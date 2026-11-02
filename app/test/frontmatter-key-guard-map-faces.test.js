// #538 (ruling a, owner 2026-10-12): front matter **key-shaped** parameters fail closed on a
// dotted key, while **whole-map** parameters stay literal on purpose — a map the caller authored
// (`updates` records, `write_note` / plan `operation=write` `frontmatter`) is an explicit map, so a
// dotted key inside it is a literal key and remains the documented escape hatch for a key that must
// contain a dot.
//
// This suite PINS that boundary from both sides. Tightening the whole-map faces (rejecting their
// dotted keys too) is a behaviour change: it must update these assertions — and the same ruling
// applies to `app/test/frontmatter-key-guard.test.js`'s escape-hatch case. Conversely, a regression
// that starts rejecting a whole-map literal key turns these cases red on purpose.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-frontmatter-map-faces-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
Object.assign(process.env, {
  VAULT_PATH: vault,
  DATA_PATH: data,
  HISTORY_PATH: path.join(data, "history"),
  VERSION_HISTORY_ENABLED: "true",
  GIT_ENABLED: "false",
  RETRIEVAL_AUTO_EMBED: "false",
  EMBEDDING_PROVIDER: "disabled",
});

const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { invalidateVaultIndex } = await import("../src/vault-index.js");
const { parseFrontmatter } = await import("../src/obsidian.js");
const { fileRevision } = await import("../src/vault.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const author = { agent: "frontmatter-map-faces", model: "test" };
const server = new McpServer({ name: author.agent, version: "1" });
registerObsidianCapabilities(server);
const client = new Client({ name: author.agent, version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
after(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

const call = (name, args) => client.callTool({ name, arguments: args, _meta: { "obsidian/author": author } });
const read = (relative) => fs.readFile(path.join(vault, relative), "utf8");
async function fixture(relative, header = "") {
  await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
  await fs.writeFile(path.join(vault, relative), header ? `---\n${header}---\n# Body\n` : "# Body\n", "utf8");
  invalidateVaultIndex([relative]);
  return fileRevision(path.join(vault, relative));
}
const body = async (relative) => (await parseFrontmatter(await read(relative))).data;
const ok = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
};
const errorText = (result) => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content.map((part) => part.text).join("\n");
};

let planCounter = 0;
async function applyPlan(change) {
  const planned = ok(await call("plan_note_changes", { changes: [change] }));
  return ok(await call("apply_note_plan", {
    planId: planned.planId,
    planHash: planned.planHash,
    idempotencyKey: `frontmatter-map-faces-${++planCounter}`,
  }));
}

test("escape hatch: manage_frontmatter action=set updates writes a literal dotted key", async () => {
  await fixture("Face/Set.md", "title: Set\n");
  ok(await call("manage_frontmatter", { path: "Face/Set.md", action: "set", updates: { "legacy.dotted": "v" } }));
  const frontmatter = await body("Face/Set.md");
  assert.equal(frontmatter["legacy.dotted"], "v", "the escape hatch must keep working");
  assert.equal(frontmatter.title, "Set", "a set merges into the existing frontmatter");
});

test("whole-map replace: manage_frontmatter action=replace updates is literal, not a nested path", async () => {
  await fixture("Face/Replace.md", "title: Replace\n");
  ok(await call("manage_frontmatter", { path: "Face/Replace.md", action: "replace", updates: { "a.b": 1, "nested.parent": { x: 2 } } }));
  const frontmatter = await body("Face/Replace.md");
  assert.equal(frontmatter["a.b"], 1);
  assert.deepEqual(frontmatter["nested.parent"], { x: 2 });
  assert.equal(frontmatter.a, undefined, "a whole-map replace must not expand dots into nesting");
});

test("plan frontmatter set with an updates record is literal", async () => {
  const baseRevision = await fixture("Face/PlanSet.md", "title: PlanSet\n");
  await applyPlan({ path: "Face/PlanSet.md", operation: "frontmatter", action: "set", baseRevision, updates: { "c.d": 2 } });
  const frontmatter = await body("Face/PlanSet.md");
  assert.equal(frontmatter["c.d"], 2);
  assert.equal(frontmatter.title, "PlanSet");
});

test("plan frontmatter replace with an updates record is literal", async () => {
  const baseRevision = await fixture("Face/PlanReplace.md", "title: PlanReplace\n");
  await applyPlan({ path: "Face/PlanReplace.md", operation: "frontmatter", action: "replace", baseRevision, updates: { "e.f": 3 } });
  const frontmatter = await body("Face/PlanReplace.md");
  assert.equal(frontmatter["e.f"], 3);
  assert.equal(frontmatter.title, undefined, "replace swaps the whole frontmatter body");
});

test("plan operation=write carries a whole frontmatter map literally", async () => {
  await applyPlan({ path: "Face/PlanWrite.md", operation: "write", mustNotExist: true, frontmatter: { "g.h": 4 }, content: "# Written\n" });
  const frontmatter = await body("Face/PlanWrite.md");
  assert.equal(frontmatter["g.h"], 4);
  assert.equal(frontmatter.g, undefined);
});

test("write_note carries a whole frontmatter map literally", async () => {
  ok(await call("write_note", { path: "Face/WriteNote.md", frontmatter: { "i.j": 5 }, content: "# WriteNote\n" }));
  const frontmatter = await body("Face/WriteNote.md");
  assert.equal(frontmatter["i.j"], 5);
  assert.equal(frontmatter.i, undefined);
});

test("the other side of the boundary: key-shaped parameters still fail closed", async () => {
  await fixture("Face/Key.md", "title: Key\n");
  assert.match(
    errorText(await call("manage_frontmatter", { path: "Face/Key.md", action: "set", key: "k.l", value: 1 })),
    /literal characters in a front matter key/,
  );
  assert.match(
    errorText(await call("rename_property", { from: "title", to: "m.n", dryRun: true })),
    /cannot create a property name containing "\."/,
  );
  const frontmatter = await body("Face/Key.md");
  assert.equal(frontmatter["k.l"], undefined);
  assert.equal(frontmatter["m.n"], undefined);
});
