import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import {
  CAPABILITY_POLICY_PROFILES,
  CAPABILITY_POLICY_SCHEMA_VERSION,
  CORE_TOOL_NAMES,
  buildCapabilityPolicyView,
} from "../src/capability-policy.js";

const ALL_SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];

test("policy module declares the Phase 2A profiles and frozen core seed", () => {
  assert.equal(CAPABILITY_POLICY_SCHEMA_VERSION, 1);
  assert.deepEqual(CAPABILITY_POLICY_PROFILES, ["full", "core", "compact", "module", "custom"]);
  assert.deepEqual(CORE_TOOL_NAMES, [
    "agent_bootstrap",
    "server_info",
    "get_note",
    "list_notes",
    "search_notes",
    "recall",
  ]);
  assert.equal(Object.isFrozen(CORE_TOOL_NAMES), true);
});

test("full policy with all scopes is exactly the current eager TOOL_NAMES view", () => {
  const view = buildCapabilityPolicyView({
    grantedScopes: ALL_SCOPES,
    profile: "full",
  });
  assert.deepEqual(view.toolNames, TOOL_NAMES);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.toolNames), true);
});

test("authorization hard-filter runs before policy and fails closed on missing scopes", () => {
  const readOnly = buildCapabilityPolicyView({
    grantedScopes: ["obsidian.read"],
    profile: "full",
  });
  assert.ok(readOnly.toolNames.includes("get_note"));
  assert.equal(readOnly.toolNames.includes("write_note"), false);
  assert.equal(readOnly.toolNames.includes("get_file"), false);
  assert.equal(readOnly.toolNames.includes("git_commit"), false);

  const noScopes = buildCapabilityPolicyView({
    grantedScopes: [],
    profile: "full",
  });
  assert.deepEqual(noScopes.toolNames, []);
});

test("core is the explicit six-tool eval seed and keeps canonical order", () => {
  const view = buildCapabilityPolicyView({
    grantedScopes: ALL_SCOPES,
    profile: "core",
  });
  assert.deepEqual(view.toolNames, CORE_TOOL_NAMES);

  const readOnly = buildCapabilityPolicyView({
    grantedScopes: ["obsidian.read"],
    profile: "core",
  });
  assert.deepEqual(readOnly.toolNames, CORE_TOOL_NAMES);
});

test("module policy unions verified source toolsets but still enforces scopes", () => {
  const readOnlyGit = buildCapabilityPolicyView({
    grantedScopes: ["obsidian.read"],
    profile: "module",
    toolsets: ["git"],
  });
  assert.deepEqual(readOnlyGit.toolNames, ["git_status", "git_diff", "git_log"]);

  const fullGit = buildCapabilityPolicyView({
    grantedScopes: ["obsidian.read", "obsidian.write"],
    profile: "module",
    toolsets: ["git"],
  });
  assert.deepEqual(fullGit.toolNames, [
    "git_status",
    "git_diff",
    "git_log",
    "git_commit",
    "git_pull",
    "git_push",
  ]);
});

test("custom allowlist cannot make unauthorized tools visible", () => {
  const view = buildCapabilityPolicyView({
    grantedScopes: ["obsidian.read", "obsidian.files"],
    profile: "custom",
    tools: ["write_note", "get_file", "get_note"],
  });
  // Output stays in canonical TOOL_NAMES order, not caller allowlist order.
  assert.deepEqual(view.toolNames, ["get_note", "get_file"]);
});

test("explicit deny wins over full, module, and custom allow", () => {
  const full = buildCapabilityPolicyView({
    grantedScopes: ALL_SCOPES,
    profile: "full",
    denyTools: ["server_info"],
  });
  assert.equal(full.toolNames.includes("server_info"), false);

  const module = buildCapabilityPolicyView({
    grantedScopes: ALL_SCOPES,
    profile: "module",
    toolsets: ["git"],
    denyTools: ["git_push"],
  });
  assert.equal(module.toolNames.includes("git_push"), false);

  const custom = buildCapabilityPolicyView({
    grantedScopes: ALL_SCOPES,
    profile: "custom",
    tools: ["get_note"],
    denyTools: ["get_note"],
  });
  assert.deepEqual(custom.toolNames, []);
});

test("invalid scope/tool/toolset/profile configuration is rejected instead of widening", () => {
  assert.throws(
    () => buildCapabilityPolicyView({ profile: "full" }),
    /grantedScopes must be an array/,
  );
  assert.throws(
    () => buildCapabilityPolicyView({ grantedScopes: ["obsidian.admin"], profile: "full" }),
    /Unsupported MCP scope/,
  );
  assert.throws(
    () => buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES, profile: "wat" }),
    /Unknown capability policy profile/,
  );
  assert.throws(
    () => buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES, profile: "module", toolsets: ["wat"] }),
    /Unknown capability toolset/,
  );
  assert.throws(
    () => buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES, profile: "custom", tools: ["wat"] }),
    /Unknown capability tool/,
  );
  assert.throws(
    () => buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES, profile: "full", tools: ["get_note"] }),
    /full policy does not accept/,
  );
  assert.throws(
    () => buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES, profile: "module", toolsets: ["git"], tools: ["get_note"] }),
    /module policy does not accept/,
  );
});

test("compact profile preserves original per-action authorization membership", () => {
  const full = buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES });
  const compact = buildCapabilityPolicyView({ grantedScopes: ALL_SCOPES, profile: "compact" });
  assert.deepEqual(compact.toolNames, full.toolNames);
  const limited = buildCapabilityPolicyView({ grantedScopes: ["obsidian.read"], profile: "compact" });
  assert.equal(limited.toolNames.includes("write_note"), false);
  assert.ok(limited.toolNames.includes("search_notes"));
});
