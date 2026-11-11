import express from "express";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { apiKeyRequired, authCorsHeaders, authMode, createAuthMiddleware, oauthEnabled } from "./src/auth.js";
import { registerObsidianCapabilities, TOOL_NAMES } from "./src/capabilities.js";
import { createDiscoveryRuntimePolicy, loadDiscoveryOperatorConfig } from "./src/discovery-runtime.js";
import { headerValue, jsonRpcError } from "./src/http.js";
import { AUTHZ_ENABLED, CORS_ORIGIN, HOST, JSON_LIMIT, MCP_PATH, MCP_SERVER_NAME, MCP_SERVER_VERSION, OAUTH_ENABLED, PORT, PROTECT_HEALTH, PUBLIC_BASE_URL, TLS_CERT_FILE, TLS_KEY_FILE, TLS_PORT, TRUST_PROXY } from "./src/server-config.js";
import { createTlsListener } from "./src/tls-listener.js";
import { createMcpSessionRegistry } from "./src/mcp-sessions.js";
import { getVaultHealth, primaryRuntime } from "./src/vault.js";
import { createVaultCompositionRoot } from "./src/vault-runtime/vault-composition-root.js";
import { AGENT_INSTRUCTIONS } from "./src/agent-bootstrap.js";
import { createOAuthService, DEFAULT_VAULT_ID, OAUTH_SCOPES } from "./src/oauth-provider.js";
import { oauthEndpointHardening } from "./src/oauth/hardening.js";
import { createAdminRouter } from "./src/admin/router.js";
import { createAccessPolicyWiring } from "./src/access-policy/server-wiring.js";
import { createWebAppRouter } from "./src/app/routes.js";
import { mountDirectUpload } from "./src/direct-upload.js";
import { createWebSessionStore } from "./src/app/web-session-store.js";
import { teardownLiveEvents } from "./src/app/live-events.js";
import { DATA_PATH, READ_ONLY, VAULT, configuredApiKeyVaults } from "./src/config.js";
import { gitConfigStoreInstance, installGitShadow, primaryGitRuntime } from "./src/git.js";
import { listWebVaults, webVaultRegistry, vaultAdmissionAdmin } from "./src/app/vault-registry.js";
import { loadVaultDiscoveryState, startVaultDiscoverySchedulers, startVaultRuntimeInventory, stopVaultDiscoverySchedulers, vaultDiscoveryHealth } from "./src/app/vault-startup.js";
import { publishVaultResync } from "./src/app/live-events.js";
import { getWebCatalogRuntime } from "./src/app/web-catalog/runtime.js";
import { requireRequestAuthor, withRequestContext } from "./src/request-context.js";
import { publishService } from "./src/publish/service.js";
import { recoverPendingBatches } from "./src/batch-journal.js";
import { deployedVersion, deployTimeFields } from "./src/release-version.js";
import { auditHealth, startupHousekeeping } from "./src/direct-upload-housekeeping.js";
import { AUTHORIZATION_MODES, createAuthorizationRuntime, createLegacyDecisionBackend } from "./src/authorization/runtime.js";
import { createShadowRecorder } from "./src/authorization/shadow.js";
import { createDeploymentDocument } from "./src/authorization/deployment-document.js";
import { createConstraintAdmin } from "./src/authorization/constraint-admin.js";
import { createNodeAuthorizationIo } from "./src/authorization/node-io.js";
import { buildSeedDocument, seedFile, seedRefusalLine, SEED_INPUTS } from "./src/authorization/seed.js";
import { importLegacyAuthorization } from "./src/authorization/legacy-import.js";
import { AUTHORIZATION_CODES } from "./src/authorization/schema.js";
import { currentWebSessionIdentity } from "./src/authorization/adapters/web.js";
import { credentialFacts, installCredentialFacts } from "./src/authorization/credential-facts.js";
import { currentPublicationRecord } from "./src/authorization/adapters/publish.js";
import { ACCESS_POLICY_SCHEMA_VERSION } from "./src/access-policy/schema.js";

const discoveryOperatorConfig = loadDiscoveryOperatorConfig();
if (discoveryOperatorConfig.warning) console.warn(`[discovery] ${discoveryOperatorConfig.warning}`);

await startupHousekeeping({ dataRoot: DATA_PATH });

// Wave D / D0: the per-Vault runtime map, assigned once the composition root has built the
// canonical registry below. `createMcpServer` runs per session, long after module init.
let vaultScopeDeps;

function createMcpServer() {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  }, { instructions: AGENT_INSTRUCTIONS });

  const discovery = createDiscoveryRuntimePolicy(server, discoveryOperatorConfig, { authDisabled: authMode === "none" });
  registerObsidianCapabilities(discovery, { accessRuntime: accessPolicy.runtime, authorization: authorizationRuntime, vaultScope: vaultScopeDeps, authorizationShadow: authorizationShadowObserver });
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

// P2 (design §10): every real MCP boundary computes the new verdict beside the old
// one and records bounded metadata. Nothing here decides: the old gates above keep
// the execution authority, and `authorizationRuntime.shadow.compare()` returns
// nothing. The candidate document lives in process memory only — it is built from
// the frozen legacy state at startup and rebuilt when that state's revision moves,
// so "file missing = broken" still only applies after the P4 switch.
const authorizationShadow = createShadowRecorder({ capacity: 512 });

/** The one deployment mode. P4 flips it to `enforce` once, inside its maintenance window. */
function configuredAuthorizationMode() {
  const value = process.env.AUTHORIZATION_MODE ?? "legacy";
  if (!AUTHORIZATION_MODES.includes(value)) throw new Error(`AUTHORIZATION_MODE must be one of ${AUTHORIZATION_MODES.join(", ")}`);
  return value;
}
let authorizationIdentity = Object.freeze({ subjects: Object.freeze({}), sessions: Object.freeze({}) });
// P4 / Task 23: the frozen ceiling of every imported credential, keyed by its token id.
let authorizationEnvelopes = Object.freeze({});
function legacyIdentityProjection(document, providerData) {
  const subjects = {};
  for (const [subjectId, record] of Object.entries(document.subjects)) {
    const disabled = subjectId.startsWith("oauth-user:")
      ? Boolean(providerData?.oauthUsers?.[subjectId.slice("oauth-user:".length)]?.disabledAt)
      : false;
    subjects[subjectId] = { credentialEpoch: record.credentialEpoch, disabled };
  }
  return Object.freeze({ subjects: Object.freeze(subjects), sessions: Object.freeze({}) });
}
// Admitted Vaults as the registry serves them now: a grant never admits a Vault, and
// an unreadable inventory denies instead of admitting everything.
function authorizationVaultAdmissions() {
  const admissions = { [DEFAULT_VAULT_ID]: { admitted: true, readOnly: Boolean(READ_ONLY) } };
  try {
    for (const vault of webVaultRegistry.list()) admissions[vault.id] ??= { admitted: true, readOnly: vault.writable === false };
  } catch {
    return {};
  }
  return admissions;
}
// The live legacy import is the ceiling source (§6.8): the credential envelopes and the
// derived subjects come from live credential state, so a new API key or OAuth account works
// the moment it exists, and no credential route learns to write the document file.
let liveDocument = null;
let liveStamp = null;
// With no provider at all (OAUTH_ENABLED=false) there are provably no accounts, keys, tokens or
// clients to import, so the seed carries the environment key and the migrated windows instead
// of refusing a state that cannot exist. A provider that exists but holds no loaded state is an
// unknown, and the importer refuses it by code (§11 C5): never a silent empty subject set.
const NO_PROVIDER_STATE = Object.freeze({ clients: {}, apiKeys: {}, accessTokens: {}, refreshTokens: {}, oauthUsers: {}, oauthUsersInitialized: true });

/** The frozen legacy credential state: the one input the seed and the derived subjects share. */
function legacyCredentialInputs() {
  const data = oauthService === null ? NO_PROVIDER_STATE : oauthService.provider.data ?? null;
  if (data === null) return null;
  return {
    providerSnapshot: data,
    // The recorded legacy switch value, never a new default (§8).
    timeConstraintsEnabled: Boolean(AUTHZ_ENABLED),
    environmentKey: { configured: apiKeyRequired, vaults: [...new Set([DEFAULT_VAULT_ID, ...(configuredApiKeyVaults() ?? [])])] },
  };
}
// §7 step 2: `constraints` come from the legacy policy document and from nothing else. A broken or
// unreadable policy store is never "no constraints": with `timeConstraintsEnabled` on, nothing
// subtracts, so the document would allow where legacy fails closed (§1, A-11). It refuses the seed
// with the store's own code. `null` means the feature is off (`AUTHZ_ENABLED=false`), not broken.
function legacyPolicyDocument() {
  if (accessPolicy.store === null) return null;
  const policy = accessPolicy.store.snapshot();
  if (policy.status !== "ready") {
    throw Object.assign(new Error("the legacy policy document cannot be read"), {
      code: policy.errorCode ?? AUTHORIZATION_CODES.STATE_UNAVAILABLE,
      input: SEED_INPUTS.POLICY_DOCUMENT,
    });
  }
  return { schemaVersion: ACCESS_POLICY_SCHEMA_VERSION, revision: policy.revision, policies: policy.policies };
}
// The derived subjects and the sealed envelopes read credentials only, never the policy document: a
// broken legacy policy file must not turn every credential into a denial.
function readLiveDocument() {
  const inputs = legacyCredentialInputs();
  if (inputs === null) return null;
  const data = inputs.providerSnapshot;
  // One stamp for the frozen legacy state: the policy revision and the credential counts.
  // A new or deleted credential therefore re-imports instead of showing up as
  // your-unknown-subject noise.
  // shortcut: two credentials replaced in the same instant do not re-import, and P4
  // freezes issuance inside the migration window.
  const policy = accessPolicy.store?.snapshot?.() ?? null;
  const revision = policy !== null && Number.isSafeInteger(policy.revision) ? policy.revision : 0;
  const keys = Object.keys(data.apiKeys).length;
  const users = Object.keys(data.oauthUsers).length;
  // Tokens too: a credential's frozen envelope is built from that snapshot, so a token
  // issued after the last import must re-import it instead of reading as "no ceiling"
  // (design §5.2 fails closed on a missing required envelope).
  const tokens = Object.keys(data.accessTokens).length + Object.keys(data.refreshTokens).length;
  const stamp = revision * 1_000_000_000 + Math.min(keys, 999) * 1_000_000 + Math.min(users, 999) * 1_000 + Math.min(tokens, 999);
  if (liveDocument !== null && stamp === liveStamp) return liveDocument;
  const imported = importLegacyAuthorization(inputs);
  authorizationIdentity = legacyIdentityProjection(imported.document, data);
  authorizationEnvelopes = imported.credentialEnvelopes;
  liveDocument = imported.document;
  liveStamp = stamp;
  return liveDocument;
}
// Task 1 (design §6.8, §7 step 1): the new model reads one durable document under the data
// directory instead of an in-memory candidate rebuilt from legacy state, so a later Admin
// edit cannot be erased by a rebuild. The file owns `constraints` and
// `timeConstraintsEnabled`; `subjects` stay derived, and are never written back.
const authorizationFile = path.join(DATA_PATH, "authorization.json");
const authorizationIo = createNodeAuthorizationIo();
const authorizationDocument = createDeploymentDocument({
  file: authorizationFile,
  io: authorizationIo,
  // §7 step 2: with no file the live legacy state is imported exactly once. `seedFile` only
  // decides; the store owns the write. `{}` is not a default — a provider without loaded state
  // makes the importer refuse by code instead of seeding an empty subject set.
  seed: async () => {
    const seeded = await seedFile({
      file: authorizationFile,
      io: authorizationIo,
      // The legacy policy document is a seed-only input: it is read only when there is no
      // document to keep, and a broken one refuses instead of installing no windows at all.
      build: () => buildSeedDocument({ ...(legacyCredentialInputs() ?? {}), policyDocument: legacyPolicyDocument() }),
    });
    // The store had to seed but the file is there: it is unusable, and a seed never replaces one.
    if (!seeded.seeded) {
      throw Object.assign(new Error("the existing authorization document is unusable"), {
        code: AUTHORIZATION_CODES.STATE_UNAVAILABLE,
        input: SEED_INPUTS.DOCUMENT,
      });
    }
    return seeded.document;
  },
  deriveSubjects: () => readLiveDocument()?.subjects ?? {},
  // The legacy state the comparison was based on, for the provenance a shadow row records.
  sourceRevision: () => liveStamp,
});
// §11 C5: a refused seed stops the process before it serves a request — in every mode, because a
// deployment that cannot seed must not answer from an empty document.
await authorizationDocument.ready.catch((error) => {
  writeSync(2, `${seedRefusalLine(error)}\n`);
  process.exit(1);
});
const authorizationStore = authorizationDocument.store;
// §6.9: the audit carries the window before and after, on one line. Days with equal hours collapse
// to a range (`mon-fri 09:00-18:00`); past `limit` day groups or date ranges the text stops and
// appends `+N`, which drops those groups' hours and those ranges. Never a subject, a Vault id or a
// credential: the service's record holds `label`, `enabled` and `schedule` only.
const AUDIT_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function auditWindowText(schedule, limit = 4) {
  if (!schedule) return "";
  const groups = [];
  for (const day of AUDIT_WEEK) {
    const hours = (schedule.weekly?.[day] ?? []).map(([from, to]) => `${from}-${to}`).join("/");
    if (!hours) continue;
    const last = groups.at(-1);
    if (last && last.hours === hours && AUDIT_WEEK.indexOf(day) === AUDIT_WEEK.indexOf(last.to) + 1) last.to = day;
    else groups.push({ from: day, to: day, hours });
  }
  const clip = (items) => (items.length > limit ? [...items.slice(0, limit), `+${items.length - limit}`] : items);
  const days = clip(groups.map((group) => `${group.from === group.to ? group.from : `${group.from}-${group.to}`} ${group.hours}`)).join(", ");
  const dates = clip((schedule.dateRanges ?? []).map((range) => `${range.from}..${range.to}`)).join(",");
  return [
    schedule.timezone,
    days,
    dates,
    schedule.startsAt ? `from ${schedule.startsAt}` : "",
    schedule.expiresAt ? `until ${schedule.expiresAt}` : "",
  ].filter(Boolean).join(" ").trim();
}

// Plan Task 5 follow-up: the five Admin constraint routes were recorded in the manifest and the
// baseline but nothing supplied their service, so a deployed build answered 503. The service is the
// one writer over the durable document above (§6.5). `vaultIds` is a function because a Vault
// admitted after boot must be selectable without a restart, and a Vault that is gone must be
// refused at write instead of stored as a constraint that can never match (§6.3).
//
// The audit record goes to the ring the Admin audit tab already reads (`provider.recordAudit`), the
// same trail `admin.login` and `admin.publish.revoke` write to: no second store, no second reader.
// §6.9 — the window only, never a subject or a credential; the service catches a sink failure, so a
// broken ring cannot fail a write that already reached the disk.
//
// `durabilityUncertain` is passed through, never dropped: the service sets it when the rename landed
// but the directory flush failed, and a trail that looks identical for a certain and an uncertain
// write hides exactly the doubt an operator would need. It is both a field for machine readers and a
// word in `detail`, because the audit page renders `detail` and not unknown keys.
const authorizationAdmin = createConstraintAdmin({
  store: authorizationStore,
  vaultIds: () => Object.entries(authorizationVaultAdmissions())
    .filter(([, entry]) => entry?.admitted === true)
    .map(([id]) => id),
  audit: (record) => {
    if (oauthService === null) return; // no provider, no ring: there is nothing to append to
    const window = (entry) => (entry === null
      ? "—"
      : `${entry.label} (${entry.enabled ? "on" : "off"}) ${auditWindowText(entry.schedule)}`.trim());
    const uncertain = record.durabilityUncertain === true;
    oauthService.provider.recordAudit({
      action: `authz.constraint.${record.action}`,
      outcome: "success",
      credentialType: "admin-session",
      credentialId: record.constraintId ?? null,
      detail: `rev ${record.revision}: ${window(record.before)} → ${window(record.after)}${uncertain ? " (durability uncertain)" : ""}`,
      ...(uncertain ? { durabilityUncertain: true } : {}),
    });
  },
});
const authorizationRuntime = createAuthorizationRuntime({
  store: authorizationStore,
  // The durable subject projection plus, for a Web request, that session's own live
  // entry from the adapter (`{sessions: {credentialId: {active, expiresAt, subjectId}}}`).
  // Without the entry every Web session denies, so the two halves are one capture.
  identitySnapshot: () => {
    const web = currentWebSessionIdentity();
    return web === null ? authorizationIdentity : { ...authorizationIdentity, sessions: web.sessions };
  },
  vaultSnapshot: authorizationVaultAdmissions,
  // A public read carries its own verified record; nothing else can set it.
  publicationSnapshot: () => currentPublicationRecord(),
  deployment: () => ({ readOnly: Boolean(READ_ONLY) }),
  now: () => Date.now(),
  // P3: the boundaries execute this runtime's answer, so the mode decides who answers. It
  // stays `legacy` (the extracted old algorithm through `legacy-evaluate.js`) until the P4
  // maintenance window switches the whole deployment once; the shadow recorder keeps
  // observing beside it.
  mode: configuredAuthorizationMode(),
  legacy: createLegacyDecisionBackend({ accessRuntime: accessPolicy.runtime }),
  shadow: authorizationShadow,
});
await authorizationRuntime.ready;
const authorizationShadowObserver = authorizationRuntime.shadow;
// P4 / Task 23: an adapter cannot read the permission state, so the one place that holds
// the imported state states each credential's frozen ceiling and committed epoch. Without
// this feed a narrow token looks like its account (a false difference) and a committed
// epoch above zero reads as a stale credential.
installCredentialFacts((authInfo) => {
  // The live import fills the envelope map, and the adapter asks before the runtime captures
  // its snapshot. Read the store first, so a token issued since the last import is never
  // read as "this credential tightens nothing".
  authorizationStore.snapshot();
  return credentialFacts({ authInfo, envelopes: authorizationEnvelopes });
});
// Background Git tasks are observed with a `system` actor, in their own unit.
installGitShadow(() => authorizationShadowObserver);

const mcpAuthMiddleware = createAuthMiddleware(oauthService, { accessRuntime: accessPolicy.runtime, authorization: authorizationRuntime, onHardRevoke: closeSessionsForClient, authorizationShadow: authorizationShadowObserver });

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
    authorizationAdmin,
    vaultGitAdmin,
    vaultGitStore,
    authorization: authorizationRuntime,
    authorizationShadow: authorizationShadowObserver,
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
    authorization: authorizationRuntime,
    authorizationShadow: authorizationShadowObserver,
    // The rename and delete routes write through the selected Vault's runtime (Task 4).
    resolveVaultRuntime: (id) => vaultScopeDeps?.resolveVaultRuntime(id) ?? null,
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
mountDirectUpload(app, { auth: mcpAuthMiddleware, accessRuntime: accessPolicy.runtime, authorization: authorizationRuntime, resolveRuntime: (id) => vaultScopeDeps?.resolveVaultRuntime(id) ?? null, provider: oauthService?.provider ?? null, writable: !READ_ONLY, authorizationShadow: authorizationShadowObserver });

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
    authorizationShadow: authorizationRuntime.summary().shadow,
    sessions: sessions.size,
    sessionRecovery: sessionRecovery.stats(),
  });
});

// The public health surface reports the shadow counts only: which boundaries were
// covered is usage information and stays on an authenticated surface.
function authorizationShadowCounts() {
  const { coveredBoundaryKeys, ...counts } = authorizationRuntime.summary().shadow;
  return counts;
}

// The authorization report an operator reads before and after a mode change: which model
// answers, which document revision it reads, and how many constraints that document holds.
// Never a subject, a Vault id, a window or a label: `/healthz` is public, and those are
// Admin facts (design §7). Test: `test/healthz-authorization.test.js`.
function authorizationReport() {
  const stored = authorizationStore.snapshot();
  return {
    mode: authorizationRuntime.snapshot().mode,
    revision: typeof stored.revision === "number" ? stored.revision : null,
    constraints: stored.status === "ready" ? stored.document.constraints.length : 0,
  };
}

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
    authorization: authorizationReport(),
    authorizationWindows: accessPolicy.summary(),
    authorizationShadow: authorizationShadowCounts(),
    sessions: sessions.size,
    sessionRecovery: sessionRecovery.stats(),
    ...vaultDiscoveryHealth(),
    audit: auditHealth(),
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
// The edge proxy terminates the browser's TLS and reaches this process over a second, private hop;
// that hop is encrypted here (docs/RELEASE_AND_DEPLOY.md -> "Encrypted upstream hop"). The plaintext
// listener stays for local health checks, in-container probes and rollback.
const appServers = [httpServer];
const tlsServer = createTlsListener(app, { certFile: TLS_CERT_FILE, keyFile: TLS_KEY_FILE });
if (tlsServer) {
  tlsServer.listen(TLS_PORT, HOST, () => {
    console.log(`Obsidian MCP server also listening on https://${HOST}:${TLS_PORT}${MCP_PATH}`);
  });
  appServers.push(tlsServer);
}

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
    const httpClosed = Promise.all(appServers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    for (const server of appServers) server.closeIdleConnections?.();
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
    for (const server of appServers) server.closeIdleConnections?.();

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
      for (const server of appServers) server.closeAllConnections?.();
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
