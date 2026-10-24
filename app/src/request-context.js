import { AsyncLocalStorage } from "node:async_hooks";
import { identifyAgentFromUserAgent, requestUserAgent } from "./agent-identity.js";
import { getSessionAuthor } from "./session-author.js";

/** Sticky author key for hosts that open a new MCP session per tool call. */
export function authClientIdFromExtra(extra) {
  const id = extra?.authInfo?.clientId ?? extra?.authInfo?.extra?.clientId;
  const text = String(id ?? "").trim();
  return text || undefined;
}

export function authUserIdFromExtra(extra) {
  const id = extra?.authInfo?.userId ?? extra?.authInfo?.extra?.userId;
  const text = String(id ?? "").trim();
  return text || undefined;
}

const storage = new AsyncLocalStorage();
export const AUTHOR_META_KEY = "obsidian/author";

/** Client names that are placeholders, not useful attribution. */
const GENERIC_CLIENT_NAMES = new Set(["mcp-client", "mcp", "unknown", "generic", ""]);

export function cleanAuthorField(value, label) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 160 || /[\r\n\u0000]/.test(result)) throw new Error(`MCP author.${label} must be a non-empty single-line value (max 160 characters)`);
  return result;
}

export function isGenericClientName(name) {
  return GENERIC_CLIENT_NAMES.has(String(name ?? "").trim().toLowerCase());
}

/** McpServer does not expose getClientVersion; the underlying Server does. */
export function getInitializedClientInfo(server) {
  const client = server?.getClientVersion?.() || server?.server?.getClientVersion?.() || {};
  return { name: String(client.name || "").trim(), version: String(client.version || "").trim() };
}

export function resolveRequestAuthor(server, extra) {
  const metadata = extra?._meta || {};
  const raw = metadata[AUTHOR_META_KEY] || metadata["obsidian.author"] || metadata.author;
  const clientName = getInitializedClientInfo(server).name;
  const genericClient = isGenericClientName(clientName);
  const session = getSessionAuthor(extra?.sessionId, authClientIdFromExtra(extra));
  const userAgentAgent = identifyAgentFromUserAgent(requestUserAgent(extra));
  // Real clientInfo.name always wins for agent. Env default / session only
  // apply when the host used a generic placeholder (e.g. Cursor mcp-client).
  const fallback = raw && typeof raw === "object" ? raw : {
    agent: (!genericClient && clientName)
      || session?.agent
      || userAgentAgent
      || process.env.MCP_DEFAULT_AUTHOR_AGENT
      || clientName
      || "mcp-client",
    model: session?.model || process.env.MCP_DEFAULT_AUTHOR_MODEL || "unspecified",
  };
  const author = { agent: cleanAuthorField(fallback.agent, "agent"), model: cleanAuthorField(fallback.model, "model") };
  // Strict bind only when the host declared a real client identity.
  if (clientName && !genericClient && author.agent !== clientName) {
    throw new Error(`MCP author.agent must match initialized client name (${clientName})`);
  }
  return author;
}

export function withRequestContext(context, callback) {
  return storage.run(context, callback);
}

// Contract §6: the context also carries `vaultId` / `vaultRuntime` as ordinary keys (selection logic
// is Wave C). `withRequestContextPatch` merges `partial` over the ambient context: explicit values win,
// `undefined` never erases an outer field, and each scope gets a fresh object (no shared parent).
export function withRequestContextPatch(partial, callback) {
  const merged = { ...(storage.getStore() || {}) };
  for (const [key, value] of Object.entries(partial || {})) if (value !== undefined) merged[key] = value;
  return storage.run(merged, callback);
}

export function requestContext() {
  return storage.getStore();
}

export function requireRequestAuthor() {
  const author = requestContext()?.author;
  if (!author) throw new Error(`MCP writes require _meta["${AUTHOR_META_KEY}"] with agent and model`);
  return author;
}

export function stampFrontmatter(frontmatter, author) {
  return { ...(frontmatter || {}), mcp_author: { agent: author.agent, model: author.model } };
}
