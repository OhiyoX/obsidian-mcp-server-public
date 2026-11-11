# Per-Vault Time Windows, on the New Model Only

Status: design for approval. Owner decision that shapes everything here: **the legacy
`access-policy` document stops being the place where time windows are edited or decided.**

## 1. Intent

Today 「定时授权」 (Admin → 定时授权) lets one subject hold one time window, and that
window hits **every Vault at once**. The owner wants one subject to hold **different
windows on different Vaults**: Vault A on workdays 09:00–18:00, Vault B on weekends,
a third Vault with no window at all.

Why now: the P4 model already carries the exact vocabulary needed
(`constraint.selector.anyOf[].targets` can name one Vault) but nothing writes it, and
the deployment still answers from the old backend. Building the feature on the old
document would mean building it twice — the owner ruled that out.

## 2. What the code does today

**Provenance note.** The first draft of this section was read from the checkout at
`projects/obsidian-mcp-server/repo`, which sits on the stale branch `fix/admin-runtime-shipped`
(20 commits behind `main`). Every fact below was re-read from `main`. The correction that
matters: `runtime.js` answers from the legacy backend in **both** `legacy` and `shadow`
(`if (mode !== "enforce")`, commit `c79e741a`), so `shadow` observes and does not enforce. A
review of the first draft claimed the opposite from that stale tree; the claim is void.

Facts, each with its evidence, all read at `main` `fdcb3a8e`:

| Fact | Evidence |
| --- | --- |
| A grant is already per Vault: `grants[].target = {kind:"vault",vaultId}` | `app/src/authorization/schema.js:59` |
| A new-model constraint can name Vaults: `selector.anyOf[].targets` | `app/src/authorization/schema.js:88`, `evaluate.js:88` |
| A constraint carries the window: `schedule {timezone, weekly, dateRanges, startsAt, expiresAt}` | `schema.js:66`, `schema.js:297` |
| Constraints only subtract, and several constraints intersect | `evaluate.js:247` (`suspend`), `evaluate.js:366` (`revoke`), `docs/AUTHZ_TIME_WINDOWS.md` §1 |
| The legacy policy key set has **no** Vault field | `app/src/access-policy/schema.js:35` |
| The whole 「定时授权」 surface reads and writes the legacy document | `app/src/admin/pages/authz.js:1`, `pages/authz-editor.js`, `access-policy-window-presentation.js`, `subject-authz.js` |
| The new model has no Admin writer: the Admin only reads `provider.authorizationSnapshot()` | `app/src/admin/catalog.js:131`; no `constraints` reference under `app/src/admin/**` |
| The deployed document is a **process-memory shadow** rebuilt from legacy state | `app/server.js:145` region (`createShadowCandidate({ build: () => importLegacyAuthorization(…) })`) |
| No durable document is written at all today | `app/src/authorization/store.js` is imported by nothing in `app/server.js` |
| `AUTHORIZATION_MODE` is read and defaulted to `legacy` | `app/server.js:118` |
| Importers exist: policies → constraints, whole state → document | `legacy-policy-import.js:142`, `legacy-import.js:295` |
| Admin write routes already map to `admin_authorization_manage` | `app/src/authorization/catalog.js:249-253` |

Consequence: **"flip a flag" is not the cutover.** The deployment has no durable document,
so an Admin edit would be erased by the next rebuild. The cutover is: give the runtime a
durable document, seed it once from the live legacy state, and only then let `enforce`
answer.

## 3. Goals

1. One subject can hold windows on different Vaults, edited in Admin, no script involved.
2. A window may name one Vault, several Vaults, or none (= every Vault, today's meaning).
3. The new model answers every decision (`AUTHORIZATION_MODE=enforce`).
4. The existing policies survive the move with identical behaviour.
5. The legacy editor stops being writable once the new one is live.
6. Every gate the repo already has (architecture, permission baseline, i18n, no-script CSP)
   stays green, and no gate is relaxed to make room.

## 4. Non-goals

- Windows per capability inside one Vault. Capabilities keep their current shape; a window
  stays "these capabilities, these Vaults, this time".
- A union of overlapping windows. Intersection stays (see §6.4).
- Time windows on the Admin console itself: an `admin-session` actor carries no subject
  (`adapters/admin.js:7`), so no account window can lock the console out, in either model.
- Any change to `access-policy` semantics. It becomes read-only history, not a second source.
- Per-note or per-folder windows.

Anti-goals (a failure even if it works):

- A response that differs between `shadow` and `enforce` for the same request.
- A cutover that needs a second import run, or that silently drops a dormant policy.
- An Admin edit that a later rebuild overwrites.

## 5. Approaches considered

**A. Port the editor only; cut over in a later window.** Lowest risk, one task. Rejected by
the owner: the feature would be invisible until the separately-scheduled flip.

**B. Editor + import + cutover in one branch, delivered as one release.** Chosen. The owner
asked for one thorough pass. The internally irreversible step (`enforce`) still sits last in
the same branch, with a recorded rollback tag.

**C. Data layer only, configured by script.** Smallest. Rejected: the owner wants to click it.

## 6. The model

### 6.1 A per-Vault window is one constraint

No new document shape. A window on Vault `work` is a constraint whose one `anyOf` branch
carries `targets: [{kind:"vault", vaultId:"work"}]` and whose `schedule` is the window.
Several Vaults with the **same** window share one constraint with several targets; Vaults
with different windows get different constraints. `targets: null` keeps today's meaning
(every Vault).

### 6.2 One subject, many constraints, still one ceiling

The ceiling (`subjects[id].grants`) does not change: a window never grants. It only removes
what the ceiling already allows, inside the Vaults it names.

### 6.3 The Admin page becomes a constraint editor

「定时授权」 keeps its URL, its list, and its no-script rules (CSP `default-src 'none'`).
What changes:

- The list is the **constraints** of the live document, not the legacy policies.
- Each row shows: subjects, Vault scope (「全部 Vault」 or the names/ids), capabilities,
  mode, window summary, and the honest now-verdict the page already computes.
- The editor gains one new control, the **Vault scope**: 全部 Vault / one / several. The
  rest of the form (weekday grid, date ranges, timezone, startsAt/expiresAt, capabilities,
  mode, enabled) keeps its current shape and labels.
- The subject drawer section (`subject-authz.js`) lists that subject's constraints across
  Vaults — the place where "different Vaults, different windows" is finally legible.
- Every new string goes through `t()` with `zh-CN` and `en` entries.
- **The capability picker speaks operations, not legacy atoms.** A constraint stores catalog
  operation ids plus surfaces and cannot store `tool:write_note`. The picker offers the
  catalog's operations grouped by surface. An imported constraint shows the operations it
  imported to, plus a read-only chip naming the atom it came from (`scope:…`, `toolset:…`),
  because one atom can expand to many operations across two surfaces and cannot be collapsed
  back.

### 6.4 Overlap

Two windows on the same (subject, Vault) intersect, exactly as today: the narrower one wins
and both are reported in the refusal (`matched` constraint ids). The page says so, because a
user who adds a second window expects either OR or a hard intersection, and silence here
would be a support ticket.

### 6.5 Writes

Writes go through the durable store's CAS: read `expectedRevision`, build the candidate
document, write. A stale revision is reported as a retry, never merged silently. The editor
therefore renders the revision it read.

### 6.6 Two neighbours must be ported, not hidden

Both are visible owner-facing behaviour and both read or write the legacy document:

- **当前状态预览** (`admin/access-policy.js` `previewForSubject`, which asks the legacy
  `runtime.explain`). It is ported onto the new decision service, so the preview and the real
  verdict cannot disagree after the freeze.
- **The subject drawer's 「应用已有规则」** (a POST that adds a subject to a legacy policy). It
  becomes "apply an existing constraint to this subject" on the new store, same words, same
  guard: it may add a restriction and never remove one.

### 6.7 The master switch

`timeConstraintsEnabled` is a document field (§2). Leaving it to an env value would make every
window the new editor creates inert, and §7.5 removes the only screen that could explain why.
The 「定时授权」 page therefore carries the switch, with an audit record and a banner while it is
off. `AUTHZ_ENABLED` seeds it on the first boot only; today that value is `true` on the NAS.

### 6.8 Who owns which half of the document

The document has four parts, and they do not have the same author:

| Part | Owner | Why |
| --- | --- | --- |
| `constraints` | the durable file, edited in Admin | this is the feature |
| `timeConstraintsEnabled` | the durable file, via the master switch (§6.7) | otherwise no screen can say why a window is inert |
| `subjects` (ceilings, `credentialEpoch`) | derived from live credential state on every change, as today | eight Admin credential routes already move ceilings; making all of them write this file is a second feature |
| `schemaVersion` / `catalogVersion` / `revision` | the store | CAS and the schema's own rules |

The store keeps a file. The runtime composes the decision document as
`{...stored, subjects: derived}`. A new API key or OAuth account therefore works the moment it
exists, exactly as today, and no credential route learns to write this file. The seed still
writes a complete document once, so the file is readable on its own and a first boot has
everything.

### 6.9 Audit

Every accepted constraint write appends one audit record: who, what (created/updated/toggled/
deleted), the constraint id, and before/after of the window **only** — never subjects'
credential material.

## 7. Persistence and cutover

Two live facts from the NAS, read for this design: `AUTHZ_ENABLED=true`, and
`data/access-policy.json` holds **one** enabled `suspend` policy over `all` capabilities with a
Monday–Friday weekly window (revision 28). So there is exactly one window to migrate, and it is
the principal-wide kind this feature generalises. `AUTHORIZATION_MODE` appears nowhere in the
deployed `docker-compose.yaml`, so a mode change or a rollback cannot reach the container until
that line exists.

Ordered steps, each observable:

0. **The mode becomes reachable.** `AUTHORIZATION_MODE` is forwarded by the compose file and
   documented in `.env.example`, defaulted to `legacy`. Without this, steps 3 and 4 are wishes.
1. **Durable document.** The runtime reads the real store (`src/authorization/store.js`) with a
   file under the data directory, instead of the in-memory shadow candidate (`server.js`). The
   decision document is `{...stored, subjects: derived}` (§6.8). In `legacy` and `shadow` no
   response changes.
2. **One-way seed, and the legacy writes stop in the same deploy.** With no file, the first
   boot imports the live state once and writes it. The same deploy freezes the legacy write
   routes. Freezing later would leave a gap in which a legacy edit silently never applies — the
   anti-goal in §4 — and a re-seed is not allowed, because it would overwrite Admin edits.
   A validation HOLD stops the boot (§11 C5).
3. **Shadow soak.** `AUTHORIZATION_MODE=shadow`. `shadow` answers from the legacy backend and
   records the new verdict beside it (`c79e741a`), so a difference is visible in
   `/healthz.authorizationShadow` without changing any response. A difference is a defect, not
   a threshold. Proof to keep: the counters and one read pair.
4. **Enforce.** `AUTHORIZATION_MODE=enforce` in the maintenance window, with the rollback tag
   recorded before the deploy. Proof: `/healthz` reports the mode and the document revision; one
   live MCP call and one live Web read answer; a subject outside its window gets
   `outside_authorized_window`; the same subject inside it succeeds; the migrated policy still
   bites.
5. **The legacy page is history.** The legacy document, its file and its routes stay on disk,
   read-only. Nothing is deleted (§11 C2).

Rollback: `AUTHORIZATION_MODE=legacy`, redeploy the recorded tag. `legacy` is the only mode
that restores the old answers; `shadow` answers from the legacy backend but still records.
The document file is inert in `legacy` and read-only there. Rollback does **not** restore the
legacy write routes: they were frozen in step 2, and unfreezing them is a code revert, which is
the honest cost of closing the gap.

### 7.1 What this release does not include

`docs/superpowers/plans/2026-11-05-permission-architecture.md` P4 also lists credential
envelopes, an `authorizationSchemaVersion` marker, `web/sessions.json` v2, and a grants editor.
This release delivers **none** of them, on purpose:

- the marker's own rule is "after the marker, no legacy rollback", and this release keeps a
  rollback;
- envelopes and sessions v2 are credential-storage work that no window needs;
- ceilings stay derived (§6.8), so a grants editor has nothing to own yet.

Those remain P4 tasks. This release is the document, the editor, the freeze and the mode.

## 8. Boundaries and gates

- New Admin routes (list/editor writes) are `ADMIN` surface operations and map to the
  existing `admin_authorization_manage` capability. New rows go in the catalog boundary
  table next to the `access-policy/*` rows.
- The permission baseline fixture is regenerated by its documented collector, not edited by
  hand; any diff is explained in the commit message.
- `AUTHZ_ENABLED` stays the recorded legacy switch; it must not be able to bypass ceilings
  or enabled constraints in the new model.

## 9. Limits

`AUTHORIZATION_LIMITS` already caps what this can grow into: 512 constraints per document,
32 subjects per constraint, 64 selector branches per constraint, 64 weekly intervals, 64 date
ranges, 65 targets per subject. A subject with windows on 20 Vaults costs 20 constraints out
of 512 — comfortable, and the editor refuses past the cap with a specific message rather than
a stack trace.

## 10. What is left to the builder

- Whether the editor writes one constraint per Vault or groups equal windows; §6.1 permits
  both. Grouping equal windows is preferred (fewer constraints) if it does not complicate
  the edit form.
- How the subject drawer orders constraints across Vaults (by Vault, then by window start).
- The exact soak length in step 3, from the owner's maintenance window.
- Whether the frozen legacy routes answer 409 or 410; either is honest, one must be chosen
  and tested.

## 11. Calls I made (for the owner to check)

- **C1**: the document becomes durable *before* any editor ships, because the deployed runtime
  rebuilds its document from legacy state and would erase an edit.
- **C2**: the legacy document is never migrated in place and never deleted.
- **C3**: intersection over union, because 定时授权 has never granted anything.
- **C4**: no new capability id; `admin_authorization_manage` already means this.
- **C5**: a validation HOLD at boot fails the boot instead of serving a partial document.
- **C6**: `subjects` stay derived from live credentials (§6.8). The file owns what a person
  edits; the code owns what a credential implies.
- **C7**: the legacy write routes freeze in the **same deploy** as the seed (§7 step 2), not at
  the end. The cost: unfreezing needs a code revert.
- **C8**: `timeConstraintsEnabled` becomes a document field with a master switch on the page
  (§6.7). Without it the new editor writes windows that can never apply.
- **C9**: the capability picker offers catalog operations, and imported atoms appear as a
  read-only chip (§6.3). Editing an imported constraint edits operations, not atoms.
- **C10**: this release stops at the document, the editor, the freeze and the mode. Envelopes,
  the schema marker, sessions v2 and the grants editor stay P4 tasks (§7.1).
- **C11**: the two legacy-reading neighbours are ported, not hidden (§6.6).

## 12. Provenance

First draft read from a stale checkout; corrected. The review that surfaced the gaps is worth
recording as process: a design that cites line numbers must say which tree it read, because
this repository has several.
