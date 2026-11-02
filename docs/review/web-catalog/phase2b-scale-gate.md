# Phase 2B — target-platform (Linux) scale gate

Closes the last Phase 2B gate: the 50k benchmark on the **target platform** with the real
Node / SQLite / WAL / filesystem / Unicode stack, not the developer machine.

Reproduce with `app/scripts/web-catalog-scale-bench.mjs`. All data lives in a temp dir, the
derived catalog DB is created **outside** the synthetic vault, and no production Vault is
read or written.

The script is **fail-closed**: `RESULT: PASS` is bound to the hard checks below (never to
timing), and any failing check exits non-zero. `BENCH_SELFTEST_FAIL=1` deliberately fails
the first hard check so the exit behaviour itself is verifiable.

## Environment

| | |
|---|---|
| Node | `v22.23.3` (baseline is `>=22.13`) |
| SQLite | `3.51.3` (`node:sqlite`) |
| Platform / arch | `linux` / `x64` |
| Runtime | the **production container's** runtime (same Node/SQLite/filesystem as the live service) |
| Code under test | the current `main` `app/src` (schema v6, `fts_rowid`) |
| DB | file-backed, **`journal_mode=wal` verified via PRAGMA**, catalog DB outside the vault |

## Hard checks (what PASS is bound to)

| check | evidence |
|---|---|
| Node satisfies the `>=22.13` baseline | `v22.23.3` |
| WAL is active on the file-backed catalog DB | `journal_mode=wal` |
| 50k cold build indexes every file (no cap truncation) | `indexed=50006/50006` |
| anchor page starts at the anchor and stays ordered | `first=Hot/h-02500.md items=100` |
| last-item anchor yields a clean terminal page | `items=1` |
| warm pages are index-only | no `TEMP B-TREE`, no `SCAN nodes` |
| reopened catalog serves warm pages from the persisted snapshot | `lastReconciledAt` present, `items=3` |
| Unicode names (CJK/Hangul/combining/emoji) are indexed | `6/6` |
| runtime watcher index path publishes the added note | `ok=true` |
| incremental reconcile re-reads only the changed files | `scanned=50007 reparsed=2 reused=50005 removed=0` |

Timings below are **observations**; no absolute SLA is asserted.

## Synthetic vault

Built in a temp dir, removed afterwards:

| | count |
|---|---|
| single hot directory (5k children) | 5,000 |
| deep / wide tree (`Deep/D###/S#/`) | 45,000 |
| Unicode names (CJK, Hangul, combining `e`+U+0301, NFC `é`, emoji) | 6 |
| **total Markdown** | **50,006** |

Vault generation: ~2.3s.

## Cold build

| scale | wall | DB (+WAL) | indexed | reused | removed |
|---|---|---|---|---|---|
| 1k | 442ms | 1.3 MiB | 1,000 | 0 | 0 |
| 10k | 4.1s | 22.8 MiB | 10,000 | 0 | 0 |
| 50k | 17.7s | 115.3 MiB | 50,006 | 0 | 0 |

This is the **whole reconcile**: directory walk + `stat` + read + front-matter parse +
sha256 + SQLite + FTS. It is not the store-level insert path (which the read-path gate
covers separately).

## Warm reads at 50k (30 samples)

| page | p50 | p95 | items | ordering index | `TEMP B-TREE` | `SCAN nodes` |
|---|---|---|---|---|---|---|
| root | 0.09ms | 0.17ms | 3 | ✅ | no | no |
| hot child (5k siblings) | 0.33ms | 0.39ms | 100 | ✅ | no | no |
| last-item anchor (5k) | 0.10ms | 0.16ms | 1 | ✅ | no | no |
| deep child | 0.08ms | 0.11ms | 9 | ✅ | no | no |
| Unicode dir | 0.08ms | 0.09ms | 6 | ✅ | no | no |

Every plan uses the `nodes_parent_*` ordering index. The last-item anchor returns a clean
terminal page (the anchor itself, nothing after it) rather than an error or a second page;
a mid-list anchor starts at the anchor and stays ordered.

## Persistence and incrementality

- **close → reopen**: the first 50k connection is explicitly **closed** before the second
  is opened, so this is a true warm restart (not a second concurrent reader). The reopened
  catalog served warm root in **0.23ms** with `lastReconciledAt` present — a warm request
  does **not** trigger a full-vault reconcile.
- **Unicode**: `6/6` present in the catalog.
- **runtime watcher/index path**: one `note.created` event through
  `createWebCatalogRuntime(...)` → `indexFile` (via `applyWatcherEvent`, **not** a direct
  store write) published the added note in ~65ms.
- **incremental reconcile**: over 50,007 files it did `reparsed=2, reused=50,005,
  removed=0` — only the two mutated files were re-read.

## Result

**PASS (10/10 hard checks)**, exit code 0. `BENCH_SELFTEST_FAIL=1` → **FAIL (9/10)**, exit
code 1 — the harness is fail-closed.
