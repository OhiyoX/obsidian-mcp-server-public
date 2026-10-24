import { authClientIdFromExtra, authUserIdFromExtra, resolveRequestAuthor, withRequestContextPatch } from "./request-context.js";
import { completeToolDescriptor } from "./tool-contracts.js";

// Standard MCP hints only. State is per session, not a conversation archive.
const reads = new Set(["server_info", "search_notes", "recall", "memory_recall", "get_note", "get_note_context", "list_notes", "find_related", "skill_list", "skill_match", "skill_validate"]);
const writes = new Set(["write_file", "start_file_upload", "upload_file_chunk", "cancel_file_upload", "create_archive", "extract_archive", "skill_export", "skill_import", "write_note", "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter", "manage_tags", "create_from_template", "memory_capture", "write_canvas", "manage_folders", "move_note", "delete_note", "restore_from_trash", "delete_trash_entry", "restore_version", "delete_version", "rename_property", "set_property_type", "update_task", "write_base", "patch_base", "git_commit", "manage_publish", "apply_note_plan", "daily_note"]);
const authorRequired = new Set([...writes, "plan_note_changes", "plan_move_note", "plan_delete_note",
  "plan_restore_version", "plan_restore_from_trash", "get_note_plan"]);
const firstRead = "Obsidian memory guidance: for user-authorized long-lived project work, call agent_bootstrap once for the shared workflow; search/read existing project notes before work and update verified durable changes at a meaningful checkpoint. No change or do-not-record means no write.";
const checkpoint = "Obsidian memory checkpoint: if this task produced confirmed durable project changes, update the existing current-state note and nearest index, then verify. Do not create duplicate notes for unchanged Q&A or record secrets/full conversations. Respect the user's current scope.";
const afterWrite = "Obsidian memory verification: read back the saved note before claiming it is recorded; maintain the nearest project index when needed. On a version conflict, reread and reconcile instead of overwriting. No extra note is needed just to record this write.";

function mutates(name, args) {
  if (!writes.has(name)) return false;
  if (name === "manage_frontmatter") return (args?.[0]?.action || "get") !== "get";
  if (name === "manage_tags") return (args?.[0]?.action || "list") !== "list";
  if (name === "manage_folders") return (args?.[0]?.action || "list") !== "list";
  if (name === "daily_note") return ["create", "append", "prepend"].includes(args?.[0]?.action);
  if (name === "update_task" || name === "rename_property") return !args?.[0]?.dryRun;
  return true;
}

export function createMemoryGuidanceRegistrar(server, { repeatAfterReads = 20 } = {}) {
  let hasGuided = false;
  let readsSinceReminder = 0;
  const registrar = {
    // Tool modules receive this registrar, not the raw McpServer. Delegate
    // clientInfo lookups so agent_bootstrap / author stamping still work.
    getClientVersion: () => server.server?.getClientVersion?.() ?? server.getClientVersion?.(),
    registerTool(name, config, handler) {
      const hint = reads.has(name)
        ? " For shared project memory, agent_bootstrap explains when to recall, update and verify notes without a user reminder."
        : writes.has(name) ? " For durable project state, update existing notes with revision checks and verify the saved result; preserve free-form personal notes." : "";
      return server.registerTool(name, completeToolDescriptor(name, { ...config, description: (config.description || "") + hint }), async (...args) => {
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
          text = afterWrite; kind = "verify-write"; hasGuided = true; readsSinceReminder = 0;
        } else if ((reads.has(name) || metadataRead) && (!hasGuided || ++readsSinceReminder >= repeatAfterReads)) {
          text = hasGuided ? checkpoint : firstRead;
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
