// Lazy flat-note list controller (Explorer Phase 2 — flat view, empty query).
//
// The flat page is a server-ordered keyset stream
// (`GET /api/web/v2/tree?flat=1&sort&direction&limit&cursor`), so paging must never
// mix two orderings: every request captures the spec it was issued under and a
// version token, and a response may only write state while its version is still
// current. A spec change or an invalidate retires every in-flight page.
//
// It owns no DOM and no preference: the controller decides when to (re)load and
// renders `state`; this module only fetches, applies and guards pages.
export const FLAT_PAGE_LIMIT = 100;
// `revealCurrent` may have to walk pages: a flat page has no anchor API (the frozen
// contract excludes `anchorPath` here), so finding a note that is not on the first
// page means continuing the keyset stream. The cap keeps that walk bounded.
export const FLAT_REVEAL_MAX_PAGES = 20;

// Existing children-API route, flat form: no `parent` (a flat page rejects one).
export function flatPageUrl({ spec, cursor = null }) {
  const query = new URLSearchParams({
    flat: "1",
    sort: spec.key,
    direction: spec.direction,
    limit: String(FLAT_PAGE_LIMIT),
  });
  if (cursor) query.set("cursor", cursor);
  return `/api/web/v2/tree?${query.toString()}`;
}

export function createFlatListController({ api, onChange = () => {}, onError = () => {} }) {
  const state = {
    spec: null,
    items: [],
    nextCursor: null,
    loading: false,
    error: null,
    version: 0,
  };

  function applyPage(version, items, nextCursor, replace) {
    if (version !== state.version) return false;
    state.items = replace ? (Array.isArray(items) ? items : []) : state.items.concat(Array.isArray(items) ? items : []);
    state.nextCursor = nextCursor || null;
    state.loading = false;
    state.error = null;
    return true;
  }

  async function fetchPage(version, cursor, { replace = false } = {}) {
    try {
      const data = await api(flatPageUrl({ spec: state.spec, cursor }));
      if (!applyPage(version, data?.items, data?.nextCursor, replace)) return false;
      onChange();
      return true;
    } catch (error) {
      if (version !== state.version) return false;
      state.loading = false;
      state.error = error;
      onChange();
      onError(error);
      return false;
    }
  }

  // First page under `spec`. Keeps the already-rendered items until the new page
  // lands so an SSE refresh does not blank the list; a spec change replaces them.
  function load(spec) {
    const sameSpec = state.spec !== null
      && state.spec.key === spec?.key
      && state.spec.direction === spec?.direction;
    const version = state.version + 1;
    state.version = version;
    state.spec = spec;
    state.loading = true;
    state.error = null;
    if (!sameSpec) {
      state.items = [];
      state.nextCursor = null;
    }
    onChange();
    // Page 1 replaces whatever was rendered; a continuation appends.
    return fetchPage(version, null, { replace: true });
  }

  function loadMore() {
    if (!state.nextCursor || state.loading) return Promise.resolve(false);
    const version = state.version;
    state.loading = true;
    onChange();
    return fetchPage(version, state.nextCursor);
  }

  function retry() {
    const version = state.version + 1;
    state.version = version;
    state.loading = true;
    state.error = null;
    if (state.items.length === 0) state.nextCursor = null;
    onChange();
    // A retry after a failed first page starts over; a retry after a failed
    // continuation resumes from the retained cursor.
    return state.nextCursor ? fetchPage(version, state.nextCursor) : fetchPage(version, null, { replace: true });
  }

  // Walk the keyset stream until `path` is present (bounded). Never restarts the
  // list, so the reader's already-loaded pages and scroll are preserved.
  async function ensureVisible(path) {
    if (!path || state.spec === null || state.error) return false;
    if (state.items.some((item) => item?.path === path)) return true;
    let pages = 0;
    while (state.nextCursor && pages < FLAT_REVEAL_MAX_PAGES) {
      pages += 1;
      const version = state.version;
      const loaded = await fetchPage(version, state.nextCursor);
      if (version !== state.version || !loaded) break;
      if (state.items.some((item) => item?.path === path)) return true;
    }
    return state.items.some((item) => item?.path === path);
  }

  // Drop items and the spec (the next mode/query change reloads). Used when the
  // flat source is no longer authoritative (live file change, mode exit).
  function invalidate() {
    state.version += 1;
    state.spec = null;
    state.items = [];
    state.nextCursor = null;
    state.loading = false;
    state.error = null;
  }

  return { state, load, loadMore, retry, ensureVisible, invalidate };
}
