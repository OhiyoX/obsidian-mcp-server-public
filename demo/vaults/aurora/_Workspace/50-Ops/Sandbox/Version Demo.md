---
title: Version Demo
tags:
  - sandbox
  - demo
status: active
priority: low
updated: 2026-10-25
---

# Version Demo

Draft two: add the rollback note and keep the previous revision recoverable.

## What this note demonstrates

- Every write returns a `revision`.
- The previous content is stored before an overwrite.
- `list_versions` and `restore_version` work from the runtime data directory, not from Git.

Related: [[_Workspace/30-Knowledge/Engineering/Operator Runbook]] · [[_Workspace/50-Ops/README]]
