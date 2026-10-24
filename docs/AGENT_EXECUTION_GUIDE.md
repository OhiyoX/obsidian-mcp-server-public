# Agent execution guide

The permanent development and test contract is [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md). Apply its complete Reader/Live rendering matrix, exact semantic style rules, fail-closed sampling, real HTTP/CLI/browser integration evidence, bounded subprocesses and single-owner coordination. The current audit evidence, PR snapshots and remaining gaps are in [QUALITY_AUDIT.md](QUALITY_AUDIT.md); they are evidence records, not permission to skip unresolved acceptance items.

This guide is written for implementation agents that need an explicit, low-ambiguity procedure. It does not replace `AGENTS.md`, architecture documents, tests, or task-specific acceptance criteria.

## 1. Truth-source order

Before editing, resolve facts in this order:

1. The user's current task and explicit acceptance criteria.
2. Repository `AGENTS.md`.
3. Current repository source and tests on the branch you are editing.
4. Relevant focused docs under `docs/`.
5. Current Obsidian project notes when available.
6. Historical notes, old TODO text, or remembered state.

Do not treat an old TODO, chat summary, or previous release as proof of current behavior.

Use these status words precisely:

- **planned**: documented intention; no implementation evidence.
- **candidate**: implementation exists on a branch/PR but is not merged.
- **merged**: present on GitHub main; says nothing about production.
- **released**: immutable tag exists with evidence from the selected validation channel.
- **deployed**: NAS deployment completed from that tag.
- **production-verified**: the relevant real endpoint/UI behavior was checked after deployment.

Never upgrade a status without evidence.

## 2. Start-of-task procedure

For every non-trivial change:

1. Read `AGENTS.md`.
2. Read the smallest relevant architecture/operations document.
3. Locate the exact source modules and existing tests.
4. Read the current focused project TODO if the task cites one.
5. State the narrow slice you are implementing in one sentence.
6. List the invariants that must remain true.

Do not begin by refactoring adjacent code.

## 3. Narrow-slice rule

A change should solve one reviewable behavior boundary.

Good slices:

- one missing recovery branch;
- one authorization mismatch;
- one rendering defect with a deterministic fixture;
- one catalog/inventory phase that does not alter execution.

Bad slices:

- "clean up the architecture";
- "improve all mobile UI";
- "rewrite search";
- combining auth, persistence, deployment, and UI changes in one patch.

If the requested behavior exposes a separate bug, record it separately unless it blocks the requested slice.

## 4. Characterize before changing

Before modifying behavior, find or add a test that demonstrates the current boundary.

For bug fixes:

1. create a deterministic failing regression when feasible;
2. make the smallest implementation change;
3. prove the regression passes;
4. run the relevant full suite.

For architecture work, first record the current dependency/call path and preserve observable behavior unless the acceptance criteria explicitly change it.

## 5. Safety invariants

Always preserve these unless the task explicitly changes them:

- Vault path containment and symlink protection;
- OAuth/API-key authorization and Vault allowlists;
- Web, Admin, OAuth, and MCP credential/session separation;
- no credentials or secret values in source, logs, notes, tests, PR text, or fixtures;
- revision checks for mutations;
- mutation journal recovery semantics;
- no production-only crash/fault API added for tests;
- no process-global mutable authorization or per-client tool visibility state;
- no implicit deployment from a Git push or merge;
- generated Web assets are changed only by building frontend source.

A read/discovery feature must not silently become an authorization mechanism.

## 6. Mutation/recovery changes

For mutation-journal, plan/apply, Trash, History, move/delete/restore, or idempotency work, reason explicitly about these boundaries:

1. before any durable destination change;
2. after one or more renames/writes but before committed marker;
3. after committed marker but before cleanup/finalization;
4. after restart recovery;
5. repeated request with the same idempotency key;
6. external writer changes between plan and apply;
7. destination originally absent;
8. destination originally present.

When a destination originally exists, pre-commit recovery must restore its original bytes and revision, not merely restore "a file exists".

Fault injection must be deterministic and test-only/internal. Do not add an MCP schema field, public HTTP endpoint, or production environment switch whose purpose is to crash the server.

## 7. Tool and scope changes

When adding, removing, renaming, or changing an MCP tool:

Check all of the following:

- registration/capability list;
- input schema;
- output schema / structured-content contract;
- Scope mapping;
- annotations such as read-only/destructive/idempotent/open-world;
- author/memory guidance if the tool mutates;
- compatibility adapters;
- tests for discovery and real `tools/call`.

For Progressive Tool Discovery, visibility is not authorization. Every real call still performs normal Scope/Vault/path checks.

## 8. Web/frontend changes

Edit `app/frontend/`, not generated bundles directly.

For frontend changes, update source, run affected behavior tests, build with `npm run build:web`, and verify generated assets are in sync. Select syntax, integration, real-browser and parity checks by the changed boundary under section 9. Run a full suite when the integration risk requires it, rather than repeating it at every stage.

For permissions, routing, Publish, login restore, or metadata-leak fixes, include negative tests. A successful authorized path does not prove an unauthorized path fails closed.

## 9. Required local verification

Select checks by changed behavior and risk; see DEVELOPMENT_STANDARDS.md. Run focused checks during development, necessary integration checks on the final tree once, and reuse the original evidence for review/publication/apply. Record commit/tree, environment, commands, counts and artifacts. Build generated assets when their source changes, reinstall when dependencies/runtime change. Empty/all-skipped/timeout results are not passes; report platform gaps.

For authorized deployment, passing tests in the local or user-designated environment allow direct deployment using the local-fast channel. Keep repository CI for external/non-local changes and candidates without trusted environment evidence. Actual CI status is separate from local/environment verification.

## 10. Git and release boundaries

Use a dedicated worktree when concurrent writers are plausible. Check content/integration changes after rebase; reuse unaffected evidence instead of automatically restarting every suite.

Authorization may cover a candidate or batch with a binding rule, action scope and target environment. Already-covered stages do not require separate confirmations. A branch/PR or green CI does not authorize an action by itself.

Lifecycle: candidate → authorized merge → immutable tag → selected validation evidence → NAS preview/drift → apply → live smoke/production verification. local-fast consumes matching environment evidence without waiting for repository CI. The default CI channel remains available. Follow RELEASE_AND_DEPLOY.md; never pull Git in the dirty NAS runtime checkout.

## 11. Documentation rule

Update documentation when the change alters a durable fact, architecture boundary, operator action, or acceptance status.

Keep distinctions explicit:

- what was already true;
- what this branch changes;
- what tests prove locally;
- what still requires merge/deploy/production verification.

Do not mark a TODO done merely because code exists. Close it only when every stated acceptance item has evidence.

## 12. Handoff format

End an implementation handoff with this compact structure:

```text
Slice:
- <exact behavior implemented>

Changed:
- <files/modules and behavior>

Evidence:
- <focused tests>
- npm run check: <result>
- npm test: <passed/failed/skipped>
- npm run build:web: <result or not applicable>

Status:
- candidate | merged | released | deployed | production-verified

Not proven:
- <remaining branch, environment, production, or manual checks>

Next action:
- <single concrete next step>
```

For a PR, include the PR URL and exact head commit SHA.

## 13. Stop conditions

Stop and report instead of guessing when:

- the task would require a secret you do not have;
- current source contradicts the requested assumption;
- a migration would destroy or overwrite user Vault/data without an approved recovery path;
- the NAS has unexpected drift;
- a recovery journal is unresolved;
- the requested acceptance criterion cannot be reproduced deterministically.

When blocked, provide the evidence and the smallest next action. Do not broaden the patch to work around an unknown state.

## 14. Project-specific current cautions

At the time this guide was introduced:

- GitHub source and NAS deployment are separate states;
- the production tool catalog is large and Progressive Tool Discovery is still a design/evaluation track, not an implemented server-side dynamic tool view;
- OAuth and API Key already share the same authorization model; future Scope v2 work changes capability granularity, not that unification;
- Publish core functionality exists, while some authenticated Web/Admin acceptance items may still be tracked separately;
- mutation/recovery work requires branch-complete crash-boundary evidence before it is considered closed.

Treat this section as contextual guidance only. Re-check current source, project notes, and release evidence before relying on it.
