// Unit contract for the stale-session recovery seam used by the MCP POST route.
//
// The real HTTP route is covered by mcp-session-recovery-http.test.js. These tests
// pin the decisions that must not drift: mode parsing, which ids are recoverable,
// the in-flight budget, fail-closed error handling, and per-response cleanup.

import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_RECOVERY_DEFAULT_MODE,
  SESSION_RECOVERY_MAX_INFLIGHT_DEFAULT,
  SESSION_RECOVERY_MAX_INFLIGHT_LIMIT,
  clampSessionRecoveryMaxInFlight,
  createStaleSessionRecovery,
  isRecoverableSessionId,
  normalizeSessionRecoveryMode,
} from "../src/mcp-session-recovery.js";

const UUID = "5f2b0a4c-9d3e-4b71-8c6a-2f0d1e7a4b93";

function fakeRes() {
  const handlers = new Map();
  return {
    headersSent: false,
    once(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = handlers.get(event);
      handlers.delete(event);
      handler?.();
    },
  };
}

function stubTransport({ failure = null, hang = false, setHeadersSent = false } = {}) {
  const calls = { requests: 0, closed: 0, bodies: [] };
  return {
    calls,
    async handleRequest(_req, res, body) {
      calls.requests += 1;
      calls.bodies.push(body);
      if (setHeadersSent) res.headersSent = true;
      if (failure) throw failure;
      if (hang) return new Promise(() => {});
      return undefined;
    },
    async close() {
      calls.closed += 1;
    },
  };
}

function stubServer() {
  return {
    connections: 0,
    async connect(transport) {
      this.connections += 1;
      this.transport = transport;
    },
  };
}

test("recovery mode parsing defaults to stateless and rejects unknown values", () => {
  assert.equal(SESSION_RECOVERY_DEFAULT_MODE, "stateless");
  assert.equal(normalizeSessionRecoveryMode(undefined), "stateless");
  assert.equal(normalizeSessionRecoveryMode(""), "stateless");
  assert.equal(normalizeSessionRecoveryMode("  STATELESS "), "stateless");
  assert.equal(normalizeSessionRecoveryMode("off"), "off");
  assert.throws(() => normalizeSessionRecoveryMode("always"), /MCP_SESSION_RECOVERY must be one of/);
});

test("in-flight budget is clamped to a bounded range", () => {
  assert.equal(clampSessionRecoveryMaxInFlight(undefined), SESSION_RECOVERY_MAX_INFLIGHT_DEFAULT);
  assert.equal(clampSessionRecoveryMaxInFlight("not-a-number"), SESSION_RECOVERY_MAX_INFLIGHT_DEFAULT);
  assert.equal(clampSessionRecoveryMaxInFlight("0"), 1);
  assert.equal(clampSessionRecoveryMaxInFlight("-5"), 1);
  assert.equal(clampSessionRecoveryMaxInFlight("9999"), SESSION_RECOVERY_MAX_INFLIGHT_LIMIT);
  assert.equal(clampSessionRecoveryMaxInFlight("8"), 8);
});

test("only opaque, bounded ids are recoverable", () => {
  assert.equal(isRecoverableSessionId(UUID), true);
  assert.equal(isRecoverableSessionId("abc.def:ghi_123-456"), true);
  assert.equal(isRecoverableSessionId("short"), false);
  assert.equal(isRecoverableSessionId("has space in it 1234"), false);
  assert.equal(isRecoverableSessionId("x".repeat(129)), false);
  assert.equal(isRecoverableSessionId(undefined), false);
  assert.equal(isRecoverableSessionId(42), false);
});

test("mode off never builds a transport and keeps the strict answer", async () => {
  let created = 0;
  const recovery = createStaleSessionRecovery({
    mode: "off",
    createServer: () => { created += 1; return stubServer(); },
    createTransport: () => stubTransport(),
    logger: { warn() {}, error() {} },
  });
  const res = fakeRes();
  assert.equal(recovery.enabled, false);
  assert.equal(await recovery.handle({ body: {} }, res, UUID), false);
  assert.equal(created, 0);
  assert.equal(recovery.stats().recovered, 0);
});

test("a malformed session id is not recovered", async () => {
  let created = 0;
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    createServer: () => { created += 1; return stubServer(); },
    createTransport: () => stubTransport(),
    logger: { warn() {}, error() {} },
  });
  assert.equal(await recovery.handle({ body: {} }, fakeRes(), "bad id"), false);
  assert.equal(created, 0);
});

test("a stale id is answered once, then closed with the response", async () => {
  const server = stubServer();
  const transport = stubTransport();
  const warnings = [];
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    createServer: () => server,
    createTransport: () => transport,
    logger: { warn: (line) => warnings.push(line), error() {} },
  });
  const res = fakeRes();
  const body = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "server_info", arguments: {} } };

  assert.equal(await recovery.handle({ body }, res, UUID), true);
  assert.equal(server.connections, 1);
  assert.equal(transport.calls.requests, 1);
  assert.deepEqual(transport.calls.bodies, [body]);
  assert.equal(transport.calls.closed, 0, "the transport must outlive the response");
  assert.deepEqual(recovery.stats(), { mode: "stateless", recovered: 1, rejected: 0, failed: 0, active: 1, maxInFlight: 64 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stale-session recovery/);
  assert.ok(!warnings[0].includes(UUID), "the full session id must not be logged");

  res.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.calls.closed, 1);
  assert.equal(recovery.stats().active, 0);

  // A second request on the same stale id recovers again but logs only once.
  assert.equal(await recovery.handle({ body }, fakeRes(), UUID), true);
  assert.equal(warnings.length, 1);
  assert.equal(recovery.stats().recovered, 2);
});

test("the in-flight budget fails closed instead of queueing", async () => {
  const transports = [];
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    maxInFlight: 1,
    createServer: () => stubServer(),
    createTransport: () => {
      const transport = stubTransport({ hang: true });
      transports.push(transport);
      return transport;
    },
    logger: { warn() {}, error() {} },
  });
  const first = recovery.handle({ body: {} }, fakeRes(), UUID);
  assert.equal(await recovery.handle({ body: {} }, fakeRes(), "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"), false);
  assert.equal(recovery.stats().rejected, 1);
  assert.equal(transports.length, 1);
  await recovery.close();
  assert.equal(transports[0].calls.closed, 1);
  await Promise.race([first, new Promise((resolve) => setImmediate(resolve))]);
});

test("a throwing server factory falls back to the strict 404 path", async () => {
  const errors = [];
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    createServer: () => { throw new Error("server factory boom"); },
    createTransport: () => stubTransport(),
    logger: { warn() {}, error: (line) => errors.push(line) },
  });
  const res = fakeRes();
  // The route must keep its own 404 answer: a throw here would become a 500.
  assert.equal(await recovery.handle({ body: {} }, res, UUID), false);
  assert.equal(res.headersSent, false);
  assert.deepEqual(recovery.stats(), { mode: "stateless", recovered: 0, rejected: 0, failed: 1, active: 0, maxInFlight: 64 });
  assert.match(errors[0], /server factory boom/);
});

test("a throwing transport factory falls back to the strict 404 path", async () => {
  const errors = [];
  let created = 0;
  let attempts = 0;
  const transport = stubTransport();
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    createServer: () => { created += 1; return stubServer(); },
    createTransport: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transport factory boom");
      return transport;
    },
    logger: { warn() {}, error: (line) => errors.push(line) },
  });
  const res = fakeRes();
  assert.equal(await recovery.handle({ body: {} }, res, UUID), false);
  assert.equal(res.headersSent, false);
  assert.equal(created, 1);
  assert.equal(recovery.stats().failed, 1);
  assert.equal(recovery.stats().active, 0, "a half-built attempt must not stay in flight");
  assert.match(errors[0], /transport factory boom/);

  // A later request on the same id still recovers: the failure is not sticky.
  assert.equal(await recovery.handle({ body: {} }, fakeRes(), UUID), true);
  assert.equal(transport.calls.requests, 1);
  assert.equal(recovery.stats().recovered, 1);
  assert.equal(recovery.stats().failed, 1);
});

test("a failure before the response starts falls back to the strict 404 path", async () => {
  const transport = stubTransport({ failure: new Error("transport boom") });
  const errors = [];
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    createServer: () => stubServer(),
    createTransport: () => transport,
    logger: { warn() {}, error: (line) => errors.push(line) },
  });
  const res = fakeRes();
  assert.equal(await recovery.handle({ body: {} }, res, UUID), false);
  assert.equal(res.headersSent, false);
  assert.equal(transport.calls.closed, 1);
  assert.deepEqual(recovery.stats(), { mode: "stateless", recovered: 0, rejected: 0, failed: 1, active: 0, maxInFlight: 64 });
  assert.match(errors[0], /transport boom/);
});

test("a failure after the response started is not replaced by an error response", async () => {
  const transport = stubTransport({ failure: new Error("stream boom"), setHeadersSent: true });
  const recovery = createStaleSessionRecovery({
    mode: "stateless",
    createServer: () => stubServer(),
    createTransport: () => transport,
    logger: { warn() {}, error() {} },
  });
  const res = fakeRes();
  assert.equal(await recovery.handle({ body: {} }, res, UUID), true);
  assert.equal(transport.calls.closed, 1);
  // The attempt still failed even though the caller cannot fall back to a 404.
  assert.deepEqual(recovery.stats(), { mode: "stateless", recovered: 0, rejected: 0, failed: 1, active: 0, maxInFlight: 64 });
});
