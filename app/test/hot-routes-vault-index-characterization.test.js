// Hot Routes Phase 0-A — evidence group 1: exact current getCachedVaultIndex
// / getVaultIndex characterization.
//
// This is characterization only. It does not change app/src, does not add a
// generation/epoch API, and does not implement Hot Routes. It records the
// current observable behavior on a synthetic scratch vault so the Phase 0
// contract proposals (cold/dirty/clean, vaultGeneration) can be grounded.
//
// Deterministic: no timers, no live Vault, no network. The only injected
// failure is a refresh performed while the scratch vault root is renamed away,
// which fails at enumeration and therefore must leave the prior published
// snapshot untouched.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-hot-routes-vault-index-"));
const vault = path.join(root, "vault");
await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
await fs.writeFile(path.join(vault, "Home.md"), "---\ntitle: Home\n---\n# Home\n");
await fs.writeFile(path.join(vault, "Projects", "README.md"), "---\ntitle: Project\n---\n# Project\n");
await fs.writeFile(path.join(vault, "Projects", "TODO.md"), "---\ntitle: TODO\n---\n# TODO\n");

process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
// Keep the fixture small so the oversized-note skip path is exercised cheaply.
process.env.MAX_READ_BYTES = "1kb";
// The unref'd retrieval-refresh debounce must not fire during this file.
process.env.RETRIEVAL_REFRESH_DEBOUNCE_MS = "60000";

const { getVaultIndex, getCachedVaultIndex, invalidateVaultIndex, getVaultIndexStats } =
  await import("../src/vault-index.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ALL_PATHS = ["Home.md", "Projects/README.md", "Projects/TODO.md"];

function pathsOf(snapshot) {
  return snapshot.records.map((record) => record.path);
}

test("cold: no published snapshot before the first successful build", () => {
  assert.equal(getCachedVaultIndex(), null);
  const stats = getVaultIndexStats();
  assert.equal(stats.cachedNotes, 0);
  assert.equal(stats.lastRefresh, null);
});

test("successful refresh publishes a complete snapshot that survives loss of the vault root", async () => {
  const index = await getVaultIndex();
  assert.equal(index.stats.files, 3);
  assert.equal(index.stats.reparsed, 3);
  assert.deepEqual(pathsOf(index), ALL_PATHS);

  const cached = getCachedVaultIndex();
  assert.ok(cached, "cached snapshot is available after a successful build");
  assert.equal(cached.stats.cached, true);
  assert.deepEqual(pathsOf(cached), ALL_PATHS);

  // getCachedVaultIndex performs no Vault IO: with the vault root renamed away
  // it still returns the exact published snapshot.
  const moved = `${vault}-moved`;
  await fs.rename(vault, moved);
  try {
    const cachedWithoutVault = getCachedVaultIndex();
    assert.ok(cachedWithoutVault);
    assert.deepEqual(pathsOf(cachedWithoutVault), ALL_PATHS);
    assert.equal(cachedWithoutVault.stats.cached, true);
  } finally {
    await fs.rename(moved, vault);
  }
});

test("path invalidation removes one record but leaves a partially complete snapshot that still reports cached", async () => {
  await getVaultIndex();
  invalidateVaultIndex("Projects/TODO.md");

  const partial = getCachedVaultIndex();
  assert.ok(partial, "indexBuilt stays true after a single-path invalidation");
  assert.equal(partial.stats.cached, true);
  assert.deepEqual(pathsOf(partial), ["Home.md", "Projects/README.md"]);

  // The next full refresh re-adds the missing note.
  const rebuilt = await getVaultIndex();
  assert.deepEqual(pathsOf(rebuilt), ALL_PATHS);
});

test("full invalidation returns the index to cold and drops all records", async () => {
  await getVaultIndex();
  invalidateVaultIndex();

  assert.equal(getCachedVaultIndex(), null);
  assert.equal(getVaultIndexStats().cachedNotes, 0);

  await getVaultIndex();
  assert.deepEqual(pathsOf(getCachedVaultIndex()), ALL_PATHS);
});

test("a failed refresh preserves the prior successful snapshot atomically", async () => {
  await getVaultIndex();
  const before = getCachedVaultIndex();
  const beforeRefresh = before.stats.lastRefresh;

  const moved = `${vault}-offline`;
  await fs.rename(vault, moved);
  try {
    await assert.rejects(() => getVaultIndex(), "refresh must reject when the vault cannot be enumerated");
  } finally {
    await fs.rename(moved, vault);
  }

  const afterFailure = getCachedVaultIndex();
  assert.ok(afterFailure, "prior snapshot remains published after a failed refresh");
  assert.equal(afterFailure.stats.lastRefresh, beforeRefresh, "lastRefresh must not advance on failure");
  assert.deepEqual(pathsOf(afterFailure), ALL_PATHS);
});

test("an oversized note is skipped while the rest of the snapshot still publishes", async () => {
  const big = path.join(vault, "Big.md");
  await fs.writeFile(big, "x".repeat(2048));
  try {
    const index = await getVaultIndex();
    assert.ok(index.stats.skipped >= 1, "oversized note counted as skipped");
    assert.ok(!index.records.some((record) => record.path === "Big.md"), "oversized note absent from records");
    assert.deepEqual(pathsOf(index), ALL_PATHS);

    const cached = getCachedVaultIndex();
    assert.equal(cached.stats.cached, true);
    assert.ok(!cached.records.some((record) => record.path === "Big.md"));
  } finally {
    await fs.rm(big, { force: true });
    await getVaultIndex();
  }
});

test("unchanged signatures are reused rather than reparsed (parsed reuse vs stat enumeration)", async () => {
  await getVaultIndex();
  const second = await getVaultIndex();
  assert.equal(second.stats.files, 3);
  assert.equal(second.stats.reparsed, 0);
  assert.equal(second.stats.reused, second.stats.files);
});

test("out-of-band content changes are invisible to the cached snapshot until the next refresh", async () => {
  await getVaultIndex();
  const stale = getCachedVaultIndex().records.find((record) => record.path === "Home.md");
  await fs.writeFile(path.join(vault, "Home.md"), "---\ntitle: Home\n---\n# Home rewritten out of band\n");

  const stillCached = getCachedVaultIndex().records.find((record) => record.path === "Home.md");
  assert.equal(stillCached.content, stale.content, "cached snapshot does not observe the external write");

  const refreshed = await getVaultIndex();
  const fresh = refreshed.records.find((record) => record.path === "Home.md");
  assert.notEqual(fresh.content, stale.content, "the next refresh observes the external write");
  assert.equal(refreshed.stats.reparsed, 1);
  assert.equal(refreshed.stats.files, 3);
});

test("freshness is exposed as additive generation stats; no legacy generation/epoch alias exists", () => {
  const stats = getVaultIndexStats();
  assert.equal(typeof stats.cachedNotes, "number");
  assert.ok("lastRefresh" in stats);
  // Phase 0-B intentionally adds these derived freshness fields; this test is
  // updated from the Phase 0-A "no generation/epoch" characterization.
  assert.equal(typeof stats.vaultGeneration, "number");
  assert.equal(typeof stats.publicationRevision, "number");
  assert.ok(["cold", "dirty", "clean"].includes(stats.freshness));
  assert.ok(stats.coverage === null || typeof stats.coverage === "object");
  // The never-published legacy names stay absent.
  assert.ok(!("generation" in stats));
  assert.ok(!("epoch" in stats));
});
