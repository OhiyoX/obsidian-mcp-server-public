import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  InvalidRequestError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { DATA_PATH } from "./config.js";
import {
  MCP_PATH,
  AUTH_AUDIT_MAX_ENTRIES,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_ADMIN_PASSWORD,
  OAUTH_INITIAL_PASSWORD,
  OAUTH_INITIAL_USERNAME,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  OAUTH_REFRESH_REUSE_GRACE_SECONDS,
  PUBLIC_BASE_URL,
  PUBLIC_BASE_URLS,
} from "./server-config.js";
import {
  DEFAULT_VAULT_ID, OAUTH_SCOPES, cleanUsername, digest, hashPassword, normalizedScopes,
  normalizedVaults, resolvePublicOrigin, token, validatePassword, validRedirectUri, verifyPassword,
} from "./oauth/primitives.js";
import { persistenceMethods } from "./oauth/persistence-methods.js";
import { protocolMethods } from "./oauth/protocol-methods.js";
import { authorizationTransferMethods, resolveAuthorizationTransferStore } from "./oauth/authorization-transfer-methods.js";
import { requestContext } from "./request-context.js";
import { normalizeDefaultVaultId } from "./default-vault.js";
import { attributeApiKeyLabel } from "./request-attribution.js";
import { LOGIN_LOCK_MAX_FAILURES, LOGIN_LOCK_WINDOW_MS, lockRetryAfterSeconds } from "./login-lockout.js";

export { DEFAULT_VAULT_ID, OAUTH_SCOPES, resolvePublicOrigin } from "./oauth/primitives.js";

class PersistentOAuthProvider {
  constructor(options) {
    this.file = options.file;
    this.adminPassword = options.adminPassword;
    this.canonicalResource = options.canonicalResource;
    this.allowedResources = new Set(
      [...(options.allowedResources || [options.canonicalResource])]
        .map((item) => new URL(item).href),
    );
    this.accessTtlSeconds = options.accessTtlSeconds;
    this.refreshTtlSeconds = options.refreshTtlSeconds;
    this.refreshReuseGraceSeconds = options.refreshReuseGraceSeconds;
    this.auditMaxEntries = options.auditMaxEntries;
    this.approvalPath = options.approvalPath;
    this.initialUsername = options.initialUsername;
    this.initialPassword = options.initialPassword;
    this.accessRuntime = options.accessRuntime ?? null; // AuthZ Wave B / B2 OAuth lifecycle gate (null = inert)
    // #364 durable transfer fence (§4.1) + the verifiable session-close hook (I06 / §17-5).
    this.transferStore = resolveAuthorizationTransferStore(options.transferStore, this.file);
    this.closeSessions = typeof options.closeSessions === "function" ? options.closeSessions : null;
    this.data = { clients: {}, clientUsage: {}, codes: {}, accessTokens: {}, refreshTokens: {}, apiKeys: {}, oauthUsers: {}, oauthUsersInitialized: false, configuredApiKeyUsage: {}, audit: [] };
    this.transactions = new Map();
    this.loginFailures = new Map();
    this.saveQueue = Promise.resolve();
    this.saveTimer = null;
    this.ready = this.load();
    this.clientsStore = {
      getClient: async (clientId) => {
        await this.ready;
        return this.data.clients[clientId];
      },
      registerClient: async (client) => {
        await this.ready;
        if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0 || client.redirect_uris.some((uri) => !validRedirectUri(uri))) {
          throw new InvalidRequestError("redirect_uris must use HTTPS or an HTTP loopback address");
        }
        const entries = Object.keys(this.data.clients);
        if (!this.data.clients[client.client_id] && entries.length >= 200) throw new InvalidRequestError("OAuth client registration limit reached");
        this.data.clients[client.client_id] = client;
        this.data.clientUsage[client.client_id] ||= { createdAt: new Date((client.client_id_issued_at || Math.floor(Date.now() / 1000)) * 1000).toISOString() };
        const registrationOrigin = requestContext()?.oauthOrigin;
        if (registrationOrigin) this.noteClientOrigin(client.client_id, registrationOrigin, { registeredAt: new Date().toISOString() });
        this.recordAudit({ action: "oauth.client.register", outcome: "success", credentialType: "oauth-client", clientId: client.client_id, origin: registrationOrigin || null });
        await this.save();
        return client;
      },
    };
  }

  recordAudit(event) {
    const entry = {
      id: randomUUID(),
      time: new Date().toISOString(),
      outcome: "success",
      ...event,
    };
    delete entry.secret;
    delete entry.token;
    this.data.audit.push(entry);
    if (this.data.audit.length > this.auditMaxEntries) this.data.audit.splice(0, this.data.audit.length - this.auditMaxEntries);
    this.scheduleSave();
    return entry;
  }

  noteClientOrigin(clientId, resource, { registeredAt = null, requestedAt = null, authorizedAt = null, usedAt = null } = {}) {
    let origin;
    try { origin = new URL(resource).origin; } catch { return null; }
    const usage = this.data.clientUsage[clientId] ||= { createdAt: null };
    usage.origins = [...new Set([...(Array.isArray(usage.origins) ? usage.origins : []), origin])];
    if (registeredAt) {
      usage.registeredOrigin ||= origin;
      usage.registeredAt ||= registeredAt;
    }
    if (requestedAt) {
      usage.lastRequestedAt = requestedAt;
      usage.lastRequestedOrigin = origin;
    }
    if (authorizedAt) {
      usage.lastAuthorizedAt = authorizedAt;
      usage.lastAuthorizedOrigin = origin;
    }
    if (usedAt) {
      usage.lastUsedOrigin = origin;
    }
    return origin;
  }

  async createApiKey(label, allowedScopes = OAUTH_SCOPES, allowedVaults = [DEFAULT_VAULT_ID], defaultVaultId = null) {
    await this.ready;
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel || cleanLabel.length > 120 || /[\r\n\0]/.test(cleanLabel)) throw new InvalidRequestError("API key remark must be 1-120 single-line characters");
    const normalizedAllowedVaults = normalizedVaults(allowedVaults);
    const id = randomUUID();
    const secret = `obmcp_${randomBytes(6).toString("hex")}_${token(32)}`;
    const record = {
      id,
      label: cleanLabel,
      prefix: secret.slice(0, 20),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      lastSource: null,
      lastUserAgent: null,
      allowedScopes: normalizedScopes(allowedScopes),
      allowedVaults: normalizedAllowedVaults,
      defaultVaultId: normalizeDefaultVaultId(defaultVaultId, normalizedAllowedVaults),
    };
    this.data.apiKeys[digest(secret)] = record;
    this.recordAudit({ action: "api-key.create", credentialType: "api-key", credentialId: id, scopes: record.allowedScopes, vaults: record.allowedVaults, detail: cleanLabel });
    await this.save();
    return { ...record, secret };
  }

  async verifyApiKey(secret, usage = {}) {
    await this.ready;
    const record = this.data.apiKeys[digest(secret)];
    if (!record) throw new Error("Invalid API key");
    record.lastUsedAt = new Date().toISOString();
    record.lastSource = usage.source || null;
    record.lastUserAgent = usage.userAgent || null;
    this.recordAudit({ action: usage.action || "mcp.call", credentialType: "api-key", credentialId: record.id, clientId: `api-key:${record.id}`, scopes: record.allowedScopes, vaults: record.allowedVaults, ...attributeApiKeyLabel(usage, record.label), outcome: "success" });
    return { type: "api-key", clientId: `api-key:${record.id}`, scopes: [...record.allowedScopes], allowedVaults: [...record.allowedVaults], defaultVaultId: record.defaultVaultId ?? null, keyId: record.id };
  }

  // AuthZ Wave B / B2 (A-10): side-effect-free counterpart of `verifyApiKey`, so
  // the final usage record can be committed only after the time gate.
  async verifyApiKeyDeferred(secret) {
    await this.ready;
    const record = this.data.apiKeys[digest(secret)];
    if (!record) throw new Error("Invalid API key");
    return { type: "api-key", clientId: `api-key:${record.id}`, scopes: [...record.allowedScopes], allowedVaults: [...record.allowedVaults], defaultVaultId: record.defaultVaultId ?? null, keyId: record.id };
  }

  // Commits the usage `verifyApiKeyDeferred` postponed (audit mirrors `verifyApiKey`).
  async noteApiKeyUse(auth, usage = {}) {
    await this.ready;
    const record = Object.values(this.data.apiKeys).find((item) => item.id === auth?.keyId);
    if (record) Object.assign(record, { lastUsedAt: new Date().toISOString(), lastSource: usage.source || null, lastUserAgent: usage.userAgent || null });
    this.recordAudit({
      action: usage.action || "mcp.call",
      credentialType: "api-key",
      credentialId: record?.id ?? (auth?.keyId || null),
      clientId: record ? `api-key:${record.id}` : (auth?.clientId || null),
      scopes: record?.allowedScopes ?? auth?.scopes ?? [],
      vaults: record?.allowedVaults ?? auth?.allowedVaults ?? [],
      ...attributeApiKeyLabel(usage, record?.label),
      outcome: "success",
    });
  }

  async noteConfiguredApiKeyUse(usage = {}) {
    await this.ready;
    this.data.configuredApiKeyUsage = {
      lastUsedAt: new Date().toISOString(),
      lastSource: usage.source || null,
      lastUserAgent: usage.userAgent || null,
    };
    this.recordAudit({ action: usage.action || "mcp.call", credentialType: "api-key", credentialId: "configured-env", clientId: "api-key:configured-env", ...usage, outcome: "success" });
  }

  async deleteApiKey(id) {
    await this.ready;
    const found = Object.entries(this.data.apiKeys).find(([, record]) => record.id === id);
    if (!found) return false;
    delete this.data.apiKeys[found[0]];
    this.recordAudit({ action: "api-key.delete", credentialType: "api-key", credentialId: id });
    await this.save();
    return true;
  }

  async createOAuthUser({ username, password, displayName, allowedScopes, allowedVaults }) {
    await this.ready;
    const normalizedUsername = cleanUsername(username);
    if (Object.values(this.data.oauthUsers).some((item) => item.username === normalizedUsername)) {
      throw new InvalidRequestError("OAuth username already exists");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      username: normalizedUsername,
      displayName: String(displayName || normalizedUsername).trim().slice(0, 120) || normalizedUsername,
      passwordHash: await hashPassword(validatePassword(password)),
      allowedScopes: normalizedScopes(allowedScopes),
      allowedVaults: normalizedVaults(allowedVaults),
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      lastLoginAt: null,
      lastSource: null,
      lastUserAgent: null,
    };
    this.data.oauthUsers[id] = record;
    this.data.oauthUsersInitialized = true;
    this.recordAudit({ action: "oauth.user.create", credentialType: "oauth-user", credentialId: id, detail: normalizedUsername });
    await this.save();
    const { passwordHash: _passwordHash, ...safeRecord } = record;
    return safeRecord;
  }

  async updateOAuthUser(id, { password, displayName, allowedScopes, allowedVaults, disabled, revokeGrants = true }) {
    await this.ready;
    const record = this.data.oauthUsers[id];
    if (!record) return null;
    if (password) record.passwordHash = await hashPassword(validatePassword(password));
    if (displayName !== undefined) record.displayName = String(displayName || record.username).trim().slice(0, 120) || record.username;
    if (allowedScopes !== undefined) record.allowedScopes = normalizedScopes(allowedScopes);
    if (allowedVaults !== undefined) record.allowedVaults = normalizedVaults(allowedVaults);
    if (disabled === true) record.disabledAt ||= new Date().toISOString();
    if (disabled === false) record.disabledAt = null;
    record.updatedAt = new Date().toISOString();
    const revokedClientIds = revokeGrants && (disabled === true || Boolean(password) || allowedScopes !== undefined || allowedVaults !== undefined) ? this.revokeUserGrantsInMemory(id) : [];
    this.recordAudit({ action: password ? "oauth.user.password.reset" : (disabled === true ? "oauth.user.disable" : (disabled === false ? "oauth.user.enable" : "oauth.user.update")), credentialType: "oauth-user", credentialId: id, detail: record.username });
    await this.save();
    const { passwordHash: _passwordHash, ...safeRecord } = record;
    return { user: safeRecord, revokedClientIds };
  }

  revokeUserGrantsInMemory(userId) {
    const now = new Date().toISOString();
    const clientIds = new Set();
    for (const collection of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const record of Object.values(collection)) {
        if (record.userId !== userId) continue;
        record.revokedAt ||= now;
        clientIds.add(record.clientId);
      }
    }
    for (const [key, record] of Object.entries(this.data.codes)) {
      if (record.userId !== userId) continue;
      clientIds.add(record.clientId);
      delete this.data.codes[key];
    }
    return [...clientIds];
  }

  async deleteOAuthUser(id) {
    await this.ready;
    const record = this.data.oauthUsers[id];
    if (!record) return null;
    const revokedClientIds = this.revokeUserGrantsInMemory(id);
    delete this.data.oauthUsers[id];
    this.recordAudit({ action: "oauth.user.delete", credentialType: "oauth-user", credentialId: id, detail: record.username });
    await this.save();
    return revokedClientIds;
  }

  async authenticateOAuthUser(username, password, usage = {}) {
    await this.ready;
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const failureKey = `${usage.source || "unknown"}:${normalizedUsername}`;
    const failure = this.loginFailures.get(failureKey) || { count: 0, resetAt: Date.now() + LOGIN_LOCK_WINDOW_MS };
    if (failure.resetAt <= Date.now()) Object.assign(failure, { count: 0, resetAt: Date.now() + LOGIN_LOCK_WINDOW_MS });
    if (failure.count >= LOGIN_LOCK_MAX_FAILURES) {
      const error = new InvalidRequestError("Too many OAuth login attempts. Try again later.");
      error.retryAfterSeconds = lockRetryAfterSeconds(failure.resetAt);
      throw error;
    }
    const record = Object.values(this.data.oauthUsers).find((item) => item.username === normalizedUsername);
    if (!record || record.disabledAt || !(await verifyPassword(password, record.passwordHash))) {
      failure.count += 1;
      this.loginFailures.set(failureKey, failure);
      this.recordAudit({ action: "oauth.user.login", credentialType: "oauth-user", credentialId: record?.id, outcome: "failure", source: usage.source || null, userAgent: usage.userAgent || null });
      return null;
    }
    this.loginFailures.delete(failureKey);
    record.lastLoginAt = new Date().toISOString();
    record.lastSource = usage.source || null;
    record.lastUserAgent = usage.userAgent || null;
    this.recordAudit({ action: "oauth.user.login", credentialType: "oauth-user", credentialId: record.id, outcome: "success", source: usage.source || null, userAgent: usage.userAgent || null });
    return record;
  }

  async oauthUserSessionRecord(id) {
    await this.ready;
    const record = this.data.oauthUsers[id];
    if (!record || record.disabledAt) return null;
    const { passwordHash: _passwordHash, ...safeRecord } = record;
    return { ...safeRecord, allowedScopes: [...record.allowedScopes], allowedVaults: [...record.allowedVaults] };
  }

  async authorizationSnapshot() {
    await this.ready;
    await this.prune(false);
    const now = Date.now();
    const connectionOrigin = (resource) => {
      try { return new URL(resource).origin; } catch { return null; }
    };
    const tokens = (collection, type) => Object.values(collection).map((record) => ({
      id: record.id, type, clientId: record.clientId, userId: record.userId || null,
      // #364 slice-2 seam: the credential's generation, so the Admin projection can overlay the fence.
      generation: Number.isInteger(record.generation) ? record.generation : 0,
      username: record.userId ? this.data.oauthUsers[record.userId]?.username || "已删除账户" : "旧授权",
      scopes: record.scopes,
      allowedVaults: record.allowedVaults,
      createdAt: record.createdAt,
      expiresAt: new Date(record.expiresAt).toISOString(),
      lastUsedAt: record.lastUsedAt || null,
      lastSource: record.lastSource || null,
      lastUserAgent: record.lastUserAgent || null,
      connectionOrigin: connectionOrigin(record.resource),
      status: record.revokedAt ? "revoked" : (record.usedAt && type === "refresh" ? "rotated" : (record.expiresAt <= now ? "expired" : "active")),
      revokedAt: record.revokedAt || null,
    }));
    return {
      apiKeys: Object.values(this.data.apiKeys).map((record) => ({ ...record })),
      configuredApiKeyUsage: { ...this.data.configuredApiKeyUsage },
      oauthUsers: Object.values(this.data.oauthUsers).map(({ passwordHash: _passwordHash, ...record }) => ({ ...record })),
      clients: Object.entries(this.data.clients).map(([clientId, client]) => {
        const usage = this.data.clientUsage[clientId] || {};
        const tokenRecords = [...Object.values(this.data.accessTokens), ...Object.values(this.data.refreshTokens)]
          .filter((record) => record.clientId === clientId);
        const origins = [...new Set([
          ...(Array.isArray(usage.origins) ? usage.origins : []),
          ...tokenRecords.map((record) => connectionOrigin(record.resource)).filter(Boolean),
        ])];
        const latestUsed = tokenRecords
          .filter((record) => record.lastUsedAt && connectionOrigin(record.resource))
          .sort((left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt))[0];
        return {
          clientId,
          defaultVaultId: usage.defaultVaultId ?? null,
          clientName: client.client_name || "",
          redirectUris: client.redirect_uris || [],
          connectionOrigins: origins,
          registeredOrigin: usage.registeredOrigin || null,
          lastRequestedOrigin: usage.lastRequestedOrigin || null,
          lastAuthorizedOrigin: usage.lastAuthorizedOrigin || null,
          lastConnectionOrigin: usage.lastUsedOrigin || connectionOrigin(latestUsed?.resource) || usage.lastAuthorizedOrigin || usage.lastRequestedOrigin || usage.registeredOrigin || origins[0] || null,
          createdAt: usage.createdAt || (client.client_id_issued_at ? new Date(client.client_id_issued_at * 1000).toISOString() : null),
          lastUsedAt: usage.lastUsedAt || null,
          lastSource: usage.lastSource || null,
          lastUserAgent: usage.lastUserAgent || null,
        };
      }),
      tokens: [...tokens(this.data.accessTokens, "access"), ...tokens(this.data.refreshTokens, "refresh")]
        .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0)),
      audit: [...this.data.audit].reverse(),
    };
  }

  async cleanupTokenRecords(olderThanDays = 7) {
    await this.ready;
    const days = Number(olderThanDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new InvalidRequestError("Token cleanup retention must be 0-3650 days");
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const removed = { access: 0, refresh: 0, total: 0, olderThanDays: days };
    for (const [type, collection] of [["access", this.data.accessTokens], ["refresh", this.data.refreshTokens]]) {
      for (const [key, record] of Object.entries(collection)) {
        let inactiveAt = null;
        if (record.revokedAt) inactiveAt = Date.parse(record.revokedAt);
        else if (type === "refresh" && record.usedAt) inactiveAt = Number(record.usedAt);
        else if (record.expiresAt <= now) inactiveAt = Number(record.expiresAt);
        if (!Number.isFinite(inactiveAt) || inactiveAt > cutoff) continue;
        delete collection[key];
        removed[type] += 1;
        removed.total += 1;
      }
    }
    this.recordAudit({ action: "oauth.token.cleanup", credentialType: "admin-session", detail: `removed=${removed.total}; retentionDays=${days}` });
    await this.save();
    return removed;
  }

  async revokeTokenById(type, id) {
    await this.ready;
    const collection = type === "access" ? this.data.accessTokens : type === "refresh" ? this.data.refreshTokens : null;
    if (!collection) throw new InvalidRequestError("Unknown token type");
    const record = Object.values(collection).find((item) => item.id === id);
    if (!record) return null;
    record.revokedAt ||= new Date().toISOString();
    this.recordAudit({ action: "oauth.token.revoke", credentialType: `oauth-${type}`, credentialId: id, clientId: record.clientId });
    await this.save();
    return { clientId: record.clientId, userId: record.userId || null };
  }

  async revokeClient(clientId, deleteRegistration = false) {
    await this.ready;
    const now = new Date().toISOString();
    let changed = false;
    for (const collection of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const record of Object.values(collection)) {
        if (record.clientId !== clientId) continue;
        record.revokedAt ||= now;
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.data.codes)) {
      if (record.clientId === clientId) {
        delete this.data.codes[key];
        changed = true;
      }
    }
    if (deleteRegistration && this.data.clients[clientId]) {
      delete this.data.clients[clientId];
      delete this.data.clientUsage[clientId];
      changed = true;
    }
    if (changed) {
      this.recordAudit({ action: deleteRegistration ? "oauth.client.delete" : "oauth.client.revoke", credentialType: "oauth-client", clientId });
      await this.save();
    }
    return changed;
  }

  async clearAudit() {
    await this.ready;
    this.data.audit = [];
    await this.save();
  }
}

Object.assign(PersistentOAuthProvider.prototype, persistenceMethods, protocolMethods, authorizationTransferMethods);

export function createOAuthService({ accessRuntime = null, closeSessions = null, transferStore = null } = {}) {
  if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is required when OAUTH_ENABLED=true");
  if (!PUBLIC_BASE_URLS.length) throw new Error("At least one PUBLIC_BASE_URL is required when OAUTH_ENABLED=true");
  if (!OAUTH_ADMIN_PASSWORD) throw new Error("OAUTH_ADMIN_PASSWORD is required when OAUTH_ENABLED=true");
  for (const origin of PUBLIC_BASE_URLS) {
    const candidate = new URL(`${origin}/`);
    if (candidate.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(candidate.hostname)) {
      throw new Error("PUBLIC_BASE_URL and aliases must use HTTPS outside localhost");
    }
  }
  const issuer = new URL(`${PUBLIC_BASE_URL}/`);
  const resource = new URL(MCP_PATH.replace(/^\/+/, ""), issuer);
  const allowedResources = PUBLIC_BASE_URLS.map((origin) => new URL(MCP_PATH.replace(/^\/+/, ""), `${origin}/`));
  const approvalPath = "/oauth/decision";
  const provider = new PersistentOAuthProvider({
    file: path.join(DATA_PATH, "oauth", "state.json"),
    adminPassword: OAUTH_ADMIN_PASSWORD,
    canonicalResource: resource,
    allowedResources,
    accessTtlSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    refreshReuseGraceSeconds: OAUTH_REFRESH_REUSE_GRACE_SECONDS,
    auditMaxEntries: AUTH_AUDIT_MAX_ENTRIES,
    approvalPath,
    initialUsername: OAUTH_INITIAL_USERNAME,
    initialPassword: OAUTH_INITIAL_PASSWORD,
    accessRuntime,
    transferStore,
    closeSessions,
  });
  return {
    issuer,
    resource,
    publicBaseUrls: PUBLIC_BASE_URLS,
    allowedResources,
    approvalPath,
    provider,
    resolveOrigin(req) {
      return resolvePublicOrigin(req, PUBLIC_BASE_URLS, PUBLIC_BASE_URL);
    },
    resourceForOrigin(origin) {
      return new URL(MCP_PATH.replace(/^\/+/, ""), `${String(origin || PUBLIC_BASE_URL).replace(/\/+$/, "")}/`);
    },
  };
}
