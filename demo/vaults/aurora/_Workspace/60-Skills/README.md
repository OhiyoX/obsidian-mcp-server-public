---
title: Skills Index
aliases:
  - 60-Skills
tags:
  - skill
  - index
status: active
updated: 2026-10-25
---

# Skills

Portable agent skills. Each skill is a directory with a `SKILL.md` and optional `references/`, `assets/`, `scripts/` and `agents/` folders.

## Installed

| Skill | Purpose | Trusted |
| --- | --- | --- |
| [[_Workspace/60-Skills/demo-release-check/SKILL\|demo-release-check]] | Verify a demo release before screenshots or publishing | yes |

## Rules

- `name` must be lowercase letters, digits and hyphens.
- Matching a skill never executes it; a human or agent must apply it explicitly.
- Keep scripts small and reviewable. Do not store credentials in a skill.
