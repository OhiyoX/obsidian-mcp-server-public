// U14 shell/contract test (U18: the right-rail toggle moved to the layout layer; U29 / #371: it
// moved on to the topbar): the document tab row, the tab strip and the layout-layer rail toggle
// in the SSR shell, the sprite glyph, the CSS classes and the `core/app.js` wiring shape.
//
// The U14 BRIEF froze these literally, U18's #334 fix kept the same contract at its new place,
// and #371's seat ruling keeps it again (option A: the rail toggle is a topbar action for good),
// so this file pins the markup and the wiring rather than re-testing behaviour (behaviour lives
// in document-tabs-model.test.js and in the real-Chromium probe):
// - `<header class="topbar view-header">` is the first child of `<main class="workspace …">` and
//   the only unconditional chrome band; `.document-tab-row` follows it and only enters the
//   layout while the strip has a tab (`.workspace.has-document-tabs`); `#document-tabs` is the
//   row's only child, empty in the SSR shell and rendered by features/tabs;
// - `#sidebar-toggle` is a topbar action — after `topbar-view-mode`, before the tab row, never
//   inside `#context-sidebar` — and stays the only rail toggle: it is now the only entry in the
//   layout layer too (#398 removed the ⋮ menu's secondary `#outline-toggle`), and the rail header
//   carries just the pane-level close `#context-drawer-close`, a client of the same state;
// - `panel-right` is the mirror of `panel-left`;
// - `core/app.js` only wires `syncFromSession()` at the committed-identity seams, hands the
//   strip the app's in-app welcome transition (#410: the last close is not a page load) and
//   does not grow (the tabs module never writes `state.path`).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");
const [pages, sprite, css, app, tabsIndex, tabsModel, tabsView, paneLayout] = await Promise.all([
  read("../src/app/pages.js"),
  read("../src/app/assets/icons.svg"),
  read("../src/app/assets/app.css"),
  read("../frontend/app/core/app.js"),
  read("../frontend/app/features/tabs/index.js"),
  read("../frontend/app/features/tabs/model.js"),
  read("../frontend/app/features/tabs/view.js"),
  read("../frontend/app/features/context/pane-layout.js"),
]);

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

// The layout row contains an empty child div (`#document-tabs`), so the generic `block`
// helper would stop at that child's closing tag. Slice up to the document body instead.
function rowBlock(page) {
  const start = page.indexOf('<div class="document-tab-row">');
  assert.ok(start > 0, "shell must contain the layout row");
  const end = page.indexOf('<section class="document workspace-leaf-content view-content">', start);
  assert.ok(end > start, "the layout row must sit below the topbar and above the document body");
  return page.slice(start, end);
}

test("the topbar is the first workspace child and the tab row follows it", async () => {
  const page = await shellMarkup();
  const container = '<div id="document-tabs" class="document-tabs" role="tablist" aria-label="打开的文档"></div>';
  assert.equal(page.includes(container), true, "the container is written literally by the SSR shell");
  assert.equal((page.match(/id="document-tabs"/g) ?? []).length, 1, "exactly one strip container");

  const workspaceOpen = '<main class="workspace workspace-split mod-vertical mod-root">';
  const workspaceStart = page.indexOf(workspaceOpen);
  const afterOpen = page.slice(workspaceStart + workspaceOpen.length).replace(/<!--[\s\S]*?-->/g, "");
  const rowOpen = '<div class="document-tab-row">';
  const topbarOpen = '<header class="topbar view-header">';
  // U29 (#371): the topbar is the only unconditional chrome band (the welcome workspace keeps a
  // single bar) and the tab row is the second band, directly under it.
  assert.equal(afterOpen.trimStart().startsWith(topbarOpen), true, "the topbar comes before every other workspace child");
  assert.ok(afterOpen.indexOf(topbarOpen) < afterOpen.indexOf(rowOpen), "the tab row sits below the topbar");
  assert.ok(afterOpen.indexOf(rowOpen) < afterOpen.indexOf(container), "the strip is nested in the layout row");
  assert.ok(afterOpen.indexOf(container) < afterOpen.indexOf('<section class="document'), "the strip sits above the document body");

  // The strip is never nested inside the view header (the header keeps its own controls).
  assert.equal(block(page, 'class="topbar view-header"', "</header>").includes("document-tabs"), false);
  // U29 (#371): the row keeps its DOM seam in the welcome state too — CSS hides it, never the SSR.
  assert.equal(rowBlock(page).includes(container), true, "the row still hosts the strip");
  // The strip ships empty: tabs are rendered from the session, never by SSR.
  assert.equal(/<div id="document-tabs"[^>]*><!--/.test(page), false);
  assert.equal(/<div id="document-tabs"[^>]*>[^<]/.test(page), false, "nothing else may live inside role=tablist, because features/tabs replaces its children");
});

test("the right-rail layout toggle lives in the topbar and keeps the frozen ARIA", async () => {
  const page = await shellMarkup();
  const topbar = block(page, 'class="topbar view-header"', "</header>");
  const toggle = '<button id="sidebar-toggle" class="icon-btn document-rail-toggle" type="button" title="隐藏右侧栏" aria-label="隐藏右侧栏" aria-pressed="true" aria-controls="context-sidebar">';
  assert.equal(topbar.includes(toggle), true, "markup + ARIA are literal");
  assert.match(topbar, /id="sidebar-toggle"[\s\S]{0,300}#panel-right"><\/use>/, "the toggle draws the mirrored panel glyph");
  assert.equal((page.match(/id="sidebar-toggle"/g) ?? []).length, 1, "no second always-on rail toggle");

  // U29 (#371) frozen position: the control is a topbar action — after the view-mode control and
  // before the document tab row — never inside the tab row and never inside the rail itself.
  const toggleAt = page.indexOf('id="sidebar-toggle"');
  const topbarAt = page.indexOf('<header class="topbar view-header">');
  assert.ok(toggleAt > topbarAt, "the toggle is inside the topbar block");
  assert.ok(toggleAt < page.indexOf("</header>", topbarAt), "and before that block closes");
  assert.ok(toggleAt > page.indexOf('class="view-mode topbar-view-mode"'), "after the view-mode control (the topbar's rightmost action)");
  assert.ok(toggleAt < page.indexOf('<div class="document-tab-row">'), "and before the document tab row");
  assert.equal(rowBlock(page).includes('id="sidebar-toggle"'), false, "the tab row carries no rail control");
  assert.equal(block(page, 'id="context-sidebar"', "</aside>").includes('id="sidebar-toggle"'), false, "nor does the rail itself");

  // U29 (#371): the rail header carries the pane-level close (the symmetric counterpart of the
  // left pane's ✕) and it is the panel layer's only close control — the layout toggle is not it.
  assert.equal(topbar.includes('id="context-drawer-close"'), false, "the pane close is not a topbar action");
  assert.equal((page.match(/id="context-drawer-close"/g) ?? []).length, 1, "exactly one pane-level rail close");

  // The rail header is the panel layer: panel switching plus that one pane close.
  const railRow = block(page, 'class="context-header context-view-header"', "</header>");
  assert.deepEqual(
    [...railRow.matchAll(/data-context-view="([a-z]+)"/g)].map((match) => match[1]),
    ["outline", "outgoing", "incoming", "tags"],
    "the four rail views are untouched",
  );
  assert.equal(railRow.includes('data-pane-slot="switch"'), true, "the panel row's switcher keeps its pane slot");
  assert.match(railRow, /id="context-drawer-close"[^>]*data-pane-slot="close"/, "the pane close is the panel row's other slot");
  assert.equal(railRow.includes('id="sidebar-toggle"'), false, "the rail toggle left the rail header");
  assert.equal(railRow.includes('id="context-close"'), false, "the old collapse chevron stays gone");
  assert.equal(page.includes('id="context-close"'), false, "the collapse chevron is gone from the shell");

  // #398: the ⋮ menu no longer duplicates the layout-layer rail toggle; document actions only.
  const menu = block(page, 'id="document-actions-menu"', "</div>");
  assert.equal(menu.includes('id="outline-toggle"'), false, "the ⋮ menu carries no rail toggle");
  assert.equal(menu.includes("data-document-outline"), false, "and no outline item hook");
  assert.equal(page.includes('id="outline-toggle"'), false, "the shell renders no #outline-toggle at all");
  assert.equal(page.includes("data-document-outline"), false, "nor its data hook");
});

test("panel-right is the exact mirror of panel-left", () => {
  const symbol = (page, id) => page.match(new RegExp(`<symbol id="${id}" viewBox="0 0 24 24">(.*?)</symbol>`))?.[1] ?? "";
  const left = symbol(sprite, "panel-left");
  const right = symbol(sprite, "panel-right");
  assert.notEqual(left, "", "panel-left exists");
  assert.notEqual(right, "", "panel-right exists");

  const outline = '<rect x="3" y="3" width="18" height="18" rx="2"/>';
  assert.equal(left.includes(outline) && right.includes(outline), true, "the same rounded frame");
  const bar = (source) => source.match(/<rect x="([\d.]+)" y="5.5" width="5.5" height="13" rx="1.5" fill="currentColor" stroke="none"\/>/);
  const leftBar = bar(left);
  const rightBar = bar(right);
  assert.ok(leftBar && rightBar, "both symbols carry one filled half-width bar");
  assert.equal(Number(leftBar[1]) + 5.5 + Number(rightBar[1]), 24, "the filled bar is mirrored across the viewBox");
  assert.equal((sprite.match(/<symbol id="panel-right"/g) ?? []).length, 1);
});

test("app.css adds only new classes for the layout row and the rail toggle", () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `app.css must define ${selector}`);
    return match[1];
  };
  // The row owns the one pane-header band; the tablist only scrolls inside it.
  assert.match(rule(".document-tab-row"), /flex: 0 0 var\(--pane-header-height\)/);
  assert.match(rule(".document-tabs"), /overflow-x: auto/);
  assert.match(rule(".document-tabs"), /flex: 1 1 auto/);
  assert.match(rule(".document-tabs:empty"), /display: none/);
  assert.match(rule(".document-tab-main"), /text-overflow|min-width: 0/);
  assert.match(rule(".document-tab-title"), /text-overflow: ellipsis/);
  assert.match(rule(".document-tab-close"), /cursor: pointer/);
  // The layout toggle keeps its size and is pinned to the row's far right even with no tab.
  assert.match(rule(".document-rail-toggle"), /flex: 0 0 28px/);
  assert.match(rule(".document-rail-toggle"), /margin-left: auto/);
  assert.equal(css.includes(".context-close"), false, "the removed collapse chevron leaves no dead rule");
  assert.equal(css.includes(".context-sidebar-toggle"), false, "the old rail-scoped toggle class is gone");
  // The narrow-screen row is its own addition, never an edit of the existing media blocks.
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.document-tab-row \{ flex-basis: 44px;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.document-tabs \{ height: 44px;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.document-rail-toggle \{ width: 44px; height: 44px; flex: 0 0 44px; \}/, "the mobile row keeps the 44px touch target the toggle had in the rail header");
});

test("the three pane header bands end on one divider line", () => {
  // Owner report 2026-10-19 ("线条没有对齐"): the left pane's header band was one pixel taller
  // than the topbar and the right pane's header, so the 1px divider that runs under the whole
  // top chrome stepped down 1px at the left pane's edge - and that edge is the tab strip's own
  // left boundary. Desktop has one `--header-height` band per pane, so the three dividers are
  // one continuous line; the left pane has to pay its border out of the same band height.
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `app.css must define ${selector}`);
    return match[1];
  };
  const declaration = (body, property) => {
    const match = body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`));
    assert.ok(match, `missing ${property}`);
    return match[1].trim();
  };
  const px = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
    assert.ok(match, `${value} must be a plain px length`);
    return Number(match[1]);
  };
  const bandHeight = px(/--pane-header-height:\s*(\d+px)/.exec(css)[1]);
  // The topbar and the rail header are the two bands whose border already landed at
  // `bandHeight - 1`; the global `* { box-sizing: border-box }` is what makes that true.
  assert.match(css, /\* \{ box-sizing: border-box; \}/);
  for (const selector of [".topbar", ".context-header"]) {
    assert.equal(declaration(rule(selector), "height"), "var(--pane-header-height)", `${selector} must own the shared band height`);
  }
  // The left pane's band is content-sized: top padding + the tab strip + its own 1px divider.
  const head = rule(".sidebar-head");
  const strip = rule(".sidebar-tabs");
  assert.equal(declaration(head, "border-bottom").startsWith("1px solid"), true);
  assert.equal(px(declaration(strip, "height")) + px(declaration(head, "padding").split(" ")[0]) + 1, bandHeight,
    "the left header band (padding-top + tab strip + divider) must equal the shared pane header height");
  // And the strip's own content box must still hold the 30px view tab without clipping it.
  const stripPaddingBottom = px(declaration(strip, "padding").split(" ")[2]);
  assert.ok(px(declaration(strip, "height")) - stripPaddingBottom >= 30, "the 30px view tabs still fit");
});

test("core/app.js only wires the strip and does not grow", () => {
  assert.match(app, /import \{ createDocumentTabs \} from "\.\.\/features\/tabs\/index\.js"/);
  assert.match(
    app,
    /const tabs = createDocumentTabs\(\{ openNote, getCurrentPath: \(\) => state\.path, getDocumentKind: \(\) => state\.documentKind, enterWelcome: \(\) => welcomeTransition\.enterWelcome\(\), onModelChange: \(list\) => documentTabRow\.sync\(list\) \}\);/,
    "the strip receives read-only accessors, the real openNote, the app's welcome transition and the row mirror",
  );
  // Issue #410: the welcome transition is the app's, created once from the same pipeline the
  // note/base navigation already uses (one history writer, one status projection).
  assert.match(app, /import \{ createWelcomeTransition \} from "\.\.\/features\/navigation\/welcome-transition\.js"/);
  assert.match(app, /getNavigation: \(\) => \(\{ documentNavigation, baseNavigation \}\)/, "the transition reuses the one navigation module");
  assert.match(app, /enterWelcome: \(\) => welcomeTransition\.enterWelcome\(\)/, "the strip delegates the last close");
  // The committed identity is the only sync trigger (note open/reload + Base enter/restore).
  assert.equal((app.match(/tabs\.syncFromSession\(\)/g) ?? []).length, 3, "no other sync site");
  assert.match(app, /baseNavigation\?\.exitToNote\?\.\(\);[\s\S]{0,120}tabs\.syncFromSession\(\);/, "synced after the note/base chrome commit");
  assert.match(app, /clearOutline: \(\) => \{[\s\S]{0,240}tabs\.syncFromSession\(\); documentTabRow\.sync\(tabs\.getState\(\)\.tabs\); \}/, "Base entry deactivates every tab and mirrors the row");
  assert.match(app, /refreshOutline: \(\) => \{ refreshOutlineFromSource\(\); tabs\.syncFromSession\(\); documentTabRow\.sync\(tabs\.getState\(\)\.tabs\); \}/, "a restored note re-activates its tab and mirrors the row");
  assert.ok(app.split("\n").length <= 500, "the local 500-line cap (BRIEF: net growth 0)");

  // The strip owns no document state and no persistence.
  for (const [name, source] of [["index", tabsIndex], ["model", tabsModel], ["view", tabsView]]) {
    assert.doesNotMatch(source, /state\.path\s*=/, `${name}.js must never write the document identity`);
    assert.doesNotMatch(source, /localStorage|sessionStorage/, `${name}.js keeps no tab persistence (v1)`);
    assert.doesNotMatch(source, /^import [^\n]*session/m, `${name}.js imports no session/document storage`);
  }
  assert.match(tabsIndex, /await openNote\(plan\.targetPath\)/, "switching/closing goes through the existing open flow");
  // #410: the last close is delegated to the app's in-app transition; the strip keeps no
  // page-load path and no welcome route of its own.
  assert.match(tabsIndex, /if \(!await enterWelcome\(\)\) return false;/, "the last close asks the injected transition");
  assert.doesNotMatch(tabsIndex, /locationObject|WELCOME_ROUTE|location\.(?:replace|assign|reload)/, "the strip never loads a page itself");
});

test("the rail toggle mirrors the one rail state owned by pane-layout", () => {
  assert.match(paneLayout, /import \{ attachSidebarToggle \} from "\.\/sidebar-toggle\.js"/);
  assert.match(paneLayout, /attachSidebarToggle\(\{[\s\S]{0,200}isOpen: \(\) => open,\s*setOpen: \(value\) => setOpen\(value\),/);
  assert.match(paneLayout, /toggleView\?\.paint\(open\)/, "the toggle is painted by the same setOpen every other entry point uses");
  assert.match(paneLayout, /#sidebar-toggle/, "resolved from the shell, so core/app.js keeps its current call shape");
  assert.match(paneLayout, /#context-drawer-close/, "the pane-level rail close is resolved from the shell too");
  assert.match(paneLayout, /drawerClose\.onclick = \(\) => setOpen\(false\)/, "and it is a client of the one rail state, never a second owner");
  assert.doesNotMatch(paneLayout, /closeButton|#context-close/, "the removed chevron leaves no wiring behind");
  // #398: the ⋮ secondary outline entry is gone from the single rail state too.
  assert.doesNotMatch(paneLayout, /outlineToggle|outline-toggle/, "pane-layout wires no outline toggle");
  assert.equal((app.match(/#context-close/g) ?? []).length, 0, "core/app.js no longer passes the removed chevron");
  assert.equal((app.match(/outline-toggle|outlineToggle/g) ?? []).length, 0, "and no longer passes (or queries) an outline toggle");
  // Still exactly one visibility implementation.
  assert.equal((paneLayout.match(/classList\.toggle\("context-hidden"/g) ?? []).length, 1);
  assert.equal((paneLayout.match(/localStorage\.setItem/g) ?? []).length, 1);
});

test("the shell renders the pre-U14 rail row for fixtures without the new toggle", async () => {
  // attachSidebarToggle is optional: a shell without #sidebar-toggle must stay a no-op.
  const { attachSidebarToggle } = await import("../frontend/app/features/context/sidebar-toggle.js");
  assert.equal(attachSidebarToggle({}), null);
  assert.equal(attachSidebarToggle({ toggle: { setAttribute() {} } }), null, "a node without listeners is ignored");
});
