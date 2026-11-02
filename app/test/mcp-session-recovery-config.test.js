// Plumbing contract for stale-session recovery configuration.
//
// The runtime tests cannot prove the deployment route: a value set in production
// `.env` only reaches the process if `docker-compose.yaml` forwards it. These tests
// pin compose forwarding, the `.env.example` defaults, and the runtime defaults read
// by `app/server.js` (the same import path the server uses at startup).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.yaml");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");

const RECOVERY_VARS = ["MCP_SESSION_RECOVERY", "MCP_SESSION_RECOVERY_MAX_INFLIGHT"];

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
  return yaml.load(readFileSync(COMPOSE_PATH, "utf8")).services["obsidian-server"].environment;
}

test("docker-compose forwards the session recovery vars with .env.example defaults", () => {
  const environment = composeEnvironment();
  const example = parseDotEnvExample();
  for (const name of RECOVERY_VARS) {
    assert.ok(Object.prototype.hasOwnProperty.call(environment, name), `docker-compose.yaml must forward ${name}`);
    assert.ok(example.has(name), `.env.example must document ${name}`);
    assert.equal(environment[name], `\${${name}:-${example.get(name)}}`, `${name} compose fallback must match .env.example`);
  }
});

test("startup defaults match .env.example for the recovery mode", () => {
  const example = parseDotEnvExample();
  const script = [
    'import { MCP_SESSION_RECOVERY, MCP_SESSION_RECOVERY_MAX_INFLIGHT } from "./src/server-config.js";',
    "process.stdout.write(JSON.stringify({ MCP_SESSION_RECOVERY, MCP_SESSION_RECOVERY_MAX_INFLIGHT }));",
  ].join("\n");
  const env = { ...process.env };
  for (const name of RECOVERY_VARS) delete env[name];
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: APP_ROOT, env, encoding: "utf8" });
  assert.equal(result.status, 0, `config subprocess failed: ${result.stderr}`);
  const defaults = JSON.parse(result.stdout);
  assert.equal(defaults.MCP_SESSION_RECOVERY, example.get("MCP_SESSION_RECOVERY"));
  assert.equal(String(defaults.MCP_SESSION_RECOVERY_MAX_INFLIGHT), example.get("MCP_SESSION_RECOVERY_MAX_INFLIGHT"));
});

test("the idle session TTL stays short until a session cap exists", () => {
  // A live session costs ~3.7 MB RSS (50-session probe on the 86-tool catalog), so
  // raising the default TTL without an LRU cap is a capacity regression. Recovery,
  // not a longer TTL, is what keeps stale hosts working.
  const source = readFileSync(path.join(APP_ROOT, "src", "server-config.js"), "utf8");
  assert.match(source, /SESSION_TTL_MS = parseInteger\(process\.env\.SESSION_TTL_MS, 30 \* 60 \* 1000\)/);
  assert.equal(parseDotEnvExample().get("SESSION_TTL_MS"), "1800000");
});
