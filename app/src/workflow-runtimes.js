// Wave D / D-workflows — the per-request runtime seam for the workflows / Bases toolset.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D workflows/Bases module lane — route the face through the real per-Vault runtime
//       instead of assuming the shared foundation made it per-Vault; never invent a second Vault
//       selector;
//   §10.1 the request-scoped runtime seam (a tool handler reads the *current* VaultRuntime);
//   §11  the Vault index runtime is per-Vault state — the Base query engine's record source is
//       therefore resolved through the selected Vault's index, not the primary facade;
//   §3.4 capabilities are runtime facts (an unwired Vault fails closed, never guesses);
//   §21  MV-I02 cross-Vault independence · MV-I03 no context bleed · MV-I07 primary compatibility;
//   §43-5 only the allowlisted `src/vault.js` facade imports the global root constants;
//   §47  RETURN list — a selected Vault is never served by the primary Vault's storage or index.
//
// Position in the chain:
//
//   vault-scope registrar -> request context { vaultId, vaultRuntime } -> this resolver
//                                                                        |-> vaultRuntime.localFs
//                                                                        |-> search runtime index
//
// Tool -> runtime mapping for the canonical tools of `src/tools/workflows.js` (the face this
// module owns):
//
//   | tool                  | resource resolved through this seam                        |
//   |-----------------------|-----------------------------------------------------------|
//   | list_bases            | `vaultRuntime.localFs` (walk the selected Vault's .base)   |
//   | get_base              | `vaultRuntime.localFs`                                    |
//   | write_base            | `vaultRuntime.localFs` (write + revision)                  |
//   | patch_base            | `vaultRuntime.localFs` (read + CAS revision + write)        |
//   | list_templates        | `vaultRuntime.localFs`                                     |
//   | set_property_type     | `vaultRuntime.localFs` (.obsidian/types.json)              |
//   | update_task           | `vaultRuntime.localFs` + `index.invalidate`                |
//   | daily_note            | `vaultRuntime.localFs` + `index.invalidate`                |
//   | create_from_template  | `vaultRuntime.localFs` + `index.invalidate`                |
//   | rename_property       | `vaultRuntime.localFs` + `index.getVaultIndex/invalidate`  |
//   | list_tasks            | `index.getVaultIndex` (the Vault's own note records)       |
//   | list_properties       | `index.getVaultIndex` + `vaultRuntime.localFs`             |
//   | list_aliases          | `index.getVaultIndex`                                      |
//   | query_base            | `index.getVaultIndex` (records) + `vaultRuntime.localFs`   |
//   | list_base_views       | `vaultRuntime.localFs` (read the selected Vault's .base)   |
//   | create_base_entry     | `vaultRuntime.localFs` (.base + template + new note) + `index.invalidate` |
//
// The Base *domain* service (`src/base-query.js`) and the pure workflow helpers
// (`src/workflows.js`) take their records/inputs as arguments and touch no Vault state, so they
// need no seam (they are shared by the Web Base route, which is out of this lane's scope).
//
// Resolution rules:
//   * `currentVaultRuntime()` is D-files' §10.1 seam: no request context (startup, Web/Admin,
//     direct in-process registration) or a context without a Vault selection keeps the exact
//     legacy primary behaviour (§21 MV-I07); a context that selected a Vault with a materialized
//     runtime uses that instance; a selection **without** one is refused structurally
//     (`vault_unavailable`) instead of being served by the primary Vault (§3.4/§47).
//   * the index comes from D-search's per-Vault search runtime (`searchRuntimeFor`), so a Vault
//     has exactly one index instance process-wide and this lane adds no second cache, no id-keyed
//     inventory and no module-level state (SEC-MV07 / §43-7). The primary Vault keeps the
//     process's existing index instance, so the legacy path is byte-identical.
//
// This module reads no `config.js` constant and holds no mutable state: it composes two existing
// seams and owns one refusal vocabulary.

import { VAULT_UNAVAILABLE, currentVaultRuntime } from "./vault-runtime/request-vault.js";
import { refusalForError as searchRefusalForError, searchRuntimeFor } from "./search-runtimes.js";

export { VAULT_UNAVAILABLE };

/**
 * The Vault selected by the ambient request plus the per-Vault resources the workflows / Bases
 * face reads. Frozen: callers cannot swap the runtime or index after resolution.
 *
 * @returns {Readonly<{vaultRuntime: object, vaultId: string, localFs: object, index: object}>}
 * @throws {Error & {code: "vault_unavailable"}} when the request selected a Vault that has no
 *   materialized VaultRuntime (fail closed; never the primary Vault).
 */
export function resolveWorkflowRuntime() {
  const vaultRuntime = currentVaultRuntime();
  return Object.freeze({
    vaultRuntime,
    vaultId: vaultRuntime.id,
    localFs: vaultRuntime.localFs,
    index: searchRuntimeFor(vaultRuntime).index,
  });
}

/**
 * MCP-shaped structured refusal for this seam's own `vault_unavailable` code (and for the
 * `vault_retrieval_unavailable` code D-search's resolver raises), or `null` for any other error so
 * a handler can write `return refusalForError(error) ?? err(error)`. The payload carries only the
 * Vault the caller itself asked for — never inventory facts (SEC-MV03).
 */
export function refusalForError(error) {
  const searchRefusal = searchRefusalForError(error);
  if (searchRefusal) return searchRefusal;
  if (error?.code !== VAULT_UNAVAILABLE) return null;
  const payload = { code: VAULT_UNAVAILABLE };
  if (typeof error.vaultId === "string") payload.vaultId = error.vaultId;
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}
