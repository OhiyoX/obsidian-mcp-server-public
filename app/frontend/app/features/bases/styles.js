// Desktop Bases parity stylesheet for the read-only Base surface.
//
// Shipped as a class contract string: the wiring layer (B4) injects it, tests
// assert structure only. Only existing app tokens are used; no new colors are
// invented and no source asset other than the shared icon sprite is touched.

import { BASE_PANEL_CSS } from "./styles-panels.js";
export const BASE_SURFACE_CSS = [
  // Shell: the document area owns the height. `#base-host` fills `.document`
  // absolutely (like `.editor`/`.preview`), so the Base surface can never grow
  // the page; the remaining height is handed to the table scroller below.
  "#base-host{position:absolute;inset:0;min-height:0;box-sizing:border-box;}",
  "#base-host[hidden]{display:none;}",
  "#base-host:not([hidden]){display:flex;flex-direction:column;}",
  // Document-level horizontal inset is carried by the toolbar and the first/last
  // cell padding so row hover spans the full content width, like the desktop Bases.
  ".base-surface{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;box-sizing:border-box;padding:12px 0 24px;color:var(--text-normal,var(--text));}",
  // Tool row: view glyph + view selector + sort indicator + result count, with the
  // action row (sort/filter/properties/search/new) pushed to the right edge.
  ".base-surface-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:32px;padding:10px 20px 8px;margin-bottom:4px;}",
  ".base-surface-toolbar-icon{width:16px;height:16px;flex:0 0 16px;color:var(--text-muted);}",
  ".base-view-control{min-width:0;flex:0 1 auto;}",
  ".base-view-control .select-control{border:0;background:transparent;}",
  ".base-view-control .select-control:hover,.base-view-control .select-control.is-open{border:0;background:var(--background-modifier-hover,var(--hover));}",
  ".base-view-control .select-control:focus-within{border:0;box-shadow:none;}",
  ".base-view-control .select-trigger{height:28px;padding:0 4px;gap:6px;font-weight:600;font-size:15px;}",
  // The direction glyph next to the view name is OUR indicator, so the generic
  // select chevron is suppressed inside the Base tool row (never a native look).
  ".base-view-control .select-trigger > svg{display:none;}",
  ".base-view-select{height:30px;padding:0 10px;border:1px solid var(--background-modifier-border,var(--line));border-radius:6px;background:var(--background-primary,var(--panel));color:var(--text-normal,var(--text));font:inherit;font-size:13px;cursor:pointer;}",
  ".base-view-select:focus-visible{outline:2px solid var(--interactive-accent,var(--accent));outline-offset:2px;}",
  ".base-sort-indicator{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px;color:var(--text-muted);}",
  ".base-surface-count{color:var(--text-faint);font-size:12.5px;white-space:nowrap;}",
  ".base-catalog-stale{margin:2px 20px 10px;padding:6px 10px;border-radius:6px;background:var(--background-secondary,var(--background-modifier-border));color:var(--text-muted);font-size:12.5px;}",
  ".base-surface-error{margin:2px 20px 10px;padding:8px 10px;border:1px solid var(--text-error,currentColor);border-radius:6px;color:var(--text-error,var(--text-normal));}",
  ".base-surface-empty,.base-surface-busy{padding:8px 20px;color:var(--text-muted);}",
  // Action row (desktop: 排序 / 筛选 / 属性 / 搜索 / 新建).
  ".base-action-row{position:relative;display:flex;align-items:center;gap:2px;flex:0 0 auto;margin-left:auto;}",
  ".base-action{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--text-muted);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease;}",
  ".base-action:hover{background:var(--background-modifier-hover,var(--hover));color:var(--text-normal,var(--text));}",
  // Desktop active tool button: an OPEN menu paints `--background-modifier-hover`
  // (`.text-icon-button.has-active-menu` asar app.css@262772), and only an open menu on an
  // ACTIVE tool paints `--background-modifier-active-hover` (`.text-icon-button.is-active.has-active-menu`
  // @263133, `.is-active:hover` @263492; token = `color-mix(in oklch, var(--interactive-accent) 10%,
  // transparent)` @96013). A bare `is-active` keeps the accent text only (@261915).
  ".base-action[aria-expanded=\"true\"]{background-color:var(--background-modifier-hover,var(--hover));}",
  ".base-action.base-action-active[aria-expanded=\"true\"],.base-action.base-action-active:hover{background-color:var(--background-modifier-active-hover,color-mix(in oklch,var(--interactive-accent,var(--accent)) 10%,transparent));}",
  // Byte reclaim for this cut's narrow band (see HANDOFF-FIX2.md §5): groups of rules that
  // declared the SAME block at the same specificity are merged into one selector list at the
  // LAST member's position, so no intervening rule starts winning a longhand it did not win
  // before. Every merge below is a pure `selector,selector` join of identical declarations.
  ".base-sort-indicator.base-sort-active,.base-action.base-action-active{color:var(--text-accent,var(--accent));}",
  ".base-action-icon{width:15px;height:15px;flex:0 0 15px;color:inherit;}",
  ".base-action-label{white-space:nowrap;}",
  ...BASE_PANEL_CSS,
  ".base-action:focus-visible,.base-panel-button:focus-visible{outline:2px solid var(--interactive-accent,var(--accent));outline-offset:1px;}",
  ".base-search-input{flex:0 1 220px;}",
  // Table: the table box is the only vertical scroll owner inside the Base document.
  // It flexes into the remaining document height (`min-height:0` is what lets it
  // shrink), so rows overflow into its own scrollbar instead of the page; the
  // horizontal scroll for narrow layouts is preserved and the sticky header stays
  // pinned to the top of this container. `fixed` layout is what makes the
  // drag-resizable column widths authoritative.
  ".base-table-wrap{flex:1 1 auto;min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;}",
  ".base-table{table-layout:fixed;width:100%;min-width:100%;border:0;border-collapse:separate;border-spacing:0;background:transparent;}",
  // No outer frame on the table itself; 1px row separators, faint vertical column
  // rules and a header top rule (desktop Bases keeps a light grid).
  ".base-table th,.base-table td{border:0;border-bottom:1px solid var(--background-modifier-border,var(--line));border-inline-end:1px solid color-mix(in srgb,var(--background-modifier-border,var(--line)) 55%,transparent);padding:10px 16px;text-align:left;vertical-align:middle;white-space:normal;color:var(--text-normal,var(--text));}",
  ".base-table th:last-child,.base-table td:last-child{border-inline-end:0;}",
  ".base-table th:first-child,.base-table td:first-child{padding-left:20px;}",
  ".base-table th:last-child,.base-table td:last-child{padding-right:20px;}",
  // Desktop header geometry: `.bases-thead{position:sticky;height:var(--bases-table-row-height)…}`
  // (asar app.css@488533), `.bases-thead .bases-table-header{height:var(--bases-table-row-height)}`
  // (@488885) and `.bases-td{height:var(--bases-table-row-height)}` (@494332) — the SAME 30px token as
  // the body rows (@58915), so the header is exactly one row band tall. Like the body cells, the
  // block padding has to go: `height` is a minimum on a table cell, so `padding-block:10px` kept the
  // header at 42.25 no matter what height was asked for.
  ".base-table thead th{border-top:1px solid var(--background-modifier-border,var(--line));border-bottom:1px solid var(--background-modifier-border,var(--line));position:sticky;top:0;z-index:1;background:var(--background-primary,var(--panel));color:var(--text-muted);font-weight:500;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:var(--bases-table-row-height,30px);padding-block:0;}",
  ".base-table td{overflow-wrap:anywhere;}",
  // Group headings (lane desktop-re/bases-grouping). The desktop class family is
  // `bases-group-heading`; its 1.14.4 offsets were NOT re-measured on this host (no asar),
  // so the geometry below is our own minimal box and the mismatch is registered in
  // HANDOFF-GROUPING.md as [未证实] rather than claimed as parity. It reuses the table's
  // own tokens (muted label, `--bases-table-row-height` band, hairline) so a grouped
  // table stays in the same visual system as its rows.
  ".base-table .base-group-heading>th{background:var(--background-secondary,var(--background-primary-alt,var(--panel)));color:var(--text-muted);font-weight:600;font-size:12.5px;}",
  ".base-table .base-group-heading>th .bases-group-heading-label{color:var(--text-normal,var(--text));}",
  ".base-table .base-group-heading .base-group-heading-count{margin-inline-start:var(--size-4-1,4px);background-color:var(--flair-background);border-radius:var(--radius-s);color:var(--flair-color);font-size:10px;padding:2px 4px;font-variant-numeric:tabular-nums;}",
  // Desktop row geometry: `.bases-tr{height:var(--bases-table-row-height)}` (asar app.css@494000,
  // token `--bases-table-row-height:30px` @58915) plus `.bases-td{height:var(--bases-table-row-height)}`
  // (@494332) — the 30px lives on the cell BOX, the desktop sets no vertical padding at all. Our
  // `td{padding:10px 16px}` was the whole difference (42–43px rows), so the block padding goes to
  // zero and the line box is centred in the row by the `vertical-align:middle` above.
  ".base-table tbody tr{height:var(--bases-table-row-height,30px);}",
  ".base-table tbody td{padding-block:0;}",
  // The sprite carries `.svg-icon`'s `display:block` (Obsidian app.css), which in a table cell stacks a
  // SECOND block box under the label: measured 56.25 = 20 padding + 2 borders + 20.25 label line + 14
  // icon. The header cell is an inline formatting context (the desktop's is a flex row instead), so the
  // icon has to be inline again for the header to be one line.
  ".base-column-icon{display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;color:var(--text-muted);}",
  ".base-table tbody tr:hover{background:var(--background-modifier-hover,var(--hover));}",
  // Column resize: handle sits on the column boundary, appears on hover/drag.
  ".base-col-resize{position:absolute;top:0;right:-3px;bottom:0;width:7px;display:block;cursor:col-resize;background:transparent;touch-action:none;z-index:2;}",
  ".base-col-resize::after{content:\"\";position:absolute;top:0;bottom:0;left:3px;width:1px;background:var(--interactive-accent,var(--accent));opacity:0;transition:opacity .12s ease;}",
  ".base-table thead th:hover .base-col-resize::after,.base-col-resize[data-dragging=\"true\"]::after{opacity:1;}",
  // Links: plain internal-link look with an always-on underline; no button box.
  ".base-cell-link{appearance:none;margin:0;padding:0;border:0;background:transparent;color:var(--link-color,var(--accent));font:inherit;text-align:left;text-decoration:underline;text-underline-offset:2px;cursor:pointer;}",
  ".base-cell-link:hover{color:var(--accent-hover,var(--link-color,var(--accent)));text-decoration-thickness:2px;}",
  ".base-cell-link:focus-visible{outline:2px solid var(--interactive-accent,var(--accent));outline-offset:2px;border-radius:2px;}",
  // Arrays / tag chips: reuse the desktop tag tokens.
  ".base-cell-array{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;}",
  ".base-cell-chip{display:inline-flex;align-items:center;min-height:21px;padding:1px 7px;border:1px solid color-mix(in srgb,var(--tag-color) 24%,transparent);border-radius:999px;background:var(--tag-bg,var(--tag-background));color:var(--tag-color);font-size:.86em;line-height:1.35;text-decoration:none;}",
  ".base-cell-chip.base-cell-link:hover{text-decoration:underline;}",
  ".base-cell-more{color:var(--text-faint);margin-left:4px;}",
  ".base-cell-object-entry{display:inline-block;margin-right:6px;}",
  // Dates: calendar glyph + `MM / DD / YYYY`, source value kept in datetime.
  ".base-cell-date{display:inline-flex;align-items:center;gap:6px;color:var(--text-normal,var(--text));white-space:nowrap;}",
  ".base-cell-date-icon{width:14px;height:14px;flex:0 0 14px;color:var(--text-muted);}",
  // Footer / controls.
  ".base-surface-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 20px 0;}",
  ".base-surface-footer:empty{display:none;}",
  ".base-load-more,.base-retry{height:30px;padding:0 12px;border:1px solid var(--background-modifier-border,var(--line));border-radius:6px;background:var(--background-primary,var(--panel));color:var(--text-normal,var(--text));font:inherit;font-size:.9em;cursor:pointer;}",
  ".base-panel-button:hover,.base-load-more:hover:not(:disabled),.base-retry:hover{border-color:var(--text-faint);}",
  ".base-panel-button:disabled,.base-load-more:disabled{opacity:.5;cursor:default;}",
  // List + cards (desktop `bases-list-*` / `bases-cards-*`): the same cell codec in
  // different boxes, so the row set never depends on the view type. Both wrappers are
  // the vertical scroller of the Base document, like `.base-table-wrap`.
  ".base-list-wrap,.base-cards-wrap{flex:1 1 auto;min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;}",
  ".bases-list-container{display:flex;flex-direction:column;padding:0 20px;}",
  ".bases-list-item{padding:6px 4px;border-radius:6px;}",
  ".bases-list-item-properties{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;}",
  ".bases-list-item-properties.is-indented{gap:4px;padding-left:16px;}",
  ".bases-list-property{display:inline-flex;align-items:baseline;gap:6px;min-width:0;}",
  ".list-bullet,.list-number{flex:0 0 auto;color:var(--text-faint);font-variant-numeric:tabular-nums;}",
  ".base-cell-empty,.bases-list-separator{color:var(--text-faint);}",
  // Cards: `--base-card-size` is the desktop `cardSize` (the card width); the cover
  // height and its `background-size` are written inline by the view (imageFit /
  // imageAspectRatio), because both come from the view's own options.
  ".bases-cards-container{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--base-card-size,200px),1fr));gap:12px;padding:4px 20px;align-items:start;}",
  ".bases-cards-item{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--background-modifier-border,var(--line));border-radius:8px;background:var(--background-primary,var(--panel));}",
  ".bases-list-item:hover,.bases-cards-item:hover{background:var(--background-modifier-hover,var(--hover));}",
  ".bases-cards-cover{width:100%;flex:0 0 auto;background-position:center;background-repeat:no-repeat;background-color:var(--background-secondary,var(--panel));}",
  ".bases-cards-property{display:flex;align-items:baseline;gap:8px;min-width:0;padding:3px 10px;}",
  ".bases-cards-property.mod-title{padding-top:8px;}",
  ".bases-cards-property.mod-title .bases-cards-label{display:none;}",
  ".bases-cards-label{flex:0 0 auto;color:var(--text-muted);font-size:12px;}",
  ".bases-cards-line{min-width:0;overflow-wrap:anywhere;}",
  // Group headings in list + cards (lane desktop-re/group-headings-list-cards). The desktop
  // factory is `_J.createGroupHeadingEl` (app.js@2499736) = `bases-group-heading mod-collapsible`
  // + `bases-group-property` + `bases-group-value` + `collapse-indicator collapse-icon`; the
  // skin is app.css `.bases-group-heading` @447337 (flex / baseline / gap --size-4-1 / ellipsis),
  // @448504 (property: --font-ui-smaller, --text-muted, display block), @448773 (value:
  // --font-smaller, 600), chevron rotate @448062 / un-rotate @448184, hover-only indicator
  // @448311 + always-on under `(hover:none)` @448423. `mod-collapsible` is also what keeps these
  // rules off the TABLE's heading cell, which carries `bases-group-heading` but not the mod.
  // The desktop holds the folded state in its query controller and persists it
  // (`saveGroupFolds`); this surface folds for the mount only. These headings are NOT sticky:
  // every `position:sticky` in app.css is the table thead (@488569) or the footer (@491293),
  // and the headings themselves are absolute blocks at a measured `top` inside a virtualized
  // list/cards container (@484742 / @475598). Our layouts have no virtualization, so the
  // heading and its group box sit in normal flow.
  ".bases-group-heading.mod-collapsible{display:flex;align-items:baseline;gap:4px;min-width:0;max-width:100%;overflow:hidden;white-space:nowrap;line-height:var(--bases-table-row-height,30px);cursor:var(--cursor,default);padding:4px 0 8px;}",
  ".bases-group-heading .bases-group-property{font-size:var(--font-ui-smaller,12px);font-weight:400;color:var(--text-muted);}",
  ".bases-group-heading .bases-group-value{font-size:var(--font-smaller,.875em);font-weight:600;color:var(--text-normal,var(--text));overflow:hidden;text-overflow:ellipsis;}",
  ".bases-group-heading .collapse-indicator{flex:0 0 auto;align-self:center;padding-inline:2px;color:var(--collapse-icon-color,var(--text-faint));opacity:0;}",
  ".bases-group-heading .collapse-indicator svg{transform:rotate(90deg);}",
  ".bases-group-heading .collapse-indicator.is-collapsed svg{transform:none;}",
  ".bases-group-heading:hover .collapse-indicator{opacity:1;}",
  "@media (hover:none){.bases-group-heading .collapse-indicator{opacity:1;}}",
  // The folded class lives on the GROUP BOX (desktop: list @3185086 / cards @3154320
  // `toggleClass(\"is-collapsed\")` on the group container, cards additionally dropping its
  // padding and border). `display:none` is this surface's way of not painting the rows; the
  // desktop detaches them. The heading stays, which is the whole point of a fold.
  ".bases-list-group.is-collapsed .bases-list-group-list,.bases-cards-group.is-collapsed{display:none;}",
  // Cards: the container is ONE grid when ungrouped, so a grouped list turns it into the
  // desktop's column of (heading, group box) pairs (@3154320 pushes `groupHeadingEl` then
  // `containerEl`) and each group box becomes the grid. `.is-grouped .bases-cards-container
  // .bases-cards-group{padding:0 0 16px;border-bottom:1px}` + heading `padding:4px 0 8px`
  // (app.css@475726 / @475598); the group gap is --size-4-3 (@475905).
  ".bases-cards-container[data-base-group-by]{display:flex;flex-direction:column;gap:0;align-items:stretch;}",
  ".bases-cards-group{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--base-card-size,200px),1fr));gap:12px;align-items:start;padding:0 0 16px;border-bottom:1px solid var(--background-modifier-border,var(--line));}",
  // kanban's own rules are NOT here: the layout ships as an on-demand asset and
  // injects them at runtime (kanban-runtime.js KANBAN_BOARD_CSS), so this stylesheet
  // - which every first screen loads - stays free of a surface that may never open.
  "@media (max-width:720px){.base-surface-toolbar{padding:10px 12px 8px;gap:8px;}",
  // Narrow screens: the action row (not the individual button) becomes the
  // popover's containing block, so a panel anchored to the leftmost action can
  // never overflow the viewport on the left. It spans the row's right edge instead.
  ".base-action-anchor{position:static;}",
  // The narrow band takes the box back from the fixed shell: below the desktop breakpoint the
  // panel is laid out against the action row by the stylesheet alone (`panel-position.js`
  // clears its inline placement here), exactly as .33 left this band.
  ".base-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:7;left:auto;width:min(320px,calc(100vw - 24px));max-height:min(56vh,calc(100vh - 132px));overflow:hidden;padding:8px;border-radius:8px;}",
  ".base-catalog-stale,.base-surface-error{margin-inline:12px;}",
  ".base-surface-empty,.base-surface-busy{padding-inline:12px;}",
  ".base-table th,.base-table td{padding:9px 12px;}",
  ".base-table th:first-child,.base-table td:first-child{padding-left:12px;}",
  ".base-table th:last-child,.base-table td:last-child{padding-right:12px;}",
  ".base-surface-footer{padding:8px 12px 0;}",
  ".base-action-label{display:none;}",
  ".base-action{padding:0 7px;}",
  // Narrow viewports take the app's touch scale, not the desktop 30px one: app.css
  // `@media (max-width:720px)` already gives `.select-trigger` and `.select-option`
  // `min-height:44px`, and the <=480px overlay in this file already paints `.base-action`,
  // the panel header and the close button at 44px. Fighting that (keeping the wrapper at
  // 30px) is what produced the +14px overflow, and pinning the whole popover to 30px
  // would ship a sub-touch-target select to phones. So every control role moves UP to the
  // same 44px the app already uses here — one height inside one popover, at every width.
  ".base-panel .select-control,.base-panel-input,.base-panel-select,.base-panel-button,.base-panel-option{min-height:44px;}",
  // The raw-expression block is the one input that is NOT a one-line control: it keeps its
  // 56px reading height, which the shared `min-height:44px` above would otherwise flatten
  // (same specificity, later in the cascade).
  ".base-panel-textarea{min-height:56px;}}",
  // ---------------------------------------------------------------------------
  // Mobile chrome (issue #337 Cut 2). The hamburger, the panel header (close
  // button) and the backdrop exist in the DOM at every width so the breakpoint is
  // a pure CSS switch — a width change (rotation, split view) repaints without a
  // re-render, and the desktop Base surface paints exactly what it painted before
  // because all three stay `display:none` outside the stylesheet below. The safe
  // area is published as custom properties on the surface host (with the real
  // `env()` values as their defaults) so the overlay can consume it and a test can
  // observe it; `--base-visual-viewport-*` is written at runtime by
  // features/bases/mobile-viewport.js and falls back to `100dvh` (the pre-existing
  // behaviour) when `window.visualViewport` is unavailable.
  "#base-host{--base-safe-area-top:env(safe-area-inset-top,0px);--base-safe-area-right:env(safe-area-inset-right,0px);--base-safe-area-bottom:env(safe-area-inset-bottom,0px);--base-safe-area-left:env(safe-area-inset-left,0px);}",
  ".base-toolbar-overflow{display:none;}",
  ".base-panel-header{display:none;}",
  // P1 page header. The desktop builds it only for a nested page (`pageStack.length > 1`,
  // asar app.js@2371419) and puts a `back-button` (chevron + the page title, @2369195) beside
  // the close control, so a root menu has no header at all: `display:none` above still holds at
  // the root page and at every width, and only `.is-nested` (a second page in the same panel)
  // reveals it. `<=480px` below is the one band that shows the header unconditionally, because
  // the full-bleed overlay needs its close control.
  ".base-panel.is-nested>.base-panel-header{display:flex;align-items:center;padding:var(--size-4-1);}",
  ".base-panel-header-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}",
  ".base-panel-back{display:flex;flex-grow:1;align-items:center;gap:var(--size-4-1);min-width:0;padding:4px;border:0;border-radius:var(--radius-s);background-color:transparent;color:var(--text-normal,var(--text));font:inherit;font-weight:500;font-size:13px;text-align:left;cursor:pointer;}",
  ".base-panel-back:hover{background-color:var(--background-modifier-hover);}",
  ".base-panel-back .base-panel-icon{transform:rotate(180deg);}",
  ".base-panel-close{display:flex;align-items:center;justify-content:center;padding:4px;border:0;background-color:transparent;color:var(--text-muted);cursor:pointer;}",
  ".base-panel-close:hover{color:var(--text-normal,var(--text));}",
  ".base-panel-backdrop{display:none;}",
  "@media (max-width:480px){",
  // Tool row: same left cluster (glyph / view / direction / count), the right-hand
  // action row replaced by the hamburger. Labels come back inside the menu, because
  // the <=720px block above hides them in the row.
  ".base-surface-toolbar{gap:8px;padding:8px max(12px,var(--base-safe-area-right,0px)) 8px max(12px,var(--base-safe-area-left,0px));}",
  ".base-toolbar-overflow{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;flex:0 0 44px;margin-left:auto;padding:0;border:0;border-radius:8px;background:transparent;color:var(--text-muted);cursor:pointer;}",
  ".base-toolbar-overflow:hover,.base-panel-close:hover{background:var(--background-modifier-hover,var(--hover));color:var(--text-normal,var(--text));}",
  ".base-toolbar-overflow[aria-expanded=\"true\"]{background:var(--background-modifier-hover,var(--hover));color:var(--text-accent,var(--accent));}",
  ".base-toolbar-overflow .base-action-icon{width:20px;height:20px;flex:0 0 20px;}",
  // The action row becomes the menu. `is-panel-open` only keeps the subtree
  // renderable — the panel is `position:fixed`, so it must not sit inside a
  // `display:none` ancestor — and flattens the row and hides its buttons so no menu
  // box can leak out from under the full-width overlay.
  ".base-action-row{display:none;}",
  ".base-action-row.is-menu-open,.base-action-row.is-panel-open{position:absolute;top:calc(100% + 6px);left:max(12px,var(--base-safe-area-left,0px));right:max(12px,var(--base-safe-area-right,0px));z-index:7;margin:0;display:block;padding:6px;border:1px solid var(--background-modifier-border,var(--line));border-radius:8px;background:var(--background-primary,var(--panel));box-shadow:0 12px 32px rgb(0 0 0 / 18%);}",
  ".base-action-row.is-panel-open{padding:0;border:0;background:transparent;box-shadow:none;}",
  ".base-action-row.is-panel-open .base-action{visibility:hidden;}",
  ".base-action-anchor{position:static;display:block;}",
  ".base-action{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;height:44px;padding:0 12px;font-size:14px;}",
  ".base-action-label{display:inline;}",
  ".base-action-icon{width:18px;height:18px;flex:0 0 18px;}",
  // Full-width overlay panel (design §Q3: fixed to the viewport, never a bottom
  // sheet, no gesture state machine). `top`/`max-height` follow the *visual*
  // viewport so a keyboard or a pinch never hides the active input; `min-height`
  // keeps it a real overlay instead of a content-sized tooltip, and because it is
  // capped by the same visual-viewport height the backdrop below stays tappable
  // whenever the content is shorter than the screen.
  ".base-panel{position:fixed;left:0;right:0;top:var(--base-visual-viewport-offset-top,0px);width:auto;max-width:none;min-width:0;height:auto;min-height:min(var(--base-visual-viewport-height,100dvh),320px);max-height:var(--base-visual-viewport-height,100dvh);border:0;border-radius:0;padding:max(8px,var(--base-safe-area-top,0px)) max(14px,var(--base-safe-area-right,0px)) max(14px,var(--base-safe-area-bottom,0px)) max(14px,var(--base-safe-area-left,0px));background-color:var(--background-primary,var(--panel));box-shadow:0 18px 44px rgb(0 0 0 / 28%);}",
  ".base-panel-header{display:flex;align-items:center;gap:8px;min-height:44px;margin:0 0 8px;border-bottom:1px solid var(--background-modifier-border,var(--line));}",
  ".base-panel-header-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600;color:var(--text-normal,var(--text));}",
  ".base-panel-close{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;flex:0 0 44px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--text-muted);cursor:pointer;}",
  ".base-toolbar-overflow:focus-visible,.base-panel-close:focus-visible{outline:2px solid var(--interactive-accent,var(--accent));outline-offset:1px;}",
  ".base-panel-close .base-panel-icon{width:18px;height:18px;flex:0 0 18px;}",
  ".base-panel-backdrop{display:block;position:fixed;left:0;right:0;top:var(--base-visual-viewport-offset-top,0px);height:var(--base-visual-viewport-height,100dvh);z-index:6;padding:0;border:0;background:rgb(0 0 0 / 32%);}}",
  // ---------------------------------------------------------------------------
  // Touch table (issue #337 Cut 3). Gate = `(pointer: coarse)`, the *capability*
  // of the primary pointer, not a width: a finger-first device needs these rules
  // on a phone and on a tablet alike, and every desktop check runs a fine pointer
  // (Playwright's default `newPage` has no touch), so the 1440px surface and its
  // `bases/parity/*` items keep the byte-identical rules above.
  //
  //   - `touch-action:pan-x pan-y` — the container already scrolls in both axes
  //     (`overflow:auto`); the declaration is what keeps a *vertical* pan from
  //     being captured by the horizontal scroller (measured: `pan-x` alone stops
  //     vertical delivery, `none` stops both). `auto` also allows both axes, so
  //     the declaration is about never narrowing it back — e.g. the 7px resize
  //     handle carries `touch-action:none`.
  //   - 44px rows: the desktop row is 41.5px at narrow widths (`padding:9px 12px`
  //     + a 21px line), i.e. below the touch target minimum.
  //   - the resize handle is hidden here and never wired (resize.js): a finger on
  //     the boundary would hit a `touch-action:none` element and the drag gesture
  //     would be swallowed. No drag alternative in v1.
  //   - the tap selection is a state a finger can see; the row handler itself is
  //     only bound on a coarse pointer (view.js).
  "@media (pointer: coarse){",
  ".base-table-wrap{touch-action:pan-x pan-y;}",
  ".base-table tbody tr{height:44px;}",
  ".base-table thead th .base-col-resize{display:none;}",
  ".base-table tbody tr[aria-selected=\"true\"]{background:color-mix(in srgb,var(--interactive-accent,var(--accent)) 12%,transparent);box-shadow:inset 2px 0 0 0 var(--interactive-accent,var(--accent));}",
  "}",
].join("");
