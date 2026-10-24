// v2 Search API contract (Phase 3A-2): pure query parsing + HTTP status mapping +
// the bounded second pass. The route layer does auth/allowlist BEFORE any catalog
// access; this module never touches auth.
//
// Cost model (frozen): a search request never reads the whole Vault. Candidates come
// from the FTS/SQL stream, and only candidates are hydrated for exact verification —
// at most SECOND_PASS_BUDGET per batch and MAX_CANDIDATES_PER_REQUEST per request.
// When a page cannot be filled within that budget the response still carries a
// continuable cursor, so a budget can never become a silent miss.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）
import path from "node:path";
import { allTagsForNote } from "../../obsidian.js";
import { evaluateObsidianQuery, expandOccurrenceSnippets, expandTagSnippets } from "../../search/evaluator.js";
import { parseObsidianQuery } from "../../search/obsidian-query.js";
import { recallFromSnapshot } from "../../retrieval.js";
import { readNoteInRoot } from "./note-reader.js";
import { SemanticUnavailableError, joinSemanticCandidates } from "./semantic-candidates.js";
import { WebCatalogHttpError } from "./tree-api.js";
import {
  MAX_CANDIDATES_PER_REQUEST,
  SEARCH_PAGE_DEFAULT,
  SEARCH_PAGE_MAX,
  SECOND_PASS_BUDGET,
  WebCatalogSearchCursorError,
  encodeSearchCursor,
  searchCandidates,
} from "./search-candidates.js";
import { planSearchCandidates } from "./search-planner.js";

export { WebCatalogHttpError };

export const SEARCH_LIMIT_DEFAULT = SEARCH_PAGE_DEFAULT;
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = SEARCH_PAGE_MAX;
export const SEARCH_QUERY_MAX_LENGTH = 1000;

// `published:` is a hard filter over the Publish registry (v1 parity), never a text
// term. It is extracted before parsing so it can never degrade into a trigram/text
// clause -- that regression made the Web `Publishes` button disagree with the
// document Publish state after the Phase 3A-3 v2 cutover. First occurrence wins and
// every occurrence is stripped, matching the deprecated v1 route exactly.
const PUBLISH_FILTER_PATTERN = /(?:^|\s)published:(true|false)(?=\s|$)/i;

export function extractPublishFilter(rawQuery) {
  const source = String(rawQuery ?? "");
  const match = PUBLISH_FILTER_PATTERN.exec(source);
  if (!match) return { query: source, published: null };
  return {
    query: source.replace(/(^|\s)published:(?:true|false)(?=\s|$)/gi, " ").trim(),
    published: match[1].toLowerCase() === "true",
  };
}

// The `published:` candidate set is derived in exactly one place: the *active*
// Publish registry (§9). `PublishService.list()` defaults to `includeInactive:false`,
// so an orphaned/invalid record can never re-enter the public candidate set, and no
// caller can drift to a frontmatter `published` read or to `includeInactive:true`.
// Both the v2 search route and the deprecated v1 notes route call this helper.
export async function resolvePublishedPaths(publishService, vaultId) {
  const records = await publishService.list({ vaultIds: [vaultId] });
  return new Set(records.map((item) => item.path));
}

// Public limit contract: default 50, 1..200, decimal integers only; anything else is
// a 400 (the route never silently clamps).
export function parseSearchLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return SEARCH_LIMIT_DEFAULT;
  const value = String(raw);
  if (!/^\d+$/.test(value)) throw new WebCatalogHttpError(400, "invalid-limit", "limit must be a decimal integer");
  const limit = Number(value);
  if (limit < SEARCH_LIMIT_MIN || limit > SEARCH_LIMIT_MAX) {
    throw new WebCatalogHttpError(400, "invalid-limit", "limit out of range");
  }
  return limit;
}

// Only an explicit true/false is accepted, so a typo can never silently change the
// search semantics (v1 used a loose "anything else is false" rule).
function parseFlag(raw, name) {
  if (raw === undefined || raw === null || raw === "") return false;
  const value = String(raw).toLocaleLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new WebCatalogHttpError(400, `invalid-${name}`, `${name} must be true or false`);
}

export function parseSearchQuery(query = {}) {
  const rawQuery = query.q === undefined || query.q === null ? "" : String(query.q);
  if (rawQuery.length > SEARCH_QUERY_MAX_LENGTH) {
    throw new WebCatalogHttpError(400, "invalid-query", "query is too long");
  }
  const rawCursor = query.cursor;
  const cursor = rawCursor === undefined || rawCursor === null || rawCursor === "" ? null : String(rawCursor);
  return {
    q: rawQuery,
    limit: parseSearchLimit(query.limit),
    cursor,
    semantic: parseFlag(query.semantic, "semantic"),
    caseSensitive: parseFlag(query.caseSensitive, "caseSensitive"),
  };
}

export function mapSearchStoreError(error) {
  if (error instanceof WebCatalogHttpError) return error;
  if (error instanceof WebCatalogSearchCursorError) {
    return error.code === "WEB_CATALOG_CURSOR_STALE"
      ? new WebCatalogHttpError(409, "cursor-stale", "cursor is stale; re-run this search")
      : new WebCatalogHttpError(400, "cursor-invalid", "cursor is invalid");
  }
  return null;
}

function aliasesFor(frontmatter) {
  const value = frontmatter.aliases ?? frontmatter.alias ?? [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

// U5: one excerpt per hit, like the desktop search panel. The evaluator still owns the
// structural excerpts (line:/section:/path:/file:/property), but a whole-document text
// clause can only ever yield one excerpt there -- its `values` is the entire document. This
// Web-only layer adds one excerpt per literal occurrence of every positive textual clause,
// in document order, then merges the evaluator's excerpts, dedupes and caps the list at
// min(matchCount, MAX_SNIPPETS_PER_NOTE). Pure: it re-uses the record the second pass already
// read (no extra file read) and never touches the evaluator's own return value, so the MCP
// `search_notes` payload is byte-for-byte unchanged.
//
// U12: a `tag:` excerpt is the *real document line* that carries the tag (desktop shape),
// not the evaluator's synthetic `#tag` chip. `expandTagSnippets` supersedes (`replaced`)
// only the synthetics it could back with a real line, so an unresolvable tag keeps the
// frozen fallback instead of silently losing its excerpt.
export const MAX_SNIPPETS_PER_NOTE = 10;

export function collectItemSnippets({ record, parsed, result, caseSensitive = false, semanticCandidate = false }) {
  const cap = Math.max(0, Math.min(Number(result?.matchCount) || 0, MAX_SNIPPETS_PER_NOTE));
  if (cap === 0) return [];
  // A semantic hit is satisfied by retrieval, not by a literal occurrence: keep exactly the
  // frozen semantic snippet behaviour (structural clauses only) instead of inventing excerpts.
  const occurrences = semanticCandidate ? [] : expandOccurrenceSnippets(record, parsed, { caseSensitive });
  const tags = semanticCandidate ? { snippets: [], replaced: [] } : expandTagSnippets(record, parsed, { caseSensitive });
  const replaced = new Set(tags.replaced);
  const structural = (result?.snippets || []).filter((candidate) => !replaced.has(String(candidate ?? "")));
  const snippets = [];
  const seen = new Set();
  for (const candidate of [...occurrences, ...tags.snippets, ...structural]) {
    const text = String(candidate ?? "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    snippets.push(text);
    if (snippets.length >= cap) break;
  }
  return snippets;
}

// One candidate -> a v1-equivalent record, then the *unchanged* evaluator decides.
// A candidate that cannot be read is skipped and counted, never silently matched and
// never a request-level failure.
//
// A `published` filter is decided on the canonical candidate path before any file
// read: registry paths and catalog paths share the same `relative(root, absolute)`
// normalization (the v1 pathFilter relied on exactly this equality), so the filter
// rejects a candidate without paying for a read. Candidate *selection* already
// excludes them (search-query.js); this is the second-pass recheck that keeps the
// invariant true for any candidate source.
// The returned `read` flag is what the callers count as a real file read: a
// publish-filter rejection must never be reported as a second-pass read.
async function verifyCandidate({ vault, parsed, caseSensitive, readNote, candidate, semanticCandidate = false, publishFilter = null }) {
  if (publishFilter && publishFilter.paths.has(candidate.path) !== publishFilter.published) {
    return { skipped: true, reason: "publish-filter", read: false };
  }
  const absolute = path.join(vault.root, ...candidate.path.split("/"));
  let read;
  try {
    read = await readNote(vault.root, absolute, { tolerateMalformedFrontmatter: true });
  } catch {
    return { skipped: true, read: true };
  }
  const record = {
    path: read.path,
    name: path.posix.basename(read.path),
    basename: path.posix.basename(read.path, ".md"),
    tags: allTagsForNote(read),
    aliases: aliasesFor(read.frontmatter || {}),
    frontmatter: read.frontmatter || {},
    content: read.content,
    raw: read.raw,
  };
  // `semanticCandidate` keeps v1's hybrid semantics: positive textual clauses are
  // satisfied by the retrieval hit and only the structural conditions are re-checked.
  const result = evaluateObsidianQuery(record, parsed, { caseSensitive, semanticCandidate });
  if (!result.matched) return { skipped: false, read: true };
  return {
    skipped: false,
    read: true,
    item: {
      path: record.path,
      name: record.name,
      kind: "note",
      // Taken from the candidate so the value belongs to the same catalog
      // generation/snapshot as the page (frozen §6 item schema).
      modifiedMs: candidate.modified_ms ?? null,
      // bm25 rank (lower is more relevant); the server order is authoritative.
      score: candidate.score_q / 1_000_000,
      matchCount: result.matchCount,
      snippets: collectItemSnippets({ record, parsed, result, caseSensitive, semanticCandidate }),
    },
  };
}

function cursorFor(store, plan, candidate) {
  return encodeSearchCursor({
    catalogId: store.catalogId(),
    generation: store.generation(),
    queryHash: plan.queryHash,
    rankMode: plan.rankMode,
    scoreQ: candidate.score_q,
    pathKey: candidate.path_key,
  });
}

// The caller has already authenticated + resolved the allowed Vault.
// `recall` is injectable so the semantic path can be exercised deterministically
// without an embedding provider; production always uses the retrieval snapshot.
// `publishService` supplies the Publish registry for a `published:` filter and is
// injectable for the same reason; a missing service is an explicit 503, never a
// silently unfiltered result set.
export async function resolveSearchPage({ vault, query, getRuntime, readNote = readNoteInRoot, recall = recallFromSnapshot, publishService = null }) {
  let options;
  try {
    options = parseSearchQuery(query);
  } catch (error) {
    const mapped = mapSearchStoreError(error);
    if (mapped) throw mapped;
    throw error;
  }

  const { query: textQuery, published } = extractPublishFilter(options.q);

  let runtime;
  try {
    runtime = getRuntime(vault, { startReconcile: false });
  } catch {
    throw new WebCatalogHttpError(503, "catalog-unavailable", "Web catalog is not available");
  }
  if (!runtime) throw new WebCatalogHttpError(503, "catalog-unavailable", "Web catalog is not available");
  if (!runtime.store.metaGet("lastReconciledAt")) {
    throw new WebCatalogHttpError(503, "catalog-not-ready", "Web catalog has not finished its first reconcile");
  }

  const store = runtime.store;
  const stale = store.isStale() || !runtime.status().covered;
  let parsed;
  try {
    parsed = parseObsidianQuery(textQuery);
  } catch {
    throw new WebCatalogHttpError(400, "invalid-query", "query could not be parsed");
  }
  const plan = planSearchCandidates(parsed, { caseSensitive: options.caseSensitive, semantic: options.semantic, published });
  let publishFilter = null;
  if (published !== null) {
    if (!publishService?.list) {
      throw new WebCatalogHttpError(503, "publish-filter-unavailable", "Publish state is not available to the search service");
    }
    try {
      // The same object feeds both the SQL candidate constraint (filterParams reads
      // it as an iterable) and the second-pass recheck (`paths.has`).
      publishFilter = { published, paths: await resolvePublishedPaths(publishService, vault.id) };
    } catch (error) {
      throw new WebCatalogHttpError(503, "publish-filter-unavailable", `Publish state is unavailable: ${error?.message || error}`);
    }
  }
  if (options.semantic) {
    if (options.cursor) {
      // A successful semantic page never carries a cursor, so this cursor can only
      // belong to an already-established lexical fallback. Re-entering semantic here
      // would append a second "first page" onto the lexical one.
      const lexical = await resolveLexicalPage({ vault, options, store, parsed, plan, stale, readNote, publishFilter });
      lexical.semantic = {
        requested: true,
        used: false,
        error: "Continuing lexical fallback because semantic search was unavailable",
      };
      return lexical;
    }
    const semantic = await resolveSemanticPage({ vault, options, store, parsed, stale, readNote, recall, publishFilter });
    if (semantic.payload) return semantic.payload;
    // Explicit degradation: keep the lexical path, and report why semantic did not run.
    const lexical = await resolveLexicalPage({ vault, options, store, parsed, plan, stale, readNote, publishFilter });
    lexical.semantic = { requested: true, used: false, error: semantic.unavailable };
    return lexical;
  }

  return resolveLexicalPage({ vault, options, store, parsed, plan, stale, readNote, publishFilter });
}

async function resolveLexicalPage({ vault, options, store, parsed, plan, stale, readNote, publishFilter = null }) {
  const items = [];
  let consumed = 0;
  let reads = 0;
  let skipped = 0;
  let skippedPublish = 0;
  let examined = null;
  let exhausted = false;
  let cursorIn = options.cursor;

  try {
    while (items.length < options.limit && consumed < MAX_CANDIDATES_PER_REQUEST && !exhausted) {
      const batch = Math.min(SECOND_PASS_BUDGET, MAX_CANDIDATES_PER_REQUEST - consumed);
      // The publish constraint selects candidates, so a request never spends its
      // candidate budget paging past notes the registry already excluded.
      const page = searchCandidates(store, { plan, limit: batch, cursor: cursorIn, publish: publishFilter });
      if (page.items.length === 0) {
        exhausted = true;
        break;
      }
      // A batch may contain more candidates than the page still needs: the rest stay
      // pending, so the stream must not be reported as exhausted.
      let pending = false;
      for (const candidate of page.items) {
        if (items.length >= options.limit) {
          pending = true;
          break;
        }
        examined = candidate;
        consumed += 1;
        const verified = await verifyCandidate({ vault, parsed, caseSensitive: options.caseSensitive, readNote, candidate, publishFilter });
        if (verified.read) reads += 1;
        if (verified.skipped) {
          if (verified.reason === "publish-filter") skippedPublish += 1;
          else skipped += 1;
        } else if (verified.item) items.push(verified.item);
      }
      if (pending) break;
      if (!page.nextCursor) exhausted = true;
      else cursorIn = page.nextCursor;
    }
  } catch (error) {
    const mapped = mapSearchStoreError(error);
    if (mapped) throw mapped;
    throw error;
  }

  return {
    query: options.q,
    items,
    nextCursor: exhausted || !examined ? null : cursorFor(store, plan, examined),
    semantic: { requested: options.semantic, used: false, error: null },
    catalog: { generation: store.generation(), stale },
    search: { mode: plan.candidateMode, rank: plan.rankMode, candidates: consumed, secondPassReads: reads, skipped, skippedPublish },
  };
}

// Phase 3B-2: the semantic path. Retrieval supplies a bounded candidate window; the
// catalog join decides which of those paths still exist, and the same bounded second
// pass re-checks the structural conditions. There is no markdownFiles()/read-all path
// anywhere in this flow, and a retrieval failure degrades explicitly (lexical results
// plus a non-null semanticError), never silently.
async function resolveSemanticPage({ vault, options, store, parsed, stale, readNote, recall: recallFn, publishFilter = null }) {
  // Retrieval must receive the *query text*, never a control alias: the publish
  // filter is a constraint on the candidate set, not something to embed. This is also
  // v1 parity (`hybridSearch` recalls `parsed.semanticText`).
  const semanticText = String(parsed?.semanticText || "").trim();
  if (!semanticText) {
    // Same wording as the v1/hybrid path: a query without a positive text term cannot
    // drive retrieval, and a filter-only search must not become a semantic top-K page.
    return { unavailable: "Semantic search requires a positive text term" };
  }
  let joined;
  try {
    const recall = await recallFn(semanticText, {
      semantic: true,
      limit: Math.max(options.limit * 4, 50),
      chunksPerNote: 2,
      snippetLength: 400,
    });
    // The publish constraint is applied inside the join, so the retrieval window can
    // never decide which Publish documents exist.
    joined = joinSemanticCandidates({ store, recall, limit: SECOND_PASS_BUDGET, publishFilter });
  } catch (error) {
    // The retrieval producer throws a plain Error when it has no snapshot.
    const message = error instanceof SemanticUnavailableError
      ? error.message
      : `Semantic retrieval unavailable: ${error?.message || error}`;
    return { unavailable: message };
  }
  if (!joined.semanticUsed) {
    // Reachable without an error string: a snapshot can exist while embeddings are
    // disabled or absent. The window is lexical/metadata relevance, so it must not be
    // presented as a semantic page.
    return {
      unavailable: joined.semanticError || "Semantic embeddings are unavailable in the current retrieval snapshot",
    };
  }
  if (joined.generationMismatch) {
    // A catalog mutation landed while the candidate window was being joined: never
    // mix that snapshot with the newer catalog.
    return { unavailable: "Catalog changed during semantic retrieval" };
  }

  const items = [];
  let reads = 0;
  let skipped = 0;
  let skippedPublish = 0;
  for (const candidate of joined.items) {
    if (items.length >= options.limit) break;
    const verified = await verifyCandidate({ vault, parsed, caseSensitive: options.caseSensitive, readNote, candidate, semanticCandidate: true, publishFilter });
    if (verified.read) reads += 1;
    if (verified.skipped) {
      if (verified.reason === "publish-filter") skippedPublish += 1;
      else skipped += 1;
    } else if (verified.item) items.push({ ...verified.item, score: candidate.semanticScore });
  }
  return {
    payload: {
      query: options.q,
      items,
      // The semantic stream is the bounded retrieval window, so it is a single page.
      nextCursor: null,
      semantic: { requested: true, used: joined.semanticUsed, error: joined.semanticError },
      catalog: { generation: store.generation(), stale },
      search: {
        mode: "semantic",
        rank: "semantic",
        candidates: joined.candidates,
        examined: joined.examined,
        window: joined.window,
        secondPassReads: reads,
        skipped,
        // The join counts the publish skips inside the retrieval window; the second
        // pass can only add zero (it rechecks the same constraint).
        skippedPublish: skippedPublish + joined.skippedPublish,
        skippedPath: joined.skippedPath,
        skippedMissing: joined.skippedMissing,
        duplicates: joined.duplicates,
      },
    },
  };
}
