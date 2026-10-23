// Issue #285 — real-server HTTP integration for audit attribution.
//
// Pure helper tests cannot see middleware order, the MCP session lifecycle
// (initialize → session id → later tools/call) or the actual persisted audit row.
// This spawns the real `server.js` against a scratch vault/data root and asserts
// the audit records the server really wrote.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ADMIN_PASSWORD = "audit-attribution-admin-password";
const ENV_API_KEY = "audit-attribution-configured-env-key";

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
    child.kill();
  });
}

async function waitForHealth(url, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}): ${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the server: ${output.join("")}`);
}

async function rpc(url, key, method, params, session, id, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { "X-API-Key": key } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const payload = response.headers.get("content-type")?.includes("event-stream")
    ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((item) => item.id === id)
    : JSON.parse(body);
  assert.ok(payload && !payload.error, JSON.stringify(payload));
  return { result: payload.result, session: response.headers.get("mcp-session-id") || session };
}

/** Polls the persisted audit until the expected row exists (audit saves are debounced). */
async function waitForAudit(root, predicate, description) {
  const file = path.join(root, "data", "oauth", "state.json");
  let seen = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      seen = Array.isArray(parsed.audit) ? parsed.audit : [];
      const match = seen.find(predicate);
      if (match) return match;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`audit row never appeared: ${description}\nrows=${JSON.stringify(seen.map((row) => ({ action: row.action, agent: row.agent, agentSource: row.agentSource, source: row.source, sourceKind: row.sourceKind })), null, 1)}`);
}

test("a real MCP session records clientInfo, ignores forged XFF and labels the API Key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "i285-audit-attribution-"));
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      OAUTH_ADMIN_PASSWORD: ADMIN_PASSWORD,
      OAUTH_INITIAL_USERNAME: "audit-owner",
      OAUTH_INITIAL_PASSWORD: "audit-owner-password",
      // Explicitly untrusted ingress: a direct peer must not be able to forge a source.
      TRUST_PROXY: "",
      API_KEY: ENV_API_KEY,
      GIT_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(() => stopChild(child));
  // #428: the catalog is `<DATA_PATH>/web-catalog`, inside this test's temp root, and node:test runs
  // `after` hooks in registration order — stop the server before deleting the root, or Windows
  // cannot unlink the SQLite file the live child still holds.
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await waitForHealth(`${origin}/healthz`, child, output);

  // 1) initialize declares a real clientInfo; undici UA alone would be blank.
  const initialized = await rpc(`${origin}/mcp`, ENV_API_KEY, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "9.1" },
  }, undefined, 1, { "User-Agent": "undici" });
  assert.ok(initialized.session, "initialize must return a session id");
  const initializeRow = await waitForAudit(root, (row) => row.action === "mcp.initialize" && row.credentialId === "configured-env", "configured-env initialize");
  assert.equal(initializeRow.agent, "pi");
  assert.equal(initializeRow.agentSource, "clientInfo");
  assert.equal(initializeRow.clientInfoName, "pi");
  assert.equal(initializeRow.clientInfoVersion, "9.1");
  assert.equal(initializeRow.genericClient, "undici");
  assert.equal(initializeRow.source, "127.0.0.1");
  assert.equal(initializeRow.sourceKind, "loopback");
  assert.equal(initializeRow.sourceTrusted, false);
  assert.equal(initializeRow.sourceTrustedEntry, "none");

  // 2) a later tools/call in the same session resolves that clientInfo (session binding).
  await rpc(`${origin}/mcp`, ENV_API_KEY, "tools/call", { name: "list_notes", arguments: {} }, initialized.session, 2, { "User-Agent": "undici" });
  const callRow = await waitForAudit(root, (row) => row.action === "mcp.tool.list_notes" && row.credentialId === "configured-env", "configured-env tools/call");
  assert.equal(callRow.agent, "pi", "the session-bound clientInfo must reach the audit row");
  assert.equal(callRow.agentSource, "clientInfo");
  assert.equal(callRow.clientInfoName, "pi");
  assert.equal(callRow.userAgent, "undici");
  assert.equal(callRow.genericClient, "undici");

  // 3) a forged chain on an untrusted direct peer must not become the source.
  await rpc(`${origin}/mcp`, ENV_API_KEY, "tools/call", { name: "list_tags", arguments: {} }, initialized.session, 3, {
    "User-Agent": "undici", "X-Forwarded-For": "203.0.113.9",
  });
  const forgedRow = await waitForAudit(root, (row) => row.action === "mcp.tool.list_tags" && row.credentialId === "configured-env", "configured-env tools/call with forged XFF");
  assert.equal(forgedRow.source, "127.0.0.1", "raw XFF must be ignored from an untrusted peer");
  assert.equal(forgedRow.sourcePeer, "127.0.0.1");
  assert.deepEqual(forgedRow.forwardedChain, ["203.0.113.9"]);
  assert.equal(forgedRow.sourceTrusted, false);
  assert.equal(forgedRow.sourceTrustedEntry, "none");
  assert.equal(forgedRow.sourceKind, "untrusted-forwarded");

  // 4) an administrator-created API Key: its label is the best available identity.
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const adminPage = await (await fetch(`${origin}/admin/auth?tab=keys`, { headers: { Cookie: cookie } })).text();
  const csrf = adminPage.match(/name="csrf" value="([^"]+)"/)[1];
  const created = await fetch(`${origin}/admin/auth/api-key/create`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, label: "NAS undici key" }),
  });
  assert.equal(created.status, 303);
  const keysPage = await (await fetch(`${origin}/admin/auth?tab=keys`, { headers: { Cookie: cookie } })).text();
  const managedKey = keysPage.match(/obmcp_[0-9a-f]{12}_[A-Za-z0-9_-]+/)[0];

  await rpc(`${origin}/mcp`, managedKey, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-client", version: "1" },
  }, undefined, 4, { "User-Agent": "node" });
  const labelRow = await waitForAudit(root, (row) => row.action === "mcp.initialize" && row.credentialId !== "configured-env" && row.agentSource === "apiKeyLabel", "managed key initialize");
  assert.equal(labelRow.agent, "NAS undici key");
  assert.equal(labelRow.agentSource, "apiKeyLabel");
  assert.equal(labelRow.clientInfoName, null, "a placeholder clientInfo must not be recorded as an identity");
  assert.equal(labelRow.genericClient, "node");
  assert.equal(labelRow.userAgent, "node");

  // 5) the Admin audit table renders the new attribution without leaking the key.
  const auditHtml = await (await fetch(`${origin}/admin/auth?tab=audit&pageSize=100`, { headers: { Cookie: cookie } })).text();
  // The attribution source is per row now (prototype `5-render.js` Agent column + `.uax` detail): the
  // prototype has no `agentSource` filter, so the class is named on the row itself. A credential that
  // carries a Key label must be attributed to that label, never to a User-Agent guess.
  assert.match(auditHtml, /Agent 来源：/);
  assert.doesNotMatch(auditHtml, /Agent（UA 推测）/);
  assert.match(auditHtml, /<span class="ell">NAS undici key<\/span><span class="sub2">Key 备注<\/span>/, "the labelled credential keeps its Key-label attribution");
  assert.match(auditHtml, /本机/);
  // The retired v2 wording is gone; what must still hold is that the page never promotes the
  // placeholder clientInfo to an identity, and that it names every attribution class honestly.
  assert.doesNotMatch(auditHtml, /<span class="ell">mcp-client<\/span>/, "the placeholder clientInfo is never rendered as an Agent");
  assert.match(auditHtml, /Key 备注/);
  assert.match(auditHtml, /X-Forwarded-For：[\s\S]{0,80}（未受信，仅诊断）/, "a forged chain stays diagnostic");
  assert.match(auditHtml, /NAS undici key/);
  assert.match(auditHtml, /pi/);
  assert.doesNotMatch(auditHtml, new RegExp(managedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the audit page must never render the API key secret");
  assert.doesNotMatch(auditHtml, /Bearer [A-Za-z0-9._-]+/);
});
