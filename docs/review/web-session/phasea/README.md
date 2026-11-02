# Web session durability — Phase A review

Status: implementation candidate (not deployed). Base `eee33d477ca6989241b7ec9eaba855d2531c681c`.

Scope: human `obsidian_web_session` durability only. Admin sessions stay in the
auth-center process. This slice does not touch the frontend reconnect supervisor,
browser harness, cursor fallback, MCP/OAuth auth, or provider persistence core.

## Owned files

- `app/src/app/routes.js` — thin router; delegates session lifecycle to the manager.
- `app/src/app/web-session-store.js` — durable store class + re-export facade (new).
- `app/src/app/web-session-schema.js` — constants + strict schema/token validation (new).
- `app/src/app/web-session-resolve.js` — `resolveWebSession` + Express session manager (new).
- `app/src/app/events/teardown.js` — live-event teardown controller (new).
- `app/server.js` — owns/injects the store, awaits `ready`, shutdown ordering.
- `app/src/app/live-events.js` — minimal idempotent `teardownLiveEvents()`.
- `app/test/web-session-store.test.js`, `web-session-routes.test.js`,
  `web-session-restart.test.js`, `web-session-shutdown.test.js` (new).
- `app/test/preload-stall-watcher.mjs` — test-only deterministic watcher-close fault injection.
- `docs/WEB_AUTH_ARCHITECTURE.md`, `docs/WEB_OPERATIONS.md`.

## Frozen contract

`DATA_PATH/web/sessions.json`, schema v1, `{ version: 1, sessions: { <sha256hex64>: record } }`.
Top level allows only `version` and `sessions`; any extra field fails the store closed.
Record fields are exactly `userId`, `userUpdatedAt`, `csrf`, `vaultId`, `createdAt`,
`expiresAt`, `lastSeenAt`. No raw cookie token, bearer, scopes, allowedVaults,
password or Admin data ever reach disk. Incoming cookie tokens must round-trip the
current `randomBytes(32).toString("base64url")` shape (non-canonical 43-char
encodings are rejected); the store hashes them.

- Startup validates key/field/time/schema bounds, rejects corrupt JSON, unknown
  schema, oversized files (>32 MiB) and >10,000 active records, then prunes
  expired records. No reset fallback. `ENOENT` is an empty store.
- Login: provider auth -> non-empty allowedVaults -> candidate -> durable create
  -> committed memory -> `Set-Cookie`. Persist failure returns 503 with no cookie
  and no authenticatable memory session.
- Foreground create/update use a candidate snapshot: the candidate document is
  written atomically while committed memory still shows the prior record; memory is
  swapped only after the write succeeds and the committed membership/version is
  unchanged. A concurrent valid touch is preserved and a concurrent logout is never
  resurrected. Candidate records are strictly validated before any write.
- Logout: immediate in-process deny, then durable delete ack before clearing the
  cookie and returning success. Failure returns 503; the dirty deletion retries on
  the next checkpoint/drain.
- `currentSession` re-reads `provider.oauthUserSessionRecord()` every request and
  uses live scopes/allowedVaults; missing/disabled/revision-mismatch deletes and
  denies. Touch is a process-local CAS; a stale version re-reads/revalidates or
  fails bounded, never blind-writes an old snapshot back. Touch time is captured
  after the provider await. The overdue fence uses each record's own durable
  expiry/lastSeen marker (initialized from the loaded document, advanced only for a
  serialized+acked version), so an unrelated create/checkpoint or a restart cannot
  renew another record's budget and a concurrent touch during an in-flight write
  cannot inherit an unwritten marker. After an awaited overdue checkpoint the
  membership, expiry and version are revalidated before the request may count as a
  renewal.
- Vault select and vault create persist through `updateIfCurrent`; a failed vault
  create leaves the old revision so the next request fails closed (no cross-store
  atomicity claim). GET note vault selection is a delayed memory CAS.
- Shutdown: one shared promise, admission fence, listener close initiated
  immediately, `teardownLiveEvents()` bounded by the shared 10s deadline, SSE close,
  admitted-request barrier, store timer stop, Web drain, provider drain, awaited
  HTTP close, non-zero exit on any teardown/drain/timeout failure. Watcher close
  failures are collected and reported instead of swallowed.

## Five bounded guarantees (no over-claim)

1. The cookie is still issued only at login with `maxAge=8h`; it is never
   refreshed, so the browser retains an absolute ~8h limit.
2. With a single writer, monotonic clock and healthy I/O, every successfully
   completed authenticated request has durable expiry less than 60s behind memory
   expiry. The fence is per record (durable expiry/lastSeen/version captured from
   the loaded or last-acked document); a bare 60s timer or a global persist clock is
   not used as the correctness mechanism.
3. Logout durable-delete failure denies the token in-process but cannot promise
   post-crash revocation; this is documented as a residual.
4. Vault create provider update and session revision update are not a cross-store
   transaction; failure fails closed on the next request.
5. One server process writes the file; multi-replica file locking is out of scope.

## Tests

`app/test/web-session-store.test.js` — schema/corruption/oversize/cap fail closed,
unknown top-level field, hashed-key-only disk, 0600 (Linux), queue failure recovery,
dirty-deletion retry, request-side fence, drain, CAS/no-resurrection, strict candidate
validation, canonical token round-trip, entered-barrier concurrent touch/logout,
per-record fence (unrelated create/checkpoint, long-idle restart, in-flight
candidate/checkpoint unwritten-marker races, failed-checkpoint recovery),
worst-case 10k record cap.

`app/test/web-session-routes.test.js` — login durable-before-cookie, logout ack,
logout failure deny + retry, vault select failure keeps committed vault, vault
create partial failure fails closed, overdue fence + failed checkpoint 503,
disabled/deleted/revision fail closed, scope/vault removal.

`app/test/web-session-restart.test.js` — same cookie survives a hard child restart,
logout does not resurrect, expired/revision/disabled fail closed after restart, no
raw token or bearer/scopes on disk.

`app/test/web-session-shutdown.test.js` — idempotent SSE teardown, teardown reports
watcher close failures, never-settling teardown keeps admission fenced, SIGTERM ends
an active SSE stream and exits 0, failed drain exits non-zero, rejected/never-settling
watcher close bounded by the shared deadline and exits non-zero (child process with the
test-only `preload-stall-watcher.mjs`).
