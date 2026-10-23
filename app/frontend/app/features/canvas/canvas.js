// Canvas document entry (G11): the only client file that renders a `.canvas`.
//
// On-demand by construction: the asset is referenced exclusively by the canvas
// document page (src/app/pages.js publishes it as a `<script type="module">` only
// when the page really carries an `initial-canvas-path`), so a workspace page,
// note page or Base page never requests it - that is the zero-request evidence in
// the lane HANDOFF (0 requests without a `.canvas`, exactly 1 with).
//
// It deliberately does not live inside app.js/reader.js/editor.js: those bundles
// are inside the first-screen/deferred byte ratchets, which this lane may not
// raise (RECON §6 刀2). Everything the surface needs - the API call, the geometry,
// the DOM and its CSS - ships in this one asset, and the CSS is injected from here
// so app.css stays byte-identical.
//
// Desktop evidence behind what is drawn: node rect `{x,y,width,height}` and the
// four node kinds `text|file|group|link` (@3370292, @3418436), edges
// `{id,fromNode,fromSide,toNode,toSide}` (@3406852). Read-only: no editing, no
// PNG export (RECON §3 G13 explicitly lists both as non-goals).
import { CANVAS_SURFACE_CSS, mountCanvasSurface, renderCanvasError } from "./surface.js";

const CANVAS_MESSAGES = {
  "not-a-canvas": "这个文件不是画布（缺少 nodes 数组）。",
  "invalid-json": "画布文件不是有效的 JSON。",
  "canvas-not-found": "画布文件不存在或不可访问。",
  "canvas-too-large": "画布文件超出可读取的大小上限。",
};

export function canvasApiUrl(target) {
  return `/api/web/v1/canvas?path=${encodeURIComponent(target.path)}`;
}

/** The page contract: datas on the module script, metas as the fallback. */
export function readCanvasTarget(doc = globalThis.document) {
  if (!doc?.querySelector) return null;
  const script = doc.querySelector("script[data-canvas-path]");
  const path = script?.getAttribute("data-canvas-path")
    || doc.querySelector('meta[name="initial-canvas-path"]')?.getAttribute("content")
    || "";
  if (!path) return null;
  const vaultId = script?.getAttribute("data-canvas-vault")
    || doc.querySelector('meta[name="initial-canvas-vault"]')?.getAttribute("content")
    || null;
  return { path, vaultId };
}

export function injectCanvasStyles(doc = globalThis.document) {
  if (!doc?.createElement || !doc.head) return null;
  if (doc.querySelector("style[data-canvas-surface]")) return null;
  const style = doc.createElement("style");
  style.setAttribute("data-canvas-surface", "");
  style.textContent = CANVAS_SURFACE_CSS;
  doc.head.append(style);
  return style;
}

// The document pane is shared with the note surface (the shell owns it). Opening a
// note from the tree must therefore drop the canvas overlay instead of covering
// the note: the tab strip is the app's own signal that a document was committed.
export function watchDocumentSwitch({ doc = globalThis.document, host, onSwitch = () => {} } = {}) {
  const tabs = doc?.getElementById?.("document-tabs");
  if (!tabs || typeof MutationObserver !== "function") return () => {};
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.addedNodes?.length) {
        host.hidden = true;
        onSwitch();
        return;
      }
    }
  });
  observer.observe(tabs, { childList: true });
  return () => observer.disconnect();
}

/**
 * Loads the document and mounts it. Never rejects: an unavailable API or a
 * non-canvas file leaves a visible status line in the host.
 */
export async function openCanvasDocument({ doc = globalThis.document, fetchImpl = globalThis.fetch, host, target = readCanvasTarget(doc) } = {}) {
  if (!host || !target) return { ok: false, reason: "no-target" };
  injectCanvasStyles(doc);
  let payload = null;
  let failure = null;
  try {
    const response = await fetchImpl(canvasApiUrl(target), { headers: { Accept: "application/json" }, credentials: "same-origin" });
    if (!response?.ok) {
      const body = await response?.json?.().catch(() => null);
      failure = String(body?.error || "");
    } else {
      payload = await response.json();
    }
  } catch {
    failure = "";
  }
  if (!payload) {
    renderCanvasError({ host, doc, message: CANVAS_MESSAGES[failure] || "画布加载失败。" });
    return { ok: false, reason: failure || "request-failed" };
  }
  const tally = mountCanvasSurface({ host, document: payload, doc });
  return { ok: true, ...tally, path: payload.path ?? target.path };
}

// Page bootstrap: only a page that publishes the canvas contract runs this, and it
// is a no-op (with no request) on every other page.
if (typeof globalThis.document !== "undefined" && globalThis.document?.getElementById) {
  const bootstrap = () => {
    const target = readCanvasTarget(globalThis.document);
    const host = globalThis.document.getElementById("canvas-host");
    if (!target || !host) return;
    globalThis.document.documentElement.setAttribute("data-canvas-document", "");
    injectCanvasStyles(globalThis.document);
    watchDocumentSwitch({ doc: globalThis.document, host, onSwitch: () => globalThis.document.documentElement.removeAttribute("data-canvas-document") });
    void openCanvasDocument({ doc: globalThis.document, host, target });
  };
  if (globalThis.document.readyState === "loading") globalThis.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  else bootstrap();
}

export { mountCanvasSurface, renderCanvasError, CANVAS_SURFACE_CSS };
