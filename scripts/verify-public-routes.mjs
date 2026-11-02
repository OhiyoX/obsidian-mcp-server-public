// Secret-free public edge route contract check.
import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
assert.match(baseUrl, /^https:\/\//, "Pass the public HTTPS origin as argv[2] or PUBLIC_BASE_URL");

async function request(path, { method = "GET", headers, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

async function expectStatus(path, expected, options) {
  const response = await request(path, options);
  assert.equal(response.status, expected, `${options?.method || "GET"} ${path} returned ${response.status}, expected ${expected}`);
  return response;
}

const protectedMcp = await (await expectStatus("/.well-known/oauth-protected-resource/mcp", 200)).json();
assert.equal(protectedMcp.resource, `${baseUrl}/mcp`);
assert.ok(protectedMcp.authorization_servers?.includes(`${baseUrl}/`));

const protectedRoot = await (await expectStatus("/.well-known/oauth-protected-resource", 200)).json();
assert.equal(protectedRoot.resource, `${baseUrl}/mcp`);

const authorization = await (await expectStatus("/.well-known/oauth-authorization-server", 200)).json();
assert.equal(authorization.issuer, `${baseUrl}/`);
assert.equal(authorization.authorization_endpoint, `${baseUrl}/oauth/authorize`);
assert.equal(authorization.token_endpoint, `${baseUrl}/oauth/token`);
assert.equal(authorization.registration_endpoint, `${baseUrl}/oauth/register`);
assert.equal(authorization.revocation_endpoint, `${baseUrl}/oauth/revoke`);

const invalidForm = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "" };
await expectStatus("/oauth/authorize", 400);
await expectStatus("/oauth/token", 400, invalidForm);
await expectStatus("/oauth/register", 400, invalidForm);
await expectStatus("/oauth/revoke", 400, invalidForm);
await expectStatus("/oauth/decision", 400, invalidForm);
await expectStatus("/authorize", 400);
for (const compatibilityPath of ["/token", "/register", "/revoke"]) await expectStatus(compatibilityPath, 400, invalidForm);
const legacyAdmin = await expectStatus("/admin", 302);
assert.equal(legacyAdmin.headers.get("location"), "/admin/auth");
const adminLogin = await expectStatus("/admin/auth/login", 200);
assert.match(adminLogin.headers.get("content-security-policy") || "", /img-src 'self'/);
assert.match(await adminLogin.text(), /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
await expectStatus("/auth/login", 200);
const anonymousApp = await expectStatus("/app", 303, { redirect: "manual" });
assert.equal(anonymousApp.headers.get("location"), "/auth/login");
await expectStatus("/api/web/v1/notes", 401);
// The Web explorer and search moved to /api/web/v2 (tree/search). The edge
// allowlist must forward both API versions; asserting only v1 let a v2-only
// regression reach production (2026-10-04, fixed in edge-portable).
await expectStatus("/api/web/v2/tree", 401);
await expectStatus("/api/web/v2/search", 401);
// Use a syntactically valid opaque ID so the edge allowlist forwards the
// request to the application. Malformed IDs are intentionally rejected by
// nginx before application security headers can be attached.
const missingPublish = await expectStatus(`/publish/${"A".repeat(43)}`, 404);
assert.match(missingPublish.headers.get("content-security-policy") || "", /script-src 'self'/);
await expectStatus("/mcp", 204, { method: "OPTIONS" });

const challenge = await expectStatus("/mcp", 401, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "public-route-contract", version: "1" } } }),
});
assert.match(challenge.headers.get("www-authenticate") || "", /oauth-protected-resource\/mcp/);

await expectStatus("/healthz", 404);
await expectStatus("/", 404);

console.log("Public Obsidian MCP edge route contract: PASS");
