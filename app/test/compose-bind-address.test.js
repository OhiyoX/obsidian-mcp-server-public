// The published port is a security boundary: the NAS deployment binds it to its
// LAN address, while the repository default must stay usable on any machine.
// Pin both the compose interpolation and the .env.example default so a compose
// rewrite cannot silently publish the MCP/Web port on every interface.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.yaml");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");
const TLS_PORT_RULE = "${MCP_BIND_ADDR:-0.0.0.0}:${MCP_TLS_PORT:-18924}:18924";
// The plaintext port serves the container health check, in-container probes and rollback, so it
// stays on the host loopback and never reaches the LAN.
const PLAINTEXT_PORT_RULE = "127.0.0.1:${MCP_PORT:-18923}:18923";

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

test("docker-compose binds the published port through MCP_BIND_ADDR", () => {
  const compose = yaml.load(readFileSync(COMPOSE_PATH, "utf8"));
  const ports = compose.services["obsidian-server"].ports;
  const example = parseDotEnvExample();

  assert.ok(
    Array.isArray(ports) && ports.includes(TLS_PORT_RULE),
    `docker-compose.yaml must publish the TLS port as ${TLS_PORT_RULE}`,
  );
  assert.ok(
    Array.isArray(ports) && ports.includes(PLAINTEXT_PORT_RULE),
    "the plaintext port must stay on loopback only",
  );
  assert.equal(example.get("MCP_BIND_ADDR"), "0.0.0.0", ".env.example must document the default bind address");
});
