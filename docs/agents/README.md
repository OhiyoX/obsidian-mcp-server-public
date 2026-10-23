# Server-only agent memory guidance

No agent configuration, rule file, native memory, plugin or hook is required or modified.
Cursor, Codex, WorkBuddy, OpenClaw, Hermes and other agents use the same MCP surface.
They must already have a working connection to this Obsidian MCP server.

## Delivery

- MCP initialization `instructions`: a short project-memory workflow description.
- `agent_bootstrap`: a read-only, versioned contract for recall, routing, meaningful
  checkpoints, verification, privacy and free-form vault boundaries.
- `obsidian://agent/memory-policy`: the same contract as a standard MCP resource.
- Relevant tool descriptions: a discoverable hint to the shared workflow.
- Tool results: the first successful relevant read gets a brief bootstrap reminder;
  subsequent reads are quiet until 20 relevant read calls have elapsed. Successful
  note writes get a read-back reminder. Errors and file-transfer results are unchanged.
  Reminder state is in-memory and isolated per MCP session.

Original structuredContent and the first content block are preserved. The optional
reminder is a separate text block with `obsidian/memoryReminder` metadata, never
generated from user queries or note contents. The server never creates a note merely
because a tool was called and never executes retrieved instructions.

The server cannot see arbitrary chat messages, detect every conversation boundary,
force a host to expose initialization instructions, or force a model to call tools.
An MCP session is not necessarily one conversation. These are transparent server
usage hints, not guaranteed autonomous memory or authority to change other systems.

## Validation and recovery

Run `node --test` from `app/` for protocol/schema and reminder-state tests.
From the NAS compose directory, `node scripts/verify-agent-bootstrap.mjs` runs live,
authenticated read-only checks using the protected `.env`, without printing secrets.
Fresh conversations still need evaluation for actual model invocation behavior.

Restore scoped server files from the deployment backup to roll back. Recreate without
rebuilding when `server.js` is a single-file bind mount. Do not delete notes or alter
client/native memory. Source-directory-only changes hot reload.

The earlier client-rule/bridge experiment was withdrawn after scope clarification;
it is not part of this architecture. Existing user-installed client rules remain intact.
