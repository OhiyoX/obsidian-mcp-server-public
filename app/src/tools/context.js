import { z } from "zod/v4";
import { err, errStructured, ok } from "../result.js";
import { buildNoteContext, buildProjectContext, buildWorkspaceContext, HARD_MAX_OUTPUT_BYTES, OUTPUT_BUDGET_TOO_SMALL } from "../context-service.js";
// Wave D / D-intelligence: the selected Vault's runtime is resolved inside the service; this
// adapter only turns the structured `vault_retrieval_unavailable` refusal into an MCP error
// payload instead of a generic message (fail closed, never the primary Vault).
import { refusalForError } from "../search-runtimes.js";

// Thin MCP adapter over the protocol-neutral ContextService. No retrieval or
// budget logic lives here; see src/context-service.js for the contract.
export function registerContextTools(server) {
  server.registerTool(
    "get_note_context",
    {
      title: "Get Obsidian Note Context",
      inputSchema: {
        path: z.string().min(1).describe("Exact vault-relative note path; no fuzzy or project discovery. With contextScope=project or contextScope=workspace this value is ignored."),
        includeProvenance: z.boolean().default(false).describe("Attach per-item source provenance and index freshness (about 220 bytes per item). Off by default."),
        contextScope: z.enum(["note", "project", "workspace"]).default("note").describe("note (default) answers about the note at path; project answers about the explicit projectRoot only, returning its canonical README, nearby conventions and active TODO items; workspace returns the known convention files directly under workspaceRoot as quoted reference data, never as instructions."),
        projectRoot: z.string().optional().describe("Required for contextScope=project: the vault-relative directory that names the project. The server never guesses it, never scans the whole Vault and never falls back to another project."),
        workspaceRoot: z.string().optional().describe("contextScope=workspace: the vault-relative directory that holds the workspace conventions. Defaults to the operator-configured workspace root. Only the known convention files directly under it are read; nothing in note content can move this root."),
        maxChars: z.number().int().min(1).max(32000).default(12000).describe("Unicode-codepoint budget for Vault-derived text; capped at 32000."),
        maxItems: z.number().int().min(1).max(64).default(20).describe("Maximum variable items (backlinks plus related notes); capped at 64."),
        maxOutputBytes: z.number().int().min(1).max(HARD_MAX_OUTPUT_BYTES).optional().describe("Optional UTF-8 byte budget for the whole serialized structuredContent; when set, optional excerpts/metadata are trimmed first and whole items last, and a budget too small for the envelope is refused."),
        includeBacklinks: z.boolean().default(true).describe("Include bounded backlinks from the existing Vault link index."),
        includeRelated: z.boolean().default(false).describe("Include bounded related notes using the existing ranking."),
        semantic: z.boolean().default(true).describe("Prefer semantic related notes; falls back to deterministic lexical ranking."),
      },
      // Read-only for the Vault, but related retrieval with the default
      // `semantic: true` may call the configured embedding provider
      // (`embedTexts`), so the tool's worst case is open-world even though
      // `includeRelated` defaults to false.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        // No new option: the note path stays byte-identical, because the project and workspace
        // branches are entered only when they are asked for by name.
        if (input.contextScope === "workspace") return ok(await buildWorkspaceContext(input));
        if (input.contextScope === "project") return ok(await buildProjectContext(input));
        return ok(await buildNoteContext(input));
      } catch (error) {
        if (error?.code === OUTPUT_BUDGET_TOO_SMALL) return errStructured(error);
        return refusalForError(error) ?? err(error);
      }
    },
  );
}
