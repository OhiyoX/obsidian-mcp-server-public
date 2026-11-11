// Task 6 — the Explorer's rename / safe-delete context menu.
//
// The module is a thin seam over two shipped primitives (`ui/popup-menu.js`,
// `ui/popup-position.js`) and the Explorer's own row markup, so this file drives the product
// events a user produces — a right click on a row, `F2` on the focused row, `Shift+F10` — and
// reads back only the surface the wiring task consumes: `target()`, `itemFor()`, `openFor()`.
//
// `test/helpers/base-dom.mjs` ships no event classes and Node has neither `MouseEvent` nor
// `KeyboardEvent`, so the harness document gets a minimal pair on `defaultView`: the shape the
// browser gives this module (type, key, shiftKey, clientX/clientY, `preventDefault`), dispatched
// through the harness's real listeners instead of calling anything private.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createExplorerContextMenu, targetFromRow } from "../frontend/app/features/explorer/context-menu.js";

// The classes `frontend/app/features/explorer/tree.js` really renders.
const ROW_CLASS = { folder: "tree-folder-row", note: "note", file: "note note-file", base: "note note-base" };

class HarnessEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.target = undefined;
    this.defaultPrevented = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

// The harness dispatches to one node and does not propagate, while a browser bubbles
// `contextmenu` from the row up to the host that delegates it. The fixture walks that path with
// one event, so `event.target` stays the row — what the host's listener really sees.
function dispatchBubbling(node, event) {
  for (let current = node; current; current = current.parentNode) current.dispatchEvent(event);
}

// The harness `dataset` is a plain object and does not reflect to attributes the way a browser's
// `DOMStringMap` does, so the fixture writes both halves of what `data-*` means.
function setData(node, key, value) {
  node.dataset[key] = value;
  node.setAttribute(`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
}

// Mirrors the shipped markup: a folder row wrapper carries `data-folder-path`, a note /
// attachment / Base name button carries `data-path` and (except for a plain note) `data-kind`.
function rowNode(document, { kind, path }) {
  const row = document.createElement(kind === "folder" ? "div" : "button");
  row.className = ROW_CLASS[kind];
  if (kind === "folder") setData(row, "folderPath", path);
  else {
    setData(row, "path", path);
    if (kind !== "note") setData(row, "kind", kind);
  }
  row.textContent = path;
  return row;
}

function mount(rows, { onRename, onDelete } = {}) {
  const local = createDomHarness();
  local.install();
  local.document.defaultView = { MouseEvent: HarnessEvent, KeyboardEvent: HarnessEvent };
  const host = local.createElement("div");
  host.className = "tree";
  local.document.body.append(host);
  for (const row of rows) host.append(rowNode(local.document, row));
  const menu = createExplorerContextMenu({
    host,
    documentRef: local.document,
    windowRef: local.document.defaultView,
    onRename,
    onDelete,
  });
  return { menu, doc: local.document, host, local };
}

test("the menu opens on a right click and reports the row's kind and path", () => {
  const { menu, doc } = mount([{ kind: "folder", path: "Projects" }]);
  dispatchBubbling(doc.querySelector('[data-folder-path="Projects"]'), new doc.defaultView.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(menu.target()?.path, "Projects");
  assert.equal(menu.itemFor("rename").textContent.includes("重命名"), true);
});

test("F2 renames the focused row and Shift+F10 opens the menu", () => {
  const calls = [];
  const { menu, doc, host } = mount([{ kind: "note", path: "Top.md" }], { onRename: (target) => calls.push(target.path) });
  const row = doc.querySelector('[data-path="Top.md"]');
  row.focus();
  host.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  assert.deepEqual(calls, ["Top.md"]);
  host.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  assert.equal(menu.target()?.path, "Top.md");
});

test("every row class reports its kind, the F2 hint is a kbd, and a pick runs one callback", () => {
  const deleted = [];
  const { menu, doc } = mount(
    [{ kind: "file", path: "a.pdf" }, { kind: "base", path: "B.base" }],
    { onDelete: (target) => deleted.push(target.path) },
  );

  assert.deepEqual(targetFromRow(doc.querySelector('[data-path="a.pdf"]')), { kind: "file", path: "a.pdf" });
  assert.deepEqual(targetFromRow(doc.querySelector('[data-path="B.base"]')), { kind: "base", path: "B.base" });

  const popup = doc.querySelector(".tree-context-menu");
  assert.equal(popup.getAttribute("role"), "menu");
  assert.equal(popup.hidden, true, "the menu starts closed");
  assert.equal(menu.itemFor("rename").querySelector("kbd")?.textContent, "F2", "the rename item carries the F2 hint");

  dispatchBubbling(doc.querySelector('[data-path="B.base"]'), new doc.defaultView.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(popup.getAttribute("data-menu-target"), "B.base");
  popup.dispatchEvent({ type: "click", target: menu.itemFor("delete") });
  assert.deepEqual(deleted, ["B.base"], "the delete pick runs the delete callback once");
  assert.equal(popup.hidden, true, "picking an item closes the menu");
  assert.equal(menu.target(), null);

  menu.destroy();
  assert.equal(doc.querySelector(".tree-context-menu"), null, "destroy removes the popup");
});
