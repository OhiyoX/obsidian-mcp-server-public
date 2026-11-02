// The property page of the Bases action menu — `编辑 {{name}}` (lane desktop-re/bases-property-submenu).
//
// This module is NOT in the first-screen bundle: `property-edit-runtime.js` is the esbuild entry
// that carries it into `src/app/assets/property-edit.js`, loaded by `property-edit-lazy.js` the
// first time a reader clicks a row's `›` (coordinator R1 §1: the page costs ~7 kB gzip, which the
// first-screen ratchet refuses). Its copy comes from `property-edit-i18n.js` for the same reason.
import { propertyEditTranslator } from "./property-edit-i18n.js";
import { el, spriteIcon } from "./dom.js";
import { panelContainer, panelScroll, panelShell } from "./panel-chrome.js";

// ── The property page (`编辑 {{name}}`) ────────────────────────────────────────
//
// Desktop: `PJ.showEditPage` pushes `new IJ(host, queryController, propId, false)` onto the SAME
// page stack (asar app.js@2483200), and `IJ` is a page, not a popup: its title is
// `titleEditProperty({name})` — 编辑 {{name}} — its back button is the stack's own back
// (`@2485669`), and its body is a `bases-toolbar-menu-form` of `input-row`s.
//
//   * 显示名称 (`labelDisplayName`, @2486663): `input-row` > `input-row-label` +
//     `input-row-content` > TextComponent with the property NAME as placeholder, the current
//     display name as value and `.autoSelect()` (the owner's screenshot: `status` selected).
//     Blur commits, Enter blurs (so it commits), Escape reverts the field (@2486700).
//   * 属性类型 (`labelPropertyType`, @2487693): built from `metadataTypeManager.registeredTypeWidgets`
//     — a VAULT-level table — and `onChange` calls `metadataTypeManager.setType(name, type)`, i.e.
//     it does NOT write `properties.<key>.type` into the `.base` (the property config recognises
//     `displayName` only, app.js@2347620). This service has no types write face, so the control is
//     the same box with the current type and is `disabled`; the note under it says so. Inventing a
//     `.base` field the desktop ignores would be worse than a visibly read-only control.
//   * `⋮`: the desktop's page action menu (`showActions`, @2487960) holds 隐藏属性/显示属性 and, for
//     a formula row, 删除公式. Not ported here yet (registered in the compatibility matrix); this
//     page reaches hide/show through the row checkbox the reader came from.
const PROPERTY_TYPE_LABELS = Object.freeze({
  text: "bases.property.typeText",
  number: "bases.property.typeNumber",
  date: "bases.property.typeDate",
  datetime: "bases.property.typeDatetime",
  checkbox: "bases.property.typeCheckbox",
  multitext: "bases.property.typeList",
  list: "bases.property.typeList",
  tags: "bases.property.typeTags",
});

export function propertyTypeLabel(type, t = propertyEditTranslator(globalThis.document)) {
  const key = PROPERTY_TYPE_LABELS[type];
  return key ? t(key) : String(type ?? "");
}

/** The page title the desktop gives this page: `编辑 {{name}}` (`titleEditProperty`, @2485969). */
export function propertyEditTitle(doc, entry) {
  const t = propertyEditTranslator(doc);
  const shown = entry?.displayName ?? entry?.label ?? entry?.key ?? "";
  return t("bases.property.edit", { name: shown });
}

/**
 * Fill an EXISTING panel with the page body. The eager gate owns the shell (so the panel's header
 * survives the chunk arriving), the chunk owns everything inside it.
 */
export function fillPropertyEditPage(panel, { doc, entry = null, width = null, onSubmit = null, onError = null, transport = null, context = null } = {}) {
  const t = propertyEditTranslator(doc);
  const key = String(entry?.key ?? "");
  // Desktop `getDisplayName()` (app.js@2347840): the declared display name, else the name itself.
  const shown = entry?.displayName ?? entry?.label ?? key;
  panel.setAttribute("data-prop-edit-page", key);
  // The menu this page was pushed from measured 223px; a form with a select in it sized itself at
  // 310px and the panel jumped 88px left (coordinator R1). Pin the measured width so the page is
  // laid out inside the same box, and `panel-position.js` keeps the same right edge.
  if (Number(width) > 0) {
    panel.style.width = `${Math.round(Number(width))}px`;
    panel.setAttribute("data-prop-edit-width", String(Math.round(Number(width))));
  }
  // The gate's shell already provides the scroll body (it must survive the chunk arriving, and the
  // failure line has to live in it — review D4); a caller without one gets a fresh node.
  const provided = panel.querySelector?.("[data-base-panel-scroll]") ?? null;
  const scroll = provided ?? panelScroll(doc);
  scroll.replaceChildren();
  // This page is built through `.bases-toolbar-menu-container` (app.js@2506194), like the list.
  const container = panelContainer(doc);
  scroll.appendChild(container);
  if (!provided) panel.appendChild(scroll);
  // `createDiv("bases-toolbar-menu-form")` (app.js@2486655) is the page's body column.
  const form = el(doc, "div", "base-panel-form bases-toolbar-menu-form");
  container.appendChild(form);

  const nameRow = el(doc, "div", "base-panel-form-row input-row");
  nameRow.appendChild(el(doc, "div", "base-panel-form-label input-row-label", t("bases.property.displayName")));
  const nameContent = el(doc, "div", "base-panel-form-content input-row-content");
  nameRow.appendChild(nameContent);
  form.appendChild(nameRow);

  const input = doc.createElement("input");
  input.className = "base-panel-input base-panel-form-input";
  input.type = "text";
  input.setAttribute("data-prop-display-name", key);
  input.setAttribute("data-focus", `prop-display-name-${key}`);
  input.setAttribute("aria-label", t("bases.property.displayName"));
  // `.setPlaceholder(c)` is the property NAME; `.setValue(...)` the display name, `.autoSelect()`.
  input.placeholder = key;
  input.value = shown;
  nameContent.appendChild(input);

  const error = el(doc, "p", "base-panel-error");
  error.setAttribute("data-prop-edit-error", "");
  error.setAttribute("role", "alert");
  error.hidden = true;
  nameContent.appendChild(error);

  let busy = false;
  // The value of the last submission: Enter calls `blur()` (desktop) and also commits directly, so
  // the same text must never be sent twice by the two paths.
  // The last submission that actually WENT OUT, keyed by <revision>|<value>: Enter calls `blur()`
  // (desktop) and also commits directly, so those two paths must not send the same write twice —
  // but a retry after a refused write is legitimate (review D1), and once the revision changed the
  // same text is a different attempt. Cleared on every failure.
  let lastSent = null;
  const revisionOf = () => String((context?.transport ?? transport)?.revision?.() ?? "");
  const commit = () => {
    const next = String(input.value ?? "").trim();
    // Desktop guard: `if (u !== a.getDisplayName(t))` — writing the name that is already shown is a
    // no-op, and an emptied field means "delete the key", not "store an empty string".
    const sendKey = `${revisionOf()}|${next}`;
    if (busy || !onSubmit || next === shown || sendKey === lastSent) return;
    lastSent = sendKey;
    busy = true;
    Promise.resolve(onSubmit({ property: key, value: next === "" ? null : next }))
      .then(() => {
        error.hidden = true;
      })
      .catch((cause) => {
        // A refused write is never remembered as "sent": the reader may hand the same text again
        // (after a 409 adopted a new revision, that attempt is a different write — review D1).
        lastSent = null;
        // Inline and the typed value stays (A.3): a stale revision must not cost the reader the text.
        error.textContent = cause?.message || t("bases.property.saveFailed");
        error.hidden = false;
      })
      .finally(() => {
        busy = false;
      });
  };
  input.onblur = commit;
  input.onkeydown = (event) => {
    if (event?.isComposing || event?.defaultPrevented) return;
    if (event?.key === "Enter") {
      event.preventDefault?.();
      commit();
      input.blur?.();
    } else if (event?.key === "Escape") {
      // Desktop: `i.value=c; i.blur()` — revert to the shown name, then commit (which no-ops).
      event.preventDefault?.();
      input.value = shown;
      input.blur?.();
    }
  };

  // 属性类型: only for a NOTE property (desktop `"note" === l`); a formula row shows the formula
  // editor and a built-in row shows nothing, so neither gets a box that would be pure decoration.
  if (entry && entry.kind !== "formula" && entry.source !== "builtin") {
    const typeRow = el(doc, "div", "base-panel-form-row input-row");
    typeRow.setAttribute("data-prop-type-row", "");
    typeRow.appendChild(el(doc, "div", "base-panel-form-label input-row-label", t("bases.property.type")));
    const typeContent = el(doc, "div", "base-panel-form-content input-row-content");
    typeRow.appendChild(typeContent);
    const select = doc.createElement("select");
    select.className = "base-panel-select base-panel-form-select";
    select.setAttribute("data-prop-type-select", key);
    select.setAttribute("data-focus", `prop-type-${key}`);
    select.setAttribute("aria-label", t("bases.property.type"));
    // The registered-type table is not addressable from this service (see the comment above): the
    // current type is shown on its own, and the control says what is missing instead of listing
    // options none of which could be written.
    const current = entry.declaredType ?? entry.kind ?? "text";
    const option = doc.createElement("option");
    option.value = current;
    option.textContent = propertyTypeLabel(current, t);
    select.appendChild(option);
    select.value = current;
    select.disabled = true;
    // One short line in the body, the whole reason in the control's `title`: the long sentence
    // wrapped onto two lines and squeezed the form (coordinator R1 #3).
    select.setAttribute("title", t("bases.property.typeUnverified"));
    typeContent.appendChild(select);
    const note = el(doc, "p", "base-panel-note", t("bases.property.typeReadOnly"));
    note.setAttribute("title", t("bases.property.typeUnverified"));
    typeContent.appendChild(note);
    form.appendChild(typeRow);
  }
  return panel;
}

/** `fillPropertyEditPage` on a fresh shell — the shape the unit tests and any eager caller use. */
export function buildPropertyEditPanel(_state, context, { entry = null, onSubmit = null, width = null } = {}) {
  const doc = context.doc;
  const panel = panelShell(doc, "properties-edit", propertyEditTitle(doc, entry));
  return fillPropertyEditPage(panel, { doc, entry, width, onSubmit });
}
