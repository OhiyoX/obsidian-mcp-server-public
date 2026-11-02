// P1 (#630) — the `create_base_entry` face: `base:create` (`@3158532`) as an MCP write
// tool. Create the note the view is looking for, then prove the view can find it again.
//
// Extracted from `tools/workflows.js`, which had reached its line budget: the pure
// decisions (folder + property derivation, the queryability pre-check) live in
// `src/base-create.js`, the wire shape of the *other* Base write face lives in
// `src/base-patch-face.js`, and this module holds only what is specific to this tool —
// its descriptor, its template read, its error vocabulary and its handler. The
// registration itself stays in `tools/workflows.js`.
//
// Desktop authority, verbatim offsets and the recorded divergences: lane HANDOFF.md.

import { z } from "zod/v4";

import {
  BASE_CREATE_ERROR_CODES,
  BASE_CREATE_WARNING_CODES,
  assertEntryQueryable,
  resolveEntryTarget,
  syntheticBaseRecord,
} from "./base-create.js";
import { bytesRevision, patchBaseError } from "./base-patch-face.js";
import { compileBaseView, parseAndValidateBase } from "./base-query.js";
import { readNote, writeNoteFile } from "./obsidian.js";
import { err, errStructured, ok } from "./result.js";
import { assertWritable, exists } from "./vault-runtime/request-vault.js";
import { refusalForError, resolveWorkflowRuntime } from "./workflow-runtimes.js";

// Shared with the sibling Base faces (`get_base` / `write_base` / `patch_base` /
// `query_base`, which import it from here): a bare name addresses the `.base` sibling.
export function basePath(inputPath) {
  return inputPath.toLowerCase().endsWith(".base") ? inputPath : `${inputPath}.base`;
}

// The `newItemTemplate` half of the desktop UI contract (`open()` `@2454600`): the
// declared note contributes its PARENT FOLDER (only as the folder fallback, i.e. when
// `newItemFolder` is empty) and its FRONTMATTER, which REPLACES the filter-derived
// defaults. Its body is not copied (`createNewFile(folder, <editor content>)`). A
// declared-but-missing file is the desktop's silent fallback to the filter-derived
// defaults; here it is reported as a warning instead of being hidden.
//
// Divergence, recorded in the lane HANDOFF.md: the desktop *CLI* (`base:create`
// `@3158532`) never reads `newItemTemplate` — only the UI button does. This face
// implements the UI path, because that is the behaviour a user sees in Obsidian.
async function readBaseEntryTemplate(localFs, base, warnings) {
  const declared = typeof base?.newItemTemplate === "string" ? base.newItemTemplate.trim() : "";
  if (!declared) return null;
  const relative = declared.toLowerCase().endsWith(".md") ? declared : `${declared}.md`;
  const abs = localFs.resolveVaultPath(relative);
  if (!(await exists(abs))) {
    warnings.push(BASE_CREATE_WARNING_CODES.TEMPLATE_UNRESOLVED);
    return null;
  }
  const note = await readNote(abs);
  const vaultPath = localFs.toVaultPath(abs);
  const slash = vaultPath.lastIndexOf("/");
  return { folder: slash === -1 ? "" : vaultPath.slice(0, slash), frontmatter: note.frontmatter };
}

// The codes this face keeps on the wire (`errStructured` shape, A6). Everything else — a
// missing `.base` (`ENOENT`), a symlinked parent that escapes the Vault, a read-only
// session — keeps the historical `err()` prose, exactly like the Base write faces next
// to it. `localFs.atomicWriteFile` has no create-exclusive mode (its `ifMatch` branch
// REQUIRES the file to exist, `vault-runtime/local-fs.js` @237), so the create-only
// guarantee is the pre-write existence check in the handler; a raw `EEXIST` is mapped
// defensively to the same conflict code in case an fs layer ever surfaces one.
export function normalizeBaseCreateError(error) {
  if (error?.code === "EEXIST") {
    return patchBaseError(
      BASE_CREATE_ERROR_CODES.EXISTS,
      "An entry already exists at the target path (EEXIST): create_base_entry never overwrites an existing note.",
    );
  }
  return error;
}

export const BASE_CREATE_WIRE_CODES = new Set([
  ...Object.values(BASE_CREATE_ERROR_CODES),
  "revision-conflict",
  "invalid-yaml",
  "invalid-schema",
  "view-not-found",
  "unsupported",
]);

export const CREATE_BASE_ENTRY_TOOL = Object.freeze({
  title: "Create Obsidian Base Entry",
  description:
    "Create the note a Base view is looking for, and refuse to create one it would not show. The target folder and the frontmatter defaults are derived from the .base itself, exactly like the desktop's `base:create`/\"New\" button: `newItemFolder`, then a `newItemTemplate` note's parent folder and frontmatter, then the folder implied by the view's own filters (`file.folder == \"X\"` / `file.inFolder(\"X\")`), then the .base file's own folder; properties come from the view's readable filter rules (`note.<prop> ==|>=|<= <literal>`, `note.<prop>.isEmpty()`, `file.hasTag(x)`, `file.hasProperty(x)`) plus every `order` key as present-but-null. `values` overrides those defaults. `file` is the new note's path RELATIVE TO THE DERIVED FOLDER (desktop composes `folder + name`), default \"Untitled.md\"; an existing target is refused with `entry-exists` and never overwritten, and a traversal/absolute `file` with `entry-path-invalid`. Before writing anything, the planned record is evaluated with the same view evaluator `query_base` uses: if the view's filters would not return it, the call fails with `entry-not-queryable` and nothing is written; a view configuration this query subset cannot evaluate reports `query-precheck-inconclusive` in `warnings` instead of claiming the entry is queryable. The .base document is never modified.",
  // `ifMatch` is optional because this tool does not write the .base — but when given it
  // is a hard precondition, refused with the same `revision-conflict` code `patch_base`
  // uses (A4b's 409), read from the same one-read bytes.
  inputSchema: {
    path: z.string().min(1),
    view: z.string().optional(),
    file: z.string().optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    ifMatch: z.string().min(1).optional(),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
});

export async function createBaseEntryHandler({ path: inputPath, view: viewName, file, values, ifMatch }) {
  try {
    assertWritable();
    const precondition = typeof ifMatch === "string" ? ifMatch.trim() : "";
    const { index, localFs } = resolveWorkflowRuntime();
    const baseAbs = localFs.resolveVaultPath(basePath(inputPath));
    // One read, two views: the revision the precondition addresses and the document
    // the entry is planned against are the same version.
    const baseBytes = await localFs.readLimitedBuffer(baseAbs);
    const currentRevision = bytesRevision(baseBytes);
    if (precondition && precondition !== currentRevision) {
      throw patchBaseError("revision-conflict", `Revision conflict: expected ${precondition}, current ${currentRevision}`, {
        expectedRevision: precondition,
        currentRevision: currentRevision,
      });
    }
    const { base } = parseAndValidateBase(baseBytes.toString("utf8"));
    const warnings = [];
    const template = await readBaseEntryTemplate(localFs, base, warnings);
    // The compiled view (not its name) is what the derivation reads; an unknown view
    // name is the Base domain's own `view-not-found` refusal.
    const { view, viewName: selectedViewName } = compileBaseView(base, viewName);
    const target = resolveEntryTarget({ base, view, template, baseFile: localFs.toVaultPath(baseAbs), file });
    // Caller `values` win over the derived/template defaults: the desktop has no such
    // input (its CLI writes the derived frontmatter verbatim), so this merge order is
    // this face's own contract — and it is what makes a template that does not satisfy
    // the view repairable in the same call.
    const frontmatter = { ...(template ? template.frontmatter : target.derived.frontmatter), ...(values ?? {}) };
    // Issue #630 hard requirement: decide findability BEFORE writing. The record fed to
    // the evaluation is the shape the Vault index produces for the bytes about to be
    // written, so this decision and `query_base` cannot disagree.
    const record = syntheticBaseRecord({ path: target.path, frontmatter });
    assertEntryQueryable({ base, viewName: selectedViewName, record, warnings });
    const targetAbs = localFs.resolveVaultPath(target.path);
    if (await exists(targetAbs)) {
      throw patchBaseError(
        BASE_CREATE_ERROR_CODES.EXISTS,
        `An entry already exists at ${target.path}: create_base_entry never overwrites an existing note. Choose another file, or edit it with patch_note.`,
        { path: target.path },
      );
    }
    const written = await writeNoteFile(targetAbs, frontmatter, "");
    // The new note must be visible to the very index `query_base` reads, and a create
    // cannot have been indexed before it existed (`create_from_template` invalidates the
    // same way after its write).
    index.invalidate(target.path);
    return ok({
      path: target.path,
      basePath: localFs.toVaultPath(baseAbs),
      view: selectedViewName,
      folderSource: target.folderSource,
      created: true,
      size: written.stat.size,
      revision: written.revision,
      frontmatter,
      warnings,
    });
  } catch (error) {
    const normalized = normalizeBaseCreateError(error);
    if (BASE_CREATE_WIRE_CODES.has(normalized?.code)) return errStructured(normalized);
    return refusalForError(normalized) ?? err(normalized);
  }
}
