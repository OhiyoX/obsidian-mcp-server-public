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
      description: "Move or rename a note, optionally updating wikilinks and Markdown links in other notes.",
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
      description: "Delete a note through a recoverable plan. By default a persistent Trash backup is finalized after commit.",
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
      description: "Find all notes that link to a given note by wikilink, Markdown link, or embed.",
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
      description: "List durable Trash backups of deleted notes, the starting point to recover or undo an accidental deletion. 误删恢复先列这里。",
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
      description: "Recover a note deleted by mistake from its durable Trash backup (undo an accidental deletion) to its original path or a new vault-relative destination. 误删恢复用它。",
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
      description: "List a note's persistent pre-write version snapshots (newest first) so you can roll back, undo or revert an accidental or mistaken write; every write response returns the preWriteVersionId of its own snapshot. 查看历史快照、准备回滚误写时用它。",
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
      description: "Permanently delete one explicitly identified backup from the MCP trash.",
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
      description: "Roll back (undo / revert) an accidental or mistaken write: restore a pre-write version snapshot. Pass overwrite: true when the note still exists; IDs come from list_versions or a write response preWriteVersionId. 误写回滚、撤销上一次写入用它。",
      inputSchema: { versionId: z.string().min(1), destination: z.string().optional(), overwrite: z.boolean().default(false), ifMatch: z.string().optional() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ versionId, destination, overwrite, ifMatch }) => {
      try {
        assertWritable();
        const source = await readFileVersion(versionId);
        const destinationPath = toVaultPath(resolveVaultPath(destination || source.path));
        if (!destinationPath.toLowerCase().endsWith(".md")) {
          const restoredFile = await restoreFileVersion(versionId, { destination, overwrite, ifMatch });
          // Wave D / D-plans: a recovery write invalidates the *selected* Vault's index, exactly
          // like the other mutating tools (contract §11/§21 MV-I03) — the primary facade's
          // `invalidateVaultIndex` would advance the primary index for a secondary restore.
          invalidateSelectedVaultIndex(restoredFile.restoredPath);
          return ok(restoredFile);
        }
        const plan = await createRestoreVersionPlan({ versionId, destination, overwrite, ifMatch });
        const applied = await applyNotePlan(plan.planId, plan.planHash, randomUUID());
        const restored = applied.changed[0] || { path: plan.changes[0].path, revision: plan.changes[0].candidateRevision };
        return ok({ versionId: source.versionId, restoredPath: restored.path, revision: restored.revision,
          size: restored.size ?? source.size });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "delete_version",
    {
      title: "Delete Obsidian MCP File Version",
      description: "Permanently delete one explicitly identified pre-write version snapshot. This is not a rollback and has no undo.",
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
      description: "Return vault wikilink, Markdown-link, and embed graph nodes and edges.",
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
      description: "List unresolved or ambiguous internal links with source notes and candidate targets.",
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
      description: "List notes with no resolved incoming links.",
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
      description: "List notes with no resolved outgoing links.",
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
