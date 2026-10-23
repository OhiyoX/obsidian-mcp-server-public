# User Configuration

This guide explains how to run this Obsidian MCP server and connect MCP clients to it.

## 1. Configure Environment

From the project root:

```sh
cp .env.example .env
```

Edit `.env`:

```sh
OBSIDIAN_VAULT_PATH=./vaults/vault
MCP_PORT=18923
OBSIDIAN_READ_ONLY=false
API_KEY=
API_KEY_HEADER=X-API-Key
OAUTH_ENABLED=false
PUBLIC_BASE_URL=
OAUTH_ADMIN_PASSWORD=
TRUST_PROXY=false
OAUTH_INITIAL_USERNAME=
OAUTH_INITIAL_PASSWORD=
OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
OAUTH_REFRESH_REUSE_GRACE_SECONDS=30
AUTH_AUDIT_MAX_ENTRIES=2000
AUTH_ADMIN_SESSION_TTL_SECONDS=3600
PROTECT_HEALTH=false
OBSIDIAN_TIMEZONE=Asia/Shanghai
SESSION_TTL_MS=1800000
MCP_SESSION_RECOVERY=stateless
MCP_SESSION_RECOVERY_MAX_INFLIGHT=64
MAX_TRANSFER_BYTES=100mb
MAX_INLINE_TRANSFER_BYTES=5mb
TRANSFER_CHUNK_BYTES=1mb
TRANSFER_TTL_MS=86400000
MAX_ARCHIVE_ENTRIES=1000
MAX_ARCHIVE_BYTES=100mb
MAX_ARCHIVE_UNCOMPRESSED_BYTES=250mb
VERSION_HISTORY_ENABLED=true
MAX_VERSIONS_PER_FILE=50
GIT_ENABLED=true
GIT_AUTO_COMMIT=true
GIT_COMMIT_DEBOUNCE_SECONDS=180
GIT_COMMIT_MAX_DELAY_SECONDS=900
GIT_AUTO_COMMIT_SWEEP=true
GIT_SWEEP_INTERVAL_SECONDS=900
GIT_AUTO_PUSH=false
GIT_AUTHOR_NAME=Obsidian MCP
GIT_AUTHOR_EMAIL=obsidian-mcp@local
GIT_REMOTE=origin
GIT_BRANCH=
NPM_REGISTRY=https://registry.npmjs.org
RETRIEVAL_CHUNK_SIZE=1400
RETRIEVAL_CHUNK_OVERLAP=180
EMBEDDING_PROVIDER=disabled
EMBEDDING_BASE_URL=
EMBEDDING_MODEL=qwen3-embedding-0.6b-q8
EMBEDDING_API_KEY=
EMBEDDING_TIMEOUT_MS=120000
EMBEDDING_BATCH_SIZE=32
EMBEDDING_INDEX_CONCURRENCY=4
EMBEDDING_EDGE_PROVIDER=openai
EMBEDDING_EDGE_BASE_URL=
EMBEDDING_EDGE_MODEL=qwen3-embedding-0.6b-q8
EMBEDDING_EDGE_API_KEY=
EMBEDDING_EDGE_TIMEOUT_MS=1500
EMBEDDING_EDGE_HEALTH_INTERVAL_MS=10000
EMBEDDING_EDGE_REGISTRY_URL=http://127.0.0.1:11435
EMBEDDING_EDGE_REGISTRY_API_KEY=
VAULT_WORKSPACE_ROOT=_Workspace
MEMORY_PATH=_Workspace/20-Memory
SKILLS_PATH=_Workspace/60-Skills
WEB_CATALOG_ENABLED=true
WEB_CATALOG_DIR=
```

Important settings:

- `OBSIDIAN_VAULT_PATH`: host path to your Obsidian vault.
- `OBSIDIAN_VAULTS_ROOT` (forwarded into the container as `WEB_VAULTS_ROOT`): parent directory of the secondary Vaults this service discovers. Since the multi-Vault wave **both** MCP and the Web app serve every Vault under it (up to 64); an MCP tool selects one with the optional `vaultId`. See [Multi-Vault (多库)](#multi-vault-多库).
- `WEB_DEFAULT_VAULT`: the **primary** Vault's canonical id when `OBSIDIAN_VAULTS_ROOT` is configured; the primary root itself stays `OBSIDIAN_VAULT_PATH`. Without `OBSIDIAN_VAULTS_ROOT` the only valid id is `default` and the server is primary-only.
- `MCP_PORT`: host port exposed by Docker.
- `OBSIDIAN_READ_ONLY`: set `true` to disable write/delete/move tools.
- `API_KEY`: optional shared secret for MCP clients.
- `OAUTH_ENABLED`: enables the interactive OAuth 2.1 flow used by ChatGPT web and other remote MCP clients.
- `PUBLIC_BASE_URL`: externally reachable HTTPS origin (for example `https://mcp.example.com`, without `/mcp`). It must route both MCP and OAuth endpoints to this container.
- `TRUST_PROXY`: comma-separated IPs/CIDRs (or Express named ranges) for every proxy peer that can connect directly to the container. With an FRP TCP tunnel, this normally includes the FRP client host as well as any Docker gateway used by another ingress path. Keep `false` without a proxy; `true` is rejected to prevent spoofing IP-based OAuth rate limits.
- `OAUTH_ADMIN_PASSWORD`: strong password used only for `/admin/auth`. It is never accepted by the OAuth consent page.
- `OAUTH_INITIAL_USERNAME` / `OAUTH_INITIAL_PASSWORD`: one-time seed for the first separate OAuth login account. After first startup, manage accounts and rotate passwords in `/admin/auth`; only salted scrypt hashes are stored in the authorization state.
- `OAUTH_ACCESS_TOKEN_TTL_SECONDS` / `OAUTH_REFRESH_TOKEN_TTL_SECONDS`: short-lived access-token and refresh-token lifetimes; refresh tokens rotate on every use.
- `OAUTH_REFRESH_REUSE_GRACE_SECONDS`: bounded replay window for concurrent refreshes from multi-request file connectors; after the window the rotated token is rejected.
- `AUTH_AUDIT_MAX_ENTRIES`: maximum secret-free authorization activity records retained in `/data/oauth/state.json`.
- Authorization transfer fence: `/data/oauth/transfers.json` (schema v1) records an OAuth client authorization transfer and the per-`(client, account)` revocation generation the fence is built on. It holds ids, statuses and timestamps only — never a token, secret or password. Back it up together with `state.json`; a corrupt or self-contradictory file (for example a transfer whose generation record is missing) makes the server refuse to start instead of silently dropping the fence, and a binary that predates the fence must not be rolled back to without first persisting the source revocations. The file is single-writer — run exactly one server process against a `DATA_PATH`. The current-account ceiling re-check applies to the authorization-code exchange; refresh exchanges are not re-checked yet. The Admin clients tab starts and cancels a transfer behind the usual admin session + CSRF, and the projection overlay removes a fenced source from the current relation. See [WEB_AUTH_ARCHITECTURE.md](WEB_AUTH_ARCHITECTURE.md#authorization-transfer-fence) for the route, status mapping and pending wording.
- `AUTH_ADMIN_SESSION_TTL_SECONDS`: idle lifetime of the in-memory authorization-management login.
- `API_KEY_HEADER`: request header name for API key auth. Default is `X-API-Key`.
- `PROTECT_HEALTH`: set `true` if `/healthz` should also require the API key.
- `OBSIDIAN_TIMEZONE`: timezone used for Daily Notes and template variables.
- `SESSION_TTL_MS`: closes abandoned MCP sessions after this idle time. Each live session holds a full MCP server (~3.7 MB RSS on the 87-tool catalog), so raise it together with a session cap; a host that outlives the TTL keeps working through `MCP_SESSION_RECOVERY` instead of seeing `404 Session not found`.
- `MCP_SESSION_RECOVERY`: `stateless` (default) or `off`. Streamable HTTP expects a client that gets `404 Session not found` to start a new session with a fresh `initialize`, but some hosts keep sending the old `Mcp-Session-Id` instead. `stateless` answers such a request once, without registering a session, so one expiry or restart does not disable the rest of that conversation; `off` keeps the strict 404. Authorization, Scope and Vault checks are unaffected. `/healthz` reports `sessionRecovery`: `recovered` (attempts that completed), `failed` (attempts that did not complete — construction, connect or the request itself; a failure before the response starts falls back to the strict 404), `rejected` (attempts never started because the in-flight budget was full), `active` and `maxInFlight`.
- `MCP_SESSION_RECOVERY_MAX_INFLIGHT`: concurrent stale-session recoveries allowed before falling back to the strict 404 (default 64, maximum 256). Each recovery builds one short-lived MCP server (~3.7 MB RSS) and closes it with the response, so the transient ceiling is roughly this value times that figure; lower it on a memory-tight host.
- `VERSION_HISTORY_ENABLED`: save the previous file before every overwrite.
- `GIT_ENABLED`: expose Git tools for a vault that already contains `.git`. Together with the other `GIT_*` values it is the **environment baseline**: the effective configuration of the primary Vault when no per-Vault record has been saved, and the suggested (but disabled) values shown for a secondary Vault.
- `GIT_AUTO_COMMIT`: debounce and commit only paths changed through MCP.
- `GIT_COMMIT_DEBOUNCE_SECONDS`: quiet period before an automatic local commit (minimum 5 seconds).
- `GIT_AUTO_COMMIT_SWEEP` / `GIT_SWEEP_INTERVAL_SECONDS`: every interval (default 900 s, minimum 30), also commit whatever is left in the working tree — changes made through Syncthing, the Obsidian app, or another agent on the host never go through `GIT_AUTO_COMMIT` and would otherwise stay uncommitted indefinitely. Sweep commits use their own neutral message (`chore(obsidian): sweep vault working-tree changes`) and author (`<GIT_AUTHOR_NAME> (auto-sweep)`), are logged as `Git sweep committed <hash> (working-tree commit by auto-sweep; may include pending MCP writes)`, and are reported by `git_status` → `configuration.lastSweep`. The message names the *executor* (the sweep) rather than the content's origin, because a sweep also consumes pending MCP batches and folds those paths into its own commit. Set `GIT_AUTO_COMMIT_SWEEP=false` if the vault must only ever contain MCP-authored commits. The sweep watches the whole tree, so it also commits files no tool wrote (and `.gitignore`d junk stays ignored); a catalogue of surgical edits is still better done through the MCP write tools.
- `GIT_AUTO_PUSH`: push after automatic commits; keep `false` unless unattended credentials are intentionally configured. A failed push never fails the commit: it is logged as `Git push failed [<class>] remote=… exit=… consecutive=…: <summary>` (URL userinfo, `Authorization` headers and token-shaped strings are scrubbed) and exposed as `git_status` → `configuration.push` (`lastOutcome.at` / `pushed` / `failureClass` / `summary`, plus `consecutiveFailures`). Classes: `unreachable`, `auth`, `non-fast-forward`, `no-upstream`, `rejected`, `unknown`.
- `GIT_REMOTE` / `GIT_BRANCH`: default remote **name** and optional branch for pull/push. A per-Vault record may override both; the name rule is the same everywhere (plain git name, never a URL, never credential-bearing), see [ADMIN_VAULT_GIT.md](ADMIN_VAULT_GIT.md#3-configurable-fields-and-bounds).
- `NPM_REGISTRY`: build-time npm registry; use `https://registry.npmmirror.com` on networks where the official registry is slow.
- `EMBEDDING_PROVIDER`: `openai` for the OpenAI-compatible `/v1/embeddings` transport used by the llama.cpp/node-llama-cpp companion embedding service, `ollama` for an explicitly selected `/api/embed` transport, or `disabled` for lexical-only recall. Production currently uses `openai` with `qwen3-embedding-4b-q6`.
- `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL`: provider endpoint and stable model id.
- `EMBEDDING_API_KEY`: optional Bearer token for the embedding service; never store it in vault notes.
- `EMBEDDING_TIMEOUT_MS` / `EMBEDDING_BATCH_SIZE`: request timeout and incremental indexing batch size.
- `EMBEDDING_INDEX_CONCURRENCY`: number of indexing batches sent concurrently; recall uses the last committed snapshot and is not blocked by indexing.
- `EMBEDDING_EDGE_*`: optional preferred edge-PC endpoint for normal/background embeddings. Set `EMBEDDING_EDGE_REGISTRY_URL` to the stable NAS embedding URL to discover DHCP-managed edge workers. Recall is sent once to `EMBEDDING_BASE_URL` with central scheduling enabled by `X-Embedding-Mode: recall`; direct edge configuration is used when no primary provider is configured. `EMBEDDING_EDGE_BASE_URL` remains a fixed-address override.
- `MEMORY_PATH` / `SKILLS_PATH`: managed schema roots. Notes outside these roots remain unrestricted.
- `WEB_CATALOG_ENABLED` / `WEB_CATALOG_DIR`: the Web Explorer's derived SQLite catalog. `WEB_CATALOG_ENABLED=false` makes the v2 routes return `503 catalog-unavailable`. With `WEB_CATALOG_DIR` unset the catalog files live at `<DATA_PATH>/web-catalog/<vaultId>.sqlite` (issue #428; the pre-#428 `cwd/data/web-catalog` default is retired). Two servers given the same effective directory and the same vault id share one file, so isolate independent instances explicitly — see [WEB_OPERATIONS.md](WEB_OPERATIONS.md#web-catalog-directory-issue-428).
- `MAX_VERSIONS_PER_FILE`: retained pre-write versions for each vault file.
- `MAX_TRANSFER_BYTES` / `MAX_INLINE_TRANSFER_BYTES` / `TRANSFER_CHUNK_BYTES` / `TRANSFER_TTL_MS`: hard transfer limit, safe whole-response default, per-call chunk size, and staged-upload lifetime.
- `MAX_ARCHIVE_*`: ZIP input, entry-count, and total expanded-size limits used before extraction.

Git pull uses fast-forward-only mode and refuses a dirty vault. SSH credentials can be placed under `data/ssh/` as a restricted deploy key and `known_hosts`; this directory is mounted read-only into the container. Automatic local commit with manual pull/push is recommended when Obsidian desktop or Syncthing may edit the same vault.

### Git — environment baseline vs per-Vault records

The `GIT_*` variables above are the deployment baseline, not the only source of truth. An operator
can save a configuration for one Vault on the Auth Center page **Vault 与 Git**
(`/admin/auth/vault-git`); the full page reference is [ADMIN_VAULT_GIT.md](ADMIN_VAULT_GIT.md). The
inheritance rules are:

| Vault | Persisted record | Effective configuration | Page shows |
| --- | --- | --- | --- |
| primary | none | exactly the `GIT_*` baseline | `env-default` |
| primary | present | the record; **persisted wins over `GIT_*`** | `persisted` |
| secondary | none | every toggle forced off (`enabled` / `autoCommit` / `autoPush` / `autoCommitSweep`); timing, remote and branch remain visible as suggestions | `default-disabled` |
| secondary | present | the record | `persisted` |

Key points:

- A newly discovered secondary Vault is **disabled by default**. It never inherits
  `GIT_AUTO_COMMIT=true` / `GIT_AUTO_COMMIT_SWEEP=true` from the primary, so discovering a Vault can
  never produce commits or pushes on its own.
- Saving on the page creates a persisted record for that Vault only, and it survives a service
  restart. Other Vaults keep following the matrix above.
- The stored file is `<DATA_PATH>/git-vaults.json` (`/data/git-vaults.json` in the Docker topology).
  It holds configuration only — never a token, password, key or credential-bearing remote URL — and
  is written atomically with mode `0600`.
- Commit identity (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`) and every credential stay
  deployment-level: they are not per-Vault record fields.
- If the store is unreadable or corrupt, Git is disabled fail-closed for the primary Vault rather
  than silently falling back to the environment baseline; see the recovery steps in
  [ADMIN_VAULT_GIT.md](ADMIN_VAULT_GIT.md#61-the-store-is-broken-or-unreadable-fail-closed).

How the Git **tools** consume that configuration (Wave D / D-git):

- `git_status` / `git_diff` / `git_log` / `git_commit` / `git_pull` / `git_push` act on the
  **selected** Vault. With no `vaultId` — or with the primary's id — they keep using the primary
  repository exactly as before; a `vaultId` naming a secondary reads and commits **that Vault's own**
  repository (every Git command runs with the Vault's own root as the working directory) under that
  Vault's own effective configuration above.
- A secondary Vault whose Git is disabled (the default), whose store record is invalid, or whose root
  is not a Git working tree answers with a structured, machine-readable refusal
  (`git_runtime_disabled` / `git_runtime_config_invalid` / `git_runtime_repository_missing`). It never
  reads or commits the primary Vault's repository. An id with no materialized Vault runtime is already
  refused before the tool runs (`vault_unavailable`), and the Git resolver itself refuses such a
  selection (`vault_git_unavailable`) instead of falling back to another Vault's repository.
- Mutations the server routes through Git on a secondary (folder deletion and multi-file plan
  mutations) are auto-committed into that Vault's own repository on that Vault's debounce/max-delay
  values. Commit identity and credentials remain deployment-level for every Vault.
- Known limitation (tracked in the Wave D / D-git handoff): a plain single-file write on a secondary
  (`write_note`, `write_file`, …) still does not feed that Vault's auto-commit batch; use `git_commit`
  for those paths.

### Multi-Vault (多库)

One process serves more than one Vault. `OBSIDIAN_VAULT_PATH` stays the **primary** Vault; every
directory under `OBSIDIAN_VAULTS_ROOT` is discovered as a **secondary**. Discovery is a bounded
`readdir` of that root driven by four triggers — startup, the explicit Admin *刷新 Vault 清单*
action, the directory watcher, and the bounded periodic scan (both of the latter are opt-in, see
below) — never a rescan per request — and the inventory is hard-capped at **64** Vaults;
exceeding that bound fails closed with a visible error instead of silently truncating.

#### Automatic discovery (hot discovery, opt-in)

A new directory under the Vaults root can be picked up **without restarting the container**. This is
**off by default**: set `VAULT_DISCOVERY_ENABLED=true` (and restart) to arm it.

| | `VAULT_DISCOVERY_ENABLED=false` (default) | `VAULT_DISCOVERY_ENABLED=true` |
| --- | --- | --- |
| watcher / periodic scan | not started at all — no `fs.watch` handle, no directory `stat`, no timer | started after the startup round published |
| a new directory under the Vaults root | only picked up by the explicit Admin refresh | picked up within the debounce window (or, at the latest, by the next bounded scan) |
| approval | unchanged | unchanged — see the warning below |

**Discovery is not authorization.** A newly found directory always lands as **`pending`** (visible to
an administrator only); it is not servable, no index/Git/background work starts for it, and an
administrator must approve it before the normal scope / `allowedVaults` rules decide access. Turning
the switch on never grants anything by itself, and turning it back off never revokes an existing
approval.

**Preconditions and boundaries.**

- The parent directory (`WEB_VAULTS_ROOT`, mounted as `/vaults` by `docker-compose.yaml`) must be
  visible **inside** the container. A host directory that is not mounted (or a path this process may
  not read) cannot be discovered: the status reports a diagnostic instead of inventing a Vault.
  Hot discovery cannot cross the Docker mount namespace — mount the parent, not the individual Vaults.
- Only direct children of that configured root are candidates. Two different things must not be
  confused here:
  - the **discovery parent itself** (the configured root) missing or not usable is a watcher
    diagnostic: `VAULT_WATCH_PARENT_MISSING` (does not exist / not mounted) or
    `VAULT_WATCH_PARENT_UNREADABLE` (unreadable, or the path is not a directory — `errno: "ENOTDIR"`);
  - a **file** (or a hidden/symlink entry) *inside* that root is simply not a Vault and produces
    **no** `VAULT_WATCH_*` code at all: the registry records it internally as a skipped entry
    (`not-a-directory`, `hidden-entry`, `symlink-entry`, `invalid-id`, `primary-id`,
    `unresolved-root`) and it never appears in `/healthz`'s `vaultDiscovery.vaults`. Do not go looking
    for a watcher diagnostic for a file under the root — there is none.
- A removed directory becomes `unavailable`; a renamed directory means *old id unavailable + new id
  pending*. An approval is **never** migrated to a new directory or reused by a recycled id.
- A refresh never resets unrelated sessions, open notes or in-flight calls.

**Rolling back.** Set `VAULT_DISCOVERY_ENABLED=false` and restart. The automatic triggers stop; the
admission record (`DATA_PATH/vault-admissions.json`) stays authoritative, so already-admitted Vaults
keep working and `pending`/revoked/deleted ones stay refused. Keep the file — it is what makes the
rollback safe (see the admission-record sections above for backup/recovery).

**Tuning (optional; frozen defaults).** Only read when the switch is on; out-of-range values are
clamped, non-numeric values fall back to the default:

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `VAULT_DISCOVERY_DEBOUNCE_MS` | `500` | 50–5000 | quiet period after the last directory event |
| `VAULT_DISCOVERY_MAX_COALESCE_MS` | `5000` | 500–60000 (≥ debounce) | hard ceiling for one burst: a storm cannot postpone the round past this |
| `VAULT_DISCOVERY_PERIODIC_SECONDS` | `60` | 30–900 | bounded fallback scan interval (the correctness path) |
| `VAULT_DISCOVERY_PERIODIC_MAX_SECONDS` | `900` | 30–900 (≥ periodic) | ceiling for the failure backoff |

**Where to look when it misbehaves.** `GET /healthz` → `vaultDiscovery`:

- `scheduled` — `watcher`/`periodic` (armed), `subscribed` (live watch handles), `triggers.watcher`
  and `triggers.periodic` (rounds attributed to each trigger), `events`/`merged`/`ignored`,
  `currentPeriodicMs` (after backoff), `consecutiveFailures`, `lastOutcome`, `lastSuccessAt`,
  `lastFailureCode`, and `diagnostics[]` with `{ code, at, parentIndex, errno }` — an **ordinal**, never
  an absolute path;
- `vaults[id]` — `admission`, `status` (`pending`/`initializing`/`ready`/`error`/`unavailable`),
  `reason`, `lastSeenAt`, `discoveryMs`, `failureCount`;
- `failures` / `lastError` / `lastSuccessAt` — round-level outcome of the unified reconciliation.

Diagnostic codes: `VAULT_WATCH_PARENT_MISSING` (not mounted / does not exist),
`VAULT_WATCH_PARENT_UNREADABLE` (permissions, or not a directory), `VAULT_WATCH_SUBSCRIPTION_FAILED`,
`VAULT_WATCH_SUBSCRIPTION_ERROR` (the handle died and was closed), `VAULT_WATCH_RECONCILE_REJECTED`,
`VAULT_WATCH_UNKNOWN_EVENT`.

**Known limitation.** A watch handle that stops delivering events *without* reporting an error
(Linux inotify queue overflow, network filesystems that drop events) is not re-subscribed, so
`scheduled.subscribed` can be optimistic about liveness. Correctness does not depend on it: the
bounded periodic scan re-derives the inventory, and it is the path that guarantees convergence. A
re-subscription policy is tracked for the W5 wave.

**`vaultId` is the one selector.** Every Vault-scoped tool accepts an optional `vaultId`:

- omitted — or equal to the primary's id — means the primary Vault and keeps the pre-existing
  behavior byte for byte;
- a secondary id means that Vault's own root, index, history, Trash, plans, transfers and Git
  repository;
- the id rule is the same one the Web app already uses: 1–80 code points, first character a letter
  or digit, no `.` / `..`, no slash, backslash or NUL;
- the primary's id is `WEB_DEFAULT_VAULT` when the Vaults root is configured, otherwise `default`;
  `server_info.defaultVaultId` reports it.

There is deliberately **no** session “current Vault” and no `select_vault` tool: any state that
depends on “the Vault the last call selected” breaks across host reconnects, parallel sessions and
batched calls. The canonical catalog therefore stays **87 tools** — 2 global (`agent_bootstrap`,
`server_info`, which carry no `vaultId`) and 85 Vault-scoped ones. `server_info` is global because it
*reports* the inventory instead of selecting from it.

**Authorization is checked before any Vault I/O.** The credential's allowed-Vault list must contain
the requested id, and a refusal never falls back to another Vault:

| Situation | Result |
| --- | --- |
| id is not in this credential's allowed Vaults | `vault_access_denied` |
| id violates the id rule | `vault_id_invalid` |
| id is not in the registry, or no runtime was materialized for it | `vault_unavailable` |
| search / index / recall face without a materialized runtime | `vault_retrieval_unavailable` |

A broken secondary (unreadable root, invalid record, missing Git repository) fails closed for **that**
Vault and capability only; it is never served by the primary's state.

**Per-Vault data layout.** Primary state keeps its existing paths (nothing is migrated). A
secondary's protected state lives under its own `dataKey` = full `sha256(vaultId)` hex digest, so no
`DATA_PATH` sub-state ever depends on a user-controlled directory name:

| State | Primary (unchanged) | Secondary |
| --- | --- | --- |
| version history | `HISTORY_PATH` (`/data/history`) | `<DATA_PATH>/vaults/<dataKey>/history/` |
| Trash | `TRASH_PATH` (`/data/trash`) | `<DATA_PATH>/vaults/<dataKey>/trash/` |
| retrieval index | `RETRIEVAL_INDEX_PATH` (`/data/index/retrieval-index.json`) | `<DATA_PATH>/vaults/<dataKey>/index/retrieval-index.json` |
| staged uploads | `/data/transfers/uploads/` | `<DATA_PATH>/vaults/<dataKey>/transfers/uploads/` |
| mutation journal | `/data/mutation-journal/` | `<DATA_PATH>/vaults/<dataKey>/mutation-journal/` |
| mutation idempotency | `/data/mutation-idempotency/` | `<DATA_PATH>/vaults/<dataKey>/mutation-idempotency/` |
| Git configuration | the `GIT_*` baseline (or `git-vaults.json`, see the matrix above) | `git-vaults.json` record, default-disabled |
| Publish records | `/data/publish/state.json` | the same file; records are keyed by `vaultId` + path |

`dataKey` is derived from the id and is not Vault identity. The discovery scan itself stays bounded —
one `readdir` of the Vaults root plus a canonical-root check per candidate — and never builds a
Vault's index, arms a Git timer or runs a Git command. Secondary data directories are created on
first use (write / history / Trash), and a secondary's index, retrieval state and Git runtime are
materialized on demand; a secondary with no per-Vault record has Git disabled by default, so being
discovered can never produce a commit or a push.

**Which tool faces are per-Vault in this revision.** Nine of the thirteen canonical capability keys
are wired end to end:

| Capability | Vault-scoped tools it covers |
| --- | --- |
| `notes` | `get_note`, `get_metadata`, `write_note`, `append_to_note`, `patch_note`, `replace_in_note`, `manage_frontmatter`, `manage_tags` |
| `files` | `list_files`, `get_file`, `pull_file`, `pull_note_file`, `write_file`, the upload session tools, `create_archive` / `inspect_archive` / `read_archive_entry` / `extract_archive`, `get_canvas`, `write_canvas`, `manage_folders` |
| `history` | `list_versions`, `restore_version`, `delete_version`, plus the pre-write snapshot every routed write creates |
| `trash` | `list_trash`, `restore_from_trash`, `delete_trash_entry` |
| `plans` | `plan_note_changes`, `plan_move_note`, `plan_delete_note`, `plan_restore_version`, `plan_restore_from_trash`, `get_note_plan`, `apply_note_plan`, `get_note_version`, `compare_note_versions` |
| `git` | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_pull`, `git_push` |
| `memory` | `memory_capture`, `memory_recall` |
| `skills` | `skill_list`, `skill_match`, `skill_validate`, `skill_export`, `skill_import` |
| `publish` | `get_publish_status`, `manage_publish` |

Two further faces are routed per Vault in the same revision **without** flipping a capability key of
their own — that zero-flip is deliberate, see `webCatalog` below:

- The **search / index / link** face (`search_notes`, `list_notes`, `list_recent`, `list_tags`,
  `get_backlinks`, `get_graph`, `get_unresolved_links`, `get_orphans`, `get_deadends`,
  `index_status`, `reindex_vault`, `recall`, `find_related`, `graph_health`, `suggest_links`,
  `get_note_context`) resolves the selected Vault's own index and retrieval state; a selection with
  no materialized search runtime is refused with `vault_retrieval_unavailable` instead of reading the
  primary index.
- The **workflow / Bases** face (`list_bases`, `get_base`, `list_base_views`, `write_base`, `patch_base`, `query_base`, `list_tasks`,
  `update_task`, `daily_note`, `list_templates`, `create_from_template`, `list_properties`,
  `rename_property`, `list_aliases`, `set_property_type`) reads and writes the selected Vault's
  files and its index. It stays out of the capability map on purpose: the MCP Base path does not run
  through the Web catalog runtime, so reporting `webCatalog` (the composite of notes/files/search)
  would be an over-claim.

**Still not multi-Vault (4 keys: `retrieval`, `semantic`, `webCatalog`, `events`).** Read this
narrowly — it is a capability-reporting gap, not four broken toolsets:

- The per-Vault runtime capability map reports these four keys `{available: false, reason: …}`; it
  never guesses `true` and never omits a key. The search composition reports `retrieval` and
  `semantic` from its own per-Vault facts — a Vault whose index is wired reports `retrieval`
  available, and `semantic` follows the shared embedding provider — while `webCatalog` is a
  *composite* of notes/files/search rather than a primitive one face owns, and `events` is an index
  fact reported in that same composition layer. Converging the four keys into one capability graph is
  owned by the convergence slice (contract §31); it is **not** part of this revision.
- `server_info.vaults[].capabilities` currently returns the registry's fail-closed default map:
  **every** key `available: false` with one shared reason, primary included. Do not read that as the
  wiring report yet — the wiring truth is the per-Vault runtime map plus the search composition.
  Closing that gap is tracked with the same §31 convergence.
- MCP resources (`obsidian://vault/index`, `obsidian://vault/tags`, `obsidian://vault/graph`) are
  deliberately **primary-only** and take no `vaultId`; they never read “the Vault of the last tool
  call”.
- Web search: semantic retrieval is available only for the primary Vault; a secondary Web Vault uses
  exact search and says so explicitly.
- Admin *Vault 与 Git*: a secondary's Git runtime facts render as 未知状态 in this revision even
  though its per-Vault Git runtime exists, because the Admin assembly still resolves a runtime for
  the primary only. Wiring the runtime map into that page belongs to the §31 convergence.

API key and OAuth can be enabled together. Existing API-key clients keep working; interactive clients can discover and complete OAuth without receiving the shared API key.

### ChatGPT web OAuth connector

1. Put the service behind a public HTTPS reverse proxy. Forward `/.well-known/*`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/oauth/decision`, the cached-client compatibility endpoints `/authorize`, `/token`, `/register`, `/revoke`, `/admin/auth`, and `/mcp` to the container.
2. Set `OAUTH_ENABLED=true`, `PUBLIC_BASE_URL` to that HTTPS origin, a strong `OAUTH_ADMIN_PASSWORD`, and separate first-login values in `OAUTH_INITIAL_USERNAME` / `OAUTH_INITIAL_PASSWORD`.
3. Recreate the Compose service and confirm `https://<host>/.well-known/oauth-protected-resource/mcp` returns metadata whose `resource` is `https://<host>/mcp`.
4. Add the single MCP URL `https://<host>/mcp` in ChatGPT. The initial challenge asks for read, write, and file scopes. Sign in with an OAuth account, review the three selected scopes, optionally reduce them, and approve. The issued token never exceeds either the client's request or that account's scope ceiling.

Do not expose port 18923 directly to the internet. TLS termination and any network-level rate limiting belong at the reverse proxy; the embedded OAuth endpoints also apply application-level request limits.

Public edge route contract:

| Public path | Edge behavior |
| --- | --- |
| `/mcp` | Proxy Streamable HTTP; disable buffering and allow long-lived GET/POST/DELETE plus OPTIONS |
| `/.well-known/oauth-protected-resource/mcp` | Proxy OAuth protected-resource metadata |
| `/.well-known/oauth-protected-resource` | Proxy root protected-resource metadata |
| `/.well-known/oauth-authorization-server` | Proxy authorization-server metadata |
| `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` | Proxy OAuth endpoints |
| `/oauth/decision` | Proxy OAuth account consent submission |
| `/admin/auth` and subpaths | Proxy authorization-management login and actions |
| `/app` and `/app/*` | Proxy the authenticated Obsidian Web workspace and same-origin assets |
| `/publish/*` | Proxy anonymous opaque Publish links; GET/HEAD only |
| `/auth/login`, `/auth/logout` | Proxy the separate Web account session flow |
| `/api/web/v{1,2}/*` | Proxy authenticated same-origin Web JSON requests (v2 carries explorer tree and search) |
| `/authorize`, `/token`, `/register`, `/revoke` | Proxy compatibility endpoints for connectors with cached legacy discovery; fresh discovery does not advertise them |
| `/admin`, `/healthz`, `/`, all other paths | Return 404 at the public edge |

After any Nginx, FRP, DNS, certificate, or edge-host migration, run the secret-free route check:

```sh
node scripts/verify-public-routes.mjs https://mcp.example.com
```

When moving the canonical public origin, update `PUBLIC_BASE_URL` and recreate the
container only after the new edge host passes the route check. The previous host
may remain as a temporary reverse-proxy compatibility endpoint, but its OAuth
metadata will advertise the new canonical origin. Existing OAuth connectors must
disconnect and authorize again because tokens are audience-bound; API-key clients
can continue through either routed host during the migration window.

### Authorization management

Open `${PUBLIC_BASE_URL}/admin/auth` and sign in with `OAUTH_ADMIN_PASSWORD`. The concise, server-rendered interface uses separate tabs for overview, OAuth accounts, API keys, OAuth clients, OAuth tokens, Publish documents, and audit history. It manages separate OAuth login accounts and their scope ceilings, labeled API keys, registered OAuth clients, access/refresh token status, cross-Vault Publish metadata/revocation, and authorization audit. Publish administration never renders document bodies. Managed keys are displayed only once and are stored as hashes. The configured environment `API_KEY` remains visible as a non-deletable entry and must be rotated in `.env`.

The OAuth Token tab sorts records by creation time, newest first by default, and allows ascending order. Its cleanup action only removes inactive history: revoked, expired, or rotated access/refresh-token records older than the selected retention period. Selecting “all inactive records” uses a zero-day retention period. Active tokens are never removed by cleanup; use the explicit revoke action when an active grant must be invalidated.

Time-window (定时授权) authorization is an optional authorization layer on top of Scope/Vault checks. It is off by default (`AUTHZ_ENABLED=false`, Stage 0); policies are managed in the Admin 定时授权 tab. See the operator guide [AUTHZ_TIME_WINDOWS.md](AUTHZ_TIME_WINDOWS.md) for semantics, subject/capability namespaces and validation. Rollback is turning `AUTHZ_ENABLED` off: the runtime becomes a no-op allow-all and no content capability changes.

### Minimal Obsidian Web workspace

Open `${PUBLIC_BASE_URL}/app` and sign in with an enabled OAuth user account that
has `obsidian.read`. Editing and new-note creation additionally require
`obsidian.write`. The Web session is an `HttpOnly`, `Secure`, `SameSite=Lax`
cookie with its own CSRF token and is separate from OAuth bearer tokens, API
keys, and the admin cookie.

The workspace includes note listing, Obsidian-compatible search, safe Markdown preview,
raw Markdown editing, creation, and optimistic concurrency through note
revisions. The Explorer tree lists Vault folders, Markdown notes, `.base` files
and non-Markdown attachments (an attachment entry carries its lowercase file
extension for the suffix badge). An attachment is indexed by path/name/
extension/mtime/size only: its bytes are never indexed, searched, or projected
into tags/properties/links, and it is served solely through the authenticated
asset route under the same Vault/scope rules. Writes reuse atomic Vault writes,
version snapshots, index invalidation, and Git mutation tracking. Anonymous Web
APIs return 401 and do not expose titles, paths, tags, search hits, or content.
The Vault is never served as a static directory, and Obsidian plugin code is not
executed.

Opening a note updates the address to its deterministic authenticated route at
`/app/note/<route>`. Copying that link does not bypass authentication: login and
the user's current Vault allowlist are checked on every request. Accounts with
`obsidian.write` can Publish or revoke the current note. Publish returns a
high-entropy `/publish/<id>` URL that can be read without login, but only for
that one Markdown document. Publish renders a bounded public-property projection:
by default only `title`, `description`, `tags`, `aliases`, `type`, `status`,
`created`, `updated`, and `date` are exposed. A note may opt in additional
property names with `publish_properties: [name, ...]`; the control property itself
is never rendered. All other frontmatter remains private unless explicitly listed.
Attachments, internal navigation, Vault search/listing/backlinks, and community
themes are not exposed. A moved or deleted source invalidates the URL. MCP exposes the same state via
`get_publish_status` and `manage_publish`, and both tools enforce the token or
API key's `allowedVaults`.

On viewports up to 720 CSS pixels, the bottom status bar is removed and the view
mode control moves to the top bar. Touch controls use a 44 CSS-pixel hit region,
inputs use a 16-pixel font to avoid mobile zoom, and the shell uses dynamic
viewport units plus safe-area insets. SVG icons remain density-independent;
physical device DPI does not require multiplying CSS layout dimensions.

Web and MCP `search_notes` share the same query language. Supported forms are
`path:folder`, `file:name`, `tag:parent`, `content:text`, `line:"same line"`,
`section:"same section"`, `[property]`, and `[property:value]`. Whitespace is
AND, uppercase `OR` creates alternatives, `-term` excludes, quotes preserve a
phrase, and `line:(alpha beta)` / `section:(alpha beta)` require every grouped
term in one line or section. Parent tags match nested tags. Enable the Web
“使用语义” button, call `/api/web/v1/notes?...&semantic=true`, or pass
`semantic: true` to `search_notes` for hybrid retrieval. Structural filters
remain mandatory. Secondary Web Vaults use exact search and explicitly report
that semantic retrieval is available only for the configured primary Vault.

Web sessions are in memory and are revoked by a container restart. Every request
also checks the current account record; disabling, deleting, changing the
password, or changing the permission ceiling invalidates existing Web sessions.

Revoking/deleting a managed key or OAuth client also closes its current MCP sessions. Resetting an OAuth account password, changing its scope ceiling, disabling it, or deleting it revokes grants issued to that account and closes matching client sessions. Audit entries record credential identifiers, timestamps, success/failure, source address, User-Agent and MCP method/tool name. Request arguments, note content, Key/Token values and passwords are never logged.

### ChatGPT and MCP tool metadata

All tools expose an object `outputSchema` that describes the corresponding `structuredContent`; the same result is also serialized into a text content block for clients that do not consume structured results. Safety hints are explicit rather than relying on MCP defaults: read-only operations are idempotent and non-destructive, Vault mutations are closed-world unless they intentionally contact the embedding or Git remote, and destructive operations are marked accordingly. After changing a tool result, update `app/src/tool-contracts.js` and run the test suite so the advertised contract and returned object cannot drift silently.

### Agent-safe note change plans

Use `plan_note_changes` before important or multi-note edits. Existing notes require their current `baseRevision`; new notes require `mustNotExist=true`. The response contains an expiring `planId`, `planHash`, candidate revisions, bounded line diffs, and structured frontmatter/heading/link/tag/task changes without writing the Vault. Apply the reviewed plan with `apply_note_plan` and a unique idempotency key. The server rechecks every revision, stages the batch, and rolls back completed replacements if a later file fails. A timed-out apply may be retried with the same idempotency key.

Use `get_note_version` to inspect one persistent pre-write version and `compare_note_versions` to compare current notes, historical versions, or candidate content. `git_diff` remains the repository working-tree comparison; it does not replace candidate or version comparison. Plans are author-bound, in-memory, and expire after 10 minutes by default.

### Attachments and archives

- Use `pull_file` for a complete MCP embedded resource up to `MAX_TRANSFER_BYTES`, or `get_file` with `offset`/`length` for base64 chunks.
- Use `start_file_upload`, then sequential `upload_file_chunk` calls with the returned offset. Call `file_upload_status` after a connector/session refresh to resume from `nextOffset`. The final chunk sets `finalize=true`; size and optional SHA-256 are checked before an atomic Vault write, and a lost final response can be replayed idempotently.
- Use `create_archive` to make a `.zip`, `inspect_archive` to view its safe manifest, and `extract_archive` first with its default `dryRun=true`. Set `dryRun=false` only after reviewing outputs/collisions.
- Transfer and archive tools cannot access `.git` or `.obsidian`. Regular note APIs remain free to write normal Vault paths and are not forced into a managed attachment directory.

## 2. Start The Server

First run or normal start:

```sh
docker compose up -d --build
```

Watch logs:

```sh
docker compose logs -f obsidian-server
```

Clean source rebuild:

```sh
./scripts/rebuild.sh
```

The production image runs `node server.js` without a file watcher. After testing and staging JavaScript edits under `app/server.js` or `app/src`, run `docker compose restart obsidian-server` to load them. Rebuild when `package.json`, dependencies, or `app/Dockerfile` changes. A Compose command change requires `docker compose up -d --no-build --force-recreate obsidian-server`; this revokes in-memory Web sessions.

For a NAS Docker/Compose project UI, import `docker-compose.yaml` from this repository. It uses the stable Compose project name `obsidian-mcp-server` and local image tag `obsidian-mcp-server:latest`. Remove or stop older projects that also claim the fixed container name before starting this project.

## 3. Check Health

Without protected health:

```sh
curl -sS http://127.0.0.1:18923/healthz
```

With `PROTECT_HEALTH=true` and `API_KEY` set:

```sh
AUTH_HEADER_NAME="${API_KEY_HEADER:-X-API-Key}"
curl -sS -H "$AUTH_HEADER_NAME: $API_KEY" http://127.0.0.1:18923/healthz
```

Expected shape:

```json
{
  "ok": true,
  "vaultPath": "/vault",
  "dataPath": "/data",
  "trashPath": "/data/trash",
  "historyPath": "/data/history",
  "versionHistoryEnabled": true,
  "readOnly": false,
  "apiKeyRequired": false
}
```

## 4. MCP Client Configuration

Use Streamable HTTP transport.

Without API key:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://127.0.0.1:18923/mcp"
    }
  }
}
```

With API key:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://127.0.0.1:18923/mcp",
      "headers": {
        "X-API-Key": "<API_KEY>"
      }
    }
  }
}
```

If a client does not support `headers` in this exact shape, use its HTTP-header configuration UI and add either:

```http
X-API-Key: <API_KEY>
```

or:

```http
Authorization: Bearer <API_KEY>
```

Do not print or paste real API keys into chat logs.

### Author metadata and model switches

Mutating tool calls can carry `_meta["obsidian/author"]` inside MCP request `params`:

```json
{
  "_meta": {
    "obsidian/author": {
      "agent": "codex",
      "model": "gpt-5.6-sol"
    }
  }
}
```

The `agent` must equal the `clientInfo.name` sent during `initialize` when that name is a real client id. Generic names such as `mcp-client` allow an explicit `_meta` or `agent_bootstrap({ client, model })` session author instead. If metadata is omitted, the server adds an author automatically from that client name (or session / `MCP_DEFAULT_AUTHOR_*`) and uses the configured default model (or `unspecified`). A local Node client that wants precise model attribution can use `app/src/author-client.js` and call `wrapped.setModel("<new-model>")` after switching models.

## 5. Protocol Smoke Test

Initialize:

```sh
PORT="${MCP_PORT:-18923}"
AUTH_HEADER_NAME="${API_KEY_HEADER:-X-API-Key}"

curl -sS -i -X POST "http://127.0.0.1:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  ${API_KEY:+-H "$AUTH_HEADER_NAME: $API_KEY"} \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"obsidian-mcp-smoke-test","version":"1.0.0"}}}'
```

Copy the `mcp-session-id` response header, then list tools:

```sh
SESSION="<mcp-session-id>"
PORT="${MCP_PORT:-18923}"
AUTH_HEADER_NAME="${API_KEY_HEADER:-X-API-Key}"

curl -sS -X POST "http://127.0.0.1:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  ${API_KEY:+-H "$AUTH_HEADER_NAME: $API_KEY"} \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

curl -sS -X POST "http://127.0.0.1:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  ${API_KEY:+-H "$AUTH_HEADER_NAME: $API_KEY"} \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Close the session:

```sh
curl -sS -X DELETE "http://127.0.0.1:${PORT}/mcp" \
  -H "mcp-session-id: $SESSION" \
  ${API_KEY:+-H "$AUTH_HEADER_NAME: $API_KEY"}
```

## 6. Troubleshooting

- `401 Unauthorized`: configure the API key header or bearer token.
- `400 Bad Request: initialize first`: send `initialize` before other MCP requests.
- `404 Session not found`: initialize a new session, or rely on `MCP_SESSION_RECOVERY=stateless` (default), which answers one request per stale id without session state. Check `/healthz` `sessionRecovery.{recovered,failed,rejected}` to confirm recovery is doing the work and not failing closed.
- Health works but MCP fails: make sure the client sends `Accept: application/json, text/event-stream`.
- Source edits do not apply: restart `obsidian-server` after staging the source, then check `docker compose logs -f obsidian-server` and `/healthz`. Production should run `node server.js` without `--watch`.
- Vault writes fail: check `OBSIDIAN_READ_ONLY`, vault permissions, and the host path in `OBSIDIAN_VAULT_PATH`.
- Stale writes fail with `Revision conflict`: read the note/file again and retry with its latest `revision` as `ifMatch`.
- Daily Note date is off by one day: set `OBSIDIAN_TIMEZONE` and recreate the container so the compose environment is applied.
- A Base filter or formula is rejected: `query_base` supports the safe portable subset described by its tool schema, including the `file.asLink(if(property, property, file.name))` formula subset; use `get_base` for unsupported official or plugin-defined formulas.
