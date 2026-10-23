// HTTP contract tests for GET /api/web/v1/canvas (G11 minimal API face).
//
// Real Express + real http.createServer with injected fake auth and the real
// root-scoped reader against a synthetic tmp vault. Verifies the frozen status
// mapping (RECON §4 刀2 ③: a file without a `nodes` array is an explicit 4xx, never
// a 500), the DTO, no-store/security headers and the absence of any write path.
process.env.MAX_READ_BYTES = "2048";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const [{ registerCanvasRoute }, { readCanvasDocument }] = await Promise.all([
  import("../src/app/canvas-route.js"),
  import("../src/app/canvas-reader.js"),
]);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-canvas-route-"));
const vaultDir = path.join(root, "vault");
const outside = path.join(root, "outside");
await fs.mkdir(vaultDir, { recursive: true });
await fs.mkdir(outside, { recursive: true });

// The lane fixture: all four desktop node types and two edges, one per axis.
const FIXTURE = {
  nodes: [
    { id: "group-a", type: "group", x: -120, y: -80, width: 640, height: 420, background: "#1f1f1f" },
    { id: "text-a", type: "text", x: 0, y: 0, width: 240, height: 120, text: "卡片" },
    { id: "file-a", type: "file", x: 400, y: 0, width: 240, height: 120, file: "Notes/Plan.md", subpath: "#Step" },
    { id: "link-a", type: "link", x: 200, y: 280, width: 240, height: 80, url: "https://example.com/a" },
  ],
  edges: [
    { id: "edge-1", fromNode: "text-a", fromSide: "right", toNode: "file-a", toSide: "left", color: "#e03131" },
    { id: "edge-2", fromNode: "text-a", fromSide: "bottom", toNode: "link-a", toSide: "top", label: "see also" },
  ],
  version: "1.0-1.1",
};
await fs.writeFile(path.join(vaultDir, "Board.canvas"), JSON.stringify(FIXTURE));
await fs.writeFile(path.join(vaultDir, "Empty.canvas"), JSON.stringify({ nodes: [], edges: [] }));
await fs.writeFile(path.join(vaultDir, "NotCanvas.canvas"), JSON.stringify({ views: [{ name: "All" }] }));
await fs.writeFile(path.join(vaultDir, "Broken.canvas"), '{"nodes":[{"id":"x"');
await fs.writeFile(path.join(vaultDir, "Dir.canvas"), "", { flag: "w" }).catch(() => {});
await fs.rm(path.join(vaultDir, "Dir.canvas"), { force: true });
await fs.mkdir(path.join(vaultDir, "Dir.canvas"), { recursive: true });
await fs.writeFile(path.join(vaultDir, "Big.canvas"), "x".repeat(4096));
await fs.writeFile(path.join(vaultDir, "Project.base"), "views: []\n");
await fs.writeFile(path.join(outside, "secret.canvas"), JSON.stringify(FIXTURE));

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const HTTP_TIMEOUT_MS = 5_000;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function securityHeaders(_req, res, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}

function makeDeps(overrides = {}) {
  return {
    requireApi(req, res, next) {
      if (req.get("x-test-auth") !== "ok") return res.status(401).json({ error: "Login required" });
      req.webSession = { allowedScopes: ["obsidian.read"] };
      next();
    },
    async currentVault(req) {
      const id = req.get("x-test-vault") || "primary";
      if (id === "denied") throw new Error("Vault access denied");
      return { id, root: vaultDir };
    },
    readCanvas: overrides.readCanvas ?? readCanvasDocument,
  };
}

async function startServer(deps, { security = true } = {}) {
  const app = express();
  if (security) app.use("/api/web/v1", securityHeaders);
  const router = express.Router();
  registerCanvasRoute(router, deps);
  app.use(router);
  app.use((error, _req, res, _next) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Vault access denied") return res.status(403).json({ error: "Vault access denied" });
    res.status(500).json({ error: "Request failed" });
  });
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function request(server, query = "", { method = "GET", vault = "primary", auth = "ok" } = {}) {
  return fetch(`${server.base}/api/web/v1/canvas${query}`, {
    method,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { "x-test-auth": auth, "x-test-vault": vault },
  });
}

test("unauthenticated requests are 401 before any Vault access", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Board.canvas", { auth: "no" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Login required");
  } finally {
    await server.close();
  }
});

test("a vault outside the account allowlist is 403 and never reads the file", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Board.canvas", { vault: "denied" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Vault access denied");
  } finally {
    await server.close();
  }
});

test("a canvas document returns the frozen DTO (4 node types + 2 edges)", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Board.canvas");
    assert.equal(response.status, 200);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(response.headers.get(name.toLowerCase()), value, `${name} must be set`);
    }
    const body = await response.json();
    assert.deepEqual(body.nodes.map((node) => node.type).sort(), ["file", "group", "link", "text"]);
    assert.deepEqual(body.edges.map((edge) => edge.id), ["edge-1", "edge-2"]);
    assert.deepEqual(body.edges[0], { id: "edge-1", fromNode: "text-a", fromSide: "right", toNode: "file-a", toSide: "left", color: "#e03131" });
    assert.deepEqual(body.edges[1], { id: "edge-2", fromNode: "text-a", fromSide: "bottom", toNode: "link-a", toSide: "top", label: "see also" });
    const text = body.nodes.find((node) => node.id === "text-a");
    assert.deepEqual(text, { id: "text-a", type: "text", x: 0, y: 0, width: 240, height: 120, text: "卡片" });
    assert.equal(body.path, "Board.canvas");
    assert.match(body.revision, /^sha256:[0-9a-f]{64}$/);
    assert.match(body.route, /^\/app\/canvas\//);
    assert.deepEqual(body.unknownData, { version: "1.0-1.1" });
    assert.equal(JSON.stringify(body).includes(root), false, "no absolute fixture path in the body");
  } finally {
    await server.close();
  }
});

test("an empty canvas is a canvas (200), not an error", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Empty.canvas");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
    assert.equal(body.unknownData, undefined);
  } finally {
    await server.close();
  }
});

test("a file without a nodes array is 422 (explicit 4xx, never a 500)", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=NotCanvas.canvas");
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "not-a-canvas");
    const broken = await request(server, "?path=Broken.canvas");
    assert.equal(broken.status, 422);
    assert.equal((await broken.json()).error, "invalid-json");
  } finally {
    await server.close();
  }
});

test("path problems are 404 without leaking absolute paths", async () => {
  const server = await startServer(makeDeps());
  try {
    for (const bad of ["Missing.canvas", "Project.base", "Dir.canvas", "../outside/secret.canvas", "/etc/passwd.canvas", "C:/tmp/x.canvas"]) {
      const response = await request(server, `?path=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 404, bad);
      const body = await response.json();
      assert.equal(body.error, "canvas-not-found", bad);
      assert.equal(JSON.stringify(body).includes(root), false, "no absolute fixture path in the body");
    }
    const tooLarge = await request(server, "?path=Big.canvas");
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error, "canvas-too-large");
  } finally {
    await server.close();
  }
});

test("the path parameter is validated before any IO (400 invalid-path)", async () => {
  let calls = 0;
  const deps = makeDeps({ readCanvas: async (...args) => { calls += 1; return readCanvasDocument(...args); } });
  const server = await startServer(deps);
  try {
    for (const query of ["", "?path=", "?path=a&path=b", "?path[]=x"]) {
      const response = await request(server, query);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error, "invalid-path", query);
    }
    assert.equal(calls, 0, "an invalid request must not touch the reader");
  } finally {
    await server.close();
  }
});

test("the route is GET-only: no write path exists", async () => {
  const server = await startServer(makeDeps());
  try {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await request(server, "?path=Board.canvas", { method });
      assert.equal(response.status, 404, `${method} must not be routed`);
    }
  } finally {
    await server.close();
  }
});

test("unknown IO failures stay 500 with a stable body", async () => {
  const server = await startServer(makeDeps({ readCanvas: async () => { throw Object.assign(new Error("boom /var/secret"), { code: "EIO" }); } }));
  try {
    const response = await request(server, "?path=Board.canvas");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Request failed" });
  } finally {
    await server.close();
  }
});
