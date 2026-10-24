# W3 RETURN repair (candidate)

Authority: Issue 437 admission contract revision
`sha256:5240077f57b8dea1ac815b5c028f4797380ed7d495a9e7bf85f6020075895534`.
The historical RETURN bound `73844d9c`; this continuation starts at WIP
`35f60768`, on base `1dc52b3e82660ae5c78b3d4ae69e0cc9fd6edb00` (PR #496).
Evidence is execution self-validation, pending independent review on the final head.

## 1. Managed Admin refresh

The composition root injects the process's existing admission controller into the
Admin assembly. GET/model only read current facts. The protected manual refresh
calls that controller's `reconcile("manual")`; it creates no alternate registry,
runtime map or approval path. A clean commit renders HTTP 200, a coalesced trigger
renders 202 without claiming completion, and a failed/degraded round returns 503.
Failure retains the committed managed inventory instead of a synthesized primary.
Legacy instances retain their existing refresh/degradation behavior.

The actual W2 attached path is discovery/prepare → durable admission commit →
`registry.commit(..., { staged: true })` → `runtimeMap.commit(boundPlan)` → the
single composed-record switch → primary authorization binding. `applyStaged` is
the W2 standalone branch only: an attached registry explicitly refuses it. This
repair preserves that boundary rather than weakening it to permit direct refresh.

`vault-w3-admin-refresh-http.test.js` uses the real Auth Center router, login,
session-cookie/CSRF guards, TCP HTTP requests and a managed controller/map. It
checks matching durable/registry/runtime/serving facts, primary authorization,
invalid CSRF, a real filesystem failure and recovery. Loading the base Admin
modules produces the original valid-CSRF 503; the unchanged assertion fails.

No merge, release or deployment is implied. Final head, raw outputs, runtime
paths and remaining validation are recorded in `HANDOFF-W3-RETURN-FIX.md` in the
task scratch directory. W2 GO and the #441 composition prerequisite remain in force.

## 2. Admin admission projection and operations

The Admin-only list combines structural descriptors, published admission facts,
durable admission decisions and the service's runtime status. The two dimensions
stay separate: pending/approved decision; unavailable/initializing/ready/error
runtime state. W2's pending gate status projects as unavailable with its original
reason. Pending/missing/refused ids remain visible to Admin without creating a
content descriptor, granting service rights, or triggering scans on GET/model.
Durable decisions take precedence so a coalesced revoke displays pending immediately.

All three forms use the Auth Center's existing Admin session and CSRF guards:

| POST suffix under `/admin/auth/vault-git` | Allowed fields besides `csrf` |
| --- | --- |
| `/admission/initialize` | explicit `confirm` id(s), repeated form fields supported |
| `/admission/approve` | one known `vaultId` |
| `/admission/revoke` | one known `vaultId` |

The server supplies trusted actor `admin:auth-center`; client actor/unknown fields
are rejected. Operations use the same controller and service, never write approval
directly. Valid completed operations return 200, coalesced publication returns 202,
invalid input returns 400, identity conflict returns 403, and unavailable service/
storage returns 503. A CSRF failure is 403; no session redirects to login.
Initialization does not infer completion from a prior history entry during a flight.

Git save/verify and runtime status probing refuse nonservable ids. Content/map
resolution remains W2-authoritative. A captured secondary handle stops serving new
I/O after revoke; primary revoke denies process authorization, and refresh cannot
approve it. Real HTTP tests cover these controls, explicit initialization, failure,
coalesced operations and subsequent reapproval. Same-pending-world base projection
is invisible (`htmlBeta:false`); repaired projection is visible (`htmlBeta:true`),
while the serving list stays `[vault,alpha]` in both worlds.

## 3. Behavioral negative controls

The old five helper-level tests are replaced with seven managed composition/
consumer tests. They consume public composed facts or actual filesystem reader
facades. Production source and W2 assertions are not weakened. A test-only module
load hook injects one matched source mutation into each fresh child process;
`verify-vault-w3-controls.mjs` requires assertion failure (exit 1, exactly one test,
zero pass/skip/cancel), then the same test with no injection must pass (exit 0).
All seven also run together without the hook. A timeout/load error is never red proof.

| Test | Injected violation | Required behavioral counterexample |
| --- | --- | --- |
| NC1 | Map `forEach` passes the writable backing copy | delete/set changes public membership |
| NC2 | Set `forEach` passes the writable backing copy | delete/add changes the allow-set |
| NC3 | captured facade looks up the current entry's lease on each call | old consumer wrongly inherits fresh approval |
| NC4 | ignore committed generation in currency check | old reader starts new I/O before re-resolution |
| NC5 | reuse equal generation even when the lease is revoked | proof recovery returns the old revoked facade |
| NC6 | omit actual identity proof check | captured reader starts I/O after proof deletion |
| NC7 | omit runtime-map serving check | resolving a refused id returns a facade |

NC1/NC2 attempt real writes through the callback third argument before checking its
shape. Each attempts mutation once, so appended entries cannot cause an endless
delete/reinsert traversal. They also verify public values are frozen and runtime
entries are opaque. The driver keeps per-test raw red/green evidence under explicit
`DATA_PATH/w3-control-evidence`; copy it into the task handoff before cleanup.

The checkpoint's first NC3 injector (`entry.lease`) did not break W2: publication
copies owner entries, so the old closure still held its old lease. The driver
correctly rejected that non-counterexample. The replacement injects a real
current-membership lookup on every captured operation; NC3 assertions stay intact.

Local runtime is Windows Node 26.3.0. New-head Linux/Node 22 CI, browser/real MCP
transport and NAS production remain separate, unverified gates. No frontend bundle
source changes were made. This is a candidate for independent review, not a GO.

The first static check found `src/app/vault-registry.js` at 507 lines (500 budget).
The existing controller delegation/aliases and new Admin binding were extracted
into `src/app/vault-admission-admin-binding.js`; public W2 names and refusal/legacy
semantics stay unchanged. The HTTP harness also uses this production binding.
The budget was neither raised nor waived. Final raw check results are in the handoff.

The full-suite continuation keeps the single-registry composition assertion intact
by retaining its original argument order. The Web export characterization adds
exactly the new `vaultAdmissionAdmin` name, checks its complete frozen key set and
identity with the existing W2 seams; the no-history/trash/version/Git assertion
and exact Web route whitelist remain unchanged. No admission/publication invariant
is relaxed to accommodate these additive Admin APIs.

Test isolation: always set absolute `DATA_PATH` and task-local `TEMP`/`TMP` outside
the Git worktree (still inside the project scratch directory). A temp fixture
inside the worktree can inherit its parent Git repository, invalidating a
repository-missing control.
Leave optional derived `TRASH_PATH`/`HISTORY_PATH`/`RETRIEVAL_INDEX_PATH` unset for
existing tests that set their own explicit fixture `DATA_PATH`; otherwise they
inherit the outer paths and disagree with the fixtures. The initial full-run
path failures and corrected-run results are retained separately in the handoff.

The HTTP harness rejects the complete Node/WHATWG fetch blocked-port set when
Windows allocates port 0, including low ports. The initial partial set caused one
full-run fixture failure (`bad port`); it was corrected without changing assertions.

## 4. C-ENV / H1 fixture-owned data binding

The HOLD at `ca5cfa0be16966dabfb64d505de480da7918384d` identified an undeclared
DATA_PATH prerequisite. `test/helpers/vault-w3-data-path.js` binds the caller's
explicit root or creates a fresh `os.tmpdir()/vault-w3-data-*` directory before
the HTTP harness dynamically imports production config consumers. The fixture
refuses the product default/drive root and rejects later binding drift. Each HTTP
world still owns its independent `mkdtemp` directory and retains all behavioral
assertions. Only fixture-owned fallback roots are removed by suite cleanup.

The seven-control CLI uses this same binding before spawning children. Explicit
calls still require `app/.data-local`; an absent DATA_PATH accepts only the newly
owned isolated root. Every assertion/exit/count/injection gate remains in place.
Its stdout is retained before fallback-root cleanup, including actual DATA_PATH.
No `.github/workflows/**` or CI runner configuration is changed by this repair.

`vault-w3-data-path.test.js` checks fresh-process config binding, both ownership
modes, cleanup ownership, binding drift and refusal of the product default.
The H1 cache-config/delete-env/pending diagnostic and HTTP10/control7 runs in both
environments are recorded in the new scratch `HANDOFF-W3-RETURN-FIX-2.md`.
These are execution evidence; exact-head Linux CI and independent seat re-binding
remain H2 requirements and are not replaced by Windows results.
