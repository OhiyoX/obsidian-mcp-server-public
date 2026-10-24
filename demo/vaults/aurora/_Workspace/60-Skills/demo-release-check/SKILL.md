---
name: demo-release-check
description: Verify a demo release with health, search and link checks before capturing screenshots or publishing.
version: 1.0.0
title: Demo Release Check
triggers:
  - release check
  - demo verification
  - screenshot prep
allowed-tools: Read Grep Bash
trusted: true
risk: low
paths:
  - _Workspace/40-Projects/**
  - _Workspace/30-Knowledge/**
---

# Demo Release Check

Use this skill when preparing a demo build or refreshing the public screenshots.

## Steps

1. Call `healthz` and confirm `ok: true`.
2. Run `search_notes` with a term that must appear in at least one note.
3. Run `graph_health`; confirm unresolved links are the intentional ones.
4. Open one note through the Web workspace and confirm the revision is returned.
5. Capture desktop and mobile screenshots against the synthetic vault only.

## Stop conditions

- Any screenshot shows a real path, hostname or credential.
- The index reports a stale generation after a write.
- A publish link resolves for a note that was never published.

See [[references/checklist]] for the full checklist.
