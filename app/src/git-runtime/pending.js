// Per-instance pending-batch model for the per-vault GitRuntime (Wave A / A6).
//
// Frozen semantics being preserved (W0-D §3, contract §16.4):
//  - `paths` is a Set of vault-relative normalized paths, so repeated writes to
//    one file dedupe;
//  - `authors` is a Map keyed `agent\0model`, kept in first-seen author order —
//    that order decides the order of the commits `flushNow()` emits;
//  - `since` is the **oldest** pending start, never the newest, and only a
//    restored (failed) batch may pull it further back;
//  - path containment is decided against this runtime's own root, never an
//    ambient vault (contract §16.1).
//
// The instance owns every mutable field: there is no module-level state.

import path from "node:path";
import { GIT_RUNTIME_CODES, GitRuntimeError } from "./support.js";

function bucketKey(author) {
  return `${author.agent}\u0000${author.model}`;
}

export class GitPendingBatches {
  #root;
  #paths = new Set();
  #authors = new Map();
  #since = null;

  constructor(root) {
    this.#root = path.resolve(root);
  }

  get root() {
    return this.#root;
  }

  get size() {
    return this.#paths.size;
  }

  get since() {
    return this.#since;
  }

  set since(instant) {
    this.#since = instant;
  }

  paths() {
    return [...this.#paths].sort();
  }

  authors() {
    return [...this.#authors.values()].map((bucket) => bucket.author);
  }

  batches() {
    return [...this.#authors.values()].map(({ author, paths }) => ({ author, paths: [...paths] }));
  }

  // W0-D §3 normalization, bound to this runtime's root.
  normalize(userPath) {
    const raw = String(userPath).replaceAll("\\", "/").replace(/\0/g, "").trim();
    const literal = raw.replace(/^\/+/, "");
    // A drive-letter prefix is absolute on Windows but a plain directory name on
    // POSIX, where the containment check below would accept it: the same vault
    // path must not be accepted on one platform and rejected on the other. It is
    // refused everywhere, before the posix normalization can rewrite the literal
    // the caller sent (RETURN-1; contract §42 SEC-MV01 root containment).
    if (/^[A-Za-z]:\//.test(literal)) {
      throw new GitRuntimeError(GIT_RUNTIME_CODES.INVALID_PATH, `Git path traversal denied: drive-letter path ${JSON.stringify(literal)} is never vault-relative`);
    }
    const normalized = path.posix.normalize(literal);
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      throw new GitRuntimeError(GIT_RUNTIME_CODES.INVALID_PATH, "Git path must identify a file or folder inside the vault");
    }
    const resolved = path.resolve(this.#root, normalized);
    const relative = path.relative(this.#root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new GitRuntimeError(GIT_RUNTIME_CODES.INVALID_PATH, "Git path traversal denied");
    }
    return normalized;
  }

  track(author, paths) {
    const key = bucketKey(author);
    const bucket = this.#authors.get(key) || { author, paths: new Set() };
    const added = [];
    for (const item of Array.isArray(paths) ? paths : [paths]) {
      if (!item) continue;
      const normalized = this.normalize(item);
      this.#paths.add(normalized);
      bucket.paths.add(normalized);
      added.push(normalized);
    }
    this.#authors.set(key, bucket);
    return added;
  }

  // Snapshots the entries covered by a commit scope and removes them, so a
  // later `track()` for the same path is a new batch the in-flight commit must
  // not touch. `scopes === null` covers (and consumes) every batch.
  take(scopes) {
    const normalized = scopes === null ? null : scopes.map((item) => this.normalize(item));
    const covers = (pending) => normalized === null
      || normalized.some((scope) => pending === scope || pending.startsWith(`${scope.replace(/\/$/, "")}/`));
    const detached = [];
    for (const [key, bucket] of this.#authors) {
      const taken = [...bucket.paths].filter(covers);
      if (taken.length === 0) continue;
      for (const item of taken) {
        bucket.paths.delete(item);
        this.#paths.delete(item);
      }
      detached.push({ author: bucket.author, paths: taken });
      if (bucket.paths.size === 0) this.#authors.delete(key);
    }
    return detached;
  }

  restore(batches, since) {
    if (!batches?.length) return;
    for (const batch of batches) {
      const key = bucketKey(batch.author);
      const bucket = this.#authors.get(key) || { author: batch.author, paths: new Set() };
      for (const item of batch.paths) {
        bucket.paths.add(item);
        this.#paths.add(item);
      }
      this.#authors.set(key, bucket);
    }
    // A restored (older) batch pulls the oldest-known start back so its deadline
    // is not dragged out.
    this.#since = earliestSince(this.#since, since);
  }

  clear() {
    this.#paths.clear();
    this.#authors.clear();
  }

  resetIfSettled() {
    if (this.#paths.size > 0) return false;
    this.#since = null;
    return true;
  }
}

export function earliestSince(current, incoming) {
  if (current === null || incoming === null) return current ?? incoming;
  const currentMs = Date.parse(current);
  const incomingMs = Date.parse(incoming);
  if (Number.isNaN(currentMs)) return incoming;
  if (Number.isNaN(incomingMs)) return current;
  return currentMs <= incomingMs ? current : incoming;
}
