// Issue #673 (item 4) — the main-line audit must classify, not guess, and it must not lie in either
// direction: a squash merge keeps the pull request's own commit SHA, the forge's own merge style
// names the PR in a different place than the API merge, and a real direct push must stay `direct`.

import assert from "node:assert/strict";
import test from "node:test";

import { classifyFirstParent, parseFirstParent, report } from "../../scripts/main-commit-audit.mjs";

const line = (sha, parents, subject) => `${sha}\u0000${parents.join(" ")}\u0000${subject}`;

test("a merge commit the forge knows is traced to its pull request", () => {
  const commits = parseFirstParent(line("aaa", ["aaa1", "aaa2"], "Merge #781: 发布访问统计"));
  const merged = new Map([["aaa", { number: 781 }]]);
  assert.deepEqual(classifyFirstParent(commits, merged).map((row) => [row.classification, row.pull.number]), [["pr", 781]]);
});

test("a squash merge is traced by its own SHA, so it is never reported as a direct push", () => {
  // A squash merge lands one commit on the main line whose SHA is the PR's merge_commit_sha.
  const commits = parseFirstParent(line("bbb", ["bbb1"], "feat(x): one commit, no merge parents"));
  const merged = new Map([["bbb", { number: 790 }]]);
  const [row] = classifyFirstParent(commits, merged);
  assert.equal(row.classification, "pr");
  assert.equal(row.pull.number, 790);
});

test("the forge's own merge message names the pull request in parentheses", () => {
  const commits = parseFirstParent(line("ccc", ["ccc1", "ccc2"], "Merge pull request 'fix/authz-editor-ui' (#767): 定时授权编辑页支持可视化周时段"));
  const [row] = classifyFirstParent(commits, new Map());
  assert.equal(row.classification, "pr-merge-message");
  assert.equal(row.pull.number, 767);
});

test("the API merge message without the word 'pull request' is recognised too", () => {
  const commits = parseFirstParent(line("ddd", ["ddd1", "ddd2"], "Merge #812: something"));
  assert.equal(classifyFirstParent(commits, new Map())[0].classification, "pr-merge-message");
});

test("a single-parent commit with no pull request is a direct push", () => {
  const commits = parseFirstParent(line("eee", ["eee1"], "chore: push straight to main"));
  const [row] = classifyFirstParent(commits, new Map());
  assert.equal(row.classification, "direct");
  assert.equal(row.pull, null);
});

test("a one-parent commit that says 'Merge …' is not a merge, so it stays direct", () => {
  // The message alone must never clear a commit: without a second parent there was no merge.
  const commits = parseFirstParent(line("fff", ["fff1"], "Merge pull request 'x' (#900): squashed by hand"));
  assert.equal(classifyFirstParent(commits, new Map())[0].classification, "direct");
});

test("the report counts each class and marks the untraced ones", () => {
  const rows = classifyFirstParent(parseFirstParent([
    line("a1", ["p1", "p2"], "Merge #1: one"),
    line("a2", ["p1"], "direct thing"),
  ].join("\n")), new Map([["a1", { number: 1 }]]));
  const text = report(rows);
  assert.match(text, /NOT TRACED/);
  assert.match(text, /commits 2 \| pr 1 \| pr-merge-message 0 \| direct 1/);
});
