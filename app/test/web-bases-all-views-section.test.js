// U12 — `所有视图` section + the two real condition counts (owner ruling 2026-10-23).
//
// The owner's Bases panel was missing a whole BLOCK, not a style: the desktop filter
// menu draws `所有视图` (the Base-file-level `filters:`) above `当前视图` (the selected
// view's), each with the number of its conditions in a `.flair`, and one condition row
// per leaf. The Web DTO exposed neither layer, so the client had no honest count.
//
// This file pins the three seams end to end:
//   1. the server projection of both layers (`app/src/base-filter-summary.js`), on the
//      owner's REAL anchor: `Projects.base` → `filters.and` with 2 conditions, first
//      view `开发 dev` → `filters: kind == "dev"` with 1;
//   2. the additive DTO through the REAL HTTP route + REAL snapshot adapter;
//   3. the panel DOM (`所有视图` / `当前视图`, flair text, read-only rows) and the two
//      degradations: no `filters` (older server) and a malformed layer.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import { applyBasePage, createBaseState } from "../frontend/app/features/bases/state.js";
import { summarizeBaseFilters } from "../src/base-filter-summary.js";
import { createBaseSnapshotEvaluator } from "../src/app/base-snapshot-adapter.js";
import { registerBaseRoute } from "../src/app/base-route.js";
import { readBaseInRoot } from "../src/app/base-reader.js";

// The owner's file, reduced to the two facts the acceptance anchors on
// (`D:/Obsidian/vault/_Workspace/40-Projects/Projects.base`, read-only source).
const PROJECTS_BASE = [
  "filters:",
  "  and:",
  "    - 'file.inFolder(\"_Workspace/40-Projects\")'",
  "    - 'file.ext == \"md\"'",
  "properties:",
  "  kind:",
  "    displayName: 类型",
  "views:",
  "  - type: table",
  "    name: 开发 dev",
  "    order:",
  "      - file.name",
  "      - kind",
  "    filters:",
  "      and:",
  "        - 'kind == \"dev\"'",
  "  - type: table",
  "    name: 全部",
  "    order:",
  "      - file.name",
  "",
].join("\n");

// --- 1. the projection ------------------------------------------------------

test("the two declared layers are projected with their leaf counts (owner anchor)", () => {
  const base = {
    filters: {
      and: ['file.inFolder("_Workspace/40-Projects")', 'file.ext == "md"'],
    },
  };
  const view = { name: "开发 dev", filters: { and: ['kind == "dev"'] } };
  assert.deepEqual(summarizeBaseFilters({ base, view }), {
    base: {
      conjunction: "and",
      count: 2,
      conditions: [
        // A call this subset evaluates through its P0 regex table, not through the
        // expression parser: property/operator/value stay null, the author's own
        // expression is the honest projection.
        { property: null, operator: null, value: null, expression: 'file.inFolder("_Workspace/40-Projects")' },
        { property: "file.ext", operator: "is", value: "md", expression: 'file.ext == "md"' },
      ],
    },
    view: {
      conjunction: "and",
      count: 1,
      conditions: [{ property: "kind", operator: "is", value: "dev", expression: 'kind == "dev"' }],
    },
  });
});

test("a layer that declares nothing is null; a declared empty group is count 0", () => {
  assert.deepEqual(summarizeBaseFilters({ base: {}, view: {} }), { base: null, view: null });
  assert.deepEqual(summarizeBaseFilters({}), { base: null, view: null });
  const empty = summarizeBaseFilters({ base: { filters: { or: [] } } });
  assert.deepEqual(empty.base, { conjunction: "or", count: 0, conditions: [] });
  // The legacy AND list reads as `and`, and a bare expression leaf is conjunction-less.
  assert.equal(summarizeBaseFilters({ base: { filters: ["a == 1"] } }).base.conjunction, "and");
  assert.equal(summarizeBaseFilters({ base: { filters: "a == 1" } }).base.conjunction, null);
  // Nested groups still count their LEAVES (the anecdote the flair must not lose).
  const nested = summarizeBaseFilters({ base: { filters: { and: ["a == 1", { or: ["b == 2", "c == 3"] }] } } });
  assert.equal(nested.base.count, 3);
});

// --- 2. the DTO through the real route + real adapter -----------------------

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-allviews-"));
const vaultDir = path.join(root, "vault");
await fs.mkdir(path.join(vaultDir, "_Workspace/40-Projects"), { recursive: true });
await fs.writeFile(path.join(vaultDir, "_Workspace/40-Projects/Projects.base"), PROJECTS_BASE);
await fs.writeFile(path.join(vaultDir, "_Workspace/40-Projects/Dev note.md"), "---\nkind: dev\n---\n");
await fs.writeFile(path.join(vaultDir, "_Workspace/40-Projects/Other note.md"), "---\nkind: other\n---\n");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function record(relativePath, kind) {
  return {
    path: relativePath,
    basename: path.posix.basename(relativePath, ".md"),
    frontmatter: { kind },
    tags: [],
    links: [],
    stat: { size: 1, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" },
  };
}

async function startBaseServer() {
  const app = express();
  const router = express.Router();
  registerBaseRoute(router, {
    requireApi(req, _res, next) {
      req.webSession = { allowedScopes: ["obsidian.read"] };
      next();
    },
    async currentVault() {
      return { id: "primary", root: vaultDir };
    },
    readBase: readBaseInRoot,
    async loadRecords() {
      return {
        records: [
          record("_Workspace/40-Projects/Dev note.md", "dev"),
          record("_Workspace/40-Projects/Other note.md", "other"),
          record("Elsewhere/Other.md", "dev"),
        ],
        catalog: { catalogId: "cat-1", generation: 1, stale: false },
        complete: true,
      };
    },
    evaluateSnapshot: createBaseSnapshotEvaluator(),
  });
  app.use(router);
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function fetchBase(query) {
  const server = await startBaseServer();
  try {
    const response = await fetch(`${server.base}/api/web/v1/base${query}`, { signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json() };
  } finally {
    await server.close();
  }
}

test("the DTO carries both layers and keeps `capabilities` grouping-capable", async () => {
  const { status, body } = await fetchBase(`?path=${encodeURIComponent("_Workspace/40-Projects/Projects.base")}`);
  assert.equal(status, 200);
  // The NEW key is additive: everything the pre-U12 contract promised still holds.
  // `grouping` is the lane desktop-re/bases-grouping truth flip (the server executes it).
  assert.deepEqual(body.capabilities, { editable: false, grouping: true, aggregation: false });
  assert.equal(body.supportedSubset, true);
  assert.equal(body.view.name, "开发 dev");
  assert.deepEqual(body.filters.base, {
    conjunction: "and",
    count: 2,
    conditions: [
      { property: null, operator: null, value: null, expression: 'file.inFolder("_Workspace/40-Projects")' },
      { property: "file.ext", operator: "is", value: "md", expression: 'file.ext == "md"' },
    ],
  });
  assert.deepEqual(body.filters.view, {
    conjunction: "and",
    count: 1,
    conditions: [{ property: "kind", operator: "is", value: "dev", expression: 'kind == "dev"' }],
  });
});

test("an unfiltered view still reports both layers as JSON objects with null members", async () => {
  const { body } = await fetchBase(`?path=${encodeURIComponent("_Workspace/40-Projects/Projects.base")}&view=${encodeURIComponent("全部")}`);
  assert.deepEqual(body.filters, { base: body.filters.base, view: null });
  assert.equal(body.filters.base.count, 2);
});

// --- 3. the panel DOM -------------------------------------------------------

const harness = createDomHarness();
harness.install();
const document = harness.document;

const COLUMNS = [
  { key: "file.name", label: "名称", kind: "property" },
  { key: "kind", label: "类型", kind: "property" },
];

const DTO_FILTERS = {
  base: {
    conjunction: "and",
    count: 2,
    conditions: [
      { property: null, operator: null, value: null, expression: 'file.inFolder("_Workspace/40-Projects")' },
      { property: "file.ext", operator: "is", value: "md", expression: 'file.ext == "md"' },
    ],
  },
  view: {
    conjunction: "and",
    count: 1,
    conditions: [{ property: "kind", operator: "is", value: "dev", expression: 'kind == "dev"' }],
  },
};

function buildPanel(state = {}) {
  const calls = [];
  const api = createBasePanels({ doc: document, close() {}, onFilter: (next) => calls.push(next) });
  const panel = api.build(
    "filter",
    { filter: [], q: "", columns: COLUMNS, rows: [], path: "Projects.base", ...state },
    { doc: document, columns: COLUMNS, visibleColumns: COLUMNS, config: { hidden: [], widths: {} } },
  );
  return { panel, calls };
}

test("所有视图 is drawn above 当前视图, with the real count in each flair", () => {
  const { panel } = buildPanel({ filters: DTO_FILTERS });
  const groups = panel.querySelectorAll("[data-filter-group]");
  assert.deepEqual(groups.map((group) => group.getAttribute("data-filter-group")), ["base", "view"]);
  assert.deepEqual(groups.map((group) => group.querySelector(".base-panel-section-label").textContent), ["所有视图", "当前视图"]);
  const flairs = groups.map((group) => group.querySelector("[data-section-count]"));
  assert.deepEqual(flairs.map((flair) => flair.textContent), ["2", "1"]);
  assert.deepEqual(flairs.map((flair) => flair.getAttribute("hidden")), [null, null]);
  assert.equal(flairs[0].className, "base-panel-count flair");
});

test("the declared conditions are READ-ONLY rows in one bordered box per section", () => {
  const { panel, calls } = buildPanel({ filters: DTO_FILTERS });
  const baseRows = panel.querySelectorAll('[data-filter-statements="base"] [data-filter-declared]');
  const viewRows = panel.querySelectorAll('[data-filter-statements="view"] [data-filter-declared]');
  assert.deepEqual(baseRows.map((row) => row.getAttribute("data-filter-declared")), ["0", "1"]);
  assert.deepEqual(viewRows.map((row) => row.getAttribute("data-filter-declared")), ["0"]);

  // Row 0 is the expression dialect leaf (no editor could be honest about it), row 1
  // is the desktop triple 条件 [property] [operator] [value].
  const expression = baseRows[0].querySelector(".base-panel-condition-expression");
  assert.equal(expression.textContent, 'file.inFolder("_Workspace/40-Projects")');
  assert.deepEqual(
    [...baseRows[1].querySelectorAll(".base-panel-condition-part")].map((part) => part.textContent),
    ["file.ext", "等于", "md"],
  );
  assert.deepEqual(
    [...viewRows[0].querySelectorAll(".base-panel-condition-part")].map((part) => part.textContent),
    ["kind", "等于", "dev"],
  );
  // Read-only means read-only: no control inside a declared row, and nothing the row
  // can be clicked into emits a filter write.
  for (const row of [...baseRows, ...viewRows]) {
    assert.deepEqual(row.querySelectorAll("select, input, textarea, button"), []);
    row.click?.();
  }
  assert.deepEqual(calls, []);
});

test("the 当前视图 flair counts the declared layer PLUS the URL overrides", () => {
  const { panel } = buildPanel({
    filters: DTO_FILTERS,
    filter: [{ key: "kind", op: "is", value: "ops" }],
  });
  const view = panel.querySelector('[data-filter-group="view"]');
  assert.equal(view.querySelector("[data-section-count]").textContent, "2");
  // The editable override row is still there, in its own (unboxed) row.
  assert.equal(panel.querySelectorAll("[data-filter-row]").length, 1);
});

test("the counts come from the DTO, not from `conditions.length` (hardcode control)", () => {
  // A layer whose declared count disagrees with the rows it ships: the flair must
  // follow the DTO (the desktop's own counter), so a hardcoded/derived number fails.
  const { panel } = buildPanel({
    filters: { base: { conjunction: "and", count: 7, conditions: [] }, view: null },
  });
  assert.equal(panel.querySelector('[data-filter-group="base"] [data-section-count]').textContent, "7");
  assert.equal(panel.querySelector('[data-filter-statements="base"]'), null, "0 rows, no empty box");
});

test("no DTO filters: no 所有视图 section and the pre-U12 count (degrades, never throws)", () => {
  const { panel } = buildPanel({ filter: [{ key: "kind", op: "is", value: "dev" }] });
  assert.equal(panel.textContent.includes("所有视图"), false);
  assert.equal(panel.querySelectorAll("[data-filter-group]").length, 1);
  assert.equal(panel.querySelector("[data-section-count]").textContent, "1");
});

test("a malformed layer degrades to no rows instead of crashing the menu", () => {
  const { panel } = buildPanel({
    filters: { base: { conjunction: "xor", count: "two", conditions: "nope" }, view: { conditions: [null, 7, {}] } },
  });
  const base = panel.querySelector('[data-filter-group="base"]');
  assert.equal(base.querySelector(".base-panel-section-label").textContent, "所有视图");
  // `count: "two"` is not a number -> the honest fallback is 0 (flair hidden).
  assert.equal(base.querySelector("[data-section-count]").getAttribute("hidden"), "");
  assert.equal(panel.querySelector('[data-filter-statements="base"]'), null);
  // `{}` survives normalization but has no property and no expression: the row is
  // drawn with an empty slot rather than with an invented label.
  const viewRow = panel.querySelector('[data-filter-statements="view"] [data-filter-declared="0"]');
  assert.equal(viewRow.querySelector(".base-panel-condition-expression").textContent, "");
});

// --- 4. state seam ----------------------------------------------------------

test("applyBasePage keeps the summary, and a load-more page never blanks it", () => {
  const state = createBaseState();
  applyBasePage(state, { path: "Projects.base", filters: DTO_FILTERS, rows: [] });
  assert.deepEqual(state.filters, DTO_FILTERS);
  applyBasePage(state, { rows: [] }, { append: true });
  assert.deepEqual(state.filters, DTO_FILTERS, "a partial page must not clear the section");
  // A DTO without the key (older server) is `null`, never `undefined`.
  const legacy = createBaseState();
  applyBasePage(legacy, { path: "Old.base", rows: [] });
  assert.equal(legacy.filters, null);
});
