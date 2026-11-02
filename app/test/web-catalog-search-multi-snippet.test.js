// U5: per-hit excerpts for the frozen v2 search item shape.
//
// The frozen evaluator returns exactly one excerpt for a whole-document text clause -- the
// clause's `values` is the entire document, so its loop runs once. The Web layer expands it
// to one excerpt per literal occurrence (desktop search shape) without touching the
// evaluator's own return value, so the MCP `search_notes` payload cannot change.
//
// Real Express router + real session login + real catalog runtime + real file reads.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-snippets-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
// Each hit carries its own marker inside the excerpt window (120 characters either side)
// and sits more than 2*contextLength (240) characters from the next hit, so every excerpt
// is a distinct string cut from its own occurrence.
const zebraNote = (label, count) => `# ${label}\n\n${Array.from({ length: count }, (_, index) => `${"填".repeat(140)} 段落${index + 1}标记 zebra ${"充".repeat(140)}\n`).join("\n")}`;
await fs.writeFile(path.join(vault, "Notes", "multi.md"), `---\ntags: [ztag, done]\n---\n${zebraNote("multi", 4)}`);
await fs.writeFile(path.join(vault, "Notes", "two.md"), zebraNote("two", 2));
await fs.writeFile(path.join(vault, "Notes", "capped.md"), zebraNote("capped", 12));
// A structural-only query target that carries no text hit at all.
await fs.writeFile(path.join(vault, "Notes", "tagged.md"), "---\ntags: [onlytag]\n---\nno needle here\n");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

// Imported only after VAULT_PATH/DATA_PATH are set: config is read at import time.
const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  runtimeModule,
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
]);
const { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests } = runtimeModule;

test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  delete process.env.WEB_CATALOG_ENABLED;
  await fs.rm(root, { recursive: true, force: true });
});

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) =>
  fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });

async function startAuthedApp() {
  const user = {
    id: "user-multi-snippet",
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
  app.use(createWebAppRouter({ provider, secureCookie: false }));
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
  return {
    search: async (query) => (await boundedFetch(`${base}/api/web/v2/search${query}`, { headers: { Cookie: cookie } })).json(),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("v2 search returns one excerpt per literal hit and keeps the structural shape", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();

  const app = await startAuthedApp();
  try {
    const body = await app.search("?q=zebra&limit=50");
    const byPath = new Map(body.items.map((item) => [item.path, item]));
    const four = byPath.get("Notes/multi.md");
    const two = byPath.get("Notes/two.md");
    assert.ok(four && two, `both multi-hit notes matched (${[...byPath.keys()].join(", ")})`);
    // `matchCount` keeps exactly the evaluator's value; the excerpt list now follows it.
    assert.equal(four.matchCount, 4);
    assert.equal(four.snippets.length, 4, `one excerpt per hit (${JSON.stringify(four.snippets.slice(0, 1))})`);
    assert.equal(two.matchCount, 2);
    assert.equal(two.snippets.length, 2);
    for (const item of [four, two]) {
      assert.ok(item.snippets.every((snippet) => snippet.includes("zebra")), `every excerpt carries the needle: ${JSON.stringify(item.snippets)}`);
      assert.equal(new Set(item.snippets).size, item.snippets.length, "excerpts are deduped");
    }
    // Document order: excerpt N belongs to hit N.
    four.snippets.forEach((snippet, index) => assert.ok(snippet.includes(`段落${index + 1}标记`), `excerpt ${index} is the ${index + 1}th hit: ${snippet.slice(0, 24)}…`));
    // The other frozen item fields are untouched by the excerpt expansion.
    assert.equal(four.name, "multi.md");
    assert.equal(typeof four.modifiedMs, "number");
    assert.equal(typeof four.score, "number");
    // caseSensitive is honoured by the expansion as well as by the count.
    const strict = await app.search("?q=ZEBRA&limit=50&caseSensitive=true");
    assert.equal(strict.items.length, 0, "a case-sensitive miss stays a miss");
    const loose = await app.search("?q=ZEBRA&limit=50&caseSensitive=false");
    assert.equal(loose.items.length, 3, "the same query case-insensitively matches all three notes");
    assert.ok(loose.items.every((item) => item.snippets.length >= 1), "case-insensitive hits keep their excerpts");
    // U12 migration (was: `["#onlytag"]`): a `tag:` excerpt is now the real document line
    // that carries the tag -- here the frontmatter key line -- not the synthetic chip.
    const tagged = await app.search("?q=tag%3Aonlytag&limit=50");
    assert.deepEqual(tagged.items.map((item) => item.path), ["Notes/tagged.md"]);
    assert.equal(tagged.items[0].matchCount, 1);
    assert.deepEqual(tagged.items[0].snippets, ["tags: [onlytag]"]);
    // Mixed query: both shapes merge under the same cap, text excerpts first (document
    // order), the tag's real line after them.
    const mixed = await app.search(`?q=${encodeURIComponent("tag:ztag zebra")}&limit=50`);
    assert.deepEqual(mixed.items.map((item) => item.path), ["Notes/multi.md"]);
    assert.equal(mixed.items[0].matchCount, 5, "4 text hits + 1 tag hit");
    assert.equal(mixed.items[0].snippets.length, 5, "both shapes merge under one cap");
    assert.equal(mixed.items[0].snippets[4], "tags: [ztag, done]");
    // A path hit keeps its single excerpt.
    const patted = await app.search("?q=path%3Amulti&limit=50");
    assert.deepEqual(patted.items.map((item) => item.path), ["Notes/multi.md"]);
    assert.equal(patted.items[0].snippets.length, 1);
    assert.ok(patted.items[0].snippets[0].includes("multi"));
    // More hits than the cap: the list is bounded at min(matchCount, 10) while the real
    // matchCount is still reported untouched.
    const capped = byPath.get("Notes/capped.md");
    assert.ok(capped, "the 12-hit note matched");
    assert.equal(capped.matchCount, 12);
    assert.equal(capped.snippets.length, 10, "the per-note excerpt cap is 10");
    assert.ok(capped.snippets.every((snippet) => snippet.includes("zebra")));
  } finally {
    await app.close();
  }
});
