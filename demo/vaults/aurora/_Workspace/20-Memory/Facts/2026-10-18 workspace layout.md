---
id: memory-demo-layout
type: memory
memory_kind: fact
title: Workspace layout
description: The demo vault mirrors a _Workspace layout so memory, projects and skills are discoverable.
status: active
confidence: 1
entities:
  - workspace
projects:
  - aurora-launch
tags:
  - memory
  - conventions
created: 2026-10-18
updated: 2026-10-25
---

# Workspace layout

The vault root holds free-form folders (Assets, Canvas, Templates, Views) and a `_Workspace` tree:

- `_Workspace/20-Memory` for durable memory
- `_Workspace/40-Projects` for project state
- `_Workspace/60-Skills` for portable skills

The server is started with `VAULT_WORKSPACE_ROOT=_Workspace`, so the managed memory and skill tools resolve to these paths.

Related: [[_Workspace/00-System/Agent/AI 笔记规范]] · [[_Workspace/60-Skills/README]]
