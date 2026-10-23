// Incremental Web Catalog indexer — maps a read note/base to a catalog record and
// keeps ancestor directories present. Pure: no HTTP, no routes, no watcher.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// Wave A / A2 adds the Base record source: a typed frontmatter projection and the
// canonical outbound-link target projection (same extractLinks as vault-index).
import path from "node:path";
import { allTagsForNote, extractLinks } from "../../obsidian.js";
import { FRONTMATTER_CODEC_VERSION, encodeFrontmatter } from "./value-codec.js";

function parseTime(value) {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Canonical link projection: reuse the MCP vault-index extraction, then keep the
// raw `target` file.hasLink compares against. External schemes are not Vault links
// and duplicate targets never change hasLink, so both are dropped.
export function extractLinkTargets(content, sourcePath) {
  const targets = new Set();
  for (const link of extractLinks(String(content ?? ""), String(sourcePath ?? ""))) {
    const target = String(link?.target ?? "").trim();
    if (!target) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.add(target);
  }
  return [...targets];
}

export function frontmatterStateFromRead(read) {
  const frontmatter = read?.frontmatter ?? {};
  try {
    return { state: { codecVersion: FRONTMATTER_CODEC_VERSION, encodedValue: encodeFrontmatter(frontmatter) }, fault: null };
  } catch (error) {
    // Fail closed: the note stays visible, but the catalog is flagged incomplete so
    // a Base route can 503 instead of silently dropping a property.
    return { state: null, fault: error?.message || String(error) };
  }
}

export function catalogRecordFromRead(read) {
  const rel = String(read?.path || "").replace(/\\/g, "/");
  const stat = read?.stat || {};
  const frontmatter = read?.frontmatter || {};
  const aliasesValue = frontmatter.aliases ?? frontmatter.alias ?? [];
  const aliases = (Array.isArray(aliasesValue) ? aliasesValue : [aliasesValue]).map(String).filter(Boolean);
  const { state: frontmatterState, fault: frontmatterFault } = frontmatterStateFromRead(read);

  // Scalar frontmatter only: arrays/objects are searchable through FTS/tags, not
  // as flat property rows. The full value tree lives in note_frontmatter_state.
  const properties = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    properties[key] = value;
  }

  return {
    path: rel,
    name: path.posix.basename(rel),
    size: typeof stat.size === "number" ? stat.size : null,
    modifiedMs: parseTime(stat.modified),
    createdMs: parseTime(stat.created),
    revision: read?.revision ?? null,
    tags: allTagsForNote(read),
    aliases,
    properties,
    frontmatterState,
    frontmatterFault,
    links: extractLinkTargets(read?.content, rel),
    content: read?.content ?? "",
    // Full file text (body + frontmatter). The FTS projection stores this so a
    // `text:` clause (which matches v1's `record.raw`) stays a true candidate
    // superset under the trigram substring index.
    raw: read?.raw ?? read?.content ?? "",
  };
}

// A Base file is a typed node only: size/modified/created + byte revision. It is
// never parsed, never tagged, and never enters the note projections or FTS.
export function baseRecordFromRead(read) {
  const rel = String(read?.path || "").replace(/\\/g, "/");
  const stat = read?.stat || {};
  return {
    path: rel,
    name: path.posix.basename(rel),
    size: typeof stat.size === "number" ? stat.size : null,
    modifiedMs: parseTime(stat.modified),
    createdMs: parseTime(stat.created),
    revision: read?.revision ?? null,
  };
}

// An attachment (non-Markdown, non-Base regular file) is a typed node only:
// path/name/size/mtime. Its bytes are never opened, hashed, parsed or projected
// into FTS / tags / properties / links; `metadataRevision` is the reconcile's cheap
// reuse signature (size:mtime:ctime:ino).
export function fileRecordFromEntry(entry) {
  const rel = String(entry?.path || "").replace(/\\/g, "/");
  return {
    path: rel,
    name: path.posix.basename(rel),
    size: typeof entry?.size === "number" ? entry.size : null,
    modifiedMs: entry?.modifiedMs ?? null,
    createdMs: entry?.createdMs ?? null,
    metadataRevision: entry?.metadataRevision ?? null,
  };
}

export function ensureCatalogDirectories(store, relPath) {
  const parts = String(relPath || "").replace(/\\/g, "/").split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    store.upsertDirectory({ path: current, name: part });
  }
}

// Materialize one directory node (and its ancestor chain) as an explicit catalog
// node. Unlike ensureCatalogDirectories this INCLUDES the last segment, so a Web
// folder create can make an empty folder visible in the tree immediately
// (read-your-writes), without waiting for the next reconcile.
export function ensureCatalogDirectory(store, relPath) {
  const parts = String(relPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    store.upsertDirectory({ path: current, name: part });
  }
  return current || null;
}

// One logical note write as one published catalog mutation. When the content
// revision is unchanged (e.g. the watcher echoing a Web write we already indexed),
// this is a no-op so a self-echo never advances the generation a second time.
export function upsertCatalogRead(store, read, { dedupe = true } = {}) {
  const record = catalogRecordFromRead(read);
  if (dedupe && record.revision) {
    const existing = store.locate(record.path);
    // No-op only when the content *and* every catalog-visible metadata field match.
    // A content-identical touch still moves modified_ms, and the Explorer order is
    // part of the catalog, so it must re-publish.
    const sameContent = existing && existing.revision === record.revision;
    if (sameContent && existing.modified_ms === record.modifiedMs) {
      return { ...record, skipped: true };
    }
  }
  store.batch(() => {
    ensureCatalogDirectories(store, record.path);
    store.upsertNote(record);
  });
  return { ...record, skipped: false };
}

// One logical Base write as one published catalog mutation (nodes row only).
export function upsertCatalogBase(store, read, { dedupe = true } = {}) {
  const record = baseRecordFromRead(read);
  if (dedupe && record.revision) {
    const existing = store.locate(record.path);
    if (existing && existing.revision === record.revision && existing.modified_ms === record.modifiedMs) {
      return { ...record, skipped: true };
    }
  }
  store.batch(() => {
    ensureCatalogDirectories(store, record.path);
    store.upsertBase(record);
  });
  return { ...record, skipped: false };
}

// One logical attachment write as one published catalog mutation (nodes row only).
// There is no content revision: two writes are the same entry only when the catalog
// already holds that path with the same mtime.
export function upsertCatalogFile(store, entry, { dedupe = true } = {}) {
  const record = fileRecordFromEntry(entry);
  if (dedupe) {
    const existing = store.locate(record.path);
    if (existing && existing.kind === "file" && existing.modified_ms === record.modifiedMs) {
      return { ...record, skipped: true };
    }
  }
  store.batch(() => {
    ensureCatalogDirectories(store, record.path);
    store.upsertFile(record);
  });
  return { ...record, skipped: false };
}

// Cheap, comparable file identity for reconcile reuse. mtime alone misses a
// same-size/same-mtime rewrite (offline edit, restore, sync), while ctime and the
// inode still move.
function fileSignature(info) {
  const ctime = Number.isFinite(info?.ctimeMs) ? info.ctimeMs : 0;
  const ino = info?.ino ?? 0;
  return `${info?.size ?? 0}:${info?.mtimeMs ?? 0}:${ctime}:${ino}`;
}

// Adapts the project's Vault primitives into the reconcile `source` contract.
// `listDocuments` is the typed inventory; a legacy `listMarkdown` is still accepted
// so existing callers keep working (treated as note-only).
export function createVaultCatalogSource({
  vaultRoot,
  listMarkdown,
  listDocuments,
  // Optional explicit-directory inventory. Omitted by legacy callers, in which
  // case the reconcile keeps deriving directories from file ancestors only.
  listDirectories,
  stat,
  readNote,
  readBase,
  toVaultPath,
  maxEntries = Number.MAX_SAFE_INTEGER,
}) {
  const absoluteFor = (relPath) => path.join(vaultRoot, ...String(relPath).split("/"));
  const source = {
    async list() {
      const documents = listDocuments
        ? await listDocuments({ maxEntries })
        : (await listMarkdown({ maxEntries })).map((absolute) => ({ absolute, kind: "note" }));
      const entries = [];
      for (const document of documents) {
        const info = await stat(document.absolute);
        entries.push({
          path: toVaultPath(document.absolute),
          kind: document.kind,
          size: info.size,
          modifiedMs: info.mtimeMs,
          signature: fileSignature(info),
        });
      }
      return entries;
    },
    // `readNote` already resolves an absolute path; callers pass a vault-relative
    // logical path so the catalog never sees a raw filesystem path.
    read(relPath) {
      return readNote(absoluteFor(relPath), { tolerateMalformedFrontmatter: true });
    },
    readBase(relPath) {
      return readBase(absoluteFor(relPath));
    },
    // Attachment metadata only: stat, never open/read the bytes.
    async statFile(relPath) {
      const info = await stat(absoluteFor(relPath));
      return { path: String(relPath), size: info.size, modifiedMs: info.mtimeMs ?? null };
    },
  };
  // Declared only when the caller supplies an inventory: the reconcile treats the
  // presence of this hook as "index explicit directories too".
  if (listDirectories) {
    source.listDirectories = async () => (await listDirectories({ maxEntries })).map((entry) => ({
      path: toVaultPath(entry.absolute),
      kind: entry.kind ?? "directory",
    }));
  }
  return source;
}
