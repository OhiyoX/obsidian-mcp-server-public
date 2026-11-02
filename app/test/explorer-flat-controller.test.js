// Lazy flat-list controller: request identity, paging, stale retirement and the
// bounded reveal walk (injected api, no DOM).
import assert from "node:assert/strict";
import test from "node:test";
import {
  FLAT_PAGE_LIMIT,
  FLAT_REVEAL_MAX_PAGES,
  createFlatListController,
  flatPageUrl,
} from "../frontend/app/features/explorer/flat-controller.js";

function createFakeApi(handler) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url);
  };
  return { api, calls };
}

const page = (items, nextCursor = null) => ({ parent: "", items, nextCursor, catalog: { generation: 1, stale: false } });
const note = (path) => ({ kind: "note", path, name: path, title: path, modified: null });

test("flatPageUrl uses flat=1 with the spec and never sends a parent", () => {
  assert.equal(
    flatPageUrl({ spec: { key: "modified", direction: "desc" } }),
    `/api/web/v2/tree?flat=1&sort=modified&direction=desc&limit=${FLAT_PAGE_LIMIT}`,
  );
  const withCursor = flatPageUrl({ spec: { key: "path", direction: "asc" }, cursor: "abc" });
  assert.match(withCursor, /flat=1&sort=path&direction=asc&limit=100&cursor=abc/);
  assert.equal(withCursor.includes("parent"), false);
});

test("load fetches page 1 and loadMore passes the returned cursor back verbatim", async () => {
  const pages = [page([note("a.md"), note("b.md")], "cursor-1"), page([note("c.md")])];
  let index = 0;
  const { api, calls } = createFakeApi(() => pages[index++]);
  const controller = createFlatListController({ api });

  await controller.load({ key: "modified", direction: "desc" });
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md", "b.md"]);
  assert.equal(controller.state.nextCursor, "cursor-1");
  assert.equal(controller.state.loading, false);

  await controller.loadMore();
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md", "b.md", "c.md"]);
  assert.equal(controller.state.nextCursor, null);
  assert.match(calls[1].url, /cursor=cursor-1/);
  // Exhausted: another loadMore is a no-op and issues no request.
  assert.equal(await controller.loadMore(), false);
  assert.equal(calls.length, 2);
});

test("a spec change retires the in-flight page so a stale response can never land", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let call = 0;
  const { api } = createFakeApi(async () => {
    call += 1;
    if (call === 1) await first;
    return page([note(call === 1 ? "stale.md" : "fresh.md")]);
  });
  const controller = createFlatListController({ api });

  const pending = controller.load({ key: "modified", direction: "desc" });
  await Promise.resolve();
  await controller.load({ key: "path", direction: "asc" });
  releaseFirst();
  await pending;
  assert.deepEqual(controller.state.items.map((item) => item.path), ["fresh.md"]);
  assert.equal(controller.state.loading, false);
});

test("a failed page surfaces the error, keeps loaded rows and retry resumes from the cursor", async () => {
  const errors = [];
  let call = 0;
  const { api, calls } = createFakeApi(() => {
    call += 1;
    if (call === 2) throw Object.assign(new Error("boom"), { status: 503 });
    if (call === 1) return page([note("a.md")], "cursor-1");
    return page([note("b.md")]);
  });
  const controller = createFlatListController({ api, onError: (error) => errors.push(error) });
  await controller.load({ key: "modified", direction: "desc" });
  assert.equal(await controller.loadMore(), false);
  assert.equal(controller.state.error?.status, 503);
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md"], "loaded rows are not blanked by a failed continuation");
  assert.equal(errors.length, 1);

  await controller.retry();
  assert.equal(controller.state.error, null);
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md", "b.md"]);
  assert.match(calls[2].url, /cursor=cursor-1/, "retry resumes the retained cursor");
});

test("a failed first page retries from page 1", async () => {
  let call = 0;
  const { api, calls } = createFakeApi(() => {
    call += 1;
    if (call === 1) throw Object.assign(new Error("boom"), { status: 400 });
    return page([note("a.md")]);
  });
  const controller = createFlatListController({ api });
  await controller.load({ key: "modified", direction: "desc" });
  assert.equal(controller.state.error?.status, 400);
  assert.deepEqual(controller.state.items, []);
  await controller.retry();
  assert.equal(controller.state.error, null);
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md"]);
  assert.equal(calls[1].url.includes("cursor"), false);
});

test("ensureVisible walks the keyset stream until the note is present", async () => {
  const pages = [
    page([note("a.md"), note("b.md")], "c1"),
    page([note("c.md"), note("d.md")], "c2"),
    page([note("e.md")]),
  ];
  let index = 0;
  const { api, calls } = createFakeApi(() => pages[index++]);
  const controller = createFlatListController({ api });
  await controller.load({ key: "path", direction: "asc" });
  assert.equal(await controller.ensureVisible("e.md"), true);
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md", "b.md", "c.md", "d.md", "e.md"]);
  assert.equal(calls.length, 3);
  // Already-present target: no extra request.
  assert.equal(await controller.ensureVisible("b.md"), true);
  assert.equal(calls.length, 3);
});

test("ensureVisible is bounded and reports a miss without throwing", async () => {
  let calls = 0;
  const { api } = createFakeApi(() => {
    calls += 1;
    return page([note(`p${calls}.md`)], `cursor-${calls}`);
  });
  const controller = createFlatListController({ api });
  await controller.load({ key: "path", direction: "asc" });
  assert.equal(await controller.ensureVisible("missing.md"), false);
  assert.equal(calls, 1 + FLAT_REVEAL_MAX_PAGES, "one initial page plus the bounded walk");
  assert.equal(FLAT_REVEAL_MAX_PAGES > 1, true);
});

test("ensureVisible before any load and after invalidate is a no-op", async () => {
  const { api, calls } = createFakeApi(() => page([note("a.md")]));
  const controller = createFlatListController({ api });
  assert.equal(await controller.ensureVisible("a.md"), false);
  await controller.load({ key: "modified", direction: "desc" });
  controller.invalidate();
  assert.deepEqual(controller.state.items, []);
  assert.equal(controller.state.spec, null);
  assert.equal(await controller.ensureVisible("a.md"), false);
  assert.equal(calls.length, 1);
});

test("load with an unchanged spec keeps the rendered rows until the refresh lands", async () => {
  let release;
  let call = 0;
  const { api } = createFakeApi(async () => {
    call += 1;
    if (call === 2) await new Promise((resolve) => { release = resolve; });
    return page([note(call === 1 ? "a.md" : "b.md")]);
  });
  const controller = createFlatListController({ api });
  await controller.load({ key: "modified", direction: "desc" });
  const pending = controller.load({ key: "modified", direction: "desc" });
  await Promise.resolve();
  assert.deepEqual(controller.state.items.map((item) => item.path), ["a.md"], "an unchanged-spec refresh does not blank the list");
  release();
  await pending;
  assert.deepEqual(controller.state.items.map((item) => item.path), ["b.md"]);
});
