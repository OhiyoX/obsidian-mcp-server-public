// Optional narrow-width pass of `render-parity-phase1-mobile.mjs` (TODO §4 item 5).
//
// The synthetic fixture theme is the gate's core proof; this module adds the
// three committed community-theme subsets (`test/fixtures/*.subset.css`, the
// pinned derivatives Phase 1-C asserts at 1440) re-measured at 375px, so a
// declaration that only takes effect at phone width is still checked. It runs
// only when `COMMUNITY_THEMES_PATH` exists; CI never depends on a local Vault
// path and the real read-only theme directory is deliberately not read here.
//
// The contract is the same two-sided one the wide community gate uses:
//   * the subset declares the property for the kind -> computed must equal the
//     theme's declared value;
//   * it does not declare it -> computed must equal the 375px Web fallback,
//     unless the token sentinel proves the paint is fed by a theme token.
// Root-token assertions stay owned by the wide gate (a token is a document-level
// value, not a narrow-width one); token-mediated paint is attributed here with
// the same sentinel mechanism.
//
// Kept in its own module because the repository's line budget does not
// fit both passes in one entry (same split as `render-parity-geometry-probe.mjs`
// / `render-parity-geometry-harness.mjs`). It is a harness: it installs themes
// and measures, it never writes production state.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { KINDS } from "./render-parity-theme-core.mjs";
import { parseSubset } from "./extract-theme-subset.mjs";
import { SHORTHANDS, SURVEY, mutateSubsetCss, observedTokens, selectorsOf, tableOf } from "./render-parity-community-probe.mjs";

const SUBSET_FIXTURE = /^render-parity-.*\.subset\.css$/;
const fixturesRoot = path.resolve(import.meta.dirname, "..", "test/fixtures");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").replace(/"/g, "'").replace(/\s*,\s*/g, ",").trim().toLowerCase();

/** Runs in the page: selection at the matching end, then one explicit scroll stop. */
const SCROLL_TO = (fraction) => {
  const view = window.__testEditor?._view;
  if (view) view.dispatch({ selection: { anchor: fraction === 1 ? view.state.doc.length : 0 } });
  const scroller = document.querySelector(".cm-scroller");
  if (!scroller) return null;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.round(max * fraction);
  return { fraction, want: Math.round(max * fraction), got: scroller.scrollTop, max };
};

/**
 * Optional item 5. `ctx` is provided by the gate entry:
 * `{ page, base, vault, viewport, liveFractions, writeTheme, setThemeLink, setMode,
 *    assertSurfaceLayout, fail }`.
 */
export async function runCommunityNarrow(ctx) {
  const { page, base, vault, viewport, liveFractions, writeTheme, setThemeLink, setMode, assertSurfaceLayout, fail } = ctx;
  const themes = [];
  for (const file of (await fs.readdir(fixturesRoot)).filter((name) => SUBSET_FIXTURE.test(name)).sort()) {
    const parsed = parseSubset(await fs.readFile(path.join(fixturesRoot, file), "utf8"));
    if (parsed.bodySha256 !== parsed.manifest.subset.sha256) fail(`${file}: body sha256 does not match the pinned manifest`);
    themes.push({ file, name: parsed.manifest.source.name, body: parsed.body, themeName: `RenderParityMobile${parsed.manifest.source.name}` });
  }
  if (!themes.length) fail("COMMUNITY_THEMES_PATH is set but no community theme subsets were found in test/fixtures");
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await sleep(200);
  const record = { layout: {}, modes: {} };
  await setMode(page, "preview");
  await assertSurfaceLayout(page, "reader", viewport, "preview", record);
  await setMode(page, "live");
  await assertSurfaceLayout(page, "live", viewport, "live", record);
  const allTokens = [...new Set(themes.flatMap((theme) => observedTokens(tableOf(theme.body))))].sort();
  await setThemeLink(page, base, null);
  const fallback = await surveyNarrow({ page, setMode, liveFractions, arg: { kinds: KINDS, tokens: allTokens, selectors: [], dropped: [], shorthands: SHORTHANDS } });
  const reports = [];
  for (const theme of themes) {
    const item = { file: theme.file, theme: theme.name, width: viewport.width, claims: null, mismatches: [], shadowed: [], control: null, foundAt: null };
    const table = tableOf(theme.body);
    const arg = { kinds: KINDS, tokens: observedTokens(table), selectors: selectorsOf(table), dropped: [], shorthands: SHORTHANDS };
    await writeTheme(vault, theme.themeName, theme.body);
    await setThemeLink(page, base, theme.themeName);
    const survey = await surveyNarrow({ page, setMode, liveFractions, arg });
    // Sentinel pass: a property that moves once every theme token is overridden
    // is fed by a theme token — that is how token-mediated paint is attributed.
    await page.evaluate((names) => {
      const style = document.createElement("style");
      style.id = "u17-mobile-sentinel";
      style.textContent = `* { ${names.map((name) => `${name}: rgb(1, 3, 5) !important;`).join(" ")} }`;
      document.head.appendChild(style);
    }, arg.tokens);
    await sleep(120);
    survey.sentinel = await surveyNarrow({ page, setMode, liveFractions, arg });
    await page.evaluate(() => document.querySelector("#u17-mobile-sentinel")?.remove());
    await sleep(60);
    item.foundAt = survey.foundAt || null;
    evaluateSubsetNarrow({ label: `${theme.name}@${viewport.width}`, survey, fallback, item, fail });
    if (!process.env.RENDER_PARITY_SKIP_CONTROL) item.control = await subsetControl({ page, base, vault, theme, arg, before: survey, item, liveFractions, setMode, writeTheme, setThemeLink, fail, width: viewport.width });
    reports.push(item);
  }
  await setThemeLink(page, base, null);
  return { width: viewport.width, layout: record.layout, modes: record.modes, fallbackMeasured: true, themes: reports };
}

/** Both surfaces at the narrow width, with the Live side merged over the range. */
async function surveyNarrow({ page, setMode, liveFractions, arg }) {
  await setMode(page, "preview");
  await sleep(60);
  const reader = await page.evaluate(SURVEY, { ...arg, surface: "reader" });
  await setMode(page, "live");
  await sleep(80);
  const live = { kinds: {}, tokens: {}, tokenOwners: {}, applicable: {}, droppedMatches: [] };
  const foundAt = {};
  for (const fraction of liveFractions) {
    await page.evaluate(SCROLL_TO, fraction);
    await sleep(150);
    const pass = await page.evaluate(SURVEY, { ...arg, surface: "live" });
    for (const [id, entry] of Object.entries(pass.kinds)) {
      if (entry.found && !live.kinds[id]?.found) { live.kinds[id] = entry; foundAt[id] = fraction; }
      else if (!live.kinds[id]) live.kinds[id] = entry;
    }
    Object.assign(live.tokens, pass.tokens);
    Object.assign(live.tokenOwners, pass.tokenOwners);
    Object.assign(live.applicable, pass.applicable);
  }
  return { reader, live, foundAt };
}

/** Two-sided contract at the narrow width: declared ⇒ theme value, else fallback. */
function evaluateSubsetNarrow({ label, survey, fallback, item, fail }) {
  const claims = { declared: 0, tokenMediated: 0, fallback: 0, shadowed: 0 };
  for (const surface of ["reader", "live"]) {
    for (const kind of KINDS) {
      for (const prop of kind.props[surface] || []) {
        const entry = survey[surface].kinds[kind.id];
        const where = `${label} ${surface} ${kind.id}.${prop}`;
        if (!entry?.found) {
          item.mismatches.push({ surface, kind: kind.id, prop, expected: "element", actual: "missing" });
          fail(`${where}: no element to measure at ${label}`);
          continue;
        }
        const actual = entry.values?.[prop];
        const declared = entry.declarations?.[prop];
        if (declared?.shadowedBy) {
          // The theme declares it but an app rule wins at the same element: when
          // both paint the same value the theme's intent is met, otherwise it is
          // reported the way the wide gate reports it (not fatal by default).
          if (normalize(actual) === normalize(declared.normalized)) { claims.declared += 1; continue; }
          claims.shadowed += 1;
          item.shadowed.push({ surface, kind: kind.id, prop, declared: declared.normalized, computed: actual, shadowedBy: declared.shadowedBy });
          continue;
        }
        if (declared) {
          claims.declared += 1;
          if (normalize(actual) !== normalize(declared.normalized)) {
            item.mismatches.push({ surface, kind: kind.id, prop, expected: declared.normalized, actual, selector: declared.selector, mode: "declared" });
            fail(`${where}: theme declared ${JSON.stringify(declared.value)} (${declared.selector}), computed ${JSON.stringify(actual)}`);
          }
          continue;
        }
        const before = fallback[surface].kinds[kind.id]?.values?.[prop];
        if (before != null && normalize(actual) === normalize(before)) { claims.fallback += 1; continue; }
        const sentinel = survey.sentinel?.[surface]?.kinds?.[kind.id]?.values?.[prop];
        if (sentinel != null && normalize(sentinel) !== normalize(actual)) { claims.tokenMediated += 1; continue; }
        item.mismatches.push({ surface, kind: kind.id, prop, expected: "theme-attributable", actual, fallback: before, mode: "unattributed" });
        fail(`${where}: computed ${JSON.stringify(actual)} differs from the narrow fallback ${JSON.stringify(before)} but no theme declaration or theme token explains it`);
      }
    }
  }
  item.claims = claims;
  return claims;
}

/** Negative control: mutate the subset and require the narrow paint to follow. */
async function subsetControl({ page, base, vault, theme, arg, before, item, liveFractions, setMode, writeTheme, setThemeLink, fail, width }) {
  const mutated = mutateSubsetCss(theme.body);
  if (!mutated.mutations) {
    fail(`${theme.name} negative control: the mutation transform changed nothing`);
    return { mutations: 0, moved: 0, unchanged: [] };
  }
  await writeTheme(vault, `${theme.themeName}Mut`, mutated.css);
  await setThemeLink(page, base, `${theme.themeName}Mut`);
  const after = await surveyNarrow({ page, setMode, liveFractions, arg });
  const unchanged = [];
  let moved = 0;
  for (const surface of ["reader", "live"]) {
    for (const kind of KINDS) {
      for (const prop of kind.props[surface] || []) {
        const declared = after[surface].kinds[kind.id]?.declarations?.[prop];
        if (!declared || declared.shadowedBy) continue;
        const value = after[surface].kinds[kind.id]?.values?.[prop];
        if (normalize(value) !== normalize(declared.normalized)) {
          fail(`${theme.name} negative control ${surface} ${kind.id}.${prop}: mutated declaration ${JSON.stringify(declared.value)} computed ${JSON.stringify(value)}`);
          continue;
        }
        const was = before[surface].kinds[kind.id]?.declarations?.[prop];
        if (was && normalize(was.normalized) === normalize(declared.normalized)) continue;
        const previous = before[surface].kinds[kind.id]?.values?.[prop];
        if (normalize(previous) === normalize(value)) unchanged.push(`${surface} ${kind.id}.${prop} stayed ${JSON.stringify(value)}`);
        else moved += 1;
      }
    }
  }
  if (!moved) fail(`${theme.name} negative control: no declared value moved at ${width}px`);
  for (const entry of unchanged) fail(`${theme.name} negative control: ${entry}`);
  await setThemeLink(page, base, theme.themeName);
  return { mutations: mutated.mutations, moved, unchanged };
}
