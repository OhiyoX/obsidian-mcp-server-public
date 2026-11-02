// Frontend tests for the U7 right-rail top layout (desktop parity).
//
// Desktop's right rail renders two stacked rows above the panel content:
//   1. the rail's own tab row — one icon tab per view (U18: panel switching only; the
//      rail's show/hide control moved to the layout layer, the document tab row);
//   2. the active panel's **own** head — that panel's real actions only
//      (Outgoing links: 📖 show/hide unlinked mentions + ⋮; Backlinks: ⋮; Tags: sort/filter).
// The content section titles/counts (U2) live inside the panel, under its head.
//
// These tests pin the real `pages.js` markup (row split, per-panel head control sets,
// no fabricated desktop-only controls) and the behaviour: clicking the already-active
// tab collapses the rail, the layout-layer `#sidebar-toggle` (U29: a topbar action) collapses it
// from outside the rail and restores it, the pane-level `#context-drawer-close` is a client of the
// same one state, and the 📖 switch really hides the unlinked-mentions section and remembers it.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { attachNoteContext } from "../frontend/app/features/context/attach-note-context.js";
import { initializeContextPane } from "../frontend/app/features/context/pane-layout.js";
import { CONTEXT_VIEWS, DEFAULT_CONTEXT_VIEW } from "../frontend/app/features/context/view-switcher.js";

const dom = createDomHarness();
dom.install();

// Persisted-preference contract: literals on purpose, because a rename silently loses
// the user's saved choice across reloads.
const RAIL_OPEN_KEY = "obsidian-web.context-open";
const UNLINKED_VISIBLE_KEY = "obsidian-web.context-unlinked";

async function shellMarkup() {
  const { appPage } = await import("../src/app/pages.js");
  return appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});
}

function block(page, openNeedle, closeToken) {
  const anchor = page.indexOf(openNeedle);
  assert.ok(anchor > 0, `shell must contain ${openNeedle}`);
  const open = page.lastIndexOf("<", anchor);
  const end = page.indexOf(closeToken, anchor);
  return page.slice(open, end + closeToken.length);
}

const topRowBlock = (page) => block(page, 'class="context-header context-view-header"', "</header>");
const panelBlock = (page, name) => block(page, `data-context-view-panel="${name}"`, "</section>");
const sectionHeaderBlock = (page, name) => block(page, `data-context-section="${name}"`, "</header>");
const panelHeadBlock = (page, name) => block(page, `data-context-panel="${name}"`, "</header>");
const idsIn = (markup) => [...markup.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
const menuItemsOf = (markup) => [...markup.matchAll(/data-context-action="([a-z-]+)"[^>]*>([^<]*)</g)].map((match) => `${match[1]}=${match[2]}`);

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

// --- markup: tab row + per-panel heads --------------------------------------

test("the rail tab row keeps exactly the four view tabs and the pane-level close", async () => {
  const page = await shellMarkup();
  const topbarAt = page.indexOf('<header class="topbar view-header">');
  const row = topRowBlock(page);

  // U18 + U29: the show/hide control is a layout-layer control (the topbar's actions), so this
  // panel row carries panel switching plus its own pane-level close — never the layout toggle.
  assert.equal(row.includes('id="context-close"'), false, "the old collapse chevron left the panel row");
  assert.equal(row.includes('id="sidebar-toggle"'), false, "the rail toggle is not in the panel row");
  assert.equal(page.includes('id="context-close"'), false, "the chevron is gone from the shell");
  // U29 (#371): the symmetric counterpart of the left pane's ✕ — one pane close per pane header.
  assert.match(row, /id="context-drawer-close"[^>]*data-pane-slot="close"/, "the pane-level close is the panel row's close slot");
  assert.ok(row.indexOf('role="tablist"') < row.indexOf('id="context-drawer-close"'), "the close follows the view switcher (the pane header's far right)");
  assert.equal((page.match(/id="context-drawer-close"/g) ?? []).length, 1, "exactly one pane-level rail close");
  assert.deepEqual(
    [...row.matchAll(/data-context-view="([a-z]+)"/g)].map((match) => match[1]),
    ["outline", "outgoing", "incoming", "tags"],
    "exactly the four implemented views, in the frozen order",
  );
  assert.equal(row.includes('role="tablist"'), true);
  assert.equal(row.includes("#link-in") && row.includes("#link-out") && row.includes("#tag"), true, "each view keeps its own icon");
  assert.equal(row.includes("#calendar") || row.includes("#table") || row.includes("#book-open"), false, "no view icon is fabricated into the tab row");

  // Layout layer proof: the rail toggle is a topbar action, and the tab row carries no control.
  const topbar = page.slice(topbarAt, page.indexOf("</header>", topbarAt));
  assert.equal(topbar.includes('id="sidebar-toggle"'), true, "the rail toggle lives in the topbar's actions");
  const tabRow = page.slice(page.indexOf('<div class="document-tab-row">'), page.indexOf('<section class="document workspace-leaf-content view-content">'));
  assert.equal(tabRow.includes('id="sidebar-toggle"'), false, "the document tab row carries no rail control");
  assert.equal(tabRow.includes('id="context-close"'), false, "and the panel row keeps no collapse control");

  // Per-panel controls are no longer parked in the shared row: the tab row owns tabs only.
  assert.equal(row.includes("context-view-tools"), false, "the shared row no longer hosts panel tools");
  assert.equal(row.includes("tags-sort-toggle") || row.includes("tags-filter-toggle"), false, "tags tools leave the shared row");
  assert.equal(row.includes("unlinked-toggle"), false, "the unlinked switch belongs to its panel head");
  assert.equal(row.includes("context-section-menu-toggle"), false, "the ⋮ menus belong to their panel heads");
});

test("each panel head carries exactly that panel's real actions", async () => {
  const page = await shellMarkup();

  // Outgoing links: 📖 show/hide unlinked mentions + the existing ⋮ (collapse/refresh).
  const outgoingHead = panelHeadBlock(page, "outgoing");
  assert.deepEqual(idsIn(outgoingHead), ["unlinked-toggle", "outgoing-menu-toggle"], "outgoing head = 📖 + ⋮ only");
  assert.deepEqual(menuItemsOf(outgoingHead), ["collapse=折叠", "refresh=刷新"], "the ⋮ keeps exactly the two real actions");
  assert.equal(outgoingHead.includes("#book-open"), true, "the switch uses the existing book-open symbol");

  // Backlinks: only the ⋮ — this app has no unlinked section there, so no 📖 switch.
  const incomingHead = panelHeadBlock(page, "incoming");
  assert.deepEqual(idsIn(incomingHead), ["incoming-menu-toggle"], "incoming head = ⋮ only");
  assert.deepEqual(menuItemsOf(incomingHead), ["collapse=折叠", "refresh=刷新"]);

  // Tags: the existing sort/filter tools, moved out of the shared row into this panel.
  const tagsHead = panelHeadBlock(page, "tags");
  assert.deepEqual(
    idsIn(tagsHead),
    ["tags-sort-toggle", "tags-filter-toggle"],
    "tags head = the two real tools (plus their own menu, asserted below)",
  );
  assert.equal(tagsHead.includes('id="tags-sort-menu"'), true, "the tags menu belongs to the tags head");
  assert.deepEqual(
    [...tagsHead.matchAll(/data-tags-(?:sort|direction)="[a-z]+"[^>]*>([^<]+)</g)].map((match) => match[1]),
    ["按数量", "按名称", "降序", "升序"],
    "the tags menu keeps exactly the four real options",
  );
  assert.equal(tagsHead.includes('class="context-title">标签<'), true, "the tags head keeps its title");

  // Outline has no real panel action → no head element at all (no empty fake row).
  assert.equal(page.includes('data-context-panel="outline"'), false, "no fabricated outline panel head");
  assert.equal(panelBlock(page, "outline").includes("context-panel-head"), false, "the outline panel has no head row");

  // Each panel head lives inside its own panel, so it follows the view switch.
  for (const name of ["outgoing", "incoming", "tags"]) {
    const panel = panelBlock(page, name);
    assert.equal(panel.includes(`data-context-panel="${name}"`), true, `${name}'s head is inside ${name}'s panel`);
  }
  // And the section titles/counts stay content-level (U2 contract, unchanged).
  assert.equal(sectionHeaderBlock(page, "outgoing").includes('<span class="context-title">当前笔记中的链接</span>'), true);
  assert.equal(sectionHeaderBlock(page, "outgoing").includes('data-context-count="outgoing"'), true);
  assert.equal(sectionHeaderBlock(page, "outgoing").includes("context-section-menu-toggle"), false, "the ⋮ left the section header");
  assert.equal(sectionHeaderBlock(page, "incoming").includes('<span class="context-title">链接当前笔记</span>'), true);
  assert.equal(sectionHeaderBlock(page, "unlinked").includes("context-section-menu-toggle"), false, "the unlinked section keeps no ⋮");
});

test("no desktop-only panel action and no fake control is rendered", async () => {
  const page = await shellMarkup();
  const start = page.indexOf('id="context-sidebar"');
  const rail = page.slice(start, page.indexOf("</aside>", start));
  for (const fake of ["#bookmarks", "#graph", "#properties", "#new-folder", "#collapse-all", "在页面中显示", "显示更多上下文", "更改排序方式", "显示搜索筛选"]) {
    assert.equal(rail.includes(fake), false, `no fabricated control: ${fake}`);
  }
  assert.deepEqual(
    [...rail.matchAll(/data-context-action="([a-z-]+)"/g)].map((match) => match[1]),
    ["collapse", "refresh", "collapse", "refresh"],
    "the only panel actions are the two real ones, once per link panel",
  );
  assert.equal([...rail.matchAll(/context-section-menu-toggle/g)].length, 2, "one ⋮ per link panel");
  assert.equal([...rail.matchAll(/id="unlinked-toggle"/g)].length, 1, "a single unlinked-mentions switch");
  assert.equal(rail.includes("#bookmark") || rail.includes('data-context-view="graph"'), false);
});

// --- behaviour: the panel head follows the view -----------------------------

function buildRail({ storage, withShell = false } = {}) {
  const root = dom.createElement("aside");
  root.id = "context-sidebar";
  root.className = "context-sidebar";

  const row = dom.createElement("header");
  row.className = "context-header context-view-header";
  const switcher = dom.createElement("div");
  switcher.className = "context-view-switcher";
  switcher.setAttribute("role", "tablist");
  const tabs = CONTEXT_VIEWS.map((name) => {
    const button = dom.createElement("button");
    button.className = "icon-btn context-view-btn";
    button.setAttribute("data-context-view", name);
    button.setAttribute("aria-selected", String(name === DEFAULT_CONTEXT_VIEW));
    button.setAttribute("aria-controls", `context-view-${name}`);
    switcher.append(button);
    return button;
  });
  row.append(switcher);

  const panels = {};
  const panel = (name) => {
    const section = dom.createElement("section");
    section.id = `context-view-${name}`;
    section.className = "context-view";
    section.setAttribute("data-context-view-panel", name);
    section.hidden = name !== DEFAULT_CONTEXT_VIEW;
    panels[name] = section;
    return section;
  };

  const outline = panel("outline");
  const outlineList = dom.createElement("nav");
  outlineList.id = "outline-list";
  outline.append(outlineList);

  function linkHead(name, ids) {
    const head = dom.createElement("header");
    head.className = "context-header context-panel-head";
    head.setAttribute("data-context-panel", name);
    const buttons = ids.map((id) => {
      const button = dom.createElement("button");
      button.id = id;
      button.className = "icon-btn";
      head.append(button);
      return button;
    });
    return { head, buttons };
  }

  const outgoing = panel("outgoing");
  const outgoingHead = linkHead("outgoing", ["unlinked-toggle", "outgoing-menu-toggle"]);
  const outgoingSection = dom.createElement("header");
  outgoingSection.className = "context-header context-section-header";
  outgoingSection.setAttribute("data-context-section", "outgoing");
  const outgoingCount = dom.createElement("span");
  outgoingCount.className = "context-section-count";
  outgoingSection.append(outgoingCount);
  const outgoingList = dom.createElement("nav");
  outgoingList.id = "outgoing-list";
  outgoingList.className = "outline-list";
  const splitter = dom.createElement("div");
  splitter.id = "context-rail-splitter";
  splitter.className = "context-rail-splitter";
  const unlinkedSection = dom.createElement("header");
  unlinkedSection.className = "context-header context-section-header unlinked-header";
  unlinkedSection.setAttribute("data-context-section", "unlinked");
  const unlinkedCount = dom.createElement("span");
  unlinkedCount.className = "context-section-count";
  unlinkedSection.append(unlinkedCount);
  const unlinkedList = dom.createElement("nav");
  unlinkedList.id = "unlinked-list";
  unlinkedList.className = "outline-list";
  outgoing.append(outgoingHead.head, outgoingSection, outgoingList, splitter, unlinkedSection, unlinkedList);

  const incoming = panel("incoming");
  const incomingHead = linkHead("incoming", ["incoming-menu-toggle"]);
  const incomingList = dom.createElement("nav");
  incomingList.id = "incoming-list";
  incoming.append(incomingHead.head, incomingList);

  const tags = panel("tags");
  const tagsHead = dom.createElement("header");
  tagsHead.className = "context-header context-panel-head tags-header";
  tagsHead.setAttribute("data-context-panel", "tags");
  tagsHead.setAttribute("data-context-section", "tags");
  const tagsTools = dom.createElement("div");
  tagsTools.className = "context-view-tools tags-tools";
  const tagsList = dom.createElement("nav");
  tagsList.id = "tags-list";
  tagsHead.append(tagsTools);
  tags.append(tagsHead, tagsList);

  root.append(row, outline, outgoing, incoming, tags);

  let shell = null;
  let sidebarToggle = null;
  if (withShell) {
    shell = dom.createElement("div");
    shell.className = "shell";
    // U18 + U29 (#371): the rail's show/hide control is the topbar's layout action;
    // `pane-layout` resolves it (and the panel row's pane close) from the shell. #398 removed
    // the ⋮ menu's secondary `#outline-toggle`, so this toggle is the one rail entry.
    const topbar = dom.createElement("header");
    topbar.className = "topbar view-header";
    sidebarToggle = dom.createElement("button");
    sidebarToggle.id = "sidebar-toggle";
    sidebarToggle.setAttribute("aria-pressed", "true");
    topbar.append(sidebarToggle);
    shell.append(topbar, root);
    dom.document.body.replaceChildren(shell);
  } else {
    dom.document.body.replaceChildren(root);
  }

  const context = attachNoteContext({
    outgoingHost: outgoingList,
    incomingHost: incomingList,
    openNote: () => {},
    storage,
    loadTags: false,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ links: [], mentions: [] }) }),
  });

  return {
    root, row, switcher, tabs, panels, shell, sidebarToggle,
    outgoingHead: outgoingHead.head, outgoingToggle: outgoingHead.buttons[0], outgoingMenu: outgoingHead.buttons[1],
    incomingHead: incomingHead.head, incomingMenu: incomingHead.buttons[0],
    outgoingList, splitter, unlinkedSection, unlinkedList, tagsHead, tagsTools, incomingList,
    context,
    visible: () => CONTEXT_VIEWS.filter((name) => panels[name].hidden === false),
  };
}

test("switching a tab moves the visible panel (and therefore its head) with it", () => {
  const rail = buildRail({ storage: memoryStorage() });
  assert.equal(rail.context.view.isWired, true);
  assert.deepEqual(rail.visible(), ["outline"], "the outline view is the default");

  for (const name of CONTEXT_VIEWS) {
    rail.tabs.find((tab) => tab.getAttribute("data-context-view") === name).click();
    assert.deepEqual(rail.visible(), [name], `only ${name} is visible`);
    assert.equal(rail.context.view.getView(), name);
    for (const tab of rail.tabs) {
      assert.equal(tab.getAttribute("aria-selected"), String(tab.getAttribute("data-context-view") === name));
    }
  }

  // The head of a hidden panel is inside that hidden panel: never visible alongside another.
  rail.tabs.find((tab) => tab.getAttribute("data-context-view") === "tags").click();
  assert.equal(rail.panels.outgoing.hidden, true, "the outgoing panel (and its head) is hidden with the tags view");
  assert.equal(rail.panels.tags.hidden, false);
  rail.context.destroy();
});

// --- behaviour: clicking the active tab collapses the rail -------------------

function stubBrowser({ open = true, narrow = false } = {}) {
  const previous = { localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia };
  globalThis.localStorage = {
    store: new Map(open ? [] : [[RAIL_OPEN_KEY, "false"]]),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
    setItem(key, value) { this.store.set(key, String(value)); },
  };
  globalThis.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
  return {
    restore() {
      if (previous.localStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previous.localStorage;
      if (previous.matchMedia === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = previous.matchMedia;
    },
  };
}

test("the layout toggle collapses the rail from outside it, and restores it", () => {
  const browser = stubBrowser();
  try {
    const rail = buildRail({ storage: memoryStorage(), withShell: true });
    const pane = initializeContextPane({
      shell: rail.shell,
      scrim: dom.createElement("div"),
    });
    assert.equal(rail.shell.classList.contains("context-hidden"), false, "the rail starts open");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "true", "the layout toggle reports the open rail");

    // The active tab (outline) collapses instead of re-selecting (U7, unchanged).
    rail.tabs[0].click();
    assert.equal(rail.shell.classList.contains("context-hidden"), true, "clicking the active tab collapses the rail");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "false", "the layout toggle follows the same state");
    assert.equal(rail.context.view.getView(), "outline", "collapsing does not change the selected view");
    assert.equal(globalThis.localStorage.getItem(RAIL_OPEN_KEY), "false", "the collapse is remembered like the removed chevron's");

    // The layout toggle restores the rail (it is outside the rail, so it works while hidden).
    rail.sidebarToggle.click();
    assert.equal(pane.isNarrow(), false);
    assert.equal(rail.shell.classList.contains("context-hidden"), false, "the layout toggle restores the rail");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "true");
    assert.equal(globalThis.localStorage.getItem(RAIL_OPEN_KEY), "true", "restoring is remembered too");
    rail.tabs.find((tab) => tab.getAttribute("data-context-view") === "tags").click();
    assert.equal(rail.context.view.getView(), "tags");
    assert.equal(rail.shell.classList.contains("context-hidden"), false, "switching views does not collapse the rail");

    // The layout toggle performs the real collapse — the semantics #context-close used to own.
    rail.sidebarToggle.click();
    assert.equal(rail.shell.classList.contains("context-hidden"), true, "#sidebar-toggle really collapses the rail");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "false");
    assert.equal(globalThis.localStorage.getItem(RAIL_OPEN_KEY), "false");

    // #398: there is no ⋮ secondary rail path left — the one layout toggle stays two-way.
    assert.equal(dom.document.querySelector("#outline-toggle"), null, "the ⋮ outline item is gone");
    rail.sidebarToggle.click();
    assert.equal(rail.shell.classList.contains("context-hidden"), false, "the layout toggle restores the rail again");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "true");
    rail.context.destroy();
  } finally {
    browser.restore();
  }
});

test("on a narrow viewport the layout toggle opens the drawer and the active tab closes it", () => {
  const browser = stubBrowser({ narrow: true });
  try {
    const rail = buildRail({ storage: memoryStorage(), withShell: true });
    initializeContextPane({
      shell: rail.shell,
      scrim: dom.createElement("div"),
    });
    // U18: the layout-layer toggle is the narrow entry point; it never depends on ⋯.
    rail.sidebarToggle.click();
    assert.equal(rail.shell.classList.contains("context-open"), true, "the layout toggle opens the drawer");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "true");
    // #398: the same toggle is the only rail entry, and it closes the drawer it opened.
    rail.sidebarToggle.click();
    assert.equal(rail.shell.classList.contains("context-open"), false, "the layout toggle closes the drawer again");
    assert.equal(rail.sidebarToggle.getAttribute("aria-pressed"), "false");
    rail.sidebarToggle.click();
    assert.equal(rail.shell.classList.contains("context-open"), true, "the layout toggle re-opens it");
    rail.tabs[0].click();
    assert.equal(rail.shell.classList.contains("context-open"), false, "clicking the active tab closes the drawer");
    rail.context.destroy();
  } finally {
    browser.restore();
  }
});

// --- behaviour: the 📖 show/hide unlinked mentions switch --------------------

test("the unlinked switch really hides that section, remembers it, and keeps U3 intact", async () => {
  const storage = memoryStorage();
  const browser = stubBrowser();
  try {
    const rail = buildRail({ storage });
    rail.context.view.setView("outgoing");
    assert.equal(rail.panels.outgoing.hidden, false, "the outgoing view is on screen");
    assert.equal(rail.outgoingToggle.getAttribute("aria-pressed"), "true", "unlinked mentions are shown by default");
    for (const element of [rail.unlinkedSection, rail.unlinkedList, rail.splitter]) {
      assert.equal(element.hidden, false, "the whole unlinked section starts visible");
    }
    assert.equal(rail.context.splitter.isWired, true, "the U3 splitter is wired");
    assert.equal(rail.context.splitter.isSuspended?.(), false);

    rail.outgoingToggle.click();
    assert.equal(rail.unlinkedSection.hidden, true, "hiding removes the section header");
    assert.equal(rail.unlinkedList.hidden, true, "hiding removes the mention list");
    assert.equal(rail.splitter.hidden, true, "a hidden section keeps no height handle");
    assert.equal(rail.outgoingToggle.getAttribute("aria-pressed"), "false");
    assert.equal(storage.dump()[UNLINKED_VISIBLE_KEY], "false", "the choice is persisted");
    assert.equal(rail.context.splitter.isSuspended?.(), true, "the splitter stops applying a stored height");
    assert.equal(rail.outgoingList.hidden, false, "the outgoing list is untouched");
    assert.equal(rail.panels.outgoing.hidden, false, "the panel itself stays");

    // The choice survives a reload (fresh instance, same storage).
    rail.context.destroy();
    const reloaded = buildRail({ storage });
    reloaded.context.view.setView("outgoing");
    assert.equal(reloaded.outgoingToggle.getAttribute("aria-pressed"), "false", "the switch state survives a reload");
    assert.equal(reloaded.unlinkedSection.hidden, true);
    assert.equal(reloaded.unlinkedList.hidden, true);
    assert.equal(reloaded.splitter.hidden, true);
    assert.equal(reloaded.context.splitter.isSuspended?.(), true);

    // Switching documents must not silently re-show or re-hide the section.
    await reloaded.context.setDocument({ path: "Target.md" });
    assert.equal(reloaded.unlinkedSection.hidden, true, "a document switch keeps the user's choice");

    reloaded.outgoingToggle.click();
    assert.equal(reloaded.unlinkedSection.hidden, false, "the switch restores the section");
    assert.equal(reloaded.unlinkedList.hidden, false);
    assert.equal(reloaded.splitter.hidden, false);
    assert.equal(storage.dump()[UNLINKED_VISIBLE_KEY], "true");
    assert.equal(reloaded.context.splitter.isSuspended?.(), false);
    reloaded.outgoingToggle.click();
    assert.equal(reloaded.unlinkedSection.hidden, true, "and hides it again (real toggle, not one-way)");
    reloaded.context.destroy();
  } finally {
    browser.restore();
  }
});

test("the section title and count stay content-level (U2) while the head holds the switch", async () => {
  const page = await shellMarkup();
  const panel = panelBlock(page, "outgoing");
  const headIndex = panel.indexOf('data-context-panel="outgoing"');
  const sectionIndex = panel.indexOf('data-context-section="outgoing"');
  const unlinkedIndex = panel.indexOf('data-context-section="unlinked"');
  const listIndex = panel.indexOf('id="outgoing-list"');
  const splitterIndex = panel.indexOf('id="context-rail-splitter"');
  const unlinkedListIndex = panel.indexOf('id="unlinked-list"');
  assert.ok(headIndex > 0 && sectionIndex > headIndex, "the panel head comes before the section header");
  assert.ok(listIndex > sectionIndex && splitterIndex > listIndex, "the link list keeps its splitter (U3)");
  assert.ok(unlinkedIndex > splitterIndex && unlinkedListIndex > unlinkedIndex, "the unlinked section keeps its order (U2/U3)");
  assert.equal(/class="[^"]*context-panel-head[^"]*"\s+data-context-panel="outgoing"/.test(panel), true);
  assert.equal(/id="unlinked-toggle"[^>]*aria-pressed="true"/.test(panel), true, "the switch starts pressed (section shown)");

  // The tags panel head carries the tags title together with its own tools, above the list.
  const tags = panelBlock(page, "tags");
  assert.equal(tags.includes('data-context-section="tags"') && tags.includes("tags-tools"), true, "tags title + tools live in one head");
  assert.equal(tags.indexOf("tags-tools") < tags.indexOf('id="tags-list"'), true, "tools sit above the tag list");
});
