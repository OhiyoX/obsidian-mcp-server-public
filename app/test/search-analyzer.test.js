import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as analyzer from "../src/search/analyzer.js";

const { analyzeText, analyzePositiveClauses } = analyzer;

// Search v2 Phase 1A — offline Analyzer behavior contract.
//
// These assertions are a behavior golden, not relevance truth. No token here is
// a qrel, a relevance label, or a ranking target.
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

function compact(tokens) {
  return tokens.map((token) => [token.kind, token.value, token.rawStart, token.rawEnd, token.sources.join(",")]);
}

function tokensOf(text, options) {
  return compact(analyzeText(text, options).tokens);
}

function assertThrows(kind, callback, label) {
  assert.throws(callback, (error) => {
    assert.equal(error.constructor, kind, `${label}: expected ${kind.name}, got ${error.constructor.name}: ${error.message}`);
    return true;
  }, label);
}

test("module exports exactly the two frozen functions (no normalized->raw mapping)", () => {
  assert.deepEqual(Object.keys(analyzer).sort(), ["analyzePositiveClauses", "analyzeText"]);
});

test("ligature ﬃ keeps a one-code-unit raw span while normalizing to ffi", () => {
  assert.deepEqual(tokensOf("\uFB03"), [["word", "ffi", 0, 1, "lexical"]]);
});

test("NFD e+combining and NFC é normalize equally but keep their own raw spans", () => {
  assert.deepEqual(tokensOf("e\u0301"), [
    ["word", "\u00e9", 0, 2, "lexical"],
    ["ascii_fold", "e", 0, 2, "ascii.fold"],
  ]);
  assert.deepEqual(tokensOf("\u00e9"), [
    ["word", "\u00e9", 0, 1, "lexical"],
    ["ascii_fold", "e", 0, 1, "ascii.fold"],
  ]);
  assert.equal(analyzeText("e\u0301").tokens[0].value, analyzeText("\u00e9").tokens[0].value);
});

test("astral code points are two UTF-16 units, so offsets stay slice-exact", () => {
  const input = "a\u{1F600}b";
  assert.deepEqual(tokensOf(input), [
    ["word", "a", 0, 1, "lexical"],
    ["word", "b", 3, 4, "lexical"],
  ]);
  for (const token of analyzeText(input).tokens) {
    assert.equal(input.slice(token.rawStart, token.rawEnd).length > 0, true);
  }
});

test("unpaired high and low surrogates are rejected", () => {
  assertThrows(RangeError, () => analyzeText("a\uD800"), "high surrogate");
  assertThrows(RangeError, () => analyzeText("a\uDC00"), "low surrogate");
  assertThrows(RangeError, () => analyzeText("\uD800"), "leading high surrogate");
  assertThrows(RangeError, () => analyzePositiveClauses([{ text: "x\uD800", kind: "term" }]), "clause surrogate");
});

test("Turkish I / İ / ı use locale-independent toLowerCase", () => {
  assert.deepEqual(tokensOf("I \u0130 \u0131"), [
    ["word", "i", 0, 1, "lexical"],
    ["word", "i\u0307", 2, 3, "lexical"],
    ["ascii_fold", "i", 2, 3, "ascii.fold"],
    ["word", "\u0131", 4, 5, "lexical"],
  ]);
});

test("ASCII fold is an additive alias and never replaces the canonical token", () => {
  assert.deepEqual(tokensOf("caf\u00e9"), [
    ["word", "caf\u00e9", 0, 4, "lexical"],
    ["ascii_fold", "cafe", 0, 4, "ascii.fold"],
  ]);
  assert.deepEqual(tokensOf("caf\u00e9", { asciiFold: false }), [["word", "caf\u00e9", 0, 4, "lexical"]]);
  // No ICU transliteration: ß / ø / ł stay non-ASCII and produce no alias.
  assert.deepEqual(tokensOf("\u00df"), [["word", "\u00df", 0, 1, "lexical"]]);
  assert.deepEqual(tokensOf("\u00f8"), [["word", "\u00f8", 0, 1, "lexical"]]);
  assert.deepEqual(tokensOf("\u0142"), [["word", "\u0142", 0, 1, "lexical"]]);
});

test("snake_case keeps the whole identifier and its parts", () => {
  assert.deepEqual(tokensOf("restore_from_trash"), [
    ["identifier.part", "restore", 0, 7, "identifier.split"],
    ["identifier.whole", "restore_from_trash", 0, 18, "lexical"],
    ["identifier.part", "from", 8, 12, "identifier.split"],
    ["identifier.part", "trash", 13, 18, "identifier.split"],
  ]);
});

test("camelCase and acronyms keep the whole identifier and deterministic parts", () => {
  assert.deepEqual(tokensOf("HTTPServerV2"), [
    ["identifier.part", "http", 0, 4, "identifier.split"],
    ["identifier.whole", "httpserverv2", 0, 12, "lexical"],
    ["identifier.part", "server", 4, 10, "identifier.split"],
    ["identifier.part", "v2", 10, 12, "identifier.split"],
  ]);
  assert.deepEqual(tokensOf("fooBarV2"), [
    ["identifier.part", "foo", 0, 3, "identifier.split"],
    ["identifier.whole", "foobarv2", 0, 8, "lexical"],
    ["identifier.part", "bar", 3, 6, "identifier.split"],
    ["identifier.part", "v2", 6, 8, "identifier.split"],
  ]);
});

test("kebab, dotted version, and domain identifiers keep the whole token", () => {
  assert.deepEqual(tokensOf("search-v2"), [
    ["identifier.part", "search", 0, 6, "identifier.split"],
    ["identifier.whole", "search-v2", 0, 9, "lexical"],
    ["identifier.part", "v2", 7, 9, "identifier.split"],
  ]);
  assert.deepEqual(tokensOf("v2026.10.03"), [
    ["identifier.part", "v2026", 0, 5, "identifier.split"],
    ["identifier.whole", "v2026.10.03", 0, 11, "lexical"],
    ["identifier.part", "10", 6, 8, "identifier.split"],
    ["identifier.part", "03", 9, 11, "identifier.split"],
  ]);
  assert.deepEqual(tokensOf("example.com"), [
    ["identifier.part", "example", 0, 7, "identifier.split"],
    ["identifier.whole", "example.com", 0, 11, "lexical"],
    ["identifier.part", "com", 8, 11, "identifier.split"],
  ]);
});

test("slash identifiers keep the whole token without filesystem normalization", () => {
  const input = "app/src/search/analyzer.js";
  const tokens = analyzeText(input).tokens;
  const whole = tokens.find((token) => token.kind === "identifier.whole");
  assert.equal(whole.value, input);
  assert.equal(input.slice(whole.rawStart, whole.rawEnd), input);
  assert.deepEqual(compact(tokens), [
    ["identifier.part", "app", 0, 3, "identifier.split"],
    ["identifier.whole", "app/src/search/analyzer.js", 0, 26, "lexical"],
    ["identifier.part", "src", 4, 7, "identifier.split"],
    ["identifier.part", "search", 8, 14, "identifier.split"],
    ["identifier.part", "analyzer", 15, 23, "identifier.split"],
    ["identifier.part", "js", 24, 26, "identifier.split"],
  ]);
});

test("hashes keep the complete token unchanged", () => {
  const hash = "4062b5a547504012b44da573ca7904292c6e7296";
  assert.deepEqual(tokensOf(hash), [["word", hash, 0, 40, "lexical"]]);
});

test("CJK runs emit run + unigram + bigram and never a trigram", () => {
  assert.deepEqual(tokensOf("\u4E2D"), [
    ["cjk.run", "\u4E2D", 0, 1, "cjk.run"],
    ["cjk.unigram", "\u4E2D", 0, 1, "cjk.unigram"],
  ]);
  assert.deepEqual(tokensOf("\u4E2D\u6587"), [
    ["cjk.unigram", "\u4E2D", 0, 1, "cjk.unigram"],
    ["cjk.run", "\u4E2D\u6587", 0, 2, "cjk.run"],
    ["cjk.bigram", "\u4E2D\u6587", 0, 2, "cjk.bigram"],
    ["cjk.unigram", "\u6587", 1, 2, "cjk.unigram"],
  ]);
  const tokens = analyzeText("\u4E2D\u6587\u641C\u7D22").tokens;
  assert.deepEqual(compact(tokens), [
    ["cjk.unigram", "\u4E2D", 0, 1, "cjk.unigram"],
    ["cjk.bigram", "\u4E2D\u6587", 0, 2, "cjk.bigram"],
    ["cjk.run", "\u4E2D\u6587\u641C\u7D22", 0, 4, "cjk.run"],
    ["cjk.unigram", "\u6587", 1, 2, "cjk.unigram"],
    ["cjk.bigram", "\u6587\u641C", 1, 3, "cjk.bigram"],
    ["cjk.unigram", "\u641C", 2, 3, "cjk.unigram"],
    ["cjk.bigram", "\u641C\u7D22", 2, 4, "cjk.bigram"],
    ["cjk.unigram", "\u7D22", 3, 4, "cjk.unigram"],
  ]);
  assert.equal(tokens.some((token) => token.kind.includes("trigram")), false);
});

test("mixed Latin + CJK splits at the script boundary", () => {
  assert.deepEqual(tokensOf("openwrt\u7F51\u7EDC\u6545\u969C"), [
    ["word", "openwrt", 0, 7, "lexical"],
    ["cjk.unigram", "\u7F51", 7, 8, "cjk.unigram"],
    ["cjk.bigram", "\u7F51\u7EDC", 7, 9, "cjk.bigram"],
    ["cjk.run", "\u7F51\u7EDC\u6545\u969C", 7, 11, "cjk.run"],
    ["cjk.unigram", "\u7EDC", 8, 9, "cjk.unigram"],
    ["cjk.bigram", "\u7EDC\u6545", 8, 10, "cjk.bigram"],
    ["cjk.unigram", "\u6545", 9, 10, "cjk.unigram"],
    ["cjk.bigram", "\u6545\u969C", 9, 11, "cjk.bigram"],
    ["cjk.unigram", "\u969C", 10, 11, "cjk.unigram"],
  ]);
});

test("CJK range boundaries are explicit (extensions, kana, Hangul, astral)", () => {
  const isCjk = (character) => analyzeText(character).tokens.some((token) => token.kind.startsWith("cjk."));
  assert.equal(isCjk("\u4DBF"), true, "last CJK Ext-A");
  assert.equal(isCjk("\u4DC0"), false, "Yijing symbol is not CJK");
  assert.equal(isCjk("\u4E00"), true, "first CJK Unified Ideograph");
  assert.equal(isCjk("\u9FFF"), true, "last CJK Unified Ideograph");
  assert.equal(isCjk("\u3041"), true, "first assigned Hiragana letter");
  assert.equal(isCjk("\u3040"), false, "unassigned code point inside the kana range is not CJK");
  assert.equal(isCjk("\u30FF"), true, "Katakana range end");
  assert.equal(isCjk("\uAC00"), true, "Hangul Syllables start");
  assert.equal(isCjk("\u1100"), true, "Hangul Jamo start");
  assert.equal(isCjk("\uA960"), true, "Hangul Jamo Ext-A start");
  assert.equal(isCjk("\uFF66"), true, "Halfwidth Katakana start");
  assert.equal(isCjk("\u{20000}"), true, "CJK Ext-B astral start");
  assert.equal(isCjk("\u{2A6DF}"), true, "CJK Ext-B astral end");
  assert.equal(isCjk("\uA000"), false, "Yi syllable is a word, not CJK");
  const astral = analyzeText("\u{20000}").tokens.find((token) => token.kind === "cjk.run");
  assert.equal(astral.rawStart, 0);
  assert.equal(astral.rawEnd, 2);
});

test("kana-block punctuation separates CJK runs and never spans them", () => {
  // U+30FB KATAKANA MIDDLE DOT (Po) and U+30A0 KATAKANA-HIRAGANA DOUBLE HYPHEN
  // (Pd) sit inside the frozen 3040-30FF range but must not join a run.
  for (const punctuation of ["\u30FB", "\u30A0"]) {
    const input = `\u30AB${punctuation}\u30CA`;
    const tokens = analyzeText(input).tokens;
    assert.deepEqual(compact(tokens), [
      ["cjk.run", "\u30AB", 0, 1, "cjk.run"],
      ["cjk.unigram", "\u30AB", 0, 1, "cjk.unigram"],
      ["cjk.run", "\u30CA", 2, 3, "cjk.run"],
      ["cjk.unigram", "\u30CA", 2, 3, "cjk.unigram"],
    ], `punctuation ${punctuation}`);
    // No token, unigram, or n-gram may cover the punctuation code unit at index 1.
    for (const token of tokens) {
      assert.equal(token.rawStart <= 1 && token.rawEnd > 1, false, `${punctuation} span ${token.kind}`);
      assert.equal(token.value.includes(punctuation), false, `${punctuation} value ${token.kind}`);
    }
    assert.equal(tokens.some((token) => token.kind === "cjk.bigram"), false, `${punctuation} no bigram`);
  }
});

test("symbols and unassigned code points inside CJK ranges are not CJK", () => {
  const isCjk = (character) => analyzeText(character).tokens.some((token) => token.kind.startsWith("cjk."));
  assert.equal(isCjk("\u309B"), false, "spacing voiced sound mark (Sk)");
  assert.equal(isCjk("\u309C"), false, "spacing semi-voiced sound mark (Sk)");
  assert.equal(isCjk("\u3040"), false, "unassigned U+3040");
  assert.equal(isCjk("\u3097"), false, "unassigned U+3097");
  assert.equal(isCjk("\u3098"), false, "unassigned U+3098");
  assert.equal(isCjk("\u30FB"), false, "kana middle dot (Po)");
  assert.equal(isCjk("\u30A0"), false, "kana double hyphen (Pd)");
});

test("legitimate kana marks and long-vowel marks stay inside the CJK run", () => {
  // U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK (Lm) is a letter modifier.
  assert.deepEqual(tokensOf("\u30B3\u30FC\u30D2\u30FC"), [
    ["cjk.unigram", "\u30B3", 0, 1, "cjk.unigram"],
    ["cjk.bigram", "\u30B3\u30FC", 0, 2, "cjk.bigram"],
    ["cjk.run", "\u30B3\u30FC\u30D2\u30FC", 0, 4, "cjk.run"],
    ["cjk.unigram", "\u30FC", 1, 2, "cjk.unigram"],
    ["cjk.bigram", "\u30FC\u30D2", 1, 3, "cjk.bigram"],
    ["cjk.unigram", "\u30D2", 2, 3, "cjk.unigram"],
    ["cjk.bigram", "\u30D2\u30FC", 2, 4, "cjk.bigram"],
    ["cjk.unigram", "\u30FC", 3, 4, "cjk.unigram"],
  ]);
  // U+3099 combining dakuten (Mn) stays in the run's original raw span.
  const input = "\u304B\u3099";
  const run = analyzeText(input).tokens.find((token) => token.kind === "cjk.run");
  assert.equal(run.rawStart, 0);
  assert.equal(run.rawEnd, 2);
  assert.equal(input.slice(run.rawStart, run.rawEnd), input);
});

test("plain text never invents query syntax from quotes, -negatives, OR, or operators", () => {
  const input = '"foo bar" -baz OR qux';
  const tokens = analyzeText(input).tokens;
  assert.deepEqual(compact(tokens), [
    ["word", "foo", 1, 4, "lexical"],
    ["word", "bar", 5, 8, "lexical"],
    ["word", "baz", 11, 14, "lexical"],
    ["word", "or", 15, 17, "lexical"],
    ["word", "qux", 18, 21, "lexical"],
  ]);
  assert.equal(tokens.some((token) => token.kind === "phrase.literal"), false);
  assert.equal(tokens.some((token) => token.kind.includes("negative")), false);
  assert.equal(tokens.some((token) => token.kind.includes("operator")), false);
  assert.deepEqual(tokensOf("tag:x"), [
    ["word", "tag", 0, 3, "lexical"],
    ["word", "x", 4, 5, "lexical"],
  ]);
});

test("phrase clauses emit a phrase.literal covering the whole clause text", () => {
  const text = "  Exact   Phrase  ";
  const result = analyzePositiveClauses([{ text, kind: "phrase" }]);
  const clause = result.clauses[0];
  assert.equal(clause.clauseIndex, 0);
  assert.equal(clause.kind, "phrase");
  const literal = clause.tokens.find((token) => token.kind === "phrase.literal");
  assert.equal(literal.value, text.normalize("NFKC").toLowerCase());
  assert.equal(text.slice(literal.rawStart, literal.rawEnd), text);
  assert.deepEqual(compact(clause.tokens), [
    ["phrase.literal", "  exact   phrase  ", 0, 18, "phrase.literal"],
    ["word", "exact", 2, 7, "lexical"],
    ["word", "phrase", 10, 16, "lexical"],
  ]);
});

test("term clauses produce ordinary analysis and no phrase literal", () => {
  const result = analyzePositiveClauses([{ text: "fooBar", kind: "term" }]);
  assert.deepEqual(result, {
    clauses: [{
      clauseIndex: 0,
      kind: "term",
      tokens: [
        { kind: "identifier.part", value: "foo", rawStart: 0, rawEnd: 3, sources: ["identifier.split"] },
        { kind: "identifier.whole", value: "foobar", rawStart: 0, rawEnd: 6, sources: ["lexical"] },
        { kind: "identifier.part", value: "bar", rawStart: 3, rawEnd: 6, sources: ["identifier.split"] },
      ],
    }],
  });
});

test("empty inputs are not errors", () => {
  assert.deepEqual(analyzeText(""), { tokens: [] });
  assert.deepEqual(analyzePositiveClauses([]), { clauses: [] });
});

test("invalid clauses and options are rejected, never silently ignored", () => {
  assertThrows(TypeError, () => analyzeText(5), "non-string text");
  assertThrows(TypeError, () => analyzeText("x", []), "array options");
  assertThrows(TypeError, () => analyzeText("x", { unknown: 1 }), "unknown option");
  assertThrows(TypeError, () => analyzeText("x", { asciiFold: "yes" }), "non-boolean asciiFold");
  assertThrows(TypeError, () => analyzeText("x", { maxGeneratedTokens: 1.5 }), "non-integer limit");
  assertThrows(RangeError, () => analyzeText("x", { maxGeneratedTokens: 0 }), "zero limit");
  assertThrows(RangeError, () => analyzeText("x", { maxInputCodeUnits: -1 }), "negative limit");
  assertThrows(TypeError, () => analyzePositiveClauses("x"), "non-array clauses");
  assertThrows(TypeError, () => analyzePositiveClauses([null]), "null clause");
  assertThrows(TypeError, () => analyzePositiveClauses([{ kind: "term" }]), "missing text");
  assertThrows(TypeError, () => analyzePositiveClauses([{ text: 1, kind: "term" }]), "non-string clause text");
  assertThrows(TypeError, () => analyzePositiveClauses([{ text: "x", kind: "negative" }]), "negative clause kind");
  assertThrows(TypeError, () => analyzePositiveClauses([{ text: "x", kind: "term", extra: 1 }]), "unknown clause key");
});

test("bounds reject the whole call; there is no partial result", () => {
  assertThrows(RangeError, () => analyzeText("abcd", { maxInputCodeUnits: 3 }), "input bound");
  assertThrows(RangeError, () => analyzeText("abc def", { maxGeneratedTokens: 1 }), "token bound");
  assertThrows(RangeError, () => analyzeText("\u4E2D\u6587\u641C\u7D22", { maxCjkRunCodePoints: 2 }), "cjk bound");
  assertThrows(
    RangeError,
    () => analyzePositiveClauses([{ text: "abc", kind: "term" }, { text: "def", kind: "term" }], { maxInputCodeUnits: 5 }),
    "aggregate input bound",
  );
  assertThrows(
    RangeError,
    () => analyzePositiveClauses([{ text: "abc", kind: "term" }, { text: "def", kind: "term" }], { maxGeneratedTokens: 1 }),
    "aggregate token bound",
  );
  // The exact aggregate budget passes and yields both clauses.
  const result = analyzePositiveClauses([{ text: "abc", kind: "term" }, { text: "def", kind: "term" }], { maxInputCodeUnits: 6 });
  assert.equal(result.clauses.length, 2);
});

test("inputs are never mutated and repeated calls are deep-equal", () => {
  const clauses = [{ text: "fooBar", kind: "term" }, { text: "caf\u00e9", kind: "phrase" }];
  const options = { asciiFold: false };
  const clauseSnapshot = JSON.stringify(clauses);
  const optionSnapshot = JSON.stringify(options);
  const first = analyzePositiveClauses(clauses, options);
  const second = analyzePositiveClauses(clauses, options);
  assert.equal(JSON.stringify(clauses), clauseSnapshot);
  assert.equal(JSON.stringify(options), optionSnapshot);
  assert.deepEqual(first, second);
  assert.deepEqual(analyzeText("中文搜索"), analyzeText("中文搜索"));
});

test("every token satisfies the raw-slice invariant and the source vocabulary", () => {
  const vocabulary = new Set([
    "lexical",
    "identifier.split",
    "cjk.run",
    "cjk.unigram",
    "cjk.bigram",
    "ascii.fold",
    "phrase.literal",
  ]);
  const inputs = [
    "restore_from_trash fooBarV2 app/src/search/analyzer.js",
    "\u4E2D\u6587 openwrt \u00e9\u00df\u00f8",
    '"foo bar" -baz OR tag:x',
    "\uFB03 e\u0301 a\u{1F600}b",
  ];
  for (const input of inputs) {
    for (const token of analyzeText(input).tokens) {
      assert.equal(token.rawStart >= 0 && token.rawEnd > token.rawStart, true, `${input} span`);
      assert.equal(token.rawEnd <= input.length, true, `${input} span within input`);
      assert.equal(typeof input.slice(token.rawStart, token.rawEnd), "string");
      assert.deepEqual(Object.keys(token).sort(), ["kind", "rawEnd", "rawStart", "sources", "value"]);
      for (const source of token.sources) assert.equal(vocabulary.has(source), true, `source ${source}`);
    }
  }
});

test("fixture golden vectors match deterministically", async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureDirectory, "fixtures", "search-analyzer-v1.json"), "utf8"));
  assert.equal(fixture.purpose, "behavior-contract");
  assert.equal(fixture.relevanceLabels, null);
  for (const testCase of fixture.textCases) {
    assert.deepEqual(analyzeText(testCase.input, testCase.options), testCase.expected, testCase.name);
  }
  for (const testCase of fixture.clauseCases) {
    assert.deepEqual(analyzePositiveClauses(testCase.input, testCase.options), testCase.expected, testCase.name);
  }
});
