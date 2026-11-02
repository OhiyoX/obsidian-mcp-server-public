// Search v2 Phase 1A — offline, pure text analyzer.
//
// This module is deliberately offline and dependency-free (zero imports). It
// does NOT parse a raw query: quote characters, `-negatives`, `OR`, and
// `field:value` operators are plain text here and carry no query semantics.
//
// Frozen API (reviewer GO):
//   analyzeText(text, options?)                -> { tokens }
//   analyzePositiveClauses(clauses, options?)  -> { clauses: [{ clauseIndex, kind, tokens }] }
//
// Every token is { kind, value, rawStart, rawEnd, sources }:
//   kind      one of the fixed KIND_RANK keys below.
//   value     canonical token = raw fragment -> NFKC -> String.prototype.toLowerCase().
//             Locale-sensitive conversion (toLocaleLowerCase / locale args) is
//             intentionally never used.
//   rawStart  raw UTF-16 code-unit offset, inclusive, into the exact input text.
//   rawEnd    raw UTF-16 code-unit offset, exclusive.
//   sources   sorted unique rule names that produced this identity.
// `input.slice(rawStart, rawEnd)` is always the original fragment. No
// normalized offsets or normalized->raw mapping are produced.

const KIND_RANK = Object.freeze({
  word: 0,
  "identifier.whole": 1,
  "identifier.part": 2,
  "cjk.run": 3,
  "cjk.unigram": 4,
  "cjk.bigram": 5,
  "phrase.literal": 6,
  ascii_fold: 7,
});

// Frozen, explicit CJK code-point ranges (inclusive). No Intl.Segmenter and no
// OS/locale dictionary segmentation is used anywhere. A range alone is not
// sufficient admission: the code point must also carry an admitted Unicode
// general category (see CJK_ADMITTED_CATEGORIES below).
const CJK_RANGES = Object.freeze([
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7af], // Hangul Syllables
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff66, 0xff9d], // Halfwidth Katakana
  [0x20000, 0x2a6df], // CJK Unified Ideographs Extension B
  [0x2a700, 0x2b73f], // CJK Unified Ideographs Extension C
  [0x2b740, 0x2b81f], // CJK Unified Ideographs Extension D
  [0x2b820, 0x2ceaf], // CJK Unified Ideographs Extension E
  [0x2ceb0, 0x2ebef], // CJK Unified Ideographs Extension F
]);

// A code point joins a CJK run only when it is inside a frozen CJK range AND its
// Unicode general category is Letter (L*), Mark (M*), or Number (N*). The
// ranges above are coarse and also contain non-word code points, which are
// rejected so they separate runs instead of becoming tokens or n-grams:
//   punctuation P*  e.g. U+30A0 KATAKANA-HIRAGANA DOUBLE HYPHEN,
//                        U+30FB KATAKANA MIDDLE DOT
//   symbols S*      e.g. U+309B/U+309C spacing voiced sound marks
//   unassigned Cn   e.g. U+3040, U+3097, U+3098
// This is a fixed Unicode general-category property lookup (no locale, no OS or
// language dictionary, no segmentation). Admitted marks keep a combining mark
// (e.g. U+3099/U+309A dakuten/handakuten) inside the run's original raw span;
// admitted modifier letters keep legitimate kana marks such as U+30FC
// KATAKANA-HIRAGANA PROLONGED SOUND MARK.
const CJK_ADMITTED_CATEGORIES = /[\p{L}\p{M}\p{N}]/u;

// Offline engineering guardrails, not product search limits or performance
// targets. Every bound overflow throws; nothing is silently truncated.
const DEFAULTS = Object.freeze({
  asciiFold: true,
  maxInputCodeUnits: 262144,
  maxGeneratedTokens: 65536,
  maxCjkRunCodePoints: 8192,
});

const OPTION_KEYS = Object.freeze(["asciiFold", "maxInputCodeUnits", "maxGeneratedTokens", "maxCjkRunCodePoints"]);

// ASCII fold is an additive alias only. A folded value is emitted only when it
// differs from the canonical value and lies entirely inside the alphabet that
// is legal for that kind. No ICU transliteration (ß/ø/ł are left alone).
const ASCII_FOLD_ALPHABETS = new Map([
  ["word", /^[a-z0-9]+$/],
  ["identifier.whole", /^[a-z0-9_.\-/]+$/],
  ["identifier.part", /^[a-z0-9]+$/],
]);

const WORD_START = /[\p{L}\p{N}]/u;
const WORD_CONTINUE = /[\p{L}\p{N}\p{M}]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const NUMBER = /\p{N}/u;
const IDENTIFIER_PUNCT = /[_.\-/]/;

function inCjkRange(codePoint) {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint < start) return false;
    if (codePoint <= end) return true;
  }
  return false;
}

function isCjkCodePoint(codePoint) {
  if (!inCjkRange(codePoint)) return false;
  return CJK_ADMITTED_CATEGORIES.test(String.fromCodePoint(codePoint));
}

function codePointSize(codePoint) {
  return codePoint > 0xffff ? 2 : 1;
}

function isLexicalWordStart(codePoint) {
  return !isCjkCodePoint(codePoint) && WORD_START.test(String.fromCodePoint(codePoint));
}

function isLexicalWordContinue(codePoint) {
  return !isCjkCodePoint(codePoint) && WORD_CONTINUE.test(String.fromCodePoint(codePoint));
}

function normalizeValue(raw) {
  return raw.normalize("NFKC").toLowerCase();
}

function asciiFoldValue(value) {
  const stripped = value.normalize("NFKD").replace(/\p{M}+/gu, "");
  return stripped === value ? null : stripped;
}

function assertWellFormedUtf16(text, label) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RangeError(`${label} contains an unpaired high surrogate at ${index}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RangeError(`${label} contains an unpaired low surrogate at ${index}`);
    }
  }
}

function parseOptions(options) {
  if (options === undefined) return { ...DEFAULTS };
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("options must be a plain object");
  }
  const config = { ...DEFAULTS };
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw new TypeError(`unknown option "${key}"`);
    const value = options[key];
    if (key === "asciiFold") {
      if (typeof value !== "boolean") throw new TypeError("asciiFold must be a boolean");
      config.asciiFold = value;
    } else {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`${key} must be a safe integer`);
      }
      if (value <= 0) throw new RangeError(`${key} must be a positive integer`);
      config[key] = value;
    }
  }
  return config;
}

function createBudget(config) {
  return { config, inputCodeUnits: 0, generatedTokens: 0 };
}

function chargeInput(budget, units) {
  const next = budget.inputCodeUnits + units;
  if (next > budget.config.maxInputCodeUnits) {
    throw new RangeError(`input exceeds maxInputCodeUnits (${budget.config.maxInputCodeUnits})`);
  }
  budget.inputCodeUnits = next;
}

function pushToken(tokens, budget, kind, value, rawStart, rawEnd, source) {
  budget.generatedTokens += 1;
  if (budget.generatedTokens > budget.config.maxGeneratedTokens) {
    throw new RangeError(`token expansion exceeds maxGeneratedTokens (${budget.config.maxGeneratedTokens})`);
  }
  tokens.push({ kind, value, rawStart, rawEnd, source });
}

function emitToken(tokens, budget, config, kind, value, rawStart, rawEnd, source) {
  pushToken(tokens, budget, kind, value, rawStart, rawEnd, source);
  const alphabet = ASCII_FOLD_ALPHABETS.get(kind);
  if (!config.asciiFold || alphabet === undefined) return;
  const folded = asciiFoldValue(value);
  if (folded !== null && alphabet.test(folded)) {
    pushToken(tokens, budget, "ascii_fold", folded, rawStart, rawEnd, "ascii.fold");
  }
}

function isLowerOrDigit(character) {
  return LOWER.test(character) || NUMBER.test(character);
}

function hasCaseBoundary(raw) {
  for (let index = 1; index < raw.length; index += 1) {
    if (isLowerOrDigit(raw[index - 1]) && UPPER.test(raw[index])) return true;
    if (UPPER.test(raw[index - 1]) && UPPER.test(raw[index]) && index + 1 < raw.length && LOWER.test(raw[index + 1])) {
      return true;
    }
  }
  return false;
}

function isIdentifierRaw(raw) {
  for (let index = 0; index < raw.length; index += 1) {
    if (IDENTIFIER_PUNCT.test(raw[index])) return true;
  }
  return hasCaseBoundary(raw);
}

function collectCamelParts(raw, start, end, parts) {
  let partStart = start;
  for (let index = start + 1; index < end; index += 1) {
    const boundary = (isLowerOrDigit(raw[index - 1]) && UPPER.test(raw[index]))
      || (UPPER.test(raw[index - 1]) && UPPER.test(raw[index]) && index + 1 < end && LOWER.test(raw[index + 1]));
    if (boundary) {
      parts.push({ start: partStart, end: index });
      partStart = index;
    }
  }
  parts.push({ start: partStart, end });
}

function splitIdentifier(raw) {
  const parts = [];
  let segmentStart = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    const atEnd = index === raw.length;
    if (atEnd || IDENTIFIER_PUNCT.test(raw[index])) {
      if (index > segmentStart) collectCamelParts(raw, segmentStart, index, parts);
      segmentStart = index + 1;
    }
  }
  return parts;
}

function scanLexicalEnd(text, start) {
  let index = start;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (isLexicalWordStart(codePoint)) {
      index += codePointSize(codePoint);
      continue;
    }
    if (IDENTIFIER_PUNCT.test(text[index]) && index > start) {
      const next = index + 1;
      if (next < text.length && isLexicalWordStart(text.codePointAt(next))) {
        index += 1;
        continue;
      }
      break;
    }
    if (isLexicalWordContinue(codePoint) && index > start) {
      index += codePointSize(codePoint);
      continue;
    }
    break;
  }
  return index;
}

function emitLexical(text, start, end, budget, config, tokens) {
  const raw = text.slice(start, end);
  if (isIdentifierRaw(raw)) {
    emitToken(tokens, budget, config, "identifier.whole", normalizeValue(raw), start, end, "lexical");
    for (const part of splitIdentifier(raw)) {
      const value = normalizeValue(raw.slice(part.start, part.end));
      emitToken(tokens, budget, config, "identifier.part", value, start + part.start, start + part.end, "identifier.split");
    }
    return;
  }
  emitToken(tokens, budget, config, "word", normalizeValue(raw), start, end, "lexical");
}

function emitCjkRun(text, start, end, points, budget, config, tokens) {
  if (points.length > config.maxCjkRunCodePoints) {
    throw new RangeError(`CJK run of ${points.length} code points exceeds maxCjkRunCodePoints (${config.maxCjkRunCodePoints})`);
  }
  pushToken(tokens, budget, "cjk.run", normalizeValue(text.slice(start, end)), start, end, "cjk.run");
  for (const point of points) {
    pushToken(tokens, budget, "cjk.unigram", normalizeValue(text.slice(point.start, point.start + point.size)), point.start, point.start + point.size, "cjk.unigram");
  }
  for (let index = 0; index + 1 < points.length; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    pushToken(tokens, budget, "cjk.bigram", normalizeValue(text.slice(left.start, right.start + right.size)), left.start, right.start + right.size, "cjk.bigram");
  }
}

function scanText(text, budget, config) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (isCjkCodePoint(codePoint)) {
      const start = index;
      const points = [];
      while (index < text.length) {
        const pointCodePoint = text.codePointAt(index);
        if (!isCjkCodePoint(pointCodePoint)) break;
        const size = codePointSize(pointCodePoint);
        points.push({ start: index, size });
        index += size;
      }
      emitCjkRun(text, start, index, points, budget, config, tokens);
      continue;
    }
    if (isLexicalWordStart(codePoint)) {
      const start = index;
      index = scanLexicalEnd(text, index);
      emitLexical(text, start, index, budget, config, tokens);
      continue;
    }
    index += codePointSize(codePoint);
  }
  return tokens;
}

function compareStringArrays(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

function compareTokens(left, right) {
  if (left.rawStart !== right.rawStart) return left.rawStart - right.rawStart;
  if (left.rawEnd !== right.rawEnd) return left.rawEnd - right.rawEnd;
  if (KIND_RANK[left.kind] !== KIND_RANK[right.kind]) return KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (left.value !== right.value) return left.value < right.value ? -1 : 1;
  return compareStringArrays(left.sources, right.sources);
}

function finalize(rawTokens) {
  const merged = new Map();
  for (const token of rawTokens) {
    const key = `${token.kind}\u0000${token.value}\u0000${token.rawStart}\u0000${token.rawEnd}`;
    const existing = merged.get(key);
    if (existing) existing.sources.add(token.source);
    else merged.set(key, { kind: token.kind, value: token.value, rawStart: token.rawStart, rawEnd: token.rawEnd, sources: new Set([token.source]) });
  }
  const tokens = [];
  for (const token of merged.values()) {
    tokens.push({ kind: token.kind, value: token.value, rawStart: token.rawStart, rawEnd: token.rawEnd, sources: [...token.sources].sort() });
  }
  tokens.sort(compareTokens);
  return tokens;
}

function prepareClause(clause, index) {
  if (clause === null || typeof clause !== "object" || Array.isArray(clause)) {
    throw new TypeError(`clauses[${index}] must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(clause);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`clauses[${index}] must be a plain object`);
  }
  for (const key of Object.keys(clause)) {
    if (key !== "text" && key !== "kind") throw new TypeError(`clauses[${index}] has an unknown key "${key}"`);
  }
  if (typeof clause.text !== "string") throw new TypeError(`clauses[${index}].text must be a string`);
  if (clause.kind !== "term" && clause.kind !== "phrase") {
    throw new TypeError(`clauses[${index}].kind must be "term" or "phrase"`);
  }
  assertWellFormedUtf16(clause.text, `clauses[${index}].text`);
  return { text: clause.text, kind: clause.kind };
}

function analyzeClause(clause, budget, config) {
  const tokens = [];
  if (clause.kind === "phrase") {
    pushToken(tokens, budget, "phrase.literal", normalizeValue(clause.text), 0, clause.text.length, "phrase.literal");
  }
  tokens.push(...scanText(clause.text, budget, config));
  return tokens;
}

// Analyze plain text. Quotes, `-`, `OR`, and `field:value` are ordinary text.
export function analyzeText(text, options) {
  const config = parseOptions(options);
  if (typeof text !== "string") throw new TypeError("text must be a string");
  assertWellFormedUtf16(text, "text");
  const budget = createBudget(config);
  chargeInput(budget, text.length);
  return { tokens: finalize(scanText(text, budget, config)) };
}

// Analyze already-parsed positive clauses. Only `{ text, kind }` with
// kind "term" | "phrase" is accepted; negatives and raw query syntax are not.
export function analyzePositiveClauses(clauses, options) {
  const config = parseOptions(options);
  if (!Array.isArray(clauses)) throw new TypeError("clauses must be an array");
  const prepared = clauses.map((clause, index) => prepareClause(clause, index));
  const budget = createBudget(config);
  chargeInput(budget, prepared.reduce((total, clause) => total + clause.text.length, 0));
  const result = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const clause = prepared[index];
    result.push({ clauseIndex: index, kind: clause.kind, tokens: finalize(analyzeClause(clause, budget, config)) });
  }
  return { clauses: result };
}
