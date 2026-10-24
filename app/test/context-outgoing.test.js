// Frontend tests for the context sidebar outgoing-links section (Phase 2).
//
// Real DOM harness (test/helpers/base-dom.mjs) + injected dependencies. Covers
// the loading/empty/error state machine, document switching (including Base <->
// note), navigation hand-off to the existing openNote/asset/external paths, and
// untrusted-text rendering safety.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  createOutgoingLinks,
  defaultAssetUrl,
  safeExternalUrl,
} from "../frontend/app/features/context/outgoing.js";

const dom = createDomHarness();
dom.install();

const NOTE_ITEM = { target: "Target", kind: "note", resolvedPath: "Target.md", alias: null, heading: null };

function hostFixture() {
  const host = dom.createElement("nav");
  host.id = "outgoing-list";
  return host;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function linkRows(host) {
  return host.querySelectorAll(".outgoing-item");
}

test("initial state is the idle hint", () => {
  const host = hostFixture();
  const controller = createOutgoingLinks({ host, fetchOutgoing: async () => ({ links: [] }) });
  assert.equal(controller.getState().status, "idle");
  assert.match(host.textContent, /打开笔记后显示出链/);
});

test("setDocument shows loading then renders ready items in order", async () => {
  const host = hostFixture();
  const calls = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async ({ path }) => {
      calls.push(path);
      return { links: [NOTE_ITEM, { target: "Missing", kind: "unresolved", resolvedPath: null, alias: null, heading: null }] };
    },
  });
  const pending = controller.setDocument({ path: "Note.md", vaultId: "vault" });
  assert.equal(controller.getState().status, "loading");
  assert.match(host.textContent, /正在加载出链/);
  await pending;
  assert.deepEqual(calls, ["Note.md"]);
  assert.equal(controller.getState().status, "ready");
  const rows = linkRows(host);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.kind, "note");
  assert.equal(rows[1].dataset.kind, "unresolved");
});

test("an empty link list is an explicit empty state", async () => {
  const host = hostFixture();
  const controller = createOutgoingLinks({ host, fetchOutgoing: async () => ({ links: [] }) });
  await controller.setDocument({ path: "Note.md" });
  assert.equal(controller.getState().status, "empty");
  // Desktop Outgoing links pane (U2): the「当前笔记中的链接」list's own empty state;
  // the second section 「当前笔记中潜在的链接」 is rendered by `unlinked.js`.
  assert.match(host.textContent, /没有链接/);
});

test("a failed load renders an error state and retry refetches", async () => {
  const host = hostFixture();
  let attempt = 0;
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom with /absolute/path");
      return { links: [NOTE_ITEM] };
    },
  });
  await controller.setDocument({ path: "Note.md" });
  assert.equal(controller.getState().status, "error");
  assert.match(host.textContent, /出链加载失败/);
  assert.equal(host.textContent.includes("/absolute/path"), false, "server error text must not be rendered");
  const retry = host.querySelector(".outgoing-retry");
  assert.ok(retry, "error state exposes a retry control");
  retry.click();
  await tick();
  await tick();
  assert.equal(attempt, 2);
  assert.equal(controller.getState().status, "ready");
  assert.equal(linkRows(host).length, 1);
});

test("clicking a resolved note hands off to the existing openNote with the heading fragment", async () => {
  const host = hostFixture();
  const opened = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({
      links: [{ target: "Other#Section", kind: "note", resolvedPath: "Other.md", alias: "别名", heading: "Section" }],
    }),
    openNote: (path, options) => opened.push({ path, ...options }),
  });
  await controller.setDocument({ path: "Note.md" });
  const row = linkRows(host)[0];
  assert.equal(row.querySelector(".outgoing-row-path").textContent, "Other");
  // The alias is only visible through the tooltip (U2 row format): `alias (path)`.
  assert.equal(row.title, "别名 (Other.md)");
  row.querySelector("button").click();
  assert.deepEqual(opened, [{ path: "Other.md", fragment: "Section" }]);
});

test("a note without a resolved path stays inert", async () => {
  const host = hostFixture();
  const opened = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({ links: [{ target: "Target", kind: "note", resolvedPath: null, alias: null, heading: null }] }),
    openNote: (path) => opened.push(path),
  });
  await controller.setDocument({ path: "Note.md" });
  const row = linkRows(host)[0];
  assert.equal(row.dataset.kind, "note");
  const button = row.querySelector("button");
  assert.equal(button, null);
  assert.deepEqual(opened, []);
});

test("clicking an asset reuses the authenticated asset route", async () => {
  const host = hostFixture();
  const opened = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({ links: [{ target: "images/pixel.png", kind: "asset", resolvedPath: null, alias: null, heading: null }] }),
    openAsset: (url, item) => opened.push({ url, target: item.target }),
  });
  await controller.setDocument({ path: "Folder/Note.md", vaultId: "vault" });
  linkRows(host)[0].querySelector("button").click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].target, "images/pixel.png");
  assert.equal(opened[0].url, "/api/web/v1/asset?path=images%2Fpixel.png&from=Folder%2FNote.md&vaultId=vault");
  assert.equal(opened[0].url, defaultAssetUrl("images/pixel.png", "Folder/Note.md", "vault"));
});

test("external links open a new window with noopener noreferrer", async () => {
  const host = hostFixture();
  const opened = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({ links: [{ target: "https://example.com/x", kind: "external", resolvedPath: null, alias: "站点", heading: null }] }),
    openExternal: (url, event) => opened.push({ url, prevented: typeof event?.preventDefault === "function" }),
  });
  await controller.setDocument({ path: "Note.md" });
  const anchor = linkRows(host)[0].querySelector("a");
  assert.equal(anchor.getAttribute("href"), "https://example.com/x");
  assert.equal(anchor.getAttribute("target"), "_blank");
  assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
  assert.equal(anchor.querySelector(".outgoing-row-path").textContent, "https://example.com/x");
  assert.equal(anchor.querySelector(".context-row-parent"), null, "external rows never grow a parent subline");
  anchor.click();
  assert.deepEqual(opened, [{ url: "https://example.com/x", prevented: true }]);
});

test("an unsafe external scheme is inert, not a link", async () => {
  const host = hostFixture();
  const opened = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({ links: [{ target: "javascript:alert(1)", kind: "external", resolvedPath: null, alias: null, heading: null }] }),
    openExternal: (url) => opened.push(url),
  });
  await controller.setDocument({ path: "Note.md" });
  const row = linkRows(host)[0];
  assert.equal(row.querySelector("a"), null);
  assert.match(row.textContent, /javascript:alert\(1\)/);
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("data:text/html,<script>"), null);
  assert.equal(safeExternalUrl("https://example.com"), "https://example.com");
  assert.equal(safeExternalUrl("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safeExternalUrl("//example.com/x"), "//example.com/x");
  assert.deepEqual(opened, []);
});

test("aliases and targets are rendered as untrusted text (no HTML injection)", async () => {
  const host = hostFixture();
  const payload = '<img src=x onerror="globalThis.pwned=true">';
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({ links: [
      { target: "Target", kind: "note", resolvedPath: "Target.md", alias: payload, heading: null },
      { target: payload, kind: "unresolved", resolvedPath: null, alias: null, heading: null },
      { target: "https://example.com", kind: "external", resolvedPath: null, alias: payload, heading: null },
    ] }),
  });
  await controller.setDocument({ path: "Note.md" });
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.querySelectorAll("a,button,span,div,li,ul").length > 0, true);
  assert.equal(host.textContent.includes(payload), true);
  assert.equal(globalThis.pwned, undefined);
});

test("switching documents refetches and ignores a stale response", async () => {
  const host = hostFixture();
  const pending = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: ({ path }) => new Promise((resolve) => pending.push({ path, resolve })),
  });
  const first = controller.setDocument({ path: "A.md" });
  const second = controller.setDocument({ path: "B.md" });
  assert.deepEqual(pending.map((item) => item.path), ["A.md", "B.md"]);
  pending[1].resolve({ links: [{ target: "B", kind: "unresolved", resolvedPath: null, alias: null, heading: null }] });
  await second;
  pending[0].resolve({ links: [{ target: "A", kind: "unresolved", resolvedPath: null, alias: null, heading: null }] });
  await first;
  assert.equal(controller.getState().path, "B.md");
  assert.deepEqual(controller.getState().items.map((item) => item.target), ["B"]);
  assert.equal(linkRows(host).length, 1);
  assert.match(linkRows(host)[0].textContent, /^B$/);
});

test("Base <-> note round trip clears and reloads the section", async () => {
  const host = hostFixture();
  const calls = [];
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async ({ path }) => {
      calls.push(path);
      return { links: [NOTE_ITEM] };
    },
  });
  await controller.setDocument({ path: "Note.md" });
  assert.equal(linkRows(host).length, 1);

  await controller.setDocument({ path: "Table.base", documentKind: "base" });
  assert.equal(controller.getState().status, "idle");
  assert.deepEqual(controller.getState().items, []);
  assert.equal(linkRows(host).length, 0);
  assert.match(host.textContent, /Base 文档没有出链/);

  await controller.setDocument({ path: "Other.md", documentKind: "note" });
  assert.deepEqual(calls, ["Note.md", "Other.md"]);
  assert.equal(controller.getState().path, "Other.md");
  assert.equal(linkRows(host).length, 1);
});

test("clear resets items and shows the idle hint", async () => {
  const host = hostFixture();
  const controller = createOutgoingLinks({ host, fetchOutgoing: async () => ({ links: [NOTE_ITEM] }) });
  await controller.setDocument({ path: "Note.md" });
  controller.clear();
  assert.deepEqual(controller.getState(), {
    status: "idle", path: null, vaultId: null, documentKind: null, items: [],
  });
  assert.match(host.textContent, /打开笔记后显示出链/);
});

test("the module registers no global listeners and imports no forbidden feature", async () => {
  const host = hostFixture();
  let documentListenerCalls = 0;
  const originalAdd = dom.document.addEventListener;
  dom.document.addEventListener = (...args) => { documentListenerCalls += 1; return originalAdd?.apply(dom.document, args); };
  try {
    const controller = createOutgoingLinks({ host, fetchOutgoing: async () => ({ links: [NOTE_ITEM] }) });
    await controller.setDocument({ path: "Note.md" });
    controller.destroy();
    assert.equal(documentListenerCalls, 0);
  } finally {
    dom.document.addEventListener = originalAdd;
  }

  const source = await fs.readFile(new URL("../frontend/app/features/context/outgoing.js", import.meta.url), "utf8");
  for (const forbidden of ["core/app.js", "features/bases", "features/explorer", "features/navigation", "app/src/app/assets"]) {
    assert.equal(source.includes(forbidden), false, `outgoing.js must not reference ${forbidden}`);
  }
  assert.equal(/document\s*\.\s*addEventListener|window\s*\.\s*addEventListener/.test(source), false);
  assert.equal(/innerHTML/.test(source), false);
});
