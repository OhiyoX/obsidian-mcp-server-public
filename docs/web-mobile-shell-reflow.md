# Obsidian Web — the mobile shell reflow (issue #371)

Related: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) · [`docs/USER_CONFIGURATION.md`](USER_CONFIGURATION.md)
(the user-facing viewport behaviour) · [`docs/web-explorer-touch-prefetch.md`](web-explorer-touch-prefetch.md)
and [`docs/web-bases-mobile-chrome.md`](web-bases-mobile-chrome.md) (the other mobile slices this
one sits next to) · `scratch/web-bases/reviews/u371-design-response.json` (the seat ruling this
implements) · `scripts/web-regression/mobile-shell.mjs` (the browser scene) ·
`test/web-mobile-shell.test.js` (the Node contract).

## 1. What changed, and why

Three pieces of shell behaviour were inconsistent on a phone and are now frozen here.

**One unconditional chrome band.** The workspace used to render `.document-tab-row` as its first
child with `#sidebar-toggle` inside it, so a workspace with no tab showed an almost empty second
bar with an orphan rail toggle. Since #371 the topbar is the first child and the only band that is
always in the layout, the rail toggle is its rightmost action, and `.document-tab-row` follows it
and is in the layout *only* while the strip has a tab:

- `pages.js` — `#sidebar-toggle` moved into `.topbar-actions` (after `.topbar-view-mode`, before
  the tab row), and the row now holds `#document-tabs` only.
- `frontend/app/features/explorer/document-tab-row.js` (new) — mirrors the committed tab model
  (`tabs.getState().tabs`) onto `.workspace`, and `core/app.js` calls `sync()` at the same three
  seams that reconcile the strip (note open/reload, Base entry, Base restore). `app.css` hides
  `.document-tab-row` unless `.workspace.has-document-tabs` is set, so the row node keeps its DOM
  seam but a welcome workspace — or a Base opened first — keeps a single bar.
- Frozen red lines (U18, unchanged): exactly one `#sidebar-toggle`, it stays in the DOM while the
  rail is collapsed, it never moves into `#context-sidebar`/`.scrim`, and it keeps
  `aria-controls="context-sidebar"` + `aria-pressed` + the `panel-right` glyph.

**One side-pane breakpoint.** The old `@media (max-width:1050px) and (min-width:721px)` band made
the left pane docked while the right rail was a drawer. It is gone: `>720px` is docked on both
sides (the desktop grid), `<=720px` is a drawer on both sides, and the Bases `<=480px` layout stays
feature-local and untouched.

**One drawer at a time.** `frontend/app/features/context/drawer-exclusion.js` (new) owns the mobile
drawer policy: the `<=720px` query, the two class names (`.sidebar-open` / `.context-open`), the
mutual exclusion and the shared scrim. `pane-layout.js` (rail), `sidebar-panels.js` (files/search)
and the topbar hamburger all go through it, so opening one side hands the other side back and the
shell can never carry both drawer classes. The module keeps no state: it toggles the classes on the
shell and publishes an element-scoped `drawer-policy-change` event so the rail controller can
reconcile its own state (`aria-pressed`, tooltip) with the real DOM instead of keeping a stale copy.
Desktop stays exactly as it was: `.sidebar-hidden` and the `obsidian-web.context-open` preference
are only read/written above the breakpoint.

**Both docked panes remember their visibility (#420).** Above the breakpoint each pane's docked
class (`.sidebar-hidden` / `.context-hidden`) is mirrored by a scalar preference of the same shape:
`obsidian-web.explorer-open` for the files/search pane
(`frontend/app/features/explorer/sidebar-panels.js`) and `obsidian-web.context-open` for the rail
(`frontend/app/features/context/pane-layout.js`). Only the exact string `"false"` means collapsed,
the write happens only above the breakpoint, and each pane has exactly one writer (that module's
`setOpen`), so the docked class, the toggle's pressed mirror and the preference can never drift
apart. A phone drawer is a temporary viewport state and never rewrites the docked choice; leaving
drawer mode restores the remembered one.

**Symmetric pane headers.** Both side panes now expose the same header shape — the view switcher
plus exactly one pane-level close — so neither pane is the one without an in-pane exit:

| | switcher slot | close slot | action slot |
| --- | --- | --- | --- |
| left (`.sidebar-head`) | `.sidebar-tabs` (`data-pane-slot="switch"`) | `#panel-close` (`data-pane-slot="close"`, ✕) | `.panel-head` (`data-pane-slot="actions"`) |
| right (`.context-view-header`) | `.context-view-switcher` (`data-pane-slot="switch"`) | `#context-drawer-close` (`data-pane-slot="close"`, ✕) | `.context-panel-head` (`data-pane-slot="actions"`) |

`#panel-close` was a *pane* control parked in the Files panel head; it moved to the pane header,
which also gives the search panel the close it never had. `#context-drawer-close` is a client of
the single rail state in `pane-layout` (it calls the same `setOpen`), never a second owner.

**One owner of the top inset.** The shared `--pane-header-height` token no longer contains
`env(safe-area-inset-top)`. The mobile block republishes the inset as `--app-inset-top`, the topbar
(the topmost band) consumes it once, and when a drawer covers the topbar the drawer takes it over
while the covered topbar gives it back. That also makes the contract measurable on a viewport
without a notch: the browser scene injects a non-zero `--app-inset-top` and asserts that exactly one
band reacts to it.

**The no-note rail explains itself.** With no document the outline pane (and the runtime empty state
in `features/context/outline.js`) says 「打开笔记后显示大纲与反链」 instead of the shorter
outline-only wording. The rail toggle is *not* disabled — it stays a real entry, per the frozen
option A.

## 2. What deliberately did not change

- The `<=480px` Bases chrome (`features/bases/styles.js`) belongs to #337 and is untouched.
- Desktop docked behaviour, the pane resizers and the document tab model/persistence are unchanged
  (both docked panes now remember their visibility the same way — see the #420 paragraph above);
  the ⋮ menu's secondary `#outline-toggle` entry was removed by #398, so the topbar
  `#sidebar-toggle` is the only layout-layer rail entry.
- **The document tab strip is the Markdown note history.** `features/tabs` only ever holds Markdown
  notes: a non-note document (`documentKind === "base"`) never enters the tab model and leaves
  `activeIndex === -1`, so an empty strip (no `.has-document-tabs`) is the intended state for a
  welcome workspace or a Base opened first — not a missing tab. The Bases flow keeps that model
  unchanged: a Base first-open has no tabs, so the row stays hidden; switching from notes to a Base
  keeps the (inactive) note tabs, so the row stays.
- No second scrim, no new dependency, no production file watcher.

## 3. Verification

- `cd app && npm run check` (syntax + architecture incl. the 500-line budget).
- `cd app && npm test` — `test/web-mobile-shell.test.js` pins the drawer policy, the row mirror,
  the pane-slot symmetry and the safe-area contract; the U14/U18 frozen files were migrated
  (`document-tabs-shell`, `web-right-rail-topbar`, `web-doc-header-parity`,
  `web-left-sidebar-panels`, `web-bases-outline-residue`).
- `cd app && npm run build:web` then `node scripts/web-regression.mjs` — the new scene
  `mobile-shell.mjs` adds seven checks (welcome single bar, no-note rail, tab row on note, drawer
  exclusion + shared scrim, pane-header symmetry, single top-inset owner, desktop docked contrast)
  on its own 390x844-coarse and 1440x1000 contexts; its trace lands in
  `<outputRoot>/mobile-shell-trace.json`.
- The four render-parity gates (`phase0`, `phase1-theme`, `phase1-geometry`, `phase1-mobile`).

## 4. Known limits

- A pointer tap on the topbar is intercepted by the open drawer's scrim (by design: the scrim owns
  "tap outside" and closes the current drawer), so the mutual exclusion is exercised through the
  keyboard activation path in the browser scene and through the controller unit tests.
- `frontend/app/ui/pane.js` still disables the pane resizers at `<=1050px`; above the breakpoint the
  panes are docked between 721 and 1050px, so the resizers stay inert there (pre-existing for the
  left pane, new for the right rail). Left as a follow-up rather than widening this slice's surface.
- Real-device notch behaviour cannot be observed in a headless Chromium (`env()` resolves to 0);
  the contract is pinned by the injectable inset channel plus the static CSS assertions.
