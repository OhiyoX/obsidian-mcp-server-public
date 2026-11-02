#!/usr/bin/env node
// Phase 3-B isolated OAuth-managed-key host scope submatrix (read-only).
//
// This closes the reduced-scope host gap that the main controlled matrix recorded
// `blocked`: instead of the fixed all-scope configured-env API_KEY, it seeds a
// managed API key with an explicit scope set through the existing
// `createOAuthService()` provider in an isolated `DATA_PATH`, runs an
// OAUTH-enabled isolated loopback server, and drives the real installed Pi host
// through the user's eager Obsidian MCP bridge. The secret lives in memory only
// and is injected per child via `OBSIDIAN_MCP_API_KEY`; only the provider's
// hashed record is persisted in the isolated temporary `DATA_PATH`.
//
// Cells (same byte-identical `files-read-zh` prompt/profile/fixture per trial):
//   files-allowed        read + files scope; file tool advertised; sentinel returned with a real call
//   files-missing-scope  read-only scope; server + bridge announce a filtered catalog (no file tools),
//                        sentinel never returned, no unauthorized tool advertised
//   invalid-credential   invalid key; the bridge reaches the loopback server and is rejected 401
//   missing-env-key      OBSIDIAN_MCP_API_KEY absent; bridge hard-throws at load, server never reached
//   zeroScope            createApiKey([]) normalizes to all scopes -> unconstructible, recorded blocked
//
// Hygiene: no production URL/Vault/server, no global Pi config change, no server
// source/runtime change, no plaintext secret in files/argv/logs/artifact, all owned
// children stopped, read-only scratch servers.

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatedArtifactMismatch } from "./artifact-text.mjs";
import {
  APP_DIR,
  DEFAULT_EXTENSION,
  DEFAULT_OUT_DIR,
  FIXTURE_DIR,
  REPO_DIR,
  directCatalog,
  freePort,
  generateSentinel as generateBaseSentinel,
  gitInfo,
  killTree,
  piVersion,
  resolveExpect,
  runNestedPi,
  sha256Hex,
  summarizeControlledTrace,
  waitForHealth,
  withClient,
} from "./host-controlled-matrix.mjs";
import {
  answerMatchesExpect,
  generateEphemeralKey,
  normalizeToolName,
  parsePiRecords,
  resolvePiCli,
  scrubText,
} from "./host-bridge-evidence.mjs";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SCOPE_SCHEMA_VERSION = "1.0.0";
export const SCOPE_AUTHOR = "app/scripts/host-scope-matrix.mjs";
export const SCOPE_JSON = "scope-matrix.json";
export const SCOPE_MD = "scope-matrix.md";
export const SCOPE_TASK_ID = "files-read-zh";
export const SCOPE_TRIALS_PER_CELL = 5;
export const SCOPE_MAX_WALL_MS = 15 * 60 * 1000;
export const SCOPE_SENTINEL_PREFIX = "ORACLE-SCOPE-";
export const SCOPE_PROVIDER = "opencode-go";
export const SCOPE_MODEL = "deepseek-v4.1-flash";
export const SCOPE_TRANSPORT_ONLY_LABEL = "transport-only direct HTTP assertion; this is not host evidence";

export const SCOPE_READ_FILES = Object.freeze(["obsidian.read", "obsidian.files"]);
export const SCOPE_READ_ONLY = Object.freeze(["obsidian.read"]);

export const SCOPE_CELLS = Object.freeze([
  Object.freeze({
    id: "files-allowed",
    kind: "positive",
    credential: "managed",
    scopes: SCOPE_READ_FILES,
    description: "OAUTH-managed key with obsidian.read + obsidian.files; file tool advertised and sentinel returned with an executed call.",
  }),
  Object.freeze({
    id: "files-missing-scope",
    kind: "missing_scope",
    credential: "managed",
    scopes: SCOPE_READ_ONLY,
    description: "OAUTH-managed key with obsidian.read only; file tools filtered from the catalog and the sentinel never returned.",
  }),
  Object.freeze({
    id: "invalid-credential",
    kind: "invalid",
    credential: "invalid",
    scopes: null,
    description: "Unmanaged invalid key; the bridge reaches the isolated server and receives 401 (host init failure after a real request).",
  }),
  Object.freeze({
    id: "missing-env-key",
    kind: "missing_env",
    credential: "missing",
    scopes: null,
    description: "OBSIDIAN_MCP_API_KEY absent; the bridge hard-throws at extension load, so the server is never reached.",
  }),
]);

/** Tools whose scope requirement includes `obsidian.files`, derived from the real
 * server scope registry so the filter check cannot silently drift. */
export const FILE_REQUIRED_TOOLS = Object.freeze(
  Object.entries(MCP_TOOL_SCOPE_REQUIREMENTS)
    .filter(([, requirements]) => requirements.includes("obsidian.files"))
    .map(([name]) => name)
    .sort(),
);

export const SCOPE_LIMITS = Object.freeze([
  "This is a bounded isolated host submatrix, separate from the 90-trial controlled matrix. It does not change any controlled-matrix success count, source sha, or dated provenance.",
  "Auth is an OAUTH-managed API key seeded through the existing provider; the plaintext secret is memory-only and injected per child via spawn env. Only the provider's hashed record is persisted, in the isolated temporary DATA_PATH.",
  "`files-allowed` and `files-missing-scope` reuse the byte-identical `files-read-zh` prompt/profile/fixture with a fresh random sentinel in the vault copy of Attachments/diagram.svg. The sentinel value is never written to the artifact.",
  "The `files-missing-scope` catalog filtering is proven on the real Pi -> eager bridge -> isolated server chain (announced tools) plus a server-side scoped tools/list; the direct get_file 403 is labelled transport-only.",
  "`invalid-credential` is only recorded when the isolated server observed the request (audit rejection); `missing-env-key` is a host init failure with zero server requests, not a server 401.",
  "A true zero-scope key is unconstructible: createApiKey([]) normalizes to all MCP scopes. The zeroScope cell is recorded blocked and is never replaced with an invalid credential or faked as a PASS.",
  "No native Pi deferral/tool-search/http://127.0.0.1 server behavior beyond this isolated loopback case is claimed; provider payload tokens are UNMEASURED.",
]);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

export function generateScopeSentinel(bytes = 6) {
  const base = generateBaseSentinel(bytes);
  return base.replace("ORACLE-FILES-", SCOPE_SENTINEL_PREFIX);
}

export function buildScopeSchedule(cells = SCOPE_CELLS, trials = SCOPE_TRIALS_PER_CELL) {
  const schedule = [];
  for (let trial = 0; trial < trials; trial += 1) {
    for (const cell of cells) {
      schedule.push({ cell: cell.id, kind: cell.kind, trial });
    }
  }
  return schedule;
}

export function normalizeCatalogNames(names = []) {
  return names.map((name) => normalizeToolName(name));
}

export function announcedFileTools(announcedNames = []) {
  const files = new Set(FILE_REQUIRED_TOOLS);
  return normalizeCatalogNames(announcedNames)
    .filter((name) => files.has(name))
    .sort();
}

export function advertisedFileTools(catalogNames = []) {
  const files = new Set(FILE_REQUIRED_TOOLS);
  return normalizeCatalogNames(catalogNames)
    .filter((name) => files.has(name))
    .sort();
}

/** Sentinel leak for the scope design: only the files-allowed positive may
 * legitimately return the scratch sentinel; any other cell returning it is a leak. */
export function isScopeSentinelLeak(trial) {
  return trial.sentinelInAnswer === true && trial.cell !== "files-allowed";
}

export function evaluateScopeTask({ answer, expect, trace }) {
  const answerMatch = answerMatchesExpect(answer, expect);
  const evidenceCall = trace.evidenceCall === true && trace.executedToolCallCount > 0;
  return {
    answerMatch,
    evidenceCall,
    success: answerMatch && evidenceCall,
    successRule: "exact normalized answer AND >=1 executed call in expectedTools ∪ alternativeTools",
  };
}

export function summarizeScopeCell(trials, cell) {
  const usable = trials.filter((trial) => ["ok", "task_failed"].includes(trial.status));
  const success = usable.filter((trial) => trial.success === true).length;
  return {
    cell: cell.id,
    kind: cell.kind,
    credential: cell.credential,
    scopes: cell.scopes ? [...cell.scopes] : null,
    planned: trials.length,
    executed: trials.length,
    usable: usable.length,
    success,
    xOverN: `${success}/${usable.length}`,
    infraErrors: trials.filter((trial) => ["host_error", "timeout", "blocked"].includes(trial.status)).length,
    sentinelLeaks: trials.filter((trial) => isScopeSentinelLeak(trial)).length,
    retrievalTrials: trials.filter((trial) => trial.evidenceCall === true && trial.sentinelInAnswer === true).length,
    announcedFileToolTrials: trials.filter((trial) => (trial.announcedFileTools ?? []).length > 0).length,
    serverSawRequestTrials: trials.filter((trial) => trial.serverSawRequest === true).length,
    description: cell.description,
  };
}

export function renderScopeMarkdown(report) {
  const lines = [];
  lines.push("# Phase 3-B isolated OAuth-managed-key scope submatrix (candidate)");
  lines.push("");
  lines.push("Generated by `app/scripts/host-scope-matrix.mjs`. Isolated OAUTH-enabled loopback servers with seeded managed keys, read-only, memory-only secrets.");
  lines.push("");
  lines.push(`- schema: \`${report.schemaVersion}\`; status: \`${report.run.status}\``);
  lines.push(`- source sha: \`${report.source.sha}\`; branch: \`${report.source.branch}\``);
  lines.push(`- requested provider/model: \`${report.host.requestedProvider}/${report.host.requestedModel}\` (configured alias, not provider-attested identity)`);
  lines.push(`- pi: \`${report.host.piCliVersion ?? "unknown"}\`; node: \`${report.host.nodeVersion}\``);
  lines.push(`- bridge sha256: \`${report.host.bridgeSha256}\` (${report.host.bridgeBytes} bytes)`);
  lines.push(`- task: \`${report.fixture.taskId}\`; prompt sha256: \`${report.fixture.promptSha256}\``);
  lines.push(`- sentinel sha256: \`${report.fixture.sentinelSha256}\` (length ${report.fixture.sentinelLength})`);
  lines.push(`- old 90-trial controlled artifact preserved: ${report.source.controlledMatrixTrialsPreserved} trials (success ${report.source.controlledMatrixSuccessPreserved})`);
  lines.push("");
  lines.push("## Results by cell");
  lines.push("");
  lines.push("| cell | kind | credential scopes | planned | usable | success x/n | retrieval | sentinel leaks | announced file tools | server saw request |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cell of report.cells) {
    lines.push(`| ${cell.cell} | ${cell.kind} | ${cell.scopes ? cell.scopes.join(" ") : "—"} | ${cell.planned} | ${cell.usable} | ${cell.xOverN} | ${cell.retrievalTrials} | ${cell.sentinelLeaks} | ${cell.announcedFileToolTrials} | ${cell.serverSawRequestTrials} |`);
  }
  lines.push("");
  lines.push(`Totals: executed ${report.totals.executed}, usable ${report.totals.usable}, success ${report.totals.success}, infra errors ${report.totals.infraErrors}.`);
  lines.push("");
  lines.push("## Zero-scope check (never faked)");
  lines.push("");
  lines.push(`- status: \`${report.zeroScope.status}\`; constructible: \`${report.zeroScope.constructible}\``);
  lines.push(`- observed scopes for createApiKey([]): ${report.zeroScope.observedScopes.join(", ")}`);
  lines.push(`- note: ${report.zeroScope.reason}`);
  lines.push("");
  lines.push("## Transport-only (not host evidence)");
  lines.push("");
  if (report.transportOnly) {
    lines.push(`- label: ${report.transportOnly.label}`);
    lines.push(`- missing-scope tools/list advertised get_file: ${report.transportOnly.missingScopeListedGetFile}`);
    lines.push(`- missing-scope direct get_file status: ${report.transportOnly.missingScopeGetFileStatus}`);
    lines.push(`- invalid-credential direct initialize status: ${report.transportOnly.invalidCredentialStatus}`);
  } else {
    lines.push("- not run");
  }
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  for (const limit of report.limits) lines.push(`- ${limit}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runtime.
// ---------------------------------------------------------------------------

export function buildScopeServerEnv({ baseEnv, port, vault, data, adminPassword, operator }) {
  return {
    ...baseEnv,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    MCP_PORT: String(port),
    VAULT_PATH: vault,
    DATA_PATH: data,
    API_KEY: "",
    OAUTH_ENABLED: "true",
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PUBLIC_BASE_URL_ALIASES: "",
    MCP_PATH: "/mcp",
    OAUTH_ADMIN_PASSWORD: adminPassword,
    EMBEDDING_PROVIDER: "disabled",
    GIT_ENABLED: "false",
    OBSIDIAN_READ_ONLY: "true",
    MCP_DISCOVERY_PROFILE: operator.profile,
    MCP_DISCOVERY_TOOLSETS: (operator.toolsets ?? []).join(","),
    MCP_DISCOVERY_TOOLS: (operator.tools ?? []).join(","),
    MCP_DISCOVERY_DENY_TOOLS: "",
  };
}

export async function seedManagedKey({ data, port, scopes, label = "scope-submatrix" }) {
  const helper = path.join(SCRIPT_DIR, "scope-seed-key.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DATA_PATH: data,
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        MCP_PATH: "/mcp",
        OAUTH_ADMIN_PASSWORD: "scope-submatrix-admin",
        SEED_SCOPES: JSON.stringify(scopes ?? []),
        SEED_LABEL: label,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`scope seed failed (${code}): ${stderr.slice(0, 300)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`scope seed output unreadable: ${error?.message || error}`));
      }
    });
  });
}

export async function readScopeAudit(data) {
  try {
    const state = JSON.parse(await readFile(path.join(data, "oauth", "state.json"), "utf8"));
    const audit = Array.isArray(state.audit) ? state.audit : [];
    return {
      count: audit.length,
      rejections: audit
        .filter((entry) => entry.outcome === "failure")
        .map((entry) => ({ action: entry.action, detail: entry.detail ?? null, credentialType: entry.credentialType ?? null })),
      scopes: [...new Set(audit.flatMap((entry) => (Array.isArray(entry.scopes) ? entry.scopes : [])))].sort(),
    };
  } catch {
    return { count: 0, rejections: [], scopes: [] };
  }
}

/** Direct HTTP status of an initialize attempt; used only for the labelled
 * transport-only assertion, never as host evidence. */
export async function directStatusProbe(port, apiKey) {
  const { McpHttpClient } = await import("./tool-discovery-production-eval.mjs");
  const client = new McpHttpClient({ url: `http://127.0.0.1:${port}/mcp`, apiKey: apiKey ?? undefined });
  const connected = await client.connect();
  return connected.ok ? 200 : (connected.status ?? connected.kind ?? null);
}

async function runScopeTransportCheck(port, secret, expectFileTools) {
  return withClient(port, secret, async (client) => {
    const listed = await client.listTools();
    const names = listed.ok ? listed.tools.map((tool) => tool.name) : [];
    const call = await client.callTool("get_file", { path: "Attachments/diagram.svg" });
    return {
      label: SCOPE_TRANSPORT_ONLY_LABEL,
      listedGetFile: names.map((name) => normalizeToolName(name)).includes("get_file"),
      advertisedFileTools: advertisedFileTools(names),
      getFileStatus: call?.kind === "http_error" ? call.status : null,
      getFileKind: call?.kind ?? null,
      expectFileTools,
    };
  });
}

async function runScopeTrial({ cell, task, trialIndex, tempRoot, extensionPath, piCli, timeoutMs, sentinel, catalogNames }) {
  const vault = path.join(tempRoot, `vault-${cell.id}-${trialIndex}`);
  const data = path.join(tempRoot, `data-${cell.id}-${trialIndex}`);
  await cp(path.join(FIXTURE_DIR, "vault"), vault, { recursive: true });
  await cp(path.join(FIXTURE_DIR, "data"), data, { recursive: true });
  const svgPath = path.join(vault, "Attachments", "diagram.svg");
  const svg = await readFile(svgPath, "utf8");
  await writeFile(svgPath, svg.replaceAll("{{SENTINEL}}", sentinel), "utf8");

  const expect = resolveExpect(task, sentinel);
  const port = await freePort();
  let secret = null;
  let seeded = null;
  if (cell.credential === "managed") {
    seeded = await seedManagedKey({ data, port, scopes: cell.scopes, label: `scope-${cell.id}` });
    secret = seeded.secret;
  } else if (cell.credential === "invalid") {
    secret = generateEphemeralKey();
  }

  const operator = { profile: "full", toolsets: [], tools: [] };
  const serverChild = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: buildScopeServerEnv({ baseEnv: process.env, port, vault, data, adminPassword: "scope-submatrix-admin", operator }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  serverChild.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
  serverChild.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));

  const base = {
    cell: cell.id,
    kind: cell.kind,
    credential: cell.credential,
    credentialScopes: cell.scopes ? [...cell.scopes] : null,
    taskId: task.id,
    profile: "full",
    operatorProfile: "full",
    trial: trialIndex,
    promptSha256: sha256Hex(task.prompt),
    expectSha256: sha256Hex(expect),
    sentinelSha256: sha256Hex(sentinel),
    status: "unknown",
  };

  try {
    if (!(await waitForHealth(port, 20000))) {
      return { ...base, status: "blocked", reason: "scratch OAUTH server did not become healthy", serverLogTail: scrubText(serverLog.join("").slice(-400), secret ?? "") };
    }
    const baseline = await readScopeAudit(data);
    let catalog = null;
    let transport = null;
    if (cell.credential === "managed") {
      const direct = await directCatalog(port, secret);
      catalog = direct.ok ? direct : null;
      if (cell.kind === "missing_scope") transport = await runScopeTransportCheck(port, secret, false);
    }
    const url = `http://127.0.0.1:${port}/mcp`;
    const pi = await runNestedPi({ piCli, extensionPath, url, apiKey: secret, prompt: task.prompt, cwd: tempRoot, timeoutMs });
    // Give the provider's debounced 500ms audit save time to flush before reading.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const audit = await readScopeAudit(data);
    const serverSawRequest = audit.count > baseline.count;
    const newRejections = audit.rejections.slice(baseline.rejections.length);
    let directProbeStatus = null;
    if (cell.credential === "invalid" || cell.credential === "missing") {
      directProbeStatus = await directStatusProbe(port, secret);
    }
    const records = parsePiRecords(scrubText(pi.stdout, secret ?? ""));
    const trace = summarizeControlledTrace(records, {
      readOnlyNames: catalog?.readOnlyNames ?? [],
      visibleNames: catalog?.names ?? [],
      expectedTools: task.expectedTools,
      alternativeTools: task.alternativeTools,
    });
    const answer = scrubText(
      records
        .filter((record) => record?.type === "message_end" && record.message?.role === "assistant")
        .flatMap((record) => record.message.content ?? [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .at(-1) ?? "",
      secret ?? "",
    );
    const evaluation = evaluateScopeTask({ answer, expect, trace });
    const announcedFiles = announcedFileTools(trace.announcedNames ?? []);
    const sentinelInAnswer = sentinel ? answer.includes(sentinel) : false;
    const hostSettled = pi.settled === true;
    let status;
    // Invalid/missing-credential cells are host init failures by design: the
    // bridge cannot establish a tool session, even if Pi still emits a settled
    // message. They can never be counted as a task success.
    if (cell.kind === "invalid" || cell.kind === "missing_env") status = "host_error";
    else if (pi.timedOut) status = "timeout";
    else if (hostSettled) status = evaluation.success ? "ok" : "task_failed";
    else if (pi.code === 0) status = "task_failed";
    else status = "host_error";
    return {
      ...base,
      status,
      catalogCount: catalog?.count ?? null,
      catalogNames: catalog?.names ?? null,
      readOnlyCount: catalog?.readOnlyNames?.length ?? null,
      advertisedFileTools: catalog ? advertisedFileTools(catalog.names) : [],
      announcedToolCount: trace.announcedToolCount,
      announcedNames: trace.announcedNames ?? [],
      announcedFileTools: announcedFiles,
      executedToolCallCount: trace.executedToolCallCount,
      executedCalls: trace.executedCalls,
      evidenceCall: evaluation.evidenceCall,
      answerMatch: evaluation.answerMatch,
      success: evaluation.success,
      answerSha256: sha256Hex(answer),
      answerLength: answer.length,
      answerText: answer.includes(sentinel) ? null : scrubText(answer, secret ?? ""),
      sentinelInAnswer,
      sentinelLeak: isScopeSentinelLeak({ cell: cell.id, sentinelInAnswer }),
      serverSawRequest,
      serverRejections: newRejections,
      directProbeStatus,
      transportCheck: transport,
      deniedCalls: trace.deniedCalls,
      mutationCalls: trace.mutationCalls,
      readOnlyGuardPassed: trace.readOnlyGuardPassed,
      latencyMs: pi.latencyMs,
      hostExitCode: pi.code,
      hostTimeout: pi.timedOut,
      hostSettled,
      stderrSummary: scrubText(pi.stderr, secret ?? "").slice(0, 240),
    };
  } finally {
    killTree(serverChild);
  }
}

// ---------------------------------------------------------------------------
// Artifact verification.
// ---------------------------------------------------------------------------

export async function verifyScopeMatrixArtifacts({ outDir = DEFAULT_OUT_DIR } = {}) {
  const errors = [];
  let json;
  try {
    json = JSON.parse(await readFile(path.join(outDir, SCOPE_JSON), "utf8"));
  } catch {
    return { ok: false, errors: [`${SCOPE_JSON} missing or unreadable`] };
  }
  if (json.schemaVersion !== SCOPE_SCHEMA_VERSION) errors.push(`schemaVersion is not ${SCOPE_SCHEMA_VERSION}`);
  if (json.generatedBy !== SCOPE_AUTHOR) errors.push(`generatedBy is not ${SCOPE_AUTHOR}`);
  const cell = (id) => (json.cells ?? []).find((entry) => entry.cell === id);
  for (const entry of json.cells ?? []) {
    if (entry.success > entry.usable) errors.push(`${entry.cell}: success > usable`);
    if (entry.xOverN !== `${entry.success}/${entry.usable}`) errors.push(`${entry.cell}: xOverN mismatch`);
  }
  const allowed = cell("files-allowed");
  const missing = cell("files-missing-scope");
  if (!allowed || !missing) errors.push("missing files-allowed/files-missing-scope cells");
  else {
    if (allowed.usable !== allowed.executed) errors.push("files-allowed had infrastructure errors");
    if (allowed.retrievalTrials !== allowed.executed) errors.push("files-allowed did not retrieve the sentinel with a real call in every trial");
    if (allowed.announcedFileToolTrials !== allowed.executed) errors.push("files-allowed did not advertise the file tool in every trial");
    if (allowed.sentinelLeaks !== 0) errors.push("files-allowed was treated as a sentinel leak");
    if (missing.success !== 0) errors.push("files-missing-scope recorded a success");
    if (missing.sentinelLeaks !== 0) errors.push("files-missing-scope leaked the sentinel");
    if (missing.announcedFileToolTrials !== 0) errors.push("files-missing-scope advertised an unauthorized file tool");
  }
  const invalid = cell("invalid-credential");
  if (invalid && invalid.serverSawRequestTrials !== invalid.executed) {
    errors.push("invalid-credential did not prove the server observed the rejected request in every executed trial");
  }
  const missingEnv = cell("missing-env-key");
  if (missingEnv && missingEnv.serverSawRequestTrials !== 0) {
    errors.push("missing-env-key must never reach the server");
  }
  if (json.zeroScope?.status !== "blocked") errors.push("zeroScope must be recorded blocked");
  if (json.zeroScope?.constructible !== false) errors.push("zeroScope must be recorded unconstructible");
  if ((json.zeroScope?.observedScopes ?? []).length !== 3) errors.push("zeroScope observed scopes must be all three MCP scopes");
  if (!json.transportOnly || json.transportOnly.label !== SCOPE_TRANSPORT_ONLY_LABEL) errors.push("transportOnly label missing");
  if (json.transportOnly?.missingScopeGetFileStatus !== 403) errors.push("transport-only missing-scope get_file must be 403");
  for (const trial of json.trials ?? []) {
    if (isScopeSentinelLeak(trial)) errors.push(`${trial.cell}/${trial.trial}: sentinel leak`);
    if (trial.cell === "missing-env-key" && trial.serverSawRequest === true) errors.push(`${trial.cell}/${trial.trial}: missing-env key reached the server`);
    if (trial.cell === "invalid-credential" && trial.serverSawRequest !== true) errors.push(`${trial.cell}/${trial.trial}: invalid credential never reached the server`);
  }
  try {
    const md = await readFile(path.join(outDir, SCOPE_MD), "utf8");
    const mismatch = generatedArtifactMismatch(md, `${renderScopeMarkdown(json)}\n`);
    if (mismatch) errors.push(`${SCOPE_MD}: ${mismatch}`);
  } catch {
    errors.push(`${SCOPE_MD} missing or unreadable`);
  }
  if (/ORACLE-SCOPE-[0-9a-f]{12}/.test(JSON.stringify(json))) errors.push("scope sentinel value leaked into the JSON artifact");
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Batch runner + CLI.
// ---------------------------------------------------------------------------

export function parseScopeArgs(argv) {
  const options = { mode: "run", outDir: DEFAULT_OUT_DIR, extension: DEFAULT_EXTENSION, pi: null, timeoutMs: 240000, maxWallMs: SCOPE_MAX_WALL_MS, trials: SCOPE_TRIALS_PER_CELL, keepTemp: false, filter: null };
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
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--filter") options.filter = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function loadScopeFixture() {
  const raw = await readFile(path.join(FIXTURE_DIR, "tasks.json"), "utf8");
  const fixture = JSON.parse(raw);
  const task = fixture.tasks.find((entry) => entry.id === SCOPE_TASK_ID);
  if (!task) throw new Error(`fixture is missing the scope task ${SCOPE_TASK_ID}`);
  return { fixture, task, raw };
}

/** Regenerate only the scope cells/totals/MD from the raw committed trials,
 * preserving every trial observation, the run provenance, zeroScope, and the
 * labelled transport-only result. */
export async function recomputeScopeMatrix({ outDir = DEFAULT_OUT_DIR } = {}) {
  const jsonPath = path.join(outDir, SCOPE_JSON);
  const json = JSON.parse(await readFile(jsonPath, "utf8"));
  const trials = json.trials ?? [];
  const cells = SCOPE_CELLS.map((cell) => summarizeScopeCell(trials.filter((trial) => trial.cell === cell.id), cell));
  const byOutcome = {};
  for (const trial of trials) byOutcome[trial.status] = (byOutcome[trial.status] ?? 0) + 1;
  const next = {
    ...json,
    cells,
    totals: {
      executed: trials.length,
      usable: trials.filter((trial) => ["ok", "task_failed"].includes(trial.status)).length,
      success: trials.filter((trial) => trial.success === true).length,
      infraErrors: trials.filter((trial) => ["host_error", "timeout", "blocked"].includes(trial.status)).length,
      byOutcome,
    },
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, SCOPE_MD), `${renderScopeMarkdown(next)}\n`, "utf8");
  return { ok: true, recomputed: true, trials: next.trials.length, totals: next.totals };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseScopeArgs(argv);
  if (options.mode === "verify") {
    const result = await verifyScopeMatrixArtifacts({ outDir: options.outDir });
    return { ok: result.ok, errors: result.errors };
  }
  if (options.mode === "recompute") {
    return recomputeScopeMatrix({ outDir: options.outDir });
  }
  const piCli = options.pi ?? resolvePiCli();
  if (!piCli) throw new Error("Pi CLI not found; set PI_CLI or pass --pi <path-to-cli.js>");
  const { existsSync } = await import("node:fs");
  if (!existsSync(options.extension)) throw new Error(`Pi bridge extension not found: ${options.extension}`);

  const { fixture, task, raw } = await loadScopeFixture();
  const bridgeText = await readFile(options.extension, "utf8");
  const sentinel = generateScopeSentinel();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "host-scope-matrix-"));
  const started = Date.now();
  const git = await gitInfo(REPO_DIR);
  const baseReport = {
    schemaVersion: SCOPE_SCHEMA_VERSION,
    generatedBy: SCOPE_AUTHOR,
    generatedAt: new Date().toISOString(),
    experiment: "isolated OAuth-managed-key host scope submatrix",
    run: { status: "partial", startedAt: new Date(started).toISOString(), maxWallMs: options.maxWallMs, elapsedMs: 0, completedTrials: 0, plannedTrials: 0, aborted: false, abortReason: null },
    source: {
      sha: git.sha,
      branch: git.branch,
      controlledMatrix: path.join("docs", "review", "tool-discovery", "host-matrix", "controlled-matrix.json").split(path.sep).join("/"),
      controlledMatrixSourceSha: "0d912a415cd1436c6daa17063bed2781663d88d5",
      controlledMatrixSuccessPreserved: 70,
      controlledMatrixTrialsPreserved: 90,
    },
    host: {
      requestedProvider: SCOPE_PROVIDER,
      requestedModel: SCOPE_MODEL,
      providerModelProvenance: "configured --provider/--model alias passed to the nested Pi process; not provider-attested identity",
      bridgePath: options.extension,
      bridgeSha256: sha256Hex(bridgeText),
      bridgeBytes: Buffer.byteLength(bridgeText),
      piCliVersion: await piVersion(piCli),
      nodeVersion: process.version,
    },
    fixture: {
      path: path.join(FIXTURE_DIR, "tasks.json"),
      sha256: sha256Hex(raw),
      taskId: task.id,
      prompt: task.prompt,
      promptSha256: sha256Hex(task.prompt),
      expectSha256: sha256Hex(resolveExpect(task, sentinel)),
      sentinelSha256: sha256Hex(sentinel),
      sentinelLength: sentinel.length,
    },
    zeroScope: { status: "blocked", constructible: false, observedScopes: [], reason: "createApiKey([]) normalizes to all MCP scopes; a true zero-scope managed key is unconstructible. Recorded blocked, never replaced with an invalid credential and never faked as PASS." },
    transportOnly: null,
    cells: [],
    totals: { executed: 0, usable: 0, success: 0, infraErrors: 0, byOutcome: {} },
    trials: [],
    limits: [...SCOPE_LIMITS],
  };

  const trials = [];
  let aborted = false;
  let abortReason = null;
  let transportOnly = null;

  const persist = async (status) => {
    const cells = SCOPE_CELLS.map((cell) => summarizeScopeCell(trials.filter((trial) => trial.cell === cell.id), cell));
    const byOutcome = {};
    for (const trial of trials) byOutcome[trial.status] = (byOutcome[trial.status] ?? 0) + 1;
    const report = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      run: { ...baseReport.run, status, elapsedMs: Date.now() - started, completedTrials: trials.length, plannedTrials: SCOPE_CELLS.length * options.trials, aborted, abortReason },
      transportOnly,
      cells,
      totals: {
        executed: trials.length,
        usable: trials.filter((trial) => ["ok", "task_failed"].includes(trial.status)).length,
        success: trials.filter((trial) => trial.success === true).length,
        infraErrors: trials.filter((trial) => ["host_error", "timeout", "blocked"].includes(trial.status)).length,
        byOutcome,
      },
      trials,
    };
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, SCOPE_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(options.outDir, SCOPE_MD), `${renderScopeMarkdown(report)}\n`, "utf8");
    return report;
  };

  try {
    // Zero-scope proof: seed with [] and show it normalizes to all scopes.
    const zeroRoot = await mkdtemp(path.join(os.tmpdir(), "host-scope-zero-"));
    try {
      const zeroPort = await freePort();
      const zeroKey = await seedManagedKey({ data: zeroRoot, port: zeroPort, scopes: [], label: "zero-scope-proof" });
      baseReport.zeroScope = {
        ...baseReport.zeroScope,
        observedScopes: [...zeroKey.scopes],
        constructible: zeroKey.scopes.length === 0,
        status: zeroKey.scopes.length === 0 ? "measured" : "blocked",
      };
    } finally {
      await rm(zeroRoot, { recursive: true, force: true }).catch(() => {});
    }

    const schedule = buildScopeSchedule(SCOPE_CELLS, options.trials).filter((entry) => !options.filter || entry.cell === options.filter);
    for (const entry of schedule) {
      if (Date.now() - started > options.maxWallMs) {
        abortReason = "scope max wall time reached; remaining trials left incomplete";
        break;
      }
      const cell = SCOPE_CELLS.find((item) => item.id === entry.cell);
      const trial = await runScopeTrial({
        cell,
        task,
        trialIndex: entry.trial,
        tempRoot,
        extensionPath: options.extension,
        piCli,
        timeoutMs: options.timeoutMs,
        sentinel,
        catalogNames: [],
      });
      if (trial.transportCheck && !transportOnly) {
        transportOnly = {
          label: SCOPE_TRANSPORT_ONLY_LABEL,
          missingScopeListedGetFile: trial.transportCheck.listedGetFile,
          missingScopeGetFileStatus: trial.transportCheck.getFileStatus,
          advertisedFileTools: trial.transportCheck.advertisedFileTools,
        };
      }
      if (isScopeSentinelLeak(trial)) {
        aborted = true;
        abortReason = `sentinel leak in ${trial.cell}/${trial.trial}`;
      }
      if ((trial.mutationCalls ?? []).length > 0) {
        aborted = true;
        abortReason = `non-read-only host call in ${trial.cell}/${trial.trial}: ${trial.mutationCalls.join(", ")}`;
      }
      trials.push(trial);
      await persist("partial");
    }
    const invalidTrial = trials.find((trial) => trial.cell === "invalid-credential" && trial.directProbeStatus != null);
    transportOnly = {
      ...(transportOnly ?? { label: SCOPE_TRANSPORT_ONLY_LABEL, missingScopeListedGetFile: null, missingScopeGetFileStatus: null, advertisedFileTools: [] }),
      invalidCredentialStatus: invalidTrial?.directProbeStatus ?? null,
    };
    const report = await persist(aborted ? "aborted" : "complete");
    return { ok: !aborted, status: report.run.status, outDir: options.outDir, completed: report.totals.executed, success: report.totals.success, zeroScope: report.zeroScope.status };
  } finally {
    if (!options.keepTemp) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`host-scope-matrix: temp cleanup deferred (${error?.code || error?.message})\n`);
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
      process.stderr.write(`host-scope-matrix failed: ${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
