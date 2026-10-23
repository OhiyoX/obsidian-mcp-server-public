/**
 * #428 — Web Catalog default directory (`DATA_PATH/web-catalog`) and its observability.
 *
 * Contract: `scratch/admin-review/codex-seat/RULING-428-RESPONSE.md` (design GO, option A) and the
 * lane BRIEF. Superseded behavior: `process.env.WEB_CATALOG_DIR || process.cwd()/data/web-catalog`.
 *
 * What is proven here:
 *   1. path matrix — explicit `WEB_CATALOG_DIR` wins (absolute + relative), the default is the
 *      resolved `DATA_PATH/web-catalog`, empty `WEB_CATALOG_DIR` falls through, different vault ids
 *      are different files, and same dir + same id is one file (documented shared boundary);
 *   2. one open line per actually-opened store, naming the exact file that was opened, not repeated
 *      per request;
 *   3. two REAL child processes — same cwd, same vault id, different Vault, different `DATA_PATH`,
 *      inherited `WEB_CATALOG_DIR` cleared — each reconcile only their own markers (tree + FTS);
 *   4. the same isolation holds with two different explicit directories, and the persisted snapshot
 *      is reused across a restart;
 *   5. migration: a child with its OWN cwd finds the retired `cwd/data/web-catalog` index poisoned,
 *      clears an inherited `WEB_CATALOG_DIR` explicitly, opens nothing from that index before its
 *      first reconcile, rebuilds from the Vault alone, and leaves the retired file byte-identical;
 *   6. negative controls — (a) two processes given the retired default's *effective* directory go red
 *      on the shared file (crosstalk, or an explicit SQLite BUSY/LOCKED failure tied to that file and
 *      to an open/reconcile/read phase — the control accepts and records either manifestation, and
 *      anything else is an `untiedFailure`), and (b) driving the migration criterion against a
 *      process that ends up on the retired index goes red on behaviour (poison present in the opened
 *      store, the retired file written), not merely on "the resolved paths differ".
 *
 * The child harness and the pair handshake live in `test/helpers/web-catalog-pair-driver.mjs`; the
 * retired-path migration scenario and its single acceptance predicate live in
 * `test/helpers/web-catalog-migration.mjs`. The controls do not use SQLite corruption as a criterion:
 * they assert observable content (crosstalk, poison visibility, a real write). The byte-level
 * "nothing from the retired index" evidence is collected with `collectStoreBytesBeforeReconcile`
 * right after `ready` and BEFORE the first `reconcile` command is sent, so the check cannot be
 * satisfied by bytes read back after the rebuild.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { DATA_PATH } from "../src/config.js";
import {
  WEB_CATALOG_DIR_SOURCE,
  catalogFileFor,
  resolveWebCatalogLocation,
} from "../src/app/web-catalog/runtime.js";
import { APP_ROOT, classifySharedDirectoryHarm, isolationHolds, runCatalogPair, runSharedDirectoryPair, startCatalogChild } from "./helpers/web-catalog-pair-driver.mjs";
import {
  LEGACY_POISON_NOTE,
  collectStoreBytesBeforeReconcile,
  migrationAcceptance,
  poisonLegacyCatalog,
  snapshotLegacy,
} from "./helpers/web-catalog-migration.mjs";

const base = await fsp.mkdtemp(path.join(os.tmpdir(), "obsidian-i428-catalog-"));
after(() => fsp.rm(base, { recursive: true, force: true }));

const TOKEN_A = "alphamarker428";
const TOKEN_B = "betamarker428";
const TOKEN_POISON = "poisonmarker428";

async function writeVault(root, note, body) {
  await fsp.mkdir(path.join(root, "Notes"), { recursive: true });
  await fsp.writeFile(path.join(root, note), body);
  return root;
}

// ---------------------------------------------------------------------------
// 1. Path matrix (in-process resolution)
// ---------------------------------------------------------------------------

function withCatalogDir(value, fn) {
  const saved = process.env.WEB_CATALOG_DIR;
  try {
    if (value === undefined) delete process.env.WEB_CATALOG_DIR;
    else process.env.WEB_CATALOG_DIR = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.WEB_CATALOG_DIR;
    else process.env.WEB_CATALOG_DIR = saved;
  }
}

test("#428 path matrix: explicit -> default -> relative -> id boundary", () => {
  const dataPathDefault = path.join(DATA_PATH, "web-catalog");

  withCatalogDir(undefined, () => {
    const location = resolveWebCatalogLocation({ id: "vault-one" });
    assert.equal(location.source, "DATA_PATH", "no WEB_CATALOG_DIR falls back to DATA_PATH");
    assert.equal(location.dir, dataPathDefault);
    assert.equal(location.file, path.join(dataPathDefault, "vault-one.sqlite"));
    assert.equal(catalogFileFor({ id: "vault-one" }), location.file);
  });

  withCatalogDir("", () => {
    const location = resolveWebCatalogLocation({ id: "vault-one" });
    assert.equal(location.source, "DATA_PATH", "an empty WEB_CATALOG_DIR falls through");
    assert.equal(location.dir, dataPathDefault);
  });

  withCatalogDir(path.join(base, "explicit"), () => {
    const a = resolveWebCatalogLocation({ id: "vault-one" });
    const b = resolveWebCatalogLocation({ id: "vault-two" });
    assert.equal(a.source, "WEB_CATALOG_DIR");
    assert.equal(a.dir, path.join(base, "explicit"));
    assert.notEqual(a.dir, dataPathDefault, "explicit configuration wins over the DATA_PATH default");
    assert.notEqual(a.file, b.file, "a different vault id is a different file");
    assert.equal(a.vaultId, "vault-one");
  });

  // Existing relative-path interpretation: resolved against the process cwd, unchanged by #428.
  withCatalogDir(path.join("relative", "catalog"), () => {
    const location = resolveWebCatalogLocation({ id: "vault-one" });
    assert.equal(location.source, "WEB_CATALOG_DIR");
    assert.equal(location.dir, path.join(process.cwd(), "relative", "catalog"));
    assert.equal(location.file, path.join(process.cwd(), "relative", "catalog", "vault-one.sqlite"));
  });

  // Documented boundary (not fixed by this slice): one effective directory + one vault id is one file.
  withCatalogDir(path.join(base, "shared"), () => {
    const first = resolveWebCatalogLocation({ id: "default" });
    const second = resolveWebCatalogLocation({ id: "default" });
    assert.deepEqual(first, second);
    assert.equal(WEB_CATALOG_DIR_SOURCE.EXPLICIT, "WEB_CATALOG_DIR");
    assert.equal(WEB_CATALOG_DIR_SOURCE.DATA_PATH, "DATA_PATH");
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Default DATA_PATH (relative), one open line, cross-process isolation
// ---------------------------------------------------------------------------

test("#428 default resolves a relative DATA_PATH, logs the opened file once, and isolates processes", async () => {
  const root = path.join(base, "default-path");
  const vaultA = await writeVault(path.join(root, "vault-a"), "Notes/Alpha.md", `# alpha\n\n${TOKEN_A}\n`);
  const vaultB = await writeVault(path.join(root, "vault-b"), "Notes/Beta.md", `# beta\n\n${TOKEN_B}\n`);
  const cwd = path.join(root, "cwd");
  await fsp.mkdir(cwd, { recursive: true });

  const pair = await runCatalogPair({
    name: "default-path",
    cwd,
    // A relative DATA_PATH proves config.js's own resolution is what the catalog consumes.
    envA: { DATA_PATH: "data-a" },
    envB: { DATA_PATH: "data-b" },
    vaultA,
    vaultB,
    noteA: "Notes/Alpha.md",
    noteB: "Notes/Beta.md",
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
  });

  for (const [label, ready] of [
    ["A", pair.readyA],
    ["B", pair.readyB],
  ]) {
    assert.equal(ready.location.source, "DATA_PATH", `${label} must use the DATA_PATH default`);
    assert.equal(ready.location.dir, path.join(cwd, `data-${label.toLowerCase()}`, "web-catalog"));
    assert.equal(ready.location.file, path.join(ready.location.dir, "default.sqlite"));
    assert.ok(ready.fileExists, `${label} opened a real file`);
  }
  assert.notEqual(pair.readyA.location.file, pair.readyB.location.file, "distinct DATA_PATH -> distinct file");
  // The retired default must be gone: no `cwd/data/web-catalog` is created anymore.
  assert.equal(fs.existsSync(path.join(cwd, "data", "web-catalog")), false, "retired cwd/data default is unused");

  // One open line per actually-opened store, naming that exact file, with its source.
  const escaped = pair.readyA.location.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.equal(pair.reconciledA.evidence.logs.length, 1, "A logs exactly one open line");
  assert.equal(pair.readA.evidence.logs.length, 1, "a read does not log again (no per-request logging)");
  assert.match(pair.reconciledA.evidence.logs[0], new RegExp(escaped));
  assert.match(pair.reconciledA.evidence.logs[0], /source: DATA_PATH/);
  assert.equal(fs.existsSync(pair.readyA.location.file), true, "the logged file is the file on disk");

  assert.ok(isolationHolds(pair.readA.evidence, "Notes/Alpha.md", "Notes/Beta.md"), `A leaked: ${JSON.stringify(pair.readA.evidence)}`);
  assert.ok(isolationHolds(pair.readB.evidence, "Notes/Beta.md", "Notes/Alpha.md"), `B leaked: ${JSON.stringify(pair.readB.evidence)}`);
});

// ---------------------------------------------------------------------------
// 4a. Two different explicit directories isolate just the same
// ---------------------------------------------------------------------------

test("#428 two different explicit WEB_CATALOG_DIRs do not share an index", async () => {
  const root = path.join(base, "explicit-split");
  const vaultA = await writeVault(path.join(root, "vault-a"), "Notes/Alpha.md", `# alpha\n\n${TOKEN_A}\n`);
  const vaultB = await writeVault(path.join(root, "vault-b"), "Notes/Beta.md", `# beta\n\n${TOKEN_B}\n`);

  const pair = await runCatalogPair({
    name: "explicit-split",
    cwd: APP_ROOT,
    envA: { DATA_PATH: path.join(root, "data"), WEB_CATALOG_DIR: path.join(root, "cat-a") },
    envB: { DATA_PATH: path.join(root, "data"), WEB_CATALOG_DIR: path.join(root, "cat-b") },
    vaultA,
    vaultB,
    noteA: "Notes/Alpha.md",
    noteB: "Notes/Beta.md",
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
  });

  assert.equal(pair.readyA.location.source, "WEB_CATALOG_DIR");
  assert.equal(pair.readyA.location.file, path.join(root, "cat-a", "default.sqlite"));
  assert.equal(pair.readyB.location.file, path.join(root, "cat-b", "default.sqlite"));
  assert.match(pair.reconciledA.evidence.logs[0], /source: WEB_CATALOG_DIR/);
  assert.ok(isolationHolds(pair.readA.evidence, "Notes/Alpha.md", "Notes/Beta.md"));
  assert.ok(isolationHolds(pair.readB.evidence, "Notes/Beta.md", "Notes/Alpha.md"));
});

// ---------------------------------------------------------------------------
// 4b. The persisted snapshot is reused after a restart (same location, new process)
// ---------------------------------------------------------------------------

test("#428 a restarted process reuses the persisted catalog at the same DATA_PATH location", async () => {
  const root = path.join(base, "restart-reuse");
  const vault = await writeVault(path.join(root, "vault"), "Notes/Alpha.md", `# alpha\n\n${TOKEN_A}\n`);
  const env = {
    VAULT_PATH: vault,
    DATA_PATH: path.join(root, "data"),
    I428_VAULT_ROOT: vault,
    I428_VAULT_ID: "default",
    I428_OWN_NOTE: "Notes/Alpha.md",
    I428_OWN_TOKEN: TOKEN_A,
    I428_OTHER_NOTE: "Notes/Beta.md",
    I428_OTHER_TOKEN: TOKEN_B,
  };

  const first = startCatalogChild({ label: "restart:first", cwd: APP_ROOT, env });
  let location;
  try {
    location = (await first.awaitEvent("ready")).location;
    await first.command({ cmd: "reconcile" }, "reconciled");
  } finally {
    await first.stop();
  }
  assert.equal(fs.existsSync(location.file), true);

  const second = startCatalogChild({ label: "restart:second", cwd: APP_ROOT, env });
  try {
    const ready = await second.awaitEvent("ready");
    assert.equal(ready.location.file, location.file, "a restart reuses the same file");
    const read = await second.command({ cmd: "read" }, "read");
    assert.equal(read.evidence.started, false, "no reconcile ran in the restarted process");
    assert.equal(read.evidence.own.located, true, "the persisted snapshot is readable before any reconcile");
    assert.ok(read.evidence.own.fts >= 1);
  } finally {
    await second.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. Migration from the REAL retired path (<cwd>/data/web-catalog)
// ---------------------------------------------------------------------------

test("#428 a cold start in a dedicated cwd rebuilds from the Vault and never reads or rewrites the retired cwd/data index", async () => {
  const root = path.join(base, "migration-retired-path");
  const vault = await writeVault(path.join(root, "vault"), "Notes/Alpha.md", `# alpha\n\n${TOKEN_A}\n`);

  // The child gets its OWN cwd, so the retired default resolves inside it: the poison must sit at
  // `<cwd>/data/web-catalog`, the location that actually retires here — not at a test-invented path.
  const cwd = path.join(root, "cwd");
  await fsp.mkdir(cwd, { recursive: true });
  const legacyDir = path.join(cwd, "data", "web-catalog");
  const legacyFile = poisonLegacyCatalog({
    legacyDir,
    vaultId: "default",
    note: LEGACY_POISON_NOTE,
    token: TOKEN_POISON,
  });
  const legacy = snapshotLegacy(legacyFile);

  // The new location comes from a DATA_PATH that is NOT the retired `<cwd>/data` tree.
  const dataPath = path.join(root, "new-data");
  const expected = {
    legacyDir,
    poisonNote: LEGACY_POISON_NOTE,
    poisonToken: TOKEN_POISON,
    dataPathDir: path.join(dataPath, "web-catalog"),
    newFile: path.join(dataPath, "web-catalog", "default.sqlite"),
    vaultNotes: ["Notes/Alpha.md"],
  };

  const child = startCatalogChild({
    label: "migration:retired-path",
    cwd,
    env: {
      VAULT_PATH: vault,
      DATA_PATH: dataPath,
      // What a pre-#428 deployment looks like: the inherited pointer still names the retired
      // directory. The harness clears it explicitly, and that clear is asserted below.
      WEB_CATALOG_DIR: legacyDir,
      I428_CLEAR_WEB_CATALOG_DIR: "1",
      I428_VAULT_ROOT: vault,
      I428_VAULT_ID: "default",
      I428_OWN_NOTE: "Notes/Alpha.md",
      I428_OWN_TOKEN: TOKEN_A,
      I428_OTHER_NOTE: LEGACY_POISON_NOTE,
      I428_OTHER_TOKEN: TOKEN_POISON,
    },
  });
  let ready;
  let storeBytesBeforeReconcile;
  let preReconcile;
  let reconciled;
  try {
    ready = await child.awaitEvent("ready");
    // Collected BEFORE the first reconcile command is sent (the child reconciles only on that
    // command), so this is the byte-level "did the opened store already hold the retired index?"
    // evidence for the pre-reconcile window — not a read taken after the rebuild.
    storeBytesBeforeReconcile = collectStoreBytesBeforeReconcile({
      ready,
      poisonNote: LEGACY_POISON_NOTE,
      poisonToken: TOKEN_POISON,
    });
    preReconcile = (await child.command({ cmd: "read" }, "read")).evidence;
    reconciled = (await child.command({ cmd: "reconcile" }, "reconciled")).evidence;
  } finally {
    await child.stop();
  }

  const acceptance = migrationAcceptance({
    ready,
    preReconcile,
    reconciled,
    legacy,
    expected,
    storeBytesBeforeReconcile,
  });
  assert.ok(acceptance.ok, `migration acceptance failed: ${JSON.stringify(acceptance)}`);
  assert.equal(acceptance.checks.locationIsDataPathDefault, true);
  assert.equal(acceptance.checks.inheritedDirExplicitlyCleared, true);
  assert.equal(acceptance.checks.noLegacyMarkerInStoreBeforeReconcile, true);
  assert.equal(acceptance.checks.rebuiltFromVault, true);
  assert.equal(acceptance.checks.legacyBytesUnchanged, true);
  assert.equal(acceptance.checks.legacyMtimeUnchanged, true);
  assert.equal(acceptance.checks.legacyEntriesUnchanged, true);
  assert.equal(acceptance.storeBytesBeforeReconcile.collectedAt, "before-first-reconcile");
  assert.equal(acceptance.storeBytesBeforeReconcile.file, expected.newFile);
  assert.deepEqual(acceptance.storeBytesBeforeReconcile.hits, [], "no retired marker byte in the new store");
  assert.match(reconciled.logs[0], /source: DATA_PATH/);
  assert.ok(reconciled.logs[0].includes(expected.newFile), "the log names the file that was opened");
});

// ---------------------------------------------------------------------------
// 6. Negative control (b): serving the retired index goes red on BEHAVIOUR, not on path inequality
// ---------------------------------------------------------------------------

test("#428 migration negative control: reading the retired index back is caught behaviourally", async () => {
  const root = path.join(base, "migration-negative");
  const vault = await writeVault(path.join(root, "vault"), "Notes/Alpha.md", `# alpha\n\n${TOKEN_A}\n`);
  const cwd = path.join(root, "cwd");
  await fsp.mkdir(cwd, { recursive: true });
  const legacyDir = path.join(cwd, "data", "web-catalog");
  const legacyFile = poisonLegacyCatalog({
    legacyDir,
    vaultId: "default",
    note: LEGACY_POISON_NOTE,
    token: TOKEN_POISON,
  });
  const legacy = snapshotLegacy(legacyFile);
  const dataPath = path.join(root, "new-data");
  const expected = {
    legacyDir,
    poisonNote: LEGACY_POISON_NOTE,
    poisonToken: TOKEN_POISON,
    dataPathDir: path.join(dataPath, "web-catalog"),
    newFile: path.join(dataPath, "web-catalog", "default.sqlite"),
    vaultNotes: ["Notes/Alpha.md"],
  };

  // Same child, same cwd, same DATA_PATH — but the inherited pointer is NOT cleared, so the process
  // serves the retired index. This is the shape of "the code read the old file back".
  const child = startCatalogChild({
    label: "migration:negative",
    cwd,
    env: {
      VAULT_PATH: vault,
      DATA_PATH: dataPath,
      WEB_CATALOG_DIR: legacyDir,
      I428_VAULT_ROOT: vault,
      I428_VAULT_ID: "default",
      I428_OWN_NOTE: "Notes/Alpha.md",
      I428_OWN_TOKEN: TOKEN_A,
      I428_OTHER_NOTE: LEGACY_POISON_NOTE,
      I428_OTHER_TOKEN: TOKEN_POISON,
    },
  });
  let ready;
  let storeBytesBeforeReconcile;
  let preReconcile;
  let reconciled;
  try {
    ready = await child.awaitEvent("ready");
    // Same pre-reconcile collection point as the positive case: this process landed on the retired
    // index, so the byte evidence must already show the poison BEFORE any reconcile ran.
    storeBytesBeforeReconcile = collectStoreBytesBeforeReconcile({
      ready,
      poisonNote: LEGACY_POISON_NOTE,
      poisonToken: TOKEN_POISON,
    });
    preReconcile = (await child.command({ cmd: "read" }, "read")).evidence;
    reconciled = (await child.command({ cmd: "reconcile" }, "reconciled")).evidence;
  } finally {
    await child.stop();
  }

  const acceptance = migrationAcceptance({
    ready,
    preReconcile,
    reconciled,
    legacy,
    expected,
    storeBytesBeforeReconcile,
  });
  console.log(
    "#428 migration negative-control evidence:",
    JSON.stringify({
      location: ready.location,
      storeBytesBeforeReconcile: acceptance.storeBytesBeforeReconcile,
      checks: acceptance.checks,
    }),
  );
  assert.equal(acceptance.ok, false, "the migration criterion must detect a process serving the retired index");
  // The red is observable behaviour, and NOT merely "the resolved paths differ":
  assert.notDeepEqual(
    acceptance.storeBytesBeforeReconcile.hits,
    [],
    "the retired marker must be visible in the store bytes read before the first reconcile",
  );
  assert.equal(acceptance.checks.noLegacyMarkerInStoreBeforeReconcile, false);
  assert.equal(preReconcile.other.located, true, "the retired poison note is readable before any reconcile");
  assert.ok(
    acceptance.checks.legacyBytesUnchanged === false || acceptance.checks.legacyMtimeUnchanged === false,
    "the retired file must show a real write",
  );
});

// ---------------------------------------------------------------------------
// 7. Negative control (a): the retired default's effective directory goes red
// ---------------------------------------------------------------------------
//
// Two processes given the SAME effective directory is the retired default's shape. SQLite's
// scheduler picks how that shows: a lock collision while one process migrates the file the other
// holds, or crosstalk once both stores are open. Both are accepted and both are recorded; the
// control insists only that the harm is tied to the shared file and not to an unrelated crash.
test("#428 negative control: a shared effective directory (the retired default) breaks the isolation acceptance", async () => {
  const root = path.join(base, "legacy-shared");
  const vaultA = await writeVault(path.join(root, "vault-a"), "Notes/Alpha.md", `# alpha\n\n${TOKEN_A}\n`);
  const vaultB = await writeVault(path.join(root, "vault-b"), "Notes/Beta.md", `# beta\n\n${TOKEN_B}\n`);
  // Same cwd, same vault id, and the same effective directory the retired
  // `process.cwd()/data/web-catalog` default produced for both servers.
  const cwd = path.join(root, "cwd");
  const sharedDir = path.join(cwd, "data", "web-catalog");
  const sharedFile = path.join(sharedDir, "default.sqlite");
  await fsp.mkdir(cwd, { recursive: true });

  const record = await runSharedDirectoryPair({
    name: "legacy-shared",
    cwd,
    env: { WEB_CATALOG_DIR: sharedDir },
    sharedFile,
    a: { vault: vaultA, note: "Notes/Alpha.md", token: TOKEN_A },
    b: { vault: vaultB, note: "Notes/Beta.md", token: TOKEN_B },
  });
  const verdict = classifySharedDirectoryHarm(record);
  // Raw evidence: the crosstalk (if SQLite let both stores open) AND the contention (if it did not).
  console.log("#428 negative-control evidence:", JSON.stringify(verdict));

  assert.equal(
    [record.sides.a.location, record.sides.b.location].some((location) => location?.file === sharedFile),
    true,
    "at least one process must have resolved the shared file",
  );
  assert.equal(fs.existsSync(sharedFile), true, "the shared catalog file must really exist");
  assert.equal(verdict.untiedFailures.length, 0, `a failure unrelated to the shared file: ${JSON.stringify(verdict.untiedFailures)}`);
  assert.equal(verdict.harmObserved, true, `sharing the effective directory MUST be detected as harm: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.isolation.a === true && verdict.isolation.b === true, false, "the isolation acceptance must fail");
});
