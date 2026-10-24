// #364 authorization-transfer runtime: PURE queries over the durable transfer
// store state. No I/O, no clock reads, no mutation — every function takes the
// store state (and, when relevant, an explicit `now`) so the fence algebra can be
// unit tested without a filesystem and can never become a second source of truth.
//
// Two questions this module answers:
//
// 1. Is a credential of pair `(clientId, userId)` fenced by a transfer? A pair
//    carries a monotonic revocation generation; a credential carries the
//    generation it was minted at. Valid ⇔ equal. See the store module header for
//    why equality (not "revokedAt > issuedAt") is what makes concurrent issuance
//    unable to cross the revoke boundary.
// 2. May a pending transfer for `(clientId, targetUserId)` be completed by this
//    successful normal OAuth exchange?

// Pair keys are persisted in `transfers.json`, so the encoding must be unambiguous for
// ANY id pair (an id is a UUID or an opaque token today, but the store must not rely on
// that). A JSON array of the two ids is injective and self-describing; a bare joining
// separator would let `("a", "b\u0000c")` and `("a\u0000b", "c")` collide.
export function pairGenerationKey(clientId, userId) {
  return JSON.stringify([String(clientId ?? ""), String(userId ?? "")]);
}

/** `[clientId, userId]` for a key produced by `pairGenerationKey`, or `null`. */
export function parsePairGenerationKey(key) {
  try {
    const parsed = JSON.parse(String(key));
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Missing / malformed / legacy generation counts as the oldest generation. */
export function normalizeGeneration(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function currentPairGeneration(state, clientId, userId) {
  if (!state || !clientId || !userId) return 0;
  return normalizeGeneration(state.generations?.[pairGenerationKey(clientId, userId)]?.generation);
}

export function generationRecordFor(state, clientId, userId) {
  if (!state || !clientId || !userId) return null;
  const entry = state.generations?.[pairGenerationKey(clientId, userId)];
  return entry ? { ...entry, generation: normalizeGeneration(entry.generation) } : null;
}

/**
 * @returns {{ fenced: boolean, reason: string, credentialGeneration: number, currentGeneration: number|null }}
 * `degraded` (store unloaded / corrupt / unreadable) fails CLOSED: every credential is
 * treated as fenced, because a fence that cannot be read must never be assumed absent.
 */
export function evaluateCredentialFence({ state = null, degraded = false, clientId, userId, generation } = {}) {
  const credentialGeneration = normalizeGeneration(generation);
  if (degraded) return { fenced: true, reason: "store_unavailable", credentialGeneration, currentGeneration: null };
  if (!clientId || !userId) return { fenced: false, reason: "no_pair", credentialGeneration, currentGeneration: 0 };
  const currentGeneration = currentPairGeneration(state, clientId, userId);
  return {
    fenced: credentialGeneration !== currentGeneration,
    reason: credentialGeneration === currentGeneration ? "current" : "generation_mismatch",
    credentialGeneration,
    currentGeneration,
  };
}

/** Read-only view adapter for a store instance (or `null` when none is configured). */
export function transferStateView(store) {
  if (!store || typeof store !== "object") return { state: null, degraded: false, configured: false };
  let degraded = false;
  try {
    if (typeof store.isHealthy === "function") degraded = store.isHealthy() !== true;
  } catch {
    degraded = true;
  }
  let state = null;
  try {
    state = typeof store.view === "function" ? store.view() : null;
  } catch {
    degraded = true;
  }
  return { state, degraded, configured: true };
}

/**
 * Pending completion eligibility for one `(clientId, targetUserId)`.
 * More than one live pending is a broken invariant and fails closed.
 */
export function findCompletionCandidate({ state = null, degraded = false, clientId, targetUserId, now } = {}) {
  if (degraded) return { transfer: null, reason: "store_unavailable" };
  if (!clientId || !targetUserId) return { transfer: null, reason: "no_pair" };
  const pending = Object.values(state?.transfers || {}).filter((transfer) =>
    transfer?.status === "pending" && transfer.clientId === clientId && transfer.targetUserId === targetUserId);
  if (!pending.length) return { transfer: null, reason: "none" };
  if (pending.length > 1) return { transfer: null, reason: "ambiguous" };
  const transfer = pending[0];
  if (Number.isFinite(now) && Date.parse(transfer.expiresAt) <= now) return { transfer, reason: "expired" };
  return { transfer, reason: "eligible" };
}

/** Live pendings for one client, oldest first — the Admin projection input. */
export function pendingTransfersForClient(state, clientId) {
  return Object.values(state?.transfers || {})
    .filter((transfer) => transfer?.status === "pending" && transfer.clientId === clientId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((transfer) => ({ ...transfer }));
}

/** Every transfer record, newest first — the Admin history input. */
export function transferRecords(state) {
  return Object.values(state?.transfers || {})
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((transfer) => ({ ...transfer }));
}
