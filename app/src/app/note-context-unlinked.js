// Unlinked mentions for the note-context sidebar (U2 desktop parity).
//
// Desktop's Outgoing links pane has a second section, 「当前笔记中潜在的链接」:
// text IN the current note that matches the NAME or ALIAS of ANOTHER note in the
// Vault and is not already linked. Each entry is a context excerpt with the match
// highlighted plus one chip per candidate note for the matched name (a name shared
// by several notes yields several chips, which is exactly what desktop renders).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Obsidian Web 笔记信息侧栏.md
// GET /api/web/v1/note-context/unlinked?path=<vault-relative.md>
//   -> { vaultId, path, revision, mentions: [{ line, excerpt, highlights, chips }], truncated }
//
// Data: candidate names/aliases, the already-linked target set and the note text all
// come from the Web Catalog (the `notes_fts` row holds the same full text the index
// built). No Vault readdir and no Markdown fs.readFile happen on this path: the text
// is read through the store's public `readIndexedNoteText()` accessor (read-only, one
// indexed lookup).
//
// Read-only. No note body leaves the API; only bounded excerpts do.
import { getWebCatalogRuntime } from "./web-catalog/runtime.js";
import { NOTE_KIND } from "./web-catalog/vault-source.js";
import { resolveWebVaultPath } from "./vault-registry.js";

function notFound(res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).json({ error: "Not found" });
}

// Bounds: a pathological note must not turn one request into an unbounded payload.
const MAX_MENTIONS = 200;
const MAX_CHIPS_PER_MENTION = 200;
const EXCERPT_MAX = 160;

// The API only accepts an explicit Markdown document path (mirrors outgoing/incoming).
function requestedMarkdownPath(raw) {
  const value = String(raw ?? "").trim();
  if (!value || !/\.md$/i.test(value)) return null;
  return value;
}

function aliasesOf(frontmatter) {
  const value = frontmatter?.aliases ?? frontmatter?.alias ?? [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

// A catalog that was never reconciled is not an authoritative empty Vault.
function readyCatalogStore(vault) {
  const runtime = getWebCatalogRuntime(vault, { startReconcile: false });
  if (!runtime) return null;
  const store = runtime.store;
  if (!store.metaGet("lastReconciledAt")) return null;
  const catalogId = store.catalogId();
  if (typeof catalogId !== "string" || catalogId === "") return null;
  return store;
}

// Markdown frontmatter is metadata, not body text; desktop's mention scan reads the
// note body. A malformed header simply stays in the scan (no data loss), matching the
// indexer's tolerant parse.
function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

// Wikilinks and Markdown links are already links; a match inside one must not be
// reported as an unlinked mention. Offsets are UTF-16 code units, the same unit the
// renderer slices with.
function linkSpans(text) {
  const spans = [];
  const pattern = /\[\[[^\]]*\]\]|\[[^\][]*\]\([^()]*\)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) spans.push([match.index, match.index + match[0].length]);
  return spans;
}

function inSpans(index, spans) {
  return spans.some(([start, end]) => index >= start && index < end);
}

// Builds the case-insensitive name index (name -> candidate notes) from the Catalog
// records, excluding the current note itself so a mention never links to its own note.
function buildNameIndex(records, selfPath) {
  const byLower = new Map();
  for (const record of records) {
    if (!record || record.path === selfPath) continue;
    for (const name of [record.basename, ...aliasesOf(record.frontmatter)]) {
      const key = String(name ?? "").toLowerCase();
      if (!key) continue;
      let list = byLower.get(key);
      if (!list) byLower.set(key, (list = []));
      if (!list.some((candidate) => candidate.path === record.path)) list.push({ name: String(name), path: record.path });
    }
  }
  return byLower;
}

// One excerpt entry per line that carries at least one unlinked mention.
function clampExcerpt(text, highlights) {
  let start = 0;
  let end = text.length;
  if (end > EXCERPT_MAX) {
    const first = highlights[0]?.start ?? 0;
    start = Math.max(0, first - Math.floor(EXCERPT_MAX / 3));
    end = Math.min(text.length, start + EXCERPT_MAX);
  }
  let excerpt = text.slice(start, end);
  // Trimming leading whitespace shifts every offset; move `start` with it.
  start += excerpt.length - excerpt.trimStart().length;
  excerpt = excerpt.trim();
  const kept = highlights
    .filter((hit) => hit.start >= start && hit.end <= start + excerpt.length)
    .map((hit) => ({ start: hit.start - start, end: hit.end - start }));
  const prefix = start > 0 ? "…" : "";
  const suffix = start + excerpt.length < text.length ? "…" : "";
  const shift = prefix.length;
  return { excerpt: `${prefix}${excerpt}${suffix}`, highlights: kept.map((hit) => ({ start: hit.start + shift, end: hit.end + shift })) };
}

function buildMentionEntry({ line, text, highlights, chips }) {
  const { excerpt, highlights: clamped } = clampExcerpt(text, highlights);
  return {
    line,
    excerpt,
    highlights: clamped,
    chips: chips.slice(0, MAX_CHIPS_PER_MENTION),
  };
}

export async function buildUnlinkedMentions(vault, rawPath) {
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
    return { status: 503, code: "catalog-not-ready" };
  }
  if (!store) return { status: 503, code: "catalog-not-ready" };

  // Existence and revision come from the Catalog projection, never from the Vault.
  let node;
  try {
    node = store.locate(targetPath);
  } catch {
    return { status: 404 };
  }
  if (!node || node.kind !== NOTE_KIND) return { status: 404 };
  if (!store.baseProjectionStatus().complete) return { status: 503, code: "catalog-incomplete" };

  let metadata;
  let records;
  let raw;
  try {
    metadata = store.listDocumentMetadata({ kinds: [NOTE_KIND] });
    records = store.readDocumentRecords(metadata.map((row) => row.path));
    // Public store accessor for the indexed full text (`notes_fts.raw`): read-only,
    // one indexed lookup, never the Vault filesystem.
    raw = store.readIndexedNoteText(targetPath);
  } catch {
    return { status: 503, code: "catalog-not-ready" };
  }
  if (typeof raw !== "string") return { status: 503, code: "catalog-incomplete" };

  const body = stripFrontmatter(raw).replace(/\r\n/g, "\n");
  const byLower = buildNameIndex(records, targetPath);
  if (byLower.size === 0) {
    return { status: 200, body: { vaultId: vault.id, path: targetPath, revision: node.revision ?? null, mentions: [], truncated: false } };
  }

  const spans = linkSpans(body);
  const namesByLength = [...byLower.keys()].sort((left, right) => right.length - left.length);
  const lines = body.split(/\r?\n/);
  const mentions = [];
  let offset = 0;
  let truncated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineStart = offset;
    offset += line.length + 1; // the split newline
    if (!line) continue;

    const lower = line.toLowerCase();
    const hits = [];
    for (const nameKey of namesByLength) {
      let from = 0;
      for (;;) {
        const at = lower.indexOf(nameKey, from);
        if (at < 0) break;
        const absolute = lineStart + at;
        if (!inSpans(absolute, spans)) {
          const end = at + nameKey.length;
          const overlaps = hits.some((hit) => at < hit.end && end > hit.start);
          if (!overlaps) hits.push({ start: at, end, nameKey });
        }
        from = at + nameKey.length;
      }
    }
    if (hits.length === 0) continue;
    hits.sort((left, right) => left.start - right.start);

    const chips = [];
    for (const hit of hits) {
      for (const candidate of byLower.get(hit.nameKey) ?? []) {
        if (!chips.some((chip) => chip.path === candidate.path && chip.name === candidate.name)) chips.push({ ...candidate });
      }
    }
    mentions.push(buildMentionEntry({
      line: index + 1,
      text: line,
      highlights: hits.map((hit) => ({ start: hit.start, end: hit.end })),
      chips,
    }));
    if (mentions.length >= MAX_MENTIONS) {
      truncated = index + 1 < lines.length;
      break;
    }
  }

  return {
    status: 200,
    body: { vaultId: vault.id, path: targetPath, revision: node.revision ?? null, mentions, truncated },
  };
}
