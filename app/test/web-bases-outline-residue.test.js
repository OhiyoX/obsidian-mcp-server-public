// P1-FINISH-2 regression: the outline pane must not keep the previous note's
// headings after the document surface switches to a Base.
//
// The navigation wiring clears the outline on Base entry (see
// features/navigation/base-navigation.js) and the normal note-open flow renders
// it again. This file locks the outline side of that contract: `clear()` returns
// the pane to the existing empty state and `setHeadings()` repopulates it.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createOutline } from "../frontend/app/features/context/outline.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.CSS = { escape: (value) => String(value) };

// U29 (#371) assertion migration: the no-note empty state now names both panes the rail shows
// (the seat ruling's goal ⑥). The SSR shell (pages.js) carries the same wording.
const EMPTY_TEXT = "打开笔记后显示大纲与反链";

function makeOutline() {
  const host = document.createElement("nav");
  const outline = createOutline({ host, getScrollRoot: () => null, onNavigate: () => {} });
  return { host, outline };
}

function headings() {
  return [
    { id: "h-alpha", text: "Alpha", level: 1, from: 0 },
    { id: "h-beta", text: "Beta", level: 2, from: 12 },
  ];
}

test("a fresh outline renders the existing empty state", () => {
  const { host } = makeOutline();
  assert.equal(host.querySelectorAll(".outline-item").length, 0);
  assert.equal(host.querySelector(".context-empty")?.textContent, EMPTY_TEXT);
});

test("note -> base clears the stale headings; base -> note renders them again", () => {
  const { host, outline } = makeOutline();

  // A note is open: its headings are rendered.
  outline.setHeadings(headings());
  assert.equal(host.querySelectorAll(".outline-item").length, 2);
  assert.match(host.textContent, /Alpha/);

  // Entering a Base clears to the empty state (base-navigation calls clear()).
  outline.clear();
  assert.equal(host.querySelectorAll(".outline-item").length, 0, "no stale note headings may survive a Base");
  assert.equal(host.querySelector(".context-empty")?.textContent, EMPTY_TEXT);

  // Returning to a note re-renders from the source model through the normal flow.
  outline.setHeadings([{ id: "h-gamma", text: "Gamma", level: 1, from: 0 }]);
  assert.equal(host.querySelectorAll(".outline-item").length, 1);
  assert.match(host.textContent, /Gamma/);
  assert.doesNotMatch(host.textContent, /Alpha/);
});

test("clear() accepts the existing empty-state message and defaults to it", () => {
  const { host, outline } = makeOutline();
  outline.setHeadings(headings());
  outline.clear();
  assert.equal(host.querySelector(".context-empty")?.textContent, EMPTY_TEXT);
  outline.clear("自定义");
  assert.equal(host.querySelector(".context-empty")?.textContent, "自定义");
});
