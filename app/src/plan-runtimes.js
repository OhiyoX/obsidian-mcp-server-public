// Wave D / D-plans — the per-request index seam for the plans / recovery face.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §10.1 the request-scoped runtime seam (a handler/model module reads the *current* VaultRuntime);
//   §11  the Vault index instance is per-Vault state — an invalidation carries its runtime;
//   §21  MV-I03 no cross-Vault context bleed · MV-I07 primary compatibility;
//   §3.4 capabilities are runtime facts · §43-5 facade allowlist · §47 a selected Vault is never
//        served by the primary Vault.
//
// Position in the chain:
//
//   vault-scope registrar -> request context { vaultId, vaultRuntime } -> this resolver -> index
//
// The plans face (`tools/plans.js` -> `src/mutation-plans.js#applyNotePlan`) and the recovery face
// (`tools/links.js#restore_version`, non-Markdown) commit a write through the request-routed
// mutation runtime, so the invalidation that follows must move the *selected* Vault's index
// generation — never the primary facade's, or a secondary mutation would leave its own index stale
// while advancing another Vault's generation (SEC-MV06).
//
// Resolution rules (D-files' `currentVaultRuntime` is the single source):
//   * no request context (startup, Web/Admin, direct in-process callers) -> the primary runtime,
//     whose index *is* the process's existing `src/vault-index.js` instance, so the legacy
//     single-Vault behaviour is byte-identical (§21 MV-I07);
//   * a selection with a materialized runtime -> that Vault's index instance, from D-search's
//     per-Vault cache (`searchRuntimeFor`, one instance process-wide, no second cache here);
//   * a selection **without** a materialized runtime -> `vault_unavailable` (§47), never the
//     primary index.
//
// This module reads no `config.js` constant and holds no module-level mutable state (§43-5,
// SEC-MV07): it composes two existing seams and owns one refusal vocabulary.

import { VAULT_UNAVAILABLE, currentVaultRuntime } from "./vault-runtime/request-vault.js";
import { searchRuntimeFor } from "./search-runtimes.js";

export { VAULT_UNAVAILABLE };

/**
 * The index instance of the Vault that owns the current call.
 *
 * @returns {object} a `createVaultIndexRuntime` instance (the primary Vault's process instance when
 *   no Vault was selected)
 * @throws {Error & {code: "vault_unavailable"}} when the request selected a Vault without a
 *   materialized runtime (fail closed; never the primary index)
 */
export function resolvePlanIndex() {
  return searchRuntimeFor(currentVaultRuntime()).index;
}

/**
 * Invalidate `paths` (a string, or an array of Vault-relative paths) on the *selected* Vault's
 * index after a committed plan / recovery write. `[]` is an index no-op that still schedules that
 * Vault's retrieval refresh, exactly like the legacy facade call it replaces.
 */
export function invalidateSelectedVaultIndex(paths) {
  return resolvePlanIndex().invalidate(paths);
}
