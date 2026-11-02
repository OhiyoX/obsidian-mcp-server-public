// Wave D / D-git — resolver + registry guards for the per-Vault GitRuntime.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §16/§16.1 per-Vault GitRuntime and command root · §16.4 `trackGitMutation` goes to the current
//   VaultRuntime's Git · §21 MV-I07 primary compatibility · §42 SEC-MV06 (no fallback on a broken
//   secondary) · SEC-MV07 · §43-6 (no Git state in a module global) · §47 RETURN list.
//
// This file freezes the seam D-git added — `src/git-runtimes.js` — with no filesystem, no git
// binary and no MCP transport: a fake B1 VaultRuntime is enough to prove that the primary instance
// is reused by identity, a secondary gets its own instance rooted at its own path, a selection
// without a runtime is refused instead of served by the primary, and a hostile factory cannot make
// one Vault answer with another Vault's repository.
//
// Its own process on purpose: `config.js` reads the `GIT_*` baseline at import, and `src/git.js`
// builds the primary GitRuntime and injects the resolver wiring once at import.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dgit-resolver-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.GIT_ENABLED = "false";
process.env.GIT_AUTO_COMMIT = "false";
for (const root of [PRIMARY_ROOT, SECONDARY_ROOT, DATA_ROOT]) await fs.mkdir(root, { recursive: true });
after(() => fs.rm(ROOT, { recursive: true, force: true }));

const { gitConfigStoreInstance, primaryGitRuntime } = await import("../src/git.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { primaryRuntime } = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");
const {
  GIT_RUNTIME_INVALID,
  GIT_RUNTIME_REFUSED,
  configureGitRuntimes,
  gitRuntimeFor,
  refusalForError,
  releaseGitRuntime,
  resolveGitRuntime,
} = await import("../src/git-runtimes.js");

// The durable A5 load is asynchronous; settle it once so the provider matrix is deterministic.
await gitConfigStoreInstance().ready;

const SECONDARY = Object.freeze({ id: "secondary", root: SECONDARY_ROOT, primary: false });
const OTHER = Object.freeze({ id: "other", root: path.join(VAULTS_ROOT, "other"), primary: false });

test("§21 MV-I07: no Vault selection (and the primary selection) reuse the one primary GitRuntime", () => {
  assert.equal(resolveGitRuntime(), primaryGitRuntime(), "no request context keeps the legacy primary instance");
  assert.equal(gitRuntimeFor(primaryRuntime), primaryGitRuntime(), "the primary B1 runtime must reuse the src/git.js instance");
  const selected = withRequestContext({ vaultId: DEFAULT_VAULT_ID, vaultRuntime: primaryRuntime }, () => resolveGitRuntime());
  assert.equal(selected, primaryGitRuntime(), "an explicit primary selection is still that same instance");
  const byIdOnly = withRequestContext({ vaultId: DEFAULT_VAULT_ID }, () => resolveGitRuntime());
  assert.equal(byIdOnly, primaryGitRuntime(), "a primary vaultId without a runtime is not a refusal");
});

test("§16.1: a secondary gets its own GitRuntime, cached by the B1 runtime instance", () => {
  const secondary = gitRuntimeFor(SECONDARY);
  assert.notEqual(secondary, primaryGitRuntime(), "SEC-MV06: a secondary must never be the primary GitRuntime");
  assert.equal(secondary.vaultId, SECONDARY.id);
  assert.equal(secondary.root, SECONDARY_ROOT, "the command root is bound to that Vault's own root");
  assert.equal(gitRuntimeFor(SECONDARY), secondary, "the cache is keyed by the runtime instance (one instance per Vault)");
  assert.equal(releaseGitRuntime(SECONDARY), true, "release clears the timers and forgets the instance");
  const rebuilt = gitRuntimeFor(SECONDARY);
  assert.notEqual(rebuilt, secondary, "a released runtime is never served again");
  assert.equal(releaseGitRuntime(SECONDARY), true);
  assert.equal(releaseGitRuntime({ id: "never-materialized", root: SECONDARY_ROOT, primary: false }), false);
  assert.equal(releaseGitRuntime(primaryRuntime), false, "the primary instance belongs to the process, never released here");
});

test("§47/SEC-MV06: a selected Vault with no materialized GitRuntime is refused, never the primary", () => {
  let thrown = null;
  try {
    withRequestContext({ vaultId: "ghost" }, () => resolveGitRuntime());
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a selected vaultId without a runtime must refuse");
  assert.equal(thrown.code, GIT_RUNTIME_REFUSED);
  assert.equal(thrown.vaultId, "ghost");
  const payload = refusalForError(thrown);
  assert.deepEqual(payload.structuredContent, { code: GIT_RUNTIME_REFUSED, vaultId: "ghost" });
  assert.equal(payload.isError, true);
  // The refusal is re-usable by a tool handler, and unrelated errors are left to `err()`.
  assert.equal(refusalForError(new Error("nothing to do with git")), null);
});

test("§3.4/§16.2: an A6 runtime failure becomes a machine-readable MCP refusal", () => {
  const disabled = Object.assign(new Error("Git integration is disabled for this vault"), { code: "git_runtime_disabled" });
  const payload = refusalForError(disabled, SECONDARY.id);
  assert.equal(payload.isError, true);
  assert.deepEqual(payload.structuredContent, {
    code: "git_runtime_disabled",
    vaultId: SECONDARY.id,
    message: "Git integration is disabled for this vault",
  });
  const missingRepo = Object.assign(new Error("The mounted vault is not a Git working tree"), { code: "git_runtime_repository_missing" });
  assert.equal(refusalForError(missingRepo, SECONDARY.id).structuredContent.code, "git_runtime_repository_missing");
});

test("§47: a malformed VaultRuntime is refused instead of being guessed into a repository", () => {
  const cases = [
    null,
    "secondary",
    { id: "", root: SECONDARY_ROOT, primary: false },
    { id: "secondary", root: "relative/path", primary: false },
    { id: SECONDARY.id, root: SECONDARY_ROOT, primary: true }, // claims primacy with a foreign id
  ];
  for (const value of cases) {
    assert.throws(() => gitRuntimeFor(value), (error) => error.code === GIT_RUNTIME_INVALID, `expected a refusal for ${JSON.stringify(value)}`);
  }
});

test("SEC-MV06: a factory that hands back another Vault's runtime is refused, not published", () => {
  // Deliberately last: this replaces the process wiring with a hostile factory, which is exactly the
  // composition error the guard exists for.
  configureGitRuntimes({
    primaryGitRuntime: () => primaryGitRuntime(),
    createSecondaryRuntime: () => primaryGitRuntime(),
  });
  assert.throws(
    () => gitRuntimeFor(OTHER),
    (error) => error.code === GIT_RUNTIME_INVALID && /never substitute the primary repository/.test(error.message),
  );
  assert.equal(gitRuntimeFor(primaryRuntime), primaryGitRuntime(), "the primary path is unaffected by a hostile secondary factory");
});
