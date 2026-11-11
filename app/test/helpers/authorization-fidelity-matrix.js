// P1 — the permission fidelity matrix, shared by the phases that must prove it.
//
// One legacy policy meets one boundary at one instant; the OLD verdict comes from
// the frozen legacy evaluator (`access-policy/evaluate.js`) with the exact atoms
// the old gate would have sent, and the NEW verdict comes from the caller (the
// §8 reference matcher in the selector test, `authorize()` in the decision test).
// Equal verdicts are the proof; a difference is a HOLD row for the phase report.
//
// Admin, the anonymous publish page and system tasks are trusted contexts, so no
// legacy plane verdict exists for them. A Web route the legacy gate never reached
// (`/app` shell, login page, login style assets, the two exempt session routes)
// has no legacy verdict either: its row is `inconclusive`, and an inconclusive row
// is reported, never counted as agreement (the plan's shadow rule).
//
// `LEGACY_WEB_GATES` is the evidence from `src/app/routes.js` at P0 `c668c9fa`:
// `readGate` = `requireWebRead` (read scope), `filesGate` = `requireWebFiles`,
// `writeRouteGate` = the write class (read + write). `GET /api/web/v1/vaults` is
// in the read class on purpose: it carries `readGate` at routes.js:247.

import {
  capabilitiesForOAuthLifecycle,
  capabilitiesForResource,
  capabilitiesForTool,
  capabilitiesForWebRoute,
} from "../../src/access-policy/capabilities.js";
import { evaluateAccess } from "../../src/access-policy/evaluate.js";
import { evaluatePolicySchedule } from "../../src/access-policy/time.js";
import { TOOL_NAMES } from "../../src/config.js";
import {
  authorizationOperation,
  capabilityForBoundary,
  catalogBoundaryKeys,
  isOutsideTemporalPlane,
  surfaceForBoundary,
} from "../../src/authorization/catalog.js";
import { toolsetForTool } from "../../src/capability-catalog.js";

export const UUID_A = "3f1e6b2c-9a4d-4a53-9d1f-0c2b7e5a1c11";
export const UUID_B = "7c9e1f42-2b3d-4c88-8e6f-1a2b3c4d5e6f";
export const SUBJECT = "oauth-user:user-1";
export const SUBJECTS = Object.freeze([SUBJECT]);
export const TIMEZONE = "Asia/Shanghai";
export const INSIDE = Date.parse("2026-11-02T12:00:00+08:00"); // Monday 12:00 local
export const OUTSIDE = Date.parse("2026-11-02T20:00:00+08:00"); // Monday 20:00 local
export const DEFAULT_INSTANTS = Object.freeze([
  Object.freeze({ label: "inside", nowMs: INSIDE }),
  Object.freeze({ label: "outside", nowMs: OUTSIDE }),
]);

/** A legacy policy in the old document shape (already normalized by its validator). */
export function legacyPolicy(overrides = {}) {
  return {
    id: UUID_A,
    label: "legacy window",
    enabled: true,
    subjects: [SUBJECT],
    mode: "suspend",
    capabilities: ["tool:get_note"],
    timezone: TIMEZONE,
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

export function legacyDocument(policies) {
  return { schemaVersion: 1, revision: 3, policies };
}

/** The nine legacy policies the matrix runs: one per selector kind, both modes. */
export function fidelityPolicies() {
  return [
    legacyPolicy({ id: "11111111-1111-4111-8111-111111111111", label: "all", capabilities: ["all"] }),
    legacyPolicy({ id: "22222222-2222-4222-8222-222222222222", label: "web", capabilities: ["surface:web"] }),
    legacyPolicy({ id: "33333333-3333-4333-8333-333333333333", label: "mcp", capabilities: ["surface:mcp"] }),
    legacyPolicy({ id: "44444444-4444-4444-8444-444444444444", label: "oauth revoke", mode: "revoke", capabilities: ["all"] }),
    legacyPolicy({ id: "55555555-5555-4555-8555-555555555555", label: "tool", capabilities: ["tool:write_note"] }),
    legacyPolicy({ id: "66666666-6666-4666-8666-666666666666", label: "toolset", capabilities: [`toolset:${toolsetForTool("get_note")}`] }),
    legacyPolicy({ id: "77777777-7777-4777-8777-777777777777", label: "resource", capabilities: ["resource:obsidian://vault/index"] }),
    legacyPolicy({ id: "88888888-8888-4888-8888-888888888888", label: "files", capabilities: ["scope:obsidian.files"] }),
    legacyPolicy({ id: "99999999-9999-4999-8999-999999999999", label: "mixed", capabilities: ["surface:web", "tool:write_note"] }),
  ];
}

/**
 * The boundaries the legacy temporal gate really evaluated, with the atoms the old
 * gate would have sent and the (surface, capability) pair the catalog gives the
 * same boundary now.
 */
// Register and revoke are operations the legacy plane never evaluated: only the consent page,
// the code exchange and the refresh carried the OAuth-only-revoke rule.
const OAUTH_LIFECYCLE_CAPABILITIES = Object.freeze(["oauth_authorize", "oauth_code_exchange", "oauth_refresh"]);

export function gatedBoundaries() {
  const rows = [];
  for (const key of catalogBoundaryKeys) {
    const capability = capabilityForBoundary(key);
    const surface = surfaceForBoundary(key);
    const operation = authorizationOperation(capability);
    if (surface === "admin" || surface === "publish" || surface === "system") continue; // trusted contexts
    let legacy = null;
    if (TOOL_NAMES.includes(key)) legacy = capabilitiesForTool(key);
    else if (key.startsWith("obsidian://")) legacy = capabilitiesForResource(key);
    else if (surface === "mcp") legacy = capabilitiesForTool(capability); // direct upload keeps the MCP control tool
    // The OAuth endpoints were covered by the legacy OAuth-only-revoke rule; a revoke policy
    // denied them then too, so they are comparable rather than inconclusive.
    else if (surface === "oauth" && OAUTH_LIFECYCLE_CAPABILITIES.includes(capability)) legacy = capabilitiesForOAuthLifecycle();
    else {
      const scopeClass = Object.keys(LEGACY_WEB_SCOPE_CLASSES).find((name) => LEGACY_WEB_GATES[name].includes(key));
      // No scope class = the legacy gate never ran here: the row is inconclusive.
      if (scopeClass) legacy = capabilitiesForWebRoute({ scopes: LEGACY_WEB_SCOPE_CLASSES[scopeClass] });
    }
    // An operation outside the temporal plane was never evaluated by the legacy gate
    // either (the metadata plane bypasses it, A-07): its row is comparable only as an
    // "ungated" row, never as a policy decision the baseline made.
    if (isOutsideTemporalPlane(capability)) legacy = null;
    void operation;
    rows.push({ key, surface, capability, legacy, gated: legacy !== null });
  }
  // The OAuth lifecycle is not a manifest boundary but it is a gated surface.
  rows.push({ key: "oauth:token-lifecycle", surface: "oauth", capability: "oauth_refresh", legacy: capabilitiesForOAuthLifecycle(), gated: true });
  return rows;
}

/**
 * The OLD verdict: the real legacy evaluator plus the OAuth-surface rule.
 * `null` means "no legacy plane verdict" (the gate never ran): inconclusive.
 */
export function oldVerdict({ policies, surface, capabilities, subjects = [SUBJECT], nowMs }) {
  if (capabilities === null) return null; // the legacy gate never ran on this boundary
  const decision = evaluateAccess({ snapshot: { status: "ready", policies }, subjects, capabilities, nowMs });
  // protocol-methods.js:14-24 — only a revoke denies on the OAuth surface.
  if (surface === "oauth") return !(decision.allowed === false && decision.mode === "revoke");
  return decision.allowed;
}

const LEGACY_WEB_GATES = Object.freeze({
  read: Object.freeze([
    "GET /app/note/*", "GET /app/base/*", "GET /app/canvas/*",
    "GET /api/web/v1/vaults", "GET /api/web/v1/notes", "GET /api/web/v1/events",
    "GET /api/web/v1/note", "GET /api/web/v1/link/resolve", "GET /api/web/v1/publish",
    "GET /api/web/v1/themes", "GET /api/web/v1/theme.css", "GET /api/web/v1/theme-asset",
    "GET /api/web/v1/base", "GET /api/web/v1/base/raw", "GET /api/web/v1/canvas",
    "GET /api/web/v1/tags", "GET /api/web/v1/note-context/incoming",
    "GET /api/web/v1/note-context/outgoing", "GET /api/web/v1/note-context/unlinked",
    "GET /api/web/v2/search", "GET /api/web/v2/tree",
  ]),
  files: Object.freeze(["GET /api/web/v1/asset"]),
  write: Object.freeze([
    "POST /api/web/v1/note", "POST /api/web/v1/folder", "POST /api/web/v1/asset",
    "POST /api/web/v1/publish", "POST /api/web/v1/vault", "PATCH /api/web/v1/base",
    // Web rename and safe delete: the same write class (obsidian.read + obsidian.write).
    "POST /api/web/v1/rename", "POST /api/web/v1/delete",
  ]),
});

const LEGACY_WEB_SCOPE_CLASSES = Object.freeze({
  read: Object.freeze(["obsidian.read"]),
  files: Object.freeze(["obsidian.read", "obsidian.files"]),
  write: Object.freeze(["obsidian.read", "obsidian.write"]),
});

/** The §8 matching rule: `anyOf` is OR, branch fields are AND, arrays inside are OR. */
export function branchMatches(branch, { surface, capability }) {
  if (branch.surfaces !== null && !branch.surfaces.includes(surface)) return false;
  if (branch.capabilities !== null && !branch.capabilities.includes(capability)) return false;
  if (branch.targets !== null) return false;
  return true;
}

/** Reference NEW verdict for converted constraints (the §8 semantics). */
export function referenceNewVerdict({ constraints, surface, capability, subjects = [SUBJECT], nowMs }) {
  // The catalog declares the identity and public-shell OPERATIONS outside the
  // temporal plane, so the exemption is a property of the operation and no request
  // string can select it.
  if (isOutsideTemporalPlane(capability)) return true;
  const matched = constraints.filter((constraint) => constraint.enabled === true
    && constraint.subjects.some((subject) => subjects.includes(subject))
    && constraint.selector.anyOf.some((branch) => branchMatches(branch, { surface, capability })));
  const denied = matched.filter((constraint) => !evaluatePolicySchedule(constraint.schedule, nowMs).ok);
  if (surface === "oauth") return !denied.some((constraint) => constraint.mode === "revoke");
  return denied.length === 0;
}

/**
 * Run the matrix: every policy x every gated boundary x every instant.
 * `evaluateNew({policy, boundary, instant})` returns the NEW verdict as a boolean.
 */
export function runFidelityMatrix({ policies, evaluateNew, instants = DEFAULT_INSTANTS }) {
  const boundaries = gatedBoundaries();
  const rows = [];
  for (const policy of policies) {
    for (const boundary of boundaries) {
      for (const instant of instants) {
        rows.push({
          key: `${policy.id}|${boundary.key}|${instant.label}`,
          policyId: policy.id,
          label: policy.label,
          boundary: boundary.key,
          surface: boundary.surface,
          capability: boundary.capability,
          gated: boundary.gated,
          instant: instant.label,
          nowMs: instant.nowMs,
          // `capabilities: null` means the legacy gate never ran on this boundary. The OAuth
          // surface rule must not invent a verdict for it: the row is inconclusive.
          old: boundary.legacy === null
            ? null
            : oldVerdict({ policies: [policy], surface: boundary.surface, capabilities: boundary.legacy, nowMs: instant.nowMs }),
          new: evaluateNew({ policy, boundary, instant }),
        });
      }
    }
  }
  const comparable = rows.filter((row) => row.old !== null);
  const inconclusive = rows.filter((row) => row.old === null);
  return {
    rows,
    comparable,
    inconclusive,
    boundaries,
    instants,
    differences: comparable.filter((row) => row.old !== row.new),
  };
}
