# Obsidian Web Bases — table touch (issue #337, Cut 3)

Related: [`docs/web-bases-mobile-chrome.md`](web-bases-mobile-chrome.md) (Cut 2, which introduced the
mobile chrome this table sits in), [`docs/web-explorer-touch-prefetch.md`](web-explorer-touch-prefetch.md)
(Cut 1, the shared mobile regression infrastructure), `scratch/web-bases/U20/DESIGN-RESPONSE.md`
§Cut 3 (the design verdict this implements), `scripts/web-regression/bases-table-touch.mjs` (the
browser scene), `test/web-bases-table-touch.test.js` (the Node line).

## 1. What changed, and what deliberately did not

At phone widths the Base table was still the desktop table: `41.5px` rows (below any touch-target
minimum), a live column-resize boundary, and no touch affordance of its own. Cut 3 gives that
surface its finger behaviour:

- `frontend/app/features/bases/styles.js` — one `@media (pointer: coarse)` block: the container's
  `touch-action`, the 44px row height, the hidden resize handle and the tap-selection paint.
- **new** `frontend/app/features/bases/pointer-policy.js` — `isCoarsePointer(win)` and the pure
  selection transition. One place decides "is the primary pointer a finger", so the resize policy
  and the selection policy cannot drift apart.
- `frontend/app/features/bases/resize.js` — `attachColumnResize` returns an inert, `disabled:true`
  handle on a coarse pointer: no listener set is ever attached on top of the `touch-action:none`
  handle.
- `frontend/app/features/bases/view.js` — row identity (`row.path`), the tap-selection state and its
  re-application after a re-render. The row handler is bound **only** on a coarse pointer.
- `frontend/app/features/bases/controller.js` — passes the already-threaded `windowObject` down to
  the view (one line; the capability seam is injected, never sniffed).
- **new** `app/scripts/web-regression/bases-table-touch.mjs` + one call from `bases-mobile.mjs` — the
  six table-touch checks, in the same 360x800 `pointer: coarse` / `hover: none` context as the Cut 2
  chrome scene (the file split is the 500-line architecture budget; none of the six Cut 2 checks was
  touched).
- **new** `test/web-bases-table-touch.test.js` and one entry in `web-bases-surface-contract.test.js`
  (`pointer-policy.js` joins the module-isolation/line-budget/sink list).

**Not changed:** every desktop rule above the block is byte-identical — the container keeps
`overflow:auto` + `overscroll-behavior:contain`, the handle keeps `touch-action:none`, the rows keep
`padding:9px 12px` at narrow widths, and the 1440px fine-pointer matrix (including every
`bases/parity/*` item and the mouse column-drag) behaves exactly as before (measured: `touch-action`
`auto`, rows `42.25px`, handle `display:block`, drag `220px -> 280px` persisted). There is **no**
drag alternative for the column width in v1, **no** new dependency, **no** new endpoint and **no**
`app.css` / Explorer / render-parity change.

**The optional sticky first column is not implemented** (design marks it "optional enhancement").
Reason: at 360px the first column is 220px of a 360px band, so pinning it would leave ~140px of live
data and make horizontal panning the only way to read any other column, while adding a second
scroll-coupled geometry that no existing gate measures. The design's other optional item ("tooltip on
a resize attempt") is also not implemented: the handle is not reachable at all.

## 2. The gate is a capability, not a width

All four rules are keyed on `(pointer: coarse)` — the kind of *primary pointer*, not the viewport
width:

- a phone in landscape (520px wide) is still a finger-first device and keeps all four rules;
- the desktop matrix runs a fine pointer, so it is untouched even though Cut 2's chrome block is
  width-keyed at `<=480px`;
- `any-pointer: coarse` is deliberately not used: a touchscreen laptop whose primary pointer is a
  trackpad keeps the desktop table (the design's "explicitly disabled on `(pointer: coarse)`").

`pointer-policy.js` fails closed to the desktop side for any window it cannot interrogate (no
`matchMedia`, or a throwing one), which is what keeps the Node harness — and therefore every existing
Base unit test — on the desktop path.

```
(pointer: coarse)                        desktop (pointer: fine)
  .base-table-wrap  touch-action:pan-x pan-y    unchanged (auto)
  tbody tr          44px min height             padding-based (41.5px narrow / 42.25px wide)
  .base-col-resize  hidden + never wired        hover handle, drag resizes + persists
  tap on a cell     selects its row             no row selection at all
  tap on a link     opens the note, no select   link opens the note
```

## 3. Row selection: why it exists, and what it is not

The design's Cut 3 acceptance says "row selection works via 44px touch target" and "link click > row
selection", but **no row-selection behaviour existed anywhere in the tree** (verified: no
`aria-selected` / row click handler in `features/bases/**`, and the desktop parity items only pin the
*link* click). Without a selection there is nothing for the priority rule to protect, so this cut adds
the minimum that makes the contract observable:

- a tap on a row's cell sets `aria-selected="true"` + `.is-selected` on that `<tr>` and clears any
  previous one (exactly one selected row, or none);
- a tap on the already selected row clears it (a real transition, not a one-way flag);
- the selection is keyed by `row.path` and re-applied after a re-render; it is reset when the surface
  is cleared;
- **a tap on a link cell never reaches the row handler**: the link button keeps calling
  `stopPropagation()` (cell.js), which is the whole mechanism — the row handler deliberately does not
  re-check `event.target`, because a target check would silently duplicate the guard and make the
  contract unfalsifiable.

Honest scope: v1 has **no consumer** for the selection (no bulk action, no keyboard selection, no
cross-page persistence) — it is the touch state the design's acceptance calls for, nothing more. The
row handler is bound only on a coarse pointer, so desktop gains no selection affordance.

## 4. Verification map

| behaviour | evidence |
| --- | --- |
| capability seam, selection transition, resize refusal (coarse inert / fine still resizes), selection state machine + re-render + link `stopPropagation`, stylesheet placement | `test/web-bases-table-touch.test.js` (7 cases) |
| horizontal pan, vertical pan (data cell **and** column boundary) with in-scene `pan-x` falsification, 44px rows, boundary hidden/untargetable/inert, tap selection + paint, link priority (DOM mutation observer) | `scripts/web-regression/bases-table-touch.mjs` (6 checks, matrix 133 → 139), trace in `<outputRoot>/bases-table-touch-trace.json` |
| desktop unchanged (touch-action, row height, handle, mouse drag + persist, no selection) | the 1440px `bases/parity/*` items plus the `probe-desktop-fine` measurement (`touch-action:auto`, row `42.25px`, drag `220 -> 280`) |
| Cut 2 chrome, Cut 1 prefetch | unchanged scenes, re-run green |

## 5. Measured facts and honest boundaries

- **The container already scrolled horizontally; the missing piece was the axis declaration.**
  `.base-table-wrap` is `overflow:auto`, so on the pre-cut tree `overflow-x` was already `auto` and a
  real CDP finger pan already moved `scrollLeft` `0 -> 460` (`scrollWidth 820` vs `clientWidth 360`).
  What did **not** exist was `touch-action:pan-x pan-y`: the pre-cut container computed `auto`.
  Behaviourally `auto` also allows both axes, so the declaration is a *freeze* of the contract; that it
  is load-bearing was verified rather than asserted — narrowing it to `pan-x` makes the same vertical
  pan deliver nothing (`scrollTop 0`, evidenced by the in-scene falsification inside T2 **and** by the
  `pan-x`-only negative control turning T1+T2 red), and the 7px handle's own `touch-action:none` was
  the pre-existing code that could capture an axis.
- **"Page scroll" is the container's vertical axis in this surface.** `#base-host` fills `.document`
  absolutely and the table box is the only vertical scroll owner *by design* (desktop invariant,
  unchanged here), so at 360x800 no ancestor has vertical overflow at all. The check therefore
  constructs a real vertical overflow *inside the container* (360x420: `scrollHeight 400` vs
  `clientHeight 224`) and asserts that a vertical finger pan moves `scrollTop` `0 -> 176` while
  `scrollLeft` stays `0` — i.e. the horizontal scroller never owns the gesture. Scroll chaining past
  the container stays disabled by the pre-existing `overscroll-behavior:contain`.
- **The resize trap was real.** On the pre-cut tree the handle sat at every column boundary as a 7px
  `display:block` element with `touch-action:none`; a vertical pan starting exactly there delivered
  `scrollTop 0` (measured), and a horizontal one was swallowed too. After the cut the same point
  hit-tests to the header cell and pans in both axes (`scrollTop 176`, `scrollLeft 460`).
- **Rows are 44px, cells carry the target.** All seven fixture rows measure `44px` except the one
  two-line row (`82px`); the cell box inside a row measures `44px` (`padding:9px 12px` + `height:44px`).
- **Android/Chrome emulation only.** The scene runs Chromium's mobile emulation profile
  (`hasTouch`, `isMobile`, `deviceScaleFactor:3`), which is what `(pointer: coarse)` / `(hover: none)`
  resolve from. Real iOS Safari / Android Chrome (notch insets, 120Hz feel, real `touch-action`
  compositor behaviour, momentum panning) is **unverified** here and stays on the manual checklist the
  design defines (`docs/manual-mobile-verification.md` is still to be written; the design's Cut 3
  HANDOFF requires it before a production deploy).
- **Touch input is synthesised through CDP.** `Input.dispatchTouchEvent` (the channel behind
  Playwright's `touchscreen.tap`) drives the real gesture pipeline — measured: it honours
  `touch-action` (`none` stops both axes, `pan-x` stops vertical, `pan-y` stops horizontal) — but it is
  not a hardware finger: gesture *feel*, inertial panning and pinch behaviour remain unproven.
- **Selection paint and hover.** The selected row paints
  `color-mix(in srgb, var(--interactive-accent) 12%, transparent)` plus a 2px inset accent bar; a
  trailing tap also leaves Chromium's touch-hover background on the row, so the selected tint is
  asserted as *different from* an unselected row rather than as an exact colour.
- **`overscroll-behavior: contain` is untouched**, so a pan that reaches the end of the table still
  does not chain to an ancestor. That is the pre-existing desktop behaviour; a future "let the page
  take over at the ends" decision is a separate change with its own evidence.
