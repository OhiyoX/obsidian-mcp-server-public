// Process primary authorization: unresolved bootstrap always refuses. Legacy is an explicit
// proven mode (switch off, record absent, enrollment absent), never a missing resolver/cache.
const LEGACY_TOKEN = Object.freeze({ legacy: true });
const UNKNOWN_TOKEN = Object.freeze({ unresolved: true });
const RELEASED = Object.freeze({ lease: null, isCurrent: () => false });
let state = null;
let mode = "unresolved";
let onReleaseCallback = null;
let onAllowCallback = null;
export function initializePrimaryAuthorization({ managed }) {
  if (typeof managed !== "boolean") throw new TypeError("explicit managed/legacy evidence is required");
  if (mode === "managed") return;
  if (managed) { mode = "managed"; state = RELEASED; }
  else if (mode === "unresolved") mode = "legacy";
}
export function bindPrimaryAuthorization(lease, isCurrent) {
  if (lease == null) return false;
  if (typeof isCurrent !== "function") throw new TypeError("primary binding requires an authoritative currency predicate");
  if (state?.lease === lease) return false;
  mode = "managed";
  state = Object.freeze({ lease, isCurrent });
  allowPrimaryAuthorization();
  return true;
}
// Starting resources never grants authority: only the committed lease can allow a managed primary.
export function allowPrimaryAuthorization() {
  if (mode !== "managed" || state?.lease == null || !primaryAuthorized()) return false;
  if (typeof onAllowCallback === "function") {
    try { onAllowCallback(); } catch (error) { console.error("Primary allow callback failed:", error); }
  }
  return true;
}
export function releasePrimaryAuthorization(lease) {
  // F3: support releasing process-owned primary (lease=null) in managed mode
  if (mode !== "managed") return false;
  if (lease == null && state?.lease != null) return false; // Can't release with wrong lease
  if (lease != null && state?.lease !== lease) return false; // Can't release with wrong lease
  mode = "managed"; state = RELEASED;
  // F3: invoke the registered callback to stop timers
  if (typeof onReleaseCallback === "function") {
    try { onReleaseCallback(); } catch (error) { console.error("Primary release callback failed:", error); }
  }
  return true;
}
export function primaryAuthorizationToken() {
  return mode === "legacy" ? LEGACY_TOKEN : state?.lease ?? UNKNOWN_TOKEN;
}
export function primaryAuthorized() {
  if (mode === "legacy") return true;
  try { return state?.isCurrent() === true; } catch { return false; }
}
export function primaryAuthorizationState() {
  return Object.freeze({ mode, bound: state?.lease != null, released: state === RELEASED });
}
export function registerPrimaryReleaseCallback(callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  onReleaseCallback = callback;
}
export function registerPrimaryAllowCallback(callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  onAllowCallback = callback;
}
