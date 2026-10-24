import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { apiKeyRequired, authCorsHeaders, authMode, createAuthMiddleware, oauthEnabled } from "./src/auth.js";
import { registerObsidianCapabilities, TOOL_NAMES } from "./src/capabilities.js";
import { createDiscoveryRuntimePolicy, loadDiscoveryOperatorConfig } from "./src/discovery-runtime.js";
import { headerValue, jsonRpcError } from "./src/http.js";
import { AUTHZ_ENABLED, CORS_ORIGIN, HOST, JSON_LIMIT, MCP_PATH, MCP_SERVER_NAME, MCP_SERVER_VERSION, OAUTH_ENABLED, PORT, PROTECT_HEALTH, PUBLIC_BASE_URL, TRUST_PROXY } from "./src/server-config.js";
import { createMcpSessionRegistry } from "./src/mcp-sessions.js";
import { getVaultHealth, primaryRuntime } from "./src/vault.js";
import { createVaultCompositionRoot } from "./src/vault-runtime/vault-composition-root.js";
import { AGENT_INSTRUCTIONS } from "./src/agent-bootstrap.js";
import { createOAuthService, OAUTH_SCOPES } from "./src/oauth-provider.js";
import { oauthEndpointHardening } from "./src/oauth/hardening.js";
import { createAdminRouter } from "./src/admin/router.js";
import { createAccessPolicyWiring } from "./src/access-policy/server-wiring.js";
import { createWebAppRouter } from "./src/app/routes.js";
import { mountDirectUpload } from "./src/direct-upload.js";
import { createWebSessionStore } from "./src/app/web-session-store.js";
import { teardownLiveEvents } from "./src/app/live-events.js";
import { DATA_PATH, READ_ONLY, VAULT } from "./src/config.js";
import { gitConfigStoreInstance, primaryGitRuntime } from "./src/git.js";
import { listWebVaults, webVaultRegistry, vaultAdmissionAdmin } from "./src/app/vault-registry.js";
import { loadVaultDiscoveryState, startVaultDiscoverySchedulers, startVaultRuntimeInventory, stopVaultDiscoverySchedulers, vaultDiscoveryHealth } from "./src/app/vault-startup.js";
import { publishVaultResync } from "./src/app/live-events.js";
import { getWebCatalogRuntime } from "./src/app/web-catalog/runtime.js";
import { requireRequestAuthor, withRequestContext } from "./src/request-context.js";
import { publishService } from "./src/publish/service.js";
import { recoverPendingBatches } from "./src/batch-journal.js";
import { deployedVersion, deployTimeFields } from "./src/release-version.js";

const discoveryOperatorConfig = loadDiscoveryOperatorConfig();
if (discoveryOperatorConfig.warning) console.warn(`[discovery] ${discoveryOperatorConfig.warning}`);

// Wave D / D0: the per-Vault runtime map, assigned once the composition root has built the
// canonical registry below. `createMcpServer` runs per session, long after module init.
let vaultScopeDeps;

function createMcpServer() {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  }, { instructions: AGENT_INSTRUCTIONS });

  const discovery = createDiscoveryRuntimePolicy(server, discoveryOperatorConfig, { authDisabled: authMode === "none" });
  registerObsidianCapabilities(discovery, { accessRuntime: accessPolicy.runtime, vaultScope: vaultScopeDeps });
  discovery.install();
  return server;
}

// MCP session lifecycle (registry, stale-session recovery, principal ownership,
// hard-revoke close, idle TTL reaper) is owned by src/mcp-sessions.js.
const { sessions, sessionRecovery, createSessionTransport, closeSessionsForClient, sessionBelongsToAuth, startReaper } = createMcpSessionRegistry({ createServer: createMcpServer });

function isInitializeRequest(body) {
  if (Array.isArray(body)) {
    return body.some((message) => message?.method === "initialize");
  }
  return body?.method === "initialize";
}

const app = express();
app.set("trust proxy", TRUST_PROXY);

// Shutdown admission fence and active-request barrier. SSE is ended by
// teardownLiveEvents() before the barrier so long-lived responses cannot deadlock.
let shuttingDown = false;
let activeRequests = 0;
let resolveIdle = null;
app.use((req, res, next) => {
  if (shuttingDown) return res.status(503).json({ error: "Server is shutting down" });
  activeRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRequests -= 1;
    if (activeRequests === 0 && resolveIdle) resolveIdle();
  };
  res.on("finish", release);
  res.on("close", release);
  next();
});
const faviconPath = fileURLToPath(new URL("./src/app/assets/favicon.svg", import.meta.url));
app.get("/favicon.svg", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(faviconPath);
});
const oauthService = OAUTH_ENABLED ? createOAuthService({ closeSessions: closeSessionsForClient }) : null;
// #364: admit the durable transfer fence (or refuse to start) before any credential is verified (§16).
await oauthService?.provider.ready;

// AuthZ Wave C wiring (INTERFACE §10.6): server.js only creates and injects it.
const accessPolicy = createAccessPolicyWiring({ enabled: AUTHZ_ENABLED, dataPath: DATA_PATH, oauthService });
await accessPolicy.ready;
const mcpAuthMiddleware = createAuthMiddleware(oauthService, { accessRuntime: accessPolicy.runtime, onHardRevoke: closeSessionsForClient });

// The server owns and injects the durable Web session store, and must prove it
// loadable (schema/bounds/corruption fail closed) before admission.
let webSessionStore = null;
if (oauthService) {
  webSessionStore = createWebSessionStore({ file: path.join(DATA_PATH, "web", "sessions.json") });
  await webSessionStore.ready;
}
await loadVaultDiscoveryState(); // W2 #437 §2.2: a corrupt/unreadable admission record refuses startup

if (oauthService) {
  const oauthRouterOptions = {
    provider: oauthService.provider,
    issuerUrl: oauthService.issuer,
    resourceServerUrl: oauthService.resource,
    scopesSupported: OAUTH_SCOPES,
    resourceName: "Obsidian Vault MCP",
  };
  const oauthMetadataTemplate = createOAuthMetadata(oauthRouterOptions);
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) {
    if (!oauthMetadataTemplate[key]) continue;
    const endpoint = new URL(oauthMetadataTemplate[key]);
    oauthMetadataTemplate[key] = new URL(`/oauth${endpoint.pathname}`, oauthService.issuer).href;
  }

  function authorizationServerMetadata(req) {
    const origin = oauthService.resolveOrigin(req);
    const issuer = `${origin}/`;
    const metadata = { ...oauthMetadataTemplate, issuer };
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) {
      if (!metadata[key]) continue;
      metadata[key] = new URL(new URL(metadata[key]).pathname, issuer).href;
    }
    return metadata;
  }

  function protectedResourceMetadata(req) {
    const origin = oauthService.resolveOrigin(req);
    const issuer = `${origin}/`;
    const resource = oauthService.resourceForOrigin(origin);
    return {
      resource: resource.href,
      authorization_servers: [issuer],
      scopes_supported: OAUTH_SCOPES,
      resource_name: "Obsidian Vault MCP",
    };
  }

  // Host-aware discovery must win over the SDK router so work aliases never advertise the private canonical origin.
  app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(authorizationServerMetadata(req)));
  app.get("/.well-known/oauth-protected-resource", (req, res) => res.json(protectedResourceMetadata(req)));
  app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => res.json(protectedResourceMetadata(req)));
  // Tighten the upstream SDK auth endpoints before either router is mounted (malformed
  // PKCE challenges and raw validation dumps must not leak). See src/oauth/hardening.js.
  app.use(oauthEndpointHardening());
  const canonicalOAuthRouter = mcpAuthRouter(oauthRouterOptions);
  app.use("/oauth", (req, res, next) => withRequestContext(
    { oauthOrigin: oauthService.resolveOrigin(req) },
    () => canonicalOAuthRouter(req, res, next),
  ));
  // Keep the former root endpoints as explicit protocol compatibility routes: cached
  // connector metadata may still open /authorize although fresh metadata says /oauth/authorize.
  const compatibilityOAuthPaths = new Set(["/authorize", "/token", "/register", "/revoke"]);
  const compatibilityOAuthRouter = mcpAuthRouter(oauthRouterOptions);
  app.use((req, res, next) => compatibilityOAuthPaths.has(req.path)
    ? withRequestContext(
      { oauthOrigin: oauthService.resolveOrigin(req) },
      () => compatibilityOAuthRouter(req, res, next),
    )
    : next());
  app.post(oauthService.approvalPath, express.urlencoded({ extended: false, limit: "32kb" }), async (req, res) => {
    try {
      await oauthService.provider.handleApproval(req, res);
    } catch (error) {
      console.warn("OAuth authorization denied:", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.status(403).send("Authorization denied. Return to the MCP client and try again.");
    }
  });
  // Wave E / EA + Wave F / F1 (D1): Vault composition root (extracted to satisfy F1's line budget).
  const { vaultGitAdmin, vaultGitStore, vaultRuntimeMap, vaultScopeDeps: vaultScope } = createVaultCompositionRoot({
    registry: webVaultRegistry,
    primaryRuntime, primaryRoot: VAULT, dataRoot: DATA_PATH, writable: !READ_ONLY, admission: vaultAdmissionAdmin,
  });
  vaultScopeDeps = vaultScope;
  await startVaultRuntimeInventory({ runtimeMap: vaultRuntimeMap, logger: console });
  // W4 (#437): after the startup round published, arm the two long-lived automatic triggers. The
  // switch (`VAULT_DISCOVERY_ENABLED`) is the only gate; with it off nothing is started here.
  await startVaultDiscoverySchedulers({ logger: console });
  const authAdminRouter = createAdminRouter({
    provider: oauthService.provider,
    adminPassword: oauthService.provider.adminPassword,
    secureCookie: oauthService.issuer.protocol === "https:",
    configuredApiKeyEnabled: apiKeyRequired,
    onCredentialRevoked: closeSessionsForClient,
    listVaults: listWebVaults,
    publishService,
    publicBaseUrl: PUBLIC_BASE_URL,
    accessPolicyAdmin: accessPolicy.admin,
    vaultGitAdmin,
    vaultGitStore,
  });
  // Keep the historical admin entry point usable while the canonical router lives under /admin/auth.
  app.get("/admin", (_req, res) => res.redirect(302, "/admin/auth"));
  app.use("/admin/auth", authAdminRouter);
  app.use(createWebAppRouter({
    provider: oauthService.provider,
    secureCookie: oauthService.issuer.protocol === "https:",
    publishService,
    resolveOrigin: oauthService.resolveOrigin,
    webSessionStore,
    accessRuntime: accessPolicy.runtime,
  }));
  // Phase 2B cold start: build each catalog in the background so the lazy Explorer
  // does not 503 catalog-not-ready. This is startup work, never on the request path.
  listWebVaults()
    .then(async (inventory) => {
      for (const vault of inventory.vaults) {
        const runtime = getWebCatalogRuntime(vault);
        if (!runtime) continue;
        // Publish a ready signal once the initial reconcile lands (reload without a manual refresh).
        runtime
          .drain()
          .then(() => publishVaultResync(vault.id, "catalog-ready"))
          .catch(() => {});
      }
    })
    .catch(() => {});
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    ["Accept", "Authorization", "Content-Type", "Last-Event-ID", "Mcp-Session-Id", ...authCorsHeaders(), "mcp-session-id"].join(", "),
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id, WWW-Authenticate");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Issue #470 Wave A: `PUT /uploads/:uploadId` (DIRECT_UPLOAD_ENABLED=false removes it again).
mountDirectUpload(app, { auth: mcpAuthMiddleware, accessRuntime: accessPolicy.runtime, resolveRuntime: (id) => vaultScopeDeps?.resolveVaultRuntime(id) ?? null, provider: oauthService?.provider ?? null, writable: !READ_ONLY });

app.get("/", mcpAuthMiddleware, (_req, res) => {
  const release = deployedVersion();
  res.json({
    name: MCP_SERVER_NAME,
    version: release.version,
    ...deployTimeFields(release),
    transport: "streamable-http",
    endpoint: MCP_PATH,
    health: "/healthz",
    apiKeyRequired,
    oauthEnabled,
    authMode,
    tools: TOOL_NAMES,
    authorizationWindows: accessPolicy.summary(),
    sessions: sessions.size,
    sessionRecovery: sessionRecovery.stats(),
  });
});

app.get("/healthz", PROTECT_HEALTH ? mcpAuthMiddleware : (_req, _res, next) => next(), async (_req, res) => {
  const health = await getVaultHealth();
  const release = deployedVersion();
  res.status(health.ok ? 200 : 503).json({
    ...health,
    version: release.version,
    ...deployTimeFields(release),
    apiKeyRequired,
    oauthEnabled,
    authMode,
    protectHealth: PROTECT_HEALTH,
    authorizationWindows: accessPolicy.summary(),
    sessions: sessions.size,
    sessionRecovery: sessionRecovery.stats(),
    ...vaultDiscoveryHealth(),
  });
});

app.post(MCP_PATH, express.json({ limit: JSON_LIMIT, type: ["application/json", "application/*+json"] }), mcpAuthMiddleware, async (req, res) => {
  const sessionId = headerValue(req, "mcp-session-id");

  try {
    if (sessionId) {
      const record = sessions.get(sessionId);
      if (!record) {
        // A client that kept a stale id can either re-initialize (fresh session, stale
        // header ignored) or, with recovery enabled, be answered statelessly once.
        if (sessionRecovery.enabled && isInitializeRequest(req.body)) {
          const fresh = await createSessionTransport(req.auth);
          await fresh.transport.handleRequest(req, res, req.body);
          return;
        }
        if (await sessionRecovery.handle(req, res, sessionId)) return;
        if (!res.headersSent) jsonRpcError(res, 404, -32000, "Session not found");
        return;
      }
      if (!sessionBelongsToAuth(record, req.auth)) {
        jsonRpcError(res, 403, -32001, "MCP session belongs to a different authenticated principal");
        return;
      }
      record.lastAccessAt = Date.now();
      await record.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32000, "Bad Request: initialize first or provide mcp-session-id");
      return;
    }

    const record = await createSessionTransport(req.auth);
    await record.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP POST:", error);
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  }
});

app.get(MCP_PATH, mcpAuthMiddleware, async (req, res) => {
  const sessionId = headerValue(req, "mcp-session-id");
  if (!sessionId) {
    res.status(400).send("Missing mcp-session-id header");
    return;
  }

  const record = sessions.get(sessionId);
  if (!record) {
    res.status(404).send("Session not found");
    return;
  }
  if (!sessionBelongsToAuth(record, req.auth)) {
    res.status(403).send("MCP session belongs to a different authenticated principal");
    return;
  }
  record.lastAccessAt = Date.now();

  try {
    await record.transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling MCP GET:", error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
});

app.delete(MCP_PATH, mcpAuthMiddleware, async (req, res) => {
  const sessionId = headerValue(req, "mcp-session-id");
  if (!sessionId) {
    res.status(400).send("Missing mcp-session-id header");
    return;
  }

  const record = sessions.get(sessionId);
  if (!record) {
    res.status(404).send("Session not found");
    return;
  }
  if (!sessionBelongsToAuth(record, req.auth)) {
    res.status(403).send("MCP session belongs to a different authenticated principal");
    return;
  }
  record.lastAccessAt = Date.now();

  try {
    await record.transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling MCP DELETE:", error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error?.type === "entity.parse.failed") {
    jsonRpcError(res, 400, -32700, "Parse error: invalid JSON request body");
    return;
  }

  jsonRpcError(res, 500, -32603, "Internal server error");
});

// Refuse traffic until any interrupted multi-note commit is reconciled.
await recoverPendingBatches();
const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Obsidian MCP Streamable HTTP server listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

const sessionReaper = startReaper();

const SHUTDOWN_DEADLINE_MS = 10_000;
let shutdownPromise = null;

function waitForActiveRequests() {
  if (activeRequests === 0) return Promise.resolve();
  return new Promise((resolve) => { resolveIdle = resolve; });
}

function withDeadline(promise, deadlineAt, label) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(`${label} exceeded the shutdown deadline`));
  const tracked = Promise.resolve(promise);
  // If the timeout wins, the still-pending teardown must not surface as an unhandled rejection.
  tracked.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    // Deliberately ref'd: a never-settling teardown must keep the process alive until the deadline.
    timer = setTimeout(() => reject(new Error(`${label} exceeded the shutdown deadline`)), remaining);
  });
  return Promise.race([tracked, timeout]).finally(() => clearTimeout(timer));
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const deadlineAt = Date.now() + SHUTDOWN_DEADLINE_MS;
    let failed = false;
    const fail = (error) => {
      failed = true;
      console.error(`Shutdown cleanup failure: ${error?.message || error}`);
    };
    console.log(`Received ${signal}, closing ${sessions.size} MCP session(s)...`);
    shuttingDown = true;
    // W4 (#437): stop the automatic discovery triggers first — no watcher event or periodic round may
    // begin a reconciliation while the process is tearing down.
    try { stopVaultDiscoverySchedulers(); } catch (error) { fail(error); }

    // Begin teardown first: it synchronously fences new SSE admission and ends streams under
    // the shared deadline; the listener close is initiated immediately and never awaited before it.
    const teardownStarted = teardownLiveEvents();
    const httpClosed = new Promise((resolve) => httpServer.close(() => resolve()));
    httpServer.closeIdleConnections?.();
    try { await withDeadline(teardownStarted, deadlineAt, "SSE teardown"); }
    catch (error) { fail(error); }

    // Close/await already-admitted MCP transports.
    clearInterval(sessionReaper);
    for (const [sessionId, record] of sessions.entries()) {
      try { await withDeadline(record.transport.close(), deadlineAt, `MCP session ${sessionId}`); }
      catch (error) { fail(error); }
    }
    try { await withDeadline(sessionRecovery.close(), deadlineAt, "MCP stale-session recovery"); }
    catch (error) { fail(error); }

    // Wait for already-admitted HTTP requests; SSE is already ended above.
    try { await withDeadline(waitForActiveRequests(), deadlineAt, "HTTP request barrier"); }
    catch (error) { fail(error); }
    // Now that ended SSE responses are idle, release their keep-alive sockets.
    httpServer.closeIdleConnections?.();

    // Stop the Web store timer and drain the final dirty TTL, then provider state.
    try {
      if (webSessionStore) {
        const drained = await withDeadline(webSessionStore.drain(), deadlineAt, "Web session drain");
        if (!drained?.ok) throw new Error(`Web session drain failed: ${drained?.reason || "unknown"}`);
      }
    } catch (error) { fail(error); }
    try { if (accessPolicy.store) await withDeadline(accessPolicy.drain(), deadlineAt, "Access policy drain"); } catch (error) { fail(error); }
    try {
      if (oauthService?.provider?.drainPersistence) await withDeadline(oauthService.provider.drainPersistence(), deadlineAt, "OAuth persistence drain");
    } catch (error) { fail(error); }

    // Await the already-initiated listener close.
    try { await withDeadline(httpClosed, deadlineAt, "HTTP close"); }
    catch (error) {
      fail(error);
      httpServer.closeAllConnections?.();
    }

    if (failed) {
      console.error("Graceful shutdown completed with cleanup failures; exiting non-zero");
      process.exit(1);
    }
    console.log("HTTP server closed");
    process.exit(0);
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
