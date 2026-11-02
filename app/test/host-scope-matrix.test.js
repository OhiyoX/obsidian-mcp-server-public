import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildScopeSchedule,
  buildScopeServerEnv,
  FILE_REQUIRED_TOOLS,
  generateScopeSentinel,
  isScopeSentinelLeak,
  SCOPE_AUTHOR,
  SCOPE_CELLS,
  SCOPE_JSON,
  SCOPE_MD,
  SCOPE_SENTINEL_PREFIX,
  SCOPE_TASK_ID,
  SCOPE_TRANSPORT_ONLY_LABEL,
  SCOPE_TRIALS_PER_CELL,
  summarizeScopeCell,
  verifyScopeMatrixArtifacts,
} from "../scripts/host-scope-matrix.mjs";
import { MCP_SCOPES, normalizeScopes } from "../src/scopes.js";
import { DEFAULT_OUT_DIR } from "../scripts/host-controlled-matrix.mjs";

test("scope sentinel is prefixed, high-entropy and non-repeating", () => {
  const first = generateScopeSentinel();
  assert.match(first, /^ORACLE-SCOPE-[0-9a-f]{12}$/);
  assert.equal(first.includes(SCOPE_SENTINEL_PREFIX), true);
  assert.notEqual(first, generateScopeSentinel());
});

test("buildScopeSchedule is deterministic, balanced and covers every cell", () => {
  const schedule = buildScopeSchedule(SCOPE_CELLS, SCOPE_TRIALS_PER_CELL);
  assert.equal(schedule.length, SCOPE_CELLS.length * SCOPE_TRIALS_PER_CELL);
  for (const cell of SCOPE_CELLS) {
    assert.equal(schedule.filter((entry) => entry.cell === cell.id).length, SCOPE_TRIALS_PER_CELL);
  }
  assert.deepEqual(schedule.slice(0, SCOPE_CELLS.length).map((entry) => entry.cell), SCOPE_CELLS.map((cell) => cell.id));
});

test("FILE_REQUIRED_TOOLS is derived from the real scope registry and includes get_file", () => {
  assert.ok(FILE_REQUIRED_TOOLS.includes("get_file"));
  assert.ok(FILE_REQUIRED_TOOLS.includes("pull_file"));
});

test("scope sentinel leak is only the missing-scope/invalid cells, never files-allowed", () => {
  assert.equal(isScopeSentinelLeak({ cell: "files-allowed", sentinelInAnswer: true }), false);
  assert.equal(isScopeSentinelLeak({ cell: "files-missing-scope", sentinelInAnswer: true }), true);
  assert.equal(isScopeSentinelLeak({ cell: "invalid-credential", sentinelInAnswer: true }), true);
  assert.equal(isScopeSentinelLeak({ cell: "files-missing-scope", sentinelInAnswer: false }), false);
});

test("zero scope is not constructible: createApiKey([]) normalizes to all MCP scopes", () => {
  assert.deepEqual(normalizeScopes([]), [...MCP_SCOPES]);
  assert.equal(MCP_SCOPES.length, 3);
});

test("summarizeScopeCell keeps success/usable honest and counts leaks and server requests", () => {
  const cell = SCOPE_CELLS.find((entry) => entry.id === "files-missing-scope");
  const summary = summarizeScopeCell(
    [
      { cell: "files-missing-scope", status: "task_failed", success: false, sentinelInAnswer: false, announcedFileTools: [], serverSawRequest: true },
      { cell: "files-missing-scope", status: "host_error", success: false, sentinelInAnswer: false, announcedFileTools: [], serverSawRequest: false },
    ],
    cell,
  );
  assert.equal(summary.executed, 2);
  assert.equal(summary.usable, 1);
  assert.equal(summary.success, 0);
  assert.equal(summary.xOverN, "0/1");
  assert.equal(summary.infraErrors, 1);
});

test("buildScopeServerEnv enables OAuth, leaves API_KEY empty and keeps the secret out of argv", () => {
  const env = buildScopeServerEnv({
    baseEnv: { PATH: "/usr/bin" },
    port: 6011,
    vault: "/tmp/v",
    data: "/tmp/d",
    adminPassword: "admin-pass",
    operator: { profile: "full", toolsets: [], tools: [] },
  });
  assert.equal(env.OAUTH_ENABLED, "true");
  assert.equal(env.API_KEY, "");
  assert.equal(env.PUBLIC_BASE_URL, "http://127.0.0.1:6011");
  assert.equal(env.MCP_PATH, "/mcp");
  assert.equal(env.OAUTH_ADMIN_PASSWORD, "admin-pass");
  assert.equal(env.MCP_DISCOVERY_PROFILE, "full");
  assert.equal(env.LANG, undefined);
});

function syntheticScopeReport() {
  const cellOf = (id) => SCOPE_CELLS.find((entry) => entry.id === id);
  const trials = [
    { cell: "files-allowed", kind: "positive", trial: 0, status: "ok", success: true, answerMatch: true, evidenceCall: true, sentinelInAnswer: true, announcedFileTools: ["get_file"], advertisedFileTools: ["get_file"], serverSawRequest: true, mutationCalls: [], deniedCalls: [] },
    { cell: "files-missing-scope", kind: "missing_scope", trial: 0, status: "task_failed", success: false, answerMatch: false, evidenceCall: false, sentinelInAnswer: false, announcedFileTools: [], advertisedFileTools: [], serverSawRequest: true, mutationCalls: [], deniedCalls: [] },
    { cell: "invalid-credential", kind: "invalid", trial: 0, status: "host_error", success: false, answerMatch: false, evidenceCall: false, sentinelInAnswer: false, announcedFileTools: [], advertisedFileTools: [], serverSawRequest: true, directProbeStatus: 401, mutationCalls: [], deniedCalls: [] },
    { cell: "missing-env-key", kind: "missing_env", trial: 0, status: "host_error", success: false, answerMatch: false, evidenceCall: false, sentinelInAnswer: false, announcedFileTools: [], advertisedFileTools: [], serverSawRequest: false, directProbeStatus: 401, mutationCalls: [], deniedCalls: [] },
  ];
  return {
    schemaVersion: "1.0.0",
    generatedBy: SCOPE_AUTHOR,
    generatedAt: "2026-01-01T00:00:00.000Z",
    experiment: "isolated OAuth-managed-key host scope submatrix",
    run: { status: "complete", completedTrials: trials.length, plannedTrials: trials.length, aborted: false },
    source: { sha: "abc", branch: "b", controlledMatrixSourceSha: "0d912a4", controlledMatrixSuccessPreserved: 70, controlledMatrixTrialsPreserved: 90 },
    host: { requestedProvider: "opencode-go", requestedModel: "deepseek-v4.1-flash", bridgeSha256: "x", bridgeBytes: 1, piCliVersion: "0.99.2", nodeVersion: "v26" },
    fixture: { taskId: SCOPE_TASK_ID, prompt: "p", promptSha256: "p", expectSha256: "e", sentinelSha256: "s", sentinelLength: 25 },
    zeroScope: { status: "blocked", constructible: false, observedScopes: [...MCP_SCOPES], reason: "unconstructible" },
    transportOnly: { label: SCOPE_TRANSPORT_ONLY_LABEL, missingScopeListedGetFile: false, missingScopeGetFileStatus: 403, invalidCredentialStatus: 401, advertisedFileTools: [] },
    cells: SCOPE_CELLS.map((cell) => summarizeScopeCell(trials.filter((trial) => trial.cell === cell.id), cell)),
    totals: { executed: trials.length, usable: 2, success: 1, infraErrors: 2, byOutcome: { ok: 1, task_failed: 1, host_error: 2 } },
    trials,
    limits: ["bounded"],
  };
}

test("verifyScopeMatrixArtifacts accepts a consistent pair and rejects tamper, leaks and false zero-scope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scope-verify-"));
  const { renderScopeMarkdown } = await import("../scripts/host-scope-matrix.mjs");
  try {
    const report = syntheticScopeReport();
    const write = async () => {
      await writeFile(path.join(dir, SCOPE_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await writeFile(path.join(dir, SCOPE_MD), `${renderScopeMarkdown(report)}\n`, "utf8");
    };
    await write();
    assert.deepEqual(await verifyScopeMatrixArtifacts({ outDir: dir }), { ok: true, errors: [] });

    // CRLF checkout is equivalent; a real edit is not.
    await writeFile(path.join(dir, SCOPE_MD), `${renderScopeMarkdown(report).replace(/\n/g, "\r\n")}\n`, "utf8");
    assert.deepEqual(await verifyScopeMatrixArtifacts({ outDir: dir }), { ok: true, errors: [] });
    await writeFile(path.join(dir, SCOPE_MD), `${renderScopeMarkdown(report)}\nTAMPER\n`, "utf8");
    assert.equal((await verifyScopeMatrixArtifacts({ outDir: dir })).ok, false);
    await write();

    // A missing-scope success or an announced unauthorized tool fails.
    report.cells.find((entry) => entry.cell === "files-missing-scope").success = 1;
    await write();
    assert.ok((await verifyScopeMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("missing-scope")));
    report.cells.find((entry) => entry.cell === "files-missing-scope").success = 0;
    report.cells.find((entry) => entry.cell === "files-missing-scope").announcedFileToolTrials = 1;
    await write();
    assert.ok((await verifyScopeMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("unauthorized")));
    report.cells.find((entry) => entry.cell === "files-missing-scope").announcedFileToolTrials = 0;

    // Faking a zero-scope PASS is rejected.
    report.zeroScope.status = "measured";
    report.zeroScope.constructible = true;
    await write();
    assert.ok((await verifyScopeMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("zeroScope")));
    report.zeroScope = { status: "blocked", constructible: false, observedScopes: [...MCP_SCOPES], reason: "unconstructible" };

    // A missing-env-key trial that reached the server is rejected.
    report.trials.find((trial) => trial.cell === "missing-env-key").serverSawRequest = true;
    await write();
    assert.ok((await verifyScopeMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("missing-env-key")));
    report.trials.find((trial) => trial.cell === "missing-env-key").serverSawRequest = false;

    // A sentinel value in the JSON is a leak.
    report.trials[0].note = "ORACLE-SCOPE-abcdefabcdef";
    await write();
    assert.ok((await verifyScopeMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("sentinel")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("committed scope artifact verifies and preserves the old 90-trial counts", async () => {
  const json = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, SCOPE_JSON), "utf8"));
  const markdown = await readFile(path.join(DEFAULT_OUT_DIR, SCOPE_MD), "utf8");
  assert.equal(await import("../scripts/host-scope-matrix.mjs").then((m) => m.renderScopeMarkdown(json).trim()), markdown.replace(/\r\n/g, "\n").trim());
  assert.deepEqual(await verifyScopeMatrixArtifacts({ outDir: DEFAULT_OUT_DIR }), { ok: true, errors: [] });
  assert.equal(json.source.controlledMatrixSourceSha, "0d912a415cd1436c6daa17063bed2781663d88d5");
  assert.equal(json.source.controlledMatrixSuccessPreserved, 70);
  const cell = (id) => json.cells.find((entry) => entry.cell === id);
  assert.equal(cell("files-allowed").usable, 5);
  assert.equal(cell("files-allowed").announcedFileToolTrials, 5);
  assert.equal(cell("files-allowed").retrievalTrials, 5);
  assert.ok(cell("files-allowed").success >= 1);
  assert.equal(cell("files-missing-scope").success, 0);
  assert.equal(cell("files-missing-scope").announcedFileToolTrials, 0);
  assert.equal(cell("invalid-credential").serverSawRequestTrials, cell("invalid-credential").executed);
  assert.equal(cell("missing-env-key").serverSawRequestTrials, 0);
  assert.equal(json.zeroScope.status, "blocked");
  assert.equal(json.transportOnly.missingScopeGetFileStatus, 403);

  // The old controlled artifact still verifies and its success count is untouched.
  const controlled = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, "controlled-matrix.json"), "utf8"));
  assert.equal(controlled.totals.success, 70);
  assert.equal(controlled.totals.executed, 90);
});
