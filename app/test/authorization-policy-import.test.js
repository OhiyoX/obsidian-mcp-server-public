// P1 / Task 6 — legacy temporal selectors become new constraint branches.
//
// Contract: design §8. One old policy stays one new constraint: the old selector
// list is an OR, so each old selector becomes its own `anyOf` branch, never an
// AND. `tool:`, `toolset:` and `resource:` selectors belong to the MCP surface
// only; a `scope:` selector expands onto the entries that actually used that
// scope at the baseline, direct upload keeps its MCP control-tool meaning, and a
// revoke policy keeps exactly one all-null branch. Every other field, including
// the UUID, is copied unchanged.
//
// The proof is a comparison, not an opinion: the shared fidelity matrix runs a
// legacy policy against every boundary the legacy gate really covered and both
// instants, and the OLD verdict from `access-policy/evaluate.js` must equal the
// NEW verdict under the §8 semantics. The Web session boundaries are part of the
// matrix: the catalog keeps them outside the temporal plane, so `all` and
// `surface:web` reach neither of them.

import assert from "node:assert/strict";
import test from "node:test";

import {
  importLegacyConstraints,
  LEGACY_POLICY_IMPORT_CODES,
} from "../src/authorization/legacy-policy-import.js";
import { importLegacyAuthorization } from "../src/authorization/legacy-import.js";
import {
  AUTHORIZATION_CATALOG_VERSION,
  authorizationOperation,
  capabilityForBoundary,
  isOutsideTemporalPlane,
  surfaceForBoundary,
} from "../src/authorization/catalog.js";
import { validateAuthorizationDocument } from "../src/authorization/schema.js";
import { capabilitiesForWebRoute } from "../src/access-policy/capabilities.js";
import { evaluateAccess } from "../src/access-policy/evaluate.js";
import { TOOLSET_TOOLS, toolsetForTool } from "../src/capability-catalog.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_RESOURCE_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import {
  INSIDE,
  OUTSIDE,
  SUBJECT,
  SUBJECTS,
  TIMEZONE,
  UUID_A,
  UUID_B,
  fidelityPolicies,
  legacyDocument,
  legacyPolicy,
  oldVerdict,
  referenceNewVerdict,
  runFidelityMatrix,
} from "./helpers/authorization-fidelity-matrix.js";

const newVerdict = referenceNewVerdict;
// The catalog keeps these two Web session boundaries outside the temporal plane.
const SESSION_BOUNDARIES = Object.freeze(["GET /api/web/v1/session", "POST /api/web/v1/vault/select"]);

function convert(policies) {
  return importLegacyConstraints({ policyDocument: legacyDocument(policies) });
}

test("mixed_surface_and_tool_selectors_preserve_OR_without_restricting_web_tool_aliases", () => {
  const policy = legacyPolicy({ capabilities: ["surface:web", "tool:write_note"] });
  const { constraints, idMap } = convert([policy]);
  const constraint = constraints[0];

  assert.deepEqual(constraint.selector.anyOf, [
    { surfaces: ["web"], capabilities: null, targets: null },
    { surfaces: ["mcp"], capabilities: ["write_note"], targets: null },
  ]);
  assert.deepEqual(idMap[policy.id], { "surface:web": [0], "tool:write_note": [1] });
  assert.equal(constraint.selector.anyOf.length, 2, "OR must stay two branches, never one AND");

  const webNotePost = { surface: "web", capability: "write_note" };
  const mcpWriteNote = { surface: "mcp", capability: "write_note" };
  const mcpGetNote = { surface: "mcp", capability: "get_note" };
  assert.equal(newVerdict({ constraints, ...webNotePost, nowMs: OUTSIDE }), false, "the Web note POST is covered by the surface:web branch");
  assert.equal(newVerdict({ constraints, ...mcpWriteNote, nowMs: OUTSIDE }), false, "the MCP write is covered by the tool branch");
  assert.equal(newVerdict({ constraints, ...mcpGetNote, nowMs: OUTSIDE }), true, "an unrelated MCP tool must not be restricted by an OR");
  assert.equal(newVerdict({ constraints, ...webNotePost, nowMs: INSIDE }), true, "inside the window nothing is denied");

  // A tool-only selector must not reach the Web route that shares the capability.
  const toolOnly = convert([legacyPolicy({ id: UUID_B, capabilities: ["tool:write_note"] })]);
  assert.deepEqual(toolOnly.constraints[0].selector.anyOf, [{ surfaces: ["mcp"], capabilities: ["write_note"], targets: null }]);
  assert.equal(newVerdict({ constraints: toolOnly.constraints, ...webNotePost, nowMs: OUTSIDE }), true);
  assert.equal(newVerdict({ constraints: toolOnly.constraints, ...mcpWriteNote, nowMs: OUTSIDE }), false);
});

test("scope_files_does_not_restrict_the_web_asset_post", () => {
  const { constraints } = convert([legacyPolicy({ capabilities: ["scope:obsidian.files"] })]);
  const branch = constraints[0].selector.anyOf[0];
  assert.deepEqual([...branch.surfaces].sort(), ["mcp", "web"]);
  assert.equal(branch.capabilities.includes("write_file"), false, "write_file never needed the files scope");

  assert.equal(newVerdict({ constraints, surface: "web", capability: "write_file", nowMs: OUTSIDE }), true, "Web asset POST keeps working");
  assert.equal(newVerdict({ constraints, surface: "web", capability: "get_file", nowMs: OUTSIDE }), false, "Web asset GET is files");
  assert.equal(newVerdict({ constraints, surface: "mcp", capability: "delete_file", nowMs: OUTSIDE }), false, "the MCP file tool is files");
  assert.equal(newVerdict({ constraints, surface: "mcp", capability: "write_note", nowMs: OUTSIDE }), true, "a note write is not files");
});

test("one_old_policy_becomes_one_constraint_and_keeps_every_other_field", () => {
  const policies = [
    legacyPolicy(),
    legacyPolicy({ id: UUID_B, label: "second", capabilities: ["scope:obsidian.read", "surface:mcp"] }),
  ];
  const { constraints, idMap } = convert(policies);
  assert.equal(constraints.length, 2, "one policy must stay one constraint");
  assert.deepEqual(Object.keys(idMap), [UUID_A, UUID_B]);

  const [first] = constraints;
  assert.equal(first.id, UUID_A);
  assert.equal(first.label, "legacy window");
  assert.equal(first.enabled, true);
  assert.deepEqual(first.subjects, SUBJECTS);
  assert.equal(first.mode, "suspend");
  assert.equal(first.createdAt, "2026-10-01T00:00:00.000Z");
  assert.equal(first.updatedAt, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(first.schedule, {
    timezone: TIMEZONE,
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
  });
  // A disabled policy stays disabled; nothing is switched on here.
  const disabled = convert([legacyPolicy({ enabled: false })]).constraints[0];
  assert.equal(disabled.enabled, false);
});

test("revoke_policy_becomes_exactly_one_all_null_branch", () => {
  const { constraints } = convert([legacyPolicy({ mode: "revoke", capabilities: ["all"] })]);
  assert.deepEqual(constraints[0].selector.anyOf, [{ surfaces: null, capabilities: null, targets: null }]);
  assert.equal(constraints[0].mode, "revoke");
  // Every surface is denied outside the window, including the OAuth lifecycle.
  for (const row of [
    { surface: "mcp", capability: "get_note" },
    { surface: "web", capability: "get_note" },
    { surface: "oauth", capability: "oauth_refresh" },
  ]) {
    assert.equal(newVerdict({ constraints, ...row, nowMs: OUTSIDE }), false);
  }
});

test("a_direct_upload_keeps_its_mcp_control_tool_behavior", () => {
  const chunk = "PUT /uploads/:uploadId";
  const complete = "PATCH /uploads/:uploadId";
  const otherMethod = "* /uploads/:uploadId";
  assert.equal(capabilityForBoundary(chunk), "start_direct_upload");
  assert.equal(surfaceForBoundary(chunk), "mcp");
  assert.equal(surfaceForBoundary(complete), "mcp");
  assert.equal(capabilityForBoundary(otherMethod), "start_direct_upload");
  assert.equal(surfaceForBoundary(otherMethod), "mcp");

  const mcpSuspend = convert([legacyPolicy({ capabilities: ["surface:mcp"] })]).constraints;
  assert.equal(newVerdict({ constraints: mcpSuspend, surface: "mcp", capability: "start_direct_upload", nowMs: OUTSIDE }), false);
  const toolSuspend = convert([legacyPolicy({ capabilities: ["tool:start_direct_upload"] })]).constraints;
  assert.equal(newVerdict({ constraints: toolSuspend, surface: "mcp", capability: "start_direct_upload", nowMs: OUTSIDE }), false);
  const webSuspend = convert([legacyPolicy({ capabilities: ["surface:web"] })]).constraints;
  assert.equal(newVerdict({ constraints: webSuspend, surface: "mcp", capability: "start_direct_upload", nowMs: OUTSIDE }), true);
});

test("tool_toolset_and_resource_selectors_are_limited_to_mcp", () => {
  const toolset = toolsetForTool("get_note");
  assert.equal(typeof toolset, "string");
  const cases = [
    { atom: "tool:get_note", expectedCapabilities: ["get_note"] },
    { atom: `toolset:${toolset}`, expectedCapabilities: [...TOOLSET_TOOLS[toolset]].sort() },
    { atom: "resource:obsidian://vault/index", expectedCapabilities: ["vault_index_read"] },
  ];
  for (const { atom, expectedCapabilities } of cases) {
    const { constraints } = convert([legacyPolicy({ capabilities: [atom] })]);
    const [branch] = constraints[0].selector.anyOf;
    assert.deepEqual(branch.surfaces, ["mcp"], atom);
    assert.deepEqual(branch.capabilities, expectedCapabilities, atom);
    assert.equal(newVerdict({ constraints, surface: "mcp", capability: expectedCapabilities[0], nowMs: OUTSIDE }), false, atom);
    assert.equal(newVerdict({ constraints, surface: "web", capability: "get_note", nowMs: OUTSIDE }), true, atom);
    assert.equal(newVerdict({ constraints, surface: "oauth", capability: "oauth_refresh", nowMs: OUTSIDE }), true, atom);
  }
});

test("old_and_new_verdicts_agree_across_the_fidelity_matrix", () => {
  const policies = fidelityPolicies();
  const { constraints } = convert(policies);
  const byId = new Map(constraints.map((constraint) => [constraint.id, constraint]));

  const { rows, comparable, inconclusive, boundaries, differences } = runFidelityMatrix({
    policies,
    evaluateNew: ({ policy, boundary, instant }) => newVerdict({
      constraints: [byId.get(policy.id)],
      surface: boundary.surface,
      capability: boundary.capability,
      nowMs: instant.nowMs,
    }),
  });

  // 184 manifest rows minus 39 Admin actions = 145 boundaries (the Task 4 rename and
  // delete routes are two of them); 130 carry a legacy plane verdict and 15 never
  // reached that gate (`/app` shell, login page, login style assets, the two exempt
  // session routes, and — §4.1a — the three instance metadata boundaries), so those rows
  // are inconclusive, never "agreeing".
  assert.equal(boundaries.length, 145);
  assert.equal(boundaries.filter((boundary) => boundary.gated).length, 130);
  assert.equal(boundaries.filter((boundary) => boundary.gated).length + inconclusive.length / (9 * 2), 145);
  assert.equal(rows.length, 9 * 145 * 2);
  assert.equal(rows.length, 2610);
  assert.equal(comparable.length, 9 * 130 * 2);
  assert.equal(comparable.length, 2340);
  assert.equal(inconclusive.length, 9 * 15 * 2);
  assert.equal(inconclusive.length, 270);
  assert.equal(new Set(inconclusive.map((row) => row.boundary)).size, 15);
  assert.equal(boundaries.some((boundary) => SESSION_BOUNDARIES.includes(boundary.key)), true);
  assert.equal(comparable.some((row) => row.old === true), true);
  assert.equal(comparable.some((row) => row.old === false), true);
  assert.deepEqual(differences, []);
  assert.deepEqual(comparable.map((row) => row.old), comparable.map((row) => row.new));

  // How many rows depend on the temporal exemption: 15 boundaries (2 Vault-session, 8
  // public auth/shell, and the 3 instance metadata boundaries of §4.1a, plus the two
  // credential-housekeeping endpoints). Each exempt row flips to deny when it is
  // evaluated as a content operation, and the gated Vault list does not flip.
  const exemptRows = rows.filter((row) => isOutsideTemporalPlane(row.capability));
  assert.equal(new Set(exemptRows.map((row) => row.boundary)).size, 15);
  assert.equal(exemptRows.length, 9 * 15 * 2);
  assert.equal(exemptRows.length, 270);
  for (const boundary of boundaries.filter((candidate) => isOutsideTemporalPlane(candidate.key))) {
    // A policy on the boundary's OWN surface, so the counterpart content capability is
    // matched by the window and the flip proves the exemption rather than the shape check.
    const { constraints } = convert([legacyPolicy({ capabilities: [`surface:${boundary.surface}`] })]);
    assert.equal(newVerdict({ constraints, surface: boundary.surface, capability: boundary.capability, nowMs: OUTSIDE }), true, boundary.key);
    // The exemption is the operation's, so the same request without the identity
    // operation would be denied: the capability carries the exemption, not a string.
    const asContentOperation = boundary.capability === "vault_select" ? "get_note" : "get_note";
    assert.equal(newVerdict({ constraints, surface: boundary.surface, capability: asContentOperation, nowMs: OUTSIDE }), false, `${boundary.key} must depend on the exemption`);
  }
  const vaultsRow = boundaries.find((boundary) => boundary.key === "GET /api/web/v1/vaults");
  assert.equal(vaultsRow.gated, true, "the legacy readGate covered the Vault list");
  assert.equal(vaultsRow.capability, "vault_list_read");
  assert.equal(isOutsideTemporalPlane(vaultsRow.capability), false);
  const webSuspension = convert([legacyPolicy({ capabilities: ["surface:web"] })]).constraints;
  assert.equal(newVerdict({ constraints: webSuspension, surface: vaultsRow.surface, capability: vaultsRow.capability, nowMs: OUTSIDE }), false, "the gated Vault list stays inside the plane");

  // The public auth pages and the app shell are exempt, so no inconclusive row is a
  // denial any more: a window cannot lock a person out of the login page.
  const inconclusiveDenials = inconclusive.filter((row) => row.new === false);
  assert.deepEqual(inconclusiveDenials.map((row) => `${row.boundary}|${row.label}|${row.instant}`), []);
});

test("five_hundred_and_twelve_policies_with_sixty_four_selectors_keep_the_constraint_count", () => {
  const atomPool = [
    "surface:mcp", "surface:web", "surface:oauth",
    "scope:obsidian.read", "scope:obsidian.write", "scope:obsidian.files",
    ...Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS).map((uri) => `resource:${uri}`),
    ...TOOL_NAMES.slice(0, 54).map((tool) => `tool:${tool}`),
  ];
  assert.equal(atomPool.length, 64, "64 distinct selectors, the old per-policy maximum");

  const policies = Array.from({ length: 512 }, (_, index) => legacyPolicy({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    label: `policy ${index}`,
    capabilities: [...atomPool],
  }));
  const { constraints, idMap } = convert(policies);

  assert.equal(constraints.length, 512, "the constraint count must not grow with the branch count");
  assert.deepEqual(constraints.map((constraint) => constraint.id), policies.map((policy) => policy.id));
  assert.equal(Object.keys(idMap).length, 512);
  assert.equal(constraints.every((constraint) => constraint.selector.anyOf.length <= 64), true);
  assert.equal(constraints[0].selector.anyOf.length <= 64, true);
  assert.doesNotThrow(() => validateAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 1,
    timeConstraintsEnabled: true,
    subjects: {},
    constraints,
  }));
});

test("a_dormant_broken_policy_raises_the_migration_hold", () => {
  const good = legacyPolicy({ id: UUID_A });
  // Disabled is not a licence to drop a policy that cannot be read.
  const dormantBroken = legacyPolicy({ id: UUID_B, enabled: false, capabilities: ["tool:not_a_real_tool"] });
  assert.throws(
    () => convert([good, dormantBroken]),
    (error) => {
      assert.equal(error.code, LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD);
      return true;
    },
  );
  assert.throws(
    () => importLegacyConstraints({ policyDocument: { schemaVersion: 1, revision: 1, policies: "nope" } }),
    (error) => error.code === LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD,
  );
  // §5.1 defines `grants: []` as "no rights"; an empty old capability list is a
  // broken rule, not a no-rights rule, so dropping it would grant. Keep the HOLD.
  assert.throws(
    () => convert([legacyPolicy({ capabilities: [] })]),
    (error) => error.code === LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD,
  );
  // An unreadable document never yields a partial conversion.
  assert.throws(
    () => importLegacyConstraints({ policyDocument: { schemaVersion: 99, revision: 1, policies: [] } }),
    (error) => error.code === LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD,
  );
});

test("conversion_never_touches_the_old_service", () => {
  const policies = [legacyPolicy({ capabilities: ["surface:web", "tool:write_note"] })];
  const document = legacyDocument(policies);
  const snapshot = structuredClone(document);
  const before = evaluateAccess({
    snapshot: { status: "ready", policies },
    subjects: SUBJECTS,
    capabilities: capabilitiesForWebRoute({ scopes: ["obsidian.read", "obsidian.write"] }),
    nowMs: OUTSIDE,
  });

  const { constraints } = importLegacyConstraints({ policyDocument: document });

  assert.deepEqual(document, snapshot, "the legacy document must not be mutated");
  const after = evaluateAccess({
    snapshot: { status: "ready", policies },
    subjects: SUBJECTS,
    capabilities: capabilitiesForWebRoute({ scopes: ["obsidian.read", "obsidian.write"] }),
    nowMs: OUTSIDE,
  });
  assert.deepEqual(after, before, "the old decision must not move");
  assert.equal(constraints.length, 1);
});

test("all_or_surface_web_never_reaches_the_web_session_boundaries", () => {
  // The session bootstrap and the Vault choice are identity and allowlist
  // decisions, not content operations: a revoke window must not lock a person out
  // of them, and no selector may expand onto them.
  for (const key of SESSION_BOUNDARIES) {
    const surface = surfaceForBoundary(key);
    const capability = capabilityForBoundary(key);
    assert.equal(surface, "web");
    assert.equal(capability, "vault_select");
    assert.equal(isOutsideTemporalPlane(capability), true, "the exemption is the operation's");

    for (const [capabilities, mode] of [[["all"], "revoke"], [["all"], "suspend"], [["surface:web"], "suspend"]]) {
      const { constraints } = convert([legacyPolicy({ capabilities, mode })]);
      assert.equal(newVerdict({ constraints, surface, capability, nowMs: OUTSIDE }), true, `${mode} ${capabilities} on ${key}`);
    }
    // A narrow selector still does not reach them either.
    for (const capabilities of [["tool:write_note"], ["scope:obsidian.read"], ["surface:mcp"]]) {
      const { constraints } = convert([legacyPolicy({ capabilities })]);
      assert.equal(newVerdict({ constraints, surface, capability, nowMs: OUTSIDE }), true, `${capabilities} on ${key}`);
    }
  }
  // The exemption is a property of two boundaries, not of the Web surface and not of
  // the `vault_select` capability: the gated Vault list shares that capability and
  // stays inside the temporal plane (Blocker 2).
  const webSuspension = convert([legacyPolicy({ capabilities: ["surface:web"] })]).constraints;
  assert.equal(newVerdict({ constraints: webSuspension, surface: "web", capability: "get_note", nowMs: OUTSIDE }), false);
  assert.equal(newVerdict({ constraints: webSuspension, surface: "web", capability: "vault_list_read", nowMs: OUTSIDE }), false);
  assert.equal(newVerdict({ constraints: webSuspension, surface: "web", capability: "vault_select", nowMs: OUTSIDE }), true);
  assert.equal(newVerdict({ constraints: webSuspension, surface: "web", capability: "session_bootstrap", nowMs: OUTSIDE }), true);
});

test("legacy_authorization_import_converts_the_policy_document", () => {
  const snapshot = () => ({
    oauthUsers: {
      "user-1": {
        id: "user-1",
        username: "user-1",
        allowedScopes: ["obsidian.read", "obsidian.write"],
        allowedVaults: ["default"],
      },
    },
    apiKeys: {},
    accessTokens: {},
    refreshTokens: {},
    clients: {},
    clientUsage: {},
    configuredApiKeyUsage: {},
    oauthUsersInitialized: true,
  });
  const policy = legacyPolicy({ capabilities: ["surface:web", "tool:write_note"] });
  const result = importLegacyAuthorization({
    providerSnapshot: snapshot(),
    policyDocument: legacyDocument([policy]),
    timeConstraintsEnabled: true,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });
  assert.equal(result.document.constraints.length, 1);
  assert.equal(result.document.timeConstraintsEnabled, true);
  assert.deepEqual(Object.keys(result.report.policyIdMap), [policy.id]);
  assert.equal(result.report.counts.constraints, 1);
  assert.doesNotThrow(() => validateAuthorizationDocument(result.document));

  // A broken policy document blocks the whole import: no document, no partial grants.
  const broken = legacyDocument([legacyPolicy({ capabilities: ["tool:not_a_real_tool"] })]);
  assert.throws(
    () => importLegacyAuthorization({
      providerSnapshot: snapshot(),
      policyDocument: broken,
      timeConstraintsEnabled: true,
      catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    }),
    (error) => error.code === LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD,
  );
});
