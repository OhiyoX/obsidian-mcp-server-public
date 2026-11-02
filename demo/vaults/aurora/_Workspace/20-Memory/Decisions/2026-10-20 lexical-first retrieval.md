---
id: memory-demo-lexical-first
type: memory
memory_kind: decision
title: Lexical-first retrieval
description: Exact lexical search runs first; semantic recall only when the exact pass is empty.
status: active
confidence: 0.9
entities:
  - hybrid search
projects:
  - aurora-launch
tags:
  - memory
  - retrieval
created: 2026-10-20
updated: 2026-10-25
---

# Lexical-first retrieval

## Decision

Search answers with an exact lexical pass first. Semantic recall runs only when the exact pass matches nothing and the query has positive text.

## Why

- Identifiers, paths and tags are common in notes and need exact matches.
- Lexical results are cheap and explainable.
- Semantic recall is a fallback, not a replacement.

## Consequence

The UI must label which pass produced a result. A semantic fallback must never be presented as an exact match.

Related: [[_Workspace/30-Knowledge/Research/Hybrid Search]] · [[_Workspace/40-Projects/aurora-launch/README]]
