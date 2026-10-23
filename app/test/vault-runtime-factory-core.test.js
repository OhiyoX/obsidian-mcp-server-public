// B1 — VaultRuntime factory + compatibility-facade tests (contract §5, §5.3, §43-5, §26;
// brief §2.2, §2.3).
//
// Two jobs:
//   1. pin the *literal* runtime seam (field names, pass-through identity, fail-closed
//      capabilities, frozen instances) that lanes B2 / B3 / B4 / B6 / C dock to;
//   2. prove the `src/vault.js` facade kept every legacy export with its old signature, and
//      that neither new module holds ambient state (ALS / module-global / global roots).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_VAULT_ID } from "../src/oauth/primitives.js";
import { HISTORY_PATH, RETRIEVAL_INDEX_PATH, TRASH_PATH, VAULT, DATA_PATH } from "../src/config.js";
import * as facade from "../src/vault.js";
import { CAPABILITY_KEYS, createVaultDescriptor, unavailable } from "../src/vault-runtime/descriptor.js";
import { vaultDataPaths } from "../src/vault-runtime/paths.js";
import { createVaultRuntime, defaultRuntimeCapabilities, normalizeRuntimeCapabilities } from "../src/vault-runtime/runtime.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (relative) => fs.readFile(path.join(SRC, relative), "utf8");

// The pre-facade export surface (BASE 9fdfa5c `app/src/vault.js`), name → function.length.
// Verified against a live import of the BASE file when this lane was built; it is a
// signature ratchet: a renamed export, a changed default parameter or a wrapper that
// changes arity fails here.
const LEGACY_EXPORTS = Object.freeze({
  assertWritable: 0, normalizeVaultInput: 0, hasExtension: 1, hasNumericExtension: 1,
  fileExtension: 1, isAcceptedObsidianFile: 1, isTextFile: 1, assertInsideVault: 1,
  assertCanonicalInsideRoot: 2, assertCanonicalInsideVault: 1, openCanonicalVaultFile: 1,
  assertNotVaultRoot: 1, resolveVaultPath: 0, resolveCanvasPath: 1, toVaultPath: 1,
  stripMarkdownExtension: 1, normalizeNotePath: 1, decodeLinkTarget: 1, exists: 1,
  ensureParent: 1, resolveTrashPath: 0, toTrashPath: 1, ensureVaultParent: 1, fileRevision: 1,
  assertRevision: 2, withMutationLock: 1, atomicWriteFile: 2, createVersionSnapshot: 1,
  listFileVersions: 1, readFileVersion: 1, restoreFileVersion: 1, readLimitedText: 1, walk: 1,
  allMarkdownFiles: 0, backupBeforeDelete: 1, listTrashEntries: 0, readTrashEntry: 1,
  restoreTrashEntry: 1, deleteTrashEntry: 1, deleteFileVersion: 1, getVaultHealth: 0,
});
// Additive surface of this lane: the primary compatibility runtime handle.
const ADDITIVE_EXPORTS = Object.freeze(["primaryRuntime"]);

async function scratchVault() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b1-runtime-"));
  const root = path.join(base, "vault");
  await fs.mkdir(root, { recursive: true });
  return { base, root, data: path.join(base, "data") };
}
const DEP_NOOP_AUTHOR = { requireRequestAuthor: () => {}, trackGitMutation: () => {} };

async function descriptorFor(root, { id = "vault", primary = true, capabilities } = {}) {
  return createVaultDescriptor({
    id, root, primary, writable: true,
    capabilities: capabilities ?? Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, unavailable("test fixture")])),
  });
}

// ---------------------------------------------------------------------------
// §2.3 facade compatibility
// ---------------------------------------------------------------------------

test("facade export snapshot: every legacy name survives with its original arity", () => {
  assert.deepEqual(Object.keys(facade).sort(), [...Object.keys(LEGACY_EXPORTS), ...ADDITIVE_EXPORTS].sort());
  for (const [name, arity] of Object.entries(LEGACY_EXPORTS)) {
    assert.equal(typeof facade[name], "function", `${name} must still be exported as a function`);
    assert.equal(facade[name].length, arity, `${name} signature changed (expected ${arity} declared parameters)`);
  }
  assert.equal(typeof facade.primaryRuntime, "object");
});

test("facade delegates to the primary runtime and keeps the legacy primary data paths (§5.1)", async () => {
  const runtime = facade.primaryRuntime;
  assert.equal(runtime.id, DEFAULT_VAULT_ID, "the primary runtime id must equal the auth plane's DEFAULT_VAULT_ID");
  assert.equal(runtime.root, VAULT);
  assert.equal(runtime.primary, true);
  assert.equal(runtime.localFs.root, path.resolve(VAULT));
  assert.equal(runtime.localFs.trashRoot, path.resolve(TRASH_PATH));
  assert.equal(runtime.localFs.historyRoot, path.resolve(HISTORY_PATH));
  assert.equal(runtime.paths, runtime.localFs.dataPaths, "paths is the A7 mapping, passed by identity");

  const expected = vaultDataPaths({
    primary: true, history: HISTORY_PATH, trash: TRASH_PATH, retrievalIndex: RETRIEVAL_INDEX_PATH,
    transfersUploads: path.join(DATA_PATH, "transfers", "uploads"),
    mutationJournal: path.join(DATA_PATH, "mutation-journal"),
    mutationIdempotency: path.join(DATA_PATH, "mutation-idempotency"),
  });
  assert.deepEqual(runtime.paths, expected, "primary keeps today's legacy history/trash/data paths");
  // Delegation is literal, not a wrapper: the exported function IS the instance method.
  assert.equal(facade.resolveVaultPath, runtime.localFs.resolveVaultPath);
  assert.equal(facade.withMutationLock, runtime.localFs.withMutationLock);
  assert.equal(facade.atomicWriteFile, runtime.localFs.atomicWriteFile);
  assert.equal(facade.getVaultHealth, runtime.localFs.getVaultHealth);
});

// --- pre-facade health payload: two frozen shapes (RETURN-2) --------------------------------
// `local-fs.js getVaultHealth()` *creates* `root`/`dataRoot` and then probes them for
// readability/writability, so its payload has always been two-state, and which state a given
// instance reports follows the host's permissions for the paths bound into that instance:
//   * OK    — `mkdir` + `access(R_OK/W_OK)` all succeeded (9 keys, success branch, local-fs.js:473-485);
//   * error — one of those syscalls threw (6 keys: drops the history/version/read-budget facts
//             and adds `error`).
// Only the OK branch is deterministically reachable, and only for a root the test owns; that is
// what the temp-root case below pins. The facade binds the real `config.js` roots (`VAULT`,
// `DATA_PATH`), so on a host where those cannot be created/accessed (Linux CI as a non-root user:
// `/vault`, `/data`) the error branch is the correct pre-facade answer — see RETURN-2.md.
const HEALTH_OK_KEYS = Object.freeze(["ok", "vaultPath", "dataPath", "trashPath", "historyPath", "versionHistoryEnabled", "maxVersionsPerFile", "readOnly", "maxReadBytes"]);
const HEALTH_ERROR_KEYS = Object.freeze(["ok", "vaultPath", "dataPath", "trashPath", "readOnly", "error"]);
// Keys a multi-vault health payload would grow; none of them may ever appear (contract §5.1).
const MULTI_VAULT_KEYS = Object.freeze(["vaults", "vaultIds", "vaultRegistry", "multiVault", "vaultScope", "allowedVaults"]);
const sameKeys = (keys, shape) => keys.length === shape.length && keys.every((key, index) => key === shape[index]);

// Deterministic shape contract: a temp-root localFs instance (root + dataRoot under `os.tmpdir()`,
// both already created) must take the OK branch and expose exactly the 9 pre-facade keys, in order.
// This is the case that pins the shape; the facade case below only rules out *new* keys.
test("health of a temp-root localFs instance is exactly the 9-key pre-facade OK shape", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b1-health-"));
  const root = path.join(base, "vault");
  const data = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  const runtime = createVaultRuntime({
    descriptor: { id: "vault", root, primary: false },
    paths: { root: data, history: path.join(data, "history"), trash: path.join(data, "trash") },
    dataRoot: data,
    deps: DEP_NOOP_AUTHOR,
  });
  const health = await runtime.localFs.getVaultHealth();
  assert.equal(health.ok, true, "a writable temp root must take the OK branch (this case is not allowed to be host-dependent)");
  assert.deepEqual(Object.keys(health), HEALTH_OK_KEYS);
  assert.deepEqual([health.vaultPath, health.dataPath, health.trashPath], [path.resolve(root), path.resolve(data), path.join(path.resolve(data), "trash")]);
  for (const key of MULTI_VAULT_KEYS) assert.equal(key in health, false, `health must not expose ${key}`);
});

test("facade health payload keeps the pre-facade scalar shape (no multi-vault keys)", async () => {
  // Two-state by design: the shape follows whether the host lets `getVaultHealth()` create + probe
  // the config roots (see the frozen shapes above). Both are pre-facade shapes, so accepting either
  // loses no coverage; the single-state assertion is the temp-root case. Anything outside these two
  // shapes — notably any new multi-vault key — still fails here.
  const health = await facade.getVaultHealth();
  const keys = Object.keys(health);
  assert.ok(sameKeys(keys, HEALTH_OK_KEYS) || sameKeys(keys, HEALTH_ERROR_KEYS), `facade health must be the pre-facade OK or error shape, got ${JSON.stringify(keys)}`);
  assert.equal(health.ok, sameKeys(keys, HEALTH_OK_KEYS), "`ok` must agree with the shape the host produced");
  for (const key of MULTI_VAULT_KEYS) {
    assert.equal(key in health, false, `health must not expose ${key}`);
  }
});

// ---------------------------------------------------------------------------
// §5 runtime seam
// ---------------------------------------------------------------------------

test("runtime exposes exactly the frozen seam and passes A7 paths through by identity", async () => {
  const { root, data } = await scratchVault();
  const descriptor = await descriptorFor(root);
  const paths = vaultDataPaths({
    primary: true, history: path.join(data, "history"), trash: path.join(data, "trash"),
    retrievalIndex: path.join(data, "index", "retrieval-index.json"),
    transfersUploads: path.join(data, "transfers", "uploads"),
    mutationJournal: path.join(data, "mutation-journal"),
    mutationIdempotency: path.join(data, "mutation-idempotency"),
  });
  const runtime = createVaultRuntime({ descriptor, paths, dataRoot: data, deps: DEP_NOOP_AUTHOR });

  assert.deepEqual(Object.keys(runtime).sort(), ["capabilities", "descriptor", "id", "localFs", "paths", "primary", "root"]);
  assert.equal(runtime.id, descriptor.id);
  assert.equal(runtime.root, root);
  assert.equal(runtime.primary, true);
  assert.equal(runtime.paths, paths, "the A7 mapping must be passed through, not re-derived");
  assert.equal(runtime.localFs.root, path.resolve(root));
  assert.equal(runtime.localFs.dataRoot, path.resolve(data));
  assert.equal(runtime.descriptor.id, descriptor.id);
  assert.equal(runtime.descriptor.dataKey, descriptor.dataKey);
  assert.deepEqual(runtime.capabilities, descriptor.capabilities);
  assert.notEqual(runtime.descriptor, descriptor, "the runtime must not hand out the caller's descriptor object");

  for (const value of [runtime, runtime.descriptor, runtime.capabilities, runtime.localFs]) {
    assert.ok(Object.isFrozen(value), "the runtime seam and its members must be frozen");
  }
});

test("runtime capabilities fail closed: missing map → every capability unavailable + reason", async () => {
  const { root, data } = await scratchVault();
  const descriptor = await createVaultDescriptor({ id: "vault", root, primary: true, writable: true, capabilities: defaultRuntimeCapabilities() });
  const plain = { id: descriptor.id, root, primary: true }; // no capabilities carried at all
  const fallback = createVaultRuntime({ descriptor: plain, paths: { history: path.join(data, "h"), trash: path.join(data, "t") }, deps: DEP_NOOP_AUTHOR });
  assert.deepEqual(Object.keys(fallback.capabilities).sort(), [...CAPABILITY_KEYS].sort());
  for (const key of CAPABILITY_KEYS) {
    assert.equal(fallback.capabilities[key].available, false, `${key} must default to unavailable`);
    assert.ok(fallback.capabilities[key].reason.length > 0, `${key} must carry a visible reason`);
  }
  // A descriptor that DOES carry capabilities is honoured; an injected map wins.
  const fromDescriptor = createVaultRuntime({ descriptor, paths: { history: path.join(data, "h"), trash: path.join(data, "t") }, deps: DEP_NOOP_AUTHOR });
  assert.deepEqual(fromDescriptor.capabilities, descriptor.capabilities);
  const injected = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { available: true }]));
  const explicit = createVaultRuntime({ descriptor: plain, paths: { history: path.join(data, "h"), trash: path.join(data, "t") }, capabilities: injected, deps: DEP_NOOP_AUTHOR });
  assert.equal(explicit.capabilities.notes.available, true);
});

test("runtime capabilities and inputs are rejected, never silently coerced", async () => {
  const { root, data } = await scratchVault();
  const paths = { history: path.join(data, "h"), trash: path.join(data, "t") };
  const descriptor = { id: "vault", root, primary: true };
  const cases = [
    [{ descriptor, paths, capabilities: { notes: { available: true } } }, /missing:/],
    [{ descriptor, paths, capabilities: Object.fromEntries([...CAPABILITY_KEYS.map((k) => [k, { available: true }]), ["nope", { available: true }]]) }, /unknown capability keys: nope/],
    [{ descriptor, paths, capabilities: Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, k === "notes" ? { available: false } : { available: true }])) }, /must use exactly \{available, reason\}/],
    // A blank reason is rejected by A1's `unavailable()` — single-sourced, still fail-closed.
    [{ descriptor, paths, capabilities: Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, k === "notes" ? { available: false, reason: "   " } : { available: true }])) }, /non-empty reason/],
    [{ descriptor: { ...descriptor, root: "relative/vault" }, paths }, /root must be an absolute path/],
    [{ descriptor: { id: "vault", root, primary: "yes" }, paths }, /descriptor\.primary must be passed explicitly as a boolean/],
    [{ descriptor: { id: "", root, primary: true }, paths }, /descriptor\.id must be a non-empty string/],
    [{ descriptor, paths: null }, /paths must be the A7 vaultDataPaths result/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => createVaultRuntime({ ...input, deps: DEP_NOOP_AUTHOR }), expected, JSON.stringify(input).slice(0, 90));
  }
  assert.throws(() => normalizeRuntimeCapabilities(null), /capabilities must be an object/);
  const empty = defaultRuntimeCapabilities("because lane B1 wires nothing");
  assert.equal(empty.git.reason, "because lane B1 wires nothing");
  assert.ok(Object.isFrozen(empty));
});

test("two runtimes are independent objects (no shared module state) and creation is synchronous", async () => {
  const a = await scratchVault();
  const b = await scratchVault();
  const runtimeA = createVaultRuntime({ descriptor: { id: "A", root: a.root, primary: false }, paths: { root: a.data, history: path.join(a.data, "history"), trash: path.join(a.data, "trash") }, deps: DEP_NOOP_AUTHOR });
  const runtimeB = createVaultRuntime({ descriptor: { id: "B", root: b.root, primary: false }, paths: { root: b.data, history: path.join(b.data, "history"), trash: path.join(b.data, "trash") }, deps: DEP_NOOP_AUTHOR });
  assert.ok(!(runtimeA instanceof Promise), "createVaultRuntime must not perform I/O");
  assert.equal(runtimeA.localFs.dataRoot, path.resolve(a.data), "secondary dataRoot defaults to the A7 per-vault root");
  assert.notEqual(runtimeA.localFs, runtimeB.localFs);
  assert.notEqual(runtimeA.localFs.withMutationLock, runtimeB.localFs.withMutationLock);
  assert.equal(runtimeA.localFs.withMutationLock, runtimeA.localFs.withMutationLock, "the lock is per instance, stably bound");
});

// ---------------------------------------------------------------------------
// §5.3 / §43-5 source constraints for the new modules
// ---------------------------------------------------------------------------

const FORBIDDEN_GLOBALS = ["VAULT", "DATA_PATH", "TRASH_PATH", "HISTORY_PATH", "RETRIEVAL_INDEX_PATH", "MEMORY_PATH", "SKILLS_PATH"];

function importStatements(text) {
  return [...text.matchAll(/import\s+(?:([^"';]*?)\s+from\s+)?"([^"]+)";/g)].map((match) => ({
    clause: (match[1] ?? "").trim(),
    specifier: match[2],
    bindings: match[1] === undefined ? [] : [...match[1].matchAll(/(?:\{([^}]*)\}|([\w$]+))/g)].flatMap((piece) =>
      piece[1] !== undefined ? piece[1].split(",").map((name) => name.trim()).filter(Boolean) : [piece[2]]),
  }));
}
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
function violations(rawText) {
  const text = stripComments(rawText);
  const found = [];
  if (/AsyncLocalStorage/.test(text)) found.push("AsyncLocalStorage");
  if (/request-context/.test(text)) found.push("request-context");
  if (/process\.env/.test(text)) found.push("process.env");
  if (/\brequire\s*\(/.test(text)) found.push("require(");
  if (/^(?:let|var)\s/m.test(text)) found.push("module-level let/var");
  if (/^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set)\s*\(/m.test(text)) found.push("module-level collection");
  return found;
}

test("scanner self-proof: the ambient-state oracle is not vacuous", () => {
  const bad = [
    'import { VAULT } from "../config.js";',
    "const viewStore = new AsyncLocalStorage();",
    "let mutationTail = Promise.resolve();",
    'const root = process.env.VAULT_PATH;',
  ].join("\n");
  assert.ok(violations(bad).includes("AsyncLocalStorage"));
  assert.ok(violations(bad).includes("module-level let/var"));
  assert.ok(violations(bad).includes("process.env"));
  assert.deepEqual(violations(bad + '\nconst cache = new Map();'), ["AsyncLocalStorage", "process.env", "module-level let/var", "module-level collection"]);
  // Comments must not trip the oracle, but real code inside a function must not either.
  assert.deepEqual(violations('// process.env.X and AsyncLocalStorage are forbidden here\nimport path from "node:path";\nfunction createLocalFs() {\n  let tail = Promise.resolve();\n  const seen = new Map();\n}\n'), []);
  const parsed = importStatements(bad).find((entry) => entry.specifier === "../config.js");
  assert.deepEqual(parsed.bindings, ["VAULT"]);
});

test("new runtime modules hold no ambient state and cannot reach the global roots (§5.3/§43-5)", async () => {
  const localFsSource = await source("vault-runtime/local-fs.js");
  const runtimeSource = await source("vault-runtime/runtime.js");
  for (const [name, text] of [["local-fs.js", localFsSource], ["runtime.js", runtimeSource]]) {
    assert.deepEqual(violations(text), [], `${name} must not use ALS, env, require or module-level mutable state`);
    for (const forbidden of FORBIDDEN_GLOBALS) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(stripComments(text)), `${name} must not reference ${forbidden}`);
    }
  }
  const localImports = importStatements(localFsSource);
  assert.deepEqual(localImports.map((entry) => entry.specifier).sort(), ["../config.js", "node:crypto", "node:fs", "node:fs/promises", "node:path"]);
  const configBindings = localImports.find((entry) => entry.specifier === "../config.js").bindings.sort();
  assert.deepEqual(configBindings, ["EXCLUDED_DIRS", "MAX_LIST_ENTRIES", "MAX_READ_BYTES", "MAX_VERSIONS_PER_FILE", "OBSIDIAN_ACCEPTED_EXTENSIONS", "READ_ONLY", "TEXT_FILE_EXTENSIONS", "VERSION_HISTORY_ENABLED"]);
  const runtimeImports = importStatements(runtimeSource);
  assert.deepEqual(runtimeImports.map((entry) => entry.specifier).sort(), ["./descriptor.js", "./local-fs.js", "node:path"]);
  // The mutation lock is closure-local: it only ever appears indented inside the factory.
  assert.match(localFsSource, /\n  let mutationTail = Promise\.resolve\(\);/, "the lock must be declared inside createLocalFs");
  assert.ok(!/^let mutationTail/m.test(localFsSource), "the lock must not be module-level");
});
