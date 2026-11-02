// Focused plumbing tests for Progressive Tool Discovery operator configuration.
//
// These tests do not re-test the resolver. They prove the deployment route that
// the runtime tests cannot cover:
//
// 1. `docker-compose.yaml` actually forwards the four `MCP_DISCOVERY_*` vars
//    into the container environment, with fallback defaults that match
//    `.env.example`. Without this wiring, values set in a production `.env`
//    never reach the process.
// 1b. The same route for the five `VAULT_DISCOVERY_*` vars (W4 #437 / review N1):
//    the operator documentation lists them as tunable, so compose must forward
//    them instead of leaving them as comments — otherwise an operator edits
//    `.env`, sees no error, and silently keeps running the defaults.
// 2. The real startup read path (`loadDiscoveryOperatorConfig()` with no
//    argument, exactly as `app/server.js` calls it) observes the process
//    environment and falls back to `full` when the vars are absent.
// 3. When a Docker CLI is available, `docker compose config` renders the vars
//    from a secret-free environment fixture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.yaml");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");

const DISCOVERY_VARS = [
  "MCP_DISCOVERY_PROFILE",
  "MCP_DISCOVERY_TOOLSETS",
  "MCP_DISCOVERY_TOOLS",
  "MCP_DISCOVERY_DENY_TOOLS",
];

/** W4 (#437) Vault hot-discovery operator variables — forwarded, never comments. */
const VAULT_DISCOVERY_VARS = [
  "VAULT_DISCOVERY_ENABLED",
  "VAULT_DISCOVERY_DEBOUNCE_MS",
  "VAULT_DISCOVERY_MAX_COALESCE_MS",
  "VAULT_DISCOVERY_PERIODIC_SECONDS",
  "VAULT_DISCOVERY_PERIODIC_MAX_SECONDS",
];

function parseDotEnvExample() {
  const values = new Map();
  for (const raw of readFileSync(ENV_EXAMPLE_PATH, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function composeEnvironment() {
  const compose = yaml.load(readFileSync(COMPOSE_PATH, "utf8"));
  return compose.services["obsidian-server"].environment;
}

test("docker-compose forwards every MCP_DISCOVERY_* var with .env.example defaults", () => {
  const environment = composeEnvironment();
  const example = parseDotEnvExample();

  for (const name of DISCOVERY_VARS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(environment, name),
      `docker-compose.yaml must forward ${name} into the container environment`,
    );
    assert.ok(example.has(name), `.env.example must document ${name}`);
    assert.equal(
      environment[name],
      `\${${name}:-${example.get(name)}}`,
      `${name} compose fallback must match the .env.example default`,
    );
  }
});

test("docker-compose forwards every VAULT_DISCOVERY_* var with .env.example defaults", () => {
  // Review N1: these five were documented as operator-tunable while compose kept four of them as
  // comment lines, so `docker compose config` rendered none of them and a value set in `.env` never
  // reached the process. Re-commenting any single compose line below makes this test fail.
  const environment = composeEnvironment();
  const example = parseDotEnvExample();

  for (const name of VAULT_DISCOVERY_VARS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(environment, name),
      `docker-compose.yaml must forward ${name} into the container environment (a comment line forwards nothing)`,
    );
    assert.ok(example.has(name), `.env.example must document ${name} with a value (not only in a comment)`);
    assert.equal(
      environment[name],
      `\${${name}:-${example.get(name)}}`,
      `${name} compose fallback must match the .env.example default`,
    );
  }
  // The switch stays off unless the operator opts in; the tuning defaults are the frozen parameters the
  // watcher module documents (500ms / 5s / 60s / 900s).
  assert.equal(example.get("VAULT_DISCOVERY_ENABLED"), "false");
  assert.equal(example.get("VAULT_DISCOVERY_DEBOUNCE_MS"), "500");
  assert.equal(example.get("VAULT_DISCOVERY_MAX_COALESCE_MS"), "5000");
  assert.equal(example.get("VAULT_DISCOVERY_PERIODIC_SECONDS"), "60");
  assert.equal(example.get("VAULT_DISCOVERY_PERIODIC_MAX_SECONDS"), "900");
});

function runConfigProcess(extraEnv) {
  const script = [
    'import { loadDiscoveryOperatorConfig } from "./src/discovery-config.js";',
    "process.stdout.write(JSON.stringify(loadDiscoveryOperatorConfig()));",
  ].join("\n");
  const env = { ...process.env, ...extraEnv };
  for (const name of DISCOVERY_VARS) {
    if (!(name in extraEnv)) delete env[name];
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: APP_ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `config subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("startup config read observes the process environment", () => {
  const config = runConfigProcess({
    MCP_DISCOVERY_PROFILE: "custom",
    MCP_DISCOVERY_TOOLS: "get_note,server_info",
  });
  assert.equal(config.profile, "custom");
  assert.deepEqual(config.tools, ["get_note", "server_info"]);
  assert.deepEqual(config.toolsets, []);
  assert.deepEqual(config.denyTools, []);
  assert.equal(config.warning, null);
});

test("startup config read defaults to full when discovery vars are absent", () => {
  const config = runConfigProcess({});
  assert.equal(config.profile, "full");
  assert.deepEqual(config.tools, []);
  assert.deepEqual(config.toolsets, []);
  assert.deepEqual(config.denyTools, []);
  assert.equal(config.warning, null);
});

const dockerComposeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

test(
  "docker compose config renders discovery vars from a secret-free environment fixture",
  { skip: dockerComposeAvailable ? false : "docker compose CLI is unavailable" },
  () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "obsidian-discovery-compose-"));
    try {
      // Minimal secret-free fixture: only the discovery profile is set. Passing
      // --env-file replaces the implicit project .env, so no production secret
      // is read or rendered. Run from the repo root so relative build/volume
      // paths resolve.
      const envFixture = path.join(fixtureDir, "fixture.env");
      writeFileSync(envFixture, "MCP_DISCOVERY_PROFILE=core\n");

      const result = spawnSync("docker", ["compose", "--env-file", envFixture, "-f", COMPOSE_PATH, "config"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `docker compose config failed: ${result.stderr}`);
      assert.match(result.stdout, /MCP_DISCOVERY_PROFILE:\s*core/);
      assert.match(result.stdout, /MCP_DISCOVERY_TOOLSETS:\s*""/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);
