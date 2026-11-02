// AuthZ Wave A / A2 — capability expansion and validation.
//
// Pure module: no I/O, no clock, no module-level mutable state. The capability
// namespaces are frozen by `scratch/authz/INTERFACE.md` §6:
//   all | surface:mcp|web|oauth | scope:obsidian.read|write|files
//       | toolset:<canonical toolset> | tool:<canonical tool> | resource:<canonical uri>
//
// Tool / toolset / resource / scope names are never restated here. They are
// resolved from the existing sources of truth: app/src/scopes.js,
// app/src/capability-catalog.js and app/src/config.js.

import { TOOL_NAMES } from "../config.js";
import { MCP_RESOURCE_SCOPE_REQUIREMENTS, MCP_SCOPES, MCP_TOOL_SCOPE_REQUIREMENTS } from "../scopes.js";
import { TOOLSET_TOOLS, toolsetForTool } from "../capability-catalog.js";
import { parseSubject } from "./subjects.js";

/** Existing scope vocabulary, reused by reference (never re-declared). */
export const SCOPES = MCP_SCOPES;

const SURFACES = Object.freeze(["mcp", "web", "oauth"]);
const SURFACE_SET = new Set(SURFACES);
const SCOPE_SET = new Set(MCP_SCOPES);
const TOOL_SET = new Set(TOOL_NAMES);
const TOOLSET_SET = new Set(Object.keys(TOOLSET_TOOLS));
const RESOURCE_SET = new Set(Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS));

const MAX_NAME_LENGTH = 160;
const MAX_RESOURCE_LENGTH = 512;
const INVALID_NAME_PATTERN = /[\s\u0000-\u001f\u007f*]/;

function isCleanName(value, maxLength) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && !INVALID_NAME_PATTERN.test(value);
}

/**
 * Syntactic capability check for the schema layer: known namespace prefix and a
 * well-formed value. Bounded enumerations (`surface`, `scope`) are checked
 * against their frozen sets here; `tool`/`toolset`/`resource` names are only
 * shape-checked — their canonical membership is `unknownCapabilities`' job.
 */
export function isValidCapabilityShape(capability) {
  if (typeof capability !== "string") return false;
  if (capability === "all") return true;
  const separator = capability.indexOf(":");
  if (separator < 1) return false;
  const namespace = capability.slice(0, separator);
  const value = capability.slice(separator + 1);
  if (namespace === "surface") return SURFACE_SET.has(value);
  if (namespace === "scope") return SCOPE_SET.has(value);
  if (namespace === "tool") return isCleanName(value, MAX_NAME_LENGTH);
  if (namespace === "toolset") return isCleanName(value, MAX_NAME_LENGTH);
  if (namespace === "resource") return isCleanName(value, MAX_RESOURCE_LENGTH);
  return false;
}

/** Full canonical resolution (shape + membership against the frozen sets). */
function isCanonicalCapability(capability) {
  if (typeof capability !== "string") return false;
  if (capability === "all") return true;
  const separator = capability.indexOf(":");
  if (separator < 1) return false;
  const namespace = capability.slice(0, separator);
  const value = capability.slice(separator + 1);
  if (namespace === "surface") return SURFACE_SET.has(value);
  if (namespace === "scope") return SCOPE_SET.has(value);
  if (namespace === "tool") return TOOL_SET.has(value);
  if (namespace === "toolset") return TOOLSET_SET.has(value);
  if (namespace === "resource") return RESOURCE_SET.has(value);
  return false;
}

/**
 * Capabilities implied by calling one MCP tool. Unknown tool -> `null`
 * (fail closed). Scopes come from scopes.js; the toolset comes from the
 * capability catalog.
 */
export function capabilitiesForTool(toolName) {
  if (typeof toolName !== "string") return null;
  if (!Object.hasOwn(MCP_TOOL_SCOPE_REQUIREMENTS, toolName)) return null;
  const toolset = toolsetForTool(toolName);
  if (!toolset) return null;
  return [
    "all",
    "surface:mcp",
    ...MCP_TOOL_SCOPE_REQUIREMENTS[toolName].map((scope) => `scope:${scope}`),
    `toolset:${toolset}`,
    `tool:${toolName}`,
  ];
}

/** Capabilities implied by reading one canonical MCP resource. Unknown -> null. */
export function capabilitiesForResource(uri) {
  if (typeof uri !== "string") return null;
  if (!Object.hasOwn(MCP_RESOURCE_SCOPE_REQUIREMENTS, uri)) return null;
  return ["all", "surface:mcp", ...MCP_RESOURCE_SCOPE_REQUIREMENTS[uri].map((scope) => `scope:${scope}`), `resource:${uri}`];
}

/**
 * Capabilities implied by a Web route, expressed with existing scopes only.
 * A malformed or non-canonical scope returns `null` (the caller fails closed)
 * instead of being silently dropped.
 */
export function capabilitiesForWebRoute({ scopes } = {}) {
  if (!Array.isArray(scopes)) return null;
  const scoped = [];
  for (const scope of scopes) {
    if (typeof scope !== "string" || !SCOPE_SET.has(scope)) return null;
    scoped.push(`scope:${scope}`);
  }
  return ["all", "surface:web", ...new Set(scoped)];
}

/** Capabilities for the OAuth token lifecycle (hard revoke only). */
export function capabilitiesForOAuthLifecycle() {
  return ["all", "surface:oauth"];
}

/** Entries that cannot be resolved into the canonical capability set. */
export function unknownCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return capabilities.filter((capability) => !isCanonicalCapability(capability));
}

/** Subjects that are not valid frozen-namespace subjects (see subjects.js). */
export function unknownSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  return subjects.filter((subject) => parseSubject(subject) === null);
}
