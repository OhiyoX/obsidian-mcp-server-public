import { ViewPlugin } from "@codemirror/view";
import { caretPaintTarget, caretSnapSettled, layoutUnitLeft } from "./caret-metrics.js";

// Re-snapping must not feed itself: writing `style.left` fires the style
// mutation observer, and Blink's 1/64 px LayoutUnit can round the written value
// so the element never reads back exactly as written. Remember both the raw
// CodeMirror value and our snapped value so an observer pass can distinguish
// "CodeMirror redrew" from "we already handled this node".
const SNAPPED_LEFT = Symbol("caretSnappedLeft");
const RAW_LEFT = Symbol("caretRawLeft");

/**
 * Keep drawSelection() cursors on the physical-pixel grid by moving the layout
 * `left`, not by painting a fractional CSS transform.
 *
 * drawSelection() may replace/update cursor DOM during its own measure cycle.
 * Snapping in a sibling requestMeasure therefore races the final cursor node.
 * Observe that final DOM/style mutation instead: mutation observers run after
 * the CodeMirror write and before the browser paints.
 *
 * A fractional `translate` is painted as a sub-pixel transform, which
 * antialiases both caret edges at integral DPR (1/2) where Blink would already
 * snap a layout box. Moving `left` onto the device grid lets that native
 * snapping keep the caret crisp and keeps line-start and in-line carets the
 * same painted width. At fractional DPR the CSS grid cannot be represented
 * exactly by LayoutUnit; the probe evidence for that boundary lives in
 * `app/test/editor-caret.test.js` and the P0-B handoff.
 *
 * This never changes EditorState selection or CodeMirror document geometry.
 */
export const snapCaretToDevicePixels = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.queued = false;
    this.destroyed = false;
    this.schedule = this.schedule.bind(this);
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(view.dom, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    view.scrollDOM.addEventListener("scroll", this.schedule, { passive: true });
    window.addEventListener("resize", this.schedule, { passive: true });
    this.schedule();
  }

  update(update) {
    if (
      update.selectionSet
      || update.docChanged
      || update.viewportChanged
      || update.geometryChanged
      || update.focusChanged
    ) {
      this.schedule();
    }
  }

  schedule() {
    if (this.queued || this.destroyed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.destroyed) this.snap();
    });
  }

  snap() {
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    for (const cursor of this.view.dom.querySelectorAll(".cm-cursor")) {
      // Clean up any paint offset written by the previous transform-based snap.
      if (cursor.style.translate) cursor.style.removeProperty("translate");
      const rawLeft = Number.parseFloat(cursor.style.left);
      if (!Number.isFinite(rawLeft)) continue;
      if (caretSnapSettled(rawLeft, cursor[SNAPPED_LEFT])) continue;
      const rect = cursor.getBoundingClientRect();
      const { left, delta, changed } = caretPaintTarget({ rawLeft, viewportLeft: rect.left, dpr });
      if (!changed) {
        cursor[RAW_LEFT] = rawLeft;
        continue;
      }
      // Blink stores `style.left` as a LayoutUnit and serializes the specified
      // float back, so writing the raw `rawLeft + delta` sum can truncate one
      // LayoutUnit short of the device grid. Write the LayoutUnit-exact value
      // so the used layout left is the one we chose.
      const snapped = layoutUnitLeft(left);
      if (cursor[RAW_LEFT] === undefined) cursor[RAW_LEFT] = rawLeft;
      if (snapped === rawLeft) {
        cursor[SNAPPED_LEFT] = rawLeft;
        continue;
      }
      cursor.style.left = `${snapped}px`;
      // Blink serializes the used value and may round it (LayoutUnit 1/64 px),
      // so compare future passes against what the DOM actually reports. Using
      // the requested value here would re-fire forever at fractional DPR.
      cursor[SNAPPED_LEFT] = Number.parseFloat(cursor.style.left);
    }
  }

  destroy() {
    this.destroyed = true;
    this.observer.disconnect();
    this.view.scrollDOM.removeEventListener("scroll", this.schedule);
    window.removeEventListener("resize", this.schedule);
    for (const cursor of this.view.dom.querySelectorAll(".cm-cursor")) {
      cursor.style.removeProperty("translate");
      if (cursor[RAW_LEFT] !== undefined) cursor.style.left = `${cursor[RAW_LEFT]}px`;
      delete cursor[SNAPPED_LEFT];
      delete cursor[RAW_LEFT];
    }
  }
});
