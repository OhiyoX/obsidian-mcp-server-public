// #276 — an agent must be able to see that it CAN write, on a read path.
//
// The measured failure: with every write tool in a deferred tier, and a host search that drops CJK
// ("写入笔记" matched nothing), an agent saw six read tools and concluded it had no write capability.
// `agent_bootstrap` now names the 37 write tools; this file pins the second half — `server_info` is
// direct in every host, so it must carry the ability itself: enabled, how many, and a few names,
// including a pointer to the full list. A read-only deployment must say the opposite, and must not
// name a write tool it cannot serve.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const APP_ROOT = new URL("..", import.meta.url);
const LANE_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-276-"));
process.env.VAULT_PATH = path.join(LANE_ROOT, "vault");
process.env.DATA_PATH = path.join(LANE_ROOT, "data");
await mkdir(process.env.VAULT_PATH, { recursive: true });
await mkdir(process.env.DATA_PATH, { recursive: true });

const { WRITE_TOOLS } = await import("../src/capability-catalog.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");

after(async () => {
  await rm(LANE_ROOT, { recursive: true, force: true });
});

async function callServerInfo() {
  const server = new McpServer({ name: "issue-276-probe", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "issue-276-probe", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: "server_info", arguments: {} })).structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}

test("server_info states the write capability, its size and real tool names (#276)", async () => {
  const info = await callServerInfo();
  assert.equal(info.ok, true);
  const writes = info.writes;
  assert.ok(writes && typeof writes === "object", "server_info must carry a writes block, not only tools[]");
  assert.equal(writes.enabled, true, "this fixture is a writable deployment");
  // The count comes from the scope table, so a new mutating tool cannot leave a stale number behind.
  assert.equal(writes.count, WRITE_TOOLS.length);
  assert.ok(writes.count > 30, `the measured deployment had 37 write tools; got ${writes.count}`);
  assert.ok(Array.isArray(writes.examples) && writes.examples.length >= 3, "examples must name real tools");
  for (const name of writes.examples) {
    assert.ok(TOOL_NAMES.includes(name), `writes.examples names an unregistered tool: ${name}`);
    assert.ok(WRITE_TOOLS.includes(name), `writes.examples names a tool that is not a write tool: ${name}`);
  }
  // The two the issue measured by hand must be reachable by name from a read path.
  for (const name of ["write_note", "patch_note"]) {
    assert.ok(writes.examples.includes(name), `writes.examples must include ${name}`);
  }
  assert.equal(writes.fullList, "agent_bootstrap", "the examples must point at the complete list");
});

test("a read-only deployment says writes are disabled and names no write tool (#276)", async () => {
  // READ_ONLY is read at module evaluation, so this assertion needs a fresh process — the same device
  // the bootstrap contract uses.
  const script = [
    'const { registerObsidianCapabilities } = await import("./src/capabilities.js");',
    'const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");',
    'const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");',
    'const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");',
    'const server = new McpServer({ name: "probe", version: "0" }); registerObsidianCapabilities(server);',
    'const client = new Client({ name: "probe", version: "0" });',
    'const [a, b] = InMemoryTransport.createLinkedPair();',
    'await Promise.all([server.connect(a), client.connect(b)]);',
    'const info = (await client.callTool({ name: "server_info", arguments: {} })).structuredContent;',
    'console.log(JSON.stringify(info.writes));',
    'await client.close(); await server.close();',
  ].join(" ");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      OBSIDIAN_READ_ONLY: "true",
      VAULT_PATH: process.env.VAULT_PATH,
      DATA_PATH: path.join(LANE_ROOT, "read-only-data"),
    },
  });
  const writes = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(writes.enabled, false);
  assert.equal(writes.count, 0, "a read-only deployment serves no write tool, so the count must be 0");
  assert.deepEqual(writes.examples, [], "naming a write tool it cannot serve would be a lie");
});
