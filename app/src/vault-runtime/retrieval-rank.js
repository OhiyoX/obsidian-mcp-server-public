// B3 — pure retrieval ranking and chunking primitives.
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置"
//   §12  Retrieval runtime (per-Vault state; the embedding provider may stay process-shared)
//   §27  Wave B / B3   ·  §40 Retrieval / semantic tests
//   §43-7 retrieval/index runtime state must not live in a module global
//   §43-5 a new Vault-dependent module must not import the global path constants
//
// DELIBERATELY PURE: no module-level mutable state, no `config.js` import, no
// `process.env` read, no filesystem access, no Vault root and no knowledge of
// "the" Vault. Every tunable (chunk size/overlap) and every process-shared
// collaborator (the embedding provider) is an explicit parameter, so this code
// can serve many Vaults while sharing nothing Vault-identifying.
//
// The mutable per-Vault state (index cache, operation queue, build job, refresh
// timer) lives in the `createRetrievalRuntime` closure in `./retrieval-runtime.js`
// (W0-A doc §4.3: "state/loading/operationQueue/activeIndexJob/refreshTimer/
// lastRefreshAt/pendingIndexOptions all move into the per-vault runtime").

import { createHash } from "node:crypto";

/** sha256 hex of a chunk identity string. Behaviorally identical to BASE `retrieval.js`. */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * CJK-bigram + Latin-word tokenizer. Frozen by `test/search-v2-baseline.test.js`
 * and consumed by the recovery/related-notes ranking helpers; unchanged from BASE.
 */
export function tokenize(value) {
  const normalized = String(value || "").toLocaleLowerCase().normalize("NFKC");
  const output = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    output.push(token);
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token];
      output.push(...chars);
      for (let index = 0; index < chars.length - 1; index += 1) output.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return output;
}

function splitLongText(text, maxLength, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLength);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("。", end), text.lastIndexOf(". ", end));
      if (boundary > start + maxLength / 2) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

/**
 * Heading-aware Markdown chunker. `chunkSize`/`overlap` are required explicit
 * numbers (fail closed) — the per-Vault runtime supplies its injected
 * `retrievalConfig` values, so nothing here reads process config.
 *
 * @param {{ path: string, basename: string, content: string, frontmatter?: object }} record
 * @param {{ chunkSize: number, overlap: number }} options
 */
export function chunkMarkdown(record, options = {}) {
  const { chunkSize, overlap } = options;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error("retrieval-rank: chunkMarkdown requires a positive integer chunkSize");
  if (!Number.isInteger(overlap) || overlap < 0) throw new Error("retrieval-rank: chunkMarkdown requires a non-negative integer overlap");
  const sections = [];
  let heading = record.frontmatter.title || record.basename;
  let buffer = [];
  for (const line of record.content.split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match && buffer.some((item) => item.trim())) {
      sections.push({ heading, text: buffer.join("\n").trim() });
      buffer = [];
    }
    if (match) heading = match[2].trim();
    buffer.push(line);
  }
  if (buffer.some((item) => item.trim())) sections.push({ heading, text: buffer.join("\n").trim() });
  const chunks = [];
  let ordinal = 0;
  for (const section of sections) {
    for (const text of splitLongText(section.text, chunkSize, overlap)) {
      const contentHash = hash(`${section.heading}\n${text}`);
      chunks.push({ id: `${record.path}#${ordinal}`, ordinal, heading: section.heading, text, hash: contentHash });
      ordinal += 1;
    }
  }
  return chunks;
}

/** Search metadata projection for one Vault-index record. Unchanged from BASE. */
export function metadataFor(record) {
  const fm = record.frontmatter || {};
  const list = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(String).filter(Boolean);
  return {
    title: String(fm.title || record.basename),
    description: String(fm.description || ""),
    type: String(fm.type || ""),
    status: String(fm.status || ""),
    memoryKind: String(fm.memory_kind || ""),
    tags: record.tags,
    aliases: record.aliases,
    entities: list(fm.entities),
    projects: list(fm.projects || fm.project),
    created: fm.created || record.stat.created,
    updated: fm.updated || record.stat.modified,
  };
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : null;
}

function bm25Scores(chunks, queryTokens) {
  const documents = chunks.map((chunk) => tokenize(`${chunk.note.metadata.title} ${chunk.heading} ${chunk.text}`));
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, documents.length);
  const scores = new Array(chunks.length).fill(0);
  for (const token of [...new Set(queryTokens)]) {
    const documentFrequency = documents.filter((tokens) => tokens.includes(token)).length;
    if (!documentFrequency) continue;
    const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
    documents.forEach((tokens, index) => {
      const frequency = tokens.filter((item) => item === token).length;
      if (!frequency) return;
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * tokens.length / Math.max(1, averageLength));
      scores[index] += idf * (frequency * 2.2) / denominator;
    });
  }
  return scores;
}

function matchesFilters(note, options) {
  const normalize = (value) => String(value).toLocaleLowerCase();
  if (options.pathPrefix && note.path !== options.pathPrefix && !note.path.startsWith(`${options.pathPrefix.replace(/\/$/, "")}/`)) return false;
  if (options.types?.length && !options.types.map(normalize).includes(normalize(note.metadata.type))) return false;
  if (options.status?.length && !options.status.map(normalize).includes(normalize(note.metadata.status))) return false;
  if (options.kinds?.length && !options.kinds.map(normalize).includes(normalize(note.metadata.memoryKind))) return false;
  if (options.tags?.length && !options.tags.every((tag) => note.metadata.tags.map(normalize).includes(normalize(tag).replace(/^#/, "")))) return false;
  if (options.entities?.length && !options.entities.some((entity) => note.metadata.entities.map(normalize).includes(normalize(entity)))) return false;
  return true;
}

/**
 * Hybrid BM25 + metadata + (optional) embedding ranking over one runtime's
 * committed index state. `collaborators` carries the Vault's injected
 * collaborators: `{ semanticConfiguration, embedTexts }`. Pure with respect to
 * module state; the only side effect is the injected embedding call.
 */
export async function rankRecall(current, query, options = {}, collaborators = {}) {
  const notes = Object.values(current.notes).filter((note) => matchesFilters(note, options));
  const chunks = notes.flatMap((note) => note.chunks.map((chunk) => ({ ...chunk, note })));
  const queryTokens = tokenize(query);
  const lexicalScores = bm25Scores(chunks, queryTokens);
  const maxLexical = Math.max(0, ...lexicalScores);
  let queryEmbedding = null;
  let semanticError = null;
  if (options.semantic !== false && collaborators.semanticConfiguration().enabled && chunks.some((chunk) => chunk.embedding)) {
    try { [queryEmbedding] = await collaborators.embedTexts(query, { priority: "interactive", race: true }); }
    catch (error) { semanticError = error.message; }
  }
  const scored = chunks.map((chunk, index) => {
    const lexical = maxLexical ? lexicalScores[index] / maxLexical : 0;
    const cosineValue = queryEmbedding ? cosine(queryEmbedding, chunk.embedding) : null;
    const semantic = cosineValue === null ? 0 : Math.max(0, (cosineValue + 1) / 2);
    const metadataText = tokenize([chunk.note.metadata.title, chunk.note.metadata.description, ...chunk.note.metadata.tags, ...chunk.note.metadata.entities].join(" "));
    const metadataMatches = queryTokens.filter((token) => metadataText.includes(token)).length;
    const metadata = queryTokens.length ? Math.min(1, metadataMatches / queryTokens.length) : 0;
    const semanticWeight = queryEmbedding && cosineValue !== null ? 0.3 : 0;
    const lexicalWeight = semanticWeight ? 0.55 : 0.85;
    const score = lexical * lexicalWeight + semantic * semanticWeight + metadata * 0.15;
    const reasons = [];
    if (lexical > 0) reasons.push(`lexical:${lexical.toFixed(3)}`);
    if (semanticWeight) reasons.push(`semantic:${semantic.toFixed(3)}`);
    if (metadata > 0) reasons.push(`metadata:${metadata.toFixed(3)}`);
    return { chunk, score, lexical, semantic: semanticWeight ? semantic : null, metadata, reasons };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const grouped = new Map();
  for (const item of scored) {
    const existing = grouped.get(item.chunk.note.path) || { path: item.chunk.note.path, metadata: item.chunk.note.metadata, score: item.score, reasons: item.reasons, chunks: [] };
    existing.score = Math.max(existing.score, item.score);
    if (existing.chunks.length < (options.chunksPerNote || 2)) existing.chunks.push({ id: item.chunk.id, heading: item.chunk.heading, text: item.chunk.text.slice(0, options.snippetLength || 700), score: item.score, reasons: item.reasons });
    grouped.set(item.chunk.note.path, existing);
  }
  const results = [...grouped.values()].sort((a, b) => b.score - a.score).slice(0, options.limit || 10);
  return { query, results, totalCandidates: notes.length, semanticUsed: Boolean(queryEmbedding), semanticError };
}
