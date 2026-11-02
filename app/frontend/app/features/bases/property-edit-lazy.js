// The eager half of the property page: the gate only.
//
// Same contract as `kanban-lazy.js` / the Mermaid gate: the page implementation ships as an
// ON-DEMAND asset (`src/app/assets/property-edit.js`, built from `property-edit-runtime.js`), the
// shell publishes its versioned URL as `data-property-edit-src`, and this module holds what the
// always-loaded bundle still needs — the URL lookup, the panel the stack mounts, and a fail-closed
// line for "the chunk did not arrive".
//
// Deliberately small: the ratchet is on the bundle this file lives in. No import cache (the ES
// module map dedups by URL — see the kanban gate's note).
//
// The shell owns a BODY node (`panelScroll`) that the chunk fills and the failure line reuses, so
// the panel keeps what the panel chrome put around it: the header (back `‹` / close `✕`) and the
// `.base-panel` skin. Clearing the whole panel instead left a bare line floating over the table
// with no way out except Escape (review D4).
import { panelScroll, panelShell } from "./panel-chrome.js";

const CHUNK_ATTR = "data-property-edit-src";

export const PROPERTY_EDIT_LOAD_ERROR_TEXT = "This property page could not be loaded.";

/** The versioned chunk URL the shell published; "" when the shell predates this slice. */
export function propertyEditChunkUrl(doc) {
  return doc?.querySelector?.("script[data-property-edit-src]")?.getAttribute(CHUNK_ATTR) || "";
}

/**
 * The page's shell plus the promise that fills it.
 *
 * The panel is returned SYNCHRONOUSLY (the pages menu mounts it and the panel chrome prepends the
 * header before anything async can happen), so the shell must survive the chunk arriving: the
 * chunk fills the BODY this shell already has. A missing or failing chunk is fail-closed with a
 * visible `[data-prop-edit-error]` line inside that same body — never a silently empty page, never
 * a chrome-less fragment, never a fallback to another surface. Re-opening the page retries,
 * because the shell is rebuilt from scratch.
 */
export function buildPropertyEditPageLazily({ doc, entry, width, transport, url, load } = {}) {
  const panel = panelShell(doc, "properties-edit", String(entry?.label ?? entry?.key ?? ""));
  // The pushed page keeps the menu's own width, in EVERY state — including "the chunk never
  // arrived", where the content is only an error line (coordinator R1 #1).
  if (Number(width) > 0) {
    panel.style.width = `${Math.round(Number(width))}px`;
    panel.setAttribute("data-prop-edit-width", String(Math.round(Number(width))));
  }
  const body = panelScroll(doc);
  panel.appendChild(body);
  panel.setAttribute("data-prop-edit-loading", "");
  const done = (async () => {
    try {
      const href = url || propertyEditChunkUrl(doc);
      // One request per URL per page: the ES module map dedups, so there is no cache here.
      const runtime = href ? await (typeof load === "function" ? load : (target) => import(target))(href) : null;
      if (!runtime || typeof runtime.fillPropertyPage !== "function") throw new Error("chunk-unavailable");
      return runtime.fillPropertyPage(panel, { doc, entry, width, transport });
    } catch {
      panel.removeAttribute("data-prop-edit-loading");
      const error = doc.createElement("div");
      // `base-panel-section` is reused for its existing 2px inset: the first screen is a signed
      // byte ratchet, so the failure state borrows a rule instead of adding one.
      error.className = "base-panel-error base-panel-section";
      error.setAttribute("role", "alert");
      error.setAttribute("data-prop-edit-error", "");
      error.textContent = PROPERTY_EDIT_LOAD_ERROR_TEXT;
      // Only the BODY is replaced: the panel's own box (background, border, padding) and the
      // header the chrome mounted stay exactly where they were.
      body.replaceChildren(error);
      return panel;
    }
  })();
  return { panel, done };
}
