import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readSourceTree } from "./helpers/source-tree.js";

const editorSource = readSourceTree(new URL("../frontend/app/features/editor/", import.meta.url));
const themeSource = fs.readFileSync(
  fileURLToPath(new URL("../frontend/app/features/editor/extensions/theme.js", import.meta.url)),
  "utf8",
);
const appCss = fs.readFileSync(
  fileURLToPath(new URL("../src/app/assets/app.css", import.meta.url)),
  "utf8",
);

test("editor exposes getRenderContext and getViewportAnchor for core integration", () => {
  const source = editorSource;
  assert.equal(source.includes("getRenderContext()"), true);
  assert.equal(source.includes("assetRevisions"), true);
  assert.equal(source.includes("documentContext"), true);
  assert.equal(source.includes("getViewportAnchor()"), true);
  assert.equal(source.includes("posAtCoords"), true);
  // Asset revisions must survive mode refresh and only reset on vault/path change.
  assert.equal(source.includes("assetRevisions = {}"), true);
  assert.equal(source.includes("queueDocumentContextRefresh"), true);
  assert.equal(source.includes("queueMicrotask"), true);
  // Themeable heading paint is static-before-theme.css now; dynamic CM theme keeps geometry only.
  assert.equal(appCss.includes(".HyperMD-header-1"), true);
  assert.equal(appCss.includes("font-size: var(--h1-size, 1.8em)"), true);
  assert.equal(themeSource.includes('fontSize: "var(--h1-size, 1.8em)"'), false);
  assert.equal(source.includes("Decoration.widget"), true);
  assert.equal(source.includes('FOLD_ICON_PATH = "m9 18 6-6-6-6"'), true);
  // Desktop-parity affordance: desktop's own indicator is role=button without a
  // tabindex; ours is reachable and reports its state (WCAG 2.2 AA 2.5.8 / 4.1.2).
  assert.equal(source.includes('setAttribute("role", "button")'), true);
  assert.equal(source.includes('setAttribute("tabindex", "0")'), true);
  assert.equal(source.includes('setAttribute("aria-expanded"'), true);
  assert.equal(source.includes("toggleFoldAt"), true);
  // Heading before-space is the shared Reader/Live geometry token, not a literal.
  assert.equal(source.includes('paddingTop: "var(--md-heading-space-before, 1.25em)"'), true);
  assert.equal(source.includes(".cm-live-heading"), true);
  assert.equal(source.includes("cm-fold-h${this.level}"), true);
  assert.equal(source.includes("headingLevelAt"), true);
  assert.equal(source.includes("headingFoldIndicators"), true);
  assert.equal(source.includes("headingFoldHover"), false);
  assert.equal(source.includes("is-revealed"), false);
  assert.equal(source.includes("--fold-block-offset"), false);
  assert.equal(source.includes("BlockType"), false);
  assert.equal(source.includes("cm-fold-marker"), false);
  assert.equal(source.includes("fold-gutter-align"), false);
  assert.equal(source.includes("chevron-down"), false);
  assert.equal(source.includes("foldGutter("), false);
  assert.equal(source.includes(':scope > .cm-line'), false);
  assert.equal(source.includes("ListMarkWidget"), true);
  assert.equal(source.includes("WikiLinkWidget"), true);
  assert.equal(source.includes("CodeLangWidget"), false);
  assert.equal(source.includes("this.editable = editable"), false);
  assert.equal(source.includes("rewriteFenceLanguage"), false);
  assert.equal(source.includes("cm-live-code-lang-select"), false);
  assert.equal(source.includes("cm-live-code-lang-line"), true);
  assert.equal(source.includes("cm-live-code-fence-line"), true);
  assert.equal(source.includes("selectionReveals"), true);
  // WEB-ED-02: the table-delimiter caret snap is gone; fence insertion uses a
  // fence-specific helper that carries no table semantics.
  assert.equal(source.includes("snapPosOffHiddenChrome"), false);
  assert.equal(source.includes("TABLE_DIVIDER_RE"), false);
  assert.equal(source.includes("fenceLineInsertPos"), true);
  assert.equal(source.includes("newlineInCodeBlock"), true);
  assert.equal(source.includes("codeBlockNewlineSpec"), true);
  assert.equal(source.includes("liveNewlineSpec"), true);
  assert.equal(source.includes("newlineInLive"), true);
  assert.equal(source.includes("collapseNewlineClick"), true);
  assert.equal(source.includes("normalizeLiveClickSelection"), true);
  assert.equal(source.includes("shouldCollapsePaddingNewline"), true);
  assert.equal(source.includes("pointerEvents: \"none\""), true);
  assert.equal(source.includes("cm-live-hr"), true);
  assert.equal(source.includes("cm-live-code-fence-active"), false);
  assert.equal(source.includes("MarkdownBlockWidget"), false);
  assert.equal(source.includes("safeDecorationSet"), true);
  assert.equal(source.includes("cm-live-inline-code"), true);
  assert.equal(source.includes("cm-live-inline-code-content"), true);
  assert.equal(source.includes("--code-block-padding-block"), true);
  assert.equal(source.includes("cm-live-code-indented"), true);
  assert.equal(source.includes("leavePropertiesWidget"), true);
  assert.equal(source.includes("skipPropertiesCaret"), true);
  assert.equal(source.includes("cursorAfterFrontmatter"), true);
  // WEB-ED-R1: drawSelection owns the editable caret. Do not reintroduce the
  // broken mixed state where theme CSS globally hides .cm-cursor and tries to
  // force the browser-native caret back on.
  assert.equal(source.includes("drawSelection()"), true);
  assert.equal(source.includes("snapCaretToDevicePixels"), true);
  assert.equal(themeSource.includes('".cm-cursor": { display: "none !important" }'), false);
  assert.equal(themeSource.includes('width: "2px"'), true);
  assert.equal(themeSource.includes('borderLeft: "0"'), true);
  assert.equal(themeSource.includes('backgroundColor: "var(--interactive-accent, var(--accent))"'), true);
  // E1 P0-B: caret device-pixel alignment is paint-only and must move the
  // layout `left`, not paint a fractional transform (which antialiases the
  // caret at integral DPR). The shared arithmetic helper keeps the grid math
  // testable without a browser.
  assert.equal(editorSource.includes("caret-metrics.js"), true);
  assert.equal(editorSource.includes("caretPaintTarget"), true);
  assert.equal(editorSource.includes(".style.translate ="), false);
  assert.equal(editorSource.includes("currentTranslateX"), false);
  // List source is local chrome: editing the list body must not expose its
  // Markdown marker, and idle/source states must share one layout width.
  assert.equal(source.includes("cm-live-list-bullet"), true);
  assert.equal(source.includes("Math.min(context.to, node.to + 1)"), true);
  // WEB-ED-04: hidden task markers are atomic from the same decoration set.
  assert.equal(source.includes("EditorView.atomicRanges.of("), true);
  assert.equal(source.includes("taskAtomicRangesFromDecorations"), true);
  assert.equal(source.includes("taskCaretAfterToggle"), true);
  assert.equal(source.includes("class TaskCheckboxWidget extends WidgetType"), true);
});

test("editor refreshAssets mirrors revisions into closure", () => {
  const source = editorSource;
  assert.equal(source.includes("assetRevisions = { ...meta.assetRevisions }"), true);
  assert.equal(source.includes("blockPreview.refreshAssets"), true);
});
