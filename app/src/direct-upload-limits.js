// Issue #470 follow-up — admission control for `PUT /uploads/:uploadId`.
//
// Contract: `scratch/briefs/rate-limit-470-BRIEF.md` §1 (task A). Wave A bounded a single body
// (50 MiB) and one writer per handle, but nothing bounded how often or how many at once a
// credential could ask for, so `n × 50 MiB` could fill the staging disk and take normal note
// writes down with it. This module is the pure state machine for the three new gates; the router
// owns *where* they run (before the first body byte) and the HTTP/audit mapping.
//
// Deliberately free of express, `process.env` and config imports: callers inject the clock, so the
// tests can cross a rate window without sleeping for a minute, and `direct-upload.js` stays the one
// place that reads configuration.
//
// Rate shape: a token bucket with capacity = `ratePerMinute` and a smooth refill of
// `ratePerMinute / 60` per second. The first `ratePerMinute` requests may burst; sustained
// throughput is exactly the configured per-minute budget, and `retryAfterSeconds` is the exact
// wait for the next token instead of a rounded-up minute. (A fixed 60 s sliding window would make
// the HTTP recovery assertion sleep a full minute; the contract only fixes the sustained rate.)
//
// Issue #698: the bucket is charged per UPLOAD, not per request. `rateLimit()` was spent by every
// request that reached admission, including each `PATCH` chunk of the same handle, so the default
// 8 MiB chunking of a full 50 MiB file hit the seventh request of a six-token budget and a
// compliant client was answered `429`. A contiguous append is the continuation of the admission
// already granted for that handle, so the router asks `rateChargeHeld(credential, uploadId)`
// before charging and records the charge (`recordRateCharge`) once the handle is proven to exist
// and belong to the caller. Only the rate gate is amortised: the in-flight, disk and time gates
// are per request by construction and are not touched here.
//
// Task B adds the *time* half of the same story: an idle PUT and an over-long PUT. The guard below
// is a stream wrapper, not a server-level timeout, because `POST /mcp` is a long-lived SSE
// transport and any global `server.requestTimeout` / `headersTimeout` / `timeout` would cut healthy
// sessions. Same style as the limiter: no express, no `process.env`, caller injects values.

import fs from "node:fs/promises";
import { PassThrough } from "node:stream";

export const DIRECT_UPLOAD_LIMIT_DEFAULTS = Object.freeze({
  ratePerMinute: 6,
  maxConcurrentPerCredential: 2,
  maxConcurrentGlobal: 8,
  minFreeBytes: 512 * 1024 * 1024,
});

// A bucket whose key has not been seen for a minute and is already full carries no information.
// Pruning only runs past this size, so the normal case stays O(1) per request.
const PRUNE_THRESHOLD = 512;
const PRUNE_IDLE_MS = 60_000;
// How long a paid rate charge keeps waiving the chunks of its upload. It only has to outlive the
// handle itself (transfer TTL, 24 h by default), and `direct-upload.js` passes that TTL in.
const RATE_CHARGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} [options]
 * @param {number} [options.ratePerMinute] sustained requests per credential per minute
 * @param {number} [options.maxConcurrentPerCredential] simultaneous PUTs per credential
 * @param {number} [options.maxConcurrentGlobal] simultaneous PUTs per process
 * @param {() => number} [options.now] injectable clock (ms)
 * @param {number} [options.rateChargeTtlMs] how long one upload's paid rate charge is remembered
 */
export function createDirectUploadLimiter({
  ratePerMinute = DIRECT_UPLOAD_LIMIT_DEFAULTS.ratePerMinute,
  maxConcurrentPerCredential = DIRECT_UPLOAD_LIMIT_DEFAULTS.maxConcurrentPerCredential,
  maxConcurrentGlobal = DIRECT_UPLOAD_LIMIT_DEFAULTS.maxConcurrentGlobal,
  now = Date.now,
  rateChargeTtlMs = RATE_CHARGE_TTL_MS,
} = {}) {
  const capacity = Math.max(1, Math.floor(Number(ratePerMinute) || DIRECT_UPLOAD_LIMIT_DEFAULTS.ratePerMinute));
  const perCredential = Math.max(1, Math.floor(Number(maxConcurrentPerCredential) || DIRECT_UPLOAD_LIMIT_DEFAULTS.maxConcurrentPerCredential));
  const global = Math.max(1, Math.floor(Number(maxConcurrentGlobal) || DIRECT_UPLOAD_LIMIT_DEFAULTS.maxConcurrentGlobal));
  const chargeTtlMs = Math.max(1_000, Math.floor(Number(rateChargeTtlMs) || RATE_CHARGE_TTL_MS));
  const refillPerSecond = capacity / 60;
  const buckets = new Map();
  const inflight = new Map();
  // credential key -> (uploadId -> paidAt). Nested so no delimiter can collide two keys.
  const paidCharges = new Map();
  let inflightTotal = 0;
  let paidTotal = 0;

  function prunePaid(at) {
    if (paidCharges.size <= PRUNE_THRESHOLD) return;
    for (const [key, paid] of paidCharges) {
      for (const [uploadId, paidAt] of paid) {
        if (at - paidAt >= chargeTtlMs) { paid.delete(uploadId); paidTotal -= 1; }
      }
      if (paid.size === 0) paidCharges.delete(key);
    }
  }

  function prune(at) {
    if (buckets.size <= PRUNE_THRESHOLD) return;
    for (const [key, bucket] of buckets) {
      if (bucket.tokens >= capacity && at - bucket.updatedAt >= PRUNE_IDLE_MS) buckets.delete(key);
    }
  }

  function bucketFor(key, at) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: at };
      buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSeconds = Math.max(0, at - bucket.updatedAt) / 1000;
    if (elapsedSeconds > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
      bucket.updatedAt = at;
    }
    return bucket;
  }

  return {
    /** Consume one request slot. Never touches in-flight state. */
    rateLimit(key) {
      const at = now();
      prune(at);
      const bucket = bucketFor(key, at);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, remaining: Math.floor(bucket.tokens) };
      }
      const retryAfterSeconds = Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / capacity));
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    },

    /**
     * Claim an in-flight PUT slot. The returned `release` is idempotent and must run on every exit
     * path (success, rejection, client abort); a leaked claim would keep answering 429 forever.
     */
    acquire(key) {
      if (inflightTotal >= global) {
        return { allowed: false, reason: "global", retryAfterSeconds: 1 };
      }
      const held = inflight.get(key) || 0;
      if (held >= perCredential) {
        return { allowed: false, reason: "credential", retryAfterSeconds: 1 };
      }
      inflight.set(key, held + 1);
      inflightTotal += 1;
      let released = false;
      return {
        allowed: true,
        release() {
          if (released) return;
          released = true;
          const remaining = (inflight.get(key) || 1) - 1;
          if (remaining <= 0) inflight.delete(key);
          else inflight.set(key, remaining);
          inflightTotal = Math.max(0, inflightTotal - 1);
        },
      };
    },

    /**
     * Has this upload already paid its rate token? (Issue #698.) Keyed by BOTH the credential and
     * the uploadId: a new handle is a new upload and still spends a token.
     */
    rateChargeHeld(key, uploadId) {
      if (typeof uploadId !== "string" || uploadId === "") return false;
      const at = now();
      prunePaid(at);
      const paid = paidCharges.get(key);
      const paidAt = paid?.get(uploadId);
      if (paidAt === undefined) return false;
      if (at - paidAt >= chargeTtlMs) {
        paid.delete(uploadId);
        paidTotal -= 1;
        if (paid.size === 0) paidCharges.delete(key);
        return false;
      }
      return true;
    },

    /**
     * Remember that `uploadId` holds a rate token for `key`. The router only calls this after the
     * handle was located and confirmed to belong to the caller with the direct-upload mode, so a
     * guessed or foreign `uploadId` cannot buy an unlimited number of uncharged requests.
     */
    recordRateCharge(key, uploadId) {
      if (typeof uploadId !== "string" || uploadId === "") return;
      const at = now();
      prunePaid(at);
      let paid = paidCharges.get(key);
      if (!paid) { paid = new Map(); paidCharges.set(key, paid); }
      if (!paid.has(uploadId)) paidTotal += 1;
      paid.set(uploadId, at);
    },

    /** Read-only view for tests/diagnostics; no credential or IP is exposed. */
    snapshot() {
      return { capacity, perCredential, global, buckets: buckets.size, inflightKeys: inflight.size, inflightTotal, paidUploads: paidTotal };
    },
  };
}

// Delay codes carried by the timeout errors. They are the `code` field of the HTTP error body and
// of the audit line, so the operator can tell a stalled client from an over-long one.
export const DIRECT_UPLOAD_TIMEOUT_CODES = Object.freeze({
  idle: "upload_idle_timeout",
  duration: "upload_max_duration",
});

/**
 * Bound one upload body in TIME (issue #470 follow-up, task B).
 *
 * Why a stream guard instead of `server.requestTimeout` / `headersTimeout` / `timeout`: those are
 * process-wide, and `POST /mcp` legitimately keeps an SSE stream open for tens of minutes. Bounding
 * the process would cut healthy sessions; bounding this one body does not. The guard therefore owns
 * nothing but the body it is handed.
 *
 * Mechanics — the source (`req`) is piped into an internal `PassThrough` and the runtime streams
 * THAT. Backpressure is preserved (`pipe` pauses the socket when the inner stream is full), and a
 * timeout can destroy the inner stream without touching the socket, which is what still lets the
 * router answer `408` to the client. Destroying `req` itself would kill the socket first.
 *
 * - `idleTimeoutMs`: no NEW byte for that long ⇒ fire the idle code. Armed at the start of the body
 *   (a client that never sends a byte is idle too) and re-armed on every chunk.
 * - `maxDurationMs`: total wall clock from the FIRST byte ⇒ fire the duration code. Not armed before
 *   the first byte: a request that never starts is the idle case, and counting from handle creation
 *   would punish a client that legitimately waited for its turn.
 *
 * `0` disables either bound. A client that goes away mid-body is NOT a timeout (no `408` for a
 * socket nobody reads); it keeps the existing interruption semantics instead, which is why the
 * source's departure is forwarded to the inner stream explicitly (see `propagateSourceGone`).
 *
 * @param {object} options
 * @param {import("node:stream").Readable} options.stream the request body (or any readable)
 * @param {number} [options.idleTimeoutMs]
 * @param {number} [options.maxDurationMs]
 * @param {(source: import("node:stream").Readable) => boolean} [options.clientDisconnected]
 * @returns {{ body: PassThrough, dispose: () => void, timedOut: () => string|null, firstByteAt: () => number|null }}
 */
export function createUploadStreamGuard({
  stream,
  idleTimeoutMs = 0,
  maxDurationMs = 0,
  clientDisconnected = (source) => source?.destroyed === true || source?.readableEnded === true,
} = {}) {
  if (!stream || typeof stream.on !== "function" || typeof stream.pipe !== "function") {
    throw new Error("[direct_upload_invalid] createUploadStreamGuard requires a readable stream");
  }
  const body = new PassThrough();
  let idleTimer = null;
  let durationTimer = null;
  let firstByteAt = null;
  let timedOut = null;
  let disposed = false;

  // The runtime streams `body`, not `req`, and `pipe()` does NOT forward a source that dies
  // mid-body (it only unpipes). A `PassThrough` nobody ends or destroys therefore stays open
  // forever, so the runtime's `pipeline` would never settle: no `markFailed`, no audit line, no
  // writer-lock release, and one leaked `.part` write handle per abort. The guard therefore has to
  // forward the source's departure itself; this listener is deliberately persistent (not `once`)
  // so an `error` on a source that outlives `dispose()` still cannot become an uncaught exception.
  body.on("error", () => {});

  function clearTimers() {
    if (idleTimer) clearTimeout(idleTimer);
    if (durationTimer) clearTimeout(durationTimer);
    idleTimer = null;
    durationTimer = null;
  }

  /**
   * The source left before its body completed ⇒ reject the inner stream, so `pipeline` settles and
   * the runtime's existing interruption path runs (`markFailed("interrupted")`, the router's
   * `deny/503/<code>` audit line, the writer-lock release in its `finally`).
   *
   * The code is the source's own when it carries one (`ECONNRESET` from a destroyed socket, i.e.
   * byte-for-byte what the pre-guard `pipeline(req, …)` reported) and `ECONNRESET` otherwise.
   */
  function propagateSourceGone(cause) {
    if (disposed || body.destroyed) return;
    clearTimers();
    // Normal completion: `end` was reached and `pipe` ends the body on its own.
    if (stream.readableEnded) return;
    const code = typeof cause?.code === "string" && cause.code ? cause.code : "ECONNRESET";
    body.destroy(Object.assign(new Error("The client disconnected before the upload body was complete"), { code }));
  }

  function fire(code, message) {
    if (disposed || timedOut) return;
    // The socket is already gone: not our error to report, and `res` may not even be writable. The
    // interruption is reported by `propagateSourceGone`, never as a `408`.
    if (clientDisconnected(stream)) { clearTimers(); return; }
    timedOut = code;
    clearTimers();
    body.destroy(Object.assign(new Error(message), { code }));
  }

  function armIdle() {
    if (!(idleTimeoutMs > 0) || disposed || timedOut || body.destroyed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      fire(DIRECT_UPLOAD_TIMEOUT_CODES.idle, `No upload byte arrived for ${idleTimeoutMs} ms; the upload was aborted`);
    }, idleTimeoutMs);
  }

  function onChunk() {
    if (disposed || timedOut) return;
    if (firstByteAt === null) {
      firstByteAt = Date.now();
      if (maxDurationMs > 0) {
        durationTimer = setTimeout(() => {
          durationTimer = null;
          fire(DIRECT_UPLOAD_TIMEOUT_CODES.duration, `Upload exceeded the ${maxDurationMs} ms total duration; the upload was aborted`);
        }, maxDurationMs);
      }
    }
    armIdle();
  }

  stream.on("data", onChunk);
  stream.on("error", (error) => propagateSourceGone(error));
  stream.on("close", () => propagateSourceGone(stream.errored ?? null));
  stream.pipe(body);
  armIdle();
  // The socket can already be gone when the guard is built: the router awaits the handle lookup and
  // the disk-headroom check first, and a `close` that fired inside that window never reaches the
  // listener above. `pipe()` from an already-dead source is a no-op (it does not end or error the
  // destination), so without this the inner stream would never settle again — before the guard
  // existed, `pipeline(req, …)` simply rejected in this situation.
  if (stream.destroyed || stream.errored) propagateSourceGone(stream.errored ?? null);

  return {
    body,
    timedOut: () => timedOut,
    firstByteAt: () => firstByteAt,
    /** Clear both timers and detach. Safe to call twice; must run on every exit path. */
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      stream.off("data", onChunk);
      if (!stream.destroyed) stream.unpipe(body);
    },
  };
}

/**
 * Staging-disk headroom gate. `dir` is the owning Vault's `transfersUploads` root.
 *
 * `statfs` failure (unsupported filesystem, EACCES, a race on the just-created root) fails OPEN and
 * is reported as `unknown` so the caller can put `freeBytesUnknown: true` into the audit line: a
 * monitoring gap must not become a second outage that rejects every upload. The explicit 507 is
 * reserved for a *measured* shortage.
 */
export async function checkDiskHeadroom({ dir, minFreeBytes, statfs = fs.statfs } = {}) {
  if (!Number.isFinite(minFreeBytes) || minFreeBytes <= 0) {
    return { ok: true, checked: false, unknown: false, freeBytes: null };
  }
  if (typeof dir !== "string" || dir === "") {
    return { ok: true, checked: false, unknown: true, freeBytes: null };
  }
  const read = typeof statfs === "function" ? statfs : fs.statfs;
  try {
    const stats = await read(dir);
    const freeBytes = Number(stats?.bavail) * Number(stats?.bsize);
    if (!Number.isFinite(freeBytes)) {
      return { ok: true, checked: true, unknown: true, freeBytes: null };
    }
    return { ok: freeBytes >= minFreeBytes, checked: true, unknown: false, freeBytes };
  } catch {
    return { ok: true, checked: true, unknown: true, freeBytes: null };
  }
}
