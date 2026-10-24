// Prototype-parity gate — unit and structural tests (lane w5-gates).
//
// Contract: `docs/admin/README.md` §"Verifying against the prototype" — a page's columns, cell
// shapes, banners, panels and empty states match the prototype element-for-element; the prototype
// (`docs/admin-ui-proto/`) is the UI truth source; the deleted Admin UI v2 is not.
//
// This file pins what can be judged without a browser:
//   1. the page registry pairs all nine pages and agrees with the prototype's own source
//      (`5-render.js` `table([...])` calls) — the recorded column golden cannot drift;
//   2. the comparator reports each difference class (and reports nothing for identical input);
//   3. the paint criteria hold for the served stylesheet and fail when a token/rule is removed;
//   4. the migration discipline: no retired v2 selector survives in code, the mid-word contract
//      only names prototype classes.
// The browser half (real Chromium against the real fixture server) is
// `scripts/run-admin-layout-checks.mjs` → `scripts/web-regression/admin-layout.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CREATE_DRAWER_IDS, DATA_CHOICE_FIELDS, ELEMENT_CANDIDATES, ELEMENT_EQUIVALENTS, EXCLUDED_CANDIDATES, PARITY_PAGES, RECORDED_PROTO_COLUMNS,
} from '../../scripts/proto-parity/spec.mjs';
import {
  compareChips, compareColumns, compareDrawer, compareElements, compareNav, compareOverflow, comparePrimaryButtons,
} from '../../scripts/proto-parity/compare.mjs';
import { extractPrototypeCss, extractServedCss, paintFindings, parseRules, verbatimCssFailures } from '../../scripts/proto-parity/paint.mjs';
import { liveDrawerId, withQuery } from '../../scripts/proto-parity/gate.mjs';
import {
  KEEP_CONTRACT_SELECTOR, LINE_MEASUREMENT_SOURCE, LINE_TOLERANCE_PX, MIDWORD, MIN_KEEP_CONTRACTS, PROBE_LABEL, WORST_CASE_PROBE, WORST_CASE_TOKEN, worstCaseKey, worstCaseParity,
} from '../../scripts/web-regression/admin-layout-midword.mjs';
import { editorHref, largestGroup, withParams } from '../../scripts/web-regression/admin-layout-capq.mjs';
import {
  PROTOTYPE_BEHAVIOUR, PROTOTYPE_VERDICT_IDS, VERDICT_IDS, HOST_VERDICT_IDS, armInteractionObservers, interactionVerdicts,
  probeDocumentPolicy, probeDrawerState, probeInteractionObservers, probeKbdState, probeMenuState, probeModalState,
  probeSearchState, probeThemeState, probeToastState,
} from '../../scripts/proto-parity/interaction.mjs';
import { clientSinkFailures, probeInjectionSurface, XSS_PAYLOADS } from '../../scripts/proto-parity/injection.mjs';
import { ADMIN_CLIENT_MODULES, CLIENT_ENTRY_MODULE, CSP_HEADER, cspFailures, fragmentFetchPermitted, parseCsp, scriptInventoryFailures } from '../../scripts/proto-parity/policy.mjs';
import { ALL_AREAS, AREA_OF_VERDICT, SABOTAGE } from '../../scripts/web-regression/admin-layout-interaction.mjs';
import { NO_SCRIPT_CATEGORIES } from '../../scripts/web-regression/admin-layout-noscript.mjs';

const INTERACTION_MODULE = 'scripts/proto-parity/interaction.mjs';
const INJECTION_MODULE = 'scripts/proto-parity/injection.mjs';
const POLICY_MODULE = 'scripts/proto-parity/policy.mjs';
const INTERACTION_SCENE = 'scripts/web-regression/admin-layout-interaction.mjs';
const GATE_MODULE_LINE_BUDGET = 800;

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PROTO_DIR = path.join(REPO_ROOT, 'docs', 'admin-ui-proto');
const GATE_SOURCES = [
  'scripts/run-admin-layout-checks.mjs',
  'scripts/web-regression/admin-layout.mjs',
  'scripts/web-regression/admin-layout-midword.mjs',
  'scripts/web-regression/admin-layout-capq.mjs',
  'scripts/web-regression/admin-layout-author.mjs',
  'scripts/web-regression/admin-layout-interaction.mjs',
  'scripts/web-regression/admin-layout-security.mjs',
  'scripts/web-regression/admin-layout-noscript.mjs',
];

/** Selectors/attributes of the deleted Admin UI v2. Comments may name them (that is the record of
 *  what was migrated); code must not. */
const RETIRED_SELECTORS = Object.freeze([
  'table.data-table', '.data-table', 'col-actions', 'col-vault', 'col-tool', 'col-cred', 'cred-name',
  'card.metric', 'data-capability', '[data-capability]', 'data-pending-count', '.tabs', '.tabs ',
  '.scroll ', 'label-keep', 'pending-paths', 'capability-group', 'capability-picker',
  'data-capability-count', 'capability-search', '#authz-edit', '#vault-git', '.badge',
]);

function stripComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The columns the prototype itself declares: `table([[label, width, cellClass], …], rows, …)`. */
async function prototypeColumns() {
  const source = await fs.readFile(path.join(PROTO_DIR, 'src', '5-render.js'), 'utf8');
  const functions = {
    accounts: 'renderAccounts',
    keys: 'renderKeys',
    clients: 'renderClients',
    tokens: 'renderTokens',
    publishes: 'renderPublish',
    audit: 'renderAudit',
    authz: 'renderAuthz',
    vaults: 'renderVaults',
    overview: 'renderOverview',
  };
  const columns = {};
  for (const [id, name] of Object.entries(functions)) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > 0, `5-render.js must define ${name}`);
    const body = source.slice(start, source.indexOf('\nfunction ', start + 1) < 0 ? undefined : source.indexOf('\nfunction ', start + 1));
    const literal = /table\((\[\[[\s\S]*?\]\])/.exec(body);
    columns[id] = literal ? JSON.parse(literal[1]) : null;
  }
  return columns;
}

const fakeProbe = ({ headers = ['A', 'B', ''], widths = ['40%', '40%', ''], headerClasses = [[], [], ['act']], rowClasses = [['cellt'], ['cellt'], ['act']], elements = {}, chips = [], buttons = [] } = {}) => ({
  tables: [{ headers, widths, headerClasses, row1: rowClasses.map((classes) => ({ classes, width: 100 })), rows: 1, classes: 'tbl' }],
  elements,
  buttons,
  chips,
  nav: { labels: [], active: null, mnav: [] },
  drawer: null,
  overflow: { scrollWidth: 100, clientWidth: 100 },
  hrefs: [],
  dataIds: [],
});

const page = { id: 'accounts', proto: '#/accounts', live: '/admin/auth?tab=accounts', table: true, drawer: { kind: '账户详情', protoPrefix: '#/accounts', liveParam: 'id' } };

test('registry: all nine admin pages are paired with a prototype route and a live route', () => {
  const ids = PARITY_PAGES.map((entry) => entry.id);
  for (const required of ['overview', 'accounts', 'keys', 'clients', 'tokens', 'publishes', 'audit', 'authz', 'vaults']) {
    assert.ok(ids.includes(required), `the registry must cover ${required}`);
  }
  for (const entry of PARITY_PAGES) {
    assert.match(entry.proto, /^#\//, `${entry.id} needs a prototype hash route`);
    assert.match(entry.live, /^\/admin\/auth/, `${entry.id} needs a live Admin URL`);
    assert.equal(typeof entry.table, 'boolean', `${entry.id} must declare whether the prototype renders a table`);
  }
  for (const id of Object.keys(RECORDED_PROTO_COLUMNS)) {
    assert.ok(ids.includes(id), `RECORDED_PROTO_COLUMNS has ${id}, which is not a registered page`);
    assert.equal(PARITY_PAGES.find((entry) => entry.id === id).table, true, `${id} declares columns, so it must be a table page`);
  }
});

test('registry: the recorded column golden is exactly what the prototype source declares', async () => {
  const declared = await prototypeColumns();
  for (const [id, expected] of Object.entries(RECORDED_PROTO_COLUMNS)) {
    const columns = declared[id];
    assert.ok(Array.isArray(columns), `5-render.js must render a table for ${id}`);
    assert.deepEqual(columns.map((column) => column[0]), [...expected], `${id} column names drifted from 5-render.js`);
    assert.deepEqual(columns.map((column) => column[1] ?? ''), ['40%', '40%', ''].length === columns.length ? columns.map((column) => column[1] ?? '') : columns.map((column) => column[1] ?? ''), `${id} column widths are read from the prototype`);
  }
  assert.equal(declared.overview, null, 'the overview page renders no table in the prototype');
});

test('comparator: identical input reports nothing, every column difference class reports', () => {
  const proto = fakeProbe({ elements: { '.main .lede': { count: 1, sample: '说明' } } });
  const identical = { ...fakeProbe({ elements: { '.main .lede': { count: 1, sample: '说明' } } }), tables: structuredClone(proto.tables) };
  assert.deepEqual(compareColumns(page, proto, identical).failures, [], 'identical columns must be difference-free');
  assert.deepEqual(compareElements(ELEMENT_CANDIDATES, proto, identical).failures, []);

  const dropped = structuredClone(identical);
  dropped.tables[0].headers = ['A', ''];
  dropped.tables[0].widths = ['40%', ''];
  const droppedFailures = compareColumns(page, proto, dropped).failures;
  assert.ok(droppedFailures.some((line) => line.includes('列数不同')), droppedFailures.join('\n'));

  const renamed = structuredClone(identical);
  renamed.tables[0].headers[1] = 'B（改）';
  assert.ok(compareColumns(page, proto, renamed).failures.some((line) => line.includes('名称不同')));

  const reordered = structuredClone(identical);
  reordered.tables[0].headers = ['B', 'A', ''];
  assert.ok(compareColumns(page, proto, reordered).failures.some((line) => line.includes('顺序')));

  const rewidthed = structuredClone(identical);
  rewidthed.tables[0].widths = ['30%', '50%', ''];
  assert.ok(compareColumns(page, proto, rewidthed).failures.some((line) => line.includes('宽度不同')));

  const headerClass = structuredClone(identical);
  headerClass.tables[0].headerClasses = [[], [], []];
  assert.ok(compareColumns(page, proto, headerClass).failures.some((line) => line.includes('表头缺少原型 class')));

  const cellClass = structuredClone(identical);
  cellClass.tables[0].row1 = [{ classes: [], width: 100 }, { classes: [], width: 100 }, { classes: ['act'], width: 100 }];
  const cellFailures = compareColumns(page, proto, cellClass).failures;
  assert.ok(cellFailures.some((line) => line.includes('首行单元格缺少原型 class')));

  const noTable = structuredClone(identical);
  noTable.tables = [];
  assert.ok(compareColumns(page, proto, noTable).failures.some((line) => line.includes('缺少列表表格')));
});

test('comparator: a missing required element is a failure and an extra one is only a note', () => {
  const proto = { ...fakeProbe(), elements: { '.main .lede': { count: 1, sample: '说明' }, '.main .stats': { count: 8, sample: '8' } } };
  const live = { ...fakeProbe(), elements: { '.main .lede': { count: 0, sample: '' }, '.main .stats': { count: 8, sample: '8' } } };
  const result = compareElements(ELEMENT_CANDIDATES, proto, live);
  assert.ok(result.failures.some((line) => line.includes('.main .lede')), result.failures.join('\n'));
  assert.deepEqual(result.failures.filter((line) => line.includes('.main .stats')), [], 'a present element is not a failure');
  const extra = compareElements(ELEMENT_CANDIDATES, proto, { ...fakeProbe(), elements: { '.main .lede': { count: 3, sample: '说明' }, '.main .stats': { count: 8, sample: '8' } } });
  assert.deepEqual(extra.failures, []);
  assert.ok(extra.notes.some((line) => line.includes('.main .lede')), 'extras are recorded as notes');
});

// The scripted-control substitution: the prototype flips state with `<button class="switch">`, the
// no-JS plane uses a native checkbox. The criterion ("this page offers this control") is unchanged,
// and only the entries listed in `spec.ELEMENT_EQUIVALENTS` are substituted.
test('comparator: a documented substitute satisfies a required element, and only then', () => {
  for (const [selector, entry] of Object.entries(ELEMENT_EQUIVALENTS)) {
    assert.ok(ELEMENT_CANDIDATES.includes(selector), `${selector} must be a required candidate to carry a substitute`);
    assert.ok(entry.accept.length && entry.reason.length > 20, `${selector} needs accepted substitutes and a reason`);
    for (const alternative of entry.accept) assert.ok(ELEMENT_CANDIDATES.includes(alternative) || /input|checkbox/.test(alternative), `${alternative} must be a plausible selector`);
  }
  const elements = (counts) => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, { count: value, sample: 'x' }]));
  const proto = { ...fakeProbe(), elements: elements({ '.main .switch': 1, '.main .lede': 1 }) };
  const substituted = { ...fakeProbe(), elements: elements({ '.main .switch': 0, '.main .chk': 2, '.main .lede': 1 }) };
  assert.deepEqual(compareElements(ELEMENT_CANDIDATES, proto, substituted, ELEMENT_EQUIVALENTS).failures, [], 'a native checkbox is accepted where the prototype renders a scripted switch');
  const raw = { ...fakeProbe(), elements: elements({ '.main .switch': 0, '.main .chk': 2, '.main .lede': 1 }) };
  assert.ok(compareElements(ELEMENT_CANDIDATES, proto, raw).failures.some((line) => line.includes('.main .switch')), 'without the substitution table the same page fails');
  const missing = { ...fakeProbe(), elements: elements({ '.main .switch': 0, '.main .chk': 0, '.main .lede': 1 }) };
  const missingFailures = compareElements(ELEMENT_CANDIDATES, proto, missing, ELEMENT_EQUIVALENTS).failures;
  assert.ok(missingFailures.some((line) => line.includes('.main .switch') && line.includes('等价')), missingFailures.join('\n'));
  // A selector with no entry is never substituted.
  const noLede = { ...fakeProbe(), elements: elements({ '.main .switch': 1, '.main .lede': 0 }) };
  assert.ok(compareElements(ELEMENT_CANDIDATES, proto, noLede, ELEMENT_EQUIVALENTS).failures.some((line) => line.includes('.main .lede')));
});

test('comparator: the drawer inventory is compared both ways and a missing drawer is red', () => {
  const drawer = { sections: ['状态', '同步设置'], kvKeys: ['Git 仓库', '目录'], fieldLabels: ['远端名称'], choiceValues: ['enabled'] };
  const proto = { ...fakeProbe(), drawer };
  const identical = { ...fakeProbe(), drawer: structuredClone(drawer) };
  assert.deepEqual(compareDrawer(page, proto, identical).failures, []);

  const missingSection = { ...fakeProbe(), drawer: { ...structuredClone(drawer), sections: ['状态'] } };
  assert.ok(compareDrawer(page, proto, missingSection).failures.some((line) => line.includes('抽屉分节')));

  const missingKey = { ...fakeProbe(), drawer: { ...structuredClone(drawer), kvKeys: ['Git 仓库'] } };
  assert.ok(compareDrawer(page, proto, missingKey).failures.some((line) => line.includes('kv')));

  const extraField = { ...fakeProbe(), drawer: { ...structuredClone(drawer), fieldLabels: ['远端名称', '自造字段'] } };
  assert.ok(compareDrawer(page, proto, extraField).failures.some((line) => line.includes('多出')), 'a field the prototype does not have is a difference too');

  const noDrawer = { ...fakeProbe(), drawer: null };
  assert.ok(compareDrawer(page, proto, noDrawer).failures.some((line) => line.includes('缺少 ?id= 详情抽屉')));
});

// The Vault picker's option values are the deployment's registry ids, not product vocabulary: the
// prototype fixture names its Vaults `vault`/`research` and no deployment has to share them. The
// picker's *presence* stays required, and every other choice token stays verbatim.
test('comparator: Vault option ids are deployment data, the picker and the other choices are not', () => {
  const protoDrawer = {
    sections: [], kvKeys: [], fieldLabels: [],
    choiceValues: ['obsidian.read', 'obsidian.write'],
    vaultChoices: ['vault', 'research'],
  };
  const liveDrawer = {
    sections: [], kvKeys: [], fieldLabels: [],
    choiceValues: ['obsidian.read', 'obsidian.write'],
    vaultChoices: ['default'],
  };
  const result = compareDrawer(page, { ...fakeProbe(), drawer: protoDrawer }, { ...fakeProbe(), drawer: liveDrawer });
  assert.deepEqual(result.failures, [], result.failures.join('\n'));
  assert.ok(result.notes.some((line) => line.includes('部署数据')), 'the two Vault id sets are recorded as evidence');

  const emptyPicker = compareDrawer(page, { ...fakeProbe(), drawer: protoDrawer }, { ...fakeProbe(), drawer: { ...liveDrawer, vaultChoices: [] } });
  assert.ok(emptyPicker.failures.some((line) => line.includes('Vault 选项缺失')), emptyPicker.failures.join('\n'));

  const driftedScope = compareDrawer(page, { ...fakeProbe(), drawer: protoDrawer }, { ...fakeProbe(), drawer: { ...liveDrawer, choiceValues: ['obsidian.read', 'research'] } });
  assert.ok(driftedScope.failures.some((line) => line.includes('复选/单选项取值')), 'the shared vocabulary is still compared verbatim');
  assert.deepEqual([...DATA_CHOICE_FIELDS], ['vault', 'allowedVault']);
});

test('comparator: navigation, overflow, primary-button paint and chip bounds', () => {
  const proto = { ...fakeProbe(), nav: { labels: ['概览', 'OAuth 账户'], active: 'OAuth 账户', mnav: ['概览', 'Token'] } };
  assert.deepEqual(compareNav(proto, { ...fakeProbe(), nav: { labels: ['概览', 'OAuth 账户'], active: 'OAuth 账户', mnav: ['概览', 'Token'] } }).failures, []);
  assert.ok(compareNav(proto, { ...fakeProbe(), nav: { labels: ['OAuth 账户', '概览'], active: 'OAuth 账户', mnav: ['概览', 'Token'] } }).failures.some((line) => line.includes('顺序')));
  assert.ok(compareNav(proto, { ...fakeProbe(), nav: { labels: ['概览'], active: null, mnav: [] } }).failures.some((line) => line.includes('当前页项')));
  assert.ok(compareNav(proto, { ...fakeProbe(), nav: { labels: ['概览'], active: '概览', mnav: [] } }).failures.some((line) => line.includes('移动端导航')));

  assert.deepEqual(compareOverflow({ overflow: { scrollWidth: 900, clientWidth: 900 } }), []);
  assert.deepEqual(compareOverflow({ overflow: { scrollWidth: 901, clientWidth: 900 } }), [], 'a 1px subpixel difference is tolerated');
  assert.ok(compareOverflow({ overflow: { scrollWidth: 902, clientWidth: 900 } }).some((line) => line.includes('横向溢出')));

  const paintButtons = [
    { text: '保存', classes: 'btn primary', background: 'rgb(47, 116, 224)', color: 'rgb(255, 255, 255)', width: 80, height: 32 },
  ];
  assert.deepEqual(comparePrimaryButtons({ buttons: paintButtons }, 1), []);
  assert.ok(comparePrimaryButtons({ buttons: [{ ...paintButtons[0], background: 'rgba(0, 0, 0, 0)' }] }, 1).some((line) => line.includes('背景透明')));
  assert.ok(comparePrimaryButtons({ buttons: [] }, 1).some((line) => line.includes('数量不足')));

  const chips = [{ text: '读取', classes: 'cap', lines: 1, width: 60, height: 24 }];
  assert.deepEqual(compareChips({ chips }, { maxHeight: 28, maxWidth: 320 }).failures, []);
  assert.ok(compareChips({ chips: [{ ...chips[0], height: 40 }] }, { maxHeight: 28, maxWidth: 320 }).failures.some((line) => line.includes('高 40px')));
  assert.ok(compareChips({ chips: [{ ...chips[0], lines: 2 }] }, { maxHeight: 28, maxWidth: 320 }).failures.some((line) => line.includes('断成 2 行')));
});

test('paint: the served stylesheet is the prototype stylesheet verbatim, and the declarations hold', async () => {
  const head = await fs.readFile(path.join(PROTO_DIR, 'src', '1-head.html'), 'utf8');
  const module = await fs.readFile(path.join(REPO_ROOT, 'app', 'src', 'admin', 'assets', 'proto-css.js'), 'utf8');
  const prototypeCss = extractPrototypeCss(head);
  const servedCss = extractServedCss(module);
  assert.deepEqual(verbatimCssFailures({ prototypeCss, servedCss }), [], 'proto-css.js must stay a verbatim copy of 1-head.html');
  const findings = paintFindings(servedCss);
  assert.deepEqual(findings.failures, [], 'the served stylesheet must satisfy the paint declarations');
  assert.equal(findings.evidence.declarations['--hh'], '52px');
  assert.equal(findings.evidence.declarations['.btn.primary background'], 'var(--accent)');
  assert.equal(findings.evidence.declarations['.tw border'], '1px solid var(--line)');
});

test('paint: removing a token or rule turns the declaration criteria red (negative controls)', async () => {
  const head = await fs.readFile(path.join(PROTO_DIR, 'src', '1-head.html'), 'utf8');
  const css = extractPrototypeCss(head);
  const mutations = [
    ['--accent token', (text) => text.replace(/--accent:#[0-9a-f]{6};/g, '')],
    ['--bg token', (text) => text.replace(/--bg:#[0-9a-f]{6};/g, '')],
    ['--line token', (text) => text.replace(/--line:#[0-9a-f]{6};/g, '')],
    ['--hh token', (text) => text.replace(/--hh:52px;/, '')],
    ['.bar height rule', (text) => text.replace('.bar{height:var(--hh);', '.bar{')],
    ['.btn.primary background rule', (text) => text.replace('.btn.primary{background:var(--accent);', '.btn.primary{')],
    ['.tw border rule', (text) => text.replace('.tw{border:1px solid var(--line);', '.tw{')],
  ];
  for (const [label, mutate] of mutations) {
    const mutated = mutate(css);
    assert.notEqual(mutated, css, `the ${label} mutation must actually change the stylesheet`);
    const failures = paintFindings(mutated).failures;
    assert.ok(failures.length > 0, `removing the ${label} must fail the paint criteria`);
  }
  // The `:root{` wrapper class of defect (RETURN-1): without it, `parseRules` sees a bogus
  // selector and every declaration-based criterion must fail closed.
  const broken = css.replace(':root{', 'root{');
  assert.notEqual(broken, css);
  assert.ok(paintFindings(broken).failures.some((line) => line.includes('--hh')), 'a broken :root wrapper must fail closed');
  assert.equal(parseRules(':root{--accent:#fff}').get(':root').get('--accent'), '#fff');
});

// The drawer URL defect (lane w5-gates-fix): `/admin/auth/vault-git` has no query, so a blind
// `&id=` produced `/admin/auth/vault-git&id=default` → 404 → "缺少 ?id= 抽屉" + "实现页一个 chip 都没有".
test('gate: the drawer URL is joined with query semantics, and the create sentinel is not a detail', () => {
  assert.equal(withQuery('/admin/auth/vault-git', { id: 'default' }), '/admin/auth/vault-git?id=default', 'a route without a query gets `?`');
  assert.equal(withQuery('/admin/auth?tab=accounts', { id: 'a b' }), '/admin/auth?tab=accounts&id=a+b', 'a route with a query keeps it and appends with `&`');
  assert.equal(withQuery('/admin/auth?tab=authz&edit=1#authz-window', { id: 'x' }), '/admin/auth?tab=authz&edit=1&id=x#authz-window', 'the fragment stays last');
  assert.equal(withQuery('/admin/auth/access-policy?new=1', { id: 'p' }), '/admin/auth/access-policy?new=1&id=p');
  // `&`-joined URLs are exactly the shape the gate used to build, and they must not come back.
  assert.equal(withQuery('/admin/auth/vault-git', { id: 'default' }).includes('vault-git&'), false);

  const listHrefs = ['/admin/auth?tab=accounts&id=new', '/admin/auth?tab=accounts&id=0780c9a4-a29b-474f-a0da-43abc17d7d5d'];
  assert.equal(liveDrawerId({ hrefs: listHrefs }), '0780c9a4-a29b-474f-a0da-43abc17d7d5d', '`?id=new` is the create drawer, not a record');
  assert.equal(liveDrawerId({ hrefs: ['/admin/auth?tab=keys&id=new', '/admin/auth?tab=keys&id=configured-env'] }), 'configured-env');
  assert.equal(liveDrawerId({ hrefs: ['/admin/auth/vault-git?id=default'] }), 'default');
  assert.equal(liveDrawerId({ hrefs: ['/admin/auth?tab=accounts&id=new'] }), null, 'a list page that only offers the create drawer has no detail entry');
  assert.equal(liveDrawerId({ hrefs: ['/admin/auth?tab=clients&id=a%20b'] }), 'a b', 'ids stay decoded');
  assert.deepEqual([...CREATE_DRAWER_IDS], ['new']);
});

// The mid-word measurement (lane w5-gates-fix): a line is a vertical band. The first pair is what
// Chromium actually returned for a `td.cellt.mono` holding the 48-character worst-case token - the
// untruncated run and the clipped run of ONE line - run through the very source the page evaluates.
test('midword: one ellipsis-truncated line is one line, and it is the measurement the page runs', () => {
  const rect = (x, y, w, h) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h });
  const lineBoxesOver = (rects) => new Function('document', `${LINE_MEASUREMENT_SOURCE}; return lineBoxes;`)({
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => rects }),
  })({});
  assert.equal(LINE_TOLERANCE_PX, 1);
  assert.equal(lineBoxesOver([rect(313, 386, 376, 20), rect(313, 386, 205, 20)]), 1, 'the untruncated + clipped rects of one line are one line');
  assert.equal(lineBoxesOver([rect(313, 386, 205, 20), rect(313, 408, 205, 20)]), 2, 'two stacked rects are two lines');
  assert.equal(lineBoxesOver([rect(0, 0, 10, 18), rect(0, 18, 10, 18), rect(0, 36, 10, 18)]), 3);
  assert.equal(lineBoxesOver([rect(0, 0, 0, 18), rect(4, 0, 12, 20)]), 1, 'degenerate rects are ignored');
  // Both probes must use that measurement and the visibility gate, not a private copy of either.
  for (const source of [MIDWORD, WORST_CASE_PROBE]) {
    assert.ok(source.includes(LINE_MEASUREMENT_SOURCE), 'the probe embeds the shared line measurement');
    assert.ok(source.includes('checkVisibility'), 'the probe skips what the browser is not rendering');
  }
  assert.ok(MIDWORD.includes('rendered(el)'), 'the scan gates every token on visibility');
  assert.ok(WORST_CASE_PROBE.includes('.find(rendered)'), 'the injected target is a rendered element');
  assert.equal(MIN_KEEP_CONTRACTS, 3);
});

// The two-sided requirement, as a pure function: the same token in the same cell class must get the
// same verdict on the prototype and on the plane.
test('midword: the same token must get the same verdict on both sides', () => {
  const cell = (target, lines) => ({ cell: 'cellt', target, lines, cellWidth: 167, whiteSpace: 'nowrap' });
  const agree = worstCaseParity({ results: [cell('td.cellt', 1), cell('b', 1)] }, { results: [cell('td.cellt', 1), cell('b', 1)] });
  assert.deepEqual(agree.disagreements, []);
  assert.deepEqual(agree.only, []);
  const disagree = worstCaseParity({ results: [cell('td.cellt', 1)] }, { results: [cell('td.cellt', 2)] });
  assert.equal(disagree.disagreements.length, 1);
  assert.ok(disagree.disagreements[0].includes('两侧判定不一致'), disagree.disagreements[0]);
  assert.ok(disagree.disagreements[0].includes('cellt|td.cellt'), disagree.disagreements[0]);
  const bothBroken = worstCaseParity({ results: [cell('b', 2)] }, { results: [cell('b', 3)] });
  assert.deepEqual(bothBroken.disagreements, [], 'both sides breaking is not a disagreement (each side fails on its own)');
  const oneSided = worstCaseParity({ results: [cell('td.cellt', 1)] }, { results: [cell('span.sub2', 1)] });
  assert.deepEqual(oneSided.disagreements, []);
  assert.equal(oneSided.only.length, 2);
  assert.ok(oneSided.only.some((line) => line.includes('实现独有')));
  assert.equal(worstCaseKey({ cell: 'act', target: 'td.act' }), 'act|td.act');
});

test('migration: no retired Admin UI v2 selector survives in the gate code', async () => {
  const files = [...GATE_SOURCES];
  for (const dir of ['proto-parity']) {
    const entries = await fs.readdir(path.join(REPO_ROOT, 'app', 'scripts', dir));
    for (const entry of entries.filter((name) => name.endsWith('.mjs'))) files.push(`scripts/${dir}/${entry}`);
  }
  for (const relative of files) {
    const source = stripComments(await fs.readFile(path.join(REPO_ROOT, 'app', relative), 'utf8'));
    for (const selector of RETIRED_SELECTORS) {
      assert.equal(source.includes(selector), false, `${relative} still references the retired selector "${selector}" in code (comments may record it, code may not)`);
    }
  }
});

test('migration: the mid-word contract only names prototype classes, and the probes are real tokens', () => {
  const parts = KEEP_CONTRACT_SELECTOR.split(',').map((part) => part.trim());
  assert.ok(parts.length >= 4, `the keep contract must name several contexts, got ${parts.length}`);
  for (const part of parts) {
    assert.match(part, /^\.tbl|^\.idc|^\.tag|^\.cap$|^td\.act/, `the migrated keep context "${part}" must come from the prototype vocabulary`);
  }
  for (const retired of ['.data-table', 'col-actions', 'col-cred', 'cred-name', 'badge', 'label-keep']) {
    assert.equal(KEEP_CONTRACT_SELECTOR.includes(retired), false, `the keep contract must not name ${retired}`);
  }
  assert.equal(PROBE_LABEL.length, 60, 'the probe label stays 60 characters');
  assert.equal(/\s/.test(PROBE_LABEL), false, 'the probe label is one whitespace-free token');
  assert.equal(/\s/.test(WORST_CASE_TOKEN), false, 'the worst-case token is whitespace-free');
});

test('migration: the capability-filter helper finds the editor link and keeps the query before the fragment', () => {
  const hrefs = ['/admin/auth/access-policy', '/admin/auth/access-policy?new=1', '/admin/auth/access-policy?window=x#authz-window', '/admin/auth/access-policy?edit=42#authz-edit'];
  assert.equal(editorHref(hrefs, '/admin/auth/access-policy'), '/admin/auth/access-policy?edit=42#authz-edit');
  assert.equal(editorHref(['/admin/auth/access-policy', '/admin/auth/access-policy?new=1'], '/admin/auth/access-policy'), null, 'the 新建 link is not an editor link');
  assert.equal(withParams('/admin/auth/access-policy?edit=42#authz-edit', { capq: 'tool:x' }), '/admin/auth/access-policy?edit=42&capq=tool%3Ax#authz-edit');
  assert.equal(largestGroup({ groups: [{ name: 'subjects', count: 3 }, { name: 'capabilities', count: 109 }] }).name, 'capabilities');
});

// Retired assertions are simply gone (git history holds them); the gate does not keep a ledger of
// what the removed implementation used to assert.

test('d0: the split of the interaction gate stays inside the architecture line budget', async () => {
  for (const relative of [INTERACTION_MODULE, INJECTION_MODULE, POLICY_MODULE, INTERACTION_SCENE, 'scripts/web-regression/admin-layout-security.mjs', 'scripts/web-regression/admin-layout-noscript.mjs']) {
    const source = await fs.readFile(path.join(REPO_ROOT, 'app', relative), 'utf8');
    const lines = source.split('\n').length;
    assert.ok(lines <= GATE_MODULE_LINE_BUDGET, `${relative} has ${lines} lines (budget ${GATE_MODULE_LINE_BUDGET}): extract a cohesive module instead of registering an exception`);
  }
  // The three modules are one gate: the behaviour table and verdicts must not silently lose the
  // policy/probe half they refer to.
  const interaction = await fs.readFile(path.join(REPO_ROOT, 'app', INTERACTION_MODULE), 'utf8');
  assert.ok(interaction.includes("from \"./policy.mjs\""), 'interaction.mjs must take the script policy from policy.mjs');
  const security = await fs.readFile(path.join(REPO_ROOT, 'app', 'scripts', 'web-regression', 'admin-layout-security.mjs'), 'utf8');
  assert.ok(security.includes("proto-parity/injection.mjs"), 'the security scene must use the injection module');
});

test('registry: excluded candidates each carry a reason and are not also required', () => {
  for (const entry of EXCLUDED_CANDIDATES) {
    assert.ok(entry.selector && entry.reason.length > 10, `excluded candidate ${entry.selector} needs a reason`);
    const base = entry.selector.split(',')[0].trim();
    assert.equal(ELEMENT_CANDIDATES.includes(base), false, `${base} cannot be both required and excluded`);
  }
});

/* ------------------------------------------------------------------ D0 interaction gate (l4) */

// The policy the plane actually serves and the constant the gate asserts must be one string: a copied
// expectation would let a weakened header pass while the gate keeps quoting the old value.
test('d0: the served CSP header is the frozen policy, and every weakening fails', async () => {
  const router = await fs.readFile(path.join(REPO_ROOT, 'app', 'src', 'admin', 'router.js'), 'utf8');
  const match = /res\.setHeader\("Content-Security-Policy", "([^"]+)"\)/.exec(router);
  assert.ok(match, 'router.js must set the CSP header');
  assert.equal(match[1], CSP_HEADER, 'the gate constant must be the header the router serves');
  assert.deepEqual(cspFailures(CSP_HEADER), [], 'the frozen policy must satisfy its own assertions');
  assert.equal(parseCsp(CSP_HEADER)['script-src'].join(' '), "'self'");

  const weakenings = {
    'inline script': CSP_HEADER.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    eval: CSP_HEADER.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    'third-party origin': CSP_HEADER.replace("script-src 'self'", 'script-src https://cdn.example.com'),
    wildcard: CSP_HEADER.replace("script-src 'self'", 'script-src *'),
    'default loosened': CSP_HEADER.replace("default-src 'none'", "default-src 'self'"),
    'frame-ancestors dropped': CSP_HEADER.replace('; frame-ancestors', ''),
    'base-uri dropped': CSP_HEADER.replace('; base-uri', ''),
    'connect-src dropped': CSP_HEADER.replace("; connect-src 'self'", ''),
    'connect-src loosened': CSP_HEADER.replace("connect-src 'self'", 'connect-src *'),
    'no header at all': '',
  };
  for (const [label, header] of Object.entries(weakenings)) {
    assert.ok(cspFailures(header).length > 0, `weakening the policy (${label}) must fail the criterion`);
  }
  // `ctx.fetchFragment` is a same-origin `fetch`; a policy without `connect-src` falls back to
  // `default-src 'none'` and the browser refuses it (lane l1/l4 measured that in Chromium on
  // 2026-10-18, which is why the frozen policy carries `connect-src 'self'`). Both directions stay
  // asserted, so dropping the directive cannot pass.
  assert.equal(fragmentFetchPermitted(CSP_HEADER), true, 'the frozen policy permits the same-origin fragment fetch');
  assert.equal(fragmentFetchPermitted(CSP_HEADER.replace("; connect-src 'self'", '')), false, 'without connect-src the same-origin fetch is refused (default-src fallback)');
  assert.equal(fragmentFetchPermitted(`${CSP_HEADER}; connect-src *`), false, "a wildcard connect-src must not satisfy it");
});

// The whitelist is the one place a new feature module becomes reachable, so both sides have to agree.
test('d0: the module whitelist matches the router, and every script-policy violation fails', async () => {
  const router = await fs.readFile(path.join(REPO_ROOT, 'app', 'src', 'admin', 'router.js'), 'utf8');
  const map = /const CLIENT_MODULES = new Map\(\[([\s\S]*?)\]\)/.exec(router);
  assert.ok(map, 'router.js must declare the CLIENT_MODULES whitelist');
  const served = [...map[1].matchAll(/\["([^"]+)",/g)].map((item) => item[1]);
  assert.deepEqual([...served].sort(), [...ADMIN_CLIENT_MODULES].sort(), 'the gate whitelist and router.js must name the same modules');

  const clean = {
    scripts: [{ src: `/admin/auth/assets/${CLIENT_ENTRY_MODULE}`, type: 'module', inline: false, sameOrigin: true, textLength: 0 }],
    inlineHandlers: [], javascriptUrls: [], cspMeta: null,
  };
  assert.deepEqual(scriptInventoryFailures(clean, { authenticated: true }), [], 'one whitelisted same-origin module is the accepted shape');
  assert.equal(scriptInventoryFailures(clean, { authenticated: false }).length, 1, 'login/error pages must load no script at all');

  const violations = {
    'inline script': { ...clean, scripts: [{ src: '', type: '', inline: true, sameOrigin: false, textLength: 42 }, ...clean.scripts] },
    'foreign origin': { ...clean, scripts: [{ src: 'https://evil.example/x.js', type: 'module', inline: false, sameOrigin: false, textLength: 0 }] },
    'protocol-relative origin': { ...clean, scripts: [{ src: '//evil.example/x.js', type: 'module', inline: false, sameOrigin: false, textLength: 0 }] },
    'non-whitelisted same-origin file': { ...clean, scripts: [{ src: '/admin/auth/assets/other.js', type: 'module', inline: false, sameOrigin: true, textLength: 0 }] },
    'classic script': { ...clean, scripts: [{ src: '/admin/auth/assets/admin-client.js', type: '', inline: false, sameOrigin: true, textLength: 0 }] },
    'second module tag': { ...clean, scripts: [...clean.scripts, { src: '/admin/auth/assets/admin-feature-keys.js', type: 'module', inline: false, sameOrigin: true, textLength: 0 }] },
    'no module on an authenticated page': { ...clean, scripts: [] },
    'on* attribute': { ...clean, inlineHandlers: ['div[onmouseover]'] },
    'javascript: url': { ...clean, javascriptUrls: ['a[href]=javascript:alert(1)'] },
    'csp meta tag': { ...clean, cspMeta: CSP_HEADER },
  };
  for (const [label, inventory] of Object.entries(violations)) {
    assert.ok(scriptInventoryFailures(inventory, { authenticated: true }).length > 0, `${label} must fail the script policy`);
  }
});

// Hard rule 1 (values go through textContent) as a static audit, plus the runtime half in the browser
// scene (`observers.htmlSinks === 0`).
test('d0: the client source audit flags every HTML sink, and the served modules are clean', async () => {
  const flagged = {
    'innerHTML from data': 'el.innerHTML = data;',
    'innerHTML from a template': 'el.innerHTML = `<b>${name}</b>`;',
    'outerHTML': 'el.outerHTML = html;',
    'insertAdjacentHTML': "el.insertAdjacentHTML('beforeend', html);",
    'document.write': 'document.write(html);',
    'eval': 'eval(payload);',
    'new Function': 'const fn = new Function(code);',
    'string timer': "setTimeout('doThing()', 10);",
    'on* attribute': "el.setAttribute('onclick', 'run()');",
  };
  for (const [label, source] of Object.entries(flagged)) {
    assert.ok(clientSinkFailures({ probe: source }).length > 0, `${label} must be flagged as an HTML sink`);
  }
  assert.deepEqual(clientSinkFailures({ probe: 'el.innerHTML = "";' }), [], 'clearing with an empty literal is allowed');
  assert.deepEqual(clientSinkFailures({ probe: 'el.textContent = String(value);' }), [], 'textContent is the accepted way to write a value');
  assert.deepEqual(clientSinkFailures({ 'probe: comment': '// innerHTML = data is exactly what we must not do' }), [], 'a comment is not a sink');
  assert.deepEqual(clientSinkFailures({ 'probe: block comment': '/* insertAdjacentHTML(html) */' }), [], 'a block comment is not a sink');
  assert.deepEqual(clientSinkFailures({ 'probe: url': 'const href = "https://example.com//x";' }), [], 'a URL is not a comment');

  const sources = {};
  for (const name of ADMIN_CLIENT_MODULES) {
    sources[name] = await fs.readFile(path.join(REPO_ROOT, 'app', 'src', 'admin', 'assets', name), 'utf8');
  }
  assert.deepEqual(clientSinkFailures(sources), [], 'the served enhancement modules must own no HTML sink');
});

// The behaviour table, the verdicts and the negative controls have to stay in step: a verdict without
// a sabotage could pass because it never measures anything.
test('d0: every behaviour names its prototype authority, a verdict and a negative control', () => {
  const seen = new Set();
  for (const entry of PROTOTYPE_BEHAVIOUR) {
    assert.ok(entry.id && entry.requires.length >= 6, `${entry.id} needs a one-line requirement (got ${JSON.stringify(entry.requires)})`);
    assert.ok(entry.proto.includes('6-app.js') || entry.proto.includes('D0'), `${entry.id} must name its prototype/D0 authority`);
    assert.ok(['both', 'host'].includes(entry.plane), `${entry.id} must declare which tree it is asserted on`);
    assert.ok(VERDICT_IDS.includes(entry.verdict), `${entry.id} names verdict ${entry.verdict}, which does not exist`);
    assert.ok(typeof interactionVerdicts[entry.verdict] === 'function', `${entry.verdict} must be a verdict function`);
    assert.equal(seen.has(entry.id), false, `${entry.id} is declared twice`);
    seen.add(entry.id);
  }
  assert.deepEqual([...VERDICT_IDS].sort(), [...PROTOTYPE_VERDICT_IDS, ...HOST_VERDICT_IDS].sort());
  assert.ok(PROTOTYPE_VERDICT_IDS.length >= 12, 'the prototype reference must cover every measured behaviour');
  for (const id of PROTOTYPE_VERDICT_IDS) {
    assert.ok(SABOTAGE[id], `the prototype verdict ${id} has no sabotage (its green would be unproven)`);
    assert.ok(ALL_AREAS.includes(AREA_OF_VERDICT[id]), `${id} must map to a scenario area`);
  }
  // A host verdict is about the Admin host, not about the prototype: the prototype *is* one inline
  // script, so asserting these on it would be a criterion nobody can satisfy.
  assert.equal(PROTOTYPE_VERDICT_IDS.some((id) => id === 'no-inline-script-policy'), false);
  assert.ok(HOST_VERDICT_IDS.includes('no-inline-script-policy'));
  assert.ok(HOST_VERDICT_IDS.includes('client-writes-values-with-textContent'));
});

// Every probe is serialized into the page on its own (`Function.prototype.toString`), so a probe that
// references a module-scope helper throws in the browser instead of measuring (that is exactly the
// class of bug a reviewer found in an earlier probe).
test('d0: every in-page probe is self-contained (no module-scope references)', async () => {
  const sources = [INTERACTION_MODULE, INJECTION_MODULE].map((relative) => fs.readFile(path.join(REPO_ROOT, 'app', relative), 'utf8'));
  const texts = await Promise.all(sources);
  const moduleScope = new Set(texts.flatMap((source) => [...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1])));
  const probes = {
    probeDocumentPolicy, armInteractionObservers, probeInteractionObservers, probeDrawerState, probeMenuState,
    probeModalState, probeToastState, probeThemeState, probeKbdState, probeSearchState, probeInjectionSurface,
  };
  for (const [name, fn] of Object.entries(probes)) {
    const body = fn.toString();
    assert.ok(body.includes('document') || body.includes('window'), `${name} must be a DOM probe`);
    for (const scopeName of moduleScope) {
      if (scopeName === name) continue;
      assert.equal(new RegExp(`\\b${scopeName}\\b`).test(body), false, `${name} must not reference the module-scope ${scopeName} (it is serialized alone)`);
    }
  }
  assert.deepEqual(Object.keys(XSS_PAYLOADS).length, 4, 'the injection probe covers four real data fields');
  assert.equal(Object.values(XSS_PAYLOADS).every((payload) => /__xss_/.test(payload)), true, '每次注入都能自证是否执行（旗标）');
});

// The scenes only run if they are registered; a dropped registration would silently shrink the gate.
test('d0: the interaction / security / no-JS scenes are registered in the shared runner', async () => {
  const scene = await fs.readFile(path.join(REPO_ROOT, 'app', 'scripts', 'web-regression', 'admin-layout.mjs'), 'utf8');
  for (const call of ['registerInteractionChecks', 'registerSecurityChecks', 'registerNoScriptChecks']) {
    assert.ok(scene.includes(`import { ${call} }`), `${call} must be imported by the shared scene`);
    assert.ok(scene.includes(`await ${call}(`), `${call} must be awaited before the teardown check`);
  }
  assert.ok(scene.indexOf('await registerNoScriptChecks(') < scene.indexOf('teardown is itself a criterion'), 'the new scenes run before the fixture teardown');
});

test('d0: the no-JS gate covers every category, and the fixture hook is additive', async () => {
  assert.deepEqual([...NO_SCRIPT_CATEGORIES], ['accounts', 'keys', 'clients', 'tokens', 'publishes', 'audit', 'policies', 'git-repair']);
  const scene = await fs.readFile(path.join(REPO_ROOT, 'app', 'scripts', 'web-regression', 'admin-layout-noscript.mjs'), 'utf8');
  assert.ok((scene.match(/await check\('admin-nojs:/g) ?? []).length >= 9, 'one check per category plus the page-error check');
  for (const keyword of ['账户', 'Key', '客户端', 'Token', '发布', '审计', '策略', 'Git 修复']) {
    assert.ok(scene.includes(keyword), `the no-JS scene must cover ${keyword}`);
  }
  assert.ok(scene.includes('javaScriptEnabled: false'), 'the writes must happen with scripting disabled');
  assert.ok(scene.includes('prepareData'), 'the Git-repair category needs the pre-boot corruption hook');
  // The hook is additive: the fixture must call it before the server spawns, and nothing else changes.
  const fixture = await fs.readFile(path.join(REPO_ROOT, 'app', 'scripts', 'web-regression', 'admin-layout-fixture.mjs'), 'utf8');
  const hook = fixture.indexOf('await prepareData(dataRoot)');
  assert.ok(hook > 0, 'startAdminLayoutFixture must invoke prepareData');
  assert.ok(hook < fixture.indexOf('spawn(process.execPath'), 'prepareData must run before the server starts');
  assert.ok(fixture.includes('prepareData = null'), 'the hook must default to off (existing callers unchanged)');
});
