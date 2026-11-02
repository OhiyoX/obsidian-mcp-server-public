import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-files-scope-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "images"), { recursive: true });
await fs.writeFile(path.join(vault, "Note.md"), "# Readable note\n", "utf8");
await fs.writeFile(path.join(vault, "images", "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;

const [{ createWebAppRouter }, { defaultWebVaultId }, { PublishService }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/publish/service.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) => fetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
});

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  let timeoutId;
  const timedOut = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Timed out closing Web scope test server")), HTTP_TIMEOUT_MS);
  });
  try {
    await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function startAuthedApp(scopes, stateName) {
  const user = {
    id: `user-${stateName}`,
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: [...scopes],
    allowedVaults: [defaultWebVaultId()],
  };
  const audits = [];
  const provider = {
    authenticateOAuthUser: async (username, password) => username === "owner" && password === "password" ? user : null,
    oauthUserSessionRecord: async (id) => id === user.id ? user : null,
    recordAudit(entry) { audits.push(entry); },
  };
  const app = express();
  app.use(createWebAppRouter({
    provider,
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
    assert.equal(login.status, 303);
    const cookieHeader = login.headers.get("set-cookie");
    assert.ok(cookieHeader, "login must return a session cookie");
    const cookie = cookieHeader.split(";", 1)[0];
    return { base, cookie, audits, close: () => closeHttpServer(server) };
  } catch (error) {
    await closeHttpServer(server).catch(() => {});
    throw error;
  }
}

test("Web attachment reads require obsidian.files while note reads remain available to obsidian.read", async () => {
  const readOnly = await startAuthedApp(["obsidian.read"], "read-only");
  try {
    const note = await boundedFetch(`${readOnly.base}/api/web/v1/note?path=Note.md`, {
      headers: { Cookie: readOnly.cookie },
    });
    assert.equal(note.status, 200);
    assert.match((await note.json()).content, /Readable note/);

    const deniedAsset = await boundedFetch(`${readOnly.base}/api/web/v1/asset?path=images%2Fpixel.png&from=Note.md`, {
      headers: { Cookie: readOnly.cookie },
    });
    assert.equal(deniedAsset.status, 403);
    assert.deepEqual(await deniedAsset.json(), { error: "Account does not have file permission" });
    assert.equal(readOnly.audits.some((entry) => entry.action === "web.attachment.read"), false);
  } finally {
    await readOnly.close();
  }

  const fileReader = await startAuthedApp(["obsidian.read", "obsidian.files"], "file-reader");
  try {
    const asset = await boundedFetch(`${fileReader.base}/api/web/v1/asset?path=images%2Fpixel.png&from=Note.md`, {
      headers: { Cookie: fileReader.cookie },
    });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), Buffer.from("89504e470d0a1a0a", "hex"));
    assert.equal(fileReader.audits.filter((entry) => entry.action === "web.attachment.read").length, 1);
  } finally {
    await fileReader.close();
  }
});
