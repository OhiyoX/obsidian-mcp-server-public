// SSR additions on top of the prototype stylesheet (PROTO_CSS).
//
// The prototype is a single-file SPA: its menus, drawers, modals and toasts are toggled by an
// inline script. The Admin plane runs no script (CSP `default-src 'none'`), so the same visual
// states are reached by *server* state instead: `?id=` opens the drawer, `<details>` opens a row
// menu, a confirm page renders the modal, and a result renders a banner. This file only adds the
// mechanics those need — it never restyles a prototype class.
export const ADMIN_SSR_CSS = `
/* ---------- timed authorization editor ---------- */
.constraint-editor{--authz-row:34px} /* one row height for the timeline and the weekly text rows */
.constraint-editor [hidden]{display:none!important}
.constraint-editor .ped{grid-template-columns:minmax(0,1fr) clamp(290px,28vw,400px)}
.constraint-editor .ped-form{width:100%;max-width:none;min-width:0;padding:var(--s4)}
.constraint-editor .fs{min-width:0;margin:0 0 var(--s4);padding:0 0 var(--s3);border-bottom:1px solid var(--line)}
.constraint-editor .fs:last-child{margin-bottom:0;border-bottom:0}
.constraint-editor .fs>legend{display:block}
.constraint-editor .fs>legend .muted{display:inline-block;font-size:13px;margin-inline-start:var(--s2)}
.constraint-editor .help{color:var(--tx3);margin:var(--s2) 0 0}
.constraint-editor .chk{align-items:center;overflow-wrap:anywhere}
.constraint-editor .chk:has(:checked){background:var(--accent-bg)}
.constraint-editor .chk:focus-within{outline:2px solid var(--accent);outline-offset:-2px}
.constraint-editor .constraint-basic{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s4);margin-bottom:var(--s3)}
.constraint-editor .constraint-basic .chk{min-height:32px}
.constraint-editor .constraint-scope,.constraint-editor .schedule-shortcut-actions{display:flex;flex-wrap:wrap;gap:var(--s2)}
.constraint-editor .constraint-choices{display:grid;gap:var(--s2);min-width:0}
.constraint-editor .constraint-choices:has(.pick-list>.chk),.constraint-editor [data-vault-choices]{border:1px solid var(--line2);border-radius:var(--r2);padding:var(--s2)}
.constraint-editor [data-subject-picker]{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:4px;max-height:220px;scrollbar-gutter:stable}
/* The box sits on the name line (owner 2026-11-23): centering it put it between the name and
   the id line on a two-line subject cell. */
.constraint-editor [data-subject-picker] .chk{min-width:0;padding:4px 8px;align-items:flex-start}
/* Center the box on the NAME line regardless of the font's line box: half the leftover line
   height. A fixed pixel offset drifted at other zooms and fonts (owner 2026-11-23: the box
   stuck out above the name). */
.constraint-editor [data-subject-picker] .chk input{width:16px;height:16px;margin-top:calc((1lh - 16px) / 2)}
.constraint-editor [data-subject-picker] .chk>span{min-width:0}
.constraint-editor [data-surface-scope]{display:flex;flex-wrap:wrap;gap:var(--s3)}
.constraint-editor [data-subject-picker] .chk+.chk{margin-top:2px}
.constraint-editor .constraint-subjects>.constraint-choices{grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))}
.constraint-editor .constraint-subjects :is([data-subject-picker],[data-no-matches]){grid-column:1/-1}
.constraint-subject-tabs{display:flex;gap:var(--s1);flex-wrap:wrap}
.constraint-subject-tabs .btn[aria-pressed=true]{background:var(--accent-bg);color:var(--accent-tx)}
@media(pointer:coarse){.constraint-subject-tabs .btn{min-height:44px}}
.constraint-editor .constraint-operation-picker{display:flex;align-items:center;gap:var(--s2);margin-top:var(--s2)}
.constraint-editor .constraint-operation-picker>*{min-width:0}
.constraint-editor [data-operation-feedback]:empty{display:none}
.operation-groups{display:grid;gap:var(--s2);margin-top:var(--s2)}
.operation-group{border:1px solid var(--line);border-radius:var(--r2);padding:var(--s2)}
.operation-group>summary{cursor:pointer;font-size:13px;font-weight:600;padding:var(--s1)}
.operation-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:4px;max-height:260px;overflow:auto;scrollbar-gutter:stable}
.operation-grid .chk{min-width:0;margin:0;overflow-wrap:anywhere}
.constraint-editor .schedule-heading{margin-top:var(--s4)}
.constraint-editor .schedule-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s2) var(--s4);margin-top:var(--s2)}
.constraint-editor .schedule-header>.schedule-heading{flex:1 1 300px;margin:0;min-width:0}
.constraint-editor .schedule-header>.fld{display:flex;flex-direction:row;align-items:center;gap:var(--s2);flex:0 1 260px;margin:0;min-width:0}
.constraint-editor .schedule-header>.fld>label{flex:none;margin:0}
.constraint-editor .schedule-header>.fld>.sel{flex:1;min-width:0;width:100%}
.constraint-editor #constraint-schedule{scroll-margin-top:var(--s4)}
.constraint-editor :is(.schedule-heading h2,.draft-timeline h3){font-size:14px;margin:0}
.constraint-editor .schedule-shortcuts{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);margin-top:var(--s2);padding:var(--s2);background:var(--bg);border:1px solid var(--line);border-radius:var(--r2)}
.constraint-editor .schedule-shortcuts .help{flex-basis:100%;margin:0}
.constraint-editor .schedule-shortcuts .schedule-shortcut-times{margin:0}
.constraint-editor .schedule-shortcut-times{display:grid;grid-template-columns:100px max-content 100px;justify-content:start;align-items:center;gap:var(--s2);margin-bottom:var(--s2)}
.constraint-editor .draft-timeline{margin:var(--s4) 0;padding:var(--s3);border:1px solid var(--line);border-radius:var(--r2)}
.constraint-editor .draft-timeline .help{margin:var(--s1) 0 var(--s2)}
.constraint-editor .timeline-touch-hint{display:none}
.constraint-editor .draft-timeline .tl{column-gap:0;row-gap:0}
.constraint-editor .draft-timeline .tl a{grid-column:1/-1;display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;min-height:var(--authz-row);border-radius:var(--r);color:var(--tx2)}
.constraint-editor .draft-timeline .tl a:hover{background:var(--hover);text-decoration:none}
.constraint-editor .draft-timeline .tl .tr{height:calc(var(--authz-row) - 6px);cursor:crosshair;user-select:none}
.constraint-editor .draft-timeline .tl .tr .w{min-width:1px}
.constraint-editor .draft-timeline .tl .tr .w.drawing{background:var(--ok);outline:1px solid var(--ok);color:var(--pane);font-size:11px;line-height:16px;white-space:nowrap;pointer-events:none}
.constraint-editor .weekly-schedule,.constraint-editor .schedule-dates{margin-top:var(--s3);border:1px solid var(--line);border-radius:var(--r2)}
.constraint-editor .schedule-workspace{display:block}
.constraint-editor .weekly-schedule [data-schedule-rows]{display:flex;flex-wrap:wrap;gap:var(--s2);min-width:0}
.constraint-editor .weekly-schedule .schedule-group{padding-block:0}
.constraint-editor .weekly-schedule .schedule-row{flex:0 0 196px;width:196px;max-width:100%;height:calc(var(--authz-row) - 4px);gap:2px;border:1px solid var(--line2);border-radius:var(--r);background:var(--field,var(--bg));padding-left:2px}
.constraint-editor .weekly-schedule .schedule-row+.schedule-row{margin:0}
.constraint-editor .weekly-schedule .schedule-row .inp{border:0;box-shadow:none;background:transparent;text-align:center;padding:0 2px;height:calc(var(--authz-row) - 6px);font-size:13px;min-width:0}
.constraint-editor .weekly-schedule .schedule-row:focus-within{outline:2px solid var(--accent);outline-offset:-1px}
.constraint-editor .weekly-schedule [data-remove-row]{border-left:1px solid var(--line2);border-radius:0;min-height:calc(var(--authz-row) - 6px);height:calc(var(--authz-row) - 6px);width:28px}
.constraint-editor .weekly-schedule [data-add-row]{min-height:26px;height:26px;padding:0 8px;font-size:12px}
.constraint-editor .schedule-dates{padding:var(--s3)}
.constraint-editor .schedule-dates summary{cursor:pointer;font-size:14px;font-weight:600}
.constraint-editor .schedule-dates[open] summary{margin-bottom:var(--s3)}
.constraint-editor .schedule-group{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:var(--s2);min-height:var(--authz-row);padding:0 var(--s3)}
/* The divider is drawn inside the row, so a row keeps exactly --authz-row and lines up with the
   timeline above it (a border would add a pixel per row). */
.constraint-editor .weekly-schedule .schedule-group+.schedule-group{box-shadow:inset 0 1px 0 var(--line)}
.constraint-editor .schedule-group>b{align-self:center;padding-top:0;line-height:var(--authz-row);white-space:nowrap}
.constraint-editor .schedule-group:focus-within{background:var(--accent-bg)}
.constraint-editor .schedule-group:not([data-day]){grid-template-columns:minmax(0,1fr) auto;padding-inline:0}
.constraint-editor .schedule-row{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto;align-items:center;gap:var(--s2);max-width:380px}
.constraint-editor .schedule-row+.schedule-row{margin-top:var(--s1)}
.constraint-editor :is(.schedule-row input,.schedule-dates input,.grid2>*),.constraint-editor .ped-side{min-width:0}
.constraint-editor .schedule-row input[type=text]{font-family:var(--mono)}
.constraint-editor [data-remove-row]{width:32px;padding:0}
.constraint-editor .ped-side .stick{max-height:100%;overflow-wrap:anywhere}
.constraint-editor .sumbox .tags{margin:var(--s1) 0}
.constraint-editor .verdict small{display:block;color:var(--tx3);margin-top:var(--s1)}
.constraint-editor .constraint-preview-dirty{margin:0 0 var(--s3);color:var(--amber);background:var(--amber-bg);padding:var(--s2);border-radius:var(--r)}
.constraint-editor+.ped-foot{position:relative;flex:none}
.constraint-delete{position:relative}
.constraint-delete summary{list-style:none;cursor:pointer}
.constraint-delete summary::-webkit-details-marker{display:none}
.constraint-delete>div{position:absolute;bottom:calc(100% + 8px);right:0;width:min(240px,80vw);padding:var(--s3);background:var(--pane);border:1px solid var(--line2);border-radius:var(--r2);box-shadow:var(--shadow)}
.constraint-delete p{margin:0 0 var(--s2)}
@media(pointer:coarse){
  .constraint-editor .chk,.constraint-editor [data-add-row],.constraint-editor [data-remove-row],.constraint-editor .schedule-shortcut-actions .btn,.constraint-editor+.ped-foot .btn,.constraint-editor .draft-timeline .tl a{min-height:44px}
  .constraint-editor [data-remove-row]{width:44px}
  .constraint-editor .timeline-pointer-hint{display:none}
  .constraint-editor .timeline-touch-hint{display:block}
}
@media(max-width:1160px){
  .constraint-editor .ped{grid-template-columns:minmax(0,1fr)}
  .constraint-editor .ped-side{border-left:0;border-top:1px solid var(--line)}
}
@media(max-width:720px){
  .constraint-editor{--authz-row:36px}
  .constraint-editor .constraint-subjects>.constraint-choices{grid-template-columns:minmax(0,1fr)}
  .bar:has(+.constraint-editor) .idc{display:none}
  /* Phone: one day is one compact line — label, its ranges, the add control — instead of a
     bordered card under a full-width heading (owner 2026-11-23: the rows were still too large). */
  /* One label column for both lists, so the day names line up vertically. */
  .constraint-editor .draft-timeline{padding:8px 10px;margin:var(--s2) 0}
  .constraint-editor .draft-timeline .tl{row-gap:0}
  .constraint-editor .draft-timeline .tl a{min-height:var(--authz-row);font-size:12px;grid-template-columns:34px minmax(0,1fr)}
  .constraint-editor .draft-timeline .tl .tr{height:calc(var(--authz-row) - 6px)}
  .constraint-editor .schedule-group,.constraint-editor .schedule-group:not([data-day]){display:flex;flex-wrap:wrap;align-items:center;gap:3px 6px;min-height:var(--authz-row);padding:0 10px}
  .constraint-editor .schedule-group>b{flex:0 0 34px;padding-top:0;font-size:12px;font-weight:600;color:var(--tx2);line-height:var(--authz-row)}
  .constraint-editor [data-schedule-rows]{flex:0 1 auto;display:flex;flex-wrap:wrap;gap:4px}
  .constraint-editor .weekly-schedule .schedule-row{display:grid;grid-template-columns:56px auto 56px auto;flex:none;width:auto;max-width:none;border:0;background:transparent;padding-left:0;gap:2px}
  /* A phone needs to see where to tap: the two times read as fields, centered, 40px tall; the
     remove control keeps a 40px box; the add control collapses to its plus sign (text kept for
     assistive tech, no room for it on the row). */
  .constraint-editor .weekly-schedule .schedule-row .inp{height:calc(var(--authz-row) - 6px);min-height:calc(var(--authz-row) - 6px);padding:0 2px;text-align:center;font-size:13px;background:var(--field,var(--bg));border:1px solid var(--line2);border-radius:var(--r)}
  .constraint-editor .weekly-schedule .schedule-row>span{color:var(--tx3);font-size:11px;margin:0 3px}
  .constraint-editor .weekly-schedule [data-remove-row]{min-height:calc(var(--authz-row) - 6px);height:calc(var(--authz-row) - 6px);width:34px;border-left:0;display:grid;place-items:center}
  .constraint-editor .weekly-schedule [data-add-row]{margin-left:auto;min-height:calc(var(--authz-row) - 6px);height:calc(var(--authz-row) - 6px);width:34px;padding:0;font-size:0;justify-content:center;border:1px solid var(--line2);border-radius:var(--r)}
  .constraint-editor [data-add-row]{grid-column:2}
  .constraint-editor .schedule-row{max-width:none}
}
/* ---------- no-JS row menu (<details>) ---------- */
/* The slash hint is the prototype's own kbd element; the plane wraps it in the submit button the
   prototype never needed (a pointer operator must be able to submit a script-free GET filter). The
   button is style-transparent, so the kbd is drawn exactly where the prototype draws it. */
.kbd-hint{border:0;background:none;padding:0;margin:0;display:inline-flex;height:auto;border-radius:0}
.kbd-hint:hover{background:none}
.mn{position:relative;display:inline-flex}
.mn>summary{list-style:none;cursor:pointer;display:grid;place-items:center;width:28px;height:28px;border-radius:var(--r);color:var(--tx3)}
.mn>summary::-webkit-details-marker{display:none}
.mn>summary:hover{background:var(--hover);color:var(--tx)}
.mn[open]>summary{background:var(--sel);color:var(--tx)}
.mn>.menu{position:absolute;right:0;top:calc(100% + 4px);display:none}
.mn[open]>.menu{display:block}
.menu a,.menu label{display:flex;align-items:center;gap:var(--s2);width:100%;height:32px;padding:0 var(--s2);border-radius:4px;font-size:13px;color:var(--tx)}
.menu a:hover,.menu label:hover{background:var(--hover);text-decoration:none}
.menu a .i,.menu label .i{color:var(--tx3)}
.menu a.dz2,.menu label.dz2{color:var(--danger)}
.menu a.dz2 .i,.menu label.dz2 .i{color:var(--danger)}
.menu form{margin:0}
.menu form button{display:flex;align-items:center;gap:var(--s2);width:100%;height:32px;padding:0 var(--s2);border-radius:4px;font-size:13px;color:var(--tx)}
.menu form button:hover{background:var(--hover)}
.menu form button .i{color:var(--tx3)}
.menu form button.dz2,.menu form button.dz2 .i{color:var(--danger)}
.menu hr{border:0;border-top:1px solid var(--line);margin:4px 0}

/* ---------- server-rendered overlay states ---------- */
.modal.show{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
.modal .acts form{margin:0}
.drawer .bar h1 .cnt{font-weight:400}


/* ---------- switches as real submit buttons ---------- */
button.switch{padding:0;display:inline-block}
form.inline-form{display:inline-flex;margin:0}
/* A no-JS form that must lay out like the prototype's own block (Q11: inside an inline-flex form a
   width:100% select has no definite width, so the row wrapped and the card grew a line). */
form.inline-form.form-block{display:block;width:100%}
form.toggle-form{display:inline-flex;margin:0;align-items:center;gap:var(--s2)}
/* A switch that belongs to a form the page already renders (the policy editor's 状态 field) cannot
   be a nested form element and must not be a dead button: a label.switch wraps the real checkbox, the
   input fills the box, and :has() paints the on state — clicking the switch toggles the submitted
   field itself, so the control works with scripting disabled. */
label.switch{display:inline-block}
label.switch>input[type=checkbox]{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
label.switch:has(>input[type=checkbox]:checked){background:var(--accent)}
label.switch:has(>input[type=checkbox]:checked)::after{transform:translateX(14px)}
label.switch:has(>input[type=checkbox]:focus-visible){outline:2px solid var(--accent);outline-offset:2px}

/* ---------- mobile "更多" sheet ---------- */
.mnav .mmore{flex:1;display:flex;position:relative}
.mnav .mmore>summary{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:13px;color:var(--tx3);list-style:none;cursor:pointer}
.mnav .mmore>summary::-webkit-details-marker{display:none}
.mnav .mmore[open]>summary{color:var(--tx)}
.mnav .mmore>.menu{position:absolute;right:0;left:auto;bottom:100%;margin-bottom:6px;display:none;max-height:60vh;overflow:auto;
  /* #606: the popover used to inherit the slot's width (left:0;right:0 on a ~64–78px slot) while
     proto-css's .menu{min-width:180px} still applied, so it hung past the right edge by 100–116px.
     Anchor it to the slot's RIGHT edge so it grows leftwards inside the viewport. */
  min-width:min(220px,calc(100vw - 16px));max-width:calc(100vw - 16px)}
.mnav .mmore>.menu a,.mnav .mmore>.menu .ni{flex:none;width:100%;display:flex;flex-direction:row;align-items:center;gap:var(--s2);padding:10px 12px;font-size:14px}
.mnav .mmore[open]>.menu{display:block}

/* ---------- links inside table cells keep the row look ---------- */
a.cell-link{color:inherit}
a.cell-link:hover{text-decoration:none}
a.cell-link:hover .nm b{text-decoration:underline}
a.cell-link.block{display:block;min-width:0}
/* A row menu is absolutely positioned inside a cell (SSR takes the prototype's scripted
   fixed-position menu and renders it as a details element), so the table box must not clip it
   vertically. Horizontal clipping stays: a long token scrolls instead of widening the page. */
.tw{overflow-x:clip;overflow-y:visible}
.tbl td.act,.tbl th.act{overflow:visible}
tr.detail-row{display:none}
tr:has(details.ua[open]) + tr.detail-row{display:table-row}

/* ---------- page-level toolbar / rows the prototype toggles with JS ---------- */
.toolbar .right{margin-left:auto;display:flex;align-items:center;gap:var(--s2)}
.toolbar form{margin:0}
.toolbar .sel.sm,.toolbar .inp.sm{width:auto}
.toolbar .seg button[aria-current="page"],.toolbar .seg a.on{background:var(--elev);color:var(--tx);box-shadow:0 0 0 1px var(--line2)}
.toolbar .seg a{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:4px;font-size:13px;color:var(--tx2);white-space:nowrap}
.toolbar .seg a:hover{color:var(--tx);text-decoration:none}
.filters{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-bottom:var(--s3)}
.filters .inp,.filters .sel{width:auto;min-width:120px}
.filters .search{min-width:220px}
.rowline{display:flex;align-items:center;justify-content:space-between;gap:var(--s2)}

/* ---------- server result / flash line (the prototype uses a toast) ---------- */
.result{display:flex;gap:var(--s2);align-items:flex-start;padding:10px var(--s3);border-radius:var(--r2);font-size:13px;line-height:18px;margin-bottom:var(--s4);border:1px solid var(--line2);background:var(--field);color:var(--tx2)}
.result.ok{border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:var(--ok-bg);color:var(--tx)}
.result.ok .i{color:var(--ok)}
.result.err{border-color:color-mix(in srgb,var(--danger) 40%,transparent);background:var(--danger-bg);color:var(--tx)}
.result.err .i{color:var(--danger)}

/* ---------- audit expandable detail (prototype: JS row expand) ---------- */
tr.detail-row td{background:var(--bg);padding:var(--s2) var(--s3) var(--s3);white-space:normal}
tr.detail-row .uax{padding:var(--s2) 0;color:var(--tx2);overflow-wrap:anywhere;word-break:normal}
.authz-operation-detail>[data-imported-atoms]{margin-top:var(--s2)}
.tbl td>[data-imported-atoms],.mc [data-imported-atoms]{margin-top:var(--s1)}
.tbl tbody tr.dim td.act > *{opacity:1}
/* The row's pause/resume control carries its label only where the table has room: at ~1024px two
   labelled buttons squeezed the status and window columns into wrapping (measured in a screenshot).
   Below 1180px the icon keeps its title and aria-label. PROTO_CSS stays untouched: it is the
   prototype's verbatim copy and the paint gate compares it byte for byte. */
@media(max-width:1180px){.tbl td.act .hide-md{display:none}}
.ov2 .kv > *{min-width:0;overflow-wrap:anywhere}
.tw>.empty{padding-block:var(--s6)}
.drawer #authz{display:grid;gap:var(--s2)}
.drawer #authz :is(h3,.banner,.verdict){margin:0}
.drawer .subject-authz-list{display:grid;gap:var(--s2)}
.drawer #authz .verdict span,.drawer [data-key-access-form] .chk>span{min-width:0;overflow-wrap:anywhere}
.drawer .key-access-scopes{gap:var(--s2)}
.drawer :is(.key-access-vaults,.account-access-vaults){min-width:0;margin:var(--s4) 0;padding:var(--s2);border:1px solid var(--line);border-radius:var(--r2)}
.drawer :is(.key-access-vaults,.account-access-vaults) legend{padding:0 var(--s1);color:var(--tx2)}
.drawer form.dsec[action$="/default-vault"]{border-top:1px solid var(--line);padding-top:var(--s4);margin-top:var(--s4)}
.drawer:has([name=defaultVaultId]) .dsec:not(:first-child){margin-top:var(--s4)}
.drawer :is(.key-access-vaults,.account-access-vaults){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:var(--s2);margin-block:var(--s3)}
.drawer :is(.key-access-vaults,.account-access-vaults) .chk{margin:0;min-width:0}
.drawer form.dsec[action$="/default-vault"]{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s2);align-items:start}
.drawer form.dsec[action$="/default-vault"]>h3{grid-column:1/-1;margin:0}
.drawer form.dsec[action$="/default-vault"]>.fld{display:contents}
.drawer form.dsec[action$="/default-vault"] .sel{grid-column:1;grid-row:2}
.drawer form.dsec[action$="/default-vault"] .help{grid-column:1/-1;grid-row:3}
.drawer .default-vault-actions{grid-column:2;grid-row:2}
@media(max-width:420px){
  .drawer form.dsec[action$="/default-vault"]{grid-template-columns:minmax(0,1fr)}
  .drawer .default-vault-actions{grid-column:1;grid-row:4}
}
.tbl th:not(.act)::after{right:0;width:10px;background:linear-gradient(var(--line2),var(--line2)) center/1px 45% no-repeat}
.tbl th:has(+th.act)::after{display:none}
.tbl th:not(.act):hover::after,.tbl.rz-active th:not(.act)::after{background-image:linear-gradient(var(--accent),var(--accent))}
.authz-operation-detail>.help{margin:var(--s3) 0 0}
tr.detail-row .dt{padding:10px var(--s3) 12px;font-size:13px;color:var(--tx2);display:grid;grid-template-columns:120px minmax(0,1fr);gap:4px var(--s3)}
tr.detail-row .dt .k{color:var(--tx3)}
tr.detail-row .dt .mono{word-break:break-all}
details.ua>summary{list-style:none;cursor:pointer;display:inline-grid;place-items:center;width:32px;height:32px;border-radius:var(--r);color:var(--tx3)}
details.ua>summary:hover,details.ua[open]>summary{background:var(--hover)}
details.ua[open]>summary .i{transform:rotate(90deg)}
details.ua>summary::-webkit-details-marker{display:none}
details.ua[open]>summary{color:var(--tx)}

/* ---------- login / error pages keep the prototype card ---------- */
.login{min-height:100dvh}
.login .box .note{font-size:13px;color:var(--tx3);line-height:18px}

/* ---------- read-only cells ---------- */
.lock-cell{display:inline-flex;align-items:center;color:var(--tx3)}
.panel-note{font-size:13px;color:var(--tx3);line-height:18px;margin:0 0 var(--s2)}

/* ---------- narrow-screen navigation (Q10 — user-decided DESIGN ADDITION, 2026-10-18) ----------
   The prototype marks a .ibtn.mobile-only menu button in its page bar but never gives it a
   rule or a handler (5-render.js:106, no .mobile-only in 1-head.html, no mmenu case in
   6-app.js), so there is nothing to copy for the *behaviour*. The plane therefore renders a real
   control: a link to the server's own ?nav=1 state, which opens the sidebar as an overlay. The
   breakpoint is the prototype's own @media (max-width:720px) (1-head.html:353) — no new one is
   introduced, and above it the control is display:none so the wide layout is untouched. */
/* The scroll lock belongs to the narrow overlay only: at wide viewports the sidebar is an ordinary,
   always-visible column and the nav=1 state is degenerate, so locking the page there would be wrong. */
.mobile-only{display:none}
.side .nav-close{display:none}
/* The shell's content is the page scroller. The prototype gets that from .content{flex:1;min-height:0}
   plus the .scroll class on the page body; our pages put their own .content.scroll INSIDE the shell's
   .content, so without an overflow here a tall page (the audit table with 25 rows is 1719px) grows past
   the fixed-height .app and the whole document scrolls, dragging the sidebar out of view (owner
   screenshot 2026-10-21). Constrain the shell, not the page. */
.app > .main > .content{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
/* SSR: the prototype's 窗口外处理方式 options are .mode button cards (1-head.html:286-290) with a
   decorative .radio that fills when selected. A server-rendered page needs real radios, so the same
   card look is applied to the .chk label that carries the input. Without this the two options fell
   back to bare radios: no border, no selected fill, no copy rhythm — the parity gap the owner
   reported on 2026-10-21. Keys on our own .chk; .mode button itself is never restyled. */
.mode .chk{position:relative;display:flex;flex-direction:column;gap:2px;border:1px solid var(--line2);border-radius:var(--r2);padding:var(--s3);background:var(--field);font-size:14px}
.mode .chk>span{display:flex;flex-direction:column;gap:2px;min-width:0}
.mode .chk>input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.mode .chk b{font-weight:600;font-size:14px;display:flex;gap:var(--s2);align-items:center}
.mode .chk>span>span{font-size:13px;color:var(--tx3);line-height:18px}
.mode .chk.on{border-color:var(--accent);background:var(--accent-bg)}
.mode .chk.on.rv{border-color:var(--danger);background:var(--danger-bg)}
.mode .chk.on b>.radio{border:4px solid var(--accent)}
.mode .chk.on.rv b>.radio{border-color:var(--danger)}
.mode .chk:focus-within{outline:2px solid var(--accent);outline-offset:2px}
/* A fieldset refuses to shrink below its widest child (initial min-inline-size:min-content),
   so the AuthZ editor fieldset stuck out 16px past a 320px viewport and dragged the picker and its
   search row with it. min-width:0 lets the box take the width the grid already gave it. */
@media (max-width:720px){
  .main{position:relative}
  .main>.nav-toggle{display:inline-flex;position:absolute;top:10px;left:8px;z-index:26}
  .main>.bar{padding-left:44px}
  /* The prototype hides .side below this breakpoint; the overlay is its open state. */
  .side.nav-open{display:flex;position:fixed;top:0;left:0;bottom:0;width:min(86vw,320px);z-index:70;
    background:var(--side);border-right:1px solid var(--line2);box-shadow:var(--shadow)}
  .side.nav-open .nav-close{display:inline-flex;margin-right:2px}
  .side.nav-open .brand{padding-left:var(--s2)}
  body.nav-overlay-open{overflow:hidden}
  /* #607: even a bounded page window is ~11 items wide; with the total and the page-size form on the
     same row it cannot fit a phone. Let the row wrap instead of widening the content. */
  .pager{flex-wrap:wrap;row-gap:var(--s2)}
  .pager .pg{flex-wrap:wrap;row-gap:4px}
  .fs,.picker{min-width:0}
}

/* Below 380px the prototype's own flex row squeezes the search label down to its icon (19px at 320px),
   which pushes the kbd slash hint past the viewport edge by 13px. The prototype has the same
   squeeze (it is not a regression of this plane), but it makes the filter row unusable and leaks a
   horizontal overflow, so the label takes its own row on very small phones only — a registered
   mobile adaptation (docs/admin/README.md, M-a), not a parity claim. */
@media (max-width:380px){
  .toolbar .search{flex:1 1 100%;overflow:hidden}
}

/* ---------- self-drawn select (Q12 — user-decided DESIGN CHANGE, 2026-10-18) ----------
   A native option list cannot be styled, so the owner asked for the expanded list to be drawn by the
   plane. The *closed* control stays the prototype's .sel (a button.sel inherits the box, the
   border, the radius and the chevron gradient); the popup is ours and follows the Admin vocabulary
   (--elev surface, 1px --line2, --shadow, 32px rows / 28px for .sm, 8px padding).
   The real <select> is only clipped: it stays in the form (so submits and change still come from
   it) and is aria-hidden + tabindex=-1 while the proxy owns the interaction. */
/* The real control must stay INVISIBLE whatever the page's own rules say: .toolbar .sel.sm and
   friends are three-class rules and would win against this one without the !important flags. It is
   still laid out (not display:none) so the shape line keeps the prototype's select.sel, and still in
   its form, so submits and change events keep coming from it.
   position:fixed, NOT absolute: an absolutely positioned box contributes scrollable overflow to
   whatever contains it, and this control's static position sits at the bottom of a long list — so on
   the audit page (whose 每页条数 select lives in the pager below a 1587px table) the document grew to
   the full content height, the 100vh shell scrolled away and left a blank page under it. A fixed box
   never adds to the document's scroll area. */
select.sel[data-select-native]{position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;
  margin:-1px!important;padding:0!important;border:0!important;overflow:hidden;clip-path:inset(50%);
  white-space:nowrap;pointer-events:none!important}
/* Accounts reset: an empty (or too short) new-password field disables its submit button with no
   script. The required + minlength attributes make the input invalid, :has() then paints the button
   and blocks the pointer, and the browser's own validation stops the submit. The server keeps its
   12-256 check, so this is an affordance, never the guarantee. */
form.dsec:has(input[name=password]:invalid) button[type=submit]{pointer-events:none;opacity:.5}
/* A no-JS fallback control the enhancement replaced. The hidden attribute alone is not enough: the
   prototype's own .btn{display:inline-flex} is an author rule and beats the UA sheet's [hidden]. */
[data-enhanced-hidden="1"]{display:none!important}button.sel.sel-proxy{text-align:left;display:inline-flex;align-items:center;overflow:hidden;white-space:nowrap;
  text-overflow:ellipsis;font:inherit;font-size:14px;cursor:pointer;min-width:0;max-width:100%}
button.sel.sel-proxy.sm{font-size:13px}
button.sel.sel-proxy:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.selmenu{position:fixed;z-index:75;box-sizing:border-box;background:var(--elev);border:1px solid var(--line2);border-radius:var(--r2);
  box-shadow:var(--shadow);padding:var(--s2);overflow:auto;font-size:14px;line-height:20px;color:var(--tx)}
.selmenu .sel-opt{display:flex;align-items:center;gap:var(--s2);height:32px;padding:0 var(--s2);border-radius:4px;
  cursor:pointer;white-space:nowrap}
.selmenu .sel-opt .sel-opt-label{overflow:hidden;text-overflow:ellipsis}
.selmenu .sel-opt:hover{background:var(--hover)}
.selmenu .sel-opt.act{background:var(--hover)}
.selmenu .sel-opt.on{background:var(--sel);color:var(--tx)}
.selmenu .sel-opt.on.act{background:var(--sel)}
.selmenu .sel-opt .sel-check{margin-left:auto;color:var(--accent);visibility:hidden}
.selmenu .sel-opt.on .sel-check{visibility:visible}
.selmenu .sel-opt:focus{outline:0}
.selmenu.sm .sel-opt{height:28px;font-size:13px}
/* Motion is an enhancement, never a requirement: an operator (or an OS setting) that asks for no
   animation gets the same overlay states without the transition. The client's reveal/conceal helpers
   check the same media query, so the scripted path removes nodes immediately instead of waiting out
   a duration that no longer exists. */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{transition-duration:0s !important;animation-duration:0s !important;animation-iteration-count:1 !important}
}
`;
