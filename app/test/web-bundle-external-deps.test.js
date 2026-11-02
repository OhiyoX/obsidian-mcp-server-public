// Gate: every external (bare) import that `build:web` actually pulls into a bundle must be a
// declared dependency of `app/package.json` (`dependencies` or `devDependencies`).
//
// Why this exists (#482 follow-up): `build:web` bundles `frontend/app/**` into the committed
// assets under `src/app/assets/`. A package that is only importable because some other
// dependency hoisted it into `node_modules` (mermaid, kept in `dependencies` while it is only a
// bundle input, and `@lezer/markdown`, not declared at all) makes a clean `npm ci` tree the
// installer's shape rather than the repository's contract: a tree where the hoist does not
// happen rebuilds nothing and `build:web` exits 1 while `git status` stays clean, because the
// committed asset is still sitting in the worktree.
//
// The import graph is parsed by esbuild itself (`packages: "external"`, metafile inputs), not by
// a regex over `import` statements, so comments, multi-line imports and re-exports cannot fake a
// pass. Fail-closed floors (entry coverage, a minimum number of specifiers) keep a changed
// esbuild metafile from turning this into a silent no-op.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
const declared = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

// Package name of a bare specifier: `@scope/pkg/sub/path` -> `@scope/pkg`, `pkg/sub` -> `pkg`.
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Entry points of `build:web` (both esbuild invocations), read from the script itself so a new
// entry is covered without editing this test. Every file-looking token must exist: if the
// extractor stops seeing an entry, that is a failure, not a silently smaller gate.
const BUILD_SCRIPT = packageJson.scripts?.["build:web"] ?? "";
const FILE_TOKEN = /\.(?:m?js|jsx|ts|tsx|css)$/;
const fileTokens = BUILD_SCRIPT.split(/\s+/).filter((token) => FILE_TOKEN.test(token) && !token.startsWith("-"));
const entryPoints = fileTokens.filter((token) => fs.existsSync(path.join(APP_ROOT, token)));

async function externalImportsBySourceFile() {
  const result = await build({
    absWorkingDir: APP_ROOT,
    entryPoints,
    outdir: "src/app/assets",
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    packages: "external",
    logLevel: "silent",
  });
  const bySource = new Map();
  for (const [file, meta] of Object.entries(result.metafile.inputs)) {
    // `<runtime>` is esbuild's synthetic helper module (platform glue), not a project file.
    if (file.startsWith("<")) continue;
    for (const imported of meta.imports ?? []) {
      // `<runtime>` is esbuild's synthetic helper module (platform glue), not a package.
      if (!imported.external || imported.path.startsWith("<")) continue;
      if (!bySource.has(imported.path)) bySource.set(imported.path, new Set());
      bySource.get(imported.path).add(file);
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.external && !imported.path.startsWith("<") && !bySource.has(imported.path)) {
        bySource.set(imported.path, new Set());
      }
    }
  }
  return { bySource, inputs: Object.keys(result.metafile.inputs) };
}

test("build:web entry points are extracted from the npm script", () => {
  assert.ok(BUILD_SCRIPT.includes("esbuild"), "build:web must still be an esbuild command");
  assert.deepEqual(
    entryPoints,
    fileTokens,
    "every file-looking argument of build:web must resolve in the worktree (a new entry path the extractor cannot see would shrink this gate silently)",
  );
  assert.ok(entryPoints.length >= 2, `expected the bundled entry points, got ${JSON.stringify(entryPoints)}`);
});

test("every external import of the build:web bundles is a declared dependency", async () => {
  const { bySource, inputs } = await externalImportsBySourceFile();

  for (const entry of entryPoints) {
    assert.ok(
      inputs.some((input) => input.endsWith(entry.replaceAll("\\", "/"))),
      `esbuild did not parse the build:web entry ${entry}; the gate would be blind to it`,
    );
  }
  const specifiers = [...bySource.keys()].sort();
  assert.ok(
    specifiers.length >= 8,
    `only ${specifiers.length} external specifier(s) collected (${JSON.stringify(specifiers)}) - the metafile walk is not seeing the bundle's packages`,
  );

  const undeclared = specifiers
    .filter((specifier) => !declared.has(packageName(specifier)))
    .map((specifier) => `${specifier} (imported by ${[...bySource.get(specifier)].sort().join(", ") || "the bundle output"})`);
  assert.deepEqual(
    undeclared,
    [],
    `build:web imports package(s) that app/package.json does not declare; a clean npm ci tree may not resolve them:\n${undeclared.join("\n")}`,
  );
});
