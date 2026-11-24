// P3: promote an override into Git Base files, and publish Base + reset in one CAS.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { promoteOverridesToWorktree } from "../src/prompt-registry/promote.js";
import { createPromptAdminService } from "../src/prompt-registry/service.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";

const run = promisify(execFile);
const bundled = bundledBasePack();
const roots = [];

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A throwaway git worktree holding the pack, so `git diff` is a real diff. */
async function worktreeWithPack() {
  const root = await mkdtemp(path.join(tmpdir(), "promote-worktree-"));
  roots.push(root);
  const packRoot = path.join(root, "app", "prompts", "base");
  await mkdir(path.join(packRoot, "tools", "canonical"), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    keys: {
      "tools.canonical.get_note.description": { file: "tools/canonical/get_note.md", overrideAllowed: true },
      "bootstrap.instructions": { file: "bootstrap-instructions.md", overrideAllowed: false },
    },
  };
  await writeFile(path.join(packRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(packRoot, "tools", "canonical", "get_note.md"), `${bundled.values["tools.canonical.get_note.description"]}\n`);
  await writeFile(path.join(packRoot, "bootstrap-instructions.md"), "Base-only text.\n");
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "test"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "pack"], { cwd: root });
  return { root, packRoot };
}

test("promote writes only the mapped file and answers a reviewable diff", async () => {
  const { root } = await worktreeWithPack();
  const key = "tools.canonical.get_note.description";
  const result = await promoteOverridesToWorktree({
    worktreeDir: root,
    overrides: { [key]: "Promoted copy for get_note." },
    keys: [key],
    sourceBasePack: bundled,
  });
  assert.deepEqual([...result.changedFiles], ["tools/canonical/get_note.md"]);
  assert.match(result.diff, /Promoted copy for get_note\./);
  assert.deepEqual(result.expectedEffectiveValues, { [key]: "Promoted copy for get_note." });
  const written = await readFile(path.join(root, "app", "prompts", "base", "tools", "canonical", "get_note.md"), "utf8");
  assert.equal(written, "Promoted copy for get_note.\n");
  // No commit was made: the change is still the developer's to review.
  const { stdout: status } = await run("git", ["status", "--short"], { cwd: root });
  assert.match(status, /M app\/prompts\/base\/tools\/canonical\/get_note\.md/);
  const { stdout: log } = await run("git", ["log", "--oneline"], { cwd: root });
  assert.equal(log.trim().split("\n").length, 1, "promote never commits");
});

test("promote refuses base-only keys, unknown keys and escapes", async () => {
  const { root } = await worktreeWithPack();
  await assert.rejects(
    promoteOverridesToWorktree({ worktreeDir: root, overrides: { "bootstrap.instructions": "x" }, keys: ["bootstrap.instructions"], sourceBasePack: bundled }),
    /base-only key/,
  );
  await assert.rejects(
    promoteOverridesToWorktree({ worktreeDir: root, overrides: { "no.such.key": "x" }, keys: ["no.such.key"], sourceBasePack: bundled }),
    /unknown key/,
  );
  await assert.rejects(
    promoteOverridesToWorktree({ worktreeDir: path.join(root, ".."), overrides: {}, keys: ["tools.canonical.get_note.description"], sourceBasePack: bundled }),
    /not a worktree/,
  );
});

test("promote refuses a file that moved away from the active Base", async () => {
  const { root, packRoot } = await worktreeWithPack();
  const key = "tools.canonical.get_note.description";
  await writeFile(path.join(packRoot, "tools", "canonical", "get_note.md"), "someone else edited this\n");
  await assert.rejects(
    promoteOverridesToWorktree({ worktreeDir: root, overrides: { [key]: "promoted" }, keys: [key], sourceBasePack: bundled }),
    /differs from both/,
  );
});

test("publish + reset is one atomic commit, and a stale override loses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "promote-publish-"));
  roots.push(root);
  const store = createPromptRegistryStore({
    headFile: path.join(root, "agent-prompts.json"),
    packsDir: path.join(root, "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  const service = createPromptAdminService({ store, bundledBase: bundled });
  const key = "memory.firstRead";

  await service.publishOverride({ expectedRevision: 0, set: { [key]: "promoted text" }, reason: "seed" });
  const published = await service.publishBase({
    expectedRevision: 1,
    pack: { values: { ...bundled.values, [key]: "promoted text" } },
    resetOverriddenKeys: [key],
    expectedOverrideValues: { [key]: "promoted text" },
    reason: "promote",
  });
  assert.equal(published.ok, true);
  assert.equal(store.snapshot().overrideCount, 0, "the override is gone in the same commit");
  assert.equal(store.snapshot().values[key], "promoted text");
  assert.equal(store.snapshot().sources[key], "base");

  // A second admin changed the override first: the reset must lose, not delete it.
  await service.publishOverride({ expectedRevision: store.snapshot().revision, set: { [key]: "someone else" }, reason: "concurrent" });
  const stale = await service.publishBase({
    expectedRevision: store.snapshot().revision,
    pack: { values: { ...bundled.values, [key]: "promoted text" } },
    resetOverriddenKeys: [key],
    expectedOverrideValues: { [key]: "promoted text" },
    reason: "stale promote",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "PROMPT_STALE_OVERRIDE");
  assert.equal(store.snapshot().values[key], "someone else", "the newer override survives");
});
