// Focused tests for the Phase 2C Scope-negative runtime matrix.
//
// These tests drive the real MCP Streamable HTTP transport with sentinel-wrapped
// handlers. They assert that visibility equals the scope/profile truth computed
// independently of the runtime policy function, that no denied call reaches a tool
// handler, and that fail-closed negatives hold.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-runtime-matrix-test-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";

const {
  ALL_SCOPES,
  DEFAULT_OUT_DIR,
  RUNTIME_MATRIX_JSON,
  RUNTIME_MATRIX_MD,
  SCOPE_SETS,
  buildRuntimeMatrixReport,
  evaluateRuntimeGate,
  expectedVisibleNames,
  formatRuntimeMatrixMarkdown,
  profileDefinitions,
  verifyRuntimeMatrixArtifacts,
} = await import("../scripts/tool-discovery-runtime-matrix.mjs");
const { MCP_SCOPES } = await import("../src/scopes.js");

test("the matrix Scope axis matches the Scope truth in src/scopes.js", () => {
  // Guards against the hardcoded matrix axis drifting from the canonical scope list.
  assert.deepEqual(ALL_SCOPES, MCP_SCOPES);
});

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

let cached;
async function report() {
  if (!cached) cached = await buildRuntimeMatrixReport();
  return cached;
}

test("runtime matrix covers full/core/modules x scope sets and passes its gate", async () => {
  const current = await report();
  assert.equal(current.profiles.length, profileDefinitions().length);
  assert.ok(current.profiles.some((profile) => profile.id === "full"));
  assert.ok(current.profiles.some((profile) => profile.id === "core"));
  assert.ok(current.profiles.some((profile) => profile.id.startsWith("module:")));
  assert.equal(current.profiles.reduce((sum, profile) => sum + profile.rows.length, 0), current.profiles.length * SCOPE_SETS.length);
  assert.equal(current.gate.decision, "pass");
  for (const check of current.gate.checks) assert.equal(check.pass, true, `${check.id}: ${check.detail}`);
});

test("every row matches the independently computed scope/profile wire order", async () => {
  const current = await report();
  for (const profile of current.profiles) {
    for (const row of profile.rows) {
      const expected = expectedVisibleNames(profile.policy, row.scopes, current.nativeRegistrationOrder);
      assert.equal(row.expectedCount, expected.length, `${profile.id}/${row.scopeSet} expected count`);
      assert.equal(row.visibleCount, expected.length, `${profile.id}/${row.scopeSet} visible count`);
      assert.equal(row.matchesExpectedWireOrder, true, `${profile.id}/${row.scopeSet} wire order`);
      assert.equal(row.structuralLeaks, 0, `${profile.id}/${row.scopeSet} structural leaks`);
      assert.equal(row.hiddenNameInPayload, 0, `${profile.id}/${row.scopeSet} hidden name leak`);
    }
  }
});

test("no denied call ever reaches a registered handler", async () => {
  const current = await report();
  for (const profile of current.profiles) {
    assert.deepEqual(profile.handlerInvocations, [], `${profile.id} invoked a handler`);
    for (const row of profile.rows) {
      if (row.hiddenCount > 0) assert.ok(row.deniedCalls > 0, `${profile.id}/${row.scopeSet} made no denied probe`);
      assert.equal(row.deniedHandlerExecutions, 0, `${profile.id}/${row.scopeSet} denied handler`);
      assert.equal(row.deniedMetadataLeaks, 0, `${profile.id}/${row.scopeSet} denied metadata`);
      assert.ok(row.deniedSamples.every((sample) => sample.isError === true));
    }
  }
});

test("missing auth and empty scopes fail closed and scope changes recompute per request", async () => {
  const current = await report();
  for (const profile of current.profiles) {
    assert.equal(profile.negatives.missingAuth.visibleCount, 0, `${profile.id} missing auth`);
    assert.equal(profile.negatives.missingAuth.deniedCallIsError, true, `${profile.id} missing auth denied call`);
    assert.equal(profile.negatives.noScope.visibleCount, 0, `${profile.id} no scope`);
    assert.equal(profile.negatives.noScope.deniedCallIsError, true, `${profile.id} no scope denied call`);
    assert.equal(profile.negatives.scopeChange.matchesExpected, true, `${profile.id} scope change`);
  }
});

test("full-profile wired descriptors deep-equal the raw native HTTP descriptors", async () => {
  const current = await report();
  const full = current.profiles.find((profile) => profile.id === "full");
  assert.equal(full.fullDescriptorsDeepEqualNativeRaw, true);
});

test("runtime gate fails when a denied handler execution or a leak is injected", async () => {
  const current = await report();
  const injectedHandler = structuredClone(current);
  injectedHandler.profiles[0].rows[0].deniedHandlerExecutions = 1;
  assert.equal(evaluateRuntimeGate(injectedHandler).checks.find((check) => check.id === "zero-denied-handler-executions").pass, false);

  const injectedLeak = structuredClone(current);
  injectedLeak.profiles[0].rows[0].structuralLeaks = 1;
  assert.equal(evaluateRuntimeGate(injectedLeak).checks.find((check) => check.id === "zero-metadata-leaks").pass, false);

  const injectedScope = structuredClone(current);
  injectedScope.profiles[0].negatives.missingAuth.visibleCount = 1;
  assert.equal(evaluateRuntimeGate(injectedScope).checks.find((check) => check.id === "missing-auth-fail-closed").pass, false);
});

test("checked-in runtime matrix artifacts recompute", async () => {
  const verification = await verifyRuntimeMatrixArtifacts();
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.ok, true);
  assert.equal(verification.gateDecision, "pass");
  const current = await report();
  assert.equal(typeof formatRuntimeMatrixMarkdown(current), "string");
  assert.ok(ALL_SCOPES.length === 3);
});

test("runtime matrix Markdown verifies under a CRLF checkout and still fails on a content edit", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "runtime-matrix-eol-"));
  try {
    await writeFile(path.join(outDir, RUNTIME_MATRIX_JSON), await readFile(path.join(DEFAULT_OUT_DIR, RUNTIME_MATRIX_JSON), "utf8"), "utf8");
    // The committed artifact is LF; a Windows checkout with core.autocrlf=true materializes CRLF.
    const lf = (await readFile(path.join(DEFAULT_OUT_DIR, RUNTIME_MATRIX_MD), "utf8")).replace(/\r\n/g, "\n");
    await writeFile(path.join(outDir, RUNTIME_MATRIX_MD), lf.replace(/\n/g, "\r\n"), "utf8");
    const crlf = await verifyRuntimeMatrixArtifacts({ outDir });
    assert.equal(crlf.ok, true, crlf.errors.join("; "));

    // Any non-EOL edit must still fail the same gate.
    await writeFile(path.join(outDir, RUNTIME_MATRIX_MD), `${lf.replace(/\n/g, "\r\n")}tampered\r\n`, "utf8");
    const tampered = await verifyRuntimeMatrixArtifacts({ outDir });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => error.includes(RUNTIME_MATRIX_MD)));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
