// MCP session lifecycle: the in-memory session registry, per-request principal
// ownership, stale-session recovery, hard-revoke close and the idle TTL reaper.
//
// Extracted from `server.js` so the entry point only composes and injects
// (AuthZ Wave C wiring contract, INTERFACE §10.6). Behavior is unchanged:
// `server.js` passes its own `createMcpServer`, keeps the route-level ownership
// checks and the shutdown deadline, and only the registry internals live here.

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createStaleSessionRecovery } from "./mcp-session-recovery.js";
import { MCP_SESSION_RECOVERY, MCP_SESSION_RECOVERY_MAX_INFLIGHT, SESSION_TTL_MS } from "./server-config.js";
import { clearSessionAuthor } from "./session-author.js";

// Returns `{ sessions, sessionRecovery, createSessionTransport,
// closeSessionsForClient, sessionBelongsToAuth, startReaper }`. `createServer`
// must build one MCP server per session/recovery; it is called lazily, so the
// caller may create the registry before its server dependencies are wired.
export function createMcpSessionRegistry({ createServer }) {
  const sessions = new Map();
  const sessionRecovery = createStaleSessionRecovery({
    mode: MCP_SESSION_RECOVERY,
    maxInFlight: MCP_SESSION_RECOVERY_MAX_INFLIGHT,
    createServer,
  });

  function authPrincipalId(auth) {
    if (!auth?.clientId) return null;
    return [auth.type || "unknown", auth.clientId, auth.userId || ""].join(":");
  }

  function sessionBelongsToAuth(record, auth) {
    const principalId = authPrincipalId(auth);
    if (!record.authPrincipalId) return principalId === null;
    return record.authPrincipalId === principalId;
  }

  async function createSessionTransport(auth) {
    const record = {
      server: createServer(),
      transport: null,
      createdAt: new Date().toISOString(),
      lastAccessAt: Date.now(),
      authClientId: auth?.clientId,
      authUserId: auth?.userId ?? null,
      authPrincipalId: authPrincipalId(auth),
      lastCloseError: null,
    };

    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        record.sessionId = sessionId;
        sessions.set(sessionId, record);
        console.log(`MCP session initialized: ${sessionId}`);
      },
    });

    transport.onclose = async () => {
      if (record.closed) return;
      record.closed = true;

      const sessionId = transport.sessionId || record.sessionId;
      if (sessionId) {
        clearSessionAuthor(sessionId);
        sessions.delete(sessionId);
        console.log(`MCP session closed: ${sessionId}`);
      }
    };

    record.transport = transport;
    await record.server.connect(transport);
    return record;
  }

  // One close attempt, with the outcome recorded on the record. A failed close is
  // NOT a close: the record stays resident (it is only ever removed by the real
  // `onclose` above) and carries `lastCloseError` so ops can see and retry it.
  async function closeRecord(record) {
    const sessionId = record.sessionId ?? record.transport?.sessionId ?? null;
    try {
      await record.transport.close();
      record.lastCloseError = null;
      return { sessionId, error: null };
    } catch (error) {
      const detail = String(error?.message || error || "close failed").slice(0, 200);
      record.lastCloseError = { sessionId, error: detail, at: new Date().toISOString() };
      return { sessionId, error: detail };
    }
  }

  // Hard revoke: close every live transport for one credential, principal-scoped
  // when a userId is supplied.
  //
  // #364 / ruling §17-5: the OLD `Promise.allSettled` discarded every outcome, so a
  // caller could not prove I06. The result is now a verifiable close report
  // (`matched`/`closed`/`failed`/`sessionIds`/`failures`); a failure is reported, never
  // swallowed, and callers keep the durable deny regardless of the outcome. The call
  // is idempotent, so re-issuing it is the explicit retry path for a failed close.
  async function closeSessionsForClient(clientId, { userId } = {}) {
    const result = { clientId: clientId ?? null, userId: userId ?? null, matched: 0, closed: 0, failed: 0, sessionIds: [], failures: [] };
    if (typeof clientId !== "string" || !clientId) return result;
    const principalId = userId ? authPrincipalId({ type: "oauth", clientId, userId }) : null;
    const matching = [...sessions.values()].filter((record) =>
      record.authClientId === clientId
      && (!principalId || record.authPrincipalId === principalId)
    );
    result.matched = matching.length;
    const settled = await Promise.allSettled(matching.map(async (record) => {
      const outcome = await closeRecord(record);
      if (outcome.error) {
        const wrapped = new Error(outcome.error);
        wrapped.sessionId = outcome.sessionId;
        throw wrapped;
      }
      return outcome.sessionId;
    }));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        result.closed += 1;
        if (outcome.value) result.sessionIds.push(outcome.value);
        continue;
      }
      result.failed += 1;
      const sessionId = outcome.reason?.sessionId ?? null;
      if (sessionId) result.sessionIds.push(sessionId);
      result.failures.push({ sessionId, error: String(outcome.reason?.message || outcome.reason || "close failed").slice(0, 200) });
    }
    return result;
  }

  /**
   * Ops recovery view: live records whose `close()` failed and that are therefore
   * still resident. Recovery is explicit — the idle reaper retries each tick and an
   * operator (or Admin retry) can re-issue the idempotent
   * `closeSessionsForClient(clientId, { userId })`; a process restart clears the
   * registry but never re-admits a fenced credential. Nothing here deletes a Map
   * entry to pretend a session was closed.
   */
  function listUnclosedSessions() {
    return [...sessions.entries()]
      .filter(([, record]) => record.lastCloseError)
      .map(([sessionId, record]) => ({
        sessionId,
        clientId: record.authClientId ?? null,
        userId: record.authUserId ?? null,
        lastAccessAt: record.lastAccessAt ?? null,
        lastCloseError: record.lastCloseError,
      }));
  }

  // Idle TTL reaper. `unref()` keeps it from holding the process open; the
  // shutdown path clears it explicitly. A close that keeps failing is retried on
  // every tick and left resident (with `lastCloseError`) — it is never treated as
  // closed.
  function startReaper() {
    const reaper = setInterval(async () => {
      const cutoff = Date.now() - SESSION_TTL_MS;
      for (const [sessionId, record] of sessions.entries()) {
        if (record.lastAccessAt >= cutoff) continue;
        console.log(`Closing expired MCP session: ${sessionId}`);
        const outcome = await closeRecord(record);
        if (outcome.error) console.error(`Error closing expired MCP session ${sessionId}: ${outcome.error}`);
      }
    }, Math.max(30_000, Math.min(SESSION_TTL_MS, 60_000)));
    reaper.unref();
    return reaper;
  }

  return {
    sessions,
    sessionRecovery,
    createSessionTransport,
    closeSessionsForClient,
    listUnclosedSessions,
    sessionBelongsToAuth,
    startReaper,
  };
}
