// Client-side helper: inject the current author metadata into MCP mutations.
// The server remains authoritative and validates the metadata on every write.
export const AUTHOR_META_KEY = "obsidian/author";

export const MUTATING_TOOL_NAMES = new Set([
  "write_file",
  "write_note",
  "append_to_note",
  "patch_note",
  "replace_in_note",
  "manage_frontmatter",
  "manage_tags",
  "create_from_template",
  "memory_capture",
  "skill_export",
  "skill_import",
  "write_canvas",
  "manage_folders",
  "move_note",
  "delete_note",
  "restore_from_trash",
  "delete_trash_entry",
  "restore_version",
  "delete_version",
  "rename_property",
  "set_property_type",
  "update_task",
  "write_base",
  "patch_base",
  "git_commit",
  "manage_publish",
  "plan_note_changes",
  "plan_move_note",
  "plan_delete_note",
  "plan_restore_version",
  "plan_restore_from_trash",
  "get_note_plan",
  "apply_note_plan",
]);

function clean(value, label) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 160 || /[\r\n\u0000]/.test(result)) {
    throw new Error(`MCP author.${label} must be a non-empty single-line value (max 160 characters)`);
  }
  return result;
}

export function normalizeAuthor({ agent, model } = {}) {
  return { agent: clean(agent, "agent"), model: clean(model, "model") };
}

export function withAuthorMetadata(request, author) {
  if (!request || !MUTATING_TOOL_NAMES.has(request.name)) return request;
  const metadata = normalizeAuthor(author);
  return {
    ...request,
    _meta: { ...(request._meta || {}), [AUTHOR_META_KEY]: metadata },
  };
}

// Wrap an MCP SDK callTool function. `model` may be a string or a resolver
// function, so a model switch can take effect without reconnecting MCP.
export function createAuthorAwareCallTool(callTool, { agent, model } = {}) {
  if (typeof callTool !== "function") throw new TypeError("callTool must be a function");
  const fixedAgent = clean(agent, "agent");
  let modelSource = model;
  const resolveModel = () => typeof modelSource === "function" ? modelSource() : modelSource;
  const wrapped = (request, ...rest) => MUTATING_TOOL_NAMES.has(request?.name)
    ? callTool(withAuthorMetadata(request, { agent: fixedAgent, model: resolveModel() }), ...rest)
    : callTool(request, ...rest);
  wrapped.setModel = (nextModel) => { modelSource = nextModel; };
  wrapped.getAuthor = () => normalizeAuthor({ agent: fixedAgent, model: resolveModel() });
  return wrapped;
}
