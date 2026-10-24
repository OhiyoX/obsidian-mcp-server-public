import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod/v4";
import { MAX_READ_BYTES, OBSIDIAN_TIMEZONE } from "../config.js";
import { BaseQueryError, compileBaseView, evaluateBaseView, parseAndValidateBase, validateBaseDocument } from "../base-query.js";
// Issue #627: the MCP face re-derives the grouping/summaries DECLARATION from the
// same frozen readers the shared service uses, so the projection below cannot
// invent a grouping the `.base` never asked for (pure modules, no cycle: both
// are already imported by `base-query.js`).
import { readGroupByDeclaration } from "../base-grouping.js";
import { readSummaryDeclarations } from "../base-summaries.js";
// Issue #628: ad-hoc narrowing inputs are normalized before any Vault I/O.
import { normalizeAdhocFilters, normalizeAdhocSearch, normalizeAdhocSort } from "../base-adhoc-params.js";
// P1 (#629): the MCP write face reuses A4a's mutation module and A4b's amplification
// budget instead of re-implementing either. `base-patch.js` owns the desktop write
// whitelist and the line locator; `base-patch-budget.js` owns the 512-entry / 256 KB
// bound the Web PATCH face enforces before it enters the domain function.
import {
  BASE_PATCH_MUTATION_SCHEMA,
  PATCH_BASE_WIRE_CODES,
  assertProvenanceSpliceable,
  bytesRevision,
  normalizePatchBaseError,
  patchBaseError,
  queryAvailabilityWarnings,
  splicePatchedBytes,
} from "../base-patch-face.js";
import { BASE_VIEW_OPTION_KEYS, patchBaseLines } from "../base-patch.js";
import { MAX_PATCH_MUTATIONS, assertMutationBudget } from "../base-patch-budget.js";
// P1 (#630): the `base:create` face (descriptor + handler + wire codes).
import { CREATE_BASE_ENTRY_TOOL, basePath, createBaseEntryHandler } from "../base-create-face.js";

import { assertFrontmatterKeyIsLiteral, parseFrontmatter, readNote, writeNoteFile } from "../obsidian.js";
import { assertBaseQueryFormat, renderBaseQueryFormat } from "../base-formats.js";
import { mapBaseViewsError, normalizeBaseInputPath, summarizeBaseViews } from "../base-view-summaries.js";
import { err, errStructured, ok } from "../result.js";
// Wave D / D-workflows (contract §10.1/§29): this face resolves its Vault per request — the
// selected Vault's `localFs` plus the record source of its *own* VaultIndex instance — instead of
// the primary-bound `src/vault.js` / `src/vault-index.js` facades. A selection without a
// materialized runtime is refused structurally, never served by the primary Vault.
import { refusalForError, resolveWorkflowRuntime } from "../workflow-runtimes.js";
import { assertWritable, exists } from "../vault-runtime/request-vault.js";
import { formatObsidianDate, inferPropertyType, parseTasks, renderTemplate, updateTaskLine } from "../workflows.js";

async function readJsonConfig(localFs, relativePath, fallback = {}) {
  const abs = localFs.resolveVaultPath(relativePath);
  if (!(await exists(abs))) return fallback;
  return JSON.parse(await localFs.readLimitedText(abs));
}

async function templateFolder(localFs) {
  const config = await readJsonConfig(localFs, ".obsidian/templates.json", {});
  return config.folder || "Templates";
}

async function readTemplate(localFs, name) {
  const folder = await templateFolder(localFs);
  const normalized = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
  const abs = localFs.resolveVaultPath(path.posix.join(folder, normalized));
  return { abs, content: await localFs.readLimitedText(abs), folder };
}

async function dailyNoteInfo(localFs, dateInput) {
  const config = await readJsonConfig(localFs, ".obsidian/daily-notes.json", {});
  const date = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid date: ${dateInput}`);
  const format = config.format || "YYYY-MM-DD";
  const title = formatObsidianDate(date, format, OBSIDIAN_TIMEZONE);
  const relativePath = path.posix.join(config.folder || "", `${title}.md`);
  return { date, title, path: relativePath, template: config.template || "", format, folder: config.folder || "", timeZone: OBSIDIAN_TIMEZONE };
}


// Issue #531: `rename_property`'s `to` is a caller-supplied front matter key that can CREATE a new
// key, so it needs the same fail-closed literal guard as `patch_note` / `manage_frontmatter` / note
// plans (`assertFrontmatterKeyIsLiteral`, `src/obsidian.js`) — one implementation, no second copy.
// `from` stays untouched on purpose: it must already exist as a literal key, so renaming *out of* a
// legacy dotted key (`a.b` -> `plain`) remains the only cleanup path. The guard's generic wording is
// prefixed with the rename action so the caller learns which write refused it, and the check runs
// before the snapshot loop (and before the index read) so preview and apply are identical and
// neither can leave a half-written batch.
function assertRenameDestinationIsWritable(to) {
  try {
    assertFrontmatterKeyIsLiteral(to);
  } catch (error) {
    throw new Error(`rename_property cannot create a property name containing ".": "${to}". ${error.message}`);
  }
}

// Issue #627 (P1) — the MCP projection of the cut-4 grouping DTO.
//
// `base-query.js` `buildGroupingDto` already computes `groups` / `summaries` and
// omits BOTH keys when the selected view declares neither, so the values are the
// service's verbatim ones (this adapter is a transport, never a second
// calculator). What it does own is the decision of what may reach the wire:
//
//   * declaration absent -> `{}`: the historical DTO keeps its exact keys and
//     field order, byte-for-byte (the B1 DTO lock in
//     `test/mcp-query-base-dto-lock.test.js`);
//   * declaration present -> `groups` (plus `summaries` when declared) appended
//     AFTER the historical fields, so the pre-#627 prefix never moves. An
//     undeclared key is absent, never `null` / `[]` — the same ADD-only rule the
//     service and the Web Base route already follow;
//   * declaration present but the result carries no `groups` -> fail closed with
//     `code: "unsupported"`. #627 names exactly this shape as the risk:
//     `supportedSubset: true` while the caller's grouping intent was swallowed.
//     Returning `{}` here would be that false success, so it throws instead.
//
// Pure: no I/O, no state, no clock. Exported so the negative-control test can
// exercise the projection with a stub result (and prove the end-to-end
// assertions depend on it).
export function projectBaseGroupingDto({ view, result }) {
  const groupBy = readGroupByDeclaration(view);
  const summaries = readSummaryDeclarations(view?.summaries, "views[].summaries");
  if (!groupBy && !summaries) return {};
  if (!Array.isArray(result?.groups)) {
    throw new BaseQueryError(
      "Base view declares groupBy/summaries but the query result carried no groups; refusing to report an ungrouped result as supported",
      "unsupported",
    );
  }
  if (summaries && !result.summaries) {
    throw new BaseQueryError(
      "Base view declares summaries but the query result carried none; refusing to report them as supported",
      "unsupported",
    );
  }
  return {
    groups: result.groups,
    ...(summaries ? { summaries: result.summaries } : {}),
  };
}

export function registerWorkflowTools(server) {
  server.registerTool(
    "list_tasks",
    {
      title: "List Obsidian Tasks",
      description: "List Markdown tasks with stable path:line references and status filtering.",
      inputSchema: {
        pathPrefix: z.string().optional(),
        query: z.string().optional(),
        status: z.string().length(1).optional(),
        completed: z.boolean().optional(),
        limit: z.number().int().min(1).max(5000).default(500),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, query, status, completed, limit }) => {
      try {
        const { index: vaultIndex } = resolveWorkflowRuntime();
        const index = await vaultIndex.getVaultIndex({ pathPrefix });
        const matcher = query ? new RegExp(query, "i") : null;
        const tasks = [];
        for (const record of index.records) {
          for (const task of parseTasks(record.raw, record.path)) {
            if (status !== undefined && task.status !== status) continue;
            if (completed !== undefined && task.completed !== completed) continue;
            if (matcher && !matcher.test(task.text)) continue;
            tasks.push({ ...task, revision: record.revision });
            if (tasks.length >= limit) return ok({ tasks, truncated: true, index: index.stats });
          }
        }
        return ok({ tasks, truncated: false, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Obsidian Task",
      description: "Toggle or set one Markdown task status using a path:line reference.",
      inputSchema: {
        ref: z.string().optional(),
        path: z.string().optional(),
        line: z.number().int().min(1).optional(),
        status: z.string().default("toggle").describe("toggle, done, todo, or one custom status character"),
        ifMatch: z.string().optional(),
        dryRun: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ ref, path: notePath, line, status, ifMatch, dryRun }) => {
      try {
        if (ref) {
          const match = ref.match(/^(.*):(\d+)$/);
          if (!match) throw new Error("ref must use path:line format");
          notePath = match[1];
          line = Number(match[2]);
        }
        if (!notePath || !line) throw new Error("Provide ref or both path and line");
        const { index, localFs } = resolveWorkflowRuntime();
        const abs = localFs.resolveVaultPath(notePath, { assumeMarkdown: true });
        const note = await readNote(abs);
        const wantedStatus = status === "done" ? "x" : status === "todo" ? " " : status;
        const updated = updateTaskLine(note.raw, line, wantedStatus);
        if (dryRun) return ok({ path: note.path, line, previousStatus: updated.previousStatus, status: updated.status, changed: updated.raw !== note.raw, dryRun: true, revision: note.revision });
        const written = await localFs.atomicWriteFile(abs, updated.raw, { encoding: "utf-8", ifMatch });
        // §11/§37: the write invalidates the *selected* Vault's index, so a secondary mutation can
        // never advance (or leave stale) another Vault's index generation.
        index.invalidate(note.path);
        return ok({ path: note.path, line, previousStatus: updated.previousStatus, status: updated.status, revision: written.revision });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "daily_note",
    {
      title: "Manage Obsidian Daily Note",
      description: "Resolve, read, create, append, or prepend a Daily Note using vault configuration and templates.",
      inputSchema: {
        action: z.enum(["path", "read", "create", "append", "prepend"]).default("path"),
        date: z.string().optional(),
        content: z.string().default(""),
        overwrite: z.boolean().default(false),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ action, date, content, overwrite, ifMatch }) => {
      try {
        const { index, localFs } = resolveWorkflowRuntime();
        const info = await dailyNoteInfo(localFs, date);
        const abs = localFs.resolveVaultPath(info.path);
        const existed = await exists(abs);
        if (action === "path") return ok({ ...info, date: info.date.toISOString(), exists: existed });
        if (action === "read") {
          const note = await readNote(abs);
          return ok({ ...info, date: info.date.toISOString(), content: note.raw, frontmatter: note.frontmatter, revision: note.revision, stat: note.stat });
        }
        assertWritable();
        if (action === "create") {
          if (existed && !overwrite) throw new Error("Daily note already exists. Set overwrite=true to replace it.");
          let template = content;
          if (!template && info.template) template = (await readTemplate(localFs, info.template)).content;
          const rendered = renderTemplate(template, { date: info.date, title: info.title, timeZone: info.timeZone });
          // Preserve template frontmatter and stamp the same mcp_author
          // provenance as append/prepend instead of writing raw bytes.
          const parsed = parseFrontmatter(rendered);
          const written = await writeNoteFile(abs, parsed.data, parsed.content, { ifMatch });
          index.invalidate(info.path);
          return ok({ ...info, date: info.date.toISOString(), created: !existed, revision: written.revision, size: written.stat.size });
        }
        if (!existed) throw new Error("Daily note does not exist; create it first");
        const note = await readNote(abs);
        const next = action === "append" ? `${note.content.trimEnd()}\n${content}\n` : `${content}\n${note.content}`;
        const written = await writeNoteFile(abs, note.frontmatter, next, { ifMatch });
        index.invalidate(info.path);
        return ok({ ...info, date: info.date.toISOString(), action, revision: written.revision, size: written.stat.size });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List Obsidian Templates",
      description: "List Markdown templates from the Templates core plugin folder.",
      inputSchema: { includeContent: z.boolean().default(false), limit: z.number().int().min(1).max(1000).default(200) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ includeContent, limit }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        const folder = await templateFolder(localFs);
        const root = localFs.resolveVaultPath(folder);
        if (!(await exists(root))) return ok({ folder, templates: [] });
        const entries = await localFs.walk(root, { recursive: true, extension: ".md", maxEntries: limit + 1 });
        const templates = [];
        for (const entry of entries.slice(0, limit)) templates.push({ name: entry.path.slice(folder.length + 1).replace(/\.md$/i, ""), path: entry.path, size: entry.size, modified: entry.modified, content: includeContent ? await localFs.readLimitedText(localFs.resolveVaultPath(entry.path)) : undefined });
        return ok({ folder, templates, truncated: entries.length > limit });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "create_from_template",
    {
      title: "Create Obsidian Note From Template",
      description: "Render Obsidian date/time/title variables plus custom variables into a new note.",
      inputSchema: {
        template: z.string().min(1),
        path: z.string().min(1),
        variables: z.record(z.string(), z.unknown()).optional(),
        date: z.string().optional(),
        overwrite: z.boolean().default(false),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ template, path: targetPath, variables, date, overwrite, ifMatch }) => {
      try {
        const { index, localFs } = resolveWorkflowRuntime();
        const source = await readTemplate(localFs, template);
        const abs = localFs.resolveVaultPath(targetPath, { assumeMarkdown: true });
        const existed = await exists(abs);
        if (existed && !overwrite) throw new Error("Destination note exists. Set overwrite=true to replace it.");
        const parsedDate = date ? new Date(date) : new Date();
        if (Number.isNaN(parsedDate.valueOf())) throw new Error(`Invalid date: ${date}`);
        const title = path.posix.basename(localFs.toVaultPath(abs)).replace(/\.md$/i, "");
        const rendered = renderTemplate(source.content, { date: parsedDate, title, variables, timeZone: OBSIDIAN_TIMEZONE });
        const written = await localFs.atomicWriteFile(abs, rendered, { encoding: "utf-8", ifMatch });
        index.invalidate(localFs.toVaultPath(abs));
        return ok({ template: localFs.toVaultPath(source.abs), path: localFs.toVaultPath(abs), created: !existed, revision: written.revision, size: written.stat.size });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_properties",
    {
      title: "List Obsidian Properties",
      description: "Aggregate note properties, inferred or configured types, occurrence counts, and optional file paths.",
      inputSchema: { pathPrefix: z.string().optional(), includeFiles: z.boolean().default(false), nameRegex: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, includeFiles, nameRegex }) => {
      try {
        const { index: vaultIndex, localFs } = resolveWorkflowRuntime();
        const index = await vaultIndex.getVaultIndex({ pathPrefix });
        const configured = await readJsonConfig(localFs, ".obsidian/types.json", {});
        const properties = new Map();
        for (const record of index.records) {
          for (const [name, value] of Object.entries(record.frontmatter)) {
            const current = properties.get(name) || { name, count: 0, types: new Set(), files: [] };
            current.count += 1;
            current.types.add(inferPropertyType(value));
            if (includeFiles) current.files.push(record.path);
            properties.set(name, current);
          }
        }
        const matcher = nameRegex ? new RegExp(nameRegex, "i") : null;
        const output = [...properties.values()].filter((item) => !matcher || matcher.test(item.name)).map((item) => ({ name: item.name, count: item.count, configuredType: configured[item.name], inferredTypes: [...item.types].sort(), files: includeFiles ? item.files : undefined })).sort((a, b) => a.name.localeCompare(b.name));
        return ok({ properties: output, configuredTypes: configured, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "rename_property",
    {
      title: "Rename Obsidian Property",
      description: "Rename a frontmatter property across notes with conflict handling and dry-run support.",
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1),
        pathPrefix: z.string().optional(),
        conflict: z.enum(["error", "skip", "overwrite"]).default("error"),
        dryRun: z.boolean().default(true),
        limit: z.number().int().min(1).max(5000).default(1000),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ from, to, pathPrefix, conflict, dryRun, limit }) => {
      try {
        assertRenameDestinationIsWritable(to);
        const { index: vaultIndex, localFs } = resolveWorkflowRuntime();
        // The index *payload* is a snapshot, the runtime is the invalidator: `vaultIndex.invalidate`
        // is the selected Vault's own index instance (`src/search-runtimes.js`). Wave F / F1's
        // completion matrix caught this local shadowing `index` (a payload has no `invalidate()`).
        const snapshot = await vaultIndex.getVaultIndex({ pathPrefix });
        const changed = [];
        const skipped = [];
        for (const record of snapshot.records) {
          if (!Object.hasOwn(record.frontmatter, from)) continue;
          if (Object.hasOwn(record.frontmatter, to) && conflict !== "overwrite") {
            if (conflict === "error") throw new Error(`Property conflict in ${record.path}: ${to} already exists`);
            skipped.push(record.path);
            continue;
          }
          changed.push(record.path);
          if (!dryRun) {
            const next = { ...record.frontmatter, [to]: record.frontmatter[from] };
            delete next[from];
            await writeNoteFile(localFs.resolveVaultPath(record.path), next, record.content, { ifMatch: record.revision });
            vaultIndex.invalidate(record.path);
          }
          if (changed.length >= limit) break;
        }
        return ok({ from, to, dryRun, changed, skipped, truncated: changed.length >= limit });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_aliases",
    {
      title: "List Obsidian Aliases",
      description: "List frontmatter aliases with their target note paths.",
      inputSchema: { pathPrefix: z.string().optional(), nameRegex: z.string().optional(), limit: z.number().int().min(1).max(5000).default(500) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, nameRegex, limit }) => {
      try {
        const { index: vaultIndex } = resolveWorkflowRuntime();
        const index = await vaultIndex.getVaultIndex({ pathPrefix });
        const matcher = nameRegex ? new RegExp(nameRegex, "i") : null;
        const aliases = [];
        for (const record of index.records) {
          for (const alias of record.aliases) {
            if (matcher && !matcher.test(alias)) continue;
            aliases.push({ alias, path: record.path });
            if (aliases.length >= limit) return ok({ aliases, truncated: true, index: index.stats });
          }
        }
        return ok({ aliases, truncated: false, index: index.stats });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "set_property_type",
    {
      title: "Set Obsidian Property Type",
      description: "Update the vault-wide Obsidian property type registry in .obsidian/types.json.",
      inputSchema: { name: z.string().min(1), type: z.enum(["text", "multitext", "number", "checkbox", "date", "datetime", "aliases", "tags"]), remove: z.boolean().default(false) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ name, type, remove }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        const relativePath = ".obsidian/types.json";
        const types = await readJsonConfig(localFs, relativePath, {});
        if (remove) delete types[name];
        else types[name] = type;
        const written = await localFs.atomicWriteFile(localFs.resolveVaultPath(relativePath), `${JSON.stringify(types, null, 2)}\n`, { encoding: "utf-8" });
        return ok({ name, type: remove ? undefined : type, removed: remove, revision: written.revision });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "list_bases",
    {
      title: "List Obsidian Bases",
      description: "List .base files in the vault.",
      inputSchema: { pathPrefix: z.string().optional(), limit: z.number().int().min(1).max(1000).default(200) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, limit }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        const root = localFs.resolveVaultPath(pathPrefix || "");
        const entries = await localFs.walk(root, { recursive: true, extension: ".base", maxEntries: limit + 1 });
        return ok({ bases: entries.slice(0, limit), truncated: entries.length > limit });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "get_base",
    {
      title: "Get Obsidian Base",
      description: "Read, parse, and validate an Obsidian .base YAML document. Returns `revision` — the sha256 of the document's bytes, the same token this server's write faces use as their precondition — so it can be passed straight into `patch_base`'s `ifMatch` or `write_base`'s `ifMatch`.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: inputPath }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        const abs = localFs.resolveVaultPath(basePath(inputPath));
        // One read, two views: `raw` is the decoded text (historical payload, unchanged) and the
        // token is over the very bytes that decode produced — not a re-read, which could describe
        // a different version of the file than `raw`.
        const bytes = await localFs.readLimitedBuffer(abs);
        const raw = bytes.toString("utf8");
        const base = yaml.load(raw);
        const errors = validateBaseDocument(base);
        // Additive (P1): `revision` is appended after the historical fields, so the
        // pre-existing `path/raw/base/valid/errors` payload keeps its shape and order.
        return ok({ path: localFs.toVaultPath(abs), raw, base, valid: errors.length === 0, errors, revision: bytesRevision(bytes) });

      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  server.registerTool(
    "write_base",
    {
      title: "Write Obsidian Base",
      // Honest labelling (Issue #629): this tool re-serialises the whole document, so it
      // cannot preserve what YAML dumping does not carry. `patch_base` is the tool for a
      // document that must stay byte-identical outside the edited lines.
      description: "Validate and atomically create or replace an Obsidian .base YAML document. This is a WHOLE-DOCUMENT rewrite: the document is re-serialised from the parsed mapping, so formatting is normalised, key order is not guaranteed and comments or unknown keys may not survive. Use `patch_base` when the file must keep everything you did not ask to change.",
      inputSchema: { path: z.string().min(1), base: z.record(z.string(), z.unknown()), overwrite: z.boolean().default(false), ifMatch: z.string().optional() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path: inputPath, base, overwrite, ifMatch }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        const errors = validateBaseDocument(base);
        if (errors.length) throw new Error(`Invalid Base: ${errors.join("; ")}`);
        const abs = localFs.resolveVaultPath(basePath(inputPath));
        const existed = await exists(abs);
        if (existed && !overwrite) throw new Error("Base exists. Set overwrite=true to replace it.");
        const raw = yaml.dump(base, { noRefs: true, lineWidth: 120, sortKeys: false });
        const written = await localFs.atomicWriteFile(abs, raw, { encoding: "utf-8", ifMatch });
        return ok({ path: localFs.toVaultPath(abs), created: !existed, revision: written.revision, size: written.stat.size });
      } catch (error) {
        return refusalForError(error) ?? err(error);
      }
    },
  );

  // P1 (#630) — `base:create` (`@3158532`) as an MCP write face. The descriptor, the
  // template read, the wire codes and the handler live in `../base-create-face.js`
  // (this file is at its line budget); the pure decisions live in `../base-create.js`.
  server.registerTool("create_base_entry", CREATE_BASE_ENTRY_TOOL, createBaseEntryHandler);
  server.registerTool(
    "patch_base",
    {
      title: "Patch Obsidian Base (line-surgical, CAS)",
      description:
        "Apply a line-surgical increment to an Obsidian .base document: only the addressed lines change, so comments, unknown keys, key order, quote style, line endings and the final-newline state outside them survive byte-for-byte. An addressed line is rewritten from the new value, so bytes *inside* an addressed line are not preserved (a non-UTF-8 byte there does not survive); lines outside them keep their bytes exactly, even bytes that are not valid UTF-8. " +
        "A document holding bytes that are not valid UTF-8 supports in-place replacements and appends at the end of the document, where every existing line keeps its bytes exactly; a structural edit that cannot be mapped back byte-for-byte — inserting a line in the middle, or deleting any line — fails closed with `base-not-patchable`, because line identity is not recoverable from a lossy decode — use `write_base` for that. " +
        "`ifMatch` is mandatory (the `revision` from `get_base`): a missing precondition fails with `precondition-required`, a stale one with `revision-conflict`, and in both cases the document is left untouched. " +
        "Only the desktop write whitelist is addressable (view options, `formulas.<name>`, `properties.<name>.displayName`); anything else fails closed with `base-not-patchable` / `base-unknown-key`. " +
        "The response always carries `warnings`: a non-empty array means `query_base` cannot serve the patched document (this server's query subset is narrower than the write whitelist), so do not assume the patch is queryable without reading it. " +
        "`mutationId` is accepted for parity with the Web PATCH face and is not used as an idempotency key here — the CAS revision is the concurrency guard. Use `write_base` only when the whole document should be re-serialised.",
      inputSchema: {
        path: z.string().min(1),
        // Optional in the schema on purpose: a missing precondition is refused *by the
        // handler* with the stable `precondition-required` code (A4b's 428), which a
        // protocol-level validation error could not express.
        ifMatch: z.string().min(1).optional(),
        mutations: z.array(BASE_PATCH_MUTATION_SCHEMA).min(1).max(MAX_PATCH_MUTATIONS),
        mutationId: z.string().min(1).max(120).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path: inputPath, ifMatch, mutations }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        const precondition = typeof ifMatch === "string" ? ifMatch.trim() : "";
        if (!precondition) {
          throw patchBaseError("precondition-required", "patch_base requires ifMatch (the content revision returned by get_base); a blind write is refused");
        }
        // Same budget as the Web PATCH face, checked before the read and the YAML parse.
        assertMutationBudget(mutations);
        assertWritable();
        const abs = localFs.resolveVaultPath(basePath(inputPath));
        // Read once: the token is over these bytes and A4a is handed their decoded view, so the
        // precondition the caller addresses and the document we patch are the same version.
        const bytes = await localFs.readLimitedBuffer(abs);
        const raw = bytes.toString("utf8");
        const current = bytesRevision(bytes);
        if (precondition !== current) {
          throw patchBaseError("revision-conflict", `Revision conflict: expected ${precondition}, current ${current}`, {
            expectedRevision: precondition,
            currentRevision: current,
          });
        }
        const { text: next, lines } = patchBaseLines(raw, mutations);
        // Fail closed *before* anything is spliced or written: on a document that is not valid
        // UTF-8 every line must come back from the original bytes or be explicitly written.
        assertProvenanceSpliceable(bytes, raw, lines);
        const warnings = queryAvailabilityWarnings(next);
        if (next === raw) {
          // A4a's idempotence: the document already holds the requested values. No bytes
          // are written, so the caller keeps the revision it addressed.
          return ok({ path: localFs.toVaultPath(abs), changed: false, revision: current, previousRevision: current, size: bytes.length, warnings });
        }
        // The patched text is spliced back into the original bytes: every line the locator
        // left alone keeps its bytes exactly (non-UTF-8 ones included), and only the
        // replaced/inserted lines are encoded fresh as UTF-8.
        const nextBytes = splicePatchedBytes(bytes, lines);
        if (nextBytes.length > MAX_READ_BYTES) throw patchBaseError("base-too-large", "Base exceeds the read limit after patching");
        // Atomic write + CAS inside the runtime's mutation lock: the revision is re-read
        // there over the same bytes, so a writer that landed between the read above and this
        // call loses. A Buffer is written as-is (`encoding` does not apply to it).
        const written = await localFs.atomicWriteFile(abs, nextBytes, { encoding: "utf8", ifMatch: current });
        return ok({ path: localFs.toVaultPath(abs), changed: true, revision: written.revision, previousRevision: current, size: written.stat.size, warnings });
      } catch (error) {
        const normalized = normalizePatchBaseError(error);
        if (PATCH_BASE_WIRE_CODES.has(normalized?.code)) return errStructured(normalized);
        if (/read-only/i.test(String(normalized?.message || ""))) return errStructured(patchBaseError("read-only", normalized.message));
        return refusalForError(normalized) ?? err(normalized);
      }
    },
  );

  server.registerTool(
    "query_base",
    {
      title: "Query Obsidian Base (Portable Subset)",
      description: "Query common safe Base filters and sorting in Docker. Supports and/or/not, comparisons, contains, startsWith, endsWith, file.inFolder, file.hasTag, and file.hasLink. Also evaluates the safe file.asLink(if(property, property, file.name)) formula subset into structured link cells; unsupported formulas fail closed. `format` selects the response rendering: json (default, unchanged DTO), csv, tsv, md, or paths. When the selected view declares `groupBy` / `summaries`, the DTO additionally carries `groups` (group key, keyType, count, rowPaths, per-group summaries) and — when declared — the view-wide `summaries`; both keys are absent when nothing is declared, and the csv/tsv/md/paths text never expresses grouping (read `structuredContent` for it). Three optional ad-hoc inputs narrow or reorder one call without writing the .base file: `filters` (the .base filter-group dialect: and/or/not groups, {key,op,value} leaves from the frozen operator list, or an advanced expression string) is AND-combined with the base and view filters; `sort` ([{property, direction}], direction asc|desc, default asc) REPLACES the view sort; `search` (case-insensitive substring over the view columns, like the Web `q`) is AND-combined with the filters. Pipeline order is filters -> search -> sort -> limit -> grouping -> summaries; `limit` keeps its historical meaning (an explicit row ceiling that overrides the view limit).",
      inputSchema: {
        path: z.string().min(1),
        view: z.string().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        filters: z.unknown().optional(),
        sort: z.array(z.unknown()).optional(),
        search: z.string().optional(),
        format: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: inputPath, view: viewName, limit, filters, sort, search, format }) => {
      let selectedFormat;
      try {
        // A1: fail closed on an unknown format instead of silently returning
        // json. Validated before any I/O so a bad parameter never reads a Base.
        selectedFormat = assertBaseQueryFormat(format);
        // #628: the ad-hoc narrowing inputs are normalized (and every malformed
        // shape refused with a stable BaseQueryError code) BEFORE any Vault I/O,
        // so a bad parameter never reads a Base. Absent inputs stay `undefined`
        // and are a no-op in the canonical evaluator.
        const filterExtra = normalizeAdhocFilters(filters);
        const sortOverride = normalizeAdhocSort(sort);
        const textQuery = normalizeAdhocSearch(search);
        const { index: vaultIndex, localFs } = resolveWorkflowRuntime();
        const abs = localFs.resolveVaultPath(basePath(inputPath));
        // parse + schema validation, then compile the whole formula AST before
        // any filtering/limit/empty result (shared canonical Base domain service).
        const { base } = parseAndValidateBase(await localFs.readLimitedText(abs));
        const { view, viewName: selectedViewName, order, formulas } = compileBaseView(base, viewName);
        // §11/§29: the record source is the *selected* Vault's index instance, so the Base query is
        // evaluated against that Vault's own notes and can never read another Vault's corpus.
        const index = await vaultIndex.getVaultIndex();
        const result = evaluateBaseView({ base, view, order, formulas, records: index.records, limit, filterExtra, sortOverride, textQuery });
        // Issue #627 fail-closed: if the shared service ever reports that it could
        // not execute the view, that must surface as a coded error — never as a
        // `supportedSubset: true` DTO. Unreachable on today's service (it throws
        // instead), which is exactly why the guard is cheap to keep.
        if (result.supportedSubset !== true) {
          throw new BaseQueryError("Base view uses unsupported configuration", "unsupported");
        }
        // MCP DTO parity: `views` / `columns` from the shared service stay out of
        // the tool contract and the field order matches the historical handler.
        // #627: `groups` / `summaries` are appended LAST and only when the selected
        // view declares `groupBy` / `summaries` (see `projectBaseGroupingDto`), so an
        // undeclared document stays byte-identical.
        const dto = { path: localFs.toVaultPath(abs), view: selectedViewName, rows: result.rows, totalMatched: result.totalMatched, truncated: result.truncated, supportedSubset: result.supportedSubset, index: index.stats, ...projectBaseGroupingDto({ view, result }) };
        // Backward compatibility (hard requirement): without `format` the result
        // is the historical `ok(dto)` — byte-for-byte identical.
        if (selectedFormat === "json") return ok(dto);
        const rendered = renderBaseQueryFormat({ format: selectedFormat, columns: result.columns, rows: result.rows });
        // #627 format decision: the rendered TEXT stays the flat row set (the
        // `toText` / `toMarkdown` byte baselines of A1 are frozen), while
        // `structuredContent` carries the grouping DTO — the same `groups` /
        // `summaries` keys as json, because they ride in `dto`. Grouping intent is
        // therefore never dropped: it is always on the wire for every format, and
        // docs/bases/MCP-GROUPED-DTO.md states that the four text formats never
        // express it.
        const structuredContent = { ...dto, format: selectedFormat, text: rendered.text };
        if (rendered.paths) structuredContent.paths = rendered.paths;
        // The text formats are consumed as text (`content[0].text`); the
        // structured payload keeps the DTO contract plus the rendering so both
        // transports carry the same result.
        return { content: [{ type: "text", text: rendered.text }], structuredContent };
      } catch (error) {
        // A6: a BaseQueryError / format code stays on the wire (stable
        // `{code, message}` payload); the Vault-scope refusal keeps its own
        // frozen shape.
        return refusalForError(error) ?? errStructured(error);
      }
    },
  );

  // A2 — `base:views` (`@3242395`, MCP-AGENT-SURFACE-GAP.md §2.1/§4): the
  // desktop's view *selector* has no MCP counterpart, so an agent that wants to
  // know "which views does this Base have / which one is the kanban" today has
  // to pull the whole YAML with `get_base`. This tool returns the summaries only
  // (no YAML body, no rows) and never returns `views` from `query_base` (the B1
  // DTO lock forbids that field there). Read-only: same Vault-relative `path`
  // input as its `get_base`/`query_base` siblings, same read scope, no new
  // capability (`scopes.js` READ_TOOLS) and no relaxation.
  server.registerTool(
    "list_base_views",
    {
      title: "List Obsidian Base Views",
      description: "List the declared views of an Obsidian .base file as lightweight summaries (name, type, filters, sort, limit, groupBy, summaries, isDefault) with the view `query_base` uses when `view` is omitted. Use it to pick a view before querying. Returns no YAML body and no row data.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: inputPath }) => {
      try {
        const { localFs } = resolveWorkflowRuntime();
        // Input validation before any Vault I/O (a non-.base path fails closed),
        // then the shared root-confinement + symlink-refusal read path.
        const requested = normalizeBaseInputPath(inputPath);
        const abs = localFs.resolveVaultPath(requested);
        const { base } = parseAndValidateBase(await localFs.readLimitedText(abs));
        return ok({ path: localFs.toVaultPath(abs), ...summarizeBaseViews(base) });
      } catch (error) {
        // A6 shape: `{code, message}`. `mapBaseViewsError` only re-codes the
        // message-only filesystem facts (missing file, traversal/symlink
        // refusal) and rebuilds their message from the *relative* path, so no
        // absolute path is ever echoed; every other error keeps its own code and
        // the Vault-scope refusal keeps its frozen shape.
        const mapped = mapBaseViewsError(error, { path: inputPath });
        return refusalForError(mapped) ?? errStructured(mapped);
      }
    },
  );
}
