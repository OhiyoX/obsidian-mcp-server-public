// Verifies that a direct/LAN caller cannot spoof its audit identity with X-Forwarded-For.
// Reads credentials from environment and never prints secrets, cookies, or response bodies.
import assert from "node:assert/strict";

const directBaseUrl = String(process.env.DIRECT_BASE_URL || "").replace(/\/+$/, "");
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const apiKey = process.env.API_KEY || "";
const adminPassword = process.env.OAUTH_ADMIN_PASSWORD || "";
const spoofedIp = `203.0.113.${100 + Math.floor(Math.random() * 100)}`;
assert.ok(directBaseUrl.startsWith("http://") && publicBaseUrl.startsWith("https://") && apiKey && adminPassword, "Verification environment is incomplete");

const initialized = await fetch(`${directBaseUrl}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-API-Key": apiKey,
    "X-Forwarded-For": spoofedIp,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "trust-proxy-spoof-test", version: "1" } } }),
  signal: AbortSignal.timeout(15_000),
});
assert.equal(initialized.status, 200, "Direct MCP verification request failed");
const session = initialized.headers.get("mcp-session-id");
await initialized.arrayBuffer();
if (session) {
  await fetch(`${directBaseUrl}/mcp`, { method: "DELETE", headers: { "Mcp-Session-Id": session, "X-API-Key": apiKey }, signal: AbortSignal.timeout(5_000) }).catch(() => {});
}

const login = await fetch(`${publicBaseUrl}/admin/auth/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: adminPassword }),
  signal: AbortSignal.timeout(15_000),
});
assert.equal(login.status, 303, "Authorization center login failed");
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
assert.ok(cookie, "Authorization center cookie missing");
const page = await fetch(`${publicBaseUrl}/admin/auth`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) });
assert.equal(page.status, 200, "Authorization center page unavailable");
assert.doesNotMatch(await page.text(), new RegExp(spoofedIp.replaceAll(".", "\\.")), "Untrusted direct caller spoofed its source IP");
console.log("Direct/LAN X-Forwarded-For spoof rejection: PASS");
