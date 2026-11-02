// Admin OAuth "授权关系" projection.
//
// The relation between an OAuth account and an OAuth client is an
// AUTHORIZATION relation, not ownership. It is established only while a valid
// grant exists, i.e. a token record whose `status === "active"`. Revoked,
// expired and rotated grants are NOT part of the current relation, so the
// admin UI never shows a revoked client as still authorized. History is
// deliberately not folded into these columns; if it is ever surfaced it must be
// a separate "历史授权" view.

import { normalizeGeneration, pairGenerationKey } from "../oauth/authorization-transfer-runtime.js";

const ACTIVE_GRANT_STATUS = "active";
const UNKNOWN_ACCOUNT_LABEL = "已删除 / 未知";
const NO_ACTIVE_GRANT_LABEL = "无有效授权";
const LEGACY_GRANT_USERNAMES = new Set(["旧授权"]);

function html(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function clientIdOf(record) {
  return record?.clientId == null || record.clientId === "" ? "" : String(record.clientId);
}

function userIdOf(record) {
  return record?.userId == null || record.userId === "" ? "" : String(record.userId);
}

function usernameKeyOf(record) {
  return String(record?.username || "").trim().toLowerCase();
}

// Only tokens explicitly marked active are current grants. A missing `status`
// (legacy fixture or hand-built record) is not an active grant.
function activeGrants(snapshot) {
  const tokens = Array.isArray(snapshot?.tokens) ? snapshot.tokens : [];
  return tokens.filter((token) => token?.status === ACTIVE_GRANT_STATUS);
}

function accountView(user) {
  if (!user) return null;
  const username = String(user.username || "").trim();
  const displayName = String(user.displayName || "").trim() || username;
  if (!displayName && !username) return null;
  return { id: user.id == null || user.id === "" ? "" : String(user.id), username, displayName };
}

function indexAccounts(snapshot) {
  const users = Array.isArray(snapshot?.oauthUsers) ? snapshot.oauthUsers : [];
  const byId = new Map();
  const byName = new Map();
  for (const user of users) {
    const view = accountView(user);
    if (!view) continue;
    if (view.id && !byId.has(view.id)) byId.set(view.id, view);
    if (view.username && !byName.has(view.username.toLowerCase())) byName.set(view.username.toLowerCase(), view);
  }
  return { byId, byName };
}

function pushAccount(accounts, seen, account) {
  if (!account) return;
  const idKey = account.id ? "id:" + account.id : "";
  const nameKey = account.username ? "name:" + account.username.toLowerCase() : "";
  if ((idKey && seen.has(idKey)) || (nameKey && seen.has(nameKey))) return;
  if (idKey) seen.add(idKey);
  if (nameKey) seen.add(nameKey);
  accounts.push(account);
}

function accountDisplay(account) {
  if (account.username && account.displayName && account.displayName !== account.username) {
    return account.displayName + "（" + account.username + "）";
  }
  return account.displayName || account.username;
}

function accountCell(account) {
  const primary = account.displayName || account.username;
  const secondary = account.username && primary !== account.username ? `<br><code>${html(account.username)}</code>` : "";
  return `<span class="cred-name"><strong>${html(primary)}</strong>${secondary}</span>`;
}

// ---------------------------------------------------------------------------
// Issue #364 §4.5: authorization-transfer fence overlay
// ---------------------------------------------------------------------------

/**
 * Overlay the durable transfer fence on a credential snapshot BEFORE any relation is
 * computed. A credential whose own `generation` is behind its pair's committed transfer
 * generation is not a current authorization — even while its record still says `status:
 * "active"` and even when the physical revoke was never persisted. Doing this here (not
 * in the HTML layer) means every consumer of the projection — the linked-account cell, the
 * account client count, the tokens table — agrees on the relation.
 *
 * A fence that cannot be read fails CLOSED: when the store reports `healthy: false` every
 * active grant is withdrawn from the current relation, mirroring `evaluateCredentialFence`'s
 * `degraded` branch. That withdrawal is unconditional: it happens BEFORE the pair check, so a
 * credential without a usable pair (missing `userId`, legacy username-only record) is withdrawn
 * too — the runtime also returns `fenced` for such a record while the store is degraded, and a
 * fence that cannot be read must never be assumed absent for anybody. `healthy` is deliberately
 * NOT used as proof that the store is writable.
 *
 * `transferSnapshot` is `provider.authorizationTransferSnapshot()`. An absent snapshot, or
 * `available: false` (no store configured), leaves the input untouched.
 */
export function applyAuthorizationTransferFence(snapshot, transferSnapshot = null) {
  const tokens = Array.isArray(snapshot?.tokens) ? snapshot.tokens : [];
  if (!transferSnapshot || transferSnapshot.available === false) return snapshot;
  const generations = new Map();
  for (const entry of Array.isArray(transferSnapshot.generations) ? transferSnapshot.generations : []) {
    if (typeof entry?.key === "string") generations.set(entry.key, normalizeGeneration(entry.generation));
  }
  const degraded = transferSnapshot.healthy === false;
  return {
    ...snapshot,
    tokens: tokens.map((token) => {
      if (token?.status !== ACTIVE_GRANT_STATUS) return token;
      // Degraded store: withdraw EVERYTHING first. Whether a pair can be matched is
      // irrelevant — `evaluateCredentialFence({ degraded: true })` is fenced for any
      // credential, so checking the pair first would leak a legacy pair-less grant.
      if (degraded) return { ...token, status: "revoked", transferFenced: true };
      const clientId = clientIdOf(token);
      const userId = userIdOf(token);
      // Legacy / unidentifiable grants carry no pair, exactly like the runtime's `no_pair` branch.
      if (!clientId || !userId) return token;
      const currentGeneration = generations.get(pairGenerationKey(clientId, userId)) ?? 0;
      if (normalizeGeneration(token.generation) === currentGeneration) return token;
      return { ...token, status: "revoked", transferFenced: true };
    }),
  };
}

function hasActiveGrantForClient(client, snapshot) {
  const clientId = clientIdOf(client);
  if (!clientId) return false;
  return activeGrants(snapshot).some((token) => clientIdOf(token) === clientId);
}

export function linkedOAuthAccountsForClient(client, snapshot = {}) {
  const clientId = clientIdOf(client);
  if (!clientId) return [];
  const { byId, byName } = indexAccounts(snapshot);
  const seen = new Set();
  const accounts = [];
  for (const token of activeGrants(snapshot)) {
    if (clientIdOf(token) !== clientId) continue;
    const userId = userIdOf(token);
    if (userId) {
      pushAccount(accounts, seen, byId.get(userId));
      continue;
    }
    const nameKey = usernameKeyOf(token);
    if (!nameKey || LEGACY_GRANT_USERNAMES.has(nameKey)) continue;
    pushAccount(accounts, seen, byName.get(nameKey));
  }
  return accounts;
}

export function linkedOAuthAccountLabel(client, snapshot = {}) {
  const accounts = linkedOAuthAccountsForClient(client, snapshot);
  if (accounts.length) return accounts.map(accountDisplay).join("、");
  return hasActiveGrantForClient(client, snapshot) ? UNKNOWN_ACCOUNT_LABEL : NO_ACTIVE_GRANT_LABEL;
}

export function linkedOAuthAccountCell(client, snapshot) {
  const accounts = linkedOAuthAccountsForClient(client, snapshot);
  if (accounts.length) return accounts.map(accountCell).join("<br>");
  const label = hasActiveGrantForClient(client, snapshot) ? UNKNOWN_ACCOUNT_LABEL : NO_ACTIVE_GRANT_LABEL;
  return `<span class="muted">${html(label)}</span>`;
}

export function countOAuthClientsForUser(user, snapshot = {}) {
  const userId = user?.id == null || user.id === "" ? "" : String(user.id);
  const username = String(user?.username || "").trim().toLowerCase();
  const clientIds = new Set();
  for (const token of activeGrants(snapshot)) {
    const clientId = clientIdOf(token);
    if (!clientId) continue;
    const tokenUserId = userIdOf(token);
    if (tokenUserId) {
      if (userId && tokenUserId === userId) clientIds.add(clientId);
      continue;
    }
    const nameKey = usernameKeyOf(token);
    if (!username || !nameKey || LEGACY_GRANT_USERNAMES.has(nameKey)) continue;
    if (nameKey === username) clientIds.add(clientId);
  }
  return clientIds.size;
}

export function oauthClientCountLabel(count) {
  return "已授权客户端 " + (Number(count) || 0) + " 个";
}

export function linkedOAuthClientsForUser(user, snapshot = {}) {
  const userId = user?.id == null || user.id === "" ? "" : String(user.id);
  const username = String(user?.username || "").trim().toLowerCase();
  const clients = Array.isArray(snapshot?.clients) ? snapshot.clients : [];
  const byId = new Map(clients.map((c) => [String(c.clientId || ""), c]));
  const clientIds = new Set();
  for (const token of activeGrants(snapshot)) {
    const clientId = clientIdOf(token);
    if (!clientId) continue;
    const tokenUserId = userIdOf(token);
    if (tokenUserId) {
      if (userId && tokenUserId === userId) clientIds.add(clientId);
      continue;
    }
    const nameKey = usernameKeyOf(token);
    if (!username || !nameKey || LEGACY_GRANT_USERNAMES.has(nameKey)) continue;
    if (nameKey === username) clientIds.add(clientId);
  }
  return [...clientIds].map((id) => byId.get(id)).filter(Boolean);
}
