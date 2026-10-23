# 真机人工验收清单：移动端 / 触屏与图片拖放上传

本清单把最近几轮**已合并但只有 Chromium 仿真证据**的移动端 / 触屏特性整理成可逐条执行的真机验收步骤，供操作者在真实 iOS Safari / Android Chrome 上复核并留下可归档证据。它不替代自动门禁，只补自动门禁证明不了的那一层：真实指针类型、真实刘海 / safe-area、真实软键盘、真实手势与惯性。

## 0. 目的、范围与已合并事实

为什么现在要做真机验收：

- `#337` 三刀全部已合入 `main`，但三份 HANDOFF 都如实登记「真机验收未做」。
- `#371`（顶栏 / 抽屉重整）已合入，其 safe-area 与抽屉互斥同样只在 headless Chromium 验证过；`env(safe-area-inset-*)` 在 headless 恒为 `0`，**真机是否非零仍未验证**（见 §0.1）。
- U30（编辑器图片拖放原地上传）没有做过生产 / 真机端到端。
- `#471` 的 **P1 安装元数据**（Web App Manifest + 192/512/maskable 512/Apple 180 图标 + app 壳 Apple standalone meta + CSP `manifest-src 'self'`）**尚未合并**（候选分支，**无 Service Worker** —— SW 属 P2）；本清单 **F 段**即其真机项，自动门禁只覆盖元数据本身。

本清单覆盖的实现（引用均已核对存在，见 §0.2）：

| 段 | 特性 | issue | 合并 PR | 合并 commit | 实现说明 |
| --- | --- | --- | --- | --- | --- |
| A1 | Explorer 触摸 / 笔预取（#337 Cut 1） | #337 | #366 | `d893555a` | `docs/web-explorer-touch-prefetch.md` |
| A2 | Bases 移动 chrome（#337 Cut 2） | #337 | #370 | `729e5af4` | `docs/web-bases-mobile-chrome.md` |
| A3 | Bases 表格触摸（#337 Cut 3） | #337 | #381 | `352e2dc3` | `docs/web-bases-table-touch.md` |
| B | 移动端顶栏 / 左右栏抽屉重整 | #371 | #385 | `0d08d127` | `docs/web-mobile-shell-reflow.md` |
| C | 编辑器图片拖放原地上传（契约 v1） | — | #389 | `eb8b5a23` | 契约在 Vault `TODO - Obsidian Web 图片拖放原地上传` |
| F | 安装元数据与 standalone 启动（P1） | #471 | **未合并**（候选分支） | — | 本文档 F 段 + `docs/pwa-install-metadata.md`；**不含 SW** |

状态词一律按 `docs/AGENT_EXECUTION_GUIDE.md`：本表**除已明确标注「未合并（候选分支）」的行外**，其余特性当前记 **merged**（只表示在 GitHub `main` 上），真机验收通过后才可升格为 **production-verified**；已 tag + 部署分别记 **released** / **deployed**。

### 0.1 `viewport-fit=cover`（issue #369，**仍 OPEN**）—— app 壳 meta 的前提已修，真机 safe-area 读数仍未验证

> **订正（2026-10-10，web-bases 协调方）：** 本小节原文写「App 页面的 viewport meta 目前是 `width=device-width,initial-scale=1`，**没有** `viewport-fit=cover`……后果：真机上 `env(safe-area-inset-*)` **恒为 `0px`**」—— **该描述已作废**（依据已不成立）：

- `#369` 的 **app 壳 meta 部分**已由提交 `f9656540`（PR **#431**）修复，并随 **`v2026.10.09.1`** 部署：app 壳（`/app` 与 `/app/note/*`）的 viewport meta 现为 `width=device-width,initial-scale=1,viewport-fit=cover`（源在 `app/src/app/pages.js:99`）。
- **但 `#369` 仍 OPEN**（app 壳 meta ≠ 整体完成）：其剩余面包括**真机设备端 safe-area 复验**、**匿名 publish 页 meta**、**publish 窄屏设备复验** —— 这些仍按「未验证」处理。
- **匿名登录页刻意不带 `viewport-fit`**（按其设计记录，不是缺口）。
- ⇒ **非零 inset 的前提已具备**，但 `env(safe-area-inset-*)` 在真机上**是否非零从未实测**。因此本清单**不再写「真机恒为 0」**；A2 / B5 的 safe-area 子项改用下列口径：
  - 记 **`UNVERIFIED-REAL-DEVICE`**（本清单新增状态词，仅用于**尚未验证或证据不足**）；**不要**预设为 0，也不要仅因观察不到非零 inset 就判 FAIL —— 把**实测到的值**（含 0）如实写进备注。
  - **拿到可判别的真机读数后，不得继续填 `UNVERIFIED-REAL-DEVICE`**：按契约判 `PASS` / `FAIL`；若设备本身无适用安全区（如无刘海），记 `N/A` 并写明原因。
  - 旧状态词 **`KNOWN-GAP(#369)` 已退役**（其「真机恒为 0」的依据已不成立）；历史验收记录里的该词按「当时前提缺失」理解，不改写历史。⚠ **退役状态词不等于 #369 已关**（见上）。
- 参考：issue [#369](https://github.com/OhiyoX/obsidian-mcp-server/issues/369)（**仍 OPEN**）。

### 0.2 引用核对（验收时逐条复核过）

- issue（**2026-10-10 实时核对**）：`#337`（Web Mobile / Touch UX 专项，**CLOSED** 2026-10-07）、`#369`（viewport-fit=cover，**OPEN** —— app 壳 meta 已修、剩余项见 §0.1）、`#371`（m 端顶栏 / 抽屉重整，**CLOSED** 2026-10-07）、`#388`（asset drop 真进度，OPEN，解释 C1 的进度行为）、**`#418`**（m 端左抽屉在 Bases 上穿透，**OPEN**；修复候选 PR #468 尚在定位一条未分类 CI 红，**未合并**；本清单 **D 段**即该刀的真机项）、**`#473`**（#418 修复的**旧引擎透明度回落**兼容欠账，非发布阻塞；本清单 **D2** 引用）。
- PR：`#366`→`d893555a`、`#370`→`729e5af4`、`#381`→`352e2dc3`、`#385`→`0d08d127`、`#389`→`eb8b5a23`（全部 MERGED）。

## 1. 观测约定：状态词、证据与安全

- **状态词**（每条检查只填一个）：`PASS` / `FAIL` / `N/A`（本设备上不适用，需写明原因）/ `BLOCKED`（环境或前置不具备）/ `UNVERIFIED-REAL-DEVICE`（该项只能真机观测，而**本次未取得有效读数/证据不足**）。**`UNVERIFIED-REAL-DEVICE` 不是结论词**：一旦拿到可判别的真机读数，就按契约记 `PASS` / `FAIL`（无适用安全区则 `N/A` 并说明），不得继续用它代替判定。**`KNOWN-GAP(#369)` 已退役**（其依据已不成立，见 §0.1；#369 本身仍 OPEN）。
- **证据要求**：每台设备每条检查至少留一份证据。截图命名建议 `U32-<检查项>-<平台>-<日期>.<ext>`（例：`U32-A2-android-20261007.png`），录屏命名同规则加 `-screenrec`。证据统一放 `scratch/web-bases/U32/evidence/`，并在记录表（E1）里登记文件名。
- **每条检查都要记设备**：机型 + OS 版本 + 浏览器名与版本（A4 要求 iOS 与 Android 各跑一遍）。
- **实例入口与凭据**：实例 URL 与登录方式见 Obsidian Vault 的 ops 笔记（`_Workspace/50-Ops/` 下的部署 / 运维笔记），**本清单与证据里绝不写** URL 里的 token、密码、API key、session cookie。
- 上机前先确认这份构建是你要验收的版本：从 Web 侧栏底部版本标记 / `GET /healthz` / `data/deployed-version.json` 读出「版本 tag + commit」，填入 E1 的表头。比较对象是本次要验证的 tag，而非「本地某个 checkout」。

## A. #337 Mobile / Touch UX（三刀）

### A1 · Cut 1 触摸预取（`d893555a`，PR #366）

**前置**：一台触屏设备（iOS Safari 或 Android Chrome），打开一个含「未展开、且本轮从未加载过」的目录行的 Vault；建议把网络节流为 Slow 3G，或先用远程调试挂上 `chrome://inspect`（Android）/ Safari 开发菜单（iOS）以便看请求时间线。位于 Explorer 文件列表。

**步骤**：

1. 手指按住某个未加载目录行 **≥100ms 且不移动**，然后松手，再观察展开该目录时的加载表现。
2. 对另一个未加载目录，**快速点按**（<100ms 内抬起）；再对第三个未加载目录做一次**快速上下滑动**（scroll）。
3. 再对第四个未加载目录：按住 ≥100ms 但在窗口内把手指**滑出该行超过约 10px**（或滑动列表），然后松手。
4. 在慢网 / 离线节流下，依次对 A、B、C 三个未加载目录各产生一次「按住 ≥100ms」的预取意图（保持在飞），观察第 3 个是否被丢弃。

**期望**：

- 步骤 1：出现预取 —— 随后展开该目录时**没有**「正在加载…」的空白档，或该档明显变短（预取命中同一 `childrenByParent` 缓存）。
- 步骤 2：**不**发出任何预取请求（快速点按由点击走正式请求；滚动不是意图）。
- 步骤 3：取消，**不**发预取；点击本身的正式请求不受影响。
- 步骤 4：最多 2 条投机请求在飞（`PREFETCH_CONCURRENCY_LIMIT = 2`），第 3 个**被丢弃、不排队**。
- 其余冻结参数（供判断是否为回归）：意图窗口 `100ms`、移动容差 `10px`、释放后 commit grace `250ms`、只认 `touch`/`pen`（鼠标忽略）、能力判定 `(pointer: coarse) OR (hover: none)`。详见 `docs/web-explorer-touch-prefetch.md` §2。

**证据**：远程调试 Network 的请求时间线截图（标出哪次触摸对应哪条 tree 请求），或（无调试器时）慢网下「按住 100ms 后展开」与「直接点开」的对照录屏；步骤 2/3 的负向结果同样要留证据。记录机型 / OS / 浏览器版本。

**失败上报**：[issue #337](https://github.com/OhiyoX/obsidian-mcp-server/issues/337)（Cut 1）。参数回归（100ms / 10px / 预算 2）也归 #337。

### A2 · Cut 2 Bases 移动 chrome（`729e5af4`，PR #370）

**前置**：设备宽度约 **360 CSS px**（或先横屏再转回竖屏，确认断点行为），打开一个含 `.base` 的 Vault 并进入该 Base；进入时视口宽度应 `≤480px`（这才是移动 chrome 生效的断点，`>480px` 是桌面 chrome）。

**步骤**：

1. 观察 Base 工具栏右侧动作（sort / filter / properties / search / new）：应经 **hamburger（☰）** 到达 —— 逐个点开 ☰，每项都点得进、能打开对应面板。
2. 打开任一面板：确认它是**全宽 overlay**（横跨视口宽、顶部锚定），**不是** bottom sheet；确认面板 header 有**关闭按钮**；点面板外的 **backdrop** 能关闭；若设备有外接 / 软键盘，按 **Escape** 也能关闭。
3. 在面板内的输入框（如 filter / search）里聚焦并输入，弹出**软键盘**，观察被聚焦的输入是否仍可见、面板是否随可视区收缩重锚。
4. safe-area：在刘海 / 挖孔机上，确认最上层 chrome（包括打开态 overlay）的内容不被刘海遮挡。

**期望**：

- 步骤 1：五项动作全部可达、可点开；桌面宽度下 hamburger / overlay header / backdrop 应为 `display:none`（本次可在真机上转横屏 >480px 顺带核对桌面形态未变）。
- 步骤 2：全宽 overlay、有 header 关闭、backdrop 关闭、Escape 关闭（三种关闭任一失效即 FAIL）。
- 步骤 3：软键盘弹出时聚焦输入**不被遮挡**，可见带内；键盘收起后面板高度恢复。这是 headless 无法证明、**只能真机确认**的一项。
- 步骤 4：**只能真机观测** —— 前提已具备（`viewport-fit=cover` 已在 app 壳，见 §0.1），但 `env(safe-area-inset-*)` 在真机上**是否非零未验证**；请把**实测值（含 0）**写进备注并记 **`UNVERIFIED-REAL-DEVICE`**，**不要**预设 0，也不要仅因观察到 0 就判 FAIL。
- 已知设计边界（不是 bug）：overlay 覆盖整个视口（含 App 自己的顶栏），所以手机上 Base 面板打开时全局抽屉开关暂时不可达；它提供 header 关闭 + backdrop + Escape 三种退出，属设计取舍。

**证据**：360px 下 ☰ 展开菜单截图、每个面板的全宽 overlay 截图、backdrop 关闭录屏；步骤 3 的「键盘弹出前 / 后」两张截图（能看到输入框与面板边界）；步骤 4 的刘海区截图（用于记录 `UNVERIFIED-REAL-DEVICE` 的实测 inset）。记录机型 / OS / 浏览器版本。

**失败上报**：功能失败 → [issue #337](https://github.com/OhiyoX/obsidian-mcp-server/issues/337)（Cut 2；**该 issue 已 CLOSED**，作为历史归属引用）；safe-area 读数异常 → 先对照 [issue #369](https://github.com/OhiyoX/obsidian-mcp-server/issues/369)（**仍 OPEN**：app 壳 meta 已修、剩余项见 §0.1；除非能证明是新回归，否则不要重开），并在验收记录里如实登记实测值。

### A3 · Cut 3 表格触摸（`352e2dc3`，PR #381）

**前置**：主指针为手指（`pointer: coarse`）的手机 / 平板；打开一个**列数多于视口宽度**、且**行数足以纵向溢出**的 Base 表格（例如 360×420 的容器内至少 7 行）。桌面 / 触控板为主指针的设备上这四项规则不启用，属预期。

**步骤**：

1. 在表格上做**横向滑动**；再在数据单元格上做**纵向滑动**；再在**列与列的边界处**做一次纵向滑动。
2. 测量并目测行高：手指点单元格是否好点（目标行高 ≥44px）。
3. 粗指针下列宽把手：在列边界处按住 / 拖动，确认把手**不出现、拖不动**；对同一表格用鼠标（若设备接鼠标）应仍能拖。
4. 先后点一个**链接单元格**和一个**非链接单元格**，再点一次已选中的非链接行。

**期望**：

- 步骤 1：横向滑动改变表格 `scrollLeft`；纵向滑动（数据单元格上、以及列边界上）都改变 `scrollTop`，且横向滚动**不吞掉**纵向手势；列边界处不再阻断手势（这是 Cut 3 修掉的实际陷阱）。
- 步骤 2：行高 ≥44px（普通行），单元格命中区舒适。
- 步骤 3：粗指针下 `display:none` 且未接线、拖拽无反应；v1 没有列宽拖拽替代方案。
- 步骤 4：点链接**只跳转笔记、不选中行**；点非链接单元格 ⇒ 恰好选中一行（有可见选中态），再点该行 ⇒ 清除。
- 已知平台行为（不是 bug）：一次被取消的滚动手势之后的**第一下点按可能不会变成 click**（平台的「停止滚动」）。测试行选中前先等列表停稳。

**证据**：横向平移前后 / 纵向平移前后的关键帧截图或录屏；列边界处纵拖的录屏；选中态截图；行高目测（可用设备开发工具量）。记录机型 / OS / 浏览器版本。

**失败上报**：[issue #337](https://github.com/OhiyoX/obsidian-mcp-server/issues/337)（Cut 3）。

### A4 · 双平台覆盖（iOS Safari + Android Chrome）

**前置**：至少各一台 iOS Safari 与 Android Chrome 设备。

**步骤**：把 A1、A2、A3 三段在 iOS Safari 与 Android Chrome 上**各完整跑一遍**。

**期望**：两平台各自记录结论；同一项在两平台结论不同（尤其 safe-area / 手势）时必须分别留下证据，不得用平台 A 的结论代填平台 B。

**证据**：每平台、每项独立证据文件；记录表（E1）每行都要有机型 / OS / 浏览器版本。

**失败上报**：平台相关失败按该项归属上报（A1/A2/A3 分别指向 #337 对应 Cut；safe-area 指向 #369）。

## B. #371 顶栏 / 左右栏抽屉（m 端）

**前置**：设备宽度 `≤720px`（这是「两侧都是抽屉」的断点；`>720px` 两侧 docked，属桌面网格）。`docs/web-mobile-shell-reflow.md` 是本段的实现说明。

### B1 · 欢迎页只有一条 topbar

**前置**：进入实例时**没有打开任何笔记**（欢迎态），视口 `≤720px`。

**步骤**：打开实例落地页，保持不打开任何笔记，观察顶部有几条横向 chrome 带，以及右栏开关的位置。

**期望**：只有**一条** topbar；右栏开关（`panel-right` 图标）是 topbar **最右**的按钮，而不是被一条几乎空白的 tab 行单独挂着。不得出现孤儿开关的空行。

**证据**：欢迎态截图（需能数清顶部 band 数量与开关位置）。记录机型 / OS / 浏览器版本。

**失败上报**：[issue #371](https://github.com/OhiyoX/obsidian-mcp-server/issues/371)。

### B2 · 打开笔记后标签条出现，开关仍在 topbar

**前置**：同 B1，视口 `≤720px`。

**步骤**：从文件树打开一篇 Markdown 笔记，再切回欢迎态（或先观察打开后的形态）。

**期望**：打开笔记后**标签条出现**（`.document-tab-row` 在有 tab 时进入布局）；右栏开关仍在 topbar 最右、不被标签条夺走。备注：Base 首次打开无 tab，标签行保持隐藏；从笔记切到 Base 时（inactive）标签行仍在 —— 这些都是既有契约，不是缺陷。

**证据**：打开笔记后的截图（顶部两条带 + 开关位置）。记录机型 / OS / 浏览器版本。

**失败上报**：[issue #371](https://github.com/OhiyoX/obsidian-mcp-server/issues/371)。

### B3 · ≤720px 开一侧关另一侧 + 遮罩关闭

**前置**：视口 `≤720px`，左右两侧都可打开。

**步骤**：

1. 打开左栏（Files / Search）→ 点右栏开关。
2. 反向：打开右栏 → 点左栏开关。
3. 打开任一侧，点 scrim（遮罩）。

**期望**：

- 步骤 1/2：**开一侧即关另一侧** —— 任何时刻 shell 上只有一个抽屉类（`.sidebar-open` / `.context-open` 互斥），不存在两侧同时打开。
- 步骤 3：点遮罩**关闭当前抽屉**（遮罩归当前抽屉所有）。

**证据**：步骤 1、2 的录屏（能看清一个关、另一个开），步骤 3 的关闭录屏。记录机型 / OS / 浏览器版本。

**失败上报**：[issue #371](https://github.com/OhiyoX/obsidian-mcp-server/issues/371)。

### B4 · 左右栏 header 对称

**前置**：视口 `≤720px`，可分别打开左右抽屉。

**步骤**：分别打开左抽屉与右抽屉，逐个对照两侧 header 的三个槽位：视图切换 / 关闭 / 操作位；并测量关闭按钮的命中区。

**期望**：左右 header **同形** —— 各有一个视图切换（switch）槽、**恰好一个** pane 级关闭（✕）槽、一个操作（actions）槽；两侧关闭按钮命中区 **≥44px**。不得出现「一侧没有 pane 级退出」的不对称。

**证据**：左右抽屉并排截图（标出三个槽位）；命中区测量（用设备开发工具量关闭按钮盒模型）。记录机型 / OS / 浏览器版本。

**失败上报**：[issue #371](https://github.com/OhiyoX/obsidian-mcp-server/issues/371)。

### B5 · safe-area 只作用于最上层 chrome

**前置**：刘海 / 挖孔机；视口 `≤720px`。

**步骤**：分别在三种状态下观察顶部 inset 的归属：(a) 只有 topbar；(b) 左抽屉覆盖 topbar；(c) 右抽屉覆盖 topbar。关注「哪条 band 多吃了 `env(safe-area-inset-top)`」。

**期望**：**只有最上面那条可见 chrome** 吃顶部 inset：仅 topbar 时归 topbar；抽屉覆盖时抽屉接管、被覆盖的 topbar 归还它（交接）。`--pane-header-height` 本身不再包含 `env(safe-area-inset-top)`。

**只能真机观测**：前提已具备（见 §0.1），但真机 `env(safe-area-inset-*)` 是否非零**未验证**；请把三种状态各自的**实测 inset（含 0）**写进备注并记 **`UNVERIFIED-REAL-DEVICE`**，不要预设 0，也不要仅因观察到 0 就判 FAIL。

**证据**：三种状态各一张截图（标注 inset 归属的观察结果）；**同时如实记下实测的 inset 值（含 0）**；若设备本身无适用安全区（如无刘海），记 `N/A` 并说明原因。记录机型 / OS / 浏览器版本。

**失败上报**：契约失败（左右栏互斥 / 交接）→ 若确认为新回归，按 §E2 流程上报（**#371 已 CLOSED**，仅作历史归属引用）；safe-area 读数异常 → [#369](https://github.com/OhiyoX/obsidian-mcp-server/issues/369)（**仍 OPEN**，见 §0.1）。

## C. U30 图片拖放上传（契约 v1）

**前置**：一台**桌面**浏览器（C1–C5 真机非必需，桌面浏览器即可；C6 才涉及移动端）；一个可写（非只读）实例、一篇可编辑的 Markdown 笔记；准备素材：一张合法 `png`（例 `pixel.png`）、一个非法文件（例 `bad.pdf`）。

契约要点（供判断，见 PR #389 与 Vault 契约 v1）：白名单 `.png/.jpg/.jpeg/.gif/.webp`（**扩展名 + 魔数双白名单**，`.svg` v1 排除）；落盘 `attachments/`；同名走 `-1/-2…` 后缀；失败**绝不写 Markdown**。

### C1 · 单图原地上传 + 落点插入

**前置**：桌面浏览器打开一篇笔记的编辑（Live）模式。

**步骤**：从桌面文件管理器把 `pixel.png` 拖到正文中**某一行的中间**（不是文档末尾）的目标位置，松手。

**期望**：

- 出现一行上传状态（文件名 / 进度 / 取消）；
- 201 成功后，在**落点**插入 `![[attachments/pixel.png]]`，且图片**立即显示**（随后的读回 `GET /api/web/v1/asset?...` 返回 200）；
- 插入是**单次**编辑动作（一次 Ctrl+Z 可撤销）；
- 进度语义（v1 契约，非缺陷）：由于契约冻结用 `fetch`，进度条是**不确定态 → 201 即 100%**，不是字节级真进度。真进度另见 [#388](https://github.com/OhiyoX/obsidian-mcp-server/issues/388)。

**证据**：录屏或「拖放前 / 插入后」两张截图；Network 面板显示 `POST /api/web/v1/asset` 201 与随后资源 GET 200。记录浏览器版本。

**失败上报**：[PR #389](https://github.com/OhiyoX/obsidian-mcp-server/pull/389)（若只是「进度条不是真进度」，那是 v1 已知设计，指向 #388，不算 FAIL）。

### C2 · 多图拖放：顺序 + 失败不写 Markdown

**前置**：同 C1；准备 3 个文件且其中一个是失败样本（例 `a.png`、`bad.pdf`、`b.png`）。

**步骤**：一次把 3 个文件拖到同一个落点，松手。

**期望**：

- 出现 3 行状态，顺序与拖入文件顺序一致；
- 成功的按顺序**逐张串行**上传并插入（无并发）；
- **失败的那张不写 Markdown**，其行内**标红并给出原因**（响应 `error` 文案）；失败文件读回应为 404；
- 例：`bad.pdf` 被拒（415），只插入两张成功 embed，`bad.pdf` 不在 `attachments/`。

**证据**：录屏 + 失败行截图（含红色原因）+ Network 中该文件的 415。记录浏览器版本。

**失败上报**：[PR #389](https://github.com/OhiyoX/obsidian-mcp-server/pull/389)。

### C3 · 同名第二次 ⇒ `-1` 后缀，首个不变

**前置**：同 C1。

**步骤**：上传一次 `pixel.png`，再上传一次**同名** `pixel.png`。

**期望**：第二个落盘为 `attachments/pixel-1.png`（依次 `-1/-2…`，最多探到 1000，仍冲突 409）；**首个文件内容 / revision 不变**；正文两条 embed 分别指向两个路径。

**证据**：文件树 `attachments/` 截图（两个文件）+ 正文两条 embed 截图；或用两次 GET 的大小 / 字节对比。记录浏览器版本。

**失败上报**：[PR #389](https://github.com/OhiyoX/obsidian-mcp-server/pull/389)。

### C4 · 撤销只回退插入、不删已上传文件

**前置**：C1 上传成功、正文已插入 embed。

**步骤**：在编辑器里按一次 `Ctrl+Z`（macOS 为 `Cmd+Z`）。

**期望**：正文 embed 被移除（回到插入前），**`attachments/` 里的文件仍在**（GET 该资源仍 200）；同时出现**一次**提示（约「文件已上传，撤销仅移除引用。」）。

**证据**：录屏（含提示浮层）+ 撤销后 GET 该资源仍 200。

**失败上报**：[PR #389](https://github.com/OhiyoX/obsidian-mcp-server/pull/389)。

### C5 · 非法 / 越界：非图片被拒；只读模式被拒

**前置**：(a) 可写实例；(b) 另有一个 `OBSIDIAN_READ_ONLY=true` 的只读实例。

**步骤**：

1. 在可写实例把 `bad.pdf` 拖入编辑器；再把一个**扩展名是 `.png` 但内容是文本**的文件拖入。
2. 在只读实例上把合法 `pixel.png` 拖入编辑器。

**期望**：

- 步骤 1：均被拒（415，扩展名白名单或魔数不符），**不写 Markdown**，行内标红给出原因；
- 步骤 2：被拒（只读模式 `assertWritable()` → 403），**不写 Markdown、不落盘**。
- 越界场景（symlink 逃逸 / `.obsidian` / `.trash` / 根 / 路径穿越 / 绝对路径）属 API 层，真机 UI 无法构造；由 `app/test/web-asset-upload.test.js` 的真实 HTTP 矩阵覆盖。若要在人工侧验证，只能用 ops 实例构造附件目录，或如实标 **N/A（由自动测试覆盖）**。

**证据**：415 / 403 的画面或 Network 截图 + 「无链接写入」的证据（撤销 / 正文字数或读回 404）。记录浏览器版本。

**失败上报**：[PR #389](https://github.com/OhiyoX/obsidian-mcp-server/pull/389)。

### C6 ·（可选）移动端浏览器拖放「不适用」

**前置**：iOS Safari / Android Chrome。

**步骤**：尝试从系统相册把图片「拖」到编辑器正文。

**期望**：移动端浏览器通常**无法**做这种拖放 ⇒ 如实记 **N/A**，并写清契约 v1 的**非目标**：**移动端相册选择器不在 v1**（v1 非目标还包括非图片附件、外部 URL 抓取、粘贴上传、对象存储直传、Base 内上传、孤立附件回收、`.svg`/`.avif`/`.bmp` 等）。

**证据**：一行文字记录（N/A + 原因 + 引用契约 v1 非目标）即可。

**失败上报**：N/A 无需上报；若某些设备（如 iPad 分屏）真的能拖入且行为异常，则上报 [PR #389](https://github.com/OhiyoX/obsidian-mcp-server/pull/389)。

## D. #418 移动端抽屉层序与不透明（Bases 之上）

**前置**：设备宽度 `≤720px`（两侧均为抽屉的断点）；Vault 里存在一个 **Base**（`.base`）；已登录。

**背景（一句话）**：m 端打开左抽屉时，Bases 的表头 / 工具栏 / 面板会**盖在抽屉与遮罩之上**（feature-local `z-index` 与 fixed 抽屉同号或更高，且都越过 `.scrim`），并且抽屉底色直接取主题 chrome token —— 社区主题把 `--background-secondary` 给成半透明时，抽屉会**透出 Base 内容**。修复候选 = PR **#468**（`isolation: isolate` + `rgb(from … / 1)`，**尚未合并**）。

### D1 · 左抽屉打开在 Base 之上

1. 打开该 Base（进入 Bases 视图），再点顶栏左端按钮打开左栏。
2. 观察抽屉覆盖区：**不应**看到 Base 表头 / 工具栏图标 / 列竖线 / 结果文案穿过抽屉；抽屉表面应**完全不透明**。
3. 点抽屉**未覆盖**的那条竖带（遮罩区）：应由**遮罩**接住并关闭抽屉；若点击被 Base 按钮接走（抽屉不关、Base 菜单弹出），记 **FAIL**。

**期望**：抽屉是覆盖区内的**最上层**不透明表面；遮罩点击关闭有效。

### D2 · 半透明社区主题下的不透明性

**前置**：装一个把 `--background-secondary` 设为半透明的社区主题（例：`rgb(40 40 40 / 0.8)`），设备仍在 `≤720px`。

**步骤**：同 D1 打开 Base，然后**对左抽屉与右抽屉各做一次**（分别记录），观察抽屉表面。

**期望**：**两侧抽屉都仍不透明**（左右分别记）。**按支持范围记（#473 路线 A；见 `docs/WEB_OPERATIONS.md` 的 Supported browser floor）**：

- 设备浏览器**低于支持下限**（Chrome/Edge ≤118、Safari ≤16.3、Firefox ≤127）⇒ 该行记 **`N/A`**，并在备注写明「引擎版本低于支持下限」——**政策边界，不等于通过**（**不计入**已验证范围），**不再**记 `FAIL`；
- **范围内**引擎 ⇒ **实测**判：两侧抽屉仍不透明 ⇒ `PASS`（备注写浏览器版本）；**实测仍半透明 ⇒ `FAIL`**（真缺陷）。

**历史口径**：`#473` 曾把范围外引擎实测半透明记为「已知兼容欠账 · 非发布阻塞」；**路线 A 定下支持范围后由本节替代**（**历史失败记录保留**，不改写）。

### D3 · 右抽屉、Base 溢出菜单与关闭后行为

**步骤**：分别用 (a) **右抽屉**、(b) 先打开 Base 的 **☰ 溢出菜单**再打开左抽屉（⚠ **仅 `≤480px` 适用**：Bases 只在 `≤480px` 显示该入口；`481–720px` 对该子项记 **N/A** 并写明原因）、(c) 关闭抽屉后继续操作 Base。

**期望**：(a) 右抽屉同样不透明，其未覆盖竖带的遮罩点击能关闭；(b) 抽屉**盖住** Base 溢出菜单（不是反被盖）；(c) 抽屉关闭后 Base 视图**完全正常**（表头 / 菜单 / 表格可交互，无残留遮挡）。

**证据**：四组截图（默认主题抽屉开 / 半透明主题抽屉开 / 右抽屉开 / Base 菜单与抽屉同开）+ 遮罩点击关闭的录屏；备注写明机型 / OS / 浏览器版本。

**失败上报**：[issue #418](https://github.com/OhiyoX/obsidian-mcp-server/issues/418)。**注意**：自动门禁的同 tag 本机 390×844 coarse 证据**不等于**真机；真机层只由本段负责。

## F. #471 P1 · 安装元数据与 standalone 启动（**不含 Service Worker**）

**前置**：一台 Android Chrome 与一台 iOS / iPadOS Safari；设备已登录目标实例；部署版本包含 `#471` **P1**（manifest + 图标 + app 壳 Apple meta + `manifest-src 'self'`）。实例必须是 **HTTPS 源**（Chromium 的安装判定要求安全上下文；`http://127.0.0.1` 只在本地开发算安全）。

**背景（一句话）**：P1 只落**安装元数据** —— `/app/assets/manifest.webmanifest?v=…`（**内容寻址**：URL 由 `assetUrl()` 生成 `?v=<sha256[:16]>`，与图标 URL 同口径；`id` / `start_url` / `scope` **同为 `/app/`**，见 [#471](https://github.com/OhiyoX/obsidian-mcp-server/issues/471) R5 订正）、192 / 512 / 独立 maskable 512 / Apple 180 图标、app 壳的 `rel=manifest` + `apple-touch-icon` + 三个 Apple standalone meta、CSP 最小加 `manifest-src 'self'`。**没有 Service Worker**（属 P2），所以本段**不测**离线、预缓存与更新提示；**Publish 页不挂 manifest**（其 CSP 独立）。

**自动门禁已覆盖（真机不要重复记成结论）**：

- `app/test/web-pwa-install-metadata.test.js`：真实 HTTP 下的 head（app / note / Base **共用同一 manifest**、登录页不挂 manifest、Publish CSP 独立）、manifest 的 MIME / `immutable` 缓存 / 字段、图标**实际像素尺寸**、maskable 的**留白与安全区**（逐像素）、图标 URL 的 `?v=` 内容寻址。
- 浏览器门禁 `Chromium web regression` 的 `pwa:` 检查：Chromium **实际取回并解析** manifest（`Page.getAppManifest`；被 CSP 拦住时为红）、引擎按声明尺寸解码图标、maskable 安全区、以及 `black-translucent` 背后的**单一 top-inset owner**（注入非零 inset 后 topbar 高度精确增长、tab 行不重复补）。
- ⚠ **自动检查通过只允许 P1 候选送审**；**`#471` 的关闭仍须其原定的双平台真机验收**，不由自动门禁或本文档宣布。

**引擎事实（决定本段怎么记，不写「全平台保证」）**：

- Chromium **108（Android）/ 112（桌面）**起，**从浏览器菜单安装**不再要求带 `fetch` 的 Service Worker（[Chrome for Developers](https://developer.chrome.com/blog/update-install-criteria)）。**订正（原表述错误，已撤回）**：此前把「没有自动安装横幅」归因于「**无 SW**」——**该归因不成立**：当前官方安装条件（[web.dev · install criteria](https://web.dev/articles/install-criteria)）**并未**把 Service Worker 列为 `beforeinstallprompt` 的必要项，2023 年文章里的「for now」**不是当前保证**。⇒ 真机上若**未出现**自动横幅，**按实际观察如实记录**并登记为**未定性**（**不得**写成「因为没有 SW」）；横幅本身属 P2 观察范围，不作为本段判据。
- iOS / iPadOS **16.4–18**：只有 `display: standalone`（或旧式 `apple-mobile-web-app-capable` meta）才会以 Web App 方式打开 —— **本刀两者都发**。
- **订正旧说法**：「iOS 首次添加主屏一定重新登录」**不成立**：iOS / iPadOS **17.2** 起，「添加到主屏幕」创建 Web App 时**会复制 cookies（含登录态）**，但**只复制 cookies**（其他 local storage 不复制）（[WebKit 说明](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)）。F3 / F5 一律按**实际系统版本**记录，不沿用旧断言。

### F1 · Android Chrome：安装并从主屏启动

**步骤**：

1. Chrome 打开 `https://<实例>/app` 并登录。
2. 三点菜单：**记下实际文案**（「安装应用」/「添加到主屏幕」/「安装」），再执行。
3. 从主屏图标启动；在应用内打开一条笔记与一个 Base。

**期望**：启动后**无浏览器地址栏 / 底栏**（standalone）；应用内导航不跳回浏览器标签；菜单若只给「添加到主屏幕」快捷方式而没有安装入口，记 **`BLOCKED`（现象：引擎未给安装入口）** 并写明文案与机型 / 版本，**不要**记 PASS，**也不要**把原因写成「无 SW」（归因已订正，见上文）。

**额外观察项**：若应用内部发生到 **`/app`（无尾斜杠）**的跳转（切换 Vault、会话过期后重新登录等），**特别观察**它是否被引擎当成**跨 scope** 而在浏览器 UI 里打开（背景与两个候选修法见 `docs/pwa-install-metadata.md` §5）；如实记录现象与机型 / 版本，**不要预设**。

**证据**：主屏图标 + 启动后首屏截图（含状态栏）；Chrome 版本。

### F2 · Android 主屏图标（maskable）与主题色

**步骤**：(a) 看主屏图标的圆形 / 方圆遮罩形态；(b) 应用内切**深 / 浅**主题，再看状态栏与任务切换器里的应用卡颜色。

**期望**：图标是**满幅**的 maskable（无透明缺口、无异常白边，遮罩下图形完整居中）；状态栏 / 应用卡颜色跟随当前主题（沿用既有 `theme-boot.js` writer，**没有第二个 theme-color 写者**）。

**证据**：主屏图标（圆遮罩形态）+ 深 / 浅各一张截图。

### F3 · iOS / iPadOS：添加到主屏幕并启动

**前置**：先记系统版本（它决定 F5 的期望）。

**步骤**：Safari 打开 `https://<实例>/app` 并登录 → 分享 → 「添加到主屏幕」→ 从主屏启动 → 打开笔记、Base、抽屉与 tabs。

**期望**：图标为 apple-touch-icon（180，**不出现透明黑底**）；以独立窗口打开（无 Safari 地址栏 / 底栏）；应用内主要动作与浏览器内一致。

**证据**：主屏图标 + 启动首屏（含状态栏）；系统版本 + Safari 版本。

### F4 · standalone 状态栏与 safe-area（`black-translucent` 实测）

**前置**：有刘海 / 灵动岛 / 圆角的设备（iPhone X 起，或 Android 打孔屏）；已从主屏启动。

**步骤**：(a) 竖屏看顶栏；(b) 转横屏再看顶栏与正文左右边距；(c) 打开左抽屉（再看顶栏与抽屉的相对位置）；(d) 打开长笔记滚到顶与滚到底。

**期望**：`black-translucent` 下内容确实延伸到状态栏之下，但**顶栏内容不被状态栏遮挡**（顶栏按 `env(safe-area-inset-top)` 下移，52px 内容带完整可见）；横屏时左右 inset 生效（正文 / 抽屉不被圆角裁掉）；**唯一的 top-inset owner 仍是顶栏**（抽屉打开时由抽屉接管、顶栏让出，绝不双补）。

**记法**：用远程调试读出**实测值**并写进备注（含 0）：`getComputedStyle(document.querySelector('.shell')).getPropertyValue('--app-inset-top')`，或直接看 `env(safe-area-inset-*)`；拿不到可判别读数记 `UNVERIFIED-REAL-DEVICE`。

**证据**：竖 / 横屏截图（含状态栏）+ 实测值文本。

**失败上报**：按性质区分 —— 元数据 / 安装行为错报 [#471](https://github.com/OhiyoX/obsidian-mcp-server/issues/471)；安全区补偿不足报 [#369](https://github.com/OhiyoX/obsidian-mcp-server/issues/369)。

### F5 · 登录过期后返回

**步骤**：用**隔离的测试会话**造成确定性过期 / 撤销 —— 例如使用短 TTL 的测试会话，或由运维侧在**测试实例**上**撤销该会话**（撤销后先确认接口**返回 401**），→ 在应用内点一个会发请求的动作（打开笔记 / 切 tab）→ 落到登录页后重新登录。**不要**用「重启生产服务」来制造过期：**当前有效 Web 会话可跨重启存续**（本节前版「重启会撤销内存会话」是**错误前提**，已按实测撤回）。

**期望**：请求 401 / 302 后落到**登录页**，登录成功后回到可用的 app 壳；**不出现**旧账号数据、也不出现「白屏卡死」。

**注意**：iOS / iPadOS **17.2+** 添加主屏时 cookies 被复制 ⇒ 首次启动**可能已是登录态**（旧说法已订正，见上）；更早版本或未复制时首次启动会要求登录 —— 两者都算 PASS，按**实际**记录。

**证据**：过期后的画面 + 重新登录成功后的画面；系统 / 浏览器版本。

### F6 · 抽屉、tabs 与软键盘（standalone）

**步骤**：(a) 打开左抽屉再打开右抽屉；(b) 打开 2–3 条笔记，切换与关闭 tab；(c) 进入编辑面（Live / RAW）点进正文唤出软键盘，滚到长行末尾再收起键盘。

**期望**：抽屉 / tabs 与浏览器内一致（契约见 B 段与 `docs/web-mobile-shell-reflow.md`）：两侧互斥、遮罩点击可关；软键盘弹出后**光标行不被键盘遮住**、正文可继续滚动、收起后布局回正；tabs 不因键盘弹出被挤掉。

**证据**：录屏；机型 / OS / 浏览器版本。

**证据与上报**：截图命名沿用 §1 的 `U32-<检查项>-<平台>-<日期>.<ext>`（例 `U32-F1-android-20261010.png`），放 `scratch/web-bases/P471/evidence/real-device/`；失败上报 [#471](https://github.com/OhiyoX/obsidian-mcp-server/issues/471)。

### F7 · #471 内部 app 根 = `/app/`（I471-NAV 切片，**已合并**）

**背景**：P1 manifest 的 `id` = `start_url` = `scope` = `/app/`；scope 匹配是**同源前缀**测试，故**裸根 `/app` 在 scope 之外**（**设计如此**）。I471-NAV 把仓库里的**内部导航目标**统一为 `/app/`（切/建 Vault、welcome 路由、登录默认返回、会话过期 303 目标、Admin 入口链接），**不放宽 `next` 校验、不扩大 scope**（席位裁定 A）。

**先分清三类，判据不同**（避免把正确行为判成 FAIL）：

| 类别 | 说明 | 判据 |
| --- | --- | --- |
| **A. scope 内的内部导航** | 切/建 Vault、关闭最后一个 tab 后的 welcome 地址 | 应**留在已安装窗口内**（目标落在 `scope: /app/` 内） |
| **B. 认证交接** | `/auth/*`（登录页）**不在** scope 内、**未迁移**（设计如此） | 落到登录页**不算跳出**；判据是**登录完成后的最终返回**是否回到 scope 内 |
| **C. 旧书签观察项** | 裸根 `/app`（无尾斜杠）**在 scope 之外** | 仍应被服务（未登录时跳登录页）；standalone 下是否被引擎视为 scope 外导航**只作观察记录**，不单独据此判 FAIL |

**真机核对项**（本刀只到 Chromium 近似 + 几何判据，真机项**未证实**）：

1. **A：切换 Vault**（standalone 内）→ 应留在同一 standalone 窗口、无浏览器地址栏、不弹浏览器 UI；记录设备与是否「跳出到浏览器」。
2. **B：会话过期后重新登录** → **默认返回**为 `/app/`；但若入口带**合法 `next`**（note / Base 深链接），**必须回到该深链接并保留 query**（既有 HTTP 回归已覆盖此契约，见 `app/test/web-nav-root-scope.test.js`）；两者都**不得**落到空白或浏览器 UI。造过期请用**隔离测试会话**的确定性过期/撤销，**不要**用「重启生产服务」（有效 Web 会话可跨重启存续，见 F5）。
3. **A：关闭最后一个 tab** → 地址应为 `/app/`。**Back / Forward 必须按可复现的预置序列**（`Close All` 经 `replaceState` **替换**当前记录，故 Back **不会**回到被替换掉的那条）：从 `/app/` 开始 → 打开 note A → 打开 note B（B 活跃）→ 菜单 **Close All**（地址变 `/app/`）⇒ **Back 应回到 note A 的记录、Forward 回到 welcome 记录**，两次都留在同一窗口内。**前置序列记入 E1 的备注栏**（席位实测：`[/app/, A, Welcome] → Back=A → Forward=Welcome`）。
4. **C：裸根旧书签 `/app`** → 仍应被服务并在未登录时跳到登录页；记录 standalone 下是否被引擎视为 scope 外导航（**观察项**，按上表 C 类口径记录）。

**期望**：A 类导航留在已安装窗口内；B 类**只对「登录后的最终返回」**判成败（**落到 `/auth/login` 登录页本身不算 FAIL**，见上文 B 类口径）；C 类只记录现象。**A / B 类若发生「跳出到浏览器 UI 或落到空白」，记 `FAIL` 并附录屏 + 机型 / OS / 引擎版本**；未能真机执行则记 `UNVERIFIED-REAL-DEVICE`（仅作覆盖面说明，**不作定论**）。

**证据与上报**：命名沿用 §1 的 `U32-<检查项>-<平台>-<日期>.<ext>`（例 `U32-F7-ios-20261010.png`）；**真机证据放独立目录 `scratch/web-bases/P471/evidence/real-device/`**（**不与** `I471-NAV/evidence/` 的自动化读数混用）；上报目标见 §E 的上报清单（`#471`）。

## E. 记录与回退

### E1 · 记录表模板

每次验收先填表头，再逐条填行。实例 URL 一栏只写「见 ops 笔记」或内部别名，**不写凭据**。

**验收表头**

| 字段 | 值 |
| --- | --- |
| 验收日期 | |
| 验收人 | |
| 目标 tag | |
| 目标 commit | |
| 部署 / 入口 | 见 ops 笔记（不写 URL 中的 token） |
| 健康检查 | `GET /healthz` 结果 |

**逐条记录表**

| 检查项 | 机型 | OS 版本 | 浏览器 + 版本 | 实例 | 结果 | 证据文件名 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 触摸预取 | | | | 见 ops 笔记 | PASS/FAIL/N/A/BLOCKED/UNVERIFIED-REAL-DEVICE | | |
| A2 Bases 移动 chrome | | | | | | | safe-area 子项**尚未验证时**才记 `UNVERIFIED-REAL-DEVICE`（见 §0.1）；**实测到 FAIL 按 E2 处理**，不得以「未验证」豁免 |
| A3 表格触摸 | | | | | | | |
| A4 双平台覆盖 | | | | | | | iOS / Android 各一行 |
| B1 单条 topbar | | | | | | | |
| B2 标签条 + 开关 | | | | | | | |
| B3 抽屉互斥 + 遮罩 | | | | | | | |
| B4 header 对称 | | | | | | | |
| B5 safe-area 归属 | | | | | | | 实测值入备注；口径见 §0.1（`UNVERIFIED-REAL-DEVICE`） |
| D1 左抽屉在 Base 之上 | | | | | | | `#418`；遮罩点击必须能关闭 |
| D2 半透明主题不透明性 | | | | | | | **左右抽屉分别记**；引擎**低于支持下限**（见 `docs/WEB_OPERATIONS.md` 的 **Supported browser floor**）⇒ 记 **`N/A`** 并在备注写明「引擎版本低于下限」（**政策边界，非缺陷**）；**范围内**引擎若实测半透明 ⇒ `FAIL`（历史兼容欠账口径见 #473；路线 A 已把支持范围写成政策） |
| D3 右抽屉 / Base 菜单 / 关闭后 | | | | | | | `#418` |
| C1 单图原地上传 | | | | | | | 进度为「不确定→100%」（#388） |
| C2 多图 + 失败不写 | | | | | | | |
| C3 同名 `-1` 后缀 | | | | | | | |
| C4 撤销只回退插入 | | | | | | | |
| C5 非法 / 只读被拒 | | | | | | | 越界场景可记 N/A |
| C6 移动端拖放 | | | | | | | 通常 N/A |
| F1 Android 安装 + 主屏启动 | | | | | | | `#471` P1；无安装入口记 `BLOCKED` 并写菜单文案 |
| F2 Android maskable 图标 + 主题色 | | | | | | | `#471` P1 |
| F3 iOS 添加到主屏 + 启动 | | | | | | | `#471` P1；记系统版本 |
| F4 standalone 状态栏 / safe-area | | | | | | | 实测 inset 值入备注（含 0）；读数不可判别记 `UNVERIFIED-REAL-DEVICE` |
| F5 登录过期后返回 | | | | | | | iOS 17.2+ 可能已复制 cookies，按实际记 |
| F6 抽屉 / tabs / 软键盘 | | | | | | | `#471` P1；契约同 B 段 |
| F7a standalone 内切 Vault | | | | | | | `#471`/I471-NAV；**A 类**判据（应留同一窗口、无地址栏） |
| F7b 过期→登录→返回 | | | | | | | **B 类**：默认回 `/app/`；**带合法 `next` 须回原深链接并保留 query**；造过期用隔离测试会话，**不得**用重启 |
| F7c 关闭最后 tab + Back/Forward | | | | | | | **A 类**：**备注栏必写前置** `从 /app/ 起 → 打开 note A → 打开 note B → 菜单 Close All`；**Back 回 note A**、Forward 回 welcome（`Close All` 用 `replaceState` 替换当前记录，故**不**回到 B） |
| F7d 裸根旧书签 `/app` | | | | | | | **C 类观察项**：仍应被服务 / 未登录跳登录页；是否被视为 scope 外导航**只作记录**，不单独据此判 `FAIL` |

**只有实际做过的项才能计入「已验证范围」，且必须四类分开记**（2026-10-10 按 Codex 复审 R3 订正）：

**引擎与支持下限**（2026-10-10 #473 路线 A 补充）：设备的浏览器**低于 `docs/WEB_OPERATIONS.md` 的 Supported browser floor**（Chrome/Edge 119+ · Safari 16.4+ · Firefox 128+）时，该行记 **`N/A`** 并在备注写明「引擎版本低于下限」——**政策边界不等于通过**，既**不计入**「已验证范围」、也**不得**记为 `FAIL`（未支持的引擎不在验收范围内）。范围内的引擎仍按**实测**判 `PASS` / `FAIL`；历史失败记录**照旧保留**。

| 记录类别 | 含义 | 可否计入 `production-verified` |
| --- | --- | --- |
| **已验证·通过** | 真机上实测 `PASS` | ✅ **仅此类**可计入 |
| **已验证·失败 / 已知欠账** | 真机上实测 `FAIL`，或已登记的兼容欠账（例：旧引擎透明度回落 → follow-up [#473](https://github.com/OhiyoX/obsidian-mcp-server/issues/473)）——须带 follow-up 链接与退出条件 | ❌ |
| **未验证** | 本次未做 / 证据不足 ⇒ `UNVERIFIED-REAL-DEVICE`（**仅作覆盖面说明，不作定论**） | ❌ |
| **不适用 / 受阻** | `N/A`（写明原因）/ `BLOCKED`（写明前置） | ❌ |

回写 Obsidian 项目笔记时同样按这四类分开写；**不得**把后三类合并成一句「未验证」。

### E2 · 回退路径

任何**硬失败**（`FAIL`）按下列**四步**处理。**三条口径**（2026-10-10 按 Codex 常任席位复审 R3 订正）：

- **「此前未验证」不豁免「后来测出的 FAIL」**：`UNVERIFIED-REAL-DEVICE` 只是**覆盖面说明**，不是失败豁免 —— 一旦实测到 `FAIL`，就按硬失败处理。
- **兼容欠账归「已验证失败 / 已知欠账」**（例：旧引擎透明度回落 → follow-up [#473](https://github.com/OhiyoX/obsidian-mcp-server/issues/473)），**不要**与「未验证」混写，并标明 follow-up 链接与退出条件。
- **只有本清单显式登记为已知欠账、且附 follow-up 的签名**，才走该登记口径。

1. **留证**：记录可复现步骤（精确到「哪台设备 / 哪个视口宽 / 哪个动作序列」），保存截图 / 录屏 / 控制台日志，登记证据文件名。不要只写结论。
2. **上报**：按检查项指向对应目标 —— `#337`（A 段 Cut 1/2/3）、`#371`（B 段）、`#389`（C 段功能）、`#369`（safe-area 缺口）、`#388`（真进度诉求）、`#471`（F 段：P1 安装元数据 / standalone 行为）。附上第 1 步的证据与「期望 / 实际 / 影响面」。
3. **是否回退**：如果失败影响生产可用性（例如正文数据被破坏、上传越权、抽屉 / 面板无法退出），按 Vault `Deployment/` 的既有回滚流程回退：**参数是「当前已部署 release 的 tag」**（脚本会恢复**该 release 的部署前备份**；**传「上一个 tag」会被拒绝** —— 实读 `scripts/release.py` 与 `scripts/nas_deploy.py` 的结论）。仓库侧命令：**`python scripts/release.py rollback <当前已部署 tag>`** —— 例：当前生产为 `v2026.10.10.1` 时执行 `python scripts/release.py rollback v2026.10.10.1`（详见 `docs/RELEASE_AND_DEPLOY.md` §4；Vault 与 `data/` 不动，回滚后重查容器健康、MCP 与 Web）。回退是独立操作，不因一次 Git push 或 CI 绿自动发生。
4. **回写**：回退完成后更新记录表与 Obsidian 项目笔记（结论 + commit / tag + 证据引用），保持「merged ≠ deployed ≠ production-verified」的分界。
