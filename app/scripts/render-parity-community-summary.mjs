// Console summary for the Phase 1-C community theme gate (issue #360).
//
// Split out of `render-parity-phase1-community.mjs` so the gate entry stays
// inside the repository's line budget. It is presentation only: it reads the
// report the gate already built, prints one block per colour side, and never
// asserts anything (every verdict lives in the gate's `problems` list).
import path from "node:path";
import { DARK_FIXTURE_THEME_NAME, DECLARED_SIDE_TOKENS } from "./render-parity-color-sides.mjs";

/** Side records in the order they were measured (light first). */
export function sideListOf(report, sides) {
  return sides.filter((mode) => report.sides[mode]).map((mode) => report.sides[mode]);
}

function shadowedTotalOf(sideList) {
  return sideList.reduce((total, side) => total
    + [...side.subsets, ...side.realThemes].reduce((count, entry) => count + (entry.shadowed?.length ?? entry.shadowed ?? 0), 0), 0);
}

export function printCommunityThemeSummary({ report, sides, realThemesConfigured, strictTokens, outputRoot, problems }) {
  const sideList = sideListOf(report, sides);
  console.log("");
  console.log("Render parity Phase 1-C (community theme subsets) summary");
  console.log(`  status   : ${report.status}`);
  console.log(`  sides    : ${sideList.map((side) => `${side.side}${side.colorProblems.length ? "(NOT IN FORCE)" : ""}`).join(", ")}`);
  console.log(`  subsets  : ${(sideList[0]?.subsets ?? []).map((entry) => `${entry.theme}(${entry.bytes}B, ${entry.rules} rules)`).join(", ")}`);
  console.log(`  real     : ${realThemesConfigured || "not configured (COMMUNITY_THEMES_PATH)"}`);
  // The self-built dark fixture is the only theme whose `.theme-dark` block the
  // dark side asserts; show its per-side verdict so "dark declaration in force"
  // is visible without opening the JSON.
  const selfBuilt = sideList.flatMap((side) => (side.realThemes ?? []).filter((entry) => entry.name === DARK_FIXTURE_THEME_NAME).map((entry) => `${side.side}:${entry.mismatches.length ? `${entry.mismatches.length} MISMATCH` : "ok"}`));
  console.log(`  selfbuilt: ${selfBuilt.join(", ") || "none"}`);
  for (const side of sideList) {
    const declared = DECLARED_SIDE_TOKENS.map((entry) => `${entry.token}=${JSON.stringify(side.declaredTokens[entry.token]?.actual ?? null)}`).join(" ");
    console.log(`  ${side.side.padEnd(5)}: clobbered ${side.clobbered.length}${strictTokens ? " (strict: failing)" : " (reported)"}, themeInvalid ${side.themeInvalid.length}, color-scheme=${side.color.colorScheme}, declared ${declared}`);
    for (const entry of side.clobbered.slice(0, 12)) {
      console.log(`    - ${entry.theme} ${entry.token}: declared ${JSON.stringify(entry.declared)} via ${entry.selector}, app computed ${JSON.stringify(entry.computed)}`);
    }
    for (const entry of side.themeInvalid) {
      const sources = `${entry.sources.map((item) => item.selector).join(", ")} from ${entry.sources.map((item) => item.source).join(" + ")}`;
      console.log(`    - ${entry.theme} ${entry.token}: computed ${JSON.stringify(entry.computed)} (empty); declared ${JSON.stringify(entry.declared)} via ${sources}`);
    }
    for (const entry of side.subsets) {
      for (const item of entry.shadowedDetails || []) {
        console.log(`    - ${entry.theme} ${item.surface} ${item.kind}.${item.prop}: theme ${JSON.stringify(item.declared)} (${item.selector}) vs app ${item.shadowedBy} -> ${JSON.stringify(item.computed)}`);
      }
    }
  }
  console.log(`  shadowed : ${shadowedTotalOf(sideList)}`);
  console.log(`  report   : ${path.join(outputRoot, "render-parity-community-report.json")}`);
  if (problems.length) {
    console.log("  problems :");
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  return report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}
