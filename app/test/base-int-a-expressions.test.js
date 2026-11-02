// Bases P1 / INT-A — positive end-to-end coverage for the newly wired P1-A
// expression capabilities (follow-up to `review-verdict-P0-FLIP.md`).
//
// The flipped P0-restriction cases live in `bases-link-formula.test.js` /
// `base-query.test.js`; this file carries the *new* capability matrix through
// the real canonical pipeline (`queryBaseSnapshot`) and the real MCP
// `query_base` tool:
//   note.<prop> references · literals (number / string / boolean / null) ·
//   arithmetic · comparison · logical operators · type-mismatch error class ·
//   the frozen depth-20/21 boundary.
//
// Self-contained: it injects its own records and writes its own scratch vault.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-bases-int-a-expr-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const { BaseQueryError, queryBaseSnapshot } = await import("../src/base-query.js");
const { BaseFormulaError, compileBaseFormulas, evaluateBaseFormula } = await import("../src/base-formulas.js");
const { registerWorkflowTools } = await import("../src/tools/workflows.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const STAT = { size: 0, created: "2026-01-01T00:00:00Z", modified: "2026-02-01T00:00:00Z" };
const RECORDS = [
  {
    path: "Notes/Full.md",
    basename: "Full",
    frontmatter: { title: "Alpha Title", status: "active", price: 3, age: 4 },
    tags: [],
    links: [],
    stat: STAT,
  },
  {
    path: "Notes/Blank.md",
    basename: "Blank",
    frontmatter: { status: "archived" },
    tags: [],
    links: [],
    stat: STAT,
  },
];

function baseDocument(formulas) {
  const order = ["file.path", ...Object.keys(formulas).map((name) => `formula.${name}`)];
  return `${[
    "formulas:",
    ...Object.entries(formulas).map(([name, source]) => `  ${name}: '${source}'`),
    "views:",
    "  - type: table",
    "    name: Main",
    "    order:",
    ...order.map((key) => `      - ${key}`),
  ].join("\n")}\n`;
}

// `formula.<name>` cells are structured `{ path, displayName, kind }` objects.
function displays(raw, records = RECORDS) {
  return queryBaseSnapshot({ raw, records }).rows.map((row) => Object.fromEntries(
    Object.entries(row.values).map(([key, value]) => [key, value && typeof value === "object" ? value.displayName : value]),
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

test("INT-A: note.<prop> and bare references resolve to the same real value", () => {
  const raw = baseDocument({ explicit: "file.asLink(note.title)", bare: "file.asLink(title)" });
  const [full, blank] = displays(raw);
  assert.equal(full["formula.explicit"], "Alpha Title");
  assert.equal(full["formula.bare"], "Alpha Title");
  // Frozen missing-value behaviour: no title -> basename fallback, never the raw source.
  assert.equal(blank["formula.explicit"], "Blank");
  assert.equal(blank["formula.bare"], "Blank");
});

test("INT-A: literals (number / string / boolean / null) evaluate end to end", () => {
  const raw = baseDocument({
    num: "file.asLink(42)",
    str: 'file.asLink("x")',
    bool: "file.asLink(true)",
    nil: "file.asLink(null)",
    decimal: "file.asLink(1.5)",
  });
  const [row] = displays(raw);
  assert.equal(row["formula.num"], "42");
  assert.equal(row["formula.str"], "x");
  assert.equal(row["formula.bool"], "true");
  assert.equal(row["formula.decimal"], "1.5");
  // A null literal is an empty value, so the cell keeps the P0 basename fallback.
  assert.equal(row["formula.nil"], "Full");
});

test("INT-A: literal types are really typed (probes distinguish boolean/number/string/null)", () => {
  const raw = baseDocument({
    // A string "true" would equal the string "true"; a boolean literal does not.
    boolProbe: 'file.asLink(true == "true")',
    // A number literal plus a string literal is a type-mismatch, a typed probe is not.
    numProbe: "file.asLink(42 == 42)",
    strNum: 'file.asLink("1" + "2")',
    numSum: "file.asLink(1 + 2)",
    nullIsMissing: "file.asLink(null == missing_property)",
    nullIsNotNull: 'file.asLink(null == "")',
  });
  const [row] = displays(raw);
  assert.equal(row["formula.boolProbe"], "false");
  assert.equal(row["formula.numProbe"], "true");
  assert.equal(row["formula.strNum"], "12");
  assert.equal(row["formula.numSum"], "3");
  assert.equal(row["formula.nullIsMissing"], "true");
  assert.equal(row["formula.nullIsNotNull"], "false");
});

test("INT-A: arithmetic, comparison and logical operators evaluate end to end", () => {
  const raw = baseDocument({
    sum: "file.asLink(1 + 2)",
    product: "file.asLink(3 * 4)",
    difference: "file.asLink(7 - 2)",
    quotient: "file.asLink(8 / 2)",
    remainder: "file.asLink(7 % 4)",
    precedence: "file.asLink(1 + 2 * 3)",
    grouped: "file.asLink((1 + 2) * 3)",
    gt: "file.asLink(5 > 3)",
    eq: "file.asLink(1 == 1)",
    ne: 'file.asLink("a" != "b")',
    and: "file.asLink(true && false)",
    or: "file.asLink(true || false)",
    not: "file.asLink(!true)",
  });
  const [row] = displays(raw);
  assert.equal(row["formula.sum"], "3");
  assert.equal(row["formula.product"], "12");
  assert.equal(row["formula.difference"], "5");
  assert.equal(row["formula.quotient"], "4");
  assert.equal(row["formula.remainder"], "3");
  assert.equal(row["formula.precedence"], "7");
  assert.equal(row["formula.grouped"], "9");
  assert.equal(row["formula.gt"], "true");
  assert.equal(row["formula.eq"], "true");
  assert.equal(row["formula.ne"], "true");
  assert.equal(row["formula.and"], "false");
  assert.equal(row["formula.or"], "true");
  assert.equal(row["formula.not"], "false");
});

test("INT-A: a cross-type operator reports unsupported and keeps the P1-A message", () => {
  const raw = baseDocument({ bad: 'file.asLink("5" + 3)' });
  const error = snapshotError(raw);
  assert.ok(error instanceof BaseQueryError, "type-mismatch must fail closed");
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /Operator "\+" requires two numbers or two strings but found string and number/);
  assert.match(error.message, /type-mismatch/);
  // The formula layer keeps the original P1-A code separate from the mapped one.
  const compiled = compileBaseFormulas({ bad: 'file.asLink("5" + 3)' });
  let formulaError = null;
  try {
    evaluateBaseFormula(compiled.bad, RECORDS[0]);
  } catch (failure) {
    formulaError = failure;
  }
  assert.ok(formulaError instanceof BaseFormulaError);
  assert.equal(formulaError.code, "unsupported");
  assert.equal(formulaError.expressionCode, "type-mismatch");
});

test("INT-A: the frozen depth boundary is 20 pass / 21 unsupported", () => {
  const nested = (count) => {
    let expression = "file.name";
    for (let index = 0; index < count; index += 1) expression = `if(title, ${expression}, file.name)`;
    return `file.asLink(${expression})`;
  };
  assert.equal(queryBaseSnapshot({ raw: baseDocument({ deep: nested(20) }), records: RECORDS }).rows[0].values["formula.deep"].displayName, "Full");
  const error = snapshotError(baseDocument({ deep: nested(21) }));
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /nesting|depth/i);
});

test("INT-A: the same capabilities are reachable through the MCP query_base tool", async () => {
  await fs.writeFile(
    path.join(vault, "IntA.base"),
    baseDocument({
      title: "file.asLink(note.title)",
      const_num: "file.asLink(42)",
      const_true: "file.asLink(true)",
      const_str: 'file.asLink("x")',
      sum: "file.asLink(1 + 2)",
      product: "file.asLink(3 * 4)",
      gt: "file.asLink(5 > 3)",
      and: "file.asLink(true && false)",
      not: "file.asLink(!true)",
    }),
    "utf8",
  );
  await fs.writeFile(path.join(vault, "TypeMismatch.base"), baseDocument({ bad: 'file.asLink("5" + 3)' }), "utf8");
  await fs.writeFile(path.join(vault, "Note.md"), "---\ntitle: Alpha Title\n---\n# Alpha\n", "utf8");

  const server = new McpServer({ name: "bases-int-a-expressions", version: "1" });
  registerWorkflowTools(server);
  const client = new Client({ name: "bases-int-a-expressions-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "query_base", arguments: { path: "IntA.base" } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const values = result.structuredContent.rows[0].values;
    assert.equal(values["formula.title"].displayName, "Alpha Title");
    assert.equal(values["formula.const_num"].displayName, "42");
    assert.equal(values["formula.const_true"].displayName, "true");
    assert.equal(values["formula.const_str"].displayName, "x");
    assert.equal(values["formula.sum"].displayName, "3");
    assert.equal(values["formula.product"].displayName, "12");
    assert.equal(values["formula.gt"].displayName, "true");
    assert.equal(values["formula.and"].displayName, "false");
    assert.equal(values["formula.not"].displayName, "false");

    const mismatch = await client.callTool({ name: "query_base", arguments: { path: "TypeMismatch.base" } });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content[0].text, /requires two numbers or two strings/);
    assert.match(mismatch.content[0].text, /type-mismatch/);
  } finally {
    await client.close();
    await server.close();
  }
});
