// P0 Task 6 gate: the Base pack is complete, unambiguous and shipped.
//
// `assertBasePromptInventory` is the single place that answers "does the pack cover
// what the code registers?". It runs here and inside the architecture check, so a
// new tool, prompt or compact domain without copy fails before a release, not in
// an agent's first call.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { COMPACT_GROUPS } from "../src/compact-tools.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_PROMPT_NAMES } from "../src/prompts.js";
import { loadBundledBase } from "../src/prompt-registry/base-pack.js";

const ROOT = new URL("../prompts/base/", import.meta.url);
const PACK_ROOT = ROOT.pathname;
const MANIFEST = JSON.parse(await readFile(new URL("manifest.json", ROOT), "utf8"));

/**
 * Fail with every missing or extra key named at once, so one run tells the whole
 * story instead of one tool per attempt.
 */
export function assertBasePromptInventory({ toolNames, compactDomains, promptNames, manifest = MANIFEST }) {
  const keys = new Set(Object.keys(manifest.keys ?? {}));
  const problems = [];

  for (const name of toolNames) {
    if (!keys.has(`tools.canonical.${name}.description`)) problems.push(`missing canonical copy: ${name}`);
  }
  for (const name of promptNames) {
    for (const field of ["title", "description", "body"]) {
      if (!keys.has(`prompts.${name}.${field}`)) problems.push(`missing prompt copy: ${name}.${field}`);
    }
  }
  for (const key of keys) {
    const canonical = /^tools\.canonical\.(.+)\.description$/.exec(key);
    if (canonical !== null && !toolNames.includes(canonical[1])) problems.push(`copy for an unregistered tool: ${canonical[1]}`);
    const compact = /^tools\.compact\.(.+)\.summary$/.exec(key);
    if (compact !== null && !compactDomains.includes(compact[1])) problems.push(`copy for an unknown domain: ${compact[1]}`);
    const prompt = /^prompts\.(.+)\.(?:title|description|body)$/.exec(key);
    if (prompt !== null && !promptNames.includes(prompt[1])) problems.push(`copy for an unknown prompt: ${prompt[1]}`);
  }
  // One file, one key: a shared file makes two different strings drift together.
  const files = Object.values(manifest.keys ?? {}).map((entry) => entry.file);
  for (const file of new Set(files)) {
    if (files.filter((value) => value === file).length > 1) problems.push(`one file carries several keys: ${file}`);
  }
  assert.deepEqual(problems, []);
}

test("the shipped pack covers every registered tool, prompt and known domain", () => {
  assertBasePromptInventory({
    toolNames: [...TOOL_NAMES],
    compactDomains: Object.keys(COMPACT_GROUPS),
    promptNames: [...MCP_PROMPT_NAMES],
  });
});

test("the inventory reports every gap in one run", () => {
  assert.throws(
    () =>
      assertBasePromptInventory({
        toolNames: ["get_note", "brand_new_tool"],
        compactDomains: ["obsidian_read", "obsidian_new"],
        promptNames: ["research_brief", "unregistered_prompt"],
        manifest: {
          keys: {
            "tools.canonical.get_note.description": { file: "a.md" },
            "tools.compact.obsidian_read.summary": { file: "b.md" },
            "tools.compact.obsidian_new.summary": { file: "b.md" },
            "prompts.research_brief.title": { file: "c.md" },
          },
        },
      }),
    /missing canonical copy: brand_new_tool/,
  );
});

test("the pack on disk is UTF-8, ends with one newline and declares every file", async () => {
  const loaded = loadBundledBase({
    rootDir: PACK_ROOT,
    toolNames: [...TOOL_NAMES],
    compactDomains: Object.keys(COMPACT_GROUPS),
    promptNames: [...MCP_PROMPT_NAMES],
  });
  const declared = new Set(Object.values(loaded.manifest.keys).map((entry) => entry.file));
  for (const file of declared) {
    const bytes = await readFile(path.join(PACK_ROOT, file));
    assert.notEqual(bytes[0], 0xef, `${file} has no BOM`);
    const text = bytes.toString("utf8");
    assert.ok(text.endsWith("\n"), `${file} ends with a newline`);
    assert.ok(!text.endsWith("\n\n"), `${file} ends with exactly one newline`);
  }
  // No stray Markdown file: an unlisted file would never be read or reviewed as copy.
  const walk = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) found.push(...(await walk(path.join(directory, entry.name), relative)));
      else if (entry.name.endsWith(".md")) found.push(relative);
    }
    return found;
  };
  const onDisk = await walk(PACK_ROOT);
  assert.deepEqual(onDisk.filter((file) => !declared.has(file)), []);
  assert.equal(onDisk.length, declared.size);
});

test("the image ships the pack through the existing copy step", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY \. \.\/$/m, "Dockerfile copies the whole app tree");
  assert.ok(!/COPY\s+prompts/.test(dockerfile), "no per-directory copy is needed for the pack");
});
