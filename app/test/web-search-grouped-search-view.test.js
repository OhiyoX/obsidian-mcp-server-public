// U4: desktop-shaped grouped search results (group head + highlighted excerpt rows).
//
// The frozen v2 contract keeps the server order authoritative and `snippets` is a list
// of plain-text excerpts with no highlight markers, so grouping and highlighting are
// client-side view concerns over the real payload:
//   item = { path, name, modifiedMs, score, matchCount, snippets[] }
// Highlighting never invents a match: only a literal query term that is really present
// in the excerpt text becomes a <mark>.
//
// `dom-shim.mjs` has no append/querySelector, so this suite installs its own minimal
// element so the queried DOM can be inspected (see web-search-published-filter-view).
import assert from "node:assert/strict";
import test from "node:test";

function createElement(name, doc) {
  const attrs = new Map();
  const children = [];
  const classes = new Set();
  let ownText = "";
  const node = {
    nodeName: String(name).toUpperCase(),
    nodeType: 1,
    dataset: {},
    style: {},
    disabled: false,
    hidden: false,
    children,
    childNodes: children,
    ownerDocument: doc,
    get className() { return [...classes].join(" "); },
    set className(value) { classes.clear(); for (const token of String(value).split(/\s+/)) if (token) classes.add(token); },
    classList: {
      add(...tokens) { for (const token of tokens) classes.add(token); },
      remove(...tokens) { for (const token of tokens) classes.delete(token); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        const next = force === undefined ? !classes.has(token) : Boolean(force);
        if (next) classes.add(token); else classes.delete(token);
        return next;
      },
    },
    setAttribute(key, value) { attrs.set(String(key), String(value)); },
    getAttribute(key) { return attrs.has(String(key)) ? attrs.get(String(key)) : null; },
    removeAttribute(key) { attrs.delete(String(key)); },
    hasAttribute(key) { return attrs.has(String(key)); },
    append(...nodes) { children.push(...nodes); return nodes.at(-1); },
    appendChild(child) { children.push(child); return child; },
    querySelector() { return null; },
    get textContent() {
      if (children.length) return children.map((child) => child.textContent ?? "").join("");
      return ownText;
    },
    set textContent(value) { children.length = 0; ownText = String(value ?? ""); },
  };
  return node;
}

function createDocument() {
  const doc = { createElement: (name) => createElement(name, doc) };
  doc.createTextNode = (value) => ({ nodeType: 3, textContent: String(value ?? "") });
  // U9: the result-group chevron is a real sprite <svg><use>, so the harness needs the SVG
  // factory (the shared dom-shim does not provide one).
  doc.createElementNS = (_ns, name) => createElement(name, doc);
  return doc;
}

const doc = createDocument();
globalThis.document = doc;

const { renderSearchResults, SEARCH_MORE_ATTR, SEARCH_GROUP_TOGGLE_ATTR } = await import("../frontend/app/features/search/search-view.js");
const { searchStatus } = await import("../frontend/app/features/search/search-state.js");
const { extractHighlightTerms, highlightSegments } = await import("../frontend/app/features/search/highlight.js");

function createHost() {
  const host = createElement("nav", doc);
  Object.defineProperty(host, "innerHTML", {
    configurable: true,
    get: () => "",
    set: () => { host.children.length = 0; },
  });
  return host;
}

function flatten(element, out = []) {
  out.push(element);
  for (const child of element.children || []) flatten(child, out);
  return out;
}

const withClass = (nodes, token) => nodes.filter((node) => String(node.className || "").split(/\s+/).includes(token));

function render(state) {
  const host = createHost();
  const opened = [];
  const notes = [];
  renderSearchResults({
    host,
    state,
    isCurrent: (path) => path === state.currentPath,
    onNote: (path) => notes.push(path),
    onLoadMore: () => {},
    onToggleGroup: (path) => opened.push(path),
  });
  const nodes = flatten(host);
  return {
    host,
    nodes,
    groups: withClass(nodes, "search-group"),
    snippetRows: withClass(nodes, "search-snippet-row"),
    marks: nodes.filter((node) => node.nodeName === "MARK"),
    sentinel: nodes.find((node) => typeof node.getAttribute === "function" && node.getAttribute(SEARCH_MORE_ATTR) === "true") || null,
    empty: withClass(nodes, "empty")[0] || null,
    opened: () => opened,
    notes: () => notes,
  };
}

const itemA = {
  path: "Notes/a.md",
  name: "a.md",
  matchCount: 3,
  snippets: ["第一段提到 协作 的正文", "这一行完全没有命中词", "结尾再次 协作"],
};
const itemB = { path: "Notes/b.md", name: "b.md", matchCount: 1, snippets: ["另一个 协作 摘录"] };
const grouped = {
  query: "协作",
  caseSensitive: false,
  collapsedGroups: new Set(),
  items: [itemA, itemB],
  nextCursor: "cursor-1",
  loading: false,
};

// --- grouped rendering -----------------------------------------------------------

test("one group per result, in server order, with the note name and matchCount", () => {
  const view = render(grouped);
  assert.equal(view.groups.length, 2, "group count equals the API item count");
  assert.deepEqual(view.groups.map((group) => group.dataset.searchGroup), ["Notes/a.md", "Notes/b.md"]);
  const heads = withClass(view.nodes, "search-group-head");
  const titles = withClass(view.nodes, "search-group-title");
  assert.deepEqual(titles.map((title) => title.textContent), ["a.md", "b.md"]);
  assert.deepEqual(withClass(view.nodes, "search-group-count").map((count) => count.textContent), ["3", "1"]);
  // The item row stays the single `.note[data-path]` per result: the frozen Chromium
  // regression derives the ordered path list from `.search-results .note[data-path]`.
  const notes = withClass(view.nodes, "note");
  assert.deepEqual(notes.map((note) => note.dataset.path), ["Notes/a.md", "Notes/b.md"]);
  assert.deepEqual(notes.map((note) => note.title), ["Notes/a.md", "Notes/b.md"]);
  assert.equal(heads.length, 2);
});

test("every snippet renders as its own excerpt row and opens the note on click", () => {
  const view = render(grouped);
  assert.equal(view.snippetRows.length, 4, "a.md has three excerpts, b.md one");
  assert.deepEqual(view.snippetRows.map((row) => row.dataset.path), ["Notes/a.md", "Notes/a.md", "Notes/a.md", "Notes/b.md"]);
  view.snippetRows[0].onclick();
  assert.deepEqual(view.notes(), ["Notes/a.md"], "a real click opens the excerpt's note");
});

test("highlighting only marks the query term that is really in the excerpt", () => {
  const view = render(grouped);
  assert.deepEqual(view.marks.map((mark) => mark.textContent), ["协作", "协作", "协作"]);
  const [firstRow, secondRow, thirdRow, fourthRow] = view.snippetRows;
  assert.deepEqual(withClass(flatten(firstRow), "search-snippet").map((node) => node.textContent), ["第一段提到 协作 的正文"]);
  assert.equal(flatten(secondRow).filter((node) => node.nodeName === "MARK").length, 0, "an excerpt without the term stays untouched");
  assert.equal(withClass(flatten(thirdRow), "search-snippet")[0].textContent, "结尾再次 协作");
  assert.equal(withClass(flatten(fourthRow), "search-snippet").length, 1);
});

test("case sensitivity is honoured when re-locating the term in the excerpt", () => {
  const state = { ...grouped, query: "ALPHA", caseSensitive: false, items: [{ path: "N.md", name: "N.md", matchCount: 2, snippets: ["alpha here", "ALPHA there"] }] };
  assert.equal(render(state).marks.length, 2, "case-insensitive query marks both spellings");
  const strict = { ...state, caseSensitive: true };
  assert.equal(render(strict).marks.length, 1, "case-sensitive query only marks the exact spelling");
  assert.equal(render(strict).marks[0].textContent, "ALPHA");
});

test("a collapsed group keeps its rows in the DOM but marks them hidden", () => {
  const view = render({ ...grouped, collapsedGroups: new Set(["Notes/a.md"]) });
  const toggles = withClass(view.nodes, "search-group-toggle");
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].getAttribute("aria-expanded"), "false");
  assert.equal(toggles[1].getAttribute("aria-expanded"), "true");
  assert.equal(view.snippetRows.length, 4, "the excerpts stay rendered so a re-expand needs no refetch");
  assert.ok(view.snippetRows.filter((row) => row.dataset.path === "Notes/a.md").every((row) => row.hidden === true));
  assert.ok(view.snippetRows.filter((row) => row.dataset.path === "Notes/b.md").every((row) => row.hidden === false));
  toggles[1].onclick();
  assert.deepEqual(view.opened(), ["Notes/b.md"], "the toggle reports the group path to the owner");
});

test("U9: the group chevron is the desktop chevron glyph from the sprite, not a CSS triangle", () => {
  const view = render(grouped);
  // The shim's className is a property; the renderer uses setAttribute("class"), so read
  // either (a real DOM reflects one into the other).
  const classOf = (node) => String(node.getAttribute?.("class") ?? node.className ?? "");
  const chevron = view.nodes.find((node) => classOf(node).split(/\s+/).includes("search-group-chevron"));
  assert.ok(chevron, "the group toggle renders a chevron");
  assert.equal(chevron.nodeName, "SVG", "the chevron is a real SVG element");
  assert.ok(classOf(chevron).split(/\s+/).includes("svg-icon"), "it carries the shared sprite-icon class");
  assert.equal(chevron.getAttribute("aria-hidden"), "true");
  assert.equal(chevron.children[0].nodeName, "USE");
  assert.equal(chevron.children[0].getAttribute("href"), "/app/assets/icons.svg#chevron-right");
  const toggles = withClass(view.nodes, "search-group-toggle");
  assert.equal(toggles.length, 2, "every result group keeps exactly one toggle");
  for (const toggle of toggles) {
    assert.equal(flatten(toggle).filter((node) => classOf(node).includes("search-group-chevron")).length, 1, "each toggle carries exactly one chevron");
  }
});

test("a cursor keeps the load-more affordance and an exhausted page does not", () => {
  assert.ok(render(grouped).sentinel, "a page with a cursor stays continuable");
  assert.equal(render({ ...grouped, nextCursor: null }).sentinel, null);
});

test("an empty page with a cursor keeps the honest empty text and the sentinel", () => {
  const view = render({ ...grouped, items: [], nextCursor: "cursor-2" });
  assert.equal(view.empty.textContent, "本页没有匹配，可继续加载");
  assert.ok(view.sentinel);
});

test("an untouched search panel says how to start instead of claiming no results", () => {
  const untouched = render({ query: "", items: [], nextCursor: null, loading: false, collapsedGroups: new Set() });
  assert.equal(untouched.empty.textContent, "输入关键词开始搜索");
  // A state without an explicit query (older callers) still means "no results".
  const exhausted = render({ items: [], nextCursor: null, loading: false });
  assert.equal(exhausted.empty.textContent, "没有找到笔记");
});

// --- count row -------------------------------------------------------------------

test("the count row shows the loaded result count and says when more exists", () => {
  const more = searchStatus({ query: "协作", items: grouped.items, nextCursor: "c", semantic: false, semanticUsed: false, semanticError: null });
  assert.equal(more.text, "2 项结果 · 普通搜索 · 还有更多");
  const done = searchStatus({ query: "协作", items: grouped.items, nextCursor: null, semantic: false, semanticUsed: false, semanticError: null });
  assert.equal(done.text, "2 项结果 · 普通搜索");
});

test("the count row never drops the semantic / index-updating notice", () => {
  const degraded = searchStatus({ query: "x", items: grouped.items, nextCursor: null, semantic: true, semanticUsed: false, semanticError: "provider missing" });
  assert.equal(degraded.kind, "warning");
  assert.match(degraded.text, /语义不可用/);
  assert.match(degraded.text, /2 项结果/);
  assert.equal(degraded.title, "provider missing");
  const used = searchStatus({ query: "x", items: grouped.items, nextCursor: null, semantic: true, semanticUsed: true, semanticError: null });
  assert.match(used.text, /普通搜索 \+ 语义/);
  assert.match(used.text, /2 项结果/);
  const stale = searchStatus({ query: "x", items: grouped.items, nextCursor: null, semantic: false, semanticUsed: false, semanticError: null }, { stale: true });
  assert.equal(stale.kind, "warning");
  assert.match(stale.text, /索引更新中/);
  assert.match(stale.text, /2 项结果/);
});

// --- highlight purity ------------------------------------------------------------

test("highlight terms are the literal query words, never an operator", () => {
  assert.deepEqual(extractHighlightTerms("协作"), ["协作"]);
  assert.deepEqual(extractHighlightTerms("alpha beta"), ["alpha", "beta"]);
  assert.deepEqual(extractHighlightTerms('"intro selection"'), ["intro selection"]);
  // U12: `tag:` is the one operator whose value is part of the excerpt (see the test below).
  assert.deepEqual(extractHighlightTerms('tag:fixture "intro selection"'), ["fixture", "#fixture", "intro selection"]);
  assert.deepEqual(extractHighlightTerms("alpha OR beta"), ["alpha", "beta"]);
  assert.deepEqual(extractHighlightTerms("-alpha beta"), ["beta"]);
  assert.deepEqual(extractHighlightTerms("file:b.md"), []);
  assert.deepEqual(extractHighlightTerms("line:\"intro text\""), []);
  assert.deepEqual(extractHighlightTerms("[status:done]"), []);
  assert.deepEqual(extractHighlightTerms("path:a/b"), []);
  assert.deepEqual(extractHighlightTerms("   "), []);
});

// U12: the tag name must be highlightable, because a `tag:` excerpt is now the REAL
// document line -- `tags: obsidian mcp oauth deployment`, `- deployment`, `mentions #memory`
// -- and `tag:` itself never appears in it.
test("tag: excerpts highlight the queried tag name inside the real line", () => {
  const terms = extractHighlightTerms("tag:#deployment");
  assert.deepEqual(terms, ["deployment", "#deployment"]);
  const frontmatter = highlightSegments("tags: obsidian mcp oauth deployment", terms, { caseSensitive: false });
  assert.deepEqual(frontmatter.at(-1), { text: "deployment", match: true });
  assert.deepEqual(highlightSegments("- deployment", terms, { caseSensitive: false }), [
    { text: "- ", match: false },
    { text: "deployment", match: true },
  ]);
  // An inline occurrence is marked whole (`#deployment`), not just its name.
  assert.deepEqual(highlightSegments("mentions #deployment inline", terms, { caseSensitive: false }), [
    { text: "mentions ", match: false },
    { text: "#deployment", match: true },
    { text: " inline", match: false },
  ]);
  // The parent form highlights the queried name inside the nested tag.
  assert.deepEqual(highlightSegments("tags: [web/deploy]", extractHighlightTerms("tag:web"), { caseSensitive: false }), [
    { text: "tags: [", match: false },
    { text: "web", match: true },
    { text: "/deploy]", match: false },
  ]);
  // A negated or empty tag clause is still not a term, and other operators stay stripped.
  assert.deepEqual(extractHighlightTerms("-tag:#deployment"), []);
  // An empty tag clause was never an operator match (the generic pass needs `\S+` after the
  // colon): its term stays exactly as it was before this slice.
  assert.deepEqual(extractHighlightTerms("tag:"), ["tag:"]);
  assert.deepEqual(extractHighlightTerms("tag:#a/b"), ["a/b", "#a/b"]);
  assert.deepEqual(extractHighlightTerms("path:a/b tag:#deployment"), ["deployment", "#deployment"]);
});

test("segments split the excerpt around real hits and keep the original text", () => {
  const segments = highlightSegments("第一段提到 协作 的正文", ["协作"], { caseSensitive: false });
  assert.deepEqual(segments, [
    { text: "第一段提到 ", match: false },
    { text: "协作", match: true },
    { text: " 的正文", match: false },
  ]);
  assert.deepEqual(highlightSegments("no hit here", ["协作"], { caseSensitive: false }), [{ text: "no hit here", match: false }]);
  assert.deepEqual(highlightSegments("", ["协作"]), []);
  // Longest term wins so a longer phrase is not split by a shorter prefix.
  assert.deepEqual(highlightSegments("alpha beta", ["alpha", "alpha beta"], { caseSensitive: false }), [{ text: "alpha beta", match: true }]);
});
