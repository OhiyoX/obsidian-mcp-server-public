import {
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  WebSessionStoreError,
  hashWebSessionToken,
} from "./web-session-schema.js";

const MAX_CAS_ATTEMPTS = 5;

function parseCookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 1) continue;
    try { result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1)); } catch { /* ignore malformed cookie */ }
  }
  return result;
}

/**
 * Resolve one authenticated Web session. Provider state is authoritative on every
 * call; persisted scopes/allowedVaults are never used. The touch is a process-local
 * CAS; when the durable checkpoint lag reaches the fence the caller must await a
 * successful checkpoint before the request may count as a durable renewal. The
 * post-checkpoint membership/expiry/version fence makes a concurrent logout or
 * expiry win instead of returning a session that no longer exists.
 */
export async function resolveWebSession({ store, provider, rawToken, ttlMs = WEB_SESSION_TTL_MS }) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = store.snapshot(rawToken);
    if (!snapshot) return null;
    if (snapshot.record.expiresAt <= store.now()) {
      store.deleteSession(rawToken);
      return null;
    }
    const user = await provider.oauthUserSessionRecord(snapshot.record.userId);
    if (!user || user.updatedAt !== snapshot.record.userUpdatedAt) {
      store.deleteSession(rawToken);
      return null;
    }
    const allowedScopes = [...(user.allowedScopes || [])];
    const allowedVaults = [...(user.allowedVaults || [])];
    let vaultId = snapshot.record.vaultId;
    if (!allowedVaults.includes(vaultId)) vaultId = allowedVaults[0];
    // Capture the touch time only after the provider await: a stale pre-await clock
    // could otherwise move lastSeenAt/expiresAt backwards.
    const touchNow = store.now();
    const touch = store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({
      ...record,
      lastSeenAt: touchNow,
      expiresAt: touchNow + ttlMs,
      vaultId,
    }));
    if (!touch.ok) {
      if (touch.reason === "stale") continue;
      return null;
    }
    if (touch.checkpointRequired) {
      let checkpoint;
      try {
        checkpoint = await store.checkpoint();
      } catch {
        throw new WebSessionStoreError("checkpoint_failed", "Web session persistence is unavailable");
      }
      if (!checkpoint.ok) throw new WebSessionStoreError("checkpoint_failed", "Web session persistence is unavailable");
      // The awaited checkpoint is a race window: a concurrent logout/revoke or expiry
      // may have removed or replaced the record. Only an unchanged, unexpired record
      // counts as a successful durable renewal; otherwise retry or fail closed.
      const current = store.snapshot(rawToken);
      if (!current || current.record.expiresAt <= store.now()) return null;
      if (current.version !== touch.version) continue;
    }
    return {
      id: rawToken,
      version: touch.version,
      userId: snapshot.record.userId,
      userUpdatedAt: snapshot.record.userUpdatedAt,
      username: user.username,
      displayName: user.displayName,
      csrf: snapshot.record.csrf,
      vaultId,
      allowedScopes,
      allowedVaults,
      createdAt: snapshot.record.createdAt,
      expiresAt: touch.record.expiresAt,
      lastSeenAt: touch.record.lastSeenAt,
    };
  }
  return null;
}

/**
 * Express-facing adapter so routes.js stays a thin router.
 *
 * `nextTarget` defaults to the slash-bearing app root, matching the manifest `scope` the
 * installed app resolves (#471); `requirePage` then redirects the bare root to the plain login
 * URL instead of adding a redundant `next` parameter.
 */
export function createWebSessionManager({ store, provider, cookieName = WEB_SESSION_COOKIE, ttlMs = WEB_SESSION_TTL_MS, nextTarget = () => "/app/" }) {
  async function currentSession(req) {
    const rawToken = parseCookies(req)[cookieName];
    if (!rawToken) return null;
    return resolveWebSession({ store, provider, rawToken, ttlMs });
  }

  async function requireSession(req, res, next, page = false) {
    try {
      const session = await currentSession(req);
      if (!session) {
        if (!page) return res.status(401).json({ error: "Login required" });
        const target = nextTarget(req);
        return res.redirect(303, target === "/app/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(target)}`);
      }
      req.webSession = session;
      next();
    } catch (error) {
      if (error?.webSessionStoreFailure) {
        if (page) return res.status(503).send("Session persistence is unavailable");
        return res.status(503).json({ error: "Session persistence unavailable" });
      }
      next(error);
    }
  }

  return {
    store,
    currentSession,
    requirePage: (req, res, next) => requireSession(req, res, next, true),
    requireApi: (req, res, next) => requireSession(req, res, next),
    requireCsrf(req, res, next) {
      const supplied = req.get("X-CSRF-Token") || req.body?.csrf;
      if (!supplied || supplied !== req.webSession.csrf) return res.status(403).json({ error: "CSRF validation failed" });
      next();
    },
    selectVault(req, vaultId) {
      return store.mutateSession(req.webSession.id, (record) => ({ ...record, vaultId }));
    },
    noteSelection(req, vaultId) {
      store.touchIfCurrent(hashWebSessionToken(req.webSession.id), req.webSession.version, (record) => ({ ...record, vaultId }));
      req.webSession.vaultId = vaultId;
    },
    createVaultUpdate(req, { vaultId, userUpdatedAt }) {
      return store.mutateSession(req.webSession.id, (record) => ({ ...record, vaultId, userUpdatedAt }));
    },
  };
}
