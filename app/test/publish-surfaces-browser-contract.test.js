// Node-only contract test for the Web Publish surface browser runner (Wave C / C3).
//
// No browser and no server: it pins the fixture file set, the checks module's exports,
// the check naming, the `--list` output, the "runtime unavailable" exit path, and the
// absence of any dependency installation. The real checks run through
// `node scripts/run-web-publish-checks.mjs` (see the lane HANDOFF for the run log).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWebPublishFixtureVault,
  fixtureNotePath,
  WEB_PUBLISH_BLOCK_SAMPLES,
  WEB_PUBLISH_FILES,
  WEB_PUBLISH_INLINE_SAMPLES,
  WEB_PUBLISH_INVALID_ID,
  WEB_PUBLISH_VAULT_ID,
} from "../scripts/web-publish-fixtures.mjs";
import { blockScrollProblems, inlineCodeBoxProblems, registerWebPublishChecks, WEB_PUBLISH_SCENARIOS, WEB_PUBLISH_SCROLL_OVERFLOW_X } from "../scripts/web-publish-checks.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(appRoot, "scripts", "run-web-publish-checks.mjs");

function withFixture(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-publish-fixture-test-"));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("fixture builder creates the Vault, the registry seed and no real data", async () => {
  await withFixture(async (root) => {
    const fixtures = await createWebPublishFixtureVault(root);
    assert.equal(fixtures.vault, path.join(root, "vault"));
    assert.equal(fixtures.data, path.join(root, "data"));

    const exists = (relative) => fs.existsSync(fixtureNotePath(fixtures, relative));
    for (const relative of Object.values(WEB_PUBLISH_FILES)) {
      assert.ok(exists(relative), `missing fixture file: ${relative}`);
    }
    // The decoy is the #270 case: a frontmatter field that must never satisfy `published:`.
    assert.match(fs.readFileSync(fixtureNotePath(fixtures, WEB_PUBLISH_FILES.decoy), "utf8"), /^---\npublished: true\n---/);

    // #447: the active note body is the measuring sample of the mobile-overflow check, so
    // dropping the long tokens must fail here rather than silently weaken that check.
    const activeBody = fs.readFileSync(fixtureNotePath(fixtures, WEB_PUBLISH_FILES.active), "utf8");
    for (const sample of WEB_PUBLISH_INLINE_SAMPLES) {
      assert.ok(activeBody.includes(`\`${sample.text}\``), `the active fixture must keep the #447 inline sample ${sample.id}: ${sample.text}`);
    }
    for (const sample of WEB_PUBLISH_BLOCK_SAMPLES) {
      assert.ok(activeBody.includes(sample.text), `the active fixture must keep the #447 block sample ${sample.id}: ${sample.text}`);
    }

    // The invalid record is a state-file fixture because `publish` is Markdown-only.
    const state = JSON.parse(fs.readFileSync(fixtures.stateFile, "utf8"));
    assert.equal(state.version, 2);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].id, WEB_PUBLISH_INVALID_ID);
    assert.equal(state.records[0].vaultId, WEB_PUBLISH_VAULT_ID);
    assert.equal(state.records[0].path, WEB_PUBLISH_FILES.invalid);
    assert.equal(state.records[0].lifecycle, "active");

    // The runner must not inherit a multi-Vault layout: the fixture assumes one Vault.
    assert.equal(fixtures.serverEnv.VAULT_PATH, fixtures.vault);
    assert.equal(fixtures.serverEnv.DATA_PATH, fixtures.data);
    assert.equal(fixtures.serverEnv.WEB_CATALOG_ENABLED, "true");
    assert.equal("WEB_VAULTS_ROOT" in fixtures.serverEnv, false);
  });
});

test("the checks module registers the required surfaces", async () => {
  assert.equal(typeof registerWebPublishChecks, "function");
  assert.deepEqual(WEB_PUBLISH_SCENARIOS.map((scenario) => scenario.id), [
    "admin-publish-panel-lifecycle",
    "web-publishes-filter",
    "public-surface-orphan",
    "public-page-mobile-overflow",
  ]);
  assert.deepEqual(WEB_PUBLISH_SCENARIOS.map((scenario) => scenario.name), [
    "Admin Publish tab renders every lifecycle without a dead public link",
    "the Web Publishes filter matches the active Publish registry",
    "a retired Publish record is never a public candidate",
    "the public page never scrolls sideways on a phone viewport (#447)",
  ]);

  // A rename of any wired surface must break this contract, not silently drop coverage.
  const source = await import("node:fs/promises").then((module) => module.readFile(path.join(appRoot, "scripts", "web-publish-checks.mjs"), "utf8"));
  for (const needle of ["/admin/auth?tab=publishes", "#publishes-open", "#search-list", "/api/web/v2/search?", "/api/web/v1/notes", "/publish/", "已公开", "目标缺失", "不符合公开契约"]) {
    assert.ok(source.includes(needle), `the checks must pin ${needle}`);
  }

  // `registerWebPublishChecks` is driven by the ctx contract: call it with a stub ctx
  // and a failing browser-free page to prove the three checks are actually registered.
  const registered = [];
  await registerWebPublishChecks({
    check: async (name) => { registered.push(name); },
    page: null,
    serverUrl: "http://127.0.0.1:0",
    login: async () => {},
    adminLogin: async () => {},
    search: async () => ({ notes: [] }),
    fixtures: { invalidId: WEB_PUBLISH_INVALID_ID },
    state: { activePath: "a.md", orphanPath: "b.md", orphanId: "x", activeId: "y", decoyPath: "c.md", plainPath: "d.md", invalidPath: "e.canvas", activePublicPath: "/publish/y" },
    sleep: async () => {},
  });
  assert.deepEqual(registered, WEB_PUBLISH_SCENARIOS.map((scenario) => scenario.name));
});

test("the runner lists its checks and fails closed without a Playwright runtime", () => {
  const listed = spawnSync(process.execPath, [runner, "--list"], { cwd: appRoot, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  for (const scenario of WEB_PUBLISH_SCENARIOS) {
    assert.ok(listed.stdout.includes(scenario.id), `${scenario.id} missing from --list`);
    assert.ok(listed.stdout.includes(scenario.name), `${scenario.name} missing from --list`);
  }
  assert.match(listed.stdout, /check-count: 4/);

  const missing = spawnSync(process.execPath, [runner], {
    cwd: appRoot,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_MODULE: path.join(os.tmpdir(), "definitely-not-a-playwright-module.mjs") },
  });
  assert.equal(missing.status, 2, `expected the documented runtime-unavailable exit, got ${missing.status}: ${missing.stderr}`);
  assert.match(missing.stderr, /runtime unavailable/);
  assert.match(missing.stderr, /never installs dependencies/);
});

test("the runner never installs dependencies and stays inside the owner files", () => {
  const source = fs.readFileSync(runner, "utf8");
  // The comment may promise it, but the code must never spawn a package manager.
  for (const forbidden of [/spawn(?:Sync)?\(\s*["'`]npm/, /exec(?:Sync|File)?\(\s*["'`]npm/, /node_modules/]) {
    assert.equal(forbidden.test(source), false, `the runner must not reference ${forbidden}`);
  }
  // It is a standalone runner: it must not import the shared browser harness.
  assert.equal(/from\s+["'][^"']*web-regression[^"']*["']/.test(source), false, "the runner must not import the shared harness");
});

// #447 FIX3 — the behavioural gate's two criteria, pinned here as the fast half so a
// regression of the *criteria themselves* fails without a browser. The real proof stays the
// served-page measurement in `run-web-publish-checks.mjs`; this only makes the shapes it must
// reject explicit and cheap to re-check.
test("#447: a named inline sample must render a real box, not merely keep its text", () => {
  const rendered = { text: "sample", display: "inline", visibility: "visible", clientRects: 1, width: 120, height: 19, right: 300, parentRight: 340 };
  assert.deepEqual(inlineCodeBoxProblems(rendered), [], "a rendered, wrapping inline node must pass");
  for (const [label, patch] of [
    ["display:none (the FIX3 counterexample keeps the text)", { display: "none", clientRects: 0, width: 0, height: 0, right: 0 }],
    ["visibility:hidden", { visibility: "hidden" }],
    ["a zero layout box", { clientRects: 0, width: 0, height: 0 }],
    ["no client rects", { clientRects: 0 }],
    ["painting past its parent", { right: 400 }],
  ]) {
    assert.ok(inlineCodeBoxProblems({ ...rendered, ...patch }).length > 0, `the gate must reject ${label}`);
  }
  assert.ok(inlineCodeBoxProblems(undefined).length > 0, "a sample that was never captured is a problem, never a pass");
});

test("#447: the block-level <pre> must keep the user scroll mechanism, not just the overflow size", () => {
  const block = { display: "block", visibility: "visible", width: 356, height: 60, right: 374, overflowX: "auto", whiteSpace: "pre", codeWhiteSpace: "pre", scrollWidth: 1562, clientWidth: 356, scrollLeftAfterProgrammaticScroll: 24 };
  assert.deepEqual(blockScrollProblems(block, 390), [], "an `overflow: auto` block with a real scroll range must pass");
  assert.deepEqual([...WEB_PUBLISH_SCROLL_OVERFLOW_X].sort(), ["auto", "scroll"], "`overflow-x: auto` and `scroll` are the only accepted mechanisms");
  for (const [label, patch] of [
    ["overflow-x:hidden (the FIX3 counterexample keeps scrollWidth > clientWidth)", { overflowX: "hidden" }],
    ["overflow-x:clip", { overflowX: "clip" }],
    ["overflow-x:visible", { overflowX: "visible" }],
    ["a wrapped block", { codeWhiteSpace: "pre-wrap", scrollWidth: 356 }],
    ["no scroll range", { scrollWidth: 356, scrollLeftAfterProgrammaticScroll: 0 }],
    ["not a scroll container", { scrollLeftAfterProgrammaticScroll: 0 }],
    ["a zero layout box", { width: 0, height: 0 }],
    ["painting past the page edge", { right: 500 }],
  ]) {
    assert.ok(blockScrollProblems({ ...block, ...patch }, 390).length > 0, `the gate must reject ${label}`);
  }
  assert.ok(blockScrollProblems(undefined, 390).length > 0, "a block that was never captured is a problem, never a pass");
});
