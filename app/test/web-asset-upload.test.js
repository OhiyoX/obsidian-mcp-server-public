// U30 contract A2/A3/A5: real HTTP coverage for `POST /api/web/v1/asset`.
//
// Same shape as `web-files-scope.test.js`: a temporary Vault, the real `createWebAppRouter`
// and a real login + CSRF handshake, so the middleware order (raw body -> session -> CSRF ->
// write gate -> handler), the error mapping and the on-disk result are all exercised for real.
//
// The process env is fixed before the app modules are imported: `MAX_READ_BYTES` is lowered so
// the 413 case stays cheap, and `WEB_ASSET_MAX_BYTES` is deliberately raised above it to prove
// the mandatory clamp (an upload ceiling above the read ceiling would create unreadable assets).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-asset-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
const outside = path.join(root, "outside");
await fs.mkdir(vault, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.mkdir(path.join(vault, "notes"), { recursive: true });
await fs.mkdir(path.join(vault, "images"), { recursive: true });
await fs.writeFile(path.join(vault, "Note.md"), "# Asset note\n", "utf8");
await fs.writeFile(path.join(vault, "notes", "demo.md"), "# Demo\n", "utf8");
await fs.writeFile(path.join(vault, "images", "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.MAX_READ_BYTES = "64kb";
process.env.WEB_ASSET_MAX_BYTES = "1mb";
delete process.env.WEB_VAULTS_ROOT;
delete process.env.OBSIDIAN_READ_ONLY;

const [
  { createWebAppRouter },
  { defaultWebVaultId },
  { PublishService },
  { MAX_READ_BYTES, WEB_ASSET_MAX_BYTES, WEB_ATTACHMENT_FOLDER },
  { writeWebAsset, sniffImageType, cleanAssetName, WEB_ASSET_TYPES },
  { registerAssetRoute },
  { classifyWebApiError },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/publish/service.js"),
  import("../src/config.js"),
  import("../src/app/attachments.js"),
  import("../src/app/asset-route.js"),
  import("../src/app/web-api-error.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) => fetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
});

// A real 1x1 PNG: long enough for magic-number sniffing and byte-comparable after the round trip.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  let timeoutId;
  const timedOut = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Timed out closing Web asset test server")), HTTP_TIMEOUT_MS);
  });
  try {
    await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function providerFor(scopes, allowedVaults, audits) {
  const user = {
    id: `user-${scopes.join("-") || "none"}`,
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: [...scopes],
    allowedVaults: [...allowedVaults],
  };
  return {
    authenticateOAuthUser: async (username, password) => username === "owner" && password === "password" ? user : null,
    oauthUserSessionRecord: async (id) => id === user.id ? user : null,
    recordAudit(entry) { audits.push(entry); },
  };
}

async function startAuthedApp(scopes, stateName, { allowedVaults = [defaultWebVaultId()] } = {}) {
  const audits = [];
  const app = express();
  app.use(createWebAppRouter({
    provider: providerFor(scopes, allowedVaults, audits),
    secureCookie: false,
    publishService: new PublishService({ file: path.join(data, `${stateName}.json`) }),
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await boundedFetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "password" }),
    });
    assert.equal(login.status, 303, `login failed for ${stateName}`);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const page = await (await boundedFetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    const csrf = page.match(/name="csrf-token" content="([^"]+)"/)?.[1];
    assert.ok(csrf, "the app page must expose the CSRF token");
    return { base, cookie, csrf, audits, close: () => closeHttpServer(server) };
  } catch (error) {
    await closeHttpServer(server).catch(() => {});
    throw error;
  }
}

function upload(base, auth, { name, body = PNG, from, csrf = auth.csrf, headers = {} } = {}) {
  const query = from === undefined ? "" : `?from=${encodeURIComponent(from)}`;
  const requestHeaders = { Cookie: auth.cookie, "Content-Type": "application/octet-stream", ...headers };
  if (typeof name === "string") requestHeaders["x-file-name"] = encodeURIComponent(name);
  if (csrf !== null) requestHeaders["X-CSRF-Token"] = csrf;
  return boundedFetch(`${base}/api/web/v1/asset${query}`, { method: "POST", headers: requestHeaders, body });
}

const attachmentPath = (...parts) => path.join(vault, WEB_ATTACHMENT_FOLDER, ...parts);

test("asset upload rejects anonymous, unscoped, CSRF-less and oversized requests without leaking paths", async () => {
  const writer = await startAuthedApp(["obsidian.read", "obsidian.write"], "writer");
  const reader = await startAuthedApp(["obsidian.read"], "reader");
  try {
    // 401: no session at all (and no CSRF): the session gate must run before the CSRF gate.
    const anonymous = await upload(writer.base, { cookie: "", csrf: null }, { name: "anon.png" });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "Login required" });

    // 403: authenticated, CSRF present, but no obsidian.write scope.
    const noScope = await upload(reader.base, reader, { name: "noscope.png" });
    assert.equal(noScope.status, 403);
    const noScopeBody = await noScope.text();
    assert.deepEqual(JSON.parse(noScopeBody), { error: "Account does not have write permission" });
    assert.equal(reader.audits.some((entry) => entry.action === "web.asset.create"), false);

    // 403: CSRF header missing, then present but wrong.
    const missingCsrf = await upload(writer.base, writer, { name: "csrf.png", csrf: null });
    assert.equal(missingCsrf.status, 403);
    const missingCsrfBody = await missingCsrf.text();
    assert.deepEqual(JSON.parse(missingCsrfBody), { error: "CSRF validation failed" });
    const wrongCsrf = await upload(writer.base, writer, { name: "csrf.png", csrf: "not-the-token" });
    assert.equal(wrongCsrf.status, 403);
    assert.deepEqual(await wrongCsrf.json(), { error: "CSRF validation failed" });

    // 413: the raw parser's limit is the clamped ceiling, not the configured 1mb.
    const oversized = await upload(writer.base, writer, { name: "big.png", body: Buffer.concat([PNG, Buffer.alloc(MAX_READ_BYTES, 7)]) });
    assert.equal(oversized.status, 413);
    const oversizedBody = await oversized.text();
    assert.deepEqual(JSON.parse(oversizedBody), { error: "Request body too large" });

    // 400: no `x-file-name` header at all.
    const unnamed = await upload(writer.base, writer, { name: null });
    assert.equal(unnamed.status, 400);
    const unnamedBody = await unnamed.text();
    assert.deepEqual(JSON.parse(unnamedBody), { error: "Invalid file name" });

    // No rejection may echo the Vault's absolute path.
    for (const [label, text] of [["scope", noScopeBody], ["csrf", missingCsrfBody], ["oversize", oversizedBody], ["unnamed", unnamedBody]]) {
      assert.equal(text.includes(vault), false, `${label}: error body must not contain the Vault path: ${text}`);
    }
    assert.equal(await fs.readdir(vault).then((entries) => entries.includes(WEB_ATTACHMENT_FOLDER)), false, "no rejection may create the attachment folder");
  } finally {
    await reader.close();
    await writer.close();
  }
});

test("asset upload validates the file name and the sniffed type (400/415) without writing", async () => {
  const app = await startAuthedApp(["obsidian.read", "obsidian.write"], "validation");
  try {
    const rejected = [
      ["traversal", { name: "../escape.png" }, 400, "Invalid file name"],
      ["posix absolute", { name: "/etc/passwd.png" }, 400, "Invalid file name"],
      ["windows absolute", { name: "C:\\temp\\x.png" }, 400, "Invalid file name"],
      ["NUL byte", { name: "x\u0000.png" }, 400, "Invalid file name"],
      ["backslash", { name: "dir\\x.png" }, 400, "Invalid file name"],
      ["dot-prefixed", { name: ".hidden.png" }, 400, "Invalid file name"],
      ["extension outside the whitelist", { name: "notes.pdf" }, 415, "Unsupported image type"],
      ["excluded .svg", { name: "logo.svg" }, 415, "Unsupported image type"],
      ["excluded .avif", { name: "photo.avif" }, 415, "Unsupported image type"],
      ["markdown extension", { name: "note.md" }, 415, "Unsupported image type"],
      ["no extension", { name: "photo" }, 415, "Unsupported image type"],
      ["text renamed to .png", { name: "fake.png", body: Buffer.from("this is not a PNG, it is plain text\n") }, 415, "Unsupported image type"],
      ["gif bytes behind .png", { name: "wrong.png", body: Buffer.from("GIF89a.........", "latin1") }, 415, "Unsupported image type"],
    ];
    for (const [label, options, status, error] of rejected) {
      const response = await upload(app.base, app, options);
      const text = await response.text();
      assert.equal(response.status, status, `${label}: expected ${status}, body ${text}`);
      assert.deepEqual(JSON.parse(text), { error }, label);
      assert.equal(text.includes(vault), false, `${label}: error body must not contain the Vault path`);
    }
    // 404: `from` must point at an existing note; it never silently falls back to the Vault root.
    const missingSource = await upload(app.base, app, { name: "ok.png", from: "Missing.md" });
    assert.equal(missingSource.status, 404);
    assert.deepEqual(await missingSource.json(), { error: "Not found" });
    const traversalSource = await upload(app.base, app, { name: "ok.png", from: "../outside/secret.md" });
    assert.equal(traversalSource.status, 400);
    assert.deepEqual(await traversalSource.json(), { error: "Invalid Vault path" });
    const nonMarkdownSource = await upload(app.base, app, { name: "ok.png", from: "images/pixel.png" });
    assert.equal(nonMarkdownSource.status, 400);

    assert.equal(await fs.readdir(vault).then((entries) => entries.includes(WEB_ATTACHMENT_FOLDER)), false, "no rejected upload may create the attachment folder");
  } finally {
    await app.close();
  }
});

test("asset upload lands in attachments/, reports the disk sha256 and never overwrites", async () => {
  const app = await startAuthedApp(["obsidian.read", "obsidian.write", "obsidian.files"], "positive");
  try {
    const first = await upload(app.base, app, { name: "pixel one.png", from: "notes/demo.md" });
    const firstBody = await first.text();
    assert.equal(first.status, 201, firstBody);
    const created = JSON.parse(firstBody);
    assert.equal(created.vaultId, defaultWebVaultId());
    assert.equal(created.path, `${WEB_ATTACHMENT_FOLDER}/pixel one.png`);
    assert.equal(created.size, PNG.length);
    assert.equal(created.contentType, "image/png");
    assert.equal(created.revision, sha256(PNG));
    assert.equal(created.url, `/api/web/v1/asset?path=attachments%2Fpixel+one.png&from=notes%2Fdemo.md`);

    // `revision` must equal the sha256 of the bytes actually on disk.
    const onDisk = await fs.readFile(attachmentPath("pixel one.png"));
    assert.deepEqual(onDisk, PNG);
    assert.equal(created.revision, sha256(onDisk));
    assert.equal(app.audits.filter((entry) => entry.action === "web.asset.create").length, 1);
    assert.equal(app.audits.at(-1).detail, `${defaultWebVaultId()}:${created.path}`);

    // The returned URL is directly usable as `<img src>` and reads back byte-identically.
    const readBack = await boundedFetch(`${app.base}${created.url}`, { headers: { Cookie: app.cookie } });
    assert.equal(readBack.status, 200);
    assert.equal(readBack.headers.get("content-type"), "image/png");
    assert.equal(readBack.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await readBack.arrayBuffer()), PNG);

    // A second upload of the same name takes `-1` and leaves the first file untouched.
    const second = await upload(app.base, app, { name: "pixel one.png", from: "notes/demo.md" });
    assert.equal(second.status, 201);
    const next = await second.json();
    assert.equal(next.path, `${WEB_ATTACHMENT_FOLDER}/pixel one-1.png`);
    assert.deepEqual(await fs.readFile(attachmentPath("pixel one.png")), PNG);
    assert.deepEqual(await fs.readFile(attachmentPath("pixel one-1.png")), PNG);

    // Unicode + spaces survive; illegal characters collapse to `-` and the stem caps at 120.
    const unicode = await upload(app.base, app, { name: "  中文 图 :*? 名.png" });
    assert.equal(unicode.status, 201);
    assert.equal((await unicode.json()).path, `${WEB_ATTACHMENT_FOLDER}/中文 图 - 名.png`);
    const long = await upload(app.base, app, { name: `${"n".repeat(200)}.png` });
    assert.equal(long.status, 201);
    const longName = path.posix.basename((await long.json()).path);
    assert.equal(longName, `${"n".repeat(120)}.png`);
    const emptyStem = await upload(app.base, app, { name: "***.png" });
    assert.equal(emptyStem.status, 201);
    assert.equal((await emptyStem.json()).path, `${WEB_ATTACHMENT_FOLDER}/image.png`);
  } finally {
    await app.close();
  }
});

test("the upload path and the direct read-back never scan the Vault", async () => {
  const app = await startAuthedApp(["obsidian.read", "obsidian.write", "obsidian.files"], "io");
  const original = { readdir: fs.readdir };
  const scanned = [];
  fs.readdir = async (target, ...rest) => { scanned.push(String(target)); return original.readdir.call(fs, target, ...rest); };
  try {
    const upload1 = await upload(app.base, app, { name: "io-probe.png", from: "notes/demo.md" });
    assert.equal(upload1.status, 201);
    assert.deepEqual(scanned, [], "upload must not enumerate any directory (no matchingFiles / whole-Vault scan)");
    const url = (await upload1.json()).url;

    // Direct branch: `from` + Vault-relative path resolves without the bounded fallback scan.
    const direct = await boundedFetch(`${app.base}${url}`, { headers: { Cookie: app.cookie } });
    assert.equal(direct.status, 200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), PNG);
    assert.deepEqual(scanned, [], "the direct `from` branch must not scan the Vault either");

    // Control: a target that only matches by basename does take the scanning fallback, which
    // proves the tripwire above is live rather than an inert assertion.
    const fallback = await boundedFetch(`${app.base}/api/web/v1/asset?path=deep%2Fpixel.png&from=Note.md`, { headers: { Cookie: app.cookie } });
    assert.equal(fallback.status, 200);
    assert.ok(scanned.includes(vault), `the basename fallback must enumerate the Vault, got ${JSON.stringify(scanned)}`);
  } finally {
    fs.readdir = original.readdir;
    await app.close();
  }
});

test("asset upload answers 409 once the -N suffix space is exhausted", async () => {
  const app = await startAuthedApp(["obsidian.read", "obsidian.write"], "conflict");
  try {
    await fs.mkdir(attachmentPath(), { recursive: true });
    // Occupy the base name and every suffix the contract allows (`-1` .. `-1000`).
    for (let index = 0; index <= 1000; index += 1) {
      await fs.writeFile(attachmentPath(`exhaust${index ? `-${index}` : ""}.png`), Buffer.from([0x00]));
    }
    const response = await upload(app.base, app, { name: "exhaust.png" });
    const text = await response.text();
    assert.equal(response.status, 409, text);
    assert.deepEqual(JSON.parse(text), { error: "Attachment name conflict" });
    assert.equal(text.includes(vault), false);
    // Nothing was overwritten and no `-1001` escape hatch was invented.
    assert.deepEqual(await fs.readFile(attachmentPath("exhaust.png")), Buffer.from([0x00]));
    assert.equal(await fs.stat(attachmentPath("exhaust-1001.png")).then(() => true, () => false), false);
  } finally {
    await app.close();
  }
});

// Creates a symlink or, only on Windows where the privilege is unavailable, skips the test
// (the same convention as `context-security.test.js` / `skills.test.js`; assertions are never weakened).
// `attempts` is explicit because a Windows `junction` can only target a directory: a file target
// must not be faked with a junction (it resolves to ENOENT and would prove nothing).
async function symlinkOrSkip(t, target, linkPath, type, attempts = process.platform === "win32" ? ["junction", "dir", "file"] : [type]) {
  let lastError;
  for (const attempt of attempts) {
    try {
      await fs.symlink(target, linkPath, attempt);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  t.skip(`symlink privilege unavailable on this platform: ${lastError?.code}`);
  return false;
}

test("writeWebAsset refuses a symlinked attachment folder that escapes the Vault", async (t) => {
  const escapeRoot = path.join(root, "escape-vault");
  await fs.mkdir(escapeRoot, { recursive: true });
  const outsideTarget = path.join(outside, "asset-escape-target");
  await fs.mkdir(outsideTarget, { recursive: true });
  if (!(await symlinkOrSkip(t, outsideTarget, path.join(escapeRoot, "attachments"), "dir"))) return;

  const vaultRecord = { id: "escape", root: escapeRoot };
  await assert.rejects(
    writeWebAsset(vaultRecord, { fileName: "escape.png", body: PNG }),
    /Symbolic link escapes the vault/,
  );
  assert.deepEqual(await fs.readdir(outsideTarget), [], "nothing may be written through an escaping symlink");
});

test("writeWebAsset refuses a symlinked target file that escapes the Vault", async (t) => {
  // A Windows `junction` can only target a directory, so this case is asserted where a real
  // file symlink exists (POSIX, or Windows with the privilege) and skipped elsewhere.
  if (process.platform === "win32") {
    t.skip("file symlinks need elevation on Windows (EPERM); the directory case above covers the junction path");
    return;
  }
  const safeRoot = path.join(root, "safe-vault");
  await fs.mkdir(path.join(safeRoot, "attachments"), { recursive: true });
  const outsideFile = path.join(outside, "outside-file.png");
  await fs.writeFile(outsideFile, Buffer.from("outside"));
  if (!(await symlinkOrSkip(t, outsideFile, path.join(safeRoot, "attachments", "link.png"), "file", ["file"]))) return;
  await assert.rejects(
    writeWebAsset({ id: "safe", root: safeRoot }, { fileName: "link.png", body: PNG }),
    /Symbolic link escapes the vault/,
  );
  assert.deepEqual(await fs.readFile(outsideFile), Buffer.from("outside"));
  assert.equal(await fs.readdir(path.join(safeRoot, "attachments")).then((entries) => entries.length), 1, "no `-1` copy may be created next to an escaping link");
});

test("the asset route takes the Vault from the session only and maps its domain errors", async () => {
  // 403: a Vault the session is not authorized for, mapped by the shared classifier.
  const audits = [];
  const deniedApp = express();
  deniedApp.use(express.json());
  registerAssetRoute(deniedApp, {
    requireApi: (_req, _res, next) => { _req.webSession = { allowedScopes: ["obsidian.write"], allowedVaults: ["other"], vaultId: "vault", userId: "u", username: "owner" }; next(); },
    requireCsrf: (_req, _res, next) => next(),
    currentVault: async () => { throw new Error("Vault access denied"); },
    provider: { recordAudit: (entry) => audits.push(entry) },
  });
  deniedApp.use("/api/web/v1", (error, _req, res, _next) => {
    const response = classifyWebApiError(error);
    res.status(response.status).json(response.code ? { error: response.error, code: response.code } : { error: response.error });
  });
  const deniedServer = await new Promise((resolve) => {
    const instance = http.createServer(deniedApp).listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const base = `http://127.0.0.1:${deniedServer.address().port}`;
    const denied = await boundedFetch(`${base}/api/web/v1/asset?from=Note.md&vaultId=other`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": "denied.png", "X-CSRF-Token": "x", "x-vault-id": "other" },
      body: PNG,
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "Vault access denied" });
    assert.deepEqual(audits, []);
  } finally {
    await closeHttpServer(deniedServer);
  }

  // A request that carries a Vault id in the query, a header and the body still writes into the
  // Vault the session resolved: the route never reads a caller-supplied Vault id.
  const sessionRoot = path.join(root, "session-vault");
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(path.join(sessionRoot, "Note.md"), "# Session note\n");
  const otherRoot = path.join(root, "other-vault");
  await fs.mkdir(otherRoot, { recursive: true });
  const seen = [];
  const stubApp = express();
  registerAssetRoute(stubApp, {
    requireApi: (req, _res, next) => { req.webSession = { allowedScopes: ["obsidian.write"], allowedVaults: ["session"], vaultId: "session", userId: "u", username: "owner" }; next(); },
    requireCsrf: (_req, _res, next) => next(),
    currentVault: async (req) => { seen.push({ query: req.query.vaultId, header: req.get("x-vault-id"), body: Buffer.isBuffer(req.body) }); return { id: "session", root: sessionRoot }; },
    provider: { recordAudit() {} },
  });
  stubApp.use("/api/web/v1", (error, _req, res, _next) => {
    const response = classifyWebApiError(error);
    res.status(response.status).json({ error: response.error });
  });
  const stubServer = await new Promise((resolve) => {
    const instance = http.createServer(stubApp).listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const base = `http://127.0.0.1:${stubServer.address().port}`;
    const response = await boundedFetch(`${base}/api/web/v1/asset?from=Note.md&vaultId=other`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": "routed.png", "X-CSRF-Token": "x", "x-vault-id": "other" },
      body: PNG,
    });
    const routedBody = await response.text();
    assert.equal(response.status, 201, routedBody);
    assert.deepEqual(seen, [{ query: "other", header: "other", body: true }]);
    assert.deepEqual(await fs.readFile(path.join(sessionRoot, WEB_ATTACHMENT_FOLDER, "routed.png")), PNG);
    assert.equal(await fs.readdir(otherRoot).then((entries) => entries.length), 0, "the caller-supplied Vault id must be ignored");
  } finally {
    await closeHttpServer(stubServer);
  }
});

test("cleanAssetName, sniffImageType and the whitelist stay aligned", () => {
  assert.equal(MAX_READ_BYTES, 64 * 1024);
  assert.equal(WEB_ASSET_MAX_BYTES, MAX_READ_BYTES, "WEB_ASSET_MAX_BYTES=1mb must be clamped to MAX_READ_BYTES");
  assert.equal(WEB_ATTACHMENT_FOLDER, "attachments");
  assert.deepEqual([...WEB_ASSET_TYPES.keys()].sort(), [".gif", ".jpeg", ".jpg", ".png", ".webp"]);
  assert.equal(WEB_ASSET_TYPES.has(".svg"), false, "`.svg` stays excluded while the read route serves it inline");
  assert.deepEqual(cleanAssetName("a%20b.PNG"), { stem: "a b", extension: ".png", contentType: "image/png" });
  assert.deepEqual(cleanAssetName("café  图.webp").stem, "café  图");
  assert.throws(() => cleanAssetName("../x.png"), { status: 400 });
  assert.throws(() => cleanAssetName("x.svg"), { status: 415 });
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(Buffer.from("GIF89a..........")), "image/gif");
  assert.equal(sniffImageType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("plain text, not an image")), null);
});
