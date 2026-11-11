// Task 4 — the constraint admin service (design §6.5, §6.8, §6.9).
//
// The acceptance set is the plan's Step 1: Vault scope lands in the selector, an
// unknown Vault is refused instead of stored inert, a stale revision loses, the 513th
// constraint is refused by the schema's own limit, the master switch makes constraints
// inert without touching a ceiling, and every accepted write is audited exactly once.
// The decisions below come from the real `authorize()`, so a stored scope that reads
// right but matches wrong cannot pass.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { CONSTRAINT_ADMIN_CODES, createConstraintAdmin } from "../src/authorization/constraint-admin.js";
import { createDeploymentDocument } from "../src/authorization/deployment-document.js";
import { authorize } from "../src/authorization/evaluate.js";
import { serializeAuthorizationDocument } from "../src/authorization/schema.js";
import { createAuthorizationStore } from "../src/authorization/store.js";

const { UNKNOWN_VAULT, CONSTRAINT_NOT_FOUND } = CONSTRAINT_ADMIN_CODES;
const STALE_REVISION = "stale_authorization_revision";
const LIMIT_EXCEEDED = "authorization_limit_exceeded";

const VAULT_A = "a";
const VAULT_B = "b";
const SUBJECT = "oauth-user:user-1";
const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const STAMP = "2026-11-01T00:00:00.000Z";
const INSIDE = Date.parse("2026-11-02T12:00:00+08:00"); // Monday 12:00 in Asia/Shanghai
const OUTSIDE = Date.parse("2026-11-02T20:00:00+08:00");

const DATA_ROOT = process.env.DATA_PATH;
const io = {
  mkdir: (target, options) => mkdir(target, options),
  readFile: (target) => readFile(target),
  open: (target, flags, mode) => open(target, flags, mode),
  rename: (from, to) => rename(from, to),
  unlink: (target) => unlink(target),
  chmod: (target, mode) => chmod(target, mode),
};

const SCHEDULE = Object.freeze({
  timezone: "Asia/Shanghai",
  weekly: { mon: [["09:00", "18:00"]] },
  dateRanges: [],
  startsAt: null,
  expiresAt: null,
});

function draft(overrides = {}) {
  return {
    label: "weekday hours",
    subjects: [SUBJECT],
    mode: "suspend",
    capabilities: ["get_note"],
    surfaces: null,
    vaultIds: [VAULT_A],
    schedule: { ...SCHEDULE },
    ...overrides,
  };
}

function storedConstraintAt(index) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    label: `window ${index}`,
    enabled: true,
    subjects: [SUBJECT],
    mode: "suspend",
    selector: { anyOf: [{ surfaces: null, capabilities: ["get_note"], targets: [{ kind: "vault", vaultId: VAULT_A }] }] },
    schedule: { ...SCHEDULE },
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function documentAt({ revision = 1, constraints = [], timeConstraintsEnabled = true } = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision,
    timeConstraintsEnabled,
    subjects: {
      [SUBJECT]: {
        credentialEpoch: 0,
        grants: [
          { target: { kind: "vault", vaultId: VAULT_A }, capabilities: ["get_note"] },
          { target: { kind: "vault", vaultId: VAULT_B }, capabilities: ["get_note"] },
        ],
      },
    },
    constraints,
  };
}

async function harness(options = {}) {
  assert.equal(typeof DATA_ROOT, "string", "DATA_PATH must point at the isolated test root");
  await mkdir(DATA_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(DATA_ROOT, "constraint-admin-"));
  const file = path.join(dir, "authorization.json");
  await writeFile(file, options.contents ?? serializeAuthorizationDocument(documentAt(options)));
  const store = createAuthorizationStore({ file, io: options.io ?? io });
  await store.ready;
  return { file, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function adminOverStore(store, overrides = {}) {
  return createConstraintAdmin({
    store,
    now: () => STAMP,
    newId: () => UUID_1,
    vaultIds: [VAULT_A, VAULT_B],
    ...overrides,
  });
}

function request(vaultId, { nowMs = INSIDE, capability = "get_note" } = {}) {
  return {
    actor: {
      kind: "oauth",
      subjectIds: [SUBJECT],
      credentialId: "credential-1",
      credentialEpochs: { [SUBJECT]: 0 },
      grantCeiling: null,
      audience: null,
      expiresAt: null,
      revoked: false,
      transferGeneration: 0,
      proof: null,
    },
    capability,
    target: { kind: "vault", vaultId },
    surface: "mcp",
    nowMs,
  };
}

function decisionSnapshot(document) {
  return {
    status: "ready",
    document,
    identities: { [SUBJECT]: { credentialEpoch: 0, transferGeneration: 0 } },
    vaultAdmissions: {
      [VAULT_A]: { admitted: true, readOnly: false },
      [VAULT_B]: { admitted: true, readOnly: false },
    },
    publication: null,
    deployment: { readOnly: false },
  };
}

function decide(store, vaultId, options) {
  return authorize(request(vaultId, options), decisionSnapshot(store.snapshot().document));
}

async function fileText(file) {
  return readFile(file, "utf8");
}

test("1. create with vaultIds:[a] stores only that Vault as a target, and only its decisions match", async () => {
  const h = await harness();
  try {
    const admin = adminOverStore(h.store);
    const created = await admin.create({ expectedRevision: 1, draft: draft() });
    assert.deepEqual(created, { ok: true, revision: 2, id: UUID_1 });

    const [stored] = h.store.snapshot().document.constraints;
    assert.deepEqual(stored.selector.anyOf[0].targets, [{ kind: "vault", vaultId: VAULT_A }]);

    // Outside the window: the constraint reaches Vault a and stops it there.
    const onA = decide(h.store, VAULT_A, { nowMs: OUTSIDE });
    assert.equal(onA.allowed, false);
    assert.deepEqual([...onA.matchedConstraintIds], [UUID_1]);
    // Vault b is not in the scope, so the same instant keeps full access.
    const onB = decide(h.store, VAULT_B, { nowMs: OUTSIDE });
    assert.equal(onB.allowed, true);
    assert.deepEqual([...onB.matchedConstraintIds], []);
  } finally {
    await h.cleanup();
  }
});

test("2. create with vaultIds:null stores targets:null", async () => {
  const h = await harness();
  try {
    const admin = adminOverStore(h.store);
    const created = await admin.create({ expectedRevision: 1, draft: draft({ vaultIds: null }) });
    assert.equal(created.ok, true);

    const [stored] = h.store.snapshot().document.constraints;
    assert.equal(stored.selector.anyOf[0].targets, null);
    // Every Vault: both are now inside the window, and outside it both are stopped.
    assert.equal(decide(h.store, VAULT_A, { nowMs: OUTSIDE }).allowed, false);
    assert.equal(decide(h.store, VAULT_B, { nowMs: OUTSIDE }).allowed, false);
  } finally {
    await h.cleanup();
  }
});

test("3. create with an unknown Vault answers unknown_vault and writes nothing", async () => {
  const h = await harness();
  try {
    const admin = adminOverStore(h.store);
    const before = await fileText(h.file);
    const refused = await admin.create({ expectedRevision: 1, draft: draft({ vaultIds: ["nope"] }) });

    assert.deepEqual(refused, { ok: false, code: UNKNOWN_VAULT, path: "vaultIds[0]" });
    assert.equal(await fileText(h.file), before);
    assert.equal(h.store.snapshot().revision, 1);
    assert.deepEqual(h.store.snapshot().document.constraints, []);
  } finally {
    await h.cleanup();
  }
});

test("4. a second create on the same expectedRevision is stale, and the document keeps one constraint", async () => {
  const h = await harness();
  try {
    const admin = adminOverStore(h.store);
    const first = await admin.create({ expectedRevision: 1, draft: draft() });
    const second = await admin.create({ expectedRevision: 1, draft: draft({ label: "the second save" }) });

    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, code: STALE_REVISION, path: null });

    const committed = JSON.parse(await fileText(h.file));
    assert.equal(committed.constraints.length, 1);
    assert.equal(committed.constraints[0].label, "weekday hours");
    assert.equal(admin.list().revision, 2);
  } finally {
    await h.cleanup();
  }
});

test("5. the 513th constraint answers the schema's limit code and is not stored", async () => {
  const constraints = Array.from({ length: 512 }, (_, index) => storedConstraintAt(index + 1));
  const h = await harness({ constraints });
  try {
    const admin = adminOverStore(h.store);
    const before = await readFile(h.file);
    const refused = await admin.create({ expectedRevision: 1, draft: draft() });

    assert.deepEqual(refused, { ok: false, code: LIMIT_EXCEEDED, path: "constraints" });
    assert.equal(h.store.snapshot().document.constraints.length, 512);
    assert.equal(h.store.snapshot().revision, 1);
    assert.deepEqual(await readFile(h.file), before, "the refused write leaves the file byte-identical");
  } finally {
    await h.cleanup();
  }
});

test("6. setTemporalPlane(false) makes every constraint inert and leaves every ceiling alone", async () => {
  const h = await harness();
  try {
    const admin = adminOverStore(h.store);
    await admin.create({ expectedRevision: 1, draft: draft() });
    const withPlaneOn = h.store.snapshot().document;
    assert.equal(decide(h.store, VAULT_A, { nowMs: OUTSIDE }).allowed, false);

    const switched = await admin.setTemporalPlane({ expectedRevision: 2, enabled: false });
    assert.deepEqual(switched, { ok: true, revision: 3 });

    const switchedDocument = h.store.snapshot().document;
    assert.equal(switchedDocument.timeConstraintsEnabled, false);
    // Ceilings and the constraint itself are untouched: the switch is not a delete.
    assert.deepEqual(switchedDocument.subjects, withPlaneOn.subjects);
    assert.deepEqual(switchedDocument.constraints, withPlaneOn.constraints);
    // Inert, not deleted: the same instant now passes.
    assert.equal(decide(h.store, VAULT_A, { nowMs: OUTSIDE }).allowed, true);
    assert.equal(decide(h.store, VAULT_B, { nowMs: OUTSIDE }).allowed, true);
    // The ceiling still refuses what it refused before the switch.
    assert.equal(decide(h.store, VAULT_A, { nowMs: OUTSIDE, capability: "write_note" }).allowed, false);
  } finally {
    await h.cleanup();
  }
});

test("7. every accepted write appends one audit record, and a throwing audit still accepts the write", async () => {
  const h = await harness();
  try {
    const records = [];
    const admin = adminOverStore(h.store, { audit: (record) => records.push(record) });

    await admin.create({ expectedRevision: 1, draft: draft() });
    await admin.update({ expectedRevision: 2, id: UUID_1, draft: draft({ label: "renamed" }) });
    await admin.toggle({ expectedRevision: 3, id: UUID_1, enabled: false });
    await admin.setTemporalPlane({ expectedRevision: 4, enabled: false });
    await admin.remove({ expectedRevision: 5, id: UUID_1 });

    assert.equal(records.length, 5);
    assert.deepEqual(records.map((record) => record.action), ["created", "updated", "toggled", "plane_changed", "deleted"]);
    assert.deepEqual(records.map((record) => record.revision), [2, 3, 4, 5, 6]);
    assert.deepEqual(records.map((record) => record.constraintId), [UUID_1, UUID_1, UUID_1, null, UUID_1]);
    assert.equal(records[0].before, null);
    assert.equal(records[2].after.enabled, false);
    assert.equal(records[4].after, null);

    // A refused write records nothing.
    const refused = await admin.remove({ expectedRevision: 6, id: UUID_1 });
    assert.deepEqual(refused, { ok: false, code: CONSTRAINT_NOT_FOUND, path: "id" });
    assert.equal(records.length, 5);

    // An audit that throws is swallowed by the writer.
    let throwingCalls = 0;
    const throwing = adminOverStore(h.store, {
      newId: () => UUID_2,
      audit: () => {
        throwingCalls += 1;
        throw new Error("audit sink is down");
      },
    });
    const accepted = await throwing.create({ expectedRevision: 6, draft: draft({ label: "after a broken sink" }) });
    assert.deepEqual(accepted, { ok: true, revision: 7, id: UUID_2 });
    assert.equal(throwingCalls, 1);
    assert.equal(throwing.list().constraints.length, 1);
  } finally {
    await h.cleanup();
  }
});
// The store `server.js` exposes is the composed one, whose `snapshot()` carries the derived
// subjects. This is the store every write must survive without moving a ceiling (§6.8).
test("8. through the deployment store, five writes leave the committed subjects untouched", async () => {
  const h = await harness();
  const derived = {
    "api-key:new": { credentialEpoch: 1, grants: [{ target: { kind: "vault", vaultId: VAULT_A }, capabilities: ["get_note"] }] },
    "api-key:wide": {
      credentialEpoch: 7,
      grants: [{ target: { kind: "vault", vaultId: VAULT_A }, capabilities: ["get_note", "write_note"] }],
    },
  };
  const deployment = createDeploymentDocument({ file: h.file, io, deriveSubjects: () => derived });
  try {
    await deployment.ready;
    const admin = adminOverStore(deployment.store);
    const before = JSON.parse(await fileText(h.file)).subjects;
    assert.deepEqual(deployment.store.snapshot().document.subjects, derived, "a reader sees the derived half");

    assert.equal((await admin.create({ expectedRevision: 1, draft: draft() })).ok, true);
    await admin.update({ expectedRevision: 2, id: UUID_1, draft: draft({ label: "renamed" }) });
    await admin.toggle({ expectedRevision: 3, id: UUID_1, enabled: false });
    await admin.setTemporalPlane({ expectedRevision: 4, enabled: false });
    await admin.remove({ expectedRevision: 5, id: UUID_1 });

    const onDisk = JSON.parse(await fileText(h.file));
    assert.equal(onDisk.revision, 6);
    assert.deepEqual(onDisk.constraints, [], "the durable half is written");
    assert.deepEqual(onDisk.subjects, before, "no write persists a derived subject");
    assert.deepEqual(deployment.store.snapshot().document.subjects, derived, "the derived view still answers the derivation");

    // A draft the schema refuses still reaches the caller with its field path.
    const refused = await admin.create({ expectedRevision: 6, draft: draft({ label: "" }) });
    assert.deepEqual(refused, { ok: false, code: "invalid_authorization_document", path: "constraints[0].label" });
  } finally {
    await deployment.store.drain();
    await h.cleanup();
  }
});

test("9. a directory flush that fails keeps the write and marks it durability-uncertain", async () => {
  // The store flushes the directory with `open(dir, "r")` and the temp file with a mode.
  const uncertainIo = {
    ...io,
    open: (target, flags, mode) => (mode === undefined
      ? Promise.reject(new Error("directory flush refused"))
      : open(target, flags, mode)),
  };
  const h = await harness({ io: uncertainIo });
  try {
    const records = [];
    const admin = adminOverStore(h.store, { audit: (record) => records.push(record) });
    const written = await admin.create({ expectedRevision: 1, draft: draft() });

    assert.deepEqual(written, { ok: true, revision: 2, id: UUID_1, durabilityUncertain: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].durabilityUncertain, true, "the audit record carries the doubt");
    assert.equal(JSON.parse(await fileText(h.file)).revision, 2, "the rename landed, so the write stands");
  } finally {
    await h.cleanup();
  }
});

test("10. two admins over one store serialize: the same revision has one winner", async () => {
  const h = await harness();
  try {
    const setup = adminOverStore(h.store, { newId: () => UUID_1 });
    const first = adminOverStore(h.store, { newId: () => UUID_2 });
    const second = adminOverStore(h.store, { newId: () => "33333333-3333-4333-8333-333333333333" });
    assert.equal((await setup.create({ expectedRevision: 1, draft: draft() })).ok, true);

    // Both read revision 2 before either replace runs: the store's queue decides.
    const [a, b] = await Promise.all([
      first.create({ expectedRevision: 2, draft: draft({ label: "from the first admin" }) }),
      second.create({ expectedRevision: 2, draft: draft({ label: "from the second admin" }) }),
    ]);
    assert.equal([a, b].filter((result) => result.ok).length, 1, "one revision, one winner");
    assert.deepEqual([a, b].find((result) => !result.ok), { ok: false, code: STALE_REVISION, path: null });
    assert.equal(JSON.parse(await fileText(h.file)).constraints.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("11. list() on a broken store carries the store's own reason code", async () => {
  const h = await harness({ contents: "{\"schemaVersion\": 1, \"catalogVersion\": 1}" });
  try {
    assert.equal(h.store.snapshot().status, "broken");
    const listed = adminOverStore(h.store).list();
    assert.equal(listed.code, "invalid_authorization_document", "not just revision: null");
    assert.equal(listed.code, h.store.snapshot().code);
    assert.deepEqual(listed.constraints, []);
  } finally {
    await h.cleanup();
  }
});

test("12. the audit records the window the schema saved, not the draft it was built from", async () => {
  const h = await harness();
  try {
    const records = [];
    const admin = adminOverStore(h.store, { audit: (record) => records.push(record) });
    const schedule = {
      ...SCHEDULE,
      weekly: { mon: [["09:00", "18:00"]], tue: [] },
      startsAt: "2026-11-01T00:00:00+08:00",
    };
    await admin.create({ expectedRevision: 1, draft: draft({ schedule }) });

    const [stored] = JSON.parse(await fileText(h.file)).constraints;
    assert.deepEqual(Object.keys(stored.schedule.weekly), ["mon"], "the schema dropped the empty day");
    assert.equal(stored.schedule.startsAt, "2026-10-31T16:00:00.000Z", "the instant was normalized");
    assert.deepEqual(records[0].after.schedule, stored.schedule, "the audit carries the saved window");
  } finally {
    await h.cleanup();
  }
});

test("13. an async audit sink that rejects neither fails the write nor escapes", async () => {
  const h = await harness();
  try {
    const admin = adminOverStore(h.store, {
      audit: async () => {
        throw new Error("sink down");
      },
    });
    const accepted = await admin.create({ expectedRevision: 1, draft: draft() });
    assert.deepEqual(accepted, { ok: true, revision: 2, id: UUID_1 });
    // A rejection that escaped the swallow fails this test as an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.snapshot().revision, 2);
  } finally {
    await h.cleanup();
  }
});

test("14. a function for vaultIds is re-read on every write", async () => {
  const h = await harness();
  try {
    let admitted = [VAULT_A];
    const admin = adminOverStore(h.store, { vaultIds: () => admitted });
    assert.equal((await admin.create({ expectedRevision: 1, draft: draft() })).ok, true);

    admitted = [];
    const refused = await admin.create({ expectedRevision: 2, draft: draft({ label: "after the Vault went away" }) });
    assert.deepEqual(refused, { ok: false, code: UNKNOWN_VAULT, path: "vaultIds[0]" });
  } finally {
    await h.cleanup();
  }
});
