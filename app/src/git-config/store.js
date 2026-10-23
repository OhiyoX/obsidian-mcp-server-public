// Durable per-vault GitConfig store for the MCP multi-Vault track, Wave A / A5.
//
// Contract: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置` §15.3
// (persistence), §15.4 (defaults), §42 SEC-MV04 (no secrets), §43 (gates).
//
// The store owns exactly one caller-supplied file (default
// `<dataRoot>/git-vaults.json`) and never derives any other path: like the
// AuthZ access-policy store it must not import `config.js`, so A6/B4/E decide
// where the file lives.
//
// Invariants:
//  - a corrupt or unreadable file is a `broken` snapshot, never a crash and
//    never a silent reset: `read()` throws and every mutation fails closed;
//  - CAS: `expectedRevision` must equal the committed revision, so a stale
//    writer can never win (`last-write-wins` is forbidden) and the conflict is
//    returned as an explicit structure;
//  - a candidate reaches committed memory only after its durable atomic write
//    succeeded, so a failed persist cannot pollute committed state;
//  - durability: temp file -> `fsync` -> atomic rename (plus a best-effort
//    directory fsync), with 0600 on the temp file;
//  - all writes inside one process are serialized through a single queue; no
//    cross-process exclusion is promised (same posture as the precedent store),
//    which is why CAS is mandatory for every mutation.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GIT_CONFIG_CODES,
  GIT_CONFIG_LIMITS,
  GIT_CONFIG_SCHEMA,
  GitConfigError,
  buildGitConfigRecord,
  isGitConfigError,
  isValidGitConfigVaultId,
  parseGitConfigDocument,
  serializeGitConfigDocument,
  validateGitConfigDocument,
} from "./schema.js";

const FILE_NAME = "git-vaults.json";
const TEMP_PREFIX = ".git-vaults.";
const TEMP_SUFFIX = ".tmp";
// Isolation slot of a repaired broken file: same directory as the store file, so a repair never
// derives a second root and the operator finds the content next to the document it replaced.
const ISOLATE_SUFFIX = ".broken";

/**
 * The codes `repair()` alone reports. They are additive: no existing caller's contract moves, and
 * nothing here is reachable from `read()` / `write()` / `upsertVault()` / `removeVault()`.
 */
export const GIT_CONFIG_REPAIR_CODES = Object.freeze({
  // The store is readable (or became readable): a repair would overwrite healthy configuration.
  NOT_NEEDED: "git_config_repair_not_needed",
  // The corrupt file could not be moved aside, so nothing was written at all (fail closed).
  ISOLATE_FAILED: "git_config_repair_isolate_failed",
});

function freezeVaults(vaults) {
  const frozen = {};
  for (const [id, record] of Object.entries(vaults)) frozen[id] = Object.freeze(record);
  return Object.freeze(frozen);
}

class GitConfigStore {
  constructor({ dataRoot, filePath, clock = () => new Date(), logger = null, io = fs } = {}) {
    const file = filePath ?? (dataRoot === undefined || dataRoot === null ? null : path.join(dataRoot, FILE_NAME));
    if (!file) throw new TypeError("createGitConfigStore requires dataRoot or filePath");
    this.file = file;
    this.io = io;
    this.clock = typeof clock === "function" ? clock : () => new Date();
    this.logger = logger;
    // Fail closed until the load resolves: `status` is never "ready" up front.
    this.status = "broken";
    this.revision = null;
    this.errorCode = undefined;
    this.vaults = Object.freeze({});
    this.ready = this.#load();
    this.tail = this.ready.then(() => {}, () => {});
  }

  snapshot() {
    const snapshot = { status: this.status, revision: this.revision, vaults: this.vaults };
    if (this.errorCode) snapshot.errorCode = this.errorCode;
    return snapshot;
  }

  // Fail-closed read: a broken store never looks like an empty configuration.
  async read() {
    await this.ready;
    if (this.status !== "ready") {
      throw new GitConfigError(this.errorCode ?? GIT_CONFIG_CODES.STORE_IO, "git config store is not readable");
    }
    return { status: "ready", revision: this.revision, vaults: this.vaults };
  }

  // `next` is a complete vaultId -> record map (build records with
  // `buildGitConfigRecord`); the revision is assigned by the store.
  write(next, { expectedRevision } = {}) {
    return this.#enqueue(() => this.#commit(expectedRevision, () => next));
  }

  upsertVault(vaultId, patch, { expectedRevision } = {}) {
    if (!isValidGitConfigVaultId(vaultId)) return Promise.resolve(this.#failure(GIT_CONFIG_CODES.INVALID_VAULT_ID));
    return this.#enqueue(() => this.#commit(expectedRevision, (current) => ({
      ...current,
      [vaultId]: buildGitConfigRecord({ patch, base: current[vaultId], updatedAt: this.#now() }),
    })));
  }

  removeVault(vaultId, { expectedRevision } = {}) {
    if (!isValidGitConfigVaultId(vaultId)) return Promise.resolve(this.#failure(GIT_CONFIG_CODES.INVALID_VAULT_ID));
    return this.#enqueue(() => this.#commit(expectedRevision, (current) => {
      const next = { ...current };
      delete next[vaultId];
      return next;
    }));
  }

  drain() {
    return this.tail;
  }

  /**
   * Repair a `broken` store: isolate the unreadable file, then commit an empty A5 document through
   * the store's own durable write path (§15.3), so memory and revision move exactly the way every
   * other write moves them.
   *
   * Safety contract:
   *  - only a broken store may be repaired. A readable one, or one whose file has become readable
   *    again since boot, answers `NOT_NEEDED` and is never overwritten (the caller reports 409).
   *  - nothing is deleted: the corrupt file is *renamed* to `<file>.<ISO instant>-<6 hex>.broken`
   *    in the same directory and that path is returned, so the original content stays recoverable.
   *  - isolation happens before any write. If the rename fails the on-disk state is untouched and
   *    this fails closed with `ISOLATE_FAILED` and zero writes.
   *  - `#persist` + `#setReady` are the same two steps `#commit` uses; only the CAS comparison is
   *    absent, which is inherent: a broken store has no committed revision to compare against.
   *  - if the empty document cannot be persisted, the isolated file is put back (best effort) and
   *    the store stays exactly as broken as it was; when the put-back fails the isolation path is
   *    reported so the preserved content is never lost track of.
   */
  repair() {
    return this.#enqueue(async () => {
      await this.ready;
      if (this.status === "ready") return this.#repairRefusal(GIT_CONFIG_REPAIR_CODES.NOT_NEEDED);
      // An external fix (the file parses again) is adopted without any write instead of being
      // thrown away by a reset. Read-only: no rename, no persist.
      if (await this.#adoptReadableFile()) return this.#repairRefusal(GIT_CONFIG_REPAIR_CODES.NOT_NEEDED);
      let isolated;
      try {
        isolated = await this.#isolate();
      } catch {
        return this.#repairRefusal(GIT_CONFIG_REPAIR_CODES.ISOLATE_FAILED);
      }
      let candidate;
      try {
        candidate = validateGitConfigDocument({ schema: GIT_CONFIG_SCHEMA, revision: 0, vaults: {} });
      } catch (error) {
        // Unreachable with the frozen schema; kept so a future schema change fails closed here too.
        await this.#restore(isolated.path);
        if (isGitConfigError(error)) return this.#repairRefusal(error.code);
        throw error;
      }
      try {
        await this.#persist(candidate);
      } catch {
        const restored = await this.#restore(isolated.path);
        const failure = this.#repairRefusal(GIT_CONFIG_CODES.STORE_IO);
        // Only when the corrupt file stayed in the isolation slot: the operator must know where it is.
        return restored ? failure : { ...failure, isolatedPath: isolated.path };
      }
      this.#setReady(candidate.revision, candidate.vaults);
      return { ok: true, status: "ready", revision: candidate.revision, isolatedPath: isolated.path };
    });
  }

  #now() {
    const value = this.clock();
    const millis = value instanceof Date
      ? value.getTime()
      : typeof value === "number" ? value : Date.parse(String(value));
    if (!Number.isFinite(millis)) throw new TypeError("clock must return a valid instant");
    return new Date(millis).toISOString();
  }

  #current() {
    return { status: this.status, revision: this.revision };
  }

  #failure(code) {
    return { ok: false, code, current: this.#current() };
  }

  #setReady(revision, vaults) {
    this.status = "ready";
    this.revision = revision;
    this.errorCode = undefined;
    this.vaults = freezeVaults(vaults);
  }

  #setBroken(code) {
    this.status = "broken";
    this.revision = null;
    this.errorCode = code;
    this.vaults = Object.freeze({});
  }

  async #load() {
    // A size check before reading keeps a corrupt/oversized file from being
    // pulled into memory; `stat` ENOENT is the documented empty-store path.
    try {
      let stats;
      try {
        stats = await this.io.stat(this.file);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          this.#setReady(0, {});
          return this.#statusResult();
        }
        this.#setBroken(GIT_CONFIG_CODES.STORE_IO);
        return this.#statusResult();
      }
      if (stats && typeof stats.size === "number" && stats.size > GIT_CONFIG_LIMITS.fileBytes) {
        this.#setBroken(GIT_CONFIG_CODES.LIMIT_EXCEEDED);
        return this.#statusResult();
      }
      let text;
      try {
        text = await this.io.readFile(this.file, "utf8");
      } catch {
        this.#setBroken(GIT_CONFIG_CODES.STORE_IO);
        return this.#statusResult();
      }
      const parsed = parseGitConfigDocument(text);
      if (!parsed.ok) {
        this.#setBroken(parsed.code);
        return this.#statusResult();
      }
      this.#setReady(parsed.document.revision, parsed.document.vaults);
      return this.#statusResult();
    } catch {
      this.#setBroken(GIT_CONFIG_CODES.STORE_IO);
      return this.#statusResult();
    }
  }

  #repairRefusal(code) {
    return { ok: false, code, current: this.#current() };
  }

  /** The same read + parse guards `#load` applies, without the broken-on-failure branch. */
  async #adoptReadableFile() {
    try {
      const stats = await this.io.stat(this.file);
      if (stats && typeof stats.size === "number" && stats.size > GIT_CONFIG_LIMITS.fileBytes) return false;
      const parsed = parseGitConfigDocument(await this.io.readFile(this.file, "utf8"));
      if (!parsed.ok) return false;
      this.#setReady(parsed.document.revision, parsed.document.vaults);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rename the corrupt file into its isolation slot. `rename` never reads the payload, so an
   * oversized file (the `LIMIT_EXCEEDED` broken state) is isolated as cheaply as a small one. The
   * random tail makes the slot unique, because a second `rename` onto an existing name would
   * silently replace the earlier isolated copy.
   */
  async #isolate() {
    const stamp = this.#now().replace(/[:.]/g, "-");
    const target = `${this.file}.${stamp}-${randomBytes(3).toString("hex")}${ISOLATE_SUFFIX}`;
    await this.io.rename(this.file, target);
    await this.#syncDirectory(path.dirname(this.file));
    return { path: target };
  }

  /** Put the isolated file back. Best effort: a failure leaves the content preserved at its slot. */
  async #restore(isolatedPath) {
    try {
      await this.io.rename(isolatedPath, this.file);
      await this.#syncDirectory(path.dirname(this.file));
      return true;
    } catch {
      return false;
    }
  }

  #statusResult() {
    const result = { ok: this.status === "ready", status: this.status, revision: this.revision };
    if (this.errorCode) result.errorCode = this.errorCode;
    return result;
  }

  async #commit(expectedRevision, buildVaults) {
    if (this.status !== "ready") return this.#failure(this.errorCode ?? GIT_CONFIG_CODES.STORE_IO);
    if (expectedRevision !== this.revision) return this.#failure(GIT_CONFIG_CODES.STALE_REVISION);
    let candidate;
    try {
      candidate = validateGitConfigDocument({
        schema: GIT_CONFIG_SCHEMA,
        revision: this.revision + 1,
        vaults: buildVaults(this.vaults),
      });
    } catch (error) {
      if (isGitConfigError(error)) return this.#failure(error.code);
      throw error;
    }
    try {
      await this.#persist(candidate);
    } catch {
      return this.#failure(GIT_CONFIG_CODES.STORE_IO);
    }
    this.#setReady(candidate.revision, candidate.vaults);
    return { ok: true, revision: candidate.revision };
  }

  async #persist(document) {
    const payload = serializeGitConfigDocument(document);
    const directory = path.dirname(this.file);
    const temporary = path.join(directory, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
    try {
      await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await this.io.open(temporary, "w", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        // The precedent access-policy store renames without fsyncing; contract
        // §15.3 requires it, so the temp file is flushed before the rename.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.io.rename(temporary, this.file);
    } catch (error) {
      try {
        await this.io.unlink(temporary);
      } catch { /* best-effort temp cleanup */ }
      throw error;
    }
    await this.#syncDirectory(directory);
  }

  async #syncDirectory(directory) {
    let handle;
    try {
      handle = await this.io.open(directory, "r");
      await handle.sync();
    } catch (error) {
      // Windows cannot fsync a directory handle; POSIX durability keeps the
      // rename without this hint. Recorded, never fatal.
      this.logger?.debug?.(`git-config: directory fsync unavailable (${error?.code ?? "unknown"})`);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch { /* best-effort */ }
      }
    }
  }

  #enqueue(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => {}, () => {});
    return run;
  }
}

export function createGitConfigStore(options = {}) {
  return new GitConfigStore(options);
}
