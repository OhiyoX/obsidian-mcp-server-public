import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoots = ["frontend", "src"];
const scriptRoots = ["scripts", "test"];

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

// The owner retired the hard code-line gate on 2026-11-13: no line count is inspected here,
// only the behavioural/relation checks below. `inspected` counts the files those checks cover.
async function inspect(file) {
  await readFile(path.join(root, file), "utf8");
  inspected.push(file);
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

// Prompt copy lives in `prompts/base` (see test/prompt-base-inventory.test.js), never as a
// tool-config literal: a duplicated description is what issue #825 was about. Zod parameter
// `.describe(...)` calls are not this property and stay allowed.
const PROMPT_COPY_OWNERS = ["src/base-create-face.js"];
for (const file of await collect("src/tools")) PROMPT_COPY_OWNERS.push(file);
for (const file of PROMPT_COPY_OWNERS) {
  const content = await readFile(path.join(root, file), "utf8");
  const line = content.split("\n").findIndex((entry) => /^\s*description:\s*(["'`]|$)/.test(entry));
  if (line >= 0) failures.push(`${file}:${line + 1}: tool description literal (move the copy to prompts/base)`);
}

if (failures.length) {
  console.error("Architecture check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`architecture check passed for ${inspected.length} source files`);
}
