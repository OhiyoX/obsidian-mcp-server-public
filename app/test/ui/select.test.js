// U48 (#409) — the custom `<select>` ARIA listbox keyboard contract.
//
// Drives the real `ui/select.js` on the repository's DOM harness: the listbox roles, a keyboard
// open landing on the selected option, Arrow/Home/End traversal, Enter/Space commit through the
// native `<select>` (value + `change`), Escape closing and handing the focus back to the
// trigger, roving `tabindex`, and a `destroy()`/re-mount path that leaves no listener behind.
//
// The two negative controls at the end are paired: each runs an assertion from the suites above
// against a deliberately broken twin and requires it to fail, so a green run also proves the
// assertion is sensitive instead of vacuously passing.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createDomHarness } from "../helpers/base-dom.mjs";
import { enhanceSelects } from "../../frontend/app/ui/select.js";

const dom = createDomHarness();
dom.install();

const live = [];

// --- fixtures ---------------------------------------------------------------

const DEFAULT_OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

// One `select[data-select]` in the shape every consumer builds (page markup, `buildSelect`,
// the Base view control), enhanced by the real module.
function scene({
  options = DEFAULT_OPTIONS,
  value = null,
  disabled = [],
  ariaLabel = "切换 Vault",
  enhance = true,
  track = true,
} = {}) {
  const host = dom.createElement("div");
  const select = dom.createElement("select");
  select.className = "vault-select";
  select.setAttribute("data-select", "");
  select.setAttribute("aria-label", ariaLabel);
  options.forEach((option, index) => {
    const node = dom.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    if (disabled.includes(index)) node.disabled = true;
    if (value !== null && option.value === value) node.selected = true;
    select.append(node);
  });
  if (value !== null) select.value = value;
  host.append(select);
  dom.document.body.replaceChildren(host);

  const handle = { host, select, control: null, changes: [] };
  select.addEventListener("change", () => handle.changes.push(select.value));
  if (enhance) handle.control = enhanceSelects(host);
  handle.wrapper = host.querySelector(".select-control");
  handle.trigger = host.querySelector(".select-trigger");
  handle.menu = host.querySelector(".select-menu");
  handle.items = () => [...handle.menu.querySelectorAll(".select-option")];
  if (track) live.push(handle);
  return handle;
}

const keyOn = (node, name) => node.dispatchEvent({ type: "keydown", key: name });
const key = (name) => dom.document.dispatchEvent({ type: "keydown", key: name });
const pointerClick = (node) => node.dispatchEvent({ type: "click", detail: 1 });
const focusOf = () => dom.document.activeElement;
const outsideClick = (node) => dom.document.dispatchEvent({ type: "click", target: node });
const tabindexes = (handle) => handle.items().map((item) => item.tabIndex);
const isAssertionError = (error) => error?.code === "ERR_ASSERTION";

// Net per-type listener count over the two hosts the control may use. The harness ignores the
// capture flag but matches listeners by identity, exactly like `removeEventListener` does.
function trackListeners() {
  const counts = new Map();
  const bump = (type, delta) => counts.set(type, (counts.get(type) ?? 0) + delta);
  const originals = [dom.document, globalThis].map((target) => ({ target, add: target.addEventListener, remove: target.removeEventListener }));
  for (const entry of originals) {
    entry.target.addEventListener = (type, listener, ...rest) => { bump(type, 1); return entry.add.call(entry.target, type, listener, ...rest); };
    entry.target.removeEventListener = (type, listener, ...rest) => { bump(type, -1); return entry.remove.call(entry.target, type, listener, ...rest); };
  }
  return {
    total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    restore: () => { for (const entry of originals) { entry.target.addEventListener = entry.add; entry.target.removeEventListener = entry.remove; } },
  };
}

// A spy payload, so a test can assert the handler consumed the keystroke. The harness's
// `dispatchEvent` only fills gaps, so the spies survive.
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

// --- roles / hidden native select -------------------------------------------

test("the control announces a listbox and keeps the native select out of every surface", () => {
  const handle = scene({ value: "b" });
  assert.equal(handle.trigger.getAttribute("aria-haspopup"), "listbox");
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(handle.trigger.getAttribute("aria-label"), "切换 Vault");
  assert.equal(handle.menu.getAttribute("role"), "listbox");
  assert.equal(handle.menu.hidden, true);
  // The listbox is named by its own trigger, never by a document-wide id.
  assert.ok(handle.trigger.id.length > 0, "the trigger needs an id for aria-labelledby");
  assert.equal(handle.menu.getAttribute("aria-labelledby"), handle.trigger.id);

  const items = handle.items();
  assert.deepEqual(items.map((item) => item.getAttribute("role")), ["option", "option", "option"]);
  assert.deepEqual(items.map((item) => item.getAttribute("aria-selected")), ["false", "true", "false"]);

  // The native element stays the value source but is invisible and unreachable.
  assert.equal(handle.select.getAttribute("aria-hidden"), "true");
  assert.equal(handle.select.tabIndex, -1);
  assert.equal(handle.select.classList.contains("select-native"), true);

  pointerClick(handle.trigger);
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(handle.menu.hidden, false);
  key("Escape");
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(handle.menu.hidden, true);
});

test("the trigger label follows the selected option and falls back when nothing is selected", () => {
  const selected = scene({ value: "c" });
  assert.equal(selected.trigger.firstElementChild.textContent, "Gamma");

  const empty = scene({ options: [{ value: "", label: "" }] });
  assert.equal(empty.trigger.firstElementChild.textContent, "请选择");
});

// --- opening ----------------------------------------------------------------

test("a keyboard open lands on the selected option and moves the focus into the listbox", () => {
  const handle = scene({ value: "b" });
  keyOn(handle.trigger, "ArrowDown");
  assert.equal(handle.menu.hidden, false, "ArrowDown opens the listbox");
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(focusOf(), handle.items()[1], "the focus lands on the selected option");
  assert.equal(handle.changes.length, 0, "opening never commits a value");
});

test("ArrowUp, Enter and Space open on the selected option as well", () => {
  for (const name of ["ArrowUp", "Enter", " "]) {
    const handle = scene({ value: "b" });
    keyOn(handle.trigger, name);
    assert.equal(handle.menu.hidden, false, `${name} must open the listbox`);
    assert.equal(focusOf(), handle.items()[1], `${name} must land on the selected option`);
    handle.control.destroy();
  }
});

test("a keyboard open with nothing selected lands on the first enabled option", () => {
  const handle = scene({ disabled: [0] });
  keyOn(handle.trigger, "Enter");
  assert.equal(focusOf(), handle.items()[1], "the disabled first option is skipped");
});

test("a pointer open never moves the focus", () => {
  const handle = scene({ value: "a" });
  const editor = dom.createElement("textarea");
  dom.document.body.append(editor);
  editor.focus();
  pointerClick(handle.trigger);
  assert.equal(handle.menu.hidden, false, "the listbox opened");
  assert.equal(focusOf(), editor, "and the pointer kept its own focus");
  assert.notEqual(focusOf(), handle.items()[0]);
});

// --- traversal --------------------------------------------------------------

test("ArrowDown/ArrowUp cycle through the enabled options and skip disabled ones", () => {
  const handle = scene({ options: [...DEFAULT_OPTIONS, { value: "d", label: "Delta" }], disabled: [1], value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  assert.equal(focusOf(), handle.items()[0]);
  key("ArrowDown");
  assert.equal(focusOf(), handle.items()[2], "the disabled option is skipped");
  key("ArrowDown");
  assert.equal(focusOf(), handle.items()[3]);
  key("ArrowDown");
  assert.equal(focusOf(), handle.items()[0], "the list wraps at the end");
  key("ArrowUp");
  assert.equal(focusOf(), handle.items()[3], "and at the start");
  key("ArrowUp");
  assert.equal(focusOf(), handle.items()[2]);
});

test("Home and End jump to the first and last enabled options", () => {
  const handle = scene({ options: [...DEFAULT_OPTIONS, { value: "d", label: "Delta" }], disabled: [3] });
  keyOn(handle.trigger, "ArrowDown");
  key("End");
  assert.equal(focusOf(), handle.items()[2], "End stops at the last enabled option");
  key("Home");
  assert.equal(focusOf(), handle.items()[0]);
});

test("the roving tabindex keeps exactly one option reachable while open and none when closed", () => {
  const handle = scene({ value: "b" });
  assert.deepEqual(tabindexes(handle), [-1, -1, -1], "a closed listbox keeps no option in the tab order");
  keyOn(handle.trigger, "ArrowDown");
  assert.deepEqual(tabindexes(handle), [-1, 0, -1], "the active option is the only reachable one");
  key("ArrowDown");
  assert.deepEqual(tabindexes(handle), [-1, -1, 0], "and it follows the active option");
  assert.equal(focusOf(), handle.items()[2], "roving focus: the active option is the focused one");
  key("Escape");
  assert.deepEqual(tabindexes(handle), [-1, -1, -1]);
});

// --- commit -----------------------------------------------------------------

test("Enter commits the active option through the native select, closes and returns the focus", () => {
  const handle = scene({ value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  key("ArrowDown");
  assert.equal(focusOf(), handle.items()[1]);
  key("Enter");
  assert.equal(handle.select.value, "b", "the native select is the value source");
  assert.deepEqual(handle.changes, ["b"], "exactly one bubbling change");
  assert.equal(handle.menu.hidden, true, "the listbox closed");
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focusOf(), handle.trigger, "the focus came back to the trigger");
  assert.deepEqual(tabindexes(handle), [-1, -1, -1]);
});

test("Space commits the active option too", () => {
  const handle = scene({ value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  key("ArrowDown");
  key(" ");
  assert.equal(handle.select.value, "b");
  assert.deepEqual(handle.changes, ["b"]);
  assert.equal(handle.menu.hidden, true);
  assert.equal(focusOf(), handle.trigger);
});

test("a pointer click on an option commits it and returns the focus to the trigger", () => {
  const handle = scene({ value: "a" });
  pointerClick(handle.trigger);
  pointerClick(handle.items()[2]);
  assert.equal(handle.select.value, "c");
  assert.deepEqual(handle.changes, ["c"]);
  assert.equal(handle.menu.hidden, true);
  assert.equal(focusOf(), handle.trigger);
  assert.equal(handle.trigger.firstElementChild.textContent, "Gamma", "the trigger label re-rendered");
});

test("a disabled option can never be committed", () => {
  const handle = scene({ value: "a", disabled: [2] });
  pointerClick(handle.trigger);
  pointerClick(handle.items()[2]);
  assert.equal(handle.select.value, "a", "the value did not move");
  assert.deepEqual(handle.changes, [], "and no change was emitted");
  assert.equal(handle.menu.hidden, false, "the listbox stayed open");
});
// --- dismissal --------------------------------------------------------------

test("Escape closes, returns the focus to the trigger and consumes the keystroke", () => {
  const handle = scene({ value: "b" });
  keyOn(handle.trigger, "ArrowDown");
  const calls = spyKey("Escape");
  assert.equal(handle.menu.hidden, true);
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focusOf(), handle.trigger);
  assert.equal(calls.prevented, 1, "Escape is prevented");
  assert.equal(calls.stopped, 1, "and never reaches an outer layer (the innermost layer owns it)");
});

test("Tab closes the listbox without stealing the browser's focus move", () => {
  const handle = scene({ value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  const calls = spyKey("Tab");
  assert.equal(handle.menu.hidden, true);
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(calls.prevented, 0, "Tab must stay a real focus move");
  assert.equal(calls.stopped, 0);
});

test("an outside click closes the listbox and leaves the click target's focus alone", () => {
  const handle = scene({ value: "a" });
  const outside = dom.createElement("div");
  dom.document.body.append(outside);
  const editor = dom.createElement("textarea");
  dom.document.body.append(editor);
  editor.focus();
  pointerClick(handle.trigger);
  outsideClick(handle.menu);
  assert.equal(handle.menu.hidden, false, "a press inside the listbox keeps it open");
  outsideClick(handle.trigger);
  assert.equal(handle.menu.hidden, false, "the trigger press belongs to its own click handler");
  outsideClick(outside);
  assert.equal(handle.menu.hidden, true);
  assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focusOf(), editor, "an outside dismissal never grabs the trigger");
});

// --- re-render / state stability --------------------------------------------

test("a re-render from the native select refreshes the options without losing the selection", () => {
  const handle = scene({ value: "a" });
  keyOn(handle.trigger, "ArrowDown");
  assert.equal(focusOf(), handle.items()[0]);

  const added = dom.createElement("option");
  added.value = "d";
  added.textContent = "Delta";
  handle.select.append(added);
  handle.select.dispatchEvent({ type: "change" });

  assert.deepEqual(handle.items().map((item) => item.textContent), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual(
    handle.items().map((item) => item.getAttribute("aria-selected")),
    ["true", "false", "false", "false"],
    "the committed value never regresses on a re-render",
  );
  assert.equal(handle.select.value, "a");
  assert.equal(handle.trigger.firstElementChild.textContent, "Alpha");
  assert.equal(focusOf(), handle.items()[0], "the active option survived the rebuild");
  assert.deepEqual(tabindexes(handle), [0, -1, -1, -1]);
});

test("closing without choosing never moves the value, and reopening re-lands on the selection", () => {
  const handle = scene({ value: "b" });
  keyOn(handle.trigger, "ArrowDown");
  key("ArrowDown");
  assert.equal(focusOf(), handle.items()[2]);
  key("Escape");
  assert.equal(handle.select.value, "b", "Escape is not a commit");
  assert.deepEqual(handle.changes, []);
  keyOn(handle.trigger, "ArrowDown");
  assert.equal(focusOf(), handle.items()[1], "the reopen lands on the selected option again");
});

// --- listeners / destroy ----------------------------------------------------

test("the control installs nothing while closed and releases everything on close", () => {
  const tracker = trackListeners();
  try {
    const handle = scene({ value: "a" });
    assert.equal(tracker.total(), 0, "enhancing a closed control registers nothing");
    pointerClick(handle.trigger);
    assert.equal(tracker.total(), 4, "an open listbox owns the dismiss/keydown pair plus resize/scroll");
    key("Escape");
    assert.equal(tracker.total(), 0, "closing removes exactly those four");
  } finally {
    tracker.restore();
  }
});

test("destroy() closes the listbox, is idempotent and leaves no listener behind", () => {
  const tracker = trackListeners();
  try {
    const handle = scene({ value: "a" });
    keyOn(handle.trigger, "ArrowDown");
    assert.equal(tracker.total(), 4);
    handle.control.destroy();
    assert.equal(tracker.total(), 0, "destroy removes every listener it installed");
    assert.equal(handle.menu.hidden, true, "and leaves the listbox closed");
    assert.equal(handle.trigger.getAttribute("aria-expanded"), "false");
    assert.deepEqual(tabindexes(handle), [-1, -1, -1]);
    handle.control.destroy();
    assert.equal(tracker.total(), 0, "a second destroy is a no-op");
    // The control is inert: no key reopens it and the document listener is gone for good.
    keyOn(handle.trigger, "ArrowDown");
    assert.equal(handle.menu.hidden, true);
    key("ArrowDown");
    assert.equal(handle.menu.hidden, true);
  } finally {
    tracker.restore();
  }
});

test("re-mounting a fresh subtree leaves no listener behind (the Base surface re-enhances per render)", () => {
  const tracker = trackListeners();
  try {
    const first = scene({ value: "a" });
    keyOn(first.trigger, "ArrowDown");
    key("Escape");
    dom.document.body.replaceChildren();
    first.control.destroy();
    const second = scene({ value: "a" });
    assert.equal(tracker.total(), 0, "a re-mounted closed control adds nothing");
    keyOn(second.trigger, "ArrowDown");
    assert.equal(tracker.total(), 4, "and the fresh control works on its own");
  } finally {
    tracker.restore();
  }
});

// --- negative controls ------------------------------------------------------
// Each one runs an assertion from the suites above against a deliberately broken twin and
// requires it to fail; the same assertion is green on the real control.

// The pre-U48 implementation reduced to the behaviour the audit found: the trigger opens the
// listbox and nothing else — no focus entry, no Arrow traversal.
function legacyTwin({ itemCount = 3, selectedIndex = -1 } = {}) {
  const wrapper = dom.createElement("span");
  wrapper.className = "select-control";
  const trigger = dom.createElement("button");
  trigger.className = "select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = dom.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  wrapper.append(trigger, menu);
  dom.document.body.replaceChildren(wrapper);
  let open = false;
  const toggle = () => { open = !open; menu.hidden = !open; trigger.setAttribute("aria-expanded", String(open)); };
  trigger.addEventListener("click", toggle);
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (!open) toggle();
  });
  for (let index = 0; index < itemCount; index += 1) {
    const item = dom.createElement("button");
    item.className = "select-option";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === selectedIndex));
    menu.append(item);
  }
  return { trigger, menu, items: () => [...menu.querySelectorAll(".select-option")] };
}

// The navigation contract, shared by the real control and the twin below.
function assertArrowNavigation({ trigger, items }) {
  keyOn(trigger, "ArrowDown");
  assert.equal(focusOf(), items()[0], "ArrowDown must open on the selected option");
  key("ArrowDown");
  assert.equal(focusOf(), items()[1], "ArrowDown must move to the next option");
}

test("negative control 1: the Arrow-navigation assertion is red without the Arrow handler", () => {
  const real = scene();
  assertArrowNavigation(real);
  assert.equal(focusOf(), real.items()[1], "the real control keeps the focus on the moved option");

  dom.document.activeElement = null;
  const twin = legacyTwin();
  assert.throws(
    () => assertArrowNavigation(twin),
    isAssertionError,
    "the open-only twin must fail the very same navigation assertion",
  );
  assert.equal(twin.menu.hidden, false, "sanity: the twin did open — it just cannot navigate");
});

test("negative control 2: the listener-leak checker is red for a leaking twin", () => {
  const tracker = trackListeners();
  try {
    const clean = scene({ value: "a" });
    keyOn(clean.trigger, "ArrowDown");
    clean.control.destroy();
    assert.equal(tracker.total(), 0, "the real control leaves nothing behind");

    const leakyAdd = (type) => dom.document.addEventListener(type, () => {}, true);
    leakyAdd("click");
    leakyAdd("keydown");
    assert.throws(
      () => assert.equal(tracker.total(), 0, "destroy must leave no listener"),
      isAssertionError,
      "the leak this checker exists to catch",
    );
  } finally {
    tracker.restore();
  }
});
