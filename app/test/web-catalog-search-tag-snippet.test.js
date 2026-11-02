// U12: the v2 search API must return REAL document lines for `tag:` clauses (desktop shape).
//
// Real Express router + real session login + real catalog runtime + real file reads, so the
// assertion "every excerpt is findable in the note's own text" is checked against the bytes
// on disk rather than a fixture object.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-tag-snippets-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
const notes = {
  // The desktop reference line, verbatim from the user's screenshot.
  "Notes/scalar.md": "---\ntags: obsidian mcp oauth deployment\n---\nBody without any tag line.\n",
  // `type: deployment` is a frontmatter value, never a tag.
  "Notes/block.md": "---\ntype: deployment\ntags:\n  - memory\n  - inbox\n---\nBody.\n",
  // The U22 desktop reference: a real block list rendered as `tags: a b c` (U22 fixtures).
  "Notes/wordpress.md": "---\ntags:\n  - wordpress\n  - 运维\n  - mcp\n  - ops-host\n---\nBody.\n",
  // A folded (`>-`) tags scalar: real tags, no single line that carries them.
  "Notes/folded.md": "---\ntags: >-\n  alpha\n  beta\n---\nBody.\n",
  "Notes/nested.md": "---\ntags: [web/deploy, other]\n---\nBody.\n",
  "Notes/inline.md": "---\ntitle: inline note\n---\nThe first line mentions #memory inline.\nSecond line.\n",
  // `#fenced` lives only inside a code fence: not an inline tag, so not a hit.
  "Notes/fenced.md": '---\ntitle: fenced\n---\n```js\nconst x = "#fenced";\n```\nNo real tag.\n',
  // A CRLF note (this Vault really has them): the `tags:` line must not be lost to the `\r`.
  "Notes/crlf.md": ["---", "type: memory", "tags:", "  - memory", "  - nas", "---", "Body."].join("\r\n"),
  // A YAML flow list spread over two lines: a real tag with no single line that carries it.
  "Notes/multiline.md": "---\ntags: [lonely,\n  nested]\n---\nBody.\n",
};
for (const [name, raw] of Object.entries(notes)) await fs.writeFile(path.join(vault, ...name.split("/")), raw);
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
    id: "user-tag-snippet",
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

// A synthetic `#tag` chip is the shape this slice removes; a real excerpt is a window of a
// document line, so everything outside the window's `…` markers must exist in the raw file.
function assertRealExcerpt(snippet, raw, needle) {
  assert.notEqual(snippet, `#${needle}`, "the excerpt is no longer the synthetic chip");
  const body = snippet.replace(/^…/, "").replace(/…$/, "").trim();
  assert.ok(body.length > 0, "the excerpt is not empty");
  assert.ok(raw.includes(body), `excerpt ${JSON.stringify(snippet)} is a real line of the note`);
  assert.ok(snippet.includes(needle), `excerpt ${JSON.stringify(snippet)} carries the queried tag name`);
}

// U22: a block-list excerpt is the desktop-flattened `tags: a b c` line, which is not a
// contiguous fragment of the raw bytes (the file has `tags:` plus indented bullets). It is
// verified verbatim against the block's own values, each of which must be a real bullet.
function assertBlockExcerpt(snippet, raw, key, values) {
  assert.equal(snippet, `${key}: ${values.join(" ")}`);
  for (const value of values) {
    assert.ok(raw.includes(`- ${value}`), `the block value ${JSON.stringify(value)} is a real bullet of the note`);
  }
}

test("tag: queries excerpt the real document lines and keep matchCount", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();

  const app = await startAuthedApp();
  try {
    // 1. The desktop reference: a scalar `tags:` line, matched by `tag:#X`.
    const deployment = await app.search("?q=tag%3A%23deployment&limit=50");
    assert.deepEqual(deployment.items.map((item) => item.path), ["Notes/scalar.md"], "`type: deployment` is not a tag hit");
    assert.equal(deployment.items[0].matchCount, 1);
    assert.deepEqual(deployment.items[0].snippets, ["tags: obsidian mcp oauth deployment"]);
    assertRealExcerpt(deployment.items[0].snippets[0], notes["Notes/scalar.md"], "deployment");
    // The same clause written without `#` behaves identically.
    const noHash = await app.search("?q=tag%3Adeployment&limit=50");
    assert.deepEqual(noHash.items, deployment.items);

    // 2. A block-list frontmatter tag: the whole list flattened to one desktop-style line.
    const memory = await app.search("?q=tag%3A%23memory&limit=50");
    const memoryByPath = new Map(memory.items.map((item) => [item.path, item]));
    assert.deepEqual([...memoryByPath.keys()].sort(), ["Notes/block.md", "Notes/crlf.md", "Notes/inline.md"]);
    assert.equal(memoryByPath.get("Notes/block.md").matchCount, 1);
    assert.deepEqual(memoryByPath.get("Notes/block.md").snippets, ["tags: memory inbox"]);
    assertBlockExcerpt(memoryByPath.get("Notes/block.md").snippets[0], notes["Notes/block.md"], "tags", ["memory", "inbox"]);
    // CRLF note: the same flattened line, with no carriage return in the excerpt.
    assert.deepEqual(memoryByPath.get("Notes/crlf.md").snippets, ["tags: memory nas"]);
    assertBlockExcerpt(memoryByPath.get("Notes/crlf.md").snippets[0], notes["Notes/crlf.md"], "tags", ["memory", "nas"]);
    assert.deepEqual(memoryByPath.get("Notes/inline.md").snippets, ["The first line mentions #memory inline."]);
    assertRealExcerpt(memoryByPath.get("Notes/inline.md").snippets[0], notes["Notes/inline.md"], "memory");

    // 2b. The desktop reference string, verbatim, from a real block list (U22).
    const mcp = await app.search(`?q=${encodeURIComponent("tag:mcp")}&limit=50`);
    const mcpByPath = new Map(mcp.items.map((item) => [item.path, item]));
    assert.deepEqual(mcpByPath.get("Notes/wordpress.md").snippets, ["tags: wordpress 运维 mcp ops-host"]);
    assertBlockExcerpt(mcpByPath.get("Notes/wordpress.md").snippets[0], notes["Notes/wordpress.md"], "tags", ["wordpress", "运维", "mcp", "ops-host"]);

    // 3. Nested tags keep the evaluator's parent semantics.
    const parent = await app.search(`?q=${encodeURIComponent("tag:web")}&limit=50`);
    assert.deepEqual(parent.items.map((item) => item.path), ["Notes/nested.md"]);
    assert.equal(parent.items[0].matchCount, 1);
    assert.deepEqual(parent.items[0].snippets, ["tags: [web/deploy, other]"]);
    assertRealExcerpt(parent.items[0].snippets[0], notes["Notes/nested.md"], "web");

    // 4. A tag the index never counted, and a tag with no single real line.
    const fenced = await app.search(`?q=${encodeURIComponent("tag:#fenced")}&limit=50`);
    assert.deepEqual(fenced.items, [], "a fenced `#fenced` is not a tag and cannot become an excerpt");
    const fallback = await app.search(`?q=${encodeURIComponent("tag:#nested")}&limit=50`);
    assert.deepEqual(fallback.items.map((item) => item.path), ["Notes/multiline.md"]);
    assert.equal(fallback.items[0].matchCount, 1, "matchCount is untouched by the excerpt change");
    assert.deepEqual(fallback.items[0].snippets, ["#nested"], "no real line: the frozen fallback stays");
    // A folded (`>-`) tags scalar: the index counts `alpha`, but no line carries it.
    const folded = await app.search(`?q=${encodeURIComponent("tag:#alpha")}&limit=50`);
    assert.deepEqual(folded.items.map((item) => item.path), ["Notes/folded.md"]);
    assert.deepEqual(folded.items[0].snippets, ["#alpha"], "no line carries a folded scalar -> frozen fallback stays");

    // 5. Non-tag clauses are untouched by this slice.
    const byText = await app.search("?q=Body&limit=50");
    assert.ok(byText.items.every((item) => item.snippets.every((snippet) => snippet.includes("Body"))));
    const byPath = await app.search("?q=path%3ANotes%2Fscalar&limit=50");
    assert.deepEqual(byPath.items.map((item) => item.path), ["Notes/scalar.md"]);
    assert.equal(byPath.items[0].snippets.length, 1);
    const byProp = await app.search("?q=%5Btitle%3Ainline%20note%5D&limit=50");
    assert.deepEqual(byProp.items.map((item) => item.path), ["Notes/inline.md"]);
    assert.deepEqual(byProp.items[0].snippets, ["[title: inline note]"]);
  } finally {
    await app.close();
  }
});
