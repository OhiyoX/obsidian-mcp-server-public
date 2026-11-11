# Web explorer: safe delete and rename — design (2026-11-06)

## Intent, and why

A folder named `_Workspace/40-P[0;3~rojects` sat in the vault for weeks and the operator could not
remove it from the browser. Two facts made that possible:

- `/api/web/v1/` has **create** for folders (`src/app/routes.js:575`) and full note CRUD, and no
  folder delete and no rename at all. Notes and attachments can be deleted; a directory cannot.
- `normalizeWebFolderPath` (`src/app/web-folders.js:24`) strips `\0` and rejects `..`, hidden and
  excluded segments, and then accepts every other byte. A paste that carried the printable tail of a
  terminal escape sequence (`[0;3~`) became a real directory name.

The folder held one file, `notes/docs/ui-proto/index.html` (108,697 bytes). At 2026-11-06 18:33:32
+08 an apply deleted that file (idempotency record `36416da7…`, `author.agent: "Cursor"`,
`author.model: "Grok Bot"`), so only empty directories were left. Nothing prunes an empty directory,
git never tracked the path, and the Web UI had no way to remove it. The operator had to ask for a
shell.

The request: right-click on an explorer row, **safe delete** (recovers), and **rename** with the
`F2` key, in the same way Obsidian behaves. Rename must rewrite the `[[wikilinks]]` that point at
the moved note or folder. The operator chose this over a note-only version.

## Goals

- Context menu on every explorer row (folder, note, attachment, base): 重命名 and 安全删除.
- `F2` renames the focused row. `ContextMenu` key or `Shift+F10` opens the menu for the focused row.
- Delete always moves to Trash (`TRASH_PATH`), never `rm`. A second confirmation names the target.
- Rename of a note or a folder rewrites the wikilinks and Markdown links that resolve to it, in the
  other notes of the same vault.
- The open note survives a rename of itself or of a parent folder (its path follows).
- Every write goes through the pipeline the note route already uses: `requireApi`, `requireCsrf`,
  `writeRouteGate`, `obsidian.write` scope, `assertWritable`, audit.

## Non-goals

- Drag-and-drop move, bulk operations, cut/copy/paste, permanent delete UI, a Trash browser UI.
- Renaming attachments. Their names are embed targets; renaming them would need the same rewrite for
  `![[…]]` in a different resolver. Rename covers notes and folders only; attachments can be deleted.
- Rewriting published URLs or `publish` rows after a rename. Publish is keyed by path; a renamed note
  loses its public URL, exactly as it does after a move through MCP today. Documented, not fixed.
- Cleaning empty directories automatically. This design removes the directories it empties, nothing
  else.

## Approaches

**A — reuse what each layer already does best (chosen).** A **note** rename calls the existing
`createMovePlan({from, to, updateLinks: true})` + `applyNotePlan`, inside the request context of the
selected Vault (see "Vault scope" below). A note or attachment delete calls `createDeletePlan` /
`createDeleteFilePlan`. A **folder** is not a list of files to copy: it is a directory to rename, so a
folder rename is one `fs.rename` followed by a text-only link-rewrite plan, and a folder delete is one
`fs.rename` into that Vault's Trash. Trade-off: the directory step is not journaled by the plan
engine, so an interrupted folder rename is repaired by hand (documented under Risks). Benefit: binary
files are never re-encoded, an empty folder renames like any other, and the link rewrite keeps the
engine's revisions, backups and conflict detection.

**B — notes only.** Smallest change: it reuses A's note half and leaves folders unmanageable, which
is the case that started this. Rejected: the operator's example is a folder.

**C — a general file manager** (move, copy, drag, batch, permanent delete). Rejected: it is several
features, and only delete and rename were asked for.

## Design

### Backend

Two routes, both under the note-route pipeline, in `src/app/routes.js`:

```
POST /api/web/v1/rename   { path, to, ifMatch? }   -> { from, to, updatedLinksIn, kind }
POST /api/web/v1/delete   { path, confirm: true }  -> { deleted, kind, trash, files }
```

`rename`:

- Note: `createMovePlan` + `applyNotePlan`. Destination exists → 409 (`Destination exists`).
  `ifMatch` = the revision the browser read; a mismatch is 409 as on the note route.
- Folder: `renameWebFolder(vault, { from, to })`, new in `src/app/web-rename-delete.js`.
  1. Guard: both paths canonical and inside the vault (`resolveWebVaultPath`, `allowMissing` for `to`),
     `from` is a real directory and not the vault root, `to` does not exist, `to` is not inside
     `from`, neither path is inside `.git/` or `.obsidian/`.
  2. Count the notes under `from` with the registry's own `markdownFiles(vault)` walk. Refuse above
     **500 files**.
  3. `fs.rename(fromAbs, toAbs)`. One syscall; every byte inside moves unchanged, and an empty folder
     moves like any other.
  4. Build a **text-only** plan for the links: for each moved note, every other note whose text
     resolves a link to its old path becomes one `raw` item with `baseRevision`. Refuse above **200
     rewritten notes**. Apply it with `applyNotePlan`.
  5. A failed link plan renames the directory back and reports the failure; the vault then matches
     its state before the request. A failed rename back is logged and reported as a manual repair.

`delete`:

- Note → `createDeletePlan({ path, backup: true })`; attachment or other file → `createDeleteFilePlan`.
  Both already move the bytes to `TRASH_PATH/<timestamp>/<vault path>`.
- Folder → `deleteWebFolder(vault, { path })`, new: same guards as the folder move, refuse the vault
  root and protected roots, refuse above 500 files, then one `fs.rename(fromAbs, <trash>/<timestamp>-<uuid>/<vault path>)`.
  **One** Trash entry for the whole folder, bytes unchanged. A folder is not restored per file: the
  Trash browser is out of scope, and `plan_restore_from_trash` restores files.
- `confirm: true` is required. Without it the route answers 400: a delete reached by a stale tab that
  thinks it is renaming must not remove anything.
- `mutationId` is required on `rename` when the request reaches the plan engine (a note, or a
  folder's link step). The client mints it with the existing `session.createMutationId()`, as the
  note route does, and the value reaches `applyNotePlan(planId, planHash, mutationId)` so a retry
  replays instead of applying twice. A folder delete has no plan: a retry answers 404 because the
  path is gone, which is honest and needs no store.

### Vault scope

The Web surface is Vault-scoped: `currentVault(req)` → `resolveWebVaultPath(vault, …)` →
`writeWebNote(vault, …)`. The plan engine instead resolves through `currentVaultRuntime()`
(`src/vault-runtime/request-vault.js`), which answers the **primary** runtime when the request
context carries no `vaultRuntime`. Calling the engine from a Web route without a context would
silently rename in the wrong Vault.

So both routes run their plan work inside `withRequestContextPatch({ vaultId, vaultRuntime }, …)`,
where `vaultRuntime = resolveVaultRuntime(vault.id)` — the same dependency `mountDirectUpload`
already receives (`server.js:351`). A Vault without a materialized runtime answers 503
`vault_unavailable`, the refusal code the MCP registrar uses. Trash for the folder step is
`vaultRuntime.paths.trash`, so each Vault keeps its own Trash.

Both routes write one audit line (`web.rename`, `web.delete`) with the vault id and the path, as the
folder-create route does.

### Frontend

`frontend/app/features/explorer/context-menu.js` (new):

- Builds a `role="menu"` popup and drives it with the existing `createPopupMenuController`
  (`frontend/app/ui/popup-menu.js`). Items: 重命名 (`F2`), 安全删除. The server exposes no writable
  flag for the explorer, and the create entries are always enabled and report a 403 as a message
  (`controller.js:423`); the menu items do the same, so there is one behaviour, not two.
- Opens from `contextmenu` on a row, from `ContextMenu`/`Shift+F10` on the focused row, and is
  positioned by the existing popup layout helper so it stays on screen on a phone.

Rename uses the existing inline draft machinery (`frontend/app/features/explorer/create-draft.js`)
with a `rename` mode: the input is prefilled with the current name, `Enter` commits, `Escape`
cancels, an empty or unchanged name closes without a request. No `prompt()`.

Delete calls `confirm()` with the target path and the sentence "将移到回收站，可还原". On success the
explorer row goes away, an open note that was deleted closes to the welcome state, and the toast
names what happened.

After a rename the client updates `state.path` and the tab row when the open note moved, calls
`explorer.syncCurrent()` and reloads the tree.

### i18n

New keys in `src/i18n/messages/zh-CN.js` and `en.js` (both catalogs must stay key-identical,
`test/i18n-catalog.test.js`): menu labels, the confirm sentence, the toast lines, the two refusal
messages (file and note caps), and the "destination exists" message.

### Tests

- `test/folder-plans.test.js`: guards (vault root, `.git`, destination exists, `to` inside `from`),
  the file and note caps, the emitted item set for a small tree, and that a refused plan touches
  nothing.
- `test/web-rename-delete-routes.test.js`: 401 without a session, 403 without CSRF, 409 on an
  existing destination, 400 without `confirm`, and the happy paths for note, folder and attachment.
- `test/explorer-context-menu.test.js`: menu opens on `contextmenu` and on `F2`, items disable
  without write permission, rename commits through the API and cancels on `Escape`.
- Link rewriting is already covered by the `move_note` tests; the folder case adds one test with two
  nested notes linking each other and one link from outside the folder.

## Risks and what to check

- **Link rewrite misses.** `replaceVaultLinks` (`src/obsidian.js:516`) resolves bare names, aliases,
  headings and embeds through `resolveLinkPath`. An ambiguous bare link (`[[README]]` with two
  READMEs) is left untouched by design; the toast reports the number of notes it changed, not a
  promise that all links moved.
- **The open note after a rename.** Forgetting `state.path` leaves the editor saving to a path that
  no longer exists. The test asserts the path follows.
- **Large folders.** The caps are refusals, not partial work: the plan is built before anything is
  applied, so a refusal leaves the vault unchanged.
- **Trash growth.** Every delete keeps its bytes, as note deletes already do. No new retention policy.
- **The folder rename is not journaled.** The plan engine journals file applies; a directory rename
  is one syscall it does not see. If the process dies between the rename and the link plan, the folder
  has its new name and some notes still link to the old one. That is visible, and the fix is the same
  request again with the link step only. A journaled directory rename is a later change.
- **Concurrency.** A note renamed in the browser while an agent writes it: `baseRevision` on every
  item makes the apply fail rather than lose the agent's bytes.
- **CIFS shares.** The vault may live on a share that refuses `rmdir` on a directory with an open
  handle; the directory then stays and the response says so.

## Calls I made (check these while reading)

1. Rename covers notes and folders; attachments are delete-only. Their names are embed targets.
2. Delete always goes to Trash; no permanent delete in the UI. This matches `delete_note` today.
3. Caps: 500 files, 200 rewritten notes. Above them the operation refuses with the count.
4. The context menu carries two items. No copy-path, no duplicate, nothing else.
5. The menu is built in a new module and reuses `createPopupMenuController`, not a new popup system.
6. `confirm: true` on the delete route is deliberate API friction, not redundancy.
7. Vault scope comes from `resolveVaultRuntime(vault.id)` and a request context; a Vault without a
   runtime is refused, never served by the primary runtime.
8. A folder is renamed as a directory, not rebuilt file by file, so binaries and empty folders need no
   special case.
9. A folder delete leaves one Trash entry and offers no per-file restore; file deletes keep the
   engine's per-file Trash backups.
10. `mutationId` is required for plan work and absent for the folder delete; a retried delete answers 404.
