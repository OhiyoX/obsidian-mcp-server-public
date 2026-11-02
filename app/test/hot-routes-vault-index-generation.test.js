// Hot Routes Phase 0-B — getVaultIndex generation / freshness contract.
//
// Deterministic, synthetic-vault coverage for the vault-index.js additive
// generation/freshness layer:
//   - process-local vaultGeneration / publicationRevision / snapshotGeneration
//   - serialized whole-build mutex with a generation fence captured before
//     enumeration and rechecked after the last await
//   - bounded retry (2 attempts) with a stable VAULT_INDEX_FENCE_CONFLICT
//   - invalidation semantics (`paths`, unknown paths, `[]`, full)
//   - observed external-change detection for the same includeHidden identity
//   - additive read-time stats and coverage (clean+partial is not dirty)
//
// Races use explicit entered/release barriers, never timing assumptions. A
// second build is never awaited before the first build's gate is released,
// because every build is serialized behind the same promise tail.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-hot-routes-generation-"));
const vault = path.join(root, "vault");
await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
await fs.mkdir(path.join(vault, ".secret"), { recursive: true });
await fs.writeFile(path.join(vault, "Home.md"), "---\ntitle: Home\n---\n# Home\n\n[[Projects/README]]\n");
await fs.writeFile(path.join(vault, "Projects", "README.md"), "# Project README\n");
await fs.writeFile(path.join(vault, "Projects", "TODO.md"), "# TODO\n");
await fs.writeFile(path.join(vault, ".hidden-note.md"), "# Hidden\n");
await fs.writeFile(path.join(vault, ".secret", "Deep.md"), "# Deep\n");

process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.HISTORY_PATH = path.join(root, "data", "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(root, "data", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
// Keep the fixture tiny so the oversized-note skip path is exercised cheaply.
process.env.MAX_READ_BYTES = "1kb";
// The unref'd retrieval-refresh debounce must not fire during this file.
process.env.RETRIEVAL_REFRESH_DEBOUNCE_MS = "60000";

const { getVaultIndex, getCachedVaultIndex, invalidateVaultIndex, getVaultIndexStats } =
  await import("../src/vault-index.js");
const { buildNoteContext } = await import("../src/context-service.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function pathsOf(snapshot) {
  return snapshot ? snapshot.records.map((record) => record.path).sort() : null;
}

function fakeStat(real, size) {
  return {
    size,
    dev: real.dev,
    ino: real.ino,
    mtime: real.mtime,
    mtimeMs: real.mtimeMs,
    birthtime: real.birthtime,
    isFile: () => real.isFile(),
    isDirectory: () => real.isDirectory(),
    isSymbolicLink: () => real.isSymbolicLink(),
  };
}

test("cold start: generation/revision are zero and no snapshot identity exists", () => {
  const stats = getVaultIndexStats();
  assert.equal(stats.vaultGeneration, 0);
  assert.equal(stats.snapshotGeneration, null);
  assert.equal(stats.publicationRevision, 0);
  assert.equal(stats.freshness, "cold");
  assert.equal(stats.coverage, null);
  assert.equal(getCachedVaultIndex(), null);
});

test("first successful build publishes once at generation zero and stays clean", async () => {
  const index = await getVaultIndex();
  assert.equal(index.stats.files, 3);
  assert.equal(index.stats.vaultGeneration, 0);
  assert.equal(index.stats.snapshotGeneration, 0);
  assert.equal(index.stats.publicationRevision, 1);
  assert.equal(index.stats.freshness, "clean");
  assert.deepEqual(index.stats.coverage, { includeHidden: false, completeness: "complete", skipped: 0 });
  assert.deepEqual(pathsOf(index), ["Home.md", "Projects/README.md", "Projects/TODO.md"]);

  const stats = getVaultIndexStats();
  assert.equal(stats.vaultGeneration, 0);
  assert.equal(stats.publicationRevision, 1);
  assert.equal(stats.freshness, "clean");
});

test("no-change ordinary and force refreshes publish without bumping the generation", async () => {
  const before = getVaultIndexStats();
  const ordinary = await getVaultIndex();
  assert.equal(ordinary.stats.vaultGeneration, before.vaultGeneration);
  assert.equal(ordinary.stats.snapshotGeneration, before.vaultGeneration);
  assert.equal(ordinary.stats.publicationRevision, before.publicationRevision + 1);

  const afterOrdinary = getVaultIndexStats();
  const forced = await getVaultIndex({ force: true });
  assert.equal(forced.stats.vaultGeneration, afterOrdinary.vaultGeneration);
  assert.equal(forced.stats.publicationRevision, afterOrdinary.publicationRevision + 1);
  assert.equal(forced.stats.freshness, "clean");
});

test("known-path invalidation bumps once, keeps the snapshot and reports dirty", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();
  invalidateVaultIndex("Projects/TODO.md");
  const after = getVaultIndexStats();

  assert.equal(after.vaultGeneration, before.vaultGeneration + 1);
  assert.equal(after.publicationRevision, before.publicationRevision);
  assert.equal(after.snapshotGeneration, before.snapshotGeneration);
  assert.equal(after.freshness, "dirty");

  const cached = getCachedVaultIndex();
  assert.ok(cached && !(cached instanceof Map));
  assert.equal(typeof cached.resolveLink, "function");
  assert.equal(cached.stats.cached, true);
  assert.equal(cached.stats.freshness, "dirty");
  assert.deepEqual(pathsOf(cached), ["Home.md", "Projects/README.md"]);

  // A dirty rebuild publishes the current generation without a second
  // external-content bump.
  const rebuilt = await getVaultIndex();
  assert.equal(rebuilt.stats.vaultGeneration, after.vaultGeneration);
  assert.equal(rebuilt.stats.snapshotGeneration, after.vaultGeneration);
  assert.equal(rebuilt.stats.publicationRevision, after.publicationRevision + 1);
  assert.equal(rebuilt.stats.freshness, "clean");
  assert.ok(rebuilt.records.some((record) => record.path === "Projects/TODO.md"));
});

test("unknown non-empty path invalidation still bumps the generation once", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();
  invalidateVaultIndex("Does/Not/Exist.md");
  const after = getVaultIndexStats();
  assert.equal(after.vaultGeneration, before.vaultGeneration + 1);
  assert.equal(after.publicationRevision, before.publicationRevision);
  assert.equal(after.freshness, "dirty");
});

test("empty array invalidation is an index no-op that keeps the snapshot", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();
  const beforeCached = getCachedVaultIndex();
  invalidateVaultIndex([]);
  const after = getVaultIndexStats();
  assert.equal(after.vaultGeneration, before.vaultGeneration);
  assert.equal(after.publicationRevision, before.publicationRevision);
  assert.equal(after.snapshotGeneration, before.snapshotGeneration);
  assert.equal(after.freshness, before.freshness);
  assert.deepEqual(pathsOf(getCachedVaultIndex()), pathsOf(beforeCached));
});

test("full invalidation bumps the generation and returns to cold", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();
  invalidateVaultIndex();
  const after = getVaultIndexStats();
  assert.equal(after.vaultGeneration, before.vaultGeneration + 1);
  assert.equal(after.publicationRevision, before.publicationRevision);
  assert.equal(after.snapshotGeneration, null);
  assert.equal(after.freshness, "cold");
  assert.equal(after.coverage, null);
  assert.equal(getCachedVaultIndex(), null);

  const rebuilt = await getVaultIndex();
  assert.equal(rebuilt.stats.freshness, "clean");
  assert.equal(rebuilt.stats.snapshotGeneration, rebuilt.stats.vaultGeneration);
});

test("invalidation during an awaited read fences the old attempt and retries", async () => {
  await getVaultIndex({ force: true });
  const before = getVaultIndexStats();

  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let blocked = false;
  const originalOpen = fs.open;
  fs.open = async (candidate, ...rest) => {
    if (!blocked && String(candidate).endsWith("Home.md")) {
      blocked = true;
      enteredResolve();
      await release;
    }
    return originalOpen.call(fs, candidate, ...rest);
  };

  try {
    const build = getVaultIndex({ force: true });
    await entered;
    invalidateVaultIndex("Projects/README.md");
    const afterInvalidate = getVaultIndexStats();
    assert.equal(afterInvalidate.freshness, "dirty");
    releaseResolve();
    const result = await build;
    fs.open = originalOpen;

    // Exactly one publication for this call: the fenced attempt never published.
    assert.equal(result.stats.publicationRevision, before.publicationRevision + 1);
    assert.equal(result.stats.vaultGeneration, afterInvalidate.vaultGeneration);
    assert.equal(result.stats.snapshotGeneration, afterInvalidate.vaultGeneration);
    assert.equal(result.stats.freshness, "clean");
  } finally {
    fs.open = originalOpen;
  }
});

test("invalidation during enumeration fences the old attempt and retries", async () => {
  await getVaultIndex({ force: true });
  const before = getVaultIndexStats();

  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let blocked = false;
  const originalStat = fs.stat;
  fs.stat = async (candidate, ...rest) => {
    if (!blocked && String(candidate).endsWith("Home.md")) {
      blocked = true;
      enteredResolve();
      await release;
    }
    return originalStat.call(fs, candidate, ...rest);
  };

  try {
    const build = getVaultIndex();
    await entered;
    invalidateVaultIndex("Home.md");
    const afterInvalidate = getVaultIndexStats();
    releaseResolve();
    const result = await build;
    fs.stat = originalStat;

    assert.equal(result.stats.publicationRevision, before.publicationRevision + 1);
    assert.equal(result.stats.vaultGeneration, afterInvalidate.vaultGeneration);
    assert.equal(result.stats.freshness, "clean");
  } finally {
    fs.stat = originalStat;
  }
});

test("serialized builds prevent an earlier build from overwriting a later one", async () => {
  await fs.writeFile(path.join(vault, "Home.md"), "---\ntitle: Home\n---\n# Home old\n[[Projects/README]]\n");
  await fs.writeFile(path.join(vault, "Projects", "README.md"), "# README old\n");
  await getVaultIndex({ force: true });

  // G1 must re-read README; pause it on that read.
  await fs.writeFile(path.join(vault, "Projects", "README.md"), "# README v2\n");
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let blocked = false;
  const originalOpen = fs.open;
  fs.open = async (candidate, ...rest) => {
    if (!blocked && String(candidate).endsWith("README.md")) {
      blocked = true;
      enteredResolve();
      await release;
    }
    return originalOpen.call(fs, candidate, ...rest);
  };

  try {
    const g1 = getVaultIndex();
    await entered;
    // Change Home while G1 is paused, then queue G2. G2 must not run (and must
    // not be awaited) before G1's gate is released.
    await fs.writeFile(path.join(vault, "Home.md"), "---\ntitle: Home\n---\n# Home v2\n[[Projects/README]]\n");
    const g2 = getVaultIndex();
    releaseResolve();
    const [r1, r2] = await Promise.all([g1, g2]);
    fs.open = originalOpen;

    assert.equal(r2.stats.publicationRevision, r1.stats.publicationRevision + 1);
    assert.equal(r2.stats.vaultGeneration, r1.stats.vaultGeneration + 1);
    const final = getCachedVaultIndex();
    assert.equal(final.records.find((record) => record.path === "Home.md").content.includes("# Home v2"), true);
    assert.equal(final.records.find((record) => record.path === "Projects/README.md").content, "# README v2\n");
  } finally {
    fs.open = originalOpen;
  }
});

test("two fence conflicts exhaust retry with VAULT_INDEX_FENCE_CONFLICT and no publish", async () => {
  await getVaultIndex({ force: true });
  const before = getVaultIndexStats();

  let attempts = 0;
  const originalOpen = fs.open;
  fs.open = async (candidate, ...rest) => {
    if (String(candidate).endsWith("Home.md") && attempts < 2) {
      attempts += 1;
      invalidateVaultIndex("Home.md");
    }
    return originalOpen.call(fs, candidate, ...rest);
  };

  let error;
  try {
    await getVaultIndex({ force: true });
    assert.fail("expected a fence conflict");
  } catch (caught) {
    error = caught;
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(attempts, 2);
  assert.equal(error?.code, "VAULT_INDEX_FENCE_CONFLICT");
  const after = getVaultIndexStats();
  assert.equal(after.publicationRevision, before.publicationRevision);
  assert.equal(after.vaultGeneration, before.vaultGeneration + 2);
  assert.equal(after.freshness, "dirty");

  // The serialized queue stays usable after the failure.
  const recovered = await getVaultIndex({ force: true });
  assert.equal(recovered.stats.freshness, "clean");
  assert.ok(recovered.records.some((record) => record.path === "Home.md"));
});

test("full invalidation during a build discards the attempt and rebuilds cold", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();

  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let blocked = false;
  const originalOpen = fs.open;
  fs.open = async (candidate, ...rest) => {
    if (!blocked && String(candidate).endsWith("Home.md")) {
      blocked = true;
      enteredResolve();
      await release;
    }
    return originalOpen.call(fs, candidate, ...rest);
  };

  try {
    const build = getVaultIndex({ force: true });
    await entered;
    invalidateVaultIndex();
    assert.equal(getVaultIndexStats().freshness, "cold");
    assert.equal(getCachedVaultIndex(), null);
    releaseResolve();
    const result = await build;
    fs.open = originalOpen;

    assert.equal(result.stats.publicationRevision, before.publicationRevision + 1);
    assert.equal(result.stats.freshness, "clean");
    assert.equal(result.stats.snapshotGeneration, result.stats.vaultGeneration);
    assert.ok(result.records.some((record) => record.path === "Home.md"));
  } finally {
    fs.open = originalOpen;
  }
});

test("an out-of-band content change is observed with a single generation bump", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();
  await fs.writeFile(path.join(vault, "Projects", "TODO.md"), "# TODO rewritten out of band\n");

  const result = await getVaultIndex();
  assert.equal(result.stats.vaultGeneration, before.vaultGeneration + 1);
  assert.equal(result.stats.snapshotGeneration, result.stats.vaultGeneration);
  assert.equal(result.stats.publicationRevision, before.publicationRevision + 1);
  assert.equal(result.stats.freshness, "clean");

  const unchanged = await getVaultIndex();
  assert.equal(unchanged.stats.vaultGeneration, result.stats.vaultGeneration);
  assert.equal(unchanged.stats.publicationRevision, result.stats.publicationRevision + 1);
});

test("includeHidden identity switches republish without a content-generation bump", async () => {
  await getVaultIndex({ includeHidden: false });
  const base = getVaultIndexStats();

  const hidden = await getVaultIndex({ includeHidden: true });
  assert.equal(hidden.stats.vaultGeneration, base.vaultGeneration);
  assert.equal(hidden.stats.publicationRevision, base.publicationRevision + 1);
  assert.equal(hidden.stats.coverage.includeHidden, true);
  assert.ok(hidden.records.some((record) => record.path === ".hidden-note.md"));

  const back = await getVaultIndex({ includeHidden: false });
  assert.equal(back.stats.vaultGeneration, base.vaultGeneration);
  assert.equal(back.stats.publicationRevision, base.publicationRevision + 2);
  assert.equal(back.stats.coverage.includeHidden, false);
  assert.ok(!back.records.some((record) => record.path.startsWith(".")));
});

test("concurrent includeHidden callers receive independent return payloads", async () => {
  const [withHidden, withoutHidden] = await Promise.all([
    getVaultIndex({ includeHidden: true }),
    getVaultIndex({ includeHidden: false }),
  ]);
  assert.equal(withHidden.stats.coverage.includeHidden, true);
  assert.equal(withoutHidden.stats.coverage.includeHidden, false);
  assert.ok(withHidden.records.some((record) => record.path === ".hidden-note.md"));
  assert.ok(withoutHidden.records.every((record) => !record.path.startsWith(".")));
});

test("pathPrefix is a caller projection and each explicit refresh publishes once", async () => {
  await getVaultIndex();
  const before = getVaultIndexStats();

  const projects = await getVaultIndex({ pathPrefix: "Projects" });
  assert.deepEqual(pathsOf(projects), ["Projects/README.md", "Projects/TODO.md"]);
  assert.equal(projects.stats.vaultGeneration, before.vaultGeneration);
  assert.equal(projects.stats.publicationRevision, before.publicationRevision + 1);
  // The resolver is still built over the whole vault, not the projection.
  const resolved = projects.resolveLink({ target: "Home" }, "Projects/README.md");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.path, "Home.md");

  const home = await getVaultIndex({ pathPrefix: "Home.md" });
  assert.deepEqual(pathsOf(home), ["Home.md"]);
  assert.equal(home.stats.vaultGeneration, before.vaultGeneration);
  assert.equal(home.stats.publicationRevision, before.publicationRevision + 2);

  // The shared cache is whole-vault, not prefix-scoped.
  const cached = getCachedVaultIndex();
  assert.ok(cached.records.some((record) => record.path === "Home.md"));
  assert.ok(cached.records.some((record) => record.path === "Projects/README.md"));
});

test("an oversized note is clean+partial and becomes complete after it shrinks", async () => {
  const big = path.join(vault, "Big.md");
  await fs.writeFile(big, "x".repeat(2048));
  try {
    const index = await getVaultIndex({ force: true });
    assert.ok(index.stats.skipped >= 1);
    assert.equal(index.stats.freshness, "clean");
    assert.equal(index.stats.snapshotGeneration, index.stats.vaultGeneration);
    assert.equal(index.stats.coverage.completeness, "partial");
    assert.ok(index.stats.coverage.skipped >= 1);
    assert.ok(!index.records.some((record) => record.path === "Big.md"));

    await fs.writeFile(big, "# Big small\n");
    const shrunk = await getVaultIndex({ force: true });
    assert.ok(shrunk.records.some((record) => record.path === "Big.md"));
    assert.equal(shrunk.stats.skipped, 0);
    assert.equal(shrunk.stats.coverage.completeness, "complete");
  } finally {
    await fs.rm(big, { force: true });
    await getVaultIndex({ force: true });
  }
});

test("a size race (small stat, oversized read) is a clean skip, not a failure", async () => {
  const race = path.join(vault, "Race.md");
  await fs.writeFile(race, "y".repeat(4096));
  const originalStat = fs.stat;
  fs.stat = async (candidate, ...rest) => {
    const real = await originalStat.call(fs, candidate, ...rest);
    if (String(candidate).endsWith("Race.md")) return fakeStat(real, 10);
    return real;
  };
  try {
    const index = await getVaultIndex({ force: true });
    assert.ok(index.stats.skipped >= 1);
    assert.ok(!index.records.some((record) => record.path === "Race.md"));
    assert.equal(index.stats.freshness, "clean");
    assert.equal(index.stats.coverage.completeness, "partial");
  } finally {
    fs.stat = originalStat;
    await fs.rm(race, { force: true });
    await getVaultIndex({ force: true });
  }
});

test("a failed refresh keeps the last successful records/stats and marks dirty", async () => {
  await getVaultIndex({ force: true });
  const before = getVaultIndexStats();
  const beforeCached = getCachedVaultIndex();

  const todoAbs = path.join(vault, "Projects", "TODO.md");
  const boom = new Error("synthetic read failure");
  const originalOpen = fs.open;
  let injected = false;
  fs.open = async (candidate, ...rest) => {
    if (!injected && String(candidate) === todoAbs) {
      injected = true;
      const handle = await originalOpen.call(fs, candidate, ...rest);
      handle.read = async () => { throw boom; };
      return handle;
    }
    return originalOpen.call(fs, candidate, ...rest);
  };

  try {
    await assert.rejects(() => getVaultIndex({ force: true }), /synthetic read failure/);
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(injected, true);

  const after = getVaultIndexStats();
  assert.equal(after.publicationRevision, before.publicationRevision);
  assert.equal(after.files, before.files);
  assert.equal(after.reparsed, before.reparsed);
  assert.equal(after.lastRefresh, before.lastRefresh);
  assert.equal(after.freshness, "dirty");
  assert.deepEqual(pathsOf(getCachedVaultIndex()), pathsOf(beforeCached));
  assert.equal(getCachedVaultIndex().stats.freshness, "dirty");

  const recovered = await getVaultIndex({ force: true });
  assert.equal(recovered.stats.freshness, "clean");
});

test("getCachedVaultIndex stays compatible with the context-service revision map", async () => {
  await getVaultIndex();
  const cached = getCachedVaultIndex();
  assert.ok(cached && !(cached instanceof Map));
  assert.ok(Array.isArray(cached.records));
  assert.equal(typeof cached.resolveLink, "function");
  const revisionByPath = new Map(cached.records.map((entry) => [entry.path, entry.revision]));
  assert.equal(String(revisionByPath.get("Home.md")).startsWith("sha256:"), true);

  const context = await buildNoteContext({ path: "Home.md", includeRelated: false });
  assert.equal(context.status, "ok");
  assert.ok(
    !context.warnings.some((warning) => warning.code === "index_unavailable"),
    "the cached index must satisfy the context-service dependency",
  );

  invalidateVaultIndex();
  assert.equal(getCachedVaultIndex(), null);
});

test("getVaultIndexStats keeps legacy fields and only adds freshness fields", async () => {
  await getVaultIndex();
  const stats = getVaultIndexStats();
  for (const key of ["cachedNotes", "lastRefresh", "files", "reparsed", "reused", "removed", "skipped", "durationMs"]) {
    assert.ok(key in stats, `missing legacy stats key ${key}`);
  }
  for (const key of ["vaultGeneration", "snapshotGeneration", "publicationRevision", "freshness", "coverage"]) {
    assert.ok(key in stats, `missing additive stats key ${key}`);
  }
});
