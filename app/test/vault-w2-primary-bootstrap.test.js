import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { INCARNATION_FILE } from "../src/vault-runtime/incarnation.js";
const exec = promisify(execCallback);
const base = await fs.mkdtemp(path.join(os.tmpdir(), "w2-bootstrap-"));
const root = path.join(base, "vaults", "vault"); const data = path.join(base, "data");
await fs.mkdir(root, { recursive: true }); await fs.mkdir(data);
Object.assign(process.env, { VAULT_PATH: root, WEB_VAULTS_ROOT: path.dirname(root), WEB_DEFAULT_VAULT: "vault",
  DATA_PATH: data, RETRIEVAL_INDEX_PATH: path.join(data, "retrieval-index.json"), GIT_ENABLED: "true",
  GIT_AUTO_COMMIT: "true", GIT_AUTO_COMMIT_SWEEP: "true", GIT_AUTO_PUSH: "false",
  VAULT_DISCOVERY_ENABLED: "true", EMBEDDING_PROVIDER: "disabled", RETRIEVAL_AUTO_EMBED: "false" });
const git = async args => (await exec("git", ["-C", root, ...args])).stdout.trim();
await git(["init", "-q"]); await git(["config", "user.email", "test@example.com"]); await git(["config", "user.name", "Test"]);
await fs.writeFile(path.join(root, "baseline.md"), "# baseline"); await git(["add", "-A"]); await git(["commit", "-qm", "baseline"]);
const timers = []; const realSet = globalThis.setInterval; const realClear = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; };
globalThis.clearInterval = timer => { if (timers.includes(timer)) timer.cleared = true; else realClear(timer); };
const { primaryGitRuntime } = await import("../src/git.js");
const activeAtImport = timers.filter(timer => !timer.cleared).length;
const retrieval = await import("../src/retrieval.js");
const { primaryRuntime } = await import("../src/vault.js");
const registry = await import("../src/app/vault-registry.js");
const { startVaultRuntimeInventory } = await import("../src/app/vault-startup.js");
const { createVaultCompositionRoot } = await import("../src/vault-runtime/vault-composition-root.js");
const { allowPrimaryAuthorization, primaryAuthorizationToken } = await import("../src/vault-runtime/primary-authorization.js");
const { vaultRuntimeMap: map } = createVaultCompositionRoot({ registry: registry.webVaultRegistry, primaryRuntime,
  primaryRoot: root, dataRoot: data, writable: true });
const exists = file => fs.access(file).then(() => true, () => false);
const worker = primaryGitRuntime(); const indexFile = path.join(data, "retrieval-index.json");
// Observe the REAL startup probes so directory replacement waits for entered git children.
// This adds no timing assumption and preserves every start call and its returned promise.
const startupFlights = new Set(); const startWorker = worker.start;
worker.start = function (...args) {
  const flight = startWorker.apply(this, args); startupFlights.add(flight);
  flight.then(() => startupFlights.delete(flight), () => startupFlights.delete(flight));
  return flight;
};
test.after(async () => { worker.stop(); globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
  await retrieval.drainRetrievalIndex(); await map.settleRetirements(); await fs.rm(base, { recursive: true, force: true }); });

test("F3: managed import/start refuses before initialization and binds without resolver queries", async () => {
  assert.equal(activeAtImport, 0, "managed raw primary must not arm timers during import");
  assert.equal(allowPrimaryAuthorization(), false, "allow cannot grant an uninitialized primary authority");
  const head = await git(["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "uninitialized.md"), "# uninitialized");
  const result = await worker.sweepNow();
  assert.equal(result.committed, false);
  assert.equal(await git(["rev-parse", "HEAD"]), head);
  assert.equal(timers.filter(timer => !timer.cleared).length, 0);
  assert.equal(retrieval.startRetrievalIndex({ embeddings: false }).unavailable, true);
  await startVaultRuntimeInventory({ runtimeMap: map, logger: { log() {} } });
  await registry.initializeVaultAdmissions({ confirm: [], actor: "admin:test", source: "test" });
  const boundToken = primaryAuthorizationToken();
  assert.equal(boundToken, map.leaseOf("vault"), "composition binds the authoritative lease before resolver queries");
  allowPrimaryAuthorization(); // F3: allow primary after initialization
  assert.equal(primaryAuthorizationToken(), boundToken, "allow must preserve identity/generation authorization");
  await worker.start();
  const timer = timers.filter(timer => !timer.cleared).at(-1);
  assert.equal(typeof timer?.fn, "function");
  await fs.writeFile(path.join(root, "healthy.md"), "# healthy");
  assert.equal((await timer.fn()).committed, true, "real Git positive control");
  const control = await git(["rev-parse", "HEAD"]);
  // No searchRuntimeFor or gitRuntimeFor query has occurred anywhere in this file.
  retrieval.scheduleRetrievalRefresh({ embeddings: false });
  await registry.revokeVaultAdmission("vault", { actor: "admin:test" });
  assert.equal(allowPrimaryAuthorization(), false, "allow cannot revive revoked authorization");
  assert.equal(timer.cleared, true);
  await retrieval.drainRetrievalIndex();
  assert.equal(await exists(indexFile), false, "release must cancel, never promote, the unstarted debounce");
  assert.equal((await timer.fn()).committed, false);
  assert.equal(await git(["rev-parse", "HEAD"]), control);
  assert.equal(registry.webVaultRegistry.refusal("vault").httpStatus, 403);
  await registry.approveVaultAdmission("vault", { actor: "admin:test" });
  assert.equal((await timer.fn()).committed, false, "old callback cannot inherit reapproval");
  await fs.writeFile(path.join(root, "fresh.md"), "# fresh");
  const freshTimer = timers.filter(timer => !timer.cleared).at(-1);
  assert.notEqual(freshTimer, timer);
  assert.equal((await freshTimer.fn()).committed, true);
});

test("F4: actual exported direct sync refuses after durable revoke and creates zero index files", async () => {
  if (!registry.vaultDiscoveryStatus().initialized) {
    await startVaultRuntimeInventory({ runtimeMap: map, logger: { log() {} } });
    await registry.initializeVaultAdmissions({ confirm: [], actor: "admin:test", source: "test" });
  }
  const { searchRuntimeFor } = await import("../src/search-runtimes.js");
  searchRuntimeFor(map.get("vault"));
  await registry.revokeVaultAdmission("vault", { actor: "admin:test" });
  const result = await retrieval.syncRetrievalIndex({ embeddings: false, force: true });
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, "vault_runtime_lease_revoked");
  assert.equal(await exists(indexFile), false);
  assert.equal((await retrieval.retrievalIndexStatus()).indexJob, null, "read-only status is still usable");
  await registry.approveVaultAdmission("vault", { actor: "admin:test" });
  searchRuntimeFor(map.get("vault")); // Re-bind after approval
  const allowed = await retrieval.syncRetrievalIndex({ embeddings: false, force: true });
  assert.ok(allowed.notes > 0); assert.equal(await exists(indexFile), true);
});

test("R-C: restored primary proof and equal-generation approval renew real Git/search while old consumers stay dead", async () => {
  const { gitRuntimeFor } = await import("../src/git-runtimes.js");
  const { searchRuntimeFor } = await import("../src/search-runtimes.js");
  const old = map.get("vault"); const oldLease = map.leaseOf("vault");
  const oldGit = gitRuntimeFor(old); const oldSearch = searchRuntimeFor(old);
  await worker.start(); await Promise.all([...startupFlights]);
  const oldTimer = timers.filter(timer => !timer.cleared).at(-1);
  assert.equal(typeof oldTimer?.fn, "function");
  const captureRefresh = search => {
    const realTimeout = globalThis.setTimeout; let captured;
    globalThis.setTimeout = (fn, ms) => { captured = realTimeout(fn, ms); captured.refreshCallback = fn; return captured; };
    try { search.retrieval.scheduleRetrievalRefresh({ embeddings: false }); }
    finally { globalThis.setTimeout = realTimeout; }
    clearTimeout(captured); // Invoke the real callback ourselves, with its original authorization token.
    assert.equal(typeof captured?.refreshCallback, "function");
    return captured.refreshCallback;
  };
  const oldRefresh = captureRefresh(oldSearch);
  await fs.rm(indexFile, { force: true });
  const generation = oldLease.generation;
  const proofFile = path.join(root, INCARNATION_FILE); const proof = await fs.readFile(proofFile);
  const binding = registry.webVaultRegistry.admission("vault").identityDigest;
  await fs.rm(proofFile);
  assert.throws(() => old.localFs.readLimitedText(path.join(root, "baseline.md")), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
  assert.equal(oldLease.generation, generation + 1); assert.equal(oldLease.revoked, true);
  await fs.writeFile(proofFile, proof);
  assert.equal((await registry.approveVaultAdmission("vault", { actor: "admin:test" })).status, "committed");
  const freshLease = map.leaseOf("vault");
  assert.equal(freshLease.generation, oldLease.generation, "the exact R-C numeric collision");
  assert.notEqual(freshLease, oldLease);
  assert.equal(primaryAuthorizationToken(), freshLease, "publish rebinds primary authority before resolver queries");
  assert.equal(registry.webVaultRegistry.admission("vault").identityDigest, binding);
  assert.ok(proof.equals(await fs.readFile(proofFile)));
  const fresh = map.get("vault");
  assert.equal(await fresh.localFs.readLimitedText(path.join(root, "baseline.md")), "# baseline");
  const currentGit = gitRuntimeFor(fresh); const currentSearch = searchRuntimeFor(fresh);
  await currentGit.start(); await Promise.all([...startupFlights]);
  const currentTimer = timers.filter(timer => !timer.cleared).at(-1);
  assert.notEqual(currentTimer, oldTimer);
  assert.notEqual(currentGit, oldGit); assert.notEqual(currentSearch, oldSearch);
  const head = await git(["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "rc-recovered.md"), "# recovered primary work");
  assert.equal((await oldTimer.fn()).committed, false);
  await assert.rejects(async () => oldGit.sweepNow(), { code: "git_runtime_lease_revoked" });
  assert.throws(() => oldSearch.retrieval.startRetrievalIndex({ embeddings: false }), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
  oldRefresh(); await retrieval.drainRetrievalIndex();
  assert.equal(await exists(indexFile), false, "old retrieval callback cannot write after the fresh binding");
  assert.equal(await git(["rev-parse", "HEAD"]), head, "old Git work never commits");
  assert.equal(gitRuntimeFor(fresh), currentGit); assert.equal(searchRuntimeFor(fresh), currentSearch);
  assert.equal((await currentTimer.fn()).committed, true, "fresh real Git timer commits");
  assert.notEqual(await git(["rev-parse", "HEAD"]), head);
  assert.equal(await git(["show", "HEAD:rc-recovered.md"]), "# recovered primary work");
  captureRefresh(currentSearch)(); await retrieval.drainRetrievalIndex();
  assert.equal(await exists(indexFile), true, "fresh real search callback writes the index");
  const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
  assert.ok(JSON.stringify(index).includes("recovered primary work"));
  assert.throws(() => old.localFs.readLimitedText(path.join(root, "baseline.md")), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
  assert.equal(oldLease.revoked, true);
});

test("R-B: real primary Git callback and direct retrieval refuse a replacement before scanning and stay dead", async () => {
  let deadline;
  try {
    await Promise.race([Promise.all([...startupFlights]), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Git startup did not settle before replacement")), 20000); deadline.unref();
    })]);
  } finally { clearTimeout(deadline); }
  const handle = map.get("vault");
  const oldTimer = timers.filter(timer => !timer.cleared).at(-1);
  assert.equal(typeof oldTimer.fn, "function");
  await fs.rm(indexFile, { force: true });
  // Replace the actual managed directory; no resolver/stat injection.
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root);
  await git(["init", "-q"]); await git(["config", "user.email", "test@example.com"]); await git(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "replacement.md"), "replacement-body");
  await git(["add", "-A"]); await git(["commit", "-qm", "replacement baseline"]);
  const head = await git(["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "must-not-commit.md"), "replacement new work");
  assert.equal((await oldTimer.fn()).committed, false);
  assert.equal((await worker.sweepNow()).committed, false);
  assert.equal(await git(["rev-parse", "HEAD"]), head);
  assert.equal((await retrieval.syncRetrievalIndex({ embeddings: false, force: true })).unavailable, true);
  assert.equal(await exists(indexFile), false);
  assert.throws(() => handle.localFs.readLimitedText(path.join(root, "replacement.md")), error => error.code === "VAULT_RUNTIME_LEASE_REVOKED");
  assert.equal((await registry.reconcileVaults("manual", { actor: "admin:test" })).status, "committed");
  await assert.rejects(registry.approveVaultAdmission("vault", { actor: "admin:test" }), error => error.code === "VAULT_ADMISSION_IDENTITY_CONFLICT");
  assert.equal((await oldTimer.fn()).committed, false);
  assert.equal((await retrieval.syncRetrievalIndex({ embeddings: false, force: true })).unavailable, true);
  assert.equal(await exists(indexFile), false);
  assert.equal(await git(["rev-parse", "HEAD"]), head);
});
