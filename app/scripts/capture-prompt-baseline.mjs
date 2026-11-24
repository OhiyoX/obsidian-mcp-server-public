// Capture the current MCP prompt baseline (canonical/compact descriptions, memory
// reminders, bootstrap payload, MCP prompt copy, initialize instructions) into
// `test/fixtures/prompt-base-baseline.json`.
//
// Run once before the Base Prompt migration, then never automatically: the fixture
// is a frozen contract (`test/prompt-base-golden.test.js`), not a snapshot that a
// normal test run may refresh. Re-capture only with a reviewer reading the diff.
//
//   node scripts/capture-prompt-baseline.mjs

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-prompt-baseline-"));
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { CAPABILITY_CATALOG } = await import("../src/capability-catalog.js");
const { COMPACT_GROUPS, compactToolView } = await import("../src/compact-tools.js");
const { compactDescriptorFingerprint } = await import("../src/compact-descriptor-integrity.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");
const { createDiscoveryRuntimePolicy } = await import("../src/discovery-runtime.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { createMemoryGuidanceRegistrar } = await import("../src/memory-guidance.js");
const { registerPrompts } = await import("../src/prompts.js");
const { AGENT_INSTRUCTIONS, getAgentBootstrap } = await import("../src/agent-bootstrap.js");

async function withClient(createServer, run) {
  const server = createServer();
  const client = new Client({ name: "prompt-baseline", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function nativeServer() {
  const server = new McpServer({ name: "prompt-baseline-native", version: "1" });
  registerObsidianCapabilities(server);
  return server;
}

function compactServer(config) {
  const server = new McpServer({ name: "prompt-baseline-compact", version: "1" });
  const discovery = createDiscoveryRuntimePolicy(server, config, { authDisabled: true });
  registerObsidianCapabilities(discovery);
  discovery.install();
  return server;
}

const canonicalWire = await withClient(nativeServer, async (client) => {
  const { tools } = await client.listTools();
  return JSON.parse(JSON.stringify(tools));
});
if (canonicalWire.length !== TOOL_NAMES.length) {
  throw new Error(`native tools/list returned ${canonicalWire.length}, TOOL_NAMES has ${TOOL_NAMES.length}`);
}

const canonical = {};
for (const tool of canonicalWire) canonical[tool.name] = { title: tool.title ?? null, description: tool.description ?? null };

const compactConfig = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact" });
const compactWire = await withClient(() => compactServer(compactConfig), async (client) => {
  const { tools } = await client.listTools();
  return JSON.parse(JSON.stringify(tools));
});

const readNames = new Set(
  CAPABILITY_CATALOG.filter((entry) => entry.scope.every((scope) => scope === "obsidian.read")).map((entry) => entry.name),
);
const scopedCompact = compactToolView(canonicalWire, [...readNames]);

// Memory guidance: derive the per-kind suffix and the three reminder texts from a
// real registrar, so the fixture records what the wire carries, not a guess.
function guidanceProbe() {
  const tools = new Map();
  const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
  const registrar = createMemoryGuidanceRegistrar(server, { repeatAfterReads: 2 });
  registrar.registerTool("search_notes", { description: "RAW-READ" }, async () => ({ content: [] }));
  registrar.registerTool("write_note", { description: "RAW-WRITE" }, async () => ({ content: [] }));
  return { tools, registrar };
}

function appended(result) {
  return result.content.at(-1)?.text ?? "";
}

const readProbe = guidanceProbe();
const firstRead = appended(await readProbe.tools.get("search_notes").handler());
const readHint = readProbe.tools.get("search_notes").config.description.slice("RAW-READ".length);
const writeProbe = guidanceProbe();
const writeHint = writeProbe.tools.get("write_note").config.description.slice("RAW-WRITE".length);
const afterWrite = appended(await writeProbe.tools.get("write_note").handler());
const guided = guidanceProbe();
guided.registrar.registerTool("agent_bootstrap", { description: "RAW-BOOTSTRAP" }, async () => ({ content: [] }));
await guided.tools.get("agent_bootstrap").handler();
// The probe throttles at 2 reads: the first read after a bootstrap is silent, the
// next one carries the checkpoint reminder.
let checkpoint = "";
for (let index = 0; index < 2 && checkpoint === ""; index += 1) {
  checkpoint = appended(await guided.tools.get("search_notes").handler());
}

// The prompt copy is defined by `registerPrompts`. It is captured on a bare McpServer
// rather than through the capability chain: the chain only re-exposes
// `registerPrompt` when the access-policy registrar is present, which is a
// separate reachability question from the text contract frozen here.
function barePromptsServer() {
  const server = new McpServer({ name: "prompt-baseline-prompts", version: "1" });
  registerPrompts(server);
  return server;
}

const prompts = await withClient(barePromptsServer, async (client) => {
  const listed = await client.listPrompts();
  const research = listed.prompts.find((prompt) => prompt.name === "research_brief");
  const got = await client.getPrompt({ name: "research_brief", arguments: { topic: "golden topic" } });
  return {
    list: JSON.parse(JSON.stringify(listed.prompts)),
    researchBrief: {
      title: research?.title ?? null,
      description: research?.description ?? null,
      body: got.messages[0]?.content?.text ?? null,
    },
  };
});

const instructions = await withClient(
  () => new McpServer({ name: "prompt-baseline-instructions", version: "1" }, { instructions: AGENT_INSTRUCTIONS }),
  async (client) => client.getInstructions() ?? "",
);

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
} catch {
  // A tarball export has no git; the digest of the content is still frozen.
}

const baseline = {
  schemaVersion: 1,
  capturedFrom: commit,
  toolNames: [...TOOL_NAMES],
  canonical,
  compact: {
    profile: "compact",
    groups: Object.keys(COMPACT_GROUPS),
    fingerprint: compactDescriptorFingerprint(compactWire),
    descriptors: compactWire.map((tool) => ({ name: tool.name, description: tool.description ?? null })),
    branches: compactWire.reduce((sum, tool) => sum + (tool.inputSchema?.oneOf?.length ?? 0), 0),
    scoped: {
      scopes: ["obsidian.read"],
      names: scopedCompact.tools.map((tool) => tool.name),
      fingerprint: compactDescriptorFingerprint(scopedCompact.tools),
    },
  },
  memory: { firstRead, checkpoint, afterWrite, readHint, writeHint },
  bootstrap: JSON.parse(JSON.stringify(getAgentBootstrap({ client: "prompt-baseline", project: "" }))),
  prompts,
  initializeInstructions: instructions,
};

const out = path.join(process.cwd(), "test", "fixtures", "prompt-base-baseline.json");
await writeFile(out, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
await rm(ROOT, { recursive: true, force: true });
console.log(`wrote ${out} (${canonicalWire.length} canonical, ${compactWire.length} compact, ${Object.keys(canonical).length} descriptions)`);
