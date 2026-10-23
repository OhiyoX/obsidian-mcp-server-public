// Prototype-parity — the **waiver tables** and their hygiene (Wave Q, extracted from `shape.mjs`
// when the line budget ran out).
//
// `shape.mjs` owns the probe and the comparison; this module owns the closed set of exception KINDS,
// the explicit tables (every entry names one exact canonical line, one state, one side and WHY), the
// budgets, and the hygiene rules that keep the table from becoming a place to hide a region: no
// wildcards, a real reason, a known kind, per-kind constraints, no two entries for the same
// (state, line, side), a `count` that matches the occurrences it excuses, `catalog` only on the
// catalogue region, and `data` never on a region container.

/**
 * Explicit data/state waivers: the exact canonical line, on one state, why it is not a shape
 * difference, and WHICH KIND of exception it is. The kinds are a closed set and each one is
 * validated (`waiverFindings`), so the table can not become a place to hide a region:
 *   * `state`  — a record-row shape the local fixture cannot reproduce (the prototype's own fixture
 *                holds states a single-Vault dev fixture does not). The line must be a `↻` row set.
 *   * `data`   — one datum differs (a nullable timestamp, a count, a deployment-specific name).
 *   * `no-js-submit` — one labelled `button` a no-JS GET form needs where the prototype scripts the
 *                submit, or one search box the prototype scripts and the plane makes a real GET
 *                form. Each form may add at most one submit button.
 *   * `catalog` — a REGION whose multiplicity comes from the runtime catalogue rather than from the
 *                layout (the Admin plane reads the real capability catalogue, the prototype's mock
 *                has fewer groups). Only the catalogue's group container (`div.cap-g`) may use it:
 *                a region is never excused as a single datum (`data` is rejected on a container).
 *   * `deliberate` — a shell-level difference that is deliberate and documented elsewhere.
 * Every waiver must still match a real difference (a stale one FAILS the gate), wildcards are
 * rejected, a waiver must be consumed exactly as often as its `count` says, and two entries for the
 * same `(state, line, side)` are rejected (they would hide each other's staleness).
 */
export const SHAPE_WAIVER_KINDS = Object.freeze(['state', 'data', 'no-js-submit', 'catalog', 'deliberate']);
export const SHAPE_WAIVER_BUDGET = 30;
export const SHAPE_STATE_WAIVER_BUDGET = 8;
export const SHAPE_WAIVERS = Object.freeze([
  Object.freeze({
    state: 'overview', line: '↻ a.li [href=route:vaults:detail] :: - { b :: T span.dot :: - span.ell :: T }',
    side: 'proto-only', kind: 'state',
    reason: '原型的 fixture 有两个 Vault（其中一个未初始化 Git），概览的「需要关注」因此多一行「research 未初始化 Git 仓库」；'
      + '本 fixture 是单 Vault 且已启用 Git 的部署。同一行由 `renderOverviewPage` 的 repository-missing 分支渲染，'
      + '该分支由 vaults 状态（`?tab=vault-git`）与 Vault 清单覆盖，不是形状差异。',
  }),
  Object.freeze({
    state: 'login', line: 'ibtn [open=no] :: -', side: 'proto-only', kind: 'deliberate',
    reason: '原型登录页的密码「显示/隐藏」是脚本按钮（`data-act=pwtoggle`）；未认证页面按 D0 策略不加载任何脚本，'
      + '一个永远不响应的按钮就是假的 affordance，所以 plane 不渲染它。密码字段本身、标签与错误/锁定文案逐项对照。',
  }),
  Object.freeze({
    state: 'tokens', line: 'btn.btn.ghost.sm :: T', side: 'live-only', kind: 'no-js-submit',
    reason: '原型令牌工具栏的排序控件是脚本 `select`（`data-act=tok-order`，自动提交）；plane 的同一个控件是 GET 表单，'
      + '需要一个显式提交按钮（无脚本时下拉框无法自行提交）。控件本身、选项与默认值逐项对照，只多这一个按钮。'
      + '（Wave R 的同类排查：这个按钮**不**在脚本生效后收起——GET 工具栏的 change 已由拖拽列表的原地切换接管，'
      + '再叠 data-autosubmit 会在同一个 change 上补一次真实 GET，比它替换的行为更差。）',
  }),
  Object.freeze({
    state: 'audit', line: 'btn.btn.ghost.sm :: T', side: 'live-only', kind: 'no-js-submit', count: 2,
    reason: '原型审核工具栏与分页的排序/每页控件都是脚本（`data-af`、`data-act=pagesize`，自动提交）；plane 的同一工具栏与每页控件是 GET 表单，'
      + '而隐式提交只在单文本框表单上生效、`select` 更不能自行提交，因此两处各需要一个带文案的提交按钮（「筛选」与「应用」），'
      + '否则无脚本时筛选与翻页都不可用。两个按钮的 line 完全相同，所以由一条 `count: 2` 的豁免记录（两条同名条目会被拒绝：会互相遮蔽失效检测）。'
      + '选项、默认值与筛选语义由交互/无 JS 门禁对照。与「定时授权预览」「令牌排序」不同，这两处**不**隐藏：'
      + '它们属于一个多字段文本筛选表单，脚本侧的原型是边输入边筛选（ debounce），而不是“一次下拉即提交”，'
      + '把按钮隐掉就等于放弃一个无脚本可用的显式提交（见 docs/QUALITY_AUDIT.md 的 Wave R 同类排查）。',
  }),
  Object.freeze({
    state: 'authz-editor', line: 'div.cap-g :: -', side: 'live-only', kind: 'catalog',
    reason: '能力分组列表的长度属于**运行时目录**：plane 渲染的是真实能力目录（全部/访问面/权限范围/工具集/单个工具/资源六组），'
      + '原型的 mock 只有五组，所以多出一个 `div.cap-g` 区域。分组区域的“多一组”不是布局回归，但也不能当“一个数据不同”豁免'
      + '（`data` 已在判据里明确拒绝区域容器行）——它的数量来自目录。区域内部结构（cap-h 标题 + cap-b 复选行）仍逐项对照；'
      + '选择与筛选行为由 admin-layout-capq 门禁对照（它证明的是“勾选集合 + 过滤不丢已选”，不比较分组名）。',
  }),
  Object.freeze({
    state: 'authz-editor', line: 'cap-h :: T', side: 'live-only', kind: 'data',
    reason: '同上：运行时真实目录比原型 mock 多一个分组标题（六组 vs 五组），标题文本与项数是目录数据。'
      + '注意 capq 门禁**不**比较分组名（它只对照勾选集合、`?capq=` 过滤保留已选与未改动保存不丢选项），'
      + '分组标题本身的“存在与数量”由这条豁免与本状态的分组区域豁免承当。',
  }),
  Object.freeze({
    state: 'authz-editor', line: 'disclosure [open=no] :: -', side: 'live-only', kind: 'deliberate',
    reason: 'plane 多一个「用其他主体试算（服务端判定）」折叠块：原型用脚本实时预览，plane 的判定只能来自服务端，'
      + '无脚本时这是唯一能发起试算的入口。它是有意保留的额外控件（无 JS 契约），不是布局回归。',
  }),
  Object.freeze({
    state: 'vaults', line: 'btn.btn :: -', side: 'live-only', kind: 'deliberate',
    reason: '原型完全没有准入区（`grep 准入 docs/admin-ui-proto` → 0），但 Vault 准入是真实能力，而“全新部署'
      + '（无 vault-admissions.json + 发现关闭）”必须在 UI 上有办法把闸打开。这一条控件就是一个真实 GET 链接'
      + '（`<base>?confirm=admission`，与 Git 修复对话框同一个 `?confirm=` 惯例）：表单与逐库确认选择都在那个状态里，'
      + '所以本页骨架只多这一个控件（抽屉不能承担：原型的抽屉分节/复选取值是逐项精确比对，且首次初始化前没有任何 Vault 有准入描述符）。'
      + '2026-10-22 前列表区被整块隐藏、抽屉只有一句「等待显式初始化」，文档里的启用路径实际无入口。',
  }),
  Object.freeze({
    state: 'vaults', line: 'span.hide-m :: T', side: 'live-only', kind: 'deliberate',
    reason: '上面那个准入入口链接的文案容器：它与页栏的「刷新 Vault 清单」用同一个约定（图标 + `span.hide-m` 文案），'
      + '窄屏（320px）时只留图标，否则页栏会横向溢出 32px（实测过）。原型里只有一个 `hide-m` 文案，因此多出一个。',
  }),
]);

/** Budget for the structural-label waivers (`compareShapeLabels`). */
export const SHAPE_LABEL_WAIVER_BUDGET = 12;
export const SHAPE_LABEL_WAIVERS = Object.freeze([
  Object.freeze({ state: 'tokens', label: '.btn = 排序', kind: 'no-js-submit', reason: '排序控件的无脚本提交按钮（见同状态同 kind 的形状豁免；Wave R 同类排查后决定不在脚本生效时收起）。' }),
  Object.freeze({ state: 'audit', label: '.btn = 筛选', kind: 'no-js-submit', reason: '审核筛选表单的无脚本提交按钮（见同状态同 kind 的形状豁免）。' }),
  Object.freeze({ state: 'audit', label: '.btn = 应用', kind: 'no-js-submit', reason: '每页条数表单的无脚本提交按钮（见同状态同 kind 的形状豁免）。' }),
  Object.freeze({ state: 'authz-editor', label: 'disclosure trigger = 用其他主体试算（服务端判定）', kind: 'deliberate', reason: '服务端试算折叠块的无脚本触发器（文案即其功能名）。' }),
  Object.freeze({
    state: 'authz-editor', label: '.cap-h = 访问面surface# 项', kind: 'data',
    reason: '运行时真实能力目录比原型 mock 多一个分组（访问面 surface）—— 分组标题文本（含项数）是目录数据，'
      + '与同状态的 catalog/`cap-h` 形状豁免对应；分组的存在与数量不靠这条豁免（形状侧不允许用 data 豁免区域）。',
  }),
  Object.freeze({
    state: 'vaults', label: '.btn = 初始化准入', kind: 'deliberate',
    reason: '上面那条 `btn.btn` 形状豁免的文案面：它是全新部署里唯一的准入入口（原型没有准入区），'
      + '无脚本时仍是一个真实可用、真实可点的 GET 链接（`?confirm=admission`）。',
  }),
]);

/**
 * Containers whose children are RECORDS. Under these, how many children exist is data — the
 * prototype's own fixture and the fixture server hold different records — while the SET of child
 * shapes still is structure (N7). Everywhere else (the shell's buttons, a toolbar's controls, a
 * panel's fields, a menu's items, a `.kv` block's rows…) the count is compared like any other
 * element, so a control that exists on one side only cannot hide behind a collapsed run.
 */
/** Waiver hygiene: no wildcards, a real reason, a known kind, and per-kind constraints. */
export function waiverFindings(waivers, { budget = SHAPE_WAIVER_BUDGET, stateBudget = SHAPE_STATE_WAIVER_BUDGET } = {}) {
  const failures = [];
  if (waivers.length > budget) failures.push(`豁免条目 ${waivers.length} 条超过预算 ${budget} 条：豁免是债，不是通行证`);
  const stateWaivers = waivers.filter((item) => item.kind === 'state');
  if (stateWaivers.length > stateBudget) failures.push(`行态豁免 ${stateWaivers.length} 条超过预算 ${stateBudget} 条：先把 fixture 造全，再来加豁免`);
  const seen = new Map();
  for (const waiver of waivers) {
    const label = `${waiver.state}: ${JSON.stringify(waiver.line)}`;
    if (!waiver.state) failures.push(`${label} 没有 state`);
    if (!waiver.reason || String(waiver.reason).length < 40) failures.push(`${label} 的 reason 必须写清为什么（≥40 字）`);
    if (!SHAPE_WAIVER_KINDS.includes(waiver.kind)) failures.push(`${label} 的 kind=${JSON.stringify(waiver.kind)} 不在 ${SHAPE_WAIVER_KINDS.join('/')} 之内`);
    if (/[*?]|TODO/.test(String(waiver.line ?? ''))) failures.push(`${label} 含通配符：豁免只能逐行精确匹配`);
    if (String(waiver.line ?? '').includes('\n')) failures.push(`${label} 跨行：豁免只能针对一行`);
    if (!['proto-only', 'live-only'].includes(waiver.side)) failures.push(`${label} 必须声明 side（proto-only / live-only）`);
    if (waiver.kind === 'state' && !String(waiver.line).includes('↻')) failures.push(`${label} 声明 state 但它不是一条行态集合（缺 ↻）`);
    if (waiver.kind !== 'state' && String(waiver.line).includes('↻')) failures.push(`${label} 试图用 ${waiver.kind} 豁免整排行态集合：行态只能声明为 state`);
    if (waiver.kind === 'no-js-submit' && !/^btn\.[a-z. ]*\[?[^\]]*\]? :: T$/.test(String(waiver.line).trim())) {
      failures.push(`${label} 声明 no-js-submit 但它不是一行带文案的 .btn：无脚本控件只能豁免控件本身`);
    }
    if (waiver.kind === 'catalog' && !/^div\.cap-g\b/.test(String(waiver.line).trim())) {
      failures.push(`${label} 声明 catalog 但它不是能力目录的分组区域（div.cap-g）：目录数量豁免只适用于目录区域`);
    }
    if (waiver.kind === 'data' && /^div\.[a-z-]*cap-g\b/.test(String(waiver.line).trim())) {
      failures.push(`${label} 用 data 豁免了目录区域：区域的存在与数量不是“一个数据不同”，只能用 catalog`);
    }
    // Two entries for the same (state, line, side) excuse two occurrences of one line while hiding
    // each other's staleness: declaring it twice must be rejected. One occurrence is one waiver, and
    // a line that legitimately appears twice declares `count`.
    const key = `${waiver.state}||${String(waiver.line).trim()}||${waiver.side}`;
    if (seen.has(key)) failures.push(`${label} 重复豁免：同一 (state, line, side) 声明了两次，会互相遮蔽失效检测（同一行出现两次要写成一条 count: 2）`);
    seen.set(key, true);
    if (waiver.count !== undefined && (!Number.isInteger(waiver.count) || waiver.count < 1)) {
      failures.push(`${label} 的 count=${JSON.stringify(waiver.count)} 不是正整数`);
    }
  }
  return failures;
}
