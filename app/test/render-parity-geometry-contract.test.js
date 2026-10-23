// Phase 1-B offline guards for the "shared geometry token" gate.
//
// The bounded Chromium gate (`scripts/render-parity-phase1-geometry.mjs` and the
// in-suite check) owns the measured-gap proof. These fast checks keep the tokens,
// the two host adapters, the probe document and the fixture from silently
// drifting apart between runs:
//
//   1. every shared geometry token is declared once in app.css (theme-overridable)
//      and consumed by BOTH the Reader and the Live adapter;
//   2. the duplicated magic numbers the tokens replaced are gone;
//   3. the geometry fixture literally declares every sentinel the gate asserts,
//      and the allowlist keeps tolerance tiny with no environment exceptions;
//   4. each heading/block pair in the probe document is DIRECTLY adjacent, so the
//      measured gap is the spacing token rather than a source blank-line spacer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADJACENCIES,
  GEOMETRY_ALLOWLIST_RELATIVE,
  GEOMETRY_EXPECTED,
  GEOMETRY_FIXTURE_RELATIVE,
  GEOMETRY_PROBE_SOURCE,
  GEOMETRY_TOKENS,
  TABLES,
  validateGeometryFixture,
} from "../scripts/render-parity-geometry-core.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8").replace(/\r\n/g, "\n");
const appCss = read("src/app/assets/app.css");
const themeJs = read("frontend/app/features/editor/extensions/theme.js");

test("every shared geometry token is declared in app.css for both themes", () => {
  for (const token of GEOMETRY_TOKENS) {
    assert.match(appCss, new RegExp(`\\s${token}:\\s*\\S`), `app.css must declare ${token}`);
  }
  // Declared in a :root-scoped block (app.css loads BEFORE the Vault's community
  // theme.css), so a theme can override the same names through the cascade.
  for (const token of ["--md-heading-space-before", "--md-heading-space-after", "--md-table-box-sizing"]) {
    const index = appCss.indexOf(`${token}:`);
    assert.ok(index > 0, `${token} must be declared`);
    const open = appCss.lastIndexOf("{", index);
    const close = appCss.lastIndexOf("}", open);
    const selector = appCss.slice(close + 1, open).trim();
    assert.ok(selector.includes(":root"), `${token} must be declared on a :root selector, found \"${selector}\"`);
  }
});

test("Reader and Live adapters consume the same heading geometry tokens", () => {
  // Reader: headings own before/after space; the next block's top margin and the
  // previous block's bottom margin must not collapse into a second number.
  assert.match(
    appCss,
    /\.preview h1, \.preview h2, \.preview h3, \.preview h4, \.preview h5, \.preview h6 \{[^}]*margin: var\(--md-heading-space-before\) 0 var\(--md-heading-space-after\)/s,
  );
  assert.match(appCss, /\.preview :is\(h1, h2, h3, h4, h5, h6\) \+ :is\(p, ul, ol, blockquote, pre, \.table-scroll, table\) \{ margin-top: 0; \}/);
  assert.match(
    appCss,
    /\.preview :is\(p, ul, ol, blockquote, pre, \.table-scroll, table\):has\(\+ :is\(h1, h2, h3, h4, h5, h6\)\) \{ margin-bottom: 0; \}/,
  );
  // Live: the same after-space as measured line padding, the same before-space as
  // line padding on every heading level, and the fold marker follows the token.
  assert.match(appCss, /\.cm-line\.cm-live-heading \{[^}]*padding-bottom: var\(--md-heading-space-after, \.55em\)/s);
  for (const level of [1, 2, 3, 4, 5, 6]) {
    assert.match(themeJs, new RegExp(`"\\.cm-live-h${level}": \\{ paddingTop: "var\\(--md-heading-space-before, 1\\.25em\\)" \\}`));
  }
  // The fold indicator is inline (desktop app.css@8259), so the heading's own line
  // box places it: no per-level offset arithmetic may come back.
  assert.equal(/cm-fold-h[1-6][^\n]*marginTop/.test(themeJs), false, "fold geometry must come from the line box, not a per-level calc");
  assert.match(themeJs, /"\.cm-fold-indicator": \{[^}]*display: "inline-block"/s);
  // Generic adjacent-block spacing family.
  assert.match(appCss, /\.preview p \{ margin: var\(--md-block-gap\) 0; \}/);
  assert.match(appCss, /\.preview li \{ margin: var\(--md-list-item-gap\) 0; \}/);
  assert.match(appCss, /\.preview blockquote \{\s*margin: var\(--md-block-gap\) 0;/);
});

test("the magic numbers the shared tokens replaced are gone", () => {
  assert.equal(appCss.includes("margin: 1.25em 0 .55em"), false, "Reader heading margins must come from the token");
  assert.equal(appCss.includes(".preview p { margin: .72em 0; }"), false, "Reader paragraph gap must come from the token");
  assert.equal(appCss.includes(".preview li { margin: .25em 0; }"), false, "Reader list gap must come from the token");
  assert.equal(/\.cm-line\.cm-live-heading \{[^}]*padding-bottom: \.55em/s.test(appCss), false, "Live heading after-space must come from the token");
  for (const literal of ['paddingTop: ".55em"', 'paddingTop: ".48em"', 'paddingTop: ".42em"', 'paddingTop: ".36em"', 'paddingTop: ".3em"', 'paddingTop: ".25em"']) {
    assert.equal(themeJs.includes(literal), false, `${literal} must be replaced by the shared token`);
  }
});

test("Reader and Live table hosts consume the same table geometry tokens", () => {
  assert.match(appCss, /\.preview \.table-scroll \{[^}]*box-sizing: var\(--md-table-box-sizing, border-box\)[^}]*overflow-x: var\(--md-table-overflow-x, hidden\)/s);
  assert.match(appCss, /\.preview \.table-scroll\[data-table-overflow="true"\] \{ overflow-x: var\(--md-table-overflow-x-active, auto\); \}/);
  assert.match(appCss, /\.preview table \{[^}]*box-sizing: var\(--md-table-box-sizing, border-box\)[^}]*width: max\(var\(--md-table-inline-size, 100%\), var\(--table-layout-width, 0px\)\)/s);
  assert.match(appCss, /\.cm-table-viewport \{[^}]*box-sizing: var\(--md-table-box-sizing, border-box\)[^}]*overflow-x: var\(--md-table-overflow-x, hidden\)/s);
  assert.match(appCss, /\.cm-table-viewport\[data-table-overflow="true"\] \{\s*overflow-x: var\(--md-table-overflow-x-active, auto\);/);
  assert.match(appCss, /\.cm-live-table-element \{[^}]*box-sizing: var\(--md-table-box-sizing, border-box\)[^}]*width: max\(var\(--md-table-inline-size, 100%\), var\(--table-layout-width, 0px\)\)/s);
});

test("geometry fixture declares every sentinel and the allowlist stays strict", () => {
  const css = read(GEOMETRY_FIXTURE_RELATIVE);
  assert.deepEqual(validateGeometryFixture(css), []);
  // The fixture must be a plausible theme (token overrides only), not a Web copy.
  assert.doesNotMatch(css, /!important/);
  const allowlist = JSON.parse(read(GEOMETRY_ALLOWLIST_RELATIVE));
  assert.ok(Number(allowlist.tolerancePx) <= 1, "tolerancePx must stay tiny");
  assert.deepEqual(allowlist.knownEnvironmentFailures, []);
});

test("every probe pair is directly adjacent so the gap proves the token", () => {
  const lines = GEOMETRY_PROBE_SOURCE.split("\n");
  const lineIndexOf = (needle) => lines.findIndex((line) => line.includes(needle));
  for (const adj of ADJACENCIES) {
    const heading = lineIndexOf(adj.readerHeading.needle);
    const target = lineIndexOf(adj.readerTarget.needle);
    assert.ok(heading >= 0 && target >= 0, `${adj.id} markers must exist`);
    // The measured gap must not include a source blank-line spacer: no empty line
    // may sit between the heading and its target. (A fenced-code pair legitimately
    // has the ``` fence line in between; that fence is part of the code block.)
    const between = adj.direction === "after" ? lines.slice(heading + 1, target) : lines.slice(target + 1, heading);
    for (const line of between) {
      assert.notEqual(line.trim(), "", `${adj.id}: no blank source line may separate the pair`);
    }
    const direction = Math.sign(target - heading);
    assert.equal(direction, adj.direction === "after" ? 1 : -1, `${adj.id}: the target must sit ${adj.direction} the heading`);
  }
  assert.equal(new Set(ADJACENCIES.map((adj) => adj.id)).size, ADJACENCIES.length, "adjacency ids must be unique");
  assert.equal(TABLES.filter((table) => table.expectOverflow).length, 1, "one table must exercise the overflow policy");
});

test("expectations stay in lockstep with the fixture sentinels", () => {
  const css = read(GEOMETRY_FIXTURE_RELATIVE);
  for (const token of GEOMETRY_TOKENS) {
    const value = GEOMETRY_EXPECTED[token];
    assert.ok(value != null, `GEOMETRY_EXPECTED.${token} is missing`);
    assert.ok(css.includes(`${token}: ${value};`), `fixture must declare ${token}: ${value}`);
  }
});
