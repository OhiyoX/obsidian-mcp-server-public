// Hot Routes Phase 0-A — reproducible source map for evidence group 2.
//
// The full mutation/invalidation matrix is documented in
// docs/review/hot-routes/phase0/mutation-invalidation-matrix.md. This test
// makes its central wiring claims reproducible: if a future change adds or
// removes an invalidateVaultIndex caller, or changes the cold/dirty semantics
// of the current module, this test fails and the matrix must be updated.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function collectJs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...await collectJs(url));
    else if (entry.name.endsWith(".js")) files.push(url);
  }
  return files;
}

function relative(url) {
  return decodeURIComponent(url.pathname).split("/src/").at(-1);
}

test("invalidateVaultIndex callers are exactly the recorded wiring set", async () => {
  // Wave D / D-workflows: `tools/workflows.js` moved off the facade name onto the selected
  // Vault's runtime (`src/workflow-runtimes.js` -> `index.invalidate(...)`), so it is no longer a
  // `invalidateVaultIndex` caller here. With no Vault selection that index *is* the primary
  // instance, so the legacy semantics are unchanged; the row moved in
  // `docs/review/hot-routes/phase0/mutation-invalidation-matrix.md` in this same change.
  const callers = [];
  for (const url of await collectJs(SRC)) {
    const text = await readFile(url, "utf8");
    if (/invalidateVaultIndex\s*\(/.test(text)) callers.push(relative(url));
  }
  // Wave D / D-intelligence (2026) removed `tools/intelligence.js` from this set: `memory_capture`
  // now invalidates the *selected Vault's* `vault-runtime/vault-index-runtime.js` instance
  // (`runtime.index.invalidate(...)`), so it no longer reaches the primary-bound facade name.
  // Wave D / D-plans (2026) removed `mutation-plans.js` and `tools/links.js` for the same reason:
  // `applyNotePlan` invalidates through `searchRuntimeFor(currentVaultRuntime())` and
  // `restore_version` through `resolveSearchRuntime()` — the per-Vault index instances D-search
  // materialized. With no Vault selection both resolve to the primary instance, so the legacy
  // semantics are unchanged; the rows moved in
  // `docs/review/hot-routes/phase0/mutation-invalidation-matrix.md` in this same change.
  // Tightening only — the documented matrix moved with it.
  assert.deepEqual(callers.sort(), [
    "vault-index.js",
  ]);
});

// Wave B / B2 (2026) moved the index implementation (and its state) out of `vault-index.js` into the
// per-Vault instance `vault-runtime/vault-index-runtime.js`, leaving `vault-index.js` as the
// compatibility facade. The behavioural assertions below are unchanged — only the file that must
// contain them moved with the code. The public invalidation name stays `vault-index.js`'s export,
// so the caller set above keeps describing real callers.
const INDEX_SOURCE = new URL("vault-runtime/vault-index-runtime.js", SRC);

test("path invalidation deletes one record without clearing indexBuilt", async () => {
  const text = await readFile(INDEX_SOURCE, "utf8");
  const pathBranch = text.match(/  function invalidate\(paths\) \{[\s\S]*?\n  \}/);
  assert.ok(pathBranch, "the runtime instance must own invalidate(paths)");
  const body = pathBranch[0];
  assert.match(body, /if \(!paths\) \{[\s\S]*?noteCache\.clear\(\)[\s\S]*?indexBuilt = false;/);
  assert.match(body, /noteCache\.delete\(normalizeVaultInput\(item\)\)/);
  // The single-path branch must not reset indexBuilt, which is what makes a
  // partially invalidated snapshot still report itself as cached.
  const pathOnly = body.split("noteCache.delete(normalizeVaultInput(item))")[1];
  assert.doesNotMatch(pathOnly, /indexBuilt\s*=\s*false/);
});

test("getCachedVaultIndex is cold exactly when indexBuilt is false", async () => {
  const text = await readFile(INDEX_SOURCE, "utf8");
  assert.match(text, /if \(!indexBuilt\) return null;/);
  assert.match(text, /indexBuilt = true;/);
});

test("note write tools do not import or call the vault index today", async () => {
  const notes = await readFile(new URL("tools/notes.js", SRC), "utf8");
  assert.doesNotMatch(notes, /vault-index/);
  assert.doesNotMatch(notes, /invalidateVaultIndex/);
});

test("batch failure semantics distinguish rollback from post-commit finalization", async () => {
  const write = await readFile(new URL("batch-write.js", SRC), "utf8");
  // afterFinish runs outside the try/catch, so its failure cannot enter the
  // rollback path.
  const catchIndex = write.indexOf("} catch (error) {");
  const afterFinishIndex = write.indexOf("if (afterFinish) await afterFinish();");
  assert.ok(catchIndex >= 0 && afterFinishIndex > catchIndex, "afterFinish must run outside the rollback try/catch");
  // A failed rollback surfaces as an AggregateError and leaves the journal.
  assert.match(write, /throw new AggregateError\(\[error, recoveryError\]/);
  assert.match(write, /Batch write failed; recovery journal remains/);

  const journal = await readFile(new URL("batch-journal.js", SRC), "utf8");
  // The non-committed state rolls back; the committed state never rolls back.
  assert.match(journal, /if \(manifest\.state !== "committed"\) \{/);
  assert.match(journal, /if \(manifest\.state === "committed"\) \{/);
  // Rollback restores only targets whose current revision equals `after`.
  assert.match(journal, /if \(current !== item\.after\) continue;/);
});

test("batch apply invalidates after the durable batch commit, not before", async () => {
  const text = await readFile(new URL("mutation-plans.js", SRC), "utf8");
  const apply = text.match(/export async function applyNotePlan\([\s\S]*?\n\}/);
  assert.ok(apply);
  const body = apply[0];
  const batchIndex = body.indexOf("await atomicWriteBatch(");
  // Wave D / D-plans: the call now goes through the lane helper (`src/plan-runtimes.js`), which
  // resolves the *selected* Vault's index instance (`searchRuntimeFor(currentVaultRuntime())` in
  // `src/search-runtimes.js`) instead of the primary-bound `invalidateVaultIndex` facade name. The
  // ordering requirement is unchanged.
  const invalidateIndex = body.indexOf("invalidateSelectedVaultIndex(results.map");
  assert.ok(batchIndex >= 0 && invalidateIndex > batchIndex, "invalidate must follow atomicWriteBatch");
  // Idempotent replay returns before invalidation; the original commit already
  // invalidated, and a process restart starts cold.
  assert.ok(body.indexOf("idempotentReplay: true") < invalidateIndex);
});
