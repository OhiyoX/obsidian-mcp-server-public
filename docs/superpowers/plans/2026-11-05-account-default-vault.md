# 账号级默认 Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OAuth 账户（人）能设一个默认 Vault；客户端自己的默认优先，未设置时继承账号；网页登录首屏同样跟随账号默认。

**Architecture:** 复用 #642 的既有链路——`verifyAccessToken()` 每请求现算默认库，`src/default-vault.js` 的 `effectiveVaultId()` 不改；本次只在解析处插入账号层、在 `oauthUsers` 记录上加一个字段、在 Admin 账户抽屉加一个沿用同一 picker 的表单，并让网页登录/会话兜底读同一字段。

**Tech Stack:** Node ESM（node:test）、Admin SSR（无 JS 也可用）、真实 Chromium 门禁（Admin 骨架 + Web 回归）。

**Spec:** `docs/superpowers/specs/2026-11-05-account-default-vault-design.md`

## Global Constraints

- 解析顺序：MCP `显式 vaultId > 客户端默认 > 账号默认 > 全局 primary`；Web `会话记住的库 > 账号默认 > allowedVaults[0] > 全局 primary`。
- 偏好不是授权：默认库**不**扩大 `allowedVaults`；生效值不在 allowlist 时必须 `vault_access_denied`，不静默回退。
- 改默认库**不吊销**任何 token；改 `allowedVaults` 的现有吊销语义不变。
- 缺字段 / `null` = 继承上层；不升 schema 版本，不补写旧记录。
- `server_info.defaultVaultSource` 取值改为 `api-key | client | account | server`。
- Admin 无 JS 契约照旧：GET 表单 + POST + CSRF；文案进两个 catalog（`en.pages.js` / `zh-CN.pages.js` 键集必须相等）。
- 原型参照只前推、不发区域豁免（`docs/admin-ui-proto/README.md`）。

## Review Focus

1. **共享同一账号的多个客户端**：一方设了默认库、另一方没设——没设的那个必须走账号默认，不能串到另一方的库。
2. **改默认库后用旧 handle**：`planId` / `uploadId` 属于原库，跨库 apply/upload 必须拒绝（沿用 #642 用例）。
3. **账户被移出库**：账号默认指向的库从 `allowedVaults` 里被删掉——MCP 必须拒绝，网页必须退回可用库且不 500。
4. **旧数据**：升级前写入的 `oauthUsers` 没有该字段——读起来必须等同「继承」，不能报错、不能让所有人默认库变成 `undefined`。
5. **API Key 与 env Key**：不参与账号层；`configured-env` 的默认库仍只有 primary，不能被账号设置影响。

---

### Task 1: 账户默认库的持久化与 MCP 解析

**Files:**
- Modify: `app/src/oauth/persistence-methods.js`（load 归一 + 新方法 `updateOAuthUserDefaultVault`）
- Modify: `app/src/oauth/protocol-methods.js:243`（`verifyAccessToken` 的 `defaultVaultId` 与新增 `defaultVaultSource`）
- Modify: `app/src/tools/info.js:125`（`defaultVaultSource` 取值）
- Test: `app/test/oauth-account-default-vault.test.js`（新建）

**Interfaces:**
- Produces: `provider.updateOAuthUserDefaultVault(userId: string, defaultVaultId: string | null) -> Promise<boolean>`（`false` = 账户不存在）。
- Produces: `verifyAccessToken()` 返回值新增 `defaultVaultSource: "client" | "account" | null`。
- Produces: `server_info.defaultVaultSource: "api-key" | "client" | "account" | "server"`。

- [ ] **Step 1: 写失败测试**

```js
// app/test/oauth-account-default-vault.test.js —— 复用 test/authorization-transfer-provider.test.js 的 provider 搭建方式
test("client default wins over the account default", async () => {
  const { provider, clientId, userId } = await fixture({ userDefault: "account-vault", clientDefault: "client-vault" });
  const auth = await provider.verifyAccessToken(tokenFor(provider, clientId, userId));
  assert.equal(auth.defaultVaultId, "client-vault");
  assert.equal(auth.defaultVaultLayer, "client");
});

test("an account default applies when the client has none", async () => {
  const { provider, clientId, userId } = await fixture({ userDefault: "account-vault", clientDefault: null });
  const auth = await provider.verifyAccessToken(tokenFor(provider, clientId, userId));
  assert.equal(auth.defaultVaultId, "account-vault");
  assert.equal(auth.defaultVaultLayer, "account");
});

test("neither layer set keeps the pre-existing behaviour", async () => {
  const { provider, clientId, userId } = await fixture({ userDefault: null, clientDefault: null });
  const auth = await provider.verifyAccessToken(tokenFor(provider, clientId, userId));
  assert.equal(auth.defaultVaultId, null);
  assert.equal(auth.defaultVaultLayer, null);
});

test("a legacy account record without the field reads as inherit", async () => {
  const { provider, clientId, userId } = await fixture({ userDefault: undefined, clientDefault: null });
  const auth = await provider.verifyAccessToken(tokenFor(provider, clientId, userId));
  assert.equal(auth.defaultVaultId, null);
});

test("saving an out-of-scope account default is rejected", async () => {
  const { provider, userId } = await fixture({ userDefault: null, clientDefault: null });
  await assert.rejects(() => provider.updateOAuthUserDefaultVault(userId, "not-allowed"), /allowed Vaults/);
});

test("a resolved default outside the token's allowed Vaults is denied, never swapped", async () => {
  // 账户默认在保存后又被移出 allowlist：预授权必须拒绝，不能静默换库。
  const { provider, clientId, userId, token } = await fixture({ userDefault: "beta", clientDefault: null });
  const narrowed = tokenWithAllowedVaults(provider, clientId, userId, ["alpha"]);
  const auth = await provider.verifyAccessToken(narrowed);
  await assert.rejects(() => requestedVaults(auth, undefined), /vault_access_denied|access/i);
});

test("changing the account default does not revoke the account's tokens", async () => {
  const { provider, userId, token } = await fixture({ userDefault: null, clientDefault: null });
  assert.equal(await provider.updateOAuthUserDefaultVault(userId, "alpha"), true);
  await assert.doesNotReject(() => provider.verifyAccessToken(token));
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd app && node --test test/oauth-account-default-vault.test.js`
Expected: FAIL —— `updateOAuthUserDefaultVault is not a function`，以及 `defaultVaultSource` 全为 `undefined`。

- [ ] **Step 3: 实现**

`persistence-methods.js`：
- load 归一里对 `oauthUsers` 每条做 `record.defaultVaultId !== undefined` 时的 `normalizeDefaultVaultId(record.defaultVaultId)`（与 apiKeys/tokens 同一行位置）。
- 新增方法，形状照 `updateOAuthClientDefaultVault`：归一化时传该账户的 `allowedVaults`，写 `defaultVaultId`（`null` = 继承），审计 `oauth.user.default-vault.update` 且 `detail` 写具体 id 或 `inherit`，`await this.save()`，返回 `true`；账户不存在返回 `false`。

`protocol-methods.js` 的 `verifyAccessToken`：`defaultVaultId` 改为
`clientUsage[clientId]?.defaultVaultId ?? oauthUsers[userId]?.defaultVaultId ?? null`，
并新增 `defaultVaultLayer: clientUsage[clientId]?.defaultVaultId ? "client" : (oauthUsers[userId]?.defaultVaultId ? "account" : null)`。

`info.js`：`defaultVaultSource` 改为按 `extra.authInfo` 计算——`type === "api-key"` 且有默认 → `"api-key"`；否则用 `authInfo.defaultVaultLayer`；都没有 → `"server"`。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd app && node --test test/oauth-account-default-vault.test.js test/default-vault.test.js test/server-info-default-vault.test.js`
Expected: 全 PASS（含既有两文件）。

- [ ] **Step 5: 提交**

```bash
git add app/src/oauth/persistence-methods.js app/src/oauth/protocol-methods.js app/src/tools/info.js app/test/oauth-account-default-vault.test.js
git commit -m "feat(mcp): an OAuth account can carry a default Vault, inherited when the client sets none"
```

---

### Task 2: Admin 账户抽屉的默认 Vault 表单

**Files:**
- Modify: `app/src/admin/pages/accounts.js`（抽屉新增一节）
- Modify: `app/src/admin/routes/default-vault.js`（新路由）
- Modify: `app/src/i18n/admin/en.pages.js`、`app/src/i18n/admin/zh-CN.pages.js`
- Test: `app/test/admin-redo/records.test.js` 或新建 `app/test/admin-redo/account-default-vault.test.js`

**Interfaces:**
- Consumes: Task 1 的 `provider.updateOAuthUserDefaultVault`。
- Produces: `POST /admin/auth/oauth/user/default-vault`，表单字段 `id`、`defaultVaultId`、`csrf`；成功 303 回 `accounts`。

- [ ] **Step 1: 写失败测试** —— 渲染账户抽屉时断言：`.dsec` 里出现 `name="defaultVaultId"` 的 `select`，选项含「继承」+ 只含该账户 `allowedVaults` 的库；`allowedVaults` 外的库不出现。POST 路由测试：越权值 400 且未落盘、空值成功、缺 CSRF 拒绝、非管理员拒绝。
- [ ] **Step 2: 跑测试确认红** —— `cd app && node --test test/admin-redo/account-default-vault.test.js`；Expected: `select[name=defaultVaultId]` 数量为 0。
- [ ] **Step 3: 实现** —— 抽屉里加 `div.dsec > h3 + renderDefaultVaultPicker(ctx, { current: account.defaultVaultId ?? null, allowedVaults: account.allowedVaults || [] })` 包在 `form[method=post][action="/admin/auth/oauth/user/default-vault"]` 内并带 `csrf`；路由照 `api-key/default-vault` 的形状（`validateChoice` 复用，值必须在该账户 allowlist 且在 `listVaults()` 清单里），成功 `setFlash` + `redirectTab(res, "accounts")`。文案键：`adm.accounts.defaultVault`、`adm.dv.userUpdated`、`adm.dv.userMissing`。
- [ ] **Step 4: 跑测试确认绿** —— 新增文件 + `test/admin-redo/records.test.js` + `test/i18n-admin-catalog.test.js` 全 PASS。
- [ ] **Step 5: 提交** —— `git commit -m "feat(admin): set an account default Vault from its drawer"`

---

### Task 3: 网页登录与会话跟随账号默认（B）

**Files:**
- Modify: `app/src/app/auth-routes.js:78`
- Modify: `app/src/app/web-session-resolve.js:43-44`
- Test: `app/test/web-session-routes.test.js`（追加用例）

**Interfaces:**
- Consumes: `oauthUsers[userId].defaultVaultId`（Task 1 的字段）。
- Produces: 登录时 `vaultId = user.defaultVaultId ?? user.allowedVaults[0] ?? defaultWebVaultId()`；解析兜底 `账号默认（若仍允许） → allowedVaults[0]`。

- [ ] **Step 1: 写失败测试** —— 三个用例：① 账户默认 `beta`、allowlist `[alpha, beta]`，登录后会话 `vaultId === "beta"`；② 登录后切到 `alpha`，重新解析会话仍是 `alpha`（不被默认拉回）；③ 把 `beta` 移出 allowlist 后解析退回 `alpha`，不得抛错。
- [ ] **Step 2: 跑测试确认红** —— `cd app && node --test test/web-session-routes.test.js`；Expected: ① 拿到 `alpha`。
- [ ] **Step 3: 实现** —— 两处按上面的顺序取值；不改 `selectVault` / `noteSelection` 的语义。
- [ ] **Step 4: 跑测试确认绿** —— 同上命令 + `test/web-session-restart.test.js`。
- [ ] **Step 5: 提交** —— `git commit -m "feat(web): the login session opens the account default Vault when one is set"`

---

### Task 4: Admin 原型参照前推 + 门禁

**Files:**
- Modify: `docs/admin-ui-proto/src/5-render.js`（账户抽屉加同一节）
- Modify: `docs/admin-ui-proto/README.md`（变更表加一行，写明「前推，不豁免」）
- Test: `app/scripts/run-admin-layout-checks.mjs`（既有门禁，不改判据）

- [ ] **Step 1: 跑门禁确认红** —— `cd app && PLAYWRIGHT_MODULE=/usr/local/lib/node_modules/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scripts/run-admin-layout-checks.mjs`；Expected: `proto-shape` 报 accounts 状态多出 live-only 行。
- [ ] **Step 2: 前推参照** —— 在原型 `renderAccounts()` 的抽屉里画同一节（同一 `form.dsec > h3 + select.sel + button` 结构）。
- [ ] **Step 3: 跑门禁确认绿** —— 同一命令；Expected: `admin-layout checks: N/N passed`。
- [ ] **Step 4: 负控** —— 临时删掉原型里那一节，门禁必须红；复原。
- [ ] **Step 5: 提交** —— `git commit -m "docs(admin-proto): push the reference forward for the account default Vault section"`

---

### Task 5: 文档与部署

**Files:**
- Modify: `docs/USER_CONFIGURATION.md`（`server_info` 字段与默认库语义）
- Modify: `docs/multi-vault/W0-E-auth-characterization.md`（`oauthUsers.defaultVaultId` 现状表）
- Test: 无单测；以 Task 1–4 的套件为准

- [ ] **Step 1: 更新两处文档**，写明三层顺序、Web 首屏规则、`defaultVaultSource` 新枚举。
- [ ] **Step 2: 跑定向套件** —— `cd app && node --test test/oauth-account-default-vault.test.js test/default-vault.test.js test/server-info-default-vault.test.js test/web-session-routes.test.js test/admin-redo/account-default-vault.test.js`（全 PASS）+ `npm run check`。
- [ ] **Step 3: 提交** —— `git commit -m "docs: the account default Vault layer and the new server_info source values"`
- [ ] **Step 4: 发布与部署（local-fast）** —— 写回执 `scratch/local-evidence/<sha>/`（定向套件、`npm run check`、Admin 门禁三份 artifact），`release.py publish` + `deploy --apply`，回读 `deployed-version.json` 与生产 `server_info`（`defaultVaultSource` 应为 `server`，因为当前凭证未设默认库）。
