// U9: full icon audit — every audited control must draw the glyph the desktop reference
// draws. The sprite is a shared asset, so the assertions pin (a) the glyph geometry for
// the symbols that changed and (b) the control → symbol wiring in the SSR shell / search
// view. The browser probe (scratch/web-bases/U9/probe/u9-icon-audit-probe.mjs) covers the
// rendered result; this suite keeps the source of truth honest without a browser.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const sprite = await fs.readFile(new URL("../src/app/assets/icons.svg", import.meta.url), "utf8");
const pages = await fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const searchView = await fs.readFile(new URL("../frontend/app/features/search/search-view.js", import.meta.url), "utf8");
const { propertyIconName } = await import("../frontend/app/features/editor/frontmatter.js");

// Every icon call site under frontend/app/features/** plus the SSR shell, so a renamed or
// deleted symbol cannot survive as a silently empty <use>.
const callSiteFiles = [
  new URL("../src/app/pages.js", import.meta.url),
  new URL("../frontend/app/features/reader/reader.js", import.meta.url),
  new URL("../frontend/app/features/context/outline.js", import.meta.url),
  new URL("../frontend/app/features/context/row.js", import.meta.url),
  new URL("../frontend/app/features/context/tags.js", import.meta.url),
  new URL("../frontend/app/features/document/properties-panel.js", import.meta.url),
  new URL("../frontend/app/features/document/view-mode-controller.js", import.meta.url),
  new URL("../frontend/app/features/bases/actions.js", import.meta.url),
  new URL("../frontend/app/features/bases/cell.js", import.meta.url),
  new URL("../frontend/app/features/bases/panels.js", import.meta.url),
  new URL("../frontend/app/features/bases/panel-chrome.js", import.meta.url),
  new URL("../frontend/app/features/bases/panel-sort.js", import.meta.url),
  new URL("../frontend/app/features/bases/panel-filter.js", import.meta.url),
  new URL("../frontend/app/features/bases/panel-properties.js", import.meta.url),
  new URL("../frontend/app/features/bases/toolbar.js", import.meta.url),
  new URL("../frontend/app/features/bases/view.js", import.meta.url),
  new URL("../frontend/app/features/search/search-view.js", import.meta.url),
];

const symbol = (id) => {
  const match = sprite.match(new RegExp(`<symbol id="${id}" viewBox="0 0 24 24">([\\s\\S]*?)</symbol>`));
  return match ? match[1] : null;
};
const pathsOf = (id) => [...(symbol(id) ?? "").matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);

// The desktop reference is Obsidian's own chain+arrow glyph for the two link views
// (obsidian-icon-links-going-out / -coming-in, viewBox 0 0 24 24), not a Lucide glyph.
const CHAIN_HOOK_A = "M8.70467 12C8.21657 11.6404 7.81269 11.1817 7.52044 10.6549C7.22819 10.1281 7.0544 9.54553 7.01086 8.94677C6.96732 8.348 7.05504 7.74701 7.26808 7.18456C7.48112 6.62212 7.81449 6.11138 8.24558 5.68697L10.7961 3.17516C11.5978 2.41258 12.6716 1.99062 13.7861 2.00016C14.9007 2.0097 15.9668 2.44997 16.755 3.22615C17.5431 4.00234 17.9902 5.05233 17.9998 6.14998C18.0095 7.24763 17.5811 8.30511 16.8067 9.09467L15.9014 10";
const CHAIN_HOOK_B = "M11.2953 8C11.7834 8.35957 12.1873 8.81831 12.4796 9.34512C12.7718 9.87192 12.9456 10.4545 12.9891 11.0532C13.0327 11.652 12.945 12.253 12.7319 12.8154C12.5189 13.3779 12.1855 13.8886 11.7544 14.313L9.20392 16.8248C8.40221 17.5874 7.32844 18.0094 6.21389 17.9998C5.09933 17.9903 4.03318 17.55 3.24504 16.7738C2.4569 15.9977 2.00985 14.9477 2.00016 13.85C1.99047 12.7524 2.41893 11.6949 3.19326 10.9053L4.09859 10";

test("the ribbon/sidebar toggle carries the desktop's filled left column", () => {
  const body = symbol("panel-left");
  assert.ok(body, "the sprite defines #panel-left");
  assert.match(body, /<rect x="3" y="3" width="18" height="18" rx="2"\/>/, "the outer panel stays a stroked rounded square");
  assert.match(body, /fill="currentColor"/, "the left column is filled, like the desktop glyph");
  assert.match(body, /stroke="none"/, "the fill is not also stroked");
  assert.doesNotMatch(body, /M9 3v18/, "the old empty centre line is gone");
});

test("the new-note control draws Lucide square-pen (desktop file-explorer New note)", () => {
  assert.equal(symbol("square-pen"), '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/>');
  assert.match(pages, /id="new-note"[^>]*>\$\{icon\("square-pen"\)\}/);
});

test("the reveal-active control draws Lucide gallery-vertical (desktop Auto-reveal active file)", () => {
  assert.equal(symbol("gallery-vertical"), '<path d="M3 2h18"/><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 22h18"/>');
  assert.match(pages, /id="reveal-active"[^>]*>\$\{icon\("gallery-vertical"\)\}/);
});

test("the document actions menu draws the desktop's vertical ellipsis", () => {
  assert.match(pages, /id="document-actions-toggle"[^>]*>\$\{icon\("more-vertical"\)\}/);
  assert.doesNotMatch(pages, /id="document-actions-toggle"[^>]*>\$\{icon\("share-2"\)\}/);
});

test("the link views use Obsidian's chain+arrow glyphs, not a scaled-down chain", () => {
  assert.deepEqual(pathsOf("link-out"), [CHAIN_HOOK_A, CHAIN_HOOK_B, "M18 21L21 18L18 15", "M14 18H21"], "#link-out = links-going-out");
  assert.deepEqual(pathsOf("link-in"), [CHAIN_HOOK_A, CHAIN_HOOK_B, "M17 21L14 18L17 15", "M21 18H14"], "#link-in = links-coming-in");
});

test("a plain property row draws the desktop's left-aligned three-line glyph", () => {
  assert.deepEqual(pathsOf("text"), ["M21 6H3M15 12H3M17 18H3"], "#text matches the measured desktop property glyph");
});

test("the search result group chevron is a sprite chevron, not a CSS triangle", () => {
  // U38 (#571): the href comes from the shared resolver, never a bundle literal.
  assert.match(searchView, /import \{ spriteIcon \} from "\.\.\/\.\.\/ui\/icons\.js"/);
  assert.match(searchView, /spriteIcon\(doc, "chevron-right", "svg-icon search-group-chevron"\)/);
  assert.doesNotMatch(searchView, /icons\.svg/, "no hand-built sprite URL is left in the search view");
  assert.match(symbol("chevron-right") ?? "", /<path d="m9 18 6-6-6-6"\/>/);
  const rule = css.match(/\.search-group-chevron \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /width: 14px/, "the chevron is sized like a glyph");
  assert.doesNotMatch(rule, /border-left/, "the CSS triangle is gone");
  assert.match(css, /\.search-group-toggle\[aria-expanded="false"\] \.search-group-chevron \{ transform: rotate\(0deg\); \}/, "the expanded/collapsed rotation is unchanged");
});

test("every icon call site resolves to a real sprite symbol (full inventory)", async () => {
  const sources = await Promise.all(callSiteFiles.map(async (url) => [url, await fs.readFile(url, "utf8")]));
  const names = new Set();
  const patterns = [
    /\bicon(?:Html)?\("([a-z0-9-]+)"/g,
    // Every module that builds a sprite glyph goes through ui/icons.js, so the argument is
    // `doc` / `documentRef` / any document-like root (widened from `doc` in #571; strictly
    // more call sites are covered, as the hand-built anchors are gone).
    /\b(?:spriteIcon|createSpriteIcon)\(\s*[A-Za-z_$][\w$]*,\s*"([a-z0-9-]+)"/g,
    /icons\.svg#([a-z0-9-]+)/g,
    /\bicon:\s*"([a-z0-9-]+)"/g,
  ];
  for (const [, source] of sources) {
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  // Resolved at runtime rather than from a literal at the call site:
  //  - property rows -> frontmatter.propertyIconName() / reader.js propertyIcon()
  //  - base sort panel -> panels.js `dir === "asc" ? "arrow-up" : "arrow-down"`
  //  - base column glyphs -> view.js columnIconName()
  //  - base sort indicator default -> actions.js BASE_SORT_INDICATOR_DEFAULT_ICON
  //  - view-mode toggle -> view-mode-controller.js icons map (asserted below)
  for (const key of ["title", "created", "tags", "mcp_author"]) names.add(propertyIconName(key));
  for (const name of ["arrow-up", "arrow-down", "calendar", "link", "chevrons-up-down", "book-open", "code", "pen"]) names.add(name);
  assert.ok(names.size >= 20, `the scan really found the icon call sites (${names.size})`);
  const missing = [...names].filter((name) => !new RegExp(`<symbol id="${name}" viewBox="0 0 24 24">`).test(sprite));
  assert.deepEqual(missing, [], `every referenced icon exists in the sprite (missing: ${missing.join(", ")})`);
  for (const name of ["book-open", "code", "pen"]) {
    assert.match(sprite, new RegExp(`<symbol id="${name}" viewBox="0 0 24 24">`), `${name} is defined`);
  }
});
