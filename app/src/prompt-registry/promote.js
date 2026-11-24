// Promote a tested Runtime Override into the developer-maintained Base files.
//
// This writes files in a worktree the developer named and answers the diff. It never
// commits, pushes, touches the running server or edits the Vault: the operator reviews
// the change like any other code change, then publishes the new Base with
// `base publish --reset-overrides`.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function refuse(reason, detail) {
  const error = new Error(detail === undefined ? reason : `${reason}: ${detail}`);
  error.code = "PROMOTE_REFUSED";
  error.reason = reason;
  return error;
}

/** Resolve a pack file inside the worktree, refusing anything that leaves it. */
async function resolvePackFile(packRoot, relative) {
  if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative) || relative.includes("\\")) {
    throw refuse("unsafe file path", String(relative));
  }
  if (relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw refuse("unsafe file path", relative);
  }
  const target = path.join(packRoot, relative);
  const realRoot = await fs.realpath(packRoot);
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    throw refuse("missing file", relative);
  }
  const inside = path.relative(realRoot, real);
  if (inside === "" || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw refuse("file escapes the pack", relative);
  }
  return real;
}

/**
 * Apply the overrides in `keys` to their Base files in `worktreeDir`.
 * Returns the changed files, the diff, and the revision/values the follow-up
 * publish must assert so a concurrent override change cannot be deleted silently.
 */
export async function promoteOverridesToWorktree({ worktreeDir, overrides, keys, sourceBasePack, io = fs } = {}) {
  if (typeof worktreeDir !== "string" || worktreeDir === "") throw refuse("worktreeDir is required");
  if (!Array.isArray(keys) || keys.length === 0) throw refuse("at least one key is required");
  if (overrides === null || typeof overrides !== "object") throw refuse("overrides are required");

  const root = path.resolve(worktreeDir);
  const packRoot = path.join(root, "app", "prompts", "base");
  let manifest;
  try {
    manifest = JSON.parse(await io.readFile(path.join(packRoot, "manifest.json"), "utf8"));
  } catch {
    throw refuse("not a worktree with app/prompts/base", worktreeDir);
  }

  const planned = [];
  for (const key of keys) {
    const entry = manifest.keys?.[key];
    if (entry === undefined) throw refuse("unknown key for this worktree", key);
    if (entry.overrideAllowed !== true) throw refuse("base-only key", key);
    const value = overrides[key];
    if (typeof value !== "string" || value.trim() === "") throw refuse("override is not text", key);
    const file = await resolvePackFile(packRoot, entry.file);
    const current = await io.readFile(file, "utf8");
    const normalized = current.replace(/\r?\n$/, "");
    if (normalized === value) throw refuse("already the same text", key);
    // The override was written against a Base that may have moved on. A file whose
    // current text is neither the old Base nor the override would silently lose an
    // edit, so it is refused for a human to resolve.
    if (sourceBasePack?.values?.[key] !== undefined && normalized !== sourceBasePack.values[key] && normalized !== value) {
      throw refuse("worktree text differs from both the active Base and the override", key);
    }
    planned.push({ key, file, value, previous: normalized, relative: entry.file });
  }

  const changedFiles = [];
  for (const item of planned) {
    await io.writeFile(item.file, `${item.value}\n`, "utf8");
    changedFiles.push(item.relative);
  }

  let diff = "";
  try {
    const { stdout } = await run("git", ["diff", "--", "app/prompts/base"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    diff = stdout;
  } catch (error) {
    throw refuse("git diff failed in the worktree", String(error?.message ?? error));
  }

  return Object.freeze({
    changedFiles: Object.freeze(changedFiles),
    diff,
    expectedRevision: null, // the caller fills it from the live state
    expectedEffectiveValues: Object.freeze(Object.fromEntries(planned.map((item) => [item.key, item.value]))),
    previousValues: Object.freeze(Object.fromEntries(planned.map((item) => [item.key, item.previous]))),
  });
}
