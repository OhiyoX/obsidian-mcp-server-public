# 统一权限架构设计

- 日期：2026-11-05
- 状态：**owner 已批准（2026-11-05）；尚未写任何实现代码**。批准的三个决定见 §15。
- 事实基线：commit `a65767d1785245dba07e42aeff9f32f6f686e981`，tree `c5d2774074dd982355be9a7ada5030886deda592`。以下 `file:line` 均指该基线，不指未来实现。
- 上一层设计：[账号级默认 Vault](2026-11-05-account-default-vault-design.md)。保留其偏好解析顺序，不把默认库变成授权。
- 计划：[permission-architecture](../plans/2026-11-05-permission-architecture.md)。本轮只写这两份文档，不写产品代码、测试或配置。

## 1. 意图、决定与验收目标

owner 要求「权限架构需要好好梳理一下重构」，并建议「一步到位，长期收益」。**选择 A：一种 capability 词汇、一个授权决策入口**（owner 批准）。批准覆盖本文的数据模型、生效语义、行为差异与切换代价；不覆盖任何实现结果的验收——那要按 §11 逐阶段证明。

第一个产品查询是：同一账户在 `vault` 只读，在 `example-vault` 可以写。它必须是普通的 `(subject, capability, target)` 查询，不能是用户名、Vault 名或路由中的特判。

目标：

1. 账户、客户端、Key、token、Web 会话共享同一种授权数据；各自仍有独立认证凭据。
2. 所有内容入口及 Admin 的生效预览只问 `authorize()`，不再各自组合 Scope、allowlist、时间窗。
3. 缩权在下一次授权查询生效；OAuth 原有 consent 上限不因账户扩权自动扩大。
4. 用冻结基线、真实边界夹具、影子比较和负控证明迁移；所有有意差异逐项批准，不以“重构”掩盖。
5. 分阶段独立交付；任何阶段不得出现部分入口使用新权限、其他入口继续放宽的状态。

## 2. 当前事实与纠偏

| 事实 | 原始依据 |
| --- | --- |
| 三个 OAuth Scope 是 `obsidian.read` / `obsidian.write` / `obsidian.files`；所有工具先要求 read，再叠加附加 Scope | `app/src/scopes.js:3-7`、`app/src/scopes.js:53-57` |
| `READ_TOOLS` 包含 `write_note`、`manage_tags`、`move_note`、`delete_note`；它不是“只读工具集” | `app/src/scopes.js:15-28`；附加 write 来自 `app/src/scopes.js:30-38` |
| HTTP 层按请求求 Scope、按批次成员求 Vault，并在 Key/OAuth 两条分支分别检查 | `app/src/auth.js:60-89`、`app/src/auth.js:276-290`、`app/src/auth.js:312-325` |
| registrar 又检查 `allowedVaults`；Web 页面、当前库、切库、写路由也有局部检查 | `app/src/vault-scope-registrar.js:90-97`、`app/src/vault-scope-registrar.js:151-165`、`app/src/app/routes.js:141`、`app/src/app/routes.js:192-196`、`app/src/app/routes.js:247-260`、`app/src/app/routes.js:468-471`、`app/src/app/routes.js:518-522` |
| 时间窗已与 Scope/catalog 接线，并非完全“不说话”；缺的是统一的按库授权模型与最终决策入口 | `app/src/access-policy/capabilities.js:12-15`、`app/src/access-policy/capabilities.js:80-116`；另一个裁决点在 `app/src/access-policy/registrar.js:137-159` |
| 时间策略是只能收紧的约束；多个匹配策略相交，revoke 优先；broken 不是 empty | `app/src/access-policy/evaluate.js:19-26`、`app/src/access-policy/evaluate.js:38-66` |
| token 存的是 `scopes`，不是 `allowedScopes`；账户/Key 才存 `allowedScopes`；token 同时冻结 `allowedVaults` | `app/src/oauth/protocol-methods.js:141-152`、`app/src/oauth-provider.js:135-136`、`app/src/oauth-provider.js:215-216` |
| OAuth token 验证取记录里的 Scope/Vault；默认库则每次读 client → account | `app/src/oauth/protocol-methods.js:235-247` |
| 授权码交换检查当前账户；refresh 沿用旧 grant 的 Vault，不重新检查账户 ceiling | `app/src/oauth/protocol-methods.js:158-165`、`app/src/oauth/protocol-methods.js:191-192`、`app/src/oauth/protocol-methods.js:203-231` |
| 账户新增权限可以保留旧 grant；缩权通过撤销 grant 生效，并关闭匹配客户端会话 | `app/src/admin/grants.js:93-100`、`app/src/admin/router.js:441-461` |
| **Web 已经是第三种情况**：每次读账户权限；`updatedAt` 不符就撤销会话；不是 token 的冻结模型 | `app/src/app/web-session-resolve.js:29-47`、`app/src/oauth-provider.js:305-310` |
| 默认库只是偏好；MCP 显式参数优先；Web 登录取账户默认，手选失效再取允许的账户默认或首库 | `app/src/default-vault.js:3-6`、`app/src/app/auth-routes.js:73-80`、`app/src/app/web-session-resolve.js:43-46` |
| 环境 Key 不一定只到 primary：primary 加 `API_KEY_VAULTS`；Admin 同源但不可编辑 | `app/src/auth.js:221-227`、`app/src/admin/catalog.js:21-37` |
| 不能按名字推断旧附件权限：`delete_file` 是 read+files，`write_file` 是 read+write；Web 上传检查 write | `app/src/scopes.js:30-44`、`app/src/capability-catalog.js:104-113`、`app/src/app/asset-route.js:42-45` |
| discovery 不是授权；Compact 解包后仍调用原工具；还有独立 profile/denyTools 限制 | `app/src/discovery-runtime.js:164-190`、`app/src/compact-tools.js:158-170` |
| 直传在 PUT/PATCH 上另查 Scope、时间窗及有权库中的 handle | `app/src/direct-upload.js:349-369`、`app/src/direct-upload.js:479-517`、`app/src/direct-upload.js:610-657` |
| Publish 匿名读取绑定记录自己的 Vault/path，不是发布者当前 allowlist；管理读取与匿名读取不能混用 | `app/src/app/routes.js:177-185`、`app/src/publish/service.js:303-337` |
| MCP Vault resources 是 primary-only，registrar 不给它们做 Vault 选择 | `app/src/resources.js:16-51`、`app/src/vault-scope-registrar.js:176-185` |
| Git 工具使用所选 Vault 的 runtime；Admin 由独立 session + CSRF 保护 | `app/src/tools/git.js:19-30`、`app/src/admin/router.js:140-154`、`app/src/admin/router.js:245-250` |

**数量口径**：题述“约 74 处 write 检查”未证实，不能作为验收分母。基线 `rg -n 'obsidian.write' app/src` 得到 64 个匹配行；`rg -n 'allowedVaults' app/src` 得到 112 个匹配行、`rg -o` 得到 139 个出现。这是文本统计，不等于独立决策点。上述文件中的真实分支及 Phase 0 生成的入口清单才是迁移分母。

既有文档仅作有日期的背景：`docs/WEB_AUTH_ARCHITECTURE.md:29-41` 描述 durable Web 会话；`docs/AUTHZ_TIME_WINDOWS.md:10-35` 描述约束语义；`docs/multi-vault/W0-E-auth-characterization.md:19-38` 是 Wave C 后态表，其后历史段不能冒充现状；`docs/USER_CONFIGURATION.md:274-285` 描述默认库规则。发现旧文字与源码不符时，记录差异，不默默选择较宽松的一项。

## 3. Approaches

| 方案 | 收益 | 代价与风险 | 决定 |
| --- | --- | --- | --- |
| **A：操作 capability + target 的统一授权模型；唯一 `authorize()`** | 按库、按操作表达权限；权限解释、时间约束、token ceiling、Admin 同源；之后新增能力不必再添一种权限语言 | 要迁移持久化、协议边界和全部入口；必须先做等价证明与可恢复切换 | **选择**。一步到位指终态与数据模型，不指一次大爆炸上线 |
| B：保留 Scope + `allowedVaults`，只加一个 resolver | 改动较小；可以暂时集中现有重复代码 | Scope×Vault 仍是矩形；要表达每库不同读写就新增 sidecar/特判；时间选择器和 Admin 继续翻译三种语言 | 不选。只能改善接线，不能解决核心表达能力 |
| C：完整策略引擎，例如通用 RBAC/ABAC、表达式或外部 PDP | 未来路径、组织、继承等表达力最大 | 当前没有这些需求；引入规则语言、优先级、缓存与引擎运维，增加审计和迁移面 | 不选。不为未来未要求的需求增加解释器或依赖 |

A 不引入通用策略 DSL。允许项只有显式 capability grants；额外限制只有固定结构的时间窗。`toolset:`、`surface:` 等旧选择器只在导入器出现，不能继续成为第二套授权入口。

## 4. 一种 capability 词汇

### 4.1 原子与目录

**我的判断**：沿用现有 canonical tool 名作为操作 capability ID，例如 `get_note`、`write_note`、`delete_file`、`git_push`、`manage_publish`。不再发明一套与工具平行的领域命名。Web 与 MCP 执行同一动作就引用同一个 ID。

新增 `app/src/authorization/catalog.js` 为唯一目录，导出 `AUTHORIZATION_CATALOG_VERSION = 1` 和 `authorizationOperation(id)`。描述符为：

```text
{ id: CapabilityId, plane: "content"|"metadata"|"control",
  targetKind: "vault"|"instance"|"publication", grantable: boolean,
  contentEffect: "read"|"mutate", oauthScopes: string[],
  surfaces: ("mcp"|"web"|"oauth"|"admin"|"publish"|"system")[] }
```

- 工具 ID 集合精确覆盖 `TOOL_NAMES`；不能依赖 annotations 推断权限。`oauthScopes` 是**协议兼容映射**，不是最终授权检查。
- 额外固定 ID：`vault_index_read`、`vault_tags_read`、`vault_graph_read`、`vault_create`、`vault_select`、`vault_list_read`、`session_bootstrap`、`agent_memory_policy_read`、`publish_document_read`、`oauth_authorize`、`oauth_code_exchange`、`oauth_refresh`、`admin_metadata_read`、`admin_authorization_manage`、`admin_publish_revoke`、`admin_git_manage`、`system_git_commit`、`system_git_push`。
- `vault_*_read` 对应三条 primary-only resource URI；`agent_memory_policy_read` 对应 `obsidian://agent/memory-policy`，`targetKind:"instance"`（该 URI 不读任何 Vault 内容）；不把一次工具选择记进 resource 的目标。
- `vault_select` 是每库 read 派生的会话动作，不授予写入；`vault_create` 是单独的 instance grant。已有账户的旧 read+write 会迁移出 create，以保留行为；新建每库 write 不隐含创建其他库。
- **可授予集合（builder-check 后定稿）**：`grantable:true` 包括全部 canonical 工具 ID、`vault_*_read`、`vault_create`、`agent_memory_policy_read`。`grantable:false` 只有两类：`admin_*`、`oauth_*`、`publish_document_read`、`system_git_*` 这类由受信 verifier 注入的控制操作，以及 `vault_select`（由每库 read 派生，不单独授予）。schema 必须接受导入器可能产出的每一个可授予 ID；把可授予项误标为不可授予会让导入器与每次 resource 读取都被拒。
- `server_info`、`agent_bootstrap`、`agent_memory_policy_read` 是 instance metadata；不授予任何 Vault 内容权限，但**账户与 Key 的标准读取预设包含这三项**——否则迁移后的新身份会丢掉今天可用的握手与策略面。编辑器把它们显示为 `instance` 分组。
- `contentEffect:mutate` 包括内容更改/删除、附件上传/删除、发布状态变更、Git commit/pull/push。计划预览不算内容写入，apply 算。`delete_file` 必须归为 mutate，即使它旧时不要求 write Scope。
- 只读/编辑/全部是**编辑器预设**，不存 role，也不参与裁决。只读预设只展开 `contentEffect:read` 的 Vault grants 加 instance 读取，不含 Publish 管理或 Git mutation；新增 capability 不自动进入旧 grants。
- **新建 Vault 的授权由 handler 写，不由 `authorize()` 写**：registry 写入成功后，创建者的 handler 在一次 store CAS 里给创建者加上该库的写预设（该库的 read 操作 + mutate 操作），与今天「新建即进 `allowedVaults`」等价。CAS 失败时报错并让该库对创建者不可见，不回退成只读或隐式全权。

### 4.2 边界映射

| 入口动作 | capability / target |
| --- | --- |
| MCP 原工具；Compact action | 原工具名 / 已解析 Vault；Compact 必须先严格校验 group、action、params |
| Web note 读取、写入；Base raw/query/patch；Canvas 读取 | `get_note`、`write_note`；`get_base` / `query_base` / `patch_base`；`get_canvas` / 当前或 URL 显式库 |
| Web 附件 GET/POST；folder POST；search/tree/tags/context | `get_file` / `write_file`；`manage_folders`；`search_notes` / `list_files` / `list_tags` / `get_note_context` / 当前库 |
| Web Publish status/manage | `get_publish_status` / `manage_publish` / 当前库 |
| Web Vault 列表 | `vault_list_read` / instance；只回答「哪些库可读」，**在时间平面内**（旧 `readGate` 就是门） |
| Web 切库、会话身份 | `vault_select` / 会话；**不在时间平面内**（P1 定稿，见 §4.1a） |
| Web 新建库 | `vault_create` + 新建后由 handler 写该库写预设 |
| Web 主题、壳页面和 SSE | 内容衍生读取引用 `get_note` / 所属库；不把公开登录样式路由当任意库内容接口 |
| 公开登录页、登出、主题资源、语言页、壳页面 | `session_bootstrap` / instance，**不可授予**，**不在时间平面内**：§9 要求公开页面不受账户时间策略约束 |
| 四条 MCP resource | `vault_index_read` / `vault_tags_read` / `vault_graph_read` / primary；`obsidian://agent/memory-policy` → `agent_memory_policy_read` / instance |
| 直传 PUT/PATCH | `start_direct_upload` / handle 绑定的库；先对可授权库作无内容投影，再查 handle，再对实际绑定库授权 |
| 匿名 Publish | `publish_document_read` / `{kind:"publication", id}`；委托仅限已加载的活动记录精确 Vault/path |

**§4.1a 时间平面豁免（P1 定稿，2026-11-05）**

- 豁免是**操作的属性**，不是请求的属性：`TEMPORAL_PLANE_EXEMPT_OPERATIONS = ["vault_select", "session_bootstrap", "oauth_client_register", "oauth_token_revoke"]`。登记与撤销在账户主体存在之前发生、作用于 client/token 存储，任何账户的时间窗都不该挡住它们；consent / code exchange / refresh 仍受旧的「仅 revoke 生效」规则约束。纯函数与 runtime 只读操作 id；请求里不接受任何 `boundary` 之类字段，因此调用方无法把「切库」的豁免贴到「库列表」上。
- 一个操作**不得同时持有豁免边界与非豁免边界**；目录测试宁可红，也不许合并。
- 豁免的只可能是身份/壳操作：均为 `grantable:false` 或 `targetKind:"instance"` 且 `contentEffect:"read"`，不承载任何库内容。
- **instance 元数据操作在时间平面之外**：`agent_bootstrap`、`server_info`、`agent_memory_policy_read` 与 `session_bootstrap` 同列（owner 2026-11-05 裁决）。工具层本来就在暂停期间绕过它们（A-07），所以旧判定一直是 allow；把它们留在平面内会让新模型在暂停期间对 `server_info` 回答 403，并制造一条假的影子差异。这三个操作不承载任何库内容，因此符合上一行。
- 传入的边界键若与操作 id 不符，一律按未豁免处理（fail closed）。
| Git 用户调用 / 自动任务 | `git_*` / 所选库；`system_git_*` / 已准入且启用相应任务的库 |
| Admin 目录/预览/改权/发布撤销/Git 设置 | 控制操作各用 `admin_*`；预览目标身份的具体 capability 仍调用同一个 `authorize()` |

Web 旧 Scope 映射可能与同类 MCP 不同的行必须在 Phase 0 逐条列出；例如 Web asset POST 使用 `write_file`，其基线也是 read+write，不顺手加 files。未发现准确对应操作时不得猜测，阻断该入口切换并补目录行/夹具。

## 5. 一个存储模型与主体组合

### 5.1 文件与精确形状

新增单写者文件 `<DATA_PATH>/authorization.json`，目录 `0700`、文件 `0600`。认证、密码、token digest、默认库偏好仍留其原有存储；权限文件不放凭据秘密。

```json
{
  "schemaVersion": 1,
  "catalogVersion": 1,
  "revision": 1,
  "timeConstraintsEnabled": false,
  "subjects": {
    "oauth-user:u1": {
      "credentialEpoch": 0,
      "grants": [
        {"target":{"kind":"vault","vaultId":"vault"},"capabilities":["get_note","search_notes"]},
        {"target":{"kind":"vault","vaultId":"example-vault"},"capabilities":["get_note","search_notes","write_note"]},
        {"target":{"kind":"instance"},"capabilities":["agent_bootstrap","server_info"]}
      ]
    },
    "oauth-client:c1": {"credentialEpoch":0,"grants":null}
  },
  "constraints": []
}
```

此 JSON 是形状示例，**不是完整只读预设**，不能据此只迁移两个读操作。

类型规则：

- `SubjectId` 继续使用 `oauth-user:<id>`、`oauth-client:<id>`、`api-key:<id>`；环境 Key 是 `api-key:configured-env`。id 来自已验证身份，绝不用用户名、显示名、token 或秘密 hash。
- `Grant = {target: {kind:"vault",vaultId:string}|{kind:"instance"}, capabilities: CapabilityId[]}`。列表去重、稳定排序；同一 target 只存一行，capability 必须已知、grantable 且 targetKind 匹配。
- `grants: []` = 无权。只有 OAuth client 允许 `grants:null`，表示“客户端不额外收紧”，**不是授予一切**；单独 client 不因此获得内容权。
- `credentialEpoch` 是非负安全整数。改权限不增 epoch；密码重置、停用、显式全撤销先持久化 epoch 增量。删除保留 `{credentialEpoch:next,grants:[]}` tombstone，避免重用 ID 复活旧授权。
- **`catalogVersion` 兼容规则（builder-check 后定稿）**：文档与 token envelope 的 `catalogVersion` 可以小于当前目录版本——目录只增不改既有 ID 的含义，因此**增加目录项不要求全局重新 consent**。未知 capability ID 在该操作被请求时拒绝（`operation_unknown`），不影响同一主体的其他操作。版本**大于**当前目录则 fail closed（`authorization_state_unavailable`），不解释未知语义。`schemaVersion` 与 `revision` 仍精确校验。
- `revision`、`schemaVersion` 必须精确校验；unknown key、重复主体/目标/capability、非法 id、非法 epoch、超限、断引用均拒绝。JSON 重复键必须在解析时发现，不能让 `JSON.parse` 静默覆盖安全字段。
- 冻结上限：文件 16 MiB；主体 10,000；每主体 target 65（64 个 Vault + instance）；每行 capability 不超过当版目录总数；constraints 512；每条 subjects 32、selector 分支 64、每分支 capability 128。现有时间窗的 weekly/dateRanges 各 64、label 120、timezone 80 上限不扩大。超限不截断。
- 环境 Key、Admin session、Publish link、system worker 不落成可编辑 grants；runtime 以相同 `Grant` 形状作**只读投影**。认证类型固定其最大能力，不能伪装成账户或 Key。

### 5.2 身份如何携带权限

| 身份 | 可信引用、权限来源及组合 |
| --- | --- |
| OAuth 账户 | identity record 只引用 `oauth-user:<id>`；其 grants 是实时账户上限 |
| OAuth client + user token | 实时账户 grants ∩ 实时 client ceiling（null 是中性）∩ token 的冻结 `grantCeiling`；另检查两方 epoch、audience、expiry、revokedAt、transfer generation |
| 历史无 userId 的 OAuth token | 保留自身迁移后的冻结 ceiling，并相交 client ceiling；不借当前任意账户补权；不新增 client_credentials 流程 |
| 托管 API Key | 根据已验证 keyId 实时取对应 grants；认证记录冻结 `authorizationEpoch`，必须等于主体当前 epoch；Key 无账户归属，不继承账户默认或权限 |
| 环境 Key | 启动时由 `API_KEY` 是否存在及 primary + `API_KEY_VAULTS` 编译全部旧工具能力；只读展示，配置变更仍需重启，不在 JSON 偷增可变授权 |
| Web session | 只引用账户和登录时的 `credentialEpoch`；不复制 grants，不设隐式 OAuth client，不被冻结的 `updatedAt` 同时承担偏好与权限失效 |
| Admin / 匿名 Publish / system | 可信 verifier 注入的受限操作上下文；不能出现在普通主体编辑表单或 client 请求参数里 |
| 显式 no-auth 部署 | 仅 composition root 在 `authMode === "none"` 时注入 `deployment-anonymous` actor；投影已准入库的旧全部能力，不接受外部伪造或缺 actor 自动放行 |

每个主体内部 grants 作并集；有多个上限时取交集；constraints 只能再扣减。缺失账户、Key、client 或必需 envelope 都拒绝，不能把缺失 client 当 `grants:null`。

### 5.3 旧记录的默认值

仅在迁移阶段，通过**基线 provider 已验证、已归一化**的快照导入：账户/Key 的 `allowedScopes × allowedVaults` 编译成显式操作 grants；旧 client 缺字段导入 `grants:null, credentialEpoch:0`；旧 token 缺 envelope 导入其自身 `scopes × allowedVaults`；旧 Web session epoch 导入 0，同时保留原账户 revision 校验所得有效性。已失效的 session 不迁活。

基线 load 对 token 缺 Vault 使用用户/primary fallback，对账户/Key 作归一化（`app/src/oauth/persistence-methods.js:31-60`）；只能在这个冻结导入步骤复现，不能在新格式运行时继续 fallback。原文件空列表/缺字段导致何种旧归一化须由夹具证明，不把推测当默认全权。

**切换后**：主体缺记录 = 拒绝；grants 缺字段 = broken；`[]` = deny；新 client 只能通过受信注册事务显式建 `null` ceiling。新格式无 envelope、版本未知或权限文件缺失都 fail closed，不再自动导入旧字段。

## 6. 一个决策入口

新增纯函数，所有 adapter 只能调用它，不得自行检查权限数组：

```text
authorize(request: AuthorizationRequest, snapshot: AuthorizationSnapshot): AuthorizationDecision

AuthorizationRequest = {
  actor: VerifiedActor,
  capability: CapabilityId,
  target: {kind:"vault",vaultId:string}|{kind:"instance"}|{kind:"publication",id:string},
  surface: "mcp"|"web"|"oauth"|"admin"|"publish"|"system",
  nowMs: number
}
AuthorizationDecision = {
  allowed: boolean,
  code: "allowed"|"invalid_credential"|"insufficient_scope"|"capability_denied"|
        "vault_access_denied"|"vault_id_invalid"|"vault_unavailable"|
        "outside_authorized_window"|"authorization_policy_unavailable"|
        "authorization_state_unavailable"|"operation_unknown",
  enforcement: "transport"|"operation",
  mode: null|"suspend"|"revoke",
  revision: number|null,
  matchedConstraintIds: string[],
  denyConstraintId: string|null,
  nextAllowedAt: string|null
}
```

- `VerifiedActor` 是 adapter 内部由认证结果构造的不可由 HTTP body/_meta 指定的对象：`{kind,subjectIds,credentialId,credentialEpochs,grantCeiling,audience,expiresAt,revoked,transferGeneration,proof}`。`kind` 只允许 `oauth` / `api-key` / `environment-key` / `web-session` / `admin-session` / `publication` / `system` / `deployment-anonymous`；subjectIds 为 SubjectId 数组，credentialId 为非秘密 string，credentialEpochs 为 SubjectId→整数映射，grantCeiling 为 Grant[] 或 null，audience 为 string 或 null，expiresAt 为 epoch-ms 或 null，revoked 为 boolean，transferGeneration 为整数或 null。`proof` 为 null 或严格区分的 `{kind:"admin-session"}` / `{kind:"publication",id:string}` / `{kind:"system",vaultId:string,task:"commit"|"push"}` / `{kind:"deployment-anonymous"}`。证明只能由相应 verifier 注入，字段与 actor.kind 不符即拒绝。不把原 token 或 cookie 传给纯函数。
- **身份投影形状（P1 交接，P2 wiring 必须先落实）**：`{subjects: {subjectId: {credentialEpoch, disabled}}, sessions: {credentialId: {active, expiresAt, subjectId}}}`。`credentialEpoch` 缺失时两侧都按 0 合成；`sessions` 缺失会让每个 Web 会话被拒，所以 P2 适配器必须同时填 actor 与投影。
- `system` 与 `admin-session` **不得携带主体**：后台任务与控制台不是人的凭据；否则一个账户的时间窗能停掉后台提交，一次用户 revoke 会把控制台变成传输级拒绝。构造器与纯函数两层都拒绝。
- `AuthorizationSnapshot = {status:"ready"|"broken", document, identities, vaultAdmissions, publication|null, deployment}`。身份状态、transfer fence、registry admission、READ_ONLY/Git 启用事实来自一个请求捕获的已提交投影；不在纯函数做 I/O。
- 生产注入的 `authorization.authorize(request)` 只是同步捕获本进程 committed snapshot、注入时钟并调用上述纯函数的薄壳；不是第二个算法。session membership/expiry 也在身份投影中实时校验，避免注销后仍用旧开流身份。Admin 预览可注入时间，普通客户端不能决定 `nowMs`。
- 顺序：可信身份/域/有效期/永久 fence → principal-wide revoke → 已知 capability、surface/target 形状 → 冻结 ceiling/实时 grants → 目标准入与可用性 → 时间约束 → 部署只读/运行能力限制。grant 不能使不存在或未准入的 Vault 可用。
- 拒绝在 Vault stat、正文、缓存、索引、附件、Git 命令或 mutation 之前；registry/授权/handle 的受保护元数据读取不等于允许内容 I/O。返回值不含笔记路径/标题/revision/body、秘密或完整策略。
- `insufficient_scope` 只是 OAuth/旧 Key 的兼容错误：导入器/协议 ceiling 的来源标记可解释 capability 缺口；不能用 Scope 再算一遍 allow。每库操作缺权用 `capability_denied`，整库无 grant 用 `vault_access_denied`。

### 6.1 调用方式与接线边界

1. **MCP HTTP**：认证后，解包每个 Compact 成员，逐成员解析目标、调用 `authorize()`；全批次 credential/冻结 ceiling/静态 grant 或 Vault 拒绝仍先拒整个请求，handler 全部为 0。保留基线“Scope 不足先于越库”的兼容错误优先级，不依数组成员顺序选较宽松结果。
2. **MCP registrar**：在 handler 前再次调用同一个 `authorize()`，然后才解析内容 runtime 和 patch request context。重复调用是实时防御，不是复制规则。resource 显式传 primary。
3. **时间拒绝位置**：revoke 的 `enforcement:"transport"` 映射旧 401；suspend/broken-policy 的 `enforcement:"operation"` 不变成批次 HTTP 403，而由每条工具/resource wrapper 返回原内容拒绝。HTTP 接纳 transport 不代表允许内容；wrapper 永远重查，不消费一次旧 allow 凭证。
4. **Web**：先 session，写请求再 CSRF，再从 URL/session 解析目标，再授权，最后 handler；页面隐藏为 404 的拒绝继续由 adapter 映射。所有注册路由都有显式目录映射；未知写路由继续拒绝。SSE 在打开、心跳与投递事件前重查绑定库，拒绝即关闭，不发送队列内容。
5. **直传/plan/apply/upload**：每个后续请求重新授权实际绑定库。默认库更改不能重绑 planId/uploadId；查不到或越权 handle 不回退 primary。长 PUT 的授权点是本次请求 admission，不宣称能中止已开始写入的所有字节。
6. **Publish**：管理操作走账户/Key 的 capability；匿名 `resolve` 在读取正文前用活动记录构造精确 publication 委托并调用 `authorize()`。不追溯相交发布者当前账户权限，不把公开链接变成整个 Vault 的读权；生命周期失效仍 404。
7. **Git**：用户工具经同一 authorizer 后进原 runtime；后台 sweep/autoCommit/autoPush 用 `system` actor 和配置投影，绝不借最后一个用户的 token。权限不替代 Git 配置或 Vault admission。
8. **Admin/discovery/server_info**：控制动作有独立 admin verifier；`catalog.js` 对目标主体的每个操作用 `authorize()` 作投影。tools/list 取“至少一个可执行目标”的能力投影，再相交既有 operator discovery 配置；实际调用仍重查。Admin 不从 token 的 scope/Vault 并集推断权限。

## 7. Freshness：冻结什么、实时读什么

规则：**用户曾同意交给某凭据的上限被冻结；操作者现在允许什么实时读；身份撤销用永久 fence；路由偏好实时读但不是授权。**

OAuth code、access/refresh token 新增同形 `authorization`：

```text
{version:1, catalogVersion:1,
 subjectEpochs: Record<SubjectId, nonnegative-safe-integer>,
 grantCeiling: Grant[], protocolScopes: string[]}
```

- code 在 consent 时冻结 ceiling；code exchange 再与实时账户/client 相交。access/refresh 不得比 code 更宽。`protocolScopes` 只保存本凭据同意的旧 Scope 标签，用于 OAuth response/challenge 和旧错误优先级映射，绝不参与 allow。refresh 可缩小标签，不能扩大；不能从每库 grants 的并集反造更大的 consent。
- refresh ceiling = 原 refresh ceiling ∩ 请求的 OAuth scope 编译结果 ∩ 实时 grants。旋转/并发 grace 不能扩大；新增 Vault/操作须重新 consent，不靠 refresh升级。
- 每次内容调用实时读取账户/Key grants、client ceiling、约束启用状态/当前时间、账户停用、epoch、transfer generation、Vault admission/可用性及部署只读。只缓存已提交的不可变数据快照，不缓存 allow。
- Web 权限修改不再因为 `updatedAt` 变化登出；下一调用按新 grants 判定。`web/sessions.json` 升为 `version:2`；每条记录精确为 `{userId,credentialEpoch,csrf,vaultId,createdAt,expiresAt,lastSeenAt}`，其余字段/上限/单写者保证不放宽。迁移仅转换仍满足旧 userUpdatedAt/expiry 校验的记录；无效记录不复活。密码、停用、显式 revoke 仍使会话/凭据失效。恢复启用不降低 epoch，旧会话不能复活。
- Key 本身没有独立 consent 层；修改其 grants 就是修改此 Key 的实时权限。环境 Key 仍是部署启动快照。
- 默认库保持 `显式 vaultId > client > account > primary`；Web `session > account > first readable Vault > primary`。失效显式目标/MCP 默认拒绝，不静默换库；Web 仅按已批准的“记住的库失效”规则重选可读库。API Key 仍 `key > primary`。
- 新权限在一次持久化 ack 后对**之后开始的 authorize 调用**生效。已准入的单次请求可能完成，不承诺跨文件/跨进程的瞬时强杀；SSE 则每次投递重查。账户缩权后再显式加回同一权利，可让仍未被 revoke、ceiling 原本包含它的旧 token 恢复该权利；要永久撤销必须增 epoch。

以上是有意的新语义，不是现状声明。不能把“等价迁移通过”当作 owner 已批准这些行为变化。

## 8. 时间约束并入模型

每条新约束精确形状：

```text
{id,label,enabled,subjects:SubjectId[],mode:"suspend"|"revoke",
 selector:{anyOf:[{surfaces:Surface[]|null,capabilities:CapabilityId[]|null,
                   targets:GrantTarget[]|null}]},
 schedule:{timezone,weekly,dateRanges,startsAt,expiresAt},createdAt,updatedAt}
```

- `selector.anyOf` 是 1–64 个固定结构分支的 OR；分支内三个字段按 AND，字段内按 OR；null 才是不限制，空数组非法。没有嵌套表达式或任意脚本。`subjects` 与 actor subjects 相交，多个匹配约束继续全部满足。
- `revoke` 只允许 `anyOf` 恰好一个三项全 null 的分支，含 OAuth lifecycle；不允许局部 revoke。suspend 不会授予任何 capability。
- 复用 `app/src/access-policy/time.js` 的时区/窗口代数，不重写时间解释。旧 schema 的字段及 revoke 要求见 `app/src/access-policy/schema.js:33-37`、`app/src/access-policy/schema.js:202-217`。
- 导入 `scope:s`：按基线各入口实际使用的 Scope 展开 capability + surface 分支；`tool:t`：展开 t 且限制 `surfaces:["mcp"]`；`toolset:x`：展开该组原工具且限制 mcp；`resource:u`：对应 resource capability 且限制 mcp；`surface:x`：对应 surface 条件；`all`：全 selector null。直传沿用基线 CONTROL_TOOL 的 mcp 语义。共享同名 capability 的 Web 路由不能被旧 `tool:` 选择器误伤。
- **关键**：旧一条 capability 列表的匹配是 OR（`app/src/access-policy/evaluate.js:19-26`），不能把 `surface:web` 和 `tool:write_note` 合成 AND。导入器把混合 OR 转成同一约束的 `anyOf` 分支，保留原 UUID、schedule、mode、label、enabled、subjects 和 timestamps。分支稳定排序/去重；不增加约束数量，不因拆分突破旧 512 条 policy 上限，也不抬高该门禁。迁移报告可记录旧 selector→分支索引映射。
- 新增 Web/system capability 不被旧 toolset/scope 选择器自动覆盖；导入展开的是基线所有真实入口，包括 Web、直传、OAuth lifecycle 的对应匹配。不能只拿 MCP 工具名展开 `scope:`。OAuth lifecycle 保留“只执行 revoke、不执行 suspend”的边界（`app/src/oauth/protocol-methods.js:14-24`），不能导入出旧时没有的 suspend 拒绝。
- `AUTHZ_ENABLED` 基线默认 false（`app/src/server-config.js:44`）。导入时原值写入 `timeConstraintsEnabled`，不得顺手打开或关闭。Stage 0 的坏文件目前不读（`app/src/access-policy/server-wiring.js:19-20`）；shadow 不改变旧服务。无法解析的休眠旧策略阻断正式迁移，修复/确认导入前不能以“disabled”丢弃文件。

## 9. 持久化、失败与修复

- store 遵守 validate → clone → 单队列 CAS(expectedRevision) → 同目录 temp 写入/同步 → rename → 发布 committed memory；失败不发布候选，旧内存与旧盘仍一致。写失败不能报告缩权成功。保留原件供修复，不做 corrupt-reset。
- 主体授权与约束在一个文件里原子提交，避免账户权限和时间规则各自生效半套。identity/token 存储仍独立；不声称跨 store 事务。
- 新建身份先建认证记录再写 grants，中途失败为无权孤儿；删除/停用/密码重置先持久化授权 epoch/tombstone，再做认证存储写入。后步失败可能导致额外登出，必须明确报错，不能回滚 epoch 复活旧凭据。
- enforced 新格式下权限文件缺失/损坏/未知版本/不可读：内容 `authorization_state_unavailable`，启动只开放受保护的 Admin 修复及无内容健康面；无 legacy fallback、无自动 seed 全权账户。
- 任一已启用约束结构损坏：整个授权文档 broken；运行时 evaluator/时钟无效同样拒绝。`authorization_policy_unavailable` 只用于可区分的约束子状态，不能把错误变成 empty。
- OAuth identity/transfer state 或 Web session store 无法可信读取：对应认证失败/503；不能依据权限文件猜身份。transfer fence 的启动拒绝约束保持（`app/src/oauth/persistence-methods.js:12-15`）；权限修复不能清除它。
- Admin 修复使用独立 admin session + CSRF + 输入确认 + 保存原件和 SHA-256 + 严格 schema 校验。broken grants 不允许普通主体凭最后一次 allow 继续用内容；Admin 只能修配置/读诊断，不可借修复获取正文。
- `server_info`/bootstrap/协议握手的无内容修复面保留；授权状态 broken 时 `server_info` 不投影未知 Vault/索引/路径信息。Admin 的本地管理密码不可用时由受保护部署恢复文件，不另造匿名 repair API。
- 匿名 Publish 是独立委托读取：权限文件 broken 不提升或撤销已存在的活动链接；其自身记录/委托不可验证则 404。公开页面不受账户时间策略约束，保留其原契约，不把发布者缩权当隐式 revoke。

## 10. 迁移、影子模式与阶段交付

| 阶段 | 可单独上线的交付物 | 实际 enforcement / 退出门 |
| --- | --- | --- |
| P0 表征 | 冻结入口、baseline oracle、fixture manifest、计数/比较器负控 | 全部旧实现；覆盖清单完整，无权限变化 |
| P1 核心与导入 | 纯 authorizer、严格 store、离线 importer；不接内容 enforcement | 全部旧实现；转换确定、候选不改原文件 |
| P2 影子 | 每个真实边界旁计算新 verdict，仅写受限差异；包括 Admin 只读解释；候选授权文档**只存在于进程内存**，启动时由导入器从冻结旧状态生成、旧状态 revision 变化时重算，P4 前不落盘 | **只按旧判定执行一次**；新 verdict 绝不调用 handler、改响应、改 usage 或写权限状态 |
| P3 统一入口桥接 | 全部入口通过同一 runtime 接口；legacy/shadow 后端仍可用，旧算法从 handler 中抽出 | 切片按 transport 移动但始终旧 enforcement；每片与 P0 等价 |
| P4 原子切换 | 维护窗口冻结授权编辑/issuance，生成新文件、token envelope、迁移 marker；一次选择 enforce；**同时上线最小 grants 编辑器**（服务端表格：主体 × target × capability，CSRF、`expectedRevision`、同一 store、无 JS 可用），否则切换后没有任何入口能改权限。P5 只在其上加预设、生效解释与原型 | 所有 transport 一起新 enforcement；未完成 marker 前不恢复流量；全套安全探针通过 |
| P5 混合权限 Admin | 按库编辑/生效解释/预设、双语、前推原型 | owner 已批准 freshness；首个混合 grant 与边界反例通过；不再允许无损验证外的 legacy 降级 |
| P6 删除旧路 | 删除 Scope/allowlist 判定、旧时间 selector 执行及 rollout 开关 | 只剩 canonical 模型；协议兼容 Scope 翻译保留，不保留双权威 |

迁移步骤：

1. 校验旧 provider 快照和 transfer fence，记录源文件 SHA-256、基线 tree、目录版本、策略开关；源集合为 `oauth/state.json`、`oauth/transfers.json`、`access-policy.json`、`web/sessions.json` 及环境 Key 的非秘密配置摘要。不能在活动写入时边读边猜一致快照。
2. 账户/Key：对每个旧允许库，授予旧 Scope 联合足以调用的每个操作；额外 instance/Web 对应行由真实基线 fixture 导出。三个 resource capability 只在旧 allowlist 包含 primary 且具 read 时授予 primary，不能为了保留潜在越库缺口而给 secondary-only 身份新增 primary grant；其差异按 §11.3 单独批准。未知旧 Vault 可保留 grant，但不可绕过 registry/admission。
3. token：**只编译自身旧快照**，不借账户新增 Vault；保存原过期、撤销、rotation、audience、generation。code 同理；迁移不得延长 TTL 或新增 token。
4. 导入旧策略与原启用状态；保存旧文件及 selector 分支映射。导入失败、休眠坏策略、超限或无法唯一关联的记录一律 HOLD，不跳过。
   - 影子期的候选文档不落盘：启动时按第 1 步的冻结快照在内存生成，旧状态 revision 改变时重建。因此「文件缺失＝broken」只适用于 P4 之后的 enforced 阶段；它不会把影子期每个 verdict 变成 deny，也不需要另造一份预生成文件。
5. P2 每次用同一个时刻、同一旧状态 revision、同一已解析目标计算旧/新 verdict；无法取得同一快照记 `inconclusive`，不是 match。只记 `{requestId,surface,capability,targetKind,oldAllowed,newAllowed,oldCode,newCode,sourceRevision,newRevision}`；必要 Vault/主体关联只进受保护 Admin 诊断，不记参数、路径、正文或秘密。
6. P4 使用有界维护窗口，冻结本进程 admission/授权写入，drain 后重读 source hashes；先准备所有新文件，再写 OAuth state 顶层字段 `authorizationSchemaVersion:1`、各 envelope 及 `web/sessions.json` v2。新 runtime 校验完整集合及 hashes 后恢复流量；崩溃在中间只能继续迁移或在仍无新写入的维护窗口恢复整组备份。
7. marker 一旦提交，`legacy`/`shadow` 启动选择必须拒绝，不能由配置退回旧权限。新格式启动只读新权威文件；旧字段保留到 P6 只为 rollback 备份，不参与 allow。托管 Key 认证记录同时写 `authorizationEpoch:0`；切换后缺此字段拒绝，不能每次从当前主体 epoch 反填，否则永久撤销会失效。
8. P6 从认证存储清除旧授权字段，保留 identity、默认库与 token 生命周期字段；只归档迁移前快照和已退役的 `access-policy.json`，不移动/删除仍在用的 `oauth/state.json`、`oauth/transfers.json` 或 `web/sessions.json`。旧测试改为 importer/协议测试，不把授权负例删掉。

P4 验收补充（P2 交接）：catalog 支撑的 Web 读取路由（`/api/web/v2/tree`、`/api/web/v2/search`、`/api/web/v1/tags`、`/api/web/v1/base`）在切换后必须用真实目录返回 200 与正文；P2 的 `authorization-web-read-boundaries.test.js` 只证明了网关行与拒绝位置，没有证明正文读取。

影子退出条件：完整 fixture 矩阵零未解释差异、零 `inconclusive`；真实或定向合成流量覆盖每个入口与每种凭据；受保护的观测窗口至少 24 小时，低流量必须补合成用例，不能凭空闲零差异通过。时间边界用注入时钟补测，不要求等一周。授权 seat 可复用内容未变的原始证据，不重复全量跑门禁；不能豁免缺失入口。

## 11. 等价证明与有意差异

### 11.1 Oracle 与夹具

新文件：`app/test/fixtures/permission-architecture/baseline.json`、`manifest.json`、`legacy-state.json`、`legacy-policies.json`。均为合成身份、Vault `vault` / `example-vault` / `denied-vault`，无真实凭据或内容。manifest 绑定基线 commit/tree、Node/依赖版本、目录条目及源摘要。oracle 必须由**基线真实 middleware/router/SDK 行为**采集，而不是新 importer 自己生成自己预期的结果。

每格比较 `(身份, capability/action, target, 时刻, surface, credential generation)` 的 allow/deny、稳定错误族、HTTP/工具拒绝位置、handler/content-I/O 次数；正例计数必须大于 0，拒绝例为 0。读取/写入失败还检查 Vault bytes、revision、journal/handle 不被修改。动态 URI、批次、Compact、resource、Web 404、CSRF、直传 PUT/PATCH、Publish 委托、Git、Admin 预览都必须有真实边界行。

已有可复用的原始夹具入口，不把它们的存在当作本轮通过证据：`app/test/multi-vault-auth-characterization.test.js`、`app/test/multi-vault-auth-matrix.test.js`、`app/test/compact-v2-real-authz-matrix.test.js`、`app/test/web-files-scope.test.js`、`app/test/access-policy-server-integration.test.js`、`app/test/authorization-transfer-provider.test.js`、`app/test/oauth-account-default-vault.test.js`。执行者必须读断言再复用。

最低矩阵：各 Scope 幂集、允许库组合、无凭据/伪造/停用/撤销、API Key/环境 Key/OAuth/Web、有/无默认/失效默认、全套工具+resources+路由、同/跨库 batch、跨 client/user/audience、UTC/Asia/Shanghai/有 DST 的时区、窗口边界 ±1ms、broken/缺失/未知格式、持久化失败及重启。

### 11.2 不可缺的负控

- 从比较器输入删一格、重复一格、全空、把 false 改 true、把未知结果当 false：比较器必须红，不能只比较共同字段。
- 故意移除执行前 authorizer；扩大 target 到所有库；跳过 live ceiling；以 client null 代替缺记录；旧 refresh 注入新增 Vault：真实边界测试必须红。
- 旧混合 OR policy 错译成 AND、冻结时钟、broken 当 empty：时间矩阵必须红。
- 故意从路由映射漏一项，或只给 helpers 接新模型而没有生产接线：inventory/真实 HTTP 用例必须红。
- 原型前推后额外塞一个 `div.dsec`；只删一个语言的 key；丢失 placeholder：Admin 门禁必须红。

### 11.3 有意差异登记，不设豁免

严格等价只针对**迁移原有可表达授权，且身份/授权状态不变**的场景；按库新编辑另做产品矩阵。以下四条 owner 已批准（2026-11-05，第 4 条同日追加），必须单独断言前后，不能从 shadow 差异表删去：

1. **（owner 已批准）** 权限缩小实时生效，不再靠撤销整批 OAuth grants；Web 也不因单纯改权登出。refresh 新增实时 intersection；code 在 consent 冻结 Vault ceiling。
2. **（owner 已批准）** 新的只读预设排除实际 mutation，包括旧 read+files 可调用的 `delete_file`。导入旧 files grant 仍保留旧权利；只有显式应用只读预设才改变它，Admin 必须显示差异。
3. **（owner 已批准）** primary-only resources 必须检查 primary grant。源码可见目前 HTTP 的 Vault 集合只收 tools/call，registrar 不包 resource（`app/src/auth.js:73-89`、`app/src/vault-scope-registrar.js:176-185`）；secondary-only token 是否真实读取 primary **未证实**。P0 必须用真实 SDK 证明。若基线允许而新模型拒绝，登记为安全收紧并要求单独批准，不为追求等价保留越权通道。

4. **（owner 已批准，2026-11-05 追加）** 跨库深链按库拒绝。`/app/note/*`、`/app/base/*`、`/app/canvas/*` 的深链指向会话 `allowedVaults` 之外的库时，旧行为是会话级 readGate 允许、handler 回答 404；新模型在读取正文之前以 `vault_access_denied` 拒绝。P2 断言该行（`authorization-web-shadow.test.js`：一行、old allow、new deny、boundary `GET /app/note/*`），P4 起该请求的答案是拒绝而非 404。release note 必须写明。

任何其他差异都 HOLD；“长期更好”“更安全”不是免审理由，尤其不得自动扩权。unknown 工具/URI 的拒绝及旧 Scope challenge 优先级由协议 mapper 对照 oracle 保留；`protocolScopes` 只能影响拒绝外观，不能让 unknown capability 成为 allow。新字段/错误码/枚举对客户端的影响必须写 release note。

## 12. Admin 面与可见契约

- 账户/Key 抽屉显示“Vault × 操作能力”表，另有 `instance` 分组（`agent_bootstrap`、`server_info`、`agent_memory_policy_read`）；常用预设只读/编辑/全部/自定义，展开技术细节看 capability ID。账户和 Key 不再分开编辑全局 Scope 与 allowlist。
- client 抽屉显示“额外上限：不额外限制 / 自定义”，并说明它不能授予账户本来没有的权利。环境 Key 只读，明确部署来源；无记录与零权限分开。
- 每次保存带 `expectedRevision`；过期 409，保留草稿且不写盘。预览显示当前实时 grants、冻结 token ceiling、client 限制、时间窗、只读部署和最终拒绝原因；不能以 token 列的权限并集冒充某一 token 的能力。
- 保存缩权说明“下次请求生效；不新增授权；不强制结束已准入请求”；单独的永久撤销动作继续列出受影响身份并确认。默认库编辑保持独立，必须可读且已注册；切换偏好不改 grants/epoch。
- broken 文件显示不可用及修复入口；不显示“无策略”“全部正常”。Admin 只显示管理元数据，不能预览 Vault 正文。审计记录 actor、subject、target、revision、操作差异和结果，不含秘密/内容。
- 新文案进入 `app/src/i18n/admin/zh-CN.permissions.js`、`app/src/i18n/admin/en.permissions.js`，由现有聚合目录导入。键集合与 placeholders 完全相同，动态 key 也显式测试；已有同键约束见 `app/test/i18n-admin-catalog.test.js:27-40`。
- 权限表、client 上限、token 解释、时间选择器更新时，**同时前推** `docs/admin-ui-proto/src/4-data.js`、`src/5-render.js`、`src/6-app.js` 与生成的 `index.html`；按 `docs/admin-ui-proto/README.md:279-290` 带结构负控。不得新增区域豁免、通配豁免或抬高 waiver 预算。
- SSR 真表单、无 JS、CSRF、输入确认、同源增强、键盘/ARIA、深浅色和窄屏都保留；现行规则见 `docs/admin/README.md:47-67`、`docs/admin/README.md:158-181`。本设计不改 CSP、不换前端框架。

## 13. Rollback

1. **P0–P3**：关闭 shadow observer 或回退对应代码即可；旧 enforcement 与旧权限文件未变。保留差异证据，不回滚 OAuth/session 数据来“复原测试”。
2. **P4 维护窗口内、尚未恢复流量**：校验 source hashes 后恢复成组备份；保留 transfer fence、审计与迁移失败原件。不存在新凭据/改权才能恢复旧快照。
3. **新 enforcement 已接客**：首选回退到上一份**懂新 schema 的二进制**，保留新权限状态、epoch、transfer fence和新 token。不得切回旧 allowlist 路径。
4. 若必须降到旧二进制，先停止 admission；对每个主体/凭据做新→旧→新 round-trip，证明旧格式能精确表示所有生效 grants/约束及永久撤销。混合 per-Vault 读写、操作子集或不可表达的新约束会让导出失败，**禁止降级，只能 fix-forward 或使用 schema-aware 恢复版**。
5. 不可通过“取各库 Scope 并集”回滚，它会把 `vault` 的只读变成可写。不得恢复较旧 `oauth/state.json`、清空新文件/transfer fence、降低 epoch、临时关闭时间约束或扩大 allowlist 来维持可用性。
6. 每阶段交付要保留 immutable 代码/产物、数据 schema、脱敏 manifest、备份 SHA-256、drift、回退命令与线上 allow/deny smoke；本文不授权 merge/release/deploy。

## 14. 非目标、反目标与实施者自由度

非目标：组织/角色继承、路径级 ACL、任意 ABAC 表达式、外部策略引擎、多副本写者、第三方登录、新 OAuth grant type、API Key 账号归属、MCP 当前 Vault 状态、重做 Web 编辑器、重构 Vault/Git/Publish 存储格式。

反目标：继续维护三套 runtime 词汇；以 UI 隐藏替代服务端授权；把默认库当授权；因迁移扩大旧 token；保留永久 dual-write/legacy fallback；吞坏文件为 empty；靠数量/旧 CI 绿灯代替真实边界；给 Admin 区域发 waiver；用无法表示混合权限的旧二进制冒险回滚。

实施者可以选择小模块内部拆分、测试夹具帮助函数与页面排布细节；不能更改本设计的字段、交集规则、错误边界、审批门或 migration/rollback 条件。共享文件按阶段单一 owner，不把完整鉴权迁移分给多个 agent 同时编辑。

## 15. 我的判断、owner 问题与交付状态

本设计作者自行选择：复用工具名作为操作 ID；显式 grants 而非 role/通配；client null ceiling；新单文件授权 store；OAuth ceiling 冻结 + 当前权限实时相交；单纯改权不吊销 token；24 小时 shadow + 全入口合成覆盖；schema-aware rollback；按计划分阶段上线。这些选择若错，代价主要是协议/迁移返工、过度登出或意外权限差异，不是已获批准的产品事实。

owner 于 2026-11-05 批准了三条决定（原话「都批」）：

1. **批准 §7**：权限缩小实时生效、单纯改权不登出；OAuth 在账户新增库/能力后必须重新 consent，旧 refresh 不自动扩权。
2. **批准 §11.3 的两条行为差异**：新的只读预设排除真实 mutation（含 `delete_file`）；P0 若证实 primary-only resource 的越库读取，则按安全收紧处理，并单独记入 release note。
3. **接受 §13 的切换代价**：正式切换需要一次有界维护窗口；混合权限启用后只能 schema-aware rollback 或 fix-forward，不得降回旧二进制。

批准覆盖设计与行为语义，不覆盖实现结果。未执行产品测试、migration、shadow 或生产验证；没有验收/GO 结论。builder-check 提出的 7 个可建造性问题已按协调者判定写回本文与计划（§4.1 可授予集合与 instance 预设、新建库由 handler 写授权、§5.1 `catalogVersion` 兼容、§10 影子候选只在内存、P4 自带最小编辑器、§12 instance 分组、第四条 resource）。实现按计划分阶段，每阶段须独立原文复核后才能进下一阶段。
