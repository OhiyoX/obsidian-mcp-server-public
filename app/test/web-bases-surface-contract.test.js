// Source-contract checks for the self-contained Base surface module.
//
// These lock the Wave A isolation boundary: the module must import in Node with
// no DOM global, must never use an HTML sink, must not depend on the Markdown
// editor / document session / explorer / navigation, and must not be wired into
// the app bundle (assets stay byte-identical).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const BASE_MODULES = [
  "index.js",
  "state.js",
  "cell.js",
  "view.js",
  "controller.js",
  "document-kind.js",
  "styles.js",
  // U12 split: the panel family of the parity stylesheet moved to its own module so
  // styles.js has room for the 所有视图 section. Same budget, same bans.
  "styles-panels.js",
  "toolbar.js",
  "panels.js",
  "mobile-viewport.js",
  "panel-chrome.js",
  "panel-sort.js",
  "panel-filter.js",
  "panel-properties.js",
  "actions.js",
  "dom.js",
  "resize.js",
  "pointer-policy.js",
  "view-config.js",
  "view-options.js",
  "row-layouts.js",
  "query-state.js",
];

async function readModule(name) {
  return fs.readFile(new URL(`../frontend/app/features/bases/${name}`, import.meta.url), "utf8");
}

// Comments may legitimately name the APIs we forbid; scan code only.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("the Base entry imports in Node without any DOM global", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  const module = await import("../frontend/app/features/bases/index.js");
  assert.equal(typeof module.createBaseSurface, "function");
  assert.equal(typeof module.BASE_SURFACE_CSS, "string");
  assert.equal(typeof module.describeCellValue, "function");
  assert.equal(typeof module.buildBaseRequestUrl, "function");
});

test("no Base module uses an HTML sink", async () => {
  for (const name of BASE_MODULES) {
    const source = stripComments(await readModule(name));
    assert.doesNotMatch(source, /\.innerHTML\b/, `${name} must not assign innerHTML`);
    assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML|document\.write|eval\(/, `${name} must not use an HTML/eval sink`);
  }
});

test("no Base module imports the app core, editor, explorer, session, navigation or ui", async () => {
  // U38 (#571) narrowed this ban by exactly one module: `ui/icons.js` is now the single sprite
  // resolver for the whole app (it is DOM-free — one `data-icon-sprite` attribute read — and
  // imports nothing), so `cell.js` builds its calendar glyph through it instead of hand-writing the
  // `icons.svg#…` literal `web-firstload-budget` forbids. The negative lookahead is what keeps the
  // carve-out from widening: every *other* `ui/` module stays banned, and the deep-equal below
  // pins the exception to that one edge.
  for (const name of BASE_MODULES) {
    const source = await readModule(name);
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:core\/app|features\/editor|features\/explorer|features\/session|features\/document|features\/navigation|features\/reader|publish|ui\/(?!icons\.js))/,
      `${name} must stay independent of the Markdown document stack`,
    );
  }
  const crossing = [];
  for (const name of BASE_MODULES) {
    const source = stripComments(await readModule(name));
    for (const match of source.matchAll(/from\s+["'][^"']*ui\/([^"']*)["']/g)) crossing.push(`${name} -> ui/${match[1]}`);
  }
  assert.deepEqual(crossing, ["cell.js -> ui/icons.js"], "only the shared sprite resolver may cross into ui/");
});

test("Base internals stay behind the navigation wiring module", async () => {
  // B4 legitimately wires the surface into the app, but only through
  // features/navigation/base-navigation.js. The entry itself must keep no direct
  // dependency on Base internals so app.js stays a thin bootstrap module.
  const app = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /features\/bases|createBaseSurface/);
  assert.ok(app.split(/\r?\n/).length <= 500, "app.js must stay within the local 500-line cap");
  const wiring = await fs.readFile(new URL("../frontend/app/features/navigation/base-navigation.js", import.meta.url), "utf8");
  assert.match(wiring, /bases\/index\.js/);
  assert.match(wiring, /BASE_SURFACE_CSS/);
});

test("every Base module stays within the architecture line budget", async () => {
  for (const name of BASE_MODULES) {
    const source = await readModule(name);
    assert.ok(source.split(/\r?\n/).length <= 500, `${name} exceeds the local 500-line cap`);
  }
});

test("createBaseSurface returns the frozen mount contract", async () => {
  const { createBaseSurface } = await import("../frontend/app/features/bases/index.js");
  const surface = createBaseSurface({ host: null, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });

  for (const method of ["open", "setView", "loadMore", "close", "destroy", "getState", "getRoute"]) {
    assert.equal(typeof surface[method], "function", `missing ${method}`);
  }

  const state = surface.getState();
  assert.deepEqual(Object.keys(state).sort(), [
    "catalogStale",
    "columns",
    "documentKind",
    "error",
    "filter",
    "loading",
    "nextCursor",
    "path",
    "q",
    "rows",
    "sort",
    "view",
  ]);
  assert.equal(state.documentKind, null);
  assert.equal(surface.getRoute(), null);
  surface.destroy();
});

test("the desktop header is one row band tall (inventory F2) and stays one line", async () => {
  const { BASE_SURFACE_CSS } = await import("../frontend/app/features/bases/styles.js");
  // Desktop bytes: `.bases-thead{position:sticky;height:var(--bases-table-row-height)…}` (app.css@488533),
  // `.bases-thead .bases-table-header{height:var(--bases-table-row-height)}` (@488885) and
  // `.bases-td{height:var(--bases-table-row-height)}` (@494332) — the header uses the SAME 30px band as
  // the body rows. `height` is a minimum on a table cell, so the block padding has to be zero as well.
  assert.match(BASE_SURFACE_CSS, /\.base-table thead th\{[^}]*height:var\(--bases-table-row-height,30px\);padding-block:0;\}/);
  // The sprite is `display:block` (Obsidian's `.svg-icon`); in a table cell that stacks a second block
  // box under the label (measured 56.25 = 20 padding + 2 borders + 20.25 line + 14 icon), so the header
  // icon must be inline again.
  assert.match(BASE_SURFACE_CSS, /\.base-column-icon\{display:inline-block;/);
});

test("the request URL never exposes offset or pageNumber", async () => {
  const { buildBaseRequestUrl } = await import("../frontend/app/features/bases/index.js");
  const url = buildBaseRequestUrl({ path: "A b.base", view: "Table", limit: 100, cursor: null });
  assert.equal(url.startsWith("/api/web/v1/base?"), true);
  assert.equal(url.includes("offset"), false);
  assert.equal(url.includes("pageNumber"), false);
  assert.equal(url.includes("path=A+b.base"), true);
  assert.equal(url.includes("view=Table"), true);
  assert.equal(url.includes("limit=100"), true);
});

test("the desktop row height and the two active-tool fills stay in the stylesheet", async () => {
  const { BASE_SURFACE_CSS } = await import("../frontend/app/features/bases/styles.js");
  // Desktop bytes: `--bases-table-row-height:30px` (app.css@58915), `.bases-tr{height:…}` (@494000)
  // and `.bases-td{height:…}` (@494332) — the 30px lives on the cell BOX, so the vertical padding
  // band our `td{padding:10px 16px}` used to add must not come back (42–43px rows).
  assert.match(BASE_SURFACE_CSS, /\.base-table tbody tr\{height:var\(--bases-table-row-height,30px\);\}/);
  assert.match(BASE_SURFACE_CSS, /\.base-table tbody td\{padding-block:0;\}/);
  // Two DIFFERENT desktop backgrounds: an open menu on a plain tool = `--background-modifier-hover`
  // (@262772); only an active tool fills with `--background-modifier-active-hover` = accent 10%
  // (@263133 / @263492, token @96013). Collapsing them into one accent rule would tint every menu.
  assert.match(BASE_SURFACE_CSS, /\.base-action\[aria-expanded="true"\]\{background-color:var\(--background-modifier-hover/);
  assert.match(BASE_SURFACE_CSS, /\.base-action\.base-action-active\[aria-expanded="true"\],\.base-action\.base-action-active:hover\{background-color:var\(--background-modifier-active-hover,/);
});
