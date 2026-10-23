// Line-budget policy shared by `check-architecture.mjs` and its tests.
//
// The gate inspects frontend/, src/, scripts/, test/ and root-level *.js|*.mjs.
//
// Owner ruling 2026-10-11 (`500 -> 800`, **no hard limit**): a file over
// `LINE_BUDGET` may still ship, but only as a **registered exception** in
// `scripts/line-budget-baseline.json` with a non-empty `reason` and `plan` —
// i.e. exceeding the ceiling is allowed *if you give a reason*. New code should
// still extract a cohesive module rather than grow a monolith.
//
// There is no "only shrink" ratchet: a registered file may grow when the same
// change raises its `maxLines` and refreshes the reason (the exception has to be
// re-justified, not silently extended). Once a file is back within the ceiling,
// its entry must be removed.

export const LINE_BUDGET = 800;

export const BASELINE_PATH = "scripts/line-budget-baseline.json";

// Number of lines in `content`, ignoring a single trailing newline so the count
// matches `wc -l` (an 800-line file ending with "\n" is 800 lines, not 801).
export function countLines(content) {
  const text = String(content).replaceAll("\r\n", "\n");
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

// Baseline keys are repository-relative (`app/scripts/...`); inspected paths are
// relative to the check's working directory (`app/`). Compare on a common form.
export function normalizeRepoPath(value) {
  const unified = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  return unified.startsWith("app/") ? unified.slice("app/".length) : unified;
}

function baselineIndex(baseline) {
  const index = new Map();
  const entries = baseline && typeof baseline === "object" ? baseline.entries : undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return index;
  for (const [key, value] of Object.entries(entries)) index.set(normalizeRepoPath(key), { key, value });
  return index;
}

export function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    return [`${BASELINE_PATH}: baseline must be a JSON object`];
  }
  if (!baseline.entries || typeof baseline.entries !== "object" || Array.isArray(baseline.entries)) {
    return [`${BASELINE_PATH}: baseline must contain an entries object`];
  }
  const failures = [];
  for (const [key, entry] of Object.entries(baseline.entries)) {
    const label = `${BASELINE_PATH} ${key}`;
    if (!key.trim()) {
      failures.push(`${label}: path must not be empty`);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failures.push(`${label}: entry must be an object`);
      continue;
    }
    if (!Number.isInteger(entry.maxLines) || entry.maxLines <= LINE_BUDGET) {
      failures.push(`${label}: maxLines must be an integer greater than ${LINE_BUDGET}`);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) failures.push(`${label}: missing non-empty reason`);
    if (typeof entry.plan !== "string" || !entry.plan.trim()) failures.push(`${label}: missing non-empty plan`);
  }
  return failures;
}

export function applyLineBudget({ inspected, baseline }) {
  const index = baselineIndex(baseline);
  const failures = [];
  for (const item of inspected ?? []) {
    const registered = index.get(normalizeRepoPath(item.file));
    if (!registered) {
      if (item.lines > LINE_BUDGET) {
        failures.push(`${item.file}: ${item.lines} lines exceeds ${LINE_BUDGET} (extract a cohesive module, or register a reason+plan exception in ${BASELINE_PATH})`);
      }
      continue;
    }
    const maxLines = Number.isInteger(registered.value?.maxLines) ? registered.value.maxLines : LINE_BUDGET;
    if (item.lines > maxLines) {
      failures.push(`${item.file}: ${item.lines} lines exceeds registered maxLines ${maxLines} (raise maxLines in ${BASELINE_PATH} with a refreshed reason, or split the module)`);
    }
  }
  return failures;
}

// Full audit: baseline-shape failures + budget failures, plus removal notices for
// entries whose file is already back within the default budget.
export function auditLineBudget({ inspected, baseline }) {
  const failures = [...validateBaseline(baseline), ...applyLineBudget({ inspected, baseline })];
  const index = baselineIndex(baseline);
  const notices = [];
  for (const item of inspected ?? []) {
    const registered = index.get(normalizeRepoPath(item.file));
    if (registered && item.lines <= LINE_BUDGET) {
      notices.push(`${item.file}: ${item.lines} lines within ${LINE_BUDGET}; remove its line-budget baseline entry`);
    }
  }
  return { failures, notices };
}
