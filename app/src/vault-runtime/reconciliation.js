// W2 (#437) — the process's ONE unified reconciliation service, contract §1 / §4 / §5 / §6.
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §1   四类触发（启动 / 人工 / watcher / 周期）进同一进程内单例；禁止请求触发扫描；单飞；最多一个待重跑
//        标记；禁止队列积压；有界枚举（每父目录 ≤4096、每轮 5s 逻辑期限）；超时结果不得晚到进入发布；
//        未结束的 I/O 计入单飞。去抖/周期参数属 W4（本波只留接口，不启动定时器）。
//   §2.1 准入决定（持久化）与运行状态（投影）正交；`unavailable` 不得覆盖准入决定
//   §4   唯一权威顺序：① 发现/校验 → ② 准备候选运行时并完成 align → ③ 持久化唯一权威记录（同一 revision）
//        → ④ 同步切换同一 revision 的组合快照 → ⑤ 激活后台任务 / 退役旧运行时
//   §5   删除 ⇒ unavailable（准入不变）；重命名 ⇒ 旧 unavailable + 新 pending；恢复仅当 identity 匹配
//   §6   可观测性：每 Vault 状态、发现耗时、失败次数、最后成功时间（请求热路径不做无界遍历）
//
// Shape: this is a *coordinator*, not a second inventory. Discovery, bounded enumeration and path
// safety stay in the A2 registry (`prepare`); per-Vault runtime materialization stays in the D0 map
// (`prepare`/`commit`). Steps ③ and ④ are separate calls so a persist failure leaves the previously
// published set visible and never rolls back a tightened refusal gate (contract §4/§10).
// `unavailable` here is a runtime projection only — the admission decision lives in the store.

import { ADMISSIONS_REVISION_CONFLICT, serializeRegistrySnapshot } from "./admission-store.js";
import { resolveVaultIdentity } from "./identity.js";
import { initializeConfirmedVaults, approveConfirmedVault } from "./explicit-enrollment.js";
import { composedServingSets, isolatePrepareFailures, publishComposed } from "./reconciliation-commit.js";
import { computeReconciliationDiff } from "./reconciliation-diff.js";
import { createRunBookkeeping } from "./reconciliation-status.js";
import { createRetryScheduler, resolveRetryTimers } from "./reconciliation-retry.js";
import { createGateFactory } from "./reconciliation-gate.js";
import { RECONCILIATION_TRIGGERS, RECONCILIATION_TRIGGER_MANUAL, RUNTIME_ERROR, RUNTIME_READY, RUNTIME_UNAVAILABLE } from "./reconciliation-vocabulary.js";
import { toServingRefusal } from "./serving-gate.js";
import { MAX_ENTRIES_PER_PARENT, ROUND_BUDGET_MS } from "./registry-scan.js";

// The pure diff/vocabulary live in their own modules (line budget); re-exported for consumers/tests.
export { computeReconciliationDiff } from "./reconciliation-diff.js";
export {
  RECONCILIATION_TRIGGERS,
  RECONCILIATION_TRIGGER_STARTUP,
  RECONCILIATION_TRIGGER_MANUAL,
  RECONCILIATION_TRIGGER_WATCHER,
  RECONCILIATION_TRIGGER_PERIODIC,
  RUNTIME_UNAVAILABLE,
  RUNTIME_INITIALIZING,
  RUNTIME_READY,
  RUNTIME_ERROR,
} from "./reconciliation-vocabulary.js";

export const RECONCILIATION_CONFIG_INVALID = "VAULT_RECONCILIATION_CONFIG_INVALID";

// W2FIX3 item 6 — the current self-retry rate. The seat measured 19 rounds/250 ms at the previous
// default (`retryDelayMs = 0` + a pending-rerun flag): a persistent construction failure made the
// process scan and WRITE the record in a hot loop with no watcher. The default is now a bounded
// delay, failures back off geometrically, and `0`/NaN/negative is refused. W4 owns full debounce.
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const MIN_RETRY_DELAY_MS = 25;
export const MAX_RETRY_DELAY_MS = 900_000;

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `createReconciliationService({ registry, runtimeMap?, admissions?, resolveIdentity?, activate?,
 *   configDigest?, limits?, now?, logger? })`
 *
 *   registry       — canonical A2 registry; MUST expose `prepare`/`commit`/`snapshot` (a pre-W2
 *                    `refresh()` publishes before align and cannot serve as a prepare step, §4).
 *   runtimeMap     — optional D0 map (`prepare`/`commit`/`discard`/`settleRetirements`).
 *   admissions     — optional admission store. Without it the service is a pure refresh coordinator.
 *   activate       — optional `async ({ id, descriptor, identity, created }) => void`, step ⑤.
 *   limits         — `{ roundBudgetMs = 5000, maxEntriesPerParent = 4096 }` (contract §1).
 */
export function createReconciliationService({
  registry,
  runtimeMap = null,
  admissions = null,
  resolveIdentity = resolveVaultIdentity,
  activate = null,
  configDigest = null,
  limits = {},
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  scheduler = null,
  commitObserver = null,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!isPlainObject(registry) || typeof registry.prepare !== "function" || typeof registry.commit !== "function" || typeof registry.snapshot !== "function") {
    fail(RECONCILIATION_CONFIG_INVALID, "registry must expose prepare()/commit()/snapshot(): the pre-W2 refresh() publishes before align and cannot serve as the prepare step (contract §4)");
  }
  if (runtimeMap !== null && (!isPlainObject(runtimeMap) || typeof runtimeMap.prepare !== "function" || typeof runtimeMap.commit !== "function")) {
    fail(RECONCILIATION_CONFIG_INVALID, "runtimeMap must expose prepare(descriptors)/commit(plan) when provided");
  }
  if (admissions !== null && (typeof admissions.load !== "function" || typeof admissions.commit !== "function" || typeof admissions.isInitialized !== "function")) {
    fail(RECONCILIATION_CONFIG_INVALID, "admissions must be an admission store (load/commit/isInitialized/entries)");
  }
  if (typeof resolveIdentity !== "function") fail(RECONCILIATION_CONFIG_INVALID, "resolveIdentity must be a function (root) => identity");
  if (activate !== null && typeof activate !== "function") fail(RECONCILIATION_CONFIG_INVALID, "activate must be a function or null");
  if (typeof now !== "function") fail(RECONCILIATION_CONFIG_INVALID, "now must be a function returning epoch ms");
  // item 6: validate the retry parameter — a hot loop must be impossible by construction.
  if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs) || retryDelayMs < MIN_RETRY_DELAY_MS || retryDelayMs > MAX_RETRY_DELAY_MS) {
    fail(
      RECONCILIATION_CONFIG_INVALID,
      `retryDelayMs must be a finite number in [${MIN_RETRY_DELAY_MS}, ${MAX_RETRY_DELAY_MS}] ms; got ${String(retryDelayMs)} ` +
        "(0/NaN/negative/Infinity would make an untriggered failure re-scan and re-write in a hot loop)",
    );
  }
  if (commitObserver !== null && typeof commitObserver !== "function") fail(RECONCILIATION_CONFIG_INVALID, "commitObserver must be a function when provided");
  const timers = (() => { try { return resolveRetryTimers(scheduler); } catch (error) { fail(RECONCILIATION_CONFIG_INVALID, error.message); } })();
  const maxEntriesPerParent = limits.maxEntriesPerParent ?? MAX_ENTRIES_PER_PARENT;
  const roundBudgetMs = limits.roundBudgetMs ?? ROUND_BUDGET_MS;
  if (!Number.isInteger(maxEntriesPerParent) || maxEntriesPerParent < 1) fail(RECONCILIATION_CONFIG_INVALID, "limits.maxEntriesPerParent must be a positive integer");
  if (!Number.isInteger(roundBudgetMs) || roundBudgetMs < 1) fail(RECONCILIATION_CONFIG_INVALID, "limits.roundBudgetMs must be a positive integer");

  // single-flight (contract §1): one round at a time, at most one pending rerun, no queue.
  let inFlight = null;
  let pendingRerun = false;
  let coalescedCount = 0;
  let runSeq = 0;
  let stopped = false;
  // item 6: ONE bounded, backoff-limited scheduled retry (see `reconciliation-retry.js`).
  const retry = createRetryScheduler({
    baseDelayMs: retryDelayMs,
    minDelayMs: MIN_RETRY_DELAY_MS,
    maxDelayMs: MAX_RETRY_DELAY_MS,
    timers,
    onFire: () => {
      if (stopped || inFlight !== null || !pendingRerun) return undefined;
      pendingRerun = false;
      return start("rerun", {}).catch(() => undefined);
    },
  });
  // The gate buffer of the round currently running, so a registry refresh outside `runOnce` (e.g.
  // the Admin inventory route) still shares one decision per Vault instead of inventing a second one.
  let activeRun = null;

  // observability projection (contract §6). The per-Vault runtime lease is owned by the runtime map.
  const bookkeeping = createRunBookkeeping({ registry, roundBudgetMs, maxEntriesPerParent, now, logger });
  const { mutateStatus, observeRoundStart, noteFailure, setRevision } = bookkeeping;
  const finalize = (record, outcome) => bookkeeping.finalize(record, outcome);

  /**
   * Tighten the serving gate immediately (W2 fix, items 1/5): a refusal decided in step ①/② is
   * sticky, so a later persistence failure can never re-open a deleted, replaced or revoked Vault.
   * Only a successful composed publish (`registry.commit`) re-baselines it.
   */
  function refuse(descriptor, decision) {
    if (typeof registry.refuse === "function") registry.refuse(descriptor.id, toServingRefusal(decision));
    return decision;
  }

  /** The admission gate (contract §4.1 step ① / §2.1). It never writes `approved`. */
  const createGate = createGateFactory({ admissions, resolveIdentity, refuse, now });

  /**
   * The registry's default gate. Inside a round it shares that round's decision buffer; outside it
   * reads the persisted entries and records nothing (the next round re-observes every Vault).
   */
  async function gate(descriptor) {
    const run = activeRun ?? { entries: admissions === null ? {} : { ...admissions.entries() }, observations: Object.create(null) };
    return createGate(run)(descriptor);
  }

  /** Step ③ payload: entries + registry projection at ONE revision (contract §2.2/§4). */
  function buildNextEntries(run) {
    const next = { ...run.entries };
    const at = run.atIso;
    for (const [id, observation] of Object.entries(run.observations)) {
      if (!observation.touched) continue;
      const entry = next[id];
      if (entry === undefined) {
        next[id] = { identity: observation.identity, admission: "pending", firstSeenAt: at, lastSeenAt: at, approvedAt: null, approvedBy: null, generation: 1, note: null, identityConflict: false };
        continue;
      }
      if (observation.conflict) {
        // Keep the original binding; only the conflict flag + generation move (contract §3.1).
        next[id] = { ...entry, lastSeenAt: at, generation: entry.generation + 1, identityConflict: true };
        continue;
      }
      // `lastSeenAt` refresh does NOT bump generation (contract §3).
      next[id] = { ...entry, lastSeenAt: at, identityConflict: false };
    }
    return next;
  }

  async function runOnce(record, options) {
    const at = now();
    const deadlineAt = at + roundBudgetMs;
    // Every candidate Vault is `initializing` until this round decides (contract §2.1); the previous
    // `error` set is captured first so an activation retry does not depend on the projection we overwrite.
    const previouslyErrored = observeRoundStart();
    const runState = admissions === null ? { revision: 0, entries: {} } : (admissions.snapshotState?.() ?? { revision: admissions.revision(), entries: admissions.entries() });
    const run = { atIso: new Date(at).toISOString(), entries: { ...runState.entries }, revision: runState.revision, observations: Object.create(null) };
    activeRun = run;

    // ① discovery + validation + admission (bounded; a breach publishes nothing).
    let prepared;
    try {
      prepared = await registry.prepare({ gate: createGate(run), maxEntriesPerParent, deadlineAt, now });
    } catch (error) {
      return finalize(record, { status: "failed", stage: "discover", error });
    }
    const diff = computeReconciliationDiff(registry.snapshot(), prepared.snapshot);
    // §5 + item 5: a vanished directory is refused NOW (sticky), so a later persist failure cannot
    // hand the old descriptor/runtime back. A Vault the gate already observed keeps its more specific
    // refusal (a replaced directory is `identity-changed`, not a generic `directory-missing`).
    if (typeof registry.refuse === "function") {
      for (const id of diff.removed) if (run.observations[id] === undefined) registry.refuse(id, toServingRefusal({ admitted: false, status: RUNTIME_UNAVAILABLE, reason: "directory-missing", code: null }));
    }
    // ② prepare candidate runtimes; isolate per-Vault construction failures and keep the healthy ones
    // (item 5 — one broken constructor may never block a whole round).
    let plan = null;
    if (runtimeMap !== null) {
      try {
        plan = runtimeMap.prepare(prepared.snapshot.vaults);
      } catch (error) {
        // A structural/config failure (e.g. a primary conflict) still aborts the round loudly.
        return finalize(record, { status: "failed", stage: "prepare-runtime", error, diff });
      }
      for (const failure of plan.failed ?? []) {
        // Item 5: isolate the failing Vault from the candidate servable set, keep its identity and
        // project the error; the healthy Vaults below are still prepared, persisted and committed.
        if (typeof registry.refuse === "function") registry.refuse(failure.id, toServingRefusal({ admitted: false, status: RUNTIME_ERROR, reason: "runtime-prepare-failed", code: failure.error?.code ?? null }));
        noteFailure(failure.id, { reason: "runtime-prepare-failed", code: failure.error?.code ?? null });
        logger?.warn?.(`[vault-reconciliation] isolating ${failure.id}: runtime prepare failed (${failure.error?.message || failure.error})`);
      }
      prepared = isolatePrepareFailures(prepared, plan.failed ?? []);
    }
    const isolationFailures = plan?.failed ?? [];

    // A late discovery result must not enter the visible set (contract §4.1) — checked BEFORE persist.
    if (now() > deadlineAt) {
      if (runtimeMap !== null && plan !== null && typeof runtimeMap.discard === "function") runtimeMap.discard(plan);
      return finalize(record, { status: "not-published", stage: "round-deadline", error: Object.assign(new Error("discovery round crossed its logical deadline before publish"), { code: "VAULT_REGISTRY_ROUND_TIMEOUT" }), diff });
    }

    // ③ persist the ONE authoritative record (admissions + registry projection, same revision).
    // An uninitialized store is a valid state (contract §2.3): discovery observations are reported but
    // nothing is persisted and no entry is created before the explicit administrator initialization.
    // The write is a CAS on the revision this round read (item 3): a lost race discards the candidate
    // and schedules the single pending re-run instead of reverting an administrator decision.
    let persistedRevision = null;
    if (admissions !== null && admissions.isInitialized()) {
      try {
        const persisted = await admissions.commit({
          entries: buildNextEntries(run),
          registry: serializeRegistrySnapshot(prepared.snapshot, run.entries),
          expectedRevision: run.revision,
          actor: options.actor ?? `reconciliation:${record.trigger}`,
        });
        persistedRevision = persisted?.revision ?? null;
      } catch (error) {
        // Nothing was published: the previous snapshot stays visible and the refusal gates stay in force.
        if (runtimeMap !== null && plan !== null && typeof runtimeMap.discard === "function") runtimeMap.discard(plan);
        if (error?.code === ADMISSIONS_REVISION_CONFLICT) pendingRerun = true;
        return finalize(record, { status: "not-published", stage: "persist", error, diff });
      }
    }

    // ④ STAGE, THEN ONE COMPOSED COMMIT (item 3): `stageCommit` performs every remaining failable
    // validation and `composedServingSets` derives the explicit allow-set; NOTHING is swapped yet.
    let staged;
    try {
      staged = registry.commit(prepared, { ...(persistedRevision === null ? {} : { revision: persistedRevision }), deferServing: true, staged: true });
    } catch (error) {
      if (runtimeMap !== null && plan !== null && typeof runtimeMap.discard === "function") runtimeMap.discard(plan);
      pendingRerun = true;
      return finalize(record, { status: "committed-degraded", stage: "publish", error, diff, revision: persistedRevision ?? undefined });
    }
    const sets = composedServingSets(staged.snapshot, plan === null ? null : plan.presentIds);
    const composed = Object.freeze({
      revision: staged.snapshot.revision,
      snapshot: staged.snapshot,
      serving: Object.freeze({ allowed: Object.freeze([...sets.allowed]), refusals: sets.refusals }),
      plan,
    });
    // W2FIX4 item A: ONE ordered, synchronous composed publish (see `publishComposed`); the two
    // consumer faces always describe the same generation, including mid-commit and after a late
    // serving-publish / observer fault. A fault BEFORE the map adopted the candidate undoes both.
    let published;
    let applied = null;
    try {
      ({ published, applied } = publishComposed({ registry, runtimeMap, plan, staged, composed, commitObserver }));
    } catch (error) {
      // The durable record may already be committed. Report that revision as DEGRADED; the helper
      // restored a consistent view (previous revision, or the new one when the map had adopted it).
      pendingRerun = true;
      return finalize(record, { status: "committed-degraded", stage: "runtime-commit", error, diff, revision: staged.snapshot.revision, created: plan?.createdIds ?? [] });
    }
    setRevision(published.revision);

    // ⑤ activate background work, then retire the displaced runtimes.
    if (isolationFailures.length > 0) pendingRerun = true;
    const decided = new Set(Object.keys(published.admissions));
    for (const vault of published.vaults) {
      const decision = published.admissions[vault.id] ?? { admission: null, status: RUNTIME_READY, reason: null, code: null };
      mutateStatus(vault.id, {
        admission: decision.admission, status: decision.status, reason: decision.reason, code: decision.code,
        identityDigest: published.identities[vault.id]?.digest ?? null,
        discoveryMs: run.observations[vault.id]?.discoveryMs ?? bookkeeping.current(vault.id)?.discoveryMs ?? null,
        lastSeenAt: run.atIso,
      });
    }
    for (const skip of published.skipped) {
      if (skip.reason !== "not-admitted") continue;
      const decision = published.admissions[skip.name] ?? {};
      mutateStatus(skip.name, {
        admission: decision.admission ?? null, status: decision.status ?? RUNTIME_UNAVAILABLE,
        reason: decision.reason ?? "not-admitted", code: decision.code ?? skip.code ?? null,
        identityDigest: published.identities[skip.name]?.digest ?? null, lastSeenAt: run.atIso,
      });
    }
    for (const id of diff.removed) {
      if (decided.has(id)) continue; // this round already decided it (e.g. `identity-changed`)
      // §5: a vanished directory is `unavailable`; the admission decision is untouched.
      mutateStatus(id, { status: RUNTIME_UNAVAILABLE, reason: "directory-missing", code: null, lastSeenAt: run.atIso });
    }

    const activationErrors = [];
    if (activate !== null) {
      // Newly visible/changed Vaults and Vaults degraded by an earlier activation failure are retried;
      // this does not depend on the runtime map being present (contract §4 step ⑤).
      const targets = new Set([...diff.added, ...diff.changed, ...previouslyErrored]);
      for (const vault of published.vaults) {
        if (!targets.has(vault.id)) continue;
        // item 1: a non-admitted Vault must never get its index/Git/background work started.
        if (admissions !== null && published.admissions[vault.id]?.admitted !== true) continue;
        try {
          await activate({ id: vault.id, descriptor: vault, identity: published.identities[vault.id] ?? null, created: diff.added.includes(vault.id) });
          mutateStatus(vault.id, { status: RUNTIME_READY, reason: null, code: null, lastSuccessAt: new Date(now()).toISOString() });
        } catch (error) {
          // §4: post-commit activation failure degrades + retries; it never rolls back.
          activationErrors.push(vault.id);
          mutateStatus(vault.id, { status: RUNTIME_ERROR, reason: "activation-failed", code: error?.code ?? null, failureCount: (bookkeeping.current(vault.id)?.failureCount ?? 0) + 1 });
          logger?.warn?.(`[vault-reconciliation] activation failed for ${vault.id}: ${error?.message || error}`);
        }
      }
      if (activationErrors.length > 0) pendingRerun = true;
    }
    let retirementFailed = false;
    if (runtimeMap !== null && typeof runtimeMap.settleRetirements === "function") {
      try {
        await runtimeMap.settleRetirements();
      } catch (error) {
        // item 7: a failed retirement keeps its record/handle for a retry and is reported as a
        // degradation — never silently swallowed while the round claims `committed`.
        retirementFailed = true;
        logger?.warn?.(`[vault-reconciliation] runtime retirement failed and is retryable: ${error?.message || error}`);
      }
    }

    return finalize(record, {
      status: activationErrors.length === 0 && !retirementFailed && isolationFailures.length === 0 ? "committed" : "committed-degraded",
      stage: isolationFailures.length > 0 ? "prepare-runtime" : (activationErrors.length > 0 ? "activate" : (retirementFailed ? "retire" : null)),
      diff, revision: published.revision, created: applied?.created ?? [], released: applied?.released ?? 0,
    });
  }

  /** Release the single-flight slot and schedule the ONE pending rerun (contract §1, item 6). */
  function releaseSlot(entry) {
    if (inFlight === entry) inFlight = null;
    activeRun = null;
    if (stopped) return;
    if (!pendingRerun) {
      retry.cancel();
      return;
    }
    retry.schedule();
  }

  function start(trigger, options) {
    const record = { id: ++runSeq, trigger, startedAt: now(), actor: options.actor ?? null };
    const entry = { id: record.id };
    inFlight = entry;
    // A started round consumes the pending-rerun flag; only a trigger that arrives DURING this round
    // (coalesced) sets it again.
    pendingRerun = false;
    // The returned promise resolves only after the slot is released, so a trigger issued immediately
    // after `await reconcile(...)` enters a fresh round instead of being coalesced by a stale slot.
    const settled = runOnce(record, options).then(
      (summary) => { releaseSlot(entry); return summary; },
      (error) => { releaseSlot(entry); throw error; },
    );
    entry.promise = settled;
    return settled;
  }

  /**
   * Enter the single flight. A trigger arriving mid-round sets the ONE pending rerun flag and
   * answers immediately with `coalesced` — no queue, no growth (contract §1).
   */
  function reconcile(trigger = RECONCILIATION_TRIGGER_MANUAL, options = {}) {
    if (!RECONCILIATION_TRIGGERS.includes(trigger)) {
      fail(RECONCILIATION_CONFIG_INVALID, `unknown reconciliation trigger ${JSON.stringify(trigger)}; expected one of ${RECONCILIATION_TRIGGERS.join("|")}`);
    }
    if (inFlight !== null) {
      if (!pendingRerun) pendingRerun = true;
      coalescedCount += 1;
      return Promise.resolve(Object.freeze({ runId: inFlight.id, trigger, status: "coalesced", coalesced: coalescedCount }));
    }
    return start(trigger, options);
  }

  /**
   * Explicit trusted initialization (contract §2.3): only the confirmed list becomes `approved`.
   * `confirm` must be an explicit array of Vault IDs — `WEB_VAULTS_ROOT`, directory existence and
   * `allowedVaults` are NOT substitutes for the administrator's list. The configured primary is
   * always part of the confirmed set (it is configuration, not discovery).
   */
  async function initializeVaults({ source, actor, confirm } = {}) {
    if (admissions === null) fail(RECONCILIATION_CONFIG_INVALID, "initializeVaults requires an admission store");
    if (!Array.isArray(confirm)) fail(RECONCILIATION_CONFIG_INVALID, "initializeVaults requires an explicit `confirm` array of Vault IDs");
    return initializeConfirmedVaults({ registry, admissions, resolveIdentity, now, configDigest, source, actor, confirm });
  }

  /** Protected-admin seam (W2 store layer; the Admin UI is W3): decide, then reconcile. */
  async function approve(id, { actor } = {}) {
    if (admissions === null) fail(RECONCILIATION_CONFIG_INVALID, "approve requires an admission store");
    await approveConfirmedVault({ id, registry, admissions, resolveIdentity, now, actor });
    // Resource startup follows the authoritative composed publish, never an id-based allow.
    return reconcile(RECONCILIATION_TRIGGER_MANUAL, { actor });
  }

  async function revoke(id, { actor } = {}) {
    if (admissions === null) fail(RECONCILIATION_CONFIG_INVALID, "revoke requires an admission store");
    await admissions.revoke(id, { actor });
    // W2FIX2 item 4: a DURABLE revoke must tighten the refusal gate BEFORE we report completion.
    // Waiting for the scan round is wrong twice over — it may be coalesced away, and captured runtime
    // handles (leased in `instances.js`) re-check this decision synchronously on their next call.
    if (typeof registry.refuse === "function") {
      registry.refuse(id, toServingRefusal({ admitted: false, admission: "pending", status: "pending", reason: "awaiting-approval", code: null }));
    }
    // W2FIX3 item 5: latch the runtime lease and stop the background consumers for this id NOW, before
    // the caller observes the revoke, instead of waiting for a possibly-coalesced scan.
    if (runtimeMap !== null && typeof runtimeMap.quiesce === "function") {
      try {
        await runtimeMap.quiesce(id);
      } catch (error) {
        logger?.warn?.(`[vault-reconciliation] quiesce after revoke of ${id} failed: ${error?.message || error}`);
      }
    }
    return reconcile(RECONCILIATION_TRIGGER_MANUAL, { actor });
  }

  /** Stop scheduling further reruns (shutdown / tests). An in-flight round still completes. */
  function stop() {
    stopped = true;
    retry.stop();
  }

  return Object.freeze({
    reconcile,
    gate,
    initializeVaults,
    approve,
    revoke,
    stop,
    triggers: RECONCILIATION_TRIGGERS,
    status: () => bookkeeping.status({ inFlight: inFlight !== null, pendingRerun, coalesced: coalescedCount, runs: runSeq }),
  });
}
