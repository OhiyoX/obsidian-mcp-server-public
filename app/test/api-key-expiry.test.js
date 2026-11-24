import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-key-expiry-"));
process.env.DATA_PATH = root;
process.env.PUBLIC_BASE_URL = "http://localhost:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "test-owner";
process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.WEB_DEFAULT_VAULT = "default";

const { createOAuthService: createOAuthServiceRaw } = await import("../src/oauth-provider.js");
const { apiKeyExpired, keyExpiryState, resolveKeyExpiry } = await import("../src/api-key-expiry.js");
const providers = new Set();

function createOAuthService() {
  const service = createOAuthServiceRaw();
  providers.add(service.provider);
  return service;
}

// A second provider over the same DATA_PATH reads the same oauth/state.json.
function createProvider() {
  const service = createOAuthServiceRaw();
  providers.add(service.provider);
  return service.provider;
}

after(async () => {
  for (const provider of providers) await provider.drainPersistence();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('an expired managed key is refused by both verify paths', async () => {
  const service = createOAuthService();
  const created = await service.provider.createApiKey('expired', undefined, undefined, null, '2020-01-01T00:00:00.000Z');
  assert.equal(created.expiresAt, '2020-01-01T00:00:00.000Z');
  await assert.rejects(() => service.provider.verifyApiKey(created.secret), /API key expired/);
  await assert.rejects(() => service.provider.verifyApiKeyDeferred(created.secret), /API key expired/);
  const snapshot = await service.provider.authorizationSnapshot();
  assert.ok(snapshot.apiKeys.some((item) => item.id === created.id), 'the record stays for audit');
});

test('a key without expiry and a future expiry both verify', async () => {
  const service = createOAuthService();
  const forever = await service.provider.createApiKey('forever');
  assert.equal(forever.expiresAt, null);
  assert.equal((await service.provider.verifyApiKey(forever.secret)).keyId, forever.id);
  const later = await service.provider.createApiKey('later', undefined, undefined, null, new Date(Date.now() + 86400000).toISOString());
  assert.equal((await service.provider.verifyApiKeyDeferred(later.secret)).keyId, later.id);
});

test('updateApiKey never rewrites expiresAt', async () => {
  const service = createOAuthService();
  const created = await service.provider.createApiKey('keep', undefined, undefined, null, new Date(Date.now() + 86400000).toISOString());
  const updated = await service.provider.updateApiKey(created.id, { allowedScopes: ['obsidian.read'], expiresAt: null });
  assert.equal(updated.expiresAt, created.expiresAt);
});

test('expiresAt survives a save and reload of the store', async () => {
  const service = createOAuthService();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const created = await service.provider.createApiKey('persisted', undefined, undefined, null, expiresAt);
  await service.provider.drainPersistence();

  const reloaded = createProvider();
  const snapshot = await reloaded.authorizationSnapshot();
  const record = snapshot.apiKeys.find((item) => item.id === created.id);
  assert.ok(record, 'the key is visible to a provider built over the same data file');
  assert.equal(record.expiresAt, expiresAt);
  assert.equal((await reloaded.verifyApiKey(created.secret)).keyId, created.id);
});

test('a key expires exactly at expiresAt, not a millisecond later', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.equal(apiKeyExpired({ expiresAt: '2030-01-01T00:00:00.000Z' }, now), true);
  assert.equal(apiKeyExpired({ expiresAt: '2030-01-01T00:00:00.001Z' }, now), false);
});

const fixed = Date.parse('2026-11-18T12:00:00.000Z');
test('resolveKeyExpiry maps the choice list, the date and the two errors', () => {
  assert.equal(resolveKeyExpiry('never', '', fixed), null);
  assert.equal(resolveKeyExpiry(undefined, '', fixed), null);
  assert.equal(resolveKeyExpiry('7', '', fixed), new Date(fixed + 7 * 86400000).toISOString());
  assert.equal(resolveKeyExpiry('90', '', fixed), new Date(fixed + 90 * 86400000).toISOString());
  assert.equal(resolveKeyExpiry('never', '2026-12-01', fixed), '2026-12-01T23:59:59.999Z');
  // 选项与日期同时给：日期优先（表单里两者会同时出现）。
  assert.equal(resolveKeyExpiry('7', '2026-12-01', fixed), '2026-12-01T23:59:59.999Z');
  // 今天的日期按日末算，今天选今天不得算过期。
  assert.equal(resolveKeyExpiry('never', '2026-11-18', fixed), '2026-11-18T23:59:59.999Z');
  assert.throws(() => resolveKeyExpiry('never', '01/12/2026', fixed), /expiry_invalid/);
  assert.throws(() => resolveKeyExpiry('never', '2026-11-17', fixed), /expiry_past/);
});

// The store trusts expiresAt, so this boundary must not let a value out that apiKeyExpired would
// read as "never expires".
test('resolveKeyExpiry refuses a day that does not exist and a forged choice', () => {
  assert.throws(() => resolveKeyExpiry('never', '2027-02-30', fixed), /expiry_invalid/);
  assert.throws(() => resolveKeyExpiry('never', '2026-12-01T00:00:00Z', fixed), /expiry_invalid/);
  assert.throws(() => resolveKeyExpiry('1', '', fixed), /expiry_invalid/);
  assert.throws(() => resolveKeyExpiry(7, '', fixed), /expiry_invalid/);
});

test("keyExpiryState names never, active, today and expired", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  assert.deepEqual(keyExpiryState(null, now), { kind: "never", days: null });
  assert.deepEqual(keyExpiryState("2026-11-20T12:00:00.000Z", now), { kind: "active", days: 2 });
  assert.deepEqual(keyExpiryState("2026-11-18T18:00:00.000Z", now), { kind: "today", days: 1 });
  assert.deepEqual(keyExpiryState("2026-11-18T11:00:00.000Z", now), { kind: "expired", days: null });
  // A corrupt record must read as expired, never as permanent.
  assert.deepEqual(keyExpiryState("not-a-date", now), { kind: "expired", days: null });
});

test("an expired refusal leaves no usage stamp and no success audit", async () => {
  const service = createOAuthService();
  const created = await service.provider.createApiKey("trace", undefined, undefined, null, "2020-01-01T00:00:00.000Z");
  await assert.rejects(() => service.provider.verifyApiKey(created.secret, { source: "127.0.0.1", action: "mcp.call" }), /API key expired/);
  const snapshot = await service.provider.authorizationSnapshot();
  const record = snapshot.apiKeys.find((item) => item.id === created.id);
  assert.equal(record.lastUsedAt, null, "an expired call must not look like a use");
  assert.equal(snapshot.audit.some((item) => item.credentialId === created.id && item.action === "mcp.call"), false);
});

test("a corrupt expiry refuses the key instead of making it permanent", async () => {
  const service = createOAuthService();
  const created = await service.provider.createApiKey("corrupt", undefined, undefined, null, "not-a-date");
  await assert.rejects(() => service.provider.verifyApiKey(created.secret), /API key expired/);
  assert.deepEqual(keyExpiryState("not-a-date"), { kind: "expired", days: null });
});

test("the create audit carries the expiry", async () => {
  const service = createOAuthService();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const created = await service.provider.createApiKey("audited", undefined, undefined, null, expiresAt);
  const snapshot = await service.provider.authorizationSnapshot();
  const entry = snapshot.audit.find((item) => item.action === "api-key.create" && item.credentialId === created.id);
  assert.equal(entry.expiresAt, expiresAt);
});

test("keyExpiryState says today only on the same UTC day", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  // Dying tomorrow at 11:00 is 23 hours away, but it is not today.
  assert.equal(keyExpiryState("2026-11-19T11:00:00.000Z", now).kind, "active");
  assert.equal(keyExpiryState("2026-11-18T23:59:59.999Z", now).kind, "today");
});
