// Outgoing links section for the note-context sidebar (sidebar Phase 2).
//
// Self-contained: it renders only inside its own host, registers no global
// listeners and never touches other chrome. The host wiring (document switch,
// `openNote`, API client) is supplied by the caller so the existing document
// switch callbacks drive `setDocument` / `clear`; the module itself never polls.
//
// Safety: every alias/target is untrusted text. Rendering uses textContent and
// validated attributes only; there is no raw-HTML sink. An `external` kind whose
// URL does not pass the scheme allowlist is rendered as a non-interactive item.
//
// Contract: TODO - Obsidian Web 笔记信息侧栏.md (Phase 2), frozen DTO:
//   { target, kind: note|asset|external|unresolved, resolvedPath, alias, heading }
//
// Section copy follows the desktop Outgoing links pane (see the U2 reference
// screenshots): the list's own header is 「当前笔记中的链接」 and its empty state is
// 「没有链接」; the second section below it is 「当前笔记中潜在的链接」 (rendered by
// `unlinked.js`). The idle/Base/loading/error states are Web-only states desktop does
// not have and keep their own copy.
import { parentDirOf, rowContent, rowTitle, stripNoteExtension } from "./row.js";

export const OUTGOING_MESSAGES = {
  idle: "打开笔记后显示出链",
  base: "Base 文档没有出链",
  loading: "正在加载出链…",
  empty: "没有链接",
  error: "出链加载失败",
};

const IDLE_MESSAGE = OUTGOING_MESSAGES.idle;
const BASE_MESSAGE = OUTGOING_MESSAGES.base;
const LOADING_MESSAGE = OUTGOING_MESSAGES.loading;
const EMPTY_LIST_MESSAGE = OUTGOING_MESSAGES.empty;
const ERROR_MESSAGE = OUTGOING_MESSAGES.error;
const RETRY_LABEL = "重试";

// External navigation is limited to schemes a link may safely open. Anything
// else (javascript:, data:, vbscript:, …) degrades to an unresolved, inert item.
const SAFE_EXTERNAL_PROTOCOL = /^(https?|mailto|tel):$/i;

export function safeExternalUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const candidate = raw.startsWith("//") ? `https:${raw}` : raw;
    const parsed = new URL(candidate);
    return SAFE_EXTERNAL_PROTOCOL.test(parsed.protocol) ? raw : null;
  } catch {
    return null;
  }
}

// Reuses the authenticated asset route the Reader embeds already use.
export function defaultAssetUrl(target, sourcePath = "", vaultId = null) {
  const query = new URLSearchParams({ path: String(target ?? "").split("#", 1)[0] });
  if (sourcePath) query.set("from", String(sourcePath));
  if (vaultId) query.set("vaultId", String(vaultId));
  return `/api/web/v1/asset?${query.toString()}`;
}

function defaultOpenAsset(url) {
  globalThis.window?.open?.(url, "_blank", "noopener,noreferrer");
}

function defaultOpenExternal(url) {
  globalThis.window?.open?.(url, "_blank", "noopener,noreferrer");
}

function rowTextFor(item) {
  // Desktop shows the full vault-relative path for a resolved note/asset and the
  // raw target for an external/unresolved entry (external keeps its URL text).
  if (item.kind === "note" && item.resolvedPath) return stripNoteExtension(item.resolvedPath);
  return item.target;
}

function normalizeItems(links) {
  if (!Array.isArray(links)) return [];
  const allowed = new Set(["note", "asset", "external", "unresolved"]);
  return links
    .filter((link) => link && typeof link === "object")
    .map((link) => ({
      target: String(link.target ?? ""),
      kind: allowed.has(link.kind) ? link.kind : "unresolved",
      resolvedPath: typeof link.resolvedPath === "string" ? link.resolvedPath : null,
      alias: link.alias == null ? null : String(link.alias),
      heading: link.heading == null ? null : String(link.heading),
    }));
}

export function createOutgoingLinks({
  host,
  fetchOutgoing,
  openNote = () => {},
  openAsset = defaultOpenAsset,
  openExternal = defaultOpenExternal,
  getAssetUrl = defaultAssetUrl,
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

  function renderRow(item, sourcePath, vaultId) {
    const row = documentRef.createElement("li");
    row.className = `outgoing-item outgoing-item-${item.kind}`;
    row.dataset.kind = item.kind;
    if (item.resolvedPath) row.dataset.resolvedPath = item.resolvedPath;
    // The row text is the full path (see `rowTextFor`), so an alias stays reachable
    // only through the tooltip: `alias (resolvedPath)`, or the path unchanged.
    const titleBase = item.kind === "note" && item.resolvedPath ? item.resolvedPath : item.target;
    row.title = rowTitle(titleBase, item.alias);

    const text = rowTextFor(item);
    // External rows keep their URL text and never grow a parent-directory subline.
    const parent = item.kind === "external" ? null : parentDirOf(item.resolvedPath || text);

    if (item.kind === "note" && item.resolvedPath) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "outgoing-link context-row";
      button.append(...rowContent(documentRef, { text, parent, mainClass: "outgoing-row-path" }));
      button.addEventListener("click", () => openNote(item.resolvedPath, { fragment: item.heading || "" }));
      row.append(button);
      return row;
    }

    if (item.kind === "asset") {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "outgoing-link outgoing-asset context-row";
      button.append(...rowContent(documentRef, { text, parent, mainClass: "outgoing-row-path" }));
      button.addEventListener("click", () => openAsset(getAssetUrl(item.target, sourcePath, vaultId), item));
      row.append(button);
      return row;
    }

    if (item.kind === "external") {
      const url = safeExternalUrl(item.target);
      if (url) {
        const anchor = documentRef.createElement("a");
        anchor.className = "outgoing-link outgoing-external context-row";
        anchor.setAttribute("href", url);
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.append(...rowContent(documentRef, { text, parent: null, mainClass: "outgoing-row-path" }));
        anchor.addEventListener("click", (event) => {
          event.preventDefault?.();
          openExternal(url, event);
        });
        row.append(anchor);
        return row;
      }
    }

    // unresolved, missing note target, or an unsafe external scheme: inert text.
    const span = documentRef.createElement("span");
    span.className = "outgoing-unresolved context-row";
    span.setAttribute("aria-disabled", "true");
    span.append(...rowContent(documentRef, { text, parent, mainClass: "outgoing-row-path" }));
    row.append(span);
    return row;
  }

  function renderItems(items, sourcePath, vaultId) {
    setCount(items.length);
    if (!host || typeof documentRef?.createElement !== "function") return;
    if (!items.length) {
      message(EMPTY_LIST_MESSAGE);
      return;
    }
    host.replaceChildren();
    const list = documentRef.createElement("ul");
    list.className = "outgoing-list-items";
    for (const item of items) list.append(renderRow(item, sourcePath, vaultId));
    host.append(list);
  }

  function renderError() {
    setCount(0);
    if (!host || typeof documentRef?.createElement !== "function") return;
    host.replaceChildren();
    const wrap = documentRef.createElement("div");
    wrap.className = "context-empty outgoing-error";
    const text = documentRef.createElement("span");
    text.textContent = ERROR_MESSAGE;
    const retry = documentRef.createElement("button");
    retry.type = "button";
    retry.className = "outgoing-retry";
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
      const data = await fetchOutgoing({ path, vaultId, signal: controller.signal });
      if (token !== seq) return;
      const items = normalizeItems(data?.links);
      state = { ...state, status: items.length ? "ready" : "empty", items };
      renderItems(items, path, vaultId);
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
    message(LOADING_MESSAGE, "context-empty outgoing-loading");
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
    message(LOADING_MESSAGE, "context-empty outgoing-loading");
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
