# Obsidian Web Explorer — Touch Prefetch (issue #337, Cut 1)

Related: [`docs/web-explorer-prefetch.md`](web-explorer-prefetch.md) (the #284 hover policy this
reuses), [`docs/web-bases-mobile-chrome.md`](web-bases-mobile-chrome.md) (Cut 2, which the mobile
scene described here was built to be shared with), `scratch/web-bases/U20/DESIGN-RESPONSE.md`
§Cut 1 (the design verdict this implements), `scripts/web-regression/mobile.mjs` (the browser
scene), `test/explorer-prefetch-touch.test.js` (the fake-clock matrix).

## 1. What changed, and what deliberately did not

Touch-first devices (phones, pens, tablets in `pointer: coarse` / `hover: none`) had no
speculative Explorer prefetch at all: `prefetch.js` is fail-closed without `(hover: hover)`, so
the first expand of an unloaded folder was always `tap -> request -> loading -> rows`. Cut 1 adds
a second, parallel intent policy for that input:

- **new** `frontend/app/features/explorer/prefetch-touch.js` — pure policy: the 100 ms window, the
  10 px slop, the 250 ms commit grace, per-`pointerId` bookkeeping, the session ceiling, `dispose()`;
- **new** `frontend/app/features/explorer/prefetch-touch-bind.js` — the only renderer seam, delegated
  once on the list host (`#note-list`) instead of per row, because every render rebuilds the rows;
- `frontend/app/features/explorer/controller.js` — one intent instance + one host binding, next to
  the existing hover instance;
- `app/scripts/web-regression/mobile.mjs` + one registration in `web-regression.mjs` — the mobile
  scene (viewport 390x844, `hasTouch`, `isMobile`, coarse pointer / no hover).

**Not changed:** the hover policy (`prefetch.js`, `prefetch-hover.js`), the tree renderer
(`tree.js`), the lazy controller (`lazy-controller.js`), the tree endpoint, and the formal
click/toggle path. There is **no second cache, no second request channel, no new query parameter,
no new HTTP header, no new dependency, and no `touchstart` binding** — the touch policy calls the
same `controller.prefetch(parent)` / `cancelPrefetch(parent)` API and therefore inherits the same
owner/epoch/sort/generation/invalidate fences, the same silent failure policy and the same
`childrenByParent` cache (#337 I337-E01).

## 2. Trigger parameters (frozen first slice)

| parameter | value | where |
| --- | --- | --- |
| intent window (finger must stay down, ≤ slop) | `100 ms` | `TOUCH_PREFETCH_INTENT_DELAY_MS` |
| movement slop (Euclidean, one definition) | `10 px` | `TOUCH_PREFETCH_SLOP_PX` + `exceedsTouchSlop()` |
| post-release commit grace | `250 ms` | `TOUCH_PREFETCH_COMMIT_GRACE_MS` |
| pointer types | `touch`, `pen` (primary only, mouse ignored) | `TOUCH_PREFETCH_POINTER_TYPES` |
| capability | `(pointer: coarse)` **OR** `(hover: none)` | `resolveTouchCapability()` |
| speculative concurrency | `2`, shared with hover | `lazy-prefetch.js` (existing) |
| session ceiling | 20 issues / 60 s, then 120 s cooldown | `TOUCH_PREFETCH_RATE_LIMIT_*` |

These are UX/resource parameters, not protocol constants (same posture as #284 §0.3).

## 3. Lifecycle, ownership and cancellation

```
idle --pointerdown(primary touch/pen, folder row)--> armed (window timer)
armed --window elapses, still down, ≤ slop--> issued (`prefetch(parent)`, silent)
armed --pointerup inside the window--> nothing is issued (the click owns the formal request)
armed --pointercancel / pointerleave / travel > slop--> nothing is issued
issued --pointerup--> grace (the click may promote the owner; controller I08)
issued --pointercancel / pointerleave (finger still down) / travel > slop--> cancelPrefetch(parent)
grace --click/toggle promotes--> done (owner-safe late cancel is a no-op, I04)
grace --timer expires--> cancelPrefetch(parent)
```

Two details are deliberate and measured, not stylistic:

- **`pointerup` does not abort.** It starts the grace window so the click that follows the release
  can *promote* the in-flight owner (one request) instead of aborting and re-issuing (two). This is
  the touch form of #284 I08.
- **`pointerleave`/travel during the grace window is ignored.** A real touch pointer is released
  before the browser reports it as leaving the row — measured order on the emulated profile:
  `pointerdown -> pointerup -> pointerout/pointerleave (x4, up the ancestor chain) -> click`. A
  leave that arrives after the release is the tail of a completed tap, so cancelling there would
  abort a request that is about to be promoted.

`pointerleave` does not bubble, so the delegated seam observes it in the capture phase
(`prefetch-touch-bind.js`). The touch seam never calls `preventDefault`, `stopPropagation` or
`setPointerCapture` (I337-E02), so native scrolling, text selection and the click path are
untouched; a scroll instead arrives as `pointercancel` or as travel past the slop.

## 4. Cost controls

The per-parent speculative budget is the existing one (`PREFETCH_CONCURRENCY_LIMIT = 2`, over-budget
intents are dropped, never queued, I05) and is shared between hover and touch because both go
through the same controller bookkeeping. U20 §Q2 additionally requires a cumulative ceiling for
metered connections; it is enforced in the intent instance (`rateLimitMax` / `rateLimitWindowMs` /
`rateLimitCooldownMs`, injectable so the fake-clock tests pin it): the 21st issue inside a 60 s
window is dropped and starts a 120 s cooldown, after which the window resets. The formal click path
is never rate-limited — it does not go through the intent at all.

Telemetry is a plain `debug` seam (defaults to nothing; wire it to `console.debug` to see
`prefetch-issued` / `cancel:*` / `released-inside-window` / `grace-expired` / `rate-limited` /
`rate-limit-triggered`). Promotion stays accounted by the controller's existing
`prefetchStats().promoted` — no second counter, no external reporting.

## 5. Verification map

| behaviour | evidence |
| --- | --- |
| 100 ms window, 10 px slop, grace, cancel reasons, ceiling, multi-pointer, dispose | `test/explorer-prefetch-touch.test.js` (fake clock, no sleep, no DOM) |
| capability fail-closed (fine pointer, `off` preference, disposed) and mouse/secondary ignore | same file |
| delegated seam: host-only binding, no add-button arming, no timer/network rule | same file (behaviour + source invariants) |
| controller-side budget (drop the 3rd, formal never queued) | `test/explorer-prefetch-controller.test.js` (existing) + the browser budget gate |
| real Chromium touch/pen wire + DOM behaviour | `scripts/web-regression/mobile.mjs` (5 checks, 122 -> 127 in the matrix) |
| #284 desktop hover unchanged | the 8 existing `explorer-prefetch.mjs` checks, same green matrix |

## 6. Measured platform facts (why the gates are shaped this way)

- **Touch input defers main-thread work by ~110 ms on this emulated profile.** A plain
  `setTimeout(fn, 0)` scheduled from a folder row's own `pointerdown` listener ran 116 ms later, and
  the 100 ms window timer fired at the same moment. Consequence: for real *touch* input, a 0 ms
  window and a 100 ms window are observationally identical, so the window is asserted in the **pen**
  phase (its 0 ms timer runs at +16 ms, the window timer at +107 ms) and owned by the fake-clock
  unit matrix. The negative control (`TOUCH_PREFETCH_INTENT_DELAY_MS = 0`) turns the pen assertion
  and three unit tests red.
- **The first tap after a canceled scroll does not become a click.** Measured sequence after a swipe:
  `pointerdown -> pointerup` with no `mousedown`/`mouseup`/`click` (the platform's "stop the
  scroll"). The mobile scene therefore runs its swipe last, and it waits for the list to stop
  scrolling before pointing at a row.
- **A request aborted a few milliseconds after it is initiated can be invisible to Playwright's
  wire observer**, so the scene also records every tree fetch the page initiates (an in-page `fetch`
  wrapper) and compares both halves in the page's own clock domain.

## 7. Honest boundaries

- The touch fast-tap/scroll gate (`mobile touch prefetch issues no speculative request for a fast
  tap or a scroll swipe`) **passes on the pre-#337 base**, because all of its assertions are
  negative ("no request") and the base trivially issues none. Its falsifying power is exercised by
  the window negative control (its sibling gates) and by the unit matrix; it is kept because it is
  the user-visible contract, not because it is red on base. The other four mobile checks are red on
  base.
- The 20/60 s ceiling has fake-clock unit tests but no browser gate (no scene needs 20 touch
  issues), and it is enforced by the intent instance rather than inside `lazy-controller.js`
  (U20 §Q2 says "controller state"): that file is at 487/500 lines and #337 §B1 declares a
  `lazy-controller.js` change a scope deviation. Behaviour is unchanged either way; the placement
  is the deviation, and it is flagged for the coordinator.
- The renderer seam is wired from `controller.js` (one delegated binding on the list host) rather
  than from `tree.js`: `tree.js` is at 499/500 lines with no baseline entry, and the row DOM is
  rebuilt on every render, so a per-row binding would have to be re-attached on each paint. The
  hover seam in `tree.js` is untouched.
- Production verification on a real Android/iOS device (the U20 §"Manual iOS Safari Checklist",
  including `visualViewport`/safe-area behaviour and a real 120 Hz tap) is **not** part of this
  slice and remains open for the cuts that own mobile Bases chrome.
