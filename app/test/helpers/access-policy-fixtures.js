// Shared deterministic fixtures for AuthZ Wave A (A4 runtime) and Wave B adapters.
//
// Contract: `scratch/authz/INTERFACE.md` §9 and the A4 BRIEF §2. Everything here
// is inert data or a programmable stand-in:
//   - no real credentials, tokens, passwords or hashes (placeholders only);
//   - no ambient clock reads (clocks are injected);
//   - no filesystem access (the io fake is in-memory);
//   - no sleeps (concurrency is controlled by explicit barriers).
//
// `policyFixture` returns a *normalized* policy: it is run through the A3
// `validateAccessPolicyDocument` so a fixture can never assert a shape the real
// store would reject.

import {
  ACCESS_POLICY_SCHEMA_VERSION,
  newPolicyId,
  validateAccessPolicyDocument,
} from "../../src/access-policy/schema.js";

/** Fixed instant used by fixture timestamps; never "now". */
export const FIXTURE_INSTANT = "2026-10-05T00:00:00.000Z";

/** Frozen default weekly grid: Mon–Fri 09:00–18:00 in the policy timezone. */
export const FIXTURE_WEEKLY = Object.freeze({
  mon: [["09:00", "18:00"]],
  tue: [["09:00", "18:00"]],
  wed: [["09:00", "18:00"]],
  thu: [["09:00", "18:00"]],
  fri: [["09:00", "18:00"]],
});

/**
 * Injectable clock. `now()` returns an epoch-ms instant; `advance(ms)` moves it
 * forward and `set(ms)` jumps to an absolute instant. Neither reads the host
 * clock, so tests never sleep to reach a boundary.
 */
export function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => (current += ms),
    set: (ms) => (current = ms),
  };
}

/**
 * A normalized, valid suspend policy (exactly the 13 schema keys). Defaults:
 * subject `oauth-user:u1`, capability `scope:obsidian.read`, timezone
 * `Asia/Shanghai`, weekly Mon–Fri 09:00–18:00.
 */
export function policyFixture(overrides = {}) {
  const raw = {
    id: newPolicyId(),
    label: "work hours",
    enabled: true,
    subjects: ["oauth-user:u1"],
    mode: "suspend",
    capabilities: ["scope:obsidian.read"],
    timezone: "Asia/Shanghai",
    weekly: { ...FIXTURE_WEEKLY },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: FIXTURE_INSTANT,
    updatedAt: FIXTURE_INSTANT,
    ...overrides,
  };
  const document = validateAccessPolicyDocument({
    schemaVersion: ACCESS_POLICY_SCHEMA_VERSION,
    revision: 0,
    policies: [raw],
  });
  return document.policies[0];
}

/** A `store.snapshot()`-shaped object. Extra keys (e.g. `errorCode`) pass through. */
export function snapshotFixture({ status = "ready", revision, policies = [], ...rest } = {}) {
  const resolved = revision === undefined ? (status === "ready" ? 0 : null) : revision;
  return { status, revision: resolved, policies, ...rest };
}

/**
 * Minimal in-memory store stand-in with call recording. It is *not* a second
 * store implementation: no validation, no atomic writes, no queue — just enough
 * shape for runtime/adapter tests (`ready/snapshot/replace/mutate/repairBroken/drain`).
 */
export function fakeStore({ snapshot, ready } = {}) {
  let current = snapshot ?? snapshotFixture();
  const calls = { snapshot: 0, replace: [], mutate: [], repairBroken: [], drain: 0 };
  const stale = () => ({
    ok: false,
    code: "stale_policy_revision",
    current: { status: current.status, revision: current.revision },
  });
  const commit = (expectedRevision, policies) => {
    if (current.status !== "ready" || expectedRevision !== current.revision) return stale();
    current = snapshotFixture({ revision: current.revision + 1, policies: [...policies] });
    return { ok: true, revision: current.revision };
  };
  return {
    calls,
    ready: Promise.resolve(
      ready ?? { ok: current.status === "ready", status: current.status, revision: current.revision },
    ),
    snapshot() {
      calls.snapshot += 1;
      return current;
    },
    async replace(expectedRevision, policies) {
      calls.replace.push([expectedRevision, policies]);
      return commit(expectedRevision, policies);
    },
    async mutate(expectedRevision, mutationFn) {
      calls.mutate.push([expectedRevision]);
      return commit(expectedRevision, mutationFn(current.policies));
    },
    async repairBroken({ policies } = {}) {
      calls.repairBroken.push(policies);
      current = snapshotFixture({ revision: (current.revision ?? 0) + 1, policies: [...(policies ?? [])] });
      return { ok: true, revision: current.revision };
    },
    drain() {
      calls.drain += 1;
      return Promise.resolve();
    },
  };
}

function enoent(file) {
  return Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
}

/**
 * Programmable in-memory io for `createAccessPolicyStore`. Covers
 * `readFile/writeFile/rename/mkdir/unlink/stat` with:
 *   - `io.files`   : live `Map` of path -> contents (seed via `files`);
 *   - `io.calls`   : per-op argument log;
 *   - `io.failures`: mutable per-op error injection (`io.failures.rename = err`);
 *   - `io.barrier(op)`: pause the next call of `op` until `release()` runs.
 */
export function fakeIo({ files = {}, failures = {} } = {}) {
  const state = new Map(Object.entries(files));
  const calls = { stat: [], readFile: [], writeFile: [], rename: [], mkdir: [], unlink: [] };
  const gates = new Map();
  const gate = async (op) => {
    const pending = gates.get(op);
    if (!pending) return;
    gates.delete(op);
    await pending.promise;
  };
  const check = (op) => {
    if (failures[op]) throw failures[op];
  };
  return {
    files: state,
    calls,
    failures,
    barrier(op) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      gates.set(op, { promise, release });
      return { promise, release };
    },
    async stat(file) {
      calls.stat.push(file);
      await gate("stat");
      check("stat");
      if (!state.has(file)) throw enoent(file);
      return { size: Buffer.byteLength(state.get(file), "utf8") };
    },
    async readFile(file) {
      calls.readFile.push(file);
      await gate("readFile");
      check("readFile");
      if (!state.has(file)) throw enoent(file);
      return state.get(file);
    },
    async mkdir(directory, options) {
      calls.mkdir.push([directory, options]);
      await gate("mkdir");
      check("mkdir");
    },
    async writeFile(file, data, options) {
      calls.writeFile.push([file, data, options]);
      await gate("writeFile");
      check("writeFile");
      state.set(file, data);
    },
    async rename(from, to) {
      calls.rename.push([from, to]);
      await gate("rename");
      check("rename");
      state.set(to, state.get(from));
      state.delete(from);
    },
    async unlink(file) {
      calls.unlink.push(file);
      await gate("unlink");
      check("unlink");
      state.delete(file);
    },
  };
}
