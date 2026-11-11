// P1 / Task 4 — committed authorization store with CAS and failure atomicity.
//
// Contract: design §9. One single-writer file, one serial queue, then
// validate -> clone -> CAS(expectedRevision) -> same-directory temp write + sync
// -> rename -> publish the committed projection. A failed write publishes neither
// the candidate nor a success, so the old memory and the old file stay
// consistent. A missing, unreadable or broken file is a `broken` snapshot: the
// store never seeds an empty document. `repair` is the only way out of `broken`,
// and it saves the original bytes with their SHA-256 first.
//
// `io` is the explicit seam (mkdir/readFile/open/rename/unlink/chmod), so a
// test can make rename or sync fail without a real disk fault. The store never
// reads the ambient clock and writes no audit record: audit is a caller concern,
// and a non-fatal audit failure therefore cannot move a decision here.

import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
  AUTHORIZATION_CODES,
  parseAuthorizationDocument,
  serializeAuthorizationDocument,
  validateAuthorizationDocument,
} from "./schema.js";

const { INVALID_DOCUMENT, STATE_UNAVAILABLE } = AUTHORIZATION_CODES;

export const AUTHORIZATION_STORE_CODES = Object.freeze({
  // The caller's expectedRevision is not the committed one: another writer won.
  STALE_REVISION: "stale_authorization_revision",
  // The candidate was built for a different next revision; a lost write would
  // otherwise hide behind a reused number.
  REVISION_MISMATCH: "authorization_revision_mismatch",
  WRITE_FAILED: "authorization_store_io_error",
  REPAIR_NOT_REQUIRED: "authorization_repair_not_required",
});

const { STALE_REVISION, REVISION_MISMATCH, WRITE_FAILED, REPAIR_NOT_REQUIRED } = AUTHORIZATION_STORE_CODES;

const IO_METHODS = Object.freeze(["mkdir", "readFile", "open", "rename", "unlink", "chmod"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function failure(code) {
  return { ok: false, revision: null, code };
}

/**
 * `createAuthorizationStore({file, io}) -> {ready, snapshot(), replace(), repair(), drain()}`
 *
 * - `ready` settles when the first load attempt finished; it never rejects.
 * - `snapshot()` is frozen: `{status:"loading"}` before `ready`, then
 *   `{status:"ready", revision, document}` or `{status:"broken", code}`.
 * - mutations return `{ok, revision, code}` and are serialized.
 */
export function createAuthorizationStore({ file, io } = {}) {
  if (typeof file !== "string" || file.length === 0) throw new TypeError("authorization store needs a file path");
  if (!io || typeof io !== "object") throw new TypeError("authorization store needs an io seam");
  for (const name of IO_METHODS) {
    if (typeof io[name] !== "function") throw new TypeError(`authorization store io seam is missing ${name}`);
  }

  const directory = dirname(file);
  let state = Object.freeze({ status: "loading" });
  let queue = Promise.resolve();

  function publish(document) {
    state = Object.freeze({ status: "ready", revision: document.revision, document: deepFreeze(document) });
  }

  async function lockDownMode() {
    // 0600 is the contract; a mode failure is reported by the caller, it must not
    // turn a readable state into a denial.
    await io.chmod(file, 0o600).catch(() => {});
  }

  async function load() {
    let bytes;
    try {
      bytes = await io.readFile(file);
    } catch {
      state = Object.freeze({ status: "broken", code: STATE_UNAVAILABLE });
      return;
    }
    const parsed = parseAuthorizationDocument(bytes.toString("utf8"));
    if (!parsed.ok) {
      state = Object.freeze({ status: "broken", code: parsed.code });
      return;
    }
    await lockDownMode();
    publish(parsed.document);
  }

  // A rename is only durable once the directory that holds the name is flushed.
  // Without this, a crash right after `rename` can lose the name; the store would
  // then load as broken and refuse every request.
  async function fsyncDirectory() {
    let handle = null;
    try {
      handle = await io.open(directory, "r");
      await handle.sync();
      await handle.close();
      handle = null;
      return true;
    } catch {
      if (handle) await handle.close().catch(() => {});
      return false;
    }
  }

  // One durable write: mkdir 0700, temp file 0600 in the same directory, write,
  // fsync, close, rename, then fsync the directory.
  //   "durable"   - the rename and the directory flush succeeded;
  //   "uncertain"  - the rename succeeded but the directory flush failed, so the
  //                  name may or may not survive a crash. The caller must NOT undo
  //                  it: the disk is now ahead of memory, so the store adopts the
  //                  document and answers success with `durabilityUncertain: true`;
  //   false        - nothing was renamed; the temp file is removed and nothing
  //                  changed. Reporting failure after the state advanced is the one
  //                  outcome that must never happen.
  async function writeDurably(document) {
    const bytes = Buffer.from(serializeAuthorizationDocument(document), "utf8");
    const temp = join(directory, `.${basename(file)}.tmp-${randomUUID()}`);
    let handle = null;
    try {
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await io.open(temp, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await io.rename(temp, file);
      return (await fsyncDirectory()) ? "durable" : "uncertain";
    } catch {
      if (handle) await handle.close().catch(() => {});
      await io.unlink(temp).catch(() => {});
      return false;
    }
  }

  // Keep the broken original for offline repair (design §9: no corrupt-reset).
  // The name carries the content hash, so an earlier original is never overwritten
  // by different bytes.
  async function saveOriginal() {
    let bytes;
    try {
      bytes = await io.readFile(file);
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, backupFile: null, sha256: null };
      return { ok: false };
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const backupFile = `${file}.broken-${sha256.slice(0, 16)}`;
    let handle = null;
    try {
      handle = await io.open(backupFile, "w", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await io.chmod(backupFile, 0o600).catch(() => {});
    } catch {
      if (handle) await handle.close().catch(() => {});
      return { ok: false };
    }
    return { ok: true, backupFile, sha256 };
  }

  function normalizeCandidate(document) {
    try {
      return { ok: true, document: validateAuthorizationDocument(document) };
    } catch (error) {
      return { ok: false, code: typeof error?.code === "string" ? error.code : INVALID_DOCUMENT };
    }
  }

  async function applyReplace(expectedRevision, document) {
    if (state.status !== "ready") return failure(STATE_UNAVAILABLE);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) return failure(STALE_REVISION);
    const candidate = normalizeCandidate(document);
    if (!candidate.ok) return failure(candidate.code);
    if (candidate.document.revision !== expectedRevision + 1) return failure(REVISION_MISMATCH);
    const written = await writeDurably(candidate.document);
    if (written === false) return failure(WRITE_FAILED);
    // The disk is the truth: adopt the document even when the directory flush failed.
    publish(candidate.document);
    return written === "uncertain"
      ? { ok: true, revision: candidate.document.revision, code: null, durabilityUncertain: true }
      : { ok: true, revision: candidate.document.revision, code: null };
  }

  async function applyRepair(document) {
    // A healthy store uses `replace` with CAS; repair is reserved for a broken one.
    if (state.status === "ready") return failure(REPAIR_NOT_REQUIRED);
    const candidate = normalizeCandidate(document);
    if (!candidate.ok) return failure(candidate.code);
    const original = await saveOriginal();
    if (!original.ok) return failure(WRITE_FAILED);
    const written = await writeDurably(candidate.document);
    if (written === false) return failure(WRITE_FAILED);
    publish(candidate.document);
    return {
      ok: true,
      revision: candidate.document.revision,
      code: null,
      backupFile: original.backupFile,
      sha256: original.sha256,
      ...(written === "uncertain" ? { durabilityUncertain: true } : {}),
    };
  }

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.then(() => {}, () => {});
    return run;
  }

  const ready = enqueue(load);

  return Object.freeze({
    ready,
    snapshot: () => state,
    replace: (expectedRevision, document) => enqueue(async () => {
      await ready;
      return applyReplace(expectedRevision, document);
    }),
    repair: (document) => enqueue(async () => {
      await ready;
      return applyRepair(document);
    }),
    drain: () => queue.then(() => {}),
  });
}
