// Web folder write path (U6): create one Vault folder.
//
// It mirrors the MCP `manage_folders` `create` semantics (recursive parent
// creation, hidden/`..`/excluded-segment rejection, canonical containment) but is
// wired through the exact Web write pipeline the note route uses:
// requireApi + requireCsrf + writeGate + `obsidian.write` scope + assertWritable()
// + audit. The only added contract is a strict 409 when the folder already exists
// (so the client can surface "already exists" instead of silently no-op).
import fs from "node:fs/promises";
import path from "node:path";
import { EXCLUDED_DIRS } from "../config.js";
import { assertCanonicalInsideRoot, assertWritable } from "../vault.js";
import { ensureCatalogDirectory } from "./web-catalog/indexer.js";
import { getWebCatalogRuntime } from "./web-catalog/runtime.js";

// A typed failure the route can map to a status without leaking internals.
export class WebFolderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WebFolderError";
    this.status = status;
  }
}

// Strict vault-relative folder path. Unlike normalizeVaultInput this never
// silently collapses `a/../b`: every segment must be a plain, visible name.
export function normalizeWebFolderPath(input) {
  const raw = String(input ?? "").replaceAll("\\", "/").replace(/\0/g, "").trim();
  if (!raw) throw new WebFolderError("Folder name is required", 400);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new WebFolderError("Absolute paths are not allowed", 400);
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) throw new WebFolderError("Folder name is required", 400);
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new WebFolderError("Path traversal denied", 400);
    if (segment.startsWith(".")) throw new WebFolderError("Hidden folders are not allowed", 400);
    if (EXCLUDED_DIRS.has(segment)) throw new WebFolderError("Excluded folder", 400);
  }
  return segments.join("/");
}

export async function createWebFolder(vault, userPath) {
  assertWritable();
  const rel = normalizeWebFolderPath(userPath);
  const root = path.resolve(vault.root);
  const absolute = path.resolve(root, ...rel.split("/"));
  await assertCanonicalInsideRoot(root, absolute, { allowMissing: true });

  // Recursive parent creation is part of the `create` contract; every existing
  // level is re-checked for canonical containment before the leaf is created.
  const parent = path.dirname(absolute);
  if (parent !== root) {
    await fs.mkdir(parent, { recursive: true });
    await assertCanonicalInsideRoot(root, parent);
  }

  try {
    // Non-recursive mkdir: an existing leaf is an atomic EEXIST (409), never a
    // silent success, and two concurrent creates cannot both report created.
    await fs.mkdir(absolute);
  } catch (error) {
    if (error?.code === "EEXIST") throw new WebFolderError("Folder already exists", 409);
    if (error?.code === "ENOTDIR") throw new WebFolderError("A parent path is not a folder", 400);
    throw error;
  }

  // Read-your-writes: publish the directory node (and its ancestors) now so the
  // Explorer shows the new folder without waiting for the next reconcile; the
  // watcher reconcile remains the backstop.
  const catalog = getWebCatalogRuntime(vault);
  if (catalog?.store) ensureCatalogDirectory(catalog.store, rel);

  return { path: rel, created: true };
}
