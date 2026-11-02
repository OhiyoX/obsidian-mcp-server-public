// Offline guards for the Phase 1-C community theme gate.
//
// The bounded Chromium gate (`scripts/render-parity-phase1-community.mjs`) owns
// the computed-paint proof against the derived subsets of Things / Minimal /
// AnuPpuccin. These fast checks keep the committed fixtures, their pinned
// provenance and the gate's declared-vs-undeclared decision logic from drifting:
//
//   1. every subset parses and carries the manifest its own body hashes to;
//   2. the provenance header is complete (source path/sha256/bytes/theme,
//      extraction time, tool version, license) and its counts match the body;
//   3. the token cascade / `var()` resolution used for "the theme declares this"
//      behaves as documented (specificity, !important, source order, host
//      applicability, fallbacks, dark-scope exclusion);
//   4. a subset is a strict subset: full-theme markers are absent and the body is
//      a fraction of the source theme.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectTokenDefs, parseCss, parseSubset, sha256 } from "../scripts/extract-theme-subset.mjs";
import { isThemeSideInvalid } from "../scripts/render-parity-phase1-community.mjs";
import { mutateSubsetCss, resolveThemeTokens, tableOf } from "../scripts/render-parity-community-probe.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(appRoot, "test/fixtures");
const SUBSETS = ["render-parity-things.subset.css", "render-parity-minimal.subset.css", "render-parity-anuppuccin.subset.css"];
const read = (file) => fs.readFileSync(path.join(fixturesRoot, file), "utf8");
const loaded = SUBSETS.map((file) => ({ file, text: read(file), parsed: parseSubset(read(file)) }));

test("the three community subsets parse and hash to their pinned manifest", () => {
  assert.equal(loaded.length, 3);
  const themes = loaded.map((entry) => entry.parsed.manifest.source.name).sort();
  assert.deepEqual(themes, ["AnuPpuccin", "Minimal", "Things"]);
  for (const { file, text, parsed } of loaded) {
    assert.equal(parsed.bodySha256, parsed.manifest.subset.sha256, `${file}: body hash`);
    assert.equal(sha256(parsed.body), parsed.manifest.subset.sha256, `${file}: body hash is over the body`);
    assert.equal(Buffer.byteLength(parsed.body, "utf8"), parsed.manifest.subset.bytes, `${file}: body bytes`);
    assert.ok(text.startsWith("/* RENDER-PARITY-THEME-SUBSET v1"), `${file}: subset marker`);
    assert.ok(text.includes("MANIFEST-JSON-BEGIN") && text.includes("MANIFEST-JSON-END"), `${file}: manifest block`);
    assert.ok(parseCss(parsed.body).rules.length > 0, `${file}: body must contain rules`);
  }
});

test("subset provenance headers are complete and match the body", () => {
  for (const { file, parsed } of loaded) {
    const { manifest, body } = parsed;
    assert.equal(manifest.tool, "app/scripts/extract-theme-subset.mjs", `${file}: tool`);
    assert.match(manifest.toolVersion, /^\d+\.\d+\.\d+$/, `${file}: tool version`);
    assert.ok(!Number.isNaN(Date.parse(manifest.extractedAt)), `${file}: extraction time`);
    assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/, `${file}: source sha256`);
    assert.ok(manifest.source.path.endsWith("theme.css"), `${file}: source path`);
    assert.ok(manifest.source.bytes > manifest.subset.bytes, `${file}: source must be bigger than the subset`);
    assert.ok(manifest.source.name && manifest.source.version && manifest.source.author, `${file}: source theme identity`);
    assert.ok(manifest.source.license && manifest.source.licenseSource, `${file}: license + how it was determined`);
    assert.match(manifest.subset.sha256, /^[0-9a-f]{64}$/, `${file}: subset sha256`);
    // Counts are re-derived from the committed body, never trusted.
    const table = collectTokenDefs(parseCss(body).rules);
    assert.equal(Object.keys(table).length, manifest.subset.tokens, `${file}: token count`);
    assert.equal(Object.values(table).reduce((total, defs) => total + defs.length, 0), manifest.subset.tokenDefinitions, `${file}: token definition count`);
    assert.ok(parseCss(body).rules.length <= manifest.subset.rules, `${file}: serialized rules <= kept rules`);
    assert.deepEqual(Object.keys(manifest.sentinel).sort(), Object.keys(table).slice(0, 6).sort(), `${file}: pinned sentinel tokens`);
    for (const [token, value] of Object.entries(manifest.sentinel)) {
      assert.ok(body.includes(`${token}:`), `${file}: body declares ${token}`);
      assert.ok(body.includes(String(value).slice(0, 12)), `${file}: body carries the pinned value of ${token}`);
    }
  }
});

test("a subset stays a strict subset of its source theme", () => {
  for (const { file, parsed } of loaded) {
    const { manifest, body } = parsed;
    assert.ok(body.length * 4 < manifest.source.bytes, `${file}: subset must be far smaller than the source theme`);
    assert.ok(manifest.droppedSample.length > 0, `${file}: the gate re-checks a dropped-rule sample`);
    for (const entry of manifest.droppedSample) {
      assert.ok(entry.selector && Array.isArray(entry.props) && entry.props.length, `${file}: dropped sample entry`);
      assert.ok(!body.includes(`${entry.selector} {`), `${file}: sampled dropped rule must not be in the body`);
    }
    for (const marker of manifest.excludedMarkers) {
      assert.ok(!body.includes(marker), `${file}: out-of-scope marker ${marker} must not reach the subset`);
    }
    // The subset is light-mode only by construction.
    assert.ok(!/\B\.theme-dark\b/.test(body), `${file}: dark-scoped rules must not be extracted`);
  }
});

test("declared-vs-undeclared logic: cascade, applicability, chains, control", () => {
  const table = {
    "--plain": [["body", "#111111", 0]],
    "--tie": [["body", "#222222", 0], [".theme-light", "#333333", 0]],
    "--forced": [["body", "#444444", 0], [".theme-light", "#555555", 1]],
    "--variant": [["body", "#666666", 0], [".theme-light.minimal-atom-light", "#777777", 0]],
    "--chain": [["body", "rgb(var(--plain))", 0]],
    "--fallback": [["body", "var(--missing, 12px)", 0]],
    "--broken": [["body", "var(--missing)", 0]],
  };
  const applicable = (selector) => !selector.includes("minimal-atom-light");
  const resolved = resolveThemeTokens(table, applicable);
  assert.equal(resolved["--plain"].resolved, "#111111");
  assert.equal(resolved["--plain"].scope, "root");
  // Equal specificity: the later definition wins.
  assert.equal(resolved["--tie"].resolved, "#333333");
  // `!important` beats specificity.
  assert.equal(resolved["--forced"].resolved, "#555555");
  // A definition whose selector cannot match this host never wins.
  assert.equal(resolved["--variant"].resolved, "#666666");
  // `var()` chains resolve inside the subset; declared fallbacks are used.
  assert.equal(resolved["--chain"].resolved, "rgb(#111111)");
  assert.equal(resolved["--fallback"].resolved, "12px");
  // Dark-scoped definitions never reach the table: that exclusion is the
  // extractor's, so the light definition is what the gate resolves.
  assert.deepEqual(collectTokenDefs(parseCss(".theme-dark { --dark: #999999; } .theme-light { --dark: #888888; }").rules)["--dark"], [[".theme-light", "#888888", 0]]);
  // An unresolvable chain is reported, not guessed.
  assert.equal(resolved["--broken"].resolved, null);
  // When nothing can match, the token makes no claim at all.
  assert.deepEqual(Object.keys(resolveThemeTokens({ "--x": [[".minimal-atom-light", "#000", 0]] }, applicable)), []);
  // Element-scoped tokens are not read off the note container.
  assert.equal(resolveThemeTokens({ "--callout": [[".callout", "#aaa", 0]] }, () => true)["--callout"].scope, "element");
});

test("a theme declaration the browser drops is classified, never excused", () => {
  // An empty computed value that no app-side sheet owns is a declaration the
  // browser dropped at parse time (AnuPpuccin's `rgba(var(255, 255, 255), 0.09)`
  // is not a valid custom-property reference), which no cascade can repair:
  // reported as `themeInvalid`, not as a clobber. A dropped declaration is
  // invisible to the CSSOM, so the theme's rule never reaches `tokenOwners` and
  // the token has no owner at all -- `null`, not `community-theme`.
  assert.equal(isThemeSideInvalid({ observed: "", ownerSheet: null }), true);
  assert.equal(isThemeSideInvalid({ observed: "", ownerSheet: "community-theme" }), true);
  // The app's own sheet winning is a real clobber, empty or not.
  assert.equal(isThemeSideInvalid({ observed: "", ownerSheet: "style" }), false);
  // A token that computed to a real value is never reclassified, whoever owns it.
  assert.equal(isThemeSideInvalid({ observed: "40rem", ownerSheet: "community-theme" }), false);
  assert.equal(isThemeSideInvalid({ observed: 0, ownerSheet: "community-theme" }), false);
});

test("the token table is side-aware: dark definitions and conditional rules (#360)", () => {
  // The light table is the frozen pre-#360 baseline: `.theme-dark`-scoped
  // definitions never reach it. The dark table (includeDark) must contain them,
  // because in dark mode they are the very declarations the cascade uses.
  const rules = parseCss([
    "body { --a: 1; --b: 2; --c: 3; }",
    ".theme-dark { --a: 10; }",
    "@media print { .theme-dark { --b: 20; } }",
    ".theme-dark { --c: 30; }",
  ].join("\n")).rules;
  const light = collectTokenDefs(rules);
  assert.deepEqual(light["--a"], [["body", "1", 0]]);
  assert.deepEqual(light["--c"], [["body", "3", 0]]);
  assert.deepEqual(light["--b"], [["body", "2", 0]], "a light table cannot see a dark-only definition");
  const dark = collectTokenDefs(rules, { includeDark: true });
  assert.deepEqual(dark["--a"], [["body", "1", 0], [".theme-dark", "10", 0]]);
  assert.deepEqual(dark["--c"], [["body", "3", 0], [".theme-dark", "30", 0]]);
  // A conditional at-rule cannot be attributed without evaluating its condition,
  // so it is never a dark-table winner (measured: Things declares --h1-color in
  // `@media print`, which the 1440px screen cascade never applies).
  assert.deepEqual(dark["--b"], [["body", "2", 0]]);
  assert.ok(!JSON.stringify(dark["--b"]).includes("20"), "the @media print value must not enter the table");
  // A non-conditional at-rule (@layer) is still read.
  const layered = parseCss("@layer t { .theme-dark { --d: 4; } }").rules;
  assert.equal(collectTokenDefs(layered)["--d"], undefined);
  assert.deepEqual(collectTokenDefs(layered, { includeDark: true })["--d"], [[".theme-dark", "4", 0]]);
});

test("the negative control transform moves real theme values", () => {
  const body = loaded[0].parsed.body;
  const mutated = mutateSubsetCss(body);
  assert.ok(mutated.mutations > 0, "the mutation must change at least one declaration value");
  assert.notEqual(mutated.css, body);
  for (const sample of ["#ff82b2", "rgb(46, 128, 242)"]) {
    if (body.includes(sample)) assert.ok(!mutated.css.includes(sample), `mutation must move ${sample}`);
  }
  const before = tableOf(body);
  const after = tableOf(mutated.css);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "the mutation must not add or drop tokens");
});
