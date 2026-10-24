# 开发规范与强制测试契约

本规范适用于后续功能、修复、重构、测试、发布和文档变更。参考 TimeTrace 的 `docs/10-audit-refactor-development-plan.md`：先确认产品事实，再审查测试；测试全绿不代表契约正确。用户特别要求 Reader 与编辑模式的样式渲染保持完全一致。

本文件定义验收要求；[QUALITY_AUDIT.md](QUALITY_AUDIT.md) 记录当前证据与缺口。自动化脚本是否已经实现、合并或部署必须分别核验，不能由规范存在推断。

参考证据于 2026-10-02 重新读取 TimeTrace `master@2a9bb0e4c3092429a9b77598f71c1ba360b102b5`：

| 参考文档 | 本项目采用的约束 |
| --- | --- |
| [AGENTS.md](https://github.com/OhiyoX/TimeTrace/blob/2a9bb0e4c3092429a9b77598f71c1ba360b102b5/AGENTS.md) | PR 前测试/构建/静态检查；源码、测试、开发文档与项目记忆同步；不可声称未观察的 CI/运行验证 |
| [审计开发方案](https://github.com/OhiyoX/TimeTrace/blob/2a9bb0e4c3092429a9b77598f71c1ba360b102b5/docs/10-audit-refactor-development-plan.md) | 审查 Git 历史与现行产品决策，撤回已失效的旧审计结论；先失败回归、每文件唯一 owner、热点集成分 wave |
| [开发文档](https://github.com/OhiyoX/TimeTrace/blob/2a9bb0e4c3092429a9b77598f71c1ba360b102b5/docs/02-development.md) | 一个事实源向多个界面提供一致结果；时区显式注入；守恒/不变量优先于截图或数量指标 |
| [仓库测试发布流程](https://github.com/OhiyoX/TimeTrace/blob/2a9bb0e4c3092429a9b77598f71c1ba360b102b5/docs/18-repository-workflow.md) | 单测/构建/集成交互/发布验证分层；源码推送、发布与部署状态分开；只有已验证产物进入发布 |

上述约束按 Obsidian MCP/Web 的风险边界转化，不移植 Android 设备流程，也不把 TimeTrace 历史文档中的问题当作本项目现存 bug。

## 1. 开工与并行协作

1. 阅读 `AGENTS.md`、架构文档、对应 active TODO。
2. 记录本地 HEAD、工作区既有修改、`origin/main` 和相关 open/最近 merged PR 的 head 与 CI。非平凡任务开工必须先核对 remote；发现同范围 PR 后先审计和补契约，避免重复实现。
3. 不能在有本地修改时机械 pull/reset/checkout。其他人的修改、未提交文档和运行数据必须保留。
4. 为切片记录“产品事实 → 唯一事实源 → 失败场景 → 回归证据 → 文档归属”。不能用旧测试或历史笔记覆盖当前事实。
5. 一次修复一个可验证边界。多模块审计可以集中记录，生产修复按独立 PR 分开。合并后必须在最终组合代码树重跑相关门禁。

## 2. 契约与逻辑统一

- 同一个概念只有一个权威定义：Scope 来自 `src/scopes.js`，工具能力来自 canonical catalog，路径规则来自 Vault boundary，写入状态来自 journal/document session。
- Reader、Live、Publish 可以使用不同宿主结构，但共享 Markdown 语义、视觉 tokens 和可见结果。禁止在多个控制器复制权限判断、日期分桶、链接解析或写入状态机。
- 注册、输入/输出 schema、Scope、annotations、真实调用和文档同一切片更新；发现不一致时以授权和行为契约审查，不以“测试以前这么写”解释。
- 状态区别必须保留：不存在与零字节、无权限与不存在、词法 fallback 与真实 semantic result、candidate 与 deployed。
- **front matter 键语义（单一来源 = `src/obsidian.js` 的 `assertFrontmatterKeyIsLiteral`；业主裁定 2026-10-12 / issue #538）**：键在所有读取路径上都是**字面量**（点号是字符，不是路径）。因此：① **key 形参**（`manage_frontmatter` 的 `key`、`patch_note`/plan 的 `target`、`rename_property` 的 `to`）含点号即 **fail closed**，文案给出替代做法（整体替换父映射）；② **整块映射**保持**字面量**、**有意如此** —— `updates` 记录（`manage_frontmatter action=set|replace`、plan `frontmatter action=set|replace`）与整块 `frontmatter`（`write_note`、plan `operation=write`）是调用方自己构造的映射，里面的点键就是显式字面键，也是「确需含点键」的**逃生口**；③ 删除**已存在**的字面点键是唯一清理路径，放行。**该边界由用例钉住**（`app/test/frontmatter-key-guard.test.js` + `app/test/frontmatter-key-guard-map-faces.test.js`）；**收紧 ② 属行为变更**，必须同时更新那两套断言。
- 日期测试显式传入业务时区；边界包含 UTC、Asia/Shanghai、自然日切换和涉及 DST 的业务时区。不能依赖测试宿主默认时区。

## 3. Reader 与编辑模式渲染的强制契约

### 完全一致的含义

相同笔记、主题、字体、缩放、可用宽度和资源版本下，Reader 与 Live Preview 的**可见文档**必须一致：字形及语义样式、内容排列、换行、缩进、块间距、表格布局、代码和引用表面一致。DOM 标签相同不是要求；DOM 不同也不能成为可见差异的豁免理由。

Live idle 是与 Reader 直接比较的编辑渲染状态。Live caret/selection 状态只允许光标、选区、焦点、必要控件和正在编辑范围的源语法显现；这些状态不能改变非编辑内容的字体、颜色、基线、装饰或文档节奏。RAW 模式显式显示源文本，但相同语义 token 的样式归属、模式切换后的原文/undo/selection 必须保持。不得用 RAW 的存在豁免 Live parity。

允许的交互差异必须定位到具体范围并验证其目的。隐藏 Markdown 标记占位、Reader 独有箭头、不同白空格规则导致的可见宽度/换行差异，都属于需要消除或证明无可见影响的债务，不能永久冠以“host model”后宣布完全一致。

### 必须覆盖的矩阵

| 维度 | 必须验证 |
| --- | --- |
| 语法 | h1–h6/Setext、段落及软硬换行、strong/em/strike/highlight、外链/内链/别名/片段、嵌套有序/无序列表、checked/open task 和富文本 task、inline/fenced/indented code、quote/callout、表格、hr、图片/音视频/文件 embed、footnote、comment、frontmatter/Properties |
| 状态 | Reader、Live idle、caret、正反向 selection；切回 Reader；RAW round-trip；readonly |
| 主题 | light/dark、核心 fallback、真实 Vault theme；低 specificity 的 canonical 选择器必须能覆盖 fallback |
| 布局 | 桌面/窄屏、sidebar 开关、长行/长表格、空/长属性、多行嵌套、不同缩放与 DPR |
| 操作 | 点击、编辑、撤销/重做、复制、选区跨块、中文 IME、外部刷新、快速滚动与虚拟化 |

每次样式变更至少覆盖所有受影响语法在 light/dark × idle/caret/selection 的组合，以及一个真实 Vault theme。完整一致性验收必须覆盖整张矩阵；未测的格子保持 open。

环境矩阵的最低自动化目标为 light/dark × desktop(1440×1000)/narrow(390×844) × default/small-14/large-20/alt-family，共16个唯一cell。这是最低环境轴，不替代社区主题、focus/IME或完整语法。字号和字体族使用现有生产token，并记录实际computed font；每cell使用独立context/page，在字体加载和布局稳定后采样。报告逐cell保存probe/state/schema与差异，再汇总；缺失、重复、未知cell和非法配置必须失败。本地缩小范围须标partial，PR/tag/release完整门禁不得静默沿用缩小结果。

### 测量与样式归属

- 核心 fallback 置于静态 CSS，低 specificity，早于 Vault theme。禁止晚注入 `EditorView.theme` 或 HighlightStyle 抢占语义 paint。
- 字体、字号、字重、字形、行高、字间距、前景/背景、装饰色/线、padding/border/radius 的共享 token 精确一致；不能用 1px 容差掩盖字号/行高/token 漂移。
- 实测几何仅允许不超过 1 CSS px 的浮点/栅格误差，必须另测最终 glyph 与可见块外框。字体/图片加载完成后再采样；缺测、null、NaN 不等于 0。
- Reader `td` 对 Live cell 容器；Reader `pre` 对完整 Live code card；quote/heading 对完整可见块。禁止拿外框与内部 `p`/code line 比较后误报或豁免。
- composite 采样必须证明语义块完整起止边界；相邻块不能因同 CSS class 合并，虚拟化只挂载中间行必须报告 incomplete。mandatory composite 缺失不得回退局部行后视为完整通过；用真实 DOM 行为回归验证这些分支。
- computed style 用于语义和几何证据；截图/像素及人工复验用于最终可见结果、clip、caret/selection 和 IME。两类证据不能互相替代。
- 状态断言与采集器必须使用同一字段契约。新增 required class 后，真实 DOM 采集必须能保留该 class；用缺字段/错误过滤器反例验证采集器，不能删除 required 断言让门禁变绿。逐语法操作按实际 source range 和所属行验证，不能用整篇文档首行代替目标行。
- active 几何逐块真实激活后采样，切换后另测 idle 的隐藏与补偿清理；不要求 inactive 块保留 active 源码。稳定采样阈值只确定采样时机，不代替最终 ≤1px 的可见几何约束。补偿布局须同时测正文换行、可见外框、clip/scroll 和相邻块，不能只检查 CSS 属性为正。
- 修复后删除对应 allowlist 条目。禁止新增颜色/字体/间距豁免、扩大通配规则或把失败 probe 改为 deferred 来让 CI 变绿。
- 既有 allowlist 是债务清单。每条须有明确字段、原因、当前差值、修复归属和退出条件。结构差异只有在完整可见外框/字形证据一致时才可关闭。
- `Phase 0 passed` 仅说明已测的非 deferred 差异已分类；不允许表述为“阅读/编辑完全一致”。完全一致的验收必须无未测语法、无未解决的可见差异。

## 4. 写测试的纪律

- bug 修复先提供旧实现失败的确定性行为回归，再修改实现；不适合自动化的情形必须记录复现、失败观察、检查步骤。
- 断言用户可观察的事实、错误和数据不变量，避免只检查源码字符串或照抄被测实现。源码测试适合锁架构边界，不能替代实际行为。
- 每个权限/路径/资源隔离测试同时验证允许和拒绝路径。拒绝时不得执行 handler、泄露 revision/路径/标题，也不能 fallback 到别的 Vault。
- 异步测试控制 barrier/dispatcher/Promise，不能用更长 delay 掩盖竞态。browser 等待条件必须有上限，记录 timeout 的失败证据。
- 浏览器同笔记重载必须等待精确请求响应及状态提交完成；路径名未变化不能证明reload已完成，固定sleep不能代替完成条件。导航/丢弃输入回归使用可控请求barrier，同时验证等待期间本地输入、完成后的编辑器字节与磁盘字节，区分UI未提交与意外写盘。一次重跑绿不能关闭历史时序失败。
- 使用隔离临时 Vault/data、端口和凭证夹具；进程、timer、watcher、临时文件均须 finally/after 清理。只使用虚构凭证，不打印实际配置。
- 不允许 `.only`、待办测试、静默漏跑、重试成功覆盖原失败、忽略非零退出码、无界等待或 `continue-on-error` 绕过必需门禁。
- 验证结果须 fail/cancelled/todo 为 0，实际执行数量大于 0；预期的平台或明确范围 skip 逐项说明，不算覆盖。Windows 的 symlink 权限、Compose CLI 缺失等平台缺口如实报告，不能算全覆盖验收。
- 测试数量下降、probe 丢失或矩阵缩小必须在 PR 明确解释；测试覆盖率不能由文件数或通过数推断。
- 纯 helper 测试不能代替集成接线测试。HTTP 错误分类必须通过真实 router 请求验证 status、Content-Type、稳定响应和无信息泄漏；包括挂载前缀、嵌套 router、JSON parser 与 route 内 catch 旁路。CLI exit helper 必须另外验证真实子进程退出码、check/write 模式及异常输入。
- 比较契约本身必须验证：左右字段集合对称、缺失/null/0 分开、双侧 NaN/Infinity 拒绝、非法顶层形状拒绝、必需采样 schema 不可静默为空。语义样式精确比较；只有明确列举的实测几何字段可使用不超过 1 CSS px 的容差。新增 helper 后必须另验 browser harness 确实调用它，未接线不算门禁已修复。
- 子进程必须配置 timeout，网络请求使用有界取消；timeout、信号退出和非零 exit 都是失败。故障恢复测试须验证故障前后 bytes/revision、journal 保留、解除故障后的恢复及再次恢复幂等。

## 5. 各域必须证明的边界

| 域 | 固定不变量与最低反例 |
| --- | --- |
| Auth/Scope/Vault | API Key/OAuth 共用授权语义；Web/Admin/MCP session 与凭证隔离；缺 auth、空/撤销 Scope、跨 Vault/域/用户、未知 Vault 均 fail closed |
| 路径/文件/归档 | 实路径 containment、final/intermediate symlink、绝对路径/`..`/隐藏保护区、超限/损坏 ZIP、文件增长时读取上限、解压后资源不越界 |
| mutation/journal | plan 无副作用；revision 冲突不写；不存在/零字节分开；前提交恢复原 bytes+revision；提交后恢复幂等结果；外部 writer/cleanup 冲突保留 journal |
| 传输/版本/Trash | 重放、chunk 顺序/大小/expiry、digest mismatch、目标已存在、removeBackup 前后 crash、非 Markdown byte-preserving restore |
| Web document session | A/B 乱序、GET/POST 飞行中输入、失败导航保留原文、save chain、external refresh 与 undo 分离、SSE 自回声按 revision 判断 |
| 检索/索引 | malformed YAML 不拖垮其他笔记；删除/移动失效；词法/semantic 降级真实报告；截断与未覆盖区域显式报告；link ambiguity 不猜测 |
| Discovery | 可见性不是授权；native wire order 与 canonical membership 分开；隐藏/缺 Scope 调用不触达 handler；历史 inventory 不冒充当前清单 |
| 发布/部署 | lockfile 安装、生成资产同步、immutable tag 与所选通道的验证证据、NAS drift/备份/health/smoke/recovery；merge 与生产状态分开 |

Web 与 MCP 对相同附件能力使用相同 Scope 契约；`obsidian.read` 的笔记读取与 `obsidian.files` 的文件能力须分别做真实 HTTP allow/deny 验证。错误路径同时保持安全响应与既有业务状态：预期 partial 不改为未捕获异常，未知 IO 不吞成 empty/missing，ready snapshot 不偷偷增加全量扫描。安全加固不能以删除这些断言获得绿灯。

恢复保证须声明适用的 writer/进程边界。进程内锁、乐观 revision 校验、journal 幂等与静态 canonical guard 分别验证，不由其中一项推导跨进程原子 CAS/事务或消除全部 TOCTOU。新增 SSE 队列同时验证 overflow/resync、drain 再入、close/backpressure 清理；自回声去重容量与服务端 replay horizon 必须说明其关系和超出窗口的行为。

重放日志同时证明身份正确性与资源生命周期：长期断线、已确认 echo、确定未写的拒绝、不确定写入结果、hello/resync 水位前后提交、note/Vault 切换及重复 replay。固定容量不得悄悄遗忘仍可重放的自身 mutation；无限保留未确认条目也不能作为验收方案。清理依据必须来自可验证的协议/会话边界，并保持 foreign writer 与 dirty 输入保护。

## 6. 必须执行的门禁

按本次变更与风险选择验证范围。开发阶段先定向检查，最终组合树统一运行必要集成检查；PR、审查、发布和 apply 引用同一份原始证据，不换阶段就重跑。

- 纯说明文字：内容、链接和实际授权核对；可执行配置、工作流与发布资产不因在 docs 目录就豁免。
- 代码/测试：相关语法、架构、单元/真实边界回归；涉及共享接口、鉴权、迁移、并发时加相应集成/负例。
- frontend：构建生成资产并核一致性，跑受影响真实浏览器与 parity 矩阵；不对无关修改机械跑完整视觉矩阵。
- 发布：记录最终 commit/tree、依赖、环境、命令、计数和原始产物。已授权本机或指定环境验证通过可直接发布部署，仓库 CI 继续后台运行。
- 外部/非本地改动或缺少可信环境证据：沿用常规 CI required checks。保留完整 CI 回归，不能伪造 CI 绿灯。

可用命令按范围选：app 下 npm ci（依赖/运行时变化时）、npm run check、node --test <相关文件>、node scripts/run-node-tests-ci.mjs（需要全量时）、npm run build:web、node scripts/run-browser-tests-ci.mjs、相关 parity、npm audit --audit-level=low；根目录 Python 测试与 inventory 检查用于相关脚本/工具变更。

缺测、空跑、全 skip、超时不是通过；合法平台 skip 写原因与未证实项。未知失败先定位，不自动当环境抖动整套重跑；浏览器 CI 默认一次，显式诊断最多一次补跑并保留首轮产物。runner/网络/证书故障与产品失败区分，真实安全或产品失败不能忽略。

工具配置与运行事实见 RELEASE_AND_DEPLOY.md；源码里的 gate 列表不构成每刀都重复执行的固定流水线。当前行数预算是 800，按第 7 节登记例外；不按过时 500 行副本机械拆分。

## 7. 行数预算与例外登记

行数门禁由 `scripts/check-architecture.mjs`（扫描与接线）和 `scripts/line-budget.mjs`（纯逻辑）实现，随 `npm run check` 一起执行。

- **预算 800 行（非硬限制）**，行数按 `wc -l` 口径计算（结尾换行不算额外一行），覆盖 `frontend/`、`src/`、`scripts/`、`test/`（递归，`.js`/`.mjs`）以及根级 `*.js`/`*.mjs`（即 `server.js`）。`src/app/assets/` 是 `build:web` 生成物，排除在外，不得手工编辑。**业主口径 2026-10-11：500 → 800，并取消硬限制。**
- **新代码优先拆**：未登记文件超过 800 行会 fail，提示 extract a cohesive module，**或登记 reason+plan 例外**。默认按职责抽出内聚模块，而不是把整块逻辑塞进一个文件。
- **判断口径**：能拆就拆；只有确属用例密集的测试矩阵、生成/基准脚本或一次性 harness 才允许登记例外。登记是**已确认的债务**，不是继续扩张的许可。
- **例外登记（给理由才放行）**：`app/scripts/line-budget-baseline.json` 的结构为 `{ "entries": { "<repo 相对路径>": { "maxLines": <int>, "reason": "<为什么允许长>", "plan": "<拆分计划或保持理由>" } } }`。`maxLines` 必须是大于 800 的整数，`reason` 与 `plan` 都必须是非空字符串；缺失或形状非法即 fail。文件回落到 800 行以内后**必须**从 baseline 删除该条。
- **取消「只缩不涨」**：登记值不再是单向下调的棘轮。已登记文件若超过其 `maxLines` 会 fail 并提示更新 `maxLines`；**在同一改动里抬高 `maxLines` 并重述 `reason`/`plan` 即可作为例外放行** —— 即「超限须给出理由」，而不是绝对禁止。
- 拆分完成或脚本归档后同步删除对应 baseline 条目，并更新本节的判断依据。

## 8. PR、文档和状态验收

PR 按本次范围给出：基线/head SHA、行为前后、唯一事实源、相关回归与验证命令/计数、实际运行的 browser/parity 矩阵、受影响的生成资产、剩余风险、恢复方式、对应文档/active TODO。未运行的全量套件标未测，不为填写模板机械执行。

并行实现开始前由协调者登记文件 owner 与现有 PR，不仅登记主题。只要现场可能存在多人/Agent 并行操作仓库——即使只是疑似——owner 一律在基于当前 `origin/main` 的独立 `git worktree` 中开发，不在主检出里切换分支；切片合入后从新 `main` 重建 worktree，不复用过期 worktree。已由其他 owner 处理的 bug 先交接；新的更强回归贡献给同一条修复路径，避免两个 PR 同改热点文件。每次分支更新后将 PR 正文改成最终实现和当前验证；最初的 regression-only 描述只能保留为标注 SHA 的历史红证据，不能与已存在的生产修改相冲突。

状态词沿用 [AGENT_EXECUTION_GUIDE.md](AGENT_EXECUTION_GUIDE.md)：candidate、merged、released、deployed、production-verified。不得从“已合并”推导“已部署”，不得把旧 CI 改写成新 head 的 CI；仍有效的环境证据按内容复用，不得从“已有 tests”推导“完整一致性”。

合并/发布/部署按用户授权范围与绑定规则执行，执行前核绑定；同一授权已包含的动作不重复确认。CI 绿灯不自行构成授权，main 已推送不代表已部署。

任何变更影响持久架构、操作规程、测试门禁或用户偏好时，同步代码契约文档、开发规范及现有 Obsidian 项目索引。没有通过全部验收的 TODO 保持 active。测试债务修复后收缩基线，历史失败证据保留。

## 9. 变更分级：门禁按「变更面」施加（2026-10-10 用户定案）

证据绑定内容、依赖、生成资产和环境。SHA/base 漂移先核 diff：未变部分可引用旧原件，变化部分重验及必要集成；不得把旧 CI 改写成新 head 的 CI。冲突消解/风险变化补相关独立审查，不一律重审完整历史。

授权写项目、候选/绑定规则、动作与目标；一次授权可覆盖合并、tag/release、部署，范围内连续完成。用户只授权合并时不扩展部署；已授权环境验证通道不再单独问一次。默认 CI 通道保留；用户授权且本机/指定环境相关检查通过，使用 local-fast 与原始证据直接发布部署，不等 PR/main/tag CI。

审查者独立读取 diff、关键源码及原始测试产物，运行针对风险的反例；不机械复跑已核可信的全部门禁。实现者不得自审，audit: 写读了什么、跑了什么、反例与未证实项。运维排障、问答、改笔记、管理凭据不套项目验收。

禁止为触发 CI 做空提交；不永久关闭分支保护或删工作流。条件跳过与 required check 缺失按 GitHub 实际语义核验。部署仍保持串行、不可变 tag、产物一致、preview/drift、备份回滚和线上 smoke。

## 10. 本地运行隔离 `DATA_PATH`（2026-10-10 用户要求）

`app/src/config.js` 的默认 `DATA_PATH = path.resolve(process.env.DATA_PATH || "/data")` 在 **Windows** 上把「根路径」解析为**当前盘符根**（`D:\data`），于是本地跑服务或测试会把数据写到**项目外**（`D:\data` 里已积累 `oauth/`、`history/`、`web-catalog/`、`mutation-journal/`、`route-metrics.json`）。WSL / CI 不受影响（Linux 下即 WSL 内的 `/data`，实测为空）。

**每份切片 `BRIEF.md` 必须写明以下四条，验收时逐条核对：**

1. 起服务或跑测试前**显式指定 `DATA_PATH`**（必要时一并指定 `TRASH_PATH` / `HISTORY_PATH` / `RETRIEVAL_INDEX_PATH`），指向**本项目内、已被 gitignore 的临时目录**（如 `<worktree>/app/.data-local`）。
2. **不得**依赖默认 `/data`；**不得**把本地运行数据写进项目外 / 盘根 / 他人现场。
3. 任务结束**清掉**该临时目录（或确认它已被 `.gitignore` 覆盖且不进提交）。
4. `HANDOFF` **报告实际使用的 `DATA_PATH` 值**。

同源纪律：一次性临时文件只落本项目内按任务分的临时目录、任务结束即清；worktree 一律落项目 `worktrees/`。
