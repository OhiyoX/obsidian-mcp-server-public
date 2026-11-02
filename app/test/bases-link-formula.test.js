import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-bases-formula-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(data, { recursive: true });

async function write(relative, content) {
  const abs = path.join(vault, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

function note(frontmatter, body = "") {
  const keys = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${keys}\n---\n${body}`;
}

// --- Synthetic Maps fixtures (minimal, no live user content) -----------------

// Knowledge uses file.asLink(if(title, title, file.name))
await write("_Workspace/30-Knowledge/Alpha.md", note({ title: "Alpha Title", type: "knowledge", status: "active", updated: "2026-09-01" }, "# Alpha\n"));
await write("_Workspace/30-Knowledge/Beta.md", note({ type: "knowledge", status: "active", updated: "2026-09-02" }, "# Beta\n"));
await write("_Workspace/30-Knowledge/Gamma.md", note({ title: '""', type: "knowledge", status: "active", updated: "2026-09-03" }, "# Gamma\n"));
await write("_Workspace/30-Knowledge/Whitespace.md", note({ title: '"   "', type: "knowledge", status: "active", updated: "2026-09-04" }, "# Whitespace\n"));
await write("_Workspace/30-Knowledge/Numeric.md", note({ title: "2026", type: "knowledge", status: "active", updated: "2026-09-05" }, "# Numeric\n"));
await write("_Workspace/30-Knowledge/Flagged.md", note({ title: "true", type: "knowledge", status: "active", updated: "2026-09-06" }, "# Flagged\n"));
await write("_Workspace/30-Knowledge/Listed.md", note({ title: '["One", "Two"]', type: "knowledge", status: "active", updated: "2026-09-07" }, "# Listed\n"));
await write("_Workspace/30-Knowledge/Map.md", note({ title: '{"nested": true}', type: "knowledge", status: "active", updated: "2026-09-08" }, "# Map\n"));
await write("_Workspace/30-Knowledge/Blank.md", note({ type: "knowledge", status: "active", updated: "2026-09-09" }, "# Blank\n"));

// Skills uses file.asLink(if(name, name, file.name))
await write("_Workspace/60-Skills/SKILL.md", note({ name: "Skill Display" }, "# SKILL\n"));
await write("_Workspace/60-Skills/Desktop/One.md", note({ name: "Desktop Skill", type: "skill" }, "# One\n"));
await write("_Workspace/60-Skills/Desktop/NoName.md", note({ type: "skill" }, "# NoName\n"));
await write("_Workspace/60-Skills/Other.md", note({ type: "note" }, "# Other\n"));

// Projects: Project.base has no formulas, only filters/sort.
await write("_Workspace/40-Projects/README.md", note({ type: "project" }, "# Projects\n"));
await write("_Workspace/40-Projects/obsidian_mcp_server/TODO - A.md", note({ status: "active", priority: "P1", updated: "2026-09-10" }, "# A\n"));
await write("_Workspace/40-Projects/obsidian_mcp_server/TODO - B.md", note({ status: "deferred", priority: "P2", updated: "2026-09-11" }, "# B\n"));
await write("_Workspace/40-Projects/obsidian_mcp_server/DONE - TODO - C.md", note({ status: "done", priority: "P1", updated: "2026-09-12" }, "# C\n"));
await write("_Workspace/40-Projects/obsidian_mcp_server/TODO - D.md", note({ status: "active", priority: "P1", updated: "2026-09-20" }, "# D\n"));
await write("_Workspace/40-Projects/obsidian_mcp_server/TODO - E.md", note({ status: "active", priority: "P2", updated: "2026-09-15" }, "# E\n"));
await write("_Workspace/40-Projects/obsidian_mcp_server/TODO - F.md", note({ status: "active", priority: "P3", updated: "2026-09-01" }, "# F\n"));

// Nested-if: file.asLink(if(title, title, if(name, name, file.name)))
await write("_Workspace/70-Nested/HasTitle.md", note({ title: "Title Wins" }, "# HasTitle\n"));
await write("_Workspace/70-Nested/HasName.md", note({ name: "Name Wins" }, "# HasName\n"));
await write("_Workspace/70-Nested/EmptyTitle.md", note({ title: '""', name: "Name From Empty Title" }, "# EmptyTitle\n"));
await write("_Workspace/70-Nested/Fallback.md", note({ type: "nested" }, "# Fallback\n"));

// Exact spellings from the read-only Vault snapshots.
await write("Knowledge.base", [
  "filters:",
  "  and:",
  '    - file.inFolder("_Workspace/30-Knowledge")',
  '    - file.ext == "md"',
  "formulas:",
  "  note: file.asLink(if(title, title, file.name))",
  "properties:",
  "  formula.note:",
  "    displayName: Note",
  "views:",
  "  - type: table",
  "    name: Knowledge",
  "    order:",
  "      - formula.note",
  "      - type",
  "      - status",
  "    sort:",
  "      - property: updated",
  "        direction: DESC",
  "",
].join("\n"));

await write("Skills.base", [
  "filters:",
  "  and:",
  '    - file.inFolder("_Workspace/60-Skills")',
  "    - or:",
  '        - file.name == "SKILL"',
  "        - and:",
  '            - file.inFolder("_Workspace/60-Skills/Desktop")',
  '            - note.type == "skill"',
  "formulas:",
  "  note: file.asLink(if(name, name, file.name))",
  "properties:",
  "  formula.note:",
  "    displayName: Note",
  "views:",
  "  - type: table",
  "    name: Skills",
  "    order:",
  "      - formula.note",
  "      - type",
  "",
].join("\n"));

await write("Project.base", [
  "filters:",
  "  and:",
  '    - file.inFolder("_Workspace/40-Projects/obsidian_mcp_server")',
  '    - file.ext == "md"',
  "views:",
  "  - type: table",
  "    name: 进行中",
  "    filters:",
  "      and:",
  '        - file.name.startsWith("TODO - ")',
  '        - status != "deferred"',
  "    order:",
  "      - file.name",
  "      - priority",
  "      - status",
  "      - updated",
  "    sort:",
  "      - property: priority",
  "        direction: ASC",
  "      - property: updated",
  "        direction: DESC",
  "  - type: table",
  "    name: 暂缓",
  "    filters:",
  "      and:",
  '        - file.name.startsWith("TODO - ")',
  '        - status == "deferred"',
  "    order:",
  "      - file.name",
  "      - priority",
  "      - status",
  "      - updated",
  "  - type: table",
  "    name: 已完成",
  '    filters: file.name.startsWith("DONE - TODO - ")',
  "    order:",
  "      - file.name",
  "      - priority",
  "      - status",
  "      - updated",
  "    sort:",
  "      - property: updated",
  "        direction: DESC",
  "",
].join("\n"));

await write("Nested.base", [
  'filters: file.inFolder("_Workspace/70-Nested")',
  "formulas:",
  "  note: file.asLink(if(title, title, if(name, name, file.name)))",
  "properties:",
  "  formula.note:",
  "    displayName: Note",
  "views:",
  "  - type: table",
  "    name: Nested",
  "    order:",
  "      - formula.note",
  "",
].join("\n"));

// --- Negative / validation fixtures -----------------------------------------

await write("Bad/UnsupportedFileProp.base", "formulas:\n  note: file.asLink(file.path)\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/UnknownMethod.base", "formulas:\n  note: file.asLink2(title)\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/UnknownFunction.base", "formulas:\n  note: file.asLink(sum(title, name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
// formula.<name> references are out of scope: reject in used, dead-branch, unused and empty-result formulas.
await write("Bad/FormulaRef.base", "formulas:\n  note: file.asLink(if(formula.other, formula.other, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/FormulaRefDeadBranch.base", "formulas:\n  note: file.asLink(if(title, file.name, formula.other))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/FormulaRefUnused.base", "formulas:\n  unused: file.asLink(formula.other)\nviews:\n  - type: table\n    name: Bad\n    order: [file.name]\n");
await write("Bad/FormulaRefEmpty.base", "filters: file.inFolder(\"_Workspace/NoSuchFolder\")\nformulas:\n  note: file.asLink(if(title, title, formula.other))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
// INT-B: a DECLARED `formula.<name>` dependency is supported (positive fixture).
await write("FormulaRef.base", "formulas:\n  other: file.asLink(title)\n  note: file.asLink(if(formula.other, formula.other, file.name))\nviews:\n  - type: table\n    name: FormulaRef\n    order: [formula.note]\n");
// INT-C flip (review-verdict-INT-C-GO.md §3): `formula.*` in view.filters / view.sort
// is wired (typed values). The positive sort fixture sorts on `file.asLink(file.name)`
// so the raw values are all strings (no list/object record to trip the fail-closed rule).
await write("FilterFormulaPos.base", 'filters: formula.note == "Alpha Title"\nformulas:\n  note: file.asLink(if(title, title, file.name))\nviews:\n  - type: table\n    name: FilterFormulaPos\n    order: [formula.note]\n');
await write("SortFormulaPos.base", 'filters: file.inFolder("_Workspace/30-Knowledge")\nformulas:\n  label: file.asLink(file.name)\nviews:\n  - type: table\n    name: SortFormulaPos\n    order: [formula.label]\n    sort:\n      - property: formula.label\n        direction: ASC\n');
// INT-A flip (review-verdict-P0-FLIP.md): `note.<prop>` and the literal engine
// are supported now, so these three fixtures are covered by the positive case
// below instead of this fail-closed table.
await write("Bad/NoteNamespace.base", "formulas:\n  note: file.asLink(if(note.title, note.title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/TrueLiteral.base", "formulas:\n  note: file.asLink(if(true, title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/NullLiteral.base", "formulas:\n  note: file.asLink(if(title, title, null))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/Syntax.base", "formulas:\n  note: 'file.asLink(if(title, title))'\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/DeadBranch.base", "formulas:\n  note: file.asLink(if(title, file.name, file.unknown))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/UnusedInvalid.base", "formulas:\n  unused: file.asLink(file.path)\nviews:\n  - type: table\n    name: Bad\n    order: [file.name]\n");
await write("Bad/SortFormula.base", "filters: file.inFolder(\"_Workspace/30-Knowledge\")\nformulas:\n  note: file.asLink(if(title, title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n    sort:\n      - property: formula.note\n        direction: ASC\n");
await write("Bad/FilterFormula.base", "filters: formula.note == \"x\"\nformulas:\n  note: file.asLink(if(title, title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Bad/MissingOrderFormula.base", "filters: file.inFolder(\"_Workspace/30-Knowledge\")\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n");
await write("Empty/Valid.base", "filters: file.inFolder(\"_Workspace/NoSuchFolder\")\nformulas:\n  note: file.asLink(if(title, title, file.name))\nviews:\n  - type: table\n    name: Empty\n    order: [formula.note]\n");
await write("Empty/Invalid.base", "filters: file.inFolder(\"_Workspace/NoSuchFolder\")\nformulas:\n  note: file.asLink(file.path)\nviews:\n  - type: table\n    name: Empty\n    order: [formula.note]\n");

let deep = "file.name";
for (let index = 0; index < 25; index += 1) deep = `if(title, ${deep}, file.name)`;
await write("Bad/DeepNesting.base", `formulas:\n  note: file.asLink(${deep})\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n`);

const { registerWorkflowTools } = await import("../src/tools/workflows.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "bases-link-formula-test", version: "1" });
  registerWorkflowTools(server);
  const client = new Client({ name: "bases-link-formula-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function query(client, args) {
  return client.callTool({ name: "query_base", arguments: args });
}

// Display name of one note's `formula.note` cell in a tool result.
function rowValue(result, notePath) {
  return result.structuredContent.rows.find((row) => row.path === notePath).values["formula.note"].displayName;
}

test("query_base returns structured asLink cells for Knowledge (file.asLink(if(title, title, file.name)))", async () => {
  await withClient(async (client) => {
    const result = await query(client, { path: "Knowledge.base" });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const byPath = Object.fromEntries(result.structuredContent.rows.map((row) => [row.path, row]));
    const alpha = byPath["_Workspace/30-Knowledge/Alpha.md"];
    assert.deepEqual(alpha.values["formula.note"], {
      path: "_Workspace/30-Knowledge/Alpha.md",
      displayName: "Alpha Title",
      kind: "asLink",
    });
    // Null/empty/whitespace property falls back to basename.
    assert.equal(byPath["_Workspace/30-Knowledge/Beta.md"].values["formula.note"].displayName, "Beta");
    assert.equal(byPath["_Workspace/30-Knowledge/Gamma.md"].values["formula.note"].displayName, "Gamma");
    assert.equal(byPath["_Workspace/30-Knowledge/Whitespace.md"].values["formula.note"].displayName, "Whitespace");
    assert.equal(byPath["_Workspace/30-Knowledge/Blank.md"].values["formula.note"].displayName, "Blank");
    // Defined non-string display behavior.
    assert.equal(byPath["_Workspace/30-Knowledge/Numeric.md"].values["formula.note"].displayName, "2026");
    assert.equal(byPath["_Workspace/30-Knowledge/Flagged.md"].values["formula.note"].displayName, "true");
    assert.equal(byPath["_Workspace/30-Knowledge/Listed.md"].values["formula.note"].displayName, "One, Two");
    assert.equal(byPath["_Workspace/30-Knowledge/Map.md"].values["formula.note"].displayName, "Map");
    // Serialized tool response carries a consumable object, never the source text.
    assert.equal(result.content[0].text.includes("file.asLink"), false);
    for (const row of result.structuredContent.rows) {
      assert.equal(row.values["formula.note"].path, row.path, "link path must be the authorized record path");
      assert.equal(typeof row.values["formula.note"].displayName, "string");
      assert.equal(row.values["formula.note"].kind, "asLink");
    }
  });
});

test("query_base returns structured asLink cells for Skills (file.asLink(if(name, name, file.name)))", async () => {
  await withClient(async (client) => {
    const result = await query(client, { path: "Skills.base" });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const byPath = Object.fromEntries(result.structuredContent.rows.map((row) => [row.path, row]));
    assert.deepEqual(byPath["_Workspace/60-Skills/SKILL.md"].values["formula.note"], {
      path: "_Workspace/60-Skills/SKILL.md",
      displayName: "Skill Display",
      kind: "asLink",
    });
    assert.equal(byPath["_Workspace/60-Skills/Desktop/One.md"].values["formula.note"].displayName, "Desktop Skill");
    assert.equal(byPath["_Workspace/60-Skills/Desktop/NoName.md"].values["formula.note"].displayName, "NoName");
    assert.equal(byPath["_Workspace/60-Skills/Other.md"], undefined, "non-matching note must stay filtered out");
  });
});

test("query_base returns structured asLink cells for nested if(title, title, if(name, name, file.name))", async () => {
  await withClient(async (client) => {
    const result = await query(client, { path: "Nested.base" });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const byPath = Object.fromEntries(result.structuredContent.rows.map((row) => [row.path, row]));
    assert.deepEqual(byPath["_Workspace/70-Nested/HasTitle.md"].values["formula.note"], {
      path: "_Workspace/70-Nested/HasTitle.md",
      displayName: "Title Wins",
      kind: "asLink",
    });
    assert.equal(byPath["_Workspace/70-Nested/HasName.md"].values["formula.note"].displayName, "Name Wins");
    assert.equal(byPath["_Workspace/70-Nested/EmptyTitle.md"].values["formula.note"].displayName, "Name From Empty Title");
    assert.equal(byPath["_Workspace/70-Nested/Fallback.md"].values["formula.note"].displayName, "Fallback");
    // Serialized tool response carries the exact same consumable payload, never the source.
    const serialized = JSON.parse(result.content[0].text);
    assert.deepEqual(serialized, result.structuredContent);
    assert.equal(result.content[0].text.includes("file.asLink"), false);
    assert.deepEqual(serialized.rows.find((row) => row.path === "_Workspace/70-Nested/HasTitle.md").values["formula.note"], {
      path: "_Workspace/70-Nested/HasTitle.md",
      displayName: "Title Wins",
      kind: "asLink",
    });
  });
});

test("Project.base without formulas keeps existing filters, sort and sort-before-limit behavior", async () => {
  await withClient(async (client) => {
    const active = await query(client, { path: "Project.base", view: "进行中" });
    assert.equal(active.isError, undefined, JSON.stringify(active.content));
    // priority ASC then updated DESC: D(P1 09-20), A(P1 09-10), E(P2), F(P3).
    assert.deepEqual(active.structuredContent.rows.map((row) => row.path), [
      "_Workspace/40-Projects/obsidian_mcp_server/TODO - D.md",
      "_Workspace/40-Projects/obsidian_mcp_server/TODO - A.md",
      "_Workspace/40-Projects/obsidian_mcp_server/TODO - E.md",
      "_Workspace/40-Projects/obsidian_mcp_server/TODO - F.md",
    ]);
    assert.equal(active.structuredContent.rows[0].values["file.name"], "TODO - D");
    assert.equal(active.structuredContent.rows.some((row) => Object.keys(row.values).some((key) => key.startsWith("formula."))), false);

    // limit applies after sort, so the prefix is the sorted head (D, A), not the path head.
    const limited = await query(client, { path: "Project.base", view: "进行中", limit: 2 });
    assert.deepEqual(limited.structuredContent.rows.map((row) => row.path), [
      "_Workspace/40-Projects/obsidian_mcp_server/TODO - D.md",
      "_Workspace/40-Projects/obsidian_mcp_server/TODO - A.md",
    ]);
    assert.equal(limited.structuredContent.totalMatched, 4);
    assert.equal(limited.structuredContent.truncated, true);

    const deferred = await query(client, { path: "Project.base", view: "暂缓" });
    assert.deepEqual(deferred.structuredContent.rows.map((row) => row.path), ["_Workspace/40-Projects/obsidian_mcp_server/TODO - B.md"]);

    const done = await query(client, { path: "Project.base", view: "已完成" });
    assert.deepEqual(done.structuredContent.rows.map((row) => row.path), ["_Workspace/40-Projects/obsidian_mcp_server/DONE - TODO - C.md"]);
  });
});

test("undefined bare frontmatter properties are missing data, not executable expressions", async () => {
  await withClient(async (client) => {
    const result = await query(client, { path: "Knowledge.base", limit: 500 });
    const blank = result.structuredContent.rows.find((row) => row.path === "_Workspace/30-Knowledge/Blank.md");
    assert.equal(blank.values["formula.note"].displayName, "Blank");
  });
});

test("formula validation fails closed before filtering and reports clear errors", async () => {
  await withClient(async (client) => {
    const cases = [
      ["Bad/UnsupportedFileProp.base", /unsupported file property/i],
      ["Bad/UnknownMethod.base", /file\.asLink2|Unsupported|must start with file\.asLink/],
      ["Bad/UnknownFunction.base", /sum|Unsupported|Expected/],
      ["Bad/FormulaRef.base", /references undeclared formula "other"/],
      ["Bad/FormulaRefDeadBranch.base", /references undeclared formula "other"/],
      ["Bad/FormulaRefUnused.base", /references undeclared formula "other"/],
      ["Bad/FormulaRefEmpty.base", /references undeclared formula "other"/],
      ["Bad/Syntax.base", /Expected|Unexpected|malformed|Invalid/i],
      ["Bad/DeadBranch.base", /file\.unknown|Unsupported/],
      ["Bad/UnusedInvalid.base", /file\.path|Unsupported/],
      ["Bad/DeepNesting.base", /nesting|depth/i],
      ["Empty/Invalid.base", /file\.path|Unsupported/],
    ];
    for (const [base, pattern] of cases) {
      const result = await query(client, { path: base });
      assert.equal(result.isError, true, `${base} must fail closed`);
      assert.match(result.content[0].text, pattern, `${base} error message`);
    }
  });
});

test("flipped P0 restrictions: note.title and the true/null literals are supported", async () => {
  await withClient(async (client) => {
    // Was: ["Bad/NoteNamespace.base", /unsupported namespaced reference/] (a fail-closed row).
    const namespace = await query(client, { path: "Bad/NoteNamespace.base" });
    assert.equal(namespace.isError, undefined, "note.title must now resolve instead of failing closed");
    assert.equal(rowValue(namespace, "_Workspace/30-Knowledge/Alpha.md"), "Alpha Title");
    // Was: ["Bad/TrueLiteral.base", /unsupported literal "true"/] (a fail-closed row).
    const trueLiteral = await query(client, { path: "Bad/TrueLiteral.base" });
    assert.equal(trueLiteral.isError, undefined, "the true literal must now evaluate instead of failing closed");
    assert.equal(rowValue(trueLiteral, "_Workspace/70-Nested/Fallback.md"), "Fallback");
    // Was: ["Bad/NullLiteral.base", /unsupported literal "null"/] (a fail-closed row).
    const nullLiteral = await query(client, { path: "Bad/NullLiteral.base" });
    assert.equal(nullLiteral.isError, undefined, "the null literal must now evaluate instead of failing closed");
    assert.equal(rowValue(nullLiteral, "_Workspace/70-Nested/HasTitle.md"), "Title Wins");
  });
});

test("flipped P0 restrictions (INT-B): a formula definition can reference a declared formula", async () => {
  await withClient(async (client) => {
    // Was: `formula.<name>` references were rejected outright (out of scope).
    const result = await query(client, { path: "FormulaRef.base" });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(rowValue(result, "_Workspace/30-Knowledge/Alpha.md"), "Alpha Title");
    assert.equal(rowValue(result, "_Workspace/30-Knowledge/Blank.md"), "Blank", "empty dependency falls back to file.name");
  });
});

test("flipped P0 restrictions (INT-C): formula.* participates in filters / sort; list values still fail closed", async () => {
  await withClient(async (client) => {
    // Was: `formula.*` in view.filters was rejected outright (out of scope).
    const filterResult = await query(client, { path: "FilterFormulaPos.base" });
    assert.equal(filterResult.isError, undefined, JSON.stringify(filterResult.content));
    assert.deepEqual(filterResult.structuredContent.rows.map((row) => row.path), ["_Workspace/30-Knowledge/Alpha.md"]);

    // Was: `formula.*` in view.sort was rejected outright (out of scope).
    const sortResult = await query(client, { path: "SortFormulaPos.base" });
    assert.equal(sortResult.isError, undefined, JSON.stringify(sortResult.content));
    assert.deepEqual(sortResult.structuredContent.rows.map((row) => row.path), [
      "_Workspace/30-Knowledge/Alpha.md",
      "_Workspace/30-Knowledge/Beta.md",
      "_Workspace/30-Knowledge/Blank.md",
      "_Workspace/30-Knowledge/Flagged.md",
      "_Workspace/30-Knowledge/Gamma.md",
      "_Workspace/30-Knowledge/Listed.md",
      "_Workspace/30-Knowledge/Map.md",
      "_Workspace/30-Knowledge/Numeric.md",
      "_Workspace/30-Knowledge/Whitespace.md",
    ]);

    // Unchanged, but no longer for the blanket reason: this fixture sorts on
    // `file.asLink(if(title, title, file.name))` over Knowledge, whose Listed/Map
    // notes carry list / object titles — list sorting is fail-closed (INT-C §4).
    const listSortResult = await query(client, { path: "Bad/SortFormula.base" });
    assert.equal(listSortResult.isError, true);
    assert.match(listSortResult.content[0].text, /not supported in view sort for list values/);

    const missingOrder = await query(client, { path: "Bad/MissingOrderFormula.base" });
    assert.equal(missingOrder.isError, true);
    assert.match(missingOrder.content[0].text, /missing formula "note"/);
  });
});

test("empty result sets still validate the whole formula AST", async () => {
  await withClient(async (client) => {
    const valid = await query(client, { path: "Empty/Valid.base" });
    assert.equal(valid.isError, undefined, JSON.stringify(valid.content));
    assert.deepEqual(valid.structuredContent.rows, []);
    assert.equal(valid.structuredContent.totalMatched, 0);
  });
});
