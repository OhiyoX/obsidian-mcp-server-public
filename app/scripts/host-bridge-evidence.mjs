#!/usr/bin/env node
// Phase 3 host-bridge runtime evidence harness (isolated scratch, read-only).
//
// This script drives the *real* Pi host, through the user's installed Obsidian
// MCP bridge extension, against an isolated loopback scratch Obsidian MCP
// server. It measures what the host actually announces and calls, and it never
// touches the production Vault, the production server, the Web UI, or any
// global credential file.
//
// Hygiene contract (verified by app/test/host-bridge-evidence.test.js):
//   - the scratch API key is generated with crypto.randomBytes, in memory;
//   - it is passed to child processes ONLY through the `env` option of
//     child_process.spawn — never through argv, a shell string, a fixture, a
//     temp file, stdout, stderr, or this script's own output;
//   - captured child output is scrubbed; only aggregate outcomes are written.
//
// Read-only guard (precise label): the scratch server runs with
// OBSIDIAN_READ_ONLY=true. That flag is NOT a blanket execution gate for every
// mutation path — on this isolated scratch server `manage_publish` still writes
// publish state under DATA_PATH and `reindex_vault` still queues indexing work.
// What is actually observed here is narrower and specific: a direct `write_note`
// probe was denied and created no file. The harness guard itself is a POST-HOC
// assertion, not an execution gate: it computes the read-only-annotated set from
// the live `tools/list` and asserts that every host tool call belongs to that
// set (a `readOnlyHint:false` tool such as `manage_publish` would be flagged).
// It never issues a task that needs a mutation tool.
//
// The Pi bridge is a *custom user extension* that eagerly registers every MCP
// tool; this is NOT the host's provider-native deferred loading. The evidence
// is labelled accordingly.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpHttpClient } from "./tool-discovery-production-eval.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_DIR = path.resolve(APP_DIR, "..");
export const FIXTURE_DIR = path.join(APP_DIR, "test", "fixtures", "host-bridge-evidence");
export const DEFAULT_EXTENSION = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
  "obsidian-mcp",
  "index.ts",
);
export const DEFAULT_OUT = path.join(
  REPO_DIR,
  "docs",
  "review",
  "tool-discovery",
  "host-matrix",
  "phase3-host-runtime-evidence.json",
);
export const SCHEMA_VERSION = "1.1.0";
export const SECRET_PREFIX = "hostbridge-";
export const PROVIDER = "opencode-go";
export const MODEL = "deepseek-v4.1-flash";

// ---- Declared, reusable evidence labels (single source of truth) ----------
// The committed artifact must not drift from these labels; the focused test
// asserts the checked-in JSON carries exactly these values.
export const EVIDENCE_POLICY = Object.freeze({
  readOnlyServer:
    "OBSIDIAN_READ_ONLY=true (not a blanket gate: manage_publish writes DATA_PATH publish state and reindex_vault queues)",
  guard:
    "post-hoc assertion that every host tool call is in the readOnlyHint:true set from the live tools/list (not an execution gate)",
  key: "ephemeral crypto.randomBytes, passed only through spawn env",
});

export const EVIDENCE_METRICS = Object.freeze({
  schemaBytes:
    "Buffer.byteLength(JSON.stringify(tools)) over the whole tools/list array; includes [ ] and , framing",
  descriptorBytesSum: "sum of Buffer.byteLength(JSON.stringify(tool)) per descriptor",
  framingRelation:
    "within one snapshot schemaBytes - descriptorBytesSum === count + 1 framing bytes; this is not schema drift, and byte totals are per-snapshot",
  providerModel:
    "requested --provider/--model alias only; not provider-attested identity and not a provider request-payload measurement",
});

export const EVIDENCE_LIMITS = Object.freeze([
  "Three fixtures, one task each, on a scratch vault; `full` and `core` share one prompt/expectation while `module` uses a different prompt. This is a bounded characterization, not a controlled cross-profile success/latency comparison and not a statistical sample.",
  "The Pi bridge is a custom user extension that eagerly registers all MCP tools; it is not provider-native deferred loading. Native Pi provider auto-defer/tool-search remains unknown, and no host deferred/search mechanism is claimed.",
  "The nested Pi host runs with -nbt (no built-in tools), so only bridge tools are callable.",
  "Model/provider errors are recorded as evidence, not as task success.",
  "Requested provider/model is the configured --provider/--model alias, not provider-attested identity, and schemaBytes is the server's serialized tools/list ARRAY (including [ ] and , framing), not a provider request-payload cost.",
  "OBSIDIAN_READ_ONLY is not a blanket execution gate: manage_publish still writes scratch DATA_PATH publish state and reindex_vault still queues work. The direct write_note probe was denied and created no file; the per-run guard is a post-hoc readOnlyHint assertion, not an execution gate.",
  "Catalog byte totals are per-snapshot: a schema change between revisions changes the descriptor sum, while the `count + 1` framing relation holds only within one snapshot. Byte totals are not comparable across revisions.",
  "No production Vault, production server, Web UI, or global credential file was read or written.",
]);

// ---------------------------------------------------------------------------
// Pure, side-effect-free helpers (unit-tested).
// ---------------------------------------------------------------------------

/** Generate an ephemeral scratch key in memory. The returned value is a secret
 * and must never be logged, serialized, or placed in argv. */
export function generateEphemeralKey(bytes = 24) {
  return SECRET_PREFIX + randomBytes(bytes).toString("hex");
}

/** Replace every occurrence of `secret` with a redaction marker. */
export function scrubText(text, secret) {
  let out = String(text ?? "");
  if (secret) out = out.split(secret).join("[REDACTED]");
  return out;
}

/** Recursively scrub a JSON-like value. */
export function scrubValue(value, secret) {
  if (typeof value === "string") return scrubText(value, secret);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, secret));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrubValue(entry, secret);
    return out;
  }
  return value;
}

/** Build the argv for the nested Pi process. `processed by process.execPath`, so
 * the first element is the Pi CLI entry point. The API key is intentionally
 * absent from this array: it is delivered through the child `env` only. */
export function buildPiArgs({ piCli, extensionPath, provider, model, prompt }) {
  return [
    piCli,
    "--provider",
    provider,
    "--model",
    model,
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "-e",
    extensionPath,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "-nbt",
    prompt,
  ];
}

/** Build the scratch server environment. The key is a value here and is handed
 * to spawn via `env`; it is never interpolated into a command string. */
export function buildServerEnv({ baseEnv, port, vault, data, apiKey, profile, toolsets }) {
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
    MCP_DISCOVERY_PROFILE: profile,
    MCP_DISCOVERY_TOOLSETS: toolsets ?? "",
    MCP_DISCOVERY_TOOLS: "",
    MCP_DISCOVERY_DENY_TOOLS: "",
  };
}

/** Parse the nested Pi `--mode json` output into JSONL records. */
export function parsePiRecords(text) {
  const records = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Partial/streamed lines are skipped; a full record is self-contained.
    }
  }
  return records;
}

/** Strip the Pi extension prefix so host tool names can be compared with the
 * raw MCP names returned by the scratch server's `tools/list`. */
export function normalizeToolName(name) {
  const raw = String(name ?? "");
  return raw.startsWith("mcp_obsidian_") ? raw.slice("mcp_obsidian_".length) : raw;
}

/** Normalize free text to a comparison key: lowercase, with every non-alphanumeric
 * run collapsed to a single space. "Yes." -> "yes"; "active" -> "active". */
export function normalizeAnswer(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Exact normalized equality against the fixture's expected output. This rejects
 * negations and superstrings, so "inactive" !== "active", "yesterday" !== "yes",
 * and "the status is active" does not match "active". */
export function answerMatchesExpect(answer, expect) {
  const normalized = normalizeAnswer(answer);
  const expected = normalizeAnswer(expect);
  return expected.length > 0 && normalized === expected;
}

/** A validated task success requires BOTH an exact fixture answer AND at least
 * one actually executed MCP tool call. A model self-report with an empty tool
 * trace is not a success. */
export function evaluateTaskMatch({ answer, expect, executedToolCallCount }) {
  return answerMatchesExpect(answer, expect) && Number(executedToolCallCount) > 0;
}

/** Summarize the host tool payload and execution trace. */
export function summarizeToolTrace(records, { readOnlyNames = [] } = {}) {
  const readOnly = new Set(readOnlyNames.map(normalizeToolName));
  const announced = new Set();
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
      executed.push(record.toolName);
    }
  }
  const mutationCalls = executed.filter((name) => !readOnly.has(normalizeToolName(name)));
  return {
    announcedToolCount: announced.size,
    announcedSample: [...announced].sort().slice(0, 5),
    executedToolCalls: [...executed],
    executedToolCallCount: executed.length,
    mutationCalls,
    readOnlyGuardPassed: mutationCalls.length === 0,
  };
}

/** Extract the final assistant text block from the nested Pi records. */
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

/** Locate the Pi CLI bundle from an explicit env override or from PATH. */
export function resolvePiCli({ env = process.env, exists = existsSync } = {}) {
  if (env.PI_CLI && exists(env.PI_CLI)) return env.PI_CLI;
  for (const dir of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Render a scrubbed Markdown summary from the evidence object. */
export function renderEvidenceMarkdown(evidence) {
  const host = evidence.host ?? {};
  const requestedProvider = host.requestedProvider ?? host.provider ?? "unknown";
  const requestedModel = host.requestedModel ?? host.model ?? "unknown";
  const lines = [];
  lines.push("# Phase 3 host-bridge runtime evidence (candidate)");
  lines.push("");
  lines.push(
    "Generated by `app/scripts/host-bridge-evidence.mjs`. Isolated scratch server, read-only, loopback, ephemeral key in memory.",
  );
  lines.push("");
  lines.push(`- evidence schema: \`${evidence.schemaVersion}\``);
  lines.push(
    `- requested provider/model: \`${requestedProvider}/${requestedModel}\` (configured \`--provider\`/\`--model\` alias, not provider-attested identity and not a provider payload measurement)`,
  );
  lines.push(`- pi cli: \`${host.piCliVersion ?? "unknown"}\``);
  lines.push(`- node: \`${host.nodeVersion}\``);
  lines.push(`- bridge: ${host.bridge}`);
  lines.push("");
  lines.push("| task | profile | announced | read-only | executed | mutation calls | guard | answer match | latency ms | outcome |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of evidence.runs) {
    const announced = run.host?.announcedToolCount ?? "unknown";
    const readOnly = run.catalog?.readOnlyCount ?? "unknown";
    const executed = run.host?.executedToolCallCount ?? "unknown";
    const mutations = run.host?.mutationCalls?.length ?? "unknown";
    const guard = run.host?.readOnlyGuardPassed === true ? "pass" : run.host?.readOnlyGuardPassed === false ? "FAIL" : "unknown";
    const match = run.taskMatch === true ? "yes" : run.taskMatch === false ? "no" : "unknown";
    lines.push(
      `| ${run.taskId} | ${run.profile} | ${announced} | ${readOnly} | ${executed} | ${mutations} | ${guard} | ${match} | ${run.latencyMs ?? "unknown"} | ${run.status} |`,
    );
  }
  lines.push("");
  lines.push(
    "\`answer match\` is \`true\` only when the assistant text exactly normalizes to the fixture's expected value AND at least one MCP tool call was actually executed. A model self-report with an empty tool trace is not a match.",
  );
  lines.push("");
  lines.push("## Catalog (direct `tools/list` on the isolated server)");
  lines.push("");
  lines.push("| profile | toolsets | announced | read-only | schema bytes | descriptor bytes (sum) |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const run of evidence.runs) {
    lines.push(
      `| ${run.profile} | ${run.toolsets || "(none)"} | ${run.catalog?.count ?? "unknown"} | ${run.catalog?.readOnlyCount ?? "unknown"} | ${run.catalog?.schemaBytes ?? "unknown"} | ${run.catalog?.descriptorBytesSum ?? "unknown"} |`,
    );
  }
  lines.push("");
  lines.push(
    "\`schema bytes\` is \`Buffer.byteLength(JSON.stringify(tools))\` over the whole \`tools/list\` ARRAY, including the \`[\` \`]\` brackets and \`,\` separators. Within one snapshot it exceeds the summed per-descriptor bytes by exactly \`count + 1\` framing bytes. This is JSON array framing, not schema drift, and byte totals are only comparable within a single snapshot.",
  );
  lines.push("");
  lines.push("## Mutation guard probe");
  lines.push("");
  lines.push(
    evidence.mutationGuard
      ? `- attempted \`${evidence.mutationGuard.tool}\` on the isolated read-only vault: denied=\`${evidence.mutationGuard.denied}\`, fileCreated=\`${evidence.mutationGuard.fileCreated}\``
      : "- not run",
  );
  lines.push("");
  lines.push(
    "The probe above is the specific direct \`write_note\` check. The per-run guard is a POST-HOC assertion over the live \`readOnlyHint:true\` set (it would flag a \`readOnlyHint:false\` call such as \`manage_publish\`); it is not an execution gate. \`OBSIDIAN_READ_ONLY=true\` does not block every mutation path: \`manage_publish\` still writes scratch \`DATA_PATH\` publish state and \`reindex_vault\` still queues work.",
  );
  lines.push("");
  lines.push("## Boundaries");
  lines.push("");
  for (const limit of evidence.limits) lines.push(`- ${limit}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runtime helpers (side-effecting).
// ---------------------------------------------------------------------------

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status < 500) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function killTree(child) {
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

async function directCatalog(port, apiKey) {
  const client = new McpHttpClient({ url: `http://127.0.0.1:${port}/mcp`, apiKey });
  const connected = await client.connect();
  if (!connected.ok) return { ok: false, kind: connected.kind ?? "connect_failed" };
  const listed = await client.listTools();
  if (!listed.ok) return { ok: false, kind: listed.kind ?? "list_failed" };
  const tools = listed.tools;
  const names = tools.map((tool) => tool.name).sort();
  const readOnlyNames = tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .map((tool) => tool.name)
    .sort();
  // `schemaBytes` is the whole serialized `tools/list` ARRAY (it includes the
  // `[`/`]` brackets and `,` separators). `descriptorBytesSum` is the sum of the
  // per-descriptor bytes, the same metric the P2C cost gate reports. The two
  // differ by exactly `count + 1` framing bytes — JSON array framing, not schema
  // drift — and the artifact records both so they cannot be misread.
  return {
    ok: true,
    count: names.length,
    names,
    readOnlyNames,
    schemaBytes: Buffer.byteLength(JSON.stringify(tools)),
    descriptorBytesSum: tools.reduce(
      (sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)),
      0,
    ),
    schemaBytesScope:
      "serialized tools/list ARRAY (Buffer.byteLength(JSON.stringify(tools))), includes [ ] and , framing",
  };
}

async function mutationGuardProbe(port, apiKey, vault) {
  const target = path.join(vault, "Guard", "Probe.md");
  const client = new McpHttpClient({ url: `http://127.0.0.1:${port}/mcp`, apiKey });
  const connected = await client.connect();
  if (!connected.ok) return { tool: "write_note", attempted: false, reason: "connect_failed" };
  const result = await client.callTool("write_note", { path: "Guard/Probe.md", content: "guard-probe" });
  return {
    tool: "write_note",
    attempted: true,
    denied: result?.kind === "result" ? result.result?.isError === true : true,
    fileCreated: existsSync(target),
  };
}

async function runNestedPi({ piCli, extensionPath, url, apiKey, prompt, cwd, timeoutMs }) {
  const args = buildPiArgs({ piCli, extensionPath, provider: PROVIDER, model: MODEL, prompt });
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, OBSIDIAN_MCP_URL: url, OBSIDIAN_MCP_API_KEY: apiKey },
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
      // Pi can keep the MCP transport's event loop alive after it has already
      // produced the final answer. Stop as soon as the agent settles.
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

async function runProfile({ task, tempRoot, extensionPath, piCli, timeoutMs }) {
  const vault = path.join(tempRoot, `vault-${task.id}`);
  const data = path.join(tempRoot, `data-${task.id}`);
  await cp(path.join(FIXTURE_DIR, "vault"), vault, { recursive: true });
  await mkdir(data, { recursive: true });
  const apiKey = generateEphemeralKey();
  const port = await freePort();
  const serverChild = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: buildServerEnv({
      baseEnv: process.env,
      port,
      vault,
      data,
      apiKey,
      profile: task.profile,
      toolsets: task.toolsets,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  serverChild.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
  serverChild.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));

  const base = {
    taskId: task.id,
    profile: task.profile,
    toolsets: task.toolsets || "",
    expect: task.expect,
    status: "unknown",
  };

  try {
    if (!(await waitForHealth(port, 20000))) {
      return {
        ...base,
        status: "blocked",
        reason: "scratch server did not become healthy",
        serverLogTail: scrubText(serverLog.join("").slice(-400), apiKey),
      };
    }
    const catalog = await directCatalog(port, apiKey);
    if (!catalog.ok) {
      return { ...base, status: "blocked", reason: `tools/list failed (${catalog.kind})`, catalog: { ok: false } };
    }
    const guard = await mutationGuardProbe(port, apiKey, vault);
    const url = `http://127.0.0.1:${port}/mcp`;
    const pi = await runNestedPi({ piCli, extensionPath, url, apiKey, prompt: task.prompt, cwd: tempRoot, timeoutMs });
    const records = parsePiRecords(scrubText(pi.stdout, apiKey));
    const host = summarizeToolTrace(records, { readOnlyNames: catalog.readOnlyNames });
    const answer = scrubText(extractFinalText(records), apiKey);
    const answerMatch = answerMatchesExpect(answer, task.expect);
    const taskMatch = evaluateTaskMatch({
      answer,
      expect: task.expect,
      executedToolCallCount: host.executedToolCallCount,
    });
    const scrubbedStderr = scrubText(pi.stderr, apiKey);
    return {
      ...base,
      status: pi.timedOut ? "timeout" : pi.settled ? "ok" : pi.code === 0 ? "ok" : "host_error",
      catalog: {
        ok: true,
        count: catalog.count,
        readOnlyCount: catalog.readOnlyNames.length,
        schemaBytes: catalog.schemaBytes,
        descriptorBytesSum: catalog.descriptorBytesSum,
        schemaBytesScope: catalog.schemaBytesScope,
      },
      host,
      answer,
      answerMatch,
      taskMatch,
      latencyMs: pi.latencyMs,
      hostExitCode: pi.code,
      hostTimeout: pi.timedOut,
      hostSettled: pi.settled === true,
      stderrSummary: scrubbedStderr ? scrubbedStderr.slice(0, 240) : "",
      mutationGuard: guard,
      announcedNames: catalog.names,
    };
  } finally {
    killTree(serverChild);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, extension: DEFAULT_EXTENSION, pi: null, timeoutMs: 240000, keepTemp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") options.out = argv[++i];
    else if (arg === "--extension") options.extension = argv[++i];
    else if (arg === "--pi") options.pi = argv[++i];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--keep-temp") options.keepTemp = true;
  }
  return options;
}

async function piVersion(piCli) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [piCli, "--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").trim() || null));
    child.on("error", () => resolve(null));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const piCli = options.pi ?? resolvePiCli();
  if (!piCli) throw new Error("Pi CLI not found; set PI_CLI or pass --pi <path-to-cli.js>");
  if (!existsSync(options.extension)) throw new Error(`Pi bridge extension not found: ${options.extension}`);
  const tasksFile = JSON.parse(await readFile(path.join(FIXTURE_DIR, "tasks.json"), "utf8"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "host-bridge-evidence-"));
  const started = Date.now();
  try {
    const runs = [];
    for (const task of tasksFile.tasks) {
      runs.push(await runProfile({ task, tempRoot, extensionPath: options.extension, piCli, timeoutMs: options.timeoutMs }));
    }
    const guardRun = runs.find((run) => run.mutationGuard?.attempted);
    const evidence = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      host: {
        requestedProvider: PROVIDER,
        requestedModel: MODEL,
        providerModelProvenance:
          "configured --provider/--model alias passed to the nested Pi process; not provider-attested model identity and not a provider request-payload measurement",
        bridge: "custom user extension (~/.pi/agent/extensions/obsidian-mcp/index.ts), eager registerTool of every MCP tool",
        piCliVersion: await piVersion(piCli),
        nodeVersion: process.version,
      },
      policy: EVIDENCE_POLICY,
      metrics: EVIDENCE_METRICS,
      mutationGuard: guardRun?.mutationGuard ?? null,
      runs: runs.map((run) => {
        const { announcedNames, ...rest } = run;
        return rest;
      }),
      limits: [...EVIDENCE_LIMITS],
      elapsedMs: Date.now() - started,
    };
    const scrubbed = scrubValue(evidence, null);
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(scrubbed, null, 2)}\n`, "utf8");
    const markdownPath = options.out.replace(/\.json$/, ".md");
    await writeFile(markdownPath, `${renderEvidenceMarkdown(scrubbed)}\n`, "utf8");
    return { ok: true, out: options.out, markdown: markdownPath, runs: scrubbed.runs.map((run) => ({
      taskId: run.taskId,
      status: run.status,
      announced: run.host?.announcedToolCount ?? null,
      executed: run.host?.executedToolCallCount ?? null,
      guard: run.host?.readOnlyGuardPassed ?? null,
      match: run.taskMatch ?? null,
      latencyMs: run.latencyMs ?? null,
    })) };
  } finally {
    if (!options.keepTemp) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        // Windows can keep a briefly-locked handle after a killed child. The
        // temp root holds no secret; surface the cleanup state instead of
        // failing an otherwise complete run.
        process.stderr.write(`host-bridge-evidence: temp cleanup deferred (${error?.code || error?.message})\n`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`host-bridge-evidence failed: ${error?.message || error}\n`);
      process.exitCode = 1;
    });
}
