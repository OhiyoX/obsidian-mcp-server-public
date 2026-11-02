import { StateEffect, StateField } from "@codemirror/state";

export const interactionEffect = StateEffect.define();

export const interactionField = StateField.define({
  create() {
    return {
      pointerSelecting: false,
      composing: false,
      pointerAnchor: null,
      dragMoved: false,
    };
  },
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(interactionEffect)) next = { ...next, ...effect.value };
    }
    return next;
  },
});

export function isInteractionFrozen(state) {
  const value = state.field(interactionField, false);
  return Boolean(value?.pointerSelecting || value?.composing);
}

/**
 * Shared pointer-drag freeze for surfaces that own their own pointerdown.
 *
 * `attachInteractionHandlers` only sees pointerdowns that reach `view.dom`.
 * A nested block surface (the rendered table block) stops the event before it
 * gets there, but the gesture can then continue in the root editor (see
 * `table-cell-editor.js` / `table-drag-handoff.js`). That continuation must
 * engage the same freeze, otherwise Live Preview block/decoration plugins keep
 * rebuilding under the pointer while the user is still dragging.
 *
 * Returns true when the field actually changed.
 */
export function freezePointerSelection(view, { dragMoved = true } = {}) {
  const value = view.state.field(interactionField, false);
  if (!value) return false;
  const moved = Boolean(dragMoved);
  if (value.pointerSelecting && value.dragMoved === moved) return false;
  view.dispatch({ effects: interactionEffect.of({ pointerSelecting: true, dragMoved: moved }) });
  return true;
}

/**
 * Releases a pointer freeze. Safe to call when no freeze is set, and safe to
 * call for a freeze this module's own handler did not create — a nested surface
 * or a lost pointerup must never leave the editor frozen forever.
 *
 * `dragMoved` is deliberately preserved: the click fallback
 * (`shouldCollapsePaddingNewline`) reads it after the gesture ends.
 */
export function releasePointerSelection(view) {
  const value = view.state.field(interactionField, false);
  if (!value?.pointerSelecting) return false;
  view.dispatch({ effects: interactionEffect.of({ pointerSelecting: false, pointerAnchor: null }) });
  return true;
}

/**
 * Shared pointer + composition freeze for Live Preview decorations.
 * Maps decoration ranges while frozen; callers rebuild after release.
 */
export function createInteractionBinder() {
  return {
    extension: [interactionField],
    effect: interactionEffect,
    field: interactionField,
  };
}

export function attachInteractionHandlers(view) {
  let pointerSelecting = false;
  let dragMoved = false;
  let anchor = null;
  let detached = false;

  const setFreeze = (patch) => {
    if (detached) return;
    view.dispatch({ effects: interactionEffect.of(patch) });
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    pointerSelecting = true;
    dragMoved = false;
    anchor = { x: event.clientX, y: event.clientY };
    setFreeze({ pointerSelecting: true, dragMoved: false, pointerAnchor: anchor });
  };

  const onPointerMove = (event) => {
    if (!pointerSelecting || !anchor || dragMoved) return;
    if (Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) > 4) {
      dragMoved = true;
      // Dispatch once when the drag threshold is crossed; geometry rebuilds on pointerup.
      setFreeze({ pointerSelecting: true, dragMoved: true, pointerAnchor: anchor });
    }
  };

  const endPointer = () => {
    if (!pointerSelecting) {
      // A nested block surface may own this gesture (it stopped the pointerdown
      // before it reached view.dom). Never leave its shared freeze latched.
      if (!detached) releasePointerSelection(view);
      return;
    }
    pointerSelecting = false;
    const wasDrag = dragMoved;
    dragMoved = false;
    anchor = null;
    setFreeze({ pointerSelecting: false, dragMoved: wasDrag, pointerAnchor: null });
  };

  const onCompositionStart = () => setFreeze({ composing: true });
  const onCompositionEnd = () => setFreeze({ composing: false });

  const onBlur = () => {
    endPointer();
    if (!detached) setFreeze({ composing: false });
  };

  view.dom.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);
  window.addEventListener("blur", onBlur);
  view.dom.addEventListener("compositionstart", onCompositionStart);
  view.dom.addEventListener("compositionend", onCompositionEnd);

  return () => {
    detached = true;
    view.dom.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endPointer);
    window.removeEventListener("pointercancel", endPointer);
    window.removeEventListener("blur", onBlur);
    view.dom.removeEventListener("compositionstart", onCompositionStart);
    view.dom.removeEventListener("compositionend", onCompositionEnd);
    pointerSelecting = false;
    dragMoved = false;
    anchor = null;
    // Do not dispatch during teardown — EditorView may already be destroyed.
  };
}
