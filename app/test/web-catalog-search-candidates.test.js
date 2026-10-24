// Phase 3A-1 candidate-stream contract: trigram substring semantics, keyset paging,
// cursor identity, v1 superset/equivalence, FTS freshness, the short-needle (incl.
// CJK) continuation gate and the 50k complexity gate.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { evaluateObsidianQuery } from "../src/search/evaluator.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";
import { SEARCH_CANDIDATE_MODES, SEARCH_RANK_MODES, buildWebCatalogSearchQuery } from "../src/app/web-catalog/search-query.js";
import { planSearchCandidates } from "../src/app/web-catalog/search-planner.js";
import {
  MAX_CANDIDATES_PER_REQUEST,
  WebCatalogSearchCursorError,
  encodeSearchCursor,
  searchCandidates,
} from "../src/app/web-catalog/search-candidates.js";
import { ensureCatalogDirectories, openWebCatalogStore } from "../src/app/web-catalog/store.js";

// --- runtime guard: the frozen baseline must provide the trigram substring index ---

test("the frozen runtime provides a trigram substring index with bm25", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(raw, tokenize='trigram')");
  db.prepare("INSERT INTO t(rowid, raw) VALUES (1, ?)").run("the Foobar quick brown fox");
  const hits = (needle) => db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(`"${needle}"`).length;
  assert.equal(hits("foo"), 1, "case-insensitive substring");
  assert.equal(hits("oob"), 1, "substring, not a whole token");
  assert.equal(hits("quick"), 1);
  assert.equal(hits("oo"), 0, "shorter than one trigram: no candidate, never an error");
  const score = db.prepare("SELECT CAST(bm25(t) * 1000000 AS INTEGER) AS s FROM t WHERE t MATCH ?").get('"foo"').s;
  assert.equal(Number.isSafeInteger(score), true);
});

test("the bm25 sorter is bounded by the page, not by the match set", () => {
  // The bm25 order is explicit `(score_q, path_key)`, which needs a sorter. FTS5 only
  // guarantees relevance order for `ORDER BY rank` and leaves the relative order of
  // equal keys undefined, so an implicit tie-break cannot back a paging protocol.
  // What makes the explicit tie-break safe is that SQLite's sorter keeps only the
  // top-N rows: the same query without LIMIT materialises the whole match set.
  const store = buildScaleVault(50000, 5000);
  const plan = planSearchCandidates(parseObsidianQuery("deep"));
  const built = buildWebCatalogSearchQuery({ candidateMode: plan.candidateMode, rankMode: plan.rankMode, size: 50 });
  // Param 0 is the FTS MATCH placeholder the store fills in.
  const page = { sql: built.sql, params: [plan.match, ...built.params.slice(1)] };
  const unbounded = { sql: page.sql.replace(/ LIMIT \?$/, ""), params: page.params.slice(0, -1) };
  const db = store.testDb();
  const rss = () => Math.round(process.memoryUsage().rss / 1048576);
  const measure = ({ sql, params }) => {
    const before = rss();
    const rows = db.prepare(sql).all(...params);
    return { rows: rows.length, delta: rss() - before };
  };
  // Bounded first: RSS only grows, so measuring the page before the reference keeps
  // the comparison conservative.
  const bounded = measure(page);
  const materialized = measure(unbounded);
  assert.equal(bounded.rows, 51, "one page plus the look-ahead row");
  assert.ok(materialized.rows > 40000, `the reference must materialise the match set: ${materialized.rows}`);
  assert.ok(
    bounded.delta < materialized.delta / 2,
    `page memory must stay bounded by the LIMIT: page=${bounded.delta}MB materialised=${materialized.delta}MB`,
  );
  store.close();
});

// --- fixture: the same data feeds the catalog and the v1 evaluator ---

const NOTES = [
  {
    path: "Notes/Alpha.md",
    content: "alpha body with foobar token",
    raw: "---\nstatus: done\ntags:\n  - projects/x\n---\nalpha body with foobar token",
    tags: ["projects/x"],
    properties: { status: "done" },
    frontmatter: { status: "done" },
  },
  {
    path: "Notes/Beta.md",
    content: "beta body only",
    raw: "---\nstatus: todo\n---\nbeta body only",
    tags: ["areas/y"],
    properties: { status: "todo" },
    frontmatter: { status: "todo" },
  },
  {
    path: "Archive/Deep/Gamma.md",
    content: "## Section One\n\ngamma line here\n\n## Section Two\n\nmore gamma",
    raw: "---\nstatus: done\n---\n## Section One\n\ngamma line here\n\n## Section Two\n\nmore gamma",
    tags: ["projects/x", "areas/y"],
    properties: { status: "done" },
    frontmatter: { status: "done" },
  },
  // A needle that only exists in frontmatter YAML: `text:` matches v1's `raw`.
  {
    path: "Notes/Frontmatter-only.md",
    content: "no matching body text at all",
    raw: "---\nsecretword: zzqqxx\n---\nno matching body text at all",
    tags: [],
    properties: { secretword: "zzqqxx" },
    frontmatter: { secretword: "zzqqxx" },
  },
  // CJK: 1-2 character needles cannot use the trigram index (residual), 3+ can.
  {
    path: "Notes/CJK.md",
    content: "中文笔记 内容",
    raw: "---\nstatus: done\n---\n中文笔记 内容",
    tags: ["projects/x"],
    properties: { status: "done" },
    frontmatter: { status: "done" },
  },
  {
    path: "Archive/CJK-two.md",
    content: "另一篇 笔记 文档",
    raw: "---\nstatus: todo\n---\n另一篇 笔记 文档",
    tags: [],
    properties: { status: "todo" },
    frontmatter: { status: "todo" },
  },
];

function seed(store, notes) {
  store.batch(() => {
    for (const note of notes) {
      ensureCatalogDirectories(store, note.path);
      store.upsertNote({
        path: note.path,
        content: note.content,
        raw: note.raw,
        tags: note.tags || [],
        aliases: note.aliases || [],
        properties: note.properties || {},
        modifiedMs: note.modifiedMs ?? 0,
      });
    }
  });
}

function v1Matches(notes, query, options = {}) {
  const parsed = parseObsidianQuery(query);
  return notes
    .filter((note) =>
      evaluateObsidianQuery(
        {
          path: note.path,
          name: path.posix.basename(note.path),
          basename: path.posix.basename(note.path, ".md"),
          tags: note.tags || [],
          aliases: note.aliases || [],
          frontmatter: note.frontmatter || {},
          content: note.content,
          raw: note.raw,
        },
        parsed,
        { caseSensitive: options.caseSensitive === true },
      ).matched,
    )
    .map((note) => note.path);
}

function streamPaths(store, query, options = {}, limit = 2) {
  const plan = planSearchCandidates(parseObsidianQuery(query), options);
  const paths = [];
  let cursor = null;
  for (let guard = 0; guard < 400; guard += 1) {
    const page = searchCandidates(store, { plan, limit, cursor });
    paths.push(...page.items.map((item) => item.path));
    cursor = page.nextCursor;
    if (!cursor) return { paths, plan, windowCapped: page.windowCapped };
  }
  throw new Error("candidate stream did not terminate");
}

test("every v1 match is a candidate, and the bounded second pass restores exact v1 equality", () => {
  const store = openWebCatalogStore();
  seed(store, NOTES);
  const queries = [
    "foobar", // substring, not a token
    "oob", // substring in the middle of a token
    "oo", // shorter than a trigram -> residual stream
    "ab", // 2-char ASCII -> residual stream
    "笔记", // 2-char CJK -> residual stream
    "中文笔", // 3-char CJK -> trigram candidate
    "中文笔记", // 4-char CJK -> trigram candidate
    "path:Notes",
    "file:Alpha",
    "tag:projects",
    "tag:projects/x",
    "[status]",
    "[status:done]",
    "[secretword:zzqqxx]",
    "line:gamma",
    "section:Section One",
    "zzqqxx", // only present in frontmatter YAML
    "alpha OR tag:areas",
    "alpha OR line:gamma", // one unseeded branch -> residual
    "-alpha",
    "alpha line:alpha",
  ];
  for (const query of queries) {
    const expected = v1Matches(NOTES, query).sort();
    const { paths, plan } = streamPaths(store, query);
    const candidates = [...new Set(paths)];
    assert.deepEqual(paths, candidates, `${query}: no duplicate candidates`);
    for (const match of expected) {
      assert.ok(candidates.includes(match), `${query}: ${match} must be a candidate (${plan.candidateMode})`);
    }
    // Simulate the Phase 3A-2 second pass on the bounded candidate set.
    const notesByPath = new Map(NOTES.map((note) => [note.path, note]));
    const secondPass = candidates
      .filter((candidate) => v1Matches([notesByPath.get(candidate)], query).length === 1)
      .sort();
    assert.deepEqual(secondPass, expected, `${query}: second pass must equal v1 exactly`);
  }
  store.close();
});

test("short needles page through the residual stream without duplicates or misses", () => {
  // Frozen §11 gate: 1-2 character needles (CJK and ASCII) must still be reachable
  // by continuing the cursor, not by an error and not by a silent cap.
  const store = openWebCatalogStore();
  seed(store, NOTES);
  for (const query of ["笔记", "oo", "ab"]) {
    const planned = planSearchCandidates(parseObsidianQuery(query));
    assert.equal(planned.candidateMode, SEARCH_CANDIDATE_MODES.RESIDUAL, `${query} is residual`);
    assert.equal(planned.rankMode, SEARCH_RANK_MODES.PATH, `${query} ranks by path`);
    const { paths } = streamPaths(store, query, {}, 2);
    assert.equal(paths.length, NOTES.length, `${query}: the residual stream reaches every note`);
    assert.deepEqual([...new Set(paths)], paths, `${query}: no duplicates`);
    const expected = v1Matches(NOTES, query).sort();
    const notesByPath = new Map(NOTES.map((note) => [note.path, note]));
    const secondPass = paths.filter((candidate) => v1Matches([notesByPath.get(candidate)], query).length === 1).sort();
    assert.deepEqual(secondPass, expected, `${query}: second pass equals v1`);
  }
  store.close();
});

test("candidate items carry metadata only — the candidate layer never hydrates note text", () => {
  const store = openWebCatalogStore();
  seed(store, NOTES);
  const page = searchCandidates(store, { plan: planSearchCandidates(parseObsidianQuery("foobar")), limit: 5 });
  assert.ok(page.items.length >= 1);
  for (const item of page.items) {
    assert.deepEqual(Object.keys(item).sort(), ["kind", "modified_ms", "name", "path", "path_key", "score_q"]);
  }
  store.close();
});

test("paging is keyset-stable and ends with a null cursor", () => {
  const store = openWebCatalogStore();
  seed(store, NOTES);
  const plan = planSearchCandidates(parseObsidianQuery(""));
  assert.equal(plan.candidateMode, SEARCH_CANDIDATE_MODES.RESIDUAL);
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = searchCandidates(store, { plan, limit: 1, cursor });
    assert.equal(page.items.length, 1);
    seen.push(page.items[0].path);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, NOTES.length);
  assert.deepEqual([...new Set(seen)], seen);
  store.close();
});

test("search cursors fail closed on tampering, another query, another catalog and a stale generation", () => {
  const store = openWebCatalogStore();
  seed(store, NOTES);
  const plan = planSearchCandidates(parseObsidianQuery("body"));
  const first = searchCandidates(store, { plan, limit: 1 });
  assert.ok(first.nextCursor);

  const decode = (cursor, overrides = {}) =>
    searchCandidates(store, {
      plan: overrides.plan ?? plan,
      limit: 1,
      cursor,
    });

  assert.throws(() => decode("not-a-cursor!"), WebCatalogSearchCursorError);
  assert.throws(() => decode(Buffer.from("{}", "utf8").toString("base64url")), WebCatalogSearchCursorError);
  // Another query identity must not continue this stream.
  assert.throws(
    () => decode(first.nextCursor, { plan: planSearchCandidates(parseObsidianQuery("gamma")) }),
    WebCatalogSearchCursorError,
  );

  // A stale generation is recoverable, so it carries the dedicated code.
  const staleCursor = encodeSearchCursor({
    catalogId: store.catalogId(),
    generation: store.generation() + 1,
    queryHash: plan.queryHash,
    rankMode: plan.rankMode,
    scoreQ: 0,
    pathKey: "0000",
  });
  assert.throws(
    () => decode(staleCursor),
    (error) => error instanceof WebCatalogSearchCursorError && error.code === "WEB_CATALOG_CURSOR_STALE",
  );

  // A cursor from another catalog is rejected even when the generation matches.
  const other = openWebCatalogStore();
  const foreignCursor = encodeSearchCursor({
    catalogId: other.catalogId(),
    generation: store.generation(),
    queryHash: plan.queryHash,
    rankMode: plan.rankMode,
    scoreQ: 0,
    pathKey: "0000",
  });
  assert.throws(() => decode(foreignCursor), WebCatalogSearchCursorError);

  // A mutation moves the generation, so the old cursor is stale.
  store.upsertNote({ path: "Notes/Alpha.md", content: "changed", raw: "changed" });
  assert.throws(
    () => decode(first.nextCursor),
    (error) => error instanceof WebCatalogSearchCursorError && error.code === "WEB_CATALOG_CURSOR_STALE",
  );
  other.close();
  store.close();
});

test("the FTS projection tracks updates and removals", () => {
  const store = openWebCatalogStore();
  seed(store, NOTES);
  const plan = () => planSearchCandidates(parseObsidianQuery("zzqqxx"));
  assert.equal(searchCandidates(store, { plan: plan(), limit: 10 }).items.length, 1);
  store.upsertNote({ path: "Notes/Frontmatter-only.md", content: "replaced", raw: "replaced" });
  assert.equal(searchCandidates(store, { plan: plan(), limit: 10 }).items.length, 0, "old needle disappears");
  store.removePath("Archive/Deep/Gamma.md");
  const gamma = planSearchCandidates(parseObsidianQuery("more gamma"));
  assert.equal(searchCandidates(store, { plan: gamma, limit: 10 }).items.length, 0, "removed note leaves the index");
  store.close();
});

// --- 50k complexity gate: candidate work is bounded by the window/page, not the vault ---

function buildScaleVault(total, hot) {
  const store = openWebCatalogStore();
  store.batch(() => {
    for (let index = 0; index < hot; index += 1) {
      const notePath = `Hot/h-${String(index).padStart(5, "0")}.md`;
      ensureCatalogDirectories(store, notePath);
      store.upsertNote({ path: notePath, content: `# hot ${index}`, raw: `# hot ${index}`, modifiedMs: index });
    }
    for (let index = 0; index < total - hot; index += 1) {
      const notePath = `Deep/D${String(Math.floor(index / 90)).padStart(3, "0")}/S${Math.floor((index % 90) / 9)}/note-${String(index).padStart(5, "0")}.md`;
      ensureCatalogDirectories(store, notePath);
      store.upsertNote({ path: notePath, content: `# deep ${index}`, raw: `# deep ${index}`, modifiedMs: index });
    }
  });
  return store;
}

function planText(rows) {
  return rows.map((row) => row.detail).join("\n");
}

test("50k candidate queries are index-only and do not grow with the vault", () => {
  const small = buildScaleVault(1000, 500);
  const big = buildScaleVault(50000, 5000);
  const textPlan = planSearchCandidates(parseObsidianQuery("hot"));
  const structuralPlan = planSearchCandidates(parseObsidianQuery("path:Hot"));
  const residualPlan = planSearchCandidates(parseObsidianQuery("line:hot"));
  assert.equal(textPlan.rankMode, SEARCH_RANK_MODES.BM25);
  assert.equal(structuralPlan.rankMode, SEARCH_RANK_MODES.PATH);
  assert.equal(structuralPlan.candidateMode, SEARCH_CANDIDATE_MODES.FTS);

  const plansFor = (store, plan) =>
    planText(store.planSearchCandidates({ candidateMode: plan.candidateMode, rankMode: plan.rankMode, match: plan.match, limit: 50 }));

  for (const [label, store] of [["1k", small], ["50k", big]]) {
    const text = plansFor(store, textPlan);
    const structural = plansFor(store, structuralPlan);
    const residual = plansFor(store, residualPlan);
    for (const [name, text_] of [["text", text], ["structural", structural], ["residual", residual]]) {
      assert.ok(!/SCAN nodes\b/i.test(text_), `${label} ${name}: no full nodes scan\n${text_}`);
    }
    // The FTS match must DRIVE the join and nodes must be reached only by primary-key
    // lookup. Without the explicit hint the planner satisfies the path ordering by
    // walking `nodes_kind_path_key` over the whole catalog and probing FTS per row
    // (O(total notes)): measured on the target platform, a 5k-match `path:` query did
    // not return within 120s at 50k notes. `SEARCH n USING INDEX nodes_kind_path_key`
    // would satisfy a "no SCAN nodes" assertion, so this gate names the required shape.
    for (const [name, text_] of [["bm25", text], ["structural", structural]]) {
      assert.match(text_, /SCAN notes_fts VIRTUAL TABLE/, `${label} ${name}: the FTS match must drive the join\n${text_}`);
      assert.match(text_, /SEARCH n USING INDEX sqlite_autoindex_nodes_1 \(path=\?\)/, `${label} ${name}: nodes must be a primary-key lookup\n${text_}`);
      assert.doesNotMatch(text_, /nodes_kind_path_key/, `${label} ${name}: must not walk the catalog by path_key\n${text_}`);
    }
    // Residual mode carries no rank at all: index order, no sort, and it is the one
    // mode that legitimately streams `nodes` itself.
    assert.match(residual, /nodes_kind_path_key/, `${label} residual uses the path_key index\n${residual}`);
    assert.ok(!/TEMP B-TREE/i.test(residual), `${label} residual must not sort\n${residual}`);
  }

  assert.equal(plansFor(big, textPlan), plansFor(small, textPlan), "the 50k text plan must equal the 1k plan");
  assert.equal(plansFor(big, residualPlan), plansFor(small, residualPlan), "the residual plan must not change with vault size");

  // A page returns at most size + 1 rows (the extra row only signals "has more").
  const page = searchCandidates(big, { plan: textPlan, limit: 50 });
  assert.ok(page.items.length <= 51, `page bounded: ${page.items.length}`);
  assert.ok(page.nextCursor, "a full page must offer a continuation");

  // Every match must stay reachable by continuing the cursor, with each request
  // bounded: the per-request ceiling must never truncate the stream.
  const seen = [];
  let cursor = null;
  let maxConsumed = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const next = searchCandidates(big, { plan: textPlan, limit: 200, cursor });
    maxConsumed = Math.max(maxConsumed, next.consumed);
    seen.push(...next.items.map((item) => item.path));
    cursor = next.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 5000, "all 5000 bm25 matches must be reachable");
  assert.equal(new Set(seen).size, 5000, "no duplicates across continuations");
  assert.ok(maxConsumed <= MAX_CANDIDATES_PER_REQUEST, `per-request consumption bounded: ${maxConsumed}`);

  // Issue #270: the publish constraint must be a candidate-selection constraint, so a
  // sparse registry inside a large vault answers in one page instead of asking the
  // user to click through empty pages. It also must not change the plan.
  // Two of the 5000 "hot" matches: the constraint must narrow the stream to these.
  const sparse = ["Hot/h-00000.md", "Hot/h-00001.md"];
  const filteredPlan = (store) => store.planSearchCandidates({
    candidateMode: textPlan.candidateMode, rankMode: textPlan.rankMode, match: textPlan.match, limit: 50,
    publish: { published: true, paths: sparse },
  }).map((row) => row.detail).filter((detail) => !/json_each|LIST SUBQUERY|BLOOM FILTER/.test(detail));
  assert.deepEqual(filteredPlan(big), filteredPlan(small), "the publish constraint must not make the plan grow with the vault");
  const sparsePage = searchCandidates(big, { plan: textPlan, limit: 50, publish: { published: true, paths: sparse } });
  assert.deepEqual(sparsePage.items.map((item) => item.path), sparse, "only the two published notes are candidates");
  assert.equal(sparsePage.nextCursor, null, "a sparse registry must not need a second page");

  small.close();
  big.close();
});

// --- publish filter is a candidate-selection constraint (issue #270) --------------
//
// The constraint must not change the statement *text*: the store prepares the six
// shapes once at open and binds by position, so a request-varying SQL string would
// silently bind against the wrong statement.

test("the publish constraint is unconditional in the SQL and carried by parameters", () => {
  const withFilter = buildWebCatalogSearchQuery({
    candidateMode: SEARCH_CANDIDATE_MODES.FTS,
    rankMode: SEARCH_RANK_MODES.BM25,
    size: 10,
    publish: { published: true, paths: ["Notes/Alpha.md"] },
  });
  const without = buildWebCatalogSearchQuery({
    candidateMode: SEARCH_CANDIDATE_MODES.FTS,
    rankMode: SEARCH_RANK_MODES.BM25,
    size: 10,
  });
  assert.equal(withFilter.sql, without.sql, "the statement text must not depend on the request");
  assert.notDeepEqual(withFilter.params, without.params);
  assert.equal(withFilter.sql.includes("json_each"), true);
  // Two extra parameters (path list + required flag), always in the same position.
  assert.equal(withFilter.params.length, without.params.length);
  assert.equal(without.params.at(-3), "[]", "the default binding cannot match any row");
  assert.equal(without.params.at(-2), 0, "so `0 = 0` keeps every candidate");
  assert.equal(withFilter.params.at(-3), '["Notes/Alpha.md"]');
  assert.equal(withFilter.params.at(-2), 1, "published:true requires membership");
});

test("published:true / published:false / absent select the right candidates in SQL", () => {
  const store = openWebCatalogStore();
  seed(store, NOTES);
  const plan = planSearchCandidates(parseObsidianQuery("line:alpha"), { published: true });
  const residual = (publish) => {
    const rows = [];
    let cursor = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = searchCandidates(store, { plan, limit: 100, cursor, publish });
      rows.push(...page.items.map((item) => item.path));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return rows.sort();
  };
  const published = [NOTES[0].path];
  assert.deepEqual(residual({ published: true, paths: published }), published, "only the registry path");
  assert.deepEqual(
    residual({ published: false, paths: published }),
    NOTES.map((note) => note.path).filter((p) => p !== NOTES[0].path).sort(),
    "every other note",
  );
  assert.deepEqual(residual(null), NOTES.map((note) => note.path).sort(), "no constraint keeps the stream complete");
  store.close();
});
