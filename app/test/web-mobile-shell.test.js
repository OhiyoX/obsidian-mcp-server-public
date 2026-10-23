// U29 (#371) mobile shell reflow — the contract the frozen U14/U18 shell tests do not own.
//
// The seat ruling for #371 froze four things that live in no other test file:
//   - one side-pane breakpoint (`<=720px`): both panes are drawers below it, both are docked
//     above it, and at most one drawer is ever open (the old 721-1050 tablet band is gone);
//   - the document tab row is a *conditional* band: it enters the layout only while the strip
//     has a tab, so the welcome workspace keeps exactly one bar;
//   - the top notch inset is consumed by exactly one visible chrome band (the topbar, or the
//     drawer that covers it) and never by the shared `--pane-header-height` token;
//   - both side panes expose the same header shape (one view switcher + one pane-level close),
//     so neither pane is the one without an in-pane exit.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  DRAWER_QUERY,
  LEFT_DRAWER_CLASS,
  RIGHT_DRAWER_CLASS,
  closeDrawers,
  isDrawerMode,
  isDrawerOpen,
  setDrawerOpen,
} from "../frontend/app/features/context/drawer-exclusion.js";
import { TAB_ROW_VISIBLE_CLASS, createDocumentTabRow } from "../frontend/app/features/explorer/document-tab-row.js";
import { initializeSidebarPanels } from "../frontend/app/features/explorer/sidebar-panels.js";
import { initializeContextPane } from "../frontend/app/features/context/pane-layout.js";

const dom = createDomHarness();
dom.install();

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const [pagesSource, sidebarPanelsSource, paneLayoutSource, outlineSource] = await Promise.all([
  fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../frontend/app/features/explorer/sidebar-panels.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../frontend/app/features/context/pane-layout.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../frontend/app/features/context/outline.js", import.meta.url), "utf8"),
]);
const markup = (await import("../src/app/pages.js")).appPage({ username: "owner", displayName: "Owner", csrf: "token" }, {});

const slice = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};
const rule = (source, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `app.css must define ${selector}`);
  return match[1];
};

// --- the one drawer policy ---------------------------------------------------

test("one <=720px breakpoint drives both side panes, and it is the shared literal", () => {
  assert.equal(DRAWER_QUERY, "(max-width:720px)", "the drawer query is the frozen mobile breakpoint");
  assert.equal(isDrawerMode((query) => { assert.equal(query, DRAWER_QUERY); return { matches: true }; }), true);
  assert.equal(isDrawerMode(() => ({ matches: false })), false);
  // Fail-closed without a matcher (an environment without matchMedia keeps docked panes).
  assert.equal(isDrawerMode(() => undefined), false);
});

test("opening one drawer hands the other one back (never two open classes)", () => {
  const shell = dom.createElement("div");
  shell.className = "shell";
  setDrawerOpen(shell, "left", true);
  assert.deepEqual([isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")], [true, false], "the left drawer opens");
  setDrawerOpen(shell, "right", true);
  assert.deepEqual(
    [isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")],
    [false, true],
    "opening the right drawer closes the left one",
  );
  setDrawerOpen(shell, "left", true);
  assert.deepEqual([isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")], [true, false], "and the other way round");
  assert.equal(shell.classList.contains(LEFT_DRAWER_CLASS), true);
  assert.equal(shell.classList.contains(RIGHT_DRAWER_CLASS), false);
  closeDrawers(shell);
  assert.deepEqual([isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")], [false, false], "the shared scrim path closes both");
  // Closing the side that is already closed is a no-op, not a state flip.
  setDrawerOpen(shell, "right", false);
  assert.equal(isDrawerOpen(shell, "right"), false);
});

// --- the two real controllers on one shell -----------------------------------

function stubBrowser({ narrow = true } = {}) {
  const previous = { localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia };
  globalThis.localStorage = {
    store: new Map(),
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

test("the files drawer closes the note-context drawer and the toggle stops claiming it is open", () => {
  const browser = stubBrowser({ narrow: true });
  try {
    const shell = dom.createElement("div");
    shell.className = "shell";
    // A real shell resolves the notch contract through the element's own view.
    shell.ownerDocument = { defaultView: globalThis };
    const filesToggle = dom.createElement("button");
    filesToggle.id = "files-toggle";
    const sidebarToggle = dom.createElement("button");
    sidebarToggle.id = "sidebar-toggle";
    sidebarToggle.setAttribute("aria-pressed", "true");
    const scrim = dom.createElement("div");
    scrim.className = "scrim";
    shell.append(filesToggle, sidebarToggle, scrim);
    dom.document.body.replaceChildren(shell);

    const sidebar = initializeSidebarPanels({ shell });
    const pane = initializeContextPane({ shell, scrim });

    sidebarToggle.click();
    assert.equal(isDrawerOpen(shell, "right"), true, "the topbar toggle opens the note-context drawer");
    assert.equal(isDrawerOpen(shell, "left"), false);

    filesToggle.click();
    assert.deepEqual(
      [isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")],
      [true, false],
      "opening the files drawer closes the note-context one",
    );
    assert.equal(pane.isOpen(), false, "the rail state follows the real DOM instead of keeping a stale copy");
    assert.equal(sidebarToggle.getAttribute("aria-pressed"), "false", "so the toggle stops claiming an open rail");

    // #420: the mirror holds in the other direction too — opening the note-context drawer hands the
    // files drawer back, and the ribbon toggle stops claiming the pane that is no longer on screen.
    sidebarToggle.click();
    assert.deepEqual(
      [isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")],
      [false, true],
      "opening the note-context drawer closes the files one",
    );
    assert.equal(filesToggle.classList.contains("active"), false, "the ribbon toggle follows the real DOM as well");

    // The shared scrim closes the drawer that is open and never leaves the other one behind.
    scrim.click();
    assert.deepEqual([isDrawerOpen(shell, "left"), isDrawerOpen(shell, "right")], [false, false], "the scrim closes the current drawer");
    pane.destroy();
  } finally {
    browser.restore();
  }
});

test("above the breakpoint both panes stay docked and no drawer class is used", () => {
  const browser = stubBrowser({ narrow: false });
  try {
    const shell = dom.createElement("div");
    shell.className = "shell";
    const filesToggle = dom.createElement("button");
    filesToggle.id = "files-toggle";
    const scrim = dom.createElement("div");
    scrim.className = "scrim";
    shell.append(filesToggle, scrim);
    dom.document.body.replaceChildren(shell);

    const sidebar = initializeSidebarPanels({ shell });
    const pane = initializeContextPane({ shell, scrim });
    sidebarToggleClick(shell, pane);
    filesToggle.click();
    assert.equal(isDrawerOpen(shell, "left"), false, "a docked pane never gets a drawer class");
    assert.equal(shell.classList.contains("sidebar-hidden"), true, "the ribbon toggle hides the docked pane as before");
    assert.equal(shell.classList.contains("context-hidden"), false, "and the rail keeps its own docked preference");
    pane.destroy();
  } finally {
    browser.restore();
  }
});

// The docked path is the same `setOpen` the rail always had; the toggle node lives in the shell
// markup, so this probe resolves it the way `pane-layout` does.
function sidebarToggleClick(shell, pane) {
  pane.setOpen(true);
  assert.equal(shell.classList.contains("context-hidden"), false);
}

test("the pane-level rail close collapses the rail through the same one state", () => {
  for (const narrow of [false, true]) {
    const browser = stubBrowser({ narrow });
    try {
      const shell = dom.createElement("div");
      shell.className = "shell";
      const sidebarToggle = dom.createElement("button");
      sidebarToggle.id = "sidebar-toggle";
      sidebarToggle.setAttribute("aria-pressed", "true");
      const scrim = dom.createElement("div");
      scrim.className = "scrim";
      shell.append(sidebarToggle, scrim);
      dom.document.body.replaceChildren(shell);
      const drawerClose = dom.createElement("button");
      drawerClose.id = "context-drawer-close";
      drawerClose.setAttribute("data-pane-slot", "close");
      dom.document.body.append(drawerClose);

      const pane = initializeContextPane({ shell, scrim });
      if (narrow) sidebarToggle.click();
      drawerClose.click();
      assert.equal(
        narrow ? isDrawerOpen(shell, "right") : shell.classList.contains("context-hidden"),
        narrow ? false : true,
        "the pane-level close really closes the pane it belongs to",
      );
      assert.equal(sidebarToggle.getAttribute("aria-pressed"), "false", "and the layout toggle follows the same one state");
      sidebarToggle.click();
      assert.equal(
        narrow ? isDrawerOpen(shell, "right") : !shell.classList.contains("context-hidden"),
        true,
        "the layout toggle still re-opens it (one state, two entry points)",
      );
      pane.destroy();
    } finally {
      browser.restore();
    }
  }
});

// --- the conditional document tab row ---------------------------------------

test("the document tab row mirrors the committed tab model", () => {
  const workspace = dom.createElement("main");
  workspace.className = "workspace";
  const row = createDocumentTabRow({ workspace });
  assert.equal(row.isWired, true);
  assert.equal(workspace.classList.contains(TAB_ROW_VISIBLE_CLASS), false, "the welcome workspace starts with one bar");
  assert.equal(row.sync([{ path: "A.md" }]), true);
  assert.equal(workspace.classList.contains(TAB_ROW_VISIBLE_CLASS), true, "a tab puts the row back into the layout");
  assert.equal(row.sync([]), false);
  assert.equal(workspace.classList.contains(TAB_ROW_VISIBLE_CLASS), false, "closing the last tab removes it again");
  assert.equal(createDocumentTabRow({ workspace: null }).isWired, false, "a shell without a workspace stays a no-op");
});

test("the row is hidden by CSS by default and only the mirrored class shows it", () => {
  assert.match(rule(css, ".document-tab-row"), /display:\s*none/, "the row is not in the layout without a tab");
  assert.match(rule(css, ".workspace.has-document-tabs .document-tab-row"), /display:\s*flex/);
  // The row keeps the shared band geometry it always had (the toggle left, the height stayed).
  assert.match(rule(css, ".document-tab-row"), /flex:\s*0 0 var\(--pane-header-height\)/);
  // SSR never inlines the hidden state: the visibility is a class, not a style attribute.
  assert.doesNotMatch(pagesSource, /class="document-tab-row"[^>]*style="[^"]*display:\s*none/);
});

// --- safe area: exactly one owner -------------------------------------------

test("the shared pane token carries no top inset and the sheet declares one inset channel", () => {
  const mobile = slice(css, "@media (max-width: 720px) {", "\n}");
  assert.match(mobile, /--pane-header-height: 52px/, "the shared geometry token is inset-free");
  assert.doesNotMatch(mobile, /--pane-header-height:\s*calc\([^)]*env\(/, "env() must not be baked into the shared token");
  assert.equal(
    (css.match(/--app-inset-top:/g) ?? []).length,
    1,
    "exactly one declaration republishes the top inset",
  );
  assert.match(css, /--app-inset-top:\s*env\(safe-area-inset-top, 0px\)/);
  // The topbar owns it while it is the topmost band, and hands it over to the drawer that covers it.
  const topbar = rule(css, ".shell .topbar");
  assert.match(topbar, /height:\s*calc\(52px \+ var\(--app-inset-top\)\) !important/);
  assert.match(topbar, /padding:\s*var\(--app-inset-top\)/);
  const covered = rule(css, ".shell.sidebar-open .topbar, .shell.context-open .topbar");
  assert.match(covered, /height:\s*52px !important/);
  assert.match(covered, /padding-top:\s*0 !important/);
  assert.match(rule(css, ".shell.sidebar-open .sidebar, .shell.context-open .context-sidebar"), /padding-top:\s*var\(--app-inset-top\)/);
});

test("the 721-1050 tablet band is gone from the stylesheet", () => {
  assert.doesNotMatch(css, /max-width:\s*1050px/, "no side-pane rule may keep the old tablet band");
  assert.doesNotMatch(css, /min-width:\s*721px/, "and the band's lower edge is gone with it");
  // Below the one breakpoint both panes really are drawers on the shared scrim.
  const mobile = slice(css, "@media (max-width: 720px) {", "\n}");
  assert.match(mobile, /\.sidebar \{ position: fixed/, "the files pane becomes a drawer");
  assert.match(mobile, /\.context-sidebar \{ position: fixed/, "the note-context pane becomes a drawer");
  assert.match(mobile, /\.shell\.sidebar-open \.scrim, \.shell\.context-open \.scrim \{/, "and both share the one scrim");
  assert.equal((markup.match(/class="scrim"/g) ?? []).length, 1, "the shell ships exactly one scrim");
});

test("the open drawer is opaque and the document column stays under the shell overlays (#418)", () => {
  // Issue #418: a feature may lift itself inside the document with a z-index (the Base surface
  // header uses 5), so the document subtree is one stacking context below the shell overlays and
  // the drawer surface forces alpha 1 on the themed chrome colour instead of trusting a token a
  // community theme may hand over translucent. Both rules live in the frozen <=720px block.
  const mobile = slice(css, "@media (max-width: 720px) {", "\n}");
  assert.match(mobile, /\.sidebar, \.context-sidebar \{[^}]*background-color: rgb\(from [^}]*\/ 1\);/, "the drawer surface must composite opaque");
  assert.match(mobile, /\.workspace \{[^}]*isolation: isolate;/, "the document column must be a stacking context under the drawer");
  // The frozen order is untouched: the scrim is still the translucent hint below the drawer.
  assert.match(mobile, /\.sidebar \{ position: fixed; z-index: 5;/, "the drawer stays above the scrim");
  assert.match(mobile, /z-index: 4; display: block; background: #0006;/, "the scrim stays translucent and below the drawer");
});

test("the no-note rail states what it will show, in the shell and at runtime", () => {
  // U29 (#371) goal ⑥: the preferred fix (the full empty-state wording), not the downgrade to a
  // disabled toggle. Both the SSR paint and the runtime empty state carry the same sentence.
  assert.match(markup, /<div class="context-empty">打开笔记后显示大纲与反链<\/div>/);
  assert.match(outlineSource, /function clear\(message = "打开笔记后显示大纲与反链"\)/);
  // The layout toggle is never disabled: without a document it is a real, working entry.
  assert.doesNotMatch(markup, /id="sidebar-toggle"[^>]*disabled/);
  assert.equal((markup.match(/id="sidebar-toggle"/g) ?? []).length, 1);
});

// --- pane header symmetry ----------------------------------------------------

test("both side panes expose the same pane header shape, asserted item by item", () => {
  const leftHeader = slice(markup, 'class="sidebar-head"', 'id="panel-files"');
  const rightHeader = slice(markup, 'class="context-header context-view-header"', "</header>");
  const shape = (header) => ({
    slots: [...header.matchAll(/data-pane-slot="([a-z]+)"/g)].map((match) => match[1]),
    tablist: (header.match(/role="tablist"/g) ?? []).length,
    closeClass: header.includes('class="icon-btn pane-head-close"'),
    closeGlyph: header.includes('#x"></use>'),
    closeIsLast: header.indexOf('data-pane-slot="close"') > header.indexOf('data-pane-slot="switch"'),
  });
  assert.deepEqual(shape(leftHeader), shape(rightHeader), "the two pane headers are one shape");
  assert.deepEqual(shape(leftHeader), { slots: ["switch", "close"], tablist: 1, closeClass: true, closeGlyph: true, closeIsLast: true });

  // Each pane has exactly one of each slot, and the close is a real pane control: it closes the
  // pane it belongs to through the same single state its external toggle owns.
  for (const [name, pane] of [
    ["left", slice(markup, '<aside class="sidebar ', '<footer class="sidebar-footer">')],
    ["right", slice(markup, '<aside id="context-sidebar"', "</aside>")],
  ]) {
    assert.equal((pane.match(/data-pane-slot="switch"/g) ?? []).length, 1, `${name}: one view switcher`);
    assert.equal((pane.match(/data-pane-slot="close"/g) ?? []).length, 1, `${name}: one pane-level close`);
    assert.ok((pane.match(/data-pane-slot="actions"/g) ?? []).length >= 1, `${name}: the panel heads expose the action slot`);
  }
  assert.match(sidebarPanelsSource, /closeButton \?\? \$\("#panel-close"\)/, "the left pane close is the pane toggle");
  assert.match(paneLayoutSource, /drawerClose\.onclick = \(\) => setOpen\(false\)/, "the right pane close is the same rail state");
  // The rail header still carries no layout toggle (U18 stays true under #371).
  assert.equal(slice(markup, '<aside id="context-sidebar"', "</aside>").includes('id="sidebar-toggle"'), false);
});
