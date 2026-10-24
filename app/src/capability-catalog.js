// Static Capability Catalog parity layer (Progressive Tool Discovery, Phase 1 narrow step).
//
// This module is DATA plus pure derivations only. It is not imported by
// `server.js`, `capabilities.js`, any `register*Tools` function, `config.js`,
// `scopes.js`, or `tool-contracts.js`, so it cannot change registration,
// authorization, `tools/list`, or any other runtime behavior.
//
// Every field is either verified from an existing repository source or is
// explicitly reported as a gap. No capability/domain/intent taxonomy is
// invented here. The catalog only *describes* the current eager catalog; it
// does not filter, defer, activate, or expose a dynamic visible view.

import { TOOL_NAMES } from "./config.js";

export const CAPABILITY_CATALOG_SCHEMA_VERSION = 1;

// Verified evidence for each catalog field. Tests assert against the same
// sources named here.
export const CAPABILITY_CATALOG_FIELD_SOURCES = Object.freeze({
  name: "app/src/config.js TOOL_NAMES (canonical tool name; equals tools/list name)",
  toolset: "source evidence: the app/src/tools/*.js registration module whose register*Tools calls server.registerTool(name, ...), reached through app/src/capabilities.js",
  domain: "unverified: no canonical capability/domain taxonomy exists in the runtime (Phase 1 gap)",
  aliases: "verified none: the runtime declares no alias table and tools/list names equal TOOL_NAMES",
  intents: "unverified: no canonical intent taxonomy exists in the runtime (Phase 1 gap)",
  visibility: "source evidence: registerObsidianCapabilities registers every tool unconditionally and tools/list carries no visibility filter",
  relatedTools: "derived structural relation: sibling tools registered by the same source module (not a capability-semantics claim)",
  scope: "source evidence: app/src/scopes.js MCP_TOOL_SCOPE_REQUIREMENTS (authorization truth; not carried in tools/list)",
});

// Axes the prompt asks for that cannot be filled from existing sources without
// inventing semantics. They stay empty/null and are reported here.
export const CAPABILITY_CATALOG_GAPS = Object.freeze([
  Object.freeze({
    field: "domain",
    status: "unverified",
    value: null,
    reason: "No canonical capability-catalog taxonomy is implemented. toolset (source registration module) is the verified proxy.",
  }),
  Object.freeze({
    field: "intents",
    status: "unverified",
    value: Object.freeze([]),
    reason: "No canonical intent taxonomy exists in the runtime. Populating intents would invent capability semantics.",
  }),
]);

// Canonical source registration module per toolset id (source evidence).
export const TOOLSET_MODULES = Object.freeze({
  info: "tools/info.js",
  notes: "tools/notes.js",
  search: "tools/search.js",
  files: "tools/files.js",
  links: "tools/links.js",
  workflows: "tools/workflows.js",
  git: "tools/git.js",
  intelligence: "tools/intelligence.js",
  context: "tools/context.js",
  publish: "tools/publish.js",
  plans: "tools/plans.js",
});

// Registration order within each source module, captured from the real
// register*Tools functions. Tests re-derive this from source so drift fails.
export const TOOLSET_TOOLS = Object.freeze({
  info: Object.freeze(["agent_bootstrap", "server_info"]),
  notes: Object.freeze([
    "get_note", "get_metadata", "write_note", "append_to_note", "patch_note",
    "replace_in_note", "manage_frontmatter", "manage_tags",
  ]),
  search: Object.freeze(["list_notes", "list_recent", "search_notes", "list_tags"]),
  files: Object.freeze([
    "list_files", "pull_note_file", "get_file", "pull_file", "write_file",
    "start_file_upload",
  "start_direct_upload", "upload_file_chunk", "file_upload_status", "cancel_file_upload",
    "create_archive", "inspect_archive", "read_archive_entry", "extract_archive", "get_canvas", "write_canvas",
    "manage_folders",
  ]),
  links: Object.freeze([
    "move_note", "delete_note", "get_backlinks", "list_trash", "restore_from_trash",
    "list_versions", "delete_trash_entry", "restore_version", "delete_version", "get_graph",
    "get_unresolved_links", "get_orphans", "get_deadends",
  ]),
  workflows: Object.freeze([
    "list_tasks", "update_task", "daily_note", "list_templates", "create_from_template",
    "list_properties", "rename_property", "list_aliases", "set_property_type", "list_bases",
    "get_base", "write_base", "patch_base", "create_base_entry", "query_base", "list_base_views",
  ]),
  git: Object.freeze(["git_status", "git_diff", "git_log", "git_commit", "git_pull", "git_push"]),
  intelligence: Object.freeze([
    "index_status", "reindex_vault", "recall", "find_related", "graph_health", "suggest_links",
    "memory_capture", "memory_recall", "skill_list", "skill_match", "skill_validate",
    "skill_export", "skill_import",
  ]),
  context: Object.freeze(["get_note_context"]),
  publish: Object.freeze(["get_publish_status", "manage_publish"]),
  plans: Object.freeze([
    "plan_restore_from_trash", "plan_restore_version", "plan_delete_note", "plan_move_note",
    "plan_note_changes", "get_note_plan", "apply_note_plan", "get_note_version",
    "compare_note_versions",
  ]),
});

// Every tool currently requires obsidian.read; only the extra scopes are
// recorded here. Tests compare this against scopes.js.
const TOOL_EXTRA_SCOPES = Object.freeze({
  pull_note_file: Object.freeze(["obsidian.files"]),
  get_file: Object.freeze(["obsidian.files"]),
  pull_file: Object.freeze(["obsidian.files"]),
  write_file: Object.freeze(["obsidian.write"]),
  start_file_upload: Object.freeze(["obsidian.write", "obsidian.files"]),
  start_direct_upload: Object.freeze(["obsidian.write", "obsidian.files"]),
  file_upload_status: Object.freeze(["obsidian.files"]),
  upload_file_chunk: Object.freeze(["obsidian.write", "obsidian.files"]),
  cancel_file_upload: Object.freeze(["obsidian.write", "obsidian.files"]),
  create_archive: Object.freeze(["obsidian.write", "obsidian.files"]),
  inspect_archive: Object.freeze(["obsidian.files"]),
  read_archive_entry: Object.freeze(["obsidian.files"]),
  extract_archive: Object.freeze(["obsidian.write", "obsidian.files"]),
  write_canvas: Object.freeze(["obsidian.write"]),
  write_note: Object.freeze(["obsidian.write"]),
  append_to_note: Object.freeze(["obsidian.write"]),
  patch_note: Object.freeze(["obsidian.write"]),
  replace_in_note: Object.freeze(["obsidian.write"]),
  manage_frontmatter: Object.freeze(["obsidian.write"]),
  manage_tags: Object.freeze(["obsidian.write"]),
  move_note: Object.freeze(["obsidian.write"]),
  delete_note: Object.freeze(["obsidian.write"]),
  restore_from_trash: Object.freeze(["obsidian.write"]),
  delete_trash_entry: Object.freeze(["obsidian.write"]),
  restore_version: Object.freeze(["obsidian.write"]),
  delete_version: Object.freeze(["obsidian.write"]),
  manage_folders: Object.freeze(["obsidian.write"]),
  update_task: Object.freeze(["obsidian.write"]),
  create_from_template: Object.freeze(["obsidian.write"]),
  rename_property: Object.freeze(["obsidian.write"]),
  set_property_type: Object.freeze(["obsidian.write"]),
  write_base: Object.freeze(["obsidian.write"]),
  patch_base: Object.freeze(["obsidian.write"]),
  create_base_entry: Object.freeze(["obsidian.write"]),
  git_commit: Object.freeze(["obsidian.write"]),
  git_pull: Object.freeze(["obsidian.write"]),
  git_push: Object.freeze(["obsidian.write"]),
  memory_capture: Object.freeze(["obsidian.write"]),
  skill_export: Object.freeze(["obsidian.write", "obsidian.files"]),
  skill_import: Object.freeze(["obsidian.write", "obsidian.files"]),
  manage_publish: Object.freeze(["obsidian.write"]),
  apply_note_plan: Object.freeze(["obsidian.write"]),
  daily_note: Object.freeze(["obsidian.write"]),
});

// The only visibility mode implemented today: every registered tool is visible
// in tools/list unconditionally.
export const EAGER_VISIBILITY = "eager";

const TOOL_INDEX = new Map(TOOL_NAMES.map((name, index) => [name, index]));

const TOOLSET_BY_TOOL = new Map();
for (const [toolset, tools] of Object.entries(TOOLSET_TOOLS)) {
  for (const name of tools) {
    if (TOOLSET_BY_TOOL.has(name)) throw new Error(`Capability catalog maps tool ${name} to multiple toolsets`);
    TOOLSET_BY_TOOL.set(name, toolset);
  }
}

function scopeFor(name) {
  return Object.freeze(["obsidian.read", ...(TOOL_EXTRA_SCOPES[name] || [])]);
}

function buildCatalog() {
  return TOOL_NAMES.map((name) => {
    const toolset = TOOLSET_BY_TOOL.get(name);
    if (!toolset) throw new Error(`Capability catalog is missing tool ${name}`);
    const related = TOOLSET_TOOLS[toolset]
      .filter((sibling) => sibling !== name)
      .sort((a, b) => TOOL_INDEX.get(a) - TOOL_INDEX.get(b));
    return Object.freeze({
      name,
      toolset,
      domain: null,
      aliases: Object.freeze([]),
      intents: Object.freeze([]),
      visibility: EAGER_VISIBILITY,
      relatedTools: Object.freeze(related),
      scope: scopeFor(name),
    });
  });
}

// Catalog entries ordered exactly like TOOL_NAMES.
export const CAPABILITY_CATALOG = Object.freeze(buildCatalog());

export const CAPABILITY_CATALOG_BY_NAME = Object.freeze(
  Object.fromEntries(CAPABILITY_CATALOG.map((entry) => [entry.name, entry])),
);

export const CAPABILITY_CATALOG_TOOL_COUNT = CAPABILITY_CATALOG.length;

export function catalogEntry(name) {
  return CAPABILITY_CATALOG_BY_NAME[name] || null;
}

export function toolsetForTool(name) {
  return TOOLSET_BY_TOOL.get(name) || null;
}
