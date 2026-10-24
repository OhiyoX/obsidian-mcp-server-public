---
title: Hybrid Search Notes
aliases:
  - Retrieval Model
  - Hybrid Retrieval
tags:
  - research
  - retrieval
status: active
priority: medium
updated: 2026-10-19
---

# Hybrid Search Notes

The retriever answers in two passes: an exact lexical pass first, then a semantic pass only when the exact pass is empty and the query has positive text.

## Scoring sketch

For a query $q$ and a chunk $d$:

$$
S(q,d) = \alpha \cdot \frac{\mathrm{bm25}(q,d)}{\max_{d'} \mathrm{bm25}(q,d')} + (1-\alpha)\cdot \cos(\mathbf{e}_q,\mathbf{e}_d)
$$

with $\alpha = 1$ for the exact pass and $\alpha = 0.35$ for hybrid recall.[^1]

## Why lexical first

- Exact identifiers, paths and tags are common in notes.
- Lexical results are cheap and explainable.
- Semantic recall is a fallback, not a replacement.

## Signals

| Signal | Source | Used for |
| --- | --- | --- |
| Term match | Chunk text | Ranking |
| Title boost | File name | Ranking |
| Tag match | Frontmatter and inline tags | Filtering |
| Link distance | Resolved wikilinks | Related notes |
| Embedding similarity | Companion embedding service | Hybrid fallback |

## Open work

- [ ] Explain negative queries without falling back to silence
- [ ] Tune the chunk overlap for long tables
- [ ] Compare alias expansion against raw title matching

[^1]: Synthetic numbers for the demo; treat them as illustrative, not benchmarks.

Related: [[_Workspace/20-Memory/Decisions/2026-10-20 lexical-first retrieval]]
