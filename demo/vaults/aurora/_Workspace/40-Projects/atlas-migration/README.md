---
title: Atlas Migration
aliases:
  - Atlas
alias: Atlas Migration
tags:
  - project
  - migration
status: active
priority: medium
owner: jordan
updated: 2026-10-22
created: 2026-10-02
---

# Atlas Migration

Move the archived Atlas collection into the current schema without rewriting history.

## Why

The old export still uses flat tags and has no stable identifiers. That makes link repair manual and blocks the multi-vault demo.

## Approach

1. Inventory every archive entry and record its digest.
2. Map legacy tags to the current vocabulary.
3. Re-run the link resolver and keep unresolved links visible.
4. Freeze the result and stop importing from the legacy export.

## Risks

| Risk | Mitigation |
| --- | --- |
| Duplicate titles | Compare path plus digest before import |
| Broken embeds | Copy attachments first, then rewrite embeds |
| Silent data loss | Keep the source archive immutable until sign-off |

See [[_Workspace/40-Projects/atlas-migration/Cutover Plan]] for the execution order.

#migration
