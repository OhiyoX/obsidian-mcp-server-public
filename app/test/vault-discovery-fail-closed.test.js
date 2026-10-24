// W2 (#437) — fail-closed integration at the real composition seam (acceptance hard gate).
//
// The W2 acceptance hard gate: "文件缺失/损坏不得被现有 `primary-only` 降级路径吞掉后开放 Vault" —
// a missing or corrupt `vault-admissions.json` must not let the pre-W2 primary-only degrade path open
// discovered Vaults. This file exercises the REAL modules (`src/app/vault-registry.js`,
// `src/app/vault-startup.js`) and the REAL `server.js` entry point in subprocesses, because
// `config.js` reads its environment at module load and the Web registry is a module singleton.
//
// Covered: initialization / state loss (delete + restart) / corrupt-file refusal (bytes preserved) /
// missing-file refusal to auto-approve — the W2 hard-gate list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROBE = `
import {
  initializeVaultAdmissions,
  listWebVaults,
  loadVaultAdmissions,
  revokeVaultAdmission,
  vaultDiscoveryStatus,
} from "./src/app/vault-registry.js";
import { startVaultRuntimeInventory } from "./src/app/vault-startup.js";
const quiet = { info() {}, warn() {}, log() {} };
const out = {};
try {
  out.admissions = await loadVaultAdmissions();
  if (out.admissions.enabled) {
    await startVaultRuntimeInventory({ runtimeMap: null, logger: quiet });
    out.started = true;
  }
  if (process.env.PROBE_INIT === "true") {
    out.approved = await initializeVaultAdmissions({ confirm: JSON.parse(process.env.PROBE_CONFIRM || "[]"), actor: "admin:probe", source: "probe-cli" });
  }
  if (process.env.PROBE_REVOKE) {
    await revokeVaultAdmission(process.env.PROBE_REVOKE, { actor: "admin:probe" });
    out.revoked = process.env.PROBE_REVOKE;
  }
  out.vaults = (await listWebVaults()).vaults.map((vault) => vault.id).sort();
  const status = vaultDiscoveryStatus();
  out.status = {
    initialized: status.initialized,
    vaults: Object.fromEntries(Object.entries(status.vaults ?? {}).map(([id, value]) => [id, { admission: value.admission ?? null, status: value.status, reason: value.reason ?? null }])),
  };
} catch (error) {
  out.error = { code: error?.code ?? null, message: String(error?.message ?? error) };
}
console.log("PROBE_RESULT " + JSON.stringify(out));
`;

async function withWorld({ vaults = ["alpha", "beta"] }, task) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-failclosed-"));
  const primary = path.join(base, "primary");
  const root = path.join(base, "vaults");
  const data = path.join(base, "data");
  await fs.mkdir(primary, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(root, id), { recursive: true });
  const admissionsFile = path.join(data, "vault-admissions.json");
  try {
    return await task({ base, primary, root, data, admissionsFile });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

function probeEnv(world, extra = {}) {
  return {
    ...process.env,
    VAULT_PATH: world.primary,
    DATA_PATH: world.data,
    WEB_VAULTS_ROOT: world.root,
    WEB_DEFAULT_VAULT: "vault",
    EMBEDDING_PROVIDER: "disabled",
    GIT_ENABLED: "false",
    ...extra,
  };
}

function runProbe(world, extra = {}, replacement = null) {
  // Test-only syscall seam; the real controller/store/restart run unchanged. A confirmed replacement
  // has a distinct file id even if this filesystem reuses the deleted directory's inode.
  const prefix = replacement === null ? "" : `
    import fs from "node:fs/promises";
    const originalStat = fs.stat;
    fs.stat = async (root, options) => {
      const stat = await originalStat(root, options);
      if (root === ${JSON.stringify(path.join(world.root, "alpha"))} && options?.bigint === true) {
        return new Proxy(stat, { get(target, key) {
          if (key === "ino") return BigInt(${JSON.stringify(replacement.fileId)});
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }});
      }
      return stat;
    };
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", prefix + PROBE], { cwd: APP_ROOT, env: probeEnv(world, extra), encoding: "utf8", timeout: 60_000 });
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("PROBE_RESULT "));
  const probe = line ? JSON.parse(line.slice("PROBE_RESULT ".length)) : null;
  return { probe, status: result.status, stderr: result.stderr };
}

test("discovery disabled (default) with NO record: the pre-W2 inventory is unchanged (nothing to manage yet)", async () => {
  await withWorld({}, async (world) => {
    const { probe, status } = runProbe(world);
    assert.equal(status, 0, "the probe process must exit cleanly");
    assert.deepEqual(probe.admissions, { enabled: false, initialized: false, revision: 0 });
    assert.deepEqual(probe.vaults, ["alpha", "beta", "vault"], "without any record and without the switch there is nothing to enforce");
    assert.equal(probe.status.initialized, false);
    await assert.rejects(fs.stat(world.admissionsFile), "the disabled path must not create an admission record");
  });
});

test("ITEM 2: turning the discovery switch OFF cannot un-manage an existing instance", async () => {
  await withWorld({}, async (world) => {
    // ① explicit initialization with the switch ON approves only the confirmed list.
    const initial = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true", PROBE_INIT: "true", PROBE_CONFIRM: '["alpha"]' });
    assert.deepEqual(initial.probe.vaults, ["alpha", "vault"]);

    // ② the switch is now OFF, but the record exists ⇒ enforcement stays on.
    const off = runProbe(world, {});
    assert.equal(off.status, 0);
    assert.equal(off.probe.admissions.enabled, true, "an existing record keeps the gate enforced with the switch off");
    assert.deepEqual(off.probe.vaults, ["alpha", "vault"], "approved Vaults keep serving");
    assert.equal(off.probe.status.vaults.beta.status, "pending", "a pending Vault stays unavailable with the switch off");

    // ③ revoke alpha while the switch is on, then restart with the switch OFF: it must stay refused.
    const revoked = runProbe(world, { PROBE_REVOKE: "alpha" });
    assert.equal(revoked.probe.revoked, "alpha");
    assert.deepEqual(revoked.probe.vaults, ["vault"], "a revoked Vault is unavailable immediately");
    const afterOff = runProbe(world, {});
    assert.equal(afterOff.probe.admissions.initialized, true);
    assert.deepEqual(afterOff.probe.vaults, ["vault"], "the revoked decision survives a restart with the switch off");
    assert.equal(afterOff.probe.status.vaults.alpha.reason, "awaiting-approval");
  });
});

test("ITEM 2: a corrupt record still fail-closes with the discovery switch OFF", async () => {
  await withWorld({}, async (world) => {
    const corrupt = '{ "version": 1, "revision": 2, "migration": { "done": true, ';
    await fs.writeFile(world.admissionsFile, corrupt, "utf8");
    const { probe, status } = runProbe(world, {});
    assert.equal(status, 0, "the probe reports rather than crashes");
    assert.equal(probe.error.code, "VAULT_ADMISSIONS_CORRUPT", "state loss/corruption refuses even with the switch off");
    assert.equal(probe.vaults, undefined, "no inventory may be produced after a corrupt load");
    assert.equal(await fs.readFile(world.admissionsFile, "utf8"), corrupt, "the corrupt file stays byte-for-byte");
  });
});

test("HARD GATE: discovery enabled + MISSING admission file opens no discovered Vault", async () => {
  await withWorld({}, async (world) => {
    const { probe, status } = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true" });
    assert.equal(status, 0, "a missing file is not corruption: the process must still start");
    assert.equal(probe.admissions.enabled, true);
    assert.equal(probe.admissions.initialized, false);
    assert.equal(probe.started, true);
    assert.deepEqual(probe.vaults, [], "the primary is described structurally but has NO service right before initialization");
    assert.equal(probe.status.vaults.alpha.status, "pending");
    assert.equal(probe.status.vaults.alpha.reason, "admissions-not-initialized");
    assert.equal(probe.status.vaults.vault.status, "pending");
    await assert.rejects(fs.stat(world.admissionsFile), "an uninitialized round must not create the record");
  });
});

test("HARD GATE: discovery enabled + CORRUPT admission file is fail-closed and preserved", async () => {
  await withWorld({}, async (world) => {
    const corrupt = '{ "version": 1, "revision": 2, "migration": { "done": true, ';
    await fs.writeFile(world.admissionsFile, corrupt, "utf8");
    const { probe, status } = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true" });
    assert.equal(status, 0, "the probe catches the error to report it; the SERVER-level refusal is covered below");
    assert.equal(probe.error.code, "VAULT_ADMISSIONS_CORRUPT");
    assert.equal(probe.vaults, undefined, "no inventory may be produced after a corrupt load");
    assert.equal(await fs.readFile(world.admissionsFile, "utf8"), corrupt, "the corrupt file must be preserved byte-for-byte");
  });
});

test("initialization / state loss: only the confirmed list is approved, a restart keeps it, deleting the file does not re-approve", async () => {
  await withWorld({}, async (world) => {
    // ① explicit administrator initialization on an uninitialized store.
    const initial = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true", PROBE_INIT: "true", PROBE_CONFIRM: '["alpha"]' });
    assert.equal(initial.status, 0);
    assert.deepEqual(initial.probe.approved.sort(), ["alpha", "vault"], "the configured primary plus the confirmed list");
    assert.deepEqual(initial.probe.vaults, ["alpha", "vault"], "beta was discovered but not confirmed");
    assert.equal(initial.probe.status.vaults.beta.status, "pending");
    const document = JSON.parse(await fs.readFile(world.admissionsFile, "utf8"));
    assert.equal(document.migration.done, true);
    assert.equal(document.migration.source, "probe-cli");
    assert.equal(document.entries.alpha.admission, "approved");
    assert.equal(document.entries.beta.admission, "pending");

    // ② restart: the persisted decision is honoured without any re-initialization.
    const restarted = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true" });
    assert.equal(restarted.status, 0);
    assert.equal(restarted.probe.admissions.initialized, true);
    assert.deepEqual(restarted.probe.vaults, ["alpha", "vault"]);
    assert.deepEqual(restarted.probe.status.initialized, true);

    // ③ state loss: deleting the record must NOT be treated as a first enable (no auto re-approval).
    await fs.rm(world.admissionsFile, { force: true });
    const afterLoss = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true" });
    assert.equal(afterLoss.status, 0);
    assert.equal(afterLoss.probe.admissions.initialized, false);
    assert.deepEqual(afterLoss.probe.vaults, [], "a lost record must not re-approve anything (not even the primary)");
    await assert.rejects(fs.stat(world.admissionsFile), "the lost state must not be recreated automatically");

    // ④ re-initialization is possible after the loss, but only through an explicit confirmation.
    const reinit = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true", PROBE_INIT: "true", PROBE_CONFIRM: "[]" });
    assert.deepEqual(reinit.probe.approved, ["vault"], "an explicit empty confirmation approves only the configured primary");
    assert.deepEqual(reinit.probe.vaults, ["vault"]);
  });
});

test("ITEM 1 (W2FIX2): a managed instance keeps refusing after the switch is off AND the record is deleted", async () => {
  await withWorld({}, async (world) => {
    const initial = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true", PROBE_INIT: "true", PROBE_CONFIRM: '["alpha"]' });
    assert.deepEqual(initial.probe.vaults, ["alpha", "vault"]);
    const sentinel = path.join(world.data, "vault-admission-enrollment.json");
    const sentinelBytes = await fs.readFile(sentinel, "utf8");
    assert.match(sentinelBytes, /"managed"\s*:\s*true/, "the enrollment sentinel records the managed mode");
    assert.match(sentinelBytes, /"alpha"/, "the sentinel keeps the trusted identity binding");

    // The seat's exact sequence: initialize → leave one Vault pending → REVOKE another → switch off.
    const revoked = runProbe(world, { PROBE_REVOKE: "alpha" });
    assert.equal(revoked.probe.revoked, "alpha");
    assert.deepEqual(revoked.probe.vaults, ["vault"], "the revoke is immediately effective");

    // State loss: delete ONLY the record. The switch is off by default in `runProbe({})`.
    await fs.rm(world.admissionsFile, { force: true });
    const lost = runProbe(world, {});
    assert.equal(lost.status, 0);
    assert.equal(lost.probe.admissions.enabled, true, "the independent sentinel keeps the instance managed with the switch off");
    assert.equal(lost.probe.admissions.initialized, false, "the record is gone: nothing is initialized");
    assert.deepEqual(lost.probe.vaults, [], "after record loss NOTHING may be served, not even the primary/beta");
    assert.equal(lost.probe.status.vaults.alpha.reason, "admissions-not-initialized");
    assert.equal(lost.probe.status.vaults.beta.reason, "admissions-not-initialized");
    assert.equal(lost.probe.status.vaults.vault.reason, "admissions-not-initialized");
    await fs.stat(sentinel); // the sentinel itself is never removed by the record delete
    await assert.rejects(fs.stat(world.admissionsFile), "a lost record must not be recreated without an explicit initialization");

    // A same-identity recovery IS possible — but only through an explicit administrator confirmation.
    const recovered = runProbe(world, { PROBE_INIT: "true", PROBE_CONFIRM: '["alpha"]' });
    assert.equal(recovered.status, 0);
    assert.deepEqual(recovered.probe.approved.sort(), ["alpha", "vault"]);
    assert.deepEqual(recovered.probe.vaults, ["alpha", "vault"]);
  });
});

test("ITEM 1 (W2FIX2): after record loss a REPLACED directory cannot be re-initialized (binding survives)", async () => {
  await withWorld({}, async (world) => {
    const initial = runProbe(world, { VAULT_DISCOVERY_ENABLED: "true", PROBE_INIT: "true", PROBE_CONFIRM: '["alpha"]' });
    assert.deepEqual(initial.probe.vaults, ["alpha", "vault"]);
    await fs.rm(world.admissionsFile, { force: true });
    const oldIdentity = await resolveVaultIdentity({ root: path.join(world.root, "alpha") });
    // Replace the directory: same id, NEW identity.
    await fs.rm(path.join(world.root, "alpha"), { recursive: true, force: true });
    await fs.mkdir(path.join(world.root, "alpha"), { recursive: true });

    const recovery = runProbe(world, { PROBE_INIT: "true", PROBE_CONFIRM: '["alpha"]' }, { fileId: (BigInt(oldIdentity.fileId) + 1n).toString() });
    assert.equal(recovery.status, 0, "the probe reports rather than crashes");
    assert.equal(recovery.probe.error.code, "VAULT_ADMISSION_IDENTITY_CONFLICT", "re-confirming the directory is not recovering the old binding");
    assert.equal(recovery.probe.vaults, undefined, "no inventory may be published by a refused recovery");
    await assert.rejects(fs.stat(world.admissionsFile), "a refused recovery writes nothing at all");
  });
});

test("the REAL server refuses to start on a corrupt record and boots on a missing one", async (t) => {
  await withWorld({}, async (world) => {
    const corrupt = '{ "version": 1, "revision": ';
    await fs.writeFile(world.admissionsFile, corrupt, "utf8");
    const refused = spawnSync(process.execPath, ["server.js"], {
      cwd: APP_ROOT,
      env: probeEnv(world, { VAULT_DISCOVERY_ENABLED: "true", PORT: "0" }),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.notEqual(refused.status, 0, "a corrupt admission record must refuse startup");
    const output = `${refused.stdout}${refused.stderr}`;
    assert.match(output, /VAULT_ADMISSIONS_CORRUPT/, "the refusal must be the admission-corruption failure, not a later one");
    assert.doesNotMatch(output, /listening on/, "the listener must never open");
  });

  await withWorld({}, async (world) => {
    await fs.rm(world.admissionsFile, { force: true });
    const child = spawn(process.execPath, ["server.js"], {
      cwd: APP_ROOT,
      env: probeEnv(world, { VAULT_DISCOVERY_ENABLED: "true", PORT: "0" }),
    });
    let output = "";
    const listening = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      const onData = (chunk) => {
        output += String(chunk);
        if (output.includes("listening on")) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    child.kill("SIGKILL");
    t.diagnostic(`server stdout/stderr (truncated): ${output.slice(0, 200)}`);
    assert.equal(listening, true, `a missing record must still boot (no accidental fail-closed on absence): ${output.slice(0, 400)}`);
  });
});
