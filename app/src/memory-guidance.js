import { authClientIdFromExtra, authUserIdFromExtra, resolveRequestAuthor, withRequestContextPatch } from "./request-context.js";
import { MEMORY_PATH } from "./config.js";
import { bundledPromptRegistry } from "./prompt-registry/bundled.js";
import { livePromptSnapshot } from "./prompt-registry/live.js";
import { currentPromptSnapshot } from "./prompt-registry/request-snapshot.js";
import { renderPromptTemplate } from "./prompt-registry/schema.js";
import { completeToolDescriptor } from "./tool-contracts.js";

// Standard MCP hints only. State is per session, not a conversation archive.
export const GUIDANCE_READ_TOOLS = Object.freeze(["server_info", "search_notes", "recall", "memory_recall", "get_note", "get_note_context", "list_notes", "find_related", "skill_list", "skill_match", "skill_validate"]);
export const GUIDANCE_WRITE_TOOLS = Object.freeze(["write_file", "delete_file", "start_file_upload", "upload_file_chunk", "cancel_file_upload", "create_archive", "extract_archive", "skill_export", "skill_import", "write_note", "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter", "manage_tags", "create_from_template", "memory_capture", "write_canvas", "manage_folders", "move_note", "delete_note", "restore_from_trash", "delete_trash_entry", "restore_version", "delete_version", "rename_property", "set_property_type", "update_task", "write_base", "patch_base", "git_commit", "manage_publish", "apply_note_plan", "daily_note"]);
const reads = new Set(GUIDANCE_READ_TOOLS);
const writes = new Set(GUIDANCE_WRITE_TOOLS);
const authorRequired = new Set([...writes, "plan_note_changes", "plan_move_note", "plan_delete_note",
  "plan_restore_version", "plan_restore_from_trash", "get_note_plan"]);
/** Values a Base template may interpolate; the copy itself lives in `prompts/base`. */
const TEMPLATE_VALUES = Object.freeze({ memoryPath: MEMORY_PATH });

function mutates(name, args) {
  if (!writes.has(name)) return false;
  if (name === "manage_frontmatter") return (args?.[0]?.action || "get") !== "get";
  if (name === "manage_tags") return (args?.[0]?.action || "list") !== "list";
  if (name === "manage_folders") return (args?.[0]?.action || "list") !== "list";
  if (name === "daily_note") return ["create", "append", "prepend"].includes(args?.[0]?.action);
  if (name === "update_task" || name === "rename_property") return !args?.[0]?.dryRun;
  return true;
}

/** The pack text of a tool, without the guidance suffix. */
export function canonicalToolText(name, promptSnapshot) {
  const base = promptSnapshot.values[`tools.canonical.${name}.description`];
  return typeof base === "string" ? renderPromptTemplate(base, TEMPLATE_VALUES) : undefined;
}

/** The read/write suffix for a tool at one snapshot ("" when it carries none). */
export function guidanceSuffix(name, promptSnapshot) {
  if (reads.has(name)) return promptSnapshot.values["memory.readHint"];
  if (writes.has(name)) return promptSnapshot.values["memory.writeHint"];
  return "";
}

/** Base or Override text plus its suffix; never appends to an already-suffixed copy. */
export function projectToolDescription(name, promptSnapshot) {
  const text = canonicalToolText(name, promptSnapshot);
  return text === undefined ? undefined : text + guidanceSuffix(name, promptSnapshot);
}

export function createMemoryGuidanceRegistrar(server, { repeatAfterReads = 20, registry = null } = {}) {
  // Per call, in this order: the request's pinned snapshot (so one request never mixes
  // two revisions), then the injected registry, then the process-wide one.
  const snapshotOf = () => currentPromptSnapshot() ?? (registry === null ? livePromptSnapshot() : registry.snapshot());
  // An operator may tune the reminder cadence; the default stays code-owned.
  const thresholdOf = (snapshot) => {
    const tuned = snapshot.tuning?.repeatAfterReads;
    return Number.isInteger(tuned) ? tuned : repeatAfterReads;
  };
  // One snapshot per registration and per call: a request never mixes two revisions.
  const copy = (key) => renderPromptTemplate(snapshotOf().values[key], TEMPLATE_VALUES);
  let hasGuided = false;
  let readsSinceReminder = 0;
  const registrar = {
    // Tool modules receive this registrar, not the raw McpServer. Delegate
    // clientInfo lookups so agent_bootstrap / author stamping still work.
    getClientVersion: () => server.server?.getClientVersion?.() ?? server.getClientVersion?.(),
    registerTool(name, config, handler) {
      const snapshot = snapshotOf();
      const description = (config.description ?? canonicalToolText(name, snapshot) ?? "") + guidanceSuffix(name, snapshot);
      return server.registerTool(name, completeToolDescriptor(name, { ...config, description }), async (...args) => {
        const extra = args.length > 1 ? args[args.length - 1] : undefined;
        const author = authorRequired.has(name) && extra ? resolveRequestAuthor(server, extra) : undefined;
        // Contract §8: this layer sits *inside* the Vault-scope registrar, so it must merge over the
        // ambient context instead of replacing it — the selected `vaultId`/`vaultRuntime` (and the
        // outer `authzUsage`) have to stay visible to the handler. `undefined` values never erase an
        // outer key (A4 `withRequestContextPatch` semantics).
        const result = await withRequestContextPatch({ author, authClientId: authClientIdFromExtra(extra), authUserId: authUserIdFromExtra(extra), tool: name, sessionId: extra?.sessionId }, () => handler(...args));
        if (!result || result.isError) return result;
        if (name === "agent_bootstrap") { hasGuided = true; readsSinceReminder = 0; return result; }
        const metadataRead = (name === "manage_frontmatter" && (args[0]?.action || "get") === "get")
          || (name === "manage_tags" && (args[0]?.action || "list") === "list");
        let text; let kind;
        if (mutates(name, args) && !metadataRead) {
          text = copy("memory.afterWrite"); kind = "verify-write"; hasGuided = true; readsSinceReminder = 0;
        } else if ((reads.has(name) || metadataRead) && (!hasGuided || ++readsSinceReminder >= thresholdOf(snapshotOf()))) {
          text = hasGuided ? copy("memory.checkpoint") : copy("memory.firstRead");
          kind = hasGuided ? "checkpoint" : "bootstrap";
          hasGuided = true; readsSinceReminder = 0;
        }
        if (!text) return result;
        // Preserve machine consumers' original JSON and structured data.
        return { ...result, content: [...(result.content || []), { type: "text", text }],
          _meta: { ...result._meta, "obsidian/memoryReminder": { kind, source: "server", version: 1 } } };
      });
    },
  };
  for (const method of ["registerResource", "registerPrompt"]) {
    if (typeof server[method] === "function") registrar[method] = server[method].bind(server);
  }
  return registrar;
}
