# Search v2 — Phase 1A offline Analyzer

Status: Phase 1A offline analyzer contract/implementation. This is **not** Search
v2, BM25F, RRF, shared-service, phrase-correctness, or relevance completion.

## Scope

`app/src/search/analyzer.js` is a pure, zero-import, offline module. It analyzes
plain text and already-parsed positive clauses. It is **not** a raw-query parser:
quotes, `-negatives`, `OR`, and `field:value` operators carry no query syntax
here. It is not imported by any production/runtime module and it does not change
any parser, evaluator, retrieval, ranking, weight, snippet, MCP, Web, Context, or
Discovery behavior.

Frozen API:

```js
analyzeText(text, options?)                -> { tokens: Token[] }
analyzePositiveClauses(clauses, options?)  -> { clauses: [{ clauseIndex, kind, tokens: Token[] }] }
```

`analyzePositiveClauses` accepts only already-parsed positive clauses shaped
`{ text: string, kind: "term" | "phrase" }`. Negatives and raw query syntax are
rejected, not interpreted. The future runtime integration slice owns mapping a
real parser AST into this shape.

## Token shape

```js
{ kind, value, rawStart, rawEnd, sources }
```

- `kind`: one of the fixed kinds below.
- `value`: canonical token = raw fragment `-> NFKC -> String.prototype.toLowerCase()`.
  Locale-sensitive conversion (`toLocaleLowerCase`, locale arguments) is never used.
- `rawStart` / `rawEnd`: raw UTF-16 code-unit offsets into the exact input text,
  `[rawStart, rawEnd)`. `input.slice(rawStart, rawEnd)` is always the original
  fragment, even when normalization changes length (`ﬃ` -> `ffi`, `e\u0301` -> `é`,
  astral code points).
- `sources`: sorted unique rule names.

No normalized offsets and no normalized -> raw offset mapping are exported.

### Fixed `kindRank`

```text
word               0
identifier.whole   1
identifier.part    2
cjk.run            3
cjk.unigram        4
cjk.bigram         5
phrase.literal     6
ascii_fold         7
```

Deterministic ordering: `rawStart ASC`, `rawEnd ASC`, `kindRank ASC`, `value`
code-unit lexical ASC, `sources` lexical ASC. Dedupe identity is
`(kind, value, rawStart, rawEnd)`; matching identities merge their `sources`.
Different kinds with the same value are never merged.

### Source vocabulary

```text
lexical            word and identifier.whole tokens from the lexical scan
identifier.split   identifier.part tokens
cjk.run            CJK whole-run tokens
cjk.unigram        CJK unigram tokens
cjk.bigram         CJK bigram tokens
ascii.fold         ASCII-fold additive aliases
phrase.literal     phrase clause whole-literal tokens
```

## Normalization and ASCII fold

Canonical order is frozen: raw fragment `-> NFKC -> String.prototype.toLowerCase()`.
Turkish-I behavior follows locale-independent JS: `I -> i`, `İ -> i` + combining
dot, `ı` stays dotless.

ASCII fold is an additive alias only and never replaces the canonical token:

```text
canonical -> NFKD -> remove \p{M} combining marks
          -> emit ascii_fold only when the result differs and is fully inside
             the kind's ASCII alphabet
```

No ICU transliteration: `ß`, `ø`, `ł` are not rewritten. Aliases apply to `word`,
`identifier.whole`, and `identifier.part`. `café` keeps `café` and adds `cafe`;
`İstanbul` adds `istanbul`; `ı` adds nothing.

## Lexical expansion

A lexical run starts at a letter/number, may include combining marks, and may
include `_`, `-`, `.`, `/` only when they sit between word characters. `/`, `.`,
`-`, `_` are lexical identifier punctuation only — the analyzer never calls
`path.normalize`, resolve, drive-letter rules, or separator canonicalization, and
never treats a token as a real filesystem path.

A run is an identifier when it contains identifier punctuation or a deterministic
case boundary (lower/digit -> Upper, or acronym -> Capitalized). Identifiers keep
the complete `identifier.whole` **and** their `identifier.part` subwords:

- `restore_from_trash` -> whole + `restore` / `from` / `trash`
- `HTTPServerV2` -> whole + `HTTP` / `Server` / `V2`
- `search-v2` -> whole + `search` / `v2`
- `app/src/search/analyzer.js` -> whole + `app` / `src` / `search` / `analyzer` / `js`
- `v2026.10.03`, `example.com` -> whole + dotted parts
- hashes are kept complete and are never special-cased

## CJK

No `Intl.Segmenter` and no locale dictionary segmentation. `isCjkCodePoint` uses
these frozen, inclusive code-point ranges:

```text
1100–11FF    Hangul Jamo
3040–30FF    Hiragana + Katakana
31F0–31FF    Katakana Phonetic Extensions
3400–4DBF    CJK Unified Ideographs Extension A
4E00–9FFF    CJK Unified Ideographs
A960–A97F    Hangul Jamo Extended-A
AC00–D7AF    Hangul Syllables
D7B0–D7FF    Hangul Jamo Extended-B
F900–FAFF    CJK Compatibility Ideographs
FF66–FF9D    Halfwidth Katakana
20000–2A6DF  CJK Unified Ideographs Extension B
2A700–2B73F  CJK Unified Ideographs Extension C
2B740–2B81F  CJK Unified Ideographs Extension D
2B820–2CEAF  CJK Unified Ideographs Extension E
2CEB0–2EBEF  CJK Unified Ideographs Extension F
```

A CJK run ends at any non-CJK code point; punctuation is never part of a run.
A frozen range is necessary but not sufficient: a code point joins a run only
when it is inside one of the ranges **and** its Unicode general category is
Letter (`L*`), Mark (`M*`), or Number (`N*`). This is a fixed Unicode
property-table lookup (`/[\p{L}\p{M}\p{N}]/u`) — no locale, no OS/language
dictionary, and no segmentation. The coarse ranges also contain non-word code
points, which are rejected so they separate runs instead of becoming tokens or
n-grams:

```text
punctuation P*   U+30A0 KATAKANA-HIRAGANA DOUBLE HYPHEN
                 U+30FB KATAKANA MIDDLE DOT
symbols S*       U+309B / U+309C spacing voiced sound marks
unassigned Cn    U+3040, U+3097, U+3098
```

Admitted marks keep legitimate kana inside the run's original raw span:
U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK is `Lm`, and the combining
U+3099 / U+309A dakuten/handakuten are `Mn`. `カ・ナ` therefore yields two runs
(`カ`, `ナ`) with no token, unigram, or bigram covering the middle dot.
Output is full run + unigrams + bigrams. Trigram is explicitly deferred and no
trigram option exists. Example for `中文搜索`:

```text
cjk.run      中文搜索
cjk.unigram  中 文 搜 索
cjk.bigram   中文 文搜 搜索
```

## Phrase clause

A `{ kind: "phrase" }` clause always keeps one `phrase.literal` token whose raw
span covers the complete clause text (`clause.text.slice(rawStart, rawEnd) === clause.text`)
and whose `value` is `NFKC -> toLowerCase` of the whole literal. The clause also
produces ordinary analysis tokens for future candidate generation. `phrase.literal`
is never replaced by n-grams; adjacency and hard-filtering are out of scope.

## Bounds and errors

All bounds are offline engineering guardrails, not product search limits or
performance targets. Any overflow throws and the whole call fails; nothing is
silently truncated. Bounds are aggregate across an entire
`analyzePositiveClauses` call, not per clause.

| option | default | meaning |
| --- | --- | --- |
| `asciiFold` | `true` | additive ASCII aliases |
| `maxInputCodeUnits` | `262144` | aggregate input UTF-16 code units |
| `maxGeneratedTokens` | `65536` | aggregate generated tokens before dedupe |
| `maxCjkRunCodePoints` | `8192` | single CJK run code points |

Errors are explicit:

- non-string `text`; non-array `clauses`; non-object clause; non-string clause
  `text`; `kind` other than `term`/`phrase`; unknown clause key; non-plain or
  unknown `options`; non-boolean `asciiFold`; non-integer limit -> `TypeError`
- unpaired UTF-16 surrogate; non-positive limit; any bound overflow -> `RangeError`

Empty string and empty clause array are valid and return empty results. The
analyzer never mutates its inputs.

## Fixture

`app/test/fixtures/search-analyzer-v1.json` is marked
`purpose: "behavior-contract"`, `relevanceLabels: null`. Its expected tokens are a
behavior golden, **not qrels, not relevance labels, and not a ranking target**.
They must never be used to approve analyzer-produced relevance.

## Benchmark

`node app/scripts/search-analyzer-benchmark.mjs [--iterations=N]` runs the fixture
correctness assertions first; a contract failure exits non-zero and emits no
performance numbers. It then reports wall/CPU/RSS and token counts for the
`phase1a-analyzer-text` and `phase1a-analyzer-clauses` strategies over an offline
synthetic corpus. There is no pass/fail threshold. Numbers are observations for
this corpus on this Node runtime only; they are not a "faster search", ranking,
accuracy, or relevance claim. The optional legacy-tokenizer reference is omitted
because this lane does not import a production retrieval environment and cannot
prove an exact frozen baseline.

## Internal checkpoints

A1 core contract (normalization, raw UTF-16 spans, validation, ordering/dedupe);
A2 lexical expansion (identifier whole + parts, ASCII-fold alias); A3 CJK +
clause wrapper (`phrase.literal`); A4 fixture/benchmark/docs. These are internal
checkpoints, not separate product phases.

## Files

```text
app/src/search/analyzer.js
app/test/search-analyzer.test.js
app/test/fixtures/search-analyzer-v1.json
app/scripts/search-analyzer-benchmark.mjs
docs/review/search-v2/analyzer/README.md
```

No existing file is modified and no production module imports the analyzer.
