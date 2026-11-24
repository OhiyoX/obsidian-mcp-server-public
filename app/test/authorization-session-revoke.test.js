// #617 (W3-C) — revoking the token behind an OPEN MCP session must take effect on the next request.
//
// The matrix this issue asks for is the 265-row permission baseline; what it does not have is the
// temporal half: every row opens its own session, so "revoked" is proved only for a credential that
// was never admitted. The dangerous shape is the other one — a session that was already admitted,
// whose credential is then revoked. A server that trusts the session instead of re-reading the
// credential would keep answering from a revoked token until the client reconnected, which is
// exactly the "was visible, stays callable" inheritance #617 forbids.
//
// Which gate answers is worth stating, because two exist. Measured negative controls:
//   * skipping the token-store status test (`protocol-methods.js`: `record.revokedAt`) turns this
//     red — the call answered 200 and ran the handler, so the per-request credential re-read is
//     the gate this test pins;
//   * skipping the principal-wide revoke decision (`auth.js` `revokeRefusal`) does NOT turn it red,
//     because the token store already refuses the credential at `verifyAccessToken`.
// Both must refuse; only the first is on this path today.
//
// The check is end to end: a real OAuth token, a real `initialize` (the SDK's session id comes back
// in `mcp-session-id`), a real `tools/call` that succeeds, then `revokeTokenById`, then the SAME
// session id sends the SAME call again. The second answer must be a transport refusal (401) with
// zero handler calls, and no byte may change in the Vault.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const { removeBaselineRoot, seedPermissionBaselineEnv } = await import("./helpers/permission-baseline-env.js");
const env = await seedPermissionBaselineEnv();
const { createPermissionPlane, observeCase, toolCall } = await import("./helpers/permission-plane.js");

test.after(async () => removeBaselineRoot(env.root));

test("a token revoked mid-session refuses the next call on that same session, before any handler", async (t) => {
  const plane = await createPermissionPlane({ envKey: process.env.API_KEY, primaryVault: env.primary });
  t.after(() => plane.close());
  const provider = plane.provider;
  // The shared env helper makes the Vault directories; this probe needs one readable note in the
  // Vault the token holds, so the first call succeeds and the second one has something to refuse.
  await fs.writeFile(path.join(env.vaults, "vault", "note.md"), "# Session revoke probe\n", "utf8");

  const user = await provider.createOAuthUser({
    username: "session-revoke",
    password: "session-revoke-password",
    displayName: "Session Revoke",
    allowedScopes: ["obsidian.read"],
    allowedVaults: ["vault"],
  });
  await provider.clientsStore.registerClient({
    client_id: "session-revoke-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Session Revoke",
    redirect_uris: ["https://client.example/session-revoke"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const token = await provider.issueTokens("session-revoke-client", ["obsidian.read"], "http://127.0.0.1:18923/mcp", user.id, ["vault"]);
  const actor = { id: "oauth:session-revoke", headers: () => ({ Authorization: `Bearer ${token.access_token}` }) };

  const read = toolCall("get_note", { path: "note.md", vaultId: "vault" });
  // 1. The session is admitted: this opens the MCP session and answers with the note.
  const admitted = await observeCase(plane, { actor, request: read, vaultRoot: env.vaults, targetCase: "vault:primary" });
  assert.equal(admitted.allowed, true, `the first call must be admitted: ${JSON.stringify(admitted)}`);
  const sessionId = plane.sessionIdOf(actor);
  assert.ok(sessionId, "the admitted call must have opened a real MCP session");

  // 2. Revoke the credential that session was admitted with. The session id stays the same.
  const tokens = await provider.authorizationSnapshot();
  const record = tokens.tokens.find((entry) => entry.status === "active" && entry.userId === user.id);
  assert.ok(record, "the issued token must be present and active before the revoke");
  await provider.revokeTokenById(record.type, record.id);

  // 3. The same session, the same call: refused at the transport, with no handler and no byte moved.
  const refused = await observeCase(plane, { actor, request: read, vaultRoot: env.vaults, targetCase: "vault:primary", sessionId });
  assert.equal(refused.allowed, false, `a revoked token must not keep a session alive: ${JSON.stringify(refused)}`);
  assert.equal(refused.status, 401, `the refusal must be a transport 401, got ${refused.status}`);
  assert.equal(refused.handlerCalls, 0, "no tool handler may run for a revoked credential");
  assert.equal(refused.contentIo, 0, "a refused call must not change a Vault byte");

  // 4. Negative control: a fresh session on the same revoked token is refused too, so step 3 is not
  //    measuring "this session was closed" but "the credential is gone".
  const fresh = await observeCase(plane, { actor, request: read, vaultRoot: env.vaults, targetCase: "vault:primary", sessionId: null });
  assert.equal(fresh.allowed, false, "a revoked credential must not open a new session either");
  assert.equal(fresh.status, 401);
});
