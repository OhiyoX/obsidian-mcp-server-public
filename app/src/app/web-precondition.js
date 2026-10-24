// The Web write faces' precondition reader and the one "you sent none" answer (#624).
//
// Every Web write surface that can overwrite an existing document needs a revision
// precondition (CAS). Two faces used to disagree about the *refusal* for a missing
// one: `PATCH /api/web/v1/base` answered 428 `precondition-required`, while
// `POST /api/web/v1/note` let `Existing notes require a revision` reach the shared
// classifier, which turned it into a 409 — the same meaning with a different status
// and a different body. The three rows are now one table for both faces:
//
//   missing precondition + target exists -> 428 precondition-required (this module)
//   precondition does not match (stale)  -> 409 + the revision on disk (domain code)
//   no precondition + target missing     -> created, unchanged
//
// `readPrecondition` is the single token reader (it used to be a private copy inside
// `base-patch-route.js`): the `If-Match` header wins over the body's `ifMatch`, the
// header's quoted form (`"sha256:..."`, what the read faces issue as `ETag`) and a
// weak prefix are unwrapped, and only an empty/absent value means "none". Anything
// else — including `*` — is returned as the literal token: `*` keeps the A4b base
// face's "must exist, skip the revision compare" meaning there, and stays a plain
// (non-matching, hence conflicting) token on the note face, which never had `*`
// semantics. Widening that is a separate decision, not a side effect of this one.

/**
 * The frozen missing-precondition answer. Both faces build it here so their bodies
 * cannot drift apart again: same key set (`error`, `code`, `message`) and the same
 * `code` value; only the route name and the optional detail differ.
 */
export function preconditionRequiredBody(routeName, detail = null) {
  const base = `${routeName} requires If-Match (or body ifMatch)`;
  return {
    error: "precondition-required",
    code: "precondition-required",
    message: detail ? `${base}: ${detail}` : base,
  };
}

/**
 * `If-Match` header wins over the body's `ifMatch` (`If-Match` literal accepted
 * too). Anything but one token is refused downstream as a mismatch; only RFC's `*`
 * ("any current representation") gets special treatment: it skips the revision
 * comparison, and the reader's path gate still answers 404 when the file is gone,
 * so `*` can never turn an update endpoint into a create.
 *
 * @returns {string|null} `null` when the caller sent no precondition at all.
 */
export function readPrecondition(req) {
  const header = req.get("If-Match");
  const body = req.body?.ifMatch ?? req.body?.["If-Match"];
  const supplied = header !== undefined && header !== null && String(header).trim() !== "" ? header : body;
  if (supplied === undefined || supplied === null || String(supplied).trim() === "") return null;
  const value = String(supplied).trim();
  if (value === "*") return "*";
  return value.replace(/^W\//i, "").replace(/^"([\s\S]*)"$/, "$1");
}
