// U48 (#409) — the focus handoff and surface lifecycle contract of the custom `<select>`.
//
// Split out of `test/ui/select.test.js` to keep both files inside the line budget. The
// interaction model itself (roles, roving focus, Arrow/Home/End, Enter/Space commit, Escape,
// listener bookkeeping) lives there; this file covers the two defects the batch-5 review
// reproduced in the real application:
//
//   1. a keyboard commit whose consumer replaces the whole subtree from inside its synchronous
//      `change` handler (`features/bases/view.js`) must not leave the focus on a detached
//      trigger — the real symptom was `document.activeElement === BODY`;
//   2. a listbox left open when its surface is hidden or replaced must stop owning the document
//      keys instead of swallowing the next keystroke.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createDomHarness } from "../helpers/base-dom.mjs";
import { enhanceSelects } from "../../frontend/app/ui/select.js";

const dom = createDomHarness();
dom.install();

const live = [];

// One `select[data-select]` in the shape the Base view control builds. `focusKey` is the
// consumer-declared focus identity of the control (`data-focus` on the native select).
function scene({ value = "a", focusKey = null, track = true } = {}) {
  const host = dom.createElement("div");
  const select = dom.createElement("select");
  select.className = "slot-select";
  select.setAttribute("data-select", "");
  select.setAttribute("aria-label", "视图");
  if (focusKey) select.setAttribute("data-focus", focusKey);
  for (const [optionValue, label] of [["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"]]) {
    const option = dom.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  host.append(select);
  dom.document.body.replaceChildren(host);

  const handle = { host, select, control: enhanceSelects(host) };
  handle.wrapper = host.querySelector(".select-control");
  handle.trigger = host.querySelector(".select-trigger");
  handle.menu = host.querySelector(".select-menu");
  handle.items = () => [...handle.menu.querySelectorAll(".select-option")];
  if (track) live.push(handle);
  return handle;
}

const keyOn = (node, name) => node.dispatchEvent({ type: "keydown", key: name });
const key = (name) => dom.document.dispatchEvent({ type: "keydown", key: name });
const focusOf = () => dom.document.activeElement;

// A spy payload, so a test can assert whether the control consumed the keystroke.
function spyKey(name) {
  const calls = { prevented: 0, stopped: 0 };
  dom.document.dispatchEvent({
    type: "keydown",
    key: name,
    preventDefault: () => { calls.prevented += 1; },
    stopPropagation: () => { calls.stopped += 1; },
  });
  return calls;
}

afterEach(() => {
  for (const handle of live.splice(0)) handle.control?.destroy();
  dom.document.activeElement = null;
  dom.document.body.replaceChildren();
});

// --- the focus handoff ------------------------------------------------------

test("a keyboard commit hands the focus to the replacement control the consumer builds", () => {
  const first = scene({ value: "a", focusKey: "slot-a" });
  // The consumer contract of `features/bases/view.js`: the `change` handler replaces the whole
  // subtree and re-enhances it before the dispatch returns, so the committing control is
  // detached while it is still running.
  let fresh = null;
  first.select.addEventListener("change", () => {
    fresh = scene({ value: first.select.value, focusKey: "slot-a" });
  });

  keyOn(first.trigger, "ArrowDown");
  key("ArrowDown");
  key("Enter");

  assert.ok(fresh, "the consumer re-rendered the control");
  assert.equal(fresh.select.value, "b", "the replacement carries the committed value");
  assert.equal(first.trigger.getAttribute("data-focus"), "slot-a", "the module published the declared slot key");
  assert.equal(first.select.getAttribute("data-focus"), null, "and moved it off the never-focused native select");
  assert.equal(fresh.trigger.getAttribute("data-focus"), "slot-a");
  assert.notEqual(focusOf(), first.trigger, "the focus must never sit on the detached trigger");
  assert.equal(focusOf(), fresh.trigger, "the focus landed on the live replacement trigger");
});

test("a commit whose consumer never rebuilds a control focuses nothing instead of a detached node", () => {
  const handle = scene({ value: "a", focusKey: "slot-b" });
  // A consumer that tears the subtree down without building a replacement is the worst case: no
  // live target exists, so the focus must be left where the browser put it — never on a node
  // that is no longer in the document.
  handle.select.addEventListener("change", () => {
    dom.document.activeElement = null;
    dom.document.body.replaceChildren(dom.createElement("div"));
  });

  keyOn(handle.trigger, "ArrowDown");
  key("Enter");

  assert.equal(dom.document.querySelector('[data-focus="slot-b"]'), null, "the declared slot no longer exists");
  assert.equal(focusOf(), null, "so nothing — in particular not the detached trigger — was focused");
});

// --- a surface that went away without a notification ------------------------

test("a listbox whose surface is hidden releases the document keys instead of eating them", () => {
  const handle = scene({ value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  assert.equal(handle.menu.hidden, false);

  // The Base host stays in the DOM, hidden, while the note is shown again.
  handle.host.hidden = true;
  const arrow = spyKey("ArrowDown");
  assert.equal(arrow.prevented, 0, "a hidden listbox must not swallow the keystroke");
  assert.equal(arrow.stopped, 0);
  assert.equal(handle.menu.hidden, true, "the control released itself");
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");

  const enter = spyKey("Enter");
  assert.equal(enter.prevented, 0, "and it keeps letting every later key through");
});

test("a listbox whose subtree was replaced without re-enhancing releases the document keys", () => {
  const handle = scene({ value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  assert.equal(handle.menu.hidden, false);

  // In-app navigation renders a fresh subtree and the old one is dropped without a destroy()
  // call: the leaked document listener must still notice that it lost its surface.
  dom.document.body.replaceChildren(dom.createElement("div"));
  const arrow = spyKey("ArrowDown");
  assert.equal(arrow.prevented, 0, "a detached listbox must not swallow the keystroke");
  const enter = spyKey("Enter");
  assert.equal(enter.prevented, 0);
});
