import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { InvalidRequestError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { MCP_SCOPES, SCOPE_DEFINITIONS, normalizeScopes } from "../scopes.js";
import { configuredWebDefaultVault, configuredWebVaultsRoot } from "../config.js";
const scrypt = promisify(scryptCallback);

export const OAUTH_SCOPES = MCP_SCOPES;
export const DEFAULT_VAULT_ID = configuredWebVaultsRoot()
  ? (configuredWebDefaultVault() || "vault")
  : "default";
export const SCOPE_LABELS = Object.fromEntries(
  Object.entries(SCOPE_DEFINITIONS).map(([scope, item]) => [scope, [item.label, item.description]]),
);

export function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, saltValue, hashValue] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = Buffer.from(await scrypt(String(password), Buffer.from(saltValue, "base64url"), expected.length));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function validRedirectUri(value) {
  let uri;
  try { uri = new URL(value); } catch { return false; }
  if (uri.hash || uri.username || uri.password) return false;
  if (uri.protocol === "https:") return true;
  return uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname);
}

export function normalizedScopes(scopes, fallback = OAUTH_SCOPES) {
  try { return normalizeScopes(scopes, fallback); } catch { throw new InvalidScopeError("Unsupported OAuth scope"); }
}

export function normalizedVaults(vaults, fallback = [DEFAULT_VAULT_ID]) {
  const wanted = Array.isArray(vaults) && vaults.length ? vaults : fallback;
  const values = [...new Set(wanted.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!values.length || values.some((item) => item.length > 80 || /[\\/\0]/.test(item) || item === "." || item === "..")) {
    throw new InvalidRequestError("Invalid Vault access list");
  }
  if (configuredWebVaultsRoot() && values.length === 1 && values[0] === "default") return [DEFAULT_VAULT_ID];
  return values;
}

export function cleanUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@-]{2,63}$/.test(username)) {
    throw new InvalidRequestError("OAuth username must be 3-64 characters using letters, numbers, ., _, @ or -");
  }
  return username;
}

export function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 12 || password.length > 256) throw new InvalidRequestError("OAuth password must be 12-256 characters");
  return password;
}

export function sourceFromRequest(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

export function normalizeResource(value, allowedResources, fallbackResource) {
  const allowed = allowedResources instanceof Set
    ? allowedResources
    : new Set([...(allowedResources || [])].map((item) => new URL(item).href));
  const resource = value ? new URL(value) : new URL(fallbackResource);
  resource.hash = "";
  if (!allowed.has(resource.href)) throw new InvalidTargetError("OAuth resource does not match this MCP server");
  return resource;
}

export function resolvePublicOrigin(req, publicBaseUrls, fallback) {
  const urls = (publicBaseUrls || []).map((value) => String(value || "").replace(/\/+$/, "")).filter(Boolean);
  const forwarded = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = (forwarded || String(req?.headers?.host || "").trim()).toLowerCase();
  if (host) {
    const matched = urls.find((origin) => {
      try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
    });
    if (matched) return matched;
  }
  return String(fallback || urls[0] || "").replace(/\/+$/, "");
}
