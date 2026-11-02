// Tiny DOM helpers shared by the Base toolbar and its panels. Everything goes
// through createElement/textContent: no module in features/bases/ may use an HTML
// sink (surface contract, WB-10).

import { createSpriteIcon } from "./cell.js";

export function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function spriteIcon(doc, name, className) {
  return createSpriteIcon(doc, name, className ? `svg-icon ${className}` : "svg-icon");
}

// A themed `<select>`; `data-select` opts it into the app's custom dropdown.
export function buildSelect(doc, { className, options = [], value = null, attributes = {}, focusKey = null } = {}) {
  const select = doc.createElement("select");
  if (className) select.className = className;
  select.setAttribute("data-select", "");
  if (focusKey) select.setAttribute("data-focus", focusKey);
  for (const [name, attributeValue] of Object.entries(attributes)) select.setAttribute(name, attributeValue);
  for (const option of options) {
    const node = doc.createElement("option");
    node.value = String(option.value);
    node.textContent = String(option.label ?? option.value);
    if (option.attributes) {
      for (const [name, attributeValue] of Object.entries(option.attributes)) node.setAttribute(name, attributeValue);
    }
    if (value !== null && String(option.value) === String(value)) node.selected = true;
    select.appendChild(node);
  }
  if (value !== null) select.value = String(value);
  return select;
}
