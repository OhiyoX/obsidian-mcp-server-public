// Draggable height splitter between the two sections of the note-context "outgoing" view.
//
// The「当前笔记中的链接」view stacks two independently scrolling sections: the outgoing
// link list and the unlinked-mentions list. Desktop Obsidian renders both as plain
// sections of one contiguous column with no drag affordance (Obsidian Help
// `plugins/outgoing-links` documents the two sections but no splitter; the community
// splitter plugins only resize tab groups/panes), so this control is an explicit
// **user-requested Web enhancement** — not a desktop parity feature.
//
// The module owns the pointer drag, the keyboard nudge, the min-height clamp and the
// per-browser preference. It never rewrites the section markup, so `wireContextSection`
// keeps owning collapse/refresh.
//
// Min-height policy: {@link MIN_FIRST_SECTION}/{@link MIN_SECOND_SECTION} are *section*
// minimums (header + list). The list minimum applied to the drag is derived by removing
// that section's own header height, so the numbers hold at every breakpoint (the
// compact/mobile layouts use a taller header). When the rail is too short to satisfy
// both minimums the range collapses to what fits, never to a negative height.
export const STORAGE_KEY = "obsidian-web.rail-split.v1";
export const MIN_FIRST_SECTION = 120;
export const MIN_SECOND_SECTION = 80;
export const KEYBOARD_STEP = 16;
const DRAG_THRESHOLD = 3;
const RESIZING_CLASS = "is-resizing-rail";

const toNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Heights come from layout only; the harness/tests inject them via getBoundingClientRect.
function elementHeight(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect?.();
  const height = toNumber(rect?.height);
  if (height > 0) return height;
  return Math.max(0, toNumber(element.offsetHeight));
}

export function createContextRailSplitter({
  documentRef = globalThis.document,
  storage = null,
  windowRef = globalThis,
  panel = null,
  handle = null,
  firstList = null,
  secondHeader = null,
  minFirstSection = MIN_FIRST_SECTION,
  minSecondSection = MIN_SECOND_SECTION,
  step = KEYBOARD_STEP,
  resizeObserver: ResizeObserverImpl = null,
} = {}) {
  const panelEl = panel ?? documentRef?.querySelector?.("#context-view-outgoing") ?? null;
  const handleEl = handle ?? panelEl?.querySelector?.("#context-rail-splitter") ?? null;
  const firstListEl = firstList ?? panelEl?.querySelector?.("#outgoing-list") ?? null;
  const firstHeaderEl = panelEl?.querySelector?.('[data-context-section="outgoing"]') ?? null;
  const secondHeaderEl = secondHeader ?? panelEl?.querySelector?.('[data-context-section="unlinked"]') ?? null;

  if (!panelEl || !handleEl || !firstListEl || !firstHeaderEl || !secondHeaderEl) {
    return { isWired: false, getValue: () => null, getStored: () => null, setValue: () => null, metrics: () => null, sync: () => null, setSuspended: () => null, isSuspended: () => false, destroy: () => {} };
  }

  let stored = readStored();
  let current = null;
  let endDrag = null;
  let suspended = false;

  function readStored() {
    try {
      const raw = storage?.getItem?.(STORAGE_KEY);
      if (raw == null || raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      // A blocked/absent storage only costs the remembered split.
      return null;
    }
  }

  function writeStored(value) {
    try {
      storage?.setItem?.(STORAGE_KEY, String(value));
    } catch {
      // Ignore: the split still applies for this session.
    }
  }

  // Usable list band = panel minus both section headers and the splitter itself.
  function metrics() {
    const panelHeight = elementHeight(panelEl);
    const firstHeader = elementHeight(firstHeaderEl);
    const secondHeader = elementHeight(secondHeaderEl);
    const splitter = elementHeight(handleEl);
    const available = panelHeight - firstHeader - secondHeader - splitter;
    const rawMin = minFirstSection - firstHeader;
    const rawMax = available - (minSecondSection - secondHeader);
    const lo = Math.max(0, Math.min(rawMin, available));
    const hi = Math.max(lo, Math.min(rawMax, available));
    return { panelHeight, available, lo, hi };
  }

  function updateAria(lo, hi, value) {
    handleEl.setAttribute?.("aria-valuenow", String(Math.round(value)));
    handleEl.setAttribute?.("aria-valuemin", String(Math.round(lo)));
    handleEl.setAttribute?.("aria-valuemax", String(Math.round(hi)));
  }

  // Apply a clamped first-list height. Returns the applied value, or null while the
  // panel is not laid out (hidden view / before first layout) so nothing is pinned to 0.
  function render(value) {
    if (suspended) return null;
    const { panelHeight, available, lo, hi } = metrics();
    if (!(panelHeight > 0) || !(available > 0)) return null;
    const next = Math.round(clamp(value, lo, hi));
    if (firstListEl.style) firstListEl.style.flex = `0 0 ${next}px`;
    current = next;
    updateAria(lo, hi, next);
    return next;
  }

  function setValue(value, { persist = true } = {}) {
    const next = render(value);
    if (next == null) return null;
    if (persist) {
      stored = next;
      writeStored(next);
    }
    return next;
  }

  // The drag/keyboard baseline: the applied value, else the list as currently laid out.
  function liveValue() {
    if (current != null) return current;
    const measured = elementHeight(firstListEl);
    if (measured > 0) return measured;
    return metrics().lo;
  }

  function sync() {
    const { panelHeight, available, lo, hi } = metrics();
    if (!(panelHeight > 0) || !(available > 0)) return null;
    if (stored == null) {
      // No preference yet: leave the CSS default layout alone, but keep the a11y
      // values in step with whatever the browser actually rendered.
      updateAria(lo, hi, clamp(elementHeight(firstListEl) || lo, lo, hi));
      return null;
    }
    return render(stored);
  }

  // U7: with the unlinked-mentions section hidden there is nothing left to split, so the
  // splitter releases the first list and stops re-applying the stored height; un-suspending
  // re-applies it through the normal sync path.
  function setSuspended(value) {
    suspended = Boolean(value);
    // The handle has no meaning without the second section, so it hides with it (the
    // rail's own ``[hidden]`` rule wins over the flex display).
    if (handleEl) handleEl.hidden = suspended;
    if (suspended) {
      if (firstListEl.style) firstListEl.style.flex = "";
      current = null;
      return null;
    }
    return sync();
  }

  function onPointerDown(event) {
    if (event?.button != null && event.button !== 0) return;
    if (typeof event?.isPrimary === "boolean" && !event.isPrimary) return;
    const startY = toNumber(event?.clientY);
    const base = liveValue();
    const pointerId = event?.pointerId;
    let dragging = false;

    const onMove = (moveEvent) => {
      const delta = toNumber(moveEvent?.clientY) - startY;
      if (!dragging) {
        if (Math.abs(delta) < DRAG_THRESHOLD) return;
        dragging = true;
        moveEvent?.preventDefault?.();
        try { handleEl.setPointerCapture?.(pointerId); } catch { /* capture is best-effort */ }
        documentRef?.body?.classList?.add?.(RESIZING_CLASS);
      }
      setValue(base + delta);
    };

    const finish = () => {
      cleanup();
      if (!dragging) return;
      dragging = false;
      try { handleEl.releasePointerCapture?.(pointerId); } catch { /* already released */ }
      documentRef?.body?.classList?.remove?.(RESIZING_CLASS);
    };

    function cleanup() {
      windowRef?.removeEventListener?.("pointermove", onMove);
      windowRef?.removeEventListener?.("pointerup", finish);
      windowRef?.removeEventListener?.("pointercancel", finish);
      windowRef?.removeEventListener?.("blur", finish);
      endDrag = null;
    }

    windowRef?.addEventListener?.("pointermove", onMove);
    windowRef?.addEventListener?.("pointerup", finish);
    windowRef?.addEventListener?.("pointercancel", finish);
    windowRef?.addEventListener?.("blur", finish);
    endDrag = finish;
  }

  function onKeyDown(event) {
    const key = event?.key;
    if (key !== "ArrowUp" && key !== "ArrowDown") return;
    event.preventDefault?.();
    setValue(liveValue() + (key === "ArrowDown" ? step : -step));
  }

  handleEl.addEventListener("pointerdown", onPointerDown);
  handleEl.addEventListener("keydown", onKeyDown);

  const ResizeObserverCtor = ResizeObserverImpl ?? globalThis.ResizeObserver ?? null;
  let observer = null;
  const onWindowResize = () => { sync(); };
  if (typeof ResizeObserverCtor === "function") {
    observer = new ResizeObserverCtor(() => { sync(); });
    // The panel covers view switches / window resizes; the first list covers its own
    // content growing (that is what the default, preference-less split is sized from).
    try {
      observer.observe?.(panelEl);
      observer.observe?.(firstListEl);
    } catch { /* observing is best-effort */ }
  } else {
    windowRef?.addEventListener?.("resize", onWindowResize);
  }

  sync();

  return {
    isWired: true,
    getValue: () => current,
    getStored: () => stored,
    setValue,
    setSuspended,
    isSuspended: () => suspended,
    metrics,
    sync,
    destroy() {
      handleEl.removeEventListener?.("pointerdown", onPointerDown);
      handleEl.removeEventListener?.("keydown", onKeyDown);
      endDrag?.();
      observer?.disconnect?.();
      if (!observer) windowRef?.removeEventListener?.("resize", onWindowResize);
    },
  };
}
