// Wave F / F1 — real dual-Vault matrix for the git face's remote operations (`git_pull`, `git_push`).
//
// Why this file exists (§31 "complete full matrix"): the D-git lane matrix drives `git_status`,
// `git_diff`, `git_log`, `git_commit` (and the routed write path) but never the two remote
// operations, so their per-Vault command root was unproven. Here both tools run against a real bare
// remote with the *secondary* Vault as the only enabled repository; the primary's repository must
// never be pushed, pulled into, or even touched (§16.1 command root, §21 MV-I02, §42 SEC-MV06, §47).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";

import { PRIMARY_ID, SECONDARY_ID, configureDualVaultEnv, createDualVaultHarness } from "./helpers/multi-vault-f1-harness.js";

const execFileAsync = promisify(execFile);
const git = (dir, ...args) => execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8" });
const gitOut = async (dir, ...args) => (await git(dir, ...args)).stdout.trim();

const env = await configureDualVaultEnv({ prefix: "obsidian-mv-f1-gap-git-" });
const PRIMARY_ROOT = env.primaryRoot;
const SECONDARY_ROOT = env.secondaries[SECONDARY_ID];
const REMOTE = path.join(env.root, "remote-secondary.git");
const SCRATCH = path.join(env.root, "scratch-clone");

async function seedRepo(root, branch, file, subject) {
  await git(root, "init", "-q", "-b", branch);
  await git(root, "config", "user.name", "F1 Seed");
  await git(root, "config", "user.email", "f1-seed@example.com");
  await fs.writeFile(path.join(root, file), `${subject}\n`);
  await git(root, "add", file);
  await git(root, "commit", "-q", "-m", subject);
}

await seedRepo(PRIMARY_ROOT, "primary-branch", "primary-seed.md", "primary seed commit");
await seedRepo(SECONDARY_ROOT, "main", "secondary-seed.md", "secondary seed commit");
await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", REMOTE], { encoding: "utf8" });
await git(SECONDARY_ROOT, "remote", "add", "origin", REMOTE);

// The A5 store: only the secondary is git-enabled. The primary therefore keeps its deployment
// baseline (`GIT_ENABLED=false` from the harness env) and its own repository is never operated on.
await fs.writeFile(path.join(env.dataRoot, "git-vaults.json"), `${JSON.stringify({
  schema: 1,
  revision: 1,
  vaults: {
    [SECONDARY_ID]: {
      enabled: true,
      autoCommit: false,
      autoPush: false,
      autoCommitSweep: false,
      debounceSeconds: 300,
      maxDelaySeconds: 900,
      sweepIntervalSeconds: 900,
      remote: "origin",
      branch: "main",
      updatedAt: "2026-10-07T00:00:00.000Z",
    },
  },
})}\n`);

const harness = await createDualVaultHarness(env);
after(async () => { await harness.teardown(); });

const primaryHead = () => gitOut(PRIMARY_ROOT, "rev-parse", "HEAD");
const primaryRemotes = () => gitOut(PRIMARY_ROOT, "remote").catch(() => "");
const remoteHead = (branch = "main") => gitOut(REMOTE, "rev-parse", branch);

test("§16.1/§29: git_push/git_pull operate on the selected Vault's own repository and remote", async () => {
  const client = await harness.toolClient();
  const primaryBefore = await primaryHead();
  try {
    const secondaryHead = await gitOut(SECONDARY_ROOT, "rev-parse", "HEAD");
    const pushed = await client.call("git_push", { vaultId: SECONDARY_ID });
    assert.notEqual(pushed, null);
    assert.equal(await remoteHead(), secondaryHead, "the secondary's own commit must reach its configured remote");
    assert.equal(await primaryRemotes(), "", "the primary repository must not gain a remote (§16.1 command root)");
    assert.equal(await primaryHead(), primaryBefore, "pushing the secondary must not move the primary");

    // A genuine fast-forward: a scratch clone advances the remote, then the secondary pulls it.
    await git(env.root, "clone", "-q", REMOTE, SCRATCH);
    await git(SCRATCH, "config", "user.name", "F1 Remote");
    await git(SCRATCH, "config", "user.email", "f1-remote@example.com");
    await fs.writeFile(path.join(SCRATCH, "pulled.md"), "# pulled by the remote\n");
    await git(SCRATCH, "add", "pulled.md");
    await git(SCRATCH, "commit", "-q", "-m", "remote commit");
    await git(SCRATCH, "push", "-q", "origin", "main");
    const advanced = await remoteHead();
    assert.notEqual(advanced, secondaryHead);

    const pulled = await client.call("git_pull", { vaultId: SECONDARY_ID });
    assert.notEqual(pulled, null);
    assert.equal(await gitOut(SECONDARY_ROOT, "rev-parse", "HEAD"), advanced, "the secondary must fast-forward to the remote head");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "pulled.md"), "utf8"), /^# pulled by the remote\r?\n$/);
    assert.equal(await fs.readFile(path.join(PRIMARY_ROOT, "pulled.md"), "utf8").then(() => true, () => false), false, "the pull must never land in the primary Vault");
    assert.equal(await primaryHead(), primaryBefore, "the primary repository must stay exactly where it was");
  } finally {
    await client.close();
  }
});

test("§47: the git remote operations refuse a Vault with no enabled runtime and an unknown Vault", async () => {
  const client = await harness.toolClient();
  const primaryBefore = await primaryHead();
  const remoteBefore = await remoteHead();
  try {
    // The primary has a real repository but no enabled Git runtime in this deployment: refused,
    // never silently served by the secondary's runtime and never by a fabricated one.
    const primaryPush = await client.attempt("git_push", { vaultId: PRIMARY_ID });
    assert.equal(primaryPush.isError, true, "a git-disabled primary must refuse git_push");
    const primaryPull = await client.attempt("git_pull", { vaultId: PRIMARY_ID });
    assert.equal(primaryPull.isError, true, "a git-disabled primary must refuse git_pull");
    for (const name of ["git_push", "git_pull"]) {
      const unknown = await client.attempt(name, { vaultId: "ghost" });
      assert.equal(unknown.isError, true, `${name} must refuse an unknown Vault`);
      assert.match(String(unknown.text), /ghost/);
    }
    assert.equal(await primaryHead(), primaryBefore, "a refused call must not touch the primary repository");
    assert.equal(await remoteHead(), remoteBefore, "a refused call must not push anything");
  } finally {
    await client.close();
  }
});
