// Phase 1 render-parity slice: inline code.
//
// The real bounded Chromium harness (`scripts/render-parity-phase0.mjs`) owns
// computed-style measurement. These offline checks keep the Phase 1 expectation
// and the shared padding token from silently drifting back:
//
//   1. the allowlist may no longer relax inline-code vertical padding, box
//      height or glyph offset (only the hidden-source-mark width reserve stays);
//   2. Reader and Live must consume the same shared padding tokens;
//   3. the built browser bundle must carry the token reference.
//
// They intentionally do not touch the Phase 0 harness or CI wiring.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROBES } from "../scripts/render-parity-phase0.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

const allowlist = JSON.parse(read("test/fixtures/render-parity-allowlist.json"));
const appCss = read("src/app/assets/app.css");
const themeSource = read("frontend/app/features/editor/extensions/theme.js");
const editorBundle = read("src/app/assets/editor.js");
const liveSource = read("frontend/app/features/editor/extensions/live-decorations.js");
const pagesSource = read("src/app/pages.js");
const appSource = read("frontend/app/core/app.js");

const VERTICAL_FIELDS = [
  "style.paddingTop",
  "style.paddingBottom",
  "metrics.paddingTopPx",
  "metrics.paddingBottomPx",
  "metrics.glyphTopFromBoxTop",
  "metrics.boxHeight",
];

test("inline-code probe still measures Reader and Live under the Phase 0 gate", () => {
  const probe = PROBES.find((entry) => entry.kind === "inline-code");
  assert.ok(probe, "inline-code probe must exist");
  assert.equal(probe.readerClimb, "code");
  assert.equal(probe.liveClimb, ".cm-live-inline-code");
  assert.equal(probe.deferred, undefined, "Phase 1 inline-code must gate, not defer");
  assert.equal((allowlist.deferred || []).includes("inline-code"), false);
});

test("allowlist no longer relaxes inline-code vertical padding or geometry", () => {
  const entries = (allowlist.entries || []).filter((entry) => (entry.kinds || []).includes("inline-code"));
  assert.equal(entries.length, 1, "inline-code should have exactly one explicit expectation entry");
  const [entry] = entries;
  assert.ok(entry.category && entry.reason, "the entry keeps its category and reason");
  for (const field of VERTICAL_FIELDS) {
    assert.equal(entry.fields.includes(field), false, `${field} must not be allowlisted after the Phase 1 slice`);
  }
  // The hidden backtick placeholders are a real host-model reserve; that width
  // difference is the only permitted inline-code expectation.
  assert.deepEqual(entry.fields, ["metrics.boxWidth"]);
});

test("Reader and Live share the static Obsidian-compatible inline-code base", () => {
  assert.match(appCss, /--code-size:\s*var\(--font-smaller\)/);
  assert.match(appCss, /--code-normal:\s*var\(--text-muted\)/);
  assert.match(appCss, /--code-background:\s*var\(--background-primary-alt\)/);
  assert.match(appCss, /--code-inline-padding-block:\s*\.1em/);
  assert.match(appCss, /--code-inline-padding-inline:\s*\.25em/);

  // Phase 1-A: the fallback scope must stay inside :where() so real themes can
  // win with a low-specificity canonical selector (`.markdown-rendered code`).
  const readerRule = appCss.match(/:where\(\.preview, \.markdown-rendered\) :not\(pre\) > code \{([^}]*)\}/);
  assert.ok(readerRule, "Reader canonical code rule must exist");
  assert.match(readerRule[1], /padding:\s*var\(--code-inline-padding-block\) var\(--code-inline-padding-inline\)/);

  const liveRule = appCss.match(/:where\(\.markdown-source-view\.mod-cm6\) \.cm-inline-code \{([^}]*)\}/);
  assert.ok(liveRule, "Live canonical .cm-inline-code base rule must exist");
  assert.match(liveRule[1], /padding:\s*var\(--code-inline-padding-block\) var\(--code-inline-padding-inline\)/);

  // A bare `.preview code` / `.markdown-source-view.mod-cm6 .cm-inline-code`
  // fallback would out-specify a community theme's canonical selector.
  assert.equal(/\.preview code,/.test(appCss), false, "Reader fallback must not keep a bare .preview code rule");
  assert.equal(/\.markdown-source-view\.mod-cm6 \.cm-inline-code \{/.test(appCss), false, "Live fallback must not keep a bare .cm-inline-code scope");

  // Dynamic CodeMirror theme CSS is injected after <link id="community-theme">.
  // Inline-code paint must stay out of it or the real vault theme cannot win.
  assert.equal(themeSource.includes('".cm-live-inline-code": {'), false);
  assert.equal(themeSource.includes('".cm-live-inline-code-content": {'), false);
});

test("inline code exposes Obsidian-compatible theme selectors", () => {
  assert.match(liveSource, /cm-inline-code cm-live-inline-code-content cm-live-inline-code/);
  assert.match(pagesSource, /markdown-preview-view markdown-rendered markdown-preview-sizer markdown-preview-section/);
  assert.match(appSource, /markdown-preview-view markdown-rendered markdown-preview-sizer markdown-preview-section/);

  const readerRule = appCss.match(/:where\(\.preview, \.markdown-rendered\) :not\(pre\) > code \{([^}]*)\}/);
  assert.ok(readerRule, "Reader canonical inline-code rule must exist");
  assert.match(readerRule[1], /color:\s*var\(--code-normal\)/);
  assert.match(readerRule[1], /background:\s*var\(--code-background\)/);
  assert.match(readerRule[1], /font-size:\s*var\(--code-size\)/);
  assert.match(readerRule[1], /border-radius:\s*var\(--radius-s\)/);

  assert.equal(themeSource.includes('".cm-live-inline-code": {'), false);
  assert.equal(themeSource.includes('".cm-live-inline-code-content": {'), false);
});
