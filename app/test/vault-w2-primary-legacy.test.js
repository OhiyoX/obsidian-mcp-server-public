import assert from "node:assert/strict";
import { execFile as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execCallback);

test("F3 legacy control: explicit unmanaged bootstrap keeps real primary Git and direct retrieval healthy", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "w2-primary-legacy-"));
  const root = path.join(base, "vaults", "legacy");
  const data = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(data);
  const indexFile = path.join(data, "retrieval-index.json");
  Object.assign(process.env, {
    VAULT_PATH: root, WEB_VAULTS_ROOT: path.dirname(root), WEB_DEFAULT_VAULT: "legacy", DATA_PATH: data,
    RETRIEVAL_INDEX_PATH: indexFile, VAULT_DISCOVERY_ENABLED: "false", EMBEDDING_PROVIDER: "disabled",
    RETRIEVAL_AUTO_EMBED: "false", GIT_ENABLED: "true", GIT_AUTO_COMMIT: "true",
    GIT_AUTO_COMMIT_SWEEP: "true", GIT_AUTO_PUSH: "false",
  });
  const git = async args => (await exec("git", ["-C", root, ...args], { timeout: 15_000 })).stdout.trim();
  const timers = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let worker, retrieval;
  try {
    await git(["init", "-q"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await fs.writeFile(path.join(root, "baseline.md"), "# baseline\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "baseline"]);
    assert.deepEqual(await fs.readdir(data), [], "neither admissions record nor enrollment sentinel exists");
    globalThis.setInterval = (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    };
    globalThis.clearInterval = timer => { if (timers.includes(timer)) timer.cleared = true; else realClear(timer); };
    worker = (await import("../src/git.js")).primaryGitRuntime();
    retrieval = await import("../src/retrieval.js");
    const { primaryAuthorizationState } = await import("../src/vault-runtime/primary-authorization.js");
    assert.equal(primaryAuthorizationState().mode, "legacy");
    assert.equal(timers.filter(timer => !timer.cleared).length, 1, "proven legacy arms its primary timer at import");
    const { primaryRuntime } = await import("../src/vault.js");
    const { webVaultRegistry } = await import("../src/app/vault-registry.js");
    const { createVaultCompositionRoot } = await import("../src/vault-runtime/vault-composition-root.js");
    const { startVaultRuntimeInventory } = await import("../src/app/vault-startup.js");
    const { vaultRuntimeMap } = createVaultCompositionRoot({ registry: webVaultRegistry, primaryRuntime,
      primaryRoot: root, dataRoot: data, writable: true });
    assert.equal((await startVaultRuntimeInventory({ runtimeMap: vaultRuntimeMap, logger: { log() {} } })).enabled, false);
    assert.equal(primaryAuthorizationState().mode, "legacy", "fallback inventory cannot change proven legacy mode");
    await worker.start();
    const head = await git(["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(root, "healthy.md"), "# healthy legacy\n");
    assert.equal((await timers.filter(timer => !timer.cleared).at(-1).fn()).committed, true);
    assert.notEqual(await git(["rev-parse", "HEAD"]), head);
    assert.ok((await retrieval.syncRetrievalIndex({ embeddings: false, force: true })).notes > 0);
    await fs.access(indexFile);
  } finally {
    worker?.stop();
    if (retrieval) await retrieval.drainRetrievalIndex();
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    await fs.rm(base, { recursive: true, force: true });
  }
});
