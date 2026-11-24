import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { err, ok } from "../result.js";
// Per-Vault routing (Wave D / D-files, contract §10.1/§29): every note/version/trash primitive
// below resolves against `requestContext().vaultRuntime`.
import { assertWritable, deleteFileVersion, deleteTrashEntry, listFileVersions, listTrashEntries, readFileVersion, readTrashEntry, resolveVaultPath, restoreFileVersion, restoreTrashEntry, toVaultPath } from "../vault-runtime/request-vault.js";
// Per-Vault search/index routing (Wave D / D-search §29 + D-plans): the link/graph read tools
// resolve their index through the search runtime, and a recovery write invalidates that same
// per-Vault instance through this lane's seam (never the primary facade's index); the path
// normalizer stays Vault-independent and keeps coming from the primary facade.
import { refusalForError, resolveSearchRuntime } from "../search-runtimes.js";
import { invalidateSelectedVaultIndex } from "../plan-runtimes.js";
import { normalizeNotePath } from "../vault.js";
import { applyNotePlan, createDeletePlan, createMovePlan, createRestoreTrashPlan, createRestoreVersionPlan } from "../mutation-plans.js";

export function registerLinkTools(server) {
  server.registerTool(
    "move_note",
    {
      title: "Move Obsidian Note",
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().default(false),
        updateLinks: z.boolean().default(true),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ from, to, overwrite, updateLinks, ifMatch }) => {
      try {
        assertWritable();
        const plan = await createMovePlan({ from, to, overwrite, updateLinks, ifMatch });
        const applied = await applyNotePlan(plan.planId, plan.planHash, randomUUID());
        const fromRel = toVaultPath(resolveVaultPath(from, { assumeMarkdown: true }));
        const toRel = toVaultPath(resolveVaultPath(to, { assumeMarkdown: true }));
        return ok({ moved: { from: fromRel, to: toRel },
          updatedLinksIn: applied.changed.map((item) => item.path).filter((item) => item !== fromRel && item !== toRel) });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete Obsidian Note",
      inputSchema: { path: z.string().min(1), backup: z.boolean().default(true), ifMatch: z.string().optional() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path: notePath, backup, ifMatch }) => {
      try {
        assertWritable();
        const plan = await createDeletePlan({ path: notePath, backup, ifMatch });
        const applied = await applyNotePlan(plan.planId, plan.planHash, randomUUID());
        const deleted = applied.changed[0];
        return ok({ deleted: deleted.path, previousSizeInBytes: deleted.previousSizeInBytes, backup: deleted.backup });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get Obsidian Backlinks",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const targetPath = normalizeNotePath(path);
        const index = await resolveSearchRuntime().index.getVaultIndex();
        const backlinks = [];
        for (const record of index.records) {
          const matches = record.links.map((link) => ({ ...link, resolution: index.resolveLink(link, record.path) })).filter((link) => link.resolution.path === targetPath);
          if (matches.length) backlinks.push({ path: record.path, links: matches });
        }
        return ok({ target: targetPath, backlinks });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_trash",
    {
      title: "List Obsidian MCP Trash",
      inputSchema: {
        pathPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(5000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, limit }) => {
      try {
        const entries = await listTrashEntries({ pathPrefix, limit });
        return ok({ entries, truncated: entries.length >= limit });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "restore_from_trash",
    {
      title: "Restore Obsidian MCP Trash Entry",
      inputSchema: {
        backupPath: z.string().min(1),
        destination: z.string().optional(),
        overwrite: z.boolean().default(false),
        removeBackup: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ backupPath, destination, overwrite, removeBackup }) => {
      try {
        assertWritable();
        const source = await readTrashEntry(backupPath, { maxBytes: Number.MAX_SAFE_INTEGER });
        const destinationPath = toVaultPath(resolveVaultPath(destination || source.originalPath));
        if (!destinationPath.toLowerCase().endsWith(".md")) {
          return ok(await restoreTrashEntry(backupPath, { destination, overwrite, removeBackup }));
        }
        const plan = await createRestoreTrashPlan({ backupPath, destination, overwrite, removeBackup });
        const applied = await applyNotePlan(plan.planId, plan.planHash, randomUUID());
        const restored = applied.changed[0] || { path: plan.changes[0].path, revision: plan.changes[0].candidateRevision };
        return ok({ backupPath: source.backupPath, restoredPath: restored.path,
          revision: restored.revision, size: restored.size ?? source.size,
          backupRemoved: Boolean(restored.backupRemoved) });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "list_versions",
    {
      title: "List Obsidian MCP File Versions",
      inputSchema: { path: z.string().min(1), limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, limit }) => {
      try {
        return ok({ path, versions: await listFileVersions(path, { limit }) });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "delete_trash_entry",
    {
      title: "Delete Obsidian MCP Trash Entry",
      inputSchema: { backupPath: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ backupPath }) => {
      try {
        return ok(await deleteTrashEntry(backupPath));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "restore_version",
    {
      title: "Restore Obsidian MCP File Version",
      inputSchema: { versionId: z.string().min(1).optional(), path: z.string().min(1).optional(), revision: z.string().min(1).describe("Vault Git commit (4-40 hex), HEAD or HEAD~N; use with path instead of versionId. Markdown only.").optional(), destination: z.string().optional(), overwrite: z.boolean().default(false), ifMatch: z.string().optional() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ versionId, path, revision, destination, overwrite, ifMatch }) => {
      try {
        assertWritable();
        const gitSource = path !== undefined || revision !== undefined;
        if (gitSource ? (versionId !== undefined || !path || !revision) : !versionId) throw new Error("Supply either versionId or path + revision, exclusively");
        const source = gitSource ? null : await readFileVersion(versionId);
        const destinationPath = toVaultPath(resolveVaultPath(destination || path || source.path));
        if (!gitSource && !destinationPath.toLowerCase().endsWith(".md")) {
          const restoredFile = await restoreFileVersion(versionId, { destination, overwrite, ifMatch });
          // Wave D / D-plans: a recovery write invalidates the *selected* Vault's index, exactly
          // like the other mutating tools (contract §11/§21 MV-I03) — the primary facade's
          // `invalidateVaultIndex` would advance the primary index for a secondary restore.
          invalidateSelectedVaultIndex(restoredFile.restoredPath);
          return ok(restoredFile);
        }
        const plan = await createRestoreVersionPlan({ versionId, path, revision, destination, overwrite, ifMatch });
        const applied = await applyNotePlan(plan.planId, plan.planHash, randomUUID(), { returnPreWriteVersionId: true });
        const restored = applied.changed[0] || { path: plan.changes[0].path, revision: plan.changes[0].candidateRevision };
        return ok({ ...(source ? { versionId: source.versionId } : { sourceRevision: plan.sourceRevision }),
          restoredPath: restored.path, revision: restored.revision,
          size: restored.size ?? source?.size ?? (await stat(resolveVaultPath(restored.path))).size,
          ...(restored.preWriteVersionId ? { preWriteVersionId: restored.preWriteVersionId } : {}) });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "delete_version",
    {
      title: "Delete Obsidian MCP File Version",
      inputSchema: { versionId: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ versionId }) => {
      try {
        return ok(await deleteFileVersion(versionId));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "get_graph",
    {
      title: "Get Obsidian Link Graph",
      inputSchema: { pathPrefix: z.string().optional(), limit: z.number().int().min(1).max(5000).default(1000) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, limit }) => {
      try {
        const index = await resolveSearchRuntime().index.getVaultIndex({ pathPrefix });
        const records = index.records.slice(0, limit);
        const nodes = [];
        const edges = [];
        for (const record of records) {
          nodes.push({ id: record.path, tags: record.tags, aliases: record.aliases });
          for (const link of record.links) {
            const resolution = index.resolveLink(link, record.path);
            edges.push({ from: record.path, to: resolution.path || link.target, type: link.type, raw: link.raw, status: resolution.status, candidates: resolution.candidates });
          }
        }
        return ok({ nodes, edges, truncated: index.records.length > limit, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "get_unresolved_links",
    {
      title: "Get Unresolved Obsidian Links",
      inputSchema: { pathPrefix: z.string().optional(), includeAmbiguous: z.boolean().default(true), limit: z.number().int().min(1).max(5000).default(500) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, includeAmbiguous, limit }) => {
      try {
        const index = await resolveSearchRuntime().index.getVaultIndex({ pathPrefix });
        const links = [];
        for (const record of index.records) {
          for (const link of record.links) {
            const resolution = index.resolveLink(link, record.path);
            if (resolution.status === "resolved" || (!includeAmbiguous && resolution.status === "ambiguous")) continue;
            links.push({ source: record.path, raw: link.raw, target: link.target, type: link.type, status: resolution.status, candidates: resolution.candidates });
            if (links.length >= limit) return ok({ links, truncated: true, index: index.stats });
          }
        }
        return ok({ links, truncated: false, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "get_orphans",
    {
      title: "Get Orphan Obsidian Notes",
      inputSchema: { pathPrefix: z.string().optional(), limit: z.number().int().min(1).max(5000).default(500) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, limit }) => {
      try {
        const fullIndex = await resolveSearchRuntime().index.getVaultIndex();
        const incoming = new Map(fullIndex.records.map((record) => [record.path, 0]));
        for (const record of fullIndex.records) {
          for (const link of record.links) {
            const resolved = fullIndex.resolveLink(link, record.path);
            if (resolved.path) incoming.set(resolved.path, (incoming.get(resolved.path) || 0) + 1);
          }
        }
        const prefix = pathPrefix ? `${pathPrefix.replace(/\/$/, "")}/` : "";
        const notes = fullIndex.records.filter((record) => (!prefix || record.path.startsWith(prefix)) && (incoming.get(record.path) || 0) === 0).slice(0, limit).map((record) => ({ path: record.path, tags: record.tags, aliases: record.aliases }));
        return ok({ notes, truncated: notes.length >= limit, index: fullIndex.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "get_deadends",
    {
      title: "Get Dead-end Obsidian Notes",
      inputSchema: { pathPrefix: z.string().optional(), limit: z.number().int().min(1).max(5000).default(500) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, limit }) => {
      try {
        const index = await resolveSearchRuntime().index.getVaultIndex({ pathPrefix });
        const notes = index.records.filter((record) => !record.links.some((link) => index.resolveLink(link, record.path).path)).slice(0, limit).map((record) => ({ path: record.path, tags: record.tags, aliases: record.aliases }));
        return ok({ notes, truncated: notes.length >= limit, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );
}
