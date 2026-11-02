// Bases P1 / INT-A — end-to-end tests for the canonical formula wiring.
//
// Scope of this file:
//   1. P0 parity for the `file.asLink(...)` family that must not drift
//      (module level + a real Base query with injected records);
//   2. the newly wired P1-A capabilities (literals, `note.<prop>`, parentheses,
//      arithmetic / comparison / logical operators) through the REAL canonical
//      pipeline (`queryBaseSnapshot`) and the REAL MCP `query_base` tool;
//   3. the frozen error-code mapping (`syntax` / `unsupported` / `type-mismatch`
//      / `limit`) including the MCP-visible `unsupported` result;
//   4. deliberately NOT wired capabilities: every one must fail closed with an
//      explicit error, never a silent `undefined`;
//   5. per-row evaluation counting evidence (one evaluation per formula per row).
//
// The file is self-contained: it injects its own records and writes its own
// scratch vault, so it never touches the real vault or another lane's fixtures.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-bases-int-a-"));
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
const { BaseFormulaError, compileBaseFormulas, evaluateBaseFormula, isFormulaTruthy } = await import("../src/base-formulas.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function baseDocument(formulas, order = ["file.path", ...Object.keys(formulas).map((name) => `formula.${name}`)]) {
  const lines = ["formulas:"];
  for (const [name, source] of Object.entries(formulas)) lines.push(`  ${name}: '${source}'`);
  lines.push("views:", "  - type: table", "    name: Main", "    order:");
  for (const key of order) lines.push(`      - ${key}`);
  return `${lines.join("\n")}\n`;
}

const RECORD_STAT = { size: 0, created: "2026-01-01T00:00:00Z", modified: "2026-02-01T00:00:00Z" };

const RECORDS = [
  {
    path: "Notes/Note.md",
    basename: "Note",
    frontmatter: { title: "Alpha", status: "active", price: 3, age: 4, flag: true },
    tags: [],
    links: [],
    stat: RECORD_STAT,
  },
  {
    path: "Notes/Empty.md",
    basename: "Empty",
    frontmatter: { title: "", status: "archived", price: 0, age: 8 },
    tags: [],
    links: [],
    stat: RECORD_STAT,
  },
];

function displayNames(raw, records = RECORDS, viewName = "Main") {
  const snapshot = queryBaseSnapshot({ raw, records, viewName });
  return snapshot.rows.map((row) => row.values);
}

// Same query, flattened to the display name of every formula column (the raw
// cell is the structured `{ path, displayName, kind }` object).
function displays(raw, records = RECORDS, viewName = "Main") {
  return displayNames(raw, records, viewName).map((values) => Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value && typeof value === "object" ? value.displayName : value]),
  ));
}

function snapshotError(raw, records = RECORDS) {
  try {
    queryBaseSnapshot({ raw, records });
  } catch (error) {
    return error;
  }
  return null;
}

// Counts own-property reads without ever executing an accessor: a Proxy trap
// runs instead of the getter, so instrumentation cannot change the semantics.
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

// ── 1. P0 parity: the `file.asLink(...)` family must not drift ──────────────

test("P0 parity: the file.asLink family keeps its exact cells and fallbacks", () => {
  const compiled = compileBaseFormulas({
    note: "file.asLink(if(title, title, file.name))",
    name: "file.asLink(file.name)",
    property: "file.asLink(title)",
    nested: "file.asLink(if(title, title, if(status, status, file.name)))",
  });
  const cell = (ast, frontmatter) => evaluateBaseFormula(ast, { path: "Folder/Note.md", basename: "Note", frontmatter });
  const cases = [
    [{ title: "Display" }, "Display"],
    [{}, "Note"],
    [{ title: "" }, "Note"],
    [{ title: "   " }, "Note"],
    [{ title: 2026 }, "2026"],
    [{ title: true }, "true"],
    [{ title: ["One", "Two"] }, "One, Two"],
    [{ title: { nested: true } }, "Note"],
    [{ title: null }, "Note"],
    [{ title: Number.NaN }, "Note"],
  ];
  for (const [frontmatter, expected] of cases) {
    const expectedCell = { path: "Folder/Note.md", displayName: expected, kind: "asLink" };
    // `note.<prop>` is the explicit form of the same bare property: A-INT wires
    // both to the identical value and display rule.
    assert.deepEqual(cell(compiled.note, frontmatter), expectedCell, `note with ${JSON.stringify(frontmatter)}`);
    assert.deepEqual(cell(compiled.property, frontmatter), expectedCell, `property with ${JSON.stringify(frontmatter)}`);
    assert.deepEqual(cell(compiled.name, frontmatter), { path: "Folder/Note.md", displayName: "Note", kind: "asLink" });
  }
  assert.equal(cell(compiled.nested, { title: "T", status: "S" }).displayName, "T");
  assert.equal(cell(compiled.nested, { status: "S" }).displayName, "S");
  assert.equal(cell(compiled.nested, {}).displayName, "Note");
});

test("P0 parity: a real Base query keeps rows, columns and init cells unchanged", () => {
  const raw = baseDocument(
    {
      note: "file.asLink(if(title, title, file.name))",
      label: "file.asLink(file.name)",
    },
    ["file.path", "title", "formula.note", "formula.label"],
  );
  const [first, second] = displayNames(raw);
  assert.deepEqual(Object.keys(first), ["file.path", "title", "formula.note", "formula.label"]);
  assert.equal(first["file.path"], "Notes/Note.md");
  assert.equal(first.title, "Alpha");
  assert.deepEqual(first["formula.note"], { path: "Notes/Note.md", displayName: "Alpha", kind: "asLink" });
  assert.deepEqual(first["formula.label"], { path: "Notes/Note.md", displayName: "Note", kind: "asLink" });
  assert.deepEqual(second["formula.note"], { path: "Notes/Empty.md", displayName: "Empty", kind: "asLink" });
  assert.deepEqual(second["formula.label"], { path: "Notes/Empty.md", displayName: "Empty", kind: "asLink" });
});

test("P0 parity: formula evaluation still never invokes an accessor", () => {
  const frontmatter = {};
  Object.defineProperty(frontmatter, "title", { enumerable: true, get() { throw new Error("accessor must not run"); } });
  const compiled = compileBaseFormulas({ n: "file.asLink(note.title)", p: "file.asLink(if(title, title, file.name))" });
  const record = { path: "F/G.md", basename: "G", frontmatter };
  assert.equal(evaluateBaseFormula(compiled.n, record).displayName, "G");
  assert.equal(evaluateBaseFormula(compiled.p, record).displayName, "G");
  const inherited = Object.create({ title: "prototype" });
  const inheritedRecord = { path: "F/I.md", basename: "I", frontmatter: inherited };
  assert.equal(evaluateBaseFormula(compiled.p, inheritedRecord).displayName, "I");
});

// ── 2. Newly wired P1-A capabilities, end to end ────────────────────────────

test("wired: literals (number / string / boolean / null) evaluate end to end", () => {
  const raw = baseDocument({
    n: "file.asLink(2)",
    s: 'file.asLink("text")',
    b: "file.asLink(true)",
    f: "file.asLink(false)",
    z: "file.asLink(null)",
  });
  const [row] = displays(raw);
  assert.equal(row["formula.n"], "2");
  assert.equal(row["formula.s"], "text");
  assert.equal(row["formula.b"], "true");
  assert.equal(row["formula.f"], "false");
  // An empty value (null literal) falls back to the note basename, exactly like
  // a missing property: the P0 fallback rule is not weakened by literals.
  assert.equal(row["formula.z"], "Note");
});

test("wired: note.<prop>, bare property, parentheses and operators evaluate end to end", () => {
  const raw = baseDocument({
    ns: "file.asLink(note.title)",
    bare: "file.asLink(title)",
    parens: "file.asLink((price + age))",
    precedence: "file.asLink(price + age * 2)",
    add: "file.asLink(price + age)",
    sub: "file.asLink(price - age)",
    mul: "file.asLink(price * age)",
    div: "file.asLink(age / price)",
    mod: "file.asLink(age % price)",
    concat: 'file.asLink(title + "!")',
    eq: 'file.asLink(status == "active")',
    ne: 'file.asLink(status != "active")',
    gt: "file.asLink(age > price)",
    lte: "file.asLink(price <= age)",
    and: "file.asLink(price > 0 && age > 0)",
    or: "file.asLink(flag || price > 0)",
    not: "file.asLink(!flag)",
  });
  const [active, archived] = displays(raw);
  assert.equal(active["formula.ns"], "Alpha");
  assert.equal(active["formula.bare"], "Alpha");
  assert.equal(active["formula.parens"], "7");
  assert.equal(active["formula.precedence"], "11");
  assert.equal(active["formula.add"], "7");
  assert.equal(active["formula.sub"], "-1");
  assert.equal(active["formula.mul"], "12");
  assert.equal(active["formula.div"], "1.3333333333333333");
  assert.equal(active["formula.mod"], "1");
  assert.equal(active["formula.concat"], "Alpha!");
  assert.equal(active["formula.eq"], "true");
  assert.equal(active["formula.ne"], "false");
  assert.equal(active["formula.gt"], "true");
  assert.equal(active["formula.lte"], "true");
  assert.equal(active["formula.and"], "true");
  assert.equal(active["formula.or"], "true");
  assert.equal(active["formula.not"], "false");
  // Same formulas, second record: typed comparison stays typed (no coercion).
  assert.equal(archived["formula.eq"], "false");
  assert.equal(archived["formula.gt"], "true");
  // price = 0 on the second record: `age % price` is a non-finite result and
  // becomes a missing value (B6#3), so the P0 basename fallback applies.
  assert.equal(archived["formula.mod"], "Empty");
});

test("wired: 1/0 is a missing value, not Infinity (P1-A B6#3 semantics)", () => {
  const raw = baseDocument({ div: "file.asLink(1 / 0)" });
  const [row] = displays(raw);
  assert.equal(row["formula.div"], "Note");
});

test("wired: depth 20 passes and depth 21 fails closed as unsupported", () => {
  const nest = (count) => {
    let expression = "file.name";
    for (let index = 0; index < count; index += 1) expression = `if(title, ${expression}, file.name)`;
    return `file.asLink(${expression})`;
  };
  const ok = queryBaseSnapshot({ raw: baseDocument({ deep: nest(20) }), records: RECORDS });
  assert.equal(ok.rows[0].values["formula.deep"].displayName, "Note");
  const error = snapshotError(baseDocument({ deep: nest(21) }));
  assert.ok(error instanceof BaseQueryError, "depth 21 must fail closed");
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /nesting|depth/i);
});

// ── 3. Error-code mapping (frozen table) ────────────────────────────────────

test("mapping: P1-A codes are mapped and the original message is preserved", () => {
  const cases = [
    // [source, expected mapped code, expected original P1-A code, message fragment]
    ["file.asLink(price +)", "syntax", "syntax", /Expected an expression/],
    ["file.asLink(now())", "unsupported", "unsupported", /Unsupported function "now"/],
    ["file.asLink(1 +)", "syntax", "syntax", /Expected an expression/],
  ];
  for (const [source, code, expressionCode, pattern] of cases) {
    let failure = null;
    try {
      compileBaseFormulas({ x: source });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof BaseFormulaError, `${source} must fail closed`);
    assert.equal(failure.code, code, `${source}: mapped code`);
    assert.equal(failure.expressionCode, expressionCode, `${source}: original P1-A code`);
    assert.match(failure.message, pattern, `${source}: original message preserved`);
  }

  // type-mismatch and limit are value/grammar-level and are only observable at
  // evaluation time (`limit` is raised by the parser, so it fails at compile).
  let limited = null;
  let nested = "file.name";
  for (let index = 0; index < 21; index += 1) nested = `if(title, ${nested}, file.name)`;
  try {
    compileBaseFormulas({ x: `file.asLink(${nested})` });
  } catch (error) {
    limited = error;
  }
  assert.equal(limited.code, "unsupported", "limit maps to unsupported");
  assert.equal(limited.expressionCode, "limit", "the original limit code is kept");

  const compiled = compileBaseFormulas({ x: 'file.asLink("5" + price)' });
  let mismatch = null;
  try {
    evaluateBaseFormula(compiled.x, { path: "A.md", basename: "A", frontmatter: { price: 3 } });
  } catch (error) {
    mismatch = error;
  }
  assert.equal(mismatch.code, "unsupported", "type-mismatch maps to unsupported");
  assert.equal(mismatch.expressionCode, "type-mismatch", "the original type-mismatch code is kept");
  assert.match(mismatch.message, /Operator "\+" requires two numbers or two strings but found string and number/);
});

test("mapping: the canonical pipeline reports unsupported for every formula failure", () => {
  // BaseQueryError keeps its frozen four-code vocabulary; a formula failure of
  // any P1-A family is reported as `unsupported` (same as P0 did for malformed
  // formulas), which is what app/test/base-query.test.js pins.
  const cases = [
    ['file.asLink("5" + price)', /requires two numbers or two strings/],
    ["file.asLink(price +)", /Expected an expression/],
    ["file.asLink(now())", /Unsupported function/],
  ];
  for (const [source, pattern] of cases) {
    const error = snapshotError(baseDocument({ x: source }));
    assert.ok(error instanceof BaseQueryError, `${source} must fail closed`);
    assert.equal(error.code, "unsupported", `${source}: canonical code`);
    assert.match(error.message, pattern, `${source}: canonical message keeps the P1-A text`);
  }
});

// ── 4. Deliberately not wired: explicit unsupported, never undefined ────────

test("not wired: other file.<prop>, functions, literals and syntax fail closed", () => {
  const cases = [
    ["file property", "file.asLink(file.size)", /unsupported file property "file\.size"/],
    ["unknown function", 'file.asLink(link("Alpha"))', /Unsupported function "link"/],
    ["method call", "file.asLink((price / age).toFixed(2))", /Unsupported member access "toFixed"/],
    ["regex literal", "file.asLink(price.matches(/x/))", /Unsupported function "price\.matches"/],
    ["list literal", "file.asLink([1, 2])", /Unsupported expression syntax/],
    ["object literal", "file.asLink({ a: 1 })", /Unsupported expression syntax/],
    ["this namespace", "file.asLink(this.file.name)", /Unsupported expression namespace "this"/],
    ["date arithmetic", 'file.asLink(price + "1d")', /requires two numbers or two strings/],
    ["two-argument if", "file.asLink(if(title, title))", /Expected 3 arguments for "if"/],
  ];
  for (const [name, source, pattern] of cases) {
    const error = snapshotError(baseDocument({ x: source }));
    assert.ok(error instanceof BaseQueryError, `${name} must fail closed (never undefined)`);
    assert.equal(error.code, "unsupported", `${name}: code`);
    assert.match(error.message, pattern, `${name}: message names the unsupported construct`);
  }
});

test("not wired: unused formulas and dead branches are still fully validated", () => {
  // INT-B flipped the formula-reference half of this test: `formula.<name>` is
  // wired now, so an UNDECLARED reference is the remaining fail-closed case.
  assert.throws(
    () => compileBaseFormulas({ unused: "file.asLink(formula.other)", note: "file.asLink(title)" }),
    /references undeclared formula "other"/,
  );
  assert.throws(
    () => compileBaseFormulas({ note: "file.asLink(if(title, title, formula.other))" }),
    /references undeclared formula "other"/,
  );
  const empty = snapshotError(baseDocument({ note: "file.asLink(if(title, title, formula.other))" }), []);
  assert.ok(empty instanceof BaseQueryError, "an empty record set still validates the whole AST");
  assert.equal(empty.code, "unsupported");
  const error = snapshotError(baseDocument({ note: "file.asLink(if(title, title, formula.other))" }), RECORDS);
  assert.equal(error.code, "unsupported");
});

test("not wired: hostile formula names stay own keys and truthiness stays the P0 rule", () => {
  const compiled = compileBaseFormulas(JSON.parse('{"__proto__": "file.asLink(note.title)"}'));
  assert.equal(Object.getPrototypeOf(compiled), null);
  assert.equal(Object.hasOwn(compiled, "__proto__"), true);
  assert.equal({}.displayName, undefined);
  assert.equal(isFormulaTruthy(undefined), false);
  assert.equal(isFormulaTruthy({}), true);
  const raw = baseDocument(JSON.parse('{"__proto__": "file.asLink(note.title)"}'));
  const [row] = displays(raw, RECORDS, undefined);
  assert.equal(row["formula.__proto__"], "Alpha");
});

// ── 5. Per-row evaluation counting ──────────────────────────────────────────

test("counting: each formula evaluates its references once per row", () => {
  const raw = baseDocument({ n: "file.asLink(note.title)", p: "file.asLink(if(title, title, file.name))" });
  const first = countingFrontmatter({ title: "Alpha" });
  const second = countingFrontmatter({ title: "Beta" });
  const records = [
    { path: "Notes/A.md", basename: "A", frontmatter: first.proxy, tags: [], links: [], stat: RECORD_STAT },
    { path: "Notes/B.md", basename: "B", frontmatter: second.proxy, tags: [], links: [], stat: RECORD_STAT },
  ];
  const snapshot = queryBaseSnapshot({ raw, records });
  assert.deepEqual(snapshot.rows.map((row) => row.values["formula.n"].displayName), ["Alpha", "Beta"]);
  assert.deepEqual(snapshot.rows.map((row) => row.values["formula.p"].displayName), ["Alpha", "Beta"]);
  // `readOwnDataProperty` reads a key twice (hasOwn + getOwnPropertyDescriptor),
  // so one evaluation of `note.title` is exactly 2 recorded descriptors per row:
  // formula.n = 0 + 2, formula.p = (condition + consequent) = 2 + 4.
  assert.equal(first.counts.get("title"), 6, "row 1: one evaluation per formula reference");
  assert.equal(second.counts.get("title"), 6, "row 2: one evaluation per formula reference");
  assert.equal(first.counts.get("basename"), undefined, "inactive branch is not evaluated");
});

// ── 6. MCP level evidence ───────────────────────────────────────────────────

test("MCP query_base: wired formulas work and unwired/type-mismatched ones return unsupported", async () => {
  await fs.writeFile(
    path.join(vault, "Wired.base"),
    baseDocument(
      { n: "file.asLink(price + age)", s: 'file.asLink(title + "!")', m: "file.asLink(age % price)" },
      ["file.path", "formula.n", "formula.s", "formula.m"],
    ),
    "utf8",
  );
  await fs.writeFile(path.join(vault, "Mismatch.base"), baseDocument({ x: 'file.asLink("5" + price)' }, ["file.path", "formula.x"]), "utf8");
  await fs.writeFile(path.join(vault, "FormulaRef.base"), baseDocument({ x: "file.asLink(formula.other)" }, ["file.path", "formula.x"]), "utf8");
  await fs.writeFile(path.join(vault, "Note.md"), "---\ntitle: Alpha\nprice: 3\nage: 4\n---\n# Alpha\n", "utf8");

  const { registerWorkflowTools } = await import("../src/tools/workflows.js");
  const server = new McpServer({ name: "bases-int-a-test", version: "1" });
  registerWorkflowTools(server);
  const client = new Client({ name: "bases-int-a-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const wired = await client.callTool({ name: "query_base", arguments: { path: "Wired.base" } });
    assert.equal(wired.isError, undefined, JSON.stringify(wired.content));
    const values = wired.structuredContent.rows[0].values;
    assert.equal(values["formula.n"].displayName, "7");
    assert.equal(values["formula.s"].displayName, "Alpha!");
    assert.equal(values["formula.m"].displayName, "1");

    // Type-mismatch via MCP: the canonical error is `unsupported` and the
    // message carries the original P1-A text (MCP has no code field, so the
    // service-level code is asserted too, matching base-query.test.js parity).
    const mismatch = await client.callTool({ name: "query_base", arguments: { path: "Mismatch.base" } });
    assert.equal(mismatch.isError, true, "type-mismatch must fail closed");
    assert.match(mismatch.content[0].text, /Operator "\+" requires two numbers or two strings but found string and number/);
    assert.equal(snapshotError(baseDocument({ x: 'file.asLink("5" + price)' })).code, "unsupported");

    const unwired = await client.callTool({ name: "query_base", arguments: { path: "FormulaRef.base" } });
    assert.equal(unwired.isError, true, "an undeclared formula.<name> must fail closed");
    assert.match(unwired.content[0].text, /references undeclared formula "other"/);
  } finally {
    await client.close();
    await server.close();
  }
});

// ── 7. INT-B: formula.<name> dependencies are wired ─────────────────────────

describe("INT-B formula references", () => {
  test("a declared formula can feed another formula definition", () => {
    const compiled = compileBaseFormulas({
      base: "file.asLink(price * 2)",
      doubled: "file.asLink(formula.base + 1)",
      branch: "file.asLink(if(title, formula.base, formula.doubled))",
    });
    const record = { path: "Notes/Note.md", basename: "Note", frontmatter: { title: "Alpha", price: 3 } };
    const value = (name) => evaluateBaseFormula(compiled[name], record).displayName;
    assert.equal(value("base"), "6");
    assert.equal(value("doubled"), "7", "the dependency contributes its raw value, not the asLink cell");
    assert.equal(value("branch"), "6");
  });

  test("unused formulas and dead branches are dependency-validated too", () => {
    const compiled = compileBaseFormulas({
      unusedDep: "file.asLink(price + 1)",
      unused: "file.asLink(formula.unusedDep * 2)",
      note: "file.asLink(if(title, title, formula.unusedDep))",
    });
    const record = { path: "Notes/Note.md", basename: "Note", frontmatter: { price: 3 } };
    assert.equal(evaluateBaseFormula(compiled.note, record).displayName, "4", "dead branch still resolves its dependency");
    assert.equal(evaluateBaseFormula(compiled.unused, record).displayName, "8");
  });

  test("undeclared references and dependency cycles fail closed at compile time", () => {
    assert.throws(() => compileBaseFormulas({ a: "file.asLink(formula.absent)" }),
      /references undeclared formula "absent"/);
    assert.throws(() => compileBaseFormulas({ a: "file.asLink(formula.a)" }),
      /cycle detected: a -> a/);
    assert.throws(() => compileBaseFormulas({ a: "file.asLink(formula.b)", b: "file.asLink(formula.a)" }),
      /cycle detected: a -> b -> a/);
  });
});
