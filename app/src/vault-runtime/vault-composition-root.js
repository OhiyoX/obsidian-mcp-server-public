// Wave E / EA + Wave F / F1 (D1): Vault Git and runtime composition root
//
// Extracted from server.js to satisfy Wave F's line-budget ratchet. The composition root
// assembles the vault-facing services (Git admin, runtime map, vault scope deps) from
// the canonical registry and primary runtime, keeping server.js under the ≤498 line budget.

import { createVaultGitAdminAssembly } from "../admin/vault-git-assembly.js";
import { gitConfigStoreInstance, primaryGitRuntime } from "../git.js";
import { createVaultRuntimeMap } from "./instances.js";
import { bindPrimaryAuthorization, primaryAuthorizationState } from "./primary-authorization.js";
import { releaseVaultRuntimeCaches } from "./runtime-release.js";
import { requireRequestAuthor } from "../request-context.js";

/**
 * Assemble the vault composition root: Git admin, runtime map, and vault scope deps.
 * Returns { vaultGitAdmin, vaultRuntimeMap, vaultScopeDeps }.
 *
 * Wave F / F1 (D1): contract §43-5 prohibits new vault-runtime modules from importing global path
 * constants (VAULT/DATA_PATH/READ_ONLY). server.js injects them here as parameters.
 */
export function createVaultCompositionRoot({ registry, primaryRuntime, primaryRoot, dataRoot, writable, admission = null }) {
  // Wave E / EA + Wave F / F1 (D1): the Auth Center "Vault 与 Git" tab (E2's routes) is assembled
  // from the process's existing state (contract §17, §27 B4/B7, §30 E2). The A2 registry is the
  // Web face's ONE canonical instance, injected here at the composition root and reused by the D0
  // runtime map below — the assembly never builds a second inventory (§31, §43-3). No store, no
  // repo, or an unreadable inventory degrades to an absent tab / a primary-only view.
  const vaultGitAssembly = createVaultGitAdminAssembly({
    registry,
    store: gitConfigStoreInstance(),
    primaryRuntime: primaryGitRuntime(),
    primaryRoot,
    writable,
    logger: console,
    admission,
  });
  const vaultGitAdmin = vaultGitAssembly.admin;
  // The A5 Git-config store, so the Admin repair path can quarantine a broken document instead of
  // only reporting it. Null when the assembly is degraded (then no repair is offered).
  const vaultGitStore = vaultGitAssembly.store ?? null;

  // Wave D / D0 (§29): one VaultRuntime per canonical registry Vault; W2FIX3 drainFor stops its Git/search caches.
  const vaultRuntimeMap = createVaultRuntimeMap({
    registry,
    primaryRuntime,
    dataRoot,
    deps: { requireRequestAuthor },
    // Bind at construction and each composed publish, before any Git/search resolver query.
    onPrimaryLease: (lease, isCurrent) => {
      // The map's pre-load fallback is not admission evidence. Explicit legacy bootstrap stays valid.
      if (primaryAuthorizationState().mode === "legacy" && lease.identityDigest === null) return;
      bindPrimaryAuthorization(lease, () => lease.identityDigest !== null && isCurrent());
    },
    drainFor: (_descriptor, handle) => releaseVaultRuntimeCaches(handle),
  });

  const vaultScopeDeps = {
    resolveVaultRuntime: (id) => vaultRuntimeMap.get(id),
    vaultExists: (id) => vaultRuntimeMap.has(id),
  };

  return { vaultGitAdmin, vaultGitStore, vaultRuntimeMap, vaultScopeDeps };
}
