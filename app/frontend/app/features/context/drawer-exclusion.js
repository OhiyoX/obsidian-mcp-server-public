// U29 (#371): the single mobile drawer policy of both side panes.
//
// `sidebar-panels.js` (files / search) and `pane-layout.js` (note context) each own one pane,
// but a phone has room for one drawer at a time. Both controllers therefore drive their drawer
// state through this module instead of toggling each other's class, so "opening one side hands
// the other side back" lives in exactly one place and neither controller needs to know the other
// exists. `<=720px` is the one side-pane breakpoint (the old 721-1050 tablet band is gone); above
// it each pane keeps its own docked preference (`.sidebar-hidden` / `obsidian-web.context-open`)
// and this module is not consulted. Only one `.scrim` exists in the shell, so the shared overlay
// needs no second owner: it is shown by CSS from whichever drawer class is present.
export const DRAWER_QUERY = "(max-width:720px)";
export const LEFT_DRAWER_CLASS = "sidebar-open";
export const RIGHT_DRAWER_CLASS = "context-open";
export const DRAWER_POLICY_EVENT = "drawer-policy-change";

const CLASSES = { left: LEFT_DRAWER_CLASS, right: RIGHT_DRAWER_CLASS };

export function isDrawerMode(matchMediaFn = globalThis.matchMedia) {
  return Boolean(matchMediaFn?.(DRAWER_QUERY)?.matches);
}

export function isDrawerOpen(shell, side) {
  return Boolean(shell?.classList?.contains(CLASSES[side]));
}

/**
 * Put one side into (or out of) its drawer state. Opening a side always closes the other one:
 * the shell may never carry both drawer classes. The element-scoped event lets the other
 * controller reconcile its own state (its `aria-pressed`, its preference) with the real DOM
 * instead of keeping a second, stale copy — no module-level state is involved.
 */
export function setDrawerOpen(shell, side, open) {
  const own = CLASSES[side];
  if (!own || !shell?.classList) return false;
  const other = side === "left" ? RIGHT_DRAWER_CLASS : LEFT_DRAWER_CLASS;
  if (open) shell.classList.remove(other);
  shell.classList.toggle(own, Boolean(open));
  announce(shell, side, Boolean(open));
  return Boolean(open);
}

export function closeDrawers(shell) {
  shell?.classList?.remove(LEFT_DRAWER_CLASS, RIGHT_DRAWER_CLASS);
}

function announce(shell, side, open) {
  const view = shell?.ownerDocument?.defaultView;
  if (typeof view?.CustomEvent !== "function" || typeof shell.dispatchEvent !== "function") return;
  shell.dispatchEvent(new view.CustomEvent(DRAWER_POLICY_EVENT, { detail: { side, open } }));
}
