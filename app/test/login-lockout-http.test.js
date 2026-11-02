import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Issue #206 regression: a locked out login must report the real remaining
// window and a Retry-After header, on every entry point that shares the window.

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

async function waitFor(url, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server: ${output.join("")}`);
}

// The admin window counts failures per source address; the Web window counts per
// source + username. Both block on the 9th attempt (8 recorded failures).
async function exhaustLock(url, init) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(url, init);
    assert.notEqual(response.status, 429, `attempt ${attempt + 1} should not be locked yet`);
  }
  return fetch(url, init);
}

function assertHonestLockout(response, body, label) {
  assert.equal(response.status, 429, `${label} should be locked`);
  const retryAfter = Number(response.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, `${label} must send Retry-After`);
  assert.ok(retryAfter <= 900, `${label} Retry-After must stay inside the 15 minute window`);
  assert.match(body, /\d+\s*(分钟|秒)/, `${label} must show the remaining window`);
  assert.doesNotMatch(body, /请 15 分钟后再试。$/, `${label} must not hardcode the window`);
}

test("locked out logins report the real remaining window with Retry-After", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-lockout-"));
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: base,
      OAUTH_ADMIN_PASSWORD: "test-only-admin-password",
      OAUTH_INITIAL_USERNAME: "test-owner",
      OAUTH_INITIAL_PASSWORD: "test-oauth-password",
      API_KEY: "",
      GIT_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitFor(`${base}/healthz`, child, output);

    // Admin password login: 8 failures then a lockout that reports the wait.
    const adminInit = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.21" },
      body: "password=wrong-admin-password",
    };
    assertHonestLockout(await exhaustLock(`${base}/admin/auth/login`, adminInit), await (await fetch(`${base}/admin/auth/login`, adminInit)).text(), "admin login");

    // Web OAuth-account login: same window semantics, different copy.
    const webInit = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.22" },
      body: "username=test-owner&password=wrong-oauth-password",
    };
    const locked = await exhaustLock(`${base}/auth/login`, webInit);
    assertHonestLockout(locked, await locked.text(), "web login");
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
