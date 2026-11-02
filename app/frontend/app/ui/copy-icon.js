// Inline copy / check glyphs for the code-block copy affordance.
//
// Why these are inlined instead of using the shared sprite (`ui/icons.js` →
// `/app/assets/icons.svg#copy`): that URL is built by hand and carries **no
// version query** (the 53 unversioned sprite refs `web-firstload-budget` tracks
// as U38), while the asset server answers it with
// `Cache-Control: public, max-age=31536000, immutable`. A browser that cached the
// sprite before a symbol existed therefore keeps that copy for a year, and the
// button rendered as an empty box on top of its own box outline — the owner
// report of 2026-10-17, reproduced first-hand in
// `worktrees/desktop-re/copy-icon-hotfix/evidence/` (`use` resolves to a 0×0 bbox
// once the pre-#550 sprite is replayed). An affordance that must always be visible
// cannot depend on a URL that cannot be invalidated, so this one carries its own
// geometry.
//
// The shapes are the lucide `copy` / `check` geometry, drawn on a 24×24 viewBox
// so the existing `.svg-icon` contract (`fill: none; stroke: currentColor;
// stroke-width: 1.8`) paints them exactly like every sprite icon in the app.
const SVG_NS = "http://www.w3.org/2000/svg";

function glyph(className, shapes) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}

/** lucide `copy` — the two stacked sheets. */
export function copyGlyph(className = "svg-icon") {
  return glyph(className, [
    ["rect", { x: "8", y: "8", width: "14", height: "14", rx: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ]);
}

/** lucide `check` — the copied state. */
export function checkGlyph(className = "svg-icon") {
  return glyph(className, [["path", { d: "m5 12 5 5L20 7" }]]);
}
