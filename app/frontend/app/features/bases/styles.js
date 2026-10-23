// Desktop Bases parity stylesheet for the read-only Base surface.
//
// Shipped as a class contract string: the wiring layer (B4) injects it, tests
// assert structure only. Only existing app tokens are used; no new colors are
// invented and no source asset other than the shared icon sprite is touched.

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
  // Byte reclaim for this cut's narrow band (see HANDOFF-FIX2.md §5): groups of rules that
  // declared the SAME block at the same specificity are merged into one selector list at the
  // LAST member's position, so no intervening rule starts winning a longhand it did not win
  // before. Every merge below is a pure `selector,selector` join of identical declarations.
  ".base-sort-indicator.base-sort-active,.base-action.base-action-active{color:var(--text-accent,var(--accent));}",
  ".base-action-icon{width:15px;height:15px;flex:0 0 15px;color:inherit;}",
  ".base-action-label{white-space:nowrap;}",
  // Action popovers (排序 / 筛选 / 属性 / 搜索 / 新建). Each action button owns an anchor;
  // the panel is absolutely positioned inside it, so opening a menu overlays the
  // table instead of pushing it down, and the tool row never changes height. The
  // header is lifted into its own stacking context so a popover always paints over
  // the sticky table head. Only existing app tokens are used.
  ".base-surface-header{position:relative;z-index:5;}",
  ".base-action-anchor{position:relative;display:inline-flex;align-items:center;}",
  // P0 shell (lane desktop-re/bases-css-port-impl): the panel IS the desktop's
  // `div.menu.bases-toolbar-menu` (asar app.js@2368459), so it takes `.menu`'s own box
  // (asar app.css@282803) plus the `.bases-toolbar-menu` attach block (@455439). No number is
  // re-invented: `--layer-popover` = 30 (@74387), `--radius-m` = 8px (@83110),
  // `--background-secondary` (@78369 via `--menu-background`), `--background-modifier-border-hover`
  // (@78419 via `--menu-border-color`), `--shadow-s` (@78257 via `--menu-shadow`), `--icon-s`
  // = 16px (@72362). Those tokens are DECLARED in `src/app/assets/app.css` (inside the
  // `web-theme-fallback` layer, so a Vault theme that declares them still wins): the first
  // version of this rule instead wrote one-off `var()` fallbacks that resolved differently from
  // the desktop (`#dadada` came out `--color-base-30`; the shadow fallback was the desktop DARK
  // `--shadow-s` under a light `--background-secondary`). Only the two chains whose producer the
  // Web layer does not declare keep a fallback: `--menu-border-width` (this app declares no
  // `--border-width`) and `--menu-border-color` (no `--background-modifier-border-hover`), both
  // carrying the desktop's own resolved value.
  //
  // `--input-height: 28px` is deliberately NOT copied from `.bases-toolbar-menu` (@455439):
  // nothing in this panel consumes it (the controls here are the Web app's 30px
  // `.select-control` skin, pinned by `test/web-bases-panel-tokens.test.js`), and a copied
  // declaration with no consumer is not alignment evidence.
  // The desktop's `backdrop-filter:var(--menu-backdrop-filter)` (= `none`), its `corner-shape`
  // and its `-webkit-app-region` are NOT copied: the first two are no-ops with no token in this
  // app, the third is the desktop window frame's own concern.
  ".base-panel{position:fixed;z-index:var(--layer-popover,30);min-width:220px;max-width:100vw;max-height:100%;overflow:hidden;padding:0;margin:0;display:flex;flex-direction:column;border:var(--menu-border-width,1px) solid var(--menu-border-color,var(--color-base-35));border-radius:var(--menu-radius,var(--radius-m));background-color:var(--menu-background,var(--background-secondary,var(--panel)));box-shadow:var(--menu-shadow,var(--shadow-s));user-select:none;}",
  // P5 width semantics: the FILTER menu keeps the desktop's own width
  // (`--bases-filter-menu-width: 520px`, asar app.css@57465, applied by
  // `.bases-toolbar-menu.bases-toolbar-filter-menu` @455631). `:where()` holds the rule at zero
  // specificity, so the `<=720px` and `<=480px` bands below still own the box when narrow.
  ":where(.base-panel[data-base-panel=\"filter\"]){width:var(--bases-filter-menu-width,520px);}",
  // ---------------------------------------------------------------------------
  // G5 — `.menu-scroll`: the desktop panel's scroll container
  // ---------------------------------------------------------------------------
  // The desktop menu is `div.menu.bases-toolbar-menu` > `div.menu-scroll` (asar
  // app.js@2369180) and the Bases variant makes THAT node the scroller
  // (`.bases-toolbar-menu .menu-scroll{overflow-y:auto;padding:0}`, app.css@455560) while the shell
  // keeps `.menu{overflow:hidden}` (@282803). The previous cut scrolled the shell itself
  // (`overflow:auto` on `.base-panel`), so the panel's own header travelled with the content.
  // The desktop class name is carried alongside ours so a reading can address either selector.
  // The `flex`/`min-height` that make this the shell's only growing child are set on
  // `.base-panel > .base-panel-scroll` below, after the column reset would otherwise flatten it.
  ".base-panel-scroll{display:flex;flex-direction:column;min-height:0;overflow-y:auto;padding:0;}",
  // G6 — `.bases-toolbar-menu-container` (app.css@452892; built by the menu constructor at
  // app.js@2366362 and by the property page at app.js@2506194): the inner column of the menus
  // that really have one. It — NOT the shell — owns `max-width:300px` (the shell is
  // `max-width:100vw`, @455439) and the three local token overrides; `--bases-property-menu-item-radius`
  // is the one the property rows consume (`border-start-start-radius`, @455105).
  ".base-panel-container{--icon-size:var(--icon-s);--icon-stroke:var(--icon-s-stroke-width);--bases-property-menu-item-radius:var(--radius-m);display:flex;flex-direction:column;min-height:0;width:100%;max-width:300px;}",
  // The desktop's `.bases-toolbar-section` wrapper is not a node in this surface (its header
  // row is `.base-panel-section` itself, see P3 below), so that wrapper's own
  // `padding:var(--size-2-1)` = 2px lives on the panel's direct children instead: the shell is
  // `padding:0` like `.menu`, and without this inset every row and control would sit flush
  // against the shell edge. `panel-position.js` still owns where the box lands; the desktop
  // `--bases-filter-menu-width` is adopted above and the reading is in
  // `evidence/readings.json`.
  // The popover is a column flex box so its own `max-height` is a real budget for its
  // body: every child is a full-width block (a native `<select>` and a `<textarea>`
  // are inline-level by default, which is what used to shrink the advanced filter
  // input into the leftover space of the conjunction selector), and the scrollable
  // lists are the only children allowed to shrink. No child may carry a `flex`
  // shorthand: its basis would become a *height* in this container, so the row
  // layouts below scope their `flex` to `.base-panel-row`.
  ".base-panel-row{display:flex;align-items:center;gap:6px;margin:0 0 6px;}",
  ".base-panel-row:last-child{margin-bottom:0;}",
  // Section heading (已显示 / 全部属性 / 当前视图 / 排序依据) with its real count. The
  // heading is the popover's hierarchy: one step brighter than the counts, with the
  // desktop section hairline under it (`.bases-toolbar-menu .bases-toolbar-section:not(:last-child)
  // {border-bottom:var(--border-width) solid var(--background-modifier-border)}`, asar
  // app.css@455428 block) so 当前视图 and 已显示 stop reading as one flat list.
  // FIX-1 F4: the heading row's `gap` is the DESKTOP's own
  // `.bases-toolbar-section-header{gap:var(--size-4-1)}` (asar app.css@455960 = 4px), not this
  // surface's 6px row rhythm — the heading is a desktop component and the desktop wins that
  // argument. `.base-panel-row` / `.base-panel-footer` have no desktop counterpart and keep the
  // 6px rhythm (nail ⑤ of `test/web-bases-panel-tokens.test.js`, which gives way here).
  // ---------------------------------------------------------------------------
  // G7/G8 — the desktop section, its header container and its flair
  // ---------------------------------------------------------------------------
  // G7 wrapper: `.bases-toolbar-menu .bases-toolbar-section{padding:var(--size-2-1)}`
  // (asar app.css@455722; `--size-2-1` = 2px @85969) plus the hairline BETWEEN sections
  // (`:not(:last-child){border-bottom:var(--border-width) solid var(--background-modifier-border)}`,
  // @455797). This layer declares no `--border-width` (its menu border reads the same desktop
  // token through `--menu-border-width`, see the token contract in `web-bases-panel-tokens`), so
  // the desktop's 1px is written out. The wrapper is a real node now: the old `.base-panel-section`
  // WAS the heading row, so the desktop heading box had nowhere to live (gaps.md G7).
  ".base-panel-section{padding:2px;}",
  ".base-panel-section:not(:last-child){border-bottom:1px solid var(--background-modifier-border);}",
  // G7 header: `.bases-toolbar-menu .bases-toolbar-section-header` (asar app.css@455939,
  // built at app.js@2479077). It declares `--font-medium`/`--font-ui-small`, neither of which this
  // layer declares, so the desktop's own resolved 500/13px are written out — the same rule this
  // sheet already follows for other desktop-only tokens. `justify-content:space-between` is gone:
  // the desktop keeps the flair right after the label (@455939 + @456413), not at the far edge.
  ".base-panel-section-header{--flair-background:var(--background-modifier-hover);--flair-color:var(--text-muted);display:flex;align-items:center;padding:var(--size-4-2) var(--size-4-3);color:var(--text-normal,var(--text));font-weight:500;font-size:13px;gap:var(--size-4-1);}",
  ".base-panel-section-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}",
  // G8: the count IS the desktop `.flair`. The filter menu's section headers each create one
  // (`e.createSpan({cls:"flair"})`, asar app.js@2479449 / @2479951) and fill it with the real
  // number of active filters (`setText(String(t))`, @2480093) — so a bare number was the wrong
  // shape. `.flair`'s own box is app.css@253669; the Bases override `margin-inline-start`
  // (@456413, `--size-4-1` = 4px) is what puts it 4px after the label. `--size-2-1`/`--size-2-2`
  // (2px/4px, @85969/@85988) are not declared here, so those two paddings are literal, and
  // `font-variant-numeric:tabular-nums` is the one declaration this count already carried.
  ".base-panel-section-header .flair{background-color:var(--flair-background);border-radius:var(--radius-s);color:var(--flair-color);font-size:10px;letter-spacing:.05em;margin-inline-start:var(--size-4-1);padding:2px 4px;position:relative;text-transform:uppercase;white-space:nowrap;vertical-align:middle;font-variant-numeric:tabular-nums;}",
  ".base-panel-count{flex:0 0 auto;}",
  // The section's own content column (desktop `div.bases-toolbar-section-content`, app.js@2479077).
  ".base-panel-section-content{display:flex;flex-direction:column;min-height:0;}",
  // Static conjunction line of the filter popover (the frozen contract is AND only).
  ".base-panel-hint{margin:0 0 6px;color:var(--text-muted);font-size:12.5px;}",
  // Footer: the rows' 6px rhythm plus the hairline before the group actions. The
  // actions are a COLUMN of full-width rows, which is the desktop shape
  // (`.bases-toolbar-menu-actions{display:flex;flex-direction:column;padding:var(--size-4-1)}`,
  // asar app.css@459374, with `.text-icon-button{width:100%}` for 添加筛选器 @459252) —
  // not two equal-width boxes stretched across one line.
  ".base-panel-footer{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:6px 0 0;padding-top:6px;border-top:1px solid var(--background-modifier-border,var(--line));}",
  ".base-panel-search{margin:0 0 6px;}",
  ".base-panel-icon-button{justify-content:center;flex:0 0 30px;padding:0;}",
  // The `</>` simple/advanced switch: an icon control on the `当前视图` heading row
  // (desktop keeps it in `.bases-toolbar-menu-container-header` next to the menu
  // title), so it must not grow the heading row into a button bar.
  // The simple/advanced switch — the desktop's own row-action icon control
  // (`l.createDiv("filter-row-actions")` then `h.createEl("button",{cls:"clickable-icon
  // filer-expression-mode-toggle"})`, asar app.js@2468679/@2468775; `.clickable-icon` box
  // app.css@258658, hover @259149). Two notes: (1) the section header is NOT its home — the
  // desktop header there carries only the collapse icon, the label and the flair (@2479077);
  // (2) it is scoped to the action row on purpose, because the shared 30px control skin below is
  // a ONE-class rule and a one-class `.base-panel-mode` lost its `border`/`background` to it —
  // that is exactly how the switch ended up wearing the input frame the owner photographed
  // (`.base-panel-button` matches the skin at equal specificity, later in the cascade).
  // `--clickable-icon-radius`/`--size-2-2`/`--size-2-3` are not declared in this layer, so the
  // desktop's 4px/6px padding is written out over this surface's own `--radius-s`.
  ".base-panel-actions{display:flex;align-items:center;padding-top:4px;}",
  ".base-panel-actions .base-panel-mode{flex:0 0 auto;margin-inline-start:auto;height:auto;padding:4px 6px;border:0;border-radius:var(--radius-s);background:transparent;color:var(--text-muted);}",
  ".base-panel-actions .base-panel-mode:hover{background:var(--background-modifier-hover,var(--hover));color:var(--text-normal);}",
  ".base-panel-actions .base-panel-mode[data-filter-mode=\"advanced\"]{color:var(--text-accent,var(--accent));}",
  // The grow intent lives on the generated `.select-control` wrapper, which is the node
  // that is really laid out; the native `<select>` it wraps is the 1px `.select-native`,
  // so a `flex` on the select was dead. The conjunction selector is a direct child of the
  // panel, so the column layout already stretches it to the full width.
  // Option rows: the app's `.select-option` skin (min-height 30, radius 4).
  // P2 menu item: the desktop `.bases-toolbar-menu-item` (asar app.css@466792) — one item
  // class for the rows a menu really lists. `padding-inline-start` is the wider side, as in
  // the desktop declaration pair.
  ".base-panel-option{display:flex;align-items:center;gap:var(--size-4-2);min-height:30px;width:100%;padding:4px 4px;padding-inline-start:6px;border-radius:var(--radius-s);color:var(--text-normal,var(--text));font-size:13px;cursor:pointer;}",
  ".base-panel-option:hover{background:var(--background-modifier-hover,var(--hover));}",
  // The row is a `<label>`: keyboard focus lands on the checkbox, so the row needs
  // the focus twin of its hover face or the option list has no visible focus at all.
  ".base-panel-option:focus-within{background:var(--background-modifier-hover,var(--hover));}",
  // FIX-1 F7: the desktop overrides the property menu row's START corners with its own token
  // (`border-start-start-radius`/`border-end-start-radius: var(--bases-property-menu-item-radius)`,
  // asar app.css@455105; `--bases-property-menu-item-radius: var(--radius-m)` @453001 = 8px).
  // Only the properties menu gets it — every other panel keeps the 4px `--radius-s` option row.
  // Logical longhands, exactly as the desktop writes them (and not a second `border-radius`
  // number, so nail ① of `test/web-bases-panel-tokens.test.js` still reads one scale).
  ".base-panel[data-base-panel=\"properties\"] .base-panel-option{border-start-start-radius:var(--bases-property-menu-item-radius,var(--radius-m));border-end-start-radius:var(--bases-property-menu-item-radius,var(--radius-m));}",
  ".base-panel-option-label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}",
  // Read-only formula source of a computed property: real information, but a second
  // full-size label made the row read as one long run of text. Muted monospace, on
  // its own shrinkable slot, one line.
  ".base-panel-formula-source{flex:1 1 auto;color:var(--text-faint);font-family:var(--font-monospace,monospace);font-size:11.5px;}",
  ".base-panel-check{height:15px;flex:0 0 15px;margin:0;}",
  ".base-panel-icon{width:13px;height:13px;flex:0 0 13px;color:currentColor;}",
  // FIX-1 F6: the close control must be a 24x24 hit target. The desktop's icon size in these
  // headers is `--icon-s` = 16px (asar app.css@72362) and this button carries `padding:4px`, so
  // 16+4+4 = 24 — the 13px glyph left a 21x21 target. The `<=480px` overlay band re-sizes the
  // same glyph at 18px and still wins (it is later in this sheet).
  ".base-panel-close .base-panel-icon{width:var(--icon-s);height:var(--icon-s);flex:0 0 var(--icon-s);}",
  // ONE control skin: input, button and (fallback) select share one declaration block.
  // `user-select:text` keeps the shell's desktop `user-select:none` from reaching a real text
  // field (a menu has none, this panel has three roles of them).
  ".base-panel-input,.base-panel-select,.base-panel-button{height:30px;min-width:0;padding:0 8px;border:1px solid var(--control-border);border-radius:6px;background:var(--control-bg);color:var(--text-normal,var(--text));font:inherit;font-size:13px;user-select:text;}",
  // P5 search field: the desktop container's own skin (asar app.css@453150/@453414) — the input
  // itself is transparent with no box and the hairline lives under it. It has to sit AFTER the
  // shared control skin above: both are one-class selectors, so source order is what decides, and
  // the first placement of this rule was dead (real-Chromium reading: border-width 1px). The 6px
  // bottom rhythm from `.base-panel-search` above stays.
  ".base-search-input,.base-panel-search{border:0;border-radius:0;box-shadow:none;background-color:transparent;margin-top:4px;padding-bottom:2px;border-bottom:1px solid var(--background-modifier-border,var(--line));}",
  ".base-panel-input{flex:1 1 90px;}",
  // The laid-out select is the generated `.select-control`: 28px trigger + 1px borders.
  ".base-panel .select-control{height:30px;}",
  // `min-height:0` is load-bearing, not decoration: app.css `@media (max-width:720px)`
  // hands `.select-trigger` a 44px touch `min-height`, and `min-height` beats `height`
  // whichever comes later in the cascade. Without this reset a narrow viewport paints a
  // 44px trigger inside a 30px wrapper (+14px, the 「不协调」 regression the review of
  // `641ba056` found). The wrapper is the visible box at every width, the trigger only
  // ever fills its content box.
  ".base-panel .select-trigger{height:100%;min-height:0;}", 
  // The row `flex` above is a *width* only inside `.base-panel-row`; in the popover's own
  // column layout it would be a height, so every direct child of the panel resets it.
  // ORDER MATTERS: this reset must stay after `.base-panel-input` (it wins on source
  // order, both are one class) and before `.base-panel-list` (which grows back into the
  // popover's leftover budget) — `test/web-bases-panel-layout.test.js` pins the order.
  ".base-panel > *,.base-panel-scroll > *,.base-panel-container > *{flex:0 0 auto;margin-inline:2px;}",
  // G7: the section and its content are column flex boxes too, but their children carry the
  // DESKTOP's own 2px inset (`--size-2-1`, the section's padding above) instead of the margin
  // the sectionless panels use, so a heading row lands at 2+12 = 14px from the panel edge —
  // which is what the desktop's `.bases-toolbar-section{padding:2px}` + header `padding:8px 12px`
  // add up to as well.
  ".base-panel-section > *,.base-panel-section-content > *{flex:0 0 auto;}",
  ".base-panel-list{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;max-height:260px;overflow:auto;}",
  // G5: the scroll node is the shell's only growing child. It is written as a two-class
  // selector so it wins over the column reset above on specificity, not on source order — the
  // reset sits at the position `web-bases-panel-layout` pins (input < reset < list).
  ".base-panel > .base-panel-scroll{flex:1 1 auto;}",
  // The two panels that have no section node (search / new) keep the section's own 2px inset
  // on the scroller, so their single row is not flush against the panel edge.
  ".base-panel[data-base-panel=\"search\"] .base-panel-scroll,.base-panel[data-base-panel=\"new\"] .base-panel-scroll{padding:2px;}",
  // ---------------------------------------------------------------------------
  // G9/G10 — the desktop item's state classes and its second-level elements
  // ---------------------------------------------------------------------------
  // G9, destructive action: `.bases-toolbar-menu-item.mod-destructive{color:var(--text-error)}`
  // (asar app.css@467177), set from the action's own flag
  // (`n.rowEl.toggleClass("mod-destructive",e.destructive)`, app.js@2523902). The desktop's
  // carrier is the action ROW; here the row's real control is the remove button, so the class
  // lands on that control (HANDOFF §G9). `--text-error` is not declared in this layer, so the
  // same `currentColor` fallback the surface's error box already uses is kept.
  ".base-panel-button.mod-destructive{color:var(--text-error,currentColor);}",
  // G9, hidden item: `.bases-toolbar-menu-item.mod-hidden` (@467406) + its name override
  // (@467509), set for a property the view does not show (`t.toggleClass("mod-hidden",!v)`,
  // asar app.js@2490299). This is the condition's real carrier — the visibility checkbox is
  // exactly the `d.contains(l)` set the desktop reads.
  ".base-panel-option.mod-hidden{--icon-color:var(--text-faint);color:var(--text-faint);}",
  ".base-panel-option.mod-hidden .base-panel-item-name{--link-color:var(--text-faint);--link-color-hover:var(--text-muted);--link-unresolved-color:var(--text-faint);}",
  // G9, disabled item: `.bases-toolbar-menu-item.is-disabled` (@467250; set from `!!e.error`,
  // asar app.js@2512259). Here the row carries it exactly when its own control is disabled.
  ".base-panel-option.is-disabled{--icon-color:var(--text-faint);color:var(--text-faint);cursor:default;background-color:transparent;}",
  // G10, the item's second level: `.bases-toolbar-menu-item .bases-toolbar-menu-item-info`
  // (asar app.css@468482; built at app.js@2488830), `-info-icon` (@469227/@469406) and the
  // trailing action slot (@469509). The info box grows and clips, so the name ellipsises inside
  // it and the action slot stays at the row end; `gap` is the desktop `--size-4-2` = 8px, which
  // this layer DOES declare.
  ".base-panel-item-info{display:flex;align-items:center;gap:var(--size-4-2);font-size:13px;flex-grow:1;overflow:hidden;}",
  ".base-panel-item-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}",
  ".base-panel-item-info-icon{cursor:pointer;display:flex;align-items:center;user-select:none;}",
  ".base-panel-item-info-icon::before{content:\"\\200B\";width:0;}",
  ".base-panel-action-icon{color:var(--text-muted);display:flex;align-items:center;justify-content:center;}",
  // Fixed 56px block, no resize grip (the popover's own budget is a `max-height`).
  ".base-panel-textarea{height:auto;min-height:56px;resize:none;font-family:var(--font-monospace,monospace);font-size:12.5px;line-height:1.45;}",
  // A footer action is a menu row: full width (the column above stretches it) and
  // left-aligned icon + label, like the desktop `.bases-toolbar-menu-item`
  // (asar app.css@466779). Scoped to the footer so the icon buttons elsewhere keep
  // their centred face.
  ".base-panel-footer .base-panel-button{justify-content:flex-start;text-align:left;}",
  ".base-panel-button{display:inline-flex;align-items:center;gap:6px;padding:0 10px;cursor:pointer;}",
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
  ".base-table thead th{border-top:1px solid var(--background-modifier-border,var(--line));border-bottom:1px solid var(--background-modifier-border,var(--line));position:sticky;top:0;z-index:1;background:var(--background-primary,var(--panel));color:var(--text-muted);font-weight:500;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".base-table td{overflow-wrap:anywhere;}",
  ".base-column-icon{width:14px;height:14px;vertical-align:-2px;margin-right:6px;color:var(--text-muted);}",
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
