// Gate: the `build:web` command set, the committed bundles under `src/app/assets/` and the
// lazily-loaded `*-runtime.js` entries must agree in BOTH directions (issue #588).
//
// Why this exists: `web-bundle-external-deps.test.js` (#482 follow-up) proves that every external
// import the build pulls in is a declared dependency — it derives its world *from* `build:web`, so
// entry set and asserted import set shrink together. The independent review of #587 showed the
// consequence: deleting the mermaid esbuild command outright left that gate green, because the
// stale `mermaid.js` in the worktree was never compared to anything. This file supplies the missing
// criterion — a committed bundle with no build command, a build command with no committed bundle, a
// build entry that no longer exists, and a lazily-loaded runtime entry missing from `build:web` all
// turn red here.
//
// Static assets are the one hand-written exception; they are listed with their reason so a dead
// entry cannot rot in the allowlist.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
const BUILD_SCRIPT = packageJson.scripts?.["build:web"] ?? "";
const ASSET_DIR = "src/app/assets";
const FEATURES_DIR = "frontend/app/features";

// Bundles that are committed next to the build outputs but are NOT produced by `build:web`:
// they are hand-written, served as-is. Each one has to keep existing (checked below), so the
// allowlist cannot silently absorb a build output whose command was deleted.
const STATIC_ASSETS = Object.freeze([
  "app-loader.js", // inlined boot shim: served before the bundled app is loaded
  "login.js", // standalone login page script, not part of the app bundle
  "theme-boot.js", // renders the theme class before first paint; must not wait for app.js
]);

const FILE_TOKEN = /\.(?:m?js|jsx|ts|tsx|css)$/;

// Split `build:web` into its `&&`-chained esbuild invocations. Fail-closed: a segment that is not
// an esbuild call, or an esbuild call that declares no entry/output, is an error rather than a
// silently smaller gate.
function parseEsbuildCommands(script) {
  const segments = script
    .split("&&")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.map((segment) => {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens[0] !== "esbuild") {
      throw new Error(`build:web segment is not an esbuild invocation: ${segment}`);
    }
    const flag = (name) => {
      const found = tokens.find((token) => token.startsWith(`--${name}=`));
      return found ? found.slice(name.length + 3) : undefined;
    };
    const entries = tokens
      .slice(1)
      .filter((token) => !token.startsWith("-") && FILE_TOKEN.test(token));
    const outfile = flag("outfile");
    const outdir = flag("outdir");
    const entryNames = flag("entry-names");
    if (!outfile && !outdir) throw new Error(`esbuild invocation declares no output: ${segment}`);
    if (entries.length === 0) throw new Error(`esbuild invocation declares no entry: ${segment}`);
    return { segment, entries, outfile, outdir, entryNames };
  });
}

// Output paths a command set produces, relative to APP_ROOT. Only `[name]` entry naming is
// supported on purpose: a different placeholder would mean this extractor no longer knows the
// layout, and guessing would hide exactly the drift this gate exists to catch.
function declaredOutputs(commands) {
  const outputs = new Set();
  for (const command of commands) {
    if (command.outfile) {
      outputs.add(command.outfile);
      continue;
    }
    if (command.entryNames !== undefined && command.entryNames !== "[name]") {
      throw new Error(`unsupported entry naming in build:web: ${command.entryNames}`);
    }
    for (const entry of command.entries) {
      const name = path.basename(entry).replace(FILE_TOKEN, "");
      outputs.add(path.posix.join(command.outdir.replaceAll("\\", "/"), `${name}.js`));
    }
  }
  return outputs;
}

function listFiles(root, relativeDir, predicate) {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) return listFiles(root, relative, predicate);
      return predicate(relative) ? [relative] : [];
    })
    .sort();
}

const isJavaScriptAsset = (relative) => relative.startsWith(`${ASSET_DIR}/`) && relative.endsWith(".js") && !relative.includes("/fonts/");
const isRuntimeEntry = (relative) => relative.startsWith(`${FEATURES_DIR}/`) && relative.endsWith("-runtime.js");

// Committed bundles that no build command produces and the static allowlist does not explain.
function orphanAssets(present, outputs, staticAssets) {
  return present.filter((asset) => !outputs.has(asset) && !staticAssets.includes(path.posix.basename(asset)));
}

// Build outputs that are declared but absent from the worktree.
function missingOutputs(outputs, exists) {
  return [...outputs].filter((output) => !exists(output)).sort();
}

// Lazily-loaded entries (`*-runtime.js`) that `build:web` never bundles.
function unbundledRuntimeEntries(runtimeFiles, commands) {
  const entrySet = new Set(commands.flatMap((command) => command.entries.map((entry) => entry.replaceAll("\\", "/"))));
  return runtimeFiles.filter((file) => !entrySet.has(file));
}

test("#588: build:web, the committed bundles and the runtime entries agree in both directions", () => {
  assert.ok(BUILD_SCRIPT.includes("esbuild"), "build:web must still be an esbuild command");
  const commands = parseEsbuildCommands(BUILD_SCRIPT);
  assert.ok(commands.length >= 5, `expected the five esbuild invocations of build:web, got ${commands.length}`);
  const outputs = declaredOutputs(commands);

  const missingEntries = commands.flatMap((command) => command.entries).filter((entry) => !fs.existsSync(path.join(APP_ROOT, entry)));
  assert.deepEqual(missingEntries, [], "build:web names an entry that does not exist in the worktree");

  assert.deepEqual(missingOutputs(outputs, (output) => fs.existsSync(path.join(APP_ROOT, output))), [],
    "build:web declares a bundle that is not committed; the served asset would be stale or absent");

  const present = listFiles(APP_ROOT, ASSET_DIR, isJavaScriptAsset);
  assert.ok(present.length >= 8, `expected the committed bundles under ${ASSET_DIR}, got ${JSON.stringify(present)}`);
  assert.deepEqual(orphanAssets(present, outputs, STATIC_ASSETS), [],
    "a committed bundle is produced by no build:web command and is not a declared static asset - " +
    "either the build command was dropped (the #588 blind spot) or the asset is stale");

  const runtimeFiles = listFiles(APP_ROOT, FEATURES_DIR, isRuntimeEntry);
  assert.ok(runtimeFiles.length >= 3, `expected the lazily-loaded runtime entries, got ${JSON.stringify(runtimeFiles)}`);
  assert.deepEqual(unbundledRuntimeEntries(runtimeFiles, commands), [],
    "a *-runtime.js entry is not bundled by build:web, so the loader would request a file that is never built");
});

test("#588: every static-asset exception still exists (the allowlist cannot rot)", () => {
  for (const asset of STATIC_ASSETS) {
    assert.ok(fs.existsSync(path.join(APP_ROOT, ASSET_DIR, asset)), `declared static asset is gone: ${asset}`);
  }
});

test("#588 negative controls: dropping a build command, a bundle or an entry turns the gate red", () => {
  const commands = parseEsbuildCommands(BUILD_SCRIPT);
  const outputs = declaredOutputs(commands);

  // 1) The exact regression the independent review demonstrated: the mermaid invocation disappears.
  const withoutMermaid = parseEsbuildCommands(
    BUILD_SCRIPT.split("&&").filter((segment) => !segment.includes("mermaid-runtime.js")).join("&&"),
  );
  const mermaidOrphans = orphanAssets([`${ASSET_DIR}/mermaid.js`], declaredOutputs(withoutMermaid), STATIC_ASSETS);
  assert.deepEqual(mermaidOrphans, [`${ASSET_DIR}/mermaid.js`], "deleting the mermaid command must orphan mermaid.js");

  // 2) A renamed `--outdir` entry: the command now names a file that is gone AND the committed
  //    bundle it used to produce becomes an orphan (both directions move together).
  const renamed = BUILD_SCRIPT.replace("frontend/app/publish.js", "frontend/app/publish-v2.js");
  assert.notEqual(renamed, BUILD_SCRIPT, "the rename must actually change build:web");
  const renamedCommands = parseEsbuildCommands(renamed);
  const missingEntry = renamedCommands
    .flatMap((command) => command.entries)
    .filter((entry) => !fs.existsSync(path.join(APP_ROOT, entry)));
  assert.deepEqual(missingEntry, ["frontend/app/publish-v2.js"], "a renamed entry must be reported missing");
  assert.deepEqual(
    orphanAssets([`${ASSET_DIR}/publish.js`], declaredOutputs(renamedCommands), STATIC_ASSETS),
    [`${ASSET_DIR}/publish.js`],
    "the pre-rename bundle becomes an orphan once the entry is renamed",
  );

  // 3) A runtime entry that no longer appears in build:web.
  const withoutKanban = parseEsbuildCommands(
    BUILD_SCRIPT.split("&&").filter((segment) => !segment.includes("kanban-runtime.js")).join("&&"),
  );
  assert.deepEqual(
    unbundledRuntimeEntries(["frontend/app/features/bases/kanban-runtime.js"], withoutKanban),
    ["frontend/app/features/bases/kanban-runtime.js"],
  );

  // 4) The pure extractor must not silently swallow a malformed script.
  assert.throws(() => parseEsbuildCommands("esbuild frontend/app/core/app.js --bundle"), /declares no output/);
  assert.throws(() => parseEsbuildCommands("esbuild --outfile=src/app/assets/x.js"), /declares no entry/);
  assert.throws(() => parseEsbuildCommands("echo hi"), /not an esbuild invocation/);
  assert.throws(
    () => declaredOutputs(parseEsbuildCommands(BUILD_SCRIPT.replace("--entry-names=[name]", "--entry-names=[name]-[hash]"))),
    /unsupported entry naming/,
  );
  assert.ok(outputs.size >= 8, `expected at least 8 declared outputs, got ${outputs.size}`);
});
