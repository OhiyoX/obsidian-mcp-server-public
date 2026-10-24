// #598/#617 W3-C real-authentication Compact profile characterization.
// Real child server.js, real managed API keys/OAuth PKCE, actual HTTP middleware.
// Scratch VAULT_PATH/DATA_PATH only; secrets never enter fixtures/artifacts.
// A passing result is NOT cross-Vault/time-window/revocation full-matrix GO.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  API_KEY,
  approveAndExchange,
  callTool,
  freePort,
  initialize,
  listTools,
  mcp,
  outsideWindowPolicy,
  registerOAuthClient,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
  writePolicy,
} from "./helpers/server-spawn-fixtures.js";

const exec = promisify(execFile);
const SCOPE_READ = ["obsidian.read"];
const SCOPE_FILES = ["obsidian.read", "obsidian.files"];
const SCOPE_WRITE = ["obsidian.read", "obsidian.write"];
const SCOPE_ALL = ["obsidian.read", "obsidian.write", "obsidian.files"];
const COMPACT = "compact";
const APP = path.resolve(import.meta.dirname, "..");
const SEED = path.join(APP, "scripts", "scope-seed-key.mjs");

function actions(tools) {
  return tools.flatMap((tool) =>
    tool.inputSchema?.oneOf
      ? tool.inputSchema.oneOf.map((branch) => ({
          action: branch.properties.action.const,
          name: tool.name,
          schema: branch.properties.params,
        }))
      : [{ action: tool.name, name: tool.name, schema: tool.inputSchema }],
  );
}

async function managedKey(root, port, scopes, label) {
  const env = {
    ...process.env,
    DATA_PATH: path.join(root, "data"),
    VAULT_PATH: path.join(root, "vault"),
    WEB_VAULTS_ROOT: path.join(root, "vaults"),
    WEB_DEFAULT_VAULT: "vault",
    PUBLIC_BASE_URL: "http://localhost:" + port,
    MCP_PATH: "/mcp",
    OAUTH_ADMIN_PASSWORD: "test-only-password",
    SEED_SCOPES: JSON.stringify(scopes),
    SEED_LABEL: label,
  };
  const result = await exec(process.execPath, [SEED], {
    cwd: APP, env, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  // The secret is returned in memory only and intentionally never logged.
  const key = JSON.parse(result.stdout);
  assert.deepEqual(key.scopes, scopes);
  assert.ok(key.secret);
  return key;
}

async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compact-w3-real-auth-"));
  const port = await freePort();
  await seedVault(root);
  await fs.mkdir(path.join(root, "vaults", "secondary"), { recursive: true });
  await fs.writeFile(path.join(root, "vaults", "secondary", "private.md"), "# Secondary sentinel: forbidden\n", "utf8");
  return { root, port };
}

function envFor({ root, port }, extra = {}) {
  return serverEnv({
    root, port,
    extra: {
      API_KEY: "",
      MCP_DISCOVERY_PROFILE: COMPACT,
      VAULT_DISCOVERY_ENABLED: "false",
      OBSIDIAN_READ_ONLY: "false",
      EMBEDDING_PROVIDER: "disabled",
      GIT_ENABLED: "false",
      WEB_VAULTS_ROOT: path.join(root, "vaults"),
      WEB_DEFAULT_VAULT: "vault",
      ...extra,
    },
  });
}

test("W3-C real managed API-key HTTP: four Scope combinations, direct-call denial, Vault binding", async () => {
  const fixture = await scratch();
  const { root, port } = fixture;
  let child;
  try {
    const cells = [
      { label: "read", scopes: SCOPE_READ, file: false, write: false },
      { label: "files", scopes: SCOPE_FILES, file: true, write: false },
      { label: "write", scopes: SCOPE_WRITE, file: false, write: true },
      { label: "all", scopes: SCOPE_ALL, file: true, write: true },
    ];
    for (const cell of cells) cell.key = await managedKey(root, port, cell.scopes, "w3-" + cell.label);
    const started = await startServer(envFor(fixture));
    child = started.child;
    const base = started.base;
    for (const cell of cells) {
      const auth = { key: cell.key.secret };
      const init = await initialize(base, auth);
      assert.equal(init.status, 200, cell.label);
      const listed = await listTools(base, auth, init.session);
      assert.equal(listed.status, 200, cell.label);
      const routes = actions(listed.payload.result.tools);
      const has = (name) => routes.some((entry) => entry.action === name);
      assert.equal(has("get_note"), true, cell.label);
      assert.equal(has("get_file"), cell.file, cell.label);
      assert.equal(has("write_note"), cell.write, cell.label);
      assert.equal(has("git_push"), cell.write, cell.label);
      assert.equal(has("start_file_upload"), cell.file && cell.write, cell.label);
      const noteRoute = routes.find((route) => route.action === "get_note");
      const valid = await callTool(base, auth, init.session, noteRoute.name, {
        action: "get_note", params: { path: "note.md", format: "content" },
      });
      assert.equal(valid.status, 200, cell.label);
      assert.notEqual(valid.payload.result.isError, true, cell.label);
      if (!cell.write) {
        // Guess a virtual name previously advertised to a full-scope caller:
        // HTTP Scope must deny it, before any native mutation.
        const denied = await callTool(base, auth, init.session, "obsidian_edit_write_nonidempotent", {
          action: "write_note", params: { path: "forbidden-" + cell.label + ".md", content: "bad" },
        });
        assert.equal(denied.status, 403, cell.label);
        await assert.rejects(fs.access(path.join(root, "vault", "forbidden-" + cell.label + ".md")));
      }
      if (!cell.file) {
        const denied = await callTool(base, auth, init.session, "obsidian_file_read", {
          action: "get_file", params: { path: "note.md", encoding: "text" },
        });
        assert.equal(denied.status, 403, cell.label);
      }
      // All four credentials are primary-Vault-only, even at full Scope.
      const cross = await callTool(base, auth, init.session, noteRoute.name, {
        action: "get_note", params: { vaultId: "secondary", path: "private.md" },
      });
      assert.equal(cross.status, 403, cell.label);
      assert.doesNotMatch(cross.text, /Secondary sentinel: forbidden/);
      const legacy = await callTool(base, auth, init.session, "get_note", { path: "note.md" });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.payload.result.isError, true, "legacy direct call must be hidden in compact");
    }
    // Full credential is a genuine write capability, confined to a scratch Vault.
    const full = cells[3];
    const auth = { key: full.key.secret };
    const init = await initialize(base, auth);
    const listed = await listTools(base, auth, init.session);
    const write = actions(listed.payload.result.tools).find((x) => x.action === "write_note");
    assert.ok(write);
    const result = await callTool(base, auth, init.session, write.name, {
      action: "write_note", params: { path: "compact-real-auth-smoke.md", content: "# Real-scoped write\n", overwrite: false },
    });
    assert.equal(result.status, 200);
    assert.notEqual(result.payload.result.isError, true);
    assert.match(await fs.readFile(path.join(root, "vault", "compact-real-auth-smoke.md"), "utf8"), /Real-scoped write/);
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("W3-C real OAuth PKCE bearer: compact exposes only granted read actions and rejects writes", async () => {
  const fixture = await scratch();
  let child;
  try {
    const server = await startServer(envFor(fixture));
    child = server.child;
    const client = { ...(await registerOAuthClient(server.base)), resource: server.publicBase + "/mcp" };
    const tokens = await approveAndExchange(server.base, client);
    const auth = { bearer: tokens.access_token };
    const init = await initialize(server.base, auth);
    assert.equal(init.status, 200);
    const visible = actions((await listTools(server.base, auth, init.session)).payload.result.tools);
    assert.ok(visible.some((x) => x.action === "get_note"));
    assert.equal(visible.some((x) => x.action === "write_note"), false);
    assert.equal(visible.some((x) => x.action === "get_file"), false);
    const denied = await callTool(server.base, auth, init.session, "obsidian_edit_write_nonidempotent", {
      action: "write_note", params: { path: "oauth-forbidden.md", content: "no" },
    });
    assert.equal(denied.status, 403);
    await assert.rejects(fs.access(path.join(fixture.root, "vault", "oauth-forbidden.md")));
  } finally {
    await stopChild(child);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("W3-C real configured-key AuthZ window: compact call suspended, hard revoke refuses initialization", async () => {
  const fixture = await scratch();
  let child;
  try {
    await writePolicy(fixture.root, [outsideWindowPolicy()]);
    const configured = envFor(fixture, { AUTHZ_ENABLED: "true", API_KEY });
    const server = await startServer(configured);
    child = server.child;
    const auth = { key: API_KEY };
    const init = await initialize(server.base, auth);
    assert.equal(init.status, 200);
    const tools = actions((await listTools(server.base, auth, init.session)).payload.result.tools);
    const route = tools.find((item) => item.action === "get_note");
    assert.ok(route);
    const denied = await callTool(server.base, auth, init.session, route.name, {
      action: "get_note", params: { path: "note.md" },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.payload.result.isError, true);
    assert.equal(denied.payload.result.structuredContent?.code, "outside_authorized_window");
    await stopChild(child);
    child = null;
    await writePolicy(fixture.root, [outsideWindowPolicy({ mode: "revoke", capabilities: ["all"] })], 2);
    const restarted = await startServer(configured);
    child = restarted.child;
    const blocked = await initialize(restarted.base, auth);
    assert.equal(blocked.status, 401);
    assert.doesNotMatch(blocked.text, /note\.md|outside_authorized_window/);
  } finally {
    await stopChild(child);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
