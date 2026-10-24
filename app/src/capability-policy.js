// Pure capability-policy view for Progressive Tool Discovery Phase 2A.
//
// This module must stay side-effect free and must not be imported by the runtime
// registration path until the separate Phase 2B wiring is explicitly enabled.
// It only derives a stable visible-name view from the immutable capability
// catalog, granted scopes, and an operator/test policy.
//
// Security invariant: policy may reduce visibility, never grant authorization.

import {
  CAPABILITY_CATALOG,
  TOOLSET_TOOLS,
} from "./capability-catalog.js";
import { MCP_SCOPES } from "./scopes.js";

export const CAPABILITY_POLICY_SCHEMA_VERSION = 1;

export const CAPABILITY_POLICY_PROFILES = Object.freeze([
  "full",
  "core",
  "compact",
  "module",
  "custom",
]);

export const CORE_TOOL_NAMES = Object.freeze([
  "agent_bootstrap",
  "server_info",
  "get_note",
  "list_notes",
  "search_notes",
  "recall",
]);

const CATALOG_NAMES = Object.freeze(CAPABILITY_CATALOG.map((entry) => entry.name));
const CATALOG_NAME_SET = new Set(CATALOG_NAMES);
const TOOLSET_NAMES = Object.freeze(Object.keys(TOOLSET_TOOLS));
const TOOLSET_NAME_SET = new Set(TOOLSET_NAMES);

for (const name of CORE_TOOL_NAMES) {
  if (!CATALOG_NAME_SET.has(name)) {
    throw new Error(`Capability policy core references unknown tool ${name}`);
  }
}

function freezeCopy(values) {
  return Object.freeze([...values]);
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
}

function normalizeGrantedScopes(scopes) {
  assertArray(scopes, "grantedScopes");
  const normalized = [...new Set(scopes.map((scope) => String(scope || "").trim()).filter(Boolean))];
  const unknown = normalized.filter((scope) => !MCP_SCOPES.includes(scope));
  if (unknown.length) throw new Error(`Unsupported MCP scope: ${unknown.join(", ")}`);
  return normalized;
}

function normalizeToolNames(names, label) {
  assertArray(names, label);
  const normalized = [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
  const unknown = normalized.filter((name) => !CATALOG_NAME_SET.has(name));
  if (unknown.length) throw new Error(`Unknown capability tool in ${label}: ${unknown.join(", ")}`);
  return normalized;
}

function normalizeToolsets(toolsets) {
  assertArray(toolsets, "toolsets");
  const normalized = [...new Set(toolsets.map((name) => String(name || "").trim()).filter(Boolean))];
  const unknown = normalized.filter((name) => !TOOLSET_NAME_SET.has(name));
  if (unknown.length) throw new Error(`Unknown capability toolset: ${unknown.join(", ")}`);
  return normalized;
}

function allowedNamesForProfile(profile, toolsets, tools) {
  if (!CAPABILITY_POLICY_PROFILES.includes(profile)) {
    throw new Error(`Unknown capability policy profile: ${profile}`);
  }

  if (profile === "full" || profile === "compact") {
    if (toolsets.length || tools.length) throw new Error(`${profile} policy does not accept toolsets/tools allowlists`);
    return null;
  }

  if (profile === "core") {
    if (toolsets.length || tools.length) throw new Error("core policy does not accept toolsets/tools allowlists");
    return new Set(CORE_TOOL_NAMES);
  }

  if (profile === "module") {
    if (tools.length) throw new Error("module policy does not accept tools allowlist");
    return new Set(toolsets.flatMap((toolset) => TOOLSET_TOOLS[toolset]));
  }

  if (toolsets.length) throw new Error("custom policy does not accept toolsets");
  return new Set(tools);
}

export function buildCapabilityPolicyView({
  grantedScopes,
  profile = "full",
  toolsets = [],
  tools = [],
  denyTools = [],
} = {}) {
  const normalizedScopes = normalizeGrantedScopes(grantedScopes);
  const normalizedToolsets = normalizeToolsets(toolsets);
  const normalizedTools = normalizeToolNames(tools, "tools");
  const normalizedDenyTools = normalizeToolNames(denyTools, "denyTools");

  const allowed = allowedNamesForProfile(profile, normalizedToolsets, normalizedTools);
  const denied = new Set(normalizedDenyTools);
  const granted = new Set(normalizedScopes);

  // Authorization is always evaluated before policy selection. The final
  // canonical-order filter then applies profile allow + explicit deny.
  const authorized = CAPABILITY_CATALOG.filter((entry) =>
    entry.scope.every((scope) => granted.has(scope)),
  );

  const toolNames = authorized
    .map((entry) => entry.name)
    .filter((name) => (allowed === null || allowed.has(name)) && !denied.has(name));

  return Object.freeze({
    schemaVersion: CAPABILITY_POLICY_SCHEMA_VERSION,
    profile,
    grantedScopes: freezeCopy(normalizedScopes),
    toolsets: freezeCopy(normalizedToolsets),
    tools: freezeCopy(normalizedTools),
    denyTools: freezeCopy(normalizedDenyTools),
    toolNames: freezeCopy(toolNames),
  });
}
