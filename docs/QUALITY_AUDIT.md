# 2026-10-02 质量审计、测试约束与 PR 分工

本次目标是审查 bug、设计与逻辑不一致，并将约束进入长期[开发规范](DEVELOPMENT_STANDARDS.md)。不是“证明所有潜在 bug 都不存在”。2026-10-02 用户要求停止本地代码修复，因为 remote 正在修；该指令之后只核对远端、整理规范和记忆，不继续改代码。

随后用户明确指定并授权与 remote chat [表格滑动修复状态](https://chatgpt.com/g/g-p-6ab7bbcf2dcc8191a1df74c053e53720-obsidianxiang-mu/c/6abf45d1-99e8-83e9-af3f-5598ca49731c) 配合。已读取近期记录并发送协作消息：remote 继续生产修复，本地负责规范/契约/审计，交接本地候选重复范围及未修的失败表征。消息已发送；收到回复前不宣称对方已确认分工或接手问题。

## 证据基线

- 本地初始 HEAD：`d387cc9a71d057255bd0a76b38672a5b02c16bac`（#112）。开工已有 `README.md` 与 `docs/WEB_OPERATIONS.md` 修改，保留。
- 随后核对 `origin/main`：`b029e1f0be2a778486306fc7fdf386b0618e92eb`，已含 #115–#119 等变更。本地早期样式结论不能直接用于这个更新基线。
- TimeTrace 参考：`TimeTrace/docs/10-audit-refactor-development-plan.md`：契约先于既有测试、修复前失败回归、时区/数据不变量、分层门禁、诚实报告未验证项。
- 本机 Node `v26.3.0` / Windows；remote CI 为 Node 22 / Linux。两者证据不混写；生产状态本次未重新核验。

## Remote 已在处理的范围

| PR | 核验时状态 | 已处理或正在处理的契约 |
| --- | --- | --- |
| [#115](https://github.com/OhiyoX/obsidian-mcp-server/pull/115) | merged | quote/code 的共享 paint 与静态 CSS ownership，移除陈旧 allowance |
| [#116](https://github.com/OhiyoX/obsidian-mcp-server/pull/116) | merged | heading 与 fold geometry 共享 line-height |
| [#117](https://github.com/OhiyoX/obsidian-mcp-server/pull/117) | merged | compact maxDiffChars schema |
| [#118](https://github.com/OhiyoX/obsidian-mcp-server/pull/118) | merged | highlight content paint、underline alpha、active wiki semantic class |
| [#119](https://github.com/OhiyoX/obsidian-mcp-server/pull/119) | merged | 低 specificity Vault theme 覆盖 fallback |
| [#120](https://github.com/OhiyoX/obsidian-mcp-server/pull/120) | open/candidate | CRLF/LF 生成 Markdown 验证与篡改反例；head `b853c6acd3d49519b4469ffb85956ad9711cee84`，CI `37001284728` success |
| [#121](https://github.com/OhiyoX/obsidian-mcp-server/pull/121) | open/candidate | idle HR rhythm、table-cell 正确取样；head `b4e980bd6031515b0af189ccdd0a0e7165802812` 的 CI `37001659901` app success、Chromium failure |

#121 的失败是 `LP-06 selection stays visible across every styled Live surface`，artifact 显示 active HR `hrHeight=22.609375`、`dividerBorder=0px`；不能把 idle 修复或 app success 写成全部验收。PR 状态是本次核验快照，后续以最新 head 重新核验。

## 按域审计矩阵

### 2026-10-02 协调复核快照（Asia/Shanghai）

本次读取的 GitHub main 为 `0d912a415cd1436c6daa17063bed2781663d88d5`。以下状态是精确 head 的快照，不代表部署或完整审计结束；本地继续只做审查、隔离复现实验和文档，不修改生产代码。

| PR | 核验结果与待办 |
| --- | --- |
| #120/#121 | 已 merged；此前“open/Chromium failed”属于历史 head，不再代表最新状态 |
| #122 `aae43def` | 显式未知 Vault fail closed，app/Chromium 均 success；仍 open |
| #123 `b6589035` | task checkbox 低 specificity 与 probe，app/Chromium success，已 merged；task host/deferred 与完整矩阵仍未闭环 |
| #124 `fd69c5b` | 因与 #126 重复已 closed；历史回归证据保留，避免重复生产修复 |
| #126 `39eb1020` | 健康笔记与损坏笔记正文均可搜索；app/Chromium success，仍 open，stacked on #122；PR 正文仍残留 regression-only 叙述，须更新为最终实现 |
| #125 `92709d95`→`917f35e6` | 旧 head helper/test 在隔离 scratch 独立运行 8 tests、7 pass/1 fail：`comparableNumber("10px")` 返回 null；新 head 修正双转义正则及精确样式比较、非法形状/非有限数检查，app/Chromium success；尚未接入 browser harness，不能宣布完整门禁已修复 |
| #127 `df79ae9b` | 同 OAuth client_id 的不同用户复用 MCP session 的 regression-only 候选，app failure；须观察并修复认证 principal 绑定，再验证同 principal token refresh 与跨凭证边界 |
| #128 `8ec75dca` | cost-gate exit helper 候选，当前验证进行中；需明确 report/write/check 语义并补真实 CLI 子进程退出证据，helper 单测不等于已证明接线 |
| #129 `07ddb271` | Web API classifier 单测 app success；独立同结构 Express HTTP 实验显示挂载后 req.path 被剥离为 `/audit-failure`，API 分支不执行，返回 400 HTML，期待 500 JSON 的断言失败。真实 router HTTP 回归及接线修复仍必需 |
| #130 `4f840e2b` | History 预置中间 symlink canonical guard，app success；须补旧实现失败、子进程有界 timeout 和恢复后重复幂等证据。pre/post guard 不证明恶意外部 writer 换链竞态已原子解决 |

复现实验文件：`<isolated-audit-workspace>/`；只保存指定 PR 的只读源码快照和审查 probe，不回写脏 repo。Express 实验验证的是相同挂载结构的框架行为，尚未运行 #129 完整 router，不冒充全应用验收。

四个普通 Chat 的反馈使用 send to chat；读取接口与部分发送偶发 `Too many requests`，失败发送不视为已送达，也不改用浏览器发送后续消息。先从公开 PR/head/CI 独立核验，再补发未送达的审查反馈。

后续复核补充（截至 20:17）：main 已推进到 `32b1954596e68725bd6349b7f7cfed95f0ac8881`。

- #125 `f8f760f7` 进一步将几何容差上限锁到 1 CSS px，app/Chromium success；此前 `917f35e6` 的 8/8 focused tests 已由协调者独立运行。空 schema 只表示结构检查，不是采样完整性；harness owner 仍须强制非空 schema 并接入 helper。
- #130 `adbedecb` 已基于当前 main 更新：timeout 15s、signal/timeout 拒绝、二次 recovery 幂等；app/Chromium success。旧实现红证据保留在已关闭未合并 #133（611 tests / 609 pass / 2 fail / 0 skip），不能把红实验 PR 当作待合入修复。
- #129 `62045140` 已修挂载后的 API 判定并补真实 HTTP 负例。协调者以该 exact-head git archive 在隔离目录运行两套相关测试，JSON parser 回归通过；注入 session failure 暴露 `currentSession`→`requireApi` Promise rejection 未被 Express 4 捕获，Publish 边界另有 400≠404 失败。普通测试失败后未退出并已中断；诊断使用 force-exit 时还出现 Node 26/Windows libuv assertion，不能将这一运行时问题归为产品 bug。使用现有本地依赖、Node 26 的结果是候选诊断，最终须由 Node 22 clean CI 验证；没有宣称本地全 suite 通过。
- #131 `bed3c07e` app success，真实 Chromium failure：73 passed / 0 failed，但 `serverErrors` 含预期 invalid-search 400 的 `Search operator requires a value at position 6`。保留 adapter 阻断，API 正常 4xx 处理须配套；不能扩大忽略规则伪绿。
- #132 提供 missing-note HTTP 回归，与 #129 同属 API error 边界，须确认 owner 并合成一条实现路径；#135 提供 symlink-swap/读取时增长的失败回归，生产改动与 #130 的 vault.js 需按函数交接并组合验收。
- #136（index 失败刷新缓存）、#137（SSE replay/live 顺序）、#138（crash/recovery 子进程 timeout）出现新候选；本轮尚未审查其完整 diff/最新 CI，保持未验证。

### 第二波复核与严格门禁暴露的问题

永久规范与本审计已形成独立文档 Draft PR [#140](https://github.com/OhiyoX/obsidian-mcp-server/pull/140)，初始 head `437e50a92876c624da97af8b0924f5de5ec05e66` 的 app/Chromium CI 均 success，diff/本地 Markdown links 检查通过。它只修改五个 Markdown，不将本地脏代码候选混入修复，也不宣称规范中的所有门禁已实现。

| 候选 | 新核验结果 | 剩余验收 |
| --- | --- | --- |
| #127 `8634debe` | principal 绑定及同 principal token refresh，app/Chromium success | GET/DELETE、跨 API Key/OAuth、Scope/Vault handler 隔离矩阵仍要列明 |
| #129 `173825d3` | 独立 API error middleware、async session middleware 捕获拒绝、Publish 安全404及安全4xx分类，app/Chromium success；#132已closed superseded | 与严格 adapter 组合树重验；不能用旧 a2b17bf（500≠400）失败当作最新 head 状态 |
| #131 `040d9a2d` | 正常 search 400 不再使 Chromium误红；Chromium success，但 app failure 为旧 API mapping 的500≠400 | 基于最新 #129 组合/rebase后重验，不撤销 serverErrors 阻断 |
| #135 `fa4f627a` | symlink swap/增长读取生产候选；Chromium success，app architecture check failure | 修复结构约束后重验；与 #130 同文件窄修组合验证，不声称所有父目录换链竞态已解决 |
| #136 `54097bea` | index 刷新使用 staging Map，失败不污染 last-success cache；app/Chromium success，diff已审查 | 并发刷新、includeHidden/pathPrefix及缓存失效边界仍要明确 |
| #137 `a3f68db7` | replay snapshot→queue→live，reentrant hello 事件无重复且有序；app/Chromium success，diff已审查 | 新增 overflow-resync/回压/断开释放分支的确定性回归；正文不得残留test-only说法 |
| #138 `a8b1f124` | 21个crash/restart子进程设置15s timeout并拒绝signal；609/609、0skip与Chromium success，diff已审查 | 这是测试约束加固，不是新增生产恢复保证 |
| #139 `50426202` | 真实CLI report/write/verify保持hold/full，app/Chromium success，diff已审查 | unknown/candidate仅helper负例，当前CLI不可达；缺失/篡改artifact的真实非零exit负例仍可补强 |
| #141 `46f3ad72` | 保留save在途新remote revision/tombstone；Chromium success，但app生成资产diff门禁失败 | 固定构建重生成asset并重验，不手工伪造minified bundle |
| #142 `6850723f` | #125严格helper接入真实parity harness；schema、states、semantic classes均fail closed；app success、Chromium因parity失败 | 完整可见渲染仍未通过，见下述真实差异；其余113allowance/11deferred不能算完整一致 |

#142 CI `37006627995` 的历史 parity（每个 light/dark 主题）：20 probes、126 differences、113 allowed、2 unexpected、11 deferred；代码块边框 Reader `1px`、Live `0px`。后续核实为采样范围错误：Reader 完整 pre 对比 Live 中间代码行，不能据此证明真实可见边框不同。`9a2f7e74935d9a4c301587024e55516c7cee123a` 改为完整 Live code card composite，未修改 CSS 或放宽容差，CI `37007151142` app/Chromium success。真实结果为每主题 20 probes、115 differences、104 allowed、0 unexpected、11 deferred；仍不等于完整一致。composite 必须补真实 DOM 回归：完整起止边界、相邻 fenced block 不合并、虚拟化仅中间行不能冒充完整采样、mandatory composite=null 不回退伪通过。

### 2026-10-02 20:40（Asia/Shanghai）覆盖与设计边界复核

文档 #140 `0d98972af042afa175cfd04e34555f7d70215c17` 的 CI `37007281723` app/Chromium 均 success；这是本次更新前的已验证文档版本。更新后必须核验新 head，不继承旧绿灯。

- #127 `552e1a7829eb2e2bc5f63f8c1e8ae0227f1dc5db` 的 CI `37006905502` 双绿。新增同 client 不同 OAuth user 的 POST/GET/DELETE 拒绝、Managed API Key 复用 OAuth session 拒绝；同 principal refresh 允许，无 principal record 对认证请求 fail closed。覆盖增强不代表所有 handler 的 Scope/Vault 矩阵已穷尽。
- #131 `a9a43dce8f0824f50e43366520118af17066f19d` 的 CI `37007427809` 双绿；历史 040d9a2d 红灯已被后续修订取代。零检查、畸形结果、skip/过滤、CLI artifact 负例等完整门禁覆盖仍须逐项列证。
- #141 `bdda22c09d094eff5c6b8274c3fb05f795f27296` 的 CI `37007063825` 双绿，固定构建资产已同步；历史 46f3ad72 的生成资产失败不代表当前 head 失败。
- #135 `5c7a7f15b9670bfd4a74642159e8282b5ef81c46` 已 stack #130。CI `37007028958` Chromium success、app failure，失败已进入行为测试：Context target-mutates 抛 secure-open 错误而未返回 partial；unexpected IO 未 reject；ready snapshot 额外 stat（2≠1）。这些失败须保留并修正契约，不能仍只描述旧 506-line architecture blocker，也不能由单独 #130 绿灯推导组合通过。
- 安全 Chat 指出 Web `/api/web/v1/asset` 只有 requireApi，read-only OAuth Web user 与 MCP 附件要求 `obsidian.files` 的语义不统一。目前属于源码确认的设计缺口，尚未有该负例的运行证据；已派给安全 owner 明确 Scope 契约并补临时 Vault 的真实 HTTP allow/deny 回归。

| 恢复/并发域 | 已有证据 | 保留设计债务与验收边界 |
| --- | --- | --- |
| mutation plan/journal | 无副作用 preview、revision-bound apply、部分失败和多 crash 点、重启恢复、子进程有界 | JS 锁仅进程内；跨进程 commit/recover 互斥和 revision 原子 CAS 未证明 |
| Trash/History | source/destination drift、quarantine、cleanup conflict；#130 静态 canonical guard、修复后再次 recovery 幂等 | 外部 writer 换链/检查后写入竞态仍未证明；非 Markdown restore 边界独立验收 |
| idempotency | restart、同 key winner、不同 plan 拒绝、client/user binding | DATA root canonical 契约需独立核验；commit 与记录不是跨进程事务，不把潜在缺口写成已复现 bug |
| document session | #141 新 remote revision/tombstone、continued edit/save chain/A-B/旧身份回包/self echo | remote marker 清除点继续验证；32 条 self-echo journal 与 SSE replay horizon 的关系属于设计债务 |
| SSE | #137 replay snapshot→queue→live，reentrant hello 无重复有序 | overflow-resync、queue-drain 再入、close/backpressure cleanup 新分支尚需确定性回归 |
| index | #136 staging Map，失败保留 last-success cache | 并发 refresh、includeHidden/pathPrefix 和失效边界未闭环；不宣称文件系统快照事务 |

本轮能证明单进程 crash recovery、乐观 revision 冲突检测和部分静态 canonical guard；不等于跨进程文件系统事务、原子 CAS 或所有 TOCTOU 竞态已消除。完整审计与 Reader/Live 完全一致性继续保持 active。

### 渲染完整覆盖的执行矩阵

独立渲染 Chat 的源码审计指出原 Phase 0 固定 1440×1000、默认字体、light/dark；selection dispatch 不等于实际 focus。#142 已完成严格 helper 接入，但以下轴不能由该次绿灯推导通过。社区主题、窄屏与真实 mouse selection 的专项 Chromium 证据仍不等于全语法 parity。

| 切片 | 必须补齐的覆盖 | 退出条件/当前状态 |
| --- | --- | --- |
| R1 采样完整性 | mandatory schema、合法非空 states、双向字段、非有限值、完整 composite | #142 已接线；composite 起止/相邻块/虚拟化缺测的真实行为反例待补 |
| R2 布局/字体/主题 | 桌面1440与窄屏390、resize/sidebar、small/default/large正文、正文与monospace字体族、社区主题 | 显式 matrix cell 与缺 cell 失败；目前只有默认轴的完整运行证据 |
| R3 状态/操作 | focus/blur、正反selection、逐语法Reader→Live→RAW→Live、滚动前后、IME与undo | dispatch selection 不冒充focus；table专项scroll不替代其他语法；仍open |
| R4 基本语法扩展 | Setext、bold+italic、转义、URL/email autolink、ordered/nested list、checked rich task、无语言fence、nested quote、hard break | 新增probe/schema与真实字形/外框；不能只检查canonical marker字符串；仍open |
| R5 复合语法毕业 | table、Properties、callout、footnote、indented code、image/note/file embed、math、HTML/tag/comment | 每类deferred有owner/退出条件；支持范围先与产品契约核对，unsupported明确记录；仍open |

基础heading/paragraph/inline tokens已有门禁，但也须扩展上述轴。HR/open task的idle覆盖不等于caret/selection覆盖。旧allowlist policy仍称HR excluded而实现已idle gated，文案应由harness owner同步；未知/未实现语法不能盲目新增支持，也不能把既有支持漏测改称unsupported。

### 后续候选与文档自身运行证据

- 文档 #140 `c1705d5d85273ae451ca912bdc958a28cbdeafee` 的 CI `37008386817` app success、Chromium **72 pass / 1 fail / 73**。LP-02 的 pending B 场景保留 A 输入断言通过，confirmed A reload 最后仍含新输入 marker；artifact `11227021673` 已保留并成功反馈原 remote/harness owner 与 recovery Chat。当前不能标文档 PR 全绿，也不以重跑成功抹去本次失败；旧基线不包含 #129/#131 等独立候选。
- #143 `dc0f7a4346064d64ea4378eab5a8c86aa43577db` 仅新增 CI contents:read 和 app job 30min timeout，CI `37007855273` 双绿；diff已审查。不是 root inventory/audit/零skip/tag-release 完整门禁已落地的证明。
- #144 `34924ee1` 的真实 in-memory MCP healthy search 首断言失败，CI `37008197295` app red。`54956e6fc68ca0f91c20834f0d3b7c23ee5f08a6` 将 readNote 的 parser-only fallback 显式 opt-in 给 index，普通读取仍 strict；IO/stat/revision 不在 catch 内。CI `37008612405` 双绿，healthy/broken body/backlink 与 #136 snapshot 回归通过，diff已审查。更广泛 metadata 消费者与解析状态披露仍可继续审计。
- #145 初始 `a28230cc` 的 red 是 note allow 夹具 Vault ID 不一致（403≠200），**不是 asset 缺Scope反例已运行确认**。后续 `aa0575acbea5d1690cba1bf05c1c01ae2b300766` 对齐 defaultWebVaultId、补 server/timer cleanup，并在 resolveAttachment 前加 files Scope guard；本轮已审diff，最新CI当时pending。应保留正确旧实现asset红证据与最终 allow/deny绿证据，不把fixture失败当产品bug。

send to chat 若返回429/already responding/cloudflare_challenge，反馈保持未送达；不得用浏览器补发或绕开用户的Chat-only约束。本轮门禁完整覆盖矩阵的最后补发遇challenge，owner已有此前派工但不能宣称最新反馈送达。

### 续轮：已验证补测与继续派工

- 文档 #140 `141018153526bd5851b514c5212214ffc130282c` CI `37009201530` app/Chromium success。保留 c170 的 LP-02 红证据：只读定位发现 final A reload 仅 sleep300，没有精确 GET/commit 完成条件；#141走save状态，不能据单次绿灯归因其已修reload。controlled GET barrier、等待完成与磁盘无污染的验收已成功交原remote。
- #137 `d7be13728150a7742dd288dac665b833d9db0390` CI `37009213573` 双绿；相对 a3f68db7仅 live-events.test.js +298/-0，协调者已核验文件清单。新增 replay overflow/resync、drain 再入、client close 和backpressure资源释放/恢复3连接槽的确定性回归；此前该四项coverage open现在有运行证据。跨进程恢复与其他设计债务不据此关闭。
- #145 正确旧实现红证据已独立读取：`9000857f` CI `37008734243` job `110843078152`，note allow先通过200，asset deny在test:105 actual200/expected403失败。修订aa0575ac双绿已核验；这才构成fixture纠正→正确行为red→窄guard green证据链。
- #142 独立只读复核确认nonempty schema、required states与双向semantic classes已接入且契约运行通过；相邻无空行fence、虚拟化中间段、composite=null回退仍只有源码风险和coverage缺口。report字段semanticClassLosses实际计additions+losses，属于命名债务。R2目标为16环境cells，各cell独立context/字体加载/完整report，纯module测试不替代真实browser矩阵。

已成功续派：原remote负责composite/LP-02及之后R2接线；gate Chat提交并补齐root inventory/audit/零skip/过滤/CLI与CI-release接线矩阵；security Chat继续theme/Publish资源契约与动态撤销；recovery Chat继续idempotency DATA root和commit-record保证边界。随后尝试将R2纯matrix模块单独派给render Chat和通知原remote均遇cloudflare_challenge，**该新文件owner方案尚未送达，不视为正式交接**。所有会话仍普通Chat，协调者仅更新文档与审计，不恢复本地生产代码修改。

### PR 收束与组合验证

用户指出未合并PR积压，协调方向改为先收束已有候选与依赖、暂停新增独立PR。此变更通知原remote与gate Chat遇challenge，尚未送达；先前成功派工仍可能继续执行，不能宣称所有Chat已暂停。创建新的纯matrix模块owner方案同样未正式交接。

盘点时共有18个open PR、其中17个Draft；#146是另一条host matrix工作，此组合未纳入。主要审计依赖如下，顺序不等于合并授权或最终验收：

| 顺序/组 | 已有候选 | 收束要求 |
| --- | --- | --- |
| Web Vault | #122 → #126 | 父PR先进入main后，子PR改base/rebase；共用registry/test，组合回归 |
| API/权限/浏览器门禁 | #127；#129 → #145/#131 | #129先收束；两个子PR最终均进入同一组合树，正常4xx不污染serverErrors、未知5xx阻断 |
| MCP索引 | #136 → #144 | 保留失败刷新原缓存与parser-only降级，子PR不重复父diff |
| History/读取 | #130 → #135 | #135仍app红，保留partial/未知IO/ready snapshot三条契约，暂不列通过 |
| 恢复/会话 | #137、#138、#141 | 新SSE分支回归、crash timeout、save远端状态与生成资产组合验；LP-02历史race继续open |
| CI/成本门禁 | #143；#128 → #139 | workflow权限/timeout不代替完整quality gate；CLI helper/report/write/verify事实分开 |
| 开发规范 | #140 | 文档精确记录最终组合状态，五个Markdown独立审查 |

协调者在隔离 `scratch/audit-pr-consolidation` 基于 main `2d11ae9a118d51822d343dca26b8760313b8e9ae` 本地合成16个候选：122/126/127/129/145/131/136/144/130/137/138/141/143/128/139/140。所有merge无冲突，组合SHA `31ec0f61a9a885711bbbbbf121871dd393c279d4`；这不是远端main合并，也没有推送整合分支。#140当时head为80018d5，其自身CI已双绿。原dirty工作区保留，协调者没有补生产修复。

组合树运行证据：Windows + Node22.23.3、clean npm ci；syntax222/architecture126通过；Node653 tests、648 pass、0 fail/cancelled/todo、5skip（4项symlink权限+Compose缺CLI）；root inventory10/10、Python10/10；build与Git-normalized生成资产diff通过。Playwright1.63.0/Chromium1243真实browser73/73，errors/serverErrors无阻断；parity每light/dark主题20probes、114diff、103allowed、0unexpected、11deferred。Windows结果不替代Linux零skip或16cell/完整语法验收，LP-02一次绿不关闭旧race。

组合 `npm audit` 明确失败：dompurify low、fast-uri high、hono/ip-address moderate，共4包且均有fixAvailable。该问题未修，不能以个别PR的app/browser绿灯声称全部strict gates通过。依赖报告和browser/parity artifact保存在隔离目录；需要最小依赖修复与Linux组合验收后再评估最终合入状态。当前不自动关闭非重复PR、不merge/release/deploy，现有父子链按顺序收束，避免再堆叠相同修复。

随后盘点发现已有续派任务又产生 #147–#150，open增至22；上述16候选组合结果不包含这四个后继，不能外推。暂停新增通知因challenge/429仍未送达，不能宣称积压已经减少。

| 后继 | 本轮核验 | 收束归属 |
| --- | --- | --- |
| #147 `06b72004` | harness-only LP-02改为两个精确GET barrier、release前后editor/disk字节不变量；diff已读，CI37014219719双绿 | 原remote；补入下一组合树，保留c170历史红 |
| #148 `cff74f21` | idempotency静态DATA child root canonical containment，CI37014627308双绿；仅已读范围/证据与文件清单，未完整diff复核 | recovery；独立root保证不声称跨进程事务/并发换链解决 |
| #149 `04cb0c02` | stack#127的OAuth用户grant撤销隔离回归，app red；本轮未独立读完整失败日志 | security；当前regression-only，不列入已通过组合候选 |
| #150 `ffcc2f20` | stack#143的Node/Python完整结果门禁，diff已读，app success、browser当时pending；root inventory/audit/release接线仍需核验 | gate；协调者独立parser试验发现未知/畸形OK qualifier被接受，补现有PR即可，不新开候选 |

#150 Python exact-head `evaluate_result(0,"",summary)` 的独立诊断：`Ran 2 tests ... OK`→无问题；`OK (unknown)`与`OK (skipped=not-a-number)`也→无问题，与“unqualified clean OK / 畸形结果失败”的承诺不一致。这是synthetic summary的解析契约证据，不是实际unittest有skip仍被接受的运行证明。Node adapter等待exit而非stdio close属于源级完整输出风险，尚未有运行反例，不直接定性为产品失败。所有后继先纳入现有依赖表与组合验收，不重复增加同功能PR。

### 用户授权后的合入记录

用户明确要求“能合并的合并”。协调者按依赖顺序核对精确head与app/browser成功状态，使用merge commit和match-head保护；父PR合入后将子PRbase改为main，不删除父分支，不合入失败表征，不发布/部署。

已合入18个：#122/#127/#129/#136/#130/#137/#138/#141/#143/#128，以及#126/#145/#131/#144/#139/#147/#148/#146。#139新b2919b20已补CLI missing/tampered artifact非零exit；#14706b72004将LP-02改为可控请求/commit和editor/disk字节不变量。#148cff74f21静态DATA root containment已完整读diff，不宣称并发换链或跨进程事务解决。#146后来更新到7610e95，协调者补读新增scope matrix范围/密钥seed及verify路径，27项host matrix专项测试和两份committed artifact校验通过后按新head合入；旧992的验证不能替代此次补审。

合入前隔离组合复验包含更新后的#139/#147/#148和当时#146：Node22 Windows671 tests、666pass、0fail、5环境skip；真实Chromium73/73，包括新的确定性LP-02；architecture/normalized生成资产通过。随后#146范围再次更新，27/27专项与两个verify通过。所有候选独立Linux app/browser CI已通过；最终远端main组合CI须按最终head另行核验，不把Windows5skip当完整验收。

#140开发规范文档本次补入授权/合入记录，待本次文档head CI通过后合入。仍保留#135 Context失败、#149跨用户撤销隔离红回归、#150结果解析缺口及其依赖#152 release gate、#153依赖audit失败；#151 R2/composite按最新head运行结果和diff另审，未将旧head失败套到新head。根inventory/audit/完整16环境及全语法债务保持明确，不因大量合并改称“全审计完成”。停止本地生产修复与只用普通Chat/send to chat的偏好继续有效；user merge授权已取代此前不得merge的派工限制，没有据此扩大到tag/release/deploy。

反馈发送受到限流或“already responding”时不视为送达；保留问题并等待 Chat 可接收，再只通过 send to chat 补发。对外状态始终根据精确 PR head/CI，而非会话口头报告。

本轮检查了生产源码/测试清单、关键调用边界、全量 Node/Python 基线、CI/release 脚本、真实 Chromium 与 parity probe/allowlist。下表明确证据层次，未覆盖项不伪装为逐行完整审计。

| 域 | 本轮证据 | 后续测试约束/未证明 |
| --- | --- | --- |
| Auth/Discovery | 阅读 auth/request-context/runtime/policy；已有真实传输 scope matrix | API Key/OAuth/Web/Admin 跨 Vault、跨域负例持续必需；不以 visibility 代替授权 |
| Vault/文件/Context | 阅读 vault、bounded-read、附件、Web registry；Context security 已有反例 | 本机 3 项 symlink 权限 skip，Linux 必须全跑；Web search 的 stat→read 增长竞态和外部 writer 安全须进一步压力验证 |
| mutation/recovery | 阅读 plan/idempotency/journal 文档与对应测试集合 | MCP/Web/外部进程共同 CAS 尚未证明；既有 Web 锁明确仅 process-local，不能宣称跨进程原子 CAS |
| Web session/editor | document-session 状态机、浏览器 72 场景和既有回归 | 全局 UI/IME/DPR/真实笔记人工验收仍未完成；单套 browser 全绿不等于全矩阵 |
| Reader/Live 样式 | 初始与候选运行 light/dark × 19 probes；阅读 remote parity 修复和 allowance | main 仍 deferred 多种语法，仍存在 host geometry 及独有 chrome；完全一致性没有闭环 |
| Search/registry | 阅读 tree/search/link 路径并添加失败表征 | malformed YAML 导致全局搜索失败、未知 Vault fallback，见待修清单 |
| 构建/依赖/发布 | lockfile audit、npm ci/check/test/build、Python、inventory、CI/release 比对 | 门禁漏 root inventory、skip 与过滤策略、供应链审计接入；remote Node 22 最终组合验证 |

## 待协调的问题与证据

| ID | 优先级 | 问题 | 当前归属/退出条件 |
| --- | --- | --- | --- |
| QA-01 | P0 | 完全一致性未证明：Phase 0 允许差异且 deferred task/callout/embed/footnote/Properties/table 等 | remote parity track；按开发规范完整矩阵验收，无未解决可见差异后关闭 |
| QA-02 | P0 | #121 当前 active selection Chromium 失败 | remote #121；最新 head 的 app/browser/parity 全过且人工边界复验 |
| QA-03 | P1 | 浏览器 adapter 接受 truthy 非 boolean pass、null/畸形结果与 duplicate name 的证据不完整 | 本地门禁候选；8 项反例曾先失败后通过；协调 remote 后独立窄 PR |
| QA-04 | P1 | adapter 记录 serverErrors 却不阻断；但 harness 有预期 400 syntax error 被记作 server error | 两端一起定义 expected-client-error 与 unexpected-server-error；不能简单忽略日志或让合法负例使整套必红 |
| QA-05 | P1 | `resolveWebVault` 显式未知 ID fallback 到 primary | 本地失败测试已表征，生产实现未修；验证 unknown/deleted/disallowed Vault 均不误选 primary，再检查 HTTP boundary |
| QA-06 | P1 | `listWebNotes` 搜索时 `matter(raw)` 未隔离单篇坏 YAML，导致有效笔记搜索也失败 | 本地失败测试已表征，生产实现未修；保留损坏笔记原文并隔离解析错误，不得吞权限/IO 错误 |
| QA-07 | P1 | dependency audit 初始 4 包/7 advisory（dompurify low、fast-uri high、hono/ip-address moderate） | 本地仅 lockfile 候选更新后零漏洞；remote 是否更新与最终 browser 验证仍待协调 |
| QA-08 | P1 | parity numeric tolerance 用于样式 token，字段只按 left 遍历，缺值可按 0 比较 | 本地测试/脚本候选；需 exact semantic style、双向字段、null fail closed，几何只允许明确小容差 |
| QA-09 | P1 | 生成 Markdown 的 CRLF 与 LF 逻辑相同却导致门禁失败 | remote #120，已 CI success；不重复修复，合并后组合核验 |
| QA-10 | P1 | 根 `scripts/tool-inventory.test.mjs` 未进原 app CI/release；本地 skip 能仍退出成功 | 本地 quality gate 候选；明确 Linux 0 skip、root tests、超时/过滤/零检查反例后统一接入 |
| QA-11 | P1 | Web error middleware 将内部错误统一返回 400 并发送原始 message | confirmed source-level；尚无故障注入行为证据，先写 IO/内部错误和 path leakage 的 HTTP 反例，区分 4xx/5xx |
| QA-12 | P2 | Vault 遍历 10k 上限与搜索结果截断的 completeness 不完全统一 | source-level risk；边界数据夹具证明 truncated 语义，再修复，未宣称所有大 Vault 已覆盖 |

## 本地候选与暂停状态

用户叫停前已产生未提交的实现、tests、package/lockfile、CI/release 与生成资产改动。它们**没有合并、发布或部署**，不是可直接交付的代码集；与 remote #115/#116/#118/#120 存在重叠，保留供后续审查，不在脏工作区 pull/覆盖。

初始全量：570 tests，563 pass、2 fail、5 skip；2 fail 为 CRLF artifact 验证。Python 10/10，root inventory 10/10。symlink/Compose skip 是环境缺口。

本地 quality gate 在新增 Vault 失败回归之前通过，包含 syntax/architecture、Node、root inventory、Python、build 资产一致与 audit 零漏洞。随后加入 QA-05/QA-06 的 2 项失败表征，并按用户要求停止修复；**当前工作区测试不全绿**，不能沿用之前的 gate success。

初始 parity：每个主题 19 probes、107 allowed differences、27 deferred differences、0 unexpected。候选修改后：每个主题 97 allowed、30 deferred、0 unexpected；统计变化涉及 exact-style 测量改进，不能据此宣称当前 main 改善或完全一致。候选完整 Chromium 72/72 场景通过，但新增 server-error 阻断因预期 search syntax error 使 adapter failed；这一候选行为尚未最终重验。

## 恢复与下一步

### 2026-10-03 最新审查补记（文档候选，未合并）

main `8fc03e7b1c7210e4eb022fc65e6652934c3ae82b` 的 CI `37040898363` 全绿，#135/#153 已合入；开发规范 #140 已合入。历史段落保留当时状态，不能用其中的未合并/已验证描述覆盖当前证据。

#159@`32799e892fce8ce491d68964056ec6101731cafe` CI `37044718959`：app/Dependency audit 通过，真实浏览器 74/74 通过，完整16环境 parity仍失败。窄屏 default/small14/large20/alt-family 的 unexpected 为4/4/8/4，light/dark对称；桌面各格另有12条 heading active/selection 状态契约错误。R2 aggregate覆盖64/180、debt134、complete=false。窄屏default h2 glyphWidth 329.84→362.09，large20 h3 358.77→405.48、h4 303.39→355.95，仍是待修可见几何差异，不能只解决 class 采集后宣布完成。

已定位状态采集缺口：`liveSemanticClasses` 只收 `^cm-live-`，却要求 `cm-heading-source-active`，导致每格6标题×2状态报错；修复须补真实采集与缺字段反例，保留状态要求。旧h2编辑错误已证实为整篇doc.startsWith误取首行，新source-range/同一行/完整doc/selection回归通过。resize/font现逐级激活并验证idle清理；0.25px稳定条件没有替代最终1px约束。

隔离ca4d6eac Node22.23.3 clean install后两次build:web均得到normalized editor.js `44ec74d6fa56f2478b29d5be9ee5db4abb8a8c19`，与CI目标相同；原dirty工作区未覆盖，生产源码未由协调者修改。#151仍70cfd2ce，#159 stack其上；最终组合验收未完成，不合并。

#164@c7b0a7e exact CI37043747439全绿；旧test-only a0b98d03确定暴露33/40/512 own replay误标foreign和后续保存仍残留remoteRevision。真实session/controller/broker接线已补，资源清理、失败保存未commit条目、长期断线、真实cursor与重复replay仍补审，暂不合并。唯一owner为恢复继任普通Chat6abfde48；渲染owner为remote继任6abfbee8。无tag/release/deploy。

后续核验：#151@78d4f04已补probe-declared祖先class采集，独立CI37045510874仍parity红；该head基于main，未叠加#159，不能当作组合修复失败或成功。新组合完整16cell验收仍待运行。五个Chat读取统一429，未取到新回复，不刷请求。

#165@b034133b最终CI37045558688 app/browser/audit全绿，已审四文件并按exact-head授权合并，main为8f89b8b4683a4e9d5a9f0f4d35a8bf174c583506；组合CI37046032709 app/browser/audit全部通过。旧test-only79374cd2 CI37045277448真实HTTP证明撤销A单token会把同client的B MCP会话关闭（404≠200），新provider返回clientId/userId，admin调用已有principal teardown，A token401且B token/session200。git merge-tree无冲突；PR正文已改为最终修复和RED/GREEN证据，不再标regression-only。无部署/tag。

最新组合#159@6df11247 CI37045938945 app/audit与browser74/74通过，桌面12条状态采集错误已消除，完整R2仍因窄屏4/4/8/4几何失败。状态采集修复不得被记录成全部parity完成。#166 History canonical source读取候选正在更新，旧红/新绿和边界审查未验收；#167真实MCP搜索move/delete/truncation与semantic降级仅补覆盖，最新efea91a5 CI37046419969待验，不冒称修复历史bug。

### 2026-10-02 普通 Chat 协调约束

用户明确要求所有新派工会话只用普通 **Chat**，禁止 Work。新会话首次创建使用浏览器，之后消息使用 **send to chat** 工具。误建的四个 Work 会话已由用户删除；此前取消指令已送达其四个关联执行任务，不再派工。没有据此宣称其历史任务未产生代码变更。

已在 Obsidian 项目中通过浏览器创建以下普通 Chat，提交前均核实“聊天=1、工作=0”；后续协调消息已通过 send to chat 成功送达。创建和派工不代表审计完成或测试通过。

| 普通 Chat | 分工与文件边界 |
| --- | --- |
| [权限安全](https://chatgpt.com/c/6abf9b59-8068-83e9-b179-acefd0669ce9) | Auth/OAuth/API Key/Scope、Vault 路径与文件安全、routes.js；不改 registry、CSS、parity、CI |
| [写入恢复与并发](https://chatgpt.com/c/6abf9b8c-2400-83e8-bff2-53d86d385085) | mutation/journal/idempotency/Trash/history/session/SSE；不改 Auth、registry、CSS、CI |
| [阅读编辑完整一致性](https://chatgpt.com/c/6abf9bb6-79b8-83ee-9b70-aaa865f3ed12) | 独立覆盖矩阵与缺失采样审计；原 remote 的渲染和 parity 文件须先交接 |
| [测试门禁与检索](https://chatgpt.com/c/6abf9c0f-80d4-83ee-b68c-1684210d986e) | CI/release/browser adapter、search/Discovery；独占 vault-registry.js 的 QA-05/06，不改 routes.js 或 parity 文件 |

原 remote 继续负责已有渲染修复/#121 与 app.css、theme.js、live-decorations.js、当前 parity harness/allowlist/web-regression。各 Chat 可在自身可用工具范围内修代码、建测试及候选 PR；不得因工具缺失自行切 Work，不自动合并、发布、部署，不操作真实 Vault。协调者继续暂停本地代码修复，维护共享开发规范与审计报告。下一步核验各 Chat 的工具访问、基线 SHA 和实际结果。

1. 本地停止所有代码修复；remote 继续负责已有 parity/portability PR。文档约束与风险归属先落地。
2. 后续获准处理代码时，先将本地候选保存成独立补丁/分支，再在隔离 checkout 上对齐最新 main；人工挑选不重叠门禁候选，禁止 wholesale overwrite。
3. QA-05/QA-06 保留为失败回归；不能删除或 skip 来伪装绿灯。门禁试验独立审查，不能把脏工作区的包/CI 直接投入发布。
4. 生产无本轮修改，恢复无需重启服务。任何将来部署沿用 tag CI、NAS preview drift、备份/回滚规程。
5. 完整渲染一致性 TODO 保持 active；状态变化由最新 PR/head/运行证据更新。

## 2026-10-18 Admin D0（同源增强脚本）门禁与裁决

Admin 重做第二轮（D0：用户批准同源增强脚本）收尾。契约与真源见仓库 `docs/admin/README.md` 的 D0 节；
这里只记质量门禁与三条判据的裁决。

### 本轮跑过什么（本机 Windows，真 Chromium 1243）

- `npm run check`：语法 918 文件 + 架构 1069 文件，通过（含门禁与客户端模块的行预算）。
- 串行全量 `node --test --test-concurrency=1`：0 fail（**必须串行**；默认并发在本机会有约 11 条时序假红）。
  精确计数与各产物 SHA-256 见回执 `scratch/admin-parity/evidence/local-evidence.json`
  （`obsidian-local-validation/v1`，commit/tree 绑定）。
- Admin 门禁 `node scripts/run-admin-layout-checks.mjs`：**40/40**（结构 / paint / 无 JS / 交互 / host 策略 /
  迁移判据），其中自带原型侧 sabotage 负控（每条行为一个）与注入负控（inline script 必须被拦、
  注入 `on*`/`javascript:` 必须报红）——负控不是可选项，它和正控在同一次运行里断言。
- 浏览器半边：`ADMIN_CLIENT_BROWSER_EVIDENCE=1 node --test --test-concurrency=1 test/admin-redo/client-*.test.js`
  （真浏览器 + 真夹具服务器）。
- D0 boot 探针：每个认证页 `data-admin-client=1`、`<script>`=1、`on*`=0；登录页 0 脚本。
- 判据负控 `scratch/admin-parity/negctl-gate-judgments.mjs`：7/7 符合预期。

### 三条判据的裁决（实现缺陷 vs 过期判据）

1. **危险操作确认框「文本门禁」= 实现缺陷**（判据与原型一致，是增强脚本漏做）。SSR 契约要求按钮
   **出厂可用**（无 JS 必须能提交，服务端自己比对 `confirm`），原型则用脚本 `disabled` 到文本匹配为止
   （`6-app.js:101/437`）。修法 = 增强脚本补回门禁（比对页面自己的 `.tc code` 目标串，多一个字符也算不匹配），
   服务端比对不变；有脚本 / 无脚本两条真浏览器断言进 `test/admin-redo/client-overlays.test.js`。
2. **`/` 聚焦搜索 = 过期判据（测量缺陷，不是实现）**。旧判据用一条逗号分隔的 `querySelector` 取"当前页搜索框"，
   而它返回**文档顺序第一个**匹配：SSR 搜索表单里隐藏的 `<input name=tab>`（被 `.search input` 命中）。
   焦点其实一直在可见的 `input[name=q]`。修度量：按优先级解析候选、跳过 `type=hidden`/`disabled`，并**加严**——
   焦点落在没有布局盒的控件上判红。
3. **无 JS 删除策略 = 过期判据（判据缺陷，markup 正确）**。typed 字段确实通过 `form="cf1"` 属于该表单，
   但旧判据手写比较 `getAttribute("form") === form.id`，而 `HTMLFormElement` 的 `[LegacyOverrideBuiltIns]`
   命名访问让表单自己的 `<input type=hidden name=id>` **遮蔽 `form.id`**，正确绑定被读成"没关联"。
   修度量：改用浏览器自己的 form owner（`input.form === form`）并**加严**（字段必须未 disabled）。
   负控：缺 id / 无 `form=` / disabled / 页面无焦点 → 判据真红（原始 JSON 见回执同目录日志）。

## 2026-10-18 Admin 与原型「整页骨架」对照（Wave P）

起因：用户反馈「Admin 的 UI 与交互仍和原型不一致」。实测结论：**交互侧是好的**（线上真浏览器 smoke 23/23：
点行走同源 fragment fetch + `pushState` 开抽屉、`t`/`?`/`/`/`g o`、0 CSP 违规、无 JS 建/拒/删策略），
但**外观/结构侧确实有偏离** —— 且上一轮门禁 40/40 没抓到，因为它比的是「挑选过的判据 + 几何」，
不是整页 DOM 骨架：多一整条工具栏、把控件类型换掉都能过。

### 这一轮做了什么

1. **把对照升级为门禁**：`app/scripts/proto-parity/shape.mjs`（探针 + 判定）与 `shape-gate.mjs`（抓取 / 注册 / 负控），
   注册进 `web-regression/admin-layout.mjs`。每个状态用**同一归一化**同时量原型
   （`docs/admin-ui-proto/index.html?dev=1&theme=dark`）与实现，断言「形状序列一致 + 结构位置文案一致 + 记录入口一致」；
   数据差异只能**逐行显式豁免**（`kind ∈ state/data/no-js-submit/deliberate`，无通配符，条目失效即红）。
   门禁总数 40 → **47/47**。负控：实现侧注入（改类名 / 加区域 / 拿掉页头）红；**原型侧**注入同样改动也红
   （原型是现读，不是黄金副本）；滥用豁免（通配符 / 未声明 kind / 用 data 豁免整排行态 / 失效条目）红。
2. **修掉四处可见差异**（都修在 SSR 原始 HTML，不靠脚本补齐）：
   - 侧栏：删掉 `{group:""}` 多渲染的**空 `.sec-h`**（整栏比原型下移 44px）；`审计` 去掉计数只留 attention 红点。
   - 搜索框：回归原型 `<kbd>/</kbd>`；真实 GET 表单靠**单文本字段的隐式提交**（不再用放大镜按钮占位）。
   - 编辑器：删掉原型没有的顶部工具栏（两个筛选回到 `.picker` 内的原型位置，用 `form=` 关联外置 GET 表单避免嵌套 form）；
     `状态` 改 `switchControl`（`.switch` 外观 + 真实 checkbox）；删掉预览栏里原型没有的 SSR 说明。
   - 总览：`需要关注 / 最近失败` 行回到 `<a class="li" href=…>`（失败行带 `&focus=`，审核页支持 `?focus=` 的 `.cur` 标记）。
3. **独立审查**（席位 `01a14e31`，未参与本波）给 **GO**，并留 Wave Q 清单：R1 记录行内部结构不可见、
   R2 抽屉无棘轮上限、R3 本波新增可见文案未进 `LABEL_SCOPE`、R4 一条豁免理由句不准确、
   R5 侧栏 kbd 按钮是脚本专属（需在 `docs/admin/README.md` 记为显式例外）、R6 `.pg` 不在 data containers、
   R7 `assertPreview` 初始判定被放宽；协调席另查出 `LABEL_SCOPE` 缺 `h2`/`p.help`、`shape.mjs` 重复豁免未检测。
   **这些未在本版修**，原样留在 Wave Q（不写成"已修"）。

### 本轮跑过什么（本机 Windows，真 Chromium 1243）

- 回执 `scratch/admin-parity/evidence/local-evidence.json`：绑**发布提交 `920f7350` / tree `c9dfb33a814e`**，
  8 项全绿（check、串行全量 **4374 executed / 0 failed**、门禁 47/47、浏览器半边 28/28、D0 boot 探针、
  判据负控 7/7、HTTP smoke、review-fixes）。
- 发布：**`v2026.10.18.7`**（提交 `920f7350`，NAS changed 16 文件、drift `[]`、action restart）。
  版本号让位说明：`.6` 已被 desktop-re 的 Web 批次（`d48f01b1`）占用 ⇒ 本版为 `.7`。
- 线上 `.7` 后的独立复核（协调席本人跑，不采信实现席自述）：交互 smoke **23/23**；`sidebar-parity` 确认线上
  `nav` 首个子元素是 `a.ni`（与原型同）、44px 位移消失；截图对照确认搜索框 `/` 提示与编辑器（无工具栏 + 开关外观）。
- 环境事故与修法（记下以免复发）：共享 `app/node_modules` 被清空（只剩 66 项、无 `express`）⇒ 依赖它的套件全红、
  门禁 "fixture server must become ready" 失败；修法 = `repo/app` 下 `npm ci` + 重建 `node_modules/playwright`
  junction（指向 `scratch/.pw-runtime`）+ `npm rebuild esbuild`。**判据：门禁与套件大面积同时红时，先查依赖是否完整，
  再怀疑产品。**

## 2026-10-19 Admin「整页骨架门禁」灵敏度补强（Wave Q）

Wave P 把「与原型逐状态整页 DOM 骨架一致」做成了门禁（47/47）。两名独立审查席仍指出判据盲区：判据覆盖不到的
地方，仍然能让「多一条工具栏 / 换掉控件类型」溜过去。本波只补**门禁与测试的灵敏度**，另修由此暴露或已确认的
产品可见差异；判据一律加严，没有为了变绿而放宽。

### 门禁判据（`app/scripts/proto-parity/{shape,shape-waivers,shape-gate}.mjs`）

| # | 现象（改前） | 改法 | 反证（必须真红） |
| --- | --- | --- | --- |
| Q1 | `LABEL_SCOPE` 只含 `.sec-h`：分区标题（`h2`）、说明段（`p.help`）、旁注（`.tx2`）、能力分组标题（`.cap-h`）的文案根本不比 | 四者进 `LABEL_SCOPE` | 改 `h2` 文案 / 删 `p.help` / 改**原型侧** `h2` 各自真红（负控 A、B） |
| Q2 | 两条完全相同的 `(state,line,side)` 豁免会互相遮蔽失效检测 | 卫生检查直接拒绝重复；同一行出现多次必须写成**一条** `count:N`，并按实际命中数校验 | 故意复制一条 → 红；`count:1` 而命中 2 → 红；`count:0` → 红 |
| Q3 | `kind=data` 能豁免整块区域容器；`.search`/`.btn`/`switch` 的归一化丢掉了「无脚本时能不能用」的语义 | ① `data` 不再能豁免容器行，目录区域数量改用受限的新 kind `catalog`（只允许指向 `div.cap-g`）；② 搜索框与控件契约改为**正判据**：`compareShapeSearchBoxes`（提示文案逐盒对照、GET 可提交、查询字段带 `name`、有提交目标）＋ `deadControls`（`<a class=btn>` 必须有 href、`label.switch` 必须包真实 checkbox、`button.switch` 必须提交或明确标为非交互） | `form.search` 退回 `label.search` → 红；拿掉某个 `.btn` 的 `href` → 红；把真实 checkbox 换成脚本按钮 → 红 |
| Q4 | 记录行内部结构不可见（行内元素 kind 互换 → 0 failures） | **不改配对键，收窄说法并给出实测边界**：三种顺序判据在**当前正确树**上分别产生 43（严格序列）/ 3（相邻对）/ 2（最小下标）处假差异，成员集合判据 49 处 —— 全部源于两侧 fixture 持有的记录不同。因此：非记录行按顺序逐行比；记录**区域**按签名比；行内成员/顺序按数据口径记为 note（报告单列计数）。边界本身写成反证：行内交换**必须**只是 note，而拿掉整块记录区域**必须**真红 | 行内交换 → 无失败（断言边界，防止说法被悄悄改动）；拿掉 `tbody` → 红 |
| Q5 | 抽屉状态「只报告不断言」，且 `>0` 的断言在抽屉变干净时反而红 | 棘轮 `<= 136`（只降不升）+ 单独断言抽屉内的 `compareShapeLinks`（记录入口两侧一致） | 差异数涨到 137/139（本波内实测到过这两种值）→ 红 |
| Q6 | `.pg` 不在 data containers：页数被当结构，跨页 fixture 会因数据变红 | `.pg` 进 data containers（页数是部署数据） | 棘轮保持 136，跨页不再因数据变红 |
| Q7 | `assertPreview` 初始判定退成 `/现在（/`，实际依赖墙上时钟 | 先加载「非今天」的那一天：该 draft 不含今天的窗口 ⇒ 服务端判定必然为「暂停 · 今日无生效时段」，逐字断言（并保留「不得读作允许访问」） | 浏览器侧负控（本地算出的判定）仍然真红 |
| Q8 | 两条 `authz-editor` 的 `data` 豁免理由写「capq 对照分组名」 | 改正：capq 只对照勾选集合 / `?capq=` 过滤保留已选 / 未改动保存不丢选项，**不比较分组名**；分组区域数量由 `catalog` 豁免承担 | 理由句可逐条核对；卫生检查通过 |
| Q9 | 负控 C 里有一条「自比较」（拿未注入的探针与全量判定比长度），从不恒假；另有三处旧断言需要复核 | 自比较换成「注入区域 + **真实豁免表**下仍必须报红」；负控 A/B/C 增补 Q1–Q4 的真红项；三处旧断言逐条复核（authz preview 的 `inline-form` 形状、`.pick-list > label.pick`、审核分页的 `.pg` 当前页标记） | 全部真红输出见门禁运行日志 |

### 产品侧（Q1–Q3 变严后暴露 / 已知候选）

**判定：实现缺陷，已修。** 时间窗口摘要有两套说法：`presentation/model.windowSummary` 与原型一致，而
#434 展示模型 `access-policy-window-presentation.js` 与客户端镜像 `admin-feature-lists.js` 用
「周一至周五 · 09:00–18:00」「未设置周时段」「每天 · 全天」并以「 · 」连接 —— 于是「允许时间窗口」列、
移动卡片 `.tx2` 与编辑器预览栏三处都与原型不同（原型 `5-render.js:windowSummary`：工作日/每天/周末 +
字面 `HH:MM–HH:MM`（全天即 `00:00–24:00`）、以「；」连接、无周窗口即「每天全天」）。现在两侧同一套词汇；
仅预算兜底「自定义 · N 个时段」与「无法解析时间窗口」保留为 plane 专有，并在代码注释里写明。前后同测：
窗口展示单测矩阵与预算边界、集成测试的列文案、`admin-window-presentation` 门禁常量、浏览器场景的期望摘要
全部随新词汇更新。

### 本波发现的既有缺陷（不是本波引入；各自留证据与归属）

1. **`scripts/run-admin-window-checks.mjs` 自 AuthZ 页面重写后即失效**：其接线断言要从列表页抽取
   `data-window-open href=…`，而该属性只存在于**已无人 import** 的 `src/admin/access-policy-view.js`
   （`src/admin/router.js` 只 import `routes/access-policy.js` → `pages/authz.js`）。本波只同步了它的摘要常量，
   未修接线。**未修，归属 AuthZ 后续波**：要么把门禁指向 `pages/authz.js` 行菜单的 `?window=`，要么删除死的旧路由模块。
2. **全量套件 4 条红同源（已修）**：OS 分配的临时端口落在 undici 的 blocked-port 名单里（本机实测 6667），
   `fetch` 直接 `TypeError: fetch failed / cause: Error: bad port`，看起来像服务端/套接字缺陷；
   `scratch/admin-parity/evidence-run-shim.cjs` 的注释早就记了这个本机端口范围问题（上一波用 shim 绕开）。
   本波把修法放进树里：① 新增 `test/fetch-safe-port.mjs`（`fetchSafePort()`），直接修了已经红过的三个文件；
   ② 新增 `test/preload-fetch-safe-listen.mjs`（`--import` 预载，只改 fixture 绑定的空闲端口，不碰任何断言），
   覆盖其余四十多处 `listen(0)`。文档里的串行命令改成带预载的形式（`docs/admin/README.md`）；
   CI（Linux）的临时端口范围不覆盖名单，不需要这个预载。

### 本轮跑过什么（本机 Windows，真 Chromium 1243）

- 热工作树 `npm run check`：语法 **918** 文件 + 架构 **1073** 文件，通过。
- 门禁 `node scripts/run-admin-layout-checks.mjs`：**47/47**（含本波新增判据与全部负控）。
- 串行全量 `node --test --test-concurrency=1 test/*.test.js test/admin-redo/*.test.js`：
  **4274 tests / 4247 pass / 0 fail / 27 skipped**（日志 `scratch/admin-parity/wave-q/full-serial-3.txt`）。
  之前两次红的归因：第一次 4 条全是 `bad port`（已修）；第二次 2 条是我修那 4 条时漏了一个 `import`（已修）。
- 浏览器半边（真 Chromium）：`ADMIN_CLIENT_BROWSER_EVIDENCE=1 … client-lists.test.js` **11/11**；
  `client-lists + discovery-runtime + authorization-transfer-admin-e2e` **27/27**。
- 冻结副本（`git archive 94515388`，非热工作树）：`npm run check`（syntax 918 / architecture 1073）+ 门禁 **47/47**；
  串行全量同跑（日志 `scratch/admin-parity/wave-q/frozen-*.txt`）。

## 2026-10-19 Admin 收尾（Wave R）：两条用户裁决的设计变更 + 门禁自欺三处 + CI 端口/时序

Wave Q 之后独立审查席留下 7 条发布阻塞。本波只做这 7 条，并且每条都把口径写成可执行的断言（不是叙述）。
下面按「用户裁决 / 可见差异 / 门禁自欺 / CI 时序」分组，**明确区分 parity 与设计变更**。

### A. 用户裁决的设计变更（2026-10-18）—— **不是** parity

1. **Q12 自绘下拉（用户裁决的设计变更）**。原生 `<select>` 的展开列表不可样式化，用户要求改由 plane 自绘。
   - 新增 `app/src/admin/assets/admin-feature-select.js`（`registerFeature("select")`），同步
     `router.js: CLIENT_MODULES`、`scripts/proto-parity/policy.mjs: ADMIN_CLIENT_MODULES`、`docs/admin/README.md` D0 模块清单。
   - 作用域：Admin 内所有 `select.sel`（含 `.sel.sm`），标 `data-native-select` 的除外。
   - **无 JS 契约**：真实 `<select>` 永远留在 DOM 与表单里（`name`/选项/`value` 不变），脚本生效后仅 *视觉* 隐藏
     （`position:absolute` + 1px 裁切 + `aria-hidden` + `tabindex=-1`），选择**镜像回**真实 select 并派发真实 `change`。
     无脚本时行为与之前逐字一致（浏览器半边有断言）。
   - 外观沿用 Admin 设计语言：`--elev` 面 / `1px --line2` / `--r2` / `--shadow` / 32px 行（`.sm` 28）/ 8px padding /
     13–14px 字号 / hover `--hover` / 选中 `--sel`+`--tx`+勾选标记；`max-height:320px` 可滚；宽度对齐控件；挂在 `body`
     上 `position:fixed`（不被容器裁切），滚动/缩放即关闭。
   - 键盘/ARIA 达原生同级：↑/↓、Home/End、Enter/Space、Esc（关闭并把焦点还给控件）、Tab、首字母 type-ahead；
     `role=combobox` + `aria-expanded` + `aria-controls`，列表 `role=listbox` / `role=option` / `aria-activedescendant`；
     外点关闭、再次点控件关闭；弹层进 `ctx` overlay 栈。
   - **门禁口径（显式登记为用户裁决）**：`admin-layout-design.mjs` 断言「JS 开时弹层存在且选中态样式正确（`.on`+`aria-selected`+
     勾选标记+`--sel` 底）+ 封闭态仍是原型 `.sel` 形态（高/宽/圆角/字号与原型原生 select 同测）」，**不**断言「与原型一致」。
     形状门禁侧给自绘控件加了 N16 透明规则（真实 select 仍在 DOM 里承担骨架行），所以封闭态的行仍是 `select.sel :: -`。
   - 三处负控（浏览器半边 `client-select.test.js`，各自真红）：断开镜像 → 红；弹层不挂 body → 红；把真实 select 移出表单 → 红。
     设计门禁内另有同三条（在已打开的判据上叠加破坏）。

2. **Q10 窄屏导航（用户裁决的设计新增）**。原型那枚 `[data-act=mmenu]` 是**死标记**：`1-head.html` 没有 `.mobile-only`
   规则、按钮内联 `display:none`、`6-app.js` 也没有 `mmenu` 分支 ⇒ 没有可继承的行为，这是新增设计。
   - 断点**复用**原型 `@media (max-width:720px)`（`1-head.html:353`，`.mnav` 也在其中），不造新断点。
   - 窄屏时页面外壳渲染 `.ibtn.mobile-only[data-nav-toggle]`（`aria-label="菜单"`、`aria-controls="admin-nav"`、`aria-expanded`）；
     宽屏 `display:none`（形状门禁在 1440 看不到它，宽屏布局零改动）。
   - JS 开：点击 → 侧栏覆盖层滑入 + `#mscrim` + `body.overlay-open` 滚动锁定 + `role=dialog`/`aria-modal`，
     焦点移入侧栏、关闭后还给按钮；Esc（走 overlay 栈）/点 scrim/点导航项/再点按钮都关闭；打开走 `pushState`（不重载），
     关闭用 `history.back()` 让 Back 也等于关闭。
   - **无 JS 可用**：SSR 渲染 `?nav=1` 这一真实状态（侧栏 `nav-open` + scrim + `role=dialog` + 关闭链接回当前 URL），
     无脚本时按钮本身就是指向 `?nav=1` 的链接；底部 `.mnav` 原样保留。
   - 门禁（390×844）：按钮存在可见；JS 开时覆盖层/scrim/`aria-expanded`/滚动锁定/焦点/URL 且不重载；Esc 关闭且焦点回按钮；
     无 JS 时 `?nav=1` 渲染覆盖层与关闭链接、点导航可跳转。反证：拿掉 `?nav=1` 服务端状态 → 红；把按钮改成纯 `data-act`（无 href）→ 红。

### B. 用户可见差异

3. **Q11 预览卡 132px → 与原型一致（±8px 门禁）**。「当前状态预览」多渲染的无 JS 提交按钮并不是高度本身：
   根因是 `form.inline-form{display:inline-flex}`（shrink-to-fit）里 `width:100%` 的 select **没有确定宽度可解**，
   于是内部 flex 行换行，卡片多出一整行（≈40px）。
   - 修法：该表单加 `form-block`（`display:block`，仍保留 `inline-form` 让形状门禁把它当透明）；`查看` 按钮加
     `data-enhance="hide-when-scripted"`，由 D0 客户端在**替换它的增强真的跑过之后**才收起（表单被 select 增强标记
     `data-enhanced="1"` 才收；增强抛错则按钮留着）；`select` 加 `data-autosubmit`，列表页 `data-preview-form` 走
     服务端自己的 `POST {base}/preview` 片段采纳 ⇒ **选主体原地出判定**（不导航、URL 不变、焦点留在控件上）。
     无 JS 时按钮可见、POST 正常、判定正确（浏览器半边有断言）。
   - 同类排查：`tokens` 排序按钮与 `audit` 的 `筛选/应用` **保持可见**——GET 工具栏的 change 已由原地切换接管，
     再叠 `data-autosubmit` 会在同一个 change 上补一次真实 GET；`audit` 是多字段文本筛选，原型是 debounce 实时筛选，
     不是「一次下拉即提交」。两条豁免保留并在表里写明这条理由。`tokens` 的 `查看`-类豁免（`.btn = 排序`）因此保留，
     而 `authz` 的两条豁免（行与文案）随按钮收起而**删除**（失效豁免会红）。

### C. 门禁自欺三处

4. **R2 红绿依赖场景顺序**。审查席实测：干净 fixture 单跑 shape 场景 3/7、约 150 条数据差异；先注册再跑 7/7。
   - 修法：shape 场景**自带播种**（`seedParityFixture` 改成**按条件幂等**：已有账户+策略就返回 `seeded:false` 并跳过，
     不会造第二份数据），并把前置条件写成断言（每个列表页两侧都必须有记录区、每个抽屉页两侧都必须有记录行），
     缺前置就明确红；报告头把差异分成**结构 / 数据驱动**两段（数据驱动 = 记录行/记录区，或本侧记录入口少于原型）。
   - 证据：干净 fixture 单跑 shape 场景（2026-10-19，本机）**8/8 全绿**，报告 `# differences: 0（结构 0 / 数据驱动 0）`。
   - 反证：同一前置判据对一份合成痕迹（原型有 `tbody`、实现没有）必须报红——写死在同一 check 里。

5. **R3 负控里「绝对零失败」被数据差异带成假红**。改为「只允许 **0 条新增**失败」：以同一页未注入时的判据结果为基线做差
   （正常树上基线为空，控制强度不变；有数据差异时不再假红）。反证：拿掉整块 `tbody` 在同一口径下必须产生新失败。

6. **R4 抽屉棘轮 136 零余量且数据相关**（另一份数据实测 137）。改为**结构签名集合 ⊆ 冻结基线**：
   签名 = 差异行去掉 state 前缀、掩码 id/数字/`= 值`；**新签名一条即红**，已知签名出现多少次都不计。
   当前冻结 **55 个签名**（旧口径下同一棵树 140 条差异、上一波记录 136 条 —— 这正是「条数描述的是数据不是布局」）。
   改善不报红（子集判定），报告会列出可修剪的签名。

### D. CI 端口与判据时序

7. **CI 端口**：`app/scripts/run-node-tests-ci.mjs` 的 `node --test` 现在接上
   `--import <app>/test/preload-fetch-safe-listen.mjs`（CI 与本地同一条命令）。另外 `admin-layout-fixture.freePort()` 改用
   `scripts/fetch-safe-listen.mjs` 的 `listenFetchSafe`：门禁自己也会 `listen(0)`，抽到 undici blocked-port 时整场门禁红成
   「fixture server must become ready」（本波第一次跑就复现了）。
8. **toast 判据时序**：`toast-shown-then-expires` 原来在固定 80/1000/2700ms 三个点采样，机器有负载时原型侧会 `46/47`。
   现在**轮询到状态变化**：等到出现（上限 4s）→ 出现后 1s 仍在 → 等到消失（上限 7s），并要求消失不早于约 2.5s。
   **改的是时序假设，不是放宽判据**（仍然要求出现、1s 仍在、由自身 3200ms 定时器收走）。

### 本轮跑过什么（本机 Windows，真 Chromium 1243）

（实测数字见下一条提交后的回执；冻结副本同跑）

### 实测（本机 Windows，真 Chromium 1243；日志在 `evidence/wave-r/`）

- 热工作树 `npm run check`：语法 **937** 文件 + 架构 **1094** 文件，通过。
- 门禁 `node scripts/run-admin-layout-checks.mjs`：**52/52**，且**连跑 3 次全部 52/52**
  （`evidence/wave-r/gate-run-{1,2,3}.txt`；此前 47 次口径下会偶发 46/47，见 D 组 toast 时序）。
- 串行全量 `node --import ./test/preload-fetch-safe-listen.mjs --test --test-concurrency=1 test/*.test.js test/admin-redo/*.test.js`：
  **4351 tests / 4317 pass / 0 fail / 34 skipped**（`evidence/wave-r/serial-full.txt`）。
- 浏览器半边（真 Chromium）：`ADMIN_CLIENT_BROWSER_EVIDENCE=1 … client-*.test.js` **33/33**
  （含新增 `client-select.test.js` 5 条：行为 + 无 JS + 3 条负控；`evidence/wave-r/client-browser.txt`）。
- **R2 反证实测**：干净 fixture **单跑** shape 场景 **8/8**（旧口径 3/7、~150 条数据差异；
  `evidence/wave-r/shape-standalone.txt`）。
- 反证汇总（纯函数口径 + 浏览器负控）：`evidence/wave-r/negative-controls.txt`。
- **冻结副本**（`git archive fe45eb99` → 临时目录，`app/node_modules` junction）：`npm run check`
  （syntax 937 / architecture 1094）+ 门禁 **52/52** + 串行全量同跑 **4351 / 0 fail / 34 skipped**
  （`evidence/wave-r/frozen-gate.txt`、`evidence/wave-r/frozen-serial.txt`）。
  发布提交与本行记录的差异只有本节文档（代码/门禁零差异）。
- 两条实现过程中真实咬到的坑（记下来）：
  1. `ADMIN_SSR_CSS` 是模板字符串，**注释里写反引号会直接语法错误**（`node --check` 能抓，
     但服务端启动才炸 → 门禁报 “fixture server must become ready”）。本波出现两次，均已修。
  2. `vaults`/`vaults-repair` 的「no JS hooks」扫描跑在**整份文档**上（CSS 也在内），
     所以 CSS 注释里写 `[data-act=mmenu]` 会让它对这条真断言报红 —— 改注释措辞，不动断言。
