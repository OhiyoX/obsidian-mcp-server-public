// B4 integration: Base document navigation state machine (documentKind).
//
// Exercises the real document session, the real Base surface controller (with a
// controlled fetch queue) and the extracted chrome/navigation modules. No app.js
// bootstrap is required, so the dirty/abort/history boundaries are deterministic.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createDocumentSession } from "../frontend/app/features/session/index.js";
import { createSessionStatusPresenter } from "../frontend/app/features/session/status-presenter.js";
import { createBaseNavigation, DIRTY_BASE_CONFIRM } from "../frontend/app/features/navigation/base-navigation.js";
import { readInitialBaseTarget } from "../frontend/app/features/bases/document-kind.js";

const harness = createDomHarness();
harness.install();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeFetchQueue() {
  const calls = [];
  const pending = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    const next = pending.shift();
    if (!next) throw new Error(`unexpected fetch call: ${url}`);
    return next.promise;
  };
  return { fetchImpl, calls, enqueue: () => { const item = deferred(); pending.push(item); return item; } };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function basePage(overrides = {}) {
  return {
    vaultId: "vault-1",
    path: "Notes/Project.base",
    route: "/app/base/Notes%2FProject.base",
    revision: "rev-1",
    views: [{ name: "Table", type: "table" }],
    view: { name: "Table", type: "table" },
    columns: [{ key: "name", label: "Name", kind: "string" }],
    rows: [{ path: "Notes/A.md", values: { name: "A" } }],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false, grouping: false, aggregation: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
    ...overrides,
  };
}

function setup({ dirty = false, confirmResult = true } = {}) {
  const doc = harness.document;
  const documentHost = doc.createElement("section");
  documentHost.className = "document";
  const editorHost = doc.createElement("div");
  editorHost.className = "editor";
  const preview = doc.createElement("article");
  preview.className = "preview";
  documentHost.appendChild(editorHost);
  documentHost.appendChild(preview);

  const controls = {
    save: doc.createElement("button"),
    modeToggles: [doc.createElement("button"), doc.createElement("button")],
    publishButtons: [doc.createElement("button"), doc.createElement("button")],
    copyButtons: [doc.createElement("button")],
    topbarStatus: doc.createElement("div"),
    documentActionsChrome: doc.createElement("div"),
  };
  controls.modeToggles[0].disabled = false;
  const pathLabel = doc.createElement("span");
  pathLabel.textContent = "Notes/Dirty.md";

  const state = { path: null, vaultId: "vault-1", documentKind: null, mode: "preview" };
  const session = createDocumentSession();
  const ticket = session.beginOpen({ vaultId: "vault-1", path: "Notes/Dirty.md" });
  session.commitOpen(ticket, { content: "old", revision: "r1", path: "Notes/Dirty.md" });
  if (dirty) session.noteLocalEdit("edited");
  state.path = session.path;
  state.documentKind = "note";

  const queue = makeFetchQueue();
  const commits = [];
  const confirms = [];
  const errors = [];
  const outlineCalls = { clear: 0, refresh: 0 };
  const abortNoteOpen = { count: 0 };
  const abortRefresh = { count: 0 };
  const save = controls.save;
  const status = doc.createElement("span");
  const conflictBar = { render() {} };
  const syncStatus = createSessionStatusPresenter({
    state, session, save, status, conflictBar, isVaultSwitching: () => false,
  });

  const nav = createBaseNavigation({
    state,
    session,
    api: async () => { throw new Error("api must not be used when fetchImpl is injected"); },
    toast: (message, isError) => errors.push({ message, isError }),
    confirm: (message) => { confirms.push(message); return confirmResult; },
    documentHost,
    editorHost,
    preview,
    controls,
    pathLabel,
    fetchImpl: queue.fetchImpl,
    commit: (data, mode) => { commits.push({ data, mode }); return true; },
    openNote: () => true,
    abortNoteOpen: () => { abortNoteOpen.count += 1; },
    abortRefresh: () => { abortRefresh.count += 1; },
    isVaultSwitching: () => false,
    clearOutline: () => { outlineCalls.clear += 1; },
    refreshOutline: () => { outlineCalls.refresh += 1; },
    syncStatus,
  });

  return { doc, documentHost, editorHost, preview, controls, pathLabel, state, session, queue, commits, confirms, errors, abortNoteOpen, abortRefresh, outlineCalls, nav, host: nav.getHost(), save, status };
}

test("dirty note → Base cancel changes nothing and sends no request", async () => {
  const ctx = setup({ dirty: true, confirmResult: false });
  const before = {
    path: ctx.state.path,
    kind: ctx.state.documentKind,
    live: ctx.session.liveText,
    dirty: ctx.session.isDirty(),
  };
  const opened = await ctx.nav.openBase({ path: "Notes/Project.base" });
  assert.equal(opened, false);
  assert.deepEqual(ctx.confirms, [DIRTY_BASE_CONFIRM]);
  assert.equal(ctx.queue.calls.length, 0);
  assert.equal(ctx.commits.length, 0);
  assert.equal(ctx.abortNoteOpen.count, 0);
  assert.equal(ctx.state.path, before.path);
  assert.equal(ctx.state.documentKind, before.kind);
  assert.equal(ctx.session.liveText, before.live);
  assert.equal(ctx.session.isDirty(), before.dirty);
  assert.equal(ctx.host.hidden, true);
  assert.equal(ctx.editorHost.hidden, false);
});

test("dirty note → Base confirm switches identity, clears local bytes, then commits history", async () => {
  const ctx = setup({ dirty: true, confirmResult: true });
  const call = ctx.queue.enqueue();
  const promise = ctx.nav.openBase({ path: "Notes/Project.base" });
  // Surface switched before the request resolved.
  assert.equal(ctx.state.documentKind, "base");
  assert.equal(ctx.host.hidden, false);
  assert.equal(ctx.editorHost.hidden, true);
  assert.equal(ctx.preview.hidden, true);
  assert.equal(ctx.save.disabled, true);
  // Base hides the Markdown-only chrome, not just disables it (TODO §4.2/§15.7).
  assert.equal(ctx.save.hidden, true);
  assert.ok(ctx.controls.modeToggles.every((node) => node.hidden === true));
  assert.ok(ctx.controls.publishButtons.every((node) => node.hidden === true));
  assert.ok(ctx.controls.copyButtons.every((node) => node.hidden === true));
  assert.equal(ctx.controls.topbarStatus.hidden, true);
  assert.equal(ctx.controls.documentActionsChrome.hidden, true);
  assert.equal(ctx.commits.length, 0);
  call.resolve(response(200, basePage()));
  assert.equal(await promise, true);
  assert.equal(ctx.state.path, "Notes/Project.base");
  assert.equal(ctx.state.documentKind, "base");
  assert.equal(ctx.session.isDirty(), false);
  assert.equal(ctx.commits.length, 1);
  assert.equal(ctx.commits[0].data.documentKind, "base");
  assert.equal(ctx.commits[0].data.path, "Notes/Project.base");
  // The committed route carries the view override (deep-linkable URL state).
  assert.equal(ctx.commits[0].data.route, "/app/base/Notes%2FProject.base?view=Table");
  assert.equal(ctx.commits[0].mode, "push");
  assert.equal(ctx.abortNoteOpen.count, 1);
  assert.equal(ctx.abortRefresh.count, 1);
});

test("Base request failure preserves the original dirty Markdown document", async () => {
  const ctx = setup({ dirty: true, confirmResult: true });
  const call = ctx.queue.enqueue();
  const promise = ctx.nav.openBase({ path: "Notes/Project.base" });
  call.resolve(response(503, { error: "Base catalog is not ready.", code: "catalog_not_ready" }));
  assert.equal(await promise, false);
  assert.equal(ctx.queue.calls.length, 1);
  assert.equal(ctx.commits.length, 0);
  // Identity and unsaved bytes restored; no blank half-switch.
  assert.equal(ctx.state.path, "Notes/Dirty.md");
  assert.equal(ctx.state.documentKind, "note");
  assert.equal(ctx.session.isDirty(), true);
  assert.equal(ctx.host.hidden, true);
  assert.equal(ctx.editorHost.hidden, false);
  assert.equal(ctx.preview.hidden, false);
  assert.ok(ctx.errors.length >= 1);
});

test("rapid Base A/B switch: the late A response never contaminates B", async () => {
  const ctx = setup({ dirty: false });
  const a = ctx.queue.enqueue();
  const b = ctx.queue.enqueue();
  const openA = ctx.nav.openBase({ path: "A.base", route: "/app/base/A" });
  const openB = ctx.nav.openBase({ path: "B.base", route: "/app/base/B" });
  b.resolve(response(200, basePage({ path: "B.base", route: "/app/base/B", rows: [{ path: "B.md", values: { name: "B" } }] })));
  assert.equal(await openB, true);
  a.resolve(response(200, basePage({ path: "A.base", route: "/app/base/A", rows: [{ path: "A.md", values: { name: "A" } }] })));
  assert.equal(await openA, false);
  assert.equal(ctx.state.path, "B.base");
  assert.equal(ctx.commits.length, 1);
  assert.equal(ctx.commits[0].data.path, "B.base");
  assert.equal(ctx.host.querySelector(".base-surface").getAttribute("data-base-path"), "B.base");
  assert.equal(ctx.host.textContent.includes("A.base"), false);
});

test("invalidating a pending Base open (note navigation wins) fences the late response", async () => {
  const ctx = setup({ dirty: false });
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "A.base", route: "/app/base/A" });
  ctx.nav.invalidate(); // stands in for openNote fencing the Base open
  call.resolve(response(200, basePage({ path: "A.base", route: "/app/base/A" })));
  assert.equal(await open, false);
  assert.equal(ctx.commits.length, 0);
  assert.notEqual(ctx.state.path, "A.base");
});

test("the topbar path label shows the Base path and restores the note label", async () => {
  const ctx = setup({ dirty: false });
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "Notes/A.base", route: "/app/base/A" });
  assert.equal(ctx.pathLabel.textContent, "Notes/A.base");
  call.resolve(response(200, basePage({ path: "Notes/A.base", route: "/app/base/A" })));
  assert.equal(await open, true);
  assert.equal(ctx.pathLabel.textContent, "Notes/A.base");
  ctx.nav.exitToNote();
  assert.equal(ctx.pathLabel.textContent, "Notes/Dirty.md");
});

test("a note open that re-rendered the breadcrumb is not clobbered by exitToNote", async () => {
  const ctx = setup({ dirty: false });
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "Notes/A.base", route: "/app/base/A" });
  call.resolve(response(200, basePage({ path: "Notes/A.base", route: "/app/base/A" })));
  await open;
  // A real note open renders the breadcrumb before exitToNote runs.
  ctx.pathLabel.textContent = "Notes/Next.md";
  ctx.state.path = "Notes/Next.md";
  ctx.nav.exitToNote();
  assert.equal(ctx.pathLabel.textContent, "Notes/Next.md");
});

test("exitToNote restores markdown chrome, hidden state and control enablement", async () => {
  const ctx = setup({ dirty: false });
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "A.base", route: "/app/base/A" });
  assert.equal(ctx.save.disabled, true);
  assert.equal(ctx.save.hidden, true);
  assert.equal(ctx.controls.modeToggles[0].disabled, true);
  assert.equal(ctx.controls.modeToggles[0].hidden, true);
  assert.equal(ctx.controls.publishButtons[0].hidden, true);
  assert.equal(ctx.controls.copyButtons[0].hidden, true);
  assert.equal(ctx.controls.topbarStatus.hidden, true);
  assert.equal(ctx.controls.documentActionsChrome.hidden, true);
  call.resolve(response(200, basePage({ path: "A.base", route: "/app/base/A" })));
  await open;
  ctx.state.path = "Notes/Back.md";
  ctx.nav.exitToNote();
  assert.equal(ctx.state.documentKind, "note");
  assert.equal(ctx.host.hidden, true);
  assert.equal(ctx.controls.modeToggles[0].disabled, false);
  assert.equal(ctx.save.hidden, false);
  assert.equal(ctx.controls.modeToggles[0].hidden, false);
  assert.ok(ctx.controls.publishButtons.every((node) => node.hidden === false));
  assert.ok(ctx.controls.copyButtons.every((node) => node.hidden === false));
  assert.equal(ctx.controls.topbarStatus.hidden, false);
  assert.equal(ctx.controls.documentActionsChrome.hidden, false);
});

test("Ctrl+S equivalent: after Base open the save path stays disabled (no note write route)", async () => {
  const ctx = setup({ dirty: true, confirmResult: true });
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "Notes/Project.base" });
  call.resolve(response(200, basePage()));
  await open;
  assert.equal(ctx.save.disabled, true);
  // Every captured fetch is a read-only Base GET; no note POST is ever issued.
  for (const entry of ctx.queue.calls) {
    assert.match(entry.url, /^\/api\/web\/v1\/base\?/);
    assert.notEqual(entry.options?.method, "POST");
  }
});

test("entering a Base clears the note outline; a failed Base open restores it", async () => {
  const ctx = setup({ dirty: false });
  assert.equal(ctx.outlineCalls.clear, 0);
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "Notes/A.base", route: "/app/base/A" });
  // Stale note headings are dropped as soon as the surface leaves the note.
  assert.equal(ctx.outlineCalls.clear, 1);
  assert.equal(ctx.outlineCalls.refresh, 0);
  call.resolve(response(503, { error: "Base catalog is not ready.", code: "catalog_not_ready" }));
  assert.equal(await open, false);
  assert.equal(ctx.state.documentKind, "note");
  // The restored note gets its outline re-rendered by the injected callback.
  assert.equal(ctx.outlineCalls.refresh, 1);
});

test("a successful Base open never restores the note outline", async () => {
  const ctx = setup({ dirty: false });
  const call = ctx.queue.enqueue();
  const open = ctx.nav.openBase({ path: "Notes/A.base", route: "/app/base/A" });
  call.resolve(response(200, basePage({ path: "Notes/A.base", route: "/app/base/A" })));
  assert.equal(await open, true);
  assert.equal(ctx.state.documentKind, "base");
  assert.equal(ctx.outlineCalls.clear, 1);
  assert.equal(ctx.outlineCalls.refresh, 0);
});

test("a cancelled dirty navigation to Base leaves the outline untouched", async () => {
  const ctx = setup({ dirty: true, confirmResult: false });
  assert.equal(await ctx.nav.openBase({ path: "Notes/A.base" }), false);
  assert.equal(ctx.outlineCalls.clear, 0);
  assert.equal(ctx.outlineCalls.refresh, 0);
});

test("a failed Base-to-Base switch keeps the cleared outline (still on a Base)", async () => {
  const ctx = setup({ dirty: false });
  const first = ctx.queue.enqueue();
  const openA = ctx.nav.openBase({ path: "A.base", route: "/app/base/A" });
  first.resolve(response(200, basePage({ path: "A.base", route: "/app/base/A" })));
  assert.equal(await openA, true);
  const second = ctx.queue.enqueue();
  const openB = ctx.nav.openBase({ path: "B.base", route: "/app/base/B" });
  second.resolve(response(503, { error: "Base catalog is not ready.", code: "catalog_not_ready" }));
  assert.equal(await openB, false);
  assert.equal(ctx.state.documentKind, "base");
  assert.equal(ctx.outlineCalls.clear, 2);
  assert.equal(ctx.outlineCalls.refresh, 0);
});

test("the api client adapter maps Base DTO and errors into the A4 fetch contract", async () => {
  const doc = harness.document;
  const state = { path: null, vaultId: "vault-1", documentKind: null };
  const session = createDocumentSession();
  const calls = [];
  let mode = "ok";
  const api = async (url) => {
    calls.push(url);
    if (mode === "ok") return basePage();
    const error = new Error("Base catalog is not ready.");
    error.status = 503;
    error.code = "catalog_not_ready";
    throw error;
  };
  const nav = createBaseNavigation({
    state,
    session,
    api,
    toast: () => {},
    documentHost: doc.createElement("section"),
    editorHost: doc.createElement("div"),
    preview: doc.createElement("article"),
    commit: () => true,
    openNote: () => true,
    syncStatus: () => {},
  });
  assert.equal(await nav.openBase({ path: "A.base" }), true);
  assert.equal(state.path, "Notes/Project.base");
  assert.match(calls[0], /^\/api\/web\/v1\/base\?path=A\.base/);
  mode = "fail";
  assert.equal(await nav.openBase({ path: "B.base" }), false);
  assert.equal(calls.length, 2);
});

test("status presenter never lets the note session overwrite an open Base identity", () => {
  const state = { path: "Notes/Base.base", vaultId: "vault-1", documentKind: "base", revision: null, dirty: false, deleted: false, conflict: null };
  const session = createDocumentSession();
  const ticket = session.beginOpen({ vaultId: "vault-1", path: "Notes/Old.md" });
  session.commitOpen(ticket, { content: "x", revision: "r", path: "Notes/Old.md" });
  session.noteLocalEdit("dirty");
  const save = { disabled: false };
  const status = { textContent: "尚未保存" };
  const presenter = createSessionStatusPresenter({
    state, session, save, status, conflictBar: { render() {} }, isVaultSwitching: () => false,
  });
  presenter(session.statusFlags());
  assert.equal(state.path, "Notes/Base.base");
  assert.equal(state.documentKind, "base");
  assert.equal(save.disabled, true);
  assert.equal(status.textContent, "");
});

test("readInitialBaseTarget reads the deep-link meta and encoded route", () => {
  const doc = harness.document;
  const pathMeta = doc.createElement("meta");
  pathMeta.setAttribute("name", "initial-base-path");
  pathMeta.setAttribute("content", "Notes/Project.base");
  const vaultMeta = doc.createElement("meta");
  vaultMeta.setAttribute("name", "initial-base-vault");
  vaultMeta.setAttribute("content", "vault-1");
  doc.head.appendChild(pathMeta);
  doc.head.appendChild(vaultMeta);
  const target = readInitialBaseTarget(doc, {
    pathname: "/app/base/Notes%2FProject.base",
    search: "?view=Table",
    origin: "https://example.test",
  });
  assert.deepEqual(target, {
    path: "Notes/Project.base",
    vaultId: "vault-1",
    route: "/app/base/Notes%2FProject.base",
    view: "Table",
  });
  assert.equal(readInitialBaseTarget(createDomHarness().document, { pathname: "/app" }), null);
});
