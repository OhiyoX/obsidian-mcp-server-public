import { DEFAULT_NOTE_NAME, activeDraft, beginDraft, preserveActiveDraft, renderActiveDraft, settleActiveDraft } from "./create-draft.js";
import { bindFolderHoverIntent } from "./prefetch-hover.js";

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Row horizontal geometry (lazy renderer): the indent lives in the row's own padding
// rather than in the container, so a highlighted row spans the whole list width with its
// own rounded left edge. Keep these in step with .note-list padding, .tree-children indent
// and the two text indents in app.css.
const LIST_PADDING = 6;
const INDENT_STEP = 23;
const ROW_EDGE_INSET = 4;
const NOTE_TEXT_INDENT = 21;
const FOLDER_TEXT_INDENT = 6;

function isCurrentNote(notePath, currentPath) {
  const note = normalizePath(notePath);
  const current = normalizePath(currentPath);
  if (!note || !current) return false;
  if (note === current) return true;
  return note.replace(/\.md$/i, "") === current.replace(/\.md$/i, "");
}

// A Base is file-level content but NOT a note: the note identity above strips `.md`,
// which would let `X.base` match a same-stem `X.md`. Selection must be exact
// document kind + exact path (Bases TODO §4.1), so Base uses plain path equality.
function isCurrentBase(basePath, currentPath) {
  const base = normalizePath(basePath);
  const current = normalizePath(currentPath);
  return Boolean(base) && base === current;
}

// Desktop file-explorer shape: a `.base` row is an ordinary file row (no custom
// glyph) whose right edge carries a muted `BASE` tag. The tag reuses the sidebar
// hover/muted tokens only — no invented colors.
export const BASE_TAG_TEXT = "BASE";

// Inline create drafts (issue #427) are owned by `create-draft.js`: it holds the single
// draft slot, the token-scoped commit-once rule and the cancel semantics. This renderer
// only resolves DOM containers and repaints the active row.
function draftContainer(host, scope) {
  if (!scope) return host;
  // Match on the row's own dataset instead of building an attribute selector: the folder
  // path is data, not a CSS identifier. The children container is the row's next element
  // sibling (the renderer always appends the two together).
  const wrap = [...host.querySelectorAll(".tree-folder-row")].find((row) => row.dataset?.folderPath === scope);
  const parent = wrap?.parentNode;
  const siblings = parent ? [...parent.children] : [];
  const index = siblings.indexOf(wrap);
  const children = index >= 0 ? siblings[index + 1] : null;
  return children?.classList?.contains?.("tree-children") ? children : null;
}

function hasRootDraft() {
  const draft = activeDraft();
  return Boolean(draft) && !draft.scope;
}

// Open a note draft for one tree entry (a folder row's `+`). `scope` is the parent the
// note will be created in; the panel-head entries open through the controller instead.
function openDraft({ host, scope, scopeLabel, onCreateNote }) {
  const container = draftContainer(host, scope);
  if (!container) return false;
  container.hidden = false;
  return beginDraft({
    host,
    container,
    // A repaint (SSE / sort / refetch) rebuilds every folder's children, so the row of a
    // failed commit must be re-rendered into the container that is live at that point.
    resolveContainer: () => {
      const live = draftContainer(host, scope);
      if (live) live.hidden = false;
      return live;
    },
    kind: "note",
    scope,
    scopeLabel,
    initialValue: DEFAULT_NOTE_NAME,
    onCommit: (name) => onCreateNote?.(scope, name),
  });
}

// Repaint the active draft into its container. The two phases preserve the original
// order: a root-scope draft sits above every row / placeholder, an in-folder draft lives
// inside the folder's live children (which only exist once the level is rendered).
function renderDraft({ host, phase, preserved }) {
  const draft = activeDraft();
  if (!draft) return false;
  if ((!draft.scope) !== (phase === "root")) return false;
  const container = draftContainer(host, draft.scope);
  if (!container) {
    settleActiveDraft();
    return false;
  }
  return renderActiveDraft({ host, container, preserved });
}

// Search renderer: renders the derived view ({ spec, root }) built by view-model.js
// from the currently returned search result set. Ordering is fully delegated to the
// pure sort-model through that view; this renderer never sorts.
function isEmptyView(view) {
  return view.root.folders.length === 0 && view.root.notes.length === 0;
}

export function renderExplorer({
  host,
  view,
  currentPath,
  query,
  expanded,
  searchCollapsed = new Set(),
  escapeHtml,
  onFolder,
  onEnsureExpanded,
  onCreateNote,
  onNote,
  revealCurrent = false,
}) {
  const preserved = preserveActiveDraft();
  host.innerHTML = "";
  renderDraft({ host, phase: "root", preserved });
  if (isEmptyView(view)) {
    host.innerHTML = '<div class="empty">没有找到笔记</div>';
    settleActiveDraft();
    return;
  }

  function renderBranch(node, parent) {
    for (const folder of node.folders) {
      const folderPath = folder.path;
      const open = query ? !searchCollapsed.has(folderPath) : expanded.has(folderPath);

      const rowWrap = document.createElement("div");
      rowWrap.className = "tree-folder-row";
      rowWrap.dataset.folderPath = folderPath;

      const row = document.createElement("button");
      row.type = "button";
      row.className = "tree-folder";
      row.setAttribute("aria-expanded", open ? "true" : "false");
      row.title = folderPath;
      row.innerHTML = `<span class="tree-caret" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m5.5 3.5 4.5 4.5-4.5 4.5"/></svg></span><span class="tree-folder-name">${escapeHtml(folder.name)}</span>`;

      const add = document.createElement("button");
      add.type = "button";
      add.className = "tree-folder-add";
      add.title = `在 ${folder.name} 中新建笔记`;
      add.setAttribute("aria-label", add.title);
      add.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

      const children = document.createElement("div");
      children.className = "tree-children";
      children.hidden = !open;

      row.onclick = () => onFolder(folderPath);
      add.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.setAttribute("aria-expanded", "true");
        // Ensure the level exists first (a v1 render may replace the host), then open the
        // draft against the container that is really in the DOM.
        onEnsureExpanded?.(folderPath);
        openDraft({ host, scope: folderPath, scopeLabel: folder.name, onCreateNote });
      };

      rowWrap.append(row, add);
      parent.append(rowWrap, children);
      renderBranch(folder.children, children);
    }

    for (const note of node.notes) {
      const button = document.createElement("button");
      const active = isCurrentNote(note.path, currentPath);
      button.className = `note${active ? " active" : ""}`;
      button.dataset.path = note.path;
      if (active) button.setAttribute("aria-current", "page");
      button.title = note.path;
      const snippet = query && note.snippets?.[0]
        ? `<div class="note-snippet">${escapeHtml(note.snippets[0]).replace(/\s+/g, " ")}</div>`
        : "";
      button.innerHTML = `<div class="note-title">${escapeHtml(note.title)}</div>${snippet}`;
      button.onclick = () => onNote(note.path);
      parent.append(button);
    }
  }

  renderBranch(view.root, host);
  renderDraft({ host, phase: "folder", preserved });
  if (revealCurrent) {
    host.querySelector('.note[aria-current="page"]')?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}

// Lazy renderer: renders one directory level at a time from the per-parent children
// map in the server's ordering. It never re-sorts a page — the ordering (and the
// cursor that walks it) belongs to the server for the current SortSpec. Folders are
// folder-first because the server's ordering tuple is folder-first.
export function renderLazyExplorer({
  host,
  model,
  currentPath,
  escapeHtml,
  onToggle,
  onLoadMore,
  onRetry,
  onEnsureExpanded,
  onCreateNote,
  onNote,
  onOpenBase,
  onOpenFile,
  // Issue #284 B2: hover intent is a bare event; `prefetch.js` owns the policy.
  hoverIntent,
  revealCurrent = false,
}) {
  const preserved = preserveActiveDraft();
  host.innerHTML = "";

  // A root-scope draft (panel-head new note / new folder) is rebuilt at the top of the
  // root level, above every row and above any empty/loading placeholder (the renderer owns
  // the host's innerHTML); an in-folder draft is rebuilt once its folder row exists.
  renderDraft({ host, phase: "root", preserved });

  const rootItems = model.childrenByParent.get("");
  if (!Array.isArray(rootItems)) {
    if (model.errorByParent.has("")) {
      host.append(buildLoadError("", model, onRetry));
    } else if (!hasRootDraft()) {
      host.innerHTML = '<div class="empty">正在加载…</div>';
    }
    renderDraft({ host, phase: "folder", preserved });
    return;
  }
  if (rootItems.length === 0 && !model.nextCursorByParent.get("")) {
    if (!hasRootDraft()) host.innerHTML = '<div class="empty">没有找到笔记</div>';
    renderDraft({ host, phase: "folder", preserved });
    return;
  }

  function renderLoadMore(parent, container) {
    const cursor = model.nextCursorByParent.get(parent);
    if (!cursor) return;
    const loading = model.loadingParents.has(parent);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-load-more";
    button.dataset.parentPath = parent;
    // While loading, the sentinel must not re-fire: a second click would abort and
    // restart the same-parent request with the same cursor.
    button.disabled = loading;
    button.textContent = loading ? "正在加载…" : "加载更多";
    button.onclick = () => onLoadMore?.(parent);
    container.append(button);
  }

  // An indented row still highlights its WHOLE row (desktop shape), so each row's box is
  // pulled left to just inside the list edge and the indent becomes padding. The pull is
  // exact per depth, which keeps the row's own border-radius on the visible left edge
  // instead of leaving a clipped, square edge behind the list's overflow.
  function applyRowGeometry(row, depth) {
    const indentToday = LIST_PADDING + INDENT_STEP * depth;
    const pull = indentToday - ROW_EDGE_INSET;
    row.style.marginLeft = `-${pull}px`;
    row.style.width = `calc(100% + ${pull}px)`;
    return indentToday;
  }

  function renderNote(item, container, depth) {
    const button = document.createElement("button");
    const active = isCurrentNote(item.path, currentPath);
    button.className = `note${active ? " active" : ""}`;
    button.dataset.path = item.path;
    if (active) button.setAttribute("aria-current", "page");
    button.title = item.path;
    const indentToday = applyRowGeometry(button, depth);
    button.style.paddingLeft = `${indentToday + NOTE_TEXT_INDENT - ROW_EDGE_INSET}px`;
    button.innerHTML = `<div class="note-title">${escapeHtml(item.title ?? item.name ?? item.path)}</div>`;
    button.onclick = () => onNote?.(item.path);
    container.append(button);
  }

  // A Base is a file-level node rendered like a note row but with its own icon and
  // an explicit open seam: the renderer only emits the intent, navigation lives in
  // the caller (B4). Display name is the stem (`title`); `title`/`aria-label` keep
  // the full path including `.base` (Bases TODO §4.1).
  function renderBase(item, container, depth) {
    const button = document.createElement("button");
    const active = isCurrentBase(item.path, currentPath);
    button.className = `note note-base${active ? " active" : ""}`;
    button.dataset.path = item.path;
    button.dataset.kind = "base";
    if (active) button.setAttribute("aria-current", "page");
    button.title = item.path;
    button.setAttribute("aria-label", item.path);
    const indentToday = applyRowGeometry(button, depth);
    button.style.paddingLeft = `${indentToday + NOTE_TEXT_INDENT - ROW_EDGE_INSET}px`;
    button.innerHTML = `<span class="note-title">${escapeHtml(item.title ?? item.name ?? item.path)}</span><span class="note-badge">${BASE_TAG_TEXT}</span>`;
    button.onclick = () => onOpenBase?.({ path: item.path });
    container.append(button);
  }

  // An attachment is a file-level node rendered like a note row with the desktop
  // suffix badge on its right edge. Desktop shows the full file name (extension
  // included) and a muted uppercase suffix tag; a file without an extension shows
  // no badge at all. The badge reuses the same `.note-badge` spec as `BASE`.
  function renderFile(item, container, depth) {
    const button = document.createElement("button");
    button.className = "note note-file";
    button.dataset.path = item.path;
    button.dataset.kind = "file";
    button.title = item.path;
    button.setAttribute("aria-label", item.path);
    const indentToday = applyRowGeometry(button, depth);
    button.style.paddingLeft = `${indentToday + NOTE_TEXT_INDENT - ROW_EDGE_INSET}px`;
    const title = document.createElement("span");
    title.className = "note-title";
    title.textContent = item.title ?? item.name ?? item.path;
    button.append(title);
    const extension = String(item.extension ?? "").trim();
    if (extension) {
      const badge = document.createElement("span");
      badge.className = "note-badge";
      badge.textContent = extension.toUpperCase();
      button.append(badge);
    }
    button.onclick = () => onOpenFile?.(item);
    container.append(button);
  }

  function renderFolder(item, container, depth) {
    const open = model.expanded.has(item.path);
    const rowWrap = document.createElement("div");
    rowWrap.className = "tree-folder-row";
    rowWrap.dataset.folderPath = item.path;
    const indentToday = applyRowGeometry(rowWrap, depth);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-folder";
    row.setAttribute("aria-expanded", open ? "true" : "false");
    row.title = item.path;
    row.style.paddingLeft = `${indentToday + FOLDER_TEXT_INDENT - ROW_EDGE_INSET}px`;
    row.innerHTML = `<span class="tree-caret" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m5.5 3.5 4.5 4.5-4.5 4.5"/></svg></span><span class="tree-folder-name">${escapeHtml(item.name ?? item.path)}</span>`;

    const add = document.createElement("button");
    add.type = "button";
    add.className = "tree-folder-add";
    add.title = `在 ${item.name ?? item.path} 中新建笔记`;
    add.setAttribute("aria-label", add.title);
    add.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

    const children = document.createElement("div");
    children.className = "tree-children";
    children.hidden = !open;

    row.onclick = () => onToggle?.(item.path);
    bindFolderHoverIntent(row, item.path, hoverIntent);
    add.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.setAttribute("aria-expanded", "true");
      // Ensure the level is loaded FIRST: a lazy load re-renders the host, so the
      // container must be re-resolved afterwards or the inline editor lands in a
      // detached subtree (the collapsed+unloaded first-`+` race) — `openDraft`
      // resolves the container after this await.
      await onEnsureExpanded?.(item.path);
      openDraft({ host, scope: item.path, scopeLabel: item.name ?? item.path, onCreateNote });
    };

    rowWrap.append(row, add);
    container.append(rowWrap, children);
    if (!open) return;

    if (!model.childrenByParent.has(item.path)) {
      if (model.errorByParent.has(item.path)) children.append(buildLoadError(item.path, model, onRetry));
      else if (model.loadingParents.has(item.path)) children.innerHTML = '<div class="empty">正在加载…</div>';
    } else {
      renderLevel(item.path, children, depth + 1);
    }
  }

  // renderLevel() is the single load-more sentinel exit for a parent; renderFolder()
  // must not append a second one. `depth` feeds the per-row horizontal geometry above.
  function renderLevel(parent, container, depth = 0) {
    if (model.errorByParent.has(parent) && !model.childrenByParent.has(parent)) {
      container.append(buildLoadError(parent, model, onRetry));
      return;
    }
    for (const item of model.childrenByParent.get(parent) ?? []) {
      if (item.kind === "directory") renderFolder(item, container, depth);
      else if (item.kind === "base") renderBase(item, container, depth);
      else if (item.kind === "file") renderFile(item, container, depth);
      else renderNote(item, container, depth);
    }
    renderLoadMore(parent, container);
  }

  renderLevel("", host);
  renderDraft({ host, phase: "folder", preserved });
  if (revealCurrent) {
    host.querySelector('.note[aria-current="page"]')?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}

// Explicit, owned error state: a failed first page is never rendered as an empty
// "completed" tree and never leaves mixed rows behind.
function buildLoadError(parent, model, onRetry) {
  const wrap = document.createElement("div");
  wrap.className = "tree-load-error";
  wrap.dataset.parentPath = parent;
  const message = document.createElement("span");
  message.className = "tree-load-error-text";
  message.textContent = "加载失败";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "tree-retry";
  retry.textContent = "重试";
  retry.onclick = () => onRetry?.(parent);
  wrap.append(message, retry);
  return wrap;
}
