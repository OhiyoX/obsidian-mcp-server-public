// Frozen 口径 for the web word-count badge (issue #430, matrix rows 1-2).
//
// Every expected value below is part of the frozen contract: changing one of them is a
// product decision, not a refactor. The same table is reproduced in
// `scratch/web-bases/U52/U52.HANDOFF.md` §2.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyGrapheme,
  countCharacters,
  countWords,
  formatCount,
  formatWordCountLabel,
  normalizeSource,
  segmentGraphemes,
  stripMarkdown,
  summarizeWordCount,
} from "../frontend/app/features/document/word-count.js";

const MODULE_URL = new URL("../frontend/app/features/document/word-count.js", import.meta.url);
const source = () => fs.readFileSync(fileURLToPath(MODULE_URL), "utf8");

// [name, input, words, characters (whitespace excluded), charactersWithWhitespace]
const FROZEN = [
  ["latin sentence", "Hello world", 2, 10, 11],
  ["latin word shapes", "don't well-known snake_case 3.14", 5, 29, 32],
  ["cjk only", "中文测试", 4, 4, 4],
  ["cjk + latin + digits", "Hello 世界 123", 4, 10, 12],
  ["japanese with cjk punctuation", "こんにちは、世界！", 7, 9, 9],
  ["korean hangul", "안녕하세요", 5, 5, 5],
  ["emoji zwj family", "family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} end", 3, 10, 12],
  ["emoji regional flag", "\u{1F1E8}\u{1F1F3} flag", 2, 5, 6],
  ["emoji with variation selector", "\u2764\uFE0F love", 2, 5, 6],
  ["emoji keycap", "\u0031\uFE0F\u20E3 done", 2, 5, 6],
  ["keycap digits are two emoji words", "\u0031\uFE0F\u20E3\u0032\uFE0F\u20E3", 2, 2, 2],
  ["keycap hash is one emoji word", "\u0023\uFE0F\u20E3", 1, 1, 1],
  ["devanagari consonant + vowel sign is one grapheme", "\u0915\u093E", 1, 1, 1],
  ["arabic number sign prepends a word grapheme", "\u0600a", 1, 1, 1],
  ["combining diacritics", "cafe\u0301 latte\u0301", 2, 9, 10],
  ["crlf line endings", "alpha\r\nbravo\r\n", 2, 10, 12],
  ["lone cr line endings", "alpha\rbravo\r", 2, 10, 12],
  ["whitespace only", " \t\n\u3000\n", 0, 0, 5],
  ["empty", "", 0, 0, 0],
  ["frontmatter stripped", "---\ntitle: Note\ntags: [a, b]\n---\n\nbody words here\n", 3, 13, 17],
  ["frontmatter with ... close", "---\ntitle: Note\n...\nbody words\n", 2, 9, 11],
  ["unterminated frontmatter stays text", "---\ntitle: Note\n\nbody\n", 3, 14, 19],
  ["heading markers dropped, text kept", "# Title\n\n## Sub title\n", 3, 13, 17],
  ["setext heading underline dropped", "Title\n=====\n\nbody\n", 2, 9, 13],
  ["bold / italic / strike markers dropped", "**bold** and *ital* and ~~struck~~\n", 5, 20, 25],
  ["link display text kept, url dropped", "see [display text](https://example.com/a/b) now\n", 4, 17, 21],
  ["wiki link basename kept", "see [[Path/To/Note Name]] now\n", 4, 14, 18],
  ["wiki link alias preferred", "see [[Path/To/Note|Alias Here]] now\n", 4, 15, 19],
  ["image alt and path dropped", "![alt words](img.png) and ![[embed.png]]\n", 1, 3, 8],
  ["reference link text kept", "see [text][ref] and [ref]: /url\n", 5, 20, 25],
  ["autolink dropped", "<https://example.com/x> done\n", 1, 4, 7],
  ["html tags dropped", "<span class=\"x\">hi</span> there\n", 2, 7, 11],
  ["html comment dropped", "before <!-- hidden words --> after\n", 2, 11, 14],
  ["fenced code body excluded", "before\n\n```js\nconst a = 1;\n```\n\nafter\n", 2, 11, 15],
  ["tilde fence body excluded", "before\n\n~~~\nraw text\n~~~\n\nafter\n", 2, 11, 15],
  ["inline code text kept, backticks dropped", "use `npm run build` now\n", 5, 17, 22],
  ["task checkbox marker dropped, text kept", "- [ ] do thing\n- [x] done thing\n", 4, 16, 20],
  ["blockquote marker dropped", "> quoted line\n", 2, 10, 12],
  ["list markers dropped", "- item one\n* item two\n1. first\n2) second\n", 6, 25, 31],
  ["thematic break dropped", "above\n\n---\n\nbelow\n", 2, 10, 15],
  ["table pipes are punctuation", "| a | b |\n| --- | --- |\n| 1 | 2 |\n", 4, 19, 34],
];

test("frozen input → expected counts (issue #430 matrix row 1-2)", () => {
  // Collect every mismatch instead of failing on the first row, so a RED run names each frozen
  // sample (the keycap / Devanagari / Prepend rows are the regression witnesses for this fix).
  const failures = [];
  for (const [name, input, words, characters, charactersWithWhitespace] of FROZEN) {
    const actual = summarizeWordCount(input);
    const expected = { words, characters, charactersWithWhitespace };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${name}: ${JSON.stringify(input)} -> ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
    }
  }
  assert.deepEqual(failures, []);
});

test("CRLF and LF inputs produce identical counts (issue #430 matrix row 1)", () => {
  const lf = "---\ntitle: x\n---\n\n# Head\n\nbody **words** [link](u)\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.deepEqual(summarizeWordCount(crlf), summarizeWordCount(lf));
});

test("grapheme segmentation keeps ZWJ / VS16 / flag sequences whole", () => {
  const cases = [
    ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", 1],
    ["\u{1F1E8}\u{1F1F3}", 1],
    ["\u2764\uFE0F", 1],
    ["\u0031\uFE0F\u20E3", 1],
    ["cafe\u0301", 4],
    ["\u{1F600}", 1],
  ];
  for (const [input, expected] of cases) {
    assert.equal(segmentGraphemes(input).length, expected, JSON.stringify(input));
  }
});

test("character counting is grapheme-aware, not UTF-16 aware", () => {
  const input = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  assert.ok(input.length > 1, "the raw string must be several UTF-16 code units");
  assert.equal(countCharacters(input), 1);
  assert.equal(countCharacters(input, { includeWhitespace: true }), 1);
});

test("grapheme classes drive the word unit decision", () => {
  assert.equal(classifyGrapheme("a"), "word");
  assert.equal(classifyGrapheme("9"), "word");
  assert.equal(classifyGrapheme("中"), "cjk");
  assert.equal(classifyGrapheme("あ"), "cjk");
  assert.equal(classifyGrapheme("한"), "cjk");
  assert.equal(classifyGrapheme("\u{1F600}"), "emoji");
  assert.equal(classifyGrapheme("\u2764\uFE0F"), "emoji");
  // A keycap sequence starts with an ASCII digit/`#` but is one emoji grapheme, not a word/other.
  assert.equal(classifyGrapheme("\u0031\uFE0F\u20E3"), "emoji");
  assert.equal(classifyGrapheme("\u0023\uFE0F\u20E3"), "emoji");
  assert.equal(classifyGrapheme("\u0915\u093E"), "word");
  assert.equal(classifyGrapheme(" "), "whitespace");
  assert.equal(classifyGrapheme("\u3000"), "whitespace");
  assert.equal(classifyGrapheme("|"), "other");
  // A text-default pictograph without VS16 is punctuation, not an emoji word.
  assert.equal(classifyGrapheme("\u00A9"), "other");
});

test("word runs keep internal joiners and split on other punctuation", () => {
  assert.equal(countWords("don't"), 1);
  assert.equal(countWords("well-known"), 1);
  assert.equal(countWords("snake_case"), 1);
  assert.equal(countWords("3.14"), 2);
  assert.equal(countWords("a - b"), 2);
  assert.equal(countWords("a--b"), 2);
});

test("normalizeSource folds CRLF and CR to LF", () => {
  assert.equal(normalizeSource("a\r\nb\rc\n"), "a\nb\nc\n");
});

test("stripMarkdown keeps readable text and drops syntax", () => {
  assert.equal(stripMarkdown("**bold**").trim(), "bold");
  assert.equal(stripMarkdown("# Head"), "Head");
  assert.equal(stripMarkdown("---\nk: v\n---\nbody").trim(), "body");
  assert.equal(stripMarkdown("- [ ] task").trim(), "task");
  assert.equal(stripMarkdown("![alt](a.png)").trim(), "");
  assert.equal(stripMarkdown("[[Path/Note|x]]").trim(), "x");
  assert.equal(stripMarkdown("[[Path/Note]]").trim(), "Note");
  assert.equal(stripMarkdown("[[Path/Note#Head]]").trim(), "Note");
});

test("the grapheme fast path never splits a cluster the segmenter keeps whole", () => {
  // The fast path is a hand-written "this text cannot contain a multi-code-point grapheme" test;
  // a missing code point silently splits a cluster and corrupts the character count. Sweep every
  // BMP code point in five joining contexts against the real segmenter, and sample the astral
  // planes (the pattern covers them with one blanket range).
  const segmenter = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  if (!segmenter) return; // the documented fallback is asserted separately below
  const intlSegments = (text) => [...segmenter.segment(text)].map((part) => part.segment);
  const contexts = (character) => [character + "a", "a" + character, character + "\u0301", "\u1100" + character, character + "\u11A8"];
  const failures = [];
  for (let code = 0; code <= 0xffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const character = String.fromCodePoint(code);
    for (const sample of contexts(character)) {
      if (segmentGraphemes(sample).length !== intlSegments(sample).length) {
        failures.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")} in ${JSON.stringify(sample)}`);
        break;
      }
    }
  }
  assert.deepEqual(failures, [], "the fast-path condition must cover every joining code point");
  for (const character of ["\u{1F1E8}", "\u{1F600}", "\u{1F468}", "\u{1F3FB}", "\u{1D400}", "\u{20000}"]) {
    for (const sample of contexts(character)) {
      assert.equal(segmentGraphemes(sample).length, intlSegments(sample).length, JSON.stringify(sample));
    }
  }
});

test("the no-Segmenter fallback keeps its documented (over-counting) numbers", () => {
  // The frozen table above is the Intl.Segmenter contract. Without a segmenter the module falls
  // back to code-point iteration, which over-counts keycap/variation sequences; freeze that too so
  // the limitation is stated, not assumed, and so narrowing the fast path can never be mistaken
  // for fixing the fallback. Runs in a child process because the segmenter cache is module-global.
  const samples = [
    ["\u0031\uFE0F\u20E3\u0032\uFE0F\u20E3", { words: 6, characters: 6, charactersWithWhitespace: 6 }],
    ["\u0023\uFE0F\u20E3", { words: 2, characters: 3, charactersWithWhitespace: 3 }],
    ["\u0915\u093E", { words: 1, characters: 2, charactersWithWhitespace: 2 }],
    ["\u0600a", { words: 1, characters: 2, charactersWithWhitespace: 2 }],
  ];
  const script = [
    "delete Intl.Segmenter;",
    `const { summarizeWordCount } = await import(${JSON.stringify(MODULE_URL.href)});`,
    `const inputs = ${JSON.stringify(samples.map(([input]) => input))};`,
    "console.log(JSON.stringify(inputs.map((input) => summarizeWordCount(input))));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const line = output.trim().split("\n").at(-1);
  assert.deepEqual(JSON.parse(line), samples.map(([, expected]) => expected));
});

test("thousands grouping is deterministic and locale-independent", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(1234), "1,234");
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatCount(-5), "0");
  assert.equal(formatCount("nope"), "0");
  assert.deepEqual(formatWordCountLabel({ words: 1234, characters: 1567 }), {
    words: "字数 1,234",
    characters: "字符 1,567",
    full: "字数 1,234，字符 1,567（字符数不含空白）",
  });
});

test("counting is pure: repeated calls agree and the input string is never mutated", () => {
  const input = "**bold** 中文 [link](u) \u{1F600}\r\n";
  const snapshot = String(input);
  const first = summarizeWordCount(input);
  const second = summarizeWordCount(input);
  assert.deepEqual(first, second);
  assert.equal(input, snapshot, "the source string must be untouched");
});

test("the counter cannot write anywhere (issue #430: 0 file / 0 network / 0 save)", () => {
  const text = source();
  for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "navigator.sendBeacon", "require(", "node:fs", "process.env", "document.createElement", "document.querySelector", "globalThis.document", "window."]) {
    assert.ok(!text.includes(forbidden), `word-count.js must not reference ${forbidden}`);
  }
  assert.ok(!/\bdocument\s*\.\s*(?:createElement|querySelector|getElementById|body|head|documentElement)\b/.test(text), "word-count.js must not touch the DOM");
});
