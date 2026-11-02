import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const themeSource = await fs.readFile(
  new URL("../frontend/app/features/editor/extensions/theme.js", import.meta.url),
  "utf8",
);
const parityAllowlist = JSON.parse(await fs.readFile(
  new URL("./fixtures/render-parity-allowlist.json", import.meta.url),
  "utf8",
));
const liveDecorationsSource = await fs.readFile(
  new URL("../frontend/app/features/editor/extensions/live-decorations.js", import.meta.url),
  "utf8",
);
const createEditorSource = await fs.readFile(
  new URL("../frontend/app/features/editor/create-editor.js", import.meta.url),
  "utf8",
);

test("Web surfaces use Obsidian semantic background mappings", () => {
  assert.match(css, /--background-primary:\s*var\(--color-base-00\)/);
  assert.match(css, /--background-primary-alt:\s*var\(--color-base-10\)/);
  assert.match(css, /--background-secondary:\s*var\(--color-base-20\)/);
  assert.match(css, /--background-secondary-alt:\s*var\(--color-base-30\)/);
});

test("Web chrome delegates sidebar states to theme navigation tokens", () => {
  assert.match(css, /--app-chrome-bg:\s*var\(--background-secondary\)/);
  assert.match(css, /--app-sidebar-text:\s*var\(--nav-item-color\)/);
  assert.match(css, /--app-sidebar-hover:\s*var\(--nav-item-background-hover\)/);
  assert.match(css, /--app-sidebar-active-bg:\s*var\(--nav-item-background-active\)/);
  assert.doesNotMatch(css, /--app-sidebar-active-bg:\s*color-mix/);
});

test("completed tasks are visually muted in reading and live preview", () => {
  // Desktop-declared completed paint: faint tone + line-through, on the same
  // canonical state surfaces Obsidian Desktop and Things target.
  assert.match(css, /:where\(\.preview\) \.task-list-item\.is-checked,[^}]*color:\s*var\(--text-faint\);[^}]*text-decoration:\s*line-through;/);
  assert.match(css, /:where\(\.cm-editor\) \.cm-line\.HyperMD-task-line\.is-checked,[^}]*color:\s*var\(--text-faint\);[^}]*text-decoration:\s*line-through;/);
  // Both completed-state shapes stay reachable for a real theme.
  assert.match(css, /:where\(\.preview\) \.task-list-item\[data-task="x"\]/);
  assert.match(css, /:where\(\.cm-editor\) \.cm-line\.HyperMD-task-line\[data-task="x"\]/);
  assert.match(css, /:where\(\.cm-editor\) \.cm-line:has\(\.cm-live-task-checkbox:checked\)/);
});

test("task checkbox geometry stays theme-token driven and flat", () => {
  assert.match(css, /width:\s*var\(--checkbox-size, 15px\)/);
  assert.match(css, /border-radius:\s*var\(--checkbox-radius, 3px\)/);
  assert.match(css, /background:\s*transparent;[\s\S]*color:\s*var\(--text-normal\);[\s\S]*box-shadow:\s*none;/);
  assert.match(css, /:where\(\.preview\) \.task-list-item-checkbox,\s*\n\.cm-live-task-checkbox \{[\s\S]*color:\s*var\(--text-normal\)/);
  assert.match(css, /background:\s*var\(--checkbox-color, var\(--interactive-accent\)\)/);
});


test("Reader and Live block code share static theme-owned paint", () => {
  assert.match(css, /--code-block-foreground:\s*var\(--text-normal\)/);
  assert.match(css, /\.preview pre \{[^}]*color:\s*var\(--code-block-foreground\)/s);
  assert.match(css, /\.preview pre code \{[^}]*color:\s*inherit/s);
  assert.match(css, /\.cm-live-code \{[^}]*color:\s*var\(--code-block-foreground\)/s);
  assert.match(css, /\.cm-live-code \{[^}]*background:\s*var\(--code-background, var\(--code-bg\)\)/s);
  assert.doesNotMatch(themeSource, /"\.cm-live-code":\s*\{/);
});

test("Reader and Live blockquotes consume one shared paint contract", () => {
  assert.match(css, /--blockquote-color:\s*var\(--text-muted\)/);
  assert.match(css, /--blockquote-border-color:\s*var\(--quote-opening-modifier,/);
  assert.match(css, /--blockquote-border-thickness:\s*3px/);
  assert.match(css, /\.preview blockquote \{[^}]*color:\s*var\(--blockquote-color\)/s);
  assert.match(css, /\.preview blockquote \{[^}]*border-left:\s*var\(--blockquote-border-thickness\) solid var\(--blockquote-border-color\)/s);
  assert.match(css, /\.HyperMD-quote \{[^}]*color:\s*var\(--blockquote-color\)/s);
  assert.match(css, /\.HyperMD-quote \{[^}]*box-shadow:\s*inset var\(--blockquote-border-thickness\) 0 0 var\(--blockquote-border-color\)/s);
});

test("render parity no longer excuses fixed quote or strikethrough paint drift", () => {
  const categories = new Set((parityAllowlist.entries || []).map((entry) => entry.category));
  assert.equal(categories.has("quote-token-drift"), false);
  assert.equal(categories.has("strikethrough-selector-mismatch"), false);
});


test("Reader and Live headings share one line-height contract including fold geometry", () => {
  assert.match(css, /--heading-line-height:\s*1\.25/);
  assert.match(
    css,
    /\.preview h1, \.preview h2, \.preview h3, \.preview h4, \.preview h5, \.preview h6 \{[^}]*line-height:\s*var\(--heading-line-height\)/s,
  );
  assert.match(themeSource, /"\.cm-live-heading": \{ lineHeight: "var\(--heading-line-height, 1\.25\)" \}/);
  // The fold indicator inherits the heading's line box (desktop app.css@8259), so the
  // heading line-height contract no longer needs a per-level fold offset.
  assert.equal(themeSource.includes("* 1.25 - 16px"), false, "fold offsets must not re-derive heading line geometry");
  assert.doesNotMatch(themeSource, /cm-fold-h[1-6][^\n]*marginTop/);

  const categories = new Set((parityAllowlist.entries || []).map((entry) => entry.category));
  assert.equal(categories.has("typography-token-drift"), false);
});


test("highlight and link paint keep Reader/Live semantic geometry aligned", () => {
  assert.match(
    css,
    /\.preview mark \{[^}]*padding:\s*0 \.1em;[^}]*background:\s*var\(--highlight-background\)/s,
  );
  assert.match(
    css,
    /\.cm-highlight, \.cm-obsidian-highlight\) \{[^}]*padding:\s*0 \.1em;[^}]*color:\s*inherit/s,
  );
  assert.match(
    css,
    /text-decoration-color:\s*color-mix\(in srgb, var\(--text-accent, var\(--syntax-link\)\) 42%, transparent\)/,
  );
  // #484 / #505: the paint pin no longer expects a fixed trim of 2. Owner truth
  // (2026-10-10 screenshot) is that idle `===a===` shows only `a`, so both sides'
  // whole `=` run is the delimiter. The pin follows `locateHighlightSpans` plus
  // functional trim — the same rule `highlightSpans()` hides with.
  assert.match(
    createEditorSource,
    /decorated\(locateHighlightSpans, "cm-obsidian-highlight cm-highlight", \{[\s\S]*?trimStart: highlightTrimStart,[\s\S]*?trimEnd: highlightTrimEnd,[\s\S]*?classFor: highlightedColourClass,[\s\S]*?\}\)/,
  );
});

test("wiki links preserve semantic class while exposing editable source", () => {
  const occurrences = liveDecorationsSource.match(/cm-hmd-internal-link cm-obsidian-link cm-live-wiki-link/g) || [];
  assert.ok(occurrences.length >= 2, "idle widget and active source must share cm-live-wiki-link");
});

test("render parity only allows intentional external-icon and editable-wiki width", () => {
  const relevant = (parityAllowlist.entries || []).filter((entry) =>
    (entry.kinds || []).some((kind) => ["highlight", "link-external", "link-wiki"].includes(kind))
  );
  assert.equal(relevant.some((entry) => entry.category === "highlight-padding"), false);
  assert.equal(relevant.some((entry) => entry.category === "link-token-drift"), false);
  assert.equal(relevant.some((entry) => entry.category === "interaction-chrome"), false);

  const external = relevant.find((entry) => entry.category === "external-link-reader-icon");
  assert.deepEqual(external?.fields, ["metrics.boxWidth"]);
  const wiki = relevant.find((entry) => entry.category === "wiki-source-width");
  assert.deepEqual(wiki?.fields, ["metrics.boxWidth"]);
});


test("Live semantic fallback scope does not outrank canonical theme selectors", () => {
  const start = css.indexOf("Obsidian Live semantic fallback surface");
  const end = css.indexOf(".preview .tag, .preview .property-pill", start);
  assert.ok(start >= 0 && end > start, "semantic fallback block must exist");
  const block = css.slice(start, end);

  assert.match(block, /:where\(\.markdown-source-view\.mod-cm6\.is-live-preview\) \.HyperMD-header/);
  assert.match(block, /:where\(\.markdown-source-view\.mod-cm6\.is-live-preview\) \.cm-strong/);
  assert.match(block, /:where\(\.markdown-source-view\.mod-cm6\.is-live-preview\) :is\(\.cm-link,/);
  assert.match(block, /:where\(\.markdown-source-view\.mod-cm6\.is-live-preview\) :is\(\.cm-highlight,/);
  assert.doesNotMatch(block, /(^|\n)\.markdown-source-view\.mod-cm6\.is-live-preview /);
  assert.doesNotMatch(block, /\.cm-hashtag\.cm-meta/);
});


test("mobile Reader and Live share the same scrollbar-gutter width contract", () => {
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.preview \{[^}]*scrollbar-gutter:\s*auto;/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.editor \.cm-scroller \{[^}]*scrollbar-gutter:\s*auto !important;/s);
  assert.match(themeSource, /"\.cm-scroller": \{[\s\S]*scrollbarGutter: "stable"/s);
});


test("Reader and Live horizontal rules split theme paint from CodeMirror geometry", () => {
  assert.match(css, /--hr-border-color:\s*var\(--background-modifier-border, var\(--line\)\)/);
  assert.match(css, /--hr-border-width:\s*1px/);
  assert.match(css, /--hr-spacing-block:\s*calc\(var\(--font-text-size, 16px\) \+ var\(--font-text-size, 16px\)\)/);
  assert.match(css, /\.preview hr \{[^}]*margin:\s*var\(--hr-spacing-block\) 0;[^}]*border-top:\s*var\(--hr-border-width\) solid var\(--hr-border-color\)/s);
  assert.match(css, /:where\(\.markdown-source-view\.mod-cm6\.is-live-preview\) \.cm-live-hr \{[^}]*border-top:\s*var\(--hr-border-width\) solid var\(--hr-border-color\)/s);
  assert.doesNotMatch(css, /\.cm-live-hr \{[^}]*padding:/s);
  assert.match(themeSource, /"\.cm-live-hr": \{[^}]*padding: "var\(--hr-spacing-block, 32px\) 0"[^}]*fontSize: "0"[^}]*lineHeight: "0"/s);
  assert.match(themeSource, /"\.cm-live-hr-active": \{[^}]*padding: "calc\(var\(--hr-spacing-block, 32px\) - \.75em\) 0"[^}]*fontSize: "\.9em"[^}]*lineHeight: "1\.5"/s);
  const idleHrGeometry = themeSource.match(/"\.cm-live-hr": \{([^}]*)\}/s)?.[1] || "";
  const activeHrGeometry = themeSource.match(/"\.cm-live-hr-active": \{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(idleHrGeometry, /border(?:Top|Bottom|Left|Right|Color)\s*:/);
  assert.doesNotMatch(idleHrGeometry, /(?:^|\n)\s*color\s*:/);
  assert.doesNotMatch(activeHrGeometry, /border(?:Top|Bottom|Left|Right|Color)\s*:/);
  assert.doesNotMatch(activeHrGeometry, /(?:^|\n)\s*color\s*:/);
});


test("Reader task fallback stays at canonical checkbox/theme specificity", () => {
  assert.match(css, /:where\(\.preview\) \.task-list-item-checkbox,\s*\n\.cm-live-task-checkbox \{/);
  assert.match(css, /:where\(\.preview\) \.task-list-item\.is-checked,/);
  assert.doesNotMatch(css, /(^|\n)\.preview \.task-list-item-checkbox(?:[:,\s])/);
  assert.doesNotMatch(css, /(^|\n)\.preview \.task-list-item\.is-checked(?:[:,\s])/);
  // The Live completed fallback must stay :where()-scoped too, so a real
  // theme.css selector always out-specifies it.
  assert.doesNotMatch(css, /(^|\n)\.cm-editor \.cm-line\.HyperMD-task-line(?:\.is-checked|\[data-task)/);
});
