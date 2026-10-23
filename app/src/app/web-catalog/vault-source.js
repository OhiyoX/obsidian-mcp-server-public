// Root-scoped Vault source primitives for the Web Catalog.
//
// Contract: Phase 2A-0 — every authorized Web Vault indexes its OWN vault.root.
// The primary Vault is no longer special: the enumerator and the path projection
// are parameterized by root, so a secondary Vault never reads the primary tree and
// each Vault keeps an independent store/catalogId/generation/stale/coverage.
//
// Wave A / A2 adds a typed inventory: .md is a `note` document, .base is a `base`
// document. Both share one sorted-DFS policy (hidden/symlink/EXCLUDED_DIRS skipped,
// case-insensitive extension, canonical containment unchanged).
// S2 extends the *inventory* enumerator to every regular visible file, so a
// non-Markdown/non-Base attachment is indexed as a `file` node (metadata only).
// `isCatalogDocumentPath` keeps its original md/base meaning so the watcher's
// `note.*` vs `asset.changed` SSE classification does not change.
import fs from "node:fs/promises";
import path from "node:path";
import { EXCLUDED_DIRS } from "../../config.js";

const DEFAULT_DEPTH = 20;

export const NOTE_KIND = "note";
export const BASE_KIND = "base";
export const FILE_KIND = "file";
// An explicit directory node. Until U6 directories only reached the catalog as a
// side effect of a file's ancestor chain (ensureCatalogDirectories), so a folder
// that recursively contains no catalog document was invisible in the Explorer.
export const DIRECTORY_KIND = "directory";

const MARKDOWN_EXTENSIONS = new Set([".md"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".base"]);

export function toRootRelative(root, absolute) {
  return String(path.relative(root, absolute)).split(path.sep).join("/");
}

// `name` is a single path segment; returns the catalog document kind or null.
export function documentKindForName(name) {
  const ext = path.extname(String(name ?? "")).toLowerCase();
  if (ext === ".md") return NOTE_KIND;
  if (ext === ".base") return BASE_KIND;
  return null;
}

// Inventory classifier: every regular file is exactly one of note | base | file.
// `file` covers extension-less attachments (`LICENSE`) as well.
export function catalogKindForName(name) {
  return documentKindForName(name) ?? FILE_KIND;
}

// A vault-relative path the inventory may index at all (every segment visible).
// Visibility is not authorization: this only mirrors the walk's hidden-segment rule.
export function isCatalogInventoryPath(relative) {
  const segments = String(relative ?? "").split("/").filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.some((segment) => segment.startsWith("."));
}

// A vault-relative logical path is a document iff every segment is visible and the
// final one carries a document extension. Used by the watcher to classify events.
export function isCatalogDocumentPath(relative) {
  const segments = String(relative ?? "").split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment.startsWith("."))) return false;
  return documentKindForName(segments[segments.length - 1]) !== null;
}

// Shared sorted DFS. `extensions` bounds which suffixes count toward maxEntries, so
// a caller that only wants Markdown is not starved by unrelated documents.
// `includeAllFiles` accepts every regular, non-hidden file (attachments included).
// `includeDirectories` additionally records each visible, non-excluded directory
// itself (sorted-DFS order), which is how an empty folder becomes an index node.
// The directory budget is independent of `maxEntries` so a directory listing is
// never truncated by unrelated files.
async function walk(root, { extensions, includeAllFiles, includeDirectories = false, maxEntries, includeHidden, depth }) {
  const files = [];
  const directories = [];
  async function visit(current, currentDepth) {
    if (files.length >= maxEntries && directories.length >= maxEntries) return;
    const dirents = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const dirent of dirents) {
      if (files.length >= maxEntries && directories.length >= maxEntries) return;
      if (!includeHidden && dirent.name.startsWith(".")) continue;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (EXCLUDED_DIRS.has(dirent.name)) continue;
        if (includeDirectories && directories.length < maxEntries) {
          directories.push({ absolute: path.join(current, dirent.name), kind: DIRECTORY_KIND });
        }
        if (currentDepth < depth) await visit(path.join(current, dirent.name), currentDepth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!includeAllFiles && !extensions.has(path.extname(dirent.name).toLowerCase())) continue;
      if (files.length >= maxEntries) continue;
      files.push({ absolute: path.join(current, dirent.name), kind: catalogKindForName(dirent.name) });
    }
  }
  await visit(root, 0);
  return { files, directories };
}

function walkOptions(options, { extensions, includeAllFiles = false, includeDirectories = false }) {
  return {
    extensions,
    includeAllFiles,
    includeDirectories,
    maxEntries: options.maxEntries ?? Number.MAX_SAFE_INTEGER,
    includeHidden: options.includeHidden ?? false,
    depth: options.depth ?? DEFAULT_DEPTH,
  };
}

// Legacy contract: Markdown only. maxEntries counts Markdown documents.
export async function listMarkdownUnder(root, options = {}) {
  const found = await walk(root, walkOptions(options, { extensions: MARKDOWN_EXTENSIONS }));
  return found.files.map((entry) => entry.absolute);
}

// Typed contract: { absolute, kind: "note" | "base" } under the same walk policy.
export async function listCatalogDocumentsUnder(root, options = {}) {
  return (await walk(root, walkOptions(options, { extensions: DOCUMENT_EXTENSIONS }))).files;
}

// Typed contract: { absolute, kind: "note" | "base" | "file" } for every regular
// visible file. The S2 reconcile uses this so attachments become catalog nodes;
// `listMarkdownUnder` / `listCatalogDocumentsUnder` keep their narrower contracts.
export async function listCatalogInventoryUnder(root, options = {}) {
  return (await walk(root, walkOptions(options, { includeAllFiles: true }))).files;
}

// Typed contract: { absolute, kind: "directory" } for every visible, non-excluded
// directory under the same walk policy (sorted DFS). The reconcile adds these as
// explicit `directory` nodes so a folder that recursively holds no catalog document
// still appears in the Explorer tree.
export async function listCatalogDirectoriesUnder(root, options = {}) {
  return (await walk(root, walkOptions(options, { includeAllFiles: true, includeDirectories: true }))).directories;
}
