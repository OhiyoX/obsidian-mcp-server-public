/**
 * Minimal browser globals for Node tests.
 * Intentionally incomplete for DOMPurify (no Document.nodeType === 9):
 * reader sanitize must fail closed via escape, not return raw HTML.
 * Parser-only tests (e.g. LP-11 comments) stay scoped to markdown-it.
 */

function createElement(name) {
  const attrs = new Map();
  const children = [];
  const element = {
    nodeName: String(name || "").toUpperCase(),
    nodeType: 1,
    style: {},
    childNodes: children,
    children,
    textContent: "",
    innerHTML: "",
    className: "",
    setAttribute(key, value) { attrs.set(String(key), String(value)); },
    getAttribute(key) { return attrs.has(String(key)) ? attrs.get(String(key)) : null; },
    removeAttribute(key) { attrs.delete(String(key)); },
    hasAttribute(key) { return attrs.has(String(key)); },
    appendChild(child) { children.push(child); return child; },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    cloneNode() { return createElement(name); },
    addEventListener() {},
    removeEventListener() {},
  };
  return element;
}

export function installDomShim() {
  if (globalThis.__obsidianDomShim) return;
  const document = {
    // Deliberately omit nodeType DOCUMENT_NODE so DOMPurify stays unsupported here.
    documentElement: createElement("html"),
    body: createElement("body"),
    createElement,
    createDocumentFragment() {
      return { nodeType: 11, childNodes: [], appendChild(child) { this.childNodes.push(child); return child; } };
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text), nodeValue: String(text) };
    },
    implementation: {
      createHTMLDocument() {
        return {
          body: createElement("body"),
          createElement,
          createDocumentFragment: document.createDocumentFragment,
        };
      },
    },
  };
  globalThis.window = globalThis;
  globalThis.document = document;
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
  globalThis.Element = function Element() {};
  globalThis.HTMLElement = function HTMLElement() {};
  globalThis.DocumentFragment = function DocumentFragment() {};
  globalThis.DOMParser = function DOMParser() {
    this.parseFromString = () => document;
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_COMMENT: 128, FILTER_ACCEPT: 1 };
  globalThis.__obsidianDomShim = true;
}
