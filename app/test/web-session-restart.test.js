import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");

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
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill("SIGKILL");
  });
}

async function waitForHealth(url, child, output) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server: ${output.join("")}`);
}

async function startServer(root, port) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      WEB_VAULTS_ROOT: path.join(root, "vaults"),
      WEB_DEFAULT_VAULT: "vault",
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      OAUTH_ADMIN_PASSWORD: "test-only-password",
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
  await waitForHealth(`http://127.0.0.1:${port}/healthz`, child, output);
  return { child, output };
}

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-session-restart-"));
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  await fs.mkdir(path.join(root, "vaults"), { recursive: true });
  await fs.writeFile(path.join(root, "vault", "Note.md"), "# Restart note\n", "utf8");
  return root;
}

async function login(base) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "test-owner", password: "test-oauth-password" }),
  });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "login must set a cookie");
  const cookie = setCookie.split(";", 1)[0];
  const page = await fetch(`${base}/app`, { headers: { Cookie: cookie } });
  const csrf = (await page.text()).match(/name="csrf-token" content="([^"]+)"/)?.[1] || null;
  return { cookie, csrf };
}

async function sessionStatus(base, cookie) {
  const response = await fetch(`${base}/api/web/v1/session`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  return response;
}

test("a valid Web session survives a hard server restart and logout does not", async (t) => {
  const root = await setupRoot();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let running = await startServer(root, port);
  try {
    const { cookie, csrf } = await login(base);
    assert.equal((await sessionStatus(base, cookie)).status, 200);

    // The durable store must never contain the raw cookie token or bearer/scopes.
    const storeFile = path.join(root, "data", "web", "sessions.json");
    const raw = await fs.readFile(storeFile, "utf8");
    const rawToken = cookie.slice(cookie.indexOf("=") + 1);
    assert.equal(raw.includes(rawToken), false);
    const parsed = JSON.parse(raw);
    assert.ok(Object.keys(parsed.sessions).every((key) => /^[0-9a-f]{64}$/.test(key)));
    assert.equal(raw.includes("allowedScopes"), false);
    assert.equal(raw.includes("allowedVaults"), false);
    assert.equal(raw.includes("bearer"), false);

    await stopChild(running.child);
    running = await startServer(root, port);
    assert.equal((await sessionStatus(base, cookie)).status, 200, "same cookie must survive a hard restart");

    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(logout.status, 303);
    await stopChild(running.child);
    running = await startServer(root, port);
    assert.equal((await sessionStatus(base, cookie)).status, 401, "logout must not resurrect after restart");
  } finally {
    await stopChild(running.child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("expired, revision-changed and disabled accounts fail closed after restart", async (t) => {
  const root = await setupRoot();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let running = await startServer(root, port);
  try {
    const { cookie } = await login(base);
    await stopChild(running.child);

    const storeFile = path.join(root, "data", "web", "sessions.json");
    const store = JSON.parse(await fs.readFile(storeFile, "utf8"));
    for (const key of Object.keys(store.sessions)) {
      store.sessions[key].expiresAt = 1;
      store.sessions[key].lastSeenAt = 1;
      store.sessions[key].createdAt = 1;
    }
    await fs.writeFile(storeFile, JSON.stringify(store));
    running = await startServer(root, port);
    assert.equal((await sessionStatus(base, cookie)).status, 401, "expired must fail closed");
  } finally {
    await stopChild(running.child);
    await fs.rm(root, { recursive: true, force: true });
  }

  // Revision change
  const root2 = await setupRoot();
  const port2 = await freePort();
  const base2 = `http://127.0.0.1:${port2}`;
  let running2 = await startServer(root2, port2);
  try {
    const { cookie } = await login(base2);
    await stopChild(running2.child);
    const oauthFile = path.join(root2, "data", "oauth", "state.json");
    const oauth = JSON.parse(await fs.readFile(oauthFile, "utf8"));
    for (const user of Object.values(oauth.oauthUsers)) user.updatedAt = "2030-01-01T00:00:00.000Z";
    await fs.writeFile(oauthFile, JSON.stringify(oauth));
    running2 = await startServer(root2, port2);
    assert.equal((await sessionStatus(base2, cookie)).status, 401, "revision change must fail closed");
  } finally {
    await stopChild(running2.child);
    await fs.rm(root2, { recursive: true, force: true });
  }

  // Disabled account
  const root3 = await setupRoot();
  const port3 = await freePort();
  const base3 = `http://127.0.0.1:${port3}`;
  let running3 = await startServer(root3, port3);
  try {
    const { cookie } = await login(base3);
    await stopChild(running3.child);
    const oauthFile = path.join(root3, "data", "oauth", "state.json");
    const oauth = JSON.parse(await fs.readFile(oauthFile, "utf8"));
    for (const user of Object.values(oauth.oauthUsers)) user.disabledAt = "2026-10-03T00:00:00.000Z";
    await fs.writeFile(oauthFile, JSON.stringify(oauth));
    running3 = await startServer(root3, port3);
    assert.equal((await sessionStatus(base3, cookie)).status, 401, "disabled must fail closed");
  } finally {
    await stopChild(running3.child);
    await fs.rm(root3, { recursive: true, force: true });
  }
});
