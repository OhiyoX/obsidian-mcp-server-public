// Incoming links (backlinks) section for the note-context sidebar (sidebar Phase 3).
//
// Self-contained like `outgoing.js`: it renders only inside its own host, registers
// no global listeners and never touches other chrome. The host wiring (document
// switch, `openNote`, API client) is supplied by the caller, so the existing
// document-switch callbacks drive `setDocument` / `clear`; the module never polls.
//
// Safety: every alias/source path is untrusted text. Rendering uses textContent and
// validated attributes only; there is no raw-HTML sink.
//
// Contract: TODO - Obsidian Web 笔记信息侧栏.md (Phase 3), frozen DTO:
//   { sourcePath, target, alias, heading }
// Only sources that resolve to the current note are listed (the API never sends
// external/asset/unresolved targets), so every row navigates; a missing
// `sourcePath` still degrades to an inert, faded row instead of a fake control.

// row, and the U2 desktop parity rule: the row shows the source note's full
// vault-relative path plus a muted parent-directory subline (the alias, when one
// exists, stays available through the row tooltip).
import { parentDirOf, rowContent, stripNoteExtension } from "./row.js";

export const INCOMING_MESSAGES = {
  idle: "打开笔记后显示反向链接",
  base: "Base 文档没有反向链接",
  loading: "正在加载反向链接…",
  // Desktop wording for the Backlinks empty state; flagged for user re-verification
  // in the H2 handoff because the reference screenshots only show the outgoing panel.
  empty: "没有反向链接",
  error: "反向链接加载失败",
};

const IDLE_MESSAGE = INCOMING_MESSAGES.idle;
const BASE_MESSAGE = INCOMING_MESSAGES.base;
const LOADING_MESSAGE = INCOMING_MESSAGES.loading;
const EMPTY_LIST_MESSAGE = INCOMING_MESSAGES.empty;
const ERROR_MESSAGE = INCOMING_MESSAGES.error;
const RETRY_LABEL = "重试";

function normalizeItems(links) {
  if (!Array.isArray(links)) return [];
  return links
    .filter((link) => link && typeof link === "object")
    .map((link) => ({
      sourcePath: typeof link.sourcePath === "string" ? link.sourcePath : "",
      target: String(link.target ?? ""),
      alias: link.alias == null ? null : String(link.alias),
      heading: link.heading == null ? null : String(link.heading),
    }));
}

export function createIncomingLinks({
  host,
  fetchIncoming,
  openNote = () => {},
  countHost = null,
  documentRef = globalThis.document,
} = {}) {
  let state = { status: "idle", path: null, vaultId: null, documentKind: null, items: [] };
  let seq = 0;
  let controller = null;

  // The header count is the number of rendered rows (desktop parity), so it is
  // written next to every render path and never derived separately.
  function setCount(value) {
    if (countHost) countHost.textContent = String(value);
  }

  function message(text, className = "context-empty") {
    setCount(0);
    if (!host || typeof documentRef?.createElement !== "function") return;
    host.replaceChildren();
    const node = documentRef.createElement("div");
    node.className = className;
    node.textContent = text;
    host.append(node);
  }

  function renderRow(item) {
    const row = documentRef.createElement("li");
    const resolved = Boolean(item.sourcePath);
    row.className = resolved ? "incoming-item" : "incoming-item incoming-item-unresolved";
    row.dataset.sourcePath = item.sourcePath;
    // No alias handling here: the incoming projection always sends `alias: null`
    // (the catalog's link targets drop aliases, see note-context.js), so the tooltip
    // stays the source path. Outgoing rows, which do carry aliases, use `rowTitle`.
    row.title = item.sourcePath || item.target;
    const text = stripNoteExtension(item.sourcePath) || item.target;
    const parent = parentDirOf(item.sourcePath || text);

    if (resolved) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "incoming-link context-row";
      button.append(...rowContent(documentRef, { text, parent, mainClass: "incoming-row-path" }));
      button.addEventListener("click", () => openNote(item.sourcePath, { fragment: item.heading || "" }));
      row.append(button);
      return row;
    }

    // Defensive: the API only sends resolved sources, so this is an inert fallback
    // (never a control that cannot work).
    const span = documentRef.createElement("span");
    span.className = "incoming-unresolved context-row";
    span.setAttribute("aria-disabled", "true");
    span.append(...rowContent(documentRef, { text, parent, mainClass: "incoming-row-path" }));
    row.append(span);
    return row;
  }

  function renderItems(items) {
    setCount(items.length);
    if (!host || typeof documentRef?.createElement !== "function") return;
    if (!items.length) {
      message(EMPTY_LIST_MESSAGE);
      return;
    }
    host.replaceChildren();
    const list = documentRef.createElement("ul");
    list.className = "incoming-list-items";
    for (const item of items) list.append(renderRow(item));
    host.append(list);
  }

  function renderError() {
    setCount(0);
    if (!host || typeof documentRef?.createElement !== "function") return;
    host.replaceChildren();
    const wrap = documentRef.createElement("div");
    wrap.className = "context-empty incoming-error";
    const text = documentRef.createElement("span");
    text.textContent = ERROR_MESSAGE;
    const retry = documentRef.createElement("button");
    retry.type = "button";
    retry.className = "incoming-retry";
    retry.textContent = RETRY_LABEL;
    retry.addEventListener("click", () => { void refresh(); });
    wrap.append(text, retry);
    host.append(wrap);
  }

  function cancel() {
    if (controller) {
      try { controller.abort(); } catch { /* already aborted */ }
      controller = null;
    }
  }

  async function load(token, path, vaultId) {
    controller = new AbortController();
    try {
      const data = await fetchIncoming({ path, vaultId, signal: controller.signal });
      if (token !== seq) return;
      const items = normalizeItems(data?.links);
      state = { ...state, status: items.length ? "ready" : "empty", items };
      renderItems(items);
    } catch (error) {
      if (token !== seq || error?.name === "AbortError") return;
      state = { ...state, status: "error", items: [] };
      renderError();
    }
  }

  function clear(text = IDLE_MESSAGE) {
    seq += 1;
    cancel();
    state = { status: "idle", path: null, vaultId: null, documentKind: null, items: [] };
    message(text);
  }

  async function setDocument({ path, vaultId = null, documentKind = "note" } = {}) {
    if (documentKind === "base") {
      clear(BASE_MESSAGE);
      state.documentKind = "base";
      return getState();
    }
    if (!path) {
      clear(IDLE_MESSAGE);
      return getState();
    }
    seq += 1;
    cancel();
    const token = seq;
    state = { status: "loading", path: String(path), vaultId: vaultId ?? null, documentKind: "note", items: [] };
    message(LOADING_MESSAGE, "context-empty incoming-loading");
    await load(token, state.path, state.vaultId);
    return getState();
  }

  async function refresh() {
    if (!state.path || state.documentKind === "base") return getState();
    const { path, vaultId } = state;
    seq += 1;
    cancel();
    const token = seq;
    state = { ...state, status: "loading", items: [] };
    message(LOADING_MESSAGE, "context-empty incoming-loading");
    await load(token, path, vaultId);
    return getState();
  }

  function getState() {
    return { ...state, items: state.items.map((item) => ({ ...item })) };
  }

  function destroy() {
    seq += 1;
    cancel();
    state = { status: "idle", path: null, vaultId: null, documentKind: null, items: [] };
    setCount(0);
    if (host && typeof host.replaceChildren === "function") host.replaceChildren();
  }

  message(IDLE_MESSAGE);

  return { setDocument, refresh, clear, getState, destroy };
}
