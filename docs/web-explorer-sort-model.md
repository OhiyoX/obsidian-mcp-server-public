# Obsidian Web Explorer — Sort Model (Phase 1 pure contract)

Status: **Phase 1 model implemented; consumed by the search-result view and by the Phase 2 flat list; lazy Tree ordering is server-authoritative.**
Scope: planning/contract record for `app/frontend/app/features/explorer/sort-model.js`.
The module is a pure projection layer. It is imported by `view-model.js` and by `flat-mode.js`
(which orders the already-returned search result set) and therefore bundled for
the Explorer search view. It does **not** order lazy Tree pages: the paginated
Tree takes its ordering from the server (see `docs/web-explorer-sort-ui.md`). See §12 for the Phase 2
flat-view wiring and which server keys a query-less flat page can actually serve.

## 1. Purpose and boundary

`sortTreeLevel` and `sortFlatNotes` re-order records that the caller already
holds. They are a defensive layer for a future toolbar / persisted preference:
an unknown or stale sort spec can never throw or leak into arbitrary ordering —
it fails closed to the view default.

The model does **not**:

- fetch, search, filter, paginate, or re-run any query;
- change hard filters, `path:` / `file:` / `tag:` / `published:` semantics, parser
  or semantic recall;
- change query membership, or break the existing `300` / `10,000` server bounds;
- add server fields, read `created`, dedupe, merge, or drop records;
- touch UI, `core/app.js`, controller, `tree.js`, routes, search, auth, API,
  localStorage, or the browser harness.

`metadata-only` tree sorting is only "sort the returned list". A
`slice(0, 300)` truncated tree stays truncated; this is **not** a
"sort the whole Vault by name/modified" feature. Flat/query sorting is a
projection of the server-returned query result set, not a new search.

## 2. Public API (frozen)

```js
sortTreeLevel({ folders, notes }, sort?)
sortFlatNotes(notes, sort?, context?)

sort    = { key, direction }
context = { query: boolean }
```

Defaults for both functions: `{ key: "name", direction: "asc" }`.

| view | allowed `key` |
| --- | --- |
| Tree | `name`, `modified` |
| Flat | `name`, `modified`, `path`, `score` |

`direction` is `asc | desc`.

`score` is only legal in `sortFlatNotes(..., { query: true })`. A `score`
request in any non-query context falls back to `name asc`; the model never
infers query context from a non-zero `score`.

Any invalid/unknown `sort` (unknown key, unknown direction, missing direction,
non-object spec) fails closed to that view's default `name asc`. It does not
throw. Passing an invalid **container shape** (non-object `{folders, notes}`,
non-array `folders`/`notes`/`notes`) throws `TypeError`; this is the explicit
fail-closed boundary and is covered by tests.

## 3. Immutability and identity

- input arrays are never mutated;
- records are never mutated or replaced;
- returned elements are the **same object references** as the input;
- cardinality is preserved: no de-duplication, no merge, no drop;
- duplicate `path` values are kept as separate records;
- when every comparison key is equal, the original input index is the final
  stable tie-break, so equal inputs are deterministic without hiding upstream
  duplicates.

Only these existing record fields are read: `path`, `title`, `modified`, `score`
(`tags`/`matchCount`/`snippets` are never needed for ordering). No new server
field is invented, so the module can be adopted without an API change.

## 4. Name semantics

The sort name for a note:

1. `title` when it is a non-empty string;
2. otherwise `basename(path)`;
3. otherwise the raw `path`.

`.md` is never stripped and no new display title is derived. `basename` is the
segment after the last `/`; a path ending in `/` (empty basename) falls back to
the raw path. A folder uses `name`, else `basename(path)`, else raw `path`.
Records whose name/path are not usable strings degrade to `""` for comparison
only; the record itself is untouched.

A `.base` and an attachment (`file` kind: any non-Markdown, non-Base regular
file) carry no frontmatter title, so they sort by the full file name — extension
included (`Report.pdf`, `Notes.txt`). The server stores that full name in the
`basename` ordering column; the Tree DTO surfaces it as `title` plus the
lowercase `extension` badge source for a `file`.

Name comparison uses a pinned collator — never a bare `localeCompare()`:

```text
locale: zh-Hans
numeric: false
sensitivity: variant
ignorePunctuation: false
```

The comparison key is NFC-normalized, but the record (and the clickable `path`)
is never rewritten. **No natural/numeric ordering is provided**, so `foo2` vs
`foo10` has no "human number" guarantee.

> The locale is pinned to avoid following the browser default, but
> `Intl.Collator` depends on ICU/Unicode data. Bit-for-bit identical ordering of
> Chinese names across different ICU versions is **not** guaranteed; tests must
> not lock a specific pinyin total order.

## 5. Path comparison

`path` sorting and every final path tie-break use a raw JS string UTF-16
code-unit comparator (`a < b` / `a > b`). No collator, no `localeCompare`, no
NFC. Path identity is therefore locale-independent.

For every key other than `path` itself, the primary key may be `desc`, but the
final path tie-break stays `ASC`. `desc` is applied by negating the primary
comparison only — never by `array.reverse()` — so grouping, missing-last, and
path ties are never inverted.

## 6. Tree semantics

`sortTreeLevel` returns new `{ folders, notes }` arrays. The consumer contract is
that folders always render before file entries; a note, a `.base` and an
attachment all belong to the single file group and are never placed in a single
comparator with folders and reversed together. Server-side this is the catalog's
`kind_rank` (`0` directory, `1` note|base|file).

`key = name`

- folders: folder name by direction;
- notes: note name by direction;
- equal name → raw path `ASC`;
- fully equal → original input index.

`key = modified`

- folders have no `modified` metadata; it is never faked;
- folders are fixed at name `ASC`, unaffected by `modified asc/desc`;
- notes order by valid `modified` timestamp asc/desc;
- invalid/missing timestamps always come **after** valid ones;
- within the invalid group: name `ASC` → path `ASC`;
- folders always precede all notes.

So `modified desc` can never move folders to the bottom or invalid dates to the
top.

### 6.1 Attachment (`file`) entries

An attachment is a regular Vault file that is neither `.md` nor `.base`
(images, PDFs, `.txt`, `.sha256`, `.zip`, extension-less files…). The catalog
records **metadata only** — path, name, extension, mtime and size. Its bytes are
never opened, hashed, parsed or projected, so it can never appear in FTS,
semantic candidates, tags, properties or link projections; only the existing
authenticated asset route can serve its content.

For ordering, `file` shares the `kind_rank = 1` file group with `note` and
`base`, so it interleaves by exactly the note rule above: `name` uses the pinned
collator on the full file name, `modified` keeps folders at name `ASC`, missing
or invalid `modified` always sorts last and is never flipped by `desc`, and the
raw UTF-16 path tie-break stays `ASC`. The Tree DTO adds `extension` for these
entries (lowercase, no leading dot, `""` when the file has no suffix) so the
client can render the desktop-style right-aligned suffix badge.

## 7. Timestamp contract

A timestamp is accepted only as a strict RFC3339-style datetime **with an
explicit timezone**:

```text
YYYY-MM-DDTHH:mm:ssZ
YYYY-MM-DDTHH:mm:ss+08:00
YYYY-MM-DDTHH:mm:ss-05:00
YYYY-MM-DDTHH:mm:ss.sssZ        (fractional seconds: one or more digits)
```

Accepted syntax details:

- `T`/`t` separator and `Z`/`z` designator are both accepted;
- fractional seconds accept one or more digits and are truncated to
  millisecond precision;
- the offset must be `±HH:MM` with two-digit hours/minutes.

Everything below is missing/invalid and always sorts last, in both directions:

- `undefined`/`null`, `""`, arbitrary text;
- a naive (timezone-less) datetime, e.g. `2026-01-01T00:00:00`;
- a space separator, e.g. `2026-01-01 00:00:00Z`;
- a non-`±HH:MM` offset, e.g. `+8:00`;
- calendar rollover: invalid day/month such as `2026-02-30`, `2026-06-31`,
  `2026-02-29` (non-leap year), month `00`/`13`, day `00`/`32`;
- out-of-range time such as `24:00:00` or `00:00:60`;
- a non-string value such as an epoch number.

The string form is checked first (regex + explicit component range checks), then
parsed. Explicit range checks are required because `Date.parse` silently rolls
calendar-invalid input forward (`2026-02-30` → `2026-03-02`).

## 8. Flat semantics

`sortFlatNotes` re-orders only the passed set. `name` and `modified` follow the
same rules as Tree notes.

- `path`: primary raw UTF-16 path comparator; `asc`/`desc`; equal path keeps the
  original index.
- `score`: only in query context; only a finite `number` is valid; `0` is a valid
  score; `NaN`/`Infinity`/`-Infinity`/non-number/missing are invalid and always
  last (never flipped by `desc`); finite scores follow the requested direction;
  score ties break by path `ASC`.

`direction` is an explicit contract; there is no implicit "score is always
descending".

## 9. Non-goals for this slice

The model has no authority to clear a query, change a filter, switch vault,
change the current selection, change `expanded`/`searchCollapsed`, reveal/scroll,
touch an active inline-create input, or read/write `localStorage`. Flat/reveal
coexistence belongs to a later wiring slice and must not be "handled in passing"
inside the model.

## 10. Integration prerequisites (next slices — not implemented here)

Merging `sort-model.js` means only the Phase 1 pure model exists. The Explorer
sort/flat TODO, localStorage preference, toolbar, controller wiring, and
bundle/browser integration remain OPEN future slices.

Before wiring the model into the controller, note that the current
`sameTreeShape` only compares sorted paths. Once sorting is active, reuse /
invalidation identity must additionally be aware of:

- the sort key and direction;
- the `title`/`name` and `modified` values that participate in ordering;
- flat query `score` where the view needs it;
- `path`.

Otherwise a refresh where paths are unchanged but a title or `modified` changed
would silently reuse stale DOM even though the theoretical order changed.

That controller change is explicitly out of scope here; this document records
only the contract.

## 11. Lazy Tree adaptation (Phase 2B)

The paginated Tree does **not** re-sort pages with this model. Tree ordering is a
server request-identity (`{version,key,direction}` + `sortEpoch`) mapped onto the
existing children-API `sort`/`direction` parameters, so the cursor and the
page boundary stay consistent. `sortFlatNotes`/`sortTreeLevel` continue to serve
the already-returned search result set only. See
## 12. Flat view wiring (Phase 2)

`sortFlatNotes` now backs the Explorer flat list
(`frontend/app/features/explorer/{flat-mode,flat-view,flat-controller,flat-control,flat-preference}.js`).
It has two data sources, and each one only offers the keys it can honour:

| Source | Rows | Ordering authority | Keys |
| --- | --- | --- | --- |
| Active query | the loaded `/api/web/v2/search` rows, adapted by `toFlatRecord()` | the frozen model (client-side projection of the returned set) | `name`, `modified`, `path`, `score` |
| No query | the `GET /api/web/v2/tree?flat=1` keyset page | the server | `modified`, `path` |

Server-side flat ordering (`src/app/web-catalog/ordering.js` `FLAT_ORDERINGS`) uses only
globally meaningful stored columns:

- `modified` = `(modified_valid, modified_asc|modified_desc, path_key)`;
- `path` = `path_key` (`asc` scans `nodes_kind_path_key` forward, `desc` backward, so the
  keyset operator is derived from the entry directions, never assumed to be `>`);
- `name` is **not serveable**: `name_rank` is a dense collator rank *within
  (parent, kind)*, so ordering by it across parents would group notes by their rank in
  unrelated folders. A global name order needs a catalog-level name-rank projection;
  until then `?flat=1&sort=name` is a `400 invalid-sort` and the browser control
  disables the filename entries while no query is active.

The flat `modified` tie-break is `path_key`, not the Tree's name-then-path: a global name
tie-break has exactly the same missing projection. Equal timestamps therefore order by
path in both directions.

The flat page keeps the tree envelope (`{parent, items, nextCursor, catalog}`) and the
tree cursor error family. A flat cursor carries `flat: true`, so a flat cursor is never
accepted by a children page and vice versa (they can otherwise share parent `""`, sort,
direction and keyset shape).