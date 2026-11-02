// S2 front-end half: Explorer attachment (`file`) rows and the right-aligned
// suffix badge, replicating the desktop file explorer.
//
// The renderer contract is locked two ways: source assertions for the dispatch
// and the seams, and a real render pass through `renderLazyExplorer` on the DOM
// harness (the same harness the Base surface tests use) so the badge text, the
// click seam and the extension-less behaviour are asserted on live elements,
// not on source text alone.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createLazyExplorerState } from "../frontend/app/features/explorer/lazy-model.js";
import { renderLazyExplorer } from "../frontend/app/features/explorer/tree.js";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";
import { defaultAssetUrl } from "../frontend/app/features/context/outgoing.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;

const treeSource = await fs.readFile(new URL("../frontend/app/features/explorer/tree.js", import.meta.url), "utf8");
const controllerSource = await fs.readFile(new URL("../frontend/app/features/explorer/controller.js", import.meta.url), "utf8");
const wiringSource = await fs.readFile(new URL("../frontend/app/core/explorer-wiring.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");

// A directory + a note + the four attachment shapes the acceptance names
// (`.txt`, `.sha256`, `.pdf`, no suffix) + a `.base`, in the server's order.
const ITEMS = [
  { kind: "directory", path: "Sub", name: "Sub" },
  { kind: "note", path: "Notes.md", title: "Notes" },
  { kind: "file", path: "readme.txt", name: "readme.txt", title: "readme.txt", extension: "txt" },
  { kind: "file", path: "checksums.sha256", name: "checksums.sha256", title: "checksums.sha256", extension: "sha256" },
  { kind: "file", path: "paper.pdf", name: "paper.pdf", title: "paper.pdf", extension: "pdf" },
  { kind: "file", path: "LICENSE", name: "LICENSE", title: "LICENSE", extension: "" },
  { kind: "base", path: "Board.base", title: "Board" },
];

function renderLazy(items = ITEMS, extra = {}) {
  const host = document.createElement("div");
  const model = createLazyExplorerState();
  model.childrenByParent.set("", items);
  const opened = [];
  renderLazyExplorer({
    host,
    model,
    currentPath: null,
    escapeHtml: (value) => String(value),
    onNote: () => {},
    onOpenBase: () => {},
    onOpenFile: (item) => opened.push(item),
    ...extra,
  });
  return { host, model, opened };
}

const rowFor = (host, path) => host.querySelectorAll(".note").find((row) => row.dataset.path === path);

// --- Renderer contract -------------------------------------------------------

test("renderLevel dispatches a `file` node to its own renderer, never to renderNote", () => {
  assert.match(treeSource, /else if \(item\.kind === "file"\) renderFile\(item, container, depth\)/);
  assert.match(treeSource, /function renderFile\(item, container, depth\)/);
  assert.match(treeSource, /button\.dataset\.kind = "file"/);
});

test("the renderer emits rows in the model order and never re-sorts a page", () => {
  // Server order is authoritative (G1 contract): the front end must not re-rank
  // attachments against notes/bases.
  assert.doesNotMatch(treeSource, /\.sort\(/);
  const { host } = renderLazy();
  assert.deepEqual(
    host.querySelectorAll(".note").map((row) => row.dataset.path),
    ["Notes.md", "readme.txt", "checksums.sha256", "paper.pdf", "LICENSE", "Board.base"],
  );
  assert.equal(host.querySelectorAll(".tree-folder-row").length, 1, "the directory stays a folder row");
});

test("each attachment row carries the uppercase suffix badge from `extension`", () => {
  const { host } = renderLazy();
  assert.equal(rowFor(host, "readme.txt").querySelector(".note-badge").textContent, "TXT");
  assert.equal(rowFor(host, "checksums.sha256").querySelector(".note-badge").textContent, "SHA256");
  assert.equal(rowFor(host, "paper.pdf").querySelector(".note-badge").textContent, "PDF");
  assert.equal(host.querySelectorAll(".note-file .note-badge").length, 3, "one badge per extension-carrying file");
});

test("a file without an extension renders no badge (desktop parity)", () => {
  const { host } = renderLazy();
  const row = rowFor(host, "LICENSE");
  assert.ok(row, "the extension-less file still renders");
  assert.equal(row.querySelector(".note-badge"), null);
  assert.equal(row.querySelector(".note-title").textContent, "LICENSE");
});

test("attachment rows reuse the flex row + right-aligned `.note-badge` spec", () => {
  const { host } = renderLazy();
  const row = rowFor(host, "readme.txt");
  assert.ok(row.classList.contains("note-file"));
  assert.ok(row.classList.contains("note"));
  assert.match(css, /\.note\.note-file \{ display: flex; align-items: center; gap: 6px; \}/);
  assert.match(css, /\.note\.note-file \.note-title \{ flex: 1 1 auto; \}/);
  // The badge itself is the shared Wave D spec, right-aligned via margin-left:auto.
  const badge = css.slice(css.indexOf(".note-badge {"), css.indexOf(".note-badge {") + 500);
  assert.match(badge, /margin-left: auto/);
  assert.match(badge, /background: var\(--app-sidebar-hover/);
  assert.match(badge, /color: var\(--app-sidebar-muted/);
  assert.match(badge, /text-transform: uppercase/);
});

test("clicking an attachment row emits the open intent with the tree item", () => {
  const { host, opened } = renderLazy();
  rowFor(host, "paper.pdf").onclick();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, "paper.pdf");
  assert.equal(opened[0].extension, "pdf");
});

test("the BASE row and note row are unchanged by the attachment branch", () => {
  const { host } = renderLazy();
  const base = rowFor(host, "Board.base");
  assert.ok(base.classList.contains("note-base"));
  assert.equal(base.dataset.kind, "base");
  // renderBase still writes its row through innerHTML (the shared BASE spec).
  assert.match(base.innerHTML, /<span class="note-badge">BASE<\/span>/);
  const note = rowFor(host, "Notes.md");
  assert.equal(note.classList.contains("note-file"), false);
  assert.equal(note.querySelector(".note-badge"), null);
});

// --- Controller + wiring seams ----------------------------------------------

test("the controller accepts an optional openFile and forwards onOpenFile to the renderer", () => {
  assert.match(controllerSource, /createExplorerController\(\{[^}]*\bopenFile\b[^}]*\}\)/);
  assert.match(controllerSource, /onOpenFile: \(item\) => openFile\?\.\(item\)/);
  assert.match(treeSource, /onOpenFile,/);
});

test("the controller forwards an attachment click from a real render to its openFile seam", async () => {
  const host = document.createElement("div");
  const opened = [];
  const api = async () => ({
    parent: "",
    items: [{ kind: "file", path: "Attachments/a.txt", name: "a.txt", title: "a.txt", extension: "txt" }],
    nextCursor: null,
    catalog: { generation: 1, stale: false },
  });
  const controller = createExplorerController({
    state: { path: null, query: "", searchCollapsed: new Set(), semantic: false, caseSensitive: false, vaultId: "v1" },
    host,
    statusHost: null,
    api,
    toast: () => {},
    escapeHtml: (value) => String(value),
    openNote: () => {},
    createNote: () => {},
    openBase: () => {},
    openFile: (item) => opened.push(item),
  });
  await controller.load("");
  const row = rowFor(host, "Attachments/a.txt");
  assert.ok(row, "the attachment row renders through the controller path");
  assert.equal(row.querySelector(".note-badge").textContent, "TXT");
  row.onclick();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, "Attachments/a.txt");
});

test("the wiring opens attachments through the existing authenticated asset route", () => {
  // Reuses `defaultAssetUrl` (the Reader / outgoing-links helper) and invents no route.
  assert.match(wiringSource, /import \{ defaultAssetUrl \} from "\.\.\/features\/context\/outgoing\.js"/);
  assert.match(wiringSource, /openAssetInNewTab\(getAssetUrl\(item\.path, "", state\.vaultId \?\? null\)\)/);
  assert.doesNotMatch(wiringSource, /\/api\/web\/v1\/asset/);
  assert.equal(
    defaultAssetUrl("Attachments/paper.pdf", "", "v1"),
    "/api/web/v1/asset?path=Attachments%2Fpaper.pdf&vaultId=v1",
  );
});

test("an extension-less attachment is never selected by the note `.md`-stripping identity", () => {
  // `Photo` (no suffix) must not light up as active while `Photo.md` is open.
  assert.match(controllerSource, /button\.dataset\.kind === "base" \|\| button\.dataset\.kind === "file"/);
  const host = document.createElement("div");
  const model = createLazyExplorerState();
  model.childrenByParent.set("", [{ kind: "file", path: "Photo", name: "Photo", title: "Photo", extension: "" }]);
  renderLazyExplorer({
    host,
    model,
    currentPath: "Photo.md",
    escapeHtml: (value) => String(value),
    onNote: () => {},
    onOpenBase: () => {},
    onOpenFile: () => {},
  });
  assert.equal(rowFor(host, "Photo").classList.contains("active"), false);
  assert.equal(host.querySelectorAll('.note[aria-current="page"]').length, 0);
});
