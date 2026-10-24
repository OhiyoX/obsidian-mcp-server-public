---
title: Snippets
tags:
  - resources
  - code
status: active
priority: low
updated: 2026-10-17
---

# Snippets

Reusable fragments kept close to the notes that use them.

## Read a note with a revision token

```js
const res = await fetch(`${base}/api/web/v1/note?path=${encodeURIComponent(path)}`);
const { content, revision } = await res.json();
```

## Write only if the revision still matches

```js
await fetch(`${base}/api/web/v1/note`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": csrf },
  body: JSON.stringify({ path, content: next, ifMatch: revision })
});
```

## Resolve a wikilink

```js
const { status, target } = await fetch(
  `${base}/api/web/v1/link/resolve?from=${from}&link=${link}`
).then((r) => r.json());
```

## Style rules

- Prefer the smallest block that still runs.
- Never store a credential in a note.
- Link the snippet from the note that explains it: [[_Workspace/30-Knowledge/Engineering/Architecture]].
