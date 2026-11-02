// Gate: the Web fallback layer must not drift from desktop Obsidian unnoticed.
//
// `src/app/assets/app.css` `@layer web-theme-fallback` is hand-maintained. Its
// values were copied from Obsidian at some point and nothing has checked them
// since; the first run of this gate found 52 divergences across 30 tokens,
// including stale literal colours and six heading colours that no desktop
// surface produces. See the allowlist fixture for the classification.
//
// The baseline is derived from the `app.css` inside the locally installed
// Obsidian (`scripts/extract-obsidian-base-tokens.mjs`), pinned by version and
// sha256. Regenerating it is a deliberate, reviewable event; this test only
// guards the committed state.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ALLOWLIST_CLASSES,
  DESKTOP_UNDECLARED,
  DRIFT,
  MATCH,
  compareTokenClaims,
  evaluateBaseTokenGate,
  extractDefaultTokens,
  extractLayerTokenClaims,
  flattenDefaults,
  normalizeTokenValue,
  parseStylesheetRules,
  summarizeRows,
} from "../scripts/obsidian-desktop-oracle.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, "test/fixtures/obsidian-desktop-base-tokens.json");
const allowlistPath = path.join(appRoot, "test/fixtures/obsidian-desktop-base-tokens-allowlist.json");
const webCssPath = path.join(appRoot, "src/app/assets/app.css");
const FALLBACK_LAYER = "web-theme-fallback";

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

test("fixture carries provenance for the desktop build it came from", async () => {
  const fixture = await readJson(fixturePath);
  assert.equal(fixture.fixture, "obsidian-desktop-base-tokens");
  assert.equal(fixture.fixtureVersion, 1);
  assert.match(fixture.obsidianVersion, /^\d+\.\d+\.\d+$/, "fixture must pin the Obsidian version it was extracted from");
  assert.equal(fixture.source.entry, "app.css");
  assert.match(fixture.source.archiveSha256, /^[0-9a-f]{64}$/);
  assert.match(fixture.source.appCssSha256, /^[0-9a-f]{64}$/);
  assert.ok(fixture.scope.tokens > 0 && fixture.scope.totalDesktopTokens >= fixture.scope.tokens);
  assert.equal(Object.keys(fixture.tokens).length, fixture.scope.tokens);
  for (const [token, entry] of Object.entries(fixture.tokens)) {
    assert.match(token, /^--/, `${token} must be a custom property`);
    assert.ok(entry.light !== undefined && entry.dark !== undefined, `${token} must record both colour modes`);
  }
});

test("Web fallback layer stays aligned with desktop Obsidian defaults", async () => {
  const [fixture, allowlist, webCss] = await Promise.all([readJson(fixturePath), readJson(allowlistPath), fs.readFile(webCssPath, "utf8")]);
  const claims = extractLayerTokenClaims(webCss, FALLBACK_LAYER);
  assert.ok(claims, `src/app/assets/app.css must keep an @layer ${FALLBACK_LAYER} block`);

  const result = evaluateBaseTokenGate({ claims, fixture, allowlist });
  assert.deepEqual(result.problems, [], `base-token gate failed:\n- ${result.problems.join("\n- ")}`);
  assert.ok(result.summary[MATCH] > 0, "a gate that compares nothing is not a gate");
});

test("allowlist entries are classified and justified", async () => {
  const allowlist = await readJson(allowlistPath);
  assert.equal(allowlist.kind, "obsidian-desktop-base-tokens-allowlist");
  assert.ok(allowlist.entries.length > 0);
  const seen = new Set();
  for (const entry of allowlist.entries) {
    assert.ok(!seen.has(entry.token), `${entry.token} is listed twice`);
    seen.add(entry.token);
    assert.ok(ALLOWLIST_CLASSES.includes(entry.class), `${entry.token}: unknown class ${entry.class}`);
    assert.ok(entry.reason.trim().length >= 20, `${entry.token}: reason must explain the divergence`);
    for (const mode of entry.modes) assert.ok(["light", "dark"].includes(mode), `${entry.token}: bad mode ${mode}`);
  }
});

// --- the gate must be able to fail -------------------------------------------------

test("negative control: a changed desktop baseline is reported as drift", async () => {
  const [fixture, allowlist, webCss] = await Promise.all([readJson(fixturePath), readJson(allowlistPath), fs.readFile(webCssPath, "utf8")]);
  const claims = extractLayerTokenClaims(webCss, FALLBACK_LAYER);
  const target = "--color-base-100";
  assert.equal(claims.get(target).light, fixture.tokens[target].light, "fixture assumption: this token currently matches");

  const mutated = structuredClone(fixture);
  mutated.tokens[target].light = "#010203";
  const rows = compareTokenClaims(claims, flattenDefaults(mutated.tokens));
  const row = rows.find((entry) => entry.token === target && entry.mode === "light");
  assert.equal(row.status, DRIFT, "a mutated desktop default must show up as drift");
  assert.equal(row.desktop, "#010203");

  // ...and the gate must reject it, not merely describe it: no allowlist entry covers it.
  const result = evaluateBaseTokenGate({ claims, fixture: mutated, allowlist });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes(target)), "gate must name the drifting token");
});

test("negative control: a token added to the Web layer without regenerating the fixture fails closed", async () => {
  const [fixture, allowlist, webCss] = await Promise.all([readJson(fixturePath), readJson(allowlistPath), fs.readFile(webCssPath, "utf8")]);
  const mutatedCss = webCss.replace(
    /@layer web-theme-fallback \{\n/,
    "@layer web-theme-fallback {\n:root { --web-only-sentinel: 42px; }\n",
  );
  assert.notEqual(mutatedCss, webCss, "fixture assumption: the layer opening line is findable");
  const claims = extractLayerTokenClaims(mutatedCss, FALLBACK_LAYER);
  const result = evaluateBaseTokenGate({ claims, fixture, allowlist });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("--web-only-sentinel")));
});

test("negative control: a stale allowlist entry fails closed", async () => {
  const [fixture, allowlist, webCss] = await Promise.all([readJson(fixturePath), readJson(allowlistPath), fs.readFile(webCssPath, "utf8")]);
  // Pretend an allowlisted divergence was resolved by dropping the claim from the
  // Web layer, without anyone touching the allowlist: the entry is now stale and
  // the gate has to say so instead of silently keeping a dead deviation.
  const target = allowlist.entries[0];
  assert.ok(target, "fixture assumption: the allowlist has entries");
  const mutatedCss = webCss.replace(new RegExp(`\\n\\s*${target.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: [^;]+;`), "\n");
  assert.notEqual(mutatedCss, webCss, `fixture assumption: ${target.token} is declared in the layer`);
  const claims = extractLayerTokenClaims(mutatedCss, FALLBACK_LAYER);
  assert.equal(claims.has(target.token), false);
  const result = evaluateBaseTokenGate({ claims, fixture, allowlist });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes(target.token)), "gate must name the stale entry");
});

// --- oracle primitives --------------------------------------------------------------

test("cascade: body beats :root by inheritance, mode class beats body by specificity", () => {
  const rules = parseStylesheetRules(`
    :root { --a: root; --shared: root; }
    body { --a: body; --shared: body; }
    .theme-dark { --a: dark; }
    @media print { body { --a: print; } }
    @supports (font-variation-settings: normal) { body { --b: supports; } }
  `);
  const tokens = extractDefaultTokens(rules);
  assert.equal(tokens["--a"].light.value, "body");
  assert.equal(tokens["--a"].dark.value, "dark", ".theme-dark must outrank body on the same element");
  assert.equal(tokens["--shared"].light.value, "body", "body must beat :root for inherited custom properties");
  assert.equal(tokens["--b"].light.value, "supports", "@supports is true in the shipped Chromium and must count");
  assert.ok(!Object.values(tokens).some((entry) => entry.light?.value === "print" || entry.dark?.value === "print"), "@media print must not leak into the screen cascade");
});

test("layer claims: an unconditional selector inside the layer covers both modes", () => {
  const css = `@layer web-theme-fallback {
    :root, .theme-light { --a: light; --b: both; }
    .theme-dark { --a: dark; }
  }`;
  const claims = extractLayerTokenClaims(css, "web-theme-fallback");
  assert.equal(claims.get("--a").light, "light");
  assert.equal(claims.get("--a").dark, "dark");
  assert.equal(claims.get("--b").light, "both");
  assert.equal(claims.get("--b").dark, "both", ":root applies in dark mode too; reading it as light-only hides half the baseline");
  assert.equal(extractLayerTokenClaims(css, "missing-layer"), null);
});

test("compare: normalizes only what is provably equivalent", () => {
  assert.equal(normalizeTokenValue("#FFF"), "#ffffff");
  assert.equal(normalizeTokenValue("WHITE"), "#ffffff");
  assert.equal(normalizeTokenValue(" var(--x) ; "), "var(--x)");
  assert.notEqual(normalizeTokenValue("rgb(0 0 0 / 7.5%)"), normalizeTokenValue("color-mix(in oklch, var(--mono-100) 6.7%, transparent)"), "different notations must stay drift, not be guessed equal");

  const claims = new Map([
    ["--same", { light: "white", dark: "#000" }],
    ["--diff", { light: "1px", dark: "2px" }],
    ["--missing", { light: "3px", dark: "3px" }],
  ]);
  const rows = compareTokenClaims(claims, { "--same": { light: "#ffffff", dark: "black" }, "--diff": { light: "2px", dark: "3px" } });
  const byKey = new Map(rows.map((row) => [`${row.token}:${row.mode}`, row.status]));
  assert.equal(byKey.get("--same:light"), MATCH);
  assert.equal(byKey.get("--same:dark"), MATCH);
  assert.equal(byKey.get("--diff:light"), DRIFT);
  assert.equal(byKey.get("--missing:light"), DESKTOP_UNDECLARED);
  // 3 claims x 2 modes = 6 rows: --same matches twice, --diff drifts twice, --missing is desktop-undeclared twice.
  assert.deepEqual(summarizeRows(rows), { [MATCH]: 2, [DRIFT]: 2, [DESKTOP_UNDECLARED]: 2 });
});
