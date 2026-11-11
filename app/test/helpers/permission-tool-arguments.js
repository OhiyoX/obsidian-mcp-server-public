// P0 / Task 1 — real arguments for the whole-tool sweep.
//
// Review Minor 9: 64 of the sweep rows were SDK argument-validation refusals (`validation`), so the
// row tested the schema instead of the gate. Every tool is now called with arguments its own
// `inputSchema` accepts: the required properties are filled from the live schema, and a curated
// table supplies the few semantic values a filler cannot know (a file that exists, a view name, a
// mutation the Base editor accepts). A refusal that remains is the operation's own answer, which is
// what the row is meant to record.
//
// One deliberate malformed case per surface stays in the baseline (`malformed:` time cases of the
// collector): that proves `validation` is still recorded as a family.

/** Fixed values the curated table shares. */
const NOTE = "note.md";
const BASE = "Note.base";
const CANVAS = "Sketch.canvas";
const SHA_ZERO = "0".repeat(64);

/**
 * Semantic arguments per tool. Anything not listed is filled from its schema.
 * A `null` argument set means "call it with no arguments" (the tool declares nothing required).
 */
const CURATED = Object.freeze({
  get_note: { path: NOTE },
  get_metadata: { path: NOTE },
  get_file: { path: "assets/pixel.png" },
  pull_file: { path: "assets/pixel.png" },
  pull_note_file: { path: NOTE },
  list_notes: {},
  list_files: {},
  list_recent: {},
  list_tags: {},
  list_trash: {},
  list_tasks: {},
  list_templates: {},
  list_properties: {},
  list_aliases: {},
  list_versions: { path: NOTE },
  get_note_version: { versionId: "00000000-0000-4000-8000-000000000002" },
  compare_note_versions: { left: { kind: "current", path: NOTE }, right: { kind: "candidate", path: NOTE, content: "# candidate\n" } },
  search_notes: { query: "note" },
  write_note: { path: "sweep-written.md", content: "# sweep\n" },
  append_to_note: { path: "sweep-written.md", content: "\nappended\n" },
  patch_note: { path: "sweep-written.md", operation: "append", targetType: "heading", target: "Sweep", content: "sweep\n" },
  replace_in_note: { path: "sweep-written.md", replacements: [{ search: "appended", replace: "appended" }] },
  manage_frontmatter: { path: "sweep-written.md", action: "set", key: "sweep", value: "1" },
  manage_tags: { path: "sweep-written.md", add: ["sweeptag"] },
  move_note: { from: "sweep-written.md", to: "sweep-moved.md" },
  delete_note: { path: "sweep-moved.md" },
  write_file: { path: "sweep.bin", base64: Buffer.from("sweep").toString("base64") },
  delete_file: { path: "sweep.bin" },
  create_archive: { sourcePaths: [NOTE], destination: "sweep.zip" },
  inspect_archive: { path: "sweep.zip" },
  read_archive_entry: { archivePath: "sweep.zip", entry: NOTE },
  extract_archive: { archivePath: "sweep.zip", destinationDirectory: "sweep-extracted" },
  start_direct_upload: { path: "sweep-direct.bin", totalBytes: 5, sha256: SHA_ZERO },
  get_canvas: { path: CANVAS },
  write_canvas: { path: "Sweep.canvas", canvas: { nodes: [], edges: [] } },
  daily_note: {},
  list_bases: {},
  get_base: { path: BASE },
  query_base: { path: BASE },
  list_base_views: { path: BASE },
  patch_base: { path: BASE, ifMatch: "0", mutations: [{ op: "set-view-option", view: "Main", key: "limit", value: 25 }] },
  write_base: { path: "Sweep.base", base: { views: [{ type: "table", name: "Main", order: ["file.name"] }] } },
  create_base_entry: { path: BASE, values: { name: "sweep" } },
  get_graph: {},
  get_backlinks: { path: NOTE },
  get_unresolved_links: {},
  get_orphans: {},
  get_deadends: {},
  get_note_context: { path: NOTE },
  suggest_links: { path: NOTE },
  find_related: { path: NOTE },
  recall: { query: "note" },
  memory_capture: { title: "sweep", content: "sweep memory" },
  skill_list: {},
  index_status: {},
  reindex_vault: {},
  graph_health: {},
  git_status: {},
  git_diff: {},
  git_log: {},
  git_commit: { message: "sweep" },
  get_publish_status: { path: NOTE },
  manage_publish: { action: "publish", path: NOTE },
  plan_note_changes: { changes: [{ path: "planned.md", operation: "write", content: "# plan\n" }] },
  plan_move_note: { from: NOTE, to: "planned.md" },
  plan_delete_note: { path: NOTE },
  update_task: { path: NOTE, line: 1, text: "- [x] sweep" },
  apply_note_plan: { planId: "00000000-0000-4000-8000-000000000003", planHash: "sweephash", idempotencyKey: "sweep-key-0001" },
  get_note_plan: { planId: "00000000-0000-4000-8000-000000000003" },
});

/** Value for one declared property, chosen from its name first and its type second. */
function valueFor(name, spec) {
  const schema = spec && typeof spec === "object" ? spec : {};
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return /limit|count|size|offset|line|version|days/i.test(name) ? 1 : 0;
  if (type === "array") return [];
  if (type === "object") return {};
  if (/^(?:path|note|from|source|target)$/i.test(name)) return NOTE;
  if (/^vaultId$/i.test(name)) return "vault";
  if (/^(?:query|q|search|text)$/i.test(name)) return "note";
  if (/^(?:tag|name|label|title|entry)$/i.test(name)) return "sweep";
  if (/sha256|digest/i.test(name)) return SHA_ZERO;
  if (/base64|content|body/i.test(name)) return Buffer.from("sweep").toString("base64");
  if (/url|link/i.test(name)) return "https://example.com";
  if (/date/i.test(name)) return "2026-11-05";
  if (/id$/i.test(name)) return "00000000-0000-4000-8000-000000000001";
  return "sweep";
}

/** Arguments for one tool: curated when known, otherwise every required property filled. */
export function sweepArgumentsFor(name, inputSchema) {
  if (Object.hasOwn(CURATED, name)) return { ...CURATED[name] };
  const schema = inputSchema && typeof inputSchema === "object" ? inputSchema : {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const args = {};
  for (const key of required) args[key] = valueFor(key, properties[key]);
  return args;
}

/** The deliberate malformed case: an argument of the wrong type, refused by the SDK schema. */
export const MALFORMED_TOOL_CALL = Object.freeze({ tool: "get_note", args: { path: 42 } });
