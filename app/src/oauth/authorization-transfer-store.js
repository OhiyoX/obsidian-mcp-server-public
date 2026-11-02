// #364 durable authorization-transfer store.
//
// Owns the ONLY durable record of an OAuth client authorization transfer between
// two local accounts, and the per-`(clientId, userId)` revocation generation the
// transfer fence is built on. It is deliberately a separate module: the fence
// must NOT depend on the optional AuthZ runtime (`oauthHardRevoke`) and must NOT
// be expressible through the main OAuth state file, whose writes are file-atomic
// but not business-atomic (contract §1.6 / §4.2, ruling §17-4).
//
// Durability contract:
// - every mutation is a whole-file temp + `rename()` replacement in the same
//   directory, `mode 0600`, mirroring `oauth/persistence-methods.js::save()`;
// - mutations are serialized through one promise queue, and the committed state is
//   only ever replaced by a candidate that was **already written to disk**:
//   clone → mutate the clone → persist the clone → publish it. A reader can never
//   observe (or act on) a fence whose rename() has not returned, a mutator that
//   throws cannot publish a partial edit, and a failed write publishes nothing at
//   all. "Durable fence" and "in-memory fence" therefore never diverge — not even
//   in the safe over-deny direction;
// - a corrupt / unknown-version / malformed file — including records that
//   contradict each other (see `validateCrossRecords`) — makes `ready` reject and
//   `isHealthy()` false; the caller must refuse admission (server.js awaits
//   `provider.ready`), and the fence query fails closed while unhealthy;
// - nothing bearer-shaped is ever persisted: ids, accounts, statuses, times.
//
// Generation semantics (contract §4.1 as amended by ruling §17-1/§17-4):
// - `generations[<clientId>\0<userId>]` is a monotonically increasing counter.
//   A pair with no record is generation 0;
// - an issued access/refresh token and an unconsumed authorization code carry the
//   generation that was current when it was minted, and a credential is only
//   valid while its generation EQUALS the pair's current generation;
// - `begin()` increments the pair's generation, which permanently invalidates
//   every credential minted before the fence, while a fresh normal login +
//   consent for the same pair mints credentials at the new generation;
// - because issuance inherits the *source credential's* generation, a concurrent
//   exchange can never "upgrade" an old code/refresh across the boundary. The
//   guarantee is structural (equality on a shared counter), not a timestamp
//   comparison — see `authorization-transfer-runtime.js`.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeGeneration, pairGenerationKey, parsePairGenerationKey } from "./authorization-transfer-runtime.js";

export const AUTHORIZATION_TRANSFER_SCHEMA_VERSION = 1;
export const AUTHORIZATION_TRANSFER_PENDING_TTL_MS = 15 * 60 * 1000;
export const AUTHORIZATION_TRANSFER_STATUSES = Object.freeze(["pending", "completed", "cancelled", "expired"]);

const STATUS_SET = new Set(AUTHORIZATION_TRANSFER_STATUSES);

/** Typed store failure. `code` is stable for callers; `status` is the §5 HTTP hint. */
export class AuthorizationTransferStoreError extends Error {
  constructor(code, message, { status = 500 } = {}) {
    super(message);
    this.name = "AuthorizationTransferStoreError";
    this.code = code;
    this.status = status;
  }
}

function unavailable(message) {
  return new AuthorizationTransferStoreError("unavailable", message, { status: 503 });
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message) {
  return new AuthorizationTransferStoreError("corrupt", message, { status: 503 });
}

function clone(value) {
  return structuredClone(value);
}

function emptyState() {
  return { version: AUTHORIZATION_TRANSFER_SCHEMA_VERSION, generations: {}, transfers: {} };
}

function requireString(value, label, { pattern = null } = {}) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`transfer ${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) throw invalid(`transfer ${label} has an invalid form`);
  return value;
}

function requireIsoTime(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid(`transfer ${label} must be an ISO timestamp`);
  return value;
}

/**
 * Cross-record consistency. A well-formed document can still be self-contradictory,
 * and the dangerous shape is silent: a `generation >= 1` transfer whose
 * `generations` record is missing (or behind) would make every old-generation
 * credential of that pair look unfenced. Refuse admission instead.
 */
function validateCrossRecords(parsed) {
  const pendingSources = new Set();
  const pendingTargets = new Set();
  const highestGeneration = new Map();
  for (const transfer of Object.values(parsed.transfers)) {
    const pairKey = pairGenerationKey(transfer.clientId, transfer.sourceUserId);
    highestGeneration.set(pairKey, Math.max(highestGeneration.get(pairKey) ?? 0, transfer.generation));
    if (transfer.status !== "pending") continue;
    const sourceKey = pairGenerationKey(transfer.clientId, transfer.sourceUserId);
    const targetKey = pairGenerationKey(transfer.clientId, transfer.targetUserId);
    if (pendingSources.has(sourceKey)) throw invalid("at most one pending transfer is allowed per (client, source account)");
    if (pendingTargets.has(targetKey)) throw invalid("at most one pending transfer is allowed per (client, target account)");
    pendingSources.add(sourceKey);
    pendingTargets.add(targetKey);
  }
  for (const [pairKey, generation] of highestGeneration) {
    const entry = parsed.generations[pairKey];
    if (!entry) throw invalid(`the fence generation for ${pairKey} is missing while transfer history references it`);
    if (normalizeGeneration(entry.generation) < generation) throw invalid(`the fence generation for ${pairKey} is behind its transfer history`);
  }
  for (const [key, entry] of Object.entries(parsed.generations)) {
    if (!entry?.transferId) continue;
    const pair = parsePairGenerationKey(key);
    const transfer = parsed.transfers[entry.transferId];
    if (!transfer) throw invalid(`generation ${key} references an unknown transfer`);
    if (transfer.clientId !== pair[0] || transfer.sourceUserId !== pair[1]) throw invalid(`generation ${key} references a transfer of a different pair`);
  }
}

function validateState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("transfer store must be a JSON object");
  if (parsed.version !== AUTHORIZATION_TRANSFER_SCHEMA_VERSION) {
    throw new AuthorizationTransferStoreError(
      "unsupported_version",
      `unsupported transfer store version: ${String(parsed.version)}`,
      { status: 503 },
    );
  }
  if (!parsed.transfers || typeof parsed.transfers !== "object" || Array.isArray(parsed.transfers)) throw invalid("transfer store `transfers` must be an object");
  if (!parsed.generations || typeof parsed.generations !== "object" || Array.isArray(parsed.generations)) throw invalid("transfer store `generations` must be an object");
  for (const [key, entry] of Object.entries(parsed.generations)) {
    if (!parsePairGenerationKey(key)) throw invalid("generation key must encode `[clientId, userId]`");
    if (!Number.isInteger(entry?.generation) || entry.generation < 1) throw invalid(`generation for ${key} must be a positive integer`);
    if (entry.transferId !== undefined && entry.transferId !== null && typeof entry.transferId !== "string") throw invalid(`generation ${key} transferId must be a string`);
    if (entry.revokedAt !== undefined && entry.revokedAt !== null) requireIsoTime(entry.revokedAt, "generation revokedAt");
  }
  for (const [id, transfer] of Object.entries(parsed.transfers)) {
    if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) throw invalid(`transfer ${id} must be an object`);
    if (transfer.id !== id) throw invalid(`transfer ${id} id does not match its key`);
    requireString(transfer.clientId, "clientId");
    requireString(transfer.sourceUserId, "sourceUserId");
    requireString(transfer.targetUserId, "targetUserId");
    if (!STATUS_SET.has(transfer.status)) throw invalid(`transfer ${id} status is invalid`);
    requireIsoTime(transfer.createdAt, "createdAt");
    requireIsoTime(transfer.expiresAt, "expiresAt");
    if (!Number.isInteger(transfer.generation) || transfer.generation < 1) throw invalid(`transfer ${id} generation must be a positive integer`);
    if (transfer.sourceRevokedAt !== undefined && transfer.sourceRevokedAt !== null) requireIsoTime(transfer.sourceRevokedAt, "sourceRevokedAt");
    if (transfer.completedAt !== undefined && transfer.completedAt !== null) requireIsoTime(transfer.completedAt, "completedAt");
    if (transfer.cancelledAt !== undefined && transfer.cancelledAt !== null) requireIsoTime(transfer.cancelledAt, "cancelledAt");
  }
  validateCrossRecords(parsed);
}

/**
 * `createAuthorizationTransferStore({ file, ttlMs, now, fsModule, generateId })`.
 *
 * `file`        : absolute path of `DATA_PATH/oauth/transfers.json` (owned by the caller so
 *                 the `DATA_PATH` literal stays in `oauth-provider.js`).
 * `ttlMs`       : pending completion TTL (contract v1: 15 minutes).
 * `now`         : injectable clock (epoch ms) so expiry tests never sleep.
 * `fsModule`    : injectable fs seam for write/rename fault injection.
 * `generateId`  : injectable id factory (tests assert deterministic ids).
 */
export function createAuthorizationTransferStore({
  file,
  ttlMs = AUTHORIZATION_TRANSFER_PENDING_TTL_MS,
  now = () => Date.now(),
  fsModule = fs,
  generateId = () => randomUUID(),
} = {}) {
  if (typeof file !== "string" || !file.trim()) throw new Error("createAuthorizationTransferStore requires a file path");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("createAuthorizationTransferStore ttlMs must be a positive number");

  let state = emptyState();
  let healthy = false;
  let tail = Promise.resolve();
  let persistCount = 0;

  function enqueue(work) {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function persist(candidate) {
    const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await fsModule.writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsModule.rename(temporary, file);
      await fsModule.chmod(file, 0o600).catch(() => {});
      persistCount += 1;
    } catch (error) {
      await fsModule.rm(temporary, { force: true }).catch(() => {});
      throw unavailable(`authorization transfer store is not writable: ${message(error)}`);
    }
  }

  // Whole-file mutation under one queue: clone → mutate the clone → durable write →
  // publish. The published `state` is only ever replaced by a candidate whose
  // rename() already returned, so an observer (including a concurrent duplicate
  // request) can never read a fence that is not durable yet, a mutator rejection
  // cannot leave a half-mutated published state, and a failed write publishes
  // nothing. A mutator that returns `persist: false` must not have mutated the
  // candidate (that is the read-only idempotent path).
  function mutate(mutator) {
    return enqueue(async () => {
      const candidate = clone(state);
      const outcome = mutator(candidate);
      if (!outcome || outcome.persist === false) return outcome ? outcome.value : undefined;
      await persist(candidate);
      state = candidate;
      return outcome.value;
    });
  }

  const ready = (async () => {
    try {
      await fsModule.mkdir(path.dirname(file), { recursive: true });
    } catch (error) {
      healthy = false;
      throw unavailable(`authorization transfer store directory is not creatable: ${message(error)}`);
    }
    /** @type {string} */
    let raw;
    try {
      raw = await fsModule.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        const fresh = emptyState();
        await enqueue(async () => { await persist(fresh); });
        state = fresh;
        healthy = true;
        return;
      }
      healthy = false;
      throw unavailable(`authorization transfer store is unreadable: ${message(error)}`);
    }
    try {
      const parsed = JSON.parse(raw);
      validateState(parsed);
      state = {
        version: AUTHORIZATION_TRANSFER_SCHEMA_VERSION,
        generations: parsed.generations,
        transfers: parsed.transfers,
      };
      healthy = true;
    } catch (error) {
      healthy = false;
      if (error instanceof AuthorizationTransferStoreError) throw error;
      throw invalid(`authorization transfer store is corrupt: ${message(error)}`);
    }
  })();

  function view() {
    return state;
  }

  function pendingIn(candidateState, clientId, userId, field) {
    return Object.values(candidateState.transfers)
      .filter((transfer) => transfer.status === "pending" && transfer.clientId === clientId && transfer[field] === userId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0] || null;
  }

  function expireStale(candidateState) {
    const stamp = now();
    const expired = [];
    for (const transfer of Object.values(candidateState.transfers)) {
      if (transfer.status !== "pending" || Date.parse(transfer.expiresAt) > stamp) continue;
      transfer.status = "expired";
      transfer.cancelledAt = new Date(stamp).toISOString();
      transfer.closedReason = "expired";
      expired.push(clone(transfer));
    }
    return expired;
  }

  return {
    file,
    ttlMs,
    ready,
    isHealthy: () => healthy,
    /** Live read-only view of the persisted state. Callers must not mutate it. */
    view,
    snapshot: () => clone(state),
    persistCount: () => persistCount,

    getTransfer(id) {
      const transfer = state.transfers[id];
      return transfer ? clone(transfer) : null;
    },

    pendingForSource(clientId, sourceUserId) {
      const transfer = pendingIn(state, clientId, sourceUserId, "sourceUserId");
      return transfer ? clone(transfer) : null;
    },

    pendingForTarget(clientId, targetUserId) {
      const transfer = pendingIn(state, clientId, targetUserId, "targetUserId");
      return transfer ? clone(transfer) : null;
    },

    /**
     * Durably create the `(clientId, sourceUserId)` fence + one pending transfer.
     * - same source + same target with a live pending ⇒ idempotent reuse (no new
     *   record, no second generation bump);
     * - same source + different live pending target, or another live pending for
     *   the same target ⇒ `conflict` with ZERO fence/record side effects;
     * - stale pendings of the same pair are expired first and returned as
     *   `expired`, so they can be audited.
     */
    async begin({ clientId, sourceUserId, targetUserId } = {}) {
      requireString(clientId, "clientId");
      requireString(sourceUserId, "sourceUserId");
      requireString(targetUserId, "targetUserId");
      if (sourceUserId === targetUserId) throw new AuthorizationTransferStoreError("invalid_request", "source and target must differ", { status: 400 });
      return mutate((candidate) => {
        const expired = expireStale(candidate);
        const existing = pendingIn(candidate, clientId, sourceUserId, "sourceUserId");
        if (existing && existing.targetUserId === targetUserId) {
          return { persist: expired.length > 0, value: { transfer: clone(existing), reused: true, expired } };
        }
        if (existing) {
          throw new AuthorizationTransferStoreError("conflict", "the source account already has a pending transfer to a different target", { status: 409 });
        }
        if (pendingIn(candidate, clientId, targetUserId, "targetUserId")) {
          throw new AuthorizationTransferStoreError("conflict", "the target account already has a pending transfer for this client", { status: 409 });
        }
        const stamp = now();
        const id = generateId();
        const key = pairGenerationKey(clientId, sourceUserId);
        const generation = normalizeGeneration(candidate.generations[key]?.generation) + 1;
        const transfer = {
          id,
          clientId,
          sourceUserId,
          targetUserId,
          status: "pending",
          generation,
          sourceRevokedAt: new Date(stamp).toISOString(),
          createdAt: new Date(stamp).toISOString(),
          expiresAt: new Date(stamp + ttlMs).toISOString(),
          completedAt: null,
          cancelledAt: null,
          closedReason: null,
          completionUserId: null,
          lastErrorCode: null,
        };
        candidate.generations[key] = { generation, transferId: id, revokedAt: transfer.sourceRevokedAt };
        candidate.transfers[id] = transfer;
        return { value: { transfer: clone(transfer), reused: false, expired } };
      });
    },

    /** Cancel a pending completion intent. Never restores the source's credentials. */
    async cancel(id, { reason = "cancelled" } = {}) {
      requireString(id, "id", { pattern: /^[A-Za-z0-9._:-]{1,128}$/ });
      return mutate((candidate) => {
        const transfer = candidate.transfers[id];
        if (!transfer) throw new AuthorizationTransferStoreError("not_found", "unknown authorization transfer", { status: 404 });
        if (transfer.status !== "pending") return { persist: false, value: { changed: false, transfer: clone(transfer), reason: "not_pending" } };
        transfer.status = "cancelled";
        transfer.cancelledAt = new Date(now()).toISOString();
        transfer.closedReason = reason;
        return { value: { changed: true, transfer: clone(transfer), reason } };
      });
    },

    /**
     * Mark a pending transfer completed. Only a `pending` intent that is still
     * inside its TTL may complete: a cancelled or expired intent can never be
     * revived by a stale request, and the deadline is re-checked **inside the
     * serialized section** so a completion that was queued while the intent was
     * live still cannot land after it expired.
     */
    async complete(id, { completionUserId } = {}) {
      requireString(id, "id", { pattern: /^[A-Za-z0-9._:-]{1,128}$/ });
      requireString(completionUserId, "completionUserId");
      return mutate((candidate) => {
        const transfer = candidate.transfers[id];
        if (!transfer) throw new AuthorizationTransferStoreError("not_found", "unknown authorization transfer", { status: 404 });
        if (transfer.status !== "pending") return { persist: false, value: { changed: false, transfer: clone(transfer), reason: "not_pending" } };
        if (Date.parse(transfer.expiresAt) <= now()) {
          const stamp = new Date(now()).toISOString();
          transfer.status = "expired";
          transfer.cancelledAt = stamp;
          transfer.closedReason = "expired";
          return { value: { changed: false, transfer: clone(transfer), reason: "expired" } };
        }
        if (transfer.targetUserId !== completionUserId) {
          throw new AuthorizationTransferStoreError("invalid_request", "completion account does not match the transfer target", { status: 400 });
        }
        transfer.status = "completed";
        transfer.completedAt = new Date(now()).toISOString();
        transfer.completionUserId = completionUserId;
        return { value: { changed: true, transfer: clone(transfer), reason: "completed" } };
      });
    },

    /** Expire every pending transfer past its TTL. Returns the expired records. */
    async sweepExpired() {
      return mutate((candidate) => {
        const expired = expireStale(candidate);
        return { persist: expired.length > 0, value: expired };
      });
    },
  };
}
