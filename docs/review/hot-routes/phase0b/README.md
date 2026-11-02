# Hot Routes Phase 0-B — vault-index generation / freshness

Status: **candidate** (branch evidence; not merged, not released, not deployed).
Base: `cd67371ff36cdc840abb95168b675a17050b46ed` (Phase 0-A merged).
Scope: `app/src/vault-index.js` plus focused tests and this document. No
cross-module write hooks, no retrieval changes, no resolver/route cache feature,
no exposure/resource/tool/bootstrap/heat/query-cache change, and no
Web/Context/Discovery wiring. Existing resolver behavior is unchanged.

## What this slice adds

`vault-index.js` now keeps process-local build/freshness bookkeeping:

| state | meaning |
| --- | --- |
| `vaultGeneration` | logical Vault generation and build fence token; resets to `0` on restart |
| `publicationRevision` | count of successful atomic publications; resets to `0` on restart |
| `snapshotGeneration` | the `vaultGeneration` the published snapshot was built against, else `null` |
| `snapshotIdentity` | declared coverage identity (`{ includeHidden }`) of the published snapshot, else `null` |

Freshness is always derived, never separately tracked:

```text
cold  := no published snapshot (indexBuilt === false)
clean := snapshotGeneration === vaultGeneration
dirty := a snapshot exists but snapshotGeneration !== vaultGeneration
```

Neither counter is persisted or comparable across processes; content hashes
(`record.revision`) are unchanged and remain the deterministic content
representation this slice compares.

## Frozen behavior

- Every actual `getVaultIndex()` call still enumerates/stats/reads the Vault.
  There is **no** clean fast-path, TTL, or zero-I/O cache hit. `force` and
  `pathPrefix` cannot open a second build lane.
- The whole build runs under one rejection-safe promise-tail mutex. The tail
  always settles, so a rejected build cannot poison the queue.
- The fence token is captured **before** enumeration. All parsing writes only to
  a local `nextCache`/stats. After the last `await`, the generation is rechecked
  synchronously and the snapshot is published with **no further await**.
- A conflict discards the whole attempt and retries once (`2` attempts total).
  Exhaustion throws `error.code === "VAULT_INDEX_FENCE_CONFLICT"` with no
  publish and no old-success return. The queue stays usable afterwards.
- Successful publication increments `publicationRevision` exactly once per call
  (even when records are unchanged) and sets
  `snapshotGeneration = vaultGeneration`.
- A non-empty `invalidateVaultIndex(paths)` — including unknown paths — bumps
  `vaultGeneration` once per call before returning and leaves the snapshot
  published but dirty. `invalidateVaultIndex([])` is an index no-op that still
  keeps the existing retrieval-refresh scheduling side effect.
- Full/invalid `invalidateVaultIndex()` bumps once, clears the cache, sets
  `indexBuilt = false`, and resets `snapshotGeneration`/`snapshotIdentity` to
  `null` (cold).
- A clean, same-identity rebuild whose observed paths/revisions changed treats
  it as an externally observed content change: `vaultGeneration` is bumped once,
  atomically with publication. A dirty rebuild does not add another
  content-change bump, and a different `includeHidden` identity is not a content
  change.
- A refresh failure (including fence exhaustion) keeps the previous
  records/counters/`lastRefresh`/`publicationRevision`. It marks the old
  snapshot dirty by bumping only when it was clean; a cold index stays cold. No
  half-built cache is ever published.

## Additive stats

`getVaultIndex()`, `getCachedVaultIndex()`, and `getVaultIndexStats()` add:

```text
vaultGeneration
snapshotGeneration
publicationRevision
freshness: "cold" | "dirty" | "clean"
coverage: null | { includeHidden, completeness: "complete" | "partial", skipped }
```

Cold snapshots report `coverage: null`. `skipped > 0` is **clean + partial**, not
dirty. `includeHidden: false` can still be `complete`. Existing count/timing
fields (`files`, `reparsed`, `reused`, `removed`, `skipped`, `durationMs`,
`lastRefresh`, `cachedNotes`) keep describing the most recent successful
publication; freshness fields are synthesized at read time.

`getCachedVaultIndex()` keeps its exact return shape: `null` or
`{ records, resolveLink, stats }` (never a `Map`). Its only caller,
`context-service.js`, uses it as a revision map and is unchanged. When dirty it
still returns the internal cached view with honest `freshness: "dirty"`; it is
not a canonical fresh index.

## Guarantees and limits

This slice guarantees that in-process invalidations cannot be overwritten by an
in-flight build, that serialized builds cannot late-publish over a newer one,
that publication is atomic, that no-change refreshes do not change
`vaultGeneration`, and that coverage/skip is distinguished from dirtiness.

It does **not** claim: all MCP mutation paths call invalidate; retrieval,
resolver or route caches share this freshness; hidden/non-hidden is an
authorization boundary; partial coverage is the full canonical Vault; generation
survives restart or crosses processes; or that filesystem writes landing during
a build are fully fenced (this is an observed-refresh guarantee, not filesystem
snapshot isolation).

## Tests

`app/test/hot-routes-vault-index-generation.test.js` is the focused
deterministic suite (explicit entered/release barriers, no timing assumptions,
no deadlocked serialized second build). It covers the read and enumeration
invalidation races, late-old-publication prevention, two fence-conflict
exhaustion and queue recovery, full invalidation during a build, unknown path
vs `[]`, no-change force/ordinary refreshes, observed external changes with the
same identity, `includeHidden` identity switches and concurrent callers,
`pathPrefix` projections and real publication counts, oversized skip / size race
/ shrink, failure atomicity and dirty marking, context-service compatibility, and
canonical stats fields.

Reproduce from `app/`:

```sh
node --test test/hot-routes-vault-index-generation.test.js
node --test test/hot-routes-vault-index-characterization.test.js test/vault-index-refresh-atomicity.test.js test/hot-routes-mutation-invalidation-map.test.js
npm run check
```
