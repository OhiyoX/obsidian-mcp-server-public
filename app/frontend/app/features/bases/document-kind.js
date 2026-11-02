// Document-kind state (`null | "note" | "base"`) and the chrome switch between
// the Markdown document surfaces and the read-only Base surface.
//
// This module owns only visibility + control enablement. It never renders a
// Base table (features/bases/controller.js) and never touches the Markdown
// editor value or session. B4 wires it; A4's Base module stays independent.
//
// Contract: §10.1 (explicit documentKind), WB-04 (typed document), WB-09.

export const DOCUMENT_KIND_NOTE = "note";
export const DOCUMENT_KIND_BASE = "base";

// Deep-link target for `/app/base/<encoded-document-route>`.
//
// The B3 page contract ships a `<meta name="initial-base-path">` (and optional
// `initial-base-vault`). The encoded route already lives in `location.pathname`,
// so the surface can reuse it verbatim for history. `view` may come from `?view=`.
export function readInitialBaseTarget(doc, locationObject = globalThis.location) {
  if (!doc || typeof doc.querySelector !== "function") return null;
  const pathMeta = doc.querySelector('meta[name="initial-base-path"]');
  const path = metaContent(pathMeta);
  if (!path) return null;
  const vaultId = metaContent(doc.querySelector('meta[name="initial-base-vault"]')) || null;
  let route = null;
  let view = null;
  const pathname = locationObject?.pathname || "";
  const search = locationObject?.search || "";
  if (pathname) {
    try {
      const url = new URL(`${pathname}${search}`, locationObject?.origin || "http://localhost");
      route = url.pathname;
      view = url.searchParams.get("view");
    } catch {
      route = pathname;
    }
  }
  return { path, vaultId, route, view };
}

function metaContent(meta) {
  if (!meta) return null;
  if (typeof meta.getAttribute === "function") {
    const value = meta.getAttribute("content");
    if (value) return value;
  }
  return typeof meta.content === "string" && meta.content ? meta.content : null;
}

export function createDocumentKindController({
  state,
  documentHost,
  editorHost,
  preview,
  baseHost,
  controls = {},
  pathLabel = null,
  syncStatus = () => {},
} = {}) {
  let captured = null;
  let basePathText = null;

  // `controls` values may be single elements or arrays of elements.
  function controlList() {
    const list = [];
    for (const value of Object.values(controls)) {
      if (!value) continue;
      if (Array.isArray(value)) list.push(...value.filter(Boolean));
      else list.push(value);
    }
    return list;
  }

  function enterBase(pathText) {
    if (state.documentKind !== DOCUMENT_KIND_BASE) {
      const list = controlList();
      captured = {
        editorHidden: Boolean(editorHost?.hidden),
        previewHidden: Boolean(preview?.hidden),
        disabled: list.map((node) => Boolean(node.disabled)),
        // Markdown-only chrome (Save / view-mode / Publish / copy-link / status) is
        // hidden, not merely disabled, on a Base document (TODO §4.2, §15.7).
        hidden: list.map((node) => Boolean(node.hidden)),
        // The topbar path label shows the Base path while a Base is open; restore the
        // previous note label when the document returns to Markdown.
        pathLabelText: pathLabel ? String(pathLabel.textContent ?? "") : null,
      };
      state.documentKind = DOCUMENT_KIND_BASE;
    }
    if (pathLabel && pathText !== undefined && pathText !== null) {
      basePathText = String(pathText);
      pathLabel.textContent = basePathText;
    }
    if (baseHost) baseHost.hidden = false;
    if (editorHost) editorHost.hidden = true;
    if (preview) preview.hidden = true;
    documentHost?.classList?.add("mode-base");
    for (const node of controlList()) {
      node.disabled = true;
      node.hidden = true;
    }
  }

  function enterNote() {
    state.documentKind = state.path ? DOCUMENT_KIND_NOTE : null;
    if (baseHost) baseHost.hidden = true;
    documentHost?.classList?.remove("mode-base");
    if (captured) {
      if (editorHost) editorHost.hidden = captured.editorHidden;
      if (preview) preview.hidden = captured.previewHidden;
      const list = controlList();
      for (let index = 0; index < list.length; index += 1) {
        if (captured.disabled[index] !== undefined) list[index].disabled = captured.disabled[index];
        if (captured.hidden[index] !== undefined) list[index].hidden = captured.hidden[index];
      }
      // Only restore when the label still shows the Base path; a real note open
      // re-renders the breadcrumb first and must win.
      if (pathLabel && captured.pathLabelText !== null && basePathText !== null && pathLabel.textContent === basePathText) {
        pathLabel.textContent = captured.pathLabelText;
      }
      captured = null;
    }
    basePathText = null;
    syncStatus();
  }

  return {
    enterBase,
    enterNote,
    isBase: () => state.documentKind === DOCUMENT_KIND_BASE,
  };
}
