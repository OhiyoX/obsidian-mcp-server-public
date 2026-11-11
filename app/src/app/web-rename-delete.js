import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyNotePlan, createDeleteFilePlan, createDeletePlan, createMovePlan, createNotePlan } from "../mutation-plans.js";
import { replaceVaultLinks } from "../obsidian.js";
import { PUBLISH_RECORD_KINDS } from "../publish/lifecycle.js";
import { publishService as defaultPublishService } from "../publish/service.js";
import { fileRevision, resolveVaultPath } from "../vault-runtime/request-vault.js";
import { assertWritable } from "../vault.js";
import { resolveWebVaultPath } from "./vault-registry.js";

const MAX_FOLDER_FILES = 500;
const MAX_REWRITTEN_NOTES = 200;
// Same cap as the Web editor (routes.js): a larger note is never read or rewritten here.
const MAX_EDITOR_BYTES = 2 * 1024 * 1024;
const PROTECTED_SEGMENTS = [".git", ".obsidian"];

/** A refusal the Web face can map straight onto an HTTP status. */
export class WebEntryError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = "WebEntryError";
    this.status = status;
    this.code = code;
  }
}

// The Vault path resolver speaks plain errors; the Web face needs a status.
async function resolveEntry(vault, userPath, options = {}) {
  try {
    return await resolveWebVaultPath(vault, userPath, options);
  } catch (error) {
    throw new WebEntryError(error.message, 400);
  }
}

// The Vault root and Obsidian's own state directories are never a rename or delete target.
function assertRenamable(rel) {
  if (!rel) throw new WebEntryError("Refusing to modify the vault root", 400);
  const segments = rel.split("/");
  if (segments.includes("..")) throw new WebEntryError("Invalid Vault path", 400);
  if (segments.some((segment) => PROTECTED_SEGMENTS.some((name) => segment.startsWith(name)))) {
    throw new WebEntryError(`Refusing to modify a protected path: ${rel}`, 400);
  }
}

async function countFiles(absPath) {
  let files = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else if (entry.isFile()) files += 1;
    }
  }
  await visit(absPath);
  if (files > MAX_FOLDER_FILES) throw new WebEntryError(`Too many files: ${files} > ${MAX_FOLDER_FILES}`, 413, "FOLDER_TOO_LARGE");
  return files;
}

// Vault-relative `*.md` files below a directory. Symbolic links and dot directories stay out.
async function listNotes(directory, relBase) {
  const found = [];
  async function visit(dir, rel) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(childAbs, childRel);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push({ rel: childRel, abs: childAbs });
    }
  }
  await visit(directory, relBase);
  return found;
}

// Every note whose text changes, with the path that note has after the rename.
// `from`/`to` are not needed: `files` carries each moved pair.
export function planFolderLinks({ files, notes }) {
  const items = [];
  for (const note of notes) {
    let next = note.raw;
    for (const pair of files) next = replaceVaultLinks(next, pair.fromRel, pair.toRel, note.path);
    if (next === note.raw) continue;
    // A moved note lives at its new path once the rename runs, so the item names that path.
    const moved = files.find((pair) => pair.fromRel === note.path);
    items.push({ path: moved ? moved.toRel : note.path, content: next });
  }
  if (items.length > MAX_REWRITTEN_NOTES) {
    throw new WebEntryError(`Too many notes to rewrite: ${items.length} > ${MAX_REWRITTEN_NOTES}`, 413, "LINKS_TOO_MANY");
  }
  return items;
}

// The scan bounds: the rewrite keeps every scanned note in memory until the plan is built, so a
// large Vault is refused instead of read. The 200-note rewrite cap is a different limit and
// applies after this one.
const MAX_SCANNED_NOTES = 5000;
const MAX_SCANNED_BYTES = 256 * 1024 * 1024;

// Read every note that the rewrite may touch. Oversized notes are skipped, not read.
async function readAllNotes(vault) {
  const listed = await listNotes(vault.root, "");
  if (listed.length > MAX_SCANNED_NOTES) {
    throw new WebEntryError("Vault has too many notes for a folder rename", 413, "TOO_MANY_NOTES");
  }
  const notes = [];
  let bytes = 0;
  for (const note of listed) {
    const size = (await fs.stat(note.abs)).size;
    if (size > MAX_EDITOR_BYTES) continue;
    bytes += size;
    if (bytes > MAX_SCANNED_BYTES) {
      throw new WebEntryError("Vault is too large to scan for links", 413, "SCAN_TOO_LARGE");
    }
    notes.push({ path: note.rel, raw: await fs.readFile(note.abs, "utf8") });
  }
  return notes;
}

// Rename the folder with one `fs.rename`, then hand the link plan to `applyLinks`.
// Every item path and every `updatedLinksIn` entry exists after the rename.
export async function renameWebFolder(vault, runtime, { from, to, applyLinks }) {
  assertWritable();
  const source = await resolveEntry(vault, from);
  const fromRel = source.path.split(path.sep).join("/");
  const target = await resolveEntry(vault, to, { allowMissing: true });
  const toRel = target.path.split(path.sep).join("/");

  assertRenamable(fromRel);
  assertRenamable(toRel);
  // A symbolic link is never renamed: the link target must stay out of reach.
  const stat = await fs.lstat(source.absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new WebEntryError("Folder not found", 400);
  if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
    throw new WebEntryError("Destination is inside the source folder", 400, "DESTINATION_INSIDE_SOURCE");
  }
  const taken = await fs.lstat(target.absolute).catch(() => null);
  if (taken) throw new WebEntryError("Destination exists", 409, "DESTINATION_EXISTS");

  // Everything that can refuse happens before the rename, so a refusal costs nothing.
  const files = await countFiles(source.absolute);
  const movedNotes = (await listNotes(source.absolute, fromRel)).map((note) => ({
    fromRel: note.rel,
    toRel: toRel + note.rel.slice(fromRel.length),
  }));
  const items = planFolderLinks({ from: fromRel, to: toRel, files: movedNotes, notes: await readAllNotes(vault) });

  await fs.rename(source.absolute, target.absolute);
  try {
    await applyLinks(items);
  } catch (error) {
    // The notes and their links must agree again, so put the directory back and rethrow.
    try {
      await fs.rename(target.absolute, source.absolute);
    } catch (restoreError) {
      // Both halves failed: nothing automated can reconcile this, so name the manual repair.
      console.error(
        `Web folder rename: the link plan failed and the rename back failed. Repair by hand: the folder is at ${target.absolute}, it belongs at ${source.absolute}.`,
        restoreError,
      );
      throw restoreError;
    }
    throw error;
  }
  return { kind: "folder", from: fromRel, to: toRel, updatedLinksIn: items.map((item) => item.path).sort(), files };
}

export async function deleteWebFolder(vault, runtime, { path: fromPath }) {
  assertWritable();
  const trashRoot = runtime?.paths?.trash;
  if (typeof trashRoot !== "string") throw new WebEntryError("Vault Trash is unavailable", 503, "TRASH_UNAVAILABLE");

  const resolved = await resolveEntry(vault, fromPath, { allowMissing: true });
  const rel = resolved.path.split(path.sep).join("/");
  let stat;
  try {
    stat = await fs.lstat(resolved.absolute);
  } catch {
    throw new WebEntryError("Folder not found", 404);
  }
  if (!stat.isDirectory()) throw new WebEntryError("Folder not found", 404);
  assertRenamable(rel);

  const files = await countFiles(resolved.absolute);

  // The stamp directory makes every delete reversible: the bytes move, they never get removed.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID();
  const stampDir = path.join(trashRoot, stamp);
  const destination = path.join(stampDir, rel);
  try {
    // A nested rel needs its parents; a bare `stampDir` is not enough (brief Step 3).
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(resolved.absolute, destination);
  } catch {
    // No bytes left the folder, so drop the empty stamp directory and refuse cleanly.
    await fs.rm(stampDir, { recursive: true, force: true }).catch(() => {});
    throw new WebEntryError("Could not move the folder into Trash", 500, "TRASH_MOVE_FAILED");
  }
  return { kind: "folder", deleted: rel, trash: stamp, files };
}

/** What the entry at an absolute Vault path is: a folder (or a link), a note, or any other file. */
export async function entryKind(absPath) {
  const stat = await fs.lstat(absPath);
  if (stat.isDirectory() || stat.isSymbolicLink()) return "folder";
  return path.extname(absPath).toLowerCase() === ".md" ? "note" : "attachment";
}

// A path that is gone is the caller's 404, not an engine failure.
async function entryKindOr404(absPath) {
  return entryKind(absPath).catch((error) => {
    if (error?.code === "ENOENT") throw new WebEntryError("Not found", 404);
    throw error;
  });
}

// The plan engine writes as the MCP author and resolves paths through the caller's runtime, so a
// call without one refuses before any I/O.
function requireRuntime(runtime) {
  if (!runtime) throw new WebEntryError("Vault runtime unavailable", 503, "vault_unavailable");
}

export async function renameWebNote(vault, runtime, { from, to, ifMatch, mutationId }) {
  requireRuntime(runtime);
  assertWritable();
  const source = await resolveEntry(vault, from, { assumeMarkdown: true, allowMissing: true });
  const fromRel = source.path.split(path.sep).join("/");
  const target = await resolveEntry(vault, to, { assumeMarkdown: true, allowMissing: true });
  const toRel = target.path.split(path.sep).join("/");
  assertRenamable(fromRel);
  assertRenamable(toRel);

  const stat = await fs.lstat(source.absolute).catch(() => null);
  if (!stat?.isFile()) throw new WebEntryError("Note not found", 404);
  // The same `sha256:<hex>` token `fileRevision` returns, compared here so the engine need not.
  if (ifMatch) {
    const revision = `sha256:${createHash("sha256").update(await fs.readFile(source.absolute)).digest("hex")}`;
    if (ifMatch !== revision) throw new WebEntryError("Revision conflict", 409, "REVISION_CONFLICT");
  }
  if (await fs.lstat(target.absolute).catch(() => null)) {
    throw new WebEntryError("Destination exists", 409, "DESTINATION_EXISTS");
  }

  let plan;
  try {
    plan = await createMovePlan({ from: fromRel, to: toRel, overwrite: false, updateLinks: true, ifMatch: null }, { runtime });
  } catch (error) {
    // The plan engine refuses a move that would rewrite more than 25 notes. That is a size
    // refusal, not a server fault: answer 413 so the client stops offering a retry.
    if (/more than 25 notes/.test(error?.message || "")) {
      throw new WebEntryError("Move affects more than 25 notes", 413, "TOO_MANY_LINK_NOTES");
    }
    throw error;
  }
  const applied = await applyNotePlan(plan.planId, plan.planHash, mutationId);
  // The plan also lists the move itself; the caller wants the notes whose links changed.
  const updatedLinksIn = applied.changed.map((change) => change.path).filter((rel) => rel !== fromRel && rel !== toRel);
  return { kind: "note", from: fromRel, to: toRel, updatedLinksIn };
}

export async function deleteWebFile(vault, runtime, { path: entryPath }) {
  requireRuntime(runtime);
  assertWritable();
  const resolved = await resolveEntry(vault, entryPath, { allowMissing: true });
  const rel = resolved.path.split(path.sep).join("/");
  const kind = await entryKindOr404(resolved.absolute);
  if (kind === "folder") throw new WebEntryError("Use the folder route to delete a folder", 400);
  assertRenamable(rel);

  // Both factories keep the bytes in the Vault Trash; a note and an attachment differ only in the read.
  const plan = kind === "note"
    ? await createDeletePlan({ path: rel, backup: true }, { runtime })
    : await createDeleteFilePlan({ path: rel }, { runtime });
  const applied = await applyNotePlan(plan.planId, plan.planHash, randomUUID());
  return { kind, deleted: rel, trash: applied.changed[0].backup };
}

// The link rewrite of a folder rename as one plan. The directory rename already ran, so every
// item path exists and its revision is read there. `planFolderLinks` hands out post-rename paths:
// write each item path as given, never apply the `from -> to` rule again.
async function applyLinkPlan(items, mutationId) {
  if (items.length === 0) return;
  const changes = [];
  for (const item of items) {
    const abs = resolveVaultPath(item.path, { assumeMarkdown: true });
    changes.push({ path: item.path, operation: "raw", raw: item.content, baseRevision: await fileRevision(abs) });
  }
  const plan = await createNotePlan(changes);
  await applyNotePlan(plan.planId, plan.planHash, mutationId);
}

// The file operation is the user's intent; the registry is a consequence. A record that cannot
// follow is one log line, never a half-failed rename or delete.
async function updateRecord(label, task) {
  try {
    await task();
  } catch (error) {
    console.error(`Publish record update failed (${label}):`, error);
  }
}

/** One rename entry point for the Web face: folder, note, or a refusal (an attachment). */
export async function renameWebEntry(vault, runtime, { path: entryPath, to, ifMatch, mutationId, publishService = defaultPublishService }) {
  requireRuntime(runtime);
  // A folder rename applies a second plan after the directory moved. Without a caller key a
  // retry would apply that plan twice, so the client must mint one (`web-rename:<uuid>`).
  if (typeof mutationId !== "string" || mutationId === "") throw new WebEntryError("Rename requires mutationId", 400, "MUTATION_ID_REQUIRED");
  const resolved = await resolveEntry(vault, entryPath, { allowMissing: true });
  const kind = await entryKindOr404(resolved.absolute);
  if (kind !== "folder" && kind !== "note") throw new WebEntryError("Attachments cannot be renamed", 400);
  const result = kind === "folder"
    ? await renameWebFolder(vault, runtime, {
      from: entryPath,
      to,
      applyLinks: (items) => applyLinkPlan(items, mutationId),
    })
    : await renameWebNote(vault, runtime, { from: entryPath, to, ifMatch, mutationId });
  // The record follows the file, so a renamed folder or a renamed published note keeps its
  // address.
  await updateRecord(`${result.from} -> ${result.to}`, () => publishService.moveRecord(vault.id, result.from, result.to));
  return result;
}

/** One delete entry point for the Web face: a folder into the Trash, else the file plan. */
export async function deleteWebEntry(vault, runtime, { path: entryPath, confirm, publishService = defaultPublishService }) {
  requireRuntime(runtime);
  if (confirm !== true) throw new WebEntryError("Deletion requires confirm: true", 400, "CONFIRM_REQUIRED");
  // Resolved first, so a path that is already gone answers 404 and not an engine 500.
  const resolved = await resolveEntry(vault, entryPath, { allowMissing: true });
  const kind = await entryKindOr404(resolved.absolute);
  // A deleted folder needs no hook: its record observes a missing target and orphans itself on
  // the next read, so the index answers 404 for ever. A deleted note retires its record now.
  if (kind === "folder") return deleteWebFolder(vault, runtime, { path: entryPath });
  const result = await deleteWebFile(vault, runtime, { path: entryPath });
  // Only a note can hold a document record; an attachment has no address to retire.
  if (result.kind !== "note") return result;
  await updateRecord(`deleted ${result.deleted}`, () => publishService.revoke(vault.id, result.deleted, { kind: PUBLISH_RECORD_KINDS.DOCUMENT }));
  return result;
}
