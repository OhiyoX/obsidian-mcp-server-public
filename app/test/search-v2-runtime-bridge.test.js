// Search v2 Task S2 — connect the existing offline analyzer to the live lexical path.
//
// The parser (`obsidian-query.js`) stays the authority: hard filters, negatives and
// quoted phrases are decided there. Only a positive *textual* clause is handed to
// `analyzePositiveClauses`/`analyzeText` — this suite pins which clauses those are,
// the exact raw UTF-16 token spans returned for them, and the fact that a hard filter
// never turns into a rankable term. The live path is behind `SEARCH_V2_ANALYZER`
// (off by default); with the flag off nothing changes, and with it on the analyzed
// tokens can only *keep* a candidate that today's literal needle already matched.
import assert from "node:assert/strict";
import test from "node:test";
import { allTagsForNote, parseFrontmatter } from "../src/obsidian.js";
import { analyzePositiveClauses } from "../src/search/analyzer.js";
import { analyzerFlagOn, clausesToAnalyze, evaluateObsidianQuery } from "../src/search/evaluator.js";
import { hybridSearch } from "../src/search/hybrid-search.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";

const FLAG = "SEARCH_V2_ANALYZER";

async function withFlag(on, run) {
  const saved = process.env[FLAG];
  if (on) process.env[FLAG] = "1";
  else delete process.env[FLAG];
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
}

// The bridge output for one raw query: the clauses the analyzer was allowed to see and
// the tokens it returned for each of them, as `[kind, value, rawStart, rawEnd]`.
function bridge(query) {
  const clauses = clausesToAnalyze(parseObsidianQuery(query));
  const analyzed = analyzePositiveClauses(clauses).clauses;
  return analyzed.map((entry) => ({
    kind: entry.kind,
    text: clauses[entry.clauseIndex].text,
    tokens: entry.tokens.map((token) => [token.kind, token.value, token.rawStart, token.rawEnd]),
  }));
}

function tokensOf(query) {
  const bridged = bridge(query);
  assert.equal(bridged.length, 1, `expected exactly one analyzed clause for ${query}`);
  return bridged[0].tokens;
}

test(`the flag ${FLAG} is off unless it is explicitly on`, async () => {
  await withFlag(false, () => assert.equal(analyzerFlagOn(), false));
  for (const value of ["1", "true", "on", "yes", " TRUE "]) {
    process.env[FLAG] = value;
    assert.equal(analyzerFlagOn(), true, `${FLAG}=${value}`);
  }
  for (const value of ["", "0", "false", "off", "analyzer"]) {
    process.env[FLAG] = value;
    assert.equal(analyzerFlagOn(), false, `${FLAG}=${value}`);
  }
  delete process.env[FLAG];
});

function recordFor(raw, path) {
  const { data, content } = parseFrontmatter(raw);
  return {
    path,
    name: path.split("/").pop(),
    basename: path.replace(/^.*\//, "").replace(/\.md$/, ""),
    tags: allTagsForNote({ frontmatter: data, content }),
    aliases: [],
    frontmatter: data,
    content,
    raw,
    stat: { modified: "2026-01-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z", size: raw.length },
    revision: "sha256:0",
  };
}

const OPSTOOL = recordFor("---\nowner: Ada\ntags:\n  - ops/runbook\n---\ndeploy the restore plan, backup, retry policy\n", "Ops/runbook.md");
const OTHER = recordFor("---\nowner: Bob\ntags:\n  - notes\n---\ndeploy the restore plan, backup, retry policy\n", "Notes/other.md");
const BACKOFF = recordFor("---\nowner: Ada\ntags:\n  - ops/runbook\n---\nretry with backoff\n", "Ops/backoff.md");
const PHRASE = recordFor("---\nowner: Ada\ntags:\n  - ops/runbook\n---\na delayed retry budget is set\n", "Ops/phrase.md");
const RECORDS = [OPSTOOL, OTHER, BACKOFF, PHRASE];

const PINNED_QUERIES = [
  "网络故障",
  "restore_from_trash",
  "app/src/search.js",
  "planRestoreVersion",
  "2c1a9f0",
  '"delayed retry budget"',
  "retry policy -draft",
  "path:Ops deploy",
  "tag:ops/runbook deploy",
  "[owner:Ada] backup",
  "retry -backoff",
];

function evaluateAll(records, queries) {
  return records.map((record) => queries.map((query) => {
    const result = evaluateObsidianQuery(record, parseObsidianQuery(query), {});
    return { path: record.path, query, matched: result.matched, matchCount: result.matchCount, snippets: result.snippets, matchedClauses: result.matchedClauses };
  }));
}

// --- which clauses the analyzer may see ------------------------------------------------

test("only positive textual clauses are handed to the analyzer", () => {
  const texts = (query) => bridge(query).map((entry) => [entry.kind, entry.text]);
  assert.deepEqual(texts("网络故障"), [["term", "网络故障"]]);
  assert.deepEqual(texts("restore_from_trash"), [["term", "restore_from_trash"]]);
  assert.deepEqual(texts("app/src/search.js"), [["term", "app/src/search.js"]]);
  assert.deepEqual(texts("planRestoreVersion"), [["term", "planRestoreVersion"]]);
  assert.deepEqual(texts("2c1a9f0"), [["term", "2c1a9f0"]]);
  assert.deepEqual(texts('"delayed retry budget"'), [["phrase", "delayed retry budget"]]);
  assert.deepEqual(texts("retry policy -draft"), [["term", "retry"], ["term", "policy"]]);
  assert.deepEqual(texts("path:Ops deploy"), [["term", "deploy"]]);
  assert.deepEqual(texts("tag:search/index refresh"), [["term", "refresh"]]);
  assert.deepEqual(texts("[owner:Ada] backup"), [["term", "backup"]]);
  assert.deepEqual(texts("-draft"), []);
  assert.deepEqual(texts("-path:Ops -tag:notes"), []);
  assert.deepEqual(texts("path:Ops tag:notes"), []);
});

test("a hard filter value never becomes a rankable term", () => {
  for (const query of ["path:Ops deploy", "tag:search/index refresh", "[owner:Ada] backup", "retry -draft", "-restore"]) {
    const values = bridge(query).flatMap((entry) => entry.tokens.map(([, value]) => value));
    for (const forbidden of ["ops", "search/index", "ada", "draft", "path", "tag", "owner"]) {
      assert.ok(!values.includes(forbidden), `${query}: hard-filter value ${forbidden} reached the analyzer tokens`);
    }
  }
});

// --- raw UTF-16 interpretation ---------------------------------------------------------

test("a CJK query keeps its run and its n-grams on the raw offsets", () => {
  assert.deepEqual(tokensOf("网络故障"), [
    ["cjk.unigram", "网", 0, 1],
    ["cjk.bigram", "网络", 0, 2],
    ["cjk.run", "网络故障", 0, 4],
    ["cjk.unigram", "络", 1, 2],
    ["cjk.bigram", "络故", 1, 3],
    ["cjk.unigram", "故", 2, 3],
    ["cjk.bigram", "故障", 2, 4],
    ["cjk.unigram", "障", 3, 4],
  ]);
});

test("identifiers keep the whole form and their parts", () => {
  assert.deepEqual(tokensOf("restore_from_trash"), [
    ["identifier.part", "restore", 0, 7],
    ["identifier.whole", "restore_from_trash", 0, 18],
    ["identifier.part", "from", 8, 12],
    ["identifier.part", "trash", 13, 18],
  ]);
  assert.deepEqual(tokensOf("app/src/search.js"), [
    ["identifier.part", "app", 0, 3],
    ["identifier.whole", "app/src/search.js", 0, 17],
    ["identifier.part", "src", 4, 7],
    ["identifier.part", "search", 8, 14],
    ["identifier.part", "js", 15, 17],
  ]);
  assert.deepEqual(tokensOf("planRestoreVersion"), [
    ["identifier.part", "plan", 0, 4],
    ["identifier.whole", "planrestoreversion", 0, 18],
    ["identifier.part", "restore", 4, 11],
    ["identifier.part", "version", 11, 18],
  ]);
});

test("a hash stays one word and a quoted phrase keeps its literal", () => {
  assert.deepEqual(tokensOf("2c1a9f0"), [["word", "2c1a9f0", 0, 7]]);
  assert.deepEqual(tokensOf('"delayed retry budget"'), [
    ["word", "delayed", 0, 7],
    ["phrase.literal", "delayed retry budget", 0, 20],
    ["word", "retry", 8, 13],
    ["word", "budget", 14, 20],
  ]);
});

test("every token span slices back to its own raw fragment", () => {
  for (const query of PINNED_QUERIES) {
    for (const entry of bridge(query)) {
      for (const [kind, , rawStart, rawEnd] of entry.tokens) {
        const fragment = entry.text.slice(rawStart, rawEnd);
        assert.ok(fragment.length > 0, `${query} ${kind}: empty raw span ${rawStart}..${rawEnd}`);
        assert.equal(fragment.normalize("NFKC").toLowerCase(), entry.tokens.find((token) => token[0] === kind && token[2] === rawStart && token[3] === rawEnd)[1]);
      }
    }
  }
});

// --- the live path stays the parser's ---------------------------------------------------

test("hard filters, negatives and phrases stay hard with the flag on and off", async () => {
  const cases = [
    ["path:Ops deploy", OPSTOOL, true, OTHER, false],
    ["tag:ops/runbook deploy", OPSTOOL, true, OTHER, false],
    ["[owner:Ada] backup", OPSTOOL, true, OTHER, false],
    ["retry -backoff", BACKOFF, false, OPSTOOL, true],
    ['"delayed retry budget"', PHRASE, true, OTHER, false],
  ];
  for (const flag of [false, true]) {
    await withFlag(flag, () => {
      for (const [query, record, expected, other, otherExpected] of cases) {
        const parsed = parseObsidianQuery(query);
        assert.equal(evaluateObsidianQuery(record, parsed, {}).matched, expected, `flag=${flag} ${query} on ${record.path}`);
        assert.equal(evaluateObsidianQuery(other, parsed, {}).matched, otherExpected, `flag=${flag} ${query} on ${other.path}`);
      }
    });
  }
});

test("the flag does not move a single evaluated result", async () => {
  const off = await withFlag(false, () => evaluateAll(RECORDS, PINNED_QUERIES));
  const on = await withFlag(true, () => evaluateAll(RECORDS, PINNED_QUERIES));
  assert.deepEqual(on, off);
});

test("the analyzed tokens really gate the live clause", () => {
  const parsed = parseObsidianQuery("restore");
  const clause = parsed.groups[0][0];
  assert.equal(evaluateObsidianQuery(OPSTOOL, parsed, {}).matched, true);
  const blocked = new Map([[clause, ["not-in-this-note"]]]);
  assert.equal(evaluateObsidianQuery(OPSTOOL, parsed, { analyzedNeedles: blocked }).matched, false);
  const allowed = new Map([[clause, ["restore"]]]);
  assert.equal(evaluateObsidianQuery(OPSTOOL, parsed, { analyzedNeedles: allowed }).matched, true);
});

test("semantic auto behaviour is unchanged by the flag", async () => {
  const calls = [];
  const recallStub = async (text) => {
    calls.push(text);
    return { results: [], semanticUsed: false, semanticError: null };
  };
  for (const flag of [false, true]) {
    await withFlag(flag, async () => {
      calls.length = 0;
      const exact = await hybridSearch(RECORDS, parseObsidianQuery("deploy"), {}, recallStub);
      assert.equal(exact.exactMatched, 2);
      assert.equal(calls.length, 0, `flag=${flag}: auto mode called recall although the exact pass matched`);
      assert.equal(exact.fallbackUsed, false);
      const zero = await hybridSearch(RECORDS, parseObsidianQuery("quuxabsent"), {}, recallStub);
      assert.equal(zero.exactMatched, 0);
      assert.equal(calls.length, 1, `flag=${flag}: auto mode did not fall back on a zero-exact query`);
      assert.equal(zero.fallbackUsed, true);
    });
  }
});
