// P1 (#630) — `create_base_entry`: create the note a Base view is looking for, and
// refuse to create one the view would not show.
//
// Desktop authority (`evidence/asar/obsidian_app.js`, offsets and the two divergences
// in the lane HANDOFF.md): the folder chain `newItemFolder` -> `newItemTemplate` parent
// -> filter-derived folder (`file.folder ==` / `file.inFolder()`) -> the `.base` file's
// own parent; the property defaults `wQ` reads off the view's readable filter rules and
// `order` keys; the CLI composes `folder + name` and defaults the name to "Untitled".
//
// What this suite locks:
//   1. the happy path end-to-end, INCLUDING the Issue #630 hard requirement — the new
//      note is returned by the very `query_base` call for that view;
//   2. an existing target is refused (`entry-exists`) and never overwritten;
//   3. properties that cannot satisfy the view's filters are refused
//      (`entry-not-queryable`) with nothing written (the chosen policy: REFUSE, see the
//      justification in HANDOFF.md — a written-but-invisible row is the defect);
//   4. traversal / absolute / outside-root / symlinked-parent targets are refused with
//      nothing written;
//   5. a read-only session refuses before any I/O (child process: `OBSIDIAN_READ_ONLY`
//      is read once at config import, so it cannot be toggled in-process);
//   6. two negative controls that prove 2 and 3 are not vacuous: the same plan written by
//      a mutant that skips the check produces exactly the outcome the check prevents;
//   7. the compact face: the routed action total grew by exactly one and the descriptors
//      still partition the canonical catalog.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-base-create-"));
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
process.env.OBSIDIAN_READ_ONLY = "false";
await fs.mkdir(data, { recursive: true });
await fs.mkdir(outside, { recursive: true });

const FIXTURES = {
  "Tasks/Existing.md": "---\nstatus: todo\n---\n# Existing\n",
  // The template lives INSIDE the filtered folder on purpose: desktop takes the new
  // item's folder from the template's parent, and an out-of-folder template would be
  // refused by the pre-check (which is exactly the divergence documented in HANDOFF).
  "Tasks/_template.md": "---\nstatus: todo\npriority: high\n---\n# Template body\n",
  "Boards/Tasks.base": [
    'filters: file.inFolder("Tasks")',
    "views:",
    "  - type: table",
    "    name: Board",
    "    filters: 'status == \"todo\"'",
    "    order:",
    "      - file.name",
    "      - status",
    "",
  ].join("\n"),
  "Boards/Template.base": [
    "newItemTemplate: Tasks/_template.md",
    'filters: file.inFolder("Tasks")',
    "views:",
    "  - type: table",
    "    name: Templated",
    "    filters: 'status == \"todo\"'",
    "",
  ].join("\n"),
  // Declared template that does not exist: desktop silently falls back to the
  // filter-derived defaults; this face reports `newitemtemplate-unresolved`.
  "Boards/MissingTemplate.base": [
    "newItemTemplate: Tasks/Gone.md",
    'filters: file.inFolder("Tasks")',
    "views:",
    "  - type: table",
    "    name: Board",
    "    filters: 'status == \"todo\"'",
    "",
  ].join("\n"),
  // An unknown view name must stay the Base domain's own `view-not-found` refusal.
  "Boards/Views.base": [
    'filters: file.inFolder("Tasks")',
    "views:",
    "  - type: table",
    "    name: Board",
    "    filters: 'status == \"todo\"'",
    "",
  ].join("\n"),
};
for (const [relative, content] of Object.entries(FIXTURES)) {
  const absolute = path.join(vault, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

const AUTHOR = { agent: "pi-lane", model: "gpt-5.6-sol-xhigh" };

const { withRequestContext } = await import("../src/request-context.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { COMPACT_GROUPS, compactToolView } = await import("../src/compact-tools.js");
const { checkCompactDescriptorIntegrity, compactDescriptorBranchTotal } = await import("../src/compact-descriptor-integrity.js");
const { hasDeclaredToolContract, completeToolAnnotations, outputSchemaForTool } = await import("../src/tool-contracts.js");
const { registerWorkflowTools } = await import("../src/tools/workflows.js");
await import("../src/vault-index.js");

let server;
let client;
let servedSchema;

before(async () => {
  server = new McpServer({ name: "base-create-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "base-create-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  servedSchema = (await client.listTools()).tools.find((tool) => tool.name === "create_base_entry")?.inputSchema;
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

// Every write goes through the same author context the production registrar installs.
const call = (name, args) => withRequestContext({ author: AUTHOR }, () => client.callTool({ name, arguments: args }));
const create = (args) => call("create_base_entry", args);
const readFileOrNone = async (absolute) => {
  try {
    return await fs.readFile(absolute, "utf8");
  } catch {
    return null;
  }
};
const fileExists = async (absolute) => (await readFileOrNone(absolute)) !== null;
const messageOf = (result) => result.content?.[0]?.text ?? "";
const codeOf = (result) => result.structuredContent?.code;

// ── 1. The happy path, end-to-end ───────────────────────────────────────────

test("create_base_entry creates the note the view wants, and query_base returns it", async () => {
  const created = await create({ path: "Boards/Tasks.base", view: "Board", file: "First" });
  assert.notEqual(created.isError, true, messageOf(created));
  const payload = created.structuredContent;
  assert.equal(payload.path, "Tasks/First.md", "the note lands in the folder the view's filters imply");
  assert.equal(payload.folderSource, "view-filters");
  assert.equal(payload.view, "Board");
  assert.equal(payload.created, true);
  assert.deepEqual(payload.warnings, [], "nothing was inconclusive");
  // The property defaults are the view's own readable rules + its `order` keys.
  assert.equal(payload.frontmatter.status, "todo");

  const onDisk = await readFileOrNone(path.join(vault, "Tasks/First.md"));
  assert.ok(onDisk, "the note must exist on disk");
  assert.match(onDisk, /status: todo/);

  // Issue #630 hard requirement: the same view query finds it.
  const queried = await call("query_base", { path: "Boards/Tasks.base", view: "Board" });
  assert.notEqual(queried.isError, true, messageOf(queried));
  const paths = queried.structuredContent.rows.map((row) => row.path);
  assert.ok(paths.includes("Tasks/First.md"), `query_base must return the new note, got ${paths.join(", ")}`);
});

test("the derived defaults come from the view's filters, and caller `values` override them", async () => {
  const created = await create({ path: "Boards/Tasks.base", view: "Board", file: "Second", values: { status: "todo", priority: "low" } });
  assert.notEqual(created.isError, true, messageOf(created));
  assert.deepEqual(created.structuredContent.frontmatter, { status: "todo", priority: "low" });
});

test("a declared newItemTemplate contributes its parent folder and its frontmatter", async () => {
  const created = await create({ path: "Boards/Template.base", view: "Templated" });
  assert.notEqual(created.isError, true, messageOf(created));
  const payload = created.structuredContent;
  // Desktop `open()`: no explicit file -> "Untitled", folder from the template's parent.
  assert.equal(payload.path, "Tasks/Untitled.md");
  assert.equal(payload.folderSource, "newItemTemplate.parent");
  // The template frontmatter REPLACES the filter-derived defaults (desktop `u||...`),
  // and the template's body is not copied.
  assert.deepEqual(Object.keys(payload.frontmatter).sort(), ["priority", "status"]);
  assert.equal(payload.frontmatter.priority, "high");
  const onDisk = await readFileOrNone(path.join(vault, "Tasks/Untitled.md"));
  assert.ok(onDisk);
  assert.doesNotMatch(onDisk, /Template body/);
});

test("a declared-but-missing template falls back to the derived defaults and says so", async () => {
  const created = await create({ path: "Boards/MissingTemplate.base", view: "Board", file: "Fallback" });
  assert.notEqual(created.isError, true, messageOf(created));
  assert.deepEqual(created.structuredContent.frontmatter, { status: "todo" });
  assert.deepEqual(created.structuredContent.warnings, ["newitemtemplate-unresolved"]);
});

test("`ifMatch` is an optional precondition on the .base revision", async () => {
  const base = await call("get_base", { path: "Boards/Tasks.base" });
  const revision = base.structuredContent.revision;
  const matched = await create({ path: "Boards/Tasks.base", view: "Board", file: "Pinned", ifMatch: revision });
  assert.notEqual(matched.isError, true, messageOf(matched));
  const stale = await create({ path: "Boards/Tasks.base", view: "Board", file: "Stale", ifMatch: "sha256:deadbeef" });
  assert.equal(stale.isError, true);
  assert.equal(codeOf(stale), "revision-conflict");
  assert.equal(await fileExists(path.join(vault, "Tasks/Stale.md")), false, "a refused call writes nothing");
});

test("an unknown view name keeps the Base domain's own refusal code", async () => {
  const result = await create({ path: "Boards/Views.base", view: "Nope", file: "Nope" });
  assert.equal(result.isError, true);
  assert.equal(codeOf(result), "view-not-found");
});

// ── 2. An existing target is refused, never overwritten ─────────────────────

test("an existing target is refused with `entry-exists` and keeps its bytes", async () => {
  const before = await readFileOrNone(path.join(vault, "Tasks/Existing.md"));
  const result = await create({ path: "Boards/Tasks.base", view: "Board", file: "Existing" });
  assert.equal(result.isError, true);
  assert.equal(codeOf(result), "entry-exists");
  assert.equal(await readFileOrNone(path.join(vault, "Tasks/Existing.md")), before, "the existing note must be byte-identical");
});

// ── 3. Unqueryable entries are refused before the write ─────────────────────

test("values that cannot satisfy the view's filters are refused with nothing written", async () => {
  const result = await create({ path: "Boards/Tasks.base", view: "Board", file: "Done one", values: { status: "done" } });
  assert.equal(result.isError, true);
  assert.equal(codeOf(result), "entry-not-queryable");
  assert.match(messageOf(result), /would not be found/);
  assert.equal(await fileExists(path.join(vault, "Tasks/Done one.md")), false, "the refusal must precede the write");
});

// ── 4. Illegal targets ──────────────────────────────────────────────────────

test("traversal, absolute and outside-root targets are refused with nothing written", async () => {
  const traversal = await create({ path: "Boards/Tasks.base", view: "Board", file: "../Escaped.md" });
  assert.equal(traversal.isError, true);
  assert.equal(codeOf(traversal), "entry-path-invalid");
  assert.equal(await fileExists(path.join(vault, "Escaped.md")), false);

  const absolute = await create({ path: "Boards/Tasks.base", view: "Board", file: "/tmp/Absolute.md" });
  assert.equal(absolute.isError, true);
  assert.equal(codeOf(absolute), "entry-path-invalid");

  const outsideRoot = await create({ path: "../../outside.base", view: "Board", file: "x" });
  assert.equal(outsideRoot.isError, true);
  assert.equal(await fileExists(path.join(outside, "x.md")), false);
});

test("a symlinked directory that escapes the vault is refused with nothing written", async (t) => {
  const link = path.join(vault, "Tasks", "link");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.diagnostic("symlink/junction creation is not permitted on this host — the escaping-parent case is unverified here");
    return;
  }
  const result = await create({ path: "Boards/Tasks.base", view: "Board", file: "link/Breakout.md" });
  assert.equal(result.isError, true, "an entry path whose real parent is outside the vault must be refused");
  assert.equal(await fileExists(path.join(outside, "Breakout.md")), false, "nothing may be written outside the vault");
});

// ── 5. Read-only session ────────────────────────────────────────────────────

test("a read-only session refuses before any I/O", () => {
  // `READ_ONLY` is read once at config import, so this runs in a child process.
  const script = `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    import fs from "node:fs";
    import path from "node:path";
    const { registerWorkflowTools } = await import("./src/tools/workflows.js");
    const server = new McpServer({ name: "readonly", version: "1" });
    registerWorkflowTools(server);
    const client = new Client({ name: "readonly", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const result = await client.callTool({ name: "create_base_entry", arguments: { path: "Boards/Tasks.base", view: "Board", file: "ReadOnly" } });
    process.stdout.write(JSON.stringify({
      isError: result.isError === true,
      message: result.content?.[0]?.text ?? "",
      wrote: fs.existsSync(path.join(process.env.VAULT_PATH, "Tasks", "ReadOnly.md")),
    }));
    await client.close();
    await server.close();
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      OBSIDIAN_READ_ONLY: "true",
      VAULT_PATH: vault,
      DATA_PATH: data,
      EMBEDDING_PROVIDER: "disabled",
      GIT_ENABLED: "false",
    },
    encoding: "utf8",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.isError, true, `a read-only session must refuse the write: ${parsed.message}`);
  assert.match(parsed.message, /read-only/i);
  assert.equal(parsed.wrote, false, "a read-only session writes nothing");
});

// ── 6. Negative controls ────────────────────────────────────────────────────

// The two controls below are the checks this tool exists for, inverted: instead of
// mutating the source, they reproduce the exact plan the tool builds and write it the
// way a tool WITHOUT the check would. If the assertions in 2/3 were vacuous, the mutant
// would produce the same outcome as the real call — it does not.

test("negative control: without the queryability pre-check, the row is invisible to the view", async () => {
  const { parseAndValidateBase, compileBaseView } = await import("../src/base-query.js");
  const { resolveEntryTarget, syntheticBaseRecord } = await import("../src/base-create.js");
  const raw = await fs.readFile(path.join(vault, "Boards/Tasks.base"), "utf8");
  const { base } = parseAndValidateBase(raw);
  const { view } = compileBaseView(base, "Board");
  const target = resolveEntryTarget({ base, view, baseFile: "Boards/Tasks.base", file: "Mutant.md" });
  const frontmatter = { status: "done" };
  // The mutant writer: same plan, no pre-check, straight to disk.
  await fs.writeFile(path.join(vault, target.path), `---\nstatus: done\n---\n`, "utf8");
  const record = syntheticBaseRecord({ path: target.path, frontmatter });
  assert.equal(record.path, "Tasks/Mutant.md", "the plan is the one the real call refuses");

  const queried = await call("query_base", { path: "Boards/Tasks.base", view: "Board" });
  const paths = queried.structuredContent.rows.map((row) => row.path);
  assert.equal(paths.includes("Tasks/Mutant.md"), false, "the written-but-unqueryable row is exactly why the pre-check refuses");
  // The real call for the same plan is the refusal under test in §3.
  const refused = await create({ path: "Boards/Tasks.base", view: "Board", file: "Mutant again", values: { status: "done" } });
  assert.equal(codeOf(refused), "entry-not-queryable");
});

test("negative control: without the existence check, an existing note is overwritten", async () => {
  const before = await readFileOrNone(path.join(vault, "Tasks/Second.md"));
  assert.ok(before, "the fixture written by the happy path must exist");
  // The mutant writer: no `exists()` check, so the runtime's atomic write replaces it.
  await fs.writeFile(path.join(vault, "Tasks/Second.md"), "---\nstatus: gone\n---\n", "utf8");
  const after_ = await readFileOrNone(path.join(vault, "Tasks/Second.md"));
  assert.notEqual(after_, before, "a writer without the check DOES clobber — so the `entry-exists` assertion in §2 is not vacuous");
  await fs.writeFile(path.join(vault, "Tasks/Second.md"), before, "utf8");
});

// ── 7. Registration and the compact face ────────────────────────────────────

test("create_base_entry is registered as a strict, non-destructive tool with an output contract", async () => {
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "create_base_entry");
  assert.ok(tool, "create_base_entry must be registered");
  assert.deepEqual(Object.keys(servedSchema.properties).sort(), ["file", "ifMatch", "path", "values", "view"]);
  assert.deepEqual(servedSchema.required, ["path"], "only `path` is required");
  assert.equal(servedSchema.properties.values.type, "object", "`values` is a property map");
  assert.deepEqual(tool.annotations, { destructiveHint: false, openWorldHint: false }, "the raw declaration: not read-only, not destructive");
  assert.deepEqual(completeToolAnnotations(tool.annotations), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(hasDeclaredToolContract("create_base_entry"), true);
  const schema = outputSchemaForTool("create_base_entry");
  assert.equal(schema.safeParse({ path: "a.md", basePath: "b.base", view: "v", folderSource: "view-filters", created: true, size: 1, revision: "sha256:x" }).success, true);
  assert.equal(schema.safeParse({ path: "a.md" }).success, false, "the output contract is enforced");
});

test("the compact face routes exactly one more action and still partitions the catalog", async () => {
  // The compact mapping partitions the WHOLE canonical catalog, so the native list
  // comes from the production registration (not this file's workflows-only server).
  const { registerObsidianCapabilities } = await import("../src/capabilities.js");
  const full = new McpServer({ name: "base-create-native", version: "1" });
  registerObsidianCapabilities(full);
  const nativeClient = new Client({ name: "base-create-native-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await full.connect(st);
  await nativeClient.connect(ct);
  let nativeTools;
  try {
    nativeTools = JSON.parse(JSON.stringify((await nativeClient.listTools()).tools));
  } finally {
    await nativeClient.close();
    await full.close();
  }
  assert.equal(nativeTools.length, TOOL_NAMES.length);
  const { tools: compact, routing } = compactToolView(nativeTools, TOOL_NAMES);
  // The +1 this lane adds: 89 -> 90 routed actions, every canonical name exactly once.
  assert.equal(compactDescriptorBranchTotal(compact), TOOL_NAMES.length);
  assert.equal(TOOL_NAMES.length, 90);
  // `routing` is keyed by DESCRIPTOR name, so the membership check is the Set that
  // carries the action.
  const owner = [...routing.entries()].find(([, members]) => members.has("create_base_entry"));
  assert.ok(owner, "the new action must be routed under a compact descriptor");
  const ownerTool = compact.find((tool) => tool.name === owner[0]);
  assert.ok(
    ownerTool.inputSchema.oneOf.some((branch) => branch.properties.action.const === "create_base_entry"),
    "the action must appear as a oneOf branch on its descriptor",
  );
  assert.equal(COMPACT_GROUPS.obsidian_edit.includes("create_base_entry"), true, "it belongs to the compact write group");
  const reading = checkCompactDescriptorIntegrity({ tools: compact, routing });
  assert.equal(reading.ok, true, reading.errors.join("\n"));
  assert.equal(reading.exposedTotal, TOOL_NAMES.length);
});
