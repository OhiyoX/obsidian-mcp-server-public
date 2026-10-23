// #364 authorization-transfer provider methods.
//
// Mixed into `PersistentOAuthProvider.prototype` exactly like `persistenceMethods`
// and `protocolMethods`, so the transfer service shares the ONE in-memory OAuth
// account/token state and the ONE audit trail instead of keeping a parallel view.
// The durable fence itself lives in `authorization-transfer-store.js`; the pure
// algebra lives in `authorization-transfer-runtime.js`; the protocol gates
// (verify / refresh / code exchange) call the small helpers exported here.
//
// Contract map:
// - I02 / §4.2: `beginAuthorizationTransfer` returns only after the fence is
//   durable, and the fence is consulted before any credential is consumed;
// - I04 / §4.3: `revokeClientUserGrants` is pair-scoped, never whole-user or
//   whole-client;
// - I06 / §17-5: `closeTransferSessions` returns a VERIFIABLE close result
//   (matched/closed/failed/sessionIds/failures) and audits failures without ever
//   lifting the fence;
// - I08 / I09: conflict detection happens before the fence write and before the
//   source revoke, and is repeated inside the store's serialized section;
// - I11 / §6: audit events carry ids and status only — never a bearer, secret,
//   password, or authorization code;
// - §4.4: completion is driven by the normal OAuth exchange hook
//   (`noteAuthorizationTransferCompletion`), never by an Admin-side synthesis.

import path from "node:path";

import {
  evaluateCredentialFence,
  findCompletionCandidate,
  normalizeGeneration,
  pairGenerationKey,
  transferRecords,
  transferStateView,
} from "./authorization-transfer-runtime.js";
import { createAuthorizationTransferStore } from "./authorization-transfer-store.js";

/**
 * Resolve the #364 fence store: the caller's instance when supplied (tests / custom
 * wiring), otherwise `transfers.json` beside the OAuth state file it fences. Keeping
 * the derivation here (rather than in `oauth-provider.js`) keeps that entry point inside
 * its line budget and keeps every `DATA_PATH/oauth` literal where it already lived.
 */
export function resolveAuthorizationTransferStore(provided, stateFile) {
  return provided ?? createAuthorizationTransferStore({ file: path.join(path.dirname(stateFile), "transfers.json") });
}

export const AUTHORIZATION_TRANSFER_EVENTS = Object.freeze({
  begin: "oauth.client.transfer.begin",
  sourceRevokeSyncFailed: "oauth.client.transfer.source_revoke_sync_failed",
  complete: "oauth.client.transfer.complete",
  completeFailed: "oauth.client.transfer.complete_failed",
  cancel: "oauth.client.transfer.cancel",
  expire: "oauth.client.transfer.expire",
  sessionCloseFailed: "oauth.client.transfer.session_close_failed",
  deny: "oauth.client.transfer.deny",
});

/** Typed transfer failure. `status` is the frozen §5.2 HTTP mapping for slice 2. */
export class AuthorizationTransferError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "AuthorizationTransferError";
    this.code = code;
    this.status = status;
  }
}

function detail(error, limit = 240) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? text.slice(0, limit) : text;
}

function livePending(state, clientId, userId, field, now) {
  return Object.values(state?.transfers || {})
    .filter((transfer) => transfer?.status === "pending"
      && transfer.clientId === clientId
      && transfer[field] === userId
      && Date.parse(transfer.expiresAt) > now)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0] || null;
}

export const authorizationTransferMethods = {
  // ---- fence queries (called from the protocol gates) ----------------------

  /** Read-only fence decision for one credential record. Fails closed when degraded. */
  credentialFence(record) {
    const { state, degraded } = transferStateView(this.transferStore);
    return evaluateCredentialFence({
      state,
      degraded,
      clientId: record?.clientId ?? null,
      userId: record?.userId ?? null,
      generation: record?.generation,
    });
  },

  isCredentialFenced(record) {
    return this.credentialFence(record).fenced === true;
  },

  /** Pair generation a freshly minted credential must carry. */
  currentPairGenerationFor(clientId, userId) {
    const { state } = transferStateView(this.transferStore);
    return normalizeGeneration(state?.generations?.[pairGenerationKey(clientId, userId)]?.generation);
  },

  /** Current authorization for one exact pair, mirroring the Admin projection's `active`. */
  hasActiveAuthorization(clientId, userId) {
    if (!clientId || !userId) return false;
    const now = Date.now();
    for (const collection of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const record of Object.values(collection)) {
        if (record.clientId !== clientId || record.userId !== userId) continue;
        if (record.revokedAt || record.expiresAt <= now) continue;
        if (collection === this.data.refreshTokens && record.usedAt) continue;
        if (this.isCredentialFenced(record)) continue;
        return true;
      }
    }
    return false;
  },

  /** Audit helper: a fenced credential was refused on the token endpoint. */
  recordFencedCredentialDeny({ clientId, userId, credentialType, credentialId = null, surface = "oauth" }) {
    this.recordAudit({
      action: AUTHORIZATION_TRANSFER_EVENTS.deny,
      outcome: "failure",
      surface,
      credentialType,
      ...(credentialId ? { credentialId } : {}),
      clientId: clientId ?? null,
      userId: userId ?? null,
      detail: "credential generation precedes the durable transfer fence",
    });
  },

  // ---- pair-scoped revoke (I04 / §4.3) ------------------------------------

  /**
   * Revoke ONLY `(clientId, userId)`: matching access tokens, matching refresh
   * tokens and matching unconsumed authorization codes. Pure in-memory; the
   * caller owns persistence (mirrors `revokeUserGrantsInMemory`).
   */
  revokeClientUserGrants(clientId, userId) {
    const revokedAt = new Date().toISOString();
    const revokedTokenIds = [];
    for (const collection of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const record of Object.values(collection)) {
        if (record.clientId !== clientId || record.userId !== userId || record.revokedAt) continue;
        record.revokedAt = revokedAt;
        revokedTokenIds.push(record.id);
      }
    }
    let removedCodeCount = 0;
    for (const [key, record] of Object.entries(this.data.codes)) {
      if (record.clientId !== clientId || record.userId !== userId) continue;
      delete this.data.codes[key];
      removedCodeCount += 1;
    }
    return {
      clientId,
      userId,
      revokedAt,
      changed: revokedTokenIds.length > 0 || removedCodeCount > 0,
      revokedTokenIds,
      removedCodeCount,
    };
  },

  // ---- session close result (I06 / §17-5) ---------------------------------

  /**
   * Close the live MCP transports of exactly `(clientId, userId)` and return a
   * verifiable result. A failure is audited and surfaced, never rolled back and
   * never allowed to lift the fence.
   */
  async closeTransferSessions({ clientId, userId, transferId = null } = {}) {
    const unavailable = typeof this.closeSessions !== "function";
    let raw = null;
    let thrown = null;
    if (!unavailable) {
      try {
        raw = await this.closeSessions(clientId, { userId });
      } catch (error) {
        thrown = error;
      }
    }
    const failures = Array.isArray(raw?.failures) ? raw.failures.slice(0, 20) : [];
    if (thrown) failures.push({ sessionId: null, error: detail(thrown) });
    const result = {
      clientId,
      userId,
      unavailable,
      matched: Number.isFinite(raw?.matched) ? raw.matched : 0,
      closed: Number.isFinite(raw?.closed) ? raw.closed : 0,
      failed: (Number.isFinite(raw?.failed) ? raw.failed : 0) + (thrown ? 1 : 0),
      sessionIds: Array.isArray(raw?.sessionIds) ? raw.sessionIds.slice(0, 50) : [],
      failures,
    };
    if (result.unavailable || result.failed > 0) {
      this.recordAudit({
        action: AUTHORIZATION_TRANSFER_EVENTS.sessionCloseFailed,
        outcome: "failure",
        credentialType: "oauth-client",
        clientId: clientId ?? null,
        userId: userId ?? null,
        ...(transferId ? { transferId } : {}),
        detail: `unavailable=${result.unavailable}; matched=${result.matched}; closed=${result.closed}; failed=${result.failed}`,
      });
    }
    return result;
  },

  // ---- begin / cancel / expiry --------------------------------------------

  transferErrorFrom(error) {
    if (error instanceof AuthorizationTransferError) return error;
    switch (error?.code) {
      case "conflict":
        return new AuthorizationTransferError("conflict", 409, "A transfer for this client and source account already exists");
      case "not_found":
        return new AuthorizationTransferError("not_found", 404, "Unknown authorization transfer");
      case "invalid_request":
        return new AuthorizationTransferError("invalid_request", 400, error.message);
      default:
        return new AuthorizationTransferError("unavailable", 503, "Authorization transfer store is unavailable");
    }
  },

  /**
   * Begin `(clientId, sourceUserId) -> targetUserId`.
   * Resolves only after the durable fence exists. Throws `AuthorizationTransferError`
   * (400/404/409/503) with zero fence/revoke side effects on every rejection.
   */
  async beginAuthorizationTransfer({ clientId, sourceUserId, targetUserId, actor = null, source = null, userAgent = null } = {}) {
    await this.ready;
    const store = this.transferStore;
    if (!store) throw new AuthorizationTransferError("unavailable", 503, "Authorization transfer store is not configured");
    for (const [label, value] of [["clientId", clientId], ["sourceUserId", sourceUserId], ["targetUserId", targetUserId]]) {
      if (typeof value !== "string" || !value.trim()) throw new AuthorizationTransferError("invalid_request", 400, `${label} is required`);
    }
    if (sourceUserId === targetUserId) throw new AuthorizationTransferError("invalid_request", 400, "source and target accounts must differ");
    const now = Date.now();
    // Reads only from here to the durable begin: duplicate submits are idempotent
    // and every conflict rejection leaves the fence, the grants and the live
    // sessions untouched (I08/I09).
    const view = transferStateView(store);
    if (view.degraded) throw new AuthorizationTransferError("unavailable", 503, "Authorization transfer store is unreadable");
    const state = view.state;
    const existingForPair = livePending(state, clientId, sourceUserId, "sourceUserId", now);
    if (existingForPair && existingForPair.targetUserId !== targetUserId) {
      throw new AuthorizationTransferError("conflict", 409, "The source account already has a pending transfer to a different target");
    }
    if (existingForPair) {
      const sessions = await this.closeTransferSessions({ clientId, userId: sourceUserId, transferId: existingForPair.id });
      // Report the close outcome that was actually observed: a reused intent whose
      // transport refused to close is degraded exactly like a fresh one.
      const degraded = sessions.failed > 0 || sessions.unavailable;
      this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.begin, existingForPair, {
        actor, source, userAgent, reused: true, degraded, sessionsClosed: sessions.closed, sessionsFailed: sessions.failed,
      });
      return { transfer: existingForPair, reused: true, expired: [], degraded, revoke: { changed: false, revokedTokenIds: [], removedCodeCount: 0 }, sessions };
    }
    if (livePending(state, clientId, targetUserId, "targetUserId", now)) {
      throw new AuthorizationTransferError("conflict", 409, "The target account already has a pending transfer for this client");
    }
    if (!this.data.clients[clientId]) throw new AuthorizationTransferError("not_found", 404, "Unknown OAuth client");
    const sourceUser = this.data.oauthUsers[sourceUserId];
    const targetUser = this.data.oauthUsers[targetUserId];
    if (!sourceUser || !targetUser) throw new AuthorizationTransferError("not_found", 404, "Unknown OAuth account");
    if (targetUser.disabledAt) throw new AuthorizationTransferError("conflict", 409, "The target account is disabled");
    if (!this.hasActiveAuthorization(clientId, sourceUserId)) {
      throw new AuthorizationTransferError("conflict", 409, "The source account has no active authorization for this client");
    }
    if (this.hasActiveAuthorization(clientId, targetUserId)) {
      throw new AuthorizationTransferError("conflict", 409, "The target account is already authorized for this client");
    }
    let begun;
    try {
      begun = await store.begin({ clientId, sourceUserId, targetUserId });
    } catch (error) {
      throw this.transferErrorFrom(error);
    }
    for (const expired of begun.expired) this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.expire, expired, { detail: "superseded_or_stale_pending" });
    // A concurrent duplicate won the store race: the fence is durable and the source
    // revoke has already been performed by that winner, so never revoke or re-save
    // again — only report the close outcome this request actually observed.
    if (begun.reused) {
      const sessions = await this.closeTransferSessions({ clientId, userId: sourceUserId, transferId: begun.transfer.id });
      const degraded = sessions.failed > 0 || sessions.unavailable;
      this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.begin, begun.transfer, {
        actor, source, userAgent, reused: true, degraded, sessionsClosed: sessions.closed, sessionsFailed: sessions.failed,
      });
      return { transfer: begun.transfer, reused: true, expired: begun.expired, degraded, revoke: { changed: false, revokedTokenIds: [], removedCodeCount: 0 }, sessions };
    }
    // The fence is durable now; everything below is best-effort consistency. A
    // failure here must never re-admit the source's old credentials.
    let revoke = { changed: false, revokedTokenIds: [], removedCodeCount: 0 };
    let degraded = false;
    try {
      revoke = this.revokeClientUserGrants(clientId, sourceUserId);
      if (revoke.changed) await this.save();
    } catch (error) {
      degraded = true;
      this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.sourceRevokeSyncFailed, begun.transfer, {
        outcome: "failure",
        detail: detail(error),
        lastErrorCode: "revoke_sync_failed",
      });
    }
    const sessions = await this.closeTransferSessions({ clientId, userId: sourceUserId, transferId: begun.transfer.id });
    if (sessions.failed > 0 || sessions.unavailable) degraded = true;
    this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.begin, begun.transfer, {
      actor,
      source,
      userAgent,
      reused: begun.reused,
      degraded,
      sourceRevokeSynced: !degraded,
      sessionsClosed: sessions.closed,
      sessionsFailed: sessions.failed,
    });
    return { transfer: begun.transfer, reused: begun.reused, expired: begun.expired, degraded, revoke, sessions };
  },

  /** Cancel a pending completion intent. Never restores the source's credentials. */
  async cancelAuthorizationTransfer(transferId, { actor = null, source = null, userAgent = null, reason = "cancelled_by_admin" } = {}) {
    await this.ready;
    if (!this.transferStore) throw new AuthorizationTransferError("unavailable", 503, "Authorization transfer store is not configured");
    let result;
    try {
      result = await this.transferStore.cancel(transferId, { reason });
    } catch (error) {
      throw this.transferErrorFrom(error);
    }
    if (result.changed) {
      this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.cancel, result.transfer, { actor, source, userAgent, reason });
    }
    return result;
  },

  /** Expire pending intents past their TTL and audit each one. Never restores credentials. */
  async sweepExpiredTransfers() {
    await this.ready;
    if (!this.transferStore) return [];
    const expired = await this.transferStore.sweepExpired();
    for (const transfer of expired) {
      this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.expire, transfer, { detail: "pending_ttl_elapsed" });
    }
    return expired;
  },

  // ---- completion hook (normal OAuth exchange only, §4.4) ------------------

  /**
   * Called after a successful authorization-code exchange saved its tokens.
   * Completes the one pending intent that this exact `(clientId, targetUserId)`
   * exchange satisfies, or reports why not. Only an intent whose candidate reason is
   * `eligible` may complete: an intent past its TTL stays incomplete even when its
   * expiry could not be persisted (the deadline is a property of the record, not of
   * the last successful sweep). A store failure leaves the transfer pending and
   * audits `complete_failed` — the token response stays successful (B really is
   * authorized) but nothing claims a completion that is not durable.
   */
  async noteAuthorizationTransferCompletion({ clientId, userId } = {}) {
    if (!this.transferStore || !clientId || !userId) return { completed: false, reason: "not_applicable" };
    try {
      await this.sweepExpiredTransfers();
    } catch {
      // A sweep failure must not break the exchange; the pending record simply
      // stays live (and is re-evaluated on the next exchange / Admin read).
    }
    const { state, degraded } = transferStateView(this.transferStore);
    const candidate = findCompletionCandidate({ state, degraded, clientId, targetUserId: userId, now: Date.now() });
    if (candidate.reason !== "eligible" || !candidate.transfer) return { completed: false, reason: candidate.reason };
    let result;
    try {
      result = await this.transferStore.complete(candidate.transfer.id, { completionUserId: userId });
    } catch (error) {
      this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.completeFailed, candidate.transfer, {
        outcome: "failure",
        completionUserId: userId,
        detail: detail(error),
        lastErrorCode: "completion_persist_failed",
      });
      return { completed: false, reason: "persist_failed" };
    }
    if (!result.changed) {
      // The store re-checks the deadline inside its serialized section, so this is
      // the "queued past the TTL" case: the expiry is durable now, report it.
      if (result.reason === "expired") {
        this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.expire, result.transfer, { detail: "pending_ttl_elapsed_in_commit" });
      }
      return { completed: false, reason: result.reason };
    }
    this.recordTransferAudit(AUTHORIZATION_TRANSFER_EVENTS.complete, result.transfer, { completionUserId: userId });
    return { completed: true, transfer: result.transfer };
  },

  // ---- projection input for slice 2 (Admin) -------------------------------

  /** Durable transfer records + pair generations for the Admin projection overlay. */
  async authorizationTransferSnapshot() {
    await this.ready;
    if (!transferStateView(this.transferStore).configured) {
      return { available: false, healthy: false, transfers: [], generations: [] };
    }
    try {
      await this.sweepExpiredTransfers();
    } catch {
      // Display must stay readable while writes are failing; the fence still holds.
      // The committed state below is therefore the PRE-sweep one: a stale pending is
      // reported as `pending` (with its `expiresAt`), never as an expiry that did not
      // land. The record's deadline, not the last successful sweep, decides.
    }
    // Read the committed view AFTER the sweep. The store publishes a NEW state object
    // on every durable commit (clone -> persist -> publish), so a reference captured
    // before `await` would still hold the pre-sweep object and project the outdated
    // `pending` status even though the expiry is on disk and audited (regression:
    // `5eb0da78` returned `pending` while the committed state was `expired`).
    const view = transferStateView(this.transferStore);
    const state = view.state;
    return {
      available: true,
      healthy: view.degraded !== true && this.transferStore?.isHealthy?.() === true,
      transfers: transferRecords(state),
      generations: Object.entries(state?.generations || {}).map(([key, value]) => ({
        key,
        generation: normalizeGeneration(value?.generation),
        transferId: value?.transferId ?? null,
        revokedAt: value?.revokedAt ?? null,
      })),
    };
  },

  recordTransferAudit(action, transfer, extra = {}) {
    const { transfer: _transfer, ...rest } = extra;
    return this.recordAudit({
      action,
      outcome: "success",
      credentialType: "oauth-client",
      clientId: transfer?.clientId ?? null,
      userId: transfer?.sourceUserId ?? null,
      transferId: transfer?.id ?? null,
      sourceUserId: transfer?.sourceUserId ?? null,
      targetUserId: transfer?.targetUserId ?? null,
      ...rest,
    });
  },
};
