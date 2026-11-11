// #736: a committed journal is finished on the next start, but recovery runs outside a request and
// `trackGitMutation` used to call `requireRequestAuthor()` — with Git auto-commit on, that threw
// `MCP writes require _meta["obsidian/author"]`, `recoverPendingBatches()` failed, and the process
// never listened. The author is now recorded in the journal manifest, so recovery attributes the
// Git mutation from the journal instead of from a request that no longer exists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CHILD_PROCESS_TIMEOUT_MS = 30_000;

function spawnNodeSync(args, options = {}) {
  const child = spawnSync(process.execPath, args, {
    ...options,
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assert.notEqual(child.error?.code, "ETIMEDOUT", child.error?.message || "child process must not time out");
  assert.equal(child.signal, null, `unexpected child signal: ${child.signal}`);
  return child;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-batch-journal-git-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "true";
process.env.VERSION_HISTORY_ENABLED = "true";

const git = (...args) => {
  const child = spawnSync("git", args, { cwd: vault, encoding: "utf-8" });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
};

git("init", "-q", "-b", "main");
git("config", "user.name", "vault-test");
git("config", "user.email", "vault-test@example.com");
await fs.writeFile(path.join(vault, "seed.md"), "seed\n");
git("add", "-A");
git("commit", "-q", "-m", "seed");

const { trackGitMutation } = await import("../src/git.js");

test("#736: recovery finishes a committed journal with Git auto-commit on and no request context", async () => {
  const target = path.join(vault, "recovered.md");
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'recovery-author', model: 'journal-test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'recovered.md'),
        data: 'recovered body', mustNotExist: true }],
        { afterCommit: () => process.exit(83) }));
  `;
  const crashed = spawnNodeSync(["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env }, encoding: "utf-8",
  });
  assert.equal(crashed.status, 83, crashed.stderr);
  assert.equal(await fs.readFile(target, "utf-8"), "recovered body");

  const journalRoot = path.join(data, "mutation-journal");
  const [id] = await fs.readdir(journalRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, id, "manifest.json"), "utf-8"));
  assert.equal(manifest.state, "committed");
  assert.deepEqual(manifest.author, { agent: "recovery-author", model: "journal-test" },
    "the manifest records the author of the write, so recovery does not need a request");

  // The regression: this process has no request context, so the old code threw and never started.
  const recovered = spawnNodeSync(["--input-type=module", "-e",
    "import { recoverPendingBatches } from './src/batch-journal.js'; await recoverPendingBatches();"], {
    cwd: path.resolve("."), env: { ...process.env }, encoding: "utf-8",
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.doesNotMatch(recovered.stderr, /require _meta/, "recovery must not ask for a request author");
  assert.deepEqual(await fs.readdir(journalRoot), [], "the finished journal is cleaned up");
});

test("#736: the journal author reaches Git without a request context, and the guard still holds", () => {
  const author = { agent: "recovery-author", model: "journal-test" };
  // Recovery's shape: an explicit author, no request context.
  assert.doesNotThrow(() => trackGitMutation(["recovered.md"], author));
  // Request paths keep the guard: no context and no explicit author still refuses to invent one.
  assert.throws(() => trackGitMutation(["recovered.md"]), /require _meta/);
});
