// kanban (the 4th desktop view type, RECON §1.1) — read-only rendering.
//
// Every assertion here has a negative control that turns it red:
//   ① column count == `groups.length`      (negative: drop a group from the DTO)
//   ② cards in a column == that group's count (negative: move a rowPath across)
//   ③ no `groupBy` (no `groups` in the DTO) => explicit error, never a fallback table
//   ④ column order == DTO order (`groupBy.direction`, SEMANTICS-FROZEN P9)
//      (negative control: the reversed direction renders the reversed order)
//   ⑤ the board's horizontal scroller exists, so a 375px viewport cannot grow the
//      document (negative control: the same probe with a column pinned to 400px and
//      no scroller — measured in real Chromium, evidence/probe-kanban.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";
import { BASE_SURFACE_CSS } from "../frontend/app/features/bases/styles.js";
import { KANBAN_BOARD_CSS, KANBAN_COLUMN_WIDTH, KANBAN_NO_GROUP_TEXT, resolveKanbanOptions } from "../frontend/app/features/bases/kanban-runtime.js";
import { BASE_VIEW_TYPE_KANBAN, resolveViewOptions } from "../frontend/app/features/bases/view-options.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

// The board is an ON-DEMAND asset (kanban-lazy.js is the eager gate, kanban-runtime.js
// the asset). The gate resolves its URL from the shell's own `data-kanban-src`, so these
// pins run through the real dynamic-import path: the attribute points at the real runtime
// module. Removing the attribute is the negative control for the gate (no asset published
// => no import at all).
const KANBAN_SRC = new URL("../frontend/app/features/bases/kanban-runtime.js", import.meta.url).href;
const chunkTag = document.createElement("script");
chunkTag.setAttribute("data-kanban-src", KANBAN_SRC);
document.head.appendChild(chunkTag);
function publishKanbanChunk(url) {
  if (url === null) chunkTag.removeAttribute("data-kanban-src");
  else chunkTag.setAttribute("data-kanban-src", url);
}

const ROUTE = "/app/base/r";
const BASE_PATH = "40-Projects/Projects.base";

const COLUMNS = [
  { key: "name", label: "Name", kind: "string" },
  { key: "status", label: "Status", kind: "string" },
  { key: "score", label: "Score", kind: "formula" },
];

const ROWS = [
  { path: "Notes/A.md", values: { name: "A", status: "active", score: 3 } },
  { path: "Notes/B.md", values: { name: "B", status: "done", score: 1 } },
  { path: "Notes/C.md", values: { name: "C", status: "done", score: 2 } },
];

// ASC (`direction: ASC` or absent) and DESC over the same retained rows: the frozen
// pipeline only ever moves GROUPS, so the row set is identical and the column order
// is reversed (SEMANTICS-FROZEN P9 / C5).
const GROUPS_ASC = [
  { key: "active", keyType: "string", count: 1, rowPaths: ["Notes/A.md"] },
  { key: "done", keyType: "string", count: 2, rowPaths: ["Notes/B.md", "Notes/C.md"] },
];
const GROUPS_DESC = [...GROUPS_ASC].reverse();

function page(overrides = {}) {
  return {
    vaultId: "vault-1",
    path: BASE_PATH,
    route: ROUTE,
    revision: "rev-1",
    views: [{ name: "Board", type: "kanban" }, { name: "Table", type: "table" }],
    view: { name: "Board", type: "kanban" },
    columns: COLUMNS,
    rows: ROWS,
    groups: GROUPS_ASC,
    totalMatched: ROWS.length,
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

let host = null;

async function openBoard(dto, storage = makeStorage()) {
  host = document.createElement("div");
  host.hidden = true;
  document.body.appendChild(host);
  const surface = createBaseSurface({
    host,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => dto }),
    storage,
    windowObject: globalThis,
  });
  await surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Board" });
  return { surface, host };
}

const columns = (node) => [...node.querySelectorAll(".bases-kanban-column")];
const labelOf = (column) => column.querySelector(".bases-kanban-column-label").textContent;
const cardPaths = (column) => [...column.querySelectorAll("[data-row-id]")].map((node) => node.getAttribute("data-row-id"));

test("① a kanban view renders one column per group, in DTO order", async () => {
  const { host: node } = await openBoard(page());
  assert.equal(node.querySelector(".base-surface").getAttribute("data-view-type"), "kanban");
  const board = node.querySelector("[data-base-kanban]");
  assert.notEqual(board, null);
  assert.equal(board.getAttribute("data-kanban-columns"), String(GROUPS_ASC.length));
  assert.equal(columns(node).length, GROUPS_ASC.length);
  assert.deepEqual(columns(node).map(labelOf), ["active", "done"]);
  assert.deepEqual(columns(node).map((column) => column.getAttribute("data-group-count")), ["1", "2"]);
  // The desktop column width is the kanban slider's own default (asar @3171058 / v7).
  assert.equal(board.style.getPropertyValue("--base-kanban-column-width"), `${KANBAN_COLUMN_WIDTH.fallback}px`);
});

test("② each column carries exactly its group's rows (same cells as the table)", async () => {
  const { host: node } = await openBoard(page());
  const [first, second] = columns(node);
  assert.deepEqual(cardPaths(first), GROUPS_ASC[0].rowPaths);
  assert.deepEqual(cardPaths(second), GROUPS_ASC[1].rowPaths);
  // Reuse of the cards item: the ƒ formula marker and the shared cell codec are the
  // ones the other layouts render, not a second formatter.
  assert.equal(first.querySelectorAll(".bases-cards-item").length, GROUPS_ASC[0].count);
  assert.match(second.textContent, /ƒ Score/);
  assert.equal(node.querySelectorAll(".base-table").length, 0);
  assert.equal(node.querySelectorAll(".base-col-resize").length, 0);
});

test("③ kanban without a groupBy fails closed with an explicit line", async () => {
  // No `groups` key at all == the view declares neither groupBy nor summaries.
  const { host: node } = await openBoard(page({ groups: undefined }));
  assert.equal(node.querySelector("[data-base-kanban]"), null);
  const error = node.querySelector("[data-kanban-error]");
  assert.notEqual(error, null);
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(error.textContent, KANBAN_NO_GROUP_TEXT);
  assert.equal(node.querySelector(".base-table"), null, "never a silent table fallback");
  // Negative control for ③: the same document WITH groups renders the board.
  const ok = await openBoard(page());
  assert.equal(ok.host.querySelector("[data-kanban-error]"), null);
  assert.equal(columns(ok.host).length, GROUPS_ASC.length);
});

test("④ column order follows the group direction, never a re-derivation", async () => {
  const asc = await openBoard(page());
  assert.deepEqual(columns(asc.host).map(labelOf), ["active", "done"]);
  // Negative control: the reversed `groupBy.direction` DTO renders the reversed order.
  const desc = await openBoard(page({ groups: GROUPS_DESC }));
  assert.deepEqual(columns(desc.host).map(labelOf), ["done", "active"]);
  assert.notDeepEqual(columns(desc.host).map(labelOf), columns(asc.host).map(labelOf));
  // …and the row SET is unchanged (only groups move, P9/C5).
  assert.deepEqual(
    columns(desc.host).flatMap(cardPaths).sort(),
    columns(asc.host).flatMap(cardPaths).sort(),
  );
});

test("empty states: an empty group and an empty partition both explain themselves", async () => {
  const withEmpty = await openBoard(page({
    groups: [...GROUPS_ASC, { key: "todo", keyType: "string", count: 0, rowPaths: [] }],
  }));
  const empty = columns(withEmpty.host).find((column) => labelOf(column) === "todo");
  assert.equal(empty.querySelectorAll("[data-row-id]").length, 0);
  assert.match(empty.textContent, /No rows in this group\./);
  // A keyless group renders desktop's own label (`i18n` labelGroupKeyNone:"None").
  const none = await openBoard(page({ groups: [{ key: null, keyType: "null", count: 3, rowPaths: ROWS.map((row) => row.path) }] }));
  assert.deepEqual(columns(none.host).map(labelOf), ["None"]);
  assert.equal(none.host.querySelectorAll(".bases-cards-item").length, 3);
  const noGroups = await openBoard(page({ groups: [] }));
  assert.equal(columns(noGroups.host).length, 0);
  assert.match(noGroups.host.textContent, /No groups to show\./);
});

test("⑤ the board is its own horizontal scroller (the 375px overflow contract)", async () => {
  // The document must never be widened by the board: the wrapper scrolls. The rules ship
  // in the lazy asset now (KANBAN_BOARD_CSS, injected at runtime), so they are read there;
  // this is the CSS half. The measured half (real Chromium, 375x667, scrollWidth <=
  // innerWidth) is evidence/probe-bases-kanban.mjs.
  const wrap = /\.base-kanban-wrap\{([^}]*)\}/.exec(KANBAN_BOARD_CSS);
  assert.notEqual(wrap, null);
  assert.match(wrap[1], /overflow:auto/);
  assert.match(wrap[1], /min-height:0/);
  assert.equal(/\.base-kanban-wrap/.test(BASE_SURFACE_CSS), false, "the first-screen stylesheet must not carry the board");
  // The column keeps the declared width instead of shrinking into the viewport.
  const column = /\.bases-kanban-column\{([^}]*)\}/.exec(KANBAN_BOARD_CSS);
  assert.match(column[1], /flex:0 0 var\(--base-kanban-column-width/);
  const { host: node } = await openBoard(page());
  // No inline width is written on a column: the single source is the custom property.
  assert.doesNotMatch(node.querySelector(".bases-kanban-column").getAttribute("style") ?? "", /width/);
});

test("kanban options: the desktop columnWidth slider domain and its non-number fallback", async () => {
  // The slider domain belongs to the layout's own asset; the eager resolver no longer
  // knows kanban's `columnWidth` (it hands the cards options over instead).
  assert.deepEqual(KANBAN_COLUMN_WIDTH, { min: 200, max: 500, step: 10, fallback: 280 });
  assert.equal(resolveKanbanOptions(undefined).columnWidth, 280);
  assert.equal(resolveKanbanOptions({ columnWidth: 500 }).columnWidth, 500);
  assert.equal(resolveKanbanOptions({ columnWidth: 900 }).columnWidth, 500);
  assert.equal(resolveKanbanOptions({ columnWidth: 12 }).columnWidth, 200);
  for (const bad of [0, -1, "wide", null, undefined, NaN]) {
    assert.equal(resolveKanbanOptions({ columnWidth: bad }).columnWidth, 280, `${String(bad)}`);
  }
  assert.equal(resolveViewOptions("kanban").columnWidth, undefined, "the eager resolver must not resolve the lazy option");
  assert.deepEqual(resolveViewOptions("kanban"), resolveViewOptions("cards"), "kanban reuses the cards options");
  assert.equal(BASE_VIEW_TYPE_KANBAN, "kanban");
  // The chosen value reaches the board through the custom property, not inline widths.
  const { host: node } = await openBoard(page());
  assert.equal(node.querySelector(".bases-kanban-board").style.getPropertyValue("--base-kanban-column-width"), "280px");
});
