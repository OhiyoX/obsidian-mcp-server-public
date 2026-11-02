// Pure lazy Explorer tree state for Phase 2B.
//
// Contract: replace the global `state.notes` tree with per-parent loaded children
// plus keyset cursors, generation-fenced per parent, so the Explorer can lazily load
// one directory at a time and only refresh the affected parent on invalidation.
//
// Lazy Tree sorting adaptation: the global SortSpec is a *request identity*, not a
// display attribute. Every loaded page, cursor and loading owner records the
// `sortEpoch` it was produced under. A sort change bumps the epoch and retires all
// page/cursor/loading state while keeping interaction state (`expanded`,
// `currentPath`). Loading is owned, so a late request can never clear a newer
// request's loading flag.
//
// Pure: no DOM, no fetch, no SSE. The controller owns requests; this owns the state
// transitions, which keeps the browser/network contract testable on its own.

function normalizePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function parentOf(path) {
  const rel = normalizePath(path);
  const index = rel.lastIndexOf("/");
  return index < 0 ? "" : rel.slice(0, index);
}

// Ancestors of a path, root-first (the item itself is never an ancestor).
export function ancestorChain(path) {
  const parts = normalizePath(path).split("/");
  parts.pop();
  const chain = [];
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    chain.push(current);
  }
  return chain;
}

// A render-visible STRUCTURAL signature: two models with the same signature render the
// same node structure, so the Explorer may reuse its DOM. It intentionally does NOT
// include the loading/error state of an already-loaded parent: a background refresh of
// a loaded level must keep its nodes (identity/markers) and only patch its load-more
// chrome. A level with no children yet, however, renders exactly one of the explicit
// error/retry row, the loading placeholder, or nothing, so those states ARE structural
// (the root is always materialized even though "" is never in `expanded`). Cursor
// PRESENCE decides whether a sentinel exists; `modified` is excluded (not rendered;
// ordering is server-side).
export function treeRenderSignature(model) {
  function levelState(parent) {
    if (model.childrenByParent.has(parent)) return "loaded";
    if (model.errorByParent.has(parent)) return "error";
    if (model.loadingParents.has(parent)) return "loading";
    return "empty";
  }
  return JSON.stringify({
    expanded: [...model.expanded].sort(),
    children: [...model.childrenByParent.entries()].map(([parent, items]) => [
      parent,
      items.map((item) => [item.kind, item.path, item.title ?? item.name ?? null]),
    ]),
    sentinels: [...model.nextCursorByParent.entries()]
      .filter(([, cursor]) => Boolean(cursor))
      .map(([parent]) => parent)
      .sort(),
    // Root + every expanded level that has no children yet: its error/loading row is
    // render-visible, so a 500/503 failure must change the signature and re-render the
    // retry row. Already-loaded levels are omitted (DOM reuse / sentinel chrome).
    levels: [
      ["", levelState("")],
      ...[...model.expanded]
        .filter((parent) => !model.childrenByParent.has(parent))
        .sort()
        .map((parent) => [parent, levelState(parent)]),
    ],
  });
}

export function createLazyExplorerState() {
  return {
    expanded: new Set(),
    childrenByParent: new Map(),
    nextCursorByParent: new Map(),
    loadedGenerationByParent: new Map(),
    // parent -> sortEpoch the currently loaded page/cursor was produced under.
    loadedSortEpochByParent: new Map(),
    // Derived rendering projection; ownership lives in loadingOwnerByParent.
    loadingParents: new Set(),
    // parent -> opaque owner token of the in-flight request (never a bare boolean).
    loadingOwnerByParent: new Map(),
    errorByParent: new Map(),
    currentPath: null,
    sortSpec: null,
    sortEpoch: 0,
  };
}

// --- Sort identity ---------------------------------------------------------

export function setSortIdentity(state, spec) {
  state.sortSpec = spec;
  return state;
}

// Bumps the epoch and retires every page/cursor/loading/error under the old spec.
// Interaction state (`expanded`, `currentPath`) is deliberately preserved.
export function bumpSortEpoch(state, spec) {
  state.sortSpec = spec;
  state.sortEpoch += 1;
  retireAllPages(state);
  return state.sortEpoch;
}

// A parent's loaded page is usable only when it belongs to the current sort epoch.
export function isSortCurrent(state, parent) {
  const rel = normalizePath(parent);
  return state.loadedSortEpochByParent.get(rel) === state.sortEpoch
    && state.childrenByParent.has(rel);
}

function retireAllPages(state) {
  state.childrenByParent.clear();
  state.nextCursorByParent.clear();
  state.loadedGenerationByParent.clear();
  state.loadedSortEpochByParent.clear();
  state.loadingParents.clear();
  state.loadingOwnerByParent.clear();
  state.errorByParent.clear();
  return state;
}

// --- Loading ownership -----------------------------------------------------

export function beginLoad(state, parent, owner) {
  const rel = normalizePath(parent);
  const resolved = owner ?? Symbol("load");
  state.loadingOwnerByParent.set(rel, resolved);
  state.loadingParents.add(rel);
  state.errorByParent.delete(rel);
  return resolved;
}

// A late `finally` from a retired request must not clear a newer request's flag:
// passing an owner only clears when it is still that owner.
export function endLoad(state, parent, owner) {
  const rel = normalizePath(parent);
  if (owner !== undefined && state.loadingOwnerByParent.get(rel) !== owner) return false;
  state.loadingOwnerByParent.delete(rel);
  state.loadingParents.delete(rel);
  return true;
}

export function isLoading(state, parent, owner) {
  const rel = normalizePath(parent);
  if (owner === undefined) return state.loadingParents.has(rel);
  return state.loadingOwnerByParent.get(rel) === owner;
}

// Retires any ownership for a parent without implying success.
export function retireLoad(state, parent) {
  const rel = normalizePath(parent);
  state.loadingOwnerByParent.delete(rel);
  state.loadingParents.delete(rel);
  return state;
}

export function setLoadError(state, parent, error) {
  const rel = normalizePath(parent);
  state.errorByParent.set(rel, error ?? true);
  state.loadingOwnerByParent.delete(rel);
  state.loadingParents.delete(rel);
  return state;
}

export function loadErrorFor(state, parent) {
  return state.errorByParent.get(normalizePath(parent)) ?? null;
}

export function clearLoadError(state, parent) {
  state.errorByParent.delete(normalizePath(parent));
  return state;
}

// --- Pages -----------------------------------------------------------------

export function isLoaded(state, parent) {
  return state.childrenByParent.has(normalizePath(parent));
}

export function itemsFor(state, parent) {
  return state.childrenByParent.get(normalizePath(parent)) ?? null;
}

export function nextCursorFor(state, parent) {
  return state.nextCursorByParent.get(normalizePath(parent)) ?? null;
}

export function loadedGenerationFor(state, parent) {
  return state.loadedGenerationByParent.get(normalizePath(parent)) ?? null;
}

export function loadedSortEpochFor(state, parent) {
  return state.loadedSortEpochByParent.get(normalizePath(parent)) ?? null;
}

// A fresh/foreign page replaces the parent's children; a same-generation (and
// same-sort) continuation appends. The cursor and generation always advance
// together. A page captured under a retired epoch is rejected outright.
export function applyTreePage(state, { parent, items, nextCursor = null, generation, append = false, sortEpoch, owner }) {
  const rel = normalizePath(parent);
  if (sortEpoch !== undefined && sortEpoch !== state.sortEpoch) return false;
  const sameGeneration = state.loadedGenerationByParent.get(rel) === generation
    && state.loadedSortEpochByParent.get(rel) === state.sortEpoch;
  const base = append && sameGeneration ? state.childrenByParent.get(rel) ?? [] : [];
  state.childrenByParent.set(rel, [...base, ...items]);
  state.nextCursorByParent.set(rel, nextCursor ?? null);
  state.loadedGenerationByParent.set(rel, generation);
  state.loadedSortEpochByParent.set(rel, state.sortEpoch);
  if (owner === undefined || state.loadingOwnerByParent.get(rel) === owner) {
    state.loadingOwnerByParent.delete(rel);
    state.loadingParents.delete(rel);
  }
  state.errorByParent.delete(rel);
  return true;
}

export function invalidateParent(state, parent) {
  const rel = normalizePath(parent);
  state.childrenByParent.delete(rel);
  state.nextCursorByParent.delete(rel);
  state.loadedGenerationByParent.delete(rel);
  state.loadedSortEpochByParent.delete(rel);
  state.loadingOwnerByParent.delete(rel);
  state.loadingParents.delete(rel);
  state.errorByParent.delete(rel);
  return state;
}

export function invalidateAll(state) {
  retireAllPages(state);
  return state;
}

// SSE note.created/deleted: invalidate only the affected parent, never the whole
// Explorer.
export function invalidatePath(state, path) {
  return invalidateParent(state, parentOf(path));
}

export function setExpanded(state, parent, expanded) {
  const rel = normalizePath(parent);
  if (expanded) state.expanded.add(rel);
  else state.expanded.delete(rel);
  return state;
}

export function revealAncestors(state, path) {
  for (const ancestor of ancestorChain(path)) state.expanded.add(ancestor);
  return state;
}

// Bounded memory: keep only the given parents' children (e.g. expanded + current
// ancestor chain), releasing the rest. Evicted in-flight loads are cleared too, so
// an aborted parent cannot stay stuck in loadingParents forever.
export function evictParents(state, keep) {
  const keepSet = new Set((keep || []).map(normalizePath));
  for (const parent of [...state.childrenByParent.keys()]) {
    if (keepSet.has(parent)) continue;
    state.childrenByParent.delete(parent);
    state.nextCursorByParent.delete(parent);
    state.loadedGenerationByParent.delete(parent);
    state.loadedSortEpochByParent.delete(parent);
    state.errorByParent.delete(parent);
  }
  for (const parent of [...state.loadingParents]) {
    if (!keepSet.has(parent)) {
      state.loadingParents.delete(parent);
      state.loadingOwnerByParent.delete(parent);
    }
  }
  return state;
}
