// Frontend tests for the repository-level Tags panel (desktop Tags view replica).
//
// Real shell markup from `pages.js` (title, sort menu item set, filter input, list
// landmark, empty copy), the app.css right-aligned count contract, and the panel
// behavior on a real DOM harness: name-left/count-right rows, `/`-grouped parents
// whose count is self + descendants, persisted parent collapse, a real client-side
// filter, server-side sort re-fetch, and the `tag:#<path>` search reuse.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { buildTagTree, createTagsPanel, filterTagTree, flattenTagTree, sortTagTree } from "../frontend/app/features/context/tags.js";
import { attachTagsPanel } from "../frontend/app/features/context/attach-tags.js";
import { attachNoteContext } from "../frontend/app/features/context/attach-note-context.js";

const dom = createDomHarness();
dom.install();

const here = path.dirname(fileURLToPath(import.meta.url));
const TAGS_TITLE = "标签";

async function shellMarkup() {
  const { appPage } = await import("../src/app/pages.js");
  return appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});
}

function headerBlock(page, name) {
  const anchor = page.indexOf(`data-context-section="${name}"`);
  assert.ok(anchor > 0, `shell must contain the ${name} section header`);
  const open = page.lastIndexOf("<header", anchor);
  const end = page.indexOf("</header>", anchor);
  return page.slice(open, end + "</header>".length);
}

function navBlock(page, id) {
  const anchor = page.indexOf(`id="${id}"`);
  assert.ok(anchor > 0, `shell must contain #${id}`);
  const open = page.lastIndexOf("<nav", anchor);
  const end = page.indexOf("</nav>", anchor);
  return page.slice(open, end + "</nav>".length);
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

// Mirrors the real `pages.js` tags markup so behavior tests use the same structure
// the shell ships: one panel head carrying the title and the sort/filter tools (U7).
function buildTagsChrome() {
  const header = dom.createElement("header");
  header.className = "context-header context-panel-head tags-header";
  header.setAttribute("data-context-panel", "tags");
  header.setAttribute("data-context-section", "tags");

  const title = dom.createElement("span");
  title.className = "context-title";
  title.textContent = TAGS_TITLE;

  const tools = dom.createElement("div");
  tools.className = "tags-tools";
  const sortToggle = dom.createElement("button");
  sortToggle.id = "tags-sort-toggle";
  sortToggle.className = "icon-btn tags-sort-toggle";
  sortToggle.setAttribute("aria-haspopup", "menu");
  sortToggle.setAttribute("aria-expanded", "false");
  const filterToggle = dom.createElement("button");
  filterToggle.id = "tags-filter-toggle";
  filterToggle.className = "icon-btn tags-filter-toggle";
  filterToggle.setAttribute("aria-pressed", "false");
  tools.append(sortToggle, filterToggle);

  const sortMenu = dom.createElement("div");
  sortMenu.id = "tags-sort-menu";
  sortMenu.className = "tags-sort-menu";
  sortMenu.setAttribute("role", "menu");
  sortMenu.hidden = true;
  const options = [
    ["data-tags-sort", "count", "按数量", true],
    ["data-tags-sort", "name", "按名称", false],
    ["data-tags-direction", "desc", "降序", true],
    ["data-tags-direction", "asc", "升序", false],
  ];
  for (const [attr, value, label, checked] of options) {
    const option = dom.createElement("button");
    option.className = "tags-sort-option";
    option.setAttribute("role", "menuitemradio");
    option.setAttribute(attr, value);
    option.setAttribute("aria-checked", String(checked));
    option.textContent = label;
    sortMenu.append(option);
  }

  header.append(title, tools, sortMenu);

  const filterRow = dom.createElement("div");
  filterRow.className = "tags-filter-row";
  filterRow.hidden = true;
  const filterInput = dom.createElement("input");
  filterInput.id = "tags-filter";
  filterInput.className = "tags-filter";
  filterRow.append(filterInput);

  const host = dom.createElement("nav");
  host.id = "tags-list";
  host.className = "outline-list tags-list";
  host.setAttribute("aria-label", TAGS_TITLE);
  const empty = dom.createElement("div");
  empty.className = "context-empty";
  empty.textContent = "没有标签";
  host.append(empty);

  return { header, host, sortToggle, sortMenu, filterToggle, filterRow, filterInput };
}

function mountPanel({ tags = [], fetchImpl, storage = memoryStorage(), searchInput = null } = {}) {
  const chrome = buildTagsChrome();
  // The chrome is part of the attached shell in the real app, and the panel's own popup contract
  // depends on it: `ui/popup-menu.js` only returns the focus to a candidate it can really focus,
  // and a browser drops `focus()` on a node that is not in the document (a detached node would
  // silently leave the focus on the body). Attaching it here is what the shell does.
  dom.document.body.append(chrome.header, chrome.filterRow, chrome.host);
  const calls = [];
  const fetchStub = fetchImpl || (async (url) => { calls.push(String(url)); return jsonResponse({ tags }); });
  const panel = createTagsPanel({
    host: chrome.host,
    sortToggle: chrome.sortToggle,
    sortMenu: chrome.sortMenu,
    filterToggle: chrome.filterToggle,
    filterRow: chrome.filterRow,
    filterInput: chrome.filterInput,
    searchInput,
    fetchImpl: fetchStub,
    storage,
  });
  return { chrome, panel, calls, fetchStub };
}

const rowsOf = (host) => [...host.querySelectorAll(".tag-node")].map((node) => ({
  path: node.getAttribute("data-tag-path"),
  name: node.querySelector(".tag-name")?.textContent ?? null,
  count: node.querySelector(".tag-count")?.textContent ?? null,
  countClass: node.querySelector(".tag-count")?.className ?? null,
}));

// --- pure tree model --------------------------------------------------------

test("buildTagTree groups `/` paths and a parent counts itself plus every descendant", () => {
  const roots = buildTagTree([{ tag: "a", count: 1 }, { tag: "a/b", count: 2 }, { tag: "a/b/c", count: 3 }]);
  assert.deepEqual(flattenTagTree(roots), [["a", 6], ["a/b", 5], ["a/b/c", 3]]);
  assert.equal(roots[0].count, 1, "the parent keeps its own projected count separately");
});

test("sortTagTree is deterministic: count desc with a name tie-break, then name direction", () => {
  const tags = [{ tag: "b", count: 2 }, { tag: "a", count: 2 }, { tag: "c", count: 9 }];
  assert.deepEqual(flattenTagTree(sortTagTree(buildTagTree(tags), { sort: "count", direction: "desc" })), [["c", 9], ["a", 2], ["b", 2]]);
  assert.deepEqual(flattenTagTree(sortTagTree(buildTagTree(tags), { sort: "name", direction: "asc" })), [["a", 2], ["b", 2], ["c", 9]]);
  assert.deepEqual(flattenTagTree(sortTagTree(buildTagTree(tags), { sort: "name", direction: "desc" })), [["c", 9], ["b", 2], ["a", 2]]);
});

test("filterTagTree keeps ancestors of a match", () => {
  const roots = buildTagTree([{ tag: "a/b/c", count: 1 }, { tag: "other", count: 5 }]);
  assert.deepEqual(flattenTagTree(filterTagTree(roots, "b/c")), [["a", 1], ["a/b", 1], ["a/b/c", 1]]);
  assert.deepEqual(filterTagTree(roots, "zzz"), []);
});

// --- real shell markup ------------------------------------------------------

test("the shell carries the desktop Tags panel structure", async () => {
  const page = await shellMarkup();
  const header = headerBlock(page, "tags");
  assert.equal(header.includes(`<span class="context-title">${TAGS_TITLE}</span>`), true, "panel title is 标签");
  // U7: the tags panel head is the panel's own `data-context-panel` head row, so the tools
  // and the title sit in the same element — and never in the shared rail tab row.
  assert.equal(header.includes('data-context-panel="tags"'), true, "the tags header is the tags panel head");
  assert.equal(header.includes('data-tags-sort="count"'), true);
  assert.equal(header.includes('data-tags-sort="name"'), true);
  assert.equal(header.includes('data-tags-direction="desc"'), true);
  assert.equal(header.includes('data-tags-direction="asc"'), true);
  // Exactly the four real options, no desktop-only fake controls.
  const optionLabels = [...header.matchAll(/data-tags-(?:sort|direction)="[a-z]+"[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(optionLabels, ["按数量", "按名称", "降序", "升序"]);
  assert.equal(header.includes("tags-sort-toggle"), true);
  assert.equal(header.includes("tags-filter-toggle"), true);
  assert.equal(header.includes('aria-haspopup="menu"'), true);
  const railRow = page.slice(
    page.lastIndexOf("<header", page.indexOf('class="context-header context-view-header"')),
    page.indexOf("</header>", page.indexOf('class="context-header context-view-header"')) + "</header>".length,
  );
  assert.equal(railRow.includes("tags-tools"), false, "the shared rail row carries no panel tools");
  assert.equal(railRow.includes("tags-sort-toggle"), false, "no tags control in the shared rail row");
  const filterRow = page.slice(page.indexOf('class="tags-filter-row"'), page.indexOf(">", page.indexOf('class="tags-filter-row"')));
  assert.equal(filterRow.includes("hidden"), true, "the filter box is hidden until its toggle opens it");
  assert.equal(page.includes('id="tags-filter"'), true);
  const list = navBlock(page, "tags-list");
  assert.equal(list.includes(`aria-label="${TAGS_TITLE}"`), true);
  assert.equal(list.includes('<div class="context-empty">没有标签</div>'), true, "empty copy is 没有标签");
});

test("app.css keeps the tag name left and the count right-aligned", async () => {
  const css = await fs.readFile(path.join(here, "..", "src", "app", "assets", "app.css"), "utf8");
  const countRule = css.match(/\.tag-count\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(countRule, /margin-left:\s*auto/);
  assert.match(countRule, /text-align:\s*right/);
  assert.match(css.match(/\.tag-name\s*\{[^}]*\}/)?.[0] ?? "", /text-overflow:\s*ellipsis/);
  assert.match(css.match(/\.tag-item\s*\{[^}]*\}/)?.[0] ?? "", /display:\s*flex/);
});

// --- panel behavior ---------------------------------------------------------

test("rows render name left / count right, defaulting to count desc", async () => {
  const { chrome, panel } = mountPanel({
    tags: [{ tag: "mcp", count: 72 }, { tag: "obsidian", count: 141 }, { tag: "运维", count: 97 }],
  });
  await panel.load();
  assert.deepEqual(rowsOf(chrome.host).map((row) => [row.name, row.count]), [["obsidian", "141"], ["运维", "97"], ["mcp", "72"]]);
  assert.deepEqual(rowsOf(chrome.host).map((row) => row.countClass), ["tag-count", "tag-count", "tag-count"]);
  assert.equal(chrome.host.querySelectorAll(".tag-name").length, 3, "the name element exists for every row");
  panel.destroy();
});

test("nested tags render parent/child rows and collapse really hides children", async () => {
  const storage = memoryStorage();
  const { chrome, panel } = mountPanel({
    tags: [{ tag: "a", count: 1 }, { tag: "a/b", count: 2 }, { tag: "a/b/c", count: 3 }],
    storage,
  });
  await panel.load();
  assert.deepEqual(flattenTagTree(buildTagTree([{ tag: "a", count: 1 }, { tag: "a/b", count: 2 }, { tag: "a/b/c", count: 3 }])), [["a", 6], ["a/b", 5], ["a/b/c", 3]]);
  assert.deepEqual(rowsOf(chrome.host).map((row) => [row.path, row.count]), [["a", "6"], ["a/b", "5"], ["a/b/c", "3"]]);
  const parent = chrome.host.querySelector('[data-tag-path="a"]');
  const childList = [...parent.childNodes].find((node) => node.nodeName === "UL");
  assert.ok(childList, "the parent owns a real child list");

  chrome.host.querySelector('[data-tag-toggle="a"]').click();
  assert.equal(panel.isCollapsed("a"), true);
  assert.equal(rowsOf(chrome.host).map((row) => row.path).includes("a/b"), false, "collapsing removes descendant rows");
  assert.equal(storage.getItem("obsidian-web.tags-collapsed"), '["a"]', "collapse state is persisted locally");

  // A fresh panel with the same storage starts collapsed.
  const second = mountPanel({ tags: [{ tag: "a/b", count: 2 }], storage });
  await second.panel.load();
  assert.equal(second.panel.isCollapsed("a"), true);
  assert.equal(second.panel.getState().sort, "count");
  panel.destroy();
  second.panel.destroy();
});

test("the filter box really filters and reports a no-match state", async () => {
  const { chrome, panel } = mountPanel({
    tags: [{ tag: "a/b/c", count: 1 }, { tag: "other", count: 5 }],
  });
  await panel.load();
  panel.setFilter("b/c");
  assert.deepEqual(rowsOf(chrome.host).map((row) => row.path), ["a", "a/b", "a/b/c"]);
  panel.setFilter("zzz");
  assert.equal(chrome.host.textContent, "没有匹配的标签");
  panel.setFilter("");
  assert.deepEqual(rowsOf(chrome.host).map((row) => row.path), ["other", "a", "a/b", "a/b/c"]);
  panel.destroy();
});

test("the sort menu re-fetches with the new sort/direction and updates aria-checked", async () => {
  const { chrome, panel, calls } = mountPanel({ tags: [{ tag: "x", count: 1 }] });
  await panel.load();
  assert.equal(calls[0], "/api/web/v1/tags?sort=count&direction=desc&limit=500");
  chrome.sortToggle.click();
  assert.equal(chrome.sortMenu.hidden, false, "the sort menu opens");
  chrome.sortMenu.querySelector('[data-tags-sort="name"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.at(-1), "/api/web/v1/tags?sort=name&direction=desc&limit=500");
  chrome.sortToggle.click();
  chrome.sortMenu.querySelector('[data-tags-direction="asc"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.at(-1), "/api/web/v1/tags?sort=name&direction=asc&limit=500");
  assert.equal(chrome.sortMenu.querySelector('[data-tags-sort="name"]').getAttribute("aria-checked"), "true");
  assert.equal(chrome.sortMenu.querySelector('[data-tags-direction="asc"]').getAttribute("aria-checked"), "true");
  assert.equal(chrome.sortMenu.querySelector('[data-tags-sort="count"]').getAttribute("aria-checked"), "false");
  panel.destroy();
});

test("the sort menu uses the shared popup primitive: aria, focus, outside dismissal, arrows (#407)", async () => {
  const { chrome, panel } = mountPanel({ tags: [{ tag: "x", count: 1 }] });
  await panel.load();
  const option = (attr, value) => chrome.sortMenu.querySelector(`[${attr}="${value}"]`);
  try {
    const closedAria = chrome.sortToggle.getAttribute("aria-expanded");
    assert.equal(closedAria, "false", "the sort menu starts closed");
    assert.equal(panel.isSortOpen(), false);

    // A keyboard open hands the focus to the checked option (count / desc are the defaults).
    chrome.sortToggle.dispatchEvent({ type: "click", detail: 0 });
    assert.equal(chrome.sortMenu.hidden, false);
    assert.equal(chrome.sortToggle.getAttribute("aria-expanded"), "true");
    assert.equal(panel.isSortOpen(), true);
    assert.equal(dom.document.activeElement, option("data-tags-sort", "count"), "the checked option takes the focus");

    // Arrow/Home/End walk the four real options in DOM order.
    dom.document.dispatchEvent({ type: "keydown", key: "ArrowDown" });
    assert.equal(dom.document.activeElement, option("data-tags-sort", "name"));
    dom.document.dispatchEvent({ type: "keydown", key: "End" });
    assert.equal(dom.document.activeElement, option("data-tags-direction", "asc"));
    dom.document.dispatchEvent({ type: "keydown", key: "ArrowDown" });
    assert.equal(dom.document.activeElement, option("data-tags-sort", "count"), "ArrowDown wraps at the end");
    dom.document.dispatchEvent({ type: "keydown", key: "Home" });
    assert.equal(dom.document.activeElement, option("data-tags-sort", "count"));
    dom.document.dispatchEvent({ type: "keydown", key: "ArrowUp" });
    assert.equal(dom.document.activeElement, option("data-tags-direction", "asc"), "ArrowUp wraps at the start");

    // Picking from the keyboard still sorts and closes, and the focus goes back to the toggle.
    option("data-tags-direction", "asc").click();
    assert.equal(panel.isSortOpen(), false);
    assert.equal(chrome.sortToggle.getAttribute("aria-expanded"), "false");
    assert.equal(dom.document.activeElement, chrome.sortToggle, "picking an option returns focus to the sort toggle");

    // A pointer open leaves the focus where it was, and an outside press dismisses without
    // moving it either.
    const editor = dom.createElement("textarea");
    const outside = dom.createElement("div");
    dom.document.body.append(editor, outside);
    editor.focus();
    chrome.sortToggle.dispatchEvent({ type: "click", detail: 1 });
    assert.equal(panel.isSortOpen(), true);
    assert.equal(dom.document.activeElement, editor, "a pointer open leaves the focus alone");
    dom.document.dispatchEvent({ type: "pointerdown", target: outside });
    assert.equal(panel.isSortOpen(), false, "an outside press dismisses the sort menu");
    assert.equal(chrome.sortToggle.getAttribute("aria-expanded"), "false");
    assert.equal(dom.document.activeElement, editor, "and the focus stays where the pointer left it");

    // Escape closes it and hands the focus back to the toggle.
    chrome.sortToggle.dispatchEvent({ type: "click", detail: 1 });
    dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(panel.isSortOpen(), false);
    assert.equal(dom.document.activeElement, chrome.sortToggle, "Escape returns focus to the sort toggle");
  } finally {
    panel.destroy();
  }
});

test("clicking a tag writes tag:#<path> into the shared search box and fires its input event", async () => {
  const searchInput = dom.createElement("input");
  searchInput.id = "search";
  searchInput.value = "";
  const events = [];
  searchInput.addEventListener("input", (event) => events.push({ type: event.type, value: searchInput.value }));
  const { chrome, panel } = mountPanel({ tags: [{ tag: "todo", count: 35 }, { tag: "a/b", count: 2 }], searchInput });
  await panel.load();

  chrome.host.querySelector('[data-tag="todo"]').click();
  assert.equal(searchInput.value, "tag:#todo");
  assert.deepEqual(events, [{ type: "input", value: "tag:#todo" }]);

  chrome.host.querySelector('[data-tag="a/b"]').click();
  assert.equal(searchInput.value, "tag:#a/b");
  assert.equal(events.length, 2, "every click reuses the same search flow");
  panel.destroy();
});

test("empty, loading and error states are explicit and XSS-safe", async () => {
  const empty = mountPanel({ tags: [] });
  await empty.panel.load();
  assert.equal(empty.chrome.host.textContent, "没有标签");

  const failing = mountPanel({ fetchImpl: async () => { throw new Error("boom"); } });
  await failing.panel.load();
  assert.equal(failing.chrome.host.textContent, "标签加载失败");

  const hostile = mountPanel({ tags: [{ tag: `<img src=x onerror="globalThis.__tagsXss=1">`, count: 1 }] });
  await hostile.panel.load();
  assert.equal(hostile.chrome.host.querySelector("img"), null, "a hostile tag name never creates an element");
  assert.equal(hostile.chrome.host.querySelector(".tag-name").textContent, `<img src=x onerror="globalThis.__tagsXss=1">`);
  assert.equal(globalThis.__tagsXss, undefined);

  empty.panel.destroy();
  failing.panel.destroy();
  hostile.panel.destroy();
});

// --- attachment / repository scope ------------------------------------------

test("attachTagsPanel is a no-op without the panel markup", async () => {
  dom.document.body.replaceChildren(dom.createElement("aside"));
  const panel = attachTagsPanel({ documentRef: dom.document, storage: memoryStorage() });
  await panel.load();
  assert.equal(panel.getState().status, "idle");
});

test("the Tags panel is repository-level: a Base switch leaves its rows untouched", async () => {
  const previous = dom.document.body.querySelectorAll?.(".context-sidebar") ?? [];
  void previous;
  const root = dom.createElement("aside");
  root.className = "context-sidebar";
  const outgoing = dom.createElement("nav");
  outgoing.id = "outgoing-list";
  const incoming = dom.createElement("nav");
  incoming.id = "incoming-list";
  const chrome = buildTagsChrome();
  const searchInput = dom.createElement("input");
  searchInput.id = "search";
  root.append(outgoing, incoming, chrome.header, chrome.filterRow, chrome.host, searchInput);
  dom.document.body.replaceChildren(root);

  const fetchImpl = async (url) => {
    if (String(url).startsWith("/api/web/v1/tags")) {
      return jsonResponse({ vaultId: "default", tags: [{ tag: "obsidian", count: 141 }], total: 1, truncated: false });
    }
    return jsonResponse({ vaultId: "default", path: "x", revision: "r", links: [], truncated: false });
  };
  const context = attachNoteContext({ documentRef: dom.document, fetchImpl, openNote: () => {}, storage: memoryStorage() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(rowsOf(chrome.host).map((row) => [row.name, row.count]), [["obsidian", "141"]]);

  await context.setDocument({ path: "x.md", documentKind: "note" });
  await context.clear();
  await context.setDocument({ path: "Project.base", documentKind: "base" });
  assert.deepEqual(rowsOf(chrome.host).map((row) => [row.name, row.count]), [["obsidian", "141"]], "tag rows survive note/Base switches");
  context.destroy();
});
