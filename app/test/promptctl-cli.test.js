// P1 Task 6: the developer CLI. Local validation never touches the network; every
// write goes through the real Admin login and CSRF, and the password stays on stdin.

import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import express from "express";

import { createAdminRouter } from "../src/admin/router.js";
import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { createPromptAdminService } from "../src/prompt-registry/service.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";

const run = promisify(execFile);
const SCRIPT = new URL("../scripts/promptctl.mjs", import.meta.url).pathname;
const PASSWORD = "test-only-admin-password";
const bundled = bundledBasePack();

function providerStub() {
  return {
    ready: Promise.resolve(),
    recordAudit: () => {},
    async authorizationSnapshot() {
      return { oauthUsers: [], clients: [], apiKeys: [], tokens: [], audit: [], configuredApiKeyUsage: { lastUsedAt: null, lastSource: null } };
    },
  };
}

/** A real server: admin router over a real registry store, on a loopback port. */
async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "promptctl-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createPromptRegistryStore({
    headFile: path.join(dir, "agent-prompts.json"),
    packsDir: path.join(dir, "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  const service = createPromptAdminService({ store, bundledBase: bundled });
  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider: providerStub(),
    adminPassword: PASSWORD,
    secureCookie: false,
    promptRegistryStore: store,
    promptAdminService: service,
  }));
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { store, url: `http://127.0.0.1:${server.address().port}` };
}

function cli(args, { password = PASSWORD } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.end(`${password}\n`);
  });
}

test("base validate works offline and names a bad key", async (t) => {
  const ok = await cli(["base", "validate"]);
  assert.equal(ok.code, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.ok, true);
  assert.match(parsed.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(parsed.keys > 100);

  const dir = await mkdtemp(path.join(tmpdir(), "promptctl-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, keys: { "memory.firstRead": { file: "memory/first-read.md" } } }));
  const bad = await cli(["base", "validate", "--root", dir]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /PROMPT_BASE_INVALID/);
});

test("status, publish and diff run against the real Admin API", async (t) => {
  const { store, url } = await startServer(t);

  const status = await cli(["status", "--url", url, "--password-stdin"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).revision, 0);

  const diff = await cli(["base", "diff", "--url", url, "--password-stdin"]);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).valid, true);

  const publish = await cli(["base", "publish", "--url", url, "--revision", "0", "--reason", "cli test", "--password-stdin"]);
  assert.equal(publish.code, 0, publish.stderr);
  assert.equal(JSON.parse(publish.stdout).revision, 1);
  assert.equal(store.snapshot().revision, 1);

  const stale = await cli(["base", "publish", "--url", url, "--revision", "0", "--reason", "cli test", "--password-stdin"]);
  assert.notEqual(stale.code, 0);
  assert.match(stale.stderr, /HTTP 409/);
});

test("neither the password nor the session cookie reaches output or argv", async (t) => {
  const { url } = await startServer(t);
  const result = await cli(["status", "--url", url, "--password-stdin"]);
  assert.equal(result.code, 0, result.stderr);
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(PASSWORD), false);
  assert.equal(/obsidian_mcp_admin=/.test(combined), false);
  // A password passed as an argv value is refused before any request is made.
  const refused = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, "status", "--url", url, "--password", PASSWORD], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /password-stdin is required/);
  assert.equal(refused.stderr.includes(PASSWORD), false);
});

test("an unauthenticated URL is refused with a clear error", async (t) => {
  const { url } = await startServer(t);
  const result = await cli(["status", "--url", url, "--password-stdin"], { password: "wrong-password" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /login failed with HTTP 403/);
});
