import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTHOR,
  buildControlledServerEnv,
  buildSchedule,
  classifyToolCall,
  CONTROLLED_JSON,
  CONTROLLED_LIMITS,
  CONTROLLED_MD,
  CONTROLLED_POLICY,
  DEFAULT_OUT_DIR,
  deriveControlledSummaries,
  evaluateControlledTask,
  FIXTURE_DIR,
  generateSentinel,
  hasSentinelTemplate,
  isSentinelLeak,
  operatorEnvForCell,
  oracleToolsForTask,
  PROFILE_IDS,
  renderControlledMarkdown,
  resolveExpect,
  scheduleDigest,
  sentinelLeakTrials,
  sha256Hex,
  summarizeCellTrials,
  summarizeControlledTrace,
  TRIALS_PER_CELL,
  validateFixture,
  verifyControlledMatrixArtifacts,
} from "../scripts/host-controlled-matrix.mjs";

const TASKS = [
  { id: "a", expect: "active", prompt: "p", expectedTools: ["get_note"], alternativeTools: ["get_file"] },
  { id: "b", expect: "2", prompt: "p", expectedTools: ["compare_note_versions"], alternativeTools: ["list_versions"] },
  { id: "files-read-zh", expect: "{{SENTINEL}}", prompt: "p", expectedTools: ["get_file"], alternativeTools: ["pull_file"] },
];

test("generateSentinel is prefixed, high-entropy and non-repeating", () => {
  const first = generateSentinel();
  assert.match(first, /^ORACLE-FILES-[0-9a-f]{12}$/);
  assert.notEqual(first, generateSentinel());
});

test("resolveExpect replaces only the sentinel template placeholder", () => {
  assert.equal(resolveExpect({ expect: "{{SENTINEL}}" }, "ORACLE-FILES-abc"), "ORACLE-FILES-abc");
  assert.equal(hasSentinelTemplate({ expect: "active" }), false);
  assert.equal(hasSentinelTemplate({ expect: "{{SENTINEL}}" }), true);
});

test("oracleToolsForTask is the sorted expected ∪ alternative union and flags missing tools", () => {
  const { tools, missing } = oracleToolsForTask(TASKS[0], ["get_note", "get_file", "other"]);
  assert.deepEqual(tools, ["get_file", "get_note"]);
  assert.deepEqual(missing, []);
  const bad = oracleToolsForTask({ expectedTools: ["ghost"], alternativeTools: [] }, ["get_note"]);
  assert.deepEqual(bad.missing, ["ghost"]);
});

test("operatorEnvForCell maps the three profiles to operator configurations", () => {
  assert.deepEqual(operatorEnvForCell("full", TASKS[0], ["get_note"]), { profile: "full", toolsets: [], tools: [] });
  assert.deepEqual(operatorEnvForCell("core", TASKS[0], ["get_note"]), { profile: "core", toolsets: [], tools: [] });
  assert.deepEqual(operatorEnvForCell("oracle-module", TASKS[0], ["get_note", "get_file"]), {
    profile: "custom",
    toolsets: [],
    tools: ["get_file", "get_note"],
  });
});

test("buildSchedule is pre-registered, balanced and deterministic", () => {
  const schedule = buildSchedule(TASKS, PROFILE_IDS, TRIALS_PER_CELL);
  assert.equal(schedule.length, TASKS.length * PROFILE_IDS.length * TRIALS_PER_CELL);
  for (const task of TASKS) {
    for (const profile of PROFILE_IDS) {
      assert.equal(schedule.filter((entry) => entry.taskId === task.id && entry.profile === profile).length, TRIALS_PER_CELL);
    }
  }
  assert.equal(scheduleDigest(schedule), scheduleDigest(buildSchedule(TASKS, PROFILE_IDS, TRIALS_PER_CELL)));
  // Rotating profile order: the first task's first-trial block starts at full,
  // the second task's starts at core, the third at oracle-module.
  assert.deepEqual(schedule.slice(0, 3).map((entry) => entry.profile), ["full", "core", "oracle-module"]);
  assert.deepEqual(schedule.slice(3, 6).map((entry) => entry.profile), ["core", "oracle-module", "full"]);
  assert.deepEqual(schedule.slice(6, 9).map((entry) => entry.profile), ["oracle-module", "full", "core"]);
});

test("classifyToolCall uses only the declared taxonomy", () => {
  assert.equal(classifyToolCall("mcp_obsidian_get_note", { expectedTools: ["get_note"], alternativeTools: [] }), "expected");
  assert.equal(classifyToolCall("get_file", { expectedTools: ["get_note"], alternativeTools: ["get_file"] }), "declared_alternative");
  assert.equal(classifyToolCall("write_note", { expectedTools: ["get_note"], alternativeTools: [] }), "unexpected");
});

test("summarizeControlledTrace separates expected, alternative, unexpected, hidden-denied and mutation", () => {
  const records = [
    { type: "message_start", message: { sections: { tools: "- mcp_obsidian_get_note: get_note — read\n- mcp_obsidian_write_note: write_note — write" } } },
    { type: "tool_execution_start", toolCallId: "1", toolName: "mcp_obsidian_get_note" },
    { type: "tool_execution_end", toolCallId: "1", toolName: "mcp_obsidian_get_note", result: { isError: false } },
    { type: "tool_execution_start", toolCallId: "2", toolName: "mcp_obsidian_get_graph" },
    { type: "tool_execution_end", toolCallId: "2", toolName: "mcp_obsidian_get_graph", result: { isError: false } },
    { type: "tool_execution_start", toolCallId: "3", toolName: "mcp_obsidian_write_note" },
    { type: "tool_execution_end", toolCallId: "3", toolName: "mcp_obsidian_write_note", result: { isError: true } },
    { type: "tool_execution_start", toolCallId: "4", toolName: "mcp_obsidian_ghost_tool" },
    { type: "tool_execution_end", toolCallId: "4", toolName: "mcp_obsidian_ghost_tool", result: { isError: true } },
  ];
  const trace = summarizeControlledTrace(records, {
    readOnlyNames: ["get_note", "get_graph"],
    visibleNames: ["get_note", "get_graph", "write_note"],
    expectedTools: ["get_note"],
    alternativeTools: ["get_graph"],
  });
  assert.equal(trace.announcedToolCount, 2);
  assert.equal(trace.executedToolCallCount, 4);
  assert.equal(trace.expectedCallCount, 1);
  assert.equal(trace.declaredAlternativeCallCount, 1);
  assert.deepEqual(trace.unexpectedCalls, ["write_note", "ghost_tool"]);
  assert.deepEqual(trace.mutationCalls, ["write_note"]);
  assert.equal(trace.readOnlyGuardPassed, false);
  assert.equal(trace.evidenceCall, true);
  // A visible tool that errors on bad args is NOT hidden-denied; an invisible
  // tool that errors is.
  assert.deepEqual(
    trace.executedCalls.filter((call) => call.hiddenDenied).map((call) => call.name),
    ["ghost_tool"],
  );
});

test("evaluateControlledTask requires an exact answer AND a declared evidence call", () => {
  const okTrace = { evidenceCall: true, executedToolCallCount: 1 };
  assert.equal(evaluateControlledTask({ answer: "active", expect: "active", trace: okTrace }).success, true);
  // Exact answer, empty trace: self-report is not success.
  assert.equal(evaluateControlledTask({ answer: "active", expect: "active", trace: { evidenceCall: false, executedToolCallCount: 0 } }).success, false);
  // Unrelated call cannot satisfy evidence even with the right answer.
  assert.equal(evaluateControlledTask({ answer: "active", expect: "active", trace: { evidenceCall: false, executedToolCallCount: 3 } }).success, false);
  // Superstring/negation rejected even with an evidence call.
  assert.equal(evaluateControlledTask({ answer: "inactive", expect: "active", trace: okTrace }).success, false);
  assert.equal(evaluateControlledTask({ answer: "the value is active", expect: "active", trace: okTrace }).success, false);
  assert.equal(evaluateControlledTask({ answer: "yes", expect: "yes", trace: okTrace }).success, true);
  assert.equal(evaluateControlledTask({ answer: "yesterday", expect: "yes", trace: okTrace }).success, false);
});

test("summarizeCellTrials flags infra instability and comparison minimums", () => {
  const trial = (status, success = false) => ({ status, success });
  const unstable = summarizeCellTrials([trial("host_error"), trial("timeout"), trial("ok", true), trial("ok", true), trial("ok", true)]);
  assert.equal(unstable.infraErrors, 2);
  assert.equal(unstable.unstable, true);
  assert.equal(unstable.comparable, false);
  assert.equal(unstable.xOverN, "3/3");
  const short = summarizeCellTrials([trial("ok", true), trial("ok", true)]);
  assert.equal(short.comparable, false);
  assert.equal(short.unstable, false);
});

test("summarizeCellTrials separates answerMatches from the honest no-evidence answerOnly", () => {
  const withEvidence = { status: "ok", success: true, answerMatch: true, evidenceCall: true };
  const answerNoEvidence = { status: "task_failed", success: false, answerMatch: true, evidenceCall: false };
  const evidenceNoAnswer = { status: "task_failed", success: false, answerMatch: false, evidenceCall: true };
  const summary = summarizeCellTrials([withEvidence, answerNoEvidence, evidenceNoAnswer]);
  assert.equal(summary.answerMatches, 2);
  assert.equal(summary.answerOnly, 1);
  assert.equal(summary.evidenceOnly, 1);
  assert.equal(summary.success, 1);
});

test("policy/limits state the evidence-bearing proxy boundary", () => {
  assert.match(CONTROLLED_POLICY.evidenceBearing, /result-payload causality/);
  assert.ok(CONTROLLED_LIMITS.some((limit) => /result payload contains the answer/.test(limit)));
  assert.ok(CONTROLLED_LIMITS.some((limit) => /Auth conditions are equivalent, not byte-identical/.test(limit)));
});

test("deriveControlledSummaries regenerates cells and totals from raw trials only", () => {
  const trials = [
    { taskId: "a", profile: "full", trial: 0, status: "ok", success: true, answerMatch: true, evidenceCall: true, mutationCalls: [], deniedCalls: [] },
    { taskId: "a", profile: "full", trial: 1, status: "task_failed", success: false, answerMatch: true, evidenceCall: false, mutationCalls: [], deniedCalls: [] },
    { taskId: "a", profile: "core", trial: 0, status: "ok", success: true, answerMatch: true, evidenceCall: true, mutationCalls: [], deniedCalls: [] },
  ];
  const fixtureTasks = [{ id: "a", coreCoverage: "positive" }];
  const derived = deriveControlledSummaries({ trials, fixtureTasks, trialsPerCell: 2, plannedTrials: 4 });
  assert.equal(derived.totals.executed, 3);
  assert.equal(derived.totals.success, 2);
  const full = derived.cells.find((cell) => cell.profile === "full");
  assert.equal(full.answerMatches, 2);
  assert.equal(full.answerOnly, 1);
  assert.equal(full.success, 1);
});

test("sentinel leak is only the missing-tool profile or a non-files task", () => {
  assert.equal(isSentinelLeak({ taskId: "files-read-zh", profile: "core", sentinelInAnswer: true }), true);
  assert.equal(isSentinelLeak({ taskId: "files-read-zh", profile: "full", sentinelInAnswer: true }), false);
  assert.equal(isSentinelLeak({ taskId: "note-read-full-en", profile: "core", sentinelInAnswer: true }), true);
  assert.equal(isSentinelLeak({ taskId: "files-read-zh", profile: "oracle-module", sentinelInAnswer: false }), false);
  assert.deepEqual(
    sentinelLeakTrials([
      { taskId: "files-read-zh", profile: "core", sentinelInAnswer: true, trial: 0 },
      { taskId: "files-read-zh", profile: "full", sentinelInAnswer: true, trial: 1 },
    ]).map((entry) => entry.trial),
    [0],
  );
});

test("validateFixture rejects tools that are not in the live catalog", () => {
  const fixture = { tasks: [{ id: "x", prompt: "p", expect: "e", expectedTools: ["ghost"], alternativeTools: [] }] };
  const errors = validateFixture(fixture, ["get_note"]);
  assert.ok(errors.some((error) => error.includes("ghost")));
});

test("buildControlledServerEnv keeps the key out of argv-shaped data and forces read-only", () => {
  const secret = generateSentinel();
  const env = buildControlledServerEnv({
    baseEnv: { PATH: "/usr/bin" },
    port: 6011,
    vault: "/tmp/v",
    data: "/tmp/d",
    apiKey: secret,
    operator: { profile: "custom", toolsets: [], tools: ["get_note", "get_file"] },
  });
  assert.equal(env.API_KEY, secret);
  assert.equal(env.OBSIDIAN_READ_ONLY, "true");
  assert.equal(env.OAUTH_ENABLED, "false");
  assert.equal(env.MCP_DISCOVERY_PROFILE, "custom");
  assert.equal(env.MCP_DISCOVERY_TOOLS, "get_note,get_file");
  assert.equal(env.LANG, undefined);
});

test("fixture tasks.json is well-formed and its prompts never template the sentinel value", async () => {
  const fixture = JSON.parse(await readFile(path.join(FIXTURE_DIR, "tasks.json"), "utf8"));
  assert.equal(fixture.tasks.length, 6);
  for (const task of fixture.tasks) {
    assert.ok(task.prompt.includes(" ") || task.prompt.length > 0);
    assert.equal(task.prompt.includes("ORACLE-FILES-"), false);
    assert.equal(JSON.stringify(task.expectedTools).includes("{{"), false);
  }
});

function syntheticReport() {
  const trial = {
    taskId: "a",
    profile: "full",
    trial: 0,
    status: "ok",
    success: true,
    answerMatch: true,
    evidenceCall: true,
    executedToolCallCount: 1,
    mutationCalls: [],
    deniedCalls: [],
    sentinelInAnswer: false,
    catalogCount: 2,
    readOnlyCount: 1,
    schemaBytes: 10,
    descriptorBytesSum: 7,
  };
  return {
    schemaVersion: "1.0.0",
    generatedBy: AUTHOR,
    generatedAt: "2026-01-01T00:00:00.000Z",
    run: { status: "complete", completedTrials: 1, plannedTrials: 1, aborted: false },
    source: { sha: "0d912a4", branch: "b" },
    host: { requestedProvider: "opencode-go", requestedModel: "deepseek-v4.1-flash", bridgeSha256: sha256Hex("x"), bridgeBytes: 1, piCliVersion: "0.99.2", nodeVersion: "v26" },
    fixture: { sentinelSha256: sha256Hex("s"), sentinelLength: 25 },
    policy: CONTROLLED_POLICY,
    schedule: { sha256: sha256Hex("sched"), trialsPerCell: 1 },
    mutationGuard: { tool: "write_note", denied: true, fileCreated: false },
    cells: [{ taskId: "a", profile: "full", coreCoverage: "positive", planned: 1, executed: 1, usable: 1, success: 1, answerOnly: 1, evidenceOnly: 0, infraErrors: 0, unstable: false, comparable: true, xOverN: "1/1", trials: [trial] }],
    totals: { planned: 1, executed: 1, usable: 1, success: 1, infraErrors: 0, byOutcome: { ok: 1 } },
    controlGate: { mutationCalls: 0, sentinelLeaks: 0, deniedCalls: 0, aborted: false, reason: null },
    scopeNegative: { status: "blocked", reason: "no isolated reduced-scope host credential path" },
    costMetrics: [{ profile: "full", catalogCount: 2, readOnlyCount: 1, schemaBytes: 10, descriptorBytesSum: 7, framingOk: true, estimatedTokensCeilBytes4: 3, providerPayloadTokens: "UNMEASURED" }],
    trials: [trial],
    limits: ["bounded"],
  };
}

test("committed controlled-matrix artifact verifies and carries the expected controlled pattern", async () => {
  const json = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, CONTROLLED_JSON), "utf8"));
  const markdown = await readFile(path.join(DEFAULT_OUT_DIR, CONTROLLED_MD), "utf8");
  assert.equal(renderControlledMarkdown(json).trim(), markdown.replace(/\r\n/g, "\n").trim());
  assert.deepEqual(await verifyControlledMatrixArtifacts({ outDir: DEFAULT_OUT_DIR }), { ok: true, errors: [] });

  // Frozen provenance: the experiment ran from the accepted Phase 3 sha and
  // measured live host behavior in the controlled 6 x 3 x 5 design.
  assert.equal(json.source.sha, "0d912a415cd1436c6daa17063bed2781663d88d5");
  assert.equal(json.totals.planned, 90);
  assert.equal(json.totals.executed, 90);
  assert.equal(json.totals.infraErrors, 0);
  assert.equal(json.controlGate.aborted, false);
  assert.equal(json.controlGate.mutationCalls, 0);
  assert.equal(json.controlGate.sentinelLeaks, 0);
  assert.equal(json.mutationGuard.denied, true);
  assert.equal(json.mutationGuard.fileCreated, false);
  for (const cost of json.costMetrics) assert.equal(cost.providerPayloadTokens, "UNMEASURED");

  // Controlled result: the per-task oracle and full profiles hold every cell;
  // the static core profile holds only the two positive-coverage tasks and
  // fails the partial/missing-coverage tasks as pre-registered.
  const cell = (taskId, profile) => json.cells.find((entry) => entry.taskId === taskId && entry.profile === profile);
  for (const task of ["note-read-full-en", "search-relevance-en", "server-info-capability-mixed", "links-backlinks-en", "files-read-zh", "compare-versions-zh"]) {
    assert.equal(cell(task, "full").xOverN, "5/5", `${task}/full`);
    assert.equal(cell(task, "oracle-module").xOverN, "5/5", `${task}/oracle-module`);
  }
  assert.equal(cell("note-read-full-en", "core").xOverN, "5/5");
  assert.equal(cell("search-relevance-en", "core").xOverN, "5/5");
  assert.equal(cell("server-info-capability-mixed", "core").xOverN, "0/5");
  assert.equal(cell("links-backlinks-en", "core").xOverN, "0/5");
  assert.equal(cell("files-read-zh", "core").xOverN, "0/5");
  assert.equal(cell("compare-versions-zh", "core").xOverN, "0/5");
  // The reduced-scope host negative was not fabricable; it is recorded unknown.
  assert.equal(json.scopeNegative.status, "blocked");
});

test("verifyControlledMatrixArtifacts accepts a consistent pair and rejects drift/tamper/sentinel", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "controlled-verify-"));
  try {
    const report = syntheticReport();
    const write = async () => {
      await writeFile(path.join(dir, CONTROLLED_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await writeFile(path.join(dir, CONTROLLED_MD), `${renderControlledMarkdown(report)}\n`, "utf8");
    };
    await write();
    assert.deepEqual(await verifyControlledMatrixArtifacts({ outDir: dir }), { ok: true, errors: [] });

    // Markdown tamper fails; CRLF checkout is equivalent to LF.
    await writeFile(path.join(dir, CONTROLLED_MD), `${renderControlledMarkdown(report)}\nTAMPER\n`, "utf8");
    assert.equal((await verifyControlledMatrixArtifacts({ outDir: dir })).ok, false);
    await write();
    await writeFile(path.join(dir, CONTROLLED_MD), `${renderControlledMarkdown(report).replace(/\n/g, "\r\n")}\n`, "utf8");
    assert.deepEqual(await verifyControlledMatrixArtifacts({ outDir: dir }), { ok: true, errors: [] });
    await write();

    // Catalog framing drift fails.
    report.costMetrics[0].descriptorBytesSum = 6;
    await write();
    assert.ok((await verifyControlledMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("framing")));
    report.costMetrics[0].descriptorBytesSum = 7;

    // Provider payload tokens must stay UNMEASURED.
    report.costMetrics[0].providerPayloadTokens = "1234";
    await write();
    assert.ok((await verifyControlledMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("UNMEASURED")));
    report.costMetrics[0].providerPayloadTokens = "UNMEASURED";

    // Cell arithmetic must stay consistent.
    report.cells[0].success = 2;
    await write();
    assert.equal((await verifyControlledMatrixArtifacts({ outDir: dir })).ok, false);
    report.cells[0].success = 1;

    // A sentinel value in the JSON is a leak.
    report.trials[0].note = "ORACLE-FILES-abcdefabcdef";
    await write();
    assert.ok((await verifyControlledMatrixArtifacts({ outDir: dir })).errors.some((error) => error.includes("sentinel")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
