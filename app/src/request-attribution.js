// Request-level audit attribution (issue #285).
//
// Everything here is a pure classification/derivation helper: nothing
// authenticates, authorizes or persists. Two questions are answered per audit row:
//
//   * WHO — the agent shown for a request, together with `agentSource`, which
//     records WHY that value won (clientInfo > meta > session > apiKeyLabel > ua);
//   * WHERE — the final adopted `source` split from the direct peer, the raw
//     Forwarded chain and whether a configured trust-proxy hop was used.
//
// UA data is untrusted and only ever feeds display/diagnostics: no function in
// this module may be used for Scope, Vault, AuthZ or allow/deny decisions.

import { classifyGenericUserAgent, identifyAgentFromUserAgent } from "./agent-identity.js";
import { isGenericClientName } from "./request-context.js";
import { getSessionAuthor } from "./session-author.js";

const AUTHOR_META_KEY = "obsidian/author";
const AUDIT_FIELD_MAX = 240;
const ADDRESS_MAX = 80;
const AGENT_MAX = 160;
const LABEL_MAX = 120;

/** Raw `X-Forwarded-For` entries kept for diagnostics before the explicit truncation. */
export const FORWARDED_CHAIN_MAX_HOPS = 8;

/** Same normalization as the existing `requestUsage()` helper (no trimming). */
export function cleanAuditValue(value, max = AUDIT_FIELD_MAX) {
  return String(value || "").replace(/[\r\n\0]/g, " ").slice(0, max) || null;
}

function headerText(headers, name) {
  if (!headers) return "";
  const wanted = name.toLowerCase();
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  if (Array.isArray(value)) return value.join(", ");
  return value == null ? "" : String(value);
}

function auditMessages(body) {
  if (Array.isArray(body)) return body;
  return body ? [body] : [];
}

/** Agent fields are single-line and trimmed; empty/whitespace is no identity. */
function cleanAgentValue(value, max = AGENT_MAX) {
  const text = String(value ?? "").replace(/[\r\n\0]/g, " ").trim();
  return text.slice(0, max) || null;
}

// ---------------------------------------------------------------------------
// Agent attribution layers
// ---------------------------------------------------------------------------

/**
 * Lower rank wins.
 *
 * `clientInfo` is the MCP `initialize` declaration bound to the current
 * session/request; `apiKeyLabel` is the administrator-written remark and sits
 * below a declared session identity but above the UA hint.
 */
export const AGENT_SOURCE_PRIORITY = Object.freeze({
  clientInfo: 0,
  meta: 1,
  session: 2,
  apiKeyLabel: 3,
  ua: 4,
  none: 5,
});

const EMPTY_ATTRIBUTION = Object.freeze({ agent: null, agentSource: "none", clientInfoName: null, clientInfoVersion: null });

function attributionLayer(agent, agentSource, extra = {}) {
  const value = cleanAgentValue(agent);
  if (!value) return null;
  return { agent: value, agentSource, clientInfoName: null, clientInfoVersion: null, ...extra };
}

function normalizeAttribution(value) {
  if (!value?.agent) return { ...EMPTY_ATTRIBUTION };
  return {
    agent: String(value.agent),
    agentSource: AGENT_SOURCE_PRIORITY[value.agentSource] === undefined ? "none" : value.agentSource,
    clientInfoName: value.clientInfoName ?? null,
    clientInfoVersion: value.clientInfoVersion ?? null,
  };
}

/**
 * Priority-ordered resolution: `clientInfo > meta > session > apiKeyLabel > ua`.
 * Placeholder client names (`mcp-client`, …) are not an identity and are skipped.
 */
export function resolveAgentAttribution({ clientInfoName, clientInfoVersion, metaAgent, sessionAgent, apiKeyLabel, uaAgent } = {}) {
  const clientInfo = isGenericClientName(clientInfoName) ? null : attributionLayer(clientInfoName, "clientInfo", {
    clientInfoName: cleanAgentValue(clientInfoName),
    clientInfoVersion: cleanAgentValue(clientInfoVersion),
  });
  const candidates = [
    clientInfo,
    attributionLayer(metaAgent, "meta"),
    attributionLayer(sessionAgent, "session"),
    attributionLayer(apiKeyLabel, "apiKeyLabel"),
    attributionLayer(uaAgent, "ua"),
  ].filter(Boolean);
  return normalizeAttribution(candidates[0]);
}

/** Keeps `current` unless `candidate` sits at a strictly higher-priority layer. */
export function preferAgentAttribution(current, candidate) {
  const kept = normalizeAttribution(current);
  const preferred = normalizeAttribution(candidate);
  if (!preferred.agent) return kept;
  const keptRank = AGENT_SOURCE_PRIORITY[kept.agentSource] ?? AGENT_SOURCE_PRIORITY.none;
  const preferredRank = AGENT_SOURCE_PRIORITY[preferred.agentSource] ?? AGENT_SOURCE_PRIORITY.none;
  return preferredRank < keptRank ? preferred : kept;
}

/** API Key `label` fallback; never outranks session/clientInfo attribution. */
export function attributeApiKeyLabel(usage, label) {
  const candidate = attributionLayer(label, "apiKeyLabel");
  if (!candidate) return usage;
  return { ...usage, ...preferAgentAttribution(usage, candidate) };
}

/** `clientInfo` declared in the request's own MCP `initialize` body. */
export function bodyClientInfo(body) {
  const message = auditMessages(body).find((item) => item?.method === "initialize");
  const clientInfo = message?.params?.clientInfo;
  if (!clientInfo || typeof clientInfo !== "object") return null;
  const name = cleanAgentValue(clientInfo.name);
  if (!name) return null;
  return { name, version: cleanAgentValue(clientInfo.version) };
}

/** `_meta["obsidian/author"].agent` declared on the current request. */
export function bodyMetaAgent(body) {
  for (const message of auditMessages(body)) {
    const metadata = message?.params?._meta;
    if (!metadata || typeof metadata !== "object") continue;
    const raw = metadata[AUTHOR_META_KEY] || metadata["obsidian.author"] || metadata.author;
    const agent = raw && typeof raw === "object" ? raw.agent : raw;
    const cleaned = cleanAgentValue(agent);
    if (cleaned) return cleaned;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source attribution
// ---------------------------------------------------------------------------

/** Canonical form used only for comparison/classification, never written to audit. */
export function normalizeAddress(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  const bracketed = text.startsWith("[") ? text.slice(1, text.indexOf("]") === -1 ? undefined : text.indexOf("]")) : text;
  return bracketed.startsWith("::ffff:") ? bracketed.slice("::ffff:".length) : bracketed;
}

export function isLoopbackAddress(value) {
  const text = normalizeAddress(value);
  if (!text) return false;
  if (text === "::1" || text === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text);
}

/** Bounded, cleaned raw `X-Forwarded-For`; overflow is reported, never silent. */
export function boundedForwardedChain(raw, maxHops = FORWARDED_CHAIN_MAX_HOPS) {
  const parts = String(raw ?? "")
    .split(",")
    .map((item) => cleanAuditValue(item, ADDRESS_MAX)?.trim())
    .filter(Boolean);
  return { chain: parts.slice(0, maxHops), truncated: parts.length > maxHops };
}

function trustProxySetting(req) {
  try {
    const value = req?.app?.get?.("trust proxy");
    return value === undefined || value === null || value === false ? null : String(value);
  } catch {
    return null;
  }
}

/**
 * Splits the final adopted address from its provenance.
 *
 * `source` keeps its existing meaning (`req.ip`, i.e. Express with the configured
 * trust-proxy predicate already applied), so audit filters and the credential
 * linkage do not change. `sourceTrusted` is true only when Express adopted an
 * address other than the direct peer — which is exactly the case in which a
 * configured proxy hop was actually consumed. Raw XFF on an untrusted peer never
 * changes `source`, it is only recorded and marked `untrusted-forwarded`.
 */
export function requestSourceAttribution(req) {
  const source = cleanAuditValue(req?.ip || req?.socket?.remoteAddress, ADDRESS_MAX);
  const sourcePeer = cleanAuditValue(req?.socket?.remoteAddress, ADDRESS_MAX);
  const { chain: forwardedChain, truncated: forwardedChainTruncated } = boundedForwardedChain(headerText(req?.headers, "x-forwarded-for"));
  const sourceTrusted = Boolean(source && sourcePeer && normalizeAddress(source) !== normalizeAddress(sourcePeer));
  const trustedSetting = trustProxySetting(req);
  let sourceKind = "direct";
  if (sourceTrusted) sourceKind = "trusted-proxy";
  else if (forwardedChain.length) sourceKind = "untrusted-forwarded";
  else if (isLoopbackAddress(source)) sourceKind = "loopback";
  return {
    source,
    sourcePeer,
    forwardedChain,
    forwardedChainTruncated,
    sourceTrusted,
    sourceTrustedEntry: sourceTrusted ? (cleanAuditValue(trustedSetting, LABEL_MAX) || "configured") : "none",
    sourceKind,
  };
}

// ---------------------------------------------------------------------------
// Usage envelope
// ---------------------------------------------------------------------------

/**
 * Builds the audit envelope for one HTTP request.
 *
 * `clientInfo` here is the request's own `initialize` declaration; for later
 * `tools/call` requests the session-bound clientInfo is layered on by
 * `auth.js`/`oauth-provider.js` at their existing commit points (no extra write
 * path, no delayed enrichment).
 */
export function buildRequestUsage(req) {
  const messages = auditMessages(req?.body);
  const methods = messages.map((message) => message?.method).filter(Boolean);
  const tools = messages.filter((message) => message?.method === "tools/call").map((message) => message?.params?.name).filter(Boolean);
  const userAgent = cleanAuditValue(headerText(req?.headers, "user-agent"), AUDIT_FIELD_MAX);
  const sessionId = headerText(req?.headers, "mcp-session-id").trim();
  const session = sessionId ? getSessionAuthor(sessionId) : undefined;
  const clientInfo = bodyClientInfo(req?.body);
  const attribution = resolveAgentAttribution({
    clientInfoName: clientInfo?.name,
    clientInfoVersion: clientInfo?.version,
    metaAgent: bodyMetaAgent(req?.body),
    sessionAgent: session?.agent,
    uaAgent: identifyAgentFromUserAgent(userAgent),
  });
  return {
    action: tools.length ? `mcp.tool.${tools.join(",")}` : `mcp.${methods.join(",") || String(req?.method || "").toLowerCase()}`,
    method: cleanAuditValue(methods.join(","), 160),
    tool: cleanAuditValue(tools.join(","), 200),
    ...requestSourceAttribution(req),
    userAgent,
    genericClient: classifyGenericUserAgent(userAgent),
    ...attribution,
  };
}
