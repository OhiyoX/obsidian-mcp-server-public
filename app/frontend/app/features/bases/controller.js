// Base surface controller: network + state machine + request fencing + URL state.
//
// Frozen mount contract (B4 wires this; do not change signatures):
//   createBaseSurface({ host, fetchImpl, onOpenNote, onError })
//     -> { open, setView, loadMore, close, destroy, getState, getRoute }
//
// Additional optional seams (desktop parity, additive):
//   enhance(root)            custom-dropdown enhancement run after every mount
//   onCreateNote(folder,name) reuse of the existing "new note" flow
//   locationObject/historyObject/windowObject  deep links + Back/Forward
//
// Guarantees:
// - a monotonic requestVersion + AbortController fence every request; a stale
//   response can never write state or DOM (rapid A/B, view switch, load-more);
// - close() aborts in-flight work and clears only `host`;
// - `sort`/`filter`/`q` overrides live in the document URL and are re-applied on
//   Back/Forward; switching the view clears them back to the view's declaration;
// - 409 reloads the current Base/view first page KEEPING the user's sort/filter/q;
//   400 invalid-cursor clears the view cursor and reloads page one; 503 is a
//   retryable error (no fallback);
// - failures always resolve to { ok:false, error } and render an explicit error
//   state. This module never redirects, reloads or fakes data.

import {
  BASE_LIMIT_DEFAULT,
  applyBaseError,
  applyBasePage,
  buildBaseRequestUrl,
  createBaseState,
  resetBaseState,
  toPublicState,
} from "./state.js";
import {
  buildBaseHref,
  normalizeFilter,
  normalizeQuery,
  normalizeSort,
  parseBaseSearch,
} from "./query-state.js";
import { folderOfPath } from "./toolbar.js";
import { createBaseView } from "./view.js";

// Every sentence here is painted into the Base surface, so it is user language. The
// server's own English wording is never rendered: `makeError` keeps the server
// `body.error` as `detail` (shown as the hover title) while the visible message is
// this table, the formula class table below, or the generic fallback.
const STATUS_MESSAGES = {
  400: "数据库请求无效。",
  401: "需要先登录。",
  403: "没有访问该数据库的权限。",
  404: "未找到该数据库或视图。",
  409: "数据库快照已变化，已重新加载当前视图。",
  422: "此数据库配置使用了暂不支持的安全子集。",
  500: "数据库查询失败。",
  503: "索引尚未就绪，请稍后重试。",
};

// Formula failure classes (server `body.formula.code`, see
// docs/bases/FORMULA-PARITY.md); wording mirrors the desktop i18n keys
// msgErrorInvalidFunction / msgErrorTypeError / msgErrorInfiniteLoop.
const FORMULA_MESSAGES = {
  "formula-invalid-function": "Invalid function in formula.",
  "formula-type-error": "Type error in formula.",
  "formula-infinite-loop": "Infinite loop detected in formula.",
};

function failure(error) {
  return { ok: false, error };
}

function closedFailure() {
  return failure({ status: 0, code: "closed", message: "数据库面板已关闭。" });
}

function notReady() {
  return { status: 0, code: "not-ready", message: "当前没有打开任何数据库。" };
}

function superseded() {
  return { status: 0, code: "superseded", message: "已被更新的请求取代。" };
}

function safeGlobal(read) {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

function makeError(status, body) {
  const mapped = STATUS_MESSAGES[status];
  const serverMessage = body && typeof body.error === "string" && body.error ? body.error : null;
  // Fail-closed formula errors carry a stable class: the visible message names the
  // failure instead of the generic "unsupported subset" text (the query still
  // fails as a whole; no partial result set is ever rendered).
  const formula = body && body.formula && typeof body.formula === "object" ? body.formula : null;
  const formulaMessage = formula ? FORMULA_MESSAGES[formula.code] ?? null : null;
  return {
    status,
    code: body && typeof body.code === "string" ? body.code : null,
    formula: formula ? { code: formula.code ?? null, name: typeof formula.name === "string" ? formula.name : null } : null,
    // `detail` is the untouched server sentence: it stays available for support and
    // for the hover title, but it is not what the reader is asked to read.
    detail: formulaMessage ? null : serverMessage,
    message: formulaMessage ?? mapped ?? serverMessage ?? "数据库查询失败。",
  };
}

// A route may carry the override query (`/app/base/x?sort=...`); the path alone is
// what the document identity (and history comparison) uses.
function splitRoute(route) {
  const value = typeof route === "string" ? route : null;
  if (!value) return { path: null, params: null };
  const index = value.indexOf("?");
  if (index < 0) return { path: value, params: null };
  return { path: value.slice(0, index), params: parseBaseSearch(value.slice(index)) };
}

export function createBaseSurface({
  host,
  fetchImpl,
  onOpenNote,
  onError,
  enhance = null,
  onCreateNote = null,
  locationObject = undefined,
  historyObject = undefined,
  windowObject = undefined,
  storage = undefined,
} = {}) {
  const doc = globalThis.document;
  const doFetch = fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const loc = locationObject === undefined ? safeGlobal(() => globalThis.location) : locationObject;
  const hist = historyObject === undefined ? safeGlobal(() => globalThis.history) : historyObject;
  const win = windowObject === undefined ? safeGlobal(() => globalThis.window) : windowObject;
  const store = storage === undefined ? safeGlobal(() => globalThis.localStorage) : storage;
  const state = createBaseState();
  let requestVersion = 0;
  let controller = null;
  let closed = false;

  const view = createBaseView({
    doc,
    host,
    enhance,
    storage: store,
    windowObject: win,
    onOpenNote: (arg) => onOpenNote?.(arg),
    onSelectView: (name) => { void setView(name); },
    onLoadMore: () => { void loadMore(); },
    onRetry: () => { void retry(); },
    onSort: (list) => { void setSort(list); },
    onFilter: (list) => { void setFilter(list); },
    onQuery: (value) => { void setQuery(value); },
    onNewNote: (name) => onCreateNote?.(folderOfPath(state.path), name),
    onRerender: () => { view.render(state); },
  });

  function notifyError(error) {
    try {
      onError?.(error);
    } catch {
      // Listener failures must never break navigation or fencing.
    }
  }

  function isCurrent(version) {
    return !closed && version === requestVersion;
  }

  function beginRequest() {
    if (controller) {
      try {
        controller.abort();
      } catch {
        // Abort is best-effort; a new version already fences the old response.
      }
    }
    controller = typeof AbortController === "function" ? new AbortController() : null;
    const version = ++requestVersion;
    return { version, signal: controller ? controller.signal : undefined };
  }

  async function requestPage({ signal, path, view: viewName, cursor }) {
    if (!doFetch) {
      return failure({ status: 0, code: "no-fetch", message: "当前环境没有可用的网络请求实现。" });
    }
    const url = buildBaseRequestUrl({
      path,
      view: viewName,
      limit: BASE_LIMIT_DEFAULT,
      cursor,
      sort: state.sort,
      filter: state.filter,
      q: state.q,
    });
    let response;
    try {
      response = await doFetch(url, { signal, headers: { accept: "application/json" } });
    } catch (err) {
      if (err && err.name === "AbortError") {
        return failure({ status: 0, code: "aborted", message: "请求已取消。" });
      }
      return failure({ status: 0, code: "network", message: "数据库请求失败。" });
    }
    if (!response || typeof response !== "object") {
      return failure({ status: 0, code: "network", message: "数据库请求失败。" });
    }
    if (response.ok === false) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const status = Number(response.status) || 0;
      return failure(makeError(status, body));
    }
    let dto = null;
    try {
      dto = await response.json();
    } catch {
      return failure({ status: 500, code: "invalid-response", message: "数据库返回的内容不是合法 JSON。" });
    }
    return { ok: true, dto };
  }

  async function loadFirstPage({ keepRows = false, retryStale = true } = {}) {
    const { version, signal } = beginRequest();
    state.loading = true;
    state.error = null;
    state.nextCursor = null;
    if (!keepRows) {
      state.rows = [];
      state.columns = [];
    }
    // Not awaited: the request below must be issued in this same tick (the render's own
    // completion is awaited by the final render of this function).
    view.render(state);

    const result = await requestPage({ signal, path: state.path, view: state.view, cursor: null });
    if (!isCurrent(version)) return failure(superseded());
    if (!result.ok) {
      if (retryStale && result.error.status === 409) {
        // Catalog identity moved under us: restart THIS view once and keep the
        // user's sort/filter/q (they are part of the new identity).
        notifyError(result.error);
        return loadFirstPage({ keepRows: true, retryStale: false });
      }
      applyBaseError(state, result.error);
      notifyError(result.error);
      await view.render(state);
      return failure(result.error);
    }
    applyBasePage(state, result.dto, { append: false });
    await view.render(state);
    return { ok: true };
  }

  // ---- URL state -----------------------------------------------------------

  function urlState() {
    return { view: state.view, sort: state.sort, filter: state.filter, q: state.q };
  }

  function commitUrl(mode = "replace") {
    if (!state.route || !loc || !hist) return false;
    const pathname = String(loc.pathname ?? "");
    if (pathname !== String(state.route)) return false;
    const href = buildBaseHref(state.route, urlState());
    if (`${pathname}${String(loc.search ?? "")}` === href) return false;
    const entry = hist.state && typeof hist.state === "object" ? hist.state : {};
    try {
      if (mode === "push" && typeof hist.pushState === "function") hist.pushState(entry, "", href);
      else if (typeof hist.replaceState === "function") hist.replaceState(entry, "", href);
      else return false;
    } catch {
      return false;
    }
    return true;
  }

  // Re-apply the overrides the address bar now carries (Back/Forward, deep link).
  function syncFromUrl() {
    if (closed) return Promise.resolve(closedFailure());
    if (state.documentKind !== "base" || !state.path) return Promise.resolve(failure(notReady()));
    // A different route in the address bar is a document transition owned by the
    // navigation wiring; only same-document override changes belong here.
    if (state.route && String(loc?.pathname ?? "") !== String(state.route)) {
      return Promise.resolve({ ok: true, unchanged: true });
    }
    const parsed = parseBaseSearch(loc?.search ?? "");
    const nextView = parsed.view ?? state.view;
    const unchanged = nextView === state.view
      && JSON.stringify(parsed.sort) === JSON.stringify(state.sort)
      && JSON.stringify(parsed.filter) === JSON.stringify(state.filter)
      && parsed.q === state.q;
    if (unchanged) return Promise.resolve({ ok: true, unchanged: true });
    state.view = nextView;
    state.sort = parsed.sort;
    state.filter = parsed.filter;
    state.q = parsed.q;
    return loadFirstPage({ keepRows: true });
  }

  const onPopState = () => { void syncFromUrl(); };
  if (win && typeof win.addEventListener === "function") win.addEventListener("popstate", onPopState);

  // ---- Public operations ---------------------------------------------------

  async function open({ vaultId, path, route, view: viewName = null, sort = null, filter = null, q = null } = {}) {
    if (closed) return closedFailure();
    const split = splitRoute(route);
    // Deep link: the query on the route wins over a stale address bar.
    const urlParams = split.params ?? parseBaseSearch(loc?.search ?? "");
    state.documentKind = "base";
    state.vaultId = vaultId ?? null;
    state.path = path ?? null;
    state.route = split.path ?? null;
    state.view = viewName ?? urlParams.view ?? null;
    state.viewType = null;
    state.sort = normalizeSort(sort ?? urlParams.sort);
    state.filter = normalizeFilter(filter ?? urlParams.filter);
    state.q = normalizeQuery(q ?? urlParams.q ?? "");
    state.views = [];
    state.columns = [];
    state.rows = [];
    state.nextCursor = null;
    state.error = null;
    state.loading = false;
    return loadFirstPage({ keepRows: false });
  }

  // Switching the view drops the explicit overrides: the new view's own
  // declaration is authoritative again (D-PARITY-PLAN item 6).
  async function setView(viewName) {
    if (closed) return closedFailure();
    if (state.documentKind !== "base" || !state.path) return failure(notReady());
    state.view = viewName === null || viewName === undefined ? null : String(viewName);
    state.sort = [];
    state.filter = [];
    state.q = "";
    state.error = null;
    commitUrl("push");
    return loadFirstPage({ keepRows: true });
  }

  async function setSort(list) {
    if (closed) return closedFailure();
    if (state.documentKind !== "base" || !state.path) return failure(notReady());
    state.sort = normalizeSort(list);
    state.error = null;
    commitUrl("push");
    return loadFirstPage({ keepRows: true });
  }

  async function setFilter(list) {
    if (closed) return closedFailure();
    if (state.documentKind !== "base" || !state.path) return failure(notReady());
    state.filter = normalizeFilter(list);
    state.error = null;
    commitUrl("push");
    return loadFirstPage({ keepRows: true });
  }

  // Typing in the search box must not spam the history stack.
  async function setQuery(value) {
    if (closed) return closedFailure();
    if (state.documentKind !== "base" || !state.path) return failure(notReady());
    const next = normalizeQuery(value);
    if (next === state.q) return { ok: true, unchanged: true };
    state.q = next;
    state.error = null;
    commitUrl("replace");
    return loadFirstPage({ keepRows: true });
  }

  async function loadMore() {
    if (closed) return closedFailure();
    if (state.documentKind !== "base" || !state.path) return failure(notReady());
    const expectedCursor = state.nextCursor;
    if (!expectedCursor) return failure({ status: 0, code: "no-more", message: "没有更多记录了。" });
    if (state.loading) return failure({ status: 0, code: "busy", message: "已有一个请求正在进行。" });

    const { version, signal } = beginRequest();
    state.loading = true;
    state.error = null;
    view.setBusy(state);

    const result = await requestPage({ signal, path: state.path, view: state.view, cursor: expectedCursor });
    if (!isCurrent(version)) return failure(superseded());

    if (!result.ok) {
      state.loading = false;
      if (result.error.status === 409) {
        notifyError(result.error);
        return loadFirstPage({ keepRows: true });
      }
      if (result.error.status === 400 && result.error.code === "invalid-cursor") {
        state.nextCursor = null;
        notifyError(result.error);
        return loadFirstPage({ keepRows: true });
      }
      applyBaseError(state, result.error);
      notifyError(result.error);
      await view.render(state);
      return failure(result.error);
    }

    // Fence against an interleaved request that already advanced the cursor.
    if (state.nextCursor !== expectedCursor) return failure(superseded());
    applyBasePage(state, result.dto, { append: true });
    view.appendRows(result.dto.rows ?? [], state);
    return { ok: true };
  }

  async function retry() {
    if (closed) return closedFailure();
    if (state.documentKind !== "base" || !state.path) return failure(notReady());
    return loadFirstPage({ keepRows: state.rows.length > 0 });
  }

  function close() {
    closed = true;
    requestVersion += 1;
    if (win && typeof win.removeEventListener === "function") win.removeEventListener("popstate", onPopState);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      controller = null;
    }
    view.clear();
    resetBaseState(state);
  }

  function destroy() {
    close();
  }

  // Leaving the Base document for a note: the host is hidden, not unmounted, so the widgets
  // inside it have to give up their document listeners while they are out of sight (#409
  // review). Unlike `close()` this keeps the surface usable for the next Base open.
  function release() {
    view.releaseEnhance();
  }

  function getState() {
    return toPublicState(state);
  }

  // The history entry / deep link for this document, overrides included.
  function getRoute() {
    return state.route ? buildBaseHref(state.route, urlState()) : null;
  }

  return {
    open,
    setView,
    setSort,
    setFilter,
    setQuery,
    syncFromUrl,
    loadMore,
    close,
    release,
    destroy,
    getState,
    getRoute,
  };
}
