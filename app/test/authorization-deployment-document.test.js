// Task 1 — the deployment's durable document with derived subjects.
//
// Contract: design §6.8 and §7 step 1. The file owns `constraints` and
// `timeConstraintsEnabled`; `subjects` are derived from live credential state on every
// read, so a credential created after the cutover works at once and no credential route
// ever writes this file. A missing or broken file is seeded once; a seed that throws — or
// that the schema refuses — fails the boot instead of publishing a partial document (§11
// C5). The seed is written through the store's atomic rename, and the derived subjects are
// never written back.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { createDeploymentDocument } from "../src/authorization/deployment-document.js";
import { createNodeAuthorizationIo } from "../src/authorization/node-io.js";
import { AUTHORIZATION_CODES, parseAuthorizationDocument, serializeAuthorizationDocument } from "../src/authorization/schema.js";

const { INVALID_DOCUMENT, STATE_UNAVAILABLE } = AUTHORIZATION_CODES;
const DATA_ROOT = process.env.DATA_PATH;

const STORED_SUBJECT = {
  credentialEpoch: 1,
  grants: [{ target: { kind: "instance" }, capabilities: ["read_note"] }],
};

const CONSTRAINT = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "weekday hours",
  enabled: true,
  subjects: ["oauth-user:user-1"],
  mode: "suspend",
  selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
  schedule: { timezone: "Asia/Shanghai", weekly: { mon: [["09:00", "18:00"]] }, dateRanges: [], startsAt: null, expiresAt: null },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function storedDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 4,
    timeConstraintsEnabled: true,
    subjects: { "api-key:old": STORED_SUBJECT },
    constraints: [],
    ...overrides,
  };
}

async function workdir(label) {
  assert.equal(typeof DATA_ROOT, "string", "DATA_PATH must point at the isolated test root");
  await mkdir(DATA_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(DATA_ROOT, `${label}-`));
  return { dir, file: path.join(dir, "authorization.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// The real io seam, wrapped so a test can see what reached the disk.
function recordingIo() {
  const base = createNodeAuthorizationIo();
  const calls = { mkdir: [], readFile: [], open: [], rename: [], unlink: [], chmod: [] };
  const io = {};
  for (const [name, fn] of Object.entries(base)) {
    io[name] = (...args) => {
      calls[name].push(args);
      return fn(...args);
    };
  }
  return { io, calls };
}

function renames(calls) {
  return calls.rename.map(([from, to]) => ({ from, to }));
}

async function storedOnDisk(file) {
  const parsed = parseAuthorizationDocument((await readFile(file)).toString("utf8"));
  assert.equal(parsed.ok, true, `the document on disk must parse: ${parsed.code ?? ""}`);
  return parsed.document;
}

test("a missing file is seeded once and the seeded document is written", async () => {
  const work = await workdir("seed");
  const { io, calls } = recordingIo();
  let seedCalls = 0;
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => {
      seedCalls += 1;
      return storedDocument();
    },
    deriveSubjects: (subjects) => subjects,
  });
  try {
    await deployment.ready;

    assert.equal(seedCalls, 1, "the seed runs once");
    const writes = renames(calls);
    assert.equal(writes.length, 1, "the seed is written through exactly one atomic rename");
    assert.equal(writes[0].to, work.file, "the temp file is renamed onto the document path");

    const onDisk = await storedOnDisk(work.file);
    assert.equal(onDisk.revision, 4);
    assert.deepEqual(Object.keys(onDisk.subjects), ["api-key:old"], "the file is readable on its own");

    const snapshot = deployment.store.snapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.revision, 4);

    deployment.store.snapshot();
    deployment.store.snapshot();
    assert.equal(renames(calls).length, 1, "reading never writes");
    assert.equal(seedCalls, 1, "a seeded store is never re-seeded");
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a credential that appears later is visible without a write, and the derived view mutates nothing", async () => {
  const work = await workdir("derived");
  const { io, calls } = recordingIo();
  const seen = [];
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => storedDocument(),
    deriveSubjects: (subjects) => {
      seen.push(Object.keys(subjects));
      return { "api-key:new": { credentialEpoch: 1, grants: [] } };
    },
  });
  try {
    await deployment.ready;
    const writes = renames(calls).length;

    const first = deployment.store.snapshot();
    assert.equal(first.status, "ready");
    assert.equal(first.document.subjects["api-key:new"].credentialEpoch, 1, "a new credential has a derived ceiling");
    assert.equal(first.document.subjects["api-key:old"], undefined, "the derived half replaces the stored one");
    assert.equal(first.document.timeConstraintsEnabled, true, "the durable half is kept");
    assert.equal(first.document.catalogVersion, AUTHORIZATION_CATALOG_VERSION);
    assert.ok(Object.isFrozen(first.document.subjects), "the derived view is frozen: no consumer writes back into the live import");
    assert.ok(Object.isFrozen(first.document));

    assert.deepEqual(deployment.store.snapshot().document.subjects, { "api-key:new": { credentialEpoch: 1, grants: [] } });
    assert.equal(renames(calls).length, writes, "a later credential is never written to the file");
    assert.deepEqual(seen, [["api-key:old"], ["api-key:old"]], "the derivation receives the stored subjects unchanged");

    assert.deepEqual(Object.keys((await storedOnDisk(work.file)).subjects), ["api-key:old"], "the file keeps the seeded subjects");
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a seed that throws rejects ready and publishes no document", async () => {
  const work = await workdir("seed-throws");
  const { io, calls } = recordingIo();
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => {
      throw new Error("legacy import hold");
    },
    deriveSubjects: (subjects) => subjects,
  });
  try {
    await assert.rejects(deployment.ready, /legacy import hold/);
    assert.equal(deployment.store.snapshot().status, "broken");
    assert.equal(deployment.store.snapshot().code, STATE_UNAVAILABLE);
    assert.equal(renames(calls).length, 0, "a failed seed writes nothing");
    await assert.rejects(readFile(work.file), { code: "ENOENT" });
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("before ready the store is loading, and a refused seed leaves it broken", async () => {
  const work = await workdir("refused-seed");
  const { io } = recordingIo();
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => storedDocument({ revision: 0 }),
    deriveSubjects: () => {
      throw new Error("a broken store must not be composed");
    },
  });
  try {
    assert.deepEqual(deployment.store.snapshot(), { status: "loading" }, "the store's own snapshot is answered unchanged");
    await assert.rejects(deployment.ready, { code: INVALID_DOCUMENT });
    assert.equal(deployment.store.snapshot().status, "broken");
    assert.equal(deployment.store.snapshot().code, STATE_UNAVAILABLE);
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a second boot against a valid document never re-seeds or overwrites it", async () => {
  const work = await workdir("second-boot");
  const { io, calls } = recordingIo();
  await writeFile(work.file, serializeAuthorizationDocument(storedDocument({ revision: 2, timeConstraintsEnabled: false })), { mode: 0o600 });
  const before = await readFile(work.file);
  let seedCalls = 0;
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => {
      seedCalls += 1;
      throw new Error("an existing document must never be re-seeded");
    },
    deriveSubjects: (subjects) => subjects,
  });
  try {
    await deployment.ready;
    assert.equal(seedCalls, 0, "a readable document is never seeded again");
    assert.deepEqual(await readFile(work.file), before, "the bytes on disk are unchanged");
    assert.equal(renames(calls).length, 0, "nothing was written");
    const snapshot = deployment.store.snapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.document.timeConstraintsEnabled, false, "an Admin edit survives the boot");
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a throwing derivation answers broken, is not retried per request, and recovers", async () => {
  const work = await workdir("derivation-throws");
  const { io } = recordingIo();
  let attempts = 0;
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => storedDocument({ revision: 2 }),
    deriveSubjects: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("legacy import hold");
      return { "api-key:old": STORED_SUBJECT };
    },
  });
  try {
    await deployment.ready;

    const failed = deployment.store.snapshot();
    assert.equal(failed.status, "broken", "a throwing derivation is a broken state, never a throw");
    assert.equal(failed.code, STATE_UNAVAILABLE);
    assert.equal(deployment.store.snapshot().status, "broken");
    assert.equal(attempts, 1, "a failed derivation is cached, not retried for every request");

    const written = await deployment.store.replace(2, storedDocument({ revision: 3 }));
    assert.equal(written.ok, true);
    const recovered = deployment.store.snapshot();
    assert.equal(recovered.status, "ready", "a new committed document retries the derivation");
    assert.equal(recovered.revision, 3);
    assert.equal(attempts, 2);
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a write composed from the derived snapshot persists the committed subjects, not the derived ones", async () => {
  const work = await workdir("write-path");
  const { io } = recordingIo();
  await writeFile(work.file, serializeAuthorizationDocument(storedDocument({ revision: 4 })), { mode: 0o600 });
  // Drops the stored row, adds one, and widens the ceiling of a third.
  const derived = {
    "api-key:new": { credentialEpoch: 1, grants: [{ target: { kind: "vault", vaultId: "a" }, capabilities: ["get_note"] }] },
    "api-key:wide": { credentialEpoch: 7, grants: [{ target: { kind: "vault", vaultId: "a" }, capabilities: ["get_note", "write_note"] }] },
  };
  const deployment = createDeploymentDocument({ file: work.file, io, deriveSubjects: () => derived });
  try {
    await deployment.ready;
    const before = await storedOnDisk(work.file);
    const composed = deployment.store.snapshot();
    assert.equal(composed.status, "ready");
    assert.deepEqual(composed.document.subjects, derived, "a reader sees the derived half");

    // Exactly what a writer that builds its candidate from `snapshot()` hands over.
    const written = await deployment.store.replace(4, { ...composed.document, revision: 5, constraints: [CONSTRAINT] });
    assert.equal(written.ok, true);

    const onDisk = await storedOnDisk(work.file);
    assert.equal(onDisk.revision, 5);
    assert.equal(onDisk.constraints.length, 1, "the durable half is written");
    assert.deepEqual(onDisk.subjects, before.subjects, "the derived rows are never written back");
    assert.deepEqual(deployment.store.snapshot().document.subjects, derived, "the derived view still answers the derivation");

    // A candidate that names its own subjects cannot change them either.
    const second = await deployment.store.replace(5, { ...deployment.store.snapshot().document, revision: 6, subjects: {} });
    assert.equal(second.ok, true);
    assert.deepEqual((await storedOnDisk(work.file)).subjects, before.subjects, "the file owns its subjects");
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("the store states the source revision a shadow row records", async () => {
  const work = await workdir("source-revision");
  const { io } = recordingIo();
  let stamp = 11;
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => storedDocument(),
    deriveSubjects: (subjects) => subjects,
    sourceRevision: () => stamp,
  });
  try {
    await deployment.ready;
    assert.equal(deployment.store.sourceRevision(), 11);
    stamp = 12;
    assert.equal(deployment.store.sourceRevision(), 12, "read at call time, never captured at construction");
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});
