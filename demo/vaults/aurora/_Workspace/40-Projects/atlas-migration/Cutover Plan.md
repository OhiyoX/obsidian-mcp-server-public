---
title: Atlas Cutover Plan
alias: Cutover Plan
tags:
  - project
  - migration
  - plan
status: active
priority: medium
updated: 2026-10-22
---

# Atlas Cutover Plan

```mermaid
flowchart LR
  A[Legacy export] --> B[Inventory]
  B --> C[Digest check]
  C --> D[Tag mapping]
  D --> E[Import]
  E --> F{Link audit}
  F -- clean --> G[Freeze]
  F -- gaps --> H[Repair queue]
  H --> E
```

## Sequence

1. Snapshot the legacy export and record the checksum.
2. Run the inventory against the snapshot, not the live folder.
3. Import into a staging vault.
4. Audit unresolved links and orphan notes.
5. Promote only after the audit is clean.

## Exit criteria

- Zero unresolved links introduced by the import
- Every attachment has a resolvable target
- The staging vault passes the same smoke checks as production
- The legacy export is read-only for seven days

Related: [[_Workspace/40-Projects/atlas-migration/README]] · [[_Workspace/30-Knowledge/Engineering/Operator Runbook]]
