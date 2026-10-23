// Hot Routes Phase 1-A — isolated, snapshot-derived cache primitive.
//
// Not wired into any runtime path. It provides a narrow, hermetic cache for
// pure derivations of ONE published vault snapshot. It performs no filesystem,
// network, auth/session, or vault-index access; freshness is supplied by the
// caller as a synchronous, zero-I/O `readFreshness()` probe (Phase 0-B
// `getVaultIndexStats()` shape).
//
// Guarantees (only these): for a caller-supplied snapshot still `clean` with an
// unchanged publication identity and satisfied coverage, a repeated pure
// derivation may be reused; plus TTL, LRU count/byte capacity, singleflight
// coalescing, epoch invalidation, and caller mutation isolation. Not guaranteed:
// out-of-band filesystem freshness; automatic invalidation on notes/files/
// skills/git-pull/journal paths; process-wide "zero stale"; any production
// TTL/capacity/hit-rate value; caching of auth/session views. The key and every
// entry retain only SHA-256 digests of caller args and of the snapshot token —
// never raw args, raw query/body, note paths, or skipped data.
import { createHash } from "node:crypto";

const NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAMESPACE_LENGTH = 64;
const KEY_SEPARATOR = "\u0000";

// Structural denylist: rejected at construction so secrets / raw request
// material can never reach a cache key, entry, or metric.
const DENIED_ARG_KEYS = new Set([
  "auth", "authorization", "cookie", "cookies", "token", "tokens", "session", "sessions",
  "rawquery", "query", "rawbody", "body", "password", "passwords", "credential", "credentials",
  "apikey", "secret", "secrets", "bearer", "csrf", "jwt", "setcookie", "headers",
]);

const BYPASS_REASONS = new Set([
  "cold", "dirty", "freshness-error", "generation-mismatch", "publication-mismatch",
  "include-hidden-mismatch", "coverage-mismatch", "coverage-requirement", "invalidated",
]);

function cacheError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonNegativeInteger(value) { return isFiniteInteger(value) && value >= 0; }

function isPositiveInteger(value) { return isFiniteInteger(value) && value > 0; }

function isNonNegativeNumber(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

function sha256(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }

function isDeniedArgKey(key) {
  return DENIED_ARG_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}
// Injective structured encoding: a sorted JSON tuple list with explicit scalar
// /array type tags, so separator-shaped keys and distinct JSON types never alias.
function encodeScalar(value) {
  if (value === null) return ["z", null];
  const type = typeof value;
  if (type === "string") return ["s", value];
  if (type === "boolean") return ["b", value];
  if (type === "number") {
    if (!Number.isFinite(value)) throw cacheError("HOT_ROUTE_CACHE_ARGS", "canonicalArgs numbers must be finite");
    return ["n", value];
  }
  throw cacheError("HOT_ROUTE_CACHE_ARGS", `canonicalArgs value of type ${type} is not a JSON scalar`);
}
function encodeArgValue(key, value) {
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (item !== null && typeof item === "object") {
        throw cacheError("HOT_ROUTE_CACHE_ARGS", "canonicalArgs arrays may contain scalars only");
      }
      return encodeScalar(item);
    });
    return [key, "a", parts];
  }
  if (value !== null && typeof value === "object") {
    throw cacheError("HOT_ROUTE_CACHE_ARGS", "canonicalArgs accepts JSON scalars and scalar arrays only");
  }
  return [key, "v", encodeScalar(value)];
}
// Validate and canonicalize a namespace declaration at construction time.
function normalizeNamespaceConfig(name, raw) {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAMESPACE_LENGTH || !NAMESPACE_PATTERN.test(name)) {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", `invalid namespace name: ${String(name)}`);
  }
  if (!isPlainObject(raw)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} must be an object`);
  const allowedKeys = raw.allowedArgKeys;
  if (!Array.isArray(allowedKeys) || allowedKeys.length === 0) {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} requires a non-empty allowedArgKeys list`);
  }
  const allowedArgKeys = new Set();
  for (const key of allowedKeys) {
    if (typeof key !== "string" || key.length === 0) {
      throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} has a non-string argument key`);
    }
    if (isDeniedArgKey(key)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} may not accept denied key "${key}"`);
    if (allowedArgKeys.has(key)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} repeats argument key "${key}"`);
    allowedArgKeys.add(key);
  }
  const rawRequired = raw.requiredArgKeys ?? [];
  if (!Array.isArray(rawRequired)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} requiredArgKeys must be an array`);
  const requiredArgKeys = [];
  for (const key of rawRequired) {
    if (typeof key !== "string" || !allowedArgKeys.has(key)) {
      throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} required key "${String(key)}" is not allowed`);
    }
    if (!requiredArgKeys.includes(key)) requiredArgKeys.push(key);
  }
  if (raw.requireComplete !== undefined && typeof raw.requireComplete !== "boolean") {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} requireComplete must be a boolean`);
  }
  let coverage = raw.coverage ?? "any";
  if (coverage !== "any" && coverage !== "complete") {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} coverage must be "any" or "complete"`);
  }
  if (raw.requireComplete === true) coverage = "complete";
  const knownFields = new Set(["allowedArgKeys", "requiredArgKeys", "coverage", "requireComplete", "maxCanonicalBytes"]);
  for (const field of Object.keys(raw)) {
    if (!knownFields.has(field)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} has unknown schema field "${field}"`);
  }
  if (!isPositiveInteger(raw.maxCanonicalBytes)) {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", `namespace ${name} requires a positive integer maxCanonicalBytes`);
  }
  return { name, allowedArgKeys, requiredArgKeys, requireComplete: coverage === "complete", maxCanonicalBytes: raw.maxCanonicalBytes };
}
function normalizeCanonicalArgs(namespaceConfig, canonicalArgs) {
  const args = canonicalArgs === undefined ? {} : canonicalArgs;
  if (!isPlainObject(args)) throw cacheError("HOT_ROUTE_CACHE_ARGS", "canonicalArgs must be a plain object");
  const keys = Object.keys(args).sort();
  for (const key of keys) {
    if (isDeniedArgKey(key)) throw cacheError("HOT_ROUTE_CACHE_ARGS", `canonicalArgs key "${key}" is structurally denied`);
    if (!namespaceConfig.allowedArgKeys.has(key)) {
      throw cacheError("HOT_ROUTE_CACHE_ARGS", `canonicalArgs key "${key}" is not allowed for namespace ${namespaceConfig.name}`);
    }
  }
  for (const required of namespaceConfig.requiredArgKeys) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw cacheError("HOT_ROUTE_CACHE_ARGS", `canonicalArgs is missing required key "${required}"`);
    }
  }
  const encoded = JSON.stringify(keys.map((key) => encodeArgValue(key, args[key])));
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > namespaceConfig.maxCanonicalBytes) {
    throw cacheError("HOT_ROUTE_CACHE_ARGS", `canonicalArgs exceeds maxCanonicalBytes (${bytes} > ${namespaceConfig.maxCanonicalBytes})`);
  }
  return { digest: sha256(encoded) };
}
// Snapshot identity. Only digests are retained; raw stats never are.
function normalizeSourceStats(sourceStats) {
  if (!isPlainObject(sourceStats)) throw cacheError("HOT_ROUTE_CACHE_SOURCE", "sourceStats must be a plain object");
  if (!isNonNegativeInteger(sourceStats.publicationRevision)) {
    throw cacheError("HOT_ROUTE_CACHE_SOURCE", "sourceStats.publicationRevision must be a non-negative integer");
  }
  if (!isNonNegativeInteger(sourceStats.snapshotGeneration)) {
    throw cacheError("HOT_ROUTE_CACHE_SOURCE", "sourceStats.snapshotGeneration must be a non-negative integer");
  }
  let includeHidden;
  if (typeof sourceStats.includeHidden === "boolean") includeHidden = sourceStats.includeHidden;
  else if (isPlainObject(sourceStats.coverage) && typeof sourceStats.coverage.includeHidden === "boolean") includeHidden = sourceStats.coverage.includeHidden;
  if (includeHidden === undefined) throw cacheError("HOT_ROUTE_CACHE_SOURCE", "sourceStats.includeHidden must be a boolean");
  const coverage = sourceStats.coverage;
  if (!isPlainObject(coverage) || (coverage.completeness !== "complete" && coverage.completeness !== "partial")) {
    throw cacheError("HOT_ROUTE_CACHE_SOURCE", "sourceStats.coverage.completeness must be \"complete\" or \"partial\"");
  }
  if (!isNonNegativeInteger(coverage.skipped)) {
    throw cacheError("HOT_ROUTE_CACHE_SOURCE", "sourceStats.coverage.skipped must be a non-negative integer");
  }
  const skippedDigest = sha256(String(coverage.skipped));
  const tokenPayload = [
    `pub:${sourceStats.publicationRevision}`,
    `gen:${sourceStats.snapshotGeneration}`,
    `hidden:${includeHidden ? 1 : 0}`,
    `cov:${coverage.completeness}`,
    `skip:${skippedDigest}`,
  ].join("|");
  return {
    publicationRevision: sourceStats.publicationRevision,
    snapshotGeneration: sourceStats.snapshotGeneration,
    includeHidden,
    coverageCompleteness: coverage.completeness,
    coverageSkippedDigest: skippedDigest,
    tokenDigest: sha256(tokenPayload),
  };
}

// JSON-like structured-cloneable values only. Functions, Map/Set, class
// instances, BigInt, Symbol, undefined and cycles are explicitly unsupported.
function cloneJsonLike(value, seen) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) throw cacheError("HOT_ROUTE_CACHE_VALUE", "computed numbers must be finite");
    return value;
  }
  if (type === "object") {
    if (seen.has(value)) throw cacheError("HOT_ROUTE_CACHE_VALUE", "computed value contains a cycle");
    seen.add(value);
    let output;
    if (Array.isArray(value)) output = value.map((item) => cloneJsonLike(item, seen));
    else if (isPlainObject(value)) {
      output = {};
      // Own `__proto__`/`constructor` become data properties, never setters.
      for (const key of Object.keys(value)) {
        Object.defineProperty(output, key, { value: cloneJsonLike(value[key], seen), writable: true, enumerable: true, configurable: true });
      }
    } else throw cacheError("HOT_ROUTE_CACHE_VALUE", "computed value must be JSON-like");
    seen.delete(value);
    return output;
  }
  throw cacheError("HOT_ROUTE_CACHE_VALUE", `computed value of type ${type} is unsupported`);
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function createHotRouteCache(options = {}) {
  if (!isPlainObject(options)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", "createHotRouteCache options must be an object");
  const { namespaces, ttlMs, maxEntries, maxApproxBytes, readFreshness } = options;
  const now = options.now ?? Date.now;
  if (!isPlainObject(namespaces)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", "namespaces must be a plain object");
  if (!isNonNegativeNumber(ttlMs)) {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", "ttlMs must be explicitly provided as a non-negative finite number");
  }
  if (!isPositiveInteger(maxEntries)) {
    throw cacheError("HOT_ROUTE_CACHE_CONFIG", "maxEntries must be explicitly provided as a positive integer");
  }
  let byteCap = null;
  if (maxApproxBytes !== undefined) {
    if (!isPositiveInteger(maxApproxBytes)) throw cacheError("HOT_ROUTE_CACHE_CONFIG", "maxApproxBytes must be a positive integer when provided");
    byteCap = maxApproxBytes;
  }
  if (typeof now !== "function") throw cacheError("HOT_ROUTE_CACHE_CONFIG", "now must be a function");
  if (typeof readFreshness !== "function") throw cacheError("HOT_ROUTE_CACHE_CONFIG", "readFreshness must be a synchronous function");

  const namespaceConfigs = new Map();
  for (const [name, raw] of Object.entries(namespaces)) namespaceConfigs.set(name, normalizeNamespaceConfig(name, raw));

  let globalEpoch = 0;
  const namespaceEpochs = new Map();
  const entries = new Map(); // key -> { key, expiresAt, value, bytes }
  const inflight = new Map(); // key -> { captured, settled, promise }
  let approxBytes = 0;
  const counters = { hit: 0, miss: 0, computed: 0, coalesced: 0, bypass: 0, reject: 0, expired: 0, evicted: 0, oversize: 0 };
  const bypassByReason = Object.create(null);

  function recordBypass(reason) {
    if (!BYPASS_REASONS.has(reason)) reason = "freshness-error";
    counters.bypass += 1;
    bypassByReason[reason] = (bypassByReason[reason] ?? 0) + 1;
    return { status: "bypass", reason };
  }

  function currentTime() {
    const value = now();
    if (!isNonNegativeNumber(value)) throw cacheError("HOT_ROUTE_CACHE_CLOCK", "now() must return a finite non-negative number");
    return value;
  }

  // Fail-closed freshness read: a throwing or malformed provider yields a
  // bypass reason and never a stale value.
  function readFreshnessState() {
    let snapshot;
    try {
      snapshot = readFreshness();
    } catch {
      return { ok: false, reason: "freshness-error" };
    }
    if (!isPlainObject(snapshot) || typeof snapshot.freshness !== "string") return { ok: false, reason: "freshness-error" };
    if (snapshot.freshness !== "clean") {
      if (snapshot.freshness === "cold") return { ok: false, reason: "cold" };
      if (snapshot.freshness === "dirty") return { ok: false, reason: "dirty" };
      return { ok: false, reason: "freshness-error" };
    }
    if (!isNonNegativeInteger(snapshot.vaultGeneration) || !isNonNegativeInteger(snapshot.publicationRevision)) {
      return { ok: false, reason: "freshness-error" };
    }
    let includeHidden;
    if (typeof snapshot.includeHidden === "boolean") includeHidden = snapshot.includeHidden;
    else if (isPlainObject(snapshot.coverage) && typeof snapshot.coverage.includeHidden === "boolean") includeHidden = snapshot.coverage.includeHidden;
    if (includeHidden === undefined || !isPlainObject(snapshot.coverage)) return { ok: false, reason: "freshness-error" };
    const { completeness, skipped } = snapshot.coverage;
    if ((completeness !== "complete" && completeness !== "partial") || !isNonNegativeInteger(skipped)) {
      return { ok: false, reason: "freshness-error" };
    }
    return {
      ok: true,
      state: {
        vaultGeneration: snapshot.vaultGeneration,
        publicationRevision: snapshot.publicationRevision,
        includeHidden,
        completeness,
        skippedDigest: sha256(String(skipped)),
      },
    };
  }

  function evaluateFence(namespaceConfig, source, captured) {
    const current = readFreshnessState();
    if (!current.ok) return current;
    const state = current.state;
    if (state.vaultGeneration !== source.snapshotGeneration) return { ok: false, reason: "generation-mismatch" };
    if (state.publicationRevision !== source.publicationRevision) return { ok: false, reason: "publication-mismatch" };
    if (state.includeHidden !== source.includeHidden) return { ok: false, reason: "include-hidden-mismatch" };
    if (state.completeness !== source.coverageCompleteness || state.skippedDigest !== source.coverageSkippedDigest) {
      return { ok: false, reason: "coverage-mismatch" };
    }
    if (namespaceConfig.requireComplete && source.coverageCompleteness !== "complete") {
      return { ok: false, reason: "coverage-requirement" };
    }
    if (captured) {
      if (globalEpoch !== captured.global) return { ok: false, reason: "invalidated" };
      if ((namespaceEpochs.get(namespaceConfig.name) ?? 0) !== captured.namespace) return { ok: false, reason: "invalidated" };
    }
    return { ok: true };
  }

  function evictOldest() {
    const oldestKey = entries.keys().next().value;
    const entry = entries.get(oldestKey);
    entries.delete(oldestKey);
    approxBytes -= entry.bytes;
    counters.evicted += 1;
  }

  function storeEntry(key, owned, bytes, commitNow) {
    if (ttlMs === 0) return; // ttl 0: compute and return, never retain.
    if (byteCap !== null && bytes > byteCap) {
      counters.oversize += 1;
      return;
    }
    const existing = entries.get(key);
    if (existing) {
      approxBytes -= existing.bytes;
      entries.delete(key);
    }
    entries.set(key, { key, expiresAt: commitNow + ttlMs, value: owned, bytes });
    approxBytes += bytes;
    while (entries.size > maxEntries) evictOldest();
    if (byteCap !== null) while (approxBytes > byteCap && entries.size > 0) evictOldest();
  }

  function createSlot(key, namespaceConfig, source, captured, compute) {
    const slot = { captured, settled: false, promise: null };
    slot.promise = (async () => {
      let raw;
      try {
        raw = await compute();
      } catch (error) {
        counters.reject += 1;
        return { kind: "rejected", error };
      }
      // Group post-compute fence. A failure here is sticky: once the source
      // identity changed mid-compute, no caller may receive the value.
      const fence = evaluateFence(namespaceConfig, source, captured);
      if (!fence.ok) return { kind: "stale", reason: fence.reason };
      let owned;
      let cacheable;
      let bytes = 0;
      try {
        if (raw === null || raw === undefined) {
          owned = raw;
          cacheable = false; // returned but never retained (no negative cache).
        } else {
          owned = deepFreeze(cloneJsonLike(raw, new Set()));
          cacheable = true;
          bytes = Buffer.byteLength(JSON.stringify(owned), "utf8");
        }
        if (cacheable) storeEntry(key, owned, bytes, currentTime());
      } catch (error) {
        counters.reject += 1;
        return { kind: "rejected", error };
      }
      counters.computed += 1;
      return { kind: "ready", owned, cacheable };
    })();
    const cleanup = () => {
      slot.settled = true;
      if (inflight.get(key) === slot) inflight.delete(key);
    };
    slot.promise.then(cleanup, cleanup);
    return slot;
  }

  async function getOrCompute(input) {
    if (!isPlainObject(input)) throw cacheError("HOT_ROUTE_CACHE_ARGS", "getOrCompute input must be an object");
    const namespaceConfig = namespaceConfigs.get(input.namespace);
    if (!namespaceConfig) throw cacheError("HOT_ROUTE_CACHE_NAMESPACE", `unknown namespace: ${String(input.namespace)}`);
    if (typeof input.compute !== "function") throw cacheError("HOT_ROUTE_CACHE_ARGS", "compute must be a function");
    const source = normalizeSourceStats(input.sourceStats);
    const args = normalizeCanonicalArgs(namespaceConfig, input.canonicalArgs);
    const key = `${namespaceConfig.name}${KEY_SEPARATOR}${args.digest}${KEY_SEPARATOR}${source.tokenDigest}`;
    const compute = input.compute;

    // One microtask yield so a synchronous invalidate()/clear() issued by the
    // caller immediately after this promise is returned is observed before any
    // fence decision or returned value.
    await Promise.resolve();

    const captured = { global: globalEpoch, namespace: namespaceEpochs.get(namespaceConfig.name) ?? 0 };
    const preFence = evaluateFence(namespaceConfig, source, captured);
    if (!preFence.ok) return recordBypass(preFence.reason);

    const entry = entries.get(key);
    if (entry) {
      if (currentTime() >= entry.expiresAt) {
        // Equal-to-expiry is expired; discovered expiry removes the entry.
        entries.delete(key);
        approxBytes -= entry.bytes;
        counters.expired += 1;
      } else {
        // Recheck the fence immediately before resolving this individual hit.
        const hitFence = evaluateFence(namespaceConfig, source, captured);
        if (!hitFence.ok) return recordBypass(hitFence.reason);
        entries.delete(key);
        entries.set(key, entry); // LRU: successful hit becomes MRU.
        counters.hit += 1;
        return { status: "hit", value: cloneJsonLike(entry.value, new Set()) };
      }
    }

    let slot = inflight.get(key);
    if (slot && slot.settled) {
      inflight.delete(key); // recovery: a settled slot whose cleanup did not run must not wedge.
      slot = undefined;
    }
    if (slot) {
      counters.coalesced += 1;
    } else {
      counters.miss += 1;
      slot = createSlot(key, namespaceConfig, source, captured, compute);
      inflight.set(key, slot);
    }

    const outcome = await slot.promise;
    if (outcome.kind === "rejected") throw outcome.error;
    if (outcome.kind === "stale") return recordBypass(outcome.reason);
    // Individual fence for the leader and every waiter, using the slot's
    // captured epochs so an invalidate during/after compute bypasses all.
    const settleFence = evaluateFence(namespaceConfig, source, slot.captured);
    if (!settleFence.ok) return recordBypass(settleFence.reason);
    return { status: "computed", value: outcome.cacheable ? cloneJsonLike(outcome.owned, new Set()) : outcome.owned };
  }

  function invalidate(namespace) {
    if (!namespaceConfigs.has(namespace)) throw cacheError("HOT_ROUTE_CACHE_NAMESPACE", `unknown namespace: ${String(namespace)}`);
    namespaceEpochs.set(namespace, (namespaceEpochs.get(namespace) ?? 0) + 1);
    const prefix = `${namespace}${KEY_SEPARATOR}`;
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = entries.get(key);
        entries.delete(key);
        approxBytes -= entry.bytes;
      }
    }
  }

  function clear() {
    globalEpoch += 1;
    entries.clear();
    approxBytes = 0;
  }

  function stats() {
    return {
      hit: counters.hit,
      miss: counters.miss,
      computed: counters.computed,
      coalesced: counters.coalesced,
      bypass: counters.bypass,
      reject: counters.reject,
      expired: counters.expired,
      evicted: counters.evicted,
      oversize: counters.oversize,
      currentEntries: entries.size,
      approxBytes,
      inflight: inflight.size,
      bypassByReason: { ...bypassByReason },
    };
  }

  return Object.freeze({ getOrCompute, invalidate, clear, stats });
}
