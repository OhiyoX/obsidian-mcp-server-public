// Frontend tests for the note-context unlinked-mentions section (U2 desktop parity).
//
// Real DOM harness + injected dependencies. Covers the state machine, the excerpt
// highlight rendering (numeric ranges, never raw HTML), the chip-to-candidate hand-off
// and untrusted-text safety.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { UNLINKED_MESSAGES, createUnlinkedMentions } from "../frontend/app/features/context/unlinked.js";
import { attachNoteContext } from "../frontend/app/features/context/attach-note-context.js";

const dom = createDomHarness();
dom.install();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function hostFixture() {
  const host = dom.createElement("nav");
  host.id = "unlinked-list";
  return host;
}

const ENTRY = {
  line: 3,
  excerpt: "Plain Architecture mention and README.",
  highlights: [
    { start: 6, end: 18 },
    { start: 31, end: 37 },
  ],
  chips: [
    { name: "Architecture", path: "Architecture.md" },
    { name: "README", path: "README.md" },
  ],
};

function rows(host) {
  return host.querySelectorAll(".unlinked-item");
}

test("the section starts on its idle hint", () => {
  const host = hostFixture();
  const controller = createUnlinkedMentions({ host, fetchUnlinked: async () => ({ mentions: [] }) });
  assert.equal(controller.getState().status, "idle");
  assert.match(host.textContent, /打开笔记后显示潜在的链接/);
});

test("an entry renders the excerpt with highlighted matches and one chip per candidate", async () => {
  const host = hostFixture();
  const count = dom.createElement("span");
  const controller = createUnlinkedMentions({
    host,
    countHost: count,
    fetchUnlinked: async () => ({ mentions: [ENTRY] }),
  });
  await controller.setDocument({ path: "Target.md" });

  assert.equal(count.textContent, "1");
  assert.equal(rows(host).length, 1);
  const row = rows(host)[0];
  assert.equal(row.dataset.line, "3");

  // The excerpt text is split into text nodes and highlighted runs, with no HTML sink.
  assert.equal(row.querySelector(".unlinked-excerpt").textContent, ENTRY.excerpt);
  const marks = row.querySelectorAll(".unlinked-hit");
  assert.equal(marks.length, 2);
  assert.deepEqual(marks.map((mark) => mark.textContent), ["Architecture", "README"]);

  const chips = row.querySelectorAll(".unlinked-chip");
  assert.equal(chips.length, 2);
  assert.deepEqual(chips.map((chip) => chip.querySelector(".unlinked-chip-name").textContent), ["Architecture", "README"]);
  assert.deepEqual(chips.map((chip) => chip.title), ["Architecture.md", "README.md"]);
  // Every chip carries the chain icon (the shared sprite symbol).
  for (const chip of chips) {
    assert.equal(chip.querySelector("use").getAttribute("href"), "/app/assets/icons.svg#link");
  }
});

test("a chip click opens its specific candidate note", async () => {
  const host = hostFixture();
  const opened = [];
  const controller = createUnlinkedMentions({
    host,
    fetchUnlinked: async () => ({
      mentions: [{
        line: 9,
        excerpt: "README",
        highlights: [{ start: 0, end: 6 }],
        chips: [{ name: "README", path: "README.md" }, { name: "README", path: "Sub/README.md" }],
      }],
    }),
    openNote: (path) => opened.push(path),
  });
  await controller.setDocument({ path: "Target.md" });
  const chips = rows(host)[0].querySelectorAll(".unlinked-chip");
  chips[1].click();
  assert.deepEqual(opened, ["Sub/README.md"]);
});

test("an empty mention list is an explicit empty state", async () => {
  const host = hostFixture();
  const controller = createUnlinkedMentions({ host, fetchUnlinked: async () => ({ mentions: [] }) });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(controller.getState().status, "empty");
  assert.equal(host.textContent, UNLINKED_MESSAGES.empty);
});

test("a failed load renders an error state and retry refetches", async () => {
  const host = hostFixture();
  let attempt = 0;
  const controller = createUnlinkedMentions({
    host,
    fetchUnlinked: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom with /absolute/path");
      return { mentions: [ENTRY] };
    },
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(controller.getState().status, "error");
  assert.match(host.textContent, /潜在的链接加载失败/);
  assert.equal(host.textContent.includes("/absolute/path"), false, "server error text must not be rendered");
  host.querySelector(".unlinked-retry").click();
  await tick();
  await tick();
  assert.equal(attempt, 2);
  assert.equal(rows(host).length, 1);
});

test("Base and clear reset the section", async () => {
  const host = hostFixture();
  const count = dom.createElement("span");
  const controller = createUnlinkedMentions({ host, countHost: count, fetchUnlinked: async () => ({ mentions: [ENTRY] }) });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(count.textContent, "1");

  await controller.setDocument({ path: "Table.base", documentKind: "base" });
  assert.equal(host.textContent, "Base 文档没有潜在的链接");
  assert.equal(count.textContent, "0");

  controller.clear();
  assert.equal(host.textContent, "打开笔记后显示潜在的链接");
  assert.equal(controller.getState().status, "idle");
});

test("excerpts and chip names are rendered as untrusted text (no HTML injection)", async () => {
  const host = hostFixture();
  const payload = '<img src=x onerror="globalThis.pwned=true">';
  const controller = createUnlinkedMentions({
    host,
    fetchUnlinked: async () => ({
      mentions: [{
        line: 1,
        excerpt: `${payload} mention`,
        highlights: [{ start: 0, end: payload.length }],
        chips: [{ name: payload, path: `${payload}.md` }],
      }],
    }),
  });
  await controller.setDocument({ path: "Target.md" });
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.textContent.includes(payload), true);
  assert.equal(globalThis.pwned, undefined);
});

test("the module registers no global listeners and has no raw-HTML sink", async () => {
  const source = await fs.readFile(new URL("../frontend/app/features/context/unlinked.js", import.meta.url), "utf8");
  for (const forbidden of ["core/app.js", "features/editor", "features/explorer", "features/navigation"]) {
    assert.equal(source.includes(forbidden), false, `unlinked.js must not reference ${forbidden}`);
  }
  assert.equal(/document\s*\.\s*addEventListener|window\s*\.\s*addEventListener/.test(source), false);
  assert.equal(/innerHTML/.test(source), false);
});

test("the shell markup carries the unlinked section under the outgoing list", async () => {
  const { appPage } = await import("../src/app/pages.js");
  const page = appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});
  const anchor = page.indexOf('data-context-section="unlinked"');
  assert.ok(anchor > 0, "the shell must contain the unlinked section header");
  const header = page.slice(page.lastIndexOf("<header", anchor), page.indexOf("</header>", anchor) + "</header>".length);
  assert.match(header, /<span class="context-title">当前笔记中潜在的链接<\/span>/);
  assert.match(header, /data-context-count="unlinked"/);
  assert.equal(header.includes("context-section-menu-toggle"), false, "the unlinked section has no ⋮ of its own");
  const navAnchor = page.indexOf('id="unlinked-list"');
  const nav = page.slice(page.lastIndexOf("<nav", navAnchor), page.indexOf("</nav>", navAnchor) + "</nav>".length);
  assert.match(nav, /aria-label="当前笔记中潜在的链接"/);
  assert.ok(navAnchor > page.indexOf('id="outgoing-list"'), "the unlinked section comes after the link list");
});

test("attachNoteContext wires the unlinked section from the shared call site", async () => {
  const root = dom.createElement("aside");
  const header = dom.createElement("header");
  header.className = "context-header context-section-header";
  header.setAttribute("data-context-section", "unlinked");
  const count = dom.createElement("span");
  count.className = "context-section-count";
  count.textContent = "0";
  header.append(count);
  const host = dom.createElement("nav");
  host.id = "unlinked-list";
  root.append(header, host);
  dom.document.body.replaceChildren(root);

  const requests = [];
  const context = attachNoteContext({
    outgoingHost: null,
    incomingHost: null,
    openNote: () => {},
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/unlinked")) return jsonResponse({ mentions: [ENTRY] });
      return jsonResponse({ links: [] });
    },
  });
  await context.setDocument({ path: "Target.md" });
  assert.deepEqual(requests, [
    "/api/web/v1/note-context/outgoing?path=Target.md",
    "/api/web/v1/note-context/incoming?path=Target.md",
    "/api/web/v1/note-context/unlinked?path=Target.md",
  ]);
  assert.equal(count.textContent, "1", "unlinked count == rendered entries");
  assert.equal(rows(host).length, 1);
  context.destroy();
});

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}
