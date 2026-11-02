import { parseBool, parseInteger } from "./config.js";
import { clampSessionRecoveryMaxInFlight, normalizeSessionRecoveryMode } from "./mcp-session-recovery.js";

export const PORT = parseInteger(process.env.PORT || process.env.MCP_PORT, 18923);
export const HOST = process.env.HOST || "0.0.0.0";
export const MCP_PATH = process.env.MCP_PATH || "/mcp";
export const MCP_SERVER_NAME = process.env.MCP_SERVER_NAME || "obsidian-mcp-server";
export const MCP_SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
export const PROTECT_HEALTH = parseBool(process.env.PROTECT_HEALTH || "false");
export const JSON_LIMIT = process.env.JSON_LIMIT || "25mb";
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
export const TRUST_PROXY = (() => {
  const value = String(process.env.TRUST_PROXY || "").trim();
  if (!value || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") throw new Error("TRUST_PROXY=true is not allowed; configure an explicit proxy IP, subnet, or named range");
  return value;
})();
// Idle lifetime of an in-memory MCP session. Each live session holds a full MCP
// server (~3.7 MB RSS measured over 50 sessions on the 86-tool catalog), so a
// longer default is a capacity decision: land a session cap before raising it.
// Hosts that outlive the TTL no longer fail; stale-session recovery answers them.
export const SESSION_TTL_MS = parseInteger(process.env.SESSION_TTL_MS, 30 * 60 * 1000);
// `off` keeps the strict Streamable HTTP answer (404 until the client
// re-initializes); `stateless` answers a stale session id once, without state.
export const MCP_SESSION_RECOVERY = normalizeSessionRecoveryMode(process.env.MCP_SESSION_RECOVERY);
export const MCP_SESSION_RECOVERY_MAX_INFLIGHT = clampSessionRecoveryMaxInFlight(process.env.MCP_SESSION_RECOVERY_MAX_INFLIGHT);
export const OAUTH_ENABLED = parseBool(process.env.OAUTH_ENABLED || "false");
export const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
export const PUBLIC_BASE_URL_ALIASES = String(process.env.PUBLIC_BASE_URL_ALIASES || "")
  .split(/[\s,]+/)
  .map((value) => String(value || "").trim().replace(/\/+$/, ""))
  .filter(Boolean);
export const PUBLIC_BASE_URLS = [...new Set([PUBLIC_BASE_URL, ...PUBLIC_BASE_URL_ALIASES].filter(Boolean))];
export const OAUTH_ADMIN_PASSWORD = process.env.OAUTH_ADMIN_PASSWORD || "";
export const OAUTH_INITIAL_USERNAME = process.env.OAUTH_INITIAL_USERNAME || "";
export const OAUTH_INITIAL_PASSWORD = process.env.OAUTH_INITIAL_PASSWORD || "";
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = Math.max(300, parseInteger(process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3600));
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = Math.max(3600, parseInteger(process.env.OAUTH_REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60));
export const OAUTH_REFRESH_REUSE_GRACE_SECONDS = Math.max(0, Math.min(120, parseInteger(process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS, 30)));
export const AUTH_AUDIT_MAX_ENTRIES = Math.max(100, Math.min(20_000, parseInteger(process.env.AUTH_AUDIT_MAX_ENTRIES, 2000)));
export const AUTH_ADMIN_SESSION_TTL_SECONDS = Math.max(300, parseInteger(process.env.AUTH_ADMIN_SESSION_TTL_SECONDS, 3600));
// AuthZ time-window access control (issue 269). Single flag, off by default;
// Stage 0 is inert. Wave C reads this when it wires the policy runtime.
export const AUTHZ_ENABLED = parseBool(process.env.AUTHZ_ENABLED || "false");
