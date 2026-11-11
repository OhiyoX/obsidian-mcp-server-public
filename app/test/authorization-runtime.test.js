// P1 / Task 8 — trusted actors and a request-level committed snapshot.
//
// Contract: design §6 (VerifiedActor, request capture, order) and §7 (freeze the
// consented ceiling, read live facts on every call, never cache an allow). The
// runtime is the thin shell between the adapters and the pure `authorize()`:
//   * an actor comes from `verifiedActor()` only, never from a request body,
//     `_meta`, header or a hand-written object;
//   * the clock is injected, so a caller cannot choose "now";
//   * every call captures the store's committed projection plus the live identity,
//     Vault, publication and deployment facts; nothing is cached except immutable
//     data, and no allow is cached;
//   * a malformed or throwing clock denies, and a throwing audit sink never turns
//     a deny into an allow.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename as fsRename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { verifiedActor, isVerifiedActor } from "../src/authorization/actors.js";
import { createAuthorizationRuntime, AUTHORIZATION_MODES } from "../src/authorization/runtime.js";
import { createAuthorizationStore } from "../src/authorization/store.js";
import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../src/authorization/evaluate.js";
import { serializeAuthorizationDocument } from "../src/authorization/schema.js";
import { INSIDE, OUTSIDE } from "./helpers/authorization-fidelity-matrix.js";

const { ALLOWED, INVALID_CREDENTIAL, CAPABILITY_DENIED, OUTSIDE_WINDOW, POLICY_UNAVAILABLE, STATE_UNAVAILABLE } = AUTHORIZATION_DECISION_CODES;

const VAULT = "vault";
const SUBJECT = "oauth-user:user-1";
const DATA_ROOT = process.env.DATA_PATH;

const nodeIo = {
  mkdir: (target, options) => mkdir(target, options),
  readFile: (target) => readFile(target),
  open: (target, flags, mode) => open(target, flags, mode),
  rename: (from, to) => fsRename(from, to),
  unlink: (target) => unlink(target),
  chmod: (target, mode) => chmod(target, mode),
};

function countedIo(overrides = {}) {
  const counts = { readFile: 0, open: 0, rename: 0 };
  const io = {};
  for (const [name, fn] of Object.entries(nodeIo)) {
    io[name] = async (...args) => {
      if (name in counts) counts[name] += 1;
      return fn(...args);
    };
  }
  return { io: { ...io, ...overrides }, counts };
}

async function workdir(label) {
  assert.equal(typeof DATA_ROOT, "string", "DATA_PATH must point at the isolated test root");
  await mkdir(DATA_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(DATA_ROOT, `${label}-`));
  return { dir, file: path.join(dir, "authorization.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function documentAt(revision, { grants = [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] }], constraints = [], timeConstraintsEnabled = false } = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision,
    timeConstraintsEnabled,
    subjects: { [SUBJECT]: { credentialEpoch: 0, grants } },
    constraints,
  };
}

async function seed(file, document) {
  await writeFile(file, serializeAuthorizationDocument(document), { mode: 0o600 });
}

/** A complete verifier result; every fact the actor carries is stated. */
function verification(overrides = {}) {
  return {
    subjectIds: [SUBJECT],
    credentialId: "credential-1",
    credentialEpochs: { [SUBJECT]: 0 },
    grantCeiling: null,
    audience: null,
    expiresAt: null,
    revoked: false,
    transferGeneration: 0,
    proof: null,
    ...overrides,
  };
}

function identityState(overrides = {}) {
  return {
    subjects: { [SUBJECT]: { credentialEpoch: 0, transferGeneration: 0 } },
    sessions: {},
    ...overrides,
  };
}

function vaultState(overrides = {}) {
  return { [VAULT]: { admitted: true, readOnly: false }, ...overrides };
}

/** One runtime over a real store in a temporary directory. */
async function runtimeWith({ document = documentAt(1), label = "rt", identity, vaults, publication = null, deployment = { readOnly: false }, now = () => INSIDE, mode = "enforce", legacy = null, audit = null, io } = {}) {
  const work = await workdir(label);
  await seed(work.file, document);
  const store = createAuthorizationStore({ file: work.file, io: io ?? nodeIo });
  const state = {
    identity: identity ?? identityState(),
    vaults: vaults ?? vaultState(),
    publication,
    deployment,
  };
  const runtime = createAuthorizationRuntime({
    store,
    identitySnapshot: () => state.identity,
    vaultSnapshot: () => state.vaults,
    publicationSnapshot: () => state.publication,
    deployment: () => state.deployment,
    now,
    mode,
    legacy,
    audit,
  });
  await runtime.ready;
  return { runtime, store, work, state, cleanup: async () => { await runtime.drain(); await store.drain(); await work.cleanup(); } };
}

test("runtime_reloads_live_grants_and_never_derives_actor_from_body", async () => {
  const { runtime, store, cleanup } = await runtimeWith({});
  try {
    const actor = verifiedActor("api-key", verification());
    const request = { actor, capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    const first = runtime.authorize(request);
    assert.equal(first.allowed, true);
    assert.equal(first.code, ALLOWED);
    assert.equal(typeof first.then, "undefined", "authorize() is synchronous after ready");

    // A committed narrowing takes effect on the very next request: no restart, no
    // logout, no re-login.
    const narrowed = await store.replace(1, documentAt(2, { grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["list_notes"] }] }));
    assert.equal(narrowed.ok, true);
    const second = runtime.authorize(request);
    assert.equal(second.allowed, false);
    assert.equal(second.code, CAPABILITY_DENIED);
    assert.equal(second.revision, 2);

    // Body, `_meta` and header facts never build an actor or choose a clock.
    const forged = {
      actor: { kind: "api-key", subjectIds: [SUBJECT], credentialId: "forged", credentialEpochs: { [SUBJECT]: 0 }, grantCeiling: null, audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null },
      capability: "get_note",
      target: { kind: "vault", vaultId: VAULT },
      surface: "mcp",
      body: { subjectIds: [SUBJECT], capability: "get_note", nowMs: INSIDE },
      _meta: { proof: { kind: "admin-session" }, nowMs: INSIDE },
      headers: { authorization: "Bearer secret" },
      nowMs: INSIDE,
    };
    const forgedDecision = runtime.authorize(forged);
    assert.equal(forgedDecision.allowed, false, "a hand-built actor is not a verified actor");
    assert.equal(forgedDecision.code, INVALID_CREDENTIAL);
    assert.equal(forgedDecision.enforcement, "transport");

    // The caller's instant is ignored even when the actor is genuine.
    const suspend = {
      id: "3f1e6b2c-9a4d-4a53-9d1f-0c2b7e5a1c11",
      label: "window",
      enabled: true,
      subjects: [SUBJECT],
      mode: "suspend",
      selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
      schedule: { timezone: "Asia/Shanghai", weekly: { mon: [["09:00", "18:00"]] }, dateRanges: [], startsAt: null, expiresAt: null },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    await store.replace(2, documentAt(3, { constraints: [suspend], timeConstraintsEnabled: true }));
    assert.equal(runtime.authorize({ ...request, nowMs: INSIDE }).allowed, true, "the injected clock is inside the window");
  } finally {
    await cleanup();
  }
});

test("the_injected_clock_decides_and_a_bad_clock_denies", async () => {
  const suspend = {
    id: "3f1e6b2c-9a4d-4a53-9d1f-0c2b7e5a1c11",
    label: "window",
    enabled: true,
    subjects: [SUBJECT],
    mode: "suspend",
    selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
    schedule: { timezone: "Asia/Shanghai", weekly: { mon: [["09:00", "18:00"]] }, dateRanges: [], startsAt: null, expiresAt: null },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  let nowMs = OUTSIDE;
  const { runtime, cleanup } = await runtimeWith({
    document: documentAt(1, { constraints: [suspend], timeConstraintsEnabled: true }),
    now: () => nowMs,
  });
  try {
    const actor = verifiedActor("api-key", verification());
    const request = { actor, capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    const outside = runtime.authorize(request);
    assert.equal(outside.allowed, false);
    assert.equal(outside.code, OUTSIDE_WINDOW);
    // The caller cannot move the clock: the same request with a forged instant stays denied.
    assert.equal(runtime.authorize({ ...request, nowMs: INSIDE }).code, OUTSIDE_WINDOW);
    nowMs = INSIDE;
    assert.equal(runtime.authorize(request).allowed, true);
  } finally {
    await cleanup();
  }

  for (const badClock of [() => Number.NaN, () => "2026-11-02", () => undefined, () => { throw new Error("clock broke"); }]) {
    const broken = await runtimeWith({ now: badClock, label: "clock" });
    try {
      const decision = broken.runtime.authorize({
        actor: verifiedActor("api-key", verification()),
        capability: "get_note",
        target: { kind: "vault", vaultId: VAULT },
        surface: "mcp",
        nowMs: INSIDE,
      });
      assert.equal(decision.allowed, false, "a malformed clock never allows");
      assert.equal(decision.code, POLICY_UNAVAILABLE);
    } finally {
      await broken.cleanup();
    }
  }
});

test("the_identity_projection_applies_to_the_next_request", async () => {
  const { runtime, state, cleanup } = await runtimeWith({});
  try {
    const request = { actor: verifiedActor("web-session", verification({ credentialId: "session-1", subjectIds: [SUBJECT], expiresAt: INSIDE + 60_000, proof: null })), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "web" };
    state.identity = identityState({ sessions: { "session-1": { subjectId: SUBJECT, expiresAt: INSIDE + 60_000, active: true } } });
    assert.equal(runtime.authorize(request).allowed, true);

    // A logout or an expiry is visible on the next call, without a new login.
    state.identity = identityState({ sessions: { "session-1": { subjectId: SUBJECT, expiresAt: INSIDE + 60_000, active: false } } });
    const revoked = runtime.authorize(request);
    assert.equal(revoked.allowed, false);
    assert.equal(revoked.code, INVALID_CREDENTIAL);
    state.identity = identityState({ sessions: { "session-1": { subjectId: SUBJECT, expiresAt: INSIDE - 1, active: true } } });
    assert.equal(runtime.authorize(request).code, INVALID_CREDENTIAL);
    // A session the projection does not know is not trusted.
    state.identity = identityState({ sessions: {} });
    assert.equal(runtime.authorize(request).code, INVALID_CREDENTIAL);

    // An epoch bump and a disabled account refuse the very next request.
    const apiRequest = { actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    state.identity = identityState({ subjects: { [SUBJECT]: { credentialEpoch: 1, transferGeneration: 0 } } });
    assert.equal(runtime.authorize(apiRequest).code, INVALID_CREDENTIAL);
    state.identity = identityState({ subjects: { [SUBJECT]: { credentialEpoch: 0, transferGeneration: 0, disabled: true } } });
    assert.equal(runtime.authorize(apiRequest).code, INVALID_CREDENTIAL);
    state.identity = identityState();
    assert.equal(runtime.authorize(apiRequest).allowed, true);
  } finally {
    await cleanup();
  }
});

test("a_failed_store_write_never_changes_the_projection", async () => {
  const work = await workdir("failed-write");
  await seed(work.file, documentAt(1));
  const failing = countedIo({ rename: async () => { throw Object.assign(new Error("rename broke"), { code: "EIO" }); } });
  const store = createAuthorizationStore({ file: work.file, io: failing.io });
  const runtime = createAuthorizationRuntime({
    store,
    identitySnapshot: () => identityState(),
    vaultSnapshot: () => vaultState(),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => INSIDE,
    mode: "enforce",
  });
  await runtime.ready;
  try {
    const request = { actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    assert.equal(runtime.authorize(request).allowed, true);
    // The candidate is never committed, so the acked projection keeps deciding.
    const rejected = await store.replace(1, documentAt(2, { grants: [] }));
    assert.equal(rejected.ok, false);
    assert.equal(store.snapshot().revision, 1);
    assert.equal(runtime.snapshot().revision, 1);
    const decision = runtime.authorize(request);
    assert.equal(decision.allowed, true);
    assert.equal(decision.revision, 1);
  } finally {
    await runtime.drain();
    await store.drain();
    await work.cleanup();
  }
});

test("the_projection_is_committed_and_never_a_candidate", async () => {
  const work = await workdir("candidate");
  await seed(work.file, documentAt(1));
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const { io } = countedIo();
  io.rename = async (from, to) => {
    await gate;
    return fsRename(from, to);
  };
  const store = createAuthorizationStore({ file: work.file, io });
  const runtime = createAuthorizationRuntime({
    store,
    identitySnapshot: () => identityState(),
    vaultSnapshot: () => vaultState(),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => INSIDE,
    mode: "enforce",
  });
  await runtime.ready;
  try {
    const request = { actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    const pending = store.replace(1, documentAt(2, { grants: [] }));
    // The write is in flight: the runtime still decides on revision 1 and allows.
    assert.equal(runtime.snapshot().revision, 1);
    assert.equal(runtime.authorize(request).allowed, true);
    release();
    const acked = await pending;
    assert.equal(acked.ok, true);
    assert.equal(runtime.snapshot().revision, 2);
    assert.equal(runtime.authorize(request).allowed, false);
  } finally {
    await runtime.drain();
    await store.drain();
    await work.cleanup();
  }
});

test("the_hot_path_reads_no_file_and_caches_no_allow", async () => {
  const counted = countedIo();
  const { runtime, state, cleanup } = await runtimeWith({ io: counted.io, label: "hot" });
  try {
    const request = { actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    assert.equal(counted.counts.readFile, 1, "one read at load");
    for (let index = 0; index < 5; index += 1) assert.equal(runtime.authorize(request).allowed, true);
    assert.equal(counted.counts.readFile, 1, "no file read on the hot path");
    assert.equal(runtime.summary().decisions, 5, "every request went through the decision");

    // A live admission flip is visible on the next call: no allow was cached.
    state.vaults = { [VAULT]: { admitted: false } };
    const denied = runtime.authorize(request);
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "vault_unavailable");
    assert.equal(runtime.summary().decisions, 6);
  } finally {
    await cleanup();
  }
});

test("an_invented_boundary_field_is_ignored", async () => {
  const suspension = {
    id: "3f1e6b2c-9a4d-4a53-9d1f-0c2b7e5a1c11",
    label: "weekday window",
    enabled: true,
    subjects: [SUBJECT],
    mode: "suspend",
    selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
    schedule: { timezone: "Asia/Shanghai", weekly: { mon: [["09:00", "18:00"]] }, dateRanges: [], startsAt: null, expiresAt: null },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  const { runtime, cleanup } = await runtimeWith({
    document: documentAt(1, {
      grants: [
        { target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] },
        { target: { kind: "instance" }, capabilities: ["vault_list_read"] },
      ],
      constraints: [suspension],
      timeConstraintsEnabled: true,
    }),
    label: "invented-boundary",
    now: () => OUTSIDE,
  });
  try {
    const gated = {
      actor: verifiedActor("api-key", verification()),
      capability: "vault_list_read",
      target: { kind: "instance" },
      surface: "web",
      nowMs: INSIDE,
      // A spread tool argument or a payload field: it must buy nothing.
      boundary: "GET /api/web/v1/session",
    };
    const denied = runtime.authorize(gated);
    assert.equal(denied.allowed, false, "the boundary field must not select an exemption");
    assert.equal(denied.code, OUTSIDE_WINDOW);
    // The same field on the exempt operation is allowed because the OPERATION is
    // exempt, not because the string was believed.
    const exempt = runtime.authorize({ ...gated, capability: "vault_select", target: { kind: "vault", vaultId: VAULT } });
    assert.equal(exempt.allowed, true);
  } finally {
    await cleanup();
  }
});

test("a_throwing_audit_sink_never_changes_the_decision", async () => {
  let calls = 0;
  const audit = () => {
    calls += 1;
    throw new Error("audit sink broke");
  };
  const { runtime, cleanup } = await runtimeWith({ audit });
  try {
    const allowedRequest = { actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
    assert.equal(runtime.authorize(allowedRequest).allowed, true, "an allow stays an allow");
    const deniedRequest = { ...allowedRequest, capability: "delete_file" };
    const denied = runtime.authorize(deniedRequest);
    assert.equal(denied.allowed, false, "a deny stays a deny");
    assert.equal(denied.code, CAPABILITY_DENIED);
    assert.equal(calls, 2, "the sink was really called");
    assert.equal(runtime.summary().auditFailures, 2);
  } finally {
    await cleanup();
  }
});

test("before_ready_and_a_broken_store_deny", async () => {
  const work = await workdir("broken");
  // No file: the store is broken, so the runtime must deny content and keep the
  // no-content repair surface open.
  const store = createAuthorizationStore({ file: work.file, io: nodeIo });
  const runtime = createAuthorizationRuntime({
    store,
    identitySnapshot: () => identityState(),
    vaultSnapshot: () => vaultState(),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => INSIDE,
    mode: "enforce",
  });
  const actor = verifiedActor("api-key", verification());
  // Before `ready` settles there is no committed projection at all.
  const early = runtime.authorize({ actor, capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" });
  assert.equal(early.allowed, false);
  assert.equal(early.code, STATE_UNAVAILABLE);
  await runtime.ready;
  const broken = runtime.authorize({ actor, capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" });
  assert.equal(broken.allowed, false);
  assert.equal(broken.code, STATE_UNAVAILABLE);
  assert.equal(runtime.snapshot().status, "broken");
  // The repair surface (§9) is still allowed.
  assert.equal(runtime.authorize({ actor, capability: "server_info", target: { kind: "instance" }, surface: "mcp" }).allowed, true);
  await runtime.drain();
  await store.drain();
  await work.cleanup();
});

test("verified_actor_accepts_only_verifier_shapes", () => {
  const actor = verifiedActor("api-key", verification());
  assert.equal(isVerifiedActor(actor), true);
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(JSON.stringify(actor).includes("VERIFIED"), false, "the brand is not serializable");

  // A hand-written object is not a verified actor.
  assert.equal(isVerifiedActor({ ...actor }), false);
  assert.equal(isVerifiedActor(null), false);

  for (const kind of ["nobody", "", null, 7]) {
    assert.throws(() => verifiedActor(kind, verification()), TypeError);
  }
  // A proof that does not match the kind is a forgery.
  assert.throws(() => verifiedActor("admin-session", verification({ proof: { kind: "publication", id: "p1" } })), TypeError);
  assert.throws(() => verifiedActor("api-key", verification({ proof: { kind: "admin-session" } })), TypeError);
  assert.throws(() => verifiedActor("admin-session", verification()), TypeError, "an admin actor needs its proof");
  // Unknown or missing facts are refused: a verifier must state each one.
  assert.throws(() => verifiedActor("api-key", { ...verification(), subjectIdsFromBody: [SUBJECT] }), TypeError);
  for (const field of ["subjectIds", "credentialId", "credentialEpochs", "grantCeiling", "audience", "expiresAt", "revoked", "transferGeneration", "proof"]) {
    const incomplete = verification();
    delete incomplete[field];
    assert.throws(() => verifiedActor("api-key", incomplete), TypeError, field);
  }
  // A non-boolean revocation, a bad epoch or a secret-looking credential is refused.
  assert.throws(() => verifiedActor("api-key", verification({ revoked: "false" })), TypeError);
  assert.throws(() => verifiedActor("api-key", verification({ credentialEpochs: { [SUBJECT]: -1 } })), TypeError);
  assert.throws(() => verifiedActor("api-key", verification({ credentialId: "" })), TypeError);

  // A correct admin proof builds an admin actor (no subjects, no ceiling).
  const admin = verifiedActor("admin-session", verification({ subjectIds: [], credentialEpochs: {}, proof: { kind: "admin-session" } }));
  assert.equal(isVerifiedActor(admin), true);
  assert.deepEqual(admin.proof, { kind: "admin-session" });

  // A background task or the console is not a person's credential.
  assert.throws(() => verifiedActor("system", verification({ subjectIds: [SUBJECT], proof: { kind: "system", vaultId: "vault", task: "commit" } })), TypeError);
  assert.throws(() => verifiedActor("admin-session", verification({ proof: { kind: "admin-session" } })), TypeError);

  // A ceiling with no subject to bind it is refused here as well.
  assert.throws(() => verifiedActor("admin-session", verification({ subjectIds: [], credentialEpochs: {}, proof: { kind: "admin-session" }, grantCeiling: [{ target: { kind: "instance" }, capabilities: ["admin_metadata_read"] }] })), TypeError);

  // Only an explicit no-auth deployment may build the anonymous actor.
  assert.throws(() => verifiedActor("deployment-anonymous", verification({ proof: { kind: "deployment-anonymous" } })), TypeError);
  assert.throws(() => verifiedActor("deployment-anonymous", verification({ proof: { kind: "deployment-anonymous" }, authMode: "required" })), TypeError);
  const anonymous = verifiedActor("deployment-anonymous", verification({ subjectIds: [], credentialEpochs: {}, proof: { kind: "deployment-anonymous" }, authMode: "none" }));
  assert.equal(isVerifiedActor(anonymous), true);
});

// Task 19 splits the modes on purpose, so the name says what is proven here: the mode is
// validated, `legacy` answers from the injected backend (a missing backend denies), and
// `shadow` answers from it too: only `enforce` answers from the new model (design §10 P2).
// `authorization-legacy-backend.test.js` proves both directions with a counting backend.
test("mode_is_validated_and_legacy_mode_answers_from_the_injected_backend", async () => {
  const results = [];
  for (const mode of AUTHORIZATION_MODES) {
    const backend = { evaluate: () => ({ allowed: true, reason: "no_matching_policy", mode: null, denyPolicyId: null, enforcement: "operation" }) };
    const { runtime, cleanup } = await runtimeWith({ mode, label: `mode-${mode}`, legacy: mode === "shadow" ? backend : null });
    try {
      const request = { actor: verifiedActor("api-key", verification()), capability: "delete_file", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" };
      results.push(runtime.authorize(request).code);
      assert.equal(runtime.summary().mode, mode);
      assert.equal(runtime.summary().legacy, mode === "shadow");
    } finally {
      await cleanup();
    }
  }
  // The modes split on purpose: `legacy` and `shadow` answer from the temporary legacy
  // backend (and a missing backend denies instead of guessing), while `enforce` answers from
  // the new model and never reaches the backend. A shadow verdict is an observation; it must
  // not become the response (design §10 P2).
  assert.deepEqual(results, [STATE_UNAVAILABLE, ALLOWED, CAPABILITY_DENIED]);
  assert.deepEqual([...AUTHORIZATION_MODES], ["legacy", "shadow", "enforce"]);

  assert.throws(() => createAuthorizationRuntime({ store: { snapshot: () => ({ status: "broken" }), ready: Promise.resolve(), drain: async () => {} }, identitySnapshot: () => ({}), vaultSnapshot: () => ({}), deployment: () => ({}), now: () => INSIDE, mode: "authoritative" }), TypeError);
  assert.throws(() => createAuthorizationRuntime({ identitySnapshot: () => ({}), vaultSnapshot: () => ({}), deployment: () => ({}), now: () => INSIDE }), TypeError);
  assert.throws(() => createAuthorizationRuntime({ store: { snapshot: () => ({ status: "broken" }), ready: Promise.resolve(), drain: async () => {} }, identitySnapshot: () => ({}), vaultSnapshot: () => ({}), deployment: () => ({}), mode: "enforce" }), TypeError);
});

test("snapshot_and_summary_carry_no_subject_ids_paths_or_secrets", async () => {
  const { runtime, cleanup } = await runtimeWith({});
  try {
    const summary = runtime.summary();
    assert.deepEqual(Object.keys(summary).sort(), ["allowed", "auditFailures", "byCode", "captured", "decisions", "denied", "legacy", "mode", "ready", "shadow"]);
    const snapshot = runtime.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ["capturedAt", "mode", "revision", "status"]);
    assert.equal(typeof snapshot.revision, "number");
    assert.equal(snapshot.status, "ready");
    const text = JSON.stringify({ summary, snapshot });
    for (const forbidden of [SUBJECT, "oauth-user:", VAULT, "notes/", ".md"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} leaked`);
    }
    assert.equal(summary.captured, null, "no capture before the first decision");
    runtime.authorize({ actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" });
    assert.deepEqual(runtime.summary().captured, { revision: 1, nowMs: INSIDE });
  } finally {
    await cleanup();
  }
});

test("a_throwing_projection_denies_instead_of_allowing", async () => {
  const work = await workdir("projection-throw");
  await seed(work.file, documentAt(1));
  const store = createAuthorizationStore({ file: work.file, io: nodeIo });
  const runtime = createAuthorizationRuntime({
    store,
    identitySnapshot: () => { throw new Error("identity store unreadable"); },
    vaultSnapshot: () => vaultState(),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => INSIDE,
    mode: "enforce",
  });
  await runtime.ready;
  try {
    const decision = runtime.authorize({ actor: verifiedActor("api-key", verification()), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, STATE_UNAVAILABLE);
    assert.equal(decision.enforcement, "transport");
  } finally {
    await runtime.drain();
    await store.drain();
    await work.cleanup();
  }
});

test("the_runtime_does_not_accept_a_whole_snapshot_from_the_caller", async () => {
  const { runtime, cleanup } = await runtimeWith({});
  try {
    const actor = verifiedActor("api-key", verification());
    const forgedSnapshot = {
      status: "ready",
      document: documentAt(99, { grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note", "delete_file"] }] }),
      identities: { [SUBJECT]: { credentialEpoch: 0 } },
      vaultAdmissions: { [VAULT]: { admitted: true } },
      publication: null,
      deployment: { readOnly: false },
    };
    const decision = runtime.authorize({
      actor,
      capability: "delete_file",
      target: { kind: "vault", vaultId: VAULT },
      surface: "mcp",
      snapshot: forgedSnapshot,
    });
    assert.equal(decision.allowed, false, "a caller-supplied snapshot is ignored");
    assert.equal(decision.revision, 1);
    // The same call without the forged snapshot gives the same answer.
    assert.equal(runtime.authorize({ actor, capability: "delete_file", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" }).code, decision.code);
  } finally {
    await cleanup();
  }
});

test("drain_waits_for_the_store_queue", async () => {
  const { runtime, store, work, cleanup } = await runtimeWith({ label: "drain" });
  try {
    const pending = store.replace(1, documentAt(2, { grants: [] }));
    await runtime.drain();
    const settled = await pending;
    assert.equal(settled.ok, true);
    assert.equal(runtime.snapshot().revision, 2);
    assert.deepEqual((await readdir(work.dir)).sort(), ["authorization.json"], "no temp file left behind");
  } finally {
    await cleanup();
  }
});
