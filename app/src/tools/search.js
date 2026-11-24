import fs from "node:fs/promises";
import { z } from "zod/v4";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "../config.js";
import { readNote } from "../obsidian.js";
import { projectSearchResult } from "../output-projection.js";
import { err, ok } from "../result.js";
import { semanticModeFor } from "../search/hybrid-search.js";
import { buildZeroResultDiagnostics } from "../search/query-diagnostics.js";
import { refusalForError, resolveSearchRuntime } from "../search-runtimes.js";
import { normalizeVaultInput } from "../vault.js";

export function resolveListNotesPath(pathPrefix) {
  return pathPrefix === undefined ? "" : normalizeVaultInput(pathPrefix);
}

export function registerSearchTools(server) {
  server.registerTool(
    "list_notes",
    {
      title: "List Obsidian Notes",
      inputSchema: {
        pathPrefix: z.string().optional().describe("Vault-relative directory to list. Use an empty string for the vault root."),
        recursive: z.boolean().default(false),
        depth: z.number().int().min(0).max(20).default(2),
        includeDirectories: z.boolean().default(true),
        includeHidden: z.boolean().default(false),
        nameRegex: z.string().optional(),
        cursor: z.string().optional().describe("Path cursor returned by a previous call."),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, recursive, depth, includeDirectories, includeHidden, nameRegex, cursor, limit }) => {
      try {
        const selectedPath = resolveListNotesPath(pathPrefix);
        // Wave D / D-search: the directory face reads the *selected* Vault's filesystem service,
        // so `list_notes` and `search_notes` cannot disagree about which Vault they describe.
        const { vaultRuntime } = resolveSearchRuntime();
        const localFs = vaultRuntime.localFs;
        const dir = localFs.resolveVaultPath(selectedPath);
        const entries = await localFs.walk(dir, { recursive, depth, includeDirectories, includeHidden, extension: ".md", nameRegex, afterPath: cursor, maxEntries: limit + 1 });
        const truncated = entries.length > limit;
        const page = entries.slice(0, limit);
        return ok({ directory: localFs.toVaultPath(dir), entries: page, truncated, nextCursor: truncated ? page.at(-1)?.path : undefined });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_recent",
    {
      title: "List Recent Obsidian Notes",
      inputSchema: { limit: z.number().int().min(1).max(100).default(10), pathPrefix: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, pathPrefix }) => {
      try {
        const index = await resolveSearchRuntime().index.getVaultIndex({ pathPrefix });
        const notes = index.records.map((record) => ({ path: record.path, size: record.stat.size, modified: record.stat.modified, created: record.stat.created, revision: record.revision }));
        notes.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok({ notes: notes.slice(0, limit), totalCount: notes.length, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Obsidian Notes",
      inputSchema: {
        query: z.string().max(1000).optional(),
        useRegex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        wholeWord: z.boolean().default(false),
        flexibleWhitespace: z.boolean().default(false),
        semantic: z.boolean().optional().describe("Semantic tri-state: omitted = auto exact-first (fall back to hybrid retrieval only when the exact pass matches zero records and the query has positive text); false = strict exact/lexical only; true = always run hybrid retrieval for positive text (incompatible with regex mode)."),
        tags: z.array(z.string()).optional(),
        matchAllTags: z.boolean().default(false),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        pathPrefix: z.string().optional(),
        pathRegex: z.string().max(500).optional(),
        fileRegex: z.string().max(500).optional(),
        modifiedAfter: z.string().optional(),
        modifiedBefore: z.string().optional(),
        createdAfter: z.string().optional(),
        createdBefore: z.string().optional(),
        includeFrontmatter: z.boolean().default(true),
        contextLength: z.number().int().min(0).max(1000).default(120),
        maxMatchesPerNote: z.number().int().min(1).max(50).default(10),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
        sortBy: z.enum(["relevance", "path", "modified", "created"]).default("relevance"),
        sortDirection: z.enum(["asc", "desc"]).default("desc"),
        includeProvenance: z.boolean().default(false).describe("Attach per-hit source provenance and index freshness (about 225 bytes per hit). Off by default: it is evidence you ask for, not a tax on every search."),
        view: z.enum(["full", "standard", "brief"]).default("full").describe("Result detail: full (default, unchanged) keeps every field; standard drops excerpt text; brief keeps only path, revision, the totals/truncation state and the semantic status."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        if (!input.query && !input.tags?.length && !input.frontmatter && !input.pathRegex && !input.fileRegex && !input.pathPrefix) throw new Error("Provide at least one search or path filter");
        if (input.semantic === true && input.useRegex) throw new Error("Semantic search cannot be combined with regex mode");
        const runtime = resolveSearchRuntime();
        const search = await runtime.searchService.search(input.query, { ...input, rank: "bm25f" });
        const { index, candidates, parsed } = search;
        const results = search.results;
        const direction = input.sortDirection === "asc" ? 1 : -1;
        if (input.sortBy === "path") results.sort((a, b) => direction * a.path.localeCompare(b.path));
        else if (input.sortBy === "modified") results.sort((a, b) => direction * a.stat.modified.localeCompare(b.stat.modified));
        else if (input.sortBy === "created") results.sort((a, b) => direction * a.stat.created.localeCompare(b.stat.created));
        else results.sort((a, b) => (b.score || 0) - (a.score || 0) || b.matchCount - a.matchCount || b.stat.modified.localeCompare(a.stat.modified));
        const limited = results.slice(0, input.limit);
        // Contract §7: explain the exact pass only for the non-regex zero-exact
        // path, over the already-filtered candidate set (never a Vault rewalk).
        const diagnostics = !input.useRegex && search.exactMatched === 0
          ? buildZeroResultDiagnostics(candidates, parsed, input)
          : undefined;
        const payload = {
          results: limited,
          totalScanned: index.records.length,
          totalMatched: results.length,
          truncated: results.length > input.limit,
          semanticRequested: input.semantic === true,
          semanticUsed: search.semanticUsed,
          semanticError: search.semanticError,
          hybridUsed: search.hybridUsed,
          index: index.stats,
          semanticMode: semanticModeFor(input),
          fallbackUsed: search.fallbackUsed,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        };
        return ok(projectSearchResult("search_notes", payload, input.view));
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_tags",
    {
      title: "List Obsidian Tags",
      inputSchema: { nameRegex: z.string().optional(), includeNotes: z.boolean().default(false), pathPrefix: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ nameRegex, includeNotes, pathPrefix }) => {
      try {
        const counts = new Map();
        const notes = [];
        const index = await resolveSearchRuntime().index.getVaultIndex({ pathPrefix });
        for (const note of index.records) {
          const tags = note.tags;
          notes.push({ path: note.path, tags });
          for (const tag of tags) {
            const parts = tag.split("/");
            for (let i = 1; i <= parts.length; i += 1) {
              const current = parts.slice(0, i).join("/");
              counts.set(current, (counts.get(current) || 0) + 1);
            }
          }
        }
        const matcher = nameRegex ? new RegExp(nameRegex, "i") : null;
        const tags = [...counts.entries()].map(([tag, count]) => ({ tag, count })).filter((item) => !matcher || matcher.test(item.tag)).sort((a, b) => a.tag.localeCompare(b.tag));
        return ok({ tags, notes: includeNotes ? notes : undefined, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );
}
