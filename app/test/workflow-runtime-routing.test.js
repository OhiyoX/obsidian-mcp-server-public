// Wave D / D-workflows — freeze the per-request runtime seam this lane added
// (`src/workflow-runtimes.js`) plus the capability-wiring consistency it must not over-claim.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §3.4  a capability is a RUNTIME FACT — flip only the keys a lane actually wired, report every
//         other key `{available:false, reason}`, never guess;
//   §10.1 the request-scoped runtime seam · §11 the per-Vault VaultIndex instance ·
//   §21 MV-I07 primary compatibility · §43-5 facade allowlist · §47 no secondary → primary fallback.
//
// This suite is the negative-control target for "capability over-claims an unwired key": adding
// `webCatalog` (or any other unwired key) to `WIRED_CAPABILITY_KEYS` turns the first test red.
//
// SCOPE OF THE §29/§43-5 RUNTIME PIN — it is a LINT, not a guarantee. Everything this file asserts
// about *where* the runtime is resolved is a reading of the module's TEXT: occurrence counts,
// module-scope regexes, handler-body slicing. Text cannot see intent, so a handler that keeps
// `resolveWorkflowRuntime()` inside its own body but CACHES the result in a module-scope binding
// (`let cached = null; ... cached ??= resolveWorkflowRuntime()`) serves the FIRST request's Vault to
// every later request while every assertion below stays green (review r3, NC5 — observed green here
// while `create_base_entry` fed one Vault's runtime into another Vault's request). That class is not
// closed by matching more shapes: the next refactor (a helper's return value, a `Map` keyed by
// vaultId, `globalThis`) re-opens it identically.
//
// The GUARANTEE is carried by behaviour, not by this file. It lives in section 8 of
// `test/multi-vault-workflows-matrix.test.js`:
//   * "§10.1/§29: create_base_entry (#630) writes into the CURRENT request's Vault, never the first one's"
//   * "§21 MV-I07: create_base_entry without vaultId stays on the primary Vault and never the secondary"
//   * "§47: create_base_entry is refused structurally for an unmaterialized, unknown or unguarded Vault selection"
//   * "§10.1/§29: create_base_entry re-reads the runtime after a Vault is re-materialized (no module-scope cache survives)"
// Those drive the real tool twice inside one process (in two Vaults, and in one Vault across a runtime
// re-materialization) and assert the on-disk result, the `.base` the defaults came from and the
// per-Vault index identity. The NC5 shape turns the first two red (review r3); the NC6 shape (`Map`
// keyed by vaultId, review r4 item 1) is turned red ONLY by the re-materialization case — text cannot
// see it, which is why the guarantee is a behaviour assertion and this file is only a lint.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dworkflows-routing-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";
for (const dir of [PRIMARY_ROOT, SECONDARY_ROOT, DATA_ROOT]) await fs.mkdir(dir, { recursive: true });

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const { primaryRuntime } = await import("../src/vault.js");
const { primaryIndexRuntime } = await import("../src/vault-index.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { CAPABILITY_KEYS } = await import("../src/vault-runtime/descriptor.js");
const { WIRED_CAPABILITY_KEYS, wiredCapabilities } = await import("../src/vault-runtime/capabilities.js");
const { searchRuntimeFor } = await import("../src/search-runtimes.js");
const { VAULT_UNAVAILABLE, refusalForError, resolveWorkflowRuntime } = await import("../src/workflow-runtimes.js");
const { withRequestContext } = await import("../src/request-context.js");
const { TOOLSET_TOOLS } = await import("../src/capability-catalog.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { VAULT_SCOPED_TOOLS } = await import("../src/vault-scope.js");

const AUTHOR = Object.freeze({ agent: "mv-dworkflows-routing", model: "test" });
const APP_DIR = new URL("..", import.meta.url);

const newMap = async () => {
  const map = createVaultRuntimeMap({
    registry: createVaultRegistry({ primaryRoot: PRIMARY_ROOT, primaryId: DEFAULT_VAULT_ID, vaultsRoot: VAULTS_ROOT, writable: true }),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor: () => AUTHOR },
  });
  await map.refresh();
  return map;
};
const inVault = (vaultId, vaultRuntime, task) => withRequestContext({ author: AUTHOR, vaultId, vaultRuntime }, task);

// ---------------------------------------------------------------------------------------
// 1. §3.4 — the capability graph still claims exactly what Wave D has wired (no over-claim)
// ---------------------------------------------------------------------------------------

// The canonical tools this lane routes per Vault, and the capability keys their resources belong
// to. Declared here (not in production) so the assertion ties the reported graph to the real tool
// registry instead of mirroring a constant.
const WORKFLOWS_TOOLS = Object.freeze(TOOLSET_TOOLS.workflows);
const REQUIRED_CAPABILITY_KEYS = Object.freeze(["notes", "files"]);

test("§3.4: the wired set is exactly the Wave D lanes' claim and every unwired key stays fail closed", () => {
  // D-files wired notes/files/history/trash, D-git wired git, D-intelligence wired memory/skills,
  // D-plans wired plans. D-workflows itself consumes `vaultRuntime.localFs` (`files`/`notes`) and
  // D-search's per-Vault index — it wires no capability key of its own (the dispatch guess
  // `webCatalog` would be an over-claim: no Web-catalog runtime is involved in the MCP Base path —
  // see the lane HANDOFF). The expected set is the exact Wave D claim and is EXTENDED (never
  // loosened) whenever a later lane wires a key — same-commit drift declaration; see
  // `src/vault-runtime/capabilities.js`.
  // D-publish wired publish (tools/publish.js + src/publish/service.js read/write the selected
  // Vault's own records through the canonical Web registry; see that lane's matrix and
  // `src/vault-runtime/capabilities.js`).
  // D-workflows itself consumes `vaultRuntime.localFs` (`files`/`notes`) and D-search's per-Vault
  // index — it wires no capability key of its own (the dispatch guess `webCatalog` would be an
  // over-claim: no Web-catalog runtime is involved in the MCP Base path — see the lane HANDOFF).
  // Wave F / F1 (§31) then converged the last map-level key: `retrieval` is available because B2's
  // VaultIndex + B3's retrieval runtime are materialized per Vault (D-search, one instance pair per
  // runtime) and every index/retrieval tool is routed. The expected set is the exact Wave D + F1
  // claim and is EXTENDED (never loosened) whenever a later lane wires a key — same-commit drift
  // declaration; see `src/vault-runtime/capabilities.js`.
  assert.deepEqual(
    [...WIRED_CAPABILITY_KEYS].sort(),
    ["files", "git", "history", "memory", "notes", "plans", "publish", "retrieval", "skills", "trash"],
    "the wired set must be exactly the Wave D + F1 claim — any extra key here would be an over-claim (§3.4)",
  );
  for (const key of REQUIRED_CAPABILITY_KEYS) {
    assert.ok(WIRED_CAPABILITY_KEYS.includes(key), `${key} is required by the workflows/Bases face and must be wired`);
  }
  const graph = wiredCapabilities();
  assert.deepEqual([...WIRED_CAPABILITY_KEYS].sort(), Object.keys(graph).filter((key) => graph[key].available === true).sort());
  for (const key of CAPABILITY_KEYS) {
    if (WIRED_CAPABILITY_KEYS.includes(key)) {
      assert.deepEqual(graph[key], { available: true }, `${key} is wired and must be reported available`);
    } else {
      assert.equal(graph[key].available, false, `${key} is not wired by any Wave D lane and must stay fail closed (§3.4)`);
      assert.ok(graph[key].reason.length > 0, `${key} must carry a visible reason`);
    }
  }
  for (const name of WORKFLOWS_TOOLS) {
    assert.ok(TOOL_NAMES.includes(name), `${name} must be a canonical tool`);
    assert.ok(VAULT_SCOPED_TOOLS.includes(name), `${name} must be classified vault-scoped`);
  }
});

// ---------------------------------------------------------------------------------------
// 2. §43-5/§29 — the tool module consumes this lane's seam and no primary facade
// ---------------------------------------------------------------------------------------

test("§29/§43-5: src/tools/workflows.js resolves its Vault through the lane seam only", async () => {
  const source = await fs.readFile(new URL("src/tools/workflows.js", APP_DIR), "utf8");
  assert.ok(source.includes("workflow-runtimes.js"), "the tool module must consume the lane resolver");
  assert.ok(source.includes("vault-runtime/request-vault.js"), "the tool module must consume the request runtime");
  for (const facade of [/from "\.\.\/vault\.js"/, /from "\.\.\/vault-index\.js"/, /(?<![.\w$])getVaultIndex\s*\(/, /(?<![.\w$])invalidateVaultIndex\s*\(/]) {
    assert.doesNotMatch(source, facade, "the tool module must not use a primary-bound facade");
  }
  for (const canonical of ["list_bases", "get_base", "write_base", "query_base"]) {
    assert.ok(source.includes(`"${canonical}"`), `${canonical} must stay registered by this module`);
  }
  // every registered tool of the module resolves the runtime before touching Vault state.
  // `create_base_entry` (#630) keeps its handler in `base-create-face.js` so workflows.js stays under the
  // architecture line budget; the resolution therefore lives in that face. The invariant is not weakened
  // to "15 of 16": the face must resolve exactly once per registered handler too, and it must be the ONLY
  // extra resolver, so a handler that forgets to resolve still fails here.
  const registrations = source.match(/server\.registerTool\(/g)?.length ?? 0;
  const resolutions = source.match(/resolveWorkflowRuntime\(\)/g)?.length ?? 0;
  const faceSource = await fs.readFile(new URL("src/base-create-face.js", APP_DIR), "utf8");
  const faceResolutions = faceSource.match(/resolveWorkflowRuntime\(\)/g)?.length ?? 0;
  // Counting is not enough: hoisting the resolution to module scope keeps the count at one while the
  // handler stops reading the CURRENT request's runtime (review r2 B3 / NC2 - that shape passed 71+66
  // routing and multi-vault tests silently). So the resolution must sit INSIDE the delegated handler
  // body, and the face must not resolve anything at module scope.
  //
  // Still a LINT, never the guarantee: this is a reading of the source text, so it cannot see a
  // handler that resolves in-body and then caches the value on a module-scope binding (review r3,
  // NC5 - that shape passes every assertion here). The guarantee for this behaviour is the dynamic
  // dual-Vault pair in `test/multi-vault-workflows-matrix.test.js` section 8 (§10.1/§29
  // "create_base_entry (#630) writes into the CURRENT request's Vault, never the first one's").
  const faceHandlerStart = faceSource.indexOf("export async function createBaseEntryHandler(");
  assert.ok(faceHandlerStart > 0, "create_base_entry's handler must be a named export in its face module");
  const faceHandlerEnd = faceSource.indexOf("\nexport ", faceHandlerStart + 1);
  const faceHandlerBody = faceSource.slice(faceHandlerStart, faceHandlerEnd === -1 ? undefined : faceHandlerEnd);
  const faceHandlerResolutions = faceHandlerBody.match(/resolveWorkflowRuntime\(\)/g)?.length ?? 0;
  assert.equal(faceHandlerResolutions, 1,
    "the delegated handler must resolve the runtime inside its own body (module-scope hoisting must fail here)");
  assert.doesNotMatch(faceSource, /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*resolveWorkflowRuntime\(\)/m,
    "the face must not resolve the runtime at module scope");
  const delegatedHandlers = source.match(/server\.registerTool\(\s*"create_base_entry"[\s\S]{0,40}?createBaseEntryHandler\s*\)/g)?.length ?? 0;
  const faceImports = source.match(/^import \{[^}]*\} from "\.\.\/base-create-face\.js";$/gm)?.length ?? 0;
  assert.equal(resolutions + faceResolutions, registrations,
    "every handler resolves its runtime exactly once (workflows.js + the create_base_entry face)");
  assert.equal(delegatedHandlers, 1, "exactly one handler is delegated to create_base_entry's face module");
  assert.equal(faceImports, 1, "the face module is imported exactly once");
  assert.equal(faceResolutions, 1, "the delegated face resolves the runtime exactly once");
});

test("§43-5/SEC-MV07: src/workflow-runtimes.js holds no ambient state and reads no config", async () => {
  const source = await fs.readFile(new URL("src/workflow-runtimes.js", APP_DIR), "utf8");
  assert.doesNotMatch(source, /process\.env/, "the seam must not read the environment");
  assert.doesNotMatch(source, /from "\.\/config\.js"/, "the seam must not read global path constants");
  assert.doesNotMatch(source, /^(?:let|var) /m, "the seam must hold no module-level mutable state");
  assert.doesNotMatch(source, /new (?:Map|Set|WeakMap|WeakSet)\(/, "the seam must not cache runtimes itself");
});

// ---------------------------------------------------------------------------------------
// 3. §10.1/§21 MV-I07 — resolution identity: primary reuses the process instances
// ---------------------------------------------------------------------------------------

test("§21 MV-I07: no Vault selection resolves to the process's primary runtime and index", async () => {
  const noContext = resolveWorkflowRuntime();
  assert.ok(Object.isFrozen(noContext), "the resolved bundle must be frozen");
  assert.equal(noContext.vaultRuntime, primaryRuntime);
  assert.equal(noContext.vaultId, DEFAULT_VAULT_ID);
  assert.equal(noContext.localFs, primaryRuntime.localFs);
  assert.equal(noContext.index, primaryIndexRuntime, "the primary keeps the process's single index instance");
  const explicit = await inVault(DEFAULT_VAULT_ID, primaryRuntime, async () => resolveWorkflowRuntime());
  assert.deepEqual([explicit.vaultRuntime, explicit.localFs, explicit.index], [primaryRuntime, primaryRuntime.localFs, primaryIndexRuntime]);
});

// ---------------------------------------------------------------------------------------
// 4. §11 — one index instance per materialized Vault, never a second cache
// ---------------------------------------------------------------------------------------

test("§11: a secondary resolves to its own index instance, reused across calls", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  assert.ok(secondaryRuntime, "the registry must materialize the secondary");
  const resolved = await inVault(SECONDARY, secondaryRuntime, async () => resolveWorkflowRuntime());
  assert.equal(resolved.localFs, secondaryRuntime.localFs);
  assert.equal(resolved.index, searchRuntimeFor(secondaryRuntime).index, "the face must reuse D-search's per-Vault index");
  assert.notEqual(resolved.index, primaryIndexRuntime, "SEC-MV06: a secondary never gets the primary index");
  const again = await inVault(SECONDARY, secondaryRuntime, async () => resolveWorkflowRuntime());
  assert.equal(again.index, resolved.index, "at most one index instance per materialized Vault");
});

// ---------------------------------------------------------------------------------------
// 5. §47 — a selection without a runtime is refused structurally, never served
// ---------------------------------------------------------------------------------------

test("§47: a Vault selection without a runtime is refused instead of falling back to primary", async () => {
  const cases = [
    { label: "no runtime in the context", context: { author: AUTHOR, vaultId: SECONDARY } },
    { label: "malformed runtime", context: { author: AUTHOR, vaultId: SECONDARY, vaultRuntime: {} } },
  ];
  for (const { label, context } of cases) {
    const error = await inVault(context.vaultId, context.vaultRuntime, async () => {
      try {
        resolveWorkflowRuntime();
        return null;
      } catch (thrown) {
        return thrown;
      }
    });
    assert.equal(error?.code, VAULT_UNAVAILABLE, `${label}: must fail closed with the stable code`);
    assert.equal(error?.vaultId, SECONDARY, `${label}: the refusal carries the requested Vault only`);
    const refusal = refusalForError(error);
    assert.deepEqual(refusal.structuredContent, { code: VAULT_UNAVAILABLE, vaultId: SECONDARY });
    assert.equal(refusal.isError, true);
  }
  assert.equal(refusalForError(new Error("unrelated")), null, "unrelated errors keep the generic error path");
  // D-search's own resolver code is delegated, so the face reports one vocabulary for both seams
  const delegated = refusalForError(Object.assign(new Error("x"), { code: "vault_retrieval_unavailable", vaultId: SECONDARY }));
  assert.equal(delegated?.structuredContent.code, "vault_retrieval_unavailable");
});
