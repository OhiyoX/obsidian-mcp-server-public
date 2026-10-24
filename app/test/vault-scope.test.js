// A3 — canonical MCP tool vault-scope registry (contract §7, §26 A3, §35, §43-1/2, §44-2).
//
// Twin: `app/src/vault-scope.js`. This file asserts the CANONICAL facts:
//   §7.1 global = {agent_bootstrap, server_info}; §7.2 every other canonical tool is
//   vault-scoped; §7.3 the optional 1–80 char `vaultId` spec; §7.4 tool count unchanged.
//
// Layering note — two assertions about "vault-scoped", deliberately different:
//   * THIS file asserts the canonical CLASSIFICATION target (contract §7.1/§7.2).
//   * `test/multi-vault-auth-characterization.test.js` ratchets today's AUTH behavior: the
//     `auth.js` `VAULT_SCOPED_TOOLS` set currently covers only get_publish_status /
//     manage_publish, and any non-Publish call collapses to the default Vault (old-red 2,
//     contract §1.4). Wave C replaces that set with this registry; that ratchet then flips.
//   Neither test proves the other: one records auth today, one records the canonical target.
//
// 落地 cross-check: the production classification is compared member-by-member against the
// frozen Wave 0 matrix (`test/helpers/multi-vault-tool-classification.js`, 87 tools). The
// helper stays read-only here — its removal and the switch of
// `test/multi-vault-tool-inventory.test.js` onto this module belong to Wave C (§28, W0-B §6).
//
// Deterministic and offline: no clock, no network, no writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAMES } from "../src/config.js";
import { MAX_VAULT_ID_LENGTH } from "../src/vault-runtime/descriptor.js";
import {
  GLOBAL_TOOLS,
  VAULT_ID_INPUT_SPEC,
  VAULT_SCOPED_TOOLS,
  VAULT_SCOPE_INVALID,
  applyVaultIdSpec,
  classifyTools,
  isVaultScopedTool,
} from "../src/vault-scope.js";
import {
  GLOBAL_TOOLS as W0B_GLOBAL_TOOLS,
  TOOL_CLASSIFICATION,
} from "./helpers/multi-vault-tool-classification.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_DIR, "..");
const MODULE_RELATIVE = "src/vault-scope.js";
const MODULE_SOURCE = () => fs.readFileSync(path.join(APP_ROOT, MODULE_RELATIVE), "utf8");

/** Vault-scoped names of the frozen W0-B matrix, in `TOOL_NAMES` order. */
const W0B_SCOPED_TOOLS = Object.freeze(
  Object.entries(TOOL_CLASSIFICATION)
    .filter(([, entry]) => entry.surface === "vault-scoped")
    .map(([name]) => name),
);

// ---------------------------------------------------------------------------
// Import scanner (comments + non-specifier string bodies blanked), self-proved.
// Same instrument as the A1 descriptor test so both allowlists are read the same way.
// ---------------------------------------------------------------------------
function stripForImports(source) {
  let out = "";
  let i = 0;
  let state = "code";
  let keep = false;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"') { keep = /(?:from|import)\s*$/.test(out); state = c === "'" ? "sq" : "dq"; out += c; i += 1; continue; }
      if (c === "`") { keep = false; state = "tpl"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") { if (c === "\n") state = "code"; out += c === "\n" ? c : " "; i += 1; continue; }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " "; i += 1; continue;
    }
    if (state === "tpl") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === "`") { state = "code"; out += c; i += 1; continue; }
      out += c === "\n" ? c : " "; i += 1; continue;
    }
    if (c === "\\") { out += keep ? c + (n ?? "") : "  "; i += 2; continue; }
    if (c === (state === "sq" ? "'" : '"')) { state = "code"; out += c; i += 1; continue; }
    out += keep ? c : " "; i += 1; continue;
  }
  return out;
}

/** Static imports as `[{ specifier, names }]`; comments/strings never produce bindings. */
function parseImports(source) {
  const text = stripForImports(source);
  const re = /\bimport\s*(?:([^"'`;]*?)\s+from\s+)?["']([^"']+)["']/g;
  const found = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const clause = (match[1] || "").trim();
    const names = [];
    let rest = clause;
    if (!clause.startsWith("{")) {
      const brace = clause.indexOf("{");
      const head = (brace === -1 ? clause : clause.slice(0, brace)).replace(/,\s*$/, "").trim();
      if (head && !head.startsWith("*")) names.push(head);
      rest = brace === -1 ? "" : clause.slice(brace);
    }
    if (rest.startsWith("{")) {
      for (const part of rest.slice(1, rest.lastIndexOf("}")).split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    found.push({ specifier: match[2], names });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Oracles shared by a real assertion and its negative control.
// ---------------------------------------------------------------------------
/** Problems with a (global, scoped) classification against `TOOL_NAMES` (contract §7.2). */
function classificationProblems(globalTools, scopedTools) {
  const union = [...globalTools, ...scopedTools];
  const problems = [];
  if (new Set(union).size !== union.length) problems.push("duplicate tool name");
  if ([...union].sort().join("\u0000") !== [...TOOL_NAMES].sort().join("\u0000")) problems.push("union != TOOL_NAMES");
  if (union.some((name) => !TOOL_NAMES.includes(name))) problems.push("name outside TOOL_NAMES");
  if (globalTools.some((name) => scopedTools.includes(name))) problems.push("global/scoped overlap");
  return problems;
}

/** Problems with a (global, scoped) classification against the frozen W0-B matrix (contract §7.1/§7.2). */
function surfaceProblems(globalTools, scopedTools) {
  const problems = [];
  if (globalTools.join("\u0000") !== [...W0B_GLOBAL_TOOLS].join("\u0000")) problems.push("global != frozen W0-B global set");
  if (scopedTools.join("\u0000") !== [...W0B_SCOPED_TOOLS].join("\u0000")) problems.push("scoped != frozen W0-B scoped set");
  return problems;
}

/** Problems with a `vaultId` spec against contract §7.3 + the descriptor bound. */
function specProblems(spec) {
  const problems = [];
  if (spec.name !== "vaultId") problems.push("name");
  if (spec.type !== "string") problems.push("type");
  if (spec.optional !== true) problems.push("optional");
  if (spec.minLength !== 1) problems.push("minLength");
  if (spec.maxLength !== MAX_VAULT_ID_LENGTH) problems.push("maxLength != descriptor.MAX_VAULT_ID_LENGTH");
  if (typeof spec.description !== "string" || spec.description.trim() === "") problems.push("description");
  if (Object.keys(spec).sort().join(",") !== "description,maxLength,minLength,name,optional,type") problems.push("key set");
  return problems;
}

// ---------------------------------------------------------------------------
// 1. Cross-check against the frozen Wave 0 matrix
// ---------------------------------------------------------------------------
test("W0-B cross-check: canonical GLOBAL_TOOLS equals the frozen matrix global set", () => {
  assert.deepEqual(GLOBAL_TOOLS, [...W0B_GLOBAL_TOOLS]);
});

test("W0-B cross-check: derived VAULT_SCOPED_TOOLS is element-wise equal to the frozen vault-scoped entries", () => {
  assert.deepEqual(surfaceProblems(GLOBAL_TOOLS, VAULT_SCOPED_TOOLS), [], "canonical classification must equal the frozen matrix");
  assert.deepEqual(VAULT_SCOPED_TOOLS, [...W0B_SCOPED_TOOLS]);
  // Anti-false-green anchors: the comparison must not be satisfied by two empty sets.
  assert.ok(VAULT_SCOPED_TOOLS.length > 0 && W0B_SCOPED_TOOLS.length > 0);
  assert.ok(VAULT_SCOPED_TOOLS.includes("get_note"));
  assert.ok(VAULT_SCOPED_TOOLS.includes("apply_note_plan"));
  assert.ok(!VAULT_SCOPED_TOOLS.includes("server_info"));
  assert.equal(Object.keys(TOOL_CLASSIFICATION).length, TOOL_NAMES.length, "frozen matrix must cover every canonical tool");
});

// ---------------------------------------------------------------------------
// 2. Frozen global set (contract §7.1)
// ---------------------------------------------------------------------------
test("GLOBAL_TOOLS is exactly {agent_bootstrap, server_info} and frozen", () => {
  assert.deepEqual(GLOBAL_TOOLS, ["agent_bootstrap", "server_info"]);
  assert.ok(Object.isFrozen(GLOBAL_TOOLS));
  for (const name of GLOBAL_TOOLS) assert.equal(isVaultScopedTool(name), false);
});

test("isVaultScopedTool agrees with the derived set for every canonical tool", () => {
  for (const name of TOOL_NAMES) {
    assert.equal(isVaultScopedTool(name), !GLOBAL_TOOLS.includes(name), `${name} classification`);
  }
  for (const unknown of ["", "not_a_tool", 42, null, undefined, {}, []]) {
    assert.equal(isVaultScopedTool(unknown), false, `${JSON.stringify(unknown)} must not classify as vault-scoped`);
  }
});

// ---------------------------------------------------------------------------
// 3. Coverage of TOOL_NAMES (contract §7.2, §7.4 — count unchanged)
// ---------------------------------------------------------------------------
test("TOOL_NAMES coverage: global ∪ scoped == TOOL_NAMES, disjoint, duplicate-free", () => {
  assert.deepEqual(classificationProblems(GLOBAL_TOOLS, VAULT_SCOPED_TOOLS), []);
  assert.deepEqual(VAULT_SCOPED_TOOLS, TOOL_NAMES.filter((name) => !GLOBAL_TOOLS.includes(name)), "order must follow TOOL_NAMES");
});

test("classifyTools: the pure rule derives the same sets and fails closed", () => {
  const classified = classifyTools(TOOL_NAMES);
  assert.equal(classified.global, GLOBAL_TOOLS);
  assert.deepEqual(classified.scoped, VAULT_SCOPED_TOOLS);
  assert.deepEqual(classifyTools(["agent_bootstrap", "server_info", "get_note"]).scoped, ["get_note"]);
  const rejects = [
    "get_note",
    [],
    ["agent_bootstrap", "server_info", "get_note", "get_note"],
    ["agent_bootstrap", "get_note"],
    ["agent_bootstrap", "server_info", ""],
    ["agent_bootstrap", "server_info", 7],
  ];
  for (const input of rejects) {
    assert.throws(() => classifyTools(input), (error) => error.code === VAULT_SCOPE_INVALID && error.message.startsWith(`[${VAULT_SCOPE_INVALID}] `), `must reject ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Canonical vaultId spec (contract §7.3)
// ---------------------------------------------------------------------------
test("VAULT_ID_INPUT_SPEC matches contract §7.3 and the descriptor ID bound", () => {
  assert.deepEqual(specProblems(VAULT_ID_INPUT_SPEC), []);
  assert.equal(VAULT_ID_INPUT_SPEC.maxLength, 80, "contract §3.2/§7.3 bound is 1–80");
  assert.equal(VAULT_ID_INPUT_SPEC.description, "不传 = default/primary Vault");
  assert.ok(Object.isFrozen(VAULT_ID_INPUT_SPEC));
});

test("applyVaultIdSpec merges the frozen canonical spec into a new object without mutating the input", () => {
  const input = { path: { type: "string" }, ifMatch: { type: "string", optional: true } };
  const snapshot = JSON.stringify(input);
  const merged = applyVaultIdSpec(input);
  assert.notEqual(merged, input);
  assert.equal(JSON.stringify(input), snapshot, "input schema must not be mutated");
  assert.deepEqual(Object.keys(merged).sort(), ["ifMatch", "path", "vaultId"]);
  assert.equal(merged.vaultId, VAULT_ID_INPUT_SPEC, "must share the frozen canonical spec, not a local copy");
  assert.deepEqual(applyVaultIdSpec({}), { vaultId: VAULT_ID_INPUT_SPEC });
});

test("applyVaultIdSpec is fail-closed on a duplicate vaultId or a non-plain-object schema", () => {
  for (const bad of [null, undefined, [], "vaultId", 42, Object.assign(Object.create({}), { path: {} })]) {
    assert.throws(() => applyVaultIdSpec(bad), (error) => error.code === VAULT_SCOPE_INVALID, `must reject ${JSON.stringify(bad)}`);
  }
  // Today's two Publish tools declare `vaultId` locally (contract §7.3 parity, Wave C).
  assert.throws(
    () => applyVaultIdSpec({ path: { type: "string" }, vaultId: { type: "string", optional: true } }),
    (error) => error.code === VAULT_SCOPE_INVALID && error.message.includes("already declares"),
  );
});

// ---------------------------------------------------------------------------
// 5. Architecture constraints (contract §43-5, brief §1.1/§2.2)
// ---------------------------------------------------------------------------
test("import scanner self-proof: only real static specifiers and bindings are reported", () => {
  const fixture = [
    'import { TOOL_NAMES } from "./config.js";',
    "// import { FAKE } from './auth.js';",
    'const text = "import { ALSO_FAKE } from \'./app/fake.js\'";',
    "const html = `<script>import x from \"./app/tpl.js\"</script>`;",
    "await import('./dynamic.js');",
    'import("./dynamic-two.js");',
  ].join("\n");
  const parsed = parseImports(fixture);
  assert.deepEqual(parsed.map((entry) => entry.specifier), ["./config.js"]);
  assert.deepEqual(parsed.flatMap((entry) => entry.names), ["TOOL_NAMES"]);
});

test("vault-scope.js imports only TOOL_NAMES + MAX_VAULT_ID_LENGTH (no auth.js, no app/**)", () => {
  const source = MODULE_SOURCE();
  const parsed = parseImports(source);
  assert.deepEqual(parsed.map((entry) => entry.specifier), ["./config.js", "./vault-runtime/descriptor.js"], "import allowlist changed (contract §43-5)");
  assert.deepEqual(parsed.flatMap((entry) => entry.names), ["TOOL_NAMES", "MAX_VAULT_ID_LENGTH"]);
  for (const { specifier } of parsed) {
    assert.ok(!/(^|\/)auth\.js$/.test(specifier), `${specifier} must not reach auth.js (Wave C owns that wiring)`);
    assert.ok(!specifier.replace(/^\./, "").includes("/app/"), `${specifier} must not reach app/**`);
  }
  const code = stripForImports(source);
  assert.ok(!/\bprocess\b/.test(code), "vault-scope.js must not read process.env (pure foundation)");
  assert.ok(!/\brequire\s*\(/.test(code), "no CommonJS require in an ESM module");
});

// ---------------------------------------------------------------------------
// 6. Negative controls of the real oracles (companions to the logged temp-break runs)
// ---------------------------------------------------------------------------
test("negative control: the frozen-matrix oracle detects server_info moved into the scoped set", () => {
  assert.deepEqual(surfaceProblems(GLOBAL_TOOLS, VAULT_SCOPED_TOOLS), [], "control precondition: the real pair is clean");
  // The brief's temp-break (1): move `server_info` from global to scoped. The union still equals
  // TOOL_NAMES, so only the frozen-surface comparison can see it — which is exactly why the
  // canonical classification is cross-checked member-by-member against W0-B.
  const problems = surfaceProblems(["agent_bootstrap"], [...VAULT_SCOPED_TOOLS, "server_info"]);
  assert.ok(problems.includes("global != frozen W0-B global set"));
  assert.ok(problems.includes("scoped != frozen W0-B scoped set"));
  assert.deepEqual(classificationProblems(["agent_bootstrap"], [...VAULT_SCOPED_TOOLS, "server_info"]), [], "documented blind spot of the union-only coverage oracle");
});

test("negative control: the coverage oracle detects a dropped, duplicated or overlapping tool", () => {
  assert.deepEqual(classificationProblems(GLOBAL_TOOLS, VAULT_SCOPED_TOOLS), [], "control precondition: the real pair is clean");
  const dropped = classificationProblems(GLOBAL_TOOLS, VAULT_SCOPED_TOOLS.filter((name) => name !== "get_note"));
  assert.ok(dropped.includes("union != TOOL_NAMES"));
  const duplicated = classificationProblems(GLOBAL_TOOLS, [...VAULT_SCOPED_TOOLS, "get_note"]);
  assert.ok(duplicated.includes("duplicate tool name"));
  const overlapped = classificationProblems(["agent_bootstrap", "server_info"], [...VAULT_SCOPED_TOOLS, "server_info"]);
  assert.ok(overlapped.includes("global/scoped overlap") && overlapped.includes("duplicate tool name"));
  const foreign = classificationProblems(GLOBAL_TOOLS, [...VAULT_SCOPED_TOOLS.slice(1), "not_a_tool"]);
  assert.ok(foreign.includes("name outside TOOL_NAMES"));
});

test("negative control: the spec oracle detects maxLength 79 and a forked key set", () => {
  assert.deepEqual(specProblems(VAULT_ID_INPUT_SPEC), [], "control precondition: the real spec is clean");
  const short = { ...VAULT_ID_INPUT_SPEC, maxLength: 79 };
  assert.ok(specProblems(short).includes("maxLength != descriptor.MAX_VAULT_ID_LENGTH"));
  assert.equal(short.maxLength, MAX_VAULT_ID_LENGTH - 1, "the mutation must be exactly one below the canonical bound");
  const forked = { ...VAULT_ID_INPUT_SPEC, pattern: "^x$" };
  assert.ok(specProblems(forked).includes("key set"));
});
