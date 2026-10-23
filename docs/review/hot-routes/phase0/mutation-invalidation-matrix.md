# Hot Routes Phase 0-A — mutation invalidation matrix

Status: **candidate characterization** (branch evidence, not merged, not production).
Base: `origin/main@2d25d899cceedc76b41d894f4bf2edff68480572`.
Scope: source-grounded map of how the current code invalidates the in-memory
Vault index after Vault-affecting operations. **No wiring changes were made.**

Reproducibility: `app/test/hot-routes-mutation-invalidation-map.test.js` asserts
the caller set and the cold/dirty semantics this document relies on.

Wave D / D-workflows (multi-Vault, branch `feat/mv-d-workflows-per-vault`) update: the four
workflows rows below no longer call the primary facade `invalidateVaultIndex`. `tools/workflows.js`
resolves the *selected* Vault's runtime (`src/workflow-runtimes.js` → `index.invalidate(...)`), so an
invalidation can only move the Vault that was actually written (contract §11/§37: Vault A's mutation
must not change Vault B's index generation). With no Vault selection the resolved index *is* the
primary instance (`src/vault-index.js`), so the legacy single-Vault behaviour is unchanged. The
facade-name caller set in the reproducibility test therefore no longer lists `tools/workflows.js`.

Wave D / D-plans (multi-Vault, branch `feat/mv-d-plans-per-vault`) applies the same rule to the plans
and recovery rows below: `mutation-plans.js#applyNotePlan` and `tools/links.js#restore_version` now
invalidate through the lane seam `src/plan-runtimes.js#invalidateSelectedVaultIndex` (which resolves
`searchRuntimeFor(currentVaultRuntime())`, i.e. D-search's per-Vault instances) instead of the primary
facade `invalidateVaultIndex`. With no Vault selection the seam resolves to the
primary index instance (`src/vault-index.js`), so the legacy single-Vault behaviour is unchanged; a
selected Vault without a materialized runtime is refused (`vault_unavailable`) instead of advancing
the primary index. The facade-name caller set in the reproducibility test therefore now lists only
`src/vault-index.js` itself.

## 1. How invalidation works today

- `app/src/vault-index.js`
  - `getVaultIndex()` always enumerates Markdown files and stats each one; a
    changed `size:mtimeMs` signature reparses, an unchanged one is reused.
    It publishes atomically only after the whole loop succeeds.
  - `getCachedVaultIndex()` returns `null` iff `indexBuilt === false`; otherwise
    it returns the current in-memory `noteCache` with no Vault IO.
  - `invalidateVaultIndex(paths)`:
    - no argument → `noteCache.clear()` **and** `indexBuilt = false` (cold);
    - one/many paths → `noteCache.delete(...)` only, **`indexBuilt` stays true**
      (a partially complete snapshot that still reports `cached: true`).
  - There is **no public vault generation/epoch**. Freshness is only observable
    through `getVaultIndexStats()` and record presence.
- Invalidation is **tool-level**, not a central commit hook. `atomicWriteBatch`
  and `atomicWriteFile` do not touch the index; callers must call
  `invalidateVaultIndex` themselves.

## 2. Explicit invalidation paths

| Tool(s) | Mutation | Shared path | Invalidation reference |
| --- | --- | --- | --- |
| `update_task` | task line rewrite | `atomicWriteFile` | `tools/workflows.js` `index.invalidate(note.path)` (Vault-bound, Wave D / D-workflows) |
| `daily_note` (create/append/prepend) | create/write note | `atomicWriteFile` / `writeNoteFile` | `tools/workflows.js` `index.invalidate(info.path)` (Vault-bound) |
| `create_from_template` | create note from template | `atomicWriteFile` | `tools/workflows.js` `index.invalidate(localFs.toVaultPath(abs))` (Vault-bound) |
| `rename_property` | per-note frontmatter rewrite | `writeNoteFile` | `tools/workflows.js` `index.invalidate(record.path)` per record (Vault-bound) |
| `memory_capture` | create memory note | `writeNoteFile` | `tools/intelligence.js` `runtime.index.invalidate(toVaultPath(abs))` (+ `runtime.retrieval.syncRetrievalIndex`) — since Wave D / D-intelligence this is the *selected Vault's* `vault-runtime/vault-index-runtime.js` instance, not the primary facade, so `tools/intelligence.js` no longer appears in the `invalidateVaultIndex` caller set |
| `move_note`, `delete_note`, `restore_from_trash`, `restore_version` (Markdown), `apply_note_plan` | batch commit | `mutation-plans.js` `applyNotePlan` → `atomicWriteBatch` | `mutation-plans.js` `invalidateSelectedVaultIndex(results.map((item) => item.path))` **after** the durable commit; the helper (`src/plan-runtimes.js`) resolves the *selected* Vault's index instance (Wave D / D-plans) |
| `restore_version` (non-Markdown) | single file restore | `restoreFileVersion` | `tools/links.js` `invalidateSelectedVaultIndex(restoredFile.restoredPath)` (Vault-bound; Wave D / D-plans) |

Batch semantics inside `applyNotePlan`:

- successful changed commit → invalidates every changed path;
- idempotent replay (`idempotentReplay: true`) returns **before** the
  invalidation call; the original commit already invalidated, and a restart is
  cold;
- `changed.length === 0` (no-op) → `invalidateSelectedVaultIndex([])` runs, which
  deletes nothing but still schedules the *selected* Vault's retrieval refresh;
- any `atomicWriteBatch` failure → the invalidation is skipped because the
  call throws before it. Whether a durable change remains depends on the
  failure boundary; see §4. `afterCommit` / `afterFinish` failures in
  particular can leave a committed change un-invalidated.

## 3. Vault-affecting operations with **no** explicit invalidation (gaps)

These mutate observable Vault content but leave the in-memory index untouched.
The next `getVaultIndex()` still detects the change through the `size:mtimeMs`
signature, but a future Hot Route cache that trusts `getCachedVaultIndex()`
without a refresh would serve stale data.

| Tool(s) | Mutation | Shared path | Reference | Gap |
| --- | --- | --- | --- | --- |
| `write_note`, `append_to_note`, `patch_note`, `replace_in_note`, `manage_frontmatter`, `manage_tags` | note write | `writeNoteFile` → `atomicWriteFile` | `tools/notes.js` | module does not import `vault-index.js` |
| `write_file` | arbitrary file write | `atomicWriteFile` | `tools/files.js` | no invalidation |
| `write_canvas` | `.canvas` write | `atomicWriteFile` | `tools/files.js` | no invalidation |
| `manage_folders` (delete) | folder removal | `fs.rm` | `tools/files.js` | no invalidation |
| `extract_archive` | multi-file extract | `atomicWriteFile` per entry | `src/file-transfer.js` | no invalidation |
| `skill_import` | package import | `atomicWriteFile` / `fs.rm` | `src/skills.js` | no invalidation |
| `skill_export` | package ZIP write | `atomicWriteFile` | `src/skills.js` | writes non-Markdown archive; no Markdown record |
| `write_base`, `set_property_type` | `.base` / `.obsidian/types.json` | `atomicWriteFile` / types registry | `tools/workflows.js` | not Markdown; index unaffected |
| `git_pull` | fast-forward pull rewrites Vault files | `src/git.js` `pullUnlocked` | `tools/git.js` | no invalidation |
| batch-journal recovery | restore/reconcile after crash | `src/batch-journal.js` `recoverUnlocked` | startup `recoverPendingBatches()` | no invalidation; startup index is cold, runtime recovery is unverified |
| `reindex_vault` | retrieval index only | `src/retrieval.js` | `tools/intelligence.js` | by design does not change Vault content; must not bump a future `vaultGeneration` |

Plan-only / dry-run operations (`plan_*`, `get_note_plan`, `plan_note_changes`,
`compare_note_versions`, `get_note_version`, `update_task` `dryRun: true`) do not
mutate and do not invalidate.

## 4. Failure / uncertainty semantics

The earlier blanket claim "any throw from `atomicWriteBatch` means no durable
change" is **not** source-accurate. The actual boundaries are derived from
`app/src/batch-write.js` (`atomicWriteBatch`, `prepareEntries`) and
`app/src/batch-journal.js` (`finishBatchJournal`, `recoverUnlocked`).

`atomicWriteBatch` phases and their failure outcome:

1. **Validation-before-write** — `prepareEntries()` throws before
   `beginBatchJournal` (duplicate path, outside-vault path, `ifMatch`/
   `mustNotExist` conflict, trash-source revision mismatch). It may have created
   parent directories via `ensureVaultParent`, but no note bytes and no journal
   exist. No durable note change; no invalidation required.
2. **Write started, rollback succeeds** — a failure after `beginBatchJournal`
   during temp durable writes, the revision re-check, `setBatchJournalState(
   "committing")`, or the rename loop enters the `catch`, which calls
   `finishBatchJournal`. With `manifest.state !== "committed"` that function
   checks every target, restores each target whose current revision equals
   `after` from the journal backup (or removes a created file), and deletes the
   journal. If rollback succeeds, the original error propagates and **no durable
   note change remains**; no invalidation is emitted. (If the `save()` inside
   `setBatchJournalState("committed")` fails, the on-disk manifest is still
   `"committing"`, so this rollback branch runs even though renames happened.)
3. **Rollback failure / recovery uncertain** — if the `finishBatchJournal` call
   inside the `catch` itself throws (recovery conflict, backup checksum
   mismatch, finalize failure), `atomicWriteBatch` throws an `AggregateError`
   with `Batch write failed; recovery journal remains at …`. The journal stays
   on disk and `recoverPendingBatchesUnlocked()` reconciles it on the next batch
   or startup. At throw time the durable outcome is **uncertain**: some targets
   may hold `after`, some `before`. A future `vaultGeneration` must **bump**
   here, not assume "no change".
4. **Post-commit / afterFinish failure** — once `setBatchJournalState(journal,
   "committed")` succeeds, the rename loop is complete and target bytes are
   durable. A throw from `afterCommit`, or from the finalization inside
   `finishBatchJournal` (history/trash/idempotency), re-enters the `catch`; with
   `manifest.state === "committed"` that function **does not roll back** — it
   verifies `current === after` and re-runs finalization. `afterFinish` runs
   **outside** the try/catch after the journal is removed, so its failure also
   cannot roll back. In both cases the note changes are already committed and a
   future cache must treat the paths as changed (invalidate/bump). Because
   `applyNotePlan` only calls `invalidateSelectedVaultIndex` (the *selected* Vault's
   index instance) after `atomicWriteBatch`
   returns, a case-4 throw leaves a committed change **un-invalidated** today.

Injection status: cases 3 and 4 are **not** injected by a Phase 0 runtime test.
The classification is source-derived from the functions named above. Existing
`app/test/batch-*.test.js` crash-hook tests exercise case 2 and parts of the
recovery path, but no test asserts the `vaultGeneration` implication.

| Boundary | Current behavior | Hot Routes implication |
| --- | --- | --- |
| validation-before-write | throws before journal; no note bytes | no bump required |
| write started, rollback succeeds | `finishBatchJournal` restores/removes, deletes journal; throws | no bump required (no durable change) |
| rollback failure / recovery uncertain | `AggregateError`; journal remains for `recoverPendingBatchesUnlocked` | **bump** — durable outcome unknown |
| post-commit / `afterCommit` / finalize failure | committed bytes durable; no rollback | **bump/invalidate** — and today no invalidation is emitted |
| `afterFinish` failure | durable finish complete; cannot roll back | **bump/invalidate** — today no invalidation is emitted |
| recovery at runtime | `recoverPendingBatchesUnlocked()` does not invalidate the index | unverified gap: recovered bytes may not be reflected in a partial in-memory snapshot |
| idempotent replay | returns committed result without re-invalidating | safe because the original commit invalidated and restart is cold |
| `getVaultIndex` failed refresh | prior successful snapshot is preserved (evidence group 1) | future cache must distinguish `dirty` from `clean` |

## 5. Unverified gaps for the coordinator

1. No central commit hook exists; correctness currently depends on each tool
   remembering to invalidate the selected Vault's index through the per-Vault
   seam (`resolveSearchRuntime()` / `searchRuntimeFor(...)`, or the primary
   facade `invalidateVaultIndex` for code with no Vault selection). The gap list
   in §3 is the evidence for a future generation-fencing design, not a claim
   that current `getVaultIndex` is stale.
2. Batch-journal runtime recovery is not covered by an invalidation test.
3. `git_pull` can rewrite the whole Vault without invalidation.
4. `invalidateSelectedVaultIndex([])` schedules the selected Vault's retrieval refresh
   even when nothing changed; that is a side effect, not a correctness issue.
