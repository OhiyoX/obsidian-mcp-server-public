// Multi-Vault Wave 0 / W0-B — frozen canonical tool classification (characterization only).
//
// Contract: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库
// （vault scope）与按库 Git 配置.md` §7 (canonical tool vault-scope registry), §13.5 (other
// handles), §25 W0-B (tool inventory), §43 (architecture tests), §44 (old-red list).
//
// This module is DATA ONLY — it exports frozen constants and performs no logic, no I/O and no
// registration. Every entry is asserted against a real source of truth by
// `app/test/multi-vault-tool-inventory.test.js`:
//   - tool set / order        -> `TOOL_NAMES` in `app/src/config.js`
//   - real registration names -> `registerObsidianCapabilities(server)` capture shell
//   - `module`                -> source scan of `app/src/tools/*.js`
//   - required scopes         -> `MCP_TOOL_SCOPE_REQUIREMENTS` in `app/src/scopes.js`
//
// `surface` follows the frozen rule of contract §7.1: `global` is exactly
// `{agent_bootstrap, server_info}`; every other canonical tool is `vault-scoped`.
// `handles` lists cross-call handles the tool consumes and/or produces (contract §13.5):
// opaque durable ids kept in process/global stores, plus vault-relative path references that
// are re-interpreted in the selected vault on the next call. Tokens come from `HANDLE_TOKENS`;
// an empty array means "no cross-call handle was proven from source".
//
// Wave A / A3 will absorb this table into production `app/src/vault-scope.js` (the canonical
// registry plus the §7.3 `vaultId` schema injection); at that point this test helper must be
// removed and the test must consume the production module instead.

/** Frozen tool-level handle vocabulary. `kind` is documentation, not behavior. */
export const HANDLE_TOKENS = Object.freeze([
  // opaque durable ids — stored outside the vault, can outlive the call that created them
  "planId", // in-process mutation-plans Map (TTL bounded)
  "uploadId", // DATA_PATH/transfers/uploads/<uploadId>.{json,part}
  "versionId", // path relative to global HISTORY_PATH
  "backupPath", // path relative to global TRASH_PATH
  "publishId", // publish record id embedded in publicPath/publicUrl
  "idempotencyKey", // DATA_PATH/mutation-idempotency/<digest>.json
  // vault-relative path references — resolved inside the selected vault on each call
  "cursor", // opaque pagination cursor returned as nextCursor (list_notes/list_files)
  "archivePath", // vault-relative ZIP path (create/inspect/extract/skill import)
  "skillPackagePath", // vault-relative exported skill ZIP path
]);

export const HANDLE_DIRECTIONS = Object.freeze(["consumes", "produces"]);

/** Tools with no vault dependency (contract §7.1). */
export const GLOBAL_TOOLS = Object.freeze(["agent_bootstrap", "server_info"]);

const h = (token, direction) => Object.freeze({ token, direction });
const produces = (token) => h(token, "produces");
const consumes = (token) => h(token, "consumes");

/**
 * `TOOL_NAMES` order, one entry per canonical tool.
 * Fields: `surface` ("global" | "vault-scoped"), `module` (registering file under
 * `app/src/tools/`), `handles` (frozen cross-call handle array).
 */
export const TOOL_CLASSIFICATION = Object.freeze({
  // app/src/tools/info.js
  agent_bootstrap: Object.freeze({ surface: "global", module: "info.js", handles: Object.freeze([]) }),
  server_info: Object.freeze({ surface: "global", module: "info.js", handles: Object.freeze([]) }),
  // app/src/tools/notes.js
  get_note: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  pull_note_file: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  get_metadata: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  // app/src/tools/search.js
  list_notes: Object.freeze({ surface: "vault-scoped", module: "search.js", handles: Object.freeze([consumes("cursor"), produces("cursor")]) }),
  // app/src/tools/files.js
  list_files: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("cursor"), produces("cursor")]) }),
  // app/src/tools/search.js
  list_recent: Object.freeze({ surface: "vault-scoped", module: "search.js", handles: Object.freeze([]) }),
  search_notes: Object.freeze({ surface: "vault-scoped", module: "search.js", handles: Object.freeze([]) }),
  // app/src/tools/files.js
  get_file: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  pull_file: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  write_file: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  start_file_upload: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([produces("uploadId")]) }),
  file_upload_status: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("uploadId")]) }),
  upload_file_chunk: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("uploadId")]) }),
  cancel_file_upload: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("uploadId")]) }),
  create_archive: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([produces("archivePath")]) }),
  inspect_archive: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("archivePath")]) }),
  read_archive_entry: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("archivePath")]) }),
  extract_archive: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([consumes("archivePath")]) }),
  get_canvas: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  write_canvas: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  // app/src/tools/notes.js
  write_note: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  append_to_note: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  patch_note: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  replace_in_note: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  manage_frontmatter: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  // app/src/tools/search.js
  list_tags: Object.freeze({ surface: "vault-scoped", module: "search.js", handles: Object.freeze([]) }),
  // app/src/tools/notes.js
  manage_tags: Object.freeze({ surface: "vault-scoped", module: "notes.js", handles: Object.freeze([]) }),
  // app/src/tools/links.js
  move_note: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  delete_note: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  list_trash: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([produces("backupPath")]) }),
  restore_from_trash: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([consumes("backupPath")]) }),
  delete_trash_entry: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([consumes("backupPath")]) }),
  list_versions: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([produces("versionId")]) }),
  restore_version: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([consumes("versionId")]) }),
  delete_version: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([consumes("versionId")]) }),
  // app/src/tools/files.js
  manage_folders: Object.freeze({ surface: "vault-scoped", module: "files.js", handles: Object.freeze([]) }),
  // app/src/tools/links.js
  get_backlinks: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  get_graph: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  get_unresolved_links: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  get_orphans: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  get_deadends: Object.freeze({ surface: "vault-scoped", module: "links.js", handles: Object.freeze([]) }),
  // app/src/tools/workflows.js
  list_tasks: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  update_task: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  daily_note: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  list_templates: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  create_from_template: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  list_properties: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  list_aliases: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  rename_property: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  set_property_type: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  list_bases: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  get_base: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  write_base: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  // P1 (#629): the line-surgical `.base` increment consumes the revision `get_base`
  // reports and returns a new one, but `revision` is not part of the frozen
  // `HANDLE_TOKENS` vocabulary, so it is not claimed as a cross-call handle here
  // (same shape as its `write_base` sibling).
  patch_base: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  // P1 (#630): the create face reads/writes only the selected Vault (its .base, its
  // template note, its entry path) and holds no cross-call handle.
  create_base_entry: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  query_base: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  // A2: the read-only view selector reads the selected Vault's .base and holds no
  // cross-call handle (same shape as its get_base/query_base siblings).
  list_base_views: Object.freeze({ surface: "vault-scoped", module: "workflows.js", handles: Object.freeze([]) }),
  // app/src/tools/git.js
  git_status: Object.freeze({ surface: "vault-scoped", module: "git.js", handles: Object.freeze([]) }),
  git_diff: Object.freeze({ surface: "vault-scoped", module: "git.js", handles: Object.freeze([]) }),
  git_log: Object.freeze({ surface: "vault-scoped", module: "git.js", handles: Object.freeze([]) }),
  git_commit: Object.freeze({ surface: "vault-scoped", module: "git.js", handles: Object.freeze([]) }),
  git_pull: Object.freeze({ surface: "vault-scoped", module: "git.js", handles: Object.freeze([]) }),
  git_push: Object.freeze({ surface: "vault-scoped", module: "git.js", handles: Object.freeze([]) }),
  // app/src/tools/intelligence.js
  index_status: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  reindex_vault: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  recall: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  find_related: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  get_note_context: Object.freeze({ surface: "vault-scoped", module: "context.js", handles: Object.freeze([]) }),
  graph_health: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  suggest_links: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  memory_capture: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  memory_recall: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  skill_list: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  skill_match: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  skill_validate: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([]) }),
  skill_export: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([produces("skillPackagePath")]) }),
  skill_import: Object.freeze({ surface: "vault-scoped", module: "intelligence.js", handles: Object.freeze([consumes("archivePath")]) }),
  // app/src/tools/publish.js
  get_publish_status: Object.freeze({ surface: "vault-scoped", module: "publish.js", handles: Object.freeze([produces("publishId")]) }),
  manage_publish: Object.freeze({ surface: "vault-scoped", module: "publish.js", handles: Object.freeze([produces("publishId")]) }),
  // app/src/tools/plans.js
  plan_note_changes: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([produces("planId")]) }),
  plan_move_note: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([produces("planId")]) }),
  plan_delete_note: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([produces("planId")]) }),
  plan_restore_version: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([consumes("versionId"), produces("planId")]) }),
  plan_restore_from_trash: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([consumes("backupPath"), produces("planId")]) }),
  get_note_plan: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([consumes("planId")]) }),
  apply_note_plan: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([consumes("planId"), consumes("idempotencyKey")]) }),
  get_note_version: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([consumes("versionId")]) }),
  compare_note_versions: Object.freeze({ surface: "vault-scoped", module: "plans.js", handles: Object.freeze([consumes("versionId")]) }),
});
