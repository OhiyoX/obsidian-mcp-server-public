import fs from "node:fs/promises";
import { z } from "zod/v4";
import {
  allTagsForNote,
  appendInlineTags,
  applyStringReplacement,
  assertFrontmatterKeyIsLiteral,
  buildCachedMetadata,
  documentMap,
  findHeadingSection,
  frontmatterTags,
  inlineTags,
  normalizeTagList,
  parseBlocks,
  patchBodySection,
  readNote,
  removeInlineTags,
  serializeNoteFile,
  writeNoteFile,
} from "../obsidian.js";
import { err, ok } from "../result.js";
import { assertWritable, exists, resolveVaultPath, toVaultPath } from "../vault-runtime/request-vault.js";
import { assessWriteImpact, assertShrinkConfirmed } from "../write-guard.js";

export function registerNoteTools(server) {
  server.registerTool(
    "get_note",
    {
      title: "Get Obsidian Note",
      description: "Read a note as content, full structured data, document map, metadata, or a single section.",
      inputSchema: {
        path: z.string().min(1),
        format: z.enum(["content", "full", "document-map", "metadata", "section"]).default("full"),
        section: z.string().optional(),
        sectionType: z.enum(["heading", "block", "frontmatter"]).optional(),
        includeLinks: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, format, section, sectionType, includeLinks }) => {
      try {
        const note = await readNote(resolveVaultPath(path, { assumeMarkdown: true }));
        if (format === "content") return ok({ path: note.path, content: note.raw, revision: note.revision });
        if (format === "document-map") return ok(documentMap(note));
        if (format === "metadata") return ok({ path: note.path, cache: buildCachedMetadata(note), revision: note.revision });
        if (format === "section") return ok(readSection(note, section, sectionType));
        const output = { path: note.path, frontmatter: note.frontmatter, content: note.content, tags: allTagsForNote(note), stat: note.stat, revision: note.revision };
        if (includeLinks) output.outgoingLinks = documentMap(note).outgoingLinks;
        return ok(output);
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get Obsidian Metadata",
      description: "Return a best-effort Obsidian CachedMetadata-shaped object for a Markdown note.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const note = await readNote(resolveVaultPath(path, { assumeMarkdown: true }));
        return ok({ path: note.path, cache: buildCachedMetadata(note), revision: note.revision });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "write_note",
    {
      title: "Write Obsidian Note",
      description: "Create a note or overwrite an existing note when overwrite=true. The server records explicit or derived _meta[obsidian/author] in mcp_author frontmatter.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string().default(""),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        overwrite: z.boolean().default(false),
        ifMatch: z.string().optional().describe("Optional revision returned by get_note; rejects stale writes."),
        confirmShrink: z.boolean().default(false),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ path, content, frontmatter, overwrite, ifMatch, confirmShrink }) => {
      try {
        assertWritable();
        const abs = resolveVaultPath(path, { assumeMarkdown: true });
        const existed = await exists(abs);
        if (existed && !overwrite) throw new Error("Note already exists. Set overwrite=true to replace it.");
        const previousSize = existed ? (await fs.stat(abs)).size : 0;
        const previousContent = existed ? (await readNote(abs)).content : "";
        const nextFrontmatter = frontmatter || {};
        const nextBytes = Buffer.byteLength(serializeNoteFile(nextFrontmatter, content), "utf8");
        const impact = assessWriteImpact({ previousBytes: previousSize, nextBytes, previousContent, nextContent: content });
        // Only an overwrite of an existing note can destroy content; creation is exempt.
        if (existed && overwrite) assertShrinkConfirmed(impact, { confirmShrink, toolName: "write_note", path: toVaultPath(abs) });
        const written = await writeNoteFile(abs, nextFrontmatter, content, { ifMatch });
        return ok({
          path: toVaultPath(abs),
          created: !existed,
          previousSizeInBytes: previousSize,
          currentSizeInBytes: written.stat.size,
          revision: written.revision,
          removedHeadings: impact.removedHeadings,
          removedBlocks: impact.removedBlocks,
          shrinkRatio: impact.shrinkRatio,
          preWriteVersionId: written.preWriteVersionId,
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append To Obsidian Note",
      description: "Append content to a note, optionally inside a heading section.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        section: z.string().optional(),
        createTargetIfMissing: z.boolean().default(false),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ path, content, section, createTargetIfMissing, ifMatch }) => {
      try {
        assertWritable();
        const abs = resolveVaultPath(path, { assumeMarkdown: true });
        const existed = await exists(abs);
        if (!existed) {
          if (section) throw new Error("Cannot append to a section in a missing note");
          const written = await writeNoteFile(abs, {}, content, { ifMatch });
          return ok({ path: toVaultPath(abs), created: true, previousSizeInBytes: 0, currentSizeInBytes: written.stat.size, revision: written.revision, preWriteVersionId: written.preWriteVersionId });
        }
        const previousSize = (await fs.stat(abs)).size;
        const note = await readNote(abs);
        const next = section ? patchBodySection(note.content, "heading", section, "append", content, createTargetIfMissing) : `${note.content.trimEnd()}\n${content}\n`;
        const written = await writeNoteFile(abs, note.frontmatter, next, { ifMatch });
        return ok({ path: note.path, created: false, previousSizeInBytes: previousSize, currentSizeInBytes: written.stat.size, revision: written.revision, preWriteVersionId: written.preWriteVersionId });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "patch_note",
    {
      title: "Patch Obsidian Note",
      description: "Append, prepend, or replace note content. replace swaps the ENTIRE targeted heading body (or block line / frontmatter value), not one matching line; a write shrinking the note by more than 20% is refused unless confirmShrink is true.",
      inputSchema: {
        path: z.string().min(1),
        operation: z.enum(["append", "prepend", "replace"]).default("append"),
        targetType: z.enum(["heading", "block", "frontmatter"]),
        target: z.string().min(1),
        content: z.string(),
        createTargetIfMissing: z.boolean().default(false),
        ifMatch: z.string().optional(),
        confirmShrink: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, operation, targetType, target, content, createTargetIfMissing, ifMatch, confirmShrink }) => {
      try {
        assertWritable();
        const abs = resolveVaultPath(path, { assumeMarkdown: true });
        const previousSize = (await fs.stat(abs)).size;
        const note = await readNote(abs);
        let nextFrontmatter = note.frontmatter;
        let nextContent = note.content;
        if (targetType === "frontmatter") {
          assertFrontmatterKeyIsLiteral(target, { existing: note.frontmatter });
          const current = note.frontmatter[target];
          const value = operation === "append" && current !== undefined ? `${current}${content}` : operation === "prepend" && current !== undefined ? `${content}${current}` : content;
          nextFrontmatter = { ...note.frontmatter, [target]: value };
        } else {
          nextContent = patchBodySection(note.content, targetType, target, operation, content, createTargetIfMissing);
        }
        const nextBytes = Buffer.byteLength(serializeNoteFile(nextFrontmatter, nextContent), "utf8");
        const impact = assessWriteImpact({ previousBytes: previousSize, nextBytes, previousContent: note.content, nextContent });
        // Every operation is assessed; only replace can actually shrink a note.
        assertShrinkConfirmed(impact, { confirmShrink, toolName: "patch_note", path: note.path });
        const written = await writeNoteFile(abs, nextFrontmatter, nextContent, { ifMatch });
        const updated = await readNote(abs);
        return ok({
          path: note.path,
          operation,
          targetType,
          target,
          previousSizeInBytes: previousSize,
          currentSizeInBytes: updated.stat.size,
          revision: updated.revision,
          removedHeadings: impact.removedHeadings,
          removedBlocks: impact.removedBlocks,
          shrinkRatio: impact.shrinkRatio,
          preWriteVersionId: written.preWriteVersionId,
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "replace_in_note",
    {
      title: "Replace In Obsidian Note",
      description: "Run literal or regex replacements against a note body while preserving frontmatter.",
      inputSchema: {
        path: z.string().min(1),
        replacements: z.array(z.object({
          search: z.string().min(1),
          replace: z.string(),
          useRegex: z.boolean().default(false),
          caseSensitive: z.boolean().default(false),
          wholeWord: z.boolean().default(false),
          flexibleWhitespace: z.boolean().default(false),
          replaceAll: z.boolean().default(true),
        })).min(1),
        ifMatch: z.string().optional(),
        confirmShrink: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, replacements, ifMatch, confirmShrink }) => {
      try {
        assertWritable();
        const abs = resolveVaultPath(path, { assumeMarkdown: true });
        const previousSize = (await fs.stat(abs)).size;
        const note = await readNote(abs);
        const { output, details } = applyStringReplacement(note.content, replacements);
        const nextBytes = Buffer.byteLength(serializeNoteFile(note.frontmatter, output), "utf8");
        const impact = assessWriteImpact({ previousBytes: previousSize, nextBytes, previousContent: note.content, nextContent: output });
        assertShrinkConfirmed(impact, { confirmShrink, toolName: "replace_in_note", path: note.path });
        const written = await writeNoteFile(abs, note.frontmatter, output, { ifMatch });
        return ok({
          path: note.path,
          replacements: details,
          previousSizeInBytes: previousSize,
          currentSizeInBytes: written.stat.size,
          revision: written.revision,
          removedHeadings: impact.removedHeadings,
          removedBlocks: impact.removedBlocks,
          shrinkRatio: impact.shrinkRatio,
          preWriteVersionId: written.preWriteVersionId,
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "manage_frontmatter",
    {
      title: "Manage Obsidian Frontmatter",
      description: "Get, set, delete, or replace YAML frontmatter values for a note.",
      inputSchema: {
        path: z.string().min(1),
        action: z.enum(["get", "set", "delete", "replace"]).default("get"),
        key: z.string().optional(),
        value: z.unknown().optional(),
        updates: z.record(z.string(), z.unknown()).optional(),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ path, action, key, value, updates, ifMatch }) => {
      try {
        const abs = resolveVaultPath(path, { assumeMarkdown: true });
        const note = await readNote(abs);
        if (action === "get") return ok({ path: note.path, frontmatter: key ? { [key]: note.frontmatter[key] } : note.frontmatter, revision: note.revision });
        assertWritable();
        let next = { ...note.frontmatter };
        if (action === "set") {
          if (updates) next = { ...next, ...updates };
          if (key) {
            assertFrontmatterKeyIsLiteral(key, { existing: note.frontmatter });
            next[key] = value;
          }
        } else if (action === "delete") {
          if (!key) throw new Error("key is required for delete");
          assertFrontmatterKeyIsLiteral(key, { existing: note.frontmatter, removing: true });
          delete next[key];
        } else {
          next = updates || {};
        }
        const written = await writeNoteFile(abs, next, note.content, { ifMatch });
        // Return stamped frontmatter (mcp_author is server-owned), not the pre-write object.
        const saved = await readNote(abs);
        return ok({ path: note.path, frontmatter: saved.frontmatter, revision: written.revision });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "manage_tags",
    {
      title: "Manage Obsidian Tags",
      description: "List, add, remove, or set tags in frontmatter, inline body tags, or both.",
      inputSchema: {
        path: z.string().min(1),
        action: z.enum(["list", "add", "remove", "set"]).default("list"),
        tags: z.array(z.string()).default([]),
        location: z.enum(["frontmatter", "inline", "both"]).default("frontmatter"),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ path, action, tags, location, ifMatch }) => {
      try {
        const abs = resolveVaultPath(path, { assumeMarkdown: true });
        const note = await readNote(abs);
        const front = frontmatterTags(note.frontmatter);
        const body = inlineTags(note.content);
        if (action === "list") return ok({ path: note.path, frontmatter: front, inline: body, all: [...new Set([...front, ...body])], revision: note.revision });
        assertWritable();
        const normalized = normalizeTagList(tags);
        let nextFrontmatter = { ...note.frontmatter };
        let nextContent = note.content;
        if (location === "frontmatter" || location === "both") {
          if (action === "add") nextFrontmatter.tags = [...new Set([...front, ...normalized])];
          if (action === "remove") nextFrontmatter.tags = front.filter((tag) => !normalized.includes(tag));
          if (action === "set") nextFrontmatter.tags = normalized;
        }
        if (location === "inline" || location === "both") {
          if (action === "add") nextContent = appendInlineTags(nextContent, normalized);
          if (action === "remove") nextContent = removeInlineTags(nextContent, normalized);
          if (action === "set") nextContent = appendInlineTags(removeInlineTags(nextContent, body), normalized);
        }
        await writeNoteFile(abs, nextFrontmatter, nextContent, { ifMatch });
        const updated = await readNote(abs);
        return ok({ path: updated.path, frontmatter: frontmatterTags(updated.frontmatter), inline: inlineTags(updated.content), all: allTagsForNote(updated), revision: updated.revision });
      } catch (error) {
        return err(error);
      }
    },
  );
}

function readSection(note, section, sectionType) {
  if (!section) throw new Error("section is required when format=section");
  if (sectionType === "frontmatter") return { path: note.path, section, value: note.frontmatter[section] };
  if (sectionType === "block") {
    const block = parseBlocks(note.content).find((item) => item.id === section.replace(/^\^/, ""));
    if (!block) throw new Error(`Block not found: ${section}`);
    return { path: note.path, section, block };
  }
  const found = findHeadingSection(note.content, section);
  if (!found) throw new Error(`Heading not found: ${section}`);
  return { path: note.path, section, heading: found.heading, content: note.content.split("\n").slice(found.bodyStart, found.end).join("\n") };
}
