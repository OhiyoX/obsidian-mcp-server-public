import { icon } from "../../ui/icons.js";

function headingKey(index, heading) {
  return heading?.id || `outline-heading-${index + 1}`;
}

/**
 * Outline built from the source/editor heading model, not from a hidden reader DOM.
 * Preview nodes are bound by order only when the reader is visible.
 */
export function createOutline({ host, getScrollRoot, onNavigate, getEditorAnchor = null }) {
  let headings = [];
  let activeKey = null;
  let frame = 0;
  let navigationKey = null;
  const collapsed = new Set();

  function beginNavigation(key) {
    navigationKey = key;
  }

  function releaseNavigationFromInput(event) {
    if (!navigationKey || host.contains(event.target)) return;
    navigationKey = null;
    scheduleSync();
  }

  function tree() {
    const roots = [];
    const stack = [];
    for (const heading of headings) {
      const item = { ...heading, children: [] };
      while (stack.length && stack.at(-1).level >= item.level) stack.pop();
      if (stack.length) stack.at(-1).children.push(item);
      else roots.push(item);
      stack.push(item);
    }
    return roots;
  }

  function render() {
    host.replaceChildren();
    if (!headings.length) {
      const empty = document.createElement("div");
      empty.className = "context-empty";
      empty.textContent = "当前笔记没有标题";
      host.append(empty);
      return;
    }

    function append(items, parent) {
      for (const heading of items) {
        const node = document.createElement("div");
        node.className = "outline-node tree-item";
        node.dataset.level = String(heading.level);
        const row = document.createElement("div");
        row.className = "outline-row";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "outline-collapse";
        toggle.tabIndex = heading.children.length ? 0 : -1;
        toggle.hidden = !heading.children.length;
        toggle.title = collapsed.has(heading.key) ? "展开" : "折叠";
        toggle.setAttribute("aria-label", `${toggle.title} ${heading.title}`);
        toggle.setAttribute("aria-expanded", String(!collapsed.has(heading.key)));
        toggle.append(icon("chevron-right"));

        const button = document.createElement("button");
        button.type = "button";
        button.className = "outline-item tree-item-self";
        button.dataset.outlineKey = heading.key;
        button.textContent = heading.title;
        button.title = heading.title;
        button.classList.toggle("is-active", heading.key === activeKey);
        button.addEventListener("click", () => {
          beginNavigation(heading.key);
          setActive(heading.key);
          onNavigate(heading);
        });
        row.append(toggle, button);
        node.append(row);

        if (heading.children.length) {
          const children = document.createElement("div");
          children.className = "outline-children tree-item-children";
          children.hidden = collapsed.has(heading.key);
          toggle.addEventListener("click", () => {
            const isCollapsed = collapsed.has(heading.key);
            if (isCollapsed) collapsed.delete(heading.key);
            else collapsed.add(heading.key);
            children.hidden = !isCollapsed;
            toggle.classList.toggle("is-collapsed", !isCollapsed);
            toggle.title = isCollapsed ? "折叠" : "展开";
            toggle.setAttribute("aria-expanded", String(isCollapsed));
          });
          toggle.classList.toggle("is-collapsed", collapsed.has(heading.key));
          append(heading.children, children);
          node.append(children);
        }
        parent.append(node);
      }
    }
    append(tree(), host);
  }

  function setActive(key) {
    if (!key || key === activeKey) return;
    activeKey = key;
    host.querySelectorAll(".outline-item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.outlineKey === key);
    });
    host.querySelector(`[data-outline-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function syncActiveFromPreview(scrollRoot) {
    if (!headings.length || !scrollRoot || scrollRoot.hidden) return;
    const scrollable = scrollRoot.scrollHeight > scrollRoot.clientHeight + 2;
    if (scrollable && scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2) {
      setActive(headings.at(-1).key);
      return;
    }
    const rootTop = scrollRoot.getBoundingClientRect().top + 72;
    let current = headings[0];
    for (const heading of headings) {
      if (!heading.node) continue;
      if (heading.node.getBoundingClientRect().top <= rootTop) current = heading;
      else break;
    }
    setActive(current.key);
  }

  function resolveAnchorOffset(anchor) {
    if (anchor == null) return null;
    if (typeof anchor === "number" && !Number.isNaN(anchor)) return anchor;
    if (typeof anchor === "object") {
      const value = anchor.offset ?? anchor.from ?? anchor.pos ?? anchor.position;
      if (value != null && !Number.isNaN(Number(value))) return Number(value);
    }
    const asNumber = Number(anchor);
    return Number.isNaN(asNumber) ? null : asNumber;
  }

  function syncActiveFromEditor() {
    if (!headings.length || typeof getEditorAnchor !== "function") return;
    const offset = resolveAnchorOffset(getEditorAnchor());
    if (offset == null) return;
    let current = headings[0];
    for (const heading of headings) {
      if (heading.from <= offset) current = heading;
      else break;
    }
    if (current) setActive(current.key);
  }

  function syncActive() {
    frame = 0;
    if (navigationKey) return;
    const scrollRoot = typeof getScrollRoot === "function" ? getScrollRoot() : null;
    if (scrollRoot && !scrollRoot.hidden && scrollRoot.style?.display !== "none") {
      const hiddenByCss = scrollRoot.offsetParent === null && scrollRoot !== document.body;
      if (!hiddenByCss) {
        syncActiveFromPreview(scrollRoot);
        return;
      }
    }
    syncActiveFromEditor();
  }

  function scheduleSync() {
    if (!frame) frame = requestAnimationFrame(syncActive);
  }

  function normalize(sourceHeadings = []) {
    return sourceHeadings
      .map((heading, index) => {
        const title = String(heading.text ?? heading.title ?? "").trim();
        if (!title) return null;
        return {
          key: headingKey(index, heading),
          id: heading.id || headingKey(index, heading),
          title,
          level: Number(heading.level) || 1,
          from: Number(heading.from) || 0,
          to: Number(heading.to) || Number(heading.from) || 0,
          node: null,
        };
      })
      .filter(Boolean);
  }

  function sameVisibleStructure(nextHeadings) {
    if (headings.length !== nextHeadings.length) return false;
    return headings.every((heading, index) => {
      const next = nextHeadings[index];
      return heading.key === next.key
        && heading.title === next.title
        && heading.level === next.level;
    });
  }

  function setHeadings(sourceHeadings = []) {
    const nextHeadings = normalize(sourceHeadings);
    const structureUnchanged = sameVisibleStructure(nextHeadings);
    const previousActiveKey = activeKey;
    headings = nextHeadings;
    activeKey = headings.some((heading) => heading.key === previousActiveKey)
      ? previousActiveKey
      : headings[0]?.key || null;
    const liveKeys = new Set(headings.map((heading) => heading.key));
    for (const key of collapsed) {
      if (!liveKeys.has(key)) collapsed.delete(key);
    }
    if (navigationKey && (!structureUnchanged || !liveKeys.has(navigationKey))) navigationKey = null;
    if (!structureUnchanged) render();
    scheduleSync();
    return headings;
  }

  /** Bind rendered preview heading nodes by document order for scroll sync/navigation. */
  function bindPreviewNodes(root) {
    if (!root) return;
    const nodes = [...root.querySelectorAll(
      ".markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3, .markdown-preview-view h4, .markdown-preview-view h5, .markdown-preview-view h6",
    )];
    headings.forEach((heading, index) => {
      const node = nodes[index] || null;
      heading.node = node;
      if (node) {
        node.dataset.outlineKey = heading.key;
        if (heading.id) node.id = heading.id;
      }
    });
    scheduleSync();
  }

  function clear(message = "打开笔记后显示大纲与反链") {
    headings = [];
    activeKey = null;
    navigationKey = null;
    host.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "context-empty";
    empty.textContent = message;
    host.append(empty);
  }

  function scrollTo(keyOrHeading) {
    const key = typeof keyOrHeading === "string" ? keyOrHeading : keyOrHeading?.key;
    const target = headings.find((heading) => heading.key === key || heading.id === key);
    if (!target) return;
    if (target.node) {
      beginNavigation(target.key);
      target.node.scrollIntoView({ behavior: "smooth", block: "start" });
      setActive(target.key);
      return;
    }
    // A missing preview node cannot be navigated by calling the owner again:
    // its preview handler calls scrollTo, which would recurse indefinitely.
    return false;
  }

  const initialRoot = typeof getScrollRoot === "function" ? getScrollRoot() : null;
  initialRoot?.addEventListener("scroll", scheduleSync, { passive: true });
  document.addEventListener("wheel", releaseNavigationFromInput, { capture: true, passive: true });
  document.addEventListener("touchstart", releaseNavigationFromInput, { capture: true, passive: true });
  document.addEventListener("pointerdown", releaseNavigationFromInput, { capture: true });
  document.addEventListener("keydown", releaseNavigationFromInput, { capture: true });
  clear();
  return {
    clear,
    setHeadings,
    bindPreviewNodes,
    scrollTo,
    scheduleSync,
    getHeadings: () => headings.map((heading) => ({ ...heading })),
  };
}
