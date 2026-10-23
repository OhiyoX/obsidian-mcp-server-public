// #369 (V369): the app shell must opt into the full viewport canvas.
//
// `env(safe-area-inset-*)` resolves to `0px` unless the page's viewport meta carries
// `viewport-fit=cover`, so app.css's single top-inset owner (`--app-inset-top`, consumed by the
// topbar / drawer bands in the `<=720px` sheet) can never observe a notch without it. The
// assertions below run against the bytes of a real `GET /app` response — real Express router,
// real login session, real `http.createServer` — instead of matching the `pages.js` source text.
//
// Scope: only the workspace shell (`appPage()`). The anonymous login and publish pages ship their
// own meta and own their own decision; this file deliberately says nothing about them.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-viewport-fit-cover-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
await fs.writeFile(path.join(vault, "Note.md"), "# Note\n", "utf8");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const [{ createWebAppRouter }, { encodeDocumentRoute }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/publish/service.js"),
]);

const user = {
  id: "user-viewport-fit",
  username: "owner",
  displayName: "Owner",
  updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write"],
  allowedVaults: ["default"],
};
const provider = {
  authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
  oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
  recordAudit() {},
};

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Real HTTP bytes for one app-shell URL behind a real login session. */
async function fetchShellPage(urlPath) {
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "password" }),
    });
    assert.equal(login.status, 303, "the fixture login must succeed before the shell can be read");
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const response = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${urlPath} must render the shell`);
    return await response.text();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Every `<meta name="viewport">` in document order, paired with its raw `content` value. */
function viewportMetas(html) {
  return [...String(html).matchAll(/<meta\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\bname="viewport"/.test(tag))
    .map((tag) => ({ tag, content: tag.match(/\bcontent="([^"]*)"/)?.[1] ?? null }));
}

function assertCoverViewport(html, label) {
  const metas = viewportMetas(html);
  assert.equal(metas.length, 1, `${label} must ship exactly one viewport meta, got ${metas.length}`);
  const [meta] = metas;
  assert.notEqual(meta.content, null, `${label} viewport meta must carry a content attribute`);
  const tokens = meta.content.split(",").map((token) => token.trim()).filter(Boolean);
  assert.ok(tokens.includes("width=device-width"), `${label} must keep width=device-width, got "${meta.content}"`);
  assert.ok(tokens.includes("initial-scale=1"), `${label} must keep initial-scale=1, got "${meta.content}"`);
  assert.ok(tokens.includes("viewport-fit=cover"), `${label} must declare viewport-fit=cover, got "${meta.content}"`);
}

test("GET /app ships a viewport meta that opts into the full canvas", async () => {
  assertCoverViewport(await fetchShellPage("/app"), "GET /app");
});

test("the note shell (GET /app/note/*) ships the same head", async () => {
  const encoded = encodeDocumentRoute("default", "Note.md");
  assertCoverViewport(await fetchShellPage(`/app/note/${encoded}`), "GET /app/note/*");
});
