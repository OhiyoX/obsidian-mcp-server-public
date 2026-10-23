// A2 — `list_base_views`: the agent-facing view selector for Obsidian Bases.
//
// Contract under test (desktop authority: `base:views` @3242395, see
// MCP-AGENT-SURFACE-GAP.md §2.1/§2.2 and app/src/base-view-summaries.js):
//   * the tool returns view SUMMARIES only — never the YAML body (`raw`/`base`)
//     and never row data;
//   * an empty / missing `views:` key is an explicit empty result, not an error;
//   * a missing Base, a non-`.base` path, an out-of-root path and a symlink that
//     escapes the Vault are STRUCTURED errors (`{code, message}` via
//     `errStructured`, A6 shape) and never a 500, and they never echo an
//     absolute path;
//   * the served input schema is a single strict branch (`path`, plus the
//     canonical `vaultId` the registrar injects) — no permissive `any` input.
//
// The negative controls at the bottom run the *same* assertions against a local
// mutant that returns the full YAML: they must fail there (and a real source
// mutation turns the corresponding assertions red — raw runs in HANDOFF.md).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  BASE_VIEWS_ERROR_CODES,
  BASE_VIEW_PASSTHROUGH_FIELDS,
  BASE_VIEW_SUMMARY_FIELDS,
  BaseViewsError,
  mapBaseViewsError,
  normalizeBaseInputPath,
  summarizeBaseViews,
} from "../src/base-view-summaries.js";
import { completeToolAnnotations, hasDeclaredToolContract, outputSchemaForTool } from "../src/tool-contracts.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-list-base-views-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
const outside = path.join(root, "outside");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
await fs.mkdir(data, { recursive: true });
await fs.mkdir(outside, { recursive: true });

// `Boards.base` is deliberately padded: the negative control asserts that the
// summary payload stays far below the document size, so a "return the whole YAML"
// mutant is measurable rather than a matter of taste.
const BIG_BODY = Array.from({ length: 120 }, (_, index) => `  # padding line ${index} ${"x".repeat(80)}`).join("\n");

const FIXTURES = {
  "Boards.base": [
    "# Boards — view selector fixture",
    'filters: file.inFolder("Tasks")',
    "formulas:",
    "  due: 'if(due, due, \"\")'",
    BIG_BODY,
    "views:",
    "  - type: table",
    "    name: AllTasks",
    "    limit: 25",
    "    filters:",
    "      and:",
    '        - status != "done"',
    "    sort:",
    "      - property: due",
    "        direction: ASC",
    "    order:",
    "      - file.name",
    "      - status",
    "  - type: cards",
    '    name: "Cards (mine)"',
    "    groupBy:",
    "      property: status",
    "    summaries:",
    "      score: Sum",
    "  - type: list",
    "    name: PlainList",
    "",
  ].join("\n"),
  // Empty view array: an explicit, successful empty result.
  "Empty.base": ["views: []", ""].join("\n"),
  // No `views:` key at all: same explicit empty result.
  "NoViews.base": ['filters: file.inFolder("Tasks")', ""].join("\n"),
  // Schema-invalid (a Base domain error, not an A2 error) — A6 codes must survive.
  "MissingName.base": ["views:", "  - type: table", ""].join("\n"),
  // Not a `.base` document at all.
  "Notes.md": "# Notes\n",
};

for (const [relative, content] of Object.entries(FIXTURES)) {
  const absolute = path.join(vault, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}
// A real symlink whose target escapes the Vault root, plus a directory link
// (a Windows junction, which needs no elevation). Only if the platform refuses
// both does the end-to-end assertion skip (the code path is still covered by the
// mapper unit test below); the skip is reported in the test diagnostic.
await fs.writeFile(path.join(outside, "Boards.base"), FIXTURES["Boards.base"], "utf8");
const escaping = [];
try {
  await fs.symlink(path.join(outside, "Boards.base"), path.join(vault, "Escaping.base"));
  escaping.push("Escaping.base");
} catch { /* file symlinks need privileges on Windows */ }
try {
  await fs.symlink(outside, path.join(vault, "escape"), process.platform === "win32" ? "junction" : "dir");
  escaping.push("escape/Boards.base");
} catch { /* no symlink support at all */ }

const VIEWS_PAYLOAD_SIZE_LIMIT = 2048;

const { registerWorkflowTools } = await import("../src/tools/workflows.js");
await import("../src/vault-index.js");

let server;
let client;
let servedSchema;

before(async () => {
  server = new McpServer({ name: "list-base-views-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "list-base-views-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  servedSchema = (await client.listTools()).tools.find((tool) => tool.name === "list_base_views")?.inputSchema;
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function listViews(arguments_) {
  return client.callTool({ name: "list_base_views", arguments: arguments_ });
}

async function payload(arguments_) {
  const result = await listViews(arguments_);
  assert.notEqual(result.isError, true, `list_base_views must not fail: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

// The single place that encodes "the summary payload is not the document".
// Both the positive test and the negative control call it, so a mutant that
// widens the payload fails the same assertions the shipped code passes.
function assertSummaryOnly(structure, rawLength) {
  for (const forbidden of ["raw", "base", "content", "rows", "formulas"]) {
    assert.equal(forbidden in structure, false, `the payload must not carry \`${forbidden}\``);
  }
  for (const view of structure.views) {
    assert.ok(
      Object.keys(view).every((key) => BASE_VIEW_SUMMARY_FIELDS.includes(key)),
      `view summary carries an undeclared field: ${Object.keys(view).join(",")}`,
    );
  }
  const bytes = JSON.stringify(structure).length;
  assert.ok(bytes <= VIEWS_PAYLOAD_SIZE_LIMIT, `summary payload must stay small, got ${bytes} bytes`);
  assert.ok(bytes < rawLength / 4, `summary payload (${bytes}B) must be far below the document (${rawLength}B)`);
  assert.deepEqual(Object.keys(structure).sort(), ["defaultView", "path", "views"]);
}

// ── 1. Registration and input schema ────────────────────────────────────────

test("list_base_views is registered as a strict, read-only tool", async () => {
  const listed = (await client.listTools()).tools;
  const tool = listed.find((entry) => entry.name === "list_base_views");
  assert.ok(tool, "list_base_views must be registered");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  // The descriptor completion (destructiveHint/idempotentHint) is applied by the
  // production registrar; assert it through the shared helper instead of the raw
  // in-memory registration used here.
  assert.deepEqual(completeToolAnnotations(tool.annotations), { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  // A2 declares a real output contract (the catalog test asserts this for every tool).
  assert.equal(hasDeclaredToolContract("list_base_views"), true);
  const schema = outputSchemaForTool("list_base_views");
  assert.equal(schema.safeParse({ path: "Boards.base", views: [], defaultView: null }).success, true);
  assert.equal(schema.safeParse({ path: "Boards.base", views: [{}], defaultView: "A" }).success, true);
  assert.equal(schema.safeParse({ views: [], defaultView: null }).success, false, "path is required");
});

test("the served input schema is one strict branch: `path` only, no catch-all `any` input", () => {
  assert.ok(servedSchema, "the served input schema must be observable");
  assert.deepEqual(Object.keys(servedSchema.properties).sort(), ["path"], "path is the only A2 input");
  assert.deepEqual(servedSchema.required, ["path"]);
  for (const property of Object.values(servedSchema.properties)) {
    assert.equal(typeof property.type, "string", "every input branch declares a concrete scalar type");
    assert.equal(property.additionalProperties, undefined);
  }
  assert.equal(servedSchema.properties.path.minLength, 1);
  // A union-shaped schema (the desktop `base:query` file:/path:/view: family) is
  // NOT advertised: A2 keeps the sibling `get_base`/`query_base` single-path input.
  assert.equal(servedSchema.anyOf, undefined);
  assert.equal(servedSchema.oneOf, undefined);
});

test("a refused input shape is rejected by the protocol layer instead of reaching the handler", async () => {
  const result = await client.callTool({ name: "list_base_views", arguments: { path: "" } }).catch((error) => ({ threw: error }));
  if (result.threw) {
    assert.match(String(result.threw.message), /validation|path/i);
    return;
  }
  assert.equal(result.isError, true, "an empty path must not be accepted");
});

// ── 2. Pure summarizer contract ─────────────────────────────────────────────

test("normalizeBaseInputPath appends .base, keeps a dotted Base name, and fails closed on another document kind", () => {
  assert.equal(normalizeBaseInputPath("Boards"), "Boards.base");
  assert.equal(normalizeBaseInputPath("Boards.base"), "Boards.base");
  assert.equal(normalizeBaseInputPath("Nested/Boards.BASE"), "Nested/Boards.BASE");
  assert.equal(normalizeBaseInputPath("My.Board"), "My.Board.base");
  for (const bad of ["Notes.md", "Board.canvas", "data.json", "raw.yaml", ""]) {
    assert.throws(() => normalizeBaseInputPath(bad), (error) => {
      assert.ok(error instanceof BaseViewsError);
      assert.equal(error.code, BASE_VIEWS_ERROR_CODES.NOT_A_BASE);
      return true;
    }, `${bad} must be refused`);
  }
});

test("summarizeBaseViews emits only the frozen field vocabulary and copies declared values verbatim", () => {
  const base = {
    views: [
      { type: "table", name: "One", limit: 5, sort: [{ property: "due", direction: "DESC" }], order: ["file.name"], filters: { and: ['status == "x"'] } },
      { type: "cards", name: "Two", groupBy: { property: "status" }, summaries: { score: "Sum" } },
      { type: "list", name: "Three", filters: [], sort: [], groupBy: {}, summaries: {}, limit: undefined },
    ],
  };
  const summary = summarizeBaseViews(base);
  assert.equal(summary.defaultView, "One");
  assert.deepEqual(summary.views.map((view) => view.isDefault), [true, false, false]);
  assert.deepEqual(summary.views[0], {
    name: "One",
    type: "table",
    filters: { and: ['status == "x"'] },
    sort: [{ property: "due", direction: "DESC" }],
    limit: 5,
    isDefault: true,
  });
  assert.deepEqual(summary.views[1], {
    name: "Two",
    type: "cards",
    groupBy: { property: "status" },
    summaries: { score: "Sum" },
    isDefault: false,
  });
  // Empty declarations are absent, not `[]`/`{}` (the base-query.js declaration freeze).
  assert.deepEqual(summary.views[2], { name: "Three", type: "list", isDefault: false });
  for (const view of summary.views) {
    for (const field of BASE_VIEW_PASSTHROUGH_FIELDS) {
      if (field in view) assert.ok(!(Array.isArray(view[field]) && view[field].length === 0));
    }
  }
  // The summary must not alias the parsed document.
  base.views[0].limit = 99;
  assert.equal(summary.views[0].limit, 5);
});

test("summarizeBaseViews reports an empty / missing views key as an explicit empty result", () => {
  for (const base of [{}, { views: [] }, { views: undefined }, { filters: "file.inFolder(\"X\")" }]) {
    assert.deepEqual(summarizeBaseViews(base), { views: [], defaultView: null });
  }
});

// ── 3. Tool behaviour ───────────────────────────────────────────────────────

test("list_base_views returns the view summaries for a real Base (list/cards/table, filters, sort, limit, groupBy, summaries)", async () => {
  const structure = await payload({ path: "Boards.base" });
  assert.equal(structure.path, "Boards.base");
  assert.equal(structure.defaultView, "AllTasks");
  assert.deepEqual(structure.views, [
    {
      name: "AllTasks",
      type: "table",
      filters: { and: ['status != "done"'] },
      sort: [{ property: "due", direction: "ASC" }],
      limit: 25,
      isDefault: true,
    },
    { name: "Cards (mine)", type: "cards", groupBy: { property: "status" }, summaries: { score: "Sum" }, isDefault: false },
    { name: "PlainList", type: "list", isDefault: false },
  ]);
  const raw = await fs.readFile(path.join(vault, "Boards.base"), "utf8");
  assertSummaryOnly(structure, raw.length);
  // The `order` key (declared by the fixture) is deliberately not part of the A2
  // vocabulary, and the top-level document (formulas, comments) never appears.
  assert.equal("order" in structure.views[0], false);
  assert.equal(JSON.stringify(structure).includes("padding line"), false);
});

test("the same summaries are reachable through the bare-name form as through the .base path", async () => {
  assert.deepEqual(await payload({ path: "Boards" }), await payload({ path: "Boards.base" }));
});

test("an empty view list and a missing views key are both successful empty results", async () => {
  for (const base of ["Empty.base", "NoViews.base"]) {
    const structure = await payload({ path: base });
    assert.deepEqual(structure, { path: base, views: [], defaultView: null });
  }
});

// ── 4. Structured errors (A6 shape, never a 500) ────────────────────────────

async function errorPayload(arguments_) {
  const result = await listViews(arguments_);
  assert.equal(result.isError, true, `expected an error result, got ${JSON.stringify(result.structuredContent)}`);
  assert.equal(typeof result.structuredContent?.code, "string");
  assert.ok(result.structuredContent.message.length > 0);
  assert.match(result.content[0].text, /^Error: /);
  assert.equal(JSON.stringify(result).includes(root), false, "no absolute path may leak");
  return result.structuredContent;
}

test("a missing Base is a structured base-not-found error", async () => {
  const payload_ = await errorPayload({ path: "Does/Not/Exist.base" });
  assert.equal(payload_.code, BASE_VIEWS_ERROR_CODES.NOT_FOUND);
  assert.match(payload_.message, /Does\/Not\/Exist\.base/);
});

test("a non-.base path is a structured not-a-base error and reads nothing", async () => {
  for (const bad of ["Notes.md", "Board.canvas"]) {
    const payload_ = await errorPayload({ path: bad });
    assert.equal(payload_.code, BASE_VIEWS_ERROR_CODES.NOT_A_BASE);
  }
  // The empty string never reaches the handler: the protocol layer rejects it
  // (z.string().min(1)) — see the schema test above.
});

test("an out-of-root path is a structured path-outside-vault error", async () => {
  // `local-fs.js` strips a leading POSIX slash by design, so a `/etc/...` input is a
  // *vault-relative* path (follows the pinned runtime semantics, asserted separately).
  for (const traversal of ["../outside/Boards.base", "../Boards.base", "D:/outside/Boards.base", "//server/share/Boards.base"]) {
    const payload_ = await errorPayload({ path: traversal });
    assert.equal(payload_.code, BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT, `${traversal} must be refused structurally`);
  }
  const posixAbsolute = await errorPayload({ path: "/etc/passwd.base" });
  assert.equal(posixAbsolute.code, BASE_VIEWS_ERROR_CODES.NOT_FOUND, "a leading slash is stripped (vault-relative by design)");
});

test("a symlink that escapes the Vault root is refused", async (t) => {
  if (escaping.length === 0) {
    t.diagnostic("symlink creation is not permitted on this platform/user; the code path stays covered by the mapper unit test");
    return;
  }
  for (const link of escaping) {
    const payload_ = await errorPayload({ path: link });
    assert.equal(payload_.code, BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT, `${link} must be refused`);
  }
});

test("a Base domain failure keeps its own BaseQueryError code (A6 vocabulary survives)", async () => {
  const payload_ = await errorPayload({ path: "MissingName.base" });
  assert.equal(payload_.code, "invalid-schema");
  assert.match(payload_.message, /views\[0\]\.name/);
});

test("the error mapper re-codes only what this lane owns", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'D:\\\\vault\\\\X.base'"), { code: "ENOENT" });
  const mapped = mapBaseViewsError(enoent, { path: "X.base" });
  assert.equal(mapped.code, BASE_VIEWS_ERROR_CODES.NOT_FOUND);
  assert.equal(mapped.message, "Base not found: X.base");
  assert.equal(mapped.message.includes("D:\\"), false);

  const traversal = mapBaseViewsError(new Error("Path traversal denied"), { path: "../x.base" });
  assert.equal(traversal.code, BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT);

  const symlink = mapBaseViewsError(new Error("Symbolic link escapes the vault"), { path: "x.base" });
  assert.equal(symlink.code, BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT);

  const absolute = mapBaseViewsError(new Error('Vault paths are vault-relative; Windows absolute and UNC paths are not accepted: "D:/x"'), { path: "D:/x" });
  assert.equal(absolute.code, BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT);

  const domain = Object.assign(new Error("Unsupported Base key: views[].groupBy"), { code: "unsupported" });
  assert.equal(mapBaseViewsError(domain), domain, "a BaseQueryError must pass through untouched");
});

// ── 5. Negative controls ────────────────────────────────────────────────────

test("negative control: the summary-only assertions really reject a full-YAML payload", async () => {
  const raw = await fs.readFile(path.join(vault, "Boards.base"), "utf8");
  const parsed = { filters: 'file.inFolder("Tasks")', views: [{ type: "table", name: "AllTasks" }] };
  const mutant = { path: "Boards.base", views: [{ name: "AllTasks", type: "table", isDefault: true }], defaultView: "AllTasks", raw, base: parsed };
  assert.throws(() => assertSummaryOnly(mutant, raw.length), /must not carry `raw`/, "a full-YAML mutant must fail the key assertion");

  const oversized = { path: "Boards.base", views: [{ name: "AllTasks", type: "table", isDefault: true, summaries: { blob: "y".repeat(4096) } }], defaultView: "AllTasks" };
  assert.throws(() => assertSummaryOnly(oversized, raw.length), /payload must stay small/, "an oversized payload must fail the size bound");

  const widened = { path: "Boards.base", views: [{ name: "A", type: "table", isDefault: true, order: ["file.name"] }], defaultView: "A" };
  assert.throws(() => assertSummaryOnly(widened, raw.length), /undeclared field/, "an out-of-vocabulary field must fail");

  // The shipped payload passes the very same assertions (proving they are not vacuous).
  const shipped = await payload({ path: "Boards.base" });
  assertSummaryOnly(shipped, raw.length);
});
