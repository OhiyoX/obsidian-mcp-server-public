// P1 (#629) — `patch_base`: the line-surgical `.base` increment over MCP, with a
// mandatory CAS precondition.
//
// What this lane is responsible for (BRIEF `desktop-re/mcp-patch-base`):
//   * the mutation face is A4a's (`patchBaseDocument`) — this tool only wires it, so
//     "everything outside the addressed lines is byte-identical" is asserted here
//     against the real disk bytes (comments, unknown keys, quote style, CRLF, no final
//     newline), never against a re-serialised expectation;
//   * the precondition is mandatory and content-derived: the token `get_base` reports is
//     the same sha256 the write path compares inside its mutation lock, so a missing
//     precondition is `precondition-required` and a stale one is `revision-conflict`,
//     and neither may touch the file;
//   * A4a's own refusals (`base-not-patchable` / `base-unknown-key`) survive as
//     structured codes;
//   * the response never claims the patched document is queryable: `warnings` is the
//     only channel for that statement, and it is non-empty exactly when `query_base`'s
//     own compile step would refuse the document.
//
// Negative controls at the bottom run the SAME assertions through mutants (an mtime
// token, a `yaml.dump` rewrite); they must fail there. They are the evidence that the
// assertions above are not vacuous — a real source mutation turns the corresponding
// shipped assertion red as well.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import yaml from "js-yaml";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-patch-base-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.TRASH_PATH = path.join(data, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
await fs.mkdir(data, { recursive: true });
await fs.mkdir(vault, { recursive: true });

// A document that only a line-surgical writer can keep intact: a header comment, an
// unknown top-level key, a nested unknown view key, a quoted value with an escaped
// quote, CRLF line endings and no final newline.
const ORIGINAL = [
  "# Boards — header comment",
  "filters: file.inFolder(\"Tasks\")",
  "unknownTopLevelKey: keep-me",
  "views:",
  "  - type: table",
  "    name: AllTasks",
  "    limit: 25",
  "    futureOption: \"keep \\\"quoted\\\"\"",
  "  - type: cards",
  "    name: Cards",
].join("\r\n");

const BASE = "Boards.base";
const ABSOLUTE = path.join(vault, BASE);
await fs.writeFile(ABSOLUTE, ORIGINAL, "utf8");

// A document whose bytes are not valid UTF-8 (a latin-1 `é` in a comment): YAML still parses
// it, but `readLimitedText` decodes the byte as U+FFFD. It is the fixture that separates the
// two candidate CAS tokens — `sha256(bytes)` vs `sha256(decoded text)` — and it must stay
// patchable, with the illegal byte preserved.
const NON_UTF8 = Buffer.concat([
  Buffer.from("# caf", "latin1"),
  Buffer.from([0xe9]),
  Buffer.from(" (latin-1 comment)\r\nviews:\r\n  - type: table\r\n    name: AllTasks\r\n    limit: 25\r\n  - type: cards\r\n    name: Cards\r\n", "utf8"),
]);
const NON_UTF8_NAME = "Cafe.base";
const NON_UTF8_ABSOLUTE = path.join(vault, NON_UTF8_NAME);
const LIMIT_TO_50 = [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 50 }];
const writeNonUtf8 = () => fs.writeFile(NON_UTF8_ABSOLUTE, NON_UTF8);
const expectedNonUtf8Bytes = () => Buffer.from(NON_UTF8.toString("latin1").replace("limit: 25", "limit: 50"), "latin1");

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const contentRevision = (text) => sha256(Buffer.from(text, "utf8"));
// The mutant the negative control uses: a token derived from metadata instead of content.
const mtimeRevision = async () => `mtime:${(await fs.stat(ABSOLUTE)).mtimeMs}`;

const { registerWorkflowTools } = await import("../src/tools/workflows.js");
const { withRequestContext } = await import("../src/request-context.js");
const { MCP_TOOL_SCOPE_REQUIREMENTS, requiredScopesForTools } = await import("../src/scopes.js");
const { COMPACT_GROUPS, compactToolView, projectCompactCall } = await import("../src/compact-tools.js");
const { BASE_PATCH_OPERATIONS, patchBaseDocument } = await import("../src/base-patch.js");

const AUTHOR = Object.freeze({ agent: "mcp-patch-base-lane", model: "test" });

let server;
let client;
let servedInputSchema;

before(async () => {
  server = new McpServer({ name: "mcp-patch-base-test", version: "1" });
  registerWorkflowTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "mcp-patch-base-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  servedInputSchema = (await client.listTools()).tools.find((tool) => tool.name === "patch_base")?.inputSchema;
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

// Every write goes through the same author context the production registrar installs.
const call = (name, args) => withRequestContext({ author: AUTHOR }, () => client.callTool({ name, arguments: args }));
const structured = async (name, args) => (await call(name, args)).structuredContent;
const patch = (args) => call("patch_base", args);
const read = () => fs.readFile(ABSOLUTE, "utf8");
const reset = () => fs.writeFile(ABSOLUTE, ORIGINAL, "utf8");

async function currentRevision() {
  return (await structured("get_base", { path: BASE })).revision;
}

async function expectRefusal(args, code) {
  const result = await patch(args);
  assert.equal(result.isError, true, `patch_base must refuse: ${result.content?.[0]?.text}`);
  assert.equal(result.structuredContent?.code, code, `expected code ${code}, got ${JSON.stringify(result.structuredContent)}`);
  assert.equal(await read(), ORIGINAL, `a refused patch (${code}) must leave the document untouched`);
  return result;
}

// ── 1. Registration, scope and the strict input union ───────────────────────

test("patch_base is registered as a write tool with a strict mutation union", () => {
  assert.ok(servedInputSchema, "patch_base must be served");
  assert.deepEqual(Object.keys(servedInputSchema.properties).sort(), ["ifMatch", "mutationId", "mutations", "path"]);
  assert.equal(MCP_TOOL_SCOPE_REQUIREMENTS.patch_base.includes("obsidian.write"), true);
  // A read-only credential must not be able to reach it: the scope gate derives the
  // required set from the registry, so this is the same refusal path the auth layer uses.
  assert.deepEqual(requiredScopesForTools(["patch_base"]), ["obsidian.read", "obsidian.write"]);
  assert.equal(requiredScopesForTools(["get_base"]).includes("obsidian.write"), false);

  const branches = servedInputSchema.properties.mutations.items.oneOf;
  assert.ok(Array.isArray(branches), "mutations must be a closed oneOf union");
  assert.deepEqual(branches.map((branch) => branch.properties.op.const), [...BASE_PATCH_OPERATIONS]);
  for (const branch of branches) {
    assert.equal(branch.additionalProperties, false, "no catch-all mutation object is advertised");
    assert.equal(Object.hasOwn(branch.properties, "args"), false, "no `args: any` escape hatch");
    assert.deepEqual(Object.keys(branch.properties).sort(), [...branch.required].sort(), "every mutation field is required");
  }
});

// ── 2. Success: byte-identical outside the addressed line ───────────────────

test("a successful patch changes exactly one line and preserves every other byte", async () => {
  await reset();
  const ifMatch = await currentRevision();
  assert.equal(ifMatch, contentRevision(ORIGINAL), "get_base.revision is the content sha256");

  const result = await structured("patch_base", {
    path: BASE,
    ifMatch,
    mutations: [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 50 }],
  });
  assert.equal(result.changed, true);
  assert.equal(result.previousRevision, ifMatch);
  assert.deepEqual(result.warnings, [], "the patched document is still queryable");
  assert.equal(result.revision, contentRevision(await read()), "the returned revision is the new content sha256");

  const after = await read();
  const originalLines = ORIGINAL.split("\r\n");
  const afterLines = after.split("\r\n");
  assert.equal(afterLines.length, originalLines.length, "no line was added or removed");
  const changed = originalLines.map((line, index) => (line === afterLines[index] ? null : index)).filter((index) => index !== null);
  assert.deepEqual(changed, [6], "exactly one line differs");
  assert.equal(afterLines[6], "    limit: 50");
  // Byte-level invariants the whole lane exists for: CRLF survived, the comment and the
  // unknown keys are untouched, the quoted value keeps its escaped quotes, no newline was
  // appended. (`yaml.dump` fails every one of these — see the negative control.)
  assert.equal(after.includes("\r\n"), true);
  assert.equal(after.includes("\n") && !after.includes("\r\n"), false, "no LF-only line was introduced");
  assert.equal(after.includes("# Boards — header comment"), true);
  assert.equal(after.includes("unknownTopLevelKey: keep-me"), true);
  assert.equal(after.includes("    futureOption: \"keep \\\"quoted\\\"\""), true);
  assert.equal(after.endsWith("\n"), false, "the missing final newline must stay missing");

  // get_base now reports the new revision and the patched value.
  const readBack = await structured("get_base", { path: BASE });
  assert.equal(readBack.revision, contentRevision(after));
  assert.equal(readBack.base.views[0].limit, 50);

  // And query_base can still serve it (the `warnings: []` claim is real).
  const queried = await structured("query_base", { path: BASE });
  assert.equal(queried.path, BASE);
  await reset();
});

test("an increment that changes nothing writes nothing and keeps the addressed revision", async () => {
  await reset();
  const ifMatch = await currentRevision();
  const result = await structured("patch_base", {
    path: BASE,
    ifMatch,
    mutations: [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 25 }],
  });
  assert.equal(result.changed, false);
  assert.equal(result.revision, ifMatch);
  assert.equal(await read(), ORIGINAL);
});

// ── 2b. The CAS token is the sha256 of the document BYTES ───────────────────
// The token `get_base` reports and the token the write lock re-reads must be the same quantity
// over the same input. They are only equal for a document that survives a UTF-8 round trip, so
// the assertions below use a document that does not: hashing the decoded text (the pre-fix
// definition) both misreports the revision and makes every `ifMatch` unusable there.

test("get_base.revision is the sha256 of the bytes, and patch_base accepts it", async () => {
  await reset();
  const bytes = await fs.readFile(ABSOLUTE);
  const revision = await currentRevision();
  assert.equal(revision, sha256(bytes), "the token is over the document bytes");
  // For a valid UTF-8 document the two definitions coincide — which is exactly why the
  // divergence below needs its own fixture.
  assert.equal(revision, contentRevision(ORIGINAL));
  const result = await structured("patch_base", { path: BASE, ifMatch: revision, mutations: LIMIT_TO_50 });
  assert.equal(result.changed, true);
  assert.equal(result.revision, sha256(await fs.readFile(ABSOLUTE)));
  await reset();
});

test("a non-UTF-8 document stays patchable and keeps the illegal bytes byte-for-byte", async () => {
  await writeNonUtf8();
  const bytes = await fs.readFile(NON_UTF8_ABSOLUTE);
  const decoded = bytes.toString("utf8");
  // The fixture is only meaningful if the two candidate tokens really differ.
  assert.notEqual(sha256(bytes), sha256(Buffer.from(decoded, "utf8")), "the two token inputs must differ here");
  assert.equal(decoded.includes("\uFFFD"), true, "the illegal byte decodes with replacement");

  const revision = (await structured("get_base", { path: NON_UTF8_NAME })).revision;
  assert.equal(revision, sha256(bytes), "get_base.revision is over the raw bytes, not the decoded text");

  const result = await structured("patch_base", { path: NON_UTF8_NAME, ifMatch: revision, mutations: LIMIT_TO_50 });
  assert.equal(result.changed, true, "the revision get_base handed out must be accepted by the write path");
  assert.equal(result.previousRevision, revision);
  assert.deepEqual(result.warnings, []);

  const after = await fs.readFile(NON_UTF8_ABSOLUTE);
  assert.equal(after.equals(expectedNonUtf8Bytes()), true, "only the addressed line may change, byte for byte");
  assert.equal(after.length, bytes.length, "the increment is the same width, so nothing shifted");
  assert.equal(after.indexOf(0xe9), bytes.indexOf(0xe9), "the latin-1 byte is still 0xE9, not the U+FFFD encoding (EF BF BD)");
  assert.ok(after.indexOf(0xe9) >= 0, "the fixture must actually contain the illegal byte");
  // Exactly one line differs, and the CRLF/LF layout of the rest is untouched.
  const beforeLines = bytes.toString("latin1").split("\n");
  const afterLines = after.toString("latin1").split("\n");
  assert.deepEqual(beforeLines.map((line, index) => (line === afterLines[index] ? null : index)).filter((index) => index !== null), [4]);
  // The splice must not change what A4a's own text view produced — it only preserves bytes.
  assert.equal(after.toString("utf8"), patchBaseDocument(decoded, LIMIT_TO_50));
  assert.equal(result.revision, sha256(after));
  assert.equal((await structured("get_base", { path: NON_UTF8_NAME })).revision, sha256(after));
});

test("negative control: a text-derived token would make the non-UTF-8 document unusable", async () => {
  await writeNonUtf8();
  const bytes = await fs.readFile(NON_UTF8_ABSOLUTE);
  // The mutant is the pre-fix definition: hash the decoded text (what `contentRevision(text)` did).
  const mutant = sha256(Buffer.from(bytes.toString("utf8"), "utf8"));
  const revision = (await structured("get_base", { path: NON_UTF8_NAME })).revision;
  assert.notEqual(mutant, revision, "the mutant token is not the one this server hands out");
  // And using it fails exactly the way the shipped bug did: refused, with the file untouched.
  const result = await patch({ path: NON_UTF8_NAME, ifMatch: mutant, mutations: LIMIT_TO_50 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "revision-conflict");
  assert.equal((await fs.readFile(NON_UTF8_ABSOLUTE)).equals(bytes), true, "a refused patch must not write");
});

// ── 2c. Multi-hunk splicing: the lines BETWEEN two addressed ones ───────────
// One batch may address lines that are not adjacent. Every line the locator did not address
// must survive — including a line that sits *between* two addressed ones and holds a byte that
// is not valid UTF-8. A splice that rebuilds the span from the first to the last addressed line
// out of the decoded text turns that byte into `EF BF BD` and still reports `changed: true`, so
// each assertion below is paired with the mutant in test ④.

const ILLEGAL = Buffer.from([0xef, 0xbf, 0xbd]); // the U+FFFD encoding a re-encode would write
const latin1Lines = (buffer) => buffer.toString("latin1").split("\n");
const changedLineIndexes = (before, after) => {
  const left = latin1Lines(before);
  const right = latin1Lines(after);
  assert.equal(right.length, left.length, "the increment must not add or remove a line");
  return left.map((line, index) => (line === right[index] ? null : index)).filter((index) => index !== null);
};

// Two addressed lines (3 and 6, 0-based) with an UNaddressed line 5 between them that carries
// the latin-1 `é`. The view's name decodes to `Caf\uFFFD`, which is how it is addressed.
const MULTI_HUNK = Buffer.concat([
  Buffer.from("views:\r\n  - type: table\r\n    name: AllTasks\r\n    limit: 25\r\n  - type: cards\r\n    name: Caf", "utf8"),
  Buffer.from([0xe9]),
  Buffer.from("\r\n    limit: 10\r\n", "utf8"),
]);
const MULTI_HUNK_NAME = "MultiHunk.base";
const MULTI_HUNK_MUTATIONS = [
  { op: "set-view-option", view: "AllTasks", key: "limit", value: 50 },
  { op: "set-view-option", view: "Caf\uFFFD", key: "limit", value: 99 },
];

// A longer span: three addressed lines (3 / 7 / 11) with an unaddressed illegal byte on each of
// the two lines in between (0xE9 then 0xFF).
const THREE_HUNK = Buffer.concat([
  Buffer.from("views:\r\n  - type: table\r\n    name: A\r\n    limit: 1\r\n    note: caf", "utf8"),
  Buffer.from([0xe9]),
  Buffer.from("\r\n  - type: table\r\n    name: B\r\n    limit: 2\r\n    note: caf", "utf8"),
  Buffer.from([0xff]),
  Buffer.from("\r\n  - type: cards\r\n    name: C\r\n    limit: 3\r\n", "utf8"),
]);
const THREE_HUNK_NAME = "ThreeHunk.base";
const THREE_HUNK_MUTATIONS = [
  { op: "set-view-option", view: "A", key: "limit", value: 11 },
  { op: "set-view-option", view: "B", key: "limit", value: 22 },
  { op: "set-view-option", view: "C", key: "limit", value: 33 },
];

async function patchFixture(name, bytes, mutations) {
  const abs = path.join(vault, name);
  await fs.writeFile(abs, bytes);
  const revision = (await structured("get_base", { path: name })).revision;
  assert.equal(revision, sha256(bytes), `${name}: the token is over the raw bytes`);
  const result = await structured("patch_base", { path: name, ifMatch: revision, mutations });
  return { result, after: await fs.readFile(abs) };
}

test("two non-adjacent addressed lines: the unaddressed line between them keeps its illegal byte", async () => {
  const { result, after } = await patchFixture(MULTI_HUNK_NAME, MULTI_HUNK, MULTI_HUNK_MUTATIONS);
  assert.equal(result.changed, true);
  assert.equal(result.previousRevision, sha256(MULTI_HUNK));
  assert.deepEqual(result.warnings, []);
  // ① only the two addressed lines differ — the middle line is byte-identical, not re-encoded.
  assert.deepEqual(changedLineIndexes(MULTI_HUNK, after), [3, 6]);
  assert.equal(latin1Lines(after)[5], latin1Lines(MULTI_HUNK)[5], "the unaddressed middle line must be copied verbatim");
  assert.ok(MULTI_HUNK.indexOf(0xe9) >= 0, "the fixture must actually contain the illegal byte");
  assert.equal(after.indexOf(0xe9), MULTI_HUNK.indexOf(0xe9), "the latin-1 byte is still 0xE9");
  assert.equal(after.indexOf(ILLEGAL), -1, "no U+FFFD may be introduced anywhere");
  assert.equal(after.length, MULTI_HUNK.length, "the increment is the same width");
  // The splice must not change what A4a's own text view produced — it only preserves bytes.
  assert.equal(after.toString("utf8"), patchBaseDocument(MULTI_HUNK.toString("utf8"), MULTI_HUNK_MUTATIONS));
  assert.equal(result.revision, sha256(after));
  assert.equal((await structured("get_base", { path: MULTI_HUNK_NAME })).revision, sha256(after));
});

test("three addressed lines across a longer span keep both unaddressed illegal bytes", async () => {
  const { result, after } = await patchFixture(THREE_HUNK_NAME, THREE_HUNK, THREE_HUNK_MUTATIONS);
  assert.equal(result.changed, true);
  assert.deepEqual(changedLineIndexes(THREE_HUNK, after), [3, 7, 11], "only the three addressed lines may differ");
  // The addressed values grow by one digit each, so the bytes after them shift — compare the
  // unaddressed lines by value, not by offset.
  assert.equal(latin1Lines(after)[4], latin1Lines(THREE_HUNK)[4]);
  assert.equal(latin1Lines(after)[8], latin1Lines(THREE_HUNK)[8]);
  assert.equal(after.includes(0xe9), true, "the latin-1 byte survives");
  assert.equal(after.includes(0xff), true, "the 0xFF byte survives");
  assert.equal(after.indexOf(ILLEGAL), -1);
  assert.equal(after.length, THREE_HUNK.length + 3, "only the three added digits");
  assert.equal(after.toString("utf8"), patchBaseDocument(THREE_HUNK.toString("utf8"), THREE_HUNK_MUTATIONS));
  assert.equal(result.revision, sha256(after));
});

test("a valid UTF-8 document stays byte-identical to the text-level patch (CRLF / LF / no final newline)", async () => {
  const document = ["views:", "  - type: table", "    name: A", "    limit: 1", "  - type: cards", "    name: B", "    limit: 2"];
  const mutations = [
    { op: "set-view-option", view: "A", key: "limit", value: 50 },
    { op: "set-view-option", view: "B", key: "limit", value: 99 },
  ];
  for (const [eol, trailing] of [["\r\n", true], ["\n", true], ["\n", false]]) {
    const raw = document.join(eol) + (trailing ? eol : "");
    const bytes = Buffer.from(raw, "utf8");
    const { after } = await patchFixture("Utf8Multi.base", bytes, mutations);
    assert.equal(
      after.equals(Buffer.from(patchBaseDocument(raw, mutations), "utf8")),
      true,
      `byte-identical for eol=${JSON.stringify(eol)} trailing=${trailing}`,
    );
    assert.deepEqual(changedLineIndexes(bytes, after), [3, 6]);
  }
});

test("negative control: a text-level re-encode silently rewrites the unaddressed line", async () => {
  const { after } = await patchFixture(MULTI_HUNK_NAME, MULTI_HUNK, MULTI_HUNK_MUTATIONS);
  // The mutant is the pre-fix splice: re-encode the patched *text*, which rebuilds every line
  // between the first and the last addressed one from its decoded form. Test ①'s load-bearing
  // assertions must all fail here.
  const mutant = Buffer.from(patchBaseDocument(MULTI_HUNK.toString("utf8"), MULTI_HUNK_MUTATIONS), "utf8");
  assert.equal(mutant.indexOf(ILLEGAL) >= 0, true, "the mutant introduces U+FFFD");
  assert.equal(mutant.indexOf(0xe9), -1, "the mutant loses the latin-1 byte");
  assert.equal(mutant.equals(after), false);
  assert.notEqual(latin1Lines(mutant)[5], latin1Lines(MULTI_HUNK)[5], "the mutant does rewrite the unaddressed line");
  assert.notDeepEqual(changedLineIndexes(MULTI_HUNK, mutant), [3, 6], "so `changed === [3, 6]` cannot hold for the mutant");
});

// ── 2d. Non-UTF-8: provenance, not line count (BRIEF-FIX-PROVENANCE) ────────
// Old failure signature (R3/R4): a line the caller never addressed was rebuilt from the lossy
// decode (`0xE9` -> `EF BF BD`) and still reported `changed: true`. Two separate causes: the gate
// compared *total line counts* (so "delete k + insert k" passed), and `insertLines` edited the
// previous line's `eol` in place (so an append made an unaddressed line look replaced). Both are
// fixed: appending writes the separator as new bytes, and the gate judges every line by its
// provenance (`kept` / `replaced` / `inserted`). What stays refused is exactly what has no byte
// mapping: any deletion, and an insertion in the middle of the document.
const TAIL_ILLEGAL = Buffer.concat([
  Buffer.from("views:\r\n  - type: table\r\n    name: AllTasks\r\n    limit: 25\r\n  - type: cards\r\n    name: Caf", "utf8"),
  Buffer.from([0xe9]),
]);
const TAIL_ILLEGAL_NAME = "TailIllegal.base";
const TAIL_ILLEGAL_ABS = path.join(vault, TAIL_ILLEGAL_NAME);
const APPEND_FORMULA = [{ op: "set-formulas", key: "flag", value: "done" }];
const IN_PLACE_LIMIT = [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 50 }];
// A trailing top-level key *after* the formulas block makes an inserted formula a middle insert,
// and a deleted one leaves a gap behind it.
const NON_UTF8_FORMULAS = Buffer.concat([
  Buffer.from("# caf", "latin1"),
  Buffer.from([0xe9]),
  Buffer.from(" (latin-1 comment)\r\nviews:\r\n  - type: table\r\n    name: AllTasks\r\n    limit: 25\r\nformulas:\r\n  a: 'x + 1'\r\n  b: 'y + 2'\r\nzzz_unknown: 1\r\n", "utf8"),
]);
const NON_UTF8_FORMULAS_NAME = "FormulasIllegal.base";
const NON_UTF8_FORMULAS_ABS = path.join(vault, NON_UTF8_FORMULAS_NAME);
// "Delete 2 lines, insert 2 lines": the total line count does not move, which is exactly why a
// count-based gate let it through (R4, bound f6da3c44).
const NET_ZERO_MUTATIONS = [
  { op: "set-formulas", key: "a", value: null },
  { op: "set-formulas", key: "b", value: null },
  { op: "set-formulas", key: "c", value: "1 + 1" },
  { op: "set-formulas", key: "d", value: "2 + 2" },
];
// `atomicWriteFile` is temp+rename, so a refusal that never reaches it must leave no temp behind.
const tmpFiles = async () => (await fs.readdir(vault)).filter((name) => name.includes(".obsidian-mcp-") && name.endsWith(".tmp"));

// ① — appending is a pure tail edit: the old last line is untouched, the separator is new bytes.
test("a non-UTF-8 document with no final newline accepts an append and keeps the old last line byte-for-byte", async () => {
  await fs.writeFile(TAIL_ILLEGAL_ABS, TAIL_ILLEGAL);
  const revision = (await structured("get_base", { path: TAIL_ILLEGAL_NAME })).revision;
  // ⑤ the gate must not change the token definition: still the raw-byte sha256, never the text's.
  assert.equal(revision, sha256(TAIL_ILLEGAL), "get_base.revision is over the raw bytes");
  assert.notEqual(revision, contentRevision(TAIL_ILLEGAL.toString("utf8")), "the two token inputs must differ here");
  assert.equal(TAIL_ILLEGAL.toString("utf8").includes("\uFFFD"), true, "the illegal byte decodes with replacement");
  assert.equal(TAIL_ILLEGAL.at(-1), 0xe9, "the fixture's last line must carry the illegal byte");
  assert.equal(TAIL_ILLEGAL.at(-1) === 0x0a, false, "the fixture must NOT end with a newline");

  const result = await structured("patch_base", { path: TAIL_ILLEGAL_NAME, ifMatch: revision, mutations: APPEND_FORMULA });
  assert.equal(result.changed, true, "an append with no final newline must be allowed");
  assert.equal(result.previousRevision, revision);
  const after = await fs.readFile(TAIL_ILLEGAL_ABS);
  // The old bytes are a prefix: the separator belongs to the first *inserted* line, not to the
  // line before it, so the line holding 0xE9 was never rewritten.
  assert.equal(after.subarray(0, TAIL_ILLEGAL.length).equals(TAIL_ILLEGAL), true, "every original byte must survive as a prefix");
  assert.equal(
    after.subarray(TAIL_ILLEGAL.length).toString("utf8"),
    "\r\nformulas:\r\n  flag: done",
    "only the new block may be appended (the document's own CRLF style, no invented final newline)",
  );
  assert.equal(after.indexOf(0xe9), TAIL_ILLEGAL.indexOf(0xe9), "the latin-1 byte is still 0xE9 at the same offset");
  assert.equal(after.indexOf(ILLEGAL), -1, "no U+FFFD may be introduced");
  assert.equal(result.revision, sha256(after));
  assert.equal((await structured("get_base", { path: TAIL_ILLEGAL_NAME })).revision, sha256(after));
});

// ③ — a middle insert and any delete have no lossless mapping: refused, bytes untouched.
test("a non-UTF-8 document refuses an insert in the middle and any delete", async () => {
  await fs.writeFile(NON_UTF8_FORMULAS_ABS, NON_UTF8_FORMULAS);
  const revision = (await structured("get_base", { path: NON_UTF8_FORMULAS_NAME })).revision;
  const insertMiddle = await patch({ path: NON_UTF8_FORMULAS_NAME, ifMatch: revision, mutations: [{ op: "set-formulas", key: "c", value: "a + b" }] });
  assert.equal(insertMiddle.isError, true, `an insert in the middle must be refused: ${insertMiddle.content?.[0]?.text}`);
  assert.equal(insertMiddle.structuredContent.code, "base-not-patchable");
  assert.match(insertMiddle.structuredContent.message, /write_base/, "the refusal must point at the whole-document tool");
  assert.equal((await fs.readFile(NON_UTF8_FORMULAS_ABS)).equals(NON_UTF8_FORMULAS), true, "a refused patch must not write");

  const removeMiddle = await patch({ path: NON_UTF8_FORMULAS_NAME, ifMatch: revision, mutations: [{ op: "set-formulas", key: "a", value: null }] });
  assert.equal(removeMiddle.isError, true, "a delete must be refused");
  assert.equal(removeMiddle.structuredContent.code, "base-not-patchable");
  assert.equal((await fs.readFile(NON_UTF8_FORMULAS_ABS)).equals(NON_UTF8_FORMULAS), true, "a refused delete must not write");
  assert.deepEqual(await tmpFiles(), []);
});

// ② — a net-zero structural edit keeps the count and is still refused by provenance.
test("a net-zero delete-2 / insert-2 patch on a non-UTF-8 document is refused by provenance", async () => {
  await fs.writeFile(NON_UTF8_FORMULAS_ABS, NON_UTF8_FORMULAS);
  const revision = (await structured("get_base", { path: NON_UTF8_FORMULAS_NAME })).revision;
  // The counterfactual: the patch really is net-zero in line count, so a count gate would pass it.
  const before = NON_UTF8_FORMULAS.toString("utf8");
  assert.equal(
    patchBaseDocument(before, NET_ZERO_MUTATIONS).split("\n").length,
    before.split("\n").length,
    "the edit must be net-zero in line count (otherwise this case proves nothing about the gate)",
  );
  const result = await patch({ path: NON_UTF8_FORMULAS_NAME, ifMatch: revision, mutations: NET_ZERO_MUTATIONS });
  assert.equal(result.isError, true, `a net-zero structural edit must be refused: ${result.content?.[0]?.text}`);
  assert.equal(result.structuredContent.code, "base-not-patchable");
  assert.match(result.structuredContent.message, /write_base/);
  assert.equal((await fs.readFile(NON_UTF8_FORMULAS_ABS)).equals(NON_UTF8_FORMULAS), true, "a refused patch must not write");
  assert.deepEqual(await tmpFiles(), [], "a refused patch must not leave a temp file");
});

// ② — the same document still accepts an in-place replacement, illegal byte included.
test("the same non-UTF-8 document still accepts an in-place replacement and keeps 0xE9", async () => {
  await fs.writeFile(TAIL_ILLEGAL_ABS, TAIL_ILLEGAL);
  const revision = (await structured("get_base", { path: TAIL_ILLEGAL_NAME })).revision;
  const result = await structured("patch_base", { path: TAIL_ILLEGAL_NAME, ifMatch: revision, mutations: IN_PLACE_LIMIT });
  assert.equal(result.changed, true);
  assert.equal(result.previousRevision, revision);
  const after = await fs.readFile(TAIL_ILLEGAL_ABS);
  assert.deepEqual(changedLineIndexes(TAIL_ILLEGAL, after), [3], "only the addressed line may change (and the line count must not)");
  assert.equal(after.length, TAIL_ILLEGAL.length, "the increment is the same width, so nothing shifted");
  assert.equal(after.at(-1), 0xe9, "the last line still ends with the illegal byte");
  assert.equal(after.indexOf(0xe9), TAIL_ILLEGAL.indexOf(0xe9));
  assert.equal(after.indexOf(ILLEGAL), -1, "no U+FFFD may be introduced");
  assert.equal(after.toString("utf8"), patchBaseDocument(TAIL_ILLEGAL.toString("utf8"), IN_PLACE_LIMIT));
  assert.equal(result.revision, sha256(after));
  assert.equal((await structured("get_base", { path: TAIL_ILLEGAL_NAME })).revision, sha256(after));
});

// ④ — a valid UTF-8 document keeps the full insert/delete/append surface, byte-identically.
test("a valid UTF-8 document still inserts, deletes and appends byte-identically to the text patch", async () => {
  const withFormulas = ["views:", "  - type: table", "    name: A", "    limit: 1", "formulas:", "  keep: done", "  drop: done"];
  const cases = [
    ["insert a key", Buffer.from(["views:", "  - type: table", "    name: A", "    limit: 1"].join("\n"), "utf8"), APPEND_FORMULA],
    ["append a block to a document with no final newline", Buffer.from(withFormulas.slice(0, 4).join("\n"), "utf8"), APPEND_FORMULA],
    ["delete a key", Buffer.from(`${withFormulas.join("\n")}\n`, "utf8"), [{ op: "set-formulas", key: "drop", value: null }]],
  ];
  for (const [label, bytes, mutations] of cases) {
    const { result, after } = await patchFixture("Utf8Structural.base", bytes, mutations);
    assert.equal(result.changed, true, `${label}: a valid UTF-8 document must stay patchable`);
    assert.equal(
      after.equals(Buffer.from(patchBaseDocument(bytes.toString("utf8"), mutations), "utf8")),
      true,
      `${label}: byte-identical to the text-level patch`,
    );
  }
  // The line count really did change in the first two cases (otherwise this proves nothing).
  assert.notEqual(patchBaseDocument(withFormulas.slice(0, 4).join("\n"), APPEND_FORMULA).split("\n").length, 4);
});

test("negative control: a whole-document re-encode loses the byte the refusal protects", async () => {
  // The mutant class the shipped assertions reject: rebuild from the decoded text. The whole-document
  // re-encode still loses the latin-1 byte on the fixture where the append is now allowed (①) and on
  // the in-place replacement; see PROBE-FIX-UTF8.log / PROBE-FIX-PROV.log.
  for (const mutations of [APPEND_FORMULA, IN_PLACE_LIMIT]) {
    const mutant = Buffer.from(patchBaseDocument(TAIL_ILLEGAL.toString("utf8"), mutations), "utf8");
    assert.equal(mutant.indexOf(ILLEGAL) >= 0, true, "the mutant introduces U+FFFD");
    assert.equal(mutant.indexOf(0xe9), -1, "the mutant loses the latin-1 byte");
    assert.equal(mutant.equals(TAIL_ILLEGAL), false);
  }
});

// ── 3. The CAS precondition ─────────────────────────────────────────────────

test("a missing precondition is refused as precondition-required (A4b 428 parity)", async () => {
  await reset();
  await expectRefusal({ path: BASE, mutations: [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 50 }] }, "precondition-required");
});

test("a stale precondition is refused as revision-conflict and the disk does not change", async () => {
  await reset();
  const stale = await currentRevision();
  // Another writer lands first: the token the caller holds is now stale.
  await fs.writeFile(ABSOLUTE, ORIGINAL.replace("limit: 25", "limit: 99"), "utf8");
  const moved = await read();
  const result = await patch({
    path: BASE,
    ifMatch: stale,
    mutations: [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 50 }],
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "revision-conflict");
  // `errStructured` keeps the frozen `{code, message}` shape, so the two revisions travel in
  // the message (the same prose the Web 409 body carries) instead of as extra fields.
  assert.match(result.structuredContent.message, new RegExp(stale));
  assert.match(result.structuredContent.message, /current sha256:[0-9a-f]{64}/);
  assert.equal(await read(), moved, "a conflicted patch must not write");
  await reset();
});

test("A4a's own refusals survive as structured codes and never write", async () => {
  await reset();
  const ifMatch = await currentRevision();
  // The view-key whitelist is part of the SERVED union, so an off-whitelist key is refused by
  // the protocol layer before A4a's `base-unknown-key` could be reached — the schema is the
  // narrower of the two gates, and the document is untouched either way.
  const offWhitelist = await patch({ path: BASE, ifMatch, mutations: [{ op: "set-view-option", view: "AllTasks", key: "base", value: 1 }] });
  assert.equal(offWhitelist.isError, true);
  assert.equal(await read(), ORIGINAL);
  // A4a's `base-not-patchable` IS reachable: a document the locator cannot address exactly
  // (3-space indentation under `views`) is refused instead of being re-serialised.
  const odd = ["views:", "   - type: table", "     name: AllTasks", ""].join("\n");
  await fs.writeFile(path.join(vault, "Odd.base"), odd, "utf8");
  const oddRevision = (await structured("get_base", { path: "Odd.base" })).revision;
  const notPatchable = await patch({ path: "Odd.base", ifMatch: oddRevision, mutations: [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 1 }] });
  assert.equal(notPatchable.isError, true);
  assert.equal(notPatchable.structuredContent.code, "base-not-patchable");
  assert.equal(await fs.readFile(path.join(vault, "Odd.base"), "utf8"), odd, "an unaddressable document must not be rewritten");
});

// ── 4. Concurrency: the CAS is the only way two callers can both lose ───────

test("two concurrent patches with the same precondition: at most one writes", async () => {
  await reset();
  const ifMatch = await currentRevision();
  const attempts = [
    { op: "set-view-option", view: "AllTasks", key: "limit", value: 50 },
    { op: "set-view-option", view: "Cards", key: "limit", value: 7 },
  ];
  // Both calls are launched before either is awaited. The in-process MCP transport may still
  // deliver them in order, in which case the loser is refused by the *pre-check* instead of by
  // the lock's re-read — both are the same CAS refusal, and the invariant under test is that
  // the document can never absorb both increments.
  const results = await Promise.all(attempts.map((mutation) => patch({ path: BASE, ifMatch, mutations: [mutation] })));
  const successes = results.filter((result) => result.isError !== true);
  const failures = results.filter((result) => result.isError === true);
  assert.ok(successes.length <= 1, `at most one writer may win: ${results.map((r) => r.content?.[0]?.text).join(" | ")}`);
  assert.equal(failures.length, 2 - successes.length);
  for (const failure of failures) assert.equal(failure.structuredContent.code, "revision-conflict");
  // Exactly one of the two increments is on disk — the loser wrote nothing of its own.
  const after = await read();
  // A4a inserts a *new* entry line with LF even in a CRLF document (its own contract,
  // covered by base-patch.test.js), so the applied-line probe splits on either ending.
  const applied = ["    limit: 50", "    limit: 7"].filter((line) => after.split(/\r?\n/).includes(line));
  assert.equal(applied.length, 1, `exactly one increment may land, got ${JSON.stringify(applied)}`);
  await reset();
});

// ── 5. The query-availability statement is evidence-based ───────────────────

test("an un-queryable patch result is reported through warnings, never silently claimed", async () => {
  await reset();
  const ifMatch = await currentRevision();
  // `if(c, a)` (2-argument) is outside the portable formula subset: A4a's write
  // whitelist accepts the increment, `query_base`'s compile step refuses the document.
  const result = await structured("patch_base", {
    path: BASE,
    ifMatch,
    mutations: [{ op: "set-formulas", key: "flag", value: "if(done, 1)" }],
  });
  assert.equal(result.changed, true);
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, "a non-queryable result must be warned about");
  assert.equal(result.warnings[0].code, "unsupported");
  // The claim is checkable against the real query tool.
  const queried = await call("query_base", { path: BASE });
  assert.equal(queried.isError, true, "query_base must indeed refuse the patched document");
  await reset();
});

// ── 6. Compact surface ──────────────────────────────────────────────────────

test("the compact mapping routes patch_base exactly once, in the write group", () => {
  assert.ok(COMPACT_GROUPS.obsidian_edit.includes("patch_base"));
  const members = Object.values(COMPACT_GROUPS).flat().filter((name) => name === "patch_base");
  assert.equal(members.length, 1, "a routed action must be unique");
  // The compact projection maps the virtual call back onto the native tool name, which is
  // what the HTTP Scope/Vault gate authorizes.
  assert.deepEqual(
    projectCompactCall("obsidian_edit_write_destructive_nonidempotent", { action: "patch_base", params: { path: BASE } }),
    { name: "patch_base", args: { path: BASE } },
  );
  // patch_base shares write_base's Scope + risk signature, so the group's descriptor set
  // is unchanged (no new descriptor, one more branch).
  const nativeTools = ["write_note", "write_base", "patch_base"].map((name) => ({ name, inputSchema: { type: "object" }, annotations: { destructiveHint: true, openWorldHint: false } }));
  const view = compactToolView(
    // compactToolView requires the full canonical list; a subset would throw by design.
    [...nativeTools, ...Object.values(COMPACT_GROUPS).flat().filter((name) => !nativeTools.some((tool) => tool.name === name)).map((name) => ({ name, inputSchema: { type: "object" }, annotations: {} }))],
    nativeTools.map((tool) => tool.name),
  );
  const descriptor = view.tools.find((tool) => tool.name.startsWith("obsidian_edit"));
  assert.ok(descriptor.inputSchema.properties.action.enum.includes("patch_base"));
  assert.equal(view.routing.get(descriptor.name).size, 3);
});

// ── 7. Negative controls (the mutants the assertions above must reject) ─────

test("negative control: an mtime-derived token would refuse a valid patch", async () => {
  await reset();
  const contentToken = await currentRevision();
  const before = await mtimeRevision();
  // Same bytes written again: only the metadata moves. A content token is stable here; an
  // mtime token would report a conflict for a caller that holds the current revision, i.e.
  // the two CAS tests above would be red for the wrong reason.
  await fs.writeFile(ABSOLUTE, ORIGINAL, "utf8");
  const after = await mtimeRevision();
  assert.notEqual(after, before, "the mutant token moved on an identical-bytes rewrite");
  assert.equal(await currentRevision(), contentToken, "the shipped token is content-derived");
  assert.equal(contentToken, contentRevision(ORIGINAL));
  // And a real byte change does move the shipped token.
  await fs.writeFile(ABSOLUTE, ORIGINAL.replace("limit: 25", "limit: 26"), "utf8");
  assert.notEqual(await currentRevision(), contentToken);
  await reset();
});

test("negative control: a yaml.dump rewrite loses the bytes this lane preserves", async () => {
  await reset();
  // The mutant is the `write_base` body: re-serialise the parsed document. Run against the
  // same fixture, every byte-preservation assertion from test 2 must fail.
  const dumped = yaml.dump(yaml.load(ORIGINAL), { noRefs: true, lineWidth: 120, sortKeys: false });
  assert.notEqual(dumped, ORIGINAL);
  assert.equal(dumped.includes("# Boards — header comment"), false, "comments are lost");
  // Unknown keys ARE part of the parsed mapping, so they survive `yaml.dump` — what does not
  // survive is their byte layout, which is exactly what test 2 asserts: the "exactly one line
  // differs" comparison must fail for the mutant.
  assert.equal(dumped.includes("unknownTopLevelKey: keep-me"), true);
  const dumpedLines = dumped.split("\n");
  const changedLines = ORIGINAL.split("\r\n").map((line, index) => (line === dumpedLines[index] ? null : index)).filter((index) => index !== null);
  assert.notEqual(changedLines.length, 1, "yaml.dump rewrites every line, so `changed === [6]` cannot hold");
  assert.equal(dumped.includes("\r\n"), false, "line endings are normalised");
  assert.equal(dumped.endsWith("\n"), true, "a final newline is added");
  // The original quoted scalar is re-serialised: the line as written does not survive.
  const originalQuotedLine = '    futureOption: "keep \"quoted\""';
  assert.equal(dumped.includes(originalQuotedLine), false, 'quote style is normalised');
});

test("negative control: the served schema must not accept an off-union mutation", async () => {
  await reset();
  const ifMatch = await currentRevision();
  const result = await patch({ path: BASE, ifMatch, mutations: [{ op: "set-view-option", view: "AllTasks", key: "limit", value: 50, extra: true }] });
  assert.equal(result.isError, true, "an extra field must not be accepted");
  assert.equal(await read(), ORIGINAL);
});
