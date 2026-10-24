// U10 frontend tests — the document header matches the desktop header.
//
// Desktop's document header keeps exactly two controls on its right edge: the reading-view
// toggle (📖, book-open) and the more-options menu (⋮, more-vertical). Copy link and Publish
// are menu items, not header chips, and the reading/source/live switch is not duplicated
// anywhere (U21 removed the empty bottom status bar that used to exist as the last place a
// duplicate could have lived).
//
// #398 removed the historical `#outline-toggle` menu item: the ⋮ menu is document actions only,
// and the rail is shown/hidden by the layout-layer `#sidebar-toggle` (its clients are the pane
// close, the scrim and the active-tab collapse). These tests pin the real `pages.js` markup, the
// real `app.css` rules and the real behaviour: no menu pick ever touches the rail, and the one
// layout-layer toggle flips the shell exactly once.
//
// U35 (#407) moved both topbar menus onto the shared `ui/popup-menu.js` primitive. The
// behaviour section below therefore drives the real `document-actions.js` and
// `view-mode-controller.js` controllers: the primitive is the only writer of `aria-expanded` /
// `hidden`, the `"topbar"` scope makes the two menus mutually exclusive, and Escape hands focus
// back to the ⋮ while a reading-view pick keeps its focus in the editor (`restoreFocus: false`).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { initializeDocumentActions } from "../frontend/app/features/navigation/document-actions.js";
import { initializeViewModeController } from "../frontend/app/features/document/view-mode-controller.js";
import { wireContextSection } from "../frontend/app/features/context/attach-note-context.js";
import { initializeContextPane } from "../frontend/app/features/context/pane-layout.js";

const dom = createDomHarness();
dom.install();

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const pagesSource = await fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8");
const appSource = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");
const actionsSource = await fs.readFile(new URL("../frontend/app/features/navigation/document-actions.js", import.meta.url), "utf8");
const paneLayoutSource = await fs.readFile(new URL("../frontend/app/features/context/pane-layout.js", import.meta.url), "utf8");

const RAIL_OPEN_KEY = "obsidian-web.context-open";
const headerBlock = () => {
  const start = pagesSource.indexOf('<div class="topbar-actions">');
  assert.ok(start > 0, "the shell renders the document header action row");
  return pagesSource.slice(start, pagesSource.indexOf("</header>", start));
};

// --- markup -----------------------------------------------------------------

test("the document header renders 实时 / 保存 / 📖 / ⋮ and nothing else", () => {
  const header = headerBlock();
  // The desktop control set, in the desktop order: sync status, Save (a real capability we
  // keep), then the two desktop-header controls with ⋮ rightmost.
  const order = ['id="live-status"', 'id="save"', 'class="view-mode topbar-view-mode"', 'id="document-actions-toggle"'].map((needle) => header.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), `every header control renders (${JSON.stringify(order)})`);
  assert.deepEqual(order, [...order].sort((left, right) => left - right), "order is 实时 → 保存 → 📖 → ⋮");
  // No independent copy-link / Publish / outline chips survive anywhere in the shell.
  assert.doesNotMatch(pagesSource, /id="copy-note-link"/);
  assert.doesNotMatch(pagesSource, /id="publish-toggle"/);
  assert.doesNotMatch(pagesSource, /topbar-outline /);
  assert.doesNotMatch(pagesSource, /desktop-document-action/);
  // The ⋮ toggle stays the header's only menu entry, with its aria contract intact.
  assert.match(header, /id="document-actions-toggle" class="icon-btn document-actions-toggle" type="button" title="文档操作" aria-label="文档操作" aria-haspopup="menu" aria-expanded="false">\$\{icon\("more-vertical"\)\}/);
  assert.equal((header.match(/id="document-actions-toggle"/g) ?? []).length, 1, "exactly one ⋮ toggle");
});

test("the ⋮ menu keeps only the document-action hooks — the outline item is gone (#398)", () => {
  const header = headerBlock();
  assert.match(header, /data-document-link type="button" role="menuitem" disabled>\$\{icon\("link"\)\}<span>复制文档链接<\/span>/);
  assert.match(header, /data-publish-toggle type="button" role="menuitem" aria-pressed="false" disabled>\$\{icon\("globe-2"\)\}<span class="document-action-label">Publish<\/span><span class="document-action-state"/);
  assert.equal((header.match(/data-document-link/g) ?? []).length, 1, "one copy-link item");
  assert.equal((header.match(/data-publish-toggle/g) ?? []).length, 1, "one Publish item");
  // #398: the menu holds real document actions only; the outline switch is not one of them.
  assert.equal((header.match(/data-document-outline/g) ?? []).length, 0, "no outline item left in the ⋮ menu");
  assert.equal((header.match(/id="outline-toggle"/g) ?? []).length, 0, "and no outline toggle button either");
  assert.doesNotMatch(pagesSource, /outline-toggle/, "the shell renders #outline-toggle nowhere");
});

test("the rail has one layout-layer entry and one click owner — no ⋮ secondary switch (#398)", () => {
  // The primary rail entry is the layout-layer toggle in the topbar's actions (U18 + U29 / #371).
  const layoutToggleAt = pagesSource.indexOf('id="sidebar-toggle"');
  const topbarAt = pagesSource.indexOf('<header class="topbar view-header">');
  assert.ok(layoutToggleAt > 0, "the layout-layer rail toggle exists in the shell");
  assert.ok(topbarAt > 0 && layoutToggleAt > topbarAt, "and it lives inside the topbar block");
  assert.ok(layoutToggleAt < pagesSource.indexOf("</header>", topbarAt), "before that block closes (it is a plain topbar action)");
  assert.ok(layoutToggleAt < pagesSource.indexOf('<div class="document-tab-row">'), "and above the conditional document tab row");
  assert.match(pagesSource, /id="sidebar-toggle"[^>]*aria-controls="context-sidebar"/);
  // #398: with the menu item gone there is no second rail owner anywhere in the runtime.
  assert.doesNotMatch(appSource, /outline-toggle/);
  assert.doesNotMatch(appSource, /outlineToggle/);
  assert.match(appSource, /initializeContextPane\(\{\s*shell,\s*scrim:/);
  assert.doesNotMatch(appSource, /onOutline/);
  assert.doesNotMatch(paneLayoutSource, /outlineToggle/);
  assert.match(paneLayoutSource, /export function initializeContextPane\(\{ shell, scrim, sidebarToggle = null,/);
  assert.doesNotMatch(actionsSource, /\[data-document-outline\]/);
  // U35 (#407): the open/close state machine now lives in the shared primitive; the one rule
  // that stays here is that picking a real document action closes the menu.
  assert.match(actionsSource, /import \{ createPopupMenuController \} from "\.\.\/\.\.\/ui\/popup-menu\.js"/);
  assert.match(actionsSource, /scope: "topbar"/);
  assert.match(actionsSource, /menu\.addEventListener\("click", onMenuClick\)/);
  assert.match(actionsSource, /if \(event\.target\.closest\("button"\)\) controller\.close\(\)/);
  assert.doesNotMatch(actionsSource, /menu\.hidden =/, "the consumer no longer writes `hidden`");
  assert.doesNotMatch(actionsSource, /setAttribute\("aria-expanded"/, "nor `aria-expanded`");
  assert.doesNotMatch(actionsSource, /document\.addEventListener/, "outside dismissal belongs to the primitive");
});

test("exactly one view-mode control is rendered, and it is the header one", () => {
  assert.equal((pagesSource.match(/view-mode-toggle/g) ?? []).length, 1, "the status-bar duplicate is gone");
  assert.doesNotMatch(pagesSource, /status-bar-btn/);
  // U21: the empty shell `<footer class="status-bar">` was removed entirely — the header
  // is the only view-mode host and there is no bottom bar left to host anything.
  assert.doesNotMatch(pagesSource, /class="status-bar"/);
  assert.equal((pagesSource.match(/class="view-mode topbar-view-mode"/g) ?? []).length, 1);
  // The three modes and the aria-checked contract are unchanged.
  for (const mode of ["preview", "raw", "live"]) {
    assert.match(pagesSource, new RegExp(`data-mode="${mode}"`));
  }
  assert.equal((pagesSource.match(/data-mode="preview" aria-checked="true"/g) ?? []).length, 1, "exactly one mode starts checked");
});

// --- styles -----------------------------------------------------------------

test("the header control styles are the desktop shape, with no chip/legacy leftovers", () => {
  // 📖 and ⋮ use the plain icon button; the 28px header chips are gone with their buttons.
  assert.doesNotMatch(css, /\.topbar-icon-action/);
  assert.doesNotMatch(css, /\.topbar-text-action/);
  assert.doesNotMatch(css, /\.desktop-document-action/);
  assert.doesNotMatch(css, /\.mobile-document-actions/);
  assert.doesNotMatch(css, /\.status-bar-btn/);
  assert.doesNotMatch(css, /\.status-bar-left|\.status-bar-right/);
  assert.match(css, /\.document-actions \{ position: relative; \}/);
  assert.match(css, /\.document-actions-toggle\.is-published::after \{/);
});

test("both header menus open downwards under the header", () => {
  const viewMenu = css.match(/\.view-mode-menu \{[^}]*\}/)?.[0] ?? "";
  assert.match(viewMenu, /top: calc\(100% \+ 6px\);/, "the reading-view menu drops below the header");
  assert.doesNotMatch(viewMenu, /bottom: calc\(100% \+ 6px\)/, "it no longer opens upward into the status bar");
  const actionsMenu = css.match(/\.document-actions-menu \{[^}]*\}/)?.[0] ?? "";
  assert.match(actionsMenu, /top: calc\(100% \+ 6px\);/, "the ⋮ menu drops below the header too");
  // The header control is visible at every width; the narrow media query no longer has to
  // un-hide it, and the touch target stays 44px.
  assert.doesNotMatch(css, /\.topbar-view-mode \{ display: none/);
  assert.doesNotMatch(css, /\.topbar-view-mode \{ display: block/);
  assert.match(css, /\.document-action-item \{ min-height: 44px; \}/);
  // U21: the narrow-screen `display:none` rule went with the element. This asserts the
  // stronger form: no `.status-bar` rule survives anywhere in the sheet (the element no
  // longer exists, so a hidden/visible rule anywhere would be dead weight).
  assert.doesNotMatch(css, /\.status-bar/);
});

// --- behaviour --------------------------------------------------------------

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

// The real shell markup shape: the document `⋮` control, the layout-layer rail toggle and the
// reading-view control that shares the `"topbar"` interaction scope with it (#407).
function buildTopbar() {
  const shell = dom.createElement("div");
  shell.className = "shell";
  const control = dom.createElement("div");
  control.className = "document-actions";
  const toggle = dom.createElement("button");
  toggle.id = "document-actions-toggle";
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");
  const menu = dom.createElement("div");
  menu.id = "document-actions-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  // #398: the menu holds document actions only (the outline switch is gone).
  const copyLink = dom.createElement("button");
  copyLink.className = "document-action-item";
  copyLink.setAttribute("data-document-link", "");
  copyLink.disabled = true;
  const publish = dom.createElement("button");
  publish.className = "document-action-item";
  publish.setAttribute("data-publish-toggle", "");
  menu.append(copyLink, publish);
  control.append(toggle, menu);
  const sidebarToggle = dom.createElement("button");
  sidebarToggle.id = "sidebar-toggle";
  sidebarToggle.setAttribute("aria-pressed", "true");
  sidebarToggle.setAttribute("aria-controls", "context-sidebar");

  // The other half of the topbar scope, in the shipped markup shape.
  const viewMode = dom.createElement("div");
  viewMode.className = "view-mode topbar-view-mode";
  const modeToggle = dom.createElement("button");
  modeToggle.className = "view-mode-toggle";
  modeToggle.setAttribute("aria-haspopup", "menu");
  modeToggle.setAttribute("aria-expanded", "false");
  const modeMenu = dom.createElement("div");
  modeMenu.className = "view-mode-menu";
  modeMenu.setAttribute("role", "menu");
  modeMenu.hidden = true;
  const modeItems = ["preview", "raw", "live"].map((mode) => {
    const item = dom.createElement("button");
    item.className = "view-mode-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(mode === "preview"));
    item.dataset.mode = mode;
    return item;
  });
  modeMenu.append(...modeItems);
  viewMode.append(modeToggle, modeMenu);
  shell.append(control, sidebarToggle, viewMode);

  const documentHost = dom.createElement("section");
  documentHost.className = "document";
  const preview = dom.createElement("article");
  const editorHost = dom.createElement("div");
  const editor = dom.createElement("div");
  editor.setMode = () => {};
  editor.leavePropertiesCaret = () => {};
  dom.document.body.replaceChildren(shell, documentHost, editorHost, preview);
  return { shell, control, toggle, menu, actions: [copyLink, publish], sidebarToggle, modeToggle, modeMenu, modeItems, editor, editorHost, preview, documentHost };
}

const noop = () => {};

function mountViewMode({ state = { mode: "preview", path: "A.md" } } = {}) {
  return (top) => initializeViewModeController({
    state,
    documentHost: top.documentHost,
    editorHost: top.editorHost,
    preview: top.preview,
    editor: top.editor,
    renderPreview: noop,
    renderWelcome: noop,
    refreshOutline: noop,
  });
}

test("a document action never touches the rail; #sidebar-toggle flips it exactly once (#398)", () => {
  const browser = stubBrowser();
  const header = buildTopbar();
  const actions = initializeDocumentActions({ toggle: header.toggle, menu: header.menu });
  try {
    initializeContextPane({ shell: header.shell, scrim: dom.createElement("div") });
    assert.equal(header.shell.classList.contains("context-hidden"), false, "the rail starts open");
    assert.equal(header.sidebarToggle.getAttribute("aria-pressed"), "true", "the toggle reports the open rail");
    const preferenceAfterInit = globalThis.localStorage.getItem(RAIL_OPEN_KEY);

    // Desktop path: open ⋮, then pick a real document action. The harness does not bubble, so
    // dispatch the item's own handler and its bubble to the menu explicitly — a real click
    // does both, and the menu must still close.
    header.toggle.click();
    assert.equal(header.menu.hidden, false, "the ⋮ menu opens");
    assert.equal(header.toggle.getAttribute("aria-expanded"), "true");
    header.actions[0].click();
    header.menu.dispatchEvent({ type: "click", target: header.actions[0] });
    assert.equal(header.menu.hidden, true, "picking an item closes the menu");
    assert.equal(header.shell.classList.contains("context-hidden"), false, "a document action never touches the rail");
    assert.equal(globalThis.localStorage.getItem(RAIL_OPEN_KEY), preferenceAfterInit, "a document action writes no rail preference");

    // Outside dismissal still closes the menu (the U10 contract, unchanged). #407 moved the
    // dismissal from a bubbled `click` to the capture-phase `pointerdown` the primitive owns;
    // the harness does not bubble either event, so the pointer is dispatched on the document.
    header.toggle.click();
    assert.equal(header.menu.hidden, false);
    const outside = dom.createElement("div");
    dom.document.body.append(outside);
    dom.document.dispatchEvent({ type: "pointerdown", target: outside });
    assert.equal(header.menu.hidden, true, "an outside press closes the ⋮ menu");
    assert.equal(header.toggle.getAttribute("aria-expanded"), "false");

    // The layout-layer toggle is the one rail entry: open <-> closed, aria-pressed in sync.
    header.sidebarToggle.click();
    assert.equal(header.shell.classList.contains("context-hidden"), true, "#sidebar-toggle collapses the rail");
    assert.equal(header.sidebarToggle.getAttribute("aria-pressed"), "false", "aria-pressed follows the collapse");
    assert.equal(globalThis.localStorage.getItem(RAIL_OPEN_KEY), "false", "the collapse is remembered");

    header.sidebarToggle.click();
    assert.equal(header.shell.classList.contains("context-hidden"), false, "a second press restores the rail");
    assert.equal(header.sidebarToggle.getAttribute("aria-pressed"), "true", "aria-pressed follows the restore");

    // Toggling the menu itself never changes the rail state either.
    header.toggle.click();
    header.toggle.click();
    assert.equal(header.menu.hidden, true);
    assert.equal(header.shell.classList.contains("context-hidden"), false, "opening/closing ⋮ does not touch the rail");
  } finally {
    actions.destroy();
    browser.restore();
  }
});

// --- U35 (#407): the shared popup/menu contract at the topbar consumers ---------

test("only one topbar menu can be open: ⋮ and the reading-view menu are mutually exclusive", () => {
  const top = buildTopbar();
  const actions = initializeDocumentActions({ toggle: top.toggle, menu: top.menu });
  const viewMode = mountViewMode()(top);
  try {
    top.toggle.click();
    assert.equal(top.menu.hidden, false, "the ⋮ menu opens");
    assert.equal(top.toggle.getAttribute("aria-expanded"), "true", "and reports itself expanded");

    top.modeToggle.click();
    assert.equal(top.modeMenu.hidden, false, "the reading-view menu opens");
    assert.equal(top.menu.hidden, true, "and the ⋮ menu closed itself (same scope)");
    assert.equal(top.toggle.getAttribute("aria-expanded"), "false", "with its aria-expanded reverted");
    assert.equal(actions.isOpen(), false, "the ⋮ controller agrees it is closed");

    top.toggle.click();
    assert.equal(top.modeMenu.hidden, true, "and the reverse direction holds too");
    assert.equal(top.modeToggle.getAttribute("aria-expanded"), "false");
    assert.equal(viewMode.isOpen(), false);
  } finally {
    actions.destroy();
    viewMode.destroy();
  }
});

test("Escape closes the ⋮ menu and hands the focus back; a pointer open never takes it", () => {
  const top = buildTopbar();
  const actions = initializeDocumentActions({ toggle: top.toggle, menu: top.menu });
  try {
    // Pointer open: the editor keeps the caret, so Escape must not move it into the header.
    top.editor.focus();
    top.toggle.dispatchEvent({ type: "click", detail: 1 });
    assert.equal(top.menu.hidden, false);
    assert.equal(dom.document.activeElement, top.editor, "a pointer open leaves the editor focused");
    dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(top.menu.hidden, true, "Escape closes the ⋮ menu");
    assert.equal(top.toggle.getAttribute("aria-expanded"), "false");
    assert.equal(dom.document.activeElement, top.toggle, "and returns focus to the ⋮ trigger");

    // Keyboard open: the menu owns the focus, and Escape must bring it back to the trigger.
    dom.document.activeElement = null;
    top.toggle.dispatchEvent({ type: "click", detail: 0 });
    assert.equal(top.menu.hidden, false);
    assert.notEqual(dom.document.activeElement, top.toggle, "a keyboard open moves focus into the menu");
    dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(dom.document.activeElement, top.toggle, "Escape hands it back to the trigger");
  } finally {
    actions.destroy();
  }
});

test("the topbar ⋮ and the right-rail section ⋮ can be open at the same time (scope isolation)", () => {
  const top = buildTopbar();
  const actions = initializeDocumentActions({ toggle: top.toggle, menu: top.menu });
  // The rail half: a real note-context panel head (its own module, its own scope).
  const head = dom.createElement("header");
  head.setAttribute("data-context-panel", "outgoing");
  const railToggle = dom.createElement("button");
  railToggle.className = "icon-btn context-section-menu-toggle";
  railToggle.setAttribute("aria-haspopup", "menu");
  railToggle.setAttribute("aria-expanded", "false");
  const railMenu = dom.createElement("div");
  railMenu.className = "context-section-menu";
  railMenu.setAttribute("role", "menu");
  railMenu.hidden = true;
  const collapse = dom.createElement("button");
  collapse.className = "context-section-menu-item";
  collapse.setAttribute("role", "menuitem");
  collapse.setAttribute("data-context-action", "collapse");
  const refresh = dom.createElement("button");
  refresh.className = "context-section-menu-item";
  refresh.setAttribute("role", "menuitem");
  refresh.setAttribute("data-context-action", "refresh");
  railMenu.append(collapse, refresh);
  head.append(railToggle, railMenu);
  dom.document.body.append(head);
  const section = wireContextSection({ header: head, listHost: null, onRefresh: noop });
  try {
    top.toggle.click();
    railToggle.click();
    assert.equal(top.menu.hidden, false, "the topbar ⋮ stays open");
    assert.equal(railMenu.hidden, false, "while the rail section ⋮ opens");
    assert.equal(top.toggle.getAttribute("aria-expanded"), "true");
    assert.equal(railToggle.getAttribute("aria-expanded"), "true");

    railToggle.click();
    assert.equal(railMenu.hidden, true, "the rail menu closes on its own trigger");
    assert.equal(railToggle.getAttribute("aria-expanded"), "false");
    assert.equal(top.menu.hidden, false, "and never closes the topbar menu (different scope)");
  } finally {
    actions.destroy();
    section.destroy();
  }
});

test("picking a reading-view mode keeps restoreFocus:false — the focus goes to the editor (#407)", () => {
  const top = buildTopbar();
  const viewMode = mountViewMode()(top);
  try {
    top.modeToggle.dispatchEvent({ type: "click", detail: 1 });
    assert.equal(top.modeMenu.hidden, false, "the reading-view menu opens on a pointer click");
    assert.equal(top.modeToggle.getAttribute("aria-expanded"), "true");

    top.modeItems.find((item) => item.dataset.mode === "live").click();
    assert.equal(top.modeMenu.hidden, true, "picking a mode closes the menu");
    assert.equal(top.modeToggle.getAttribute("aria-expanded"), "false");
    assert.equal(dom.document.activeElement, top.editor, "and the editor — not the toggle — holds the focus");
    assert.equal(top.editorHost.classList.contains("is-live-preview"), true, "the pick really switched the mode");

    // A pointer-opened reading-view menu must not grab focus on Escape either: the caret the
    // user left in the editor stays there, which is the whole point of `restoreFocus: false`.
    top.editor.focus();
    top.modeToggle.dispatchEvent({ type: "click", detail: 1 });
    dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(top.modeMenu.hidden, true);
    assert.equal(dom.document.activeElement, top.editor, "Escape keeps the editor's focus");
  } finally {
    viewMode.destroy();
  }
});
