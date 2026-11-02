# Admin plane — developer contract (greenfield redo, 2026-10-18)

The Admin console is being **rebuilt from scratch**. The previous Admin UI (Admin UI v2, W0–W8 plus
two "parity" rounds, deployed up to `v2026.10.18.1`) was judged untrustworthy and removed as a
design source: its markup, CSS, page modules and its self-reported parity claims are **not**
authority. Old code is archived in `Archive/obsidian-admin-v2-lanes-20261018.bundle` and in git
history.

Authority, in order:

1. **UI**: `docs/admin-ui-proto/` (`src/1-head.html` = design system/CSS, `src/3-body.html` = icon
   sprite, `src/4-data.js` = vocabulary/labels, `src/5-render.js` = the markup of every page,
   `src/6-app.js` = shell/menus/drawer/modal states, `README.md` = interaction rules).
2. **Behaviour/security**: the real services (`src/oauth-provider.js`, `src/publish-*`,
   `src/access-policy/*`, `src/admin/access-policy.js`, `src/admin/vault-git-routes.js`
   (`createVaultGitAdmin`), `src/git-*`, `src/scopes.js`, `src/capability-catalog.js`).

## Layout

```
app/src/admin/
  router.js         # the whole /admin/auth surface: session, CSRF, login lockout, tab dispatch, writes
  catalog.js         # per-request data assembly (the only place services are read for pages)
  grants.js          # access/refresh grant merge
  capabilities.js    # capability catalogue for the AuthZ editor (runtime groups + labels)
  http.js            # cookies / request source / form field narrowing
  layout.js          # document + `.app` shell: sidebar, sidebar footer, mobile nav
  ui.js              # page primitives: pageBar, search, row menu, table, mcards, banner, drawer, confirm
  assets/proto-css.js  # GENERATED verbatim from the prototype stylesheet — never hand-edit
  assets/icons.js      # GENERATED verbatim from the prototype sprite — never hand-edit
  assets/ssr-css.js    # SSR-only additions (`<details>` menus, `?id=` drawer/modal states, real inputs)
  presentation/format.js  # esc / relative+absolute time / short ids / planned-feature marker
  presentation/vocab.js   # scope names, token status words, policy modes, weekdays
  presentation/labels.js  # action / credential / git / publish label maps (honest "unknown")
  presentation/model.js   # per-request view model: lookups, tags, subject cells, policy windows
  pages/<tab>.js          # one module per page: `render<X>Page(ctx) -> { content, detailPanel }`
  assets/admin-client.js            # same-origin enhancement: shared context + boot
  assets/admin-feature-registry.js  # the registry (own module: a cycle here killed boot once)
  assets/admin-feature-overlays.js  # drawer over the list, floating row menu, modal confirm, toast
  assets/admin-feature-keys.js      # instant theme toggle, keyboard shortcuts, shortcut panel
  assets/admin-feature-lists.js     # instant filtering, in-place segments, live policy preview
  assets/admin-feature-select.js    # self-drawn select popup (user-decided design change, Q12)
  assets/admin-feature-nav.js       # narrow-screen nav overlay (`?nav=1`; user-decided, Q10)
```

Rules:

* **SSR is the source of truth; a same-origin enhancement script adds the prototype's behaviour.**
  The user approved external JS on 2026-10-18 (D0) after the SSR-only plane turned out to *behave*
  differently from the prototype. The client lives in `assets/admin-client.js` (shared context:
  toasts, overlay stack + Esc, shortcut registry, delegated listeners, fragment fetch, debounce,
  copy, theme) plus one feature module per concern (`admin-feature-overlays.js`,
  `admin-feature-keys.js`, `admin-feature-lists.js`), served from the admin router behind an exact
  whitelist. Hard rules: `script-src 'self'` only (no inline, no eval, no third party); the script
  never builds a page and never writes HTML from data (`textContent` for values); every action it
  intercepts is a real link or form in the markup, and any fetch/parse failure falls back to the
  original navigation. **The plane must stay fully usable with the script absent.**
* **Never edit** `assets/proto-css.js` / `assets/icons.js` (generated: `scratch/admin-parity/gen-proto-css.mjs`,
  `gen-icons.mjs`). If the design system must change, change the prototype or `assets/ssr-css.js` —
  and say why.
* **Class names come from the prototype.** Do not invent Admin classes; a missing style is a signal
  that the prototype markup is being paraphrased.
* **Data comes from `catalog.js`.** A page never calls a service directly. Unknown values render as
  `—` / 未提供, never as `0`, `正常` or `已撤销`.
* **Planned features** keep the dashed marker (`fut()` / `.futbox`) and get no fake CTA.
* **Every list table sorts, and the order lives in the URL** (owner request 2026-10-31). A column is
  declared sortable by giving its tuple a fourth item — the sort key — in the page's `table(...)`
  call:
  ```js
  table([[t("adm.keys.column.name"), "26%", "", "name"], …], rows, empty,
        { ...sort, base: tabHref({ q: query.q }) });
  ```
  `sort` comes from `readSort(query, keys, fallback)` (`table-sort.js`), `rows` from `sortRows(rows,
  sort, getters)` with the page's own accessors, and `base` from the page's existing list-URL helper,
  so a sort link never drops a search or a filter. The header renders `?sort=<key>&order=asc|desc` as
  a real GET link, so sorting works with scripting disabled and the order is shareable; the direction
  glyph is the only text a sorted header adds. **A page that pre-selects a column changes which
  record its list shows first** — the prototype must mirror that (it does, via
  `table(cols, rows, empty, { base, defaultKey })`), and the layout gate's per-state comparison is
  what keeps the two trees honest.
* **Column widths are the one client-only affordance** (2026-10-31). The grab strip is the
  stylesheet's `th::after` and the drag writes a px width onto the table's own `<col>`; no DOM is
  added, so the scriptless page and the parity capture see exactly the server's table. Widths are
  remembered per surface in `localStorage` (`omcp.colw:<tab>`), double-click resets a column, and a
  column never narrows below 56px. Nothing is required: without the module the table renders at the
  widths the server chose.

## Page contract

`renderAuthTab(tab, ctx)` calls `pages/<tab>.js`; each page returns
`{ content, detailPanel }`.

`ctx` (from `catalog.js`) carries:

| key | meaning |
| --- | --- |
| `model` | per-request view model (`presentation/model.js`): `acct`, `client`, `keyOf`, `vaultLabel`, `scopeTags`, `vaultTags`, `capTags`, `subjectView`, `subjectCell`, `windowSummary`, `inWindow`, `timeline`, `relTitle`, … |
| `snapshot` | `provider.authorizationSnapshot()` (+ `tokenGrants`), `oauthUsers`, `clients`, `tokens`, `audit` |
| `keys` | API Keys incl. the synthetic `configured-env` record |
| `grants` | access/refresh merged grants (`grants.js`) |
| `publications`, `publishCounts` | publish service records + active/invalid counts |
| `vaults`, `vaultGit` | Vault inventory and the Git admin model (`vaultGit.model`) |
| `transfers` | pending OAuth authorization transfers (#364 fence) |
| `authz` | `{ available, enabled, status, revision, policies, orphaned, count, enabledCount }` |
| `capabilities` | `{ groups: [{ group, label, items: [{ key, name }] }], nameOf, isValid }` |
| `navCounts`, `navAttention` | sidebar counts / attention dots |
| `theme`, `csrf`, `session`, `query`, `now` | request context: theme, CSRF token, admin session, query params |
| `accessPolicyBase`, `vaultGitBase` | hrefs of the two separate route modules |

## The two route modules

`/admin/auth/access-policy*` and `/admin/auth/vault-git*` live in their own route modules (they own
service-level validation, CAS and admission). They render through the same shell via
`view.renderAuthShell({ activeTab, content, session, theme, navCounts, navAttention, detailPanel })`.

## D0 — the enhancement script (same-origin client)

The user approved a **same-origin enhancement script** on 2026-10-18 (D0), after the SSR-only plane
turned out to *behave* differently from the prototype (rows navigated instead of opening the drawer,
no floating menus, no shortcuts). D0 is a narrow channel, not "add a framework": the markup stays
server-rendered and the script only re-adds the prototype's interactions.

### Script policy (frozen)

* One `<script type="module" src="/admin/auth/assets/admin-client.js">` per authenticated page —
  nothing else. The router serves `/admin/auth/assets/<name>` from an **exact whitelist** (names in
  `app/scripts/proto-parity/policy.mjs: ADMIN_CLIENT_MODULES`): `admin-client.js`,
  `admin-feature-registry.js`, `admin-feature-overlays.js`, `admin-feature-keys.js`,
  `admin-feature-lists.js`, `admin-feature-select.js`, `admin-feature-nav.js`. Feature modules are reached
  through the entry's own `import`s; any other
  name is refused, and the login page loads no script at all.
* No inline script, no `on*=` attribute, no `javascript:` URL — asserted on the *served* document
  (`probeDocumentPolicy` + `scriptInventoryFailures`) on every page, authenticated and anonymous.
* No third-party origin, no `eval`/`new Function`, and no `innerHTML`/`insertAdjacentHTML`/`outerHTML`/
  `document.write` for data: the client writes values with `textContent` only, checked both by a
  runtime counter and by a source audit (`admin-layout-security.mjs`, `injection.mjs`).
* The client never builds a page. It fetches a fragment of the *same* URL the link already pointed at
  (`x-admin-fragment: 1`), adopts the server's own nodes, and on any fetch/parse failure falls back
  to the original navigation.

### Frozen CSP (D0)

`app/src/admin/router.js` sends exactly:

```
default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

`connect-src 'self'` is load-bearing: without it `connect-src` falls back to `default-src 'none'` and
**every** same-origin fragment `fetch` is blocked. The gate compares the served header byte for byte
with `CSP_HEADER` (`app/scripts/proto-parity/policy.mjs`) and rejects
`unsafe-inline` / `unsafe-eval` / `strict-dynamic` / third-party origins in `script-src`.

### The no-JS guarantee

Every action the client intercepts is a real `<a href>` or a real `<form method="post">` in the
markup, and the plane must stay fully usable with scripting **disabled**:

* the confirm button of a type-to-confirm page ships **enabled** — a scriptless browser has to be
  able to submit, and the *server* compares `confirm`. The client's typed gate (button disabled until
  the typed text matches) is an enhancement, never the authority;
* a type-to-confirm field that cannot reach its form is a dead end: it either sits inside the
  `<form>` or carries `form="<form id>"`, and the association is read from the browser's own
  `input.form` (form owner), never from a hand-rolled attribute comparison;
* `<details class="mn">` row menus, the `?id=` drawer page, the `?confirm=` page and the `.result`
  banner are the no-script forms of the prototype's menu / drawer / modal / toast;
* the no-JS browser scene completes one real write per category (账户 / Key / Token / 客户端 / 发布 /
  审计 / 策略 / Git 修复) and re-reads the row/state afterwards, with `javaScriptEnabled: false`.

### The client `ctx` API

Feature modules register with `registerFeature(name, setup)`; `registerFeature` lives in
`admin-feature-registry.js` so the entry point and the feature modules cannot form an import cycle
(a cycle there once killed `boot()`). Note this is the **client** context — it is not the page-render
`ctx` that `catalog.js` builds for `pages/<tab>.js` (see *Page contract*).

| `ctx` | meaning |
| --- | --- |
| `toast(message, { err, ms = 3200, undo })` | the prototype toast, same 3.2 s default |
| `on(event, selector, handler, options)` | delegated `document` listener |
| `fetchFragment(url)` | same-origin `fetch` + `DOMParser` → `Document`; the only way markup enters the page |
| `debounce(fn, ms = 150)` | input debouncing |
| `copy(text)` | clipboard + toast |
| `theme` | `get` / `apply` / `toggle` / `restore` (localStorage `omcp-admin.theme`, cookie, `meta[theme-color]`) |
| `registerShortcut(combo, handler, { allowInInput })` | key registry: `g <key>` sequences, `/`, `t`, `?`, `j`/`k`, `Enter`, `Esc` |
| `openOverlay(entry)` / `closeOverlay(entry)` / `topOverlay()` | the shared overlay stack that `Esc` / outside click close |
| `mountModal(node, { onClose })` | the shared dialog host (`#modal` / `#mscrim`) for dialogs a feature builds itself |
| `push(url)` | `history.pushState` for in-place overlay states |
| `reveal(node, cls = "on")` | force the pre-transition style, then add the state class on the next frame — a transition only runs when a *starting* style was computed (append + toggle in one task otherwise snaps) |
| `conceal(node, cls = "on", ms = 220)` | remove the state class and resolve after the exit transition (bounded), so a closing drawer/modal can animate before its nodes leave the DOM |
| `motionOff()` | `prefers-reduced-motion: reduce` — the same media query `ssr-css.js` uses to zero the durations, so the helpers never wait for a duration that no longer exists |

### Inert DOM hooks the server renders (no behaviour without the script)

| hook | rendered by | used for |
| --- | --- | --- |
| `data-tab` on `.app` | `layout.js` | which tab the page is (`S.route`); a link to another tab is left to the browser |
| `data-hotkey` on `.ni` | `layout.js` | the `g <key>` sidebar jumps |
| `a.cell-link`, `details.mn` | pages / `ui.js` | rows that own an entry; the native menu the client floats |
| `data-scrim`, `.modal`, `.tc code` | `ui.js` | scrim ownership, the dialog box, the typed target string |
| `[data-overlay-dismiss]` | set by the client on the server's 取消 link | close in place instead of navigating |
| `data-enhance="hide-when-scripted"` | pages | a control that exists **only** for the no-JS path (the 定时授权 preview card's 查看); the entry drops it once the feature that replaces it has marked the form `data-enhanced="1"` |
| `data-autosubmit` | pages | the prototype's scripted “pick and it submits” select; without the script the explicit submit button is the path |
| `data-preview-form` | `pages/authz.js` | the list page's preview card: `admin-feature-lists` answers a pick in place from the server's own `POST {base}/preview` |
| `data-select-native` | `admin-feature-select.js` (client) | marks the real select as clipped/aria-hidden — an attribute, never a class, so the shape line stays the prototype's |
| `data-nav-toggle` / `data-nav-close` / `data-nav-scrim` | `layout.js` | the narrow-screen menu: a real link to the server's `?nav=1` state, its close link, and the scrim the client re-uses |

### User-decided design changes (2026-10-18) — NOT prototype parity

Two Wave R items are **user decisions**, not parity work, and the gate asserts them as such:

* **self-drawn select (Q12).** A native `<select>` option list cannot be styled; the owner asked for
  the expanded list to be drawn by the plane. Scope: every `select.sel` (incl. `.sel.sm`) unless it
  carries `data-native-select`. No-JS contract: the real `<select>` never leaves the form and keeps
  its `name`/options/value; the enhancement only clips it (aria-hidden + 1px clip) and mirrors every
  pick back with a real `change` event. The closed control stays the prototype's `.sel` vocabulary;
  the open popup is ours (`--elev`, `1px --line2`, `--shadow`, 32px / 28px rows, `--sel` selection +
  check mark, `max-height:320px`, on `<body>` with `position:fixed`). Keyboard/ARIA at native level:
  ↑/↓, Home/End, Enter/Space, Esc, Tab, type-ahead, `role=combobox` +
  `aria-expanded`/`aria-controls`/`aria-activedescendant`, `role=listbox`/`role=option`. The gate
  (`admin-layout-design.mjs`) asserts “the popup exists and paints the selected row” **and** “the
  closed state is still the prototype's `.sel`” — never “identical to the prototype”.
* **narrow-screen navigation (Q10).** The prototype's `[data-act=mmenu]` marker is dead (no CSS rule,
  no handler), so the plane defines the behaviour: at the prototype's own `@media (max-width:720px)`
  the shell renders `.ibtn.mobile-only[data-nav-toggle]`, which opens the sidebar as an overlay with
  `#mscrim`, a scroll lock, `role=dialog`/`aria-modal`, focus into the sidebar and back to the button,
  and Esc / scrim / nav item / toggle closing. Without the script it is a real link to the server's
  `?nav=1` state (overlay + scrim + close link back to the current URL), and the bottom `.mnav` stays.

### Mobile adaptations (2026-10-20) — measured, not parity claims

Four defects were filed from a phone screenshot and from source reading (issues #603-#607). Three were
reproduced with numbers, and the fixes are registered here so a later reader does not mistake them for
prototype parity:

* **M-a — the audit search label takes its own row below 380px** (`ssr-css.js`). The prototype's own
  `@media (max-width:720px){.search{min-width:0;flex:1}}` squeezes the search input to 39px at 320px
  (measured on the audit page; practically unusable, though the `<kbd>/</kbd>` hint itself stays inside
  the viewport). The prototype shows the same squeeze, so this is a deliberate narrow-phone adaptation,
  not a parity fix: below 380px the label takes a full 288px row; 390px and up are untouched.
* **M-b — the bottom 更多 popover is anchored to the slot's right edge** (`ssr-css.js`). It used to
  inherit the ~64-78px slot width while `proto-css`'s `.menu{min-width:180px}` still applied, so it hung
  102-116px past the right edge at 320/360/390px. It now grows leftwards inside the viewport
  (`min-width:min(220px,calc(100vw - 16px))`), and its items no longer inherit the bottom bar's
  icon-over-text `flex-direction: column`.
* **M-c — the audit pager is a bounded window** (`pages/audit.js`). The prototype emits one link per page;
  with `AUTH_AUDIT_MAX_ENTRIES=2000` and pageSize 25 that was 80 links / ~1477px wide, wider than any
  phone and unbounded if the cap is raised. Now: first, last, `page ± 1`, ellipses - at most 11 nodes
  whatever the page count - and at <=720px the pager row wraps so it never widens the content.

#604 (the page-size form dropped `tab=audit` and fell back to 概览) and #605 (a malformed percent escape
in *any* cookie entry threw `URIError` out of `parseCookies`, 500-ing login and every Admin page) are
plain defects, not adaptations; they are covered by `test/admin-redo/audit-pager.test.js` and
`test/admin-redo/cookies.test.js`.

**#603 (left clipping reported from a device screenshot) did not reproduce on the audit page** at
320/360/390/412 in a fixture: `documentElement.scrollWidth == clientWidth`, the toolbar/cards/pager sit at
16..width-16, and long tool names/IPs/paths wrap instead of overflowing. The only horizontal overflow
found there was #607's pager, now fixed - so the honest statement is "prime suspect fixed, device
re-check outstanding".

A second overflow exists on **other** pages and is NOT fixed here: `/admin/auth/access-policy` scrolls its
`.content` by 70/35/24px at 320/390/412 because a banner chip (`span.fut`, `white-space:nowrap`, chain
`span.fut > div.futonly.bm > div.banner.acc`) is wider than the viewport; `/admin/auth/access-policy?new=1`
adds 16px at 320 from the subject picker. Both are present in the prototype at the same widths (parity
behaviour, not introduced by this plane) and `fut.scrollIntoView()` can push `.content.scrollLeft` - which
is the *shape* of the reported left clipping. They are tracked as a separate mobile batch; a device
screenshot of the audit page is what #603 itself describes.

### Known deviations (honest)

* **the sidebar's keyboard-shortcut button is the one script-only affordance the server renders**
  (`layout.js`: `<button class="ibtn kbd-button" type="button">`). The prototype draws it too, and without
  the enhancement script it does nothing — unlike every other takeover it has no working no-JS fallback,
  which is why it is a **class hook** (`kbd-button`) rather than `data-act=`: `data-act=*` is reserved for
  affordances that stay usable without the script, and the gate asserts that (an `onclick`/`data-act`
  affordance on an authenticated page is red).
* `searchBox()` no-JS contract: the GET form must contain **exactly one** text field, so that pressing
  Enter implicitly submits it. The prototype's `<kbd>/</kbd>` hint stays visible (a real, style-transparent
  submit button carries it); adding a second text input would silently break Enter-submission.
* a link to a **different tab** (`?tab=…` ≠ `.app[data-tab]`) is left to the browser: the real
  navigation renders that page *and* its drawer server-side, which is what SSR intends, while the
  prototype re-rendered the SPA in place;
* the menu position is recomputed on resize/scroll only — `6-app.js` has no `mousemove` handler either;
* a `.result` banner that carries a secret, a link or a copy affordance keeps its banner: a toast must
  never be the only carrier of something the operator has to keep or click;
* `j`/`k` move the *menu* highlight while a menu is open (in the prototype they move table rows and
  never coexist with an open menu);
* the prototype is a single-file SPA with a hash router; the plane keeps real URLs, so drawer/modal
  states are `?id=` / `?confirm=` pages that the client upgrades in place.
* the **Vault admission bootstrap entry** is one extra labelled control in the Vault 与 Git page bar — a
  real GET link to `<base>?confirm=admission` (the same `?confirm=` idiom as the repair dialog). The
  admission capability has no prototype position at all (`grep 准入 docs/admin-ui-proto` → 0), so the
  control is declared in the shape waivers (`vaults` / `btn.btn` / `deliberate`, plus its label), the
  per-vault confirm choices live on that confirm state, and the drawer keeps only the decision surface
  (the prototype's drawer section/choice inventory is compared exactly). Found 2026-10-22: the list
  projection hid the whole admission section while the drawer only said 等待显式初始化, so a fresh
  deployment (no `vault-admissions.json`, discovery off) had **no UI way to enable the gate** — the
  route/binding/controller half was fixed on 2026-10-21 (`c72bf711`), the entry point was not.

## Legacy view chain removed (2026-10-31)

The greenfield plane used to leave the previous Admin UI's view code in the tree because the live
Git service module still imported it. That chain is gone:

- deleted `access-policy-view.js` (its only importer, `access-policy-routes.js`, was already gone on
  main; the live AuthZ surface is `routes/access-policy.js` → `pages/authz.js`);
- deleted `src/admin/vault-git-view.js`, `vault-git-config-form.js`, `admin-html.js` and
  `src/admin/admin-v2/**`;
- `src/admin/vault-git-routes.js` keeps the **service** (`createVaultGitAdmin`, `resolveActions`,
  `capabilityList`, `VAULT_GIT_CODES`) and no longer carries a legacy render path or route
  registration — its `registerVaultGitRoutes` shell, `sendFailure` renderer and the
  `renderVaultGitTab` import went with the chain (the live page is `routes/vault-git.js` →
  `pages/vaults.js`);
- the unit tests that exercised the deleted views (`test/admin-vault-git-view.test.js`,
  `test/helpers/vault-git-view-fixtures.js`) went with them;
- **kept, and live**: `src/admin/capability-labels.js` (imported by `pages/vaults.js`) and
  `src/admin/vault-admission-view.js` (its `admissionConfirmChoices` is shared with the live
  `?confirm=admission` dialog, so the legacy projection and the live dialog submit the same field
  names and values).

Also retired: `scripts/run-admin-window-checks.mjs` and `scripts/web-regression/admin-window-presentation.mjs`.
That scene read `td[data-label="窗口"] a[data-window-open]`, markup that only ever existed in the
deleted `access-policy-view.js`, so it had been unrunnable since the AuthZ page was ported. The
window surfaces are still covered: `pages/authz.js` renders the column, the timeline and the
`?window=` entry from `access-policy-window-presentation.js`, pinned by
`test/admin-access-policy-window-presentation.test.js` and `test/admin-redo/authz.test.js`, and the
list/drawer/editor shapes by the shape gate.

## Verifying against the prototype

```
# The whole Admin scene (prototype + this tree, in one run): structure, paint, full-DOM shape,
# no-JS, D0 interactions, security and the retired-defect criteria. It starts its own fixture server
# (scratch Vault + real Git repo + seeded records) and needs no credential and no Web build.
cd app
CHROMIUM_EXECUTABLE=<absolute path to a full chromium>/chrome.exe \
  WEB_TEST_OUTPUT=<trace dir outside the repo> node scripts/run-admin-layout-checks.mjs
# The pin exists because the harness refuses `chrome-headless-shell` (issue #380: its gesture timing
# makes tap checks non-deterministic). Without it the runner fails closed with the fix list.

# machine-enforced (D0 + Wave P/Q/R): the Admin prototype-parity gate must be 54/54, and its negative
# controls (prototype + implementation sabotage per criterion, injected inline script, injected
# on*/javascript: markup, waiver abuse: wildcards / wrong kinds / a `data` waiver on a region /
# duplicate entries / a `count` mismatch / a stale entry) are part of the run, not optional.
#
# The skeleton gate (`app/scripts/proto-parity/shape.mjs` + `shape-gate.mjs`) measures the prototype
# and the plane side by side with ONE normalization (tag + sorted classes + structural attributes +
# data-masked leaf text) per page state and asserts shape/order/label parity; data differences can
# only be waived line by line (`kind ∈ state|data|no-js-submit|deliberate`, no wildcards, a stale
# waiver turns the run red). It exists because the earlier judgements compared *chosen selectors and
# geometry*, which let a whole extra toolbar or a swapped control type pass unnoticed.
cd app
PLAYWRIGHT_MODULE=<path to playwright-core/index.mjs> node scripts/run-admin-layout-checks.mjs
ADMIN_CLIENT_BROWSER_EVIDENCE=1 node --test --test-concurrency=1 test/admin-redo/client-*.test.js
# full suite: SERIAL, always. On this Windows host the OS hands out ephemeral ports inside undici's
# blocked-port list (see test/preload-fetch-safe-listen.mjs), which turns an unrelated test red as
# `fetch failed / bad port`; the preload only changes which free port a fixture binds:
node --import ./test/preload-fetch-safe-listen.mjs --test --test-concurrency=1
```

CI runs the same Admin scene through `scripts/run-browser-ci.mjs` (the `Chromium web regression` job);
the local release receipt (`obsidian-local-validation/v1`) is built by
`scratch/admin-parity/build-local-evidence.mjs`.

Acceptance for a page: its table columns/cell shapes, banners, panels and empty states match the
prototype page element-for-element; no-JS; the pre-existing capability route is still reachable; a
negative control can make every new check red. The visual/layout standard is the prototype itself —
enforced by `app/scripts/proto-parity/` (see lane w5), not by a separate selector document.
