#!/usr/bin/env node
// Phase 3-B controlled eager-bridge matrix (isolated scratch, read-only).
//
// Drives the *real* Pi host, through the user's installed Obsidian MCP bridge
// extension, against an isolated loopback scratch server, and repeats every
// (task, profile) cell at least `TRIALS_PER_CELL` times with a byte-identical
// prompt/fixture/expectation under equivalent auth conditions: every trial gets a
// fresh single-use ephemeral key on its own isolated loopback server, so the auth
// *bytes* differ while the granted all-scope principal is the same. Three profiles:
//
//   full          - the eager 86-tool catalog
//   core          - the static 6-tool core profile
//   oracle-module - a per-task ORACLE upper bound: operator profile `custom`
//                   with exactly `expectedTools ∪ alternativeTools`. This is an
//                   oracle, NOT deployable autonomous discovery; it proves the
//                   ceiling, it does not propose a shipping profile.
//

//
// Tool-call taxonomy (no invented categories):
//   expected | declared_alternative | unexpected | hidden_denied
// Only genuine errors/denials/violations are treated as invalid; an `unexpected`
// read-only call is recorded, not silently counted as success evidence.
//
// Success rule boundary: an evidence-bearing call is accepted as
// `expected | declared_alternative` AND non-error. The harness does NOT assert
// that the returned payload actually contains the answer, so a measured
// "success" is a task-success proxy under that boundary, not a claim of
// observed payload causality for general tasks.
//
// Hygiene contract (verified by app/test/host-controlled-matrix.test.js):
//   - scratch API key from crypto.randomBytes, passed to children ONLY via spawn
//     env; never argv/shell/file/stdout/stderr/artifact;
//   - the random missing-tool sentinel lives ONLY inside the scratch vault copy
//     of Attachments/diagram.svg and is never written to a prompt/note/metadata
//     description/artifact. The artifact records only its sha256 and length.
//
// Read-only guard is a POST-HOC assertion over the live `readOnlyHint:true` set
// from the isolated server's own `tools/list`; it is not a blanket
// OBSIDIAN_READ_ONLY execution gate (manage_publish/reindex_vault are not
// readOnlyHint and would be flagged). The first observed non-read-only host call
// aborts the whole live batch.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatedArtifactMismatch } from "./artifact-text.mjs";
import {
  answerMatchesExpect,
  buildPiArgs,
  generateEphemeralKey,
  normalizeAnswer,
  normalizeToolName,
  parsePiRecords,
  resolvePiCli,
  scrubText,
  scrubValue,
} from "./host-bridge-evidence.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_DIR = path.resolve(APP_DIR, "..");
export const FIXTURE_DIR = path.join(APP_DIR, "test", "fixtures", "host-controlled-matrix");
export const DEFAULT_OUT_DIR = path.join(REPO_DIR, "docs", "review", "tool-discovery", "host-matrix");
export const CONTROLLED_JSON = "controlled-matrix.json";
export const CONTROLLED_MD = "controlled-matrix.md";
export const DEFAULT_EXTENSION = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
  "obsidian-mcp",
  "index.ts",
);

export const SCHEMA_VERSION = "1.0.0";
export const AUTHOR = "app/scripts/host-controlled-matrix.mjs";
export const PROVIDER = "opencode-go";
export const MODEL = "deepseek-v4.1-flash";
export const TRIALS_PER_CELL = 5;
export const MIN_USABLE_PER_CELL = 5;
export const UNSTABLE_INFRA_ERRORS = 2;
export const DEFAULT_MAX_WALL_MS = 30 * 60 * 1000;
export const SENTINEL_PREFIX = "ORACLE-FILES-";
export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;
export const DEFAULT_SOURCE_SHA = "0d912a415cd1436c6daa17063bed2781663d88d5";

export const PROFILE_IDS = Object.freeze(["full", "core", "oracle-module"]);

export const CONTROLLED_LIMITS = Object.freeze([
  "Controlled same-prompt matrix: for one task every profile uses the byte-identical prompt/fixture/expectation, and the only difference is the runtime operator profile. This is a repeated live characterization, not a statistical population sample.",
  "`oracle-module` is a per-task ORACLE upper bound (operator profile `custom` = exactly expectedTools ∪ alternativeTools). It is not deployable autonomous discovery and it does not propose a shipping default profile.",
  "`core` is the existing static 6-tool profile; a missing-tool cell is an observed failure, not a harness error.",
  "The installed bridge is a custom user extension that eagerly registers the profile's visible MCP tools; it is not provider-native deferred loading. Native Pi provider auto-defer/tool-search remains unknown.",
  "The nested Pi host runs with -nbt (no built-in tools); only bridge tools are callable, and no session/context/skills/prompt-template/extension other than the bridge is loaded.",
  "Requested provider/model is the configured --provider/--model alias, not provider-attested identity. Catalog byte totals are the server's serialized tools/list per snapshot; provider request-payload tokens were NOT measured (`UNMEASURED`).",
  "OBSIDIAN_READ_ONLY is not a blanket execution gate. The per-run guard is a post-hoc readOnlyHint assertion; one direct write_note probe is expected to be denied and to create no file.",
  "The missing-tool sentinel is a random scratch-only canary in the vault copy of Attachments/diagram.svg. It is never written to the artifact; only its sha256/length are recorded.",
  "No production Vault, production server, Web UI, global credential file, browser, or messaging surface was read or written.",
  "Success evidence is a proxy: a call counts as evidence by tool-class membership (expectedTools ∪ declared alternativeTools) plus non-error status. The harness does not assert that the result payload contains the answer, so a success is not a general-task-success claim beyond that boundary.",
  "Auth conditions are equivalent, not byte-identical: each isolated trial uses a fresh random ephemeral key (all-scope principal) and a fresh loopback server, so the granted principal is controlled while the key bytes are per-trial.",
]);

// ---------------------------------------------------------------------------
// Pure, side-effect-free helpers (unit-tested).
// ---------------------------------------------------------------------------

export function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function generateSentinel(bytes = 6) {
  return SENTINEL_PREFIX + randomBytes(bytes).toString("hex");
}

export function resolveExpect(task, sentinel) {
  return String(task.expect ?? "").replaceAll("{{SENTINEL}}", sentinel ?? "");
}

export function hasSentinelTemplate(task) {
  return String(task.expect ?? "").includes("{{SENTINEL}}");
}

/** Fold the per-task oracle: expected ∪ declared alternatives, filtered to the
 * live catalog so a task fixture naming a tool that does not exist fails the
 * catalog-membership test instead of silently widening to `full`. */
export function oracleToolsForTask(task, catalogNames) {
  const allowed = new Set(catalogNames);
  const union = [...new Set([...(task.expectedTools ?? []), ...(task.alternativeTools ?? [])])];
  const missing = union.filter((name) => !allowed.has(name));
  return { tools: union.filter((name) => allowed.has(name)).sort(), missing };
}

export function operatorEnvForCell(profile, task, catalogNames) {
  if (profile === "full") return { profile: "full", toolsets: [], tools: [] };
  if (profile === "core") return { profile: "core", toolsets: [], tools: [] };
  const { tools } = oracleToolsForTask(task, catalogNames);
  return { profile: "custom", toolsets: [], tools };
}

/** Deterministic, pre-registered balanced schedule. Trial-major; the profile
 * order rotates by task index and trial index so no profile is systematically
 * early/late and every (task, profile) gets exactly `trials` entries. */
export function buildSchedule(tasks, profiles = PROFILE_IDS, trials = TRIALS_PER_CELL) {
  const schedule = [];
  for (let trial = 0; trial < trials; trial += 1) {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const rotation = (taskIndex + trial) % profiles.length;
      for (let slot = 0; slot < profiles.length; slot += 1) {
        const profile = profiles[(rotation + slot) % profiles.length];
        schedule.push({ taskId: tasks[taskIndex].id, profile, trial });
      }
    }
  }
  return schedule;
}

export function scheduleDigest(schedule) {
  return sha256Hex(JSON.stringify(schedule));
}

export function classifyToolCall(name, { expectedTools = [], alternativeTools = [] } = {}) {
  const raw = normalizeToolName(name);
  if (expectedTools.includes(raw)) return "expected";
  if (alternativeTools.includes(raw)) return "declared_alternative";
  return "unexpected";
}

export function summarizeControlledTrace(records, { readOnlyNames = [], visibleNames = [], expectedTools = [], alternativeTools = [] } = {}) {
  const readOnly = new Set(readOnlyNames.map(normalizeToolName));
  const visible = new Set(visibleNames.map(normalizeToolName));
  const announced = new Set();
  const starts = new Map();
  const executed = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (record.type === "message_start" || record.type === "message_update") {
      const tools = record.message?.sections?.tools;
      if (typeof tools === "string") {
        for (const match of tools.matchAll(/- (mcp_obsidian_[A-Za-z0-9_]+):/g)) announced.add(match[1]);
      }
    }
    if (record.type === "tool_execution_start" && typeof record.toolName === "string") {
      starts.set(record.toolCallId, record.toolName);
      executed.push({ toolCallId: record.toolCallId, name: record.toolName });
    }
    if (record.type === "tool_execution_end" && typeof record.toolName === "string") {
      const entry = executed.find((call) => call.toolCallId === record.toolCallId) || executed.at(-1);
      if (entry) {
        entry.isError = record.result?.isError === true || record.isError === true;
        entry.ended = true;
      }
    }
  }
  const calls = executed.map((call) => {
    const cls = classifyToolCall(call.name, { expectedTools, alternativeTools });
    const raw = normalizeToolName(call.name);
    return {
      name: raw,
      class: cls,
      isError: call.isError === true,
      hiddenDenied: call.isError === true && !visible.has(raw),
      readOnly: readOnly.has(raw),
    };
  });
  const mutationCalls = calls.filter((call) => !call.readOnly && !call.hiddenDenied).map((call) => call.name);
  const deniedCalls = calls.filter((call) => call.isError).map((call) => call.name);
  const unexpectedCalls = calls.filter((call) => call.class === "unexpected").map((call) => call.name);
  const evidenceCall = calls.some((call) => (call.class === "expected" || call.class === "declared_alternative") && !call.isError);
  return {
    announcedToolCount: announced.size,
    announcedNames: [...announced].sort(),
    announcedSample: [...announced].sort().slice(0, 5),
    executedCalls: calls,
    executedToolCallCount: calls.length,
    evidenceCall,
    expectedCallCount: calls.filter((call) => call.class === "expected").length,
    declaredAlternativeCallCount: calls.filter((call) => call.class === "declared_alternative").length,
    unexpectedCalls,
    deniedCalls,
    mutationCalls,
    readOnlyGuardPassed: mutationCalls.length === 0,
  };
}

/** A validated success needs an exact normalized answer AND a real executed call
 * in expected ∪ declared alternatives. An unrelated call cannot stand in. */
export function evaluateControlledTask({ answer, expect, trace }) {
  const answerMatch = answerMatchesExpect(answer, expect);
  const evidenceCall = trace.evidenceCall === true && trace.executedToolCallCount > 0;
  return {
    answerMatch,
    evidenceCall,
    success: answerMatch && evidenceCall,
    successRule: "exact normalized answer AND >=1 executed call in expectedTools ∪ alternativeTools",
  };
}

/** A cell is unstable when infrastructure errors reach the threshold. A cell
 * with fewer than `minUsable` usable trials cannot support a comparison. */
export function summarizeCellTrials(trials, { minUsable = MIN_USABLE_PER_CELL, unstableInfraErrors = UNSTABLE_INFRA_ERRORS } = {}) {
  const usable = trials.filter((trial) => ["ok", "task_failed"].includes(trial.status));
  const infraErrors = trials.filter((trial) => ["host_error", "timeout", "blocked"].includes(trial.status)).length;
  const success = usable.filter((trial) => trial.success === true).length;
  return {
    executed: trials.length,
    usable: usable.length,
    success,
    // `answerMatches` is every usable trial whose final answer matched exactly.
    answerMatches: usable.filter((trial) => trial.answerMatch === true).length,
    // `answerOnly` is the honest no-evidence diagnostic: answer matched exactly
    // but no declared evidence call executed (e.g. links-backlinks-en/core).
    answerOnly: usable.filter((trial) => trial.answerMatch === true && trial.evidenceCall !== true).length,
    evidenceOnly: usable.filter((trial) => trial.evidenceCall === true && trial.answerMatch !== true).length,
    infraErrors,
    unstable: infraErrors >= unstableInfraErrors,
    comparable: usable.length >= minUsable && infraErrors < unstableInfraErrors,
    xOverN: `${success}/${usable.length}`,
  };
}

/** Recompute the derived summaries (cells / totals / control gate / cost) from
 * raw trial observations. Pure and side-effect free: it never changes any trial
 * observation, the source sha, or the dated provenance, so a renamed or added
 * diagnostic label can be regenerated without re-running the live batch. */
export function deriveControlledSummaries({
  trials = [],
  fixtureTasks = [],
  trialsPerCell = TRIALS_PER_CELL,
  plannedTrials = trials.length,
} = {}) {
  const grouped = new Map();
  for (const task of fixtureTasks) {
    for (const profile of PROFILE_IDS) grouped.set(`${task.id}|${profile}`, []);
  }
  for (const trial of trials) {
    const key = `${trial.taskId}|${trial.profile}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trial);
  }
  const cells = [];
  for (const [key, cellTrials] of grouped) {
    const [taskId, profile] = key.split("|");
    const task = fixtureTasks.find((entry) => entry.id === taskId);
    const summary = summarizeCellTrials(cellTrials);
    cells.push({ taskId, profile, coreCoverage: task?.coreCoverage ?? "unknown", planned: trialsPerCell, ...summary });
  }
  const byOutcome = {};
  for (const trial of trials) byOutcome[trial.status] = (byOutcome[trial.status] ?? 0) + 1;
  const costByProfile = new Map();
  for (const trial of trials) {
    if (!trial.catalogCount) continue;
    costByProfile.set(trial.profile, {
      profile: trial.profile,
      catalogCount: trial.catalogCount,
      readOnlyCount: trial.readOnlyCount,
      schemaBytes: trial.schemaBytes,
      descriptorBytesSum: trial.descriptorBytesSum,
      framingOk: trial.schemaBytes - trial.descriptorBytesSum === trial.catalogCount + 1,
      estimatedTokensCeilBytes4: Math.ceil(trial.schemaBytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN),
      providerPayloadTokens: "UNMEASURED",
    });
  }
  return {
    cells: cells.sort((a, b) => (a.taskId === b.taskId ? a.profile.localeCompare(b.profile) : a.taskId.localeCompare(b.taskId))),
    totals: {
      planned: plannedTrials,
      executed: trials.length,
      usable: trials.filter((trial) => ["ok", "task_failed"].includes(trial.status)).length,
      success: trials.filter((trial) => trial.success === true).length,
      infraErrors: trials.filter((trial) => ["host_error", "timeout", "blocked"].includes(trial.status)).length,
      byOutcome,
    },
    controlGate: {
      mutationCalls: trials.reduce((sum, trial) => sum + (trial.mutationCalls ?? []).length, 0),
      sentinelLeaks: trials.filter((trial) => isSentinelLeak(trial)).length,
      deniedCalls: trials.reduce((sum, trial) => sum + (trial.deniedCalls ?? []).length, 0),
    },
    costMetrics: [...costByProfile.values()].sort((a, b) => a.profile.localeCompare(b.profile)),
  };
}

export function isSentinelLeak(trial) {
  if (trial.sentinelInAnswer !== true) return false;
  // The files task legitimately returns the sentinel when the profile can read
  // the attachment; only the missing-tool profile (core) or any other task
  // returning it is a leak.
  if (trial.taskId === "files-read-zh" && trial.profile !== "core") return false;
  return true;
}

export function sentinelLeakTrials(trials) {
  return trials.filter(isSentinelLeak).map((trial) => ({ taskId: trial.taskId, profile: trial.profile, trial: trial.trial }));
}

export function redactSentinel(text, sentinel) {
  return sentinel ? String(text ?? "").split(sentinel).join("[SENTINEL]") : String(text ?? "");
}

// ---------------------------------------------------------------------------
// Runtime helpers.
// ---------------------------------------------------------------------------

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // best effort
  }
}

export function buildControlledServerEnv({ baseEnv, port, vault, data, apiKey, operator }) {
  return {
    ...baseEnv,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    MCP_PORT: String(port),
    VAULT_PATH: vault,
    DATA_PATH: data,
    API_KEY: apiKey,
    OAUTH_ENABLED: "false",
    EMBEDDING_PROVIDER: "disabled",
    GIT_ENABLED: "false",
    OBSIDIAN_READ_ONLY: "true",
    MCP_DISCOVERY_PROFILE: operator.profile,
    MCP_DISCOVERY_TOOLSETS: (operator.toolsets ?? []).join(","),
    MCP_DISCOVERY_TOOLS: (operator.tools ?? []).join(","),
    MCP_DISCOVERY_DENY_TOOLS: "",
  };
}

export async function withClient(port, apiKey, fn) {
  const { McpHttpClient } = await import("./tool-discovery-production-eval.mjs");
  const client = new McpHttpClient({ url: `http://127.0.0.1:${port}/mcp`, apiKey });
  const connected = await client.connect();
  if (!connected.ok) throw new Error(`connect failed: ${connected.kind ?? "unknown"}`);
  return fn(client);
}

export async function directCatalog(port, apiKey) {
  return withClient(port, apiKey, async (client) => {
    const listed = await client.listTools();
    if (!listed.ok) return { ok: false, kind: listed.kind ?? "list_failed" };
    const tools = listed.tools;
    const names = tools.map((tool) => tool.name).sort();
    const readOnlyNames = tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    const serialized = JSON.stringify(tools);
    const descriptorBytesSum = tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0);
    const schemaBytes = Buffer.byteLength(serialized);
    return {
      ok: true,
      count: names.length,
      names,
      readOnlyNames,
      schemaBytes,
      descriptorBytesSum,
      framingOk: schemaBytes - descriptorBytesSum === names.length + 1,
      catalogDigest: sha256Hex(serialized),
    };
  });
}

export async function mutationGuardProbe(port, apiKey, vault) {
  const target = path.join(vault, "Guard", "Probe.md");
  return withClient(port, apiKey, async (client) => {
    const result = await client.callTool("write_note", { path: "Guard/Probe.md", content: "guard-probe" });
    const { existsSync } = await import("node:fs");
    return {
      tool: "write_note",
      attempted: true,
      denied: result?.kind === "result" ? result.result?.isError === true : true,
      fileCreated: existsSync(target),
    };
  });
}

export async function runNestedPi({ piCli, extensionPath, url, apiKey, prompt, cwd, timeoutMs }) {
  const args = buildPiArgs({ piCli, extensionPath, provider: PROVIDER, model: MODEL, prompt });
  // The bridge reads OBSIDIAN_MCP_API_KEY at extension load and hard-throws when
  // it is absent, so a missing-env child must not inherit a stray value.
  const env = { ...process.env, OBSIDIAN_MCP_URL: url };
  if (apiKey) env.OBSIDIAN_MCP_API_KEY = apiKey;
  else delete env.OBSIDIAN_MCP_API_KEY;
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const started = Date.now();
  let finished = false;
  let settleTimer = null;
  const outcome = await new Promise((resolve) => {
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      killTree(child);
      resolve(value);
    };
    const hardTimer = setTimeout(() => finish({ code: null, timedOut: true, settled: false }), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"type":"agent_end"')) finish({ code: 0, timedOut: false, settled: true });
      else if (!settleTimer && stdout.includes('"type":"agent_settled"')) {
        settleTimer = setTimeout(() => finish({ code: 0, timedOut: false, settled: true }), 1200);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => finish({ code, timedOut: false, settled: stdout.includes('"type":"agent_settled"') }));
    child.on("error", () => finish({ code: null, timedOut: false, settled: false }));
  });
  return { stdout, stderr, latencyMs: Date.now() - started, ...outcome };
}

export function extractFinalText(records) {
  let text = "";
  for (const record of records) {
    if (record?.type === "message_end" && record.message?.role === "assistant") {
      for (const block of record.message.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") text = block.text;
      }
    }
  }
  return text.trim();
}

async function runTrial({ task, profile, trialIndex, tempRoot, extensionPath, piCli, timeoutMs, sentinel, catalogNames }) {
  const vault = path.join(tempRoot, `vault-${task.id}-${profile}-${trialIndex}`);
  const data = path.join(tempRoot, `data-${task.id}-${profile}-${trialIndex}`);
  await cp(path.join(FIXTURE_DIR, "vault"), vault, { recursive: true });
  await cp(path.join(FIXTURE_DIR, "data"), data, { recursive: true });
  const svgPath = path.join(vault, "Attachments", "diagram.svg");
  const svg = await readFile(svgPath, "utf8");
  await writeFile(svgPath, svg.replaceAll("{{SENTINEL}}", sentinel), "utf8");

  const expect = resolveExpect(task, sentinel);
  const operator = operatorEnvForCell(profile, task, catalogNames);
  const apiKey = generateEphemeralKey();
  const port = await freePort();
  const serverChild = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: buildControlledServerEnv({ baseEnv: process.env, port, vault, data, apiKey, operator }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  serverChild.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
  serverChild.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));

  const base = {
    taskId: task.id,
    anchorTaskId: task.anchorTaskId,
    category: task.category,
    coreCoverage: task.coreCoverage,
    profile,
    operatorProfile: operator.profile,
    oracleTools: operator.profile === "custom" ? operator.tools : [],
    trial: trialIndex,
    expectSha256: sha256Hex(expect),
    promptSha256: sha256Hex(task.prompt),
    status: "unknown",
  };

  try {
    if (!(await waitForHealth(port, 20000))) {
      return { ...base, status: "blocked", reason: "scratch server did not become healthy", serverLogTail: redactSentinel(scrubText(serverLog.join("").slice(-400), apiKey), sentinel) };
    }
    const catalog = await directCatalog(port, apiKey);
    if (!catalog.ok) return { ...base, status: "blocked", reason: `tools/list failed (${catalog.kind})` };
    const url = `http://127.0.0.1:${port}/mcp`;
    const pi = await runNestedPi({ piCli, extensionPath, url, apiKey, prompt: task.prompt, cwd: tempRoot, timeoutMs });
    const records = parsePiRecords(scrubText(pi.stdout, apiKey));
    const trace = summarizeControlledTrace(records, {
      readOnlyNames: catalog.readOnlyNames,
      visibleNames: catalog.names,
      expectedTools: task.expectedTools,
      alternativeTools: task.alternativeTools,
    });
    const answer = scrubText(extractFinalText(records), apiKey);
    const evaluation = evaluateControlledTask({ answer, expect, trace });
    const status = pi.timedOut ? "timeout" : pi.settled ? (evaluation.success ? "ok" : "task_failed") : pi.code === 0 ? "task_failed" : "host_error";
    const sentinelInAnswer = sentinel ? answer.includes(sentinel) : false;
    return {
      ...base,
      status,
      catalogCount: catalog.count,
      readOnlyCount: catalog.readOnlyNames.length,
      schemaBytes: catalog.schemaBytes,
      descriptorBytesSum: catalog.descriptorBytesSum,
      announcedToolCount: trace.announcedToolCount,
      executedToolCallCount: trace.executedToolCallCount,
      executedCalls: trace.executedCalls,
      evidenceCall: evaluation.evidenceCall,
      answerMatch: evaluation.answerMatch,
      success: evaluation.success,
      answerSha256: sha256Hex(answer),
      answerLength: answer.length,
      answerText: hasSentinelTemplate(task) ? null : redactSentinel(answer, sentinel),
      sentinelInAnswer,
      unexpectedCalls: trace.unexpectedCalls,
      deniedCalls: trace.deniedCalls,
      mutationCalls: trace.mutationCalls,
      readOnlyGuardPassed: trace.readOnlyGuardPassed,
      latencyMs: pi.latencyMs,
      hostExitCode: pi.code,
      hostTimeout: pi.timedOut,
      hostSettled: pi.settled === true,
      stderrSummary: redactSentinel(scrubText(pi.stderr, apiKey), sentinel).slice(0, 240),
    };
  } finally {
    killTree(serverChild);
  }
}

// ---------------------------------------------------------------------------
// Report rendering + verification.
// ---------------------------------------------------------------------------

export const CONTROLLED_POLICY = Object.freeze({
  success: "exact normalized answer AND >=1 actually executed MCP call in expectedTools ∪ alternativeTools",
  evidenceBearing: "tool-class membership (expectedTools ∪ alternativeTools) AND non-error; result-payload causality with the answer is NOT asserted",
  readOnlyGuard: "post-hoc assertion that every host call is in the profile's readOnlyHint:true set (not a blanket execution gate)",
  sentinel: "random scratch-only canary in the vault copy of Attachments/diagram.svg; artifact stores sha256/length only",
  providerPayloadTokens: "UNMEASURED (no provider request-payload tokenizer was run)",
  oracleModule: "per-task oracle upper bound (custom profile = expectedTools ∪ alternativeTools); not deployable autonomous discovery",
});

export function renderControlledMarkdown(report) {
  const lines = [];
  lines.push("# Phase 3-B controlled eager-bridge matrix (candidate)");
  lines.push("");
  lines.push("Generated by `app/scripts/host-controlled-matrix.mjs`. Isolated scratch servers, loopback, read-only, ephemeral in-memory keys.");
  lines.push("");
  lines.push(`- schema: \`${report.schemaVersion}\`; status: \`${report.run.status}\``);
  lines.push(`- source sha: \`${report.source.sha}\`; branch: \`${report.source.branch}\``);
  lines.push(`- requested provider/model: \`${report.host.requestedProvider}/${report.host.requestedModel}\` (configured alias, not provider-attested identity)`);
  lines.push(`- pi: \`${report.host.piCliVersion ?? "unknown"}\`; node: \`${report.host.nodeVersion}\``);
  lines.push(`- bridge sha256: \`${report.host.bridgeSha256}\` (${report.host.bridgeBytes} bytes)`);
  lines.push(`- schedule sha256: \`${report.schedule.sha256}\`; trials/cell: ${report.schedule.trialsPerCell}`);
  lines.push(`- sentinel sha256: \`${report.fixture.sentinelSha256}\` (length ${report.fixture.sentinelLength})`);
  lines.push("");
  lines.push("## Results by cell");
  lines.push("");
  lines.push("| task | profile | coverage | planned | executed | usable | success x/n | infra errors | unstable | comparable |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cell of report.cells) {
    lines.push(
      `| ${cell.taskId} | ${cell.profile} | ${cell.coreCoverage} | ${cell.planned} | ${cell.executed} | ${cell.usable} | ${cell.xOverN} | ${cell.infraErrors} | ${cell.unstable ? "yes" : "no"} | ${cell.comparable ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push(`Totals: planned ${report.totals.planned}, executed ${report.totals.executed}, usable ${report.totals.usable}, success ${report.totals.success}, infra errors ${report.totals.infraErrors}.`);
  lines.push("");
  lines.push("A cell success is counted only for `status` in {ok, task_failed} with an exact-answer-plus-evidence-call pass. A missing-tool cell is an observed failure.");
  lines.push("");
  lines.push("## Catalog and cost");
  lines.push("");
  lines.push("| profile | tools | read-only | schema bytes | descriptor bytes (sum) | framing ok | ceil(bytes/4) | provider payload tokens |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cost of report.costMetrics) {
    lines.push(
      `| ${cost.profile} | ${cost.catalogCount} | ${cost.readOnlyCount} | ${cost.schemaBytes} | ${cost.descriptorBytesSum} | ${cost.framingOk ? "yes" : "no"} | ${cost.estimatedTokensCeilBytes4} | ${cost.providerPayloadTokens} |`,
    );
  }
  lines.push("");
  lines.push("`ceil(bytes/4)` is a coarse byte/4 estimate, NOT a tokenizer result. `provider payload tokens` is `UNMEASURED` and is never derived from catalog bytes.");
  lines.push("");
  lines.push("## Control gate");
  lines.push("");
  lines.push(`- mutation/non-read-only host calls: ${report.controlGate.mutationCalls}`);
  lines.push(`- sentinel leaks: ${report.controlGate.sentinelLeaks}`);
  lines.push(`- denied host calls: ${report.controlGate.deniedCalls}`);
  lines.push(`- aborted: ${report.controlGate.aborted}${report.controlGate.reason ? ` (${report.controlGate.reason})` : ""}`);
  lines.push(`- direct write_note guard probe: ${report.mutationGuard ? `denied=${report.mutationGuard.denied}, fileCreated=${report.mutationGuard.fileCreated}` : "not run"}`);
  lines.push("");
  lines.push("## Reduced-scope negative");
  lines.push("");
  lines.push(`- status: \`${report.scopeNegative.status}\``);
  lines.push(`- note: ${report.scopeNegative.reason}`);
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  for (const limit of report.limits) lines.push(`- ${limit}`);
  lines.push("");
  return lines.join("\n");
}

export async function verifyControlledMatrixArtifacts({ outDir = DEFAULT_OUT_DIR } = {}) {
  const errors = [];
  let json;
  try {
    json = JSON.parse(await readFile(path.join(outDir, CONTROLLED_JSON), "utf8"));
  } catch {
    return { ok: false, errors: [`${CONTROLLED_JSON} missing or unreadable`] };
  }
  if (json.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion is not ${SCHEMA_VERSION}`);
  if (json.generatedBy !== AUTHOR) errors.push(`generatedBy is not ${AUTHOR}`);
  if (json.policy?.providerPayloadTokens !== CONTROLLED_POLICY.providerPayloadTokens) {
    errors.push("provider payload tokens label drifted");
  }
  for (const cell of json.cells ?? []) {
    const cellTrials = (json.trials ?? []).filter((trial) => trial.taskId === cell.taskId && trial.profile === cell.profile);
    if (cell.executed > cell.planned) errors.push(`${cell.taskId}/${cell.profile}: executed > planned`);
    if (cell.usable > cell.executed) errors.push(`${cell.taskId}/${cell.profile}: usable > executed`);
    if (cell.success > cell.usable) errors.push(`${cell.taskId}/${cell.profile}: success > usable`);
    if (cellTrials.length !== cell.executed) errors.push(`${cell.taskId}/${cell.profile}: trial count != executed`);
    if (cell.xOverN !== `${cell.success}/${cell.usable}`) errors.push(`${cell.taskId}/${cell.profile}: xOverN mismatch`);
  }
  for (const cost of json.costMetrics ?? []) {
    if (cost.schemaBytes - cost.descriptorBytesSum !== cost.catalogCount + 1) {
      errors.push(`${cost.profile}: schemaBytes framing relation broken`);
    }
    if (cost.providerPayloadTokens !== "UNMEASURED") errors.push(`${cost.profile}: provider payload tokens not UNMEASURED`);
  }
  if (json.controlGate && json.controlGate.mutationCalls > 0 && !json.controlGate.aborted) {
    errors.push("control gate: mutation calls recorded without abort");
  }
  try {
    const md = await readFile(path.join(outDir, CONTROLLED_MD), "utf8");
    const mismatch = generatedArtifactMismatch(md, `${renderControlledMarkdown(json)}\n`);
    if (mismatch) errors.push(`${CONTROLLED_MD}: ${mismatch}`);
  } catch {
    errors.push(`${CONTROLLED_MD} missing or unreadable`);
  }
  if (/ORACLE-FILES-[0-9a-f]{12}/.test(JSON.stringify(json))) errors.push("sentinel value leaked into the JSON artifact");
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Batch runner + CLI.
// ---------------------------------------------------------------------------

async function loadFixture() {
  const raw = await readFile(path.join(FIXTURE_DIR, "tasks.json"), "utf8");
  const fixture = JSON.parse(raw);
  const catalog = await (async () => {
    const { CAPABILITY_CATALOG } = await import("../src/capability-catalog.js");
    return CAPABILITY_CATALOG.map((entry) => entry.name);
  })();
  return { fixture, raw, catalog };
}

/** Regenerate only the derived summaries from the raw trial observations that
 * are already committed, preserving every trial, the frozen source sha, and the
 * original dated provenance (`generatedAt`, `run.startedAt`). Used to apply a
 * diagnostic rename without re-running the 90 live trials. */
export async function recomputeControlledMatrix({ outDir = DEFAULT_OUT_DIR } = {}) {
  const jsonPath = path.join(outDir, CONTROLLED_JSON);
  const json = JSON.parse(await readFile(jsonPath, "utf8"));
  const { fixture } = await loadFixture();
  const derived = deriveControlledSummaries({
    trials: json.trials ?? [],
    fixtureTasks: fixture.tasks,
    trialsPerCell: json.schedule?.trialsPerCell ?? TRIALS_PER_CELL,
    plannedTrials: json.totals?.planned ?? (json.trials ?? []).length,
  });
  const next = {
    ...json,
    cells: derived.cells,
    totals: derived.totals,
    controlGate: { ...derived.controlGate, aborted: json.controlGate?.aborted ?? false, reason: json.controlGate?.reason ?? null },
    costMetrics: derived.costMetrics,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, CONTROLLED_MD), `${renderControlledMarkdown(next)}\n`, "utf8");
  return { ok: true, recomputed: true, trials: next.trials.length, totals: next.totals };
}

export function validateFixture(fixture, catalogNames) {
  const errors = [];
  const ids = new Set();
  for (const task of fixture.tasks) {
    if (ids.has(task.id)) errors.push(`${task.id}: duplicate task id`);
    ids.add(task.id);
    if (!task.prompt || typeof task.prompt !== "string") errors.push(`${task.id}: missing prompt`);
    if (!task.expect || typeof task.expect !== "string") errors.push(`${task.id}: missing expect`);
    const { missing } = oracleToolsForTask(task, catalogNames);
    if (missing.length) errors.push(`${task.id}: tools not in catalog: ${missing.join(", ")}`);
    if (!(task.expectedTools ?? []).length) errors.push(`${task.id}: empty expectedTools`);
  }
  return errors;
}

export function parseArgs(argv) {
  const options = {
    mode: "run",
    outDir: DEFAULT_OUT_DIR,
    extension: DEFAULT_EXTENSION,
    pi: null,
    timeoutMs: 240000,
    maxWallMs: DEFAULT_MAX_WALL_MS,
    trials: TRIALS_PER_CELL,
    resume: false,
    keepTemp: false,
    filter: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--verify") options.mode = "verify";
    else if (arg === "--recompute") options.mode = "recompute";
    else if (arg === "--out-dir") options.outDir = path.resolve(next());
    else if (arg === "--extension") options.extension = next();
    else if (arg === "--pi") options.pi = next();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--max-wall-ms") options.maxWallMs = Number(next());
    else if (arg === "--trials") options.trials = Number(next());
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--filter") options.filter = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export async function piVersion(piCli) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [piCli, "--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").trim() || null));
    child.on("error", () => resolve(null));
  });
}

export async function gitInfo(cwd) {
  const { execFileSync } = await import("node:child_process");
  try {
    return {
      sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
      branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    };
  } catch {
    return { sha: DEFAULT_SOURCE_SHA, branch: "unknown" };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === "verify") {
    const result = await verifyControlledMatrixArtifacts({ outDir: options.outDir });
    return { ok: result.ok, errors: result.errors };
  }
  if (options.mode === "recompute") {
    return recomputeControlledMatrix({ outDir: options.outDir });
  }
  const piCli = options.pi ?? resolvePiCli();
  if (!piCli) throw new Error("Pi CLI not found; set PI_CLI or pass --pi <path-to-cli.js>");
  const { existsSync } = await import("node:fs");
  if (!existsSync(options.extension)) throw new Error(`Pi bridge extension not found: ${options.extension}`);

  const { fixture, raw } = await loadFixture();
  const { CAPABILITY_CATALOG } = await import("../src/capability-catalog.js");
  const catalogNames = CAPABILITY_CATALOG.map((entry) => entry.name);
  const fixtureErrors = validateFixture(fixture, catalogNames);
  if (fixtureErrors.length) throw new Error(`Invalid fixture: ${fixtureErrors.join("; ")}`);

  const bridgeText = await readFile(options.extension, "utf8");
  const sentinel = generateSentinel();
  const schedule = buildSchedule(fixture.tasks, PROFILE_IDS, options.trials).filter((entry) => {
    if (!options.filter) return true;
    const [taskId, profile] = options.filter.split(":");
    return (!taskId || entry.taskId === taskId) && (!profile || entry.profile === profile);
  });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "host-controlled-matrix-"));
  const started = Date.now();
  const git = await gitInfo(REPO_DIR);
  const baseReport = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: AUTHOR,
    generatedAt: new Date().toISOString(),
    run: { status: "partial", startedAt: new Date(started).toISOString(), maxWallMs: options.maxWallMs, elapsedMs: 0, completedTrials: 0, plannedTrials: schedule.length, aborted: false, abortReason: null },
    source: { sha: git.sha, branch: git.branch, requestedBase: DEFAULT_SOURCE_SHA },
    host: {
      requestedProvider: PROVIDER,
      requestedModel: MODEL,
      providerModelProvenance: "configured --provider/--model alias passed to the nested Pi process; not provider-attested identity and not a provider request-payload measurement",
      bridgePath: options.extension,
      bridgeSha256: sha256Hex(bridgeText),
      bridgeBytes: Buffer.byteLength(bridgeText),
      piCliVersion: await piVersion(piCli),
      nodeVersion: process.version,
    },
    fixture: {
      path: path.join(FIXTURE_DIR, "tasks.json"),
      sha256: sha256Hex(raw),
      taskCount: fixture.tasks.length,
      sentinelSha256: sha256Hex(sentinel),
      sentinelLength: sentinel.length,
      sentinelPolicy: "random scratch-only canary in the vault copy of Attachments/diagram.svg",
    },
    policy: CONTROLLED_POLICY,
    schedule: { sha256: scheduleDigest(schedule), trialsPerCell: options.trials, profiles: [...PROFILE_IDS], cellCount: fixture.tasks.length * PROFILE_IDS.length },
    mutationGuard: null,
    cells: [],
    totals: { planned: schedule.length, executed: 0, usable: 0, success: 0, infraErrors: 0, byOutcome: {} },
    controlGate: { mutationCalls: 0, sentinelLeaks: 0, deniedCalls: 0, aborted: false, reason: null },
    scopeNegative: {
      status: "blocked",
      reason: "configured-env API_KEY grants all MCP scopes; the installed bridge sends only X-API-Key and no isolated reduced-scope host credential path exists without OAuth-store seeding. Recorded blocked/unknown at the host layer, not fabricated.",
    },
    costMetrics: [],
    trials: [],
    limits: [...CONTROLLED_LIMITS],
  };

  const trials = [];
  const completedKeys = new Set();
  if (options.resume && existsSync(path.join(options.outDir, CONTROLLED_JSON))) {
    try {
      const prior = JSON.parse(await readFile(path.join(options.outDir, CONTROLLED_JSON), "utf8"));
      for (const trial of prior.trials ?? []) {
        // Sentinel-task trials are re-run so the final artifact carries one
        // sentinel generation; every other completed cell is preserved.
        if (trial.taskId === "files-read-zh") continue;
        trials.push(trial);
        completedKeys.add(`${trial.taskId}|${trial.profile}|${trial.trial}`);
      }
    } catch {
      // unreadable prior artifact: start fresh
    }
  }
  let aborted = false;
  let abortReason = null;
  let guard = null;

  const persist = async (status) => {
    const elapsedMs = Date.now() - started;
    const derived = deriveControlledSummaries({
      trials,
      fixtureTasks: fixture.tasks,
      trialsPerCell: options.trials,
      plannedTrials: schedule.length,
    });
    const report = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      run: { ...baseReport.run, status, elapsedMs, completedTrials: trials.length, aborted, abortReason },
      mutationGuard: guard,
      cells: derived.cells,
      totals: derived.totals,
      controlGate: { ...derived.controlGate, aborted, reason: abortReason },
      costMetrics: derived.costMetrics,
      trials,
    };
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, CONTROLLED_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(options.outDir, CONTROLLED_MD), `${renderControlledMarkdown(report)}\n`, "utf8");
    return report;
  };

  try {
    // One direct write_note guard probe on a transient full-profile server.
    const guardRoot = path.join(tempRoot, "guard");
    const guardVault = path.join(guardRoot, "vault");
    const guardData = path.join(guardRoot, "data");
    await cp(path.join(FIXTURE_DIR, "vault"), guardVault, { recursive: true });
    await mkdir(guardData, { recursive: true });
    const guardKey = generateEphemeralKey();
    const guardPort = await freePort();
    const guardServer = spawn(process.execPath, ["server.js"], {
      cwd: APP_DIR,
      env: buildControlledServerEnv({ baseEnv: process.env, port: guardPort, vault: guardVault, data: guardData, apiKey: guardKey, operator: { profile: "full", toolsets: [], tools: [] } }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      if (await waitForHealth(guardPort, 20000)) guard = await mutationGuardProbe(guardPort, guardKey, guardVault);
    } finally {
      killTree(guardServer);
    }

    for (const entry of schedule) {
      if (Date.now() - started > options.maxWallMs) {
        abortReason = "max wall time reached; remaining cells left incomplete (resume with --resume)";
        break;
      }
      if (aborted) break;
      if (completedKeys.has(`${entry.taskId}|${entry.profile}|${entry.trial}`)) continue;
      const task = fixture.tasks.find((item) => item.id === entry.taskId);
      const trial = await runTrial({
        task,
        profile: entry.profile,
        trialIndex: entry.trial,
        tempRoot,
        extensionPath: options.extension,
        piCli,
        timeoutMs: options.timeoutMs,
        sentinel,
        catalogNames,
      });
      trials.push(trial);
      const leaks = sentinelLeakTrials([trial]);
      if (leaks.length) {
        aborted = true;
        abortReason = `sentinel leak in ${trial.profile}/${trial.taskId} (missing-tool profile returned the scratch canary)`;
      }
      if ((trial.mutationCalls ?? []).length > 0) {
        aborted = true;
        abortReason = `non-read-only host call observed in ${trial.profile}/${trial.taskId}: ${trial.mutationCalls.join(", ")}`;
      }
      if (guard?.fileCreated) {
        aborted = true;
        abortReason = "direct write_note guard probe created a file";
      }
      await persist(aborted ? "aborted" : "partial");
    }
    const report = await persist(aborted ? "aborted" : "complete");
    return {
      ok: !aborted,
      status: report.run.status,
      outDir: options.outDir,
      completed: report.totals.executed,
      planned: report.totals.planned,
      success: report.totals.success,
      controlGate: report.controlGate,
      scopeNegative: report.scopeNegative.status,
    };
  } finally {
    if (!options.keepTemp) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`host-controlled-matrix: temp cleanup deferred (${error?.code || error?.message})\n`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      if (!summary.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`host-controlled-matrix failed: ${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
