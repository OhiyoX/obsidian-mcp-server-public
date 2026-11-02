import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  FETCH_BAD_PORT_MAX,
  FETCH_BAD_PORTS,
  isFetchUnsafePort,
  listenFetchSafe,
  listenFetchSafeOrigin,
} from "../scripts/fetch-safe-listen.mjs";

test("the bad-port list is the WHATWG fetch set and its max is the safety floor", () => {
  // Spot-check the entries the issue and the earlier local copies named.
  for (const port of [6000, 6665, 6666, 6669, 6697, 10080]) assert.ok(FETCH_BAD_PORTS.has(port), `${port} must be a bad port`);
  assert.equal(FETCH_BAD_PORT_MAX, Math.max(...FETCH_BAD_PORTS));
  assert.ok(FETCH_BAD_PORTS.has(FETCH_BAD_PORT_MAX), "the floor must itself be a listed bad port");
  // Nothing above the floor may be listed, or the candidate range would be unsound.
  for (const port of FETCH_BAD_PORTS) assert.ok(port <= FETCH_BAD_PORT_MAX);
});

test("isFetchUnsafePort rejects everything a low dynamic range can hand out", () => {
  assert.equal(isFetchUnsafePort(10080), true, "the floor itself is unsafe");
  assert.equal(isFetchUnsafePort(6000), true);
  assert.equal(isFetchUnsafePort(1024), true, "a Windows dynamic-range start is unsafe");
  assert.equal(isFetchUnsafePort(10081), false, "just above the floor is safe");
  assert.equal(isFetchUnsafePort(65535), false);
  // Non-ports must fail closed rather than be treated as safe.
  assert.equal(isFetchUnsafePort(0), true);
  assert.equal(isFetchUnsafePort(null), true);
  assert.equal(isFetchUnsafePort(10080.5), true);
});

test("listenFetchSafe hands back a port the project's fetch() will dial", async (t) => {
  const server = http.createServer((_request, response) => response.writeHead(204).end());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listenFetchSafe(server);
  assert.equal(isFetchUnsafePort(port), false, `bound port ${port} must be fetch-safe`);
  // The point of the helper: a real request must reach the listener.
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 204);
});

test("listenFetchSafeOrigin returns the matching origin URL", async (t) => {
  const server = http.createServer((_request, response) => response.writeHead(204).end());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenFetchSafeOrigin(server);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const port = Number(origin.split(":").pop());
  assert.equal(isFetchUnsafePort(port), false);
  assert.equal((await fetch(`${origin}/`)).status, 204);
});

test("a pinned bad candidate is closed and retried until a safe port is bound (#344 retry path)", async (t) => {
  const server = http.createServer((_request, response) => response.writeHead(204).end());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Attempt 0 is pinned to the top of the bad-port list; every later attempt gets a
  // random candidate above the floor. This drives the retry branch deterministically
  // instead of waiting for the OS to hand out a bad port.
  let attempts = 0;
  const port = await listenFetchSafe(server, {
    maxAttempts: 8,
    candidates: (attempt) => {
      attempts += 1;
      return attempt === 0 ? FETCH_BAD_PORT_MAX : undefined;
    },
  });
  assert.ok(attempts >= 2, `the loop must have retried after the bad candidate (attempts=${attempts})`);
  assert.equal(isFetchUnsafePort(port), false, `the retry must land on a safe port, got ${port}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 204, "the socket surviving the retry must still serve");
});

test("the retry loop is bounded: all-bad candidates throw instead of looping forever", async () => {
  const server = http.createServer((_request, response) => response.writeHead(204).end());
  await assert.rejects(
    () => listenFetchSafe(server, { candidates: [FETCH_BAD_PORT_MAX, 6000, 6666], maxAttempts: 3 }),
    /fetch-safe loopback port after 3 attempts/,
  );
  await new Promise((resolve) => server.close(resolve));
});

test("a target that cannot bind on any attempt fails loudly instead of returning a bad port", async () => {
  // A target whose listen() always errors: the helper must exhaust its attempts and throw.
  const failing = {
    once() { return this; },
    off() { return this; },
    address: () => null,
    close: (callback) => callback?.(),
    listen(_port, _host) { queueMicrotask(() => this.once.error?.({ code: "EADDRINUSE" })); },
  };
  const originalOnce = failing.once.bind(failing);
  failing.once = (event, handler) => {
    if (event === "error") failing.once.error = handler;
    return originalOnce(event, handler);
  };
  await assert.rejects(() => listenFetchSafe(failing, { maxAttempts: 3 }), /fetch-safe loopback port after 3 attempts/);
});
