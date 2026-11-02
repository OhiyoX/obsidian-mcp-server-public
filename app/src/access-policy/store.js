// Access-policy durable store for AuthZ Wave A / A3.
//
// Contract: `scratch/authz/INTERFACE.md` §8 and DEVELOPMENT §10. The store owns
// exactly one caller-supplied file. It never derives a path on its own and never
// touches oauth state or Web session files.
//
// Invariants:
//  - a startup failure is a `broken` snapshot, never a crash and never an empty
//    policy set: `evaluateAccess` fails closed on `status !== "ready"`;
//  - CAS: `expectedRevision` must equal the committed revision, so a stale
//    writer can never win (`last-write-wins` is forbidden);
//  - a candidate enters committed memory only after its durable atomic write
//    succeeded, so a failed persist cannot pollute committed state;
//  - all writes are serialized through one internal queue;
//  - `snapshot()` hands out frozen arrays and frozen policy objects only.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ACCESS_POLICY_CODES, isAccessPolicyError } from "./errors.js";
import {
  ACCESS_POLICY_LIMITS,
  ACCESS_POLICY_SCHEMA_VERSION,
  parseAccessPolicyDocument,
  serializeAccessPolicyDocument,
  validateAccessPolicyDocument,
} from "./schema.js";

const TEMP_PREFIX = ".access-policy.";
const TEMP_SUFFIX = ".tmp";

function freezePolicies(policies) {
  return Object.freeze(policies.map((policy) => Object.freeze(policy)));
}

class AccessPolicyStore {
  constructor({ file, now = Date.now, io = fs } = {}) {
    this.file = file;
    // Accepted for the frozen constructor contract; v1 persistence is purely
    // caller-stamped, so the store never reads the ambient clock itself.
    this.clock = now;
    this.io = io;
    // Fail closed until the load resolves: `status` is never "ready" by default.
    this.status = "broken";
    this.revision = null;
    this.errorCode = undefined;
    this.policies = Object.freeze([]);
    this.ready = this.#load();
    this.tail = this.ready.then(() => {}, () => {});
  }

  snapshot() {
    const snapshot = { status: this.status, revision: this.revision, policies: this.policies };
    if (this.errorCode) snapshot.errorCode = this.errorCode;
    return snapshot;
  }

  replace(expectedRevision, nextPolicies) {
    return this.#enqueue(() => this.#commit(expectedRevision, () => nextPolicies));
  }

  mutate(expectedRevision, mutationFn) {
    if (typeof mutationFn !== "function") return Promise.reject(new TypeError("mutationFn must be a function"));
    return this.#enqueue(() => this.#commit(expectedRevision, () => mutationFn(this.policies)));
  }

  repairBroken({ policies } = {}) {
    return this.#enqueue(async () => {
      const candidate = this.#candidate((this.revision ?? 0) + 1, policies);
      if (!candidate.ok) return this.#failure(candidate.code);
      try {
        await this.#persist(candidate.document);
      } catch {
        return this.#failure(ACCESS_POLICY_CODES.STORE_IO);
      }
      this.#commitSnapshot(candidate.document);
      return { ok: true, revision: candidate.document.revision };
    });
  }

  drain() {
    return this.tail;
  }

  #current() {
    return { status: this.status, revision: this.revision };
  }

  #failure(code) {
    return { ok: false, code, current: this.#current() };
  }

  #readyResult() {
    const result = { ok: this.status === "ready", status: this.status, revision: this.revision };
    if (this.errorCode) result.errorCode = this.errorCode;
    return result;
  }

  #setReady(revision, policies) {
    this.status = "ready";
    this.revision = revision;
    this.errorCode = undefined;
    this.policies = freezePolicies(policies);
  }

  #commitSnapshot(document) {
    this.#setReady(document.revision, document.policies);
  }

  #setBroken(code) {
    this.status = "broken";
    this.revision = null;
    this.errorCode = code;
    this.policies = Object.freeze([]);
  }

  async #load() {
    // A size check before reading keeps a corrupt/oversized file from being
    // pulled into memory; `stat` ENOENT is the documented empty-store path.
    let stats;
    try {
      stats = await this.io.stat(this.file);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.#setReady(0, []);
        return this.#readyResult();
      }
      this.#setBroken(ACCESS_POLICY_CODES.STORE_IO);
      return this.#readyResult();
    }
    if (stats && typeof stats.size === "number" && stats.size > ACCESS_POLICY_LIMITS.fileBytes) {
      this.#setBroken(ACCESS_POLICY_CODES.LIMIT_EXCEEDED);
      return this.#readyResult();
    }
    let text;
    try {
      text = await this.io.readFile(this.file, "utf8");
    } catch {
      this.#setBroken(ACCESS_POLICY_CODES.STORE_IO);
      return this.#readyResult();
    }
    const parsed = parseAccessPolicyDocument(text);
    if (!parsed.ok) {
      this.#setBroken(parsed.code);
      return this.#readyResult();
    }
    this.#setReady(parsed.document.revision, parsed.document.policies);
    return this.#readyResult();
  }

  // Validate a candidate document. Returns `{ ok:true, document }` or
  // `{ ok:false, code }` for a data error; an unexpected exception propagates.
  #candidate(revision, policies) {
    try {
      return {
        ok: true,
        document: validateAccessPolicyDocument({
          schemaVersion: ACCESS_POLICY_SCHEMA_VERSION,
          revision,
          policies,
        }),
      };
    } catch (error) {
      if (isAccessPolicyError(error)) return { ok: false, code: error.code };
      throw error;
    }
  }

  async #commit(expectedRevision, buildPolicies) {
    if (this.status !== "ready" || expectedRevision !== this.revision) {
      return this.#failure(ACCESS_POLICY_CODES.STALE_REVISION);
    }
    // A mutation callback that throws is a caller programming error and rejects
    // the returned promise; an invalid candidate is a data error and comes back
    // as `{ ok:false, code }`. Either way committed memory and the file are
    // untouched until the durable write below succeeds.
    const candidate = this.#candidate(this.revision + 1, buildPolicies());
    if (!candidate.ok) return this.#failure(candidate.code);
    try {
      await this.#persist(candidate.document);
    } catch {
      return this.#failure(ACCESS_POLICY_CODES.STORE_IO);
    }
    this.#commitSnapshot(candidate.document);
    return { ok: true, revision: candidate.document.revision };
  }

  async #persist(document) {
    const payload = serializeAccessPolicyDocument(document);
    const directory = path.dirname(this.file);
    const temporary = path.join(directory, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
    try {
      await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.io.writeFile(temporary, payload, { mode: 0o600 });
      await this.io.rename(temporary, this.file);
    } catch (error) {
      try {
        await this.io.unlink(temporary);
      } catch { /* best-effort temp cleanup */ }
      throw error;
    }
  }

  #enqueue(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => {}, () => {});
    return run;
  }
}

export function createAccessPolicyStore(options = {}) {
  return new AccessPolicyStore(options);
}
