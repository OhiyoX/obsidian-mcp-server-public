// AuthZ Wave B / B5 — architecture contract tests.
//
// Contract: `scratch/authz/INTERFACE.md` §10.5 and DEVELOPMENT §21. These are
// structural assertions that lock the boundaries the time-window authorization
// feature depends on. Every set is derived from its canonical source (TOOL_NAMES,
// the capability catalog, the line budget in scripts/line-budget.mjs), never from
// a hard-coded tool count, so the contract stays true as the catalog grows.
// Source-string scans only lock architecture boundaries; behavioral coverage
// stays in the focused access-policy tests.
//
// Deterministic and offline: no clock, no network, no sleeps, no writes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { countLines, LINE_BUDGET, normalizeRepoPath } from "../scripts/line-budget.mjs";
import { parseBool, TOOL_NAMES } from "../src/config.js";
import { capabilitiesForTool } from "../src/access-policy/capabilities.js";
import { ACCESS_POLICY_CODES } from "../src/access-policy/errors.js";
import { createAccessPolicyRuntime } from "../src/access-policy/runtime.js";
import {
  ACCESS_POLICY_SCHEMA_VERSION,
  validateAccessPolicyDocument,
} from "../src/access-policy/schema.js";
import { policyFixture } from "./helpers/access-policy-fixtures.js";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = path.join(APP_ROOT, "src");
const ACCESS_POLICY_DIR = path.join(SRC_ROOT, "access-policy");
const ACCESS_POLICY_PREFIX = `${ACCESS_POLICY_DIR}${path.sep}`;

function readSource(absolutePath) {
  return fs.readFileSync(absolutePath, "utf8");
}

function relativeToApp(absolutePath) {
  return path.relative(APP_ROOT, absolutePath).split(path.sep).join("/");
}

function listFiles(root, predicate = () => true, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) listFiles(target, predicate, out);
    else if (entry.isFile() && predicate(target)) out.push(target);
  }
  return out;
}

function isJavaScript(file) {
  return /\.(?:js|mjs)$/.test(file);
}

// Extracts the module specifier of every static import/re-export, dynamic
// import() and require(). A boundary scan only needs to see specifiers, not the
// resolved module graph.
function importSpecifiers(sourceText) {
  const specifiers = [];
  const pattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(sourceText)) !== null) specifiers.push(match[1]);
  return specifiers;
}

function normalizeSpecifier(specifier) {
  return specifier.split("\\").join("/");
}

// Returns the text between the parentheses of the first `<callee>(` call, so a
// structural assertion can inspect a call's arguments without hard-coding lines.
function callArguments(sourceText, callee) {
  const start = sourceText.indexOf(`${callee}(`);
  if (start < 0) return null;
  const open = start + callee.length;
  let depth = 0;
  for (let index = open; index < sourceText.length; index += 1) {
    if (sourceText[index] === "(") depth += 1;
    else if (sourceText[index] === ")") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(open + 1, index);
    }
  }
  return null;
}

function isUnderAccessPolicy(absolutePath) {
  return absolutePath.startsWith(ACCESS_POLICY_PREFIX);
}

// ① Schedule/timezone policy logic only lives in src/access-policy. Every other
// production module (and server.js) may import the decision core nowhere. The
// current Wave A head has zero hits, and the assertion is written as a forbidden
// set so Wave C wiring cannot introduce one.
test("schedule and timezone decisions stay inside src/access-policy", () => {
  const decisionCoreMarkers = ["time.js", "evaluate.js"].map((name) => `access-policy/${name}`);
  const productionFiles = [...listFiles(SRC_ROOT, isJavaScript), path.join(APP_ROOT, "server.js")];
  assert.ok(productionFiles.length > 0, "the production scan must inspect real files");
  const offenders = [];
  for (const file of productionFiles) {
    for (const specifier of importSpecifiers(readSource(file))) {
      const normalized = normalizeSpecifier(specifier);
      if (decisionCoreMarkers.some((marker) => normalized.endsWith(marker)) && !isUnderAccessPolicy(file)) {
        offenders.push(`${relativeToApp(file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `only src/access-policy may import time.js/evaluate.js: ${offenders.join(", ")}`);

  // Sanity: the scan sees real decision-core imports inside the module.
  const runtimeImports = importSpecifiers(readSource(path.join(ACCESS_POLICY_DIR, "runtime.js")));
  assert.ok(runtimeImports.some((specifier) => specifier.endsWith("/evaluate.js")), "runtime.js must import the evaluator");
});

// ② The MCP registrar must wrap the full canonical tool catalog. Activated on
// the Wave B integration head; at base 45e838f the B1-owned registrar.js does
// not exist yet, so the assertion is reported as a known skip instead of a
// false pass.
const registrarModule = await import(new URL("../src/access-policy/registrar.js", import.meta.url))
  .then((module) => module)
  .catch(() => null);

test("the access-policy registrar wraps every canonical MCP tool", {
  skip: registrarModule
    ? false
    : "PENDING Wave B: src/access-policy/registrar.js is owned by B1 and absent at base 45e838f; runs once the Wave B integration head lands",
}, async () => {
  const { createAccessPolicyRegistrar } = registrarModule;
  assert.equal(typeof createAccessPolicyRegistrar, "function", "registrar must export createAccessPolicyRegistrar");

  const registered = [];
  const server = {
    registerTool(name, config, handler) {
      registered.push({ name, config, handler });
    },
    registerResource() {},
  };
  const runtime = createAccessPolicyRuntime({ enabled: false, store: null });
  const registrar = createAccessPolicyRegistrar(server, {
    runtime,
    isMetadataTool: () => false,
    isMetadataResource: () => false,
  });

  const originals = new Map();
  for (const name of TOOL_NAMES) {
    const original = (...args) => ({
      content: [{ type: "text", text: `${name}:${args[args.length - 1]?.probe ?? ""}` }],
      isError: false,
    });
    originals.set(name, original);
    registrar.registerTool(name, { description: name }, original);
  }

  assert.equal(registered.length, TOOL_NAMES.length, "registrar.registerTool must be called for every TOOL_NAMES entry");
  assert.deepEqual(registered.map((entry) => entry.name), [...TOOL_NAMES]);
  for (const entry of registered) {
    assert.notEqual(entry.handler, originals.get(entry.name), `${entry.name} must be wrapped by the access-policy registrar`);
  }

  // A disabled runtime is zero behavior difference: the wrapper still evaluates
  // (allow-all) and delegates to the real handler.
  const probe = { probe: "ok" };
  const throughWrapper = await registered[0].handler({}, probe);
  assert.deepEqual(throughWrapper, originals.get(TOOL_NAMES[0])({}, probe));
});

// ③ The capability namespace resolves from the canonical catalog and scope
// sources; tool names are never restated inside the access-policy module.
test("tool capabilities resolve from the canonical catalog and scope sources", () => {
  const file = path.join(ACCESS_POLICY_DIR, "capabilities.js");
  const text = readSource(file);
  assert.match(text, /from "\.\.\/capability-catalog\.js"/, "must import the capability catalog");
  assert.match(text, /from "\.\.\/scopes\.js"/, "must import the canonical scope table");

  const restated = TOOL_NAMES.filter((name) => text.includes(`"${name}"`) || text.includes(`'${name}'`));
  assert.deepEqual(restated, [], `canonical tool names must not be restated: ${restated.join(", ")}`);

  const unresolvable = TOOL_NAMES.filter((name) => {
    const capabilities = capabilitiesForTool(name);
    return !Array.isArray(capabilities) || !capabilities.includes(`tool:${name}`);
  });
  assert.deepEqual(unresolvable, [], `every canonical tool must resolve a capability set: ${unresolvable.join(", ")}`);
});

// ④ Authorization must never be cached through the hot-route cache.
test("the access-policy core never references the hot-route cache", () => {
  const offenders = listFiles(ACCESS_POLICY_DIR, isJavaScript)
    .filter((file) => /hot-route-cache/.test(readSource(file)))
    .map(relativeToApp);
  assert.deepEqual(offenders, []);
});

// ⑤ Tool discovery must not import the temporal policy evaluator to mutate
// tools/list.
test("tool discovery never imports the access-policy modules", () => {
  const text = readSource(path.join(SRC_ROOT, "discovery-runtime.js"));
  const offenders = importSpecifiers(text)
    .map(normalizeSpecifier)
    .filter((specifier) => specifier.includes("access-policy/"));
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(text, /access-policy/, "discovery-runtime.js must not mention the access-policy module");
});

// ⑥ The authz wiring targets stay inside the repository's canonical line budget.
// The budget and the registered-baseline policy are read from the same shared
// source as `npm run check` (scripts/line-budget.mjs + scripts/line-budget-baseline.json),
// so this assertion cannot silently drift from the architecture gate.
test("authz wiring targets stay within the canonical architecture line budget", (t) => {
  // Pin the frozen default: #280 moved the constant out of check-architecture.mjs
  // into the shared module, so assert the value itself instead of a source regex.
  assert.equal(LINE_BUDGET, 800, "the canonical default line budget is 800 lines (owner ruling 2026-10-11; not a hard limit)");

  const baseline = JSON.parse(readSource(path.join(APP_ROOT, "scripts", "line-budget-baseline.json")));
  const registered = new Map(
    Object.entries(baseline.entries ?? {}).map(([key, entry]) => [normalizeRepoPath(key), entry]),
  );

  // Sanity: the baseline parses and normalizes to real registered entries, so the
  // registered branch below cannot silently degrade into unreachable code.
  assert.ok(
    [...registered.values()].some((entry) => Number.isInteger(entry.maxLines)),
    "the line-budget baseline must register at least one entry with an integer maxLines",
  );

  // Follow-up guard: server.js dropped its baseline entry after the MCP session
  // lifecycle moved to src/mcp-sessions.js, and must stay under the default
  // budget without a re-registration.
  assert.equal(registered.has("server.js"), false, "server.js must stay out of the line-budget baseline");
  const serverLines = countLines(readSource(path.join(APP_ROOT, "server.js")));
  t.diagnostic(`server.js: ${serverLines} lines (default budget ${LINE_BUDGET}, unregistered)`);
  assert.ok(
    serverLines <= LINE_BUDGET,
    `server.js has ${serverLines} lines, exceeding the ${LINE_BUDGET}-line architecture budget`,
  );

  for (const relative of ["src/app/routes.js", "src/admin/router.js", "src/app/live-events.js"]) {
    const lines = countLines(readSource(path.join(APP_ROOT, relative)));
    const entry = registered.get(relative);
    if (!entry) {
      // Unregistered files must fit the default budget.
      t.diagnostic(`${relative}: ${lines} lines (default budget ${LINE_BUDGET}, unregistered)`);
      assert.ok(
        lines <= LINE_BUDGET,
        `${relative} has ${lines} lines, exceeding the ${LINE_BUDGET}-line architecture budget`,
      );
      continue;
    }
    // Registered files may only shrink below their recorded maxLines, and the
    // baseline entry must keep documenting why it is exempt.
    assert.ok(Number.isInteger(entry.maxLines), `${relative} baseline entry must record an integer maxLines`);
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim() !== "",
      `${relative} baseline entry must keep a non-empty reason`,
    );
    assert.ok(
      typeof entry.plan === "string" && entry.plan.trim() !== "",
      `${relative} baseline entry must keep a non-empty plan`,
    );
    t.diagnostic(`${relative}: ${lines} lines (registered maxLines ${entry.maxLines})`);
    assert.ok(
      lines <= entry.maxLines,
      `${relative} has ${lines} lines, exceeding its registered maxLines ${entry.maxLines}`,
    );
  }
});

// ⑪ Every Web content-plane registrar keeps the temporal `readGate` in its
// middleware chain (`requireApi: [requireApi, readGate]`). Dropping it for a bare
// `requireApi` would silently bypass the authorization window for that route, so
// the wiring is locked at the source level as well as by the HTTP gate tests.
// Scanned by slicing the registrar call's parentheses, never by line number.
test("the Web content route registrations keep the readGate in their middleware chain", () => {
  const text = readSource(path.join(SRC_ROOT, "app", "routes.js"));
  const registrars = [
    "registerSearchRoute",
    "registerTreeRoute",
    "registerBaseRoute",
    "registerNoteContextRoute",
    "registerTagsRoute",
  ];
  const offenders = [];
  for (const registrar of registrars) {
    const args = callArguments(text, registrar);
    if (args === null) offenders.push(`${registrar}: call not found`);
    else if (!args.includes("requireApi: [requireApi, readGate]")) {
      offenders.push(`${registrar}: requireApi is not [requireApi, readGate]`);
    }
  }
  assert.deepEqual(offenders, [], `every Web content registrar must keep the readGate: ${offenders.join(", ")}`);
});

// ⑦ Policy state lives only in the caller-supplied file: the access-policy core
// never touches OAuth state or Web session files, and the store never derives a
// path of its own.
test("policy state stays in the caller-supplied file and never touches OAuth/Web state", () => {
  const statePattern = /oauth[\\/]state\.json|web[\\/]sessions\.json|state\.json|sessions\.json/;
  const offenders = listFiles(ACCESS_POLICY_DIR, isJavaScript)
    .filter((file) => statePattern.test(readSource(file)))
    .map(relativeToApp);
  assert.deepEqual(offenders, []);

  const store = readSource(path.join(ACCESS_POLICY_DIR, "store.js"));
  assert.match(store, /constructor\(\s*\{[^}]*\bfile\b/, "the store must accept the caller-supplied file");
  assert.doesNotMatch(store, /DATA_PATH|access-policy\.json/, "the store must not hard-code a policy path");
});

// ⑧ Fixtures and focused tests must never carry real credentials.
test("access-policy fixtures and tests carry no real credentials", () => {
  // Assemble the API-key prefix so this scanner does not match its own source.
  const apiKeyPattern = new RegExp(`${["ob", "mcp_"].join("")}[A-Za-z0-9_-]{6,}`);
  const tokenShapes = [
    /["']([A-Za-z0-9+/]{40,}={0,2})["']/g,
    /["']([0-9a-fA-F]{32,})["']/g,
  ];
  const files = [
    path.join(APP_ROOT, "test", "helpers", "access-policy-fixtures.js"),
    ...listFiles(path.join(APP_ROOT, "test"), (file) => /^access-policy-.*\.test\.js$/.test(path.basename(file))),
  ];
  assert.ok(files.length >= 2, "the credential scan must cover the fixtures and the access-policy tests");

  for (const file of files) {
    const text = readSource(file);
    assert.doesNotMatch(text, apiKeyPattern, `${relativeToApp(file)} contains an API-key-shaped literal`);
    for (const pattern of tokenShapes) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)].map((match) => match[1]);
      assert.deepEqual(matches, [], `${relativeToApp(file)} contains a token-shaped literal: ${matches.join(", ")}`);
    }
  }
});

// ⑨ Hard revoke is principal-wide `all` only; a narrower revoke is refused at the
// schema boundary, never silently downgraded to suspend.
test("revoke policies are all-only at the schema boundary", () => {
  const document = (policy) => ({
    schemaVersion: ACCESS_POLICY_SCHEMA_VERSION,
    revision: 0,
    policies: [policy],
  });
  const narrower = { ...policyFixture(), mode: "revoke", capabilities: ["all", "tool:get_note"] };
  assert.throws(
    () => validateAccessPolicyDocument(document(narrower)),
    (error) => error?.code === ACCESS_POLICY_CODES.REVOKE_REQUIRES_ALL,
  );

  const allOnly = { ...policyFixture(), mode: "revoke", capabilities: ["all"] };
  assert.doesNotThrow(() => validateAccessPolicyDocument(document(allOnly)));
});

// ⑩ AUTHZ_ENABLED is the single feature flag and defaults to false.
test("AUTHZ_ENABLED is a single flag that defaults to false", () => {
  assert.equal(parseBool("false"), false);
  assert.equal(parseBool(""), false);
  assert.equal(parseBool("0"), false);
  assert.equal(parseBool("true"), true);
  assert.equal(parseBool("1"), true);

  const text = readSource(path.join(SRC_ROOT, "server-config.js"));
  assert.match(
    text,
    /export const AUTHZ_ENABLED = parseBool\(process\.env\.AUTHZ_ENABLED \|\| "false"\);/,
    "AUTHZ_ENABLED must default to false through parseBool",
  );

  const authzEnvReads = text.match(/process\.env\.AUTHZ_[A-Z_]+/g) || [];
  assert.deepEqual([...new Set(authzEnvReads)], ["process.env.AUTHZ_ENABLED"], "exactly one authz switch may exist");
  for (const forbidden of ["AUTHZ_MODE", "AUTHZ_ENFORCE", "AUTHZ_HIDE_DENIED_TOOLS"]) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not be introduced`);
  }
});

// Extra: a disabled runtime is a zero-behavior-difference allow, whatever the
// request looks like.
test("a disabled access-policy runtime is a zero-behavior-difference allow", () => {
  const runtime = createAccessPolicyRuntime({ enabled: false, store: null });
  for (const request of [
    { subjects: ["oauth-user:u1"], capabilities: ["all"] },
    { subjects: [], capabilities: [] },
    { subjects: ["unknown:subject"], capabilities: ["tool:get_note"] },
  ]) {
    assert.equal(runtime.evaluate(request).allowed, true);
    assert.equal(runtime.explain(request).allowed, true);
  }
  assert.deepEqual(runtime.summary(), { enabled: false, status: "disabled", policyCount: 0 });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.status, "disabled");
  assert.deepEqual([...snapshot.policies], []);
});
