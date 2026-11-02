// Per-MCP-session clientInfo registry (issue #285, dev contract §7.1).
//
// `requestUsage()` runs in the HTTP auth layer, where only the `mcp-session-id`
// header is visible. The authoritative MCP `clientInfo` name/version exists only
// after the `initialize` request reached the MCP server, so the audit needs a
// bridge between those two lifecycle points.
//
// This registry is process-local and never persisted (audit rows are the durable
// record, not a session→identity database). It is keyed by BOTH the MCP session
// id and the authenticated client id: one API Key may be shared by several agents,
// so a credential-wide "last clientInfo" would mis-attribute sessions. Every
// lookup fails closed when either part is missing or unknown, entries expire on
// the same idle threshold as the MCP session TTL, and a full registry evicts the
// oldest entry so a miss only ever degrades attribution.
//
// The hook is called from `auth.js` for the request whose own body carries the
// initialize declaration: the session id is assigned by the transport while the
// response is written, so the entry is recorded on `finish`.

import { SESSION_TTL_MS } from "./server-config.js";
import { isGenericClientName } from "./request-context.js";
import { preferAgentAttribution } from "./request-attribution.js";

export const SESSION_CLIENT_INFO_MAX_ENTRIES = 500;

const entries = new Map();
let maxEntries = SESSION_CLIENT_INFO_MAX_ENTRIES;
let idleTtlMs = SESSION_TTL_MS;

function keyFor(sessionId, authClientId) {
  const session = String(sessionId ?? "").trim();
  const client = String(authClientId ?? "").trim();
  return session && client ? `${session}\u0000${client}` : null;
}

function evictOldest() {
  let oldestKey = null;
  let oldestSeen = Infinity;
  for (const [key, entry] of entries) {
    if (entry.lastSeenAt < oldestSeen) {
      oldestSeen = entry.lastSeenAt;
      oldestKey = key;
    }
  }
  if (oldestKey) entries.delete(oldestKey);
}

/** Records (or refreshes) the clientInfo declared for one session + credential. */
export function recordSessionClientInfo(sessionId, authClientId, clientInfo) {
  const key = keyFor(sessionId, authClientId);
  const name = String(clientInfo?.name ?? "").trim();
  if (!key || !name || isGenericClientName(name)) return false;
  const now = Date.now();
  for (const [existingKey, entry] of entries) {
    if (now - entry.lastSeenAt >= idleTtlMs) entries.delete(existingKey);
  }
  if (!entries.has(key) && entries.size >= maxEntries) evictOldest();
  entries.set(key, {
    name,
    version: String(clientInfo?.version ?? "").trim() || null,
    recordedAt: now,
    lastSeenAt: now,
  });
  return true;
}

/** Returns the current session's clientInfo, or undefined when it is not provable. */
export function getSessionClientInfo(sessionId, authClientId) {
  const key = keyFor(sessionId, authClientId);
  if (!key) return undefined;
  const entry = entries.get(key);
  if (!entry) return undefined;
  const now = Date.now();
  if (now - entry.lastSeenAt >= idleTtlMs) {
    entries.delete(key);
    return undefined;
  }
  entry.lastSeenAt = now;
  return { name: entry.name, version: entry.version };
}

/**
 * Drops every entry for one session. Exported for the session-close/revoke wiring
 * in `mcp-sessions.js`, which is outside this lane's owner set; until that is
 * wired the idle TTL and the credential-bound key keep lookups fail-closed.
 */
export function clearSessionClientInfo(sessionId) {
  const session = String(sessionId ?? "").trim();
  if (!session) return;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(`${session}\u0000`)) entries.delete(key);
  }
}

/** Records the initialize declaration once the transport has assigned a session id. */
export function registerSessionClientInfoFromRequest(req, res, clientInfo) {
  if (!req || !res || !clientInfo?.name || typeof res.on !== "function") return;
  res.on("finish", () => {
    let sessionId = null;
    try {
      sessionId = res.getHeader?.("mcp-session-id") ?? null;
    } catch {
      sessionId = null;
    }
    if (Array.isArray(sessionId)) sessionId = sessionId[0];
    recordSessionClientInfo(sessionId, req.auth?.clientId, clientInfo);
  });
}

function sessionIdFrom(req) {
  const value = req?.headers?.["mcp-session-id"];
  return value == null ? "" : (Array.isArray(value) ? String(value[0] ?? "") : String(value));
}

/**
 * Upgrades an audit usage envelope to the current session's `clientInfo` when the
 * (sessionId, authClientId) pair proves the association. Enrichment only, at the
 * existing commit point: a miss degrades the row, it never delays the response or
 * rewrites the truthful `usageDeferral` outcome.
 */
export function applySessionClientInfo(usage, req) {
  const clientInfo = getSessionClientInfo(sessionIdFrom(req), req?.auth?.clientId);
  if (!clientInfo) return;
  Object.assign(usage, preferAgentAttribution(usage, {
    agent: clientInfo.name,
    agentSource: "clientInfo",
    clientInfoName: clientInfo.name,
    clientInfoVersion: clientInfo.version,
  }));
}

/** Sets the verified credential and enriches usage in one step, so no branch can miss it. */
export function attachSessionAuth(req, usage, auth) {
  req.auth = auth;
  applySessionClientInfo(usage, req);
}

/** Test helper. */
export function resetSessionClientInfoForTests() {
  entries.clear();
  maxEntries = SESSION_CLIENT_INFO_MAX_ENTRIES;
  idleTtlMs = SESSION_TTL_MS;
}

/** Test helper: tighten the bound / idle threshold deterministically. */
export function configureSessionClientInfoForTests({ maxEntries: limit, idleTtlMs: ttl } = {}) {
  if (Number.isInteger(limit) && limit > 0) maxEntries = limit;
  if (Number.isInteger(ttl) && ttl > 0) idleTtlMs = ttl;
}
