// MCP Interface v2 experimental adapter. No new application handler, OAuth scope,
// Vault selection, or mutation implementation lives here. Native registered tools
// remain the sole execution authority; this module only builds a bounded view.
import { TOOL_NAMES } from "./config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "./scopes.js";

export const COMPACT_GROUPS = Object.freeze({
  agent_bootstrap: ["agent_bootstrap"],
  obsidian_info: ["server_info", "index_status"],
  obsidian_search: ["search_notes", "recall", "find_related", "list_recent", "memory_recall"],
  obsidian_read: ["get_note", "get_metadata", "get_note_context", "get_canvas", "get_base", "query_base", "list_base_views"],
  obsidian_browse: ["list_notes", "list_files", "list_tags", "list_tasks", "list_templates", "list_properties", "list_aliases", "list_bases"],
  obsidian_graph: ["get_backlinks", "get_graph", "get_unresolved_links", "get_orphans", "get_deadends", "graph_health", "suggest_links"],
  obsidian_edit: ["write_note", "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter", "manage_tags", "update_task", "daily_note", "write_canvas", "write_base", "patch_base", "create_base_entry"],
  obsidian_organize: ["move_note", "manage_folders", "rename_property", "set_property_type", "create_from_template"],
  obsidian_plan: ["plan_note_changes", "plan_move_note", "plan_delete_note", "plan_restore_version", "plan_restore_from_trash", "get_note_plan"],
  obsidian_apply: ["apply_note_plan"],
  obsidian_soft_delete: ["delete_note"],
  obsidian_restore: ["restore_from_trash", "restore_version"],
  obsidian_purge: ["delete_trash_entry", "delete_version"],
  obsidian_history: ["list_trash", "list_versions", "get_note_version", "compare_note_versions"],
  obsidian_file_read: ["get_file", "pull_file", "pull_note_file", "inspect_archive", "read_archive_entry", "file_upload_status"],
  obsidian_file_mutate: ["write_file", "create_archive", "extract_archive"],
  obsidian_file_upload: ["start_file_upload", "upload_file_chunk", "cancel_file_upload"],
  obsidian_git_read: ["git_status", "git_diff", "git_log"],
  obsidian_git_commit: ["git_commit"],
  obsidian_git_sync: ["git_pull", "git_push"],
  obsidian_index_rebuild: ["reindex_vault"],
  obsidian_memory_capture: ["memory_capture"],
  obsidian_skill_read: ["skill_list", "skill_match", "skill_validate"],
  obsidian_skill_transfer: ["skill_export", "skill_import"],
  obsidian_publish_read: ["get_publish_status"],
  obsidian_publish_write: ["manage_publish"],
});

// Preserve these discoverable entry points unchanged, including their native
// schemas. server_info must also remain reachable during a temporal suspension.
export const COMPACT_PASSTHROUGH = Object.freeze(["agent_bootstrap", "server_info"]);
const PASSTHROUGH = new Set(COMPACT_PASSTHROUGH);
const sourceToDomain = new Map();
for (const [domain, names] of Object.entries(COMPACT_GROUPS)) {
  for (const name of names) {
    if (sourceToDomain.has(name)) throw new Error("Duplicate compact source: " + name);
    sourceToDomain.set(name, domain);
  }
}
const canonical = new Set(TOOL_NAMES);
if (sourceToDomain.size !== canonical.size || [...sourceToDomain.keys()].some((name) => !canonical.has(name))) {
  throw new Error("Compact tool mapping must cover canonical tools exactly once");
}

function riskAnnotation(annotation = {}) {
  const readOnlyHint = annotation.readOnlyHint === true;
  return Object.freeze({
    readOnlyHint,
    destructiveHint: readOnlyHint ? false : annotation.destructiveHint !== false,
    idempotentHint: readOnlyHint || annotation.idempotentHint === true,
    openWorldHint: annotation.openWorldHint === true,
  });
}

function signature(name, descriptor) {
  const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[name];
  if (!scopes) throw new Error("Missing canonical scope: " + name);
  const risk = riskAnnotation(descriptor.annotations);
  return JSON.stringify({ scopes, risk });
}

function suffixFor(name, descriptor) {
  const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[name];
  const a = riskAnnotation(descriptor.annotations);
  const tags = [scopes.includes("obsidian.write") ? "write" : "read"];
  if (scopes.includes("obsidian.files")) tags.push("files");
  if (a.openWorldHint) tags.push("external");
  if (a.destructiveHint) tags.push("destructive");
  if (!a.idempotentHint) tags.push("nonidempotent");
  return tags.join("_");
}

function actionInputSchema(members) {
  const branches = members.map((tool) => ({
    type: "object",
    properties: {
      action: { type: "string", const: tool.name },
      params: tool.inputSchema,
    },
    required: ["action", "params"],
    additionalProperties: false,
  }));
  return {
    type: "object",
    description: "Choose an action and pass its native validated parameters inside params.",
    properties: {
      action: { type: "string", enum: members.map((tool) => tool.name) },
      params: { type: "object" },
    },
    required: ["action", "params"],
    additionalProperties: false,
    oneOf: branches,
  };
}

/**
 * Generate descriptors from the SDK's actual native list, never guessed schemas.
 * Partition by *identical* Scope and complete annotation signatures; mixing
 * different MCP risk hints into a single descriptor is explicitly forbidden.
 *
 * The full native list determines names; the caller's per-request view reduces
 * membership and description *before* any virtual descriptor is emitted.
 */
export function compactToolView(nativeTools, allowedToolNames) {
  const native = new Map(nativeTools.map((tool) => [tool.name, tool]));
  if (native.size !== canonical.size || TOOL_NAMES.some((name) => !native.has(name))) {
    throw new Error("Native tool list is out of sync with the compact mapping");
  }
  const allowed = new Set(allowedToolNames);
  const descriptors = [];
  const routing = new Map();

  for (const [domain, names] of Object.entries(COMPACT_GROUPS)) {
    const partitions = new Map();
    for (const name of names) {
      if (PASSTHROUGH.has(name)) continue;
      const descriptor = native.get(name);
      const id = signature(name, descriptor);
      if (!partitions.has(id)) partitions.set(id, []);
      partitions.get(id).push(descriptor);
    }
    for (const group of partitions.values()) {
      const visible = group.filter((tool) => allowed.has(tool.name));
      if (!visible.length) continue;
      const first = group[0];
      const name = partitions.size === 1 ? domain : domain + "_" + suffixFor(first.name, first);
      if (routing.has(name) || canonical.has(name)) throw new Error("Compact tool name collision: " + name);
      const annotations = riskAnnotation(first.annotations);
      descriptors.push({
        name,
        title: domain.replaceAll("_", " ") + " (" + visible.length + " actions)",
        description: "Obsidian actions / 笔记操作: " + visible.map((tool) => tool.name).join(", ") +
          ". Choose action then supply its native params; credentials and Vault policy are checked per action.",
        inputSchema: actionInputSchema(visible),
        annotations,
      });
      routing.set(name, new Set(visible.map((tool) => tool.name)));
    }
  }
  for (const name of COMPACT_PASSTHROUGH) {
    if (allowed.has(name)) {
      descriptors.unshift(native.get(name));
      routing.set(name, new Set([name]));
    }
  }
  if (descriptors.length !== routing.size) throw new Error("Duplicate compact descriptor name");
  return { tools: descriptors, routing };
}

/** Project a virtual call onto its source name *only* for the HTTP Scope/Vault
 * gate. Unknown/malformed actions remain unknown, so the auth gate fails closed.
 * The discovery dispatcher independently validates virtual group membership.
 */
export function projectCompactCall(name, args) {
  if (PASSTHROUGH.has(name)) return { name, args };
  if (typeof name !== "string" || !name.startsWith("obsidian_")) return { name, args };
  if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.action !== "string") {
    return { name, args };
  }
  const domain = sourceToDomain.get(args.action);
  if (!domain || !name.startsWith(domain)) return { name, args };
  return { name: args.action, args: args.params };
}

export function isCompactProfile(profile) {
  return profile === "compact";
}
