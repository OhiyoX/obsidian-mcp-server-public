import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import {
  ADDITIVE_SINCE_PARITY_SNAPSHOT,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_OUT_DIR,
  EAGER_RUN_JSON,
  PARITY_JSON,
  PROBE_RECIPES,
  buildLocalCatalog,
  buildParityReport,
  buildProbePlan,
  canonicalJsonText,
  classifyToolCall,
  compareToolCatalog,
  digestJson,
  evaluateFixtures,
  findUnsafeUrlLike,
  formatEagerRunMarkdown,
  formatParityMarkdown,
  parseMcpResponseBody,
  sanitizeEndpoint,
  summarizeProbes,
  validateEagerRunReport,
  validateParityReport,
  verifyCheckedInArtifacts,
} from "../scripts/tool-discovery-production-eval.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const SCRIPT_PATH = path.join(APP_DIR, "scripts", "tool-discovery-production-eval.mjs");

const inventory = JSON.parse(await readFile(DEFAULT_INVENTORY_PATH, "utf8"));
const inventoryByName = new Map(inventory.tools.map((tool) => [tool.name, tool]));

// --- canonical JSON / digests -----------------------------------------------------

test("canonical JSON sorts keys recursively and digests are order-independent", () => {
  const a = { b: 1, a: { d: [2, 3], c: "x" } };
  const b = { a: { c: "x", d: [2, 3] }, b: 1 };
  assert.equal(canonicalJsonText(a), canonicalJsonText(b));
  assert.deepEqual(digestJson(a), digestJson(b));
  assert.equal(canonicalJsonText(a), '{"a":{"c":"x","d":[2,3]},"b":1}');
  assert.match(digestJson(a).sha256, /^[0-9a-f]{64}$/);
});

// --- SSE / JSON transport parsing -------------------------------------------------

test("parseMcpResponseBody accepts plain JSON and Streamable HTTP SSE frames", () => {
  const payload = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
  assert.deepEqual(parseMcpResponseBody(JSON.stringify(payload), "application/json"), payload);
  assert.deepEqual(parseMcpResponseBody(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, "text/event-stream"), payload);
  assert.equal(parseMcpResponseBody(""), null);
});

// --- outcome classification -------------------------------------------------------

test("classifyToolCall distinguishes success, tool errors and protocol failures", () => {
  assert.equal(classifyToolCall({ kind: "result", result: { content: [], isError: false } }).outcome, "success");
  assert.equal(classifyToolCall({ kind: "result", result: { isError: true, content: [{ type: "text", text: "boom" }] } }).outcome, "tool_error");
  assert.equal(
    classifyToolCall({ kind: "result", result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Input validation error: bad" }] } }).outcome,
    "invalid_arguments",
  );
  assert.equal(
    classifyToolCall({ kind: "result", result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Output validation error: bad" }] } }).outcome,
    "output_contract_violation",
  );
  assert.equal(classifyToolCall({ kind: "rpc_error", error: { code: -32601, message: "no" } }).outcome, "unknown_tool");
  assert.equal(classifyToolCall({ kind: "http_error", status: 401 }).outcome, "transport_error");
  assert.equal(classifyToolCall({ kind: "transport_error", code: "timeout" }).outcome, "transport_error");
});

test("tool payload text containing -32602 is not misclassified as a validation error", () => {
  const diff = "Error: git diff failed\n+ const x = -32602;\n";
  const result = classifyToolCall({ kind: "result", result: { isError: true, content: [{ type: "text", text: diff }] } });
  assert.equal(result.outcome, "tool_error");
});

test("budget-exceeded transfer errors carry a distinct probe-budget reason", () => {
  const budget = classifyToolCall({
    kind: "result",
    result: { isError: true, content: [{ type: "text", text: "Error: Complete note is 52175 bytes, exceeding maxBytes=4096; raise maxBytes" }] },
  });
  assert.equal(budget.outcome, "tool_error");
  assert.equal(budget.reason, "payload_exceeds_probe_budget");
});

// --- probe planning ---------------------------------------------------------------

test("buildProbePlan only probes read-only tools and never invents arguments", () => {
  const catalog = [
    { name: "list_notes", annotations: { readOnlyHint: true }, inputSchema: { properties: { limit: {}, cursor: {} }, required: [] } },
    { name: "write_note", annotations: { readOnlyHint: false }, inputSchema: { properties: { path: {} }, required: ["path"] } },
    { name: "get_note", annotations: { readOnlyHint: true }, inputSchema: { properties: { path: {} }, required: ["path"] } },
    { name: "plan_note_changes", annotations: { readOnlyHint: true }, inputSchema: { properties: { changes: {} }, required: ["changes"] } },
    { name: "mystery_read", annotations: { readOnlyHint: true }, inputSchema: { properties: {}, required: [] } },
  ];
  const plan = buildProbePlan({ catalog, context: {} });
  const byName = new Map(plan.map((entry) => [entry.tool, entry]));

  assert.equal(byName.get("write_note").probe, false);
  assert.equal(byName.get("write_note").reason, "not_read_only");
  assert.equal(byName.get("get_note").probe, false, "missing required context must not be probed");
  assert.equal(byName.get("get_note").reason, "missing_context:path");
  assert.equal(byName.get("plan_note_changes").probe, false);
  assert.equal(byName.get("plan_note_changes").reason, "creates_plan_stateful");
  assert.equal(byName.get("mystery_read").probe, false);
  assert.equal(byName.get("mystery_read").reason, "no_probe_recipe");
});

test("buildProbePlan drops undeclared properties and keeps declared ones", () => {
  const catalog = [
    { name: "list_notes", annotations: { readOnlyHint: true }, inputSchema: { properties: { limit: {} }, required: [] } },
    { name: "get_note", annotations: { readOnlyHint: true }, inputSchema: { properties: { path: {}, includeLinks: {} }, required: ["path"] } },
  ];
  const plan = buildProbePlan({ catalog, context: { sampleNotePath: "Notes/Example.md" } });
  const notes = plan.find((entry) => entry.tool === "list_notes");
  assert.deepEqual(notes.args, { limit: 3 });
  const note = plan.find((entry) => entry.tool === "get_note");
  assert.deepEqual(note.args, { path: "Notes/Example.md" });
});

test("every probe recipe targets a known tool and only read-only recipes are reachable", async () => {
  const known = new Set(TOOL_NAMES);
  for (const name of PROBE_RECIPES.keys()) assert.ok(known.has(name), `recipe for unknown tool ${name}`);
  const local = await buildLocalCatalog();
  const plan = buildProbePlan({ catalog: local, context: { sampleNotePath: "n.md", sampleBasePath: "b.base", sampleSkillPath: "s" } });
  for (const entry of plan.filter((item) => item.probe)) {
    assert.equal(entry.readOnly, true, `${entry.tool} is not read-only but was planned for probing`);
  }
});

// --- parity comparison ------------------------------------------------------------

function inventoryRowFor(tool) {
  return {
    name: tool.name,
    title: tool.title || "",
    inputSchema: digestJson(tool.inputSchema ?? {}),
    outputContract: digestJson(tool.outputSchema ?? {}),
    annotations: tool.annotations ?? {},
  };
}

test("compareToolCatalog reports a match for identical catalogs and detects drift", () => {
  const tool = {
    name: "server_info",
    title: "Server Info",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  const baseline = { tools: [inventoryRowFor(tool)], totals: { inputSchemaBytes: digestJson(tool.inputSchema).bytes, outputSchemaBytes: digestJson(tool.outputSchema).bytes } };
  const match = compareToolCatalog({ productionTools: [tool], inventory: baseline, expectedToolNames: ["server_info"] });
  assert.equal(match.allSchemasMatch, true);
  assert.equal(match.inputSchemaMismatches.length, 0);
  assert.equal(match.outputSchemaMismatches.length, 0);

  const drifted = { ...tool, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } };
  const drift = compareToolCatalog({ productionTools: [drifted], inventory: baseline, expectedToolNames: ["server_info"] });
  assert.equal(drift.annotationMismatches.length, 1);
  assert.equal(drift.allSchemasMatch, true, "schema fields are unchanged; only annotations drift");
});

test("offline anchor: the current working tree still reproduces the Wave 1 inventory", async () => {
  const local = await buildLocalCatalog();
  const parity = compareToolCatalog({ productionTools: local, inventory });
  // Additive tools are allowed; no historical Wave 1 tool may be removed or drift.
  assert.ok(local.length >= inventory.tools.length, "local catalog must not drop Wave 1 tools");
  assert.deepEqual(parity.inventoryMissingFromProduction, []);
  assert.deepEqual(parity.inputSchemaMismatches, []);
  assert.deepEqual(parity.outputSchemaMismatches, []);
  assert.deepEqual(parity.annotationMismatches, []);
  assert.deepEqual(parity.titleMismatches, []);
  assert.equal(parity.nameSetMatchesExpected, true);
});

// --- fixture scoring --------------------------------------------------------------

function catalogTool(name, readOnly) {
  return { name, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly }, inputSchema: { properties: {}, required: [] } };
}

test("evaluateFixtures maps real probe outcomes to honest task readiness", () => {
  const catalog = [catalogTool("get_note", true), catalogTool("write_note", false), catalogTool("recall", true), catalogTool("git_diff", true)];
  const tasks = [
    { taskId: "ready", category: "c", language: "en", expectedTools: ["get_note"] },
    { taskId: "safety", category: "c", language: "en", expectedTools: ["write_note"] },
    { taskId: "harness", category: "c", language: "en", expectedTools: ["recall"] },
    { taskId: "failed", category: "c", language: "en", expectedTools: ["git_diff"] },
  ];
  const probeResults = {
    get_note: { outcome: "success", reason: null },
    recall: { outcome: "not_probed", reason: "no_probe_recipe" },
    git_diff: { outcome: "output_contract_violation", reason: "output_validation" },
  };
  const run = evaluateFixtures({ tasks, catalog, probeResults, inventory });
  const byId = new Map(run.perTask.map((row) => [row.taskId, row]));
  assert.equal(byId.get("ready").status, "ready");
  assert.equal(byId.get("safety").status, "blocked_safety");
  assert.equal(byId.get("harness").status, "blocked_harness");
  assert.equal(byId.get("failed").status, "failed");
  assert.equal(byId.get("failed").failed[0].reason, "output_validation");
  assert.equal(run.reachableRate, 1);
  assert.equal(run.readyRate, 0.25);
});

test("summarizeProbes separates read-only coverage from excluded write tools", () => {
  const plan = [
    { tool: "get_note", readOnly: true, probe: true, args: { path: "n.md" } },
    { tool: "plan_move_note", readOnly: true, probe: false, reason: "creates_plan_stateful" },
    { tool: "write_note", readOnly: false, probe: false, reason: "not_read_only" },
  ];
  const results = {
    get_note: { outcome: "success", resultBytes: 10 },
    plan_move_note: { outcome: "not_probed", reason: "creates_plan_stateful" },
  };
  const summary = summarizeProbes(plan, results);
  assert.equal(summary.readOnlyTools, 2);
  assert.equal(summary.readOnlyProbedTools, 1);
  assert.equal(summary.readOnlyNotProbedTools, 1);
  assert.equal(summary.writeOrDestructiveToolsExcluded, 1);
  assert.equal(summary.invokedCalls, 1);
  assert.equal(summary.successRate, 1);
});

// --- checked-in artifacts ---------------------------------------------------------

test("offline verifier checks both artifact contracts and cross-consistency (not live provenance)", async () => {
  const verification = await verifyCheckedInArtifacts({ inventoryPath: DEFAULT_INVENTORY_PATH, outDir: DEFAULT_OUT_DIR });
  assert.equal(verification.ok, true, verification.errors.join("\n"));
  assert.equal(verification.offlineCanProveLiveOrigin, false);

  const parityReport = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, PARITY_JSON), "utf8"));
  assert.equal(parityReport.status, "match");
  assert.equal(parityReport.parity.wireToolCount, parityReport.baseline.inventoryToolCount);
  // The checked-in inventory may only grow by the explicitly named additive descriptors (#254).
  assert.deepEqual([...ADDITIVE_SINCE_PARITY_SNAPSHOT], ["read_archive_entry"]);
  assert.equal(
    inventory.tools.length,
    parityReport.parity.wireToolCount + ADDITIVE_SINCE_PARITY_SNAPSHOT.length,
    "the checked-in Wave 1 inventory must equal the captured catalog plus the named additive list",
  );
  for (const name of ADDITIVE_SINCE_PARITY_SNAPSHOT) {
    assert.ok(inventoryByName.has(name), `named additive tool ${name} must be present in the checked-in inventory`);
  }
  assert.equal(parityReport.scope.status, "not_wire_observable");
  assert.equal(parityReport.scope.deployedScopeEnforcement, "unknown");
  assert.equal(parityReport.target.url, undefined, "parity artifact must not embed a raw url");
  assert.equal(parityReport.provenance.offlineCanProveLiveOrigin, false);

  const eager = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, EAGER_RUN_JSON), "utf8"));
  assert.equal(eager.safety.writeOrDestructiveToolsInvoked, 0);
  assert.equal(eager.agentTaskSuccess.status, "blocked");
  assert.equal(eager.target.url, undefined, "eager artifact must not embed a raw url");
  assert.deepEqual(eager.target.endpoint, parityReport.target.endpoint, "eager/parity endpoint must agree");
  for (const row of eager.probeDetail) {
    const entry = inventoryByName.get(row.tool);
    assert.ok(entry, `eager run references unknown tool ${row.tool}`);
    assert.equal(entry.risk, "read-only", `eager run invoked non-read-only tool ${row.tool}`);
  }
});

// Reverse control: additive growth is pinned to the named list, so an unnamed extra tool,
// a missing named tool and a shrink must each fail validation.
test("validateParityReport rejects unnamed additive growth and named/removed inventory drift", async () => {
  const parityReport = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, PARITY_JSON), "utf8"));
  // The named list is spelled out literally here on purpose: a future additive descriptor must
  // edit this assertion deliberately instead of sliding in.
  assert.deepEqual([...ADDITIVE_SINCE_PARITY_SNAPSHOT], ["read_archive_entry"]);
  assert.deepEqual(validateParityReport(parityReport, inventory), [], "the unmutated pair must validate cleanly");

  // 1. an extra, unnamed tool may not slide in on additive growth
  const withUnnamed = structuredClone(inventory);
  withUnnamed.tools.push({ name: "not_a_registered_tool", risk: "read-only" });
  const unnamedErrors = validateParityReport(parityReport, withUnnamed);
  assert.ok(
    unnamedErrors.some((error) => /named additive/.test(error) && /requires exactly/.test(error)),
    `unnamed additive growth must fail the exact-count check:\n${unnamedErrors.join("\n")}`,
  );

  // 2. removing one of the named additive tools must fail, even though the count merely shrinks
  const withoutNamed = structuredClone(inventory);
  withoutNamed.tools = withoutNamed.tools.filter((tool) => tool.name !== "read_archive_entry");
  const namedErrors = validateParityReport(parityReport, withoutNamed);
  assert.ok(
    namedErrors.some((error) => /named additive tool read_archive_entry is missing/.test(error)),
    `a missing named additive tool must be reported:\n${namedErrors.join("\n")}`,
  );

  // 3. removing a historical tool must fail as well
  const historical = inventory.tools.find((tool) => tool.name !== "read_archive_entry");
  const withoutHistorical = structuredClone(inventory);
  withoutHistorical.tools = withoutHistorical.tools.filter((tool) => tool.name !== historical.name);
  const historicalErrors = validateParityReport(parityReport, withoutHistorical);
  assert.ok(historicalErrors.length > 0, "removing a historical tool must fail parity validation");
  assert.ok(
    historicalErrors.some((error) => /requires exactly/.test(error)),
    `a shrunk inventory must fail the exact-count check:\n${historicalErrors.join("\n")}`,
  );
});

// --- endpoint redaction -----------------------------------------------------------

test("sanitizeEndpoint redacts host, userinfo, path and credential query parameters", () => {
  assert.deepEqual(sanitizeEndpoint("http://10.0.0.10:18923/mcp"), {
    endpointClass: "http-private-custom-port",
    scheme: "http",
    network: "private",
    port: "custom",
  });
  const sensitive = sanitizeEndpoint("https://user:pass@internal.example.com:8443/mcp?access_token=SEKRET&signature=deadbeef#frag");
  assert.equal(sensitive.scheme, "https");
  assert.equal(sensitive.network, "public");
  assert.equal(sensitive.port, "custom");
  const text = JSON.stringify(sensitive);
  for (const secret of ["user", "pass", "internal.example.com", "8443", "access_token", "SEKRET", "signature", "deadbeef"]) {
    assert.ok(!text.includes(secret), `sanitizeEndpoint leaked ${secret}`);
  }
  assert.equal(sanitizeEndpoint("http://127.0.0.1:3000/mcp").network, "loopback");
  assert.equal(sanitizeEndpoint("http://[fe80::1]:18923/mcp").network, "link-local");
  assert.equal(sanitizeEndpoint("").endpointClass, "unset");
  assert.equal(sanitizeEndpoint("not a url").endpointClass, "invalid");
});

test("findUnsafeUrlLike flags credential query and userinfo URL variants", () => {
  assert.deepEqual(findUnsafeUrlLike({ a: "http://host/mcp?api_key=1" }), ["$.a"]);
  assert.deepEqual(findUnsafeUrlLike({ a: "https://u:p@host/mcp" }), ["$.a"]);
  assert.deepEqual(findUnsafeUrlLike({ a: "https://host/mcp" }), []);
  assert.deepEqual(findUnsafeUrlLike([{ nested: "https://host/mcp?sig=abc" }]), ["$[0].nested"]);
});

test("buildParityReport never embeds a sensitive raw endpoint", () => {
  const row = { name: "server_info", title: "Server Info", inputSchema: digestJson({}), outputContract: digestJson({}), annotations: {} };
  const production = [{ name: "server_info", title: "Server Info", inputSchema: {}, outputSchema: {}, annotations: {} }];
  const report = buildParityReport({
    target: {
      url: "https://user:pass@internal.example.com:8443/mcp?access_token=SEKRET&signature=deadbeef",
      serverInfo: { name: "obsidian-mcp-server", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    },
    parity: compareToolCatalog({ productionTools: production, inventory: { tools: [row], totals: {} }, expectedToolNames: ["server_info"] }),
  });
  const text = JSON.stringify(report);
  for (const secret of ["user:pass", "internal.example.com", "8443", "access_token", "SEKRET", "signature", "deadbeef"]) {
    assert.ok(!text.includes(secret), `parity report leaked ${secret}`);
  }
  // The synthetic inventory must satisfy the same named-additive contract as the real one:
  // one snapshot descriptor plus the single explicitly named additive tool.
  assert.deepEqual(
    validateParityReport(report, { tools: [row, { name: ADDITIVE_SINCE_PARITY_SNAPSHOT[0] }] }),
    [],
    `one snapshot tool plus the named additive list [${ADDITIVE_SINCE_PARITY_SNAPSHOT.join(", ")}] must satisfy the contract`,
  );
});

test("offline validators reject raw/credential URLs and cross-artifact drift", async () => {
  const parityReport = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, PARITY_JSON), "utf8"));
  const eager = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, EAGER_RUN_JSON), "utf8"));

  const leaked = JSON.parse(JSON.stringify(parityReport));
  leaked.target = { url: "http://10.0.0.10:18923/mcp?access_token=SEKRET" };
  const leakErrors = validateParityReport(leaked, inventory);
  assert.ok(leakErrors.some((error) => /raw url/.test(error)), leakErrors.join("\n"));
  assert.ok(leakErrors.some((error) => /credential-like URL/.test(error)), leakErrors.join("\n"));

  const drifted = JSON.parse(JSON.stringify(eager));
  drifted.target.endpoint = { ...drifted.target.endpoint, endpointClass: "https-public-default-port" };
  const crossErrors = validateEagerRunReport(drifted, { parityReport, fixtureCount: 50, inventory });
  assert.ok(crossErrors.some((error) => /endpointClass mismatch/.test(error)), crossErrors.join("\n"));

  const unsafe = JSON.parse(JSON.stringify(eager));
  unsafe.measured = [...unsafe.measured, "https://user:pw@example.com/mcp"];
  assert.ok(validateEagerRunReport(unsafe, { parityReport, fixtureCount: 50, inventory }).some((error) => /credential-like URL/.test(error)));
});

test("offline verifier reads and validates eager-run.json, not only parity", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "wave2-verify-"));
  try {
    const parityReport = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, PARITY_JSON), "utf8"));
    const eager = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, EAGER_RUN_JSON), "utf8"));
    eager.probeDetail = [...eager.probeDetail, { tool: "write_note", outcome: "success", reason: null, resultBytes: 1 }];
    await writeFile(path.join(outDir, PARITY_JSON), `${JSON.stringify(parityReport, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, EAGER_RUN_JSON), `${JSON.stringify(eager, null, 2)}\n`, "utf8");
    const verification = await verifyCheckedInArtifacts({ inventoryPath: DEFAULT_INVENTORY_PATH, outDir });
    assert.equal(verification.ok, false);
    assert.ok(verification.errors.some((error) => /non-read-only tool write_note/.test(error)), verification.errors.join("\n"));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("committed markdown reports do not claim agent task success", async () => {
  const parityReport = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, PARITY_JSON), "utf8"));
  const eager = JSON.parse(await readFile(path.join(DEFAULT_OUT_DIR, EAGER_RUN_JSON), "utf8"));
  assert.match(formatParityMarkdown(parityReport), /Scope/);
  const eagerMd = formatEagerRunMarkdown(eager);
  assert.match(eagerMd, /blocked/);
  assert.doesNotMatch(eagerMd, /task success rate|agent success rate/i);
});

// --- CLI safety -------------------------------------------------------------------

test("CLI reports blocked (never fabricated) when no host is configured", async () => {
  const env = { ...process.env };
  delete env.OBSIDIAN_MCP_URL;
  const error = await execFileAsync(process.execPath, [SCRIPT_PATH, "--run", "--json"], { env, cwd: APP_DIR }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error, "blocked runs must exit non-zero");
  assert.equal(error.code, 3);
  const result = JSON.parse(error.stdout);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /no MCP URL/);
});

test("CLI never emits the API key, even on transport failure", { timeout: 30000 }, async () => {
  const fakeKey = "TEST_SECRET_SHOULD_NOT_APPEAR_1234567890";
  const env = { ...process.env, OBSIDIAN_MCP_API_KEY: fakeKey };
  const failure = await execFileAsync(
    process.execPath,
    [SCRIPT_PATH, "--run", "--url", "http://127.0.0.1:9/mcp", "--timeout-ms", "3000", "--json"],
    { env, cwd: APP_DIR },
  ).then(
    () => null,
    (error) => error,
  );
  const stdout = failure?.stdout || "";
  assert.ok(!stdout.includes(fakeKey), "API key leaked into CLI output");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /initialize failed/);
});

test("script source carries no baked host or credential", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /192\.168\.10\.9/);
  assert.doesNotMatch(source, /wangxin/i);
  assert.doesNotMatch(source, /X-API-Key["']?\s*[:=]\s*["'][^"']+["']/);
});

test("fixtures still resolve every expected and alternative tool against TOOL_NAMES", async () => {
  const { loadFixtures, validateFixtures } = await import("../scripts/tool-discovery-eager.mjs");
  const fixtureFile = await loadFixtures();
  const validation = validateFixtures(fixtureFile);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  const known = new Set(TOOL_NAMES);
  for (const task of fixtureFile.tasks) {
    for (const name of [...task.expectedTools, ...task.alternativeTools]) assert.ok(known.has(name), `${task.taskId}: ${name}`);
  }
});

// ── Declared output widenings (Wave 1 baseline stays frozen) ────────────────
//
// `get_base.revision` (P1 #629) is the CAS token `patch_base.ifMatch` consumes, so the
// historical output contract had to grow by one property. The projection below is what
// makes that *declared* growth comparable to the frozen inventory; these three checks
// exist so the projection cannot quietly become a blanket exemption.
test("declared output widenings are minimal, and an undeclared one still goes red", async () => {
  const inventory = JSON.parse(await readFile(DEFAULT_INVENTORY_PATH, "utf8"));
  const localTools = await buildLocalCatalog();
  const live = compareToolCatalog({ productionTools: localTools, inventory });

  // (a) The declaration is exactly the set that is actually projected — no blanket pass.
  assert.deepEqual(live.compatibleOutputSchemaWidenings, ["get_base"]);
  assert.deepEqual(live.outputSchemaMismatches, []);

  // (b) Negative control: an *undeclared* extra output property must still be reported.
  const widened = structuredClone(localTools);
  const getBase = widened.find((tool) => tool.name === "get_base");
  getBase.outputSchema.properties.sneakyExtra = { type: "string" };
  const drift = compareToolCatalog({ productionTools: widened, inventory });
  assert.deepEqual(drift.outputSchemaMismatches, ["get_base"], "an undeclared output property is still drift");

  // (c) Negative control: the *declared* property's spec must stay byte-frozen. A drifted
  // spec has to throw rather than be projected away as if it were still the declared one.
  const tampered = structuredClone(localTools);
  const tamperedGetBase = tampered.find((tool) => tool.name === "get_base");
  tamperedGetBase.outputSchema.properties.revision.type = "number";
  assert.throws(
    () => compareToolCatalog({ productionTools: tampered, inventory }),
    /get_base output compatibility rule expects an exact revision spec/,
  );
});
