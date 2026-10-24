// Wave C — focused tests for the MCP vault-scope registrar
// (`app/src/vault-scope-registrar.js`).
//
// Contract: `Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md`
// §6 (context keys), §7 / §7.3 (canonical registry + schema), §7.4 (tool count),
// §8 (registrar order), §9 (HTTP gate companion), §19 (resources primary-only),
// §28 (Wave C), §34 (authorization matrix), §43-3/§43-4.
//
// The registrar is exercised through fake servers and injected spies: no Vault
// content, no real inventory and no credentials. `resolveVaultRuntime` /
// `vaultExists` are the injected seams, so "deny before I/O" is provable instead
// of asserted in prose.
//
// Environment is assigned before the src modules are imported because
// `src/config.js` resolves its paths at module evaluation.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod/v4";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-scope-registrar-"));
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.HISTORY_PATH = path.join(ROOT, "data", "history");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(process.env.VAULT_PATH, { recursive: true });
await fs.mkdir(process.env.DATA_PATH, { recursive: true });

const { VAULT_SCOPE_DENY_CODES, canonicalVaultIdProperty, createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");
const { VAULT_ID_INPUT_SPEC } = await import("../src/vault-scope.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { requestContext, withRequestContext } = await import("../src/request-context.js");

const AUTHOR = { agent: "wave-c", model: "test" };
const RUNTIME_A = Object.freeze({ id: DEFAULT_VAULT_ID, primary: true });
const RUNTIME_B = Object.freeze({ id: "beta", primary: false });

/** Fake upstream registrar that captures tool/resource registrations. */
function fakeServer() {
  const tools = new Map();
  const resources = new Map();
  const server = {
    server: { getClientVersion: () => ({ name: "vault-scope-test", version: "0" }) },
    getClientVersion: () => ({ name: "vault-scope-test", version: "0" }),
    registerTool(name, config, handler) { tools.set(name, { config, handler }); return { name }; },
    registerResource(name, uri, config, handler) { resources.set(uri, { config, handler }); },
    registerPrompt() {},
  };
  return { server, tools, resources };
}

function spies({ runtimeFor, exists, existing = true } = {}) {
  const calls = { runtimes: [], exists: [] };
  return {
    calls,
    deps: {
      resolveVaultRuntime: (vaultId) => {
        calls.runtimes.push(vaultId);
        return typeof runtimeFor === "function" ? runtimeFor(vaultId) : RUNTIME_B;
      },
      vaultExists: async (vaultId) => {
        calls.exists.push(vaultId);
        if (typeof exists === "function") return exists(vaultId);
        return existing;
      },
    },
  };
}

function scoped(name, { config = { inputSchema: { path: z.string() } }, handler } = {}) {
  const { server, tools } = fakeServer();
  const registrar = createVaultScopeRegistrar(server);
  registrar.registerTool(name, config, handler ?? ((args, extra) => requestContext()));
  return { tools, handler: tools.get(name).handler, config: tools.get(name).config };
}

function denyBody(result) {
  assert.equal(result.isError, true);
  assert.equal(typeof result.structuredContent.code, "string");
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  return result.structuredContent;
}

// ---------------------------------------------------------------------------
// 1. Schema injection (contract §7.3, §7.4)
// ---------------------------------------------------------------------------

test("injects the canonical optional vaultId into vault-scoped tools and leaves global tools alone", () => {
  const { server, tools } = fakeServer();
  const registrar = createVaultScopeRegistrar(server);
  registrar.registerTool("list_notes", { inputSchema: { directory: z.string() } }, () => null);
  registrar.registerTool("server_info", { inputSchema: {} }, () => null);
  registrar.registerTool("agent_bootstrap", { inputSchema: { client: z.string().optional() } }, () => null);

  const scoped = tools.get("list_notes").config.inputSchema;
  assert.ok(scoped.vaultId, "list_notes must carry vaultId");
  assert.equal(scoped.directory?.constructor?.name?.includes("Zod"), true, "the original fields survive");
  assert.equal(scoped.vaultId.description, VAULT_ID_INPUT_SPEC.description);
  assert.equal(scoped.vaultId.description, canonicalVaultIdProperty().description);
  // Behaviour-level check of the canonical bounds: optional, 1..80 code points, no local fork.
  assert.equal(scoped.vaultId.safeParse(undefined).success, true, "vaultId must stay optional");
  assert.equal(scoped.vaultId.safeParse("beta").success, true);
  assert.equal(scoped.vaultId.safeParse("").success, false);
  assert.equal(scoped.vaultId.safeParse("x".repeat(VAULT_ID_INPUT_SPEC.maxLength)).success, true);
  assert.equal(scoped.vaultId.safeParse("x".repeat(VAULT_ID_INPUT_SPEC.maxLength + 1)).success, false);
  for (const name of ["server_info", "agent_bootstrap"]) {
    assert.equal("vaultId" in tools.get(name).config.inputSchema, false, `${name} must not carry vaultId`);
  }
});

test("fails closed when a tool module still declares its own vaultId", () => {
  const { server } = fakeServer();
  const registrar = createVaultScopeRegistrar(server);
  assert.throws(
    () => registrar.registerTool("manage_publish", { inputSchema: { path: z.string(), vaultId: z.string().min(1).optional() } }, () => null),
    (error) => error.code === "VAULT_SCOPE_INVALID",
  );
});

// ---------------------------------------------------------------------------
// 2. Defense-in-depth + "deny before I/O" (contract §7-7, §9, §34)
// ---------------------------------------------------------------------------

test("refuses a selected vault outside the credential allowlist before any resolution or I/O", async () => {
  const { calls, deps } = spies();
  let handled = 0;
  const { server, tools } = fakeServer();
  createVaultScopeRegistrar(server, deps).registerTool("list_notes", { inputSchema: {} }, () => { handled += 1; return requestContext(); });
  const extra = { authInfo: { clientId: "c1", allowedVaults: ["beta"] } };

  const denied = await tools.get("list_notes").handler({ vaultId: "gamma" }, extra);
  assert.deepEqual(denyBody(denied), { code: VAULT_SCOPE_DENY_CODES.ACCESS_DENIED, vaultId: "gamma" });
  assert.equal(handled, 0, "the handler must not run");
  assert.deepEqual(calls.runtimes, [], "no runtime resolution on a deny");
  assert.deepEqual(calls.exists, [], "no inventory I/O on a deny");

  // An empty allowlist is a deny, not an implicit grant.
  assert.deepEqual(
    denyBody(await tools.get("list_notes").handler({ vaultId: "beta" }, { authInfo: { clientId: "c1", allowedVaults: [] } })),
    { code: VAULT_SCOPE_DENY_CODES.ACCESS_DENIED, vaultId: "beta" },
  );
  // The allowlisted member is admitted and only then resolved.
  const allowed = await tools.get("list_notes").handler({ vaultId: "beta" }, extra);
  assert.equal(allowed.vaultId, "beta");
  assert.equal(allowed.vaultRuntime, RUNTIME_B);
  assert.deepEqual(calls.runtimes, ["beta"]);
  assert.deepEqual(calls.exists, ["beta"]);
});

test("refuses a malformed vaultId without touching the inventory", async () => {
  const { calls, deps } = spies();
  const { tools, server } = fakeServer();
  createVaultScopeRegistrar(server, deps).registerTool("get_note", { inputSchema: {} }, () => "ran");
  for (const bad of [".", "..", "with/slash", "x".repeat(VAULT_ID_INPUT_SPEC.maxLength + 1), " lead"]) {
    const denied = await tools.get("get_note").handler({ vaultId: bad }, { authInfo: { allowedVaults: [bad] } });
    assert.equal(denyBody(denied).code, VAULT_SCOPE_DENY_CODES.INVALID_ID, bad);
  }
  assert.deepEqual(calls.exists, []);
  assert.deepEqual(calls.runtimes, []);
});

test("an authorized but unknown non-default vault is refused as unavailable", async () => {
  const { deps } = spies({ exists: async (id) => id === "beta" });
  const { server, tools } = fakeServer();
  createVaultScopeRegistrar(server, deps).registerTool("list_notes", { inputSchema: {} }, () => "ran");
  const unknown = await tools.get("list_notes").handler({ vaultId: "ghost" }, { authInfo: { allowedVaults: ["ghost"] } });
  assert.deepEqual(denyBody(unknown), { code: VAULT_SCOPE_DENY_CODES.UNAVAILABLE, vaultId: "ghost" });
  assert.equal(await tools.get("list_notes").handler({ vaultId: "beta" }, { authInfo: { allowedVaults: ["beta"] } }), "ran");
});

test("a broken inventory fails closed and never falls back to primary", async () => {
  const { deps } = spies({ exists: async () => { throw Object.assign(new Error("boom"), { code: "EACCES" }); } });
  const { server, tools } = fakeServer();
  createVaultScopeRegistrar(server, deps).registerTool("list_notes", { inputSchema: {} }, () => "ran");
  const denied = await tools.get("list_notes").handler({ vaultId: "beta" }, { authInfo: { allowedVaults: ["beta"] } });
  assert.equal(denyBody(denied).code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// 3. Context injection (contract §6, A4 patch semantics)
// ---------------------------------------------------------------------------

test("runs the handler inside a patched context that keeps outer fields and adds the selected vault", async () => {
  const { deps } = spies({ exists: async () => true });
  const { server, tools } = fakeServer();
  createVaultScopeRegistrar(server, deps).registerTool("list_notes", { inputSchema: {} }, () => requestContext());

  const inside = await withRequestContext({ author: AUTHOR, authzUsage: { denied: false } }, () => tools.get("list_notes").handler({ vaultId: "beta" }, { authInfo: { allowedVaults: ["beta"] } }));
  assert.equal(inside.vaultId, "beta");
  assert.equal(inside.vaultRuntime, RUNTIME_B);
  assert.deepEqual(inside.author, AUTHOR);
  assert.equal(inside.authzUsage.denied, false, "the outer authz usage object is preserved by reference");

  // No credential allowlist in play (no-auth mode / direct in-process call) => unrestricted.
  const unrestricted = await tools.get("list_notes").handler({ vaultId: "beta" });
  assert.equal(unrestricted.vaultId, "beta");

  // No vaultId argument => the default Vault, and the context must not leak to later calls.
  const fallback = await tools.get("list_notes").handler({}, { authInfo: { allowedVaults: [DEFAULT_VAULT_ID] } });
  assert.equal(fallback.vaultId, DEFAULT_VAULT_ID);
  assert.equal(requestContext(), undefined, "the patch scope ends with the call");
});

test("never substitutes the primary runtime for a secondary vault", async () => {
  const { server, tools } = fakeServer();
  // No injected resolver: the production default must give primary its runtime and secondary none.
  createVaultScopeRegistrar(server, { vaultExists: async () => true }).registerTool("list_notes", { inputSchema: {} }, () => requestContext());
  const primary = await tools.get("list_notes").handler({}, { authInfo: { allowedVaults: [DEFAULT_VAULT_ID] } });
  assert.equal(primary.vaultRuntime?.primary, true);
  assert.equal(primary.vaultRuntime?.id, DEFAULT_VAULT_ID);
  const secondary = await tools.get("list_notes").handler({ vaultId: "beta" }, { authInfo: { allowedVaults: ["beta"] } });
  assert.equal(secondary.vaultId, "beta");
  assert.equal(secondary.vaultRuntime, undefined, "a secondary Vault must never receive the primary runtime");
  assert.equal(Object.hasOwn(secondary, "vaultRuntime"), false, "undefined is skipped, not written");
});

test("the injected primary runtime resolves to the legacy primary roots (behaviour-preserving wiring)", async () => {
  // The registrar now publishes `vaultRuntime` on every scoped call, so the subsystems that read it
  // (`file-transfer.js`, `mutation-idempotency.js`, `batch-journal.js`) must resolve exactly the legacy
  // primary roots for the default Vault — otherwise this wiring would silently move state.
  const [{ primaryRuntime }, config, idempotency] = await Promise.all([
    import("../src/vault.js"),
    import("../src/config.js"),
    import("../src/mutation-idempotency.js"),
  ]);
  assert.equal(primaryRuntime.primary, true);
  assert.equal(primaryRuntime.id, DEFAULT_VAULT_ID);
  assert.equal(primaryRuntime.root, config.VAULT);
  assert.equal(primaryRuntime.paths.trash, config.TRASH_PATH);
  assert.equal(primaryRuntime.paths.history, config.HISTORY_PATH);
  const legacy = idempotency.primaryMutationVaultScope();
  const fromRuntime = idempotency.mutationVaultScopeFromRuntime(primaryRuntime, DEFAULT_VAULT_ID);
  assert.equal(fromRuntime.primary, true);
  assert.equal(fromRuntime.vaultId, legacy.vaultId);
  assert.equal(fromRuntime.key, legacy.key);
  assert.equal(fromRuntime.idempotencyRoot, legacy.idempotencyRoot);
  assert.equal(fromRuntime.journalRoot, path.join(config.DATA_PATH, "mutation-journal"));
});

test("global tools keep their own context untouched", async () => {
  const { server, tools } = fakeServer();
  createVaultScopeRegistrar(server).registerTool("server_info", { inputSchema: {} }, () => requestContext());
  const context = await tools.get("server_info").handler({}, { authInfo: { allowedVaults: ["beta"] } });
  assert.equal(context, undefined, "no vault context is established for a global tool");
});

// ---------------------------------------------------------------------------
// 4. Resources stay primary-only (contract §19, §43-12)
// ---------------------------------------------------------------------------

test("delegates resource registration untouched and never rewrites a resource handler", async () => {
  const { server, resources } = fakeServer();
  const registrar = createVaultScopeRegistrar(server);
  const resourceHandler = async () => requestContext();
  registrar.registerResource("obsidian-vault-index", "obsidian://vault/index", {}, resourceHandler);
  assert.equal(resources.has("obsidian://vault/index"), true);
  // The registrar adds no wrapper: the upstream registrar receives the very same handler.
  assert.equal(resources.get("obsidian://vault/index").handler, resourceHandler);
  // Invoking it inside a patched vault context passes the ambient context through unchanged, so a
  // resource can never select a Vault of its own (contract §19).
  const seen = await withRequestContext({ vaultId: "beta" }, () => resources.get("obsidian://vault/index").handler());
  assert.deepEqual(seen, { vaultId: "beta" });
  assert.equal(requestContext(), undefined);
});

test("the vault layer does not implement registerResource itself", async () => {
  const source = await fs.readFile(new URL("../src/vault-scope-registrar.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /registerResource\s*\(/, "the vault registrar must delegate resources, not wrap them");
  const resources = await fs.readFile(new URL("../src/resources.js", import.meta.url), "utf8");
  assert.doesNotMatch(resources, /request-context/, "resources must not read the ambient Vault selection (§19)");
});
