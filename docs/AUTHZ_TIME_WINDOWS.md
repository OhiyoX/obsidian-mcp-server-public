# AuthZ Time Windows — operator guide

Scope: issue 269 — time-window authorization layered on top of the existing
Scope/Vault authorization.

**Read §0 first.** The model that decides is no longer the one §1–§7 describe. Those
sections stay accurate for the **legacy** document, which is still on disk and still
readable, but its writes are frozen.

## 0. The per-Vault model (P4)

One document, one mode, one editor.

- **One durable document:** `DATA_PATH/authorization.json`. It owns the constraints and
  `timeConstraintsEnabled`. The subjects are derived from live credential state on every
  read and never written back, so a credential created after the cutover works at once and
  no credential route has to write this file (design §6.8).
- **One mode:** `AUTHORIZATION_MODE=legacy | shadow | enforce`, forwarded by
  `docker-compose.yaml` (`.env.example` documents it). `enforce` is the only mode whose
  answer comes from this document. `legacy` and `shadow` answer from the old gate, and in
  both the recorder still compares the new verdict beside that answer
  (`/healthz.authorizationShadow`); `shadow` is the mode where that comparison is the point.
- **A constraint is per subject and per Vault.** A constraint names subjects, one mode
  (`suspend` or `revoke`, as §1 defines them), a selector and a schedule. The selector
  picks surfaces, capabilities and **targets**, and a target is the instance or exactly one
  Vault: `{kind: "vault", vaultId: …}`. A window can therefore suspend `read_note` for one
  Vault while every other Vault stays open. A constraint with no Vault target keeps the
  principal-wide meaning §1 describes. Several matching constraints still intersect, and a
  revoke constraint is still all-or-nothing (design §6.4, §6.2).
- **The editor is the constraint page** `/admin/auth/authz`: list, drawer, create, update,
  toggle, delete. Writes are compare-and-swap on the document `revision` (a stale writer gets
  409 `stale_authorization_revision` and keeps its draft) and map to the existing
  `admin_authorization_manage` capability. Every write appends an audit row
  `authz.constraint.*` that carries the constraint id, the revision and the window before and
  after on one line: label, on/off, timezone, weekday hours, date ranges, start and expiry
  (`auditWindowText`, `app/server.js`; at most four day groups and four date ranges, then
  `+N`). It never carries a subject or a Vault id.
- **`/healthz` reports the model, nothing else:**
  `authorization: {mode, revision, constraints}` — the mode in force, the committed document
  revision (`null` while no document is readable) and how many constraints it holds. It
  never carries a subject id, a Vault id, a window, a capability or a label: `/healthz` is
  public, and those facts stay on Admin.
- **The legacy page is history.** `DATA_PATH/access-policy.json`, its page
  `/admin/auth/access-policy` and its routes stay on disk, read-only. The seven legacy writes
  (`POST …/access-policy/{create,update,toggle,delete,preview,repair,subjects}`) refuse with
  409 `access_policy_frozen` and point at `/admin/auth/authz`. They were frozen in the same
  deploy that seeded the document, because an accepted legacy edit would be stored and never
  apply. Nothing is deleted, and a re-seed is not allowed: the seed runs once, only when no
  document exists, and never overwrites one.
- **The cutover, the soak rule, the enforce proof and the rollback truth** are in
  [RELEASE_AND_DEPLOY.md](RELEASE_AND_DEPLOY.md), section
  "AuthZ per-Vault cutover (P4)".

§1–§7 below remain the reference for the legacy document and for the semantics the two
models share.

## 1. Feature semantics

- **Constraint-only.** Final allow = existing Scope/Vault authorization **AND**
  every matching time constraint passes. A policy can never grant access that the
  existing authorization would deny (DEVELOPMENT A-01/A-02).
- **`suspend` is fine-grained.** A suspend policy lists one or more capabilities
  (`tool:`, `toolset:`, `resource:`, `scope:`, `surface:`). Outside its window only
  the listed capabilities are denied with `outside_authorized_window`. The
  credential, session and transport stay valid; the next in-window request works
  without re-issuing a credential (DEVELOPMENT A-04).
- **`revoke` is principal-wide `all` only.** A revoke policy must carry exactly
  `["all"]`; the schema rejects anything else with `revoke_requires_all_capability`
  and never silently downgrades to suspend (A-03). Outside the window the whole
  principal is denied: MCP requests receive the existing 401 `invalid_token`
  challenge family (with no policy detail). Revoke is temporary, not destructive —
  no `revokedAt` write, no deletion of the API key/user/token/Web session, and the
  same durable credential authenticates again after the window (A-05).
- Multiple matching policies intersect. There is no priority, grant, or deny
  effect, and a more specific `tool:` entry does not override a broader `scope:`
  entry.
- **No authorization cache.** Every protected request is evaluated against the
  current server clock and the current immutable policy snapshot; allow results
  are never cached in an MCP session, Web session, or route cache (A-09).
- **Broken is not empty.** A missing file is a ready empty policy; a
  corrupt/unsupported/unreadable file is `broken` and fails closed
  (`authorization_policy_unavailable`), never "no policy, therefore allow" (A-11).

## 2. Subject and capability namespaces

Subjects are frozen; unknown subject types fail validation (DEVELOPMENT §6):

| runtime identity | subject |
| --- | --- |
| managed API key | `api-key:<keyId>` |
| configured environment API key | `api-key:configured-env` |
| OAuth client-only | `oauth-client:<clientId>` |
| OAuth user token | `oauth-client:<clientId>` + `oauth-user:<userId>` |
| Web session | `oauth-user:<userId>` |

Subjects are never derived from `username`/`displayName`, and never from a raw
token or secret hash. Deleting a credential does not auto-delete a policy: an
orphaned subject is shown in Admin but matches no request.

Capability vocabulary (DEVELOPMENT §7, INTERFACE §6):

```text
all
surface:mcp | surface:web | surface:oauth
scope:obsidian.read | scope:obsidian.write | scope:obsidian.files
toolset:<canonical toolset>
tool:<canonical tool name>
resource:<canonical MCP resource URI>
```

Tool/toolset/resource/scope names come from the existing sources of truth
(`app/src/scopes.js`, `app/src/capability-catalog.js`, `TOOL_NAMES` in
`app/src/config.js`); the access-policy module never restates them.

## 3. Policy file and limits

- One durable path, with no environment override: `DATA_PATH/access-policy.json`
  (used only by the Wave C wiring). The store accepts the caller-supplied `file`
  and never derives a path of its own.
- v1 never reads or writes `oauth/state.json` or `web/sessions.json`; a code
  rollback therefore does not require restoring either file.
- Hard bounds (`ACCESS_POLICY_LIMITS` in `app/src/access-policy/schema.js`):
  file ≤ 1 MiB, ≤ 512 policies, ≤ 32 subjects per policy, ≤ 64 capabilities per
  policy, ≤ 64 weekly intervals per policy, ≤ 64 date ranges per policy, label
  ≤ 120 characters, timezone name ≤ 80 characters.
- Writes are compare-and-swap guarded by the document `revision`. A stale writer
  gets `stale_policy_revision` (HTTP 409 in Admin) instead of last-write-wins.

## 4. Rollout path (Stage 0–5)

`docker-compose.yaml` forwards `AUTHZ_ENABLED: "${AUTHZ_ENABLED:-false}"`, so both
the rollout and the rollback below are `.env` changes plus a container recreate —
no compose edit is needed (regression: `app/test/compose-authz-flag.test.js`).

- **Stage 0 — code present, feature off.** `AUTHZ_ENABLED=false` (current).
  Verify: old API key/OAuth/Web/MCP behavior identical; tool inventory identical;
  a present or corrupt policy file does not affect any request.
- **Stage 1 — enable + empty policy.** `AUTHZ_ENABLED=true` with a ready, empty
  store. Verify every old path still matches Stage 0.
- **Stage 2 — temporary test principal `suspend`.** Exercise read/write/files
  windows, an exact boundary, and Admin status/audit. Do not use a real long-lived
  credential for the first disruptive smoke.
- **Stage 3 — temporary hard revoke.** Verify 401, session-close isolation,
  temporary refresh denial, and that the same credential works after the window.
- **Stage 4 — Web/SSE.** With a temporary user: suspend page/API, SSE closure
  across the window boundary, and recovery.
- **Stage 5 — operator adoption.** Configure real principals only once the earlier
  evidence is complete.

## 5. Rollback

1. Set `AUTHZ_ENABLED=false`.
2. Restart the service.
3. Re-run the old auth/Web/MCP smoke checks.

Keep `access-policy.json`; it is inert while the flag is off. If an Admin policy
write fails, repair or restore only `access-policy.json` — do not restore an older
`oauth/state.json`, which would discard later credential changes.

## 6. Admin repair surface when the policy is broken

The metadata/repair plane stays available while a policy is denying or broken:
MCP initialize/ping/tools/list, `server_info`, `agent_bootstrap`,
`obsidian://agent/memory-policy`, `/healthz`, OAuth discovery metadata, and the
Admin Auth Center (including the AuthZ "定时授权" tab and policy repair). The Admin
session itself is not subject to the policy, so a broken policy can always be
repaired from Admin. Denied content handlers are never invoked.

## 7. Deny responses do not leak Vault content

Deny and broken responses carry only the stable codes
`outside_authorized_window` (MCP isError / Web 403) and
`authorization_policy_unavailable` (MCP isError / Web 503). They never contain a
Vault path, title, revision or content, tokens/secrets/passwords, the full policy
JSON, or raw subject ids (Admin is the only exception). The gate runs before any
Vault read/write, filesystem/archive/attachment access, search or index content
fetch, publish management content read, cache lookup/compute, or MCP resource
handler, so a denied call performs no content I/O.

## References

- Contracts: `scratch/authz/INTERFACE.md` §5–§7, §10–§11; DEVELOPMENT §4–§5,
  §10, §18, §26–§27.
- Code: `app/src/access-policy/` (errors, subjects, capabilities, schema, store,
  time, evaluate, runtime) and `AUTHZ_ENABLED` in `app/src/server-config.js`.
