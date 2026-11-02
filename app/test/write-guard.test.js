// Issue #251 regression: overwrite-style note writes must not silently shrink a
// note, must report what they deleted, and must hand back the pre-write version
// id so the caller can roll back in one step. These tests drive the real
// registered tools through the MCP SDK, so a contract/type regression fails the
// same way a production client would see it.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-write-guard-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(vault, { recursive: true });

const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { assessWriteImpact, assertShrinkConfirmed, WRITE_SHRINK_RATIO } = await import("../src/write-guard.js");

const server = new McpServer({ name: "write-guard-test", version: "1" });
registerObsidianCapabilities(server);
const client = new Client({ name: "write-guard-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

after(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

async function readRaw(rel) {
  return fs.readFile(path.join(vault, rel), "utf8");
}

async function seed(rel, content) {
  await fs.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
  await fs.writeFile(path.join(vault, rel), content, "utf8");
}

function errorText(result) {
  assert.equal(result.isError, true);
  return result.content.map((part) => part.text).join("\n");
}

const LINE = "filler line with enough words to make the byte count predictable";
function filler(prefix, count) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i} ${LINE}`).join("\n");
}

// Section One holds two sub-headings and one block, so replacing it with a tiny
// body deletes named structure, not just bytes.
const SECTION_ONE = ["### Alpha", "alpha body line ^alpha-block", filler("alpha", 60), "### Beta", filler("beta", 60)].join("\n") + "\n";

function guardedNote() {
  return [
    "# Top",
    "## Section One",
    SECTION_ONE.trimEnd(),
    "## Section Two",
    filler("two", 60),
    "## Section Three",
    filler("three", 60),
    "",
  ].join("\n");
}

test("patch_note replace that shrinks a >2KB note by more than 20% is refused without confirmation", async () => {
  await seed("Guarded/Patch.md", guardedNote());
  const before = await readRaw("Guarded/Patch.md");
  const beforeBytes = Buffer.byteLength(before, "utf8");
  assert.ok(beforeBytes >= 2048, `fixture must exceed the guard floor (was ${beforeBytes})`);

  const blocked = await call("patch_note", {
    path: "Guarded/Patch.md",
    operation: "replace",
    targetType: "heading",
    target: "Section One",
    content: "trimmed\n",
  });
  const message = errorText(blocked);
  assert.match(message, /confirmShrink/);
  assert.match(message, /plan_note_changes/);
  assert.match(message, /restore_version/);
  assert.ok(message.includes(String(beforeBytes)), `message must report the pre-write byte count: ${message}`);
  assert.match(message, /Alpha/);
  assert.equal(await readRaw("Guarded/Patch.md"), before, "a refused write must leave the note untouched");
});

test("confirmShrink: true allows the destructive patch and reports the deleted outline and shrink ratio", async () => {
  await seed("Guarded/Confirmed.md", guardedNote());
  const beforeBytes = Buffer.byteLength(await readRaw("Guarded/Confirmed.md"), "utf8");

  const applied = await call("patch_note", {
    path: "Guarded/Confirmed.md",
    operation: "replace",
    targetType: "heading",
    target: "Section One",
    content: "trimmed\n",
    confirmShrink: true,
  });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const out = applied.structuredContent;
  assert.deepEqual(out.removedHeadings, ["Alpha", "Beta"]);
  assert.deepEqual(out.removedBlocks, ["alpha-block"]);
  assert.equal(typeof out.shrinkRatio, "number");
  assert.ok(out.shrinkRatio > 0.2 && out.shrinkRatio < 1, `unexpected shrinkRatio ${out.shrinkRatio}`);
  const expectedRatio = (beforeBytes - out.currentSizeInBytes) / beforeBytes;
  assert.ok(Math.abs(out.shrinkRatio - Math.round(expectedRatio * 10000) / 10000) < 1e-9, `${out.shrinkRatio} != ${expectedRatio}`);
  assert.ok(out.currentSizeInBytes < out.previousSizeInBytes);
  assert.equal(typeof out.preWriteVersionId, "string");
  assert.match(out.preWriteVersionId, /\.bak$/);

  const after = await readRaw("Guarded/Confirmed.md");
  assert.ok(!after.includes("### Alpha"), "the confirmed patch must actually remove the section body");
});

test("preWriteVersionId restores the exact pre-write bytes in one step", async () => {
  await seed("Guarded/Rollback.md", guardedNote());
  const before = await readRaw("Guarded/Rollback.md");

  const applied = await call("patch_note", {
    path: "Guarded/Rollback.md",
    operation: "replace",
    targetType: "heading",
    target: "Section One",
    content: "trimmed\n",
    confirmShrink: true,
  });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const versionId = applied.structuredContent.preWriteVersionId;
  assert.equal(typeof versionId, "string");

  const restored = await call("restore_version", { versionId, overwrite: true });
  assert.equal(restored.isError, undefined, JSON.stringify(restored));
  assert.equal(await readRaw("Guarded/Rollback.md"), before);
});

test("a shrink below the ratio threshold is not intercepted", async () => {
  // 20 equally sized sections: dropping one is ~5% of the file.
  const sections = Array.from({ length: 20 }, (_, i) => [`## Part ${i}`, filler(`part${i}`, 20)].join("\n"));
  await seed("Guarded/Small.md", ["# Top", ...sections, ""].join("\n"));
  const beforeBytes = Buffer.byteLength(await readRaw("Guarded/Small.md"), "utf8");

  const applied = await call("patch_note", {
    path: "Guarded/Small.md",
    operation: "replace",
    targetType: "heading",
    target: "Part 0",
    content: "",
  });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const out = applied.structuredContent;
  assert.ok(out.shrinkRatio > 0 && out.shrinkRatio <= 0.2, `expected a sub-threshold shrink, got ${out.shrinkRatio}`);
  assert.ok(out.currentSizeInBytes < beforeBytes);
});

test("notes below the byte floor are never intercepted", async () => {
  const small = ["# Small", "## A", filler("a", 12), "## B", filler("b", 12), ""].join("\n");
  const smallBytes = Buffer.byteLength(small, "utf8");
  assert.ok(smallBytes < 2048, `fixture must stay below the floor (was ${smallBytes})`);
  await seed("Guarded/Tiny.md", small);

  const applied = await call("patch_note", {
    path: "Guarded/Tiny.md",
    operation: "replace",
    targetType: "heading",
    target: "A",
    content: "",
  });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  assert.ok(applied.structuredContent.shrinkRatio > 0.2, "the fixture must shrink by more than the ratio threshold");
  assert.ok(!(await readRaw("Guarded/Tiny.md")).includes("a 11"), "the small note must actually be replaced");
});

test("append operations are never intercepted and return a pre-write version id", async () => {
  await seed("Guarded/Append.md", guardedNote());

  const patched = await call("patch_note", {
    path: "Guarded/Append.md",
    operation: "append",
    targetType: "heading",
    target: "Section Two",
    content: "appended through patch\n",
  });
  assert.equal(patched.isError, undefined, JSON.stringify(patched));
  assert.equal(typeof patched.structuredContent.preWriteVersionId, "string");
  assert.match(patched.structuredContent.preWriteVersionId, /\.bak$/);
  assert.equal(patched.structuredContent.shrinkRatio, 0);
  assert.deepEqual(patched.structuredContent.removedHeadings, []);

  const appended = await call("append_to_note", { path: "Guarded/Append.md", content: "appended through append_to_note\n" });
  assert.equal(appended.isError, undefined, JSON.stringify(appended));
  assert.equal(typeof appended.structuredContent.preWriteVersionId, "string");
  assert.match(appended.structuredContent.preWriteVersionId, /\.bak$/);
});

test("write_note overwrite=true is guarded, and confirmShrink writes the smaller note", async () => {
  await seed("Guarded/Overwrite.md", guardedNote());
  const before = await readRaw("Guarded/Overwrite.md");

  const blocked = await call("write_note", { path: "Guarded/Overwrite.md", content: "# Top\n\nsmall\n", overwrite: true });
  const message = errorText(blocked);
  assert.match(message, /write_note/);
  assert.match(message, /confirmShrink/);
  assert.equal(await readRaw("Guarded/Overwrite.md"), before, "a refused overwrite must leave the note untouched");

  const applied = await call("write_note", { path: "Guarded/Overwrite.md", content: "# Top\n\nsmall\n", overwrite: true, confirmShrink: true });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  assert.equal(applied.structuredContent.created, false);
  assert.deepEqual(applied.structuredContent.removedHeadings, ["Alpha", "Beta", "Section One", "Section Three", "Section Two"]);
  assert.ok(applied.structuredContent.shrinkRatio > 0.2);
  assert.match(await readRaw("Guarded/Overwrite.md"), /small/);

  // Creating a new note is exempt from the guard.
  const created = await call("write_note", { path: "Guarded/New.md", content: "brand new\n" });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.equal(created.structuredContent.created, true);
  assert.equal(created.structuredContent.preWriteVersionId, null);
  assert.equal(created.structuredContent.shrinkRatio, 0);
});

test("replace_in_note that removes a large body chunk is guarded", async () => {
  await seed("Guarded/Replace.md", guardedNote());
  const before = await readRaw("Guarded/Replace.md");
  const beforeBytes = Buffer.byteLength(before, "utf8");

  const blocked = await call("replace_in_note", {
    path: "Guarded/Replace.md",
    replacements: [{ search: SECTION_ONE, replace: "" }],
  });
  const message = errorText(blocked);
  assert.match(message, /replace_in_note/);
  assert.ok(message.includes(String(beforeBytes)), `message must report the pre-write byte count: ${message}`);
  assert.match(message, /Alpha/);
  assert.equal(await readRaw("Guarded/Replace.md"), before);

  const applied = await call("replace_in_note", {
    path: "Guarded/Replace.md",
    replacements: [{ search: SECTION_ONE, replace: "" }],
    confirmShrink: true,
  });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const out = applied.structuredContent;
  assert.deepEqual(out.removedHeadings, ["Alpha", "Beta"]);
  assert.deepEqual(out.removedBlocks, ["alpha-block"]);
  assert.ok(out.shrinkRatio > 0.2);
  assert.match(out.preWriteVersionId, /\.bak$/);
});

// --- R1 revisions: raw-ratio gate, write_file guard, rollback contract ---

test("the shrink gate uses the unrounded ratio (20.0008% is refused while the display rounds to 0.2)", () => {
  // 23864 -> 19091 is a real 20.0008% shrink: it must be refused even though the
  // 4-decimal display value is exactly 0.2.
  const impact = assessWriteImpact({ previousBytes: 23864, nextBytes: 19091 });
  assert.ok(impact.rawShrinkRatio > WRITE_SHRINK_RATIO, `raw ratio ${impact.rawShrinkRatio} must exceed ${WRITE_SHRINK_RATIO}`);
  assert.equal(impact.shrinkRatio, 0.2, "the reported ratio is the rounded display value");
  assert.equal(impact.shrunk, true, "the gate must decide on the raw ratio");
  assert.throws(
    () => assertShrinkConfirmed(impact, { confirmShrink: false, toolName: "patch_note", path: "Guarded/Boundary.md" }),
    (error) => {
      assert.match(error.message, /-20\.0%/, "the message reports the rounded display percentage");
      return true;
    },
  );
  assert.equal(assertShrinkConfirmed(impact, { confirmShrink: true, toolName: "patch_note", path: "Guarded/Boundary.md" }), impact);
});

test("write_file overwriting an existing Markdown note is guarded and can be confirmed", async () => {
  await seed("Guarded/WriteFile.md", guardedNote());
  const before = await readRaw("Guarded/WriteFile.md");
  const beforeBytes = Buffer.byteLength(before, "utf8");

  const blocked = await call("write_file", { path: "Guarded/WriteFile.md", content: "# Top\n\nsmall\n", overwrite: true });
  const message = errorText(blocked);
  assert.match(message, /write_file/);
  assert.match(message, /confirmShrink/);
  assert.ok(message.includes(String(beforeBytes)), `message must report the pre-write byte count: ${message}`);
  assert.match(message, /Alpha/);
  assert.equal(await readRaw("Guarded/WriteFile.md"), before, "a refused write_file must leave the note untouched");

  const applied = await call("write_file", { path: "Guarded/WriteFile.md", content: "# Top\n\nsmall\n", overwrite: true, confirmShrink: true });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const out = applied.structuredContent;
  assert.equal(out.created, false);
  assert.deepEqual(out.removedHeadings, ["Alpha", "Beta", "Section One", "Section Three", "Section Two"]);
  assert.deepEqual(out.removedBlocks, ["alpha-block"]);
  assert.ok(out.shrinkRatio > 0.2, `unexpected shrinkRatio ${out.shrinkRatio}`);
  assert.ok(out.currentSizeInBytes < out.previousSizeInBytes);
  assert.equal(typeof out.preWriteVersionId, "string");
  assert.match(out.preWriteVersionId, /\.bak$/);
  assert.match(await readRaw("Guarded/WriteFile.md"), /small/);
});

test("write_file shrinking a non-Markdown file by 90% is not intercepted", async () => {
  const big = `${JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ i, text: LINE })) }, null, 2)}\n`;
  await seed("Guarded/data.json", big);
  const beforeBytes = Buffer.byteLength(big, "utf8");
  assert.ok(beforeBytes >= 2048, `fixture must exceed the guard floor (was ${beforeBytes})`);

  const applied = await call("write_file", { path: "Guarded/data.json", content: "{\"rows\":[]}\n", overwrite: true, acceptedOnly: false });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const out = applied.structuredContent;
  assert.equal(out.shrinkRatio, 0);
  assert.deepEqual(out.removedHeadings, []);
  assert.deepEqual(out.removedBlocks, []);
  assert.ok((beforeBytes - out.currentSizeInBytes) / beforeBytes > 0.9, "the fixture must shrink by at least 90%");
});

test("write_file creating a new Markdown file is never intercepted", async () => {
  const applied = await call("write_file", { path: "Guarded/WriteFileNew.md", content: "# New\n\nbody\n" });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const out = applied.structuredContent;
  assert.equal(out.created, true);
  assert.equal(out.shrinkRatio, 0);
  assert.deepEqual(out.removedHeadings, []);
  assert.deepEqual(out.removedBlocks, []);
  assert.equal(out.preWriteVersionId, null);
});

test("restore_version fails closed without overwrite while the note still exists, then restores with overwrite", async () => {
  await seed("Guarded/RollbackGuard.md", guardedNote());
  const before = await readRaw("Guarded/RollbackGuard.md");

  const applied = await call("patch_note", {
    path: "Guarded/RollbackGuard.md",
    operation: "replace",
    targetType: "heading",
    target: "Section One",
    content: "trimmed\n",
    confirmShrink: true,
  });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const versionId = applied.structuredContent.preWriteVersionId;
  assert.equal(typeof versionId, "string");
  const afterWrite = await readRaw("Guarded/RollbackGuard.md");
  assert.notEqual(afterWrite, before);

  const blocked = await call("restore_version", { versionId });
  const message = errorText(blocked);
  assert.match(message, /overwrite=true/);
  assert.equal(await readRaw("Guarded/RollbackGuard.md"), afterWrite, "a refused restore must leave the note untouched");

  const restored = await call("restore_version", { versionId, overwrite: true });
  assert.equal(restored.isError, undefined, JSON.stringify(restored));
  assert.equal(await readRaw("Guarded/RollbackGuard.md"), before, "the confirmed restore must return the exact pre-write bytes");
});

test("append_to_note reports preWriteVersionId for both create and existing notes", async () => {
  const created = await call("append_to_note", { path: "Guarded/AppendNew.md", content: "first line\n" });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.equal(created.structuredContent.created, true);
  assert.equal(created.structuredContent.preWriteVersionId, null);

  const appended = await call("append_to_note", { path: "Guarded/AppendNew.md", content: "second line\n" });
  assert.equal(appended.isError, undefined, JSON.stringify(appended));
  assert.equal(appended.structuredContent.created, false);
  assert.equal(typeof appended.structuredContent.preWriteVersionId, "string");
  assert.match(appended.structuredContent.preWriteVersionId, /\.bak$/);
});
