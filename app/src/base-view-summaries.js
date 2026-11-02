// A2 — `list_base_views`: the agent-facing "look at the views before querying"
// selector for Obsidian Bases.
//
// Desktop authority (read from `obsidian-asar-1.4.4/app.js`, read-only; the byte
// offsets are the ones already reconciled in `MCP-AGENT-SURFACE-GAP.md`):
//   * `base:views` CLI (@3242395) prints one `name\ttype` line per declared view
//     and the literal string `No views defined.` for a Base with no views. Its
//     *only* inputs are the active file, i.e. it has no `file:`/`path:`/`view:`
//     parameters (`base:query` and `base:create` do).
//   * the desktop view-config parser (@2361900..2365100) whitelists the view
//     keys `type name filters groupBy groupOrder summaries order sort limit`
//     (`RECON.md` §1.5) and preserves every unrecognized key in
//     `unrecognizedData` (@2352141/@2352326) — so a view config can carry keys
//     this server does not model.
//
// Therefore the desktop-verified part of the A2 contract is exactly
// `{ name, type }` per view; `filters` / `sort` / `limit` / `groupBy` /
// `summaries` are named below because the desktop view-key whitelist contains
// them (the *shape* of each value is passed through verbatim, never re-typed by
// this module), and `isDefault` / `defaultView` are an MCP-side design choice —
// `defaultView` names the view `query_base` selects when `view` is omitted
// (`base-query.js` `compileBaseView`: `base.views[0]`), which is NOT a desktop
// concept. Both are recorded as `desktop-unverified` in HANDOFF.md.
//
// Hard constraints this module implements:
//   * no YAML body and no row data leaves the tool — the summary is built from
//     the parsed document and carries only the frozen field vocabulary below;
//   * fail closed on a non-`.base` input instead of silently appending `.base`
//     to, say, `Notes.md` (the sibling `basePath()` helper does that; A2 does
//     not, because the resulting `ENOENT` hides the real caller mistake);
//   * errors stay structured: `BaseViewsError.code` joins the existing
//     `BaseQueryError.code` vocabulary family and is surfaced through
//     `result.js`'s `errStructured` (A6 shape).
//
// Pure module: no fs / path / express / MCP imports, no process state, no I/O.
// Reading the document is the handler's job (`base-reader` semantics: Vault-root
// confinement + symbolic-link refusal live in `vault-runtime/local-fs.js`).

// Output vocabulary, in wire order. Tests assert that a view summary never
// carries a key outside this list ("strict" on the fields we emit).
export const BASE_VIEW_SUMMARY_FIELDS = Object.freeze([
  "name",
  "type",
  "filters",
  "sort",
  "limit",
  "groupBy",
  "summaries",
  "isDefault",
]);

// The subset copied verbatim from the declared view when it is *declared*
// (see `isDeclaredViewValue`). `name` / `type` / `isDefault` are normalized.
export const BASE_VIEW_PASSTHROUGH_FIELDS = Object.freeze([
  "filters",
  "sort",
  "limit",
  "groupBy",
  "summaries",
]);

// A2-local error vocabulary. Two of the three are pure input facts; the third
// (`path-outside-vault`) is the code this lane attaches to the Vault runtime's
// own refusals (which are message-only `Error`s — see `mapBaseViewsError`).
export const BASE_VIEWS_ERROR_CODES = Object.freeze({
  NOT_A_BASE: "not-a-base",
  NOT_FOUND: "base-not-found",
  OUTSIDE_VAULT: "path-outside-vault",
});

// Extensions that name a *different* Obsidian document kind. `config.js`
// TEXT_FILE_EXTENSIONS is the source of this list; only these are rejected, so
// a dotted Base name (`My.Board` -> `My.Board.base`) still resolves.
export const NON_BASE_EXTENSIONS = Object.freeze([
  ".md",
  ".canvas",
  ".json",
  ".txt",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".html",
  ".xml",
]);

export class BaseViewsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BaseViewsError";
    this.code = code;
  }
}

/**
 * Vault-relative `.base` path for a caller-supplied input, or a fail-closed
 * `not-a-base` error. Deliberately pure: it resolves no filesystem state, so an
 * invalid input never triggers a Vault read.
 *
 * @param {unknown} inputPath
 * @returns {string} vault-relative path ending in `.base`
 * @throws {BaseViewsError} code `not-a-base`
 */
export function normalizeBaseInputPath(inputPath) {
  const value = typeof inputPath === "string" ? inputPath.trim() : "";
  if (!value) throw new BaseViewsError("A Base path is required (e.g. \"Boards/Tasks.base\")", BASE_VIEWS_ERROR_CODES.NOT_A_BASE);
  if (/\.base$/i.test(value)) return value;
  const extension = /(\.[A-Za-z0-9]+)$/.exec(value);
  if (extension && NON_BASE_EXTENSIONS.includes(extension[1].toLowerCase())) {
    throw new BaseViewsError(`Not a .base file: ${value} (expected a .base path)`, BASE_VIEWS_ERROR_CODES.NOT_A_BASE);
  }
  return `${value}.base`;
}

// Declaration-freeze rule, identical to `base-query.js`
// `isDeclaredSemanticValue` (+ the `""` case): `null`, `undefined`, `""`, `[]`
// and `{}` are treated as absent so the summary never reports a key the author
// did not actually declare.
function isDeclaredViewValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// The parsed document is the YAML load result, which can hold `Date` scalars;
// `structuredClone` keeps values intact (a JSON round trip would not) while
// still detaching the summary from the parsed object graph.
function cloneDeclaredValue(value) {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Reduce a parsed Base document to the A2 selector payload.
 *
 * @param {unknown} base parsed `.base` document (already schema-validated by the caller)
 * @returns {{views: Array<object>, defaultView: string|null}}
 */
export function summarizeBaseViews(base) {
  const declared = Array.isArray(base?.views) ? base.views : [];
  const views = declared.map((view, index) => {
    const summary = {
      name: typeof view?.name === "string" ? view.name : null,
      type: typeof view?.type === "string" ? view.type : null,
    };
    // Fixed iteration order => deterministic key order on the wire.
    for (const field of BASE_VIEW_PASSTHROUGH_FIELDS) {
      if (isDeclaredViewValue(view?.[field])) summary[field] = cloneDeclaredValue(view[field]);
    }
    summary.isDefault = index === 0;
    return summary;
  });
  return {
    views,
    defaultView: views.length > 0 ? views[0].name : null,
  };
}

// The message-only refusals `vault-runtime/local-fs.js` raises (no `code` on any
// of them): `assertInsideRoot` -> "Path traversal denied"; `assertCanonicalInsideRoot`
// -> "Symbolic link escapes the vault"; `normalizeVaultInput` -> "Vault paths are
// vault-relative; Windows absolute and UNC paths are not accepted". They are matched
// here *only* to attach a stable machine code for the client; the runtime error itself
// stays the authority for the refusal. Recorded as an explicitly coupled mapping in
// HANDOFF.md. Note the pinned `local-fs` semantics: a POSIX-absolute input like
// `/etc/x.base` is a *vault-relative* path (`etc/x.base`) — the leading slash is stripped
// by design, so that case is a `base-not-found`, not an escape.
const REFUSAL_PATTERNS = Object.freeze([
  [BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT, /Path traversal denied/],
  [BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT, /Symbolic link escapes/],
  [BASE_VIEWS_ERROR_CODES.OUTSIDE_VAULT, /Vault paths are vault-relative/],
]);

/**
 * Map a handler error onto the A2 structured-error vocabulary. Errors that this
 * lane does not own (a `BaseQueryError`, the Vault-scope refusal, a size guard)
 * are returned unchanged so their own code/refusal shape survives; only the
 * message-only filesystem facts get a code, and their messages are rebuilt from
 * the caller's *Vault-relative* path so no absolute path can leak.
 *
 * @param {unknown} error
 * @param {{path?: string}} [context] caller-supplied path (never an absolute path)
 * @returns {Error}
 */
export function mapBaseViewsError(error, { path: relativePath } = {}) {
  if (error instanceof BaseViewsError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const shown = typeof relativePath === "string" && relativePath.trim() ? relativePath.trim() : "the requested path";
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return new BaseViewsError(`Base not found: ${shown}`, BASE_VIEWS_ERROR_CODES.NOT_FOUND);
  }
  for (const [code, pattern] of REFUSAL_PATTERNS) {
    if (pattern.test(message)) return new BaseViewsError(`Refusing to read outside the Vault: ${shown}`, code);
  }
  return error instanceof Error ? error : new Error(message);
}
