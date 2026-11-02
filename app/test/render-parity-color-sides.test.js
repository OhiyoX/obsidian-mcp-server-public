// Offline guards for the two-sided colour sampling of the render-parity theme
// gates (issue #360).
//
// The Chromium gate (`scripts/render-parity-phase1-community.mjs`) owns the
// computed-paint proof on both sides. These fast checks keep the SIDE MACHINERY
// honest without a browser:
//
//   1. every literal the side invariants pin is still declared in app.css, and
//      the pinned light/dark values differ (a side that samples the other side's
//      cascade cannot pass);
//   2. the declared-token comparison accepts the declared value and rejects a
//      different value, an empty value and a missing token;
//   3. the observable colour-state check rejects a state that is not the
//      requested side (missing class, stale other-side class, wrong
//      color-scheme, wrong select value);
//   4. side separation rejects a measurement that came out identical on both
//      sides;
//   5. the gate runs light BEFORE dark, requests each side through the
//      production control, and keeps the light pass (a "dark replaced light"
//      regression must be visible as a source change).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DARK_FIXTURE_RELATIVE,
  DARK_FIXTURE_TOKENS,
  DECLARED_SIDE_BASE_COLORS,
  DECLARED_SIDE_TOKENS,
  SIDES,
  colorSideProblems,
  declaredSideTokenMismatches,
  setColorMode,
  sideSeparationProblems,
  validateColorSideDeclarations,
  validateDarkFixture,
} from "../scripts/render-parity-color-sides.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8").replace(/\r\n/g, "\n");

const appCss = read("src/app/assets/app.css");
const gate = read("scripts/render-parity-phase1-community.mjs");

test("light is sampled first and dark is not a replacement for it", () => {
  assert.deepEqual(SIDES, ["light", "dark"]);
  // One pass per side, both sides requested through the same production control.
  assert.match(gate, /for \(const mode of sides\) \{/);
  assert.match(gate, /side\.color = await setColorMode\(page, mode\);/);
  assert.match(gate, /const sides = requested\.length \? requested : SIDES;/);
  // The light-only→two-sided change must not delete the light fallback pass.
  assert.match(gate, /const fallback = await surveyFallback\(page, \{ kinds: KINDS, tokens: fallbackTokenNames, sleep, setMode \}\);/);
  assert.match(gate, /fallbackTokenNames[\s\S]{0,200}DECLARED_SIDE_TOKENS/);
});

test("app.css still declares every literal the side invariants pin", () => {
  assert.deepEqual(validateColorSideDeclarations(appCss), []);
  for (const entry of DECLARED_SIDE_TOKENS) {
    assert.ok(appCss.includes(entry.declaration), `app.css must declare ${entry.declaration}`);
    assert.notEqual(entry.light, entry.dark, `${entry.token} must differ between the sides`);
    assert.ok(appCss.includes(entry.light), `app.css must carry ${entry.light}`);
    assert.ok(appCss.includes(entry.dark), `app.css must carry ${entry.dark}`);
  }
  for (const color of DECLARED_SIDE_BASE_COLORS) assert.ok(appCss.includes(color), `app.css must carry ${color}`);
  // Drift is RED, not silently accepted.
  const broken = appCss.replace("--color-base-100: #dadada;", "--color-base-100: #000000;");
  assert.ok(validateColorSideDeclarations(broken).some((entry) => entry.includes("#dadada")), "a broken dark base colour must fail validation");
});

test("the declared tokens are asserted against the app's own declaration", () => {
  const tokens = { "--text-normal": "#dadada", "--background-primary": "#1c1c1c", "--text-faint": "#666666" };
  assert.deepEqual(declaredSideTokenMismatches("dark", tokens), []);
  assert.deepEqual(declaredSideTokenMismatches("light", { "--text-normal": "#222222", "--background-primary": "#ffffff", "--text-faint": "#ababab" }), []);
  // The light values on the dark side are the regression this pins.
  const wrong = declaredSideTokenMismatches("dark", { "--text-normal": "#222222", "--background-primary": "#1c1c1c", "--text-faint": "#666666" });
  assert.equal(wrong.length, 1);
  assert.deepEqual(wrong[0], { side: "dark", token: "--text-normal", expected: "#dadada", actual: "#222222" });
  assert.equal(declaredSideTokenMismatches("dark", { ...tokens, "--text-normal": "" }).length, 1);
  const missing = declaredSideTokenMismatches("dark", { "--background-primary": "#1c1c1c", "--text-faint": "#666666" });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].actual, "missing");
});

test("the observable colour state must be the requested side", () => {
  const dark = { side: "dark", selectValue: "dark", htmlClass: ["theme-dark"], bodyClass: ["is-desktop", "theme-dark"], colorScheme: "dark", prefersDark: false };
  assert.deepEqual(colorSideProblems("dark", dark), []);
  const light = { side: "light", selectValue: "light", htmlClass: ["theme-light"], bodyClass: ["is-desktop", "theme-light"], colorScheme: "light", prefersDark: false };
  assert.deepEqual(colorSideProblems("light", light), []);
  // A state that never reached the requested side, or that kept the other class.
  assert.equal(colorSideProblems("dark", light).length, 6);
  assert.ok(colorSideProblems("dark", { ...dark, bodyClass: ["is-desktop"] }).some((entry) => entry.includes("<body>")));
  assert.ok(colorSideProblems("dark", { ...dark, htmlClass: ["theme-dark", "theme-light"] }).some((entry) => entry.includes("still carries theme-light")));
  assert.ok(colorSideProblems("dark", { ...dark, colorScheme: "light" }).some((entry) => entry.includes("color-scheme")));
  assert.ok(colorSideProblems("dark", { ...dark, selectValue: "light" }).some((entry) => entry.includes("#color-mode")));
});

test("a side that sampled the other side's values is rejected", () => {
  const same = { light: { "--text-normal": "#dadada" }, dark: { "--text-normal": "#dadada" } };
  const problems = sideSeparationProblems(same);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /--text-normal computes the same value on both sides/);
  assert.deepEqual(sideSeparationProblems({ light: { "--text-normal": "#222222" }, dark: { "--text-normal": "#dadada" } }), []);
});

test("setColorMode refuses a side the app does not offer", async () => {
  await assert.rejects(() => setColorMode({}, "purple"), /unknown colour mode purple/);
});

test("the self-built dark fixture declares distinguishable light/dark tokens (#360)", () => {
  const fixture = read(DARK_FIXTURE_RELATIVE);
  assert.deepEqual(validateDarkFixture(fixture), []);
  for (const entry of DARK_FIXTURE_TOKENS) {
    assert.notEqual(entry.light, entry.dark, `${entry.token} must differ between the declarations`);
    assert.ok(fixture.includes(entry.light) && fixture.includes(entry.dark), `${entry.token} values must be declared`);
  }
  // A dark declaration that collapses onto the light one, disappears, or reuses
  // the app's own dark fallback is RED: the fixture is the whole dark proof.
  assert.ok(validateDarkFixture(fixture.replace("rgb(187, 170, 153)", "rgb(17, 34, 51)")).length >= 1, "a dark value equal to the light one must fail");
  assert.ok(validateDarkFixture(fixture.replace(/^\.theme-dark \{/m, ".theme-x {")).length >= 1, "losing the .theme-dark block must fail");
  assert.ok(validateDarkFixture(fixture.replace("rgb(187, 170, 153)", "#c3adff")).length >= 1, "reusing the app dark fallback must fail");
  // The light values must match <body>, not only <html>. app.css's layered
  // `:root, .theme-light` fallback also matches <body> through its theme class,
  // so a `:root`-only light declaration is shadowed on every document host
  // (measured on the real gate: html computed the theme value while
  // <body>/.preview computed the app fallback).
  const rootOnly = fixture.replace(/^\.theme-light \{/m, ":root {");
  assert.ok(rootOnly.includes(":root {"), "the :root-only counter-fixture must have been built");
  assert.ok(validateDarkFixture(rootOnly).some((problem) => /body-matching scope/.test(problem)), "a :root-only light scope must fail");
  // The community gate installs it on the CI path (no COMMUNITY_THEMES_PATH).
  assert.match(gate, /DARK_FIXTURE_RELATIVE/);
  assert.match(gate, /validateDarkFixture\(darkFixtureCss\)/);
  assert.match(gate, /realThemes\.push\(\{ name: DARK_FIXTURE_THEME_NAME/);
  // And the side summary reports it, so a dark pass cannot hide behind the fallback.
  assert.match(read("scripts/render-parity-community-summary.mjs"), /selfbuilt:/);
});
