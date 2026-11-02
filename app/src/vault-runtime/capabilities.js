// Wave D — the per-Vault capability facts that are actually wired, in one place.
//
// Contract §3.4: a capability is a *runtime fact*, not an authorization, and an unwired capability
// must be reported `{available:false, reason}` (never omitted, never guessed `true`). Wave D lanes
// flip a key only in the same change that wires its tools; this module is that single seam for the
// files / history / trash / notes face (D-files), the git face (D-git), the memory / skills face
// (D-intelligence) and the plans / recovery face (D-plans), consumed by `createVaultRuntimeMap`'s
// `capabilitiesFor` default.
//
// It imports only A1's canonical `CAPABILITY_KEYS` + `unavailable()` so the entry shape stays
// single-sourced (§43-5: no config constant, no `process.env`, no I/O, no module-level mutable
// state).

import { CAPABILITY_KEYS, unavailable } from "./descriptor.js";

// Keys whose per-Vault facts this lane wired end to end: the canonical tool names below are now
// resolved through `requestContext().vaultRuntime` (§10.1) instead of the primary facade.
//   notes   — tools/notes.js (get_note, get_metadata, write_note, append_to_note, patch_note,
//             replace_in_note, manage_frontmatter, manage_tags)
//   files   — tools/files.js (list_files, pull_note_file, get_file, pull_file, write_file,
//             start_file_upload/upload_file_chunk/file_upload_status/cancel_file_upload,
//             create_archive, inspect_archive, read_archive_entry, extract_archive,
//             get_canvas, write_canvas, manage_folders)
//   history — list_versions / restore_version / delete_version (+ the pre-write snapshots every
//             routed write creates) via tools/links.js + mutation-plans.js
//   trash   — list_trash / restore_from_trash / delete_trash_entry via tools/links.js +
//             mutation-plans.js
//   git     — tools/git.js (git_status, git_diff, git_log, git_commit, git_pull, git_push) resolves
//             `requestContext().vaultRuntime` -> that Vault's own GitRuntime
//             (`src/git-runtimes.js`, D-git): a secondary reads/commits its own repository, a
//             selection with no runtime is refused structurally, and an unmaterialized Vault never
//             silently falls back to the primary repository
//             (SEC-MV06 / §47). The key is a *wiring* fact — whether this Vault's Git is enabled,
//             has a repository, or is push-failing remains the runtime's own §16.2 state, reported
//             by `git_status.configuration`.
//   memory  — tools/intelligence.js (memory_capture, memory_recall) writes/reads under the
//             Vault-relative managed root and drives that Vault's own index invalidation +
//             retrieval sync; the write path, the existence probe and the index/retrieval
//             side effects all follow `requestContext().vaultRuntime` (D-intelligence).
//   skills  — src/skills.js + tools/intelligence.js (skill_list, skill_match, skill_validate,
//             skill_export, skill_import) resolve the Vault-relative managed Skills root, the
//             archive paths and the recall used for matching against the selected Vault
//             (D-intelligence).
//   plans   — tools/plans.js (plan_restore_from_trash, plan_restore_version, plan_delete_note,
//             plan_move_note, plan_note_changes, get_note_plan, apply_note_plan, get_note_version,
//             compare_note_versions) creates / reads / applies plans whose paths, revisions,
//             versions, Trash sources, mutation lock, journal, 24h idempotency records and index
//             invalidation all resolve through the selected Vault (D-files' request-runtime seam
//             plus D-plans' index invalidation); a plan is bound to its creating Vault (§13.1).
//   publish — tools/publish.js (get_publish_status, manage_publish) was already Vault-routed before
//             Wave D: the handler reads the *selected* `requestContext().vaultId` and
//             `src/publish/service.js` resolves that id through the canonical Web VaultRegistry
//             (`src/app/vault-registry.js` -> A2 `createVaultRegistry`), so every stat/read/write
//             lands in the selected Vault's own root and every record is keyed by
//             `vaultId + NUL + path`. D-publish verified this with a real dual-Vault matrix
//             (secondary publish/status/revoke touch only secondary records; primary zero
//             side-effect; unmaterialized/unauthorized ids refused before the handler; no primary
//             fallback) and only then flipped the key — the fact was already true, so leaving it
//             `available:false` was an under-report (§3.4 forbids guessing in either direction).
//             Declared residuals (unchanged by this lane, sanctioned by contract §13.5/§14): the
//             registry itself is one process-level file (`DATA_PATH/publish/state.json`) with one
//             mutation queue, i.e. vault-keyed records in a shared store rather than one store file
//             per Vault; and publish resolves through the canonical Web registry instead of
//             `requestContext().vaultRuntime` because it needs no per-Vault runtime instance.
//             Anonymous `/publish/<opaque-id>` resolve stays a public capability bound by the
//             record's own vaultId (§13.5), deliberately outside the credential allowlist.
//   retrieval — Wave F / F1 (§31) converged the last map-level key this lane was missing: B2's
//             `VaultIndex` and B3's retrieval runtime are materialized per Vault
//             (`src/vault-runtime/search-runtime.js`, one `index` + one `retrieval` instance per
//             runtime, the retrieval runtime's only index source being *that* Vault's index), and
//             every index/retrieval tool (`search_notes`, `list_notes`, `list_recent`,
//             `list_tags`, `index_status`, `reindex_vault`, `recall`, `find_related`,
//             `suggest_links`, `get_note_context`, `graph_health`, the graph/link readers) is
//             routed through `requestContext().vaultRuntime` with a structured
//             `vault_retrieval_unavailable` refusal and never a primary-index fallback
//             (D-search matrix; `test/search-runtime-composition.test.js`). The fact was already
//             true per Vault, so a static `available:false` here was an under-report
//             (contract §3.4 forbids guessing in either direction). Flipping the key only at the
//             map level changes no tool behaviour: the tools never read this graph; the graph is
//             what `server_info`/Admin now report through the canonical registry.
export const WIRED_CAPABILITY_KEYS = Object.freeze(["notes", "files", "history", "trash", "git", "memory", "skills", "plans", "publish", "retrieval"]);

const WIRED = new Set(WIRED_CAPABILITY_KEYS);

/**
 * The recorded reason a key is NOT wired, plus the module that owns the fact, so an unwired key is
 * a decision with an owner instead of a leftover (§3.4). F1 §31 additionally freezes this table in
 * the architecture tests: the owner path must exist.
 *
 * `semantic` is a *composite* fact (index wired AND the process-shared embedding provider
 * enabled). `src/vault-runtime/retrieval-runtime.js#semanticCapability()` already answers it per
 * Vault — `{available:false, reason}` whenever the provider is disabled — so a static
 * `{available:true}` in this graph would over-claim on a `EMBEDDING_PROVIDER=disabled`
 * deployment (§3.4/§47). Reporting the real composite fact belongs to the per-Vault capability
 * surface, not to a hard-coded key, and is the recorded follow-up (F1 HANDOFF §proposal).
 */
export const UNWIRED_CAPABILITY_DECISIONS = Object.freeze({
  semantic: Object.freeze({
    owner: ["src/vault-runtime/retrieval-runtime.js", "src/vault-runtime/search-runtime.js"],
    reason: "semantic is a composite of the per-Vault retrieval wiring and the process-shared embedding provider: `src/vault-runtime/retrieval-runtime.js`#semanticCapability() reports the honest per-Vault fact ({available:false, reason} when the provider is disabled) and `src/vault-runtime/search-runtime.js` copies that fact into the composition's capability map, so a static available:true here would over-claim whenever EMBEDDING_PROVIDER=disabled (contract §3.4/§47)",
  }),
  webCatalog: Object.freeze({
    owner: ["src/app/web-catalog/runtime.js"],
    reason: "the per-Vault Web catalog runtime (`src/app/web-catalog/runtime.js`, one sqlite per Vault id) is a Web-plane subsystem: the MCP Base/query path reads the selected Vault's own VaultIndex and localFs and never the catalog, so flipping this key on a VaultRuntime would claim a capability no MCP tool consumes (D-workflows evidence; contract §3.4)",
  }),
  events: Object.freeze({
    owner: ["src/app/live-events.js"],
    reason: "Vault-keyed live events (`src/app/live-events.js`, one watcher per Vault, publishVaultResync(vaultId, ...)) belong to the Web/SSE delivery plane and have no MCP tool: the VaultRuntime capability graph has no consumer for the key, so it stays fail-closed here and is reported as a Web-plane fact (contract §3.4/§18)",
  }),
});

const UNWIRED_REASON = "no Wave D lane has wired this capability yet (contract §3.4: report unavailable + reason instead of guessing)";

/**
 * The canonical capability graph with exactly `WIRED_CAPABILITY_KEYS` available and every other
 * `CAPABILITY_KEYS` entry `{available:false, reason}`. Frozen, and validated by A1's shape rules
 * when it reaches a runtime (`createVaultRuntime` → `normalizeRuntimeCapabilities`).
 */
export function wiredCapabilities() {
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) capabilities[key] = WIRED.has(key) ? Object.freeze({ available: true }) : unavailable(UNWIRED_CAPABILITY_DECISIONS[key]?.reason ?? UNWIRED_REASON);
  return Object.freeze(capabilities);
}
