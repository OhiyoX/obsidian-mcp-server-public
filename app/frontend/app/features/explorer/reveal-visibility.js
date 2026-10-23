// Explorer reveal visibility: does the current note row need the tree to scroll it in?
//
// Kept in its own module so the renderer's source shape (a `revealCurrent` branch that
// performs the scroll) stays intact for the frozen interaction contract, while the settled
// reveal callback can ask the same question without importing the renderer.
//
// `createSettledReveal` is that settled callback (U19): when a locate settles, the Tree
// must be told to scroll the current row in -- but only in tree mode, with no active
// query, and only while the settled path is still the current note. The controller
// injects the live seams; the decision lives here, next to the probe it depends on,
// instead of pulling the renderer or the controller's state shape into this module.
import { isSameNotePath } from "./path-identity.js";

export function currentRowNeedsReveal(host) {
  const row = host.querySelector('.note[aria-current="page"]');
  if (!row) return false;
  const box = host.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  return rect.top < box.top || rect.bottom > box.bottom;
}

export function createSettledReveal({ host, render, getCurrentPath, isFlatMode, isQueryActive }) {
  return (settledPath) => {
    if (isFlatMode() || isQueryActive() || !isSameNotePath(settledPath, getCurrentPath())) return;
    if (currentRowNeedsReveal(host)) render({ revealCurrent: true });
  };
}
