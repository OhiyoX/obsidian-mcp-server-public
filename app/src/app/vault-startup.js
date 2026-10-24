// W2 (#437) — process-startup seam for Vault admission + unified reconciliation.
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §2.2 损坏 fail-closed（拒绝启动并保留原文件）；§2.3 文件缺失 ⇒ 拒绝自动迁移，未初始化不自动批准任何 Vault
//   §4   唯一权威顺序；启动触发必须经统一服务（禁止请求触发扫描）
//
// Extracted from `server.js` (which must stay within the repository line budget) as one cohesive
// unit: "load the admission record, then run the STARTUP trigger before the listener opens".

import { installVaultReconciliation, listWebVaults, loadVaultAdmissions, startVaultDiscovery, stopVaultDiscovery, vaultDiscoveryStatus } from "./vault-registry.js";

export const VAULT_RECONCILIATION_STARTUP = "VAULT_RECONCILIATION_STARTUP";

/**
 * Load the single authoritative admission record. Fail-closed: a corrupt or unreadable file throws
 * (the caller must refuse startup and the file is left untouched). A missing file is NOT corruption:
 * it returns `{ exists: false }` and every discovered Vault stays `pending` until an administrator
 * explicitly initializes (contract §2.3).
 */
export async function loadVaultDiscoveryState() {
  const loaded = await loadVaultAdmissions();
  return Object.freeze({ ...loaded });
}

/**
 * Run the STARTUP trigger of the ONE reconciliation service, before `app.listen`.
 *
 * With admission enabled this is the only publisher of the inventory; a round that did not publish
 * is an explicit startup failure, never a silent "primary-only" degrade that opens Vaults anyway
 * (the W2 acceptance hard gate). Returns `{ enabled: false }` when admission is disabled, leaving
 * the pre-W2 explicit refresh to the caller.
 */
export async function startVaultReconciliation({ runtimeMap, logger = console } = {}) {
  // The record is ALWAYS loaded first (fail-closed on corruption) and the decision is taken from the
  // live enforcement state, never from the raw discovery switch (W2 fix, item 2).
  const loaded = await loadVaultDiscoveryState();
  if (!loaded.enabled) return Object.freeze({ enabled: false });
  installVaultReconciliation({ runtimeMap });
  await listWebVaults(); // memoized gated STARTUP trigger
  const startup = vaultDiscoveryStatus();
  if (startup.lastSuccessAt === null) {
    throw Object.assign(
      new Error(
        `[${VAULT_RECONCILIATION_STARTUP}] the startup Vault reconciliation did not publish ` +
          `(${startup.lastError?.stage ?? "unknown"}: ${startup.lastError?.message ?? "no run recorded"}); refusing to start`,
      ),
      { code: VAULT_RECONCILIATION_STARTUP },
    );
  }
  logger?.log?.(`[vault-reconciliation] startup published revision ${startup.revision} (${Object.keys(startup.vaults).length} Vault(s) observed)`);
  return Object.freeze({ enabled: true, revision: startup.revision });
}

/**
 * W4 (#437): arm the long-lived automatic triggers (directory watcher + bounded periodic fallback).
 *
 * Called by the PROCESS ENTRY (server.js) right after `startVaultRuntimeInventory`, never from the
 * startup helper itself: these two are long-lived resources that must be paired with an explicit
 * `stopVaultDiscoverySchedulers()`, so their owner is the entry point that also owns shutdown.
 * (On Windows an open directory watch can keep the process from exiting, so an embedder that starts
 * the inventory for a bounded run must not silently inherit a watcher it will never close.)
 *
 * With `VAULT_DISCOVERY_ENABLED` off this is a no-op: no watch handle, no timer (contract §10), while
 * the manual/Admin refresh path keeps working.
 */
export async function startVaultDiscoverySchedulers({ logger = console } = {}) {
  const scheduled = await startVaultDiscovery();
  if (scheduled !== null && scheduled.enabled === true) {
    logger?.log?.(
      `[vault-reconciliation] discovery triggers armed (watcher: ${scheduled.watcher}, periodic: ${scheduled.periodic}, ` +
        `debounce ${scheduled.debounceMs}ms, period ${scheduled.periodicMs}ms)`,
    );
  }
  return scheduled;
}

/** W4 (#437): release the watcher handles and the periodic timer during graceful shutdown. */
export function stopVaultDiscoverySchedulers() {
  return stopVaultDiscovery();
}

/**
 * Bring the runtime inventory up before `app.listen`.
 *
 * Admission enabled → the reconciliation service is the ONLY publisher and the STARTUP trigger runs
 * here (a round that did not publish is an explicit startup failure, never a silent primary-only
 * degrade that opens Vaults anyway — the W2 acceptance hard gate).
 * Admission disabled → the pre-W2 explicit refresh, where a failure degrades to primary-only.
 */
export async function startVaultRuntimeInventory({ runtimeMap, logger = console } = {}) {
  const startup = await startVaultReconciliation({ runtimeMap, logger });
  if (startup.enabled) return startup;
  try {
    await runtimeMap.refresh();
  } catch (error) {
    logger?.warn?.(`[vault-scope] Vault runtime map is primary-only: ${error?.message || error}`);
  }
  return Object.freeze({ enabled: false });
}

/**
 * `/healthz` payload for W2 (contract §6): the admission-file state plus the per-Vault discovery
 * projection. Bounded by the number of known Vaults — never a filesystem walk.
 */
export function vaultDiscoveryHealth() {
  const status = vaultDiscoveryStatus();
  return Object.freeze({
    vaultAdmissions: Object.freeze({ enabled: status.enabled === true, initialized: status.initialized ?? false, revision: status.revision ?? null }),
    vaultDiscovery: status,
  });
}
