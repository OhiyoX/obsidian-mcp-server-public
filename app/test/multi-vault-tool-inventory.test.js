// Multi-Vault Wave 0 / W0-B — canonical tool inventory matrix (characterization only).
//
// Contract: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库
// （vault scope）与按库 Git 配置.md`:
//   §7    canonical tool vault-scope registry (global = {agent_bootstrap, server_info})
//   §13.5 other cross-call handles
//   §25   W0-B: 87 canonical tools must have a 100% classification
//   §35   tool schema / contract tests (tool count and scopes unchanged)
//   §43   architecture tests 1/2/3 (`VAULT_SCOPED ∪ GLOBAL == TOOL_NAMES`, every registered
//         tool classified, auth must consume one canonical registry)
//   §44   old-red evidence: plan/upload handles are not vault-bound today
//
// Zero behavior change: this file only READS production sources and asserts the frozen table in
// `test/helpers/multi-vault-tool-classification.js`. No handler, schema, bundle or prod file is
// touched. Every name set is derived from a canonical source (TOOL_NAMES, the real registration
// capture, `src/tools/*.js`, `scopes.js`), never from a hard-coded count.
//
// Deterministic and offline: no clock, no network, no sleeps, no writes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerObsidianCapabilities } from "../src/capabilities.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_SCOPES, MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { registerContextTools } from "../src/tools/context.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerGitTools } from "../src/tools/git.js";
import { registerInfoTools } from "../src/tools/info.js";
import { registerIntelligenceTools } from "../src/tools/intelligence.js";
import { registerLinkTools } from "../src/tools/links.js";
import { registerNoteTools } from "../src/tools/notes.js";
import { registerPlanTools } from "../src/tools/plans.js";
import { registerPublishTools } from "../src/tools/publish.js";
import { registerSearchTools } from "../src/tools/search.js";
import { registerWorkflowTools } from "../src/tools/workflows.js";
import {
  GLOBAL_TOOLS,
  HANDLE_DIRECTIONS,
  HANDLE_TOKENS,
  TOOL_CLASSIFICATION,
} from "./helpers/multi-vault-tool-classification.js";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLS_DIR = path.join(APP_ROOT, "src", "tools");

// Same order and ownership as `registerObsidianCapabilities` in `src/capabilities.js`.
const REGISTRARS = Object.freeze([
  ["info.js", registerInfoTools],
  ["notes.js", registerNoteTools],
  ["search.js", registerSearchTools],
  ["files.js", registerFileTools],
  ["links.js", registerLinkTools],
  ["workflows.js", registerWorkflowTools],
  ["git.js", registerGitTools],
  ["intelligence.js", registerIntelligenceTools],
  ["context.js", registerContextTools],
  ["publish.js", registerPublishTools],
  ["plans.js", registerPlanTools],
]);

// `createMemoryGuidanceRegistrar` proxies resources/prompts and client version lookups; the real
// McpServer is never constructed because no handler is invoked.
function captureShell(onTool) {
  const names = [];
  const shell = {
    registerTool(name) {
      names.push(name);
      if (onTool) onTool(name);
    },
    registerResource() {},
    registerPrompt() {},
    getClientVersion: () => undefined,
  };
  return { shell, names };
}

function capturedCanonicalToolNames() {
  const { shell, names } = captureShell();
  registerObsidianCapabilities(shell);
  return names;
}

function capturedNamesByModule() {
  const byModule = new Map();
  const seen = new Map();
  for (const [moduleFile, registrar] of REGISTRARS) {
    const { shell, names } = captureShell();
    registrar(shell);
    byModule.set(moduleFile, names);
    for (const name of names) {
      assert.equal(seen.has(name), false, `${name} is registered by more than one module (${seen.get(name)} and ${moduleFile})`);
      seen.set(name, moduleFile);
    }
  }
  return { byModule, toolToModule: seen };
}

// Source scan required by the W0-B brief: which `src/tools/*.js` file textually registers a name.
function scanRegistrationsByName() {
  const byName = new Map();
  const pattern = /registerTool\(\s*["']([A-Za-z0-9_]+)["']/g;
  for (const entry of fs.readdirSync(TOOLS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(TOOLS_DIR, entry.name), "utf8");
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1];
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(entry.name);
    }
  }
  return byName;
}

function hasHandle(toolName, token, direction) {
  return TOOL_CLASSIFICATION[toolName].handles.some((handle) => handle.token === token && handle.direction === direction);
}

// Tools that carry a token in a given direction, as a sorted array.
function carriers(token, direction) {
  return Object.entries(TOOL_CLASSIFICATION)
    .filter(([, entry]) => entry.handles.some((handle) => handle.token === token && handle.direction === direction))
    .map(([name]) => name)
    .sort();
}

const sorted = (values) => [...values].sort();

test("real registration capture equals the canonical TOOL_NAMES (positive controls first)", () => {
  const captured = capturedCanonicalToolNames();

  // Positive controls: a capture shell that silently produced nothing must not look green.
  assert.ok(captured.length > 0, "registration capture returned zero tools");
  for (const control of ["agent_bootstrap", "server_info", "get_note", "apply_note_plan", "manage_publish"]) {
    assert.ok(captured.includes(control), `capture shell missed known tool ${control}`);
  }

  assert.equal(new Set(captured).size, captured.length, "a tool name was registered twice");
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "TOOL_NAMES contains duplicates");
  assert.deepEqual(sorted(captured), sorted(TOOL_NAMES), "registered tools differ from canonical TOOL_NAMES");
  assert.equal(captured.length, TOOL_NAMES.length);
});

test("classification covers TOOL_NAMES exactly, in canonical order, once per tool", () => {
  const classified = Object.keys(TOOL_CLASSIFICATION);
  assert.deepEqual(classified, TOOL_NAMES, "classification table must list TOOL_NAMES in order");

  for (const name of TOOL_NAMES) {
    const entry = TOOL_CLASSIFICATION[name];
    assert.ok(["global", "vault-scoped"].includes(entry.surface), `${name}: invalid surface ${entry.surface}`);
    assert.match(entry.module, /^[a-z0-9-]+\.js$/, `${name}: module must be a src/tools/*.js file name`);
    assert.ok(fs.existsSync(path.join(TOOLS_DIR, entry.module)), `${name}: missing module file src/tools/${entry.module}`);
    assert.ok(Array.isArray(entry.handles), `${name}: handles must be an array`);

    const pairs = new Set();
    for (const handle of entry.handles) {
      assert.ok(HANDLE_TOKENS.includes(handle.token), `${name}: unknown handle token ${handle.token}`);
      assert.ok(HANDLE_DIRECTIONS.includes(handle.direction), `${name}: unknown direction ${handle.direction}`);
      const key = `${handle.token}:${handle.direction}`;
      assert.equal(pairs.has(key), false, `${name}: duplicate handle entry ${key}`);
      pairs.add(key);
    }
  }
});

test("global surface is exactly the frozen §7.1 pair, disjoint from vault-scoped tools", () => {
  assert.deepEqual([...GLOBAL_TOOLS], ["agent_bootstrap", "server_info"], "§7.1 freeze changed");

  const globalEntries = TOOL_NAMES.filter((name) => TOOL_CLASSIFICATION[name].surface === "global");
  const vaultScopedEntries = TOOL_NAMES.filter((name) => TOOL_CLASSIFICATION[name].surface === "vault-scoped");

  assert.deepEqual(sorted(globalEntries), sorted(GLOBAL_TOOLS));
  assert.deepEqual(vaultScopedEntries, TOOL_NAMES.filter((name) => !GLOBAL_TOOLS.includes(name)));
  assert.equal(globalEntries.length + vaultScopedEntries.length, TOOL_NAMES.length);
  assert.deepEqual(globalEntries.filter((name) => vaultScopedEntries.includes(name)), []);
  for (const name of GLOBAL_TOOLS) {
    assert.deepEqual(TOOL_CLASSIFICATION[name].handles, [], `${name}: global tools must not carry vault handles`);
  }
});

test("module column matches the real registration source in both directions", () => {
  const scanned = scanRegistrationsByName();
  const { byModule, toolToModule } = capturedNamesByModule();

  const scannedNames = sorted(scanned.keys());
  assert.deepEqual(scannedNames, sorted(TOOL_NAMES), "src/tools/*.js registrations differ from TOOL_NAMES");
  assert.deepEqual(sorted(byModule.values().flatMap((names) => names)), sorted(TOOL_NAMES));

  let registrationCount = 0;
  for (const name of TOOL_NAMES) {
    const inFiles = sorted(scanned.get(name) || []);
    registrationCount += inFiles.length;
    assert.deepEqual(inFiles, [TOOL_CLASSIFICATION[name].module], `${name}: source scan module mismatch`);
    assert.equal(toolToModule.get(name), TOOL_CLASSIFICATION[name].module, `${name}: captured module mismatch`);
  }
  assert.equal(registrationCount, TOOL_NAMES.length, "a tool must be registered exactly once in src/tools/*.js");

  for (const [moduleFile, names] of byModule) {
    const expected = TOOL_NAMES.filter((name) => TOOL_CLASSIFICATION[name].module === moduleFile);
    assert.deepEqual(sorted(names), sorted(expected), `${moduleFile}: captured tools differ from classification`);
  }
});

test("required scopes are derived from scopes.js for every tool without manual drift", () => {
  assert.deepEqual(sorted(Object.keys(MCP_TOOL_SCOPE_REQUIREMENTS)), sorted(TOOL_NAMES));

  for (const name of TOOL_NAMES) {
    const requirements = MCP_TOOL_SCOPE_REQUIREMENTS[name];
    assert.ok(Array.isArray(requirements) && requirements.length >= 1, `${name}: missing scope requirements`);
    for (const scope of requirements) {
      assert.ok(MCP_SCOPES.includes(scope), `${name}: unsupported scope ${scope}`);
    }
    assert.equal(requirements[0], "obsidian.read", `${name}: obsidian.read must be the base scope`);
    assert.equal(new Set(requirements).size, requirements.length, `${name}: duplicate scopes`);
    if (TOOL_CLASSIFICATION[name].surface === "global") {
      assert.deepEqual([...requirements], ["obsidian.read"], `${name}: global metadata tools are read-only`);
    }
  }
});

test("cross-call handle anchors from §13.5 / §44 keep the correct direction", () => {
  // planId — produced by every plan_* tool, consumed by get/apply.
  for (const name of ["plan_note_changes", "plan_move_note", "plan_delete_note", "plan_restore_version", "plan_restore_from_trash"]) {
    assert.ok(hasHandle(name, "planId", "produces"), `${name} must produce planId`);
    assert.equal(hasHandle(name, "planId", "consumes"), false, `${name} must not consume planId`);
  }
  for (const name of ["get_note_plan", "apply_note_plan"]) {
    assert.ok(hasHandle(name, "planId", "consumes"), `${name} must consume planId`);
  }
  assert.deepEqual(carriers("planId", "produces"), ["plan_delete_note", "plan_move_note", "plan_note_changes", "plan_restore_from_trash", "plan_restore_version"]);
  assert.deepEqual(carriers("planId", "consumes"), ["apply_note_plan", "get_note_plan"]);

  // uploadId — produced by the two upload starters, consumed by the status/chunk/cancel tools.
  // Issue #470 Wave A adds the direct HTTP control plane: it produces the same kind of Vault-bound
  // handle (the HTTP data plane, not an MCP tool, consumes it).
  assert.deepEqual(carriers("uploadId", "produces"), ["start_direct_upload", "start_file_upload"]);
  assert.deepEqual(carriers("uploadId", "consumes"), ["cancel_file_upload", "file_upload_status", "upload_file_chunk"]);

  // versionId — produced by list_versions (+ write responses), consumed by restore/delete/inspect.
  assert.deepEqual(carriers("versionId", "produces"), ["list_versions"]);
  assert.deepEqual(carriers("versionId", "consumes"), ["compare_note_versions", "delete_version", "get_note_version", "plan_restore_version", "restore_version"]);

  // backupPath — produced by list_trash, consumed by restore/delete/plan.
  assert.deepEqual(carriers("backupPath", "produces"), ["list_trash"]);
  assert.deepEqual(carriers("backupPath", "consumes"), ["delete_trash_entry", "plan_restore_from_trash", "restore_from_trash"]);

  // Pagination cursor and vault-relative archive/skill paths.
  assert.deepEqual(carriers("cursor", "consumes"), ["list_files", "list_notes"]);
  assert.deepEqual(carriers("cursor", "produces"), ["list_files", "list_notes"]);
  assert.deepEqual(carriers("archivePath", "produces"), ["create_archive"]);
  assert.deepEqual(carriers("archivePath", "consumes"), ["extract_archive", "inspect_archive", "read_archive_entry", "skill_import"]);
  assert.deepEqual(carriers("skillPackagePath", "produces"), ["skill_export"]);

  // publishId + idempotencyKey (§13.2, §13.5; publish keeps its own public model).
  assert.deepEqual(carriers("publishId", "produces"), ["get_publish_status", "manage_publish"]);
  assert.deepEqual(carriers("idempotencyKey", "consumes"), ["apply_note_plan"]);

  // The vocabulary itself must not rot: every token is used somewhere.
  for (const token of HANDLE_TOKENS) {
    assert.ok(carriers(token, "consumes").length + carriers(token, "produces").length > 0, `handle token ${token} is unused`);
  }
});
