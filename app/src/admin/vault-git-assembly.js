// Wave E / EA — production assembly of the Auth Center "Vault 与 Git" tab.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//  - §17 / §17.1  what the Admin page may show and may never do (no repo creation, no
//                 credential editing, no credential-bearing URL in a response);
//  - §15.4        the inheritance baseline: a record-less *primary* equals the deployment's
//                 `GIT_*`, a record-less *secondary* is default-disabled;
//  - §16.2/§16.3  a missing runtime is reported as unknown and never invented; a committed
//                 save drives a config reload + timer reconcile on the same runtime;
//  - §27 B4/B7    `src/git.js` is the one §43-5 facade owning the primary Git state; the Web
//                 face owns the canonical registry it already wired for the Web UI;
//  - §30 E2       E2's `createVaultGitAdmin({ registry, store, runtimeFor, envDefaults,
//                 logger })` had no production call site (E2 handoff risk R1); this module
//                 is the assembly step of that call site, `server.js` is the call site;
//  - §43-5        a new Vault-dependent module must not import the global `VAULT` or any
//                 global path singleton, so every root arrives by injection; the only
//                 `config.js` reads here are the frozen `GIT_*` baseline values;
//  - §42          SEC-MV04 no secrets in a response; SEC-MV06 no silent substitution.
//
// Process ownership — one state, one writer, two readers:
//   * `store` and `primaryRuntime` are the *same* instances `src/git.js` already built and
//     exposes additively. The assembly never constructs either: a second store instance
//     would split the Admin write from the runtime read (§16.3) and is a defect.
//   * `runtimeFor(vaultId)` answers with the injected primary runtime, and `null` for every
//     secondary — Wave D materializes per-Vault runtimes. Until then the page shows an
//     unknown state (contract §16.2) instead of a fabricated one.
//   * `envDefaults()` is the §15.4 baseline derived from `config.js`'s `GIT_*` exports (the
//     single environment read point). `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` are deliberately
//     absent: they are runtime factory options in `src/git.js`, not §15.1 record fields, and
//     the A5 schema rejects a baseline key it does not know.
//   * `registry` is the process's ONE canonical A2 instance. Wave E / EA built a second read-only
//     A2 instance here because B7's canonical one was private to `src/app/vault-registry.js` and
//     that slice did not own the Web face (`EA.HANDOFF.md` D1/R1). Wave F §31 converged it: the
//     Web face exports the canonical instance, `server.js` injects exactly that object, and this
//     assembly owns no inventory of its own (§43-3). A degraded rescan still keeps the primary
//     Vault visible — as a *view* over the same authoritative instance, never as a rival one.
//
// Fail-closed, never crash: an unusable registry or store logs and returns `admin: null`,
// which leaves the Auth Center exactly as before this slice (tab absent, no route) instead
// of taking the whole Admin plane — or the server — down.

import {
  GIT_AUTO_COMMIT,
  GIT_AUTO_COMMIT_SWEEP,
  GIT_AUTO_PUSH,
  GIT_BRANCH,
  GIT_COMMIT_DEBOUNCE_SECONDS,
  GIT_COMMIT_MAX_DELAY_SECONDS,
  GIT_ENABLED,
  GIT_REMOTE,
  GIT_SWEEP_INTERVAL_SECONDS,
} from "../config.js";
import { DEFAULT_VAULT_ID } from "../oauth/primitives.js";
import { createVaultDescriptor } from "../vault-runtime/descriptor.js";
import { defaultCapabilitiesFor } from "../vault-runtime/registry.js";
import { createVaultGitAdmin } from "./vault-git-routes.js";
import { createVaultInventoryAdmin } from "./vault-inventory-admin.js";
import { createVaultAdmissionAdmin } from "./vault-admission-admin.js";

/** Frozen tokens this module adds (tests and the HANDOFF align on these, not on prose). */
export const VAULT_GIT_ASSEMBLY = Object.freeze({
  /** The primary Vault ID is the auth plane's canonical one — the same key A5 stores. */
  PRIMARY_ID: DEFAULT_VAULT_ID,
  REASON_REGISTRY_UNAVAILABLE: "registry-unavailable",
  REASON_STORE_UNAVAILABLE: "store-unavailable",
  INVENTORY_DEGRADED_NOTICE: "Vault 清单根目录当前不可读：本页已降级为只显示 primary Vault（没有创建任何目录，也没有改动任何配置）。修复后点“刷新 Vault 清单”重试。",
});

/**
 * The deployment's `GIT_*` baseline for the §15.4 inheritance matrix, spelled exactly like
 * the A5 record fields. A primary Vault with no persisted record resolves to these values;
 * a secondary with no record is default-disabled. Bounds are A5's, not re-decided here.
 */
export function deploymentGitEnvDefaults() {
  return Object.freeze({
    enabled: GIT_ENABLED,
    autoCommit: GIT_AUTO_COMMIT,
    autoPush: GIT_AUTO_PUSH,
    autoCommitSweep: GIT_AUTO_COMMIT_SWEEP,
    debounceSeconds: GIT_COMMIT_DEBOUNCE_SECONDS,
    maxDelaySeconds: GIT_COMMIT_MAX_DELAY_SECONDS,
    sweepIntervalSeconds: GIT_SWEEP_INTERVAL_SECONDS,
    remote: GIT_REMOTE,
    branch: GIT_BRANCH,
  });
}

/**
 * Assemble the E2 Admin service from the process's existing state.
 *
 * @param {object} options
 * @param {object} options.registry         the canonical A2 VaultRegistry instance (injected; never
 *                                          constructed here — §31/D1 single point)
 * @param {object} options.store            the A5 GitConfig store instance `src/git.js` owns
 * @param {object} [options.primaryRuntime] the A6/B4 primary runtime `src/git.js` owns
 * @param {string} options.primaryRoot      absolute primary Vault root (injected, never read here)
 * @param {boolean} [options.writable]      writable flag for the synthesized degraded descriptor
 * @param {string} [options.primaryId]      fallback primary Vault ID when the registry has none
 * @param {() => object} [options.envDefaults] §15.4 baseline provider
 * @param {object|null} [options.logger]    `warn` sink (console in production)
 * @returns {object} `{ admin, registry, store, runtimeFor, envDefaults, ensureInventory, degraded }`
 *                   — `admin` is `null` when no trustworthy registry/store can be assembled.
 */
export function createVaultGitAdminAssembly({
  registry,
  store,
  primaryRuntime = null,
  primaryRoot,
  writable = false,
  primaryId = DEFAULT_VAULT_ID,
  envDefaults = deploymentGitEnvDefaults,
  logger = null,
  admission = null,
} = {}) {
  // Logging is best effort: a broken logger must never break the Admin plane. Only `warn`
  // is used, so no diagnostic can carry a configuration value into a response.
  const warn = (message) => {
    try {
      logger?.warn?.(String(message));
    } catch {
      /* ignore */
    }
  };

  // §31/D1 / §43-3: exactly one canonical registry per process. Without a usable injected one the
  // tab stays unmounted (fail closed, exactly like an unreadable store) instead of building a
  // second inventory whose refreshes could silently disagree with the Web face.
  const usableRegistry = registry && ["list", "get", "snapshot", "refresh"].every((method) => typeof registry[method] === "function");
  if (!usableRegistry) {
    warn("[vault-git] no canonical A2 vault registry injected: the Vault 与 Git tab stays unmounted");
    return Object.freeze({
      admin: null,
      registry: null,
      store: store ?? null,
      runtimeFor: () => null,
      envDefaults,
      ensureInventory: async () => null,
      degraded: () => true,
      reason: VAULT_GIT_ASSEMBLY.REASON_REGISTRY_UNAVAILABLE,
    });
  }

  // The registry's own primary id is authoritative (one derivation); `primaryId` is only the
  // fallback for a registry that does not publish one.
  const canonicalPrimaryId = typeof registry.primaryId === "string" && registry.primaryId !== "" ? registry.primaryId : primaryId;
  let degraded = false;
  let primaryOnly = null;
  let inventoryPromise = null;
  const inventoryAdmin = createVaultInventoryAdmin({ registry, admission });
  const admissionAdmin = createVaultAdmissionAdmin({ registry, admission });

  /**
   * §4.2 semantics: one startup refresh (the first call) plus the explicit "refresh
   * inventory" action — never a rescan per request. A successful snapshot is memoized; a
   * failed one is retried on the next call so a repaired root recovers without a restart.
   */
  function ensureInventory() {
    // Managed startup is owned by vault-startup.js; page reads never trigger a scan.
    if (inventoryAdmin.enabled()) return Promise.resolve(null);
    inventoryPromise ??= refreshInventory().then(
      () => null,
      () => {
        inventoryPromise = null; // retry on the next page/action
        return null;
      },
    );
    return inventoryPromise;
  }

  /**
   * The degraded view: the primary Vault stays visible while the shared inventory cannot rescan.
   * It reuses the published primary descriptor when the canonical registry already has one, and
   * otherwise synthesizes that one descriptor through A1's pure factory — no second registry, no
   * second refresh counter, no private snapshot to drift from the Web face (§31 D1, §47).
   */
  async function degradedPrimaryView() {
    const snapshot = registry.snapshot();
    const published = Array.isArray(snapshot?.vaults) ? snapshot.vaults.find((vault) => vault?.primary === true) : null;
    let primary = published ?? null;
    if (!primary) {
      try {
        primary = await createVaultDescriptor({
          id: canonicalPrimaryId,
          name: canonicalPrimaryId,
          root: primaryRoot,
          primary: true,
          writable: registry.writable === true || writable === true,
          capabilities: defaultCapabilitiesFor(),
        });
      } catch (error) {
        warn(`[vault-git] primary Vault root is not resolvable: ${error?.message ?? error}`);
        return null;
      }
    }
    const view = Object.freeze({
      ready: true,
      revision: snapshot?.revision ?? 0,
      primaryId: canonicalPrimaryId,
      vaultsRoot: null,
      maxVaults: snapshot?.maxVaults ?? 1,
      vaults: Object.freeze([primary]),
      skipped: Object.freeze([]),
      skippedOverflow: 0,
    });
    return Object.freeze({
      list: () => view.vaults,
      get: (vaultId) => (typeof vaultId === "string" ? view.vaults.find((vault) => vault.id === vaultId) : undefined),
      snapshot: () => view,
    });
  }

  /**
   * Refresh the one shared inventory. On an unreadable secondary root the primary Vault stays
   * visible through the degraded view (with an explicit notice) while the failure is still
   * reported to the caller, so "refresh inventory" answers with an honest 503 instead of a
   * success it did not achieve.
   */
  async function refreshInventory() {
    try {
      const snapshot = await inventoryAdmin.refresh();
      degraded = false;
      primaryOnly = null;
      return snapshot ?? registry.snapshot();
    } catch (error) {
      if (inventoryAdmin.enabled()) {
        // Keep the whole last committed inventory. Never synthesize primary service rights.
        warn("[vault-git] unified managed inventory refresh failed; retaining committed projection");
        throw error;
      }
      degraded = true;
      primaryOnly = await degradedPrimaryView();
      warn(`[vault-git] vaults inventory unavailable; keeping the primary Vault visible only: ${error?.message ?? error}`);
      throw error;
    }
  }

  // One stable object for E2 even while the shared instance behind it degrades.
  const active = () => primaryOnly ?? registry;
  const facade = Object.freeze({
    primaryId: canonicalPrimaryId,
    vaultsRoot: registry.vaultsRoot ?? null,
    list: () => inventoryAdmin.enabled() ? admissionAdmin.list() : active().list(),
    get: (vaultId) => active().get(vaultId),
    snapshot: () => active().snapshot(),
    refresh: refreshInventory,
    refusesGit: admissionAdmin.refusesGit,
    admissionModel: admissionAdmin.model,
  });

  const runtimeFor = (vaultId) => (vaultId === canonicalPrimaryId && primaryRuntime ? primaryRuntime : null);

  let delegate = null;
  try {
    delegate = createVaultGitAdmin({ registry: facade, store, runtimeFor, envDefaults, logger });
  } catch (error) {
    warn(`[vault-git] Git config store unavailable: the Vault 与 Git tab stays unmounted (${error?.message ?? error})`);
    return Object.freeze({
      admin: null,
      registry: facade,
      store: store ?? null,
      runtimeFor,
      envDefaults,
      ensureInventory,
      degraded: () => degraded,
      reason: VAULT_GIT_ASSEMBLY.REASON_STORE_UNAVAILABLE,
    });
  }

  const admin = Object.freeze({
    model: async (options = {}) => {
      await ensureInventory();
      const model = await delegate.model(options);
      // A degraded inventory is stated on the page; an existing notice (a save/refresh
      // outcome) is more specific and wins.
      return degraded && !model?.notice ? { ...model, notice: VAULT_GIT_ASSEMBLY.INVENTORY_DEGRADED_NOTICE } : model;
    },
    save: async (body) => {
      await ensureInventory();
      return delegate.save(body);
    },
    refreshInventory: () => delegate.refreshInventory(),
    admissionAction: admission === null ? undefined : admissionAdmin.apply,
    verify: async (vaultId) => {
      await ensureInventory();
      return delegate.verify(vaultId);
    },
  });

  return Object.freeze({
    admin,
    registry: facade,
    store,
    runtimeFor,
    envDefaults,
    ensureInventory,
    degraded: () => degraded,
  });
}
