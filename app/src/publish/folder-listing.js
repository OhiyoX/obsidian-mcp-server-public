// `src/publish/folder-listing.js` — the one bounded walker for a published folder.
//
// A folder record has one opaque address, and every note the address may show has one
// opaque token: `sha256(folderId NUL vaultPath)` cut to 22 base64url chars. A token
// names no path, so a traversal string cannot be a token, and a token of one record
// cannot select a note of another record (design 2026-11-08, "Address shape").
//
// This module owns three decisions once, for the Web routes and the MCP tools alike:
// what the index lists (the Task 1 predicate decides each note), which token resolves
// (the same walk, so the cap that hides a note hides its token too), and where the
// folder caps refuse (`publish_folder_too_large` / `publish_folder_too_deep`).
//
// One walk, two modes (`limits.overflow`): `truncate` bounds a public read and never
// throws, `refuse` bounds a publish and turns the one note past a cap into a refusal.
//
// Boundaries: it reads the Vault through the existing readers (`resolveWebVaultPath`,
// `readWebNote`) and never writes. It imports nothing from `service.js` or the routes.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readWebNote, resolveWebVaultPath } from "../app/vault-registry.js";
import { parseFrontmatter } from "../frontmatter.js";
import { PUBLISH_FOLDER_TOO_DEEP, PUBLISH_FOLDER_TOO_LARGE, PublishTargetError } from "./target.js";
import { isDraftSegment, readPublishMarker, visibilityOf } from "./visibility.js";

export const FOLDER_TOKEN_LENGTH = 22;
export const DEFAULT_FOLDER_LIMITS = Object.freeze({ maxNotes: 500, maxDepth: 8, maxScanned: 2000 });

// `vaultPath` is the note's Vault-relative path ("Dir/a.md"), not the folder-relative
// one: the same note gets one token per record only because the id is part of the input.
export function folderToken(folderId, vaultPath) {
  return createHash("sha256")
    .update(`${folderId}\0${vaultPath}`)
    .digest("base64url")
    .slice(0, FOLDER_TOKEN_LENGTH);
}

// Listing never throws for a cap, and only `assertWithinCaps` refuses: forcing the mode here
// makes that the module's contract rather than the caller's habit.
export async function listVisibleNotes({ vault, folderPath, folderId, limits }) {
  const { entries, truncated } = await walkFolder({
    vault,
    folderPath,
    folderId,
    limits: { ...limits, overflow: "truncate" },
  });
  return { notes: entries, truncated };
}

// A token is derived, never parsed: walk the same listing and take the matching entry.
// A forged or foreign token, and a path string, simply never match.
// A public read never throws, so the cap truncates: a note beyond it has no token.
export async function resolveToken({ vault, folderPath, folderId, token, limits }) {
  const wanted = String(token ?? "");
  if (!new RegExp(`^[A-Za-z0-9_-]{${FOLDER_TOKEN_LENGTH}}$`).test(wanted)) return null;
  const { entries } = await walkFolder({ vault, folderPath, folderId, limits: { ...limits, overflow: "truncate" } });
  return entries.find((entry) => entry.token === wanted) ?? null;
}

// The publish-time half of the caps: a folder the walk cannot finish is refused before
// the registry writes anything, so a refusal leaves `state.json` byte-identical.
export async function assertWithinCaps({ vault, folderPath, limits }) {
  // `overflow: "refuse"` is not optional here: the same walk that truncates a public read
  // must refuse a publish, one note past the cap.
  await walkFolder({ vault, folderPath, limits: { ...limits, overflow: "refuse" } });
}

async function walkFolder({ vault, folderPath, folderId = "", limits }) {
  const { maxNotes, maxDepth, maxScanned, overflow } = limitsOf(limits);
  const folder = await resolveWebVaultPath(vault, folderPath);
  const entries = [];
  let truncated = false;
  let stopped = false;
  // The budget counts files read, not notes listed: hiding a note still costs its read, so an
  // anonymous `no-store` request must not read a whole published folder of private notes.
  let scanned = 0;

  // The scanned budget answers like the note cap: a public read truncates, a publish refuses.
  const stopForScanBudget = () => {
    if (overflow === "refuse") {
      throw new PublishTargetError(
        PUBLISH_FOLDER_TOO_LARGE,
        `Publish target publishes more than ${maxScanned} Markdown files: ${folderPath}`,
        { path: String(folderPath ?? "") },
      );
    }
    truncated = true;
    stopped = true;
  };

  async function visit(directory, directoryPath, depth, inDraftSubtree) {
    if (stopped) return;
    let children;
    try {
      children = (await fs.readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      // A directory we cannot read lists nothing, and a public read must never throw for it.
      return;
    }
    for (const child of children) {
      // The cap stops the whole walk, not one frame: nothing past it is read, so a deep
      // directory behind the cap cannot answer `too_deep` where `too_large` is the answer.
      if (stopped) return;
      // A symlink is never walked: the anti-goal is a request that reaches a file outside
      // its record (design "Anti-goals").
      if (child.isSymbolicLink()) continue;
      const notePath = joinVaultPath(directoryPath, child.name);
      if (child.isDirectory()) {
        // A directory is never a reason to refuse: only a visible note deeper than
        // `maxDepth` is, so a deep asset tree with no note in it is walked and answers
        // nothing (design caps: "an image ... has no route").
        // A draft subtree never inherits visibility, but the walk still enters it: a note
        // inside it is public only when it says `publish: true` (Task 1 predicate).
        await visit(path.join(directory, child.name), notePath, depth + 1, inDraftSubtree || isDraftSegment(child.name));
        continue;
      }
      if (!child.isFile() || path.posix.extname(child.name).toLowerCase() !== ".md") continue;
      if (scanned >= maxScanned) {
        stopForScanBudget();
        return;
      }
      scanned += 1;
      const note = await readNoteVisibility(vault, notePath);
      if (note === null) continue;
      if (visibilityOf({ marker: note.marker, insidePublishedFolder: true, inDraftSubtree }) !== "visible") continue;
      // Size is decided before depth, so `too_large` wins when both would fire. In
      // `truncate` mode the note past the cap proves the listing is incomplete and stops it;
      // in `refuse` mode it is the one note that turns the publish down.
      if (entries.length >= maxNotes) {
        if (overflow === "refuse") {
          throw new PublishTargetError(
            PUBLISH_FOLDER_TOO_LARGE,
            `Publish target publishes more than ${maxNotes} notes: ${folderPath}`,
            { path: String(folderPath ?? "") },
          );
        }
        truncated = true;
        stopped = true;
        return;
      }
      // A public read hides a note that sits too deep; a publish is refused for it.
      if (depth > maxDepth) {
        if (overflow === "refuse") {
          throw new PublishTargetError(
            PUBLISH_FOLDER_TOO_DEEP,
            `Publish target is deeper than ${maxDepth} levels: ${notePath}`,
            { path: notePath },
          );
        }
        continue;
      }
      entries.push({
        relPath: notePath.slice(folderPrefix(folder.path).length),
        path: notePath,
        token: folderToken(folderId, notePath),
        title: titleOf(note.data, notePath),
      });
    }
  }

  await visit(folder.absolute, folder.path, 0, false);
  return { entries, truncated };
}

// One unreadable note hides itself. The reader refuses a note over `MAX_READ_BYTES` and a
// note that vanished mid-walk, and a marker we cannot read is not evidence of
// `publish: true`, so failing closed is the only safe answer.
// shortcut: an oversized note is therefore absent from the index, not listed with a 413 page;
// upgrade together with the note route that must answer 413 for it.
async function readNoteVisibility(vault, notePath) {
  let raw;
  try {
    raw = await readWebNote(vault, notePath);
  } catch {
    return null;
  }
  let data = null;
  try {
    // Malformed YAML frontmatter is not a marker; `readPublishMarker(null)` hides the note.
    data = parseFrontmatter(raw.content).data;
  } catch {
    data = null;
  }
  return { marker: readPublishMarker(data), data };
}

function titleOf(data, notePath) {
  const declared = typeof data?.title === "string" ? data.title.trim() : "";
  return declared || path.posix.basename(notePath, path.posix.extname(notePath));
}

function joinVaultPath(base, name) {
  return base ? `${base}/${name}` : name;
}

function folderPrefix(folderPath) {
  return folderPath ? `${folderPath}/` : "";
}

function limitsOf(limits) {
  const maxNotes = Math.max(1, Math.trunc(Number(limits?.maxNotes) || DEFAULT_FOLDER_LIMITS.maxNotes));
  const maxDepth = Math.max(1, Math.trunc(Number(limits?.maxDepth) || DEFAULT_FOLDER_LIMITS.maxDepth));
  const maxScanned = Math.max(1, Math.trunc(Number(limits?.maxScanned) || DEFAULT_FOLDER_LIMITS.maxScanned));
  // One walk, two modes: `truncate` bounds a public read, `refuse` bounds a publish.
  const overflow = limits?.overflow === "refuse" ? "refuse" : "truncate";
  return { maxNotes, maxDepth, maxScanned, overflow };
}
