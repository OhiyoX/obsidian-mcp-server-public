// Web write surface A4b — the `.base` increment endpoint (`WRITE-SURFACE-DESIGN.md`
// §2.2 endpoint shape, §3.1 middleware chain, §3.2 capability, §4 CAS, §5.3 sizes).
//
// Registers exactly two handlers:
//
//   GET   /api/web/v1/base/raw?path=<vault-rel>
//     -> 200 `{ vaultId, path, content, revision, stat, route }` with
//        `ETag: "<revision>"`, `Cache-Control: private, no-cache`, 304 on `If-None-Match`
//     -> 400 invalid-path / 401 / 403 / 404 base-not-found / 413 base-too-large
//   PATCH /api/web/v1/base
//     -> body `{ path, mutations: [...], ifMatch?, mutationId? }`, header `If-Match` wins;
//        `If-Match: *` = "must exist", no revision compare
//     -> 200 `{ vaultId, path, changed, revision, previousRevision, size, route }`
//     -> 400 invalid-path / invalid-schema, 401, 403 (scope / read-only), 404,
//        409 revision-conflict, 413 base-too-large / mutations-too-large,
//        422 base-not-patchable / base-unknown-key / invalid-yaml, 428
//        precondition-required
//
// `mutations` is bounded per request by the design's amplification budget (§4.4/§5.3:
// 512 entries / 256 KB, `assertMutationBudget`) — checked here before the domain call
// and again inside the mutation face, because one increment costs O(document bytes ×
// mutations) of synchronous CPU.
//
// ── why `/base/raw` is its own endpoint ──────────────────────────────────────
// `GET /api/web/v1/base` already serves the frozen A3 query DTO (rows/columns/
// catalog, `Cache-Control: no-store`, RECON 刀2 freeze). The write face needs the
// document bytes and a CAS token, i.e. a different representation of the same file;
// folding it into that DTO would put a mutable read contract and a frozen query
// contract on one route. So the raw view is a separate, explicitly named endpoint
// and the frozen DTO is untouched.
//
// ── the middleware chain is the `POST /api/web/v1/note` chain (§3.1) ─────────
//   express.json → requireApi → requireCsrf → writeGate → obsidian.write →
//   assertWritable → currentVault → withRequestContext({author}) → domain →
//   publishWebMutation → provider.recordAudit
// The PATCH handler deliberately does NOT sit behind `readGate`/`requireWebRead`
// (§3.2): its policy gate is `writeGate`, and the scope check is the write class.
//
// ── capability: the existing `write` class, not a new one (§3.4 方案 A) ──────
// The Web policy plane knows exactly three capability classes
// (`access-policy.js` WEB_CAPABILITIES: read `[obsidian.read]`, write
// `[obsidian.read, obsidian.write]`, files `[obsidian.read, obsidian.files]`), and
// there is no per-route needs table in the frozen vocabulary (§3.4: `scope:` has
// only read/write/files). So this endpoint uses `writeGate` + the `obsidian.write`
// scope — identical to `POST /api/web/v1/note`, `/folder`, `/asset` — and no second
// permission model is invented. A narrower "edit Bases but not notes" scope would
// require expanding the frozen scope vocabulary (方案 B, owner decision), not a
// private check here.
//
// No SSE event type is added: the successful patch reuses `publishWebMutation`'s
// existing `note.changed` shape with the same fields the note route sends.
import express from "express";
import { MAX_READ_BYTES } from "../config.js";
import { assertMutationBudget } from "../base-patch-budget.js";
import { encodeDocumentRoute } from "../publish/service.js";
import { withRequestContext } from "../request-context.js";
import { assertWritable } from "../vault.js";
import { readBaseInRoot } from "./base-reader.js";
import { preconditionRequiredBody, readPrecondition } from "./web-precondition.js";

const passThrough = (_req, _res, next) => next();

// §5.3: the request body is an increment, so the write budget is the Web editor
// budget bounded by the read budget; the *target* document budget stays the
// reader's MAX_READ_BYTES (413 before and after patching).
const MAX_PATCH_BYTES = Math.min(MAX_READ_BYTES, 2 * 1024 * 1024);

const PATH_CODES = new Set(["BASE_PATH_INVALID", "BASE_NOT_FOUND", "BASE_NOT_A_FILE", "BASE_ESCAPE"]);
const PATCH_CODES = new Set(["base-not-patchable", "base-unknown-key", "invalid-yaml"]);
const statDto = (stat) => ({ size: stat.size, mtimeMs: Date.parse(stat.modified), modified: stat.modified });

// Error bodies carry a stable code and a message, never a server path (§9). The
// message is A4a's own (it names the offending view key or the unpatchable region
// and never leaks a filesystem path).
function sendPatchError(res, error) {
  const code = String(error?.code || "");
  const message = error instanceof Error ? error.message : String(error || "");
  if (code === "BASE_REVISION_CONFLICT") {
    return res.status(409).json({
      error: "revision-conflict",
      code,
      path: error.path ?? null,
      expectedRevision: error.expectedRevision ?? null,
      currentRevision: error.currentRevision,
      stat: error.stat,
    });
  }
  if (code === "BASE_TOO_LARGE") return res.status(413).json({ error: "base-too-large", code, message });
  // §4.4 / §5.3 amplification budget: over-limit `mutations` is a **413**, not a 400 —
  // the array is well-formed JSON (400 `invalid-schema` is for a malformed mutation),
  // the request is simply too large to serve, exactly like `BASE_TOO_LARGE` and the
  // `express.json` limit. Both limits (entries, serialized bytes) share this status.
  if (code === "BASE_MUTATIONS_TOO_LARGE") return res.status(413).json({ error: "mutations-too-large", code, message });
  if (PATH_CODES.has(code)) return res.status(404).json({ error: "base-not-found", code, message });
  if (PATCH_CODES.has(code)) return res.status(422).json({ error: code, code, message });
  if (code === "invalid-schema") return res.status(400).json({ error: code, code, message });
  // `assertWritable()` refuses in read-only deployments (`OBSIDIAN_READ_ONLY=1`). That is
  // a designed 403 surface (§3.1), not a server fault: without this branch the refusal
  // falls through to the shared classifier as a 500 + a stack trace in the log. Same
  // detection and body as the existing `POST /api/web/v1/folder` mapping (routes.js:494).
  if (/read-only/i.test(message)) return res.status(403).json({ error: "Server is read-only" });
  if (message === "Vault access denied") return res.status(403).json({ error: "Vault access denied" });
  if (code === "ENOENT") return res.status(404).json({ error: "base-not-found", code });
  return null;
}

export function registerBasePatchRoute(router, deps = {}) {
  const {
    requireApi,
    requireCsrf,
    readGate = passThrough,
    writeGate = passThrough,
    currentVault,
    provider,
    readBase = readBaseInRoot,
    writeBasePatch,
    checkMutationBudget = assertMutationBudget,
    publishMutation = () => null,
    source = () => "unknown",
  } = deps;
  if (typeof writeBasePatch !== "function") throw new Error("registerBasePatchRoute requires writeBasePatch");

  // The write-surface raw view: the document bytes the PATCH endpoint operates on,
  // as a CAS-addressable resource (same ETag/304 shape as `GET /api/web/v1/note`).
  router.get("/api/web/v1/base/raw", requireApi, readGate, async (req, res, next) => {
    try {
      const requested = req.query?.path;
      // A repeated `?path=a&path=b` arrives as an array and must fail closed.
      if (typeof requested !== "string" || requested === "") return res.status(400).json({ error: "invalid-path", code: "invalid-path" });
      const vault = await currentVault(req);
      const base = await readBase(vault, requested);
      const etag = `"${base.revision}"`;
      // Same ETag / 304 shape as `GET /api/web/v1/note`; error responses keep the
      // router's `no-store` because the header is only set once the read succeeded.
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("ETag", etag);
      if (req.get("If-None-Match") === etag) return res.status(304).end();
      res.json({
        vaultId: vault.id,
        path: base.path,
        content: base.raw,
        revision: base.revision,
        stat: statDto(base.stat),
        route: `/app/base/${encodeDocumentRoute(vault.id, base.path)}`,
      });
    } catch (error) {
      const mapped = sendPatchError(res, error);
      if (!mapped) next(error);
    }
  });

  router.patch("/api/web/v1/base", express.json({ limit: `${MAX_PATCH_BYTES}b` }), requireApi, requireCsrf, writeGate, async (req, res, next) => {
    try {
      // Same write pipeline as `POST /api/web/v1/note`: scope -> read-only mode ->
      // Vault from the session (never from the body) -> audit.
      if (!req.webSession.allowedScopes.includes("obsidian.write")) return res.status(403).json({ error: "Account does not have write permission" });
      assertWritable();
      const requested = req.body?.path;
      if (typeof requested !== "string" || requested === "") return res.status(400).json({ error: "invalid-path", code: "invalid-path" });
      // §4.4 budget, checked *before* the domain call: the lock, the document read and
      // the YAML parse never happen for an over-limit increment (the domain re-checks,
      // so a non-HTTP caller is bounded too).
      checkMutationBudget(req.body?.mutations);
      const ifMatch = readPrecondition(req);
      // §4.1: no precondition = refused blind write. The note route answers the same
      // situation with the same 428 body (`readPrecondition` + `preconditionRequiredBody`
      // are shared), so a client never has to special-case the surface (#624).
      if (ifMatch === null) {
        return res.status(428).json(preconditionRequiredBody("PATCH /api/web/v1/base"));
      }
      const vault = await currentVault(req);
      const result = await withRequestContext(
        { author: { agent: "obsidian-web", model: `human:${req.webSession.username}` } },
        () => writeBasePatch(vault, requested, req.body?.mutations, ifMatch),
      );
      // An increment that changed nothing wrote no bytes: no mutation event, and the
      // caller still gets the revision it addressed (§4.4 idempotent retry).
      if (result.changed) {
        publishMutation({
          vaultId: vault.id,
          path: result.path,
          created: false,
          revision: result.revision,
          size: result.size,
          origin: "web",
          mutationId: String(req.body?.mutationId || "web").slice(0, 120),
        });
      }
      provider?.recordAudit?.({
        action: "web.base.patch",
        credentialType: "web-session",
        credentialId: req.webSession.userId,
        source: source(req),
        detail: `${vault.id}:${result.path}`,
      });
      res.json({
        vaultId: vault.id,
        path: result.path,
        changed: result.changed,
        revision: result.revision,
        previousRevision: result.previousRevision,
        size: result.size,
        route: `/app/base/${encodeDocumentRoute(vault.id, result.path)}`,
      });
    } catch (error) {
      const mapped = sendPatchError(res, error);
      if (!mapped) next(error);
    }
  });
}
