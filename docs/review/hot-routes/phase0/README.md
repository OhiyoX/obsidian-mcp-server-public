# Hot Routes Phase 0-A — characterization evidence

Status: **candidate** (branch evidence; not merged, not released, not deployed).
Base: `origin/main@2d25d899cceedc76b41d894f4bf2edff68480572`.
Scope: tests / scripts / docs only. No `app/src` or `app/server.js` runtime edit.
No cache, generation, public route, heat, Discovery, or `agent_bootstrap` change.

## 1. Reproduce

From `app/`:

```sh
npm ci
npm run check
npm test
```

Focused evidence:

```sh
node --test test/hot-routes-vault-index-characterization.test.js
node --test test/hot-routes-mutation-invalidation-map.test.js
node --test test/hot-routes-resource-auth-probe.test.js
node scripts/hot-routes-phase0-benchmark.mjs            # writes the tracked artifact
node scripts/hot-routes-phase0-benchmark.mjs --out /tmp/bench.json   # reproduce without dirtying tracked evidence
```

The benchmark writes
`docs/review/hot-routes/phase0/benchmark-results.json` from a synthetic scratch
vault (use `--out <path>` to write elsewhere). Environment in this run: Node `v22.18.0` on
Linux (WSL Ubuntu, matching the CI Node 22 target),
`@modelcontextprotocol/sdk@1.30.0` pinned by `app/package-lock.json`. No live
Vault content or credentials are used.

The Windows default Node 26 run of the full suite had three environment-only
failures (two `fs.symlink` EPERM tests that require Windows Developer Mode, and
Node-24 child-spawn timing in the 100 ms CI-gate harness). The same suite was
rerun on Linux Node 22 with `0` failures (752 tests), which is the recorded
CI-equivalent baseline; no test was skipped or weakened.

## 2. Evidence group 1 — `getCachedVaultIndex` behavior

Test: `app/test/hot-routes-vault-index-characterization.test.js`.

Observed on the pinned base:

- **cold**: before any successful build, `getCachedVaultIndex()` returns `null`
  (`indexBuilt === false`).
- **successful refresh**: `getVaultIndex()` publishes the complete snapshot;
  `getCachedVaultIndex()` returns it with `stats.cached: true` and performs **no
  Vault IO** (proved by renaming the scratch vault root away and still reading
  the same records).
- **path invalidation**: `invalidateVaultIndex("…")` deletes one record but
  leaves `indexBuilt === true`; `getCachedVaultIndex()` returns a **partially
  complete** snapshot that still reports `cached: true`.
- **full invalidation**: `invalidateVaultIndex()` clears the cache and sets
  `indexBuilt = false`; `getCachedVaultIndex()` returns `null` again.
- **failed refresh**: a refresh that rejects leaves the prior published
  snapshot and `lastRefresh` unchanged (atomic publish only after the loop).
  The injected failure is enumeration-level (scratch vault root renamed away);
  there is no test seam for a mid-enumeration read failure, so that narrower
  case is reasoned from the single-threaded publish block, not injected.
- **partial completeness**: an oversized note is counted as `skipped` and is
  absent from the snapshot while the rest publishes cleanly.
- **parsed reuse vs stat enumeration**: an unchanged refresh reports
  `reparsed: 0` and `reused === files`, but still stats every file.
- **out-of-band writes**: invisible to the cached snapshot until the next
  `getVaultIndex()` refresh; there is **no public generation/epoch**.

### Proposed contract (proposal, not implemented)

- `cold`: never built, or full invalidation (`indexBuilt === false`).
- `dirty`: one or more path invalidations applied, not yet rebuilt. Today this
  state is **invisible**; a Hot Route layer must not treat `cached: true` as
  `clean`.
- `clean`: the most recent successful full publish.
- `vaultGeneration`: process-local monotonic integer, restarted at 0 per
  process. Bump on a successful changed MCP-mediated commit; bump when a commit
  outcome is uncertain (post-commit crash / recovery unknown); bump when an
  explicit refresh discovers a signature/membership change; **do not** bump on
  retrieval reindex alone.
- Entry contract: generation is the first fencing line; TTL is the second.
  A read must discard a computed value if the generation changed between read
  and publish.

## 3. Evidence group 2 — mutation invalidation matrix

Document: `docs/review/hot-routes/phase0/mutation-invalidation-matrix.md`.
Reproducible wiring test: `app/test/hot-routes-mutation-invalidation-map.test.js`.

Key findings:

- `invalidateVaultIndex` is called from exactly
  `mutation-plans.js`, `tools/intelligence.js`, `tools/links.js`,
  `tools/workflows.js` (plus its definition in `vault-index.js`).
- `tools/notes.js` write tools, `write_file` / `write_canvas` /
  `manage_folders`, `extract_archive`, `skill_import`, `git_pull`, and
  batch-journal recovery do **not** invalidate the in-memory index. The next
  `getVaultIndex()` self-heals through the `size:mtimeMs` signature, but a pure
  cache hit would not.
- `applyNotePlan` invalidates only after a durable batch commit; idempotent
  replay returns before invalidation; a no-op calls `invalidateVaultIndex([])`.
- **Failure boundaries are not uniform** (`app/src/batch-write.js`,
  `app/src/batch-journal.js`): validation-before-write and a successful rollback
  leave no durable note change; a failed rollback throws an `AggregateError`
  and leaves a recovery journal (outcome uncertain); a post-commit
  `afterCommit`/finalize/`afterFinish` failure leaves committed bytes but still
  skips `invalidateVaultIndex` because `atomicWriteBatch` throws before
  `applyNotePlan` reaches the call. Cases 3/4 are source-derived, not injected.
- No central commit hook exists; invalidation is per-tool wiring.

## 4. Evidence group 3 — pinned SDK resource auth transport probe

Test: `app/test/hot-routes-resource-auth-probe.test.js`.
Pinned SDK: `@modelcontextprotocol/sdk@1.30.0`
(`app/package-lock.json` → `node_modules/@modelcontextprotocol/sdk`).

Isolated loopback (`127.0.0.1`, ephemeral port) synthetic server/client with
fake identities and scopes. Observed:

- the resource read callback receives `extra.authInfo` on each request;
- identity and scopes are recomputed per request on the same MCP session (a
  second read with different credentials observes the new values);
- a synthetic scope-filtered handler **permits** a read that carries
  `obsidian.read`, then **denies** the same session after a scope downgrade to
  `obsidian.files`, exposing no route/tool markers — this is the same-session
  fail-closed case the open-handler identity-switch test cannot prove;
- a missing credential, including on an already-established session, is
  rejected at the HTTP layer (401) **before** the handler runs, distinct from
  auth-disabled mode where the handler runs with `authInfo === undefined`;
- a synthetic scope-filtered handler can fail closed without exposing route or
  tool metadata.

This is a **feasibility probe only**. `app/src/resources.js` today ignores
`extra` and implements no scope filter; this evidence does not claim otherwise.
No attack or production target testing was performed.

## 5. Evidence group 4 — synthetic cold/warm benchmark

Script: `app/scripts/hot-routes-phase0-benchmark.mjs`.
Artifact: `docs/review/hot-routes/phase0/benchmark-results.json`
(seed `0x5eed1234`; generated knobs: 120 notes, 12 skill docs, 1 README,
40 synthetic tools; the vault index actually enumerates **133** Markdown files =
120 notes + README + 12 `SKILL.md`).

Representative p50/p95 (this run, Node 22.18.0 Linux). The artifact now records
per-scenario `process.cpuUsage()` user/system deltas, RSS before/after/delta, and
the measured sample count. `fs calls` below is the **last-sample** total of
`node:fs/promises` module-method calls; the artifact also stores the min/max
range and per-sample totals. This is a proxy, not literal OS syscalls.

| Scenario | samples | p50 | p95 | fs calls (last/range) |
| --- | --- | --- | --- | --- |
| `vaultIndex.cold` | 5 | 96.8 ms | 97.1 ms | 1499 |
| `vaultIndex.warmUnchanged` | 25 | 11.8 ms | 13.8 ms | 302 |
| `vaultIndex.pathPrefix` | 25 | 11.1 ms | 12.7 ms | 302 |
| `cachedSnapshot.read` | 50 | 0.11 ms | 0.22 ms | 0 |
| `tags.deriveCached` | 50 | 0.01 ms | 0.02 ms | 0 |
| `tags.deriveFresh` | 15 | 10.7 ms | 11.9 ms | 302 |
| `recent.deriveCached` | 50 | 0.02 ms | 0.08 ms | 0 |
| `projectEntry.resolveCached` | 100 | ~0 ms | ~0 ms | 0 |
| `projectEntry.resolveNaive` | 15 | 10.4 ms | 11.7 ms | 302 |
| `skills.listFirstObservation` | 10 | 8.6 ms | 9.6 ms | 198 |
| `skills.listRepeated` | 25 | 9.0 ms | 10.4 ms | 198 |
| `toolsList.inMemory` | 20 | 0.94 ms | 1.66 ms | 0 |
| `toolsList.loopback` | 20 | 1.65 ms | 2.97 ms | 0 |

Output-equality checks in the artifact confirm cached derivations equal fresh
derivations and the cached project-entry lookup equals the naive scan.

Honesty notes:

- `projectEntry.*` is a **proposed L1 proxy**; no project-entry API exists yet.
- `skills.list*` has no cache and no reset; `listFirstObservation` is an
  observation, not a genuine cold state.
- `tools/list` timeout causation **cannot** be inferred from a loopback
  benchmark; attribution is unknown without production evidence.
- Hot cache hit metrics are **N/A** until a Hot Route cache is implemented.
- TTL / capacity numbers below are **proposals**, not measurements, and are not
  frozen policy.

## 6. Proposed gates (proposals only)

- Warm `getVaultIndex` is ~14 ms of stat enumeration per call; a clean-snapshot
  derivation is ~0.1 ms. This is the measured argument for caching derived
  metadata, not a mandate.
- A candidate TTL must not be frozen without user preference: the external
  out-of-band stale budget is a product decision. A safe default is
  "invalidate on MCP-mediated mutation; let the next Vault refresh bound
  out-of-band staleness", with TTL as a secondary bound.
- Candidate capacity: start from a small bounded LRU (e.g. 64–256 entries) and
  a byte cap; exact numbers require the Phase 1 implementation benchmark.
