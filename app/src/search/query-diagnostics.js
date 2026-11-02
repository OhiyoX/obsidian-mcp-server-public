import { evaluateObsidianQuery } from "./evaluator.js";

// Public explain bounds (Issue 229 contract §7.3). These bound the diagnostics
// payload only; they never change query semantics.
const MAX_GROUPS = 8;
const MAX_CLAUSES = 16;

// Clauses whose own coverage we want to explain. Every other clause in the same
// group — structural field filters and any negated clause — is a restriction
// that must also hold for the evaluated clause to count as reachable.
const TEXTUAL_TYPES = new Set(["text", "content", "line", "section"]);

function isRestriction(clause) {
  return clause.negated === true || !TEXTUAL_TYPES.has(clause.type);
}

function restrictionsFor(group, clause) {
  return group.filter((candidate) => candidate !== clause && isRestriction(candidate));
}

function countGroupMatches(records, group, evalOptions) {
  let matched = 0;
  for (const record of records) {
    if (evaluateObsidianQuery(record, { groups: [group] }, evalOptions).matched) matched += 1;
  }
  return matched;
}

// Pure, IO-free zero-result explainer. `records` is the caller's already-filtered
// candidate set (pathPrefix/pathRegex/fileRegex/modified/created/tags/frontmatter
// have been applied upstream); this module never reads the Vault or retrieval
// index and reuses the exact evaluator for every count (contract §7.1, §7.2).
export function buildZeroResultDiagnostics(records, parsed, options = {}) {
  const candidates = Array.isArray(records) ? records : [];
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  // Diagnostics explain the exact path, never a semantic candidate state.
  const evalOptions = { ...options, semanticCandidate: false };

  const output = [];
  let clauseBudget = MAX_CLAUSES;
  let truncated = false;

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    // Whole group or nothing: if the group does not fit the remaining clause
    // budget, it and every following group are omitted.
    if (groupIndex >= MAX_GROUPS || group.length > clauseBudget) {
      truncated = true;
      break;
    }
    clauseBudget -= group.length;
    output.push({
      groupIndex,
      matchedRecords: countGroupMatches(candidates, group, evalOptions),
      clauses: group.map((clause) => ({
        raw: clause.raw,
        type: clause.type,
        negated: clause.negated === true,
        matchedRecords: countGroupMatches(candidates, [clause, ...restrictionsFor(group, clause)], evalOptions),
      })),
    });
  }

  return {
    candidateRecords: candidates.length,
    exactMatched: 0,
    groupCount: groups.length,
    implicitAnd: groups.length === 1 && groups[0].length > 1,
    truncated,
    groups: output,
  };
}
