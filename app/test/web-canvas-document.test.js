// End-to-end canvas document test (G11): the real server, the real page route, the
// real asset route and the real API, driven over HTTP with a logged-in session.
//
// This is the leg the unit tests cannot see: `/app/canvas/<route>` must 404 on
// anything that is not a `.canvas` file inside the session's allowed Vaults, the
// encoded route must survive the round trip, and the page it serves must publish
// the versioned canvas asset (with the workspace shell still carrying none).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const USER = "canvas-document";
const PASSWORD = "canvas-document-password";

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
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-canvas-document-"));
const vault = path.join(root, "vault");
const outside = path.join(root, "outside");
await fs.mkdir(path.join(vault, "Boards"), { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.writeFile(path.join(vault, "Note.md"), "# document fixture\n");
await fs.writeFile(path.join(vault, "Boards", "Roadmap.canvas"), JSON.stringify(FIXTURE));
await fs.writeFile(path.join(vault, "NotCanvas.canvas"), JSON.stringify({ views: [] }));
await fs.writeFile(path.join(outside, "secret.canvas"), JSON.stringify(FIXTURE));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: APP_DIR,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    VAULT_PATH: vault,
    DATA_PATH: path.join(root, "data"),
    OAUTH_ENABLED: "true",
    PUBLIC_BASE_URL: base,
    OAUTH_INITIAL_USERNAME: USER,
    OAUTH_INITIAL_PASSWORD: PASSWORD,
    OAUTH_ADMIN_PASSWORD: PASSWORD,
    API_KEY: "",
    GIT_ENABLED: "false",
    EMBEDDING_PROVIDER: "disabled",
  },
});
const output = [];
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

test.after(async () => {
  await stopChild(child);
  await fs.rm(root, { recursive: true, force: true });
});

let cookie = "";
async function get(url, options = {}) {
  const response = await fetch(`${base}${url}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    ...options,
    headers: { cookie, ...(options.headers || {}) },
  });
  return { status: response.status, response, text: await response.text() };
}

test("the canvas document route serves the page, and refuses everything else", async (t) => {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output.join("")}`);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const body = new URLSearchParams({ username: USER, password: PASSWORD, next: "/app/" }).toString();
  const login = await fetch(`${base}/auth/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  assert.equal(login.status, 303, "login must succeed for the canvas document probe");
  cookie = (login.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]).join("; ");

  // The workspace shell and the note page must not reference the canvas asset.
  const welcome = await get("/app/");
  assert.equal(welcome.status, 200);
  assert.equal(welcome.text.includes("canvas.js"), false, "/app/ must not reference canvas.js");
  const noteBare = await get("/app/note/Note.md");
  assert.equal(noteBare.status, 302, "a bare note path is a redirect candidate");
  const note = await get(noteBare.response.headers.get("location"));
  assert.equal(note.status, 200);
  assert.equal(note.text.includes("canvas.js"), false, "the note page must not reference canvas.js");

  // A bare vault-relative path is a redirect candidate, never an authorized route.
  const bare = await get("/app/canvas/Boards/Roadmap.canvas");
  assert.equal(bare.status, 302);
  const location = bare.response.headers.get("location");
  assert.match(location, /^\/app\/canvas\/[A-Za-z0-9_-]+$/);
  const encodedRoute = location;

  await t.test("the served page publishes the canvas contract and the versioned asset", async () => {
    const page = await get(encodedRoute);
    assert.equal(page.status, 200);
    assert.equal(page.response.headers.get("cache-control"), "no-store");
    assert.match(page.response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.ok(page.text.includes('<div id="canvas-host" hidden></div>'));
    assert.ok(page.text.includes('data-canvas-path="Boards/Roadmap.canvas"'));
    assert.ok(page.text.includes('<meta name="initial-canvas-path" content="Boards/Roadmap.canvas">'));
    const asset = /<script type="module" src="(\/app\/assets\/canvas\.js\?v=[0-9a-f]{16})"/.exec(page.text);
    assert.ok(asset, "the page must publish the versioned canvas module");
    const served = await fetch(`${base}${asset[1]}`, { headers: { "Accept-Encoding": "identity" } });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-encoding"), null, "an identity request must not be compressed");
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.deepEqual(bytes, await fs.readFile(path.join(APP_DIR, "src/app/assets/canvas.js")));
    // The same bytes the budget gate measures: gzip-negotiated on request.
    const gzipped = await fetch(`${base}${asset[1]}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(gzipped.headers.get("content-encoding"), "gzip");
    assert.match(served.headers.get("cache-control"), /immutable/);
  });

  await t.test("the API agrees with the page about the same document", async () => {
    const api = await get("/api/web/v1/canvas?path=Boards%2FRoadmap.canvas");
    assert.equal(api.status, 200);
    const payload = JSON.parse(api.text);
    assert.equal(api.response.headers.get("cache-control"), "no-store");
    assert.equal(payload.route, encodedRoute, "the API route and the page route are the same identity");
    assert.deepEqual(payload.nodes.map((node) => node.type).sort(), ["file", "group", "link", "text"]);
    assert.deepEqual(payload.edges.map((edge) => edge.id), ["edge-1", "edge-2"]);
    assert.equal(JSON.stringify(payload).includes(root), false, "no absolute fixture path");
  });

  await t.test("anything that is not a canvas file inside the Vault is 404", async () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, vaultId: "default", path: "../outside/secret.canvas" }), "utf8").toString("base64url");
    for (const url of [
      "/app/canvas/Note.md",
      "/app/canvas/Missing.canvas",
      "/app/canvas/Boards",
      `/app/canvas/${forged}`,
      "/api/web/v1/canvas?path=Note.md",
      "/api/web/v1/canvas?path=..%2Foutside%2Fsecret.canvas",
      "/api/web/v1/canvas?path=%2Fetc%2Fpasswd.canvas",
    ]) {
      const response = await get(url);
      assert.equal(response.status, 404, url);
      assert.equal(response.text.includes(root), false, `${url} must not leak the Vault root`);
    }
  });

  await t.test("a non-canvas file is a 422 on the API, never a 500", async () => {
    const response = await get("/api/web/v1/canvas?path=NotCanvas.canvas");
    assert.equal(response.status, 422);
    assert.deepEqual(JSON.parse(response.text), { error: "not-a-canvas" });
  });

  await t.test("no write path exists for a canvas document", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await fetch(`${base}/api/web/v1/canvas?path=Boards%2FRoadmap.canvas`, { method, redirect: "manual", headers: { cookie }, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 404, `${method} must not be routed`);
    }
  });
});
