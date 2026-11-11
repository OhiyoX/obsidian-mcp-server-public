// P0 / Task 1 — the real-stack permission plane.
//
// `createPermissionPlane()` boots the same pieces `server.js` boots: the real OAuth provider, the
// real auth middleware, the real Vault composition root with its admission gate, the real MCP
// server with its canonical registrars AND the temporal access-policy runtime, a real HTTP `/mcp`
// endpoint that mirrors `server.js` (session ownership, stale-session recovery), the real Web app
// router, the real direct-upload data plane and the real Admin router.
//
// Two things are instrumented *from the test side only*:
//   * every tool/resource handler is counted at the seam closest to the handler itself, so
//     `handlerCalls` is a measurement, not a copy of the verdict;
//   * every Express route handler is counted the same way.
// Nothing under `src/` is patched.
//
// The caller MUST assign the environment before importing this module: `src/config.js` resolves
// its paths at module evaluation.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { comparePermissionRows } from "./permission-baseline-harness.js";

export { comparePermissionRows };

/** One MCP JSON-RPC message. */
export function toolCall(name, args, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** One MCP resource read. */
export function resourceRead(uri, id = 1) {
  return { jsonrpc: "2.0", id, method: "resources/read", params: { uri } };
}

function initializeBody(id = 0) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "permission-baseline", version: "1" } },
  };
}

// ---------------------------------------------------------------------------------------------
// The design's stable refusal families (§11.1: "stable error family", never page text).
// ---------------------------------------------------------------------------------------------

export const REFUSAL_FAMILIES = Object.freeze([
  "unauthenticated",
  "insufficient_scope",
  "vault_access_denied",
  "csrf",
  "validation",
  "outside_authorized_window",
  "operation",
  "transport",
]);

const FAMILY_BY_CODE = new Map(Object.entries({
  invalid_token: "unauthenticated",
  missing_credentials: "unauthenticated",
  insufficient_scope: "insufficient_scope",
  access_denied: "vault_access_denied",
  vault_access_denied: "vault_access_denied",
  vault_unavailable: "vault_access_denied",
  vault_id_invalid: "vault_access_denied",
  csrf: "csrf",
  outside_authorized_window: "outside_authorized_window",
  authorization_policy_unavailable: "transport",
  unsupported_media_type: "validation",
  length_required: "validation",
  payload_too_large: "validation",
  upload_offset_conflict: "validation",
  upload_range_exceeded: "validation",
  upload_integrity_mismatch: "validation",
  upload_too_large: "validation",
  validation: "validation",
  tool_error: "operation",
  internal: "operation",
}));

/** Fold whatever a plane said into one of the eight families. `null` means "allowed". */
export function refusalFamily({ code, text = "", status = 0 } = {}) {
  if (code && FAMILY_BY_CODE.has(code)) return FAMILY_BY_CODE.get(code);
  if (/csrf/i.test(text)) return "csrf";
  if (/invalid_token|missing or invalid api key|missing credentials|unauthorized|session belongs to a different/i.test(text)) return "unauthenticated";
  if (/insufficient_scope|does not have (write|file|read) permission|missing scope/i.test(text)) return "insufficient_scope";
  if (/vault access denied|vault_access_denied|vault_unavailable|vault_id_invalid/i.test(text)) return "vault_access_denied";
  if (/outside_authorized_window|outside the authorized time window|outside_authorized/i.test(text)) return "outside_authorized_window";
  if (/input validation error|invalid arguments?|invalid request body|unsupported publish action|invalid path|revision conflict|precondition|not allowed|too large/i.test(text)) return "validation";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "vault_access_denied";
  if (status === 400 || status === 409 || status === 413 || status === 416 || status === 422 || status === 428) return "validation";
  if (status === 429) return "transport";
  if (status === 404) return "transport";
  if (status >= 500) return "operation";
  return "operation";
}

// ---------------------------------------------------------------------------------------------
// Case counters — the only source of `handlerCalls`.
// ---------------------------------------------------------------------------------------------

function createCaseCounters() {
  const counters = {
    toolHandlers: 0,
    resourceHandlers: 0,
    routeHandlers: 0,
    byRoute: new Map(),
    registeredTools: new Set(),
    reset() {
      this.toolHandlers = 0;
      this.resourceHandlers = 0;
      this.routeHandlers = 0;
      this.byRoute.clear();
    },
    get handlerCalls() {
      return this.toolHandlers + this.resourceHandlers + this.routeHandlers;
    },
    summary() {
      return { toolHandlers: this.toolHandlers, resourceHandlers: this.resourceHandlers, routeHandlers: this.routeHandlers, byRoute: Object.fromEntries(this.byRoute) };
    },
  };
  return counters;
}

/**
 * Wrap a registrar so the handler it registers is counted at the seam closest to the handler: the
 * counter runs only after every registrar has already decided to proceed.
 */
function countingRegistrar(target, counters) {
  const proxy = {
    server: target.server,
    getClientVersion: () => target.getClientVersion?.(),
    registerTool(name, config, handler) {
      counters.registeredTools.add(name);
      return target.registerTool(name, config, (...args) => {
        counters.toolHandlers += 1;
        return handler(...args);
      });
    },
    registerResource(...args) {
      const handler = args[args.length - 1];
      return target.registerResource(...args.slice(0, -1), (...rest) => {
        counters.resourceHandlers += 1;
        return handler(...rest);
      });
    },
    registerPrompt: (...args) => target.registerPrompt(...args),
  };
  for (const key of Object.keys(target)) {
    if (key in proxy) continue;
    proxy[key] = typeof target[key] === "function" ? target[key].bind(target) : target[key];
  }
  return proxy;
}

const COUNTED = Symbol("permissionPlane.handlerCounted");

/** Replace every route's terminal handler with a counting wrapper (test-side only). */
function instrumentRouter(router, counters, prefix = "") {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    // Only the terminal handler counts. The earlier entries are middleware (body parser, session,
    // CSRF, write gate) — counting them would report a "handler call" for a request CSRF refused.
    const entry = layer.route.stack[layer.route.stack.length - 1];
    if (!entry || typeof entry.handle !== "function") continue;
    const handler = entry.handle;
    entry.handle = function counted(req, res, next) {
      // One count per request: several routes can match one path and pass the request on with
      // `next()`, and "a handler answered this request" is a yes/no, not a route tally.
      if (!req[COUNTED]) {
        req[COUNTED] = true;
        counters.routeHandlers += 1;
        for (const path0 of paths) {
          const key = `${prefix}${String(entry.method).toUpperCase()} ${path0}`;
          counters.byRoute.set(key, (counters.byRoute.get(key) ?? 0) + 1);
        }
      }
      return handler(req, res, next);
    };
  }
}

/**
 * Fingerprint of every file under `root`, so a write can be told from a read even when the file
 * keeps its size and lands inside one mtime tick (a re-written note is exactly that case).
 */
async function treeSnapshot(root) {
  const seen = new Map();
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // `.obsidian` / `.git` and other tool-state folders are not Vault content: a permission
      // answer must not depend on the server's own bookkeeping there.
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A created folder is content too: count it, so "made a directory" is never a silent allow.
        seen.set(full, "dir");
        await walk(full);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(full).catch(() => null);
        if (bytes) seen.set(full, `${bytes.length}:${createHash("sha1").update(bytes).digest("hex")}`);
      }
    }
  }
  await walk(root);
  return seen;
}

function treeDelta(before, after) {
  let changed = 0;
  for (const [file, stamp] of after) if (before.get(file) !== stamp) changed += 1;
  for (const file of before.keys()) if (!after.has(file)) changed += 1;
  return changed;
}

function cookieFrom(response, name) {
  const header = response.headers.getSetCookie?.() ?? [];
  const found = header.find((value) => value.startsWith(`${name}=`));
  return found ? found.split(";", 1)[0] : null;
}

/**
 * Boot the plane. The caller sets `WEB_VAULTS_ROOT`, `VAULT_PATH`, `DATA_PATH`, `API_KEY`,
 * `PUBLIC_BASE_URL` and the OAuth seed variables before it imports this module.
 *
 * `authzEnabled: true` opens the real temporal access-policy store and mounts the Admin permission
 * editor, exactly as `AUTHZ_ENABLED=true` does in `server.js`, and hands the runtime to the
 * capability registrars like `server.js:52` does.
 *
 * `policyNow` (epoch ms) pins the policy clock. A window boundary is a millisecond question, so
 * without a pinned instant a `startsAt`/`expiresAt` row would record a race instead of a decision.
 * `server.js` keeps the real clock; `permission-baseline-parity.test.js` proves both answer the
 * same request the same way.
 */
export async function createPermissionPlane({ envKey, primaryVault, authzEnabled = false, dataPath = process.env.DATA_PATH, policyNow = null }) {
  const [
    { createOAuthService, OAUTH_SCOPES },
    { createAuthMiddleware },
    { primaryRuntime },
    { webVaultRegistry, listWebVaults, vaultAdmissionAdmin },
    { createVaultCompositionRoot },
    { createDiscoveryRuntimePolicy },
    { createMcpSessionRegistry },
    { createAccessPolicyWiring },
    { createWebAppRouter },
    { createAdminRouter },
    { mountDirectUpload },
    { createWebSessionStore },
    { publishService },
    { startVaultRuntimeInventory },
    { createAccessPolicyRegistrar },
    { createVaultScopeRegistrar },
    { createMemoryGuidanceRegistrar },
    toolsInfo,
    toolsNotes,
    toolsSearch,
    toolsFiles,
    toolsLinks,
    toolsWorkflows,
    toolsGit,
    toolsIntelligence,
    toolsContext,
    toolsPublish,
    toolsPlans,
    { registerResources },
    { registerPrompts },
    { TOOL_NAMES },
    { MCP_SESSION_RECOVERY },
    { headerValue, jsonRpcError },
    { mcpAuthRouter },
    { withRequestContext },
    { createAuthorizationStore },
    { serializeAuthorizationDocument },
    { AUTHORIZATION_CATALOG_VERSION },
    { createNodeAuthorizationIo },
    { createConstraintAdmin },
  ] = await Promise.all([
    import("../../src/oauth-provider.js"),
    import("../../src/auth.js"),
    import("../../src/vault.js"),
    import("../../src/app/vault-registry.js"),
    import("../../src/vault-runtime/vault-composition-root.js"),
    import("../../src/discovery-runtime.js"),
    import("../../src/mcp-sessions.js"),
    import("../../src/access-policy/server-wiring.js"),
    import("../../src/app/routes.js"),
    import("../../src/admin/router.js"),
    import("../../src/direct-upload.js"),
    import("../../src/app/web-session-store.js"),
    import("../../src/publish/service.js"),
    import("../../src/app/vault-startup.js"),
    import("../../src/access-policy/registrar.js"),
    import("../../src/vault-scope-registrar.js"),
    import("../../src/memory-guidance.js"),
    import("../../src/tools/info.js"),
    import("../../src/tools/notes.js"),
    import("../../src/tools/search.js"),
    import("../../src/tools/files.js"),
    import("../../src/tools/links.js"),
    import("../../src/tools/workflows.js"),
    import("../../src/tools/git.js"),
    import("../../src/tools/intelligence.js"),
    import("../../src/tools/context.js"),
    import("../../src/tools/publish.js"),
    import("../../src/tools/plans.js"),
    import("../../src/resources.js"),
    import("../../src/prompts.js"),
    import("../../src/config.js"),
    import("../../src/server-config.js"),
    import("../../src/http.js"),
    import("@modelcontextprotocol/sdk/server/auth/router.js"),
    import("../../src/request-context.js"),
    import("../../src/authorization/store.js"),
    import("../../src/authorization/schema.js"),
    import("../../src/authorization/catalog.js"),
    import("../../src/authorization/node-io.js"),
    import("../../src/authorization/constraint-admin.js"),
  ]);

  const oauthService = createOAuthService();
  const provider = oauthService.provider;
  await provider.ready;

  const accessPolicy = createAccessPolicyWiring({ enabled: authzEnabled, dataPath, oauthService });
  await accessPolicy.ready;
  if (policyNow !== null) {
    // The runtime reads its clock through this member. A rename must fail loudly, not silently make
    // every pinned boundary row depend on the harness wall clock again.
    if (typeof accessPolicy.runtime?.clock !== "function") {
      throw new Error("the access-policy runtime no longer exposes its clock: the pinned time rows need it");
    }
    accessPolicy.runtime.clock = () => policyNow;
  }

  // The per-Vault constraint writes (plan Task 5) live on the Admin router. The plane gives them a
  // real store over its own data root, so their boundary rows record an accepted write instead of
  // an "unavailable" service. Nothing else in the plane reads this document: the runtime still
  // answers from the legacy store above, exactly as `server.js` does in `legacy` mode.
  await fs.mkdir(dataPath, { recursive: true });
  const authorizationFile = path.join(dataPath, "authorization.json");
  await fs.writeFile(authorizationFile, serializeAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 1,
    timeConstraintsEnabled: true,
    subjects: {},
    constraints: [],
  }));
  const authorizationStore = createAuthorizationStore({ file: authorizationFile, io: createNodeAuthorizationIo() });
  await authorizationStore.ready;
  const authorizationAdmin = createConstraintAdmin({ store: authorizationStore, vaultIds: ["vault", "alpha"] });

  const composition = createVaultCompositionRoot({
    registry: webVaultRegistry,
    primaryRuntime,
    primaryRoot: primaryVault,
    dataRoot: dataPath,
    writable: true,
    admission: vaultAdmissionAdmin,
  });

  // `server.js` loads one runtime per inventory Vault at startup; without this the vault-scope
  // registrar answers `vault_unavailable` for every secondary Vault and the baseline would record a
  // startup gap instead of the shipped behaviour.
  await startVaultRuntimeInventory({ runtimeMap: composition.vaultRuntimeMap, logger: console });

  const counters = createCaseCounters();

  /**
   * The same registration chain `registerObsidianCapabilities` builds, with the counting seam
   * inserted at the innermost point (between the memory-guidance registrar and the tool handler),
   * which is the only position where the count means "the real handler ran".
   */
  function createServer() {
    const server = new McpServer({ name: "permission-baseline", version: "0.0.0" }, { instructions: "" });
    const discovery = createDiscoveryRuntimePolicy(server, undefined, { authDisabled: false });
    let chain = discovery;
    if (accessPolicy.runtime) chain = createAccessPolicyRegistrar(chain, { runtime: accessPolicy.runtime });
    chain = createVaultScopeRegistrar(chain, composition.vaultScopeDeps);
    chain = createMemoryGuidanceRegistrar(chain);
    const counted = countingRegistrar(chain, counters);
    toolsInfo.registerInfoTools(counted);
    toolsNotes.registerNoteTools(counted);
    toolsSearch.registerSearchTools(counted);
    toolsFiles.registerFileTools(counted);
    toolsLinks.registerLinkTools(counted);
    toolsWorkflows.registerWorkflowTools(counted);
    toolsGit.registerGitTools(counted);
    toolsIntelligence.registerIntelligenceTools(counted);
    toolsContext.registerContextTools(counted);
    toolsPublish.registerPublishTools(counted);
    toolsPlans.registerPlanTools(counted);
    registerResources(counted);
    registerPrompts(counted);
    discovery.install();
    return server;
  }

  const authMiddleware = createAuthMiddleware(oauthService, { accessRuntime: accessPolicy.runtime, onHardRevoke: async () => {} });
  const registry = createMcpSessionRegistry({ createServer });
  const { sessions, sessionRecovery, createSessionTransport, sessionBelongsToAuth } = registry;

  const app = express();
  // `server.js` mounts the SDK auth router at `/oauth`, keeps the four former root paths as
  // protocol compatibility routes, and serves the approval form itself. Without these the plane
  // could not record the consent and token boundaries at all.
  const oauthRouterOptions = {
    provider,
    issuerUrl: oauthService.issuer,
    resourceServerUrl: oauthService.resource,
    scopesSupported: OAUTH_SCOPES,
    resourceName: "Obsidian Vault MCP",
  };
  const canonicalOAuthRouter = mcpAuthRouter(oauthRouterOptions);
  app.use("/oauth", (req, res, next) => withRequestContext({ oauthOrigin: oauthService.resolveOrigin(req) }, () => canonicalOAuthRouter(req, res, next)));
  const compatibilityOAuthPaths = new Set(["/authorize", "/token", "/register", "/revoke"]);
  const compatibilityOAuthRouter = mcpAuthRouter(oauthRouterOptions);
  app.use((req, res, next) => compatibilityOAuthPaths.has(req.path)
    ? withRequestContext({ oauthOrigin: oauthService.resolveOrigin(req) }, () => compatibilityOAuthRouter(req, res, next))
    : next());
  app.post(oauthService.approvalPath, express.urlencoded({ extended: false, limit: "32kb" }), async (req, res) => {
    try {
      await provider.handleApproval(req, res);
    } catch (error) {
      if (!res.headersSent) res.status(403).send("Authorization denied. Return to the MCP client and try again.");
    }
  });
  // The SDK auth router answers from its own handler chain, which is not a plain route layer, so the
  // router entry itself is the counted seam for these boundaries.
  for (const oauthRouter of [canonicalOAuthRouter, compatibilityOAuthRouter]) {
    const originalHandle = oauthRouter.handle;
    oauthRouter.handle = function countedOAuthRouter(req, res, next) {
      counters.routeHandlers += 1;
      return originalHandle.call(this, req, res, next);
    };
  }
  app.get("/admin", (_req, res) => res.redirect(302, "/admin/auth"));
  const adminRouter = createAdminRouter({
    provider,
    adminPassword: provider.adminPassword,
    secureCookie: false,
    configuredApiKeyEnabled: Boolean(envKey),
    listVaults: listWebVaults,
    publishService,
    accessPolicyAdmin: accessPolicy.admin,
    authorizationAdmin,
    vaultGitAdmin: composition.vaultGitAdmin,
    vaultGitStore: composition.vaultGitStore,
  });
  app.use("/admin/auth", adminRouter);
  const webRouter = createWebAppRouter({
    provider,
    secureCookie: false,
    publishService,
    webSessionStore: createWebSessionStore({ file: null }),
    accessRuntime: accessPolicy.runtime,
    // Same wiring `server.js` passes: the rename and delete routes write through the
    // selected Vault's runtime, so their baseline rows are real writes.
    resolveVaultRuntime: (id) => composition.vaultScopeDeps.resolveVaultRuntime(id) ?? null,
  });
  app.use(webRouter);
  const directUploads = mountDirectUpload(app, {
    auth: authMiddleware,
    accessRuntime: accessPolicy.runtime,
    resolveRuntime: composition.vaultScopeDeps.resolveVaultRuntime,
    provider,
    writable: true,
  });
  // `PUT`/`PATCH` are registered on the mounted router; instrument the router it built.
  instrumentRouter(directUploads, counters);
  instrumentRouter(webRouter, counters);
  instrumentRouter(adminRouter, counters, "ADMIN ");

  // Mirrors `server.js` §MCP POST: session ownership, stale-session recovery, then the transport.
  app.post("/mcp", express.json({ limit: "8mb", type: ["application/json", "application/*+json"] }), authMiddleware, async (req, res) => {
    const sessionId = headerValue(req, "mcp-session-id");
    const isInitialize = (body) => Boolean(body) && !Array.isArray(body) && body.method === "initialize";
    try {
      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record) {
          if (sessionRecovery.enabled && isInitialize(req.body)) {
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
      if (!isInitialize(req.body)) {
        jsonRpcError(res, 400, -32000, "Bad Request: initialize first or provide mcp-session-id");
        return;
      }
      const record = await createSessionTransport(req.auth);
      await record.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP POST:", error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** One plain HTTP request against the plane (Web routes, uploads, Admin). */
  async function httpRequest({ method = "GET", urlPath, headers = {}, body } = {}) {
    const response = await fetch(`${base}${urlPath}`, { method, redirect: "manual", headers, body });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers, setCookie: response.headers.getSetCookie?.() ?? [] };
  }

  const sessionsByActor = new Map();
  /** The real session id this principal opened (created on first use). */
  async function sessionIdFor(actor) {
    const session = await sessionFor(actor);
    return session.sessionId;
  }
  function sessionIdOf(actor) {
    return sessionsByActor.get(actor.id)?.sessionId ?? null;
  }
  async function sessionFor(actor) {
    if (sessionsByActor.has(actor.id)) return sessionsByActor.get(actor.id);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...actor.headers(envKey) },
      body: JSON.stringify(initializeBody()),
    });
    const sessionId = response.headers.get("mcp-session-id");
    await response.text().catch(() => "");
    const opened = { sessionId };
    sessionsByActor.set(actor.id, opened);
    return opened;
  }

  /** One JSON-RPC POST, optionally reusing a caller-supplied `mcp-session-id`. */
  async function call(actor, body, { sessionId } = {}) {
    const session = sessionId !== undefined ? { sessionId } : await sessionFor(actor);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session.sessionId ? { "mcp-session-id": session.sessionId } : {}),
        ...actor.headers(envKey),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  /** Sign in through the real Web login route and read the CSRF token the real page carries. */
  async function webLogin({ username, password }) {
    const login = await httpRequest({
      method: "POST",
      urlPath: "/auth/login",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, next: "/app/" }).toString(),
    });
    const cookie = cookieFrom(login, "obsidian_web_session");
    if (!cookie) return { cookie: null, csrf: null, loginStatus: login.status };
    const page = await httpRequest({ urlPath: "/app", headers: { Cookie: cookie } });
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? null;
    return { cookie, csrf, loginStatus: login.status };
  }

  /** Sign in to the real Admin surface and take the CSRF token its own forms carry. */
  async function adminLogin({ password }) {
    const login = await httpRequest({
      method: "POST",
      urlPath: "/admin/auth/login",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password }).toString(),
    });
    const cookie = cookieFrom(login, "obsidian_mcp_admin");
    if (!cookie) return { cookie: null, csrf: null, loginStatus: login.status };
    const page = await httpRequest({ urlPath: "/admin/auth", headers: { Cookie: cookie } });
    const csrf = page.text.match(/name="csrf" value="([^"]+)"/)?.[1] ?? null;
    return { cookie, csrf, loginStatus: login.status };
  }

  return {
    provider,
    oauthService,
    accessPolicy,
    authorizationAdmin,
    composition,
    directUploads,
    base,
    counters,
    toolNames: TOOL_NAMES,
    sessionRecoveryEnabled: Boolean(MCP_SESSION_RECOVERY) && sessionRecovery.enabled !== false,
    close: () => new Promise((resolve) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    call,
    sessionIdFor,
    sessionIdOf,
    httpRequest,
    webLogin,
    adminLogin,
    treeSnapshot,
    treeDelta,
  };
}

/**
 * Run one case: a real request through the real plane, plus the content effect on the Vault.
 * A refusal must leave the Vault byte-identical; that invariant is what catches a gate that
 * became a pass-through. `handlerCalls` counts real handler entries, never the verdict.
 */
export async function observeCase(plane, { actor, request, vaultRoot, targetCase, sessionId }) {
  const before = await plane.treeSnapshot(vaultRoot);
  plane.counters.reset();
  const { status, text } = await plane.call(actor, request, { sessionId });
  const handlerCalls = plane.counters.handlerCalls;
  const after = await plane.treeSnapshot(vaultRoot);
  const changedFiles = plane.treeDelta(before, after);

  let parsed = null;
  // The transport answers as SSE (`data: {...}`) or as plain JSON, depending on the request.
  const dataLine = text.split("\n").find((line) => line.trim().startsWith("data:"));
  try {
    parsed = JSON.parse(dataLine ? dataLine.trim().slice("data:".length).trim() : text);
  } catch {
    parsed = null;
  }
  const result = parsed?.result;
  const transportError = parsed?.error;
  const resultText = (result?.content ?? []).map((part) => part?.text ?? "").join(" ");
  // The SDK rejects a bad argument object before the tool handler runs; that is a `validation`
  // refusal, not a generic tool error, and the row must say so.
  const sdkValidation = /Input validation error|Invalid arguments/i.test(resultText);
  const operationCode = sdkValidation ? "validation" : (result?.structuredContent?.code ?? (result?.isError ? "tool_error" : null));
  const transportCode = transportError?.data?.code ?? (status === 401 ? "invalid_token" : (status >= 400 ? `http_${status}` : null));

  const allowed = status === 200 && Boolean(result) && result.isError !== true;
  const errorFamily = allowed
    ? null
    // The transport message is part of the evidence even when the HTTP body is empty.
    : refusalFamily({ code: operationCode ?? transportCode, text: `${text} ${transportError ? JSON.stringify(transportError) : ""}`, status });
  // Where the refusal landed. A refusal that ran no handler is pre-handler BY DEFINITION: either the
  // HTTP layer refused it, or the MCP operation layer refused it before the handler (temporal gate,
  // SDK argument validation, unknown tool). Only a refusal the handler itself produced is
  // `operation` — that is what makes the leak invariant checkable for every gate row.
  const refusedByTransport = status !== 200 || Boolean(transportError);
  const denialPoint = allowed
    ? "none"
    : (handlerCalls > 0 ? "operation" : (refusedByTransport ? "transport" : "operation_gate"));
  return {
    status,
    sample: text.slice(0, 200),
    payload: text,
    allowed,
    errorFamily,
    denialPoint,
    handlerCalls,
    contentIo: changedFiles,
    targetCase,
  };
}

/**
 * Classify one HTTP answer from the Web, upload or Admin plane by its CONTENT. A 2xx or a redirect
 * is not an allow by itself: an Admin write that fails validation bounces back with `authzError=`,
 * and a JSON refusal carries `error` even with a 200-ish surface.
 */
export function classifyHttpAnswer({ status, text, location = "", urlPath = "", method = "GET" }) {
  const isLoginRoute = /\/login$/.test(urlPath);
  const isLogoutRoute = /\/logout$/.test(urlPath);
  const isHtml = /^\s*</.test(text);
  const bounceToLogin = status >= 300 && status < 400 && /\/login\b/.test(location) && !isLoginRoute && !isLogoutRoute;
  const failureFlag = status >= 300 && status < 400 && /authzError|[?&]error=|&fail(?:ed)?=/i.test(location);

  let payload = null;
  let code = null;
  try {
    payload = JSON.parse(text);
    code = payload?.code ?? payload?.error ?? null;
  } catch {
    payload = null;
  }

  // Every successful Admin write answers with a redirect, except the Vault/Git writes, which answer
  // with the page and put the outcome in the status. A 200 page on the other Admin writes is a
  // confirm step or an inline failure, never an allow.
  const adminWrite = method !== "GET" && urlPath.startsWith("/admin/");
  // Some Admin writes answer with the rendered page instead of a redirect (the Vault/Git routes and
  // the permission-editor preview/repair forms). Their answer is in the CONTENT: the shared result
  // line renders `class="result err"` on a failure and nothing of the kind on success.
  const pageAnswer = adminWrite && isHtml;
  const successRedirect = status >= 300 && status < 400 && !bounceToLogin && !failureFlag;
  const successBody = status >= 200 && status < 300 && !(payload && (payload.error || payload.ok === false));
  const pageFailure = isHtml && /class="result err"/.test(text);
  const allowed = adminWrite
    ? (pageAnswer ? (successBody && !pageFailure) : successRedirect)
    : (successBody || successRedirect);

  if (allowed) return { allowed: true, errorFamily: null, denialPoint: "none", code: null };

  // Page text is never a family: a rendered page contains its own `name="csrf"` field, so matching
  // the body would call every refusal a CSRF failure. Only a JSON answer carries a code.
  let family;
  if (isLoginRoute && (status === 401 || status === 403)) family = "unauthenticated";
  else if (adminWrite && status === 403 && isHtml) family = "csrf";
  else if (adminWrite && ((status >= 200 && status < 300) || failureFlag)) family = "validation";
  else family = refusalFamily({ code: typeof code === "string" ? code : null, text: isHtml ? "" : text, status: bounceToLogin ? 401 : status });

  const gatePoint = family === "csrf"
    ? "csrf"
    : (bounceToLogin || status === 401 ? "transport"
      : (status === 403
        ? (family === "unauthenticated" ? "transport" : "authorization")
        : (status >= 500 ? "operation" : (status === 404 ? "routing" : (status === 429 ? "rate_limit" : "validation")))));
  return { allowed: false, errorFamily: family, denialPoint: gatePoint, code: typeof code === "string" ? code : null };
}

/** Run one case against the Web / upload / Admin plane, with the same invariants as the MCP side. */
export async function observeHttpCase(plane, { request, vaultRoot, targetCase }) {
  const before = await plane.treeSnapshot(vaultRoot);
  plane.counters.reset();
  const response = await plane.httpRequest(request);
  const handlerCalls = plane.counters.handlerCalls;
  const after = await plane.treeSnapshot(vaultRoot);
  const changedFiles = plane.treeDelta(before, after);
  const verdict = classifyHttpAnswer({
    status: response.status,
    text: response.text,
    location: response.headers.get("location") || "",
    urlPath: request.urlPath || "",
    method: request.method || "GET",
  });
  return {
    status: response.status,
    sample: response.text.slice(0, 200),
    response,
    allowed: verdict.allowed,
    errorFamily: verdict.errorFamily,
    denialPoint: verdict.allowed ? "none" : (handlerCalls > 0 ? "operation" : verdict.denialPoint),
    handlerCalls,
    contentIo: changedFiles,
    targetCase,
  };
}
