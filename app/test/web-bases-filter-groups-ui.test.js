// G3/G4 front-end: the `filters` payload codec (legacy AND list vs desktop group)
// and the advanced (raw expression) mode entry in the filter popover.
//
// The server is the fail-closed authority for shapes (web-base-params +
// base-query); this file proves the CLIENT emits the right payload for the
// conjunction selector and the advanced editor, and that the legacy URL shape is
// still produced for an AND filter.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  BASE_FILTER_OPS,
  BASE_FILTER_OPS_NOVALUE,
  buildBaseSearch,
  filterParam,
  normalizeFilter,
  parseBaseSearch,
} from "../frontend/app/features/bases/query-state.js";
import { BASE_FILTER_MESSAGES, buildFilterPanel, withConjunction } from "../frontend/app/features/bases/panel-filter.js";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;

const COLUMNS = [
  { key: "name", label: "Name", kind: "property" },
  { key: "status", label: "Status", kind: "property" },
];

test("the legacy AND list keeps its exact URL encoding and normalization", () => {
  const legacy = [{ key: "status", op: "is", value: "active" }, { key: "name", op: "is-not-empty" }];
  assert.deepEqual(normalizeFilter(legacy), legacy);
  assert.equal(filterParam(legacy), JSON.stringify(legacy));
  assert.equal(buildBaseSearch({ filter: legacy }), `?filter=${encodeURIComponent(JSON.stringify(legacy))}`);
  assert.deepEqual(parseBaseSearch(buildBaseSearch({ filter: legacy })).filter, legacy);
  // A value-less operator never carries a value, exactly as before G4.
  assert.deepEqual(normalizeFilter([{ key: "name", op: "has-property", value: 7 }]), [{ key: "name", op: "has-property" }]);
});

test("group payloads round-trip through the URL, nested included", () => {
  const group = {
    or: [
      { key: "status", op: "is", value: "active" },
      { not: [{ key: "name", op: "contains", value: "x" }] },
    ],
  };
  assert.deepEqual(normalizeFilter(group), group);
  assert.deepEqual(parseBaseSearch(buildBaseSearch({ filter: group })).filter, group);
  // `and` degrades back to the legacy array (byte-identical pre-G3 URL).
  assert.deepEqual(withConjunction(group, "and"), group.or);
  assert.deepEqual(withConjunction([{ key: "name", op: "is", value: "A" }], "not"), {
    not: [{ key: "name", op: "is", value: "A" }],
  });
});

test("the G4 operator table is exposed to the builder with its value-less members", () => {
  for (const op of ["contains-any", "contains-all", "matches", "has-property", "has-link", "in-folder", "has-tag"]) {
    assert.ok(BASE_FILTER_OPS.includes(op), op);
  }
  assert.deepEqual(BASE_FILTER_OPS_NOVALUE, ["is-empty", "is-not-empty", "has-property"]);
});

// --- popover -----------------------------------------------------------------

function buildPanel(filter) {
  const calls = [];
  const panel = buildFilterPanel(
    { filter, columns: COLUMNS },
    { doc: document, columns: COLUMNS },
    { onFilter: (list) => calls.push(list) },
  );
  return { panel, calls };
}

test("an expression payload opens the advanced editor and refuses simple mode visibly", () => {
  const { panel, calls } = buildPanel(['status == "active"', "file.hasTag(\"work\")"]);
  const area = panel.querySelector("[data-filter-advanced-mode]");
  assert.notEqual(area, null);
  assert.equal(area.value, 'status == "active"\nfile.hasTag("work")');
  // No simple rows while the payload is an expression filter.
  assert.equal(panel.querySelectorAll("[data-filter-row]").length, 0);

  // Simple mode cannot represent it: desktop `msgFilterSimpleUnavailable`.
  const mode = panel.querySelector("[data-filter-mode]");
  mode.click();
  assert.equal(panel.querySelector("[data-filter-message]").textContent, BASE_FILTER_MESSAGES.simpleUnavailable);
  assert.equal(calls.length, 0);

  // Editing the textarea emits the explicit group payload (review F1): a bare
  // string array used to be dropped by the controller's normalizeFilter.
  area.value = 'score > 8\n\nfile.hasLink("Beta")';
  area.dispatchEvent({ type: "change" });
  assert.deepEqual(calls.at(-1), { and: ['score > 8', 'file.hasLink("Beta")'] });
});

test("simple mode refuses to guess an expression for existing conditions", () => {
  const { panel, calls } = buildPanel([{ key: "status", op: "is", value: "active" }]);
  assert.equal(panel.querySelector("[data-filter-advanced-mode]"), null);
  panel.querySelector("[data-filter-mode]").click();
  assert.equal(panel.querySelector("[data-filter-message]").textContent, BASE_FILTER_MESSAGES.simpleUnavailable);
  assert.equal(calls.length, 0);
});

// ── end-to-end: panel → controller → state → URL → request (review F1) ──────
//
// The round-1 UI test only asserted the payload handed to `onFilter`, which is
// exactly how the advanced-mode bug escaped: the controller's `normalizeFilter`
// dropped the string leaves afterwards. These tests drive the REAL toolbar /
// popover DOM and assert the public state, the history URL and the request.

const ROUTE = "/app/base/Notes%2FProject.base";

function surfacePage() {
  return {
    vaultId: "vault-1",
    path: "Notes/Project.base",
    route: ROUTE,
    revision: "rev-1",
    views: [{ name: "Table", type: "table" }],
    view: { name: "Table", type: "table" },
    columns: [
      { key: "name", label: "Name", kind: "string" },
      { key: "status", label: "Status", kind: "string" },
    ],
    rows: [{ path: "Notes/A.md", values: { name: "A", status: "active" } }],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
  };
}

function newSurface({ search = "" } = {}) {
  const host = document.createElement("div");
  const calls = [];
  const history = { state: null, pushed: [], pushState: (_s, _t, href) => history.pushed.push(href), replaceState: () => {} };
  const locationObject = { pathname: ROUTE, search };
  const surface = createBaseSurface({
    host,
    fetchImpl: async (url) => { calls.push({ url }); return { ok: true, status: 200, json: async () => surfacePage() }; },
    enhance: () => {},
    storage: { getItem: () => null, setItem: () => {} },
    locationObject,
    historyObject: history,
    windowObject: { addEventListener: () => {}, removeEventListener: () => {} },
    onOpenNote: () => {},
    onError: () => {},
  });
  return { host, surface, calls, history, locationObject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function filterFromUrl(href) {
  const query = String(href).split("?")[1] ?? "";
  const raw = new URLSearchParams(query).get("filter");
  return raw === null ? null : JSON.parse(raw);
}

test("F1 e2e: an advanced payload survives controller → state → URL → request", async () => {
  const expression = "score > 8";
  const search = `?filter=${encodeURIComponent(JSON.stringify([expression]))}`;
  const { host, surface, calls, history } = newSurface({ search });
  await surface.open({ vaultId: "vault-1", path: "Notes/Project.base", route: ROUTE, view: "Table" });

  // URL → state: the top-level string leaf is accepted, not dropped.
  assert.deepEqual(surface.getState().filter, [expression]);
  // state → request: the first page carries the expression.
  assert.deepEqual(filterFromUrl(calls[0].url), [expression]);

  // Open the real filter popover and edit the advanced textarea.
  const action = host.querySelector('[data-base-action="filter"]');
  assert.notEqual(action, null);
  action.click();
  const area = host.querySelector("[data-filter-advanced-mode]");
  assert.notEqual(area, null);
  assert.equal(area.value, expression);

  const next = ['score > 8', 'file.hasLink("Beta")'];
  area.value = next.join("\n");
  area.dispatchEvent({ type: "change" });
  await settle();

  // panel → controller → state: both leaves survive normalizeFilter.
  assert.deepEqual(surface.getState().filter, { and: next });
  // state → URL (history push) and state → request.
  assert.deepEqual(filterFromUrl(history.pushed.at(-1)), { and: next });
  assert.deepEqual(filterFromUrl(surface.getRoute()), { and: next });
  assert.deepEqual(filterFromUrl(calls.at(-1).url), { and: next });
});

test("F1 e2e: a top-level expression array round-trips URL → state → request", async () => {
  const parsed = parseBaseSearch(`?filter=${encodeURIComponent(JSON.stringify(["score > 8"]))}`);
  assert.deepEqual(parsed.filter, ["score > 8"]);
  assert.deepEqual(filterFromUrl(buildBaseSearch({ filter: parsed.filter })), ["score > 8"]);

  const { surface, calls } = newSurface({ search: `?filter=${encodeURIComponent(JSON.stringify(["score > 8"]))}` });
  await surface.open({ vaultId: "vault-1", path: "Notes/Project.base", route: ROUTE, view: "Table" });
  assert.deepEqual(surface.getState().filter, ["score > 8"]);
  assert.deepEqual(filterFromUrl(calls[0].url), ["score > 8"]);
});

test("F3 e2e: an empty `or` group is not collapsed on its way to the request", async () => {
  const search = `?filter=${encodeURIComponent(JSON.stringify({ or: [] }))}`;
  const { surface, calls } = newSurface({ search });
  await surface.open({ vaultId: "vault-1", path: "Notes/Project.base", route: ROUTE, view: "Table" });
  assert.deepEqual(surface.getState().filter, { or: [] });
  assert.deepEqual(filterFromUrl(calls[0].url), { or: [] });
  assert.deepEqual(filterFromUrl(surface.getRoute()), { or: [] });
});
