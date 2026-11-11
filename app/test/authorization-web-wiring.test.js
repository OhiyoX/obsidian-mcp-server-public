// P3 / Task 21 — every Web boundary decides through the authorization runtime.
//
// Contract: design §6.1.4 and §10 P3. Four properties decide this task:
//
//   1. ONE AUTHORITY. The Web gate asks the injected authorization runtime for every
//      content route, and a deny it states is the answer: no loader, cache or mutator
//      runs. The route's own Scope class no longer decides.
//   2. EVERY BOUNDARY. The matrix walks every `web` content boundary of the catalog, so
//      a route that was left behind fails here instead of in production.
//   3. NO LOCAL RULE LEFT. A source scan of the Web route files finds no allowlist
//      decision; the Vault containment question goes through the runtime too.
//   4. `legacy` MODE ANSWERS AS BEFORE. Beside each boundary the gate's status matches the
//      old temporal gate for the same policy state, so the wiring changes no answer.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

const [
  { createWebAccessPolicy, webFilesRouteGate, webReadRouteGate, webWriteRouteGate, WEB_ROUTE_GATE },
  { createAuthorizationRuntime, createAuthorizationSeam, createLegacyDecisionBackend },
  { createShadowCandidate },
  { createAccessPolicyRuntime },
  { catalogBoundaryKeys, capabilityForBoundary, surfaceForBoundary, authorizationOperation, isOutsideTemporalPlane },
  { policyFixture },
] = await Promise.all([
  import("../src/app/access-policy.js"),
  import("../src/authorization/runtime.js"),
  import("../src/authorization/shadow.js"),
  import("../src/access-policy/runtime.js"),
  import("../src/authorization/catalog.js"),
  import("./helpers/access-policy-fixtures.js"),
]);

// 00:30 on a Tuesday in Asia/Shanghai: outside the fixture window (Mon-Fri 09:00-18:00).
const NOW = Date.parse("2026-11-02T16:30:00.000Z");
const USER = "user-web-wiring";

const ALLOWED = Object.freeze({
  allowed: true, code: "allowed", enforcement: "operation", mode: null,
  revision: null, matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt: null,
});

function deny(code = "vault_access_denied") {
  return Object.freeze({
    allowed: false, code, enforcement: "operation", mode: null, revision: null,
    matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt: null,
  });
}

function session() {
  return Object.freeze({
    credentialId: "web-session:hash-wiring",
    userId: USER,
    username: USER,
    displayName: USER,
    csrf: "csrf-wiring",
    vaultId: "vault",
    allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
    allowedVaults: ["vault", "secondary"],
  });
}

/** The counted runtime: the test states the verdict, the gate must obey it. */
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

/** A request against a mounted gate; `loader` counts every content/cache/mutation call. */
async function drive(gate, { vaultId = null } = {}) {
  const seen = { loader: 0, cache: 0, mutator: 0 };
  const req = { method: "GET", path: "/", params: {}, query: {}, body: {}, headers: {}, get: () => undefined, webSession: session() };
  if (vaultId !== null) req.params[0] = vaultId;
  let status = 200;
  let body = null;
  let reached = false;
  const res = {
    statusCode: 200,
    status(code) { status = code; this.statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    send(payload) { body = payload; return this; },
    end() { return this; },
    setHeader() {},
    redirect(code) { status = code; return this; },
  };
  const next = () => {
    reached = true;
    seen.loader += 1;
    seen.cache += 1;
    seen.mutator += 1;
  };
  await gate(req, res, next);
  return { status: reached ? 200 : status, body, reached, seen };
}

/** Every `web` content boundary, with the class its route must be gated by. */
function webBoundaries() {
  const rows = [];
  for (const key of catalogBoundaryKeys) {
    if (surfaceForBoundary(key) !== "web") continue;
    const capability = capabilityForBoundary(key);
    const operation = capability === null ? null : authorizationOperation(capability);
    if (operation === null || isOutsideTemporalPlane(capability)) continue;
    const scopes = operation.oauthScopes ?? [];
    const gateKind = scopes.includes("obsidian.files") ? "files" : scopes.includes("obsidian.write") ? "write" : "read";
    rows.push({ key, gateKind, capability, effect: operation.contentEffect });
  }
  return rows;
}

function gateFor({ key, gateKind }, { authorization, accessRuntime = inertAccessRuntime() } = {}) {
  const policy = createWebAccessPolicy({ runtime: accessRuntime, authorization });
  const shadow = null;
  if (gateKind === "write") return webWriteRouteGate(policy, key, { shadow });
  if (gateKind === "files") return webFilesRouteGate(policy, key, { shadow });
  return webReadRouteGate(policy, key, { shadow });
}

function inertAccessRuntime() {
  return { status: "ready", evaluate: () => ({ allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null }), explain: () => ({}), audit: () => {} };
}

// ---------------------------------------------------------------------------
// 1. Every Web boundary denies when the injected runtime denies.
// ---------------------------------------------------------------------------

test("every_web_boundary_denies_when_injected_runtime_denies", async () => {
  const boundaries = webBoundaries();
  assert.ok(boundaries.length >= 20, `the Web matrix must cover the real routes: ${boundaries.length}`);

  const outcomes = [];
  for (const boundary of boundaries) {
    const runtime = stubRuntime(() => deny("vault_access_denied"));
    const gate = await gateFor(boundary, { authorization: runtime });
    const result = await drive(gate);
    assert.notEqual(gate[WEB_ROUTE_GATE], undefined, `${boundary.key} must carry its own catalog key`);
    assert.equal(gate[WEB_ROUTE_GATE], boundary.key, `${boundary.key} must carry its own key`);
    assert.equal(result.reached, false, `${boundary.key}: a runtime deny must not reach loader/cache/mutator`);
    assert.deepEqual(result.seen, { loader: 0, cache: 0, mutator: 0 }, `${boundary.key}: zero content work on a deny`);
    assert.ok(result.status === 403 || result.status === 404, `${boundary.key}: refusal family, got ${result.status}`);
    assert.equal(runtime.calls.length, 1, `${boundary.key}: one decision per request`);
    assert.equal(runtime.calls[0].surface, "web");
    assert.equal(runtime.calls[0].capability, boundary.capability);
    outcomes.push({ key: boundary.key, status: result.status });
  }
  assert.equal(outcomes.length, boundaries.length);

  // An allow still reaches the loader: the deny above is the runtime's answer, not a
  // blanket refusal introduced by the wiring.
  const allowing = stubRuntime(() => ALLOWED);
  for (const boundary of boundaries.slice(0, 5)) {
    const gate = await gateFor(boundary, { authorization: allowing });
    const result = await drive(gate);
    assert.equal(result.reached, true, `${boundary.key}: an allow reaches the handler`);
  }
});

// ---------------------------------------------------------------------------
// 2. `legacy` mode: the gate's answer equals the old temporal gate's answer.
// ---------------------------------------------------------------------------

function policyStore({ status = "ready", policies = [] } = {}) {
  return { snapshot: () => ({ status, revision: status === "ready" ? 1 : null, policies }) };
}

// The frozen fixture grid: Mon-Fri 09:00-18:00 Asia/Shanghai. `NOW` is outside it.
function suspendPolicy() {
  return policyFixture({ subjects: [`oauth-user:${USER}`], capabilities: ["all"] });
}

/** The old gate, called directly: the answer the wiring must reproduce in `legacy` mode. */
function oldGateAnswer(accessRuntime, sessionValue, capabilities, page = false) {
  if (accessRuntime.status === "disabled") return { status: 200 };
  const subjects = [`oauth-user:${sessionValue.userId}`];
  if (subjects.length === 0) return { status: 503, error: "authorization_policy_unavailable" };
  let decision;
  try {
    decision = accessRuntime.evaluate({ subjects, capabilities });
  } catch {
    return { status: 503, error: "authorization_policy_unavailable" };
  }
  if (decision?.allowed === true) return { status: 200 };
  if (decision?.reason !== "outside_window" || !decision.mode) return { status: 503, error: "authorization_policy_unavailable" };
  return { status: 403, error: "outside_authorized_window", mode: decision.mode, policyId: decision.denyPolicyId ?? null };
}

/** The capability class a route's old gate carried, read from the catalog scopes. */
function oldCapabilities(boundary) {
  const scopes = authorizationOperation(boundary.capability).oauthScopes ?? [];
  return ["all", "surface:web", ...new Set(scopes.map((scope) => `scope:${scope}`))];
}

async function legacyRuntime({ policies = [], status = "ready" } = {}) {
  const accessRuntime = createAccessPolicyRuntime({ enabled: true, store: policyStore({ status, policies }), now: () => NOW });
  await accessRuntime.ready;
  const authorization = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: null }) }),
    identitySnapshot: () => ({ subjects: { [`oauth-user:${USER}`]: { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ vault: { admitted: true, readOnly: false }, secondary: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "legacy",
    legacy: createLegacyDecisionBackend({ accessRuntime }),
  });
  await authorization.ready;
  return { accessRuntime, authorization };
}

test("legacy_mode_web_gate_answers_exactly_like_the_old_temporal_gate", async () => {
  const boundaries = webBoundaries();
  const states = [
    { label: "allow", policies: [], status: "ready" },
    { label: "suspend", policies: [suspendPolicy()], status: "ready" },
    { label: "broken", policies: [], status: "broken" },
  ];
  const rows = [];
  for (const state of states) {
    const { accessRuntime, authorization } = await legacyRuntime(state);
    for (const boundary of boundaries) {
      const gate = await gateFor(boundary, { authorization, accessRuntime });
      const result = await drive(gate);
      const expected = oldGateAnswer(accessRuntime, session(), oldCapabilities(boundary));
      rows.push({
        key: `${state.label}|${boundary.key}`,
        expected: expected.status,
        actual: result.status,
        expectedError: expected.error ?? null,
        actualError: result.body?.error ?? null,
      });
    }
  }
  assert.ok(rows.length >= 60, `the matrix must be broad: ${rows.length} rows`);
  const differences = rows.filter((row) => row.expected !== row.actual || row.expectedError !== row.actualError);
  assert.deepEqual(differences, [], `legacy mode must reproduce the old Web answer: ${JSON.stringify(differences.slice(0, 4))}`);
  assert.ok(rows.some((row) => row.actual === 403), "the matrix must contain a temporal deny");
  assert.ok(rows.some((row) => row.actual === 503), "the matrix must contain a broken plane");
});

// ---------------------------------------------------------------------------
// 3. No Web route keeps its own allowlist decision.
// ---------------------------------------------------------------------------

test("no_web_route_file_decides_with_a_local_allowlist_and_the_vault_containment_asks_the_runtime", async () => {
  const files = [
    "src/app/routes.js",
    "src/app/access-policy.js",
    "src/app/asset-route.js",
    "src/app/base-page.js",
    "src/app/canvas-page.js",
    "src/app/base-patch-route.js",
  ];
  const offenders = [];
  for (const file of files) {
    const source = await fs.readFile(path.join(APP_ROOT, file), "utf8");
    if (/allowedScopes\.includes|allowedVaults\.includes/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "a Web route must not decide with a local allowlist");

  // The Vault containment question is decided by the runtime: a deny refuses the request
  // before the Vault is resolved, and an allow keeps the old chain.
  const { createWebVaultContainment } = await import("../src/app/access-policy.js");
  assert.equal(typeof createWebVaultContainment, "function", "the Web router needs the one containment decision");

  const denying = createWebVaultContainment({ authorization: stubRuntime(() => deny("vault_access_denied")) });
  assert.equal(await denying(session(), "secondary"), false, "a deny fails the containment check");
  const allowing = createWebVaultContainment({ authorization: stubRuntime(() => ALLOWED) });
  assert.equal(await allowing(session(), "secondary"), true, "an allow passes it");
  const legacy = createWebVaultContainment({});
  assert.equal(await legacy(session(), "vault"), true, "the extracted legacy backend keeps the allowlist answer");
  assert.equal(await legacy(session(), "denied-vault"), false, "and it refuses a Vault outside the list");
});
