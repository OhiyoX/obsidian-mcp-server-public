// Focused tests for AuthZ Wave A / A2 capability expansion and validation
// (app/src/access-policy/capabilities.js). Read-only pure-module tests: no I/O,
// no Vault, no server. Contract: scratch/authz/INTERFACE.md §6.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_RESOURCE_SCOPE_REQUIREMENTS, MCP_SCOPES, MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { TOOLSET_TOOLS, toolsetForTool } from "../src/capability-catalog.js";
import {
  SCOPES,
  capabilitiesForOAuthLifecycle,
  capabilitiesForResource,
  capabilitiesForTool,
  capabilitiesForWebRoute,
  isValidCapabilityShape,
  unknownCapabilities,
  unknownSubjects,
} from "../src/access-policy/capabilities.js";

const MODULE_URL = new URL("../src/access-policy/capabilities.js", import.meta.url);

function scopesOf(capabilities) {
  return capabilities.filter((capability) => capability.startsWith("scope:"));
}

test("SCOPES reuses the scopes.js vocabulary instead of declaring a copy", () => {
  assert.equal(SCOPES, MCP_SCOPES);
  assert.deepEqual([...SCOPES], ["obsidian.read", "obsidian.write", "obsidian.files"]);
});

test("catalog parity: every catalog tool expands to all/surface/scopes/toolset/tool", () => {
  assert.ok(Array.isArray(TOOL_NAMES) && TOOL_NAMES.length > 0, "TOOL_NAMES must be non-empty");
  for (const name of TOOL_NAMES) {
    const capabilities = capabilitiesForTool(name);
    assert.ok(Array.isArray(capabilities), `capabilitiesForTool(${name}) must not be null`);
    const requiredScopes = MCP_TOOL_SCOPE_REQUIREMENTS[name];
    const toolset = toolsetForTool(name);
    assert.ok(Array.isArray(requiredScopes), `${name} must have scope requirements`);
    assert.ok(toolset, `${name} must have a catalog toolset`);

    assert.equal(capabilities[0], "all");
    assert.equal(capabilities[1], "surface:mcp");
    assert.deepEqual(capabilities.slice(2, 2 + requiredScopes.length), requiredScopes.map((scope) => `scope:${scope}`));
    assert.equal(capabilities.at(-2), `toolset:${toolset}`);
    assert.equal(capabilities.at(-1), `tool:${name}`);
    assert.equal(capabilities.length, requiredScopes.length + 4);

    // Scope set parity against the authorization truth (scopes.js).
    assert.deepEqual(scopesOf(capabilities).sort(), requiredScopes.map((scope) => `scope:${scope}`).sort());
    assert.equal(new Set(capabilities).size, capabilities.length, "capabilities must be unique");
    assert.deepEqual(unknownCapabilities(capabilities), [], `${name} must expand to canonical capabilities only`);
    assert.deepEqual(new Set(capabilities.filter((item) => !item.startsWith("scope:") && item !== "all")), new Set([
      "surface:mcp",
      `toolset:${toolset}`,
      `tool:${name}`,
    ]));
  }
});

test("unknown tool names fail closed with null", () => {
  const unknown = ["search_note", "get_note ", " get_note", "get_note:*", "", "*", "constructor", "__proto__", "toString"];
  for (const name of unknown) assert.equal(capabilitiesForTool(name), null, `${name} must not expand`);
  for (const value of [null, undefined, 42, {}, ["get_note"]]) assert.equal(capabilitiesForTool(value), null);
});

test("toolset namespace resolves against the catalog toolsets", () => {
  const toolsets = Object.keys(TOOLSET_TOOLS);
  assert.ok(toolsets.length > 0);
  for (const toolset of toolsets) {
    assert.ok(TOOLSET_TOOLS[toolset].length > 0, `${toolset} must register at least one tool`);
    assert.equal(isValidCapabilityShape(`toolset:${toolset}`), true);
    assert.deepEqual(unknownCapabilities([`toolset:${toolset}`]), []);
    for (const name of TOOLSET_TOOLS[toolset]) {
      assert.equal(toolsetForTool(name), toolset, `${name} must stay in toolset ${toolset}`);
    }
  }
  assert.deepEqual(unknownCapabilities(["toolset:", "toolset:nope", "toolset:bad name", "toolset:*"]), [
    "toolset:", "toolset:nope", "toolset:bad name", "toolset:*",
  ]);
});

test("canonical MCP resources expand with literal scope: prefixes; unknown URIs fail closed", () => {
  // Literal expectations (not derived from the implementation's own table): the
  // frozen vocabulary namespaces every capability string, so the raw scopes from
  // scopes.js MUST appear prefixed as `scope:<scope>`.
  const expected = new Map([
    ["obsidian://agent/memory-policy", ["all", "surface:mcp", "scope:obsidian.read", "resource:obsidian://agent/memory-policy"]],
    ["obsidian://vault/index", ["all", "surface:mcp", "scope:obsidian.read", "resource:obsidian://vault/index"]],
    ["obsidian://vault/tags", ["all", "surface:mcp", "scope:obsidian.read", "resource:obsidian://vault/tags"]],
    ["obsidian://vault/graph", ["all", "surface:mcp", "scope:obsidian.read", "resource:obsidian://vault/graph"]],
  ]);
  // The literal map above must cover exactly the canonical resource table.
  assert.deepEqual([...expected.keys()].sort(), Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS).sort());
  for (const [uri, capabilities] of expected) {
    assert.deepEqual(capabilitiesForResource(uri), capabilities, `${uri} must expand to the literal prefixed form`);
    // No raw (unprefixed) scope may ever leak into an expansion.
    for (const scope of MCP_SCOPES) {
      assert.equal(capabilities.includes(scope), false, `${uri} must not emit the raw scope ${scope}`);
    }
    assert.deepEqual(scopesOf(capabilities), ["scope:obsidian.read"]);
    assert.deepEqual(unknownCapabilities(capabilities), []);
    // The literal requirement of scopes.js is still the same scope, prefixed.
    assert.deepEqual(MCP_RESOURCE_SCOPE_REQUIREMENTS[uri].map((scope) => `scope:${scope}`), ["scope:obsidian.read"]);
    assert.deepEqual(unknownCapabilities([`resource:${uri}`]), []);
  }
  for (const value of ["obsidian://vault/nope", "obsidian://vault/index ", "", "obsidian://vault/index*x", null, undefined, 42, {}]) {
    assert.equal(capabilitiesForResource(value), null, `${JSON.stringify(value)} must not expand`);
  }
});

test("regression: a policy holding scope:obsidian.read matches a vault resource request", () => {
  // Fail-open regression. The evaluator authorizes on a non-empty set
  // intersection between policy capabilities and request capabilities, so an
  // unprefixed `obsidian.read` in the request would never intersect the only
  // legal policy spelling (`scope:obsidian.read`) and read constraints would
  // silently stop applying to vault resources.
  const resourceCaps = capabilitiesForResource("obsidian://vault/index");
  assert.ok(Array.isArray(resourceCaps), "obsidian://vault/index must expand");
  assert.equal(resourceCaps.includes("scope:obsidian.read"), true, "the prefixed read scope must be present");
  assert.equal(resourceCaps.includes("obsidian.read"), false, "the raw unprefixed scope must not be present");

  const readPolicy = ["scope:obsidian.read"];
  assert.equal(readPolicy.some((capability) => resourceCaps.includes(capability)), true, "a read-scoped policy must hit the vault resource request");

  // Reverse control: the assertion above must not be tautological.
  const writePolicy = ["scope:obsidian.write"];
  assert.equal(writePolicy.some((capability) => resourceCaps.includes(capability)), false, "a write-scoped policy must not hit a read-only resource");

  // Every canonical resource is read-scoped today; the same intersection must
  // hold for all of them, not just the sampled index URI.
  for (const uri of Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS)) {
    const caps = capabilitiesForResource(uri);
    assert.equal(readPolicy.some((capability) => caps.includes(capability)), true, `${uri} must intersect scope:obsidian.read`);
    assert.equal(writePolicy.some((capability) => caps.includes(capability)), false, `${uri} must not intersect scope:obsidian.write`);
  }
});

test("web routes reuse existing scopes and never invent a new vocabulary", () => {
  const capabilities = capabilitiesForWebRoute({ scopes: ["obsidian.read", "obsidian.write"] });
  assert.deepEqual(capabilities, ["all", "surface:web", "scope:obsidian.read", "scope:obsidian.write"]);
  assert.equal(capabilities.includes("all"), true);
  assert.equal(capabilities.includes("surface:web"), true);
  assert.deepEqual(capabilities.slice(2), ["scope:obsidian.read", "scope:obsidian.write"]);
  // Duplicates collapse; an empty declaration stays at the surface minimum.
  assert.deepEqual(capabilitiesForWebRoute({ scopes: ["obsidian.files", "obsidian.files"] }), ["all", "surface:web", "scope:obsidian.files"]);
  assert.deepEqual(capabilitiesForWebRoute({ scopes: [] }), ["all", "surface:web"]);
  // Any non-canonical scope fails the whole route closed.
  const rejected = [
    undefined, {}, { scopes: null }, { scopes: "obsidian.read" }, { scopes: {} },
    { scopes: ["obsidian.admin"] }, { scopes: ["obsidian.read", ""] }, { scopes: ["obsidian.read", null] },
    { scopes: ["*"] },
  ];
  for (const value of rejected) assert.equal(capabilitiesForWebRoute(value), null, `${JSON.stringify(value)} must fail closed`);
  assert.equal(capabilitiesForWebRoute(), null);
});

test("OAuth lifecycle is exactly all plus surface:oauth", () => {
  assert.deepEqual(capabilitiesForOAuthLifecycle(), ["all", "surface:oauth"]);
});

test("unknownCapabilities reports every unknown namespace entry in input order", () => {
  const mixed = [
    "all", "tool:get_note", "tool:search_note", "toolset:notes", "toolset:nope",
    "resource:obsidian://vault/index", "resource:obsidian://vault/nope",
    "scope:obsidian.read", "scope:obsidian.admin", "surface:web", "surface:desktop", "vault:x", "*", "",
  ];
  assert.deepEqual(unknownCapabilities(mixed), [
    "tool:search_note", "toolset:nope", "resource:obsidian://vault/nope",
    "scope:obsidian.admin", "surface:desktop", "vault:x", "*", "",
  ]);
  // Each namespace has an unknown sample and a canonical sample.
  assert.deepEqual(unknownCapabilities(["tool:nope"]), ["tool:nope"]);
  assert.deepEqual(unknownCapabilities(["toolset:nope"]), ["toolset:nope"]);
  assert.deepEqual(unknownCapabilities(["resource:nope"]), ["resource:nope"]);
  assert.deepEqual(unknownCapabilities(["scope:nope"]), ["scope:nope"]);
  assert.deepEqual(unknownCapabilities(["surface:nope"]), ["surface:nope"]);
  const canonical = [
    "all", "surface:mcp", "surface:web", "surface:oauth",
    `toolset:${Object.keys(TOOLSET_TOOLS)[0]}`,
    `tool:${TOOL_NAMES[0]}`,
    `resource:${Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS)[0]}`,
    ...MCP_SCOPES.map((scope) => `scope:${scope}`),
  ];
  assert.deepEqual(unknownCapabilities(canonical), []);
  // Non-canonical values and non-string entries stay in the result, in order.
  assert.deepEqual(unknownCapabilities([1, null, {}, "tool:get_note"]), [1, null, {}]);
  assert.deepEqual(unknownCapabilities("tool:nope"), []);
  assert.deepEqual(unknownCapabilities(null), []);
});

test("unknownSubjects mirrors the subjects.js grammar", () => {
  const valid = ["api-key:configured-env", "api-key:abc", "oauth-client:c1", "oauth-user:u1"];
  assert.deepEqual(unknownSubjects(valid), []);
  const invalid = ["user:u1", "", " ", "*", "api-key:", "api-key:*", "api-key:bad id", `api-key:${"x".repeat(161)}`, null, 42];
  assert.deepEqual(unknownSubjects(invalid), invalid);
  assert.deepEqual(unknownSubjects("api-key:abc"), []);
  assert.deepEqual(unknownSubjects(null), []);
});

test("isValidCapabilityShape checks prefixes and bounded enumerations", () => {
  const valid = [
    "all", "surface:mcp", "surface:web", "surface:oauth",
    ...MCP_SCOPES.map((scope) => `scope:${scope}`),
    "tool:get_note", "tool:not_a_registered_tool", "toolset:notes", "toolset:not_a_catalog_toolset",
    "resource:obsidian://vault/index", "resource:obsidian://vault/anything",
  ];
  for (const capability of valid) assert.equal(isValidCapabilityShape(capability), true, `${capability} must be well formed`);
  const invalid = [
    "", "*", "all:x", "surface:desktop", "surface:", "scope:obsidian.admin", "scope:",
    "tool:", "tool:*", "tool:bad name", "toolset:", "toolset:a*b", "resource:",
    "resource:with space", "vault:x", "obsidian.read", 42, null, undefined, {}, [],
  ];
  for (const capability of invalid) assert.equal(isValidCapabilityShape(capability), false, `${JSON.stringify(capability)} must be rejected`);
  assert.equal(isValidCapabilityShape(`tool:${"x".repeat(161)}`), false);
  assert.equal(isValidCapabilityShape(`tool:${"x".repeat(160)}`), true);
});

test("expansion results are fresh, deterministic arrays", () => {
  const first = capabilitiesForTool(TOOL_NAMES[0]);
  const snapshot = [...first];
  first.push("tool:injected");
  assert.deepEqual(capabilitiesForTool(TOOL_NAMES[0]), snapshot);
  assert.notEqual(capabilitiesForTool(TOOL_NAMES[0]), first);
  assert.deepEqual(capabilitiesForTool(TOOL_NAMES[0]), capabilitiesForTool(TOOL_NAMES[0]));
  assert.deepEqual(capabilitiesForOAuthLifecycle(), capabilitiesForOAuthLifecycle());
  assert.notEqual(capabilitiesForOAuthLifecycle(), capabilitiesForOAuthLifecycle());
});

test("capabilities.js restates no tool/scope/resource list and stays pure", async () => {
  const text = await readFile(MODULE_URL, "utf8");
  const lines = text.split(/\r?\n/);
  assert.ok(lines.length <= 500, `capabilities.js is ${lines.length} lines`);
  // The anti-duplication guard: no second copy of a canonical table.
  assert.doesNotMatch(text, /TOOLSET_TOOLS\s*=\s*\{/);
  assert.doesNotMatch(text, /MCP_TOOL_SCOPE_REQUIREMENTS\s*=\s*\{/);
  assert.doesNotMatch(text, /MCP_RESOURCE_SCOPE_REQUIREMENTS\s*=\s*\{/);
  assert.doesNotMatch(text, /MCP_SCOPES\s*=\s*\[/);
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(text, new RegExp(`["']${name}["']`), `${name} must not be hardcoded`);
  }
  for (const scope of MCP_SCOPES) {
    assert.doesNotMatch(text, new RegExp(`["']${scope.replace(".", "\\.")}["']`), `${scope} must not be hardcoded`);
  }
  for (const uri of Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS)) {
    assert.equal(text.includes(`"${uri}"`), false, `${uri} must not be hardcoded`);
  }
  // Reuse of the existing modules is explicit.
  assert.match(text, /from "\.\.\/scopes\.js"/);
  assert.match(text, /from "\.\.\/capability-catalog\.js"/);
  assert.match(text, /from "\.\.\/config\.js"/);
  assert.doesNotMatch(text, /Date\.now|process\.env|node:fs|node:child_process/);
});
