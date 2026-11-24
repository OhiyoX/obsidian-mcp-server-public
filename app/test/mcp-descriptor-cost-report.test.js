// D1 gate: the measured `tools/list` descriptor cost for the compact and full
// discovery profiles, frozen so a change to the served descriptor set cannot
// pass silently.
//
// The golden numbers below were measured 2026-11-13 on 2f45eb8f from a real
// in-memory `client.listTools()` handshake, and re-frozen 2026-11-14 for C4
// (#668), which added the opt-in `includeProposals` input to `graph_health`
// (+287 bytes in both profiles). They are a contract, not a note: if
// a number differs, the assertion names it and the delta, and the descriptor set
// must be re-measured and re-frozen deliberately.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Isolate config module reads (Vault/DATA env) before importing source modules.
const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-descriptor-cost-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(SCRIPT_DIR, "scripts", "mcp-descriptor-cost-report.mjs");
const run = promisify(execFile);

const { TOOL_NAMES } = await import("../src/config.js");
const {
  buildDescriptorCostReport,
  captureToolsList,
  formatDescriptorCostTable,
} = await import("../scripts/mcp-descriptor-cost-report.mjs");

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// Re-measured for PR834: replacement safety copy and Git revision restore.
const GOLDEN = {
  "compact": {
    "profile": "compact",
    "descriptorCount": 35,
    "payloadBytes": 72843,
    "payloadSha256": "24be8e3956250a2ad3aef6f14a93e1f2f6e3d04dc2896eebad053693683e427a",
    "fingerprint": "0506214d7b723646",
    "oneOfDescriptors": 33,
    "oneOfBranches": 92,
    "oneOfBytes": 35155
  },
  "full": {
    "profile": "full",
    "descriptorCount": 92,
    "payloadBytes": 180088,
    "payloadSha256": "e1d844887cadf471b0ffb0050006b71ae4943f117713752afae2e04061126f5a",
    "fingerprint": "322a4660bb7831b8",
    "oneOfDescriptors": 0,
    "oneOfBranches": 92,
    "oneOfBytes": 0
  }
};

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

// A numeric golden must fail with its own name and delta, never as a bare
// assertion failure, so the message says what changed and by how much.
function assertGolden(measured, expected, label) {
  assert.equal(
    measured,
    expected,
    `${label}: frozen ${expected}, measured ${measured} (delta ${signed(measured - expected)}). ` +
      "The served tools/list descriptor set is a contract; re-measure and re-freeze deliberately.",
  );
}

// One real handshake per profile, reused by every assertion below.
const LISTS = {
  compact: await captureToolsList("compact"),
  full: await captureToolsList("full"),
};

const CONTEXT = { principalScope: "all", hostCapability: "tools/list" };

function report(profile) {
  return buildDescriptorCostReport(LISTS[profile], { ...CONTEXT, profile });
}

test("the compact profile reproduces the frozen 2026-11-13 cost exactly", () => {
  const golden = GOLDEN.compact;
  const measured = report("compact");

  assert.equal(measured.context.profile, "compact");
  assertGolden(measured.descriptorCount, golden.descriptorCount, "compact descriptor count");
  assertGolden(measured.toolsListPayload.bytes, golden.payloadBytes, "compact tools/list payload bytes");
  assert.equal(
    measured.toolsListPayload.sha256,
    golden.payloadSha256,
    `compact tools/list payload SHA-256: frozen ${golden.payloadSha256}, measured ${measured.toolsListPayload.sha256}. ` +
      "One descriptor byte changed; re-measure and re-freeze deliberately.",
  );
  assert.equal(
    measured.servedSchemaFingerprint,
    golden.fingerprint,
    `compact served-schema fingerprint: frozen ${golden.fingerprint}, measured ${measured.servedSchemaFingerprint}`,
  );

  assertGolden(measured.oneOf.descriptors, golden.oneOfDescriptors, "compact descriptors carrying inputSchema.oneOf");
  assertGolden(measured.oneOf.branches, golden.oneOfBranches, "compact oneOf branch total");
  assertGolden(measured.oneOf.bytes, golden.oneOfBytes, "compact oneOf bytes");

  // Per-descriptor rows must add up to the aggregate, so no descriptor is
  // counted twice or dropped from the total.
  assert.equal(measured.descriptors.length, golden.descriptorCount);
  assertGolden(
    measured.toolsListPayload.bytes,
    Buffer.byteLength(JSON.stringify(LISTS.compact), "utf8"),
    "compact payload bytes recomputed from the captured tools/list result",
  );
  assertGolden(
    measured.descriptors.reduce((sum, row) => sum + row.oneOfBranches, 0),
    golden.oneOfBranches,
    "compact per-descriptor branch sum",
  );
  assertGolden(
    measured.descriptors.reduce((sum, row) => sum + row.oneOfBytes, 0),
    golden.oneOfBytes,
    "compact per-descriptor oneOf byte sum",
  );
  const readTool = measured.descriptors.find((row) => row.name === "obsidian_read_read");
  assert.equal(readTool.oneOfBranches, 6, "obsidian_read_read serves 6 actions");
});

test("the full profile reproduces the frozen 2026-11-13 cost exactly", () => {
  const golden = GOLDEN.full;
  const measured = report("full");

  assert.equal(measured.context.profile, "full");
  assertGolden(measured.descriptorCount, golden.descriptorCount, "full descriptor count");
  assertGolden(measured.toolsListPayload.bytes, golden.payloadBytes, "full tools/list payload bytes");
  assert.equal(
    measured.toolsListPayload.sha256,
    golden.payloadSha256,
    `full tools/list payload SHA-256: frozen ${golden.payloadSha256}, measured ${measured.toolsListPayload.sha256}.`,
  );
  assert.equal(
    measured.servedSchemaFingerprint,
    golden.fingerprint,
    `full served-schema fingerprint: frozen ${golden.fingerprint}, measured ${measured.servedSchemaFingerprint}`,
  );
  assertGolden(measured.oneOf.descriptors, golden.oneOfDescriptors, "full descriptors carrying inputSchema.oneOf");
  assertGolden(measured.oneOf.branches, golden.oneOfBranches, "full oneOf branch total (one action per native descriptor)");
  assertGolden(measured.oneOf.bytes, golden.oneOfBytes, "full oneOf bytes");
});

test("action coverage is every TOOL_NAMES entry exactly once, with nothing missing or extra", () => {
  for (const profile of ["compact", "full"]) {
    const measured = report(profile);
    const coverage = measured.actionCoverage;
    assertGolden(coverage.expected, TOOL_NAMES.length, `${profile} expected action count`);
    assertGolden(coverage.covered, TOOL_NAMES.length, `${profile} covered action occurrences`);
    assertGolden(coverage.unique, TOOL_NAMES.length, `${profile} distinct covered actions`);
    assert.deepEqual(coverage.missing, [], `${profile} actions reachable from the descriptors but absent from TOOL_NAMES: ${coverage.missing.join(", ")}`);
    assert.deepEqual(coverage.extra, [], `${profile} actions not in TOOL_NAMES: ${coverage.extra.join(", ")}`);
    assert.deepEqual(coverage.duplicates, [], `${profile} actions exposed more than once: ${coverage.duplicates.join(", ")}`);
  }
});

test("a corrupted descriptor list fails loudly instead of reporting a smaller number", () => {
  const { tools } = LISTS.compact;
  const corrupt = (list) => () => buildDescriptorCostReport(list, { ...CONTEXT, profile: "compact" });

  // 1. One descriptor dropped: the payload shrinks and actions vanish. The
  //    report must refuse to state a number for a set that no longer covers the
  //    canonical catalog.
  const dropped = { tools: tools.filter((tool) => tool.name !== "obsidian_read_read_external") };
  assert.throws(
    corrupt(dropped),
    (error) => /action coverage/.test(error.message) && /missing=\[get_note_context\]/.test(error.message),
    "a dropped descriptor must throw and name the lost action",
  );

  // 2. One oneOf branch dropped inside a descriptor: fewer branches, fewer
  //    actions, smaller oneOf bytes — still a silent under-report if tolerated.
  const missingBranch = {
    tools: tools.map((tool) => (tool.name !== "obsidian_read_read"
      ? tool
      : { ...tool, inputSchema: { ...tool.inputSchema, oneOf: tool.inputSchema.oneOf.filter((branch) => branch.properties.action.const !== "list_base_views") } })),
  };
  assert.throws(
    corrupt(missingBranch),
    (error) => /missing=\[list_base_views\]/.test(error.message),
    "a dropped oneOf branch must throw and name the lost action",
  );

  // 3. A duplicated descriptor keeps every action present but double-counts
  //    bytes; only the duplicate check catches it.
  assert.throws(
    corrupt({ tools: [...tools, tools[0]] }),
    (error) => /duplicate descriptor name: /.test(error.message),
    "a duplicated descriptor must throw",
  );

  // 4. A branch without a routed action name cannot be counted or attributed.
  const malformedBranch = {
    tools: tools.map((tool) => (tool.name !== "obsidian_read_read"
      ? tool
      : { ...tool, inputSchema: { ...tool.inputSchema, oneOf: [...tool.inputSchema.oneOf, { properties: {} }] } })),
  };
  assert.throws(
    corrupt(malformedBranch),
    (error) => /obsidian_read_read: oneOf branch #6 has no properties\.action\.const/.test(error.message),
    "a branch with no action const must throw and name the descriptor and branch index",
  );

  // 5. The guards above must be about corruption, not about refusing lists: the
  //    intact list still reports.
  const intact = buildDescriptorCostReport({ tools }, { ...CONTEXT, profile: "compact" });
  assert.equal(intact.descriptorCount, GOLDEN.compact.descriptorCount);
});

test("token counts stay null and say why, instead of assuming bytes/4", () => {
  const measured = report("compact");
  assert.equal(measured.tokens.estimate, null);
  assert.equal(typeof measured.tokens.reason, "string");
  assert.ok(measured.tokens.reason.trim().length > 0, "the null token count must carry a reason");
  assert.ok(!JSON.stringify(measured).includes("estimatedTokens"), "no byte/4 token estimate may be reported");
});

test("the CLI prints the table and writes the same reports as JSON with --out", async () => {
  const outPath = path.join(TEST_ROOT, "descriptor-cost.json");
  const { stdout } = await run(process.execPath, [SCRIPT_PATH, "--out", outPath], {
    cwd: SCRIPT_DIR,
    env: { ...process.env },
    maxBuffer: 4 * 1024 * 1024,
  });

  for (const golden of Object.values(GOLDEN)) {
    assert.match(stdout, new RegExp(golden.profile), `the table must show the ${golden.profile} row`);
    assert.match(stdout, new RegExp(String(golden.payloadBytes)), `the table must show the ${golden.profile} payload bytes`);
  }

  const written = JSON.parse(await readFile(outPath, "utf8"));
  assert.deepEqual(
    written.reports.map((entry) => entry.context.profile),
    ["compact", "full"],
    "the JSON artifact holds both profiles",
  );
  const compact = written.reports[0];
  assertGolden(compact.toolsListPayload.bytes, GOLDEN.compact.payloadBytes, "CLI compact payload bytes");
  assertGolden(compact.descriptorCount, GOLDEN.compact.descriptorCount, "CLI compact descriptor count");
  assert.equal(compact.toolsListPayload.sha256, GOLDEN.compact.payloadSha256);
  assert.equal(compact.servedSchemaFingerprint, GOLDEN.compact.fingerprint);
  assert.equal(written.reports[1].servedSchemaFingerprint, GOLDEN.full.fingerprint);

  const table = formatDescriptorCostTable(written.reports);
  assert.equal(table.split("\n").length, 3, "one header, two profile rows");
  assert.match(table, /compact/);
  assert.match(table, /full/);
});
