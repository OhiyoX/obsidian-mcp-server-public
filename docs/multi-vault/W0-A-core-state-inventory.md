# W0-A — Core path/state inventory (multi-vault characterization)

- Lane: W0-A of contract `Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
  §25 (Wave 0 — characterization only), §43 (architecture tests), §44 (old-red).
- Repository: `OhiyoX/obsidian-mcp-server` · branch `test/mv-w0a-core-state-inventory` · worktree `scratch/multi-vault/W0A/worktree`.
- **BASE_SHA** (frozen) = `6dc8154c6843c426ad40d136ef43e4d1d79d2790` (= `origin/main`, 2026-10-05 20:10 +0800; `git fetch` at start: 0 ahead / 0 behind → no rebase).
- **Zero behavior change.** This lane only adds files: this document, `app/test/multi-vault-core-state-inventory.test.js`, and lane evidence outside the repo.
- Machine-checked twin: `app/test/multi-vault-core-state-inventory.test.js`. Every list below is asserted there (importer sets, DATA_PATH substates, module-state anchors, greenfield markers, config path derivation). **Wave A/B must change both files in one commit.**

## 0. Method and instruments

| # | Instrument | What it does |
|---|---|---|
| I1 | `parseImports()` in the test file | Static ES-import parser. Strips comments, blanks string/template bodies that are not `from "…"`/`import "…"` specifiers, then matches `import [clause] from "specifier"` with a clause that may span lines but never quotes/semicolons. Returns default + named bindings. |
| I2 | `mentionedInCode()` | **Independent** control: word-token scan of every line that is not a `//`/`*` comment line in `app/src/**`, asserting no file mentions a frozen identifier in code without importing it (catches an importer hidden from I1, e.g. by a scanner blind spot). |
| I3 | `path.join(DATA_PATH|dataPath, "<literal>")` regex over comment-stripped source | DATA_PATH sub-state literals and their owning modules. |
| I4 | Anchor matching (`includes` on whitespace-collapsed comment-stripped source) | Module-level state declarations; exact text anchors, so a rename/removal fails the ratchet. |
| I5 | Subprocess `import('./src/config.js')` with controlled env | Machine-verifiable version of contract §1.1 / §5.1 primary legacy path derivation. |

Known limits of I1: template bodies (including `${…}` substitutions) are treated as opaque, and regex literals are not modelled; both can only *hide* text, never invent an import. I2 covers the frozen names against that blind spot. All anchor/scans are static source facts — no runtime import side effects, no process spawned to inspect state (except I5).

Manual re-verification commands (lane evidence in `scratch/multi-vault/W0A/log-*.txt`):

```sh
cd app && node --test test/multi-vault-core-state-inventory.test.js
grep -rn "\bVAULT\b" --include=*.js src/ | grep -v '^src/config.js'
```

## 1. Matrix 1 — global path constants → importers

Definitions (all in `app/src/config.js`):

| Constant | Definition |
|---|---|
| `VAULT` | `app/src/config.js:26` (`VAULT_PATH` or `/vault`) |
| `DATA_PATH` | `app/src/config.js:27` (`DATA_PATH` or `/data`) |
| `TRASH_PATH` | `app/src/config.js:28` (`TRASH_PATH` or `DATA_PATH/trash`) |
| `HISTORY_PATH` | `app/src/config.js:29` (`HISTORY_PATH` or `DATA_PATH/history`) |
| `RETRIEVAL_INDEX_PATH` | `app/src/config.js:56` (`RETRIEVAL_INDEX_PATH` or `DATA_PATH/index/retrieval-index.json`) |
| `MEMORY_PATH` / `SKILLS_PATH` | `app/src/config.js:76–77` (from `vaultLayout`, i.e. vault-relative) |
| `WEB_VAULTS_ROOT` | **exported by config.js as a helper since Wave F / F1** — see §1.7 |

Usage class per import site: **read** (reads/inspects), **resolve** (maps a user path into an absolute path / containment), **mutate** (mkdir/write/rename/unlink under it).

### 1.1 `VAULT` — 7 importers

| Importer | Import site | Uses (file:line) | Class |
|---|---|---|---|
| `src/vault.js` | `:7–19` (**multi-line import**) | `:53` `assertInsideVault`, `:83` `assertCanonicalInsideVault`, `:94` root guard, `:100` `resolveVaultPath`, `:108` `resolveCanvasPath`, `:114` `toVaultPath`, `:356` walk root default, `:481–482` `mkdir`+`access R_OK`, `:485` `access W_OK`, `:488/:492` health payload | resolve + read + mutate |
| `src/git.js` | `:16` | `:54` `gitBaseArgs()` → `safe.directory` + `-C VAULT`, `:93–94` `normalizeGitPath` containment | resolve + mutate (git cwd) |
| `src/batch-journal.js` | `:5` | `:88` `path.resolve(VAULT, item.path)` recovery target | resolve (recovery) |
| `src/app/vault-registry.js` | `:5` | `:16` `DEFAULT_ID` from `path.basename(VAULT)`, `:33` canonical containment of primary root, `:42/:49/:51` primary record + fallback | resolve + read |
| `src/app/auth-routes.js` | `:11` | `:35,:46,:48` primary root fallback for Web auth views | read |
| `src/app/themes.js` | `:3` | `:61,:74,:90,:109,:117` default `vaultRoot = VAULT` for Web theme reads | read |
| `src/app/attachments.js` | `:9` | `:60` default `vaultRoot = VAULT` for Web attachment resolution | read + resolve |

Comment-only mentions (correctly excluded, verified by I2): `src/base-query.js:6`, `src/app/web-catalog/runtime.js:178`, `src/app/web-catalog/note-reader.js:5`.

### 1.2 `DATA_PATH` — 10 importers

| Importer | Import site | Derived state (file:line) | Class |
|---|---|---|---|
| `src/vault.js` | `:8` | `:484` `mkdir`, `:486` `access W_OK`, `:488/:493` health payload | read + mutate |
| `src/batch-journal.js` | `:5` | `:10` `root = DATA_PATH/mutation-journal` | mutate |
| `src/file-transfer.js` | `:27` | `:56` `LEGACY_UPLOADS_PATH = DATA_PATH/transfers/uploads` — the literal is now only the **primary parity ratchet**: the A7 mapping owns the value and the facade refuses to boot if the two drift (`:78`). The root actually consumed is `vaultRuntime.paths.transfersUploads` (Wave B / B5) | mutate |
| `src/git.js` | Wave B / B4 | primary GitRuntime's A5 store (contract §15): `createGitConfigStore({ dataRoot: DATA_PATH })` → `DATA_PATH/git-vaults.json`; passed as `dataRoot`, so this file adds no `path.join(DATA_PATH, "…")` literal (§2, §6.4) | read + mutate (store; E is the writer) |
| `src/mutation-idempotency.js` | `:4` | `:6` `root = DATA_PATH/mutation-idempotency`, `:27–32` realpath containment | read + mutate |
| `src/oauth-provider.js` | `:6` | `:470` `DATA_PATH/oauth/state.json` | mutate |
| `src/publish/service.js` | `:4` | `:8` `DATA_PATH/publish/state.json` | mutate |
| `src/release-version.js` | `:3` | `:14` `DATA_PATH/deployed-version.json` | read |
| `src/app/route-metrics.js` | `:21` | `:56` `DATA_PATH/route-metrics.json` (or `WEB_ROUTE_METRICS_FILE`) | mutate |
| `src/app/web-catalog/runtime.js` | `:11` | `:46` `dir = path.join(DATA_PATH, "web-catalog")` — the **#428** default for the derived catalog (a truthy `WEB_CATALOG_DIR` still wins and keeps its cwd-relative interpretation) | read + mutate (opens the SQLite store) |

Outside `app/src/**` (not part of the src scanner, asserted by anchor): `server.js:21` → `:94` `DATA_PATH/web/sessions.json`, `:86` `createAccessPolicyWiring({ dataPath: DATA_PATH })`.

### 1.3 `TRASH_PATH` — 2 importers

| Importer | Import site | Uses | Class |
|---|---|---|---|
| `src/vault.js` | `:17` | `:147–148` `resolveTrashPath` + containment, `:153` `toTrashPath`, `:373` `path.join(TRASH_PATH, timestamp, rel)` backup target, `:380` `mkdir`, `:384,:412,:430,:458` canonical containment, `:462` empty-parent pruning, `:488/:494` health | resolve + mutate |
| `src/batch-journal.js` | `:5` | `:92–98` recovery trash/consume targets, `:125` canonical check, `:275–276` `mkdir` + `realpath` root | resolve + mutate (recovery) |

Wave D / D-files **removed** `src/batch-write.js` as an importer (rule 2, tightening): its
pre-commit trash-source containment check (`assertTrashSource`) now runs against the *request's*
Vault trash root (`currentLocalFs().trashRoot`, contract §10.1/§13.4) delivered by
`src/vault-runtime/request-vault.js`, so a secondary mutation can never be validated against — or
spill into — the primary Vault's trash. `src/batch-journal.js` keeps the global constant because
B6's per-Vault journal scope still needs the legacy primary fallback for primary/schema-1
journals (`scopeRoots`); see §2.

### 1.4 `HISTORY_PATH` — 2 importers

| Importer | Import site | Uses | Class |
|---|---|---|---|
| `src/vault.js` | `:10` | `:227–237` `createVersionSnapshot` (mkdir + copy + prune), `:243–251` `listFileVersions`, `:257–263` `readFileVersion`, `:279–282` `restoreFileVersion`, `:468–475` `deleteFileVersion` + prune, `:488` health | read + mutate |
| `src/batch-journal.js` | `:5` | `:309–316` recovery version-snapshot write | mutate (recovery) |

### 1.5 `RETRIEVAL_INDEX_PATH` — 1 importer

| Importer | Import site | Uses | Class |
|---|---|---|---|
| `src/vault.js` | Wave B / B1 | compatibility facade: feeds the A7 primary `vaultDataPaths` mapping (`retrievalIndex`) for `primaryRuntime.paths`; nothing reads it directly | resolve (facade) |

Wave B / B3 **removed** `src/retrieval.js` as an importer (rule 2, tightening): the per-Vault
runtime reads the index path from `vaultRuntime.paths.retrievalIndex` (A7), and the facade
exposes the primary A7 mapping (`primaryRuntime.paths.retrievalIndex`) as its index path. The
new modules `src/vault-runtime/retrieval-runtime.js` / `retrieval-rank.js` import no global path
constant at all (§43-5), asserted by `app/test/retrieval-runtime.test.js`; see §6.2.

### 1.6 Vault-derived layout paths (extension beyond the brief's six)

| Constant | Importers | Uses |
|---|---|---|
| `MEMORY_PATH` | `src/agent-bootstrap.js:1`, `src/tools/intelligence.js:4` | `agent-bootstrap.js:45,:52` onboarding text; `intelligence.js:94,:101,:102,:110,:116,:118` `memory_capture`/`memory_recall` managed root |
| `SKILLS_PATH` | `src/agent-bootstrap.js:1`, `src/skills.js:11`, `src/tools/intelligence.js:4` | `agent-bootstrap.js:46,:53`; `skills.js:39,:40,:164,:165,:185,:192,:251` skill root resolution; `intelligence.js:136` `skill_match` prefix |

These are vault-relative (`vaultLayout`, `app/src/vault-layout.js:46` reads `VAULT_WORKSPACE_ROOT`), so they follow the primary Vault today and are isolation candidates too.

### 1.7 `WEB_VAULTS_ROOT` / `WEB_DEFAULT_VAULT` — Wave F / F1: now a single `config.js` read point

The brief lists `WEB_VAULTS_ROOT` among "constants from `app/src/config.js`". On the W0-A BASE it was **not** one; the Wave F / F1 convergence (contract §31, debt D2) closed that gap and the same change also removed the last inline read from `server.js`:

| Where | Before | After (Wave F / F1) |
|---|---|---|
| `src/config.js` | — | **the single read point**: `configuredWebVaultsRoot()` / `configuredWebDefaultVault()` |
| `src/app/vault-registry.js` | `:14–:16` raw env read | imports the helper (`:15–:18`); the canonical A2 instance is exported as `webVaultRegistry` (§31/D1) |
| `src/oauth/primitives.js` | `:9`, `:65` raw env read | imports the helper |
| `src/vault.js` | `:41` raw env read (Wave B / B1) | imports the helper — byte-identical derivation to `oauth/primitives.js` (`DEFAULT_VAULT_ID`), still ratcheted by `app/test/vault-runtime-factory-core.test.js` |
| `app/server.js` | `:180` `String(process.env.WEB_VAULTS_ROOT \|\| "").trim()` passed to the Admin assembly | **gone**: `server.js` injects the exported canonical registry, which already owns the root |

The helpers are functions rather than frozen constants so each consumer still evaluates them at its own module load — the frozen module-load semantics (and the `?cache-buster=` fixture pattern several suites use) do not change. The machine-checked ratchet therefore **tightens**: `FROZEN.envReaders` is now `{ WEB_VAULTS_ROOT: ["src/config.js"], WEB_DEFAULT_VAULT: ["src/config.js"] }` (one reader instead of three), and `FROZEN.configImporters` gains both helpers with exactly the three former readers.

`src/app/web-catalog/note-reader.js:5` mentions `WEB_VAULTS_ROOT` only in a comment. Contract §4.1 expects the registry to read current primary/secondary root config without renaming env vars; that stays true, and the primary-root/secondary-root asymmetry now lives in one module.

## 2. Matrix 2 — DATA_PATH sub-state → owner

Scan: `path.join(DATA_PATH|dataPath, "<literal>")` over `app/src/**` (I3), plus anchor-asserted indirect owners.

| Sub-state (under `DATA_PATH`) | Declared at | Read/write modules | Notes |
|---|---|---|---|
| `trash/` | `config.js:28` (default `DATA_PATH/trash`) | `vault.js`, `batch-journal.js` (Wave D / D-files: `batch-write.js` reads the trash root from the request's VaultRuntime instead of the global constant) | primary legacy trash root (contract §5.1) |
| `history/` | `config.js:29` | `vault.js`, `batch-journal.js` | version snapshots (`.bak`) |
| `index/` | `config.js:56` (`index/retrieval-index.json`) | `retrieval.js` | single retrieval index file |
| `transfers/` | `file-transfer.js:56` (`transfers/uploads`) | `file-transfer.js`, `vault.js` (Wave B / B1: facade derives the A7 `transfersUploads` path; Wave B / **B5**: the transfer facade now *consumes* `vaultRuntime.paths.transfersUploads`, and the literal survives only as the primary parity ratchet) | `<uploadId>.json` metadata (carries `vaultId` since B5) + `<uploadId>.part` |
| `mutation-journal/` | `batch-journal.js:10` | `batch-journal.js`, `batch-write.js`, `vault.js` (Wave B / B1: A7 `mutationJournal`) | one directory per batch, `manifest.json` + `backup-N` |
| `mutation-idempotency/` | `mutation-idempotency.js:6` | `mutation-idempotency.js`, `batch-write.js` (`readAppliedRecord`), `vault.js` (Wave B / B1: A7 `mutationIdempotency`) | `<sha256>.json` applied records; `lastPrunedAt` module state |
| `git-vaults.json` | Wave B / B4: `src/git.js` → `createGitConfigStore({ dataRoot: DATA_PATH })` (A5 `git-config/store.js:36` holds the `FILE_NAME` constant, not a `path.join(DATA_PATH, …)` literal) | `git-config/store.js` / `git-config/schema.js`; writer is Wave E's Admin (contract §15/§17) | per-vault Git config records + revision/CAS; corrupt file fails closed; no secrets (SEC-MV04) |
| `oauth/` | `oauth-provider.js:470` | `oauth-provider.js` | `oauth/state.json` (clients/accounts/tokens/audit) + `oauth/transfers.json` (#364 fence, schema v1; derived from the state file's directory by `src/oauth/authorization-transfer-methods.js`, so it adds no new `DATA_PATH` literal owner) |
| `publish/` | `publish/service.js:8` | `publish/service.js` | `publish/state.json`; records already carry `vaultId` (`service.js:18` `documentKey`) |
| `access-policy.json` | `access-policy/server-wiring.js:19` (via injected `dataPath`) | `access-policy/store.js` | AuthZ policy file; env-gated |
| `route-metrics.json` | `app/route-metrics.js:56` (or `WEB_ROUTE_METRICS_FILE`) | `app/route-metrics.js` | process-wide ops metrics, persisted in `DATA_PATH` |
| `deployed-version.json` | `release-version.js:11,:14` (`MANIFEST_FILE`) | `release-version.js` | written by `scripts/nas_deploy.py` |
| `web/sessions.json` | `server.js:94` | `app/web-session-store.js` | Web session store |
| `web-catalog/` | `app/web-catalog/runtime.js:46`: `WEB_CATALOG_DIR` (truthy; a relative value resolves against the process cwd) else `DATA_PATH/web-catalog`, file `${vault.id}.sqlite` | `app/web-catalog/runtime.js` | per-vault by file name. **#428** retired the old `process.cwd()/data/web-catalog` default, which made every same-cwd server with the same vault id share one file; production compose keeps its explicit `WEB_CATALOG_DIR=/data/web-catalog` (`docker-compose.yaml:29`), so its path is unchanged |

## 3. Matrix 3 — mutation lock / serialization points

| Mechanism | Site | Semantics |
|---|---|---|
| `mutationTail` promise chain | **moved by Wave B / B1** to `app/src/vault-runtime/local-fs.js` (`createLocalFs`, closure-local `let mutationTail = Promise.resolve()`) | FIFO mutex per runtime instance: the callback starts only after the previous release; `finally { release() }` guarantees no poisoned queue. Same-Vault mutations stay serial (MV-I01) while two runtimes run in parallel (MV-I02); the `src/vault.js` facade binds the primary instance, so startup/recovery (`batch-journal.js`) keeps taking the primary lock, while Wave D / D-files moved `batch-write.js`'s batch lock onto the *request's* runtime (`request-vault.js`), so a secondary batch serializes against that secondary only. **Not** cross-process (no lock file, no flock). |
| `atomicWriteFile` | `app/src/vault.js:221` (`withMutationLock(() => atomicWriteFileUnlocked(...))`) and `:194–219` unlocked body | Single-file write: history snapshot → revision check → temp file `.…obsidian-mcp-<uuid>.tmp` in the same directory → `rename` → `trackGitMutation`. Lock is re-entrant-by-ownership only through the unlocked twin. |
| Batch write boundary | `app/src/batch-write.js` (`withMutationLock(...)` — Wave D / D-files: the request runtime's lock), `recoverPendingBatchesUnlocked()`, `:28–32` idempotency pre-check, `:34` `beginBatchJournal`, `:37–47` stage temps + revision checks, `:48` state `committing`, `:49–55` rename/unlink loop, `:56–67` `committed` + `finishBatchJournal` | Holds the same single mutex for the whole batch; journal manifest is durable before any Vault file is staged or renamed. |
| Journal recovery lock | `app/src/batch-journal.js:399–400` (`recoverPendingBatches()` → `withMutationLock(recoverUnlocked)`); `:404` exports `recoverPendingBatchesUnlocked` for callers already holding the lock | Startup/recovery takes the same mutex; the `Unlocked` variant exists precisely because `atomicWriteBatch` already holds it (`batch-write.js:27`). |
| Journal root | `app/src/batch-journal.js:10` `const root = path.join(DATA_PATH, "mutation-journal")` | Module-level constant — one journal root for the whole process. |
| Idempotency root | `app/src/mutation-idempotency.js:6` `const root = path.join(DATA_PATH, "mutation-idempotency")` | Same: one root per process; `lastPrunedAt` (`:7`) throttles pruning globally. |
| Web note write lock (separate plane) | `app/src/app/vault-registry.js:268` `webNoteWriteLocks`, `:270–298` key = canonical root + note path | Web-only per-(root,path) promise chain; explicitly **not** cross-process CAS (comment `:251–267`; "NOT cross-process compare-and-swap" at `:264`). MCP writes do not take it. |

Consequence for multi-vault: the MCP mutation mutex, journal root and idempotency root are all process-global, so two Vaults are serialized against each other and share one recovery namespace today.

## 4. Matrix 4 — module-level singleton state (per-vault isolation candidates)

Each row: variable(s) → declaration `file:line` → lifecycle. All are process-lifetime; nothing is persisted except where noted. Frozen as exact anchors in the test.

### 4.1 Git — **moved by Wave B / B4** to the per-vault `GitRuntime`

On the Wave A BASE the ten bindings below were module-level in `src/git.js` / `src/git-push-observability.js`
(git.js line anchors: `pendingPaths:28`, `pendingAuthors:29`, `commitTimer:30`, `maxDelayTimer:31`,
`sweepTimer:32`, `pendingSince:34`, `lastSweep:35`, `operationQueue:36`, `imminentFlushFor:39`,
`maxDelayDeadlineAt:41`, `maxDelayKind:42`; observability `lastOutcome`/`consecutiveFailures:44–45`).
They now belong to one `GitRuntime` instance (contract §16, §44 item 8):

| State | Pre-migration site | New owner |
|---|---|---|
| `pendingPaths` / `pendingAuthors` / `pendingSince` | `src/git.js:28,29,34` | `src/git-runtime/pending.js` (`GitPendingBatches`, per instance; `paths()`/`authors()`/`since`) |
| `commitTimer` | `src/git.js:30` | `src/git-runtime/timers.js` (`GitTimerController`, per instance) |
| `maxDelayTimer` + `maxDelayDeadlineAt` / `maxDelayKind` / `imminentFlushFor` | `src/git.js:31,41,42,39` | `src/git-runtime/timers.js`, same W0-D §2 cadence (oldest-start deadline, one imminent retry) |
| `sweepTimer` | `src/git.js:32` | `src/git-runtime/timers.js`; one interval per runtime, reconciled on §16.3 reload |
| `lastSweep` | `src/git.js:35` | private instance field, exposed via `status()` |
| `operationQueue` | `src/git.js:36` | private instance field (`#enqueue`), one serialized queue per runtime |
| `lastOutcome` / `consecutiveFailures` | `src/git-push-observability.js:44–45` | `createPushHistory()` in `src/git-push-observability.js`, one history per runtime |

Behavior (W0-D §1–§10) is unchanged: `src/git.js` is now the §43-5 compatibility facade that builds
the primary runtime from A5's store + the `GIT_*` baseline and keeps every legacy export (#255/#265
included). See §6.4 and `app/test/git-migration-{config-wiring,isolation}.test.js`; the pre-migration
semantics stay frozen by `app/test/multi-vault-git-characterization.test.js`.

### 4.2 Vault index (`vault-index.js` → per-Vault instance)

**Moved by Wave B / B2 (2026).** On the Wave A BASE the nine anchors `noteCache:7` (`Map` of parsed
notes), `lastRefresh:8`, `indexBuilt:9`, `lastStats:10`, `vaultGeneration:23` (build fence token),
`publicationRevision:24`, `snapshotGeneration:25`, `snapshotIdentity:26`, `buildTail:36` (single build
lane) were module-level, and `getCachedVaultIndex():362` / `invalidateVaultIndex():372` /
`getVaultIndexStats():400` were the process-wide accessors. They now live inside the
`createVaultIndexRuntime({ vaultRuntime, deps })` factory closure in
`src/vault-runtime/vault-index-runtime.js` — one instance per Vault (contract §11, §43-7) — and
`src/vault-index.js` is the §10.1 / §43-5 compatibility facade around the primary instance. The
original comment survives verbatim on the instance state: all four freshness counters are
process-local, reset on restart, never persisted, never comparable across processes. The frozen
`FROZEN.singletons["src/vault-index.js"]` entry was deleted in the same commit (§6.2) because the
state is closure-local now — no anchor was relaxed, and the new modules reject module-level index
state explicitly.

### 4.3 Retrieval (`retrieval.js`) → **migrated by Wave B / B3**

BASE held `state:19` (parsed index), `loading:20`, `operationQueue:21` (serializes index jobs),
`activeIndexJob:22`, `lastRefreshAt:23` (10 s throttle, `:268`), `pendingIndexOptions:24`
(coalesced follow-up), `refreshTimer:25` + `refreshTimerOptions:26` (debounced refresh,
`:274–277`) — contract §1.6 / §44-5: one state and one `RETRIEVAL_INDEX_PATH` for the whole
process.

**Current fact (Wave B / B3):** those eight bindings are **gone from module scope**. They live in
the `createRetrievalRuntime` closure of `src/vault-runtime/retrieval-runtime.js` — one instance per
Vault, with the index file taken from `vaultRuntime.paths.retrievalIndex` (A7). `src/retrieval.js`
is now a compatibility facade whose exports *are* the primary instance's methods. Its
`FROZEN.singletons` anchor was therefore deleted (rule 3); the absence ratchet for the new modules
is `app/test/retrieval-runtime.test.js` (no module-level `let`/`var`, no module-level container, no
`config.js`/`process.env`, no global path constant).

### 4.4 Mutation plans / idempotency / journal

`plans:33` (`Map`, `MAX_PLANS = 200` at `:36` evicting the oldest at `:59`, TTL 10 min at `:35`), `appliedIdempotency:34` (in-memory replay marker); `mutation-idempotency.js:7 lastPrunedAt` (throttle for the persisted record pruning); `batch-journal.js:10 root` (persisted journal root).

### 4.5 Web (already per-vault where it matters)

| State | Site | Lifecycle / isolation |
|---|---|---|
| `runtimes` (`Map`) | `src/app/web-catalog/runtime.js:191` | **keyed by `vault.id`** — the only existing per-vault runtime registry; `runtimeFactory:192` is the test seam. `getWebCatalogRuntime(vault)` (`:216`), `getWebCatalogRuntimeById` (`:228`), `closeWebCatalogRuntime` (`:232`), per-vault sqlite path `catalogFileFor` (`:50–52`), location resolver `resolveWebCatalogLocation` (`:43–49`, #428) and the once-per-open line `describeWebCatalogOpen` (`:56–58`). **This is the reusable precedent for `VaultRuntime` (contract §1.3).** |
| `watchers`, `watcherGenerationSeq`, `watcherRefs`, `pending`, `coverageGaps` | `src/app/live-events.js:30,32,33,35,37` | keyed by vault id for watcher state (`releaseVaultWatcher`, coverage gaps) |
| `webNoteWriteLocks` | `src/app/vault-registry.js:268` | per-(canonical root, path) promise chain (Web writes only) |

### 4.6 Other process-wide state found by the scan (not per-vault candidates but relevant to §43-5/6/7 audits)

| State | Site | Note |
|---|---|---|
| `bySession`, `byAuthClient` | `src/session-author.js:9–10` | author attribution per MCP session/client; auth plane |
| `shared` | `src/app/route-metrics.js:325` | process-wide metrics store (`getRouteMetrics()`), persisted to `DATA_PATH/route-metrics.json` |
| `defaultClient` | `src/embeddings.js:173` | one embedding client for the process (provider config from env) |
| `cached` | `src/release-version.js:11` | deploy manifest read cache (static fact, not per-vault) |
| `viewStore`, `defaultOperatorConfig` | `src/discovery-runtime.js:32–33` | tool-discovery ALS view + operator config |
| login failure map | `src/oauth-provider.js:49` (`this.loginFailures`) | **instance** state inside the OAuth service, not module-level |

Fact correction to the brief: `app/src/auth.js` has **no** module-level mutable collections. It only freezes constant sets (`VAULT_SCOPED_TOOLS:62`, `HARD_REVOKE_CAPABILITIES:120`) plus env-derived constants. Anything per-request there is passed explicitly.

### 4.7 Greenfield markers (goal, not fact)

**Empty as of Wave A3** — `FROZEN.greenfieldAbsent` is `[]`. Both original markers are now established modules: `src/vault-runtime/` by **Wave A1** (`app/src/vault-runtime/descriptor.js`, pure module) and `app/src/vault-scope.js` by **Wave A3** (canonical tool vault-scope registry, pure module, no consumer yet). Each lane flipped its entry in the same commit as this row.

Reciprocal allowlist facts (contract §43-5), each asserted by its lane's test:

- A1: `descriptor.js` imports only `node:crypto`, `node:fs/promises`, `node:path` — not the global path constants (`app/test/vault-runtime-descriptor.test.js`).
- A3: `vault-scope.js` imports only the `TOOL_NAMES` binding from `./config.js` and the `MAX_VAULT_ID_LENGTH` bound from `./vault-runtime/descriptor.js` — never `auth.js`, never `app/**`, never `process.env`, never a global path constant (`app/test/vault-scope.test.js`). Closing this entry therefore adds no new importer of `VAULT`/`DATA_PATH`/`TRASH_PATH`/`HISTORY_PATH`/`RETRIEVAL_INDEX_PATH` to the frozen sets above.

## 5. Consistency with contract §1 (source facts, re-verified on BASE)

| Contract claim | Result |
|---|---|
| §1.1 core Vault is a global singleton (`config.js` exports + `vault.js` direct use) | confirmed — matrix 1; `vault.js` is the dominant consumer |
| §1.2 Web already has a real local multi-Vault registry; primary write still uses global `atomicWriteFile` | confirmed (`app/vault-registry.js:33,42,49`; `themes.js`/`attachments.js` default to `VAULT`) |
| §1.3 Web Catalog already per-vault, closest reusable precedent | confirmed — `web-catalog/runtime.js:167` keyed by `vault.id` |
| §1.4 MCP allowlist only covers Publish | confirmed — `app/src/auth.js:62` `VAULT_SCOPED_TOOLS` = `{get_publish_status, manage_publish}` |
| §1.5 request context has no Vault | confirmed (not in W0-A scope; owned by A4/#285) |
| §1.6 index/retrieval are process singletons | confirmed — §4.2, §4.3 |
| §1.7 mutation/recovery confused-deputy risk | confirmed — §4.4 + matrix 3 single roots |
| §1.8 upload handle has no vaultId | confirmed at the storage layer (`file-transfer.js:27` one uploads root); handle metadata is W0-C's scope |
| §1.9 Git sweep/push observability exists but is process-global | confirmed — §4.1 |

Deviations from the **brief** (not from the contract): the Web Catalog data dir uses its own env var rather than `DATA_PATH` (§2, last row) — Wave F / F1 resolved the earlier `WEB_VAULTS_ROOT` deviation (§1.7).

## 6. How to update this freeze (Wave A/B)

1. Edit the matching entry in `FROZEN` (`app/test/multi-vault-core-state-inventory.test.js`) **and** the corresponding table row here in the same commit; the test intentionally fails otherwise.
2. New importer of a global path constant → add to `FROZEN.configImporters` only when the module is a transitional compatibility facade on the contract §43-5 allowlist; a *new* Vault-dependent module importing them is an architecture violation, not an allowlist update.
3. Moving a singleton into a per-vault runtime → delete its anchor from `FROZEN.singletons` and record the new owner (e.g. `vault-runtime/runtime.js`) here.
4. Secondary data layout (contract §5.2) → `FROZEN.dataPathLiterals` gains the `vaults/<dataKey>/…` layout entries when A7/B-lanes land.

### 6.1 Applied by Wave B / B1 (compatibility facade)

Lane B1 (branch `feat/mv-b1-local-fs-runtime`) applied rule 2 + rule 3 above in one commit with
this document and the test, and changed **no behavior**:

| Ratchet | Change | Why |
|---|---|---|
| `configImporters.RETRIEVAL_INDEX_PATH` | `+ src/vault.js` | the facade feeds the A7 primary `vaultDataPaths` mapping (§1.5) |
| `envReaders.WEB_VAULTS_ROOT` | `+ src/vault.js` | `PRIMARY_VAULT_ID`, derived exactly like the auth plane's `DEFAULT_VAULT_ID` (§1.7) |
| `dataPathLiterals.transfers` / `.mutation-journal` / `.mutation-idempotency` | `+ src/vault.js` | same A7 mapping; those derivations are scheduled to collapse onto `runtime.paths` when lanes B2/B5/B6 consume it (§2) |
| `singletons["src/vault.js"]` | **removed** | the lock is now `vault-runtime/local-fs.js`'s closure-local `mutationTail` (per instance, not module-level) — rule 3 (§3, matrix 3) |

New modules: `src/vault-runtime/local-fs.js` (root-bound service, §10), `src/vault-runtime/runtime.js`
(canonical `VaultRuntime` factory, §5). `src/vault.js` keeps all 41 legacy exports with identical
signatures (a frozen export snapshot lives in `app/test/vault-runtime-factory-core.test.js`) and adds
one additive export, `primaryRuntime`.

### 6.2 Applied by Wave B / B2 (VaultIndex runtime)

Lane B2 (branch `feat/mv-b2-vault-index-runtime`) applied rule 3 above in one commit with this
document and the test. No behavior observable through `src/vault-index.js` changed.

| Ratchet | Change | Why |
|---|---|---|
| `singletons["src/vault-index.js"]` | **removed** (9 anchors) | the index state is now closure-local inside `createVaultIndexRuntime` — one instance per Vault, never module scope (§4.2; contract §11, §43-7) |

New modules: `src/vault-runtime/vault-index-runtime.js` (per-Vault factory: note cache, generation,
publicationRevision, snapshot identity, build tail, stats, plus the build/publish/invalidate entry
points) and `src/vault-runtime/vault-index-links.js` (root-free record/link projection, extracted so
the runtime module stays inside the 500-line gate). Neither imports `config.js` nor reads the
environment: `maxReadBytes`, the Vault-bound `readNote` and the parse helpers are injected, while
`allMarkdownFiles`/`toVaultPath` default to the instance's own `runtime.localFs`.
`src/vault-index.js` keeps all five legacy exports with identical names/signatures (frozen snapshot in
`app/test/vault-index-facade.test.js`) and adds one additive export, `primaryIndexRuntime`.
The contract §11 A/B isolation and same-Vault serialization assertions live in
`app/test/vault-index-runtime.test.js`.

### 6.3 Applied by Wave B / B3 (retrieval runtime)

Lane B3 (branch `feat/mv-b3-retrieval-runtime`) applied rules 1–3 above in one commit with this
document and the test, and changed **no primary behavior**:

| Ratchet | Change | Why |
|---|---|---|
| `singletons["src/retrieval.js"]` | **removed** | the eight retrieval bindings are now closure-local to `vault-runtime/retrieval-runtime.js` (one per Vault) — rule 3 (§4.3) |
| `configImporters.RETRIEVAL_INDEX_PATH` | **`- src/retrieval.js`** (now `["src/vault.js"]`) | the facade no longer derives the path; it uses the primary A7 mapping, and the new runtime reads `vaultRuntime.paths.retrievalIndex` — a tightening, not a relaxation (§1.5) |

New modules: `src/vault-runtime/retrieval-runtime.js` (`createRetrievalRuntime`, per-Vault instance,
contract §12), `src/vault-runtime/retrieval-rank.js` (pure chunking/ranking primitives) and
`src/vault-runtime/retrieval-status.js` (pure status/job/result payload builders; extracted to stay
inside the 500-line module gate).
`src/retrieval.js` keeps all 14 legacy exports with identical names and arities (frozen snapshot in
`app/test/retrieval-runtime-facade.test.js`; the exports *are* the primary instance's own functions)
and adds one additive export, `primaryRetrievalRuntime`. No entry was added to
`FROZEN.dataPathLiterals` / `FROZEN.envReaders`: the new modules add neither a `path.join(DATA_PATH,
"…")` derivation nor a direct `process.env` reader.

### 6.4 Applied by Wave B / B5 (transfer runtime)

Lane B5 (branch `feat/mv-b5-transfer-runtime`) applied **no** `FROZEN` change in its commit with this
document: the uploads literal stays in `src/file-transfer.js`, so `FROZEN.dataPathLiterals.transfers`
(`["src/file-transfer.js", "src/vault.js"]`) and `FROZEN.configImporters.DATA_PATH` remain accurate —
the two rows above were only re-annotated (rule 1 does not apply when the frozen sets do not move).

| Ratchet | Change | Why |
|---|---|---|
| `dataPathLiterals.transfers` | **unchanged** (`src/file-transfer.js` keeps the literal) | the facade still declares `path.join(DATA_PATH, "transfers", "uploads")`, but only as the primary parity ratchet; the per-Vault root now comes from `vaultRuntime.paths.transfersUploads` (§2, contract §5.1/§13.4) |
| `configImporters.DATA_PATH` | **unchanged** | `src/file-transfer.js` still imports `DATA_PATH` for that ratchet; the new module imports no global path constant at all |

New module: `src/vault-runtime/transfer-runtime.js` (`createTransferRuntime({ vaultRuntime, deps })`,
per-Vault instance, contract §27 B5/§13.4). It never imports `config.js` or `node:process` (tunables and
the protected-root policy are injected by the facade) and holds no module-level state; instances are
stateless, so the facade may build one per request runtime without caching. `src/file-transfer.js`
(288 → 241 lines) keeps all 10 exports with identical names/arities (frozen snapshot in
`app/test/transfer-runtime-facade.test.js`) and adds no export: upload metadata now carries `vaultId`,
both upload results output it, and status/chunk/cancel reject a mismatched Vault before any part-file
I/O. Per-Vault isolation, the zero-part-I/O proof and the §43-5/§43-7 purity ratchets live in
`app/test/transfer-runtime.test.js`.
### 6.5 Applied by Wave B / B4 (Git runtime migration)

Lane B4 (branch `feat/mv-b4-git-migration`) applied rules 1–3 above in one commit with this document
and the test. `src/git.js`'s observable surface is unchanged: the same 12 exports with the same names
and arities, and the W0-D characterization suite (`app/test/multi-vault-git-characterization.test.js`)
stays green item by item as the parity gate. The `#255`/`#265` suites
(`git.test.js`, `git-sweep.test.js`, `git-push-observability.test.js`) are green unmodified, and the
A6 factory suite keeps its behavior assertions (only its frozen `git-runtime/*` file list grew, rule 1).

| Ratchet | Change | Why |
|---|---|---|
| `singletons["src/git.js"]` | **removed** (11 anchors) | all Git state is per `GitRuntime` instance — rule 3 (§4.1; contract §16, §44 item 8) |
| `singletons["src/git-push-observability.js"]` | **removed** (2 anchors) | the push history is per instance via `createPushHistory()`; the module keeps the three stateless helpers — rule 3 (§4.1) |
| `configImporters.DATA_PATH` | `+ src/git.js` | the facade builds the primary A5 store from `DATA_PATH` (§1.2, §2) — an allowlisted §43-5 facade, rule 2 |
| `dataPathLiterals` | **unchanged** | the facade passes `dataRoot`, so no new `path.join(DATA_PATH, "…")` literal exists (§2) |
| `envReaders.WEB_VAULTS_ROOT` | **unchanged** | the primary vault id comes from the canonical `DEFAULT_VAULT_ID` (`oauth/primitives.js`), imported rather than re-derived — no new env reader |

New modules: `src/git-runtime/timers.js` (`GitTimerController`: the debounce timer, the max-delay
deadline + its imminent/anti-retry-storm bookkeeping and the single sweep interval, extracted so
`runtime.js` stays inside the 500-line gate) and `src/git-runtime/config-source.js`
(`createGitConfigProvider`: A5 store + `GIT_*` baseline → the runtime's synchronous `configProvider()`,
including the fail-closed broken-store branch). Both obey the A6 no-ambient-state rules, which the
factory suite now asserts for all six `git-runtime/*.js` files.
Extension beyond A6: `GitRuntime` gained `assertRepository()`, `runGit()`, `normalizePath()` and a
`pushHistory` getter (the facade's read/command surface, all still bound to the instance root and
enablement), an optional `sweepIntervalSeconds` on `start()`, and the `recoverPending` hook that
restores a failed batch's scheduling (W0-D §2/§3: the pre-migration `restorePendingBatches()` ended in
`armPendingTimers()`; its absence was an A6 gap that B4's parity gate caught, see the B4 HANDOFF).
New tests: `app/test/git-migration-config-wiring.test.js` (store → provider → runtime inheritance,
reload reconcile, broken-store fail-closed) and `app/test/git-migration-isolation.test.js` (façade
surface, persisted-record wiring, `vault.js` → primary runtime routing, two-runtime pending/flush/push
isolation, and the absence ratchet for the removed singletons).

### 6.6 Applied by Wave D / D-search (per-Vault search runtime registry)

Lane D-search (branch `feat/mv-d-search-per-vault`) applied rule 1 above in one commit with this
document and the test. It adds one **new** piece of module-level mutable state, which is the reason
this row exists:

| Ratchet | Change | Why |
|---|---|---|
| `singletons["src/search-runtimes.js"]` | **added**: `const SECONDARY_RUNTIMES = new WeakMap();` | one composed `{ index, retrieval }` pair per materialized `VaultRuntime`, keyed by the runtime **instance** (WeakMap) instead of a `vault.id` string — the same shape as the per-vault `web-catalog/runtime.js` precedent in §4.5, but with no id-keyed inventory and no leak after D0's map releases a runtime |

New modules: `src/search-runtimes.js` (resolver + registry; reads the selected Vault from the
request context and refuses a secondary selection with no materialized runtime as
`vault_retrieval_unavailable`) and `src/vault-runtime/search-runtime.js` (pure composition of B2's
`createVaultIndexRuntime` with B3's `createRetrievalRuntime`, including the Vault-bound note reader
built from each Vault's own `localFs`). The registry holds only *references*: the index state and the
retrieval state/queue/job/timers stay inside their per-Vault instances (§43-7), so no
`FROZEN.singletons` anchor for those moved here. `src/tools/{search,intelligence,links}.js`,
`src/search/hybrid-search.js` and `src/related-notes.js` now read the selected runtime instead of the
primary facades; the primary Vault keeps the process's existing instances, so the no-`vaultId` legacy
path is unchanged.

### 6.7 Applied by Wave D / D-git (per-Vault GitRuntime registry + resolver)

Lane D-git (branch `feat/mv-d-git-per-vault`) applied rule 1 above in one commit with this document
and the test. It adds one **new** file with module-level mutable state, which is the reason this row
exists:

| Ratchet | Change | Why |
|---|---|---|
| `singletons["src/git-runtimes.js"]` | **added**: `const SECONDARY_GIT_RUNTIMES = new WeakMap();` and `let wiring = null;` | one `GitRuntime` per materialized `VaultRuntime`, keyed by the runtime **instance** (WeakMap) instead of a `vault.id` string — the same shape as the §6.6 search registry (no id-keyed inventory, nothing served after D0's map releases a runtime). `wiring` is the one-shot injection from the §43-5 facade `src/git.js` (its `buildGitRuntime` factory + the A5 store it already owns + the `GIT_*` baseline); it holds references only, never Vault state |

New module `src/git-runtimes.js` (resolver + registry + structured refusals). The Git state itself —
the pending batches, the debounce/max-delay/sweep timers, the serialized operation queue,
`lastSweep` and the push history — stays inside the A6 `GitRuntime` instances, so no new
`FROZEN.singletons` anchor is needed for it (§43-6 keeps holding). `src/git.js` keeps every frozen
export (name, arity, behavior) and adds the per-Vault surface (`buildGitRuntime`,
`git*For(runtime, …)`, a request-routed `trackGitMutation`); `src/tools/git.js` resolves each call's
runtime instead of importing the primary facade. The primary Vault still reuses the one instance the
facade built at import (its #255/#265 pending/push observability is bound to it), and a request with
no Vault selection keeps the legacy primary path (§21 MV-I07).

### 6.8 Applied by Wave D / D-publish (publish face verification + `publish` capability flip)

Lane D-publish (branch `feat/mv-d-publish-per-vault`) changed **no** `FROZEN` anchor — no new
importer, singleton or `DATA_PATH` sub-state — so rules 1–4 above do not apply. It is recorded here
because §6 is the single place a later lane has to check before assuming publish state moved, and
because it flips one capability key:

| Ratchet | Change | Why |
|---|---|---|
| `WIRED_CAPABILITY_KEYS` (`src/vault-runtime/capabilities.js`) | **added** `"publish"` | the `publish` face was already Vault-routed before Wave D (contract §14: Publish is the multi-Vault precedent), so `{available:false}` was an under-report. Verified by a real dual-Vault matrix, not assumed (§3.4) |

Facts re-confirmed on this lane's BASE (`4abc4452`), unchanged by the lane:

- `src/publish/service.js` still owns the one `DATA_PATH/publish/state.json` store (§2 above; the
  `DEFAULT_FILE` binding) and keys records by `vaultId + NUL + path`; contract §5.1/§5.2 list **no**
  publish state path, and §13.5 sanctions exactly this record shape — so this lane deliberately did
  **not** invent a per-Vault publish store file (that would be a publish-contract change, out of this
  lane's scope).
- `src/tools/publish.js` reads the *selected* `requestContext().vaultId` (never a local Vault field;
  the canonical `vaultId` input comes from C's registrar) and `PublishService` resolves that id
  through the canonical registry (`src/app/vault-registry.js` → A2 `createVaultRegistry`), so every
  stat/read/write lands in the selected Vault's own root. Publish therefore consumes
  `requestContext().vaultId`, **not** `requestContext().vaultRuntime` — it needs no per-Vault runtime
  instance, which is why `src/tools/publish.js` is intentionally absent from the
  `multi-vault-d-files-matrix.test.js` `ROUTED_MODULES` list (that list asserts the
  `vault-runtime/request-vault.js` seam).
- `server.js` is **not** touched by this lane (stays at the D0 wiring, 498/500 lines).

Declared residuals (verified, not hidden — see the lane HANDOFF §4): one shared store file with one
`mutationQueue` (cross-Vault publish mutations serialize; they never cross-assign a `vaultId`), and
an anonymous `/publish/<opaque-id>` resolve that stays a public capability bound by the record's own
`vaultId` (§13.5).

### 6.9 Applied by Wave F / F1 (convergence: dead state, single-point registry, one env read point)

Lane F1 (branch `feat/mv-f1-convergence`) is the contract §31 convergence step. It changes **no**
behavioral semantics of Waves A–E; it removes duplicated process state and tightens the ratchets.

| Ratchet | Change | Why |
|---|---|---|
| `envReaders.WEB_VAULTS_ROOT` | `[src/app/vault-registry.js, src/oauth/primitives.js, src/vault.js]` → **`[src/config.js]`** | tightening (one reader instead of three): the two Web multi-Vault reads became `config.js` helpers and every former direct reader imports them (debt D2, brief §1) |
| `envReaders.WEB_DEFAULT_VAULT` | **added** `[src/config.js]` | the same single read point now covers the default-vault id read |
| `configImporters.configuredWebVaultsRoot` / `.configuredWebDefaultVault` | **added** `[src/app/vault-registry.js, src/oauth/primitives.js, src/vault.js]` | the two new helper exports and their exact consumer set (rule 1) |
| `server.js` inline `WEB_VAULTS_ROOT` read | **removed** | the composition root injects the exported canonical registry instead of re-deriving its root (debt D2) |
| `src/admin/vault-git-assembly.js` second A2 registry | **removed** | Wave E / EA built a second read-only A2 instance because B7's canonical one was private (`EA.HANDOFF.md` D1). F1 exports `webVaultRegistry` from `src/app/vault-registry.js` and `server.js` injects exactly that instance into the assembly and the D0 runtime map. The degraded primary-only view stays, but as a *view* built from A1's pure `createVaultDescriptor` over the same instance — never a rival inventory. `src/**` now has exactly ONE `createVaultRegistry(` construction site |
| `src/vault-runtime/capabilities.js` | **added** `"retrieval"`; `UNWIRED_CAPABILITY_DECISIONS` added | the per-Vault index/retrieval instances and their routing were already real (D-search); the map-level key was the recorded Wave F residual. `semantic`/`webCatalog`/`events` stay fail-closed with a now-recorded owner+reason instead of a generic "no lane yet" (§3.4) |
| `singletons` / `dataPathLiterals` | **unchanged** | F1 adds no module-level state and no new `DATA_PATH` substate |

Also in this lane (not ratchet-shaping, recorded for traceability): `src/publish/service.js` now injects
the canonical registry's own resolver (`resolveCanonicalVault`, contract §14) instead of the Web-shaped
`resolveWebVault` projection; `src/tools/info.js#safeVaultMetadata` reports the registry descriptor's
per-Vault `capabilities` (§18.1/§3.4) so a flipped key is observable; and one real defect was found by
the completion matrix and repaired — `rename_property` shadowed the index *runtime* with the index
*payload*, so its `dryRun:false` path threw `index.invalidate is not a function`.

### 6.10 Applied by the #428 Web Catalog default-path slice (runtime location)

Lane #428 (branch `fix/i428-catalog-default-path`) applied rules 1–2 in one commit with this document
and the test. The default Web Catalog directory moved from `process.cwd()/data/web-catalog` to the
resolved `DATA_PATH/web-catalog`; a truthy `WEB_CATALOG_DIR` still wins with its existing cwd-relative
interpretation, and every actually-opened store now logs one line with its vault id, absolute file path
and source (`WEB_CATALOG_DIR` | `DATA_PATH`).

| Ratchet | Change | Why |
|---|---|---|
| `configImporters.DATA_PATH` | `+ src/app/web-catalog/runtime.js` | the new default derives from the config.js-exported `DATA_PATH` (rule 2) |
| `dataPathLiterals` | **added** `"web-catalog": ["src/app/web-catalog/runtime.js"]` | §2 matrix 2 row; the module now declares one `path.join(DATA_PATH, "web-catalog")` literal |
| `dataPathOwners["src/app/web-catalog/runtime.js"]` | anchor `'process.env.WEB_CATALOG_DIR \|\| path.join(process.cwd(), "data", "web-catalog")'` → `'path.join(DATA_PATH, "web-catalog")'` | **old path source anchor**: the retired cwd-relative default must not come back (rule 1) |
| `singletons["src/app/web-catalog/runtime.js"]` | **unchanged** | the runtime registry stays keyed by `vault.id`; the slice adds no module-level state — only the new `resolveWebCatalogLocation` / `describeWebCatalogOpen` / `WEB_CATALOG_DIR_SOURCE` exports |

No behavior change to cold/warm, `stale` or cursor-invalid contracts. Migration, observability, the
keep-the-old-path escape hatch and the rollback steps live in `docs/WEB_OPERATIONS.md` ("Web catalog
directory (issue #428)"); the Admin fixture's explicit `WEB_CATALOG_DIR` (PR #424 RETURN-3 ②) is
untouched. Machine evidence: `app/test/web-catalog-default-path.test.js` (path matrix,
one-line-per-open, two real child processes with a handshake, restart reuse, a migration case that runs
in a dedicated cwd whose real retired `cwd/data/web-catalog` index is poisoned and must stay
byte-identical, and two negative controls) plus the paired ratchet updates in
`app/test/multi-vault-core-state-inventory.test.js`.

### 6.11 Applied by W2 / #437 (admission + unified reconciliation)

Branch `feat/i437-w2-reconciliation` (contract `DEVELOPMENT - Vault 热发现与准入（Issue 437）` rev3).
The gate is **off by default**: `VAULT_DISCOVERY_ENABLED` unset keeps the pre-W2 source shape exactly.

| Ratchet | Change | Why |
|---|---|---|
| `dataPathLiterals` | **added** `"vault-admissions.json": [src/config.js]` | the one authoritative admission record (contract §2.2) is declared at the single config read point, exactly like the legacy `trash`/`history`/`index` defaults |
| `dataPathLiterals` | **added** `"vault-admission-enrollment.json": [src/config.js]` (W2FIX2 / RETURN item 1) | the independent managed-mode enrollment sentinel: records only "this data root is under admission management" + trusted identity bindings/generations, so a lost `vault-admissions.json` cannot be re-read as "never managed". Same single config read point |
| `configImporters.VAULT` / `DATA_PATH` | **unchanged** | no new importer: `src/config.js` derives `VAULT_ADMISSIONS_PATH`, and the new `src/vault-runtime/{identity,admission-store,reconciliation,registry-scan}.js` modules import no global path constant (§43-5) |
| `configImporters.*` | **unchanged** | `src/app/vault-admission.js` / `vault-startup.js` read `config.js` only through `src/app/vault-registry.js` |
| `singletons` | **unchanged** | the new modules hold their state inside a factory closure; `src/app/vault-registry.js` keeps `const webNoteWriteLocks = new Map();` and gains no module-level mutable state (the controller reference is a `const`) |
| `app/test/vault-runtime-registry.test.js` purity allowlist | `+ ./registry-scan.js` | W2 extracted bounded enumeration into a cohesive sibling module because `registry.js` must stay under the 500-line budget (`MAX_ENTRIES_PER_PARENT` / `ROUND_BUDGET_MS` / the three discovery error codes are re-exported from `registry.js`) |

New source in this lane (all under `app/src/`): `vault-runtime/identity.js` (Vault identity v1: structured
tuple + sha256, `realpath` + volume/file id), `vault-runtime/admission-store.js` (the single-writer
`vault-admissions.json`: schema v1, atomic temp+rename, corrupt ⇒ refuse startup), `vault-runtime/registry-scan.js`
(bounded enumeration), `vault-runtime/reconciliation.js` (the one unified service: four trigger classes,
single-flight, `prepare`/`commit`, diff, lifecycle, observability), `app/vault-admission.js` +
`app/vault-startup.js` (composition seam). `vault-runtime/registry.js` gained the `prepare`/`commit` seam and
a persistent admission `gate`; `vault-runtime/instances.js` gained `prepare`/`commit`/`discard` +
`settleRetirements` (a displaced runtime is drained, then disposed — never merely dropped from the Map).

W2FIX2 (second RETURN) additionally splits the 500-line-budget overflow and the new guarantees into
cohesive siblings: `vault-runtime/enrollment-sentinel.js` (atomic sentinel I/O),
`vault-runtime/reconciliation-{vocabulary,status,commit}.js` (shared constants, run bookkeeping, the
composed servable set + prepare-failure isolation), `vault-runtime/runtime-lease.js` (the per-instance
identity/generation lease that refuses NEW operations on a captured handle). No new module imports a global
path constant (§43-5); the two ratchets above are the only inventory changes.

## 7. Not covered / not proven
- No runtime/behavioral proof for anything above: this is a static source inventory plus one subprocess env-derivation check (I5).
- Cross-call handle binding (`planId`, `uploadId`, cursors, version/trash ids) belongs to W0-C; MCP tool classification to W0-B; Git timer/config behavior to W0-D; auth characterization to W0-E; Web primary/secondary parity to W0-F.
- Scanner limitation: single-`VaultRuntime`-per-file assumption (one process, one primary) is a *fact about BASE*, not an invariant; the ratchets are source-shape checks, not security proofs.
- Nothing here is `merged`, `released`, `deployed`, or `production-verified`; this lane is a `candidate` branch and does not touch production.
