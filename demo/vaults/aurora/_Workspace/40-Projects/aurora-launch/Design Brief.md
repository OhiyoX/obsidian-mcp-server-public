---
title: Aurora Design Brief
aliases:
  - Brief
alias: Design Brief
tags:
  - project
  - design
status: active
priority: medium
updated: 2026-10-23
---

# Aurora Design Brief

![[aurora-mark.svg|220]]

## Intent

A calm, keyboard-first workspace for people who write notes faster than they organise them. The interface should feel like a reading room, not a dashboard.

## Principles

1. **One obvious action per surface.** Editing, reading and publishing never compete for the same control.
2. **State is visible.** Every payload carries its vault, path, revision and author.
3. **Recoverable by default.** Versions and trash are first-class, not an undo stack that disappears.

## Layout notes

> [!note] Reading width
> Body text is capped near 72 characters. Tables and Bases may break out of the measure when they need the width.

- Explorer stays collapsed on narrow screens.
- The search panel remembers its scope across navigation.
- Publish links are per document and can be revoked without deleting the note.

## Open questions

- Should the graph expose tag colours by default?
- Do we surface the revision token in the editor chrome?
- How much of the Bases formula subset belongs in the first-run tour?

## Assets

- Mark: [[aurora-mark.svg]]
- Reference board: [[Canvas/System Map.canvas]]
