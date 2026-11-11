// Prototype-parity gate — the page registry and the comparison contract.
//
// Authority for every expectation in this file is `docs/admin-ui-proto/` (the prototype is the
// Admin UI truth source; the deleted Admin UI v2 is not). The registry therefore never carries a
// hand-invented markup contract: the *proto* side of every comparison is read out of the running
// prototype at gate time (`spec.mjs` only says which prototype route belongs to which live route),
// and the recorded column lists below are a golden copy that `test/admin-redo/parity.test.js`
// re-derives from `docs/admin-ui-proto/src/5-render.js`, so an edit to the prototype fails the unit
// test instead of silently drifting away from the gate.
//
// Route pairing (prototype hash ⇄ live URL) is the one hand-written fact: the prototype is a
// hash-routed single file, the Admin plane is server-rendered under `/admin/auth`.

/** The nine Admin pages the lane brief names. `id` is the name used in reports. */
//
// The prototype's policy EDITOR (`#/authz/new`) is deliberately NOT paired: Task 3 froze the legacy
// write surface, so the plane has no editor form, no draft round trip and no save — `?new=1` renders
// the frozen list. Comparing the prototype's form against a page that can never hold one would force
// the gate to waive every control of that page (`.chk`, `.chip`, `.fld`, `fieldset.fs`, `.btn.primary`,
// `.ped-foot`), which is exactly what a parity gate must not do. The surviving surfaces of the same
// data are still paired: `authz` (the list, the `?id=` drawer vocabulary) and the read-only `?edit=`
// view, which the no-JS and design scenes assert.
export const PARITY_PAGES = Object.freeze([
  Object.freeze({
    id: "overview",
    title: "概览",
    proto: "#/overview",
    live: "/admin/auth?tab=overview",
    table: false,
    drawer: null,
  }),
  Object.freeze({
    id: "accounts",
    title: "OAuth 账户",
    proto: "#/accounts",
    live: "/admin/auth?tab=accounts",
    table: true,
    drawer: Object.freeze({ kind: "账户详情", protoPrefix: "#/accounts", liveParam: "id" }),
  }),
  Object.freeze({
    id: "keys",
    title: "API Key",
    proto: "#/keys",
    live: "/admin/auth?tab=keys",
    table: true,
    drawer: Object.freeze({ kind: "Key 详情", protoPrefix: "#/keys", liveParam: "id" }),
  }),
  Object.freeze({
    id: "clients",
    title: "OAuth 客户端",
    proto: "#/clients",
    live: "/admin/auth?tab=clients",
    table: true,
    drawer: Object.freeze({ kind: "客户端详情", protoPrefix: "#/clients", liveParam: "id" }),
  }),
  Object.freeze({
    id: "tokens",
    title: "OAuth Token",
    proto: "#/tokens",
    live: "/admin/auth?tab=tokens",
    table: true,
    drawer: null,
  }),
  Object.freeze({
    id: "publishes",
    title: "发布文档",
    proto: "#/publish",
    live: "/admin/auth?tab=publishes",
    table: true,
    drawer: null,
  }),
  Object.freeze({
    id: "audit",
    title: "审计",
    proto: "#/audit",
    live: "/admin/auth?tab=audit",
    table: true,
    drawer: null,
  }),
  Object.freeze({
    id: "authz",
    title: "定时授权",
    proto: "#/authz",
    live: "/admin/auth/access-policy",
    table: true,
    drawer: null,
    /**
     * Prototype elements this page deliberately does not render, each with the reason (printed as a
     * note on every run, never dropped silently).
     *
     * Task 3 froze the legacy write surface (design §7 step 2 + step 5): the 当前状态预览 card was a
     * POST form to the frozen `/preview` route — with the script running it fetched the verdict for a
     * chosen subject and adopted it in place — and 新建策略 created a policy in the frozen document.
     * Rendering either would be a promise the route refuses with 409. Everything else on the page
     * (the table, its columns, the window cells, the `?id=` drawer vocabulary, the banners) is still
     * compared verbatim, and the same verdicts/revision are still readable on the `?edit=` view
     * (`.ped-side`: 现在（…）判定, the 7-day timeline and the summary).
     */
    omitted: Object.freeze([
      Object.freeze({
        selector: ".main .sect",
        reason: "「当前状态预览」区域的容器：它是一张 POST 到已冻结 /preview 路由的表单（Task 3 冻结了全部旧写入端点）。"
          + "只读视图（?edit=）里的 .ped-side 仍显示同一份现在判定与 7 天时间轴。",
      }),
      Object.freeze({
        selector: ".main .sect-h",
        reason: "同一区域的分区标题：「当前状态预览」的 h2 行随那张已冻结的 POST 表单一起移除，单独保留一个空标题只会是死链接。",
      }),
      Object.freeze({
        selector: ".main .card",
        reason: "同一区域的内容卡片：卡片里的主体 select 与「查看」提交按钮就是那张已冻结的 POST 表单，卡片本身没有别的用途。",
      }),
      Object.freeze({
        selector: ".main .btn.primary",
        reason: "「新建策略」是创建入口：旧策略文档已冻结（409 access_policy_frozen），只读页面不能提供它；"
          + "按 Vault 的定时约束在新的定时授权页面（/admin/auth/authz）创建。",
      }),
    ]),
  }),
  Object.freeze({
    id: "vaults",
    title: "Vault 与 Git",
    proto: "#/vaults",
    live: "/admin/auth/vault-git",
    table: true,
    drawer: Object.freeze({ kind: "Vault 详情", protoPrefix: "#/vaults", liveParam: "id" }),
  }),
]);

/**
 * The recorded prototype column lists (`docs/admin-ui-proto/src/5-render.js` `table([...])` calls,
 * in order, with the trailing empty action column the prototype declares as `["", "", "act"]`).
 * `parity.test.js` re-derives these from the prototype source; the gate itself reads the live
 * prototype DOM, so this copy exists to fail loudly when the prototype changes, not to compare.
 */
export const RECORDED_PROTO_COLUMNS = Object.freeze({
  accounts: Object.freeze(["账户", "状态", "权限上限 · Vault", "已授权客户端", "最后登录", "创建", ""]),
  keys: Object.freeze(["名称 / 前缀", "权限 · Vault", "最后调用", "来源", "创建", ""]),
  clients: Object.freeze(["客户端", "已授权账户", "连接域名", "最后调用", "回调地址", ""]),
  tokens: Object.freeze(["客户端 · 账户", "Token（短 ID）", "权限 · Vault", "最后使用 · 签发", "状态", ""]),
  publishes: Object.freeze(["文档", "状态", "公开链接", "发布者", "发布时间", ""]),
  audit: Object.freeze(["时间", "结果", "动作", "凭据", "Agent", "来源", ""]),
  authz: Object.freeze(["策略", "状态 · 模式", "主体", "限制的能力", "允许时间窗口", ""]),
  vaults: Object.freeze(["Vault", "Git 状态", "同步方式", "远端 / 分支", "能力", ""]),
});

/**
 * Required-element candidates: the prototype's own vocabulary (`.bar h1`, `.stats`, `.lede`,
 * `.toolbar`, `.banner`, `.drawer`, `.mcard`/`.mcards`, `.tw`, `.tbl`, …). The gate intersects this
 * list with what the prototype page actually renders and requires the live page to render the same
 * set — so a page that is missing a whole region (its `.lede`, its toolbar, its table card) fails,
 * and a class the prototype does not use on that page is never demanded.
 *
 * Every entry is a selector valid in both trees. `.main` scopes the page proper (the shell is
 * checked separately through the sidebar/mobile-nav vocabulary).
 */
export const ELEMENT_CANDIDATES = Object.freeze([
  ".main .bar h1",
  ".main .bar .cnt",
  ".main .content.scroll",
  ".main .page",
  ".main .page.wide",
  ".main .lede",
  ".main .toolbar",
  ".main .search",
  ".main .seg",
  ".main .tw",
  ".main .tbl",
  ".main .mcards",
  ".main .mc",
  ".main .stats",
  ".main .stat",
  ".main .sect",
  ".main .sect-h",
  ".main .list",
  ".main .li",
  ".main .ov2",
  ".main .kv",
  ".main .banner",
  ".main .banner.amber",
  ".main .banner.danger",
  ".main .pager",
  ".main .empty",
  ".main .card",
  ".main .grid2",
  ".main .grid3",
  ".main .fld",
  ".main .chk",
  ".main .picker",
  ".main .chips .chip",
  ".main .switch",
  ".main .verdict",
  ".main .tl",
  ".main .sumbox",
  ".main .ped",
  ".main .ped-form",
  ".main .ped-side",
  ".main .ped-foot",
  ".main fieldset.fs",
  ".main .mode",
  ".main .cap-g",
  ".main .cap-h",
  ".main .cap-b",
  ".main .caps",
  ".main .idc",
  ".main .tag",
  ".main .tag.amber",
  ".main .st",
  ".main .nm",
  ".main .sub2",
  ".main .cellt",
  ".main td.act",
  ".main .btn.primary",
  ".main .btn.ghost",
  ".main .btn.danger-o",
  ".drawer.on",
  ".drawer.on .dsec",
  ".drawer.on .kv",
  ".drawer.on .danger-zone",
  ".drawer.on .fld",
  ".drawer.on .chk",
  ".drawer.on .switch",
  ".drawer.on .caps .cap",
]);

/**
 * **Equivalent substitutions** for a required element. The prototype is scripted, so a control it
 * draws as a `<button class="switch">` (state flipped by JS) has to be expressed as a real form
 * control on the Admin plane, which renders without scripting at all (`AGENTS.md`: `<script>` is
 * forbidden by CSP). The *criterion* is unchanged — "this page must offer this control" — but it
 * is satisfied by the named substitute, and only where a substitute is listed here.
 *
 * `accept` entries are selectors valid in both trees; the live page passes when it renders any of
 * them. Every entry carries the reason the substitution is a real one, so this cannot become a
 * place to hide a missing region (anything a page really needs is still derived from the prototype).
 */
export const ELEMENT_EQUIVALENTS = Object.freeze({
  '.main .switch': Object.freeze({
    accept: Object.freeze(['.main .chk', '.main input[type=checkbox]']),
    reason: '原型用 `<button class="switch">`（脚本翻状态）；SSR 无脚本、无 CSP 例外，一个要提交状态的开关只能由真实表单控件承担。'
      + '这条替换让“页面必须有这个控件”在那种写法下仍然成立，而不是把控件豁免掉。当前没有页面用到它（Vault 的开关是提交按钮，'
      + '定时授权的总开关是 `role="img"` 的只读指示），保留是为了让下一个这样的页面不必新增豁免。',
  }),
});

/**
 * Deliberate **non**-requirements, each with the reason it is not asserted. The list is short on
 * purpose: it must not become a place to hide a missing region. Anything a page really needs is
 * derived from the prototype and required.
 */
export const EXCLUDED_CANDIDATES = Object.freeze([
  Object.freeze({ selector: ".toast", reason: "脚本驱动的瞬时反馈；D0 无脚本，SSR 用 .result 行代替（`app/src/admin/ui.js: result`）" }),
  Object.freeze({ selector: ".scrim", reason: "脚本驱动的遮罩状态；SSR 用 `?id=` / `?confirm=` 的静态渲染" }),
  Object.freeze({ selector: ".menu", reason: "脚本弹出的行菜单；SSR 用 <details class=\"mn\">，语义在结构中而非同名 class" }),
  Object.freeze({ selector: ".modal", reason: "脚本弹窗；SSR 用独立确认页（`ui.js: confirmPage`）" }),
  Object.freeze({ selector: ".fut, .futonly, .futbox", reason: "规划中标记：原型里属于未实现功能，D0 阶段允许省略，不作为必需元素" }),
  Object.freeze({ selector: ".hide-m, .mobile-only", reason: "响应式显隐钩子，不是页面结构证据" }),
  Object.freeze({ selector: ".ibtn", reason: "图标按钮：原型页头里的移动端汉堡键是脚本 affordance（D0 无脚本），SSR 用 .mnav 的 <details>；剩余 .ibtn（复制/关闭等）按页面逐个可选，不作为全局必需元素" }),
]);

/**
 * The migrated `#401`/#458 column-overflow contract (was `.col-vault{min-width:7em}` +
 * `.col-actions`): a table cell whose content the prototype declares unbreakable must keep one
 * line. Scoped to the new vocabulary — `.tbl`, `.cellt`, `.nm`, `.idc`, `.mono`, `.tag`, `.act` —
 * plus the audit/badge equivalents the standard calls out, and never a full-page assumption.
 */
export const KEEP_CONTRACT_SELECTOR = ".tbl .cellt, .tbl .mono, .tbl .idc, .tbl .nm b, .tbl .nm .sub2, .tbl td.act .mn > summary, .tag, .cap, .idc";

/**
 * Deployment data that appears in the drawer's choice inventory but is **not** a prototype
 * contract: the Vault selection's option values are the registry ids of whatever Vaults the
 * deployment serves (`vault`, `research` in the prototype fixture, the fixture server's own id at
 * gate time). The *presence* of a Vault choice is asserted; its identity is recorded as evidence.
 * Every other choice token (scope keys, capability keys, mode keys) is product vocabulary and is
 * compared verbatim.
 *
 * Named per tree because the two trees label the same control differently: the prototype's
 * `vaultChecks` writes `name="vault"` (`6-app.js`), the plane's `model.vaultOptions` writes
 * `name="allowedVault"` (`presentation/model.js`), and the scope picker likewise differs
 * (`scope` × `allowedScope`) while carrying the same tokens.
 */
export const DATA_CHOICE_FIELDS = Object.freeze(["vault", "allowedVault"]);

/** Paint criteria (declaration level; the unit test re-derives them from the served CSS). */
export const PAINT_TOKENS = Object.freeze(["--accent", "--bg", "--line"]);
/**
 * Query ids that are *not* a record detail: the list pages' `新建` link (`?id=new`, e.g.
 * `?tab=accounts&id=new`) opens the create drawer, while the prototype's `#/<page>/<id>` links are
 * row links. Pairing the create drawer with a prototype detail drawer compares two different
 * surfaces, so the sentinel is skipped when the gate picks the drawer id.
 */
export const CREATE_DRAWER_IDS = Object.freeze(["new"]);
export const BAR_HEIGHT_PX = 52;
export const CHIP_MAX_HEIGHT_PX = 28;
export const CHIP_MAX_WIDTH_PX = 320;
