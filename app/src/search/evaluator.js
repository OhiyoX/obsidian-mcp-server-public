import { extractInlineTags, normalizeTag } from "../obsidian.js";

function normalize(value, caseSensitive) {
  const text = String(value ?? "").normalize("NFKC");
  return caseSensitive ? text : text.toLocaleLowerCase();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
}

function countMatches(haystack, needle, options) {
  if (!options.wholeWord && !options.flexibleWhitespace) return countOccurrences(haystack, needle);
  let source = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.flexibleWhitespace) source = source.replace(/\s+/g, "\\s+");
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])${source}(?![\\p{L}\\p{N}_])`;
  return [...haystack.matchAll(new RegExp(source, "gu"))].length;
}

function propertyEntry(frontmatter, key, caseSensitive) {
  const wanted = normalize(key, caseSensitive);
  return Object.entries(frontmatter || {}).find(([name]) => normalize(name, caseSensitive) === wanted);
}

function propertyText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(propertyText).join(" ");
  return Object.entries(value).map(([key, nested]) => `${key} ${propertyText(nested)}`).join(" ");
}

function sectionTexts(content) {
  const lines = String(content || "").split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match ? [{ index, level: match[1].length }] : [];
  });
  if (!headings.length) return [lines.join("\n")];
  const sections = headings.map((heading, headingIndex) => {
    const next = headings.slice(headingIndex + 1).find((candidate) => candidate.level <= heading.level);
    return lines.slice(heading.index, next?.index ?? lines.length).join("\n");
  });
  if (headings[0].index > 0) sections.unshift(lines.slice(0, headings[0].index).join("\n"));
  return sections;
}

// One excerpt window around a *known* match offset. `makeSnippet` keeps the historical
// first-occurrence lookup; the U5 web layer enumerates occurrences itself and reuses this
// exact window shape through `expandOccurrenceSnippets`.
function snippetWindow(text, index, matchLength, contextLength) {
  const start = Math.max(0, index - contextLength);
  const end = Math.min(text.length, index + matchLength + contextLength);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function makeSnippet(text, needle, contextLength) {
  const normalizedText = String(text || "");
  const index = normalizedText.toLocaleLowerCase().indexOf(String(needle).toLocaleLowerCase());
  if (index < 0) return normalizedText.slice(0, contextLength * 2).trim();
  return snippetWindow(normalizedText, index, String(needle).length, contextLength);
}

// Literal (not regex) occurrence offsets of `needle` in `haystack`. Both are already in
// the comparison case, so the offsets index the document this window is cut from.
function occurrenceOffsets(haystack, needle) {
  const offsets = [];
  if (!needle) return offsets;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    offsets.push(offset);
    offset += Math.max(1, needle.length);
  }
  return offsets;
}

// The `record.tags` entries a tag clause accepts, paired with the query value that
// accepted them (needed for the U12 excerpt window, which has to point at the query's
// own tag name). Frozen semantics: exact tag, or a nested tag under the queried parent.
function matchedTags(record, clause, caseSensitive) {
  const needles = (clause.values || [clause.value]).map((value) => normalize(value, caseSensitive));
  const pairs = [];
  for (const item of needles) {
    const wanted = item.replace(/^#/, "").replace(/\/$/, "");
    for (const tag of record.tags || []) {
      const normalizedTag = normalize(tag, caseSensitive).replace(/^#/, "");
      if (normalizedTag === wanted || normalizedTag.startsWith(`${wanted}/`)) pairs.push({ tag, needle: wanted });
    }
  }
  return pairs;
}

function matchClause(record, clause, options) {
  const caseSensitive = options.caseSensitive === true;
  const needles = (clause.values || [clause.value]).map((value) => normalize(value, caseSensitive));
  const needle = needles[0];
  let values = [];
  if (clause.type === "path") values = [record.path];
  else if (clause.type === "file") values = [record.basename, record.name];
  else if (clause.type === "tag") {
    const matches = matchedTags(record, clause, caseSensitive).map((pair) => pair.tag);
    return { matched: needles.every((item) => matches.some((tag) => {
      const normalizedTag = normalize(tag, caseSensitive).replace(/^#/, "");
      const wanted = item.replace(/^#/, "").replace(/\/$/, "");
      return normalizedTag === wanted || normalizedTag.startsWith(`${wanted}/`);
    })), count: matches.length, snippets: matches.map((tag) => `#${tag}`) };
  } else if (clause.type === "property") {
    const entry = propertyEntry(record.frontmatter, clause.key, caseSensitive);
    if (!entry) return { matched: false, count: 0, snippets: [] };
    if (clause.value === null) return { matched: true, count: 1, snippets: [`[${entry[0]}]`] };
    const text = normalize(propertyText(entry[1]), caseSensitive);
    const count = countMatches(text, needle, options);
    return { matched: count > 0, count, snippets: count ? [`[${entry[0]}: ${propertyText(entry[1])}]`] : [] };
  } else if (clause.type === "content") values = [record.content];
  else if (clause.type === "line") values = String(record.content || "").split(/\r?\n/);
  else if (clause.type === "section") values = sectionTexts(record.content);
  else values = [options.includeFrontmatter === false ? record.content : record.raw];
  let count = 0;
  const snippets = [];
  for (const value of values) {
    const text = normalize(value, caseSensitive);
    const occurrences = needles.map((item) => countMatches(text, item, options));
    const current = occurrences.every(Boolean) ? occurrences.reduce((sum, item) => sum + item, 0) : 0;
    count += current;
    if (current && snippets.length < options.maxMatchesPerNote) snippets.push(makeSnippet(value, clause.values?.[0] || clause.value, options.contextLength));
  }
  return { matched: count > 0, count, snippets };
}

function clausePasses(record, clause, options, semanticCandidate) {
  const textual = ["text", "content", "line", "section"].includes(clause.type);
  if (semanticCandidate && textual && !clause.negated) return { passed: true, count: 0, snippets: [] };
  const result = matchClause(record, clause, options);
  return { ...result, passed: clause.negated ? !result.matched : result.matched };
}

// The first OR-group whose clauses all pass, with each clause outcome. Shared by the
// frozen evaluator and the U5 web-layer excerpt expansion so both agree on the group.
function selectGroup(record, parsed, settings) {
  const candidates = parsed.groups.map((group) => {
    const outcomes = group.map((clause) => ({ clause, ...clausePasses(record, clause, settings, settings.semanticCandidate) }));
    return { passed: outcomes.every((outcome) => outcome.passed), outcomes };
  });
  return candidates.find((candidate) => candidate.passed) || null;
}

// Web v2 excerpt expansion (U5). Pure and additive: `evaluateObsidianQuery` (and therefore
// the MCP `search_notes` payload) is untouched. Returns one excerpt per literal occurrence
// of every positive textual clause of the selected group, in document order, dropping only
// occurrences that overlap an already-emitted one. The caller dedupes and caps the list.
//
// The whole-document text clause is why the evaluator alone can only offer one excerpt per
// note: its `values` is the entire document, so its loop runs once. The Web layer re-scans
// the very same record (no extra file read) occurrence by occurrence.
export function expandOccurrenceSnippets(record, parsed, options = {}) {
  const settings = { contextLength: 120, maxMatchesPerNote: 10, ...options };
  if (!parsed?.groups?.length) return [];
  const selected = selectGroup(record, parsed, settings);
  if (!selected) return [];
  const buckets = [];
  const bucketFor = (key, text) => {
    let bucket = buckets.find((candidate) => candidate.key === key);
    if (!bucket) {
      // The comparison case is fixed per bucket, so normalize the haystack once.
      bucket = { key, text, haystack: settings.caseSensitive === true ? text : text.toLocaleLowerCase(), hits: [] };
      buckets.push(bucket);
    }
    return bucket;
  };
  for (const outcome of selected.outcomes) {
    const clause = outcome.clause;
    if (clause.negated) continue;
    if (clause.type !== "text" && clause.type !== "content") continue;
    const wholeDocument = clause.type === "content" || settings.includeFrontmatter === false;
    const bucket = bucketFor(wholeDocument ? "content" : "raw", wholeDocument ? String(record.content ?? "") : String(record.raw ?? ""));
    const needles = (clause.values || [clause.value] || []).filter((value) => value !== undefined && value !== null && String(value) !== "");
    for (const needle of needles) {
      const wanted = settings.caseSensitive === true ? String(needle) : String(needle).toLocaleLowerCase();
      for (const index of occurrenceOffsets(bucket.haystack, wanted)) bucket.hits.push({ index, length: wanted.length });
    }
  }
  const snippets = [];
  for (const bucket of buckets) {
    bucket.hits.sort((left, right) => left.index - right.index || left.length - right.length);
    let lastEnd = -1;
    for (const hit of bucket.hits) {
      if (hit.index < lastEnd) continue;
      lastEnd = hit.index + Math.max(1, hit.length);
      snippets.push(snippetWindow(bucket.text, hit.index, hit.length, settings.contextLength));
    }
  }
  return snippets;
}

// --- U12: the real tag lines -----------------------------------------------------------
// The desktop tag panel prints the *document line* that carries the tag, not a synthetic
// `#tag` chip. The frozen evaluator can only describe a tag hit as `#<tag>` (its tag
// branch never looks at the text), so the Web layer asks for the real lines here -- same
// additive, pure, no-I/O shape as `expandOccurrenceSnippets` above. `snippets` are the
// real lines in document order; `replaced` lists the synthetic `#<tag>` excerpts this
// expansion supersedes, so a tag whose real line cannot be found keeps the frozen
// fallback instead of losing its excerpt.
// `[^\n]` rather than `.`: a CRLF note must not lose its `tags:` line to the trailing `\r`
// (`.` never matches a carriage return, and `$` then matches past it).
const FRONTMATTER_TAG_KEY = /^\s*(tags?)\s*:([^\n]*)$/;
const FRONTMATTER_TAG_ITEM = /^\s*-\s*([^\n]+?)\s*$/;

function stripYamlQuotes(value) {
  return String(value ?? "").trim().replace(/^["']/, "").replace(/["']$/, "");
}

// The tag values written on one frontmatter line: a YAML flow list, a plain scalar, or
// nothing at all (the header of a block list). Unrecognised shapes yield no item, so their
// excerpt stays the frozen synthetic one instead of being invented.
function frontmatterTagItems(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const end = text.lastIndexOf("]");
    return text.slice(1, end === -1 ? undefined : end).split(",").map(stripYamlQuotes).filter(Boolean);
  }
  return text.split(/[,\s]+/).map(stripYamlQuotes).filter(Boolean);
}

// The `---` ... `---`/`...` header, mirroring gray-matter's degradation: a header without
// a closing delimiter is not a frontmatter block, and the reader then reports none either.
function frontmatterRange(lines) {
  if ((lines[0] ?? "").trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "---" || trimmed === "...") return { end: index };
  }
  return null;
}

// `{ line, item, block }` for every tag value in the frontmatter block: the values on a
// `tags:`/`tag:` line plus the `- item` entries of its block-list form. A block-list hit
// also carries its `block` (`{ line, key, items }`, host line + values in document order),
// so the U22 excerpt can render the whole list as the one synthesised `tags: a b c` line
// the desktop panel shows. Scalar/flow hits carry `block: null` and keep their own line.
function frontmatterTagHits(lines, end) {
  const hits = [];
  let block = null;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    const key = FRONTMATTER_TAG_KEY.exec(line);
    if (key) {
      const raw = key[2].trim();
      block = raw === "" ? { line: index, key: key[1], items: [] } : null;
      for (const item of frontmatterTagItems(raw)) hits.push({ line: index, item, inline: false, block: null });
      continue;
    }
    if (!block) continue;
    const entry = FRONTMATTER_TAG_ITEM.exec(line);
    if (entry) {
      const item = stripYamlQuotes(entry[1]);
      block.items.push(item);
      hits.push({ line: index, item, inline: false, block });
    } else if (line.trim() !== "") block = null;
  }
  return hits;
}

// The offset the excerpt window should centre on: the query's own tag name inside the
// matched frontmatter value, falling back to the value itself when the name cannot be
// located (a differently-cased `- Deployment`, for instance).
function nameOffsetInItem(line, item, needle, itemIndex) {
  if (itemIndex < 0 || !needle) return Math.max(0, itemIndex);
  const lowered = line.toLocaleLowerCase();
  if (lowered.length !== line.length) return itemIndex;
  const at = lowered.indexOf(String(needle).toLocaleLowerCase(), itemIndex);
  return at >= itemIndex && at < itemIndex + item.length ? at : itemIndex;
}

export function expandTagSnippets(record, parsed, options = {}) {
  const none = { snippets: [], replaced: [] };
  const settings = { contextLength: 120, maxMatchesPerNote: 10, ...options };
  if (!parsed?.groups?.length) return none;
  const selected = selectGroup(record, parsed, settings);
  if (!selected) return none;
  const wanted = [];
  for (const outcome of selected.outcomes) {
    const clause = outcome.clause;
    if (clause.negated || clause.type !== "tag") continue;
    for (const pair of matchedTags(record, clause, settings.caseSensitive === true)) {
      if (!wanted.some((entry) => entry.tag === pair.tag)) wanted.push(pair);
    }
  }
  if (!wanted.length) return none;

  const lines = String(record.raw ?? record.content ?? "").split("\n");
  const header = settings.includeFrontmatter === false ? null : frontmatterRange(lines);
  const hits = header ? frontmatterTagHits(lines, header.end) : [];
  // Inline tags come from the one canonical scanner (fences and code spans included), so
  // the Web excerpt can never claim a `#tag` the index itself would not count.
  for (const item of extractInlineTags(lines.slice(header ? header.end + 1 : 0).join("\n"))) {
    hits.push({ line: item.position.start.line + (header ? header.end + 1 : 0), item: null, inline: true, name: item.tag, at: item.position.start.col + 1 });
  }

  const found = [];
  const replaced = [];
  for (const pair of wanted) {
    const tag = normalizeTag(pair.tag);
    let covered = false;
    for (const hit of hits) {
      if (hit.inline ? hit.name !== tag : normalizeTag(hit.item) !== tag) continue;
      covered = true;
      // U22: a block-list hit is rendered as the whole list on one synthetic line
      // (`tags: a b c`, values in document order, single spaces), the desktop shape. The
      // window is centred on the matched value inside that line; `found` still dedupes by
      // the block's host line, so a multi-value block is exactly one excerpt.
      if (hit.block) {
        const prefix = `${hit.block.key}: `;
        const text = prefix + hit.block.items.join(" ");
        const at = text.indexOf(hit.item, prefix.length);
        found.push({ line: hit.block.line, index: at < 0 ? prefix.length : at, length: Math.max(1, String(pair.needle).length), text });
        continue;
      }
      const text = lines[hit.line].replace(/\r$/, "");
      const itemIndex = hit.inline ? 0 : text.indexOf(hit.item);
      const index = hit.inline
        ? hit.at
        : nameOffsetInItem(text, hit.item, pair.needle, itemIndex);
      found.push({ line: hit.line, index, length: Math.max(1, String(pair.needle).length), text });
    }
    if (covered) replaced.push(`#${pair.tag}`);
  }

  found.sort((left, right) => left.line - right.line || left.index - right.index);
  const snippets = [];
  const seen = new Set();
  for (const hit of found) {
    if (seen.has(hit.line)) continue;
    seen.add(hit.line);
    const index = Math.min(Math.max(0, hit.index), Math.max(0, hit.text.length - 1));
    const length = Math.min(hit.length, Math.max(1, hit.text.length - index));
    snippets.push(snippetWindow(hit.text, index, length, settings.contextLength));
    if (snippets.length >= settings.maxMatchesPerNote) break;
  }
  return { snippets, replaced };
}

export function evaluateObsidianQuery(record, parsed, options = {}) {
  const settings = { contextLength: 120, maxMatchesPerNote: 10, ...options };
  if (!parsed.groups.length) return { matched: true, matchCount: 0, snippets: [], matchedClauses: [] };
  const selected = selectGroup(record, parsed, settings);
  if (!selected) return { matched: false, matchCount: 0, snippets: [], matchedClauses: [] };
  const positive = selected.outcomes.filter((outcome) => !outcome.clause.negated);
  return {
    matched: true,
    matchCount: positive.reduce((sum, outcome) => sum + (outcome.count || 0), 0),
    snippets: [...new Set(positive.flatMap((outcome) => outcome.snippets || []))].slice(0, settings.maxMatchesPerNote),
    matchedClauses: positive.filter((outcome) => outcome.matched).map((outcome) => outcome.clause.raw),
  };
}
