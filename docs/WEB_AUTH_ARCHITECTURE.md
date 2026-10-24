# Web, MCP, OAuth and Admin authentication architecture

Status: accepted and implemented.

## Security domains

| Domain | Canonical routes | Credential | Purpose |
| --- | --- | --- | --- |
| Web | `/app/*`, `/auth/*`, `/api/web/v1/*` | `obsidian_web_session` | Human Vault browsing and editing |
| Publish | `/publish/*` | Opaque 256-bit route ID | Anonymous read-only access to one explicitly published Markdown note |
| Admin | `/admin/auth/*` | `obsidian_mcp_admin` | Accounts, API keys, OAuth clients/tokens and audit |
| MCP | `/mcp` | API key or OAuth access token | Agent and automation tools |
| OAuth | `/oauth/*`, `/.well-known/*` | Authorization code, client credential and bearer token | MCP client authorization |

The OAuth user directory is shared by Web login and OAuth consent. Sessions and credentials are not interchangeable. Web and Admin cookies use separate names, validators, CSRF tokens, lifetimes and authorization checks. API keys and OAuth bearer tokens are accepted only by MCP middleware.

## Entities and lifecycle

- OAuth user: password hash, display name, enabled state and maximum Obsidian scopes.
- Web session: server-side durable record keyed by the SHA-256 token hash, with user revision, independent CSRF token and 8h sliding expiry. Restart no longer revokes it; account password/scope/enable changes still invalidate it on the next request.
- Admin session: in-memory random identifier, independent CSRF token and shorter expiry. It is created only with the protected admin password.
- OAuth grant: authorization code with PKCE, audience-bound access token and rotating refresh token.
- API key: automation credential stored only as a hash, except the configured key kept in the protected environment.

The initial implementation supports one or more users without assuming a single fixed owner. Future path policies calculate effective access as account permission intersected with path policy and operation.

## Web session durability

Human Web sessions survive an app/container restart while remaining fail-closed for real invalidation. `app/src/app/web-session-store.js` owns the durable store; the production `server.js` creates it, awaits its `ready` load and injects it into the router before HTTP admission. `DATA_PATH/web/sessions.json` is schema v1 and is written only by the single server process; multi-replica writers are not supported.

- The store keeps a committed memory map and a process-local record version. Foreground create/update persist a candidate document atomically without publishing it, then swap committed memory only if the membership/version fence still matches, so a failed write never exposes an unacknowledged candidate and a concurrent touch/logout is never clobbered or resurrected. Candidates are strictly validated before either a disk write or a memory commit, and unknown top-level state fields fail the store closed.

- The cookie continues to hold the current 32-byte base64url token; only its lowercase SHA-256 hex digest is persisted. The raw token, bearer/OAuth tokens, passwords, scopes, allowedVaults and Admin state are never written.
- Each record stores only `userId`, `userUpdatedAt`, `csrf`, `vaultId`, `createdAt`, `expiresAt`, `lastSeenAt`. Scopes and allowedVaults are read live from `provider.oauthUserSessionRecord()` on every request.
- Startup validates the exact schema, hash-key shape, field bounds and timestamp order, rejects corrupt JSON, unknown schema, oversized files and more than 10,000 active records, then prunes expired records. There is no corrupt-reset fallback.
- Login commits the durable create before sending `Set-Cookie`. Logout removes the token from the process view immediately, then requires a durable delete ack before clearing the cookie and reporting success.
- Touch keeps the 8h sliding server TTL but only checkpoints to disk at a 60s merge window. The fence is computed against each record's own durable expiry/lastSeen marker, which is initialized from the loaded document and advanced only when that exact version is serialized and acked; an unrelated create/checkpoint or a restart therefore cannot renew another record's budget, and a concurrent touch during an in-flight write never inherits an unwritten marker. A request whose touch would push durable lag to >= 60s must `await` a successful checkpoint before the authenticated response counts as a renewal; a checkpoint failure returns 503 and keeps the dirty state for retry. After the awaited checkpoint the request revalidates that the record is still present, unexpired and at the same version, so a concurrent logout or expiry wins. The cookie `maxAge=8h` is set only at login and is not refreshed, so the browser still has an absolute ~8h limit.
- Vault select is a durable foreground update. Vault create updates provider authorization first, then the session revision/vault; a session-write failure returns an error and leaves the old revision, so the next request fails closed. This is not a cross-store transaction.
- Because the 60s guarantee depends on the request-side fence (per-record durable marker, not a global clock or a timer alone), the documented bound is: with a single writer, a normally monotonic clock and healthy persistence I/O, any authenticated request that succeeded has a durable expiry less than 60s behind its memory expiry. Wall-clock jumps, event-loop stalls and I/O failures are outside that bound.

Residual limitation: if the logout durable delete fails and the process crashes before a later checkpoint, the old record can reappear on restart. The process still denies the token before the crash; there is no WAL/tombstone in this slice.

Shutdown is one shared idempotent promise with a 10s total deadline: admission is fenced, the listener close is initiated immediately, `teardownLiveEvents()` ends SSE streams and closes watchers under the same deadline, then admitted requests, MCP transports, the Web store drain and the provider drain complete best effort. A teardown, drain or deadline failure still cleans up but exits non-zero and never reports a successful shutdown; watcher close failures are collected instead of swallowed.

## Authorization transfer fence

“Authorization transfer” moves the *authorization relation* for one `(OAuth client, source account)` to a
target account (Issue #364). It never moves a bearer: the source's access token, refresh token and
unconsumed authorization codes are permanently invalidated, the client registration is untouched, and
the target must complete an ordinary login + consent + code exchange to obtain its own credentials.
The Admin form/route, the projection overlay and the end-to-end acceptance are the second slice (see
[Admin route and projection overlay](#admin-route-and-projection-overlay-slice-2) below); this
section documents the durable fence both slices share.

- `app/src/oauth/authorization-transfer-store.js` owns `DATA_PATH/oauth/transfers.json` (schema v1,
mode `0600`): transfer records (`id`, `clientId`, `sourceUserId`, `targetUserId`, `status`
(`pending`/`completed`/`cancelled`/`expired`), `generation`, `sourceRevokedAt`, `createdAt`,
`expiresAt`, `completedAt`, `completionUserId`, `closedReason`) plus a per-`(clientId, userId)`
revocation generation. It stores ids, statuses and timestamps only — never a token, code, secret or
password. Every mutation is serialized through one queue and follows
**clone → mutate the clone → durable temp + `rename()` → publish the committed state**, so a reader (or
a concurrent duplicate request) can never observe a fence whose write has not returned, a mutator that
rejects cannot publish a partial edit, and a failed write publishes nothing. The file is
**single-writer** (one process; no file watcher), like `oauth/state.json`.
  Loading validates the records against each other, not only field by field: the fence generation of a
  source pair must exist and must not be behind its transfer history, a generation reference must point
  at a transfer of that same pair, and at most one `pending` transfer may exist per source and per
  target. A contradiction — e.g. a `generation 1` transfer with no generation record, which would leave
  the old-generation credential looking unfenced — makes the server refuse to start and leaves the file
  untouched for a human.
- `app/src/oauth/authorization-transfer-runtime.js` holds the pure algebra: a credential is valid only
while its own `generation` equals its pair's current generation. Legacy credentials (no generation)
count as generation 0, so they stay valid until their pair is fenced; a fresh login after a fence
mints credentials at the new generation, while issuance always inherits the *source credential's*
generation. That equality (not a timestamp comparison) is why a concurrent exchange cannot upgrade an
old code or refresh token across a concurrently committed fence.
- The fence is consulted before any credential is consumed, on all three entries — access-token
verification, refresh-token exchange and authorization-code exchange (`app/src/oauth/protocol-methods.js`).
It is independent of the optional AuthZ runtime: `oauthHardRevoke` is still evaluated in its original
place, and a transfer denial is never expressed through it.
- `provider.revokeClientUserGrants(clientId, userId)` is the pair-scoped physical revoke (matching
access tokens, refresh tokens and unconsumed codes only). It is best-effort consistency for the Admin
token list; the durable fence is the security authority, so a failed state save is audited
(`oauth.client.transfer.source_revoke_sync_failed`) and reported as degraded without re-admitting the
source.
- A successful authorization-code exchange completes exactly one matching pending intent and re-checks
the *current* account state and ceiling (enabled, current `allowedScopes` intersection, current
`allowedVaults`). **Only this exchange re-checks the ceiling today: `exchangeRefreshToken` still issues
from the stored grant without a fresh account-ceiling check.** A completion that cannot be persisted is
audited as `oauth.client.transfer.complete_failed` and leaves the intent `pending` — never a reported
completion that is not durable.
- The `pending` TTL (15 minutes) is a **lazy** deadline: it is evaluated on read/sweep and, critically,
re-checked inside the store's serialized commit section, so the deadline is a property of the record and
**not** of whether the last sweep could be written. Only a candidate whose reason is `eligible` may
complete; an intent past its TTL stays incomplete (audited `expire`, `pending_ttl_elapsed_in_commit`
when the refusal happened during the commit) even if its expiry sweep failed. The token response itself
stays successful — the target really is authorized — but nothing claims a completion.
- Audit events (ids and statuses only, no secrets): `oauth.client.transfer.begin`,
`source_revoke_sync_failed`, `complete`, `complete_failed`, `cancel`, `expire`,
`session_close_failed`, `deny`.
- Session close is verifiable: `closeSessionsForClient(clientId, { userId })` returns
`{ matched, closed, failed, sessionIds, failures }` instead of discarding `Promise.allSettled`
results. A close failure is audited and surfaced, keeps the fence, and does not roll back the revoke.
  A failed close is **not** a close: the transport record stays resident and is reported by
  `listUnclosedSessions()` (session id, client, last error) instead of being deleted to look closed.
  Recovery is explicit — the idle reaper retries on every tick, and re-issuing the idempotent
  `closeSessionsForClient(clientId, { userId })` is the operator/Admin retry; a process restart clears
  the in-memory registry but never re-admits a fenced credential. Reaping is best effort and is *not*
  guaranteed to succeed while `close()` keeps failing.
- `provider.authorizationTransferSnapshot()` is the projection input for the second slice (Admin form/
  overlay): `{ available, healthy, transfers, generations }`. It sweeps the expired pendings first and
  then projects the **committed** state, re-reading the store view *after* the sweep — a mutation
  publishes a new state object, so a view captured before the `await` would keep projecting the stale
  `pending` even though the expiry is on disk and audited. `healthy` and `transfers` therefore describe
  what is durably committed, not what this call hoped to write. If the sweep write fails, the snapshot
  still returns the pre-sweep committed status (`pending` with its `expiresAt`), and the lazy deadline —
  not the failed sweep — is what denies the source credential; the Admin overlay must treat a `pending`
  whose `expiresAt` is already past as expired for display/completion purposes, and the expiry is
  audited exactly once, when a later sweep finally persists it.
- The production `server.js` awaits the transfer store before HTTP admission: a corrupt, malformed or
unknown-version `transfers.json` aborts startup rather than silently dropping the fence, and while an
unreadable fence exists every transfer-fenced credential query fails closed.

### Admin route and projection overlay (slice 2)

- `POST /admin/auth/oauth/client/transfer` (`app/src/admin/auth-center-transfer-routes.js`) begins a
transfer and `POST /admin/auth/oauth/client/transfer/cancel` cancels a pending intent. Both sit behind
the existing `requireAdmin` + `requireCsrf` guards — no CSRF-free shortcut and no second auth scheme. The
status codes are **not** re-derived: the service's `AuthorizationTransferError.status` is rendered
verbatim (400 / 404 / 409 / 503). A rejection happened before any durable write, so the route revokes,
fences and audits nothing on failure; the target-already-authorized 409 carries the frozen wording
「目标账户已授权该客户端，请先处理其现有授权。转移未发起。」. Success is a 303 to the clients tab plus a
flash that says the source authorization was revoked and the target must re-authorize with the same
client — never that the transfer completed. The failure page is scoped to the action: a failed *begin* says
nothing was revoked (「未撤销源账户授权」), while a failed *cancel* says the cancel did not succeed and that
the existing fence is not lifted — its 503 deliberately does **not** reuse the begin wording. A degraded
begin is described from the observed session report: a close failure carries its `closed/matched` and
`failed` counts, while a degraded begin whose sessions all closed (the `source_revoke_sync_failed` path,
`failed: 0`) gets a generic degraded note and is never blamed on the session close. The
"旧凭证仍被撤销" part is always present.
- The clients tab applies the fence **in the projection, not in the HTML**:
`applyAuthorizationTransferFence` (`app/src/admin/auth-center-oauth-linkage.js`) marks any credential
whose `generation` is behind its pair's committed generation as `revoked` before `activeGrants` runs, so
the linked-account cell, the account client count and the tokens table all agree. An unreadable fence
(`healthy: false`) fails closed and withdraws every active grant, mirroring the runtime — and it does so
**before** the pair check, so a pair-less legacy record (missing `userId`, username-only) is withdrawn too;
the runtime fences *any* credential while the store is degraded, so the pair being matchable must not be a
precondition. `healthy` is
never treated as proof that the store is writable — the route always asks the service, which decides.
- The pending label is frozen: a live pending shows 「转移待 <target> 重新授权」 and offers cancel, which
stops auto-completion and never restores the old bearer. A `pending` whose `expiresAt` has passed while
the expiry sweep could not be written is shown as a deadline that passed but is not yet committed — the
Admin must not claim the expiry landed or offer completion. The projection applies that lazy deadline
itself (`app/src/admin/auth-center-transfer-view.js`); every page render sweeps the expired intents,
which is where the `expire` audit is written.

**Rollback (contract §13).** A code rollback never restores a source's old bearer. Because a binary
that predates this fence does not know `transfers.json`, do **not** downgrade directly: first make the
source revocations physical in `state.json` (or verify that every fenced credential is already
`revokedAt`), keep `transfers.json` and the matching audit rows with `state.json` for the rollback,
and treat a non-empty fence as “do not downgrade until verified”. Rolling back the transfer UI must
not revoke the target's own token. `transfers.json` is single-writer, so a running process does not
observe an out-of-band edit (the acceptance test therefore restarts the process); never run two
writers against the same `DATA_PATH`.

## Canonical routes

Authorization endpoints are `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` and `/oauth/decision`; discovery advertises them. Root `/authorize`, `/token`, `/register` and `/revoke` remain narrow protocol aliases for connector installations that cached the former discovery document. Administration is available only under `/admin/auth`; `/admin` is not an alias. OAuth client inventory records the authorized resource origins and most recent actual MCP connection origin, and access tokens cannot cross between configured public domains.

## Threat boundaries

- Anonymous routes never return Vault filenames, search results, attachment existence or account lists.
- Publish is the only anonymous content route. It resolves one stored Vault/path tuple, strips frontmatter, disables internal navigation/media, and returns 404 for missing, moved, revoked, or malformed records.
- Attachments and themes are resolved by narrow authenticated endpoints; the Vault is never a static web root.
- State-changing browser requests require the matching session and CSRF token.
- Markdown is rendered with raw HTML disabled and sanitized in the browser.
- Audit records identity, source, action and path without credentials or content.
