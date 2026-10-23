// P1-A: tokenizer / parser / typed AST for the portable Bases expression subset.
//
// The grammar corpus in `test/fixtures/bases-grammar/*.corpus.json` is the
// frozen, official-anchored contract (see `docs/bases/BASES-GRAMMAR-CORPUS.md`);
// this file drives it and adds the non-corpus invariants the reviewer requires:
// frozen error vocabulary, exact message templates, the exact 20/21 nesting
// boundary, bounded work on hostile input, leak-free errors, AST immutability
// and a no-dynamic-execution guard on the module source.
//
// Error codes are always asserted by exact value, never by a substring match.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AST_NODE_TYPES,
  BASE_EXPRESSION_ERROR_CODES,
  BASE_EXPRESSION_OPERATORS,
  BaseExpressionError,
  ERROR_CODE_LIMIT,
  ERROR_CODE_SYNTAX,
  ERROR_CODE_TYPE_MISMATCH,
  ERROR_CODE_UNSUPPORTED,
  EXPRESSION_FUNCTION_SIGNATURES,
  MAX_EXPRESSION_DEPTH,
  PROPERTY_NAMESPACES,
  parseBaseExpression,
  tokenizeBaseExpression,
} from "../src/base-expression.js";
import { SUPPORTED_VALUE_TYPES } from "../src/base-values.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, "fixtures", "bases-grammar");
const SOURCE_ROOT = path.join(HERE, "..", "src");

// Frozen corpus size. A removed/renamed case must be an explicit review event,
// not a silently smaller suite.
const CORPUS_CASE_COUNTS = Object.freeze({
  "01-literals.corpus.json": 19,
  "02-grouping-precedence.corpus.json": 22,
  "03-references.corpus.json": 15,
  "04-functions-arity.corpus.json": 22,
  "05-errors.corpus.json": 16,
  "06-depth.corpus.json": 9,
  "07-unsupported-official.corpus.json": 14,
});

const DISPOSITIONS = new Set(["permanent", "P1-C", "P1-B/INT-B", "P1-F"]);

// `{position}` in a corpus template matches only digits, `{token}` only any
// token text; everything else is compared literally, so a reworded message
// fails instead of silently still matching.
function templateToRegExp(template) {
  const pattern = template
    .split("{position}").join("\u0000POSITION\u0000")
    .split("{token}").join("\u0000TOKEN\u0000")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .split("\u0000POSITION\u0000").join("\\d+")
    .split("\u0000TOKEN\u0000").join(".+");
  return new RegExp(`^${pattern}$`);
}

function buildInput(entry) {
  if (Object.hasOwn(entry, "input")) return entry.input;
  const parens = entry.parenDepth ?? 0;
  const unaries = entry.unaryDepth ?? 0;
  return "(".repeat(parens) + "!".repeat(unaries) + "1" + ")".repeat(parens);
}

function parseOutcome(value) {
  try {
    return { ast: parseBaseExpression(value) };
  } catch (error) {
    return { error };
  }
}

async function loadCorpus() {
  const files = (await fs.readdir(FIXTURE_ROOT)).filter((name) => name.endsWith(".corpus.json")).sort();
  const corpora = [];
  for (const file of files) {
    corpora.push({ file, data: JSON.parse(await fs.readFile(path.join(FIXTURE_ROOT, file), "utf8")) });
  }
  return corpora;
}

test("corpus manifest is well formed, official-anchored and case-count frozen", async () => {
  const corpora = await loadCorpus();
  const seenIds = new Set();
  const expressionFiles = [];
  for (const { file, data } of corpora) {
    assert.equal(data.target === "base-expression" || data.target === "base-values", true, `${file}: unknown target`);
    assert.ok(typeof data.group === "string" && data.group.length > 0, `${file}: missing group`);
    assert.ok(typeof data.title === "string" && data.title.length > 0, `${file}: missing title`);
    assert.ok(Array.isArray(data.anchors) && data.anchors.length > 0, `${file}: must carry at least one anchor`);
    for (const anchor of data.anchors) {
      assert.ok(typeof anchor.source === "string" && anchor.source.length > 0, `${file}: anchor.source`);
      assert.ok(typeof anchor.locator === "string" && anchor.locator.length > 0, `${file}: anchor.locator`);
      assert.ok(typeof anchor.quote === "string" && anchor.quote.length > 0, `${file}: anchor.quote`);
      assert.ok(typeof anchor.url === "string" && anchor.url.length > 0, `${file}: anchor.url`);
      assert.ok(
        ["official-doc", "changelog", "project-contract", "design"].includes(anchor.kind),
        `${file}: unknown anchor kind ${anchor.kind}`,
      );
    }
    for (const entry of data.cases) {
      assert.ok(typeof entry.id === "string" && entry.id.length > 0, `${file}: case without id`);
      assert.equal(seenIds.has(entry.id), false, `${file}: duplicate case id ${entry.id}`);
      seenIds.add(entry.id);
      assert.ok(["accept", "reject"].includes(entry.outcome), `${file}:${entry.id}: bad outcome`);
      assert.ok(typeof entry.note === "string" && entry.note.length > 0, `${file}:${entry.id}: missing note`);
      if (entry.outcome === "accept") {
        if (data.target === "base-expression") {
          assert.ok(
            Object.hasOwn(entry, "ast") || Object.hasOwn(entry, "astType"),
            `${file}:${entry.id}: accept case needs ast or astType`,
          );
          if (entry.ast) assert.ok(AST_NODE_TYPES.includes(entry.ast.type), `${file}:${entry.id}: unknown ast type`);
        } else {
          assert.ok(entry.result && typeof entry.result.type === "string", `${file}:${entry.id}: accept case needs result.type`);
          assert.ok(SUPPORTED_VALUE_TYPES.includes(entry.result.type), `${file}:${entry.id}: unknown value type`);
        }
      } else {
        assert.ok(BASE_EXPRESSION_ERROR_CODES.includes(entry.code), `${file}:${entry.id}: unknown error code ${entry.code}`);
        assert.equal(typeof entry.messageTemplate, "string", `${file}:${entry.id}: reject case needs messageTemplate`);
        // A fail-closed `unsupported` case must declare where it belongs, so the
        // "official but unsupported" inventory can never drift silently.
        if (entry.code === ERROR_CODE_UNSUPPORTED) {
          assert.ok(DISPOSITIONS.has(entry.disposition), `${file}:${entry.id}: unsupported case needs a known disposition`);
        }
      }
    }
    if (data.target === "base-expression") expressionFiles.push(file);
  }
  assert.deepEqual(expressionFiles, Object.keys(CORPUS_CASE_COUNTS), "expression corpus file set changed");
  for (const [file, count] of Object.entries(CORPUS_CASE_COUNTS)) {
    const data = corpora.find((item) => item.file === file).data;
    assert.equal(data.cases.length, count, `${file}: case count changed`);
  }
});

test("grammar corpus: every case reproduces exactly (AST or {code, position, template})", async () => {
  const corpora = await loadCorpus();
  let accepted = 0;
  let rejected = 0;
  for (const { file, data } of corpora) {
    if (data.target !== "base-expression") continue;
    for (const entry of data.cases) {
      const label = `${file}:${entry.id}`;
      const input = buildInput(entry);
      const { ast, error } = parseOutcome(input);
      if (entry.outcome === "accept") {
        accepted += 1;
        assert.equal(error, undefined, `${label}: expected accept, got ${error?.code} ${error?.message}`);
        assert.ok(AST_NODE_TYPES.includes(ast.type), `${label}: ${ast.type} is not a frozen AST node type`);
        if (Object.hasOwn(entry, "astType")) assert.equal(ast.type, entry.astType, `${label}: root node type`);
        if (Object.hasOwn(entry, "ast")) assert.deepStrictEqual(ast, entry.ast, `${label}: AST mismatch`);
        continue;
      }
      rejected += 1;
      assert.equal(ast, undefined, `${label}: expected reject, got ${JSON.stringify(ast)}`);
      assert.ok(error instanceof BaseExpressionError, `${label}: not a BaseExpressionError`);
      assert.equal(error.code, entry.code, `${label}: code must match exactly`);
      if (Object.hasOwn(entry, "position")) assert.equal(error.position, entry.position, `${label}: position`);
      assert.match(error.message, templateToRegExp(entry.messageTemplate), `${label}: message template`);
    }
  }
  assert.equal(accepted + rejected, 117, "expression corpus coverage changed");
  assert.ok(rejected >= 40, "corpus must keep a substantial reject set");
});

// The 20/21 boundary, generated exhaustively instead of spot-checking. This is
// what makes "20 passes, 21 fails" a measured fact rather than a claim.
test("nesting depth: exactly 20 passes and 21 fails for parens, unary and call arguments", () => {
  const depthOf = (parens, unaries) => "(".repeat(parens) + "!".repeat(unaries) + "1" + ")".repeat(parens);
  for (let depth = 0; depth <= 30; depth += 1) {
    const { ast, error } = parseOutcome(depthOf(depth, 0));
    if (depth <= MAX_EXPRESSION_DEPTH) {
      assert.equal(error, undefined, `paren depth ${depth} must pass`);
      assert.equal(ast.type, "literal");
    } else {
      assert.equal(error?.code, ERROR_CODE_LIMIT, `paren depth ${depth} must fail with limit`);
    }
  }
  for (let depth = 0; depth <= 24; depth += 1) {
    const { error } = parseOutcome("!".repeat(depth) + "a");
    assert.equal(error?.code, depth <= MAX_EXPRESSION_DEPTH ? undefined : ERROR_CODE_LIMIT, `unary depth ${depth}`);
  }
  // Parenthesis layers and unary operands share one counter.
  for (const [parens, unaries, shouldPass] of [[10, 10, true], [10, 11, false], [20, 1, false], [1, 20, false]]) {
    const { error } = parseOutcome(depthOf(parens, unaries));
    assert.equal(error === undefined, shouldPass, `parens ${parens} + unary ${unaries}`);
  }
  // Call arguments are nested expressions and therefore add a level each.
  const nestedCall = (depth) => "if(a > 0, ".repeat(depth) + "1" + ", 0)".repeat(depth);
  const atLimit = parseOutcome(nestedCall(MAX_EXPRESSION_DEPTH));
  assert.equal(atLimit.error, undefined, "call nesting inside the limit must parse");
  assert.equal(parseOutcome(nestedCall(MAX_EXPRESSION_DEPTH + 1)).error?.code, ERROR_CODE_LIMIT, "call nesting over the limit must fail");
});

test("hostile and overlong input fails or completes with bounded, leak-free errors", () => {
  const deepParens = "(".repeat(5000) + "1" + ")".repeat(5000);
  const deepUnary = "!".repeat(5000) + "a";
  const wideChain = `${"1+".repeat(20000)}1`;
  const hugeString = `"${"a".repeat(200000)}"`;

  for (const [label, input] of [["deep parens", deepParens], ["deep unary", deepUnary]]) {
    const { error } = parseOutcome(input);
    assert.ok(error instanceof BaseExpressionError, `${label}: RangeError would mean the depth cap is not recursive-safe`);
    assert.equal(error.code, ERROR_CODE_LIMIT, `${label}: code`);
    assert.equal(error.stack.split("\n").length, 1, `${label}: stack must be a single template line`);
  }

  // Iterative productions must not blow the stack on a very wide expression.
  const wide = parseOutcome(wideChain);
  assert.equal(wide.error, undefined, "a 20000-term additive chain must parse");
  let spine = 0;
  for (let node = wide.ast; node.type === "binary"; node = node.left) spine += 1;
  assert.equal(spine, 20000, "left-associative spine length");

  const long = parseOutcome(hugeString);
  assert.equal(long.error, undefined, "a 200k-character string literal must parse");
  assert.equal(long.ast.value.length, 200000, "literal value length");
});

test("error messages are deterministic templates that vary only by token and position", () => {
  const cases = [
    ["1 @ 2", "1 # 2", /^Unexpected character "(.+)" at position \d+$/],
    ["1 2", "3 4", /^Unexpected token "(.+)" at position \d+; expected end of expression$/],
    ["(1 + 2", "(1 * 2", /^Expected "\)" but found .+ at position \d+$/],
    ['"a\\qb"', '"b\\zc"', /^Unsupported escape sequence ".+" at position \d+$/],
    ["bogus.prop", "other.field", /^Unsupported expression namespace "(.+)" at position \d+$/],
    ["now()", "today()", /^Unsupported function "(.+)" at position \d+$/],
    ["if(a)", "if(a, b, c, d)", /^Function "if" expects 2 to 3 arguments but found \d+ at position \d+$/],
    ["[1]", "{2}", /^Unsupported expression syntax ".+" at position \d+$/],
  ];
  for (const [first, second, pattern] of cases) {
    const left = parseOutcome(first).error;
    const right = parseOutcome(second).error;
    assert.match(left.message, pattern, `${first}: template`);
    assert.match(right.message, pattern, `${second}: same template`);
    // Same family ⇒ same template shape; only the captured token/position differ.
    const shape = (message) => message.replace(/\d+/g, "#");
    if (!pattern.source.includes("(.+)")) {
      assert.equal(shape(left.message).replace(/".+?"/g, '"X"'), shape(right.message).replace(/".+?"/g, '"X"'), `${first} vs ${second}`);
    }
  }
  // Exact messages for one representative of each family (no regex slack).
  assert.equal(parseOutcome("1 2").error.message, 'Unexpected token "2" at position 2; expected end of expression');
  assert.equal(parseOutcome("").error.message, "Expression is empty");
  assert.equal(parseOutcome(42).error.message, "Expression must be a string");
  assert.equal(parseOutcome("now()").error.message, 'Unsupported function "now" at position 0');
  assert.equal(parseOutcome("if(a)").error.message, 'Function "if" expects 2 to 3 arguments but found 1 at position 0');
  assert.equal(
    parseOutcome("(".repeat(MAX_EXPRESSION_DEPTH + 1) + "1" + ")".repeat(MAX_EXPRESSION_DEPTH + 1)).error.message,
    `Expression nesting exceeds the maximum depth of ${MAX_EXPRESSION_DEPTH} at position ${MAX_EXPRESSION_DEPTH}`,
  );
});

test("no error path leaks a stack frame, absolute path or host detail", () => {
  const hostile = [
    "",
    "1 +",
    "(1",
    '"abc',
    "1 @ 2",
    "bogus.prop",
    "this.file.folder",
    "now()",
    "/abc/",
    "(".repeat(500) + "1" + ")".repeat(500),
    "!".repeat(5000),
    "\u0000",
  ];
  for (const input of hostile) {
    const { error } = parseOutcome(input);
    assert.ok(error instanceof BaseExpressionError, JSON.stringify(input.slice(0, 20)));
    assert.equal(error.stack, `${error.name}: ${error.message}`);
    assert.equal(error.stack.split("\n").length, 1);
    assert.doesNotMatch(error.stack, /[A-Za-z]:[\\/]|file:\/\/|node:internal|\bat [\w$.]+ \(/);
    assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]|file:\/\/|node:internal/);
    assert.ok(!error.message.includes(HERE) && !error.message.includes(SOURCE_ROOT));
    assert.ok(!JSON.stringify(error).includes("stack"));
  }
});

test("frozen vocabulary: error codes, node types, operators, depth and signatures", () => {
  assert.deepEqual(BASE_EXPRESSION_ERROR_CODES, ["syntax", "unsupported", "type-mismatch", "limit"]);
  assert.equal(ERROR_CODE_SYNTAX, "syntax");
  assert.equal(ERROR_CODE_UNSUPPORTED, "unsupported");
  assert.equal(ERROR_CODE_TYPE_MISMATCH, "type-mismatch");
  assert.equal(ERROR_CODE_LIMIT, "limit");
  assert.equal(MAX_EXPRESSION_DEPTH, 20);
  assert.deepEqual(AST_NODE_TYPES, ["literal", "reference", "unary", "binary", "comparison", "logical", "call"]);
  assert.deepEqual(PROPERTY_NAMESPACES, ["note", "file", "formula"]);
  assert.deepEqual(EXPRESSION_FUNCTION_SIGNATURES, { if: { min: 2, max: 3 } });
  assert.deepEqual(BASE_EXPRESSION_OPERATORS.arithmetic, ["+", "-", "*", "/", "%"]);
  assert.deepEqual(BASE_EXPRESSION_OPERATORS.comparison, ["==", "!=", ">", "<", ">=", "<="]);
  assert.deepEqual(BASE_EXPRESSION_OPERATORS.logical, ["&&", "||"]);
  assert.deepEqual(BASE_EXPRESSION_OPERATORS.unary, ["-", "!"]);
  for (const value of [
    BASE_EXPRESSION_ERROR_CODES,
    AST_NODE_TYPES,
    PROPERTY_NAMESPACES,
    EXPRESSION_FUNCTION_SIGNATURES,
    EXPRESSION_FUNCTION_SIGNATURES.if,
    ...Object.values(BASE_EXPRESSION_OPERATORS),
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("AST is deeply frozen and tokenization is position-exact", () => {
  const ast = parseBaseExpression("if(a > 1, -b, \"x\")");
  assert.equal(Object.isFrozen(ast), true);
  assert.equal(Object.isFrozen(ast.args), true);
  assert.equal(Object.isFrozen(ast.args[0]), true);
  assert.equal(Object.isFrozen(ast.args[1].argument), true);
  assert.throws(() => {
    ast.args[0].operator = "<";
  }, TypeError);
  assert.throws(() => {
    ast.args[2].value = "y";
  }, TypeError);

  const tokens = tokenizeBaseExpression("file.name + 1");
  assert.deepEqual(
    tokens.map((token) => [token.kind, token.raw, token.start]),
    [
      ["identifier", "file", 0],
      ["punctuator", ".", 4],
      ["identifier", "name", 5],
      ["operator", "+", 10],
      ["number", "1", 12],
      ["eof", "", 13],
    ],
  );
  assert.equal(Object.isFrozen(tokens), true);
  assert.equal(Object.isFrozen(tokens[0]), true);
});

test("module source stays pure: no fs/path/express/MCP imports, no dynamic execution", async () => {
  const allowedSpecifiers = new Set(["./base-expression.js", "./base-formulas.js"]);
  for (const file of ["base-expression.js", "base-values.js"]) {
    const source = await fs.readFile(path.join(SOURCE_ROOT, file), "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(allowedSpecifiers.has(specifier), `${file}: unexpected import ${specifier}`);
      assert.ok(!specifier.startsWith("node:"), `${file}: no node: builtins`);
    }
    assert.doesNotMatch(source, /\beval\s*\(/, `${file}: eval`);
    assert.doesNotMatch(source, /new\s+Function\s*\(/, `${file}: Function constructor`);
    assert.doesNotMatch(source, /\bvm\.|child_process|createRequire/, `${file}: dynamic code module`);
    assert.doesNotMatch(source, /\bimport\s*\(/, `${file}: dynamic import`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${file}: require`);
  }
});
