// Issue #470 Wave A — direct HTTP upload: the file bytes flow from the client straight into Node.
//
// Contract: `_Workspace/40-Projects/obsidian_mcp_server/MCP/DEVELOPMENT - Issue 470 大文件 HTTP 直传与
// 可恢复上传` (§1 code facts, §2 protocol, §2.3 authorization order, §3 errors, §5 test matrix) and the
// A0 decisions D1–D8 of the implementation brief. What this module is:
//
//   * CONTROL plane — `start_direct_upload` (MCP tool, registered in `tools/files.js`) creates the
//     durable handle through the SAME per-Vault transfer runtime the base64 chunk tools use, marked
//     `mode: "single-put"`, and answers with metadata only (`uploadId`, `method`, `relativePath`,
//     `expiresAt`, `maxBytes`, `sha256Required`, `mode`). No bytes, no base64, no absolute URL.
//   * DATA plane — `PUT /uploads/:uploadId` takes the raw body, re-verifies the caller's credential,
//     scope, time window, Vault membership and handle state on THIS request (D1: no short-lived
//     capability URL, revocation therefore bites immediately), streams the body into the staged
//     `.part` with backpressure while hashing incrementally, then publishes through the existing
//     `localFs.atomicWriteFile` + receipt path (D5).
//
// Deliberately NOT here: resume / `Content-Range` / offset recovery (Wave B). Wave A claims no resume,
// so an interrupted body is never continued and its length is never treated as success. The legacy
// MCP tools (`start_file_upload`, `upload_file_chunk`, `file_upload_status`, `cancel_file_upload`)
// keep their behaviour and schemas untouched (D2/D6 add one guard: a chunk writer may not touch a
// single-PUT handle).
//
// Reverse proxies (D7): the response carries a RELATIVE path only; nothing is derived from
// `Host` / `X-Forwarded-Host`, so one documented public origin cannot be spoofed into another.
// Audit (D8): `requestId, operation, uploadId(truncated), vaultId, credentialId, decision, durationMs,
// bytes, digest` — never content, base64, tokens, `Authorization`, cookies or full URLs.

import { randomUUID } from "node:crypto";
import express from "express";
import { MAX_TRANSFER_BYTES, TRANSFER_CHUNK_BYTES, TRANSFER_TTL_MS, parseBool, parseBytes, parseInteger } from "./config.js";
import { checkDiskHeadroom, createDirectUploadLimiter, createUploadStreamGuard, DIRECT_UPLOAD_TIMEOUT_CODES } from "./direct-upload-limits.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "./scopes.js";
import { requestContext, withRequestContext } from "./request-context.js";
import { primaryRuntime } from "./vault.js";
import {
  DIRECT_UPLOAD_MODE,
  UPLOAD_DESTINATION_EXISTS,
  UPLOAD_EXPIRED,
  UPLOAD_FAILED,
  UPLOAD_IN_PROGRESS,
  UPLOAD_INTEGRITY_MISMATCH,
  UPLOAD_MODE_CONFLICT,
  UPLOAD_NOT_FOUND,
  UPLOAD_OFFSET_CONFLICT,
  UPLOAD_RANGE_EXCEEDED,
  UPLOAD_TOO_LARGE,
  VAULT_CONTEXT_MISMATCH,
  createTransferRuntime,
} from "./vault-runtime/transfer-runtime.js";
import { capabilitiesForTool } from "./access-policy/capabilities.js";
import { subjectsFromMcpAuth } from "./access-policy/subjects.js";

/** Data-plane mount point. Kept here so the control-plane answer and the router cannot drift. */
export const DIRECT_UPLOAD_PATH_PREFIX = "/uploads";
/** Rollback gate (contract §6 "回滚"): turning this off leaves the legacy MCP chunk path intact. */
export const DIRECT_UPLOAD_ENABLED = parseBool(process.env.DIRECT_UPLOAD_ENABLED || "true");
/** D4: `min(MAX_TRANSFER_BYTES, env || 50 MiB)`; never a second, larger ceiling than the transfer one. */
export const DIRECT_UPLOAD_MAX_BYTES = Math.min(MAX_TRANSFER_BYTES, parseBytes(process.env.DIRECT_UPLOAD_MAX_BYTES || "50mb"));
/**
 * Wave B: largest single `PATCH` body. A chunk above this is refused with 413 instead of being
 * buffered/appended; the client splits the file into contiguous <= 8 MiB pieces. Never larger than
 * the whole-file ceiling.
 */
export const DIRECT_UPLOAD_PATCH_MAX_BYTES = Math.max(1, Math.min(DIRECT_UPLOAD_MAX_BYTES, parseBytes(process.env.DIRECT_UPLOAD_PATCH_MAX_BYTES || "8mb")));
/** Same scope requirement as `start_file_upload` (control plane creates the write intent). */
export const DIRECT_UPLOAD_SCOPES = MCP_TOOL_SCOPE_REQUIREMENTS.start_direct_upload;
// Issue #470 follow-up (task A): data-plane admission control. All four are env-overridable; the
// brief's table is the source of the defaults.
export const DIRECT_UPLOAD_RATE_PER_MINUTE = Math.max(1, parseInteger(process.env.DIRECT_UPLOAD_RATE_PER_MINUTE, 6));
export const DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL = Math.max(1, parseInteger(process.env.DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL, 2));
export const DIRECT_UPLOAD_MAX_CONCURRENT_GLOBAL = Math.max(1, parseInteger(process.env.DIRECT_UPLOAD_MAX_CONCURRENT_GLOBAL, 8));
/** 0 disables the gate; `parseBytes` accepts `512mb`, `536870912` or `0`. */
export const DIRECT_UPLOAD_MIN_FREE_BYTES = Math.max(0, parseBytes(process.env.DIRECT_UPLOAD_MIN_FREE_BYTES || "512mb"));
// Issue #470 follow-up (task B): time bounds for the data plane only. Deliberately NOT
// `server.requestTimeout` / `headersTimeout` / `timeout`: `POST /mcp` is a long-lived SSE transport
// that may idle for tens of minutes, so a process-wide timeout would cut healthy sessions. These
// two apply to `PUT /uploads/:uploadId` and nothing else; 0 disables either bound.
//
// `MAX_DURATION` defaults to 240 s (4 min) ON PURPOSE, even though 10 min sounds friendlier: the
// edge nginx answers its own 300 s body/proxy timeout first, so a longer value here would never
// fire in production while looking like a real bound. Keep this below the proxy's value.
export const DIRECT_UPLOAD_IDLE_TIMEOUT_MS = Math.max(0, parseInteger(process.env.DIRECT_UPLOAD_IDLE_TIMEOUT_MS, 30_000));
export const DIRECT_UPLOAD_MAX_DURATION_MS = Math.max(0, parseInteger(process.env.DIRECT_UPLOAD_MAX_DURATION_MS, 240_000));
const PROTECTED_ROOTS = new Set([".git", ".obsidian"]);
const CONTROL_TOOL = "start_direct_upload";

// ---------------------------------------------------------------------------
// Writer lock (D6): exactly one writer per uploadId inside this process.
// `transfer-runtime.js` stays stateless; the lock is injected, so the same handle cannot be written
// by two concurrent PUTs even though both would otherwise pass the pre-stream checks.
// ---------------------------------------------------------------------------
const activeWriters = new Set();
const writerLock = {
  acquire(key) {
    if (activeWriters.has(key)) return null;
    activeWriters.add(key);
    return () => activeWriters.delete(key);
  },
};

function transferDeps() {
  return {
    limits: { maxTransferBytes: MAX_TRANSFER_BYTES, chunkBytes: TRANSFER_CHUNK_BYTES, ttlMs: TRANSFER_TTL_MS },
    protectedRoots: PROTECTED_ROOTS,
    directUploadMaxBytes: DIRECT_UPLOAD_MAX_BYTES,
    writerLock,
  };
}

function runtimeFor(vaultRuntime) {
  return createTransferRuntime({ vaultRuntime, deps: transferDeps() });
}

/**
 * Same request-context rule as `file-transfer.js`: the Vault selected by the MCP request (contract
 * §6) picks the runtime; no selection keeps the primary runtime. Never guesses a secondary Vault.
 */
function selectRuntime() {
  const context = requestContext();
  const declaredVaultId = typeof context?.vaultId === "string" && context.vaultId !== "" ? context.vaultId : undefined;
  const vaultRuntime = context?.vaultRuntime;
  const target = vaultRuntime !== null && typeof vaultRuntime === "object" && vaultRuntime.localFs ? vaultRuntime : primaryRuntime;
  return { runtime: runtimeFor(target), declaredVaultId };
}

function shortId(uploadId) {
  return typeof uploadId === "string" && uploadId ? uploadId.slice(0, 8) : null;
}

/** D8: one structured line, metadata only. Deliberately no URL, token, cookie or content. */
function auditLine({ requestId, operation, uploadId, startedAt, decision, status, code = null, vaultId = null, credentialId = null, bytes = null, digest = null, nextAllowedAt = null, credentialSource = null, limit = null, retryAfterSeconds = null, freeBytes = null, freeBytesUnknown = false, rateWaived = false }) {
  const line = {
    event: "direct-upload",
    requestId,
    operation,
    uploadId: shortId(uploadId),
    vaultId,
    credentialId,
    decision,
    status,
    code,
    durationMs: Date.now() - startedAt,
    bytes,
    digest,
  };
  if (nextAllowedAt) line.nextAllowedAt = nextAllowedAt;
  // Optional fields are only emitted when they carry information, so the existing allow/deny line
  // shape (asserted by the Wave A tests) stays byte-for-byte identical in the normal case.
  if (credentialSource) line.credentialSource = credentialSource;
  if (limit) line.limit = limit;
  if (retryAfterSeconds !== null) line.retryAfterSeconds = retryAfterSeconds;
  if (freeBytes !== null) line.freeBytes = freeBytes;
  if (freeBytesUnknown) line.freeBytesUnknown = true;
  // Issue #698: visible only when this request rode an already-paid upload, so the normal line
  // shape is unchanged and an operator can tell a continuation from a charged first write.
  if (rateWaived) line.rateWaived = true;
  console.log(`[direct-upload] ${JSON.stringify(line)}`);
}

function credentialIdOf(auth) {
  const id = auth?.keyId ?? auth?.clientId ?? auth?.userId ?? null;
  return typeof id === "string" && id ? id : null;
}

// ---------------------------------------------------------------------------
// Control plane (called by the `start_direct_upload` MCP tool)
// ---------------------------------------------------------------------------

/**
 * Create a single-PUT handle. Response fields are exactly contract §2.1 minus `uploadUrl` (D7): the
 * client joins `relativePath` against the origin it already authenticated against.
 */
export async function startDirectUpload(input = {}) {
  if (!DIRECT_UPLOAD_ENABLED) throw new Error("[direct_upload_disabled] direct HTTP upload is disabled on this server");
  const startedAt = Date.now();
  const requestId = randomUUID();
  const context = requestContext();
  try {
    const { runtime, declaredVaultId } = selectRuntime();
    const started = await runtime.startDirectUpload(input, declaredVaultId);
    auditLine({
      requestId, operation: "start", uploadId: started.uploadId, startedAt, decision: "allow", status: 201,
      vaultId: started.vaultId, credentialId: context?.authClientId ?? null, bytes: started.totalBytes, digest: started.expectedSha256,
    });
    return {
      uploadId: started.uploadId,
      vaultId: started.vaultId,
      path: started.vaultPath,
      totalBytes: started.totalBytes,
      sha256: started.expectedSha256,
      overwrite: started.overwrite,
      method: "PUT",
      relativePath: `${DIRECT_UPLOAD_PATH_PREFIX}/${started.uploadId}`,
      expiresAt: started.expiresAt,
      maxBytes: started.maxBytes,
      sha256Required: true,
      mode: DIRECT_UPLOAD_MODE,
    };
  } catch (error) {
    auditLine({
      requestId, operation: "start", uploadId: null, startedAt, decision: "deny", status: 400,
      code: error?.code ?? "invalid_request", vaultId: context?.vaultId ?? null,
      credentialId: context?.authClientId ?? null, bytes: Number.isInteger(input?.totalBytes) ? input.totalBytes : null,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Data plane (PUT /uploads/:uploadId)
// ---------------------------------------------------------------------------

const HTTP_STATUS = new Map([
  [UPLOAD_NOT_FOUND, 404],
  [VAULT_CONTEXT_MISMATCH, 404],
  [UPLOAD_EXPIRED, 410],
  [UPLOAD_TOO_LARGE, 413],
  [UPLOAD_IN_PROGRESS, 409],
  [UPLOAD_MODE_CONFLICT, 409],
  [UPLOAD_FAILED, 409],
  [UPLOAD_DESTINATION_EXISTS, 409],
  [UPLOAD_INTEGRITY_MISMATCH, 400],
  // Wave B: a PATCH whose offset disagrees with the staged length, and a chunk that would run past
  // the declared total. 409 = retry at the authoritative offset; 416 = the declaration does not fit.
  [UPLOAD_OFFSET_CONFLICT, 409],
  [UPLOAD_RANGE_EXCEEDED, 416],
  // Task B: a request that stalled (idle) or outstayed its total budget. 408 is the honest answer:
  // the client may retry the SAME bytes with a fresh handle, and nothing was published.
  [DIRECT_UPLOAD_TIMEOUT_CODES.idle, 408],
  [DIRECT_UPLOAD_TIMEOUT_CODES.duration, 408],
]);

/** Timeouts are neither an allow nor a policy deny: they get their own audit decision. */
const TIMEOUT_CODES = new Set([DIRECT_UPLOAD_TIMEOUT_CODES.idle, DIRECT_UPLOAD_TIMEOUT_CODES.duration]);

function statusFor(code) {
  return HTTP_STATUS.get(code) ?? 503;
}

/** Vaults this credential may write to (never the whole inventory: that would leak existence). */
function allowedVaultIds(auth) {
  const listed = Array.isArray(auth?.allowedVaults) ? auth.allowedVaults : [];
  const unique = [...new Set(listed.filter((id) => typeof id === "string" && id !== ""))];
  return unique.length ? unique : [];
}

export function createDirectUploadRouter({ auth, accessRuntime = null, resolveRuntime: resolveVault = null, provider = null, enabled = DIRECT_UPLOAD_ENABLED, writable = true, limiter = null, minFreeBytes = DIRECT_UPLOAD_MIN_FREE_BYTES, statfs = null, idleTimeoutMs = DIRECT_UPLOAD_IDLE_TIMEOUT_MS, maxDurationMs = DIRECT_UPLOAD_MAX_DURATION_MS } = {}) {
  const router = express.Router();
  if (!enabled) return router;
  if (typeof auth !== "function") throw new Error("[direct_upload_invalid] createDirectUploadRouter requires the server's auth middleware");
  // One admission state machine per mounted router (= per server process). Tests may inject their
  // own instance; production always reads the four env-backed defaults above.
  const admission = limiter ?? createDirectUploadLimiter({
    ratePerMinute: DIRECT_UPLOAD_RATE_PER_MINUTE,
    maxConcurrentPerCredential: DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL,
    maxConcurrentGlobal: DIRECT_UPLOAD_MAX_CONCURRENT_GLOBAL,
    // A paid rate charge has to keep waiving its upload for as long as the handle can be written.
    rateChargeTtlMs: TRANSFER_TTL_MS,
  });

  function resolveRuntime(vaultId) {
    const resolved = typeof resolveVault === "function" ? resolveVault(vaultId) : null;
    if (resolved) return resolved;
    return vaultId === primaryRuntime.id ? primaryRuntime : null;
  }

  /** Find the owning Vault handle among the caller's allowed Vaults only (no cross-Vault probe). */
  async function locate(uploadId, allowed) {
    for (const vaultId of allowed) {
      const vaultRuntime = resolveRuntime(vaultId);
      if (!vaultRuntime) continue;
      let metadata;
      try {
        metadata = await runtimeFor(vaultRuntime).peekDirectUpload(uploadId);
      } catch (error) {
        if (error?.code === UPLOAD_NOT_FOUND || /Invalid uploadId/.test(error?.message || "")) continue;
        throw error;
      }
      const bound = metadata?.vaultId ?? (vaultRuntime.primary === true ? vaultId : null);
      if (bound !== vaultId) continue;
      return { vaultRuntime, vaultId, metadata };
    }
    return null;
  }

  function methodNotAllowed(_req, res) {
    res.setHeader("Allow", "PUT, PATCH");
    res.status(405).json({ error: "method_not_allowed", code: "method_not_allowed", message: "Direct uploads accept a single PUT of the whole body or contiguous PATCH chunks with Upload-Offset" });
  }

  /**
   * Authorization gate shared by both data-plane writers (`PUT` whole body, `PATCH` chunk). Lifted
   * from the Wave A PUT body without changing its order or its messages: a PATCH can never reach a
   * stage the PUT is not allowed to reach (contract §2.3).
   */
  function authorizeCaller(req, reject) {
    const caller = req.auth;
    if (!caller || typeof caller !== "object") { reject(403, "credential_required", "This endpoint requires an authenticated credential"); return null; }
    const granted = Array.isArray(caller.scopes) ? caller.scopes : [];
    const missing = DIRECT_UPLOAD_SCOPES.filter((scope) => !granted.includes(scope));
    if (missing.length) { reject(403, "insufficient_scope", `Missing scope: ${missing.join(" ")}`); return null; }

    // Same temporal gate the MCP tool goes through (INTERFACE §10.1): re-evaluated per request so a
    // window that closed after the handle was created blocks the write (contract §2.3.2).
    if (accessRuntime && typeof accessRuntime.evaluate === "function") {
      const subjects = subjectsFromMcpAuth(caller);
      const capabilities = capabilitiesForTool(CONTROL_TOOL);
      const decision = accessRuntime.evaluate({ subjects, capabilities });
      if (decision && decision.allowed === false) {
        const broken = decision.reason === "policy_unavailable";
        const explained = broken ? null : accessRuntime.explain?.({ subjects, capabilities }) ?? null;
        reject(403, broken ? "policy_unavailable" : "outside_window", "The current authorization window does not allow this write", { nextAllowedAt: explained?.nextAllowedAt ?? null });
        return null;
      }
    }
    if (!writable) { reject(403, "read_only", "This server is running read-only"); return null; }
    return caller;
  }

  /**
   * Admission control shared by both writers (issue #470 follow-up A, amended by #698): one rate
   * bucket and one set of in-flight slots per mounted router, so a PATCH and a PUT from the same
   * credential compete for the SAME budget instead of two independent ones. Runs before the first
   * body byte.
   *
   * The RATE token is charged per UPLOAD, not per request: the first write that carries a handle
   * pays, and the later PATCH chunks of the same (credential, uploadId) continue that same
   * admission rather than opening a new one. The four abuse gates are untouched: every request —
   * first or continuation — still claims its own in-flight slot right here, and the disk/idle/
   * duration gates stay per request further down. A different handle is a different upload and
   * still spends a token.
   *
   * `markRateChargeHeld()` is called only after the handle has been located and confirmed to belong
   * to this caller, so an unknown or foreign `uploadId` cannot be named repeatedly to buy free
   * requests. A concurrent race between two first writes of the same handle can spend one extra
   * token; it can never spend fewer, and the writer lock makes the second write a 409 anyway.
   */
  function admit(req, res, credentialKey, uploadId, limited) {
    const rateWaived = admission.rateChargeHeld?.(credentialKey, uploadId) === true;
    if (!rateWaived) {
      const rateDecision = admission.rateLimit(credentialKey);
      if (!rateDecision.allowed) { limited(rateDecision.retryAfterSeconds, "rate"); return null; }
    }
    const slot = admission.acquire(credentialKey);
    if (!slot.allowed) { limited(slot.retryAfterSeconds, "concurrency"); return null; }
    // `close` covers a client that aborts mid-body; the caller's `finally` covers every normal exit.
    // `release()` is idempotent, so the pair cannot double-decrement (a leaked slot would answer 429).
    res.once("close", slot.release);
    let recorded = rateWaived;
    return {
      slot,
      rateWaived,
      markRateChargeHeld() {
        if (recorded) return;
        recorded = true;
        admission.recordRateCharge?.(credentialKey, uploadId);
      },
    };
  }

  /**
   * `reject`/`limited` for one data-plane operation. The audit line and the provider audit keep the
   * Wave A shape; only the operation name (`put`/`patch`) differs. `extra.headers`/`extra.body` exist
   * for the Wave B offset answer: a 409/416 must carry the AUTHORITATIVE `Upload-Offset`.
   */
  function denials({ req, res, requestId, uploadId, caller, credentialId, audit, operation }) {
    const reject = (status, code, message, extra = {}) => {
      audit({ decision: "deny", status, code, vaultId: extra.vaultId ?? null, credentialId, bytes: extra.bytes ?? null, nextAllowedAt: extra.nextAllowedAt ?? null, freeBytes: extra.freeBytes ?? null });
      try {
        provider?.recordAudit?.({
          action: `direct-upload.${operation}`, outcome: "failure", surface: "mcp",
          credentialType: caller?.type ?? "unknown", credentialId,
          detail: `${shortId(uploadId)}:${code}`,
        });
      } catch {}
      if (res.writableEnded || res.headersSent) return;
      for (const [name, value] of Object.entries(extra.headers ?? {})) res.setHeader(name, String(value));
      res.setHeader("Connection", "close");
      res.status(status).json({ ...(extra.body ?? {}), error: code, code, message, requestId });
      // A rejected request may still have a body in flight; drain it rather than resetting the socket.
      req.resume();
    };

    /** 429 for rate/concurrency only: a distinct `decision`, never allow or deny (task A). */
    const limited = (retryAfterSeconds, limit) => {
      const detailCode = limit === "concurrency" ? "concurrency_limited" : "rate_limited";
      audit({ decision: "limited", status: 429, code: detailCode, credentialId, retryAfterSeconds, limit });
      try {
        provider?.recordAudit?.(
          { action: `direct-upload.${operation}`, outcome: "failure", surface: "mcp", credentialType: caller?.type ?? "unknown", credentialId, detail: `${shortId(uploadId)}:${detailCode}` },
        );
      } catch {}
      if (res.writableEnded || res.headersSent) return;
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.setHeader("Connection", "close");
      res.status(429).json({ error: "rate_limited", code: "rate_limited", message: `Too many direct uploads; retry after ${retryAfterSeconds} second(s)`, retryAfterSeconds, requestId });
      req.resume();
    };
    return { reject, limited };
  }

  router.put(`${DIRECT_UPLOAD_PATH_PREFIX}/:uploadId`, auth, async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const uploadId = String(req.params.uploadId || "");
    const caller = req.auth;
    const credentialId = credentialIdOf(caller);
    // Rate/concurrency key: the credential id; only when the verified credential carries none does
    // it fall back to the peer address, and that fact is then visible in the audit line.
    const credentialKey = credentialId || `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
    const credentialSource = credentialId ? null : "ip";
    const audit = (fields) => auditLine({ requestId, operation: "put", uploadId, startedAt, credentialSource, ...fields });

    const { reject, limited } = denials({ req, res, requestId, uploadId, caller, credentialId, audit, operation: "put" });
    if (!authorizeCaller(req, reject)) return;
    // Task A: admission control runs BEFORE the first body byte is read. The rate slot is consumed
    // even when the in-flight gate then refuses, so a caller cannot busy-loop concurrency for free.
    // #698: a handle this credential already paid for is not charged again.
    const admitted = admit(req, res, credentialKey, uploadId, limited);
    if (!admitted) return;
    try {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (contentType.startsWith("multipart/") || contentType.startsWith("application/json") || contentType.endsWith("+json")) {
        return reject(400, "unsupported_media_type", "Send the raw bytes; multipart and JSON envelopes are not accepted");
      }
      const declaredLength = req.headers["content-length"];
      if (req.headers["transfer-encoding"] || typeof declaredLength !== "string" || !/^\d+$/.test(declaredLength)) {
        return reject(400, "length_required", "An exact Content-Length is required; chunked bodies are not accepted");
      }
      const contentLength = Number(declaredLength);
      if (!Number.isSafeInteger(contentLength)) return reject(400, "length_required", "Content-Length is out of range");
      if (contentLength > DIRECT_UPLOAD_MAX_BYTES) return reject(413, "payload_too_large", `Body exceeds the direct upload ceiling (${DIRECT_UPLOAD_MAX_BYTES} bytes)`);

      const allowed = allowedVaultIds(caller);
      if (!allowed.length) return reject(403, "vault_access_denied", "The credential is not allowed to write to any Vault");

      let located;
      try {
        located = await locate(uploadId, allowed);
      } catch (error) {
        const code = error?.code || "storage_unavailable";
        return reject(statusFor(code), code, String(error?.message || error));
      }
      if (!located) return reject(404, "upload_not_found", "Unknown uploadId");
      const { vaultRuntime, vaultId, metadata } = located;

      // Pre-stream state checks so a 409/410/413 never has to consume the body. The runtime repeats all
      // of them authoritatively inside the write.
      if (metadata?.mode !== DIRECT_UPLOAD_MODE) return reject(409, UPLOAD_MODE_CONFLICT, `upload ${uploadId} was created for base64 chunks; use upload_file_chunk`, { vaultId });
      // The handle is real and this caller's: from here on its upload never pays the rate again.
      admitted.markRateChargeHeld();
      if (Date.parse(metadata.expiresAt) <= Date.now()) return reject(410, UPLOAD_EXPIRED, "Upload expired; start a new upload", { vaultId });
      if (metadata.status === "complete") {
        const body = { error: "upload_complete", code: "upload_complete", message: "This upload already published; the Vault file was not rewritten", requestId, uploadId, status: "COMPLETE", receiptId: metadata.receiptId ?? null, size: metadata.result?.size ?? null, sha256: metadata.result?.sha256 ?? null, revision: metadata.result?.revision ?? null };
        audit({ decision: "deny", status: 409, code: "upload_complete", vaultId, credentialId, bytes: metadata.result?.size ?? null });
        res.setHeader("Connection", "close");
        res.status(409).json(body);
        req.resume();
        return;
      }
      if (metadata.status !== "uploading") return reject(409, UPLOAD_FAILED, `upload ${uploadId} is ${metadata.status}; start a new direct upload`, { vaultId });
      if (metadata.uploadedBytes !== 0) return reject(409, UPLOAD_MODE_CONFLICT, `upload ${uploadId} already carries staged bytes; continue it with PATCH /uploads/${uploadId} and Upload-Offset, or start a new upload`, { vaultId });
      if (contentLength > metadata.totalBytes) return reject(413, "length_mismatch", `Body is ${contentLength} bytes but the upload was declared as ${metadata.totalBytes}`, { vaultId });
      if (contentLength < metadata.totalBytes) return reject(400, "length_mismatch", `Body is ${contentLength} bytes but the upload was declared as ${metadata.totalBytes}`, { vaultId });

      // Staging-disk headroom (task A): measured against the owning Vault's transfers root, after the
      // cheap state checks and still before streaming. A failed `statfs` fails OPEN and records
      // `freeBytesUnknown` instead of rejecting uploads (see direct-upload-limits.js for the reason).
      const disk = await checkDiskHeadroom({ dir: vaultRuntime.paths?.transfersUploads, minFreeBytes, statfs });
      if (!disk.ok) {
        return reject(507, "insufficient_storage", `The upload staging disk has ${disk.freeBytes} bytes free; at least ${minFreeBytes} are required`, { vaultId, freeBytes: disk.freeBytes });
      }
      const freeBytesUnknown = disk.unknown === true;

      // Task B: bound the body in time. The runtime streams the guard's inner stream, so a timeout
      // can abort the write (pipeline rejects ⇒ `.part` is never published, the handle becomes
      // `failed-retryable`) while the socket stays writable long enough to answer 408.
      const guard = createUploadStreamGuard({ stream: req, idleTimeoutMs, maxDurationMs });
      try {
        const outcome = await withRequestContext(
          { author: { agent: "direct-upload", model: "http-put" }, vaultId, vaultRuntime, tool: CONTROL_TOOL },
          () => runtimeFor(vaultRuntime).receiveDirectUpload({ uploadId, stream: guard.body, contentLength }, vaultId),
        );
        const { result, receiptId } = outcome;
        audit({ decision: "allow", status: 201, code: "complete", vaultId, credentialId, bytes: result.size, digest: result.sha256, freeBytesUnknown, rateWaived: admitted.rateWaived });
        try {
          provider?.recordAudit?.({
            action: "direct-upload.put", outcome: "success", surface: "mcp",
            credentialType: caller?.type ?? "unknown", credentialId, detail: `${vaultId}:${shortId(uploadId)}`,
          });
        } catch {}
        res.status(201).json({
          uploadId, path: result.path, size: result.size, sha256: result.sha256,
          revision: result.revision, status: "COMPLETE", receiptId,
        });
      } catch (error) {
        const code = typeof error?.code === "string" && error.code ? error.code : (error?.name === "AbortError" ? "client_aborted" : "storage_unavailable");
        const status = statusFor(code);
        const timedOut = TIMEOUT_CODES.has(code);
        audit({ decision: timedOut ? "timeout" : "deny", status, code, vaultId, credentialId, bytes: contentLength, digest: metadata.expectedSha256 ?? null, freeBytesUnknown });
        // `pipeline` destroys the request stream when it settles, so `req.destroyed` is not a reason to
        // stay silent: the response object is what still has to answer the client.
        if (res.writableEnded || res.headersSent) return;
        // A timed-out client may still be streaming bytes into a socket nobody reads any more: after
        // the 408 is flushed, drop the socket instead of leaving a half-open body behind.
        if (timedOut) res.once("close", () => { if (!req.destroyed) req.destroy(); });
        res.setHeader("Connection", "close");
        res.status(status).json({ error: code, code, message: String(error?.message || error), requestId });
      } finally {
        guard.dispose();
      }
    } finally {
      admitted.slot.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Wave B: resumable data plane — PATCH /uploads/:uploadId + `Upload-Offset`
  // ---------------------------------------------------------------------------
  // Protocol frozen in the Wave B brief (contract §2.2 option A): one contiguous chunk per request,
  // the client's `Upload-Offset` is a CLAIM and the server's `uploadedBytes` is the only authority.
  // A mismatch answers 409/416 with the authoritative offset in `Upload-Offset` AND in the body, so a
  // client can always recover without guessing. A successful append answers **200** with the new
  // `Upload-Offset` (204 is deliberately not used: the offset is the point of the answer). The chunk
  // that brings the byte count to `totalBytes` publishes through the same runtime publish step as the
  // whole-body PUT, including the publish-time re-hash (#688).
  router.patch(`${DIRECT_UPLOAD_PATH_PREFIX}/:uploadId`, auth, async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const uploadId = String(req.params.uploadId || "");
    const caller = req.auth;
    const credentialId = credentialIdOf(caller);
    // Same admission key as the PUT path: one credential, one budget (issue #470 follow-up A).
    const credentialKey = credentialId || `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
    const credentialSource = credentialId ? null : "ip";
    const audit = (fields) => auditLine({ requestId, operation: "patch", uploadId, startedAt, credentialSource, ...fields });
    const { reject, limited } = denials({ req, res, requestId, uploadId, caller, credentialId, audit, operation: "patch" });
    if (!authorizeCaller(req, reject)) return;
    // #698: only the FIRST write of an upload spends a rate token; a continuation PATCH is the same
    // admission. Its in-flight slot, disk gate and time bounds are still claimed per request.
    const admitted = admit(req, res, credentialKey, uploadId, limited);
    if (!admitted) return;
    try {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (contentType.startsWith("multipart/") || contentType.startsWith("application/json") || contentType.endsWith("+json")) {
        return reject(400, "unsupported_media_type", "Send the raw bytes; multipart and JSON envelopes are not accepted");
      }
      // The other resume protocol (PUT + Content-Range) is explicitly NOT implemented: refuse it
      // loudly instead of ignoring a header that would imply an unsupported offset semantic.
      if (req.headers["content-range"]) {
        return reject(400, "content_range_not_supported", "Resume uses PATCH with Upload-Offset; Content-Range is not part of this protocol");
      }
      const declaredLength = req.headers["content-length"];
      if (req.headers["transfer-encoding"] || typeof declaredLength !== "string" || !/^\d+$/.test(declaredLength)) {
        return reject(400, "length_required", "An exact Content-Length is required; chunked bodies are not accepted");
      }
      const contentLength = Number(declaredLength);
      if (!Number.isSafeInteger(contentLength)) return reject(400, "length_required", "Content-Length is out of range");
      if (contentLength > DIRECT_UPLOAD_PATCH_MAX_BYTES) {
        return reject(413, "chunk_too_large", `A PATCH chunk may not exceed ${DIRECT_UPLOAD_PATCH_MAX_BYTES} bytes; split the file into contiguous chunks`);
      }
      const rawOffset = req.headers["upload-offset"];
      if (typeof rawOffset !== "string" || !/^\d+$/.test(rawOffset)) {
        return reject(400, "offset_required", "An Upload-Offset header with the number of bytes already accepted is required");
      }
      const offset = Number(rawOffset);
      if (!Number.isSafeInteger(offset)) return reject(400, "offset_required", "Upload-Offset is out of range");

      const allowed = allowedVaultIds(caller);
      if (!allowed.length) return reject(403, "vault_access_denied", "The credential is not allowed to write to any Vault");
      let located;
      try {
        located = await locate(uploadId, allowed);
      } catch (error) {
        const code = error?.code || "storage_unavailable";
        return reject(statusFor(code), code, String(error?.message || error));
      }
      if (!located) return reject(404, "upload_not_found", "Unknown uploadId");
      const { vaultRuntime, vaultId, metadata } = located;

      if (metadata?.mode !== DIRECT_UPLOAD_MODE) return reject(409, UPLOAD_MODE_CONFLICT, `upload ${uploadId} was created for base64 chunks; use upload_file_chunk`, { vaultId });
      // Located and owned: the continuation of this upload never pays the rate a second time.
      admitted.markRateChargeHeld();
      if (Date.parse(metadata.expiresAt) <= Date.now()) return reject(410, UPLOAD_EXPIRED, "Upload expired; start a new upload", { vaultId });
      // The authoritative offset as of this request; the runtime repeats the check under the writer
      // lock (the only place where a concurrent PATCH could have moved it).
      const authoritative = Number.isInteger(metadata.uploadedBytes) ? metadata.uploadedBytes : 0;
      const offsetConflict = (status, code, message) => reject(status, code, message, {
        vaultId,
        headers: { "Upload-Offset": String(authoritative) },
        body: { uploadedBytes: authoritative, nextOffset: authoritative },
      });
      const resumable = metadata.status === "uploading" || metadata.status === "failed-retryable";
      // A `complete` handle is answered with its receipt (idempotent retry), never republished.
      if (!resumable && metadata.status !== "complete") return reject(409, UPLOAD_FAILED, `upload ${uploadId} is ${metadata.status}; start a new direct upload`, { vaultId });
      if (resumable) {
        if (offset > authoritative) return offsetConflict(409, UPLOAD_OFFSET_CONFLICT, `Upload-Offset ${offset} is ahead of the authoritative ${authoritative}`);
        // An offset BELOW the authoritative one is only a possible byte-identical retry; the runtime
        // compares the staged range with the body. A partial overlap is a conflict here, so the body
        // is not streamed into a chunk that could never be idempotent.
        if (offset < authoritative && offset + contentLength > authoritative) {
          return offsetConflict(409, UPLOAD_OFFSET_CONFLICT, `chunk of ${contentLength} bytes at offset ${offset} straddles the authoritative ${authoritative}`);
        }
        if (offset + contentLength > metadata.totalBytes) {
          return offsetConflict(416, UPLOAD_RANGE_EXCEEDED, `chunk of ${contentLength} bytes at offset ${offset} would exceed the declared ${metadata.totalBytes} bytes`);
        }
      }

      // Staging-disk headroom, same gate as the PUT path (no write happens for a duplicate answer).
      let freeBytesUnknown = false;
      if (resumable) {
        const disk = await checkDiskHeadroom({ dir: vaultRuntime.paths?.transfersUploads, minFreeBytes, statfs });
        if (!disk.ok) {
          return reject(507, "insufficient_storage", `The upload staging disk has ${disk.freeBytes} bytes free; at least ${minFreeBytes} are required`, { vaultId, freeBytes: disk.freeBytes });
        }
        freeBytesUnknown = disk.unknown === true;
      }

      // Same time bound as the PUT path: idle and total duration apply per chunk, so a stalled PATCH
      // is aborted and the handle stays resumable at its acknowledged offset.
      const guard = createUploadStreamGuard({ stream: req, idleTimeoutMs, maxDurationMs });
      try {
        const outcome = await withRequestContext(
          { author: { agent: "direct-upload", model: "http-patch" }, vaultId, vaultRuntime, tool: CONTROL_TOOL },
          () => runtimeFor(vaultRuntime).appendDirectUpload({ uploadId, stream: guard.body, contentLength, offset }, vaultId),
        );
        const complete = Boolean(outcome.result);
        audit({ decision: "allow", status: 200, code: complete ? "complete" : "appended", vaultId, credentialId, bytes: contentLength, digest: outcome.result?.sha256 ?? null, freeBytesUnknown, rateWaived: admitted.rateWaived });
        try {
          provider?.recordAudit?.({ action: "direct-upload.patch", outcome: "success", surface: "mcp", credentialType: caller?.type ?? "unknown", credentialId, detail: `${vaultId}:${shortId(uploadId)}` });
        } catch {}
        // A repeated chunk or a repeated request against a COMPLETE handle may still have bytes in
        // flight that the runtime never read; drain them instead of answering into a full socket, and
        // close the connection so a pooled client never reuses a socket whose body was not consumed.
        if (outcome.duplicate) {
          req.resume();
          res.setHeader("Connection", "close");
        }
        res.setHeader("Upload-Offset", String(outcome.uploadedBytes));
        res.status(200).json({
          uploadId,
          uploadedBytes: outcome.uploadedBytes,
          totalBytes: outcome.totalBytes,
          nextOffset: outcome.uploadedBytes,
          complete,
          status: complete ? "COMPLETE" : "uploading",
          idempotentReplay: outcome.idempotentReplay === true || outcome.duplicate === true,
          ...(complete ? { path: outcome.result.path, size: outcome.result.size, sha256: outcome.result.sha256, revision: outcome.result.revision, receiptId: outcome.receiptId } : {}),
        });
      } catch (error) {
        const code = typeof error?.code === "string" && error.code ? error.code : (error?.name === "AbortError" ? "client_aborted" : "storage_unavailable");
        const status = statusFor(code);
        const timedOut = TIMEOUT_CODES.has(code);
        const offsetAnswer = code === UPLOAD_OFFSET_CONFLICT || code === UPLOAD_RANGE_EXCEEDED;
        audit({ decision: timedOut ? "timeout" : "deny", status, code, vaultId, credentialId, bytes: contentLength, digest: metadata.expectedSha256 ?? null, freeBytesUnknown });
        if (res.writableEnded || res.headersSent) return;
        if (timedOut) res.once("close", () => { if (!req.destroyed) req.destroy(); });
        if (offsetAnswer) res.setHeader("Upload-Offset", String(authoritative));
        res.setHeader("Connection", "close");
        res.status(status).json({
          error: code,
          code,
          message: String(error?.message || error),
          requestId,
          ...(offsetAnswer ? { uploadedBytes: authoritative, nextOffset: authoritative } : {}),
        });
      } finally {
        guard.dispose();
      }
    } finally {
      admitted.slot.release();
    }
  });

  router.all(`${DIRECT_UPLOAD_PATH_PREFIX}/:uploadId`, methodNotAllowed);
  return router;
}

/**
 * `server.js` call site for the data plane (Wave F keeps that file shrinking). With
 * `DIRECT_UPLOAD_ENABLED=false` nothing is mounted, so the rollback leaves only the legacy MCP chunk
 * tools (contract §6).
 */
export function mountDirectUpload(app, options = {}) {
  if (options.enabled === false) return null;
  const router = createDirectUploadRouter(options);
  app.use(router);
  return router;
}
