// U4: left sidebar top layout — desktop-style tab bar + per-panel action heads.
//
// Two halves:
//  1. source/DOM contract of `pages.js` (tab order, exact per-panel control sets, and
//     the "no fake control" rule: nothing is rendered for capabilities we do not have);
//  2. behaviour of `features/explorer/sidebar-panels.js` against a minimal element shim.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { appPage } from "../src/app/pages.js";
import { initializeSidebarPanels } from "../frontend/app/features/explorer/sidebar-panels.js";
import { DEFAULT_NOTE_NAME } from "../frontend/app/features/explorer/create-draft.js";
import { ICON_SPRITE_ATTR } from "../frontend/app/ui/icons.js";

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const pagesSource = await fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8");
const appSource = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");
const sprite = await fs.readFile(new URL("../src/app/assets/icons.svg", import.meta.url), "utf8");
const html = appPage({ csrf: "csrf", username: "tester", displayName: "Tester" }, { colorMode: "dark", themeId: "Things" });

function between(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = html.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return html.slice(from, to);
}

// U38 (#571): the shell publishes the sprite URL *with its content hash* on `<html>` (the
// attribute `ui/icons.js` resolves for every runtime glyph), and every SSR reference repeats that
// URL character for character. Assertions here are therefore built from the page's own publish
// point instead of a bare `icons.svg#<symbol>` literal, which the one-year `immutable` asset entry
// would pin: a reference that loses the hash is red, and the constant comes from the resolver.
const publishedSpriteUrl = (markup) => new RegExp(`<html[^>]*\\s${ICON_SPRITE_ATTR}="([^"]+)"`).exec(markup)?.[1] ?? null;
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const idsIn = (markup) => [...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
// Buttons declared with an id, in document order: the panel head's exact control set.
const buttonsIn = (markup) => [...markup.matchAll(/<button id="([^"]+)"/g)].map((match) => match[1]);

// --- pages.js structure ----------------------------------------------------------

test("the sidebar tab bar is the first chrome row and holds the two real panels", () => {
  const sidebar = between('<aside class="sidebar ', '<footer class="sidebar-footer">');
  const tabBarAt = sidebar.indexOf('class="sidebar-tabs"');
  assert.notEqual(tabBarAt, -1, "the tab bar exists");
  assert.ok(tabBarAt < sidebar.indexOf('id="panel-files"'), "the tab bar precedes the panels");
  const tabBar = sidebar.slice(0, sidebar.indexOf("</div>", tabBarAt));
  assert.match(tabBar, /role="tablist"/);
  const tabs = [...tabBar.matchAll(/data-sidebar-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["files", "search"], "exactly the two panels that really exist");
  assert.deepEqual([...tabBar.matchAll(/role="tab"/g)].length, 2);
  assert.deepEqual([...tabBar.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]), ["panel-files", "panel-search"]);
  assert.match(tabBar, /data-sidebar-tab="files"[^>]*aria-selected="true"/);
  assert.match(tabBar, /data-sidebar-tab="search"[^>]*aria-selected="false"/);
  // No bookmarks / graph / tag tab: those panels do not exist in this build.
  assert.doesNotMatch(tabBar, /bookmark/i);
  assert.doesNotMatch(tabBar, /graph/i);
  // U29 (#371): the pane-level close (✕) is a *pane* control, so it lives in the pane header next
  // to the two view tabs and both panels offer it — for both, it is the same one toggle as the
  // ribbon's. `data-pane-slot` is the shared shape both side panes expose.
  const paneHead = between('class="sidebar-head"', 'id="panel-files"');
  assert.match(paneHead, /data-pane-slot="switch"/);
  assert.match(paneHead, /id="panel-close"[^>]*aria-label="折叠侧栏"[^>]*data-pane-slot="close"/);
  assert.deepEqual(buttonsIn(paneHead), ["panel-close"], "the pane close is the header's only button");
  assert.ok(paneHead.indexOf('data-pane-slot="switch"') < paneHead.indexOf('id="panel-close"'), "the close follows the switcher (the pane header's far right)");
});

test("the files tab draws the desktop folder glyph, and the sprite defines it", () => {
  const published = publishedSpriteUrl(html);
  assert.match(published ?? "", /^\/app\/assets\/icons\.svg\?v=[0-9a-f]{16}$/, "the shell must publish the content-hashed sprite URL");
  assert.match(html, new RegExp(`data-sidebar-tab="files"[\\s\\S]*?<use href="${escapeRegExp(published)}#folder"></use></svg></button>`));
  assert.match(sprite, /<symbol id="folder" viewBox="0 0 24 24">/);
  // The desktop reference carries the full-width divider as well (Lucide `folder-closed`),
  // measured in scratch/web-bases/U8/probe/u8-desktop-glyph-profile.json.
  assert.match(sprite, /<symbol id="folder" viewBox="0 0 24 24"><path d="[^"]+"\/><path d="M2 10h20"\/><\/symbol>/);
});

test("each panel is a labelled tabpanel and only the search one starts hidden", () => {
  assert.match(html, /<section id="panel-files"[^>]*role="tabpanel"[^>]*aria-label="文件">/);
  assert.match(html, /<section id="panel-search"[^>]*role="tabpanel"[^>]*aria-label="搜索"[^>]*hidden>/);
  const filesTag = html.slice(html.indexOf("<section id=\"panel-files\""), html.indexOf(">", html.indexOf("<section id=\"panel-files\"")));
  assert.doesNotMatch(filesTag, /hidden/, "the file panel is the default view");
});

test("the file panel head carries exactly the real file actions", () => {
  const head = between('data-panel-head="files"', '<div id="files-status"');
  // U6 assertion migration (old -> new):
  //   old: ["new-note","explorer-sort-toggle","reveal-active","publishes-open","panel-close"]
  //   new: + new-folder (after new-note) + collapse-all (before panel-close)
  // U29 (#371) migration: `#panel-close` is a pane-level control and moved to the sidebar header
  // (asserted in the tab-bar test above), so the panel head now carries the panel's own actions.
  // Phase 2 flat view adds two more Web-only actions, also outside `.sidebar-actions`
  // (mode toggle + flat sort trigger; exactly one sort trigger is visible per mode).
  assert.deepEqual(buttonsIn(head), ["new-note", "new-folder", "explorer-sort-toggle", "reveal-active", "publishes-open", "explorer-mode-toggle", "explorer-flat-sort-toggle", "collapse-all"]);
  assert.match(head, /data-pane-slot="actions"/);
  // The frozen Chromium regression reads the sort/reveal/publish set out of `.sidebar-actions`.
  // U6 deliberately keeps the two new actions OUTSIDE that group so the frozen
  // `toolbarIds` deepEqual in scripts/web-regression/explorer.mjs is unchanged.
  const actions = between('<div class="sidebar-actions"', "</div>");
  assert.deepEqual([...actions.matchAll(/id="([^"]+)"/g)].map((match) => match[1]), ["explorer-sort-toggle", "reveal-active", "publishes-open"]);
  assert.match(head, /id="new-note"[^>]*aria-label="新建笔记"/);
  assert.match(head, /id="new-folder"[^>]*aria-label="新建文件夹"/);
  assert.match(head, /id="collapse-all"[^>]*aria-label="折叠全部"/);
  assert.match(head, /id="explorer-sort-menu"/);
  // Both new actions carry a real glyph (inline svg) and the desktop order:
  // new note, new folder, sort, collapse all, close.
  assert.match(head, /id="new-folder"[^>]*><svg[^>]*class="svg-icon"/);
  assert.match(head, /id="collapse-all"[^>]*><svg[^>]*class="svg-icon"/);
  assert.ok(head.indexOf('id="new-note"') < head.indexOf('id="new-folder"'));
  assert.ok(head.indexOf('id="new-folder"') < head.indexOf('id="explorer-sort-toggle"'));
  assert.equal(head.includes('id="panel-close"'), false, "the pane close is not a file action");
  // Capabilities this build does not have are still not faked into the head.
  assert.doesNotMatch(head, /id="rename-folder"/);
  assert.doesNotMatch(head, /重命名文件夹/);
});

test("the search input moved into the search panel, next to its own status row", () => {
  const head = between('data-panel-head="search"', '<div id="search-status"');
  // The input plus the three inline search controls, in order, with nothing else.
  assert.deepEqual(idsIn(head), ["search", "search-clear", "search-case", "semantic-search"]);
  assert.match(head, /<div class="search-row">/);
  assert.match(head, /id="search"[^>]*type="search"/);
  assert.match(head, /id="search-case"[^>]*>Aa<\/button>/);
  assert.match(head, /class="search-help"/);
  const panel = between('data-panel-head="search"', '<nav id="search-list"');
  assert.match(panel, /<div id="search-status" class="search-status" role="status"/);
  assert.ok(panel.indexOf('class="search-row"') < panel.indexOf('id="search-status"'), "the count row follows the search row");
  assert.doesNotMatch(panel, /explorer-sort|sort-key/, "the search panel has no sort control (the v2 contract has no sort)");
  // The file panel must not render a search box.
  const files = between('data-panel-head="files"', '<nav id="note-list"');
  assert.doesNotMatch(files, /id="search"/);
  assert.doesNotMatch(files, /class="search-row"/);
});

test("the two panels own their own list host and the tree keeps its note-list id", () => {
  const files = between('id="panel-files"', 'id="panel-search"');
  assert.match(files, /<nav id="note-list"[^>]*class="note-list/);
  const search = between('id="panel-search"', '<footer class="sidebar-footer">');
  assert.match(search, /<nav id="search-list"[^>]*class="note-list search-list"/);
});

test("the ribbon keeps the real panel toggle and no fake entries", () => {
  const ribbon = between('<aside class="ribbon', "</aside>");
  assert.match(ribbon, /id="files-toggle"/);
  assert.deepEqual([...ribbon.matchAll(/<button/g)].length, 1, "the ribbon still holds only the real files-panel entry");
  assert.doesNotMatch(ribbon, /id="settings-open"/);
});

test("sidebar chrome styles exist for the tabs, panels and grouped results", () => {
  assert.match(css, /\.sidebar-tabs \{[\s\S]*?display:\s*flex/);
  assert.match(css, /\.sidebar-tab\[aria-selected="true"\]/);
  assert.match(css, /\.sidebar-panel\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.panel-head \{/);
  assert.match(css, /\.search-group-count \{/);
  assert.match(css, /\.search-snippet mark/, "the found text uses the real highlight token");
});

test("app.js wires the panel chrome without growing past the architecture budget", () => {
  assert.match(appSource, /import \{ initializeSidebarPanels \} from "\.\.\/features\/explorer\/sidebar-panels\.js"/);
  assert.match(appSource, /initializeSidebarPanels\(/);
  assert.doesNotMatch(appSource, /#new-note/, "the new-note control belongs to the sidebar module, not core wiring");
  assert.doesNotMatch(appSource, /#files-toggle"\)\.onclick/, "the collapse behaviour moved into the sidebar module");
  assert.ok(appSource.split("\n").length <= 500);
  // The two hosts are wired through the explorer wiring (one list per panel).
  assert.match(appSource, /searchHost/);
});

// --- sidebar-panels behaviour -----------------------------------------------------

function makeElement(name, doc) {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  const element = {
    nodeName: String(name).toUpperCase(),
    dataset: {},
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    ownerDocument: doc,
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
    hasAttribute(key) { return attrs.has(String(key)); },
    removeAttribute(key) { attrs.delete(String(key)); },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    appendChild() {},
    querySelectorAll: () => [],
    focus() { this.focused = true; },
  };
  element.__fire = (type) => listeners.get(type)?.({ preventDefault() {} });
  element.__attrs = attrs;
  return element;
}

// #420: the pane reads and writes its docked preference through the guarded
// `globalThis.localStorage` accessor. Node has no `localStorage`, so the harness installs the same
// minimal store the right-rail tests use; an empty store is the documented "no preference -> open"
// default, and it keeps the suite's stderr free of Node's experimental-storage warning.
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function buildChrome({ storage = memoryStorage() } = {}) {
  globalThis.localStorage = storage;
  const doc = { createElement: (name) => makeElement(name, doc) };
  const shell = makeElement("div", doc);
  const filesToggle = makeElement("button", doc);
  const closeButton = makeElement("button", doc);
  const newNoteButton = makeElement("button", doc);
  newNoteButton.disabled = false;
  const newFolderButton = makeElement("button", doc);
  newFolderButton.disabled = false;
  const collapseAllButton = makeElement("button", doc);
  const searchInput = makeElement("input", doc);
  const tabs = [
    Object.assign(makeElement("button", doc), { dataset: { sidebarTab: "files" }, ariaSelected: () => tabs[0].getAttribute("aria-selected") }),
    Object.assign(makeElement("button", doc), { dataset: { sidebarTab: "search" }, ariaSelected: () => tabs[1].getAttribute("aria-selected") }),
  ];
  const panels = [
    Object.assign(makeElement("section", doc), { dataset: { sidebarPanel: "files" } }),
    Object.assign(makeElement("section", doc), { dataset: { sidebarPanel: "search" }, hidden: true }),
  ];
  const registry = new Map([
    ["[data-sidebar-tab]", tabs],
    ["[data-sidebar-panel]", panels],
    ["#search", searchInput],
  ]);
  const root = {
    querySelectorAll: (selector) => registry.get(selector) ?? [],
    querySelector: (selector) => registry.get(selector) ?? null,
  };
  return { root, shell, filesToggle, closeButton, newNoteButton, newFolderButton, collapseAllButton, searchInput, tabs, panels };
}

const desktopMedia = () => ({ matches: false });

test("clicking a tab selects exactly one panel; clicking the active tab collapses the sidebar", () => {
  const chrome = buildChrome();
  const panels = initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    newNoteButton: chrome.newNoteButton,
    onNewNoteDraft: () => {},
    matchMedia: desktopMedia,
  });
  assert.equal(panels.currentView(), "files");
  assert.equal(chrome.tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(chrome.panels[0].hidden, false);
  assert.equal(chrome.panels[1].hidden, true);

  chrome.tabs[1].__fire("click");
  assert.equal(panels.currentView(), "search");
  assert.equal(chrome.tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(chrome.tabs[0].getAttribute("aria-selected"), "false");
  assert.equal(chrome.panels[1].hidden, false);
  assert.equal(chrome.panels[0].hidden, true);
  assert.equal(chrome.searchInput.focused, true, "the search tab prepares its input");

  chrome.tabs[1].__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true, "re-clicking the active tab collapses the sidebar");
  assert.equal(chrome.filesToggle.classList.contains("active"), false);

  chrome.tabs[1].__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false);
  assert.equal(chrome.filesToggle.classList.contains("active"), true);
});

test("showView is the single owner of tab state and never invents a third view", () => {
  const chrome = buildChrome();
  const panels = initializeSidebarPanels({ root: chrome.root, shell: chrome.shell, filesToggle: chrome.filesToggle, matchMedia: desktopMedia });
  panels.showView("search");
  assert.equal(chrome.panels[1].hidden, false);
  panels.showView("files");
  assert.equal(chrome.panels[0].hidden, false);
  panels.showView("nope");
  assert.equal(panels.currentView(), "files", "an unknown view is ignored");
  assert.equal(chrome.panels[0].hidden, false);
});

test("the panel close button performs the same real collapse as the ribbon toggle", () => {
  const chrome = buildChrome();
  initializeSidebarPanels({ root: chrome.root, shell: chrome.shell, filesToggle: chrome.filesToggle, closeButton: chrome.closeButton, matchMedia: desktopMedia });
  chrome.closeButton.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true);
  chrome.closeButton.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false);
  // On a narrow drawer the same control closes the drawer instead.
  const mobile = buildChrome();
  initializeSidebarPanels({ root: mobile.root, shell: mobile.shell, filesToggle: mobile.filesToggle, closeButton: mobile.closeButton, matchMedia: () => ({ matches: true }) });
  mobile.closeButton.__fire("click");
  assert.equal(mobile.shell.classList.contains("sidebar-open"), true);
  assert.equal(mobile.shell.classList.contains("sidebar-hidden"), false);
});

test("the panel-head new-note action only opens a draft (issue #427: no name, no write)", () => {
  const chrome = buildChrome();
  const calls = [];
  let resolveWrite;
  const api = () => new Promise((resolve) => { resolveWrite = resolve; });
  initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    newNoteButton: chrome.newNoteButton,
    onNewNoteDraft: () => calls.push("draft"),
    api,
    matchMedia: desktopMedia,
  });
  chrome.newNoteButton.__fire("click");
  assert.deepEqual(calls, ["draft"], "the click reports the draft intent and nothing else");
  assert.equal(DEFAULT_NOTE_NAME, "未命名笔记", "the draft's default name is the frozen product string");
  resolveWrite({ vaults: [{ id: "default", writable: true }], current: "default" });
  return Promise.resolve().then(() => {
    assert.equal(chrome.newNoteButton.disabled, false);
  });
});

test("closing the pane reports the close so an uncommitted draft can be cancelled", () => {
  const chrome = buildChrome();
  const calls = [];
  initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    closeButton: chrome.closeButton,
    onClose: () => calls.push("close"),
    matchMedia: desktopMedia,
  });
  assert.deepEqual(calls, [], "opening the pane at boot is not a close");
  chrome.closeButton.__fire("click");
  assert.deepEqual(calls, ["close"]);
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true);
  chrome.filesToggle.__fire("click");
  assert.deepEqual(calls, ["close"], "re-opening is not a close");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false);

  // A phone starts with the drawer closed: booting into it must not report a close
  // either (no draft can exist yet, and `explorer` is not constructed at that point).
  const narrow = buildChrome();
  const narrowCalls = [];
  initializeSidebarPanels({
    root: narrow.root,
    shell: narrow.shell,
    filesToggle: narrow.filesToggle,
    closeButton: narrow.closeButton,
    onClose: () => narrowCalls.push("close"),
    matchMedia: () => ({ matches: true }),
  });
  assert.deepEqual(narrowCalls, [], "booting into a closed drawer is not a close");
  narrow.filesToggle.__fire("click");
  assert.deepEqual(narrowCalls, [], "opening the drawer is not a close");
  narrow.closeButton.__fire("click");
  assert.deepEqual(narrowCalls, ["close"], "closing the open drawer is a close");
});

test("a read-only vault disables the new-note action and explains why", async () => {
  const chrome = buildChrome();
  const calls = [];
  initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    newNoteButton: chrome.newNoteButton,
    onNewNoteDraft: () => calls.push("created"),
    api: async () => ({ vaults: [{ id: "default", writable: false }], current: "default" }),
    matchMedia: desktopMedia,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chrome.newNoteButton.disabled, true);
  assert.match(chrome.newNoteButton.title, /只读/);
  chrome.newNoteButton.__fire("click");
  assert.deepEqual(calls, [], "a disabled action never fires the create flow");
});

test("the new-folder action opens the controller draft and never uses a browser prompt", () => {
  const chrome = buildChrome();
  const calls = [];
  initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    newFolderButton: chrome.newFolderButton,
    onNewFolder: () => calls.push("folder"),
    matchMedia: desktopMedia,
  });
  chrome.newFolderButton.__fire("click");
  assert.deepEqual(calls, ["folder"]);
  assert.doesNotMatch(pagesSource, /prompt\("新建文件夹/, "no browser prompt");
});

test("a read-only vault disables the new-folder action too", async () => {
  const chrome = buildChrome();
  const calls = [];
  initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    newNoteButton: chrome.newNoteButton,
    newFolderButton: chrome.newFolderButton,
    onNewFolder: () => calls.push("folder"),
    api: async () => ({ vaults: [{ id: "default", writable: false }], current: "default" }),
    matchMedia: desktopMedia,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chrome.newFolderButton.disabled, true);
  assert.match(chrome.newFolderButton.title, /只读/);
  chrome.newFolderButton.__fire("click");
  assert.deepEqual(calls, [], "a disabled action never opens the draft");
});

test("collapse-all is a real client action and stays available on a read-only vault", async () => {
  const chrome = buildChrome();
  const calls = [];
  initializeSidebarPanels({
    root: chrome.root,
    shell: chrome.shell,
    filesToggle: chrome.filesToggle,
    collapseAllButton: chrome.collapseAllButton,
    onCollapseAll: () => calls.push("collapse"),
    api: async () => ({ vaults: [{ id: "default", writable: false }], current: "default" }),
    matchMedia: desktopMedia,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chrome.collapseAllButton.disabled, false, "collapse-all is pure client state");
  chrome.collapseAllButton.__fire("click");
  assert.deepEqual(calls, ["collapse"]);
});
