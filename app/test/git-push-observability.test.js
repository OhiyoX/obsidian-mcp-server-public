import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-git-push-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "true";
process.env.GIT_COMMIT_DEBOUNCE_SECONDS = "300";
process.env.GIT_COMMIT_MAX_DELAY_SECONDS = "1";
process.env.GIT_AUTO_PUSH = "true";
process.env.GIT_REMOTE = "origin";

const { commitGit, flushAutoCommit, getGitStatus, gitConfiguration, trackGitMutation } = await import("../src/git.js");
const { withRequestContext } = await import("../src/request-context.js");
const { classifyPushFailure, resetPushObservability, scrubCredentials } = await import("../src/git-push-observability.js");
after(() => fs.rm(root, { recursive: true, force: true }));

async function git(...args) {
  return execFileAsync("git", ["-C", vault, ...args], { encoding: "utf-8" });
}

async function gitIn(dir, ...args) {
  return execFileAsync("git", ["-C", dir, ...args], { encoding: "utf-8" });
}

async function resetVault() {
  await flushAutoCommit();
  await fs.rm(path.join(vault, ".git"), { recursive: true, force: true });
  for (const entry of await fs.readdir(vault)) await fs.rm(path.join(vault, entry), { recursive: true, force: true });
  await git("init", "-q", "-b", "master");
  await fs.writeFile(path.join(vault, "seed.md"), "seed\n");
  await git("add", "seed.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "seed");
  resetPushObservability();
}

async function bareRemote(name) {
  const dir = path.join(root, `${name}.git`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync("git", ["-C", dir, "init", "-q", "--bare", "-b", "master"]);
  return dir;
}

async function useRemote(url) {
  await git("remote", "remove", "origin").catch(() => {});
  await git("remote", "add", "origin", url);
  // Production configures the upstream (branch.<name>.remote/merge); a bare `git push <remote>`
  // needs it, otherwise git refuses with "has no upstream branch".
  await git("config", "branch.master.remote", "origin");
  await git("config", "branch.master.merge", "refs/heads/master");
}

function withAuthor(fn) {
  return withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, fn);
}

async function captureWarnings(fn) {
  const messages = [];
  const original = console.warn;
  console.warn = (...args) => { messages.push(args.map(String).join(" ")); };
  try {
    return { value: await fn(), messages };
  } finally {
    console.warn = original;
  }
}

test("Push failure summaries never echo credentials", () => {
  const summary = scrubCredentials("fatal: unable to access 'https://ci-user:test-token@git.example.com/example/obsidian-vault.git/': 403");
  assert.ok(!summary.includes("test-token"));
  assert.ok(summary.includes("https://***@git.example.com"));
  assert.ok(!scrubCredentials("Authorization: Basic YWJjOmRlZg==").includes("YWJjOmRlZg=="));
  assert.ok(!scrubCredentials("remote: token=ghp_abcdefghijklmnopqrstuvwxyz012345").includes("ghp_"));
});

test("Push failures are classified into unreachable / auth / non-fast-forward", () => {
  assert.equal(classifyPushFailure({ exitCode: 128, stderr: "fatal: unable to access 'https://git.example/': Could not resolve host: git.example" }), "unreachable");
  assert.equal(classifyPushFailure({ exitCode: 128, stderr: "fatal: could not read Username for 'https://git.example': terminal prompts disabled" }), "auth");
  assert.equal(classifyPushFailure({ exitCode: 128, stderr: "fatal: Authentication failed for 'https://git.example/'" }), "auth");
  assert.equal(classifyPushFailure({ exitCode: 1, stderr: " ! [rejected]        master -> master (fetch first)" }), "non-fast-forward");
  assert.equal(classifyPushFailure({ exitCode: 1, stderr: " ! [remote rejected] master -> master (pre-receive hook declined)" }), "rejected");
  assert.equal(classifyPushFailure({ exitCode: 128, stderr: "fatal: The current branch master has no upstream branch." }), "no-upstream");
  assert.equal(classifyPushFailure({ exitCode: 128, stderr: "fatal: something new happened" }), "unknown");
});

test("A successful push is recorded for git_status", async () => {
  await resetVault();
  await useRemote(await bareRemote("ok"));
  await fs.writeFile(path.join(vault, "note.md"), "one\n");

  const committed = await withAuthor(() => commitGit({ message: "push ok", paths: ["note.md"], push: true }));
  assert.equal(committed.committed, true);
  assert.equal(committed.pushed, true);
  assert.equal(committed.push.pushed, true);

  const { push } = (await getGitStatus()).configuration;
  assert.equal(push.lastOutcome.pushed, true);
  assert.equal(push.lastOutcome.failureClass, null);
  assert.equal(push.lastOutcome.remote, "origin");
  assert.equal(push.consecutiveFailures, 0);
  assert.ok(!Number.isNaN(Date.parse(push.lastOutcome.at)), "the outcome carries a timestamp");
});

test("A rejected push keeps the commit, reports pushed:false and logs without credentials", async () => {
  await resetVault();
  const remote = await bareRemote("diverged");
  await useRemote(remote);
  await fs.writeFile(path.join(vault, "note.md"), "one\n");
  await withAuthor(() => commitGit({ message: "first", paths: ["note.md"], push: true }));

  // Diverge: a second clone pushes a commit the vault does not have.
  const other = path.join(root, "other");
  await fs.rm(other, { recursive: true, force: true });
  await execFileAsync("git", ["clone", "-q", remote, other]);
  await fs.writeFile(path.join(other, "other.md"), "other\n");
  await gitIn(other, "add", "other.md");
  await gitIn(other, "-c", "user.name=Other", "-c", "user.email=other@example.com", "commit", "-q", "-m", "other");
  await gitIn(other, "push", "-q", "origin", "master");

  await fs.writeFile(path.join(vault, "note.md"), "two\n");
  const { value: committed, messages } = await captureWarnings(() => withAuthor(() => commitGit({ message: "second", paths: ["note.md"], push: true })));
  assert.equal(committed.committed, true);
  assert.equal(committed.pushed, false);
  assert.equal(committed.push.failureClass, "non-fast-forward");
  assert.equal((await git("log", "-1", "--format=%s")).stdout.trim(), "second");

  const { push } = (await getGitStatus()).configuration;
  assert.equal(push.lastOutcome.pushed, false);
  assert.equal(push.lastOutcome.failureClass, "non-fast-forward");
  assert.equal(push.consecutiveFailures, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Git push failed \[non-fast-forward\] remote=origin/);
});

test("Missing credentials surface as an auth failure without leaking the remote password", async (t) => {
  await resetVault();
  const server = http.createServer((request, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    response.end("auth required");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await git("remote", "add", "origin", `http://git-user:sup3r-s3cret@127.0.0.1:${port}/vault.git`);
  await git("config", "branch.master.remote", "origin");
  await git("config", "branch.master.merge", "refs/heads/master");
  await fs.writeFile(path.join(vault, "note.md"), "auth\n");

  const { value: committed, messages } = await captureWarnings(() => withAuthor(() => commitGit({ message: "auth", paths: ["note.md"], push: true })));
  assert.equal(committed.committed, true);
  assert.equal(committed.pushed, false);
  assert.equal(committed.push.failureClass, "auth");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[auth\]/);
  assert.ok(!messages[0].includes("sup3r-s3cret"), `log leaked credentials: ${messages[0]}`);
  assert.ok(committed.push.summary.includes("127.0.0.1"), "the summary keeps the remote target for triage");
});

test("An unreachable remote is reported instead of being swallowed", async () => {
  await resetVault();
  await useRemote(path.join(root, "missing", "absent.git"));
  await fs.writeFile(path.join(vault, "note.md"), "gone\n");

  const { value: committed, messages } = await captureWarnings(() => withAuthor(() => commitGit({ message: "gone", paths: ["note.md"], push: true })));
  assert.equal(committed.committed, true);
  assert.equal(committed.pushed, false);
  assert.equal(committed.push.failureClass, "unreachable");
  assert.match(messages[0], /\[unreachable\]/);
});

test("An auto-push failure does not re-queue the committed paths", async () => {
  await resetVault();
  await useRemote(path.join(root, "missing-auto", "absent.git"));
  await fs.writeFile(path.join(vault, "auto.md"), "auto\n");

  const { value: flushed, messages } = await captureWarnings(() => withAuthor(async () => {
    trackGitMutation("auto.md");
    return flushAutoCommit();
  }));
  assert.equal(flushed.committed, true);
  assert.equal(messages.length, 1);

  const status = await getGitStatus();
  assert.deepEqual(status.pendingAutoCommitPaths, []);
  assert.equal(status.configuration.push.lastOutcome.pushed, false);
  assert.ok(!status.changes.some((change) => change.path === "auto.md"));
});
