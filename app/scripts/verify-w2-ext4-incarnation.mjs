// Real production resolver/store/map. No fs injection and no controlled replacement helper.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { isHandleCurrent } from "../src/vault-runtime/runtime-lease.js";
import { createGitRuntime } from "../src/git-runtime/runtime.js";

const quiet = { info() {}, warn() {}, log() {} };
const exec = promisify(execFile);
const git = async (root, args) => (await exec("git", ["-C", root, ...args], { timeout: 10000 })).stdout.trim();
async function initializeGit(root) {
  await git(root, ["init", "-q"]); await git(root, ["config", "user.email", "test@example.com"]); await git(root, ["config", "user.name", "Test"]);
  await git(root, ["add", "-A"]); await git(root, ["commit", "-qm", "baseline"]);
}
async function open(base) {
  const root = path.join(base, "vaults", "alpha");
  const gate = createVaultServingGate(); gate.arm();
  let service;
  const registry = createVaultRegistry({ primaryRoot: path.join(base, "primary"), primaryId: "vault", vaultsRoot: path.dirname(root),
    gate: descriptor => service.gate(descriptor), servingGate: gate });
  const store = createAdmissionStore({ file: path.join(base, "data", "vault-admissions.json"), logger: quiet });
  await store.load();
  const map = createVaultRuntimeMap({ registry, dataRoot: path.join(base, "data"), primaryRuntime: { id: "vault", root: path.join(base, "primary"), primary: true, localFs: {} } });
  service = createReconciliationService({ registry, runtimeMap: map, admissions: store, logger: quiet });
  return { root, registry, store, map, service, async close() { service.stop(); map.dispose(); await map.settleRetirements(); } };
}
if (process.argv[2] === "--restart") {
  const w = await open(process.argv[3]);
  try {
    await w.service.reconcile("startup");
    const handle = w.map.get("alpha");
    let approveRefused = false;
    if (!handle) { try { await w.service.approve("alpha", { actor: "admin:test" }); } catch { approveRefused = true; } }
    console.log(JSON.stringify({ visible: Boolean(handle), read: handle ? await handle.localFs.readLimitedText(path.join(w.root, "proof.md")) : null,
      digest: w.store.entryFor("alpha").identity.digest, approveRefused }));
  } finally { await w.close(); }
} else {
  assert.equal(process.platform, "linux", "this evidence requires real Linux ext4");
  assert.equal((await fs.statfs("/var/tmp")).type, 0xef53, "fixture must be native ext4");
  const base = await fs.mkdtemp("/var/tmp/i437-incarnation-");
  let w; let worker;
  try {
    await fs.mkdir(path.join(base, "primary")); await fs.mkdir(path.join(base, "data"));
    await fs.mkdir(path.join(base, "vaults", "alpha"), { recursive: true });
    w = await open(base);
    await fs.writeFile(path.join(w.root, "proof.md"), "original-body");
    await w.service.initializeVaults({ confirm: ["alpha"], actor: "admin:test", source: "ext4-explicit" });
    await w.service.reconcile("startup");
    await initializeGit(w.root);
    const original = w.store.entryFor("alpha").identity;
    const old = w.map.get("alpha");
    assert.equal(await old.localFs.readLimitedText(path.join(w.root, "proof.md")), "original-body");
    const restart = () => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--restart", base],
      { encoding: "utf8", timeout: 20000 }).trim().split("\n").at(-1));
    const healthy = restart();
    assert.equal(healthy.visible, true); assert.equal(healthy.read, "original-body"); assert.equal(healthy.digest, original.digest);
    const timers = [];
    const scheduler = { setInterval(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearInterval() {},
      setTimeout(fn) { return { fn, unref() {} }; }, clearTimeout() {} };
    worker = createGitRuntime({ vaultId: "alpha", root: w.root, configProvider: () => ({ enabled: true, autoCommit: true, autoCommitSweep: true, autoPush: false,
      debounceSeconds: 60, maxDelaySeconds: 600, sweepIntervalSeconds: 30, remote: "origin", branch: "" }),
      execFile: exec, guard: () => isHandleCurrent(old), scheduler, logger: quiet });
    await worker.start(); const oldTimer = timers.at(-1);
    await fs.writeFile(path.join(w.root, "healthy.md"), "healthy work");
    assert.equal((await oldTimer.fn()).committed, true, "real Git healthy control");
    let replacementCount = 0; let after;
    do {
      await fs.rm(w.root, { recursive: true, force: true }); await fs.mkdir(w.root);
      after = await fs.stat(w.root, { bigint: true }); replacementCount += 1;
      // Keep nonmatching allocations alive so the allocator can reach the freed ORIGINAL inode
      // instead of endlessly recycling the first .git child inode. These are real empty directories.
      if (String(after.ino) !== original.fileId && replacementCount < 4000) {
        await fs.rename(w.root, path.join(base, `allocator-hold-${replacementCount}`));
      }
    } while ((String(after.dev) !== original.volumeId || String(after.ino) !== original.fileId) && replacementCount < 4000);
    assert.equal(String(after.dev), original.volumeId); assert.equal(String(after.ino), original.fileId, "must observe real inode reuse, never injected");
    await fs.writeFile(path.join(w.root, "proof.md"), "replacement-body");
    await initializeGit(w.root); const replacementHead = await git(w.root, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(w.root, "must-not-commit.md"), "replacement work");
    const beforeScanWorkerCurrent = isHandleCurrent(old);
    const oldGitCallback = await oldTimer.fn();
    const oldGitDirect = await worker.sweepNow();
    const replacementHeadUnchanged = await git(w.root, ["rev-parse", "HEAD"]) === replacementHead;
    let oldRead = null; let oldReadCode = null;
    try { oldRead = await old.localFs.readLimitedText(path.join(w.root, "proof.md")); } catch (error) { oldReadCode = error.code; }
    const reconciliation = await w.service.reconcile("manual");
    const restarted = restart();
    const evidence = { platform: process.platform, filesystemType: (await fs.statfs(base)).type, replacementCount, tupleReused: true,
      original: { identityVersion: original.identityVersion, digest: original.digest, volumeId: original.volumeId, fileId: original.fileId },
      after: { volumeId: String(after.dev), fileId: String(after.ino) }, healthy, beforeScanWorkerCurrent,
      oldGitCallback, oldGitDirect, replacementHeadUnchanged,
      oldRead, oldReadCode, reconciliation: reconciliation.status, storedAdmission: w.store.entryFor("alpha").admission,
      bindingPreserved: w.store.entryFor("alpha").identity.digest === original.digest, currentVisible: w.map.has("alpha"), restarted };
    console.log(JSON.stringify(evidence));
    assert.equal(beforeScanWorkerCurrent, false, "captured worker guard must refuse before any scan");
    assert.equal(oldGitCallback.committed, false); assert.equal(oldGitDirect.committed, false); assert.equal(replacementHeadUnchanged, true);
    assert.equal(oldRead, null, "old handle must never read replacement content");
    assert.equal(oldReadCode, "VAULT_RUNTIME_LEASE_REVOKED");
    assert.equal(w.map.has("alpha"), false); assert.equal(evidence.bindingPreserved, true);
    assert.equal(restarted.visible, false); assert.equal(restarted.approveRefused, true);
  } finally {
    worker?.stop(); await w?.close(); await fs.rm(base, { recursive: true, force: true });
  }
}
