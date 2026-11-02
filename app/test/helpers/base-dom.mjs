// Minimal but capable DOM harness for the Base surface Node tests.
//
// The repo's `test/dom-shim.mjs` is deliberately tiny and omits
// `document.nodeType` for DOMPurify fail-closed tests; extending it would risk
// those readers. This file is a dedicated, backward-compatible alternative used
// only by the web-bases-surface tests. It implements just enough DOM to build
// and query the Base table: elements, text nodes, classList, attributes,
// select/option, events, querySelector(All) with tag/.class/#id/[attr="v"] and
// descendant combinators.

function parseCompound(text) {
  const match = text.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!match) return null;
  const tag = match[1] ? match[1].toLowerCase() : null;
  const classes = [];
  const ids = [];
  const attrs = [];
  const tokenRe = /([.#][\w-]+|\[[^\]]+\])/g;
  let token;
  while ((token = tokenRe.exec(match[2] || ""))) {
    const value = token[1];
    if (value[0] === ".") classes.push(value.slice(1));
    else if (value[0] === "#") ids.push(value.slice(1));
    else {
      const inner = value.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq === -1) attrs.push({ name: inner.trim(), value: null });
      else {
        const name = inner.slice(0, eq).trim();
        let attrValue = inner.slice(eq + 1).trim();
        if ((attrValue.startsWith('"') && attrValue.endsWith('"')) || (attrValue.startsWith("'") && attrValue.endsWith("'"))) {
          attrValue = attrValue.slice(1, -1);
        }
        attrs.push({ name, value: attrValue });
      }
    }
  }
  return { tag, classes, ids, attrs };
}

function parseSelector(selector) {
  return String(selector).split(",").map((group) => group.trim().split(/\s+/).map(parseCompound).filter(Boolean));
}

function matchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  if (compound.tag && (el.tagName || "").toLowerCase() !== compound.tag) return false;
  for (const id of compound.ids) if (el.getAttribute("id") !== id) return false;
  for (const name of compound.classes) if (!el.classList.contains(name)) return false;
  for (const { name, value } of compound.attrs) {
    if (!el.hasAttribute(name)) return false;
    if (value !== null && el.getAttribute(name) !== value) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  return parseSelector(selector).some((chain) => {
    if (chain.length === 0) return false;
    if (!matchesCompound(el, chain[chain.length - 1])) return false;
    let node = el.parentNode;
    for (let index = chain.length - 2; index >= 0; index -= 1) {
      while (node && !(node.nodeType === 1 && matchesCompound(node, chain[index]))) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

function walk(el, visit) {
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      visit(child);
      walk(child, visit);
    }
  }
}

export function createDomHarness() {
  function createTextNode(text) {
    const node = {
      nodeType: 3,
      nodeName: "#text",
      parentNode: null,
      _text: String(text),
      get textContent() { return this._text; },
      get nodeValue() { return this._text; },
      set textContent(value) { this._text = String(value); },
    };
    return node;
  }

  function makeClassList(el) {
    return {
      add(...names) {
        const set = new Set(el.className ? el.className.split(/\s+/).filter(Boolean) : []);
        for (const name of names) set.add(name);
        el.className = [...set].join(" ");
      },
      remove(...names) {
        const drop = new Set(names);
        el.className = (el.className ? el.className.split(/\s+/).filter(Boolean) : []).filter((name) => !drop.has(name)).join(" ");
      },
      contains(name) {
        return (el.className ? el.className.split(/\s+/) : []).includes(name);
      },
      toggle(name, force) {
        const has = this.contains(name);
        const shouldHave = force === undefined ? !has : Boolean(force);
        if (shouldHave) this.add(name);
        else this.remove(name);
        return shouldHave;
      },
    };
  }

  function createElement(tag) {
    const element = {
      nodeType: 1,
      nodeName: String(tag).toUpperCase(),
      tagName: String(tag).toUpperCase(),
      localName: String(tag).toLowerCase(),
      parentNode: null,
      childNodes: [],
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) { delete this[name]; },
        getPropertyValue(name) { return this[name] ?? ""; },
      },
      dataset: {},
      hidden: false,
      disabled: false,
      value: "",
      type: "",
      _attrs: new Map(),
      _listeners: new Map(),
    };
    element.classList = makeClassList(element);
    Object.defineProperty(element, "className", {
      get() { return this._attrs.get("class") ?? ""; },
      set(value) { this._attrs.set("class", String(value ?? "")); },
    });
    Object.defineProperty(element, "textContent", {
      get() {
        return this.childNodes.map((child) => (child.nodeType === 3 ? child._text : child.textContent)).join("");
      },
      set(value) {
        this.childNodes.length = 0;
        const text = String(value ?? "");
        if (text !== "") {
          const node = createTextNode(text);
          node.parentNode = this;
          this.childNodes.push(node);
        }
      },
    });
    Object.defineProperty(element, "children", {
      get() { return this.childNodes.filter((child) => child.nodeType === 1); },
    });
    Object.defineProperty(element, "firstChild", {
      get() { return this.childNodes[0] ?? null; },
    });
    Object.defineProperty(element, "firstElementChild", {
      get() { return this.childNodes.find((child) => child.nodeType === 1) ?? null; },
    });
    Object.defineProperty(element, "lastElementChild", {
      get() {
        const children = this.childNodes.filter((child) => child.nodeType === 1);
        return children[children.length - 1] ?? null;
      },
    });
    Object.defineProperty(element, "id", {
      get() { return this._attrs.get("id") ?? ""; },
      set(value) { this._attrs.set("id", String(value)); },
    });
    element.setAttribute = (name, value) => {
      const key = String(name);
      element._attrs.set(key, String(value));
      if (key === "hidden") element.hidden = true;
      if (key === "disabled") element.disabled = true;
      if (key === "value") element.value = value;
    };
    element.getAttribute = (name) => (element._attrs.has(String(name)) ? element._attrs.get(String(name)) : null);
    element.hasAttribute = (name) => element._attrs.has(String(name));
    element.removeAttribute = (name) => {
      element._attrs.delete(String(name));
      if (name === "hidden") element.hidden = false;
      if (name === "disabled") element.disabled = false;
    };
    element.appendChild = (child) => {
      if (!child) return child;
      if (child.nodeType === 11) {
        for (const grandchild of [...child.childNodes]) element.appendChild(grandchild);
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = element;
      element.childNodes.push(child);
      return child;
    };
    element.append = (...nodes) => { for (const node of nodes) element.appendChild(node); };
    element.prepend = (...nodes) => {
      for (const node of nodes.reverse()) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = element;
        element.childNodes.unshift(node);
      }
    };
    element.removeChild = (child) => {
      const index = element.childNodes.indexOf(child);
      if (index >= 0) element.childNodes.splice(index, 1);
      if (child) child.parentNode = null;
      return child;
    };
    element.replaceChildren = (...nodes) => {
      while (element.childNodes.length) element.removeChild(element.childNodes[0]);
      for (const node of nodes) element.appendChild(node);
    };
    element.replaceWith = (...nodes) => {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(element);
      parent.childNodes.splice(index, 1, ...nodes);
      for (const node of nodes) node.parentNode = parent;
      element.parentNode = null;
    };
    element.remove = () => {
      if (element.parentNode) element.parentNode.removeChild(element);
    };
    // Enough of the select/geometry surface for the app's real ui/select.js
    // enhancement to run headless.
    element.before = (...nodes) => {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(element);
      parent.childNodes.splice(index, 0, ...nodes);
      for (const node of nodes) node.parentNode = parent;
    };
    element.after = (...nodes) => {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(element);
      parent.childNodes.splice(index + 1, 0, ...nodes);
      for (const node of nodes) node.parentNode = parent;
    };
    Object.defineProperty(element, "options", {
      get() {
        if (element.tagName !== "SELECT") return undefined;
        return element.children.filter((child) => child.tagName === "OPTION");
      },
    });
    Object.defineProperty(element, "selectedIndex", {
      get() {
        const options = element.options ?? [];
        return options.findIndex((option) => option.selected === true || option.value === element.value);
      },
    });
    element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
    element.scrollIntoView = () => {};
    element.insertBefore = (node, reference) => {
      const index = reference ? element.childNodes.indexOf(reference) : element.childNodes.length;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = element;
      element.childNodes.splice(index < 0 ? element.childNodes.length : index, 0, node);
      return node;
    };
    element.addEventListener = (type, listener) => {
      if (!element._listeners.has(type)) element._listeners.set(type, []);
      element._listeners.get(type).push(listener);
    };
    element.removeEventListener = (type, listener) => {
      const list = element._listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    };
    element.dispatchEvent = (event) => {
      const payload = event ?? { type: "" };
      // A real Event exposes read-only target/preventDefault; only fill gaps.
      try {
        if (payload.target === undefined) payload.target = element;
      } catch { /* read-only */ }
      if (typeof payload.preventDefault !== "function") payload.preventDefault = () => {};
      if (typeof payload.stopPropagation !== "function") payload.stopPropagation = () => {};
      for (const listener of element._listeners.get(payload.type) ?? []) listener.call(element, payload);
      const handler = element[`on${payload.type}`];
      if (typeof handler === "function") handler.call(element, payload);
      return true;
    };
    element.click = () => element.dispatchEvent({ type: "click" });
    element.focus = () => { document.activeElement = element; };
    element.matches = (selector) => matchesSelector(element, selector);
    element.closest = (selector) => {
      let node = element;
      while (node && node.nodeType === 1) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    };
    element.querySelector = (selector) => {
      let found = null;
      walk(element, (child) => {
        if (!found && matchesSelector(child, selector)) found = child;
      });
      return found;
    };
    element.querySelectorAll = (selector) => {
      const found = [];
      walk(element, (child) => {
        if (matchesSelector(child, selector)) found.push(child);
      });
      return found;
    };
    return element;
  }

  function createDocumentFragment() {
    const fragment = {
      nodeType: 11,
      nodeName: "#document-fragment",
      parentNode: null,
      childNodes: [],
      appendChild(child) {
        this.childNodes.push(child);
        if (child) child.parentNode = this;
        return child;
      },
    };
    return fragment;
  }

  const documentListeners = new Map();
  const document = {
    createElement,
    createElementNS: (_namespace, tag) => createElement(tag),
    createTextNode,
    createDocumentFragment,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = documentListeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event?.type) ?? []) listener(event);
      return true;
    },
    documentElement: createElement("html"),
    head: createElement("head"),
    body: createElement("body"),
    activeElement: null,
    querySelector(selector) {
      return this.documentElement.querySelector(selector)
        || this.head.querySelector(selector)
        || this.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return [
        ...this.documentElement.querySelectorAll(selector),
        ...this.head.querySelectorAll(selector),
        ...this.body.querySelectorAll(selector),
      ];
    },
    getElementById(id) {
      return this.querySelector(`#${id}`);
    },
  };

  function install() {
    globalThis.document = document;
    if (!globalThis.window) globalThis.window = globalThis;
    // Node >= 26 dropped the EventTarget methods from the global object, so a
    // headless window needs its own no-op listeners.
    if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
    if (typeof globalThis.removeEventListener !== "function") globalThis.removeEventListener = () => {};
    if (!globalThis.Node) globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
    if (!globalThis.MutationObserver) {
      globalThis.MutationObserver = class MutationObserver {
        constructor(callback) { this.callback = callback; }
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
      };
    }
  }

  return { document, install, createElement, createTextNode, createDocumentFragment };
}
