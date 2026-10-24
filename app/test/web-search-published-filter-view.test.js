// `renderSearchResults` must keep the continuation affordance when a page is empty
// but still has a cursor (#270).
//
// A hard filter can legitimately fill nothing inside one candidate window: the
// server caps a request at MAX_CANDIDATES_PER_REQUEST candidates and returns a
// continuable cursor instead of a silent miss. The empty branch used to return before
// appending the load-more sentinel, so that page dead-ended with "没有找到笔记".
//
// The shared `dom-shim.mjs` has no `append`/`querySelector`, so this test installs its
// own minimal element instead of widening a helper three other suites depend on.
import assert from "node:assert/strict";
import test from "node:test";

function createElement(name) {
  const attrs = new Map();
  const children = [];
  return {
    nodeName: String(name).toUpperCase(),
    className: "",
    textContent: "",
    dataset: {},
    style: {},
    disabled: false,
    children,
    setAttribute(key, value) { attrs.set(String(key), String(value)); },
    getAttribute(key) { return attrs.has(String(key)) ? attrs.get(String(key)) : null; },
    hasAttribute(key) { return attrs.has(String(key)); },
    append(...nodes) { children.push(...nodes); return nodes.at(-1); },
    appendChild(node) { children.push(node); return node; },
    querySelector() { return null; },
  };
}

function createHost() {
  const host = createElement("div");
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

globalThis.document = { createElement };

const { renderSearchResults, SEARCH_MORE_ATTR } = await import("../frontend/app/features/search/search-view.js");

function render(state) {
  const host = createHost();
  let continued = 0;
  renderSearchResults({
    host,
    state,
    escapeHtml: (value) => String(value),
    isCurrent: () => false,
    onNote: () => {},
    onLoadMore: () => { continued += 1; },
  });
  const nodes = flatten(host);
  const sentinel = nodes.find((node) => node.getAttribute(SEARCH_MORE_ATTR) === "true") || null;
  const empty = nodes.find((node) => node.className === "empty") || null;
  return { host, nodes, sentinel, empty, continued: () => continued };
}

const baseState = { items: [], nextCursor: null, loading: false };

test("an empty page with a cursor still offers continuation", () => {
  const view = render({ ...baseState, nextCursor: "cursor-1" });
  assert.ok(view.empty, "the empty hint is still rendered");
  assert.equal(view.empty.textContent, "本页没有匹配，可继续加载");
  assert.ok(view.sentinel, "a page with a cursor must always be continuable");
  assert.equal(view.sentinel.disabled, false);
  view.sentinel.onclick();
  assert.equal(view.continued(), 1, "the sentinel is wired to the continuation callback");
});

test("an exhausted empty page is a real 'no results' without a sentinel", () => {
  const view = render({ ...baseState, nextCursor: null });
  assert.equal(view.empty.textContent, "没有找到笔记");
  assert.equal(view.sentinel, null);
});

test("a loading empty page stays honest and does not offer a re-entrant click", () => {
  const view = render({ ...baseState, nextCursor: "cursor-1", loading: true });
  assert.equal(view.empty.textContent, "正在搜索…");
  assert.ok(view.sentinel);
  assert.equal(view.sentinel.disabled, true);
});

test("a non-empty page keeps rendering rows and its continuation", () => {
  const view = render({
    ...baseState,
    nextCursor: "cursor-2",
    items: [{ path: "Notes/a.md", name: "a.md", snippets: [] }],
  });
  assert.equal(view.empty, null);
  assert.ok(view.sentinel, "the normal pagination path must not regress");
  assert.ok(view.nodes.some((node) => node.dataset?.path === "Notes/a.md"));
});
