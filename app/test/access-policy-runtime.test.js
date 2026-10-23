// Focused tests for AuthZ Wave A / A4 access-policy runtime
// (app/src/access-policy/runtime.js) and the shared fixtures helper.
//
// Deterministic: the clock is injected, fault injection uses fakes, and there
// are no sleeps. Contract: `scratch/authz/INTERFACE.md` §9 + the A4 BRIEF §3.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAccessPolicyRuntime } from "../src/access-policy/runtime.js";
import { createAccessPolicyStore } from "../src/access-policy/store.js";
import { nextTransition } from "../src/access-policy/time.js";
import {
  fakeClock,
  fakeIo,
  fakeStore,
  policyFixture,
  snapshotFixture,
} from "./helpers/access-policy-fixtures.js";

// Frozen audit whitelist (INTERFACE §9.4). The runtime may emit exactly these
// keys and nothing else.
const AUDIT_FIELDS = Object.freeze([
  "action", "outcome", "surface", "mode", "policyId",
  "credentialType", "credentialId", "clientId", "userId",
  "capabilities", "time", "nextAllowedAt", "source", "userAgent", "agent",
]);

const SUBJECTS = ["oauth-user:u1"];
const CAPABILITIES = ["all", "surface:mcp", "scope:obsidian.read"];

// Monday 2026-10-05, 05:00 UTC = 13:00 Asia/Shanghai (inside 09:00–18:00).
const MONDAY_INSIDE = Date.parse("2026-10-05T05:00:00.000Z");
// Same Monday, 11:00 UTC = 19:00 Asia/Shanghai (outside the window).
const MONDAY_OUTSIDE = Date.parse("2026-10-05T11:00:00.000Z");
// Tuesday 2026-10-06, 01:00 UTC = 09:00 Asia/Shanghai (next opening).
const TUESDAY_OPEN = "2026-10-06T01:00:00.000Z";

const ALLOWED = {
  allowed: true,
  mode: null,
  reason: "no_matching_policy",
  denyPolicyId: null,
  matchedPolicyIds: [],
};

function poisonedStore() {
  return new Proxy({}, {
    get() {
      throw new Error("the store must never be touched while disabled");
    },
  });
}

test("disabled runtime never touches the store and always allows", async () => {
  for (const store of [null, poisonedStore()]) {
    const runtime = createAccessPolicyRuntime({ enabled: false, store });
    assert.equal(runtime.status, "disabled");
    assert.deepEqual(runtime.summary(), { enabled: false, status: "disabled", policyCount: 0 });
    assert.deepEqual(runtime.snapshot(), { status: "disabled", revision: null, policies: [] });
    assert.deepEqual(runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES }), ALLOWED);
    assert.equal(await runtime.drain(), undefined);
    await runtime.ready;
    assert.equal(runtime.status, "disabled");

    const explained = runtime.explain({ subjects: SUBJECTS, capabilities: CAPABILITIES });
    assert.equal(explained.allowed, true);
    assert.equal(explained.mode, null);
    assert.equal(explained.reason, "no_matching_policy");
    assert.equal(explained.denyPolicyId, null);
    assert.deepEqual(explained.matchedPolicyIds, []);
    assert.equal(explained.timezone, null);
    assert.equal(explained.nextChangeAt, null);
    assert.equal(explained.nextAllowedAt, null);
    assert.equal(Number.isNaN(Date.parse(explained.now)), false);
  }
});

test("enabled + ready: the injected clock flips allow to deny at the window edge", async () => {
  const clock = fakeClock(MONDAY_INSIDE);
  const policy = policyFixture();
  const store = fakeStore({
    snapshot: snapshotFixture({ policies: [policy] }),
    ready: { ok: true, status: "ready", revision: 0 },
  });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: clock.now });
  await runtime.ready;

  assert.equal(runtime.status, "ready");
  assert.deepEqual(runtime.summary(), { enabled: true, status: "ready", policyCount: 1 });
  assert.deepEqual(runtime.snapshot(), { status: "ready", revision: 0, policies: [policy] });

  const allowed = runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "allowed");
  assert.equal(allowed.mode, null);
  assert.equal(allowed.denyPolicyId, null);
  assert.deepEqual(allowed.matchedPolicyIds, [policy.id]);

  clock.set(MONDAY_OUTSIDE);
  const denied = runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES });
  assert.equal(denied.allowed, false);
  assert.equal(denied.mode, "suspend");
  assert.equal(denied.reason, "outside_window");
  assert.equal(denied.denyPolicyId, policy.id);
  assert.deepEqual(denied.matchedPolicyIds, [policy.id]);

  const explained = runtime.explain({ subjects: SUBJECTS, capabilities: CAPABILITIES });
  assert.equal(explained.now, new Date(MONDAY_OUTSIDE).toISOString());
  assert.equal(explained.timezone, policy.timezone);
  assert.equal(explained.nextAllowedAt, TUESDAY_OPEN);
  // Cross-check against the A1 schedule engine rather than a hand-rolled value.
  assert.equal(explained.nextAllowedAt, new Date(nextTransition(policy, clock.now()).nextAllowedAt).toISOString());
});

test("enabled + broken: fail closed with policy_unavailable and no schedule leak", async () => {
  const store = fakeStore({
    snapshot: snapshotFixture({ status: "broken", policies: [], errorCode: "invalid_access_policy" }),
    ready: { ok: false, status: "broken", revision: null, errorCode: "invalid_access_policy" },
  });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: fakeClock(MONDAY_INSIDE).now });
  await runtime.ready;

  assert.equal(runtime.status, "broken");
  assert.deepEqual(runtime.summary(), { enabled: true, status: "broken", policyCount: 0 });
  assert.deepEqual(runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES }), {
    allowed: false,
    mode: null,
    reason: "policy_unavailable",
    denyPolicyId: null,
    matchedPolicyIds: [],
  });

  const explained = runtime.explain({ subjects: SUBJECTS, capabilities: CAPABILITIES });
  assert.equal(explained.allowed, false);
  assert.equal(explained.reason, "policy_unavailable");
  assert.equal(explained.timezone, null);
  assert.equal(explained.nextChangeAt, null);
  assert.equal(explained.nextAllowedAt, null);
});

test("audit truncates to the frozen whitelist and stamps the injected clock", async () => {
  const clock = fakeClock(MONDAY_INSIDE);
  const received = [];
  const runtime = createAccessPolicyRuntime({
    enabled: true,
    store: fakeStore(),
    now: clock.now,
    audit: (event) => received.push(event),
  });
  await runtime.ready;

  runtime.audit({
    action: "authz.deny",
    outcome: "failure",
    surface: "mcp",
    mode: "suspend",
    policyId: "11111111-1111-4111-8111-111111111111",
    credentialType: "api-key",
    credentialId: "key-1",
    clientId: "client-1",
    userId: "user-1",
    capabilities: ["scope:obsidian.read", "tool:get_note"],
    time: "1999-01-01T00:00:00.000Z",
    nextAllowedAt: TUESDAY_OPEN,
    source: "mcp",
    userAgent: "fixture-agent",
    agent: "codex",
    // Forbidden payload: must never reach the adapter.
    path: "Private/Secret Note.md",
    title: "Secret Note",
    revision: 42,
    content: "leaked body",
    token: "DO-NOT-LOG-token",
    secret: "DO-NOT-LOG-secret",
    policy: { subjects: SUBJECTS, weekly: { mon: [["09:00", "18:00"]] } },
  });

  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]).sort(), [...AUDIT_FIELDS].sort());
  assert.equal(received[0].time, new Date(MONDAY_INSIDE).toISOString());
  assert.equal(received[0].nextAllowedAt, TUESDAY_OPEN);
  assert.deepEqual(received[0].capabilities, ["scope:obsidian.read", "tool:get_note"]);
  for (const forbidden of ["path", "title", "revision", "content", "token", "secret", "policy"]) {
    assert.equal(forbidden in received[0], false, `${forbidden} must be stripped`);
  }
});

test("real store composition: window allow/deny, then a corrupt file fails closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "access-policy-runtime-"));
  try {
    const file = path.join(directory, "access-policy.json");
    const clock = fakeClock(MONDAY_INSIDE);
    const policy = policyFixture();
    const store = createAccessPolicyStore({ file });
    await store.ready;
    assert.deepEqual(await store.replace(0, [policy]), { ok: true, revision: 1 });

    const runtime = createAccessPolicyRuntime({ enabled: true, store, now: clock.now });
    await runtime.ready;
    assert.equal(runtime.status, "ready");
    assert.equal(runtime.summary().policyCount, 1);
    assert.equal(runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES }).allowed, true);

    clock.set(MONDAY_OUTSIDE);
    const denied = runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES });
    assert.equal(denied.allowed, false);
    assert.equal(denied.mode, "suspend");
    assert.equal(denied.denyPolicyId, policy.id);
    assert.equal(runtime.explain({ subjects: SUBJECTS, capabilities: CAPABILITIES }).nextAllowedAt, TUESDAY_OPEN);

    // AUTHZ_ENABLED=1 with a corrupt file: the restarted store is broken and the
    // runtime must fail closed instead of treating it as an empty policy set.
    await writeFile(file, "{ nope", "utf8");
    const restarted = createAccessPolicyRuntime({
      enabled: true,
      store: createAccessPolicyStore({ file }),
      now: clock.now,
    });
    await restarted.ready;
    assert.equal(restarted.status, "broken");
    assert.equal(restarted.summary().policyCount, 0);
    assert.equal(restarted.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES }).reason, "policy_unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AUTHZ_ENABLED off: a corrupt policy file on disk stays inert", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "access-policy-runtime-off-"));
  try {
    const file = path.join(directory, "access-policy.json");
    await writeFile(file, "{ this is not a policy document", "utf8");

    // Same file, feature on: the real store is genuinely broken.
    const enabledStore = createAccessPolicyStore({ file });
    await enabledStore.ready;
    assert.equal(enabledStore.snapshot().status, "broken");

    // Feature off: the runtime must not touch any store, so the corrupt file is inert.
    const runtime = createAccessPolicyRuntime({ enabled: false, store: poisonedStore(), now: fakeClock(MONDAY_INSIDE).now });
    assert.equal(runtime.status, "disabled");
    assert.deepEqual(runtime.evaluate({ subjects: SUBJECTS, capabilities: CAPABILITIES }), ALLOWED);
    assert.deepEqual(runtime.snapshot(), { status: "disabled", revision: null, policies: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("drain passes through to the store and is a no-op when disabled", async () => {
  const store = fakeStore();
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: fakeClock(MONDAY_INSIDE).now });
  await runtime.ready;
  assert.equal(await runtime.drain(), undefined);
  assert.equal(store.calls.drain, 1);

  const disabled = createAccessPolicyRuntime({ enabled: false, store: poisonedStore() });
  assert.equal(await disabled.drain(), undefined);
});

test("the fixture helper stays inert: fake clock and fake io do not touch the host", async () => {
  const clock = fakeClock(MONDAY_INSIDE);
  assert.equal(clock.now(), MONDAY_INSIDE);
  assert.equal(clock.advance(60_000), MONDAY_INSIDE + 60_000);
  assert.equal(clock.set(0), 0);

  const io = fakeIo({ files: { "/tmp/access-policy.json": "{}" } });
  assert.equal(await io.readFile("/tmp/access-policy.json"), "{}");
  await io.mkdir("/tmp", { recursive: true, mode: 0o700 });
  await io.writeFile("/tmp/a.tmp", "x", { mode: 0o600 });
  await io.rename("/tmp/a.tmp", "/tmp/a.json");
  await io.unlink("/tmp/a.json");
  await assert.rejects(() => io.stat("/tmp/missing.json"), /ENOENT/);
  assert.deepEqual(io.calls.readFile, ["/tmp/access-policy.json"]);
  assert.deepEqual(io.calls.mkdir, [["/tmp", { recursive: true, mode: 0o700 }]]);

  io.failures.rename = new Error("injected rename failure");
  await assert.rejects(() => io.rename("/tmp/x", "/tmp/y"), /injected rename failure/);
  io.failures.rename = null;

  const barrier = io.barrier("readFile");
  const pending = io.readFile("/tmp/access-policy.json");
  barrier.release();
  assert.equal(await pending, "{}");
});

test("runtime.js has no ambient clock call and no filesystem or node import", async () => {
  const source = await readFile(new URL("../src/access-policy/runtime.js", import.meta.url), "utf8");
  const lines = source.split(/\r?\n/);
  assert.ok(lines.length < 500, `runtime.js must stay under 500 lines (was ${lines.length})`);
  assert.equal((source.match(/Date\.now\s*\(/g) ?? []).length, 0, "no Date.now() call in the runtime body");
  assert.equal((source.match(/now = Date\.now/g) ?? []).length, 1, "the injected default must be the only clock reference");
  assert.equal(/node:fs/.test(source), false, "runtime.js must not import node:fs");
  assert.equal(/from\s+["']node:/.test(source), false, "runtime.js must not import node built-ins");
  assert.equal(/from\s+["'][^"']*\.\.\//.test(source), false, "runtime.js must only import sibling access-policy modules");
});
