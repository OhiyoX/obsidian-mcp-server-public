// Controller state machine + request fencing for the read-only Base surface.
//
// Uses the dedicated DOM harness and an injected fetch queue with controllable
// promises, so out-of-order responses and aborts are deterministic (no sleeps).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";

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

function page(overrides = {}) {
  return {
    vaultId: "vault-1",
    path: "Notes/Project.base",
    route: "/app/base/Notes%2FProject.base",
    revision: "rev-1",
    views: [{ name: "Table", type: "table" }],
    view: { name: "Table", type: "table" },
    columns: [{ key: "name", label: "Name", kind: "string" }, { key: "status", label: "Status", kind: "string" }],
    rows: [{ path: "Notes/A.md", values: { name: "A", status: "active" } }],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false, grouping: false, aggregation: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
    ...overrides,
  };
}

function newSurface() {
  const host = harness.document.createElement("div");
  const queue = makeFetchQueue();
  const errors = [];
  const surface = createBaseSurface({
    host,
    fetchImpl: queue.fetchImpl,
    onOpenNote: () => {},
    onError: (error) => errors.push(error),
  });
  return { host, queue, errors, surface };
}

test("open loads the first page and exposes the frozen public state", async () => {
  const { host, queue, surface } = newSurface();
  const call = queue.enqueue();
  const result = await (() => {
    const promise = surface.open({ vaultId: "vault-1", path: "Notes/Project.base", route: "/app/base/Notes%2FProject.base", view: "Table" });
    call.resolve(response(200, page()));
    return promise;
  })();

  assert.equal(result.ok, true);
  const state = surface.getState();
  assert.equal(state.documentKind, "base");
  assert.equal(state.path, "Notes/Project.base");
  assert.equal(state.view, "Table");
  assert.deepEqual(state.columns.map((column) => column.key), ["name", "status"]);
  assert.equal(state.rows.length, 1);
  assert.equal(state.nextCursor, null);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  assert.equal(state.catalogStale, false);
  // The document URL carries the view override so a deep link / Back restores it.
  assert.equal(surface.getRoute(), "/app/base/Notes%2FProject.base?view=Table");
  assert.equal(queue.calls.length, 1);
  assert.match(queue.calls[0].url, /^\/api\/web\/v1\/base\?/);
  assert.match(queue.calls[0].url, /path=Notes%2FProject\.base/);
  assert.match(queue.calls[0].url, /view=Table/);
  assert.match(queue.calls[0].url, /limit=100/);
  assert.doesNotMatch(queue.calls[0].url, /offset|pageNumber/);
  assert.equal(host.querySelector("table").getAttribute("role"), "table");
  assert.equal(host.querySelectorAll("tbody tr").length, 1);
});

test("out-of-order open responses never contaminate the newer document", async () => {
  const { host, queue, surface } = newSurface();
  const first = queue.enqueue();
  const second = queue.enqueue();
  const openA = surface.open({ path: "A.base", route: "/app/base/A" });
  const openB = surface.open({ path: "B.base", route: "/app/base/B" });

  second.resolve(response(200, page({ path: "B.base", route: "/app/base/B", rows: [{ path: "Notes/B.md", values: { name: "B" } }] })));
  assert.equal((await openB).ok, true);

  first.resolve(response(200, page({ path: "A.base", rows: [{ path: "Notes/A.md", values: { name: "A" } }] })));
  const resultA = await openA;

  assert.equal(resultA.ok, false);
  assert.equal(resultA.error.code, "superseded");
  assert.equal(surface.getState().path, "B.base");
  assert.equal(host.querySelector(".base-surface").getAttribute("data-base-path"), "B.base");
  assert.equal(host.textContent.includes("A.base"), false);
  assert.equal(host.querySelectorAll("tbody tr").length, 1);
});

test("close aborts in-flight work, clears only the host, and ignores late responses", async () => {
  const { host, queue, surface } = newSurface();
  const call = queue.enqueue();
  const pending = surface.open({ path: "A.base", route: "/app/base/A" });
  surface.close();
  call.resolve(response(200, page()));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(surface.getState().documentKind, null);
  assert.equal(host.childNodes.length, 0);
  assert.equal(surface.getRoute(), null);
  const closed = await surface.open({ path: "B.base" });
  assert.equal(closed.ok, false);
  assert.equal(closed.error.code, "closed");
});

test("loadMore appends the next page without replacing existing rows", async () => {
  const { surface, queue, host } = newSurface();
  const first = queue.enqueue();
  const open = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  first.resolve(response(200, page({ nextCursor: "cursor-1", totalMatched: 2 })));
  assert.equal((await open).ok, true);

  const second = queue.enqueue();
  const more = surface.loadMore();
  second.resolve(response(200, page({
    rows: [{ path: "Notes/B.md", values: { name: "B", status: "active" } }],
    totalMatched: 2,
    nextCursor: null,
  })));
  assert.equal((await more).ok, true);

  const state = surface.getState();
  assert.deepEqual(state.rows.map((row) => row.path), ["Notes/A.md", "Notes/B.md"]);
  assert.equal(state.nextCursor, null);
  assert.match(queue.calls[1].url, /cursor=cursor-1/);
  assert.equal(host.querySelectorAll("tbody tr").length, 2);
  assert.equal(host.querySelector(".base-surface").getAttribute("aria-busy"), null);
});

test("409 cursor-stale restarts only the current view first page", async () => {
  const { surface, queue } = newSurface();
  const first = queue.enqueue();
  const open = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  first.resolve(response(200, page({ nextCursor: "cursor-1", totalMatched: 2 })));
  await open;

  const stale = queue.enqueue();
  const restart = queue.enqueue();
  const more = surface.loadMore();
  stale.resolve(response(409, { error: "cursor stale", code: "cursor-stale" }));
  restart.resolve(response(200, page({ rows: [{ path: "Notes/Fresh.md", values: { name: "Fresh" } }], totalMatched: 1 })));

  assert.equal((await more).ok, true);
  const state = surface.getState();
  assert.deepEqual(state.rows.map((row) => row.path), ["Notes/Fresh.md"]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.error, null);
  assert.match(queue.calls[1].url, /cursor=cursor-1/);
  assert.doesNotMatch(queue.calls[2].url, /cursor=/);
});

test("400 invalid cursor clears the cursor and reloads the first page", async () => {
  const { surface, queue } = newSurface();
  const first = queue.enqueue();
  const open = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  first.resolve(response(200, page({ nextCursor: "cursor-1" })));
  await open;

  const invalid = queue.enqueue();
  const reload = queue.enqueue();
  const more = surface.loadMore();
  invalid.resolve(response(400, { error: "bad cursor", code: "invalid-cursor" }));
  reload.resolve(response(200, page({ rows: [{ path: "Notes/Reloaded.md", values: { name: "Reloaded" } }] })));

  assert.equal((await more).ok, true);
  const state = surface.getState();
  assert.deepEqual(state.rows.map((row) => row.path), ["Notes/Reloaded.md"]);
  assert.equal(state.nextCursor, null);
  assert.doesNotMatch(queue.calls[2].url, /cursor=/);
});

test("503 load-more keeps existing rows and renders a retryable error state", async () => {
  const { surface, queue, host } = newSurface();
  const first = queue.enqueue();
  const open = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  first.resolve(response(200, page({ nextCursor: "cursor-1" })));
  await open;

  const failing = queue.enqueue();
  const more = surface.loadMore();
  failing.resolve(response(503, { error: "catalog not ready", code: "catalog-not-ready" }));

  const result = await more;
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 503);
  const state = surface.getState();
  assert.deepEqual(state.rows.map((row) => row.path), ["Notes/A.md"]);
  assert.equal(state.nextCursor, "cursor-1");
  assert.equal(state.error.status, 503);
  assert.notEqual(host.querySelector(".base-surface-error"), null);
  assert.notEqual(host.querySelector(".base-retry"), null);
  assert.equal(queue.calls.length, 2);
});

test("an open failure resolves to {ok:false} and renders an explicit error state", async () => {
  const { surface, queue, host, errors } = newSurface();
  const call = queue.enqueue();
  const pending = surface.open({ path: "Missing.base", route: "/app/base/Missing" });
  call.resolve(response(404, { error: "not found" }));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 404);
  // Wording pin, not a behaviour contract: the visible sentence is user language
  // (desktop-re/bases-ui-parity-2 item 1 — the surface never prints the request
  // layer's English), while the raw server sentence stays available as `detail`.
  assert.equal(result.error.message, "未找到该数据库或视图。");
  assert.equal(result.error.detail, "not found");
  assert.equal(errors.length, 1);
  assert.equal(surface.getState().documentKind, "base");
  assert.notEqual(host.querySelector('[role="alert"]'), null);
});

test("a network rejection is reported as a retryable error, not a crash", async () => {
  const { surface, queue } = newSurface();
  const call = queue.enqueue();
  const pending = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  call.reject(new Error("socket closed"));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network");
});

test("setView reloads the same Base with the requested view", async () => {
  const { surface, queue } = newSurface();
  const open = queue.enqueue();
  const pendingOpen = surface.open({ path: "Notes/Project.base", route: "/app/base/r", view: "Table" });
  open.resolve(response(200, page({ views: [{ name: "Table", type: "table" }, { name: "Cards", type: "cards" }] })));
  await pendingOpen;

  const switchCall = queue.enqueue();
  const switching = surface.setView("Cards");
  switchCall.resolve(response(200, page({ view: { name: "Cards", type: "cards" }, views: [{ name: "Table", type: "table" }, { name: "Cards", type: "cards" }] })));
  assert.equal((await switching).ok, true);

  assert.equal(surface.getState().view, "Cards");
  assert.match(queue.calls[1].url, /view=Cards/);
  assert.doesNotMatch(queue.calls[1].url, /cursor=/);
});

test("catalog.stale surfaces as catalogStale without blocking rows", async () => {
  const { surface, queue, host } = newSurface();
  const call = queue.enqueue();
  const pending = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  call.resolve(response(200, page({ catalog: { catalogId: "cat-1", generation: 2, stale: true } })));

  assert.equal((await pending).ok, true);
  assert.equal(surface.getState().catalogStale, true);
  assert.equal(host.querySelectorAll("tbody tr").length, 1);
});

test("view selector change triggers setView through the injected fetch", async () => {
  const { surface, queue, host } = newSurface();
  const open = queue.enqueue();
  const pendingOpen = surface.open({ path: "Notes/Project.base", route: "/app/base/r", view: "Table" });
  open.resolve(response(200, page({ views: [{ name: "Table", type: "table" }, { name: "Cards", type: "cards" }] })));
  await pendingOpen;

  const switchCall = queue.enqueue();
  const select = host.querySelector(".base-view-select");
  assert.notEqual(select, null);
  select.value = "Cards";
  select.dispatchEvent({ type: "change" });
  switchCall.resolve(response(200, page({ view: { name: "Cards", type: "cards" }, views: [{ name: "Table", type: "table" }, { name: "Cards", type: "cards" }] })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(surface.getState().view, "Cards");
  assert.match(queue.calls[1].url, /view=Cards/);
});

test("loadMore without a cursor is a no-op failure", async () => {
  const { surface, queue } = newSurface();
  const open = queue.enqueue();
  const pending = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  open.resolve(response(200, page({ nextCursor: null })));
  await pending;

  const result = await surface.loadMore();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-more");
  assert.equal(queue.calls.length, 1);
});

test("retry after a failure restores the first page and clears the error", async () => {
  const { surface, queue, host } = newSurface();
  const failing = queue.enqueue();
  const pending = surface.open({ path: "Notes/Project.base", route: "/app/base/r" });
  failing.resolve(response(503, { error: "catalog", code: "catalog-not-ready" }));
  assert.equal((await pending).ok, false);
  assert.equal(surface.getState().error.status, 503);

  const retryCall = queue.enqueue();
  host.querySelector(".base-retry").click();
  retryCall.resolve(response(200, page()));
  await new Promise((resolve) => setImmediate(resolve));

  const state = surface.getState();
  assert.equal(state.error, null);
  assert.equal(state.rows.length, 1);
  assert.equal(host.querySelector(".base-surface-error"), null);
  assert.doesNotMatch(queue.calls[1].url, /cursor=/);
});
