# Obsidian Web Explorer — Hover Prefetch (issue #284)

Status: **implemented (Wave A/B), §13.4 check scenario corrected under review advisory (A3-R1,
fix §10.1); merge/release/deploy are separate approvals.**
Scope: `app/frontend/app/features/explorer/prefetch.js` (intent policy), `lazy-controller.js` /
`lazy-prefetch.js` (speculative bookkeeping), `prefetch-hover.js` + `tree.js` (pointer wiring).
Contract: `_Workspace/40-Projects/obsidian_mcp_server/Web/DEVELOPMENT - Issue 284 Explorer hover
预取与懒加载无缝展开.md` (implementation authority).
Touch/pen input is a separate policy on the same kernel: see
[`docs/web-explorer-touch-prefetch.md`](web-explorer-touch-prefetch.md) (issue #337, Cut 1).

## 1. What changed, and the boundary that was deliberately relaxed

The lazy Explorer historically loaded a directory level **only when the user actually expanded
it** ("只加载实际展开目录"). Hover prefetch narrows that boundary on purpose:

> a collapsed directory that the pointer has rested on for the intent window is loaded
> **before** the click, so the first expansion renders without a visible `正在加载…` gap.

What stays inside the boundary:

- **directory metadata only** — the same `/api/web/v2/tree` page the click would have fetched;
- **first page only** — never a `cursor`, never `loadMore`, never an `anchorPath` reveal;
- **no recursion** — a prefetched page is never followed by its children's pages;
- **no note bodies** — no `/api/web/v1/note`, no `reader`, no rendering;
- **no read of the user's Vault content beyond the level's own listing**.

The relaxation is therefore "the next level's listing may be fetched slightly early", not
"the Vault is crawled". See §8 for what an audit must be able to grep for.

## 2. Trigger parameters (frozen first slice)

| parameter | value | source |
| --- | --- | --- |
| intent window | `150 ms` continuous hover on the same row | `PREFETCH_INTENT_DELAY_MS` |
| capability | `matchMedia("(hover: hover)")` must match | `HOVER_MEDIA_QUERY` |
| scope of the event | directory rows only (`row.onpointerenter` / `onpointerleave`) | `prefetch-hover.js` |
| repeat enter on the same row | neither restarts the window nor issues twice | `prefetch.js` |
| a row left inside the window | no request at all | `prefetch.js` |

The window is a first-slice UX/resource parameter frozen by contract §0.3, not a protocol
constant; changing it is a product decision, not a bug fix.

## 3. Concurrency

- At most **2** speculative (hover) requests may be active per controller
  (`PREFETCH_CONCURRENCY_LIMIT`).
- The budget counts speculative owners only. Signaling a third hover past the budget is a
  **fixed drop** — nothing is queued, and the row simply behaves as if it had not been hovered.
- Formal intents (`toggle`, `ensureLoaded`, inline-create `+`, `locate`) are never queued behind
  the budget: they issue immediately, and they always take precedence over a speculative owner
  for the same parent.
- Promotion (a formal intent reaching a still-speculative owner for the same parent) reuses that
  owner: request count stays 1, the owner is upgraded in place, and one speculative slot is
  released immediately.

## 4. Cancel policy

- `pointerleave` after an issue calls `cancelPrefetch(parent)` exactly once.
- The controller cancels **only** an owner that is still speculative. A promoted (formal) owner is
  never aborted — a late `pointerleave` after the click is a no-op.
- Cancelling an in-flight speculative request aborts it; cancelling an already-answered, unconsumed
  speculative page **reclaims** it (page, cursor, generation and sort identity), so abandoned
  hovers cannot accumulate cached levels.
- A page that a formal intent consumed becomes ordinary cache and is never reclaimed by a later
  `pointerleave`.

## 5. Failure behaviour

- A failed prefetch is invisible: no `errorByParent` write, no error row, no toast — only a `failed`
  counter in `prefetchStats()`.
- The formal path is unchanged: the click that follows a failed prefetch still runs the normal
  loading / retry experience.

## 6. Consistency fences

A prefetched page is applied only under the same fences as a formal load: owner identity, sort
epoch, `SortSpec`, and the existing generation rules (`P284-I03`). Concretely:

- **generation / SSE invalidate** — a file change invalidates the level; a stale speculative
  response never reaches the DOM and never replaces the fresh page. Expanding after an invalidate
  fetches again instead of consuming the stale page.
- **sort change** — a page fetched under the old spec never wins under the new one; the rendered
  order always matches the response of the current spec.
- **speculative pages never render by themselves** — no `expanded` write, no loading row, no focus
  or `currentPath` change, no inline-create disturbance before the user clicks.

## 7. Preference and rollback

| item | value |
| --- | --- |
| key | `obsidian.web.explorer.prefetch.v1` |
| values | `hover` (default, opt-out) · `off` |
| invalid value | falls back to `hover` |
| scope | browser-global interaction preference; not per account / Vault / path |
| rollback | set the key to `off` (or ship with it forced off) — no server, Compose or Vault change is needed |

With `off`, network, DOM and error behaviour are identical to the pre-#284 main
(`P284-I09`); `hover: none` devices and blocked `localStorage` are fail-closed no-ops
(`P284-I10`).

## 8. Audit greps (what "nothing else was relaxed" means)

- `frontend/app/features/explorer/prefetch.js` — no `fetch(`, no DOM access, no model import.
- `frontend/app/features/explorer/prefetch-hover.js` — the only pointer binding; no timer,
  no `fetch`, no `AbortController`, no `matchMedia`.
- `tree.js` — binds the row events through `prefetch-hover.js`; its only `setTimeout` remains the
  pre-existing inline-create blur deferral.
- the only endpoint involved is `/api/web/v2/tree`; speculative requests carry neither `cursor` nor
  `anchorPath`.

## 9. Verification map

| behaviour | evidence |
| --- | --- |
| 150 ms window, capability, preference, dispose | `test/explorer-prefetch.test.js` (fake clock) |
| controller contract: silent success, owner-safe cancel, promotion, budget, fences, reclaim | `test/explorer-prefetch-controller.test.js` |
| renderer wiring + real pointer bridge | `test/explorer-tree-interaction.test.js` |
| real-Chromium wire/DOM behaviour (§13.1–§13.8) | `scripts/web-regression/explorer-prefetch.mjs` |

## 10. Known open item (Wave C, 2026-10-05)

`explorer prefetch budget` (§13.4) is red on the integration HEAD while the other seven Chromium
checks pass. The check establishes its premise by hovering three sibling folders with a real
pointer; moving off folder A fires `pointerleave`, which (by design, §4 above) cancels A and frees
its slot, so "two speculative requests in flight" is never true when the third hover is measured.
Measured evidence (`scratch/issue-284/C/evidence/probe/`):

- the A/B requests are aborted with `net::ERR_ABORTED` exactly when the pointer moves on;
- when the same premise is established *without* a `pointerleave` (synthetic `pointerenter` on three
  rows), the third hover issues **0** requests — i.e. the I05 budget itself holds.

Making the frozen check pass therefore requires either re-specifying its scenario (do not leave the
first two rows) or changing the frozen intent/cancel semantics (which the A2 contract test
`cancelPrefetch aborts only the speculative owner` forbids). The decision belongs to the coordinator
and the A1/A3 owners; this document only records the boundary as implemented.

### 10.1 Disposition of §13.4 (A3-R1, 2026-10-05)

The review advisory chose **option A — correct the check's scenario, keep the frozen cancel
semantics** (option B, changing A1/A2's cancel semantics, was rejected). `scripts/web-regression/
explorer-prefetch.mjs` §13.4 now enters the first row with a **real hover** — so the shipped pointer
path is still what issues a prefetch — and enters the second and third rows with a synthetic
`pointerenter` dispatched on the **real rendered row** (same binding, same intent module, same
network; only the pointer travel is omitted). That establishes "two speculative requests in flight"
without firing `pointerleave` on the first row, which a real A→B move would (it aborts A and
returns its slot — the unreachable premise measured in §10 above).

**No assertion was relaxed.** `budget:issued` (1 request per row), the `settled === 0` guard,
`budget:third` (0 requests) and `budget:formal` (1 request) are byte-identical to the red run; only
the way the three rows are entered changed. Review also approved one **added** positive assertion:
after the budget phase, moving the real pointer off a row whose request is still speculative and in
flight must abort it (`aborted >= 1`, message "real pointer leaving aborts the still-speculative
request (I04)"; the frozen §4 cancel semantics are what make that true). Negative control: raising
`PREFETCH_CONCURRENCY_LIMIT` from 2 to 3 makes the third row issue a request and the check turns
**red**, so the corrected scenario really does reach the premise (evidence:
`scratch/issue-284/C/evidence/a3r1-*`).

### 10.2 B2 residual-risk probe — honest disclosure (A3-R1, 2026-10-05)

Re-hovering the same folder right after a structural re-render issues no second request in the probe
(step D above). That is the level still being **cache-hot**, not a permanent degradation: a second
vault write invalidates that page and the next hover prefetches again (step E), and clicking the
folder in that state is a **cache hit** — the children (including the freshly written note) render
immediately with no `正在加载…` row. The root cause of D is still **not separated**: the silence is
consistent with both A1's intent still holding the parent in `issued` and the controller declining a
page it still considers current (I10 eligibility). Separating the two needs `prefetchStats()` / the
intent's `issued` set — frozen A1/B1 modules, out of an A3 slice's scope — so this remains an
**unverified item**, not a confirmed defect or a permanent downgrade.
