# Web v1 deprecation gate (Phase 4A)

This document freezes **when** the v1 compatibility layer may be removed, and what
evidence is accepted. Phase 4A only builds the evidence; it removes nothing.

## What is still compatibility-only

| item | where | status |
|---|---|---|
| `/api/web/v1/notes` | `app/src/app/routes.js` | registered, deprecated-but-supported |
| 300-result cap | `listWebTreeNotes()` / `listWebNotes()` in `app/src/app/vault-registry.js` | **unchanged** |
| `MAX_WEB_NOTES = 10_000` | same file | **unchanged** |

The Explorer tree and the search UI are both v2 (`/api/web/v2/tree`,
`/api/web/v2/search`), so no first-party code depends on those caps any more — but
that is a source-level fact, not yet a production-level one.

## Removal gate

`/api/web/v1/notes` may be removed only when **all** of the following hold:

1. **Source guard** — no production frontend file references the endpoint
   (`app/test/web-search-v2-cutover.test.js` asserts this).
2. **Browser trace** — the Chromium regression harness observes
   **first-party `/api/web/v1/notes` request count = 0** across the search, paging,
   cursor-recovery, semantic and clear flows.
3. **Production observation** — in a production environment where Phase 3B is
   deployed and this observation code is live, **authenticated** first-party
   `/api/web/v1/notes` **request attempts** stay **0 for 7 consecutive 24-hour
   periods**, crossing **at least one formal deployment or restart**, with **unbroken
   observation continuity**, **and no `WEB_DEPRECATION_EVIDENCE_BROKEN` marker in the
   container log sink during that window**.

   **Only fully completed UTC days count.** The day a deploy or reset happened is not a
   complete observation day; the window is the 7 completed UTC days before today, and
   `startedDay` must be strictly before the first of them. A window that starts at
   23:59 therefore still has to run a full 168h.

   **Semantics: request attempts, not successful responses.** A valid client that
   receives the fail-closed `503` is *still* depending on v1, so it counts as usage.
   The metrics file cannot record its own write failure, so an unrecorded attempt is
   emitted to the independent ops channel as
   `WEB_DEPRECATION_EVIDENCE_BROKEN reason=unrecorded-attempt counter=web.v1.notes.requests day=<UTC day>`.
   Because the same failing file system cannot be the evidence, the gate additionally
   requires that this marker never appears in the **independent ops sink** during the
   window.

   **The ops sink must be configured and proven; it is a mandatory pre-gate.**
   Measured on the production host: the container runs the Docker **`json-file`** driver
   and its log lives at `/var/lib/docker/containers/<container-id>/<id>-json.log`, i.e.
   a **per-container** path that `docker rm` / recreate deletes with the container. It is
   a different volume from the app data, but it is **not** durable across a redeploy, so
   it cannot be the evidence sink on its own.

   Before the 7-day clock may start, one of these must hold:

   1. **`WEB_DEPRECATION_OPS_LOG` points at a durable path outside the metrics volume**
      (append-only file, no rotation inside the window), or the deployment pipes
      container logs to a durable sink (journald/syslog/collector); **and**
   2. a real verification: emit a marker, perform a formal recreate/redeploy, and show
      the pre-deploy marker is still queryable afterwards, recording the actual driver
      (`docker inspect --format '{{.HostConfig.LogConfig.Type}} {{.LogPath}}'`,
      `docker info --format '{{.LoggingDriver}}'`).

   Without that evidence the observation window must not start.

   **An independent monitor is mandatory, not optional.** The two local channels
   (metrics file + `WEB_DEPRECATION_OPS_LOG`) cannot prove their own blindness: when both
   are unwritable the process has no way to record that it was blind, and a restart would
   reload a clean-looking file. The gate therefore requires an **attestation from an
   independent host/collector monitor** whose record is persisted outside both channels
   and survives container restart (`deprecationWindow(metrics, { …, monitor })`). Its
   `healthyDays` must cover **every day of the window and today** — otherwise "no marker
   was needed" would be mistaken for "the sink was healthy" — and any day it reports
   broken fails the gate. `brokenDays` must come from that independent evidence, never
   from `evidenceState().ops`. A local `WEB_DEPRECATION_OPS_LOG` **without** third-party
   monitoring cannot satisfy the request-attempt removal gate.

   **Continuous sink health, not just retention.** A one-off recreate test proves
   retention, not that every marker written during the window reached the sink. The
   code therefore reports the append result (`markUnrecordedAttempt()` returns it), and
   a failed append **invalidates the current epoch** (`ops-sink-failure`) with an
   operational signal carrying the error code only. `deprecationWindow()` fails when no
   sink is configured and when the epoch recorded any ops-sink write failure, so any
   ops-sink write/ingestion failure during the window invalidates it and restarts the
   7-day clock. With an external collector, that collector's own durable
   health/ingestion record is the evidence.

`authenticated` is deliberate: scanners, expired cookies and unauthenticated probes
must never keep v1 alive. The question being answered is whether a *valid Web client*
still depends on it.

If any condition is not met, the endpoint stays deprecated-but-supported and its own
legacy cap may remain.

## The counters

`app/src/app/route-metrics.js` keeps a small on-disk aggregate keyed by **UTC day
bucket**:

| counter | meaning |
|---|---|
| `web.v1.notes.requests` | authenticated first-party v1 notes usage (the gate) |
| `web.v2.tree.requests` | authenticated v2 tree pages |
| `web.v2.search.requests` | authenticated v2 search pages |
| `web.v2.search.semantic.requested` | semantic requested |
| `web.v2.search.semantic.used` | semantic actually used |
| `web.v2.search.semantic.degraded` | semantic requested but answered lexically (explicit) |
| `web.v2.failure.catalog_not_ready` | `catalog-not-ready` responses |
| `web.v2.failure.cursor_stale` | `cursor-stale` responses |

### Continuity (the epoch)

The file carries a small `observation` block — `epoch`, `startedDay`, bounded
`resets: [{day, reason}]`, `invalid` / `invalidReason` — with **day granularity and fixed
reason strings only**. A companion `<file>.epoch` marker (written once per epoch) makes
"first-ever deploy" distinguishable from "a window that was established and then lost".

| event | effect |
|---|---|
| first creation | epoch 1, `startedDay` = today, reset reason `created` |
| normal restart / deploy | same epoch and `startedDay` — an unbroken window keeps its start day |
| file missing after an established window | **new epoch**, reason `missing` |
| file corrupted / not JSON | **new epoch**, reason `corrupted` |
| different schema version | **new epoch**, reason `version` |
| file already marked invalid | **new epoch**, reason `invalid-epoch`; its counts are **not** carried forward |
| **persistence failure** | the current epoch becomes `invalid` (`persist-failure`), an operational signal with the **error code only** is emitted once, and `count()` returns `false` |

**A persistence failure makes the v1 endpoint fail closed.** It does *not* make the
request disappear from the gate: the attempt is reported to the ops channel above. If the v1 counter cannot be
written, `GET /api/web/v1/notes` answers **503 `evidence-unavailable`** instead of a normal
success. A broken evidence store therefore cannot read as a clean zero: the request that
would have been a v1 "use" is served as a failure, and the client sees it.

`observation.heartbeat` is a **secondary** continuity signal: one write per day proves the
evidence file was writable at some point that day. It is deliberately *not* the only
protection, because a same-day restart would write a fresh heartbeat after an earlier
failure — the fail-closed rule above is what makes the window sound.

A window therefore only counts while `evidenceState().valid === true`, every day carries
a heartbeat, **and** `startedDay` is at least 7 days old. **Any** reset — including a persistence failure —
restarts the 7-day clock, so a lost increment can never be mistaken for a clean zero.
Formal deployments stay evidenced by the external deployment record; no deployment or
user information is written into the metrics files.

### Why it is durable

A process-local counter cannot prove a 7-day window: one restart on day 4 would break
the chain. The store therefore writes the aggregate to disk **synchronously on every
increment** (atomic temp + rename), keeps the last 30 day buckets, and is reloaded on
startup. A fresh process, container recreate or deploy continues the same buckets.

### Why it is privacy-safe

* **Allowlist only**: only the names above can ever be written; anything else is
  dropped, including on load of a hand-edited file.
* **Aggregate integers only**: no request records, no query, no note path, no Vault
  name or id, no user id, no IP, no user agent, no timestamps finer than a UTC day.
* **Never a public surface**: the store is written from authenticated route handlers
  only (after `requireApi` + `currentVault`), and is not exposed by any endpoint.
* A damaged or missing file degrades to empty rather than failing a request.

## Order of operations

```
4A observability + docs  ->  merge  ->  formal deploy
    -> 7-day observation starts at that deploy
    -> (in parallel: production on-site verification that needs no deletion)
    -> 4B cap / v1 compatibility removal
    -> final production verification
```

## Observability (catalog)

Phase 4A does not invent a second health state machine and adds no reconcile
timing/counts: the existing catalog status (`generation`, `stale`, `reconciling`,
`covered`, `coverageEpoch`) is unchanged. The route counters above are the long-horizon
evidence.

## The independent monitor (compose sidecar, zero host configuration)

The window's `brokenDays` must come from evidence the app cannot author, so the gate
reads a second, independent channel: a `deprecation-monitor` sidecar in
`docker-compose.yaml`. It writes one attestation line per check to **stdout**, and the
`journald` log driver ships it to the host journal — the app never sees or writes it.

```
journalctl -t web-deprecation-monitor --since "7 days ago"
# WEB_DEPRECATION_MONITOR day=2026-10-04 status=healthy reason=none ops_writable=1 markers=0
```

Each run checks: the app's `/healthz`, that `/data/route-metrics.json` is still a v2
observation document, that the ops sink is writable by the app's own uid, and the
`WEB_DEPRECATION_EVIDENCE_BROKEN` marker count. It reports `status=broken reason=...`
rather than staying silent, so a broken day is visible *in the same channel* the gate
trusts. The gate accepts only lines with `status=healthy` and a non-empty `day=`.

Boundaries (all verified with `docker inspect`, and deliberately narrow):

| property | value |
|---|---|
| root filesystem | `read_only: true` (only `/tmp` is a tmpfs) |
| capabilities | `cap_drop: [ALL]` + `no-new-privileges:true` |
| network exposure | no ports; it only reaches the app by service name |
| filesystem access | `./data:/data:ro` — read-only, so it can never modify evidence |
| identity | `user: "1002:10"`, the same uid as the app, so `test -w` reflects reality |
| host footprint | none: no systemd unit, no host directory, no Docker daemon config change |

The `journald` driver is a **per-container** log option; it needs no `daemon.json`
change, which is why the attestation channel stays inside the project. `MONITOR_INTERVAL_SECONDS`
(default `3600`) sets the cadence; restart the container to force an immediate check.

Negative test (proves the monitor observes rather than always reports healthy): make the
sink unwritable for its uid and wait for the next run — it must print
`status=broken reason=ops-sink-unwritable ops_writable=0`, then return to `status=healthy`
once the permission is restored.
