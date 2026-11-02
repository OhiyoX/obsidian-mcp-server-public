// Search-result excerpt highlighting (U4).
//
// The frozen v2 search contract returns plain-text excerpts only
// (`item.snippets[]`, no highlight markers), so a hit has to be re-located in the
// excerpt text on the client. Only *literal* query words are candidates: query
// operators (path:/file:/tag:/line:/section:, `[property]`), negations and the
// OR/AND keywords are stripped first. A `<mark>` therefore can never claim a match
// the server did not return; when nothing matches, the excerpt renders untouched.
const BOOLEAN_KEYWORDS = new Set(["or", "and"]);
// `[property]`, `[property:value]`, and `key:value` / `key:"quoted value"` values.
const BRACKET_OPERATOR = /\[[^\]]*\]/g;
const KEYED_OPERATOR = /(^|\s)-?[a-zA-Z][\w-]*:(?:"[^"]*"|[^\s]+)/g;
const TERM_PATTERN = /"([^"]+)"|(\S+)/g;
// U12: `tag:` is the one keyed operator whose *value* is part of the excerpt. The tag
// excerpts are the real document lines, where the tag shows up bare (`- deployment`) or as
// an inline `#deployment` -- never as `tag:#deployment`. The tag name (plus its `#` form,
// so an inline occurrence is marked whole) therefore joins the literal terms, while the
// generic pass below still strips the operator itself.
const TAG_OPERATOR = /(^|\s)(-?)tag:(?:"([^"]*)"|(\S+))/g;

export function extractTagNames(query) {
  const names = [];
  TAG_OPERATOR.lastIndex = 0;
  let match;
  while ((match = TAG_OPERATOR.exec(String(query ?? ""))) !== null) {
    // A negated clause cannot be why the note matched, so it is not a highlight term.
    if (match[2] === "-") continue;
    const name = String(match[3] ?? match[4] ?? "").trim().replace(/^#+/, "").replace(/\/+$/, "");
    if (!name) continue;
    names.push(name, `#${name}`);
  }
  return names;
}

export function extractHighlightTerms(query) {
  const source = String(query ?? "");
  const tagNames = extractTagNames(source);
  const stripped = source
    .replace(BRACKET_OPERATOR, " ")
    .replace(KEYED_OPERATOR, " ");
  const terms = [];
  TERM_PATTERN.lastIndex = 0;
  let match;
  while ((match = TERM_PATTERN.exec(stripped)) !== null) {
    if (match[1] !== undefined) {
      const phrase = match[1].trim();
      if (phrase) terms.push(phrase);
      continue;
    }
    const token = match[2];
    if (!token || token.startsWith("-")) continue;
    if (BOOLEAN_KEYWORDS.has(token.toLowerCase())) continue;
    terms.push(token);
  }
  return dedupe([...tagNames, ...terms]);
}

function dedupe(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Splits `text` into ordered segments, flagging the ones that are a real hit. Terms are
// matched longest-first so a phrase is not split apart by one of its own words.
export function highlightSegments(text, terms = [], { caseSensitive = false } = {}) {
  const value = String(text ?? "");
  if (!value) return [];
  const needles = (Array.isArray(terms) ? terms : [])
    .map((term) => String(term ?? ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!needles.length) return [{ text: value, match: false }];

  const pattern = new RegExp(needles.map(escapeRegExp).join("|"), caseSensitive ? "g" : "gi");
  const segments = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) segments.push({ text: value.slice(cursor, match.index), match: false });
    segments.push({ text: match[0], match: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), match: false });
  return segments;
}
