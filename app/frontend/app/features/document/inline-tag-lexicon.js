/**
 * Obsidian's inline-tag lexeme, shared by both hosts.
 *
 * Issue #484 measured the two hosts disagreeing: Reading's `obsidianTags`
 * (markdown-it) accepted a tag preceded by `(`, `[` or `{` while Live
 * Preview's `decorated()` pattern required whitespace, so `(#paren)` was a tag
 * pill in Reading and plain text in Live. This module is the single lexer both
 * hosts call; neither may keep a private copy of the pattern (locked by
 * `test/inline-tag-lexicon-shared.test.js`, which compares the two hosts'
 * output on one matrix and fails if a hand-written tag pattern reappears).
 *
 * The lexeme (Obsidian's own grammar, already pinned by the Reading host):
 *   - starts at `#`;
 *   - is preceded by nothing, whitespace, or one of `(`, `[`, `{` — so
 *     `(#paren)` and `[#tag]` are tags, `word#tag` is not;
 *   - body is `[\p{L}\p{N}_/-]+`;
 *   - must contain at least one non-numeric `[\p{L}_/-]` character, so `#7`
 *     and `#123` stay ordinary text (issue references in a changelog);
 *   - ends at the first character outside the body class, so `#v2026.10.01`
 *     is `#v2026` and `#tag)` is `#tag`.
 *
 * Deliberately NOT a lexeme rule (the host decides those, because they need
 * syntax context the characters alone do not carry):
 *   - URL fragments and link targets (`[a](#sec)`, `https://x/#frag`) — the
 *     Reading host never reaches them because markdown-it's `link` rule
 *     consumes the destination first; the Live host excludes the Lezer
 *     `URL` / `LinkTitle` / `Autolink` ranges instead;
 *   - escaped `\#tag` — `\` is not in the boundary set, so the `#` simply has
 *     no valid predecessor;
 *   - code, frontmatter and HTML, which the Live host filters through
 *     `excludedSyntaxRanges()`.
 */

/** The tag body class. Exported so the drift test can assert one source. */
export const INLINE_TAG_BODY_SOURCE = String.raw`[\p{L}\p{N}_/-]+`;

const INLINE_TAG_PATTERN = new RegExp(
  String.raw`^#(?=[\p{L}\p{N}_/-]*[\p{L}_/-])${INLINE_TAG_BODY_SOURCE}`,
  "u",
);

/** The characters Obsidian accepts immediately before a tag's `#`. */
const TAG_BOUNDARY = /[\s([{]/u;

/** True when `previous` (one character, or "" at a text start) may precede a tag. */
export function isInlineTagBoundary(previous) {
  if (previous == null || previous === "") return true;
  return TAG_BOUNDARY.test(previous);
}

/**
 * The tag starting exactly at `source[index]`, or `null`.
 *
 * `blockStart` marks an index that is the beginning of a block's inline
 * content (markdown-it's `state.pos === 0`, or a Live scan offset the caller
 * proved to be one). Such an index has no predecessor to test — this is what
 * makes `>#tag`, a blockquote marker glued to the tag, behave the same in both
 * hosts.
 */
export function matchInlineTagAt(source, index, { blockStart = false } = {}) {
  const text = String(source ?? "");
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= text.length) return null;
  if (text[position] !== "#") return null;
  if (position > 0 && !blockStart && !isInlineTagBoundary(text[position - 1])) return null;
  const match = INLINE_TAG_PATTERN.exec(text.slice(position));
  if (!match) return null;
  return { raw: match[0], tag: match[0].slice(1), length: match[0].length };
}

/**
 * Every inline tag in one scanned text as `{from, to, tag, raw}`, where
 * `from`/`to` are indices into `text`.
 *
 * `boundaryOffsets` are additional indices inside `text` that count as a
 * block's inline-content start. The Live host passes the end of each Lezer
 * `QuoteMark` (and `ListMark`) on the line, so the scan sees the same content
 * start markdown-it sees; it is the caller's job to translate absolute
 * document offsets into offsets local to `text`.
 */
export function findInlineTags(text, { boundaryOffsets = [] } = {}) {
  const source = String(text ?? "");
  const blockStarts = new Set();
  for (const offset of boundaryOffsets) {
    const value = Number(offset);
    if (Number.isInteger(value) && value > 0) blockStarts.add(value);
  }
  const tags = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === "#") {
      const match = matchInlineTagAt(source, index, { blockStart: blockStarts.has(index) });
      if (match) {
        tags.push({ from: index, to: index + match.length, tag: match.tag, raw: match.raw });
        index += match.length;
        continue;
      }
    }
    index += 1;
  }
  return tags;
}
