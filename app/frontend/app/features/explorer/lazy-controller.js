// Lazy Explorer tree controller for Phase 2B-1 + lazy sorting adaptation.
//
// Owns the request lifecycle on top of the pure lazy-model: root/expand lazy loads,
// load-more, anchor locate/reveal, per-parent invalidation, the global SortSpec fence,
// and the bounded silent hover prefetch of issue #284. `api` is injected so the
// orchestration is testable without a DOM or network.
//
// Sort identity contract: every request freezes `{parent target, SortSpec, sortEpoch,
// captured generation, owner token}`. A response, error, `finally`, 503 retry or
// locate/anchor continuation may only write state while its owner is still current
// *and* its epoch/spec still match. A sort change retires every old request and
// cursor, so an old page or cursor can never be stitched into the new ordering.
//
// Hover prefetch (contract §5/§6): `prefetch(parent)` loads the same first page through
// the same kernel and the same fences; only an explicit `speculative` policy switches
// the visible lifecycle off. The owner token stays the single authority — a late
// `pointerleave` cancels a still-speculative owner but never a formal one (I04); a
// click whose identical first-page request is already in flight promotes that owner
// instead of aborting and re-issuing (I08); speculative concurrency is bounded and
// over-budget intents are dropped, never queued (I05); an unconsumed hover page is
// reclaimed on `pointerleave`/cancel through the bounded provenance bookkeeping of
// `lazy-prefetch.js` (I11), so the one children cache stays the only cache (I01).
import {
  ancestorChain,
  applyTreePage,
  beginLoad,
  bumpSortEpoch,
  clearLoadError,
  createLazyExplorerState,
  endLoad,
  invalidateAll,
  invalidateParent,
  invalidatePath,
  isLoaded,
  isSortCurrent,
  itemsFor,
  loadedGenerationFor,
  nextCursorFor,
  parentOf,
  retireLoad,
  revealAncestors,
  setExpanded,
  setLoadError,
  setSortIdentity,
} from "./lazy-model.js";
import { createPageFetcher, READY_RETRY_DELAYS_MS } from "./lazy-fetch.js";
import { normalizePath, treePageUrl } from "./lazy-page-url.js";
import { createPrefetchBookkeeping } from "./lazy-prefetch.js";
import { normalizeSortSpec, sortSpecEquals } from "./sort-spec.js";

export { READY_RETRY_DELAYS_MS };
export { TREE_PAGE_LIMIT, treePageUrl } from "./lazy-page-url.js";

export function createLazyTreeController({
  api,
  model = createLazyExplorerState(),
  onChange = () => {},
  onError = () => {},
  // Fired once a layer-by-layer `locate()` has completed for `path` (every level present
  // and the walk not superseded/aborted). The exploration controller uses it to re-run the
  // reveal-current render *after* a re-materialization, so the current note row is scrolled
  // into view on the settled tree instead of on a layout that a later resync replaces.
  onRevealSettled = () => {},
  retryDelays = READY_RETRY_DELAYS_MS,
  initialSort,
}) {
  // The controller (not the model) owns strict normalization; the model stores the
  // frozen spec so pages/cursors can prove which ordering produced them.
  setSortIdentity(model, normalizeSortSpec(initialSort));

  const pending = new Map(); // parent -> { owner, controller }
  const prefetchBook = createPrefetchBookkeeping();
  const fetchPage = createPageFetcher({ api, pageUrl: treePageUrl, retryDelays });
  let ownerSequence = 0;

  // --- request ownership ---------------------------------------------------

  // The single retirement path, and the only place that aborts an owner. A still
  // speculative owner is the only cancel-able one (I04) and gives its budget slot back
  // immediately; a promoted/formal owner is never counted as a prefetch cancel.
  function retireToken(rel, token) {
    if (pending.get(rel) === token) pending.delete(rel);
    if (token.owner.speculative && !token.closure) {
      token.closure = "cancelled";
      prefetchBook.countCancelled();
    }
    prefetchBook.release(token);
    token.controller.abort();
    endLoad(model, rel, token.owner);
  }

  function retireParent(parent) {
    const rel = normalizePath(parent);
    const token = pending.get(rel);
    if (token) {
      retireToken(rel, token);
    } else {
      retireLoad(model, rel);
    }
  }

  function abortAll() {
    for (const [rel, token] of [...pending.entries()]) retireToken(rel, token);
    prefetchBook.clear();
  }

  function beginRequest(rel, { kind, speculative, cursor, anchorPath }) {
    const previous = pending.get(rel);
    if (previous) retireToken(rel, previous);
    const owner = {
      id: ++ownerSequence,
      kind,
      epoch: model.sortEpoch,
      spec: model.sortSpec,
      speculative,
    };
    const token = {
      owner,
      controller: new AbortController(),
      cursor,
      anchorPath,
      promise: null,
      closure: null,
      slotHeld: false,
    };
    pending.set(rel, token);
    if (speculative) prefetchBook.hold(token);
    return token;
  }

  // I08: the click adopts the in-flight speculative owner instead of aborting it. The
  // token/epoch/spec are unchanged, `prefetch(...)` already handed out the same
  // promise, the slot is freed exactly once and the formal visible loading lifecycle
  // resumes on that owner.
  function promoteOwner(rel, token) {
    token.owner.speculative = false;
    if (!token.closure) {
      token.closure = "promoted";
      prefetchBook.countPromoted();
    }
    prefetchBook.release(token);
    beginLoad(model, rel, token.owner);
    onChange();
    return token;
  }

  // A token is current only while it is still the parent's owner AND the global
  // sort identity it captured is still the live one.
  function isCurrent(parent, token) {
    const rel = normalizePath(parent);
    return pending.get(rel) === token
      && token.owner.epoch === model.sortEpoch
      && sortSpecEquals(token.owner.spec, model.sortSpec);
  }

  // The level's in-flight COMPLETE HEAD owner: formal, first page, no cursor and no anchor, so its
  // page covers the level from the ordering origin. A suffix (anchor) or continuation (cursor) page
  // starts inside the level and is never a head.
  function inFlightHead(parent) {
    const token = pending.get(normalizePath(parent));
    if (!token || token.owner.speculative || token.anchorPath || token.cursor || !token.promise) return null;
    return token;
  }

  // #423 fence budget: bound the head-page waits so a resync storm cannot starve the walk (each round
  // awaits a DISTINCT owner; a page promise always settles). Shared by the whole walk and FAIL-CLOSED:
  // a head still in flight at the bound would be retired by a suffix that wins the write, the #423 loss.
  const HEAD_FENCE_ROUNDS = 8;

  // --- page lifecycle ------------------------------------------------------
  // The one load kernel: `speculative` is the only policy switch, and it decides the
  // whole visible lifecycle (begin/success notification, visible error). The identity
  // fences below are identical for a hover and for a click (I03).
  async function runPage(rel, token, append) {
    const { owner } = token;
    try {
      const data = await fetchPage(
        rel,
        { cursor: token.cursor, anchorPath: token.anchorPath, spec: owner.spec },
        token.controller.signal,
        () => isCurrent(rel, token),
      );
      if (!isCurrent(rel, token)) return null;
      const applied = applyTreePage(model, {
        parent: rel,
        items: Array.isArray(data?.items) ? data.items : [],
        nextCursor: data?.nextCursor ?? null,
        generation: data?.catalog?.generation ?? null,
        append,
        sortEpoch: owner.epoch,
        owner,
      });
      if (!applied) return null;
      if (owner.speculative) {
        // I02: silent — the page enters the one cache and only becomes provenance for a
        // later consume/reclaim decision (I11). No begin, no onChange, no expansion.
        token.closure = "success";
        prefetchBook.notePage(rel);
      } else {
        prefetchBook.clearPage(rel);
        onChange();
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        // An abort is never success and never a rendered load error, but an abort of
        // the still-current formal owner (not a retirement, which already cleaned up)
        // must release ITS loading flag and notify the UI. A speculative owner never
        // wrote visible state to release (I02).
        if (isCurrent(rel, token) && !owner.speculative) {
          endLoad(model, rel, owner);
          onChange();
        }
        return null;
      }
      if (!isCurrent(rel, token)) return null;
      if (owner.speculative) {
        // I07: counted only — the formal click keeps its own retry/error row.
        if (!token.closure) {
          token.closure = "failed";
          prefetchBook.countFailed();
        }
        return null;
      }
      setLoadError(model, rel, error);
      onChange();
      onError(error, rel);
      return null;
    } finally {
      if (isCurrent(rel, token)) pending.delete(rel);
      prefetchBook.release(token);
    }
  }

  // `promote` is opt-in on purpose: only a plain first-page request for the same parent
  // (`toggle`, `ensureLoaded`) is semantically equal to a prefetch.
  function loadPage(parent, {
    cursor = null,
    anchorPath = null,
    append = false,
    kind = "load",
    speculative = false,
    promote = false,
  } = {}) {
    const rel = parent ?? "";
    const previous = pending.get(rel);
    if (promote && !speculative && previous?.owner.speculative) {
      return promoteOwner(rel, previous).promise;
    }
    const token = beginRequest(rel, { kind, speculative, cursor, anchorPath });
    if (!speculative) {
      beginLoad(model, rel, token.owner);
      onChange();
    }
    token.promise = runPage(rel, token, append);
    return token.promise;
  }

  // --- speculative prefetch (I05/I06/I10) ----------------------------------
  // Fail-closed eligibility: every unmet precondition is a silent no-op that is never
  // counted as `issued`.
  function prefetchEligible(rel, existing) {
    if (existing) return false; // a formal in-flight owner owns the parent
    if (model.expanded.has(rel)) return false; // no longer collapsed
    if (isSortCurrent(model, rel)) return false; // current spec already has a page
    if (model.errorByParent.has(rel)) return false; // never shadow a formal error/retry
    return true;
  }

  function prefetch(parent) {
    const rel = normalizePath(parent);
    const existing = pending.get(rel);
    // The same parent already has a speculative owner: reuse it, never re-issue.
    if (existing?.owner.speculative) return existing.promise;
    if (!prefetchEligible(rel, existing)) return Promise.resolve(null);
    if (!prefetchBook.hasBudget()) {
      prefetchBook.countDropped(); // fixed drop, no queue (I05)
      return Promise.resolve(null);
    }
    // I06: first page only — no cursor, no anchor, no append, no follow-up page.
    return loadPage(rel, { kind: "prefetch", speculative: true });
  }

  function cancelPrefetch(parent) {
    const rel = normalizePath(parent);
    const token = pending.get(rel);
    if (token) {
      // I04: only an owner that is still speculative may be cancelled; a promoted
      // formal owner (a click that landed after this pointerleave) is never touched.
      if (token.owner.speculative) retireToken(rel, token);
      return;
    }
    // I11: an already-answered hover page that no formal intent consumed is reclaimed —
    // page, cursor, generation and sort identity — so hovers cannot accumulate.
    if (!prefetchBook.hasPage(rel)) return;
    prefetchBook.clearPage(rel);
    if (model.expanded.has(rel) || !isSortCurrent(model, rel)) return;
    invalidateParent(model, rel);
    prefetchBook.countEvicted();
  }

  const loadRoot = () => loadPage("", { kind: "root" });

  // Re-materialize the root and every user-expanded chain under the current spec.
  // Bounded by the expansion set (never the whole Vault) and always root-first.
  async function materializeCurrent() {
    const epoch = model.sortEpoch;
    const root = await loadPage("", { kind: "sort-root" });
    if (epoch !== model.sortEpoch) return null;
    const expanded = [...model.expanded].sort(
      (left, right) => left.split("/").length - right.split("/").length
        || (left < right ? -1 : left > right ? 1 : 0),
    );
    for (const parent of expanded) {
      if (epoch !== model.sortEpoch) return null;
      if (isSortCurrent(model, parent)) continue;
      await loadPage(parent, { kind: "sort-expand" });
    }
    return root;
  }

  // Tree mode: adopt the new spec and re-fetch under it. Every old request/cursor is
  // retired first, so no old page can be stitched into the new ordering.
  function setSort(next) {
    const spec = normalizeSortSpec(next);
    if (sortSpecEquals(spec, model.sortSpec)) return Promise.resolve(null);
    abortAll();
    bumpSortEpoch(model, spec);
    onChange();
    return materializeCurrent();
  }

  // Query mode: adopt the new spec (retire old tree pages/cursors) but issue no tree
  // network. The next reveal/clear materializes under the adopted spec.
  function adoptSort(next) {
    const spec = normalizeSortSpec(next);
    if (sortSpecEquals(spec, model.sortSpec)) return null;
    abortAll();
    bumpSortEpoch(model, spec);
    onChange();
    return null;
  }

  // Expand/ensure helpers for callers (inline create, reveal) that only need the
  // level present, not a toggle.
  function ensureLoaded(parent) {
    const rel = parent ?? "";
    if (isSortCurrent(model, rel)) {
      // I11: a formal intent consumes the hover page, which then is ordinary cache.
      prefetchBook.consume(rel);
      return Promise.resolve(null);
    }
    return loadPage(rel, { kind: "ensure", promote: true });
  }

  function loadMore(parent) {
    const rel = parent ?? "";
    // Old cursor never crosses a sort: only a page loaded under the live spec may
    // donate its cursor.
    if (!isSortCurrent(model, rel)) return Promise.resolve(null);
    const cursor = nextCursorFor(model, rel);
    if (!cursor) return Promise.resolve(null);
    return loadPage(rel, { cursor, append: true, kind: "more" });
  }

  function toggle(parent) {
    const rel = parent ?? "";
    if (model.expanded.has(rel)) {
      setExpanded(model, rel, false);
      onChange();
      return Promise.resolve(null);
    }
    setExpanded(model, rel, true);
    onChange();
    if (isSortCurrent(model, rel)) {
      // §11.4: the hover already fetched this page — expand with zero network and no
      // "正在加载…" row; the page stops being speculative (I11).
      prefetchBook.consume(rel);
      return Promise.resolve(null);
    }
    return loadPage(rel, { kind: "toggle", promote: true });
  }

  function retry(parent) {
    const rel = parent ?? "";
    clearLoadError(model, rel);
    return loadPage(rel, { kind: "retry" });
  }

  // Reveal is layer-by-layer: every level is loaded as an anchor-inclusive page so
  // the target's ancestor chain is actually present, not just "a parent is loaded".
  // A level is skipped ONLY when the parent's current-spec items already contain the
  // child. The whole walk is fenced to the epoch captured at entry, so a sort change
  // during reveal stops it instead of anchor-locating under the wrong ordering.
  async function locate(path) {
    // Remember which note the interaction state must keep visible: a global reset
    // preserves `expanded`/`currentPath`, so `invalidateEverything` re-anchors this path.
    model.currentPath = normalizePath(path) || null;
    revealAncestors(model, path);
    onChange();
    const epoch = model.sortEpoch;
    const fence = { rounds: HEAD_FENCE_ROUNDS };
    let result = null;
    let parent = "";
    for (const child of [...ancestorChain(path), path]) {
      // #423: an anchor page is a SUFFIX of its level (`tuple >= anchor tuple`), so it must never win
      // the write against the level's complete head page -- a `vault.resync` rebuild issues that head.
      // The wait MUST live in THIS frame: a helper awaiting the page in its own frame resumes before a
      // continuation the head task registered on that page *after* the wait began (registration order)
      // -- the resync/sort adoption that page triggers -- so it could answer "stable" for a level then
      // already cleared, re-headed or re-sorted. Awaiting here makes this resume that continuation's
      // neighbour: a later continuation runs after the read/anchor below, never between them. Epoch and
      // in-flight head are re-checked after EVERY await (fail closed at the shared bound), so with no
      // head in flight the first request is still issued synchronously.
      for (;;) {
        if (epoch !== model.sortEpoch) return null;
        const head = inFlightHead(parent);
        if (!head) break;
        if (fence.rounds <= 0) return null;
        fence.rounds -= 1;
        await head.promise;
      }
      const items = isSortCurrent(model, parent) ? itemsFor(model, parent) : null;
      const hasChild =
        Array.isArray(items) && items.some((item) => normalizePath(item.path) === normalizePath(child));
      if (!hasChild) {
        result = await loadPage(parent, { anchorPath: child, kind: "locate" });
        // A required level that failed, was aborted or was superseded must stop
        // reveal here: continuing would issue deeper requests after the fence.
        if (!result) return null;
        if (epoch !== model.sortEpoch) return null;
      }
      parent = child;
    }
    onRevealSettled(model.currentPath);
    return result;
  }

  function invalidate(path) {
    const parent = parentOf(path);
    const wasLoaded = isSortCurrent(model, parent);
    retireParent(parent); // always retire the in-flight owner, even if aborted
    if (wasLoaded) {
      // Reload in place: keep the current items until the new page lands, so a no-op
      // refresh does not churn the Explorer DOM (the render signature then decides).
      return loadPage(parent, { kind: "refresh" });
    }
    prefetchBook.clearPage(parent);
    invalidatePath(model, path);
    onChange();
    return Promise.resolve(null);
  }

  // Global invalidation (SSE `vault.resync`, `watcher-ready`, coverage gap): retire every
  // page and re-materialize exactly what the preserved interaction state makes visible --
  // root plus every expanded chain (bounded by the expansion set, never the whole Vault)
  // and then the anchor reveal of the current note. Reloading only the root here left every
  // expanded ancestor as an expanded-but-empty box with no loading row and no error, which
  // is the issue #336 first-paint symptom; the resync lands while `locate()` is still
  // walking the anchor chain, so both the aborted walk and the cleared pages are recovered.
  async function invalidateEverything() {
    abortAll();
    invalidateAll(model);
    onChange();
    const epoch = model.sortEpoch;
    const root = await materializeCurrent();
    if (root === null || epoch !== model.sortEpoch) return null;
    if (model.currentPath) await locate(model.currentPath);
    return root;
  }

  function dispose() {
    abortAll();
    for (const parent of [...model.loadingParents]) endLoad(model, parent);
  }

  return {
    model,
    loadRoot,
    ensureLoaded,
    loadMore,
    toggle,
    retry,
    locate,
    invalidate,
    invalidateEverything,
    prefetch,
    cancelPrefetch,
    prefetchStats: () => prefetchBook.stats(),
    setSort,
    adoptSort,
    dispose,
    loadedGenerationFor: (parent) => loadedGenerationFor(model, parent),
    isSortCurrent: (parent) => isSortCurrent(model, parent),
    isParentMaterialized: (path) => isSortCurrent(model, parentOf(path)),
    currentSort: () => model.sortSpec,
    currentEpoch: () => model.sortEpoch,
  };
}
