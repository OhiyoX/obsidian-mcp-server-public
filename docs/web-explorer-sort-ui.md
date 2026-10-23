# Obsidian Web Explorer — Lazy Tree Sorting (Phase 2B adaptation)

Status: **implemented (recovered on `feat/explorer-lazy-sort-recovery`)**. It was
originally authored against `1547e84daa1b92f0e26fdf21566c722635d547d4` and is
recovered onto frozen main `243d02c8e4201de670b75c604ebd1e7a6b3432db`, which
already carries the Phase 2B `#198` (load-first inline create), `#199` (stable
DOM / in-place refresh) and `#196` (request-level network contract) changes.
Scope: `app/frontend/app/features/explorer/{sort-spec,sort-preference,sort-control,view-model,lazy-model,lazy-controller,controller,tree}.js`,
minimal sidebar markup/CSS, and the generated `app.js` bundle.

This document supersedes the "switch sort with zero network" rule of the earlier
pure-model UI slice **for the Tree only**. It does not change the pure model,
the search backend, or any server contract.

## 1. Three view semantics are distinct

| View | Ordering authority | Network on sort change |
| --- | --- | --- |
| Root children | server (`GET /api/web/v2/tree?parent=&sort=&direction=`) | yes — new first page |
| Expanded parent | server, per parent, full paginated ordering | yes — new first page per materialized parent |
| Query/search result set | **v2 search server order is authoritative** | Explorer sort preference is retained for Tree only; active search rows are not re-ranked client-side |

The same control drives all three, but the Tree never claims that a page is the
whole Vault. Since Phase 3A-3, the search view also preserves the v2 server order and never claims to be a Vault/parent universe.

## 2. SortSpec is a request identity

`sort-spec.js` normalizes to `{ version: 1, key: "name"|"modified", direction: "asc"|"desc" }`
(fails closed to `name asc`). `sortSpecQuery()` maps it to the **existing**
children-API parameters `sort`/`direction`; no new server field is introduced.

`lazy-model.js` keeps a global `sortEpoch` (monotonic) and records, per parent,
the epoch a loaded page/cursor was produced under. Every request freezes
`{ parent, spec, epoch, captured generation, owner token }`.

## 3. Fence rules

- A response, error, `finally`, 503 retry or `locate`/`anchor` continuation may
  only write state while its owner is still current **and** `epoch`/`spec` match.
- A sort change aborts in-flight requests and retires every page, cursor,
  loading owner and error under the old epoch (interaction state `expanded` /
  `currentPath` is preserved).
- An old cursor is never reused for a new sort: `loadMore` only uses a cursor
  whose page belongs to the live spec.
- `invalidateParent` (SSE note events) retires the parent's in-flight ownership,
  so a late response cannot write a retired branch back.
- Loading is owned (`loadingOwnerByParent`), never a bare per-parent boolean, so
  a late `finally` cannot clear a newer request's loading flag.
- `503 catalog-not-ready` retries carry the originally frozen spec and stop as
  soon as their owner is retired (e.g. by a sort change).

## 4. Materialization, focus and inline create

- After a sort change the root is re-fetched, then only the user-expanded chains
  are re-materialized (bounded by `expanded`, never the whole Vault). The current
  note is re-located with `locate()` under the new spec when it was materialized
  before the switch.
- A global reset (`invalidateEverything`, driven by `vault.resync` — coverage gap,
  watcher-ready or a watcher error) applies the same rule: it keeps `expanded` and
  `currentPath`, so it re-materializes root + every expanded chain and then
  anchor-reveals `currentPath`. A reset that reloaded only the root left each
  expanded ancestor rendered as an expanded-but-empty box (no children, no loading
  row, no error) — the issue #336 first-paint symptom — because the resync is
  delivered while `locate()` is still walking the anchor chain.
- `reveal`/`ensureVisible` clear the query first, then locate under the current
  spec — never a name-default anchor on a modified-sorted tree.
- Inline create keeps the draft and focus: while the input is active, a sort
  request is only recorded as `pendingSort` (last one wins). On commit/cancel the
  last requested spec is applied against the latest lazy generation, and cursors
  captured before the draft are never reused.

## 5. Preference

`sort-preference.js` is unchanged: one strict, global `localStorage` payload
(`obsidian-web.explorer-sort.v1`), no account/vault/path/query fields, damaged
JSON or unknown key/direction fails closed to `name asc`.

## 6. UI

Sorting follows the desktop file explorer: one icon button in the file toolbar
(`#explorer-sort-toggle`) opens an option menu (`#explorer-sort-menu`) holding one
entry per key×direction (filename A-Z / Z-A, edit time newest / oldest first). The
checked entry carries `aria-checked="true"`, and the trigger's accessible name and
tooltip show the live choice, so the control costs no dedicated sidebar row.
This supersedes the earlier `['reveal-active','publishes-open']` toolbar shape:
`#explorer-sort-toggle` is the first toolbar button and `scripts/web-regression.mjs`
asserts the new three-button list. `mousedown` is prevented on the trigger and on
every option so a mouse interaction cannot blur an open inline-create input — only a
keyboard-opened menu moves focus (to the checked option, back to the trigger on
close). The menu positions itself from viewport coordinates through
`ui/popup-position.js` (the same pattern as `ui/select.js`) instead of living inside
the sidebar's overflow box. Preference storage, SortSpec, the request fence and the
zero-IO query-sort rule are unchanged.

## 7. Explicit non-goals

No backend children API/query/order/cursor/catalog change, no auth/Web-session/
reconnect change, no Flat/heat/cache change, no SSE server semantics change, no
restoration of a global `state.notes` model, and no second comparator in the
lazy Tree renderer.

## 8. Phase 2 — Flat view (same control pattern, separate controls)

The Tree sort control above is frozen. The flat view reuses the same
icon-button/menu pattern in its own controls, so it cannot mutate the Phase 1 Tree
schema:

- `#explorer-mode-toggle` → `#explorer-mode-menu` switches Tree <-> Flat
  (`obsidian-web.explorer-mode.v1`). The desktop file explorer has no flat mode, so
  this is a user-specified Web enhancement (like the U3 splitter): it reuses the
  existing `list-tree` glyph and fabricates no desktop icon or menu item.
- `#explorer-flat-sort-toggle` → `#explorer-flat-sort-menu` holds the flat keys
  (`obsidian-web.explorer-flat-sort.v1`, default `modified desc`). Options whose
  `data-requires-query="true"` (`name`, `score`) render disabled with an explicit
  reason while no query is active, because a query-less flat page is server-ordered
  and cannot serve those keys (see `docs/web-explorer-sort-model.md` §12).
- The files panel head carries `data-explorer-mode`; CSS shows exactly one sort
  trigger per mode and hides the Tree-only structure actions (`新建文件夹`, `折叠全部`)
  in Flat.
- Switching the mode never clears the query, never re-fetches the search stream and
  never touches the Tree's lazy expansion set, so switching back restores the same
  Tree. With a query active the flat list is a projection of the loaded search rows;
  without one it is the server `flat=1` keyset page.
- Both lists paint the **same** files-panel host (`#note-list`), so the Tree's
  DOM-reuse cache (`lastTreeSignature`, a statement about the model only) is dropped
  whenever Flat paints. Without that drop the switch back to Tree compares an
  unchanged signature, returns early and leaves flat rows behind while the control
  already reads "树状视图" (issue #335). A switch during an in-flight catalog
  invalidation still shows the existing `正在加载…` placeholder until the root page
  lands — the loading semantics are unchanged.
- Reveal in Flat walks the keyset pages until the current note is present (bounded),
  then scrolls to and highlights its row with the same `aria-current="page"`/`.note.active`
  identity the Tree uses. The Tree behaviour of the same control is unchanged.
- `scripts/web-explorer-flat-regression.mjs` is the additive real-Chromium regression
  for these behaviours (mode switch, query retention, every sort key, reveal,
  preference reload, narrow layout); `scripts/web-regression/explorer-mode-switch.mjs`
  is the CI-matrix scenario that asserts the immediate repaint of both directions
  (no query and with a query, Publish filter included).
