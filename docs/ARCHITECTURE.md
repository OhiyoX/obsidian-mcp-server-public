# Architecture and source layout

This project favors small, explicit modules and incremental refactors over broad rewrites. Public entry files remain stable while implementation moves behind narrow factories or controllers.

## Directory ownership

```text
app/
├─ frontend/app/
│  ├─ core/             browser bootstrap and transport primitives
│  ├─ features/         product domains; each domain owns its behavior
│  └─ ui/               reusable, domain-neutral UI utilities
├─ src/
│  ├─ app/              web server composition, routes, and live transport
│  ├─ admin/            administration and auth-center behavior
│  ├─ search/           shared Obsidian query parsing, evaluation, and hybrid ranking
│  └─ tools/            MCP tool implementations grouped by capability
├─ scripts/             build, validation, and regression automation
└─ test/                tests named after the source domain; helpers and fixtures separated
```

Generated browser bundles under `src/app/assets/` are build outputs. Never refactor them by hand; change `frontend/` and run `npm run build:web`.

`/app/assets/*` is served by `src/app/asset-encoding.js` (registered before the Web `securityHeaders` no-store middleware): pages reference those bundles as `/app/assets/<name>?v=<content hash>`, so the response is `Cache-Control: public, max-age=31536000, immutable` for every asset, with gzip negotiated per request (`Vary: Accept-Encoding`, in-memory cache keyed by name + mtime + size) and identity bodies for already-compressed formats. Session, HTML, API and publish responses stay `no-store`.

## Dependency rules

1. Entry modules export or wire dependencies; they do not accumulate domain algorithms.
2. Domain modules accept dependencies explicitly. Avoid mutable global service singletons.
3. `ui/` is domain-neutral. A UI utility must not import a feature controller.
4. Cross-feature behavior is coordinated by the composition root or a focused controller, not by deep imports into another feature's internals.
5. Stable public entry modules remain narrow API boundaries. When an internal contract changes, migrate all in-repository callers and remove the superseded path in the same verified change.
6. Reader and Live editor parsing remain separate consumers of shared Markdown contracts and canonical fixtures.

## File-size budget

Production JavaScript is limited to at most 500 physical lines. `npm run check:architecture` enforces this for every handwritten file under `frontend/` and `src/` while ignoring generated bundles. There are no exceptions. A file that exceeds the budget must be split along a cohesive responsibility before merge.

The architecture check also rejects removed migration bridges such as legacy list arguments, the `reading` view-mode alias, origin-only live-event suppression, legacy API-key state names, and legacy Skill-note contracts. Do not reintroduce them as silent fallbacks.

## Adding a feature

Create or extend one domain under `frontend/app/features/<domain>/` or the matching backend area. Expose a small public entry when other domains need it. Keep browser side effects in an initializer/controller, pass DOM nodes and services explicitly, add domain tests, then run:

```powershell
npm run check
npm test
npm run build:web
```

For Markdown behavior, also update the comprehensive/canonical fixture and run the Chromium regression suite.

## Refactor sequence

Refactor by reversible vertical slices: characterize behavior, extract one responsibility, keep stable public boundaries where they remain intentional, migrate callers, remove obsolete internal contracts, run focused tests, then run the full suite. Do not combine authentication, persistence, and UI topology changes in one unverified rewrite.

Multi-note plan/apply now uses a protected on-disk journal and startup recovery.
The commit states, recovery conflicts, and remaining limits are documented in
[MUTATION_RECOVERY.md](MUTATION_RECOVERY.md).

## Multi-Vault (vault scope)

One process serves one **primary** Vault plus up to 64 discovered **secondary** Vaults. The scope
seam is narrow and explicit:

- `src/vault-scope.js` is the single tool classification: `GLOBAL_TOOLS` is frozen to
  `{agent_bootstrap, server_info}` and every other `TOOL_NAMES` entry is Vault-scoped. The set is
  derived from `TOOL_NAMES`, so a tool cannot be left unclassified, and this module is also the
  canonical optional-`vaultId` input spec (never a second hand-written copy).
- `src/vault-scope-registrar.js` injects that schema into every scoped tool, authorizes the selected
  Vault against the credential's allowed Vaults *before* any I/O, refuses an invalid, unauthorized or
  unmaterialized id structurally, and then runs the handler inside
  `withRequestContextPatch({ vaultId, vaultRuntime })`.
- `src/vault-runtime/` owns the model: `descriptor.js` (canonical descriptor, id rule, `dataKey`),
  `registry.js` (bounded discovery, snapshot semantics, duplicate-root refusal), `paths.js` (the A7
  primary/secondary data layout), `runtime.js` + `instances.js` (one runtime per Vault; the primary
  instance is reused, a secondary gets its own lock, filesystem service and paths) and
  `capabilities.js` (the wired capability facts, with every unwired key explicitly
  `{available: false, reason}`).
- Handlers never read a global Vault root. They resolve the request's runtime through
  `src/vault-runtime/request-vault.js` (or the per-domain resolver built on it) and fail closed with
  `vault_unavailable` when the selection has no materialized runtime — a secondary is never served by
  the primary's state.

Still global by design: the MCP resources (`obsidian://vault/index|tags|graph`) are primary-only and
take no `vaultId`; the embedding provider is process-shared while each Vault owns its own index and
retrieval state; and the four capability keys `retrieval`, `semantic`, `webCatalog` and `events` are
reported fail-closed in the runtime capability map until the convergence slice folds them into one
graph. `server_info.vaults[].capabilities` currently returns the registry's fail-closed default map,
so it is not yet the per-Vault wiring report. The convergence scope (dead global state, architecture
tests, generated contracts, stage-flag default) is tracked in
`docs/multi-vault/STAGE-FLAG-DEFAULT-DECISION.md` and the contract's §31; the operator-facing summary
is in [USER_CONFIGURATION.md](USER_CONFIGURATION.md#multi-vault-多库).

Two boundaries that are *not* the multi-Vault runtime seam:

- **Publish** keeps one process-level registry (`/data/publish/state.json`) with records keyed by
  `vaultId` + path. `get_publish_status` / `manage_publish` act on the selected Vault, the Web
  Publish controls resolve the note through the Web Vault registry, and an anonymous
  `/publish/<opaque-id>` resolution is bound by the record's own `vaultId` — it is deliberately not
  part of the credential allowlist path. Per-Vault *store files* are a contract change, not a
  convergence cleanup.
- **Admin** owns the full inventory: the Auth Center **Vault 与 Git** tab
  (`/admin/auth/vault-git`) is the per-Vault Git configuration surface, guarded by the normal Admin
  session + CSRF, and it writes one Vault's record (compare-and-swap) at a time. See
  [ADMIN_VAULT_GIT.md](ADMIN_VAULT_GIT.md).

## OAuth authorization transfer fence

An OAuth authorization relation can be moved from one local account to another for one client
(Issue #364). The durable fence lives in `DATA_PATH/oauth/transfers.json`
(`app/src/oauth/authorization-transfer-store.js` + `-runtime.js`, mixed into the provider by
`authorization-transfer-methods.js`), not in `oauth/state.json` and not in the optional AuthZ runtime,
so it is consulted with `server.js`-owned ordering before an access token is verified, a refresh token
is exchanged or an authorization code is consumed. A per-`(client, account)` revocation generation —
not a timestamp — is what makes a pre-transfer credential permanently invalid while a fresh login +
consent still works. The store commits by clone → persist → publish, and its loader rejects a file
whose records contradict each other (a missing or lagging generation record, a reference to another
pair, two pending transfers for one source or target); the file is single-writer and a corrupt one
stops startup instead of dropping the fence. See
[WEB_AUTH_ARCHITECTURE.md](WEB_AUTH_ARCHITECTURE.md#authorization-transfer-fence) for the schema, audit
events and rollback rules. The Admin surface is `POST /admin/auth/oauth/client/transfer` (+ `/cancel`)
under the usual `requireAdmin` + `requireCsrf`, and the clients-tab projection overlays the fence
before computing the current relation, so a fenced credential is never shown as current even when its
physical revoke has not been written.

## MCP session lifetime

MCP Streamable HTTP sessions live in process memory only (`app/server.js`), so a
service restart or the idle reaper (`SESSION_TTL_MS`, 30 minutes by default) drops
every session; a client that keeps sending the dropped `Mcp-Session-Id` gets
`404 Session not found`. Each live session keeps a full MCP server (~3.7 MB RSS),
which is why the TTL stays short and the compatibility seam lives in
`app/src/mcp-session-recovery.js`: with `MCP_SESSION_RECOVERY=stateless` (default)
such a POST is answered as a one-shot stateless request that is closed with its
response, while authentication, Scope and Vault checks stay exactly where they
were. A request without a session id, or with a malformed id, keeps the strict
answer.
