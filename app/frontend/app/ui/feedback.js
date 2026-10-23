// Transient feedback for the Web workspace.
//
// Issue #411 (audit §5, Cut E): a toast used to be pure pixels -- no `role`, no
// `aria-live`, and success/failure shared one 2600 ms lifetime. The semantics
// added here are:
//
// - success / information -> `role="status"` + `aria-live="polite"`: announced
//   when the reader is idle, never interrupting typing;
// - failure -> `role="alert"` + `aria-live="assertive"`: an error interrupts;
// - the toast element *is* the live region. There is deliberately no container,
//   so one `toast()` call is one announcement (no container + child double
//   announcement);
// - the text is written *after* the node is attached, because a live region must
//   already be in the document when its content changes to be announced.
//
// Timing policy (explicit, see also `U37/U37.HANDOFF.md`):
//
// - `TOAST_SUCCESS_MS` = 2600 ms (unchanged baseline for success/information);
// - `TOAST_ERROR_MS` = 8000 ms -- strictly longer than success, so an error can
//   be read, and still temporary: nothing here is permanent.
//
// A failure is additionally closable by hand: pointer activation (click) works
// for every toast, and an error toast is keyboard reachable (`tabIndex = 0`,
// Escape closes it). Hovering or focusing a toast pauses its auto-remove and
// leaving re-arms the full window, so the message can be re-read; a toast is
// never removed-only-by-interaction and never outlives its timeout otherwise.
export const TOAST_SUCCESS_MS = 2600;
export const TOAST_ERROR_MS = 8000;

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

// The caller contract is unchanged: `toast(message, error = false)`. The return
// value (the live-region element) is additive and used by the tests.
export function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.setAttribute("role", error ? "alert" : "status");
  element.setAttribute("aria-live", error ? "assertive" : "polite");
  element.setAttribute("aria-atomic", "true");
  document.body.append(element);
  element.textContent = message;

  let timer = null;

  function clearTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function remove() {
    clearTimer();
    element.remove();
  }

  function arm() {
    clearTimer();
    timer = setTimeout(remove, error ? TOAST_ERROR_MS : TOAST_SUCCESS_MS);
  }

  element.addEventListener("click", remove);
  if (error) {
    // Keyboard path: reachable by Tab, closable with Escape, re-readable on focus.
    element.tabIndex = 0;
    element.addEventListener("keydown", (event) => {
      if (event?.key === "Escape") remove();
    });
    element.addEventListener("focus", clearTimer);
    element.addEventListener("blur", arm);
  }
  element.addEventListener("mouseenter", clearTimer);
  element.addEventListener("mouseleave", arm);
  arm();

  return element;
}
