// Colour-side sampling shared by the render-parity theme gates (issue #360).
//
// Phase 1-C used to sample ONE side of the theme: it wrote
// `.obsidian/appearance.json` without a `colorMode`, so the server rendered
// `<html class="theme-light">`, the app resolved "system" and headless Chromium's
// default `prefers-color-scheme: light` kept it there. Every assertion therefore
// proved light-mode paint only, while a community theme's dark branch (or the
// app's dark fallback layer) was never measured.
//
// This module makes the side an explicit, reproducible input:
//
//   * "dark" is the app's own dark state, not a hand-patched class. The gate
//     drives the production `#color-mode` <select> (the same control
//     `features/theme/theme.js` wires), and then requires the OBSERVABLE result
//     of that control: both `document.documentElement` and `document.body` carry
//     `theme-dark` (and not `theme-light`) AND the root `color-scheme` is `dark`.
//     That excludes `prefers-color-scheme` as an accidental input (the gate never
//     relies on the system preference), which is what makes the sample
//     reproducible on any runner.
//   * the app's own light/dark fallback declarations are pinned as literals and
//     re-read from `app.css`, so "dark really is in force" is asserted against
//     the DECLARATION (`--text-normal: var(--color-base-100)` with
//     `--color-base-100: #dadada` in the `.theme-dark` block), not against a
//     second measurement of the same live value. Breaking the dark declaration
//     therefore fails, instead of silently moving both sides of the comparison.
//
// Everything here is declaration-based: no pixel, no geometry, no font metric.
// The measured quantities are computed custom-property values, which the
// cascade defines exactly.

export const SIDES = ["light", "dark"];
export const COLOR_MODE_SELECT = "#color-mode";

// Root tokens whose value must differ between the two sides, with the literal
// each side's chain resolves to. Derived from app.css:
//   `:root, .theme-light { --color-base-00: #ffffff; --color-base-50: #ababab;
//                          --color-base-100: #222222; }`
//   `.theme-dark        { --color-base-00: #1c1c1c; --color-base-50: #666666;
//                          --color-base-100: #dadada; }`
//   both blocks: `--text-normal: var(--color-base-100);`
//                `--background-primary: var(--color-base-00);`
//                `--text-faint: var(--color-base-50);`
// A custom property computes to the SUBSTITUTED TEXT of the chain, so the pinned
// values are the base colours themselves, not an `rgb()` serialization.
// `validateColorSideDeclarations` fails if any of those declarations disappears,
// so these literals cannot drift away from the file that declares them.
export const DECLARED_SIDE_TOKENS = [
  { token: "--text-normal", declaration: "--text-normal: var(--color-base-100);", light: "#222222", dark: "#dadada" },
  { token: "--background-primary", declaration: "--background-primary: var(--color-base-00);", light: "#ffffff", dark: "#1c1c1c" },
  { token: "--text-faint", declaration: "--text-faint: var(--color-base-50);", light: "#ababab", dark: "#666666" },
];

/** The base colours both sides pin, as declared in app.css. */
export const DECLARED_SIDE_BASE_COLORS = [
  "--color-base-00: #ffffff;", "--color-base-00: #1c1c1c;",
  "--color-base-50: #ababab;", "--color-base-50: #666666;",
  "--color-base-100: #222222;", "--color-base-100: #dadada;",
];

const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** app.css must still declare every literal the side invariants pin. */
export function validateColorSideDeclarations(css) {
  const text = String(css ?? "").replace(/\s+/g, " ");
  const problems = [];
  for (const color of DECLARED_SIDE_BASE_COLORS) if (!text.includes(color)) problems.push(`app.css no longer declares ${color}`);
  for (const entry of DECLARED_SIDE_TOKENS) if (!text.includes(entry.declaration)) problems.push(`app.css no longer declares ${entry.declaration}`);
  for (const mode of SIDES) {
    if (!text.includes(`.theme-${mode}`)) problems.push(`app.css no longer declares a .theme-${mode} block`);
  }
  return problems;
}

/**
 * Drive the production colour-mode control and require its observable result.
 * Returns the observed state so the caller can store it in its report.
 */
export async function setColorMode(page, mode) {
  if (!SIDES.includes(mode)) throw new Error(`unknown colour mode ${mode}`);
  await page.evaluate((wanted) => {
    const select = document.querySelector("#color-mode");
    if (!select) throw new Error("the #color-mode control is missing");
    select.value = wanted;
    select.dispatchEvent(new Event("change"));
  }, mode);
  await page.waitForFunction((wanted) => {
    const has = (node) => node.classList.contains(`theme-${wanted}`) && !node.classList.contains(`theme-${wanted === "dark" ? "light" : "dark"}`);
    return has(document.documentElement) && has(document.body) && document.documentElement.style.colorScheme === wanted;
  }, mode, { timeout: 10000 });
  return page.evaluate((wanted) => ({
    side: wanted,
    selectValue: document.querySelector("#color-mode")?.value ?? null,
    htmlClass: [...document.documentElement.classList].sort(),
    bodyClass: [...document.body.classList].sort(),
    colorScheme: document.documentElement.style.colorScheme,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  }), mode);
}

/** The observable state the control produced must match the requested side. */
export function colorSideProblems(mode, state) {
  const problems = [];
  const other = mode === "dark" ? "light" : "dark";
  for (const [name, classes] of [["<html>", state?.htmlClass ?? []], ["<body>", state?.bodyClass ?? []]]) {
    if (!classes.includes(`theme-${mode}`)) problems.push(`${name} does not carry theme-${mode} (${classes.join(" ")})`);
    if (classes.includes(`theme-${other}`)) problems.push(`${name} still carries theme-${other} (${classes.join(" ")})`);
  }
  if (state?.colorScheme !== mode) problems.push(`root color-scheme is ${JSON.stringify(state?.colorScheme)}, expected ${JSON.stringify(mode)}`);
  if (state?.selectValue !== mode) problems.push(`#color-mode reads ${JSON.stringify(state?.selectValue)}, expected ${JSON.stringify(mode)}`);
  return problems;
}

/**
 * The declared tokens must compute to the side's pinned value. `tokens` is the
 * live computed map the probe already collects on the note container.
 */
export function declaredSideTokenMismatches(mode, tokens) {
  const mismatches = [];
  for (const entry of DECLARED_SIDE_TOKENS) {
    const expected = entry[mode];
    const actual = tokens?.[entry.token];
    if (actual == null || actual === "") {
      mismatches.push({ side: mode, token: entry.token, expected, actual: actual ?? "missing" });
      continue;
    }
    if (collapse(actual) !== collapse(expected)) mismatches.push({ side: mode, token: entry.token, expected, actual });
  }
  return mismatches;
}

/** A side that samples the other side's values would pass silently: reject it. */
export function sideSeparationProblems(valuesBySide) {
  const problems = [];
  for (const entry of DECLARED_SIDE_TOKENS) {
    const light = valuesBySide.light?.[entry.token];
    const dark = valuesBySide.dark?.[entry.token];
    if (light == null || dark == null) continue;
    if (collapse(light) === collapse(dark)) problems.push(`${entry.token} computes the same value on both sides (${light})`);
  }
  return problems;
}

// The self-built DARK fixture (#360).
//
// The three committed community subsets are LIGHT-ONLY by construction (the
// extractor drops `.theme-dark` rules), so on the dark side they can only prove
// "a light-only subset must not paint dark" plus the app's dark fallback. This
// fixture ships a real `.theme-dark` block whose values are distinguishable from
// both its light values and the app's own dark `--h1-color` fallback, so the
// dark side gets a genuine "the theme's dark declaration is in force" assertion
// that runs in CI without any third-party theme. Its light values use the same
// per-side shape the real subsets use (`.theme-light` / `.theme-dark`, both of
// which match <body>), never `:root` only: app.css's layered `:root, .theme-light`
// fallback matches <body> through its theme class, so a `:root`-only theme value
// would be shadowed on every document host.
export const DARK_FIXTURE_RELATIVE = "test/fixtures/render-parity-dark-fixture.css";
export const DARK_FIXTURE_THEME_NAME = "RenderParitySelfDark";
export const DARK_FIXTURE_TOKENS = [
  { token: "--h1-color", light: "rgb(17, 34, 51)", dark: "rgb(187, 170, 153)", fallbackDark: "#c3adff" },
  { token: "--render-parity-dark-probe", light: "rgb(23, 46, 69)", dark: "rgb(179, 158, 137)", fallbackDark: null },
];

/**
 * The dark fixture must keep a real `.theme-dark` block whose values differ from
 * the light ones (and from the app dark fallback), and its light values must be
 * declared on a scope that matches <body> (`.theme-light`/`body`), not `:root`
 * only. Drift is RED, never silently accepted: the gate calls this before it
 * trusts any dark-side assertion.
 */
export function validateDarkFixture(css) {
  const text = String(css ?? "").replace(/\s+/g, " ");
  const dark = /\.theme-dark\s*\{([^}]*)\}/.exec(text)?.[1] ?? null;
  const problems = [];
  if (dark == null) problems.push(`${DARK_FIXTURE_RELATIVE} no longer declares a .theme-dark block`);
  const lightSection = dark == null ? text : text.replace(dark, " ");
  const lightCode = lightSection.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!/(?:^|[\s,{>])(?:body|\.theme-light)\s*\{/.test(lightCode)) {
    problems.push(`${DARK_FIXTURE_RELATIVE} light tokens must be declared on a body-matching scope (.theme-light or body), not :root only`);
  }
  for (const entry of DARK_FIXTURE_TOKENS) {
    if (collapse(entry.light) === collapse(entry.dark)) problems.push(`${DARK_FIXTURE_RELATIVE} ${entry.token} must differ between its light and dark declarations`);
    if (!lightSection.includes(entry.light)) problems.push(`${DARK_FIXTURE_RELATIVE} no longer declares the light ${entry.token} ${entry.light} outside .theme-dark`);
    if (dark == null) continue;
    if (!dark.includes(entry.dark)) problems.push(`${DARK_FIXTURE_RELATIVE} no longer declares the dark ${entry.token} ${entry.dark} in .theme-dark`);
    if (dark.includes(entry.light)) problems.push(`${DARK_FIXTURE_RELATIVE} .theme-dark must not declare the light ${entry.token} ${entry.light}`);
    if (entry.fallbackDark && dark.includes(entry.fallbackDark)) problems.push(`${DARK_FIXTURE_RELATIVE} .theme-dark must not reuse the app fallback ${entry.fallbackDark} for ${entry.token}`);
  }
  return problems;
}
