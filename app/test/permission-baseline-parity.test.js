import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ADMIN_PASSWORD = "test-only-password";
// The in-process plane needs its isolated environment BEFORE any `src/` module is imported: the
// spawn fixtures also import `src/` (transitively), so they are loaded dynamically below. The
// spawned server gets its own explicit environment from `serverEnv`, so this cannot leak into it.
const planeEnv = await (await import("./helpers/permission-baseline-env.js")).seedPermissionBaselineEnv();
await fs.writeFile(path.join(planeEnv.primary, "note.md"), "# Parity note\n", "utf8");
const {
  API_KEY, callTool, freePort, initialize, seedVault, serverEnv, startServer, stopChild,
} = await import("./helpers/server-spawn-fixtures.js");
const REAL_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "permission-parity-real-"));
const port = await freePort();
const childEnv = serverEnv({ port, root: REAL_ROOT, extra: { AUTHZ_ENABLED: "true" } });
const REAL_DATA = path.join(REAL_ROOT, "data");
await seedVault(REAL_ROOT);
const POLICY_FILE = path.join(REAL_DATA, "access-policy.json");

const { createAccessPolicyStore } = await import("../src/access-policy/store.js");
const { createAccessPolicyAdmin } = await import("../src/admin/access-policy.js");

let real = null;
/**
 * Boot the real server on a store that already carries `policy` (or nothing).
 *
 * Task 3 froze the legacy write routes, so the spawned server can no longer be given a policy over
 * HTTP — and its store has no runtime write seam. The policy is therefore written by the *same*
 * store code before that process boots, which is the file an operator's save used to produce; the
 * server then reads it exactly as it reads any other store file.
 */
async function bootReal(policy = null) {
  if (real) {
    await stopChild(real.child);
    real = null;
  }
  await fs.rm(POLICY_FILE, { force: true });
  if (policy) {
    const store = createAccessPolicyStore({ file: POLICY_FILE });
    await store.ready;
    const created = await createAccessPolicyAdmin({ store }).createPolicy({ mode: "suspend", enabled: true, ...policy });
    assert.equal(created.ok, true, `the fixture policy must be stored: ${JSON.stringify(created).slice(0, 200)}`);
  }
  // A parallel test run can starve a spawned boot past the fixture's 45 s patience; one retry keeps
  // this proof from flaking for a reason that has nothing to do with the plane.
  real = await startServer(childEnv).catch(() => startServer(childEnv));
  return real;
}
await bootReal();
const { createPermissionPlane, observeCase, toolCall } = await import("./helpers/permission-plane.js");

let plane;

test.after(async () => {
  await plane?.close();
  if (real) await stopChild(real.child);
  await fs.rm(REAL_ROOT, { recursive: true, force: true });
  await fs.rm(planeEnv.root, { recursive: true, force: true });
});

/** The one policy both sides build: subject = the configured environment key, capability = get_note. */
function suspendPolicy(label, { inside }) {
  const now = Date.now();
  return {
    label,
    subjects: ["api-key:configured-env"],
    capabilities: ["tool:get_note"],
    timezone: "UTC",
    ...(inside
      ? { startsAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() }
      : { expiresAt: new Date(now - 1).toISOString() }),
  };
}

async function realAnswer(policy) {
  await bootReal(policy);
  try {
    const init = await initialize(real.base, { key: API_KEY });
    assert.equal(init.status, 200);
    const answer = await callTool(real.base, { key: API_KEY }, init.session, "get_note", { path: "note.md" });
    return { status: answer.status, result: answer.payload?.result, code: answer.payload?.result?.structuredContent?.code ?? null };
  } finally {
    await bootReal();
  }
}

async function planeAnswer(policy) {
  plane ??= await createPermissionPlane({ envKey: process.env.API_KEY, primaryVault: planeEnv.primary, authzEnabled: true });
  // The legacy write routes are frozen, so the plane's own Admin service is the seam (same store,
  // same CAS, same schema as an operator's save).
  const created = await plane.accessPolicy.admin.createPolicy({ mode: "suspend", enabled: true, ...policy });
  assert.equal(created.ok, true, `the plane's Admin service must store the policy: ${JSON.stringify(created).slice(0, 200)}`);
  try {
    const actor = { id: "env-key", headers: () => ({ "X-API-Key": process.env.API_KEY }) };
    return await observeCase(plane, { actor, request: toolCall("get_note", { path: "note.md" }), vaultRoot: planeEnv.vaults, targetCase: "vault:primary" });
  } finally {
    const listed = await plane.accessPolicy.admin.listPolicies();
    const stored = (listed.policies ?? []).find((entry) => entry.label === policy.label);
    const removed = stored ? await plane.accessPolicy.admin.deletePolicy(stored.id, listed.revision) : null;
    assert.equal(removed?.ok, true, `the plane's Admin service must delete the policy: ${JSON.stringify(removed).slice(0, 200)}`);
  }
}

test("a suspend policy denies get_note on the real server and in the plane with the same code", async () => {
  const policy = suspendPolicy("parity suspend", { inside: false });
  const realSide = await realAnswer(policy);
  const planeSide = await planeAnswer(policy);

  assert.equal(realSide.status, 200, "the real server answers on the MCP transport, not with an HTTP refusal");
  assert.equal(realSide.result?.isError, true, "the real server must refuse the call");
  assert.equal(realSide.code, "outside_authorized_window");

  assert.equal(planeSide.allowed, false, "the plane must refuse the same call");
  assert.equal(planeSide.errorFamily, "outside_authorized_window");
  assert.equal(planeSide.payload.includes("outside_authorized_window"), true);
  assert.equal(planeSide.handlerCalls, 0, "a temporal denial must not reach the handler");
  assert.equal(planeSide.contentIo, 0);

  assert.equal(planeSide.errorFamily, "outside_authorized_window");
  assert.equal(realSide.code, "outside_authorized_window");
});

test("a window that contains now allows the same call on both sides", async () => {
  const policy = suspendPolicy("parity allowed", { inside: true });
  const realSide = await realAnswer(policy);
  const planeSide = await planeAnswer(policy);
  assert.notEqual(realSide.result?.isError, true, "the real server must allow the call inside the window");
  assert.equal(planeSide.allowed, true);
  assert.equal(planeSide.handlerCalls, 1, "an allowed call really runs the handler");
});

test("a metadata tool stays reachable while the same principal is suspended", async () => {
  const policy = suspendPolicy("parity metadata", { inside: false });
  await bootReal(policy);
  try {
    const init = await initialize(real.base, { key: API_KEY });
    const answer = await callTool(real.base, { key: API_KEY }, init.session, "server_info", {});
    assert.notEqual(answer.payload?.result?.isError, true, "server_info must bypass the temporal gate (A-07)");
  } finally {
    await bootReal();
  }
});
