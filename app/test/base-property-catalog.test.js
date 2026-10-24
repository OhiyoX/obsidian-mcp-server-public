// Property catalog: the additive DTO field behind the desktop Properties menu.
//
// Lane desktop-re/panel-properties. The catalog is the ONLY thing that lets the Web
// popover list the properties a view does NOT show (the owner's screenshot has 26 rows,
// the frozen `columns` DTO only the 3 of the selected view). It is a read projection with
// three named sources (`src/base-property-catalog.js`): the desktop built-in name table,
// the `.base`'s own `properties:` block + resolved columns, and the frontmatter keys that
// really occur in the Base's directory.
//
// These tests pin the shape and the provenance, not the pixels: the geometry is measured
// in `evidence/readings.json` by the lane's Chromium probe.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPropertyCatalog, isInBaseDirectory } from "../src/base-property-catalog.js";
import { BASE_BUILTIN_PROPERTY_NAMES } from "../src/base-builtin-names.js";

// The owner's own Files.base shape (read-only copy of the vault document's structure).
const BASE_RAW = [
  "filters:",
  "  and:",
  '    - file.inFolder("_Workspace/40-Projects/obsidian_mcp_server")',
  "formulas:",
  "  note: file.asLink(if(title, title, file.name))",
  "properties:",
  "  formula.note:",
  "    displayName: 笔记",
  "  file.mtime:",
  "    displayName: 编辑时间",
  "  file.size:",
  "    displayName: 大小",
  "views:",
  "  - type: table",
  "    name: 全部文件",
  "    order: [formula.note, file.mtime]",
  "",
].join("\n");

const COLUMNS = [
  { key: "formula.note", label: "笔记", kind: "formula" },
  { key: "file.mtime", label: "编辑时间", kind: "property" },
];

const RECORDS = [
  { path: "_Workspace/40-Projects/obsidian_mcp_server/Note.md", frontmatter: { status: "active", updated: "2026-10-20", kind: "todo" } },
  { path: "_Workspace/40-Projects/obsidian_mcp_server/Deep/Other.md", frontmatter: { status: "done", archived: true, priority: 2, tags: ["a"], source: { commit: "x" } } },
  // Outside the Base's directory: must not contribute a key.
  { path: "_Workspace/40-Projects/elsewhere/Else.md", frontmatter: { repository: "r" } },
];

function catalog(overrides = {}) {
  return buildPropertyCatalog({
    base: { path: "_Workspace/40-Projects/obsidian_mcp_server/Files.base", raw: BASE_RAW },
    columns: COLUMNS,
    records: RECORDS,
    ...overrides,
  });
}

test("the checked rows are exactly the view's columns, first and in view order", () => {
  const rows = catalog();
  assert.deepEqual(rows.slice(0, 2).map((row) => row.key), ["formula.note", "file.mtime"]);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.checked), [true, true]);
  // A checked row carries its OBSERVED kind, not a placeholder: the desktop paints the same
  // type glyph on checked and unchecked rows alike (date → calendar), so a literal
  // "property" here left the checked rows' icon slot empty. `formula.note` is a formula;
  // `file.mtime` is a date in this fixture (the view renamed it 编辑时间 via displayName).
  assert.deepEqual(rows.slice(0, 2).map((row) => row.kind), ["formula", "date"]);
  // The label is the resolved display name, never the raw formula/key.
  // Label rule (section-5.14 review, verified against the owner's own screenshot): the MENU does
  // not apply a `.base` displayName to note/built-in rows — `status`/`updated` read as raw keys
  // there while the table headers read 状态/更新 — and only a FORMULA row takes its declared
  // displayName (项目). So `file.mtime` reads its built-in 修改时间, not the fixture's 编辑时间.
  assert.deepEqual(rows.slice(0, 2).map((row) => row.label), ["笔记", "修改时间"]);
});

test("the unchecked rows are built-ins first, then the author's keys, each alphabetical", () => {
  const rows = catalog().filter((row) => !row.checked);
  const keys = rows.map((row) => row.key);
  // Desktop order (owner screenshot `02-properties-open.png`, coordinator-verified): the
  // built-in `file.*` rows come first in key order, THEN the author's own keys in key
  // order. A single alphabetical run put `archived`/`created`/`description` above the
  // built-ins, which is not what the desktop paints.
  const isBuiltin = (key) => Object.hasOwn(BASE_BUILTIN_PROPERTY_NAMES, key);
  const firstAuthor = keys.findIndex((key) => !isBuiltin(key));
  assert.ok(firstAuthor > 0, "built-in rows lead the unchecked half");
  assert.ok(
    keys.every((key, index) => (index < firstAuthor ? isBuiltin(key) : !isBuiltin(key))),
    "the two groups never interleave",
  );
  const builtinRun = keys.slice(0, firstAuthor);
  assert.deepEqual(builtinRun, builtinRun.slice().sort(), "built-in rows read alphabetically by key");
  const authorRun = keys.slice(firstAuthor);
  assert.deepEqual(authorRun, authorRun.slice().sort(), "author rows read alphabetically by key");
  // `file.file` (文件) is the note itself; the desktop's 13 built-in rows omit it.
  assert.equal(keys.includes("file.file"), false, "the file link is not an unchecked row");
  // Declared but not shown, with the author's own display name (and no invented kind).
  const size = rows.find((row) => row.key === "file.size");
  // Same label rule as above: a built-in row shows its BUILT-IN name, not the fixture's displayName.
  assert.deepEqual(size, { key: "file.size", label: "文件大小", kind: "builtin", checked: false, source: "builtin" });
  // Frontmatter keys that really occur under the Base's directory.
  const status = rows.find((row) => row.key === "status");
  assert.equal(status.source, "observed");
  assert.equal(status.kind, "text");
  assert.equal(rows.find((row) => row.key === "priority").kind, "number");
  assert.equal(rows.find((row) => row.key === "archived").kind, "boolean");
  assert.equal(rows.find((row) => row.key === "updated").kind, "date");
  assert.equal(rows.find((row) => row.key === "tags").kind, "list");
  assert.equal(rows.find((row) => row.key === "source").kind, "object");
  // Every built-in file property the desktop offers is present exactly once, with the
  // desktop's three-step name priority. `file.file` (文件) is the exception: the desktop's
  // own 13 built-in rows leave the note's own file link out, so it is only listed when the
  // view itself shows it (checked half).
  const all = catalog();
  // `file.mtime` carries the author's own displayName in this document, which outranks the
  // built-in table — the desktop's three-step priority, pinned by `web-bases-builtin-names`.
  const declaredNames = {};
  for (const [key, label] of Object.entries(BASE_BUILTIN_PROPERTY_NAMES)) {
    const row = all.find((entry) => entry.key === key);
    if (key === "file.file") {
      assert.equal(row, undefined, "file.file is not offered when the view does not show it");
      continue;
    }
    assert.notEqual(row, undefined, `${key} must be listed`);
    assert.equal(row.label, declaredNames[key] ?? label);
  }
  // `repository` occurs only OUTSIDE the Base's directory, so the catalog must not carry it.
  assert.equal(rows.some((row) => row.key === "repository"), false);
});

test("every row carries the five documented fields and no duplicates", () => {
  const rows = catalog();
  const keys = rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length, "a property is listed exactly once");
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["checked", "key", "kind", "label", "source"]);
    assert.equal(typeof row.key, "string");
    assert.equal(typeof row.label, "string");
    assert.notEqual(row.label, "");
    assert.equal(typeof row.checked, "boolean");
    assert.ok(["builtin", "column", "declared", "observed"].includes(row.source));
  }
});

test("a malformed document degrades to columns + builtins instead of throwing", () => {
  const rows = buildPropertyCatalog({ base: { path: "Broken.base", raw: "views: [\n" }, columns: COLUMNS, records: [] });
  assert.deepEqual(rows.filter((row) => row.checked).map((row) => row.key), ["formula.note", "file.mtime"]);
  assert.ok(rows.length >= Object.keys(BASE_BUILTIN_PROPERTY_NAMES).length);
});

test("directory scoping is boundary-correct", () => {
  assert.equal(isInBaseDirectory("A/B/Note.md", "A/B"), true);
  assert.equal(isInBaseDirectory("A/BC/Note.md", "A/B"), false);
  assert.equal(isInBaseDirectory("A/B.md", "A/B"), false);
  assert.equal(isInBaseDirectory("A/B/Note.md", ""), true);
});
