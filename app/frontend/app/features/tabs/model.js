// U14 document tab strip — pure state model.
//
// The desktop window keeps one tab per open document above the view header. The Web app
// still has a single Markdown document (features/session/**) and a separate Base surface,
// so this module is only the *navigation* state of that one document: which notes have
// been visited in this page session, which one is on screen, and what closing a tab must
// do next.
//
// Invariants (frozen by the U14 BRIEF):
// - one tab per path, in first-open order;
// - a note open appends (or re-activates) its tab; a Base document adds none and leaves
//   every tab inactive;
// - closing an inactive tab never changes the active document;
// - closing the active tab hands the choice to the caller: right neighbour, else left
//   neighbour, else "welcome" (no document);
// - the model never stores document content: switching documents re-reads from disk
//   through the existing `openNote` flow (unsaved edits stay guarded by the session).
export const BASE_DOCUMENT_KIND = "base";

/** Tab label = the file name without the Markdown extension (desktop shows the note name). */
export function tabTitle(path) {
  const name = String(path ?? "").split("/").pop() ?? "";
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * The five tab-strip close actions (#429). `close` is the single-tab close the X button, the
 * keyboard `Delete` and the context menu share; the other four are the batch actions.
 */
export const BULK_CLOSE_ACTIONS = Object.freeze([
  "close",
  "close-others",
  "close-left",
  "close-right",
  "close-all",
]);

export function createTabsModel() {
  let tabs = [];
  let activeIndex = -1;

  function indexOfPath(path) {
    return tabs.findIndex((tab) => tab.path === path);
  }

  function activePath() {
    return activeIndex >= 0 ? tabs[activeIndex]?.path ?? null : null;
  }

  function paths() {
    return tabs.map((tab) => tab.path);
  }

  /**
   * Reconcile the tab list with the committed document identity. Called after every
   * successful open/reload, so it is the only writer of `activeIndex`.
   */
  function syncFromSession({ path = null, documentKind = null } = {}) {
    if (documentKind === BASE_DOCUMENT_KIND || !path) {
      activeIndex = -1;
      return activeIndex;
    }
    const known = indexOfPath(path);
    if (known >= 0) {
      activeIndex = known;
      return activeIndex;
    }
    tabs.push({ path });
    activeIndex = tabs.length - 1;
    return activeIndex;
  }

  /**
   * The caller's navigation target, i.e. the first tab the surviving set still has to the right
   * of the closing document, else the first one to its left, else `null` (no note is left, so
   * the close ends on the welcome workspace). Closing more than one tab therefore reuses the
   * single-close neighbour priority — the successor is always a tab that is really kept.
   */
  function successorAfter(removeSet, fromIndex, ordered) {
    for (let index = fromIndex + 1; index < ordered.length; index += 1) {
      if (!removeSet.has(index)) return ordered[index];
    }
    for (let index = fromIndex - 1; index >= 0; index -= 1) {
      if (!removeSet.has(index)) return ordered[index];
    }
    return null;
  }

  /**
   * Plan one of the five close actions against the tab a user operated on, without mutating
   * anything (#429). The result is the whole decision the caller needs before it touches the
   * document: which paths leave the strip, and which navigation (if any) must commit first.
   *
   *   kind         "commit" (a real change), "noop" (nothing to remove) or "invalid"
   *   removePaths  the tabs to drop, in first-open order; the target of Close Others/Left/Right
   *                is decided on the operated tab, never on the active tab or a numeric index
   *   targetPath   the navigation target (see `successorAfter`), or `null` for the welcome page
   *   needsNavigation  whether the document on screen is itself in `removePaths` — only then may
   *                the caller navigate, ask the dirty guard or move focus
   *   basis        the tab list this plan was computed against, so a stale plan can fail closed
   *
   * `operatedPath` is the tab the user acted on (context menu / keyboard / touch), which is why
   * the batch actions never drift onto the active tab or a shifted index.
   */
  function planBulkClose(action, operatedPath) {
    const ordered = paths();
    const basis = ordered.slice();
    const operatedIndex = typeof operatedPath === "string" ? indexOfPath(operatedPath) : -1;
    if (!BULK_CLOSE_ACTIONS.includes(action) || operatedIndex < 0) {
      return { kind: "invalid", action, operatedPath, operatedIndex, removePaths: [], targetPath: null, needsNavigation: false, basis };
    }
    const removeSet = new Set();
    if (action === "close") removeSet.add(operatedIndex);
    else if (action === "close-all") ordered.forEach((_, index) => removeSet.add(index));
    else if (action === "close-others") ordered.forEach((_, index) => { if (index !== operatedIndex) removeSet.add(index); });
    else if (action === "close-left") ordered.forEach((_, index) => { if (index < operatedIndex) removeSet.add(index); });
    else ordered.forEach((_, index) => { if (index > operatedIndex) removeSet.add(index); });

    const removePaths = ordered.filter((_, index) => removeSet.has(index));
    // Nothing to remove: the action is a no-op (and, in the menu, a disabled item) — it must
    // never be reported as a successful close.
    if (removePaths.length === 0) {
      return { kind: "noop", action, operatedPath, operatedIndex, removePaths, targetPath: activePath(), needsNavigation: false, basis };
    }
    // Only a navigation that really gives up the document on screen may ask the dirty guard,
    // reopen a note or move focus; a background-only batch stays a pure list edit.
    const needsNavigation = activeIndex >= 0 && removeSet.has(activeIndex);
    const targetPath = needsNavigation ? successorAfter(removeSet, activeIndex, ordered) : activePath();
    return { kind: "commit", action, operatedPath, operatedIndex, removePaths, targetPath, needsNavigation, basis };
  }

  /**
   * What closing `index` would do, without mutating anything: the caller navigates first
   * (so a rejected dirty-document guard can abort the close) and only then drops the tab.
   * The single close is planned by `planBulkClose`, so one implementation owns the neighbour
   * priority and the five actions cannot drift apart; the return shape is the frozen U14/#408
   * one the strip's tests read.
   */
  function planClose(index) {
    if (!Number.isInteger(index) || index < 0 || index >= tabs.length) return { kind: "invalid", index };
    if (index !== activeIndex) return { kind: "inactive", index };
    const plan = planBulkClose("close", tabs[index].path);
    if (plan.targetPath === null) return { kind: "welcome", index };
    return { kind: "switch", index, targetPath: plan.targetPath };
  }

  /** Drop the planned tabs in one commit. `activate` is the document identity that must stay
   *  selected (the caller passes the committed one), so the strip can never pick an active tab
   *  the document is not showing. */
  function commitBulk(plan, { activate } = {}) {
    const remove = new Set(plan?.removePaths ?? []);
    const keep = activate === undefined ? plan?.targetPath ?? null : activate;
    tabs = tabs.filter((tab) => !remove.has(tab.path));
    activeIndex = keep === null || keep === undefined ? -1 : indexOfPath(keep);
  }

  /** Drop a single tab after its close was committed (thin wrapper over `commitBulk`). For an
   *  active-tab close the plan's target is passed explicitly, so the strip's active tab reflects
   *  the document the caller just navigated to instead of depending on a second sync round-trip. */
  function removeAt(index, { activate } = {}) {
    const tab = tabs[index];
    if (!tab) return;
    commitBulk({ removePaths: [tab.path] }, { activate: activate ?? activePath() });
  }

  /** Whether the tab list still is the list a plan was computed against (stale-plan guard). */
  function samePaths(expected = []) {
    const current = paths();
    if (current.length !== expected.length) return false;
    return current.every((path, index) => path === expected[index]);
  }

  return {
    getTabs: () => tabs.map((tab) => ({ ...tab })),
    getActiveIndex: () => activeIndex,
    getActivePath: activePath,
    getPaths: paths,
    size: () => tabs.length,
    indexOfPath,
    syncFromSession,
    planBulkClose,
    planClose,
    commitBulk,
    samePaths,
    removeAt,
  };
}
