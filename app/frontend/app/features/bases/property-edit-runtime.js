// The on-demand property page — esbuild ESM entry (`src/app/assets/property-edit.js`).
//
// Coordinator R1 §1: shipping the page eagerly costs ~7 kB gzip on the first screen, which the
// ratchet refuses. Same shape as `kanban-runtime.js` / `canvas.js` / `mermaid.js`: the shell
// publishes this asset's versioned URL as `data-property-edit-src`, `property-edit-lazy.js` (the
// eager gate) dynamic-imports it the first time a reader clicks a row's `›`, and everything the
// page needs — the form DOM, the write request, the type labels and the CSS — lives here, off the
// critical path.
//
// `property-write.js` is bundled here too: the PATCH (its mutation, its `ifMatch`, its 428/409
// vocabulary) is only ever used by this page.
import { fillPropertyEditPage, propertyEditTitle } from "./panel-property-edit.js";
import { createPropertyWriter } from "./property-write.js";
import { propertyEditTranslator } from "./property-edit-i18n.js";

// The page's CSS travels with the page (kanban's `injectKanbanStyles` precedent): same rules and
// same rationale as the R1 fix, but paid for only when the page is opened.
export const PROPERTY_EDIT_CSS = [
  ".base-panel-form{display:flex;flex-direction:column;gap:var(--size-4-2);padding:var(--size-4-2);box-sizing:border-box;min-width:0;}",
  ".base-panel-form-row{display:flex;flex-direction:column;gap:var(--size-2-1);min-width:0;}",
  ".base-panel-form-label{color:var(--text-muted);font-size:var(--font-ui-small);}",
  ".base-panel-form-content{min-width:0;}",
  ".base-panel-form .base-panel-input,.base-panel-form .base-panel-select{width:100%;box-sizing:border-box;flex:0 0 auto;}",
  ".base-panel-note{margin:0;color:var(--text-muted);font-size:var(--font-ui-smaller);line-height:1.4;}",
];

const STYLE_ID = "base-property-edit-styles";

/** Attach the page's CSS once per document. */
export function injectPropertyEditStyles(doc) {
  if (!doc || doc.getElementById?.(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PROPERTY_EDIT_CSS.join("");
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

/**
 * Fill the gate's shell with the real page.
 *
 * `transport` is only what the eager side may know about the document — the request function, the
 * base path, the current revision, and two callbacks. The write itself (mutation shape, `ifMatch`,
 * 428 vs 409) stays in this chunk.
 */
export function fillPropertyPage(panel, { doc, entry, width, transport } = {}) {
  injectPropertyEditStyles(doc);
  // The gate owns the panel and its header; this fills the body it created (`panelScroll`), so a
  // page arriving after the header was mounted never tears the chrome down.
  const body = panel.querySelector?.("[data-base-panel-scroll]") ?? null;
  if (body) body.replaceChildren();
  const t = propertyEditTranslator(doc);
  // The write goes through `createPropertyWriter`, the ONLY path that adopts a 409's
  // `currentRevision` (review D1: the previously exported writer had no production call site, so
  // the behaviour its unit test pinned never reached the page). The adapter is the transport the
  // eager side hands over — a plain state object with `path` / `revision`, plus the two callbacks.
  const state = {
    get path() { return transport?.path?.(); },
    get revision() { return transport?.revision?.(); },
    set revision(value) { transport?.onRevision?.(value); },
  };
  const write = createPropertyWriter({
    fetchImpl: () => transport?.fetch,
    state,
    reload: () => transport?.reload?.(),
    copy: {
      precondition: t("bases.property.precondition"),
      staleAdopted: t("bases.property.staleAdopted"),
      staleLost: t("bases.property.staleLost"),
    },
  });
  const filled = fillPropertyEditPage(panel, {
    doc,
    entry,
    width,
    transport,
    onSubmit: ({ property, value }) => write({ property, value }),
  });
  // The title belongs to the chunk (its strings are not on the first screen), so the gate's
  // placeholder label is replaced here — the header's back label follows it.
  const title = propertyEditTitle(doc, entry);
  filled.setAttribute("aria-label", title);
  const back = filled.querySelector?.(".base-panel-back-label");
  if (back) back.textContent = title;
  filled.removeAttribute("data-prop-edit-loading");
  // Desktop `onShow`: `.autoSelect()` — the value is selected, so typing replaces the whole name.
  const input = filled.querySelector?.("[data-prop-display-name]");
  if (input && typeof input.focus === "function") {
    input.focus();
    if (typeof input.select === "function") input.select();
  }
  return filled;
}

export { propertyEditTranslator };
