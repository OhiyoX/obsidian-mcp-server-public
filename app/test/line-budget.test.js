import assert from "node:assert/strict";
import test from "node:test";

import {
  LINE_BUDGET,
  applyLineBudget,
  auditLineBudget,
  countLines,
  normalizeRepoPath,
  validateBaseline,
} from "../scripts/line-budget.mjs";

function entry(maxLines, overrides = {}) {
  return { maxLines, reason: "test matrix", plan: "keep (documented exception)", ...overrides };
}

test("countLines ignores a single trailing newline (wc -l semantics)", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\n"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("one\r\ntwo\r\n"), 2);
  assert.equal(countLines("one\r\ntwo"), 2);
});

test("normalizeRepoPath strips a leading app/ and normalizes separators", () => {
  assert.equal(normalizeRepoPath("app/scripts/x.mjs"), "scripts/x.mjs");
  assert.equal(normalizeRepoPath("scripts/x.mjs"), "scripts/x.mjs");
  assert.equal(normalizeRepoPath(".\\app\\test\\y.test.js"), "test/y.test.js");
  assert.equal(normalizeRepoPath("server.js"), "server.js");
});

test("the ceiling is 800 and it is not a hard limit (owner ruling 2026-10-11)", () => {
  assert.equal(LINE_BUDGET, 800);
});

test("unregistered file above the ceiling fails with a register/split hint", () => {
  const failures = applyLineBudget({ inspected: [{ file: "scripts/big.mjs", lines: LINE_BUDGET + 1 }], baseline: { entries: {} } });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /scripts\/big\.mjs: 801 lines exceeds 800/);
  assert.match(failures[0], /register a reason\+plan exception/);
  assert.match(failures[0], /extract a cohesive module/);
});

test("unregistered file exactly at the ceiling passes", () => {
  const failures = applyLineBudget({ inspected: [{ file: "test/small.test.js", lines: LINE_BUDGET }], baseline: { entries: {} } });
  assert.deepEqual(failures, []);
});

test("registered file within its maxLines passes", () => {
  const baseline = { entries: { "app/scripts/big.mjs": entry(900) } };
  const failures = applyLineBudget({ inspected: [{ file: "scripts/big.mjs", lines: 850 }], baseline });
  assert.deepEqual(failures, []);
});

test("registered file above its maxLines fails (the exception must be re-justified)", () => {
  const baseline = { entries: { "app/scripts/big.mjs": entry(900) } };
  const failures = applyLineBudget({ inspected: [{ file: "scripts/big.mjs", lines: 901 }], baseline });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /scripts\/big\.mjs: 901 lines exceeds registered maxLines 900/);
  assert.match(failures[0], /raise maxLines/);
});

test("a registered exception may grow once the same change refreshes maxLines and reason (no shrink ratchet)", () => {
  const stale = applyLineBudget({ inspected: [{ file: "scripts/big.mjs", lines: 950 }], baseline: { entries: { "app/scripts/big.mjs": entry(900) } } });
  assert.equal(stale.length, 1);
  const refreshed = applyLineBudget({
    inspected: [{ file: "scripts/big.mjs", lines: 950 }],
    baseline: { entries: { "app/scripts/big.mjs": entry(950, { reason: "用例密集矩阵继续增长（见 PR 说明）", plan: "按职责继续拆分" }) } },
  });
  assert.deepEqual(refreshed, []);
});

test("registered file back under the ceiling asks for baseline removal", () => {
  const baseline = { entries: { "app/test/small.test.js": entry(820) } };
  const { failures, notices } = auditLineBudget({ inspected: [{ file: "test/small.test.js", lines: LINE_BUDGET }], baseline });
  assert.deepEqual(failures, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /test\/small\.test\.js: 800 lines within 800/);
  assert.match(notices[0], /remove/i);
});

test("baseline entries require maxLines above the ceiling, reason and plan", () => {
  const baseline = {
    entries: {
      "app/scripts/empty-reason.mjs": { maxLines: 900, reason: "   ", plan: "keep" },
      "app/scripts/empty-plan.mjs": { maxLines: 900, reason: "matrix", plan: "" },
      "app/scripts/bad-max.mjs": { maxLines: "900", reason: "matrix", plan: "keep" },
      "app/scripts/tiny-max.mjs": { maxLines: LINE_BUDGET, reason: "matrix", plan: "keep" },
      "app/scripts/ok.mjs": entry(900),
    },
  };
  const failures = validateBaseline(baseline);
  assert.equal(failures.length, 4);
  assert.ok(failures.some((item) => /empty-reason\.mjs: missing non-empty reason/.test(item)));
  assert.ok(failures.some((item) => /empty-plan\.mjs: missing non-empty plan/.test(item)));
  assert.ok(failures.some((item) => /bad-max\.mjs: maxLines must be an integer greater than 800/.test(item)));
  assert.ok(failures.some((item) => /tiny-max\.mjs: maxLines must be an integer greater than 800/.test(item)));
});

test("invalid baseline shapes fail instead of silently passing", () => {
  assert.equal(validateBaseline(null).length, 1);
  assert.equal(validateBaseline({}).length, 1);
  assert.equal(validateBaseline({ entries: [] }).length, 1);
  assert.equal(validateBaseline({ entries: { "app/scripts/ok.mjs": entry(900) } }).length, 0);
});

test("auditLineBudget reports baseline validation and budget failures together", () => {
  const baseline = { entries: { "app/scripts/old.mjs": { maxLines: 900, reason: "", plan: "keep" } } };
  const { failures, notices } = auditLineBudget({
    inspected: [
      { file: "scripts/old.mjs", lines: 950 },
      { file: "scripts/new.mjs", lines: 950 },
    ],
    baseline,
  });
  assert.equal(notices.length, 0);
  assert.equal(failures.length, 3);
  assert.ok(failures.some((item) => /missing non-empty reason/.test(item)));
  assert.ok(failures.some((item) => /scripts\/old\.mjs: 950 lines exceeds registered maxLines 900/.test(item)));
  assert.ok(failures.some((item) => /scripts\/new\.mjs: 950 lines exceeds 800/.test(item)));
});
