// #622 — the property-pill contract must be LIVE, not merely present in the file.
//
// `reader-property-pills.test.js` pins the pill by reading `app.css` as text. Two injections keep
// that text intact while the rendered pill changes, so the old nails stay green:
//
//   1. comment the rule out            (`/* .preview … .multi-select-pill, … */`)
//   2. move it into `@media (max-width:720px)`
//
// This file answers the question the nails actually need — "does this rule apply at every width?" —
// by scanning the stylesheet with `styleRules` (comments stripped, at-rule nesting tracked). The two
// negative controls at the end apply exactly those injections to a copy and require the check to go
// red, so a green run cannot be an artefact of a scanner that never sees a difference.
//
// Scope: the pill rule and the properties row it inherits from. Computed pixels (13px row, 8.45px
// inset, ≈21.5px box) are still only asserted arithmetically from the tokens here; measuring them in
// real Chromium is the other half of #622 and is not claimed by this file.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { styleRules } from "./helpers/css-top-level.mjs";

const css = fs.readFileSync(new URL("../src/app/assets/app.css", import.meta.url), "utf8");

const PILL = ".preview .metadata-property-value .multi-select-pill";
const PROPERTIES = ".preview .properties";

/** Rules whose selector list names `selector` exactly (a `.x, .y { }` list is two selectors). */
function rulesFor(text, selector) {
  return styleRules(text).filter((rule) => rule.selector.split(",").map((part) => part.trim()).includes(selector));
}

function liveRulesFor(text, selector) {
  // `gates` are the at-rules that can switch a rule off (media/supports/container/scope/document);
  // `@layer` is not one, because a layered rule still applies.
  return rulesFor(text, selector).filter((rule) => rule.gates.length === 0);
}

/** Every declaration the pill contract needs, with the reason it is needed. */
const PILL_DECLARATIONS = [
  [/padding:\s*var\(--pill-padding-y\) var\(--pill-padding-x\)/, "the em-based inset (8.45px at the 13px row)"],
  [/line-height:\s*1(?:\.0+)?\s*(?:[;}]|$)/, "the box height comes from line-height, not a min-height"],
  [/all:\s*unset/, "the pill starts from the browser's box, not from the table cell"],
  [/border-radius:\s*var\(--pill-radius\)/, "the pill radius comes from the token"],
  [/white-space:\s*nowrap/, "a pill never wraps"],
  [/box-sizing:\s*border-box/, "`all: unset` reset it; max-width is a budget on the whole pill"],
  [/max-width:\s*calc\(100% - 6px - 1ch\)/, "the remove-button reserve is what keeps the pill inside its cell"],
  [/background:\s*var\(--tag-background\)/, "the tags pill keeps the accent #tag skin"],
  [/color:\s*var\(--tag-color\)/, "and the accent text colour"],
  [/border:\s*1px solid var\(--tag-border-color\)/, "the accent outline is part of the ≈21.5px box"],
];

/** The contract, expressed once so the controls run the same judgement as the positive test. */
function pillContractFailures(bodies) {
  return PILL_DECLARATIONS.filter(([pattern]) => !pattern.test(bodies)).map(([, why]) => why);
}

test("the property pill rule is live at top level, not commented out and not inside a media query", () => {
  const live = liveRulesFor(css, PILL);
  assert.ok(live.length >= 1, `at least one top-level ${PILL} rule must exist, found ${live.length}`);
  // A refactor may split the rule in two; what must hold is that the LIVE declarations still carry
  // the contract (a rule moved into `@media` contributes nothing here).
  const bodies = live.map((rule) => rule.body).join("\n");
  assert.deepEqual(pillContractFailures(bodies), [], "the live pill rules must carry the whole contract");
  assert.doesNotMatch(bodies, /min-height\s*:/, "the height must not come from a min-height squeeze");
});

test("a statement at-rule before a rule does not swallow it", () => {
  // `@charset` / `@layer a, b;` end with `;`, not a block; the next rule must still be read.
  const synthetic = styleRules('@charset "utf-8";\n@layer a, b;\n.a{color:red}\n@media (max-width:720px){.b{color:blue}}');
  assert.deepEqual(synthetic.map((rule) => rule.selector), [".a", ".b"], "both rules are read");
  assert.deepEqual(synthetic.map((rule) => rule.gates), [[], ["@media (max-width:720px)"]]);
});

test("a rule inside @layer still counts as live; @supports is a gate", () => {
  const synthetic = styleRules(".a{color:red}\n@layer base{.a{color:blue}}\n@supports (display:grid){.a{color:green}}");
  const rules = synthetic.filter((rule) => rule.selector === ".a");
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map((rule) => rule.gates.length), [0, 0, 1], "@layer does not gate, @supports does");
});

test("the properties row the pill inherits from is live at top level too", () => {
  const live = liveRulesFor(css, PROPERTIES);
  assert.ok(live.length >= 1, `at least one top-level ${PROPERTIES} rule must exist, found ${live.length}`);
  // Either spelling is the same computed size; the row must be 13px, not 11.375px.
  assert.match(live.map((rule) => rule.body).join("\n"), /font-size:\s*(?:var\(--metadata-input-font-size,\s*13px\)|13px)/, "the row keeps the 13px font size the pill rides");
});

test("negative control 1: a commented-out rule never counts as live", () => {
  // Scanner level: the same rule twice, once live and once inside a comment, is one live rule.
  const synthetic = styleRules(".a{color:red}\n/* .a{color:blue} */\n.b{color:green}");
  assert.deepEqual(synthetic.map((rule) => rule.selector), [".a", ".b"], "the commented-out rule is not reported");
  assert.equal(synthetic[0].body.trim(), "color:red", "and the live one keeps its own body");

  // Real file: the pill rule carries inner comments, so wrapping it as-is would end at the first
  // inner `*/` and leave a live fragment. Drop those inner comments first, then comment the rule
  // out — the mutation a developer actually performs.
  const [rule] = liveRulesFor(css, PILL);
  assert.ok(rule, "the control needs the rule to exist first");
  const plain = css.slice(rule.start, rule.end).replace(/\/\*[\s\S]*?\*\//g, " ");
  const commented = `${css.slice(0, rule.start)}/*${plain}*/${css.slice(rule.end)}`;
  assert.equal(liveRulesFor(commented, PILL).length, 0, "a commented-out rule must not count as live");
  assert.equal(rulesFor(commented, PILL).length, 0, "and it must not count as a rule at all");
});

test("negative control 2: moving the rule into a media query drops it from the top level", () => {
  const [rule] = liveRulesFor(css, PILL);
  assert.ok(rule, "the control needs the rule to exist first");
  const broken = `${css.slice(0, rule.start)}@media (max-width:720px){${css.slice(rule.start, rule.end)}}${css.slice(rule.end)}`;
  assert.equal(liveRulesFor(broken, PILL).length, 0, "a rule inside @media must not count as top-level");
  const moved = rulesFor(broken, PILL);
  assert.equal(moved.length, 1, "the scanner still sees it, so the failure names the real cause");
  assert.deepEqual(moved[0].conditions, ["@media (max-width:720px)"], "and reports the condition it now sits under");
  assert.deepEqual(moved[0].gates, ["@media (max-width:720px)"], "a media query is a gate");
});

test("negative control 3: dropping one declaration turns the contract red", () => {
  const [rule] = liveRulesFor(css, PILL);
  assert.ok(rule, "the control needs the rule to exist first");
  const broken = `${css.slice(0, rule.start)}${css.slice(rule.start, rule.end).replace(/background:\s*var\(--tag-background\);/, "")}${css.slice(rule.end)}`;
  const [after] = liveRulesFor(broken, PILL);
  assert.ok(after, "the rule itself is still there — only the declaration went");
  assert.throws(() => {
    for (const [pattern, why] of PILL_DECLARATIONS) assert.match(after.body, pattern, why);
  }, /accent #tag skin/, "the same contract must reject the rule without the accent skin");
});
