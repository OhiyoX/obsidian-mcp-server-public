import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExplorerView,
  explorerViewContentSignature,
  explorerViewSignature,
} from "../frontend/app/features/explorer/view-model.js";

const note = (path, extra = {}) => ({ path, title: path.split("/").pop(), ...extra });

function rootOrder(view) {
  return {
    folders: view.root.folders.map((folder) => folder.path),
    notes: view.root.notes.map((item) => item.path),
  };
}

function folder(view, path) {
  if (path === "") return view.root;
  const [head, ...rest] = path.split("/");
  const match = view.root.folders.find((item) => item.name === head);
  if (!match) throw new Error(`missing folder ${path}`);
  const nested = { root: match.children };
  return rest.length ? folder(nested, rest.join("/")) : match.children;
}

test("default view is folder-first with name asc everywhere", () => {
  const view = buildExplorerView([
    note("zeta/z.md", { title: "zeta note" }),
    note("alpha/a.md", { title: "alpha note" }),
  ]);
  assert.deepEqual(rootOrder(view), { folders: ["alpha", "zeta"], notes: [] });
  assert.deepEqual(folder(view, "alpha").notes.map((item) => item.path), ["alpha/a.md"]);
  assert.deepEqual(folder(view, "zeta").notes.map((item) => item.path), ["zeta/z.md"]);
});

test("modified desc sorts notes but keeps folders fixed at name asc", () => {
  const notes = [
    note("b/old.md", { modified: "2026-01-01T00:00:00Z" }),
    note("a/new.md", { modified: "2026-01-03T00:00:00Z" }),
    note("c/mid.md", { modified: "2026-01-02T00:00:00Z" }),
    note("a/missing.md", { modified: null }),
  ];
  const view = buildExplorerView(notes, { key: "modified", direction: "desc" });
  assert.deepEqual(view.root.folders.map((item) => item.path), ["a", "b", "c"]);
  assert.deepEqual(folder(view, "a").notes.map((item) => item.path), ["a/new.md", "a/missing.md"]);
  assert.deepEqual(folder(view, "b").notes.map((item) => item.path), ["b/old.md"]);
  assert.deepEqual(folder(view, "c").notes.map((item) => item.path), ["c/mid.md"]);
});

test("missing/invalid modified stays last in both directions and ties break on name then path", () => {
  const notes = [
    note("x.md", { title: "same", modified: "2026-01-02T00:00:00Z" }),
    note("a.md", { title: "same", modified: "2026-01-02T00:00:00Z" }),
    note("z.md", { title: "same", modified: "bad" }),
  ];
  const asc = buildExplorerView(notes, { key: "modified", direction: "asc" });
  assert.deepEqual(rootOrder(asc).notes, ["a.md", "x.md", "z.md"]);
  const desc = buildExplorerView(notes, { key: "modified", direction: "desc" });
  assert.deepEqual(rootOrder(desc).notes, ["a.md", "x.md", "z.md"]);
});

test("same-path modified reorder changes the content signature", () => {
  const before = buildExplorerView([
    note("a.md", { modified: "2026-01-01T00:00:00Z" }),
    note("b.md", { modified: "2026-01-02T00:00:00Z" }),
  ], { key: "modified", direction: "asc" });
  const after = buildExplorerView([
    note("a.md", { modified: "2026-01-05T00:00:00Z" }),
    note("b.md", { modified: "2026-01-02T00:00:00Z" }),
  ], { key: "modified", direction: "asc" });
  assert.deepEqual(rootOrder(before).notes, ["a.md", "b.md"]);
  assert.deepEqual(rootOrder(after).notes, ["b.md", "a.md"]);
  assert.notEqual(explorerViewContentSignature(before), explorerViewContentSignature(after));
});

test("same-path visible-title change changes the content signature", () => {
  const before = buildExplorerView([note("a.md", { title: "Old label" })]);
  const after = buildExplorerView([note("a.md", { title: "New label" })]);
  assert.notEqual(explorerViewContentSignature(before), explorerViewContentSignature(after));
});

test("backend order and score changes with the same visible view keep the signature", () => {
  const first = buildExplorerView([
    note("a.md", { score: 0 }),
    note("b.md", { score: 0 }),
  ], { key: "name", direction: "asc" });
  const reordered = buildExplorerView([
    note("b.md", { score: 99 }),
    note("a.md", { score: 3 }),
  ], { key: "name", direction: "asc" });
  assert.deepEqual(rootOrder(first).notes, ["a.md", "b.md"]);
  assert.deepEqual(rootOrder(reordered).notes, ["a.md", "b.md"]);
  assert.equal(explorerViewContentSignature(first), explorerViewContentSignature(reordered));
});

test("full signature includes the spec while the content signature does not", () => {
  const notes = [note("a.md"), note("b.md")];
  const asc = buildExplorerView(notes, { key: "name", direction: "asc" });
  const desc = buildExplorerView(notes, { key: "name", direction: "desc" });
  // Reversed visible order, so both signatures differ.
  assert.notEqual(explorerViewContentSignature(asc), explorerViewContentSignature(desc));
  assert.notEqual(explorerViewSignature(asc), explorerViewSignature(desc));

  const single = [note("only.md")];
  const onlyAsc = buildExplorerView(single, { key: "name", direction: "asc" });
  const onlyDesc = buildExplorerView(single, { key: "name", direction: "desc" });
  // Same visible order: content is equal (no structural reorder), spec differs.
  assert.equal(explorerViewContentSignature(onlyAsc), explorerViewContentSignature(onlyDesc));
  assert.notEqual(explorerViewSignature(onlyAsc), explorerViewSignature(onlyDesc));
});

test("adversarial: a path or title containing the old raw pipe delimiter cannot collide", () => {
  // Regression for the codex.signature-probe collision: with the previous
  // `depth|N|path|title` string concatenation both of these collapsed to the
  // identical record `0|N|note.md|x.md|y` even though the visible path and
  // visible title differ. The structured tuple signature must separate them.
  const left = buildExplorerView([note("note.md", { title: "x.md|y" })], { key: "name", direction: "asc" });
  const right = buildExplorerView([note("note.md|x.md", { title: "y" })], { key: "name", direction: "asc" });
  assert.equal(left.root.notes[0].path, "note.md");
  assert.equal(right.root.notes[0].path, "note.md|x.md");
  assert.notEqual(explorerViewContentSignature(left), explorerViewContentSignature(right));
  assert.notEqual(explorerViewSignature(left), explorerViewSignature(right));
});

test("adversarial: an independently exposed folder label participates in the signature", () => {
  // Folder labels are rendered from `folder.name`; the signature must not fold
  // them away behind the folder path alone.
  const base = buildExplorerView([note("Folder/a.md")], { key: "name", direction: "asc" });
  const relabelled = JSON.parse(JSON.stringify(base));
  relabelled.root.folders[0].name = "Folder|x";
  assert.notEqual(explorerViewContentSignature(base), explorerViewContentSignature(relabelled));
  assert.notEqual(explorerViewSignature(base), explorerViewSignature(relabelled));
});

test("view-model delegates ordering to the pure model (no local comparator)", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../frontend/app/features/explorer/view-model.js", import.meta.url), "utf8"));
  assert.match(source, /import \{ sortTreeLevel \} from "\.\/sort-model\.js"/);
  assert.match(source, /sortTreeLevel\(\{ folders: folderEntries, notes: group\.notes \}, spec\)/);
  assert.doesNotMatch(source, /localeCompare/);
});
