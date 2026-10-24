// Web v2 search state (Phase 3A-3). Pure: no DOM, no fetch, no v1 endpoint.
//
// The search view owns its own pagination state, separate from the lazy tree. A new
// query identity (q / caseSensitive / semantic) drops the previous items and cursor;
// a stale response can never append into a newer query.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A-3 契约前置决策（冻结，2026-10-04）
export const SEARCH_PAGE_LIMIT = 50;

export function createSearchState() {
  return {
    query: "",
    caseSensitive: false,
    semantic: false,
    items: [],
    nextCursor: null,
    exhausted: false,
    loading: false,
    version: 0,
    semanticUsed: false,
    semanticError: null,
    // Groups the reader collapsed; a new query identity drops it (U4).
    collapsedGroups: new Set(),
  };
}

export function isSearchActive(state) {
  return Boolean(state.query);
}

export function searchIdentity(state) {
  return JSON.stringify({
    q: state.query,
    caseSensitive: state.caseSensitive === true,
    semantic: state.semantic === true,
  });
}

// Starts a fresh page 1: the previous items and cursor belong to another query.
export function beginSearch(state, { query, caseSensitive = false, semantic = false }) {
  state.version += 1;
  state.query = query;
  state.caseSensitive = caseSensitive === true;
  state.semantic = semantic === true;
  state.items = [];
  state.nextCursor = null;
  state.exhausted = false;
  state.loading = true;
  state.collapsedGroups = new Set();
  return state.version;
}

// Continues the current query. The identity is unchanged, so the response may append.
export function beginSearchMore(state) {
  state.version += 1;
  state.loading = true;
  return state.version;
}

export function applySearchPage(state, version, payload) {
  if (version !== state.version) return false;
  // The server's semantic outcome is surfaced verbatim; it is never inferred.
  state.semanticUsed = payload?.semantic?.used === true;
  state.semanticError = payload?.semantic?.error ?? null;
  state.items = state.items.concat(Array.isArray(payload?.items) ? payload.items : []);
  state.nextCursor = payload?.nextCursor || null;
  state.exhausted = !state.nextCursor;
  state.loading = false;
  return true;
}

export function endSearch(state, version) {
  if (version !== state.version) return false;
  state.loading = false;
  return true;
}

export function resetSearch(state) {
  state.version += 1;
  state.semanticUsed = false;
  state.semanticError = null;
  state.query = "";
  state.items = [];
  state.nextCursor = null;
  state.exhausted = false;
  state.loading = false;
  state.collapsedGroups = new Set();
}

// Cursor is opaque and passed back verbatim; never an offset.
export function searchPageUrl(state, cursor = null) {
  const params = new URLSearchParams();
  params.set("q", state.query);
  params.set("limit", String(SEARCH_PAGE_LIMIT));
  if (cursor) params.set("cursor", cursor);
  params.set("semantic", state.semantic ? "true" : "false");
  params.set("caseSensitive", state.caseSensitive ? "true" : "false");
  return `/api/web/v2/search?${params.toString()}`;
}

// The v2 item shape is the contract; this is the explicit, local view adapter.
export function toSearchRow(item) {
  return {
    path: String(item?.path || ""),
    name: String(item?.name || ""),
    modifiedMs: typeof item?.modifiedMs === "number" ? item.modifiedMs : null,
    score: item?.score,
    matchCount: typeof item?.matchCount === "number" ? item.matchCount : 0,
    snippet: Array.isArray(item?.snippets) && item.snippets.length ? String(item.snippets[0]) : "",
  };
}

// The *failure* half of the same status line: one page request failed (or its cursor went
// stale) and the panel must say why in the reader's language. Kept beside `searchStatus`
// so a new server error code has exactly one place to land, and so the controller keeps
// only the request fence, never the wording.
export function searchErrorStatus(error) {
  const code = error?.data?.error || error?.code;
  if (error?.status === 400) {
    if (code === "semantic-not-supported") {
      // Kept for an older server: semantic is a supported path now.
      return { text: "语义搜索不可用（该版本未启用）", kind: "warning", title: error.message || "" };
    }
    if (code === "cursor-invalid") return { text: "搜索结果已过期，请重新输入", kind: "warning", title: "" };
    return { text: "搜索语法不完整，请检查操作符后的内容", kind: "error", title: error.message || "" };
  }
  if (error?.status === 401) return { text: "登录已过期，正在返回登录页", kind: "error", title: "" };
  if (error?.status === 503) return { text: "目录索引尚未就绪，请稍候…", kind: "warning", title: "" };
  return { text: "搜索服务暂时不可用，请稍后重试", kind: "error", title: error?.message || "" };
}

// Count row (desktop shape: "N 项结果"). The number is the *loaded* count -- the v2
// contract has no total, so it is never presented as one; a cursor turns into an
// explicit "还有更多". Semantic is never silently downgraded: the mode is always
// spelled out, and an unhonoured semantic request keeps its visible reason.
export function searchStatus(state, { stale = false, error = "" } = {}) {
  const count = state.items.length;
  const more = state.nextCursor ? " · 还有更多" : "";
  const countText = `${count} 项结果`;
  if (state.semantic && state.semanticUsed) {
    return { text: `${countText} · 普通搜索 + 语义${more}`, kind: "", title: error };
  }
  if (state.semantic) {
    // Requested but not used: the reason is always shown, never silently dropped.
    return {
      text: `${countText} · 语义不可用${more}`,
      kind: "warning",
      title: state.semanticError || error,
    };
  }
  if (stale) return { text: `${countText} · 索引更新中${more}`, kind: "warning", title: error };
  return { text: `${countText} · 普通搜索${more}`, kind: "", title: "" };
}
