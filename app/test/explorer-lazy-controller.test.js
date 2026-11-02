// Phase 2B-1a unit tests: lazy Explorer tree controller (injected api, no DOM).
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyTreeController, treePageUrl } from "../frontend/app/features/explorer/lazy-controller.js";

function createFakeApi(handler) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push({ url, signal: options.signal });
    return handler(url, options);
  };
  return { api, calls };
}

const page = (parent, items, nextCursor = null, generation = 1) => ({
  parent,
  items,
  nextCursor,
  catalog: { generation, stale: false },
});

test("treePageUrl encodes parent/cursor/anchorPath plus the SortSpec", () => {
  assert.equal(treePageUrl({ parent: "" }), "/api/web/v2/tree?parent=&sort=name&direction=asc");
  assert.match(treePageUrl({ parent: "a", cursor: "c1" }), /parent=a&sort=name&direction=asc&cursor=c1/);
  assert.match(treePageUrl({ parent: "a", anchorPath: "a/b.md" }), /anchorPath=a%2Fb\.md/);
  assert.match(treePageUrl({ parent: "a", spec: { key: "modified", direction: "desc" } }), /sort=modified&direction=desc/);
});

test("loadRoot requests the root page and applies it", async () => {
  const { api, calls } = createFakeApi(() => page("", [{ path: "Notes" }], null, 5));
  const controller = createLazyTreeController({ api });
  await controller.loadRoot();
  assert.equal(calls[0].url, "/api/web/v2/tree?parent=&sort=name&direction=asc");
  assert.deepEqual(controller.model.childrenByParent.get("").map((item) => item.path), ["Notes"]);
  assert.equal(controller.loadedGenerationFor(""), 5);
});

test("toggle expands and loads once, collapse does not request, re-expand reuses", async () => {
  let count = 0;
  const { api } = createFakeApi(() => {
    count += 1;
    return page("Notes", [{ path: "Notes/A.md" }]);
  });
  const controller = createLazyTreeController({ api });

  await controller.toggle("Notes");
  assert.equal(count, 1);
  assert.equal(controller.model.expanded.has("Notes"), true);

  await controller.toggle("Notes"); // collapse
  assert.equal(count, 1);
  assert.equal(controller.model.expanded.has("Notes"), false);

  await controller.toggle("Notes"); // re-expand, already loaded
  assert.equal(count, 1);
  assert.equal(controller.model.expanded.has("Notes"), true);
});

test("loadMore continues with the stored cursor and appends", async () => {
  const pages = [page("", [{ path: "A.md" }], "c1"), page("", [{ path: "B.md" }])];
  let index = 0;
  const { api, calls } = createFakeApi(() => pages[index++]);
  const controller = createLazyTreeController({ api });

  await controller.loadRoot();
  await controller.loadMore("");
  assert.match(calls[1].url, /cursor=c1/);
  assert.deepEqual(controller.model.childrenByParent.get("").map((item) => item.path), ["A.md", "B.md"]);
});

test("locate reveals layer-by-layer with an anchor at every level", async () => {
  const { api, calls } = createFakeApi(() => page("", []));
  const controller = createLazyTreeController({ api });

  await controller.locate("a/b/c.md");
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /parent=&sort=name&direction=asc&anchorPath=a$/);
  assert.match(calls[1].url, /parent=a&sort=name&direction=asc&anchorPath=a%2Fb$/);
  assert.match(calls[2].url, /parent=a%2Fb&sort=name&direction=asc&anchorPath=a%2Fb%2Fc\.md$/);
  assert.deepEqual([...controller.model.expanded].sort(), ["a", "a/b"]);
});

test("locate skips a level only when the loaded items already contain that child", async () => {
  const { api, calls } = createFakeApi((url) => (/parent=&/.test(url) ? page("", [{ path: "a" }]) : page("", [])));
  const controller = createLazyTreeController({ api });

  await controller.loadRoot(); // root items already contain "a"
  const before = calls.length;
  await controller.locate("a/b/c.md");
  assert.match(calls[before].url, /parent=a&sort=name&direction=asc&anchorPath=a%2Fb$/, "the present level is skipped");
  assert.match(calls[before + 1].url, /parent=a%2Fb&sort=name&direction=asc&anchorPath=a%2Fb%2Fc\.md$/);
});

test("invalidate refreshes only the affected loaded parent", async () => {
  const { api, calls } = createFakeApi((url) => page(url.match(/parent=([^&]*)/)?.[1] ?? "", [], null, 2));
  const controller = createLazyTreeController({ api });

  await controller.loadRoot();
  await controller.toggle("Notes");
  const before = calls.length;
  await controller.invalidate("Notes/A.md");
  assert.equal(calls.length, before + 1);
  assert.match(calls[calls.length - 1].url, /parent=Notes/);

  // An invalidated parent that was never loaded is not fetched.
  const quiet = calls.length;
  await controller.invalidate("Other/X.md");
  assert.equal(calls.length, quiet);
});

test("invalidating a loaded parent reloads it in place, keeping its items during the flight", async () => {
  const { api } = createFakeApi(() => page("Notes", [{ path: "Notes/A.md" }]));
  const controller = createLazyTreeController({ api, retryDelays: [] });
  await controller.toggle("Notes");

  const invalidating = controller.invalidate("Notes/A.md");
  assert.deepEqual(
    controller.model.childrenByParent.get("Notes").map((item) => item.path),
    ["Notes/A.md"],
    "the current items stay while the in-place reload is in flight",
  );
  await invalidating;
  assert.deepEqual(controller.model.childrenByParent.get("Notes").map((item) => item.path), ["Notes/A.md"]);
});

test("a superseded request is aborted and never applied", async () => {
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push(resolve);
    });
  const controller = createLazyTreeController({ api });

  const first = controller.loadRoot();
  const second = controller.loadRoot();
  resolvers[1](page("", [{ path: "B.md" }], null, 2));
  await second;
  await first;
  assert.deepEqual(
    controller.model.childrenByParent.get("").map((item) => item.path),
    ["B.md"],
    "only the latest response is applied",
  );
});

test("a failed request clears loading and keeps the previous page", async () => {
  let fail = false;
  const { api } = createFakeApi(() => {
    if (fail) throw Object.assign(new Error("boom"), { status: 500 });
    return page("Notes", [{ path: "Notes/A.md" }], "c1");
  });
  const errors = [];
  const controller = createLazyTreeController({ api, onError: (error, parent) => errors.push({ error, parent }) });

  await controller.toggle("Notes");
  fail = true;
  await controller.loadMore("Notes");

  assert.equal(controller.model.loadingParents.has("Notes"), false);
  assert.deepEqual(controller.model.childrenByParent.get("Notes").map((item) => item.path), ["Notes/A.md"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].parent, "Notes");
});

test("invalidating a parent mid-initial-load aborts it and never writes back", async () => {
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push({ url, resolve });
    });
  const controller = createLazyTreeController({ api });

  const loading = controller.toggle("Notes");
  await controller.invalidate("Notes/A.md");
  resolvers[0].resolve(page("Notes", [{ path: "Notes/A.md" }]));
  await loading;

  assert.equal(controller.model.childrenByParent.has("Notes"), false, "the aborted response must not be applied");
  assert.equal(controller.model.loadingParents.has("Notes"), false, "no loading residue");
});

test("a global invalidate retires the superseded pages and re-materializes the preserved expansion", async () => {
  const items = { "": [{ path: "root.md" }], a: [{ path: "a/x.md" }], b: [{ path: "b/y.md" }] };
  const gates = [];
  let calls = 0;
  const api = (url, { signal } = {}) => {
    calls += 1;
    const parent = new URL(`http://localhost${url}`).searchParams.get("parent") ?? "";
    // The two toggle pages stay in flight until the reset below has retired them.
    if (calls <= 2) {
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        gates.push(() => resolve(page(parent, [{ path: `stale-${parent}.md` }])));
      });
    }
    return Promise.resolve(page(parent, items[parent] ?? []));
  };
  const controller = createLazyTreeController({ api });

  const a = controller.toggle("a");
  const b = controller.toggle("b");
  const reset = controller.invalidateEverything();
  for (const release of gates) release(); // a late response for a retired owner
  await Promise.all([a, b]);
  assert.equal(controller.model.childrenByParent.has("a"), false, "a retired page must never be applied");
  assert.equal(controller.model.childrenByParent.has("b"), false);

  // Issue #336: a reset keeps `expanded`, so it must re-materialize root + every expanded
  // chain instead of leaving those levels as expanded-but-empty boxes.
  await reset;
  assert.deepEqual(controller.model.childrenByParent.get("").map((item) => item.path), ["root.md"]);
  assert.deepEqual(controller.model.childrenByParent.get("a").map((item) => item.path), ["a/x.md"]);
  assert.deepEqual(controller.model.childrenByParent.get("b").map((item) => item.path), ["b/y.md"]);
  assert.equal(controller.model.loadingParents.size, 0);
});

test("dispose aborts all pending requests and clears loading residue", async () => {
  const api = (url, { signal } = {}) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const controller = createLazyTreeController({ api });

  const a = controller.toggle("a");
  const b = controller.toggle("b");
  controller.dispose();
  assert.equal(controller.model.loadingParents.size, 0);
  await Promise.all([a, b]);
  assert.equal(controller.model.loadingParents.size, 0);
});

test("a catalog-not-ready 503 is retried with bounded backoff until the catalog is ready", async () => {
  let calls = 0;
  const api = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("not ready"), { status: 503, data: { error: "catalog-not-ready" } });
    return page("", [{ path: "A.md" }]);
  };
  const controller = createLazyTreeController({ api, retryDelays: [0, 0, 0] });
  await controller.loadRoot();
  assert.equal(calls, 3, "retried until ready");
  assert.deepEqual(controller.model.childrenByParent.get("").map((item) => item.path), ["A.md"]);
});

test("a locate() required level also recovers from catalog-not-ready", async () => {
  let ready = false;
  const { api, calls } = createFakeApi(() => {
    if (!ready) throw Object.assign(new Error("not ready"), { status: 503, data: { error: "catalog-not-ready" } });
    return page("", [{ path: "a" }]);
  });
  const controller = createLazyTreeController({ api, retryDelays: [0, 0] });
  const locating = controller.locate("a/b/c.md");
  ready = true;
  await locating;
  assert.ok(calls.length >= 2, "the first not-ready call was retried");
  assert.ok(controller.model.childrenByParent.has(""));
});

test("a catalog-unavailable 503 is not retried", async () => {
  let calls = 0;
  const errors = [];
  const api = async () => {
    calls += 1;
    throw Object.assign(new Error("unavailable"), { status: 503, data: { error: "catalog-unavailable" } });
  };
  const controller = createLazyTreeController({ api, retryDelays: [0, 0, 0], onError: (error) => errors.push(error) });
  await controller.loadRoot();
  assert.equal(calls, 1, "catalog-unavailable must not be retried");
  assert.equal(errors.length, 1);
});

test("dispose during a readiness retry terminates the loop", async () => {
  let calls = 0;
  const api = async () => {
    calls += 1;
    throw Object.assign(new Error("not ready"), { status: 503, data: { error: "catalog-not-ready" } });
  };
  const controller = createLazyTreeController({ api, retryDelays: [50, 50, 50] });
  const loading = controller.loadRoot();
  controller.dispose();
  await loading;
  assert.equal(calls, 1, "dispose stops the retry loop");
  assert.equal(controller.model.loadingParents.size, 0);
});

test("an aborted locate stops issuing deeper anchor requests", async () => {
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push({ url, resolve });
    });
  const controller = createLazyTreeController({ api });

  const locating = controller.locate("a/b/c.md");
  assert.equal(resolvers.length, 1, "only the first level is requested so far");
  // The reset retires the in-flight level and starts its own (unanswered, non-anchor)
  // re-materialization: the retired walk must not add a second anchor request.
  controller.invalidateEverything();
  await locating;

  const anchorRequests = resolvers.map((entry) => entry.url).filter((url) => url.includes("anchorPath="));
  assert.equal(anchorRequests.length, 1, "the old locate must not issue any deeper request");
});

test("dispose mid-locate stops deeper anchor requests", async () => {
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push({ url, resolve });
    });
  const controller = createLazyTreeController({ api });

  const locating = controller.locate("a/b/c.md");
  controller.dispose();
  await locating;
  assert.equal(resolvers.length, 1, "dispose mid-locate stops the reveal");
});

// --- Issue #336: reveal must survive a global resync --------------------------

test("a vault resync landing mid-locate leaves no expanded ancestor without a page (#336)", async () => {
  const items = {
    "": [{ kind: "directory", path: "_Workspace" }],
    "_Workspace": [{ kind: "directory", path: "_Workspace/40-Projects" }],
    "_Workspace/40-Projects": [{ kind: "directory", path: "_Workspace/40-Projects/U19" }],
    "_Workspace/40-Projects/U19": [{ kind: "note", path: "_Workspace/40-Projects/U19/Deep.md" }],
  };
  let releaseLevel;
  const levelGate = new Promise((resolve) => { releaseLevel = resolve; });
  const api = async (url) => {
    const parent = new URL(`http://localhost${url}`).searchParams.get("parent") ?? "";
    // Hold the second level in flight so the resync below lands exactly where the
    // first-paint SSE stream puts it: after an ancestor level was requested.
    if (parent === "_Workspace") await levelGate;
    return page(parent, items[parent] ?? []);
  };
  const controller = createLazyTreeController({ api });

  const locating = controller.locate("_Workspace/40-Projects/U19/Deep.md");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // `vault.resync` (coverage-gap / watcher-ready) preserves `expanded` + `currentPath`.
  const resync = controller.invalidateEverything();
  releaseLevel();
  await Promise.all([locating, resync]);

  const expanded = [...controller.model.expanded].sort();
  assert.deepEqual(expanded, ["_Workspace", "_Workspace/40-Projects", "_Workspace/40-Projects/U19"]);
  for (const parent of expanded) {
    assert.equal(
      controller.model.childrenByParent.has(parent),
      true,
      `expanded level "${parent}" must have a loaded page, not an empty children box`,
    );
  }
  assert.ok(
    controller.model.childrenByParent.get("_Workspace/40-Projects/U19")
      .some((item) => item.path === "_Workspace/40-Projects/U19/Deep.md"),
    "the current note must be present in its parent's page",
  );
});

// --- BASE nodes (Wave B / B2) -----------------------------------------------

test("load-more appends across a note/base page boundary with no reorder", async () => {
  const pages = [
    page("", [{ kind: "base", path: "a.base", title: "a" }, { kind: "note", path: "b.md", title: "b" }], "c1"),
    page("", [{ kind: "note", path: "c.md", title: "c" }, { kind: "base", path: "d.base", title: "d" }]),
  ];
  let index = 0;
  const { api } = createFakeApi(() => pages[index++]);
  const controller = createLazyTreeController({ api });
  await controller.loadRoot();
  await controller.loadMore("");
  const items = controller.model.childrenByParent.get("");
  assert.deepEqual(items.map((item) => item.path), ["a.base", "b.md", "c.md", "d.base"]);
  assert.deepEqual(items.map((item) => item.kind), ["base", "note", "note", "base"]);
});

test("locate reveals a `.base` path layer-by-layer without collapsing it into a note", async () => {
  const { api, calls } = createFakeApi(() => page("", []));
  const controller = createLazyTreeController({ api });
  await controller.locate("Views/Projects.base");
  assert.equal(calls.length, 2, "one anchor per level: root, then Views");
  assert.match(calls[0].url, /parent=&sort=name&direction=asc&anchorPath=Views$/);
  assert.match(calls[1].url, /parent=Views&sort=name&direction=asc&anchorPath=Views%2FProjects\.base$/);
  assert.deepEqual([...controller.model.expanded].sort(), ["Views"]);
});

test("locate completes when a loaded level already contains the .base child", async () => {
  const { api, calls } = createFakeApi((url) =>
    /parent=&/.test(url)
      ? page("", [{ kind: "base", path: "Views.base", title: "Views" }])
      : page("", []));
  const controller = createLazyTreeController({ api });
  await controller.loadRoot();
  const before = calls.length;
  await controller.locate("Views.base");
  assert.equal(calls.length, before, "the present root level is not re-fetched");
  assert.deepEqual([...controller.model.expanded], [], "a root-level base has no ancestors to expand");
});

// --- Issue #336 residual: a settled reveal must notify the scroll owner ---------

test("a settled locate notifies onRevealSettled with the normalized path (#336)", async () => {
  const settled = [];
  const { api } = createFakeApi((url) => {
    const parent = new URL(`http://localhost${url}`).searchParams.get("parent") ?? "";
    return page(parent, [{ path: "a" }, { path: "a/b" }, { path: "a/b/c.md" }]);
  });
  const controller = createLazyTreeController({ api, onRevealSettled: (path) => settled.push(path) });
  await controller.locate("./a/b/c.md");
  assert.deepEqual(settled, ["a/b/c.md"]);
});

test("a locate that needs no request still notifies onRevealSettled (#336)", async () => {
  const settled = [];
  const { api } = createFakeApi((url) => {
    const parent = new URL(`http://localhost${url}`).searchParams.get("parent") ?? "";
    return page(parent, [{ kind: "note", path: "a.md" }]);
  });
  const controller = createLazyTreeController({ api, onRevealSettled: (path) => settled.push(path) });
  await controller.loadRoot();
  settled.length = 0;
  await controller.locate("a.md");
  // Fully-loaded chain: nothing to fetch, yet the reveal is settled and must scroll.
  assert.deepEqual(settled, ["a.md"]);
});

test("an aborted locate never notifies onRevealSettled (#336)", async () => {
  const settled = [];
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push({ url, resolve });
    });
  const controller = createLazyTreeController({ api, onRevealSettled: (path) => settled.push(path) });
  const locating = controller.locate("a/b/c.md");
  controller.dispose();
  await locating;
  assert.deepEqual(settled, [], "a superseded/aborted walk is not a settled reveal");
});

test("a global resync re-notifies the preserved current path (#336)", async () => {
  const settled = [];
  const items = { "": [{ kind: "directory", path: "a" }], a: [{ kind: "note", path: "a/x.md" }] };
  const { api } = createFakeApi((url) => {
    const parent = new URL(`http://localhost${url}`).searchParams.get("parent") ?? "";
    return page(parent, items[parent] ?? []);
  });
  const controller = createLazyTreeController({ api, onRevealSettled: (path) => settled.push(path) });
  await controller.locate("a/x.md");
  assert.deepEqual(settled, ["a/x.md"]);
  await controller.invalidateEverything();
  // The resync preserves `currentPath`, so its re-materialization must re-settle it: this
  // is the signal that re-scrolls the row after the first-paint resync replaced the layout.
  assert.deepEqual(settled, ["a/x.md", "a/x.md"]);
});
