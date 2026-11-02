import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Regression coverage for src/oauth/hardening.js. These assertions are written
// against the real HTTP endpoints on purpose: a helper-only test would not prove
// that the mounted middleware runs before the SDK auth router.

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

async function waitFor(url, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server: ${output.join("")}`);
}

const ZOD_DUMP = /"expected"|invalid_type|"path":/;

test("OAuth endpoints reject malformed PKCE challenges and never leak raw validation dumps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-oauth-hardening-"));
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: base,
      OAUTH_ADMIN_PASSWORD: "test-only-password",
      OAUTH_INITIAL_USERNAME: "test-owner",
      OAUTH_INITIAL_PASSWORD: "test-oauth-password",
      API_KEY: "",
      GIT_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const redirect = encodeURIComponent(`${base}/app`);
  const authorize = (extra) => fetch(`${base}/oauth/authorize?response_type=code&client_id=bogus&redirect_uri=${redirect}&code_challenge_method=S256${extra}`);
  try {
    await waitFor(`${base}/healthz`, child, output);

    // 1. A one-character challenge used to be accepted by the SDK's `z.string()`.
    const short = await authorize("&code_challenge=abc");
    assert.equal(short.status, 400);
    const shortBody = await short.json();
    assert.equal(shortBody.error, "invalid_request");
    assert.match(shortBody.error_description, /43-128/);
    assert.doesNotMatch(JSON.stringify(shortBody), ZOD_DUMP);

    // 2. A missing challenge used to produce a serialized Zod issue array.
    const missing = await authorize("");
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, "invalid_request");
    assert.doesNotMatch(JSON.stringify(missingBody), ZOD_DUMP);

    // 3. Registration with an empty body used to echo the metadata schema.
    const register = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(register.status, 400);
    const registerBody = await register.json();
    assert.equal(registerBody.error, "invalid_client_metadata");
    assert.doesNotMatch(JSON.stringify(registerBody), ZOD_DUMP);

    // 4. A well-formed challenge must still reach the SDK's own client validation,
    //    proving the middleware only rejects unusable challenges.
    const wellFormed = await authorize(`&code_challenge=${"A".repeat(43)}`);
    assert.equal(wellFormed.status, 400);
    const wellFormedBody = await wellFormed.json();
    assert.equal(wellFormedBody.error, "invalid_client");
    assert.equal(wellFormedBody.error_description, "Invalid client_id");

    // 5. A valid registration must still succeed unchanged.
    const created = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "oauth-hardening-test",
        redirect_uris: [`${base}/app`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.ok(createdBody.client_id);
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
