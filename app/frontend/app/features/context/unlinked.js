// Unlinked mentions section for the note-context sidebar (U2 desktop parity).
//
// Desktop's Outgoing links pane renders a second section below the link list,
// 「当前笔记中潜在的链接」: text in the current note that matches another note's name
// or alias but is not linked. Each entry is the matched line as a context excerpt
// with the match highlighted, followed by one chip per candidate note for every
// matched name.
//
// Self-contained like `outgoing.js`/`incoming.js`: it renders only inside its own
// host, registers no global listeners and never polls. The host wiring (document
// switch, `openNote`, API client) is supplied by the caller.
//
// Safety: every excerpt/name/path is untrusted text. The excerpt is rendered as
// text nodes plus a numeric highlight range; there is no raw-HTML sink.
import { rowContent } from "./row.js";

export const UNLINKED_MESSAGES = {
  idle: "打开笔记后显示潜在的链接",
  base: "Base 文档没有潜在的链接",
  loading: "正在加载潜在的链接…",
  empty: "没有潜在的链接",
  error: "潜在的链接加载失败",
};

const IDLE_MESSAGE = UNLINKED_MESSAGES.idle;
const BASE_MESSAGE = UNLINKED_MESSAGES.base;
const LOADING_MESSAGE = UNLINKED_MESSAGES.loading;
const EMPTY_LIST_MESSAGE = UNLINKED_MESSAGES.empty;
const ERROR_MESSAGE = UNLINKED_MESSAGES.error;
const RETRY_LABEL = "重试";

function normalizeHighlights(value, length) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((hit) => hit && Number.isInteger(hit.start) && Number.isInteger(hit.end))
    .filter((hit) => hit.start >= 0 && hit.end > hit.start && hit.end <= length)
    .sort((left, right) => left.start - right.start);
}

function normalizeItems(mentions) {
  if (!Array.isArray(mentions)) return [];
  return mentions
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const excerpt = String(item.excerpt ?? "");
      const highlights = normalizeHighlights(item.highlights, excerpt.length);
      const chips = Array.isArray(item.chips)
        ? item.chips
          .filter((chip) => chip && typeof chip === "object")
          .map((chip) => ({ name: String(chip.name ?? ""), path: typeof chip.path === "string" ? chip.path : "" }))
          .filter((chip) => chip.name && chip.path)
        : [];
      return { line: Number.isInteger(item.line) ? item.line : null, excerpt, highlights, chips };
    });
}

export function createUnlinkedMentions({
  host,
  fetchUnlinked,
  openNote = () => {},
  countHost = null,
  documentRef = globalThis.document,
} = {}) {
  let state = { status: "idle", path: null, vaultId: null, documentKind: null, items: [] };
  let seq = 0;
  let controller = null;

  // The header count is the number of rendered entries (desktop parity).
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

  function renderExcerpt(item) {
    const block = documentRef.createElement("div");
    block.className = "unlinked-excerpt";
    let cursor = 0;
    for (const hit of item.highlights) {
      if (hit.start < cursor) continue;
      if (hit.start > cursor) block.append(documentRef.createTextNode(item.excerpt.slice(cursor, hit.start)));
      const mark = documentRef.createElement("mark");
      mark.className = "unlinked-hit";
      mark.textContent = item.excerpt.slice(hit.start, hit.end);
      block.append(mark);
      cursor = hit.end;
    }
    if (cursor < item.excerpt.length) block.append(documentRef.createTextNode(item.excerpt.slice(cursor)));
    return block;
  }

  function renderChips(item) {
    const chips = documentRef.createElement("div");
    chips.className = "unlinked-chips";
    for (const chip of item.chips) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "unlinked-chip";
      button.title = chip.path;
      button.setAttribute("aria-label", `${chip.name} → ${chip.path}`);
      button.append(...rowContent(documentRef, { text: chip.name, mainClass: "unlinked-chip-name" }));
      button.addEventListener("click", () => openNote(chip.path));
      chips.append(button);
    }
    return chips;
  }

  function renderRow(item) {
    const row = documentRef.createElement("li");
    row.className = "unlinked-item";
    if (item.line !== null) row.dataset.line = String(item.line);
    row.append(renderExcerpt(item));
    if (item.chips.length) row.append(renderChips(item));
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
    list.className = "unlinked-list-items";
    for (const item of items) list.append(renderRow(item));
    host.append(list);
  }

  function renderError() {
    setCount(0);
    if (!host || typeof documentRef?.createElement !== "function") return;
    host.replaceChildren();
    const wrap = documentRef.createElement("div");
    wrap.className = "context-empty unlinked-error";
    const text = documentRef.createElement("span");
    text.textContent = ERROR_MESSAGE;
    const retry = documentRef.createElement("button");
    retry.type = "button";
    retry.className = "unlinked-retry";
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
      const data = await fetchUnlinked({ path, vaultId, signal: controller.signal });
      if (token !== seq) return;
      const items = normalizeItems(data?.mentions);
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
    message(LOADING_MESSAGE, "context-empty unlinked-loading");
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
    message(LOADING_MESSAGE, "context-empty unlinked-loading");
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
