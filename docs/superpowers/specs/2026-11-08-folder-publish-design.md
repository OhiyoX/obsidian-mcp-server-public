# Folder publish — design (2026-11-08)

## Intent, and why

Today Publish is one Markdown file at a time: `manage_publish` takes a path, the registry
stores one record per `vaultId + path`, and the public URL is `/publish/<43-char id>`. A
directory is not a supported target: `normalizePublishTarget` appends `.md`, the resolver
answers `ENOENT`, and the call fails with `publish_target_missing`
(`app/src/publish/target.js:104-118`). `unsupported_publish_target` fires for a non-Markdown
file, not for a directory.

The owner wants to publish a **folder as a continuing set**: one fixed address that lists the
notes inside, reflects additions and removals automatically, and survives a rename. On top of
that the owner defined the visibility model:

| Document frontmatter | Containing folder | Visible |
| --- | --- | --- |
| `publish: true` | unpublished | **yes** |
| `publish: true` | published | yes |
| `publish: false` | published | **no** |
| `publish: false` | unpublished | no |
| no marker | published | yes (inherits) |
| no marker | unpublished | no |

In one sentence: **the document decides; if the document is silent, the folder decides; if
nobody decides, it is invisible.** A document is never "private by default": a document
without a marker inside a published folder is public, which is what makes a folder a
publishing unit.

## Goals

1. Publishing a folder creates one record with one opaque address. That address lists the
   visible notes inside and serves each of them.
2. A note added to, removed from, or renamed inside a published folder changes the public
   result with no second action.
3. A folder rename or move keeps the same address and the same record.
4. `publish: true` makes a note visible anywhere **and gives it its own address**;
   `publish: false` makes it invisible anywhere, even inside a published folder. The owner
   confirmed on 2026-11-08 that the address is automatic.
5. Attachments and images stay unpublished. The owner decided on 2026-11-08 to keep them out
   of this slice: `sanitizePublicMarkdownBody` (`app/src/app/publish-markdown.js:38`) keeps
   replacing every image with `附件未公开`, and the publish page CSP keeps `media-src 'none'`.
   Publishing arbitrary bytes is a separate decision with its own attack surface.
6. Web explorer context menu: publish this folder, unpublish. MCP `manage_publish` accepts a
   directory path.
7. Every public address stays an opaque id. Nothing in a URL names a Vault, an absolute path
   or a folder-relative path — the contract `src/authorization/adapters/publish.js:20-28`
   already states.

## Non-goals

- No snapshot: pages read the Vault at request time, as `/publish/:id` does today.
- No custom alias, no per-folder password, no expiry date.
- No public search endpoint and no sitemap.
- No compatibility layer for Obsidian's own Publish.
- No reverse-proxy cache: `Cache-Control: no-store` stays.

## Anti-goals

These would make the feature a failure even if it works:

- A `publish: true` note in an **unpublished** folder reveals a sibling. Its own page stands
  alone: no index, no parent link, no attachment route into the folder.
- A folder index lists a `publish: false` note's title, path or existence.
- A renamed folder silently points the old address at a different folder.
- A crafted request reaches a file outside its record: `..`, `%2e%2e`, `%00`, a leading `/`,
  a symlink, or another Vault.

## Constraints

- **Authorization plane.** `GET /publish/:id` is a catalog boundary (`publish_document_read`,
  `targetKind: publication`, `grantable: false`). The adapter hardcodes that boundary string
  (`src/authorization/adapters/publish.js:22`), so a second catalog row is not enough: the
  adapter must take the boundary as an input. The P4 equality matrix needs the new rows.
- **One registry.** `data/publish/state.json` stays the only list. The Web index, the MCP
  tools, the search `published` filter (`resolvePublishedPaths`,
  `app/src/app/web-catalog/search-api.js:61`) and the authorization seam all read it. The
  filter returns record paths today, so a folder record's members must be added to that set
  explicitly, or `published=true` silently stops matching them.
- **State version.** `STATE_VERSION` is `2` and the loader throws on anything but `1` or `2`
  (`app/src/publish/service.js:57,164`); the normalizer rebuilds each record from a fixed
  field list (`lifecycle.js:201`). Both must learn `kind`, or the field is dropped on load
  and the next save writes it away.
- **Two places build the public path**: `app/src/app/routes.js:421` and
  `app/src/tools/publish.js:83`. Both are `/publish/${record.id}`. Adding a folder record
  means both, plus `publicRecord` (`service.js:70`), which drops unknown fields.
- **`manage_publish` output is a frozen contract** (`src/tool-contracts.js` drift gate).
  Widening its payload is a deliberate, recorded change.
- **Id shape.** `/publish/:id` accepts exactly 43 base64url characters
  (`app/src/app/routes.js:217`). Folder ids use `randomBytes(32).toString("base64url")` too.
- **Existing data.** Two notes in the live Vault already carry `publish: false` and
  `private: true`; under this model they are invisible with no edit.
- **Frontend.** No literal text: every string goes through `t()` in
  `src/i18n/messages/{zh-CN,en}.js`; the bundle is rebuilt with `npm run build:web`.

## Approaches

### Where the document's own visibility lives

1. **Frontmatter** (`publish: true|false`). Chosen. It is a property of the content, it
   travels with Git, the Vault index already parses frontmatter, and the owner's notes use it.
2. Server-side state per document. Rejected: the owner wants the mark in Obsidian.
3. Both, frontmatter winning. Rejected: two sources of truth for one answer.

### Address shape

1. **Opaque id** `/publish/d/<id>`. Chosen. Survives rename and move, leaks no structure,
   matches `/publish/<id>`.
2. Path mirror `/publish/d/<path>`. Rejected: breaks on every rename, and a URL would name a path.
3. Id plus an optional alias. Rejected for now: alias uniqueness is new state for a
   convenience nobody asked for.

Items inside a folder record are addressed by an opaque **token**, not by their path:
`token = base64url(sha256(folderId + NUL + relPath)).slice(0, 22)`. The handler walks the
record's folder, computes the same token for each candidate, and serves the match. The path
never appears in a URL, so the anti-goals above have no surface, and a token from one record
cannot select a path in another.

### How a marked note gets its address

`publish: true` alone must yield a URL, or "visible anywhere" means nothing. Two triggers
maintain that record:

1. **On note write**, where the Web catalog indexer already sees every note mutation
   (`app/src/app/web-catalog/indexer.js`). Chosen: the owner's mark takes effect immediately.
2. **On the periodic reconciliation sweep** (`app/src/vault-runtime/reconciliation.js`), which
   already walks the Vault. Chosen as the sweep: it covers a Git-side change and retires a
   record after `publish: false`.

Rejected: materializing inside `GET /publish/:id`, which would write state during a public
read, and would still be unreachable, because the caller cannot guess the id.

### How the public result is computed

1. **Read time.** Chosen: walk the folder, apply the table, render. No invalidation, no drift.
2. Materialized manifest per publish. Rejected: it duplicates the Vault, and every write path
   would have to keep it fresh.

## The how (decided)

### Record kinds

`data/publish/state.json` becomes `version: 3`; `STATE_VERSION` becomes `3`; the loader
accepts `1`, `2` and `3`. One record per `vaultId + NUL + path`, plus:

```js
{ id, kind: "document" | "folder", vaultId, path, lifecycle, createdAt, updatedAt, createdBy }
```

A v2 record loads as `kind: "document"`. `normalizeLegacyRecord` and `publicRecord` must carry
`kind` through, or the field dies on the first round trip.

### Lifecycle for a folder record

`probeRecordTarget` answers `{ exists: true, isMarkdown: false }` for a directory and
`planResolve` turns that into `invalid` (`service.js:104-118`). It must learn `kind`: a folder
record is `active` when the path is a directory, `orphaned` when the path is gone, `invalid`
when the path is a file. No planner may turn a directory into `invalid` any more.

### The pure visibility predicate

New module `src/publish/visibility.js`, no IO:

```js
visibilityOf({ marker, insidePublishedFolder, inDraftSubtree })
  // marker: "public" | "private" | "none"
  // -> "visible" | "hidden"
```

Rules, in order: `private` hides; `public` shows; a note inside a draft subtree does not
inherit; otherwise the folder decides. An unrecognised value (`publish: 待定`) hides. There is
no attachment case: phase 1 publishes note bodies only.

**A descendant subdirectory named `_*` or `.*` does not inherit.** The owner confirmed this on
2026-11-08. The published folder itself always counts. Without the rule, publishing
`_Workspace` makes every work note public in one gesture. A note inside such a subtree is
still public if it says `publish: true`.

### Routes

| Route | Serves | Boundary row |
| --- | --- | --- |
| `GET /publish/:id` | one document record (unchanged) | `publish_document_read` |
| `GET /publish/d/:id` | the folder index | new `publish_folder_read` |
| `GET /publish/d/:id/n/<token>` | one note inside the record | same row |

The token is derived, never parsed: the handler lists the record's folder, computes tokens,
and serves the match. The scan is bounded by the caps below.

### Publishing and unpublishing

- `manage_publish` and the Web route accept a directory. `publish/target.js` grows a directory
  branch, still with no second allowlist.
- Unpublish deletes the record. No tombstone, as today.
- Server rename (`renameWebEntry`, `app/src/app/web-rename-delete.js:292`) updates the record
  in the same mutation, so the address follows. `pathMoved` is browser tab code and is not the
  hook.
- A Git-side rename leaves the record `orphaned`; the old address answers 404 and never revives.
- A folder deleted through the Web explorer goes to Trash and orphans the record.

### Caps and refusal codes

| Situation | Answer |
| --- | --- |
| Publish a folder with more than 500 notes | `publish_folder_too_large`, 413, before any write |
| Publish a folder deeper than 8 levels | `publish_folder_too_deep`, 413, before any write |
| A published folder grows past 500 later | index lists the first 500 by path; deeper notes are hidden |
| Unpublished-folder token request | `publish_record_not_found`, 404 |
| Token matches nothing | `publish_record_not_found`, 404 |
| An image or attachment request | no route exists; the note body keeps `附件未公开` |
| Authorization seam denies | 404 with an empty body |

`MAX_READ_BYTES` still governs one note; an oversized note inside a folder is listed and its
page answers 413 with the existing code.

## What the existing code must change

1. `service.js`: `STATE_VERSION`, loader versions, `publicRecord` gains `kind`, folder probe,
   folder planner path, `status()` accepts a directory (`statWebNote` resolves a note file).
2. `lifecycle.js`: normalizer keeps `kind`; `planResolve` leaves a directory `active`.
3. `target.js`: directory branch and its codes.
4. `catalog.js` + `adapters/publish.js`: `publish_folder_read`, parameterized boundary.
5. `routes.js` and `tools/publish.js`: the two public-path builders, folder routes.
6. `search-api.js`: `resolvePublishedPaths` unions the members of folder records.
7. `tool-contracts.js`: the widened `manage_publish` payload, recorded as a deliberate change.
8. Web explorer menu, publish page, Admin list (`kind`, visible count), i18n catalogs, bundle.

## Tests and negative controls

- v3 save then load keeps `kind`; a v2 file loads as `document`; a v1 file still loads.
- `publish: false` inside a published folder: the index omits its title, the token route
  answers 404, nothing throws 500.
- `publish: true` inside an unpublished folder: its page loads, and the folder index and a
  sibling token both answer 404.
- Tokens: a token from record A is refused by record B; a forged token is 404; `%2e%2e`,
  `..%2F`, `%00`, a leading `/` and a symlink never reach a file.
- Caps: 501 notes and depth 9 are refused, and `state.json` is byte-identical before and after.
- Delete a published folder, recreate a folder at the same path: the old id stays 404.
- A draft subtree (`_drafts/`) inside a published folder is not listed, and a note inside it
  is visible only with `publish: true`.
- Every new boundary has a catalog row and an equality-matrix row.

## Sequencing

1. `kind` + v3 migration + `visibility.js` + its table test.
2. Catalog rows, adapter boundary parameter, equality-matrix rows.
3. Folder routes, index page, token derivation, caps.
4. `publish: true` materialization (write hook + reconcile sweep).
5. MCP/Web/menu surface, payload contract, Admin column, i18n, bundle.
6. Rename and delete hooks, orphaning.

Attachments are not part of this sequence. A later slice may add them, with its own design.

## What shipped differently, and why (2026-11-08, after Task 8)

These are deliberate deviations from the text above, decided during implementation.
Each one is recorded here because the code is the truth now.

1. **The token input is the Vault path, not the folder-relative path.** `folderToken(folderId, vaultPath)`, hashing `folderId + NUL + vaultPath`. The plan's own test asserted a Vault path, so the plan contradicted itself; the Vault path is also unique across the vault. Nothing in the URL changes.
2. **A public read hides an oversized note instead of listing it with a 413.** Its frontmatter cannot be read, so `publish: false` cannot be ruled out. Fail closed. The same rule applies to a marked note over `MAX_READ_BYTES`: it gets no record.
3. **A note deeper than the depth cap is hidden from a public read**, and refused (`publish_folder_too_deep`) only at publish time, and only when a *visible note* is that deep. A deep asset tree does not refuse a publish.
4. **The walker enters a draft subtree** (`_*`, `.*`) and marks its entries `inDraftSubtree`, rather than skipping the directory. Skipping would break the rule that `publish: true` is visible anywhere.
5. **The Admin publish list carries no per-folder note count.** A count needs a second walk per request, and a truncated count would hide the truncation it reports. Deferred deliberately; the Admin list shows the `kind` as a tag inside the document cell, because the parity gate pins the prototype's column set.
6. **The permission baseline rows added for the two folder routes are 404 refusals**, because no fixture can seed a folder record yet. They prove the boundary is mapped and does no content I/O; they do not prove a served index. Regenerate with a served row when a seeding path exists.

## Two rulings that change the model, made after the whole-branch review

1. **An explicit record is a decision; `publish: false` is the only thing that withdraws it.**
   The sweep retires a record only for `private`. A note with no `publish:` key keeps any record
   someone created with the publish action, so `/publish/<id>` keeps answering. The consequence:
   deleting `publish: true` from a note does **not** withdraw its address; the owner must revoke it.
   The six-row table above still describes inheritance: no marker plus an unpublished folder
   yields no *listing*, and an explicit record is a separate grant.
2. **A scan budget of 2000 Markdown files per publish.** A directory holding more files cannot be
   published (`publish_folder_too_large`), and a listing stops at the budget with `truncated`.
   Without it, one anonymous request to a published folder holding many private notes reads every
   frontmatter in that folder.

## Known residual at the time of merge

`materialize.js` and `web-rename-delete.js` call `revoke(vaultId, path)` without a `kind`, so the
document-first fallback can revoke a folder record named `X` while syncing the note `X.md`. Both
callers know the kind. The fix is to pass `kind: "document"` at both call sites. Left unfixed
after the fix wave closed; recorded here so it is not lost.

## What is left to the builder

- The index page's HTML, CSS and wording; pagination past the cap is out of scope.
- Whether a published folder gets a marker in the explorer tree.
- Whether `publish: true` should also appear as a badge in the file tree.
