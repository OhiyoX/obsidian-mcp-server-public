// Shared harness for the P2 Web shadow tests (Tasks 12-14).
//
// A real Web router over real HTTP, the real session store, a programmable legacy
// temporal gate and an injected shadow recorder. Nothing here asserts on its own.
//
// `prepareEnv()` MUST run before the first `startWebApp()` in a test file: the router
// reads its Vault configuration at import time, so the environment is fixed once per
// process. Every later call reuses the already imported modules.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import express from "express";

export const TTL_MS = 3_600_000;
export const DEFAULT_USER = Object.freeze({
  id: "user-1", username: "owner", displayName: "Owner", updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault"],
  defaultVaultId: "vault", disabledAt: null,
});
export const ALLOW = Object.freeze({ allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null, matchedPolicyIds: [] });
export const DENY_SUSPEND = Object.freeze({ allowed: false, mode: "suspend", reason: "outside_window", denyPolicyId: "policy-1", matchedPolicyIds: ["policy-1"] });

let prepared = false;
let modulesPromise = null;

/**
 * Create the scratch tree and fix the router's environment. Returns the paths the
 * test needs. Safe to call once per file; later calls do not re-create the tree.
 */
export async function prepareEnv(root) {
  if (prepared) return { root };
  prepared = true;
  const vaultRoot = path.join(root, "vault");
  const secondaryRoot = path.join(root, "vaults", "secondary");
  await fs.mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  await fs.mkdir(path.join(secondaryRoot, ".obsidian"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  process.env.VAULT_PATH = vaultRoot;
  process.env.VAULTS_ROOT = path.join(root, "vaults");
  process.env.WEB_VAULTS_ROOT = path.join(root, "vaults");
  process.env.WEB_DEFAULT_VAULT = "vault";
  process.env.DATA_PATH = path.join(root, "data");
  process.env.EMBEDDING_PROVIDER = "disabled";
  process.env.GIT_ENABLED = "false";
  return { root, vaultRoot, secondaryRoot };
}

async function modules() {
  modulesPromise ??= Promise.all([
    import("../../src/app/routes.js"),
    import("../../src/app/vault-registry.js"),
    import("../../src/publish/service.js"),
    import("../../src/authorization/runtime.js"),
    import("../../src/authorization/shadow.js"),
    import("../../src/authorization/adapters/web.js"),
    import("../../src/authorization/adapters/publish.js"),
    import("../../src/app/web-session-store.js"),
    import("../../src/authorization/catalog.js"),
  ]).then(([routes, registry, publish, runtime, shadow, web, publishAdapter, sessionStore, catalog]) => ({
    createWebAppRouter: routes.createWebAppRouter,
    defaultWebVaultId: registry.defaultWebVaultId,
    PublishService: publish.PublishService,
    encodeDocumentRoute: publish.encodeDocumentRoute,
    createAuthorizationRuntime: runtime.createAuthorizationRuntime,
    createShadowCandidate: shadow.createShadowCandidate,
    createShadowRecorder: shadow.createShadowRecorder,
    currentWebSessionIdentity: web.currentWebSessionIdentity,
    currentPublicationRecord: publishAdapter.currentPublicationRecord,
    createWebSessionStore: sessionStore.createWebSessionStore,
    WEB_SESSION_COOKIE: sessionStore.WEB_SESSION_COOKIE,
    AUTHORIZATION_CATALOG_VERSION: catalog.AUTHORIZATION_CATALOG_VERSION,
  }));
  return modulesPromise;
}

/** The catalog version, for a caller that builds a candidate document. */
export async function catalogVersion() {
  return (await modules()).AUTHORIZATION_CATALOG_VERSION;
}

/** The published note route for a Vault/note pair. */
export async function documentRoute(vaultId, notePath) {
  return (await modules()).encodeDocumentRoute(vaultId, notePath);
}

/**
 * Start one app. `legacyDecision` is the old temporal gate's answer for every route;
 * `document` is the in-memory shadow candidate. With `shadow: false` the router gets
 * no observer at all, which is the zero-difference control.
 */
export async function startWebApp({
  label = "app", user = DEFAULT_USER, legacyDecision = ALLOW, shadow = true, document = null,
  dataRoot = null, publishFile = null,
} = {}) {
  const mods = await modules();
  const account = { ...user, allowedScopes: [...(user.allowedScopes ?? [])], allowedVaults: [...(user.allowedVaults ?? [])] };
  const audits = [];
  const provider = {
    authenticateOAuthUser: async (username, password) => username === account.username && password === "password" ? account : null,
    oauthUserSessionRecord: async (id) => id === account.id ? account : null,
    updateOAuthUser: async (id, patch) => { Object.assign(account, patch); audits.push({ action: "user.update", detail: id }); return { user: { ...account } }; },
    recordAudit(entry) { audits.push(entry); },
  };
  const legacy = {
    status: "ready",
    calls: { evaluate: [], explain: [], audit: [] },
    evaluate(input) { this.calls.evaluate.push(input); return legacyDecision; },
    explain(input) { this.calls.explain.push(input); return { nextAllowedAt: null }; },
    audit(event) { this.calls.audit.push(event); },
  };
  const store = instrumentedStore(mods.createWebSessionStore);
  const recorder = mods.createShadowRecorder({ capacity: 512 });
  const candidate = document ?? { schemaVersion: 1, catalogVersion: mods.AUTHORIZATION_CATALOG_VERSION, revision: 2, timeConstraintsEnabled: false, subjects: {}, constraints: [] };
  const runtime = mods.createAuthorizationRuntime({
    store: mods.createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: candidate }) }),
    identitySnapshot: () => ({
      subjects: { [`oauth-user:${account.id}`]: { credentialEpoch: 0, disabled: false } },
      sessions: mods.currentWebSessionIdentity()?.sessions ?? {},
    }),
    vaultSnapshot: () => ({ [mods.defaultWebVaultId()]: { admitted: true, readOnly: false }, secondary: { admitted: true, readOnly: false } }),
    // A public read carries its own verified record through the adapter's scope.
    publicationSnapshot: () => mods.currentPublicationRecord(),
    deployment: () => ({ readOnly: false }),
    now: () => Date.now(),
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;

  const app = express();
  app.use(mods.createWebAppRouter({
    provider,
    secureCookie: false,
    publishService: new mods.PublishService({ file: publishFile ?? path.join(dataRoot ?? process.env.DATA_PATH, `${label}-publish.json`) }),
    webSessionStore: store,
    accessRuntime: legacy,
    authorizationShadow: shadow ? runtime.shadow : null,
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base, legacy, user: account, audits, store, recorder, runtime,
    rows: () => recorder.rows(),
    summary: () => recorder.summary(),
    async newSession({ vaultId = mods.defaultWebVaultId() } = {}) {
      const token = randomBytes(32).toString("base64url");
      const csrf = randomBytes(16).toString("base64url");
      const at = Date.now();
      const created = await store.createSession(token, {
        userId: account.id, userUpdatedAt: account.updatedAt, csrf, vaultId,
        createdAt: at, expiresAt: at + TTL_MS, lastSeenAt: at,
      });
      if (!created.ok) throw new Error(`test session not created: ${created.reason}`);
      return { cookie: `${mods.WEB_SESSION_COOKIE}=${token}`, csrf, token };
    },
    async get(pathname, cookie = null) {
      const response = await fetch(`${base}${pathname}`, {
        redirect: "manual",
        headers: cookie ? { Cookie: cookie } : {},
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.text(), headers: response.headers };
    },
    async request(method, pathname, { cookie = null, csrf = null, body, headers = {}, contentType = null } = {}) {
      const outbound = { ...headers };
      if (cookie) outbound.Cookie = cookie;
      if (csrf) outbound["X-CSRF-Token"] = csrf;
      let payload;
      if (body === undefined) payload = undefined;
      else if (Buffer.isBuffer(body) || typeof body === "string") payload = body;
      else {
        payload = JSON.stringify(body);
        outbound["Content-Type"] = contentType ?? "application/json";
      }
      if (contentType && !Buffer.isBuffer(body) && typeof body !== "string") outbound["Content-Type"] = contentType;
      const response = await fetch(`${base}${pathname}`, {
        method,
        redirect: "manual",
        headers: outbound,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.text(), headers: response.headers };
    },
    post(pathname, options) { return this.request("POST", pathname, options); },
    patch(pathname, options) { return this.request("PATCH", pathname, options); },
    async close() {
      await new Promise((resolve) => { server.closeIdleConnections?.(); server.close(() => resolve()); });
    },
  };
}

/** The session store the router uses, with counters for its writes. */
export function instrumentedStore(createWebSessionStore) {
  const store = createWebSessionStore({ file: null });
  const stats = { create: 0, mutate: 0, revoke: 0, delete: 0 };
  return {
    stats,
    now: () => store.now(),
    snapshot: (token) => store.snapshot(token),
    touchIfCurrent: (hash, version, mutation) => store.touchIfCurrent(hash, version, mutation),
    mutateSession: (id, mutation) => { stats.mutate += 1; return store.mutateSession(id, mutation); },
    deleteSession: (token) => { stats.delete += 1; return store.deleteSession(token); },
    revoke: (token) => { stats.revoke += 1; return store.revoke(token); },
    checkpoint: () => store.checkpoint(),
    createSession: (token, record) => { stats.create += 1; return store.createSession(token, record); },
  };
}

/**
 * A candidate document that grants `capabilities` on the primary Vault and the
 * instance list/create pair to one account. Only the capabilities the test needs.
 */
export async function candidateFor(capabilities, { subject = "oauth-user:user-1", vaultId = null } = {}) {
  const { AUTHORIZATION_CATALOG_VERSION, defaultWebVaultId } = await modules();
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 2,
    timeConstraintsEnabled: false,
    subjects: {
      [subject]: {
        credentialEpoch: 0,
        grants: [
          { target: { kind: "vault", vaultId: vaultId ?? defaultWebVaultId() }, capabilities: [...capabilities] },
          { target: { kind: "instance" }, capabilities: ["vault_list_read"] },
        ],
      },
    },
    constraints: [],
  };
}
