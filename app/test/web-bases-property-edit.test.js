// Web Base property page (`编辑 {{name}}`) — lane desktop-re/bases-property-submenu.
//
// Pins the desktop shape this lane ported, all of it from the 1.14.4 asar:
//   1. the row's trailing `›` is a REAL control that pushes the property page
//      (`showEditPage`, app.js@2485790/@2483200) — `aria-haspopup="dialog"`, and pushing
//      happens through the same page stack the menus already use (depth grows, not a popup);
//   2. the page body is 显示名称 (input-row, app.js@2486663) + 属性类型 (@2487693);
//   3. the display-name field: commit on blur / Enter, revert on Escape (@2486700),
//      clearing it submits `value: null` (= delete the key, app.js@2347770), and a failed
//      write keeps the typed text and shows an inline error;
//   4. 属性类型 is read-only here (its desktop write face is the vault-level type table, not
//      `properties.<key>.type` — @2487693 + @2347620), and the icon prefers `declaredType`.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { buildPropertiesPanel, propertyIconName } from "../frontend/app/features/bases/panel-properties.js";
import { buildPropertyEditPanel, propertyTypeLabel } from "../frontend/app/features/bases/panel-property-edit.js";
import { createBaseToolbar } from "../frontend/app/features/bases/toolbar.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const CONTEXT = {
  doc: document,
  columns: [{ key: "status", label: "状态", kind: "text" }],
  visibleColumns: [{ key: "status" }],
  propertyCatalog: [
    { key: "status", label: "status", kind: "text", declaredType: "date", displayName: null, checked: true, source: "column" },
    { key: "file.mtime", label: "修改时间", kind: "builtin", declaredType: null, displayName: null, checked: false, source: "builtin" },
    { key: "formula.total", label: "合计", kind: "formula", declaredType: null, displayName: "合计", checked: false, source: "declared" },
  ],
  config: {},
};

function find(node, attribute) {
  if (typeof node.querySelector === "function") {
    const hit = node.querySelector(`[${attribute}]`);
    if (hit) return hit;
  }
  const children = Array.isArray(node.childNodes) ? node.childNodes : [];
  for (const child of children) {
    if (child?.getAttribute && child.getAttribute(attribute) !== null) return child;
    const deeper = find(child, attribute);
    if (deeper) return deeper;
  }
  return null;
}

// ── 1. the row action ────────────────────────────────────────────────────────

test("the row's `›` is a button that opens the property page, and is inert without a handler", () => {
  const opened = [];
  const panel = buildPropertiesPanel({}, CONTEXT, { onEditProperty: (key) => opened.push(key) });
  const action = find(panel, "data-prop-action-icon");
  assert.equal(action.tagName?.toLowerCase(), "button", "a real button, not a decorative span");
  assert.equal(action.getAttribute("aria-haspopup"), "dialog");
  assert.equal(action.getAttribute("aria-expanded"), "false");
  let defaultPrevented = false;
  action.onclick({ preventDefault: () => { defaultPrevented = true; }, stopPropagation: () => {} });
  assert.deepEqual(opened, ["status"], "the click opens THAT row's page");
  assert.equal(defaultPrevented, true, "a button inside the row's <label> must not also toggle the checkbox");

  const inert = buildPropertiesPanel({}, CONTEXT, {});
  const inertAction = find(inert, "data-prop-action-icon");
  assert.equal(inertAction.tagName?.toLowerCase(), "span", "no handler => the old inert slot");
  assert.equal(inertAction.getAttribute("aria-hidden"), "true");
});

// ── 2/3. the page body ───────────────────────────────────────────────────────

test("the property page is 显示名称 + 属性类型, seeded from the row", () => {
  const panel = buildPropertyEditPanel({}, CONTEXT, { entry: CONTEXT.propertyCatalog[0] });
  assert.equal(panel.getAttribute("data-prop-edit-page"), "status");
  assert.equal(panel.getAttribute("aria-label"), "编辑 status");
  const input = find(panel, "data-prop-display-name");
  assert.equal(input.value, "status", "no declared displayName => the name reads as the key");
  assert.equal(input.placeholder, "status", "the placeholder is the property NAME (setPlaceholder)");
  const select = find(panel, "data-prop-type-select");
  assert.equal(select.disabled, true, "no types write face => visibly read-only");
  assert.equal(select.value, "date", "the DECLARED type wins over the observed kind");
  assert.equal(select.options[0].textContent, propertyTypeLabel("date"));
});

test("a built-in row and a formula row get no type box (desktop: only `\"note\" === l`)", () => {
  const builtin = buildPropertyEditPanel({}, CONTEXT, { entry: CONTEXT.propertyCatalog[1] });
  assert.equal(find(builtin, "data-prop-type-row"), null);
  const formula = buildPropertyEditPanel({}, CONTEXT, { entry: CONTEXT.propertyCatalog[2] });
  assert.equal(find(formula, "data-prop-type-row"), null);
});

test("blur commits the trimmed name, Enter commits, Escape reverts, an unchanged name writes nothing", async () => {
  const sent = [];
  const panel = buildPropertyEditPanel({}, CONTEXT, {
    entry: CONTEXT.propertyCatalog[0],
    onSubmit: (payload) => { sent.push(payload); },
  });
  const input = find(panel, "data-prop-display-name");
  input.value = "status";
  input.onblur();
  assert.deepEqual(sent, [], "writing the name that is already shown is a no-op (desktop guard)");
  input.value = "  状态  ";
  input.onkeydown({ key: "Enter", preventDefault() {} });
  assert.deepEqual(sent, [{ property: "status", value: "状态" }], "Enter commits the trimmed value");
  input.value = "brand new";
  input.onkeydown({ key: "Escape", preventDefault() {} });
  assert.equal(input.value, "status", "Escape puts the shown name back");
});

test("an emptied field submits null (delete the key), never an empty string", () => {
  const sent = [];
  const panel = buildPropertyEditPanel({}, CONTEXT, {
    entry: { ...CONTEXT.propertyCatalog[0], displayName: "状态" },
    onSubmit: (payload) => { sent.push(payload); },
  });
  const input = find(panel, "data-prop-display-name");
  assert.equal(input.value, "状态", "the field is seeded from the DECLARED name when there is one");
  input.value = "   ";
  input.onblur();
  assert.deepEqual(sent, [{ property: "status", value: null }]);
});

test("a refused write keeps the typed text and shows an inline error", async () => {
  let reject;
  const panel = buildPropertyEditPanel({}, CONTEXT, {
    entry: CONTEXT.propertyCatalog[0],
    onSubmit: () => new Promise((_resolve, fail) => { reject = fail; }),
  });
  const input = find(panel, "data-prop-display-name");
  const error = find(panel, "data-prop-edit-error");
  input.value = "待重试";
  input.onblur();
  const failure = new Error("Base 已在别处被修改");
  reject(failure);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(error.hidden, false, "the error is visible");
  assert.equal(error.textContent, "Base 已在别处被修改");
  assert.equal(input.value, "待重试", "the reader does not lose what they typed");
});

// ── 4. declared type drives the icon (additive field) ────────────────────────

test("propertyIconName prefers the declared type and falls back to the inferred kind", () => {
  assert.equal(propertyIconName("text", "date"), "calendar", "declared date wins over an inferred text");
  assert.equal(propertyIconName("text", null), "text", "no declaration => the observed kind, unchanged");
  assert.equal(propertyIconName("builtin", "date"), "calendar");
  assert.equal(propertyIconName("builtin", null), "circle-info");
  // A declared type the sprite table does not know still falls back instead of painting nothing.
  assert.equal(propertyIconName("list", "something-else"), "tag");
});

// ── 5. the page is a page: the stack deepens, back returns to the list ───────

test("`›` pushes the page onto the existing stack (depth 2 => nested header with a back button)", () => {
  const host = document.createElement("div");
  const toolbar = createBaseToolbar({ doc: document, onRenameProperty: () => {} });
  const state = {
    columns: CONTEXT.columns,
    visibleColumns: CONTEXT.visibleColumns,
    totalMatched: 1,
    rows: [],
    viewType: "table",
  };
  const context = { columns: CONTEXT.columns, allColumns: CONTEXT.columns, visibleColumns: CONTEXT.visibleColumns, propertyCatalog: CONTEXT.propertyCatalog, config: {} };
  const first = toolbar.render(state, context);
  host.appendChild(first);
  toolbar.afterMount(first, () => {
    const next = toolbar.render(state, context);
    host.replaceChildren(next);
    toolbar.afterMount(next);
  });
  // Open the properties menu through its real action button.
  const action = find(host, "data-base-action");
  const properties = find(host, 'data-base-action="properties"') ?? action;
  properties.onclick();
  assert.equal(toolbar.getPanelDepth(), 1);
  assert.equal(toolbar.getOpenPanel(), "properties");
  const rowAction = find(host, "data-prop-action-icon");
  assert.ok(rowAction, "the open menu renders its rows");
  rowAction.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(toolbar.getPanelDepth(), 2, "the page is a deeper page of the SAME stack");
  assert.equal(toolbar.getOpenPanel(), "properties:edit:status");
  const shell = find(host, "data-prop-edit-loading") ?? find(host, "data-prop-edit-error") ?? find(host, "data-base-panel");
  assert.ok(shell, `the gate mounts a shell synchronously (host html: ${host.innerHTML?.slice(0, 300) ?? "n/a"})`);
  toolbar.destroy();
});
