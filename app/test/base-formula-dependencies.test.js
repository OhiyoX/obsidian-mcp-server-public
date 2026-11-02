// Bases P1 / INT-B — end-to-end tests for the formula dependency wiring.
//
// Scope of this file:
//   1. `extractFormulaReferences` (the graph's only seam) over the P1-A AST;
//   2. formula properties defined in terms of other formulas, through the REAL
//      canonical pipeline (`queryBaseSnapshot`) and the REAL MCP `query_base`;
//   3. per-row counting evidence for a diamond dependency (algorithmic counter,
//      not wall clock);
//   4. cycle completeness: self / 2-node / 3-node / dead branch, all failing at
//      compile time;
//   5. error propagation: verbatim dependency message + causes chain;
//   6. INT-C wiring: `formula.*` in filter / sort is typed, while `formula.*`
//      in `groupBy` still fails closed.
//
// The file is self-contained: it injects its own records and writes its own
// scratch vault, so it never touches the real vault or another lane's fixtures.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-bases-int-b-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(data, { recursive: true });
await fs.mkdir(vault, { recursive: true });

const { BaseQueryError, queryBaseSnapshot } = await import("../src/base-query.js");
const { BaseFormulaError, compileBaseFormulas, evaluateBaseFormula } = await import("../src/base-formulas.js");
const { extractFormulaReferences } = await import("../src/base-formula-dependencies.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

// All formulas go through the frozen P0 shell (`file.asLink(<expression>)`).
function baseDocument(formulas, order = ["file.path", "formula.note"]) {
  const lines = ["formulas:"];
  for (const [name, source] of Object.entries(formulas)) lines.push(`  ${name}: '${source}'`);
  lines.push("views:", "  - type: table", "    name: Main", "    order:");
  for (const key of order) lines.push(`      - ${key}`);
  return `${lines.join("\n")}\n`;
}

function snapshotError(raw, records = RECORDS) {
  try {
    queryBaseSnapshot({ raw, records });
  } catch (error) {
    return error;
  }
  return null;
}

// Counts own-property reads without ever executing an accessor: the Proxy trap
// runs instead of the getter, so instrumentation cannot change the semantics.
// `readOwnDataProperty` touches the descriptor twice per read (`Object.hasOwn`
// + `getOwnPropertyDescriptor`), so one evaluation of a marker key is exactly 2.
function countingFrontmatter(frontmatter) {
  const counts = new Map();
  const proxy = new Proxy(frontmatter, {
    getOwnPropertyDescriptor(target, key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { proxy, counts };
}

const RECORD_STAT = { size: 0, created: "2026-01-01T00:00:00Z", modified: "2026-02-01T00:00:00Z" };

const RECORDS = [1, 2, 3, 4, 5].map((index) => ({
  path: `Notes/Note${index}.md`,
  basename: `Note${index}`,
  frontmatter: { title: `Title ${index}`, price: index * 10, age: index },
  tags: [],
  links: [],
  stat: RECORD_STAT,
}));

function displays(raw, records = RECORDS, viewName = "Main") {
  return queryBaseSnapshot({ raw, records, viewName }).rows.map((row) =>
    Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, value?.displayName ?? value])));
}

// ── 1. extractFormulaReferences (graph seam) ────────────────────────────────

test("extractFormulaReferences: collects bare names from the P1-A AST in source order", async () => {
  assert.deepEqual(extractFormulaReferences("formula.a + formula.b"), ["a", "b"]);
  assert.deepEqual(extractFormulaReferences("if(formula.x, formula.y, 0)"), ["x", "y"]);
  assert.deepEqual(extractFormulaReferences("note.title + formula.z"), ["z"]);
  assert.deepEqual(extractFormulaReferences("1 + 2"), []);
  assert.deepEqual(extractFormulaReferences("(formula.b * 2) - formula.a"), ["b", "a"], "source order, not topological");
  assert.deepEqual(extractFormulaReferences("formula.a + formula.a"), ["a"], "each name appears once");
  assert.deepEqual(extractFormulaReferences("file.name + title"), []);
  // A parsed AST is accepted verbatim, so the seam never re-parses an AST.
  const ast = (await import("../src/base-expression.js")).parseBaseExpression("formula.deep + 1");
  assert.deepEqual(extractFormulaReferences(ast), ["deep"]);
  assert.throws(
    () => extractFormulaReferences(undefined),
    (error) => error instanceof Error && /parsed expression or an expression source/.test(error.message),
  );
});

// ── 2. formula definitions in terms of other formulas ───────────────────────

test("wired: a formula property can be defined from other formulas end to end", () => {
  const raw = baseDocument(
    {
      base: "file.asLink(price * 2)",
      scaled: "file.asLink(formula.base * 10)",
      label: 'file.asLink(if(formula.base > 50, title, file.name))',
    },
    ["formula.scaled", "formula.label"],
  );
  assert.deepEqual(displays(raw), [
    { "formula.scaled": "200", "formula.label": "Note1" },
    { "formula.scaled": "400", "formula.label": "Note2" },
    { "formula.scaled": "600", "formula.label": "Title 3" },
    { "formula.scaled": "800", "formula.label": "Title 4" },
    { "formula.scaled": "1000", "formula.label": "Title 5" },
  ]);
  // A dependency hands over its RAW value (the asLink cell is only the
  // projection wrapper): arithmetic on it must work.
  const [row] = displays(baseDocument({ d: "file.asLink(price)", twice: "file.asLink(formula.d + formula.d)" }, ["formula.twice"]),
    [RECORDS[2]], "Main");
  assert.equal(row["formula.twice"], "60");
});

// ── 3. counting: diamond dependencies, one evaluation per formula per row ───

test("counting: a diamond (a->b,c; b,c->d) evaluates each formula once per row", () => {
  const raw = baseDocument(
    {
      d: "file.asLink(n * 2)",
      b: "file.asLink(formula.d + b0)",
      c: "file.asLink(formula.d + c0)",
      a: "file.asLink(formula.b + formula.c + a0)",
    },
    ["file.path", "formula.a"],
  );
  // Each marker key is read by exactly one formula, so its descriptor count is
  // that formula's evaluation count. Without memoization `d` would be evaluated
  // once per dependent (b and c) and the counter would read d=n*2 per row.
  const totals = { n: 0, b0: 0, c0: 0, a0: 0 };
  const records = [1, 2, 3, 4, 5].map((index) => {
    const { proxy, counts } = countingFrontmatter({ n: index, b0: 1, c0: 1, a0: 1 });
    return {
      path: `Notes/Diamond${index}.md`,
      basename: `Diamond${index}`,
      frontmatter: proxy,
      tags: [],
      links: [],
      stat: RECORD_STAT,
      counts,
    };
  });
  // `textQuery` makes the pipeline project every row twice (search pass +
  // projection); the record-keyed memo keeps it at one evaluation per formula.
  const snapshot = queryBaseSnapshot({ raw, records, textQuery: "Diamond" });
  assert.deepEqual(snapshot.rows.map((row) => row.values["formula.a"].displayName), ["7", "11", "15", "19", "23"]);
  for (const record of records) {
    // 2 descriptors per evaluation (Object.hasOwn + getOwnPropertyDescriptor).
    for (const key of Object.keys(totals)) totals[key] += (record.counts.get(key) ?? 0) / 2;
  }
  assert.deepEqual(totals, { n: 5, b0: 5, c0: 5, a0: 5 }, "exactly one evaluation per formula per row");
});

// ── 4. cycle completeness (compile time, fail closed) ──────────────────────

test("cycle: self / 2-node / 3-node / dead-branch all fail closed at compile time", () => {
  const cases = [
    ["self", { a: "file.asLink(formula.a)" }, /cycle detected: a -> a/],
    ["2-node", { a: "file.asLink(formula.b)", b: "file.asLink(formula.a)" }, /cycle detected: a -> b -> a/],
    ["3-node", { a: "file.asLink(formula.b)", b: "file.asLink(formula.c)", c: "file.asLink(formula.a)" }, /cycle detected: a -> b -> c -> a/],
    // `used` is the only projected formula; the cycle lives in formulas that no
    // view and no other formula uses.
    ["dead branch", { used: "file.asLink(1 + 1)", orphan1: "file.asLink(formula.orphan2)", orphan2: "file.asLink(formula.orphan1)" }, /cycle detected: orphan1 -> orphan2 -> orphan1/],
  ];
  for (const [name, formulas, pattern] of cases) {
    // Module level: the compile step itself must reject it.
    assert.throws(() => compileBaseFormulas(formulas), (error) =>
      error instanceof BaseFormulaError && error.code === "unsupported" && pattern.test(error.message), `${name}: compile`);
    // Canonical pipeline: an empty record set must not hide the cycle.
    const error = snapshotError(baseDocument(formulas, ["file.path", "formula.used"]), []);
    assert.ok(error instanceof BaseQueryError, `${name}: must fail closed`);
    assert.equal(error.code, "unsupported", `${name}: canonical code`);
    assert.match(error.message, pattern, `${name}: cycle message`);
  }
});

test("missing formula: an undeclared formula.<name> reference fails closed at compile time", () => {
  assert.throws(() => compileBaseFormulas({ a: "file.asLink(formula.absent)" }), (error) =>
    error instanceof BaseFormulaError
    && error.code === "unsupported"
    && error.message === 'Base formula "a" references undeclared formula "absent"');
  const error = snapshotError(baseDocument({ used: "file.asLink(formula.absent)" }, ["file.path", "formula.used"]), []);
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /references undeclared formula "absent"/);
});

// ── 5. error propagation ───────────────────────────────────────────────────

test("propagation: a failing dependency poisons its dependents and keeps the root cause", () => {
  const compiled = compileBaseFormulas({ a: "file.asLink(formula.b + 1)", b: 'file.asLink("5" + 3)' });
  const { proxy, counts } = countingFrontmatter({});
  const record = { path: "Notes/A.md", basename: "A", frontmatter: proxy, tags: [], links: [], stat: RECORD_STAT };
  const error = (() => { try { evaluateBaseFormula(compiled.a, record); } catch (thrown) { return thrown; } return null; })();
  assert.ok(error instanceof BaseFormulaError, "the dependent must throw");
  assert.equal(error.code, "unsupported");
  assert.equal(error.message, 'Base formula "a" was not evaluated because dependency formulas failed: b');
  assert.equal(error.causes.length, 1);
  assert.equal(error.causes[0].code, "formula_evaluation_failed");
  assert.equal(error.causes[0].formula, "b");
  assert.match(error.causes[0].message, /Operator "\+" requires two numbers or two strings but found string and number/);
  assert.equal(error.causes[0].causes.length, 0, "the root cause is b");
  // The dependent's own body never ran (W1-B contract: the closure is not called).
  assert.equal(error.expressionCode, null);
  assert.equal(counts.size, 0, "formula a was not evaluated at all");
});

test("propagation: multiple failing dependencies are chained in declaration order", () => {
  const compiled = compileBaseFormulas({
    a: "file.asLink(formula.b + formula.c)",
    b: 'file.asLink("5" + 3)',
    c: 'file.asLink("5" * 3)',
  });
  const record = { path: "Notes/A.md", basename: "A", frontmatter: {}, tags: [], links: [], stat: RECORD_STAT };
  const error = (() => { try { evaluateBaseFormula(compiled.a, record); } catch (thrown) { return thrown; } return null; })();
  assert.equal(error.code, "unsupported");
  assert.deepEqual(error.causes.map((cause) => cause.formula), ["b", "c"], "dependencies in declaration order");
  assert.match(error.causes[0].message, /string and number/);
  assert.match(error.causes[1].message, /string and number/);
});

test("propagation: a five-formula chain nests causes down to the failing root", () => {
  const compiled = compileBaseFormulas({
    a: "file.asLink(formula.b + 1)",
    b: "file.asLink(formula.c + 1)",
    c: "file.asLink(formula.d + 1)",
    d: "file.asLink(formula.e + 1)",
    e: 'file.asLink("5" + 3)',
  });
  const record = { path: "Notes/A.md", basename: "A", frontmatter: {}, tags: [], links: [], stat: RECORD_STAT };
  const error = (() => { try { evaluateBaseFormula(compiled.a, record); } catch (thrown) { return thrown; } return null; })();
  assert.equal(error.code, "unsupported");
  const chain = [];
  for (let current = error; current; current = current.causes?.[0]) {
    chain.push(current.formula ?? "a");
  }
  assert.deepEqual(chain, ["a", "b", "c", "d", "e"], "one causes hop per formula in the chain");
  assert.match(error.message, /dependency formulas failed/);
  const root = error.causes[0].causes[0].causes[0].causes[0];
  assert.equal(root.formula, "e", "the deepest cause is the failing root");
  assert.match(root.message, /Operator "\+" requires two numbers or two strings but found string and number/);
  assert.equal(root.causes.length, 0);
});

test("MCP query_base: a dependency failure is an unsupported error with the verbatim message", async () => {
  await fs.writeFile(
    path.join(vault, "Dependency.base"),
    baseDocument({ a: "file.asLink(formula.b + 1)", b: 'file.asLink("5" + 3)' }, ["file.path", "formula.a"]),
    "utf8",
  );
  await fs.writeFile(path.join(vault, "Note.md"), "---\ntitle: Alpha\n---\n# Alpha\n", "utf8");

  const { registerWorkflowTools } = await import("../src/tools/workflows.js");
  const server = new McpServer({ name: "bases-int-b-test", version: "1" });
  registerWorkflowTools(server);
  const client = new Client({ name: "bases-int-b-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "query_base", arguments: { path: "Dependency.base" } });
    assert.equal(result.isError, true, "a dependency failure must fail closed");
    assert.match(result.content[0].text, /was not evaluated because dependency formulas failed: b/);
    // Service level: the canonical code is `unsupported` for the same input.
    assert.equal(snapshotError(baseDocument({ a: "file.asLink(formula.b + 1)", b: 'file.asLink("5" + 3)' })).code, "unsupported");
  } finally {
    await client.close();
    await server.close();
  }
});

// ── 6. INT-C: filters / sort wired, groupBy deliberately unwired ───────────

test("INT-C: formula.* in filters / sort is typed, formula.* in groupBy still fails closed", () => {
  const formulas = { x: "file.asLink(1 + 1)" };
  // Was: `formula.*` in filters was rejected by the blanket INT-B guard.
  const filterRaw = `filters: formula.x > 0\n${baseDocument(formulas, ["file.path", "formula.x"])}`;
  assert.equal(snapshotError(filterRaw), null);
  assert.equal(queryBaseSnapshot({ raw: filterRaw, records: RECORDS }).rows.length, RECORDS.length);

  // Was: `formula.*` in view.sort was rejected by the same guard.
  const sortRaw = baseDocument(formulas, ["file.path", "formula.x"]).replace(
    "    order:",
    "    sort:\n      - property: formula.x\n        direction: ASC\n    order:",
  );
  assert.equal(snapshotError(sortRaw), null);

  // Unchanged: grouping is P1-D, so a formula groupBy still fails closed.
  const groupRaw = baseDocument(formulas, ["file.path", "formula.x"]).replace(
    "    order:",
    "    groupBy: formula.x\n    order:",
  );
  const groupError = snapshotError(groupRaw);
  assert.equal(groupError.code, "unsupported");
  assert.match(groupError.message, /groupBy/);
});
