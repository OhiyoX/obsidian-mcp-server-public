// #421 (Web UI audit §7, seat ruling (a)): `#publishes-open` is a one-shot shortcut, not a
// toggle.
//
// The control sits in the Files panel head, and its click hands the reader to the Search
// panel -- so the surface that would have to show a pressed state is exactly the one that is
// no longer on screen. The ruling keeps the behaviour (preset query + panel switch) and
// removes the toggle semantics: no `aria-pressed`, an action-shaped label, and a repeat click
// that re-runs the same search instead of flipping the query back off.
//
// Two halves, like the other sidebar contracts:
//  1. source/DOM contract of the rendered `pages.js` markup;
//  2. behaviour of `features/search/controller.js` against a minimal element shim.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { appPage } from "../src/app/pages.js";
import { initializeSearchControls } from "../frontend/app/features/search/controller.js";
import { createNoteInFolder } from "../frontend/app/features/explorer/create-note.js";

const pagesSource = await fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8");
const controllerSource = await fs.readFile(new URL("../frontend/app/features/search/controller.js", import.meta.url), "utf8");
const frontendRoot = new URL("../frontend/app/", import.meta.url);
const html = appPage({ csrf: "csrf", username: "tester", displayName: "Tester" }, { colorMode: "dark", themeId: "Things" });

// The action-shaped label the ruling asks for: the established noun ("已 Publish 文档", the
// wording this control already used) with the verb that names the one-shot action.
const PUBLISHES_LABEL = "搜索已 Publish 文档";
const FILES_HEAD_END = '<div id="files-status"';

function between(markup, start, end) {
  const from = markup.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = markup.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return markup.slice(from, to);
}

// The opening tag only: attributes are what this suite asserts, never the icon inside.
function buttonTag(markup, id) {
  const at = markup.indexOf(`<button id="${id}"`);
  assert.notEqual(at, -1, `missing #${id}`);
  return markup.slice(at, markup.indexOf(">", at) + 1);
}

// --- 1. source / rendered markup ---------------------------------------------------

test("source: the Publishes entry carries no aria-pressed and an action-shaped label", () => {
  const tag = buttonTag(pagesSource, "publishes-open");
  assert.doesNotMatch(tag, /aria-pressed/, `pages.js must not declare a pressed state: ${tag}`);
  assert.match(tag, new RegExp(`aria-label="${PUBLISHES_LABEL}"`), tag);
  assert.match(tag, new RegExp(`title="${PUBLISHES_LABEL}"`), tag);
  // The old toggle wording is gone, so the control cannot read as a latched filter.
  assert.doesNotMatch(tag, /查看已 Publish 文档/, tag);
});

test("DOM: the rendered Files panel head has no pressed state on the Publishes entry", () => {
  const head = between(html, 'data-panel-head="files"', FILES_HEAD_END);
  const tag = buttonTag(head, "publishes-open");
  assert.doesNotMatch(tag, /aria-pressed/, `the rendered entry must carry no pressed state: ${tag}`);
  assert.match(tag, new RegExp(`aria-label="${PUBLISHES_LABEL}"`), tag);
  assert.match(tag, /type="button"/, tag);
  // Attribute-level, not text-level: the head's own comment names `aria-pressed` on purpose.
  const headTags = [...head.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  assert.ok(headTags.length >= 6, `the file panel head still carries its controls: ${JSON.stringify(headTags)}`);
  assert.deepEqual(
    headTags.filter((candidate) => /aria-pressed/.test(candidate)),
    [],
    "no control in the file panel head claims a pressed state any more",
  );
});

test("the rest of the file panel head keeps its existing ARIA", () => {
  const head = between(html, 'data-panel-head="files"', FILES_HEAD_END);
  assert.match(buttonTag(head, "new-note"), /aria-label="新建笔记"/);
  assert.match(buttonTag(head, "new-folder"), /aria-label="新建文件夹"/);
  assert.match(buttonTag(head, "reveal-active"), /aria-label="定位当前文件"/);
  assert.match(buttonTag(head, "collapse-all"), /aria-label="折叠全部"/);
  assert.match(
    buttonTag(head, "explorer-sort-toggle"),
    /aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-sort-menu"/,
  );
  assert.match(
    buttonTag(head, "explorer-mode-toggle"),
    /aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-mode-menu"/,
  );
  assert.match(
    buttonTag(head, "explorer-flat-sort-toggle"),
    /aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-flat-sort-menu"/,
  );
  // #421 removes the shortcut's toggle semantics, not toggles in general: the two real
  // search toggles keep their pressed state (they stay on screen while it is true).
  assert.match(buttonTag(html, "search-case"), /aria-pressed="false"/);
  assert.match(buttonTag(html, "semantic-search"), /aria-pressed="false"/);
});

test("the search controller keeps no Publishes toggle state to maintain", () => {
  assert.doesNotMatch(controllerSource, /publishesButton\.setAttribute/, controllerSource);
  assert.doesNotMatch(controllerSource, /publishesButton\.classList/, controllerSource);
  assert.doesNotMatch(controllerSource, /syncPublished/, controllerSource);
  assert.match(controllerSource, /publishesButton\.onclick/, "the shortcut still has its one action");
});

// --- 2. controller behaviour -------------------------------------------------------

function createElement(name) {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    nodeName: String(name).toUpperCase(),
    hidden: false,
    focus() { this.focused = true; },
    get className() { return [...classes].join(" "); },
    set className(value) { classes.clear(); for (const token of String(value).split(/\s+/)) if (token) classes.add(token); },
    classList: {
      add(...tokens) { for (const token of tokens) classes.add(token); },
      remove(...tokens) { for (const token of tokens) classes.delete(token); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        const next = force === undefined ? !classes.has(token) : Boolean(force);
        if (next) classes.add(token); else classes.delete(token);
        return next;
      },
    },
    setAttribute(key, value) { attrs.set(String(key), String(value)); },
    getAttribute(key) { return attrs.has(String(key)) ? attrs.get(String(key)) : null; },
    removeAttribute(key) { attrs.delete(String(key)); },
    hasAttribute(key) { return attrs.has(String(key)); },
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatchEvent(event) { listeners.get(event?.type)?.(event); },
  };
}

function createControls() {
  const elements = {
    input: createElement("input"),
    clearButton: createElement("button"),
    caseButton: createElement("button"),
    semanticButton: createElement("button"),
    publishesButton: createElement("button"),
    revealButton: createElement("button"),
  };
  const calls = { loads: [], views: 0, reveals: 0 };
  const controls = initializeSearchControls({
    state: { semantic: false, caseSensitive: false },
    ...elements,
    loadNotes: async (query) => { calls.loads.push(query); },
    revealCurrent: () => { calls.reveals += 1; },
    showSearchView: () => { calls.views += 1; },
  });
  return { ...elements, calls, controls };
}

test("clicking the shortcut sets the preset query and opens the Search panel", async () => {
  const { input, publishesButton, calls } = createControls();
  assert.equal(publishesButton.getAttribute("aria-pressed"), null, "the shortcut starts unpressed");
  await publishesButton.onclick();
  assert.equal(input.value, "published:true", "the click sets the preset query");
  assert.deepEqual(calls.loads, ["published:true"], "and runs exactly that search");
  assert.equal(calls.views, 1, "the click brings the Search panel to the front itself");
  assert.equal(publishesButton.getAttribute("aria-pressed"), null, "without reporting a pressed state");
  assert.equal(publishesButton.classList.contains("active"), false, "and without painting itself as latched");
});

test("a repeat click re-runs the same search instead of flipping the query off", async () => {
  const { input, publishesButton, calls } = createControls();
  await publishesButton.onclick();
  await publishesButton.onclick();
  assert.equal(input.value, "published:true", "the second click must not clear the query");
  assert.deepEqual(calls.loads, ["published:true", "published:true"], "it repeats the same search");
  assert.equal(calls.views, 2, "and lands on the Search panel again");
  assert.equal(publishesButton.getAttribute("aria-pressed"), null);
});

test("no other search interaction writes a pressed state onto the shortcut", async () => {
  const { input, clearButton, publishesButton, caseButton, semanticButton, calls } = createControls();
  input.value = "published:true";
  input.dispatchEvent({ type: "input", target: input });
  assert.equal(publishesButton.getAttribute("aria-pressed"), null, "typing the preset query writes no state");
  assert.equal(publishesButton.classList.contains("active"), false);
  await clearButton.onclick();
  assert.equal(input.value, "");
  assert.equal(publishesButton.getAttribute("aria-pressed"), null, "clearing writes no state either");
  assert.deepEqual(calls.loads, [""], "the clear control still runs the empty query");
  // Reverse assertion: the real toggles on this surface are untouched by #421. They are
  // written by the controller itself, so this is the state the markup cannot pre-set.
  assert.equal(semanticButton.getAttribute("aria-pressed"), null, "the semantic toggle is only synced when it changes");
  await caseButton.onclick();
  assert.equal(caseButton.getAttribute("aria-pressed"), "true");
  await semanticButton.onclick();
  assert.equal(semanticButton.getAttribute("aria-pressed"), "true");
  assert.equal(caseButton.getAttribute("aria-pressed"), "false", "the two toggles stay mutually exclusive");
  assert.equal(publishesButton.getAttribute("aria-pressed"), null);
});

// The create path was the shortcut's second writer: `features/explorer/create-note.js` used to
// clear the old Publishes toggle state (`classList.remove("active")` +
// `setAttribute("aria-pressed", "false")`) on every successful create, so the "no pressed
// state" invariant broke as soon as anyone created a note. #421 U49-FIX deleted exactly those
// two lines; this pins both directions of the remaining behaviour -- the real semantic toggle
// is still written, the shortcut is never written. The live counterpart (a real Chromium
// create through the tree, then reading `aria-pressed` off the rendered DOM) lives in
// `scripts/web-regression/explorer-mode-switch.mjs`.
test("the Explorer create path still syncs the semantic toggle but never writes the shortcut", async () => {
  const semanticButton = createElement("button");
  const publishesButton = createElement("button");
  const state = { expanded: new Set(), semantic: true };
  const search = { value: "published:true" };
  const requests = [];
  const ok = await createNoteInFolder({
    folderPath: "",
    rawName: "Probe",
    session: { isDirty: () => false },
    toast: (message) => { throw new Error(`unexpected toast: ${message}`); },
    state,
    search,
    semanticButton,
    publishesButton,
    api: async (url, options) => { requests.push([url, JSON.parse(options.body)]); return { path: "/Probe.md" }; },
    syncSearchChrome: () => {},
    cancelPendingSearch: () => {},
    loadNotes: async () => {},
    openNote: async () => true,
    enterLiveMode: () => {},
    hasChild: () => false,
  });
  assert.equal(ok, true, "the create must really succeed for the assertion to mean anything");
  assert.deepEqual(requests, [["/api/web/v1/note", { path: "/Probe.md", content: "" }]], "the create still writes the note");
  assert.equal(search.value, "", "the create still clears the search query");
  assert.equal(state.semantic, false, "and still resets the semantic state");
  assert.equal(semanticButton.getAttribute("aria-pressed"), "false", "the real toggle keeps its pressed state write");
  assert.equal(semanticButton.classList.contains("active"), false);
  assert.equal(publishesButton.getAttribute("aria-pressed"), null, "the shortcut must never receive a pressed state");
  assert.equal(publishesButton.classList.contains("active"), false, "nor its latched paint");
});

// --- 3. no second writer ------------------------------------------------------------

async function frontendModules(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) found.push(...(await frontendModules(child)));
    else if (entry.name.endsWith(".js")) found.push(child);
  }
  return found;
}
// #421 U49-FIX removed the last second writer (`features/explorer/create-note.js`, whose two
// create-path lines are now covered by the behaviour test above). There is deliberately no
// allow-list left: this is a zero-hit scan over the whole frontend, so any module that writes
// a pressed state back onto the shortcut fails here instead of being registered as debt again.
test("no frontend module writes a pressed state on the Publishes entry (zero writers repo-wide)", async () => {
  const writers = [];
  for (const url of await frontendModules(frontendRoot)) {
    const relative = url.href.slice(frontendRoot.href.length);
    const source = await fs.readFile(url, "utf8");
    for (const line of source.split("\n")) {
      if (/publishes[A-Za-z]*\s*\.\s*(setAttribute\(\s*["']aria-pressed|classList\.(toggle|remove|add)\(\s*["']active)/.test(line)) {
        writers.push(`${relative}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(writers, [], `no module may write a pressed state onto the shortcut: ${JSON.stringify(writers)}`);
});
