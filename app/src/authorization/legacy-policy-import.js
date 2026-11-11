// P1 / Task 6 — legacy temporal selectors become new constraint branches.
//
// Contract: design §8. One old policy stays exactly one new constraint. The old
// capability list is an OR, so each selector becomes its own `anyOf` branch and
// the OR never becomes an AND. `tool:`, `toolset:` and `resource:` selectors
// belong to the MCP surface only; a `scope:` selector expands onto the entries
// that really used that scope at the baseline, taken from the catalog boundary
// table (so a Web route keeps its own surface); direct upload keeps its MCP
// control-tool meaning; a revoke policy keeps exactly one all-null branch.
// Every other field, including the UUID, is copied unchanged.
//
// A legacy document that cannot be validated raises a migration HOLD. That
// includes a disabled policy: dropping it would grant, and the design forbids
// discarding a dormant policy as "disabled" without repair. This module is pure:
// it holds no state, does no I/O and never runs the old service.

import { validateAccessPolicyDocument } from "../access-policy/schema.js";
import { TOOLSET_TOOLS } from "../capability-catalog.js";
import { AUTHORIZATION_CATALOG_VERSION, authorizationOperation, capabilityForBoundary, catalogBoundaryKeys, isOutsideTemporalPlane, surfaceForBoundary } from "./catalog.js";
import { validateAuthorizationDocument } from "./schema.js";

export const LEGACY_POLICY_IMPORT_CODES = Object.freeze({
  MIGRATION_HOLD: "authorization_migration_hold",
});

function hold(reason) {
  const error = new Error(`the legacy policy document cannot be migrated: ${reason}`);
  error.name = "LegacyPolicyImportError";
  error.code = LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD;
  error.details = { reason };
  throw error;
}

/**
 * Which operation runs on which surface, and which scope that entry needs:
 * built from the catalog boundary table, so a Web route keeps the Web surface
 * and an MCP tool keeps the MCP surface even when both share one capability.
 */
function buildEntryIndex(boundaries) {
  const byScope = new Map();
  for (const key of boundaries) {
    const operationId = capabilityForBoundary(key);
    if (operationId === null) continue;
    const operation = authorizationOperation(operationId);
    if (operation === null) continue;
    const surface = surfaceForBoundary(key);
    // An exempt operation is never a selector target: the identity and public-shell
    // operations hold no scope, and the gated Vault list has its own operation.
    if (isOutsideTemporalPlane(operationId)) continue;
    for (const scope of operation.oauthScopes) {
      const entry = byScope.get(scope) ?? { capabilities: new Set(), surfaces: new Set() };
      entry.capabilities.add(operationId);
      entry.surfaces.add(surface);
      byScope.set(scope, entry);
    }
  }
  return byScope;
}

/** The branches one legacy selector becomes. The OR between selectors stays outside. */
function branchesForAtom(atom, byScope) {
  if (atom === "all") return [{ surfaces: null, capabilities: null, targets: null }];
  const separator = atom.indexOf(":");
  if (separator < 1) hold("a selector has no namespace");
  const namespace = atom.slice(0, separator);
  const value = atom.slice(separator + 1);

  if (namespace === "surface") return [{ surfaces: [value], capabilities: null, targets: null }];
  if (namespace === "tool") {
    if (authorizationOperation(value) === null) hold("a tool selector does not resolve to a catalog operation");
    return [{ surfaces: ["mcp"], capabilities: [value], targets: null }];
  }
  if (namespace === "toolset") {
    const tools = (TOOLSET_TOOLS[value] ?? []).filter((tool) => authorizationOperation(tool) !== null);
    if (tools.length === 0) hold("a toolset selector does not resolve to any catalog operation");
    return [{ surfaces: ["mcp"], capabilities: [...tools].sort(), targets: null }];
  }
  if (namespace === "resource") {
    const operationId = capabilityForBoundary(value);
    if (operationId === null) hold("a resource selector does not resolve to a catalog operation");
    return [{ surfaces: ["mcp"], capabilities: [operationId], targets: null }];
  }
  if (namespace === "scope") {
    const entry = byScope.get(value);
    if (!entry || entry.capabilities.size === 0) hold("a scope selector matches no entry");
    return [{
      surfaces: [...entry.surfaces].sort(),
      capabilities: [...entry.capabilities].sort(),
      targets: null,
    }];
  }
  hold("a selector uses an unknown namespace");
}

function convertPolicy(policy, byScope) {
  const branches = [];
  const indexOfBranch = new Map();
  const atomMap = {};
  for (const atom of policy.capabilities) {
    const indices = [];
    for (const branch of branchesForAtom(atom, byScope)) {
      const key = JSON.stringify(branch);
      if (indexOfBranch.has(key)) {
        indices.push(indexOfBranch.get(key));
        continue;
      }
      indexOfBranch.set(key, branches.length);
      indices.push(branches.length);
      branches.push(branch);
    }
    atomMap[atom] = indices;
  }
  if (branches.length === 0) hold("a policy selector expands to no branch");
  return {
    constraint: {
      id: policy.id,
      label: policy.label,
      enabled: policy.enabled,
      subjects: [...policy.subjects],
      mode: policy.mode,
      selector: { anyOf: branches },
      schedule: {
        timezone: policy.timezone,
        weekly: policy.weekly,
        dateRanges: policy.dateRanges,
        startsAt: policy.startsAt,
        expiresAt: policy.expiresAt,
      },
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    },
    atomMap,
  };
}

/**
 * `importLegacyConstraints({policyDocument, boundaries})` -> `{constraints, idMap}`.
 *
 * `idMap[policyId][selector]` lists the `anyOf` branch indices that came from that
 * selector, inside its own constraint. A null/absent document converts nothing.
 */
export function importLegacyConstraints({ policyDocument = null, boundaries = catalogBoundaryKeys } = {}) {
  if (policyDocument === null || policyDocument === undefined) return { constraints: [], idMap: {} };
  if (!Array.isArray(boundaries)) hold("the boundary table is not a list");

  let document;
  try {
    document = validateAccessPolicyDocument(policyDocument);
  } catch (error) {
    // A broken policy — dormant or not — is a repair task, never a silent drop.
    hold(`the legacy document is not valid (${error?.code ?? "unknown"})`);
  }

  const byScope = buildEntryIndex(boundaries);
  const constraints = [];
  const idMap = {};
  for (const policy of document.policies) {
    const { constraint, atomMap } = convertPolicy(policy, byScope);
    constraints.push(constraint);
    idMap[policy.id] = atomMap;
  }

  // The output must be a valid new-format constraint set; a throw here is a
  // converter defect, not a migration condition.
  validateAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 1,
    timeConstraintsEnabled: false,
    subjects: {},
    constraints,
  });
  return { constraints, idMap };
}
