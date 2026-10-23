// Canonical MCP tool vault-scope registry — contract §7 (canonical tool vault-scope
// registry), Wave A / lane A3 (contract §26 A3). The classification is the single production
// authority: Wave C wired it into `auth.js` (HTTP `requestedVaults`, contract §9/§43-3) and into
// the vault-scope registrar (`vault-scope-registrar.js`, contract §7.3/§28). No tool module and no
// auth path keeps a second set.
//
// Architecture constraints satisfied on purpose (contract §43-1/§43-2/§43-5, brief §1.1):
//   * The classification is DERIVED from `TOOL_NAMES` (`app/src/config.js`), never a
//     hand-copied list, so `GLOBAL_TOOLS ∪ VAULT_SCOPED_TOOLS == TOOL_NAMES` and the two
//     sets are disjoint by construction — a canonical tool cannot be left unclassified.
//   * Imports only the `TOOL_NAMES` binding from `./config.js` and the
//     `MAX_VAULT_ID_LENGTH` bound from `./vault-runtime/descriptor.js`: never `auth.js`,
//     never `app/**`, never the global `VAULT` / `DATA_PATH` / `TRASH_PATH` /
//     `HISTORY_PATH` / `RETRIEVAL_INDEX_PATH` constants, never `process.env`.
//   * No module-level mutable state (SEC-MV07): only frozen data and pure functions.
//
// Tool count is unchanged (contract §7.4): this module classifies the existing tools and
// never adds, removes or renames one.
//
// Fail-closed policy: an inconsistent tool list (duplicate name, empty name, or a frozen
// global name that disappeared from `TOOL_NAMES`) throws a structured `Error` carrying the
// stable `code` `VAULT_SCOPE_INVALID` and a `[VAULT_SCOPE_INVALID] ` message prefix,
// instead of silently misfiling a tool.

import { TOOL_NAMES } from "./config.js";
import { MAX_VAULT_ID_LENGTH } from "./vault-runtime/descriptor.js";

// Stable error code; consumers/tests never match on prose.
export const VAULT_SCOPE_INVALID = "VAULT_SCOPE_INVALID";

function fail(detail) {
  throw Object.assign(new Error(`[${VAULT_SCOPE_INVALID}] ${detail}`), { code: VAULT_SCOPE_INVALID });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

// ---------------------------------------------------------------------------
// Tool classification (contract §7.1 global / §7.2 vault-scoped)
// ---------------------------------------------------------------------------

/**
 * Tools with no Vault dependency — FROZEN by contract §7.1. Removing or renaming an entry
 * here is a contract change, not a refactor.
 */
export const GLOBAL_TOOLS = Object.freeze(["agent_bootstrap", "server_info"]);

/**
 * Pure classification rule (contract §7.2): `scoped = toolNames - GLOBAL_TOOLS`, order
 * preserved. Exported so the "no tool may be unclassified" invariant is testable without
 * the production list, and so Wave C / architecture tests reuse one rule instead of a
 * second hand-maintained set.
 *
 * Throws `VAULT_SCOPE_INVALID` when `toolNames` is not a non-empty string array, contains a
 * duplicate or empty name, or drops a frozen global tool.
 */
export function classifyTools(toolNames) {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    fail(`toolNames must be a non-empty array, got ${describe(toolNames)}`);
  }
  const seen = new Set();
  const scoped = [];
  for (const name of toolNames) {
    if (typeof name !== "string" || name === "") fail(`tool name must be a non-empty string, got ${describe(name)}`);
    if (seen.has(name)) fail(`duplicate tool name ${JSON.stringify(name)} — a tool must be classified exactly once`);
    seen.add(name);
    if (!GLOBAL_TOOLS.includes(name)) scoped.push(name);
  }
  const missing = GLOBAL_TOOLS.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    fail(`frozen global tool(s) missing from TOOL_NAMES: ${missing.join(", ")} — a global tool must be classified, not dropped`);
  }
  return Object.freeze({ global: GLOBAL_TOOLS, scoped: Object.freeze(scoped) });
}

const CLASSIFIED = classifyTools(TOOL_NAMES);

/** Canonical vault-scoped tools (= `TOOL_NAMES` − `GLOBAL_TOOLS`, contract §7.2), in `TOOL_NAMES` order. */
export const VAULT_SCOPED_TOOLS = CLASSIFIED.scoped;

/** True for a canonical vault-scoped tool name; false for global tools and unknown input. */
export function isVaultScopedTool(name) {
  return typeof name === "string" && VAULT_SCOPED_TOOLS.includes(name);
}

// ---------------------------------------------------------------------------
// Canonical vaultId input spec (contract §7.3)
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic canonical `vaultId` input: optional string, 1–80 chars, "omitted =
 * default/primary Vault". `maxLength` is derived from `descriptor.MAX_VAULT_ID_LENGTH`, not
 * copied, so the ID bound cannot drift between the two modules. No `pattern` here: applying
 * the canonical ID validator is the registrar's job (contract §7.3, Wave C).
 */
export const VAULT_ID_INPUT_SPEC = Object.freeze({
  name: "vaultId",
  type: "string",
  optional: true,
  minLength: 1,
  maxLength: MAX_VAULT_ID_LENGTH,
  description: "不传 = default/primary Vault",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Merge the canonical `vaultId` property into a plain-object input schema and return a NEW
 * object (the input is never mutated). The merged property is the frozen canonical spec
 * itself, so a consumer cannot fork a local copy.
 *
 * Fail-closed: rejects a non-plain-object schema and, with `VAULT_SCOPE_INVALID`, a schema
 * that already declares `vaultId` — local definitions (today: the two Publish tools'
 * hand-written `z.string().min(1).optional()`, contract §7.3) must be deleted rather than
 * silently shadowed by the canonical one.
 */
export function applyVaultIdSpec(inputSchema) {
  if (!isPlainObject(inputSchema)) {
    fail(`inputSchema must be a plain object schema, got ${describe(inputSchema)}`);
  }
  if (Object.hasOwn(inputSchema, VAULT_ID_INPUT_SPEC.name)) {
    fail(
      `inputSchema already declares "${VAULT_ID_INPUT_SPEC.name}" — delete the local definition before applying the canonical spec (contract §7.3)`,
    );
  }
  return { ...inputSchema, [VAULT_ID_INPUT_SPEC.name]: VAULT_ID_INPUT_SPEC };
}
