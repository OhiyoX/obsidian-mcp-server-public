// `published:` is a hard filter over the Publish registry, not a text term (#270).
//
// Regression context: the Phase 3A-3 cutover moved the first-party search UI to
// `/api/web/v2/search`, but the `published:` semantics stayed in the deprecated v1
// route. v2 parsed `published:true` as a plain text clause, so the Web "Publishes"
// button matched notes whose raw text happened to contain that literal (typically a
// frontmatter property) instead of the Publish registry -- while the document toolbar
// kept reading the registry. Filter and toolbar disagreed.
//
// Real Express router + real session login + real catalog runtime + real Publish
// service (no mocked search backend, no mock registry).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-published-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });

// `a`, `b`, `e` carry a frontmatter `published` property (with and without the space)
// but are never registered through the Publish feature: exactly the decoys that the
// text-clause bug surfaced as "published".
await fs.writeFile(path.join(vault, "Notes", "a.md"), "---\npublished: true\n---\nalpha one\n");
await fs.writeFile(path.join(vault, "Notes", "b.md"), "---\npublished:true\n---\nalpha two\n");
await fs.writeFile(path.join(vault, "Notes", "c.md"), "alpha three\n");
await fs.writeFile(path.join(vault, "Notes", "d.md"), "alpha four\n");
await fs.writeFile(path.join(vault, "Notes", "e.md"), "---\npublished: true\n---\nalpha five\n");
await fs.writeFile(path.join(vault, "Notes", "f.md"), "---\npublished: false\n---\nalpha six\n");

process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.WEB_CATALOG_ENABLED = "true";

// Imported only after VAULT_PATH/DATA_PATH are set: config is read at import time.
const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  runtimeModule,
  searchApiModule,
  { PublishService },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/web-catalog/search-api.js"),
  import("../src/publish/service.js"),
]);
const { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests } = runtimeModule;
const { extractPublishFilter, resolveSearchPage, WebCatalogHttpError } = searchApiModule;

const PUBLISHED = ["Notes/c.md", "Notes/d.md"];
const UNPUBLISHED = ["Notes/a.md", "Notes/b.md", "Notes/e.md", "Notes/f.md"];

function createPublishService() {
  return new PublishService({ file: path.join(data, "publish", "state.json") });
}

const publishService = createPublishService();
await publishService.ready;
for (const notePath of PUBLISHED) {
  await publishService.publish(defaultWebVaultId(), notePath);
}

const vaultRecord = await resolveWebVault(defaultWebVaultId());
const catalog = getWebCatalogRuntime(vaultRecord);
catalog.setCoverage(true, "test");
await catalog.drain();
const getRuntime = () => catalog;

test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

async function search(query) {
  return resolveSearchPage({ vault: vaultRecord, query, getRuntime, publishService });
}

// --- pure extraction --------------------------------------------------------------

test("published: is extracted before parsing, with v1 parity", () => {
  // Absent filter: the query is untouched.
  assert.deepEqual(extractPublishFilter("alpha beta"), { query: "alpha beta", published: null });
  // The filter is stripped and decides the side. The residual whitespace is not
  // normalized (v1 parity); what matters is that the remaining query still parses to
  // exactly the same clauses.
  const mixed = extractPublishFilter("alpha published:true beta");
  assert.equal(mixed.published, true);
  assert.deepEqual(
    parseObsidianQuery(mixed.query).groups,
    parseObsidianQuery("alpha beta").groups,
    "stripping the filter must not change the remaining query",
  );
  assert.deepEqual(extractPublishFilter("published:false"), { query: "", published: false });
  // Case-insensitive; every occurrence is stripped; the first one decides.
  const twice = extractPublishFilter("PUBLISHED:True alpha published:false");
  assert.equal(twice.published, true);
  assert.deepEqual(parseObsidianQuery(twice.query).groups, parseObsidianQuery("alpha").groups);
  // Not a filter: a different operator, a longer word, or the bracket property form
  // (which stays a frontmatter property clause on purpose).
  for (const text of ["published:maybe", "xpublished:true", "published:trueish", "[published:true]", "published"]) {
    assert.deepEqual(extractPublishFilter(text), { query: text, published: null }, text);
  }
});

// --- the filter is the Publish registry, not the note text -------------------------

test("published:true returns the registry, never a frontmatter lookalike", async () => {
  const payload = await search({ q: "published:true" });
  assert.deepEqual(payload.items.map((item) => item.path), PUBLISHED);
  assert.equal(payload.items.some((item) => item.path === "Notes/b.md"), false, "`published:true` without a space must not match by text either");
  // The constraint selects candidates inside the store, so non-matching notes never
  // enter the candidate stream at all: nothing to skip in the second pass, and the
  // request spends no budget paging past the decoys.
  assert.equal(payload.search.skippedPublish, 0, "selection already excluded every decoy");
  assert.ok(payload.search.candidates <= PUBLISHED.length + 1, `candidates=${payload.search.candidates} must be page-bounded, not a 1000-candidate scan`);
  // Order: filter-only pages select candidates in SQL and then read exactly the ones
  // they return. The invariant is what matters: reads == accepted candidates.
  assert.equal(payload.search.secondPassReads, PUBLISHED.length, "only the accepted notes are read");
  assert.equal(
    payload.search.secondPassReads,
    payload.search.candidates - payload.search.skipped - payload.search.skippedPublish,
    "a skipped candidate is never counted as a read",
  );
});

test("a sparse registry does not turn into empty pages", async () => {
  // 6 notes, 2 published, page size 5: the request must answer in one shot instead of
  // scanning a candidate budget and returning the rest as a cursor.
  const payload = await search({ q: "published:true", limit: "5" });
  assert.deepEqual(payload.items.map((item) => item.path), PUBLISHED);
  assert.equal(payload.nextCursor, null, "the whole filtered set fits one page");
  assert.ok(payload.search.candidates <= PUBLISHED.length + 1);
  // The complementary filter is bounded the same way.
  const unpublished = await search({ q: "published:false", limit: "5" });
  assert.equal(unpublished.items.length, 4);
  assert.ok(unpublished.search.candidates <= UNPUBLISHED.length + 1);
});

test("a candidate source that ignores the constraint still cannot leak a read", async () => {
  // Defense in depth: the second pass rechecks publish membership. A store that does
  // not push the constraint down must produce skips, not reads and not results.
  const unconstrained = {
    ...catalog.store,
    listSearchCandidates: (options) => catalog.store.listSearchCandidates({ ...options, publish: null }),
  };
  const payload = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "published:true" },
    getRuntime: () => ({ ...catalog, store: unconstrained }),
    publishService,
  });
  assert.deepEqual(payload.items.map((item) => item.path), PUBLISHED);
  assert.equal(payload.search.skippedPublish, 4, "every decoy is rejected by the second-pass recheck");
  assert.equal(payload.search.candidates, 6, "the unconstrained source really did hand over all six");
  assert.equal(payload.search.secondPassReads, PUBLISHED.length, "a publish-filter rejection is not a file read");
});

test("semantic recall never receives the publish control alias", async () => {
  const seenQueries = [];
  const recall = async (query) => {
    seenQueries.push(query);
    return { results: [{ path: "Notes/d.md", score: 0.9 }, { path: "Notes/a.md", score: 0.8 }], semanticUsed: true, semanticError: null };
  };

  // Filter + text: recall gets the text, not the alias, and the join applies the filter.
  const mixed = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "alpha published:true", semantic: "true", limit: "5" },
    getRuntime,
    publishService,
    recall,
  });
  assert.deepEqual(seenQueries, ["alpha"], "`published:true` must never become embedding input");
  assert.equal(mixed.search.mode, "semantic");
  assert.deepEqual(mixed.items.map((item) => item.path), ["Notes/d.md"], "the registry set wins over the retrieval window");
  assert.equal(mixed.search.skippedPublish, 1, "the join counts the note the registry excludes");
  assert.equal(mixed.search.secondPassReads, 1);

  // Filter only: v1 parity -- no positive text term, so retrieval is not attempted at all.
  seenQueries.length = 0;
  const filterOnly = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "published:true", semantic: "true", limit: "5" },
    getRuntime,
    publishService,
    recall,
  });
  assert.deepEqual(seenQueries, [], "a filter-only query must not call retrieval");
  assert.equal(filterOnly.semantic.used, false);
  assert.equal(filterOnly.semantic.error, "Semantic search requires a positive text term");
  assert.equal(filterOnly.search.mode === "semantic", false, "it degrades to the filtered lexical page");
  assert.deepEqual(filterOnly.items.map((item) => item.path), PUBLISHED);
});

test("published:false is the exact complement of the registry", async () => {
  const payload = await search({ q: "published:false" });
  assert.deepEqual(payload.items.map((item) => item.path), UNPUBLISHED);
});

test("the filter composes with a text clause and keeps bm25 ranking", async () => {
  const payload = await search({ q: "alpha published:true" });
  assert.deepEqual(payload.items.map((item) => item.path), PUBLISHED);
  assert.equal(payload.search.rank, "bm25");

  const other = await search({ q: "one published:true" });
  assert.deepEqual(other.items.map((item) => item.path), [], "the text clause still applies inside the filter");
});

test("the filter is exactly continuable and cursors never cross filters", async () => {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const payload = await search({ q: "published:true", limit: "1", ...(cursor ? { cursor } : {}) });
    seen.push(...payload.items.map((item) => item.path));
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, PUBLISHED, "paging through the filter reaches every match exactly once");

  // A cursor identifies "which search": the publish side is part of that identity.
  const first = await search({ q: "published:true", limit: "1" });
  assert.ok(first.nextCursor);
  await assert.rejects(
    () => search({ q: "published:false", limit: "1", cursor: first.nextCursor }),
    (error) => error instanceof WebCatalogHttpError && error.code === "cursor-invalid",
  );
});

test("a missing Publish registry is an explicit 503, never an unfiltered result", async () => {
  await assert.rejects(
    () => resolveSearchPage({ vault: vaultRecord, query: { q: "published:true" }, getRuntime }),
    (error) => error instanceof WebCatalogHttpError && error.code === "publish-filter-unavailable",
  );
  // A broken registry fails closed for the same reason.
  await assert.rejects(
    () => resolveSearchPage({
      vault: vaultRecord,
      query: { q: "published:true" },
      getRuntime,
      publishService: { list: async () => { throw new Error("state file corrupt"); } },
    }),
    (error) => error instanceof WebCatalogHttpError && error.code === "publish-filter-unavailable",
  );
  // Unfiltered searches never touch the registry.
  const plain = await resolveSearchPage({ vault: vaultRecord, query: { q: "alpha" }, getRuntime });
  assert.ok(plain.items.length > 0);
});

// --- HTTP contract + agreement with the toolbar's source of truth ------------------

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) =>
  fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing v2 search server")), HTTP_TIMEOUT_MS)),
  ]);
}

async function startAuthedApp(stateName, { injectedPublishService } = {}) {
  const user = {
    id: `user-${stateName}`,
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read"],
    allowedVaults: [defaultWebVaultId()],
  };
  const provider = {
    authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
    oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
    recordAudit() {},
  };
  const app = express();
  app.use(createWebAppRouter({
    provider,
    secureCookie: false,
    ...(injectedPublishService ? { publishService: injectedPublishService } : {}),
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await boundedFetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "password" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  return { base, cookie, close: () => closeHttpServer(server) };
}

test("the Publishes filter and the document Publish state agree over HTTP", async () => {
  // One registry instance, like production: the router's filter and the Publish
  // status routes must read the same object, not two loads of the same file.
  const app = await startAuthedApp("published-filter", { injectedPublishService: publishService });
  try {
    for (const query of ["published:true", "published:false"]) {
      const response = await boundedFetch(`${app.base}/api/web/v2/search?q=${encodeURIComponent(query)}`, { headers: { Cookie: app.cookie } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.query, query, "the response echoes the query the client sent");
      const expected = query === "published:true";
      for (const item of body.items) {
        // The toolbar action behind the copy link / Publish icon uses exactly this
        // call. Filter membership and toolbar state must never disagree.
        const status = await publishService.status(defaultWebVaultId(), item.path);
        assert.equal(Boolean(status.record), expected, `${item.path} must agree with the Publish registry`);
      }
      // Checklist: the registry side of the set is complete on both sides.
      const returned = new Set(body.items.map((item) => item.path));
      for (const notePath of expected ? PUBLISHED : UNPUBLISHED) {
        assert.equal(returned.has(notePath), true, `${notePath} missing from ${query}`);
      }
    }
  } finally {
    await app.close();
  }
});

test("the search route refuses a published: filter when the registry is unavailable", async () => {
  const app = await startAuthedApp("published-filter-broken", {
    injectedPublishService: { list: async () => { throw new Error("state file corrupt"); } },
  });
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/search?q=published:true`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "publish-filter-unavailable");
    // Unfiltered search keeps working: the failure is scoped to the filter.
    const plain = await boundedFetch(`${app.base}/api/web/v2/search?q=alpha`, { headers: { Cookie: app.cookie } });
    assert.equal(plain.status, 200);
  } finally {
    await app.close();
  }
});
