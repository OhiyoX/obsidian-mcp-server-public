import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { LIVE_CODE_TOKEN_FACES } from "../../document/code-tokens.js";

// Code tokens carry the canonical Obsidian class face (`cm-keyword`,
// `cm-string`, `cm-comment`, ...) instead of a generated `ͼ…` name, so the
// Vault theme's canonical `.cm-s-obsidian .cm-keyword` family selects them.
// The style is class-only on purpose: it emits no CSS module, and every colour
// comes from the `--code-*` semantic tokens declared once in app.css under a
// `:where()` scope. Markdown semantic paint stays out of HighlightStyle for the
// same reason: community theme.css owns headings/links/strong/emphasis/quote/
// list/strike through canonical Obsidian classes.
export const obsidianHighlight = HighlightStyle.define(
  LIVE_CODE_TOKEN_FACES.map((face) => ({ tag: face.tags, class: face.class })),
);

export const obsidianTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--background-primary, var(--panel))",
    color: "var(--text-normal, var(--text))",
    fontFamily: "var(--font-text)",
    fontSize: "var(--font-text-size, 16px)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-text)",
    lineHeight: "var(--line-height-normal, 1.65)",
    // RAW keeps CodeMirror's ordinary flow layout. Live Preview overrides the
    // inline padding and takes the fold gutter out of flow in app.css so its
    // document column can share Reader's exact horizontal axis.
    padding: "28px max(28px, env(safe-area-inset-left))",
    scrollbarGutter: "stable",
    backgroundColor: "var(--background-primary, var(--panel))",
  },
  ".cm-content": {
    minHeight: "100%",
    // Keep normal prose at the readable line width. A table may overflow this
    // child box; CodeMirror's single native scroller owns that horizontal
    // overflow instead of creating one scroll container per rendered row.
    // `--file-line-width` is the desktop core knob and wins when a theme sets
    // it (AnuPpuccin does); `--line-width` stays as the community-theme
    // convention (Things/Minimal declare `--line-width: 40rem`).
    maxWidth: "min(var(--file-line-width, var(--line-width, 700px)), 100%)",
    margin: "0 auto",
    padding: "0",
    backgroundColor: "transparent",
    fontSize: "var(--font-text-size, 16px)",
  },
  ".cm-line": { padding: "0" },
  // Horizontal-rule paint stays in static app.css so Vault theme.css remains
  // authoritative. Only CodeMirror line geometry lives here: this layer is
  // injected after app.css and must own every pixel in the height/hit-test map.
  ".cm-live-hr": {
    boxSizing: "border-box",
    overflow: "hidden",
    margin: "0",
    padding: "var(--hr-spacing-block, 32px) 0",
    fontSize: "0",
    lineHeight: "0",
  },
  ".cm-live-hr-active": {
    overflow: "visible",
    margin: "0",
    padding: "calc(var(--hr-spacing-block, 32px) - .75em) 0",
    fontSize: ".9em",
    lineHeight: "1.5",
  },
  // drawSelection() owns both selection paint and the editable caret. Keeping
  // the cursor in the same CodeMirror coordinate system avoids the broken
  // mixed state where drawSelection hides the native caret while theme CSS
  // also hides .cm-cursor.
  ".cm-cursor": {
    // Paint a fixed-width rectangle instead of a border. Border rasterization
    // can land on different device-pixel boundaries at line start vs in-line.
    width: "2px",
    borderLeft: "0",
    backgroundColor: "var(--interactive-accent, var(--accent))",
    marginLeft: "-1px",
    boxSizing: "border-box",
  },
  ".cm-dropCursor": {
    borderLeft: "2px solid var(--interactive-accent, var(--accent))",
    marginLeft: "-1px",
    boxSizing: "border-box",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    // The selection layer sits above styled surfaces. Keep it as one
    // translucent wash: per-rectangle borders or shadows create false stripes
    // across multi-line selections and look like a broken overlay.
    backgroundColor: "var(--text-selection, color-mix(in srgb, var(--interactive-accent, var(--accent, #9b87f5)) 34%, transparent)) !important",
    boxShadow: "none",
  },
  // Keep the selection paint above Live decorations. CodeMirror's default
  // selection layer is behind content (z-index -2), where code/table/inline
  // backgrounds can completely cover it.
  ".cm-selectionLayer.cm-layer": { zIndex: "5 !important", pointerEvents: "none" },
  ".cm-cursorLayer.cm-layer": { zIndex: "6 !important", pointerEvents: "none" },
  // Live Preview positions the fold gutter immediately outside the readable
  // document column. Keep it below rendered block widgets so a wide table that
  // overhangs into that lane cannot have its first border/text painted over.
  ".cm-gutters": { backgroundColor: "var(--background-primary, var(--panel))", color: "var(--text-faint)", border: "0", paddingRight: "8px", zIndex: "0" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", padding: "0 6px 0 2px", fontFamily: "var(--font-monospace)", fontSize: "11px" },
  // Active line: highlight the number itself, never fill the cell. A wrapped line's
  // gutter cell spans every visual row, so a background painted the whole block.
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-normal)" },
  // Every line touched by a selection is highlighted the same way (desktop behaviour).
  ".cm-lineNumbers .cm-selectedLineGutter": { color: "var(--text-normal)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  // Semantic paint lives in static app.css before community theme.css.
  // Dynamic CodeMirror CSS keeps only measurable/interactive geometry.
  ".cm-live-heading": { lineHeight: "var(--heading-line-height, 1.25)" },
  // Heading before-space is the shared Reader/Live geometry token: Reader uses
  // it as margin-top, Live must use measurable line padding. Keep it out of
  // app.css because EditorView.theme is injected after theme.css and owns
  // every pixel of the CodeMirror height/hit-test map.
  ".cm-live-h1": { paddingTop: "var(--md-heading-space-before, 1.25em)" },
  ".cm-live-h2": { paddingTop: "var(--md-heading-space-before, 1.25em)" },
  ".cm-live-h3": { paddingTop: "var(--md-heading-space-before, 1.25em)" },
  ".cm-live-h4": { paddingTop: "var(--md-heading-space-before, 1.25em)" },
  ".cm-live-h5": { paddingTop: "var(--md-heading-space-before, 1.25em)" },
  ".cm-live-h6": { paddingTop: "var(--md-heading-space-before, 1.25em)" },
  ".cm-live-quote": { paddingLeft: "0.9em" },
  ".cm-live-source-mark-hidden": { visibility: "hidden" },
  // Code-fence paint lives in app.css, which is loaded before the real
  // community theme.css. Do not put color/background/border/radius here:
  // EditorView.theme is injected after theme.css and would win over a
  // low-specificity community selector. Only measurable geometry stays here.
  ".cm-live-code-lang-line, .cm-live-code-fence-line": {
    fontFamily: "var(--font-monospace)",
    boxSizing: "border-box",
    fontSize: "var(--code-fence-font-size, 11px)",
    lineHeight: "var(--code-block-padding-block, 13px)",
    height: "var(--code-block-padding-block, 13px)",
    minHeight: "var(--code-block-padding-block, 13px)",
    margin: "0",
    overflow: "hidden",
  },
  ".cm-live-code-lang-line": {
    padding: "0 var(--code-block-padding-inline, 15px)",
  },
  // #482 third slice: the flair is absolutely positioned against the opening fence
  // line, so that line is the containing block — and it must not clip the flair,
  // which is taller than the 13px fence strip. Geometry lives here (not in app.css)
  // because `EditorView.theme` is injected after the stylesheets and would win the
  // tie on `overflow`/`position` anyway.
  ".cm-live-code-lang-line.cm-live-code-flair-host": {
    position: "relative",
    overflow: "visible",
  },
  ".cm-live-code-fence-line": {
    padding: "0 var(--code-block-padding-inline, 15px)",
  },
  ".cm-live-code-start": {
    marginTop: "0",
    padding: "0 var(--code-block-padding-inline, 15px)",
  },
  ".cm-live-code-start.cm-live-code-below-lang": {
    paddingTop: "0",
  },
  ".cm-live-code-body": {
    padding: "0 var(--code-block-padding-inline, 15px)",
  },
  ".cm-live-code-end": {
    marginBottom: "0",
    padding: "0 var(--code-block-padding-inline, 15px)",
  },
  ".cm-live-code-end.cm-live-code-above-fence": {
    padding: "0 var(--code-block-padding-inline, 15px)",
  },
  ".cm-live-code-indented.cm-live-code-start": {
    paddingTop: "var(--code-block-padding-block, 13px)",
  },
  ".cm-live-code-indented.cm-live-code-end": {
    paddingBottom: "var(--code-block-padding-block, 13px)",
  },
  ".cm-live-code-indented.cm-live-code-start.cm-live-code-end": {
    padding: "var(--code-block-padding-block, 13px) var(--code-block-padding-inline, 15px)",
    marginBottom: "0",
  },
  // Desktop 1.14.4 keeps the heading fold indicator inline in the line
  // (app.css@8259): a zero-width inline-block with a ZWSP `:before`, so the
  // line's own geometry - heading size, before-space padding, block-widget
  // offset - places it. No per-level offset arithmetic lives here any more.
  // Desktop paints a 10px glyph with a 4px stroke (@8222) and shows it only on
  // line hover; we keep that paint and add a 24x24 target (WCAG 2.2 AA 2.5.8),
  // a faint rest state and a focus ring.
  ".cm-fold-indicator": {
    display: "inline-block",
    position: "relative",
    zIndex: "1",
    width: "0",
  },
  ".cm-fold-indicator:before": { content: '"\\200B"' },
  ".cm-fold-indicator .collapse-indicator": {
    position: "absolute",
    top: "50%",
    insetInlineEnd: "0",
    transform: "translateY(-50%)",
    boxSizing: "border-box",
    width: "24px",
    height: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingInlineEnd: "5px",
    margin: "0",
    background: "none",
    color: "var(--collapse-icon-color, var(--text-faint))",
    cursor: "var(--cursor, default)",
    opacity: ".5",
    transition: "opacity .08s ease",
  },
  ".cm-fold-indicator .collapse-indicator svg.svg-icon": {
    width: "10px",
    height: "10px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "4px",
    transformOrigin: "50% 50%",
    transition: "transform 100ms ease-in-out",
  },
  ".cm-fold-indicator.is-open .collapse-indicator svg.svg-icon": { transform: "rotate(90deg)" },
  ".cm-fold-indicator.is-collapsed .collapse-indicator": {
    opacity: "1",
    color: "var(--collapse-icon-color-collapsed, var(--text-accent))",
  },
  // Hover and focus raise opacity and nothing else: Desktop's hover rule
  // (app.css@8265-8268) sets `opacity: 1` only, so the colour stays the
  // collapse token (@8236) instead of deepening a step. The collapsed state
  // keeps its own accent colour (@8239-8240) on hover too.
  ".cm-line:hover .cm-fold-indicator .collapse-indicator, .cm-fold-indicator .collapse-indicator:hover, .cm-fold-indicator .collapse-indicator:focus-visible": {
    opacity: "1",
  },
  ".cm-fold-indicator .collapse-indicator:focus-visible": {
    borderRadius: "4px",
    outline: "2px solid var(--interactive-accent, var(--color-accent))",
    outlineOffset: "1px",
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-fold-indicator .collapse-indicator, .cm-fold-indicator .collapse-indicator svg.svg-icon": { transition: "none" },
  },
  // Match Obsidian: muted ellipsis, no light pill/border from CM base theme.
  ".cm-foldPlaceholder, .cm-obsidian-fold-placeholder": {
    backgroundColor: "transparent",
    border: "0",
    borderRadius: "0",
    margin: "0 0.15em",
    padding: "0",
    color: "var(--text-faint)",
    fontSize: "0.95em",
    letterSpacing: "0.02em",
    cursor: "pointer",
  },
});

