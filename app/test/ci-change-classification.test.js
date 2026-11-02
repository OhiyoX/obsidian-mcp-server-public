import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Regression coverage for `.github/scripts/classify-change-set.sh`, the classifier that lets a
// documentation-only change set skip the heavy CI gates (app / dependency-audit / browser).
//
// The classifier is fail-closed: only a successful decision that *every* changed path is
// documentation may return `false`. Every case the review asked for is exercised here with a real
// temporary Git repository: plain docs, gate fixtures, mixed code, a large change set, a rename
// from code into docs, a tag push, an unusable/empty base, a directory that is not a repository,
// and an empty diff. The workflow wiring itself is asserted statically at the end.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const classifier = path.join(repoRoot, ".github", "scripts", "classify-change-set.sh");
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

// Windows' PATH may resolve bash to the WSL launcher. That cannot consume a
// native Windows worktree/path; use the Bash shipped with the same native Git.
const bash = (() => {
  if (process.platform !== "win32") return "bash";
  const locations = spawnSync("where.exe", ["git"], { encoding: "utf8", timeout: 5_000 });
  for (const gitPath of (locations.stdout || "").trim().split(/\r?\n/)) {
    for (const relative of ["../bin/bash.exe", "../../bin/bash.exe"]) {
      const candidate = path.resolve(path.dirname(gitPath), relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Windows classifier checks require Git for Windows Bash, not the WSL launcher");
})();

const tempDirs = [];

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-mcp-ci-classify-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [relativePath, content] of Object.entries(files)) {
    writeFile(dir, relativePath, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function writeFile(dir, relativePath, content) {
  const target = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ci-classify",
      GIT_AUTHOR_EMAIL: "ci-classify@example.invalid",
      GIT_COMMITTER_NAME: "ci-classify",
      GIT_COMMITTER_EMAIL: "ci-classify@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(dir, message = "change") {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function classify(dir, { base, head, ref = "refs/heads/feature" }) {
  const args = [classifier.replaceAll("\\", "/")];
  if (ref !== undefined) args.push("--ref", ref);
  args.push(base, head);
  const result = spawnSync(bash, args, { cwd: dir, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `classifier failed: ${result.stderr}`);
  return result.stdout.trim();
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("documentation only, including nested docs and a root Markdown file, skips the heavy gates", () => {
  const dir = makeRepo({ "app/src/product.js": "export const answer = 42;\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFile(dir, "docs/notes/deep/page.md", "# page\n");
  writeFile(dir, "README.md", "# readme\n");
  const head = commit(dir);
  assert.equal(classify(dir, { base, head }), "false");
});

test("a Markdown gate fixture is not documentation", () => {
  const dir = makeRepo({ "app/test/fixtures/render-parity-canonical.md": "# canonical\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFile(dir, "app/test/fixtures/render-parity-canonical.md", "# canonical fixture\n");
  const head = commit(dir);
  assert.equal(classify(dir, { base, head }), "true");
});

test("a nested Markdown file outside docs/ is not documentation", () => {
  const dir = makeRepo({ "app/README.md": "# app\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFile(dir, "app/README.md", "# app notes\n");
  const head = commit(dir);
  assert.equal(classify(dir, { base, head }), "true");
});

test("a mixed change set runs the heavy gates", () => {
  const dir = makeRepo({ "app/src/product.js": "export const answer = 42;\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFile(dir, "docs/notes/page.md", "# page\n");
  writeFile(dir, "app/src/product.js", "export const answer = 43;\n");
  const head = commit(dir);
  assert.equal(classify(dir, { base, head }), "true");
});

test("a code file with thousands of documentation files still runs the heavy gates", () => {
  // The code path sorts before `docs/`, so a `grep -q`-style pipeline would be killed by SIGPIPE
  // after its first match — and with `pipefail` that used to look like "all paths are docs".
  const dir = makeRepo({ "aaa/payload.js": "export const answer = 42;\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFile(dir, "aaa/payload.js", "export const answer = 43;\n");
  for (let index = 0; index < 5000; index += 1) {
    writeFile(dir, `docs/notes/section-${String(index).padStart(4, "0")}.md`, "# note\n");
  }
  const head = commit(dir);
  assert.equal(classify(dir, { base, head }), "true");
});

test("a rename from code into docs/ runs the heavy gates", () => {
  const dir = makeRepo({ "app/src/product.js": "export const answer = 42;\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  git(dir, ["mv", "app/src/product.js", "docs/product.md"]);
  const head = commit(dir);
  // `git diff --name-only` without `--no-renames` would report only `docs/product.md`.
  assert.equal(classify(dir, { base, head }), "true");
});

test("a tag push always runs the heavy gates", () => {
  const dir = makeRepo({ "docs/notes/page.md": "# page\n" });
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFile(dir, "docs/notes/page.md", "# page updated\n");
  const head = commit(dir);
  assert.equal(classify(dir, { base, head, ref: "refs/tags/v2026.10.10.3" }), "true");
});

test("an unusable base commit runs the heavy gates", () => {
  const dir = makeRepo({ "docs/notes/page.md": "# page\n" });
  const head = git(dir, ["rev-parse", "HEAD"]);
  assert.equal(classify(dir, { base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", head }), "true");
  assert.equal(classify(dir, { base: "0".repeat(40), head }), "true");
  assert.equal(classify(dir, { base: "", head }), "true");
  assert.equal(classify(dir, { base: head, head: "" }), "true");
});

test("a non-repository directory runs the heavy gates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-mcp-ci-classify-plain-"));
  tempDirs.push(dir);
  assert.equal(classify(dir, { base: "HEAD", head: "HEAD" }), "true");
});

test("an empty change set is documentation-only", () => {
  const dir = makeRepo({ "docs/notes/page.md": "# page\n" });
  const head = git(dir, ["rev-parse", "HEAD"]);
  assert.equal(classify(dir, { base: head, head }), "false");
});

test("the classifier reads NUL-delimited paths with --no-renames", () => {
  const script = fs.readFileSync(classifier, "utf8");
  assert.match(script, /--no-renames/);
  assert.match(script, /-z/);
  assert.doesNotMatch(script, /\|\s*grep\b/);
});

test("the heavy gates only skip on an explicit false from a successful classification", () => {
  // The checkout may use CRLF on Windows while the committed blob uses LF.
  const workflow = fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
  const failClosed = "!cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.code != 'false')";
  for (const job of ["app", "dependency-audit", "browser"]) {
    const block = new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [a-z-]+:\\n)`).exec(workflow);
    assert.ok(block, `job ${job} is missing from the workflow`);
    assert.ok(
      block[0].includes(`if: \${{ ${failClosed} }}`),
      `job ${job} must keep the fail-closed gate`,
    );
  }
  assert.match(workflow, /classify-change-set\.sh/);
  // The release gate itself must never depend on the classifier.
  assert.match(workflow, /release-gate:[\s\S]*?if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /release-gate:[\s\S]*?needs: \[app, browser, dependency-audit\]/);
});
