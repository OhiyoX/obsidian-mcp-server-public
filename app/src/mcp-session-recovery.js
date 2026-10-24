// Stale MCP session recovery for hosts that never re-initialize.
//
// Streamable HTTP expects a client that receives `404 Session not found` to start
// a new session with a fresh `initialize`. Not every real host does that: ZCode
// 1.x binds one MCP connection per conversation and keeps sending the old
// `Mcp-Session-Id` for hours after the server dropped it (idle reaper) or lost it
// (container restart, which keeps MCP sessions in process memory). One expiry then
// disables every later tool call in that conversation, even though the server is
// healthy and the credential is valid.
//
// Recovery answers such a request as a one-shot stateless request instead of
// rejecting it. Boundaries kept on purpose:
//
// - Only a *stale* id is forgiven. A request without a session id still gets
//   "initialize first", and a malformed id still gets 404, so a genuinely wrong
//   header keeps surfacing instead of being masked.
// - Authentication, Scope and Vault checks run before recovery and are unchanged;
//   recovery never widens what the caller may do.
// - A recovered request is not registered as a session and is closed with its
//   response, so `sessions` and the idle reaper keep their current meaning.
// - Recovery fails closed to the previous 404 when the mode is `off`, the id is
//   not recoverable, the in-flight budget is exhausted, or the transport cannot be
//   built (including a throwing server/transport factory).

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const SESSION_RECOVERY_MODES = ["off", "stateless"];
export const SESSION_RECOVERY_DEFAULT_MODE = "stateless";
export const SESSION_RECOVERY_MAX_INFLIGHT_DEFAULT = 64;
export const SESSION_RECOVERY_MAX_INFLIGHT_LIMIT = 256;

// Shape filter, not proof of issuance. Server-issued ids are UUIDs, and this only
// keeps obviously wrong header values on the historical 404; it cannot separate a
// genuinely stale id from a well-formed forged one. Authorization has already run
// when recovery is reached, so a recovered request can only act as the caller.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export function normalizeSessionRecoveryMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!mode) return SESSION_RECOVERY_DEFAULT_MODE;
  if (!SESSION_RECOVERY_MODES.includes(mode)) {
    throw new Error(`MCP_SESSION_RECOVERY must be one of: ${SESSION_RECOVERY_MODES.join(", ")}`);
  }
  return mode;
}

export function isRecoverableSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function clampSessionRecoveryMaxInFlight(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return SESSION_RECOVERY_MAX_INFLIGHT_DEFAULT;
  return Math.max(1, Math.min(SESSION_RECOVERY_MAX_INFLIGHT_LIMIT, parsed));
}

/**
 * @param {object} options
 * @param {string} options.mode `off` or `stateless`.
 * @param {() => object} options.createServer Builds one MCP server per recovery.
 * @param {number} [options.maxInFlight] Concurrent recoveries before failing closed.
 * @param {(options: object) => object} [options.createTransport] Transport factory.
 * @param {object} [options.logger]
 */
export function createStaleSessionRecovery({
  mode = SESSION_RECOVERY_DEFAULT_MODE,
  createServer,
  maxInFlight = SESSION_RECOVERY_MAX_INFLIGHT_DEFAULT,
  createTransport = (options) => new StreamableHTTPServerTransport(options),
  logger = console,
} = {}) {
  if (typeof createServer !== "function") throw new Error("createStaleSessionRecovery requires createServer");
  const enabled = mode !== "off";
  const inFlight = new Set();
  // One log line per stale id: a host that keeps a dead id recovers on every call.
  const announced = new Set();
  let recovered = 0;
  let rejected = 0;
  let failed = 0;

  async function release(record) {
    if (record.closed) return;
    record.closed = true;
    inFlight.delete(record);
    try {
      await record.transport.close();
    } catch {}
  }

  function announce(sessionId) {
    if (announced.has(sessionId)) return;
    announced.add(sessionId);
    if (announced.size > 128) announced.delete(announced.values().next().value);
    logger.warn?.(`MCP stale-session recovery: unknown session id …${sessionId.slice(-8)} answered statelessly`);
  }

  return {
    enabled,
    mode,
    // `failed` counts every attempt that did not complete (construction, connect, or
    // the request itself); `rejected` counts attempts never started because the
    // in-flight budget was full.
    stats: () => ({ mode, recovered, rejected, failed, active: inFlight.size, maxInFlight }),
    /**
     * Handles one POST whose `mcp-session-id` is unknown.
     * Returns true when the response was written (or started); false means the
     * caller still owns the response and must keep its existing error path.
     */
    async handle(req, res, sessionId) {
      if (!enabled || !isRecoverableSessionId(sessionId)) return false;
      if (inFlight.size >= maxInFlight) {
        rejected += 1;
        return false;
      }
      let server = null;
      let transport = null;
      let record = null;
      try {
        // Construction is inside the guard on purpose: a throwing factory must fall
        // back to the historical 404 path, not to the route's 500 handler.
        server = createServer();
        // Stateless transports are single-use by contract; one per recovery, closed
        // with the response, so recovery cannot accumulate session state.
        transport = createTransport({ sessionIdGenerator: undefined });
        record = { server, transport, closed: false };
        inFlight.add(record);
        res.once("close", () => { void release(record); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        recovered += 1;
        announce(sessionId);
        return true;
      } catch (error) {
        // Every attempt that did not complete counts as failed. Before the response
        // starts the caller falls back to the strict 404; after it started the
        // partial response cannot be replaced, but the attempt still failed.
        const written = Boolean(res.headersSent);
        failed += 1;
        if (record) {
          await release(record);
        } else {
          try { await transport?.close(); } catch {}
        }
        logger.error?.(`MCP stale-session recovery failed${written ? " after response start" : ""}: ${error?.message || error}`);
        return written;
      }
    },
    /** Closes recoveries still streaming, for graceful shutdown. */
    async close() {
      await Promise.allSettled([...inFlight].map((record) => release(record)));
    },
  };
}
