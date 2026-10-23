// U38 (#571): the sprite is answered under the one-year `immutable` asset policy, so a
// reference without the published content hash pins the symbol set for a year — that is the
// #568 blank white box. The shell publishes that URL on `<html data-icon-sprite="…">` (built
// by `src/app/pages.js` from the same `assetUrl("icons.svg")` hash as the SSR references), and
// this module is the single resolver every icon call site goes through.
export const ICON_SPRITE_ATTR = "data-icon-sprite";
// Only reachable where no page published the attribute (the Node view harness). It keeps the
// glyph drawing instead of silently disappearing; `web-firstload-budget` asserts that every
// served page publishes the versioned URL, so production never takes this branch.
const FALLBACK_SPRITE = "/app/assets/icons.svg";
const SVG_NS = "http://www.w3.org/2000/svg";

export function iconHref(doc, name) {
  const root = doc?.documentElement ?? doc?.ownerDocument?.documentElement;
  return `${root?.getAttribute?.(ICON_SPRITE_ATTR) || FALLBACK_SPRITE}#${name}`;
}

// The one `<svg><use>` builder; returns null on DOM implementations without SVG support
// (the Node view harness) so callers can degrade to text-only.
export function spriteIcon(doc, name, className = "svg-icon") {
  if (typeof doc?.createElementNS !== "function") return null;
  const svg = doc.createElementNS(SVG_NS, "svg");
  const use = doc.createElementNS(SVG_NS, "use");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", iconHref(doc, name));
  svg.append(use);
  return svg;
}

export function icon(name, className = "svg-icon") {
  return spriteIcon(document, name, className);
}

export function iconHtml(name, className = "svg-icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="${iconHref(document, name)}"></use></svg>`;
}
