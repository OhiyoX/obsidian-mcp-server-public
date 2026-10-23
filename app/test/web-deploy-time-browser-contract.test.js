// Issue #515 — the browser scene's own contract, checked without Chromium.
//
// `scripts/web-regression/deploy-time.mjs` is the gate that proves the two human-facing
// deploy-time surfaces show Beijing time, but it only runs inside the Chromium suite (locally
// behind `WEB_TEST_ONLY`). These assertions catch the cheap ways that gate can rot before
// anyone pays for a browser run:
//
//   1. the suite entry point still registers the scene, so it cannot be dropped silently;
//   2. the fixture pair the scene asserts (raw UTC ISO -> visible label) is exactly what the ONE
//      shared implementation renders, so a formatter change cannot leave a stale expectation;
//   3. the file the scene writes is the manifest `src/release-version.js` actually reads, so the
//      scene cannot pass while writing something the server ignores;
//   4. the scene registers its three named checks, sees the manifest present while they run and
//      removes it afterwards — driven with a stub recorder and a stub browser context.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BEIJING_LABEL, DEPLOYED_AT, DEPLOY_COMMIT, DEPLOY_VERSION, SERVER_FACE_PREFIX,
  deployTimeManifestPath, processOffsetSuffix, registerDeployTimeChecks,
} from "../scripts/web-regression/deploy-time.mjs";
import { formatBeijingDeployLabel } from "../src/beijing-deploy-time.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three check names the Chromium suite reports; #515's evidence is read by these names. */
const CHECK_NAMES = [
  "DT-1 settings footer line 2 shows Beijing time (+08:00) and keeps the raw UTC ISO",
  "DT-2 the Admin badge shows the same Beijing label and keeps the raw UTC ISO",
  "DT-3 /healthz stays on the raw UTC ISO and the process clock, not Asia/Shanghai",
];

test("#515 deploy time: the suite entry point registers the deploy-time scene", async () => {
  const entry = await fs.readFile(path.join(appRoot, "scripts", "web-regression.mjs"), "utf8");
  assert.match(entry, /import \{ registerDeployTimeChecks \} from '\.\/web-regression\/deploy-time\.mjs';/);
  assert.match(entry, /await registerDeployTimeChecks\(context\);/);
  // The scene logs in through the shared fixture, so the entry point has to hand it the password.
  assert.match(entry, /\bpassword: environment\.password\b/);
});

test("#515 deploy time: the scene's expectation is what the one shared formatter renders", () => {
  assert.equal(formatBeijingDeployLabel(DEPLOYED_AT), BEIJING_LABEL, "the expected visible label must be the shared formatter's output");
  // The fixture instant has to be the raw `Z`-suffixed UTC form a deploy manifest carries: the
  // scene asserts that this exact string survives on the elements afterwards.
  assert.equal(DEPLOYED_AT, "2026-09-25T04:40:00Z");
  assert.match(BEIJING_LABEL, / \+08:00$/, "the label must name the offset explicitly");
  assert.notEqual(formatBeijingDeployLabel(DEPLOYED_AT), `${SERVER_FACE_PREFIX}2026-09-25 04:40:00 +00:00`);
  assert.match(processOffsetSuffix(DEPLOYED_AT), /^[+-]\d{2}:\d{2}$/);
});

test("#515 deploy time: the scene writes the manifest release-version.js reads", async () => {
  const releaseVersion = await fs.readFile(path.join(appRoot, "src", "release-version.js"), "utf8");
  assert.match(releaseVersion, /const MANIFEST_FILE = "deployed-version\.json";/);
  assert.match(releaseVersion, /path\.join\(DATA_PATH, MANIFEST_FILE\)/);
  assert.equal(deployTimeManifestPath(path.join("C:", "scratch")), path.join("C:", "scratch", "data", "deployed-version.json"));
});

test("#515 deploy time: the scene registers three checks, keeps the manifest for them and cleans up", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-time-contract-"));
  const manifest = deployTimeManifestPath(root);
  const names = [];
  const manifestSeen = [];
  let closed = 0;
  const page = { setDefaultTimeout: () => {} };
  const context = {
    check: async (name) => { names.push(name); manifestSeen.push(existsSync(manifest)); },
    browser: { newContext: async () => ({ newPage: async () => page, close: async () => { closed += 1; } }) },
    base: "http://127.0.0.1:1", root, password: "fixture-password",
  };
  try {
    await registerDeployTimeChecks(context);
    assert.deepEqual(names, CHECK_NAMES, "the scene must register its three documented checks, in order");
    assert.deepEqual(manifestSeen, [true, true, true], "the deploy manifest must exist while the checks run");
    assert.equal(closed, 1, "the scene must close its own browser context");
    assert.equal(existsSync(manifest), false, "the scene must remove the manifest it wrote");
    assert.equal(existsSync(path.join(root, "data")), true, "the shared DATA_PATH directory stays");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("#515 deploy time: the scene keeps its own identity strings", () => {
  // The Admin badge assertion also reads the release identity off the fixture manifest; keep the
  // three values consistent with the shape `releaseBadgeHtml` renders (`commit <sha>`).
  assert.equal(DEPLOY_VERSION, "v2026.09.25.7");
  assert.match(DEPLOY_COMMIT, /^[0-9a-f]{40}$/);
});
