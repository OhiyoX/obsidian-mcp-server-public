# W0-D — Git characterization (#255 / #265 current semantics)

Status: **characterization only — zero behavior change.** This document freezes the Git behavior that
exists on BASE `6dc8154c6843c426ad40d136ef43e4d1d79d2790` so Wave B4 (per-vault `GitRuntime`,
contract §15/§16) can preserve it item by item. It does **not** fix #255/#265 and does not comment on
their issue conclusions.

- Contract authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md` §1.9, §15, §16, §25 W0-D, §38, §44 item 8.
- Frozen test: `app/test/multi-vault-git-characterization.test.js` (6 cases) + helper `app/test/helpers/git-characterization-child.mjs`.
- Reproduce: `cd app && node --test test/multi-vault-git-characterization.test.js` (6 pass, ~14 s, no network).
- Base facts used throughout: `app/src/git.js`, `app/src/git-push-observability.js`, `app/src/config.js`.

Isolation note (brief §1.2): every case runs in a child process. `config.js:45-55` reads `GIT_*` at
import time, and `git.js:28-42` holds module-level pending/timer/queue state while `git.js:495` arms a
process-global sweep timer as an import side effect. One `node` process per scenario is the only way to
get a fresh module state and a per-scenario env without touching `app/src/**`.

---

## 1. env → behavior mapping

All Git env is read once, at module import time, in `app/src/config.js:45-55`; changing it requires a
process restart. `parseBool` (`config.js:4-6`) is truthy **only** for `1/true/yes/on` (case-insensitive);
`parseInteger` (`config.js:8-11`) falls back when the value is not a finite integer.

| Variable | Default | Effective when | Invalid / floor handling | Anchor |
| --- | --- | --- | --- | --- |
| `GIT_ENABLED` | `false` | hard gate for every Git operation | non-truthy string → `false` | `config.js:45`, `git.js:49-51,138,157,379` |
| `GIT_AUTO_COMMIT` | `false` | narrows `GIT_ENABLED`: pending tracking, timers, sweep | non-truthy → `false` | `config.js:46`, `git.js:138,157,310,353,379` |
| `GIT_AUTO_PUSH` | `false` | passed as `push` to auto-commit flush and sweep | non-truthy → `false` | `config.js:47`, `git.js:331,364` |
| `GIT_COMMIT_DEBOUNCE_SECONDS` | `180` | idle debounce before a batch commit | `Math.max(5, …)`; NaN → 180 | `config.js:48`, `git.js:174-179` |
| `GIT_COMMIT_MAX_DELAY_SECONDS` | `900` | hard deadline from the oldest pending start | `Math.max(1, …)`; NaN → 900 | `config.js:49`, `git.js:158-166` |
| `GIT_AUTO_COMMIT_SWEEP` | `true` | whole-tree sweep + sweep timer | non-truthy → `false` | `config.js:50`, `git.js:353,379` |
| `GIT_SWEEP_INTERVAL_SECONDS` | `900` | sweep timer interval | `Math.max(30, …)`; NaN → 900 | `config.js:51`, `git.js:378-384` |
| `GIT_AUTHOR_NAME` | `Obsidian MCP` | sweep author agent; also the ambient Git author identity | empty → `Obsidian MCP` | `config.js:52`, `git.js:362` |
| `GIT_AUTHOR_EMAIL` | `obsidian-mcp@local` | `-c user.email` for every auto-commit | empty → `obsidian-mcp@local` | `config.js:53`, `git.js:273` |
| `GIT_REMOTE` | `origin` | default remote for pull/push/auto-push | validated by `validateRemoteOrBranch` | `config.js:54`, `git.js:103-107` |
| `GIT_BRANCH` | `""` | optional explicit branch for pull/push | empty → `null` in `gitConfiguration()` | `config.js:55`, `git.js:130` |

Manual tools are gated by `GIT_ENABLED` only: `git_status`/`git_diff`/`git_log`/`git_commit`/
`git_pull`/`git_push` call `requireEnabled()` (`git.js:49-51`) but **never** consult
`GIT_AUTO_COMMIT`/`GIT_AUTO_PUSH` (`app/src/tools/git.js:6-43`, `git.js:305-308,455-458,489-492`).

Observed facts (frozen by the test):

- `GIT_ENABLED=false` → `trackGitMutation` returns before `requireRequestAuthor()` and before touching
  pending state, so it is a silent no-op even with no request context; `getGitStatus()` throws
  `Git integration is disabled. Set GIT_ENABLED=true and rebuild/recreate the container.`
- Because `.env`/compose export `GIT_AUTHOR_NAME`, git's own `GIT_AUTHOR_NAME` env **wins over** the
  per-commit `-c user.name="${agent} (${model})"` (`git.js:270-273`). All auto-commits then carry the
  env author name; the real MCP agent/model survives only in the message trailers. With the env unset,
  the author becomes `<agent> (<model>)` for MCP batches and `Obsidian MCP (auto-sweep)` for sweeps.
  (Precedence verified directly: `GIT_AUTHOR_NAME=EnvName git -c user.name=ConfigName commit` → `%an = EnvName`.)

Commands: `grep -n "GIT_" app/src/config.js`; `cd app && node --test test/multi-vault-git-characterization.test.js`.

---

## 2. Timer mechanism

Three module-level timers, all `unref()`'d, all process-global (`git.js:30-32`):

1. **commit debounce** — `commitTimer` (`git.js:174-179`). (Re)armed on every `trackGitMutation` via
   `armPendingTimers()`, delay `GIT_COMMIT_DEBOUNCE_SECONDS * 1000`. Each new track replaces the
   timer, so it always measures the quiet period since the last write. Fires
   `flushAutoCommit()` and logs failures with `console.error("Git auto-commit failed: …")`.
2. **max-delay deadline** — `maxDelayTimer` (`git.js:190-200`), two kinds:
   - `deadline` at `pendingSince + GIT_COMMIT_MAX_DELAY_SECONDS` when that is still in the future
     (`git.js:158-164`). `pendingSince` is the **oldest** start, so later writes never extend it
     (frozen test: a 1 s deadline lands a batch while the 5 s debounce is still counting).
   - `imminent` at the 25 ms floor `PENDING_TIMER_FLOOR_MS` (`git.js:38,167-170`) when the deadline is
     already past and this oldest start has not spent its one retry (`imminentFlushFor`, `git.js:39`).
     Once spent, a later/again-expired deadline is dropped so only the debounce cadence retries
     (`git.js:171-175`) — this is the anti-retry-storm rule.
   Re-arming can only move the deadline **earlier** (`git.js:161-164`).
3. **sweep interval** — `sweepTimer` (`git.js:378-384`), `setInterval` at
   `max(1, intervalSeconds) * 1000` (the 30 s floor is already applied in config), armed exactly once
   (guard `|| sweepTimer`) and only when `GIT_ENABLED && GIT_AUTO_COMMIT && GIT_AUTO_COMMIT_SWEEP`.
   Armed at import by `startSweepTimer()` (`git.js:495`); `stopSweepTimer()` (`git.js:386-392`) clears it.

Process-exit behavior: all timers are `unref()`'d, so they never keep the process alive; there is **no
persistence** of pending state or timers. A restart drops an un-flushed pending batch (the files stay
modified in the working tree and are later caught by a sweep if enabled). `flushAutoCommit` clears both
commit/max-delay timers before snapshotting (`git.js:314-317`); a failed flush restores the batches and
re-arms scheduling through `restorePendingBatches()` → `armPendingTimers()` (`git.js:412-431`).

Commands: `sed -n '156,210p' app/src/git.js`; `node --test test/multi-vault-git-characterization.test.js --test-name-pattern="max-delay"`.

---

## 3. Pending model

- `pendingPaths` — a `Set` of vault-relative normalized paths (`git.js:28`). Normalization
  `normalizeGitPath` (`git.js:88-101`) rejects empty/traversal/`..`/absolute escapes and throws
  `Git path must identify a file or folder inside the vault` / `Git path traversal denied`. Set
  semantics dedupe the same normalized path across writes.
- `pendingAuthors` — `Map` keyed `` `${agent}\u0000${model}` `` (`git.js:140-141`), each bucket
  `{ author, paths: Set }`. Bucket insertion order is first-seen author order and decides the order of
  the commits `flushAutoCommit` emits.
- `pendingSince` — ISO string, set only when it is `null` (`git.js:149`), i.e. the oldest pending
  start. `earliestPendingSince` (`git.js:202-209`) pulls it back to the older value when a failed
  commit restores an older batch.
- Writers: `trackGitMutation(paths)` (`git.js:137-152`) — arrays or a single path. Callers:
  - `app/src/vault.js:216` (`atomicWriteFileUnlocked`; import at `:5`) — every MCP write that goes
    through the atomic writer;
  - `app/src/batch-journal.js:376` (import at `:6`) — every item finalized by a mutation journal;
  - `app/src/tools/files.js:461` (import at `:6`) — folder delete.
- Cleanup: `flushAutoCommit` snapshots and clears all pending state (`git.js:314-317`);
  `detachPendingPaths(scopes)` removes only the committed scope and keeps later same-path entries
  (`git.js:395-410`); `resetPendingIfIdle()` drops timers and `pendingSince` only when the set is
  empty (`git.js:433-441`); `restorePendingBatches` re-adds on failure (`git.js:412-431`).
- Empty flush → `{ committed: false, reason: "No pending MCP changes", paths: [] }` with no enqueue
  (`git.js:318-321`).

Order caveat: `gitConfiguration()` sorts `pendingPaths` for display (`git.js:131`), so insertion order
is observable only through the per-author bucket path list that reaches `commitUnlocked` (frozen by
the `pending-model` case: tracks `b.md, a.md, b.md, dir/x.md, dir` → bucket path order
`["b.md","a.md","dir/x.md","dir"]`).

Commands: `grep -rn "trackGitMutation" app/src/`; `node --test test/multi-vault-git-characterization.test.js --test-name-pattern="pending state"`.

---

## 4. operationQueue serialization

`let operationQueue = Promise.resolve()` (`git.js:36`); `enqueue` (`git.js:82-86`) chains work with
`operationQueue.then(operation, operation)` — the second argument means a **rejected predecessor still
runs the next operation**, and `operationQueue = result.catch(() => {})` swallows the chain error so the
queue is never stuck. A failed git operation therefore does **not** stop the queue.

Enqueued (serialized) operations: `commitGit` (`git.js:305-308`), `flushAutoCommit`'s commit loop
(`git.js:323-348`), `sweepAutoCommit` (`git.js:356-376`), `pullGit` (`git.js:455-458`), `pushGit`
(`git.js:489-492`). Consequence: one slow/hung push blocks every later queued Git operation.

Not enqueued: `getGitStatus`/`getGitDiff`/`getGitLog` are read paths (`git.js:211-247`), and
`pullUnlocked` calls `getGitStatus()` internally (`git.js:444-448`) — so a `git status` can run
concurrently with a queued commit (contract §38.2 "A operationQueue 阻塞不阻塞 B manual status" is
about the *future* per-vault queue; today there is only one queue).

Commands: `sed -n '82,86p;305,375p' app/src/git.js`.

---

## 5. Push observability (#255 current state)

Module state: `lastOutcome` and `consecutiveFailures` are process-global in
`app/src/git-push-observability.js:44-45` (the exact singleton contract §1.9/§16 says B4 must make per
vault). `recordPushOutcome(outcome)` (`:47-54`) stamps `at` (ISO), sets `consecutiveFailures = pushed
? 0 : previous + 1`, and stores `lastOutcome`.

- Success: `pushUnlocked` records `{pushed:true, remote, branch, exitCode:0, failureClass:null,
  summary:null, head}` (`git.js:469`) and returns a scrubbed `output` (`git.js:470`).
- Failure: `pushUnlocked` records `{pushed:false, …, failureClass: classifyPushFailure(error),
  summary: scrubCredentials(error.stderr||error.stdout||error.message), head}` (`git.js:472-480`),
  then `console.warn(formatPushFailureLog(outcome))` (`git.js:481`) — a single stderr WARN line
  `Git push failed [<class>] remote=… branch=… exit=… consecutive=…: <summary>` (formatter
  `git-push-observability.js:69-73`) — and throws a `pushError` carrying `pushOutcome`
  (`git.js:482-485`).
- Failure classification: `classifyPushFailure` (`git-push-observability.js:34-42`) checks in order
  `non-fast-forward` → `no-upstream` → `auth` → `unreachable` → `rejected` → `unknown` (exit code 0
  would be `none`).
- Credential scrubbing: `scrubCredentials` (`git-push-observability.js:19-32`) clips to 400 chars and
  masks URL userinfo, `Authorization` headers, GitHub/GitLab token shapes and `password/token/secret=`
  values. No credential value is ever written by Git code.
- Not swallowed / commit preserved: `commitUnlocked` **catches** the push error and reports
  `result.push = error.pushOutcome` instead of throwing (`git.js:285-296`), so a failed push never
  undoes a committed batch; `result.pushed = result.push.pushed === true` (`git.js:297`).
- Visibility entry point: `git_status` → `configuration.push` (`app/src/tools/git.js:6-10` →
  `getGitStatus` `git.js:211-224` → `gitConfiguration().push` `git.js:133` → `pushObservability()`
  `git-push-observability.js:56-61`). Shape: `{ lastOutcome: {at, pushed, remote, branch, exitCode,
  failureClass, summary, head, consecutiveFailures} | null, consecutiveFailures }`.

Remaining gaps (recorded as facts; #255 stays open): `lastOutcome` is **in-memory** (lost on restart);
there is **no** first-failure self-check (`git push --dry-run` or equivalent) to separate
"unreachable/no-credentials" from "remote refused"; and `lastOutcome` is only assigned when a push is
attempted, so it is `null` until the first push.

Commands: `sed -n '460,492p' app/src/git.js`; `node --test test/multi-vault-git-characterization.test.js --test-name-pattern="#255"`.

---

## 6. Sweep semantics (#265 current state)

`sweepAutoCommit()` (`git.js:351-376`) is the only mechanism that commits changes MCP never wrote
(module comment `git.js:44-46`).

- Gate: `if (!GIT_AUTO_COMMIT || !GIT_AUTO_COMMIT_SWEEP) return { committed:false, reason:"Automatic
  tree sweep is disabled" }` (`git.js:353`) — so `GIT_AUTO_COMMIT=false` disables the sweep even when
  `GIT_AUTO_COMMIT_SWEEP=true`.
- Commit: `commitUnlocked({ includeAll:true, consumePending:true, author:{agent:GIT_AUTHOR_NAME,
  model:"auto-sweep"}, message: SWEEP_MESSAGE, push: GIT_AUTO_PUSH })` (`git.js:356-365`), i.e.
  `git add --all` + `git commit` over the whole tree (`git.js:259,276`). Covered sources, all frozen by
  the test: MCP writes, Syncthing/other-device pulls, Obsidian-app and plugin edits, other host agents,
  deletions, and untracked files (`.gitignore`d paths stay ignored because `git add --all` honors it).
- Distinct identity: message `chore(obsidian): sweep vault working-tree changes` (`git.js:47`; #436 made
  the wording neutral — a sweep may fold pending MCP writes into its own commit, so it must not claim
  "non-MCP" content; the sweep's scope and its interaction with pending batches are unchanged), JS
  author model `auto-sweep`. Git author name is `<GIT_AUTHOR_NAME> (auto-sweep)` only when the
  `GIT_AUTHOR_NAME` env is unset; with `.env`/compose exporting it, the Git author is that env value
  for every commit (see §1).
- Pending interaction: `consumePending:true` → `detachPendingPaths(null)` (`git.js:258`) removes **all**
  pre-existing pending MCP batches, so those paths land in the sweep commit under the sweep
  author/message instead of their own `chore(obsidian): save MCP changes` commit. Paths tracked while
  the sweep is in flight survive (later batch).
- Empty sweep: `commitUnlocked` returns `{ committed:false, reason:"No staged changes" }`
  (`git.js:264-269`); `lastSweep.committed=false`.
- Observability: `lastSweep = { at, committed, hash, reason, pushed }` (`git.js:35,367-374`), exposed as
  `gitConfiguration().lastSweep` (`git.js:128`) → `git_status`; a successful sweep also logs
  `console.warn("Git sweep committed <7-char> (working-tree commit by auto-sweep; may include pending MCP writes)")` (`git.js:373`; #436 wording — the sweep is the executor, the content may include pending
  MCP writes) — the
  frozen test asserts both.
- Timer: `startSweepTimer(intervalSeconds = GIT_SWEEP_INTERVAL_SECONDS)` (`git.js:378-384`), armed once
  at import (`git.js:495`); floor 30 s.

Known gaps (facts, not desired end state): (a) sweep state, timer and `lastSweep` are process-global —
contract §1.9/§44 old-red #8 and B4's `GitRuntime`; (b) `lastSweep` is in-memory; (c) the default
900 s interval leaves "remaining tree" changes uncommitted for up to ~15 min; (d) a sweep folds a
pending MCP batch into the sweep author/message, so `git log` attribution for those paths differs from
a normal MCP batch.

Commands: `sed -n '351,392p' app/src/git.js`; `node --test test/multi-vault-git-characterization.test.js --test-name-pattern="sweep"`.

---

## 7. Command binding

`gitBaseArgs()` (`git.js:53-55`) returns
`["-c", "safe.directory=<VAULT>", "-c", "core.quotepath=false", "-C", "<VAULT>"]`, prepended to every
command in `runGit` (`git.js:61`). The `-C <VAULT>` root is the hard-bound process-global `VAULT`
(`config.js:26`); `safe.directory` is set for that same root so Git accepts the mounted work tree
regardless of uid ownership.

`runGit` (`git.js:57-80`) runs `execFile("git", ...)` with:

- `env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }` (`git.js:63`) — Git can never block on an
  interactive credential prompt; credentials/identity must come from the process environment/home Git
  config or from deployment-provided SSH material (`GIT_SSH_COMMAND`/deploy key, per `gh issue view
  255`). **No credential value is read, stored, logged or asserted anywhere in Git code** — the only
  credential handling is output sanitization via `scrubCredentials` (`git-push-observability.js:19-32`).
- `maxBuffer` default 4 MiB (`git.js:62`), overridable per call.
- On a non-allowed exit code, the thrown error carries machine-readable fields `gitCommand`,
  `exitCode`, `stderr`, `stdout` (`git.js:74-76`); `allowExitCodes` lets a caller accept specific codes
  (used by `git diff --cached --quiet`, `git.js:264`).

Remote/branch safety: `validateRemoteOrBranch(value, label)` (`git.js:103-107`) rejects a leading `-`
(option injection) and any character outside `[A-Za-z0-9._/@:-]`, throwing `Invalid Git remote` /
`Invalid Git branch`. `GIT_BRANCH=""` is allowed and means "let Git pick the current branch".

Commands: `sed -n '53,80p' app/src/git.js`; `grep -n "GIT_TERMINAL_PROMPT\|safe.directory" app/src/git.js`.

---

## 8. Failure-class table (current behavior)

| Failure | Trigger (current code) | Returned / logged / state | Anchor |
| --- | --- | --- | --- |
| Git disabled | any Git tool while `GIT_ENABLED=false` | `requireEnabled()` throws; tools return `err(...)`; no pending state | `git.js:49-51,138`; `app/src/tools/git.js:10` |
| Not a repository | `rev-parse --is-inside-work-tree !== "true"` | throws `The mounted vault is not a Git working tree`; tools return `err(...)` | `git.js:109-116` |
| Dirty work tree on pull | `pullUnlocked` sees `!status.clean` | throws `Refusing to pull with uncommitted changes; commit or clean the vault first`; nothing changes | `git.js:443-451` |
| Commit rejected (hook, etc.) | `git commit` non-zero | `commitUnlocked` restores pending + rethrows (`git.js:301-303`); `flushAutoCommit` → `console.error("Git auto-commit failed: …")`; manual `git_commit` → `err()` | `git.js:269-276,301-303,323-348` |
| Push rejected / non-fast-forward | remote refuses the update | push error caught, commit kept; `push.failureClass="non-fast-forward"`, WARN once, `consecutiveFailures++` | `git.js:285-296,472-485`; `git-push-observability.js:36` |
| No remote with upstream set | e.g. `origin` absent but `branch.<b>.remote=origin` | `failureClass="unreachable"`; commit kept; WARN once | `git-push-observability.js:39` |
| No upstream at all | push without upstream config | `failureClass="no-upstream"` (checked before `unreachable`) | `git-push-observability.js:37` |
| Missing / rejected credentials | auth error text | `failureClass="auth"`; summary scrubbed; commit kept | `git-push-observability.js:38`; `git.js:478` |
| Invalid remote/branch | value starts with `-` or has bad chars | throws `Invalid Git remote`/`Invalid Git branch`, no Git command runs | `git.js:103-107,462-464` |
| Concurrent lock / transient Git error | any `runGit` throw (e.g. `index.lock`) | error propagates out of `commitUnlocked`, pending batch restored, batch retried on the debounce cadence; queue continues | `git.js:74-76,301-303,412-431`, `git.js:82-86` |
| Sweep disabled | `GIT_AUTO_COMMIT=false` or `GIT_AUTO_COMMIT_SWEEP=false` | `{committed:false, reason:"Automatic tree sweep is disabled"}`; no error | `git.js:353` |

`classifyPushFailure` priority is `non-fast-forward → no-upstream → auth → unreachable → rejected →
unknown` (`git-push-observability.js:35-41`); the frozen push test exercises both `unreachable`
(upstream set, remote absent) and `no-upstream` (upstream removed) to pin that order.

Commands: `sed -n '34,42p' app/src/git-push-observability.js`; `node --test test/multi-vault-git-characterization.test.js --test-name-pattern="push"`.

---

## 9. Reconciliation with `gh issue view 255` / `gh issue view 265`

Both features are **already on BASE** (merged before this task): #255 by PR #264 (`9bcdb21`), #265 by
PR #266 (`d642c1a`); `app/test/git-push-observability.test.js` and `app/test/git-sweep.test.js` already
cover them. Both issues remain OPEN, so this document reconciles the issue text with current code
**without** changing or commenting on either issue.

- **#255 期望** 1-4 are implemented: structured credential-free log (`git.js:481`,
  `git-push-observability.js:69-73`), `pushed:true|false` + summary on the commit result
  (`git.js:284-297`), `git_status` → `configuration.push.lastOutcome.at` (`git.js:133`),
  WARN-level + `consecutiveFailures` counting (`git.js:481`, `git-push-observability.js:48-51`).
  Item 5 (optional first-failure self-check to separate unreachable/no-credentials from refused) is
  **not** implemented → the issue's optional acceptance item is still open.
  The issue's own owner comment (2026-10-05) says the deployment-side cause (missing container uid /
  credentials) was worked around and "本 issue 仍未解决" referred to the silent-failure code, which is
  now the #264 code on BASE. Difference to record: the issue's line "push失败没有日志" is **historical**
  for this BASE; current code logs and exposes the outcome.
- **#265 期望** 1-3 are implemented: low-frequency whole-tree sweep with a distinct author/message
  (`git.js:47,351-365`), `GIT_AUTO_COMMIT_SWEEP` + `GIT_SWEEP_INTERVAL_SECONDS` gated on enabled Git
  (`config.js:50-51`, `git.js:353`), and result observability `lastSweep` + non-silent failure
  (`git.js:367-374`, sweep errors `console.error` at `git.js:381`).
  Difference to record: the issue body's premise ("auto-commit 只覆盖 MCP 写入路径") is **historical**
  for this BASE — the sweep exists. What remains open is not the missing sweep but its process-global
  nature and per-vault isolation (contract §1.9, §44 item 8, Wave B4).

## 10. What Wave B4 must keep / improve

- Keep: env semantics and floors (§1), debounce/max-delay/imminent cadence (§2), pending dedup +
  per-author bucket order + oldest-start deadline (§3), one serialized queue per runtime (§4), push
  classification/scrub/counting/visibility (§5), sweep coverage + distinct identity + `lastSweep` (§6),
  `-C` root + `safe.directory` + no-prompt credential mechanism (§7), the failure semantics (§8).
- Improve (B4, contract §15/§16): all of the above module-level state becomes per-vault `GitRuntime`
  instance state (`git.js:28-42`, `git-push-observability.js:44-45`), `gitBaseArgs()` takes the runtime
  root instead of the global `VAULT` (`git.js:53-55`), and `git_status`/Admin report per-vault
  `push`/`lastSweep`. Update this doc and the characterization test together when that lands.

---

## 11. Migration note — Wave B / B4 landed (2026-10-06)

Status after lane B4 (branch `feat/mv-b4-git-migration`): the §10 **keep** list is preserved item by
item, verified by running this document's frozen suite unchanged as the parity gate
(`cd app && node --test test/multi-vault-git-characterization.test.js` → 6/6 green), and the §10
**improve** items landed as follows — no §1–§9 fact above changed:

- pending batches → `src/git-runtime/pending.js` (per instance); debounce/max-delay/imminent/sweep
  handles → `src/git-runtime/timers.js` (per instance); `lastSweep`/operationQueue/config → private
  `GitRuntime` fields; push `lastOutcome`/`consecutiveFailures` → `createPushHistory()` in
  `src/git-push-observability.js` (one history per runtime).
- `-C <root>`/`safe.directory` now come from the runtime's own root (`git-runtime/operations.js`),
  which for the primary is still the mounted `VAULT`.
- `src/git.js` is the compatibility facade that builds the primary runtime from the A5 store
  (`DATA_PATH/git-vaults.json`) plus the `GIT_*` baseline, so `git_status`/`gitConfiguration()` shape
  and the #255/#265 semantics are unchanged. Per-vault `git_status`/Admin reporting stays deferred to
  Wave D/E (`GitRuntime.status()` already exposes `state`/`config`/`push`/`lastSweep`).
- One textual delta: the disabled-vault error is now the per-vault runtime message
  (`Git integration is disabled for this vault`) instead of the env-oriented legacy sentence; the
  frozen assertion (`/Git integration is disabled/`) still holds. See the B4 HANDOFF for the risk
  record.

Owner map and ratchet changes: `docs/multi-vault/W0-A-core-state-inventory.md` §4.1 + §6.4.
