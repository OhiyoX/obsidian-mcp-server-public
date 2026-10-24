// Standalone runner for the Web Publish surface browser contract (Wave C / C3).
//
// Same shape as `run-web-bases-checks.mjs`: a synthetic tmp Vault fixture, a real
// `server.js` with OAuth enabled, and a real headless Chromium. It does NOT import or
// modify the shared harness (`web-regression.mjs` / `run-browser-ci.mjs`).
//
// Usage (from app/):
//   node scripts/run-web-publish-checks.mjs
//   node scripts/run-web-publish-checks.mjs --list
//   node scripts/run-web-publish-checks.mjs --json --output=DIR
//
// Playwright resolution:
//   PLAYWRIGHT_MODULE       absolute path to an external playwright entry module
//   CHROMIUM_EXECUTABLE     absolute path to a Chromium binary
//
// With no Playwright runtime the runner prints "runtime unavailable" and exits 2.
// It never installs packages and never runs `npm ci`.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createWebPublishFixtureVault, fixtureNotePath } from "./web-publish-fixtures.mjs";
import { registerWebPublishChecks, WEB_PUBLISH_SCENARIOS } from "./web-publish-checks.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = { list: false, json: false, output: "" };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help") options.help = true;
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
  }
  return options;
}

function failRuntime(reason) {
  console.error(`web-publish-checks: runtime unavailable: ${reason}`);
  console.error("Set PLAYWRIGHT_MODULE (and CHROMIUM_EXECUTABLE if needed); this runner never installs dependencies.");
  return 2;
}

async function loadChromium() {
  const modulePath = process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright";
  try {
    const mod = await import(modulePath);
    // A CJS playwright build surfaces its exports on `default` under the ESM loader.
    const chromium = mod?.chromium ?? mod?.default?.chromium;
    if (!chromium) return { error: new Error(`module ${modulePath} has no chromium export`) };
    return { chromium };
  } catch (error) {
    return { error };
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, sleep) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`test server exited early with code ${child.exitCode}`);
    await sleep(100);
  }
  throw new Error("test server did not become healthy");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: node scripts/run-web-publish-checks.mjs [--list] [--json] [--output=DIR]");
    return 0;
  }
  if (options.list) {
    console.log("# Web Publish surface browser contract checks");
    for (const scenario of WEB_PUBLISH_SCENARIOS) console.log(`${scenario.id}\t${scenario.name}`);
    console.log(`check-count: ${WEB_PUBLISH_SCENARIOS.length}`);
    return 0;
  }

  const { chromium, error } = await loadChromium();
  if (!chromium) return failRuntime(error?.message || String(error));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-publish-"));
  const fixtures = await createWebPublishFixtureVault(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("hex");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: base,
      OAUTH_INITIAL_USERNAME: "browser-test",
      OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password,
      API_KEY: "",
      GIT_ENABLED: "false",
      GIT_AUTO_COMMIT: "false",
      GIT_AUTO_PUSH: "false",
      EMBEDDING_PROVIDER: "disabled",
      EMBEDDING_EDGE_PROVIDER: "disabled",
      EMBEDDING_EDGE_BASE_URL: "",
      EMBEDDING_EDGE_REGISTRY_URL: "",
      RETRIEVAL_AUTO_EMBED: "false",
      WEB_FILE_WATCH_DEBOUNCE_MS: "50",
      ...fixtures.serverEnv,
    },
  });
  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(chunk.toString()));
  child.stdout.resume();

  const results = [];
  const notes = [];
  let browser;
  let page;
  let state = null;
  try {
    await waitForHealth(base, child, sleep);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on("pageerror", (pageError) => pageErrors.push(pageError.stack || pageError.message));

    let webLoggedIn = false;
    async function login() {
      if (webLoggedIn) return;
      const response = await page.request.post(`${base}/auth/login`, { form: { username: "browser-test", password } });
      assert.equal(response.status(), 200, `web login failed with ${response.status()}`);
      webLoggedIn = true;
    }

    let adminLoggedIn = false;
    async function adminLogin() {
      if (adminLoggedIn) return;
      const response = await page.request.post(`${base}/admin/auth/login`, { form: { password } });
      assert.ok([200, 303].includes(response.status()), `admin login returned ${response.status()}`);
      adminLoggedIn = true;
    }

    async function csrfToken() {
      const html = await (await page.request.get(`${base}/app`)).text();
      const token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
      assert.ok(token, "the app page must expose a CSRF token");
      return token;
    }

    async function publishNote(notePath) {
      const token = await csrfToken();
      const response = await page.request.post(`${base}/api/web/v1/publish`, {
        headers: { "X-CSRF-Token": token },
        data: { action: "publish", path: notePath },
      });
      assert.equal(response.status(), 200, `publish ${notePath} returned ${response.status()}: ${await response.text()}`);
      const body = await response.json();
      assert.equal(body.published, true, `publish ${notePath} must report published`);
      assert.equal(body.vaultId, "default", `fixture expects the single-vault id, got ${body.vaultId}`);
      // The Web publish payload exposes the opaque id only through `publicPath`.
      const id = String(body.publicPath || "").split("/").at(-1);
      assert.match(id, /^[A-Za-z0-9_-]{43}$/, `publish ${notePath} must return an opaque id in publicPath`);
      return { ...body, id };
    }

    async function search(apiPath, q) {
      const response = await page.request.get(`${base}${apiPath}?q=${encodeURIComponent(q)}`);
      assert.equal(response.status(), 200, `${apiPath} ${q} returned ${response.status()}`);
      return response.json();
    }

    await login();
    // The catalog must finish its first reconcile before a `published:` filter can run.
    for (let attempt = 0; ; attempt += 1) {
      const response = await page.request.get(`${base}/api/web/v2/search?q=${encodeURIComponent("published:false")}`);
      if (response.status() === 200) break;
      if (attempt >= 150) throw new Error(`v2 search never became ready: ${response.status()}`);
      await sleep(100);
    }

    const active = await publishNote(fixtures.files.active);
    const orphan = await publishNote(fixtures.files.orphan);

    // Observe the delete (through the same `list()` the Publishes filter uses), then put
    // the path back: the record must stay retired while the note is back on disk.
    await fs.rm(fixtureNotePath(fixtures, fixtures.files.orphan));
    await search("/api/web/v2/search", "published:true");
    await fs.writeFile(fixtureNotePath(fixtures, fixtures.files.orphan), "# Orphan\n\nrecreated at the same path\n");

    let orphanReindexed = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const body = await search("/api/web/v2/search", "published:false");
      if (body.items.some((item) => item.path === fixtures.files.orphan)) { orphanReindexed = true; break; }
      await sleep(200);
    }

    const persisted = JSON.parse(await fs.readFile(fixtures.stateFile, "utf8"));
    const lifecycle = Object.fromEntries(persisted.records.map((record) => [record.id, record.lifecycle]));
    notes.push(`catalog re-indexed the recreated orphan path: ${orphanReindexed}`);
    notes.push(`state lifecycles after setup: ${JSON.stringify(lifecycle)}`);
    assert.equal(lifecycle[orphan.id], "orphaned", `the setup must observe the delete before the checks run: ${JSON.stringify({ orphan: orphan.id, active: active.id, lifecycle })}`);
    assert.equal(lifecycle[active.id], "active", "the active record must stay active");
    assert.equal(lifecycle[fixtures.invalidId], "invalid", "the hand-written non-Markdown record must classify as invalid");

    state = {
      activeId: active.id,
      activePublicPath: active.publicPath,
      activePath: fixtures.files.active,
      orphanId: orphan.id,
      orphanPath: fixtures.files.orphan,
      plainPath: fixtures.files.plain,
      decoyPath: fixtures.files.decoy,
      invalidPath: fixtures.files.invalid,
    };

    await registerWebPublishChecks({
      check: async (name, fn) => {
        const start = Date.now();
        try {
          await fn();
          results.push({ name, pass: true, ms: Date.now() - start });
          console.log(`PASS ${name}`);
        } catch (checkError) {
          results.push({ name, pass: false, error: checkError.message, ms: Date.now() - start });
          console.log(`FAIL ${name}: ${checkError.message}`);
        }
      },
      page,
      serverUrl: base,
      login,
      adminLogin,
      search,
      fixtures,
      state,
      sleep,
    });

    await sleep(50);
    if (pageErrors.length) {
      console.log(`page-errors: ${pageErrors.length}`);
      for (const message of pageErrors) console.log(`  ${message.split("\n")[0]}`);
    }

    const passed = results.filter((item) => item.pass).length;
    const outputRoot = path.resolve(options.output || process.env.WEB_PUBLISH_OUTPUT || path.join(appRoot, ".web-publish"));
    await fs.mkdir(outputRoot, { recursive: true });
    const resultsPath = path.join(outputRoot, "results.json");
    await fs.writeFile(resultsPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      vault: fixtures.vault,
      state: { activeId: state.activeId, orphanId: state.orphanId, invalidId: fixtures.invalidId },
      orphanReindexed,
      lifecycles: lifecycle,
      results,
      passed,
      failed: results.length - passed,
      pageErrors,
      serverErrors,
    }, null, 2)}\n`, "utf8");
    console.log(`results: ${resultsPath}`);
    console.log(`summary: ${passed}/${results.length} passed`);
    for (const note of notes) console.log(`note: ${note}`);
    if (options.json) console.log(JSON.stringify({ passed, failed: results.length - passed, results }, null, 2));
    return results.some((item) => !item.pass) ? 1 : 0;
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const exitCode = await main();
process.exitCode = exitCode;
