// An expired managed API key must be refused at the transport, named in the audit, and refused
// with 401 rather than falling through to the generic "missing credential" row.
//
// Runs against the real auth middleware and a real HTTP socket (the same harness the Vault-scope
// tests use), so the refusion is observed end to end instead of inferred from control flow.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createAuthRevokeHarness } from "./helpers/access-policy-auth-harness.js";

const LANE_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-api-key-expiry-http-"));
process.env.VAULT_PATH = path.join(LANE_ROOT, "vault");
await mkdir(process.env.VAULT_PATH, { recursive: true });

const harness = await createAuthRevokeHarness();
const { auditFor, boot, provider, uniqueAgent } = harness;

after(async () => {
  await harness.teardown();
  await rm(LANE_ROOT, { recursive: true, force: true });
});

test("an expired managed key answers 401 and leaves exactly one named refusal", async () => {
  const agent = uniqueAgent("expired-key");
  const created = await provider.createApiKey("expired over http", undefined, undefined, null, "2020-01-01T00:00:00.000Z");
  const app = await boot({});
  try {
    const answer = await app.call({ key: created.secret, agent, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    assert.equal(answer.status, 401);
    assert.deepEqual(await answer.json(), { error: "invalid_token", error_description: "Invalid or expired API key" });
    assert.equal(app.handled.length, 0, "an expired key never reaches the MCP handler");

    const rejects = await auditFor({ action: "auth.reject", userAgent: agent });
    assert.equal(rejects.length, 1, `exactly one refusal row, got ${JSON.stringify(rejects)}`);
    assert.deepEqual({ credentialId: rejects[0].credentialId, detail: rejects[0].detail }, { credentialId: created.id, detail: "API key expired" });
    assert.equal(rejects.some((entry) => entry.detail === "missing credential"), false, "no second, false row for the same attempt");
  } finally {
    await app.close();
  }
});
