// Run from the NAS compose directory or pass API_KEY explicitly. Never prints it.
import fs from "node:fs";
import assert from "node:assert/strict";

const raw = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const match = raw.match(/^API_KEY\s*=\s*(.*)$/m);
const key = process.env.API_KEY || (match?.[1] || "").trim().replace(/^(['"])(.*)\1$/, "$2");
const endpoint = process.env.BOOTSTRAP_TEST_URL || "http://127.0.0.1:18923/mcp";
let session;
let id = 0;
let phase = "initialize";
async function rpc(method, params, notification = false) {
  const requestId = ++id;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: requestId }), method, params }),
    signal: AbortSignal.timeout(15000),
  });
  session ||= response.headers.get("mcp-session-id");
  assert.ok(response.ok, `HTTP ${response.status} at ${method}`);
  if (notification) { await response.body?.cancel(); return; }
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("event-stream")
    ? text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))).find(p => p.id === requestId)
    : JSON.parse(text);
  assert.ok(payload && !payload.error, `RPC failed at ${method}`);
  return payload.result;
}
try {
  const hello = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-memory-verifier", version: "1" } });
  console.log(`initialize: memory instructions=${Boolean(hello.instructions?.includes("agent_bootstrap"))}`);
  phase = "discover tools";
  await rpc("notifications/initialized", {}, true);
  const tools = await rpc("tools/list", {});
  assert.ok(tools.tools.some(t => t.name === "agent_bootstrap" && t.annotations.readOnlyHint));
  for (const tool of tools.tools) {
    assert.equal(tool.outputSchema?.type, "object", `${tool.name} is missing an object outputSchema`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} is missing ${hint}`);
    }
  }
  const appendTool = tools.tools.find(t => t.name === "append_to_note");
  assert.deepEqual(appendTool.outputSchema.required, ["path", "created", "previousSizeInBytes", "currentSizeInBytes", "revision"]);
  for (const name of ["pull_file", "start_file_upload", "file_upload_status", "upload_file_chunk", "create_archive", "inspect_archive", "extract_archive"]) {
    assert.ok(tools.tools.some(t => t.name === name), `Missing file-transfer tool: ${name}`);
  }
  assert.ok(tools.tools.find(t => t.name === "get_note").description.includes("without a user reminder"));
  phase = "server-only reminders";
  const firstRead = await rpc("tools/call", { name: "server_info", arguments: {} });
  assert.equal(firstRead._meta?.["obsidian/memoryReminder"]?.kind, "bootstrap");
  assert.deepEqual(JSON.parse(firstRead.content[0].text), firstRead.structuredContent);
  const secondRead = await rpc("tools/call", { name: "server_info", arguments: {} });
  assert.equal(secondRead._meta?.["obsidian/memoryReminder"], undefined);
  console.log("Server-only first-use reminder and throttling: PASS");
  for (const client of ["codex", "cursor", "workbuddy", "openclaw", "hermes", "future-agent"]) {
    phase = `bootstrap ${client}`;
    const result = await rpc("tools/call", { name: "agent_bootstrap", arguments: { client, project: "obsidian_mcp_server" } });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.client, client);
    assert.equal(result.structuredContent.policyVersion, "1.0.0");
    console.log(`${client}: bootstrap OK`);
  }
  phase = "policy resource";
  const resource = await rpc("resources/read", { uri: "obsidian://agent/memory-policy" });
  assert.equal(JSON.parse(resource.contents[0].text).policyVersion, "1.0.0");
  phase = "initialization instructions";
  assert.ok(hello.instructions?.includes("agent_bootstrap"));
  console.log("Live handshake, output schemas/annotations, OAuth/file-transfer discovery, 6 client names and policy resource: PASS (read-only checks)");
} catch (error) {
  // Do not log request headers, key values, response bodies or full errors.
  console.error(`Bootstrap verification failed at ${phase}: ${error.name}`);
  process.exitCode = 1;
} finally {
  if (session) await fetch(endpoint, { method: "DELETE", headers: { "Mcp-Session-Id": session, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(5000) }).catch(() => {});
}
