// CI wiring ratchet for the Web Publish browser checks (Wave D, issues #277/#278).
//
// The C3 runner (`scripts/run-web-publish-checks.mjs`) was delivered without a CI job;
// this test pins the wiring that makes it a gate: the `browser` job in
// `.github/workflows/ci.yml` must actually run it, with the Playwright runtime already
// installed, and must upload its artifacts with `if: always()` like every other browser
// gate in that job. It parses the real YAML (js-yaml is a runtime dependency), so a
// dropped step, a renamed artifact or a moved env var fails here instead of silently
// shrinking the browser gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.dirname(appRoot);
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
const runnerPath = path.join(appRoot, "scripts", "run-web-publish-checks.mjs");
const ARTIFACT_NAME = "web-publish-checks";
const ARTIFACT_PATH = "${{ runner.temp }}/web-publish";

const workflow = yaml.load(fs.readFileSync(workflowPath, "utf8"));
const browserJob = workflow?.jobs?.browser;
const steps = browserJob?.steps ?? [];
const indexOfStep = (predicate) => steps.findIndex(predicate);
const publishStepIndex = indexOfStep((step) => typeof step.run === "string" && step.run.includes("run-web-publish-checks.mjs"));

test("the browser job runs the Web Publish checks through the standalone runner", () => {
  assert.ok(browserJob, "the browser job must exist");
  assert.ok(publishStepIndex >= 0, "the browser job must run scripts/run-web-publish-checks.mjs");
  const step = steps[publishStepIndex];
  assert.match(step.name || "", /Publish/, "the step must be named after the Publish surface");
  assert.equal(step["working-directory"], "app");
  assert.equal(step.env?.WEB_PUBLISH_OUTPUT, ARTIFACT_PATH, "the runner writes its results into the job artifact directory");
  assert.equal(step["continue-on-error"], undefined, "the Publish gate must be blocking");
  assert.match(step.run, /timeout --signal=TERM --kill-after=15s 180s/, "the step needs its own hang detector, like the render-parity steps");
  assert.match(step.run, /set -euo pipefail/, "a failure inside the pipeline (runner or tee) must fail the step");
  assert.match(step.run, /tee "\$WEB_PUBLISH_OUTPUT\/run\.log"/, "the console log must land in the artifact for a red run");
});

test("the publish step runs with the installed runtime, after the Web assets are built", () => {
  const installIndex = indexOfStep((step) => typeof step.run === "string" && step.run.includes("playwright@"));
  const buildIndex = indexOfStep((step) => typeof step.run === "string" && step.run.includes("build:web"));
  assert.ok(installIndex >= 0, "the job must install the pinned Playwright runtime");
  assert.ok(buildIndex >= 0, "the job must build the Web assets");
  assert.ok(installIndex < publishStepIndex, "Playwright must be installed before the Publish checks run");
  assert.ok(buildIndex < publishStepIndex, "the served bundles must be built before the Publish checks run");
});

test("the Publish artifacts are uploaded with if: always()", () => {
  const uploadIndex = indexOfStep((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === ARTIFACT_NAME);
  assert.ok(uploadIndex >= 0, `the job must upload the ${ARTIFACT_NAME} artifact`);
  assert.ok(uploadIndex > publishStepIndex, "the upload must follow the run step");
  const step = steps[uploadIndex];
  assert.equal(step.if, "always()", "a red Publish run must still upload its artifacts");
  assert.equal(step.with.path, ARTIFACT_PATH);
  assert.equal(step.with["if-no-files-found"], "warn");
  assert.equal(step.with["retention-days"], 14);
});

test("the browser job's steps stay well formed and the runner it points at exists", () => {
  assert.ok(steps.length > 5);
  for (const step of steps) {
    const hasRun = typeof step.run === "string";
    const hasUses = typeof step.uses === "string";
    assert.ok(hasRun !== hasUses, `step "${step.name ?? "(unnamed)"}" must run or use, not both/neither`);
  }
  assert.ok(fs.existsSync(runnerPath), "the CI step must point at a file that exists");
  const listing = fs.readFileSync(runnerPath, "utf8");
  assert.match(listing, /It never installs packages and never runs `npm ci`/, "the runner resolves Playwright, it does not install it");
});

test("the workflow keeps the release gate behind the browser job", () => {
  assert.deepEqual(workflow.jobs["release-gate"].needs, ["app", "browser", "dependency-audit"]);
  assert.equal(browserJob["timeout-minutes"], 25);
});
