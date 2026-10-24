// Wave D / D0 — per-Vault runtime materialization map.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D tool/subsystem parity (real per-Vault *instances*, no second Vault selector) ·
//   §5  VaultRuntime composition / §5.2 secondary data layout / §5.3 no ambient worker state ·
//   §10.1 the one factory seam / §10.2 per-runtime mutation lock · §4.2 registry snapshot semantics ·
//   §3.4 capabilities are runtime facts (fail closed) · §21 MV-I02 · §43-5 · §47 RETURN list.
//
// Position: this module turns ONE canonical registry snapshot into runtime INSTANCES, and nothing
// else. It is a pure composition seam (no `config.js`, no `process.env`, no filesystem access, no
// module-level mutable state; every root and collaborator is an explicit parameter — §43-5/SEC-MV07).
// The **primary** always reuses the injected `primaryRuntime` and never builds a rival primary; a
// **secondary** gets its own descriptor, A7 data layout, mutation lock and filesystem service, and a
// factory returning anything else is refused (SEC-MV06). Capabilities stay fail closed (§3.4).
//
// The swap is atomic and, since W2FIX5 (R1), composed: `commit(plan)` publishes ONE record carrying
// the registry snapshot, the instance map and the serving set, so a consumer can never pair a new
// descriptor with an old runtime; only then are the displaced instances retired. `refresh()` stages
// the registry and re-aligns in the same single publish; `align()` alone re-aligns to the current
// snapshot. Alignment is incremental — an unchanged Vault keeps its instance (lock, cache, pending
// work), a new Vault gets one, and a removed Vault is released.

import path from "node:path";
import { wiredCapabilities } from "./capabilities.js";
import { vaultDataPaths } from "./paths.js";
import { publishComposedRecord, servingOf, servingWithout, refuseComposed } from "./composed-commit.js";
import { isVaultDirectoryCurrent } from "./identity.js";
import { createRuntimePlans } from "./runtime-plans.js";
import { createLeaseManager } from "./instance-leases.js";
import { createLeasedRuntime, revokeRuntimeLease } from "./runtime-lease.js";
import { createVaultRuntime } from "./runtime.js";

/** Stable machine-readable failure codes; consumers/tests never match on prose. */
export const VAULT_RUNTIME_MAP_INVALID = "VAULT_RUNTIME_MAP_INVALID";
export const VAULT_RUNTIME_MAP_NOT_READY = "VAULT_RUNTIME_MAP_NOT_READY";
export const VAULT_RUNTIME_MAP_PRIMARY_CONFLICT = "VAULT_RUNTIME_MAP_PRIMARY_CONFLICT";
export const VAULT_RUNTIME_MAP_RUNTIME_MISMATCH = "VAULT_RUNTIME_MAP_RUNTIME_MISMATCH";
export const VAULT_RUNTIME_MAP_RETIRE_FAILED = "VAULT_RUNTIME_MAP_RETIRE_FAILED";

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || value === "") fail(VAULT_RUNTIME_MAP_INVALID, `${label} must be a non-empty absolute path string, got ${describe(value)}`);
  if (!path.isAbsolute(value)) fail(VAULT_RUNTIME_MAP_INVALID, `${label} must be absolute, got ${describe(value)}`);
  if (value.includes("\0")) fail(VAULT_RUNTIME_MAP_INVALID, `${label} must not contain a NUL byte`);
  return value;
}

/**
 * Value identity of a descriptor. A registry rebuilds its descriptors on every refresh, so
 * reference equality would recreate every instance on every rescan and throw away live locks
 * for Vaults that did not change. Two descriptors are the same Vault instance iff they agree on
 * every fact this map consumes — including the capability map, because a capability change is a
 * runtime-fact change and must be observed by the next reader (§3.4).
 */
function descriptorKey(descriptor) {
  return JSON.stringify([
    descriptor.id,
    descriptor.root,
    descriptor.canonicalRoot ?? null,
    descriptor.primary === true,
    descriptor.writable === true,
    descriptor.dataKey ?? null,
    descriptor.capabilities ?? null,
  ]);
}

/**
 * Stop a released instance deterministically *before* it is forgotten. A B1 runtime holds no
 * timer, but a composed runtime (index / retrieval / Git, lanes B2/B3/B4) does, and §41/§47
 * forbid leaking one — and contract §4 step ⑤ explicitly forbids "merely deleting it from the Map"
 * while in-flight references or background writes exist.
 *
 * Order: `drain()` (let queued/in-flight work finish) → the injected `drainFor` hook (composition
 * root seam for per-Vault subsystems keyed off this runtime) → `dispose()`. Any hook may be sync or
 * async. A request that captured the old instance keeps operating on it safely; the map stops
 * handing it out at the synchronous swap, and the lease guard (item 4) refuses any NEW operation on
 * the captured handle once the Vault is refused/retired.
 */
async function releaseRuntime(entry, drainFor) {
  const { descriptor, runtime } = entry;
  const drainOwner = typeof runtime?.drain === "function" ? runtime : runtime?.localFs;
  if (drainOwner !== undefined && drainOwner !== null && typeof drainOwner.drain === "function") await drainOwner.drain();
  // `drainFor(descriptor, handle, runtime)`: handle is the object consumers received (the per-Vault
  // cache key), runtime the unguarded instance for internal drain/dispose work.
  if (typeof drainFor === "function") await drainFor(descriptor, entry.handle ?? runtime, runtime);
  const disposeOwner = typeof runtime?.dispose === "function" ? runtime : runtime?.localFs;
  if (disposeOwner !== undefined && disposeOwner !== null && typeof disposeOwner.dispose === "function") await disposeOwner.dispose();
}

/**
 * `createVaultRuntimeMap({ registry, dataRoot, primaryRuntime, pathsFor?, capabilitiesFor?,
 * createRuntime?, deps?, drainFor? })`
 *
 *   registry        — the canonical A2 registry: `snapshot()` must publish a ready snapshot. This map
 *                     keeps no inventory of its own (§43-3) and, when the registry carries the ONE
 *                     composed commit (`registry.composedCommit`), adopts it automatically.
 *   dataRoot        — this process's protected data root. Secondary state lives under
 *                     `<dataRoot>/vaults/<dataKey>/…` (A7, §5.2); the primary's legacy paths are
 *                     untouched because the primary runtime already owns them.
 *   primaryRuntime  — the one primary instance from `src/vault.js` (§10.1). Required: without it a
 *                     primary request would silently change identity.
 *   pathsFor / capabilitiesFor — optional A7 mapping / capability-map overrides.
 *   createRuntime   — optional factory override (tests). The returned instance is validated either way.
 *   deps            — forwarded verbatim to `createVaultRuntime`.
 *   drainFor        — optional `(descriptor, handle, runtime)` hook closing the background window.
 *
 * Returns a frozen map with `primaryId`, `size()`, `ids()`, `get(id)`/`resolve(id)`, `has(id)`,
 * `descriptorOf(id)`, `prepare(descriptors)`/`commit(plan)`/`discard(plan)`, `align()`, `refresh()`,
 * `release(id)`, `dispose()`, `settleRetirements()` and `pendingRetirements()`.
 */
export function createVaultRuntimeMap({
  registry,
  dataRoot,
  primaryRuntime,
  pathsFor,
  capabilitiesFor = wiredCapabilities,
  createRuntime = createVaultRuntime,
  drainFor,
  onPrimaryLease,
  deps,
  logger = console,
} = {}) {
  let discardedCount = 0;
  if (!isPlainObject(registry) || typeof registry.snapshot !== "function" || typeof registry.refresh !== "function") {
    fail(VAULT_RUNTIME_MAP_INVALID, `registry must be the canonical VaultRegistry (snapshot() + refresh()), got ${describe(registry)}`);
  }
  requireAbsolute(dataRoot, "dataRoot");
  if (!isPlainObject(primaryRuntime) || typeof primaryRuntime.id !== "string" || primaryRuntime.id === "" || !isPlainObject(primaryRuntime.localFs) || primaryRuntime.primary !== true) {
    fail(VAULT_RUNTIME_MAP_INVALID, `primaryRuntime must be the process's one primary VaultRuntime (§10.1), got ${describe(primaryRuntime)}`);
  }
  if (pathsFor !== undefined && typeof pathsFor !== "function") fail(VAULT_RUNTIME_MAP_INVALID, `pathsFor must be a function (descriptor) => A7 paths, got ${describe(pathsFor)}`);
  if (capabilitiesFor !== undefined && typeof capabilitiesFor !== "function") fail(VAULT_RUNTIME_MAP_INVALID, `capabilitiesFor must be a function (descriptor) => capabilities, got ${describe(capabilitiesFor)}`);
  if (typeof createRuntime !== "function") fail(VAULT_RUNTIME_MAP_INVALID, `createRuntime must be a function, got ${describe(createRuntime)}`);
  if (drainFor !== undefined && typeof drainFor !== "function") fail(VAULT_RUNTIME_MAP_INVALID, `drainFor must be a function (descriptor, runtime), got ${describe(drainFor)}`);
  if (deps !== undefined && !isPlainObject(deps)) fail(VAULT_RUNTIME_MAP_INVALID, `deps must be an object forwarded to createVaultRuntime, got ${describe(deps)}`);

  const primaryId = primaryRuntime.id;
  const pathsForSecondary = pathsFor ?? ((descriptor) => vaultDataPaths({ primary: false, dataRoot, dataKey: descriptor.dataKey }));

  // W2FIX3 item 4: every consumer handle (primary AND secondary) is minted through ONE lease manager
  // that binds it to the committed identity + authorization generation (see `instance-leases.js`).
  const leases = createLeaseManager({
    isServable: (id) => servable(id),
    generationOf: (id) => {
      const decision = admissionFor(id);
      return Number.isInteger(decision?.generation) ? decision.generation : null;
    },
    identityDigestOf: (id) => admissionFor(id)?.identityDigest ?? null,
    identityIsCurrent: id => {
      const identity = registry.snapshot().identities?.[id];
      return identity?.identityVersion !== 2 || isVaultDirectoryCurrent(identity);
    },
  });

  let instances = new Map([[primaryId, { key: null, descriptor: null, runtime: primaryRuntime, lease: leases.mint(primaryId), handle: null }]]);

  // W2FIX5 (#437 W2FIX4 item A / R1): when the canonical registry carries the ONE composed commit
  // record, publication synchronously adopts private membership into this owner's closure.
  // Public record/plan accessors contain facts only; there is no raw Map accessor or symbol.
  const composed = registry.composedCommit ?? null;
  const currentInstances = () => instances;
  const plans = createRuntimePlans();

  const bindPrimary = () => leases.bindPrimary(currentInstances().get(primaryId), onPrimaryLease);
  bindPrimary();
  // Failed retirements remain tracked for retry.
  const retirements = new Set();

  function track(entry) {
    if (entry.error === undefined) entry.error = null;
    if (!Number.isInteger(entry.attempts)) entry.attempts = 0;
    entry.promise = releaseRuntime(entry, drainFor).then(
      () => { retirements.delete(entry); },
      (error) => { entry.error = error; },
    );
    retirements.add(entry);
    return entry.promise;
  }

  /** Retire one instance: revoke its lease NOW (item 4) and start the async drain→dispose. */
  function retire(entry) {
    revokeRuntimeLease(entry.lease, "retired");
    return track(entry);
  }

  function buildSecondary(descriptor) {
    const paths = pathsForSecondary(descriptor);
    const runtime = createRuntime({
      descriptor,
      paths,
      // A secondary's protected data root is its own A7 root (§5.2), not the shared data root:
      // `getVaultHealth()` must report this Vault's state, never the process-wide one. A custom
      // mapping without `root` falls back to the injected data root.
      dataRoot: paths.root ?? dataRoot,
      capabilities: capabilitiesFor(descriptor),
      deps,
    });
    // SEC-MV06 / §47 "secondary error fallback primary": a secondary instance must be its own
    // non-primary runtime with its own root; anything else is refused instead of published.
    if (!isPlainObject(runtime) || runtime.id !== descriptor.id || runtime.root !== descriptor.root || runtime.primary !== false) {
      const disposeOwner = typeof runtime?.dispose === "function" ? runtime : runtime?.localFs;
      if (disposeOwner !== null && disposeOwner !== undefined && typeof disposeOwner.dispose === "function") {
        try { const pending = disposeOwner.dispose(); if (pending !== null && pending !== undefined && typeof pending.catch === "function") pending.catch(() => {}); } catch { /* best-effort cleanup of the rejected candidate */ }
      }
      fail(
        VAULT_RUNTIME_MAP_RUNTIME_MISMATCH,
        `the runtime built for secondary ${describe(descriptor.id)} must be its own non-primary instance rooted at ${describe(descriptor.root)} ` +
          `(got id=${describe(runtime?.id)}, root=${describe(runtime?.root)}, primary=${describe(runtime?.primary)}); never substitute the primary runtime`,
      );
    }
    return runtime;
  }

  /**
   * Contract §4 step ②: build the candidate map off to the side and validate it, WITHOUT publishing.
   * `commit(plan)` is the only swap; an abandoned plan must be `discard(plan)`-ed, never leaked.
   */
  function prepare(descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
      fail(VAULT_RUNTIME_MAP_INVALID, "a prepared snapshot must list at least the primary Vault");
    }
    const primaries = descriptors.filter((descriptor) => descriptor?.primary === true);
    if (primaries.length !== 1) {
      fail(VAULT_RUNTIME_MAP_PRIMARY_CONFLICT, `exactly one primary descriptor is required, got ${primaries.length}`);
    }
    if (primaries[0].id !== primaryId) {
      fail(
        VAULT_RUNTIME_MAP_PRIMARY_CONFLICT,
        `the registry primary ${describe(primaries[0].id)} must equal the injected primary runtime id ${describe(primaryId)}: ` +
          "this map reuses that instance and never materializes a second primary (§21 MV-I02)",
      );
    }

    const cachedPrimary = currentInstances().get(primaryId);
    const next = new Map([[primaryId, { ...cachedPrimary, descriptor: primaries[0] }]]);
    const createdIds = [];
    const reusedIds = [];
    const failed = [];
    for (const descriptor of descriptors) {
      if (descriptor.primary === true) continue;
      if (descriptor.id === primaryId) {
        fail(VAULT_RUNTIME_MAP_PRIMARY_CONFLICT, `a non-primary descriptor claims the primary id ${describe(primaryId)} (SEC-MV06)`);
      }
      const key = descriptorKey(descriptor);
      const cached = currentInstances().get(descriptor.id);
      if (cached && cached.key === key) {
        next.set(descriptor.id, cached);
        reusedIds.push(descriptor.id);
        continue;
      }
      try {
        next.set(descriptor.id, { key, descriptor, runtime: buildSecondary(descriptor), handle: null, lease: leases.mint(descriptor.id) });
        createdIds.push(descriptor.id);
      } catch (error) {
        // Item 5 PER-VAULT FAILURE ISOLATION: one broken constructor is recorded (its partial
        // candidate was cleaned up inside `buildSecondary`) and isolated from the servable set while
        // the healthy Vaults still commit.
        failed.push(Object.freeze({ id: descriptor.id, error }));
        logger?.warn?.(`[vault-runtime-map] runtime prepare failed for ${descriptor.id}: ${error?.message || error}`);
      }
    }

    const released = [];
    for (const [id, entry] of currentInstances()) {
      if (entry.runtime === primaryRuntime) continue;
      const target = next.get(id);
      if (!target || target.runtime !== entry.runtime) released.push(entry);
    }
    return plans.stage({ next, previous: currentInstances(), released, createdIds, reusedIds, failed });
  }

  /** W2 (#437) contract §4 step ④: the synchronous swap; displaced instances are retired after it. */
  function commit(plan) {
    const owned = isPlainObject(plan) ? plans.get(plan) : null;
    if (!owned || owned.discarded) fail(VAULT_RUNTIME_MAP_INVALID, "commit expects a live plan produced by this owner prepare()");
    // Every failable validation happens BEFORE the switch: a throw here must leave all three faces on
    // the previous commit, which is exactly what the ruling's pre-swap observation requires.
    if (currentInstances() !== owned.previous && currentInstances() !== owned.committed) {
      fail(VAULT_RUNTIME_MAP_INVALID, "refusing to apply a plan prepared against a different map generation (a stale candidate must be discarded, not committed)");
    }
    const payload = plan.composed ?? null;
    const prior = composed === null ? null : composed.current();
    if (composed !== null) {
      // THE one composed switch: registry snapshot + runtime map + serving set become visible in ONE
      // record assignment. A bound plan (the reconciliation service) carries the staged snapshot and
      // the explicit allow-set; a bare plan (`align()`) carries the faces over unchanged.
      publishComposedRecord(composed, {
        ...(payload === null ? {} : { snapshot: payload.snapshot, revision: payload.revision, serving: payload.serving, commits: payload.commits }),
        instances: owned.next,
      }, { snapshot: registry.snapshot(), commits: prior?.commits ?? 0, adopt: record => registry.servingGate?.adopt(record) });
    }
    if (composed === null) instances = new Map([...owned.next].map(([id, entry]) => [id, { ...entry }]));
    owned.committed = instances;
    bindPrimary();
    for (const entry of owned.released) retire(entry);
    return Object.freeze({ size: owned.next.size, created: owned.createdIds, reused: owned.reusedIds, released: owned.released.length, failed: owned.failed });
  }

  // An attached record is never rolled back one face at a time.
  function rollback(plan) {
    const owned = isPlainObject(plan) ? plans.get(plan) : null;
    if (composed !== null || !owned || currentInstances() !== owned.committed) return false;
    instances = owned.previous;
    return true;
  }

  /** Abandon a prepared plan (e.g. the authoritative record could not be persisted). */
  function discard(plan) {
    const owned = isPlainObject(plan) ? plans.get(plan) : null;
    if (!owned || owned.discarded || owned.committed) return 0;
    owned.discarded = true;
    const created = owned.createdIds;
    let released = 0;
    for (const id of created) {
      const entry = owned.next.get(id);
      if (!entry || entry.runtime === primaryRuntime) continue;
      entry.discarded = true;
      retire(entry);
      released += 1;
    }
    discardedCount += released;
    return released;
  }

  /**
   * Re-align to the current registry snapshot. Incremental and atomic: unchanged Vaults keep their
   * instance, new Vaults get one, and a removed Vault is released only after the swap — a failed build
   * never publishes a half-built map and a released instance can never be resolved once more.
   */
  function align() {
    const snapshot = registry.snapshot();
    if (!isPlainObject(snapshot) || snapshot.ready !== true) {
      fail(VAULT_RUNTIME_MAP_NOT_READY, "the registry published no ready snapshot yet: refresh() first (§4.2)");
    }
    return commit(prepare(snapshot.vaults));
  }
  /** §4.2: refresh the inventory, then align. The registry stays the single inventory authority. */
  async function refresh(options = {}) {
    if (registry.servingGate?.armed()) refuseComposed("managed runtime refresh requires unified reconciliation");
    if (composed === null) {
      await registry.refresh();
      return align();
    }
    // W2FIX5 (R1): the legacy refresh still publishes ONE record — stage the registry and build the
    // plan first, then swap both faces together. A registry-only publish in between could otherwise be
    // observed as a new descriptor beside an old runtime.
    const staged = registry.stageCommit(await registry.prepare(options));
    const prior = composed.current();
    const plan = prepare(staged.snapshot.vaults);
    return commit({ ...plan, composed: { snapshot: staged.snapshot, revision: staged.snapshot.revision, serving: prior === null ? null : servingOf(prior), commits: (prior?.commits ?? 0) + 1 } });
  }

  function get(vaultId) {
    if (typeof vaultId !== "string" || !servable(vaultId)) return undefined;
    const entry = currentInstances().get(vaultId);
    if (entry === undefined) return undefined;
    // W2FIX3 item 4: PRIMARY AND SECONDARY are both handed out through ONE memoized lease-guarded
    // facade. The underlying instance may be reused (the primary is the process instance), but a raw
    // unguarded instance is never returned as a consumer handle. The facade re-checks the lease and
    // the registry's serving decision on every call, and its generation is bound to the admission
    // generation so a revoke/re-approve can never revive an old facade.
    leases.refresh(entry);
    if (entry.handle === undefined || entry.handle === null) {
      // The facade must close over the LEASE OBJECT it was minted with (not `entry.lease`, which a
      // later re-approval replaces): that is what makes an old facade permanently dead.
      const lease = entry.lease;
      entry.handle = createLeasedRuntime(entry.runtime, lease, () => leases.isCurrent(lease));
    }
    return entry.handle;
  }

  function has(vaultId) {
    return typeof vaultId === "string" && servable(vaultId) && currentInstances().has(vaultId);
  }

  /** item 1/5: the runtime map shares the ONE serving decision with the registry's canonical resolve. */
  function servable(vaultId) {
    return typeof registry.servable === "function" ? registry.servable(vaultId) : true;
  }

  /**
   * W2FIX3 item 4 — the current AUTHORIZATION generation/identity of an id, read from the same
   * committed registry snapshot the consumer gate uses (never a stale local counter). `null` when the
   * registry carries no admission projection (legacy / admissions disabled).
   */
  function admissionFor(vaultId) {
    return typeof registry.admission === "function" ? registry.admission(vaultId) : null;
  }

  /** Drop one instance on purpose (ops / tests). The primary instance is never released. */
  function release(vaultId) {
    const current = currentInstances();
    const entry = typeof vaultId === "string" ? current.get(vaultId) : undefined;
    if (!entry || entry.runtime === primaryRuntime) return false;
    const next = new Map(current);
    next.delete(vaultId);
    instances = next;
    if (composed !== null) publishComposedRecord(composed, { instances: next, serving: servingWithout(composed.current(), vaultId) }, { snapshot: registry.snapshot() });
    retire(entry);
    return true;
  }

  /**
   * W2FIX3 item 5 — synchronously quiesce ONE id because its authorization was revoked: latch the
   * lease (so captured facades and re-checks die NOW, before the possibly-coalesced scan runs) and
   * run the composition-root `drainFor` seam so the Git/search caches for this handle are stopped
   * (their timers cleared) instead of surviving the window. The instance stays in the map so the next
   * composed commit can observe/release it; it is not handed out again because the gate refuses.
   */
  async function quiesce(vaultId) {
    const entry = typeof vaultId === "string" ? currentInstances().get(vaultId) : undefined;
    if (!entry) return false;
    revokeRuntimeLease(entry.lease, "revoked");
    if (typeof drainFor === "function") {
      try {
        await drainFor(entry.descriptor, entry.handle ?? entry.runtime, entry.runtime);
      } catch (error) {
        entry.quiesceError = error;
        logger?.warn?.(`[vault-runtime-map] quiesce of ${vaultId} failed: ${error?.message || error}`);
      }
    }
    return true;
  }

  /** Release every secondary instance; the primary runtime belongs to the process, not to this map. */
  function dispose() {
    let released = 0;
    for (const id of [...currentInstances().keys()]) if (release(id)) released += 1;
    return released;
  }

  /**
   * W2 (#437) contract §4 step ⑤: wait for the runtimes displaced by `commit()` to finish their
   * in-flight background work and be disposed. Bounded by construction and reused by the shutdown path.
   */
  async function settleRetirements({ maxRetries = 2 } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (retirements.size === 0) return true;
      await Promise.allSettled([...retirements].map((entry) => entry.promise));
      const failed = [...retirements].filter((entry) => entry.error !== null);
      if (failed.length === 0) return true;
      for (const entry of failed) {
        entry.attempts += 1;
        entry.error = null;
        track(entry);
      }
    }
    const first = [...retirements][0];
    fail(
      VAULT_RUNTIME_MAP_RETIRE_FAILED,
      `${retirements.size} runtime retirement(s) still failed after ${maxRetries + 1} attempts ` +
        `(first: ${describe(first?.descriptor?.id)} — ${first?.error?.code || first?.error?.message || "unknown"}); the records and handles are kept for a retry`,
    );
  }

  composed?.attachRuntimeMap({ refresh, adopt: membership => { instances = membership; } });
  return Object.freeze({
    primaryId,
    size: () => currentInstances().size,
    ids: () => [...currentInstances().keys()],
    get,
    resolve: get,
    has,
    // W2FIX3 item 4/5: the consumer handle (same object `get` returns) and the explicit quiesce seam.
    handleOf: (vaultId) => (typeof vaultId === "string" ? currentInstances().get(vaultId)?.handle ?? null : null),
    quiesce,
    discardedCount: () => discardedCount,
    refusalOf: (vaultId) => (typeof registry.refusal === "function" ? registry.refusal(vaultId) : null),
    descriptorOf: (vaultId) => (typeof vaultId === "string" ? currentInstances().get(vaultId)?.descriptor ?? null : null),
    // Diagnostics/tests: the unguarded instance and its lease (never hand `unguarded` to a consumer).
    unguarded: (vaultId) => (typeof vaultId === "string" ? currentInstances().get(vaultId)?.runtime ?? undefined : undefined),
    leaseOf: (vaultId) => (typeof vaultId === "string" ? currentInstances().get(vaultId)?.lease ?? null : null),
    prepare,
    commit,
    rollback,
    discard,
    align,
    refresh,
    release,
    dispose,
    settleRetirements,
    pendingRetirements: () => retirements.size,
  });
}
