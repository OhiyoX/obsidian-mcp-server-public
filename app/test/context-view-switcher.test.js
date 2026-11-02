// Frontend tests for the note-context rail view switcher (U1 desktop parity; rail top layout U7/U18/U29).
//
// Desktop keeps outline / outgoing links / backlinks / tags in the same right rail and
// shows exactly one view at a time, picked from the icon row at the top of the rail. U18
// made that row panel switching plus (U29 / #371) one pane-level close; the rail's show/hide
// control is a topbar action. These tests pin down the real `pages.js` markup (one tab row
// with the exact icon set, each panel's own head holding its real actions, one visible panel
// by default) and the element-scoped switcher behaviour (only the selected view visible,
// remembered view, invalid/absent storage, the active tab requesting a collapse, no-op
// without markup).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { attachNoteContext } from "../frontend/app/features/context/attach-note-context.js";
import {
  CONTEXT_VIEWS,
  DEFAULT_CONTEXT_VIEW,
  createContextViewSwitcher,
  normalizeContextView,
  onRailCollapseRequest,
} from "../frontend/app/features/context/view-switcher.js";

const dom = createDomHarness();
dom.install();

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

function topRowBlock(page) {
  return block(page, 'class="context-header context-view-header"', "</header>");
}

function panelBlock(page, name) {
  return block(page, `data-context-view-panel="${name}"`, "</section>");
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

// Fixture mirroring the real rail markup (icons omitted: only the switcher contract).
function mountRail({ storage = null, initial = null } = {}) {
  const root = dom.createElement("aside");
  root.id = "context-sidebar";

  // U18: the rail header is the panel layer — panel switching only.
  const header = dom.createElement("header");
  header.className = "context-header context-view-header";
  const switcher = dom.createElement("div");
  switcher.className = "context-view-switcher";
  const buttons = CONTEXT_VIEWS.map((name) => {
    const button = dom.createElement("button");
    button.className = "icon-btn context-view-btn";
    button.setAttribute("data-context-view", name);
    button.setAttribute("aria-selected", String(name === DEFAULT_CONTEXT_VIEW));
    button.setAttribute("aria-controls", `context-view-${name}`);
    switcher.append(button);
    return button;
  });
  const tools = dom.createElement("div");
  tools.className = "context-view-tools tags-tools";
  header.append(switcher);

  const panels = CONTEXT_VIEWS.map((name) => {
    const section = dom.createElement("section");
    section.id = `context-view-${name}`;
    section.className = "context-view";
    section.setAttribute("data-context-view-panel", name);
    section.hidden = name !== DEFAULT_CONTEXT_VIEW;
    return section;
  });

  root.append(header, ...panels);
  // U7: the tags tools live inside the tags panel's own head, not in the tab row.
  panels.find((panel) => panel.getAttribute("data-context-view-panel") === "tags").append(tools);
  dom.document.body.replaceChildren(root);
  const view = createContextViewSwitcher({ documentRef: dom.document, storage, initial });
  return { root, buttons, panels, tools, view, storage };
}

const tagsPanelOf = (rail) => rail.panels.find((panel) => panel.getAttribute("data-context-view-panel") === "tags");

const visible = (panels) => panels.filter((panel) => panel.hidden === false).map((panel) => panel.getAttribute("data-context-view-panel"));

// --- real shell markup ------------------------------------------------------

test("the shell rail carries one tab row with the exact desktop view icon set", async () => {
  const page = await shellMarkup();
  const row = topRowBlock(page);

  // U18: the show/hide control is a layout-layer control (the document tab row), so the
  // panel row carries panel switching only — no collapse chevron, no rail toggle.
  assert.equal(row.includes('id="context-close"'), false, "the collapse control left the panel row");
  assert.equal(row.includes('id="sidebar-toggle"'), false, "the rail toggle is not in the panel row");
  assert.equal(page.includes('id="context-close"'), false, "the collapse control is gone from the shell");

  // Exactly the four implemented views, in the frozen order, each with its own icon.
  const order = [...row.matchAll(/data-context-view="([a-z]+)"[^>]*>/g)].map((match) => match[1]);
  assert.deepEqual(order, ["outline", "outgoing", "incoming", "tags"], "exactly the four view buttons in order");
  assert.equal(row.includes("#list-tree"), true, "outline uses the list icon");
  assert.equal(row.includes("#link-out") && row.includes("#link-in"), true, "the two link views use distinct link icons");
  assert.equal(row.includes("#tag"), true, "tags uses the tag icon");
  assert.equal(row.includes("#calendar") || row.includes("#table"), false, "no desktop-only views are fabricated");

  // The tags view's own tools belong to the tags panel head (U7), never to the tab row.
  assert.equal(row.includes("context-view-tools"), false, "the tab row hosts tabs only");
  assert.equal(row.includes("tags-sort-toggle") || row.includes("tags-filter-toggle"), false, "no panel tool in the tab row");
  const tagsHead = page.slice(
    page.lastIndexOf("<header", page.indexOf('data-context-panel="tags"')),
    page.indexOf("</header>", page.indexOf('data-context-panel="tags"')) + "</header>".length,
  );
  assert.equal(tagsHead.includes('class="context-view-tools tags-tools"'), true, "tags tools are the tags panel head");
  assert.equal(tagsHead.includes('id="tags-sort-toggle"') && tagsHead.includes('id="tags-filter-toggle"'), true, "tags sort + filter live in the tags head");
  assert.deepEqual(
    [...tagsHead.matchAll(/data-tags-(?:sort|direction)="[a-z]+"[^>]*>([^<]+)</g)].map((match) => match[1]),
    ["按数量", "按名称", "降序", "升序"],
    "the tags head keeps exactly the four real sort options",
  );
});

test("the shell shows only the outline view by default and keeps the other three hidden", async () => {
  const page = await shellMarkup();
  const outline = panelBlock(page, "outline");
  assert.equal(outline.includes("hidden"), false, "the default outline view is visible");
  for (const name of ["outgoing", "incoming", "tags"]) {
    assert.equal(panelBlock(page, name).includes("hidden"), true, `${name} starts hidden`);
  }

  // Content and interactions survive the restructure: counts, `⋮` menus, empty copy.
  const outgoing = panelBlock(page, "outgoing");
  const incoming = panelBlock(page, "incoming");
  assert.equal(outgoing.includes('data-context-count="outgoing"'), true);
  assert.equal(incoming.includes('data-context-count="incoming"'), true);
  assert.deepEqual(
    [...outgoing.matchAll(/data-context-action="([a-z-]+)"[^>]*>([^<]*)</g)].map((match) => `${match[1]}=${match[2]}`),
    ["collapse=折叠", "refresh=刷新"],
  );
  assert.equal(outgoing.includes('<div class="context-empty">打开笔记后显示出链</div>'), true);
  assert.equal(incoming.includes('<div class="context-empty">打开笔记后显示反向链接</div>'), true);
  const tags = panelBlock(page, "tags");
  assert.equal(tags.includes('<span class="context-title">标签</span>'), true);
  assert.equal(tags.includes('<div class="context-empty">没有标签</div>'), true);
  assert.equal(tags.includes('id="tags-list"'), true);
});

// --- switcher behaviour -----------------------------------------------------

test("clicking a view icon shows only that panel, so its own head and tools follow", () => {
  const rail = mountRail();
  assert.equal(rail.view.isWired, true);
  assert.equal(rail.view.getView(), "outline");
  assert.deepEqual(visible(rail.panels), ["outline"]);
  assert.equal(tagsPanelOf(rail).hidden, true, "the tags head (with its tools) is hidden while outline is active");
  assert.equal(tagsPanelOf(rail).querySelector(".tags-tools") === rail.tools, true, "the tools are inside the tags panel");

  for (const name of CONTEXT_VIEWS) {
    rail.buttons.find((button) => button.getAttribute("data-context-view") === name).click();
    assert.equal(rail.view.getView(), name);
    assert.deepEqual(visible(rail.panels), [name], `only ${name} is visible`);
    assert.equal(tagsPanelOf(rail).hidden, name !== "tags", `the tags head ${name === "tags" ? "shows" : "stays hidden"} for ${name}`);
    for (const button of rail.buttons) {
      assert.equal(button.getAttribute("aria-selected"), String(button.getAttribute("data-context-view") === name));
    }
  }
  rail.view.destroy();
});

test("clicking the tab of the already-selected view asks for a rail collapse", () => {
  const rail = mountRail();
  const requests = [];
  const off = onRailCollapseRequest(() => requests.push(rail.view.getView()));
  try {
    // The active view: collapse requested, selection unchanged, nothing persisted anew.
    rail.buttons.find((button) => button.getAttribute("data-context-view") === "outline").click();
    assert.deepEqual(requests, ["outline"], "the active tab publishes exactly one collapse request");
    assert.equal(rail.view.getView(), "outline", "the selected view does not change");
    assert.deepEqual(visible(rail.panels), ["outline"]);

    // Any other view: real switch, no collapse request.
    rail.buttons.find((button) => button.getAttribute("data-context-view") === "incoming").click();
    assert.deepEqual(requests, ["outline"], "switching views never collapses the rail");
    assert.equal(rail.view.getView(), "incoming");
    rail.buttons.find((button) => button.getAttribute("data-context-view") === "incoming").click();
    assert.deepEqual(requests, ["outline", "incoming"], "and the new active tab collapses instead");
    assert.equal(rail.view.getView(), "incoming");
  } finally {
    off();
  }
  rail.view.destroy();
});

test("the rail remembers the last view and falls back to outline for junk", () => {
  const storage = memoryStorage();
  const first = mountRail({ storage });
  first.buttons.find((button) => button.getAttribute("data-context-view") === "tags").click();
  assert.equal(storage.dump()["obsidian-web.context-view"], "tags");
  first.view.destroy();

  const restored = mountRail({ storage });
  assert.equal(restored.view.getView(), "tags");
  assert.deepEqual(visible(restored.panels), ["tags"]);
  assert.equal(tagsPanelOf(restored).hidden, false);
  restored.view.destroy();

  const junk = mountRail({ storage: memoryStorage({ "obsidian-web.context-view": "properties" }) });
  assert.equal(junk.view.getView(), "outline");
  assert.deepEqual(visible(junk.panels), ["outline"]);
  junk.view.destroy();

  assert.equal(normalizeContextView("incoming"), "incoming");
  assert.equal(normalizeContextView("bogus"), "outline");
  assert.equal(normalizeContextView(null), "outline");
});

test("the switcher is a no-op without the rail markup and after destroy", () => {
  const bare = createContextViewSwitcher({ documentRef: { querySelector: () => null } });
  assert.equal(bare.isWired, false);
  assert.equal(bare.getView(), null);
  bare.setView("tags");
  bare.destroy();

  const rail = mountRail();
  rail.view.destroy();
  const before = rail.view.getView();
  rail.buttons.find((button) => button.getAttribute("data-context-view") === "incoming").click();
  assert.equal(rail.view.getView(), before, "a destroyed switcher ignores clicks");
});

test("attachNoteContext wires the rail switcher without a second call site", async () => {
  const rail = mountRail();
  const outgoingHost = dom.createElement("nav");
  outgoingHost.id = "outgoing-list";
  const incomingHost = dom.createElement("nav");
  incomingHost.id = "incoming-list";
  const context = attachNoteContext({
    outgoingHost,
    incomingHost,
    openNote: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ links: [] }) }),
  });

  assert.equal(context.view.isWired, true);
  assert.equal(context.view.getView(), "outline");
  context.view.setView("incoming");
  assert.deepEqual(visible(rail.panels), ["incoming"]);
  assert.equal(outgoingHost.hidden === false && incomingHost.hidden === false, true, "sections keep their own visibility wiring");
  context.destroy();
});
