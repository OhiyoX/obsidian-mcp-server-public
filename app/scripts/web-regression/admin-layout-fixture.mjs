// Fixture + seeding helpers for the Admin layout browser gate (issues #401-#406).
//
// Split out of `admin-layout.mjs` for the architecture line budget. This module owns the
// scratch Vault, the real Git repository, the fixture server and the real MCP calls; the scene
// module owns the assertions, `admin-layout-midword.mjs` owns the mid-word break contract
// (RETURN-2) and `admin-layout-author.mjs` owns the #400 pending-author browser regression.
//
// Issue #435: the pending batch used to be *always* empty here, and not because of the `git`
// binary. The fixture ran `GIT_AUTO_COMMIT=false`, and `src/git-runtime/runtime.js:185` returns
// `{ tracked: false, reason: "disabled" }` for a write in that state, so nothing was ever tracked:
// a fixture with a real repository (`gitRepo: true`) still reported `pendingCount: 0`. The earlier
// "git binary unavailable" attribution was wrong. `startAdminLayoutFixture` therefore enables
// autoCommit and pins a debounce / max-delay far beyond any scene, so the pending batch is
// sampled inside a window the fixture controls instead of racing a short timer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { listenFetchSafe } from '../fetch-safe-listen.mjs';


export const VIEWPORT = { width: 1600, height: 1000 };

/**
 * The explicit author every fixture MCP call declares through `_meta[obsidian/author]` (#400).
 * `admin-layout-author.mjs` asserts that a real MCP write with this author leaves a visible
 * pending batch and never renders `[object Object]`; the MCP session's `clientInfo.name` must
 * match it (`resolveRequestAuthor` rejects a mismatch).
 */
export const GATE_AUTHOR = Object.freeze({ agent: 'admin-layout-gate', model: 'gate' });

/**
 * The policy seed used by the window-presentation scene (`admin-window-presentation.mjs`) and by
 * the standalone policy fixtures: one uuid subject and one capability.
 */
export const POLICY_SEED = Object.freeze({
  mode: 'suspend', enabled: 'true', timezone: 'Asia/Shanghai', startsAt: '', expiresAt: '',
  subjects: ['api-key:configured-env', 'api-key:c74f039e-cda6-4b63-b9ab-cfca1babd021'],
  capabilities: 'scope:obsidian.read', weekly: 'mon 00:00-24:00', dateRanges: '',
});

/**
 * A loopback port this harness can actually `fetch()`. `listen(0)` alone is not enough on this host:
 * Windows draws from 1024-15000, so an OS-assigned port can land below undici's "bad port" ceiling
 * and every readiness probe fails with `bad port` (issue #344). The gate used to red as
 * "the Admin layout fixture server must become ready" whenever the draw was unlucky — a host-level
 * flake that looked like a product failure. `listenFetchSafe` is the repository's one implementation
 * of that rule; it re-listens the same socket until the bound port is fetch-safe.
 */
export async function freePort() {
  const probe = net.createServer();
  const port = await listenFetchSafe(probe, { host: '127.0.0.1' });
  await new Promise((resolve) => probe.close(() => resolve()));
  return port;
}

/** True when nothing accepts a TCP connection on `port` (the fixture released its listener). */
async function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (free) => { socket.destroy(); resolve(free); };
    socket.setTimeout(2000);
    socket.once('connect', () => settle(false));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(true));
  });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

/**
 * A real Git repository for the fixture Vault, so the Admin page reports a real pending batch
 * (待提交 with paths and authors) instead of `repository-missing`.
 *
 * Returns `{ ok, reason }`. When `ok` is false the `git` binary could not be used at all (or could
 * not create the seed commit); the #435 author regression then FAILS explicitly, because a missing
 * repository means no pending batch and a zero count is not evidence about the author rendering.
 */
export async function initGitRepo(vault) {
  let failure = null;
  const run = (args) => new Promise((resolve) => {
    const child = spawn('git', args, { cwd: vault, windowsHide: true, stdio: 'ignore' });
    child.on('error', (error) => { failure = error.code === 'ENOENT' ? 'git-not-found' : `git-spawn-failed: ${error.message}`; resolve(false); });
    child.on('exit', (code) => resolve(code === 0));
  });
  if (!await run(['init', '-q'])) return { ok: false, reason: failure ?? 'git-init-failed' };
  await run(['add', '-A']);
  if (!await run(['-c', 'user.email=gate@example.invalid', '-c', 'user.name=layout-gate', 'commit', '-q', '-m', 'fixture seed', '--allow-empty'])) {
    return { ok: false, reason: failure ?? 'git-seed-commit-failed' };
  }
  return { ok: true, reason: null };
}

/**
 * One real MCP tool call over `x-api-key`, declaring an explicit `_meta[obsidian/author]`.
 * Each call opens its own session (nothing is shared between calls) and returns the JSON-RPC
 * `result`; a tool that reports `isError` fails the caller instead of returning silently.
 */
export async function mcpCall(base, apiKey, name, args, author = GATE_AUTHOR) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey };
  const post = async (body, sessionId) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { const line = text.split('\n').find((item) => item.startsWith('data: ')); if (line) json = JSON.parse(line.slice(6)); }
    return { sessionId: response.headers.get('mcp-session-id'), json, text, status: response.status };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: author.agent, version: '1.0' } } });
  assert.ok(init.sessionId, `MCP initialize must open a session: ${init.status} ${init.text.slice(0, 200)}`);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
  const call = await post({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name, arguments: args, _meta: { 'obsidian/author': author } },
  }, init.sessionId);
  assert.equal(call.json?.result?.isError, undefined, `MCP ${name} must succeed: ${call.text.slice(0, 200)}`);
  return call.json.result;
}

/**
 * Start the isolated Admin fixture: scratch Vault (registry id `default`, the production id that
 * rendered as `defa|ult`), a data dir, a real server on a free port, and long `GIT_*` tokens.
 * Returns `{ base, password, apiKey, child, gitRepo, gitReason, fixtureRoot, stop }`.
 *
 * `prepareData(dataDir)` (optional, added by lane l4-gates) runs after the scratch data dir exists
 * and **before** the server spawns, so a scene can seed a file the process only reads at boot — the
 * no-JS gate uses it to plant a corrupt `git-vaults.json` and exercise the real repair flow.
 */
export async function startAdminLayoutFixture({ root, appRoot, serverErrors = [], prepareData = null }) {
  const fixtureRoot = path.join(root, 'admin-layout');
  const vault = path.join(fixtureRoot, 'vault');
  await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
  await fs.writeFile(path.join(vault, 'notes', 'seed.md'), '# seed\n\nfixture note\n');
  const git = await initGitRepo(vault);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const apiKey = randomBytes(16).toString('hex');
  const dataRoot = path.join(fixtureRoot, 'data');
  if (typeof prepareData === 'function') {
    await fs.mkdir(dataRoot, { recursive: true });
    await prepareData(dataRoot);
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), VAULT_PATH: vault, DATA_PATH: dataRoot,
      // RETURN-3 ②: the catalog SQLite file is `$WEB_CATALOG_DIR/<vault.id>.sqlite`, and its
      // default (`process.cwd()/data/web-catalog`) is *shared* - the harness server also runs
      // with `cwd: appRoot` and both vaults carry the registry id `default`. Without this line
      // the two servers open one file, and this fixture's tiny vault overwrites the shared
      // Explorer catalog with `notes/` (`stale: true`), so the next shared-page scene can no
      // longer open `A.md`. Keep the catalog inside our own scratch root.
      WEB_CATALOG_DIR: path.join(fixtureRoot, 'web-catalog'),
      WEB_VAULTS_ROOT: '', WEB_DEFAULT_VAULT: '', PUBLIC_BASE_URL: base,
      OAUTH_ENABLED: 'true', OAUTH_INITIAL_USERNAME: 'layout-gate', OAUTH_INITIAL_PASSWORD: password, OAUTH_ADMIN_PASSWORD: password,
      API_KEY: apiKey, AUTHZ_ENABLED: 'true',
      // #435: autoCommit is ON so a real MCP write produces a real pending batch, and the
      // debounce / max-delay are far beyond any scene, so the batch is still pending when the
      // #400 author assertion reads it (a short debounce would commit it out from under the check).
      // Sweep stays off: it would consume the batch on the whole-tree timer. Push stays off.
      GIT_ENABLED: 'true', GIT_AUTO_COMMIT: 'true', GIT_AUTO_PUSH: 'false', GIT_AUTO_COMMIT_SWEEP: 'false',
      GIT_COMMIT_DEBOUNCE_SECONDS: '86400', GIT_COMMIT_MAX_DELAY_SECONDS: '86400',
      // Long real tokens in the summary row, and the long env-default config-source pill.
      GIT_REMOTE: 'mirror-eu-central-1', GIT_BRANCH: 'feature/admin-ui-layout-standard',
      EMBEDDING_PROVIDER: 'disabled', EMBEDDING_EDGE_PROVIDER: 'disabled', EMBEDDING_EDGE_BASE_URL: '', EMBEDDING_EDGE_REGISTRY_URL: '',
      RETRIEVAL_AUTO_EMBED: 'false', WEB_FILE_WATCH_DEBOUNCE_MS: '50',
    },
  });
  child.stderr.on('data', (data) => serverErrors.push(data.toString()));
  child.stdout.resume();
  let shutdown = null;
  return {
    base, password, apiKey, child, fixtureRoot, gitRepo: git.ok, gitReason: git.reason,
    /**
     * Stop the fixture and prove what it released. The scene turns this evidence into a check
     * (RETURN-3 ②): a leaked child, port or scratch directory is exactly the cross-scene
     * interference class this scene was blamed for. Idempotent, so the caller's `finally` may
     * stop again after the check already did.
     */
    async stop() {
      if (shutdown) return shutdown;
      child.kill();
      const exited = await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(true); else child.once('exit', () => resolve(true)); });
      // The fixture lives under the caller's owned scratch root; remove only our own subdirectory.
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
      // On Windows `child.kill()` is reported as `signalCode: 'SIGTERM'` with a null `exitCode`,
      // so the evidence is "reaped and accounted for" rather than "exitCode set".
      shutdown = {
        childExited: exited && (child.exitCode !== null || child.signalCode !== null),
        childExitCode: child.exitCode,
        childSignal: child.signalCode ?? null,
        portReleased: await portIsFree(port),
        fixtureRootRemoved: !(await exists(fixtureRoot)),
      };
      return shutdown;
    },
  };
}
