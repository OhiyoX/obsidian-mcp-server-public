#!/usr/bin/env node
// Regenerate the desktop-Obsidian base-token fixture from a local install.
//
// The fixture is NOT vendored Obsidian source: it is a small derived subset —
// the tokens the Web fallback layer claims — together with a provenance manifest
// (Obsidian version, archive + app.css sha256, extraction time, tool version) so
// the subset and the real app stay connected and the fixture cannot drift
// silently. Same shape as `extract-theme-subset.mjs` uses for community themes.
//
// Obsidian is proprietary and is not redistributed here: the fixture carries
// token *values* that the gate must compare against, which is why the subset is
// restricted to the tokens the Web app already declares.
//
// Usage:
//   node scripts/extract-obsidian-base-tokens.mjs --archive <obsidian.asar> [--out <fixture.json>] [--all]
//   node scripts/extract-obsidian-base-tokens.mjs --app-css <app.css> --version <x.y.z> [...]
//   node scripts/extract-obsidian-base-tokens.mjs --archive <obsidian.asar> --check
//
// `--check` compares a fresh extraction against the committed fixture and exits
// non-zero on any difference, so an Obsidian upgrade is a visible, reviewable
// event instead of a silent baseline change.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ORACLE_VERSION,
  compareTokenClaims,
  extractDefaultTokens,
  extractLayerTokenClaims,
  flattenDefaults,
  parseStylesheetRules,
  summarizeRows,
} from "./obsidian-desktop-oracle.mjs";

export const FIXTURE_KIND = "obsidian-desktop-base-tokens";
export const FIXTURE_VERSION = 1;
export const FALLBACK_LAYER = "web-theme-fallback";

const appRoot = path.resolve(import.meta.dirname, "..");
export const DEFAULT_FIXTURE_PATH = path.join(appRoot, "test/fixtures/obsidian-desktop-base-tokens.json");
export const WEB_FALLBACK_CSS_PATH = path.join(appRoot, "src/app/assets/app.css");

/**
 * Read one file out of an Electron ASAR archive.
 *
 * ASAR layout: two UInt32LE sizes (pickle marker, header size), then the header
 * pickle (payload size, string length, JSON), then the content area at
 * `8 + headerSize`; each entry's `offset` is relative to that base.
 */
export function readAsarEntry(buffer, entryPath) {
  const headerSize = buffer.readUInt32LE(4);
  const stringLength = buffer.readUInt32LE(8 + 4);
  const header = JSON.parse(buffer.subarray(8 + 8, 8 + 8 + stringLength).toString("utf8"));
  const contentBase = 8 + headerSize;
  let node = { files: header.files };
  for (const part of entryPath.split("/").filter(Boolean)) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  if (!node || node.files || node.link !== undefined) return null;
  return buffer.subarray(contentBase + Number(node.offset), contentBase + Number(node.offset) + node.size);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function loadSource({ archive, appCss, version }) {
  // Only portable identifiers are recorded: a committed fixture must not carry
  // this machine's absolute paths, and the sha256 is the part that actually
  // pins provenance.
  if (appCss) {
    const buffer = await fs.readFile(appCss);
    return {
      css: buffer.toString("utf8"),
      obsidianVersion: version ?? "unknown",
      source: { kind: "app-css", entry: "app.css", appCssSha256: sha256(buffer) },
    };
  }
  const buffer = await fs.readFile(archive);
  const css = readAsarEntry(buffer, "app.css");
  if (!css) throw new Error(`no app.css entry in ${archive}`);
  const pkg = readAsarEntry(buffer, "package.json");
  let archiveVersion = version;
  if (!archiveVersion && pkg) {
    try {
      archiveVersion = JSON.parse(pkg.toString("utf8")).version;
    } catch {
      archiveVersion = undefined;
    }
  }
  return {
    css: css.toString("utf8"),
    obsidianVersion: archiveVersion ?? "unknown",
    source: {
      kind: "asar",
      locator: "obsidian-<version>.asar (the app Obsidian actually runs: bundled resources/obsidian.asar, or the auto-updated copy in the Electron userData dir)",
      entry: "app.css",
      archiveSha256: sha256(buffer),
      appCssSha256: sha256(css),
    },
  };
}

export function buildFixture({ extracted, obsidianVersion, source, scopedTokens }) {
  const fixture = {
    fixture: FIXTURE_KIND,
    fixtureVersion: FIXTURE_VERSION,
    toolVersion: ORACLE_VERSION,
    obsidianVersion,
    extractedAt: new Date().toISOString(),
    scope: {
      note: "Derived subset of Obsidian's shipped app.css defaults, restricted to the tokens the Web fallback layer claims.",
      layer: `@layer ${FALLBACK_LAYER} in src/app/assets/app.css`,
      selectorModel: "effective value on the note surface: body wins over :root by inheritance; .theme-light/.theme-dark win by specificity; @media print/forced-colors excluded",
      tokens: scopedTokens.length,
      totalDesktopTokens: Object.keys(extracted).length,
    },
    source,
    tokens: {},
  };
  for (const token of scopedTokens) {
    const entry = extracted[token];
    fixture.tokens[token] = {
      light: entry?.light?.value ?? null,
      dark: entry?.dark?.value ?? null,
    };
  }
  return fixture;
}

async function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const archive = arg("--archive");
  const appCss = arg("--app-css");
  if (!archive && !appCss) {
    console.error("usage: extract-obsidian-base-tokens.mjs (--archive <obsidian.asar> | --app-css <app.css>) [--out <fixture>] [--check] [--all]");
    return 2;
  }
  const fixturePath = path.resolve(arg("--out") ?? DEFAULT_FIXTURE_PATH);
  const check = argv.includes("--check");

  const loaded = await loadSource({ archive: archive && path.resolve(archive), appCss: appCss && path.resolve(appCss), version: arg("--version") });
  const extracted = extractDefaultTokens(parseStylesheetRules(loaded.css));

  const webCss = await fs.readFile(WEB_FALLBACK_CSS_PATH, "utf8");
  const claims = extractLayerTokenClaims(webCss, FALLBACK_LAYER);
  if (!claims) throw new Error(`no @layer ${FALLBACK_LAYER} block in ${WEB_FALLBACK_CSS_PATH}`);
  const scoped = argv.includes("--all") ? Object.keys(extracted).sort() : [...claims.keys()].sort();
  const fixture = buildFixture({ extracted, obsidianVersion: loaded.obsidianVersion, source: loaded.source, scopedTokens: scoped });

  const rows = compareTokenClaims(claims, flattenDefaults(fixture.tokens));
  const summary = summarizeRows(rows);
  for (const row of rows.filter((entry) => entry.status !== "match")) {
    console.error(`${row.status}\t${row.token}\t[${row.mode}] web=${row.web} desktop=${row.desktop ?? "-"}`);
  }
  console.error(`tokens=${scoped.length} declarations=${rows.length} match=${summary.match} drift=${summary.drift} desktop-undeclared=${summary["desktop-undeclared"]}`);

  if (check) {
    let committed;
    try {
      committed = JSON.parse(await fs.readFile(fixturePath, "utf8"));
    } catch (error) {
      console.error(`cannot read committed fixture ${fixturePath}: ${error.message}`);
      return 1;
    }
    const differences = [];
    if (committed.obsidianVersion !== fixture.obsidianVersion) {
      differences.push(`obsidianVersion ${committed.obsidianVersion} -> ${fixture.obsidianVersion}`);
    }
    for (const token of new Set([...Object.keys(committed.tokens ?? {}), ...Object.keys(fixture.tokens)])) {
      for (const mode of ["light", "dark"]) {
        const before = committed.tokens?.[token]?.[mode] ?? null;
        const after = fixture.tokens[token]?.[mode] ?? null;
        if (before !== after) differences.push(`${token}[${mode}] ${before} -> ${after}`);
      }
    }
    if (differences.length) {
      console.error(`\nfixture is stale (${differences.length} changes); re-run without --check to refresh:`);
      for (const line of differences) console.error(`  ${line}`);
      return 1;
    }
    console.error(`fixture is current (${fixturePath})`);
    return 0;
  }

  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(`wrote ${fixturePath} (${scoped.length} tokens, Obsidian ${fixture.obsidianVersion})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
