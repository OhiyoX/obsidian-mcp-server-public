// A4b: the `.base` write surface over HTTP — `PATCH /api/web/v1/base` (A4a
// increments) and its raw view `GET /api/web/v1/base/raw`.
//
// Real Express router + real session login + real CSRF token + real disk, so the
// write pipeline (401 → 403 scope → 403 CSRF → 428/409/404/422 → 200 + audit) is
// exercised through `createWebAppRouter` instead of a standalone mount. The two
// standalone mounts at the end are the negative controls: they replace only the
// domain function, to show the CAS assertion and the atomicity assertion are both
// sensitive to what they claim to measure.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-patch-"));
const vault = path.join(root, "default");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.WEB_DEFAULT_VAULT = "default";
// Production default (web-catalog/runtime.js:isWebCatalogEnabled defaults to true): the
// write path must also refresh the catalog for a `.base`, so the gate runs with it ON.
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
delete process.env.WEB_VAULTS_ROOT;
delete process.env.OBSIDIAN_READ_ONLY;

const [
  { createWebAppRouter },
  { registerBasePatchRoute },
  { readBaseInRoot },
  { patchBaseDocument },
  { getWebCatalogRuntimeById, __resetWebCatalogRuntimesForTests },
  { resolveWebVault, defaultWebVaultId, writeWebBasePatch },
  { MAX_PATCH_MUTATIONS, MAX_PATCH_MUTATION_BYTES },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/base-patch-route.js"),
  import("../src/app/base-reader.js"),
  import("../src/base-patch.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/vault-registry.js"),
  import("../src/base-patch-budget.js"),
]);

// A representative `.base`: a leading comment, an unknown top-level *flow* map, a
// single-quoted view name, a block-level unknown key inside the view we do NOT
// patch, and a CRLF/LF mix. Only line 6 (`    limit: 10`) may ever change.
const PLAN_LINES = [
  ["# Boards view definitions", "\r\n"],
  ['filters: file.inFolder("Boards")', "\n"],
  ["unrecognizedData: {zzz: 1}", "\r\n"],
  ["views:", "\n"],
  ["  - type: table", "\r\n"],
  ["    name: 'First'", "\n"],
  ["    limit: 10", "\r\n"],
  ["    order:", "\n"],
  ["      - file.name", "\r\n"],
  ["  - type: table", "\n"],
  ["    name: Second", "\n"],
  ["    limit: 5", "\n"],
  ["    unrecognizedData:", "\n"],
  ["      zzz: keep", "\n"],
];
const PLAN_BASE = PLAN_LINES.map(([text, eol]) => text + eol).join("");
const PLAN_LIMIT_LINE = 6;

// Inline comment inside the patched view item ⇒ the locator refuses the region.
const ANCHORS_BASE = [
  "views:\n",
  "  - type: table\n",
  "    name: Only\n",
  "    limit: 10 # capped\n",
].join("");
const PARTIAL_BASE = ["views:\n", "  - type: table\n", "    name: Only\n", "    limit: 10\n"].join("");

const USERS = {
  writer: {
    id: "user-writer",
    username: "writer",
    displayName: "Writer",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["default"],
  },
  reader: {
    id: "user-reader",
    username: "reader",
    displayName: "Reader",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read"],
    allowedVaults: ["default"],
  },
};

let audits = [];
const providerFor = () => ({
  authenticateOAuthUser: async (username, password) => (password === "password" && USERS[username] ? USERS[username] : null),
  oauthUserSessionRecord: async (id) => Object.values(USERS).find((user) => user.id === id) ?? null,
  recordAudit: (entry) => audits.push(entry),
});

const sha256 = (text) => `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
const planPath = path.join(vault, "Boards", "Plan.base");
const readDisk = (file = planPath) => fs.readFile(file, "utf8");
const writeFixtures = async ({ plan = PLAN_BASE, anchors = ANCHORS_BASE, partial = PARTIAL_BASE } = {}) => {
  await fs.mkdir(path.join(vault, "Boards"), { recursive: true });
  await fs.writeFile(planPath, plan, "utf8");
  await fs.writeFile(path.join(vault, "Anchors.base"), anchors, "utf8");
  await fs.writeFile(path.join(vault, "Partial.base"), partial, "utf8");
  await fs.writeFile(path.join(vault, "Notes.md"), "# note\n", "utf8");
};

async function startApp() {
  audits = [];
  const app = express();
  app.use(createWebAppRouter({ provider: providerFor(), secureCookie: false }));
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password: "password" }),
    });
    assert.equal(response.status, 303, `login failed for ${username}`);
    const cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const html = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
    return { cookie, csrf };
  };
  return {
    base,
    writer: await login("writer"),
    reader: await login("reader"),
    close: () => new Promise((resolve) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const rawView = (app, query, headers = {}) =>
  fetch(`${app.base}/api/web/v1/base/raw${query}`, { headers: { Cookie: app.writer.cookie, ...headers } });

const patchBase = (app, auth, body, headers = {}) =>
  fetch(`${app.base}/api/web/v1/base`, {
    method: "PATCH",
    headers: { Cookie: auth.cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf, ...headers },
    body: JSON.stringify(body),
  });

const limitTo25 = [{ op: "set-view-option", view: "First", key: "limit", value: 25 }];

// The catalog runtime is created lazily by the write path; drain it so the node read
// below is deterministic instead of racing the background reconcile.
const runtimeDrain = async () => {
  const catalog = getWebCatalogRuntimeById("default");
  if (catalog) await catalog.drain();
};

test.before(async () => {
  // One clean catalog for the whole file, exactly like the production wiring gate.
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntimeById(vaultRecord.id);
  if (catalog) {
    catalog.setCoverage(true, "test");
    await catalog.drain();
  }
});
test.beforeEach(async () => {
  await writeFixtures();
});
test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

test("① raw view: ETag/revision of the bytes on disk, 304 on If-None-Match, frozen DTO route untouched", async () => {
  const app = await startApp();
  try {
    const response = await rawView(app, "?path=Boards/Plan.base");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.equal(response.headers.get("etag"), `"${sha256(PLAN_BASE)}"`);
    const body = await response.json();
    assert.equal(body.path, "Boards/Plan.base");
    assert.equal(body.vaultId, "default");
    assert.equal(body.content, PLAN_BASE, "the raw view returns the document bytes, not a DTO");
    assert.equal(body.revision, sha256(PLAN_BASE));
    assert.equal(body.stat.size, Buffer.byteLength(PLAN_BASE, "utf8"));
    assert.equal(typeof body.stat.mtimeMs, "number");

    const notModified = await rawView(app, "?path=Boards/Plan.base", { "If-None-Match": response.headers.get("etag") });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");

    // The frozen A3 query DTO lives on its own route and still validates first:
    // an empty `path` is rejected before any Vault/catalog access.
    const dto = await fetch(`${app.base}/api/web/v1/base`, { headers: { Cookie: app.writer.cookie } });
    assert.equal(dto.status, 400);
    assert.deepEqual(await dto.json(), { error: "invalid-path" });
  } finally {
    await app.close();
  }
});

test("② successful PATCH: new revision, one changed line, unknown keys/comments/CRLF preserved, audit recorded", async () => {
  const app = await startApp();
  try {
    const before = await readDisk();
    const beforeEtag = (await rawView(app, "?path=Boards/Plan.base")).headers.get("etag");
    const response = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: limitTo25 }, { "If-Match": beforeEtag });
    assert.equal(response.status, 200);
    const body = await response.json();
    const after = await readDisk();

    assert.equal(body.changed, true);
    assert.equal(body.path, "Boards/Plan.base");
    assert.equal(body.previousRevision, sha256(before));
    assert.equal(body.revision, sha256(after));
    assert.notEqual(body.revision, body.previousRevision);
    assert.equal(body.size, Buffer.byteLength(after, "utf8"));

    // The A4a assertion口径: exactly one line differs, and the rest of the bytes
    // (comments, unknown keys, CRLF/LF mix, quote style) are identical.
    const beforeLines = before.split(/(?<=\n)/);
    const afterLines = after.split(/(?<=\n)/);
    assert.equal(afterLines.length, beforeLines.length);
    const differing = beforeLines.map((line, index) => (line === afterLines[index] ? null : index)).filter((index) => index !== null);
    assert.deepEqual(differing, [PLAN_LIMIT_LINE], "exactly one line may change");
    assert.equal(afterLines[PLAN_LIMIT_LINE], "    limit: 25\r\n", "the patched line keeps its CRLF");
    assert.equal(afterLines[PLAN_LIMIT_LINE - 1], "    name: 'First'\n", "single quotes survive");
    assert.equal((after.match(/\r\n/g) || []).length, (before.match(/\r\n/g) || []).length, "CRLF count unchanged");
    assert.match(after, /unrecognizedData: \{zzz: 1\}/, "unknown top-level flow map survives");
    assert.match(after, /# Boards view definitions/, "leading comment survives");
    assert.match(after, /      zzz: keep/, "the other view's unknown key survives");
    assert.match(after, /    name: Second\n    limit: 5\n    unrecognizedData:/, "untouched view keeps its exact bytes");

    const audit = audits.filter((entry) => entry.action === "web.base.patch");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail, "default:Boards/Plan.base");
    assert.equal(audit[0].credentialType, "web-session");
    assert.equal(audit[0].credentialId, "user-writer");

    // The raw view now serves the new bytes under the NEW ETag (read-your-writes) —
    // a constant/hash-of-nothing revision would make the CAS loop look green while
    // proving nothing, so the closed loop asserts the tag actually moved.
    const reread = await rawView(app, "?path=Boards/Plan.base");
    assert.equal(reread.headers.get("etag"), `"${sha256(after)}"`);
    assert.notEqual(reread.headers.get("etag"), beforeEtag);
    assert.equal((await reread.json()).content, after);

    // Catalog read-your-writes with the production default (catalog enabled): a `.base`
    // write refreshes the node, it does not 500 after the rename.
    await runtimeDrain();
    const node = getWebCatalogRuntimeById("default").store.locate("Boards/Plan.base");
    assert.ok(node, "the patched Base is a catalog node");
    assert.equal(node.revision, body.revision);
  } finally {
    await app.close();
  }
});

test("③ stale If-Match ⇒ 409 with currentRevision/stat of the bytes on disk", async () => {
  const app = await startApp();
  try {
    const staleEtag = (await rawView(app, "?path=Boards/Plan.base")).headers.get("etag");
    const first = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: limitTo25 }, { "If-Match": staleEtag });
    assert.equal(first.status, 200);

    const disk = await readDisk();
    const stale = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 99 }] }, { "If-Match": staleEtag });
    assert.equal(stale.status, 409);
    const rawText = await stale.text();
    const body = JSON.parse(rawText);
    assert.equal(body.error, "revision-conflict");
    assert.equal(body.path, "Boards/Plan.base");
    assert.equal(body.expectedRevision, staleEtag.replaceAll('"', ""));
    assert.equal(body.currentRevision, sha256(disk), "currentRevision must equal the value on disk");
    assert.equal(body.stat.size, Buffer.byteLength(disk, "utf8"));
    assert.equal(typeof body.stat.mtimeMs, "number");
    assert.equal(await readDisk(), disk, "a 409 must not touch the file");
    assert.deepEqual((await fs.readdir(path.join(vault, "Boards"))).filter((name) => name.includes(".tmp")), [], "no temp file survives a conflict");

    // 脱敏：the 409 body carries only safe fields — no absolute path, no vault root, no
    // uid/gid/prefixed path. Pinned on the serialised response, not on a field list.
    assert.equal(rawText.includes(vault), false, "the 409 body must not contain the vault root");
    assert.equal(rawText.includes(root), false, "the 409 body must not contain the temp root");
    assert.deepEqual(Object.keys(body).sort(), ["code", "currentRevision", "error", "expectedRevision", "path", "stat"]);
    assert.deepEqual(Object.keys(body.stat).sort(), ["modified", "mtimeMs", "size"]);

    // A stale `expectedRevision` is stated, never guessed.
    assert.equal(body.expectedRevision.startsWith("sha256:"), true);
    assert.notEqual(body.expectedRevision, body.currentRevision);
  } finally {
    await app.close();
  }
});

test("④ missing If-Match ⇒ 428 and no bytes change (body ifMatch is the accepted fallback)", async () => {
  const app = await startApp();
  try {
    const before = await readDisk();
    const missing = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: limitTo25 });
    assert.equal(missing.status, 428);
    const body = await missing.json();
    assert.equal(body.code, "precondition-required");
    // "refused" is a byte-level claim: same sha256, and no half-written temp file.
    assert.equal(sha256(await readDisk()), sha256(before), "a blind write must leave the document alone");
    assert.deepEqual((await fs.readdir(path.join(vault, "Boards"))).filter((name) => name.includes(".tmp")), []);

    // Same refusal when the body carries neither form of the precondition.
    const empty = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: limitTo25, ifMatch: "" });
    assert.equal(empty.status, 428);
    assert.equal(sha256(await readDisk()), sha256(before));
    // A 400 (malformed precondition value is not a token, so it is simply a mismatch;
    // a malformed *request* is 400) also writes nothing.
    const badPath = await patchBase(app, app.writer, { path: "", mutations: limitTo25 }, { "If-Match": `"${sha256(before)}"` });
    assert.equal(badPath.status, 400);
    assert.equal(sha256(await readDisk()), sha256(before));
    assert.deepEqual((await fs.readdir(path.join(vault, "Boards"))).filter((name) => name.includes(".tmp")), []);

    // Body `ifMatch` is honoured when the header is absent (§4.1: the brief's body form).
    const viaBody = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: limitTo25, ifMatch: sha256(before) });
    assert.equal(viaBody.status, 200);
    assert.equal((await viaBody.json()).changed, true);
    assert.notEqual(await readDisk(), before);

    // `If-Match: *` = "any existing representation": allowed, no revision compare.
    const current = await readDisk();
    const anyMatch = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 7 }] }, { "If-Match": "*" });
    assert.equal(anyMatch.status, 200);
    assert.notEqual(await readDisk(), current);
  } finally {
    await app.close();
  }
});

test("⑤ domain refusals: 422 base-not-patchable / base-unknown-key, 400 invalid schema, no write", async () => {
  const app = await startApp();
  try {
    const before = await readDisk();
    const tag = `"${sha256(before)}"`;

    const unknownKey = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: [{ op: "set-view-option", view: "First", key: "zzz", value: 1 }] }, { "If-Match": tag });
    assert.equal(unknownKey.status, 422);
    const unknownKeyBody = await unknownKey.json();
    assert.equal(unknownKeyBody.code, "base-unknown-key");
    assert.match(unknownKeyBody.message, /writable view keys/);

    const anchorsBefore = await readDisk(path.join(vault, "Anchors.base"));
    const notPatchable = await patchBase(app, app.writer, { path: "Anchors.base", mutations: [{ op: "set-view-option", view: "Only", key: "limit", value: 20 }] }, { "If-Match": `"${sha256(anchorsBefore)}"` });
    assert.equal(notPatchable.status, 422);
    const notPatchableBody = await notPatchable.json();
    assert.equal(notPatchableBody.code, "base-not-patchable");
    assert.match(notPatchableBody.message, /not line-patchable/i);

    const invalidSchema = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: [{ op: "set-view-option", view: "First", key: "limit" }] }, { "If-Match": tag });
    assert.equal(invalidSchema.status, 400);
    assert.equal((await invalidSchema.json()).code, "invalid-schema");

    const emptyBatch = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: [] }, { "If-Match": tag });
    assert.equal(emptyBatch.status, 400);

    assert.equal(await readDisk(), before, "no refused request may write");
    assert.equal(await readDisk(path.join(vault, "Anchors.base")), anchorsBefore);
    // Fail-closed also means no leftover temp file from the refused paths.
    const entries = await fs.readdir(path.join(vault, "Boards"));
    assert.deepEqual(entries.filter((name) => name.includes(".tmp")), []);
  } finally {
    await app.close();
  }
});

test("⑥ path gate: traversal / absolute / non-.base / symlink ⇒ 404 and nothing written", async () => {
  const app = await startApp();
  try {
    const before = await readDisk();
    const outside = path.join(root, "outside.base");
    await fs.writeFile(outside, "views:\n", "utf8");
    let symlinkDir = null;
    try {
      symlinkDir = path.join(vault, "linkdir");
      await fs.symlink(path.join(vault, "Boards"), symlinkDir, "dir");
    } catch {
      symlinkDir = null; // symlinks are not always available on Windows
    }

    const tag = `"${sha256(before)}"`;
    const cases = [
      ["../outside.base", 404],
      ["/abs/outside.base", 404],
      ["Boards/Plan.md", 404],
      ["Missing.base", 404],
      ["Boards\\Plan.base", 404],
      ["Boards/Plan.base/", 404],
      [path.join(root, "outside.base"), 404],
      ...(symlinkDir ? [["linkdir/Plan.base", 404]] : []),
    ];
    for (const [candidate, status] of cases) {
      const response = await patchBase(app, app.writer, { path: candidate, mutations: limitTo25 }, { "If-Match": tag });
      assert.equal(response.status, status, `expected ${status} for ${JSON.stringify(candidate)}`);
    }
    assert.equal(await readDisk(), before, "no rejected path may write the Base");
    assert.equal(await fs.readFile(outside, "utf8"), "views:\n", "no write outside the vault root");
    if (symlinkDir) {
      const viaSymlink = await patchBase(app, app.writer, { path: "linkdir/Plan.base", mutations: limitTo25 }, { "If-Match": tag });
      assert.equal(viaSymlink.status, 404, "a symlinked parent directory must not be patched through");
      assert.equal(await readDisk(), before);
    }
  } finally {
    await app.close();
  }
});

test("⑦⑧ the write pipeline: unauthenticated 401, no obsidian.write 403, missing CSRF 403", async () => {
  const app = await startApp();
  try {
    const before = await readDisk();
    const tag = `"${sha256(before)}"`;
    const body = JSON.stringify({ path: "Boards/Plan.base", mutations: limitTo25 });

    const anonymous = await fetch(`${app.base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": tag }, body });
    assert.equal(anonymous.status, 401);

    const noScope = await patchBase(app, app.reader, { path: "Boards/Plan.base", mutations: limitTo25 }, { "If-Match": tag });
    assert.equal(noScope.status, 403);
    assert.deepEqual(await noScope.json(), { error: "Account does not have write permission" });

    const noCsrf = await fetch(`${app.base}/api/web/v1/base`, { method: "PATCH", headers: { Cookie: app.writer.cookie, "Content-Type": "application/json", "If-Match": tag }, body });
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(await noCsrf.json(), { error: "CSRF validation failed" });

    // The read-class gate is not a write gate: a read-only session cannot patch even
    // though it can read the raw view.
    const readerRead = await fetch(`${app.base}/api/web/v1/base/raw?path=Boards/Plan.base`, { headers: { Cookie: app.reader.cookie } });
    assert.equal(readerRead.status, 200);

    assert.equal(await readDisk(), before, "no rejected request may write");
    assert.deepEqual(audits.filter((entry) => entry.action === "web.base.patch"), []);
  } finally {
    await app.close();
  }
});

// ── ⑨ negative controls ──────────────────────────────────────────────────────
// Both mount the same route with a replacement domain function; only the property
// under test changes, so a green result here means the assertion in ③ / the
// atomicity claim is *not* vacuous.

function variantApp(writeBasePatch, published, readBase = readBaseInRoot, checkMutationBudget = undefined) {
  const app = express();
  app.use((req, _res, next) => {
    req.webSession = { ...USERS.writer, vaultId: "default" };
    next();
  });
  const router = express.Router();
  registerBasePatchRoute(router, {
    requireApi: (_req, _res, next) => next(),
    requireCsrf: (_req, _res, next) => next(),
    currentVault: async () => ({ id: "default", root: vault, primary: false }),
    provider: { recordAudit() {} },
    readBase,
    writeBasePatch,
    checkMutationBudget,
    publishMutation: (payload) => published.push(payload),
  });
  app.use(router);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("⑨a negative control: dropping the CAS check makes ③ red (stale If-Match would be 200)", async () => {
  const published = [];
  const casLess = async (_vault, userPath, mutations) => {
    const absolute = path.join(vault, userPath);
    const raw = await fs.readFile(absolute, "utf8");
    const next = patchBaseDocument(raw, mutations);
    await fs.writeFile(absolute, next, "utf8");
    return { path: userPath, changed: true, revision: sha256(next), previousRevision: sha256(raw), size: Buffer.byteLength(next) };
  };
  const server = await listen(variantApp(casLess, published));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await readDisk();
    const tag = `"${sha256(before)}"`;
    // First write with the *current* tag, then replay it: a CAS-less implementation
    // accepts both, so ③'s `assert.equal(status, 409)` would be red here.
    const first = await fetch(`${base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": tag }, body: JSON.stringify({ path: "Boards/Plan.base", mutations: limitTo25 }) });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": tag }, body: JSON.stringify({ path: "Boards/Plan.base", mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 99 }] }) });
    assert.equal(replay.status, 200, "without CAS the stale replay is accepted (③ is sensitive to it)");
    assert.notEqual(replay.status, 409);

    // Item 5 of the brief: the mutation broadcast carries exactly the note route's fields.
    assert.ok(published.length >= 2);
    assert.deepEqual(Object.keys(published[0]).sort(), ["created", "mutationId", "origin", "path", "revision", "size", "vaultId"]);
    assert.equal(published[0].path, "Boards/Plan.base");
    assert.equal(published[0].origin, "web");
    assert.equal(published[0].created, false);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("⑨c negative control: a size-derived ETag keeps the loop green while proving nothing (组1's two assertions go red)", async () => {
  // 组4 注入：把**读端点的 ETag 来源**从内容 hash 换成非内容寻址的令牌 —— 这里用
  // `size:<bytes>`（被设计否决的 mtime/size 复合值的**确定性退化**：`10 → 25` 不改变
  // 字节数，所以“改了内容而标签不动”必然发生；纯 mtime 版本会因毫秒精度而抖动，不能做钉子）。
  // 写面用同一套令牌做 CAS，以便观察“同一标签再写”是否还能成功。
  const sizeToken = (raw) => `size:${Buffer.byteLength(raw, "utf8")}`;
  const sizeEtagReadBase = async (v, rel) => {
    const base = await readBaseInRoot(v, rel);
    return { ...base, revision: sizeToken(base.raw) };
  };
  const sizeCasPatch = async (v, userPath, mutations, ifMatch) => {
    const absolute = path.join(v.root, userPath);
    const raw = await fs.readFile(absolute, "utf8");
    if (ifMatch !== sizeToken(raw)) {
      const conflict = new Error("Revision conflict");
      conflict.code = "BASE_REVISION_CONFLICT";
      conflict.path = userPath;
      conflict.expectedRevision = ifMatch;
      conflict.currentRevision = sizeToken(raw);
      conflict.stat = { size: Buffer.byteLength(raw, "utf8"), mtimeMs: 0, modified: new Date(0).toISOString() };
      throw conflict;
    }
    const next = patchBaseDocument(raw, mutations);
    await fs.writeFile(absolute, next, "utf8");
    return { path: userPath, changed: true, revision: sizeToken(next), previousRevision: sizeToken(raw), size: Buffer.byteLength(next, "utf8") };
  };
  const server = await listen(variantApp(sizeCasPatch, [], sizeEtagReadBase));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const etag1 = (await fetch(`${base}/api/web/v1/base/raw?path=Boards/Plan.base`)).headers.get("etag");
    const first = await fetch(`${base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": etag1 }, body: JSON.stringify({ path: "Boards/Plan.base", mutations: limitTo25 }) });
    assert.equal(first.status, 200);
    const etag2 = (await fetch(`${base}/api/web/v1/base/raw?path=Boards/Plan.base`)).headers.get("etag");
    assert.equal(await readDisk(), PLAN_BASE.replace("limit: 10", "limit: 25"), "the document really changed");
    // 组1 的第一条断言（`ETag2 !== ETag1`）在这一注入下**必须红**：内容变了，标签没变。
    assert.equal(etag2, etag1, "a size-derived ETag cannot move (组1 first assertion is RED here)");
    assert.equal(etag2 === etag1, true);

    // 组1 的第二条断言（“同一 ETag1 再 PATCH ⇒ 409”）同样**必须红**：CAS 拿旧标签又成功了。
    const replay = await fetch(`${base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": etag1 }, body: JSON.stringify({ path: "Boards/Plan.base", mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 7 }] }) });
    assert.equal(replay.status, 200, "a stale tag is still accepted (组1 second assertion is RED here)");
    assert.notEqual(replay.status, 409);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("⑩ amplification budget (§4.4/§5.3): 513 entries ⇒ 413, 512 entries > 256 KB ⇒ 413, exactly at both caps ⇒ 200, and no refusal writes", async () => {
  const app = await startApp();
  try {
    const before = await readDisk();
    const tag = `"${sha256(before)}"`;
    const repeat = (count) => Array.from({ length: count }, () => ({ op: "set-view-option", view: "First", key: "limit", value: 25 }));
    const tmpNames = async () => (await fs.readdir(path.join(vault, "Boards"))).filter((name) => name.includes(".tmp"));

    // ① one entry over the count cap
    const overCount = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: repeat(MAX_PATCH_MUTATIONS + 1) }, { "If-Match": tag });
    assert.equal(overCount.status, 413, "an over-count increment is a 413, never a 200");
    const overCountBody = await overCount.json();
    assert.equal(overCountBody.code, "BASE_MUTATIONS_TOO_LARGE");
    assert.match(overCountBody.message, new RegExp(`${MAX_PATCH_MUTATIONS + 1} of at most ${MAX_PATCH_MUTATIONS}`));
    assert.equal(sha256(await readDisk()), sha256(before), "a refused budget must not write");
    assert.deepEqual(await tmpNames(), []);

    // ② exactly 512 entries, over the byte cap: the *values* are nonsense for a `.base`
    // (they would be 422 later), which is the point — the budget is refused before the
    // increment is even inspected, let alone applied.
    const fat = Array.from({ length: MAX_PATCH_MUTATIONS }, () => ({ op: "set-view-option", view: "First", key: "limit", value: "x".repeat(600) }));
    const fatBytes = Buffer.byteLength(JSON.stringify(fat), "utf8");
    assert.equal(fat.length, MAX_PATCH_MUTATIONS, "the byte case must pass the count cap, so it exercises the other limit");
    assert.ok(fatBytes > MAX_PATCH_MUTATION_BYTES, `fixture must exceed the byte budget (${fatBytes} > ${MAX_PATCH_MUTATION_BYTES})`);
    const overBytes = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: fat }, { "If-Match": tag });
    assert.equal(overBytes.status, 413);
    assert.equal((await overBytes.json()).code, "BASE_MUTATIONS_TOO_LARGE");
    assert.equal(sha256(await readDisk()), sha256(before));
    assert.deepEqual(await tmpNames(), []);

    // ③ exactly at both caps ⇒ 200, and the patch really lands. Without this half an
    // "always refuse" implementation would pass ①/② while serving nobody.
    const atCap = repeat(MAX_PATCH_MUTATIONS);
    assert.ok(Buffer.byteLength(JSON.stringify(atCap), "utf8") <= MAX_PATCH_MUTATION_BYTES);
    const allowed = await patchBase(app, app.writer, { path: "Boards/Plan.base", mutations: atCap }, { "If-Match": tag });
    assert.equal(allowed.status, 200);
    const allowedBody = await allowed.json();
    assert.equal(allowedBody.changed, true);
    assert.equal(allowedBody.revision, sha256(await readDisk()));
    assert.match(await readDisk(), /    limit: 25\r\n/);
    assert.deepEqual(await tmpNames(), []);
  } finally {
    await app.close();
  }
});

// ⑨d negative control for ⑩: the gate is removed at *both* layers, so the same 513-entry
// request that is a 413 in ⑩① is served here — ⑩ is sensitive to the gate, not to the
// body size limit or to the CAS.
test("⑨d negative control: without the budget gate 513 entries are accepted (⑩① would be red)", async () => {
  const budgetlessDomain = async (_vault, userPath, mutations) => {
    const absolute = path.join(vault, userPath);
    const raw = await fs.readFile(absolute, "utf8");
    const next = patchBaseDocument(raw, mutations);
    await fs.writeFile(absolute, next, "utf8");
    return { path: userPath, changed: true, revision: sha256(next), previousRevision: sha256(raw), size: Buffer.byteLength(next, "utf8") };
  };
  const over = (count) => JSON.stringify({ path: "Boards/Plan.base", mutations: Array.from({ length: count }, () => ({ op: "set-view-option", view: "First", key: "limit", value: 25 })) });
  const server = await listen(variantApp(budgetlessDomain, [], readBaseInRoot, () => {}));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await readDisk();
    const response = await fetch(`${base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": `"${sha256(before)}"` }, body: over(MAX_PATCH_MUTATIONS + 1) });
    assert.equal(response.status, 200, "without the gate the over-count increment is served (⑩① is RED here)");
    assert.notEqual(response.status, 413);
    assert.notEqual(await readDisk(), before, "and it really patched the document");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  // Layer by layer: with only the route-level check removed, the real domain floor
  // (`writeWebBasePatch`) still refuses the same increment — the two layers are
  // independent (called directly here: the claim is about the domain, not about HTTP).
  await writeFixtures();
  const before = await readDisk();
  await assert.rejects(
    () => writeWebBasePatch({ id: "default", root: vault, primary: false }, "Boards/Plan.base", Array.from({ length: MAX_PATCH_MUTATIONS + 1 }, () => ({ op: "set-view-option", view: "First", key: "limit", value: 25 })), `"${sha256(before)}"`),
    (error) => error.code === "BASE_MUTATIONS_TOO_LARGE",
  );
  assert.equal(sha256(await readDisk()), sha256(before), "the domain floor refuses before it writes");
});

test("⑨b negative control: a non-atomic write corrupts the document, so the atomicity assertion is not vacuous", async () => {
  const partial = async (_vault, userPath, mutations) => {
    const absolute = path.join(vault, userPath);
    const raw = await fs.readFile(absolute, "utf8");
    const next = patchBaseDocument(raw, mutations);
    // Half the bytes land, then the "process" dies: the file is neither the old nor
    // the new document — exactly what tmp+rename prevents.
    await fs.writeFile(absolute, next.slice(0, 20), "utf8");
    const error = new Error("injected write failure");
    error.code = "EIO";
    throw error;
  };
  const server = await listen(variantApp(partial, []));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(vault, "Partial.base");
  try {
    const before = await fs.readFile(file, "utf8");
    const response = await fetch(`${base}/api/web/v1/base`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": `"${sha256(before)}"` }, body: JSON.stringify({ path: "Partial.base", mutations: [{ op: "set-view-option", view: "Only", key: "limit", value: 25 }] }) });
    assert.equal(response.status, 500);
    const after = await fs.readFile(file, "utf8");
    assert.notEqual(after, before, "a non-atomic write leaves the document damaged");

    // The real implementation, given a domain refusal on the same file, leaves the
    // bytes exactly as they were (the positive half of the control).
    const app = await startApp();
    try {
      await fs.writeFile(file, before, "utf8");
      const anchors = await patchBase(app, app.writer, { path: "Partial.base", mutations: [{ op: "set-view-option", view: "Only", key: "zzz", value: 1 }] }, { "If-Match": `"${sha256(before)}"` });
      assert.equal(anchors.status, 422);
      assert.equal(await fs.readFile(file, "utf8"), before);
      assert.deepEqual((await fs.readdir(vault)).filter((name) => name.includes(".tmp")), []);
    } finally {
      await app.close();
    }
  } finally {
    await writeFixtures();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
