#!/usr/bin/env node
// Progressive Tool Discovery — Phase 0 host defer/tool-search capability probe.
//
// This script is a read-only characterization tool. It:
//   1. holds the authored Phase 0 host capability matrix as data;
//   2. validates that matrix against a fixed vocabulary and honesty rules
//      (a "supported"/"real" cell may not exist without recorded evidence);
//   3. renders docs/review/tool-discovery/host-matrix/host-matrix.md
//      deterministically from docs/review/tool-discovery/host-matrix/host-matrix.json;
//   4. optionally probes the *local* machine for installed MCP hosts.
//
// It never connects to the Obsidian MCP server, never calls an MCP tool, never
// touches the Vault, and never writes outside
// docs/review/tool-discovery/host-matrix/.
//
// Status vocabulary (see docs/AGENT_EXECUTION_GUIDE.md): this artifact is a
// "candidate" characterization. It says nothing about production.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_ROOT = path.resolve(APP_DIR, "..");
export const MATRIX_DIR = path.join(REPO_ROOT, "docs", "review", "tool-discovery", "host-matrix");
export const MATRIX_JSON_PATH = path.join(MATRIX_DIR, "host-matrix.json");
export const MATRIX_MARKDOWN_PATH = path.join(MATRIX_DIR, "host-matrix.md");

export const SCHEMA_VERSION = "1.1.0";
export const AUTHORED_COMMIT = "c860abae342a9b4ea45949de8f24690a92ec7eab";
export const STATIC_SCAN_RECIPE_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Controlled vocabularies.
// ---------------------------------------------------------------------------

export const EVIDENCE_TIERS = {
  "runtime-observed":
    "Observed directly while the host was running against an MCP surface in this task.",
  "artifact-declared":
    "Found in an installed host artifact (binary strings, bundled source, CLI output, shipped docs).",
  "documentation-only":
    "Claimed only by external documentation; no local implementation artifact found.",
  "not-detected":
    "Inspected the installed artifact and did not find the mechanism; absence is not proof of absence.",
  "not-available": "Host binary was not found locally; no capability claim is made.",
  unknown: "Not measured and not resolvable from available evidence.",
};

export const TOOL_DISCOVERY_MODES = {
  real: "A defer/tool-search mechanism exists in the installed host (artifact-declared or observed).",
  "documented-only": "A mechanism is claimed only by external documentation.",
  "eager-fallback": "Inspected host loads the full catalog and no defer/search path was found.",
  unknown: "Cannot be classified from available evidence.",
};

export const SCHEMA_LOAD_MODES = {
  "eager-auto": "Host fetches and exposes full tool schemas (input/output) on connect.",
  "deferred-capable": "Host has a mechanism to withhold or defer tool schemas, but the default is unverified.",
  "deferred-default": "Host withholds tool schemas by default under an observed/declared configuration.",
  unknown: "Not measured.",
};

export const LIST_REFRESH_MODES = {
  implemented:
    "Host artifact contains a handler/refresh path for notifications/tools/list_changed.",
  "declared-only": "Only an SDK/schema declaration was found; no host refresh path.",
  "not-detected": "No handler and no schema for notifications/tools/list_changed was found.",
  unknown: "Not measured.",
};

export const CROSS_SESSION_MODES = {
  "re-discovered-per-session": "Host reconnects and re-lists tools for a new process/session.",
  "cached-across-sessions": "Host persists a tool catalog across sessions.",
  unknown: "Not measured.",
};

const CELL_VOCABULARIES = {
  toolDiscoveryMode: new Set(Object.keys(TOOL_DISCOVERY_MODES)),
  nativeSchemaAutoLoad: new Set(Object.keys(SCHEMA_LOAD_MODES)),
  listRefresh: new Set(Object.keys(LIST_REFRESH_MODES)),
  crossSession: new Set(Object.keys(CROSS_SESSION_MODES)),
};

export const EVIDENCE_KINDS = new Set([
  "installed-artifact",
  "command-output",
  "runtime-session",
  "runtime-observed",
  "documentation-only",
]);

// How an evidence record can be checked. Only `static-digest` is recomputed by
// `--check`, and only over the *recorded* marker counts. Re-deriving those
// counts from a live artifact is a separate, explicit `--scan <scanId>=<path>`
// operation. `external-attestation` records are observations made on a specific
// machine/session; `--check` never claims to have verified them.
export const EVIDENCE_VERIFICATION = {
  "static-digest":
    "Recorded marker counts are hashed; --check recomputes the digest. Re-deriving counts needs --scan against the artifact.",
  "repository-test": "Reproduced by the repository test suite (local in-process probe).",
  "static-excerpt": "Hand-read from an installed artifact; not machine-reproducible and not verified by --check.",
  "external-attestation":
    "Observed on the probe machine or in this session; not reproducible in CI and not verified by --check.",
};

// tier -> which evidence kinds are required to justify it and which are allowed
// to appear alongside it. A `runtime-observed` cell may cite supporting static
// evidence, but must contain at least one runtime kind. This stops a static
// artifact finding from being relabeled as runtime support.
export const TIER_EVIDENCE_KINDS = {
  "runtime-observed": {
    required: new Set(["runtime-observed", "runtime-session"]),
    allowed: new Set(["runtime-observed", "runtime-session", "installed-artifact", "command-output"]),
  },
  "artifact-declared": {
    required: new Set(["installed-artifact", "command-output"]),
    allowed: new Set(["installed-artifact", "command-output"]),
  },
  "documentation-only": {
    required: new Set(["documentation-only"]),
    allowed: new Set(["documentation-only"]),
  },
  "not-detected": {
    required: new Set(["installed-artifact", "command-output"]),
    allowed: new Set(["installed-artifact", "command-output"]),
  },
  "not-available": { required: new Set(), allowed: new Set() },
  unknown: {
    required: new Set(),
    allowed: new Set(["installed-artifact", "command-output", "runtime-observed", "runtime-session", "documentation-only"]),
  },
};

// ---------------------------------------------------------------------------
// Deterministic static marker scan. The scanner is pure: the same bytes and
// token list always produce the same counts, and the digest is a hash of the
// normalized scan record. Tests exercise it against synthetic artifacts; the
// probe machine can re-derive the recorded counts with --scan.
// ---------------------------------------------------------------------------

export function scanBufferForMarkers(buffer, tokens) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer);
  const counts = {};
  for (const token of tokens) {
    let count = 0;
    let index = 0;
    if (token.length > 0) {
      while ((index = text.indexOf(token, index)) !== -1) {
        count += 1;
        index += token.length;
      }
    }
    counts[token] = count;
  }
  return counts;
}

// A scan may target a single artifact or a directory collection matched by a
// glob (for example Gemini CLI ships its MCP code across `chunk-*.js`). The
// collection descriptor is part of the digest so the recorded counts stay bound
// to the source shape, and `--scan` re-derives counts from the sorted, deduped
// file set rather than a single guessed path.

// Minimal, deterministic glob: `*` matches any run (including empty) and `?`
// matches one character, both within a single path segment. Everything else is
// escaped literally. Collections enumerate one flat directory.
export function globToRegExp(pattern) {
  let source = "";
  for (const char of String(pattern)) {
    if (char === "*") source += "[^/\\\\]*";
    else if (char === "?") source += "[^/\\\\]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// Checked-in JSON/Markdown are compared as authored LF text even when Git
// checks them out with CRLF on Windows (core.autocrlf=true). Normalizing the
// read side keeps the drift check byte-stable across platforms without
// rewriting the authored artifacts.
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n");
}

// Resolve a collection scan to a stable, deduplicated, lexicographically sorted
// list of matching files inside the given directory. `readDirectory` is
// injectable so tests can exercise ordering and dedup without a real FS.
export async function resolveCollectionFiles(directory, collection, { readDirectory = readdir } = {}) {
  const matcher = globToRegExp(collection.pattern);
  let entries;
  try {
    entries = await readDirectory(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `collection scan expects a directory containing "${collection.pattern}": ${error?.message || error}`,
    );
  }
  const names = entries
    .filter((entry) => typeof entry?.isFile === "function" && entry.isFile() && matcher.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const unique = [...new Set(names)];
  if (unique.length === 0) throw new Error(`no files matched "${collection.pattern}" in the given directory`);
  return unique.map((name) => path.join(directory, name));
}

export function normalizeCollection(collection) {
  if (!collection) return undefined;
  return { kind: collection.kind, pattern: collection.pattern };
}

export function staticScanDigest({ artifact, tokens, counts, collection }) {
  const normalized = {
    recipeVersion: STATIC_SCAN_RECIPE_VERSION,
    artifact,
    tokens: [...tokens],
    counts: Object.fromEntries(tokens.map((token) => [token, counts?.[token] ?? 0])),
  };
  const normalizedCollection = normalizeCollection(collection);
  if (normalizedCollection) normalized.collection = normalizedCollection;
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// Recorded marker scans. Counts were captured read-only on the probe machine
// and are re-derivable (not re-scanned by --check) with --scan.
export const STATIC_SCANS = {
  "codex-exe-0.151.0": {
    artifact: "@openai/codex-win32-x64/vendor/bin/codex.exe (0.151.0)",
    hostId: "codex-cli",
    tokens: ["tool_search", "defer_loading", "list_changed", "listChanged", "always_defer", "executor_capability_discovery"],
    counts: {
      tool_search: 66,
      defer_loading: 3,
      list_changed: 76,
      listChanged: 11,
      always_defer: 8,
      executor_capability_discovery: 8,
    },
  },
  "gemini-cli-bundle-0.57.0": {
    artifact: "@google/gemini-cli/bundle (0.57.0)",
    hostId: "gemini-cli",
    collection: {
      kind: "glob",
      pattern: "chunk-*.js",
      note:
        "Gemini CLI 0.57.0 splits its bundled MCP/tool-discovery code across @google/gemini-cli/bundle/chunk-*.js; --scan enumerates this directory in sorted, deduped order and aggregates every matching file.",
    },
    tokens: ["includeTools", "excludeTools", "list_changed", "listChanged", "toolDiscovery", "tool_search", "defer_loading"],
    counts: {
      includeTools: 125,
      excludeTools: 217,
      list_changed: 46,
      listChanged: 65,
      toolDiscovery: 16,
      tool_search: 0,
      defer_loading: 0,
    },
  },
  "opencode-bin-1.18.25": {
    artifact: "opencode 1.18.25 binary",
    hostId: "opencode",
    tokens: ["tool_search", "toolSearch", "defer_loading", "list_changed", "listChanged", "excludeTools"],
    counts: {
      tool_search: 256,
      toolSearch: 16,
      defer_loading: 7,
      list_changed: 6,
      listChanged: 15,
      excludeTools: 10,
    },
  },
  "cursor-workbench-3.21.16": {
    artifact: "Cursor 3.21.16 resources/app/out/vs/workbench/workbench.desktop.main.js",
    hostId: "cursor",
    tokens: ["tool_search", "toolSearch", "defer_loading", "list_changed", "listChanged"],
    counts: { tool_search: 0, toolSearch: 0, defer_loading: 0, list_changed: 4, listChanged: 3 },
  },
  "vscode-workbench-1.134.0": {
    artifact: "VS Code 1.134.0 workbench.desktop.main.js",
    hostId: "vscode",
    tokens: ["tool_search", "toolSearch", "defer_loading", "list_changed", "listChanged"],
    counts: { tool_search: 8, toolSearch: 13, defer_loading: 0, list_changed: 4, listChanged: 7 },
  },
  "workbuddy-asar-5.4.5": {
    artifact: "WorkBuddy 5.4.5 resources/app.asar",
    hostId: "workbuddy",
    tokens: ["tool_search", "defer_loading", "list_changed", "listChanged", "mcpServers", "tools/list"],
    counts: {
      tool_search: 9,
      defer_loading: 41,
      list_changed: 71,
      listChanged: 124,
      mcpServers: 437,
      "tools/list": 76,
    },
  },
};

// ---------------------------------------------------------------------------
// Evidence registry. Summaries are redacted: no credentials, tokens, or
// personal absolute paths.
// ---------------------------------------------------------------------------

export const EVIDENCE = {
  "pi-extensions-dynamic-tool-loading": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "@earendil-works/pi-coding-agent/docs/extensions.md#dynamic-tool-loading",
    summary:
      "Documents the loader pattern: register every tool, keep a loader tool active, activate searchable tools at runtime with pi.setActiveTools(); the model receives the updated tool list on the next request.",
  },
  "pi-ai-deferred-tool-loading": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai (OpenAI Responses path)",
    summary:
      "Provider serialization emits defer_loading for tool-search results and tool_search_call/tool_search_output items.",
  },
  "pi-changelog-deferred-documents": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "@earendil-works/pi-coding-agent/CHANGELOG.md",
    summary:
      "Changelog records inherited native deferred tool loading for OpenAI Responses, Fireworks, and Kimi models (issues #7709, #9323, #7199).",
  },
  "pi-obsidian-mcp-extension": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "Pi user extension .pi/agent/extensions/obsidian-mcp/index.ts",
    summary:
      "Bridge connects once at extension init, calls client.listTools(), and registers every tool with pi.registerTool(). It does not call pi.setActiveTools() and registers no notifications/tools/list_changed handler.",
  },
  "pi-session-observation": {
    kind: "runtime-session",
    verification: "external-attestation",
    source: "This conversation (PI_SESSION_ID present; model deepseek-v4.1-flash via opencode-go)",
    summary:
      "All 85 Obsidian MCP tools arrived as mcp_obsidian_* definitions with full input schemas. No loader tool and no deferred block was used.",
  },
  "codex-features-list": {
    kind: "command-output",
    verification: "external-attestation",
    source: "codex features list (codex-cli 0.151.0)",
    summary:
      "Reports tool_search (stage removed), tool_search_always_defer_mcp_tools (stage removed, effective true), skill_search (stable, true), deferred_executor / deferred_tool_world_state / executor_capability_discovery / non_prefixed_mcp_tool_names / mcp_2026_07_28 (under development, false).",
  },
  "codex-binary-tokens": {
    kind: "installed-artifact",
    verification: "static-digest",
    scanId: "codex-exe-0.151.0",
    source: "@openai/codex-win32-x64 vendor bin/codex.exe",
    summary:
      "Binary contains tool_search / tool_search_call / tool_search_output response items, defer_loading on ResponsesApiTool, always_defer flags, and a notifications/tools/list_changed constraint.",
  },
  "codex-mcp-add-help": {
    kind: "command-output",
    verification: "external-attestation",
    source: "codex mcp add --help (codex-cli 0.151.0)",
    summary:
      "Per-server flags are URL/command, env, bearer-token env var, and OAuth options; no per-server include/exclude tool filter is exposed.",
  },
  "gemini-bundle-tokens": {
    kind: "installed-artifact",
    verification: "static-digest",
    scanId: "gemini-cli-bundle-0.57.0",
    source: "@google/gemini-cli/bundle (chunk-*.js)",
    summary:
      "Token counts aggregated across the sorted, deduped chunk-*.js collection: includeTools 125, excludeTools 217, list_changed 46, listChanged 65, toolDiscovery 16; tool_search 0, defer_loading 0.",
  },
  "gemini-mcp-doc": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "@google/gemini-cli/bundle/docs/tools/mcp-server.md",
    summary:
      "discoverMcpTools() fetches tool definitions from each server and registers them in a global registry; includeTools/excludeTools are static allow/deny lists.",
  },
  "gemini-settings-mcp": {
    kind: "command-output",
    verification: "external-attestation",
    source: "gemini mcp list (gemini-cli 0.57.0)",
    summary: "No MCP servers configured in the local profile.",
  },
  "opencode-binary-tokens": {
    kind: "installed-artifact",
    verification: "static-digest",
    scanId: "opencode-bin-1.18.25",
    source: "opencode 1.18.25 binary",
    summary:
      "Token counts: tool_search 256, toolSearch 16, defer_loading 7, list_changed 6, listChanged 15, excludeTools 10.",
  },
  "opencode-mcp-listchanged": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "opencode 1.18.25 binary (MCP client)",
    summary:
      "MCP client binds notifications/tools/list_changed with autoRefresh default true and debounceMs 300, and installs list-changed handlers.",
  },
  "opencode-provider-toolsearch": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "opencode 1.18.25 binary (provider layer)",
    summary:
      "Bundles the OpenAI tool_search provider tool and Anthropic toolSearchBm25 / toolSearchRegex tools, plus defer_loading serialization.",
  },
  "opencode-mcp-list": {
    kind: "command-output",
    verification: "external-attestation",
    source: "opencode mcp list (opencode 1.18.25)",
    summary: "One configured remote MCP server reported connected.",
  },
  "cursor-workbench-tokens": {
    kind: "installed-artifact",
    verification: "static-digest",
    scanId: "cursor-workbench-3.21.16",
    source: "Cursor 3.21.16 resources/app/out/vs/workbench/workbench.desktop.main.js",
    summary:
      "Token counts: tool_search 0, toolSearch 0, defer_loading 0, list_changed 4, listChanged 3; MCP client lists tools through a paginated tools/list request.",
  },
  "cursor-listchanged-handler": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "Cursor 3.21.16 workbench bundle",
    summary:
      "MCP client routes notifications/tools/list_changed to an onDidChangeToolList event.",
  },
  "vscode-workbench-tokens": {
    kind: "installed-artifact",
    verification: "static-digest",
    scanId: "vscode-workbench-1.134.0",
    source: "VS Code 1.134.0 workbench.desktop.main.js",
    summary:
      "Token counts: tool_search 8, toolSearch 13, defer_loading 0, list_changed 4, listChanged 7.",
  },
  "vscode-toolsearch-setting": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "VS Code 1.134.0 workbench bundle settings schema",
    summary:
      "Exposes chat.agentHost.copilot.toolSearch.enabled (default true) and chat.agentHost.copilot.toolSearch.deferThreshold, and handles tool_search_output transcript entries.",
  },
  "vscode-listchanged-handler": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "VS Code 1.134.0 workbench bundle",
    summary:
      "MCP client routes notifications/tools/list_changed to an onDidChangeToolList event.",
  },
  "workbuddy-asar-tokens": {
    kind: "installed-artifact",
    verification: "static-digest",
    scanId: "workbuddy-asar-5.4.5",
    source: "WorkBuddy 5.4.5 resources/app.asar",
    summary:
      "Token counts: tool_search 9, defer_loading 41, list_changed 71, listChanged 124, mcpServers 437, tools/list 76.",
  },
  "workbuddy-tool-registry": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "WorkBuddy 5.4.5 app.asar tool-call registry",
    summary:
      "Normalizes ToolSearch/tool_search and DeferExecuteTool/defer_execute_tool tool names.",
  },
  "workbuddy-defer-loading-default": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "WorkBuddy 5.4.5 app.asar MCP server sanitizer",
    summary:
      "Builds each MCP server entry with defer_loading defaulting to false for non-builtin servers unless the server config sets it.",
  },
  "server-tools-listchanged": {
    kind: "runtime-observed",
    verification: "repository-test",
    source: "app/ node --test in-process McpServer handshake (SDK 1.30.0)",
    summary:
      "A local in-process McpServer + registerObsidianCapabilities + client.connect() handshake reports tools.listChanged: true; reproduced by app/test/host-tool-discovery-probe.test.js.",
  },
  "server-eager-catalog": {
    kind: "installed-artifact",
    verification: "static-excerpt",
    source: "docs/review/tool-discovery/inventory.md (Wave 1)",
    summary:
      "registerObsidianCapabilities registers all 85 tools unconditionally; tools/list is not filtered by scope, Vault allowlist, or read-only mode.",
  },
  "server-inprocess-catalog-wave4": {
    kind: "runtime-observed",
    verification: "repository-test",
    source: "app/ node --test in-process McpServer + client.listTools() (SDK 1.30.0)",
    summary:
      "A real in-process MCP client session lists exactly 85 tools from registerObsidianCapabilities while the server advertises tools.listChanged: true; reproduced by app/test/host-tool-discovery-probe.test.js.",
  },
  "pi-session-wave4": {
    kind: "runtime-session",
    verification: "external-attestation",
    source: "This conversation (PI_SESSION_ID present; model deepseek-v4.1-flash via opencode-go; Pi 0.87.1)",
    summary:
      "All 85 Obsidian MCP tools arrived as mcp_obsidian_* definitions with full input schemas; no loader tool and no deferred block was used. The installed bridge still registers every tool eagerly and installs no notifications/tools/list_changed handler.",
  },
  "codex-mcp-config-wave4": {
    kind: "command-output",
    verification: "external-attestation",
    source: "codex mcp list / codex mcp get obsidian (codex-cli 0.151.0)",
    summary:
      "An `obsidian` streamable_http MCP server is configured and enabled with an API-key header. The CLI reports configuration only; no tool count, deferral, or refresh behavior is observable from this command.",
  },
  "opencode-mcp-connection-wave4": {
    kind: "command-output",
    verification: "external-attestation",
    source: "opencode mcp list (opencode 1.18.25)",
    summary:
      "One configured remote MCP server `obsidian_server` is reported connected over HTTPS. The CLI reports connection status only; no tool count or deferral behavior is observable from this command.",
  },
  "gemini-mcp-config-wave4": {
    kind: "command-output",
    verification: "external-attestation",
    source: "gemini mcp list (gemini-cli 0.57.0)",
    summary:
      "No MCP servers are configured in the local Gemini CLI profile, so no Gemini MCP session could be observed.",
  },
};

// ---------------------------------------------------------------------------
// Authored matrix.
// ---------------------------------------------------------------------------

export const HOSTS = [
  {
    id: "pi",
    displayName: "Pi coding agent",
    family: "pi",
    clientKind: "cli-agent-harness",
    version: "0.87.1",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "real",
        tier: "artifact-declared",
        evidence: [
          "pi-extensions-dynamic-tool-loading",
          "pi-ai-deferred-tool-loading",
          "pi-changelog-deferred-documents",
        ],
        note: "Host-level capability: extensions can hold tools inactive and activate them with pi.setActiveTools(), and the provider layer can emit deferred tool loading. The installed Obsidian MCP bridge does not use either.",
      },
      nativeSchemaAutoLoad: {
        value: "eager-auto",
        tier: "runtime-observed",
        evidence: ["pi-obsidian-mcp-extension", "pi-session-observation", "pi-session-wave4"],
        note: "This session received all 85 obsidian tools with full input schemas; the bridge calls listTools() then registers every tool.",
      },
      listRefresh: {
        value: "not-detected",
        tier: "artifact-declared",
        evidence: ["pi-obsidian-mcp-extension"],
        note: "The bridge connects once and registers no notifications/tools/list_changed handler.",
      },
      crossSession: {
        value: "re-discovered-per-session",
        tier: "artifact-declared",
        evidence: ["pi-obsidian-mcp-extension"],
        note: "The extension factory connects and lists tools at process startup; a new process re-discovers.",
      },
    },
  },
  {
    id: "codex-cli",
    displayName: "OpenAI Codex CLI",
    family: "codex",
    clientKind: "cli-agent",
    version: "0.151.0",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "real",
        tier: "artifact-declared",
        evidence: ["codex-features-list", "codex-binary-tokens"],
        note: "Binary contains tool_search, tool_search_call/tool_search_output items and defer_loading, and the tool_search_always_defer_mcp_tools flag reports effective true. The standalone tool_search flag reports stage removed. Runtime default was not exercised.",
      },
      nativeSchemaAutoLoad: {
        value: "unknown",
        tier: "unknown",
        evidence: ["codex-binary-tokens"],
        note: "Deferral flags and defer_loading exist, but the effective default for this build was not exercised against a live MCP connection.",
      },
      listRefresh: {
        value: "implemented",
        tier: "artifact-declared",
        evidence: ["codex-binary-tokens"],
        note: "Binary constrains the notifications/tools/list_changed method string.",
      },
      crossSession: {
        value: "unknown",
        tier: "unknown",
        evidence: [],
        note: "Not measured in this task.",
      },
    },
  },
  {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    family: "gemini",
    clientKind: "cli-agent",
    version: "0.57.0",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "eager-fallback",
        tier: "artifact-declared",
        evidence: ["gemini-mcp-doc", "gemini-bundle-tokens"],
        note: "discoverMcpTools() fetches each server's full tool definitions and registers them; includeTools/excludeTools are static filters; no tool_search or defer_loading tokens were found.",
      },
      nativeSchemaAutoLoad: {
        value: "eager-auto",
        tier: "artifact-declared",
        evidence: ["gemini-mcp-doc"],
        note: "Discovery fetches and registers the full tool set from every configured server.",
      },
      listRefresh: {
        value: "unknown",
        tier: "unknown",
        evidence: ["gemini-bundle-tokens"],
        note: "SDK notification schemas are bundled, but no host path that re-lists tools on notifications/tools/list_changed was found.",
      },
      crossSession: {
        value: "unknown",
        tier: "unknown",
        evidence: [],
        note: "Not measured in this task.",
      },
    },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    family: "opencode",
    clientKind: "cli-agent",
    version: "1.18.25",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "real",
        tier: "artifact-declared",
        evidence: ["opencode-provider-toolsearch", "opencode-binary-tokens"],
        note: "Bundles the OpenAI tool_search provider tool and Anthropic toolSearchBm25/toolSearchRegex tools plus defer_loading. Whether the remote Obsidian MCP tools are deferred depends on the configured provider/model.",
      },
      nativeSchemaAutoLoad: {
        value: "unknown",
        tier: "unknown",
        evidence: ["opencode-provider-toolsearch"],
        note: "Provider-native deferral exists, but the load behavior for a third-party MCP server was not exercised.",
      },
      listRefresh: {
        value: "implemented",
        tier: "artifact-declared",
        evidence: ["opencode-mcp-listchanged"],
        note: "MCP client declares notifications/tools/list_changed with autoRefresh default true and debounceMs 300.",
      },
      crossSession: {
        value: "unknown",
        tier: "unknown",
        evidence: [],
        note: "Not measured in this task.",
      },
    },
  },
  {
    id: "cursor",
    displayName: "Cursor",
    family: "cursor",
    clientKind: "ide-agent",
    version: "3.21.16",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "unknown",
        tier: "not-detected",
        evidence: ["cursor-workbench-tokens"],
        note: "No tool_search or defer_loading tokens were found in the workbench bundle. Absence of these tokens is not proof that Cursor always loads tools eagerly.",
      },
      nativeSchemaAutoLoad: {
        value: "unknown",
        tier: "not-detected",
        evidence: ["cursor-workbench-tokens"],
        note: "The MCP client lists tools through tools/list; no deferral path was found in the bundle.",
      },
      listRefresh: {
        value: "implemented",
        tier: "artifact-declared",
        evidence: ["cursor-listchanged-handler"],
        note: "MCP client routes notifications/tools/list_changed to an onDidChangeToolList event.",
      },
      crossSession: {
        value: "unknown",
        tier: "unknown",
        evidence: [],
        note: "Not measured in this task.",
      },
    },
  },
  {
    id: "vscode",
    displayName: "Visual Studio Code",
    family: "vscode",
    clientKind: "ide-agent",
    version: "1.134.0",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "real",
        tier: "artifact-declared",
        evidence: ["vscode-toolsearch-setting", "vscode-workbench-tokens"],
        note: "Exposes chat.agentHost.copilot.toolSearch.enabled (default true) and toolSearch.deferThreshold, and handles tool_search_output transcript entries. Scoped to the Copilot agent host; applicability to arbitrary MCP servers is unverified.",
      },
      nativeSchemaAutoLoad: {
        value: "unknown",
        tier: "unknown",
        evidence: ["vscode-toolsearch-setting"],
        note: "A defer threshold exists for the Copilot agent host, but the load behavior for a third-party MCP server was not exercised.",
      },
      listRefresh: {
        value: "implemented",
        tier: "artifact-declared",
        evidence: ["vscode-listchanged-handler"],
        note: "MCP client routes notifications/tools/list_changed to an onDidChangeToolList event.",
      },
      crossSession: {
        value: "unknown",
        tier: "unknown",
        evidence: [],
        note: "Not measured in this task.",
      },
    },
  },
  {
    id: "workbuddy",
    displayName: "WorkBuddy",
    family: "workbuddy",
    clientKind: "desktop-agent",
    version: "5.4.5",
    availability: "installed",
    cells: {
      toolDiscoveryMode: {
        value: "real",
        tier: "artifact-declared",
        evidence: ["workbuddy-tool-registry", "workbuddy-asar-tokens"],
        note: "Tool registry normalizes ToolSearch/tool_search and DeferExecuteTool/defer_execute_tool; MCP entries carry a defer_loading flag.",
      },
      nativeSchemaAutoLoad: {
        value: "eager-auto",
        tier: "artifact-declared",
        evidence: ["workbuddy-defer-loading-default"],
        note: "MCP server entries default defer_loading to false for non-builtin servers, so a third-party server loads schemas eagerly unless its config sets the flag.",
      },
      listRefresh: {
        value: "implemented",
        tier: "artifact-declared",
        evidence: ["workbuddy-asar-tokens"],
        note: "MCP client validates the notifications/tools/list_changed capability before accepting it.",
      },
      crossSession: {
        value: "unknown",
        tier: "unknown",
        evidence: [],
        note: "Not measured in this task.",
      },
    },
  },
];

export const NOT_AVAILABLE_HOSTS = [
  "claude-code",
  "claude-desktop",
  "windsurf",
  "aider",
  "zed",
  "goose",
  "openclaw",
  "hermes",
];

// ---------------------------------------------------------------------------
// Runtime session observations captured while building this matrix. These are
// separate from static artifact scans: each field is either an observed value
// or `null` (not observed). A null is never inferred from documentation or from
// a static marker. `redacted` must stay true; no credential or personal path is
// recorded here. Sessions are external attestations unless a repository test
// reproduces them.
// ---------------------------------------------------------------------------

export const SESSION_OBSERVED_FIELDS = [
  "toolCount",
  "nativeSchemaAutoLoad",
  "deferral",
  "listRefresh",
  "crossSession",
];

export const RUNTIME_SESSIONS = [
  {
    id: "pi-session-wave4",
    subject: "pi",
    capturedOn: "2026-09-25",
    method: "agent-session",
    toolCount: 85,
    nativeSchemaAutoLoad: "eager-auto",
    deferral: false,
    listRefresh: null,
    crossSession: null,
    evidence: ["pi-session-wave4", "pi-obsidian-mcp-extension"],
    redacted: true,
    note: "This conversation. The Pi host exposed all 85 Obsidian tools with full schemas and no tool-search/deferral mediation. list refresh and cross-session were not re-measured in this task.",
  },
  {
    id: "codex-mcp-config-wave4",
    subject: "codex-cli",
    capturedOn: "2026-09-25",
    method: "cli-command",
    toolCount: null,
    nativeSchemaAutoLoad: null,
    deferral: null,
    listRefresh: null,
    crossSession: null,
    evidence: ["codex-mcp-config-wave4"],
    redacted: true,
    note: "codex mcp list/get show an enabled obsidian streamable_http server. Configuration is not a tool-list observation, so every capability field stays null.",
  },
  {
    id: "opencode-mcp-connection-wave4",
    subject: "opencode",
    capturedOn: "2026-09-25",
    method: "cli-command",
    toolCount: null,
    nativeSchemaAutoLoad: null,
    deferral: null,
    listRefresh: null,
    crossSession: null,
    evidence: ["opencode-mcp-connection-wave4"],
    redacted: true,
    note: "opencode mcp list reports the obsidian_server connection as connected. Connection status is not a tool-list observation, so every capability field stays null.",
  },
  {
    id: "gemini-mcp-config-wave4",
    subject: "gemini-cli",
    capturedOn: "2026-09-25",
    method: "cli-command",
    toolCount: null,
    nativeSchemaAutoLoad: null,
    deferral: null,
    listRefresh: null,
    crossSession: null,
    evidence: ["gemini-mcp-config-wave4"],
    redacted: true,
    note: "gemini mcp list reports no configured servers, so no Gemini MCP session could be observed.",
  },
  {
    id: "server-inprocess-session-wave4",
    subject: "server",
    capturedOn: "2026-09-25",
    method: "in-process-mcp-handshake",
    toolCount: 85,
    nativeSchemaAutoLoad: "eager-auto",
    deferral: false,
    listRefresh: true,
    crossSession: null,
    evidence: ["server-inprocess-catalog-wave4", "server-tools-listchanged"],
    redacted: true,
    note: "In-process client session against registerObsidianCapabilities: 85 tools listed and tools.listChanged advertised true, with no deferral. Reproduced by the repository test suite.",
  },
];

// ---------------------------------------------------------------------------
// Build / validate / render.
// ---------------------------------------------------------------------------

function buildServerBaseline() {
  return {
    tool: "obsidian-mcp-server",
    catalogTools: 85,
    toolsListChangedCapability: true,
    toolsListChangedTier: "runtime-observed",
    toolsListChangedEvidence: ["server-tools-listchanged"],
    eagerRegistrationEvidence: ["server-eager-catalog", "server-inprocess-catalog-wave4"],
    note: "The server advertises tools.listChanged: true and registers all 85 tools eagerly. Host-side visibility is not authorization; every tools/call is still scope-checked.",
  };
}

export function buildMatrix() {
  const staticScans = Object.fromEntries(
    Object.entries(STATIC_SCANS)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, scan]) => [id, { id, ...scan, digest: staticScanDigest(scan) }]),
  );
  const evidence = Object.fromEntries(
    Object.entries(EVIDENCE)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, entry]) => [id, { id, ...entry }]),
  );
  const runtimeSessions = [...RUNTIME_SESSIONS]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((session) => ({ id: session.id, ...session }));
  const verificationCounts = countBy(
    Object.values(evidence),
    (entry) => entry.verification,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: "app/scripts/probe-host-tool-discovery.mjs",
    phase: "Phase 0 — host defer/tool-search capability matrix",
    status: "candidate",
    readOnly: true,
    authoredCommit: AUTHORED_COMMIT,
    scope:
      "Characterization of installed MCP-client hosts. No runtime, registration, capability, scope, or Vault behavior is changed.",
    verificationPolicy: {
      note:
        "--check verifies schema, vocabulary, evidence references, tier/evidence-kind correspondence, static-scan digests over recorded marker counts (single-file or glob-collection scans), and checked-in JSON/Markdown drift. It does not re-scan host artifacts and does not verify external attestations.",
      verifiedByCheck: [
        "static marker counts are hashed and the digest is recomputed",
        "tier/evidence-kind correspondence for every cell",
        "checked-in JSON and Markdown match the authored data",
      ],
      notVerifiedByCheck: [
        "recorded marker counts still matching the currently installed host artifacts (re-run with --scan <scanId>=<path>; collection scans take the bundle directory)",
        "runtime-session / command-output observations captured outside this repository",
        "static excerpts that were read by hand from an installed artifact",
      ],
    },
    evidenceTiers: EVIDENCE_TIERS,
    evidenceKinds: [...EVIDENCE_KINDS].sort(),
    evidenceVerification: EVIDENCE_VERIFICATION,
    toolDiscoveryModes: TOOL_DISCOVERY_MODES,
    schemaLoadModes: SCHEMA_LOAD_MODES,
    listRefreshModes: LIST_REFRESH_MODES,
    crossSessionModes: CROSS_SESSION_MODES,
    staticScanRecipeVersion: STATIC_SCAN_RECIPE_VERSION,
    staticScans,
    evidence,
    runtimeSessions,
    evidenceVerificationCounts: verificationCounts,
    serverBaseline: buildServerBaseline(),
    counts: {
      hosts: HOSTS.length,
      runtimeSessions: RUNTIME_SESSIONS.length,
      byToolDiscoveryMode: countBy(HOSTS, (host) => host.cells.toolDiscoveryMode.value),
      bySchemaLoadMode: countBy(HOSTS, (host) => host.cells.nativeSchemaAutoLoad.value),
      byListRefreshMode: countBy(HOSTS, (host) => host.cells.listRefresh.value),
      byCrossSessionMode: countBy(HOSTS, (host) => host.cells.crossSession.value),
      byTier: countBy(
        HOSTS.flatMap((host) => Object.values(host.cells).map((c) => c.tier)),
        (tier) => tier,
      ),
    },
    hosts: structuredClone([...HOSTS]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    notAvailableHosts: [...NOT_AVAILABLE_HOSTS].sort(),
    unknowns: [
      "No host was driven through an end-to-end agent task in this task.",
      "Runtime tool-list/deferral behavior of installed hosts against a live MCP server was not exercised except for Pi's own session.",
      "Cross-session persistence was not measured for any host.",
      "Codex, OpenCode, and Gemini were observed only at the configuration/connection layer, not at the tool-list layer.",
      "External documentation of hosts that are not installed was not consulted, so no host is classified as documented-only.",
      "Byte sizes and token counts of the eager catalog are not repeated here; see docs/review/tool-discovery/inventory.md.",
      "Recorded marker counts are digest-checked but were not re-scanned by --check; re-derive them on the probe machine with --scan (a directory for collection scans).",
    ],
    measured: [
      "installed host binaries/artifacts were scanned once for defer/tool-search/list_changed markers (recorded counts are digest-checked)",
      "per-host classification into real / documented-only / eager-fallback / unknown with an evidence tier",
      "native schema auto-load, list refresh, and cross-session cells for each installed host",
      "actual local MCP connectivity for codex/opencode/gemini (config/connection status only; no tool list observed)",
      "runtime session records per host with explicit null for every field that was not observed",
      "Obsidian MCP server tools.listChanged capability and eager 85-tool catalog (reproduced by a repository in-process test)",
    ],
    notMeasured: [
      "re-scan of installed host artifacts by --check",
      "runtime tool-list/deferral behavior against a live MCP server for any host other than Pi",
      "tool count or deferral behavior for codex-cli, opencode, cursor, vscode, and workbuddy",
      "external attestations recorded outside this repository",
    ],
  };
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function validateStaticScans(matrix, fail) {
  const scans = matrix?.staticScans;
  const scanIds = new Set();
  if (!scans || typeof scans !== "object" || Array.isArray(scans)) {
    fail("staticScans must be an object");
    return scanIds;
  }
  for (const [id, scan] of Object.entries(scans)) {
    scanIds.add(id);
    if (scan?.id !== id) fail(`staticScans.${id}: id must match its key`);
    if (typeof scan?.artifact !== "string" || scan.artifact.trim() === "") fail(`staticScans.${id}: artifact is required`);
    if (scan?.collection !== undefined) {
      const collection = scan.collection;
      if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
        fail(`staticScans.${id}: collection must be an object`);
      } else {
        if (typeof collection.kind !== "string" || collection.kind.trim() === "") fail(`staticScans.${id}: collection.kind is required`);
        if (typeof collection.pattern !== "string" || collection.pattern.trim() === "") {
          fail(`staticScans.${id}: collection.pattern is required`);
        }
      }
    }
    if (!Array.isArray(scan?.tokens) || scan.tokens.length === 0) {
      fail(`staticScans.${id}: tokens must be a non-empty array`);
      continue;
    }
    if (new Set(scan.tokens).size !== scan.tokens.length) fail(`staticScans.${id}: tokens must be unique`);
    if (!scan?.counts || typeof scan.counts !== "object") {
      fail(`staticScans.${id}: counts are required`);
      continue;
    }
    for (const token of scan.tokens) {
      const value = scan.counts[token];
      if (!Number.isInteger(value) || value < 0) fail(`staticScans.${id}: counts.${token} must be a non-negative integer`);
    }
    const recomputed = staticScanDigest(scan);
    if (scan.digest !== recomputed) {
      fail(`staticScans.${id}: digest mismatch; recorded counts no longer match the scan digest`);
    }
  }
  return scanIds;
}

// Runtime session records carry observed values only. Every observed field that
// was not measured must be `null`; validation rejects guesses, unresolved
// evidence, unredacted records, and a non-null tool count that is not backed by
// runtime-kind evidence.
function validateRuntimeSessions(matrix, { evidenceIds, hostIds, fail }) {
  const sessions = matrix?.runtimeSessions;
  if (!Array.isArray(sessions)) {
    fail("runtimeSessions must be an array");
    return;
  }
  const seen = new Set();
  for (const session of sessions) {
    const label = session?.id || "(unknown session)";
    if (typeof session?.id !== "string" || session.id.trim() === "") {
      fail("runtimeSessions: every session requires a non-empty id");
      continue;
    }
    if (seen.has(session.id)) fail(`runtimeSessions.${session.id}: duplicate id`);
    seen.add(session.id);
    if (session.subject !== "server" && !hostIds.has(session.subject)) {
      fail(`${label}: subject "${session.subject}" is neither a known host nor "server"`);
    }
    if (typeof session.method !== "string" || session.method.trim() === "") fail(`${label}: method is required`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(session.capturedOn || ""))) fail(`${label}: capturedOn must be YYYY-MM-DD`);
    if (session.redacted !== true) fail(`${label}: redacted must be true`);
    if (typeof session.note !== "string" || session.note.trim() === "") fail(`${label}: note is required`);
    if (!Array.isArray(session.evidence) || session.evidence.length === 0) {
      fail(`${label}: evidence must be a non-empty array`);
    } else {
      for (const id of session.evidence) if (!evidenceIds.has(id)) fail(`${label}: unresolved evidence id "${id}"`);
    }
    for (const field of SESSION_OBSERVED_FIELDS) {
      if (!(field in session)) fail(`${label}: missing observed field ${field}`);
    }
    if (session.toolCount !== null && (!Number.isInteger(session.toolCount) || session.toolCount <= 0)) {
      fail(`${label}: toolCount must be null or a positive integer`);
    }
    if (session.nativeSchemaAutoLoad !== null && !(session.nativeSchemaAutoLoad in SCHEMA_LOAD_MODES)) {
      fail(`${label}: nativeSchemaAutoLoad must be null or a schema-load mode`);
    }
    for (const field of ["deferral", "listRefresh", "crossSession"]) {
      const value = session[field];
      if (value !== null && typeof value !== "boolean") fail(`${label}: ${field} must be null or boolean`);
    }
    if (session.toolCount !== null) {
      const kinds = (session.evidence || []).map((id) => matrix.evidence[id]?.kind).filter(Boolean);
      if (!kinds.some((kind) => kind === "runtime-observed" || kind === "runtime-session")) {
        fail(`${label}: a recorded toolCount requires runtime-observed/runtime-session evidence`);
      }
    }
  }
}

export function validateMatrix(matrix) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  if (matrix?.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (matrix?.readOnly !== true) fail("readOnly must be true");
  if (matrix?.status !== "candidate") fail("status must be candidate");
  if (typeof matrix?.authoredCommit !== "string" || !/^[0-9a-f]{40}$/.test(matrix.authoredCommit)) {
    fail("authoredCommit must be a 40-character hex SHA");
  }
  if (!Array.isArray(matrix?.hosts) || matrix.hosts.length === 0) fail("hosts must be a non-empty array");

  const scanIds = validateStaticScans(matrix, fail);
  const evidenceIds = new Set(Object.keys(matrix?.evidence || {}));
  const hostIds = new Set();

  for (const [id, entry] of Object.entries(matrix?.evidence || {})) {
    if (entry?.id !== id) fail(`evidence.${id}: id must match its key`);
    if (!EVIDENCE_KINDS.has(entry?.kind)) fail(`evidence.${id}: unknown kind "${entry?.kind}"`);
    if (!(entry?.verification in EVIDENCE_VERIFICATION)) {
      fail(`evidence.${id}: unknown verification "${entry?.verification}"`);
    }
    if (typeof entry?.summary !== "string" || entry.summary.trim() === "") fail(`evidence.${id}: summary is required`);
    if (entry?.verification === "static-digest") {
      if (typeof entry?.scanId !== "string") fail(`evidence.${id}: static-digest evidence requires a scanId`);
      else if (!scanIds.has(entry.scanId)) fail(`evidence.${id}: unresolved scanId "${entry.scanId}"`);
    } else if (entry?.scanId !== undefined) {
      fail(`evidence.${id}: scanId is only valid on static-digest evidence`);
    }
  }

  for (const host of matrix?.hosts || []) {
    const label = host?.id || "(unknown host)";
    if (!host?.id) fail("host without id");
    if (hostIds.has(host?.id)) fail(`${label}: duplicate host id`);
    hostIds.add(host?.id);
    for (const key of ["displayName", "family", "clientKind", "version", "availability"]) {
      if (typeof host?.[key] !== "string" || host[key].trim() === "") fail(`${label}: ${key} must be a non-empty string`);
    }
    for (const [cellName, vocabulary] of Object.entries(CELL_VOCABULARIES)) {
      const c = host?.cells?.[cellName];
      if (!c) {
        fail(`${label}: missing cell ${cellName}`);
        continue;
      }
      if (!vocabulary.has(c.value)) fail(`${label}.${cellName}: unknown value "${c.value}"`);
      if (!(c.tier in EVIDENCE_TIERS)) fail(`${label}.${cellName}: unknown tier "${c.tier}"`);
      if (!Array.isArray(c.evidence)) fail(`${label}.${cellName}: evidence must be an array`);
      const cited = (c.evidence || []).map((id) => matrix.evidence[id]).filter(Boolean);
      for (const id of c.evidence || []) {
        if (!evidenceIds.has(id)) fail(`${label}.${cellName}: unresolved evidence id "${id}"`);
      }
      const rule = TIER_EVIDENCE_KINDS[c.tier];
      if (rule && (rule.required.size > 0 || rule.allowed.size > 0)) {
        const kinds = cited.map((entry) => entry.kind);
        if (rule.required.size > 0 && !kinds.some((kind) => rule.required.has(kind))) {
          fail(
            `${label}.${cellName}: tier "${c.tier}" requires at least one evidence kind of ${[...rule.required].join("/")}`,
          );
        }
        for (const kind of kinds) {
          if (!rule.allowed.has(kind)) fail(`${label}.${cellName}: tier "${c.tier}" cannot cite ${kind} evidence`);
        }
      }
      if ((c.tier === "unknown" || c.tier === "not-detected" || c.value === "unknown") && typeof c.note !== "string") {
        fail(`${label}.${cellName}: unknown/not-detected cells must carry a note`);
      }
    }

    const mode = host?.cells?.toolDiscoveryMode;
    if (mode) {
      if (mode.value === "real" && !["runtime-observed", "artifact-declared"].includes(mode.tier)) {
        fail(`${label}: toolDiscoveryMode=real requires runtime-observed or artifact-declared tier`);
      }
      if (mode.value === "real" && mode.evidence.length === 0) {
        fail(`${label}: toolDiscoveryMode=real requires at least one evidence id`);
      }
      if (mode.value === "documented-only" && mode.tier !== "documentation-only") {
        fail(`${label}: toolDiscoveryMode=documented-only requires documentation-only tier`);
      }
      if (mode.value === "eager-fallback" && !["artifact-declared", "runtime-observed", "not-detected"].includes(mode.tier)) {
        fail(`${label}: toolDiscoveryMode=eager-fallback requires artifact-declared, runtime-observed, or not-detected tier`);
      }
    }
  }

  validateRuntimeSessions(matrix, { evidenceIds, hostIds, fail });

  const baseline = matrix?.serverBaseline;
  if (!baseline) {
    fail("serverBaseline is required");
  } else {
    if (!Number.isInteger(baseline.catalogTools) || baseline.catalogTools <= 0) {
      fail("serverBaseline.catalogTools must be a positive integer");
    }
    if (!(baseline.toolsListChangedTier in EVIDENCE_TIERS)) fail(`serverBaseline: unknown tier "${baseline.toolsListChangedTier}"`);
    const refs = Array.isArray(baseline.toolsListChangedEvidence) ? baseline.toolsListChangedEvidence : [];
    if (refs.length === 0) fail("serverBaseline.toolsListChangedEvidence must be a non-empty array");
    for (const id of refs) if (!evidenceIds.has(id)) fail(`serverBaseline: unresolved evidence id "${id}"`);
    const rule = TIER_EVIDENCE_KINDS[baseline.toolsListChangedTier];
    const kinds = refs.map((id) => matrix.evidence[id]?.kind).filter(Boolean);
    if (rule?.required.size > 0 && !kinds.some((kind) => rule.required.has(kind))) {
      fail(`serverBaseline: tier "${baseline.toolsListChangedTier}" requires matching runtime/observed evidence`);
    }
  }

  if (!Array.isArray(matrix?.notAvailableHosts)) fail("notAvailableHosts must be an array");
  for (const id of matrix?.notAvailableHosts || []) {
    if (hostIds.has(id)) warnings.push(`host ${id} is both available and not-available`);
  }
  if (!Array.isArray(matrix?.unknowns) || matrix.unknowns.length === 0) {
    warnings.push("matrix records no unknowns");
  }
  if (!Array.isArray(matrix?.notMeasured) || matrix.notMeasured.length === 0) {
    warnings.push("matrix records no notMeasured entries");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function renderMarkdown(matrix) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push("# Progressive Tool Discovery — Phase 0 host defer/tool-search capability matrix");
  push();
  push(`Status: **${matrix.status}** (branch artifact; baselines main \`${matrix.authoredCommit}\`).`);
  push(`Schema: \`${matrix.schemaVersion}\`. Read-only characterization.`);
  push();
  push(
    [
      "This table records what is **actually provable** about each locally installed MCP-client host.",
      "A `real` classification requires an installed artifact or a runtime observation; a host that",
      "was not measured is `unknown`, never assumed supported.",
    ].join(" "),
  );
  push();
  push(
    [
      "`--check` recomputes the static-scan digests over **recorded** marker counts and enforces",
      "tier/evidence-kind correspondence. It does **not** re-scan host artifacts and does not verify",
      "outside-the-repository runtime or command observations; those are external attestations.",
    ].join(" "),
  );
  push();
  push("## Matrix");
  push();
  push("| Host | Version | Tool discovery | Native schema auto-load | list refresh | Cross-session |");
  push("| --- | --- | --- | --- | --- | --- |");
  for (const host of matrix.hosts) {
    const c = host.cells;
    push(
      `| \`${host.id}\` | ${host.version} | ${c.toolDiscoveryMode.value} (${c.toolDiscoveryMode.tier}) | ` +
        `${c.nativeSchemaAutoLoad.value} (${c.nativeSchemaAutoLoad.tier}) | ` +
        `${c.listRefresh.value} (${c.listRefresh.tier}) | ` +
        `${c.crossSession.value} (${c.crossSession.tier}) |`,
    );
  }
  push();
  push("## Per-host notes");
  push();
  for (const host of matrix.hosts) {
    push(`### ${host.displayName} (\`${host.id}\`)`);
    push();
    push(`- Family: ${host.family}; client kind: ${host.clientKind}; availability: ${host.availability}.`);
    for (const [name, c] of Object.entries(host.cells)) {
      push(`- **${name}**: ${c.value} — ${c.tier}. ${c.note}`);
      if (c.evidence.length) {
        const refs = c.evidence.map((id) => {
          const entry = matrix.evidence[id];
          return `\`${id}\` (${entry?.kind || "?"}, ${entry?.verification || "?"})`;
        });
        push(`  - evidence: ${refs.join(", ")}`);
      }
    }
    push();
  }
  push("## Runtime sessions observed in this task");
  push();
  push(
    "Actual sessions driven or observed while building this matrix. `unknown` means the field was not observed in that session; it is never inferred. These records are external attestations (except a repository-test session) and are not verified by `--check`.",
  );
  push();
  push("| Session | Subject | Method | Captured | Tool count | Native schema | Deferral | list refresh | Cross-session | Evidence |");
  push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const session of matrix.runtimeSessions) {
    const show = (value) => (value === null ? "unknown" : String(value));
    const evidence = session.evidence.map((id) => `\`${id}\``).join(", ");
    push(
      `| \`${session.id}\` | \`${session.subject}\` | ${session.method} | ${session.capturedOn} | ` +
        `${show(session.toolCount)} | ${show(session.nativeSchemaAutoLoad)} | ${show(session.deferral)} | ` +
        `${show(session.listRefresh)} | ${show(session.crossSession)} | ${evidence} |`,
    );
  }
  push();
  push("## Obsidian MCP server baseline");
  push();
  const s = matrix.serverBaseline;
  push(`- Catalog tools: ${s.catalogTools}.`);
  push(`- \`tools.listChanged\` advertised: ${s.toolsListChangedCapability} (${s.toolsListChangedTier}).`);
  push(`- ${s.note}`);
  push();
  push("## Counts");
  push();
  push(`- Hosts: ${matrix.counts.hosts}`);
  push(`- By tool discovery: ${JSON.stringify(matrix.counts.byToolDiscoveryMode)}`);
  push(`- By schema load: ${JSON.stringify(matrix.counts.bySchemaLoadMode)}`);
  push(`- By list refresh: ${JSON.stringify(matrix.counts.byListRefreshMode)}`);
  push(`- By cross-session: ${JSON.stringify(matrix.counts.byCrossSessionMode)}`);
  push(`- Runtime sessions: ${matrix.counts.runtimeSessions}`);
  push();
  push(`## Not installed (no capability claim): ${matrix.notAvailableHosts.map((id) => `\`${id}\``).join(", ")}`);
  push();
  push("## Static artifact scans");
  push();
  push(
    `Recipe \`${matrix.staticScanRecipeVersion}\`. Digests are recomputed by \`--check\`; re-derive the ` +
      "counts on the probe machine with `--scan <scanId>=<path>` (a directory for `collection` scans).",
  );
  push();
  push("| Scan id | Artifact | Source | Recorded marker counts | Digest |");
  push("| --- | --- | --- | --- | --- |");
  for (const scan of Object.values(matrix.staticScans)) {
    const counts = scan.tokens.map((token) => `${token}=${scan.counts[token]}`).join(", ");
    const source = scan.collection ? `\`${scan.collection.pattern}\` (directory)` : "single file";
    push(`| \`${scan.id}\` | ${scan.artifact} | ${source} | ${counts} | \`${scan.digest.slice(0, 12)}…\` |`);
  }
  push();
  push("## Verification scope");
  push();
  push("Verified by `--check`:");
  push();
  for (const item of matrix.verificationPolicy.verifiedByCheck) push(`- ${item}`);
  push();
  push("Not verified by `--check`:");
  push();
  for (const item of matrix.verificationPolicy.notVerifiedByCheck) push(`- ${item}`);
  push();
  push(`Evidence verification counts: ${JSON.stringify(matrix.evidenceVerificationCounts)}`);
  push();
  push("## Evidence kinds");
  push();
  push(matrix.evidenceKinds.map((kind) => `\`${kind}\``).join(", "));
  push();
  push("## Unknowns");
  push();
  for (const u of matrix.unknowns) push(`- ${u}`);
  push();
  push("## Not measured");
  push();
  for (const u of matrix.notMeasured) push(`- ${u}`);
  push();
  push("## Evidence tiers");
  push();
  push("| Tier | Meaning |");
  push("| --- | --- |");
  for (const [tier, meaning] of Object.entries(matrix.evidenceTiers)) push(`| \`${tier}\` | ${meaning} |`);
  push();
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Optional local detection. Best-effort, read-only, never required by --check.
// ---------------------------------------------------------------------------

export const DETECT_SPECS = [
  { id: "pi", command: ["pi", "--version"] },
  { id: "codex-cli", command: ["codex", "--version"], featureCommand: ["codex", "features", "list"] },
  { id: "gemini-cli", command: ["gemini", "--version"] },
  { id: "opencode", command: ["opencode", "--version"] },
  { id: "cursor", command: ["cursor", "--version"] },
  { id: "vscode", command: ["code", "--version"] },
];

export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b(sk|pk|api|key|token|bearer)[-_A-Za-z0-9]{12,}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[redacted]");
}

export function parseCodexFeatures(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s{2,}(\S+(?:\s\S+)*?)\s{2,}(true|false)\s*$/);
    if (!match) continue;
    rows.push({ name: match[1], stage: match[2].trim(), enabled: match[3] === "true" });
  }
  return rows;
}

function runCommand(command, timeoutMs = 20000) {
  // Detection commands are fixed internal literals, so a shell launch is safe and
  // resolves platform shims (``.cmd`` on Windows) the way an operator would.
  const line = command.join(" ");
  try {
    const result = spawnSync(line, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: true,
    });
    if (result.error) return { ok: false, error: String(result.error.message || result.error) };
    return { ok: result.status === 0, status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function detectEnvironment() {
  const hosts = DETECT_SPECS.map((spec) => {
    const version = runCommand(spec.command);
    const entry = {
      id: spec.id,
      installed: version.ok,
      versionOutput: version.ok ? redactSecrets((version.stdout || version.stderr).split(/\r?\n/)[0]).trim() : null,
    };
    if (spec.featureCommand && version.ok) {
      const features = runCommand(spec.featureCommand);
      if (features.ok) {
        entry.toolDiscoveryFeatures = parseCodexFeatures(features.stdout).filter((row) =>
          /tool|defer|search|discover|mcp/i.test(row.name),
        );
      }
    }
    return entry;
  });
  return {
    generatedBy: "app/scripts/probe-host-tool-discovery.mjs --detect",
    readOnly: true,
    note:
      "Best-effort local detection only; not part of the checked-in matrix and not a capability claim. " +
      "A host CLI version can differ between launch shims (for example bash versus a Windows .cmd shim); " +
      "the checked-in matrix records the version whose installed artifact was actually inspected.",
    hosts,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/probe-host-tool-discovery.mjs [--json|--markdown|--detect|--write|--check|--scan|--scan-list|--session-list]",
      "",
      "  --json                 print the capability matrix as JSON",
      "  --markdown             print the rendered Markdown matrix",
      "  --detect               probe the local machine for installed host CLIs (read-only)",
      "  --write                write host-matrix.json and host-matrix.md into docs/",
      "  --check                validate + fail on checked-in drift (default); does not re-scan artifacts",
      "  --scan <id>=<path>     re-scan a local artifact (or collection directory) with the recorded token recipe (repeatable)",
      "  --scan-list            list the recorded static scan ids, artifacts, and collection patterns",
      "  --session-list         list the recorded runtime session observations (observed fields; null = not observed)",
      "",
    ].join("\n"),
  );
}

export function parseScanSpecs(argv) {
  const raw = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan") raw.push(argv[++i] || "");
    else if (arg.startsWith("--scan=")) raw.push(arg.slice("--scan=".length));
  }
  return raw.map((spec) => {
    const eq = spec.indexOf("=");
    if (eq === -1) throw new Error(`--scan expects <scanId>=<path>, got "${spec}"`);
    return { scanId: spec.slice(0, eq), filePath: spec.slice(eq + 1) };
  });
}

// Re-derive recorded marker counts from a local artifact. A single-file scan
// reads one path; a collection scan enumerates the matching files inside a
// directory in stable sorted order, dedupes them, and aggregates counts.
export async function runStaticScans(
  specs,
  { scans = STATIC_SCANS, readArtifact = readFile, readDirectory = readdir } = {},
) {
  const results = [];
  for (const { scanId, filePath } of specs) {
    const scan = scans[scanId];
    if (!scan) {
      results.push({ scanId, filePath, ok: false, error: "unknown scanId" });
      continue;
    }
    try {
      const counts = Object.fromEntries(scan.tokens.map((token) => [token, 0]));
      let files = null;
      if (scan.collection) {
        files = await resolveCollectionFiles(filePath, scan.collection, { readDirectory });
        for (const file of files) {
          const buffer = await readArtifact(file);
          const fileCounts = scanBufferForMarkers(buffer, scan.tokens);
          for (const token of scan.tokens) counts[token] += fileCounts[token];
        }
      } else {
        const buffer = await readArtifact(filePath);
        const fileCounts = scanBufferForMarkers(buffer, scan.tokens);
        for (const token of scan.tokens) counts[token] = fileCounts[token];
      }
      const mismatches = scan.tokens
        .filter((token) => counts[token] !== (scan.counts[token] || 0))
        .map((token) => ({ token, expected: scan.counts[token] || 0, actual: counts[token] }));
      const result = {
        scanId,
        filePath,
        ok: mismatches.length === 0,
        expectedDigest: staticScanDigest(scan),
        actualDigest: staticScanDigest({ ...scan, counts }),
        mismatches,
      };
      if (files) {
        result.collectionPattern = scan.collection.pattern;
        result.matchedFiles = files.map((file) => path.basename(file));
        result.filesDigest = createHash("sha256")
          .update(files.map((file) => path.basename(file)).join("\n"))
          .digest("hex");
      }
      results.push(result);
    } catch (error) {
      results.push({ scanId, filePath, ok: false, error: String(error?.message || error) });
    }
  }
  return results;
}

async function writeMatrixFiles() {
  const matrix = buildMatrix();
  const validation = validateMatrix(matrix);
  if (!validation.ok) {
    throw new Error(`refusing to write invalid matrix:\n${validation.errors.join("\n")}`);
  }
  await mkdir(MATRIX_DIR, { recursive: true });
  await writeFile(MATRIX_JSON_PATH, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  await writeFile(MATRIX_MARKDOWN_PATH, renderMarkdown(matrix), "utf8");
  return matrix;
}

async function main(argv) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    printUsage();
    return 0;
  }
  if (args.has("--detect")) {
    process.stdout.write(`${JSON.stringify(detectEnvironment(), null, 2)}\n`);
    return 0;
  }
  if (args.has("--scan-list")) {
    for (const scan of Object.values(buildMatrix().staticScans)) {
      const target = scan.collection ? `${scan.artifact} [directory: ${scan.collection.pattern}]` : scan.artifact;
      process.stdout.write(`${scan.id}\t${target}\n`);
    }
    return 0;
  }
  if (args.has("--session-list")) {
    for (const session of buildMatrix().runtimeSessions) {
      process.stdout.write(
        `${session.id}\t${session.subject}\t${session.method}\ttoolCount=${session.toolCount ?? "unknown"}\n`,
      );
    }
    return 0;
  }
  if (args.has("--scan")) {
    const results = await runStaticScans(parseScanSpecs(argv));
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return results.every((result) => result.ok) ? 0 : 1;
  }
  if (args.has("--write")) {
    await writeMatrixFiles();
    process.stdout.write(`wrote ${path.relative(REPO_ROOT, MATRIX_JSON_PATH)} and ${path.relative(REPO_ROOT, MATRIX_MARKDOWN_PATH)}\n`);
    return 0;
  }
  if (args.has("--markdown")) {
    process.stdout.write(renderMarkdown(buildMatrix()));
    return 0;
  }
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify(buildMatrix(), null, 2)}\n`);
    return 0;
  }

  // Default: --check.
  const matrix = buildMatrix();
  const validation = validateMatrix(matrix);
  const errors = [...validation.errors];
  for (const warning of validation.warnings) process.stderr.write(`warn: ${warning}\n`);

  let expectedJson;
  let expectedMarkdown;
  try {
    expectedJson = `${JSON.stringify(matrix, null, 2)}\n`;
    expectedMarkdown = renderMarkdown(matrix);
  } catch (error) {
    errors.push(String(error?.message || error));
  }

  for (const [file, expected] of [
    [MATRIX_JSON_PATH, expectedJson],
    [MATRIX_MARKDOWN_PATH, expectedMarkdown],
  ]) {
    try {
      const actual = normalizeNewlines(await readFile(file, "utf8"));
      if (actual !== expected) errors.push(`${path.relative(REPO_ROOT, file)} drifts from the authored matrix`);
    } catch {
      errors.push(`${path.relative(REPO_ROOT, file)} is missing`);
    }
  }

  if (errors.length) {
    for (const error of errors) process.stderr.write(`error: ${error}\n`);
    return 1;
  }
  const c = matrix.evidenceVerificationCounts;
  process.stdout.write(
    `host-matrix OK: ${matrix.hosts.length} hosts, ${matrix.runtimeSessions.length} runtime sessions, ` +
      `${Object.keys(matrix.evidence).length} evidence entries, ` +
      `${Object.keys(matrix.staticScans).length} static-scan digests recomputed (counts NOT re-scanned; use --scan), ` +
      `external attestations ${c["external-attestation"] || 0}, static excerpts ${c["static-excerpt"] || 0}, ` +
      `repository tests ${c["repository-test"] || 0}\n`,
  );
  return 0;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
