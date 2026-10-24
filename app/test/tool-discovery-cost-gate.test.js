import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import { TOOLSET_TOOLS } from "../src/capability-catalog.js";
import { CORE_TOOL_NAMES } from "../src/capability-policy.js";
import { MCP_SCOPES } from "../src/scopes.js";
import {
  ALL_SCOPES,
  AUTHOR,
  COST_GATE_JSON,
  COST_GATE_MD,
  COST_GATE_SCHEMA_VERSION,
  DEFAULT_OUT_DIR,
  TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  applyViewToNativeDescriptors,
  buildCostGateReport,
  captureRawNativeCatalog,
  costGateExitCode,
  estimatedTokens,
  evaluateGate,
  fixedProfileDefinitions,
  verifyCheckedInArtifacts,
} from "../scripts/tool-discovery-cost-gate.mjs";
import { buildCapabilityPolicyView } from "../src/capability-policy.js";

let cached;
async function report() {
  if (!cached) cached = await buildCostGateReport();
  return cached;
}

test("cost-gate CLI exit policy only accepts the hold decision", () => {
  assert.equal(costGateExitCode("hold"), 0);
  assert.equal(costGateExitCode("candidate-shrink"), 1);
  assert.equal(costGateExitCode("unexpected"), 1);
});

test("the cost-gate Scope axis matches the Scope truth in src/scopes.js", () => {
  // Guards against the hardcoded axis drifting from the canonical scope list.
  assert.deepEqual(ALL_SCOPES, MCP_SCOPES);
});

test("cost gate report is deterministic for the current worktree", async () => {
  const first = await report();
  const second = await buildCostGateReport();
  assert.equal(first.contentDigest.sha256, second.contentDigest.sha256);
  assert.equal(first.catalog.toolCount, TOOL_NAMES.length);
  assert.equal(first.generatedBy, AUTHOR);
  assert.equal(first.schemaVersion, COST_GATE_SCHEMA_VERSION);
});

test("full profile is a native passthrough of all TOOL_NAMES in order", async () => {
  const current = await report();
  const full = current.fixedProfiles.find((row) => row.id === "full");
  assert.ok(full);
  assert.deepEqual(full.toolNames, TOOL_NAMES);
  assert.equal(full.hiddenToolCount, 0);
  assert.equal(full.coverage.criticalToolRecall, 1);
  assert.equal(full.coverage.missingCriticalRefs, 0);
});

test("core profile is the frozen seed and its critical-tool gap is quantified", async () => {
  const current = await report();
  const core = current.fixedProfiles.find((row) => row.id === "core");
  assert.ok(core);
  assert.deepEqual(core.toolNames, CORE_TOOL_NAMES);
  assert.equal(core.hiddenToolCount, TOOL_NAMES.length - CORE_TOOL_NAMES.length);
  // The whole point of P2-C: core is an engineering hypothesis, not a proven default.
  assert.ok(core.coverage.criticalToolRecall < 1);
  assert.ok(core.coverage.missingCriticalRefs > 0);
  assert.ok(core.coverage.fullyCoveredFixtures < core.coverage.fixtures);
});

test("every evaluated profile only removes catalog tools (never invents one)", async () => {
  const current = await report();
  const known = new Set(TOOL_NAMES);
  for (const profile of current.fixedProfiles) {
    assert.equal(profile.toolCount, profile.toolNames.length);
    for (const name of profile.toolNames) {
      assert.ok(known.has(name), `${profile.id} exposes unknown tool ${name}`);
    }
    assert.equal(profile.hiddenToolCount, TOOL_NAMES.length - profile.toolCount);
  }
});

test("scope matrix never leaks an unauthorized tool and stays inside authorized names", async () => {
  const current = await report();
  assert.equal(current.scopeMatrix.leakTotal, 0);
  for (const row of current.scopeMatrix.rows) {
    assert.deepEqual(row.leaks, []);
    assert.ok(row.visibleCount <= row.authorizedCount);
  }
  assert.ok(current.scopeMatrix.rows.length >= current.fixedProfiles.length);
});

test("under the read-only scope set no write-scoped tool becomes visible", async () => {
  const writeScoped = ["write_note", "git_commit", "apply_note_plan", "manage_publish", "memory_capture"];
  for (const definition of fixedProfileDefinitions()) {
    const names = buildCapabilityPolicyView({ grantedScopes: ["obsidian.read"], ...definition.policy }).toolNames;
    for (const name of writeScoped) {
      assert.equal(names.includes(name), false, `${definition.id} is a read-only view but exposes ${name}`);
    }
  }
});

test("module oracle can express every fixture's expected tools via toolset unions", async () => {
  const current = await report();
  assert.equal(current.moduleOracle.allCoverExpected, true);
  for (const row of current.moduleOracle.perFixture) {
    assert.equal(row.coversExpected, true, `${row.taskId} not expressible`);
    assert.ok(row.toolsets.every((toolset) => Object.hasOwn(TOOLSET_TOOLS, toolset)));
  }
});

test("best fixed module bundle covers all expected tools but shrinks the catalog only marginally", async () => {
  const current = await report();
  const bundle = current.bestFixedModuleBundle;
  assert.ok(bundle, "expected a fixed module bundle");
  assert.ok(bundle.toolCount <= TOOL_NAMES.length);
  assert.ok(bundle.descriptorBytes <= current.catalog.descriptorBytes);
  assert.ok(bundle.toolsets.every((toolset) => Object.hasOwn(TOOLSET_TOOLS, toolset)));
  assert.ok(bundle.toolsetsOmitted.every((toolset) => !bundle.toolsets.includes(toolset)));
  // Fixtures span almost the whole catalog, so cross-fixture static coverage forces
  // nearly the full toolset union back. This is the honest finding, not a bug.
  assert.ok(bundle.descriptorBytesReduction < 0.1, `expected a marginal reduction, got ${bundle.descriptorBytesReduction}`);
});

test("baseline limits disclose the 86-tool frozen baseline and additive tools", async () => {
  const current = await report();
  // The frozen inventory gained one additive entry (read_archive_entry, #254 B+C).
  assert.equal(current.baselineLimits.historicalInventoryToolCount, 86);
  assert.equal(current.baselineLimits.fixtureBaseline.taskCount, 50);
  assert.match(current.baselineLimits.fixtureBaseline.toolCatalog, /85 tools/);
  assert.deepEqual(current.baselineLimits.additiveToolsSinceFixtureBaseline, ["start_direct_upload", "patch_base", "create_base_entry", "list_base_views", "get_note_context"]);
  assert.deepEqual(current.baselineLimits.historicalInventoryMissingFromCurrentCatalog, []);
  assert.ok(current.baselineLimits.toolsUnreferencedByFixtures.includes("get_note_context"));
  assert.ok(current.baselineLimits.notes.join(" ").includes("get_note_context"));
});

test("token figures are explicit byte/4 estimates, never tokenizer output", async () => {
  const current = await report();
  assert.equal(estimatedTokens(10), Math.ceil(10 / TOKEN_ESTIMATE_BYTES_PER_TOKEN));
  assert.match(current.metricSemantics.estimatedTokens, /NO tokenizer/);
  assert.equal(current.metricSemantics.staticCoverageIsNotSuccess, true);
  assert.match(current.metricSemantics.wrongToolRisk, /NOT an observed wrong-tool selection rate/);
});

test("forbidden tool categories stay unmeasured instead of inventing a taxonomy", async () => {
  const current = await report();
  assert.match(current.metricSemantics.forbiddenToolCategories, /no canonical category->tool mapping/i);
  assert.ok(current.unmeasured.some((item) => item.includes("forbiddenToolCategories")));
});

test("gate holds the production default at full and lists its blockers", async () => {
  const current = await report();
  assert.equal(current.gate.decision, "hold");
  assert.equal(current.gate.productionDefaultProfile, "full");
  const byId = new Map(current.gate.checks.map((check) => [check.id, check]));
  for (const id of ["catalog-integrity", "full-passthrough", "no-scope-escalation", "historical-inventory-preserved", "fixture-contract", "static-coverage-expressible", "baseline-limit-disclosed"]) {
    assert.ok(byId.has(id), `missing gate check ${id}`);
    assert.equal(byId.get(id).pass, true, `${id} should pass`);
  }
  assert.equal(byId.get("default-shrink-readiness").pass, false);
  assert.ok(current.gate.blockers.some((blocker) => blocker.startsWith("default-shrink-readiness")));
});

test("gate fails loudly when the full passthrough or the scope invariant is violated", async () => {
  const current = await report();
  const brokenFull = structuredClone(current);
  brokenFull.fixedProfiles.find((row) => row.id === "full").hiddenToolCount = 1;
  const fullDecision = evaluateGate(brokenFull);
  assert.equal(fullDecision.decision, "hold");
  assert.equal(fullDecision.checks.find((check) => check.id === "full-passthrough").pass, false);

  const leaking = structuredClone(current);
  leaking.scopeMatrix.leakTotal = 1;
  const leakDecision = evaluateGate(leaking);
  assert.equal(leakDecision.checks.find((check) => check.id === "no-scope-escalation").pass, false);
});

test("report distinguishes canonical membership order from native wire order", async () => {
  const current = await report();
  assert.deepEqual(current.catalog.canonicalMembershipOrder, TOOL_NAMES);
  assert.equal(current.catalog.nativeRegistrationOrder.length, TOOL_NAMES.length);
  assert.equal(new Set(current.catalog.nativeRegistrationOrder).size, TOOL_NAMES.length);
  // Set equality is required; positional order is explicitly allowed to differ and
  // is recorded, not assumed. The supervisor independently observed 51 mismatches at the
  // 86-tool catalog; inserting read_archive_entry after inspect_archive shifted one more row,
  // #630's create_base_entry (registered next to patch_base, not at the canonical
  // position of the additive block) shifted two more, and #470 wave A's start_direct_upload
  // (registered next to start_file_upload) shifted one more.
  assert.equal(current.runtimeParity.positionalMismatchesVsCanonical, 55);
  assert.equal(current.runtimeParity.fullProfileWiredMatchesNative, true);
  assert.equal(current.runtimeParity.fullProfileWiredNamesDeepEqualNative, true);
  assert.equal(current.runtimeParity.fullProfileWiredDescriptorsDeepEqualNative, true);
  assert.equal(current.runtimeParity.nativeOrderDigest, current.runtimeParity.wiredOrderDigest);
});

test("raw native catalog capture is unsorted and matches the recorded native order", async () => {
  const current = await report();
  const raw = await captureRawNativeCatalog();
  assert.deepEqual(raw.map((tool) => tool.name), current.catalog.nativeRegistrationOrder);
  assert.equal(raw.length, TOOL_NAMES.length);
});

test("native descriptor permutation is preserved by the runtime membership filter", () => {
  const descriptors = TOOL_NAMES.map((name, index) => ({ name, marker: index }));
  const permuted = [...descriptors].reverse();
  const visible = new Set([TOOL_NAMES[0], TOOL_NAMES[5], TOOL_NAMES[10]]);
  const filtered = applyViewToNativeDescriptors(permuted, visible);
  assert.deepEqual(filtered.map((tool) => tool.name), [...permuted].filter((tool) => visible.has(tool.name)).map((tool) => tool.name));
  // The output follows the permuted wire order, not the canonical TOOL_NAMES order.
  assert.notDeepEqual(filtered.map((tool) => tool.name), TOOL_NAMES.filter((name) => visible.has(name)));
});

test("catalog-integrity cannot pass on pure-policy evidence or a tampered native order", async () => {
  const current = await report();
  const integrity = (candidate) => evaluateGate(candidate).checks.find((check) => check.id === "catalog-integrity");
  assert.equal(integrity(current).pass, true);

  // No runtimeParity block: pure-policy-only evidence must fail.
  const policyOnly = structuredClone(current);
  delete policyOnly.runtimeParity;
  assert.equal(integrity(policyOnly).pass, false);

  // Wired parity flag flipped: fail.
  const wiredFalse = structuredClone(current);
  wiredFalse.runtimeParity.fullProfileWiredMatchesNative = false;
  assert.equal(integrity(wiredFalse).pass, false);

  // Recorded native order tampered (reversed): the digest no longer matches.
  const tampered = structuredClone(current);
  tampered.catalog.nativeRegistrationOrder = [...tampered.catalog.nativeRegistrationOrder].reverse();
  assert.equal(integrity(tampered).pass, false);
});

test("checked-in cost-gate artifacts recompute offline", async () => {
  const verification = await verifyCheckedInArtifacts();
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.ok, true);
  assert.equal(verification.gateDecision, "hold");
  assert.equal(verification.toolCount, TOOL_NAMES.length);
});

test("cost-gate Markdown verifies under a CRLF checkout and still fails on a content edit", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "cost-gate-eol-"));
  try {
    await writeFile(path.join(outDir, COST_GATE_JSON), await readFile(path.join(DEFAULT_OUT_DIR, COST_GATE_JSON), "utf8"), "utf8");
    // The committed artifact is LF; a Windows checkout with core.autocrlf=true materializes CRLF.
    const lf = (await readFile(path.join(DEFAULT_OUT_DIR, COST_GATE_MD), "utf8")).replace(/\r\n/g, "\n");
    await writeFile(path.join(outDir, COST_GATE_MD), lf.replace(/\n/g, "\r\n"), "utf8");
    const crlf = await verifyCheckedInArtifacts({ outDir });
    assert.equal(crlf.ok, true, crlf.errors.join("; "));

    // Any non-EOL edit must still fail the same gate.
    await writeFile(path.join(outDir, COST_GATE_MD), `${lf.replace(/\n/g, "\r\n")}tampered\r\n`, "utf8");
    const tampered = await verifyCheckedInArtifacts({ outDir });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => error.includes(COST_GATE_MD)));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
