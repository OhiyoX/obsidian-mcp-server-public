// #429 — the five tab-strip close actions, as pure planning over the navigation model.
//
// The strip's batch close must decide *everything* before it touches the document: which paths
// leave the list, and where the document goes when the tab on screen is one of them. This file
// pins that decision table (action x operated tab x active document), the neighbour rule for a
// plural removal, the disabled/no-op results, the equivalence with the frozen single-close plan,
// and the one-commit mutation primitive. No DOM is involved; the controller half lives in
// document-tabs-menu.test.js.
import assert from "node:assert/strict";
import test from "node:test";
import { createTabsModel, BULK_CLOSE_ACTIONS } from "../frontend/app/features/tabs/model.js";

const A = "A.md";
const B = "B.md";
const C = "C.md";
const D = "D.md";

// A strip whose first-open order is exactly `paths`; `activePath = null` means "no note tab is
// active" (a Base document is on screen, or the welcome workspace).
function strip(paths, activePath) {
  const model = createTabsModel();
  for (const path of paths) model.syncFromSession({ path, documentKind: "note" });
  if (activePath === null) model.syncFromSession({ path: null, documentKind: null });
  else if (activePath !== undefined) model.syncFromSession({ path: activePath, documentKind: "note" });
  return model;
}

const plan = (model, action, operated) => {
  const result = model.planBulkClose(action, operated);
  return { kind: result.kind, removePaths: result.removePaths, targetPath: result.targetPath, needsNavigation: result.needsNavigation };
};

test("#429: the planner knows exactly the five product actions", () => {
  assert.deepEqual([...BULK_CLOSE_ACTIONS], ["close", "close-others", "close-left", "close-right", "close-all"]);
  const model = strip([A, B], B);
  for (const action of ["close-tab", "close-everything", "", null, undefined]) {
    assert.equal(model.planBulkClose(action, B).kind, "invalid", `${String(action)} is not a close action`);
  }
  assert.equal(model.planBulkClose("close", "missing.md").kind, "invalid", "an unknown path has nothing to close");
  assert.equal(model.planBulkClose("close", undefined).kind, "invalid");
});

test("#429: action x operated tab x active document decides the exact removed set", () => {
  const cases = [
    // action, operated, active, kind, removePaths, targetPath, needsNavigation
    ["close", B, A, "commit", [B], A, false],
    ["close", B, B, "commit", [B], C, true],
    ["close", A, A, "commit", [A], B, true],
    ["close", D, D, "commit", [D], C, true],
    ["close-others", B, A, "commit", [A, C, D], B, true],
    ["close-others", A, A, "commit", [B, C, D], A, false],
    ["close-others", D, D, "commit", [A, B, C], D, false],
    ["close-others", C, B, "commit", [A, B, D], C, true],
    ["close-left", A, A, "noop", [], A, false],
    ["close-left", C, A, "commit", [A, B], C, true],
    ["close-left", C, D, "commit", [A, B], D, false],
    ["close-left", D, C, "commit", [A, B, C], D, true],
    ["close-right", D, A, "noop", [], A, false],
    ["close-right", B, A, "commit", [C, D], A, false],
    ["close-right", B, D, "commit", [C, D], B, true],
    ["close-right", A, D, "commit", [B, C, D], A, true],
    ["close-all", C, B, "commit", [A, B, C, D], null, true],
    ["close-all", C, null, "commit", [A, B, C, D], null, false],
  ];
  for (const [action, operated, active, kind, removePaths, targetPath, needsNavigation] of cases) {
    const model = strip([A, B, C, D], active);
    assert.deepEqual(
      plan(model, action, operated),
      { kind, removePaths, targetPath, needsNavigation },
      `${action} on ${operated} while showing ${String(active)}`,
    );
  }
});

test("#429: a singular strip makes Close Others / Left / Right no-ops (menu-disabled), never a fake close", () => {
  const single = strip([A], A);
  assert.equal(plan(single, "close-others", A).kind, "noop");
  assert.equal(plan(single, "close-left", A).kind, "noop");
  assert.equal(plan(single, "close-right", A).kind, "noop");
  // Close All closes the one tab, and the lone Close always removes its own tab.
  assert.deepEqual(plan(single, "close-all", A), { kind: "commit", removePaths: [A], targetPath: null, needsNavigation: true });
  assert.deepEqual(plan(single, "close", A), { kind: "commit", removePaths: [A], targetPath: null, needsNavigation: true });

  const first = strip([A, B], A);
  assert.equal(plan(first, "close-left", A).kind, "noop", "the operated tab is the first one");
  assert.equal(plan(first, "close-left", B).kind, "commit");
  const last = strip([A, B], B);
  assert.equal(plan(last, "close-right", B).kind, "noop", "the operated tab is the last one");
  assert.equal(plan(last, "close-right", A).kind, "commit");
});

test("#429: a plural removal keeps the single-close neighbour priority among surviving tabs", () => {
  // Close Others on a background tab whose neighbours all leave: the kept tab is the successor.
  const model = strip([A, B, C, D], A);
  assert.equal(plan(model, "close-others", C).targetPath, C);
  // Close Left / Right with the active document inside the removed run: first surviving tab to
  // the right, then to the left — never a tab that is being removed.
  const right = strip([A, B, C, D], B);
  assert.deepEqual(plan(right, "close-right", A), { kind: "commit", removePaths: [B, C, D], targetPath: A, needsNavigation: true });
  const left = strip([A, B, C, D], C);
  assert.deepEqual(plan(left, "close-left", D), { kind: "commit", removePaths: [A, B, C], targetPath: D, needsNavigation: true });
});

test("#429: only a removal that includes the shown document navigates; a background batch never does", () => {
  const model = strip([A, B, C, D], A);
  // None of these removal sets contains the document on screen (A), so none of them may
  // navigate, reopen a note or ask the dirty guard.
  for (const [action, operated] of [["close", B], ["close-others", A], ["close-right", B]]) {
    const result = plan(model, action, operated);
    assert.equal(result.kind, "commit", `${action} on ${operated} does remove tabs`);
    assert.equal(result.needsNavigation, false, `${action} on ${operated} keeps the shown document`);
    assert.equal(result.targetPath, A, `${action} on ${operated} keeps A active`);
  }
  // Close Left with A on screen (A is the first tab) can only remove A itself, so the product
  // planner reports the no-op instead of inventing a removal or a navigation.
  assert.deepEqual(plan(model, "close-left", A), { kind: "noop", removePaths: [], targetPath: A, needsNavigation: false });
  // The same action is a real, non-navigating batch when the shown document is not in its set.
  const elsewhere = strip([A, B, C, D], D);
  assert.deepEqual(
    plan(elsewhere, "close-left", B),
    { kind: "commit", removePaths: [A], targetPath: D, needsNavigation: false },
    "Close Left on a background tab keeps the shown document and asks nothing",
  );
  // A Base / welcome identity (no active note tab) never triggers a navigation either, even for
  // Close All: the note tabs are dropped without leaving the Base document.
  const based = strip([A, B], null);
  assert.deepEqual(plan(based, "close-all", A), { kind: "commit", removePaths: [A, B], targetPath: null, needsNavigation: false });
});

test("#429: planClose (the frozen single-close shape) is the same plan, action by action", () => {
  for (const activePath of [A, B, C, D, null]) {
    for (const [index, operated] of [A, B, C, D].entries()) {
      const model = strip([A, B, C, D], activePath);
      const single = model.planClose(index);
      const bulk = plan(model, "close", operated);
      assert.equal(bulk.kind, "commit");
      assert.deepEqual(bulk.removePaths, [operated]);
      if (activePath !== operated) {
        assert.equal(bulk.needsNavigation, false);
        assert.equal(single.kind, "inactive");
      } else if (bulk.targetPath === null) {
        assert.equal(single.kind, "welcome");
      } else {
        assert.deepEqual(single, { kind: "switch", index, targetPath: bulk.targetPath });
        assert.equal(bulk.needsNavigation, true);
      }
    }
  }
});

test("#429: the operational strip is empty / deactivated after Close All, not silently re-added", () => {
  const model = strip([A, B, C], B);
  const result = model.planBulkClose("close-all", A);
  assert.equal(model.getTabs().length, 3, "planning alone never mutates");
  model.commitBulk(result, { activate: null });
  assert.deepEqual(model.getTabs(), []);
  assert.equal(model.getActiveIndex(), -1);
  assert.equal(model.getActivePath(), null);
  // The same plan re-applied is a no-op on the now-empty list.
  model.commitBulk(result, { activate: null });
  assert.deepEqual(model.getTabs(), []);
  assert.equal(model.planBulkClose("close-all", A).kind, "invalid", "no tab is left to operate on");
});

test("#429: committing keeps the identity the caller passes, and drops only the planned paths", () => {
  const model = strip([A, B, C, D], B);
  const result = model.planBulkClose("close-others", C);
  model.commitBulk(result, { activate: C });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [C]);
  assert.equal(model.getActivePath(), C, "the committed document identity is what stays selected");
  assert.equal(model.getActiveIndex(), 0);

  // A Base document is not a tab: the same commit leaves no active tab instead of inventing one.
  const other = strip([A, B], A);
  other.commitBulk(other.planBulkClose("close-left", B), { activate: "_Bases/Status.base" });
  assert.deepEqual(other.getTabs().map((tab) => tab.path), [B]);
  assert.equal(other.getActiveIndex(), -1);
});

test("#429: removeAt (single-close mutation) and commitBulk agree, and samePaths guards staleness", () => {
  const viaRemove = strip([A, B, C], C);
  const viaCommit = strip([A, B, C], C);
  viaRemove.removeAt(1);
  viaCommit.commitBulk({ removePaths: [B] }, { activate: C });
  assert.deepEqual(viaRemove.getTabs(), viaCommit.getTabs());
  assert.equal(viaRemove.getActiveIndex(), viaCommit.getActiveIndex());
  assert.equal(viaRemove.getActivePath(), C);

  const model = strip([A, B], B);
  const result = model.planBulkClose("close-others", B);
  assert.equal(model.samePaths(result.basis), true);
  model.syncFromSession({ path: C, documentKind: "note" });
  assert.equal(model.samePaths(result.basis), false, "a tab list that moved makes the plan stale");
  assert.equal(model.samePaths([A]), false, "length is part of the identity");
  assert.equal(model.samePaths([B, A]), false, "order is part of the identity");
});

test("#429: reopening after a batch reuses the path, never a second tab", () => {
  const model = strip([A, B, C], C);
  model.commitBulk(model.planBulkClose("close-others", C));
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [C]);
  model.syncFromSession({ path: A, documentKind: "note" });
  model.syncFromSession({ path: C, documentKind: "note" });
  model.syncFromSession({ path: A, documentKind: "note" });
  assert.deepEqual(model.getTabs().map((tab) => tab.path), [C, A], "first-open order, one tab per path");
  assert.equal(model.getActiveIndex(), 1);
});
