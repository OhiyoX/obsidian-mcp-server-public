# 账号级默认 Vault（short design）

- 日期：2026-11-05
- 状态：待 owner 批准
- 相关：#642（API Key / 客户端终端身份默认 Vault，已实现）、#617（凭证 × Scope × Vault 安全矩阵）、#643（Admin 参照补齐）

## 意图

一个账户（人）通常在多个客户端里工作。现在只有 API Key 和 OAuth 客户端能设默认库，人本身不能；同一个人换客户端就得重复配，或者被迫每次传 `vaultId`。本改动让人可以设一次，客户端仍可按需覆盖。

**owner 决定（2026-11-05）**：允许细化到具体客户端设置默认库；未设置时继承自账号。

## 解析顺序（唯一入口，不复制）

```
MCP：显式 vaultId  >  客户端默认  >  账号默认  >  全局 primary
Web：会话记住的库  >  账号默认  >  allowedVaults[0]  >  全局 primary
```

- API Key 保持现状：Key 自己的默认 > 全局 primary（Key 不属于任何账号，不参与账号层）。
- 服务端 primary 不改。
- 实现落在既有入口：`verifyAccessToken()` 现在返回 `defaultVaultId = clientUsage[clientId].defaultVaultId ?? null`；改为 `客户端默认 ?? oauthUsers[userId].defaultVaultId ?? null`，并额外返回来源（token 层叫 `defaultVaultLayer`，避免与 `server_info.defaultVaultSource` 混名）。`src/default-vault.js` 的 `effectiveVaultId()` 不动。

## Web 会话首屏（owner 决定 2026-11-05：B）

网页版跟着账号默认走，让「默认库」在 MCP 与网页里是同一个意思：

- 登录建会话时：`vaultId = user.defaultVaultId ?? user.allowedVaults[0] ?? defaultWebVaultId()`（现在是 `allowedVaults[0] || defaultWebVaultId()`，`src/app/auth-routes.js:78`）。
- 用户在网页里手动切库后，**会话记住的选择优先**（`selectVault` / `noteSelection` 不变），不会被账号默认反复拉回。
- 记住的库后来被移出 allowlist 时：`账号默认（若仍允许） → allowedVaults[0]`（现在是直接 `allowedVaults[0]`，`src/app/web-session-resolve.js:43-44`）。
- 账号默认改了**不会**把已经登录的会话切过去（会话是显式选择，属于用户状态）；只影响下次登录和新会话。

## 持久化

- 字段：`oauthUsers[id].defaultVaultId`，与 `allowedVaults` 同一个明文 JSON 文件（非秘密）。
- 归一化复用 `normalizeDefaultVaultId(value, allowedVaults)`；缺字段 / `null` = 继承上层。
- 无 schema 版本升级：旧记录缺字段即「未设置」，load 时不补写。
- 修改默认库**不吊销任何 token**（偏好不是授权），与 #642 的 client 规则一致。

## 校验与 fail-closed

| 场景 | 结果 |
| --- | --- |
| 保存：值不在该账户 `allowedVaults` | 400，不落盘 |
| 保存：值不在已注册 Vault 清单 | 400，不落盘 |
| 保存：空值 | 允许，等于「继承」 |
| 解析：生效值不在该 token 的 `allowedVaults` | `vault_access_denied`，**不**回退到 primary 或其他库 |
| 账户被移除该库 / 库被删除 | 同上，拒绝而不是静默换库 |

## Admin

- 账户抽屉加一节「默认 Vault」，复用 `renderDefaultVaultPicker`（选项只列该账户有权的已注册库，含「继承」）。
- 新路由 `POST /oauth/user/default-vault`（`requireAdmin` + `requireCsrf`），校验同上，成功 flash 并回 `accounts`。
- 审计：`oauth.user.default-vault.update`，`detail` 写具体 vault id 或 `inherit`（#642 的矩阵要求记录被选 vault id，现有 key/client 两条只写 configured/inherit，本次一并补 id）。
- **原型参照成本**：账户抽屉会多一个 `div.dsec`，Admin 原型骨架门禁会红。按 `docs/admin-ui-proto/README.md` 的规则前推参照（不给区域豁免），并带负控。

## 可观测

`server_info` 的 `defaultVaultSource` 目前是 `credential | server`。改为具体来源 `api-key | client | account | server`，让「我到底按谁的默认库走的」可判读；`effectiveDefaultVaultId` 不变。同步更新 `docs/USER_CONFIGURATION.md` 与相关测试。这是**我的判断**，若你更想保住旧枚举可以改回两值 + 新增字段。

## 测试

- 解析矩阵：客户端有值 / 只有账号值 / 都没有 / 账号值失效，四种下 `effectiveVaultId` 与 `server_info` 读数。
- 持久化：写入后重启（重新 load）仍生效；旧记录缺字段不报错。
- 路由：越权值、未注册库、空值、CSRF、非管理员。
- 不吊销：改账户默认库后现有 token 仍可用（对比改 allowedVaults 会吊销）。
- 跨调用：改默认库后旧 `planId` / `uploadId` 仍绑定原库，跨库 apply 被拒（沿用 #642 已有用例）。
- Web 会话：设了账号默认时登录首屏就是该库；手动切换后重载仍是切换后的库；把该库移出 allowlist 后退回账号默认或 `allowedVaults[0]`（不得 500）。
- Admin 门禁：`node scripts/run-admin-layout-checks.mjs` 全绿（含前推后的参照与负控）。

## 我的判断（可推翻）

1. `defaultVaultSource` 枚举改成具体来源，而不是再加一个字段。
2. 只做账号级 + 客户端覆盖；**不做**「按 token / 按 grant」默认库。
3. Web 会话**跟随**账号默认（本次已定 B）；但已登录会话的当前库不被强制切换。
4. 审计补 id 只补这三条（key / client / user），不改历史记录。

## 非目标

- 不改 `allowedVaults` 授权语义；不为 MCP 引入 session 当前库或 `select_vault`（网页的每会话当前库是既有能力，不在本改动里改语义）。
- 不改 API Key 与全局 primary 的现有优先级。
- 不做批量/导入导出。
