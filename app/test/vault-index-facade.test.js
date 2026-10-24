// B2 — `src/vault-index.js` compatibility-facade tests (contract §10.1 facade, §11, brief B2 §1.2).
//
// The facade must keep every legacy export with its pre-facade name and arity (existing callers
// are unchanged), must delegate to the one primary index runtime instead of holding state, and
// must bind that instance to the primary VaultRuntime plus the process-wide read limit.
// The instance-level isolation/serialization/purity suite is `test/vault-index-runtime.test.js`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The facade reads config.js at import time, so create the scratch primary root first and keep
// the ambient env inert (no Git, no embeddings, no retrieval debounce timer).
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b2-index-facade-"));
const primaryVaultRoot = path.join(scratch, "primary-vault");
await fs.mkdir(primaryVaultRoot, { recursive: true });
process.env.VAULT_PATH = primaryVaultRoot;
process.env.DATA_PATH = path.join(scratch, "data");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.RETRIEVAL_REFRESH_DEBOUNCE_MS = "60000";

const { MAX_READ_BYTES } = await import("../src/config.js");
const { primaryRuntime } = await import("../src/vault.js");
const facade = await import("../src/vault-index.js");
const indexModule = await import("../src/vault-runtime/vault-index-runtime.js");
const linksModule = await import("../src/vault-runtime/vault-index-links.js");

// Pre-facade export surface of `app/src/vault-index.js` (BASE of this lane), name -> declared
// arity. Signature ratchet: a renamed export, a changed default parameter or a wrapper that
// changes arity fails here.
const LEGACY_EXPORTS = Object.freeze({
  getVaultIndex: 0,
  getCachedVaultIndex: 0,
  getVaultIndexStats: 0,
  invalidateVaultIndex: 1,
  createLinkResolver: 1,
});
const ADDITIVE_EXPORTS = Object.freeze(["primaryIndexRuntime"]);

test("facade export snapshot: every legacy name survives with its original arity", () => {
  assert.deepEqual(Object.keys(facade).sort(), [...Object.keys(LEGACY_EXPORTS), ...ADDITIVE_EXPORTS].sort());
  for (const [name, arity] of Object.entries(LEGACY_EXPORTS)) {
    assert.equal(typeof facade[name], "function", `${name} must still be exported as a function`);
    assert.equal(facade[name].length, arity, `${name} signature changed (expected ${arity} declared parameters)`);
  }
  assert.equal(typeof facade.primaryIndexRuntime, "object");
});

test("facade binds the primary index runtime to the primary VaultRuntime and keeps delegation literal", () => {
  const index = facade.primaryIndexRuntime;
  assert.ok(Object.isFrozen(index));
  assert.equal(index.vaultRuntime, primaryRuntime, "the primary index runtime must wrap the primary VaultRuntime");
  assert.equal(index.vaultId, primaryRuntime.id);
  assert.equal(index.root, primaryRuntime.root);
  assert.equal(index.primary, true);
  assert.equal(index.localFs, primaryRuntime.localFs);
  assert.equal(index.maxReadBytes, MAX_READ_BYTES, "the facade injects the process-wide read limit");
  assert.equal(index.generation, 0, "the facade starts cold");
  assert.equal(index.publicationRevision, 0);
  for (const name of ["getVaultIndex", "getCachedVaultIndex", "getVaultIndexStats", "invalidate"]) {
    assert.equal(typeof index[name], "function", `primaryIndexRuntime.${name} must be a function`);
  }
  // The public facade exports are delegating wrappers (arity preserved), not the instance methods.
  assert.notEqual(facade.getVaultIndex, index.getVaultIndex);
  assert.notEqual(facade.invalidateVaultIndex, index.invalidate);
  // The root-free resolver is one function identity across the links module, the runtime module and the facade.
  assert.equal(facade.createLinkResolver, indexModule.createLinkResolver);
  assert.equal(facade.createLinkResolver, linksModule.createLinkResolver);
});

test("facade delegation is observable end to end through the primary Vault", async () => {
  const index = facade.primaryIndexRuntime;
  await fs.writeFile(path.join(primaryVaultRoot, "Facade.md"), "# Facade\n", "utf8");
  const beforeRevision = index.publicationRevision;
  const built = await facade.getVaultIndex({ force: true });
  assert.ok(built.records.some((record) => record.path === "Facade.md"));
  assert.equal(index.publicationRevision, beforeRevision + 1, "the facade export must move the instance");

  const cached = facade.getCachedVaultIndex();
  assert.equal(cached.stats.cached, true);
  assert.equal(facade.getVaultIndexStats().cachedNotes, index.noteCache.size);

  facade.invalidateVaultIndex("Facade.md");
  assert.equal(index.getVaultIndexStats().freshness, "dirty");
  assert.equal(index.generation, built.stats.vaultGeneration + 1);
  assert.equal(index.publicationRevision, beforeRevision + 1, "path invalidation never publishes");

  facade.invalidateVaultIndex([]);
  assert.equal(index.generation, built.stats.vaultGeneration + 1, "[] is an index no-op");
  facade.invalidateVaultIndex();
  assert.equal(index.getCachedVaultIndex(), null);
  assert.equal(index.getVaultIndexStats().freshness, "cold");
});

test("facade keeps the legacy stats/read payload shape", async () => {
  await fs.writeFile(path.join(primaryVaultRoot, "Shape.md"), "---\ntitle: Shape\n---\n# Shape\n", "utf8");
  const built = await facade.getVaultIndex({ force: true });
  for (const key of ["records", "resolveLink", "stats"]) assert.ok(key in built, `missing index key ${key}`);
  for (const key of ["files", "reparsed", "reused", "removed", "skipped", "durationMs", "lastRefresh"]) {
    assert.ok(key in built.stats, `missing legacy stats key ${key}`);
  }
  for (const key of ["vaultGeneration", "snapshotGeneration", "publicationRevision", "freshness", "coverage"]) {
    assert.ok(key in built.stats, `missing additive stats key ${key}`);
  }
  assert.equal(built.records.find((record) => record.path === "Shape.md").frontmatter.title, "Shape");
  const resolved = built.resolveLink({ target: "Shape" }, "Other.md");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.path, "Shape.md");
});
