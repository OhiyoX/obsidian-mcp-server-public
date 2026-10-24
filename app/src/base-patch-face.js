import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { compileBaseView, parseAndValidateBase } from "./base-query.js";
import { BASE_VIEW_OPTION_KEYS } from "./base-patch.js";
import { assertProvenancePatchable, splitLines } from "./base-patch-lines.js";

export function basePath(inputPath) {
  return inputPath.toLowerCase().endsWith(".base") ? inputPath : `${inputPath}.base`;
}

// ------------------------------------------------------------------- P1 (#629)
//
// `patch_base` — the MCP counterpart of A4b's `PATCH /api/web/v1/base`. Three
// properties are the whole point of the tool and each has one owner module:
//
//   * the increment itself (`patchBaseDocument`, A4a): byte-identical outside the
//     addressed lines, fail-closed on an unaddressable region or an off-whitelist key;
//   * the precondition (CAS): the write only lands when the document still carries the
//     revision the caller addressed, and a missing precondition is its own refusal;
//   * the honest post-write statement: `query_base` serves a *subset* of the Base
//     document language, so the response carries `warnings` instead of implying that
//     the patched document is now queryable.
//
// CAS token definition: the same one the Web write face already uses for its `ETag`
// (`src/app/base-reader.js` -> `sha256:<hex>` over the document bytes) and the same quantity
// `localFs.fileRevision` re-reads inside the write lock. The input is the document's *bytes*,
// never the decoded text: `readLimitedText` decodes with replacement, so on a document holding
// non-UTF-8 bytes the two views hash differently and the caller's `ifMatch` would be refused by
// the in-lock check even though it came from this very server (one definition, one input).
// Content-derived only, so a touched-but-identical file keeps its revision (an mtime token would
// report a conflict that does not exist) and any byte change invalidates it. The write itself
// re-checks the token inside the runtime's mutation lock, so two callers holding the same
// revision can never both succeed.
// Issue #634 (§5.27): the ONE revision definition for a document is `sha256(raw bytes)`.
// `get_base` serves this token and every write face compares against it, so it lives here
// (exported) instead of being re-derived per handler.
export function bytesRevision(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// A4a's increment is line-surgical on *text*, but that text came from a lossy decode: a
// document holding non-UTF-8 bytes decodes to U+FFFD, and re-encoding those characters would
// rewrite bytes the caller never addressed — the one promise this tool makes. So the patched
// text is spliced back into the bytes we read, one line at a time:
//
//   * the original bytes are cut at their 0x0A terminators (no whole-document decode first), so
//     each piece keeps its own `\r\n` / `\n` / missing terminator exactly as written;
//   * a line A4a reports as untouched is copied from those bytes verbatim, illegal ones
//     included. `patchBaseLines` says exactly which lines those are, so this is provenance, not
//     a guess: an addressed line is rewritten from the new value as UTF-8, so an illegal byte
//     *inside* an addressed line does not survive (bounded, and stated in the tool description),
//     and an inserted line (plus any `lead` separator it carries) is new bytes only;
//   * the two views cannot disagree on line count: 0x0A is ASCII, so neither a UTF-8
//     continuation byte nor a lone invalid byte can hide a line break, and every original line
//     index maps onto exactly one byte range;
//   * a written line is only accepted where provenance says it belongs: an in-place replacement
//     in its own slot, or an appended line after the last original one (`assertProvenancePatchable`).
//
// For a valid UTF-8 document every untouched line re-encodes to itself, so the result is
// exactly `Buffer.from(text, "utf8")` — the pre-fix behaviour.
export function splicePatchedBytes(bytes, lines) {
  const rawLines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    rawLines.push(bytes.subarray(start, index + 1));
    start = index + 1;
  }
  if (start < bytes.length) rawLines.push(bytes.subarray(start));
  const parts = lines.map((line) => {
    // `lead` is the separator an appended line had to add itself (the previous line had no
    // terminator); it is new bytes, never a rewrite of the line before it.
    if (line.source === null) return Buffer.from((line.lead ?? "") + line.text + line.eol, "utf8");
    const original = rawLines[line.source];
    // Unreachable while the locator and the decoder agree on the line count; a mismatch would
    // mean the provenance is wrong, so refuse instead of splicing in the wrong bytes.
    if (original === undefined) throw patchBaseError("base-not-patchable", "the patched lines do not line up with the document bytes");
    return original;
  });
  return Buffer.concat(parts);
}

// Decision (BRIEF-FIX-PROVENANCE, R4 NO-GO on `f6da3c44`): the gate is per line, not per count.
// See `assertProvenancePatchable` — it compares each line's origin, not the number of lines, so a
// net-zero "delete k, insert k" edit cannot pass. It only applies to a document whose bytes are
// not valid UTF-8, where the line the locator wrote cannot be re-derived from the lossy decode; a
// valid UTF-8 document keeps the pre-fix behaviour (every untouched line re-encodes to itself).
// The judgement is a *strict* decode: `bytes.toString("utf8")` replaces, so it cannot tell a
// document with illegal bytes from one without.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function isStrictUtf8(bytes) {
  try {
    STRICT_UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function assertProvenanceSpliceable(bytes, raw, lines) {
  if (isStrictUtf8(bytes)) return;
  assertProvenancePatchable(lines, splitLines(raw).length);
}

export function patchBaseError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

// The write whitelist as a strict union: one branch per A4a operation, every field
// required, no `args: any` catch-all and no extra property. `op` is the discriminant so
// the served JSON schema is a closed `oneOf`.
export const BASE_PATCH_MUTATION_SCHEMA = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set-view-option"),
    view: z.string().min(1),
    key: z.enum(BASE_VIEW_OPTION_KEYS),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }).strict(),
  z.object({
    op: z.literal("set-formulas"),
    key: z.string().min(1),
    value: z.union([z.string(), z.null()]),
  }).strict(),
  z.object({
    op: z.literal("set-property-display-name"),
    property: z.string().min(1),
    value: z.string().min(1),
  }).strict(),
]);

// The codes this tool owns on the wire (`errStructured` shape). A4a's own vocabulary
// (`base-not-patchable` / `base-unknown-key`) and the shared Base domain's
// (`invalid-yaml` / `invalid-schema`) are passed through unchanged, so an agent branches on
// the same codes the Web PATCH face answers with.
export const PATCH_BASE_WIRE_CODES = new Set([
  "precondition-required",
  "revision-conflict",
  "mutations-too-large",
  "base-too-large",
  "base-not-patchable",
  "base-unknown-key",
  "invalid-schema",
  "invalid-yaml",
]);

// A4b's 413 code has no HTTP status here, so it is renamed to the surface-neutral
// vocabulary the rest of this tool's codes use; the numbers are unchanged.
export function normalizePatchBaseError(error) {
  if (error?.code === "BASE_MUTATIONS_TOO_LARGE") return patchBaseError("mutations-too-large", error.message);
  if (error?.code === "BASE_TOO_LARGE") return patchBaseError("base-too-large", error.message);
  // `localFs.atomicWriteFile` re-reads the revision inside the mutation lock and refuses
  // with a message-only conflict when another writer landed in between. That is the same
  // refusal as the pre-check, so it gets the same code (and the revision it names).
  const conflict = /^Revision conflict: expected (.*), current (.*)$/.exec(String(error?.message || ""));
  if (conflict) {
    return patchBaseError("revision-conflict", error.message, { expectedRevision: conflict[1], currentRevision: conflict[2] });
  }
  return error;
}

// Issue #629 requirement 6: never claim the patched document is queryable. The write
// whitelist (desktop parity) is wider than the portable query subset, so a `set-formulas`
// increment can produce a document `query_base` must refuse. The probe runs the *same*
// compile step `query_base` runs before it evaluates anything (`parseAndValidateBase` +
// `compileBaseView`, the shared Base domain service — no second validator), and reports
// what it found instead of failing the write: refusing here would silently narrow A4a's
// whitelist. An empty `warnings` array is the only thing that may be read as "queryable".
export function queryAvailabilityWarnings(raw) {
  try {
    const { base } = parseAndValidateBase(raw);
    compileBaseView(base);
    return [];
  } catch (error) {
    return [{
      code: typeof error?.code === "string" && error.code ? error.code : "not-queryable",
      message: `query_base cannot serve this document after the patch: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}
