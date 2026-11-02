import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_PATH } from "./config.js";
import { requestContext } from "./request-context.js";
import { validateVaultId, vaultDataKey } from "./vault-runtime/descriptor.js";

const root = path.join(DATA_PATH, "mutation-idempotency");
let lastPrunedAt = 0;

// ---------------------------------------------------------------------------
// §13 cross-call handle binding — Vault scope (shared by plans / journal / idempotency)
//
// The mutation runtime is the last durable cross-call gate, so it must never
// interpret a handle against "whatever Vault is ambient". The scope is resolved
// from the explicit request context (contract §6 / §13.2 / §13.3):
//   * an injected `vaultRuntime` (the B1/A7 seam) is authoritative and keeps the
//     primary Vault on the legacy paths (§5.1) while secondaries use `paths`;
//   * otherwise an explicit `vaultId` selects a per-Vault namespace;
//   * no `vaultId` at all is the legacy primary namespace (§22.4), never a
//     secondary and never a guess.
// This module owns the scope primitive because plans / journal / idempotency all
// import it here already (no new shared file, no ratchet movement).
// ---------------------------------------------------------------------------

/** Stable error code for a cross-vault handle mismatch (§13.1/§13.2, §36). */
export const VAULT_CONTEXT_MISMATCH = "VAULT_CONTEXT_MISMATCH";

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : `${typeof value} ${String(value)}`;
}

/** Fail-closed cross-vault error; callers match on `error.code`, never prose. */
export function vaultContextMismatch(expected, actual) {
  return Object.assign(new Error(
    `[${VAULT_CONTEXT_MISMATCH}] request Vault ${describe(actual)} does not match the handle's Vault ${describe(expected)}`,
  ), { code: VAULT_CONTEXT_MISMATCH });
}

/** Throws `VAULT_CONTEXT_MISMATCH` unless the handle's Vault equals the request Vault. */
export function assertVaultBinding(expectedVaultId, actualVaultId) {
  const expected = expectedVaultId ?? null;
  const actual = actualVaultId ?? null;
  if (expected !== actual) throw vaultContextMismatch(expected, actual);
  return actual;
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || value === "" || !path.isAbsolute(value)) {
    fail("VAULT_SCOPE_INVALID", `${label} must be a non-empty absolute path, got ${describe(value)}`);
  }
  return value;
}

/** Legacy / primary namespace: current DATA_PATH paths stay exactly as they are (§5.1, §22.2). */
const PRIMARY_SCOPE = Object.freeze({
  vaultId: null, primary: true, key: null,
  idempotencyRoot: root, journalRoot: null,
  vaultRoot: null, trashRoot: null, historyRoot: null, runtime: null,
});

/** The primary (legacy) scope — startup recovery / legacy schema 1 records (§22.4). */
export function primaryMutationVaultScope() {
  return PRIMARY_SCOPE;
}

/** Build a scope for an explicit `vaultId`; absent/blank means the legacy primary namespace. */
export function mutationVaultScopeFor(vaultId) {
  if (vaultId === undefined || vaultId === null || String(vaultId).trim() === "") return PRIMARY_SCOPE;
  const id = validateVaultId(String(vaultId));
  const key = vaultDataKey(id);
  return Object.freeze({
    vaultId: id, primary: false, key,
    idempotencyRoot: path.join(root, key), journalRoot: null,
    vaultRoot: null, trashRoot: null, historyRoot: null, runtime: null,
  });
}

/** Build a scope from an injected VaultRuntime (B1 seam); primary keeps the legacy paths (§5.1). */
export function mutationVaultScopeFromRuntime(runtime, fallbackVaultId = null) {
  const paths = runtime?.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    fail("VAULT_SCOPE_INVALID", "vaultRuntime must expose the A7 paths mapping");
  }
  const primary = Boolean(runtime.primary);
  const id = typeof runtime.id === "string" && runtime.id !== "" ? runtime.id : (fallbackVaultId === undefined ? null : fallbackVaultId);
  if (!primary && (id === null || id === "")) fail("VAULT_SCOPE_INVALID", "a secondary vaultRuntime must expose a vault id");
  return Object.freeze({
    vaultId: primary ? null : validateVaultId(String(id)),
    primary,
    key: primary ? null : vaultDataKey(String(id)),
    idempotencyRoot: requireAbsolute(paths.mutationIdempotency, "vaultRuntime.paths.mutationIdempotency"),
    journalRoot: requireAbsolute(paths.mutationJournal, "vaultRuntime.paths.mutationJournal"),
    vaultRoot: requireAbsolute(runtime.root, "vaultRuntime.root"),
    trashRoot: requireAbsolute(paths.trash, "vaultRuntime.paths.trash"),
    historyRoot: requireAbsolute(paths.history, "vaultRuntime.paths.history"),
    runtime,
  });
}

/** The scope of the current request; never guesses a secondary Vault (§13.2, SEC-MV05/SEC-MV06). */
export function currentMutationVaultScope() {
  const context = requestContext() || {};
  if (context.vaultRuntime) return mutationVaultScopeFromRuntime(context.vaultRuntime, context.vaultId);
  return mutationVaultScopeFor(context.vaultId);
}

// Recovery runs outside any request, so it resolves the owning runtime from an
// explicit, fail-closed registry populated by the integration owner (Wave C) from
// the canonical VaultRegistry. An unregistered Vault is never recovered as primary.
const recoveryScopes = new Map();

/** Register the roots/journals of one Vault for startup recovery (idempotent). */
export function registerMutationVaultScope(input = {}) {
  const vaultId = validateVaultId(String(input.vaultId ?? ""));
  const scope = Object.freeze({
    vaultId, primary: false, key: vaultDataKey(vaultId),
    idempotencyRoot: requireAbsolute(input.idempotencyRoot, "idempotencyRoot"),
    journalRoot: requireAbsolute(input.journalRoot, "journalRoot"),
    vaultRoot: requireAbsolute(input.vaultRoot, "vaultRoot"),
    trashRoot: requireAbsolute(input.trashRoot, "trashRoot"),
    historyRoot: requireAbsolute(input.historyRoot, "historyRoot"),
    runtime: input.runtime ?? null,
  });
  recoveryScopes.set(vaultId, scope);
  return scope;
}

/** Resolve a registered Vault runtime for recovery; `null` means "unknown Vault". */
export function registeredMutationVaultScope(vaultId) {
  return recoveryScopes.get(vaultId) ?? null;
}

/** Test/teardown seam for the recovery registry (no production caller). */
export function clearMutationVaultScopes() {
  recoveryScopes.clear();
}

/** Stable code for a journal whose owning Vault has no registered runtime (§13.3). */
export const JOURNAL_VAULT_UNRESOLVED = "JOURNAL_VAULT_UNRESOLVED";

/**
 * §13.3 recovery: parse the manifest first, then resolve its owning runtime. Legacy
 * schema 1 is primary-only; an unregistered Vault fails closed and is never guessed
 * as primary (SEC-MV06). The caller keeps the journal and surfaces the error.
 */
export function resolveMutationJournalScope(manifest) {
  if (manifest?.schema === 1) {
    if (manifest.vaultId) throw vaultContextMismatch(null, manifest.vaultId);
    return PRIMARY_SCOPE;
  }
  const vaultId = manifest?.vaultId ?? null;
  if (vaultId === null) return PRIMARY_SCOPE;
  const scope = recoveryScopes.get(vaultId);
  if (!scope) throw Object.assign(new Error(
    `[${JOURNAL_VAULT_UNRESOLVED}] mutation journal belongs to Vault ${JSON.stringify(vaultId)} without a registered runtime; refusing to recover it as primary (contract §13.3/§22.4; SEC-MV06 no fallback)`,
  ), { code: JOURNAL_VAULT_UNRESOLVED });
  return scope;
}

// ---------------------------------------------------------------------------
// Durable idempotency records (per-Vault, §13.2)
// ---------------------------------------------------------------------------

const validateDigest = (digest) => {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid idempotency digest");
  return digest;
};

async function canonicalRoot(scope, { allowMissing = false } = {}) {
  const rootPath = scope?.idempotencyRoot ?? root;
  let stat;
  try {
    stat = await fs.lstat(rootPath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error("Invalid mutation idempotency storage root");
  }

  const [dataReal, rootReal] = await Promise.all([
    fs.realpath(DATA_PATH),
    fs.realpath(rootPath),
  ]);
  const relative = path.relative(dataReal, rootReal);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Mutation idempotency storage escapes DATA_PATH");
  }
  return rootReal;
}

const fileFor = (rootPath, digest) =>
  path.join(rootPath, `${validateDigest(digest)}.json`);

export function idempotencyDigest(key) {
  return createHash("sha256").update(key).digest("hex");
}

// §13.2 / §22.4: schema 1 records predate the vault binding and are only ever
// interpretable as primary; schema 2 records must carry the reading scope's
// vaultId (null = primary). A record whose Vault disagrees is a cross-vault read.
function assertAppliedRecord(record, digest, scope) {
  if (!record || record.digest !== digest || !record.result || !record.author ||
      !Number.isFinite(record.expiresAtMs)) throw new Error("Invalid applied mutation record");
  if (record.schema === 1) {
    if (!scope.primary) fail(VAULT_CONTEXT_MISMATCH, "legacy schema 1 applied record is primary-only (§22.4)");
    return;
  }
  if (record.schema !== 2 || !Object.hasOwn(record, "vaultId")) throw new Error("Invalid applied mutation record");
  assertVaultBinding(record.vaultId, scope.vaultId);
}

export async function readAppliedRecord(digest, options = {}) {
  validateDigest(digest);
  const scope = options.scope || currentMutationVaultScope();
  const rootPath = await canonicalRoot(scope, { allowMissing: true });
  if (!rootPath) return null;
  const file = fileFor(rootPath, digest);
  let record;
  try { record = JSON.parse(await fs.readFile(file, "utf-8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  assertAppliedRecord(record, digest, scope);
  if (record.expiresAtMs <= Date.now()) {
    await fs.rm(file, { force: true });
    return null;
  }
  return record;
}

export async function saveAppliedRecord(record, options = {}) {
  validateDigest(record.digest);
  const scope = options.scope || currentMutationVaultScope();
  if (record.vaultId !== undefined) assertVaultBinding(record.vaultId, scope.vaultId);
  // Primary stays schema 1 (rollback-safe: an older build still reads its own
  // records, §5.1/§49.4); only a secondary Vault needs the schema 2 binding.
  const stamped = scope.primary
    ? { ...record, schema: 1, vaultId: null }
    : { ...record, schema: 2, vaultId: scope.vaultId };
  await fs.mkdir(scope.idempotencyRoot, { recursive: true, mode: 0o700 });
  const rootPath = await canonicalRoot(scope);
  const file = fileFor(rootPath, stamped.digest);
  await pruneExpiredAppliedRecords(scope);
  const existing = await readAppliedRecord(stamped.digest, { scope });
  if (existing) {
    if (existing.planId !== stamped.planId || existing.planHash !== stamped.planHash ||
        JSON.stringify(existing.author) !== JSON.stringify(stamped.author) ||
        JSON.stringify(existing.result) !== JSON.stringify(stamped.result)) {
      throw new Error("idempotencyKey was already used for another plan");
    }
    return existing;
  }
  const temp = path.join(rootPath, `.${stamped.digest}.${randomUUID()}.tmp`);
  const handle = await fs.open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(stamped)); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.link(temp, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const winner = await readAppliedRecord(stamped.digest, { scope });
    if (!winner || winner.planId !== stamped.planId || winner.planHash !== stamped.planHash ||
        JSON.stringify(winner.author) !== JSON.stringify(stamped.author) ||
        JSON.stringify(winner.result) !== JSON.stringify(stamped.result)) {
      throw new Error("idempotencyKey was already used for another plan");
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
  if (process.platform !== "win32") {
    const directory = await fs.open(rootPath, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return stamped;
}

export async function pruneExpiredAppliedRecords(scope = currentMutationVaultScope()) {
  const now = Date.now();
  if (now - lastPrunedAt < 60 * 60 * 1000) return;
  const rootPath = await canonicalRoot(scope, { allowMissing: true });
  if (!rootPath) return;
  lastPrunedAt = now;
  const names = await fs.readdir(rootPath);
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(rootPath, name);
    let record;
    try { record = JSON.parse(await fs.readFile(file, "utf-8")); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (Number.isFinite(record?.expiresAtMs) && record.expiresAtMs <= now) await fs.rm(file, { force: true });
  }
}
