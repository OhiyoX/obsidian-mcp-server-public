// Task 7 — the Explorer rename row and the safe delete, driven through the controller.
//
// The brief sketches a `mountController` helper and `new doc.defaultView.KeyboardEvent(...)`;
// this file uses the repo's own DOM harness instead (the shape `explorer-context-menu.test.js`
// uses), so every assertion runs through the real listeners, the real rows `tree.js` renders
// and the real draft row `create-draft.js` paints.
//
// What the controller owns here: `rename(target)` opens a rename draft prefilled with the
// current name and posts `{ path, to, mutationId }` on Enter; an unchanged name writes nothing;
// a conflict reopens the row; `removeEntry(target)` asks the injected confirm, posts
// `{ path, confirm: true }`, closes the deleted note and repaints. The context menu (F2 and the
// two items) is wired to the same two seams by the controller itself.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";

class HarnessEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.target = undefined;
    this.defaultPrevented = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

// The fixture rows use the classes `tree.js` really renders.
const baseName = (path) => String(path).split("/").pop();

function treeLevels() {
  return new Map([
    ["", [
      { kind: "directory", path: "Folder", name: "Folder" },
      { kind: "note", path: "Top.md", title: "Top" },
    ]],
    ["Folder", [{ kind: "note", path: "Folder/Child.md", title: "Child" }]],
  ]);
}

const parentOf = (path) => {
  const cut = String(path).lastIndexOf("/");
  return cut === -1 ? "" : String(path).slice(0, cut);
};

function buildHarness({ path = null } = {}) {
  const harness = createDomHarness();
  harness.install();
  globalThis.CSS = { escape: (value) => String(value) };
  const document = harness.document;
  document.defaultView = { KeyboardEvent: HarnessEvent, MouseEvent: HarnessEvent };
  const host = document.createElement("div");
  document.body.append(host);
  let markup = "";
  Object.defineProperty(host, "innerHTML", {
    get: () => markup,
    set: (value) => {
      markup = String(value ?? "");
      if (markup === "") host.replaceChildren();
    },
  });

  const state = { path, query: "", searchCollapsed: new Set(), semantic: false, caseSensitive: false, vaultId: "v1" };
  const posts = [];
  const toasts = [];
  const opened = [];
  const welcomed = [];
  const moved = [];
  const confirmations = [];
  const levels = treeLevels();
  let failure = null;
  let confirmAnswer = true;
  let reply = null;

  // The default reply mirrors the server: the level this path belongs to now serves the new
  // name, so the repaint after `tree.invalidate()` really shows it.
  function defaultReply(url, body) {
    const level = parentOf(body.path);
    const items = levels.get(level) ?? [];
    if (url.endsWith("/rename")) {
      levels.set(level, items.map((item) => (item.path === body.path
        ? { ...item, path: body.to, name: baseName(body.to), title: baseName(body.to) }
        : item)));
      return { kind: "note", from: body.path, to: body.to, updatedLinksIn: [] };
    }
    levels.set(level, items.filter((item) => item.path !== body.path));
    return { kind: "note", deleted: body.path, trash: "2026-11-07T00-00-00-000Z-abc" };
  }

  const api = async (url, options = {}) => {
    if ((options?.method ?? "GET") === "POST") {
      const body = options.body ? JSON.parse(options.body) : null;
      const pathname = new URL(url, "http://test").pathname;
      posts.push({ url: pathname, method: options.method, body });
      if (failure) throw failure;
      return reply ? reply(pathname, body) : defaultReply(pathname, body);
    }
    if (url.includes("/api/web/v2/search")) {
      return { items: [], nextCursor: null, semantic: { used: false }, catalog: { generation: 7, stale: false } };
    }
    const parent = new URL(url, "http://test").searchParams.get("parent") ?? "";
    return { parent, items: levels.get(parent) ?? [], nextCursor: null, catalog: { generation: 7, stale: false } };
  };

  const controller = createExplorerController({
    state,
    host,
    searchHost: null,
    statusHost: null,
    filesStatusHost: null,
    api,
    toast: (text, isError) => toasts.push({ text: String(text), isError: Boolean(isError) }),
    escapeHtml: (value) => String(value),
    openNote: (...args) => opened.push(args.length === 1 ? args[0] : args),
    createNote: () => true,
    openBase: () => {},
    openFile: () => {},
    enterWelcome: () => { welcomed.push(true); return true; },
    pathMoved: (from, to) => moved.push({ from, to }),
    confirm: (message) => { confirmations.push(message); return confirmAnswer; },
  });

  return {
    ...harness,
    document,
    host,
    state,
    controller,
    posts,
    toasts,
    opened,
    welcomed,
    moved,
    confirmations,
    input: () => host.querySelector(".note-create-input"),
    row: (target) => [...host.querySelectorAll("button.note")].find((row) => row.dataset.path === target) ?? null,
    setFailure: (error) => { failure = error; },
    setReply: (fn) => { reply = fn; },
    setConfirm: (value) => { confirmAnswer = value; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// A commit awaits the POST and the level refresh the success path issues.
const settle = async () => { for (let index = 0; index < 6; index += 1) await tick(); };

// A real user types before Enter; the draft row keeps its value from the `input` event.
function type(chrome, value) {
  const input = chrome.input();
  input.value = value;
  input.dispatchEvent({ type: "input" });
}

function enter(chrome) {
  chrome.input().dispatchEvent(new chrome.document.defaultView.KeyboardEvent("keydown", { key: "Enter" }));
}

// The harness dispatches at one node and does not bubble; a browser bubbles `contextmenu`
// from the row up to the host that delegates it (same fixture as the task 6 suite).
function dispatchBubbling(node, event) {
  for (let current = node; current; current = current.parentNode) current.dispatchEvent(event);
}

test("a rename draft prefills the current name and posts to /api/web/v1/rename on Enter", async () => {
  const chrome = buildHarness({ path: "Top.md" });
  await chrome.controller.load("");

  assert.equal(await chrome.controller.rename({ kind: "note", path: "Top.md" }), true);
  const input = chrome.input();
  assert.equal(input.value, "Top.md", "the row starts on the current name");
  assert.equal(input.placeholder, "新名称");
  assert.equal(input.getAttribute("aria-label"), "重命名笔记");

  type(chrome, "Home.md");
  enter(chrome);
  await settle();

  assert.equal(chrome.posts.length, 1, "one rename request");
  assert.equal(chrome.posts[0].url, "/api/web/v1/rename");
  assert.deepEqual({ path: chrome.posts[0].body.path, to: chrome.posts[0].body.to }, { path: "Top.md", to: "Home.md" });
  assert.match(chrome.posts[0].body.mutationId, /^web-rename:/, "the client mints the rename mutation id");
  assert.equal(Object.keys(chrome.posts[0].body).length, 3, "the body is path, to and mutationId");
  assert.deepEqual(chrome.toasts, [{ text: "已重命名为 Home.md", isError: false }]);
  assert.equal(chrome.state.path, "Home.md", "the open note follows the rename");
  assert.deepEqual(chrome.opened, [], "a rename never opens the note");
  assert.equal(chrome.input(), null, "the row is gone after the commit");
  assert.ok(chrome.row("Home.md"), "the repainted tree shows the new name");
});

test("a folder rename keeps its place and reports the rewritten links", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.setReply(() => ({ kind: "folder", from: "Folder", to: "New", updatedLinksIn: ["A.md", "B.md"] }));

  await chrome.controller.rename({ kind: "folder", path: "Folder" });
  const input = chrome.input();
  assert.equal(input.value, "Folder");
  assert.equal(input.getAttribute("aria-label"), "重命名文件夹");
  type(chrome, "New");
  enter(chrome);
  await settle();

  assert.deepEqual({ path: chrome.posts[0].body.path, to: chrome.posts[0].body.to }, { path: "Folder", to: "New" });
  assert.deepEqual(chrome.toasts.map((toast) => toast.text), [
    "已重命名为 New",
    "另更新了 2 个笔记里的链接",
  ]);
});

test("a nested rename stays in its own folder", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  await chrome.controller.ensureTreeExpanded("Folder");
  chrome.controller.render();
  assert.ok(chrome.row("Folder/Child.md"), "the nested row is rendered");

  await chrome.controller.rename({ kind: "note", path: "Folder/Child.md" });
  type(chrome, "Renamed.md");
  enter(chrome);
  await settle();

  assert.deepEqual({ path: chrome.posts[0].body.path, to: chrome.posts[0].body.to }, { path: "Folder/Child.md", to: "Folder/Renamed.md" });
});

test("a folder rename carries the note open inside it", async () => {
  const chrome = buildHarness({ path: "Folder/Child.md" });
  await chrome.controller.load("");
  await chrome.controller.ensureTreeExpanded("Folder");
  chrome.controller.render();
  chrome.setReply(() => ({ kind: "folder", from: "Folder", to: "New", updatedLinksIn: [] }));

  await chrome.controller.rename({ kind: "folder", path: "Folder" });
  type(chrome, "New");
  enter(chrome);
  await settle();

  assert.equal(chrome.state.path, "New/Child.md", "the open note follows its folder");
  assert.deepEqual(chrome.moved, [{ from: "Folder", to: "New" }], "the session appends the suffix itself, once");
});

test("a folder rename that rewrote the open note's links reloads it", async () => {
  const chrome = buildHarness({ path: "Folder/Child.md" });
  await chrome.controller.load("");
  await chrome.controller.ensureTreeExpanded("Folder");
  chrome.controller.render();
  // The server lists the moved note when it rewrote links inside it.
  chrome.setReply(() => ({ kind: "folder", from: "Folder", to: "New", updatedLinksIn: ["New/Child.md"] }));

  await chrome.controller.rename({ kind: "folder", path: "Folder" });
  type(chrome, "New");
  enter(chrome);
  await settle();

  assert.deepEqual(chrome.moved, [{ from: "Folder", to: "New" }], "the identity moves first");
  assert.deepEqual(chrome.opened, [["New/Child.md", { reason: "moved" }]], "then the changed bytes reload");
});

test("a folder delete closes the note open inside it", async () => {
  const chrome = buildHarness({ path: "Folder/Child.md" });
  await chrome.controller.load("");
  await chrome.controller.removeEntry({ kind: "folder", path: "Folder" });

  assert.deepEqual(chrome.welcomed, [true], "the deleted note leaves the editor");
});

test("Enter on an unchanged name writes nothing and closes the row", async () => {
  const chrome = buildHarness({ path: "Top.md" });
  await chrome.controller.load("");
  await chrome.controller.rename({ kind: "note", path: "Top.md" });

  enter(chrome);
  await settle();

  assert.deepEqual(chrome.posts, [], "an unchanged name is not a rename");
  assert.deepEqual(chrome.toasts, []);
  assert.equal(chrome.input(), null, "the abandoned row is closed");
  assert.equal(chrome.controller.hasActiveDraft(), false);
  assert.equal(chrome.state.path, "Top.md");
});

test("a conflict answers 409 and reopens the row with the conflict message", async () => {
  const chrome = buildHarness({ path: "Top.md" });
  await chrome.controller.load("");
  chrome.setFailure({ status: 409, message: "Destination exists" });
  await chrome.controller.rename({ kind: "note", path: "Top.md" });
  type(chrome, "Home.md");
  enter(chrome);
  await settle();

  assert.equal(chrome.posts.length, 1, "the refused rename is not retried behind the user");
  assert.deepEqual(chrome.toasts, [{ text: "同名笔记或文件夹已存在", isError: true }]);
  const reopened = chrome.input();
  assert.ok(reopened, "the row comes back for the retry");
  assert.equal(reopened.value, "Home.md", "the typed name is preserved");
  assert.equal(chrome.document.activeElement, reopened, "the focus returns for the retry");
  assert.equal(chrome.state.path, "Top.md", "a refused rename leaves the open note alone");
});

test("a delete asks once, posts confirm:true and closes the deleted note", async () => {
  const chrome = buildHarness({ path: "Top.md" });
  await chrome.controller.load("");

  chrome.setConfirm(false);
  assert.equal(await chrome.controller.removeEntry({ kind: "note", path: "Top.md" }), false);
  assert.deepEqual(chrome.posts, [], "a declined confirm writes nothing");
  assert.deepEqual(chrome.confirmations, ["将「Top.md」移到回收站？可以还原。"]);

  chrome.setConfirm(true);
  assert.equal(await chrome.controller.removeEntry({ kind: "note", path: "Top.md" }), true);
  assert.equal(chrome.posts.length, 1);
  assert.equal(chrome.posts[0].url, "/api/web/v1/delete");
  assert.deepEqual(chrome.posts[0].body, { path: "Top.md", confirm: true });
  assert.deepEqual(chrome.toasts, [{ text: "已移到回收站：Top.md", isError: false }]);
  assert.deepEqual(chrome.welcomed, [true], "the deleted note leaves the editor");
  assert.equal(chrome.row("Top.md"), null, "the row goes away");
});

test("F2 and the menu items run the same two seams", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");

  const row = chrome.row("Top.md");
  row.focus();
  chrome.host.dispatchEvent(new chrome.document.defaultView.KeyboardEvent("keydown", { key: "F2" }));
  assert.equal(chrome.input()?.value, "Top.md", "F2 opens the rename row on the focused row");
  chrome.input().dispatchEvent(new chrome.document.defaultView.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(chrome.input(), null, "Escape cancels the rename without a write");

  dispatchBubbling(chrome.row("Top.md"), new chrome.document.defaultView.MouseEvent("contextmenu", { clientX: 8, clientY: 8 }));
  const popup = chrome.document.querySelector(".tree-context-menu");
  assert.equal(popup.hidden, false, "a right click opens the menu");
  popup.dispatchEvent({ type: "click", target: popup.querySelector('[data-menu-action="rename"]') });
  assert.equal(chrome.input()?.value, "Top.md", "the rename item opens the rename row");
  chrome.input().dispatchEvent(new chrome.document.defaultView.KeyboardEvent("keydown", { key: "Escape" }));

  dispatchBubbling(chrome.row("Top.md"), new chrome.document.defaultView.MouseEvent("contextmenu", { clientX: 8, clientY: 8 }));
  popup.dispatchEvent({ type: "click", target: popup.querySelector('[data-menu-action="delete"]') });
  await settle();
  assert.deepEqual(chrome.posts.map((post) => post.url), ["/api/web/v1/delete"], "the delete item posts through the controller");
});

test("destroy tears the menu popup down with the controller", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  assert.ok(chrome.document.querySelector(".tree-context-menu"));
  chrome.controller.destroy();
  assert.equal(chrome.document.querySelector(".tree-context-menu"), null, "destroy removes the menu");
});
