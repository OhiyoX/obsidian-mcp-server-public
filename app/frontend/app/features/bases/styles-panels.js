// Panel family of the Base parity stylesheet (the desktop `.bases-toolbar-menu` chrome).
//
// Split out of styles.js by lane desktop-re/all-views-section: that module sat at 497/500
// lines, and the U12 slice (所有视图 section + read-only condition rows) needs room in it.
// This is a PURE MOVE: the array is spread back at the exact position it was cut from in
// styles.js, so `.join("")` concatenates the same strings in the same order and the shipped
// stylesheet stays byte-identical (pinned by test/web-bases-style-split.test.js).

export const BASE_PANEL_CSS = [
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
  // @455818). This layer declares no `--border-width` (its menu border reads the same desktop
  // token through `--menu-border-width`, see the token contract in `web-bases-panel-tokens`), so
  // the desktop's 1px is written out. The wrapper is a real node now: the old `.base-panel-section`
  // WAS the heading row, so the desktop heading box had nowhere to live (gaps.md G7).
  ".base-panel-section{padding:2px;}",
  ".base-panel-section:not(:last-child){border-bottom:1px solid var(--background-modifier-border);}",
  // G7 header: `.bases-toolbar-menu .bases-toolbar-section-header` (asar app.css@455939,
  // built at app.js@2479145). It declares `--font-medium`/`--font-ui-small`, neither of which this
  // layer declares, so the desktop's own resolved 500/13px are written out — the same rule this
  // sheet already follows for other desktop-only tokens. `justify-content:space-between` is gone:
  // the desktop keeps the flair right after the label (@455939 + @456413), not at the far edge.
  ".base-panel-section-header{--flair-background:var(--background-modifier-hover);--flair-color:var(--text-muted);display:flex;align-items:center;padding:var(--size-4-2) var(--size-4-3);color:var(--text-normal,var(--text));font-weight:500;font-size:13px;gap:var(--size-4-1);}",
  ".base-panel-section-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}",
  // G8: the count IS the desktop `.flair`. The filter menu's section headers each create one
  // (`e.createSpan({cls:"flair"})`, asar app.js@2479449 / @2479951) and fill it with the real
  // number of active filters (`setText(String(t))`, `e.toggle(t>0)`: app.js@2480449/@2480472,
  // called from @2480522) — so a bare number was the wrong
  // shape. `.flair`'s own box is app.css@253669; the Bases override `margin-inline-start`
  // (@456413, `--size-4-1` = 4px) is what puts it 4px after the label. `--size-2-1`/`--size-2-2`
  // (2px/4px, @85969/@85988) are not declared here, so those two paddings are literal, and
  // `font-variant-numeric:tabular-nums` is the one declaration this count already carried.
  ".base-panel-section-header .flair{background-color:var(--flair-background);border-radius:var(--radius-s);color:var(--flair-color);font-size:10px;letter-spacing:.05em;margin-inline-start:var(--size-4-1);padding:2px 4px;position:relative;text-transform:uppercase;white-space:nowrap;vertical-align:middle;font-variant-numeric:tabular-nums;}",
  ".base-panel-count{flex:0 0 auto;}",
  // The section's own content column (desktop `div.bases-toolbar-section-content`, app.js@2479465).
  ".base-panel-section-content{display:flex;flex-direction:column;min-height:0;}",
  // P5 — the conjunction line and its control (lane desktop-re/bases-menu-surface): the desktop
  // builds `filter-group-header` > `select.conjunction.dropdown` (asar app.js@2464509/@2464602)
  // and `@471459` makes that header a ROW. The row is load-bearing — in the section's column box
  // the select was an `align-self:stretch` item and painted as a full-width form field. Control
  // skin: `background-color:transparent;box-shadow:none;text-align:start;font-size:13px`
  // (@471630), hover @471841, focus ring @248624. Our visible box is the generated
  // `.select-control` wrapper (the native select is the 1px `.select-native`); the app already
  // strips that wrapper for its own inline select (app.css@41168).
  // `padding-bottom` is @471459's `var(--size-2-1)`; that token is undeclared here (it would
  // compute to 0px against the desktop's 2px, @85969), so the resolved value is written out.
  ".base-panel-group-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:2px;}",
  ".base-panel-group-header .select-control{border:0;background-color:transparent;}",
  ".base-panel-group-header .select-control:hover{background-color:var(--background-modifier-hover,var(--hover));}",
  ".base-panel-group-header .select-control:focus-within{border:0;background-color:transparent;box-shadow:0 0 0 3px var(--background-modifier-border-focus,var(--background-modifier-border,var(--line)));}",
  ".base-panel-group-header .select-trigger{font-size:13px;text-align:start;}",
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
  // P5 filter menu, lane desktop-re/bases-menu-surface. The add/clear actions are the desktop's
  // menu action rows, not framed buttons: `.menu-item` (asar app.css@283971 — gap
  // `var(--size-4-2)`, padding `var(--size-4-1) var(--size-4-2)`, `--radius-s`, 13px).
  // U12 review fix: @284660 is NOT `.menu-item:hover`; on the 1.14.4 baseline it is
  // `.menu-item:not(.is-label):not(.is-disabled).mobile-tap, …:not(…).selected{background-color:
  // var(--background-modifier-hover)}` — same VALUE, different selector family, which is why the
  // hover rule below still matches the desktop's own `--background-modifier-hover` but not that
  // selector. 16px `.menu-item-icon`=`var(--icon-s)` (@257785), disabled @284586.
  // `:not(.base-panel-mode)` keeps the `</>` on its own `.clickable-icon` box.
  ".base-panel-actions .base-panel-button:not(.base-panel-mode){display:flex;align-items:center;gap:var(--size-4-2);height:auto;padding:var(--size-4-1) var(--size-4-2);border:0;border-radius:var(--radius-s);background-color:transparent;color:var(--text-normal,var(--text));font-size:13px;white-space:nowrap;}",
  ".base-panel-actions .base-panel-button:not(.base-panel-mode):hover{background-color:var(--background-modifier-hover,var(--hover));}",
  ".base-panel-actions .base-panel-button:not(.base-panel-mode) .base-panel-icon{width:var(--icon-s);height:var(--icon-s);flex:0 0 var(--icon-s);}",
  ".base-panel-actions .base-panel-button.is-disabled{cursor:default;color:var(--text-faint);}",
  // Action row box: the desktop group action row, `@471185 … .filter-group-actions{padding-top:
  // var(--size-2-2);display:flex}` — `--size-2-2` is undeclared here too, so 4px is written out.
  ".base-panel-actions{display:flex;align-items:center;padding-top:4px;}",
  ".base-panel-actions .base-panel-mode{flex:0 0 auto;height:auto;padding:4px 6px;border:0;border-radius:var(--radius-s);background:transparent;color:var(--text-muted);}",
  // The `</>` stays a ROW control (hover face, then the advanced-mode accent). Desktop home: the
  // END of a condition row — @474298 `.filter-expression .filter-row-actions{display:flex;
  // padding:var(--size-2-1);margin-inline-start:auto;height:var(--input-height)}`, built at
  // app.js@2468679/@2468775. This build's raw-expression mode is PANEL-wide, so it lives in the
  // panel action row instead, where nothing fills the line — keeping the auto margin there pinned
  // it to the panel edge (the stray control in the owner's shot). Registered deviation, §3.
  ".base-panel-actions .base-panel-mode:hover{background:var(--background-modifier-hover,var(--hover));color:var(--text-normal);}",
  ".base-panel-actions .base-panel-mode[data-filter-mode=\"advanced\"]{color:var(--text-accent,var(--accent));}",
  // ---------------------------------------------------------------------------
  // SORT menu (lane desktop-re/panel-sort), every number re-measured on 1.14.4
  // ---------------------------------------------------------------------------
  // D4 — `--input-height:28px` is the menu's own token
  // (`.bases-toolbar-menu{--input-height:28px;z-index;min-width:220px;max-width:100vw}`,
  // asar app.css@455463). It is declared on the SHELL like the desktop does, but the
  // shared 30px control skin keeps its fallback, so only the menu that was measured in
  // this slice (sort) moves; the filter/properties menus keep 30px until their own
  // measurement lands.
  ".base-panel[data-base-panel=\"sort\"]{--input-height:28px;}",
  ".base-panel[data-base-panel=\"sort\"] .select-control{height:var(--input-height,30px);}",
  // D3 — ONE frame, two segments: `.base-toolbar-sort-item{--metadata-divider-width:0px;
  // --metadata-property-background:var(--interactive-normal);display:flex;align-items:center;
  // gap:var(--size-4-1);border-radius:var(--radius-s);background-color:var(--menu-background)}`
  // (app.css@461837; it is the row the sort menu builds at app.js@2481117), with
  //   * `.dropdown .combobox-button{box-shadow:none;border-radius:0;
  //     background-color:var(--background-modifier-form-field)}` (@462364) for both
  //     segments — the property segment is the `metadata-property` wrapper on
  //     `--interactive-normal` (@383187 + the row's own token override),
  //   * `.bases-sort-direction{min-width:5.25em;border-left:1px solid
  //     var(--background-modifier-border);padding-inline-start:var(--size-2-3)}` (@458358).
  // `--size-2-3` (6px) is not declared in this layer, so the desktop's resolved value is
  // the fallback; `--border-width` (1px) is written out, as this sheet already does.
  ".base-toolbar-sort-item{display:flex;align-items:center;gap:var(--size-4-1);margin:0 0 6px;border-radius:var(--radius-s);background-color:var(--menu-background,var(--background-secondary,var(--panel)));}",
  ".base-toolbar-sort-item:last-child{margin-bottom:0;}",
  // The empty-state line of the grouping page (no rule yet). It is body text in the menu,
  // not a control: muted, same inset as a row, so the `添加分组` action stays the only
  // thing that looks pressable.
  ".base-panel-empty{color:var(--text-muted);font-size:13px;line-height:1.45;padding:var(--size-4-1) var(--size-4-2,8px);}",
  ".base-toolbar-sort-item>.select-control{flex:1 1 auto;max-width:14em;border:0;border-radius:0;background-color:var(--interactive-normal,var(--control-bg));}",
  ".base-toolbar-sort-item>.select-control:last-of-type{flex:0 0 auto;min-width:5.25em;max-width:none;border-left:1px solid var(--background-modifier-border);padding-inline-start:var(--size-2-3,6px);background-color:var(--background-modifier-form-field,var(--control-bg));}",
  // The grouping rule's direction segment is wider than the sort one because its two
  // labels are longer (`从旧到新` / `从新到旧`), the same widget table the desktop reuses
  // for `groupBy.direction`.
  ".base-toolbar-group-item>.select-control:last-of-type{min-width:6.5em;}",
  // D2 — the grip handle: `.bases-toolbar-items .grip-handle{display:flex;align-items:center;
  // align-self:center;color:var(--text-faint);cursor:grab}` with `:hover{color:var(--text-muted)}`
  // and `:active{cursor:grabbing}` (asar app.css@453866 family). The desktop paints the glyph
  // through `.grip-handle circle{fill:var(--text-faint)}`/`:hover circle{fill:var(--text-muted)}`;
  // this app's `.svg-icon` sets `fill:none;stroke:currentColor`, so the same two colours are
  // read once through `currentColor` (the two selectors' own colour).
  ".base-toolbar-sort-item .grip-handle{display:flex;align-items:center;align-self:center;color:var(--text-faint);cursor:grab;}",
  ".base-toolbar-sort-item .grip-handle:hover{color:var(--text-muted);}",
  ".base-toolbar-sort-item .grip-handle:active{cursor:grabbing;}",
  ".base-toolbar-sort-item .grip-handle .base-panel-icon{width:var(--icon-s,16px);height:var(--icon-s,16px);}",
  ".base-toolbar-sort-item .grip-handle circle{fill:currentColor;stroke:none;}",
  // The row's own trailing control is the desktop's `clickable-icon`
  // (`a.createDiv("clickable-icon")` + `lucide-trash-2`, asar app.js@2481117): a borderless
  // 28px hit box with an icon hover face, NOT this sheet's framed `.base-panel-icon-button`.
  ".base-toolbar-sort-item .base-panel-icon-button{flex:0 0 var(--input-height,28px);width:var(--input-height,28px);height:var(--input-height,28px);padding:0;border:0;border-radius:var(--radius-s);background-color:transparent;color:var(--text-muted);}",
  ".base-toolbar-sort-item .base-panel-icon-button:hover{background-color:var(--background-modifier-hover,var(--hover));color:var(--text-normal);}",
  // D6 — the add/clear actions are the desktop's borderless menu rows in their own
  // `.bases-toolbar-menu-actions` section (`.bases-toolbar-menu .bases-toolbar-menu-actions{
  // display:flex;flex-direction:column;padding:var(--size-4-1)}`, app.css@459563) sitting AFTER
  // the rows section, so the section's own `:not(:last-child)` hairline is the divider and the
  // footer paints none. The row skin itself is the action-row block this sheet already owns
  // (`.base-panel-actions .base-panel-button`, the desktop `.bases-toolbar-menu-item` box),
  // which is why the footer carries that class too and only its box is overridden here.
  ".base-panel[data-base-panel=\"sort\"] .base-panel-footer{margin:0;padding:var(--size-4-1);border-top:0;gap:0;align-items:stretch;}",
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
  // ---------------------------------------------------------------------------
  // P6 — the PROPERTIES menu's own geometry (lane desktop-re/panel-properties)
  // ---------------------------------------------------------------------------
  // The menu is ONE flat list of items, so it carries none of this sheet's list gap and
  // none of the 30px control `min-height`: the desktop's item is
  // `.bases-toolbar-menu-item{display:flex;align-items:center;padding:var(--size-2-2)
  // var(--size-2-2);padding-inline-start:var(--size-2-3);border-radius:var(--radius-s);
  // gap:var(--size-4-2);width:100%}` (asar app.css@466779, `--size-2-2`=4px /
  // `--size-2-3`=6px / `--size-4-2`=8px @85969-family) with no `min-height` — the
  // `.base-panel-option` box above stays for every other panel (filter/sort rows), which
  // is why this is scoped to the properties shell. The measured row pitch after this is
  // in `evidence/readings.json` (the desktop reading is ≈25.75 CSS).
  ".base-panel[data-base-panel=\"properties\"] .base-panel-option{min-height:0;}",
  // Footer: the desktop group action row (`.bases-toolbar-menu .bases-toolbar-menu-actions
  // {display:flex;flex-direction:column;padding:var(--size-4-1)}`, asar app.css@459374) has
  // NO hairline above it — the owner's `全部隐藏` is a borderless menu item directly under
  // the list. `--size-4-1` = 4px. `base-panel-actions .base-panel-button` is the
  // `.menu-item` skin (asar app.css@283971) this footer row already reuses.
  ".base-panel[data-base-panel=\"properties\"] .base-panel-footer{margin:0;padding:4px;border-top:0;gap:0;}",
  // Read-only formula source of a computed property: real information, but a second
  // full-size label made the row read as one long run of text. Muted monospace, on
  // its own shrinkable slot, one line.
  ".base-panel-formula-source{flex:1 1 auto;color:var(--text-faint);font-family:var(--font-monospace,monospace);font-size:11.5px;}",
  // Desktop checkbox skin, measured from the owner's own screenshot at DPR2. The TICK is drawn in
  // the page background colour (owner: rgb(29,33,38) on an accent fill), NOT in --text-on-accent:
  // a white tick was a regression the third review round caught by pixel. (review round 2,
  // `checkbox-pixels.json`): CHECKED = solid fill rgb(92,139,223) with a dark tick; UNCHECKED =
  // the row background showing THROUGH with only a 1px outline rgb(96,108,124). The UA control we
  // had painted a solid #3b3b3b box when unchecked, which is a different widget on all 31 rows.
  // `--checkbox-color: var(--interactive-accent)` and `:checked{background/border}` are the
  // desktop's own declarations (app.css@433216).
  ".base-panel-check{appearance:none;width:16px;height:16px;flex:0 0 16px;margin:0;border:1px solid var(--checkbox-border-color,rgb(96,108,124));border-radius:var(--radius-s);background-color:transparent;position:relative;}",
  ".base-panel-check:checked{background-color:var(--checkbox-color,var(--interactive-accent,var(--accent)));border-color:var(--checkbox-color,var(--interactive-accent,var(--accent)));}",
  ".base-panel-check:checked::after{content:\"\";position:absolute;left:27%;top:18%;width:42%;height:25%;border-left:1.5px solid var(--background-primary,var(--panel));border-bottom:1.5px solid var(--background-primary,var(--panel));transform:rotate(-45deg);}",
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
  // P6 (lane desktop-re/panel-properties): the PROPERTIES menu is one flat list, so it
  // carries none of this sheet's 2px row gap and none of the list's own 260px cap — the
  // desktop's `.menu-scroll` owns that scroll (`.bases-toolbar-menu .menu-scroll{overflow-y:auto}`,
  // asar app.css@455560) and its 26-row menu scrolls there, not inside the list. Scoped to
  // the properties shell so the filter/sort lists keep their budget. It has to stay AFTER
  // the `.base-panel-list` rule above: `web-bases-panel-layout` reads that selector's first
  // match out of the shipped string.
  ".base-panel[data-base-panel=\"properties\"] .base-panel-list{gap:0;max-height:none;overflow:visible;}",
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
  // U12 — the declared-filter box (`所有视图` / `当前视图` read-only rows). Every
  // declaration below is copied from the desktop's own filter-group rules, byte-
  // offsets verified in the pinned 1.14.4 extract:
  //   app.css@470677 `.bases-query-container .filter-group{gap:var(--size-2-3);display:flex;flex-direction:column;width:100%;}`
  //   app.css@470700 `.bases-query-container .filter-group .filter-group-statements{width:100%;gap:var(--size-2-3);display:flex;flex-direction:column;}`
  //   app.css@470985 `.bases-query-container .filter-group .filter-group{background-color:var(--background-primary-alt);border:var(--table-border-width) solid var(--table-border-color);padding:var(--size-2-3);border-radius:var(--radius-m);}`
  //   app.css@472153 `.filter-row{display:flex;align-items:center;gap:var(--size-4-2);}` (the row itself is our `.base-panel-row`, same flex row)
  //   app.css@472522 `.bases-query-container .filter-row .filter-property-select{min-width:0;max-width:14em;}`
  // The desktop's box above belongs to a NESTED group; the reader sees one bordered
  // condition box per section (owner screenshot 01), so the two blocks are applied to
  // the section's statement container. `--size-2-3` (6px) is not declared by this app's
  // token layer, so the desktop's resolved value is the fallback — the same pattern
  // `--menu-border-width` already uses above.
  ".base-panel-group-statements{display:flex;flex-direction:column;gap:var(--size-2-3,6px);width:100%;box-sizing:border-box;background-color:var(--background-primary-alt);border:var(--table-border-width,1px) solid var(--table-border-color,var(--background-modifier-border,var(--line)));padding:var(--size-2-3,6px);border-radius:var(--radius-m);}",
  // The read-only slots of one declared condition: property / operator / value, each
  // one ellipsized span (`min-width:0` is what lets a flex child shrink below its
  // content, @472522), the property bounded at the desktop's own `14em`.
  ".base-panel-group-statements .filter-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;max-width:14em;}",
  ".base-panel-group-statements .filter-row>.base-panel-condition-value,.base-panel-group-statements .filter-row>.base-panel-condition-expression{flex:1 1 auto;max-width:none;}",
];
