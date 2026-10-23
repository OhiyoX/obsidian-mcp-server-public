import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_WEB_SESSION_FILE_BYTES,
  MAX_WEB_SESSION_RECORDS,
  WEB_SESSION_CHECKPOINT_MS,
  WEB_SESSION_SCHEMA_VERSION,
  WEB_SESSION_TOP_LEVEL_KEYS,
  WEB_SESSION_TTL_MS,
  WebSessionStoreError,
  hashWebSessionToken,
  isPlainObject,
  isValidWebSessionToken,
  validateRecord,
} from "./web-session-schema.js";

export {
  MAX_WEB_SESSION_FILE_BYTES,
  MAX_WEB_SESSION_RECORDS,
  WEB_SESSION_CHECKPOINT_MS,
  WEB_SESSION_COOKIE,
  WEB_SESSION_SCHEMA_VERSION,
  WEB_SESSION_TTL_MS,
  WebSessionStoreError,
  hashWebSessionToken,
  isValidWebSessionToken,
} from "./web-session-schema.js";
export { createWebSessionManager, resolveWebSession } from "./web-session-resolve.js";

const MAX_CAS_ATTEMPTS = 5;

export class WebSessionStore {
  constructor({
    file = null,
    now = Date.now,
    io = fs,
    maxRecords = MAX_WEB_SESSION_RECORDS,
    maxFileBytes = MAX_WEB_SESSION_FILE_BYTES,
    checkpointMs = WEB_SESSION_CHECKPOINT_MS,
    ttlMs = WEB_SESSION_TTL_MS,
  } = {}) {
    this.file = file;
    this.clock = now;
    this.io = io;
    this.maxRecords = maxRecords;
    this.maxFileBytes = maxFileBytes;
    this.checkpointMs = checkpointMs;
    this.ttlMs = ttlMs;
    this.records = new Map();
    this.memoryVersion = 0;
    this.dirty = false;
    this.tail = Promise.resolve();
    this.timer = null;
    this.ready = this.#load().then(() => this.#startTimer());
  }

  now() {
    return this.clock();
  }

  activeCount() {
    return this.records.size;
  }

  snapshot(rawToken) {
    if (!isValidWebSessionToken(rawToken)) return null;
    const tokenHash = hashWebSessionToken(rawToken);
    const entry = this.records.get(tokenHash);
    if (!entry) return null;
    return { tokenHash, version: entry.version, record: { ...entry.record } };
  }

  /** Foreground durable create. Memory is committed only after the candidate write succeeds. */
  createSession(rawToken, record) {
    if (!isValidWebSessionToken(rawToken)) return Promise.resolve({ ok: false, reason: "invalid_token" });
    const tokenHash = hashWebSessionToken(rawToken);
    return this.#enqueue(async () => {
      this.#pruneExpired();
      if (this.records.has(tokenHash)) return { ok: false, reason: "exists" };
      if (this.records.size >= this.maxRecords) return { ok: false, reason: "capacity" };
      let validated;
      try {
        validated = validateRecord(tokenHash, record);
      } catch (error) {
        return { ok: false, reason: "invalid_record", error };
      }
      const entry = { record: validated, version: 1, durableVersion: 0, durableExpiresAt: Number.NEGATIVE_INFINITY, durableLastSeenAt: Number.NEGATIVE_INFINITY };
      const buildVersion = this.memoryVersion;
      const candidate = new Map(this.records);
      candidate.set(tokenHash, entry);
      const persisted = await this.#persistRecords(candidate, buildVersion);
      if (!persisted.ok) {
        // The candidate never entered committed memory, so nothing is rolled back.
        this.dirty = true;
        return { ok: false, reason: "persist", error: persisted.error };
      }
      // Writes are serialized, so no other caller can have inserted this token; commit now.
      if (this.records.has(tokenHash)) {
        this.dirty = true;
        return { ok: false, reason: "exists" };
      }
      this.records.set(tokenHash, entry);
      this.memoryVersion += 1;
      return { ok: true, version: 1, record: { ...validated } };
    });
  }

  /**
   * Synchronous CAS touch. No disk write: the caller decides whether the request-side
   * overdue fence requires an awaited checkpoint before the request may succeed.
   */
  touchIfCurrent(tokenHash, expectedVersion, mutation) {
    const entry = this.records.get(tokenHash);
    if (!entry) return { ok: false, reason: "missing" };
    if (entry.version !== expectedVersion) return { ok: false, reason: "stale" };
    if (entry.record.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    let nextRecord;
    try {
      nextRecord = mutation({ ...entry.record });
    } catch (error) {
      return { ok: false, reason: "rejected", error };
    }
    if (!nextRecord) return { ok: false, reason: "rejected" };
    let validated;
    try {
      validated = validateRecord(tokenHash, nextRecord);
    } catch (error) {
      return { ok: false, reason: "invalid_record", error };
    }
    // Inherit the record's own durable marker. If a checkpoint write is in flight
    // while this touch happens, the new version must NOT inherit the unwritten
    // candidate's marker, only what was actually serialized and acked before it.
    const next = {
      record: validated,
      version: expectedVersion + 1,
      durableVersion: entry.durableVersion,
      durableExpiresAt: entry.durableExpiresAt,
      durableLastSeenAt: entry.durableLastSeenAt,
    };
    this.records.set(tokenHash, next);
    this.memoryVersion += 1;
    this.dirty = true;
    const durableExpiresAt = Number.isSafeInteger(entry.durableExpiresAt) ? entry.durableExpiresAt : Number.NEGATIVE_INFINITY;
    const durableLastSeenAt = Number.isSafeInteger(entry.durableLastSeenAt) ? entry.durableLastSeenAt : Number.NEGATIVE_INFINITY;
    return {
      ok: true,
      version: next.version,
      record: { ...validated },
      checkpointRequired:
        validated.expiresAt - durableExpiresAt >= this.checkpointMs
        || validated.lastSeenAt - durableLastSeenAt >= this.checkpointMs,
    };
  }

  /**
   * Foreground durable CAS update. The candidate document is written from the
   * committed snapshot without ever publishing it to readers; committed memory is
   * swapped only after the awaited atomic write succeeds and the committed entry
   * is still the one we read (membership + version fence).
   */
  updateIfCurrent(tokenHash, expectedVersion, mutation) {
    return this.#enqueue(async () => {
      const entry = this.records.get(tokenHash);
      if (!entry) return { ok: false, reason: "missing" };
      if (entry.version !== expectedVersion) return { ok: false, reason: "stale" };
      if (entry.record.expiresAt <= this.now()) return { ok: false, reason: "expired" };
      let nextRecord;
      try {
        nextRecord = mutation({ ...entry.record });
      } catch (error) {
        return { ok: false, reason: "rejected", error };
      }
      if (!nextRecord) return { ok: false, reason: "rejected" };
      let validated;
      try {
        validated = validateRecord(tokenHash, nextRecord);
      } catch (error) {
        return { ok: false, reason: "invalid_record", error };
      }
      const next = {
        record: validated,
        version: expectedVersion + 1,
        durableVersion: entry.durableVersion,
        durableExpiresAt: entry.durableExpiresAt,
        durableLastSeenAt: entry.durableLastSeenAt,
      };
      const buildVersion = this.memoryVersion;
      const candidate = new Map(this.records);
      candidate.set(tokenHash, next);
      const persisted = await this.#persistRecords(candidate, buildVersion);
      if (!persisted.ok) {
        // Committed memory was never changed, so the previous record is intact.
        this.dirty = true;
        return { ok: false, reason: "persist", error: persisted.error };
      }
      // A concurrent synchronous touch/delete must never be clobbered or resurrected.
      if (this.records.get(tokenHash) !== entry) {
        this.dirty = true;
        const reconciled = await this.#persistCurrent();
        if (!reconciled.ok) return { ok: false, reason: "persist", error: reconciled.error };
        return this.records.has(tokenHash) ? { ok: false, reason: "stale" } : { ok: false, reason: "missing" };
      }
      this.records.set(tokenHash, next);
      this.memoryVersion += 1;
      return { ok: true, version: next.version, record: { ...validated } };
    });
  }

  /** Bounded re-read + CAS retry for explicit user-visible mutations. */
  async mutateSession(rawToken, mutation, attempts = MAX_CAS_ATTEMPTS) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const snapshot = this.snapshot(rawToken);
      if (!snapshot) return { ok: false, reason: "missing" };
      const result = await this.updateIfCurrent(snapshot.tokenHash, snapshot.version, mutation);
      if (result.ok || result.reason !== "stale") return result;
    }
    return { ok: false, reason: "stale" };
  }

  /** Immediate in-process deny without a durable write (derived/authority cleanup). */
  deleteSession(rawToken) {
    if (!isValidWebSessionToken(rawToken)) return false;
    const removed = this.records.delete(hashWebSessionToken(rawToken));
    if (removed) {
      this.memoryVersion += 1;
      this.dirty = true;
    }
    return removed;
  }

  /** Logout: immediate deny, then awaited durable delete ack. */
  revoke(rawToken) {
    if (!isValidWebSessionToken(rawToken)) return Promise.resolve({ ok: true, removed: false });
    const removed = this.records.delete(hashWebSessionToken(rawToken));
    if (removed) {
      this.memoryVersion += 1;
      this.dirty = true;
    }
    return this.#enqueue(async () => {
      const persisted = await this.#persistCurrent();
      if (!persisted.ok) return { ok: false, reason: "persist", error: persisted.error, removed };
      return { ok: true, removed };
    });
  }

  checkpoint() {
    return this.#enqueue(() => this.#persistCurrent());
  }

  async drain() {
    this.#stopTimer();
    return this.#enqueue(() => this.#persistCurrent());
  }

  close() {
    this.#stopTimer();
  }

  async #load() {
    if (!this.file) return;
    await this.io.mkdir(path.dirname(this.file), { recursive: true });
    let raw;
    try {
      const stat = await this.io.stat(this.file);
      if (stat.size > this.maxFileBytes) throw new WebSessionStoreError("file_too_large", "Web session state file exceeds the hard size cap");
      raw = await this.io.readFile(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new WebSessionStoreError("corrupt_json", "Web session state file is not valid JSON");
    }
    if (!isPlainObject(parsed) || parsed.version !== WEB_SESSION_SCHEMA_VERSION) {
      throw new WebSessionStoreError("unsupported_schema", "Web session state file has an unsupported schema version");
    }
    for (const key of Object.keys(parsed)) {
      if (!WEB_SESSION_TOP_LEVEL_KEYS.includes(key)) {
        throw new WebSessionStoreError("invalid_record", `Web session state file has an unsupported top-level field: ${key}`);
      }
    }
    if (!isPlainObject(parsed.sessions)) {
      throw new WebSessionStoreError("invalid_record", "Web session state file is missing the sessions map");
    }
    const now = this.now();
    for (const [tokenHash, record] of Object.entries(parsed.sessions)) {
      const validated = validateRecord(tokenHash, record);
      if (validated.expiresAt <= now) continue;
      // The loaded document is exactly what is durable for this record: its expiry
      // (and version 1) is the durable fence baseline. Startup time must never
      // launder an old durable expiry into a fresh budget.
      this.records.set(tokenHash, { record: validated, version: 1, durableVersion: 1, durableExpiresAt: validated.expiresAt, durableLastSeenAt: validated.lastSeenAt });
    }
    if (this.records.size > this.maxRecords) {
      throw new WebSessionStoreError("too_many_records", "Web session state file exceeds the active record cap");
    }
  }

  #pruneExpired() {
    const now = this.now();
    let removed = 0;
    for (const [tokenHash, entry] of [...this.records]) {
      if (entry.record.expiresAt <= now) {
        this.records.delete(tokenHash);
        removed += 1;
      }
    }
    if (removed) {
      this.memoryVersion += 1;
      this.dirty = true;
    }
    return removed;
  }

  #documentOf(records) {
    const sessions = {};
    for (const [tokenHash, entry] of records) sessions[tokenHash] = { ...entry.record };
    return { version: WEB_SESSION_SCHEMA_VERSION, sessions };
  }

  /**
   * Mark exactly the entry versions that were captured for the write as durable.
   * Entries are compared by object identity at capture time, so a concurrent
   * synchronous touch (which replaces the map entry with a new object carrying the
   * previous durable marker) can never inherit an unwritten version marker.
   */
  #markDurable(entries) {
    for (const [, entry] of entries) {
      entry.durableVersion = entry.version;
      entry.durableExpiresAt = entry.record.expiresAt;
      entry.durableLastSeenAt = entry.record.lastSeenAt;
    }
  }

  /**
   * Persist the exact records handed in (candidate or committed map) and advance
   * only their per-record durable marker. `buildVersion` is the process-local
   * version observed before the write; if a synchronous touch/delete advanced it
   * during the await, the store stays dirty.
   */
  async #persistRecords(records, buildVersion) {
    const captured = [...records];
    const document = this.#documentOf(records);
    if (this.file) {
      try {
        await this.#atomicWrite(document);
      } catch (error) {
        this.dirty = true;
        return { ok: false, reason: "persist", error };
      }
    }
    this.#markDurable(captured);
    this.dirty = this.memoryVersion !== buildVersion;
    return { ok: true };
  }

  #persistCurrent() {
    return this.#persistRecords(this.records, this.memoryVersion);
  }

  async #atomicWrite(document) {
    const payload = JSON.stringify(document);
    if (Buffer.byteLength(payload, "utf8") > this.maxFileBytes) {
      throw new WebSessionStoreError("file_too_large", "Web session candidate exceeds the hard size cap");
    }
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let handle = null;
    try {
      handle = await this.io.open(temporary, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.io.rename(temporary, this.file);
      await this.io.chmod(this.file, 0o600).catch(() => {});
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* ignore close failure */ }
      }
      try { await this.io.rm(temporary, { force: true }); } catch { /* ignore cleanup failure */ }
      throw error;
    }
  }

  #enqueue(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  #startTimer() {
    if (!this.file || this.timer) return;
    this.timer = setInterval(() => {
      if (!this.dirty) return;
      this.checkpoint().catch(() => {});
    }, this.checkpointMs);
    this.timer.unref?.();
  }

  #stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function createWebSessionStore(options = {}) {
  return new WebSessionStore(options);
}
