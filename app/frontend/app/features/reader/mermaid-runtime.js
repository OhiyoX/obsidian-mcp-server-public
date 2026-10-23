// The lazy Mermaid chunk (entry for `src/app/assets/mermaid.js`).
//
// Nothing imports this module statically: `features/reader/mermaid-lazy.js` dynamic-`import()`s
// the built asset, so these bytes leave the first screen and the deferred bundles entirely and
// are only fetched by a document that has a mermaid fence. The styling travels with the chunk
// for the same reason.
//
// Desktop evidence (Obsidian 1.14.4 asar): `--font-mermaid: var(--font-text)` (app.css@3202);
// `.theme-dark .mermaid > svg { filter: invert(100%) hue-rotate(180deg) saturate(1.25) }`
// (app.css@11875); `.markdown-source-view.mod-cm6 .cm-embed-block > .mermaid { overflow-x: auto }`
// (app.css@12543); the `mermaid.initialize(...)` call is copied option for option from app.js.
import mermaid from "mermaid";

const STYLE_ID = "mermaid-surface-style";

if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    // The Web base layer has no `--font-mermaid`; Desktop declares it at :root.
    ":root{--font-mermaid:var(--font-text)}",
    ".mermaid{overflow-x:auto}",
    ".theme-dark .mermaid > svg{filter:invert(100%) hue-rotate(180deg) saturate(1.25)}",
    // Web-only fallback face: the block itself is kept, so the failure has to be visible.
    ".mermaid-error{margin:0 0 4px;color:var(--text-error,var(--color-red));font-size:var(--font-ui-smaller)}",
  ].join("");
  document.head.appendChild(style);
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  themeVariables: { fontFamily: "var(--font-mermaid)" },
  flowchart: { useMaxWidth: false },
  sequence: { useMaxWidth: false },
  gantt: { useMaxWidth: true, axisFormatter: [["%Y-%m-%d", (date) => date.getDay() === 1]] },
  journey: { useMaxWidth: true },
  class: { useMaxWidth: true },
  git: { useMaxWidth: false },
  state: { useMaxWidth: true },
  er: { useMaxWidth: false },
  pie: { useMaxWidth: true },
});

export function render(id, text, container) {
  return mermaid.render(id, text, container);
}

/**
 * Desktop's `Oj()` (asar app.js): measure the fence's parent, render into a hidden `div.mermaid`
 * at that width, take the returned `svg` string, detach the shell, put the string into a fresh
 * `div.mermaid` and replace the fence's `<pre>` with it. Desktop then prefixes every marker id
 * with the render id so two diagrams on one page cannot share `url(#…)` references; the same loop
 * runs here. Desktop also rewrites internal-link labels and `href.baseVal` — the Web has no
 * wikilink syntax inside a diagram, so those two legs are deliberately absent (recorded).
 */
export async function renderFence(pre, code, doc = document) {
  const shell = doc.createElement("div");
  shell.setAttribute("class", "mermaid");
  const width = pre.clientWidth || pre.parentNode?.clientWidth || 0;
  if (width) shell.style.width = `${width}px`;
  shell.style.visibility = "hidden";
  shell.style.position = "absolute";
  doc.body.appendChild(shell);
  const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
  let svg;
  try {
    ({ svg } = await render(id, String(code.textContent ?? "").replace(/\n$/u, ""), shell));
  } finally {
    shell.remove();
  }
  if (!svg) throw new Error("mermaid returned no svg");
  const host = doc.createElement("div");
  host.setAttribute("class", "mermaid");
  host.innerHTML = svg;
  if (!host.querySelector("svg")) throw new Error("mermaid returned no svg element");
  for (const marker of host.querySelectorAll("marker")) {
    const previous = marker.getAttribute("id");
    if (!previous) continue;
    const next = `${id}-${previous}`;
    marker.setAttribute("id", next);
    for (const attribute of ["marker-start", "marker-end"]) {
      for (const node of host.querySelectorAll(`[${attribute}="url(#${previous})"]`)) {
        node.setAttribute(attribute, `url(#${next})`);
      }
    }
  }
  pre.replaceWith(host);
}
