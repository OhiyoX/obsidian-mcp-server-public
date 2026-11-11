# Per-Vault Time Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One authorization subject can hold different time windows on different Vaults, edited in Admin, decided by the new authorization model only.

**Architecture:** The new-model document becomes durable (`src/authorization/store.js` + a real io seam under `DATA_PATH`). The file owns `constraints` and `timeConstraintsEnabled`; `subjects` stay derived from live credentials on every read, so no credential route learns to write the file. A one-way seed imports the live legacy state once. The Admin 「定时授权」 page becomes a constraint editor with a Vault scope. Legacy writes freeze in the same deploy as the seed, and `AUTHORIZATION_MODE` is forwarded by compose so the soak and the rollback are real.

**Tech Stack:** Node 22 ESM, `node:test`, Express, server-rendered Admin pages (CSP `default-src 'none'`, no client script), the existing `t()` i18n catalogs.

**Spec:** `docs/superpowers/specs/2026-11-09-authz-per-vault-windows-design.md`

## Global Constraints

- The new model is the only destination. No new behaviour is added to `src/access-policy/**`; it becomes read-only history.
- All Admin copy goes through `t()` with a `zh-CN` and an `en` entry. No literal text in a renderer.
- Admin pages stay scriptless: no `<script>`, no inline handler, no `onclick`. Every interaction is a real form POST carrying the session CSRF.
- Every document write goes through the store CAS with the `expectedRevision` the page rendered. A stale revision is a 409 with the draft kept on screen, never last-write-wins.
- Every accepted write appends one audit record through `provider.recordAudit`; a failing audit never turns a saved write into a failure and never hides one.
- Effective allow is `ceiling AND every matching constraint`. Constraints only subtract. Overlapping windows intersect.
- The token/name vocabulary is the catalog's: constraints store catalog operation ids plus surfaces, never legacy atoms.
- `AUTHORIZATION_LIMITS` from `src/authorization/schema.js` is the ceiling for the editor too: 512 constraints, 32 subjects per constraint, 64 branches, 64 weekly intervals, 64 date ranges, 65 targets. Past a limit, a specific message, never a stack trace.
- Never `git add .` or `git add -A`; name every file.
- CIFS mount: never run `npm install`. Tests run as `cd app && DATA_PATH=<tmp> node --test --test-concurrency=1 <files>`.

## Review Focus

1. **A window on Vault A must not touch Vault B.** A subject with a window on `a` and no window on `b` keeps full access to `b` inside and outside the window. Owned by Task 5's route test and Task 4's matching test.
2. **A credential created after the cutover works at once.** A new API key or OAuth account has no stored subject row; the derived subjects must give it its ceiling. Owned by Task 1's test.
3. **The master switch off is not "no authorization".** With `timeConstraintsEnabled: false` every constraint is inert and every ceiling still applies. Owned by Task 4 and Task 6.
4. **Two admins, one revision.** The second save on a stale revision must not overwrite the first. Owned by Task 4.
5. **A window naming a Vault that does not exist.** Refused at write with a specific reason, not stored as a constraint that silently never matches. Owned by Task 4.

---

### Task 1: Durable document in the deployment, with derived subjects

**Files:**
- Create: `app/src/authorization/node-io.js`
- Create: `app/src/authorization/deployment-document.js`
- Modify: `app/server.js:145-196` (the `createAuthorizationRuntime({ store: createShadowCandidate({…}) })` block)
- Modify: `docker-compose.yaml` (forward `AUTHORIZATION_MODE` and `AUTHZ_ENABLED` beside the other env lines)
- Modify: `.env.example` (document both)
- Test: `app/test/authorization-deployment-document.test.js`

**Interfaces:**
- Produces: `createNodeAuthorizationIo({ fsPromises })` → `{mkdir, readFile, open, rename, unlink, chmod}`, each `(…args) => Promise`.
- Produces: `createDeploymentDocument({ file, io, seed, deriveSubjects })` → `{ready, store}` where `store` is the shape `createAuthorizationRuntime` accepts: `ready`, `snapshot()`, `replace(expectedRevision, document)`, `repair(document)`, `drain()`.
  - `snapshot()` returns `{status:"ready", revision, document}` with `document.subjects` replaced by `deriveSubjects(stored.subjects)`; a loading or broken store returns the store's own snapshot unchanged, so the runtime still denies with `authorization_state_unavailable`.
  - With a broken-or-missing store and a `seed` function, it calls `store.repair(await seed())` once during `ready`; a throw from `seed` rejects `ready` (spec §11 C5).

- [ ] **Step 1: Write the failing test**

```js
// app/test/authorization-deployment-document.test.js
const io = fakeIo({ files: new Map() }); // reuse the store test's helper shape
const file = "/data/authorization.json";
const stored = { schemaVersion: 1, catalogVersion: 9, revision: 4, timeConstraintsEnabled: true,
  subjects: { "api-key:old": { credentialEpoch: 1, grants: [{ target: { kind: "instance" }, capabilities: ["read_note"] }] } },
  constraints: [] };
// 1. a missing file is seeded once, and the file is written
// 2. a credential that appears later is visible without a write
const store = createDeploymentDocument({ file, io, seed: async () => stored, deriveSubjects: () => ({ "api-key:new": { credentialEpoch: 1, grants: [] } }) });
await store.ready;
assert.equal(store.snapshot().document.subjects["api-key:new"].credentialEpoch, 1);
// 3. a seed that throws rejects ready and never publishes a document
```
Assert exactly those three behaviours, plus: the seeded file's bytes are written through `io.rename`, and the derived view does not mutate the stored document.

- [ ] **Step 2: Run the test, expect a module-not-found failure**

Run: `cd app && DATA_PATH=/tmp/pv-1 node --test --test-concurrency=1 test/authorization-deployment-document.test.js`

- [ ] **Step 3: Implement `node-io.js` and `deployment-document.js`**

`node-io.js` maps the six names onto `fs/promises`; `open` returns the file handle the store expects (it calls `sync`/`close`). `deployment-document.js` wraps `createAuthorizationStore({file, io})` and returns the composed view above; it composes on each `snapshot()` call and never writes the derived subjects back.

- [ ] **Step 4: Wire `app/server.js`**

Replace the `createShadowCandidate` store with `createDeploymentDocument({ file: join(DATA_PATH, "authorization.json"), io: createNodeAuthorizationIo(), seed: () => buildSeedDocument({…}), deriveSubjects })`. `deriveSubjects` reuses the ceiling the current `importLegacyAuthorization` call already produces (keep that call as the ceiling source in this task; Task 2 moves seeding into its own module). Delete the now-unused `createShadowCandidate` import if nothing else uses it. Add `AUTHORIZATION_MODE: ${AUTHORIZATION_MODE:-legacy}` and keep `AUTHZ_ENABLED` in `docker-compose.yaml`, and the same two lines in `.env.example`.

- [ ] **Step 5: Run the test and the runtime tests**

Run: `cd app && DATA_PATH=/tmp/pv-1 node --test --test-concurrency=1 test/authorization-deployment-document.test.js test/authorization-runtime.test.js test/authorization-shadow.test.js`
Expected: PASS. `AUTHORIZATION_MODE` unset still answers `legacy`.

- [ ] **Step 6: Commit**

```bash
git add app/src/authorization/node-io.js app/src/authorization/deployment-document.js app/server.js app/test/authorization-deployment-document.test.js docker-compose.yaml .env.example
git commit -m "feat(authz): give the deployment a durable document with derived subjects"
```

---

### Task 2: One-way seed from the live legacy state

**Files:**
- Create: `app/src/authorization/seed.js`
- Test: `app/test/authorization-seed.test.js`

**Interfaces:**
- Produces: `buildSeedDocument({ providerSnapshot, policyDocument, timeConstraintsEnabled, primaryVaultId, environmentKey })` → a validated document with `revision: 1`. It calls `importLegacyAuthorization` and returns `imported.document`; a HOLD from the importer propagates unchanged.
- Produces: `seedFile({ file, io, build })` → `{seeded: true}` when it wrote, `{seeded: false}` when the file already exists. It never overwrites.

- [ ] **Step 1: Write the failing test**

```js
// 1. no file -> written once, revision 1, constraints from the policy document
// 2. a second call with a different build -> seeded:false, bytes unchanged
// 3. a policy document with an invalid policy -> the HOLD error propagates and no file appears
// 4. the live shape: one enabled suspend policy over ["all"] with a mon-fri weekly window
//    imports to exactly one constraint whose schedule is that window
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-2 node --test --test-concurrency=1 test/authorization-seed.test.js`

- [ ] **Step 3: Implement `seed.js` and call it from `deployment-document`'s `seed` hook in `app/server.js`**

`buildSeedDocument` passes the recorded `timeConstraintsEnabled` (today `AUTHZ_ENABLED=true`). `seedFile` runs before the store loads: it checks `io.readFile`, and on `ENOENT` writes through the same durable path the store uses.

- [ ] **Step 4: Run the test**

Run: `cd app && DATA_PATH=/tmp/pv-2 node --test --test-concurrency=1 test/authorization-seed.test.js test/authorization-deployment-document.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/authorization/seed.js app/test/authorization-seed.test.js app/server.js
git commit -m "feat(authz): seed the document once from the live legacy state"
```

---

### Task 3: Freeze the legacy write routes

**Files:**
- Modify: `app/src/admin/routes/access-policy.js` (the six POST handlers)
- Modify: `app/src/admin/pages/authz.js` (read-only banner + pointer to the new page)
- Modify: `app/src/admin/pages/authz-editor.js` (no form when frozen)
- Modify: `app/src/i18n/admin/zh-CN.policy.js`, `app/src/i18n/admin/en.policy.js` (banner copy)
- Test: `app/test/access-policy-frozen.test.js`

**Interfaces:**
- Produces: `LEGACY_POLICY_FROZEN_CODE = "access_policy_frozen"`, used by the route response body and by the page banner.

- [ ] **Step 1: Write the failing test**

```js
// each of POST {base}/{create,update,toggle,delete,preview,repair} answers 409 with
// {error: "access_policy_frozen"} and writes nothing (the store's replace is never called);
// GET {base} still renders the stored policies, read-only, with the banner text;
// GET {base}?edit=<id> renders no <form> and no submit control.
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-3 node --test --test-concurrency=1 test/access-policy-frozen.test.js`

- [ ] **Step 3: Implement the refusal and the banner**

Each handler returns the 409 before touching the service. The page keeps its table, its window presentation and its now-verdict; it drops every write link and adds the banner pointing at `/admin/auth/authz` (Task 5's page).

- [ ] **Step 4: Run the test and the existing access-policy suites**

Run: `cd app && DATA_PATH=/tmp/pv-3 node --test --test-concurrency=1 test/access-policy-*.test.js test/admin-access-policy-*.test.js`
Expected: PASS, with the previously-write tests updated to expect the refusal (that is the intended change, not a regression).

- [ ] **Step 5: Commit**

```bash
git add app/src/admin/routes/access-policy.js app/src/admin/pages/authz.js app/src/admin/pages/authz-editor.js app/src/i18n/admin/zh-CN.policy.js app/src/i18n/admin/en.policy.js app/test/access-policy-frozen.test.js
git commit -m "feat(authz): freeze the legacy policy writes"
```

---

### Task 4: The constraint admin service (create, update, toggle, delete, plane switch)

**Files:**
- Create: `app/src/authorization/constraint-admin.js`
- Test: `app/test/authorization-constraint-admin.test.js`

**Interfaces:**
- Produces: `createConstraintAdmin({ store, audit, now, newId, vaultIds })` →
  - `list()` → `{revision, timeConstraintsEnabled, constraints}`
  - `create({ expectedRevision, draft })` → `{ok:true, revision, id}` | `{ok:false, code, path}`
  - `update({ expectedRevision, id, draft })` → same shape without `id`
  - `toggle({ expectedRevision, id, enabled })` → same
  - `remove({ expectedRevision, id })` → same
  - `setTemporalPlane({ expectedRevision, enabled })` → same
- `draft` is `{label, subjects, mode, capabilities, surfaces, vaultIds, schedule}`; `vaultIds: null` means every Vault, and the builder writes `selector.anyOf[0].targets = null`.
- Codes: `stale_authorization_revision`, `constraint_not_found`, `unknown_vault`, `limit_exceeded`, `invalid_document` — all taken from the schema/store where they already exist.
- Produces: `constraintFromDraft(draft, { id, now, vaultIds })` (exported for the route tests) → a schema-valid constraint.

- [ ] **Step 1: Write the failing test**

Cover, one assertion each:
1. `create` with `vaultIds: ["a"]` stores `targets: [{kind:"vault",vaultId:"a"}]`, and a decision for Vault `b` does not match it while Vault `a` does.
2. `vaultIds: null` stores `targets: null`.
3. `vaultIds: ["nope"]` → `unknown_vault`, nothing written.
4. two `create` calls with the same `expectedRevision` → the second answers `stale_authorization_revision` and the document holds one constraint.
5. the 513th constraint → `limit_exceeded`.
6. `setTemporalPlane({enabled:false})` leaves ceilings alone and makes every constraint inert.
7. every successful call appends exactly one audit record; a throwing audit still returns `ok:true`.

- [ ] **Step 2: Run it, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-4 node --test --test-concurrency=1 test/authorization-constraint-admin.test.js`

- [ ] **Step 3: Implement `constraint-admin.js`**

Each write: read `store.snapshot()`, refuse when not ready, build the next document (`revision + 1`), and call `store.replace(expectedRevision, next)`. Map the store's codes through unchanged. Audit after a successful replace, inside `try/catch`.

- [ ] **Step 4: Run the test**

Run: `cd app && DATA_PATH=/tmp/pv-4 node --test --test-concurrency=1 test/authorization-constraint-admin.test.js test/authorization-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/authorization/constraint-admin.js app/test/authorization-constraint-admin.test.js
git commit -m "feat(authz): a constraint service with CAS, limits and audit"
```

---

### Task 5: Admin routes for constraints, and the boundary rows

**Files:**
- Create: `app/src/admin/routes/authz.js`
- Modify: `app/src/admin/router.js` (register beside `registerAccessPolicyRoutes`)
- Modify: `app/src/authorization/catalog.js` (boundary rows for `ADMIN GET/POST /authz…`)
- Modify: `app/test/fixtures/permission-architecture/baseline.json` (regenerate with its documented collector)
- Test: `app/test/admin-authz-routes.test.js`

**Interfaces:**
- Produces: `registerAuthorizationRoutes(router, { service, mountPath, requireAdmin, requireCsrf })` with `DEFAULT_BASE = "/admin/auth/authz"`.
- Consumes: Task 4's `createConstraintAdmin` result shape.

- [ ] **Step 1: Write the failing test**

```js
// POST {base}/create                      303 back to {base} on success
// POST {base}/create with a stale revision 409, the draft kept on screen
// POST {base}/create  with vaultIds=["b"] 400 unknown_vault, body names the Vault
// POST {base}/plane   {enabled:"false"}   303; the document's flag is false
// POST {base}/delete                      303; the constraint is gone
// every POST without the CSRF field       403, nothing written
// the catalog's boundary table contains a row for each of the six routes
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-5 node --test --test-concurrency=1 test/admin-authz-routes.test.js`

- [ ] **Step 3: Implement the routes and the boundary rows**

Same decoding, CSRF and `requireAdmin` pattern as `routes/access-policy.js`. Rows go in the catalog table next to the `access-policy/*` rows, all mapping to `admin_authorization_manage`.

- [ ] **Step 4: Regenerate the permission baseline and run the gates**

Run: `cd app && node scripts/<the collector named in the baseline's header> && DATA_PATH=/tmp/pv-5 node --test --test-concurrency=1 test/permission-baseline-parity.test.js test/authorization-catalog.test.js test/admin-authz-routes.test.js && npm run check`
Expected: PASS; the baseline diff contains only the new rows and the commit message says so.

- [ ] **Step 5: Commit**

```bash
git add app/src/admin/routes/authz.js app/src/admin/router.js app/src/authorization/catalog.js app/test/fixtures/permission-architecture/baseline.json app/test/admin-authz-routes.test.js
git commit -m "feat(authz): Admin routes for constraints, mapped to admin_authorization_manage"
```

---

### Task 6: The 「定时授权」 page speaks constraints

**Files:**
- Create: `app/src/admin/pages/authz-constraints.js` (list + drawer, over constraints)
- Create: `app/src/admin/pages/authz-constraints-editor.js` (Vault scope, operations picker, plane switch)
- Modify: `app/src/admin/catalog.js` (assemble the page model from the constraint service)
- Modify: `app/src/i18n/admin/zh-CN.policy.js`, `app/src/i18n/admin/en.policy.js`
- Test: `app/test/admin-authz-constraints-page.test.js`

**Interfaces:**
- Consumes: Task 4's `list()` and Task 5's page model.
- Produces: `renderAuthzPage(model, { base })` unchanged in name; the model gains `constraints`, `revision`, `timeConstraintsEnabled`, `vaults: [{id, name}]`, `operations: [{id, surface, label}]`.

- [ ] **Step 1: Write the failing test**

```js
// 1. a constraint on Vault "a" renders the Vault's id in its scope cell, and "全部 Vault" for targets:null
// 2. the editor has one <select name="vaults" multiple> listing every admitted Vault, no inline handler
// 3. the capability picker offers catalog operation ids and no "tool:"/"scope:" atom for a NEW constraint
// 4. an imported constraint shows its atom as a read-only chip plus the operations it expanded to
// 5. the plane switch renders as a form POST; while false, the page carries the warning banner
// 6. every visible string resolves through t() in both catalogs (the existing i18n gate covers it)
// 7. the page contains no <script> (the existing no-script gate covers it)
// 8. the page states which backend decides (ruling R8): with AUTHORIZATION_MODE=legacy it says the
//    windows are recorded but not deciding; with enforce it says they decide
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-6 node --test --test-concurrency=1 test/admin-authz-constraints-page.test.js`

- [ ] **Step 3: Implement the page and the editor**

Keep the prototype's classes, the weekday grid and the timezone list. Add the multi-select for Vaults, the operation picker grouped by surface, and the plane switch. Every string through `t()`.

- [ ] **Step 4: Run the page tests and the i18n gate**

Run: `cd app && DATA_PATH=/tmp/pv-6 node --test --test-concurrency=1 test/admin-authz-*.test.js test/i18n*.test.js test/admin-layout*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/admin/pages/authz-constraints.js app/src/admin/pages/authz-constraints-editor.js app/src/admin/catalog.js app/src/i18n/admin/zh-CN.policy.js app/src/i18n/admin/en.policy.js app/test/admin-authz-constraints-page.test.js
git commit -m "feat(authz): the Admin page edits constraints with a Vault scope"
```

---

### Task 7: Port the two legacy-reading neighbours

**Files:**
- Modify: `app/src/admin/access-policy.js` (`previewForSubject` → the new decision service)
- Modify: `app/src/admin/subject-authz.js` (bring back 「应用已有规则」 and the new-rule link: Task 3
  removed both and left the stored rules read-only, so this task restores the control against a
  constraint, not a legacy policy)
- Modify: `app/src/admin/routes/authz.js` (the attach endpoint)
- Test: `app/test/admin-authz-preview.test.js`, `app/test/admin-subject-authz-attach.test.js`

**Interfaces:**
- Consumes: the runtime's decision function through the provider (`provider.authorizationSnapshot()` plus the same seam the shadow uses) and Task 4's `update`.
- Produces: `previewForSubject(subject, capabilities)` keeps its name and returns the same keys, with `decision` taken from the new engine and `mode` reporting the constraint's mode.

- [ ] **Step 1: Write the failing tests**

```js
// preview: with one suspend constraint whose window is closed, the preview says denied with
//   outside_authorized_window and names the constraint id; with the window open it says allowed.
// attach: POST {base}/subjects with an existing constraint id adds the subject and changes
//   nothing else; with a stale revision it answers 409 and the constraint is unchanged.
```

- [ ] **Step 2: Run them, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-7 node --test --test-concurrency=1 test/admin-authz-preview.test.js test/admin-subject-authz-attach.test.js`

- [ ] **Step 3: Implement the port**

The preview asks the new engine for the (subject, capability, target) triples the page already lists. The attach endpoint calls Task 4's `update` with the subject appended and everything else copied from the stored constraint.

- [ ] **Step 4: Run them**

Run: `cd app && DATA_PATH=/tmp/pv-7 node --test --test-concurrency=1 test/admin-authz-preview.test.js test/admin-subject-authz-attach.test.js test/admin-access-policy-integration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/admin/access-policy.js app/src/admin/subject-authz.js app/src/admin/routes/authz.js app/test/admin-authz-preview.test.js app/test/admin-subject-authz-attach.test.js
git commit -m "feat(authz): port the preview and the attach action to the new model"
```

---

### Task 8: Health report, docs and the cutover runbook

**Files:**
- Modify: `app/server.js` (`/healthz` gains `authorization: {mode, revision, constraints}`)
- Modify: `docs/AUTHZ_TIME_WINDOWS.md` (new model, per-Vault scope, the frozen legacy page)
- Modify: `docs/RELEASE_AND_DEPLOY.md` (the mode line in compose, the soak, the rollback truth)
- Test: `app/test/healthz-authorization.test.js`

**Interfaces:**
- Produces: `/healthz` → `authorization: {mode: "legacy"|"shadow"|"enforce", revision: <int|null>, constraints: <int>}`, and never a subject, Vault id or window.

- [ ] **Step 1: Write the failing test**

```js
// healthz reports mode "legacy" with no document; after a seeded document, revision and count;
// the payload contains no subject id and no vaultId.
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd app && DATA_PATH=/tmp/pv-8 node --test --test-concurrency=1 test/healthz-authorization.test.js`

- [ ] **Step 3: Implement and write the docs**

The runbook section states the five steps of spec §7, the exact env lines, and the rollback: `AUTHORIZATION_MODE=legacy` plus the recorded tag; `shadow` does not restore old answers.

- [ ] **Step 4: Run the test, the focused suite and the gates**

Run: `cd app && DATA_PATH=/tmp/pv-8 node --test --test-concurrency=1 test/healthz*.test.js test/publish-*.test.js test/web-catalog-*.test.js test/authorization-*.test.js && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server.js docs/AUTHZ_TIME_WINDOWS.md docs/RELEASE_AND_DEPLOY.md app/test/healthz-authorization.test.js
git commit -m "docs(authz): the per-Vault cutover runbook and the health report"
```

---

## Deployment (after all tasks and the whole-branch review)

1. Release `v2026.11.09.x` from the merge commit, deploy with `--rebuild`.
2. Prove: `/healthz` version equals the commit; image `/app/server.js` bytes equal the tag's; `docker exec obsidian-mcp-server getent passwd 1002`; `authorization.mode` and `revision` present; one live read succeeds.
3. The seed runs on this deploy (`legacy` mode, nothing changes for any request). Read `revision` and `constraints: 1` in `/healthz` — that is the migrated Mon–Fri `all` policy.
4. Soak: set `AUTHORIZATION_MODE=shadow`, redeploy, watch `/healthz.authorizationShadow` for differences. A difference is a defect.
5. Enforce: set `AUTHORIZATION_MODE=enforce`, redeploy, verify one denial inside a closed window and one allow outside it. Rollback tag recorded before the deploy.
