// Immutable operator configuration for Progressive Tool Discovery Phase 2B.
//
// The operator profile is read once at process start from environment
// variables and is never derived from a client name, request argument, or any
// other host signal. An absent, unknown, or internally inconsistent
// configuration falls back to the full compatibility profile with a bounded,
// secret-free warning. The configuration can only reduce visibility; it can
// never grant a scope.

import { CAPABILITY_POLICY_SCHEMA_VERSION, buildCapabilityPolicyView } from "./capability-policy.js";
import { MCP_SCOPES } from "./scopes.js";

export const DISCOVERY_CONFIG_SCHEMA_VERSION = 1;

const WARNING_LIMIT = 240;
const VALID_SCOPES = Object.freeze([...MCP_SCOPES]);

function cleanText(value, max = WARNING_LIMIT) {
  return String(value ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, max);
}

function splitList(value) {
  return [...new Set(String(value ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function freezeConfig({ profile, toolsets, tools, denyTools, warning }) {
  return Object.freeze({
    schemaVersion: DISCOVERY_CONFIG_SCHEMA_VERSION,
    policySchemaVersion: CAPABILITY_POLICY_SCHEMA_VERSION,
    profile,
    toolsets: Object.freeze([...toolsets]),
    tools: Object.freeze([...tools]),
    denyTools: Object.freeze([...denyTools]),
    warning: warning ? cleanText(warning) : null,
  });
}

// Validates the whole operator configuration against the same pure policy view
// the runtime uses. Any error means "invalid configuration", not "widen".
export function parseDiscoveryOperatorConfig(env = {}) {
  const profile = cleanText(env.MCP_DISCOVERY_PROFILE, 32).toLowerCase() || "full";
  const toolsets = splitList(env.MCP_DISCOVERY_TOOLSETS);
  const tools = splitList(env.MCP_DISCOVERY_TOOLS);
  const denyTools = splitList(env.MCP_DISCOVERY_DENY_TOOLS);

  try {
    buildCapabilityPolicyView({ grantedScopes: VALID_SCOPES, profile, toolsets, tools, denyTools });
    return freezeConfig({ profile, toolsets, tools, denyTools, warning: null });
  } catch (error) {
    const reason = cleanText(error instanceof Error ? error.message : String(error), 160);
    return freezeConfig({
      profile: "full",
      toolsets: [],
      tools: [],
      denyTools: [],
      warning: `Invalid MCP discovery configuration (${reason}); falling back to the full compatibility profile.`,
    });
  }
}

// Loads the process-wide operator configuration. server.js calls this exactly
// once at startup and passes the frozen result to every session server.
export function loadDiscoveryOperatorConfig(env = process.env) {
  return parseDiscoveryOperatorConfig(env);
}
