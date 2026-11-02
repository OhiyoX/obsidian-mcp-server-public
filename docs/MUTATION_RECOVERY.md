# Multi-note mutation recovery

The current plan/apply path writes one or more Vault files through
`app/src/batch-write.js`. A durable transaction record now lives under
`DATA_PATH/mutation-journal/<transaction-id>/`. Its JSON manifest contains
paths, states, SHA-256 revisions, and per-entry completion flags only.
Separate protected backup files hold the original bytes needed for recovery.
Keep `DATA_PATH` private and back it up with the Vault; never publish or commit it.

## Commit protocol

1. Check every base revision and stage a backup of each existing target.
2. Publish and sync a `prepared` manifest before staging Vault temp files.
3. Write and sync temp files, then check all base revisions again.
4. Publish `committing`, rename written targets or unlink deleted targets in
   order, and sync their directories.
5. Publish `committed`; install pre-write history from the backups using a
   transaction-specific filename, persist the idempotent result, then notify
   Git mutation tracking.
6. Remove temp files and the journal directory.

Normal exceptions and interrupted `prepared`/`committing` transactions
restore original bytes. A `committed` transaction finishes version history
and cleanup. Recovery is idempotent: the HTTP server runs it **before
listening**. If a target has a revision that matches neither the recorded
original nor candidate, or a backup checksum fails, startup fails closed and
retains the journal. This protects edits made by an external writer after a
crash.

Committed plan results are stored for 24 hours under
`DATA_PATH/mutation-idempotency/`. Filenames are hashes of client-provided
idempotency keys; records contain the plan identity, author, OAuth user and client binding,
paths, revisions, and result metadata, without note content. A retry with the
same key and plan returns the recorded result after a process restart. A key
reused for another plan or author is rejected. If the process dies before
`committed` is durable, recovery rolls back the batch and the caller must
create a new plan.

## Operator recovery

When startup reports a recovery conflict, keep the service stopped. Record
the transaction directory and compare its manifest hashes with the current
Vault files and protected backups. Restore or reconcile the conflicting
file from a known-good Vault/data backup, then restart; recovery will retry.
Do not delete the journal to make the server start. The NAS release script
refuses code rollback while a journal remains, because the prior release
cannot recover an interrupted new-format transaction. Code rollback never
rolls back Vault content or the transaction directory.

## Current limits

- The journal supports write and delete entries inside `atomicWriteBatch`.
  `plan_move_note` previews the source deletion, destination write, and link
  rewrites as one plan; `move_note` uses the same batch internally. The
  move planner rejects changes spanning more than 25 notes. `plan_delete_note`
  and `delete_note` use the journal; committed deletion backs up to Trash after
  the committed marker and recovers it on startup if necessary. The returned
  backup path is relative to Trash and can be passed to `restore_from_trash`.
  `plan_restore_version` previews a Markdown note version restore and
  `restore_version` applies Markdown restores through the same journal.
  Non-Markdown file versions retain the direct byte-preserving restore path.
  Markdown `restore_from_trash` uses the planned journal path; non-Markdown
  entries retain the direct byte-preserving restore path.
- The mutation lock is process-local. External writers can still race with a
  commit; the second revision check narrows that window but does not make the
  filesystem a cross-process transaction manager.
- Plans remain in memory. A plan that was not durably committed must be
  recreated after restart; only committed results can replay across processes.
- The test suite covers a child process exiting after one rename, exit after
  the committed marker, normal exception rollback, external-edit conflict,
  a same-process post-commit Trash-consumption rename failure, a post-commit
  Trash source that drifts before the atomic detach, an external writer that
  recreates the Trash source after the detach, and a crash at the quarantine
  unlink that the next recovery pass completes. Further cases prove that a
  writer replacing the source path during the unexpected-byte restore cannot
  destroy the last copy of those bytes, and that a recovery which already
  consumed a verified quarantine does not raise a fresh conflict when an
  external writer recreates the source path before the journal is cleared.
  The Trash cases leave the
  committed destination in place and retain the journal for recovery when
  cleanup is incomplete; the drift case fails closed instead of deleting the
  new content, and the post-detach recreation case proves the new content is
  never unlinked.
  This is not a proof of atomicity across every OS crash or storage failure.

## Trash restore recovery semantics

Markdown restores from Trash participate in the same revision-bound planning and durable journal model as other planned note mutations. `plan_restore_from_trash` is side-effect free: it reads the selected Trash entry, resolves the destination, computes the candidate content, and records the source and destination identities that must still hold when the plan is applied.

A planned Trash restore has two independent concurrency guards.

The **Trash source revision** identifies the exact backup bytes reviewed during planning. If the source is modified, replaced, or removed before apply, the restore is rejected rather than accepting a stale plan.

The **destination revision condition** protects the Vault path independently. If the destination existed during planning, its current revision must still match the recorded base revision. If the destination did not exist, it must still be absent when the write is applied.

For plans that produce a Vault mutation, these conditions are checked while preparing the batch and checked again after staging but before the journal enters the committing state. For a plan whose candidate content is already identical to the destination and therefore produces no Vault write, `apply_note_plan` still revalidates destination existence or base revision and, for Trash restores, the Trash source revision before recording the no-op application as successful. Content equality therefore does not bypass optimistic concurrency validation.

The mutation lock serializes mutations performed by this service process. External filesystem writers are not covered by that lock, so the final pre-commit revision checks narrow the external race window but do not turn the filesystem into a cross-process transactional store.

### Markdown byte fidelity

Planned Trash restore accepts Markdown content only when the backup is valid UTF-8. The restore candidate is derived from the Trash backup itself rather than reconstructed through Markdown parsing, frontmatter serialization, or another semantic transformation.

For valid UTF-8 Markdown content, byte-significant properties preserved by the UTF-8 round trip include a UTF-8 BOM, line-ending style, trailing newlines, and the exact textual payload. The candidate revision exposed by the plan identifies the UTF-8 bytes that will be written by the planned mutation.

Invalid UTF-8 Markdown backups are rejected by the planned restore path rather than being decoded lossily.

### `removeBackup` is post-commit completion work

When `removeBackup=true`, consumption of the Trash source is separated from the Vault commit.

The completion intent, including the Trash path and expected source revision, is persisted in the durable transaction journal before Vault mutation begins. That intent is not acted upon unless the transaction reaches the durable `committed` state.

The effective ordering is:

1. Validate the destination revision condition and Trash source revision.
2. Persist the prepared journal, including any Trash-consumption intent.
3. Stage the candidate Vault bytes.
4. Revalidate the destination revision condition and Trash source revision.
5. Persist the `committing` state.
6. Commit the Vault mutation.
7. Persist the `committed` state and committed result.
8. Complete protected History or Trash backup work required by the mutation.
9. If requested, revalidate the Trash source against the recorded source revision and remove it.
10. Persist the idempotency record and finish journal cleanup.

A failure or process exit before the durable committed boundary must not consume the Trash source. Recovery of a `prepared` or `committing` transaction restores the pre-mutation Vault state and leaves the Trash source untouched.

A failure or process exit after the durable committed boundary does not roll the Vault restore back solely because Trash cleanup is incomplete. Startup recovery resumes the committed transaction and continues its remaining completion work.

Before recovery removes a Trash source, it validates that the entry is a regular file inside the configured Trash root and that its SHA-256 revision still matches the source revision recorded by the journal. Removal never unlinks the source path directly, because any path-based check-then-unlink leaves a time-of-check/time-of-use window in which an external writer can replace the reviewed bytes. Instead, the reviewed entry is atomically detached with `rename` to a revision-named quarantine in the same directory, the quarantined bytes are re-hashed, and only the verified quarantine is unlinked. A writer that replaces the source path after the detach therefore cannot be deleted by this step. The quarantine name is derived from the journal's recorded revision, so a process that exits between the detach and the quarantine unlink is recognized and completed by the next recovery pass. If the detached bytes do not match the recorded revision, recovery fails closed with an explicit cleanup conflict: the unexpected bytes are restored to the source path only while it is still free (an atomic non-clobbering hard link, or an exclusive copy when hard links are unavailable). That quarantine is always retained, because linking to a free source path and then unlinking the quarantine is not atomic: an external writer that replaces the source path between the two steps would otherwise leave the quarantine as the last remaining link to the unexpected bytes and the unlink would destroy them. In every conflict case the unexpected content and the still-committed journal are preserved for operator inspection.

Committed consumption is additionally recorded with a per-entry `consumeCompleted` flag in the durable manifest. Recovery persists the flag before it deletes a verified quarantine, so a crash after the quarantine unlink but before the journal cleanup no longer has to infer completion by re-reading the source path. A `consumeCompleted` entry is never re-examined at the source path: if its verified quarantine still exists it is removed to finish the step, and an object an external writer created at the old source path afterwards is left untouched instead of being reported as a fresh conflict. Entries written before this flag existed are still recovered through the earlier quarantine-based inference; the flag only removes the ambiguity for transactions committed by builds that persist it.

If the expected Trash source is already absent while committed completion is replayed, recovery treats the consumption step as already complete.

When `removeBackup=false`, the planned restore does not record a Trash-consumption intent and recovery does not remove the source backup as a side effect of the restore.

### Idempotent replay

The committed result is associated with the plan identity, author identity, and client-provided idempotency key. Reusing the same key for the same committed plan returns the recorded result rather than executing the restore again.

Trash consumption is part of committed completion rather than an independent second mutation. A process exit after the source was removed but before all journal cleanup completed can therefore be recovered without restoring the Vault note twice or requiring the Trash entry to reappear.

An idempotency key that was already bound to another plan or author is rejected.

### Protected History and Trash storage

History snapshots and Trash entries live in protected service storage outside the Vault root. Their revisions must therefore be computed and validated from the bytes at their actual protected-storage locations.

Vault-relative helpers such as `fileRevision(path)` are not general revision APIs for arbitrary protected artifacts. They combine content identity with Vault path-resolution assumptions and must not be reused to validate History snapshots, Trash backups, journal-owned protected copies, or future artifacts stored under another service root.

Recovery instead resolves each protected artifact through the storage root that owns it, verifies that the resolved path remains inside that root, and computes its SHA-256 content identity directly from the stored bytes.

This distinction matters especially during replay of an already committed journal, where History or Trash completion may still need to be verified even though the Vault mutation itself is complete.

### Non-Markdown restores

The planned Trash restore path is intentionally limited to Markdown destinations.

Restores whose destination is not Markdown continue to use the existing direct byte-preserving restore path. Arbitrary binary content is therefore not decoded, normalized, or reserialized through the Markdown planning engine.

`plan_restore_from_trash` does not silently fall back to a direct mutation when its destination is unsupported. Planning remains side-effect free and returns an explicit error instead. Callers that require a non-Markdown restore may use the existing direct restore operation.

The direct non-Markdown path does not inherit the planned Markdown restore's journal, dual-revision, or post-commit Trash-consumption guarantees unless those capabilities are added explicitly in the future.

### Recovery invariants

For planned Markdown Trash restores, the recovery model preserves these invariants:

- planning does not mutate the Vault, Trash, History, index, or event stream;
- the Trash source identity and destination revision condition are independent concurrency guards;
- unchanged/no-op application does not bypass source or destination revision validation;
- mutating application revalidates source and destination before the journal enters its commit phase;
- a pre-commit failure cannot consume the Trash source;
- Trash consumption requested by `removeBackup=true` occurs only as completion of a durably committed transaction;
- a committed Vault restore is not rolled back solely because post-commit Trash cleanup is incomplete;
- post-commit completion survives process restart;
- cleanup never removes a Trash source whose current bytes no longer match the reviewed source revision;
- unexpected quarantined bytes are never destroyed, even when an external writer replaces the source path during their restoration;
- durable per-entry consumption completion, recorded before the verified quarantine is removed, keeps recovery from re-interpreting a source path an external writer repopulated;
- replay of an already committed idempotent operation does not repeat the Vault restore or completed Trash consumption;
- History and Trash artifacts are resolved and validated under their own protected storage roots;
- valid UTF-8 Markdown restoration preserves the candidate textual bytes rather than reconstructing the note semantically;
- non-Markdown restoration remains on the direct byte-preserving path unless explicitly migrated to the planned journal model.

## Pre-write version snapshots and one-step rollback

Overwrite-style note tools (`write_note` with `overwrite=true`, `patch_note`, `replace_in_note`, and `write_file` overwriting an existing Markdown `.md` note) reply with the version id of the snapshot taken immediately before the write. That id is the shortest path from a bad edit back to the pre-write bytes.

### Snapshot layout

When `versionHistoryEnabled` is on, every write to an existing note copies the current bytes into protected history storage before the new bytes are renamed into place:

```
<HISTORY_PATH>/<vault-relative path>.md/<ISO timestamp>-<uuid>.bak
```

Each note therefore owns a directory named after the note path (including the `.md` suffix), and each write adds one timestamped `.bak` inside it. Newest first, entries rotate at `maxVersionsPerFile`. The absolute path of a snapshot is `server_info.historyPath` + `/` + `versionId`; the `versionId` is the history-relative path `<note path>.md/<timestamp>-<uuid>.bak`.

A create (a note that did not exist yet) takes no snapshot, so its response reports `preWriteVersionId: null`. The same is true when history is disabled; `write_note` / `patch_note` / `replace_in_note` / `write_file` then still report `removedHeadings`, `removedBlocks`, and `shrinkRatio`.

### One-step rollback

Pass the `preWriteVersionId` from the write response to `restore_version({ versionId: <preWriteVersionId>, overwrite: true })` to return to the state immediately before that write. The note still exists after the write, so `restore_version` requires the explicit `overwrite: true`; omitting it fails closed with `Restore destination exists. Set overwrite=true to replace it.` rather than silently replacing the current note. Inspect the candidate first with `list_versions`, `get_note_version`, or `compare_note_versions` when the right snapshot is not obvious. Planned restores preserve the snapshot bytes exactly rather than re-serializing the note.

Git is not a rollback mechanism: auto-commit lags behind writes, so history snapshots — not commits — are the first recovery path.

### Shrink guard

The tools that can replace a whole section or body (`write_note` with `overwrite=true`, `patch_note`, `replace_in_note`, and `write_file` when it overwrites an existing Markdown `.md` file) refuse by default when the complete serialized file would shrink by more than `WRITE_SHRINK_RATIO` (20%) and the pre-write file was at least `WRITE_SHRINK_MIN_BYTES` (2048 bytes). The rejection names the byte counts, the delta percentage, and the headings and blocks the write would delete, and it tells the caller how to proceed. The decision uses the unrounded ratio, so a real shrink of 20.0008% is still refused even though the reported ratio displays as `0.2`.

- Re-run with `confirmShrink: true` to accept the loss.
- Call `plan_note_changes` first to review the diff when the intent is unclear.
- Use `list_versions` plus `restore_version` to roll back a write that already happened.

Small notes are deliberately exempt so routine edits never prompt. Appends and prepends cannot shrink a note and are never intercepted; `append_to_note` reports `preWriteVersionId` without evaluating the guard.

This guard covers the note-body write tools above plus `write_file` overwrites of existing Markdown notes. `write_file` on non-Markdown resources (`.canvas`, `.base`, JSON, attachments), `write_canvas`, `write_base`, and `create_from_template` keep their own explicit overwrite semantics and are not routed through this threshold.
