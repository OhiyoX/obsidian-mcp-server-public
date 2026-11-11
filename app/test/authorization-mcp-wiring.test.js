// P3 / Task 20 — every MCP boundary decides through the authorization runtime.
//
// Contract: design §6.1.1-3 and §10 P3. Three properties decide this task:
//
//   1. THE RUNTIME DECIDES, FOR EVERY CREDENTIAL. The HTTP admission asks the injected
//      authorization runtime once per `tools/call` member for every branch (managed API
//      Key, configured environment Key, OAuth access token) and for the principal-wide
//      revoke. A deny the runtime states is the answer: no handler runs, and the local
//      Scope / Vault lists can no longer admit a request the runtime refuses.
//   2. THE BATCH KEEPS ITS PRECEDENCE. A batch is refused as a whole, and the refusal
//      family does not depend on member order: an insufficient Scope still precedes an
//      unauthorized Vault (§6.1.1), and a hard revoke stays a transport 401.
//   3. `legacy` MODE ANSWERS WITH THE OLD ALGORITHM. For a matrix of requests the
//      runtime's decision equals the old gates' answer, because the runtime delegates to
//      the extracted legacy backend. One sample would prove nothing.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const CONFIGURED_KEY = "configured-env-wiring-key";
const MCP_URL = "http://127.0.0.1:18931/mcp";

const ALLOWED = Object.freeze({
  allowed: true, code: "allowed", enforcement: "operation", mode: null,
  revision: null, matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt: null,
});

function decision(code, { enforcement = "operation", mode = null, nextAllowedAt = null } = {}) {
  return Object.freeze({
    allowed: false, code, enforcement, mode, revision: null,
    matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt,
  });
}

/** A counted authorization runtime: the test states the verdict, the transport must obey it. */
function stubRuntime(decide) {
  const calls = [];
  return {
    calls,
    authorize(request) {
      calls.push(request);
      return decide(request) ?? ALLOWED;
    },
  };
}

async function bootHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "authz-mcp-wiring-"));
  process.env.DATA_PATH = root;
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18931";
  process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
  process.env.OAUTH_INITIAL_USERNAME = "test-owner";
  process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
  process.env.API_KEY = CONFIGURED_KEY;
  process.env.MCP_PATH = "/mcp";
  process.env.GIT_ENABLED = "false";

  const [{ createAuthMiddleware }, { createOAuthService }, { requestContext }] = await Promise.all([
    import("../src/auth.js"),
    import("../src/oauth-provider.js"),
    import("../src/request-context.js"),
  ]);

  const oauthService = createOAuthService();
  const provider = oauthService.provider;
  const harnesses = [];

  async function boot({ authorization = null, onHardRevoke = null } = {}) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(createAuthMiddleware(oauthService, { authorization, onHardRevoke }));
    const handled = [];
    app.post("/mcp", async (req, res) => {
      handled.push({ body: req.body, auth: req.auth, context: requestContext() });
      res.status(200).json({ ok: true });
    });
    const server = await new Promise((resolve, reject) => {
      const instance = http.createServer(app);
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const harness = {
      handled,
      close: () => new Promise((resolve, reject) => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close((error) => error ? reject(error) : resolve());
      }),
      async call({ key, bearer, body }) {
        return fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "X-API-Key": key } : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body ?? toolCall("list_notes", {})),
        });
      },
    };
    harnesses.push(harness);
    return harness;
  }

  return {
    provider,
    boot,
    async close() {
      for (const harness of harnesses) await harness.close();
      await provider.drainPersistence();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function toolCall(name, args) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

function batch(...calls) {
  return calls.map(([name, args], index) => ({ jsonrpc: "2.0", id: 100 + index, method: "tools/call", params: { name, arguments: args } }));
}

// ---------------------------------------------------------------------------
// 1. Every credential branch asks the runtime, and the runtime's deny is the answer.
// ---------------------------------------------------------------------------

test("mcp_admission_and_execution_use_runtime_and_keep_batch_denial_precedence", async () => {
  const harness = await bootHarness();
  try {
    const readKey = await harness.provider.createApiKey("wiring read", ["obsidian.read"], ["vault"]);
    const wideKey = await harness.provider.createApiKey("wiring wide", ["obsidian.read", "obsidian.write", "obsidian.files"], ["vault", "secondary"]);
    const token = harness.provider.issueTokens("client-wiring", ["obsidian.read"], MCP_URL, "user-wiring", ["vault"]);

    // --- Managed API Key: a runtime deny refuses the request and no handler runs.
    {
      const runtime = stubRuntime(() => decision("insufficient_scope"));
      const app = await harness.boot({ authorization: runtime });
      const response = await app.call({ key: readKey.secret });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "insufficient_scope");
      assert.equal(app.handled.length, 0, "a runtime deny must never reach the handler");
      const transport = runtime.calls.filter((call) => call.legacy?.phase === "transport");
      assert.equal(transport.length, 1, "one decision per tools/call member");
      assert.equal(transport[0].actor.kind, "api-key");
      assert.equal(transport[0].capability, "list_notes");
      assert.equal(transport[0].surface, "mcp");
      assert.equal(transport[0].target.vaultId, process.env.WEB_DEFAULT_VAULT || "default");
      assert.equal(runtime.calls.filter((call) => call.legacy?.phase === "revoke").length, 1, "the revoke is decided once per request");
    }

    // --- Configured environment Key: same seam, its own actor kind.
    {
      const runtime = stubRuntime(() => decision("vault_access_denied"));
      const app = await harness.boot({ authorization: runtime });
      const response = await app.call({ key: CONFIGURED_KEY });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "access_denied");
      assert.equal(app.handled.length, 0);
      const member = runtime.calls.find((call) => call.legacy?.phase === "transport");
      assert.equal(member.actor.kind, "environment-key");
    }

    // --- OAuth access token: same seam, its own actor kind.
    {
      const runtime = stubRuntime(() => decision("vault_access_denied"));
      const app = await harness.boot({ authorization: runtime });
      const response = await app.call({ bearer: token.access_token });
      assert.equal(app.handled.length, 0);
      assert.equal(response.status, 403);
      const member = runtime.calls.find((call) => call.legacy?.phase === "transport");
      assert.equal(member.actor.kind, "oauth");
    }

    // --- An OPERATION denial is not an admission decision: a suspend window accepts the
    //     transport and leaves the content refusal to the wrapper that re-asks (§6.1.3).
    {
      const runtime = stubRuntime(() => decision("outside_authorized_window", { mode: "suspend" }));
      const app = await harness.boot({ authorization: runtime });
      const response = await app.call({ key: readKey.secret });
      assert.equal(response.status, 200, "a suspend window never becomes a transport 403");
      assert.equal(app.handled.length, 1, "the wrapper, not admission, owns a content denial");
      assert.ok(runtime.calls.some((call) => call.legacy?.phase === "transport"));
    }

    // --- A hard revoke stays a transport 401 and still closes the credential's sessions.
    {
      const closed = [];
      const runtime = stubRuntime((request) => (request.legacy?.phase === "revoke"
        ? decision("outside_authorized_window", { enforcement: "transport", mode: "revoke" })
        : ALLOWED));
      const app = await harness.boot({ authorization: runtime, onHardRevoke: (clientId, options) => closed.push([clientId, options]) });
      const response = await app.call({ key: readKey.secret });
      assert.equal(response.status, 401, "a revoke is a transport refusal, never a content refusal");
      assert.match(response.headers.get("www-authenticate") || "", /invalid_token/);
      assert.equal(app.handled.length, 0);
      assert.equal(closed.length, 1, "the revoke hook still runs");
    }

    // --- The local Scope / Vault lists can no longer admit or refuse on their own:
    //     a credential that carries every Scope and both Vaults is refused when the
    //     runtime denies, and a credential with a narrow list passes when it allows.
    {
      const denying = stubRuntime(() => decision("vault_access_denied"));
      const app = await harness.boot({ authorization: denying });
      const response = await app.call({ key: wideKey.secret, body: toolCall("write_note", { path: "x.md", content: "x" }) });
      assert.equal(response.status, 403, "a full local Vault list cannot overrule the runtime");
      assert.equal(app.handled.length, 0);

      const allowing = stubRuntime(() => ALLOWED);
      const permissive = await harness.boot({ authorization: allowing });
      // `write_note` needs obsidian.write and the record has it; the Vault list is broad.
      const admitted = await permissive.call({ key: wideKey.secret, body: toolCall("write_note", { path: "x.md", content: "x" }) });
      assert.equal(admitted.status, 200, "the runtime's allow is the admission");
      assert.equal(permissive.handled.length, 1);
    }

    // --- Batch precedence: a whole-batch static refusal stays whole, and an
    //     insufficient Scope wins over an unauthorized Vault in either member order.
    {
      const runtime = stubRuntime((request) => {
        if (request.legacy?.phase !== "transport") return ALLOWED;
        if (request.capability === "write_note") return decision("insufficient_scope");
        if (request.capability === "get_note" && request.target.vaultId === "secondary") return decision("vault_access_denied");
        return ALLOWED;
      });
      const app = await harness.boot({ authorization: runtime });
      const forward = batch(["write_note", { path: "x.md", content: "x" }], ["get_note", { path: "private.md", vaultId: "secondary" }]);
      const reversed = batch(["get_note", { path: "private.md", vaultId: "secondary" }], ["write_note", { path: "x.md", content: "x" }]);
      const first = await app.call({ key: readKey.secret, body: forward });
      const second = await app.call({ key: readKey.secret, body: reversed });
      assert.equal(first.status, 403);
      assert.equal(second.status, 403);
      assert.equal((await first.json()).error, "insufficient_scope", "Scope precedes Vault");
      assert.equal((await second.json()).error, "insufficient_scope", "member order never picks the refusal");
      assert.equal(app.handled.length, 0, "neither member of the refused batch reaches a handler");
      assert.equal(runtime.calls.filter((call) => call.legacy?.phase === "transport").length, 4, "each member is decided in each batch");
    }
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// 2. `legacy` mode: the runtime's answer equals the old gates' answer, for a matrix.
// ---------------------------------------------------------------------------

/** Old gate primitives, imported so the oracle is the real legacy source, not a copy. */
async function legacyPrimitives() {
  const [scopes, vaultScope, accessPolicyRuntime, legacy] = await Promise.all([
    import("../src/scopes.js"),
    import("../src/vault-scope.js"),
    import("../src/access-policy/runtime.js"),
    import("../src/authorization/legacy-evaluate.js"),
  ]);
  return { requiredScopesForTools: scopes.requiredScopesForTools, isVaultScopedTool: vaultScope.isVaultScopedTool, createAccessPolicyRuntime: accessPolicyRuntime.createAccessPolicyRuntime, legacy };
}

/** The old acceptance gate, verbatim in behaviour: revoke, then Scope, then Vault. */
function oldTransportVerdict({ auth, capability, vaultId, revoke }) {
  if (revoke) return { allowed: false, code: "outside_authorized_window", enforcement: "transport" };
  const missing = oldTransportVerdict.requiredScopesForTools([capability]).filter((scope) => !auth.scopes.includes(scope));
  if (missing.length) return { allowed: false, code: "insufficient_scope", enforcement: "operation" };
  if (oldTransportVerdict.isVaultScopedTool(capability) && !auth.allowedVaults.includes(vaultId)) {
    return { allowed: false, code: "vault_access_denied", enforcement: "operation" };
  }
  return { allowed: true, code: "allowed", enforcement: "operation" };
}

/** The old tool/resource/Web temporal gate: allow, the 403 deny, or the broken 503. */
function oldTemporalVerdict(accessRuntime, subjects, capabilities) {
  const evaluated = accessRuntime.evaluate({ subjects, capabilities });
  if (evaluated?.allowed === true) return { allowed: true, code: "allowed", mode: null, policyId: null };
  if (evaluated?.reason !== "outside_window" || !evaluated.mode) return { allowed: false, code: "authorization_policy_unavailable", mode: null, policyId: null };
  return { allowed: false, code: "outside_authorized_window", mode: evaluated.mode, policyId: evaluated.denyPolicyId ?? null };
}

const MATRIX_SUBJECT = "api-key:matrix-key";
// 00:30 on a Thursday in Asia/Shanghai: outside the fixture window (Mon-Fri 09:00-18:00).
const MATRIX_NOW = Date.parse("2026-11-04T16:30:00.000Z");

function policyDocument(policies) {
  return {
    status: "ready",
    revision: 3,
    snapshot: () => ({ status: "ready", revision: 3, policies, timeConstraintsEnabled: true }),
  };
}

function matrixRuntime({ policies = [] } = {}) {
  const store = policyDocument(policies);
  const { createAccessPolicyRuntime } = matrixRuntime.primitives;
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: () => MATRIX_NOW });
  return runtime;
}

// The grid: credential shape x member x target. Every cell is one request.
const MATRIX_ACTORS = Object.freeze([
  { label: "read-key", keyId: "matrix-key", scopes: ["obsidian.read"], allowedVaults: ["vault"], kind: "api-key" },
  { label: "write-key", keyId: "matrix-key", scopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault", "secondary"], kind: "api-key" },
  { label: "files-key", keyId: "matrix-key", scopes: ["obsidian.read", "obsidian.files"], allowedVaults: ["vault"], kind: "api-key" },
  { label: "env-key", keyId: "configured-env", scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], allowedVaults: ["vault"], kind: "environment-key" },
  { label: "oauth", clientId: "client-matrix", userId: "user-matrix", scopes: ["obsidian.read"], allowedVaults: ["vault"], kind: "oauth" },
]);

const MATRIX_MEMBERS = Object.freeze([
  ["list_notes", { path: "vault" }],
  ["get_note", { path: "vault" }],
  ["write_note", { path: "vault", content: "x" }],
  ["get_file", { path: "vault" }],
  ["git_commit", { path: "vault" }],
]);

const MATRIX_VAULTS = Object.freeze(["vault", "secondary"]);

test("legacy_mode_authorize_equals_the_old_gates_for_every_matrix_cell", async () => {
  const { createAccessPolicyRuntime, legacy } = await legacyPrimitives();
  oldTransportVerdict.requiredScopesForTools = (await import("../src/scopes.js")).requiredScopesForTools;
  oldTransportVerdict.isVaultScopedTool = (await import("../src/vault-scope.js")).isVaultScopedTool;
  matrixRuntime.primitives = { createAccessPolicyRuntime };

  const { policyFixture } = await import("./helpers/access-policy-fixtures.js");
  const suspendPolicy = policyFixture({ subjects: [MATRIX_SUBJECT], capabilities: ["all"] });

  const { catalogBoundaryKeys, capabilityForBoundary, surfaceForBoundary } = await import("../src/authorization/catalog.js");
  const { createAuthorizationRuntime } = await import("../src/authorization/runtime.js");
  const { createShadowCandidate } = await import("../src/authorization/shadow.js");
  const { verifiedActor } = await import("../src/authorization/actors.js");

  const cases = [];
  for (const actorCase of MATRIX_ACTORS) {
    for (const [tool, args] of MATRIX_MEMBERS) {
      for (const vaultId of MATRIX_VAULTS) {
        for (const phase of ["transport", "tool"]) {
          cases.push({ actorCase, tool, args, vaultId, phase });
        }
      }
    }
  }
  // Resources and the Web read/write classes are separate boundaries on the same plane.
  for (const boundary of catalogBoundaryKeys) {
    const surface = surfaceForBoundary(boundary);
    const capability = capabilityForBoundary(boundary);
    if (surface !== "web" || capability === null) continue;
    if (["session_bootstrap", "vault_select"].includes(capability)) continue;
    for (const actorCase of MATRIX_ACTORS) cases.push({ actorCase, boundary, phase: "web" });
  }

  const results = [];
  for (const entry of cases) {
    const accessRuntime = matrixRuntime({ policies: entry.phase === "tool" || entry.phase === "web" ? [suspendPolicy] : [] });
    const subjects = [entry.actorCase.kind === "oauth"
      ? `oauth-client:${entry.actorCase.clientId}`
      : `api-key:${entry.actorCase.keyId}`];
    const actorSubjects = entry.actorCase.kind === "oauth"
      ? [`oauth-client:${entry.actorCase.clientId}`, `oauth-user:${entry.actorCase.userId}`]
      : [`api-key:${entry.actorCase.keyId}`];
    const actor = verifiedActor(entry.actorCase.kind === "environment-key" ? "environment-key" : entry.actorCase.kind, {
      subjectIds: actorSubjects,
      credentialId: entry.actorCase.kind === "oauth" ? `oauth:${entry.actorCase.clientId}:${entry.actorCase.userId}` : `api-key:${entry.actorCase.keyId}`,
      credentialEpochs: Object.fromEntries(actorSubjects.map((id) => [id, 0])),
      grantCeiling: null, audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null,
    });

    let request;
    let expected;
    if (entry.phase === "web") {
      const capability = capabilityForBoundary(entry.boundary);
      const capabilities = matrixWebCapabilities(capability);
      request = {
        actor, capability, target: { kind: "vault", vaultId: "vault" }, surface: "web",
        legacy: { phase: "web", capabilities },
      };
      expected = oldTemporalVerdict(accessRuntime, actorSubjects, capabilities);
    } else if (entry.phase === "tool") {
      const isMetadata = ["server_info", "agent_bootstrap"].includes(entry.tool);
      const capabilities = isMetadata ? null : matrixToolCapabilities(entry.tool);
      request = {
        actor, capability: entry.tool, target: { kind: "vault", vaultId: entry.vaultId }, surface: "mcp",
        legacy: { phase: "tool", capabilities, bypass: isMetadata },
      };
      expected = isMetadata
        ? { allowed: true, code: "allowed", mode: null, policyId: null }
        : oldTemporalVerdict(accessRuntime, actorSubjects, capabilities);
    } else {
      request = {
        actor, capability: entry.tool, target: { kind: "vault", vaultId: entry.vaultId }, surface: "mcp",
        legacy: { phase: "transport", scopes: entry.actorCase.scopes, allowedVaults: entry.actorCase.allowedVaults },
      };
      expected = oldTransportVerdict({ auth: entry.actorCase, capability: entry.tool, vaultId: entry.vaultId });
    }

    const runtime = createAuthorizationRuntime({
      store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: matrixDocument(actorSubjects) }) }),
      identitySnapshot: () => ({ subjects: Object.fromEntries(actorSubjects.map((id) => [id, { credentialEpoch: 0, disabled: false }])), sessions: {} }),
      vaultSnapshot: () => ({ vault: { admitted: true, readOnly: false }, secondary: { admitted: true, readOnly: false } }),
      publicationSnapshot: () => null,
      deployment: () => ({ readOnly: false }),
      now: () => MATRIX_NOW,
      mode: "legacy",
      legacy: legacy.createLegacyDecisionBackend({ accessRuntime }),
    });
    await runtime.ready;
    const actual = runtime.authorize(request);
    results.push({
      key: [entry.actorCase.label, entry.phase, entry.boundary ?? entry.tool, entry.vaultId ?? "-"].join("|"),
      expected: { allowed: expected.allowed, code: expected.code, mode: expected.mode ?? null },
      actual: { allowed: actual.allowed, code: actual.code, mode: actual.mode ?? null },
    });
  }

  assert.ok(results.length >= 60, `the matrix must be broad: ${results.length} rows`);
  const differences = results.filter((row) => JSON.stringify(row.expected) !== JSON.stringify(row.actual));
  assert.deepEqual(differences, [], `legacy mode must reproduce the old answer: ${JSON.stringify(differences.slice(0, 5))}`);
  assert.ok(results.some((row) => row.actual.allowed === true), "the matrix must contain allows");
  assert.ok(results.some((row) => row.actual.allowed === false), "the matrix must contain denies");
});

function matrixDocument(subjects) {
  return {
    schemaVersion: 1,
    catalogVersion: 1,
    revision: 1,
    timeConstraintsEnabled: true,
    subjects: Object.fromEntries(subjects.map((id) => [id, { credentialEpoch: 0, grants: [] }])),
    constraints: [],
  };
}

function matrixToolCapabilities(tool) {
  const requirements = {
    list_notes: ["obsidian.read"], get_note: ["obsidian.read"], write_note: ["obsidian.read", "obsidian.write"],
    get_file: ["obsidian.read", "obsidian.files"], git_commit: ["obsidian.read", "obsidian.write"],
  };
  return ["all", "surface:mcp", ...(requirements[tool] ?? []).map((scope) => `scope:${scope}`), `tool:${tool}`];
}

function matrixWebCapabilities(capability) {
  const requirements = {
    write_note: ["obsidian.read", "obsidian.write"], patch_base: ["obsidian.read", "obsidian.write"],
    manage_publish: ["obsidian.read", "obsidian.write"], get_file: ["obsidian.read", "obsidian.files"],
    vault_create: ["obsidian.read", "obsidian.write"], manage_folders: ["obsidian.read", "obsidian.write"],
  };
  return ["all", "surface:web", ...(requirements[capability] ?? ["obsidian.read"]).map((scope) => `scope:${scope}`)];
}
