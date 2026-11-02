# W0-C — Cross-call handle inventory（MCP 多库 / vault scope）

> 契约（唯一权威）：`_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md` §13（跨调用 handle 绑定，P0 安全门）、§13.5（other handles）、§22.4（legacy plans/uploads）、§25 W0-C、§36（cross-call security tests）、§44（old-red 清单 6/7）、§47（RETURN 条件）。
> **Wave 0 零行为改变**：本切片只新增 `app/test/multi-vault-handle-binding.test.js` 与本文件；未改 `app/src/**`、`app/frontend/**`、既有测试、`package.json`/lockfile/bundle；未绑 vaultId（绑定属 Wave B5/B6）。

| 项 | 值 |
| --- | --- |
| branch | `test/mv-w0c-handle-inventory` |
| BASE（= 派发冻结 = origin/main） | `6dc8154c6843c426ad40d136ef43e4d1d79d2790` |
| 安全测试 | `app/test/multi-vault-handle-binding.test.js` |
| 红证据（去掉 skip 的真实失败） | `scratch/multi-vault/W0C/red-evidence-{plan,upload,idempotency,journal}.log`、`red-evidence-all-pending.log` |
| 100% 真实源码盘点 | 全部 `file:line` 指向 BASE `6dc8154` 的工作树文件 |

## 0. 结论摘要

| handle 类别 | 现状 vault 绑定 | P0？ | §13 目标形态 |
| --- | --- | --- | --- |
| `planId`（§13.1） | **无**（进程内 Map，仅 author 校验） | ✅ P0 | plan.vaultId + get/apply 校验，mismatch → `VAULT_CONTEXT_MISMATCH`，0 Vault I/O |
| `uploadId`（§13.4） | **无**（全局 `DATA_PATH/transfers/uploads`） | ✅ P0 | metadata.vaultId + start 输出 vaultId；chunk/status/cancel 先校验后 I/O |
| mutation idempotency（§13.2） | **无**（全局 `DATA_PATH/mutation-idempotency`，digest=sha256(key)） | ✅ P0 | per-vault root 或 digest 含 vaultId；记录持久化 vaultId |
| mutation journal（§13.3） | **无**（`schema:1`，无 vaultId，recovery 解析全局 `VAULT`） | ✅ P0 | schema bump + manifest.vaultId；unknown vault fail closed |
| `versionId`（§13.5） | 隐式（相对全局 `HISTORY_PATH`） | ✖（相对 ID） | per-vault history root；在所选 runtime 内解释 |
| trash `backupPath`（§13.5） | 隐式（相对全局 `TRASH_PATH`） | ✖（相对 ID） | per-vault trash root；在所选 runtime 内解释 |
| publish opaque id（§13.5） | **已绑定**（record.vaultId） | ✖ | 保持；anonymous resolve 独立安全模型 |
| search/list `cursor`（§13.5） | 隐式（vault-relative path，无状态） | ✖ | 在所选 runtime 内解释 |
| web tree cursor（§13.5） | **已绑定**（cursor 含 `catalogId`，跨库 fail closed） | ✖ | 保持 |
| skill/package handle（§13.5） | 隐式（vault-relative path） | ✖ | 工具调用统一注入 vaultId |
| archive handle（§13.5） | 隐式（vault-relative path） | ✖ | 工具调用统一注入 vaultId |

P0 四项的可执行行为探针见 `app/test/multi-vault-handle-binding.test.js`；BASE 上 4 个 PENDING 用例的断言均为红（见 §3）。

## 1. P0 handles（§13.1–§13.4）

### 1.1 `planId` — §13.1

| 维度 | 现状（BASE `6dc8154`） |
| --- | --- |
| producer | `src/mutation-plans.js:273` `randomUUID()`（`createNotePlan:232` / `createMovePlan` / `createDeletePlan` / `createRestoreVersionPlan` / `createRestoreTrashPlan`）；public result 由 `publicPlan:220` 组装；MCP 工具 `plan_note_changes`（`src/tools/plans.js:134`）、`get_note_plan:151`、`apply_note_plan:164` |
| consumer | `getNotePlan` `src/mutation-plans.js:359`；`applyNotePlan:368`；工具 `get_note_plan` / `apply_note_plan`；内部 `move_note` / `delete_note` / `restore_*`（`src/tools/links.js`，立即 apply，不外泄 planId） |
| storage | **内存** `const plans = new Map()` `src/mutation-plans.js:33`（TTL 10min，MAX_PLANS 200，`cleanExpired`）；`const appliedIdempotency = new Map()` `:34`。plan 记录字段：`planId, planHash, author, createdAt, expiresAt, expiresAtMs, changes[], warnings`；change 字段含 `path, baseRevision, candidateRevision, absPath, candidateRaw, ...`（`publicPlan:220` 剥掉 `candidateRaw/absPath`） |
| vault binding | **无**。plan 记录与 public result 都没有 `vaultId`；`absPath` 是全局 `VAULT` 下的绝对路径；唯一门是 `sameAuthor`（`src/mutation-plans.js:42`，用于 `getNotePlan:363` / `applyNotePlan:382`） |
| cross-vault 场景 | `planId` 是全局 UUID。多库之后，只被授权 B 的调用方只要拿到 A 的 planId，`get_note_plan`/`apply_note_plan` 只校验 author，仍会 apply A 的绝对路径 → confused deputy（§47「plan/upload handle未 vault-bind」直接 RETURN）。**可执行验证**：测试文件 plan 探针在 BASE 报 `planBinding.ready === false`（public result 无 vaultId）；去掉 skip 后断言红。 |
| 契约 §13 目标 | plan record 加 `vaultId` + relative paths；`get/apply` 要求所选 vaultId === plan.vaultId，mismatch 返回稳定 `VAULT_CONTEXT_MISMATCH` 且 0 Vault I/O；public result 回传 `vaultId`（§13.1/§36.1）；legacy 内存 plan 跨 restart 自然清空（§22.4） |

### 1.2 `uploadId` — §13.4

| 维度 | 现状（BASE `6dc8154`） |
| --- | --- |
| producer | `src/file-transfer.js:80` `startFileUpload`（`randomUUID()` 作 uploadId）；工具 `start_file_upload`（`src/tools/files.js`） |
| consumer | `appendFileUpload` `src/file-transfer.js:107`、`fileUploadStatus:144`、`cancelFileUpload:160`；工具 `upload_file_chunk` / `file_upload_status` / `cancel_file_upload` |
| storage | **磁盘** `DATA_PATH/transfers/uploads/<uploadId>.json` + `<uploadId>.part`（`UPLOADS_PATH` `src/file-transfer.js:27`，`uploadPaths:43`）。metadata schema：`uploadId, vaultPath, totalBytes, uploadedBytes, expectedSha256, overwrite, acceptedOnly, status, createdAt, expiresAt`（`:90`），完成后追加 `completedAt, lastChunkOffset, lastChunkBytes, lastChunkSha256, result` |
| vault binding | **无**。`metadata.vaultPath` 是 vault-relative，finalize 时用全局 `assertTransferVaultPath` → `resolveVaultPath` 落到全局 `VAULT`；`startFileUpload` 输出里没有 `vaultId` |
| cross-vault 场景 | uploadId 是 36 字符 UUID；任何知道它的调用方都能 `file_upload_status` 读元数据、`upload_file_chunk` 追加、finalize 写入 metadata 记录的 `vaultPath`——与调用方本次所选 vault 无关。多库后 = B 作用域调用方写 A 的库（§36.2「start A → chunk B reject before part mutation」的反面）。**可执行验证**：测试文件 upload 探针在 BASE 报 `uploadBinding.ready === false`（metadata 与 start 输出均无 vaultId），红证据真实断言失败。 |
| 契约 §13 目标 | metadata 加 `vaultId`；`start_file_upload` 输出 `vaultId`；status/chunk/cancel 必须 **先**比较所选 vault 与 metadata.vaultId，mismatch 在读写 part file 前拒绝；legacy 无 vaultId 的 metadata → 只允许 primary（§13.4/§22.4/§36.2） |

### 1.3 mutation idempotency — §13.2

| 维度 | 现状（BASE `6dc8154`） |
| --- | --- |
| producer | 调用方传 `idempotencyKey`（`apply_note_plan`，`src/tools/plans.js`）；`src/mutation-plans.js:372` `idempotencyDigest(idempotencyKey)`；`src/mutation-idempotency.js:40` = `sha256(key)`，**不含 vault** |
| consumer | `applyNotePlan` replay 检查 `src/mutation-plans.js:373-375`；`readAppliedRecord` `src/mutation-idempotency.js:44`；`atomicWriteBatch` 前置检查 `src/batch-write.js:24`；journal 完成后补写 `src/batch-journal.js:374`（`saveAppliedRecord`） |
| storage | **内存** `appliedIdempotency` Map `src/mutation-plans.js:34`；**磁盘** `DATA_PATH/mutation-idempotency/<digest>.json`（root `src/mutation-idempotency.js:6`，`saveAppliedRecord:64`）。schema：`{schema:1, digest, planId, planHash, author, unchanged, appliedAt, expiresAtMs, result}`（写入 `:81`，校验 `:55`） |
| vault binding | **无**。key 空间全局；digest 只喂 key；记录无 vaultId；root 无 vault 维度 |
| cross-vault 场景 | 同一个 `idempotencyKey` 在 A/B 是**同一个**命名空间：A 提交后，B 用同 key 的 replay 会命中 A 的记录并被当作 A 的重放（`applyNotePlan:374-375` 校验 planId/planHash/author，否则报「already used for another plan」）。这正是 §36.3 要求「A/B 独立」的反面。**可执行验证**：测试文件 idempotency 探针在 BASE 中 `savedUnderB === false`（第二次 save 被全局 digest 冲突拒绝），落盘记录数 1、无 `vaultId`；红证据真实断言失败。 |
| 契约 §13 目标 | idempotency 必须 per-vault：storage root per-vault（推荐）**或** digest 显式含 vaultId；persisted record 仍写并校验 `vaultId`；A 的 replay 永不能在 B 返回（§13.2/§36.3）；schema 1 视为 primary namespace（§22.4） |

### 1.4 mutation journal — §13.3

| 维度 | 现状（BASE `6dc8154`） |
| --- | --- |
| producer | `src/batch-journal.js:31` `beginBatchJournal` → `DATA_PATH/mutation-journal/<uuid>/manifest.json`（root `:10`，`save:24`）；调用方 `atomicWriteBatch`（`src/batch-write.js:24`） |
| consumer | `setBatchJournalState` `src/batch-journal.js:68`、`finishBatchJournal:330`、`recoverPendingBatches:399`（`recoverUnlocked:383`）；startup 入口 `server.js:27` |
| storage | **磁盘** `DATA_PATH/mutation-journal/<uuid>/`：`manifest.json`（`schema:1, state, idempotency, entries[]`，`src/batch-journal.js:38`）+ `backup-N`。entry 字段：`path, existed, delete, trash, consumeTrash, before, after, backup, temp, history, historyName`（`:38-47`） |
| recovery 入口 | `recoverPendingBatches`（`src/batch-journal.js:399`，持 `withMutationLock`）→ 遍历 root 每个 36-hex 目录 → 必须存在 `manifest.json` → `finishBatchJournal`。**entry 路径解析**：`itemPaths` 用 `path.resolve(VAULT, item.path)`（`src/batch-journal.js:88`），trash 用 `TRASH_PATH`；全部是全局单例 |
| vault binding | **无**。manifest 无 `vaultId`；recovery 不做 registry 查找，直接把每个 entry 解到全局 `VAULT` |
| cross-vault 场景 | 单库时不成立；多库后 manifest 无法说明 journal 属于哪个 vault，recovery 只能按全局 primary 解——正是 §13.3 禁止的「绝不 fallback primary」。若 A 的 journal 被当作 primary 回滚，会把 A 的 `before` 字节写进 primary 同名路径。**可执行验证**：测试文件 journal 探针在 BASE 报 `journalBinding.ready === false`（manifest `schema === 1`、无 `vaultId`）；红证据真实断言失败。 |
| 契约 §13 目标 | journal schema bump，manifest 必须写 `vaultId`；recovery 先解析 manifest → 对应 registered runtime；unknown/missing Vault → fail closed、保留 journal、报 operator-visible error、绝不 fallback primary（§13.3/§36.4）；schema 1 only-primary（§22.4） |

## 2. §13.5 other handles

### 2.1 `versionId`（history）

- producer：`src/vault.js:224` `createVersionSnapshot`（路径 `:227-237`；返回相对 `HISTORY_PATH` 的 id）；`listFileVersions:240`（产出 `versionId` `:251`）；写入工具响应含 `preWriteVersionId`（`src/vault.js:202,217`）。工具：`list_versions`（`src/tools/links.js`）。
- consumer：`readFileVersion` `src/vault.js:256`、`restoreFileVersion:277`、`deleteFileVersion:466`；工具 `restore_version`/`delete_version`（`src/tools/links.js:176,205`）；plan 工具 `plan_restore_version`/`get_note_version`/`compare_note_versions`（`src/tools/plans.js`）。
- storage：**磁盘** `HISTORY_PATH = DATA_PATH/history`（`src/config.js:29`）；`versionId = <vault-relative note path>/<timestamp>-<uuid>.bak`，相对 `HISTORY_PATH`。
- vault binding：**隐式**（相对全局 `HISTORY_PATH`）；不是 opaque durable token，而是「vault-relative note path + 文件名」，在每次调用时重解。
- cross-vault 场景：`readFileVersion(versionId)` 不触碰 vault；多库后若 history 仍在全局 root，A、B 的同名笔记会共用 `<note path>` 前缀，B 作用域调用方可用 A 的 versionId 读/删 A 的历史；`restore_version` 还会把内容落到全局 `VAULT`。**源码推演，未跨两库执行**（BASE 是单库 runtime，见 §4）。
- 契约 §13 目标：per-vault history root（§5.2 dataKey 布局），在所选 runtime 内解释该相对 ID；§13.5 原则「纯 per-vault relative ID 在当前 request runtime 内解释即可」，因此不需要 versionId 内嵌 vaultId，需要的是 root 归属。

### 2.2 trash `backupPath`

- producer：`src/vault.js:373` `const backupPath = path.join(TRASH_PATH, timestamp, rel)`；`listTrashEntries:379`（产出 `backupPath` `:397,:404`）。工具 `list_trash`（`src/tools/links.js`），删除结果也回传 `backupPath`。
- consumer：`readTrashEntry:410`、`restoreTrashEntry:427`、`deleteTrashEntry:455`（`src/tools/links.js:117` 起）；`plan_restore_from_trash`（`src/mutation-plans.js`）。
- storage：**磁盘** `TRASH_PATH = DATA_PATH/trash`（`src/config.js:28`）；`backupPath = <timestamp>/<vault-relative path>`。
- vault binding：**隐式**（相对全局 `TRASH_PATH`）。
- cross-vault 场景：与 versionId 同型——B 作用域调用方可用 A 的 backupPath 删/恢复 A 的 trash 条目；`restoreTrashEntry` 的 destination 解到全局 `VAULT`。**源码推演，未跨两库执行**。
- 契约 §13 目标：per-vault trash root；相对 ID 在所选 runtime 内解释。

### 2.3 publish opaque id（含 anonymous resolve）

- producer：`src/publish/service.js:105` `publish()` → `id: randomBytes(32).toString("base64url")`（`:111`）；`publicRecord:22` 输出 `{id, vaultId, path, createdAt, updatedAt, createdBy}`；`encodeDocumentRoute:33`/`decodeDocumentRoute:38` 产出内嵌 `{v:1, vaultId, path}` 的 base64url 路由 token（privatePath 用）。
- consumer：`PublishService.resolve(id)` `src/publish/service.js:152`（按 id 查记录 → `resolveWebVault(record.vaultId)` → `readWebNote`）；`revokeById:140`；`list({vaultIds}):167`；`src/tools/publish.js:8` `allowedVaults` + `:13` `targetVault`（credential allowlist），`payload:22` 输出 `publicPath = /publish/<record.id>`。
- storage：**磁盘** `DATA_PATH/publish/state.json`（`DEFAULT_FILE` `src/publish/service.js:8`，`version:1, records[]`），`documentKey(vaultId, path)` 唯一（`:18`）。
- vault binding：**已绑定**。记录含 `vaultId`；`resolve` 复查 `vault.id !== record.vaultId → null`（`:158`）fail closed。
- cross-vault 场景：MCP/Web 侧由 `allowedVaults` 门（`src/tools/publish.js:8-16`）挡住越库；**anonymous `/publish/<id>` resolve 刻意绕过 credential allowlist**，是公开能力——记录自带的 vaultId 决定解析到哪个库，调用方无法用 id 把解析重定向到别的库。符合 §13.5「保持其独立安全模型」。
- 契约 §13 目标：无需再加绑定；A3 只需把 `src/tools/publish.js:41,59` 的局部手写 `vaultId` schema 收编为统一 canonical schema。

### 2.4 search / list cursor

- producer：`list_notes`（`src/tools/search.js:29` input `cursor`，`:41` `nextCursor`）、`list_files`（`src/tools/files.js:53`，`:64`）。底层 `walk` `src/vault.js:307` 的 `afterPath`（`:336,:346`，字典序 `rel > afterPath`）。
- consumer：同一工具的下一次调用。
- storage：**无**（无状态）；cursor 就是上一次返回的 vault-relative path。
- vault binding：**隐式**。`walk(startAbs)` 从所选 vault 的目录起走（`assertCanonicalInsideVault` `src/vault.js:319`），A 的 cursor 在 B 只影响 B 自己的分页位置，不会读到 A 的文件。
- cross-vault 场景：最坏是分页错位（同名路径），不是越权读。**源码推演**；跨两库执行留到 Wave A/B 的 runtime 后。
- 契约 §13 目标：§13.5「纯 per-vault relative ID 在当前 request runtime 内解释即可」→ 无需 cursor 内嵌 vaultId，需要 walk root = 所选 runtime。

### 2.5 web tree cursor（Web 域）

- producer：`encodeWebCatalogCursor` `src/app/web-catalog/cursor.js:35`，v4 payload 明确包含 `catalogId`（`:7`，校验 `:66`）；`encodeBaseCursor` `src/app/base-cursor.js:56`，payload 含 `catalogId`（`:63`）。
- consumer：`childrenQuery` `src/app/web-catalog/children-query.js:39-48`（`decoded.catalogId !== catalogId` → `WEB_CATALOG_CURSOR_STALE`，注释即「cross-Vault cursors fail closed」`children-query.js:45-47`）；`src/app/base-route.js:81` decode + `:113-125` `assertBaseCursorMatches`。
- storage：**无**（base64url token）。
- vault binding：**已绑定**（per-vault catalog identity）。
- cross-vault 场景：A 的 catalog cursor 在 B 的 catalog 上 fail closed（409 stale），不产生跨库读。**可执行验证**：测试文件绿例 `Web-domain cursors already carry a per-vault catalog identity (§13.5 cross-validation)` 用真实 encode/decode 模块断言 `catalogId` 被携带。
- 契约 §13 目标：无改动。

### 2.6 skill/package handle（`skillPackagePath` / vault-relative skill path）

- producer：`exportSkillPackage` `src/skills.js:188` → 返回 `path: toVaultPath(destinationAbs)`（`:210`，默认 `SKILLS_PATH/_packages/`，`src/config.js:77`）；工具 `skill_export`（`src/tools/intelligence.js:155`）。
- consumer：`skill_validate`（vault-relative path）；`skill_import`（`src/tools/intelligence.js:162`）→ `importSkillPackage` `src/skills.js:241` 消费 `archivePath`（`:260`）。
- storage：vault-relative ZIP 路径，落在所选 vault 内；`executionAuthorized:false`（`src/skills.js:159,210,260` —— 无执行面）。
- vault binding：**隐式**（vault-relative path，每次调用在所选 vault 内重解）。
- cross-vault 场景：跨库复用同一路径字符串只会在**目标**库解析（可能不存在）→ 不是 confused deputy。§13.5 归为 path reference。
- 契约 §13 目标：工具调用统一注入 `vaultId`（A3），不需要持久 handle 绑定。

### 2.7 archive handle（`archivePath`）

- producer：`create_archive`（`src/tools/files.js:333` destination）→ `createZipArchive` `src/file-transfer.js:283`。
- consumer：`inspect_archive` → `inspectZipFile` `src/file-transfer.js:298`；`extract_archive` → `extractZipArchive:306`（工具 `src/tools/files.js:371-372`）；`read_archive_entry`（工具 `src/tools/files.js:367-382`，main #300 新增，PR 组装时补记）；`skill_import` 亦消费 `archivePath`。
- storage：vault-relative ZIP 路径（所选 vault 内）。
- vault binding：**隐式**；`assertTransferVaultPath`（`src/file-transfer.js:51`）→ `resolveVaultPath` + `assertCanonicalInsideVault` 保证 extraction destination 不越出所选 root。
- cross-vault 场景：路径在所选 vault 内重解；`extractZipArchive` 的 `destinationDirectory` 同样被 containment 约束 → 无跨库写。**源码推演**。
- 契约 §13 目标：工具调用统一注入 `vaultId`。

## 3. old-red 安全测试与 §36 对应（`app/test/multi-vault-handle-binding.test.js`）

BASE 上 4 个 PENDING 用例，skip 理由均含契约条款号；探针在 module scope 真实执行生产模块，**无「文件缺失就 return」的假绿**。激活条件在每次运行时重算，无需改测试。

| 用例 | §36 组 | 探针（真实行为） | BASE 观测 | 红证据 |
| --- | --- | --- | --- | --- |
| plan public result is bound to the creating vault (§13.1) | §36.1 | `createNotePlan` 的 public result 是否有 `vaultId` | 无（`observed: null`） | `red-evidence-plan.log` |
| upload metadata and start result are bound to the creating vault (§13.4) | §36.2 | 落盘 `transfers/uploads/<id>.json` 与 `startFileUpload` 输出是否有 `vaultId` | 均无 | `red-evidence-upload.log` |
| mutation idempotency key space is per-vault (§13.2) | §36.3 | 同 key/同 digest 在 A、B vault 上下文下 save 两次；统计落盘记录与各记录 `vaultId` | 第二次 save 被拒（全局 digest 冲突），仅 1 条记录、无 vaultId | `red-evidence-idempotency.log` |
| mutation journal manifest records its vault (§13.3) | §36.4 | `beginBatchJournal` 真实 manifest 是否有 `vaultId`、schema 是否 bump | `schema: 1`、无 vaultId | `red-evidence-journal.log` |

交叉验证绿例（证明探针跑在真实模块上、非空转）：plan 取回、upload status/cancel、idempotency durable replay、journal manifest 结构、Web cursor catalogId。
预期计数：`tests 9 / pass 5 / fail 0 / skipped 4`；红证据全开时 `tests 9 / pass 5 / fail 4 / skipped 0`（4 组均为真实 `AssertionError`，非 import 崩）。

**§44 old-red 6/7**：item 6「plan 未绑定 vaultId」= 上表第 1 行；item 7「upload metadata 未绑定 vaultId」= 上表第 2 行。二者在 BASE 均红；B5/B6 合流后由协调方重跑，确认 `skip → pass`。

## 4. 未证实 / 边界（诚实清单）

1. **`versionId` / trash `backupPath` 的跨库越权未执行**：BASE 是单库 runtime（`VAULT_PATH` 单例，无 secondary registry），无法真实构造「A 的 versionId/backupPath 被 B 调用」。目前是 §2.1/§2.2 的源码推演。**下一步**：Wave A/B 的 per-vault runtime 落地后，用两个 registered vault 各造一份同名笔记/trash 条目，断言 A 的相对 id 在 B 上下文解析不到 A 的字节（或 fail closed）。
2. **`idempotency` 探针假设 §13.2 的推荐形态（per-vault storage root）**：若 B6 改走「digest 显式含 vaultId」而 storage root 不变，则本探针里直接调 `saveAppliedRecord({digest})` 的 A/B 场景需改为经生产调用方（`applyNotePlan`）驱动；激活门与断言需随之对账。已在测试文件内注释标明。
3. **`beginBatchJournal` 的 vault 来源**：探针在 `withRequestContext({vaultId})` 下调用 journal writer。若 B6 把 vaultId 作为显式参数或放到 `atomicWriteBatch` 层注入，探针调用点需相应调整（manifest 字段断言不变）。
4. **cursor 跨库行为未跨两库执行**：search/list cursor 与 archive/skill path 的「无 confused deputy」结论是源码推演（root = 所选 runtime）。**下一步**：Wave A/B 后加两库声明式对照。
5. **`server_info` / auth 的 vault 视图**不在本刀（属 W0-E）。本刀不碰 `auth.js`。

## 5. 与 W0-B 的对账（§1.3）

对照 `docs/multi-vault/W0-B-tool-inventory.md`（W0-B 分支交付）§4 handle 词表：

- 一致：`planId`、`uploadId`、`versionId`、`backupPath`、`idempotencyKey`、`cursor`（list_notes/list_files）、`publishId`、`archivePath`、`skillPackagePath` 的产出/消费方向与存储归属。
- 差异 1（补充，非冲突）：W0-B §5 称仓库里「唯一的不透明分页游标」是 `src/app/base-cursor.js`。实际有**两族** Web cursor——Base 读 API 的 `base-cursor.js` 与 Web Catalog tree 的 `src/app/web-catalog/cursor.js`（v4，`catalogId` 绑定，`children-query.js:45-47` fail closed）。两族都已 vault-scoped。本刀在 §2.5 补齐第二族。
- 差异 2（W0-B 引用笔误，未改 W0-B 文件）：W0-B §3 备注把 `list_trash`/`list_versions` 的 handle 归到「§13.5 / §44.6」。契约 §44 的 item 6 是 **plan 未绑定 vaultId**、item 7 是 **upload metadata 未绑定 vaultId**，与 trash/version 无关。本刀按 §13.5（相对 ID）表述，未引用 §44.6。

## 6. 交给下游的绑定设计要点（B5/B6 / A3）

1. **B5（plan）**：`plan.vaultId` 必填；`publicPlan` 回传 `vaultId`；`getNotePlan`/`applyNotePlan` 在 `sameAuthor` 之前或同时校验所选 vaultId，mismatch → `VAULT_CONTEXT_MISMATCH` 且**在任何 fs 调用前**返回。
2. **B6（upload / idempotency / journal）**：upload metadata 与 start 输出加 `vaultId`，chunk/status/cancel 先校验后 I/O，legacy 无 vaultId → primary only；idempotency 采用 per-vault root 或 vault-aware digest，记录写 `vaultId`；journal `schema: 2` + `manifest.vaultId`，recovery 由 manifest 解析 registered runtime，unknown → fail closed 保留 journal。
3. **A3（scope registry）**：统一 canonical `vaultId` schema 后，`versionId`/`backupPath`/`archivePath`/`skillPackagePath`/`cursor` 作为相对引用随所选 runtime 解释；publish 的局部手写 schema（`src/tools/publish.js:41,59`）收编进 registry。
4. **本刀不改**：`auth.js`、`app/src/**`、bundle；不实现绑定。
