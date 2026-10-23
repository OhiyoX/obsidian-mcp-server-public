// The one unsaved-changes guard every document transition asks through.
//
// Issue #410 (audit Cut D): closing the last document tab has to ask exactly like every
// other open/close/switch, so the dirty test and the native `confirm` live here instead of
// being re-written at each call site. A declined dialog returns `false` before the caller
// touches any state, so the document, the strip and the address all stay where they were.
//
// The action is part of the message, never part of the decision: the same guard answers for
// "open another note" and for "close this document", one implementation, one shape.
export const UNSAVED_CHANGES_PREFIX = "当前修改尚未保存，仍要";

export function dirtyDiscardMessage(action) {
  return `${UNSAVED_CHANGES_PREFIX}${action}`;
}

export function confirmDiscardChanges({ session, message, confirm: confirmOption } = {}) {
  if (!session?.isDirty?.()) return true;
  const confirmFn = confirmOption
    ?? (typeof globalThis.confirm === "function" ? globalThis.confirm.bind(globalThis) : () => true);
  return Boolean(confirmFn(message));
}
