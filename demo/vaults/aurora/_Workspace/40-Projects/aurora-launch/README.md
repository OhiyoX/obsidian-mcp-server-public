---
title: Aurora Launch
aliases:
  - Aurora
  - Launch Program
alias: Aurora Launch
tags:
  - project
  - release
status: active
priority: high
owner: alex
updated: 2026-10-24
created: 2026-09-18
---

# Aurora Launch

> [!abstract] Goal
> Ship the Aurora workspace release with a verified demo vault, a public walkthrough, and a rollback path that a single operator can follow.

## Scope

| Workstream | Owner | State |
| --- | --- | --- |
| Dataset | alex | done |
| Workspace UI | sam | in review |
| Retrieval | jordan | in progress |
| Release notes | casey | not started |

## Milestones

- [x] Freeze the synthetic dataset
- [x] Record the baseline screenshots
- [ ] Verify the [[_Workspace/40-Projects/aurora-launch/Release Checklist|release checklist]]
- [ ] Publish the [[_Workspace/40-Projects/aurora-launch/Design Brief|design brief]]
- [ ] Announce in the team channel

## Decisions

- The demo vault never contains production notes. See [[_Workspace/30-Knowledge/Engineering/Architecture#Content boundary]].
- Every write path must return a revision token; stale writes are rejected instead of merged silently.
- Retrieval defaults to lexical-first and only escalates to semantic when the exact pass is empty. Recorded in [[_Workspace/20-Memory/Decisions/2026-10-20 lexical-first retrieval]].

## Related

- [[_Workspace/30-Knowledge/Engineering/Operator Runbook]]
- [[_Workspace/50-Ops/Meeting Notes/2026-10-20 Kickoff]]
- [[Views/Project Board.base]]

#project #release
