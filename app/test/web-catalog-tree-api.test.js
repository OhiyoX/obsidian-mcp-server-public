// Phase 2A-2 unit tests: v2 Tree query parsing + HTTP status mapping.
import assert from "node:assert/strict";
import test from "node:test";
import { WebCatalogCursorError, WebCatalogAnchorError } from "../src/app/web-catalog/cursor.js";
import {
  WebCatalogHttpError,
  mapTreeStoreError,
  parseTreeLimit,
  parseTreeQuery,
  resolveTreePage,
} from "../src/app/web-catalog/tree-api.js";

const httpError = (status, code) => (error) =>
  error instanceof WebCatalogHttpError && error.status === status && error.code === code;

function fakeRuntime({ reconciled = "2026-01-01T00:00:00.000Z", stale = false, covered = true, listChildren } = {}) {
  return {
    status: () => ({ covered }),
    store: {
      metaGet: (key) => (key === "lastReconciledAt" ? reconciled : null),
      isStale: () => stale,
      listChildren:
        listChildren ??
        (() => ({ parent: "", items: [], nextCursor: null, catalog: { generation: 7, stale } })),
    },
  };
}

test("parseTreeLimit pins default 100 and 1..500, rejecting everything else", () => {
  assert.equal(parseTreeLimit(undefined), 100);
  assert.equal(parseTreeLimit(""), 100);
  assert.equal(parseTreeLimit("1"), 1);
  assert.equal(parseTreeLimit("500"), 500);
  for (const bad of ["0", "-1", "501", "1.5", "abc", "Infinity", "NaN", "1e3", " 10", "10 "]) {
    assert.throws(() => parseTreeLimit(bad), httpError(400, "invalid-limit"), `limit ${JSON.stringify(bad)}`);
  }
});

test("parseTreeQuery validates sort/direction and canonical parent/anchor", () => {
  assert.deepEqual(parseTreeQuery({}), { parent: "", sort: "name", direction: "asc", limit: 100, cursor: null, anchorPath: null });
  assert.equal(parseTreeQuery({ parent: "Notes", sort: "modified", direction: "desc", limit: "5" }).limit, 5);
  assert.throws(() => parseTreeQuery({ sort: "score" }), httpError(400, "invalid-sort"));
  assert.throws(() => parseTreeQuery({ direction: "sideways" }), httpError(400, "invalid-sort"));
  assert.throws(() => parseTreeQuery({ parent: "/abs" }), (error) => error.code === "WEB_CATALOG_PATH_INVALID");
  assert.throws(() => parseTreeQuery({ anchorPath: "a/../b" }), (error) => error.code === "WEB_CATALOG_PATH_INVALID");
});

test("resolveTreePage returns 503 before any catalog page when disabled or never built", async () => {
  let listCalled = false;
  const runtime = fakeRuntime({ listChildren: () => { listCalled = true; } });

  await assert.rejects(
    () => resolveTreePage({ vault: {}, query: {}, getRuntime: () => null }),
    httpError(503, "catalog-unavailable"),
  );
  await assert.rejects(
    () => resolveTreePage({ vault: {}, query: {}, getRuntime: () => fakeRuntime({ reconciled: null }) }),
    httpError(503, "catalog-not-ready"),
  );
  assert.equal(listCalled, false, "a never-ready catalog must not run a page query");
  assert.ok(runtime);
});

test("resolveTreePage validates the query before touching the catalog", async () => {
  let runtimeAsked = false;
  await assert.rejects(
    () => resolveTreePage({ vault: {}, query: { limit: "0" }, getRuntime: () => { runtimeAsked = true; return null; } }),
    httpError(400, "invalid-limit"),
  );
  assert.equal(runtimeAsked, false, "an invalid limit is rejected before catalog access");
});

test("resolveTreePage returns a stale snapshot as 200 with catalog.stale=true", async () => {
  const runtime = fakeRuntime({
    stale: true,
    listChildren: () => ({
      parent: "",
      items: [{ kind: "note", path: "A.md" }],
      nextCursor: null,
      catalog: { generation: 7, stale: true },
    }),
  });
  const payload = await resolveTreePage({ vault: {}, query: {}, getRuntime: () => runtime });
  assert.equal(payload.catalog.stale, true);
  assert.equal(payload.catalog.generation, 7);
  assert.deepEqual(payload.items.map((item) => item.path), ["A.md"]);
});

test("mapTreeStoreError maps anchor and cursor failures by catalog freshness", () => {
  assert.equal(mapTreeStoreError(new WebCatalogAnchorError("x"), { stale: false }).status, 404);
  assert.equal(mapTreeStoreError(new WebCatalogAnchorError("x"), { stale: true }).status, 409);
  assert.equal(
    mapTreeStoreError(new WebCatalogAnchorError("x", "WEB_CATALOG_ANCHOR_INVALID"), { stale: false }).status,
    400,
  );
  assert.equal(mapTreeStoreError(new WebCatalogCursorError("x", "WEB_CATALOG_CURSOR_STALE"), { stale: false }).status, 409);
  assert.equal(mapTreeStoreError(new WebCatalogCursorError("x"), { stale: false }).status, 400);
  assert.equal(mapTreeStoreError(new Error("boom"), { stale: false }), null);
});

test("resolveTreePage maps invalid parent/anchor to 400 invalid-path", async () => {
  const runtime = fakeRuntime();
  await assert.rejects(
    () => resolveTreePage({ vault: {}, query: { parent: "/abs" }, getRuntime: () => runtime }),
    httpError(400, "invalid-path"),
  );
  await assert.rejects(
    () => resolveTreePage({ vault: {}, query: { anchorPath: "a/../b" }, getRuntime: () => runtime }),
    httpError(400, "invalid-path"),
  );
});

test("resolveTreePage asks for snapshot-only runtime access (no reconcile)", async () => {
  let options;
  const runtime = fakeRuntime();
  await resolveTreePage({
    vault: {},
    query: {},
    getRuntime: (_vault, received) => {
      options = received;
      return runtime;
    },
  });
  assert.deepEqual(options, { startReconcile: false });
});

test("resolveTreePage maps a runtime open failure to 503 catalog-unavailable", async () => {
  await assert.rejects(
    () =>
      resolveTreePage({
        vault: {},
        query: {},
        getRuntime: () => {
          throw new Error("sqlite open failed");
        },
      }),
    httpError(503, "catalog-unavailable"),
  );
});

test("resolveTreePage reports effective stale when the runtime has no coverage", async () => {
  const runtime = fakeRuntime({ stale: false, covered: false });
  const payload = await resolveTreePage({ vault: {}, query: {}, getRuntime: () => runtime });
  assert.equal(payload.catalog.stale, true, "persisted clean is not current clean without coverage");
});
