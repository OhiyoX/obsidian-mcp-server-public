# Admin — Vault 与 Git (per-Vault Git configuration)

This page is the operator surface for the **per-Vault Git configuration store**: it shows the
canonical Vault inventory, each Vault's effective Git configuration and its runtime facts, and it
writes one Vault's record at a time under compare-and-swap (CAS).

Environment variables (`GIT_*`) stay the deployment baseline; see
[USER_CONFIGURATION.md](USER_CONFIGURATION.md#git--environment-baseline-vs-per-vault-records). Architecture authority:
`_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md`
§15–§17, §30 E4, §38.1, §42 SEC-MV04.

## 1. Where the page lives

| Item | Value |
| --- | --- |
| Page | Auth Center tab **Vault 与 Git** |
| URL | `/admin/auth/vault-git` (`/admin` redirects to `/admin/auth`) |
| Auth | the *existing* Admin session cookie plus the existing `csrf` hidden field |
| Routes | `GET /admin/auth/vault-git`, `POST …/save`, `POST …/refresh`, `POST …/verify` |

There is no separate, lower-protected management endpoint: every request goes through the same
`requireAdmin` + `requireCsrf` guards as the rest of the Auth Center. If the process cannot build a
trustworthy Vault registry or Git-config store, the assembly logs a warning and **the tab is absent
and no route is registered**, leaving the Auth Center exactly as it was.

This page is the Admin plane only. `root`, `canonicalRoot` and the configured `remote`/`branch`
names are never exposed to MCP clients or the Web app.

## 2. Per-Vault list

The summary table carries eight scannable columns ([layout standard §1](ADMIN_UI_LAYOUT_STANDARD.md#1-summary-vs-detail-issue-401):
summary rows stay short and the long facts live in the detail card):

| Column | Meaning |
| --- | --- |
| **Vault** | display name plus the canonical Vault ID |
| **角色** | `primary` / `secondary`, plus whether the Vault is writable (`可写`) or read-only (`只读`) |
| **Git 状态** | one of the five runtime states (§2.1) |
| **配置来源** | one of the three configuration sources (§2.2); the badge shows the canonical token and the explanation is in its `title` |
| **autoCommit** | effective value for automatic local commit, `开启` / `关闭` |
| **autoPush** | effective value for push-after-commit, `开启` / `关闭` |
| **sweep** | `autoCommitSweep` plus the effective `sweepIntervalSeconds` (for example `开启 900s`) |
| **remote / branch** | the configured remote **name** and branch (never a URL) |

Each Vault also has an expandable detail panel (open by default for the primary Vault) with: `id`,
`name`, 角色, `root` and `canonicalRoot` (Admin plane only), the **capability**
list, `repository`, `configError`, the loaded timer set, the pending/dirty detail (count, dirty flag,
the pending path list as its own `<details>`/`<ul>`, the oldest pending timestamp and the authors),
last sweep, last push, the effective configuration source, `updatedAt`, the configuration form and
the verify button.

Capabilities are runtime facts: each key renders as `<中文名> · 可用`, or as `<中文名> · 不可用` plus a
Chinese one-line hint when the descriptor reports it unavailable. The upstream `reason` (an
implementer decision record, contract §3.4) is never badge text — it stays in the DOM behind a
closed `技术细节` disclosure. An unmapped key falls back to `<key> · 不可用`; the page never turns a
missing capability into a silent blank.

The configuration form labels every control in Chinese with the canonical key as a sub-label
(`自动提交` / `autoCommit`), groups the controls into 开关 / 时间参数 / 远端, and keeps the save button
in its own action row.

### 2.1 Git states (five)

| State token | Label | Meaning |
| --- | --- | --- |
| `disabled` | 未启用（disabled） | Git is off for this Vault (no record on a secondary, or `enabled=false`) |
| `ready` | 已就绪（ready） | enabled, the repository was probed successfully and no push is failing |
| `repository-missing` | 仓库缺失（repository-missing） | enabled, but `git rev-parse --is-inside-work-tree` did not report a work tree |
| `config-invalid` | 配置无效（config-invalid） | the effective configuration could not be resolved (broken store or invalid record) |
| `push-failing` | 推送失败（push-failing） | enabled and ready, but the last push outcome failed |

An unknown / not-yet-reported state renders as `未知状态` instead of a guessed value: until Wave D
materializes per-Vault runtimes, a secondary Vault has no runtime and therefore no state.

### 2.2 Configuration sources (three)

| Source token | Label | Meaning |
| --- | --- | --- |
| `env-default` | env-default（继承 `GIT_*` 环境默认） | a **primary** Vault with no persisted record: the effective values are exactly the deployment's `GIT_*` |
| `persisted` | persisted（Admin 已保存） | a stored record exists for this Vault; it wins over `GIT_*` and survives a restart |
| `default-disabled` | default-disabled（默认关闭） | a **secondary** Vault with no record: every toggle is forced off; timing/remote/branch values are still displayed as suggestions |

## 3. Configurable fields and bounds

The form is validated by the Git-config schema; the page additionally carries the same bounds as
HTML `min`/`max`/`maxlength` attributes. Nothing else decides bounds, names or credential shapes.

| Field | Type | Bounds / rule |
| --- | --- | --- |
| `enabled` | boolean | master switch for this Vault's Git integration |
| `autoCommit` | boolean | debounce and commit paths changed through MCP |
| `autoPush` | boolean | push after an automatic commit |
| `autoCommitSweep` | boolean | periodic whole-tree sweep |
| `debounceSeconds` | integer | **≥ 5**, ≤ 86400 |
| `maxDelaySeconds` | integer | **≥ 1**, ≤ 86400 |
| `sweepIntervalSeconds` | integer | **≥ 30**, ≤ 604800 |
| `remote` | string | **≤ 128** characters, non-empty, plain git remote **name** |
| `branch` | string | **≤ 240** characters, may be empty, plain git branch name |

Name rule for `remote` and `branch` — a name, never a URL and never a credential-bearing form:

- no `://` (rejects every URL scheme, so a URL cannot be entered at all);
- no `@` and no `:` (rejects the `userinfo@host:path` remote forms that can embed credentials);
- must not start with `-` (no option injection);
- no `..` parent segment;
- no whitespace and no control characters;
- must match `^[A-Za-z0-9][A-Za-z0-9._/-]*$`.

Document-level bounds: at most **64** Vault records per store, store file **≤ 1 MiB**, Vault ID
**≤ 80** characters. Unknown fields are rejected — in the submitted form (unknown control name) and
inside the record (unknown JSON key), so a hand-edited document cannot smuggle in a field the server
does not validate.

`updatedAt` is stamped by the store on every write and is not editable.

Omitted fields:

- a **first** save that omits a field uses the store default (`enabled` / `autoCommit` / `autoPush` /
  `autoCommitSweep` = false, `180` / `900` / `900` seconds, `remote=origin`, empty `branch`);
- a **later** save that omits a field keeps the value already stored for that Vault.

The Admin form always submits every field it renders, so a normal save never silently changes a field
the operator did not see.

`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` are **not** per-Vault record fields: commit identity and all
credentials stay deployment-level configuration.

## 4. What this page never does

- **No repository creation.** It never runs `git init`, never creates or clones a repository, and
  never creates or edits a remote. A vault without `.git` stays without `.git` until someone
  initializes it out of band.
- **No credential editing.** Deploy keys and credential material (`data/ssh/…`, credential
  helpers, the repository's own `.git/config`) are outside this surface; the page has no field for
  them.
- **No credential-bearing URL, ever.** `remote` must be a plain name and is rejected when it looks
  like a URL or carries userinfo; every rendered dynamic string additionally passes the project's
  credential scrubber, and diagnostic free text cannot name a credential keyword.
- **No new endpoint class.** Only `save`, `refresh` and `verify`, all under the existing Admin
  session + CSRF. There is no "repair" POST in this release (a repair button renders only if a
  repair action is injected by the deployment).

## 5. Operations

### 5.1 Save a Vault's configuration (CAS)

1. Open `/admin/auth/vault-git` and expand the Vault (the primary Vault is open by default).
2. Edit the fields and submit **保存该 Vault 的 Git 配置**.
3. If the store is readable the request is narrowed to the canonical record fields, merged over the
   Vault's current record, and written with the page's `revision` as `expectedRevision`.

Outcomes:

| Outcome | What the operator sees |
| --- | --- |
| Success | redirect back to the tab; the Vault now shows `persisted` and the new `updatedAt` |
| Revision conflict | HTTP **409**, page *配置已被他人修改* — nothing was written. Reload the page and re-apply your edit |
| Invalid field / unknown field | HTTP **400** with a frozen error code and a field hint; the rejected value is not echoed back |
| Unknown Vault | HTTP **404** |
| Unreadable store | HTTP **503** *Git 配置存储或 registry 不可用* (fail closed, see §6.1) |

CAS means concurrent operators cannot silently overwrite each other: a stale `revision` is an
explicit conflict, never a last-write-wins. The store serializes writes inside one process; it makes
no cross-process exclusion promise, which is exactly why CAS is mandatory for every write.

### 5.2 Effect of a successful save (reconcile)

A committed save is immediately followed by a **config reload + timer reconcile** on that Vault's
runtime:

- **disable** (`enabled=false`) clears the debounce, max-delay and sweep timers. Committed Git
  history, pending-change state and the push history are preserved — disabling never rewrites or
  drops committed state.
- **enabling the sweep** arms **exactly one** interval; it is armed only when `enabled` and
  `autoCommit` and `autoCommitSweep` are all true.
- **changing the interval** replaces the previous timer instead of stacking a second one.
- **`autoPush`** is not retroactive: enabling it does not push commits that already exist locally.
  Only commits created after the change trigger a push; use an explicit `git_push` for history.

The write is durable before the reconcile runs. If the reconcile itself fails, the save is still
successful; the failure is logged as a warning and the runtime reconciles again on the next
start/reload. Restarting the service re-reads the store and re-applies the persisted record over the
`GIT_*` baseline.

### 5.3 Verify repository and configuration

**验证 Git repo / config** is read-only: it re-reads the Vault's configuration, re-probes repository
presence and reports the resulting state and repository in a notice at the top of the page. It writes
nothing and touches no credential. Use it after changing `enabled`, `remote`/`branch`, or after
fixing a repository out of band.

### 5.4 Refresh the Vault inventory

**刷新 Vault 清单** re-scans the Vaults root and reports the new registry revision. It creates no
repo and changes no configuration. The inventory is scanned once at startup and then only on this
action — there is no watcher and no rescan per request. If the secondary Vaults root is unreadable,
the page degrades to a primary-only view with an explicit notice and the action answers with an
honest failure instead of a success it did not achieve; repair the root and refresh again.

## 6. Troubleshooting

### 6.1 The store is broken or unreadable (fail closed)

**Location.** `<DATA_PATH>/git-vaults.json` (`DATA_PATH` defaults to `/data`; the Docker topology
mounts the data volume at `/data`). The store never derives another path. It is written atomically
(temp file → `fsync` → rename, mode `0600`) and is outside the Vault contents.

**Symptom.** A card **Git 配置存储不可用** with an error code, every configuration form disabled, and
saves answered with HTTP 503. The primary runtime resolves `config-invalid`: all its timers are
cleared, `trackMutation` becomes a no-op, and the state badge shows 配置无效（config-invalid）.
Vault content tools, Web and MCP reads are unaffected.

**Causes.** Invalid JSON; an unsupported `schema` value; an unknown document or record key; a value
outside the bounds in §3; more than 64 records; a file larger than 1 MiB; or an I/O/stat failure.

**Recovery.**

```sh
# 1. inspect, then keep a copy of the current file
ls -l  <DATA_PATH>/git-vaults.json
cp -p <DATA_PATH>/git-vaults.json <DATA_PATH>/git-vaults.json.bak
# 2. either repair the JSON/fields to match §3, or move the file aside
mv <DATA_PATH>/git-vaults.json <DATA_PATH>/git-vaults.json.broken
# 3. restart the service (or reload it) and re-check the page
```

A **missing** file is a valid empty store (revision 0), so moving it aside is a clean reset: it drops
every persisted per-Vault record and falls back to the §2.2 inheritance matrix. It does **not** touch
any repository, commit, credential or Vault note. The store never resets a corrupt file by itself and
never truncates silently — that is why the page shows the failure instead of an empty table.

If the page is missing entirely rather than broken, the assembly could not build the registry or the
store; check the service log for `[vault-git]` warnings.

### 6.2 仓库缺失（repository-missing）

Git is enabled for the Vault but no work tree was found at the Vault root. MCP content tools keep
working and are never blocked by a missing repository; there is simply nothing to commit. Fix it out
of band (`git init` / restore the clone) — this page intentionally does not create repositories — and
press **验证 Git repo / config**.

### 6.3 推送失败（push-failing）

The row shows `连续失败 <n>` and the last outcome. Use it to separate the classes:

| `failureClass` | Typical cause |
| --- | --- |
| `auth` | missing/rejected credentials or disabled terminal prompts — fix in the protected deployment configuration, never on this page |
| `unreachable` | DNS/route/connection failure, or the remote does not exist / is not a repository |
| `non-fast-forward` | the remote is ahead; integrate or fast-forward first |
| `no-upstream` | the branch has no upstream set |
| `rejected` | the remote refused the update (hook/protected branch) |
| `unknown` | anything else; read the scrubbed `summary` and the service log |

A failed push never fails the commit: the commit stays local and the failure is recorded.
`consecutiveFailures` resets to 0 on the first successful push. Credentials in any summary are always
masked before they reach the page or the log.

### 6.4 配置无效（config-invalid）on one Vault

The detail panel's `configError` names the failure. It appears when the store is unreadable (§6.1) or
when the stored record cannot be resolved. While it lasts, Git is disabled for that Vault — fail
closed, never "enabled with defaults". Fix the store (or the record) and press **验证 Git repo /
config**.

### 6.5 未知状态 / 未知来源

An unknown state means no runtime has reported facts for that Vault yet (typical for a secondary
Vault until per-Vault runtimes exist) or the runtime could not be read. An unknown source means the
configuration could not be resolved at all. Neither is silently replaced by a plausible value.

## 7. See also

- [ADMIN_UI_LAYOUT_STANDARD.md](ADMIN_UI_LAYOUT_STANDARD.md) — the Admin layout standard this page implements (column floors, badge size, form rows, detail-card separation).
- [USER_CONFIGURATION.md](USER_CONFIGURATION.md) — `GIT_*` environment baseline and the inheritance rules.
- [ARCHITECTURE.md](ARCHITECTURE.md), [WEB_AUTH_ARCHITECTURE.md](WEB_AUTH_ARCHITECTURE.md) — Admin auth plane.
- `docs/multi-vault/W0-D-git-characterization.md` — the frozen Git behavior this configuration drives.
