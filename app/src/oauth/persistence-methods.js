import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_VAULT_ID, OAUTH_SCOPES, cleanUsername, hashPassword, normalizedScopes,
  normalizedVaults, token, validatePassword,
} from "./primitives.js";
import { normalizeGeneration } from "./authorization-transfer-runtime.js";
import { normalizeDefaultVaultId } from "../default-vault.js";

export const persistenceMethods = {
  async load() {
    // #364: the durable transfer fence must be loadable before the process admits
    // traffic; a corrupt/unreadable store rejects here (fail closed, §16).
    if (this.transferStore) await this.transferStore.ready;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.data = {
        clients: parsed.clients || {}, clientUsage: parsed.clientUsage || {}, codes: parsed.codes || {},
        accessTokens: parsed.accessTokens || {}, refreshTokens: parsed.refreshTokens || {}, apiKeys: parsed.apiKeys || {},
        oauthUsers: parsed.oauthUsers || {}, oauthUsersInitialized: Boolean(parsed.oauthUsersInitialized),
        configuredApiKeyUsage: parsed.configuredApiKeyUsage || parsed.legacyApiKeyUsage || {},
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      };
      for (const [clientId, client] of Object.entries(this.data.clients)) {
        this.data.clientUsage[clientId] ||= { createdAt: client.client_id_issued_at ? new Date(client.client_id_issued_at * 1000).toISOString() : null };
        const usage = this.data.clientUsage[clientId];
        if (usage.defaultVaultId !== undefined) usage.defaultVaultId = normalizeDefaultVaultId(usage.defaultVaultId);
      }
      for (const collection of [this.data.accessTokens, this.data.refreshTokens]) {
        for (const record of Object.values(collection)) {
          record.id ||= randomUUID();
          // #364: a stored credential without a generation predates every transfer
          // fence and is therefore the OLD generation (0). It stays valid until a
          // fence for its pair advances the generation.
          record.generation = normalizeGeneration(record.generation);
          record.createdAt ||= new Date(Math.min(Date.now(), record.expiresAt || Date.now())).toISOString();
          record.lastUsedAt ??= null;
          record.lastSource ??= null;
          record.lastUserAgent ??= null;
          const userVaults = record.userId ? this.data.oauthUsers[record.userId]?.allowedVaults : undefined;
          record.allowedVaults = normalizedVaults(record.allowedVaults, userVaults || [DEFAULT_VAULT_ID]);
        }
      }
      for (const user of Object.values(this.data.oauthUsers)) {
        user.allowedScopes = normalizedScopes(user.allowedScopes);
        user.allowedVaults = normalizedVaults(user.allowedVaults);
        user.displayName ||= user.username;
        user.lastLoginAt ??= null;
        user.lastSource ??= null;
        user.lastUserAgent ??= null;
      }
      for (const record of Object.values(this.data.apiKeys)) {
        record.allowedScopes = normalizedScopes(record.allowedScopes);
        record.allowedVaults = normalizedVaults(record.allowedVaults);
        if (record.defaultVaultId !== undefined) record.defaultVaultId = normalizeDefaultVaultId(record.defaultVaultId);
      }
      // #364: authorization codes minted before this release carry no generation.
      for (const record of Object.values(this.data.codes)) record.generation = normalizeGeneration(record.generation);
      await this.seedInitialUser();
      await this.prune(false);
      await this.save();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.seedInitialUser();
      await this.save();
    }
  },


  async updateApiKey(id, { allowedScopes, allowedVaults, defaultVaultId } = {}) {
    await this.ready;
    const found = Object.values(this.data.apiKeys).find((record) => record.id === id);
    if (!found) return false;
    // Validate every replacement before mutating the live credential.
    const nextScopes = normalizedScopes(allowedScopes, found.allowedScopes);
    const nextVaults = normalizedVaults(allowedVaults, found.allowedVaults);
    const nextDefault = normalizeDefaultVaultId(
      defaultVaultId === undefined ? found.defaultVaultId ?? null : defaultVaultId, nextVaults,
    );
    Object.assign(found, { allowedScopes: nextScopes, allowedVaults: nextVaults, defaultVaultId: nextDefault });
    this.recordAudit({ action: "api-key.authorization.update", credentialType: "api-key", credentialId: id, clientId: `api-key:${id}`, scopes: found.allowedScopes, vaults: found.allowedVaults });
    await this.save();
    return { ...found, allowedScopes: [...found.allowedScopes], allowedVaults: [...found.allowedVaults] };
  },

  async updateOAuthClientDefaultVault(clientId, defaultVaultId) {
    await this.ready;
    if (!Object.hasOwn(this.data.clients, clientId)) return false;
    const normalized = normalizeDefaultVaultId(defaultVaultId);
    // This is a preference, not a grant. Per-token allowlists are enforced on every call.
    const usage = this.data.clientUsage[clientId] ||= { createdAt: null };
    usage.defaultVaultId = normalized;
    this.recordAudit({ action: "oauth.client.default-vault.update", credentialType: "oauth-client", clientId, detail: normalized ? "configured" : "inherit" });
    await this.save();
    return true;
  },

  async seedInitialUser() {
    if (Object.keys(this.data.oauthUsers).length || (!this.initialUsername || !this.initialPassword)) {
      this.data.oauthUsersInitialized = true;
      return;
    }
    const username = cleanUsername(this.initialUsername);
    const password = validatePassword(this.initialPassword);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.data.oauthUsers[id] = {
      id, username, displayName: username, passwordHash: await hashPassword(password),
      allowedScopes: [...OAUTH_SCOPES], allowedVaults: [DEFAULT_VAULT_ID],
      createdAt: now, updatedAt: now, disabledAt: null, lastLoginAt: null, lastSource: null, lastUserAgent: null,
    };
    this.recordAudit({ action: "oauth.user.bootstrap", credentialType: "oauth-user", credentialId: id });
    this.data.oauthUsersInitialized = true;
  },

  async save() {
    // An explicit durable save subsumes any previously scheduled activity save.
    // Cancel that timer before enqueueing so it cannot wake after a caller has
    // already awaited persistence (notably during teardown).
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveQueue = this.saveQueue.then(async () => {
      const temporary = `${this.file}.${process.pid}.${token(6)}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600).catch(() => {});
    });
    return this.saveQueue;
  },

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((error) => console.error("Failed to persist authorization activity:", error instanceof Error ? error.message : String(error)));
    }, 500);
    this.saveTimer.unref?.();
  },

  async drainPersistence() {
    // Teardown/lifecycle barrier: turn any debounced activity into a real queued
    // write, then wait until both the timer slot and save queue are stable.
    // If persistence fails, propagate the error; callers must not treat a failed
    // drain as a successful shutdown.
    while (true) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        await this.save();
      }
      const queue = this.saveQueue;
      await queue;
      if (!this.saveTimer && this.saveQueue === queue) return;
    }
  },

  async prune(save = true) {
    const now = Date.now();
    for (const [key, value] of Object.entries(this.data.codes)) {
      if (!value.expiresAt || value.expiresAt <= now) delete this.data.codes[key];
    }
    const retentionCutoff = now - 7 * 24 * 60 * 60 * 1000;
    for (const collection of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const [key, value] of Object.entries(collection)) {
        if (value.expiresAt <= retentionCutoff || (value.revokedAt && Date.parse(value.revokedAt) <= retentionCutoff)) delete collection[key];
      }
    }
    for (const [key, value] of this.transactions) {
      if (value.expiresAt <= now) this.transactions.delete(key);
    }
    if (save) await this.save();
  },
};
