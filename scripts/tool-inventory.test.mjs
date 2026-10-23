// Focused tests for the Phase 0 tool inventory generator.
//
// Run from the repository root (after `cd app && npm ci`):
//
//   node --test scripts/tool-inventory.test.mjs
//
// These tests do not mutate the server, Vault, or checked-in files.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildInventory,
  canonicalJson,
  canonicalize,
  collectInventory,
  compareInventoryMonotonicity,
  deriveRisk,
  JSON_PATH,
  MARKDOWN_PATH,
  sha256,
} from "./tool-inventory.mjs";
import { TOOL_NAMES } from "../app/src/config.js";

test("canonicalize sorts object keys recursively and preserves array order", () => {
  const input = { b: 1, a: { d: [3, 1, 2], c: true } };
  assert.equal(canonicalJson(input), '{"a":{"c":true,"d":[3,1,2]},"b":1}');
  assert.deepEqual(canonicalize([{ z: 1, a: 2 }]), [{ a: 2, z: 1 }]);
});

test("sha256 is stable for canonical text", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("deriveRisk follows annotation hints", () => {
  assert.equal(deriveRisk({ readOnlyHint: true, destructiveHint: false }), "read-only");
  assert.equal(deriveRisk({ readOnlyHint: false, destructiveHint: true }), "destructive");
  assert.equal(deriveRisk({ readOnlyHint: false, destructiveHint: false }), "mutating");
});

test("buildInventory reports parity, counts and totals for synthetic tools", () => {
  const mk = (name) => ({
    name,
    title: name,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    outputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  const inventory = buildInventory({
    toolsList: [mk("alpha"), mk("beta")],
    moduleMap: new Map([["alpha", "tools/info.js"], ["beta", "tools/notes.js"]]),
    scopeRequirements: {
      alpha: ["obsidian.read"],
      beta: ["obsidian.read", "obsidian.write"],
    },
    toolNames: ["alpha", "beta"],
    toolchain: { mcpSdk: "0.0.0", zod: "0.0.0", jsonSchemaDialect: "test" },
  });

  assert.deepEqual(inventory.parity.missingVersusToolNames, []);
  assert.deepEqual(inventory.parity.extraVersusToolNames, []);
  assert.equal(inventory.parity.registrationOrderMatchesToolNames, true);
  assert.equal(inventory.totals.tools, 2);
  assert.ok(inventory.totals.inputSchemaBytes > 0);
  assert.deepEqual(inventory.counts.byModule, [
    { key: "tools/info.js", count: 1 },
    { key: "tools/notes.js", count: 1 },
  ]);
  assert.deepEqual(inventory.counts.byRisk, [{ key: "read-only", count: 2 }]);
});

test("buildInventory detects missing and extra tool names", () => {
  const mk = (name) => ({
    name,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  const inventory = buildInventory({
    toolsList: [mk("extra")],
    moduleMap: new Map([["extra", "tools/info.js"]]),
    scopeRequirements: { extra: ["obsidian.read"] },
    toolNames: ["missing"],
    toolchain: {},
  });
  assert.deepEqual(inventory.parity.missingVersusToolNames, ["missing"]);
  assert.deepEqual(inventory.parity.extraVersusToolNames, ["extra"]);
});

test("live capture matches TOOL_NAMES exactly (set parity)", async () => {
  const inventory = await collectInventory();
  assert.equal(inventory.parity.toolsListed, TOOL_NAMES.length);
  assert.equal(inventory.parity.uniqueToolNames, TOOL_NAMES.length);
  assert.deepEqual(inventory.parity.duplicateNames, []);
  assert.deepEqual(inventory.parity.missingVersusToolNames, []);
  assert.deepEqual(inventory.parity.extraVersusToolNames, []);
  assert.equal(inventory.tools.length, TOOL_NAMES.length);
});

test("every live tool has provable metadata", async () => {
  const inventory = await collectInventory();
  const names = new Set(inventory.tools.map((tool) => tool.name));
  assert.equal(names.size, TOOL_NAMES.length);
  for (const tool of inventory.tools) {
    assert.ok(tool.module.startsWith("tools/"), `${tool.name} module`);
    assert.equal(tool.domain, "unknown");
    assert.ok(tool.scope.length > 0, `${tool.name} scope`);
    assert.ok(["read-only", "destructive", "mutating"].includes(tool.risk), `${tool.name} risk`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name} ${hint}`);
    }
    assert.ok(tool.inputSchema.bytes > 0, `${tool.name} input bytes`);
    assert.match(tool.inputSchema.sha256, /^[0-9a-f]{64}$/);
    assert.equal(tool.outputContract.present, true, `${tool.name} output schema`);
  }
});

test("capture is deterministic across runs", async () => {
  const first = await collectInventory();
  const second = await collectInventory();
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test("frozen evidence snapshot stays historical and the live catalog is monotonically compatible", async () => {
  const inventory = await collectInventory();
  const checkedIn = JSON.parse(await readFile(JSON_PATH, "utf8"));
  // 85 frozen Wave 1 entries plus read_archive_entry (issue #254). Not rewritten
  // to absorb later additions such as get_note_context or an MCP SDK bump.
  assert.equal(checkedIn.tools.length, 86);
  assert.equal(checkedIn.parity.toolsListed, 86);
  assert.equal(checkedIn.toolchain.mcpSdk, "1.30.0");
  assert.equal(checkedIn.tools.some((tool) => tool.name === "get_note_context"), false);
  assert.equal(inventory.tools.some((tool) => tool.name === "get_note_context"), true);
  assert.deepEqual(compareInventoryMonotonicity(checkedIn, inventory), []);
});

test("checked-in inventory.md reports the frozen baseline (86 entries) and gaps", async () => {
  const checkedIn = JSON.parse(await readFile(JSON_PATH, "utf8"));
  const markdown = await readFile(MARKDOWN_PATH, "utf8");
  const formatted = checkedIn.totals.inputSchemaBytes.toLocaleString("en-US");
  assert.match(markdown, /Tools captured: \*\*86\*\*/);
  assert.ok(markdown.includes(`Total input-schema bytes: **${formatted}**`), `markdown total ${formatted}`);
  assert.match(markdown, /Values that cannot be extracted without a real `tools\/list`/);
  assert.match(markdown, /historical evidence snapshot/);
  assert.match(markdown, /does not require the snapshot/);
  assert.doesNotMatch(markdown, /fail if checked-in files drift/);
  assert.doesNotMatch(markdown, /compares byte-for-byte/);
});

test("--stdout is byte-identical across two runs", () => {
  const script = fileURLToPath(new URL("./tool-inventory.mjs", import.meta.url));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const run = () => spawnSync(process.execPath, [script, "--stdout"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith("\n"));
  assert.equal(first.stdout.includes("\r"), false);
});

test("--check exits 0 and does not write the evidence snapshot", async () => {
  const beforeJson = await readFile(JSON_PATH);
  const beforeMd = await readFile(MARKDOWN_PATH);
  const script = fileURLToPath(new URL("./tool-inventory.mjs", import.meta.url));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--check"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /monotonic compatibility holds \(snapshot 86 tools, live \d+ tools\)/);
  assert.deepEqual(await readFile(JSON_PATH), beforeJson);
  assert.deepEqual(await readFile(MARKDOWN_PATH), beforeMd);
});

// In-memory catalog rows for the monotonicity counterexamples. Risk labels are
// the three strings `deriveRisk` emits; there is no rank in app/src.
function gateTool(name, overrides = {}) {
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    ...(overrides.annotations || {}),
  };
  return {
    name,
    risk: overrides.risk ?? "mutating",
    scope: overrides.scope ?? ["obsidian.read"],
    annotations,
  };
}

function gatePair(snapshotTool, liveTool) {
  return compareInventoryMonotonicity({ tools: [snapshotTool] }, { tools: [liveTool] });
}

test("A1 live tool set must be a superset of the snapshot", () => {
  assert.deepEqual(
    compareInventoryMonotonicity(
      { tools: [gateTool("alpha"), gateTool("beta")] },
      { tools: [gateTool("alpha")] },
    ),
    ["A1 missing tool: beta"],
  );
  assert.deepEqual(
    compareInventoryMonotonicity(
      { tools: [gateTool("alpha")] },
      { tools: [gateTool("alpha"), gateTool("gamma")] },
    ),
    [],
  );
});

test("A2 derived risk must not be downgraded", () => {
  // Rank, weakest caution first: read-only < mutating < destructive.
  // Source comment on compareInventoryMonotonicity / deriveRisk in tool-inventory.mjs.
  assert.deepEqual(
    gatePair(gateTool("alpha", { risk: "destructive" }), gateTool("alpha", { risk: "read-only" })),
    ["A2 risk downgrade: alpha snapshot=destructive live=read-only"],
  );
  assert.deepEqual(
    gatePair(gateTool("alpha", { risk: "destructive" }), gateTool("alpha", { risk: "mutating" })),
    ["A2 risk downgrade: alpha snapshot=destructive live=mutating"],
  );
  assert.deepEqual(
    gatePair(gateTool("alpha", { risk: "mutating" }), gateTool("alpha", { risk: "read-only" })),
    ["A2 risk downgrade: alpha snapshot=mutating live=read-only"],
  );
  assert.deepEqual(
    gatePair(gateTool("alpha", { risk: "read-only" }), gateTool("alpha", { risk: "destructive" })),
    [],
  );
  assert.deepEqual(
    gatePair(gateTool("alpha", { risk: "mutating" }), gateTool("alpha", { risk: "nope" })),
    ["A2 unknown risk: alpha snapshot=mutating live=nope"],
  );
});

test("A3 required scopes must not shrink", () => {
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { scope: ["obsidian.read", "obsidian.write"] }),
      gateTool("alpha", { scope: ["obsidian.read"] }),
    ),
    ["A3 scope removed: alpha missing=obsidian.write"],
  );
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { scope: ["obsidian.read"] }),
      gateTool("alpha", { scope: ["obsidian.write", "obsidian.read"] }),
    ),
    [],
  );
});

test("A4 destructiveHint must not weaken from true to false", () => {
  // true warns of destructive updates (completeToolAnnotations / MCP destructiveHint).
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { annotations: { destructiveHint: true } }),
      gateTool("alpha", { annotations: { destructiveHint: false } }),
    ),
    ["A4 destructiveHint weakened: alpha true -> false"],
  );
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { annotations: { destructiveHint: false } }),
      gateTool("alpha", { annotations: { destructiveHint: true } }),
    ),
    [],
  );
});

test("A4 idempotentHint must not weaken from false to true", () => {
  // false warns that repeated calls can have additional effects. Claiming
  // idempotence (false→true) is the weaker caution. completeToolAnnotations
  // forces true only for read-only tools.
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { annotations: { idempotentHint: false } }),
      gateTool("alpha", { annotations: { idempotentHint: true } }),
    ),
    ["A4 idempotentHint weakened: alpha false -> true"],
  );
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { annotations: { idempotentHint: true } }),
      gateTool("alpha", { annotations: { idempotentHint: false } }),
    ),
    [],
  );
});

test("A4 openWorldHint must not weaken from true to false", () => {
  // true warns that the tool may touch an open world of external entities.
  // completeToolAnnotations leaves this false unless explicitly set.
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { annotations: { openWorldHint: true } }),
      gateTool("alpha", { annotations: { openWorldHint: false } }),
    ),
    ["A4 openWorldHint weakened: alpha true -> false"],
  );
  assert.deepEqual(
    gatePair(
      gateTool("alpha", { annotations: { openWorldHint: false } }),
      gateTool("alpha", { annotations: { openWorldHint: true } }),
    ),
    [],
  );
});
