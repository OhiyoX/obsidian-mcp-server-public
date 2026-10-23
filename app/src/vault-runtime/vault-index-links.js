// `src/vault-runtime/vault-index-links.js` — pure record projection helpers for the
// per-Vault VaultIndex runtime (`./vault-index-runtime.js`, contract §11).
//
// Extracted from `src/vault-index.js` unchanged so the runtime module stays inside the
// line gate. Everything here is stateless and root-free: link resolution and alias
// normalization work on an already-built record list, and the only imports are `node:path`
// and the root-free string helpers of `./local-fs.js` (contract §43-5/§43-7: no global root
// constant, no module-level mutable state, no environment read).

import path from "node:path";
import { normalizeVaultInput, stripMarkdownExtension } from "./local-fs.js";

/** Frontmatter `aliases`/`alias` normalized to a unique non-empty string list. */
export function normalizeAliases(frontmatter) {
  const value = frontmatter.aliases ?? frontmatter.alias ?? [];
  const aliases = Array.isArray(value) ? value : [value];
  return [...new Set(aliases.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeLookup(value) {
  return normalizeVaultInput(value).toLocaleLowerCase();
}

function withMarkdownExtension(value) {
  return /\.md$/i.test(value) ? value : `${value}.md`;
}

function commonDirectoryDepth(a, b) {
  const left = path.posix.dirname(a).split("/");
  const right = path.posix.dirname(b).split("/");
  let count = 0;
  while (count < left.length && count < right.length && left[count].toLocaleLowerCase() === right[count].toLocaleLowerCase()) count += 1;
  return count;
}

function selectBestCandidate(candidates, sourcePath) {
  return [...candidates].sort((a, b) => {
    const aSameDirectory = path.posix.dirname(a.path).toLocaleLowerCase() === path.posix.dirname(sourcePath).toLocaleLowerCase() ? 1 : 0;
    const bSameDirectory = path.posix.dirname(b.path).toLocaleLowerCase() === path.posix.dirname(sourcePath).toLocaleLowerCase() ? 1 : 0;
    if (aSameDirectory !== bSameDirectory) return bSameDirectory - aSameDirectory;
    const depthDifference = commonDirectoryDepth(b.path, sourcePath) - commonDirectoryDepth(a.path, sourcePath);
    if (depthDifference) return depthDifference;
    return a.path.length - b.path.length || a.path.localeCompare(b.path);
  })[0];
}

function buildLookup(records) {
  const byPath = new Map();
  const byName = new Map();
  const byAlias = new Map();

  function add(map, key, record) {
    if (!key) return;
    const normalized = normalizeLookup(key);
    const values = map.get(normalized) || [];
    values.push(record);
    map.set(normalized, values);
  }

  for (const record of records) {
    byPath.set(normalizeLookup(record.path), record);
    add(byName, record.basename, record);
    add(byName, path.posix.basename(record.path), record);
    for (const alias of record.aliases) add(byAlias, alias, record);
  }

  return { byPath, byName, byAlias };
}

function resolveLinkWithLookup(link, sourcePath, lookup) {
  const rawTarget = normalizeVaultInput(link.target || "");
  if (!rawTarget) return { status: "unresolved", target: link.target || "", candidates: [] };

  // Obsidian note basenames may contain arbitrary dots. Resolve against the
  // actual Markdown index before interpreting the final dot segment as a file
  // extension; otherwise names such as "v2026.09.25.11 发布与 NAS 部署" are
  // misclassified as attachments.
  const targetWithExtension = withMarkdownExtension(rawTarget);
  const sourceDirectory = path.posix.dirname(sourcePath);
  const exactCandidates = [];

  let currentDirectory = sourceDirectory === "." ? "" : sourceDirectory;
  while (true) {
    exactCandidates.push(path.posix.normalize(path.posix.join(currentDirectory, targetWithExtension)));
    if (!currentDirectory) break;
    const parent = path.posix.dirname(currentDirectory);
    currentDirectory = parent === "." ? "" : parent;
  }
  exactCandidates.push(path.posix.normalize(targetWithExtension));

  for (const candidate of [...new Set(exactCandidates)]) {
    const exact = lookup.byPath.get(normalizeLookup(candidate));
    if (exact) return { status: "resolved", target: link.target, path: exact.path, candidates: [exact.path] };
  }

  const basename = stripMarkdownExtension(path.posix.basename(rawTarget));
  const candidates = [...(lookup.byName.get(normalizeLookup(basename)) || []), ...(lookup.byAlias.get(normalizeLookup(rawTarget)) || [])];
  const unique = [...new Map(candidates.map((item) => [item.path, item])).values()];
  if (unique.length) {
    const selected = selectBestCandidate(unique, sourcePath);
    return {
      status: unique.length === 1 ? "resolved" : "ambiguous",
      target: link.target,
      path: selected.path,
      candidates: unique.map((item) => item.path).sort(),
    };
  }

  const extension = path.posix.extname(rawTarget).toLocaleLowerCase();
  if (extension && extension !== ".md") return { status: "attachment", target: link.target, candidates: [] };
  return { status: "unresolved", target: link.target, candidates: [] };
}

/**
 * Root-free resolver over an index record list. Legacy export of `src/vault-index.js`
 * (re-exported there by the compatibility facade with the same function identity).
 */
export function createLinkResolver(records) {
  const lookup = buildLookup(records);
  return (link, sourcePath) => resolveLinkWithLookup(link, sourcePath, lookup);
}
