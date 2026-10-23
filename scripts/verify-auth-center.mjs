// Run from the NAS Compose directory. Never prints passwords, API keys, tokens, cookies, or response bodies.
import assert from "node:assert/strict";
import fs from "node:fs";

const raw = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
function envValue(name) {
  return (raw.match(new RegExp(`^${name}\\s*=\\s*(.*)$`, "m"))?.[1] || "").trim().replace(/^(['"])(.*)\1$/, "$2");
}

const password = process.env.OAUTH_ADMIN_PASSWORD || envValue("OAUTH_ADMIN_PASSWORD");
const baseUrl = process.env.PUBLIC_BASE_URL || envValue("PUBLIC_BASE_URL");
assert.ok(password && baseUrl.startsWith("https://"), "OAuth admin environment is incomplete");

let cookie;
let csrf;
let managedKey;
let keyId;
let registeredClientId;

async function adminPage(path = "/admin/auth") {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "Authorization management page unavailable");
  const body = await response.text();
  csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "Admin CSRF token missing");
  return body;
}

async function adminPost(path, fields) {
  const body = new URLSearchParams({ csrf });
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
}

async function mcpCall(authKey, method, params, session) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": authKey, ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  return response;
}

try {
  const login = await fetch(`${baseUrl}/admin/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(login.status, 303, "Admin login failed");
  cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "Admin session cookie missing");
  const firstPage = await adminPage();
  assert.match(firstPage, /class="app-shell"/, "Authorization management v2 app-shell missing");
  assert.match(firstPage, /class="side-body/, "Authorization management left nav missing");
  assert.match(firstPage, /--font:Inter/, "Authorization center does not use the Inter font stack");
  const accountsPage = await adminPage("/admin/auth?tab=accounts");
  assert.match(accountsPage, /OAuth 账户/, "OAuth account management section missing");
  assert.match(accountsPage, /name="allowedScope"/, "OAuth account scope controls missing");
  assert.match(accountsPage, /class="scope-option"/, "OAuth account scopes do not use the compact checkbox control");
  assert.match(accountsPage, /class="card create-panel"/, "OAuth account creation is not compact/collapsible");
  assert.doesNotMatch(accountsPage, /translateX\(/, "OAuth account scopes still use slider controls");
  const tokensPage = await adminPage("/admin/auth?tab=tokens&order=asc");
  assert.match(tokensPage, /oauth\/token\/cleanup/, "Inactive OAuth token cleanup control missing");
  assert.match(tokensPage, /value="asc" selected/, "OAuth token creation-time sort control missing");
  assert.match(tokensPage, /绑定域名/, "OAuth token resource-domain column missing");
  const auditPage = await adminPage("/admin/auth?tab=audit&origin=obsidian");
  assert.match(auditPage, /name="origin" value="obsidian"/, "Audit domain filter missing");
  const keysPage = await adminPage("/admin/auth?tab=keys");
  assert.match(keysPage, /name="allowedVault"/, "API key Vault controls missing");
  const defaultVault = keysPage.match(/name="allowedVault" value="([^"]+)" checked/)?.[1];
  assert.ok(defaultVault, "Default API key Vault was not selected");
  const staleSmokeKeyIds = [...keysPage.matchAll(/<tr><td><strong>deployment-smoke-[^<]*<\/strong>[\s\S]*?name="id" value="([0-9a-f-]{36})"/g)].map((match) => match[1]);
  for (const staleId of staleSmokeKeyIds) {
    const staleDeleted = await adminPost("/admin/auth/api-key/delete", { id: staleId });
    assert.equal(staleDeleted.status, 303, "Stale deployment smoke API key cleanup failed");
  }

  const challenge = await mcpCall("", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scope-challenge-smoke", version: "1" } });
  assert.equal(challenge.status, 401, "Unauthenticated MCP request did not return 401");
  assert.match(challenge.headers.get("www-authenticate") || "", /scope="obsidian\.read obsidian\.write obsidian\.files"/, "Initial OAuth challenge does not request full connector scopes");

  const registered = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "deployment OAuth UI smoke", redirect_uris: ["https://example.com/oauth/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(registered.status, 201, "Dynamic OAuth client registration failed");
  registeredClientId = (await registered.json()).client_id;
  assert.ok(registeredClientId, "Dynamic OAuth client id missing");
  const clientsPage = await adminPage("/admin/auth?tab=clients");
  assert.match(clientsPage, /连接域名/, "OAuth client connection-domain column missing");
  assert.match(clientsPage, new RegExp(new URL(baseUrl).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "OAuth registration domain missing from client inventory");
  assert.match(clientsPage, />注册<\/span>/, "OAuth registration origin is not labeled");
  const authorizationUrl = new URL(`${baseUrl}/authorize`);
  authorizationUrl.search = new URLSearchParams({ response_type: "code", client_id: registeredClientId, redirect_uri: "https://example.com/oauth/callback", code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", code_challenge_method: "S256", state: "deployment-smoke", resource: `${baseUrl}/mcp`, scope: "obsidian.read obsidian.write obsidian.files" });
  const consent = await fetch(authorizationUrl, { signal: AbortSignal.timeout(15_000) });
  assert.equal(consent.status, 200, "OAuth consent page unavailable");
  const consentHtml = await consent.text();
  assert.match(consentHtml, /name="username"/, "OAuth consent does not use an account username");
  assert.doesNotMatch(consentHtml, /管理员授权密码/, "OAuth consent still asks for the administrator password");
  assert.equal((consentHtml.match(/name="scope"/g) || []).length, 3, "OAuth consent does not expose all three adjustable scopes");
  assert.match(consentHtml, /ui-sans-serif/, "OAuth consent does not use the system sans-serif stack");
  assert.doesNotMatch(consentHtml, /translateX\(/, "OAuth consent scopes still use slider controls");
  assert.doesNotMatch(consentHtml, /box-shadow:0 20px|#6d28d9/, "OAuth consent still uses the previous decorative theme");

  const label = `deployment-smoke-${Date.now()}`;
  const created = await adminPost("/admin/auth/api-key/create", { label, allowedScope: ["obsidian.read", "obsidian.write", "obsidian.files"], allowedVault: defaultVault });
  assert.equal(created.status, 303, "Managed API key creation failed");
  const createdPage = await adminPage("/admin/auth?tab=keys");
  managedKey = createdPage.match(/obmcp_[0-9a-f]{12}_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(managedKey, "One-time managed API key was not displayed");
  const row = createdPage.slice(createdPage.indexOf(label));
  keyId = row.match(/name="id" value="([0-9a-f-]{36})"/)?.[1];
  assert.ok(keyId, "Managed API key id was not found");

  const initialized = await mcpCall(managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auth-center-smoke", version: "1" } });
  assert.equal(initialized.status, 200, "Managed API key could not initialize MCP");
  const session = initialized.headers.get("mcp-session-id");
  assert.ok(session, "Managed API key MCP session id missing");

  const writeOnly = await adminPost("/admin/auth/api-key/scopes", { id: keyId, allowedScope: "obsidian.write", allowedVault: defaultVault });
  assert.equal(writeOnly.status, 303, "Managed API key read Scope removal failed");
  const deniedRead = await mcpCall(managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "no-read-scope-smoke", version: "1" } });
  assert.equal(deniedRead.status, 403, "Managed API key without read Scope could initialize MCP");
  assert.equal((await deniedRead.json()).error, "insufficient_scope", "Missing read Scope returned the wrong error");

  const readOnly = await adminPost("/admin/auth/api-key/scopes", { id: keyId, allowedScope: "obsidian.read", allowedVault: defaultVault });
  assert.equal(readOnly.status, 303, "Managed API key Scope narrowing failed");
  const readOnlyInit = await mcpCall(managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "read-only-scope-smoke", version: "1" } });
  assert.equal(readOnlyInit.status, 200, "Read-only managed API key could not initialize MCP");
  const deniedWrite = await mcpCall(managedKey, "tools/call", { name: "write_note", arguments: { path: "scope-smoke-must-not-exist.md", content: "denied", overwrite: false } }, readOnlyInit.headers.get("mcp-session-id"));
  assert.equal(deniedWrite.status, 403, "Read-only managed API key was allowed to write");
  assert.equal((await deniedWrite.json()).error, "insufficient_scope", "Missing write Scope returned the wrong error");

  const readWrite = await adminPost("/admin/auth/api-key/scopes", { id: keyId, allowedScope: ["obsidian.read", "obsidian.write"], allowedVault: defaultVault });
  assert.equal(readWrite.status, 303, "Managed API key files Scope removal failed");
  const noFilesInit = await mcpCall(managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "no-files-scope-smoke", version: "1" } });
  assert.equal(noFilesInit.status, 200, "Managed API key without files Scope could not initialize MCP");
  const deniedFiles = await mcpCall(managedKey, "tools/call", { name: "start_file_upload", arguments: { path: "scope-smoke-must-not-upload.bin", totalBytes: 1 } }, noFilesInit.headers.get("mcp-session-id"));
  assert.equal(deniedFiles.status, 403, "Managed API key without files Scope could start an upload");
  assert.equal((await deniedFiles.json()).error, "insufficient_scope", "Missing files Scope returned the wrong error");

  const wrongVault = await adminPost("/admin/auth/api-key/scopes", { id: keyId, allowedScope: "obsidian.read", allowedVault: "scope-smoke-unmounted" });
  assert.equal(wrongVault.status, 303, "Managed API key Vault narrowing failed");
  const deniedVault = await mcpCall(managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vault-scope-smoke", version: "1" } });
  assert.equal(deniedVault.status, 403, "Managed API key without the mounted Vault was accepted");

  const deleted = await adminPost("/admin/auth/api-key/delete", { id: keyId });
  assert.equal(deleted.status, 303, "Managed API key deletion failed");
  keyId = null;
  const rejected = await mcpCall(managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deleted-key-smoke", version: "1" } });
  assert.equal(rejected.status, 401, "Deleted managed API key was still accepted");
  managedKey = null;
  const deletedClient = await adminPost("/admin/auth/oauth/client/delete", { clientId: registeredClientId });
  assert.equal(deletedClient.status, 303, "OAuth smoke client cleanup failed");
  registeredClientId = null;
  console.log("Public auth center, OAuth, API key read/write/files/Vault denial matrix, lifecycle and cleanup: PASS");
} finally {
  if (keyId && cookie && csrf) await adminPost("/admin/auth/api-key/delete", { id: keyId }).catch(() => {});
  if (registeredClientId && cookie && csrf) await adminPost("/admin/auth/oauth/client/delete", { clientId: registeredClientId }).catch(() => {});
}
