import { randomUUID } from "node:crypto";
import { lockoutLoginMessage, lockoutRetryAfter } from "../login-lockout.js";
import { AccessDeniedError, InvalidGrantError, InvalidScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { capabilitiesForOAuthLifecycle } from "../access-policy/capabilities.js";
import { subjectsFromOAuthRecord } from "../access-policy/subjects.js";
import {
  DEFAULT_VAULT_ID, SCOPE_LABELS, digest, escapeHtml, normalizeResource, normalizedScopes,
  normalizedVaults, sourceFromRequest, token,
} from "./primitives.js";
import { normalizeGeneration } from "./authorization-transfer-runtime.js";

// AuthZ Wave B / B2 — OAuth lifecycle hard revoke gate.
//
// Only a `revoke` policy denies here: `suspend` and a broken runtime stay inert on
// the OAuth protocol surface (the content gates own those), and an absent runtime
// is a strict no-op. The evaluation happens before any durable lifecycle write
// (`usedAt` / `revokedAt` / `issueTokens`) so a denied refresh consumes nothing and
// the original token keeps working once the window reopens.
function oauthHardRevoke(runtime, clientId, userId) {
  if (!runtime || typeof runtime.evaluate !== "function") return null;
  const subjects = subjectsFromOAuthRecord(clientId, userId);
  const capabilities = capabilitiesForOAuthLifecycle();
  const decision = runtime.evaluate({ subjects, capabilities });
  if (!decision || decision.allowed !== false || decision.mode !== "revoke") return null;
  let nextAllowedAt = null;
  try {
    nextAllowedAt = runtime.explain?.({ subjects, capabilities })?.nextAllowedAt ?? null;
  } catch {
    nextAllowedAt = null;
  }
  return { policyId: decision.denyPolicyId ?? null, nextAllowedAt };
}

export const protocolMethods = {
  renderAuthorization(res, transactionId, transaction, error = "") {
    const name = transaction.client.client_name || transaction.client.client_id;
    const scopeControls = transaction.params.scopes.map((scope) => {
      const [label, description] = SCOPE_LABELS[scope] || [scope, scope];
      return `<label class="scope"><input name="scope" type="checkbox" value="${escapeHtml(scope)}" checked><span><strong>${escapeHtml(label)}</strong> <code>${escapeHtml(scope)}</code><small>${escapeHtml(description)}</small></span></label>`;
    }).join("");
    res.status(error ? 403 : 200).type("html").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 Obsidian MCP</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>
:root{color-scheme:light;--bg:#f7f6f3;--panel:#fff;--text:#242321;--muted:#6f6d68;--line:#dedbd5;--accent:#333230;--danger:#b42318;--focus:#2563eb}
*{box-sizing:border-box}body{font:13px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:18px}
.card{max-width:560px;margin:5vh auto;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:21px}h1{font-size:21px;line-height:1.3;margin:0 0 10px}
fieldset{border:1px solid var(--line);border-radius:7px;padding:5px 11px 8px;margin:3px 0 12px}legend{padding:0 5px;font-weight:650}.scope{display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--line);padding:8px 2px;cursor:pointer}.scope:last-child{border-bottom:0}
.scope input{appearance:none;display:grid;place-items:center;flex:0 0 15px;width:15px;height:15px;margin:0;border:1px solid #aaa7a0;border-radius:4px;background:#fff}.scope input:after{content:"";width:6px;height:3px;border-left:1.5px solid #fff;border-bottom:1.5px solid #fff;opacity:0;transform:translateY(-1px) rotate(-45deg)}.scope input:checked{background:var(--accent);border-color:var(--accent)}.scope input:checked:after{opacity:1}.scope input:focus-visible{outline:2px solid #2563eb55;outline-offset:2px}.scope span{display:block;flex:1}.scope small{display:block;color:var(--muted);margin-top:1px}
.field{font:inherit;color:inherit;background:#fff;width:100%;padding:6px 8px;border:1px solid #aaa7a0;border-radius:6px;margin:3px 0 10px;min-height:34px;outline:0}.field:focus{border-color:var(--focus);box-shadow:0 0 0 2px #2563eb20}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{font:inherit;font-size:12px;font-weight:600;line-height:1.2;border:1px solid var(--accent);border-radius:6px;padding:6px 10px;cursor:pointer;min-height:32px}.allow{background:var(--accent);color:#fff}.deny{background:#fff;color:var(--text);border-color:#aaa7a0!important}.error{background:#fff7f6;color:var(--danger);border:1px solid #e4b7b2;border-radius:7px;padding:8px}.muted{color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;overflow-wrap:anywhere}@media(max-width:640px){body{padding:10px}.card{margin:2vh auto;padding:16px}}
</style></head><body><main class="card"><h1>授权 Obsidian MCP</h1><p><strong>${escapeHtml(name)}</strong> 请求访问你的 Obsidian Vault。</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="${escapeHtml(this.approvalPath)}"><input type="hidden" name="transaction" value="${escapeHtml(transactionId)}">
<label for="username">OAuth 账户</label><input class="field" id="username" name="username" autocomplete="username" required><label for="password">账户密码</label><input class="field" id="password" name="password" type="password" autocomplete="current-password" required>
<fieldset><legend>本次授权范围（可取消不需要的权限）</legend>${scopeControls}</fieldset><p class="muted">令牌只对 <code>${escapeHtml(transaction.params.resource)}</code> 有效。账户权限上限由授权管理员设置。</p>
<div class="actions"><button class="allow" name="decision" value="allow">登录并允许</button><button class="deny" name="decision" value="deny" formnovalidate>拒绝</button></div></form></main></body></html>`);
  },

  async authorize(client, params, res) {
    await this.ready;
    await this.prune(false);
    const scopes = normalizedScopes(params.scopes);
    const resource = normalizeResource(params.resource, this.allowedResources, this.canonicalResource);
    this.noteClientOrigin(client.client_id, resource, { requestedAt: new Date().toISOString() });
    await this.save();
    const transactionId = token(24);
    this.transactions.set(transactionId, { client, params: { ...params, scopes, resource: resource.href }, expiresAt: Date.now() + 10 * 60 * 1000 });
    this.renderAuthorization(res, transactionId, this.transactions.get(transactionId));
  },

  async handleApproval(req, res) {
    await this.ready;
    await this.prune(false);
    const transactionId = String(req.body?.transaction || "");
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.expiresAt <= Date.now()) {
      res.status(400).send("Authorization request expired. Return to the MCP client and try again.");
      return;
    }
    const redirect = new URL(transaction.params.redirectUri);
    if (transaction.params.state) redirect.searchParams.set("state", transaction.params.state);
    if (req.body?.decision !== "allow") {
      this.transactions.delete(transactionId);
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "The resource owner denied the request");
      res.redirect(302, redirect.href);
      return;
    }
    let user;
    try {
      user = await this.authenticateOAuthUser(req.body?.username, req.body?.password, {
        source: sourceFromRequest(req), userAgent: String(req.headers?.["user-agent"] || "").slice(0, 240) || null,
      });
    } catch (error) {
      if (/Too many/.test(error?.message || "")) {
        this.renderAuthorization(res, transactionId, transaction, lockoutLoginMessage(lockoutRetryAfter(res, error)));
        return;
      }
      throw error;
    }
    if (!user) {
      this.renderAuthorization(res, transactionId, transaction, "账户名或密码不正确，或账户已停用。");
      return;
    }
    // Identity is confirmed; a hard revoke window rejects the approval itself
    // through the existing 403 rendering path (no policy JSON, never a 500). The
    // transaction is kept so the user can retry once the window reopens.
    const revoked = oauthHardRevoke(this.accessRuntime, transaction.client.client_id, user.id);
    if (revoked) {
      this.recordAudit({ action: "authz.deny", outcome: "failure", surface: "oauth", mode: "revoke", policyId: revoked.policyId, nextAllowedAt: revoked.nextAllowedAt, credentialType: "oauth-client", clientId: transaction.client.client_id, userId: user.id });
      this.renderAuthorization(res, transactionId, transaction, "当前时间不在该账户的授权时间窗内，暂时无法完成授权。请稍后重试。");
      return;
    }
    const selected = Array.isArray(req.body?.scope) ? req.body.scope : (req.body?.scope ? [req.body.scope] : []);
    const scopes = [...new Set(selected.map(String))];
    if (!scopes.length || scopes.some((scope) => !transaction.params.scopes.includes(scope) || !user.allowedScopes.includes(scope))) {
      this.renderAuthorization(res, transactionId, transaction, "请选择至少一项账户允许且客户端已请求的权限。");
      return;
    }
    this.transactions.delete(transactionId);
    const authorizationCode = token(32);
    this.data.codes[digest(authorizationCode)] = {
      clientId: transaction.client.client_id, redirectUri: transaction.params.redirectUri,
      codeChallenge: transaction.params.codeChallenge, scopes, userId: user.id,
      resource: transaction.params.resource, expiresAt: Date.now() + 5 * 60 * 1000,
      // #364: the code is minted at the pair's CURRENT generation, so a fresh
      // consent after a transfer produces a usable (new-generation) grant while a
      // code captured before the fence stays permanently unusable.
      generation: this.currentPairGenerationFor(transaction.client.client_id, user.id),
    };
    await this.save();
    redirect.searchParams.set("code", authorizationCode);
    res.redirect(302, redirect.href);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    await this.ready;
    const record = this.data.codes[digest(authorizationCode)];
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return record.codeChallenge;
  },

  issueTokens(clientId, scopes, resource, userId = null, allowedVaults = [DEFAULT_VAULT_ID], generation = 0) {
    const accessToken = token(32);
    const refreshToken = token(40);
    const now = Date.now();
    const vaults = normalizedVaults(allowedVaults);
    // #364: a credential carries the generation of the credential it was issued
    // from (never "now"), so an in-flight exchange cannot upgrade an old code or
    // refresh token across a concurrently committed transfer fence.
    const credentialGeneration = normalizeGeneration(generation);
    this.data.accessTokens[digest(accessToken)] = { id: randomUUID(), clientId, userId, generation: credentialGeneration, scopes, allowedVaults: vaults, resource, createdAt: new Date(now).toISOString(), expiresAt: now + this.accessTtlSeconds * 1000, lastUsedAt: null, lastSource: null, lastUserAgent: null };
    this.data.refreshTokens[digest(refreshToken)] = { id: randomUUID(), clientId, userId, generation: credentialGeneration, scopes, allowedVaults: vaults, resource, createdAt: new Date(now).toISOString(), expiresAt: now + this.refreshTtlSeconds * 1000, lastUsedAt: null, lastSource: null, lastUserAgent: null };
    return { access_token: accessToken, token_type: "Bearer", expires_in: this.accessTtlSeconds, refresh_token: refreshToken, scope: scopes.join(" ") };
  },

  // #364 §17-5: a normal exchange re-checks the CURRENT account instead of trusting
  // the scope snapshot saved at consent time. A disabled/deleted account, or one
  // whose ceiling no longer covers any consented scope, must not complete a grant.
  exchangeAccountCeiling(record) {
    if (!record.userId) return { scopes: [...record.scopes], allowedVaults: [DEFAULT_VAULT_ID] };
    const user = this.data.oauthUsers[record.userId];
    if (!user || user.disabledAt) throw new InvalidGrantError("The account is no longer allowed to authorize this client");
    const scopes = record.scopes.filter((scope) => user.allowedScopes.includes(scope));
    if (!scopes.length) throw new InvalidGrantError("The account no longer allows any of the requested scopes");
    return { scopes, allowedVaults: user.allowedVaults };
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, requestedResource) {
    await this.ready;
    const key = digest(authorizationCode);
    const record = this.data.codes[key];
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== record.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    const resource = normalizeResource(requestedResource || record.resource, this.allowedResources, record.resource);
    if (resource.href !== record.resource) throw new InvalidGrantError("resource does not match the authorization request");
    // AuthZ hard revoke gate (BRIEF-R1 / INTERFACE §10.2 erratum): evaluated
    // *before* the authorization code is consumed, so a denied exchange leaves
    // the code usable for the rest of its 5 minute TTL and issues nothing.
    const revoked = oauthHardRevoke(this.accessRuntime, client.client_id, record.userId);
    if (revoked) {
      this.recordAudit({ action: "authz.deny", outcome: "failure", surface: "oauth", mode: "revoke", policyId: revoked.policyId, nextAllowedAt: revoked.nextAllowedAt, credentialType: "oauth-client", clientId: client.client_id, userId: record.userId || null });
      throw new AccessDeniedError("Access is outside the authorized time window");
    }
    // #364 durable transfer fence: independent of the AuthZ runtime, consulted
    // before the code is consumed. A pre-fence generation is permanently invalid,
    // yet the code is deliberately left unconsumed (same convention as the gate above).
    if (this.isCredentialFenced(record)) {
      this.recordFencedCredentialDeny({ clientId: client.client_id, userId: record.userId, credentialType: "oauth-code" });
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    delete this.data.codes[key];
    const ceiling = this.exchangeAccountCeiling(record);
    const result = this.issueTokens(client.client_id, ceiling.scopes, record.resource, record.userId, ceiling.allowedVaults, record.generation);
    const origin = this.noteClientOrigin(client.client_id, record.resource, { authorizedAt: new Date().toISOString() });
    this.recordAudit({ action: "oauth.token.issue", credentialType: "oauth-client", clientId: client.client_id, userId: record.userId, scopes: ceiling.scopes, vaults: ceiling.allowedVaults, origin, detail: ceiling.scopes.join(" ") });
    await this.save();
    // §4.4 completion hook: only a successful normal exchange may close a pending
    // transfer intent. A failure here never fails the token response and never
    // claims a completion that is not durable.
    await this.noteAuthorizationTransferCompletion({ clientId: client.client_id, userId: record.userId });
    return result;
  },

  async exchangeRefreshToken(client, refreshToken, requestedScopes, requestedResource) {
    await this.ready;
    const record = this.data.refreshTokens[digest(refreshToken)];
    const now = Date.now();
    if (!record || record.clientId !== client.client_id || record.expiresAt <= now || record.revokedAt) throw new InvalidGrantError("Invalid or expired refresh token");
    if (record.usedAt && now - record.usedAt > this.refreshReuseGraceSeconds * 1000) throw new InvalidGrantError("Refresh token has already been rotated");
    const scopes = normalizedScopes(requestedScopes, record.scopes);
    if (scopes.some((scope) => !record.scopes.includes(scope))) throw new InvalidScopeError("Refresh scope exceeds the original grant");
    const resource = normalizeResource(requestedResource || record.resource, this.allowedResources, record.resource);
    if (resource.href !== record.resource) throw new InvalidGrantError("resource does not match the original grant");
    // Before `usedAt` / `issueTokens`: a denied refresh must not rotate, consume or
    // revoke anything, and must not masquerade as `invalid_grant`.
    const revoked = oauthHardRevoke(this.accessRuntime, client.client_id, record.userId);
    if (revoked) {
      this.recordAudit({ action: "authz.deny", outcome: "failure", surface: "oauth", mode: "revoke", policyId: revoked.policyId, nextAllowedAt: revoked.nextAllowedAt, credentialType: "oauth-refresh", credentialId: record.id, clientId: client.client_id, userId: record.userId || null });
      throw new AccessDeniedError("Access is outside the authorized time window");
    }
    // #364 durable transfer fence: consulted before `usedAt` / `issueTokens`, so a
    // fenced refresh neither rotates nor mints a new generation.
    if (this.isCredentialFenced(record)) {
      this.recordFencedCredentialDeny({ clientId: client.client_id, userId: record.userId, credentialType: "oauth-refresh", credentialId: record.id });
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    record.usedAt ||= now;
    record.lastUsedAt = new Date(now).toISOString();
    const result = this.issueTokens(client.client_id, scopes, record.resource, record.userId, record.allowedVaults, record.generation);
    const origin = this.noteClientOrigin(client.client_id, record.resource, { authorizedAt: record.lastUsedAt });
    this.recordAudit({ action: "oauth.token.refresh", credentialType: "oauth-refresh", credentialId: record.id, clientId: client.client_id, userId: record.userId, scopes, vaults: record.allowedVaults, origin });
    await this.save();
    return result;
  },

  async verifyAccessToken(accessToken, expectedResource) {
    await this.ready;
    const record = this.data.accessTokens[digest(accessToken)];
    if (!record || record.expiresAt <= Date.now() || record.revokedAt) throw new Error("Invalid or expired OAuth access token");
    // #364 durable transfer fence, consulted before any audience/scope work.
    if (this.isCredentialFenced(record)) throw new Error("Invalid or expired OAuth access token");
    if (!this.allowedResources.has(record.resource)) throw new Error("OAuth token audience does not match this MCP server");
    if (expectedResource && new URL(expectedResource).href !== record.resource) throw new Error("OAuth token audience does not match the requested MCP domain");
    return { token: accessToken, clientId: record.clientId, userId: record.userId || null, scopes: record.scopes, allowedVaults: [...record.allowedVaults], defaultVaultId: this.data.clientUsage[record.clientId]?.defaultVaultId ?? null, expiresAt: Math.floor(record.expiresAt / 1000), resource: new URL(record.resource) };
  },

  async noteAccessTokenUse(accessToken, usage = {}) {
    await this.ready;
    const record = this.data.accessTokens[digest(accessToken)];
    if (!record || record.expiresAt <= Date.now() || record.revokedAt) return;
    record.lastUsedAt = new Date().toISOString();
    record.lastSource = usage.source || null;
    record.lastUserAgent = usage.userAgent || null;
    const clientUsage = this.data.clientUsage[record.clientId] ||= { createdAt: null };
    Object.assign(clientUsage, { lastUsedAt: record.lastUsedAt, lastSource: record.lastSource, lastUserAgent: record.lastUserAgent });
    const origin = this.noteClientOrigin(record.clientId, record.resource, { usedAt: record.lastUsedAt });
    this.recordAudit({ action: usage.action || "mcp.call", credentialType: "oauth-access", credentialId: record.id, clientId: record.clientId, userId: record.userId || null, ...usage, origin, outcome: "success" });
  },

  async revokeToken(client, request) {
    await this.ready;
    const key = digest(request.token);
    const access = this.data.accessTokens[key];
    const refresh = this.data.refreshTokens[key];
    const revokedAt = new Date().toISOString();
    if (access?.clientId === client.client_id) access.revokedAt ||= revokedAt;
    if (refresh?.clientId === client.client_id) refresh.revokedAt ||= revokedAt;
    if (access || refresh) this.recordAudit({ action: "oauth.token.revoke", credentialType: access ? "oauth-access" : "oauth-refresh", credentialId: access?.id || refresh?.id, clientId: client.client_id });
    await this.save();
  },
};
