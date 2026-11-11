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
    state: 'audit', line: 'btn.btn.futonly.ghost.sm :: -', side: 'proto-only', kind: 'deliberate',
    reason: '「导出 CSV」在原型里是设想控件（`.futonly` 虚线按钮 + `fut("设想")`）。审计记录本来就在手上，'
      + '所以现在是一个真实下载：`GET /admin/auth/audit/export.csv` 按当前筛选导出行集，带 UTF-8 BOM/CRLF/RFC 4180 引号与公式注入防护。'
      + '形状上只把这一个规划中的按钮换成了真按钮，工具栏其余分量未动。',
  }),
  Object.freeze({
    state: 'audit', line: 'btn.btn.ghost.sm :: -', side: 'live-only', kind: 'deliberate',
    reason: '同上：规划中的虚线按钮（`.futonly`）变成真实 `<a class="btn ghost sm" download>`；无脚本也能下载，不依赖增强脚本。',
  }),
  Object.freeze({
    state: 'audit', line: 'span.fut :: T', side: 'proto-only', kind: 'deliberate',
    reason: '同上：实现侧不再渲染「规划中」标记，因为这个按钮背后的功能已真实存在（下载按当前筛选的审计 CSV）；'
      + '保留一个虚线标记会让真正的功能看起来还没做，那是主动的错误信息。',
  }),
  Object.freeze({
    state: 'overview', line: '↻ div.futonly.k :: T {  }', side: 'proto-only', kind: 'state',
    reason: '「上次部署」在原型里是规划中的虚线行（`.futonly` + `fut("部署信息")`，因为当时的后台只有一份 `1.0.0` 常量与一句「未部署」）。'
      + '现在 `data/deployed-version.json` 真的提供 version/commit/deployedAt，所以这一行按真实数据渲染（部署时间按配置时区标注、'
      + 'commit 跟着版本行、没有清单时如实写「未部署（本地运行）」），不再留规划标记。这是对原型的“已完成”而非形状差异；'
      + '`data-deployed-at` 仍带原始 manifest 字符串（#515 DT-2 场景逐字比对）。',
  }),
  Object.freeze({
    state: 'overview', line: '↻ div.futonly :: - { span.fut :: T span.muted :: T }', side: 'proto-only', kind: 'state',
    reason: '同上一条的另一半：规划标记（`span.fut`）与该行的虚线容器随真实实现一起移除。',
  }),
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
    state: 'vaults', line: 'btn.btn :: -', side: 'live-only', kind: 'deliberate',
    reason: '原型完全没有准入区（`grep 准入 docs/admin-ui-proto` → 0），但 Vault 准入是真实能力，而“全新部署'
      + '（无 vault-admissions.json + 发现关闭）”必须在 UI 上有办法把闸打开。这一条控件就是一个真实 GET 链接'
      + '（`<base>?confirm=admission`，与 Git 修复对话框同一个 `?confirm=` 惯例）：表单与逐库确认选择都在那个状态里，'
      + '所以本页骨架只多这一个控件（抽屉不能承担：原型的抽屉分节/复选取值是逐项精确比对，且首次初始化前没有任何 Vault 有准入描述符）。'
      + '2026-10-22 前列表区被整块隐藏、抽屉只有一句「等待显式初始化」，文档里的启用路径实际无入口。',
  }),
  Object.freeze({
    state: 'audit', line: 'select.sel.sm :: -', side: 'live-only', kind: 'deliberate', count: 3,
    reason: '审计身份筛选（#518）：工具栏多了客户端 `client`、API Key `apiKey`、Token `token` 三个下拉，按记录里的原始 id 精确匹配。'
      + '原型只有结果/动作/凭据类型/域名/来源/关键字六项，没有按具体身份收窄的控件，所以这三个 `select.sel.sm` 是实现侧多出来的；'
      + '它们的形态与既有两个下拉逐字相同（同一个 `.sel.sm`、同一个 GET 表单），值只放 id、可读名称只放文案，不回显任何密钥或 Token 明文。'
      + '三个下拉的 canonical line 相同，所以写成一条 `count: 3`（两条同名条目会被拒绝：会互相遮蔽失效检测）。',
  }),
  Object.freeze({
    state: 'audit', line: '↻ option :: T {  }', side: 'live-only', kind: 'state', count: 3,
    reason: '同上三个下拉各自的选项组。这是一个重复组（`↻`），所以按判据只能声明为 `state`，但缘由不是数据状态差异，而是实现侧多了三组筛选控件：'
      + '原型没有这三项筛选，也就没有对应的 `<option>` 组。第一个选项是「所有…」，其余每个是被审计记录真实出现过的 id（数量由数据决定，所以只算一个重复组）。',
  }),
  Object.freeze({
    state: 'vaults', line: 'btn.btn.futonly :: -', side: 'proto-only', kind: 'deliberate',
    reason: '原型的「扫描新 Vault」是设想控件（`.futonly` + `fut("#437")`）。#437 已交付：统一对账服务按目录 watcher 与周期轮询运行，'
      + '页栏的「刷新 Vault 清单」就是同一次手动对账（`POST /refresh` → `admission.reconcile("manual")`）。'
      + '再造一个只做同一件事的按钮等于两个控件一份能力，所以实现侧把它删掉了。',
  }),
  Object.freeze({
    state: 'vaults', line: 'span.fut :: T', side: 'proto-only', kind: 'deliberate',
    reason: '同一条的另一半：实现侧不再渲染「规划中」标记。抽屉原来那句「扫描新 Vault / 热刷新尚未接线」已经不成立（生产 `VAULT_DISCOVERY_ENABLED=true`），'
      + '继续标「规划中」会让已完成的功能看起来没做。抽屉现在直接写运行时事实（发现开关、定时、最近一次对账、最近成功、最近错误）；'
      + '页栏那个设想按钮整个删除（见上一条）。',
  }),
  /* ---- 定时授权（冻结页）：Task 3 移除了「当前状态预览」卡片与「新建策略」入口，并加了冻结横幅 ---- */
  Object.freeze({
    state: 'authz', line: 'div.sect :: -', side: 'proto-only', kind: 'deliberate',
    reason: '「当前状态预览」区域的容器是一张 POST 到 /preview 的表单；Task 3 冻结了全部七个旧写入端点（409 access_policy_frozen），'
      + '所以这个只读页面不能继续提供它。同一份现在判定与 7 天时间轴仍在只读视图（?edit=）的 .ped-side 里；'
      + '按 Vault 的定时约束在新页面 /admin/auth/authz 配置。逐条豁免对应同一处移除的每一层骨架。',
  }),
  Object.freeze({
    state: 'authz', line: 'div.sect-h :: -', side: 'proto-only', kind: 'deliberate',
    reason: '同一区域的分区标题（见 div.sect 一条）：标题行随那张已冻结的表单一起移除，单独留一个空标题只会是死版面。',
  }),
  Object.freeze({
    state: 'authz', line: 'h2 :: T', side: 'proto-only', kind: 'deliberate',
    reason: '「当前状态预览」的 h2（见 div.sect 一条）。文案面见同状态的 label 豁免。',
  }),
  Object.freeze({
    state: 'authz', line: 'span.muted :: T', side: 'proto-only', kind: 'deliberate',
    reason: '「查看某个主体此刻是否被策略限制」这一行副标题，它与卡片同属那张已冻结的 POST 表单（见 div.sect 一条）。',
  }),
  Object.freeze({
    state: 'authz', line: 'div.card :: -', side: 'proto-only', kind: 'deliberate',
    reason: '同一区域的内容卡片：卡片里的主体 select 与「查看」提交按钮就是那张已冻结的 POST 表单（见 div.sect 一条）。',
  }),
  Object.freeze({
    state: 'authz', line: 'div :: -', side: 'proto-only', kind: 'deliberate',
    reason: '卡片里包裹主体下拉与「查看」按钮的那一行 flex 容器，随那张已冻结的 POST 表单一起移除（见 div.sect 一条）。',
  }),
  Object.freeze({
    state: 'authz', line: 'select.sel :: -', side: 'proto-only', kind: 'deliberate',
    reason: '试算用的主体下拉：它的值原先以 POST 提交到已冻结的 /preview（见 div.sect 一条）。'
      + '同名的 .sel.sm 下拉在审计工具栏上仍逐项对照（形状与封闭态），自绘下拉的交互契约由 admin-design 的 Q12 对照。',
  }),
  Object.freeze({
    state: 'authz', line: '↻ option :: T {  }', side: 'proto-only', kind: 'state',
    reason: '被移除的主体下拉的选项组：这是一个重复组（↻），所以按判据只能声明为 state，但缘由不是数据状态差异，'
      + '而是整张试算卡片（POST 到已冻结 /preview）随 Task 3 一起移除——见同状态的 div.sect 一条。选项来自运行时主体清单，数量本身就是数据。',
  }),
  Object.freeze({
    state: 'authz', line: 'p.help :: T', side: 'proto-only', kind: 'deliberate',
    reason: '「选择主体后显示命中的策略及此刻的判定」这句提示随卡片移除（见 div.sect 一条）。',
  }),
  Object.freeze({
    state: 'authz', line: 'span.hide-m :: T', side: 'proto-only', kind: 'deliberate',
    reason: '「新建策略」标签的响应式隐藏包装，随创建入口一起移除（见同状态的 btn.btn.primary 一条）。',
  }),
  Object.freeze({
    state: 'authz', line: 'btn.btn.primary :: -', side: 'proto-only', kind: 'deliberate',
    reason: '「新建策略」是创建入口：旧策略文档已冻结（所有写入 409），只读页面不能提供它。'
      + '按 Vault 的定时约束在新的定时授权页面创建；这一处的形状差异与文案差异（.btn = 新建策略）各一条。',
  }),
  Object.freeze({
    state: 'authz', line: 'div.amber.banner :: -', side: 'live-only', kind: 'deliberate',
    reason: '冻结横幅（R8 的诚实规则）：页面必须说明自己只读、指向新页面，并写出当前授权模式。原型没有这一条，'
      + '因为原型没有“策略文档已冻结”这个事实；不带横幅的只读页面会让操作员以为策略已经不生效（legacy 模式下它们仍在判定）。',
  }),
  Object.freeze({
    state: 'authz', line: 'div :: T', side: 'live-only', kind: 'deliberate',
    reason: '冻结横幅内部的文本容器：横幅把图标与一段带链接的说明分成两个子节点（见同状态 div.amber.banner 一条）。',
  }),
  Object.freeze({
    state: 'authz', line: 'b :: T', side: 'live-only', kind: 'deliberate', count: 2,
    reason: '冻结横幅里的两处强调（「本页已冻结（只读）」与「仍然参与判定 / 不再参与判定」）。同一 canonical 行出现两次，'
      + '所以写成一条 count: 2（两条同名条目会被拒绝：会互相遮蔽失效检测）。',
  }),
  Object.freeze({
    state: 'authz', line: 'a [href=route:<a href=<v>] :: T', side: 'live-only', kind: 'deliberate',
    reason: '冻结横幅里指向 /admin/auth/authz 的链接（见 div.amber.banner 一条）。链接由常量拼出并经 esc 转义，不是注入点。',
  }),
]);

/** Budget for the structural-label waivers (`compareShapeLabels`). */
export const SHAPE_LABEL_WAIVER_BUDGET = 12;
export const SHAPE_LABEL_WAIVERS = Object.freeze([
  Object.freeze({
    state: 'vaults', label: '.btn = 扫描新 Vault 规划中 · ##', kind: 'deliberate',
    reason: '原型把「扫描新 Vault」画成设想（`fut("#437")`）。#437 已交付（目录 watcher + 周期对账 + 手动刷新），实现侧不再有带规划标记的按钮，'
      + '这串文案因此只在原型里；形状侧见同状态的 deliberate 豁免。',
  }),
  Object.freeze({ state: 'tokens', label: '.btn = 排序', kind: 'no-js-submit', reason: '排序控件的无脚本提交按钮（见同状态同 kind 的形状豁免；Wave R 同类排查后决定不在脚本生效时收起）。' }),
  Object.freeze({ state: 'audit', label: '.btn = 筛选', kind: 'no-js-submit', reason: '审核筛选表单的无脚本提交按钮（见同状态同 kind 的形状豁免）。' }),
  Object.freeze({ state: 'audit', label: '.btn = 应用', kind: 'no-js-submit', reason: '每页条数表单的无脚本提交按钮（见同状态同 kind 的形状豁免）。' }),
  Object.freeze({
    state: 'audit', label: '.btn = 导出 CSV 规划中 · 设想', kind: 'deliberate',
    reason: '原型把「导出 CSV」画成设想（虚线按钮 + 「规划中 · 设想」）。审计记录本来就在手上，所以它是一个真实下载：'
      + 'GET /admin/auth/audit/export.csv 按当前筛选导出行集，带 UTF-8 BOM/CRLF/RFC 4180 引号与公式注入防护。'
      + '所以原型那串带规划标记的文案在实现侧不存在——形状侧的同一处差异见同状态的 deliberate 豁免。',
  }),
  Object.freeze({
    state: 'audit', label: '.btn = 导出 CSV', kind: 'deliberate',
    reason: '同一条的文本面：实现侧按钮只写「导出 CSV」（真实下载，不再自称设想）。按钮的载体 span.hide-m 与类名未变，'
      + '行集由 outcome/action/credential/origin/source/q 决定，与页面共用 readFilters + matches。',
  }),
  Object.freeze({
    state: 'vaults', label: '.btn = 初始化准入', kind: 'deliberate',
    reason: '上面那条 `btn.btn` 形状豁免的文案面：它是全新部署里唯一的准入入口（原型没有准入区），'
      + '无脚本时仍是一个真实可用、真实可点的 GET 链接（`?confirm=admission`）。',
  }),
  Object.freeze({ state: 'authz', label: '.btn = 新建策略', kind: 'deliberate', reason: '「新建策略」入口随旧写入一起移除（见同状态的 btn.btn.primary 形状豁免）。' }),
  Object.freeze({ state: 'authz', label: 'h2 = 当前状态预览', kind: 'deliberate', reason: '「当前状态预览」区域移除后它的标题也随之消失（见同状态的 div.sect 形状豁免）。' }),
  Object.freeze({ state: 'authz', label: 'p.help = 选择主体后显示命中的策略及此刻的判定。', kind: 'deliberate', reason: '试算卡片的提示文案随卡片移除（见同状态的 div.sect 形状豁免）。' }),
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
