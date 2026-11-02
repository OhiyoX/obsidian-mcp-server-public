// Hot Routes Phase 0-A — evidence group 3: pinned-SDK resource-read transport
// probe.
//
// Feasibility probe only. It uses an isolated loopback (127.0.0.1, ephemeral
// port) synthetic MCP server and a synthetic resource with fake identities and
// scopes. It never contacts the production server, never reads a live Vault,
// and never attempts exploitation. It records what the pinned SDK actually
// delivers to a resource read callback:
//
//   - is `extra.authInfo` present per request?
//   - does it change across requests on the same MCP session?
//   - is "missing auth" distinguishable from "auth disabled"?
//   - can a scope check fail closed without leaking route/tool metadata?
//
// It does NOT claim that app/src/resources.js implements any scope filter.
// The synthetic scope-filtered handler below is a probe of the SDK seam, not a
// statement about current production resources.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SDK_VERSION = JSON.parse(
  await readFile(new URL("../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url), "utf8"),
).version;
const LOCKED_SDK_VERSION = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
).packages["node_modules/@modelcontextprotocol/sdk"].version;

const PROBE_URI = "obsidian://hot/routes";
const RECOMMENDATION_MARKERS = ["project-entry", "recommendedTool", "get_note", "_Workspace/README.md"];

function parseIdentity(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const [clientId, scopeList = ""] = match[1].split("|");
  return {
    type: "test",
    clientId,
    scopes: scopeList.split(",").map((value) => value.trim()).filter(Boolean),
    allowedVaults: ["vault"],
  };
}

// `handlerMode`:
//   "open"          -> always returns content, records extra.authInfo
//   "scope-filtered" -> fails closed when obsidian.read is absent
async function startResourceHarness(t, { authDisabled = false, handlerMode = "open" } = {}) {
  const observed = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const sessions = new Map();

  app.use((req, _res, next) => {
    if (authDisabled) {
      req.auth = undefined;
      next();
      return;
    }
    req.auth = parseIdentity(req.header("authorization"));
    next();
  });

  app.post("/mcp", async (req, res) => {
    if (!authDisabled && !req.auth) {
      res.status(401).json({ error: "invalid_token", error_description: "Missing access token" });
      return;
    }
    try {
      const sessionId = req.header("mcp-session-id");
      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record) {
          res.status(404).end();
          return;
        }
        await record.transport.handleRequest(req, res, req.body);
        return;
      }
      const server = new McpServer({ name: "hot-routes-resource-probe", version: "1" });
      server.registerResource(
        "hot-routes-probe",
        PROBE_URI,
        { title: "Probe", description: "Synthetic Hot Routes probe resource.", mimeType: "application/json" },
        async (uri, extra) => {
          const authInfo = extra?.authInfo ?? null;
          observed.push({
            uri: String(uri),
            clientId: authInfo?.clientId ?? null,
            scopes: authInfo?.scopes ?? null,
          });
          if (handlerMode === "scope-filtered" && !authInfo?.scopes?.includes("obsidian.read")) {
            // Fail closed before any route/tool metadata is constructed.
            throw new Error("insufficient_scope");
          }
          return {
            contents: [{
              uri: String(uri),
              mimeType: "application/json",
              text: JSON.stringify({
                routes: [{ id: "project-entry", recommendedTool: "get_note", target: "_Workspace/README.md" }],
              }),
            }],
          };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { transport, server }),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        server.close().catch(() => {});
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: String(error?.message || error) });
    }
  });

  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    for (const record of sessions.values()) await record.server.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return { port: httpServer.address().port, observed };
}

async function rpc(port, method, params, { session, authorization } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  if (authorization) headers.authorization = authorization;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
  const text = await response.text();
  const payload = !text
    ? null
    : response.headers.get("content-type")?.includes("event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((message) => message.id === 7)
      : JSON.parse(text);
  return { status: response.status, payload, session: response.headers.get("mcp-session-id") || session };
}

async function openSession(port, { authorization } = {}) {
  const init = await rpc(
    port,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "resource-auth-probe", version: "1" } },
    { authorization },
  );
  assert.equal(init.status, 200);
  assert.ok(init.session, "initialize must return a session id");
  return init.session;
}

async function readProbe(port, session, { authorization } = {}) {
  return rpc(port, "resources/read", { uri: PROBE_URI }, { session, authorization });
}

test("the probe is pinned to the installed and locked SDK version", () => {
  assert.equal(SDK_VERSION, LOCKED_SDK_VERSION);
  assert.equal(SDK_VERSION, "1.32.1");
});

test("resource read callback receives per-request extra.authInfo on a permitted read", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "open" });
  const session = await openSession(port, { authorization: "Bearer client-a|obsidian.read" });
  const response = await readProbe(port, session, { authorization: "Bearer client-a|obsidian.read" });

  assert.equal(response.status, 200);
  assert.ok(!response.payload.error, JSON.stringify(response.payload.error));
  assert.equal(response.payload.result.contents.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].clientId, "client-a");
  assert.deepEqual(observed[0].scopes, ["obsidian.read"]);
});

test("scope and identity changes are observed per request on the same MCP session", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "open" });
  const session = await openSession(port, { authorization: "Bearer client-a|obsidian.read" });

  await readProbe(port, session, { authorization: "Bearer client-a|obsidian.read" });
  await readProbe(port, session, { authorization: "Bearer client-b|obsidian.read,obsidian.write" });

  assert.equal(observed.length, 2);
  assert.equal(observed[0].clientId, "client-a");
  assert.deepEqual(observed[0].scopes, ["obsidian.read"]);
  assert.equal(observed[1].clientId, "client-b", "the same session must not reuse the first identity");
  assert.deepEqual(observed[1].scopes, ["obsidian.read", "obsidian.write"], "scopes must be recomputed per request");
});

test("missing auth is rejected before the resource handler runs", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "open" });
  const response = await rpc(
    port,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "resource-auth-probe", version: "1" } },
  );

  assert.equal(response.status, 401);
  assert.equal(observed.length, 0, "handler must not run when auth is required and absent");
});

test("auth-disabled server runs the handler with no authInfo, distinct from missing auth", async (t) => {
  const { port, observed } = await startResourceHarness(t, { authDisabled: true, handlerMode: "open" });
  const session = await openSession(port);
  const response = await readProbe(port, session);

  assert.equal(response.status, 200);
  assert.ok(!response.payload.error, JSON.stringify(response.payload.error));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].clientId, null);
  assert.equal(observed[0].scopes, null);
});

test("a scope-filtered resource fails closed without leaking route or tool metadata", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "scope-filtered" });
  const session = await openSession(port, { authorization: "Bearer client-c|obsidian.files" });
  const response = await readProbe(port, session, { authorization: "Bearer client-c|obsidian.files" });

  assert.equal(observed.length, 1, "the handler ran and could inspect the live scope");
  assert.deepEqual(observed[0].scopes, ["obsidian.files"]);
  assert.ok(response.payload.error, "a scope-filtered handler must produce an error result");
  const serialized = JSON.stringify(response.payload);
  for (const marker of RECOMMENDATION_MARKERS) {
    assert.ok(!serialized.includes(marker), `denied response must not expose ${marker}`);
  }
});

test("a scope-filtered resource permits a read when obsidian.read is present", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "scope-filtered" });
  const session = await openSession(port, { authorization: "Bearer client-r|obsidian.read" });
  const response = await readProbe(port, session, { authorization: "Bearer client-r|obsidian.read" });

  assert.equal(response.status, 200);
  assert.ok(!response.payload.error, JSON.stringify(response.payload.error));
  assert.deepEqual(observed[0].scopes, ["obsidian.read"]);
  const serialized = JSON.stringify(response.payload);
  for (const marker of RECOMMENDATION_MARKERS) {
    assert.ok(serialized.includes(marker), `permitted response should expose ${marker}`);
  }
});

// This is the case the plain open-handler identity-switch test cannot prove:
// a permitted read followed by a scope downgrade on the same MCP session must
// fail closed, because the scope is recomputed per request rather than cached
// at session initialization.
test("same-session scope downgrade fails closed and exposes no route/tool metadata", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "scope-filtered" });
  const session = await openSession(port, { authorization: "Bearer client-d|obsidian.read" });

  const permitted = await readProbe(port, session, { authorization: "Bearer client-d|obsidian.read" });
  assert.equal(permitted.status, 200);
  assert.ok(!permitted.payload.error, JSON.stringify(permitted.payload.error));

  const denied = await readProbe(port, session, { authorization: "Bearer client-d|obsidian.files" });
  assert.equal(observed.length, 2, "the handler ran on both requests and inspected the live scope");
  assert.deepEqual(observed[0].scopes, ["obsidian.read"]);
  assert.deepEqual(observed[1].scopes, ["obsidian.files"]);
  assert.ok(denied.payload.error, "a downgraded scope on the same session must be denied");
  const serialized = JSON.stringify(denied.payload);
  for (const marker of RECOMMENDATION_MARKERS) {
    assert.ok(!serialized.includes(marker), `denied response must not expose ${marker}`);
  }
});

// Existing-session revocation: once a session is established, a request that
// no longer carries valid credentials must be rejected at the HTTP layer before
// the resource handler runs (unlike auth-disabled mode, where the handler runs
// with authInfo === undefined).
test("revoked/missing auth on an existing session is rejected before the handler", async (t) => {
  const { port, observed } = await startResourceHarness(t, { handlerMode: "scope-filtered" });
  const session = await openSession(port, { authorization: "Bearer client-e|obsidian.read" });

  const permitted = await readProbe(port, session, { authorization: "Bearer client-e|obsidian.read" });
  assert.ok(!permitted.payload.error, JSON.stringify(permitted.payload.error));
  const observedBefore = observed.length;

  const revoked = await readProbe(port, session);
  assert.equal(revoked.status, 401);
  assert.equal(observed.length, observedBefore, "the handler must not run when auth is revoked/absent on an existing session");
});
