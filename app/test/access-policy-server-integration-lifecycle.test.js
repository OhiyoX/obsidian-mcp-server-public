// AuthZ Wave C / C1 — real-server lifecycle integration (hard revoke + OAuth + shutdown).
//
// Contract: `scratch/authz/INTERFACE.md` §10.1/§10.2/§10.3/§10.6 and the C1
// BRIEF §2. These tests spawn the real `server.js` against a temporary DATA_PATH
// and talk to it over HTTP, so the hard-revoke 401 path, the OAuth
// access/refresh lifecycle gate and the shutdown drain ownership are exercised
// for real.
//
// Split out of `access-policy-server-integration.test.js`; the Stage 0 / empty /
// suspend / broken-store half stays there. The shared spawn/HTTP fixtures are
// `helpers/server-spawn-fixtures.js`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  API_KEY,
  APP_DIR,
  approveAndExchange,
  createManagedApiKey,
  freePort,
  initialize,
  listTools,
  mcp,
  outsideWindowPolicy,
  refreshTokens,
  registerOAuthClient,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
  waitForAudit,
  writePolicy,
} from "./helpers/server-spawn-fixtures.js";

test("hard revoke denies with 401 without permanently revoking the credential, and is principal-scoped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-revoke-"));
  const port = await freePort();
  await seedVault(root);
  await writePolicy(root, [outsideWindowPolicy({ mode: "revoke", capabilities: ["all"] })]);
  const env = serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } });
  const { child, base } = await startServer(env);
  try {
    // Key B is a different principal: it must be unaffected by A's revoke.
    const keyB = await createManagedApiKey(base);
    const initB = await initialize(base, { key: keyB.key });
    assert.equal(initB.status, 200);

    const denied = await initialize(base, { key: API_KEY });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") || "", /invalid_token/);
    assert.doesNotMatch(denied.text, /policyId|nextAllowedAt|outside_authorized_window/);

    const stillB = await listTools(base, { key: keyB.key }, initB.session);
    assert.equal(stillB.status, 200);
    // B is a different principal, so A's revoke must not deny or close B. The
    // managed key is deliberately read-scoped, so only membership is asserted.
    const bTools = stillB.payload.result.tools.map((tool) => tool.name);
    assert.ok(bTools.length > 0 && bTools.includes("get_note"));

    const denies = (await waitForAudit(root, (entries) => entries.some((entry) => entry.action === "authz.deny"))).filter((entry) => entry.action === "authz.deny");
    assert.ok(denies.length >= 1);
    assert.equal(denies[0].surface, "mcp");
    assert.equal(denies[0].mode, "revoke");
  } finally {
    await stopChild(child);
  }

  // Phase B: turning the policy off (restart, no watcher by design) proves the
  // credential was only temporally denied, not permanently revoked (A-05).
  await writePolicy(root, [], 2);
  const second = await startServer(serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } }));
  try {
    const health = await (await fetch(`${second.base}/healthz`)).json();
    assert.equal(health.authorizationWindows.status, "ready");
    assert.equal(health.authorizationWindows.policyCount, 0);
    const init = await initialize(second.base, { key: API_KEY });
    assert.equal(init.status, 200);
  } finally {
    await stopChild(second.child);
  }
});


test("OAuth lifecycle: a revoke window denies access and refresh without consuming the refresh token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-oauth-"));
  const port = await freePort();
  await seedVault(root);

  // Phase 1: no policy -> issue real tokens through the authorization-code flow.
  const first = await startServer(serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } }));
  let tokens;
  let client;
  try {
    client = { ...(await registerOAuthClient(first.base)), resource: `${first.publicBase}/mcp` };
    tokens = await approveAndExchange(first.base, client);
    const init = await mcp(first.base, { bearer: tokens.access_token, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wave-c-oauth", version: "1" } } } });
    assert.equal(init.status, 200);
  } finally {
    await stopChild(first.child);
  }

  // Phase 2: revoke the OAuth client -> 401 for the access token, access_denied
  // for refresh, and (asserted in phase 3) the refresh token stays usable.
  await writePolicy(root, [outsideWindowPolicy({ mode: "revoke", capabilities: ["all"], subjects: [`oauth-client:${client.registered.client_id}`] })]);

  const second = await startServer(serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } }));
  try {
    const deniedAccess = await initialize(second.base, { bearer: tokens.access_token });
    assert.equal(deniedAccess.status, 401);
    assert.match(deniedAccess.headers.get("www-authenticate") || "", /invalid_token/);
    assert.doesNotMatch(deniedAccess.text, /policyId|outside_authorized_window/);

    const refusedRefresh = await refreshTokens(second.base, client, tokens.refresh_token);
    assert.equal(refusedRefresh.status, 400, `expected the refresh to be refused, got ${refusedRefresh.status}: ${refusedRefresh.text}`);
    assert.equal(refusedRefresh.json.error, "access_denied");
    assert.doesNotMatch(refusedRefresh.text, /policyId|weekly|timezone/);
  } finally {
    await stopChild(second.child);
  }

  // Phase 3: policy off -> the SAME refresh token succeeds, proving the denied
  // refresh neither consumed nor rotated it.
  await writePolicy(root, [], 2);
  const third = await startServer(serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } }));
  try {
    const refreshed = await refreshTokens(third.base, client, tokens.refresh_token);
    assert.equal(refreshed.status, 200, `expected the untouched refresh token to work, got ${refreshed.status}: ${refreshed.text}`);
    assert.ok(refreshed.json.access_token);
  } finally {
    await stopChild(third.child);
  }
});

test("shutdown wires the access-policy drain after the Web session drain", async (t) => {
  // Windows cannot deliver a POSIX signal handler to a spawned process (child.kill
  // terminates it without running `shutdown`), so the wiring is asserted from the
  // source here and exercised end-to-end only on POSIX hosts.
  const source = await fs.readFile(path.join(APP_DIR, "server.js"), "utf8");
  const webDrain = source.indexOf("webSessionStore.drain()");
  const policyDrain = source.indexOf("accessPolicy.drain()");
  assert.ok(webDrain >= 0, "the Web session drain must stay wired");
  assert.ok(policyDrain > webDrain, "the policy drain must follow the Web session drain");
  assert.match(source, /withDeadline\(accessPolicy\.drain\(\), deadlineAt, "Access policy drain"\)/);

  if (process.platform === "win32") {
    t.diagnostic("POSIX signal shutdown is not reachable on win32; source wiring asserted instead");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-shutdown-"));
  const port = await freePort();
  await seedVault(root);
  await writePolicy(root, [outsideWindowPolicy()]);
  const { child, base } = await startServer(serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } }));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  child.kill("SIGINT");
  const code = await new Promise((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  assert.equal(code, 0);
});
