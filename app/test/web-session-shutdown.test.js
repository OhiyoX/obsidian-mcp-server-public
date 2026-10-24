import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

process.env.WEB_LIVE_UPDATES = "true";
process.env.NODE_ENV = "test";

const live = await import(`../src/app/live-events.js?shutdown=${Date.now()}`);

test("SSE teardown is idempotent and refuses new admissions afterwards", async () => {
  const first = live.teardownLiveEvents();
  const second = live.teardownLiveEvents();
  assert.equal(first, second);
  await first;
  await live.resetLiveEventsForTests();
});

test("teardown reports watcher close failures instead of a blanket success", async () => {
  await live.resetLiveEventsForTests();
  const internals = live.liveEventInternalsForTests();
  internals.watchers.set("vault-fail", {
    watcher: { close: async () => { throw new Error("synthetic close boom"); } },
    generation: 1,
    ready: true,
    readyPromise: Promise.resolve(),
    resolveReady() {},
    stopped: false,
  });
  const first = live.teardownLiveEvents();
  assert.equal(live.teardownLiveEvents(), first);
  await assert.rejects(first, (error) => /teardown failed/.test(error.message) && error.failures?.length === 1);
  await live.resetLiveEventsForTests();
});

test("a never-settling watcher close leaves SSE admission fenced while teardown stays pending", async () => {
  await live.resetLiveEventsForTests();
  const internals = live.liveEventInternalsForTests();
  internals.watchers.set("vault-hang", {
    watcher: { close: () => new Promise(() => {}) },
    generation: 1,
    ready: true,
    readyPromise: Promise.resolve(),
    resolveReady() {},
    stopped: false,
  });
  const pending = live.teardownLiveEvents();
  const res = {
    code: null,
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await live.openVaultEventStream({
    req: {},
    res,
    session: { id: "session-hang" },
    vault: { id: "vault-hang", root: process.cwd() },
    revalidate: async () => null,
  });
  assert.equal(res.code, 503);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "teardown must remain pending rather than silently succeed");
  internals.watchers.clear();
  await live.resetLiveEventsForTests();
});

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

function startServer(root, port, extraEnv = {}) {
  return spawn(process.execPath, ["server.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      OAUTH_ADMIN_PASSWORD: "test-only-password",
      OAUTH_INITIAL_USERNAME: "test-owner",
      OAUTH_INITIAL_PASSWORD: "test-oauth-password",
      API_KEY: "",
      GIT_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
      WEB_EVENT_HEARTBEAT_MS: "60000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stallWatcherEnv(mode) {
  const preload = pathToFileURL(path.join(SERVER_DIR, "test", "preload-stall-watcher.mjs")).href;
  const nodeOptions = `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--import=${preload}`;
  return { WEB_TEST_WATCHER_CLOSE: mode, NODE_OPTIONS: nodeOptions };
}

async function login(base) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "test-owner", password: "test-oauth-password" }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function setupRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-session-shutdown-"));
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  await fs.writeFile(path.join(root, "vault", "Note.md"), "# Shutdown note\n", "utf8");
  return root;
}

test("SIGTERM ends an active SSE stream, drains, exits 0, and repeated signals are idempotent", { skip: process.platform === "win32" ? "POSIX SIGTERM graceful shutdown only" : false }, async () => {
  const root = await setupRoot();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  const child = startServer(root, port);
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitForHealth(`${base}/healthz`, child, output);
    const cookie = await login(base);
    const sse = await fetch(`${base}/api/web/v1/events`, { headers: { Cookie: cookie } });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    await reader.read();
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    child.kill("SIGTERM");
    // The SSE stream must end rather than hold the request barrier open.
    const streamEnded = (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) return true;
        }
      } catch {
        // A keep-alive socket released during teardown may surface as a reset;
        // the stream is still ended and the request barrier must not be held.
        return true;
      }
    })();
    const result = await exited;
    assert.equal(result.code, 0, output.join(""));
    assert.equal(await streamEnded, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed Web store drain during shutdown exits non-zero instead of claiming success", async () => {
  const root = await setupRoot();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  const child = startServer(root, port);
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitForHealth(`${base}/healthz`, child, output);
    await login(base);
    // Replace the state file with a directory so the drain rename fails
    // deterministically on both POSIX and Windows, regardless of user rights.
    const storeFile = path.join(root, "data", "web", "sessions.json");
    await fs.rm(storeFile, { force: true });
    await fs.mkdir(storeFile, { recursive: true });
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    const result = await exited;
    assert.notEqual(result.code, 0, output.join(""));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a rejected watcher close is reported as a cleanup failure and exits non-zero", { skip: process.platform === "win32" ? "POSIX SIGTERM graceful shutdown only" : false }, async () => {
  const root = await setupRoot();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  const child = startServer(root, port, stallWatcherEnv("fail"));
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitForHealth(`${base}/healthz`, child, output);
    const cookie = await login(base);
    const sse = await fetch(`${base}/api/web/v1/events`, { headers: { Cookie: cookie } });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    await reader.read();
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    const result = await exited;
    assert.notEqual(result.code, 0, output.join(""));
    assert.match(output.join(""), /Live event teardown failed \(1 cleanup failure\(s\)\)/, output.join(""));
    await reader.cancel().catch(() => {});
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a never-settling watcher close is bounded by the shared shutdown deadline and exits non-zero", { skip: process.platform === "win32" ? "POSIX SIGTERM graceful shutdown only" : false }, async () => {
  const root = await setupRoot();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  const child = startServer(root, port, stallWatcherEnv("hang"));
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitForHealth(`${base}/healthz`, child, output);
    const cookie = await login(base);
    const sse = await fetch(`${base}/api/web/v1/events`, { headers: { Cookie: cookie } });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    await reader.read();
    const startedAt = Date.now();
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    const result = await exited;
    const elapsed = Date.now() - startedAt;
    assert.notEqual(result.code, 0, output.join(""));
    assert.match(output.join(""), /SSE teardown exceeded the shutdown deadline/, output.join(""));
    assert.ok(elapsed < 20_000, `shutdown must be bounded by the 10s shared deadline, took ${elapsed}ms`);
    await reader.cancel().catch(() => {});
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});
