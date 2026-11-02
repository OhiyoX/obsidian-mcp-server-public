// #529: front matter keys are literal on EVERY path — `get_note` with
// sectionType=frontmatter and `manage_frontmatter` action=get both index
// `frontmatter[key]` directly — so a dotted key/target is a key that contains a dot,
// never a path. Writing one used to succeed silently and drop junk (`probe.nested: x`)
// into a real note; writes now fail closed and name the supported way to set a nested
// field (replace the parent mapping, or merge through `updates`).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-frontmatter-key-guard-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.VERSION_HISTORY_ENABLED = "true";
process.env.GIT_ENABLED = "false";

const { withRequestContext } = await import("../src/request-context.js");
const { assertFrontmatterKeyIsLiteral } = await import("../src/obsidian.js");
const { createNotePlan } = await import("../src/mutation-plans.js");
const { fileRevision } = await import("../src/vault.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const author = { agent: "test-agent", model: "test-model" };
const authored = (callback) => withRequestContext({ author }, callback);
const GUARD_NOTE = "---\nprobe:\n  a: 1\n---\n# Note\n\nbody\n";

test("assertFrontmatterKeyIsLiteral: plain keys pass; dotted writes fail; existing dotted keys stay removable", () => {
  assert.doesNotThrow(() => assertFrontmatterKeyIsLiteral("plain"));
  // Slashes and dashes were never path syntax here and must keep working unchanged.
  assert.doesNotThrow(() => assertFrontmatterKeyIsLiteral("obsidian/author"));
  assert.doesNotThrow(() => assertFrontmatterKeyIsLiteral("allowed-tools"));
  assert.throws(() => assertFrontmatterKeyIsLiteral("a.b"), /literal characters in a front matter key/);
  const existing = { "a.b": "legacy" };
  assert.doesNotThrow(() => assertFrontmatterKeyIsLiteral("a.b", { existing, removing: true }));
  assert.throws(() => assertFrontmatterKeyIsLiteral("a.b", { existing }), /replace the parent mapping/);
  assert.throws(() => assertFrontmatterKeyIsLiteral("missing.b", { existing, removing: true }), /literal characters/);
});

test("front matter writes reject dotted keys and leave the note byte-identical", async () => {
  const file = path.join(vault, "Guard", "Note.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, GUARD_NOTE, "utf-8");

  const server = new McpServer({ name: "frontmatter-key-guard", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "test-agent", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const patched = await client.callTool({
      name: "patch_note",
      arguments: { path: "Guard/Note.md", operation: "replace", targetType: "frontmatter", target: "probe.nested", content: "x" },
    });
    assert.equal(patched.isError, true);
    assert.match(patched.content[0].text, /literal characters in a front matter key/);

    const set = await client.callTool({
      name: "manage_frontmatter",
      arguments: { path: "Guard/Note.md", action: "set", key: "probe.nested", value: "x" },
    });
    assert.equal(set.isError, true);
    assert.match(set.content[0].text, /replace the parent mapping/);

    const deleteMissing = await client.callTool({
      name: "manage_frontmatter",
      arguments: { path: "Guard/Note.md", action: "delete", key: "probe.nested" },
    });
    assert.equal(deleteMissing.isError, true);
    assert.match(deleteMissing.content[0].text, /literal characters in a front matter key/);

    // Nothing was written by any of the three rejections above.
    assert.equal(await fs.readFile(file, "utf-8"), GUARD_NOTE);

    // The supported spellings keep working: a plain key, and the parent mapping replaced whole.
    const plain = await client.callTool({
      name: "manage_frontmatter",
      arguments: { path: "Guard/Note.md", action: "set", key: "plain", value: "ok" },
    });
    assert.equal(plain.isError, undefined);
    assert.equal(plain.structuredContent.frontmatter.plain, "ok");

    const nested = await client.callTool({
      name: "manage_frontmatter",
      arguments: { path: "Guard/Note.md", action: "set", key: "probe", value: { a: 1, nested: "x" } },
    });
    assert.equal(nested.isError, undefined);
    assert.deepEqual(nested.structuredContent.frontmatter.probe, { a: 1, nested: "x" });

    // `updates` merges objects untouched, so it stays the escape hatch for a literal
    // dotted key — and deleting such an existing key is the only cleanup path.
    const viaUpdates = await client.callTool({
      name: "manage_frontmatter",
      arguments: { path: "Guard/Note.md", action: "set", updates: { "legacy.dotted": "v" } },
    });
    assert.equal(viaUpdates.isError, undefined);
    assert.equal(viaUpdates.structuredContent.frontmatter["legacy.dotted"], "v");

    const cleanup = await client.callTool({
      name: "manage_frontmatter",
      arguments: { path: "Guard/Note.md", action: "delete", key: "legacy.dotted" },
    });
    assert.equal(cleanup.isError, undefined);
    assert.equal(cleanup.structuredContent.frontmatter["legacy.dotted"], undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("plan frontmatter changes reject dotted keys and touch nothing on disk", async () => {
  await fs.mkdir(path.join(vault, "Guard"), { recursive: true });
  await fs.writeFile(path.join(vault, "Guard", "Plan.md"), "---\ntitle: Plan\n---\n# Plan\n", "utf-8");
  const baseRevision = await fileRevision(path.join(vault, "Guard", "Plan.md"));

  await assert.rejects(
    () => authored(() => createNotePlan([
      { path: "Guard/Plan.md", operation: "frontmatter", action: "set", key: "a.b", value: 1, baseRevision },
    ])),
    /literal characters in a front matter key/,
  );
  await assert.rejects(
    () => authored(() => createNotePlan([
      { path: "Guard/Plan.md", operation: "frontmatter", action: "delete", key: "a.b", baseRevision },
    ])),
    /literal characters in a front matter key/,
  );

  // NOTE (Codex review, 2026-10-11): that the guard sits *before* candidate serialization is a
  // property of its placement in mutation-plans.js; these calls only observe the rejection and
  // the untouched file — a guard that runs after serialization would still throw here.
  // The rejected plans wrote nothing.
  assert.equal(await fs.readFile(path.join(vault, "Guard", "Plan.md"), "utf-8"), "---\ntitle: Plan\n---\n# Plan\n");

  // `updates` remains the supported way to write a nested field, and it is unchanged.
  const plan = await authored(() => createNotePlan([
    { path: "Guard/Plan.md", operation: "frontmatter", action: "set", baseRevision, updates: { mapping: { nested: 1 } } },
  ]));
  assert.equal(plan.changed, true);
  // Mutation-sensitive on purpose: `changed: true` alone is satisfied by the author stamp, so a
  // mutant that ignores `updates` still passed it. The planned delta must carry the value.
  assert.match(JSON.stringify(plan), /"nested":1/);
});
