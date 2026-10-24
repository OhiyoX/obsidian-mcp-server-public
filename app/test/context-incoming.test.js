// Frontend tests for the note-context link sections (sidebar Phase 2 + 3).
//
// Real DOM harness (test/helpers/base-dom.mjs) + injected dependencies. Covers the
// desktop Backlinks-panel structure asserted against the real `pages.js` markup
// (section titles, counts, empty-state copy, `⋮` menu item set, list semantics), the
// incoming/backlinks section state machine and navigation, and the combined attach
// layer that keeps both sections in lockstep across note/Base switches.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { INCOMING_MESSAGES, createIncomingLinks } from "../frontend/app/features/context/incoming.js";
import { attachIncomingLinks } from "../frontend/app/features/context/attach-incoming.js";
import { attachNoteContext, wireContextSection } from "../frontend/app/features/context/attach-note-context.js";

const dom = createDomHarness();
dom.install();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const OUTGOING_TITLE = "当前笔记中的链接";
const INCOMING_TITLE = "链接当前笔记";

// --- fixture DOM mirroring the shell markup contract ------------------------

function buildSection(name, title, listId, ariaLabel, idleText) {
  const header = dom.createElement("header");
  header.className = "context-header context-section-header";
  header.setAttribute("data-context-section", name);

  const toggle = dom.createElement("button");
  toggle.className = "icon-btn context-section-menu-toggle";
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");

  const titleEl = dom.createElement("span");
  titleEl.className = "context-title";
  titleEl.textContent = title;

  const count = dom.createElement("span");
  count.className = "context-section-count";
  count.setAttribute("data-context-count", name);
  count.textContent = "0";

  const menu = dom.createElement("div");
  menu.className = "context-section-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const collapse = dom.createElement("button");
  collapse.className = "context-section-menu-item";
  // U35 (#407): the shipped markup carries `role="menuitem"` (pages.js:275/295) and the primitive's
  // keyboard navigation reads that role, so the fixture mirrors it.
  collapse.setAttribute("role", "menuitem");
  collapse.setAttribute("data-context-action", "collapse");
  collapse.textContent = "折叠";
  const refresh = dom.createElement("button");
  refresh.className = "context-section-menu-item";
  refresh.setAttribute("role", "menuitem");
  refresh.setAttribute("data-context-action", "refresh");
  refresh.textContent = "刷新";
  menu.append(collapse, refresh);

  // U7: the panel's own head owns the ⋮ menu, while the section header keeps the U2
  // title + count. Both halves are mirroring the shipped `pages.js` markup.
  const head = dom.createElement("header");
  head.className = "context-header context-panel-head";
  head.setAttribute("data-context-panel", name);
  head.append(toggle, menu);
  header.append(titleEl, count);

  const host = dom.createElement("nav");
  host.id = listId;
  host.className = "outline-list";
  host.setAttribute("aria-label", ariaLabel);
  const empty = dom.createElement("div");
  empty.className = "context-empty";
  empty.textContent = idleText;
  host.append(empty);

  return { header, head, host, count, toggle, menu, collapse, refresh };
}

function mountSidebar() {
  const root = dom.createElement("aside");
  const outgoing = buildSection("outgoing", OUTGOING_TITLE, "outgoing-list", OUTGOING_TITLE, "打开笔记后显示出链");
  const incoming = buildSection("incoming", INCOMING_TITLE, "incoming-list", INCOMING_TITLE, "打开笔记后显示反向链接");
  root.append(outgoing.head, outgoing.header, outgoing.host, incoming.head, incoming.header, incoming.host);
  // The harness document persists across tests, so each mount replaces the previous
  // sidebar (the attach layer finds the headers by document lookup).
  dom.document.body.replaceChildren(root);
  return { root, outgoing, incoming };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

const INCOMING_ITEM = { sourcePath: "Alpha.md", target: "Target", alias: null, heading: null };


function incomingFixture() {
  const host = dom.createElement("nav");
  host.id = "incoming-list";
  return host;
}

function rows(host) {
  return host.querySelectorAll(".incoming-item");
}

test("the incoming section starts on its idle hint", () => {
  const host = incomingFixture();
  const controller = createIncomingLinks({ host, fetchIncoming: async () => ({ links: [] }) });
  assert.equal(controller.getState().status, "idle");
  assert.equal(host.textContent, INCOMING_MESSAGES.idle);
});

test("a note without backlinks shows the desktop empty copy and a 0 count", async () => {
  const host = incomingFixture();
  const count = dom.createElement("span");
  const controller = createIncomingLinks({ host, countHost: count, fetchIncoming: async () => ({ links: [] }) });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(controller.getState().status, "empty");
  assert.equal(host.textContent, "没有反向链接");
  assert.equal(count.textContent, "0");
});

test("rows render in API order, one per source, and the count equals the row count", async () => {
  const host = incomingFixture();
  const count = dom.createElement("span");
  const controller = createIncomingLinks({
    host,
    countHost: count,
    fetchIncoming: async () => ({
      links: [
        { sourcePath: "Alpha.md", target: "Target", alias: null, heading: null },
        { sourcePath: "Sub/Gamma.md", target: "Target", alias: null, heading: "Section" },
      ],
    }),
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(count.textContent, "2");
  assert.equal(rows(host).length, 2);
  assert.equal(rows(host)[0].dataset.sourcePath, "Alpha.md");
  assert.equal(rows(host)[0].querySelector(".incoming-row-path").textContent, "Alpha");
  assert.equal(rows(host)[0].title, "Alpha.md");
  assert.equal(rows(host)[0].querySelector(".context-row-parent"), null, "a root-level source has no parent subline");
  assert.equal(rows(host)[1].querySelector(".incoming-row-path").textContent, "Sub/Gamma", "the row shows the full vault-relative source path (without .md)");
  assert.equal(rows(host)[1].querySelector(".context-row-parent").textContent, "Sub");
  assert.equal(rows(host)[1].title, "Sub/Gamma.md");
});

test("clicking a backlink opens the source note with its heading fragment", async () => {
  const host = incomingFixture();
  const opened = [];
  const controller = createIncomingLinks({
    host,
    fetchIncoming: async () => ({
      links: [{ sourcePath: "Sub/Gamma.md", target: "Target.md#Section", alias: null, heading: "Section" }],
    }),
    openNote: (path, options) => opened.push({ path, ...options }),
  });
  await controller.setDocument({ path: "Target.md" });
  rows(host)[0].querySelector("button").click();
  assert.deepEqual(opened, [{ path: "Sub/Gamma.md", fragment: "Section" }]);
});

test("a row without a source path is inert instead of a fake control", async () => {
  const host = incomingFixture();
  const opened = [];
  const controller = createIncomingLinks({
    host,
    fetchIncoming: async () => ({ links: [{ sourcePath: "", target: "Target", alias: null, heading: null }] }),
    openNote: (path) => opened.push(path),
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(rows(host)[0].querySelector("button"), null);
  assert.equal(rows(host)[0].querySelector("span").getAttribute("aria-disabled"), "true");
  assert.deepEqual(opened, []);
});

test("a failed load renders an error state and retry refetches", async () => {
  const host = incomingFixture();
  let attempt = 0;
  const controller = createIncomingLinks({
    host,
    fetchIncoming: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom with /absolute/path");
      return { links: [INCOMING_ITEM] };
    },
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(controller.getState().status, "error");
  assert.equal(host.textContent.includes("反向链接加载失败"), true);
  assert.equal(host.textContent.includes("/absolute/path"), false, "server error text must not be rendered");
  const retry = host.querySelector(".incoming-retry");
  assert.ok(retry, "error state exposes a retry control");
  retry.click();
  await tick();
  await tick();
  assert.equal(attempt, 2);
  assert.equal(controller.getState().status, "ready");
  assert.equal(rows(host).length, 1);
});

test("aliases and source paths are rendered as untrusted text (no HTML injection)", async () => {
  const host = incomingFixture();
  const payload = '<img src=x onerror="globalThis.pwned=true">';
  const controller = createIncomingLinks({
    host,
    fetchIncoming: async () => ({
      links: [
        { sourcePath: "Payload.md", target: "Target", alias: payload, heading: null },
        { sourcePath: `${payload}.md`, target: "Target", alias: null, heading: null },
      ],
    }),
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.textContent.includes(payload), true);
  assert.equal(globalThis.pwned, undefined);
});

test("switching documents refetches and ignores a stale response", async () => {
  const host = incomingFixture();
  const pending = [];
  const controller = createIncomingLinks({
    host,
    fetchIncoming: ({ path }) => new Promise((resolve) => pending.push({ path, resolve })),
  });
  const first = controller.setDocument({ path: "A.md" });
  const second = controller.setDocument({ path: "B.md" });
  assert.deepEqual(pending.map((item) => item.path), ["A.md", "B.md"]);
  pending[1].resolve({ links: [{ sourcePath: "B.md", target: "B", alias: null, heading: null }] });
  await second;
  pending[0].resolve({ links: [{ sourcePath: "A.md", target: "A", alias: null, heading: null }] });
  await first;
  assert.equal(controller.getState().path, "B.md");
  assert.deepEqual(controller.getState().items.map((item) => item.sourcePath), ["B.md"]);
  assert.equal(rows(host).length, 1);
});

test("Base <-> note round trip clears and reloads the section", async () => {
  const host = incomingFixture();
  const count = dom.createElement("span");
  const calls = [];
  const controller = createIncomingLinks({
    host,
    countHost: count,
    fetchIncoming: async ({ path }) => {
      calls.push(path);
      return { links: [INCOMING_ITEM] };
    },
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(count.textContent, "1");

  await controller.setDocument({ path: "Table.base", documentKind: "base" });
  assert.equal(controller.getState().status, "idle");
  assert.deepEqual(controller.getState().items, []);
  assert.equal(rows(host).length, 0);
  assert.equal(host.textContent, "Base 文档没有反向链接");
  assert.equal(count.textContent, "0");

  await controller.setDocument({ path: "Other.md", documentKind: "note" });
  assert.deepEqual(calls, ["Target.md", "Other.md"]);
  assert.equal(controller.getState().path, "Other.md");
  assert.equal(rows(host).length, 1);
});

test("the incoming module registers no global listeners and has no raw-HTML sink", async () => {
  const host = incomingFixture();
  let documentListenerCalls = 0;
  const originalAdd = dom.document.addEventListener;
  dom.document.addEventListener = (...args) => { documentListenerCalls += 1; return originalAdd?.apply(dom.document, args); };
  try {
    const controller = createIncomingLinks({ host, fetchIncoming: async () => ({ links: [INCOMING_ITEM] }) });
    await controller.setDocument({ path: "Target.md" });
    controller.destroy();
    assert.equal(documentListenerCalls, 0);
  } finally {
    dom.document.addEventListener = originalAdd;
  }

  const source = await fs.readFile(new URL("../frontend/app/features/context/incoming.js", import.meta.url), "utf8");
  for (const forbidden of ["core/app.js", "features/bases", "features/explorer", "features/navigation", "app/src/app/assets"]) {
    assert.equal(source.includes(forbidden), false, `incoming.js must not reference ${forbidden}`);
  }
  assert.equal(/document\s*\.\s*addEventListener|window\s*\.\s*addEventListener/.test(source), false);
  assert.equal(/innerHTML/.test(source), false);
});

// --- attach layers ---------------------------------------------------------

test("attachIncomingLinks fetches the incoming API and clears on Base/empty", async () => {
  const host = incomingFixture();
  const requests = [];
  const attached = attachIncomingLinks({
    host,
    openNote: () => {},
    vaultId: () => "vault",
    fetchImpl: async (url) => { requests.push({ url }); return jsonResponse({ links: [INCOMING_ITEM] }); },
  });
  await attached.setDocument({ path: "Notes/Target.md", documentKind: "note" });
  assert.equal(requests[0].url, "/api/web/v1/note-context/incoming?path=Notes%2FTarget.md");
  assert.equal(rows(host).length, 1);

  await attached.setDocument({ path: "Notes/Target.md", documentKind: "note" });
  assert.equal(requests.length, 1, "an unchanged document identity must not refetch");

  await attached.setDocument({ path: "Notes/Target.md", documentKind: "base" });
  assert.equal(host.textContent, "Base 文档没有反向链接");
  assert.equal(rows(host).length, 0);
});

test("attachNoteContext drives both sections and the header chrome from one object", async () => {
  const { outgoing, incoming } = mountSidebar();
  const requests = [];
  const context = attachNoteContext({
    outgoingHost: outgoing.host,
    incomingHost: incoming.host,
    openNote: () => {},
    vaultId: () => "vault",
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/incoming")) {
        return jsonResponse({ links: [
          { sourcePath: "Alpha.md", target: "Target", alias: null, heading: null },
          { sourcePath: "Sub/Gamma.md", target: "Target", alias: null, heading: null },
        ] });
      }
      if (String(url).includes("/unlinked")) return jsonResponse({ mentions: [] });
      return jsonResponse({ links: [{ target: "Other", kind: "unresolved", resolvedPath: null, alias: null, heading: null }] });
    },
  });

  await context.setDocument({ path: "Target.md", documentKind: "note" });
  assert.deepEqual(requests, [
    "/api/web/v1/note-context/outgoing?path=Target.md",
    "/api/web/v1/note-context/incoming?path=Target.md",
    "/api/web/v1/note-context/unlinked?path=Target.md",
  ]);
  // Counts are the rendered row counts, not a server value.
  assert.equal(outgoing.count.textContent, "1");
  assert.equal(incoming.count.textContent, "2", "count == rendered rows");
  assert.equal(rows(incoming.host).length, 2);

  // Editing/saving refreshes nothing while the document identity is unchanged.
  await context.setDocument({ path: "Target.md", documentKind: "note" });
  assert.equal(requests.length, 3);

  await context.setDocument({ path: "Table.base", documentKind: "base" });
  assert.equal(outgoing.count.textContent, "0");
  assert.equal(incoming.count.textContent, "0");
  assert.equal(incoming.host.textContent, "Base 文档没有反向链接");
  assert.equal(outgoing.host.textContent, "Base 文档没有出链");

  context.clear();
  assert.equal(incoming.host.textContent, "打开笔记后显示反向链接");
  assert.equal(outgoing.host.textContent, "打开笔记后显示出链");
});

test("the section menu opens, collapses the section and refreshes it", async () => {
  const { incoming } = mountSidebar();
  const requests = [];
  const context = attachNoteContext({
    outgoingHost: null,
    incomingHost: incoming.host,
    openNote: () => {},
    fetchImpl: async (url) => { requests.push(String(url)); return jsonResponse({ links: [INCOMING_ITEM] }); },
  });
  await context.setDocument({ path: "Target.md" });

  assert.equal(incoming.menu.hidden, true);
  assert.equal(incoming.toggle.getAttribute("aria-expanded"), "false");
  incoming.toggle.click();
  assert.equal(incoming.menu.hidden, false);
  assert.equal(incoming.toggle.getAttribute("aria-expanded"), "true");

  incoming.collapse.click();
  assert.equal(incoming.menu.hidden, true);
  assert.equal(incoming.host.hidden, true);
  assert.equal(incoming.collapse.textContent, "展开");
  incoming.toggle.click();
  incoming.collapse.click();
  assert.equal(incoming.host.hidden, false);
  assert.equal(incoming.collapse.textContent, "折叠");

  incoming.refresh.click();
  await tick();
  await tick();
  assert.equal(requests.length, 4, "refresh re-fetches the section");
  assert.equal(rows(incoming.host).length, 1);

  incoming.toggle.click();
  // U35 (#407): the Escape-to-close path belongs to the shared primitive's document-level
  // keyboard listener (a real keydown bubbles from the focused element up to the document),
  // and it hands the focus back to the `⋮` that owns the menu.
  dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(incoming.menu.hidden, true);
  assert.equal(incoming.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(dom.document.activeElement, incoming.toggle, "Escape returns focus to the section ⋮");
  context.destroy();
});

test("the two link-panel ⋮ menus exclude each other in the shared rail scope (#407)", async () => {
  const { outgoing, incoming } = mountSidebar();
  const context = attachNoteContext({
    outgoingHost: outgoing.host,
    incomingHost: incoming.host,
    openNote: () => {},
    fetchImpl: async () => jsonResponse({ links: [], mentions: [] }),
  });
  try {
    outgoing.toggle.click();
    assert.equal(outgoing.menu.hidden, false, "the outgoing ⋮ menu opens");
    assert.equal(outgoing.toggle.getAttribute("aria-expanded"), "true");

    incoming.toggle.click();
    assert.equal(incoming.menu.hidden, false, "the incoming ⋮ menu opens");
    assert.equal(outgoing.menu.hidden, true, "and the outgoing one closed itself (one popup per scope)");
    assert.equal(outgoing.toggle.getAttribute("aria-expanded"), "false");
  } finally {
    context.destroy();
  }
});

test("a section ⋮ menu dismisses outside and navigates with Arrow/Home/End (#407)", async () => {
  const { incoming } = mountSidebar();
  const context = attachNoteContext({
    outgoingHost: null,
    incomingHost: incoming.host,
    openNote: () => {},
    fetchImpl: async () => jsonResponse({ links: [] }),
  });
  try {
    incoming.toggle.dispatchEvent({ type: "click", detail: 1 });
    assert.equal(incoming.menu.hidden, false);
    dom.document.dispatchEvent({ type: "pointerdown", target: dom.document.body });
    assert.equal(incoming.menu.hidden, true, "an outside press dismisses the ⋮ menu");
    assert.equal(incoming.toggle.getAttribute("aria-expanded"), "false");

    // A keyboard open hands the focus to the first real action; the arrow keys walk the two
    // actions and wrap, Home/End jump to the ends.
    incoming.toggle.dispatchEvent({ type: "click", detail: 0 });
    assert.equal(dom.document.activeElement, incoming.collapse, "a keyboard open focuses the first action");
    dom.document.dispatchEvent({ type: "keydown", key: "ArrowDown" });
    assert.equal(dom.document.activeElement, incoming.refresh);
    dom.document.dispatchEvent({ type: "keydown", key: "ArrowDown" });
    assert.equal(dom.document.activeElement, incoming.collapse, "ArrowDown wraps at the end");
    dom.document.dispatchEvent({ type: "keydown", key: "End" });
    assert.equal(dom.document.activeElement, incoming.refresh);
    dom.document.dispatchEvent({ type: "keydown", key: "Home" });
    assert.equal(dom.document.activeElement, incoming.collapse);
    dom.document.dispatchEvent({ type: "keydown", key: "ArrowUp" });
    assert.equal(dom.document.activeElement, incoming.refresh, "ArrowUp wraps at the start");

    // The focused action is still the real one: activating it refreshes the section.
    incoming.refresh.click();
    assert.equal(incoming.menu.hidden, true, "picking an action closes the menu");
    assert.equal(dom.document.activeElement, incoming.toggle, "and the focus returns to the section ⋮");
  } finally {
    context.destroy();
  }
});

test("the combined attach layer adds no document- or window-level listener", async () => {
  const { outgoing, incoming } = mountSidebar();
  let documentListenerCalls = 0;
  const originalAdd = dom.document.addEventListener;
  dom.document.addEventListener = (...args) => { documentListenerCalls += 1; return originalAdd?.apply(dom.document, args); };
  try {
    const context = attachNoteContext({
      outgoingHost: outgoing.host,
      incomingHost: incoming.host,
      openNote: () => {},
      fetchImpl: async () => jsonResponse({ links: [] }),
    });
    await context.setDocument({ path: "Target.md" });
    assert.equal(documentListenerCalls, 0);
    context.destroy();
  } finally {
    dom.document.addEventListener = originalAdd;
  }

  const source = await fs.readFile(new URL("../frontend/app/features/context/attach-note-context.js", import.meta.url), "utf8");
  assert.equal(/document\s*\.\s*addEventListener|window\s*\.\s*addEventListener/.test(source), false);
  assert.equal(/innerHTML/.test(source), false);
});

test("wireContextSection is a no-op without the shell header markup", () => {
  const section = wireContextSection({ header: null, listHost: null });
  assert.equal(section.isCollapsed(), false);
  section.setCollapsed(true);
  assert.equal(section.isCollapsed(), false);
  section.destroy();
});
