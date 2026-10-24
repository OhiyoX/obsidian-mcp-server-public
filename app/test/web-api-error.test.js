import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createWebAppRouter } from "../src/app/routes.js";
import { classifyWebApiError } from "../src/app/web-api-error.js";

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) => fetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
});

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing Web test server")), HTTP_TIMEOUT_MS)),
  ]);
}

test("Web API error contract exposes only stable client-safe messages", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/srv/private/vault/Secret.md'"), { code: "ENOENT" });
  assert.deepEqual(classifyWebApiError(enoent), { status: 404, error: "Not found" });

  const invalidSearch = Object.assign(new Error("regex engine detail"), { code: "INVALID_SEARCH_QUERY" });
  assert.deepEqual(classifyWebApiError(invalidSearch), { status: 400, error: "Invalid search query" });

  const parse = Object.assign(new Error("Unexpected token at internal parser offset 17"), { type: "entity.parse.failed", status: 400 });
  assert.deepEqual(classifyWebApiError(parse), { status: 400, error: "Invalid JSON request body" });

  const tooLarge = Object.assign(new Error("request entity too large: limit=2097152"), { type: "entity.too.large", status: 413 });
  assert.deepEqual(classifyWebApiError(tooLarge), { status: 413, error: "Request body too large" });

  assert.deepEqual(classifyWebApiError(new Error("Path traversal denied")), { status: 400, error: "Invalid path" });
  assert.deepEqual(classifyWebApiError(new Error("Symbolic link escapes the vault: /srv/private")), { status: 400, error: "Invalid path" });
  assert.deepEqual(classifyWebApiError(new Error("Vault access denied")), { status: 403, error: "Vault access denied" });
  assert.deepEqual(classifyWebApiError(new Error("Vault already exists")), { status: 409, error: "Vault already exists" });
  assert.deepEqual(classifyWebApiError(new Error("Revision conflict: expected sha256:client, current sha256:server")), { status: 409, error: "Revision conflict" });
});

test("unexpected Web API failures are 500 and never echo implementation details", () => {
  const secretDetail = "sqlite failed at /srv/obsidian/private/state.db with token-like internal detail";
  const classified = classifyWebApiError(new Error(secretDetail));
  assert.deepEqual(classified, { status: 500, error: "Request failed" });
  assert.equal(JSON.stringify(classified).includes("/srv/obsidian/private"), false);
  assert.equal(JSON.stringify(classified).includes("token-like"), false);
});


test("Web HTTP boundary sanitizes malformed JSON parser details", async () => {
  const app = express();
  app.use(createWebAppRouter({
    provider: {},
    secureCookie: false,
    publishService: {},
    resolveOrigin: () => "http://127.0.0.1",
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const response = await boundedFetch(`http://127.0.0.1:${address.port}/api/web/v1/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"content":',
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid JSON request body" });
    assert.equal(JSON.stringify(body).includes("Unexpected"), false);
    assert.equal(JSON.stringify(body).includes("position"), false);
  } finally {
    await closeHttpServer(server);
  }
});
