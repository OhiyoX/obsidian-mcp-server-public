import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { createEmbeddingClient } from "../src/embeddings.js";
import { listenFetchSafeOrigin } from "../scripts/fetch-safe-listen.mjs";

// The "fetch-safe loopback port" rule (WHATWG fetch refuses a fixed bad-port list, and
// Windows can allocate from it) lives in `scripts/fetch-safe-listen.mjs` — one
// implementation shared by every harness and test (issue #344).

let server;
let baseUrl;
before(async () => {
  server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer test-key") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    if (request.url === "/v1/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, role: "gateway" }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/embeddings") {
      response.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 1] })) }));
      return;
    }
    response.writeHead(404).end();
  });
  baseUrl = await listenFetchSafeOrigin(server);
});
after(() => new Promise((resolve) => server.close(resolve)));

test("OpenAI-compatible embedding client checks models and embeds batches", async () => {
  const client = createEmbeddingClient({
    provider: "openai-compatible",
    baseUrl,
    model: "test-model",
    apiKey: "test-key",
    timeoutMs: 2000,
    // Tests run inside the production container too. Explicitly disable its
    // configured edge/registry so this case remains a self-contained mock.
    edgeBaseUrl: "",
    edgeRegistryUrl: "",
  });
  const health = await client.health();
  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, true);
  assert.deepEqual(await client.embed(["hi", "hello"]), [[2, 1], [5, 1]]);
});

test("embedding configuration treats llama.cpp as OpenAI-compatible transport", () => {
  const client = createEmbeddingClient({ provider: "llama.cpp", baseUrl, model: "test-model", apiKey: "test-key" });
  assert.equal(client.config.provider, "openai");
  assert.equal(client.config.identity, "openai:test-model");
});

test("embedding client resolves a DHCP edge worker from the registry", async () => {
  const edgeServer = http.createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer edge-key") { response.writeHead(401).end(); return; }
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "test-model" }] })); return; }
    if (request.url === "/v1/status") { response.end(JSON.stringify({ ok: true, role: "edge" })); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 9] })) }));
  });
  const edgeUrl = await listenFetchSafeOrigin(edgeServer);
  const registryServer = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer registry-key") { response.writeHead(401).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ deviceId: "pc-edge", baseUrl: edgeUrl, models: ["test-model"] }] }));
  });
  const registryUrl = await listenFetchSafeOrigin(registryServer);
  try {
    const client = createEmbeddingClient({ provider: "openai-compatible", baseUrl, model: "test-model", apiKey: "test-key", edgeBaseUrl: "", edgeApiKey: "edge-key", edgeRegistryUrl: registryUrl, edgeRegistryApiKey: "registry-key", edgeTimeoutMs: 2000 });
    const health = await client.health();
    assert.equal(health.edge.reachable, true, JSON.stringify(health.edge));
    assert.equal(health.edge.baseUrl, edgeUrl);
    assert.deepEqual(await client.embed("hello"), [[5, 9]]);
  } finally {
    await new Promise((resolve) => registryServer.close(resolve));
    await new Promise((resolve) => edgeServer.close(resolve));
  }
});

test("recall mode delegates center and edge racing to the gateway", async () => {
  const requests = [];
  const primaryServer = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "test-model" }] })); return; }
    if (request.url === "/v1/embeddings") {
      requests.push({ side: "center", route: request.headers["x-embedding-route"], mode: request.headers["x-embedding-mode"] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
      return;
    }
    response.writeHead(404).end();
  });
  const edgeServer = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "test-model" }] })); return; }
    if (request.url === "/v1/status") { response.end(JSON.stringify({ ok: true, role: "edge" })); return; }
    if (request.url === "/v1/embeddings") {
      requests.push({ side: "edge", route: request.headers["x-embedding-route"], mode: request.headers["x-embedding-mode"] });
      await new Promise((resolve) => setTimeout(resolve, 50));
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] }));
      return;
    }
    response.writeHead(404).end();
  });
  const [primaryUrl, edgeUrl] = await Promise.all([
    listenFetchSafeOrigin(primaryServer),
    listenFetchSafeOrigin(edgeServer),
  ]);
  try {
    const client = createEmbeddingClient({ provider: "openai", baseUrl: primaryUrl, model: "test-model", apiKey: "test-key", edgeProvider: "openai", edgeBaseUrl: edgeUrl, edgeApiKey: "edge-key", edgeTimeoutMs: 2000 });
    assert.deepEqual(await client.embed("hello", { race: true, priority: "interactive" }), [[1, 0]]);
    assert.deepEqual(requests.map((item) => item.side), ["center"]);
    assert.equal(requests[0].route, undefined);
    assert.equal(requests[0].mode, "recall");
  } finally {
    await new Promise((resolve) => primaryServer.close(resolve));
    await new Promise((resolve) => edgeServer.close(resolve));
  }
});

test("normal embedding uses only a healthy edge and does not fall back to center", async () => {
  let primaryEmbeddingCalls = 0;
  const primaryServer = http.createServer((request, response) => {
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "test-model" }] })); return; }
    if (request.url === "/v1/embeddings") { primaryEmbeddingCalls += 1; response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })); return; }
    response.writeHead(404).end();
  });
  const edgeServer = http.createServer((request, response) => {
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "test-model" }] })); return; }
    if (request.url === "/v1/status") { response.end(JSON.stringify({ ok: true, role: "edge" })); return; }
    if (request.url === "/v1/embeddings") { response.writeHead(503).end(JSON.stringify({ error: { message: "edge busy" } })); return; }
    response.writeHead(404).end();
  });
  const [primaryUrl, edgeUrl] = await Promise.all([
    listenFetchSafeOrigin(primaryServer),
    listenFetchSafeOrigin(edgeServer),
  ]);
  try {
    const client = createEmbeddingClient({ provider: "openai", baseUrl: primaryUrl, model: "test-model", apiKey: "test-key", edgeProvider: "openai", edgeBaseUrl: edgeUrl, edgeApiKey: "edge-key", edgeTimeoutMs: 2000 });
    await assert.rejects(() => client.embed("hello"), /HTTP 503/);
    assert.equal(primaryEmbeddingCalls, 0);
  } finally {
    await new Promise((resolve) => primaryServer.close(resolve));
    await new Promise((resolve) => edgeServer.close(resolve));
  }
});
