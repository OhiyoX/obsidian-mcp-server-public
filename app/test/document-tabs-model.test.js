// U14 document tab strip: model and view contract.
//
// The strip is pure navigation state over the app's single Markdown document: one tab per
// path, the committed document identity decides which tab is active, a Base document adds
// no tab and leaves every tab inactive, closing an inactive tab never navigates, and
// closing the active tab hands the caller its right neighbour, then its left neighbour,
// then "welcome". No document content is stored per tab (switching re-reads from disk
// through the existing openNote flow).
//
// These tests pin the frozen DOM contract from the U14 BRIEF as well: the wrapper is
// `role="presentation"` (a close control cannot be nested inside the tab button), the tab
// button carries `data-tab-path`/`data-tab-index`/`title` = full path, the label is the
// file name without `.md`, and the close button carries `data-tab-close` +
// `aria-label="关闭 <name>"`.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createTabsModel, tabTitle, BASE_DOCUMENT_KIND } from "../frontend/app/features/tabs/model.js";
import { createDocumentTabs } from "../frontend/app/features/tabs/index.js";

const dom = createDomHarness();
const NOTE_A = "_Workspace/40-Projects/A.md";
const NOTE_B = "_Workspace/40-Projects/B.md";
const NOTE_C = "Inbox/note-without-extension";

// --- model ------------------------------------------------------------------

test("syncFromSession appends a new note once and re-activates an existing tab", () => {
  const model = createTabsModel();
  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A]);
  assert.equal(model.getActiveIndex(), 0);

  model.syncFromSession({ path: NOTE_B, documentKind: "note" });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A, NOTE_B]);
  assert.equal(model.getActiveIndex(), 1, "the just-opened note is active");

  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A, NOTE_B], "same path never duplicates");
  assert.equal(model.getActiveIndex(), 0, "re-opening activates the existing tab");
});

test("a Base document adds no tab and leaves every tab inactive; the note tab returns", () => {
  const model = createTabsModel();
  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  model.syncFromSession({ path: NOTE_B, documentKind: "note" });

  model.syncFromSession({ path: "_Bases/Status.base", documentKind: BASE_DOCUMENT_KIND });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A, NOTE_B], "Base is not a tab");
  assert.equal(model.getActiveIndex(), -1, "no tab is active while a Base document is on screen");
  assert.equal(model.getActivePath(), null);

  model.syncFromSession({ path: NOTE_B, documentKind: "note" });
  assert.equal(model.getActiveIndex(), 1, "returning to a note restores its tab");
});

test("an empty identity (welcome) keeps the list but deactivates every tab", () => {
  const model = createTabsModel();
  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  model.syncFromSession({ path: null, documentKind: null });
  assert.equal(model.getActiveIndex(), -1);
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A]);
});

test("planClose: closing an inactive tab leaves the active document untouched", () => {
  const model = createTabsModel();
  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  model.syncFromSession({ path: NOTE_B, documentKind: "note" });
  model.syncFromSession({ path: NOTE_C, documentKind: "note" });
  model.syncFromSession({ path: NOTE_B, documentKind: "note" });

  assert.deepEqual(model.planClose(0), { kind: "inactive", index: 0 }, "a non-active tab only removes itself");
  model.removeAt(0);
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_B, NOTE_C]);
  assert.equal(model.getActivePath(), NOTE_B, "active tab is unchanged");
  assert.equal(model.getActiveIndex(), 0, "the active tab follows its shifted position");
});

test("planClose: the active tab hands over right neighbour, then left neighbour, then welcome", () => {
  const model = createTabsModel();
  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  model.syncFromSession({ path: NOTE_B, documentKind: "note" });
  model.syncFromSession({ path: NOTE_C, documentKind: "note" });
  model.syncFromSession({ path: NOTE_B, documentKind: "note" });

  assert.deepEqual(model.planClose(1), { kind: "switch", index: 1, targetPath: NOTE_C }, "right neighbour first");
  model.removeAt(1, { activate: NOTE_C });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A, NOTE_C]);

  assert.deepEqual(model.planClose(1), { kind: "switch", index: 1, targetPath: NOTE_A }, "then the left neighbour");
  model.removeAt(1, { activate: NOTE_A });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [NOTE_A]);

  assert.deepEqual(model.planClose(0), { kind: "welcome", index: 0 }, "the last tab closes to the welcome page");
  model.removeAt(0);
  assert.equal(model.getActiveIndex(), -1);
  assert.equal(model.size(), 0);
});

test("planClose ignores an out-of-range index", () => {
  const model = createTabsModel();
  assert.deepEqual(model.planClose(0), { kind: "invalid", index: 0 });
  model.syncFromSession({ path: NOTE_A, documentKind: "note" });
  assert.deepEqual(model.planClose(4), { kind: "invalid", index: 4 });
  assert.deepEqual(model.planClose(undefined), { kind: "invalid", index: undefined });
});

test("tabTitle drops only a trailing .md (desktop shows the note name)", () => {
  assert.equal(tabTitle("a/b/DONE - TODO.md"), "DONE - TODO");
  assert.equal(tabTitle("Inbox/archive.md.bak"), "archive.md.bak");
  assert.equal(tabTitle("Inbox/no-extension"), "no-extension");
  assert.equal(tabTitle(""), "");
});

// --- controller + rendered DOM ----------------------------------------------

function mountStrip({ openResult = true, welcomeResult = true } = {}) {
  // A fresh harness per strip: `document.querySelector("#document-tabs")` must resolve to
  // this fixture's container, not to a strip mounted by an earlier test.
  const local = createDomHarness();
  local.install();
  const host = local.createElement("div");
  host.id = "document-tabs";
  host.className = "document-tabs";
  host.setAttribute("role", "tablist");
  host.setAttribute("aria-label", "打开的文档");
  local.document.body.append(host);

  const app = { path: null, documentKind: null };
  const opens = [];
  const replaces = [];
  const welcomes = [];
  const stripChanges = [];
  let controller = null;

  controller = createDocumentTabs({
    documentRef: local.document,
    // #410: the strip must never navigate the page itself. This recorder is wired to the
    // removed `locationObject.replace("/app")` path and must stay empty in every test.
    locationObject: { replace: (route) => replaces.push(route) },
    // #410: the last close is delegated to the app's in-app transition; the strip only
    // drops the tab once it reports the transition committed.
    enterWelcome: () => { welcomes.push(true); return welcomeResult; },
    onModelChange: (tabs) => stripChanges.push(tabs.map((tab) => tab.path)),
    openNote: async (path) => {
      opens.push(path);
      if (openResult === false) return false;
      if (openResult === "pending") return true; // navigation left uncommitted on purpose
      app.path = path;
      app.documentKind = "note";
      controller.syncFromSession();
      return true;
    },
    getCurrentPath: () => app.path,
    getDocumentKind: () => app.documentKind,
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const rows = () => host.querySelectorAll(".document-tab");
  const mains = () => rows().map((row) => row.querySelector(".document-tab-main"));
  // The harness has no bubbling, so delegate-targeted clicks are dispatched on the strip
  // itself — the same listener the browser reaches by bubbling from the tab button.
  const click = (target) => host.dispatchEvent({ type: "click", target });
  const press = (target, key) => host.dispatchEvent({ type: "keydown", key, target, preventDefault: () => {} });
  const setDocument = (path, documentKind = "note") => {
    app.path = path;
    app.documentKind = documentKind;
    controller.syncFromSession();
  };
  return { host, controller, app, opens, replaces, welcomes, stripChanges, settle, rows, mains, click, press, setDocument };
}

function tabContract(host) {
  return host.querySelectorAll(".document-tab").map((row) => ({
    presentation: row.getAttribute("role"),
    path: row.getAttribute("data-tab-path"),
    active: row.classList.contains("is-active"),
    main: (() => {
      const main = row.querySelector(".document-tab-main");
      return {
        tag: main.tagName,
        type: main.getAttribute("type"),
        role: main.getAttribute("role"),
        selected: main.getAttribute("aria-selected"),
        tabindex: main.getAttribute("tabindex"),
        path: main.getAttribute("data-tab-path"),
        index: main.getAttribute("data-tab-index"),
        title: main.getAttribute("title"),
        label: main.querySelector(".document-tab-title").textContent,
        nestedButtons: main.querySelectorAll("button").length,
      };
    })(),
    close: (() => {
      const close = row.querySelector(".document-tab-close");
      return {
        type: close.getAttribute("type"),
        label: close.getAttribute("aria-label"),
        index: close.getAttribute("data-tab-close"),
        tabindex: close.getAttribute("tabindex"),
      };
    })(),
  }));
}

test("the rendered strip follows the frozen DOM contract and marks one active tab", () => {
  const strip = mountStrip();
  assert.equal(strip.controller.isWired, true);
  assert.deepEqual(tabContract(strip.host), [], "a fresh page renders no tab");

  strip.setDocument(NOTE_A);
  strip.setDocument("_Workspace/40-Projects/DONE - TODO.md");
  const rows = tabContract(strip.host);

  assert.deepEqual(rows.map((row) => row.presentation), ["presentation", "presentation"]);
  assert.deepEqual(rows.map((row) => row.active), [false, true]);
  assert.deepEqual(rows.map((row) => row.main.label), ["A", "DONE - TODO"]);
  assert.deepEqual(rows.map((row) => row.main.title), [NOTE_A, "_Workspace/40-Projects/DONE - TODO.md"]);
  assert.deepEqual(rows.map((row) => row.main.index), ["0", "1"]);
  assert.deepEqual(rows.map((row) => row.main.path), [NOTE_A, "_Workspace/40-Projects/DONE - TODO.md"]);
  assert.deepEqual(rows.map((row) => row.main.selected), ["false", "true"], "aria-selected is unique");
  assert.deepEqual(rows.map((row) => row.main.tabindex), ["-1", "0"], "roving tabindex follows the active tab");
  assert.deepEqual(rows.map((row) => row.main.nestedButtons), [0, 0], "no button inside the tab button");
  assert.deepEqual(rows.map((row) => row.close.label), ["关闭 A", "关闭 DONE - TODO"]);
  assert.deepEqual(rows.map((row) => row.close.index), ["0", "1"]);
  assert.deepEqual(rows.map((row) => row.close.tabindex), ["-1", "-1"]);
  assert.equal(rows.every((row) => row.main.tag === "BUTTON" && row.close.type === "button"), true);
});

test("a Base document leaves the strip without an active tab and returning restores it", () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument("_Bases/Status.base", "base");
  assert.deepEqual(tabContract(strip.host).map((row) => row.active), [false], "no active tab on a Base document");
  assert.deepEqual(tabContract(strip.host).map((row) => row.main.selected), ["false"]);

  strip.setDocument(NOTE_A);
  assert.deepEqual(tabContract(strip.host).map((row) => row.active), [true], "the note tab comes back");
});

test("clicking a tab opens that note; clicking the active tab does nothing", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  assert.deepEqual(strip.opens, [], "rendering alone never opens a document");

  strip.click(strip.mains()[0]);
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_A], "the clicked tab is opened through the normal flow");
  assert.equal(strip.controller.getState().activeIndex, 0);

  strip.click(strip.mains()[0]);
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_A], "clicking the tab already on screen never re-opens it");
});

test("closing an inactive tab removes it without navigating", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);

  const closeA = strip.rows()[0].querySelector(".document-tab-close");
  strip.click(closeA);
  await strip.settle();
  assert.deepEqual(strip.opens, [], "closing a background tab never navigates");
  assert.deepEqual(tabContract(strip.host).map((row) => row.main.label), ["B", "note-without-extension"]);
  assert.equal(strip.controller.getState().activeIndex, 1, "the active document is still the one on screen");
  assert.deepEqual(tabContract(strip.host).map((row) => row.active), [false, true]);
});

test("closing the active tab opens its right neighbour, else its left neighbour", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);
  strip.setDocument(NOTE_B);

  strip.click(strip.rows()[1].querySelector(".document-tab-close"));
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_C], "the right neighbour is opened first");
  assert.deepEqual(tabContract(strip.host).map((row) => row.main.label), ["A", "note-without-extension"]);
  assert.deepEqual(tabContract(strip.host).map((row) => row.active), [false, true]);

  strip.click(strip.rows()[1].querySelector(".document-tab-close"));
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_C, NOTE_A], "with no right neighbour the left one is opened");
  assert.deepEqual(tabContract(strip.host).map((row) => row.main.label), ["A"]);
});

test("a rejected close (unsaved-edit guard) keeps the tab active", async () => {
  const strip = mountStrip({ openResult: false });
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);

  strip.click(strip.rows()[1].querySelector(".document-tab-close"));
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_A], "the neighbour open was attempted (its own guard answered)");
  assert.deepEqual(tabContract(strip.host).map((row) => row.main.label), ["A", "B"], "the close is aborted");
  assert.deepEqual(tabContract(strip.host).map((row) => row.active), [false, true]);
  assert.equal(strip.controller.getState().activeIndex, 1);
});

test("closing the last tab runs the in-app welcome transition and never reloads the page", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  assert.deepEqual(strip.stripChanges.at(-1), [NOTE_A], "every committed list is mirrored outward");

  strip.click(strip.rows()[0].querySelector(".document-tab-close"));
  await strip.settle();
  assert.deepEqual(strip.welcomes, [true], "the app's in-app welcome transition owns the last close");
  assert.deepEqual(strip.opens, [], "no note is opened to reach the welcome page");
  assert.deepEqual(strip.replaces, [], "#410: the strip itself never loads a page");
  assert.deepEqual(tabContract(strip.host), [], "the closed tab leaves the strip");
  assert.deepEqual(strip.stripChanges.at(-1), [], "and the row mirror sees the empty strip");
  assert.equal(strip.controller.getState().activeIndex, -1, "no tab stays active on the welcome workspace");
});

test("a welcome transition the dirty guard declined keeps the tab and the document", async () => {
  const strip = mountStrip({ welcomeResult: false });
  strip.setDocument(NOTE_A);

  strip.click(strip.rows()[0].querySelector(".document-tab-close"));
  await strip.settle();
  assert.deepEqual(strip.welcomes, [true], "the guard was asked before the close");
  assert.deepEqual(strip.replaces, [], "and no page load was attempted");
  assert.deepEqual(tabContract(strip.host).map((row) => row.main.label), ["A"], "the refused close keeps the tab");
  assert.equal(strip.controller.getState().activeIndex, 0, "the document on screen is untouched");
});

test("keyboard arrows move along the strip and activate the tab they land on", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);

  const first = strip.mains()[0];
  strip.press(first, "ArrowRight");
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B], "ArrowRight activates the next tab");

  const last = strip.mains()[2];
  strip.press(last, "Home");
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B, NOTE_A], "Home activates the first tab");
});

test("the controller is a no-op when the shell has no tab strip", () => {
  const bare = createDomHarness();
  bare.install();
  const controller = createDocumentTabs({ documentRef: bare.document, openNote: async () => true });
  assert.equal(controller.isWired, false);
  assert.equal(controller.syncFromSession(), undefined);
  assert.equal(controller.destroy(), undefined);
});
