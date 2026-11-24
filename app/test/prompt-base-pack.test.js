// Prompt Base pack: parsing, validation and the loader's refusals.
//
// The pack is the developer-maintained copy of every Agent-facing string. A pack
// that is ambiguous, incomplete or over budget must be rejected whole: a publish
// that half-succeeded would leave the server quoting two versions of one rule.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROMPT_BASE_INVALID,
  PROMPT_BASE_LIMITS,
  promptBaseDigest,
  readBaseText,
  renderPromptTemplate,
  validateBasePack,
} from "../src/prompt-registry/schema.js";
import { createBundledPromptReader, loadBundledBase } from "../src/prompt-registry/base-pack.js";
import { COMPACT_GROUPS } from "../src/compact-tools.js";
import { TOOL_NAMES } from "../src/config.js";

const PACK_ROOT = fileURLToPath(new URL("../prompts/base/", import.meta.url));
const BASELINE = JSON.parse(
  await readFile(new URL("./fixtures/prompt-base-baseline.json", import.meta.url), "utf8"),
);

const INVOCATION = {
  toolNames: [...TOOL_NAMES],
  compactDomains: Object.keys(COMPACT_GROUPS),
  promptNames: ["research_brief"],
};

function pack(overrides = {}, { files = new Map() } = {}) {
  const manifest = {
    schemaVersion: 1,
    keys: {
      "memory.firstRead": { file: "memory/first-read.md" },
      "memory.checkpoint": { file: "memory/checkpoint.md" },
      "memory.afterWrite": { file: "memory/after-write.md" },
      "memory.readHint": { file: "memory/read-hint.md" },
      "memory.writeHint": { file: "memory/write-hint.md" },
      "bootstrap.instructions": { file: "bootstrap/instructions.md" },
      "bootstrap.workflow.start": { file: "bootstrap/workflow/start.md" },
      "bootstrap.workflow.reuse-and-improve": { file: "bootstrap/workflow/reuse-and-improve.md" },
      "bootstrap.workflow.checkpoint": { file: "bootstrap/workflow/checkpoint.md" },
      "bootstrap.workflow.doc-hygiene": { file: "bootstrap/workflow/doc-hygiene.md" },
      "bootstrap.workflow.write": { file: "bootstrap/workflow/write.md" },
      "bootstrap.workflow.verify": { file: "bootstrap/workflow/verify.md" },
      "bootstrap.compatibility.toolNaming": { file: "bootstrap/compat/tool-naming.md" },
      "bootstrap.compatibility.fallback": { file: "bootstrap/compat/fallback.md" },
      "bootstrap.compatibility.activation": { file: "bootstrap/compat/activation.md" },
      "prompts.research_brief.title": { file: "prompts/title.md" },
      "prompts.research_brief.description": { file: "prompts/description.md" },
      "prompts.research_brief.body": { file: "prompts/body.md" },
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`bootstrap.boundary.${index + 1}`, { file: `bootstrap/boundary-${index + 1}.md` }]),
      ),
      "tools.canonical.get_note.description": { file: "tools/get_note.md" },
      "tools.compact.obsidian_read.summary": { file: "tools/obsidian_read.md" },
      ...overrides,
    },
  };
  for (const entry of Object.values(manifest.keys)) {
    if (!files.has(entry.file)) files.set(entry.file, Buffer.from("text\n", "utf8"));
  }
  return validateBasePack({
    manifest,
    files,
    toolNames: ["get_note"],
    compactDomains: ["obsidian_read"],
    promptNames: ["research_brief"],
  });
}

function rejects(run, reason) {
  assert.throws(run, (error) => {
    assert.equal(error.code, PROMPT_BASE_INVALID, `expected ${PROMPT_BASE_INVALID}, got ${error.code}`);
    if (reason !== undefined) assert.equal(error.reason, reason);
    return true;
  });
}

test("the bundled pack validates against the live catalog", () => {
  const loaded = loadBundledBase({ rootDir: PACK_ROOT, ...INVOCATION });
  assert.equal(loaded.schemaVersion, 1);
  assert.match(loaded.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.keys(loaded.values).filter((key) => key.startsWith("tools.canonical.")).length, TOOL_NAMES.length);
  assert.equal(Object.keys(loaded.values).filter((key) => key.startsWith("tools.compact.")).length, 6);
  assert.equal(Object.isFrozen(loaded.values), true);
});

test("the bundled pack is the frozen baseline text", () => {
  const loaded = loadBundledBase({ rootDir: PACK_ROOT, ...INVOCATION });

  for (const [name, frozen] of Object.entries(BASELINE.canonical)) {
    const raw = loaded.values[`tools.canonical.${name}.description`];
    assert.equal(typeof raw, "string", name);
    // The tool's own copy is the frozen description minus the registrar suffix.
    const expected = frozen.description.endsWith(BASELINE.memory.readHint)
      ? frozen.description.slice(0, -BASELINE.memory.readHint.length)
      : frozen.description.endsWith(BASELINE.memory.writeHint)
        ? frozen.description.slice(0, -BASELINE.memory.writeHint.length)
        : frozen.description;
    // A Base template may declare placeholders; the server fills the runtime value.
    assert.equal(renderPromptTemplate(raw, { memoryPath: "20-Memory" }), expected, `${name} copy`);
  }

  for (const key of ["firstRead", "checkpoint", "afterWrite", "readHint", "writeHint"]) {
    assert.equal(loaded.values[`memory.${key}`], BASELINE.memory[key], key);
  }
  assert.equal(loaded.values["prompts.research_brief.title"], BASELINE.prompts.researchBrief.title);
  assert.equal(loaded.values["prompts.research_brief.description"], BASELINE.prompts.researchBrief.description);
  assert.equal(loaded.values["bootstrap.instructions"], BASELINE.initializeInstructions);
  assert.equal(
    renderPromptTemplate(loaded.values["prompts.research_brief.body"], { topic: "golden topic" }),
    BASELINE.prompts.researchBrief.body,
  );
});

test("text reads keep interior blank lines and drop exactly one trailing break", () => {
  assert.equal(readBaseText(Buffer.from("a\nb\n", "utf8")), "a\nb");
  assert.equal(readBaseText(Buffer.from("a\r\nb\r\n", "utf8")), "a\r\nb");
  assert.equal(readBaseText(Buffer.from("a\nb\n", "utf8"), { stripFinalNewline: false }), "a\nb\n");
  assert.equal(readBaseText(Buffer.from("中文\n\n行\n", "utf8")), "中文\n\n行");
  assert.equal(readBaseText(Buffer.from("no-break", "utf8")), "no-break");
  rejects(() => readBaseText(Buffer.from([0xff, 0xfe, 0x00])), "not utf-8");
});

test("a valid pack is immutable and digest-stable", () => {
  const a = pack();
  const b = pack();
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, promptBaseDigest(a.values));
  assert.equal(Object.isFrozen(a.values), true);
  assert.throws(() => {
    a.values["memory.firstRead"] = "changed";
  });
});

test("blank text, control characters and over-limit text are rejected", () => {
  rejects(() => pack({}, { files: new Map([["memory/first-read.md", Buffer.from("   \n")]]) }), "blank text");
  rejects(() => pack({}, { files: new Map([["memory/first-read.md", Buffer.from("a\u0000b\n")]]) }), "control character");
  rejects(
    () => pack({}, { files: new Map([["memory/first-read.md", Buffer.from(`${"x".repeat(PROMPT_BASE_LIMITS["memory."] + 1)}\n`)]]) }),
    "text over limit",
  );
});

test("pack paths may not escape the pack root", () => {
  rejects(() => pack({ "memory.firstRead": { file: "../outside.md" } }), "file path escapes the pack");
  rejects(() => pack({ "memory.firstRead": { file: "/etc/passwd.md" } }), "file path must be a relative posix path");
  rejects(() => pack({ "memory.firstRead": { file: "memory\\first.md" } }), "file path must be a relative posix path");
  rejects(() => pack({ "memory.firstRead": { file: "memory/first.txt" } }), "file must end with .md");
});

test("key hygiene: unknown, duplicate and missing keys are rejected", () => {
  rejects(() => pack({ "tools.canonical.unregistered.description": { file: "tools/x.md" } }), "unknown canonical tool key");
  rejects(() => pack({ "memory.firstRead": { file: "memory/checkpoint.md" } }), "duplicate file");
  rejects(() => pack({ "mystery.key": { file: "mystery.md" } }), "unknown key");
  rejects(
    () =>
      validateBasePack({
        manifest: { schemaVersion: 1, keys: { "memory.firstRead": { file: "memory/first-read.md" } } },
        files: new Map([["memory/first-read.md", Buffer.from("x\n")]]),
        toolNames: [],
        compactDomains: [],
        promptNames: [],
      }),
    "missing required key",
  );
  rejects(
    () =>
      validateBasePack({
        manifest: pack().manifest,
        files: new Map(),
        toolNames: ["get_note"],
        compactDomains: ["obsidian_read"],
        promptNames: ["research_brief"],
      }),
    "missing file",
  );
});

test("placeholders are declared, single-use and never executable", () => {
  rejects(
    () => pack({ "prompts.research_brief.body": { file: "prompts/body.md" } }, { files: new Map([["prompts/body.md", Buffer.from("{{topic}}\n")]]) }),
    "undeclared placeholder",
  );
  rejects(
    () =>
      pack(
        { "prompts.research_brief.body": { file: "prompts/body.md", placeholders: ["topic"] } },
        { files: new Map([["prompts/body.md", Buffer.from("{{topic}} and {{topic}}\n")]]) },
      ),
    "declared placeholder must appear exactly once",
  );
  const ok = pack(
    { "prompts.research_brief.body": { file: "prompts/body.md", placeholders: ["topic"] } },
    { files: new Map([["prompts/body.md", Buffer.from('Search for "{{topic}}".\n')]]) },
  );
  assert.equal(renderPromptTemplate(ok.values["prompts.research_brief.body"], { topic: "x" }), 'Search for "x".');
  rejects(() => renderPromptTemplate("{{topic}}", {}), "no value for placeholder");
});

test("the pack budget and schema version are enforced", () => {
  rejects(
    () =>
      validateBasePack({
        manifest: { schemaVersion: 2, keys: pack().manifest.keys },
        files: new Map(Object.values(pack().manifest.keys).map((entry) => [entry.file, Buffer.from("x\n")])),
        toolNames: ["get_note"],
        compactDomains: ["obsidian_read"],
        promptNames: ["research_brief"],
      }),
    "unsupported schemaVersion",
  );
});

test("the whole pack has one budget, whatever the per-key limits allow", () => {
  const names = Array.from({ length: 300 }, (_, index) => `tool_${index}`);
  const keys = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`bootstrap.boundary.${index + 1}`, { file: `bootstrap/boundary-${index + 1}.md` }]),
  );
  const files = new Map(Object.entries(keys).map(([, entry]) => [entry.file, Buffer.from("x\n")]));
  for (const [key, entry] of Object.entries(pack().manifest.keys)) {
    if (key.startsWith("bootstrap.boundary.")) continue;
    keys[key] = entry;
    files.set(entry.file, Buffer.from("x\n"));
  }
  for (const name of names) {
    const file = `tools/${name}.md`;
    keys[`tools.canonical.${name}.description`] = { file };
    files.set(file, Buffer.from(`${"y".repeat(4000)}\n`));
  }
  rejects(
    () =>
      validateBasePack({
        manifest: { schemaVersion: 1, keys },
        files,
        toolNames: names,
        compactDomains: [],
        promptNames: [],
      }),
    "pack over limit",
  );
});

test("a symlink that leaves the pack root is refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-pack-"));
  const outside = path.join(root, "outside.md");
  await writeFile(outside, "outside\n");
  const packRoot = path.join(root, "base");
  await mkdir(path.join(packRoot, "memory"), { recursive: true });
  const loaded = loadBundledBase({ rootDir: PACK_ROOT, ...INVOCATION });
  for (const entry of Object.values(loaded.manifest.keys)) {
    const target = path.join(packRoot, entry.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "x\n");
  }
  await rm(path.join(packRoot, "memory/first-read.md"));
  await symlink(outside, path.join(packRoot, "memory/first-read.md"));
  await writeFile(path.join(packRoot, "manifest.json"), `${JSON.stringify(loaded.manifest, null, 2)}\n`);
  try {
    rejects(() => loadBundledBase({ rootDir: packRoot, ...INVOCATION }), "file path escapes the pack");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundled reader hands out one frozen snapshot", () => {
  const loaded = loadBundledBase({ rootDir: PACK_ROOT, ...INVOCATION });
  const reader = createBundledPromptReader(loaded);
  const snapshot = reader.snapshot();
  assert.equal(snapshot.status, "bundled");
  assert.equal(snapshot.baseDigest, loaded.digest);
  assert.equal(snapshot.overrideCount, 0);
  assert.equal(snapshot.values, loaded.values);
  assert.equal(reader.snapshot(), snapshot);
});
