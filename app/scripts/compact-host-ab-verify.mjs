#!/usr/bin/env node
// #598/#616 W3-B evidence gate: evaluate REAL host traces from an independent
// runner. It neither calls an LLM nor creates synthetic "successful" trials.
// Raw prompts, note bodies, tokens and credentials are forbidden in artifacts.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const W3B_SCHEMA_VERSION = "1.0.0";
export const W3B_CELLS = Object.freeze(["full-eager", "full-defer", "compact-eager", "compact-defer"]);
export const W3B_MIN_REPEATS = 3;
const DIGEST = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const TASK_KEYS = ["id", "promptSha256", "fixtureSha256", "expectedResultSha256"];
const TRIAL_KEYS = ["taskId", "cell", "repeat", "traceFile", "traceSha256"];
const TRACE_KEYS = [
  "taskId", "cell", "repeat", "fixtureSha256", "hostVersion", "modelId", "provenance",
  "status", "observedResultSha256", "wallMs", "inputTokens", "outputTokens",
  "descriptorTokens", "unauthorizedCalls", "unexpectedMutations", "calls",
];
const CALL_KEYS = ["tool", "action", "ok", "denied"];
const TERMINAL = new Set(["ok", "task_failed", "host_error", "unsupported"]);
const ALLOWED_PROFILES = new Set(W3B_CELLS);
const finiteInteger = (n) => Number.isSafeInteger(n) && n >= 0;
const text = (s) => typeof s === "string" && s.length > 0 && s.length <= 160;
const own = (o) => o && typeof o === "object" && !Array.isArray(o);
const exact = (o, keys) => own(o) && Object.keys(o).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(o, key));
const digest = (value) => typeof value === "string" && DIGEST.test(value);

function traceLocation(root, relative) {
  if (typeof relative !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.\/-]{0,180}$/.test(relative) ||
      relative.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw new Error("Unsafe traceFile: expected a bounded relative path");
  }
  const resolved = path.resolve(root, relative);
  const inside = path.relative(path.resolve(root), resolved);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("Trace file escapes evidence root");
  return resolved;
}

function inspectTrace(trace, trial, report, task, fail) {
  const key = trial.taskId + ":" + trial.cell + ":" + trial.repeat;
  if (!exact(trace, TRACE_KEYS)) return fail(key + ": trace fields missing/unknown (possible payload/secret leak)");
  if (trace.taskId !== trial.taskId || trace.cell !== trial.cell || trace.repeat !== trial.repeat ||
      trace.fixtureSha256 !== task.fixtureSha256) fail(key + ": trace identity/fixture mismatch");
  if (trace.hostVersion !== report.host.version || trace.modelId !== report.host.model ||
      trace.provenance !== "real-host") fail(key + ": trace provenance mismatch");
  if (!TERMINAL.has(trace.status)) fail(key + ": invalid terminal status");
  if (![trace.inputTokens, trace.outputTokens, trace.descriptorTokens, trace.wallMs,
        trace.unauthorizedCalls, trace.unexpectedMutations].every(finiteInteger)) fail(key + ": invalid counters");
  if (!Array.isArray(trace.calls) || trace.calls.length > 500) fail(key + ": call evidence missing/oversized");
  else for (const call of trace.calls) {
    if (!exact(call, CALL_KEYS) || !text(call.tool) ||
        !(call.action === null || text(call.action)) ||
        typeof call.ok !== "boolean" || typeof call.denied !== "boolean" ||
        (call.ok && call.denied)) fail(key + ": illegal call shape or secret field");
  }
  if (trace.status === "unsupported") {
    if (!trial.cell.endsWith("-defer") || report.host.deferSupported !== false) fail(key + ": unsupported without host defer blocker");
    if (trace.calls?.length || trace.wallMs !== 0 || trace.inputTokens !== 0 ||
        trace.outputTokens !== 0 || trace.descriptorTokens !== 0 ||
        trace.observedResultSha256 !== null) fail(key + ": unsupported cell falsely counted as measured");
  } else {
    if (!digest(trace.observedResultSha256) && trace.observedResultSha256 !== null) fail(key + ": invalid observed oracle hash");
    if (report.host.deferSupported === false && trial.cell.endsWith("-defer")) fail(key + ": claimed deferred run on unsupported host");
    if (trace.status === "ok" && trace.observedResultSha256 !== task.expectedResultSha256) fail(key + ": success is not confirmed by task oracle");
    if (trace.status !== "ok" && trace.observedResultSha256 === task.expectedResultSha256) fail(key + ": oracle matches but success marked false");
  }
  if (trace.unauthorizedCalls !== 0 || trace.unexpectedMutations !== 0) fail(key + ": security gate failed");
}

/** Returns explicit HOLD on absent/incomplete evidence; never invents runs. */
export async function verifyCompactHostAB(report, { evidenceRoot } = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!own(report) || !exact(report, ["schemaVersion", "source", "host", "tasks", "trials", "repeats"])) {
    return { ok: false, verdict: "HOLD", errors: ["Missing or extra top-level fields"], summary: null };
  }
  if (report.schemaVersion !== W3B_SCHEMA_VERSION) fail("Unsupported W3-B schema");
  if (!exact(report.source, ["commitSha", "serverVersion", "fixtureManifestSha256", "startedAt"]) ||
      !SHA.test(report.source.commitSha ?? "") || !text(report.source.serverVersion) ||
      !digest(report.source.fixtureManifestSha256) ||
      Number.isNaN(Date.parse(report.source.startedAt))) fail("Unpinned source/fixture/timestamp");
  if (!exact(report.host, ["name", "version", "model", "deferSupported"]) ||
      !text(report.host.name) || !text(report.host.version) || !text(report.host.model) ||
      typeof report.host.deferSupported !== "boolean") fail("Missing host identity/defer capability");
  if (!finiteInteger(report.repeats) || report.repeats < W3B_MIN_REPEATS || report.repeats > 50) fail("Repetitions < 3 or > 50");
  if (!Array.isArray(report.tasks) || !report.tasks.length || report.tasks.length > 30 ||
      report.tasks.some((task) => !exact(task, TASK_KEYS) || !text(task.id) ||
        !digest(task.promptSha256) || !digest(task.fixtureSha256) || !digest(task.expectedResultSha256))) fail("Missing/unsafe tasks");
  if (Array.isArray(report.tasks) &&
      createHash("sha256").update(JSON.stringify(report.tasks)).digest("hex") !== report.source?.fixtureManifestSha256) {
    fail("Task manifest SHA-256 does not match pinned source");
  }
  const tasks = new Map((Array.isArray(report.tasks) ? report.tasks : []).map((item) => [item?.id, item]));
  if (tasks.size !== report.tasks?.length) fail("Duplicate tasks");
  const slots = new Set();
  const stats = Object.fromEntries(W3B_CELLS.map((id) => [id, { observed: 0, usable: 0, success: 0, unsupported: 0, infra: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, descriptorTokens: 0 }]));
  const root = evidenceRoot && path.resolve(evidenceRoot);
  if (!root) fail("Missing evidenceRoot");
  const trustedRoot = root ? await realpath(root).catch(() => null) : null;
  if (root && !trustedRoot) fail("Evidence root unavailable");
  if (!Array.isArray(report.trials)) fail("Missing trial inventory");
  else for (const trial of report.trials) {
    if (!exact(trial, TRIAL_KEYS) || !tasks.has(trial.taskId) ||
        !ALLOWED_PROFILES.has(trial.cell) || !finiteInteger(trial.repeat) ||
        trial.repeat >= report.repeats || !digest(trial.traceSha256)) {
      fail("Invalid trial row"); continue;
    }
    const key = trial.taskId + ":" + trial.cell + ":" + trial.repeat;
    if (slots.has(key)) { fail("Duplicate trial " + key); continue; }
    slots.add(key);
    let raw;
    try {
      const candidate = traceLocation(root, trial.traceFile);
      const actual = await realpath(candidate);
      const inside = path.relative(trustedRoot, actual);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("trace symlink escapes root");
      raw = await readFile(actual);
    } catch (error) {
      fail(key + ": missing/unsafe trace (" + (error?.code || "invalid") + ")"); continue;
    }
    if (raw.length > 128 * 1024) { fail(key + ": trace too large"); continue; }
    if (createHash("sha256").update(raw).digest("hex") !== trial.traceSha256) {
      fail(key + ": SHA-256 mismatch"); continue;
    }
    let trace;
    try { trace = JSON.parse(raw); } catch { fail(key + ": malformed JSON trace"); continue; }
    if (!own(trace)) { fail(key + ": trace must be an object"); continue; }
    inspectTrace(trace, trial, report, tasks.get(trial.taskId), fail);
    const stat = stats[trial.cell];
    stat.observed += 1;
    if (trace.status === "unsupported") { stat.unsupported += 1; continue; }
    if (trace.status === "host_error") { stat.infra += 1; continue; }
    stat.usable += 1;
    if (trace.status === "ok") stat.success += 1;
    for (const field of ["wallMs", "inputTokens", "outputTokens", "descriptorTokens"]) {
      if (finiteInteger(trace[field])) stat[field] += trace[field];
    }
  }
  if (tasks.size && finiteInteger(report.repeats)) {
    for (const task of tasks.keys()) for (const cell of W3B_CELLS) for (let i = 0; i < report.repeats; i++) {
      if (!slots.has(task + ":" + cell + ":" + i)) fail("Missing trial " + task + ":" + cell + ":" + i);
    }
  }
  for (const [name, stat] of Object.entries(stats)) {
    if (stat.usable === 0 && !(name.endsWith("-defer") && report.host.deferSupported === false)) {
      fail("No usable trials for " + name);
    }
  }
  return { ok: errors.length === 0, verdict: errors.length ? "HOLD" : "EVIDENCE_VALID_PENDING_W3_GO", errors, summary: stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportFile = process.argv[2];
  if (!reportFile) {
    process.stderr.write("Usage: node scripts/compact-host-ab-verify.mjs <report.json>\n");
    process.exitCode = 2;
  } else {
    try {
      const file = path.resolve(reportFile);
      const report = JSON.parse(await readFile(file, "utf8"));
      const result = await verifyCompactHostAB(report, { evidenceRoot: path.dirname(file) });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (!result.ok) process.exitCode = 1;
    } catch {
      process.stderr.write("W3-B evidence report not readable or invalid\n");
      process.exitCode = 1;
    }
  }
}
