---
title: Aurora Release Checklist
alias: Release Checklist
tags:
  - project
  - release
  - checklist
status: active
priority: high
updated: 2026-10-24
---

# Aurora Release Checklist

## Before the release

- [x] Datasets regenerated from the synthetic source
- [x] Screenshots captured at desktop and mobile widths
- [ ] Revision conflicts exercised against a stale editor tab
- [ ] Trash restore verified for a deleted note
- [ ] Publish link revoked and confirmed dead
- [ ] Rollback rehearsed on a clean container

## Smoke commands

```sh
curl -fsS http://127.0.0.1:18924/healthz
curl -fsS -H "X-API-Key: $DEMO_KEY" http://127.0.0.1:18924/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Rollback

1. Stop the container.
2. Restore the previous image tag.
3. Re-run the health check and a single read tool.
4. Confirm that the vault mount still resolves to the expected root.

> [!warning] Never reuse a tag
> Rebuilding an existing tag makes the rollback target ambiguous. Cut a new tag instead.

#release
