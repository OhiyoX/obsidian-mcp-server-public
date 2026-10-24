// Phase 3A-3 contract: the first-party search UI is v2-backed.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A-3 契约前置决策（冻结，2026-10-04）
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SEARCH_PAGE_LIMIT,
  applySearchPage,
  beginSearch,
  beginSearchMore,
  createSearchState,
  endSearch,
  isSearchActive,
  resetSearch,
  searchPageUrl,
  searchStatus,
  toSearchRow,
} from "../frontend/app/features/search/search-state.js";

const FRONTEND_ROOT = fileURLToPath(new URL("../frontend/app/", import.meta.url));

async function collectSources(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSources(full)));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

test("source guard: no production frontend file consumes the v1 notes endpoint", async () => {
  // This proves the first-party UI consumer count is zero. The v1 endpoint itself is
  // still registered and supported; external consumers can only be proven absent by
  // the Phase 4 production route observation.
  const files = await collectSources(FRONTEND_ROOT);
  assert.ok(files.length > 10, `scanned ${files.length} frontend sources`);
  const offenders = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (source.includes("/api/web/v1/notes")) offenders.push(path.relative(FRONTEND_ROOT, file));
  }
  assert.deepEqual(offenders, [], "first-party v1 notes consumers must be zero");
});

test("a new query identity drops the previous items and cursor", () => {
  const state = createSearchState();
  const first = beginSearch(state, { query: "alpha" });
  applySearchPage(state, first, { items: [{ path: "A.md" }], nextCursor: "c1" });
  assert.equal(state.items.length, 1);
  assert.equal(state.nextCursor, "c1");

  const second = beginSearch(state, { query: "beta" });
  assert.equal(second, first + 1);
  assert.deepEqual(state.items, [], "a new query starts from an empty page");
  assert.equal(state.nextCursor, null);
  assert.equal(state.loading, true);
  assert.equal(isSearchActive(state), true);
});

test("a stale response can never append into a newer query", () => {
  const state = createSearchState();
  const old = beginSearch(state, { query: "alpha" });
  const fresh = beginSearch(state, { query: "beta" });
  assert.equal(applySearchPage(state, old, { items: [{ path: "stale.md" }], nextCursor: "x" }), false);
  assert.deepEqual(state.items, [], "the superseded response is dropped");
  assert.equal(applySearchPage(state, fresh, { items: [{ path: "beta.md" }], nextCursor: null }), true);
  assert.deepEqual(state.items.map((item) => item.path), ["beta.md"]);
  assert.equal(state.exhausted, true);
  // A superseded failure must not clear the loading state of the newer request.
  const third = beginSearch(state, { query: "gamma" });
  assert.equal(endSearch(state, fresh), false);
  assert.equal(state.loading, true);
  assert.equal(endSearch(state, third), true);
  assert.equal(state.loading, false);
});

test("continuation appends only for the current query and keeps the cursor opaque", () => {
  const state = createSearchState();
  const first = beginSearch(state, { query: "alpha" });
  applySearchPage(state, first, { items: [{ path: "A.md" }], nextCursor: "opaque+1" });
  const more = beginSearchMore(state);
  assert.equal(more, first + 1);
  assert.equal(state.nextCursor, "opaque+1", "the cursor survives starting the next page");
  applySearchPage(state, more, { items: [{ path: "B.md" }], nextCursor: null });
  assert.deepEqual(state.items.map((item) => item.path), ["A.md", "B.md"]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.exhausted, true);
});

test("the page URL is the frozen v2 search contract", () => {
  const state = createSearchState();
  beginSearch(state, { query: "alpha beta", caseSensitive: true, semantic: false });
  const url = searchPageUrl(state);
  assert.match(url, /^\/api\/web\/v2\/search\?/);
  assert.match(url, /limit=50/);
  assert.match(url, /q=alpha\+beta/);
  assert.match(url, /caseSensitive=true/);
  assert.match(url, /semantic=false/);
  assert.doesNotMatch(url, /cursor=/, "the first page has no cursor");
  assert.match(searchPageUrl(state, "opaque-cursor"), /cursor=opaque-cursor/);
  assert.doesNotMatch(url, /offset|page=/);
  assert.equal(SEARCH_PAGE_LIMIT, 50);
});

test("clearing a search resets the view state", () => {
  const state = createSearchState();
  const version = beginSearch(state, { query: "alpha" });
  applySearchPage(state, version, { items: [{ path: "A.md" }], nextCursor: "c" });
  resetSearch(state);
  assert.equal(isSearchActive(state), false);
  assert.deepEqual(state.items, []);
  assert.equal(state.nextCursor, null);
  assert.equal(state.loading, false);
  // The bumped version means an in-flight response for the cleared query is dropped.
  assert.equal(applySearchPage(state, version, { items: [{ path: "late.md" }] }), false);
});

test("the item adapter keeps the frozen v2 fields and never invents one", () => {
  assert.deepEqual(toSearchRow({ path: "A.md", name: "A.md", modifiedMs: 12, score: -1.5, matchCount: 2, snippets: ["x"] }), {
    path: "A.md",
    name: "A.md",
    modifiedMs: 12,
    score: -1.5,
    matchCount: 2,
    snippet: "x",
  });
  assert.equal(toSearchRow({ path: "B.md" }).modifiedMs, null);
  assert.equal(toSearchRow({ path: "B.md" }).snippet, "");
});

test("the server's semantic outcome is surfaced, never inferred", () => {
  const state = createSearchState();
  const version = beginSearch(state, { query: "alpha", semantic: true });
  // Retrieval ran: say so.
  applySearchPage(state, version, { items: [{ path: "A.md" }], nextCursor: null, semantic: { requested: true, used: true, error: null } });
  assert.match(searchStatus(state).text, /普通搜索 \+ 语义/);
  assert.equal(searchStatus(state).kind, "");

  // Requested but not used: the reason is explicit and the text says so.
  const degraded = createSearchState();
  const v2 = beginSearch(degraded, { query: "alpha", semantic: true });
  applySearchPage(degraded, v2, {
    items: [{ path: "A.md" }],
    nextCursor: null,
    semantic: { requested: true, used: false, error: "Embedding provider is not configured" },
  });
  const status = searchStatus(degraded);
  assert.equal(status.kind, "warning");
  assert.match(status.text, /语义不可用/);
  assert.equal(status.title, "Embedding provider is not configured");

  const plain = createSearchState();
  beginSearch(plain, { query: "alpha" });
  assert.match(searchStatus(plain).text, /普通搜索/);
});

test("the controller wires the v2 search contract without a v1 fallback", async () => {
  const controller = await fs.readFile(new URL("../frontend/app/features/explorer/controller.js", import.meta.url), "utf8");
  assert.match(controller, /searchPageUrl\(search, cursor\)/);
  assert.match(controller, /renderSearchResults\(/);
  assert.match(controller, /loadMoreSearch/);
  assert.match(controller, /beginSearchMore\(search\)/);
  // 409 cursor-stale restarts only this search; the tree is never reloaded from it.
  assert.match(controller, /code === "cursor-stale"/);
  assert.match(controller, /const retry = beginSearch\(search,/);
  assert.doesNotMatch(controller, /\/api\/web\/v1\/notes/);
  assert.doesNotMatch(controller, /renderExplorer/);
});
