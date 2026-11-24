import path from "node:path";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { MEMORY_PATH, SKILLS_PATH } from "../config.js";
import { projectSearchResult } from "../output-projection.js";
import { err, ok } from "../result.js";
import { writeNoteFile } from "../obsidian.js";
import { buildSourceProvenance } from "../search/source-provenance.js";
import { relatedToPath } from "../related-notes.js";
import { semanticHealth } from "../retrieval.js";
import { refusalForError, resolveSearchRuntime } from "../search-runtimes.js";
// Wave D / D-intelligence — the context / memory / skills face. Every tool below needs the
// *selected* Vault's materialized runtime (contract §29 "intelligence/context/memory/skills" lane):
// the managed memory root and Skills root are Vault-relative, index invalidation + retrieval sync
// move that Vault's own state, and matching recall ranks that Vault's own chunks. A selection this
// process has no runtime for is refused structurally by `resolveSearchRuntime()` with
// `vault_retrieval_unavailable` (never served by the primary Vault, §47); `refusalForError` turns
// that into the MCP error payload. `MEMORY_PATH` / `SKILLS_PATH` are the same Vault-relative layout
// paths in every Vault, so they stay process constants (§43-5) instead of per-Vault roots.
import { exists, resolveVaultPath, toVaultPath } from "../vault-runtime/request-vault.js";
import { exportSkillPackage, importSkillPackage, listSkillPackages, validateSkillPackage } from "../skills.js";

// O3 — the same bounded-view option as `search_notes`: full (default) is the
// unchanged payload, standard drops excerpt text, brief keeps the locator only.
const VIEW_FIELD = { view: z.enum(["full", "standard", "brief"]).default("full").describe("Result detail: full (default, unchanged) keeps every field; standard drops excerpt text; brief keeps only path, revision, the totals/truncation state and the semantic status.") };

function safeMemoryContent(value) {
  const text = String(value || "");
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:api[_ -]?key|token|password|passwd|secret)\s*[:=]\s*\S{8,}/i,
    /\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{20,}\b/,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) throw new Error("Memory content appears to contain a credential or private key; store secrets outside the vault");
  return text;
}

function safeFilename(title) {
  const cleaned = String(title).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!cleaned) throw new Error("Memory title does not produce a valid filename");
  return cleaned;
}

// issue #415 — `memory_capture` is create-only for a *file* and must never invent a directory
// level. `writeNoteFile` → `atomicWriteFile` → `ensureVaultParent` runs
// `fs.mkdir(path.dirname(abs), { recursive: true })`, so a target whose parent does not exist
// (e.g. a title carrying `/` spliced into a caller-composed `path`) silently materializes a
// directory named after that segment — the real incident produced `.../Facts/2026-10-05 …ZCode/`
// plus an inner note. Reject before any Vault write so a refusal leaves the disk byte-identical.
// The one directory this tool may still materialize implicitly is the managed root itself:
// a fresh Vault has no `20-Memory/` yet, and omitting `path` is the documented remedy. Every
// parent *below* the managed root must already exist.
async function assertExistingMemoryParent(relativePath) {
  const managedRoot = MEMORY_PATH.replace(/\/+$/, "");
  const parent = path.posix.dirname(String(relativePath).replaceAll("\\", "/"));
  if (parent === managedRoot || !parent.startsWith(`${managedRoot}/`)) return; // managed root: allowed (see above)
  const info = await stat(resolveVaultPath(parent, { assumeMarkdown: false })).catch(() => null);
  if (info?.isDirectory()) return;
  throw new Error(`Target folder does not exist: "${parent}". memory_capture does not create directories: omit "path" to write to ${MEMORY_PATH}, or use an existing subdirectory (${managedRoot}/Facts/, ${managedRoot}/Decisions/, ${managedRoot}/Episodes/).`);
}

// Issue #666 — the same provenance DTO as `search_notes`, on the recall face. The retrieval
// snapshot exposes no per-note revision and no index generation to this adapter, so a recall or
// related hit reports `unknown` with a reason (`index_evidence_unavailable`) instead of claiming
// its snippet is still the file's text. Nothing is read fresh here: an unverified claim would be
// the one thing worse than an honest `unknown`.
function withProvenance(payload, vaultId, includeProvenance) {
  if (includeProvenance !== true || !Array.isArray(payload?.results)) return payload;
  return {
    ...payload,
    results: payload.results.map((hit) => ({ ...hit, provenance: buildSourceProvenance({ vaultId, path: hit.path }) })),
  };
}

// C4 (#668) — `graph_health` may PROPOSE a link repair; it never performs one. A proposal is
// evidence for the reviewed `plan_note_changes` -> `apply_note_plan` path, so this builder is pure:
// it reads the index snapshot the audit already built, writes nothing, and offers only what the
// evidence can prove. Three shapes, in order of what is knowable:
//   * an AMBIGUOUS target (two notes could be it) is reported as the ambiguity itself — candidates
//     and the lookup that matched them — never as a chosen target. Alias and duplicate-basename
//     conflicts are guesses by definition, and semantic similarity is not evidence at all;
//   * an unresolved target whose whitespace/case-collapsed name matches exactly ONE note proposes
//     that note plus the one-line diff: deterministic, no judgement;
//   * anything else (no candidate, or several collapsed ones) stays a `graph_health` issue.
// `expectedRevision` is the source record's real `sha256:` revision — the same value
// `plan_note_changes` demands as `baseRevision` — so a proposal that went stale is refused by the
// plan CAS instead of being applied silently.
function collapsedName(value) {
  return path.posix.basename(String(value || "").replaceAll("\\", "/")).replace(/\.md$/i, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function graphProposals(index, limit) {
  const byCollapsedName = new Map();
  for (const record of index.records) {
    const key = collapsedName(record.basename);
    byCollapsedName.set(key, [...(byCollapsedName.get(key) || []), record.path]);
  }
  const aliasesByPath = new Map(index.records.map((record) => [record.path, record.aliases.map((alias) => alias.trim().toLowerCase())]));
  const proposals = [];
  for (const record of index.records) {
    for (const link of record.links) {
      const resolution = index.resolveLink(link, record.path);
      if (!["ambiguous", "unresolved"].includes(resolution.status)) continue;
      const evidence = { raw: link.raw, link: link.target };
      if (resolution.status === "ambiguous") {
        const heldByAlias = resolution.candidates.some((candidate) => (aliasesByPath.get(candidate) || []).includes(String(link.target).trim().toLowerCase()));
        proposals.push({ sourcePath: record.path, evidence: { ...evidence, match: heldByAlias ? "alias" : "basename", candidates: resolution.candidates }, reason: "ambiguous_link_target", expectedRevision: record.revision, risk: "high" });
      } else {
        const candidates = byCollapsedName.get(collapsedName(link.target)) || [];
        if (candidates.length === 1) {
          const [targetPath] = candidates;
          const qualified = String(link.target).includes("/");
          // Keep the author's own "with `.md`" convention: the proposal only fixes the spelling.
          const target = qualified ? targetPath : path.posix.basename(targetPath);
          const spelling = /\.md$/i.test(String(link.target)) ? target : target.replace(/\.md$/i, "");
          proposals.push({ sourcePath: record.path, targetPath, evidence: { ...evidence, match: "collapsed-name", candidates }, reason: "link_target_spelling", expectedRevision: record.revision, risk: "low", proposedDiff: `-${link.raw}\n+${link.raw.replace(link.target, spelling)}` });
        } else if (candidates.length > 1) {
          proposals.push({ sourcePath: record.path, evidence: { ...evidence, match: "collapsed-name", candidates }, reason: "ambiguous_link_target", expectedRevision: record.revision, risk: "high" });
        }
      }
      if (proposals.length >= limit) return proposals;
    }
  }
  return proposals;
}

export function registerIntelligenceTools(server) {
  server.registerTool("index_status", {
    title: "Get Retrieval Index Status",
    inputSchema: { checkRemote: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ checkRemote }) => { try { const runtime = resolveSearchRuntime(); return ok({ ...(await runtime.retrieval.retrievalIndexStatus()), remote: checkRemote ? await semanticHealth() : undefined }); } catch (error) { return refusalForError(error) ?? err(error); } });

  server.registerTool("reindex_vault", {
    title: "Reindex Obsidian Vault",
    inputSchema: { force: z.boolean().default(false), embeddings: z.boolean().default(true) }, annotations: { destructiveHint: false, openWorldHint: true },
  }, async (options) => { try { return ok(resolveSearchRuntime().retrieval.startRetrievalIndex(options)); } catch (error) { return refusalForError(error) ?? err(error); } });

  server.registerTool("recall", {
    title: "Recall Obsidian Knowledge",
    inputSchema: {
      query: z.string().min(1).max(4000), includeProvenance: z.boolean().default(false).describe("Attach per-hit source provenance and index freshness (about 120 bytes per hit). Off by default."), pathPrefix: z.string().optional(), tags: z.array(z.string()).optional(), entities: z.array(z.string()).optional(), types: z.array(z.string()).optional(), status: z.array(z.string()).optional(), semantic: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(10), chunksPerNote: z.number().int().min(1).max(5).default(2), snippetLength: z.number().int().min(100).max(3000).default(700), ...VIEW_FIELD,
    }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, view, includeProvenance, ...options }) => { try { const runtime = resolveSearchRuntime(); return ok(projectSearchResult("recall", withProvenance(await runtime.retrieval.recall(query, options), runtime.vaultId, includeProvenance), view)); } catch (error) { return refusalForError(error) ?? err(error); } });

  server.registerTool("find_related", {
    title: "Find Related Obsidian Notes",
    inputSchema: { path: z.string().min(1), semantic: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(10), includeProvenance: z.boolean().default(false).describe("Attach per-hit source provenance and index freshness (about 120 bytes per hit). Off by default."), ...VIEW_FIELD }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ path: notePath, view, includeProvenance, ...options }) => { try { const runtime = resolveSearchRuntime(); return ok(projectSearchResult("find_related", withProvenance(await relatedToPath(notePath, options, runtime), runtime.vaultId, includeProvenance), view)); } catch (error) { return refusalForError(error) ?? err(error); } });

  server.registerTool("graph_health", {
    title: "Audit Obsidian Graph Health",
    inputSchema: { pathPrefix: z.string().optional(), includeDetails: z.boolean().default(false), includeProposals: z.boolean().default(false).describe("Return `proposals` for reviewable link repairs: ambiguous targets as candidates only (never a chosen one) and single-candidate spelling fixes, each with the expectedRevision plan_note_changes takes. Executes nothing."), limit: z.number().int().min(1).max(5000).default(200) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ pathPrefix, includeDetails, includeProposals, limit }) => {
    try {
      const index = await resolveSearchRuntime().index.getVaultIndex({ pathPrefix });
      const incoming = new Map(index.records.map((record) => [record.path, 0]));
      const issues = [];
      const counts = { resolved: 0, ambiguous: 0, unresolved: 0, attachment: 0 };
      for (const record of index.records) {
        for (const link of record.links) {
          const resolution = index.resolveLink(link, record.path);
          counts[resolution.status] = (counts[resolution.status] || 0) + 1;
          if (resolution.path) incoming.set(resolution.path, (incoming.get(resolution.path) || 0) + 1);
          if (["ambiguous", "unresolved"].includes(resolution.status) && issues.length < limit) issues.push({ source: record.path, raw: link.raw, status: resolution.status, candidates: resolution.candidates });
        }
      }
      const orphans = index.records.filter((record) => (incoming.get(record.path) || 0) === 0).map((record) => record.path);
      const deadends = index.records.filter((record) => !record.links.some((link) => index.resolveLink(link, record.path).path)).map((record) => record.path);
      const proposals = includeProposals ? graphProposals(index, limit) : undefined;
      return ok({ notes: index.records.length, links: Object.values(counts).reduce((sum, value) => sum + value, 0), counts, orphans: { count: orphans.length, paths: includeDetails ? orphans.slice(0, limit) : undefined }, deadends: { count: deadends.length, paths: includeDetails ? deadends.slice(0, limit) : undefined }, issues: includeDetails ? issues : undefined, ...(includeProposals ? { proposals } : {}), truncated: issues.length >= limit || (proposals?.length ?? 0) >= limit });
    } catch (error) { return refusalForError(error) ?? err(error); }
  });

  server.registerTool("suggest_links", {
    title: "Suggest Obsidian Links",
    inputSchema: { path: z.string().min(1), semantic: z.boolean().default(true), limit: z.number().int().min(1).max(50).default(10) }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ path: notePath, ...options }) => {
    try {
      const related = await relatedToPath(notePath, { ...options, limit: options.limit * 3 }, resolveSearchRuntime());
      return ok({ path: related.path, suggestions: related.results.filter((item) => !item.directlyLinked).slice(0, options.limit), semanticUsed: related.semanticUsed, semanticError: related.semanticError });
    } catch (error) { return refusalForError(error) ?? err(error); }
  });

  server.registerTool("memory_capture", {
    title: "Capture Managed Obsidian Memory",
    inputSchema: { title: z.string().min(1).max(200), content: z.string().min(1).max(200000), kind: z.enum(["fact", "decision", "project", "episode", "preference"]).default("fact"), description: z.string().max(1000).optional(), tags: z.array(z.string()).default([]), entities: z.array(z.string()).default([]), projects: z.array(z.string()).default([]), confidence: z.number().min(0).max(1).default(0.8), status: z.enum(["active", "superseded", "archived"]).default("active"), path: z.string().optional(), source: z.string().optional() },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      // Refuse an unmaterialized selection before any Vault stat/open.
      const runtime = resolveSearchRuntime();
      const content = safeMemoryContent(input.content);
      const date = new Date().toISOString().slice(0, 10);
      const relativePath = input.path || path.posix.join(MEMORY_PATH, `${date} ${safeFilename(input.title)}.md`);
      if (relativePath !== MEMORY_PATH && !relativePath.startsWith(`${MEMORY_PATH.replace(/\/$/, "")}/`)) throw new Error(`Managed memories must stay under ${MEMORY_PATH}`);
      await assertExistingMemoryParent(relativePath);
      const abs = resolveVaultPath(relativePath, { assumeMarkdown: true });
      if (await exists(abs)) throw new Error("Memory already exists; use note editing tools with revision checks to update it");
      const now = new Date().toISOString();
      const frontmatter = { id: `memory-${randomUUID()}`, type: "memory", memory_kind: input.kind, title: input.title, description: input.description || content.slice(0, 180).replace(/\s+/g, " "), status: input.status, confidence: input.confidence, entities: input.entities, projects: input.projects, tags: [...new Set(["memory", ...input.tags.map((tag) => tag.replace(/^#/, ""))])], source: input.source || undefined, created: date, updated: now };
      const written = await writeNoteFile(abs, frontmatter, `# ${input.title}\n\n${content.trim()}\n`);
      // Only this Vault's index generation and retrieval snapshot move (§11, §21 MV-I03).
      runtime.index.invalidate(toVaultPath(abs));
      await runtime.retrieval.syncRetrievalIndex({ embeddings: false });
      return ok({ path: toVaultPath(abs), revision: written.revision, managedRoot: MEMORY_PATH });
    } catch (error) { return refusalForError(error) ?? err(error); }
  });

  server.registerTool("memory_recall", {
    title: "Recall Managed Obsidian Memory",
    inputSchema: { query: z.string().min(1).max(4000), kinds: z.array(z.string()).optional(), entities: z.array(z.string()).optional(), semantic: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(10) }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, kinds, ...options }) => { try { return ok(await resolveSearchRuntime().retrieval.recall(query, { ...options, pathPrefix: MEMORY_PATH, types: ["memory"], kinds })); } catch (error) { return refusalForError(error) ?? err(error); } });

  server.registerTool("skill_list", {
    title: "List Managed Obsidian Skills",
    inputSchema: { validOnly: z.boolean().default(false), limit: z.number().int().min(1).max(1000).default(200) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ validOnly, limit }) => {
    try {
      resolveSearchRuntime(); // refuse an unmaterialized selection before any Vault readdir (§47)
      return ok(await listSkillPackages({ validOnly, limit }));
    } catch (error) { return refusalForError(error) ?? err(error); }
  });

  server.registerTool("skill_match", {
    title: "Match Managed Obsidian Skills",
    inputSchema: { query: z.string().min(1).max(4000), semantic: z.boolean().default(true), trustedOnly: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(5) }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, trustedOnly, ...options }) => {
    try {
      const recalled = await resolveSearchRuntime().retrieval.recall(query, { ...options, pathPrefix: SKILLS_PATH, limit: options.limit * 5 });
      const packages = await listSkillPackages({ limit: 1000 });
      const packageByEntry = new Map(packages.skills.map((item) => [item.entryPath, item]));
      const matches = recalled.results.filter((item) => packageByEntry.has(item.path)).map((item) => {
        const packaged = packageByEntry.get(item.path);
        return { ...item, kind: "package", skill: packaged.name, validation: { valid: packaged.valid, errors: packaged.errors, warnings: packaged.warnings }, trusted: packaged.trusted };
      }).filter((item) => !trustedOnly || item.trusted).slice(0, options.limit);
      return ok({ query, matches, semanticUsed: recalled.semanticUsed, semanticError: recalled.semanticError, executionAuthorized: false });
    } catch (error) { return refusalForError(error) ?? err(error); }
  });

  server.registerTool("skill_validate", {
    title: "Validate Obsidian Skill",
    inputSchema: { path: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path: skillPath }) => {
    try { resolveSearchRuntime(); return ok(await validateSkillPackage(skillPath)); } catch (error) { return refusalForError(error) ?? err(error); }
  });

  server.registerTool("skill_export", {
    title: "Export Portable Skill ZIP",
    inputSchema: { skill: z.string().min(1), destination: z.string().optional(), overwrite: z.boolean().default(false) },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, async (input) => { try { resolveSearchRuntime(); return ok(await exportSkillPackage(input)); } catch (error) { return refusalForError(error) ?? err(error); } });

  server.registerTool("skill_import", {
    title: "Import Portable Skill ZIP",
    inputSchema: { archivePath: z.string().min(1), dryRun: z.boolean().default(true) },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, async (input) => { try { resolveSearchRuntime(); return ok(await importSkillPackage(input)); } catch (error) { return refusalForError(error) ?? err(error); } });
}
