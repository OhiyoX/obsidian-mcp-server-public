// W2 (#437) — composition seam for Vault admission + unified reconciliation (Web/process side).
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §2.2 唯一权威文件 / 损坏 fail-closed；§2.3 初始化入口冻结；§4 原子发布顺序；§6 可观测性；
//   §10 关闭自动发现 ⇒ 只停止自动触发，准入门继续生效
//
// Why a separate module: `app/src/app/vault-registry.js` owns the canonical registry singleton and
// must stay within the repository line budget, so the *wiring* (store + reconciliation service +
// public admin/manual seams) lives here and the registry only holds a delegating `gate`.
//
// W2 fix (#437 RETURN, item 2): the controller is built whenever multi-Vault management is
// configured, and the `VAULT_DISCOVERY_ENABLED` switch only controls the AUTOMATIC discovery
// trigger. Enforcement is on when the switch is set OR durable managed-mode evidence exists (the
// authoritative record OR the independent enrollment sentinel, item 1 of the second RETURN), so
// turning the switch off can never un-manage an already-admitted instance: `pending`, revoked,
// identity-changed and deleted Vaults stay refused, and a corrupt/lost record still fail-closes.
// Legacy (pass-through) mode is therefore explicitly limited to an instance that has NEVER been
// managed — no switch, no record, no sentinel — and is never inferred from a mere ENOENT.

import { createAdmissionStore } from "../vault-runtime/admission-store.js";
import { createReconciliationService } from "../vault-runtime/reconciliation.js";
import { createVaultWatcher } from "../vault-runtime/vault-watcher.js";

export const RECONCILIATION_NOT_INSTALLED = "VAULT_RECONCILIATION_NOT_INSTALLED";

/** The pre-W2 pass-through decision (only ever produced when admission enforcement is off). */
const LEGACY_DECISION = Object.freeze({ admitted: true, admission: null, status: "ready", reason: null, identity: null });

function notInstalled() {
  return Object.assign(
    new Error(
      `[${RECONCILIATION_NOT_INSTALLED}] Vault discovery is enabled but the reconciliation service was never bound to a runtime map; ` +
        "refusing to publish or serve an ungated inventory (contract §4)",
    ),
    { code: RECONCILIATION_NOT_INSTALLED },
  );
}

/**
 * `createVaultAdmissionController({ registry, file, configDigest, automaticDiscovery, discovery, logger })`
 *
 * `discovery` is the W4 scheduling seam `{ parents?, debounceMs?, maxCoalesceMs?, periodicMs?,
 * maxBackoffMs?, scheduler?, watch?, statApi?, now? }`; every field has a frozen default and the
 * parent list defaults to the registry's configured discovery root. Returns a frozen controller with
 * `load()`, `install()`, `gate()`, `reconcile()`, `status()`, `initialize()`, `approve()`, `revoke()`,
 * `startDiscovery()`, `stopDiscovery()` and `store`. One controller per process; `install()` may run
 * only once.
 */
export function createVaultAdmissionController({ registry, file, enrollmentFile, configDigest = "unspecified", automaticDiscovery = false, discovery = {}, logger = console } = {}) {
  const store = createAdmissionStore({ file, enrollmentFile, logger });
  let reconciliation = null;
  let watcher = null;
  let enforced = automaticDiscovery === true;

  /** Arm the ONE serving gate (registry-owned) so nothing is servable until a composed publish. */
  function armGate() {
    const gate = registry?.servingGate;
    if (gate !== null && gate !== undefined && typeof gate.arm === "function") gate.arm();
  }

  /** Fail-closed load; the composition root MUST await this before listening (corruption ⇒ throw). */
  async function load() {
    let initial = null;
    if (!store.isLoaded()) initial = await store.load();
    // Enforcement is decided from durable evidence, NEVER from the record's ENOENT alone: the switch,
    // the authoritative record, or the independent managed-mode sentinel (item 1).
    if (automaticDiscovery === true || initial?.exists === true || initial?.managed === true || store.isManaged()) enforced = true;
    // Persist the managed-mode sentinel so a later record loss can never be re-read as "never managed".
    if (enforced && !store.isManaged()) await store.enroll({ source: "load" });
    if (enforced) armGate();
    return { enabled: enforced, initialized: store.isInitialized(), revision: store.revision() };
  }

  /** Bind the D0 runtime map once. */
  function install({ runtimeMap = null, activate = null, limits, digest } = {}) {
    if (reconciliation !== null) throw new Error("Vault reconciliation is already installed");
    reconciliation = createReconciliationService({
      registry,
      runtimeMap,
      admissions: store,
      activate,
      limits,
      configDigest: digest ?? configDigest,
      logger,
    });
    // W4 (#437): the watcher and the periodic fallback exist only under the explicit discovery switch
    // (contract §10). They call `reconciliation.reconcile` and nothing else — the single-flight slot,
    // the bounded enumeration and the admission gate all stay in the unified service.
    if (automaticDiscovery === true) {
      watcher = createVaultWatcher({
        reconcile: (trigger, options) => reconciliation.reconcile(trigger, options),
        parents: discovery.parents ?? (registry?.vaultsRoot ? [registry.vaultsRoot] : []),
        enabled: true,
        debounceMs: discovery.debounceMs,
        maxCoalesceMs: discovery.maxCoalesceMs,
        periodicMs: discovery.periodicMs,
        maxBackoffMs: discovery.maxBackoffMs,
        scheduler: discovery.scheduler ?? null,
        watch: discovery.watch ?? null,
        statApi: discovery.statApi ?? null,
        now: discovery.now ?? (() => Date.now()),
        logger,
      });
    }
    if (enforced) armGate();
    return reconciliation;
  }

  /** W4: start the two automatic triggers. A no-op (returns null) when discovery is off/unenforced. */
  async function startDiscovery() {
    if (!enforced || watcher === null) return null;
    return watcher.start();
  }

  /** W4: release every watch handle and timer (shutdown / tests). */
  function stopDiscovery() {
    return watcher === null ? null : watcher.stop();
  }

  function service() {
    if (reconciliation === null) throw notInstalled();
    return reconciliation;
  }

  /**
   * The registry's PERSISTENT gate (contract §2.1/§2.2). Before `install()` it refuses every
   * non-structural Vault, so an ungated publish is impossible even from a refresh path this wave
   * does not own (e.g. the Admin inventory route).
   */
  async function gate(descriptor) {
    if (!enforced) return LEGACY_DECISION;
    if (reconciliation !== null) return reconciliation.gate(descriptor);
    return { admitted: false, admission: null, status: "pending", reason: "reconciliation-not-installed", code: RECONCILIATION_NOT_INSTALLED, identity: null };
  }

  return Object.freeze({
    store,
    load,
    install,
    gate,
    loaded: () => store.isLoaded(),
    installed: () => reconciliation !== null,
    enforced: () => enforced,
    managed: () => store.isManaged(),
    reload: () => store.reload(),
    reconcile: (trigger = "manual", options = {}) => (enforced ? service().reconcile(trigger, options) : Promise.resolve(null)),
    startDiscovery,
    stopDiscovery,
    discovery: () => (watcher === null ? null : watcher.status()),
    status: () => {
      if (!enforced) return Object.freeze({ enabled: false, initialized: false, revision: null, inFlight: false, vaults: Object.freeze({}), scheduled: Object.freeze({ watcher: false, periodic: false, enabled: false }) });
      const base = { enabled: true, initialized: store.isInitialized(), revision: store.revision(), inFlight: false, vaults: Object.freeze({}), scheduled: Object.freeze({ watcher: false, periodic: false }) };
      const merged = reconciliation === null ? base : { ...base, ...reconciliation.status() };
      // W4: the scheduled projection reports the REAL watcher/periodic state (trigger counts, current
      // backed-off period, diagnostics) instead of the W2 placeholder `{watcher:false, periodic:false}`.
      return Object.freeze(watcher === null ? merged : { ...merged, scheduled: Object.freeze({ ...merged.scheduled, ...watcher.status() }) });
    },
    initialize: async ({ confirm, actor, source } = {}) => {
      const active = service();
      const approved = await active.initializeVaults({ confirm, actor, source });
      await active.reconcile("manual", { actor });
      // The record now exists, so the gate must apply from this moment. Enforcement is otherwise only
      // re-evaluated in load(), which means an operator who initialises a fresh deployment would see
      // "initialised" in the UI while every vault stayed ungated (and the newly written approvals
      // unenforced) until someone bounced the container.
      if (!enforced && store.isManaged()) { enforced = true; armGate(); }
      return approved;
    },
    approve: (id, { actor } = {}) => service().approve(id, { actor }),
    revoke: (id, { actor } = {}) => service().revoke(id, { actor }),
  });
}
