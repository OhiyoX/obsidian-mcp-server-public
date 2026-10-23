// Web Base formula UI (RECON §4 刀3, client half).
//
// Pins what the user can actually see:
//   1. a `formula.<name>` column renders in all three layouts (table / list /
//      cards) through the existing cell codec, with a visible ƒ marker;
//   2. the Properties popover shows the read-only formula definition (there is no
//      formula-write route, so it is shown, never edited);
//   3. a fail-closed formula error reaches the surface as a visible message whose
//      wording mirrors the desktop msgError* keys instead of the generic
//      "unsupported subset" text.
//
// Same DOM harness as the parity UI suite (no new dependency, no jsdom).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";
import { buildPropertiesPanel } from "../frontend/app/features/bases/panel-properties.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const ROUTE = "/app/base/r";
const BASE_PATH = "40-Projects/Project.base";
const FORMULA_EXPRESSION = "file.asLink(if(title, title, file.name))";

function page(view = { name: "Table", type: "table" }) {
  return {
    vaultId: "vault-1",
    path: BASE_PATH,
    route: ROUTE,
    revision: "rev-1",
    views: [
      { name: "Table", type: "table" },
      { name: "List", type: "list" },
      { name: "Cards", type: "cards" },
    ],
    view,
    columns: [
      { key: "file.name", label: "name", kind: "property", formula: null },
      {
        key: "formula.label",
        label: "Label",
        kind: "formula",
        formula: { name: "label", expression: FORMULA_EXPRESSION, displayName: "Label" },
      },
    ],
    rows: [
      {
        path: "Notes/A.md",
        values: {
          "file.name": "A",
          "formula.label": { path: "Notes/A.md", displayName: "A", kind: "asLink" },
        },
      },
    ],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
  };
}

function newSurface(body) {
  const host = document.createElement("div");
  const surface = createBaseSurface({
    host,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    enhance: () => {},
    storage: { getItem: () => null, setItem: () => {} },
    locationObject: { pathname: ROUTE, search: "" },
    historyObject: { state: null, pushState: () => {}, replaceState: () => {} },
    windowObject: { addEventListener: () => {}, removeEventListener: () => {} },
    onOpenNote: () => {},
    onError: () => {},
  });
  return { host, surface };
}

async function open(view) {
  const context = newSurface(page(view));
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: view.name });
  return context;
}

test("the table header marks a formula column with ƒ and a data attribute", async () => {
  const { host } = await open({ name: "Table", type: "table" });
  const th = host.querySelector('th[data-column-kind="formula"]');
  assert.notEqual(th, null);
  assert.equal(th.getAttribute("data-column"), "formula.label");
  assert.equal(th.querySelector(".base-column-label").textContent, "ƒ Label");
  // The plain property column is not marked.
  assert.equal(host.querySelector('th[data-column="file.name"]').getAttribute("data-column-kind"), null);
  // The evaluated value still goes through the shared cell codec (link button).
  const links = host.querySelectorAll("[data-cell-kind=link]");
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, "A");
});

test("the list layout marks the formula column and renders its value", async () => {
  const { host } = await open({ name: "List", type: "list" });
  const property = host.querySelector('.bases-list-property[data-column-kind="formula"]');
  assert.notEqual(property, null);
  assert.equal(property.getAttribute("data-column"), "formula.label");
  assert.equal(property.querySelector("[data-cell-kind=link]") !== null, true);
});

test("the cards layout shows the ƒ marker on the formula property label", async () => {
  const { host } = await open({ name: "Cards", type: "cards" });
  const property = host.querySelector('.bases-cards-property[data-column-kind="formula"]');
  assert.notEqual(property, null);
  assert.equal(property.querySelector(".bases-cards-label").textContent, "ƒ Label");
});

test("the Properties popover shows the formula definition (read-only)", () => {
  const columns = page().columns;
  const panel = buildPropertiesPanel({}, { doc: document, columns, visibleColumns: columns });
  const source = panel.querySelector('[data-formula-source="formula.label"]');
  assert.notEqual(source, null);
  assert.equal(source.textContent, `ƒ ${FORMULA_EXPRESSION}`);
  assert.equal(source.getAttribute("title"), FORMULA_EXPRESSION);
  // A plain property gets no formula source line.
  assert.equal(panel.querySelector('[data-formula-source="file.name"]'), null);
});

test("a fail-closed formula error shows the desktop-aligned message, not the generic 422 text", async () => {
  const host = document.createElement("div");
  const surface = createBaseSurface({
    host,
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: "unsupported", formula: { code: "formula-invalid-function", name: "label" } }),
    }),
    enhance: () => {},
    storage: { getItem: () => null, setItem: () => {} },
    locationObject: { pathname: ROUTE, search: "" },
    historyObject: { state: null, pushState: () => {}, replaceState: () => {} },
    windowObject: { addEventListener: () => {}, removeEventListener: () => {} },
    onOpenNote: () => {},
    onError: () => {},
  });
  await surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });
  const message = host.querySelector(".base-surface-error-message");
  assert.notEqual(message, null);
  assert.equal(message.textContent, "Invalid function in formula.");
  assert.equal(surface.getState().error.formula.code, "formula-invalid-function");
  assert.equal(surface.getState().error.formula.name, "label");
});
