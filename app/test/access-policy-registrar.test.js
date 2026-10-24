// Focused tests for AuthZ Wave B / B1 — access-policy MCP registrar
// (app/src/access-policy/registrar.js).
//
// Contract: `scratch/authz/INTERFACE.md` §10.1, BRIEF §2, DEVELOPMENT §11/§20.3.
// The registrar is exercised through fake servers and fake runtimes only: no
// filesystem, no clock, no sleeps, no real credentials. The full TOOL_NAMES set
// is registered dynamically, so the coverage contract never hardcodes 86.

import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_POLICY_URI } from "../src/agent-bootstrap.js";
import { capabilitiesForResource, capabilitiesForTool } from "../src/access-policy/capabilities.js";
import { ACCESS_DENY_CODES } from "../src/access-policy/errors.js";
import { createAccessPolicyRegistrar, METADATA_TOOLS } from "../src/access-policy/registrar.js";
import { TOOL_NAMES } from "../src/config.js";
import { requestContext, withRequestContext } from "../src/request-context.js";

const DENY_POLICY_ID = "0f8f7c2e-9f4d-4b1a-8ad2-4d3f5a6b7c8d";
const NEXT_ALLOWED_AT = "2026-10-06T01:00:00.000Z";

const ALLOWED = {
  allowed: true,
  mode: null,
  reason: "no_matching_policy",
  denyPolicyId: null,
  matchedPolicyIds: [],
};

function denyDecision(mode) {
  return {
    allowed: false,
    mode,
    reason: "outside_window",
    denyPolicyId: DENY_POLICY_ID,
    matchedPolicyIds: [DENY_POLICY_ID],
  };
}

const SUSPEND_DENIED = denyDecision("suspend");
const REVOKE_DENIED = denyDecision("revoke");
const BROKEN = {
  allowed: false,
  mode: null,
  reason: "policy_unavailable",
  denyPolicyId: null,
  matchedPolicyIds: [],
};

/** Counting fake runtime: proves evaluate/explain/audit discipline without a clock. */
function createRuntime({ status = "ready", decision = ALLOWED, auditFails = false } = {}) {
  const runtime = {
    status,
    evaluations: [],
    explanations: [],
    audits: [],
    evaluate(request) {
      runtime.evaluations.push(request);
      return typeof decision === "function" ? decision(request) : decision;
    },
    explain(request) {
      runtime.explanations.push(request);
      const resolved = typeof decision === "function" ? decision(request) : decision;
      return {
        ...resolved,
        now: "2026-10-05T12:00:00.000Z",
        timezone: "Asia/Shanghai",
        nextChangeAt: NEXT_ALLOWED_AT,
        nextAllowedAt: resolved.allowed || resolved.reason === "policy_unavailable" ? null : NEXT_ALLOWED_AT,
      };
    },
    audit(event) {
      runtime.audits.push(event);
      if (auditFails) throw new Error("audit sink unavailable");
    },
  };
  return runtime;
}

function createServer() {
  const tools = new Map();
  const resources = new Map();
  const prompts = new Map();
  return {
    tools,
    resources,
    prompts,
    server: { getClientVersion: () => ({ name: "fake-server", version: "9.9" }) },
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    registerResource(name, uri, config, handler) { resources.set(uri, { name, config, handler }); },
    registerPrompt(name, config, handler) { prompts.set(name, { config, handler }); },
  };
}

function spy(result = { marker: "handler-return" }) {
  const calls = [];
  const handler = (...args) => { calls.push(args); return result; };
  handler.calls = calls;
  return handler;
}

function authExtra(authInfo = { type: "oauth", clientId: "client-1", userId: "user-1" }) {
  return { authInfo };
}

/** One gated tool on a fake server; `invoke` calls the registered wrapper. */
function setup(runtime, { toolName = "get_note", handler = spy() } = {}) {
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  registrar.registerTool(toolName, {}, handler);
  return {
    server,
    handler,
    registrar,
    invoke: (args = {}, extra = authExtra()) => server.tools.get(toolName).handler(args, extra),
  };
}

test("every TOOL_NAMES registration is wrapped (dynamic, no hardcoded count)", async () => {
  const runtime = createRuntime();
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  const handlers = new Map();
  for (const name of TOOL_NAMES) {
    const handler = spy();
    handlers.set(name, handler);
    registrar.registerTool(name, { title: name }, handler);
  }
  assert.equal(server.tools.size, TOOL_NAMES.length);

  let wrappedCount = 0;
  for (const name of TOOL_NAMES) {
    const registered = server.tools.get(name);
    assert.equal(typeof registered.handler, "function", name);
    if (registered.handler !== handlers.get(name)) wrappedCount += 1;
    await registered.handler({}, authExtra());
    assert.equal(handlers.get(name).calls.length, 1, `${name} handler ran exactly once`);
  }
  assert.equal(wrappedCount, TOOL_NAMES.length);

  // Metadata tools bypass evaluate; every other tool is evaluated once.
  const nonMetadata = TOOL_NAMES.filter((name) => !METADATA_TOOLS.includes(name));
  assert.equal(runtime.evaluations.length, nonMetadata.length);
  for (const evaluation of runtime.evaluations) {
    assert.deepEqual(evaluation.subjects, ["oauth-client:client-1", "oauth-user:user-1"]);
    assert.equal(evaluation.capabilities[0], "all");
  }
});

test("metadata tools stay callable under deny; gated tools never reach the handler", async () => {
  assert.deepEqual(METADATA_TOOLS, ["server_info", "agent_bootstrap"]);
  assert.equal(Object.isFrozen(METADATA_TOOLS), true);

  const runtime = createRuntime({ decision: SUSPEND_DENIED });
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  const metadataSpies = METADATA_TOOLS.map(() => spy());
  METADATA_TOOLS.forEach((name, index) => registrar.registerTool(name, {}, metadataSpies[index]));
  const gated = spy();
  registrar.registerTool("get_note", {}, gated);

  for (const [index, name] of METADATA_TOOLS.entries()) {
    const result = await server.tools.get(name).handler({}, authExtra());
    assert.deepEqual(result, { marker: "handler-return" });
    assert.equal(metadataSpies[index].calls.length, 1);
  }
  const denied = await server.tools.get("get_note").handler({}, authExtra());
  assert.equal(denied.isError, true);
  assert.equal(gated.calls.length, 0);
  assert.equal(runtime.evaluations.length, 1);
});

test("suspend/revoke deny payload is stable and leaks no subject or vault content", async () => {
  for (const [mode, decision] of [["suspend", SUSPEND_DENIED], ["revoke", REVOKE_DENIED]]) {
    const runtime = createRuntime({ decision });
    const { invoke } = setup(runtime);
    const pollutedArgs = {
      path: "/vault/secret/note.md",
      title: "POLLUTED-TITLE",
      revision: "rev-9999",
      content: "POLLUTED-CONTENT",
    };
    const pollutedExtra = {
      authInfo: { type: "api-key", keyId: "RAW-KEY-ID-123", extra: { token: "SECRET-TOKEN" } },
    };
    const result = await invoke(pollutedArgs, pollutedExtra);

    assert.equal(result.isError, true);
    const expected = {
      code: ACCESS_DENY_CODES.OUTSIDE_WINDOW,
      mode,
      policyId: DENY_POLICY_ID,
      nextAllowedAt: NEXT_ALLOWED_AT,
    };
    assert.deepEqual(result.structuredContent, expected);
    assert.deepEqual(
      Object.keys(result.structuredContent).sort(),
      ["code", "mode", "nextAllowedAt", "policyId"],
    );
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse(result.content[0].text), expected);

    const serialized = JSON.stringify(result);
    for (const secret of [
      "RAW-KEY-ID-123", "SECRET-TOKEN", "/vault/secret/note.md",
      "POLLUTED-TITLE", "rev-9999", "POLLUTED-CONTENT",
      "weekly", "schedule", "Asia/Shanghai", "matchedPolicyIds",
    ]) {
      assert.equal(serialized.includes(secret), false, `deny payload leaked ${secret}`);
    }
    assert.equal(runtime.explanations.length, 1);
  }
});

test("every MCP deny emits exactly one authz.deny; allow/metadata/disabled/unknown emit none", async () => {
  // suspend and revoke denies: exactly one audit each, field-accurate, no clock.
  for (const [mode, decision] of [["suspend", SUSPEND_DENIED], ["revoke", REVOKE_DENIED]]) {
    const runtime = createRuntime({ decision });
    const { invoke, handler } = setup(runtime);
    const result = await invoke({ path: "/vault/secret/note.md" }, authExtra());
    assert.equal(result.isError, true, mode);
    assert.equal(handler.calls.length, 0, mode);
    assert.equal(runtime.audits.length, 1, `${mode} deny emits exactly one audit`);
    const [entry] = runtime.audits;
    assert.deepEqual(entry, {
      action: "authz.deny",
      outcome: "failure",
      surface: "mcp",
      mode,
      policyId: DENY_POLICY_ID,
      capabilities: capabilitiesForTool("get_note"),
      nextAllowedAt: NEXT_ALLOWED_AT,
      reason: "outside_window",
    });
    // The registrar never stamps `time`; the A4 runtime owns the clock.
    assert.equal(Object.hasOwn(entry, "time"), false, mode);
  }

  // A gated resource denies through the same single audit point.
  const resourceRuntime = createRuntime({ decision: SUSPEND_DENIED });
  const resourceServer = createServer();
  const resourceRegistrar = createAccessPolicyRegistrar(resourceServer, { runtime: resourceRuntime });
  const resourceHandler = spy();
  resourceRegistrar.registerResource("res-index", "obsidian://vault/index", {}, resourceHandler);
  const resourceResult = await resourceServer.resources.get("obsidian://vault/index").handler({ href: "obsidian://vault/index" }, authExtra());
  assert.equal(resourceResult.isError, true);
  assert.equal(resourceHandler.calls.length, 0);
  assert.deepEqual(resourceRuntime.audits, [{
    action: "authz.deny",
    outcome: "failure",
    surface: "mcp",
    mode: "suspend",
    policyId: DENY_POLICY_ID,
    capabilities: capabilitiesForResource("obsidian://vault/index"),
    nextAllowedAt: NEXT_ALLOWED_AT,
    reason: "outside_window",
  }]);

  // allow: handler runs, no audit.
  const allowRuntime = createRuntime();
  await setup(allowRuntime).invoke();
  assert.equal(allowRuntime.audits.length, 0, "allow path emits no audit");

  // metadata: bypasses the gate, no audit even under a deny decision.
  const metadataRuntime = createRuntime({ decision: SUSPEND_DENIED });
  const metadataServer = createServer();
  const metadataRegistrar = createAccessPolicyRegistrar(metadataServer, { runtime: metadataRuntime });
  metadataRegistrar.registerTool("server_info", {}, spy());
  await metadataServer.tools.get("server_info").handler({}, authExtra());
  assert.equal(metadataRuntime.audits.length, 0, "metadata path emits no audit");

  // disabled runtime: allow semantics, no audit.
  const disabledRuntime = createRuntime({ status: "disabled" });
  await setup(disabledRuntime).invoke();
  assert.equal(disabledRuntime.audits.length, 0, "disabled path emits no audit");

  // unknown tool: not the temporal layer's semantics, no audit.
  const unknownRuntime = createRuntime({ decision: SUSPEND_DENIED });
  const unknownServer = createServer();
  const unknownRegistrar = createAccessPolicyRegistrar(unknownServer, { runtime: unknownRuntime });
  unknownRegistrar.registerTool("not_a_catalog_tool_xyz", {}, spy());
  await unknownServer.tools.get("not_a_catalog_tool_xyz").handler({}, authExtra());
  assert.equal(unknownRuntime.audits.length, 0, "unknown-tool path emits no audit");
});

test("broken policy emits exactly one audit with mode:null and no explain", async () => {
  const runtime = createRuntime({ decision: BROKEN });
  const { invoke } = setup(runtime);
  const result = await invoke();
  assert.equal(result.isError, true);
  assert.equal(runtime.explanations.length, 0);
  assert.deepEqual(runtime.audits, [{
    action: "authz.deny",
    outcome: "failure",
    surface: "mcp",
    mode: null,
    policyId: null,
    capabilities: capabilitiesForTool("get_note"),
    nextAllowedAt: null,
    reason: "policy_unavailable",
  }]);
});

test("a throwing audit sink never flips a deny into an allow", async () => {
  const runtime = createRuntime({ decision: SUSPEND_DENIED, auditFails: true });
  const { invoke, handler } = setup(runtime);
  const result = await invoke();
  assert.equal(result.isError, true);
  assert.equal(handler.calls.length, 0);
  assert.deepEqual(result.structuredContent, {
    code: ACCESS_DENY_CODES.OUTSIDE_WINDOW,
    mode: "suspend",
    policyId: DENY_POLICY_ID,
    nextAllowedAt: NEXT_ALLOWED_AT,
  });
  // The sink was attempted exactly once; its failure was swallowed.
  assert.equal(runtime.audits.length, 1);
});

test("broken policy produces the stable unavailable payload without explain", async () => {
  const runtime = createRuntime({ decision: BROKEN });
  const { invoke } = setup(runtime);
  const result = await invoke();
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: ACCESS_DENY_CODES.POLICY_UNAVAILABLE });
  assert.deepEqual(JSON.parse(result.content[0].text), { code: ACCESS_DENY_CODES.POLICY_UNAVAILABLE });
  assert.equal(runtime.explanations.length, 0);
});

test("allow path runs the handler once and returns its result unchanged", async () => {
  const runtime = createRuntime();
  const sentinel = { ok: true, marker: "handler-return", nested: { n: 1 } };
  const handler = spy(sentinel);
  const { invoke } = setup(runtime, { handler });
  const result = await invoke({ note: "x" }, authExtra({ type: "api-key", keyId: "key-7" }));
  assert.equal(result, sentinel);
  assert.equal(handler.calls.length, 1);
  assert.deepEqual(runtime.evaluations, [{
    subjects: ["api-key:key-7"],
    capabilities: capabilitiesForTool("get_note"),
  }]);
});

test("resources: memory-policy bypasses the gate; canonical vault URIs do not; unknown URIs are not blocked", async () => {
  const runtime = createRuntime({ decision: SUSPEND_DENIED });
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  const uris = [MEMORY_POLICY_URI, "obsidian://vault/index", "obsidian://vault/tags", "obsidian://vault/graph"];
  const spies = new Map();
  for (const uri of uris) {
    const handler = spy();
    spies.set(uri, handler);
    registrar.registerResource(`res-${uri}`, uri, {}, handler);
  }
  const unknown = spy();
  registrar.registerResource("res-unknown", "obsidian://vault/unknown", {}, unknown);

  const memoryResult = await server.resources.get(MEMORY_POLICY_URI).handler({ href: MEMORY_POLICY_URI }, authExtra());
  assert.deepEqual(memoryResult, { marker: "handler-return" });
  assert.equal(spies.get(MEMORY_POLICY_URI).calls.length, 1);

  for (const uri of ["obsidian://vault/index", "obsidian://vault/tags", "obsidian://vault/graph"]) {
    const result = await server.resources.get(uri).handler({ href: uri }, authExtra());
    assert.equal(result.isError, true, uri);
    assert.deepEqual(result.structuredContent, {
      code: ACCESS_DENY_CODES.OUTSIDE_WINDOW,
      mode: "suspend",
      policyId: DENY_POLICY_ID,
      nextAllowedAt: NEXT_ALLOWED_AT,
    });
    assert.equal(spies.get(uri).calls.length, 0, uri);
  }

  const unknownResult = await server.resources.get("obsidian://vault/unknown").handler({ href: "obsidian://vault/unknown" }, authExtra());
  assert.deepEqual(unknownResult, { marker: "handler-return" });
  assert.equal(unknown.calls.length, 1);
  // memory-policy bypassed evaluate; the three canonical resources evaluated.
  assert.equal(runtime.evaluations.length, 3);
  const evaluated = runtime.evaluations.map((entry) => entry.capabilities.at(-1).slice("resource:".length)).sort();
  assert.deepEqual(evaluated, ["obsidian://vault/graph", "obsidian://vault/index", "obsidian://vault/tags"]);
  for (const evaluation of runtime.evaluations) {
    const uri = evaluation.capabilities.at(-1).slice("resource:".length);
    assert.deepEqual(evaluation.capabilities, capabilitiesForResource(uri));
  }
});

test("a tool the capability catalog does not know is never blocked", async () => {
  const runtime = createRuntime({ decision: SUSPEND_DENIED });
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  const name = "not_a_catalog_tool_xyz";
  assert.equal(capabilitiesForTool(name), null);
  const handler = spy();
  registrar.registerTool(name, {}, handler);

  const result = await server.tools.get(name).handler({}, authExtra());
  assert.deepEqual(result, { marker: "handler-return" });
  assert.equal(handler.calls.length, 1);
  assert.equal(runtime.evaluations.length, 0);
});

test("a disabled runtime is not short-circuited: handlers run and evaluate is still consulted", async () => {
  const runtime = createRuntime({ status: "disabled" });
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  const names = ["server_info", "agent_bootstrap", "get_note", "write_note", "start_file_upload"];
  const handlers = new Map();
  for (const name of names) {
    const handler = spy();
    handlers.set(name, handler);
    registrar.registerTool(name, {}, handler);
  }
  for (const name of names) {
    const result = await server.tools.get(name).handler({}, authExtra());
    assert.deepEqual(result, { marker: "handler-return" });
    assert.equal(handlers.get(name).calls.length, 1);
  }
  assert.equal(runtime.status, "disabled");
  // 5 tools - 2 metadata = 3 evaluations; metadata never bypasses silently.
  assert.equal(runtime.evaluations.length, 3);
  assert.ok(runtime.evaluations.length >= 1);
});

test("request-scoped authzUsage is marked denied on deny and untouched on allow", async () => {
  const denySetup = setup(createRuntime({ decision: SUSPEND_DENIED }));
  const denyUsage = { denied: false };
  let observed;
  await withRequestContext({ authzUsage: denyUsage }, async () => {
    const result = await denySetup.invoke();
    assert.equal(result.isError, true);
    observed = requestContext().authzUsage.denied;
  });
  assert.equal(observed, true);
  assert.equal(denyUsage.denied, true);

  const allowSetup = setup(createRuntime());
  const allowUsage = { denied: false };
  await withRequestContext({ authzUsage: allowUsage }, async () => {
    await allowSetup.invoke();
    assert.equal(requestContext().authzUsage.denied, false);
  });
  assert.equal(allowUsage.denied, false);

  // No authzUsage key: deny still returns a result and the key is not invented.
  const bareSetup = setup(createRuntime({ decision: SUSPEND_DENIED }));
  const bareContext = { author: { agent: "a", model: "m" } };
  const result = await withRequestContext(bareContext, () => bareSetup.invoke());
  assert.equal(result.isError, true);
  assert.equal(Object.hasOwn(bareContext, "authzUsage"), false);
});

test("write/files window denies produce no handler IO side effects", async () => {
  const runtime = createRuntime({ decision: SUSPEND_DENIED });
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime });
  const io = { handlerCalls: 0, writes: 0, reads: 0, transfers: 0 };
  const ioHandler = () => {
    io.handlerCalls += 1;
    io.writes += 1;
    io.reads += 1;
    io.transfers += 1;
    return { ok: true };
  };
  for (const name of ["write_note", "start_file_upload", "upload_file_chunk"]) {
    registrar.registerTool(name, {}, ioHandler);
  }
  for (const name of ["write_note", "start_file_upload", "upload_file_chunk"]) {
    const result = await server.tools.get(name).handler({ path: "x.md", content: "y" }, authExtra());
    assert.equal(result.isError, true, name);
  }
  assert.deepEqual(io, { handlerCalls: 0, writes: 0, reads: 0, transfers: 0 });
  assert.equal(runtime.evaluations.length, 3);
  assert.ok(runtime.evaluations.every((entry) => entry.capabilities.includes("scope:obsidian.write")));
  assert.ok(runtime.evaluations.some((entry) => entry.capabilities.includes("scope:obsidian.files")));
});

test("non-gated registrar members are delegated, not gated", () => {
  const server = createServer();
  const registrar = createAccessPolicyRegistrar(server, { runtime: createRuntime() });
  assert.deepEqual(registrar.getClientVersion(), { name: "fake-server", version: "9.9" });
  assert.equal(registrar.server, server.server);

  const prompt = spy({ messages: [] });
  registrar.registerPrompt("research_brief", { title: "t" }, prompt);
  assert.equal(server.prompts.get("research_brief").handler, prompt);
});
