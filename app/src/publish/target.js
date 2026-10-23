// `src/publish/target.js` — the authoritative Publish target gate (#278).
//
// Publish is Markdown-only: a Publish record may only point at an existing regular
// `.md` file inside the Vault. This module owns that decision once, as a small
// domain helper, so Web routes, MCP tools and `PublishService` cannot drift into
// three different whitelists (contract §6 "PublishService 是最终权威 gate", §16).
//
// Boundaries (contract §4 / §6 / §15):
//   * path/stat only — no content read, no MIME sniffing, no extension allowlist
//     widening (`.md` and its case variants, nothing else);
//   * no import of `publish/service.js`, Web routes or MCP tools, and no `node:fs`
//     import at all: the module stays deterministic and IO-free, the caller injects
//     the canonical Vault resolver and the stat probe;
//   * canonical Vault path resolution keeps its single implementation —
//     `resolveWebVaultPath(..., { assumeMarkdown: true })` (vault-registry.js) —
//     which is Web-heavy, so it is injected rather than imported (brief §1).
//
// Every rejection is a `PublishTargetError` with a stable `code`: contract §7 makes
// the code, not the prose, the cross-surface contract.

import path from "node:path";
import { MAX_READ_BYTES } from "../config.js";

export const MARKDOWN_EXTENSION = ".md";

// Contract §7 domain codes (Web: unsupported → 400, missing/not-a-file → 404,
// too-large → 413, invalid path → 400). B1/C map these; nothing here guesses HTTP.
export const UNSUPPORTED_PUBLISH_TARGET = "unsupported_publish_target";
export const INVALID_PUBLISH_TARGET_PATH = "invalid_publish_target_path";
export const PUBLISH_TARGET_MISSING = "publish_target_missing";
export const PUBLISH_TARGET_NOT_A_FILE = "publish_target_not_a_file";
export const PUBLISH_TARGET_TOO_LARGE = "publish_target_too_large";

export const PUBLISH_TARGET_ERROR_CODES = Object.freeze([
  UNSUPPORTED_PUBLISH_TARGET,
  INVALID_PUBLISH_TARGET_PATH,
  PUBLISH_TARGET_MISSING,
  PUBLISH_TARGET_NOT_A_FILE,
  PUBLISH_TARGET_TOO_LARGE,
]);

export class PublishTargetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PublishTargetError";
    this.code = code;
    this.path = details.path ?? null;
    if (details.size !== undefined) this.size = details.size;
    if (details.maxBytes !== undefined) this.maxBytes = details.maxBytes;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

// Domain-error probe for surface adapters that must not leak raw IO errors.
export function isPublishTargetError(error) {
  return error instanceof PublishTargetError
    || PUBLISH_TARGET_ERROR_CODES.includes(error?.code);
}

// §6 rule 3/5: the extension is compared case-insensitively, so `.MD`/`.Md` are
// Markdown. Extension *content* is never matched (`x.mdx`, `x.mdown` are not .md).
export function isMarkdownTargetPath(canonicalPath) {
  return path.posix.extname(String(canonicalPath ?? "")).toLowerCase() === MARKDOWN_EXTENSION;
}

// §6 rule 3/6 — the sync, pure gate. `canonicalPath` must already come from
// `normalizePublishTarget`; the shape checks here are defence in depth so a
// sloppy resolver still cannot publish outside the Vault or above a bare path
// (invariant §15-S02).
export function assertPublishableMarkdownPath(canonicalPath) {
  const value = String(canonicalPath ?? "");
  const invalid = invalidCanonicalReason(value);
  if (invalid) throw new PublishTargetError(INVALID_PUBLISH_TARGET_PATH, invalid, { path: value || null });
  if (!isMarkdownTargetPath(value)) {
    throw new PublishTargetError(
      UNSUPPORTED_PUBLISH_TARGET,
      `Publish target must be a Markdown (.md) file: ${value}`,
      { path: value },
    );
  }
  return value;
}

// §6 rule 1/2 — canonicalize through the existing Vault resolution, then hand the
// canonical Markdown path to the caller. `resolvePath` is injected (e.g.
// `resolveWebVaultPath.bind(null, vault)`) and receives the already
// `.md`-completed path plus `{ assumeMarkdown: true }`:
//   * the trailing `.md` is added here, mirroring `vault-registry.js`'s
//     `assumeMarkdown` semantics exactly, so the resolved `absolute` and the
//     returned `path` can never disagree;
//   * passing `assumeMarkdown: true` as well keeps the existing resolver the sole
//     owner of that rule when the path is used directly.
// Returns `{ path, absolute }` (`absolute` is `null` when the resolver answers with
// a bare string). The extension gate is deliberately NOT applied here, so callers
// that must canonicalize a missing target (revoke) can do so.
export async function normalizePublishTarget(userPath, { resolvePath } = {}) {
  if (typeof resolvePath !== "function") {
    throw new TypeError("normalizePublishTarget requires an injected canonical resolver ({ resolvePath })");
  }
  const requested = String(userPath ?? "").trim();
  const invalid = invalidInputReason(requested);
  if (invalid) throw new PublishTargetError(INVALID_PUBLISH_TARGET_PATH, invalid, { path: requested || null });

  const requestedPath = assumeMarkdownTarget(requested);
  let resolved;
  try {
    resolved = await resolvePath(requestedPath, { assumeMarkdown: true });
  } catch (error) {
    if (isPublishTargetError(error)) throw error;
    // ENOENT is the only resolver failure that means "no such target"; every other
    // refusal (escape, refusal to normalize) is an invalid path (§15-S02). The
    // original error stays reachable via `cause`.
    if (error?.code === "ENOENT") {
      throw new PublishTargetError(PUBLISH_TARGET_MISSING, `Publish target not found: ${requestedPath}`, { path: requestedPath, cause: error });
    }
    throw new PublishTargetError(INVALID_PUBLISH_TARGET_PATH, `Invalid Vault path: ${requested}`, { path: requested, cause: error });
  }

  const canonical = typeof resolved === "string" ? resolved : resolved?.path;
  const absolute = typeof resolved === "string" ? null : (resolved?.absolute ?? null);
  const canonicalPath = assertCanonicalTargetPath(canonical);
  return Object.freeze({ path: canonicalPath, absolute });
}

// §6 + §12.2 existence/size half of the gate. Called with a user path (then it
// normalizes first) or with an already-normalized `{ path, absolute }`.
//   stat: async ({ path, absolute }) => { isFile: boolean, size?: number } | null
// `null`/`undefined` means "target does not exist". `maxBytes` defaults to the real
// Web read limit (`config.js`), so the Publish gate and the reader cannot disagree.
export async function assertPublishableTarget(target, { resolvePath, stat, maxBytes = MAX_READ_BYTES } = {}) {
  if (typeof stat !== "function") {
    throw new TypeError("assertPublishableTarget requires an injected stat probe ({ stat })");
  }
  const normalized = typeof target === "string" || target === null || target === undefined
    ? await normalizePublishTarget(target, { resolvePath })
    : target;
  const canonicalPath = assertPublishableMarkdownPath(normalized?.path);
  const absolute = normalized?.absolute ?? null;

  const info = await stat(Object.freeze({ path: canonicalPath, absolute }));
  if (!info) throw new PublishTargetError(PUBLISH_TARGET_MISSING, `Publish target not found: ${canonicalPath}`, { path: canonicalPath });
  if (info.isFile !== true) {
    throw new PublishTargetError(PUBLISH_TARGET_NOT_A_FILE, `Publish target is not a regular file: ${canonicalPath}`, { path: canonicalPath });
  }
  const size = Number(info.size);
  if (Number.isFinite(maxBytes) && Number.isFinite(size) && size > maxBytes) {
    throw new PublishTargetError(
      PUBLISH_TARGET_TOO_LARGE,
      `Publish target exceeds the ${maxBytes}-byte Publish limit: ${canonicalPath}`,
      { path: canonicalPath, size, maxBytes },
    );
  }
  return Object.freeze({ path: canonicalPath, absolute, size: Number.isFinite(size) ? size : null });
}

// --- internals -------------------------------------------------------------------

// Mirrors `resolveWebVaultPath`'s `assumeMarkdown` rule (vault-registry.js):
// `if (assumeMarkdown && normalized && !path.posix.extname(normalized)) normalized += ".md"`.
function assumeMarkdownTarget(userPath) {
  return path.posix.extname(userPath) ? userPath : userPath + MARKDOWN_EXTENSION;
}

// Refusals applied before resolution: a Publish target is a Vault-relative path.
// (The generic note resolver silently folds absolute input into the Vault — e.g.
// "/etc/passwd" → "etc/passwd" — which is not acceptable for a public Publish id.)
function invalidInputReason(value) {
  if (!value) return "Publish target path is required";
  if (value.includes("\0")) return "Publish target path must not contain NUL";
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return "Publish target path must be Vault-relative";
  }
  return null;
}

function invalidCanonicalReason(value) {
  if (!value.trim()) return "Canonical Publish target path is required";
  if (value !== value.trim()) return "Canonical Publish target path must not be padded with whitespace";
  if (value.includes("\0")) return "Canonical Publish target path must not contain NUL";
  if (value.includes("\\")) return "Canonical Publish target path must use forward slashes";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "Canonical Publish target path must be Vault-relative";
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "Canonical Publish target path must not escape or collapse the Vault";
  }
  return null;
}

function assertCanonicalTargetPath(canonical) {
  const value = typeof canonical === "string" ? canonical : "";
  const invalid = invalidCanonicalReason(value);
  if (invalid) throw new PublishTargetError(INVALID_PUBLISH_TARGET_PATH, invalid, { path: value || null });
  return value;
}
