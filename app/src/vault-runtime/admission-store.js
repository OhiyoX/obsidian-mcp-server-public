// W2 (#437) — admission persistence, contract §2.2 / §2.3 / §3.1.
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §2.1  准入决定（pending|approved，持久化）与运行状态（unavailable|initializing|ready|error，投影）正交
//   §2.2  唯一权威文件 `DATA_PATH/vault-admissions.json`：单写者、原子替换（temp+rename）、损坏 fail-closed
//         （拒绝启动并保留原文件）；准入决定与 registry 快照**同处一个文件**（不得拆成两个 JSON）
//   §2.3  初始化入口冻结：文件缺失 ⇒ 一律拒绝自动迁移；反复切换/配置增加都不得再次自动迁移；
//         丢失恢复不得被当作「首次启用」而重新批准
//   §3.1  `entries[id].identity` 是原身份绑定，不得被新目录覆盖；已确认更换 identity 的旧 vaultId 禁止再批准
//
// Boundaries: a *store*, not a policy engine — it never enumerates directories, never decides which
// Vaults exist and never publishes. No `config.js`/`process.env` (§43-5): the file is a parameter.
// Only the explicit `initialize()` / `approve()` create an approval; discovery produces `pending`.
// A corrupt/unreadable file is never rewritten — `load()` throws and the bytes stay for an operator.
//
// The document schema/shape lives in `./admission-document.js` (line budget) and is re-exported here.
//
// W2 fix (#437 RETURN item 3): `commit()` is a compare-and-swap on the authoritative `revision`.
//
// W2FIX2 (#437 RETURN 2, items 1+2):
//   * item 1 — the MANAGED-MODE ENROLLMENT sentinel (`enrollmentFile`) is a SECOND, durable file that
//     records only "this data root is under admission management" plus the trusted identity bindings
//     and generations. It carries NO admission decision and is never read to grant one; it can only
//     ever make the store refuse MORE (a lost record is not a lost binding). The sentinel is written
//     BEFORE the record (`temp + rename`, same discipline) so a crash leaves a superset, never a
//     lower binding. See `vault-admission.js` for the enforced-mode criterion.
//   * item 2 — `load()` is single-flight and caches its success; every read AND every mutation runs
//     inside ONE serialized queue, so a late/stale read can never publish over newer state, and an
//     ENOENT `reload()` never clears a known binding. `initialize()` refuses a replaced directory
//     even when the record itself was lost, by consulting the surviving sentinel bindings.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ADMISSIONS_CORRUPT,
  ADMISSIONS_VERSION,
  ADMISSION_APPROVED,
  ADMISSION_PENDING,
  ENROLLMENT_VERSION,
  assertEnrollmentAgreesWithRecord,
  assertVaultIdentity,
  buildNextAdmissionDocument,
  cloneAdmissionState,
  isPlainObject,
  mergeEnrollmentBindings,
  serializeRegistrySnapshot,
  validateAdmissionState,
} from "./admission-document.js";
import { isValidVaultId } from "./descriptor.js";
import { ADMISSIONS_ENROLLMENT_FAILED, ADMISSIONS_READ_FAILED, defaultEnrollmentFile, readEnrollmentFile, writeEnrollmentFile } from "./enrollment-sentinel.js";
import { assertDistinctAdmissionPaths, assertDistinctAdmissionPathsReal } from "./path-identity.js";
import { createAdmissionTrust } from "./admission-trust.js";
import { trustedReadbackRefusal } from "./admission-readback.js";

// Re-export the document contract so consumers keep exactly one import site.
export {
  ADMISSIONS_CAPACITY_EXCEEDED,
  ADMISSIONS_CORRUPT,
  ADMISSIONS_VERSION,
  ADMISSION_APPROVED,
  ADMISSION_DECISIONS,
  ADMISSION_PENDING,
  ENROLLMENT_VERSION,
  MAX_ADMISSION_ENTRIES,
  emptyAdmissionState,
  emptyEnrollmentState,
  serializeRegistrySnapshot,
  validateAdmissionState,
  validateEnrollmentState,
} from "./admission-document.js";
export { ADMISSIONS_ENROLLMENT_FAILED, ADMISSIONS_READ_FAILED, defaultEnrollmentFile } from "./enrollment-sentinel.js";
export { ADMISSION_PATH_CONFLICT, assertDistinctAdmissionPaths, assertDistinctAdmissionPathsReal } from "./path-identity.js";
export { ADMISSIONS_RECOVERY_REQUIRED } from "./admission-document.js";
export { ADMISSIONS_RELOAD_REFUSED } from "./admission-readback.js";

export const ADMISSIONS_WRITE_FAILED = "VAULT_ADMISSIONS_WRITE_FAILED";
export const ADMISSIONS_INVALID_OPERATION = "VAULT_ADMISSIONS_INVALID_OPERATION";
export const ADMISSION_IDENTITY_CONFLICT = "VAULT_ADMISSION_IDENTITY_CONFLICT";
/** An admission round lost the race against a newer authoritative revision (item 3, CAS). */
export const ADMISSIONS_REVISION_CONFLICT = "VAULT_ADMISSIONS_REVISION_CONFLICT";

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return Array.isArray(value) ? `array(${value.length})` : `${typeof value} ${String(value)}`;
}

/** The default sentinel path is a sibling of the record; see `enrollment-sentinel.js`. */
/**
 * `createAdmissionStore({ file, enrollmentFile, fsApi = fs, clock = () => new Date(), logger = console })`
 * The file is the single writer's target; every mutation is computed *inside* one serialized chain
 * and applied with one atomic `temp + rename`. `load()` must be awaited before any mutation.
 */
export function createAdmissionStore({ file, enrollmentFile = defaultEnrollmentFile(file), fsApi = fs, clock = () => new Date(), logger = console } = {}) {
  if (typeof file !== "string" || file === "" || !path.isAbsolute(file)) {
    fail(ADMISSIONS_INVALID_OPERATION, `file must be a non-empty absolute path, got ${describe(file)}`);
  }
  if (typeof enrollmentFile !== "string" || enrollmentFile === "" || !path.isAbsolute(enrollmentFile)) {
    fail(ADMISSIONS_INVALID_OPERATION, `enrollmentFile must be a non-empty absolute path, got ${describe(enrollmentFile)}`);
  }
  // W2FIX3 item 1 (sync layer): the record and the sentinel must be two different files. Refused here,
  // in the constructor, so no configuration can even create a store with a colliding pair; the async
  // real-target layer runs before the first read/write in `readAndApply`/`writeDocument`.
  assertDistinctAdmissionPaths({ file, enrollmentFile });
  if (fsApi === null || typeof fsApi !== "object" || typeof fsApi.readFile !== "function" || typeof fsApi.writeFile !== "function" || typeof fsApi.rename !== "function") {
    fail(ADMISSIONS_INVALID_OPERATION, `fsApi must expose readFile/writeFile/rename, got ${describe(fsApi)}`);
  }
  if (typeof clock !== "function") fail(ADMISSIONS_INVALID_OPERATION, `clock must be a function returning a Date, got ${describe(clock)}`);

  let state = null; // null = loaded-but-absent (or never loaded); otherwise a frozen validated document
  let enrollment = null; // null = no managed-mode sentinel yet; otherwise a frozen validated sentinel
  let loaded = false;
  let loadPromise = null;
  let loadResult = null;
  let queue = Promise.resolve();

  const nowIso = () => clock().toISOString();

  /** ONE serialized chain for every read-apply and every write (item 2). */
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function requireTrustedActor(actor, action) {
    if (typeof actor !== "string" || actor.trim() === "") fail(ADMISSIONS_INVALID_OPERATION, `${action} requires a trusted operator identity (approvedBy), got ${describe(actor)}`);
    return actor.trim();
  }

  function requireLoaded() {
    if (!loaded) fail(ADMISSIONS_INVALID_OPERATION, "the admission store must be load()ed before it is used");
  }

  // W2FIX3 (items 1/2/3): the trusted read-only projection (binding, generation floor, CAS base) lives
  // in `admission-trust.js`; the store keeps `.entries`/`enrollment` as the ONE mutable source.
  const trust = createAdmissionTrust({ getState: () => state, getEnrollment: () => enrollment, requireLoaded });

  function atomicTemporary(target) {
    return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  }

  /** Build the next document from the CURRENT in-memory state (schema arithmetic lives in the
   * document module; the store owns only the live `state`). Always inside a serialized task.
   * W2FIX4 item C: the surviving sentinel's revision is a durable FLOOR — an explicit recovery after
   * a record loss must never write below it (such a record would be refused on the next load). */
  function nextDocument(payload) {
    return buildNextAdmissionDocument({ base: state, revisionFloor: enrollment?.revision ?? 0, ...payload });
  }

  async function writeDocument(document) {
    const validated = validateAdmissionState(document);
    const at = nowIso();
    // W2FIX3 item 1: never write either file until the two configured targets are proven distinct
    // (normalized + real target). Fail closed before the sentinel/record writes below.
    await assertDistinctAdmissionPathsReal({ file, enrollmentFile, fsApi });
    // Sentinel FIRST: a crash between the two writes leaves a superset of bindings (never a lower
    // one), and the record's own revision is still the single authority for admission decisions.
    const merged = mergeEnrollmentBindings(enrollment, validated.entries, at, validated.revision);
    if (merged.changed) {
      enrollment = await writeEnrollmentFile({ fsApi, enrollmentFile, document: { version: ENROLLMENT_VERSION, managed: true, managedSince: enrollment?.managedSince ?? at, revision: merged.revision, bindings: merged.bindings } });
    }
    const temporary = atomicTemporary(file);
    try {
      await fsApi.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsApi.rename(temporary, file);
    } catch (error) {
      if (typeof fsApi.rm === "function") await fsApi.rm(temporary, { force: true }).catch(() => {});
      fail(ADMISSIONS_WRITE_FAILED, `cannot atomically replace ${JSON.stringify(file)}: ${error?.code || error?.message || error}`);
    }
    state = cloneAdmissionState(validated);
    loadResult = Object.freeze({ exists: true, kept: false, managed: enrollment !== null, state });
    return state;
  }

  /** Single-writer serialization: never two concurrent writes, never a partially applied document. */
  function mutate(build) {
    return enqueue(() => writeDocument(build()));
  }

  async function readEnrollment() {
    return readEnrollmentFile({ fsApi, enrollmentFile });
  }

  /** Read + parse + validate + apply, inside the serialized queue (item 2: no stale publication). */
  async function readAndApply({ keepOnMissing }) {
    // W2FIX3 item 1: prove target independence BEFORE any read of either file (an aliased config could
    // otherwise make the two reads observe one file and hide a conflict).
    await assertDistinctAdmissionPathsReal({ file, enrollmentFile, fsApi });
    let raw;
    try {
      raw = await fsApi.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        // A missing record does NOT mean "never managed": the independent sentinel is read here too,
        // so a managed instance keeps refusing after state loss (item 1).
        enrollment = await readEnrollment();
        loaded = true;
        if (keepOnMissing && state !== null) {
          // Item 2: ENOENT must NEVER clear a known binding / trusted state.
          loadResult = Object.freeze({ exists: false, kept: true, managed: enrollment !== null, state });
          return loadResult;
        }
        state = null;
        loadResult = Object.freeze({ exists: false, kept: false, managed: enrollment !== null, state: null });
        return loadResult;
      }
      fail(
        ADMISSIONS_READ_FAILED,
        `cannot read ${JSON.stringify(file)}: ${error?.code || error?.message || error}. Refusing to start rather than treating an unreadable ` +
          "admissions file as 'not initialized' (contract §2.2 fail-closed)",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(
        ADMISSIONS_CORRUPT,
        `${JSON.stringify(file)} is not valid JSON (${error?.message || error}); refusing to start and leaving the file untouched ` +
          "(contract §2.2 fail-closed)",
      );
    }
    const validated = validateAdmissionState(parsed);
    const sentinel = await readEnrollment();
    // W2FIX3 item 2: a read-back may never move the trusted in-memory state BACKWARDS, and it may
    // never be BELOW the durable sentinel floor (a lost record write). On refusal the trusted
    // state/bindings/refusal gate are kept and BOTH files are left untouched.
    let agreementError = null;
    try {
      assertEnrollmentAgreesWithRecord(validated, sentinel);
    } catch (error) {
      agreementError = error;
    }
    const refusal = (keepOnMissing && state !== null && agreementError !== null)
      ? agreementError
      : (keepOnMissing && state !== null ? trustedReadbackRefusal(validated, state) : null);
    if (refusal !== null && keepOnMissing && state !== null) {
      logger?.warn?.(`[vault-admissions] refused a stale read-back of ${JSON.stringify(file)}: ${refusal.message}`);
      loadResult = Object.freeze({ exists: true, kept: true, refused: true, code: refusal.code, managed: enrollment !== null || sentinel !== null, state });
      return loadResult;
    }
    if (agreementError !== null) throw agreementError;
    state = cloneAdmissionState(validated);
    enrollment = sentinel;
    loaded = true;
    loadResult = Object.freeze({ exists: true, kept: false, managed: sentinel !== null, state });
    return loadResult;
  }

  /** Single-flight, cached initial load (item 2). A failure resets the flight so startup can retry. */
  function load() {
    if (loaded) return Promise.resolve(loadResult);
    if (loadPromise === null) {
      loadPromise = enqueue(() => readAndApply({ keepOnMissing: false })).finally(() => { loadPromise = null; });
    }
    return loadPromise;
  }

  /**
   * Explicit re-read, serialized with every mutation (item 2). An ENOENT keeps the known state and
   * reports `kept:true` instead of clearing the trusted bindings.
   */
  function reload() {
    requireLoaded();
    return enqueue(() => readAndApply({ keepOnMissing: true }));
  }

  /**
   * Persist the managed-mode sentinel (item 1). Only records the mode + current trusted bindings; it
   * grants nothing. Called by the composition root once enforcement is decided, so a later record
   * loss can never be re-read as "never managed".
   */
  function enroll({ source = "store" } = {}) {
    requireLoaded();
    return enqueue(async () => {
      if (enrollment !== null) {
        const merged = mergeEnrollmentBindings(enrollment, state?.entries ?? {}, nowIso(), state?.revision ?? 0);
        if (!merged.changed) return enrollment;
        enrollment = await writeEnrollmentFile({ fsApi, enrollmentFile, document: { ...enrollment, revision: merged.revision, bindings: merged.bindings } });
        return enrollment;
      }
      const at = nowIso();
      const merged = mergeEnrollmentBindings(null, state?.entries ?? {}, at, state?.revision ?? 0);
      logger?.info?.(`[vault-admissions] managed mode enrolled (source=${source}); ${Object.keys(merged.bindings).length} binding(s)`);
      enrollment = await writeEnrollmentFile({ fsApi, enrollmentFile, document: { version: ENROLLMENT_VERSION, managed: true, managedSince: at, revision: merged.revision, bindings: merged.bindings } });
      return enrollment;
    });
  }

  /** Explicit trusted initialization (contract §2.3): the ONLY path that creates approvals from
   * scratch. Writes `migration.done = true` in the same atomic document; a second call is refused.
   *
   * The `force` escape hatch is GONE. Initialization and recovery may never overwrite an existing
   * identity binding or lower a generation — a directory that changed identity must adopt a NEW Vault
   * ID (§3.1). After a record loss the surviving sentinel binding still decides. */
  async function initialize({ source, configDigest, approved = [], actor } = {}) {
    requireLoaded();
    const operator = requireTrustedActor(actor, "initialize");
    if (typeof source !== "string" || source.trim() === "") {
      fail(ADMISSIONS_INVALID_OPERATION, `initialize requires a non-empty source label, got ${describe(source)}`);
    }
    if (typeof configDigest !== "string" || configDigest.trim() === "") {
      fail(ADMISSIONS_INVALID_OPERATION, `initialize requires a non-empty configDigest, got ${describe(configDigest)}`);
    }
    if (!Array.isArray(approved)) fail(ADMISSIONS_INVALID_OPERATION, `initialize approved must be an array, got ${describe(approved)}`);
    return mutate(() => {
      if (state !== null && state.migration.done) {
        fail(
          ADMISSIONS_INVALID_OPERATION,
          `${JSON.stringify(file)} already records migration.done = true: refusing to re-run an automatic migration (contract §2.3)`,
        );
      }
      const at = nowIso();
      const entries = { ...(state?.entries ?? {}) };
      const vaults = { ...(state?.registry?.vaults ?? {}) };
      for (const item of approved) {
        if (!isPlainObject(item) || !isValidVaultId(item.id)) {
          fail(ADMISSIONS_INVALID_OPERATION, `initialize received a malformed approved entry: ${describe(item)}`);
        }
        assertVaultIdentity(item.identity, `approved[${JSON.stringify(item.id)}].identity`);
        if (typeof item.root !== "string" || item.root === "") {
          fail(ADMISSIONS_INVALID_OPERATION, `approved[${JSON.stringify(item.id)}].root must be a non-empty string`);
        }
        const existing = entries[item.id];
        // The trusted binding survives a record loss in the sentinel (item 1): re-confirming the
        // directory is NOT recovering the old binding, so a replaced identity is still refused.
        const trusted = existing?.identity ?? trust.bindingFor(item.id);
        if (trusted !== null && trusted !== undefined && trusted.digest !== item.identity.digest) {
          fail(
            ADMISSION_IDENTITY_CONFLICT,
            `refusing to initialize ${describe(item.id)}: the directory now resolves to a different identity than the trusted persisted binding. ` +
              "Initialization and recovery never overwrite an identity binding and never re-approve a reused ID (contract §3.1 v1 freeze)",
          );
        }
        entries[item.id] = {
          identity: trusted ?? item.identity,
          admission: ADMISSION_APPROVED,
          firstSeenAt: existing?.firstSeenAt ?? at,
          lastSeenAt: at,
          approvedAt: at,
          approvedBy: operator,
          generation: trust.generationFloorFor(item.id) + 1,
          note: existing?.note ?? null,
          identityConflict: false,
        };
        vaults[item.id] = {
          id: item.id,
          root: item.root,
          canonicalRoot: item.identity.canonicalRoot,
          primary: item.primary === true,
          writable: item.writable === true,
          identity: entries[item.id].identity,
        };
      }
      const document = nextDocument({ entries, registry: { vaults, skipped: [] } });
      document.migration = { done: true, doneAt: at, source: source.trim(), configDigest: configDigest.trim() };
      logger?.info?.(`[vault-admissions] initialized by ${operator} (source=${source.trim()}, ${approved.length} approved)`);
      return document;
    });
  }

  /** Reconciliation commit point (contract §4 step ③): admission decisions and the registry snapshot
   * land in ONE document at ONE revision. `expectedRevision` makes it a compare-and-swap against the
   * authoritative revision the round read (item 3): a stale round is refused, never merged. */
  async function commit({ entries, registry, actor = "reconciliation", expectedRevision } = {}) {
    requireLoaded();
    const operator = requireTrustedActor(actor, "commit");
    if (!isPlainObject(entries)) fail(ADMISSIONS_INVALID_OPERATION, `commit requires an entries object, got ${describe(entries)}`);
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      fail(ADMISSIONS_INVALID_OPERATION, `commit expectedRevision must be a non-negative integer, got ${describe(expectedRevision)}`);
    }
    return mutate(() => {
      if (state === null || !state.migration.done) {
        fail(
          ADMISSIONS_INVALID_OPERATION,
          "refusing to commit a registry snapshot before the explicit initialization created the migration marker (contract §2.3)",
        );
      }
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        fail(
          ADMISSIONS_REVISION_CONFLICT,
          `refusing to commit at revision ${expectedRevision}: the authoritative record moved to ${state.revision} while this round was in ` +
            "flight (an administrator decision won the race). The candidate is discarded and the round is re-run; a stale scan can never " +
            "revert an admission decision or a generation (contract §4, item 3)",
        );
      }
      return nextDocument({ entries, registry: registry === undefined ? undefined : { vaults: registry.vaults ?? {}, skipped: registry.skipped ?? [] } });
    });
  }

  /**
   * Approve a known (discovered) Vault. Two v1 refusals live here (contract §3.1): an approved entry
   * never loses its original identity binding, and an id whose directory changed identity can NEVER
   * be re-approved as that id — a new id is required.
   */
  async function approve(id, { actor, identity } = {}) {
    requireLoaded();
    const operator = requireTrustedActor(actor, "approve");
    if (identity !== undefined) assertVaultIdentity(identity, `approve(${describe(id)}).identity`);
    return mutate(() => {
      if (state === null) fail(ADMISSIONS_INVALID_OPERATION, "cannot approve before initialization");
      const current = state.entries[id];
      if (!current) {
        fail(ADMISSIONS_INVALID_OPERATION, `cannot approve unknown Vault ${describe(id)}: it has no admission record (discovery creates entries)`);
      }
      if (current.identity === null && identity === undefined) {
        fail(ADMISSIONS_INVALID_OPERATION, "explicit approval requires a confirmed identity proof");
      }
      if (current.identityConflict === true) {
        fail(
          ADMISSION_IDENTITY_CONFLICT,
          `refusing to approve ${describe(id)}: this id is bound to a replaced directory. Vault IDs must not be reused after an identity change ` +
            "(contract §3.1 v1 freeze): adopt a new Vault ID instead",
        );
      }
      if (current.identity !== null && identity !== undefined && current.identity.digest !== identity.digest) {
        fail(
          ADMISSION_IDENTITY_CONFLICT,
          `refusing to approve ${describe(id)}: the directory now resolves to a different identity than the persisted binding ` +
            `(${current.identity.digest.slice(7, 19)}… != ${identity.digest.slice(7, 19)}…). Persisted bindings are never overwritten and the id is ` +
            "not reusable (contract §3.1 v1 freeze): adopt a new Vault ID instead",
        );
      }
      const at = nowIso();
      const entries = {
        ...state.entries,
        [id]: {
          ...current,
          identity: current.identity ?? identity,
          admission: ADMISSION_APPROVED,
          approvedAt: at,
          approvedBy: operator,
          lastSeenAt: at,
          generation: current.generation + 1,
        },
      };
      logger?.info?.(`[vault-admissions] approved ${id} by ${operator}`);
      const vault = state.registry.vaults[id];
      const registry = vault && current.identity === null
        ? { vaults: { ...state.registry.vaults, [id]: { ...vault, identity, canonicalRoot: identity.canonicalRoot } }, skipped: state.registry.skipped }
        : undefined;
      return nextDocument({ entries, registry });
    });
  }

  /** Revoke an approval: back to `pending`. The record and its identity binding are kept. */
  async function revoke(id, { actor } = {}) {
    requireLoaded();
    const operator = requireTrustedActor(actor, "revoke");
    return mutate(() => {
      if (state === null) fail(ADMISSIONS_INVALID_OPERATION, "cannot revoke before initialization");
      const current = state.entries[id];
      if (!current) fail(ADMISSIONS_INVALID_OPERATION, `cannot revoke unknown Vault ${describe(id)}`);
      const entries = {
        ...state.entries,
        [id]: { ...current, admission: ADMISSION_PENDING, approvedAt: null, approvedBy: null, generation: current.generation + 1 },
      };
      logger?.info?.(`[vault-admissions] revoked ${id} by ${operator}`);
      return nextDocument({ entries });
    });
  }

  return Object.freeze({
    file,
    enrollmentFile,
    load,
    reload,
    enroll,
    initialize,
    commit,
    approve,
    revoke,
    snapshot: () => state,
    snapshotState: trust.snapshotState,
    entries: () => (state === null ? {} : state.entries),
    registrySnapshot: () => (state === null ? null : state.registry),
    revision: () => (state === null ? 0 : state.revision),
    isInitialized: () => state !== null && state.migration.done === true,
    isLoaded: () => loaded,
    isManaged: () => enrollment !== null,
    managedSince: () => enrollment?.managedSince ?? null,
    enrollment: () => enrollment,
    enrollmentRevision: () => enrollment?.revision ?? 0,
    bindingFor: trust.bindingFor,
    entryFor: (id) => (state === null ? undefined : state.entries[id]),
  });
}
