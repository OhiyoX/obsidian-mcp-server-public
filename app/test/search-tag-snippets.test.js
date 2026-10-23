// U12: `tag:` excerpts are the real document lines, not the frozen synthetic `#tag` chip.
// U22: a *block-list* frontmatter tag is the exception the desktop draws differently -- the
// whole list is rendered on one synthesised `tags: a b c` line (values in document order,
// single spaces), because the desktop tag panel flattens `tags:` + its `- value` bullets.
//
// The desktop tag panel prints the line that carries the tag (a scalar frontmatter `tags:`
// line, a block-list `tags:` list, or a body line with an inline `#tag`). The frozen
// evaluator's tag branch can only return `#<tag>`, so the Web layer asks `expandTagSnippets`
// for the real (or desktop-flattened) lines. These assertions pin the *frozen* shape (MCP
// `search_notes`) next to the Web shape, so a future change cannot move both at once.
import assert from "node:assert/strict";
import test from "node:test";
import { allTagsForNote, parseFrontmatter } from "../src/obsidian.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";
import { evaluateObsidianQuery, expandTagSnippets } from "../src/search/evaluator.js";

// The production record shape (`web-catalog/search-api.js#verifyCandidate`), built from the
// same helpers the indexer uses, so the tags under test are the tags the index would count.
function recordFor(raw, path = "Notes/note.md") {
  const { data, content } = parseFrontmatter(raw);
  return {
    path,
    name: path.split("/").pop(),
    basename: path.replace(/^.*\//, "").replace(/\.md$/, ""),
    tags: allTagsForNote({ frontmatter: data, content }),
    aliases: [],
    frontmatter: data,
    content,
    raw,
  };
}

const SCALAR = recordFor("---\ntags: obsidian mcp oauth deployment\n---\nBody has no tag line.\n");
const BLOCK = recordFor("---\ntype: deployment\ntags:\n  - memory\n  - inbox\n---\nBody.\n");
// The desktop reference string, verbatim from the user's screenshot and the real note
// `_Workspace/50-Ops/Services/example-host-nvultr/2026-08-29 WordPress MCP Adapter.md`.
const WORDPRESS = recordFor("---\ntags:\n  - wordpress\n  - 运维\n  - mcp\n  - example-host\n---\nBody.\n");
const FLOW = recordFor("---\ntags: [web/deploy, other]\n---\nBody.\n");
const INLINE = recordFor("---\ntitle: inline note\n---\nThe first line mentions #memory inline.\nSecond line.\n");
const FENCED = recordFor("---\ntitle: fenced only\n---\n```js\nconst x = \"#memory\";\n```\nNo real tag.\n");
const MULTILINE_FLOW = recordFor("---\ntags: [lonely,\n  nested]\n---\nBody.\n");
const FOLDED = recordFor("---\ntags: >-\n  alpha\n  beta\n---\nBody.\n");
const MIXED = recordFor("---\ntags:\n  - mcp\n  - other\n---\nBody #mcp inline.\n");
// CRLF note: `.` never matches `\r`, so a `tags:` regex that relies on it loses the line.
// Real notes in this Vault do use CRLF (two of the `tag:#memory` results), so the whole
// frontmatter path is pinned on both endings.
const CRLF = recordFor(["---", "type: memory", "tags:", "  - memory", "  - nas", "---", "Body with #memory inline as well."].join("\r\n"));
// Twelve separate inline tag lines, so the per-note excerpt cap is exercised by twelve
// excerpts (a single block list is one excerpt under U22, so it can no longer do that).
const MANY_INLINE = recordFor(`---\ntitle: many\n---\n${Array.from({ length: 12 }, (_, index) => `line #t${String(index + 1).padStart(2, "0")}`).join("\n")}\n`);

const expand = (record, query, options = {}) => expandTagSnippets(record, parseObsidianQuery(query), options);
const frozen = (record, query) => evaluateObsidianQuery(record, parseObsidianQuery(query), {});

// A scalar/inline excerpt is a window over the real line, so everything but the window's `…`
// markers must be findable in the note's raw text: that is what "a real document line" means.
function assertRealLine(record, snippet) {
  const body = snippet.replace(/^…/, "").replace(/…$/, "").trim();
  assert.ok(body.length > 0, `excerpt is not empty: ${JSON.stringify(snippet)}`);
  assert.ok(record.raw.includes(body), `excerpt ${JSON.stringify(snippet)} is a real fragment of ${record.path}`);
}

// U22: a block-list excerpt is the desktop-flattened `tags: a b c` line -- not a contiguous
// fragment of the raw bytes (which are `tags:` plus indented bullets), so it is verified
// verbatim against the block's own values, each of which must be a real bullet of the note.
function assertBlockLine(record, snippet, key, values) {
  assert.equal(snippet, `${key}: ${values.join(" ")}`);
  for (const value of values) {
    assert.ok(record.raw.includes(`- ${value}`), `the block value ${JSON.stringify(value)} is a real bullet of ${record.path}`);
  }
}

test("a scalar frontmatter tags line is the real excerpt (desktop shape)", () => {
  const before = frozen(SCALAR, "tag:#deployment");
  assert.equal(before.matchCount, 1);
  assert.deepEqual(before.snippets, ["#deployment"], "the frozen (MCP) shape stays a synthetic chip");
  const after = expand(SCALAR, "tag:#deployment");
  assert.deepEqual(after.snippets, ["tags: obsidian mcp oauth deployment"]);
  assert.deepEqual(after.replaced, ["#deployment"], "the synthetic chip is superseded, not appended");
  assert.equal(after.snippets.includes("#deployment"), false, "a synthetic chip is never an excerpt");
  assertRealLine(SCALAR, after.snippets[0]);
  assert.ok(after.snippets[0].includes("deployment"), "the excerpt carries the queried tag name");
  // `tag:` without `#` is the same clause, and case-insensitive matching still applies.
  assert.deepEqual(expand(SCALAR, "tag:deployment").snippets, after.snippets);
  assert.deepEqual(expand(SCALAR, "tag:#DEPLOYMENT").snippets, after.snippets);
});

test("a block-list frontmatter tag renders the whole list as one desktop-style line (U22)", () => {
  const after = expand(BLOCK, "tag:#memory");
  assert.deepEqual(after.snippets, ["tags: memory inbox"], "the whole list, document order, single spaces");
  assertBlockLine(BLOCK, after.snippets[0], "tags", ["memory", "inbox"]);
  assert.deepEqual(after.replaced, ["#memory"]);
  // The sibling bullet is included, but `type: deployment` is a value, not a tag.
  assert.equal(frozen(BLOCK, "tag:#deployment").matched, false);
  assert.deepEqual(expand(BLOCK, "tag:#deployment"), { snippets: [], replaced: [] });
  // Querying the sibling gives the same single line.
  assert.deepEqual(expand(BLOCK, "tag:#inbox").snippets, ["tags: memory inbox"]);
  // Two matched values in the same block are still exactly one excerpt (U22 hard rule).
  assert.deepEqual(expand(BLOCK, "tag:memory tag:inbox").snippets, ["tags: memory inbox"]);
  assert.equal(frozen(BLOCK, "tag:memory tag:inbox").matchCount, 2, "matchCount is untouched");
});

test("the desktop reference line is reproduced verbatim for a real block list (U22)", () => {
  const after = expand(WORDPRESS, "tag:mcp");
  assert.deepEqual(after.snippets, ["tags: wordpress 运维 mcp example-host"]);
  assertBlockLine(WORDPRESS, after.snippets[0], "tags", ["wordpress", "运维", "mcp", "example-host"]);
  assert.deepEqual(after.replaced, ["#mcp"]);
  // The real note's frontmatter is exactly this shape, so the desktop bytes are pinned.
  assert.equal(WORDPRESS.raw.includes("  - example-host"), true);
});

test("a flow list keeps its own real line (not a synthesised one)", () => {
  for (const query of ["tag:web", "tag:#web", "tag:web/deploy"]) {
    const after = expand(FLOW, query);
    assert.deepEqual(after.snippets, ["tags: [web/deploy, other]"], query);
    assert.deepEqual(after.replaced, ["#web/deploy"], "the superseded chip is the record tag");
    assertRealLine(FLOW, after.snippets[0]);
  }
  // The parent query matches through `web/deploy`, not through a stray `web` line.
  assert.equal(frozen(FLOW, "tag:web").matchCount, 1);
  assert.equal(frozen(FLOW, "tag:web/deploy").matchCount, 1);
});

test("an inline body tag excerpt is that body line, one excerpt per line", () => {
  const after = expand(INLINE, "tag:#memory");
  assert.deepEqual(after.snippets, ["The first line mentions #memory inline."]);
  assert.deepEqual(after.replaced, ["#memory"]);
  assertRealLine(INLINE, after.snippets[0]);
  // Two lines carrying the same inline tag: one excerpt per line, in document order.
  const twice = recordFor("---\ntitle: twice\n---\n#a on line one\n#a again\n");
  assert.equal(frozen(twice, "tag:#a").matchCount, 1, "the tag list is deduped, the count is unchanged");
  assert.deepEqual(expand(twice, "tag:#a").snippets, ["#a on line one", "#a again"]);
});

test("a frontmatter block hit and a body inline hit are two excerpts, in document order (U22)", () => {
  const after = expand(MIXED, "tag:mcp");
  assert.deepEqual(after.snippets, ["tags: mcp other", "Body #mcp inline."]);
  assert.deepEqual(after.replaced, ["#mcp"]);
});

test("a CRLF note keeps its frontmatter block line and its body tag line", () => {
  const after = expand(CRLF, "tag:#memory");
  assert.deepEqual(after.snippets, ["tags: memory nas", "Body with #memory inline as well."]);
  assert.deepEqual(after.replaced, ["#memory"]);
  assertBlockLine(CRLF, after.snippets[0], "tags", ["memory", "nas"]);
  assertRealLine(CRLF, after.snippets[1]);
  assert.equal(after.snippets.every((snippet) => !snippet.includes("\r")), true, "the excerpt carries no CR");
  assert.deepEqual(expand(CRLF, "tag:#nas").snippets, ["tags: memory nas"]);
});

test("a tag the index never counted cannot become an excerpt", () => {
  // `#memory` appears only inside a fenced code block: no inline tag, no frontmatter tag,
  // therefore no match and no excerpt.
  assert.equal(frozen(FENCED, "tag:#memory").matched, false);
  assert.deepEqual(expand(FENCED, "tag:#memory"), { snippets: [], replaced: [] });
});

test("a tag with no resolvable line keeps the frozen synthetic fallback", () => {
  // A YAML flow list spread over two physical lines: the value is a real tag (`nested`)
  // but the document has no single line that carries it as a tag value.
  assert.equal(frozen(MULTILINE_FLOW, "tag:#nested").matchCount, 1);
  const after = expand(MULTILINE_FLOW, "tag:#nested");
  assert.deepEqual(after.snippets, [], "no real line is invented");
  assert.deepEqual(after.replaced, [], "so the frozen `#nested` excerpt is not superseded");
  // A folded (`>-`) tags scalar has the same property: js-yaml still counts `alpha`/`beta`
  // as tags, but no line carries them as block bullets, so no line is invented either.
  assert.equal(frozen(FOLDED, "tag:#alpha").matchCount, 1);
  assert.deepEqual(expand(FOLDED, "tag:#alpha"), { snippets: [], replaced: [] });
  // With frontmatter excluded from the matching text the same fallback applies.
  assert.deepEqual(expand(SCALAR, "tag:#deployment", { includeFrontmatter: false }), { snippets: [], replaced: [] });
  assert.deepEqual(expand(BLOCK, "tag:#memory", { includeFrontmatter: false }), { snippets: [], replaced: [] });
});

test("excerpts are capped, deduped and scoped to the query's tag clauses", () => {
  const queries = Array.from({ length: 12 }, (_, index) => `tag:t${String(index + 1).padStart(2, "0")}`);
  const query = queries.join(" ");
  assert.equal(frozen(MANY_INLINE, query).matchCount, 12, "matchCount is the evaluator's, untouched");
  const after = expand(MANY_INLINE, query);
  assert.equal(after.snippets.length, 10, "at most ten excerpts per note");
  assert.equal(new Set(after.snippets).size, after.snippets.length, "excerpts are deduped");
  assert.deepEqual(after.replaced.length, 12);
  // A query without a tag clause, and a negated tag clause, expand to nothing at all.
  assert.deepEqual(expand(SCALAR, "obsidian"), { snippets: [], replaced: [] });
  assert.deepEqual(expand(SCALAR, "-tag:#deployment"), { snippets: [], replaced: [] });
  assert.deepEqual(expand(SCALAR, "tag:#missing"), { snippets: [], replaced: [] });
});
