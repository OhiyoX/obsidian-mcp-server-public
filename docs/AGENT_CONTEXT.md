# Agent note context API

`get_note_context` (Phase 1 of the Context API) returns one bounded,
provenance-tagged context bundle for a single, exact vault-relative note path.
`src/context-service.js` owns the protocol-neutral contract; `src/tools/context.js`
is a thin MCP adapter. Phases 2 (`get_project_context`) and 3
(`get_workspace_instructions`) are not implemented and no project/workspace
discovery arguments exist.

The tool is advertised as `readOnlyHint: true` and `openWorldHint: true`:
Vault access is read-only, but related retrieval with the default
`semantic: true` may call the configured embedding provider, so the tool's
worst case is open-world even though `includeRelated` defaults to `false`.

## Inputs

| Field | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `path` | required | non-empty | Exact vault-relative note path. No fuzzy matching, globbing, project or workspace discovery. |
| `maxChars` | `12000` | `1..32000` | Unicode-codepoint budget for Vault-derived text. |
| `maxItems` | `20` | `1..64` | Maximum context items. The target is `items[0]`; backlinks and related notes fill the remainder. |
| `includeBacklinks` | `true` | boolean | Include bounded backlinks from the existing link index. |
| `includeRelated` | `false` | boolean | Include bounded related notes using the existing retrieval ranking. |
| `semantic` | `true` | boolean | Prefer semantic related notes; only affects related retrieval. |

There is intentionally no `query`, `project`, `workspace`, `depth` or
`recursive` argument. Use `get_note` when the full note body is required.

## Output

```jsonc
{
  "status": "ok | partial | not_found",
  "path": "Notes/Target.md",
  "resolvedPath": "Notes/Target.md",
  "revision": "sha256:…",
  "items": [ /* target metadata/document map first, then backlink/related items */ ],
  "sources": [ /* provenance only, one entry per emitted item */ ],
  "warnings": [ { "code": "…", "message": "…" } ],
  "truncated": false,
  "budget": { "maxChars": 12000, "usedChars": 0, "maxItems": 20, "usedItems": 0, "counting": "vault-text-codepoints" },
  "index": { "available": true, "notes": 0, "chunks": 0, "embeddedChunks": 0, "embeddingModel": null, "semanticEnabled": false, "semanticRequested": true, "semanticUsed": false, "lexicalFallback": true, "semanticError": null },
  "policy": { "source": "server", "version": "1.0.0" }
}
```

- `status` is `not_found` for a missing note (empty result, no fuzzy guess),
  `partial` when any warning or truncation applies, otherwise `ok`.
- `items` is `[target, ...]`: `items[0]` is the target note with
  `kind: "target"` and `reason: "target"`, followed by bounded `backlink` and
  `related` items. `budget.usedItems === items.length`; `maxItems=1` returns
  only the target item.
- `sources` carries provenance only — one entry per emitted item
  (`id`, `kind`, `path`, `revision`, `revisionSource`, `trust`, `reason`,
  `score`). It never duplicates the item metadata or excerpt text. Every
  Vault-derived entry carries `path` and `trust: "untrusted_reference"`.
  `revision` is `sha256:…` when known; each entry declares `revisionSource`
  (`bounded_note_read` for the fully read target, `vault_index_snapshot` for
  backlinks/related, otherwise `null`).
- `index` is a bounded retrieval-status summary when related notes were
  requested, otherwise `null`. `available` is `false` when the retrieval state
  has not been committed in memory (a cold context read never loads it); the
  numeric counts and `semanticEnabled` are then `null`. It reports
  `semanticRequested`, `semanticUsed`, `lexicalFallback` and a bounded
  `semanticError` from the actual related attempts.
- `policy` is server control metadata (`source: "server"`). It is separate from
  Vault text and cannot be overridden by note content.

## Trust and injection model

Vault text is always reference data. Item excerpts and metadata are tagged
`trust: "untrusted_reference"`; the bundle never emits an `instructions` field
and never promotes note text into server policy. A note that contains
prompt-injection text is returned only as a bounded excerpt with the same
untrusted tag.

## Budget and bounds

- `maxChars` counts Unicode codepoints of every Vault-derived textual value:
  excerpts plus bounded metadata strings (title, type, tags, headings,
  frontmatter field names). Paths, revisions, structural flags, warning codes
  and server policy are excluded.
- `maxItems` counts the target as `items[0]` first, then backlinks plus related
  notes. `budget.usedItems === items.length` for a found note (and `0` for
  `not_found`). `maxItems=1` therefore returns only the target item.
- The target is read through an open file handle with a hard byte ceiling of
  `min(128 KiB, MAX_READ_BYTES)`. The reader stops after `ceiling + 1` bytes, so
  a file that grows between the stat and the read cannot bypass the ceiling. It
  fstats the handle before and after the read; if the file mutated during the
  read the result is `partial` with `target_changed_during_read`, `revision` is
  `null` (no complete-content revision is claimed), and metadata comes from the
  handle snapshot rather than the earlier path stat. A stable note that fits is
  hashed from exactly the bytes read (an exact revision); a note larger than the
  ceiling is `partial` with `target_note_too_large`, bounded metadata only,
  `revision: null`, warning `revision_unavailable`, and no exact revision is
  claimed.
- Backlinks are queried from the existing Vault link index with bounded output
  and iteration; the unbounded `get_backlinks` tool is not called. Ambiguous
  links whose candidate set contains the target are omitted with a bounded
  `ambiguous_link_omitted` warning — including when the resolver's provisional
  best match is a different note.
- Related notes reuse the existing `find_related` ranking through a
  snapshot-only recall: the context path never schedules a retrieval refresh and
  never cold-loads the retrieval JSON. If semantic retrieval is unavailable or
  throws, the same query is retried deterministically with lexical ranking and
  the bundle reports `semantic_degraded_to_lexical`. `lexicalFallback` is `true`
  only when semantic ranking was requested and the lexical retry produced a
  result; an explicit `semantic: false` request is a plain lexical lookup and
  reports `semanticRequested: false` / `lexicalFallback: false`. If both attempts
  fail, the note and backlinks are still returned with warning
  `related_unavailable` and `lexicalFallback: false`.

## Index and revision provenance

`get_note_context` never triggers a cold, vault-wide index build. It reads a
read-only snapshot of the last successfully built Vault link index
(`getCachedVaultIndex`). When no snapshot exists yet, the result is `partial`
with warning `index_unavailable` and no backlinks/related notes are emitted; the
bounded target metadata is still returned. Building the index is the job of the
retrieval/index flow, not of a context read.

Related retrieval uses the same rule: only the in-memory committed retrieval
state is consulted (`recallFromSnapshot` / `retrievalIndexStatusSnapshot`). A
context read never calls `requestRetrievalRefresh`, never schedules a background
index job, and never cold-loads the retrieval JSON from disk. When that state is
not committed yet, `index.available` is `false`, related notes are omitted, and
a bounded `related_unavailable` warning is emitted.

Backlink and related revisions are snapshot revisions; each item/source records
`revisionSource: "vault_index_snapshot"`. If a result references a path that is
not present in the snapshot, its `revision` is `null` and a bounded
`source_revision_unavailable` warning is emitted instead of inventing or
full-reading a revision. A note larger than `MAX_READ_BYTES` is skipped during
index construction (a proactive size gate plus the explicit size-limit error)
and does not abort the index or other notes' bounded target reads; a permission
error or any unexpected read failure still propagates.

## Warning codes

`target_note_too_large`, `target_changed_during_read`, `revision_unavailable`,
`source_revision_unavailable`, `index_unavailable`, `index_scan_truncated`,
`backlinks_truncated`, `related_truncated`, `budget_exhausted`,
`ambiguous_link_omitted`, `semantic_degraded_to_lexical`,
`related_unavailable`. The warning count is bounded; `budget_exhausted` is
always retained when the character budget is hit. Error text surfaced through
`index.semanticError` is bounded (200 codepoints) and credential-redacted.

## Error behavior

- Unsafe or escaping paths fail with `Path traversal denied` (MCP tool error).
- A path whose canonical target resolves outside the Vault — a final-name
  symlink or an intermediate directory symlink — fails with
  `Symbolic link escapes the vault` before any external target is stat'd, read
  or hashed. The canonical check runs before the target stat and again inside
  the bounded reader.
- Missing notes return `not_found` (not an error).
- Authorization remains scope-based: `get_note_context` requires
  `obsidian.read` and is never an authorization mechanism.

## Non-goals

- No project/workspace discovery.
- No full note body; that stays in `get_note`.
- No mutation, no server-side state, no dynamic tool registration.
