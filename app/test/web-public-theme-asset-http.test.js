import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-public-theme-asset-"));
const vault = path.join(root, "vault");
const activeRoot = path.join(vault, ".obsidian", "themes", "Active");
const otherRoot = path.join(vault, ".obsidian", "themes", "Other");
await fs.mkdir(path.join(activeRoot, "fonts"), { recursive: true });
await fs.mkdir(path.join(otherRoot, "fonts"), { recursive: true });
await fs.writeFile(path.join(vault, ".obsidian", "appearance.json"), JSON.stringify({
  cssTheme: "Active",
  theme: "moonstone",
}), "utf8");
await fs.writeFile(path.join(activeRoot, "theme.css"), [
  ".theme-light { --background-primary: #fff; }",
  '@font-face { font-family: "Active"; src: url("fonts/active.woff2") format("woff2"); }',
].join("\n"), "utf8");
await fs.writeFile(path.join(otherRoot, "theme.css"), [
  ".theme-light { --background-primary: #eee; }",
  '@font-face { font-family: "Other"; src: url("fonts/other.woff2") format("woff2"); }',
].join("\n"), "utf8");
const activeBytes = Buffer.from("ACTIVE_THEME_FONT_BYTES");
const otherBytes = Buffer.from("OTHER_THEME_FONT_BYTES");
await fs.writeFile(path.join(activeRoot, "fonts", "active.woff2"), activeBytes);
await fs.writeFile(path.join(otherRoot, "fonts", "other.woff2"), otherBytes);

process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const { createWebAppRouter } = await import("../src/app/routes.js");

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
    timeoutId = setTimeout(() => reject(new Error("Timed out closing public theme test server")), HTTP_TIMEOUT_MS);
  });
  try {
    await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function startApp() {
  const app = express();
  app.use(createWebAppRouter({ provider: {}, secureCookie: false, publishService: {} }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => closeHttpServer(server) };
}

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("anonymous login theme assets expose only the active default-Vault theme", async () => {
  const { base, close } = await startApp();
  try {
    const css = await boundedFetch(`${base}/auth/theme.css?name=Active`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("cache-control") || "", /public/);
    assert.equal(decodeURIComponent(css.headers.get("x-obsidian-theme") || ""), "Active");
    assert.match(await css.text(), /\/auth\/theme-asset\?name=Active&path=fonts%2Factive\.woff2/);

    const allowed = await boundedFetch(`${base}/auth/theme-asset?name=Active&path=fonts%2Factive.woff2`);
    assert.equal(allowed.status, 200);
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), activeBytes);

    const inactive = await boundedFetch(`${base}/auth/theme-asset?name=Other&path=fonts%2Fother.woff2`);
    assert.equal(inactive.status, 404);
    assert.notDeepEqual(Buffer.from(await inactive.arrayBuffer()), otherBytes);

    const missing = await boundedFetch(`${base}/auth/theme-asset?name=Active&path=fonts%2Fmissing.woff2`);
    assert.equal(missing.status, 404);

    const traversal = await boundedFetch(`${base}/auth/theme-asset?name=Active&path=..%2F..%2FOther%2Ffonts%2Fother.woff2`);
    assert.ok([400, 404].includes(traversal.status), `unexpected traversal status ${traversal.status}`);
    assert.notDeepEqual(Buffer.from(await traversal.arrayBuffer()), otherBytes);
  } finally {
    await close();
  }
});
