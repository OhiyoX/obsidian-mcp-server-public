/**
 * #428 shared-effective-directory classifier regressions (pure, in-memory).
 *
 * `classifySharedDirectoryHarm` decides whether the negative control observed real harm. It may
 * accept ONLY crosstalk, or contention that carries (a) explicit SQLite BUSY/LOCKED evidence,
 * (b) a tie to the actual shared file, and (c) that evidence inside an open/reconcile/read phase.
 * Anything else must land in `untiedFailures`, so a timeout, an unrelated crash, or a failure that
 * merely mentions `web-catalog` cannot satisfy the control.
 *
 * The end-to-end control (two real child processes, one shared SQLite file) lives in
 * `web-catalog-default-path.test.js`; this file pins the classifier's failure shapes in isolation so
 * a relaxation of the whitelist fails here as a focused unit red.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifySharedDirectoryHarm } from "./helpers/web-catalog-pair-driver.mjs";

const SHARED_FILE = "C:/tmp/i428/cwd/data/web-catalog/default.sqlite";
const OTHER_FILE = "C:/tmp/i428/elsewhere/default.sqlite";
const NOTES = {
  a: { own: "Notes/Alpha.md", other: "Notes/Beta.md" },
  b: { own: "Notes/Beta.md", other: "Notes/Alpha.md" },
};

/** One failing side shaped exactly like `runSharedDirectoryPair`'s record; the other side is quiet. */
function record({ file = SHARED_FILE, phase = "reconcile", failures = [], exit = null, stderr = "", read = null } = {}) {
  return {
    sharedFile: SHARED_FILE,
    notes: NOTES,
    sides: {
      a: { opened: false, phase: "open", failures: [], read: null, location: null, exit: null, stderr: "" },
      b: { opened: true, phase, failures, read, location: { file }, exit, stderr },
    },
  };
}

test("#428 classifier accepts explicit BUSY/LOCKED contention tied to the shared file and phase", () => {
  const verdict = classifySharedDirectoryHarm(
    record({
      phase: "reconcile",
      failures: [{ phase: "reconcile", message: "legacy-shared:B reported: SQLITE_BUSY: database is locked" }],
      stderr: "Error: database is locked { code: 'ERR_SQLITE_ERROR', errcode: 5 }",
    }),
  );
  assert.deepEqual(verdict.contention, [
    {
      side: "b",
      tiedToSharedFile: true,
      location: { file: SHARED_FILE },
      exit: null,
      failures: [{ phase: "reconcile", message: "legacy-shared:B reported: SQLITE_BUSY: database is locked" }],
      contention: [{ phase: "reconcile", evidence: ["SQLITE_BUSY", "database-is-locked"] }],
      stderrTail: "Error: database is locked { code: 'ERR_SQLITE_ERROR', errcode: 5 }",
    },
  ]);
  assert.deepEqual(verdict.untiedFailures, []);
  assert.equal(verdict.harmObserved, true);
  assert.equal(verdict.harmless, false);
});

test("#428 classifier rejects an unrelated TypeError whose stack merely names a web-catalog helper", () => {
  const verdict = classifySharedDirectoryHarm(
    record({
      phase: "reconcile",
      failures: [
        {
          phase: "reconcile",
          message:
            "TypeError: Cannot read properties of undefined (reading 'items')\n" +
            "    at openChild (file:///D:/repo/app/test/helpers/web-catalog-pair-driver.mjs:231:18)",
        },
      ],
    }),
  );
  assert.deepEqual(verdict.contention, []);
  assert.equal(verdict.untiedFailures.length, 1);
  assert.equal(verdict.untiedFailures[0].tiedToSharedFile, false);
  assert.equal(verdict.harmObserved, false, "a helper file name in a stack trace is NOT contention");
  assert.equal(verdict.harmless, true);
});

test("#428 classifier rejects a timeout", () => {
  const verdict = classifySharedDirectoryHarm(
    record({
      phase: "reconcile",
      failures: [{ phase: "reconcile", message: 'legacy-shared:B timed out waiting for "reconciled"\nstdout:\nstderr:' }],
    }),
  );
  assert.deepEqual(verdict.contention, []);
  assert.equal(verdict.untiedFailures.length, 1);
  assert.equal(verdict.harmObserved, false, "a timeout is not evidence of a shared-file collision");
});

test("#428 classifier rejects a non-lock SQLite error (generic ERR_SQLITE_ERROR)", () => {
  const verdict = classifySharedDirectoryHarm(
    record({
      phase: "reconcile",
      failures: [
        { phase: "reconcile", message: "legacy-shared:B reported: SQL logic error\n{ code: 'ERR_SQLITE_ERROR', errcode: 1 }" },
      ],
    }),
  );
  assert.deepEqual(verdict.contention, []);
  assert.equal(verdict.untiedFailures.length, 1);
  assert.equal(verdict.harmObserved, false, "ERR_SQLITE_ERROR alone covers non-lock failures too");
});

test("#428 classifier rejects BUSY/LOCKED evidence recorded outside the shared-file phases", () => {
  const verdict = classifySharedDirectoryHarm(
    record({ phase: "teardown", failures: [{ phase: "teardown", message: "database is locked" }] }),
  );
  assert.deepEqual(verdict.contention, []);
  assert.equal(verdict.untiedFailures.length, 1);
  assert.equal(verdict.harmObserved, false, "contention must be bound to an open/reconcile/read phase");
});

test("#428 classifier rejects BUSY/LOCKED evidence from a process that opened another file", () => {
  const verdict = classifySharedDirectoryHarm(
    record({ file: OTHER_FILE, failures: [{ phase: "reconcile", message: "database is locked" }] }),
  );
  assert.deepEqual(verdict.contention, []);
  assert.equal(verdict.untiedFailures.length, 1);
  assert.equal(verdict.harmObserved, false, "contention must be bound to the actual shared file");
});

test("#428 classifier still rejects a crash with no evidence at all", () => {
  const verdict = classifySharedDirectoryHarm(
    record({ phase: "read", failures: [], exit: { code: 1, signal: null }, stderr: "" }),
  );
  assert.deepEqual(verdict.contention, []);
  assert.equal(verdict.untiedFailures.length, 1);
  assert.equal(verdict.harmObserved, false, "a child that died for an unrelated reason must not satisfy the control");
});

test("#428 classifier keeps accepting crosstalk without any failure", () => {
  const verdict = classifySharedDirectoryHarm(
    record({
      read: {
        own: { path: "Notes/Beta.md", located: false, fts: 0 },
        other: { path: "Notes/Alpha.md", located: true, fts: 1 },
        tree: { notes: ["Notes/Alpha.md"] },
      },
    }),
  );
  assert.equal(verdict.isolation.b, false);
  assert.equal(verdict.crosstalk.length, 1);
  assert.deepEqual(verdict.contention, []);
  assert.deepEqual(verdict.untiedFailures, []);
  assert.equal(verdict.harmObserved, true);
});
