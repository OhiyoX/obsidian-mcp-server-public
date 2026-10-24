---
title: Operator Runbook
tags:
  - engineering
  - operations
status: active
priority: high
updated: 2026-10-24
---

# Operator Runbook

## Daily checks

- [ ] Health endpoint returns `ok`
- [ ] Index freshness is `clean`
- [ ] No pending mutation batches older than one hour
- [ ] Backup window completed

## Common actions

```sh
# health
curl -fsS http://127.0.0.1:18924/healthz

# recent notes
curl -fsS -H "X-API-Key: $DEMO_KEY" \
  "http://127.0.0.1:18924/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"release","limit":5}}}'
```

## Incident ladder

1. **Read-only mode** — stop writes before investigating.
2. **Snapshot** — copy the data directory before any repair.
3. **Replay** — use the journal, never hand-edit a half-written file.
4. **Verify** — run a read, a search and a link resolve before reopening writes.

> [!danger] Do not delete the journal
> It is the only record of an in-flight multi-note plan. Archive it instead.

Related: [[_Workspace/30-Knowledge/Engineering/Architecture]] · [[_Workspace/40-Projects/aurora-launch/Release Checklist]]
