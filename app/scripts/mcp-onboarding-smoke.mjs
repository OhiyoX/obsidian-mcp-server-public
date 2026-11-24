#!/usr/bin/env node
// Issue #669 (C5) — operator onboarding self-check for one Streamable-HTTP MCP endpoint.
//
// It runs ONE minimal probe — `initialize` -> `tools/list` -> one safe read (`server_info`) —
// and prints one JSON line:
//
//   {transport, authKind, scope, profile, readAvailable, writeDiscoverable, errors}
//
// The point is that "it does not work" becomes ONE class an operator can act on, because the
// fix differs per cause: `auth-invalid-key`, `auth-token-expired`, `scope-read-only`,
// `profile-read-only`, `session-dropped-recovered`, `network-dns`, `network-tls`,
// `cjk-write-unreachable` (`保存笔记` never reaches `write_note`), plus a few bounded fallbacks.
//
// Account and Vault text is low-trust reference; this script only reports what the endpoint
// served. It never writes: the single tool call is the read-only `server_info`. It never prints
// a credential — not the value and not a prefix — and it takes the endpoint and the credential
// from the environment or from stdin, never from argv (argv is visible in `ps`).
//
//   MCP_SMOKE_URL=https://host/mcp MCP_SMOKE_API_KEY=... node app/scripts/mcp-onboarding-smoke.mjs
//   node app/scripts/mcp-onboarding-smoke.mjs  < config.json     # {"endpoint","apiKey"|"token"}
//
// `MCP_SMOKE_TOKEN` (a bearer token) is the alternative credential. Exit code 0 = no errors.

import { pathToFileURL } from "node:url";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { tokenize } from "../src/vault-runtime/retrieval-rank.js";

export const TRANSPORT = "streamable-http";
export const PROBE_PROTOCOL_VERSION = "2025-06-18";
// The Chinese write intent from the #276 discovery work: this query MUST reach a write tool.
export const CJK_WRITE_QUERY = "保存笔记";

const SCOPE_ORDER = ["obsidian.read", "obsidian.write", "obsidian.files"];
const WRITE_TOOLS = new Set(Object.entries(MCP_TOOL_SCOPE_REQUIREMENTS)
  .filter(([, scopes]) => scopes.includes("obsidian.write"))
  .map(([name]) => name));
const DEFAULT_TIMEOUT_MS = 8000;
const DETAIL_LIMIT = 240;

class SmokeFailure extends Error {
  constructor(classification, detail) {
    super(detail);
    this.classification = classification;
    this.detail = detail;
  }
}

function bounded(value, redact) {
  const text = redact(String(value ?? "").replace(/[\r\n\t]+/g, " ").trim());
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

// Every supplied credential, plus any bearer-shaped value, becomes `[redacted]`. Applied to
// every string that leaves this module: the endpoint echoes the credential in some failures.
export function createRedactor(secrets = []) {
  const values = secrets.map((value) => String(value || "")).filter((value) => value.length >= 4);
  return (text) => {
    let output = String(text ?? "");
    for (const value of values) output = output.split(value).join("[redacted]");
    return output.replace(/(bearer\s+)[^\s",}]{4,}/gi, "$1[redacted]");
  };
}

function networkClassification(error) {
  const codes = [error, error?.cause, ...(error?.cause?.errors || [])].map((item) => item?.code).filter(Boolean);
  const names = [error?.name, error?.cause?.name].filter(Boolean);
  if (names.includes("TimeoutError")) return "network-timeout";
  if (codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) return "network-dns";
  if (codes.some((code) => /CERT|TLS|EPROTO|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/i.test(code))) return "network-tls";
  if (codes.includes("ECONNREFUSED")) return "network-refused";
  return "network-error";
}

// HTTP status -> the class that names the actual fix. `raw` is the response body as text;
// `challenge` is the `WWW-Authenticate` value, where an OAuth failure names its own error.
function httpClassification(status, raw, challenge = "") {
  const oauthError = (() => {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.error === "string") return parsed.error;
    } catch {
      // Not a JSON body; fall through to the challenge/status rules.
    }
    return /error="([^"]+)"/.exec(challenge)?.[1] || /error="([^"]+)"/.exec(raw)?.[1] || "";
  })();
  if (status === 404 && /session/i.test(raw)) return "session-dropped";
  if (status === 401) return oauthError === "invalid_token" ? "auth-token-expired" : "auth-invalid-key";
  if (status === 403) return oauthError === "insufficient_scope" ? "scope-read-only" : "auth-forbidden";
  if (status === 404) return "endpoint-not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "protocol-error";
}

function failureDetail(status, raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error_description || parsed?.error?.message || parsed?.message || `HTTP ${status}`;
  } catch {
    return raw ? raw.slice(0, DETAIL_LIMIT) : `HTTP ${status}`;
  }
}

// Streamable HTTP answers either as JSON or as a one-event SSE stream; both carry the same
// JSON-RPC response, so accept whichever arrived.
function parseResponseBody(contentType, raw, id) {
  if (!raw) return null;
  if (!/text\/event-stream/i.test(contentType || "")) return JSON.parse(raw);
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = JSON.parse(line.slice(5).trim());
    if (payload?.id === id) return payload;
  }
  return JSON.parse(raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() || "null");
}

// `保存笔记` reaches `write_note` only when a served write descriptor shares a token with the
// query, under the server's own CJK-bigram tokenizer.
// shortcut: a lexical proxy, not a Host's tool picker — it proves the served descriptors carry
// the Chinese signal, not that a model selects them; upgrade if a Host search is ever scriptable.
function cjkReachesWriteTool(tools) {
  const queryTokens = new Set(tokenize(CJK_WRITE_QUERY));
  return tools.some((tool) => WRITE_TOOLS.has(tool?.name)
    && tokenize(`${tool.name} ${tool.title || ""} ${tool.description || ""}`).some((token) => queryTokens.has(token)));
}

function observedScopes(tools) {
  return SCOPE_ORDER.filter((scope) => tools.some((tool) => MCP_TOOL_SCOPE_REQUIREMENTS[tool?.name]?.includes(scope)));
}

function readDiscovery(tools, callResult) {
  const text = Array.isArray(callResult?.content)
    ? callResult.content.filter((part) => part?.type === "text").map((part) => part.text).join("")
    : "";
  // The machine contract is `structuredContent`. A text-only result may carry a trailing prose
  // note after the pretty JSON (the served memory reminder), so its leading object is the fallback.
  const candidates = [callResult?.structuredContent, text, text.slice(0, text.indexOf("\n}") + 2)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const data = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
      return { discovery: data?.discovery || null, readAvailable: callResult?.isError !== true };
    } catch {
      // Try the next candidate shape.
    }
  }
  return { discovery: null, readAvailable: callResult?.isError !== true };
}

/**
 * Runs the probe once and returns the report object (already redacted).
 * `fetchImpl` is injectable so a caller can characterize a transport without a network.
 */
export async function runOnboardingSmoke({
  endpoint,
  apiKey = "",
  token = "",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const redact = createRedactor([apiKey, token]);
  const result = {
    transport: TRANSPORT,
    authKind: apiKey ? "api-key" : token ? "oauth" : "none",
    scope: [],
    profile: null,
    readAvailable: false,
    writeDiscoverable: false,
    errors: [],
  };
  if (!endpoint) {
    result.errors.push({ class: "config-missing-endpoint", detail: "no endpoint: set MCP_SMOKE_URL or send one on stdin" });
    return result;
  }

  let sessionId = null;
  let sessionRecovered = false;

  async function post(payload) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROBE_PROTOCOL_VERSION,
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SmokeFailure(networkClassification(error), error?.cause?.message || error?.message || "request failed");
    }
    const raw = await response.text();
    if (!response.ok) {
      throw new SmokeFailure(
        httpClassification(response.status, raw, response.headers.get("www-authenticate") || ""),
        failureDetail(response.status, raw),
      );
    }
    return { headers: response.headers, message: parseResponseBody(response.headers.get("content-type"), raw, payload.id) };
  }

  async function initialize() {
    const { headers } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROBE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "obsidian-onboarding-smoke", version: "1.0.0" },
      },
    });
    sessionId = headers.get("mcp-session-id") || sessionId;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  // One reconnection: a server that forgot the session answers 404 "Session not found".
  async function withRecovery(send) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof SmokeFailure) || error.classification !== "session-dropped" || sessionRecovered) throw error;
      sessionRecovered = true;
      await initialize();
      return send();
    }
  }

  try {
    await initialize();
    const listed = await withRecovery(async () => (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).message);
    if (!Array.isArray(listed?.result?.tools)) throw new SmokeFailure("protocol-error", "tools/list returned no tool array");
    const tools = listed.result.tools;
    result.scope = observedScopes(tools);
    result.writeDiscoverable = tools.some((tool) => WRITE_TOOLS.has(tool?.name));

    const called = await withRecovery(async () => (await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "server_info", arguments: {} },
    })).message);
    const { discovery, readAvailable } = readDiscovery(tools, called?.result);
    result.readAvailable = readAvailable;
    result.profile = discovery?.profile ?? null;

    if (sessionRecovered) {
      result.errors.push({ class: "session-dropped-recovered", detail: "the session was re-established once and the probe continued" });
    }
    if (!result.writeDiscoverable) {
      const hiddenByScope = Number(discovery?.hiddenByScope) || 0;
      const hiddenByPolicy = Number(discovery?.hiddenByPolicy) || 0;
      // Operator configuration first: a compact/reduced profile is a deliberate setting, and a
      // read-only credential on a full profile is the other cause an operator can act on.
      if (result.profile && result.profile !== "full") {
        result.errors.push({ class: "profile-read-only", detail: `the served profile is ${result.profile}; no write tool is served` });
      } else if (hiddenByScope > 0) {
        result.errors.push({ class: "scope-read-only", detail: `the credential hides ${hiddenByScope} tool(s) that need a scope it does not carry` });
      } else if (hiddenByPolicy > 0) {
        result.errors.push({ class: "profile-read-only", detail: `the served policy hides ${hiddenByPolicy} write-capable tool(s)` });
      } else {
        result.errors.push({ class: "write-undiscoverable", detail: "the endpoint serves no write-capable tool" });
      }
    } else if (!cjkReachesWriteTool(tools)) {
      result.errors.push({ class: "cjk-write-unreachable", detail: `no served write tool shares a token with "${CJK_WRITE_QUERY}"` });
    }
  } catch (error) {
    const classification = error instanceof SmokeFailure ? error.classification : "probe-crashed";
    result.errors.push({
      class: classification === "session-dropped" ? "session-dropped-unrecovered" : classification,
      detail: bounded(error instanceof SmokeFailure ? error.detail : error?.message, redact),
    });
  }
  return result;
}

// Endpoint and credential from stdin when the environment does not supply them. Accepts JSON
// (`{"endpoint","apiKey","token"}`) or `KEY=value` lines, so a secret stays out of argv.
export async function parseStdinConfig(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return {
      endpoint: String(parsed?.endpoint || parsed?.url || ""),
      apiKey: String(parsed?.apiKey || parsed?.api_key || ""),
      token: String(parsed?.token || parsed?.bearer || ""),
    };
  } catch {
    const config = {};
    for (const line of trimmed.split("\n")) {
      const [rawKey, ...rest] = line.split("=");
      const value = rest.join("=").trim();
      if (!rawKey || !value) continue;
      const key = rawKey.trim().toLowerCase();
      if (key === "endpoint" || key === "url" || key === "mcp_smoke_url") config.endpoint = value;
      else if (key === "apikey" || key === "api_key" || key === "mcp_smoke_api_key") config.apiKey = value;
      else if (key === "token" || key === "bearer" || key === "mcp_smoke_token") config.token = value;
    }
    return config;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** CLI: prints the report as one JSON line and returns the exit code. */
export async function main({ env = process.env, fetchImpl = fetch, stdin } = {}) {
  const config = { endpoint: env.MCP_SMOKE_URL || "", apiKey: env.MCP_SMOKE_API_KEY || "", token: env.MCP_SMOKE_TOKEN || "" };
  if (!config.endpoint || (!config.apiKey && !config.token)) {
    // A piped stdin is read; an interactive terminal is not (it would block).
    const piped = await parseStdinConfig((stdin ?? !process.stdin.isTTY) ? await readStdin() : "");
    config.endpoint = config.endpoint || piped.endpoint || "";
    config.apiKey = config.apiKey || piped.apiKey || "";
    config.token = config.token || piped.token || "";
  }
  const result = await runOnboardingSmoke({ endpoint: config.endpoint, apiKey: config.apiKey, token: config.token, fetchImpl });
  const redact = createRedactor([config.apiKey, config.token]);
  process.stdout.write(`${redact(JSON.stringify(result))}\n`);
  return result.errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`onboarding smoke could not run: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
