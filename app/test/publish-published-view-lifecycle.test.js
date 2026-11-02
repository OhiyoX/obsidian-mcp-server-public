// Wave C / C3 — the public `published:` surfaces must agree with the Publish
// lifecycle (issues #277/#278, dev doc §8.1/§9/§17).
//
// Two invariants, both regressions that shipped before:
//
//   1. `published:` is a hard filter over the *registry*, never a frontmatter
//      property (#270). A note whose frontmatter says `published: true` but which was
//      never registered must not appear.
//   2. The candidate set is the **active** registry only (§9). An observed-orphaned
//      record whose path reappears later must not become a public candidate again
//      (#277 Level 1: "old id 永不因 path 重建而自动恢复"), while the old anonymous
//      URL stays 404.
//
// Real Express router + real session login + real catalog runtime + real
// PublishService. The path set is derived by `resolvePublishedPaths` in both the v2
// search route and the deprecated v1 notes route; the source-contract test at the
// bottom keeps that the only derivation of the public candidate set.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const appRoot = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-published-view-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
await fs.writeFile(path.join(vault, "Notes", "Live.md"), "# live\nregistered and active\n");
await fs.writeFile(path.join(vault, "Notes", "Gone.md"), "# gone\nwill be deleted then recreated\n");
await fs.writeFile(path.join(vault, "Notes", "Plain.md"), "# plain\nnever registered\n");
await fs.writeFile(path.join(vault, "Notes", "Decoy.md"), "---\npublished: true\n---\n# decoy\nfrontmatter lookalike\n");
await fs.writeFile(path.join(vault, "Notes", "Diagram.canvas"), "{}\n");

process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.WEB_CATALOG_ENABLED = "true";
delete process.env.WEB_VAULTS_ROOT;

const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests },
  { PublishService },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/publish/service.js"),
]);

const VAULT = defaultWebVaultId();
const STAMP = "2026-10-07T00:00:00.000Z";
const INVALID_ID = "J".repeat(43);
const stateFile = path.join(data, "publish", "state.json");

// A non-Markdown historical record (§12.3) can only come from a state file: `publish`
// is Markdown-only, so it is a fixture, not an API call.
await fs.mkdir(path.dirname(stateFile), { recursive: true });
await fs.writeFile(stateFile, `${JSON.stringify({
  version: 2,
  records: [{ id: INVALID_ID, vaultId: VAULT, path: "Notes/Diagram.canvas", lifecycle: "active", createdAt: STAMP, updatedAt: STAMP, createdBy: "fixture" }],
}, null, 2)}\n`, "utf8");

const publishService = new PublishService({ file: stateFile });
await publishService.ready;
const live = await publishService.publish(VAULT, "Notes/Live.md", { actor: "owner" });
const gone = await publishService.publish(VAULT, "Notes/Gone.md", { actor: "owner" });

// Observe the delete (as the Admin list / a status read does), then put the same path
// back on disk. The record must stay retired: the recreated note is *not* published.
await fs.rm(path.join(vault, "Notes", "Gone.md"));
await publishService.list({ includeInactive: true });
await fs.writeFile(path.join(vault, "Notes", "Gone.md"), "# gone\nrecreated at the same path\n");

const vaultRecord = await resolveWebVault(VAULT);
const catalog = getWebCatalogRuntime(vaultRecord);
catalog.setCoverage(true, "test");
await catalog.drain();

test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function startAuthedApp() {
  const user = {
    id: "user-published-view",
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read"],
    allowedVaults: [VAULT],
  };
  const provider = {
    authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
    oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
    recordAudit() {},
  };
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, publishService }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "password" }),
  });
  assert.equal(login.status, 303, "web login");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  return { base, cookie, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the published candidate set is the active registry and never a frontmatter field", async () => {
  const app = await startAuthedApp();
  try {
    const headers = { Cookie: app.cookie };
    const v2 = async (q) => {
      const response = await fetch(`${app.base}/api/web/v2/search?q=${encodeURIComponent(q)}`, { headers });
      assert.equal(response.status, 200, `v2 search ${q}`);
      return (await response.json()).items.map((item) => item.path);
    };
    const v1 = async (q) => {
      const response = await fetch(`${app.base}/api/web/v1/notes?q=${encodeURIComponent(q)}`, { headers });
      assert.equal(response.status, 200, `v1 notes ${q}`);
      return (await response.json()).notes.map((item) => item.path);
    };

    // §9 + #270: the active registry only; the frontmatter decoy never appears.
    assert.deepEqual(await v2("published:true"), ["Notes/Live.md"]);
    assert.deepEqual(await v1("published:true"), ["Notes/Live.md"]);

    // The complement is every *live* note that is not a public candidate. The
    // recreated orphan note is back on disk, so it belongs here — and only here.
    const v2Private = await v2("published:false");
    assert.ok(v2Private.includes("Notes/Plain.md"), "an unregistered note is private");
    assert.ok(v2Private.includes("Notes/Decoy.md"), "a frontmatter published:true note is private (#270)");
    assert.ok(v2Private.includes("Notes/Gone.md"), "the recreated orphan path is private, not public");
    assert.equal(v2Private.includes("Notes/Live.md"), false, "an active record is not private");
    const v1Private = await v1("published:false");
    assert.ok(v1Private.includes("Notes/Gone.md"), "v1 agrees: the recreated orphan path is private");
    assert.equal(v1Private.includes("Notes/Live.md"), false, "v1 agrees: an active record is not private");

    // §9/§7: the anonymous page follows the same state, and the retired ids stay dead.
    assert.equal((await fetch(`${app.base}/publish/${live.id}`)).status, 200, "the active id still serves");
    assert.equal((await fetch(`${app.base}/publish/${gone.id}`)).status, 404, "the observed-orphan id never revives");
    assert.equal((await fetch(`${app.base}/publish/${INVALID_ID}`)).status, 404, "an invalid record is not served");

    // Reading the surfaces must not have revived the retired record (§5.1).
    const lifecycles = Object.fromEntries((await JSON.parse(await fs.readFile(stateFile, "utf8"))).records.map((record) => [record.id, record.lifecycle]));
    assert.deepEqual(lifecycles, { [live.id]: "active", [gone.id]: "orphaned", [INVALID_ID]: "invalid" });
  } finally {
    await app.close();
  }
});

test("the public candidate set has exactly one derivation (source contract)", async () => {
  const entries = await fs.readdir(path.join(appRoot, "src", "app"), { withFileTypes: true, recursive: true });
  const sources = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    sources.push([path.relative(appRoot, file).split(path.sep).join("/"), await fs.readFile(file, "utf8")]);
  }

  const calls = [];
  for (const [relative, content] of sources) {
    for (const [index, line] of content.split("\n").entries()) {
      if (/publishService\s*\.\s*list\s*\(/.test(line)) calls.push(`${relative}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(calls.length, 1, `the published path set must be derived once, found: ${JSON.stringify(calls)}`);
  assert.match(calls[0], /^src\/app\/web-catalog\/search-api\.js:\d+: const records = await publishService\.list\(\{ vaultIds: \[vaultId\] \}\);/,
    "the single derivation is resolvePublishedPaths and requests the active registry only");
  assert.equal(/includeInactive/.test(calls[0]), false, "the public candidate set may never include inactive records");

  const searchApi = sources.find(([relative]) => relative === "src/app/web-catalog/search-api.js")[1];
  assert.match(searchApi, /export async function resolvePublishedPaths\(publishService, vaultId\)/, "the helper stays exported");
  assert.match(searchApi, /paths: await resolvePublishedPaths\(publishService, vault\.id\)/, "the search route uses the helper");

  // The Admin list is the deliberate other half: it must request the retired rows
  // (§9/§17) — if it ever falls back to the default, cleanup becomes unreachable. The Admin plane is
  // assembled in one place now (`catalog.js`); the retired `auth-center.js` is gone.
  const admin = await fs.readFile(path.join(appRoot, "src", "admin", "catalog.js"), "utf8");
  assert.match(admin, /publishService\.list\(\{ includeInactive: true \}\)/, "the Admin list must read every lifecycle");
});
