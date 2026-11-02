// P1-A expression foundation: tokenizer, recursive-descent parser and typed AST
// for the portable subset of the Obsidian Bases expression language.
//
// Pure module by contract (§7): no fs / path / express / MCP imports, no
// eval / Function / vm / dynamic import, no process state, no clock, no I/O.
// Deterministic: the same source yields the same AST or the same error.
//
// Error vocabulary (exported constants; tests assert the exact code, never a
// substring): `syntax` (lexical/structural, including call arity),
// `unsupported` (official syntax this subset deliberately does not implement),
// `type-mismatch` (value-level; raised by base-values.js, which shares this
// enum) and `limit` (grammar-legal input above the frozen depth ceiling).
// Errors are leak-free: `stack` is rewritten to a single `Name: message` line,
// so no absolute path or host detail escapes through a logged error.
//
// AST (position-free so the grammar corpus is stable; deeply frozen):
//   { type: "literal",    valueType: "number"|"string"|"boolean"|"null", value }
//   { type: "reference",  namespace: "note"|"file"|"formula", name, explicit }
//   { type: "unary",      operator: "-"|"!", argument }
//   { type: "binary",     operator: "+"|"-"|"*"|"/"|"%", left, right }
//   { type: "comparison", operator: "=="|"!="|">"|"<"|">="|"<=", left, right }
//   { type: "logical",    operator: "&&"|"||", left, right }
//   { type: "call",       name: "if", args: [ … ] }
//
// Parentheses are transparent (they only shape the tree); a bare identifier is
// a note-property reference (`note.` shorthand). Parentheses, call arguments
// and unary operands each add one nesting level. P1-A ships NO evaluator:
// base-values.js owns typed value semantics and INT-A wires the walker. Full
// corpus, official anchors and frozen error templates: docs/bases/BASES-GRAMMAR-CORPUS.md.

export const ERROR_CODE_SYNTAX = "syntax";
export const ERROR_CODE_UNSUPPORTED = "unsupported";
export const ERROR_CODE_TYPE_MISMATCH = "type-mismatch";
export const ERROR_CODE_LIMIT = "limit";

export const BASE_EXPRESSION_ERROR_CODES = Object.freeze([
  ERROR_CODE_SYNTAX,
  ERROR_CODE_UNSUPPORTED,
  ERROR_CODE_TYPE_MISMATCH,
  ERROR_CODE_LIMIT,
]);

// Frozen nesting ceiling. The official grammar allows arbitrary nesting; the
// project caps it for deterministic bounded work (§7: the existing limit of 20
// must not be relaxed without evidence, and §14.2 requires the exact 20/21
// boundary). Parentheses, call arguments and unary operands each add one level
// to the depth of the expression they contain.
export const MAX_EXPRESSION_DEPTH = 20;

export const AST_NODE_TYPES = Object.freeze([
  "literal",
  "reference",
  "unary",
  "binary",
  "comparison",
  "logical",
  "call",
]);

// Documented call signatures the parser enforces. P1-A implements no
// evaluation: `if` is the only callable name because it is the sole function of
// the deployed P0 subset. `falseResult` is optional in the official signature
// (`if(condition: any, trueResult: any, falseResult?: any): any`), hence 2..3.
// Every other official function stays `unsupported` until the P1-C allowlist
// (§8) lands.
export const EXPRESSION_FUNCTION_SIGNATURES = Object.freeze({
  if: Object.freeze({ min: 2, max: 3 }),
});

const ADDITIVE_OPERATORS = Object.freeze(["+", "-"]);
const MULTIPLICATIVE_OPERATORS = Object.freeze(["*", "/", "%"]);
const ARITHMETIC_OPERATORS = Object.freeze([...ADDITIVE_OPERATORS, ...MULTIPLICATIVE_OPERATORS]);
const COMPARISON_OPERATORS = Object.freeze(["==", "!=", ">", "<", ">=", "<="]);
const ORDERING_OPERATORS = Object.freeze([">", "<", ">=", "<="]);
const LOGICAL_OPERATORS = Object.freeze(["&&", "||"]);
const UNARY_OPERATORS = Object.freeze(["-", "!"]);

// Single frozen operator vocabulary, shared with base-values.js so operator
// families never drift between the parser and the typed evaluators.
export const BASE_EXPRESSION_OPERATORS = Object.freeze({
  additive: ADDITIVE_OPERATORS,
  multiplicative: MULTIPLICATIVE_OPERATORS,
  arithmetic: ARITHMETIC_OPERATORS,
  comparison: COMPARISON_OPERATORS,
  ordering: ORDERING_OPERATORS,
  logical: LOGICAL_OPERATORS,
  unary: UNARY_OPERATORS,
});

export const PROPERTY_NAMESPACES = Object.freeze(["note", "file", "formula"]);

export class BaseExpressionError extends Error {
  constructor(code, message, position = null) {
    super(message);
    this.name = "BaseExpressionError";
    this.code = code;
    this.position = position;
    // Deterministic, path-free stack: the expression layer must never expose
    // absolute paths or host internals through a thrown error.
    this.stack = `${this.name}: ${message}`;
  }
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const NUMBER_PATTERN = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const TWO_CHARACTER_OPERATORS = Object.freeze(["&&", "||", "==", "!=", ">=", "<="]);
const ONE_CHARACTER_OPERATORS = Object.freeze(["+", "-", "*", "/", "%", ">", "<", "!"]);
// Characters that are valid punctuation somewhere in the official language but
// that this subset does not parse (list/object literals, index access, object
// keys). They tokenize so the parser can fail with UNSUPPORTED instead of a
// generic lexical error.
const UNSUPPORTED_PUNCTUATORS = Object.freeze(["[", "]", "{", "}", ":"]);
const SUPPORTED_PUNCTUATORS = Object.freeze(["(", ")", ",", "."]);
const STRING_ESCAPES = Object.freeze({
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  '"': '"',
  "'": "'",
});

function makeToken(kind, start, extra = {}) {
  return Object.freeze({ kind, start, ...extra });
}

function readString(source, start, quote) {
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    if (character === "\n" || character === "\r") break;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined || escaped === "\n" || escaped === "\r") break;
      if (!Object.hasOwn(STRING_ESCAPES, escaped)) {
        throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Unsupported escape sequence "\\${escaped}" at position ${index}`, index);
      }
      value += STRING_ESCAPES[escaped];
      index += 2;
      continue;
    }
    if (character === quote) return { value, next: index + 1 };
    value += character;
    index += 1;
  }
  throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Unterminated string literal at position ${start}`, start);
}

// Find the end of a `/.../flags` literal. Regex literals are never executed —
// the parser rejects them as UNSUPPORTED — but they must tokenize as one unit,
// otherwise `/abc/` would silently degrade into a division chain.
function readRegexLiteral(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\n" || character === "\r") break;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Unterminated regular expression literal at position ${start}`, start);
}

function matchOperator(source, index) {
  const twoCharacters = source.slice(index, index + 2);
  if (TWO_CHARACTER_OPERATORS.includes(twoCharacters)) return twoCharacters;
  const oneCharacter = source[index];
  return ONE_CHARACTER_OPERATORS.includes(oneCharacter) ? oneCharacter : null;
}

function canStartPunctuator(character) {
  return character === "." || character === "," || character === "(" || character === "[" || character === "{" || character === ":";
}

/**
 * Tokenize an expression source. Exported for the grammar corpus and tooling;
 * `parseBaseExpression` is the supported entry point. Tokens are frozen and
 * carry `{ kind, start }` plus `{ value, raw }`; the source itself is never
 * retained by an AST node.
 */
export function tokenizeBaseExpression(source) {
  if (typeof source !== "string") {
    throw new BaseExpressionError(ERROR_CODE_SYNTAX, "Expression must be a string", null);
  }
  const tokens = [];
  let index = 0;
  // `expectOperand` disambiguates division from a regex literal: `/` in a value
  // position opens a regex literal, `/` after a value is division.
  let expectOperand = true;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const { value, next } = readString(source, index, character);
      tokens.push(makeToken("string", index, { value, raw: source.slice(index, next) }));
      index = next;
      expectOperand = false;
      continue;
    }
    if (/\d/.test(character)) {
      const raw = NUMBER_PATTERN.exec(source.slice(index))[0];
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Invalid number literal "${raw}" at position ${index}`, index);
      }
      tokens.push(makeToken("number", index, { value, raw }));
      index += raw.length;
      expectOperand = false;
      continue;
    }
    if (character === "/" && expectOperand) {
      const next = readRegexLiteral(source, index);
      tokens.push(makeToken("regex", index, { raw: source.slice(index, next) }));
      index = next;
      expectOperand = false;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
      const raw = source.slice(index, end);
      if (raw === "true" || raw === "false") tokens.push(makeToken("boolean", index, { value: raw === "true", raw }));
      else if (raw === "null") tokens.push(makeToken("null", index, { raw }));
      else tokens.push(makeToken("identifier", index, { value: raw, raw }));
      index = end;
      expectOperand = false;
      continue;
    }
    if (SUPPORTED_PUNCTUATORS.includes(character) || UNSUPPORTED_PUNCTUATORS.includes(character)) {
      tokens.push(makeToken("punctuator", index, { value: character, raw: character }));
      index += 1;
      expectOperand = canStartPunctuator(character);
      continue;
    }
    const operator = matchOperator(source, index);
    if (operator) {
      tokens.push(makeToken("operator", index, { value: operator, raw: operator }));
      index += operator.length;
      expectOperand = true;
      continue;
    }
    throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Unexpected character "${character}" at position ${index}`, index);
  }
  tokens.push(makeToken("eof", source.length, { raw: "" }));
  return Object.freeze(tokens);
}

function node(type, properties) {
  return Object.freeze({ type, ...properties });
}

function peek(state) {
  return state.tokens[state.position];
}

function next(state) {
  const token = state.tokens[state.position];
  state.position += 1;
  return token;
}

function isOperator(state, values) {
  const token = peek(state);
  return token.kind === "operator" && values.includes(token.value);
}

function describeToken(token) {
  return token.kind === "eof" ? "end of expression" : `"${token.raw}"`;
}

function checkDepth(depth, position) {
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new BaseExpressionError(
      ERROR_CODE_LIMIT,
      `Expression nesting exceeds the maximum depth of ${MAX_EXPRESSION_DEPTH} at position ${position}`,
      position,
    );
  }
  return depth;
}

function expectPunctuator(state, value) {
  const token = peek(state);
  if (!(token.kind === "punctuator" && token.value === value)) {
    throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Expected "${value}" but found ${describeToken(token)} at position ${token.start}`, token.start);
  }
  return next(state);
}

function parseExpression(state, depth) {
  return parseLogicalOr(state, depth);
}

function parseLogicalOr(state, depth) {
  let left = parseLogicalAnd(state, depth);
  while (isOperator(state, ["||"])) {
    const token = next(state);
    left = node("logical", { operator: token.value, left, right: parseLogicalAnd(state, depth) });
  }
  return left;
}

function parseLogicalAnd(state, depth) {
  let left = parseEquality(state, depth);
  while (isOperator(state, ["&&"])) {
    const token = next(state);
    left = node("logical", { operator: token.value, left, right: parseEquality(state, depth) });
  }
  return left;
}

function parseEquality(state, depth) {
  let left = parseRelational(state, depth);
  while (isOperator(state, ["==", "!="])) {
    const token = next(state);
    left = node("comparison", { operator: token.value, left, right: parseRelational(state, depth) });
  }
  return left;
}

function parseRelational(state, depth) {
  let left = parseAdditive(state, depth);
  while (isOperator(state, ORDERING_OPERATORS)) {
    const token = next(state);
    left = node("comparison", { operator: token.value, left, right: parseAdditive(state, depth) });
  }
  return left;
}

function parseAdditive(state, depth) {
  let left = parseMultiplicative(state, depth);
  while (isOperator(state, ADDITIVE_OPERATORS)) {
    const token = next(state);
    left = node("binary", { operator: token.value, left, right: parseMultiplicative(state, depth) });
  }
  return left;
}

function parseMultiplicative(state, depth) {
  let left = parseUnary(state, depth);
  while (isOperator(state, MULTIPLICATIVE_OPERATORS)) {
    const token = next(state);
    left = node("binary", { operator: token.value, left, right: parseUnary(state, depth) });
  }
  return left;
}

function parseUnary(state, depth) {
  const token = peek(state);
  if (token.kind === "operator" && UNARY_OPERATORS.includes(token.value)) {
    next(state);
    return node("unary", { operator: token.value, argument: parseUnary(state, checkDepth(depth + 1, token.start)) });
  }
  // Official arithmetic table documents `+` as a binary operator only; unary
  // plus is not part of the language, so it fails closed instead of guessing.
  if (token.kind === "operator" && token.value === "+") {
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported unary operator "+" at position ${token.start}`, token.start);
  }
  return parsePostfix(state, depth);
}

function parsePostfix(state, depth) {
  const primary = parsePrimary(state, depth);
  const token = peek(state);
  if (token.kind === "punctuator" && token.value === ".") {
    const member = state.tokens[state.position + 1];
    if (!member || member.kind !== "identifier") {
      const position = member ? member.start : token.start;
      throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Expected a property name after "." at position ${position}`, position);
    }
    // Field/method access on a value (`"x".lower`, `(1).toFixed`, `date.year`).
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported member access "${member.value}" at position ${token.start}`, token.start);
  }
  if (token.kind === "punctuator" && token.value === "[") {
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported index access at position ${token.start}`, token.start);
  }
  return primary;
}

function parsePrimary(state, depth) {
  const token = peek(state);
  if (token.kind === "number") {
    next(state);
    return node("literal", { valueType: "number", value: token.value });
  }
  if (token.kind === "string") {
    next(state);
    return node("literal", { valueType: "string", value: token.value });
  }
  if (token.kind === "boolean") {
    next(state);
    return node("literal", { valueType: "boolean", value: token.value });
  }
  if (token.kind === "null") {
    next(state);
    return node("literal", { valueType: "null", value: null });
  }
  if (token.kind === "punctuator" && token.value === "(") {
    next(state);
    const inner = parseExpression(state, checkDepth(depth + 1, token.start));
    expectPunctuator(state, ")");
    return inner;
  }
  if (token.kind === "identifier") return parseReferenceOrCall(state, depth);
  if (token.kind === "regex") {
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported regular expression literal at position ${token.start}`, token.start);
  }
  if (token.kind === "punctuator" && UNSUPPORTED_PUNCTUATORS.includes(token.value)) {
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported expression syntax "${token.value}" at position ${token.start}`, token.start);
  }
  throw new BaseExpressionError(ERROR_CODE_SYNTAX, `Expected an expression but found ${describeToken(token)} at position ${token.start}`, token.start);
}

function parseReferenceOrCall(state, depth) {
  const first = next(state);
  const segments = [first.value];
  while (peek(state).kind === "punctuator" && peek(state).value === "." && state.tokens[state.position + 1].kind === "identifier") {
    next(state);
    segments.push(next(state).value);
  }
  const callee = segments.join(".");
  if (peek(state).kind === "punctuator" && peek(state).value === "(") {
    const signature = segments.length === 1 && Object.hasOwn(EXPRESSION_FUNCTION_SIGNATURES, segments[0])
      ? EXPRESSION_FUNCTION_SIGNATURES[segments[0]]
      : null;
    if (!signature) {
      throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported function "${callee}" at position ${first.start}`, first.start);
    }
    next(state);
    const args = [];
    if (!(peek(state).kind === "punctuator" && peek(state).value === ")")) {
      for (;;) {
        args.push(parseExpression(state, checkDepth(depth + 1, peek(state).start)));
        if (peek(state).kind === "punctuator" && peek(state).value === ",") {
          next(state);
          continue;
        }
        break;
      }
    }
    expectPunctuator(state, ")");
    if (args.length < signature.min || args.length > signature.max) {
      throw new BaseExpressionError(
        ERROR_CODE_SYNTAX,
        `Function "${segments[0]}" expects ${signature.min} to ${signature.max} arguments but found ${args.length} at position ${first.start}`,
        first.start,
      );
    }
    return node("call", { name: segments[0], args: Object.freeze(args) });
  }
  if (segments.length === 1) return node("reference", { namespace: "note", name: segments[0], explicit: false });
  // Namespace first: an unknown prefix (`this.file.folder`, `bogus.prop`) is a
  // clearer failure than the deeper member-access message.
  if (!PROPERTY_NAMESPACES.includes(segments[0])) {
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported expression namespace "${segments[0]}" at position ${first.start}`, first.start);
  }
  if (segments.length > 2) {
    throw new BaseExpressionError(ERROR_CODE_UNSUPPORTED, `Unsupported nested member access "${callee}" at position ${first.start}`, first.start);
  }
  return node("reference", { namespace: segments[0], name: segments[1], explicit: true });
}

/**
 * Parse an expression source into a deeply frozen, position-free AST.
 * Throws `BaseExpressionError` with an exact, frozen `code`.
 */
export function parseBaseExpression(source) {
  const tokens = tokenizeBaseExpression(source);
  const state = { tokens, position: 0 };
  if (peek(state).kind === "eof") {
    throw new BaseExpressionError(ERROR_CODE_SYNTAX, "Expression is empty", null);
  }
  const ast = parseExpression(state, 0);
  const trailing = peek(state);
  if (trailing.kind !== "eof") {
    throw new BaseExpressionError(
      ERROR_CODE_SYNTAX,
      `Unexpected token ${describeToken(trailing)} at position ${trailing.start}; expected end of expression`,
      trailing.start,
    );
  }
  return ast;
}
