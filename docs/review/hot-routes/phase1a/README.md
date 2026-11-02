# Hot Routes Phase 1-A — isolated snapshot-derived cache primitive

Status: **candidate** (branch evidence; not merged, not released, not deployed).
Base: `origin/main@eee33d477ca6989241b7ec9eaba855d2531c681c`
(tree `14462fe3c353a42242e7baab771997a2fae81518`).

Scope: one new internal primitive plus its hermetic tests, benchmark, and this
contract document. No runtime importer, barrel export, MCP tool, resource,
default enable, or real product namespace is added. `vault-index.js`, skills,
notes/files, mutation/journal, git hooks, bootstrap, Discovery, Context, query,
heat, exposure, Web, auth, and session files are untouched. This file list is
disjoint from the parallel Web session durability lane.

## 1. What this is

`app/src/hot-route-cache.js` is a narrow, in-process cache for **pure
derivations of one published vault snapshot**. It performs no filesystem,
network, auth/session, or vault-index access. Freshness is supplied by the
caller as a synchronous, zero-I/O `readFreshness()` probe shaped like Phase 0-B
`getVaultIndexStats()`:

```js
const cache = createHotRouteCache({
  namespaces,      // explicit synthetic allowlist; no product namespaces here
  ttlMs,           // required, explicit; no production default
  maxEntries,      // required, explicit positive integer
  maxApproxBytes,  // optional deterministic byte cap
  now,             // injectable clock (defaults to Date.now)
  readFreshness,   // required synchronous, zero-I/O probe
});

const result = await cache.getOrCompute({
  namespace,
  canonicalArgs,   // JSON scalars and scalar arrays only
  sourceStats,     // snapshot identity from vault-index stats
  compute,         // pure async derivation
});

cache.invalidate(namespace);
cache.clear();
cache.stats();
```

`getOrCompute` returns a discriminated result:

- `{ status: "hit", value }` — a fresh cache-owned value clone;
- `{ status: "computed", value }` — a freshly computed value clone;
- `{ status: "bypass", reason }` — no value; the caller must take the canonical
  (uncached) path. Bypass never carries a stale value.

## 2. Frozen contract

1. **Owned files only.** New primitive, test, benchmark, and this document.
2. **Snapshot-derived only.** No auth/session/user view, no raw
   request/query/body/token/cookie, no claim to observe out-of-band FS changes.
3. **Source token.** `publicationRevision + snapshotGeneration + includeHidden +
   coverage.completeness + sha256(coverage.skipped)`. The `skipped` payload is
   never stored — only its digest. This is deliberately conservative: every real
   publication bumps `publicationRevision`, so old entries miss even when the
   records are identical.
4. **Generation source.** `snapshotGeneration` is taken from the passed
   `sourceStats` (the generation Phase 0-B captured before enumeration and
   published). It is never re-read from current state to fake a snapshot
   identity. `readFreshness()` only answers "is this snapshot still usable now".
5. **pre/post fence.** Before compute: `freshness === clean`, current
   `vaultGeneration === snapshotGeneration`, current `publicationRevision`
   matches, `includeHidden` matches, coverage matches, and the namespace
   coverage requirement is met. After `await compute()` the same fence is
   re-evaluated together with the captured global/namespace epochs. Only a fully
   passing post-fence stores a value; every leader and waiter re-evaluates the
   fence immediately before resolving its own result, including on hits.
6. **Narrow internal API.** Factory + `getOrCompute`/`invalidate`/`clear`/`stats`
   as above. `bypass` never carries a value.
7. **Namespace / canonical args.** `namespaces` is an explicit construction-time
   allowlist; an unknown namespace rejects. Each namespace declares
   `allowedArgKeys`, optional `requiredArgKeys`, optional `coverage` /
   `requireComplete`, and `maxCanonicalBytes`. Only JSON scalars and scalar
   arrays are accepted; unknown keys and nested objects reject. Keys are sorted
   and encoded as an injective JSON tuple list with explicit scalar/array type
   tags, so separator-shaped keys and different JSON types cannot collide in the
   pre-hash payload; only a SHA-256 digest enters the key. No real product
   namespace is defined here.
8. **Secret boundary.** `auth`, `authorization`, `cookie`, `token`, `session`,
   raw query/body and similar names are structurally denied at construction and
   at call time. Keys, entries, and metrics retain no raw args, no note paths,
   and no skipped-path payloads.
9. **TTL.** `ttlMs` is explicit with no default. `expiresAt = commitNow +
   ttlMs`; a hit requires `now() < expiresAt`, so `now() === expiresAt` is
   expired. `ttlMs === 0` computes and returns without retaining.
10. **LRU / capacity.** `maxEntries` is an explicit positive integer. A hit
    refreshes recency; a commit becomes MRU; a discovered expired entry is
    removed. `maxApproxBytes`, when provided, uses deterministic serialized byte
    length and evicts by LRU. An oversize value is returned to the caller but
    not stored, and counts as `oversize`.
11. **Singleflight.** Key identity is `namespace + canonicalArgsDigest +
    sourceTokenDigest`. One compute per key; waiters are counted as `coalesced`.
    A mid-compute source/publication/identity change or invalidation bypasses
    every waiter.
12. **Reject / failure cleanup.** A throwing `compute` is never negative-cached
    and never creates an entry. The singleflight slot is cleared in `finally`
    style, so the next call can recompute, and all waiters share the same
    rejection. `null`/`undefined` are returned but never retained.
13. **Epoch fence.** A `globalEpoch` plus per-namespace epochs. `clear()` bumps
    the global epoch and drops all entries; `invalidate(ns)` bumps that
    namespace epoch and drops its entries. Leaders capture both at compute
    start; a mismatch at the final fence blocks store and return, so an
    in-flight compute cannot resurrect an invalidated entry.
14. **Mutation isolation.** Values are JSON-like structured-cloneable data only.
    The cache keeps one deep-frozen owned copy; every caller (first `computed`,
    every `hit`, every coalesced waiter) receives an independent clone. Own
    `__proto__`/`constructor` keys are cloned as safe own data properties
    (`Object.defineProperty`), so a `JSON.parse` object round-trips without
    mutating the clone prototype. Functions, Map/Set, class instances, BigInt,
    Symbol, `undefined`, and cycles are unsupported. `createLinkResolver(records)`
    is intentionally not wired here.
15. **Metrics.** Anonymous counters/gauges only: `hit`, `miss`, `computed`,
    `coalesced`, `bypass`, `reject`, `expired`, `evicted`, `oversize`,
    `currentEntries`, `approxBytes`, `inflight`, `bypassByReason`. No key
    detail, paths, args, auth, or skipped payloads.
16. **Deterministic acceptance.** `app/test/hot-route-cache.test.js` covers TTL
    before/at expiry, LRU recency and count/byte eviction, oversize, canonical
    key order, unknown/oversize/illegal args, singleflight, publication
    non-coalescing, rejection cleanup and retry, `clear`/`invalidate` during
    compute, dirty/cold bypass, coverage-requirement admission, the
    `rev10/rev11/rev12` ABA case, publication-only changes, caller isolation,
    individual leader/waiter fencing, source mutation while awaiting, and
    `null`/`undefined` non-retention. All races use a fake clock and explicit
    entered/release barriers — never sleeps.
17. **Benchmark.** `app/scripts/hot-route-cache-benchmark.mjs` runs the real
    primitive against a deterministic synthetic derivation and asserts every
    cached round deep-equals the uncached baseline before reporting timings. It
    sets no performance gate and makes no production TTL/capacity/hit-rate
    claim. CPU and RSS are labelled only because they are measured; filesystem
    calls are explicitly `measured: false`.
18. **Non-guarantees.** This primitive cannot observe out-of-band filesystem
    changes, cannot invalidate on notes/files/skills/git-pull/journal paths, and
    provides no end-to-end "zero stale" guarantee, no production TTL/capacity/
    hit-rate, and no auth/session caching.

## 3. Reproduce

From `app/`:

```sh
npm ci
npm run check
npm test
node --test test/hot-route-cache.test.js
node scripts/hot-route-cache-benchmark.mjs                 # JSON to stdout
node scripts/hot-route-cache-benchmark.mjs --out /tmp/hot-route-bench.json
```

The benchmark reads no vault and contacts no network. `HOT_ROUTE_BENCH_ROUNDS`
and `HOT_ROUTE_BENCH_RECORDS` shrink the fixture for a quick check.

## 4. Next

Wiring a real snapshot-derived caller, its coverage contract, and its
invalidation gaps is a separate review. Phase 1-A does not enable, expose, or
import the primitive anywhere.
