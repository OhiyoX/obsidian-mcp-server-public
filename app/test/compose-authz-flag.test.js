// Focused plumbing test for the time-window authorization operator switch.
//
// `AUTHZ_ENABLED` reaches the process only if `docker-compose.yaml` forwards it:
// the compose file interpolates `${VAR}` from `.env`, but a variable that is not
// declared under `environment:` never enters the container. Stage 1 of the
// rollout (see `docs/AUTHZ_TIME_WINDOWS.md` §4) is therefore a pure `.env`
// change only while this forwarding line exists — and rollback (§5) is the same
// `.env` flip. This test pins that wiring and its default, and couples it to
// `.env.example` so the two files cannot drift apart silently.

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
const VAR = "AUTHZ_ENABLED";

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

test("docker-compose forwards AUTHZ_ENABLED with the .env.example default", () => {
  const compose = yaml.load(readFileSync(COMPOSE_PATH, "utf8"));
  const environment = compose.services["obsidian-server"].environment;
  const example = parseDotEnvExample();

  assert.ok(
    Object.prototype.hasOwnProperty.call(environment, VAR),
    `docker-compose.yaml must forward ${VAR} into the container environment`,
  );
  assert.ok(example.has(VAR), `.env.example must document ${VAR}`);
  assert.equal(
    environment[VAR],
    `\${${VAR}:-${example.get(VAR)}}`,
    `${VAR} compose fallback must match the .env.example default`,
  );
  assert.equal(example.get(VAR), "false", `${VAR} must stay off by default`);
});
