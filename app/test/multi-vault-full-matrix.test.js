// Wave F / F1 — the COMPLETE full matrix: one row per canonical tool, each pointing at the lane
// that really drives it, plus the Wave F convergence architecture gates that keep the single-point
// claims honest.
//
// Contract: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §7/§7.1  canonical tool vault-scope registry (global = exactly {agent_bootstrap, server_info})
//   §31      Wave F convergence — "complete full matrix"; only this step may claim that every MCP
//            tool is multi-Vault; delete dead global state; architecture tests
//   §43-3    one canonical registry (no second inventory set)
//   §3.4     a capability is a runtime fact — flip only what is wired, report the rest with a reason
//   §47      RETURN list ("partial tool support claimed as complete" is a RETURN)
//
// Method: the table below is DATA with a machine-checked twin — every `lane` value must be a real
// test file whose source contains an invocation of that tool name (`call("x")`, `attempt("x")`,
// `name: "x"`). A claim that cannot be found in the suite fails this test, so the matrix cannot rot
// into prose. `global` is used only for the two tools that cannot have a dual-Vault case (§7.1:
// they carry no `vaultId`), and the assertion checks exactly that.
//
// Deterministic and offline: static reads only, no clock, no network, no Vault.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TOOL_NAMES } from "../src/config.js";
import { GLOBAL_TOOLS } from "./helpers/multi-vault-tool-classification.js";
import { CAPABILITY_KEYS } from "../src/vault-runtime/descriptor.js";
import { UNWIRED_CAPABILITY_DECISIONS, WIRED_CAPABILITY_KEYS, wiredCapabilities } from "../src/vault-runtime/capabilities.js";
import { VAULT_SCOPED_TOOLS } from "../src/vault-scope.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(APP_DIR, "test");
const read = (relative) => fs.readFileSync(path.join(APP_DIR, relative), "utf8");

/** The lane that drives each canonical tool. `global` = §7.1 (no Vault dependency exists). */
export const TOOL_COVERAGE = Object.freeze({
  // §7.1 global plane: no vaultId is injected, so a dual-Vault case is not constructible; the
  // ratchet lives in `multi-vault-tool-inventory.test.js` / `multi-vault-vault-scope-contract.test.js`.
  agent_bootstrap: "global",
  server_info: "global",
  // Wave D / D-files (notes/files/history/trash face).
  get_note: "multi-vault-d-files-matrix.test.js",
  pull_note_file: "multi-vault-gap-tools-matrix.test.js",
  get_metadata: "multi-vault-d-files-matrix.test.js",
  list_files: "multi-vault-d-files-matrix.test.js",
  get_file: "multi-vault-d-files-matrix.test.js",
  pull_file: "multi-vault-gap-tools-matrix.test.js",
  write_file: "multi-vault-d-files-matrix.test.js",
  start_file_upload: "multi-vault-gap-tools-matrix.test.js",
  start_direct_upload: "multi-vault-gap-tools-matrix.test.js",
  file_upload_status: "multi-vault-gap-tools-matrix.test.js",
  upload_file_chunk: "multi-vault-gap-tools-matrix.test.js",
  cancel_file_upload: "multi-vault-gap-tools-matrix.test.js",
  create_archive: "multi-vault-gap-tools-matrix.test.js",
  inspect_archive: "multi-vault-gap-tools-matrix.test.js",
  read_archive_entry: "multi-vault-gap-tools-matrix.test.js",
  extract_archive: "multi-vault-gap-tools-matrix.test.js",
  get_canvas: "multi-vault-gap-tools-matrix.test.js",
  write_canvas: "multi-vault-gap-tools-matrix.test.js",
  write_note: "multi-vault-d-files-matrix.test.js",
  append_to_note: "multi-vault-d-files-matrix.test.js",
  patch_note: "multi-vault-gap-tools-matrix.test.js",
  replace_in_note: "multi-vault-gap-tools-matrix.test.js",
  manage_frontmatter: "multi-vault-d-files-matrix.test.js",
  manage_tags: "multi-vault-d-files-matrix.test.js",
  move_note: "multi-vault-d-files-matrix.test.js",
  delete_note: "multi-vault-d-files-matrix.test.js",
  list_trash: "multi-vault-d-files-matrix.test.js",
  restore_from_trash: "multi-vault-d-files-matrix.test.js",
  delete_trash_entry: "multi-vault-d-files-matrix.test.js",
  list_versions: "multi-vault-d-files-matrix.test.js",
  restore_version: "multi-vault-d-files-matrix.test.js",
  delete_version: "multi-vault-d-files-matrix.test.js",
  manage_folders: "multi-vault-d-files-matrix.test.js",
  // Wave D / D-intelligence (context / memory / skills face).
  get_note_context: "multi-vault-intelligence-matrix.test.js",
  memory_capture: "multi-vault-intelligence-matrix.test.js",
  memory_recall: "multi-vault-intelligence-matrix.test.js",
  skill_list: "multi-vault-intelligence-matrix.test.js",
  skill_match: "multi-vault-intelligence-matrix.test.js",
  skill_validate: "multi-vault-intelligence-matrix.test.js",
  skill_export: "multi-vault-intelligence-matrix.test.js",
  skill_import: "multi-vault-intelligence-matrix.test.js",
  // Wave D / D-search (search + index + retrieval + link/graph readers).
  list_notes: "multi-vault-search-matrix.test.js",
  list_recent: "multi-vault-search-matrix.test.js",
  search_notes: "multi-vault-search-matrix.test.js",
  list_tags: "multi-vault-search-matrix.test.js",
  get_graph: "multi-vault-search-matrix.test.js",
  graph_health: "multi-vault-search-matrix.test.js",
  index_status: "multi-vault-search-matrix.test.js",
  reindex_vault: "multi-vault-search-matrix.test.js",
  recall: "multi-vault-search-matrix.test.js",
  get_backlinks: "multi-vault-gap-tools-matrix.test.js",
  get_unresolved_links: "multi-vault-gap-tools-matrix.test.js",
  get_orphans: "multi-vault-gap-tools-matrix.test.js",
  get_deadends: "multi-vault-gap-tools-matrix.test.js",
  find_related: "multi-vault-gap-tools-matrix.test.js",
  suggest_links: "multi-vault-gap-tools-matrix.test.js",
  // Wave D / D-workflows (workflows / Bases face).
  list_tasks: "multi-vault-workflows-matrix.test.js",
  update_task: "multi-vault-workflows-matrix.test.js",
  list_properties: "multi-vault-workflows-matrix.test.js",
  list_aliases: "multi-vault-workflows-matrix.test.js",
  list_bases: "multi-vault-workflows-matrix.test.js",
  get_base: "multi-vault-workflows-matrix.test.js",
  write_base: "multi-vault-workflows-matrix.test.js",
  // P1 (#629): the line-surgical CAS increment is invoked end-to-end in its own MCP lane file.
  patch_base: "mcp-patch-base.test.js",
  query_base: "multi-vault-workflows-matrix.test.js",
  // A2: the read-only view selector is invoked end-to-end in its own MCP lane file.
  list_base_views: "mcp-list-base-views.test.js",
  // P1 (#630): the create face's own lane holds the dual-Vault invocation.
  create_base_entry: "mcp-base-create.test.js",
  daily_note: "multi-vault-gap-tools-matrix.test.js",
  list_templates: "multi-vault-gap-tools-matrix.test.js",
  create_from_template: "multi-vault-gap-tools-matrix.test.js",
  rename_property: "multi-vault-gap-tools-matrix.test.js",
  set_property_type: "multi-vault-gap-tools-matrix.test.js",
  // Wave D / D-git.
  git_status: "multi-vault-git-matrix.test.js",
  git_diff: "multi-vault-git-matrix.test.js",
  git_log: "multi-vault-git-matrix.test.js",
  git_commit: "multi-vault-git-matrix.test.js",
  git_pull: "multi-vault-gap-git-matrix.test.js",
  git_push: "multi-vault-gap-git-matrix.test.js",
  // Wave D / D-publish.
  get_publish_status: "multi-vault-publish-matrix.test.js",
  manage_publish: "multi-vault-publish-matrix.test.js",
  // Wave D / D-plans.
  plan_note_changes: "multi-vault-plans-matrix.test.js",
  plan_move_note: "multi-vault-plans-matrix.test.js",
  plan_delete_note: "multi-vault-plans-matrix.test.js",
  plan_restore_version: "multi-vault-plans-matrix.test.js",
  plan_restore_from_trash: "multi-vault-plans-matrix.test.js",
  get_note_plan: "multi-vault-plans-matrix.test.js",
  apply_note_plan: "multi-vault-plans-matrix.test.js",
  get_note_version: "multi-vault-plans-matrix.test.js",
  compare_note_versions: "multi-vault-plans-matrix.test.js",
});

/** Invocation shapes the matrices use; a lane claim must match at least one. */
const invocationPatterns = (name) => [
  new RegExp(`(?:call|ok|raw|attempt|invoke|tool)\\("${name}"`),
  new RegExp(`callTool\\(\\{\\s*name:\\s*"${name}"`),
  new RegExp(`name:\\s*"${name}"`),
];

test("§31: the coverage table covers TOOL_NAMES exactly once (no tool exempted, none invented)", () => {
  assert.deepEqual([...Object.keys(TOOL_COVERAGE)].sort(), [...TOOL_NAMES].sort(), "one row per canonical tool");
  assert.equal(new Set(Object.keys(TOOL_COVERAGE)).size, TOOL_NAMES.length);
});

test("§31: every vault-scoped tool's coverage claim matches a real invocation in that lane", () => {
  const global = new Set(GLOBAL_TOOLS);
  for (const [name, lane] of Object.entries(TOOL_COVERAGE)) {
    if (global.has(name)) {
      assert.equal(lane, "global", `${name} has no Vault dependency (contract §7.1) — no dual-Vault case is constructible`);
      assert.equal(VAULT_SCOPED_TOOLS.includes(name), false, `${name} must not be classified vault-scoped`);
      continue;
    }
    assert.equal(VAULT_SCOPED_TOOLS.includes(name), true, `${name} must be classified vault-scoped`);
    const absolute = path.join(TEST_DIR, lane);
    assert.equal(fs.existsSync(absolute), true, `${name}: the claimed lane ${lane} must exist`);
    const text = fs.readFileSync(absolute, "utf8");
    assert.ok(
      invocationPatterns(name).some((pattern) => pattern.test(text)),
      `${name}: ${lane} claims coverage but never invokes the tool — add the real dual-Vault case or fix the table`,
    );
  }
});

test("§31: the two global tools are exactly the §7.1 pair (no tool was quietly exempted)", () => {
  assert.deepEqual([...GLOBAL_TOOLS].sort(), ["agent_bootstrap", "server_info"]);
  assert.deepEqual(Object.entries(TOOL_COVERAGE).filter(([, lane]) => lane === "global").map(([name]) => name), [...GLOBAL_TOOLS]);
});

// ---------------------------------------------------------------------------------------------
// Wave F convergence gates (the same change that converges keeps them true)
// ---------------------------------------------------------------------------------------------

test("§31/D1: exactly ONE canonical A2 registry is constructed in src/**", () => {
  const constructions = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".js")) {
        const source = fs.readFileSync(absolute, "utf8");
        // The definition site itself is not a construction site.
        if (/createVaultRegistry\s*\(/.test(source) && !/export function createVaultRegistry\s*\(/.test(source)) {
          constructions.push(path.relative(APP_DIR, absolute).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(path.join(APP_DIR, "src"));
  assert.deepEqual(constructions, ["src/app/vault-registry.js"], "a second A2 registry construction site is a defect (§31/D1, §43-3)");
  assert.ok(read("src/app/vault-registry.js").includes("export const webVaultRegistry = registry;"), "the canonical instance must be exported for single-point injection");
  assert.ok(!read("src/admin/vault-git-assembly.js").includes("createVaultRegistry"), "the Wave E Admin assembly must consume the injected registry");
});

test("§31/D1: server.js injects that ONE instance and keeps no inline Web root read", () => {
  const server = read("server.js");
  const compositionRoot = read("src/vault-runtime/vault-composition-root.js");
  assert.match(server, /createVaultCompositionRoot\(\{\s*registry: webVaultRegistry,\s*primaryRuntime,/);
  assert.equal((server.match(/registry: webVaultRegistry,/g) ?? []).length, 1);
  assert.match(compositionRoot, /export function createVaultCompositionRoot\(\{ registry, primaryRuntime,/);
  for (const consumer of ["createVaultGitAdminAssembly", "createVaultRuntimeMap"]) {
    const calls = [...compositionRoot.matchAll(new RegExp(`${consumer}\\(\\{\\s*registry,`, "g"))];
    assert.equal(calls.length, 1, `${consumer} must receive the injected canonical registry exactly once`);
  }
  assert.ok(!server.includes("process.env.WEB_VAULTS_ROOT"), "the inline WEB_VAULTS_ROOT read is gone (§31/D2)");
  assert.ok(!/vaultsRoot:/.test(server), "the assembly takes its root from the injected registry");
  // The frozen pre-F1 size was 498 lines; server.js may only shrink (LINE_BUDGET is 500).
  const lines = server.replaceAll("\r\n", "\n").split("\n").length - (server.endsWith("\n") ? 1 : 0);
  assert.ok(lines <= 498, `server.js grew to ${lines} lines; Wave F may only shrink it`);
});

test("§14: Publish resolves Vaults through the canonical registry's own resolver", () => {
  const service = read("src/publish/service.js");
  assert.ok(service.includes('from "../app/vault-registry.js"'), "the resolver must come from the canonical registry module");
  assert.ok(/resolveCanonicalVault as resolveWebVault/.test(service), "the dependency is replaced by the canonical resolver (§14)");
  assert.ok(!service.includes("createVaultRegistry"), "Publish must not construct or import a second registry");
});

test("§3.4: the capability graph claims exactly the wired keys and records every unwired decision", () => {
  assert.deepEqual(
    [...WIRED_CAPABILITY_KEYS].sort(),
    ["files", "git", "history", "memory", "notes", "plans", "publish", "retrieval", "skills", "trash"],
    "the Wave D + Wave F / F1 wired claim (extended, never loosened)",
  );
  const graph = wiredCapabilities();
  assert.deepEqual(Object.keys(graph).sort(), [...CAPABILITY_KEYS].sort(), "the graph must carry every canonical capability key");
  for (const key of CAPABILITY_KEYS) {
    if (WIRED_CAPABILITY_KEYS.includes(key)) {
      assert.deepEqual(graph[key], { available: true }, `${key} is wired and must be reported available`);
      continue;
    }
    assert.equal(graph[key].available, false, `${key} is not wired and must stay fail closed`);
    assert.ok(graph[key].reason.length > 0, `${key} must carry a visible reason`);
    const decision = UNWIRED_CAPABILITY_DECISIONS[key];
    assert.ok(decision, `${key} must be a RECORDED decision, not a leftover (§3.4)`);
    for (const owner of decision.owner) {
      assert.equal(fs.existsSync(path.join(APP_DIR, owner)), true, `${key}'s owner module ${owner} must exist`);
      assert.ok(decision.reason.includes(owner), `${key}'s recorded reason must name its owner seam ${owner}`);
    }
  }
  // `retrieval` was the Wave D residual: the index/retrieval instances ARE per Vault and routed, so
  // the map-level key converges here. `semantic` is a composite of that wiring and the shared
  // embedding provider, which the retrieval runtime answers per Vault — a static key would have to
  // guess; the source below is the evidence that the fact exists and is reported elsewhere.
  assert.ok(WIRED_CAPABILITY_KEYS.includes("retrieval"));
  assert.equal(WIRED_CAPABILITY_KEYS.includes("semantic"), false, "semantic must not be a static key (it depends on the provider)");
  assert.match(read("src/vault-runtime/retrieval-runtime.js"), /function semanticCapability\(\)/, "the per-Vault semantic fact must stay in the retrieval runtime");
  assert.match(read("src/vault-runtime/search-runtime.js"), /semantic: semanticCapability/, "the composition must report that fact per Vault");
});

test("§31: the capability graph reaches the caller-visible planes from the canonical registry", () => {
  // server_info and the Admin assembly read the SAME descriptors, so a flipped key is observable
  // (§18.1: the metadata plane may report capabilities, never roots/paths/credentials).
  assert.match(read("src/app/vault-registry.js"), /capabilitiesFor: wiredCapabilities/, "the canonical registry must carry the wired graph");
  assert.match(read("src/tools/info.js"), /webVaultRegistry\.get\(String\(vault\.id\)\)\?\.capabilities/, "server_info must report the registry's per-Vault capabilities");
  assert.match(read("src/admin/vault-git-routes.js"), /capabilityList\(descriptor\)/, "Admin must render the registry descriptor's capabilities");
});
