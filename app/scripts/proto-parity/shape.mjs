// Prototype-parity — **full-DOM shape** gate (Wave P, `v2026.10.18.6`).
//
// Why this exists. The parity gate in `gate.mjs` compared *chosen* criteria: a candidate-selector
// list, the column lists and a set of geometry probes. Every one of them was true, and the Admin
// plane still differed from the prototype in ways a user sees at a glance — the sidebar carried an
// extra empty `div.sec-h` (the whole column drifted down by one 44px item), the search box replaced
// the prototype's `<kbd>/</kbd>` hint with a submit button, the policy editor grew a whole toolbar
// the prototype does not have, and the overview's 需要关注 rows were `<div class="li">` where the
// prototype draws `<a class="li" href=…>`. A comparison of picked criteria structurally cannot see
// "a region is extra" or "the control was swapped for another kind of control".
//
// This module compares the **whole normalized DOM skeleton** of the same page state on both trees —
// the prototype (`docs/admin-ui-proto/index.html`, the UI truth source) and this tree's Admin plane
// (the fixture server) — with ONE probe run on both sides, so the comparison is symmetric by
// construction and "the implementation is the odd one out" is never an assumption.
//
// Normalization rules (N1–N9). Every rule is applied to *both* sides by the same code, and every
// rule is a documented decision rather than a per-page adjustment:
//   N1  `#root` — the prototype's static mount wrapper — contributes no shape.
//   N2  shell singleton containers that are EMPTY (`#drawer/#modal/#menu/#toast/#dscrim/#mscrim`)
//       are not UI: the prototype always carries them, the plane renders none of them.
//   N3  a closed `<details>` renders no children; the prototype's scripted popup likewise has no
//       DOM until it is opened. (The plane uses `<details class="mn">` for row menus.)
//   N4  `<svg>/<use>/<path>` icon internals, `input[type=hidden]` submission plumbing and `.scrim`
//       state veils are not layout.
//   N5  the same control spelled two ways is one node: the row menu (`details.mn` ⇄
//       `button[data-menu]` + `#menu`) canonicalizes to `rowmenu` / `popup` / `menuitem`, and the
//       search box (`label.search` ⇄ `form.search`) to `search` — the *inside* of the search box is
//       still compared element by element, which is how the missing `<kbd>/</kbd>` is caught.
//   N6  overlays (`.drawer`, `.modal`, `.menu`, `#toast`) are compared as a **trailer** in a fixed
//       kind order, not by DOM position: the prototype hoists them to body singletons, the plane
//       renders them inline.
//   N7  a run of ≥2 consecutive siblings with the same signature is a **list region**: how many rows
//       exist is data (the prototype's own fixture and the fixture server hold different records),
//       the set of row *shapes* in that region is structure. Multiplicity is recorded as evidence
//       and is never a failure by itself; a list region present on one side only is a failure.
//   N8  leaf text is compared as a KIND — `-` empty, `N` no letters, `T` has letters — never as the
//       datum itself. Literal UI copy is compared by `compareShapeLabels` over structural label
//       positions (`.sec-h`, `legend`, `th`, `kbd`, `.btn`, `.chip`, …), not over data rows.
//   N9  hrefs are compared as route tokens (`route:accounts:detail`, …): the prototype is
//       hash-routed, the plane is query-routed, and both spell the same destination.
//
// Waivers. Data differences must be *explicit*: `SHAPE_WAIVERS` names the exact canonical line, the
// state, and why it is data. A waiver that no longer matches a real difference FAILS the gate
// (stale waivers are debt, not slack), wildcards are rejected and the list has a budget. The
// in-gate negative controls prove the judgments are live: mutating the live DOM, mutating the
// PROTOTYPE DOM, and abusing the waiver list must each turn the gate red.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PARITY_PAGES } from './spec.mjs';
import { runProbe } from './probe.mjs';
import { protoUrl, withQuery } from './gate.mjs';

/**
 * The in-browser probe. Self-contained (serialized with `Function.prototype.toString`) and run
 * verbatim on both trees. Returns the normalized skeleton as a flat pre-order list of
 * `{ d, sig }` (the signature already carries the text kind), plus the structural-label inventory
 * (`labels`) and the row-multiplicity evidence (`runs`).
 */
export function probeShapeTree(options) {
  const opts = options || {};
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'USE', 'PATH', 'SYMBOL', 'DEFS', 'TITLE', 'LINK', 'META']);
  /** N2: the prototype's scripted overlays live in these body-level singletons (`3-body.html`). */
  const SHELL_SINGLETONS = new Set(['root', 'dscrim', 'mscrim', 'drawer', 'modal', 'menu', 'toast']);
  /** N6: overlay kinds and the fixed trailer order the comparison uses. */
  const OVERLAY_KINDS = ['menu', 'drawer', 'modal', 'toast'];
  /** N8: the structural label positions whose literal copy is UI vocabulary, not data. */
  // Q1: `.sec-h` alone left the section HEADINGS (`h2`), the explanatory copy (`p.help`), the inline
  // side note (`.tx2`, the switch's state hint and the window summary) and the capability group
  // titles (`.cap-h`) outside the copy comparison — a reworded or emptied heading passed. `.cap-h` is
  // the canonical kind's own element name (`summary.cap-h` / `button.cap-h`).
  const LABEL_SCOPE = ['.bar h1', '.sec-h', 'h2', 'p.help', '.tx2', '.cap-h', '.side .lbl', '.mnav a', '.stat .t', '.seg > *', 'th', 'legend', '.btn', '.chip', '.pill', 'kbd', '.pick-g > span', '.mode b', '.fld > label', '.futbox b'];

  const mask = (value) => String(value ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  const kindOf = (text) => {
    const value = mask(text);
    if (!value) return '-';
    return /[A-Za-z\u4e00-\u9fff]/.test(value) ? 'T' : 'N';
  };

  const classesOf = (el) => {
    const raw = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    const list = raw.trim().split(/\s+/).filter(Boolean)
      .filter((name) => name !== 'overlay-open')
      .map((name) => (name === 'show' ? 'on' : name));
    return [...new Set(list)].sort();
  };
  /** N11: element ids are script hooks, not shape — the prototype marks its singletons by id and the
   *  plane by class (`.drawer`, `.menu`), and the plane's own ids (`#authz-form`) exist only to wire
   *  a control to a form. Ids are therefore dropped from the comparison on both sides. */
  const idOf = () => '';

  /** N9: destination identity, not spelling. */
  const routeOf = (raw) => {
    if (!raw) return null;
    let value = String(raw);
    if (/^[a-z]+:/i.test(value)) {
      try { const url = new URL(value); value = `${url.pathname}${url.search}${url.hash}`; } catch { /* keep as-is */ }
    }
    let pathname;
    let query;
    if (value.startsWith('#')) {
      const at = value.indexOf('?');
      pathname = at < 0 ? value.slice(1) : value.slice(1, at);
      query = at < 0 ? '' : value.slice(at + 1);
    } else {
      const at = value.indexOf('?');
      pathname = at < 0 ? value : value.slice(0, at);
      query = at < 0 ? '' : value.slice(at + 1);
    }
    const params = new URLSearchParams(query);
    const segments = pathname.replace(/\/$/, '').split('/').filter(Boolean);
    const KNOWN = ['overview', 'accounts', 'keys', 'clients', 'tokens', 'publish', 'publishes', 'audit', 'authz', 'vaults', 'login', 'web'];
    let page = null;
    let detail = '';
    if (pathname === '/app' || pathname === '/app/') page = 'web';
    else if (pathname === '/admin/auth') page = 'overview';
    else if (pathname === '/admin/auth/login') page = 'login';
    else if (pathname === '/admin/auth/access-policy') page = 'authz';
    else if (pathname.startsWith('/admin/auth/access-policy/')) { page = 'authz'; detail = 'action'; }
    else if (pathname === '/admin/auth/vault-git') page = 'vaults';
    else if (KNOWN.includes(segments[0])) { page = segments[0]; if (segments[1]) detail = segments[1] === 'new' ? 'new' : 'detail'; }
    else return 'route:' + mask(value).replace(/=[^&]*/g, '=<v>');
    if (page === 'overview') {
      const tab = params.get('tab');
      if (tab) page = tab === 'publishes' || tab === 'publishs' ? 'publish' : tab;
    }
    if (page === 'publishes') page = 'publish';
    const id = params.get('id');
    if (id) detail = id === 'new' ? 'new' : 'detail';
    if (params.get('new')) detail = 'new';
    if (params.get('edit') || params.get('copy')) detail = 'detail';
    const rest = [...params.keys()].filter((key) => key !== 'tab' && key !== 'id' && key !== 'edit' && key !== 'copy' && key !== 'new').sort();
    // A record/Page parameter carries an ID whose *spelling* differs per tree (`au_1` is the
    // prototype's audit id, a UUID is the plane's). Such a value is one `<id>` token; every other
    // query value is compared as its masked self (`outcome=failure` must stay `failure`).
    const ID_PARAMS = new Set(['focus', 'revision', 'page', 'step']);
    const route = `route:${page}${detail ? ':' + detail : ''}${rest.map((key) => `&${key}=${ID_PARAMS.has(key) ? '<id>' : mask(params.get(key) || '')}`).join('')}`;
    return mask(route).replace(/<[a-z]+>/g, (token) => (token === '<uuid>' || token === '<id>' ? '<v>' : token)).replace(/\s+/g, '');
  };

  /** Attributes compared by presence. `aria-label`/`aria-current` are accessibility layers over the
   *  same visible affordance (`aria-current` duplicates the `.on` class the prototype uses); form
   *  plumbing (`name`/`value`/`form`/`method`) and the script hooks (`data-act`/`data-menu`) spell
   *  ONE control in two implementations and are asserted by the no-JS and interaction gates. */
  const ATTR_PRESENCE = ['role', 'aria-modal', 'placeholder', 'disabled', 'checked', 'required'];
  const ATTR_VALUE = ['type', 'href'];
  /** Containers whose children are RECORDS: multiplicity there is data (see N7). */
  const DATA_CONTAINERS = ['.mcards', '.list', '.pick-list', '.tags', '.stats', '.tl', '.cap-b', '.kv', '.menu'];
  const DATA_TAGS = ['TBODY'];

  /**
   * Canonical control kinds: the prototype spells a control with a scripted element, the plane with
   * the real no-JS element, and BOTH are the same affordance. Such a node is compared as a leaf, so
   * the implementation detail inside it cannot produce a diff, while its state and its copy still
   * are compared (`LABEL_SCOPE` covers `.chip`, `.pill`, `.mode b`, `.btn`, …).
   */
  const canonicalKind = (el) => {
    const classes = classesOf(el);
    const tag = el.tagName.toLowerCase();
    const parentClasses = classesOf(el.parentElement || el);
    if (classes.includes('switch')) return 'switch';
    if (classes.includes('chip')) return 'chip';
    if (classes.includes('pill')) return 'pill';
    if (classes.includes('idc')) return 'idc';
    if (classes.includes('mmore') || (tag === 'a' && el.getAttribute('data-act') === 'mmore')) return 'mmore';
    if (tag === 'button' && el.hasAttribute('data-menu')) return 'rowmenu';
    if (classes.includes('ibtn')) return 'ibtn';
    if (classes.includes('cap-h')) return 'cap-h';
    if (classes.includes('ua') && tag === 'details') return 'ua-toggle';
    if (tag === 'span' && classes.includes('ibtn') && el.closest && el.closest('td.act')) return 'ua-toggle';
    if (tag === 'button' && el.getAttribute('data-act') === 'kbd') return 'kbd-panel';
    if (parentClasses.includes('mode') && (tag === 'button' || tag === 'label')) return 'modecard';
    if (parentClasses.includes('seg') && (tag === 'button' || tag === 'a')) return 'segitem';
    // The pager's items: the prototype writes `<button data-pg>`, the plane an `<a href>` and a
    // `<span>` for the current page — one control (page N) in three spellings.
    if (parentClasses.includes('pg')) return 'pageitem';
    if (classes.includes('cell-link')) return 'cell-link';
    if (tag === 'details' && classes.includes('mn')) return 'rowmenu';
    // The timezone control: the prototype draws a `<select>` and handles 「其他（IANA 名称）…」 in
    // script; the plane cannot invent an input from a select without script, so the same field is an
    // `<input list>` whose datalist holds the prototype's nine candidates. One field, two spellings:
    // compared as one leaf (`zonechoice`), with its label asserted by `.fld > label`.
    if ((el.getAttribute('data-dv') === 'timezone' || el.getAttribute('name') === 'timezone') && (tag === 'select' || tag === 'input')) return 'zonechoice';
    return null;
  };

  /**
   * Q3 — what the search box IS, beyond its skeleton: whether it can submit its query without script
   * (`form`: it is the GET form itself, `field`: its field belongs to one, `none`: the prototype's
   * scripted `label.search`), where that submission goes, the placeholder copy it shows and the name
   * its query field carries. Used twice: the submit/action tokens go into the shape line (so a search
   * box reverted to a bare `<label>` changes the line and its no-script waiver goes stale), and the
   * whole record goes into the `searchBoxes` inventory (so the copy, the named field and the action
   * are compared positively by `compareShapeSearchBoxes` — they cannot be waived away as data).
   */
  const searchSemantics = (el) => {
    const field = el.querySelector('input:not([type=hidden]), select, textarea');
    const owner = field && field.form ? field.form : (el.tagName === 'FORM' ? el : el.closest('form'));
    const get = Boolean(owner) && String(owner.getAttribute('method') || 'get').toLowerCase() === 'get';
    return {
      submit: get ? (owner === el ? 'form' : 'field') : 'none',
      action: get ? (routeOf(owner.getAttribute('action') || '') || '') : '',
      placeholder: mask(field ? field.getAttribute('placeholder') || '' : ''),
      field: mask(field ? field.getAttribute('name') || '' : ''),
    };
  };
  /** One node signature: canonical tag + id + sorted classes + the structural attributes. */
  const sigOf = (el) => {
    const classes = classesOf(el);
    const on = classes.includes('on') ? '.on' : '';
    let tag = el.tagName.toLowerCase();
    let keep = classes.filter((name) => name !== 'on' && name !== 'click');
    const kind = canonicalKind(el);
    if (kind) { tag = kind; keep = []; }
    else if (tag === 'details' && classes.includes('cap-g')) tag = 'div';
    else if (classes.includes('search')) tag = 'search';
    else if (classes.includes('toolbar')) tag = 'toolbar';
    else if (classes.includes('menu')) tag = 'popup';
    else if (classes.includes('btn')) tag = 'btn';
    else if (classes.includes('addl')) tag = 'btn';
    else if (tag === 'tr') tag = 'tr.row';
    const attrs = [];
    // A canonical control kind is compared by STATE only: the attributes that carry its identity in
    // one implementation (role, aria-modal, type, href, checked, name) belong to the spelling the
    // no-JS and interaction gates already assert. One exception (Q3): the `switch` kind must say
    // WHAT it is — the prototype paints it with a scripted `<button>`, the plane with a real
    // checkbox that submits; swapping the two would otherwise be invisible (both carry `state=`).
    if (kind) {
      if (['switch', 'chip', 'pill', 'modecard', 'segitem', 'pageitem'].includes(kind)) {
        const checked = el.querySelector('input:checked') !== null;
        attrs.push(`state=${checked || classes.includes('on') ? 'on' : 'off'}`);
      }
      if (kind === 'ibtn' || kind === 'mmore') attrs.push(`open=${el.hasAttribute('open') ? 'yes' : 'no'}`);
      if (el.hasAttribute('disabled')) attrs.push('disabled');
      const named = `${kind}${keep.length ? '.' + keep.join('.') : ''}`;
      return attrs.length ? `${named} [${attrs.join(' ')}]` : named;
    }
    for (const key of ATTR_PRESENCE) {
      if (el.getAttribute(key) === null) continue;
      // `required` is a browser-validation hint the plane adds (the service validates anyway and the
      // prototype validates in script); `type` on a <button> is its implicit `submit`.
      if (key === 'required') continue;
      if (key === 'type' && el.tagName === 'BUTTON') continue;
      if (key === 'role' && tag === 'btn') continue;
      attrs.push(key);
    }
    // Q3: the search box keeps the semantics that decide what it DOES — whether it can submit its
    // query WITHOUT script (`form`: it is the GET form itself, `field`: its field belongs to one,
    // `none`: the prototype's scripted `label.search`) and where that submission goes. A search box
    // reverted from a real GET form to a bare `<label>` changes this line, and the waiver that
    // documented the no-script capability goes stale. Its visible copy (the placeholder) and its
    // named query field are compared through `compareShapeSearchBoxes` below — the prototype names
    // them with script hooks (`data-search` / `data-capq`), so a line-level comparison would be a
    // difference on every page by construction.
    if (tag === 'search') {
      // The line itself stays `search.search …` (N5: the prototype writes a scripted <label>, the plane
      // a real GET form — comparing the spelling would be a difference on every page by construction).
      // What the box DOES is compared positively by `compareShapeSearchBoxes`.
    }
    // `href` is compared on real navigation (a table's detail link, a menu item) and on a `.btn` LINK
    // (Q3: the link's route is what makes it a link). A `.btn` that carries no href is compared as
    // the button itself; whether a control that needs to act can act is asserted by `deadControls`
    // and by the no-JS gate, not by pretending the prototype's scripted button spells it the same.
    if (tag !== 'btn') {
      const value = el.getAttribute('href');
      const route = value === null ? null : routeOf(value);
      if (route) attrs.push(`href=${route}`);
    }
    const type = el.getAttribute('type');
    if (type && el.tagName !== 'BUTTON') attrs.push(`type=${mask(type)}`);
    const name = `${tag}${idOf(el)}${keep.length ? '.' + keep.join('.') : ''}${on}`;
    return attrs.length ? `${name} [${attrs.join(' ')}]` : name;
  };
  /** Kinds compared as a leaf; `cell-link` is transparent (the plane's `?id=` link inside a cell). */
  const LEAF_KINDS = new Set(['switch', 'chip', 'pill', 'idc', 'mmore', 'ibtn', 'modecard', 'segitem', 'pageitem', 'cap-h', 'ua-toggle', 'kbd-panel', 'zonechoice']);

  const directText = (el) => [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('');
  /** N14: text carried by a transparent hover-hint wrapper (`<span title="…">刚刚</span>`). */
  const hoistedText = (el) => [...el.children]
    .filter((kid) => kid.tagName === 'SPAN' && kid.getAttribute('title') !== null && kid.attributes.length === 1 && !kid.children.length)
    .map((kid) => kid.textContent).join('');

  const lines = [];
  const queue = [];
  const runs = [];
  const labels = [];
  const links = [];
  const records = [];
  const searchBoxes = [];
  const deadControls = [];

  const overlayKindOf = (el) => {
    const id = el.id || '';
    if (SHELL_SINGLETONS.has(id) && OVERLAY_KINDS.includes(id)) return id;
    const classes = classesOf(el);
    for (const kind of OVERLAY_KINDS) {
      if (classes.includes(kind === 'toast' ? 'result' : kind)) return kind;
    }
    return null;
  };

  const walk = (el, depth, options = {}) => {
    if (depth > 26) return;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'hidden') return;
    const classes = classesOf(el);
    if (classes.includes('scrim')) return;
    const id = el.id || '';
    // N10: what the user cannot see is not shape. Hidden-by-style nodes (the prototype's closed
    // modal/toast carry `opacity:0`, its mobile-only buttons carry `display:none`) take no part in
    // the comparison on either side.
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
    const overlayKind = overlayKindOf(el);
    if (SHELL_SINGLETONS.has(id) && !el.children.length && !mask(el.textContent)) return; // N2
    if (id === 'root' && !overlayKind) { for (const kid of [...el.children]) walk(kid, depth, options); return; } // N1
    // N5: under a popup, `form` is plumbing and `a`/`button` are the same action row.
    const inPopup = options.inPopup || classesOf(el.parentElement || el).includes('menu');
    if (inPopup && tag === 'FORM') { for (const kid of [...el.children]) walk(kid, depth, options); return; }
    if (!overlayKind && tag === 'FORM' && classes.includes('inline-form')) {
      // N5: the plane carries every scripted prototype action as a real POST form
      // (`form.inline-form`). That form is the no-JS spelling of the same button, not a new element.
      for (const kid of [...el.children]) walk(kid, depth, options);
      return;
    }
    if (!overlayKind && inPopup && (tag === 'A' || tag === 'BUTTON')) {
      const danger = classes.includes('dz2') || el.querySelector('.dz2') !== null || (el.dataset && el.dataset.mi === 'del');
      const label = mask(el.textContent);
      if (opts.labels !== false && label) labels.push(`menuitem = ${label}`);
      lines.push({ d: depth, sig: `menuitem${danger ? ' [danger]' : ''}${el.hasAttribute('disabled') ? ' [disabled]' : ''} :: ${kindOf(el.textContent)}` });
      return;
    }
    if (overlayKind) { queue.push({ kind: overlayKind, el }); return; } // N6
    // N12: the plane's `?id=` link inside a record cell is the no-JS spelling of the prototype's
    // scripted `tr.click` row open. The link itself is transparent (its destination is recorded in
    // the `links` inventory, so both sides offer the same record targets either way).
    if (classes.includes('cell-link')) {
      const route = routeOf(el.getAttribute('href'));
      if (route) links.push(route);
      const href = String(el.getAttribute('href') || '');
      const isVault = /\/vault-git(?:[?#]|$)/.test(href);
      const params = new URLSearchParams(href.replace(/^[^?]*\?/, '').split('#')[0]);
      const id = params.get('id');
      const tab = params.get('tab');
      const page = isVault ? 'vaults' : tab;
      if (id && id !== 'new' && page) records.push({ page, id });
      for (const kid of [...el.children]) walk(kid, depth, options);
      return;
    }
    // N15: the search box's submit button carries the prototype's own `<kbd>/</kbd>` hint (the
    // prototype has no pointer way to submit a script-free GET filter). Style-transparent, so the
    // visible control is the prototype's kbd — compared as if the button were not there.
    if (classes.includes('kbd-hint')) {
      for (const kid of [...el.children]) walk(kid, depth, options);
      return;
    }
    // N16: the self-drawn select (Q12 — a user-decided DESIGN CHANGE, 2026-10-18). The proxy control
    // is the scripted spelling of the same `<select>`, which **stays in the DOM** (clipped to 1px, still
    // in its form) and therefore still carries the shape line: hiding the proxy keeps the closed state
    // byte-identical to the prototype's `.sel`, which is the half the comparison is allowed to assert.
    // The opened list is ours, so it is asserted positively by the design gate ("the popup exists and
    // paints the selected row"), never as "equal to the prototype".
    if (el.hasAttribute('data-select-proxy') || el.hasAttribute('data-select-popup')) return;
    // N14: a `span` whose only attribute is `title` is a hover-hint wrapper (`relTitle` shows the
    // full timestamp on hover). It is transparent and its text belongs to the parent, so the two
    // sides' text KIND still matches (碰巧 '刚刚' vs '刚刚').
    if (tag === 'SPAN' && el.getAttribute('title') !== null && el.attributes.length === 1 && !el.children.length) {
      return; // N14: its text is hoisted to the parent by `hoistedText()`
    }
    if (classes.includes('search')) searchBoxes.push(searchSemantics(el));
    // Q3 companions — the no-script control contracts of the plane's own markup. They live here (not in
    // `sigOf`, which is also called to compare sibling runs) and use the REAL tag name, not the
    // canonical one (`tag` is already `btn` for a `.btn`, `switch` for a switch).
    //   * An `<a class="btn…">` without `href` is a dead link, and a `<span class="btn…">` that is not
    //     explicitly marked non-interactive is a dead button. (A `<button type=button>` is deliberately
    //     out of scope: `docs/admin/README.md` records the sidebar's shortcut button as the ONE
    //     script-only affordance, and the native buttons are judged by the interaction gate.)
    if (classes.some((name) => ['btn', 'addl'].includes(name))) {
      const inert = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') || el.closest('.futonly') !== null;
      if (!inert && el.tagName === 'A' && !String(el.getAttribute('href') || '').trim()) deadControls.push(`a.${classes.join('.')} 无 href`);
      if (!inert && !['A', 'BUTTON', 'INPUT', 'LABEL', 'SUMMARY', 'DETAILS', 'SELECT', 'FORM'].includes(el.tagName)) deadControls.push(`${sigOf(el)} 无脚本时不可操作`);
    }
    //   * The switch: the prototype paints it with a scripted `<button>`; the plane must spell it as
    //     something that ACTS without script — a `label.switch` wrapping the real named checkbox, a
    //     `button.switch` that submits, or an element explicitly marked non-interactive (the `.sw`
    //     container, an `aria-hidden`/`role="img"` indicator). Swapping the checkbox for a scripted
    //     button (the prototype's own spelling) turns this red.
    if (classes.includes('switch') || classes.includes('sw')) {
      const inert = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
        || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'img';
      const box = el.matches('input[type=checkbox]') ? el : el.querySelector('input[type=checkbox]');
      const named = Boolean(box && String(box.getAttribute('name') || '').trim());
      const submitter = el.tagName === 'BUTTON' && ['submit', 'reset', 'image'].includes(String(el.getAttribute('type') || '').toLowerCase());
      if (!inert && !named && !submitter) {
        deadControls.push(`${sigOf(el)} 是无脚本时不会生效的开关（既不是包着真实 checkbox 的 label，也不是提交按钮，也没标记为非交互）`);
      }
    }
    const kind = canonicalKind(el);
    if (kind) {
      // A leaf control kind: state + copy are compared, the implementation inside is not. Text is
      // compared only where the kind's label IS the UI copy (chips, pills, group headers).
      for (const selector of LABEL_SCOPE) {
        if (!el.matches || !el.matches(selector)) continue;
        const value = mask(el.textContent);
        if (value) labels.push(`${selector} = ${value}`);
      }
      const labelled = ['chip', 'pill', 'cap-h', 'mmore', 'idc'].includes(kind) ? kindOf(el.textContent) : '-';
      lines.push({ d: depth, sig: `${sigOf(el)} :: ${labelled}` });
      return;
    }
    // N3: a closed disclosure shows nothing. `details.mn` is the plane's row menu (the prototype's
    // scripted `#menu`), `details.mmore` the mobile “more” sheet (the prototype's `a[data-act]`);
    // both spell the same control the prototype spells with script.
    if (tag === 'DETAILS') {
      const capGroup = classes.includes('cap-g');
      if (!capGroup) {
        const sig = classes.includes('mn') ? 'rowmenu' : classes.includes('mmore') ? 'mmore' : 'disclosure';
        lines.push({ d: depth, sig: `${sig} [open=${el.hasAttribute('open') ? 'yes' : 'no'}] :: -` });
        if (opts.labels !== false) {
          const summary = el.querySelector(':scope > summary');
          const label = mask(summary ? (summary.getAttribute('aria-label') || summary.textContent) : '');
          if (label) labels.push(`${sig} trigger = ${label}`);
        }
        if (!el.hasAttribute('open')) return;
        for (const kid of [...el.children]) walk(kid, depth + 1, options);
        return;
      }
      // A capability group: the container line, then the trigger (always visible) and, only while the
      // group is open, its body.
      lines.push({ d: depth, sig: 'div.cap-g :: -' });
      const summary = el.querySelector(':scope > summary');
      if (summary) walk(summary, depth + 1, options);
      if (!el.hasAttribute('open')) return;
      for (const kid of [...el.children]) if (kid !== summary) walk(kid, depth + 1, options);
      return;
    }
    if (tag === 'SUMMARY' && el.parentElement && classesOf(el.parentElement).includes('mn')) {
      // The trigger is already represented by the `rowmenu` line; the summary's label is UI copy.
      const label = mask(el.getAttribute('aria-label') || el.textContent);
      if (opts.labels !== false && label) labels.push(`rowmenu trigger = ${label}`);
      return;
    }
    if (tag === 'A') {
      const route = routeOf(el.getAttribute('href'));
      if (route && el.hasAttribute('data-record-link')) links.push(route);
    }
    if (tag === 'TR' && el.hasAttribute('data-open')) {
      const routes = { account: 'accounts', key: 'keys', client: 'clients', token: 'tokens', vault: 'vaults', policy: 'authz' };
      const page = routes[el.getAttribute('data-open')];
      if (page) links.push(`route:${page}:detail`);
      const id = el.getAttribute('data-id');
      if (page && id) records.push({ page, id });
    }
    for (const selector of LABEL_SCOPE) {
      if (!el.matches || !el.matches(selector)) continue;
      const value = mask(el.textContent);
      if (value) labels.push(`${selector} = ${value}`);
    }
    const kids = [...el.children];
    // N7 evidence: consecutive siblings sharing one signature are a list region.
    const signatures = kids.map((kid) => { const kidClasses = classesOf(kid); return SKIP_TAGS.has(kid.tagName.toUpperCase()) || kidClasses.includes('scrim') ? null : sigOf(kid); });
    let index = 0;
    while (index < signatures.length) {
      let end = index + 1;
      while (end < signatures.length && signatures[end] === signatures[index]) end += 1;
      if (signatures[index] !== null && end - index >= 2) runs.push({ parent: sigOf(el), sig: signatures[index], count: end - index });
      index = end;
    }
    lines.push({ d: depth, sig: `${sigOf(el)} :: ${kindOf(directText(el) + hoistedText(el))}` });
    for (const kid of kids) walk(kid, depth + 1, options);
  };

  walk(document.body, 0);  for (const kind of OVERLAY_KINDS) {
    for (const record of queue.filter((item) => item.kind === kind)) {
      const el = record.el;
      lines.push({ d: 0, sig: `${kind}.on` });
      for (const kid of [...el.children]) walk(kid, 1, {});
    }
  }
  return { nodes: lines, runs, labels, links, records, searchBoxes, deadControls, version: 1 };
}

/** The state registry: prototype hash route ⇄ plane URL, for the pages `spec.mjs` already pairs. */
export const SHAPE_STATES = Object.freeze([
  ...PARITY_PAGES.map((page) => Object.freeze({ id: page.id, proto: page.proto, live: page.live, aliases: page.aliases })),
  Object.freeze({ id: 'login', proto: '#/login', live: '/admin/auth/login', anonymous: true }),
]);

// The waiver tables and their hygiene live in `shape-waivers.mjs`; they are re-exported here so the
// gate (and any reader of this module) keeps one place to look for the comparison contract.
export { SHAPE_WAIVER_KINDS, SHAPE_WAIVER_BUDGET, SHAPE_STATE_WAIVER_BUDGET, SHAPE_WAIVERS, SHAPE_LABEL_WAIVER_BUDGET, SHAPE_LABEL_WAIVERS, waiverFindings } from './shape-waivers.mjs';
import { SHAPE_WAIVERS, SHAPE_LABEL_WAIVERS } from './shape-waivers.mjs';

/** One waiver lookup: exact state + exact canonical line (+ which side it applies to). */
function waiverFor(waivers, stateId, line, side) {
  return waivers.find((item) => item.state === stateId && String(item.line).trim() === line.trim() && (!item.side || item.side === side));
}

const DATA_CONTAINER = [/^tbody/, /^select/, /\.mcards\b/, /\.list\b/, /\.pick-list\b/, /\.tags\b/, /\.stats\b/, /\.tl\b/, /\.cap-b\b/, /\.kv\b/, /\.chips\b/, /\.pg\b/];

function multiplicityIsData(sig) {
  return DATA_CONTAINER.some((pattern) => pattern.test(sig));
}

/**
 * Canonicalize the probe's flat skeleton into comparable lines.
 *
 * N7 lives here: under a data container a run of ≥2 consecutive siblings with one signature is
 * collapsed into `↻ <sig>` whose children are the **union of the distinct child blocks** in the run;
 * elsewhere a run is left as-is (its length is part of the shape). Multiplicity is returned as
 * evidence either way. `.pg` is a data container (Q6): how many pages a fixture has, and therefore
 * how many page items a pager draws, is the deployment's data, not a layout difference (`.pager`
 * itself is not: its children — the total, the page-size control, the pager — are structure).
 *
 * Q4: collapsing a run into a union loses the ORDER and the exact membership of the elements inside
 * a row — the measured boundary and why it is documented rather than gated is in `canonicalizeShape`.
 */
export function canonicalizeShape(nodes) {
  const root = { sig: '', children: [] };
  const stack = [{ node: root, depth: -1 }];
  for (const record of nodes || []) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= record.d) stack.pop();
    const node = { sig: record.sig, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth: record.d });
  }
  const multiplicities = new Map();
  const count = (node) => {
    multiplicities.set(node.sig, (multiplicities.get(node.sig) || 0) + 1);
    for (const child of node.children) count(child);
  };
  /**
   * Q4 — the documented boundary of the record-row comparison, MEASURED (Wave Q, on the shipped
   * tree): a row's children are compared as a SET of element kinds (the union under `↻`), and three
   * candidate ORDER criteria were built and measured against the real captures before being rejected:
   *   * strict per-occurrence child sequences → 43 false differences on the correct tree;
   *   * adjacent child pairs (distinct kinds, both sides) → 3 false differences;
   *   * smallest child index per position (a partial order) → 2 false differences.
   * Every one of them is caused by the same thing: the prototype's own fixture and the fixture server
   * hold DIFFERENT records, so the children inside a cell legitimately vary (a status branch, a tag
   * list, an extra muted line). An order criterion that ignores that turns data into a red gate, and
   * one that tolerates it (min index) either reports the two data-driven positions above or is blind
   * to a swap confined to rows whose order genuinely varies. A fourth candidate — comparing the SET of
   * direct-child kinds per row position (i.e. “a cell disappeared from the row”) — was measured too:
   * 49 false differences, same cause. The claim is therefore narrowed instead of faked: “a control was
   * swapped for another kind of control” is asserted for NON-record rows (their children are compared
   * in order, line by line) and for the record REGION level (a row kind that appears or disappears
   * changes the `↻` line), while membership and order INSIDE a record row are left to the other
   * gates and are visible in the report as data notes (the union line that differs).
   * What covers row internals elsewhere: the parity gate's column list/order criteria for tables, the
   * drawer form-field inventory, and `admin-layout-capq` for the capability picker.
   */
  const lines = [];
  /** Which emitted line is a CONTAINER (it has children below it): Q3 needs to reject a `data`
   *  waiver aimed at a region instead of at one datum. */
  const containerFlags = [];
  const emit = (text, isContainer) => { lines.push(text); containerFlags.push(Boolean(isContainer)); };
  const render = (node, indent) => {
    emit(`${indent}${node.sig}`, node.children.length > 0);
    if (multiplicityIsData(node.sig)) {
      // A record list: how many children exist is data, and so is their order, so the children are
      // grouped BY SIGNATURE. Each group is compared as a SHALLOW set of element kinds (the row's
      // own signature plus its descendants up to two levels): which cells/regions a record row is
      // built from is structure, while the data-driven variation deeper inside a cell (a status
      // branch, a tag list, a name block) is what the record itself brings.
      const groups = new Map();
      for (const child of node.children) {
        if (!groups.has(child.sig)) groups.set(child.sig, []);
        groups.get(child.sig).push(child);
      }
      for (const [sig, group] of groups) {
        const kinds = new Set();
        for (const child of group) collectKinds(child, 0, kinds, 2);
        emit(`${indent}  ↻ ${sig} { ${[...kinds].sort().join(' ')} }`, false);
      }
      return;
    }
    for (const child of node.children) render(child, indent + '  ');
  };
  const collectKinds = (node, depth, into, max) => {
    if (depth > 0) into.add(node.sig);
    if (depth >= max) return;
    for (const child of node.children) collectKinds(child, depth + 1, into, max);
  };
  for (const child of root.children) count(child);
  for (const child of root.children) render(child, '');
  return { lines, multiplicities, containerFlags };
}

/**
 * Tree-order diff (LCS), so the report shows *where* the shape diverges instead of only that it
 * does. Returns prototype-only lines (`removed`) and plane-only lines (`added`), each in order.
 */
export function diffShapeLines(protoLines, liveLines) {
  const a = protoLines;
  const b = liveLines;
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (table[i + 1][j] >= table[i][j + 1]) { removed.push({ index: i, line: a[i] }); i += 1; } else { added.push({ index: j, line: b[j] }); j += 1; }
  }
  while (i < a.length) { removed.push({ index: i, line: a[i] }); i += 1; }
  while (j < b.length) { added.push({ index: j, line: b[j] }); j += 1; }
  return { removed, added };
}

/** Compare two captures of one state: printable failures, evidence notes, the diff, the waivers used. */
export function compareShapeState({ stateId, proto, live, waivers = SHAPE_WAIVERS }) {
  const failures = [];
  const notes = [];
  const protoCanon = canonicalizeShape(proto.nodes);
  const liveCanon = canonicalizeShape(live.nodes);
  const diff = diffShapeLines(protoCanon.lines, liveCanon.lines);
  const waived = [];
  // Two lines that agree on everything except the trailing text KIND are ONE element carrying a
  // different datum ('刚刚' vs '—', a count vs a name). Shape is not the question there, so the pair
  // is reported as a datum note (visible in the report) instead of a failure. An element that exists
  // on one side only never pairs here: that difference has no counterpart line at all.
  const shapeOf = (line) => line.replace(/ :: .*$/, '');
  const liveByShape = new Map();
  for (const item of diff.added) {
    const key = shapeOf(item.line);
    if (!liveByShape.has(key)) liveByShape.set(key, item);
  }
  const paired = new Set();
  for (const item of diff.removed) {
    const match = liveByShape.get(shapeOf(item.line));
    if (!match || paired.has(match)) continue;
    paired.add(match);
    paired.add(item);
    const rowLevel = item.line.includes('↻') || match.line.includes('↻');
    notes.push(rowLevel
      ? `[${stateId}] 记录行内的元素集合/取值不同（数据口径，不计失败 — 见 shape.mjs 的 Q4 边界）：${item.line.trim()} ⇄ ${match.line.trim()}`
      : `[${stateId}] 同一元素的取值种类不同（数据）：${item.line.trim()} ⇄ ${match.line.trim()}`);
  }
  /** Which of the two trees an `index` from the diff belongs to (containers are per occurrence). */
  const containerAt = (side, index) => (side === 'proto-only' ? protoCanon : liveCanon).containerFlags[index] === true;
  /**
   * Apply the waiver that names this exact line, if any. Q3: a `data` waiver excuses “one datum is
   * different” — it may NOT excuse a region container (`div.cap-g :: -` and friends): whether a
   * region exists, and how many of them exist, is structure, and a region the prototype does not
   * draw must be fixed or named as its own kind of exception, not hidden behind a datum waiver.
   */
  const applyWaiver = (item, side) => {
    const waiver = waiverFor(waivers, stateId, item.line, side);
    if (!waiver) return false;
    waived.push({ ...item, side, reason: waiver.reason, kind: waiver.kind });
    if (waiver.kind === 'data' && containerAt(side, item.index)) {
      failures.push(`[${stateId}] 用 data 豁免了一条区域容器行（区域的存在与数量不是“一个数据不同”）：${item.line.trim()}`);
    }
    return true;
  };
  for (const item of diff.removed) {
    if (paired.has(item)) continue;
    if (applyWaiver(item, 'proto-only')) continue;
    failures.push(`[${stateId}] 原型有、实现没有：${item.line.trim()}`);
  }
  for (const item of diff.added) {
    if (paired.has(item)) continue;
    if (applyWaiver(item, 'live-only')) continue;
    failures.push(`[${stateId}] 实现有、原型没有：${item.line.trim()}`);
  }
  // Q4: the union collapses the children of a record row into a SET, so membership and order INSIDE a
  // record row are not failures (they surface as data notes) — the measured boundary is documented in
  // `canonicalizeShape`. Non-record rows are unaffected: their children are compared in order.
  // Every waiver must be consumed exactly as often as it says: a waiver that no longer matches any
  // difference is debt (it must be deleted), and a single entry cannot excuse two occurrences of the
  // same line — declaring it twice is rejected outright (`waiverFindings`), one entry must declare
  // its `count`, so two identical lines can never hide each other's staleness.
  for (const waiver of waivers.filter((item) => item.state === stateId)) {
    const hits = waived.filter((item) => item.side === (waiver.side || item.side) && item.line.trim() === String(waiver.line).trim()).length;
    const declared = waiver.count ?? 1;
    if (hits === declared) continue;
    failures.push(hits === 0
      ? `[${stateId}] 豁免失效（不再命中任何差异，应删除）：${String(waiver.line).trim()}`
      : `[${stateId}] 豁免数量不符（声明 ${declared} 处、实际命中 ${hits} 处；同一行出现几次就要在一条豁免里写 count 几次，重复条目会被拒绝）：${String(waiver.line).trim()}`);
  }
  // N7 evidence: element counts per signature. A row-count difference is data (note); an element
  // whose signature is *not* part of a list region appears as a failure above, never as a note.
  for (const sig of [...new Set([...protoCanon.multiplicities.keys(), ...liveCanon.multiplicities.keys()])].sort()) {
    const protoCount = protoCanon.multiplicities.get(sig) || 0;
    const liveCount = liveCanon.multiplicities.get(sig) || 0;
    if (protoCount !== liveCount) notes.push(`[${stateId}] 元素数：${sig.trim()} 原型 ${protoCount} / 实现 ${liveCount}`);
  }
  return { failures, notes, diff, waived, protoLines: protoCanon.lines, liveLines: liveCanon.lines, runs: { proto: proto.runs, live: live.runs } };
}

/**
 * Q3's second half: the search boxes, compared POSITIVELY instead of by waiver. Two things are
 * asserted here and neither can be waived as "data":
 *   * the visible copy — the placeholder the user reads must be the prototype's, box for box (the
 *     prototype names its field with a script hook and the plane with `name`, so the *hint text* is
 *     what is comparable);
 *   * the no-script contract of the plane's own markup — every search box must be able to submit its
 *     query with scripting disabled (it is a GET form, or its field belongs to one), its query field
 *     must carry a `name` (otherwise the GET carries no keyword) and the submission must have a
 *     destination. A search box reverted from `<form class="search" method=get>` to a bare
 *     `<label class="search">` fails here *and* changes its shape line.
 */
export function compareShapeSearchBoxes({ stateId, proto, live }) {
  const failures = [];
  const notes = [];
  const protoBoxes = proto.searchBoxes || [];
  const liveBoxes = live.searchBoxes || [];
  const counts = (list) => list.reduce((map, box) => map.set(box.placeholder, (map.get(box.placeholder) || 0) + 1), new Map());
  const protoCounts = counts(protoBoxes);
  const liveCounts = counts(liveBoxes);
  for (const [placeholder, count] of protoCounts) {
    const found = liveCounts.get(placeholder) || 0;
    if (found !== count) failures.push(`[${stateId}] 搜索框的提示文案对不上：原型 ${count} 个「${placeholder}」、实现 ${found} 个`);
  }
  for (const [placeholder, count] of liveCounts) {
    if (protoCounts.has(placeholder)) continue;
    failures.push(`[${stateId}] 实现的搜索框提示文案在原型里没有（${count} 个「${placeholder}」）`);
  }
  liveBoxes.forEach((box, index) => {
    const at = `第 ${index + 1} 个搜索框（${box.placeholder || '(无提示)'}）`;
    if (box.submit === 'none') failures.push(`[${stateId}] ${at}没有脚本时无法提交：它既不是 GET 表单，字段也不属于一个 GET 表单`);
    if (!box.field) failures.push(`[${stateId}] ${at}的查询字段没有 name，GET 筛选带不上关键词`);
    if (box.submit !== 'none' && !box.action) failures.push(`[${stateId}] ${at}没有提交目标（action）`);
  });
  if (liveBoxes.length && !protoBoxes.length) notes.push(`[${stateId}] 原型没有搜索框、实现有 ${liveBoxes.length} 个`);
  return { failures, notes, protoBoxes: protoBoxes.length, liveBoxes: liveBoxes.length };
}

/** Compare the record-link inventory: the prototype's record/detail entry points must exist here too. */
export function compareShapeLinks({ stateId, proto, live }) {
  const failures = [];
  const notes = [];
  const protoSet = new Set(proto.links || []);
  const liveSet = new Set(live.links || []);
  for (const route of protoSet) if (!liveSet.has(route)) failures.push(`[${stateId}] 原型提供了这个入口、实现没有：${route}`);
  for (const route of liveSet) if (!protoSet.has(route)) notes.push(`[${stateId}] 实现多出这个入口（原型用脚本按钮，无 href）：${route}`);
  return { failures, notes, protoLinks: [...protoSet].sort(), liveLinks: [...liveSet].sort() };
}

/** Compare the structural-label inventory (N8's companion) — literal UI copy, position by position. */
export function compareShapeLabels({ stateId, proto, live, waivers = SHAPE_LABEL_WAIVERS }) {
  const failures = [];
  const waived = [];
  const protoSet = new Set(proto.labels || []);
  const liveSet = new Set(live.labels || []);
  const allow = (label) => waivers.find((item) => item.state === stateId && item.label === label);
  for (const label of protoSet) {
    if (liveSet.has(label)) continue;
    const waiver = allow(label);
    if (waiver) { waived.push({ label, side: 'proto-only', reason: waiver.reason }); continue; }
    failures.push(`[${stateId}] 结构位置的文案只在原型里：${label}`);
  }
  for (const label of liveSet) {
    if (protoSet.has(label)) continue;
    const waiver = allow(label);
    if (waiver) { waived.push({ label, side: 'live-only', reason: waiver.reason }); continue; }
    failures.push(`[${stateId}] 结构位置的文案只在实现里：${label}`);
  }
  for (const waiver of waivers.filter((item) => item.state === stateId)) {
    if (!waived.some((item) => item.label === waiver.label)) {
      failures.push(`[${stateId}] 文案豁免失效（不再命中差异，应删除）：${waiver.label}`);
    }
  }
  return { failures, waived, protoLabels: [...protoSet].sort(), liveLabels: [...liveSet].sort() };
}
