// P2 / Task 10 — the MCP shadow at the real HTTP entry, tools, Compact actions,
// mixed batches and the primary resources.
//
// Contract: design §6.1.1-3 and §10 P2. Every real MCP boundary computes the new
// verdict beside the old one and records one bounded row; the old verdict alone
// decides the status, the payload, the handler count and the bytes. Hard revoke
// stays HTTP 401, a suspend or a broken policy stays a tool refusal, Scope still
// precedes Vault, and a mixed batch is still refused as a whole before any handler.
//
// The rows are read from the protected `/healthz` summary (`authorizationShadow`),
// which is bounded metadata only: counts and covered boundary keys, never a path,
// a body or a credential.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTHORIZATION_DECISION_CODES } from "../src/authorization/evaluate.js";
import { mapMcpAuthorizationDenial, mcpAuthorizationRequest, mcpVerifiedActor } from "../src/authorization/adapters/mcp.js";
import {
  API_KEY,
  callTool,
  createManagedApiKey,
  freePort,
  initialize,
  listTools,
  mcp,
  outsideWindowPolicy,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
  writePolicy,
} from "./helpers/server-spawn-fixtures.js";

const NOTE = { path: "note.md" };

async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shadow-p2-"));
  const port = await freePort();
  await seedVault(root);
  await fs.mkdir(path.join(root, "vaults", "secondary"), { recursive: true });
  await fs.writeFile(path.join(root, "vaults", "secondary", "private.md"), "# Secondary sentinel: forbidden\n", "utf8");
  return { root, port };
}

function envFor({ root, port }, extra = {}) {
  return serverEnv({
    root,
    port,
    extra: {
      AUTHZ_ENABLED: "true",
      MCP_DISCOVERY_PROFILE: "full",
      VAULT_DISCOVERY_ENABLED: "false",
      OBSIDIAN_READ_ONLY: "false",
      EMBEDDING_PROVIDER: "disabled",
      GIT_ENABLED: "false",
      WEB_VAULTS_ROOT: path.join(root, "vaults"),
      WEB_DEFAULT_VAULT: "vault",
      ...extra,
    },
  });
}

// The full record (counts and covered boundary keys) is on an authenticated
// surface; the public health surface reports the counts only.
async function shadowSummary(base, auth) {
  const response = await fetch(`${base}/`, { headers: auth.key ? { "X-API-Key": auth.key } : {} });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.authorizationShadow, "the authenticated surface must report the shadow record");
  return payload.authorizationShadow;
}

async function shadowCounts(base) {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.ok(health.authorizationShadow, "the health surface must report the shadow counts");
  assert.equal("coveredBoundaryKeys" in health.authorizationShadow, false, "boundary coverage is not public");
  return health.authorizationShadow;
}

async function readResource(base, auth, session, uri, id = 21) {
  return mcp(base, {
    ...auth,
    session,
    body: { jsonrpc: "2.0", id, method: "resources/read", params: { uri } },
  });
}

async function noteBytes(root) {
  return fs.readFile(path.join(root, "vault", NOTE.path), "utf8");
}

test("mcp_shadow_covers_native_compact_batch_and_primary_resources", async () => {
  const fixture = await scratch();
  const { root, port } = fixture;
  await writePolicy(root, [outsideWindowPolicy()]);
  let child;
  try {
    const started = await startServer(envFor(fixture));
    child = started.child;
    const base = started.base;

    const managed = await createManagedApiKey(base, { scopes: ["obsidian.read"], vault: "vault", label: "p2 shadow read" });
    const readAuth = { key: managed.key };
    const init = await initialize(base, readAuth);
    assert.equal(init.status, 200);
    const session = init.session;
    const before = await shadowSummary(base, readAuth);

    // 1. A native tool call: the old gate allows and the handler runs once.
    const allowed = await callTool(base, readAuth, session, "get_note", NOTE);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.payload.result.isError, undefined);
    assert.match(JSON.stringify(allowed.payload.result), /Integration note/);
    // ONE row for the whole request, although the transport, the temporal gate and the
    // Vault scope all answered it.
    // Counters are relative to the run's own baseline: the admin console reads that create
    // the managed key are real authorization units of their own.
    const afterAllowed = await shadowSummary(base, readAuth);
    assert.deepEqual(
      {
        compared: afterAllowed.compared - before.compared,
        matches: afterAllowed.matches - before.matches,
        differences: afterAllowed.differences - before.differences,
        inconclusive: afterAllowed.inconclusive - before.inconclusive,
      },
      { compared: 1, matches: 1, differences: 0, inconclusive: 0 },
      "one allowed tools/call is one row, one match",
    );

    // 2. A transport refusal: Scope before Vault, no handler, no content I/O.
    const bytesBefore = await noteBytes(root);
    const scopeDenied = await callTool(base, readAuth, session, "write_note", { path: "blocked.md", content: "must not land" });
    assert.equal(scopeDenied.status, 403);
    assert.equal(scopeDenied.payload.error, "insufficient_scope");
    await assert.rejects(fs.stat(path.join(root, "vault", "blocked.md")));
    assert.equal(await noteBytes(root), bytesBefore);
    const afterScopeDenied = await shadowSummary(base, readAuth);
    assert.deepEqual(
      { compared: afterScopeDenied.compared - before.compared, differences: afterScopeDenied.differences - before.differences },
      { compared: 2, differences: 1 },
      "one row more, and the scope family gap is the one real difference",
    );

    // 3. A requested Vault outside the credential's list: still a whole-request refusal.
    const vaultDenied = await callTool(base, readAuth, session, "get_note", { path: "private.md", vaultId: "secondary" });
    assert.equal(vaultDenied.status, 403);
    assert.equal(vaultDenied.payload.error, "access_denied");
    assert.equal(JSON.stringify(vaultDenied.payload).includes("sentinel"), false);
    const afterVaultDenied = await shadowSummary(base, readAuth);
    assert.deepEqual(
      { compared: afterVaultDenied.compared - before.compared, differences: afterVaultDenied.differences - before.differences },
      { compared: 3, differences: 1 },
      "the Vault denial agrees with the new model: no new difference",
    );

    // 4. A mixed batch: one allowed member, one scope-denied member. The old gate
    //    refuses the whole batch, so neither member reaches a handler.
    const batch = await mcp(base, {
      ...readAuth,
      session,
      body: [
        { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "get_note", arguments: NOTE } },
        { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "write_note", arguments: { path: "batch.md", content: "nope" } } },
      ],
    });
    assert.equal(batch.status, 403);
    assert.equal(batch.payload.error, "insufficient_scope");
    await assert.rejects(fs.stat(path.join(root, "vault", "batch.md")));
    assert.equal(await noteBytes(root), bytesBefore);
    // One row per member. P3 decides every member before the batch refusal, so each row
    // carries that member's own old verdict: the refusing member is a real difference and
    // the admitted member matches. Nothing is inconclusive any more — the same two rows,
    // compared instead of one of them being an unreadable layer.
    const afterBatch = await shadowSummary(base, readAuth);
    assert.deepEqual(
      {
        compared: afterBatch.compared - before.compared,
        differences: afterBatch.differences - before.differences,
        inconclusive: afterBatch.inconclusive - before.inconclusive,
      },
      { compared: 5, differences: 2, inconclusive: 0 },
      "a mixed batch is two member rows, each with its own old verdict",
    );

    // 5. A primary resource read: index and tags are Vault reads on the primary.
    const index = await readResource(base, readAuth, session, "obsidian://vault/index");
    assert.equal(index.status, 200);
    assert.match(JSON.stringify(index.payload.result.contents), /note\.md/);
    const afterResource = await shadowSummary(base, readAuth);
    assert.equal(afterResource.compared - before.compared, 6, "the resource read is one row");
    assert.equal(afterResource.differences - before.differences, 2, "and it agrees with the new model");

    // 6. Three members of the SAME tool on the SAME Vault are three authorization
    //    units: the unit key has no member discriminator, so the phase queue keeps them
    //    apart. A merged row would hide two members.
    const identical = await mcp(base, {
      ...readAuth,
      session,
      body: [
        { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "get_note", arguments: NOTE } },
        { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "get_note", arguments: NOTE } },
        { jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "get_note", arguments: NOTE } },
      ],
    });
    assert.equal(identical.status, 200);
    const afterIdentical = await shadowSummary(base, readAuth);
    assert.equal(afterIdentical.compared - before.compared, 9, "three identical members add three rows, not one");
    assert.equal(afterIdentical.differences - before.differences, 2, "and none of them is a difference");

    // 7. An unknown tool creates no row and no new allow.
    const afterKnown = await shadowSummary(base, readAuth);
    const unknown = await callTool(base, readAuth, session, "no_such_tool", {});
    assert.notEqual(unknown.payload.result?.isError, false);
    const afterUnknown = await shadowSummary(base, readAuth);
    assert.equal(afterUnknown.compared, afterKnown.compared, "an unknown tool is not an authorization row");

    // 8. A suspend denial stays a tool refusal (never a batch HTTP 403) and matches.
    const configured = { key: API_KEY };
    const configuredInit = await initialize(base, configured);
    assert.equal(configuredInit.status, 200);
    const suspended = await callTool(base, configured, configuredInit.session, "get_note", NOTE);
    assert.equal(suspended.status, 200);
    assert.equal(suspended.payload.result.isError, true);
    assert.equal(suspended.payload.result.structuredContent.code, "outside_authorized_window");
    const afterSuspend = await shadowSummary(base, readAuth);
    // A suspended request is ONE row whose effective old answer is the deny that
    // decided, so it adds no difference: the transport allow is not reported as one.
    assert.equal(afterSuspend.compared - before.compared, 10, "the suspended call is one row");
    assert.equal(afterSuspend.differences - before.differences, 2, "a suspend that both models deny is not a difference");

    // Every real MCP boundary of this run produced a row, and every row is counted
    // once as exactly one of match / difference / inconclusive.
    assert.ok(afterSuspend.compared > before.compared);
    assert.equal(afterSuspend.matches + afterSuspend.differences + afterSuspend.inconclusive, afterSuspend.compared);
    assert.ok(afterSuspend.matches > 0, "the imported candidate agrees on the plain allow");
    assert.ok(afterSuspend.coveredBoundaryKeys.includes("get_note"));
    assert.ok(afterSuspend.coveredBoundaryKeys.includes("write_note"));
    assert.ok(afterSuspend.coveredBoundaryKeys.includes("obsidian://vault/index"));
    assert.equal(afterSuspend.capacity > 0, true);
    // A bounded record of metadata only: no path, body or credential.
    const text = JSON.stringify(afterSuspend);
    for (const leak of ["note.md", "Integration note", managed.key, "obsidian-user", "secondary"]) {
      assert.equal(text.includes(leak), false, `the shadow summary must not carry ${leak}`);
    }

    // 8. Compact actions: the virtual name is projected once, before both algorithms.
    const compactFixture = await scratch();
    let compactChild;
    try {
      const compactStarted = await startServer(envFor(compactFixture, { MCP_DISCOVERY_PROFILE: "compact" }));
      compactChild = compactStarted.child;
      const compactBase = compactStarted.base;
      const compactKey = await createManagedApiKey(compactBase, { scopes: ["obsidian.read", "obsidian.write"], vault: "vault", label: "p2 shadow compact" });
      const compactAuth = { key: compactKey.key };
      const compactInit = await initialize(compactBase, compactAuth);
      assert.equal(compactInit.status, 200);
      const listed = await listTools(compactBase, compactAuth, compactInit.session);
      // The compact view partitions a group by Scope and risk signature, so the
      // descriptor that carries `get_note` is found by its own action list.
      const readGroup = listed.payload.result.tools.find((tool) => tool.description?.includes("get_note"));
      assert.ok(readGroup, "the compact profile exposes a descriptor whose actions include get_note");
      const compactName = readGroup.name;

      const compactBefore = await shadowSummary(compactBase, compactAuth);
      const compactRead = await callTool(compactBase, compactAuth, compactInit.session, compactName, { action: "get_note", params: NOTE });
      assert.equal(compactRead.status, 200);
      assert.equal(compactRead.payload.result.isError, undefined);
      const compactAfter = await shadowSummary(compactBase, compactAuth);
      assert.ok(compactAfter.compared > compactBefore.compared);
      assert.ok(compactAfter.coveredBoundaryKeys.includes("get_note"), "a compact action is recorded as its source operation");

      // An unknown Compact action is not a catalog boundary and creates no row.
      const badGroup = await callTool(compactBase, compactAuth, compactInit.session, compactName, { action: "no_such_action", params: {} });
      assert.ok(badGroup.payload.result?.isError === true || badGroup.payload.error, "an unknown Compact action is refused");
      const afterBadGroup = await shadowSummary(compactBase, compactAuth);
      assert.equal(afterBadGroup.compared, compactAfter.compared, "an unknown Compact action creates no row");

      // A malformed member (`action` without `params`) is refused by discovery before
      // any handler. The legacy HTTP gate still projects it onto the source tool name,
      // so the transport row mirrors that old gate and reaches no handler.
      const malformed = await callTool(compactBase, compactAuth, compactInit.session, compactName, { action: "get_note" });
      assert.ok(malformed.payload.result?.isError === true || malformed.payload.error, "a malformed Compact group is refused");
      const compactEnd = await shadowSummary(compactBase, compactAuth);
      assert.ok(compactEnd.compared - afterBadGroup.compared <= 1);
      assert.deepEqual(compactEnd.coveredBoundaryKeys, afterBadGroup.coveredBoundaryKeys, "a malformed member covers no new boundary");
    } finally {
      await stopChild(compactChild);
      await fs.rm(compactFixture.root, { recursive: true, force: true });
    }
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp_hard_revoke_stays_http_401_and_the_shadow_records_the_same_family", async () => {
  const fixture = await scratch();
  const { root } = fixture;
  // A principal-wide revoke for the configured key: the transport refuses before the
  // MCP transport, so no session can be opened at all.
  await writePolicy(root, [outsideWindowPolicy({ mode: "revoke", capabilities: ["all"], label: "p2 shadow revoke" })]);
  let child;
  try {
    const started = await startServer(envFor(fixture));
    child = started.child;
    const base = started.base;
    const before = await shadowCounts(base);

    const refused = await callTool(base, { key: API_KEY }, undefined, "get_note", NOTE);
    assert.equal(refused.status, 401, "a hard revoke keeps the HTTP 401 family");
    assert.equal(refused.payload.error, "invalid_token");
    assert.equal(JSON.stringify(refused.payload).includes("Integration note"), false);
    assert.match(await noteBytes(root), /Integration note/, "no handler ran for the refused call");

    // The initial handshake is refused too: the revoke precedes the transport.
    const handshake = await initialize(base, { key: API_KEY });
    assert.equal(handshake.status, 401);

    const after = await shadowCounts(base);
    assert.ok(after.compared > before.compared, "the transport boundary still records a row");
    assert.ok(after.matches > 0, "the old revoke and the new revoke agree on the family");
    assert.equal(after.differences, 0, "the old revoke and the new revoke name the same family");
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the_adapter_normalizes_one_actor_and_one_target_and_maps_the_existing_families", () => {
  const managed = { type: "api-key", keyId: "key-1", clientId: "api-key:key-1", scopes: ["obsidian.read"], allowedVaults: ["vault"], defaultVaultId: null };
  const configured = { type: "api-key", keyId: "configured-env", clientId: "api-key:configured-env", scopes: ["obsidian.read"], allowedVaults: ["vault"] };
  assert.equal(mcpVerifiedActor({ authInfo: managed }).kind, "api-key");
  assert.equal(mcpVerifiedActor({ authInfo: configured }).kind, "environment-key");
  // No verified credential, no row: an anonymous boundary is not a deny to report.
  assert.equal(mcpVerifiedActor({ authInfo: null }), null);
  assert.equal(mcpAuthorizationRequest({ authInfo: null, name: "get_note", args: {}, primaryVaultId: "vault" }), null);

  // The target follows the canonical default-Vault rule, and a resource never
  // follows the ambient selection.
  const vaultRequest = mcpAuthorizationRequest({ authInfo: { ...managed, defaultVaultId: "example-vault" }, name: "get_note", args: {}, primaryVaultId: "vault" });
  assert.deepEqual(vaultRequest.target, { kind: "vault", vaultId: "example-vault" });
  assert.deepEqual(vaultRequest.surface, "mcp");
  const resourceRequest = mcpAuthorizationRequest({ authInfo: { ...managed, defaultVaultId: "example-vault" }, resourceUri: "obsidian://vault/index", primaryVaultId: "vault" });
  assert.deepEqual(resourceRequest.target, { kind: "vault", vaultId: "vault" });
  assert.equal(resourceRequest.capability, "vault_index_read");
  // An exempt operation, an unknown name and a non-MCP boundary are never authorized here.
  assert.equal(mcpAuthorizationRequest({ authInfo: managed, name: "no_such_tool", args: {}, primaryVaultId: "vault" }), null);
  assert.equal(mcpAuthorizationRequest({ authInfo: managed, name: "session_bootstrap", args: {}, primaryVaultId: "vault" }), null);
  assert.equal(mcpAuthorizationRequest({ authInfo: managed, resourceUri: "GET /app/note/*", primaryVaultId: "vault" }), null);

  // The denial mapping keeps today's shapes for the P3/P4 bridge.
  const C = AUTHORIZATION_DECISION_CODES;
  assert.equal(mapMcpAuthorizationDenial({ allowed: true, code: C.ALLOWED }, "transport"), null);
  assert.deepEqual(mapMcpAuthorizationDenial({ allowed: false, code: C.INVALID_CREDENTIAL }, "transport"), { status: 401, body: { error: "invalid_token", error_description: "Invalid or expired access token" } });
  assert.deepEqual(mapMcpAuthorizationDenial({ allowed: false, code: C.OUTSIDE_WINDOW, mode: "revoke" }, "transport").status, 401);
  assert.equal(mapMcpAuthorizationDenial({ allowed: false, code: C.INSUFFICIENT_SCOPE }, "transport").body.error, "insufficient_scope");
  assert.equal(mapMcpAuthorizationDenial({ allowed: false, code: C.VAULT_ACCESS_DENIED }, "transport").body.error, "access_denied");
  const refused = mapMcpAuthorizationDenial({ allowed: false, code: C.OUTSIDE_WINDOW, mode: "suspend", denyConstraintId: "policy-1", nextAllowedAt: "2026-11-03T00:00:00.000Z" }, "operation");
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.structuredContent, { code: C.OUTSIDE_WINDOW, mode: "suspend", policyId: "policy-1", nextAllowedAt: "2026-11-03T00:00:00.000Z" });
  assert.deepEqual(mapMcpAuthorizationDenial({ allowed: false, code: C.VAULT_UNAVAILABLE }, "operation", { vaultId: "vault" }).structuredContent, { code: C.VAULT_UNAVAILABLE, vaultId: "vault" });
});

// Task 25 / design §11.3-3 — the approved tightening, recorded beside the legacy answer.
//
// Before `fix/resource-vault-scope` a credential that held only the secondary Vault read the
// primary Vault's content through the three `obsidian://vault/*` resources (P0 finding, committed
// baseline rows `oauth:secondary-only|mcp-resource|obsidian://vault/*`). The Vault registrar now
// asks the same runtime, so the legacy gate and the new model both refuse: one row, no difference.
test("a secondary-only credential reads no primary resource and the shadow records agreement", async () => {
  const fixture = await scratch();
  let child;
  try {
    const started = await startServer(envFor(fixture));
    child = started.child;
    const base = started.base;

    const secondaryOnly = await createManagedApiKey(base, { scopes: ["obsidian.read"], vault: "secondary", label: "p4 secondary only" });
    const auth = { key: secondaryOnly.key };
    const init = await initialize(base, auth);
    assert.equal(init.status, 200);
    const before = await shadowSummary(base, auth);

    const read = await readResource(base, auth, init.session, "obsidian://vault/index");
    assert.equal(read.status, 200);
    // The refusal keeps the resource answer shape and names the family; no byte of the
    // primary Vault is in it.
    assert.equal(read.payload.result?.isError, true, "the read is refused before any content");
    assert.match(JSON.stringify(read.payload), /vault_access_denied/);
    assert.equal(JSON.stringify(read.payload).includes("Integration note"), false, "no primary content");

    const after = await shadowSummary(base, auth);
    assert.deepEqual(
      {
        compared: after.compared - before.compared,
        matches: after.matches - before.matches,
        differences: after.differences - before.differences,
        inconclusive: after.inconclusive - before.inconclusive,
      },
      { compared: 1, matches: 1, differences: 0, inconclusive: 0 },
      "one resource row: the legacy gate and the new model both answer vault_access_denied",
    );
  } finally {
    await stopChild(child);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
