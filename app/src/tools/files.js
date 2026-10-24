import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyMatter } from "../frontmatter.js";
import { z } from "zod/v4";
import { readZipEntryFile } from "../archive/zip.js";
import { MAX_INLINE_TRANSFER_BYTES, MAX_READ_BYTES, OBSIDIAN_ACCEPTED_EXTENSIONS, TRANSFER_CHUNK_BYTES } from "../config.js";
import { trackGitMutation } from "../git.js";
import { buildNoteFileTransfer, noteFileTransferResult } from "../note-transfer.js";
import {
  appendFileUpload,
  cancelFileUpload,
  createZipArchive,
  extractZipArchive,
  fileUploadStatus,
  inspectZipFile,
  pullFile,
  startFileUpload,
} from "../file-transfer.js";
import { err, ok } from "../result.js";
import { startDirectUpload } from "../direct-upload.js";
import { requireRequestAuthor, stampFrontmatter } from "../request-context.js";
import { assessWriteImpact, assertShrinkConfirmed } from "../write-guard.js";
import {
  assertNotVaultRoot,
  assertCanonicalInsideVault,
  assertWritable,
  atomicWriteFile,
  ensureVaultParent,
  exists,
  fileExtension,
  fileRevision,
  isAcceptedObsidianFile,
  isTextFile,
  readLimitedText,
  resolveCanvasPath,
  resolveVaultPath,
  toVaultPath,
  walk,
} from "../vault-runtime/request-vault.js";

export function registerFileTools(server) {
  server.registerTool(
    "list_files",
    {
      title: "List Obsidian Files",
      description: "List Obsidian-supported files, including Markdown, Bases, Canvas, images, audio, video, and PDFs.",
      inputSchema: {
        pathPrefix: z.string().optional(),
        recursive: z.boolean().default(false),
        depth: z.number().int().min(0).max(20).default(2),
        includeDirectories: z.boolean().default(true),
        includeHidden: z.boolean().default(false),
        acceptedOnly: z.boolean().default(true),
        nameRegex: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pathPrefix, recursive, depth, includeDirectories, includeHidden, acceptedOnly, nameRegex, cursor, limit }) => {
      try {
        const dir = resolveVaultPath(pathPrefix || "");
        const entries = await walk(dir, { recursive, depth, includeDirectories, includeHidden, extension: "*", nameRegex, afterPath: cursor, entryFilter: acceptedOnly ? (entry) => entry.type === "directory" || isAcceptedObsidianFile(entry.path) : undefined, maxEntries: limit + 1 });
        const truncated = entries.length > limit;
        const page = entries.slice(0, limit);
        return ok({ directory: toVaultPath(dir), acceptedExtensions: [...OBSIDIAN_ACCEPTED_EXTENSIONS].sort(), entries: page, truncated, nextCursor: truncated ? page.at(-1)?.path : undefined });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "pull_note_file",
    {
      title: "Pull Complete Obsidian Note File",
      description: "Return one complete Markdown note as an MCP embedded resource plus structured text/base64 content so the client can save it unchanged to local storage.",
      inputSchema: {
        path: z.string().min(1),
        encoding: z.enum(["base64", "text"]).default("base64"),
        maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).default(MAX_READ_BYTES),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: notePath, encoding, maxBytes }) => {
      try {
        const abs = resolveVaultPath(notePath, { assumeMarkdown: true });
        if (fileExtension(abs) !== ".md") throw new Error("pull_note_file only supports Markdown note files");
        await assertCanonicalInsideVault(abs);
        const stat = await fs.stat(abs);
        if (!stat.isFile()) throw new Error("Note path must identify a file");
        if (stat.size > maxBytes) throw new Error(`Complete note is ${stat.size} bytes, exceeding maxBytes=${maxBytes}; raise maxBytes to pull the whole file`);
        const transfer = buildNoteFileTransfer(await fs.readFile(abs), {
          path: toVaultPath(abs),
          stat: { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() },
        }, encoding);
        return noteFileTransferResult(transfer);
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "get_file",
    {
      title: "Get Obsidian File",
      description: "Read any Obsidian-supported vault file as text, JSON, or base64.",
      inputSchema: {
        path: z.string().min(1),
        encoding: z.enum(["auto", "text", "json", "base64"]).default("auto"),
        acceptedOnly: z.boolean().default(true),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, encoding, acceptedOnly, offset, length }) => {
      try {
        const abs = resolveVaultPath(path);
        if (acceptedOnly && !isAcceptedObsidianFile(abs)) throw new Error(`Unsupported Obsidian file extension: ${fileExtension(abs)}`);
        await assertCanonicalInsideVault(abs);
        const stat = await fs.stat(abs);
        const mode = encoding === "auto" ? (isTextFile(abs) ? "text" : "base64") : encoding;
        const output = { path: toVaultPath(abs), extension: fileExtension(abs), encoding: mode, revision: await fileRevision(abs), stat: { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() } };
        if (mode === "base64") {
          const readLength = Math.min(length || Math.min(MAX_READ_BYTES, TRANSFER_CHUNK_BYTES), Math.max(0, stat.size - offset));
          const buffer = Buffer.alloc(readLength);
          const handle = await fs.open(abs, "r");
          try {
            const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
            output.content = buffer.subarray(0, bytesRead).toString("base64");
            output.range = { offset, length: bytesRead, total: stat.size, truncated: offset + bytesRead < stat.size };
          } finally {
            await handle.close();
          }
        }
        else {
          const text = await readLimitedText(abs);
          output.content = mode === "json" ? JSON.parse(text) : text;
        }
        return ok(output);
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "pull_file",
    {
      title: "Pull Complete Vault File",
      description: "Return one complete Vault attachment as an MCP embedded binary resource. For larger files, use get_file with base64 offset/length chunks.",
      inputSchema: {
        path: z.string().min(1),
        maxBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, maxBytes }) => {
      try {
        const { transfer } = await pullFile(path, { maxBytes });
        const uri = `obsidian://vault/${transfer.path.split("/").map(encodeURIComponent).join("/")}`;
        const { content, ...summary } = transfer;
        return {
          content: [
            { type: "resource", resource: { uri, mimeType: transfer.mimeType, blob: content } },
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
          structuredContent: transfer,
        };
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write Obsidian File",
      description: "Write a vault file as text, JSON, or base64.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string().optional(),
        json: z.unknown().optional(),
        encoding: z.enum(["text", "json", "base64"]).default("text"),
        overwrite: z.boolean().default(false),
        acceptedOnly: z.boolean().default(true),
        ifMatch: z.string().optional(),
        confirmShrink: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, content, json, encoding, overwrite, acceptedOnly, ifMatch, confirmShrink }) => {
      try {
        assertWritable();
        const abs = resolveVaultPath(path);
        if (acceptedOnly && !isAcceptedObsidianFile(abs)) throw new Error(`Unsupported Obsidian file extension: ${fileExtension(abs)}`);
        const existed = await exists(abs);
        if (existed && !overwrite) throw new Error("File already exists. Set overwrite=true to replace it.");
        const previousSize = existed ? (await fs.stat(abs)).size : 0;
        let data;
        if (encoding === "base64") data = Buffer.from(content || "", "base64");
        else if (encoding === "json") data = `${JSON.stringify(json === undefined ? JSON.parse(content || "null") : json, null, 2)}\n`;
        else data = content || "";
        const markdown = fileExtension(abs) === ".md";
        if (markdown && encoding === "text") {
          const parsed = parseFrontmatter(String(data));
          data = stringifyMatter(stampFrontmatter(parsed.data, requireRequestAuthor()), parsed.content);
        }
        // Issue #251: overwriting an existing Markdown note through write_file
        // must not bypass the shared shrink guard that write_note/patch_note use.
        // Non-Markdown resources keep their own explicit overwrite semantics, and
        // creating a new file can never destroy content.
        let impact = { removedHeadings: [], removedBlocks: [], shrinkRatio: 0 };
        if (markdown && existed && overwrite === true) {
          const nextBytes = encoding === "base64" ? Buffer.byteLength(data) : Buffer.byteLength(String(data), "utf8");
          const nextContent = encoding === "base64" ? "" : String(data);
          let previousContent = "";
          if (encoding !== "base64") {
            try {
              previousContent = await readLimitedText(abs);
            } catch {
              previousContent = "";
            }
          }
          impact = assessWriteImpact({ previousBytes: previousSize, nextBytes, previousContent, nextContent });
          assertShrinkConfirmed(impact, { confirmShrink, toolName: "write_file", path: toVaultPath(abs) });
        }
        const written = await atomicWriteFile(abs, data, { encoding: encoding === "base64" ? undefined : "utf-8", ifMatch });
        return ok({
          path: toVaultPath(abs),
          created: !existed,
          previousSizeInBytes: previousSize,
          currentSizeInBytes: written.stat.size,
          revision: written.revision,
          removedHeadings: impact.removedHeadings,
          removedBlocks: impact.removedBlocks,
          shrinkRatio: impact.shrinkRatio,
          preWriteVersionId: written.preWriteVersionId ?? null,
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "start_file_upload",
    {
      title: "Start Chunked Vault File Upload",
      description: "Create a resumable upload for an attachment. Upload base64 chunks sequentially with upload_file_chunk; arbitrary attachment extensions are allowed outside protected Vault internals.",
      inputSchema: {
        path: z.string().min(1),
        totalBytes: z.number().int().min(0),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
        overwrite: z.boolean().default(false),
        acceptedOnly: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, totalBytes, sha256, overwrite, acceptedOnly }) => {
      try {
        return ok(await startFileUpload({ vaultPath: path, totalBytes, expectedSha256: sha256, overwrite, acceptedOnly }));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "start_direct_upload",
    {
      title: "Start Direct HTTP Vault File Upload",
      description: "Create an HTTP upload handle so the file bytes travel from the client to the server without passing through the model, MCP JSON or base64. Send bytes to relativePath with the same credential. Either PUT the exact bytes in one request with the exact Content-Length, or resumable: PATCH consecutive byte ranges with Upload-Offset set to the bytes already stored (single writer, contiguous only; a mismatched offset returns 409 with the authoritative Upload-Offset). An interrupted upload can be resumed from its stored offset instead of restarting; expect a transient 409 UPLOAD_IN_PROGRESS right after a disconnect and retry after a short backoff.",
      inputSchema: {
        path: z.string().min(1),
        totalBytes: z.number().int().min(0),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        overwrite: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, totalBytes, sha256, overwrite }) => {
      try {
        return ok(await startDirectUpload({ vaultPath: path, totalBytes, expectedSha256: sha256, overwrite }));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "upload_file_chunk",
    {
      title: "Upload Vault File Chunk",
      description: "Append the next canonical-base64 chunk to a staged upload. Set finalize=true on the last chunk to verify size/SHA-256 and atomically publish it into the Vault.",
      inputSchema: {
        uploadId: z.string().uuid(),
        offset: z.number().int().min(0),
        base64: z.string(),
        finalize: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return ok(await appendFileUpload(input));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "file_upload_status",
    {
      title: "Get Vault File Upload Status",
      description: "Recover resumable upload progress after an MCP session or OAuth token refresh. Returns the next byte offset or the idempotent completion result.",
      inputSchema: { uploadId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ uploadId }) => {
      try {
        return ok(await fileUploadStatus(uploadId));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "cancel_file_upload",
    {
      title: "Cancel Vault File Upload",
      description: "Delete a staged upload without changing the Vault.",
      inputSchema: { uploadId: z.string().uuid() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ uploadId }) => {
      try {
        return ok(await cancelFileUpload(uploadId));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "create_archive",
    {
      title: "Create Vault ZIP Archive",
      description: "Package selected Vault files/directories into a ZIP stored in the Vault. Symbolic links, protected internals, excessive entry counts, and oversized inputs are rejected.",
      inputSchema: {
        sourcePaths: z.array(z.string().min(1)).min(1).max(100),
        destination: z.string().min(1),
        overwrite: z.boolean().default(false),
        includeHidden: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return ok(await createZipArchive(input));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "inspect_archive",
    {
      title: "Inspect Vault ZIP Archive",
      description: "Validate a ZIP and return its entry manifest without extracting it.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        return ok(await inspectZipFile(path));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "read_archive_entry",
    {
      title: "Read Vault ZIP Entry",
      description: "Read a single file entry from a Vault ZIP archive without extracting it.",
      inputSchema: {
        archivePath: z.string().min(1),
        entry: z.string().min(1),
        maxBytes: z.number().int().min(1).max(MAX_INLINE_TRANSFER_BYTES).default(65536),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ archivePath, entry, maxBytes }) => {
      try { return ok(await readZipEntryFile(archivePath, entry, { maxBytes })); }
      catch (error) { return err(error); }
    },
  );

  server.registerTool(
    "extract_archive",
    {
      title: "Safely Extract Vault ZIP Archive",
      description: "Validate and extract a ZIP into a Vault directory. Defaults to dryRun=true; path traversal, symlinks, encrypted/ZIP64 files, duplicates, protected internals, excessive expansion, and unintended overwrite are rejected.",
      inputSchema: {
        archivePath: z.string().min(1),
        destinationDirectory: z.string().default(""),
        overwrite: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return ok(await extractZipArchive(input));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "get_canvas",
    {
      title: "Get Obsidian Canvas",
      description: "Read and validate a JSON Canvas .canvas file.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const abs = resolveCanvasPath(path);
        const canvas = JSON.parse(await readLimitedText(abs));
        if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) throw new Error("Invalid JSON Canvas: expected nodes[] and edges[]");
        return ok({ path: toVaultPath(abs), canvas, revision: await fileRevision(abs), summary: { nodes: canvas.nodes.length, edges: canvas.edges.length, fileNodes: canvas.nodes.filter((node) => node.type === "file").map((node) => ({ id: node.id, file: node.file, subpath: node.subpath })) } });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "write_canvas",
    {
      title: "Write Obsidian Canvas",
      description: "Create or overwrite a JSON Canvas .canvas file.",
      inputSchema: {
        path: z.string().min(1),
        canvas: z.object({ nodes: z.array(z.record(z.string(), z.unknown())), edges: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
        overwrite: z.boolean().default(false),
        ifMatch: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, canvas, overwrite, ifMatch }) => {
      try {
        assertWritable();
        const abs = resolveCanvasPath(path);
        const existed = await exists(abs);
        if (existed && !overwrite) throw new Error("Canvas already exists. Set overwrite=true to replace it.");
        const previousSize = existed ? (await fs.stat(abs)).size : 0;
        const written = await atomicWriteFile(abs, `${JSON.stringify(canvas, null, 2)}\n`, { encoding: "utf-8", ifMatch });
        return ok({ path: toVaultPath(abs), created: !existed, previousSizeInBytes: previousSize, currentSizeInBytes: written.stat.size, revision: written.revision });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    "manage_folders",
    {
      title: "Manage Obsidian Folders",
      description: "List, create, or delete vault folders.",
      inputSchema: {
        folder: z.string().default(""),
        action: z.enum(["list", "create", "delete"]).default("list"),
        recursiveDelete: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ folder, action, recursiveDelete }) => {
      try {
        const abs = resolveVaultPath(folder || "");
        if (action === "list") return ok({ folder: toVaultPath(abs), entries: await walk(abs, { recursive: false, includeDirectories: true, extension: "*" }) });
        assertWritable();
        if (action === "create") {
          await ensureVaultParent(path.join(abs, ".obsidian-mcp-placeholder"));
          await fs.mkdir(abs, { recursive: true });
          return ok({ created: toVaultPath(abs) });
        }
        assertNotVaultRoot(abs);
        const stat = await fs.stat(abs);
        if (!stat.isDirectory()) throw new Error("Folder operation requires a directory path");
        await fs.rm(abs, { recursive: recursiveDelete, force: false });
        trackGitMutation(toVaultPath(abs));
        return ok({ deleted: toVaultPath(abs), recursive: recursiveDelete });
      } catch (error) {
        return err(error);
      }
    },
  );
}
