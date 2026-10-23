// Cell codec matrix + XSS containment for the Base surface.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  EMPTY_CELL_TOKEN,
  createCellNode,
  describeCellValue,
  formatDateValue,
  isAsLinkCell,
  previewText,
} from "../frontend/app/features/bases/cell.js";
import { createBaseView, BASE_SURFACE_CSS } from "../frontend/app/features/bases/view.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;

const IMG_PAYLOAD = '<img src=x onerror="globalThis.__basePwned=1">';
const SCRIPT_PAYLOAD = "<script>globalThis.__basePwned=1</script>";

function assertNoInjectedNodes(root) {
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector("script"), null);
  for (const element of root.querySelectorAll("*")) {
    assert.equal(element.getAttribute("onerror"), null);
    assert.equal(element.getAttribute("onload"), null);
  }
  assert.equal(globalThis.__basePwned, undefined);
}

test("null and missing values share one empty token", () => {
  assert.deepEqual(describeCellValue(null), { type: "empty", text: EMPTY_CELL_TOKEN });
  assert.deepEqual(describeCellValue(undefined), { type: "empty", text: EMPTY_CELL_TOKEN });
  assert.equal(previewText(null), EMPTY_CELL_TOKEN);
});

test("scalars map to deterministic locale-neutral text", () => {
  assert.deepEqual(describeCellValue("hello"), { type: "string", text: "hello" });
  assert.deepEqual(describeCellValue(1234567), { type: "number", text: "1234567" });
  assert.deepEqual(describeCellValue(-0.5), { type: "number", text: "-0.5" });
  assert.deepEqual(describeCellValue(true), { type: "boolean", value: true, text: "true" });
  assert.deepEqual(describeCellValue(false), { type: "boolean", value: false, text: "false" });
});

test("date values keep the source and render the desktop `MM / DD / YYYY` form", () => {
  const explicit = describeCellValue("2026-10-04T15:30:00Z", "date");
  assert.equal(explicit.type, "date");
  assert.equal(explicit.value, "2026-10-04T15:30:00Z");
  assert.equal(explicit.iso, "2026-10-04");
  assert.equal(explicit.text, "10 / 04 / 2026");

  // A bare ISO calendar date is inferred without a declared date column, like desktop Bases.
  const inferred = describeCellValue("2026-09-11");
  assert.equal(inferred.type, "date");
  assert.equal(inferred.iso, "2026-09-11");
  assert.equal(inferred.text, "09 / 11 / 2026");

  // A YAML date arrives as an ISO timestamp and keeps the same calendar day.
  const stamped = describeCellValue("2026-09-19T00:00:00.000Z");
  assert.equal(stamped.type, "date");
  assert.equal(stamped.iso, "2026-09-19");
  assert.equal(stamped.text, "09 / 19 / 2026");

  assert.equal(formatDateValue("not-a-date"), "not-a-date");
  assert.equal(describeCellValue("2026-02-31").type, "string", "impossible calendar dates stay text");
});

test("a date cell is a time element with a datetime attribute and text", () => {
  const node = createCellNode(document, describeCellValue("2026-09-11"));
  assert.equal(node.tagName, "TIME");
  assert.equal(node.className, "base-cell-date");
  assert.equal(node.getAttribute("datetime"), "2026-09-11");
  assert.match(node.textContent, /2026/);
  assert.equal(node.querySelector("script"), null);
});

test("arrays become bounded chips with an overflow counter", () => {
  const descriptor = describeCellValue(["a", "b", "c", "d", "e"]);
  assert.equal(descriptor.type, "array");
  assert.equal(descriptor.items.length, 3);
  assert.equal(descriptor.overflow, 2);
  const node = createCellNode(document, descriptor);
  assert.equal(node.querySelectorAll(".base-cell-chip").length, 3);
  assert.equal(node.querySelector(".base-cell-more").textContent, "+2");
});

test("objects become a bounded safe text summary", () => {
  const descriptor = describeCellValue({ a: 1, b: "two", c: [3, 4], d: true, e: null });
  assert.equal(descriptor.type, "object");
  assert.equal(descriptor.entries.length, 4);
  assert.equal(descriptor.overflow, 1);
  const node = createCellNode(document, descriptor);
  assert.match(node.textContent, /a: 1/);
  assert.equal(node.querySelector(".base-cell-more").textContent, "+1");
});

test("deep/cyclic objects do not hang and never execute content", () => {
  const cyclic = { name: "root" };
  cyclic.self = cyclic;
  const descriptor = describeCellValue(cyclic);
  assert.equal(descriptor.type, "object");
  assert.match(previewText(cyclic), /root/);
});

test("structured asLink is the only clickable value", () => {
  const link = { path: "Notes/A.md", displayName: "A note", kind: "asLink" };
  assert.equal(isAsLinkCell(link), true);
  assert.equal(describeCellValue(link).type, "link");
  assert.equal(describeCellValue("[[Notes/A.md]]").type, "string");

  const opened = [];
  const node = createCellNode(document, describeCellValue(link), { onOpenNote: (arg) => opened.push(arg) });
  assert.equal(node.tagName, "BUTTON");
  assert.equal(node.className, "base-cell-link");
  assert.equal(node.getAttribute("data-cell-kind"), "link");
  assert.equal(node.textContent, "A note");
  node.click();
  assert.deepEqual(opened, [{ path: "Notes/A.md" }]);
});

test("a plain string that looks like a wikilink stays plain text", () => {
  const node = createCellNode(document, describeCellValue("[[Notes/A.md]]"));
  assert.equal(node.tagName, "SPAN");
  assert.equal(node.querySelector("button"), null);
  assert.equal(node.textContent, "[[Notes/A.md]]");
});

test("boolean cells expose a readonly semantic marker", () => {
  const node = createCellNode(document, describeCellValue(true));
  assert.equal(node.getAttribute("role"), "checkbox");
  assert.equal(node.getAttribute("aria-checked"), "true");
  assert.equal(node.getAttribute("aria-readonly"), "true");
  assert.equal(node.textContent, "true");
});

test("cell strings with HTML payloads are rendered as text only", () => {
  const node = createCellNode(document, describeCellValue(IMG_PAYLOAD));
  assert.equal(node.textContent, IMG_PAYLOAD);
  assertNoInjectedNodes(node);
});

test("array items with HTML payloads are rendered as text chips", () => {
  const node = createCellNode(document, describeCellValue([IMG_PAYLOAD, SCRIPT_PAYLOAD, "ok"]));
  assert.equal(node.textContent, `${IMG_PAYLOAD}${SCRIPT_PAYLOAD}ok`);
  assertNoInjectedNodes(node);
});

test("view render treats path, view name, column label and values as untrusted text", () => {
  const host = document.createElement("div");
  const view = createBaseView({ doc: document, host, onOpenNote: () => {} });
  view.render({
    path: IMG_PAYLOAD,
    views: [{ name: SCRIPT_PAYLOAD, type: "table" }],
    view: SCRIPT_PAYLOAD,
    columns: [{ key: "name", label: IMG_PAYLOAD, kind: "string" }],
    rows: [{ path: "Notes/A.md", values: { name: SCRIPT_PAYLOAD } }],
    totalMatched: 1,
    nextCursor: null,
    loading: false,
    error: null,
    catalogStale: false,
  });

  const text = host.textContent;
  assert.equal(text.includes(IMG_PAYLOAD), true);
  assert.equal(text.includes(SCRIPT_PAYLOAD), true);
  assertNoInjectedNodes(host);
});

test("view render keeps row/column order and marks the table semantics", () => {
  const host = document.createElement("div");
  const view = createBaseView({ doc: document, host, onOpenNote: () => {} });
  view.render({
    path: "Notes/Project.base",
    views: [{ name: "Table", type: "table" }],
    view: "Table",
    columns: [{ key: "name", label: "Name", kind: "string" }, { key: "status", label: "Status", kind: "string" }],
    rows: [
      { path: "Notes/B.md", values: { name: "B", status: "active" } },
      { path: "Notes/A.md", values: { name: "A", status: "done" } },
    ],
    totalMatched: 2,
    nextCursor: null,
    loading: false,
    error: null,
    catalogStale: false,
  });

  const headers = host.querySelectorAll("thead th").map((th) => th.textContent);
  assert.deepEqual(headers, ["Name", "Status"]);
  const firstCells = host.querySelectorAll("tbody tr")[0].querySelectorAll("td").map((td) => td.textContent);
  assert.deepEqual(firstCells, ["B", "active"]);
  assert.equal(host.querySelector("table").getAttribute("role"), "table");
});

test("view render uses the desktop tool-row, count and column hooks", () => {
  const host = document.createElement("div");
  const view = createBaseView({ doc: document, host, onOpenNote: () => {} });
  view.render({
    path: "Project.base",
    views: [{ name: "All", type: "table" }],
    view: "All",
    columns: [
      { key: "updated", label: "updated", kind: "property" },
      { key: "formula.link", label: "link", kind: "formula" },
    ],
    rows: [{ path: "A.md", values: { updated: "2026-09-11", "formula.link": { path: "A.md", displayName: "A", kind: "asLink" } } }],
    totalMatched: 1,
    nextCursor: null,
    loading: false,
    error: null,
    catalogStale: false,
  });
  // Desktop parity: the tool row names the CURRENT VIEW (the base file name lives
  // in the tab/breadcrumb and stays on `data-base-path`).
  assert.equal(host.querySelector(".base-surface").getAttribute("data-base-path"), "Project.base");
  assert.equal(host.querySelector(".base-view-select").value, "All");
  assert.equal(host.querySelector(".base-surface-count").textContent, "1 个结果");
  assert.equal(host.querySelector(".base-load-more"), null, "no cursor means no load-more control");
  // Chrome/structure source contract (not pixel assertions).
  assert.match(BASE_SURFACE_CSS, /\.base-surface-toolbar-icon\{/);
  assert.match(BASE_SURFACE_CSS, /\.base-column-icon\{/);
  assert.match(BASE_SURFACE_CSS, /\.base-cell-link\{[^}]*text-decoration:underline/);
  assert.match(BASE_SURFACE_CSS, /\.base-table th,\.base-table td\{[^}]*border-inline-end/);
});
