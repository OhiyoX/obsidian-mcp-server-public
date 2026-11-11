# 统一权限架构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一种按操作和目标表达的权限模型，让同一账户在 `vault` 只读、在 `example-vault` 可写，并统一所有执行与解释入口。

**Architecture:** `authorize(request, snapshot)` 是唯一纯决策函数；可信身份、冻结 OAuth ceiling、实时 grants、时间约束和目标准入共同决定结果。先固定旧行为，再导入、影子比较和集中接线，最后所有 transport 同时切换；旧路径只在有退出条件的迁移桥中保留。

**Tech Stack:** 现有 Node.js ESM、`node:test`、Express、MCP SDK、JSON 单写者 store、SSR Admin、现有 i18n 与 Chromium/Playwright 门禁；不新增运行依赖或策略解释器。

**Spec:** `docs/superpowers/specs/2026-11-05-permission-architecture-design.md`

**状态：设计已获 owner 批准（2026-11-05）；执行方法已定：subagent-driven，每阶段一个实现者 + 一个独立原文复核，复核 GO 才进下一阶段。** 计划里的测试/文件/命令仍是未来步骤，未执行。两个阶段由协调者本人执行而不是派给子代理：P0（等价基线决定后面所有判断）与 P4（唯一一次带维护窗口的原子切换）。owner 已批准的三个决定见设计 §15。

## Global Constraints

- 一种 capability 词汇、一个授权决策入口；默认拒绝；权限不足不得执行内容 handler 或泄露正文/路径/revision。
- 用户曾同意交给某凭据的上限被冻结；操作者现在允许什么实时读；身份撤销用永久 fence；路由偏好实时读但不是授权。
- `grants: []` = 无权；只有 OAuth client 允许 `grants:null`，表示“客户端不额外收紧”，不是授予一切。
- 文件 `<DATA_PATH>/authorization.json`，`schemaVersion:1`、`catalogVersion:1`；目录 `0700`、文件 `0600`；单进程单写者。
- 冻结上限：文件 16 MiB；主体 10,000；每主体 target 65；constraints 512；每条 subjects 32、selector 分支 64、每分支 capability 128；weekly/dateRanges 各 64、label 120、timezone 80。超限不截断。
- 不新增或扩大任何门禁豁免；Admin 改动前推原型参照并带结构负控，不发区域 waiver。
- 认证、CSRF、CSP、可访问性、只读部署、Vault containment、admission、transfer fence、CAS、journal/handle 绑定和错误处理全部保留。
- 不改默认库优先级；默认库不是授权；MCP 失效目标不 fallback；Web 只按已批准的失效会话选择规则重选。
- 新格式缺记录/字段/文件、未知版本或 broken 状态 fail closed；marker 提交后禁止 legacy/shadow 回退。
- 全部任务使用独立 worktree；单一文件 owner；合入后按变化面复用/补充证据，不以旧 CI 或 helper 测试冒充真实边界。
- 每条测试命令从 `app/` 执行，显式 `DATA_PATH="$PWD/.tmp-permission/<task>"`；夹具根也只能在该隔离目录内。使用合成凭据，测试在 finally/after 清理自己创建的资源。
- 不在仓库写真实 state、Vault、凭据或线上日志；部署另需授权；任何实现任务都不授权 merge/release/deploy。

## Review Focus

1. [RF1，T5/T7/T23] 缺失/空/损坏/重复键不能当默认全权；旧 client 的 null ceiling 不能让丢失 client 通过。
2. [RF2，T6/T7] 旧 selector 列表是 OR，不能译成 AND；共享 capability 不能让 MCP-only policy 误伤 Web；OAuth suspend 不增拒绝。
3. [RF3，T14/T15/T23] 扩权、缩权、默认库变化和并发 refresh 不得重绑旧 handle 或越过原 consent；SSE 拒绝后不能继续投递排队事件。
4. [RF4，T4/T24/T25] CAS/写失败/重启/切换中断不暴露未确认候选；混合权限不可经旧格式并集回滚而扩权。
5. [RF5，T18/T26–T28] Admin 的 token 合并展示不是实际授权；无 JS、跨语言 placeholders、过期表单和结构负控均有效。

---

## 交付顺序与发布不变量

| 阶段 | Tasks | 可独立上线的状态 | 下一阶段硬门 |
| --- | --- | --- | --- |
| P0 | 1 | 旧 enforcement + 新表征夹具/比较器 | 入口清单、基线原件、负控齐全 |
| P1 | 2–8 | 新核心与导入器不接 enforcement | 纯规则/store/转换测试通过 |
| P2 | 9–18 | 真实入口旁只读 shadow；所有响应仍旧判定 | 每入口覆盖；24 小时+合成流量；零未解释差异/零 inconclusive |
| P3 | 19–22 | 入口统一调用 runtime；仍选 legacy/shadow 后端 | 本地局部授权判断清零，行为与 P0 对齐 |
| P4 | 23–25 | 一次维护窗口、一次全局 enforce 切换 | owner 批准全部有意差异；迁移、重启、回滚反例通过 |
| P5 | 26–28 | 可运营的按库权限 Admin；双语与原型前推 | 同账户双库读写矩阵、无 JS 与负控通过 |
| P6 | 29–30 | 仅新模型；旧文件离线归档，协议 Scope 翻译保留 | 原文独立审查、最终变更面门禁及恢复证据 |

“一步到位”不等于跨阶段合成一次上线。每阶段可以停留，服务保持正确。P2/P3 不得通过开关先让一个 transport enforce；P4 marker 后不能用关闭新模型救火。

## 文件职责与所有权地图

| 单元 | 文件 | 职责 |
| --- | --- | --- |
| 目录 | `app/src/authorization/catalog.js` | 操作 ID、target/plane/effect、协议映射；不是另一个 Scope 表 |
| schema/store | `app/src/authorization/schema.js`、`store.js` | 严格数据边界；单文件 committed snapshot/CAS |
| 导入 | `app/src/authorization/legacy-import.js`、`legacy-policy-import.js` | 固定基线的 grants 与约束转换，只在迁移/影子使用 |
| 决策 | `app/src/authorization/evaluate.js`、`runtime.js`、`actors.js` | 唯一算法、数据捕获/时钟、可信身份构造 |
| 迁移桥 | `app/src/authorization/shadow.js`、`legacy-evaluate.js` | 有期限的比较器与旧后端；P6 删除运行路径 |
| adapters | `app/src/authorization/adapters/mcp.js`、`web.js`、`admin.js` | 规范输入、映射响应/投影；不自行算 allow |
| 数据迁移 | `app/src/authorization/migration.js`、`app/scripts/migrate-permissions.mjs` | 维护窗口 prepare/commit、marker、备份与降级拒绝 |
| Admin | `app/src/admin/permissions.js`、`routes/permissions.js`、`permission-editor.js` | schema/CAS 服务、HTTP guard、SSR 权限表；遵守 catalog 单一数据入口 |
| 证据 | `app/test/fixtures/permission-architecture/`、`app/test/helpers/permission-baseline-harness.js` | 合成基线、manifest、真实路由/SDK 驱动和非空比较器 |

现有接线位置由各任务逐项列出；不存在这些新文件不算当前缺陷。路径中的省略仅限上表同目录表示法，任务 Files 一律写完整路径。共享热点 `app/server.js`、`app/src/auth.js`、`app/src/app/routes.js`、`app/src/admin/router.js` 串行处理。

## P0：固定事实，不改变权限

### Task 1：入口清单、真实基线与比较器

**首个失败测试：** `baseline_manifest_rejects_missing_duplicate_and_empty_rows`。

**Files:** Create `app/test/permission-baseline.test.js`、`app/test/helpers/permission-baseline-harness.js`、`app/test/fixtures/permission-architecture/manifest.json`、`app/test/fixtures/permission-architecture/baseline.json`、`app/test/fixtures/permission-architecture/legacy-state.json`、`app/test/fixtures/permission-architecture/legacy-policies.json`。Read `app/test/multi-vault-auth-characterization.test.js`、`app/test/multi-vault-auth-matrix.test.js`、`app/test/compact-v2-real-authz-matrix.test.js`、`app/test/access-policy-server-integration.test.js`、`app/test/web-files-scope.test.js`。

**Interfaces:** Produce `collectBaselineRows({ sourceRoot, dataPath, nowMs }) -> Promise<BaselineRow[]>`、`comparePermissionRows(expected, actual) -> Difference[]`。行键为 `(actorCase,surface,capability,targetCase,timeCase)`；同时记录 allowed、错误族、拒绝位置、handler/I-O 计数及 bytes/revision 不变量。

- [ ] **Step 1 — 写失败测试。** 在上述测试里断言 `assert.notDeepEqual(comparePermissionRows(rows, []), [])`；缺 1 行、重复 1 行、false→true、unknown→false 均报差异。manifest 精确 pin 基线 commit/tree，并覆盖全部 `TOOL_NAMES`、resources、受保护 Web/直传/Admin 动作。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t01" node --test test/permission-baseline.test.js`；应因 helper/manifest 缺失失败，不把旧业务通过伪装成失败。
- [ ] **Step 3 — 实现采集器并采样。** 在只读固定基线 checkout 上驱动真实 provider+HTTP+MCP SDK；源 pin 为 `a65767d1785245dba07e42aeff9f32f6f686e981` / `c5d2774074dd982355be9a7ada5030886deda592`。合成 3 库和各 Scope 幂集；逐项记录环境 Key、普通 Key、OAuth、Web、无认证、unknown/Compact/batch、CSRF、附件不对称、默认库、transfer fence、public Publish、Git、Admin。验证 secondary-only token 的 primary resource 行，未跑不得猜。
- [ ] **Step 4 — 跑绿及负控。** 同一命令应全部 PASS；允许正控 handler >0，所有拒绝 handler/content-I-O=0。记录被批准前仍 HOLD 的潜在安全差异，不改 oracle 追绿。
- [ ] **Step 5 — 提交。** `git add app/test/permission-baseline.test.js app/test/helpers/permission-baseline-harness.js app/test/fixtures/permission-architecture && git commit -m "test: characterize permission boundaries at c5d27740"`。原始采集输出留该 worktree 的证据目录，不入 Git。

## P1：新模型离线可验，不接执行权

### Task 2：唯一操作目录与边界映射

**首个失败测试：** `catalog_maps_every_native_tool_resource_and_web_route_once`。

**Files:** Create `app/src/authorization/catalog.js`、`app/test/authorization-catalog.test.js`。Read `app/src/config.js:204`、`app/src/scopes.js:15-63`、`app/src/app/access-policy.js:60-67`、T1 manifest。

**Interfaces:** Produce `AUTHORIZATION_CATALOG_VERSION = 1`、`authorizationOperation(id) -> OperationDescriptor|null`、`capabilityForBoundary(boundaryKey) -> CapabilityId|null`。descriptor 字段/额外 ID 精确按 Spec §4，边界键为原工具名、resource URI 或 `<METHOD> <path>`。

- [ ] **Step 1 — 写失败测试。** `assert.deepEqual(catalogToolIds.sort(), TOOL_NAMES.toSorted())`；每个 manifest 边界恰好 1 映射；`delete_file.contentEffect === "mutate"`；Web asset POST→`write_file`；四条 resource 各映射一次（三条 `vault_*_read`→primary，`obsidian://agent/memory-policy`→`agent_memory_policy_read`/instance）；Web 的库列表/切库/新建库各有一行；unknown→null。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t02" node --test test/authorization-catalog.test.js`；应报目录未定义。
- [ ] **Step 3 — 实现目录。** 从基线表确认每项协议 Scope，暂用对照测试约束与旧表一致；不在本步替换现有 enforcement。可授予集合按设计 §4.1：全部 canonical 工具 ID + `vault_*_read` + `vault_create` + `agent_memory_policy_read`；`grantable:false` 只有 `admin_*`、`oauth_*`、`publish_document_read`、`system_git_*` 与派生的 `vault_select`。读取预设包含三个 instance metadata ID。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；从目录移除任一路由行时覆盖测试必须失败。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/catalog.js app/test/authorization-catalog.test.js && git commit -m "feat: define canonical authorization operations"`。

### Task 3：严格 schema、catalogVersion 兼容与旧记录边界 [RF1]

**首个失败测试：** `schema_rejects_duplicate_keys_missing_grants_and_unknown_versions`。

**Files:** Create `app/src/authorization/schema.js`、`app/test/authorization-schema.test.js`。

**Interfaces:** Produce `parseAuthorizationDocument(text) -> {ok:true,document}|{ok:false,code}`、`validateAuthorizationDocument(value) -> AuthorizationDocument`、`serializeAuthorizationDocument(value) -> string`。只接 Spec §5/§8 的精确形状与上限。

- [ ] **Step 1 — 写失败测试。** `assert.equal(parseAuthorizationDocument('{"schemaVersion":1,"schemaVersion":2}').ok,false)`；拒绝账户 grants=null、缺 grants、未知 capability/target、负 epoch、重复 target/主体、非法 id、16 MiB+1；接受 client null、账户 [] 和准确边界值。**catalogVersion**：`catalogVersion: CURRENT-1` 的文档与 envelope 通过校验（旧目录项仍是同一含义）；`catalogVersion: CURRENT+1` 以 `authorization_state_unavailable` 拒绝；未知 capability ID 的文档可解析，但该 capability 上的 `authorize()` 返回 `operation_unknown`，同一主体的其他 capability 不受影响。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t03" node --test test/authorization-schema.test.js`；应报 parser 缺失。
- [ ] **Step 3 — 实现校验。** `catalogVersion` 只允许小于等于当前目录版本；不因目录新增条目拒绝旧文档，也不把未知 ID 当作 allow。parser 必须在 JSON 解析阶段检测重复键；不添加依赖。时间字段调用已有校验/时间逻辑，selector.anyOf 为 1–64 个固定分支，分支字段 null 与 [] 不混同；schema 不补全缺失 grants。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；unknown field 与 duplicate-key 的原始 JSON 反例都要命中，不只测试 JS object。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/schema.js app/test/authorization-schema.test.js && git commit -m "feat: validate unified authorization state"`。

### Task 4：committed store 与故障原子性 [RF4]

**首个失败测试：** `failed_authorization_write_publishes_neither_candidate_nor_success`。

**Files:** Create `app/src/authorization/store.js`、`app/test/authorization-store.test.js`。

**Interfaces:** Produce `createAuthorizationStore({file,io}) -> {ready,snapshot(),replace(expectedRevision,document),repair(document),drain()}`；`snapshot()` 返回冻结的 ready/broken 文档；mutations 返回 `{ok,revision,code}`。

- [ ] **Step 1 — 写失败测试。** 注入 rename/同步失败、并发 CAS 和加载损坏：`assert.deepEqual(store.snapshot(), before)`；`assert.equal(stale.ok,false)`；重启读回仅 ack 的 revision。missing file 在 enforce 是 broken，不自动写 empty。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t04" node --test test/authorization-store.test.js`；应报 store 缺失。
- [ ] **Step 3 — 实现 store。** validate→clone→串行 CAS→同目录 temp/sync/rename→publish；candidate 不污染 committed memory。repair 必须保存原件和 SHA-256，失败保留 broken；非致命审计失败不得改变 deny。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；fixture 捕获 write/rename 调用，核对 0600 和旧文件 bytes；测试关闭 queue/文件句柄。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/store.js app/test/authorization-store.test.js && git commit -m "feat: persist authorization snapshots with CAS"`。

### Task 5：账户、Key、client、token 的无损 grants 导入 [RF1]

**首个失败测试：** `import_token_ceiling_uses_its_own_vault_snapshot_not_current_account`。

**Files:** Create `app/src/authorization/legacy-import.js`、`app/test/authorization-legacy-import.test.js`。Read `app/src/oauth/persistence-methods.js:31-60`、`app/src/oauth/protocol-methods.js:141-165`。

**Interfaces:** Consume T1 已加载归一化快照、T2 catalog。Produce `importLegacyAuthorization({providerSnapshot,policyDocument,timeConstraintsEnabled,catalogVersion}) -> {document,credentialEnvelopes,webEpochs,report}`；policy 子转换由 T6 补齐，本步策略空时可独立完成。

- [ ] **Step 1 — 写失败测试。** 账户现有两库而旧 token 只有 `vault` 时，`assert.equal(importedTokenCanWriteOther,false)`；client 缺授权字段→null，账户/Key缺已验证快照→拒绝导入；保留 expired/revoked/generation/TTL。旧只读 files 仍迁出 `delete_file`，但不能伪装成新只读预设。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t05" node --test test/authorization-legacy-import.test.js`；应报 importer 缺失。
- [ ] **Step 3 — 实现转换。** 对旧 Scope 完整包含 requiredScopes 的操作作精确展开；每库分别生成 grants；instance/resource/Web 特例按 T1 oracle 定义。账户与 Key 的标准读取展开必须包含三个 instance metadata capability（`agent_bootstrap`、`server_info`、`agent_memory_policy_read`），resource capability 只授予 primary 且旧 allowlist 含 primary。输出 envelope 不写源文件；不把旧 fallback 留进新 runtime。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；相同输入序列化逐字节相同；对各 Scope 幂集×库组合与基线 oracle 对比。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/legacy-import.js app/test/authorization-legacy-import.test.js && git commit -m "feat: compile legacy grants into explicit capabilities"`。

### Task 6：时间选择器转换与 OR 保真 [RF2]

**首个失败测试：** `mixed_surface_and_tool_selectors_preserve_OR_without_restricting_web_tool_aliases`。

**Files:** Create `app/src/authorization/legacy-policy-import.js`、`app/test/authorization-policy-import.test.js`。Modify `app/src/authorization/legacy-import.js`。Read `app/src/access-policy/evaluate.js:19-26`、`app/src/access-policy/capabilities.js:80-116`、`app/src/oauth/protocol-methods.js:14-24`。

**Interfaces:** Produce `importLegacyConstraints({policyDocument,boundaries}) -> {constraints,idMap}`；consume T2 descriptor/边界数据。新约束 shape 按 Spec §8，保留原 UUID；idMap 仅记录原 selector 与同一约束的 anyOf 分支索引。

- [ ] **Step 1 — 写失败测试。** 同一旧 policy 的 `surface:web` OR `tool:write_note` 必须覆盖两支；仅 `tool:write_note` 不影响 Web note POST；scope:files 不影响 Web asset POST；OAuth suspend 不消费 code/refresh。`assert.deepEqual(oldVerdicts,newVerdicts)`。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t06" node --test test/authorization-policy-import.test.js`；应报转换函数缺失。
- [ ] **Step 3 — 实现分支转换。** 每条旧 policy 保留为 1 条约束，以 anyOf 分支保留 capability/surface OR；tool/toolset/resource 限定 mcp，直传沿用 mcp CONTROL_TOOL；原UUID/全部其他字段不改。revoke 恰好一个全null分支；512条×每条64个旧selector仍不增加约束条数。休眠坏 policy 也报 migration HOLD，shadow 不影响旧服务。
- [ ] **Step 4 — 跑绿及负控。** 同命令全部 PASS；故意 OR→AND、去 mcp surface、OAuth suspend 生效各使测试红；恢复后绿。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/legacy-policy-import.js app/src/authorization/legacy-import.js app/test/authorization-policy-import.test.js && git commit -m "feat: migrate temporal selectors without changing matches"`。

### Task 7：唯一纯 `authorize()` [RF1/RF2]

**首个失败测试：** `one_account_reads_one_vault_and_writes_the_other_without_name_special_cases`。

**Files:** Create `app/src/authorization/evaluate.js`、`app/test/authorization-evaluate.test.js`。

**Interfaces:** Produce `authorize(request: AuthorizationRequest, snapshot: AuthorizationSnapshot): AuthorizationDecision`，字段、codes、enforcement、顺序严格按 Spec §6。只复用 `app/src/access-policy/time.js` 的时间代数，不调用旧 runtime 裁决。

- [ ] **Step 1 — 写失败测试。** `vault/get_note=true`、`vault/write_note=false`、`example-vault/write_note=true`；换随机合法账户/Vault id 后同结果。断言缺主体、缺 client、伪造 proof、错误 surface/target、未知操作、broken、非法时钟拒绝；grant 不绕过 admission/READ_ONLY；revoke 优先于 Scope，静态拒绝优先于 suspend。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t07" node --test test/authorization-evaluate.test.js`；应报 authorize 缺失。
- [ ] **Step 3 — 实现交集与固定约束。** 主体内并集、多个上限相交；null client 只中性；metadata/control/Publication/system 按可信证明走目录规定边界。错误分类与 payload 不含原始主体/笔记信息。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；覆盖 startsAt/expiresAt ±1ms、UTC/Asia/Shanghai/有 DST 的时区、多个 suspend/revoke、空/损坏状态。比较 T1 全矩阵并保留批准前 HOLD 的差异行。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/evaluate.js app/test/authorization-evaluate.test.js && git commit -m "feat: centralize capability authorization decisions"`。

### Task 8：可信 actor 与请求级 committed snapshot

**首个失败测试：** `runtime_reloads_live_grants_and_never_derives_actor_from_body`。

**Files:** Create `app/src/authorization/actors.js`、`app/src/authorization/runtime.js`、`app/test/authorization-runtime.test.js`。

**Interfaces:** Produce `createAuthorizationRuntime({store,identitySnapshot,vaultSnapshot,publicationSnapshot,deployment,now,mode,legacy}) -> {ready,authorize(request),snapshot(),summary(),drain()}`；`verifiedActor(kind,verification) -> VerifiedActor`。ready 后 authorize 同步读取本进程 committed 投影并返回 Decision，不在热路径重读文件；身份投影含当前 session membership/expiry/epoch。mode 暂为 `legacy|shadow|enforce`，P6 收掉；不接受 caller 的完整 snapshot 或时间。

- [ ] **Step 1 — 写失败测试。** 同 token 第 1 次 allow、committed 缩权后第 2 次 deny；body/_meta 的 subjectIds/proof/nowMs 无效；显式 authMode none 才可建 `deployment-anonymous`。`assert.equal(second.allowed,false)`；同一请求比较快照 revision/时刻一致，无法一致标 inconclusive。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t08" node --test test/authorization-runtime.test.js`；应报 runtime 缺失。
- [ ] **Step 3 — 实现捕获层。** 验证身份状态/epoch/fence 的已提交投影；只缓存 immutable 数据，不缓存 allow；拒绝异常/NaN 时钟。通过依赖注入供 composition root 使用，不建全局服务单例。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；counter 证明每次都调用 T7，store 写失败后的投影仍是旧 ack 状态，且拒绝不会因 audit sink 抛错而放行。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/actors.js app/src/authorization/runtime.js app/test/authorization-runtime.test.js && git commit -m "feat: build trusted authorization request snapshots"`。

## P2：全入口 shadow，旧判定执行一次

### Task 9：影子比较与有界差异记录

**首个失败测试：** `shadow_mismatch_changes_no_response_handler_usage_or_state`。

**Files:** Create `app/src/authorization/shadow.js`、`app/test/authorization-shadow.test.js`。Modify `app/src/authorization/runtime.js`。

**Interfaces:** Produce `observeAuthorization({request,legacyDecision,newDecision,sourceRevision,newRevision},sink) -> void`；只保存 Spec §10 白名单。Produce `shadowSummary() -> {compared,matches,differences,inconclusive,coveredBoundaryKeys}`。

- [ ] **Step 1 — 写失败测试。** 人为 old deny/new allow 与反向差异：`assert.equal(handlerCalls,legacyHandlerCalls)`；HTTP/usage/bytes 不变；sink 抛错不改旧结果。缺快照或缺结果记 inconclusive，不能记 match；不输出路径/token/body。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t09" node --test test/authorization-shadow.test.js`；应报 observer 缺失。
- [ ] **Step 3 — 实现 observer。** 影子候选文档**只在进程内存存在**：启动时由导入器从冻结旧状态生成，旧状态 revision 变化时重建；P4 前不写盘，所以「文件缺失＝broken」只适用于切换之后。sink 为受保护的有界元数据日志；report 包含入口覆盖与时钟/source revision，不保存请求参数。runtime 的 shadow 返回旧 verdict；新 evaluator 只能计算，不能执行第二个 handler。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；强制丢字段/空行时比较器红，audit/storage 抛错仍不扩大权力。
- [ ] **Step 5 — 提交。** `git add app/src/authorization/shadow.js app/src/authorization/runtime.js app/test/authorization-shadow.test.js && git commit -m "feat: observe authorization differences without enforcement"`。

### Task 10：MCP HTTP、工具及 resource 的真实影子接线

**首个失败测试：** `mcp_shadow_covers_native_compact_batch_and_primary_resources`。

**Files:** Create `app/src/authorization/adapters/mcp.js`、`app/test/authorization-mcp-shadow.test.js`。Modify `app/src/auth.js`、`app/src/vault-scope-registrar.js`、`app/src/access-policy/registrar.js`、`app/src/capabilities.js`、`app/server.js`。

**Interfaces:** Produce `mcpAuthorizationRequest({authInfo,name,args,resourceUri,primaryVaultId}) -> AuthorizationRequest`、`mapMcpAuthorizationDenial(decision,phase) -> ProtocolResponse`。只校验/映射，不自行计算 grants。

- [ ] **Step 1 — 写失败测试。** 真实 HTTP+SDK 调原工具/Compact/混合 batch/resource；每行均有影子记录，拒绝内容 I/O=0，响应及 handler 次数与 T1 相同。unknown/非法 Compact group 不产生新 allow。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t10" node --test test/authorization-mcp-shadow.test.js`；应缺少真实 observer 调用。
- [ ] **Step 3 — 接 shadow。** 在旧判定结果旁规范 actor/目标；默认库与 Compact 只解析一次交给两算法。保持 hard revoke HTTP 401、suspend/broken-policy 工具拒绝、Scope→Vault 顺序及 whole-batch 静态拒绝（基线 `app/src/auth.js:276-290`、`app/src/access-policy/registrar.js:137-159`）。本步不删旧规则。
- [ ] **Step 4 — 跑绿。** 同命令和 `DATA_PATH="$PWD/.tmp-permission/t10-matrix" node --test test/multi-vault-auth-matrix.test.js test/compact-v2-real-authz-matrix.test.js test/access-policy-registrar.test.js` 全部 PASS；跳过生产注入的变异必须红。
- [ ] **Step 5 — 提交。** 只 add 本任务 Files 后 `git commit -m "refactor: observe MCP authorization at real boundaries"`；记录所有触及的 request-context 字段未丢失。

### Task 11：Web 主路由、默认选择与错误边界 shadow

**首个失败测试：** `web_shadow_preserves_404_csrf_and_default_vault_selection`。

**Files:** Create `app/src/authorization/adapters/web.js`、`app/test/authorization-web-shadow.test.js`。Modify `app/src/app/routes.js`、`app/src/app/auth-routes.js`、`app/src/app/web-session-resolve.js`、`app/src/app/access-policy.js`。

**Interfaces:** Produce `webAuthorizationRequest({session,routeKey,vaultId}) -> AuthorizationRequest`、`mapWebAuthorizationDenial(decision,{page}) -> {status,body}`；consume T8 runtime、T2 route map。

- [ ] **Step 1 — 写失败测试。** 真 router 遍历壳页、note、切库、列表、主题、Publish 管理及写入路由；缺 session→401、CSRF先拒、深链越库→404；client/account/default/manual 选择对齐 T1，shadow 不改 session revision。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t11" node --test test/authorization-web-shadow.test.js`；应缺 observer 行。
- [ ] **Step 3 — 接 shadow。** 按已解析目标构造输入，包含原路由的稳定错误映射；禁止在 shadow 请求中更新 epoch、grants 或登出策略。新建库的写预设**由 handler 写**（registry 成功后一次 store CAS，给创建者加该库写预设）；CAS 失败报错并让该库对创建者不可见，回退成只读或隐式全权都不允许；shadow 不执行该写入。currentVault 的重复 allowlist 先保留，P3 才移除。
- [ ] **Step 4 — 跑绿。** 同命令和 `DATA_PATH="$PWD/.tmp-permission/t11-default" node --test test/oauth-account-default-vault.test.js test/default-vault.test.js test/web-publish-auth-gate.test.js` 全部 PASS；对照 T1 非空行清单。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: observe Web permission decisions without changing sessions"`。

### Task 12：Web 分拆读取入口完整覆盖

**首个失败测试：** `web_read_shadow_covers_deep_pages_catalog_and_direct_file_reads`。

**Files:** Create `app/test/authorization-web-read-boundaries.test.js`。Modify `app/src/app/base-page.js`、`app/src/app/canvas-page.js`、`app/src/app/base-route.js`、`app/src/app/canvas-route.js`、`app/src/app/note-context.js`、`app/src/app/tags-route.js`、`app/src/app/web-catalog/tree-route.js`、`app/src/app/web-catalog/search-route.js`。

**Interfaces:** Consume T11 `webAuthorizationRequest` 与注入的 runtime；所有已注册边界使用 T2 map，不加第二份 scope/Vault 需求表。

- [ ] **Step 1 — 写失败测试。** 每个列出文件至少 1 个允许和 1 个拒绝的真实 router 行；catalog loader/cache/readBase 未授权计数=0；允许行>0；missing route map 明确 deny 而非空跑。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t12" node --test test/authorization-web-read-boundaries.test.js`；应缺分拆路由影子行。
- [ ] **Step 3 — 逐项接 observer。** 不改查询、索引、错误分类和缓存；target 取 session 或已解码深链，不能在读取正文后才记录拒绝。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；从任一个注册点移走 observer，覆盖测试必须红；不靠纯 helper 测试证明生产接线。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: cover extracted Web read authorization boundaries"`。

### Task 13：Web 分拆 mutation 入口 shadow

**首个失败测试：** `web_mutation_shadow_keeps_asset_and_base_scope_contracts`。

**Files:** Create `app/test/authorization-web-mutation-boundaries.test.js`。Modify `app/src/app/asset-route.js`、`app/src/app/base-patch-route.js`。

**Interfaces:** Consume T11 adapter、T2 map；分别引用 `write_file`、`patch_base`。主路由 folder/note/vault/publish 已由 T11 覆盖。

- [ ] **Step 1 — 写失败测试。** 真 asset POST 保留旧 read+write、不新增 files 要求；Base PATCH 的 CSRF、428、409、read-only 错误族不变。缺权限时目标 bytes/revision/journal 和写计数不变。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t13" node --test test/authorization-web-mutation-boundaries.test.js`；应缺 observer 行。
- [ ] **Step 3 — 接 shadow。** 写前记录判定，不移动 raw parser、CSRF、precondition/预算/只读与异常处理；新 route map 缺项继续拒绝。
- [ ] **Step 4 — 跑绿。** 同命令与 `DATA_PATH="$PWD/.tmp-permission/t13-files" node --test test/web-files-scope.test.js test/web-asset-upload.test.js` 全部 PASS；确认没有用新模型顺手“修正”不对称 Scope。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: observe Web mutation permissions before writes"`。

### Task 14：SSE 重新授权与已排队事件 [RF3]

**首个失败测试：** `sse_shadow_observes_open_heartbeat_and_delivery_without_double_sending`。

**Files:** Create `app/test/authorization-sse.test.js`。Modify `app/src/app/events/heartbeat.js`、`app/src/app/events/sse-broker.js`、`app/src/app/live-events.js`、`app/src/app/routes.js`。

**Interfaces:** Consume `authorization.authorize(request)`；Produce 注入回调 `authorizeSubscriber({session,vaultId}) -> AuthorizationDecision`，mode shadow 仅观察；enforce 拒绝时交既有 broker.close。

- [ ] **Step 1 — 写失败测试。** 用 barrier 而非 sleep 排队事件，再改变已提交 grants/窗口：shadow 发包数等于旧基线；enforce 场景不发送排队正文并关闭。`assert.equal(deniedContentFrames,0)`；心跳/session 失效也关闭。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t14" node --test test/authorization-sse.test.js`；应缺授权回调。
- [ ] **Step 3 — 实现 mode 明确的回调。** broker 每次投递前同步重查绑定库、当前 session membership 与账户 epoch，enforce 不接受开流时缓存的 allow；shadow 不提前关闭。不引入 async deliver 导致事件重排，保留 replay/live 同序、同步重入、close/backpressure/定时器清理，无事件内容进审计。
- [ ] **Step 4 — 跑绿。** 同命令及 `DATA_PATH="$PWD/.tmp-permission/t14-policy" node --test test/access-policy-sse.test.js test/access-policy-web.test.js` 全部 PASS；禁用投递前重查时 enforce 负例必须红。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: revalidate stream permissions at delivery boundaries"`。

### Task 15：直传与有状态 handle [RF3]

**首个失败测试：** `upload_shadow_preserves_bound_vault_after_default_and_grant_changes`。

**Files:** Create `app/test/authorization-upload.test.js`。Modify `app/src/direct-upload.js`。Read `app/test/plan-vault-binding.test.js`、`app/test/multi-vault-handle-binding.test.js`、`app/test/direct-upload-oauth.test.js`。

**Interfaces:** Consume T8/T10；对 `start_direct_upload` 作按库授权投影，再定位 handle，再授权实际绑定库；plan/apply 通过 MCP wrapper 的相同查询不改 domain handle。

- [ ] **Step 1 — 写失败测试。** 在 `vault` 建 plan/upload，切默认到 `example-vault`；后续操作仍绑定原库，跨库 apply/PUT/PATCH拒绝，staged/target bytes 不变。enforce 缩权后后续请求拒绝，shadow 仍按旧快照；失败不消耗额外 handler。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t15" node --test test/authorization-upload.test.js`；应缺实际 handle 目标的影子记录。
- [ ] **Step 3 — 接 observer/新决策回调。** 保留 admission、rate、磁盘、writer lock、offset、digest、超时和原错误处理；不得扫描无权库来定位 handle。长请求不声称能瞬时中止已准入写入。
- [ ] **Step 4 — 跑绿。** 同命令及 `DATA_PATH="$PWD/.tmp-permission/t15-handles" node --test test/plan-vault-binding.test.js test/multi-vault-handle-binding.test.js test/direct-upload-oauth.test.js` 全部 PASS；authorize-before-body 的计数反例有效。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: authorize upload continuations against bound Vaults"`。

### Task 16：匿名 Publish 精确委托，不借发布者权限

**首个失败测试：** `publication_delegation_reads_one_active_record_and_no_other_vault_content`。

**Files:** Create `app/test/authorization-publish.test.js`。Modify `app/src/publish/service.js`、`app/src/app/routes.js`、`app/src/tools/publish.js`。

**Interfaces:** Consume `verifiedActor("publication",{id})`、T7 authorizer；publication snapshot 只带已验证活动记录，不可由 URL 指定 Vault/path。

- [ ] **Step 1 — 写失败测试。** 活动链接可读其记录；同 ID 改路径/库、已 revoke/orphan/invalid、记录不可读都 404；发布者缩权不撤销链接；管理面缺 `manage_publish` 拒绝。断言 `assert.equal(otherContentReads,0)`。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t16" node --test test/authorization-publish.test.js`；应缺正文前的 authorizer。
- [ ] **Step 3 — 接精确委托。** `PublishService.resolve` 在 metadata/lifecycle 校验后、正文前查询统一 authorizer；shadow 仅记录。保留匿名不受账户时间约束、前言过滤、move/delete 永不复活、无正文 Admin 投影。
- [ ] **Step 4 — 跑绿。** 同命令及 `DATA_PATH="$PWD/.tmp-permission/t16-publish" node --test test/publish-http.test.js test/publish-service-lifecycle.test.js test/multi-vault-publish-matrix.test.js` 全部 PASS。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: express public reads as exact publication delegations"`。

### Task 17：Git 用户操作与后台任务身份

**首个失败测试：** `git_worker_uses_system_proof_not_the_last_user_and_never_falls_back_primary`。

**Files:** Create `app/test/authorization-git.test.js`。Modify `app/src/git.js`、`app/src/git-runtime/runtime.js`、`app/src/git-runtime/authorization.js`、`app/src/git-runtime/operations.js`、`app/src/git-runtimes.js`、`app/src/tools/git.js`。Read `app/src/git-runtime/timers.js`；沿用其回调 owner，不造第二个 Git runtime。

**Interfaces:** Consume `verifiedActor("system",{vaultId,task:"commit"|"push"})`；capability 为 `system_git_commit` / `system_git_push`；事实来自 Vault admission 与该库有效 Git 配置。

- [ ] **Step 1 — 写失败测试。** `vault` 只读账户 git_commit/push 拒绝，example-vault 可按 grants 允许；后台任务不借任何请求 token；secondary disabled/pending/broken 时命令计数=0，primary bytes/HEAD 不变。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t17" node --test test/authorization-git.test.js`；应缺 worker 授权调用。
- [ ] **Step 3 — 按真实 worker 接线。** 复用 runtime 的 authorization/queue seam，在排队操作真正开始时查询 T8；自动commit附带autoPush时还须独立通过system_git_push，不能只检查commit。shadow 不改变旧任务行为。保留lease generation、debounce/sweep、config fail-closed、remote 校验、作者和错误报告，不重构 Git domain。
- [ ] **Step 4 — 跑绿。** 同命令及 `DATA_PATH="$PWD/.tmp-permission/t17-git" node --test test/git-runtimes-resolution.test.js test/multi-vault-git-matrix.test.js test/git-sweep.test.js` 全部 PASS；测试证明无其他库命令。
- [ ] **Step 5 — 提交。** add 本任务确认后的实际 Files，`git commit -m "refactor: authorize Git operations with explicit actors"`。

### Task 18：discovery、server_info 与 Admin 只读解释 [RF5]

**首个失败测试：** `projections_query_real_capabilities_without_unioning_token_grants`。

**Files:** Create `app/src/authorization/adapters/admin.js`、`app/test/authorization-projections.test.js`。Modify `app/src/discovery-runtime.js`、`app/src/tools/info.js`、`app/src/admin/catalog.js`、`app/src/admin/grants.js`、`app/src/admin/auth-center-transfer-view.js`。

**Interfaces:** Produce `projectSubjectAuthorization({actor,targets,capabilities,authorization}) -> DecisionProjection[]`；同一函数供管理解释用；discovery 调 T8 后再相交 operator profile/denyTools，公开输出仅可见项。

- [ ] **Step 1 — 写失败测试。** 两个不同 ceiling 的 token 不能被并集显示为单一全权 token；transfer fenced/缺 user 的旧授权仍隐藏；server_info 不泄露无权库。shadow 的 tools/list 与 T1 完全相同；enforce 对某库 deny 的工具即使可发现也调用失败。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t18" node --test test/authorization-projections.test.js`；应缺逐 capability 查询计数。
- [ ] **Step 3 — 接投影。** 不修改 SDK 注册表或 Compact 名/风险分区；Admin 仍只从 catalog 组装数据，page 不访问服务；broken 状态保持 unknown，不能填正常。此阶段不露尚未可写的新 UI。
- [ ] **Step 4 — 跑绿。** 同命令及 `DATA_PATH="$PWD/.tmp-permission/t18-discovery" node --test test/discovery-runtime.test.js test/server-info-default-vault-source.test.js test/authorization-transfer-projection.test.js` 全部 PASS；每项 shadow 覆盖汇总与 T1 manifest 对账。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: derive permission projections from the decision service"`；P2 累计观测满足 Spec §10 后才申请 P3。

## P3：统一调用边界，仍旧 enforcement

### Task 19：受限旧后端与边界清单

**首个失败测试：** `legacy_backend_matches_oracle_with_one_shared_input_snapshot`。

**Files:** Create `app/src/authorization/legacy-evaluate.js`、`app/test/authorization-legacy-backend.test.js`。Modify `app/src/authorization/runtime.js`。

**Interfaces:** Produce `authorizeLegacy(request,snapshot) -> AuthorizationDecision`；仅 runtime 的 legacy/shadow 分支可导入，enforce 不能导入它。snapshot 包含冻结基线所需旧字段，不能从新 grants 反推旧权限。

- [ ] **Step 1 — 写失败测试。** T1 全部 rows 与该后端相同；Scope/Vault/时间拒绝位置与 error family 相同。`assert.deepEqual(comparePermissionRows(baseline,legacyRows),[])`；approve 前的安全差异保持旧判定，不偷修。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t19" node --test test/authorization-legacy-backend.test.js`；应缺旧后端。
- [ ] **Step 3 — 提取旧规则。** 从已读的原分支搬出判定，不改归一化/错误处理；协议映射仍在 adapters。旧后端有删除归属 P6，不能向新 schema 添加旧授权字段。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；旧与新后端输入来自同一捕获时刻，observer 不再重取可变旧 provider 状态。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: isolate the temporary legacy decision backend"`。

### Task 20：MCP 局部判定归零

**首个失败测试：** `mcp_admission_and_execution_use_runtime_and_keep_batch_denial_precedence`。

**Files:** Create `app/test/authorization-mcp-wiring.test.js`。Modify `app/src/auth.js`、`app/src/vault-scope-registrar.js`、`app/src/access-policy/registrar.js`、`app/src/capabilities.js`。

**Interfaces:** Consume T19 runtime、T10 adapter；HTTP admission 只拦 enforcement=transport/static；operation denial 必须交 wrapper 再查，不能执行内容。

- [ ] **Step 1 — 写失败测试。** 用注入 runtime 的 deny 响应证明所有 Key/OAuth/环境 Key 分支都调用它；倒序 batch 仍同拒绝，全部 handler=0；旧局部数组不能绕过它。source guard 只作接线补充，不替代真实 SDK。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t20" node --test test/authorization-mcp-wiring.test.js`；应显示局部判定还在代替 runtime。
- [ ] **Step 3 — 替换判定。** 删除 auth/registrar 的 scope/allowlist/time 决策，保留认证、target schema、runtime 装配、author/context patch 与 response/audit；重复防御只重复调用 runtime。默认 mode 仍 legacy/shadow。
- [ ] **Step 4 — 跑绿。** 同命令、T10 用例及 T1 oracle 全部 PASS；operation deny 不因 HTTP 接纳 transport 而漏进 handler。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: route all MCP decisions through authorization runtime"`。

### Task 21：Web 局部权限判断归零

**首个失败测试：** `every_web_boundary_denies_when_injected_runtime_denies`。

**Files:** Create `app/test/authorization-web-wiring.test.js`。Modify `app/src/app/routes.js`、`app/src/app/access-policy.js`、`app/src/app/base-page.js`、`app/src/app/canvas-page.js`、`app/src/app/base-patch-route.js`、`app/src/app/asset-route.js`、`app/src/app/web-session-resolve.js`、`app/src/app/events/heartbeat.js`。

**Interfaces:** Consume T11/T14 adapters，旧 Web session revision 模式在 P4 marker 前仍按 T1 工作；目标读取与授权分开，所有内容调用用 runtime decision。

- [ ] **Step 1 — 写失败测试。** 遍历 T1 每条 Web 边界；注入 deny 后不得调用 loader/cache/mutator，source Scan 找不到 route 内 `allowedScopes.includes` / `allowedVaults.includes` 判定。session 偏好列表可由授权投影产生，不作为第二权威。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t21" node --test test/authorization-web-wiring.test.js`；应发现现有局部判断。
- [ ] **Step 3 — 替换边界。** currentVault 先查询决策再解析 runtime；把 scope/Vault 决策移除，保留 CSRF/HTTP错误族/只读防御/路径/预算/CAS。其它读取模块复用已注入的 gate/currentVault，不增加新的权限表。
- [ ] **Step 4 — 跑绿。** 同命令及 T11–T14 全部 PASS；新 route map 缺行继续 fail closed；legacy/shadow 与 T1 相同。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: remove Web route-local authorization decisions"`。

### Task 22：直传、Publish、Git、Admin 的最终桥接

**首个失败测试：** `non_router_content_boundaries_cannot_bypass_runtime`。

**Files:** Create `app/test/authorization-domain-wiring.test.js`。Modify `app/src/direct-upload.js`、`app/src/publish/service.js`、`app/src/git.js`、`app/src/admin/catalog.js`、`app/src/admin/router.js`。

**Interfaces:** Consume T15–T18；Admin 控制请求必须由真实 admin verifier 构造 proof，再调用 runtime；existing requireAdmin/requireCsrf 仍先执行。

- [ ] **Step 1 — 写失败测试。** 对 PUT/PATCH、public resolve、Git worker、Admin 控制动作注入拒绝，内容/命令/改权计数均 0；伪造 system/admin proof 经普通请求输入无法生效。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t22" node --test test/authorization-domain-wiring.test.js`；应显示一条以上局部授权旁路。
- [ ] **Step 3 — 删除局部授权分支。** 枚举可授权库必须逐 target 调 runtime，不再直接读 auth.allowedVaults；保留 handle metadata containment、Publish lifecycle、Git config 等 domain 安全控制。P3 完成时统一入口但 enforcement 仍 legacy/shadow。
- [ ] **Step 4 — 跑绿。** 同命令与 T15–T18、T1 oracle 全部 PASS；核对 manifest 每入口至少一个正控与负控，零缺失/重复。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "refactor: close non-router authorization bypasses"`；独立审查 P3 完整 diff 后才进入 P4。

## P4：新数据与全局切换

### Task 23：凭据 ceiling、epoch 和实时刷新 [RF1/RF3]

**首个失败测试：** `refresh_cannot_gain_new_vault_and_permission_edits_do_not_revoke_credentials`。

**Files:** Create `app/test/authorization-credential-freshness.test.js`。Modify `app/src/oauth-provider.js`、`app/src/oauth/protocol-methods.js`、`app/src/oauth/persistence-methods.js`、`app/src/app/auth-routes.js`、`app/src/app/web-session-schema.js`、`app/src/app/web-session-store.js`、`app/src/app/web-session-resolve.js`、`app/src/authorization/actors.js`。

**Interfaces:** Add code/token `authorization:{version:1,catalogVersion:1,subjectEpochs,grantCeiling,protocolScopes}`；protocolScopes仅response/challenge元数据，绝不决定allow；托管 Key 冻结 `authorizationEpoch`；Web store在marker后写`version:2`，记录精确为`{userId,credentialEpoch,csrf,vaultId,createdAt,expiresAt,lastSeenAt}`。保留 OAuth transfer `generation`，不能改用 epoch 代替。

- [ ] **Step 1 — 写失败测试。** 原 refresh 只有 vault，账户加 example-vault 后旋转仍无 example-vault；consent/code 后加库也不能借 exchange 扩权；改权限不改 revokedAt/epoch但下一查询缩权；密码/停用/revoke 增 epoch，恢复启用旧 token/session不复活。旧 Key 不能把当前 epoch反填给自己。缺 envelope在marker后拒绝、marker前仍基线。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t23" node --test test/authorization-credential-freshness.test.js`；enforce 场景应暴露旧 freshness 行为。
- [ ] **Step 3 — 实现 staged schema。** marker前仍读写Web v1，不提前改变失效模型；marker后写v2，migration只转换旧revision/expiry校验仍有效的session。新格式 consent冻结 ceiling、code/refresh/每次调用实时相交；Web 由 updatedAt授权失效切为 credentialEpoch。默认偏好仍独立，不吊销 token。失败先持久化 revoke fence，再改 identity；失败不降低 epoch。
- [ ] **Step 4 — 跑绿。** 同命令及 `DATA_PATH="$PWD/.tmp-permission/t23-regression" node --test test/authorization-transfer-provider.test.js test/authorization-transfer-completion.test.js test/oauth-account-default-vault.test.js test/web-session-restart.test.js` 全部 PASS。并发 refresh/code 与 epoch commit 用 barrier 注入，不用 sleep。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "feat: enforce live authority below frozen credential ceilings"`；此步仍不得单独打开生产 enforce。

### Task 24：迁移工具、marker 与中断恢复 [RF4]

**首个失败测试：** `migration_interruption_cannot_start_partial_enforcement_or_restore_revoked_tokens`。

**Files:** Create `app/src/authorization/migration.js`、`app/scripts/migrate-permissions.mjs`、`app/test/authorization-migration.test.js`、`app/test/authorization-migration-cli.test.js`。

**Interfaces:** Produce `preparePermissionMigration({sourceDir,timeConstraintsEnabled}) -> Promise<MigrationPlan>`、`commitPermissionMigration(plan,{admissionStopped,expectedHashes}) -> Promise<MigrationReceipt>`、`verifyLegacyRollback({document,credentials,legacyCandidate}) -> {ok,code}`。CLI 仅 `--check` / `--apply` + 必需 `--data-path`；apply 必须验证 admissionStopped 与 source hashes。

- [ ] **Step 1 — 写失败测试。** 在每个 prepare/rename/marker/envelope 写点中断：不接半套流量、不自动 seed；source hash改变/坏休眠 policy/超限均拒绝；mixed grants round-trip拒绝。`assert.equal(lossyRollback.ok,false)`；check模式不改任何源 bytes；真实子进程非零退出和timeout都失败。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t24" node --test test/authorization-migration.test.js test/authorization-migration-cli.test.js`；应缺迁移工具。
- [ ] **Step 3 — 实现维护窗口协议。** T5/T6 只转换已验证快照；输出备份、SHA-256、idMap、schema、凭据 envelope、Key epoch、Web epoch及marker；恢复只接受完整集合。无新写入才允许窗口内成组恢复；接客后禁止旧快照覆盖。原 token/密码永不进入 CLI stdout/报告。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；断点重启逐一核对新文档与token/fence一致。执行 dry-run fixture：`DATA_PATH="$PWD/.tmp-permission/t24-cli" node scripts/migrate-permissions.mjs --check --data-path "$PWD/.tmp-permission/t24-cli"`，夹具须由测试准备；无有效源时应明确非零，不能把空目录算验证通过。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "feat: migrate permission state with an irreversible cutover marker"`。

### Task 25：一次全局 enforce 切换与 schema-aware rollback [RF4]

**首个失败测试：** `cutover_switches_every_transport_together_and_marker_rejects_legacy_mode`。

**Files:** Create `app/test/authorization-cutover.test.js`。Modify `app/server.js`、`app/src/server-config.js`、`app/src/authorization/runtime.js`、`docker-compose.yaml`、`.env.example`。

**Interfaces:** Stage flag `AUTHORIZATION_MODE=legacy|shadow|enforce`，marker前默认 legacy；marker后只能 enforce。timeConstraintsEnabled 从迁移文档读，不能由旧 `AUTHZ_ENABLED=false` 绕过 grants/已启用约束。

- [ ] **Step 1 — 写失败测试。** 子进程同时验 MCP/Web/直传/resources/public Publish/Git/Admin修复；marker+legacy、缺新文件、坏文件、缺envelope拒绝接内容；Admin修复/health仍可用且无内容。schema-aware 旧产物读新状态不扩权；普通旧格式降级脚本必须拒绝 mixed grants。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t25" node --test test/authorization-cutover.test.js`；应显示尚无全局启动门。
- [ ] **Step 3 — 接 composition root。** enforce 前等待所有 stores/fences与迁移一致性校验；mode 不能按 transport 分别选择。启动 fail-closed/repair面遵守 Spec §9；优先用已支持新 schema 的恢复产物，不提供“忽略 marker”选项。
- [ ] **Step 4 — 跑绿并申请阶段发布。** 同命令及 T1–T24 变更面集成 PASS；提供完整 shadow覆盖/24小时原始证据和有意差异批准记录。只有 owner 已批 Spec §15 的问题，才在授权环境 apply；记录备份、drift、immutable identity、allow/deny smoke，不因本任务存在自动部署。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "feat: gate unified authorization cutover at process admission"`。P4 接客后不允许关闭新模型回退到旧数据。

### Task 26：Admin 改权/预览/修复服务与真路由（最小编辑器随 P4 上线）[RF5]

**首个失败测试：** `admin_permission_save_is_CAS_guarded_and_cannot_edit_immutable_proofs`。

**Files:** Create `app/src/admin/permissions.js`、`app/src/admin/routes/permissions.js`、`app/test/admin-permissions-http.test.js`。Modify `app/src/admin/router.js`、`app/src/admin/catalog.js`、`app/src/admin/routes/default-vault.js`。

**Interfaces:** Produce `createPermissionAdmin({store,authorization,provider}) -> {readSubject(subjectId),preview({actor,changes,nowMs}),save({subjectId,grants,expectedRevision}),repair({document,confirm})}`；POST `/admin/auth/permissions/save`、`/preview`、`/repair`。默认库保存用可读能力投影验证，不用已移除的 allowlist。

- [ ] **Step 1 — 写失败测试。** 非Admin/缺CSRF拒绝；旧revision409且盘/内存不变；非法cap、配置env Key、admin/system/publication证明不可编辑；预览无写；broken修复必须确认/备份，输出不含正文/秘密。保存 vault只读、example-vault可写后真MCP/Web矩阵正确。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t26" node --test test/admin-permissions-http.test.js`；应路由不存在。
- [ ] **Step 3 — 实现真服务/路由。** 本任务含**最小 grants 编辑器**（切换前必须可用）：服务端表格 主体 × target × capability，含 `instance` 分组（`agent_bootstrap`、`server_info`、`agent_memory_policy_read`），无 JS 可提交。经 requireAdmin→requireCsrf→统一 control授权→schema/CAS；身份新建无权中间态、删/停用先epoch规则保持。失效默认拒绝或明确警告旧token ceiling，不偷偷改偏好。新UI完成前不添加dead CTA。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；跨状态写失败/非JSON/malformed表单经过真实router验证status/Content-Type与无泄漏，不只测service。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "feat: manage capability grants through guarded Admin routes"`。

## P5：让操作者能正确管理模型

### Task 27：预设、生效解释、双语和原型前推（在最小编辑器之上）[RF5]

**首个失败测试：** `account_drawer_edits_two_vault_permissions_with_matching_zh_and_en_keys`。

**Files:** Create `app/src/admin/permission-editor.js`、`app/src/i18n/admin/zh-CN.permissions.js`、`app/src/i18n/admin/en.permissions.js`、`app/test/admin-permissions-view.test.js`。Modify `app/src/admin/pages/accounts.js`、`app/src/admin/pages/keys.js`、`app/src/admin/pages/clients.js`、`app/src/admin/pages/tokens.js`、`app/src/admin/pages/authz.js`、`app/src/admin/pages/authz-editor.js`、`app/src/admin/subject-authz.js`、`app/src/admin/presentation/model.js`、`app/src/i18n/admin/zh-CN.js`、`app/src/i18n/admin/en.js`、`docs/admin-ui-proto/src/4-data.js`、`docs/admin-ui-proto/src/5-render.js`、`docs/admin-ui-proto/src/6-app.js`、`docs/admin-ui-proto/index.html`、`docs/admin-ui-proto/README.md`。

**Interfaces:** Produce `renderPermissionEditor({subject,projection,revision,csrf,action}) -> string`；预设只展开 capability，不存 role；所有page仅消费catalog。`adm.permissions.*` key与placeholder在两目录完全相同；旧 token 合并行保留逐 credential解释。

- [ ] **Step 1 — 写失败测试。** 账户两库不同权限可回显/提交，client null与[]分开；env Key只读；token ceiling不并集冒充。`assert.deepEqual(Object.keys(zhPermissions).sort(),Object.keys(enPermissions).sort())`；新权限提示准确区分“下一请求生效”与“永久撤销”；默认库独立分节保留。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t27" node --test test/admin-permissions-view.test.js test/i18n-admin-catalog.test.js`；应缺editor/keys。任务涉及多个page，但只引入一个共享权限表，串行由一个agent负责，不能并行抢catalog。
- [ ] **Step 3 — 实现SSR与参照。** 复用既有 `.dsec`/表格/表单/技术细节，无JS也能提交；时间selector展示改为canonical operation/target/surface。同步前推原型与`index.html`，两语言文案与placeholder同切片；不改CSP、不新增waiver，不设计新前端框架。
- [ ] **Step 4 — 跑绿。** 同命令全部 PASS；missing en key、placeholder差异必须真红；确认原型也显示已选库与client/token限制，不只更新实现。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "feat: expose per-Vault capabilities and honest permission explanations"`。

### Task 28：Admin 真浏览器、无 JS 与门禁负控 [RF5]

**首个失败测试：** `admin_permissions_browser_roundtrip_and_extra_section_negative_control`。

**Files:** Create `app/test/admin-redo/permissions.test.js`。Modify `app/scripts/proto-parity/seed.mjs`、`app/scripts/proto-parity/spec.mjs`、`app/scripts/web-regression/admin-layout-fixture.mjs`。只在这些夹具/断言补新状态；不得修改 `app/scripts/proto-parity/shape-waivers.mjs` 来放宽。

**Interfaces:** Consume T26 HTTP、T27真实SSR/原型；Produce 按主体/库/语言/JS状态的验收证据，不新增产品接口。

- [ ] **Step 1 — 写失败测试。** 浏览器无JS设置 vault只读、example-vault编辑，回读Admin并实际调用读/写验证；重复en与窄屏/深浅色/键盘，错误表单409不丢草稿。额外注入`div.dsec`必须让骨架门禁红，删一个语言key也红。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t28" node --test test/admin-redo/permissions.test.js`；新场景接入前应缺所需状态/断言，而非零执行算通过。
- [ ] **Step 3 — 补fixture与criterion。** 两侧相同记录、同状态；测server实际form owner/CSRF/noJS提交、ARIA/焦点、320/390px窄屏与桌面。只前推有意设计参照，保留既有全部安全/结构负控。
- [ ] **Step 4 — 跑绿与变异。** `DATA_PATH="$PWD/.tmp-permission/t28-layout" PLAYWRIGHT_MODULE=/usr/local/lib/node_modules/playwright/index.mjs node scripts/run-admin-layout-checks.mjs`，加上上一步node命令及`test/i18n-admin-catalog.test.js`均PASS；负控确实红、恢复后绿。绑定实际执行数、Chromium版本、产物、未证实项，不能沿用历史56/56当本次证据。
- [ ] **Step 5 — 提交。** add 本任务 Files，`git commit -m "test: verify per-Vault Admin permissions and prototype guards"`。无可用指定浏览器时保留HOLD，不装项目内Playwright或给区域豁免。

## P6：删旧权威，保留协议兼容

### Task 29：删除旧运行路径及防回归门

**首个失败测试：** `runtime_has_one_authorizer_and_no_scope_allowlist_or_temporal_bypass`。

**Files:** Create `app/test/authorization-architecture.test.js`。Modify `app/src/scopes.js`、`app/src/capability-catalog.js`、`app/src/capability-policy.js`、`app/src/compact-tools.js`、`app/src/discovery-runtime.js`、`app/src/oauth/persistence-methods.js`、`app/src/oauth-provider.js`、`app/src/authorization/runtime.js`、`app/src/authorization/legacy-import.js`、`app/src/authorization/legacy-policy-import.js`、`app/src/access-policy/capabilities.js`、`app/src/access-policy/runtime.js`、`app/src/access-policy/evaluate.js`、`app/src/access-policy/registrar.js`、`app/src/access-policy/server-wiring.js`、`app/src/app/access-policy.js`、`app/src/admin/capabilities.js`、`app/src/admin/access-policy.js`、`app/src/admin/router.js`、`app/server.js`、`app/src/server-config.js`、`docker-compose.yaml`、`.env.example`、`app/test/scopes.test.js`、`app/test/capability-policy.test.js`、`app/test/compact-tools.test.js`；Remove `app/src/authorization/legacy-evaluate.js` 的生产后端与 `shadow.js` 的生产接线。导入/影子历史测试可留纯离线材料。

**Interfaces:** `scopes.js` 只剩OAuth wire vocabulary/normalization及从canonical目录派生的协议兼容函数，不再输出独立授权表；旧namespace仅importer可用。`time.js`保留。最终 runtime 无mode分支，marker/new schema强制。

- [ ] **Step 1 — 写失败测试。** 架构扫描锁定仅`authorization/evaluate.js`产生permission verdict；原handler不存在`allowedScopes.includes`/`allowedVaults.includes`授权分支；无旧run-time evaluate调用/legacy-mode开关。真实HTTP/MCP负例仍运行，不能用扫描代替行为测试。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t29" node --test test/authorization-architecture.test.js`；应点名剩余旧路径。
- [ ] **Step 3 — 逐caller删桥。** 先`rg`每个将删除export的全部caller，按唯一目录迁移catalog/discovery/Compact/OAuth/Admin及测试；删旧READ_TOOLS/WRITE_TOOLS/FILE_TOOLS授权表，保留wire scope和风险分区的原名称。旧测试转成importer/协议/新模型同一安全断言，不能删除拒绝用例。旧状态字段不再存取，迁移工具拒绝marker后重导入。
- [ ] **Step 4 — 跑绿。** 同命令、T1 oracle/T7/T23/T25/T28及受影响旧测试全PASS；做“回加一个局部allow分支”和“去掉实际生产authorizer”的双负控。逐项解释测试计数变化；代码清单/原型门禁不加任何waiver。
- [ ] **Step 5 — 提交。** 显式add实际修改文件，`git commit -m "refactor: remove superseded permission enforcement paths"`；单一agent完成该机械收口，独立reviewer逐caller读原diff，不自审。

### Task 30：文档、组合验证与移交

**首个失败测试：** `configuration_documents_new_schema_and_schema_aware_rollback`（仅测试新配置/恢复文档契约，不另造发布框架）。

**Files:** Create `app/test/authorization-doc-contract.test.js`。Modify `docs/WEB_AUTH_ARCHITECTURE.md`、`docs/AUTHZ_TIME_WINDOWS.md`、`docs/multi-vault/W0-E-auth-characterization.md`、`docs/USER_CONFIGURATION.md`、`docs/ARCHITECTURE.md`、`docs/QUALITY_AUDIT.md`、`docs/admin/README.md`、`docs/RELEASE_AND_DEPLOY.md`。项目记忆只在获准后通过Obsidian工具更新对应README/专题，并回读；不在仓库提交Vault内容。

**Interfaces:** Produce `HANDOFF`：最终head/tree、状态词、源/目标schema、依赖/环境、命令/计数/原始证据、差异审批、drift/备份/rollback限制、owner待办；独立审查方自读原件并附`audit:`，作者只做self-check。

- [ ] **Step 1 — 写失败测试。** 读取实际配置/认证/发布文档：`assert.match(configurationGuide,/authorization\.json/)`、`assert.match(recoveryGuide,/schema-aware/)`，并检查新schema/default/consent说明及文档内链接存在。人工核对manifest行、未解释差异、执行数、负控和Review Focus全部有原始证据，不发明收据验收框架。
- [ ] **Step 2 — 跑红。** `DATA_PATH="$PWD/.tmp-permission/t30" node --test test/authorization-doc-contract.test.js`；应因旧文档缺新schema/恢复规则失败，不是空跑；不要创建虚构绿收据。
- [ ] **Step 3 — 同步契约文字与验证清单。** 旧历史明确标基线；新鲜度、scope仅协议、资源主库边界、public委托、环境Key、Admin编辑/原型规则和不能无损降级均写清。每项现状结论引实现位置/原始证据，未测写“未证实”。
- [ ] **Step 4 — 最终组合验证。** `DATA_PATH="$PWD/.tmp-permission/t30-check" npm run check`；定向T1–T29集成一次；鉴权共享接口需跑实际全量Node gate时用 `DATA_PATH="$PWD/.tmp-permission/t30-all" node --import ./test/preload-fetch-safe-listen.mjs --test --test-concurrency=1`，记录真实结果/timeout，不能把单文件绿冒充全绿。Admin scene按T28；仅frontend源码确实改变才`npm run build:web`并核生成物。独立reviewer运行风险负控，不机械重复全套。产品/安全失败必须处理，环境缺测如实HOLD。
- [ ] **Step 5 — 提交并移交。** 显式add本任务Files，`git commit -m "docs: record unified permission operations and recovery contract"`。链接设计/计划供owner审阅；执行方法须由owner确认。合并、发布与部署各按已有授权范围执行，不从测试通过自行推导授权。

## 计划自检与批准门

- 覆盖：Spec §§4–8→T2–T8/T23；§9→T3/T4/T23–T26；§10→T1/T9–T25；§11→T1/各真实边界/T29；§12→T18/T26–T28；§13→T24/T25/T30；§14的非目标保持不动。
- 每项从具名失败测试开始，红→最小实现→绿→commit；验证命令均有隔离DATA_PATH，正负控非空。旧行为描述以设计基线的`file:line`为依据，不把计划预期当现有事实。
- 类型：所有adapter只构造Spec的AuthorizationRequest；最终只有T7算法返回AuthorizationDecision；新增ceiling/epoch/property名称在所有caller一致。额外模块内部拆分可由实施者决定，但必须先更新Files/Interfaces，不能现场猜授权语义。
- 阶段正确性：P2/P3仅旧判定，P4全局切换，P5才开放新编辑；P6无永久双写/回退。任何无法证明等价/无损回滚的格子停在当前可工作阶段，不给豁免。
- 当前未执行任何步骤；没有builder独立验收或owner批准记录。作者的可实施性检查不等于审查GO。
