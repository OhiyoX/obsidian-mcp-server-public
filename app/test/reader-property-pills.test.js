// Owner report: 「属性胶囊有点小了」——the note-properties `tags` pills render one step smaller
// than the row that holds them.
//
// Round 2 re-read the desktop 1.14.4 asar and corrected two premises of round 1:
//   * `@390969` `.metadata-property-value[data-property-type="tags"] .multi-select-pill` maps the
//     pill onto `--tag-color` / `--tag-background` / `--tag-border-color`, so a `tags` *row* is
//     accent-skinned on desktop — round 1 wrongly neutralised it.
//   * `@388435` leaves every other multi-select property (`aliases` / `cssclasses` / any list
//     property) plain: no inset, no outline, neutral inherited colour.
// Both of those are PARITY and are pinned by `800d8562` (the cut that ships).
//
// **THIS IS THE ENLARGEMENT THE OWNER APPROVED.** 2026-10-20 the owner was asked A/B/C about the
// property-pill geometry and answered "B": the pill is enlarged to the row body size. It is the
// ONLY intentional deviation from desktop in this cut, registered in
// docs/web-document-metadata-panel.md §2 ⓑ. `@80359` (`--metadata-input-font-size:
// var(--font-smaller)`) + `@389421` are desktop's own pill geometry: one step below the property
// row (0.875em ⇒ 11.375px, inset 0.65em ⇒ 7.39px, radius 2em ⇒ 22.75px, box ≈17px). The owner
// asked twice for a bigger pill (「胶囊有点小了」), so this cut drops the `font-size` (the pill
// rides the 13px row ⇒ 8.45px / 26px / ≈21.5px) and paints desktop's 1px `--tag-border-color`
// outline. The SKIN stays desktop-faithful (tags row = accent, other properties = neutral).
//
// The geometry pins below are the DEFAULT assertions, and desktop's geometry (the 0.875em input
// size plus 7.39px / 22.75px / ≈17px) is the negative control - see the last case in this file,
// which injects the desktop size back and requires the pin to go RED.
//
// Rollback: the CSS and these pins live in one commit (`feat(web): 属性胶囊放大（业主 2026-10-20
// 选 B；唯一有意偏离桌面）`), so `git revert <that sha>` puts the parity tree (and the parity pins)
// back byte for byte and leaves the suite green (measured 10/10 on 800d8562).
//
// These assertions pin the *source* contract in `src/app/assets/app.css`; the resolved pixel
// geometry is measured against real Chromium by `evidence/probe-note-props-pills.mjs` and recorded
// in the lane's `pills-r2.json` / `pills-*-r2.png`.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const cssUrl = new URL("../src/app/assets/app.css", import.meta.url);
const css = fs.readFileSync(cssUrl, "utf8");

// The property row's own font size (`.preview .properties`), i.e. what the pill would inherit if
// it did not restate desktop's `--metadata-input-font-size`.
const ROW_FONT_PX = 13;
// Desktop `--metadata-input-font-size: var(--font-smaller)` = 0.875em ⇒ the pill's own size.
const DESKTOP_INPUT_EM = 0.875;
const PILL_FONT_PX = ROW_FONT_PX * DESKTOP_INPUT_EM; // 11.375

// The pin the whole cut rests on, as a predicate: the pill must not restate a font size, so it
// rides the 13px property row instead of desktop's 0.875em input size. It stays a function so the
// negative control at the bottom of this file can exercise it against an injected mutation.
function ridesRowFontSize(body) {
  return !/font-size\s*:/.test(body);
}

function ruleBlock(selectorFragment) {
  const start = css.indexOf(selectorFragment);
  assert.notEqual(start, -1, `missing rule: ${selectorFragment}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `unterminated rule: ${selectorFragment}`);
  return { selector: css.slice(start, open).trim(), body: css.slice(open + 1, close) };
}

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `missing token --${name}`);
  return match[1].trim();
}

function tokenBlock(name) {
  const index = css.indexOf(`--${name}:`);
  assert.notEqual(index, -1, `missing token --${name}`);
  const open = css.lastIndexOf("{", index);
  const close = css.indexOf("}", index);
  return css.slice(open + 1, close);
}

const pillRule = ruleBlock(".preview .metadata-property-value .multi-select-pill,");
const plainRule = ruleBlock(".preview .metadata-property-value .multi-select-pill:not([data-tag]),");
const contentRule = ruleBlock(".preview .metadata-property-value .multi-select-pill-content,");
const themeTokens = tokenBlock("tag-background");

test("property pills ride the 13px row size (the owner-approved enlargement)", () => {
  assert.equal(ridesRowFontSize(pillRule.body), true, "the pill rides the row instead of desktop's 0.875em input size");
  assert.doesNotMatch(pillRule.body, /min-height\s*:/, "height must come from line-height + padding, not a min-height squeeze");
  // The properties container is the row the pill inherits from; it must stay at the row size.
  assert.match(css, /\.preview \.properties \{[^}]*font-size: var\(--metadata-input-font-size, 13px\)/, "the properties table must stay at the row font size");
  assert.equal(token("font-smaller"), `${DESKTOP_INPUT_EM}em`);
  assert.ok(Math.abs(PILL_FONT_PX - 11.375) < 0.01, "unchanged: desktop's --metadata-input-font-size semantics (0.875em at the 13px row) is the fallback");
});

test("property pills take the row's em inset (8.45px, the enlargement)", () => {
  assert.equal(token("pill-padding-x"), "0.65em");
  assert.match(pillRule.body, /padding:\s*var\(--pill-padding-y\) var\(--pill-padding-x\)/, "the horizontal inset must be the em-based pill padding");
  const inset = Number.parseFloat(token("pill-padding-x")) * ROW_FONT_PX;
  assert.ok(Math.abs(inset - 8.45) <= 0.05, `inline inset must land at 8.45px ± 0.05 (the enlargement), got ${inset}`);
  // The parity geometry `800d8562` ships resolves the same token at the pill's own 0.875em ⇒ 7.39px.
  const desktopInset = Number.parseFloat(token("pill-padding-x")) * PILL_FONT_PX;
  assert.ok(Math.abs(desktopInset - 7.39) <= 0.05, "negative control: the parity geometry lands at 7.39px");
});

test("the pill box height comes from the row size plus the accent outline (≈21.5px)", () => {
  assert.match(pillRule.body, /line-height:\s*1/);
  assert.equal(token("pill-padding-y"), "0.25em");
  // line-height + 2 × --pill-padding-y at 13px + the 1px --tag-border-color outline = 21.5px.
  const box = ROW_FONT_PX * (1 + 2 * Number.parseFloat(token("pill-padding-y"))) + 2;
  assert.ok(Math.abs(box - 21.5) < 0.1, `expected ≈21.5px (probe: 21.5 reading / 22.5 Live), got ${box}`);
});

// Round 2, branch ⓐ: a `tags` row is accent-skinned on desktop (`@390969`), and the pill keeps
// that skin at desktop's own size.
test("tags property pills paint the accent #tag skin, not the neutral --pill-* surface", () => {
  assert.match(pillRule.body, /background:\s*var\(--tag-background\)/, "the tags pill background must be the accent tag background");
  assert.match(pillRule.body, /color:\s*var\(--tag-color\)/, "the tags pill text must be the accent tag colour");
  assert.match(pillRule.body, /border: 1px solid var\(--tag-border-color\)/, "the enlargement candidate carries desktop's accent outline too");
  assert.doesNotMatch(pillRule.body, /--pill-(background|color|border)/, "the neutral pill surface is the non-tags branch, not the tags one");
  const tagHover = ruleBlock(".preview .metadata-property-value .multi-select-pill[data-tag]:hover");
  assert.match(tagHover.body, /background:\s*var\(--tag-background-hover\)/, "hover must keep the accent tag wash");
  assert.match(tagHover.body, /color:\s*var\(--tag-color-hover\)/);
});

// Round 2, branch ⓑ: desktop `@388435` leaves every other multi-select property (aliases,
// cssclasses, any list property) as plain inline text — no inset, no outline, neutral colour.
test("non-tags property pills stay plain, like desktop @388435", () => {
  assert.match(plainRule.selector, /^\.preview \.metadata-property-value \.multi-select-pill:not\(\[data-tag\]\),$/m);
  assert.match(plainRule.selector, /\.cm-live-properties \.cm-live-property-pills \.cm-live-tag-pill:not\(:has\(> span\[data-tag\]\)\)$/m, "the Live preview pill must be in the same block as the reader pill");
  assert.match(plainRule.body, /padding:\s*0/, "desktop sets --pill-padding-x/y to 0 for non-tags properties");
  assert.match(plainRule.body, /border:\s*0/, "the plain branch must undo the candidate's 1px accent outline");
  assert.match(plainRule.body, /background:\s*var\(--pill-background\)/, "the plain branch keeps the neutral, transparent pill surface");
  assert.match(plainRule.body, /color:\s*inherit/, "non-tags values keep the neutral inherited text colour");
  assert.doesNotMatch(plainRule.body, /--tag-/, "the plain branch must not borrow the accent tag skin");
});

test("the 2em pill radius resolves against the row size (26px, the enlargement)", () => {
  assert.match(pillRule.body, /border-radius:\s*var\(--pill-radius\)/);
  assert.equal(token("pill-radius"), "2em");
  assert.ok(Math.abs(Number.parseFloat(token("pill-radius")) * ROW_FONT_PX - 26) < 0.05, "2em at the 13px row lands at 26px (parity geometry: 22.75px)");
});

test("inline #tags in the body keep the accent skin", () => {
  const inlineTag = ruleBlock(".preview .tag, .preview .property-pill");
  assert.match(inlineTag.body, /background:\s*var\(--tag-background\)/);
  assert.match(inlineTag.body, /color:\s*var\(--tag-color\)/);
  assert.match(inlineTag.body, /font-size:\s*var\(--tag-size\)/);
});

test("reading view and Live Preview share one pill rule", () => {
  assert.match(pillRule.selector, /^\.preview \.metadata-property-value \.multi-select-pill,$/m);
  assert.match(pillRule.selector, /\.cm-live-properties \.cm-live-property-pills \.cm-live-tag-pill$/m, "the Live preview pill must be in the same block as the reader pill");
  const liveHover = ruleBlock(".cm-live-properties .cm-live-property-pills .cm-live-tag-pill:has(> span[data-tag]):hover");
  assert.match(liveHover.body, /var\(--tag-background-hover\)/);
});

// Lane note-pills-gap: the reading view lays a multi-value property row out through desktop's
// `.multi-select-container` (`app.css`: `display: inline-flex; vertical-align: top; flex-wrap:
// wrap; flex: 1 1 auto; gap: var(--size-2-3); min-height: var(--input-height)`), and
// `--size-2-3: 6px`. This repo has no `--size-2-3` of its own, so the gap is written as the literal
// 6px that token resolves to, in BOTH axes (`gap`, never a one-axis `row-gap` magic number).
const containerRule = ruleBlock(".preview .metadata-property-value .multi-select-container");

test("the reading multi-select row is desktop's 6px-gapped wrapping flex container", () => {
  assert.match(containerRule.body, /display:\s*inline-flex/);
  assert.match(containerRule.body, /flex-wrap:\s*wrap/);
  assert.match(containerRule.body, /align-items:\s*center/);
  assert.match(containerRule.body, /gap:\s*6px;/, "desktop --size-2-3 resolves to 6px; both axes come from one `gap`");
  assert.doesNotMatch(containerRule.body, /(?:row|column)-gap\s*:/, "no per-axis magic number");
});

// Lane pill-max-width: desktop ALSO clamps each pill and gives it a wrapping content box
// (`app.css@294527` `.multi-select-pill{max-width:calc(100% - var(--size-2-3) - 1ch)}`,
// `app.css@295174` `.multi-select-pill-content{word-break:break-word;overflow:hidden}`). Without the
// pair, one very long tag/alias value pushed the whole value column out of the row.
test("property pills clamp to the row like desktop (max-width - 6px - 1ch)", () => {
  assert.match(pillRule.body, /max-width:\s*calc\(100% - 6px - 1ch\);/, "desktop --size-2-3 resolves to 6px, plus desktop's 1ch remove-button reserve");
  assert.doesNotMatch(pillRule.body.replace(/\/\*[\s\S]*?\*\//g, ""), /var\(--size-2-3\)/, "the declaration uses the resolved 6px, not a token this repo does not declare");
});

test("the pill's clamp lands on desktop's wrapping `.multi-select-pill-content` box", () => {
  assert.match(contentRule.selector, /^\.preview \.metadata-property-value \.multi-select-pill-content,$/m);
  assert.match(contentRule.selector, /\.cm-live-properties \.cm-live-property-pills \.multi-select-pill-content$/m, "both faces share one content rule");
  assert.match(contentRule.body, /overflow:\s*hidden/);
  assert.match(contentRule.body, /word-break:\s*break-word/);
  assert.match(contentRule.body, /white-space:\s*normal/, "the pill body is nowrap, so the content box must opt back into wrapping or min-width:auto outranks max-width");
  // Desktop has NO `text-overflow` on this box: an over-long value wraps (pill grows taller), it is
  // not ellipsised. The only ellipsis desktop puts on a pill content box is the `.external-link` /
  // `.internal-link` branch (`@390161`), which a property pill (a plain div, no link class) never hits.
  assert.doesNotMatch(contentRule.body, /text-overflow/, "no invented `…`: desktop wraps here");
});

test("the U13 click contract on property tag pills is untouched", () => {
  assert.match(css, /\.preview \.metadata-property-value \.multi-select-pill\[data-tag\] \{ cursor: pointer; \}/);
  assert.match(css, /\.cm-live-properties \.cm-live-property-pills \.cm-live-tag-pill > span\[data-tag\] \{ cursor: pointer; \}/);
});

// No empty-token drift: the neutral pill vocabulary stays declared next to the accent tag
// skin (desktop's own fallback set, pinned by test/tag-token-scope.test.js), and the round-1
// neutralisation of `--pill-background-hover` must not come back.
test("the neutral pill tokens stay in the same theme block as the tag tokens", () => {
  assert.match(themeTokens, /--pill-background: transparent;/);
  assert.match(themeTokens, /--pill-background-hover: transparent;/);
  assert.match(themeTokens, /--pill-color: var\(--text-muted\);/);
});

// Negative control in the default collection: the enlargement pin has teeth. Putting desktop's own
// input size back into the committed rule (`--metadata-input-font-size: var(--font-smaller)` =
// 0.875em, the geometry the parity cut 800d8562 ships) must turn `ridesRowFontSize` red. The same
// mutation at the file level (rewriting src/app/assets/app.css in place) is case N1 of
// `node ../negctl.mjs`, run from repo/app.
test("negative control: re-injecting desktop's 0.875em input size turns the enlargement pin red", () => {
  assert.equal(ridesRowFontSize(pillRule.body), true, "the committed pill rides the 13px row");
  const literal = pillRule.body.replace(/^/, `  font-size: ${DESKTOP_INPUT_EM}em;\n`);
  assert.match(literal, /font-size:\s*0\.875em;/, "the mutation must be desktop's input size");
  assert.equal(ridesRowFontSize(literal), false, "the injected 0.875em must turn the enlargement pin red");
  assert.equal(ridesRowFontSize(`  font-size: var(--tag-size);\n${pillRule.body}`), false, "desktop's own token resolves to the same 0.875em and must be red too");
});
