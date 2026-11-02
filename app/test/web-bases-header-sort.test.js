// Per-column sort marker on the Base table header (lane desktop-re/bases-header-parity).
//
// Desktop truth (pinned 1.14.4 extract, byte offsets are the asar file's own — NOT this
// repo's line numbers):
//   * render tail, app.js@3231419:
//       `h = this.view.config.getSort().find(t => t.property === e);
//        h ? (n.setAttr("data-sort", h.direction),
//             LM(o, "ASC" === h.direction ? "lucide-chevron-up" : "lucide-chevron-down"))
//          : (n.setAttr("data-sort", null), o.empty());`
//     ⇒ `data-sort` carries "ASC"/"DESC" and a column with no sort carries NO attribute;
//   * the marker box `td > div.bases-table-header-sort` is created on the HEADER CELL
//     (app.js@3227612) and styled at app.css@489702 (absolute, inset-inline-end:0,
//     `--icon-size: var(--icon-xs)`, `color: var(--text-muted)`);
//   * the sorted column reserves 16px and fades its last 24px:
//     `.bases-thead .bases-td[data-sort] .bases-table-header{mask-image:var(--bases-table-header-sort-mask)}`
//     (app.css@489359, mask-image @489422) and
//     `.bases-thead .bases-td[data-sort] .bases-table-header-name{padding-inline-end:var(--size-4-4)}`
//     (@489468 = 16px), with the LTR token `linear-gradient(to left,transparent var(--size-4-6),
//     black var(--size-4-6))` @58388 and its RTL mirror @489589.
//
// The sort list the header paints is the SORT PANEL's own (`effectiveSortList`: the `?sort=`
// override, else the sort the `.base` declares for the selected view) — one source, no copy.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const ROUTE = "/app/base/r";
const BASE_PATH = "40-Projects/Projects.base";

function page(overrides = {}) {
  return {
    vaultId: "vault-1",
    path: BASE_PATH,
    route: ROUTE,
    revision: "rev-1",
    views: [{ name: "Table", type: "table" }],
    view: { name: "Table", type: "table" },
    columns: [
      { key: "name", label: "Name", kind: "string" },
      { key: "status", label: "Status", kind: "string" },
      { key: "updated", label: "Updated", kind: "date" },
    ],
    rows: [{ path: "Notes/A.md", values: { name: "A", status: "active", updated: "2026-10-01" } }],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
    ...overrides,
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

function makeBrowser({ search = "" } = {}) {
  const location = { pathname: ROUTE, search };
  const history = {
    state: { kind: "obsidianWebNavigation", index: 0, path: BASE_PATH, documentKind: "base" },
    pushState() {},
    replaceState() {},
  };
  return { location, history, windowObject: { addEventListener() {}, removeEventListener() {} } };
}

async function renderSurface({ dto = page(), search = "", sort = null } = {}) {
  const host = document.createElement("div");
  const browser = makeBrowser({ search });
  const surface = createBaseSurface({
    host,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => dto }),
    enhance: () => {},
    storage: makeStorage(),
    locationObject: browser.location,
    historyObject: browser.history,
    windowObject: browser.windowObject,
    onOpenNote: () => {},
    onError: () => {},
  });
  await surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table", sort });
  return { host, surface };
}

function headerCells(host) {
  return host.querySelectorAll("th[data-column]");
}

test("a declared sort paints data-sort + one chevron on that column only", async () => {
  const { host, surface } = await renderSurface({
    dto: page({ viewSort: [{ key: "updated", dir: "desc" }] }),
  });
  const cells = headerCells(host);
  assert.equal(cells.length, 3);
  const sorted = cells.filter((cell) => cell.hasAttribute("data-sort"));
  assert.equal(sorted.length, 1, "exactly one column carries data-sort");
  assert.equal(sorted[0].getAttribute("data-column"), "updated");
  assert.equal(sorted[0].getAttribute("data-sort"), "DESC");
  // A column with no sort has NO attribute (desktop `setAttr("data-sort", null)`), not "".
  for (const cell of cells) {
    if (cell === sorted[0]) continue;
    assert.equal(cell.hasAttribute("data-sort"), false);
    assert.equal(cell.querySelector(".bases-table-header-sort"), null);
  }
  const marker = sorted[0].querySelector(".bases-table-header-sort");
  assert.ok(marker, "the marker box is a child of the header cell (desktop app.js@3227612)");
  const glyph = marker.querySelector("svg");
  assert.ok(glyph, "the marker carries an <svg><use> sprite reference");
  assert.match(glyph.querySelector("use").getAttribute("href"), /#chevron-down$/);
  surface.destroy();
});

test("the `?sort=` override wins over the declared sort, and ASC says so", async () => {
  const { host, surface } = await renderSurface({
    dto: page({ viewSort: [{ key: "updated", dir: "desc" }] }),
    sort: [{ key: "status", dir: "asc" }],
  });
  const cells = headerCells(host);
  const sorted = cells.filter((cell) => cell.hasAttribute("data-sort"));
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].getAttribute("data-column"), "status");
  assert.equal(sorted[0].getAttribute("data-sort"), "ASC");
  const marker = sorted[0].querySelector(".bases-table-header-sort");
  // icons.svg ships `chevron-down` but NOT `chevron-up`; ASC reuses the canonical glyph and
  // turns it 180deg in CSS (HANDOFF-HEADER-PARITY.md, glyph substitution — no invented path).
  assert.equal(marker.getAttribute("data-sort-glyph"), "chevron-down");
  assert.equal(marker.getAttribute("data-sort-direction"), "asc");
  surface.destroy();
});

test("no sort anywhere: zero markers and zero data-sort attributes", async () => {
  const { host, surface } = await renderSurface({ dto: page({ viewSort: [] }) });
  assert.equal(host.querySelectorAll(".bases-table-header-sort").length, 0);
  assert.equal(headerCells(host).filter((cell) => cell.hasAttribute("data-sort")).length, 0);
  surface.destroy();
});

test("the header reads the sort panel's own list — one source, no second state", async () => {
  const view = await fs.readFile(new URL("../frontend/app/features/bases/view.js", import.meta.url), "utf8");
  const marker = await fs.readFile(new URL("../frontend/app/features/bases/header-sort.js", import.meta.url), "utf8");
  assert.match(marker, /import \{ effectiveSortList \} from "\.\/panel-sort\.js";/);
  assert.match(marker, /for \(const entry of effectiveSortList\(state\)\)/);
  assert.match(view, /decorateHeaderCell\(doc, th, column\.key, state\);/);
  // Neither the renderer nor the marker may read the DTO's declared sort directly: that
  // would be a second copy of the `override ?? declared` rule the sort panel owns.
  for (const source of [view, marker]) {
    assert.equal(source.includes("state.viewSort"), false);
    assert.equal(source.includes("state.sort"), false);
  }
});

test("header typography + marker geometry stay on the desktop tokens", async () => {
  const { BASE_SURFACE_CSS } = await import("../frontend/app/features/bases/styles.js");
  // app.css@490050 with `--bases-table-font-size: var(--font-smaller)` (@58949 ⇒ 0.875em),
  // `--bases-table-header-weight: var(--font-weight)` (@58108 ⇒ 400) and
  // `--bases-table-header-color: var(--text-muted)` (@58159).
  assert.match(
    BASE_SURFACE_CSS,
    /\.base-table thead th\{[^}]*font-weight:var\(--bases-table-header-weight,var\(--font-weight,400\)\);font-size:var\(--bases-table-font-size,var\(--font-smaller,0\.875em\)\);/,
  );
  assert.match(BASE_SURFACE_CSS, /\.base-table thead th\{[^}]*color:var\(--bases-table-header-color,var\(--text-muted\)\);/);
  const headerRule = BASE_SURFACE_CSS.match(/\.base-table thead th\{[^}]*\}/)[0];
  assert.equal(/(font-weight:500|font-size:13\.5px)/.test(headerRule), false, "the old 500 / 13.5px header pair must not come back");
  // app.css@489702 marker box.
  assert.match(
    BASE_SURFACE_CSS,
    /\.base-table th \.bases-table-header-sort\{[^}]*position:absolute;inset-inline-end:0;top:-1px;height:100%;[^}]*display:flex;align-items:center;[^}]*color:var\(--text-muted\);\}/,
  );
  // 16px reserve + 24px fade on the sorted column only (app.css@489468 / @489359 / @58388).
  assert.match(
    BASE_SURFACE_CSS,
    /\.base-table th\[data-sort\] \.base-column-label\{[^}]*padding-inline-end:var\(--size-4-4,16px\);[^}]*mask-image:var\(--bases-table-header-sort-mask,linear-gradient\(to left,transparent var\(--size-4-6,24px\),black var\(--size-4-6,24px\)\)\);\}/,
  );
  assert.match(
    BASE_SURFACE_CSS,
    /\.base-table th\[data-sort\] \.base-column-label:dir\(rtl\)\{[^}]*linear-gradient\(to right,transparent/,
  );
});
