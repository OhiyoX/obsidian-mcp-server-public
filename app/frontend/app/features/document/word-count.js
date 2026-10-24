// Word / character counting for the body-pane word-count badge (issue #430).
//
// Pure, read-only and dependency-free on purpose: the module is bundled into the shell
// entry (`core/app.js`, through the session status presenter), so it must not pull in the
// deferred reader/editor bundles. It never touches the DOM, the network, the disk or any
// session/editor object — callers hand it the raw Markdown string and read back numbers.
//
// Frozen 口径 (the authoritative samples live in `test/word-count.test.js`; the same table
// is repeated in `scratch/web-bases/U52/U52.HANDOFF.md`):
//
//   Input
//   - The live raw Markdown source of the currently committed open note (`session.liveText`),
//     including unsaved local edits. Live / RAW / Reader hand in the *same* string: nothing
//     here reads rendered DOM.
//   - CRLF and lone CR are normalised to LF before anything is counted, so a CRLF checkout
//     counts identically to an LF one.
//
//   Markdown reduction (strip syntax, keep readable text)
//   - Removed: YAML frontmatter (leading `---` … `---`/`...`), fenced code blocks *including
//     their body*, HTML comments, HTML tags, images and embeds (image alt text is NOT counted),
//     link/autolink URLs, heading `#` markers, blockquote `>` markers, list markers,
//     thematic-break and setext-underline lines, task checkbox markers (`[ ]` / `[x]`),
//     emphasis markers (`*`, `**`, `_`, `~~`) that are not word-internal, and inline-code
//     backticks (the inline-code text itself stays).
//   - Kept: heading text, link display text, wiki-link alias (or the note basename when there
//     is no alias), blockquote/list/task body text, inline-code text, table cell text.
//   - Not special-cased (documented gap, frozen): indented (4-space) code blocks, table
//     delimiter rows and footnote/MathJax syntax stay in the text; their `|`/`-`/`$`
//     characters are punctuation (never word units) but they do count as characters.
//
//   Words
//   - One word unit per: CJK ideograph / kana / Hangul syllable grapheme; emoji grapheme
//     (Emoji_Presentation, regional indicator, ZWJ sequence, VS16 sequence, keycap sequence).
//   - One word unit per maximal run of letter/number graphemes, where an internal `'`, `’`,
//     `-` or `_` between two letter/number graphemes does not break the run
//     (`don't` = 1, `well-known` = 1, `snake_case` = 1, `3.14` = 2).
//   - Whitespace and all other punctuation contribute nothing.
//
//   Characters
//   - Grapheme clusters (not UTF-16 code units), so surrogate pairs and ZWJ sequences are 1.
//   - `characters` excludes whitespace; `charactersWithWhitespace` includes it.
//
//   `Intl.Segmenter` is used when available; the fallback is code-point iteration, which
//   over-counts keycap/VS16/ZWJ sequences and splits SpacingMark/Prepend clusters (frozen in the
//   no-Segmenter table in `test/word-count.test.js`, and unreachable on the supported
//   Chromium/Node targets).

const CJK_PATTERN = /[\u1100-\u11FF\u2E80-\u2EFF\u3005\u3006\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF\uF900-\uFAFF\uFE30\uFE31\uFE45\uFE46\uFF66-\uFF9D]|[\u{20000}-\u{2FA1F}]/u;
const EMOJI_PATTERN = /[\p{Emoji_Presentation}\p{Regional_Indicator}\u{20E3}\u200D\uFE0F]/u;
const WORD_GRAPHEME_PATTERN = /[\p{L}\p{N}]/u;
const INVISIBLE_GRAPHEMES = new Set(["\u200B", "\u2060", "\uFEFF"]);
const WORD_JOINERS = new Set(["'", "\u2019", "-", "_"]);
const THEMATIC_BREAK_PATTERN = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE_PATTERN = /^[ \t]*=+[ \t]*$/;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

// `Intl.Segmenter` is the correct general answer, but it costs ~65 ms per megabyte while the
// badge recomputes during typing. When the text cannot contain a multi-code-point grapheme, code
// points and grapheme clusters are the same thing, so a plain code-point walk is exact and ~5x
// cheaper. "Cannot contain" must cover *every* code point that may join a neighbour under
// UAX #29 (GB9/GB9a/GB9b/GB11 plus the Hangul and regional-indicator rules): combining marks
// (`\p{M}` = Mn + Mc/SpacingMark + Me), `Other_Grapheme_Extend` (`\p{Grapheme_Extend}`), ZWJ,
// the conjoining Hangul jamo and syllables (LV/LVT vowels and trailing jamo), the two SpacingMark
// Lo exceptions (U+0E33/U+0EB3), the Prepend format characters, CR (CR×LF), and every astral code
// point (RI pairs, ZWJ emoji, extended pictographs). Everything else still goes through the
// segmenter, and the code-point walk remains the documented fallback when `Intl.Segmenter` is
// unavailable. The condition must be a *superset* of the joining set: missing one code point
// silently splits its cluster and corrupts the character count (`का`, `؀a`), while over-including
// only costs one segmenter pass. `test/word-count.test.js` sweeps every BMP code point against
// the real segmenter to keep this honest.
const COMPLEX_GRAPHEME_PATTERN = /[\u200D\uFF9E\uFF9F\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u0D4E\u0E33\u0EB3\u1100-\u11FF\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF\u{10000}-\u{10FFFF}\r\p{Grapheme_Extend}\p{M}]/u;

let cachedSegmenter = null;
let segmenterUnavailable = false;

function graphemeSegmenter() {
  if (cachedSegmenter || segmenterUnavailable) return cachedSegmenter;
  if (typeof Intl !== "object" || typeof Intl?.Segmenter !== "function") {
    segmenterUnavailable = true;
    return null;
  }
  try {
    cachedSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    segmenterUnavailable = true;
  }
  return cachedSegmenter;
}

/**
 * Visit every grapheme cluster of `text` without materializing an array. Hot path: called once
 * per badge refresh, on the whole document.
 */
export function forEachGrapheme(text, visit) {
  const value = String(text ?? "");
  const segmenter = COMPLEX_GRAPHEME_PATTERN.test(value) ? graphemeSegmenter() : null;
  if (segmenter) {
    for (const part of segmenter.segment(value)) visit(part.segment);
    return;
  }
  for (const codePoint of value) visit(codePoint);
}

export function normalizeSource(text) {
  return String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function segmentGraphemes(text) {
  const out = [];
  forEachGrapheme(text, (grapheme) => out.push(grapheme));
  return out;
}

export function isWhitespaceGrapheme(grapheme) {
  const value = String(grapheme ?? "");
  if (!value) return false;
  return INVISIBLE_GRAPHEMES.has(value) || /^\s+$/u.test(value);
}

export function classifyGrapheme(grapheme) {
  const value = String(grapheme ?? "");
  if (!value) return "other";
  const code = value.codePointAt(0);
  // ASCII / BMP fast paths: the common cases avoid up to four regex tests per grapheme. The
  // single-code-unit guard is essential: a multi-code-point grapheme that starts with ASCII
  // (`1️⃣`, `#️⃣`) is a keycap emoji cluster, not a digit or punctuation.
  if (value.length === 1 && code < 0x80) {
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return "whitespace";
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return "word";
    return "other";
  }
  if (value.length === 1) {
    if (code === 0x3000) return "whitespace";
    if (
      (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
    ) return "cjk";
  }
  if (isWhitespaceGrapheme(value)) return "whitespace";
  if (CJK_PATTERN.test(value)) return "cjk";
  if (EMOJI_PATTERN.test(value)) return "emoji";
  if (WORD_GRAPHEME_PATTERN.test(value)) return "word";
  return "other";
}

/**
 * One classified pass over the grapheme clusters, producing all three numbers at once. The
 * previous revision segmented the document three times (words, characters, characters with
 * whitespace); on a 1 MB note that was the dominant cost, and the badge refreshes while typing.
 *
 * The word-run state machine is exactly equivalent to "a maximal run of word graphemes where a
 * single internal `'`/`’`/`-`/`_` continues the run": at most one joiner may sit between two word
 * graphemes, so `a-b` is one word while `a--b` and `a - b` are two.
 */
function createCounters() {
  let words = 0;
  let characters = 0;
  let charactersWithWhitespace = 0;
  let inRun = false;
  let joinerPending = false;
  return {
    push(grapheme) {
      const kind = classifyGrapheme(grapheme);
      if (kind === "whitespace") {
        inRun = false;
        joinerPending = false;
        charactersWithWhitespace += 1;
        return;
      }
      charactersWithWhitespace += 1;
      characters += 1;
      if (kind === "word") {
        if (!inRun) words += 1;
        inRun = true;
        joinerPending = false;
        return;
      }
      if (kind === "cjk" || kind === "emoji") {
        words += 1;
        inRun = false;
        joinerPending = false;
        return;
      }
      if (inRun && !joinerPending && WORD_JOINERS.has(grapheme)) {
        joinerPending = true;
        return;
      }
      inRun = false;
      joinerPending = false;
    },
    counts() {
      return { words, characters, charactersWithWhitespace };
    },
  };
}

function countOf(text) {
  const counters = createCounters();
  forEachGrapheme(text, (grapheme) => counters.push(grapheme));
  return counters.counts();
}

export function countWords(source) {
  return countOf(String(source ?? "")).words;
}

export function countCharacters(source, { includeWhitespace = false } = {}) {
  const counts = countOf(String(source ?? ""));
  return includeWhitespace ? counts.charactersWithWhitespace : counts.characters;
}

/**
 * Single entry point for the badge: raw Markdown in, frozen counts out.
 * `characters` excludes whitespace; `charactersWithWhitespace` includes it.
 */
export function summarizeWordCount(source) {
  return countOf(stripMarkdown(source));
}

// The leading `---` block is frontmatter only when it opens on the very first line and is
// closed by a `---` / `...` line. An unterminated block is treated as ordinary body text.
function stripFrontmatter(text) {
  const lines = text.split("\n");
  const first = (lines[0] ?? "").replace(/^\uFEFF/, "");
  if (first.trim() !== "---") return text;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "---" || line === "...") return lines.slice(index + 1).join("\n");
  }
  return text;
}

// Fenced code blocks are removed entirely (opening fence, body and closing fence). The
// closing fence must repeat the opening character at least as many times and carry no info
// string; an unterminated fence swallows the rest of the document, as in CommonMark.
function stripFencedCode(text) {
  const lines = text.split("\n");
  const kept = [];
  let open = null;
  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line);
    if (open) {
      if (match && match[1][0] === open.char && match[1].length >= open.length && /^[ \t]*$/.test(match[2])) open = null;
      continue;
    }
    if (match && (match[1][0] === "~" || !match[2].includes("`"))) {
      open = { char: match[1][0], length: match[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function wikiLinkLabel(target) {
  const withoutFragment = String(target ?? "").split("#")[0].split("|")[0].trim();
  const lastSegment = withoutFragment.split("/").pop() ?? "";
  return lastSegment.replace(/\.md$/i, "");
}

function stripInlineSyntax(text) {
  let value = text;
  value = value.replace(/<!--[\s\S]*?-->/g, "");
  // Embeds and images first: an image's alt text / target is not readable prose.
  value = value.replace(/!\[\[[^\]]*\]\]/g, " ");
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  value = value.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ");
  value = value.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => (alias ? alias : wikiLinkLabel(target)));
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  value = value.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  value = value.replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, " ");
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  value = value.replace(/`+([^`]*)`+/g, "$1");
  value = value.replace(/(?:\*\*|__|~~)([\s\S]*?)(?:\*\*|__|~~)/g, "$1");
  return value;
}

// Emphasis markers matter for the character count only; a `_` between two word graphemes is
// kept so `snake_case` stays one word (the word scan treats it as an internal joiner).
function stripEmphasisMarkers(text) {
  return text.replace(/[*_~]+/g, (match, offset, source) => {
    const before = source[offset - 1];
    const after = source[offset + match.length];
    const joined = before && after && WORD_GRAPHEME_PATTERN.test(before) && WORD_GRAPHEME_PATTERN.test(after);
    return joined ? match : "";
  });
}

function stripLineMarkers(text) {
  return text.split("\n").map((line) => {
    if (THEMATIC_BREAK_PATTERN.test(line) || SETEXT_UNDERLINE_PATTERN.test(line)) return "";
    let next = line.replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/, "");
    next = next.replace(/^[ \t]*(?:>[ \t]?)+/, "");
    next = next.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/, "");
    next = next.replace(/^[ \t]*\[[ xX]\](?=[ \t]|$)[ \t]*/, "");
    return next;
  }).join("\n");
}

/**
 * Reduce raw Markdown to the readable text the counts are taken from.
 * Line endings are normalised as part of the reduction.
 */
export function stripMarkdown(source) {
  let text = normalizeSource(source);
  text = stripFrontmatter(text);
  text = stripFencedCode(text);
  text = stripInlineSyntax(text);
  text = stripLineMarkers(text);
  return stripEmphasisMarkers(text);
}

export function formatCount(value) {
  const number = Math.max(0, Math.trunc(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatWordCountLabel(counts) {
  const words = formatCount(counts?.words);
  const characters = formatCount(counts?.characters);
  return { words: `字数 ${words}`, characters: `字符 ${characters}`, full: `字数 ${words}，字符 ${characters}（字符数不含空白）` };
}
