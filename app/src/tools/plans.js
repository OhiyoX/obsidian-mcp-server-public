import { z } from "zod/v4";
import {
  applyNotePlan,
  compareNoteSources,
  createNotePlan,
  createMovePlan,
  createDeletePlan,
  createRestoreVersionPlan,
  createRestoreTrashPlan,
  getNotePlan,
  getNoteVersion,
} from "../mutation-plans.js";
import { err, ok } from "../result.js";

const replacementSchema = z.object({
  search: z.string().min(1),
  replace: z.string(),
  useRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  flexibleWhitespace: z.boolean().default(false),
  replaceAll: z.boolean().default(true),
});

const changeSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(["write", "append", "patch", "replace", "frontmatter", "tags"]),
  baseRevision: z.string().optional(),
  mustNotExist: z.boolean().default(false),
  content: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  section: z.string().optional(),
  targetType: z.enum(["heading", "block", "frontmatter"]).optional(),
  target: z.string().optional(),
  patchOperation: z.enum(["append", "prepend", "replace"]).optional(),
  createTargetIfMissing: z.boolean().default(false),
  replacements: z.array(replacementSchema).optional(),
  action: z.enum(["set", "delete", "replace", "add", "remove"]).optional(),
  key: z.string().optional(),
  value: z.unknown().optional(),
  updates: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  location: z.enum(["frontmatter", "inline", "both"]).optional(),
}).superRefine((change, context) => {
  if (change.operation === "patch" && (!change.targetType || !change.target)) context.addIssue({ code: "custom", message: "patch requires targetType and target" });
  if (change.operation === "replace" && !change.replacements?.length) context.addIssue({ code: "custom", message: "replace requires replacements" });
  if ((change.operation === "frontmatter" || change.operation === "tags") && !change.action) context.addIssue({ code: "custom", message: `${change.operation} requires action` });
});

const maxDiffCharsSchema = z.number().int().min(1).max(500000).default(100000);

const comparisonSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current"), path: z.string().min(1) }),
  z.object({ kind: z.literal("version"), versionId: z.string().min(1) }),
  z.object({ kind: z.literal("candidate"), path: z.string().optional(), content: z.string().default(""), frontmatter: z.record(z.string(), z.unknown()).optional() }),
]);

export function registerPlanTools(server) {
  server.registerTool("plan_restore_from_trash", {
    title: "Plan Obsidian Trash Restore",
    description: "Preview a revision-bound Markdown note restore from Trash. Apply with apply_note_plan.",
    inputSchema: {
      backupPath: z.string().min(1), destination: z.string().optional(), overwrite: z.boolean().default(false),
      removeBackup: z.boolean().default(false), ifMatch: z.string().optional(),
      maxDiffChars: maxDiffCharsSchema,
      ttlSeconds: z.number().int().min(60).max(1800).default(600),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ backupPath, destination, overwrite, removeBackup, ifMatch, maxDiffChars, ttlSeconds }) => {
    try {
      return ok(await createRestoreTrashPlan({ backupPath, destination, overwrite, removeBackup, ifMatch },
        { maxDiffChars, ttlMs: ttlSeconds * 1000 }));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("plan_restore_version", {
    title: "Plan Obsidian Version Restore",
    description: "Preview a rollback / undo of an accidental or mistaken write as a revision-bound plan with a diff. Apply with apply_note_plan.",
    inputSchema: {
      versionId: z.string().min(1), destination: z.string().optional(), overwrite: z.boolean().default(false), ifMatch: z.string().optional(),
      maxDiffChars: maxDiffCharsSchema,
      ttlSeconds: z.number().int().min(60).max(1800).default(600),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ versionId, destination, overwrite, ifMatch, maxDiffChars, ttlSeconds }) => {
    try {
      return ok(await createRestoreVersionPlan({ versionId, destination, overwrite, ifMatch },
        { maxDiffChars, ttlMs: ttlSeconds * 1000 }));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("plan_delete_note", {
    title: "Plan Obsidian Note Deletion",
    description: "Preview a revision-bound note deletion and optional durable Trash backup. Apply with apply_note_plan.",
    inputSchema: {
      path: z.string().min(1), backup: z.boolean().default(true), ifMatch: z.string().optional(),
      maxDiffChars: maxDiffCharsSchema,
      ttlSeconds: z.number().int().min(60).max(1800).default(600),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ path, backup, ifMatch, maxDiffChars, ttlSeconds }) => {
    try {
      return ok(await createDeletePlan({ path, backup, ifMatch },
        { maxDiffChars, ttlMs: ttlSeconds * 1000 }));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("plan_move_note", {
    title: "Plan Obsidian Note Move",
    description: "Preview a revision-bound note move and affected links as one recoverable batch (max 25 files). Apply with apply_note_plan.",
    inputSchema: {
      from: z.string().min(1), to: z.string().min(1),
      overwrite: z.boolean().default(false), updateLinks: z.boolean().default(true),
      ifMatch: z.string().optional(),
      maxDiffChars: maxDiffCharsSchema,
      ttlSeconds: z.number().int().min(60).max(1800).default(600),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ from, to, overwrite, updateLinks, ifMatch, maxDiffChars, ttlSeconds }) => {
    try {
      return ok(await createMovePlan({ from, to, overwrite, updateLinks, ifMatch },
        { maxDiffChars, ttlMs: ttlSeconds * 1000 }));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("plan_note_changes", {
    title: "Plan Obsidian Note Changes",
    description: "Create a side-effect-free, revision-bound multi-note change plan with bounded unified diffs and Obsidian-aware structural summaries.",
    inputSchema: {
      changes: z.array(changeSchema).min(1).max(25),
      maxDiffChars: maxDiffCharsSchema,
      ttlSeconds: z.number().int().min(60).max(1800).default(600),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ changes, maxDiffChars, ttlSeconds }) => {
    try {
      return ok(await createNotePlan(changes, { maxDiffChars, ttlMs: ttlSeconds * 1000 }));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("get_note_plan", {
    title: "Get Obsidian Note Plan",
    description: "Read an unexpired note change plan created by the same MCP author.",
    inputSchema: { planId: z.string().uuid() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ planId }) => {
    try {
      return ok(getNotePlan(planId));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("apply_note_plan", {
    title: "Apply Obsidian Note Plan",
    description: "Apply a revision-bound multi-note plan with preflight checks, crash recovery, and durable 24-hour replay of committed results by idempotency key.",
    inputSchema: {
      planId: z.string().uuid(),
      planHash: z.string().min(1),
      idempotencyKey: z.string().min(8).max(200),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ planId, planHash, idempotencyKey }) => {
    try {
      return ok(await applyNotePlan(planId, planHash, idempotencyKey));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("get_note_version", {
    title: "Get Obsidian Note Version",
    description: "Read one persistent pre-write version snapshot of a note to inspect it before rolling back an accidental or mistaken write. 回滚前先看旧版本内容用它。",
    inputSchema: { versionId: z.string().min(1), maxChars: z.number().int().min(1000).max(500000).default(100000) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ versionId, maxChars }) => {
    try {
      return ok(await getNoteVersion(versionId, maxChars));
    } catch (error) {
      return err(error);
    }
  });

  server.registerTool("compare_note_versions", {
    title: "Compare Obsidian Note Versions",
    description: "Diff the current note against a persistent version snapshot, or any two sources, to see what a rollback / undo would change.",
    inputSchema: {
      left: comparisonSource,
      right: comparisonSource,
      maxDiffChars: maxDiffCharsSchema,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ left, right, maxDiffChars }) => {
    try {
      return ok(await compareNoteSources(left, right, maxDiffChars));
    } catch (error) {
      return err(error);
    }
  });
}
