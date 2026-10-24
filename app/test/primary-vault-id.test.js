// #659 — the primary Vault id has ONE derivation per plane, and the two planes must be comparable.
//
// History: three modules each spelled the "primary Vault id" out for themselves —
//   * `oauth/primitives.js`  DEFAULT_VAULT_ID  = VAULTS_ROOT ? (WEB_DEFAULT_VAULT || "vault") : "default"   (auth plane)
//   * `vault.js`             PRIMARY_VAULT_ID = the same expression, verbatim                            (vault runtime)
//   * `app/vault-registry.js` DEFAULT_ID       = WEB_DEFAULT_VAULT || basename(VAULT) || "vault"           (registry plane)
// The first two were copies (#658 turned the third into a metadata bug); this file's job is to keep the
// remaining duplication from happening again, and to pin the ONE configuration where the two planes
// legitimately disagree instead of leaving that fact to be rediscovered.
//
// The three configurations, run in subprocesses because `config.js` resolves its paths at module
// evaluation (so one process cannot see two configurations):
//   1. single-Vault (no WEB_VAULTS_ROOT): both planes say `default`; the registry is not configured at all.
//   2. multi-Vault WITH WEB_DEFAULT_VAULT: the supported deployment (`docker-compose.yaml`:
//      `${WEB_DEFAULT_VAULT:-vault}`) — the planes MUST agree.
//   3. multi-Vault WITHOUT WEB_DEFAULT_VAULT and a primary directory not named `vault`: the two planes
//      disagree by construction (auth falls back to the literal "vault", the registry to the directory
//      name). That is pinned here as a KNOWN divergence, not silently tolerated: the fix is to set
//      WEB_DEFAULT_VAULT explicitly, not to pick one fallback for both (failing closed on a
//      non-existent default is the safer half).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

/** Resolve the three ids in a fresh process with the given environment. */
function probe(env) {
  const script = `
    const { DEFAULT_VAULT_ID } = await import("./src/oauth/primitives.js");
    // vault.js does not export the id; it puts it on the primary runtime's descriptor, which is what
    // every consumer (tools, git, web) actually reads — so probe there, not from a copy.
    const { primaryRuntime } = await import("./src/vault.js");
    const { configuredPrimaryVaultId } = await import("./src/config.js");
    const { defaultWebVaultId } = await import("./src/app/vault-registry.js");
    console.log(JSON.stringify({
      auth: DEFAULT_VAULT_ID,
      runtime: primaryRuntime.descriptor.id,
      registryConfig: configuredPrimaryVaultId(),
      registryDefault: defaultWebVaultId(),
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: APP_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n").pop());
}

const roots = [];
function tempRoot(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `primary-vault-${name}-`));
  roots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("single-Vault deployment: every plane says `default`", () => {
  const vault = tempRoot("single");
  const ids = probe({ VAULT_PATH: vault, WEB_VAULTS_ROOT: "", WEB_DEFAULT_VAULT: "", DATA_PATH: tempRoot("single-data") });
  assert.equal(ids.auth, "default");
  assert.equal(ids.runtime, "default", "the vault runtime reused the auth plane's id, so it cannot drift");
  assert.equal(ids.registryDefault, "default");
});

test("multi-Vault with WEB_DEFAULT_VAULT set (the supported deployment): all planes agree", () => {
  const root = tempRoot("configured");
  const vault = path.join(root, "alpha");
  mkdirSync(vault, { recursive: true });
  const ids = probe({ VAULT_PATH: vault, WEB_VAULTS_ROOT: root, WEB_DEFAULT_VAULT: "alpha", DATA_PATH: tempRoot("configured-data") });
  assert.deepEqual(
    { auth: ids.auth, runtime: ids.runtime, registry: ids.registryDefault, registryConfig: ids.registryConfig },
    { auth: "alpha", runtime: "alpha", registry: "alpha", registryConfig: "alpha" },
    "with WEB_DEFAULT_VAULT set the three ids must be identical",
  );
});

test("multi-Vault WITHOUT WEB_DEFAULT_VAULT: the known divergence is pinned, not guessed", () => {
  const root = tempRoot("divergent");
  const vault = path.join(root, "alpha");
  mkdirSync(vault, { recursive: true });
  const ids = probe({ VAULT_PATH: vault, WEB_VAULTS_ROOT: root, WEB_DEFAULT_VAULT: "", DATA_PATH: tempRoot("divergent-data") });
  // Auth falls back to the literal `vault` (fail-closed: that id usually does not exist), the registry
  // falls back to the primary directory's name. Both are recorded so a change to either is visible.
  assert.equal(ids.auth, "vault");
  assert.equal(ids.runtime, "vault");
  assert.equal(ids.registryConfig, "alpha");
  assert.equal(ids.registryDefault, "alpha");
  assert.notEqual(ids.auth, ids.registryDefault, "if these ever coincide here, the divergence moved and this file must be updated");
});
