import { TOOL_NAMES } from "./config.js";

export const MCP_SCOPES = Object.freeze([
  "obsidian.read",
  "obsidian.write",
  "obsidian.files",
]);

export const SCOPE_DEFINITIONS = Object.freeze({
  "obsidian.read": Object.freeze({ label: "读取", description: "搜索、读取笔记、元数据、链接与知识图谱" }),
  "obsidian.write": Object.freeze({ label: "写入", description: "新建、修改、移动、删除笔记以及 Git 操作" }),
  "obsidian.files": Object.freeze({ label: "文件", description: "文件上传、下载、打包、检查和解压附件" }),
});

const READ_TOOLS = new Set([
  "agent_bootstrap", "server_info", "get_note", "pull_note_file", "get_metadata", "list_notes", "list_files", "list_recent",
  "search_notes", "get_file", "pull_file", "write_file", "start_file_upload", "file_upload_status", "upload_file_chunk",
  "cancel_file_upload", "create_archive", "inspect_archive", "read_archive_entry", "extract_archive", "get_canvas", "write_canvas", "write_note",
  "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter", "list_tags", "manage_tags", "move_note", "delete_note",
  "list_trash", "restore_from_trash", "delete_trash_entry", "list_versions", "restore_version", "delete_version", "manage_folders",
  "get_backlinks", "get_graph", "get_unresolved_links", "get_orphans", "get_deadends", "list_tasks", "update_task", "daily_note",
  "list_templates", "create_from_template", "list_properties", "list_aliases", "rename_property", "set_property_type", "list_bases",
  "get_base", "write_base", "patch_base", "create_base_entry", "query_base", "list_base_views", "git_status", "git_diff", "git_log", "git_commit", "git_pull", "git_push",
  "index_status", "reindex_vault", "recall", "find_related", "get_note_context", "graph_health", "suggest_links", "memory_capture", "memory_recall",
  "skill_list", "skill_match", "skill_validate", "skill_export", "skill_import",
  "get_publish_status", "manage_publish",
  "plan_note_changes", "plan_move_note", "plan_delete_note", "plan_restore_version", "plan_restore_from_trash", "get_note_plan", "apply_note_plan", "get_note_version", "compare_note_versions",
]);

const WRITE_TOOLS = new Set([
  "write_file", "start_file_upload", "upload_file_chunk", "cancel_file_upload", "create_archive", "extract_archive",
  "write_canvas", "write_note", "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter", "manage_tags",
  "move_note", "delete_note", "restore_from_trash", "delete_trash_entry", "restore_version", "delete_version",
  "manage_folders", "update_task", "create_from_template", "rename_property", "set_property_type", "write_base", "patch_base", "create_base_entry",
  "memory_capture", "skill_export", "skill_import", "git_commit", "git_pull", "git_push",
  "manage_publish",
  "apply_note_plan", "daily_note",
]);

const FILE_TOOLS = new Set([
  "get_file", "pull_file", "pull_note_file", "start_file_upload", "file_upload_status", "upload_file_chunk", "cancel_file_upload",
  "create_archive", "inspect_archive", "read_archive_entry", "extract_archive", "skill_export", "skill_import",
]);

const registeredTools = new Set(TOOL_NAMES);
const missingTools = TOOL_NAMES.filter((name) => !READ_TOOLS.has(name));
const unknownTools = [...new Set([...READ_TOOLS, ...WRITE_TOOLS, ...FILE_TOOLS])].filter((name) => !registeredTools.has(name));
if (missingTools.length || unknownTools.length) {
  throw new Error(`MCP Scope registry is out of sync (missing: ${missingTools.join(", ") || "none"}; unknown: ${unknownTools.join(", ") || "none"})`);
}

export const MCP_TOOL_SCOPE_REQUIREMENTS = Object.freeze(Object.fromEntries(TOOL_NAMES.map((name) => Object.freeze([
  "obsidian.read",
  ...(WRITE_TOOLS.has(name) ? ["obsidian.write"] : []),
  ...(FILE_TOOLS.has(name) ? ["obsidian.files"] : []),
])).map((requirements, index) => [TOOL_NAMES[index], requirements])));

export const MCP_RESOURCE_SCOPE_REQUIREMENTS = Object.freeze({
  "obsidian://agent/memory-policy": Object.freeze(["obsidian.read"]),
  "obsidian://vault/index": Object.freeze(["obsidian.read"]),
  "obsidian://vault/tags": Object.freeze(["obsidian.read"]),
  "obsidian://vault/graph": Object.freeze(["obsidian.read"]),
});

export function requiredScopesForTools(toolNames) {
  const required = new Set(["obsidian.read"]);
  for (const name of toolNames) {
    const requirements = MCP_TOOL_SCOPE_REQUIREMENTS[name];
    if (!requirements) return [...MCP_SCOPES];
    for (const scope of requirements) required.add(scope);
  }
  return [...required];
}

export function normalizeScopes(scopes, fallback = MCP_SCOPES) {
  const values = Array.isArray(scopes) && scopes.length ? scopes : fallback;
  const normalized = [...new Set(values.map((scope) => String(scope || "").trim()).filter(Boolean))];
  if (!normalized.length || normalized.some((scope) => !MCP_SCOPES.includes(scope))) {
    throw new Error("Unsupported MCP scope");
  }
  return normalized;
}
