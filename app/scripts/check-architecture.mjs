import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { auditLineBudget, countLines } from "./line-budget.mjs";

const root = process.cwd();
const sourceRoots = ["frontend", "src"];
const scriptRoots = ["scripts", "test"];
const baselinePath = "scripts/line-budget-baseline.json";

const ignoredPrefixes = ["src/app/assets/"];

async function collect(directory) {
  const absolute = path.join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = path.posix.join(directory.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) files.push(...await collect(relative));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

const failures = [];
const inspected = [];
const forbiddenScope = [];

async function inspect(file) {
  const content = await readFile(path.join(root, file), "utf8");
  inspected.push({ file, lines: countLines(content) });
}

for (const sourceRoot of sourceRoots) {
  for (const file of await collect(sourceRoot)) {
    if (ignoredPrefixes.some((prefix) => file.startsWith(prefix))) continue;
    forbiddenScope.push(file);
    await inspect(file);
  }
}
for (const scriptRoot of scriptRoots) {
  for (const file of await collect(scriptRoot)) {
    if (ignoredPrefixes.some((prefix) => file.startsWith(prefix))) continue;
    await inspect(file);
  }
}
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name.startsWith(".") || !/\.(?:js|mjs)$/.test(entry.name)) continue;
  await inspect(entry.name);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(path.join(root, baselinePath), "utf8"));
} catch (error) {
  failures.push(`${baselinePath}: cannot read line-budget baseline (${error.message})`);
}
if (baseline !== undefined) {
  const audit = auditLineBudget({ inspected, baseline });
  failures.push(...audit.failures);
  for (const notice of audit.notices) console.log(`line-budget: ${notice}`);
}

const forbiddenPatterns = [
  [/Deprecated alias for pathPrefix/, "deprecated list path alias"],
  [/Legacy no-op alias/, "outline refresh alias"],
  [/value === ["']reading["']/, "reading view-mode alias"],
  [/event\.origin === clientInstanceId/, "origin-only self-echo suppression"],
  [/noteLegacyApiKeyUse|api-key:legacy-env/, "legacy API-key runtime naming"],
  [/kind:\s*["']legacy-note["']|obsidian-skill-note\/v1/, "legacy Skill note contract"],
  [/OLLAMA_(?:BASE_URL|EMBED_MODEL|TIMEOUT_MS)/, "removed embedding environment alias"],
];
for (const file of forbiddenScope) {
  const content = await readFile(path.join(root, file), "utf8");
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(content)) failures.push(`${file}: forbidden ${label}`);
  }
}

const serverSource = await readFile(path.join(root, "server.js"), "utf8");
if (/app\.use\(mcpAuthRouter\(/.test(serverSource)) failures.push("server.js: unprefixed OAuth router mount");
if (/app\.use\(["']\/admin["']\s*,/.test(serverSource)) failures.push("server.js: duplicate root admin mount");

// The production container mounts only `app/server.js` + `app/src`; `app/frontend`
// is a BUILD-TIME tree that esbuild inlines into `src/app/assets/app.js`. So a
// runtime import from `src/` into `frontend/` passes on a full checkout (local,
// CI) and then dies inside the container with `ERR_MODULE_NOT_FOUND` — exactly
// how window #22 (#523) failed. `frontend/` importing `src/` is fine: that edge is
// resolved at build time and inlined into the bundle.
const CROSS_TREE_IMPORT = /(?:from|import\s*\(|require\s*\()\s*["'][^"']*frontend\//;
for (const file of await collect("src")) {
  if (ignoredPrefixes.some((prefix) => file.startsWith(prefix))) continue;
  const content = await readFile(path.join(root, file), "utf8");
  if (CROSS_TREE_IMPORT.test(content)) {
    failures.push(`${file}: forbidden runtime import into frontend/ (the container mounts only app/server.js + app/src \u21d2 ERR_MODULE_NOT_FOUND in production; window #22)`);
  }
}

if (failures.length) {
  console.error("Architecture check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`architecture check passed for ${inspected.length} source files`);
}
