// U26 — issue #337 Cut 2: Bases mobile chrome.
//
// Three levels:
//   1. the visual-viewport channel (features/bases/mobile-viewport.js) as a pure
//      observer with fake windows/events;
//   2. the toolbar disclosure + overlay shell in the mounted toolbar (hamburger,
//      menu, panel header close button, backdrop dismissal);
//   3. the stylesheet contract: the mobile block consumes the safe-area and
//      visual-viewport channels, and the desktop popover rules are untouched.
//
// The real-browser geometry (full width, fixed positioning, computed padding,
// 44px targets, the whole `visualViewport` resize behaviour) is asserted by
// scripts/web-regression/bases-mobile.mjs, not here.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseToolbar } from "../frontend/app/features/bases/toolbar.js";
import { panelBackdrop, panelHeader, withPanelChrome } from "../frontend/app/features/bases/panel-chrome.js";
import { BASE_SURFACE_CSS } from "../frontend/app/features/bases/styles.js";
import {
  BASE_VISUAL_VIEWPORT_HEIGHT,
  BASE_VISUAL_VIEWPORT_OFFSET_TOP,
  applyVisualViewport,
  createVisualViewportObserver,
  readVisualViewport,
} from "../frontend/app/features/bases/mobile-viewport.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;

const COLUMNS = [
  { key: "name", label: "Name", kind: "property" },
  { key: "status", label: "Status", kind: "property" },
];

const ACTION_IDS = ["sort", "filter", "properties", "search", "new"];

// --- visual viewport channel -------------------------------------------------

function fakeWindow({ height = 800, offsetTop = 0, withVisualViewport = true } = {}) {
  const listeners = new Map();
  const viewport = withVisualViewport ? {
    height,
    offsetTop,
    addEventListener(type, listener) { listeners.set(`visualViewport:${type}`, listener); },
    removeEventListener(type, listener) { listeners.delete(`visualViewport:${type}`); },
  } : undefined;
  const win = {
    innerHeight: height,
    visualViewport: viewport,
    addEventListener(type, listener) { listeners.set(`window:${type}`, listener); },
    removeEventListener(type, listener) { listeners.delete(`window:${type}`); },
  };
  return {
    win,
    viewport,
    listeners,
    dispatch(target, type) {
      const listener = listeners.get(`${target}:${type}`);
      assert.equal(typeof listener, "function", `${target} ${type} listener must be registered`);
      listener({ type });
    },
  };
}

test("readVisualViewport prefers visualViewport and degrades to the layout viewport", () => {
  assert.deepEqual(
    readVisualViewport({ visualViewport: { height: 412.6, offsetTop: 24.2 }, innerHeight: 800 }),
    { height: 412.6, offsetTop: 24.2, source: "visualViewport" },
  );
  // No visualViewport (old browsers): the layout viewport is the honest fallback.
  assert.deepEqual(readVisualViewport({ innerHeight: 640 }), { height: 640, offsetTop: 0, source: "innerHeight" });
  // A visualViewport without numbers is not trustworthy either.
  assert.deepEqual(readVisualViewport({ visualViewport: {}, innerHeight: 640 }), { height: 640, offsetTop: 0, source: "innerHeight" });
  // iOS reports a negative offsetTop while rubber-banding; it is never a top edge.
  assert.equal(readVisualViewport({ visualViewport: { height: 500, offsetTop: -12 }, innerHeight: 800 }).offsetTop, 0);
  // Nothing usable at all must stay null instead of publishing a zero band.
  assert.equal(readVisualViewport({ visualViewport: { height: 0 }, innerHeight: 0 }), null);
  assert.equal(readVisualViewport(null), null);
});

test("applyVisualViewport publishes rounded pixel bands as custom properties", () => {
  const element = document.createElement("div");
  assert.equal(applyVisualViewport(element, { height: 412.6, offsetTop: 24.2 }), true);
  assert.equal(element.style.getPropertyValue(BASE_VISUAL_VIEWPORT_HEIGHT), "413px");
  assert.equal(element.style.getPropertyValue(BASE_VISUAL_VIEWPORT_OFFSET_TOP), "24px");
  // No metrics / no style surface is a no-op, never a crash.
  assert.equal(applyVisualViewport(element, null), false);
  assert.equal(applyVisualViewport(null, { height: 100, offsetTop: 0 }), false);
});

test("the visual-viewport observer republishes on resize/scroll and re-attaches to a rebuilt target", () => {
  const fake = fakeWindow({ height: 800, offsetTop: 0 });
  const first = document.createElement("div");
  const second = document.createElement("div");
  let target = first;
  const changes = [];
  const observer = createVisualViewportObserver({
    win: fake.win,
    resolveTarget: () => target,
    onChange: (metrics, element) => changes.push([metrics.height, metrics.offsetTop, element]),
  });

  assert.equal(observer.isAttached(), false);
  assert.equal(observer.attach(), true);
  assert.equal(observer.attach(), false, "attach() must be idempotent");
  assert.equal(fake.listeners.has("visualViewport:resize"), true);
  assert.equal(fake.listeners.has("visualViewport:scroll"), true);
  assert.equal(observer.sync().height, 800);
  assert.equal(first.style.getPropertyValue(BASE_VISUAL_VIEWPORT_HEIGHT), "800px");
  assert.equal(changes.length, 1);

  // Same band again: no republish, no duplicate notification.
  observer.sync();
  assert.equal(changes.length, 1);

  // The keyboard opens: visualViewport shrinks (and iOS pans it).
  fake.viewport.height = 336;
  fake.viewport.offsetTop = 44;
  fake.dispatch("visualViewport", "resize");
  assert.equal(first.style.getPropertyValue(BASE_VISUAL_VIEWPORT_HEIGHT), "336px");
  assert.equal(first.style.getPropertyValue(BASE_VISUAL_VIEWPORT_OFFSET_TOP), "44px");
  assert.deepEqual(changes[changes.length - 1].slice(0, 2), [336, 44]);

  // A re-render replaces the tool row: `force` re-applies to the new element even
  // though the metrics themselves did not change.
  target = second;
  observer.sync({ force: true });
  assert.equal(second.style.getPropertyValue(BASE_VISUAL_VIEWPORT_HEIGHT), "336px");
  assert.equal(second.style.getPropertyValue(BASE_VISUAL_VIEWPORT_OFFSET_TOP), "44px");

  observer.destroy();
  assert.equal(observer.isAttached(), false);
  assert.equal(fake.listeners.has("visualViewport:resize"), false, "destroy() must detach the listeners");
  observer.destroy(); // idempotent
});

test("without visualViewport the observer falls back to the window resize signal", () => {
  const fake = fakeWindow({ height: 700, withVisualViewport: false });
  const target = document.createElement("div");
  const observer = createVisualViewportObserver({ win: fake.win, resolveTarget: () => target });
  observer.attach();
  assert.equal(fake.listeners.has("window:resize"), true, "the layout viewport is the only signal left");
  observer.sync();
  assert.equal(target.style.getPropertyValue(BASE_VISUAL_VIEWPORT_HEIGHT), "700px");
  assert.equal(target.style.getPropertyValue(BASE_VISUAL_VIEWPORT_OFFSET_TOP), "0px");
  observer.destroy();
});

// --- toolbar chrome ----------------------------------------------------------

function state() {
  return {
    sort: [],
    filter: [],
    q: "",
    rows: [],
    columns: COLUMNS,
    views: [{ name: "Table", type: "table" }],
    view: "Table",
    path: "40-Projects/Projects.base",
    totalMatched: 0,
  };
}

function mountToolbar() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const toolbar = createBaseToolbar({ doc: document, onNewNote: () => {}, queryDebounceMs: 0 });
  const renders = { count: 0 };
  const render = () => {
    renders.count += 1;
    const header = toolbar.render(state(), { columns: COLUMNS, allColumns: COLUMNS, config: { hidden: [], widths: {} } });
    host.replaceChildren(header);
    toolbar.afterMount(header, render);
    return header;
  };
  render();
  return { host, toolbar, renders, render };
}

const outside = (type) => document.dispatchEvent({ type, target: hostOf(document.body) });
function hostOf(root) {
  return root.querySelector(".base-table-wrap") ?? root;
}

test("the hamburger is a disclosure control for the five real actions, and adds none", () => {
  const { host } = mountToolbar();
  const overflow = host.querySelector("[data-base-overflow]");
  assert.notEqual(overflow, null, "the mobile tool row must ship the hamburger");
  assert.equal(overflow.tagName, "BUTTON");
  assert.equal(overflow.getAttribute("aria-expanded"), "false");
  assert.equal(overflow.getAttribute("aria-haspopup"), null, "a disclosure is not an ARIA menu trigger");
  assert.ok(overflow.getAttribute("aria-label"));
  const controls = overflow.getAttribute("aria-controls");
  const row = host.querySelector(`#${controls}`);
  assert.notEqual(row, null, "aria-controls must resolve to the action row");
  assert.equal(row.getAttribute("data-base-action-row") !== null, true);
  assert.notEqual(overflow.querySelector("svg use"), null, "the hamburger needs its icon");
  assert.equal(overflow.classList.contains("base-action"), false, "the hamburger must not join the action vocabulary");
  // The action set itself is unchanged: five buttons, one anchor each.
  assert.deepEqual(host.querySelectorAll(".base-action").map((button) => button.getAttribute("data-base-action")), ACTION_IDS);
  assert.equal(host.querySelectorAll(".base-action-anchor").length, ACTION_IDS.length);
  assert.equal(overflow.classList.contains("is-open"), false);
});

test("tapping the hamburger opens the action menu and Escape closes it", () => {
  const { host, toolbar } = mountToolbar();
  const overflow = () => host.querySelector("[data-base-overflow]");
  const row = () => host.querySelector(".base-action-row");

  overflow().click();
  assert.equal(toolbar.getOverflowOpen(), true);
  assert.equal(overflow().getAttribute("aria-expanded"), "true");
  assert.equal(row().classList.contains("is-menu-open"), true, "the row must be revealed as the menu");
  assert.equal(row().classList.contains("is-panel-open"), false);
  assert.equal(host.querySelectorAll(".base-action-label").length, ACTION_IDS.length, "the menu keeps every label");

  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(toolbar.getOverflowOpen(), false, "Escape must dismiss the disclosure");
  assert.equal(overflow().getAttribute("aria-expanded"), "false");
  assert.equal(row().classList.contains("is-menu-open"), false);

  // A second tap closes it as well.
  overflow().click();
  overflow().click();
  assert.equal(toolbar.getOverflowOpen(), false);
});

test("picking an action from the menu opens the same panel the desktop contract builds", () => {
  const { host, toolbar } = mountToolbar();
  host.querySelector("[data-base-overflow]").click();
  host.querySelector('.base-action-row [data-base-action="new"]').click();

  assert.equal(toolbar.getOverflowOpen(), false, "the menu gives way to the panel");
  assert.equal(toolbar.getOpenPanel(), "new");
  const row = host.querySelector(".base-action-row");
  assert.equal(row.classList.contains("is-panel-open"), true, "the row stays renderable for the fixed overlay");
  assert.equal(row.classList.contains("is-menu-open"), false);
  assert.equal(row.querySelectorAll('[data-base-action="new"]').length, 1, "no second action copy is built for mobile");
  assert.equal(row.querySelector('[data-base-action="new"]').getAttribute("aria-expanded"), "true");

  const anchor = host.querySelector('[data-base-anchor="new"]');
  const panel = anchor.querySelector('[data-base-panel="new"]');
  assert.notEqual(panel, null, "the panel keeps its desktop anchor as its parent");
  assert.equal(panel.parentNode, anchor);
  // The mobile shell: a header with the panel's own label and a real close control.
  const header = panel.querySelector("[data-base-panel-header]");
  assert.notEqual(header, null);
  assert.equal(header.parentNode, panel);
  assert.equal(header.querySelector(".base-panel-header-label").textContent, "新建");
  const close = header.querySelector("[data-base-panel-close]");
  assert.equal(close.tagName, "BUTTON");
  assert.equal(close.getAttribute("aria-label"), "关闭");
  assert.notEqual(close.querySelector("svg use"), null);
  // ... and the backdrop that owns the tap-to-dismiss surface.
  const backdrop = anchor.querySelector("[data-base-panel-backdrop]");
  assert.notEqual(backdrop, null, "the overlay must mount its backdrop next to the panel");
  assert.equal(backdrop.parentNode, anchor);
  const siblings = anchor.childNodes.filter((node) => node.nodeType === 1);
  assert.ok(siblings.indexOf(backdrop) < siblings.indexOf(panel), "the backdrop must precede the panel in paint order");
});

test("the overlay header close button and the backdrop are the two dismissal controls", () => {
  // Close button.
  const first = mountToolbar();
  first.host.querySelector("[data-base-overflow]").click();
  first.host.querySelector('.base-action-row [data-base-action="new"]').click();
  first.host.querySelector("[data-base-panel-close]").click();
  assert.equal(first.toolbar.getOpenPanel(), null, "the header close button must close the overlay");
  assert.equal(first.host.querySelector("[data-base-panel]"), null);
  assert.equal(first.host.querySelector(".base-action-row").classList.contains("is-menu-open"), false, "and must not leave the menu open");

  // Backdrop: a bare press on it is chrome, not an outside click, so only the
  // backdrop's own handler can dismiss — which is what the browser negative
  // control removes to prove the check is load-bearing.
  const second = mountToolbar();
  second.host.querySelector("[data-base-overflow]").click();
  second.host.querySelector('.base-action-row [data-base-action="new"]').click();
  const backdrop = second.host.querySelector("[data-base-panel-backdrop]");
  document.dispatchEvent({ type: "mousedown", target: backdrop, composedPath: () => [backdrop, document] });
  assert.equal(second.toolbar.getOpenPanel(), "new", "a press on the backdrop must not be resolved by the generic outside-click path");
  document.dispatchEvent({ type: "click", target: backdrop, composedPath: () => [backdrop, document] });
  assert.equal(second.toolbar.getOpenPanel(), "new", "and neither may a bare click on it");
  backdrop.click();
  assert.equal(second.toolbar.getOpenPanel(), null, "the backdrop's own handler is the dismissal");
  assert.equal(second.host.querySelector("[data-base-panel-backdrop]"), null);
  assert.equal(second.host.querySelector(".base-action-row").classList.contains("is-panel-open"), false);
});

test("the desktop dismissal semantics survive the mobile chrome", () => {
  const { host, toolbar, renders } = mountToolbar();
  host.querySelector('.base-action-row [data-base-action="sort"]').click();
  assert.equal(toolbar.getOpenPanel(), "sort");
  const before = renders.count;

  // Clicking another action switches the panel instead of stacking two.
  host.querySelector('.base-action-row [data-base-action="filter"]').click();
  assert.equal(toolbar.getOpenPanel(), "filter");
  assert.equal(host.querySelectorAll("[data-base-panel]").length, 1);

  // An outside press/click still dismisses (and now also collapses the menu).
  document.dispatchEvent({ type: "mousedown", target: hostOf(host), composedPath: () => [hostOf(host), document] });
  assert.equal(toolbar.getOpenPanel(), null, "mousedown outside must still dismiss the popover");
  assert.ok(renders.count > before, "dismissal must still trigger the surface re-render");

  // Escape still closes, including when the menu was left open behind it.
  host.querySelector("[data-base-overflow]").click();
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(toolbar.getOverflowOpen(), false);

  // A key that is not Escape changes nothing.
  host.querySelector(".base-action-row [data-base-action=\"search\"]").click();
  document.dispatchEvent({ type: "keydown", key: "a" });
  assert.equal(toolbar.getOpenPanel(), "search");

  toolbar.closeAll();
  assert.equal(toolbar.getOpenPanel(), null);
  assert.equal(toolbar.getOverflowOpen(), false);
});

test("closeAll, destroy and the chrome helpers leave no stale mobile state", () => {
  const { toolbar } = mountToolbar();
  toolbar.destroy();
  assert.equal(toolbar.getOpenPanel(), null);
  assert.equal(toolbar.getOverflowOpen(), false);
  assert.equal(toolbar.getActionRow(), null);

  // The chrome helpers are presentation only and keep the panel identity.
  const panel = document.createElement("div");
  panel.className = "base-panel";
  panel.setAttribute("data-base-panel", "sort");
  const decorated = withPanelChrome(document, panel, { label: "排序", onClose: () => { decorated.closed = true; } });
  assert.equal(decorated, panel, "withPanelChrome must return the same node");
  assert.equal(panel.firstChild.className, "base-panel-header");
  panel.querySelector("[data-base-panel-close]").click();
  assert.equal(decorated.closed, true);
  assert.equal(withPanelChrome(document, null, {}), null, "a missing panel must not throw");

  let closed = 0;
  const backdrop = panelBackdrop(document, () => { closed += 1; });
  assert.equal(backdrop.getAttribute("data-base-panel-backdrop") !== null, true, "the dismissal hook must be observable");
  backdrop.click();
  assert.equal(closed, 1);
  assert.equal(panelHeader(document, { label: "排序", onClose: () => {} }).querySelector(".base-panel-header-label").textContent, "排序");
});

// --- stylesheet contract -----------------------------------------------------

test("the mobile block consumes the safe-area and visual-viewport channels", () => {
  assert.match(BASE_SURFACE_CSS, /#base-host\{--base-safe-area-top:env\(safe-area-inset-top,0px\)/, "the surface host must publish the safe-area channel with real env() values");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(BASE_SURFACE_CSS, new RegExp(`env\\(safe-area-inset-${side},0px\\)`), `the ${side} safe-area inset must be consumed`);
  }
  const mobile = BASE_SURFACE_CSS.slice(BASE_SURFACE_CSS.indexOf("@media (max-width:480px)"));
  assert.ok(mobile.length > 0, "the 480px mobile stylesheet must exist");
  assert.match(mobile, /\.base-toolbar-overflow\{display:inline-flex/, "the hamburger is revealed in the mobile block");
  assert.match(mobile, /\.base-action-row\{display:none;\}/, "the desktop action row collapses in the mobile block");
  assert.match(mobile, /\.base-action-row\.is-menu-open,\.base-action-row\.is-panel-open\{position:absolute/, "the revealed row is the menu");
  assert.match(mobile, /\.base-panel\{position:fixed;/, "the mobile panel is a fixed overlay");
  assert.match(mobile, /min-height:min\(var\(--base-visual-viewport-height,100dvh\),320px\);max-height:var\(--base-visual-viewport-height,100dvh\)/, "the overlay is bounded by the visual viewport");
  assert.match(mobile, /padding:max\(8px,var\(--base-safe-area-top,0px\)\)/, "the overlay consumes the safe-area channel");
  assert.match(mobile, /\.base-panel-header\{display:flex/, "the overlay renders its header row");
  assert.match(mobile, /\.base-panel-backdrop\{display:block;position:fixed/, "the mobile backdrop is a fixed layer");
  assert.match(mobile, /top:var\(--base-visual-viewport-offset-top,0px\)/, "the overlay follows the visual-viewport pan");
});

test("the new chrome is inert outside the mobile block and the desktop popover rules are unchanged", () => {
  const desktop = BASE_SURFACE_CSS.slice(0, BASE_SURFACE_CSS.indexOf("@media (max-width:480px)"));
  assert.match(desktop, /\.base-panel\{position:absolute;top:calc\(100% \+ 6px\);right:0;z-index:7;/, "the desktop popover rule must stay byte-identical");
  assert.match(desktop, /\.base-toolbar-overflow\{display:none;\}/, "the hamburger is hidden above the breakpoint");
  assert.match(desktop, /\.base-panel-header\{display:none;\}/, "the overlay header is hidden above the breakpoint");
  assert.match(desktop, /\.base-panel-backdrop\{display:none;\}/, "the backdrop is hidden above the breakpoint");
  // No stray breakpoint is introduced by this cut: the existing narrow-screen block
  // stays the only other width rule.
  assert.deepEqual(
    [...BASE_SURFACE_CSS.matchAll(/@media \(max-width:(\d+)px\)/g)].map((match) => match[1]),
    ["720", "480"],
  );
});
