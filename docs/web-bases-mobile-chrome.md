# Obsidian Web Bases — Mobile chrome (issue #337, Cut 2)

Related: [`docs/web-explorer-touch-prefetch.md`](web-explorer-touch-prefetch.md) (Cut 1, which
introduced the mobile regression infrastructure this reuses), [`docs/web-bases-table-touch.md`](web-bases-table-touch.md)
(Cut 3, the table touch rules that sit inside this chrome), `scratch/web-bases/U20/DESIGN-RESPONSE.md`
§Cut 2 (the design verdict this implements), `scripts/web-regression/bases-mobile.mjs` (the browser
scene), `test/web-bases-mobile.test.js` (the Node matrix).

## 1. What changed, and what deliberately did not

At phone widths the Base tool row was still the desktop row: five icon-only action buttons wrapped
onto a second line, each `29x28` CSS px — below any touch target, unlabelled, and with no panel
larger than `320px` wide. Cut 2 gives that width its own chrome:

- `frontend/app/features/bases/styles.js` — a `@media (max-width:480px)` block: the hamburger, the
  menu shape of the action row, the full-width overlay panel, its header, the backdrop, and the
  safe-area / visual-viewport consumption. The desktop popover rules above the breakpoint are
  byte-identical.
- `frontend/app/features/bases/toolbar.js` — the hamburger button, the disclosure state, the
  backdrop mount and the Escape handling.
- `frontend/app/features/bases/panel-chrome.js` — `panelHeader()` / `withPanelChrome()` /
  `panelBackdrop()`: the two presentation nodes every popover gains.
- `frontend/app/features/bases/panels.js` — one place adds that chrome, so all five popovers carry
  it.
- **new** `frontend/app/features/bases/mobile-viewport.js` — a pure `visualViewport` observer that
  publishes `--base-visual-viewport-height` / `--base-visual-viewport-offset-top`.
- `app/scripts/web-regression/bases-mobile.mjs` + one registration in `web-regression.mjs` — the
  Bases mobile scene (360x800, `hasTouch`, `isMobile`, coarse pointer / no hover), which brings its
  own fixture Vault/server because the Base fixture documents are not in the shared harness Vault.
- `test/web-bases-mobile.test.js` (new) and one entry in the surface-contract module list.

**Not changed:** the five panel bodies (`panel-sort.js`, `panel-filter.js`, `panel-properties.js`
and the two panels in `panels.js`) keep their single set of action semantics (D337-06); there is
**no second action implementation, no duplicated business logic, no second query path, no URL or
API change, no new dependency and no file watcher**. Above 480px the hamburger, the overlay header
and the backdrop are `display:none`, so the desktop surface — including every
`bases/parity/*` browser check and every popover unit test — paints and behaves exactly as before.
Cut 3 (table touch: horizontal scroll, 44px rows, column-resize policy) is **not** part of this
slice; it landed separately in [`docs/web-bases-table-touch.md`](web-bases-table-touch.md). The
desktop column-resize behaviour and the `<=720px` narrow block are untouched.

## 2. The breakpoint is a CSS switch, not a JS branch

The three new elements exist in the DOM at every width and the `<=480px` block is the only thing
that reveals them. Consequences worth stating:

- a width change (rotation, split view) repaints without a re-render or a reload;
- there is **no width/UA branch in JS** for this cut, so no policy module was added:
  `matchMedia` capability policy (`mobile-policy.js` in the U20 sketch) belongs to Cut 3's
  coarse-pointer column-resize decision, and adding an unused module now would be dead code;
- the desktop DOM gains exactly three inert nodes per surface (`base-toolbar-overflow`,
  `base-panel-header` + its close button, `base-panel-backdrop`) and no inline desktop styles
  beyond the two visual-viewport custom properties on the tool row.

## 3. Interaction model

```
tool row (<=480px):  [view glyph] [view selector] [direction] [N 个结果]   ......   [☰]
☰ tap / Enter / Space  ->  action row is revealed as a menu (is-menu-open, aria-expanded=true)
Escape                 ->  menu closes
menu item tap          ->  menu closes, panel opens as a full-width overlay (is-panel-open)
overlay                ->  position:fixed, viewport width, own header + close button
backdrop tap           ->  overlay closes (the backdrop owns this dismissal)
Escape                 ->  overlay closes (unchanged desktop semantics)
```

Two details are deliberate:

- **The panel keeps its desktop anchor as its parent.** The action row carries the panel inside
  `base-action-anchor` (the desktop contract the popover tests pin); to keep the fixed overlay
  renderable the row must not be `display:none` while a panel is open, so `is-panel-open` flattens
  the row's own box and hides its buttons with `visibility:hidden`. Nothing of the row can leak out
  from under the overlay, and no `data-base-action` node is duplicated or moved.
- **The backdrop is toolbar chrome, not an "outside click".** The pre-existing dismissal runs on
  document `mousedown`/`click`; if the backdrop were treated as "outside", removing the backdrop's
  own handler would change nothing observable. The chrome predicate therefore includes
  `[data-base-panel-backdrop]`, which makes the backdrop's handler the load-bearing dismissal and
  keeps the browser negative control meaningful (see §6).

## 4. Safe area and visual viewport

The surface host publishes the safe-area channel with the real `env()` values:

```css
#base-host {
  --base-safe-area-top: env(safe-area-inset-top, 0px);   /* …right / bottom / left */
}
```

and the mobile block consumes it (`max(12px, var(--base-safe-area-left, 0px))` on the tool row,
`max(14px, …)` / `max(8px, …)` inside the overlay, `max(12px, …)` around the menu). The channel
exists so the inset is *one* value per surface instead of five ad-hoc `env()` calls, and so a test
can override it and observe the overlay follow — headless Chromium cannot emulate a real notch.

`mobile-viewport.js` observes `window.visualViewport` (`resize` + `scroll`, with the layout
viewport as the fallback signal) and publishes the live band as custom properties on the current
tool row; the mobile block sizes the overlay from them:

```css
.base-panel {
  position: fixed; left: 0; right: 0;
  top: var(--base-visual-viewport-offset-top, 0px);
  min-height: min(var(--base-visual-viewport-height, 100dvh), 320px);
  max-height: var(--base-visual-viewport-height, 100dvh);
}
```

Without `visualViewport` the fallback is `innerHeight`, i.e. the previous `100dvh` behaviour: the
panel still opens, it just cannot follow a keyboard. When the metrics change, the toolbar also
scrolls the focused control inside the overlay back into view (`scrollIntoView({block:"nearest"})`,
mobile only in practice because the custom properties are only consumed there).

The overlay is a top-anchored full-width panel, not a bottom sheet (U20 §Q3). It hugs its content
up to a 320px floor and the visual-viewport cap, which is what keeps a tappable backdrop below it;
a panel whose content is taller than the band scrolls inside itself instead.

## 5. Verification map

| behaviour | evidence |
| --- | --- |
| visual-viewport channel (preference, fallback, publish, dedupe, rebuild, destroy) | `test/web-bases-mobile.test.js` (fake windows/events) |
| hamburger disclosure, menu classes, panel mount, backdrop/close dismissal, desktop dismissal unchanged | same file |
| safe-area + visual-viewport consumption and the "desktop rules unchanged" CSS contract | same file |
| full-width overlay geometry, 44px targets, backdrop hit test, computed safe-area padding, `visualViewport` resize behaviour, breakpoint boundary | `scripts/web-regression/bases-mobile.mjs` (6 checks, matrix 127 → 133) |
| desktop parity (tool row, popovers, sort/filter/properties/search/new, resize, URL state) | the existing `bases/parity/*` checks and `web-bases-popovers` / `web-bases-parity-ui` tests, unchanged |

## 6. Measured facts and honest boundaries

- **Measured at 360x800 before the change** (`scratch/web-bases/U26/evidence/base-red-scene.log` and
  the gap probe): no `[data-base-overflow]`, the five actions `29x28` in a wrapped second row, the
  panel `position:absolute` `320px` wide with `padding-left:8px`, no backdrop node, no
  `--base-visual-viewport-*` property at all. All six new checks fail on that tree.
- **Negative controls.** Removing the backdrop's own handler turns exactly one check red
  (`a tap on the backdrop must dismiss the overlay`). Widening the breakpoint to `1000px` turns
  exactly one check red — the boundary check at 520px — while the desktop parity items stay green
  (they run at 1440px), which is why the boundary probe exists: at the desktop width a stray
  breakpoint is invisible.
- **The soft keyboard cannot be emulated.** No CDP surface in this runtime shrinks the visual
  viewport the way a keyboard does, so the keyboard口径 declared for this cut is the second option
  in the brief: the scene asserts the observable substitute — a real `visualViewport` resize
  (800 → 300) after which the overlay re-anchors, its bottom never passes the visible band, the
  focused search input stays inside that band, and the overlay grows back on restore. The
  "input is never obscured by an actual keyboard" claim remains **unproven** here.
- **`viewport-fit=cover` is still missing.** `env(safe-area-inset-*)` only reports non-zero values
  when the page's viewport meta includes `viewport-fit=cover`; the app ships
  `width=device-width,initial-scale=1` (`app/src/app/pages.js`). The consumption is implemented and
  observable through the channel, but a real iPhone would still read `0px`. That file is outside
  this slice's allowed surface and the same latent gap already affects every existing `env()` use in
  `app/src/app/assets/app.css`, so it is reported (not silently worked around) as the one concrete
  follow-up: add `viewport-fit=cover` to the app viewport meta and re-verify the notch insets on a
  real device.
- The scene runs in the mobile emulation profile (`isMobile`), where `visualViewport.height` tracks
  the emulated device metrics; on a real device the keyboard shrinks the visual viewport *without*
  a layout-viewport resize, which is covered by the same code path (the `visualViewport` `resize`
  listener), but is not exercised by a real keyboard here.
- The overlay covers the whole viewport, including the app's own top bar. That is the design's
  "covers viewport" reading, and the overlay provides three dismissals (header close button,
  backdrop tap, Escape), but it does mean the global drawer toggle is unreachable while a Base panel
  is open on a phone.
