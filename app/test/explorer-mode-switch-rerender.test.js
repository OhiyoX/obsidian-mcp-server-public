// Explorer browse-mode switch (#335): flat → tree must repaint the files panel on the
// same click.
//
// The Tree renderer reuses its DOM while `treeRenderSignature(model)` is unchanged, and
// the flat list paints the SAME files-panel host. This file locks the wiring that makes
// a flat paint invalidate the Tree's reuse cache, plus the two acceptance shapes on the
// real controller + DOM harness: no query, and an active query (which must survive the
// switch unchanged).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
const controllerSource = await fs.readFile(new URL("../frontend/app/features/explorer/controller.js", import.meta.url), "utf8");

// `helpers/base-dom.mjs` has no HTML parser: it keeps `innerHTML` as a plain property,
// so the `host.innerHTML = ""` both renderers use to clear the host would leave the
// previous rows in place. These hosts get browser-faithful clearing for that exact
// assignment, so the assertions below describe what a *repaint* appended instead of
// what the harness failed to remove.
function createListHost() {
  const host = document.createElement("div");
  let markup = "";
  Object.defineProperty(host, "innerHTML", {
    get: () => markup,
    set: (value) => {
      markup = String(value ?? "");
      if (markup === "") host.replaceChildren();
    },
  });
  return host;
}

const TREE_ROOT = {
  parent: "",
  items: [
    { kind: "directory", path: "Folder", name: "Folder" },
    { kind: "note", path: "A.md", title: "A" },
  ],
  nextCursor: null,
  catalog: { generation: 7, stale: false },
};
const FLAT_PAGE = {
  parent: "",
  items: [{ kind: "note", path: "A.md", name: "A.md", title: "A", modified: "2026-10-06T12:00:00.000Z" }],
  nextCursor: null,
  catalog: { generation: 7, stale: false },
};
const SEARCH_PAGE = {
  items: [{ path: "A.md", name: "A.md", modifiedMs: 1791300000000, score: 3, matchCount: 1, snippets: ["snippet"] }],
  nextCursor: null,
  semantic: { used: false },
  catalog: { generation: 7, stale: false },
};

function createHarness() {
  const host = createListHost();
  const state = {
    path: "A.md",
    query: "",
    searchCollapsed: new Set(),
    semantic: false,
    caseSensitive: false,
    vaultId: "v1",
  };
  const api = async (url) => {
    if (url.includes("flat=1")) return FLAT_PAGE;
    if (url.includes("/api/web/v2/search")) return SEARCH_PAGE;
    return TREE_ROOT;
  };
  const controller = createExplorerController({
    state,
    host,
    searchHost: null,
    statusHost: null,
    filesStatusHost: null,
    api,
    toast: () => {},
    escapeHtml: (value) => String(value),
    openNote: () => {},
    createNote: () => {},
    openBase: () => {},
    openFile: () => {},
  });
  return { host, state, controller };
}

const count = (host, selector) => host.querySelectorAll(selector).length;

test("a flat paint invalidates the Tree's DOM-reuse cache for the shared host", () => {
  assert.match(
    controllerSource,
    /if \(flat\.mode\(\) === "flat"\) \{[\s\S]*?lastTreeSignature = null;[\s\S]*?flat\.render\(\{ revealCurrent \}\)/,
  );
});

test("flat → tree repaints tree rows on the same click (no query)", async () => {
  const { host, controller } = createHarness();
  await controller.load("");
  assert.ok(count(host, ".tree-folder-row") > 0, "the Tree root renders before the switch");

  await controller.setMode("flat");
  assert.equal(count(host, ".tree-folder-row"), 0);
  assert.equal(count(host, ".note-flat"), FLAT_PAGE.items.length);

  await controller.setMode("tree");
  assert.ok(count(host, ".tree-folder-row") > 0, "the Tree is back without a second click");
  assert.equal(count(host, ".note-flat"), 0, "no flat row survives inside the Tree");
  assert.equal(host.firstElementChild.className, "tree-folder-row");
  // Switching modes keeps the current-note location.
  assert.equal(count(host, '.note[aria-current="page"]'), 1);
  assert.equal(host.querySelector('.note[aria-current="page"]').dataset.path, "A.md");
});

test("flat → tree repaints with an active query and keeps that query", async () => {
  const { host, state, controller } = createHarness();
  // Boot order mirrors the app: the Tree is materialized before any query is typed.
  await controller.load("");
  await controller.load("snippet");
  assert.equal(controller.isQueryActive(), true);

  await controller.setMode("flat");
  assert.equal(count(host, ".note-flat"), 1, "the flat list projects the loaded search rows");
  assert.equal(host.querySelector(".note-flat").dataset.path, "A.md");

  await controller.setMode("tree");
  assert.equal(controller.isQueryActive(), true, "the mode switch never clears the query");
  assert.equal(state.query, "snippet");
  assert.ok(count(host, ".tree-folder-row") > 0, "the Tree is back without a second click");
  assert.equal(count(host, ".note-flat"), 0, "no flat row survives inside the Tree");
});
