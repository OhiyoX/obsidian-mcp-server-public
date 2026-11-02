// The lazy Mermaid chunk (entry for `src/app/assets/mermaid.js`).
//
// Nothing imports this module statically: `features/reader/mermaid-lazy.js` dynamic-`import()`s
// the built asset, so these bytes leave the first screen and the deferred bundles entirely and
// are only fetched by a document that has a mermaid fence. The styling travels with the chunk
// for the same reason.
//
// Engine: `pele` (github.com/obsidianmd/pele), the Mermaid-to-SVG renderer Obsidian ships. It is
// synchronous, has no runtime dependencies and draws from CSS variables, so the chunk carries one
// engine instead of Mermaid plus its diagram/layout dependency tree, and theming follows the
// vault theme instead of the old dark inversion filter.
//
// Width: a diagram is not held to the article text column. It gets the same symmetric gutter
// growth the Reader already gives a wide table (`document/table-overflow-geometry.js`), so a wide
// diagram bleeds into the gutters that really exist instead of being squeezed into the column;
// whatever is still wider than the pane is panned and zoomed inside its own box.
//
// Interaction (Web-only; Desktop has no equivalent): the wheel over the diagram zooms it (no
// modifier needed, centred on the cursor), holding the left button drags it around, double click
// and `0` reset it, `+` / `-` zoom from the keyboard, and a fullscreen toggle. This is our own
// viewport controller, not Pele's zoom layer: that one refuses to pan until the drawing has been
// enlarged and only zooms with Ctrl/⌘ held, which is the opposite of what the owner asked for.
import { mount } from "pele";
import {
  TABLE_PANE_SAFETY,
  computeTableOverflowGeometry,
  nearestInlineClipBounds,
} from "../document/table-overflow-geometry.js";

const STYLE_ID = "mermaid-surface-style";
const EXPAND_LABEL = "全屏查看图表";
const COLLAPSE_LABEL = "退出全屏";
const ZOOM_IN_LABEL = "放大";
const ZOOM_OUT_LABEL = "缩小";
const RESET_LABEL = "重置缩放";
// Phase 1 draws at the diagram's own natural width so the block can be sized like a table
// before the real, width-adapted drawing happens.
const NATURAL_WIDTH = 1e9;
// 1 is the fitted drawing: the widest it can be inside its block without overflowing.
const MIN_SCALE = 1;
const MAX_SCALE = 6;
// One mouse notch is ~100 deltaY, i.e. about 1.16x; a trackpad sends many small steps.
const WHEEL_RATE = 0.0015;
const KEY_STEP = 1.25;

if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    // The Web base layer has no `--font-mermaid`; Desktop declares it at :root.
    ":root{--font-mermaid:var(--font-text)}",
    // The block bleeds into the measured gutters exactly like `.table-scroll` does.
    ".mermaid{position:relative;box-sizing:border-box;width:calc(100% + 2 * var(--mermaid-extension,0px));",
    "max-width:none;margin:1em calc(-1 * var(--mermaid-extension,0px));padding:0;overflow:hidden}",
    ".mermaid > svg{display:block;margin:0 auto}",
    // The drawing keeps the block's width and its own aspect at every zoom level, so enlarging it
    // never reflows the note; only what it shows changes. Grab is the drag affordance.
    ".mermaid-canvas{cursor:grab;-webkit-user-select:none;user-select:none}",
    ".mermaid-canvas.is-dragging{cursor:grabbing}",
    // Pele draws from these variables, so one mapping themes every diagram type.
    ".mermaid{--pele-bg:transparent;--pele-fg:var(--text-normal);--pele-muted:var(--text-muted);",
    "--pele-line:var(--text-muted);--pele-surface:var(--background-secondary);",
    "--pele-surface-alt:var(--background-secondary-alt,var(--background-secondary));",
    "--pele-border:var(--background-modifier-border);--pele-accent:var(--text-accent);",
    "--pele-font:var(--font-mermaid);--pele-radius:var(--radius-s,4px)}",
    // The tool bar (zoom in / out / reset) and the fullscreen toggle share the top-right corner.
    ".mermaid-tools{position:absolute;top:8px;right:8px;z-index:2;display:flex;flex-direction:column;",
    "gap:2px;padding:2px;border:1px solid var(--background-modifier-border);",
    "border-radius:var(--radius-s,4px);background:var(--background-primary)}",
    ".mermaid-tools button{appearance:none;display:grid;place-items:center;width:24px;height:24px;",
    "margin:0;padding:0;border:0;border-radius:var(--radius-s,4px);background:transparent;",
    "color:var(--text-muted);font:inherit;line-height:0;cursor:pointer}",
    ".mermaid-tools button:hover:not(:disabled){color:var(--text-normal);",
    "background:var(--background-modifier-hover)}",
    ".mermaid-tools button:disabled{opacity:.35;cursor:default}",
    ".mermaid:fullscreen{--mermaid-extension:0px;width:100%;height:100%;margin:0;padding:8px;",
    "overflow:hidden;background:var(--background-primary)}",
    ".mermaid:fullscreen > svg{max-width:100%;max-height:100%}",
    // Web-only fallback face: the block itself is kept, so the failure has to be visible.
    ".mermaid-error{margin:0 0 4px;color:var(--text-error,var(--color-red));font-size:var(--font-ui-smaller)}",
  ].join("");
  document.head.appendChild(style);
}


// The Reader's wide-table rule, applied to a diagram: grow symmetrically into the real gutters
// between the text column and the nearest inline clipping pane (never under a sidebar), capped at
// half of what the natural drawing needs. Whatever the gutters cannot take stays inside the box,
// where the zoom layer can pan it.
function applyTableParityWidth(host, column, naturalWidth) {
  if (host.dataset.mermaidWidth === "set" || !naturalWidth || !column?.getBoundingClientRect) return;
  const columnRect = column.getBoundingClientRect();
  const columnWidth = Number(columnRect.width) || 0;
  if (!columnWidth) return;
  const clip = nearestInlineClipBounds(host, {
    left: columnRect.left,
    right: columnRect.left + columnWidth,
    width: columnWidth,
  });
  const geometry = computeTableOverflowGeometry(naturalWidth, columnWidth, clip.width, {
    paneLeft: clip.left,
    paneRight: clip.right,
    columnLeft: columnRect.left,
    columnRight: columnRect.left + columnWidth,
    safety: TABLE_PANE_SAFETY,
  });
  host.style.setProperty("--mermaid-extension", `${geometry.extension}px`);
  host.dataset.mermaidWidth = "set";
  host.dataset.mermaidOverflow = geometry.overflow ? "true" : "false";
}

// Exactly one rule decides what the drawing shows: the SVG viewBox. Scale 1 is the fitted
// drawing (viewBox = the diagram's own box, element width 100%, height from the drawing's
// aspect), so enlarging it never reflows the note - only the visible region changes. Zoom is
// centred on the cursor, panning is a drag of the left button, and both clamp to the drawing's
// own edges, which is why a fitted drawing does not move: there is nothing outside it yet.
function createViewport(host, doc) {
  const natural = { width: 0, height: 0 };
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let pointerId = null;
  let last = { x: 0, y: 0 };
  let travelled = 0;
  let suppressClick = false;
  let listeners = [];
  const changes = [];

  const round = (value) => Math.round(value * 100) / 100;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const svg = () => host.querySelector("svg");
  const viewWidth = () => natural.width / scale;
  const viewHeight = () => natural.height / scale;

  function apply() {
    const drawing = svg();
    if (!drawing || !natural.width || !natural.height) return;
    const width = viewWidth();
    const height = viewHeight();
    // A drawing larger than the box stops at its own edges, never past them.
    offsetX = clamp(offsetX, 0, Math.max(0, natural.width - width));
    offsetY = clamp(offsetY, 0, Math.max(0, natural.height - height));
    drawing.setAttribute("viewBox", `${round(offsetX)} ${round(offsetY)} ${round(width)} ${round(height)}`);
    for (const listener of changes) listener({ scale, atFit: scale <= MIN_SCALE * 1.001 });
  }

  // Re-reads the drawing after every render (Pele replaces the SVG on a re-layout, e.g. on
  // entering fullscreen) and rests at the fitted view.
  function sync() {
    const drawing = svg();
    natural.width = Number(drawing?.getAttribute("width")) || 0;
    natural.height = Number(drawing?.getAttribute("height")) || 0;
    reset();
  }

  function reset() {
    scale = MIN_SCALE;
    offsetX = 0;
    offsetY = 0;
    apply();
  }

  // Keeps the point under (clientX, clientY) where it is while the scale changes.
  function zoomAt(factor, clientX, clientY) {
    const drawing = svg();
    if (!drawing || !natural.width) return;
    const box = drawing.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - scale) < 1e-4) return;
    const fractionX = clamp((clientX - box.left) / box.width, 0, 1);
    const fractionY = clamp((clientY - box.top) / box.height, 0, 1);
    const pointX = offsetX + fractionX * viewWidth();
    const pointY = offsetY + fractionY * viewHeight();
    scale = next;
    offsetX = pointX - fractionX * viewWidth();
    offsetY = pointY - fractionY * viewHeight();
    apply();
  }

  function zoomCentre(factor) {
    const box = svg()?.getBoundingClientRect?.();
    if (!box) return;
    zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2);
  }

  const sameTarget = (event) => {
    const target = event.target;
    // The tool bar sits inside the block and keeps its own clicks: never a pan or a zoom.
    if (target instanceof globalThis.Element && target.closest?.(".mermaid-tools")) return false;
    return target instanceof globalThis.Node ? host.contains(target) : false;
  };

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  // The wheel over a drawing is the drawing's, not the page's: it zooms, no modifier needed.
  on(host, "wheel", (event) => {
    if (!sameTarget(event) || !natural.width) return;
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * WHEEL_RATE), event.clientX, event.clientY);
  }, { passive: false });

  on(host, "pointerdown", (event) => {
    if (!sameTarget(event) || event.button !== 0 || !natural.width) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    travelled = 0;
    last = { x: event.clientX, y: event.clientY };
    host.classList.add("is-dragging");
    try { host.setPointerCapture?.(event.pointerId); } catch { /* capture is an optimisation */ }
  });

  on(host, "pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const box = svg()?.getBoundingClientRect?.();
    if (!box?.width || !box?.height || !natural.width) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    last = { x: event.clientX, y: event.clientY };
    travelled += Math.abs(dx) + Math.abs(dy);
    if (event.cancelable) event.preventDefault();
    offsetX -= dx * (viewWidth() / box.width);
    offsetY -= dy * (viewHeight() / box.height);
    apply();
  });

  const endDrag = (event) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    dragging = false;
    host.classList.remove("is-dragging");
    try { host.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    pointerId = null;
    // The click a drag ends with belongs to the drag, not to a link inside the drawing. The
    // window is one task, so a later and unrelated click is never swallowed.
    if (travelled > 4) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
  };
  on(host, "pointerup", endDrag);
  on(host, "pointercancel", endDrag);

  // A drag that ends over a diagram link is not a click on it.
  on(host, "click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  on(host, "dblclick", (event) => {
    if (!sameTarget(event) || !natural.width) return;
    event.preventDefault();
    if (scale > MIN_SCALE * 1.001) reset();
    else zoomAt(2, event.clientX, event.clientY);
  });

  on(host, "keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !natural.width) return;
    const key = event.key;
    if (key === "+" || key === "=") zoomCentre(KEY_STEP);
    else if (key === "-" || key === "_") zoomCentre(1 / KEY_STEP);
    else if (key === "0" || key === "Escape") reset();
    else return;
    event.preventDefault();
  });

  host.tabIndex = 0;

  return {
    sync,
    reset,
    zoomIn: () => zoomCentre(KEY_STEP),
    zoomOut: () => zoomCentre(1 / KEY_STEP),
    get scale() { return scale; },
    onChange(listener) {
      changes.push(listener);
      listener({ scale, atFit: scale <= MIN_SCALE * 1.001 });
    },
    destroy() {
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
      listeners = [];
      host.removeAttribute("tabindex");
    },
  };
}

const TOOL_ICONS = {
  zoomIn: '<path d="M5 12h14M12 5v14"/>',
  zoomOut: '<path d="M5 12h14"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
};

function toolButton(doc, name, label) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `mermaid-${name === "zoomIn" ? "zoom-in" : name === "zoomOut" ? "zoom-out" : name}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + TOOL_ICONS[name] + "</svg>";
  return button;
}

// The tool bar is ours because the viewport is: zoom in, zoom out, reset, fullscreen.
function addTools(host, doc, viewport) {
  const existing = host.querySelector(".mermaid-tools");
  if (existing) return existing;
  const bar = doc.createElement("div");
  bar.className = "mermaid-tools";
  const zoomIn = toolButton(doc, "zoomIn", ZOOM_IN_LABEL);
  const zoomOut = toolButton(doc, "zoomOut", ZOOM_OUT_LABEL);
  const reset = toolButton(doc, "reset", RESET_LABEL);
  zoomIn.addEventListener("click", (event) => { event.preventDefault(); viewport.zoomIn(); });
  zoomOut.addEventListener("click", (event) => { event.preventDefault(); viewport.zoomOut(); });
  reset.addEventListener("click", (event) => { event.preventDefault(); viewport.reset(); });
  bar.append(zoomIn, zoomOut, reset);

  if (typeof host.requestFullscreen === "function") {
    const expand = toolButton(doc, "expand", EXPAND_LABEL);
    expand.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (doc.fullscreenElement === host) {
        void doc.exitFullscreen?.();
        return;
      }
      // A browser that refuses fullscreen (embedded frame, policy) must not leave the toggle
      // claiming a state it does not have; the promise is the only signal there is.
      const entered = host.requestFullscreen?.();
      if (entered && typeof entered.catch === "function") entered.catch(() => {});
    });
    doc.addEventListener("fullscreenchange", () => {
      const active = doc.fullscreenElement === host;
      const label = active ? COLLAPSE_LABEL : EXPAND_LABEL;
      expand.setAttribute("aria-label", label);
      expand.title = label;
    });
    bar.append(expand);
  }

  viewport.onChange(({ atFit }) => {
    zoomOut.disabled = atFit;
    reset.disabled = atFit;
  });
  host.append(bar);
  return bar;
}

/**
 * Renders one fence into the document and replaces its `<pre>`.
 *
 * Contract with `mermaid-lazy.js`: the `<pre>` is only removed once a drawing exists. A diagram
 * Pele cannot draw throws before anything is replaced, so the gate keeps the source block and
 * adds its visible failure line - the reader never loses the text it could not draw.
 */
export function renderFence(pre, code, doc = document) {
  const text = String(code.textContent ?? "").replace(/\n$/u, "");
  if (!text.trim()) throw new Error("empty diagram");
  const column = pre.parentNode;
  const host = doc.createElement("div");
  host.setAttribute("class", "mermaid");
  host.setAttribute("data-mermaid-host", "");
  const viewport = createViewport(host, doc);
  // Pele namespaces its own SVG ids per mount (its `idPrefix`), so two diagrams that use the same
  // node names cannot collide inside one document. The engine's own zoom layer is off (`zoom:
  // false`): the viewport above owns pan and zoom. This hook re-syncs it after a re-layout (which
  // replaces the SVG) and re-adds the tool bar, which every re-render wipes with the drawing.
  const options = {
    zoom: false,
    onRender: () => {
      viewport.sync();
      addTools(host, doc, viewport);
    },
  };
  // The host is inserted before the fence, so a failed drawing can be rolled back without the
  // reader losing its source block or its position in the document.
  pre.before(host);
  let mounted = null;
  try {
    // Phase 1: draw at the diagram's natural width, which is what sizes the block.
    mounted = mount(host, text, { ...options, maxWidth: NATURAL_WIDTH });
    if (mounted.error) throw mounted.error;
    const naturalWidth = Number(host.querySelector("svg")?.getAttribute("width")) || 0;
    applyTableParityWidth(host, column, naturalWidth);
    // Phase 2: draw again, this time adapted to the block's real width.
    mounted.update(text, options);
    if (mounted.error) throw mounted.error;
  } catch (error) {
    try {
      viewport.destroy();
      mounted?.destroy?.();
    } finally {
      host.remove();
    }
    throw error;
  }
  pre.remove();
}
