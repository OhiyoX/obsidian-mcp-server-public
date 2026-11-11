// The compose file is the runtime contract of the NAS deployment. Three properties are load
// bearing and invisible from the app code:
//   * the image is authoritative — a source mount over /app makes the checkout the runtime and
//     hides a stale image;
//   * logs are bounded — an unbounded json-file log fills the NAS disk;
//   * the monitor's own check must be possible — a read-only sink reports a fault every run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_PATH = path.join(APP_ROOT, "..", "docker-compose.yaml");
const compose = yaml.load(readFileSync(COMPOSE_PATH, "utf8"));

test("no source mount shadows the built image", () => {
  const volumes = compose.services["obsidian-server"].volumes;
  for (const volume of volumes) {
    assert.doesNotMatch(volume, /(^|:)\/app(\/|:|$)/, `compose must not mount ${volume} over the image`);
  }
});

test("the container log is bounded", () => {
  const logging = compose.services["obsidian-server"].logging;
  assert.equal(logging?.driver, "json-file", "the default driver must be named");
  assert.equal(logging.options["max-size"], "10m");
  assert.equal(logging.options["max-file"], "5");
});

test("the monitor image is pinned and its ops-log check can succeed", () => {
  const monitor = compose.services["deprecation-monitor"];
  assert.doesNotMatch(monitor.image, /:latest$|:latest"/, "a floating tag makes the monitor unpinnable");
  assert.match(monitor.image, /alpine:3\.\d+/);
  const writable = monitor.volumes.some((volume) => volume === "./data/ops-log:/data/ops-log");
  assert.ok(writable, "the ops-log mount must be writable, or [ -w /data/ops-log ] always fails");
});

test("no ssh key directory outside the data tree", () => {
  const volumes = compose.services["obsidian-server"].volumes;
  assert.equal(
    volumes.some((volume) => volume.includes("/root/.ssh")),
    false,
    "HOME is /data, so git reads /data/.ssh and the data mount already carries it",
  );
});
