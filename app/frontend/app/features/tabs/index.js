// U14 document tab strip — controller.
//
// Owns the wiring between the pure model (./model.js), the DOM view (./view.js), the batch-close
// menu (./menu.js) and the app's single document pipeline: opening a tab is an ordinary
// `openNote(path)`, so the session stays the only writer of the active document, unsaved edits
// keep their existing guard, and switching tabs re-reads the note from disk (no per-tab content
// is stored).
//
// `core/app.js` only calls `syncFromSession()` after a committed open/reload and when the
// document kind changes; this module never writes the document identity.
//
// #429 close semantics — one lane for the single close and for the four batch actions:
//
//   1. plan (pure, `model.planBulkClose` / `model.planClose`): which paths leave the strip, and
//      whether the document on screen is one of them. A background-only batch is a pure list
//      edit: no navigation, no dirty-guard dialog, no focus change;
//   2. if the closure gives up the document on screen, decide the final navigation *first* and
//      let the app's pipeline commit it (`openNote` for a surviving tab, the injected in-app
//      welcome transition for the last one) — a refused guard aborts here with **zero tabs
//      removed**;
//   3. commit the planned new tab list exactly once, selected by the *committed* document
//      identity. No loop of `close(index)` calls, so a batch can never be left half applied.
//
// The plan is computed against a path-list snapshot, so a tab list that changed while the
// navigation was in flight makes the plan stale and it is dropped (fail-closed) instead of
// removing tabs the user did not see when they picked the action.
import { createTabsModel } from "./model.js";
import { createDocumentTabsView } from "./view.js";
import { createTabsCloseMenu } from "./menu.js";

export function createDocumentTabs({
  documentRef = globalThis.document,
  openNote = async () => false,
  getCurrentPath = () => null,
  getDocumentKind = () => null,
  // Issue #410 (audit Cut D): closing the last tab leaves the document altogether. The
  // transition itself (dirty guard, session reset, history/URL, welcome surface) belongs to
  // the app's document pipeline, so it is injected — this controller never reloads the page
  // and never writes the document identity itself.
  enterWelcome = null,
  // The committed list is mirrored outward on every model change, so the workspace tab row
  // (U29) follows the strip even when the change does not come from a document identity.
  onModelChange = () => {},
} = {}) {
  const host = documentRef?.querySelector?.("#document-tabs") ?? null;
  if (!host) return { isWired: false, syncFromSession() {}, destroy() {} };

  const model = createTabsModel();
  // One close at a time: a double pick, a double `Delete` or two menus cannot run a second
  // batch on top of an in-flight navigation.
  let busy = false;
  // The close lane's navigation watcher: `{ targetPath, resolve }` while a close is waiting for
  // the app to commit the document the plan decided (see `navigateTo`).
  let pendingNavigation = null;

  function render() {
    const tabs = model.getTabs();
    view?.render(tabs, model.getActiveIndex());
    // An open menu follows the list it was planned against (a tab removed by SSE, another
    // close, a vault switch) instead of offering a stale target.
    menu?.sync();
    onModelChange(tabs);
  }

  async function select(path) {
    // Clicking the tab whose note is already on screen is a no-op: re-opening it would
    // re-read the file and would ask the dirty-document guard for no reason.
    if (!path || path === model.getActivePath()) return false;
    return openNote(path);
  }

  /**
   * Hand the app the navigation the plan decided and report whether it really committed, i.e.
   * `openNote()` through the ordinary flow plus the app's own commit seam. Awaiting the returned
   * promise alone is not a correct signal: the app's pipeline also resolves `false` *after* it
   * already committed (its publish/header refresh is awaited inside the same `try`) and it can
   * stay pending after a commit, while the strip must follow the document that is really on
   * screen. A refused dirty guard, a failed open or a vault switch changes no identity, so the
   * watcher never fires and the batch removes nothing — the contract's "0 tab removed" case.
   */
  async function navigateTo(plan) {
    const committed = new Promise((resolve) => { pendingNavigation = { targetPath: plan.targetPath, resolve }; });
    const pipeline = (async () => {
      const opened = await openNote(plan.targetPath);
      return Boolean(opened) || getCurrentPath() === plan.targetPath;
    })();
    try {
      return await Promise.race([committed, pipeline]);
    } finally {
      pendingNavigation = null;
    }
  }

  /**
   * Run one planned close. `plan` is either a bulk plan or the single-close plan shape (see
   * `model.planClose`) and carries: the paths to remove, the navigation target the close
   * decided, whether the document on screen is being given up, and the list it was planned
   * against.
   */
  async function commitPlan(plan) {
    if (plan?.kind !== "commit") return false;
    if (busy) return false;
    busy = true;
    try {
      if (plan.needsNavigation) {
        if (plan.targetPath === null) {
          if (typeof enterWelcome !== "function") return false;
          if (!await enterWelcome()) return false;
        } else {
          // A refused guard (unsaved edits), a failed open or a vault switch aborts the whole
          // close before anything is removed.
          if (!await navigateTo(plan)) return false;
        }
        // The list may have moved while that navigation was in flight (another close, a
        // rename/delete through SSE). The plan is stale then, and a stale plan must not
        // remove paths the user did not pick against.
        if (!model.samePaths(plan.basis)) return false;
      }
      // One commit for the whole action, keyed on the committed document identity instead of
      // the plan's numeric positions.
      model.commitBulk(plan, { activate: getCurrentPath() });
      render();
      return true;
    } finally {
      busy = false;
    }
  }

  /** Single close (X button / `Delete` / the menu's Close). */
  async function close(index) {
    const tab = model.getTabs()[index];
    if (!tab) return false;
    const plan = model.planClose(index);
    if (plan.kind === "inactive") return commitPlan({ kind: "commit", removePaths: [tab.path], needsNavigation: false, targetPath: null, basis: model.getPaths() });
    if (plan.kind === "switch") return commitPlan({ kind: "commit", removePaths: [tab.path], needsNavigation: true, targetPath: plan.targetPath, basis: model.getPaths() });
    if (plan.kind === "welcome") return commitPlan({ kind: "commit", removePaths: [tab.path], needsNavigation: true, targetPath: null, basis: model.getPaths() });
    return false;
  }

  /** Batch close from the menu: the operated tab's *path* decides the affected set. */
  function closeMany(action, operatedPath) {
    return commitPlan(model.planBulkClose(action, operatedPath));
  }

  const menu = createTabsCloseMenu({
    documentRef,
    planFor: (action, operatedPath) => model.planBulkClose(action, operatedPath),
    onAction: (action, operatedPath) => closeMany(action, operatedPath),
  });

  const view = createDocumentTabsView({
    host,
    documentRef,
    // The keyboard navigation in the view needs the activation result: focus follows the tab
    // only after the open committed, and returns to the active tab when the guard refused it.
    onSelect: (path) => select(path),
    onClose: (index) => close(index),
    // Right-click / Shift+F10 / ContextMenu / touch long press, always with the operated tab.
    onMenu: (path, request) => menu?.open(path, request),
  });

  render();

  return {
    isWired: true,
    /** Reconcile the strip with the committed document identity (note open / reload / Base). */
    syncFromSession() {
      model.syncFromSession({ path: getCurrentPath(), documentKind: getDocumentKind() });
      // The app commits the document identity here, so this is also the signal an in-flight
      // close waits for; it resolves only for the identity the plan decided.
      const pending = pendingNavigation;
      if (pending && getCurrentPath() === pending.targetPath) {
        pendingNavigation = null;
        pending.resolve(true);
      }
      render();
    },
    getState: () => ({ tabs: model.getTabs(), activeIndex: model.getActiveIndex(), menuTarget: menu?.target() ?? null, menuOpen: Boolean(menu?.isOpen()) }),
    destroy() {
      view?.destroy();
      menu?.destroy();
    },
  };
}
