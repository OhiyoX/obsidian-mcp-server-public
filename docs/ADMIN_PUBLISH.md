# Admin — Publish lifecycle (Markdown-only 公开边界)

This page is the operator surface for the **Publish registry**: which Vault notes currently have an
anonymous read-only link, what happened to the ones that no longer do, and how to clean them up. It
is the Admin view of the record state machine owned by `PublishService`.

Authority: `_Workspace/40-Projects/obsidian_mcp_server/Web/DEVELOPMENT - Issues 277-278 Publish 生命周期与
Markdown-only 边界收口.md` §5–§9, §12.3, §15, §22 (issues #277/#278). Implementation:
`app/src/publish/service.js` (lifecycle + persistence), `app/src/publish/target.js` (target gate),
`app/src/publish/lifecycle.js` (pure decision model), `app/src/admin/publish-view.js` (this page).

## 1. Where the surface lives

| Item | Value |
| --- | --- |
| Page | Auth Center tab **Publish** |
| URL | `/admin/auth?tab=publishes` |
| Auth | the *existing* Admin session cookie (`requireAdmin`) plus the `csrf` hidden field |
| Read route | the same Admin shell — the tab renders server-side from `PublishService.list()` |
| Write route | `POST /admin/auth/publish/revoke` (by opaque id, via `PublishService.revokeById`) |
| MCP tools | `get_publish_status` (read), `manage_publish` with `action: publish \| revoke` |
| Web API | `GET /api/web/v1/publish`, `POST /api/web/v1/publish` (`action: publish \| revoke`) |
| Anonymous read | `GET /publish/<opaque-id>` |
| State file | `<DATA_PATH>/publish/state.json` (mode `0600`, atomic temp + rename) |

The tab exposes **no new write capability**: the only action it can perform is the pre-existing
revoke. Publishing a note stays a Web/MCP action (Explorer toolbar / `manage_publish`).

### Multi-Vault

Every surface above is **per-Vault**: the MCP tools read the selected `vaultId` (injected by the
vault-scope registrar, default = primary), the Web routes use `req.webSession.vaultId`, and the
Admin tab deliberately lists the whole registry so an operator can clean up every Vault.
`PublishService` resolves that id through the canonical VaultRegistry, so a publish/revoke/status
only ever stats, reads and writes the selected Vault's own root.

The **state file is shared**: one `<DATA_PATH>/publish/state.json` holds one record per
`vaultId + NUL + path`, and one mutation queue serializes every publish mutation in the process
(a secondary publish therefore rewrites the file but never touches another Vault's records).
Contract `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置` §13.5 sanctions exactly this shape
(the publish opaque id records its own `vaultId`); §5.1/§5.2 define no separate publish state path.
The `publish` capability is reported `available: true` for every Vault, verified by
`app/test/multi-vault-publish-matrix.test.js`.

## 2. Record lifecycle

One record per `vaultId + NUL + canonical path`; the opaque `id` is the public handle.

| Token | Label on this page | Persisted | Public candidate | Meaning |
| --- | --- | --- | --- | --- |
| `active` | 已公开 | yes | **yes** | the target is Markdown and exists: the anonymous link serves |
| `orphaned` | 目标缺失 | yes | no | the record was live, then an observation found the target missing |
| `invalid` | 不符合公开契约 | yes | no | the target exists but is not Markdown (`.canvas`, `.base`, `.json`, `.txt`, `.png`, a directory, …), or the record's own lifecycle value is unrecognizable |
| `unknown` | 待确认 | yes | no | a legacy (`v1`) record that has not been observed yet — never assumed public |
| `revoked` | (no row state) | **never written** | no | recognized on read only; `revoke` physically deletes the record instead of storing a tombstone |

Two rules make the table safe to read:

- **`unknown` is not "probably fine".** A v1 record stays out of every public candidate set until a
  real observation says "Markdown target exists" (§8.1). The first `status` / `list` / `resolve`
  decides it and persists the result.
- **Dead never revives.** Once a record has been observed `orphaned` / `invalid` (or read as
  `revoked`), no later request moves it back to `active`, even if the exact same path reappears. The
  old opaque URL stays 404 forever; recovery is always revoke + an explicit publish, which mints a
  **new** id (§5.1).

### 2.1 Transitions

| Operation | Observed target | Record before | Result |
| --- | --- | --- | --- |
| publish | Markdown exists | *(none)* | `active`, new id |
| publish | Markdown exists | `active` | idempotent: same id, no new record |
| publish | Markdown exists | `unknown` | adopted: same id → `active` |
| publish | Markdown exists | `orphaned` / `invalid` / `revoked` | replaced: **new id**, old record removed |
| publish | missing | *(none)* | refused, nothing written |
| publish | missing | `active` / `unknown` | refused, record → `orphaned` |
| publish | non-Markdown | *(none)* | refused, nothing written |
| publish | non-Markdown | `active` / `unknown` | refused, record → `invalid` |
| resolve (anonymous) | Markdown exists | `active` | serves the *current* body (never a cache) |
| resolve (anonymous) | Markdown exists | `unknown` | serves, persists `active` |
| resolve (anonymous) | missing | `active` / `unknown` | 404, record → `orphaned` |
| resolve (anonymous) | non-Markdown | `active` / `unknown` | 404, record → `invalid` |
| resolve (anonymous) | anything | `orphaned` / `invalid` / `revoked` | 404, no re-observation at all |
| revoke (by canonical path) | *not looked at* | any | record removed, `revoked: true` |
| revoke (by canonical path) | *not looked at* | *(none)* | `revoked: false`, HTTP 200 — never 404 |
| revoke (by opaque id) | *not looked at* | any | record removed |

Every transition — including the write that `resolve` performs when it observes a missing target —
runs inside the service's single `mutationQueue`, so a concurrent publish/revoke cannot interleave
with it (§8.2).

### 2.2 Live edits are not a new document

Editing a note in place (same path, never observed missing) keeps the id and serves the updated
content: a Publish link is a *live document* link, not a snapshot. This is deliberately different
from "was the file deleted and recreated?" — see §7.

## 3. The Markdown-only target gate

`PublishService` is the final authority (`app/src/publish/target.js`); the Web route and the MCP tool
do not keep a second allowlist (§6).

Canonicalization, in order:

1. resolve the request through the Vault path canonical resolver, inside the Vault root only;
2. a path **without** an extension gets `.md` appended (the long-standing `assumeMarkdown` rule);
3. the final canonical `extname`, lower-cased, must be exactly `.md` — so `.MD` / `.Md` pass;
4. no content sniffing, no MIME detection, no extension allow-list widening.

Accepted: `Notes/a.md`, `Notes/A.MD`, `Notes/a` (when `Notes/a.md` exists), any existing Markdown
file within `MAX_READ_BYTES`.
Rejected with a frozen code: `.canvas`, `.base`, `.json`, `.txt`, `.png`, extensionless paths whose
`.md` does not exist, directories, oversize files, traversal/absolute/UNC/backslash paths.

Historical records already in the state file are gated on their **first observation**: a historical
non-Markdown or missing target fails closed (`invalid` / `orphaned`) and is never served (§12.3).

## 4. Error codes

The machine-readable `code` is the cross-surface contract; the prose is not. No surface ever leaks a
server absolute path (§15 S02/S03).

| Domain code | Web HTTP | MCP `structuredContent.code` | Raised when |
| --- | --- | --- | --- |
| `unsupported_publish_target` | 400 | ✔ | canonical target is not `.md` |
| `publish_target_not_a_file` | 400 | ✔ | target is a directory / not a regular file |
| `publish_target_too_large` | 400 | ✔ | target exceeds `MAX_READ_BYTES` |
| `invalid_publish_target_path` | 400 | ✔ | absolute / UNC / drive / traversal / NUL path |
| `publish_target_missing` | 404 | ✔ | target does not exist (also for a `get_publish_status` miss) |
| `publish_target_unverifiable` | (internal) | — | the observation probe itself failed, so the record is not served; not reachable through Web/MCP because `publish` re-verifies the target first |
| `publish_record_not_found` / `_orphaned` / `_invalid` / `_revoked` | 404 | — | internal resolve classification for a dead record |

Revoke is deliberately **not** an error path: a missing or unrecorded path returns a structured
success (`revoked: false`) with HTTP 200, which is exactly the #277 regression that used to surface
as a raw `ENOENT`/404.

## 5. Published candidates have exactly one source

Public "published" membership is derived in one place —
`resolvePublishedPaths(publishService, vaultId)` in `app/src/app/web-catalog/search-api.js`, which
calls `PublishService.list({ vaultIds: [vaultId] })` (default `includeInactive: false`, i.e.
`active` only). Both the v2 search route and the deprecated v1 `/api/web/v1/notes` route use it, and
the `published:` query token is parsed by the single `extractPublishFilter` helper.

Consequences an operator can rely on:

- the Explorer **Publishes** filter and the document's Publish state cannot disagree;
- `orphaned` / `invalid` records are never candidates, even while their file exists again;
- a frontmatter `published: true` field means nothing on its own (#270): only the registry decides.

This page is the exception by design: it calls `list({ includeInactive: true })` so retired records
stay visible and cleanable. Their row shows the opaque id as plain text with 「已失效」 and **no**
clickable public link, because that link would 404.

## 6. What this surface never does

- no attachment publishing, no image/`.base`/`.canvas` pages, no content-level ACL;
- no automatic link/reference following from a published note;
- no MIME sniffing and no extension allow-list as a substitute for the `.md` rule;
- no tombstone/audit export (`revoked` is read-only vocabulary; the record is deleted);
- no absolute path, Vault root or filesystem error detail in any Admin/MCP/Web payload;
- no change to the opaque-id shape (32 random bytes, base64url → 43 chars) or to the Scope/Vault
  allowlist checks.

## 7. The identity limitation, stated honestly

The registry identifies a document by `vaultId + path`. That is enough for everything above, but it
cannot distinguish **"the note was edited in place"** from **"the note was deleted and a different
file was created at the same path, without the service ever observing the gap"**. Both look like
"same path, different content".

What is guaranteed (Level 1): once the service *observes* missing/non-Markdown, the old id can never
come back. What is **not** guaranteed (Level 2): an unobserved delete→recreate is treated as a live
edit of the same document. Closing that needs a stable note identity or an external event ledger; it
is tracked in `Architecture/TODO - 稳定 Note Identity 与跨路径引用` and it is explicitly out of scope
here. `mtime`/`size` are not used to fake an identity.

## 8. State file, v1 → v2 migration and rollback

`state.json` is `{ "version": 2, "records": [...] }`, one record per `vaultId + path`, written with
mode `0600` through a temp file + `rename` inside the save queue.

Migration rules (§8.1), all fail-closed:

- a v1 file loads; each record is normalized and its lifecycle becomes `unknown` (never `active`);
- a record missing `id` / `vaultId` / `path` is **dropped** with a recorded issue;
- an unrecognizable `lifecycle` value becomes `invalid`; unknown extra keys are dropped, not carried
  forward;
- an unsafe path (absolute, drive-qualified, backslash, `.`/`..`/empty segment) is dropped;
- duplicate `id`s, or two records for the same `vaultId + path`, keep the first occurrence;
- **one bad record must not stop the service**; only a structurally broken file (unparseable JSON,
  non-object, non-array `records`, or an unsupported `version`) is fatal, and then
  `PublishService.load()` rejects with `Cannot load publish state: …` and the file is left byte-for-byte
  untouched — no partial v2 rewrite.

The migrated state is persisted as v2 on the first mutation/observation, not during load.

**Before deploying a release that bumps the state version, back up `state.json`.** Rolling back the
application does not require deleting the state file (v1 files are still readable), and the file must
never be hand-deleted to "reset" publishing.

## 9. Operations

Verify the migration fixture before/after a deploy (it uses a throwaway data root and a synthetic
Vault — never your Vault):

```sh
cd app
node scripts/run-publish-migration-checks.mjs --list
node scripts/run-publish-migration-checks.mjs            # 9/9, exit 0
P278_D_MIGRATION_NEGATIVE=all node scripts/run-publish-migration-checks.mjs   # red by design: proves each guard detects its regression
```

Check the browser surfaces:

```sh
cd app
node scripts/run-web-publish-checks.mjs --list
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/run-web-publish-checks.mjs
```

`run-publish-migration-checks.mjs` exits 2 on an unknown case; `run-web-publish-checks.mjs` exits 2
when no Playwright runtime is available. Neither ever installs a dependency.

### 9.1 Publish a note

Web: Explorer toolbar → publish, or `POST /api/web/v1/publish` with `{"action":"publish","path":"…"}`.
MCP: `manage_publish` with `action: publish`. The response carries `published`, `publicPath` /
`publicUrl` and `changed` (`created` for a fresh id).

### 9.2 Revoke

From this page (by opaque id) or by canonical path over Web/MCP. Revoking a record whose file is
already gone is a normal, successful cleanup — it does not require recreating the note.

### 9.3 Republish after a lost target

Recreate the note, publish it again, and expect a **new** URL: the old id stays dead. If a caller
reports "the link still 404s after I republished", compare the id in the Admin table with the one in
the link.

### 9.4 Cleanup of retired records

Retired rows are the operator's queue: revoke them once you no longer expect the original note back.
The overview metric counts `active` records and calls out the retired count.

## 10. Troubleshooting

### 10.1 A record shows 目标缺失 but the note is back on disk

That is the intended state: the service once observed the target missing, so the record is retired
and will not re-activate. Revoke the row (or `revoke` by path) and publish the note again to get a
fresh id.

### 10.2 A record shows 不符合公开契约

The target is not Markdown (or is a directory/oversize). Either the note was renamed to another
extension, or a historical record points at e.g. `Assets/Diagram.canvas`. Revoke it; re-publishing
such a path is refused by design.

### 10.3 The Explorer Publishes filter and the Admin page disagree

They must not: the filter reads only `active` records (§5). The realistic causes are a stale browser
tab (the tab shows what the server rendered last) or a filter cache; reload before investigating.
Any genuine divergence is a bug — capture the record's `lifecycle` from this page, the `published:`
query, and the note's frontmatter.

### 10.4 The service refuses to start

`Cannot load publish state: …` means the state file itself is broken (unparseable JSON, non-array
`records`, unsupported `version`). Do **not** delete the file: back it up, inspect it, and repair or
restore from a matching backup. A single bad *record* never has this effect — those are dropped and
reported as migration issues while the service starts normally.

### 10.5 The old link came back / the link still works after revoke

Neither can happen inside the service: `resolve` serves `active` only and one record per path
is persisted. If it reproduces, treat it as a bug in the release, not as an expected limitation, and
capture `state.json` plus the two ids.

## 11. See also

- [WEB_OPERATIONS.md](WEB_OPERATIONS.md) — service operations, the browser CI gate, deploy/rollback.
- [ARCHITECTURE.md](ARCHITECTURE.md), [WEB_AUTH_ARCHITECTURE.md](WEB_AUTH_ARCHITECTURE.md) — Web/Admin auth plane.
- `_Workspace/40-Projects/obsidian_mcp_server/Web/DEVELOPMENT - Issues 277-278 …md` — the frozen contract (state machine, error codes, test matrix).
- `Architecture/TODO - 稳定 Note Identity 与跨路径引用` — the Level 2 identity limitation of §7.
