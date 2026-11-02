// Web note context: outgoing links (sidebar Phase 2) + incoming links (Phase 3).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Obsidian Web 笔记信息侧栏.md
// (Phase 2/3; the outgoing DTO was frozen by the coordinator for the E3 slice).
//
// GET /api/web/v1/note-context/outgoing?path=<vault-relative.md>
//   -> { vaultId, path, revision, links: [{ target, kind, resolvedPath, alias, heading }] }
// GET /api/web/v1/note-context/incoming?path=<vault-relative.md>
//   -> { vaultId, path, revision, links: [{ sourcePath, target, alias, heading }], truncated }
//
// Single source of truth: the canonical `extractLinks` projection (same one the
// vault index and the A2 catalog use) plus the existing Web link resolver
// (`resolveWebNoteLink`) for kind/resolution. This module never re-implements
// link parsing or Obsidian link resolution.
//
// Outgoing answers from one note body (the note is the subject, so a body read is
// required). Incoming answers from the Catalog projections only (`note_links` +
// `nodes`) and never touches the Vault filesystem: the reverse lookup runs the
// same canonical `createLinkResolver` over the Catalog's basename/alias records.
//
// Read-only. No body is returned and no note content leaves the API.
import fs from "node:fs/promises";
import { extractLinks } from "../obsidian.js";
import { createLinkResolver } from "../vault-index.js";
import { readNoteInRoot } from "./web-catalog/note-reader.js";
import { getWebCatalogRuntime } from "./web-catalog/runtime.js";
import { NOTE_KIND } from "./web-catalog/vault-source.js";
import { buildUnlinkedMentions } from "./note-context-unlinked.js";
import { resolveWebNoteLink, resolveWebVaultPath } from "./vault-registry.js";

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function notFound(res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).json({ error: "Not found" });
}

function forbidden(res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(403).json({ error: "Vault access denied" });
}

// The API only accepts an explicit Markdown document path. Anything else
// (missing, non-.md, traversal, absolute, protected) is a 404 so the error body
// can never disclose vault layout or absolute paths.
function requestedMarkdownPath(raw) {
  const value = String(raw ?? "").trim();
  if (!value || !/\.md$/i.test(value)) return null;
  return value;
}

function splitFragment(target) {
  const value = String(target ?? "");
  const index = value.indexOf("#");
  if (index < 0) return { bare: value, fragment: "" };
  return { bare: value.slice(0, index), fragment: value.slice(index + 1) };
}

function isExternal(bare) {
  return EXTERNAL_SCHEME.test(bare) || bare.startsWith("//");
}

// Prefer the canonical anchor from `extractLinks` (wiki links); markdown links
// keep the fragment inside `target`, so fall back to the raw target fragment.
function headingOf(link, fragment) {
  const anchor = typeof link?.anchor === "string" ? link.anchor : "";
  const value = String(anchor || fragment || "").trim();
  if (!value) return null;
  const stripped = value.replace(/^#/, "").trim();
  return stripped || null;
}

export async function buildOutgoingLinks(vault, rawPath) {
  const requestPath = requestedMarkdownPath(rawPath);
  if (!requestPath) return { status: 404 };

  let resolved;
  try {
    resolved = await resolveWebVaultPath(vault, requestPath, { assumeMarkdown: false });
  } catch (error) {
    // Invalid/traversal/absolute/symlink-escape/nonexistent all collapse to 404.
    if (error?.code === "ENOENT" || /Invalid Vault path|Path traversal denied|Symbolic link escapes|Protected/i.test(String(error?.message || ""))) {
      return { status: 404 };
    }
    throw error;
  }

  let stat;
  try {
    stat = await fs.stat(resolved.absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { status: 404 };
    throw error;
  }
  if (!stat.isFile()) return { status: 404 };

  let note;
  try {
    note = await readNoteInRoot(vault.root, resolved.absolute, { tolerateMalformedFrontmatter: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") return { status: 404 };
    throw error;
  }

  // `note.content` is the frontmatter-stripped body, matching `documentMap` in
  // the vault index: frontmatter links are a different projection and must not
  // leak into the body-link list.
  const canonical = extractLinks(note.content, note.path);
  const resolvedAt = new Map();
  const seen = new Set();
  const links = [];

  for (const link of canonical) {
    const rawTarget = String(link?.target ?? "");
    const { bare, fragment } = splitFragment(rawTarget);
    let kind;
    let resolvedPath = null;

    if (isExternal(bare)) {
      kind = "external";
    } else {
      // Ambiguity never guesses a different Vault: the resolver's deterministic
      // selection (same-directory/shallowest) is reused verbatim.
      let resolution = resolvedAt.get(bare);
      if (!resolution) {
        resolution = await resolveWebNoteLink(vault, note.path, bare);
        resolvedAt.set(bare, resolution);
      }
      const status = resolution?.status;
      if (status === "resolved" || status === "ambiguous") {
        kind = "note";
        resolvedPath = typeof resolution.path === "string" ? resolution.path : null;
      } else if (status === "attachment") {
        kind = "asset";
      } else {
        kind = "unresolved";
      }
    }

    const key = `${kind}\u0000${resolvedPath ?? rawTarget}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      target: rawTarget,
      kind,
      resolvedPath,
      alias: link?.alias ? String(link.alias) : null,
      heading: headingOf(link, fragment),
    });
  }

  return { status: 200, body: { vaultId: vault.id, path: note.path, revision: note.revision, links } };
}

// Incoming links are bounded per note. Above the cap the response is truncated by
// `sourcePath` order and reports it, so a client can never mistake a truncated list
// for the complete set.
const MAX_INCOMING_SOURCES = 200;

// The catalog stores one canonical raw target per (source, target) pair
// (`extractLinks().target`), which drops the wiki-link anchor and every link alias.
// `heading` is therefore recovered only when the raw target itself carries a
// `#fragment` (Markdown-style links); `alias` is always null in this projection.
function headingFromTarget(target) {
  const { fragment } = splitFragment(target);
  const value = String(fragment ?? "").trim();
  return value || null;
}

// Same alias normalization the vault index uses when it builds resolver records,
// so resolution agrees with `resolveWebNoteLink` for alias targets too.
function aliasesOf(frontmatter) {
  const value = frontmatter?.aliases ?? frontmatter?.alias ?? [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

// A catalog that was never reconciled is not an authoritative empty Vault (the
// tree/search/Base routes treat it the same way) and must fail closed instead of
// answering "no backlinks".
function readyCatalogStore(vault) {
  const runtime = getWebCatalogRuntime(vault, { startReconcile: false });
  if (!runtime) return null;
  const store = runtime.store;
  if (!store.metaGet("lastReconciledAt")) return null;
  const catalogId = store.catalogId();
  if (typeof catalogId !== "string" || catalogId === "") return null;
  return store;
}

function notReady() {
  return { status: 503, code: "catalog-not-ready" };
}

export async function buildIncomingLinks(vault, rawPath) {
  const requestPath = requestedMarkdownPath(rawPath);
  if (!requestPath) return { status: 404 };

  let resolved;
  try {
    resolved = await resolveWebVaultPath(vault, requestPath, { assumeMarkdown: false });
  } catch (error) {
    if (error?.code === "ENOENT" || /Invalid Vault path|Path traversal denied|Symbolic link escapes|Protected/i.test(String(error?.message || ""))) {
      return { status: 404 };
    }
    throw error;
  }
  const targetPath = resolved.path;

  let store;
  try {
    store = readyCatalogStore(vault);
  } catch {
    return notReady();
  }
  if (!store) return notReady();

  // Existence and revision come from the `nodes` projection, never from the Vault:
  // an unindexed/invalid catalog path is a leak-free 404 exactly like outgoing.
  let node;
  try {
    node = store.locate(targetPath);
  } catch {
    return { status: 404 };
  }
  if (!node || node.kind !== NOTE_KIND) return { status: 404 };

  let records;
  try {
    const metadata = store.listDocumentMetadata({ kinds: [NOTE_KIND] });
    records = store.readDocumentRecords(metadata.map((row) => row.path));
  } catch {
    return notReady();
  }
  // A note whose frontmatter cannot be decoded has unknown aliases, so resolution
  // could silently miss a link: fail closed rather than answer a wrong graph.
  if (!store.baseProjectionStatus().complete) return { status: 503, code: "catalog-incomplete" };

  const resolve = createLinkResolver(
    records.map((record) => ({ path: record.path, basename: record.basename, aliases: aliasesOf(record.frontmatter) })),
  );
  // `note_links` rows arrive target-ordered per source, so "keep the first target"
  // is deterministic. External schemes never enter the projection.
  const resolvedSources = new Map();
  for (const record of records) {
    for (const target of record.links ?? []) {
      const raw = String(target ?? "");
      const { bare } = splitFragment(raw);
      if (!bare || isExternal(bare)) continue;
      let resolution;
      try {
        resolution = resolve({ target: bare, type: "wiki" }, record.path);
      } catch {
        continue;
      }
      const status = resolution?.status;
      if (status !== "resolved" && status !== "ambiguous") continue;
      if (resolution.path !== targetPath) continue;
      if (!resolvedSources.has(record.path)) resolvedSources.set(record.path, raw);
    }
  }

  const links = [...resolvedSources]
    .map(([sourcePath, target]) => ({ sourcePath, target, alias: null, heading: headingFromTarget(target) }))
    // Raw UTF-16 code-unit order, the frozen catalog path tie-break, so repeated
    // identical requests are byte-identical.
    .sort((left, right) => (left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0));

  return {
    status: 200,
    body: {
      vaultId: vault.id,
      path: targetPath,
      revision: node.revision ?? null,
      links: links.slice(0, MAX_INCOMING_SOURCES),
      truncated: links.length > MAX_INCOMING_SOURCES,
    },
  };
}

function sendNoteContextResult(res, result) {
  if (result.status === 404) return notFound(res);
  res.setHeader("Cache-Control", "no-store");
  if (result.status === 503) return res.status(503).json({ error: result.code });
  return res.json(result.body);
}

export function registerNoteContextRoute(router, { requireApi, currentVault }) {
  const handlers = {
    outgoing: buildOutgoingLinks,
    incoming: buildIncomingLinks,
    unlinked: buildUnlinkedMentions,
  };
  for (const [name, build] of Object.entries(handlers)) {
    router.get(`/api/web/v1/note-context/${name}`, requireApi, async (req, res, next) => {
      try {
        const vault = await currentVault(req);
        sendNoteContextResult(res, await build(vault, req.query.path));
      } catch (error) {
        if (error?.message === "Vault access denied") return forbidden(res);
        next(error);
      }
    });
  }
}
