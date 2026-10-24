// Real-HTTP contract for stale-session recovery on POST /mcp.
//
// The defect this pins: a host that holds one MCP connection per conversation and
// keeps sending an expired/unknown `Mcp-Session-Id` used to get
// `404 {"code":-32000,"message":"Session not found"}` for every later tool call,
// even though the server was healthy and the credential valid. With
// MCP_SESSION_RECOVERY=stateless the request is answered once without session
// state; with `off` the historical 404 is preserved.
//
// One stateless server covers the whole stateless contract (recovery, boundaries,
// stale-id re-initialize, and the sensitive mutation + sticky-author path) so the
// suite pays for a single extra server process; the `off` server is a second spawn.
// Counters are read as deltas because the contract is sequential.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/frontmatter.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "test-only-recovery-key";

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
    const finish = () => {
      clearTimeout(escalate);
      resolve();
    };
    child.once("exit", finish);
    escalate = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

async function waitForHealth(base, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server: ${output.join("")}`);
}

async function startServer(t, { recovery }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `obsidian-mcp-recovery-${recovery}-`));
  const port = await freePort();
  await fs.mkdir(path.join(root, "vault", "_Workspace"), { recursive: true });
  await fs.writeFile(path.join(root, "vault", "_Workspace", "Seed.md"), "# Seed\n", "utf8");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      DATA_PATH: path.join(root, "data"),
      API_KEY,
      API_KEY_HEADER: "X-API-Key",
      OAUTH_ENABLED: "false",
      GIT_ENABLED: "false",
      // Keep the spawned server cheap: the suite runs in parallel with other
      // wall-clock-sensitive tests, so it must not build a Web catalog.
      WEB_CATALOG_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
      MCP_SESSION_RECOVERY: recovery,
      MCP_SESSION_RECOVERY_MAX_INFLIGHT: "4",
      // Pin the author fallbacks so attribution assertions cannot be influenced by
      // the developer's own environment.
      MCP_DEFAULT_AUTHOR_AGENT: "",
      MCP_DEFAULT_AUTHOR_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child, output);
  return { base, vault: path.join(root, "vault") };
}

async function mcpPost(base, { body, session, key = API_KEY } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { "X-API-Key": key } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))[0]
    : text
      ? JSON.parse(text)
      : null;
  return { status: response.status, session: response.headers.get("mcp-session-id"), payload };
}

// `mcp-client` is the generic placeholder that makes the policy `client` label the
// write author, which is the documented path for hosts such as Cursor and ZCode.
function initializeBody(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-client", version: "1" } },
  };
}

function callBody(id, name, args = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function healthz(base) {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  return response.json();
}

test("a stale session id keeps the conversation working, including writes and authorship", async (t) => {
  const { base, vault } = await startServer(t, { recovery: "stateless" });
  const noteAuthor = async (relative) => parseFrontmatter(await fs.readFile(path.join(vault, relative), "utf8")).data.mcp_author;

  const initialized = await mcpPost(base, { body: initializeBody() });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.session, "initialize must return a session id");
  const baseline = await healthz(base);
  assert.equal(baseline.sessions, 1);
  assert.equal(baseline.sessionRecovery.recovered, 0);

  // The unknown-but-well-formed id a host keeps after expiry or a restart.
  const stale = randomUUID();
  const recovered = await mcpPost(base, { body: callBody(2, "server_info"), session: stale });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.payload));
  assert.equal(recovered.payload.error, undefined);
  assert.ok(recovered.payload.result, "the recovered call must return a real tool result");
  assert.equal(recovered.session, null, "stateless recovery must not hand out a session id");
  assert.equal((await healthz(base)).sessions, 1, "recovery must not register a session");

  // Repeated calls on the same stale id keep working: hosts do not re-initialize.
  const again = await mcpPost(base, { body: callBody(3, "server_info"), session: stale });
  assert.equal(again.status, 200);
  assert.ok(again.payload.result);

  // A malformed id keeps the historical 404 so a genuinely wrong header surfaces.
  const malformed = await mcpPost(base, { body: callBody(4, "server_info"), session: "not-a-session" });
  assert.equal(malformed.status, 404);
  assert.equal(malformed.payload.error.code, -32000);
  assert.equal(malformed.payload.error.message, "Session not found");

  // Control for the authorship contract below: a recovered request has no
  // `initialize`, so without a bootstrap the attribution falls back to the
  // documented placeholder rather than inheriting the old session's clientInfo.
  const beforeBootstrap = await mcpPost(base, {
    body: callBody(5, "write_note", { path: "AuthorBefore.md", content: "before\n" }),
    session: randomUUID(),
  });
  assert.equal(beforeBootstrap.status, 200, JSON.stringify(beforeBootstrap.payload));
  assert.deepEqual(await noteAuthor("AuthorBefore.md"), { agent: "mcp-client", model: "unspecified" });

  // The host declares its identity once; the sticky author is keyed by auth clientId
  // and must survive the stateless recovery transport.
  const bootstrap = await mcpPost(base, {
    body: callBody(6, "agent_bootstrap", { client: "zcode", model: "glm-5.3" }),
    session: initialized.session,
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.payload.result.structuredContent.writeAuthor, { agent: "zcode", model: "glm-5.3" });

  const writtenThroughRecovery = await mcpPost(base, {
    body: callBody(7, "write_note", { path: "AuthorAfter.md", content: "after\n" }),
    session: randomUUID(),
  });
  assert.equal(writtenThroughRecovery.status, 200, JSON.stringify(writtenThroughRecovery.payload));
  assert.equal(writtenThroughRecovery.payload.error, undefined);
  assert.equal(writtenThroughRecovery.session, null);
  assert.deepEqual(await noteAuthor("AuthorAfter.md"), { agent: "zcode", model: "glm-5.3" });

  // A host that does re-initialize while still sending a stale header gets a fresh
  // session instead of a 404.
  const reinitialized = await mcpPost(base, { body: initializeBody(8), session: randomUUID() });
  assert.equal(reinitialized.status, 200);
  assert.ok(reinitialized.session, "a fresh session id must be issued");
  const onFresh = await mcpPost(base, { body: callBody(9, "server_info"), session: reinitialized.session });
  assert.equal(onFresh.status, 200);
  assert.ok(onFresh.payload.result);

  // Unchanged boundaries: GET with an unknown id, no credentials, and no id.
  const get = await fetch(`${base}/mcp`, { headers: { "Mcp-Session-Id": randomUUID(), "X-API-Key": API_KEY, Accept: "text/event-stream" } });
  assert.equal(get.status, 404);
  const anonymous = await mcpPost(base, { body: callBody(10, "server_info"), session: randomUUID(), key: null });
  assert.equal(anonymous.status, 401);
  const noSession = await mcpPost(base, { body: callBody(11, "server_info") });
  assert.equal(noSession.status, 400);
  assert.equal(noSession.payload.error.code, -32000);
  assert.match(noSession.payload.error.message, /initialize first/);

  const finalHealth = await healthz(base);
  assert.equal(finalHealth.sessions, 2, "only real initialize calls register sessions");
  assert.equal(finalHealth.sessionRecovery.mode, "stateless");
  assert.equal(finalHealth.sessionRecovery.recovered, 4);
  assert.equal(finalHealth.sessionRecovery.failed, 0);
  assert.equal(finalHealth.sessionRecovery.rejected, 0);
  assert.equal(finalHealth.sessionRecovery.active, 0, "recovered transports close with their response");
});

test("MCP_SESSION_RECOVERY=off keeps the strict Session not found answer", async (t) => {
  const { base } = await startServer(t, { recovery: "off" });

  const initialized = await mcpPost(base, { body: initializeBody() });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.session);

  const stale = await mcpPost(base, { body: callBody(2, "server_info"), session: randomUUID() });
  assert.equal(stale.status, 404);
  assert.equal(stale.payload.error.code, -32000);
  assert.equal(stale.payload.error.message, "Session not found");

  const health = await healthz(base);
  assert.equal(health.sessionRecovery.mode, "off");
  assert.equal(health.sessionRecovery.recovered, 0);
  assert.equal(health.sessions, 1);
});
