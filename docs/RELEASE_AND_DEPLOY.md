# Source sync, release, and NAS deployment

**Scope:** This document describes how an operator syncs source, publishes an
immutable version, and deploys it. Release identity is the annotated tag plus
the evidence receipt bound to its exact commit and tree. Treat the command
examples as version-specific and validate the CI checks for the candidate SHA.

The NAS Compose directory is a historically dirty runtime checkout.
**Do not pull Git into that directory.**
These commands run from the repository root with Python 3, Git, Node 22, SSH,
SCP, and Docker Compose available on the respective machines.

**Operator workstation (Windows).** Run the release script with the
Miniconda base interpreter: Git Bash
`/c/Users/example/miniconda3/python.exe scripts/release.py …` (PowerShell:
`& "C:\Users\example\miniconda3\python.exe" scripts/release.py …`). The
`python`/`py` names on PATH resolve only to the Windows Store stub. Do not run
release operations from WSL: repository credentials live on the Windows side,
and a worktree created by Windows git is unusable from WSL git (its `gitdir:`
pointer is a Windows absolute path).

## 1. Sync and develop

```sh
python scripts/release.py sync
cd app
npm ci
npm run check
npm test
npm run build:web
```

Commit source and generated Web assets together. Push the reviewed commit to
`origin/main` **only through an authorized, reviewed change**; validate the
CI checks at the exact candidate SHA and the required local evidence. Before
publishing a tag, inspect the actual current workflow
triggers and release-script verification behavior. `sync` requires a clean local `main` and
only fast-forwards it. Agent development should use separate branches/worktrees
and merge reviewed changes to `main` before publishing. When several people or
agents may be operating on the repository — even if only suspected — prefer a
dedicated `git worktree` created from the current `origin/main` over switching
branches in the main checkout: it keeps the main checkout clean for
`sync`/`publish` and isolates each lane's uncommitted state.

## 0. CI is off (operator decision, 2026-10-31)

`.github/workflows/ci.yml` is `workflow_dispatch` only. `public-checks.yml` remains the push and
pull-request check. The full CI workflow is intact, so restoring its triggers is the whole re-arm.

What that means for releases, until CI is re-armed:

* the standing channel is **`local-fast`** and it is now the **default** of `publish`/`deploy`:
  publication and deployment consume an operator-reviewed `obsidian-local-validation/v1` receipt
  bound to the exact commit/tree, and never wait on a tag run;
* the receipt is produced from checks actually executed on this machine (or the environment the
  operator designated) — `run-python-tests-ci.py`, `npm run check`, the focused suite, and the Admin
  prototype-parity gate — with every artifact's SHA-256 recorded next to it;
* `--validation-channel ci` remains available and fails closed when there is no tag run to verify. It
  is not a fallback to "assume green";
* do not describe a release as CI-verified while this section stands: every receipt says
  `ci_run_verified: false` with the reason;
* what the receipt does **not** prove goes in `not_proven` — say it there instead of running a
  ten-minute suite the operator explicitly asked to skip for a small fix. Name the last commit that did
  run the full suite.

## 2. Publish an immutable source version

```sh
python scripts/release.py publish v2026.09.24
```

The command requires a clean `main` equal to `origin/main`. The CI channel runs local release checks; local-fast consumes matching evidence. It
creates an annotated tag, and pushes it. "Clean" means every tracked file
matches its committed bytes after Git EOL normalization: on a Windows
`core.autocrlf=true` checkout a `build:web` run that rewrites CRLF bundles as
LF passes, because `git status` would flag them from stale stat data while
`git diff` finds no normalized change. Real edits, staged changes, and
untracked files still stop the release. Use a `.N` suffix for another release
on the same day. The date component must be the release day: carrying an earlier day's
prefix forward is a process error, and because a published tag can never be retagged the
only remedy is fix-forward -- the next release uses the current day and its own `.N`
counter. (`release.py` only validates the tag shape, so the number-taking step has to
compare the prefix with the current date.) The default CI channel waits for the repository's tag CI; authorized local-fast uses matching local or operator-designated environment results. A tag is the release identity; never force-update a published tag.

`publish` itself never queries the tag's CI run — `deploy
--validation-channel ci` owns that gate — so every publish prints one
`obsidian-release-receipt/v1` receipt line with `"ci_run_verified": false` and
the real reason. `--ci-verification {require,skip}` is an auditable declaration
only: it cannot make `publish` claim a CI result it never read.

## 3. Preview and deploy

```sh
python scripts/release.py deploy v2026.09.24
python scripts/release.py deploy v2026.09.24 --apply
```

The first deployment through this pipeline requires `--adopt` on `--apply`
after reviewing the preview. It backs up the existing files, including those
from the dirty historical checkout. Later deployments compare production files
with the previous release manifest and refuse unexpected edits. Reconcile drift
manually, then publish a new release. The preview reports exact paths and
whether the change needs only file sync, a service restart, a recreate, or an
image rebuild. It does not print `.env` or container environment values.

The local script archives tracked files from the tag, uploads them to
`<project>/.deploy-state/incoming/`, and runs `scripts/nas_deploy.py` on NAS.
The deploy target is operator configuration and is **never stored in the
repository**: pass it explicitly with `--project`, or set the protected
`OBSIDIAN_MCP_DEPLOY_PROJECT` environment variable (the explicit CLI value
wins). When both are missing, the command fails locally before any
SSH/SCP/NAS side effect; `deploy` and `rollback` share the same rule. From
Git Bash on Windows, prefix the command with `MSYS_NO_PATHCONV=1` so an
absolute Unix-style `--project` argument is not rewritten into a Windows
path (WSL and plain bash need no prefix). The target's `.env`, `data/`,
Vault, `.git`, and untracked files are never copied or deleted by the
archive. If the SSH account cannot run Docker directly, set `NASCODE` in
the **local process environment**; the script supplies it to `sudo` over
SSH stdin and does not include it in commands, Git, archives, or logs. Do
not place it in repo files.

An application copies all changed files before restarting once. It validates
Compose and checks the container is healthy, runs `node server.js`, and returns
HTTP 200 from local `/healthz`. A restart revokes in-memory Web sessions.

### Deployed version marker

Every `apply` and `rollback` writes `data/deployed-version.json` in the target
project:

```json
{ "version": "v2026.09.25.7", "commit": "<sha>", "deployedAt": "<iso>" }
```

`data/` is a protected, container-visible volume, so the running service reads
the marker from `DATA_PATH` and reports the deployed release without a Git pull
or a rebuilt image. `MCP_SERVER_VERSION` stays the fallback for local runs that
have no marker. The version is visible in the Web app sidebar footer, the
`/admin/auth` header, `GET /healthz`, the authenticated `GET /`, and the MCP
`server_info` result.
Dependency or Dockerfile changes build a new image without taking the stack
down. Code and image rollback is attempted automatically if validation fails.
Deployment backups and manifests live under
`<project>/.deploy-state/releases/<tag>/` and `.deploy-state/state.json`.

After deployment, verify live MCP tools and Web behavior through their normal
authenticated clients. For the mobile / touch surfaces (Explorer touch prefetch,
Bases mobile chrome and table touch, the mobile shell, and asset drop upload),
run the real-device checklist in [docs/manual-mobile-verification.md](manual-mobile-verification.md).
Record the deployed commit and the result in the Obsidian project note.
**Deploy time on the API surfaces.** Since 2026-10-10 the surfaces that reported the version also report the deploy time: the authenticated `GET /`, `GET /healthz` (NAS-side; the public edge does not proxy it) and the MCP `server_info` result carry `commit`, `deployedAt` (the raw ISO 8601 UTC value from the marker) and a formatted `deployedAtFormatted` / `deployedAtLabel` pair naming both a local-time form with its UTC offset and the raw ISO. The Web/Admin chrome renders the same pair. When no marker exists (local runs, pre-pipeline checkouts) the fields are `null` and the UI shows an explicit not-deployed (local run) label instead of an empty slot.


### Direct upload admission control (`PUT /uploads/`, issue #470 follow-up)

Wave A bounded one body (50 MiB) and one writer per handle. The data plane now also bounds how
many PUTs a credential may start, how much staging space they may consume, and how long a single
body may hold one of the in-flight slots; all six knobs are `.env` values and apply only to
`PUT /uploads/:uploadId` (never `/mcp`, `/api/web/*` or the legacy chunk tools).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIRECT_UPLOAD_RATE_PER_MINUTE` | `6` | Sustained **uploads** started per credential per minute (burst up to the same number). One upload = one handle: the first write that carries it pays, and the later `PATCH` chunks of that same handle do not pay again (issue #698). |
| `DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL` | `2` | Data-plane requests in flight per credential (`PUT` or `PATCH`, claimed per request). |
| `DIRECT_UPLOAD_MAX_CONCURRENT_GLOBAL` | `8` | Data-plane requests in flight across the instance. |
| `DIRECT_UPLOAD_MIN_FREE_BYTES` | `536870912` (512 MiB) | Refuse a new PUT while the staging disk has less free space; `0` disables the gate. |
| `DIRECT_UPLOAD_IDLE_TIMEOUT_MS` | `30000` (30 s) | Abort a PUT that sent no new byte for this long; `0` disables the bound. |
| `DIRECT_UPLOAD_MAX_DURATION_MS` | `240000` (4 min) | Abort a PUT whose body has been streaming for this long (clock starts at the first byte); `0` disables the bound. |

The limit key is the verified credential id; only a credential without an id falls back to the peer
address, and that fallback is marked `credentialSource:"ip"` in the audit line. Different
credentials have independent buckets and in-flight counters.

Refusals happen **before any body byte is read**:

- rate/concurrency: HTTP `429`, integer `Retry-After` (seconds) and `{"code":"rate_limited","retryAfterSeconds":N}`; the audit line uses `decision:"limited"` plus `limit:"rate"|"concurrency"` and names the `operation` (`put`/`patch`) and the `uploadId` — never allow/deny.
- staging disk below the threshold: HTTP `507` `insufficient_storage`. If `statfs` itself fails the check fails **open** and the audit line records `freeBytesUnknown:true`; a monitoring gap must not reject every upload. (The 507 is only for a measured shortage.)

**An admission refusal does not land on disk** (issue #725). The handle itself is created by
`start_direct_upload`, so before this rule a refused `PUT`/`PATCH` left its pre-created
`<uploadId>.json` and 0-byte `.part` behind until the 24 h TTL sweep (one empty shell per refusal,
which also inflated the staging directory's file count and the `scanned`/`removed` figures of that
sweep — not `/healthz`'s `orphanParts`, which skips a `.part` that still has its `.json`). The refusal
now reclaims that handle, and only one that provably carries nothing: an unwritten `single-put`
handle (`status:"uploading"`, `uploadedBytes 0`, no writer token, a 0-byte `.part`) within the
caller's writable Vaults, removed while holding the same writer lock a real writer takes (briefly;
that is also why a real writer arriving in that instant is answered the transient `409
UPLOAD_IN_PROGRESS`). A handle that is being streamed into, already has staged bytes, is
`failed-retryable`, sits outside the caller's Vaults, or that another admitted request of this
process is about to write is left untouched. Reclamation is scoped by Vault membership, not by
credential: the handle stores no credential id, so the guard cannot distinguish two credentials that
may write the same Vault. When a refusal reclaimed the handle the answer carries `handleDiscarded:true`
and `restartRequired:true` (plus `restartTool:"start_direct_upload"`), and the audit line carries
`handleDiscarded:true`; the other refusal fields are unchanged.

The rate token is charged **per upload, not per request** (issue #698). The first write that carries
an upload (the whole-body `PUT`, or the first `PATCH` chunk of a handle) spends one token; every
later chunk of that same `(credential, uploadId)` pair continues the admission already granted and
spends nothing. Otherwise the default 8 MiB chunking of a full 50 MiB file — seven chunks — would
need seven tokens from a six-per-minute budget and the seventh, perfectly compliant request would be
refused. A **different handle is a different upload** and still spends a token; only the rate gate
is amortised. The four abuse gates below (per-credential in-flight, global in-flight, staging disk,
idle/total duration) stay **per request**.

**429 is backpressure, not a fatal error.** A client that receives `429` with `Retry-After: N` must
wait at least `N` seconds (or until the response's `retryAfterSeconds`) before re-sending the SAME
request, and should apply the same wait to the upload it is currently writing. Treat `429` the same
way as the transient `409 UPLOAD_IN_PROGRESS` described under "Resumable direct upload" below: back
off and retry, never restart the upload or discard the bytes the server already acknowledged. A
`Retry-After` is always an integer number of seconds and is never sent without the `429`. The one
exception is the explicit `restartRequired:true` above: that refusal already reclaimed a handle that
held no bytes, so after the wait the client calls `start_direct_upload` again instead of retrying a
`uploadId` that no longer exists (`404`).

In-flight slots are released on response close and on every rejection path, including a client that
aborts mid-body; a leak would otherwise answer 429 forever. Tune the values for the deployed disk
and expected client concurrency, then keep the nginx `client_max_body_size 50m` aligned with
`DIRECT_UPLOAD_MAX_BYTES`.

**Time bounds (same route, nothing else).** A slow client can hold one of the 8 global in-flight
slots indefinitely, and `n × 50 MiB` is not the only way to starve the data plane: one stalled body
per slot is enough. The data plane therefore bounds each PUT in time:

- `DIRECT_UPLOAD_IDLE_TIMEOUT_MS` (default 30 s): no **new** byte for that long ⇒ abort, HTTP `408` `upload_idle_timeout`.
- `DIRECT_UPLOAD_MAX_DURATION_MS` (default 4 min): the body has been streaming for that long since its **first** byte ⇒ abort, HTTP `408` `upload_max_duration`.

Both abort paths behave like any other interruption: the `.part` file is **not** published, the handle
becomes `failed-retryable`, and the in-flight slot is released immediately — a fresh
`start_direct_upload` can be uploaded on the same credential right away. The audit line uses
`decision:"timeout"` with the code, never `allow`/`deny`, so a stalled client is distinguishable from
a rejected one. A client that already disconnected is not reported as a 408; its socket teardown
keeps the existing interruption semantics.

These values are **per route on purpose**. Do not move them to `server.requestTimeout`,
`server.headersTimeout` or `server.timeout`: `POST /mcp` is a long-lived SSE transport that
legitimately idles for many minutes, and a process-wide timeout would cut healthy sessions. The
default `MAX_DURATION` is 4 min and not 10 min because the edge nginx already gives up around 300 s;
a larger value here would never fire in production while looking like a real bound. Keep it below
the proxy's timeout, and keep `IDLE_TIMEOUT` short enough that one stalled socket cannot hold a
global slot for minutes.

### Resumable direct upload (`PATCH /uploads/`, issue #470 Wave B)

Wave B adds a second data-plane writer on the **same** handle, `PATCH /uploads/:uploadId`, so an
interrupted transfer continues from the bytes the server already accepted. It is a separate mode from
the whole-body `PUT`: pick one per upload.

| Item | Value |
| --- | --- |
| Method | `PATCH /uploads/:uploadId` (`PUT` + `Content-Range` is **not** implemented and answers `400 content_range_not_supported`). |
| Offset header | `Upload-Offset: <bytes already accepted>`. The server's `uploadedBytes` is the only authority; the header is a claim. |
| Continuity | Strictly contiguous, single writer per handle **inside one process**. Any gap or straddling chunk answers `409 UPLOAD_OFFSET_CONFLICT`. |
| Chunk size | `DIRECT_UPLOAD_PATCH_MAX_BYTES` (default `8 MiB`); larger answers `413 chunk_too_large`. |
| Success | `200` with `Upload-Offset: <new acknowledged length>` and a JSON body (`uploadedBytes`, `totalBytes`, `nextOffset`, `complete`). `204` is deliberately not used: the offset is the point of the answer. |
| Completion | The chunk that reaches `totalBytes` publishes through the **same** publish step as `PUT`, including the publish-time SHA-256 re-hash of the whole staged file; the response then carries `status:"COMPLETE"`, `path`, `size`, `sha256`, `revision`, `receiptId`. A later zero-byte `PATCH` at `Upload-Offset == totalBytes` only re-answers that receipt. |
| Idempotent retry | A chunk repeated at an **earlier** offset is accepted (`200`, `idempotentReplay:true`, no append) only when the staged range has the identical bytes; otherwise `409`. A request against a `COMPLETE` handle re-answers the receipt and never rewrites the Vault file. |
| Overrun | A chunk that would run past `totalBytes` answers `416 UPLOAD_RANGE_EXCEEDED`. Both `409` and `416` carry the authoritative `Upload-Offset` header **and** `uploadedBytes`/`nextOffset` in the body. The value is the one read **at the moment of the refusal** — the offset the writer read under the writer lock, or failing that a fresh read of the handle — never the copy the route read before the body was streamed (issue #470 follow-up F5: in the narrow interleave "another writer advanced between the route's check and the runtime's lock" that pre-stream copy is already stale). Only when neither a fresh value can be proven does the body add `offsetMayBeStale: true`, and the client must then re-read `file_upload_status` before retrying. |
| Interruption | A killed client or a mid-chunk abort keeps the acknowledged prefix in `.part` and marks the handle `failed-retryable`; the next `PATCH` at that offset continues. A dead writer's unacknowledged tail is truncated away, never counted. |
| Admission | `PATCH` shares the **same** rate bucket, in-flight slots, staging-disk gate, idle bound and total-duration bound as `PUT` (one credential, one budget). Since issue #698 the token is charged once per **upload**: the first write that carries the handle pays, and its later `PATCH` chunks are the continuation of that admission and do not spend another token. A new handle still spends one. |
| Limits | Whole-file ceiling unchanged (`min(DIRECT_UPLOAD_MAX_BYTES, MAX_TRANSFER_BYTES)`, default 50 MiB). |

Recovery is per handle: `file_upload_status` reports `uploadedBytes`/`nextOffset`, which is exactly the
`Upload-Offset` to resume with, and — once the handle is `complete` — the `receiptId` the completing
`PATCH`/`PUT` answered with (issue #470 follow-up F3), plus the pre-existing `result` `{path, size,
sha256, revision}`. So a client that lost the completing response recovers the receipt from status
**without** a second (zero-byte `PATCH`) round trip. `receiptId` is `null` while the handle is not
complete, and always `null` for the legacy base64 chunk path, which issues no receipt; the field is
never fabricated. Right after a disconnect the handle can still answer
`409 UPLOAD_IN_PROGRESS` for a short while as the previous writer unwinds; the measured range is
**275–539 ms** (it depends on how fast the dead writer's stream, audit line and writer-lock release
finish, so treat it as an observation and not a guarantee). A resuming client should retry the same
`PATCH` after a short backoff instead of restarting the upload or treating it as a fatal error. The
same backoff applies to `429` + `Retry-After` (see "Direct upload admission control" above). There is **no cross-process lock** — two server processes writing the
same handle is unsupported (and the handle directory belongs to one Vault, so a different credential
cannot see it at all). Reverse proxies must not buffer or split `PATCH` bodies (`proxy_request_buffering off`)
and must allow the method; re-check `client_max_body_size` against `DIRECT_UPLOAD_PATCH_MAX_BYTES`
for chunked clients (each request is at most one chunk).

### Audit trail on disk (`DATA_PATH/audit/`, issue #470 acceptance gap)

Every data-plane decision was already one structured line on stdout (`[direct-upload] {...}`), but the
documented NAS deployment cannot read it — `docker` needs root and `/srv/@docker` is `700` — and
the only durable copy was the 2000-entry ring inside `DATA_PATH/oauth/state.json -> audit[]` (about
8 hours of traffic, and a deleted credential's UUID can no longer be resolved there). The acceptance
probe for issue #470 therefore found **no** `.jsonl`/audit file under `data/` at all.

That gap is closed additively. The sink keeps **both** existing destinations and adds one file:

| Destination | Status | Content |
| --- | --- | --- |
| stdout (`[direct-upload] {...}`) | unchanged | the same JSON object, same key order |
| `DATA_PATH/oauth/state.json -> audit[]` | unchanged | provider/auth events, 2000-entry ring |
| `DATA_PATH/audit/YYYY-MM-DD.jsonl` | **new** | one JSON object per line, appended, never rewritten |

Details an operator needs:

- **Path and format** — `<DATA_PATH>/audit/<UTC day>.jsonl`, `0600`, directory `0700`; one compact JSON
  object per line, trailing newline, no header and no pretty-printing, so `jq -c` / `grep` work
  directly. Field names and order are the audit line's own (`event`, `requestId`, `operation`,
  `uploadId`, `vaultId`, `credentialId`, `decision`, `status`, `code`, `durationMs`, `bytes`,
  `digest`, plus the optional fields a given decision adds).
- **Rotation** — by UTC day. The local timezone is not part of the deployment contract, and a
  local-time name would split or merge a day after a TZ/DST change; `/healthz` reports the live name
  as `audit.currentFile` so nothing has to be guessed. `audit.currentFile` is `null` only until the
  sink registers the day, which happens just before the first append attempt of that day: a
  freshly started process with no audited line yet reports `null`, and so does a sink that cannot
  even establish the directory. When the directory exists but the write fails (read-only or full
  disk) `currentFile` is **already set** while nothing has landed — read `audit.written`,
  `audit.sinkFailures` and `audit.lastError` to tell whether bytes actually reached the file, and
  note the named file may not exist on disk. The sink recovers on the next line after the directory
  becomes writable again; no restart is needed.
- **Retention** — `AUDIT_RETENTION_DAYS` (default `14`, today included). The directory is scanned
  once at startup and then again each time the sink registers a day it has not registered yet —
  in practice that means one extra scan on the process's first audited line, and at most one per
  later day (noticed by the day's first audited line inside `record()`). It is never a per-request
  scan. `0`, a negative or a non-numeric value falls back to `14`. Only files matching
  `YYYY-MM-DD.jsonl` are ever deleted, so a hand-placed note in the directory is not collateral
  damage; retained files keep their bytes untouched.
- **Failure behaviour** — a full or read-only disk degrades to stdout-only, exactly like the audit
  behaviour that existed before: the request still succeeds. It is **not** silent: the failed/
  attempted count is `/healthz -> audit.sinkFailures` (plus `lastError`, `lastFailureAt`,
  `retentionFailures`, `removedFiles`, `lastSweepAt`), and one warning per distinct error code is
  logged. A non-zero `audit.sinkFailures` is a real operational alert, not noise.
- **Disabling** — `AUDIT_SINK_ENABLED=false` turns off only the file copy. stdout and the ring are
  untouched either way.
- **Ownership limits** — the file is written by the process that owns `DATA_PATH`; there is no
  cross-process lock (same rule as upload handles). Do not point two live processes at one
  `DATA_PATH`. Provider/auth events (`recordAudit`) are **not** mirrored here yet: they remain
  ring-only, which is a known, documented boundary of this batch rather than an oversight.
- **Reading it** — `jq -c 'select(.decision=="limited")' $DATA_PATH/audit/$(date -u +%F).jsonl`;
  `grep -F <uploadId-prefix>` for a data-plane line (it carries the first 8 characters) and
  `grep -F <full-uploadId>` for an `expired-sweep` line (it carries the full id, because the handle
  metadata is already gone by then).

### Expired upload handle sweep (startup)

Until this change nothing ever pruned `DATA_PATH/transfers/uploads` (and each secondary Vault's
`transfers/uploads`): handles and their `.part` payloads accumulated forever, because a handle was
only cleaned up when some caller happened to touch it again.

- **When** — once per process start, before the listener accepts traffic. Never on a request path
  (no directory scan while serving).
- **What is deleted** — a handle whose own `<uploadId>.json` metadata exists, parses, and whose
  `expiresAt` is in the past: the `<uploadId>.part` **first**, then the metadata. One audit line per
  removed handle (`operation:"expired-sweep"`, `decision:"expired-sweep"`, `code:"upload_expired"`,
  the full `uploadId`, `vaultId`, `bytes` staged).
- **Partial deletions leave a line** — deleting is not atomic, so a sweep that could not finish says
  so instead of looking like "nothing to delete":
  `code:"sweep_part_removal_failed"` (the `.part` could not go ⇒ the metadata is **kept**, so the
  next start retries the whole handle) and `code:"sweep_metadata_removal_failed"` (the bytes are
  already gone ⇒ only the metadata is left; the line is the only trace of it). Both carry the full
  `uploadId`, `vaultId`, `expiresAt` and the staged `bytes` when it is readable. `upload_expired`
  still means "removed".
- **What is never touched** — a bare `.part` with no metadata. It cannot be attributed to a handle,
  so it is left exactly where it is (counted as `orphanParts`); production carried 17 such files from
  before handles were durable and they must survive. Unreadable or corrupt metadata is kept and
  counted as a failure instead of being guessed at.
- **Observability** — `/healthz -> audit.expiredUploadSweep` = `{ scanned, removed, kept,
  orphanParts, failures, partRemovalFailures, metadataRemovalFailures, at }`. `failures` stays the
  total of everything that could not be read or deleted; the two new counters split it by which
  `rm` failed, so "bytes still on disk, retryable" is distinguishable from "only metadata left".
  A sweep that cannot read a directory increments `failures`; it never blocks startup.

### Handle TTL — decided: 24 h (owner, 2026-10-31)

The direct-upload handle TTL is `TRANSFER_TTL_MS` (24 h) and that **is the decision**, not a placeholder.
The MCP development contract's “10–15 min” suggestion was written against a *one-time capability URL*
(`presigned`-style); that design was **not** adopted (Wave A D1: `PUT`/`PATCH` re-check the caller's
credential on every request, so there is no leakable URL to keep short). With no URL to protect, the
TTL's practical job is deciding **when staging disk is reclaimed**: the handle is not bound to a
credential, so the expiry is also the only bound on how long another credential that learns an
`uploadId` could still write to it — negligible against a 128-bit random id, but not zero. A short
TTL would instead expire slow or backgrounded uploads mid-resume — a caller-visible cost for no
meaningful security gain. The staging disk is already bounded by `DIRECT_UPLOAD_MAX_BYTES`, the
free-space gate and the startup sweep above.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DIRECT_UPLOAD_TTL_MS` | unset ⇒ `TRANSFER_TTL_MS` (24 h) | Lifetime of a newly created direct-upload handle. Applies to new handles only; already-issued ones keep the expiry in their metadata. |

Changing it later is a config change, not a code change; the startup sweep above removes whatever the
old value left behind. An “idle since last write” expiry would be a behaviour change and needs its own
reviewed slice.

## 4. Roll back the current release

```sh
python scripts/release.py rollback v2026.09.24
```

Only the current completed release can be rolled back. The script refuses to
overwrite files modified since that release, restores the pre-release backup,
and recreates the prior service/image as needed. It leaves Vault and data
untouched. Check container health, MCP, and Web again after rollback.

## Validation channels and evidence reuse

The user may authorize a candidate/batch and publish/deploy actions together. For an authorized deployment, passing tests in the local or user-designated environment allow direct deployment without waiting for repository CI. The default `ci` channel remains for external/non-local development and candidates without trusted environment evidence. CI reports its real status separately; local verification does not mean CI passed.

`publish` and `deploy --apply` use the selected evidence once. The CI deploy path verifies the exact tag's successful release check and no longer repeats local suites at apply. The local-fast path verifies the exact commit/tree and artifact hashes without querying CI or rerunning test commands. Preview/drift, immutable tag identity, source/archive consistency, backups, Compose and live smoke remain required. A receipt is an operator-reviewed evidence record, not a grant of authority or a claim that every platform passed.

Keep the receipt and raw output outside the public checkout, for example in the project scratch directory:

```json
{
  "schema": "obsidian-local-validation/v1",
  "commit": "<40-character candidate SHA>",
  "tree": "<git rev-parse HEAD^{tree}>",
  "scope": "<changed behavior and required validation>",
  "environment": "<local or user-designated environment, runtime versions>",
  "not_proven": ["<platform or risk not tested>"],
  "checks": [{
    "command": "<actual command already run>",
    "exit_code": 0,
    "executed": 49,
    "failed": 0,
    "cancelled": 0,
    "skipped": 0,
    "todo": 0,
    "artifact": "results.txt",
    "sha256": "<SHA-256 of the original result file>"
  }]
}
```

`executed` is the reported total including skipped/todo cases; at least one check must actually have run. All-skipped, empty, failed, cancelled, todo, changed-artifact or mismatched-candidate receipts are refused. Review the scope and `not_proven` items before using it; include generated assets and the relevant browser/security/platform evidence where the change requires them. Commands are recorded as text and are never evaluated by the release tool. Artifact paths resolve relative to the receipt and can be absolute. Do not put secrets in the receipt, logs or authorization reference.

```sh
python scripts/release.py publish vYYYY.MM.DD.N --validation-channel local-fast --local-evidence /private/scratch/evidence.json --authorization "user approval reference covering publication"
python scripts/release.py deploy vYYYY.MM.DD.N --validation-channel local-fast --local-evidence /private/scratch/evidence.json --authorization "user approval reference covering the target deployment"
python scripts/release.py deploy vYYYY.MM.DD.N --apply --validation-channel local-fast --local-evidence /private/scratch/evidence.json --authorization "user approval reference covering the target deployment"
```

For a window-bound ancestor after main has advanced, `deploy --binding-sha <SHA> --binding-note <record>` remains **opt-in 已提供、默认仍不启用**. It verifies reachability, ancestry and agreement with the recorded binding. Omit it to require the tag at current main. No silence window, merge freeze or ACK wait is needed; take the authorized candidate once, then deploy its immutable tag.

The receipt and authorization reference are required when selecting local-fast. Existing branch protection remains in force; do not fabricate required checks or permanently disable protections. A real product/security failure must be resolved or explicitly decided by the user, even if another environment was green. Queues, cancellations and infrastructure failures do not by themselves invalidate trusted designated-environment results.

Rollback uses the prior deployment backup. To undo the new release-tool behavior, revert its source commit and use the retained CI channel. Repository changes remain candidates until merged; command examples do not claim that a release or deployment occurred.
