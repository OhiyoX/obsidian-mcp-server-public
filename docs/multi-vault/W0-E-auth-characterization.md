# W0-E — MCP 多库 auth characterization（Wave 0，零行为改变）

> **Wave C 更新（2026-10-07，见 §0）**：本文件 §1–§8 记录的是 **pre-C head** 的事实（BASE `c077d6c`）；
> Wave C（`feat/mv-c-mcp-vault-scope`）按本文件自己的规则，在同一次改动里同步了测试与本文档。§0 给出
> 每个被 C 翻转的事实及其 after-state 与位置；§1–§8 保留为历史证据。

- **契约（唯一权威）**：`_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md` §1.4、§1.5、§7、§8、§9、§9.1、§9.2、§18.1、§25 W0-E、§28、§34、§43-3/§43-4、§44-2。
- **性质**：表征（characterization）。Wave 0 本刀**只新增**文件，不改 `app/src/**` 一个字符；本文件固定的是**当时事实**，不是目标行为。
- **BASE**：`c077d6c774075908c977efc5dd467a9d966cc7f5`（派发时冻结 BASE `6dc8154` 已前进 5 提交，全部为 archive + web-context；四个 guarded 文件 `auth.js` / `request-context.js` / `oauth/primitives.js` / `app/vault-registry.js` 在 `6dc8154..c077d6c` 上 **0 diff**，无 #285 合流，故 guarded 语义未漂移）。
- **机器可验版本**：`app/test/multi-vault-auth-characterization.test.js`（真实 HTTP + 真实 `createAuthMiddleware` + 真实 `PersistentOAuthProvider`）。
- **改这些语义的刀**：C（auth/scope 集成）**已落地**（下述 §0）；A4（#285 owner）只动归因/审计层，未动 vault 语义。

---

## 0. Wave C after-state（2026-10-07）

| # | pre-C 事实（下文对应节） | Wave C after-state | 位置 |
| --- | --- | --- | --- |
| 1 | `VAULT_SCOPED_TOOLS = new Set(["get_publish_status", "manage_publish"])`（§1） | 集合被**删除**；`requestedVaults()` 改为消费 canonical registry `isVaultScopedTool()`（`app/src/vault-scope.js`，A3），**不再维护第二份集合** | `app/src/auth.js`（import + `requestedVaults`）；契约 §43-3 |
| 2 | batch 内任一非 Publish call → 整个请求短路成 `[DEFAULT_VAULT_ID]`（§1/§3） | **逐成员并集**：每个 vault-scoped call 记 `args.vaultId ?? DEFAULT_VAULT_ID`；global（§7.1）与 unknown（§9.1）不加要求 | 同上 |
| 3 | vault 门在 scope 门**之前**（§2.1）：越权+缺 scope → `access_denied` | **调序为 §8**：scope 先、vault 后，两条凭据分支一致 ⇒ 越权+缺 scope 现为 `insufficient_scope` | `app/src/auth.js`（api-key / oauth-access 分支） |
| 4 | 配置 env API key 分支**从不**调用 `deniedVault()`（§5.1）：`vaultId=secondary` → 200 | 该分支补上 vault 门（§9.2）：非 primary 的 `vaultId` → **403 `access_denied` + `auth.reject`（`credentialId: configured-env`）**，handler 0 次执行 | `app/src/auth.js` 配置 key 分支 |
| 5 | 拒绝形态：403 普通 HTTP 体，无 `WWW-Authenticate`（§2） | **不变**（C 未改拒绝形态，只改了集合来源与顺序） | `app/src/auth.js` |
| 6 | `server_info` 无任何 vault 字段（§6） | **additive**：`defaultVaultId` + `vaults`（= caller `allowedVaults ∩ registry`，每项仅 `id/name/primary/writable/capabilities`，无 root/DATA_PATH/remote/凭据）；inventory 不可读时 `vaults: []`（不伪造） | `app/src/tools/info.js`（§18.1） |
| 7 | request context 无 vault 键；memory-guidance 整对象覆盖（§7） | registrar 链变为 discovery → access-policy → **vault-scope** → memory-guidance → handler；vault-scope registrar 用 A4 的 `withRequestContextPatch` 注入 `vaultId`/`vaultRuntime`，memory-guidance 改为 patch（不再遮蔽） | `app/src/vault-scope-registrar.js`、`app/src/capabilities.js`、`app/src/memory-guidance.js` |
| 8 | 全部 vault-scoped tool 的 `inputSchema` 无 canonical `vaultId`；`publish.js` 手写 `vaultId` + 手写 allowlist | registrar 为全部 85 个 scoped tool 注入 canonical optional `vaultId`（1–80，不传=default）；`publish.js` 的局部字段与局部 allowlist **删除**，改读 registrar 选择；global 两个工具无 `vaultId`；tool count 仍 87 | `app/src/vault-scope-registrar.js`、`app/src/tools/publish.js`；契约 §7.3/§7.4/§43-4 |
| 9 | （未表征）registrar 层无 vault defense | 新增 request-level defense-in-depth：有 `authInfo` 时 selected vault 必须在 `allowedVaults` 内，否则结构化拒绝（`vault_access_denied`）；非 default 的 selected vault 再经 canonical inventory 校验（未知 → `vault_unavailable`，不回退 primary） | `app/src/vault-scope-registrar.js`；契约 §7-7/§9/§34-9 |
| 10 | `obsidian://vault/*` resources 未表征 | 明确 primary-only：registrar 不包装 resource（委托原 handler），`resources.js` 不读 ALS（源码断言 + 源码扫描） | `app/src/vault-scope-registrar.js`、`test/vault-scope-registrar.test.js`；契约 §19 |

Wave C 的机器可验版本：`app/test/multi-vault-auth-characterization.test.js`（已按 after-state 翻转，§8 顺序用例在其中）、
`app/test/multi-vault-auth-matrix.test.js`（§34-7/§34-8/§34-9 + 真实三库 inventory）、
`app/test/vault-scope-registrar.test.js`（registrar 单元/deny-before-I/O）、
`app/test/multi-vault-vault-scope-contract.test.js`（§35 SDK 级 schema/合同 + §43-4）。

负控（3 条，真红 + 复原 + 复跑绿）：`scratch/multi-vault/C/negctl-C.mjs` → ①`requestedVaults` 回退 Publish-only 集、
②registrar 去掉 defense、③`server_info` 返回全量 vault。

---

## 1. `VAULT_SCOPED_TOOLS` 现状

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 集合定义 | `new Set(["get_publish_status", "manage_publish"])` | `app/src/auth.js:62` |
| 判定函数 | `requestedVaults(req)`；无 `tools/call` → `null` | `app/src/auth.js:64-70` |
| 短路规则 | batch 内**任一** call 的 `params.name` 不在集合中 → 整个请求 `[DEFAULT_VAULT_ID]` | `app/src/auth.js:68` |
| 读取规则 | 全部 call 都在集合中 → `[...new Set(calls.map((m) => String(m?.params?.arguments?.vaultId \|\| DEFAULT_VAULT_ID)))]` | `app/src/auth.js:69` |
| 集合是否导出 | **否**（模块私有），故测试经真实 middleware 观测行为，而非直接读集合 | — |
| 是否为 canonical registry | **否**：与 `scopes.js` 的 `MCP_TOOL_SCOPE_REQUIREMENTS`（87 工具全量分类）无关联 | `app/src/scopes.js:65-73` |

⇒ 契约 §1.4 成立：MCP allowlist 目前只真正覆盖 Publish；任何其它 tools/call 一律按 `DEFAULT_VAULT_ID` 处理。契约 §44-2（old-red：`requestedVaults` 对普通 tool 固定 primary）即本行事实。

测试对应：`characterization: a non-Publish tools/call is always evaluated as the default Vault (old-red 2)`（双向证明：`vaultId=secondary` 对 default-only 凭据放行、对 secondary-only 凭据 403）、`ratchet: across all 87 canonical tools …`（对 87 个 canonical 工具逐个探测，分类结果**精确等于**这两个名字）。

## 2. `deniedVault()` 的拒绝形态

- 判定：`deniedVault(auth, req)` 取 `requestedVaults(req)`，返回第一个不在 `auth.allowedVaults` 中的 vault id，否则 `null`（`app/src/auth.js:72-76`）。
- 调用点只有两处：存量 api-key 记录分支 `:259`、OAuth access token 分支 `:293`。**配置 env API key 分支（:218-233）不调用它**（见 §5）。
- 拒绝形态（两条分支一致）：

| 维度 | 现状 | 位置 |
| --- | --- | --- |
| HTTP 状态 | `403` | `app/src/auth.js:262`（api-key）、`:296`（oauth） |
| 响应体 | `{ "error": "access_denied", "error_description": "Vault access denied" }` —— 普通 HTTP 错误体，**不是** JSON-RPC error envelope | 同上 |
| 结构化 code | 字符串字面量 `access_denied`（与 scope 拒绝的 `insufficient_scope`、凭据失败的 `invalid_token` 并列） | `:262`、`:296` |
| 响应头 | **不设** `WWW-Authenticate`（scope/凭据失败才设） | 对比 `:268`、`:302`、`:321` |
| 审计 | 一条 `auth.reject`，`outcome: "failure"`，`credentialType` 为 `api-key`/`oauth-access`，`scopes`、`vaults: auth.allowedVaults`，`detail: "vault access denied: <id>"` | `:261`、`:295` |
| 归因字段 | oauth 分支**不带** `userId`，api-key 分支带 `credentialId: auth.keyId` | 同上 |

- **「handler 0 次执行」的机制（链路）**：`server.js` 在 `/mcp` 路由**之前**挂 `createAuthMiddleware`；拒绝分支只写 `res.status(403).json(...)` 并 `return`，**从不调用 `next()`** ⇒ Express 不会进入 MCP 路由 ⇒ SDK `StreamableHTTPServerTransport` 不处理该请求 ⇒ 工具 handler 0 次执行。测试用真实 HTTP + 计数 handler 证明：所有 deny 用例 `app.handled.length === 0`，放行用例计数 +1（非空正控）。

测试对应：`characterization: the vault denial shape and audit record are frozen`。

### 2.1 现状与契约 §8 目标顺序的差异（不改，仅记录）

契约 §8 目标顺序：`credential verify → required scopes → requested vault IDs → allowedVaults → …`。
现状：**vault 门在 scope 门之前**（`:259` 早于 `:265`；`:293` 早于 `:299`）。即：一个既缺 scope 又越权的请求，今天得到的是 `access_denied` 而不是 `insufficient_scope`。切片 C 负责调序。

### 2.2 审计真实性现状（#285 的口子，仅记录）

- 存量 api-key 分支：`verifyApiKey(candidate, usage)`（`:249`）在 vault 检查（`:259`）**之前**就写了一条 `mcp.tool.<name>` **success** 审计 ⇒ 被 vault 拒绝的请求仍会留下一条“成功调用”记录。测试只冻结 oauth 分支（拒绝时无 success 记录，因为 `noteAccessTokenUse` 在 `:311`，晚于两道门）；api-key 分支的重复记录属 #285 归因修复范围，本刀不修、不断言成败语义以外的东西。

## 3. batch 语义

`requestMessages(req)` 把数组 body 原样视为 batch（`app/src/auth.js:50-52`）；`requestedScopes` / `requestedVaults` 都遍历全部 `tools/call`。

| 场景 | 现状结果 | 依据 |
| --- | --- | --- |
| 两个 call 均非 scoped（各带 `vaultId`） | 需求 = `[DEFAULT_VAULT_ID]`（`vaultId` 被忽略） | `:68` |
| scoped + 非 scoped 混合 | **仍为 `[DEFAULT_VAULT_ID]`**：非 scoped 成员短路，scoped 成员的 `vaultId` 不贡献任何东西 | `:68`（`calls.some(...)`） |
| 全部 scoped，`vaultId` 相同 | 去重为单个 id | `:69`（`new Set`） |
| 全部 scoped，`vaultId` 不同 | 取并集；**任一** id 不在 `allowedVaults` ⇒ 整个请求 403，batch 内全部 handler 0 次执行 | `:69` + `:72-76` |
| batch 内多个 scoped，其一缺省 | 缺省者按 `DEFAULT_VAULT_ID` 参与并集 | `:69` |

⇒ `publish + 非 publish` 混合 batch 的现状：非 publish 成员把请求拉到 default；若凭据恰好只有 secondary（无 default），整个 HTTP 请求被拒 —— 即使其中的 publish 成员本来就只想要 secondary。切片 C 会保留并集语义但改为从 canonical registry 取每个成员的需求。

测试对应：`characterization: a batch containing any non-Publish call collapses to the default Vault`、`characterization: an all-Publish batch unions and dedupes vault ids before any handler`。

## 4. `DEFAULT_VAULT_ID` 的定义与读取点

```js
// app/src/oauth/primitives.js:9-11
export const DEFAULT_VAULT_ID = process.env.WEB_VAULTS_ROOT
  ? (String(process.env.WEB_DEFAULT_VAULT || "vault").trim() || "vault")
  : "default";
```

- 语义：**未启用 Web 多库（`WEB_VAULTS_ROOT` 未设）时恒为 `"default"`**；启用后等于 `WEB_DEFAULT_VAULT`（缺省 `vault`）。派生自 `process.env`，**在模块求值时冻结**（非 per-request）。
- 再导出链：`app/src/oauth-provider.js:28` → `app/src/auth.js:7`。
- 同源但独立的定义：`app/src/app/vault-registry.js:16` `DEFAULT_ID` / `:37 defaultWebVaultId()`（`VAULTS_ROOT ? DEFAULT_ID : "default"`），被 `tools/publish.js:1` 引用为 tool 层缺省。两者在 `WEB_VAULTS_ROOT` 未设时一致（`"default"`）。
- 主要读取点：

| 位置 | 用途 |
| --- | --- |
| `app/src/auth.js:68,69` | `requestedVaults()` 的缺省与短路值 |
| `app/src/auth.js:220` | 配置 env API key 的 `allowedVaults: [DEFAULT_VAULT_ID]`（硬编码） |
| `app/src/oauth/primitives.js:59,65` | `normalizedVaults()` 的 fallback + `"default"→DEFAULT_VAULT_ID` 迁移映射 |
| `app/src/oauth/persistence-methods.js:32,68` | load 迁移 fallback；初始管理员账户的 `allowedVaults` |
| `app/src/oauth/protocol-methods.js:136,163` | 无 userId 的 token 铸造 fallback；exchange 时取用户 allowlist |
| `app/src/oauth-provider.js:114` | `createApiKey(..., allowedVaults = [DEFAULT_VAULT_ID])` |

测试对应：`characterization: the two Publish tools read args.vaultId and fall back to the default Vault`（缺省 → `DEFAULT_VAULT_ID` 被实际用于判定）。

## 5. credential 侧 `allowedVaults`

| 面 | 现状 | 位置 |
| --- | --- | --- |
| 存储 schema | 明文 JSON（`DATA_PATH` 下 OAuth 持久化文件，`mode 0o600`）：`oauthUsers[id].allowedVaults`、`apiKeys[digest].allowedVaults`、`accessTokens[digest].allowedVaults`、`refreshTokens[digest].allowedVaults` | `oauth/persistence-methods.js:29-45`、`oauth/protocol-methods.js:136-143` |
| 校验/归一 | `normalizedVaults()`：去重、trim、非空、≤80 字符、禁 `\ / \0`、禁 `.`/`..`；违反则 `InvalidRequestError` | `oauth/primitives.js:59-67` |
| token 铸造时来源 | 授权码交换：取 `oauthUsers[userId].allowedVaults`（无 userId → `[DEFAULT_VAULT_ID]`）；refresh 沿用 `record.allowedVaults` | `oauth/protocol-methods.js:163`、`:190` |
| 运行时读取 | `verifyAccessToken` 返回 `allowedVaults: [...record.allowedVaults]`；`verifyApiKey` 同理 | `oauth/protocol-methods.js:203`、`oauth-provider.js:137-145` |
| Admin 修改入口 | 建/改 api key：`selectedVaults(req.body)`（至少一个 Vault，否则报错）；改用户：`/admin/auth/oauth/user/scopes` 的 vault 勾选 | `admin/auth-center.js:387-401`、`:340`（用户行 `vaultOptions`） |
| Admin 只读展示 | 凭据表列出 `allowedVaults`；`configured-env` 行的 allowlist 显示为 `vaults.filter(primary)` 且 `immutable: true` | `admin/auth-center.js:353`、`:317` |
| **configured env API key** | **只有 primary**：`app/src/auth.js:220` 硬编码 `allowedVaults: [DEFAULT_VAULT_ID]`，且**不查库**。Admin 侧展示为 primary 列表并标 `immutable`（在受保护 `.env` 轮换） | `auth.js:220`、`admin/auth-center.js:317` |

### 5.1 配置 env API key 的现状缺口（本刀新发现，需 C 处理）

`app/src/auth.js:218-233` 的配置 key 分支只做 hard-revoke 判定就 `next()`，**从不调用 `deniedVault()`**。故 HTTP 层对 `vaultId` 不设门：

- 实测（本刀测试 `characterization: the configured env API key branch never evaluates the vault gate`）：`X-API-Key: <configured>` + `get_publish_status{vaultId:"secondary"}` → **200**，且无任何 `auth.reject` 审计。
- 有效拦截发生在**下一层**：`tools/publish.js:8-16` 的 `allowedVaults(extra)` / `targetVault()` 读 `extra.authInfo.allowedVaults` 并对不在表内的 id 抛 `Vault access denied`。该 `extra.authInfo` 正是 SDK 从 `req.auth` 注入的（`app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js:131`），即 `req.auth.allowedVaults = [DEFAULT_VAULT_ID]`。
- ⇒ 端到端“配置 key 只有 primary”今天成立，但**机制在 tool 层而非 HTTP 门**，报错形态也不同（tool error，不是 403）。契约 §9.2 / §34-10 的目标是把它统一到 HTTP 门；属切片 C。
- 本刀只冻结 HTTP 层事实（测试断言 200 + 无审计）；tool 层路径未在本刀用真实 MCP transport 复验（见 HANDOFF「未证实」）。

## 6. `server_info` 现状输出

- 组成：`{...await getVaultHealth(), version, tools: view.toolNames, discovery: discoveryPolicySummary(view), index: getVaultIndexStats(), onboarding: {...}}`（`app/src/tools/info.js:58-77`；health 字段见 `app/src/vault.js:488`）。
- vault 相关字段**全部是单例/全局**：`ok, vaultPath, dataPath, trashPath, historyPath, versionHistoryEnabled, maxVersionsPerFile, readOnly, maxReadBytes` —— 每个都是标量或单值，**没有** `vaults` / `vaultIds` / `vaultRegistry` / `multiVault` / `vaultScope` / `allowedVaults`（测试逐一断言这些键不存在）。
- 顶层键全集（测试冻结）：`dataPath, discovery, historyPath, index, maxReadBytes, maxVersionsPerFile, ok, onboarding, readOnly, tools, trashPath, vaultPath, version, versionHistoryEnabled`。
- caller 过滤现状：只有 **scope/工具可见性**过滤（`discovery.toolNames` 来自 per-request `resolveDiscoveryView`），**没有** per-vault 过滤 —— 契约 §18.1（`server_info` 输出 caller 可见的 vault 列表）仍是**未实现的目标**。
- `index` 也是单例统计（`getVaultIndexStats()` 读模块级 `noteCache` 等，`app/src/vault-index.js:400-402`），即契约 §44-4/§44-5 的“单一 generation / 单一 index path”。

测试对应：`characterization: server_info still reports a single-Vault singleton surface`（进程内真实 MCP client + `registerObsidianCapabilities`，不启网络）。

## 7. `request-context.js` 字段与 `withRequestContext` 覆盖顺序

- ALS store：`const storage = new AsyncLocalStorage()`（`app/src/request-context.js:18`）。**该模块没有任何 vault 字段**。
- 写入点共两处，都是整对象 `storage.run(...)`（**无 merge**）：

| # | 写入点 | 对象键 | 位置 |
| --- | --- | --- | --- |
| 1 | HTTP auth 层（仅当注入 `accessRuntime` 且请求含 tool） | `{ authzUsage }` | `app/src/auth.js:158`（`usageDeferral.run`） |
| 2 | memory-guidance registrar（每个工具调用） | `{ author, authClientId, authUserId, tool, sessionId }` | `app/src/memory-guidance.js:37` |

- **覆盖顺序（现状）**：Express 的 auth middleware 先 `storage.run({authzUsage}, next)` → 进入 MCP transport → 工具 handler 被 memory-guidance registrar 包裹，再 `storage.run({author, …}, handler)`。嵌套 ALS 中**内层完全遮蔽外层**：工具 handler 内 `requestContext()` 只能看到第 2 层的 5 个键，**看不到 `authzUsage`**。
  - 即：`app/src/request-context.js:79-81` 的 `requestContext()` 返回的是最内层 store；`AUTHOR_META_KEY` 相关读取（`requireRequestAuthor()`，`:83-87`）依赖第 2 层。
  - 契约 §1.5 的警告正是此事：新增 vault context 若直接套第三层而不 merge，会与第 2 层互相覆盖。切片 A4（等 #285）决定 merge 策略；本刀只固定当前两层顺序与字段集。
- 消费者字段清单（当前）：`author`（`resolveRequestAuthor`，`:49`）、`authClientId`/`authUserId`（`:6-17` 的 `authClientIdFromExtra`/`authUserIdFromExtra` 从 `extra.authInfo` 提取）、`tool`、`sessionId`（`memory-guidance.js:37`）、`authzUsage`（`auth.js:158`，被 access-policy registrar 用于把 denied 调用标记为不提交 usage）。

## 8. Web 侧（只读走查）：vault 选择与 allowedVaults 过滤

| 面 | 现状 | 位置 |
| --- | --- | --- |
| Vault 发现 | `listWebVaults()` 扫 `WEB_VAULTS_ROOT`（跳过符号链接/隐藏目录/非法 id），primary 记为 `DEFAULT_ID`；未配置时退化为单库 | `app/src/app/vault-registry.js:41-60` |
| 登录时选择 | 取 `user.allowedVaults[0] || defaultWebVaultId()` 写入 session；空 allowlist → 403 登录页 | `app/src/app/auth-routes.js:63-66` |
| 每次请求重解析 | **以 provider 为准**（持久化的 session scopes/allowedVaults 不参与判定）；若 `vaultId` 已不在 allowlist → 回退 `allowedVaults[0]` | `app/src/app/web-session-resolve.js:41-44` |
| API 过滤 | `/api/web/v1/session` 返回 `vaultId`+`allowedVaults`；vault 列表按 `allowedVaults` 过滤；切换 vault 校验成员资格（403 `Vault access denied`）；创建 vault 会把它加入自己的 allowlist | `app/src/app/routes.js:143`、`:182`、`:190`、`:203-207` |
| 页面/事件门 | `base-page.js:48` 校验 `allowedVaults` 后 404；heartbeat 校验 `current.vaultId === vaultId && allowedVaults.includes(vaultId)` | `app/src/app/base-page.js:45-55`、`app/src/app/events/heartbeat.js:16` |
| 差异 | Web 侧**已经有** per-request vault 解析 + allowlist 过滤（契约 §1.2 的“Web 已有真实 local multi-Vault registry”），而 MCP 侧只有 §1/§2 的 Publish-only 门 —— 两套语义目前并存 | — |

⇒ 切片 C/F 应把 MCP 侧对齐到 Web 侧已有的“凭据 allowlist + per-request 解析”模型，而不是新造一套。

---

## 契约对照小结（pre-C 差异项 → Wave C 已处理，见 §0）

| 契约条款 | pre-C 现状 | 判定 |
| --- | --- | --- |
| §1.4（仅 Publish 受管） | 完全一致 | ✅ 已表征（**C 已消除**） |
| §1.5（request context 无 Vault；第二层覆盖风险） | 完全一致（两层整对象 `run`，内层遮蔽） | ✅ 已表征 |
| §8（`scopes → vaults` 顺序；registrar 顺序） | **不一致**：vault 门在 scope 门之前（auth.js:259/265、293/299） | ⚠️ 差异 → **C 已修复**（§0-3、§0-7） |
| §9（canonical registry + batch 并集 + 任一缺失 0 执行） | batch 并集/去重/0 执行一致；但**:64-69 仍是 Publish-only set，非 canonical registry**；且**配置 key 分支无门** | ⚠️ 差异 → **C 已修复**（§0-1、§0-2、§0-4） |
| §9.1（unknown tool 不创造新语义） | 一致：未知工具名按“非 scoped”处理，不因 vault 层产生新拒绝 | ✅ 已表征（负控）；C 保留 |
| §9.2（配置 env key 仅 primary） | HTTP 层不强制（见 §5.1）；tool 层由 publish.js 兜住 | ⚠️ 差异 → **C 已修复**（§0-4；tool 层兜底已按 §43-4 删除） |
| §18.1（server_info 列 caller 可见 vault） | 未实现（无 vault 字段、无 vault 过滤） | ⚠️ 目标 → **C 已实现**（§0-6） |
| §25 W0-E 四项 | 全部固定：non-Publish 按 default ✅ / Publish 按 vaultId ✅ / batch 语义 ✅ / server_info 不列 multi-vault ✅ | ✅ |
| §34（授权矩阵 10 例） | 本刀覆盖 2/3/4/5/6/9 的**预冻结**部分（A/B allowlist 行为） | 部分 → **C 已实现 10/10**（见 §0 末的测试清单） |
| §44-2（old-red） | 已用双向探针机器化（见 §1） | ✅ |

## 方法与复现

```sh
cd app
node --test test/multi-vault-auth-characterization.test.js
npm run check
npm test
```

- 测试不启真实监听端口以外的外部依赖：`createAuthRevokeHarness()` 建 temp `DATA_PATH` + 真实 `PersistentOAuthProvider` + 真实 `createAuthMiddleware` + 真实 HTTP socket，其 `/mcp` handler 记录调用次数（等价于“fake handler 计数”）。
- `server_info` 用进程内 `McpServer` + `Client` + `InMemoryTransport`（不启网络）。
- 负控（2 条 + 1 次源码级实验）：
  1. 名字精确性：伪造名 / `"manage_publish "` / `"Manage_Publish"` 与真名在同凭据同参数下结果不同（证明判定是精确集合成员，非前缀/大小写/去空格）。
  2. 比较器非空转：`scopeSetDifferences()` 对“多一个/少一个”名字都会报出差异。
  3. 源码级：临时把 `list_notes` 加入 `auth.js:62` 的 `VAULT_SCOPED_TOOLS` → 棘轮用例**红**（`vault-scoped tool set changed`，`+list_notes`），随后 `git checkout -- app/src/auth.js` 复原，`git diff` 为空。红输出留证于 lane 目录 `log-negative-control.txt`，**未提交**。
