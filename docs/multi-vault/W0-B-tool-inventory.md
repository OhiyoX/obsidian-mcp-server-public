# W0-B — Canonical tool inventory matrix（MCP 多库 / vault scope）

> 契约（唯一权威）：`_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md` §7 / §13.5 / §25 W0-B / §35 / §43 / §44。
> **Wave 0 零行为改变**：本切片只新增测试、冻结数据模块与本文件；未改 `app/src/**`、`app/frontend/**`、既有测试、`package.json`/lockfile/bundle，未新增工具（tool count 不变，§7.4）。

| 项 | 值 |
| --- | --- |
| branch | `test/mv-w0b-tool-inventory` |
| BASE_SHA（= 派发冻结 = 生成时 origin/main） | `6dc8154c6843c426ad40d136ef43e4d1d79d2790` |
| 冻结数据模块 | `app/test/helpers/multi-vault-tool-classification.js` |
| 契约测试 | `app/test/multi-vault-tool-inventory.test.js` |
| 生成器 | `scratch/multi-vault/W0B/gen-tool-inventory.mjs`（lane 目录，与 `worktree/` 同级；sha256 `158ec454bb463eba6af93e2860c6722826d52e1bbdacd9a5c94c90087b637aba`） |
| 生成命令 | `cd scratch/multi-vault/W0B && node gen-tool-inventory.mjs`（node 22+，离线、只读源码、无网络/无时钟/无写入依赖） |

## 1. 方法与可复现性

1. **工具集合与真实注册路径（不手抄名单）**：测试构造捕获壳（`registerTool(name, config, handler)` 收集名字；`registerResource`/`registerPrompt` 空实现）并调用 `registerObsidianCapabilities(server)`（`app/src/capabilities.js`），即生产注册链（discovery → memory-guidance → handlers）。断言捕获集合精确等于 `TOOL_NAMES`，且含 `get_note`/`server_info`/`apply_note_plan` 等正控以防「捕获为空」假绿。
2. **module 列双向实证**：逐 `register*Tools(server)` 单模块捕获（与 `capability-catalog.test.js` 同顺序）得到 module → tools；再对 `app/src/tools/*.js` 做源码扫描（正则 `registerTool\(\s*["'][A-Za-z0-9_]+["']`）得到 name → files。两边都必须与分类表单元素一致；任一错标/重复注册即红。
3. **scopes 列与读写类（脚本生成，不手抄）**：直接读 `app/src/scopes.js` 的 `MCP_TOOL_SCOPE_REQUIREMENTS`（`scopes.js` 自身在 registry 与 TOOL_NAMES 失同步时 throw）。本文件的 scopes 列与 read/write/files 标记均由生成器输出。
4. **surface 冻结**：契约 §7.1 冻结 global = `{agent_bootstrap, server_info}`；其余全部 vault-scoped。测试断言分类表中 global 集合精确等于该二元组且与 vault-scoped 无交集。
5. **handle 列**：只收录**跨调用** handle（§13.5）：不透明持久 id（planId/uploadId/versionId/backupPath/publishId/idempotencyKey）与按当次所选 vault 重新解析的 vault-relative 路径引用（cursor/archivePath/skillPackagePath）。方向以 `→`（产出）/ `←`（消费）标注；证据见 §4。

## 2. 计数对账

| 来源 | 值 |
| --- | --- |
| `TOOL_NAMES.length`（`app/src/config.js`） | 87 |
| `registerObsidianCapabilities` 捕获（去重后） | 87（测试断言精确相等） |
| `app/src/tools/*.js` 源码扫描注册数 | 87 |
| 分类表条目 | 87 |
| global | 2 |
| vault-scoped | 85 |
| `MCP_TOOL_SCOPE_REQUIREMENTS` 条目 | 87 |

**结论：87/87 canonical tools 100% 有分类（契约 §25 W0-B）。** 与契约 §1 记录的「86 个工具、11 个 tools 模块」在刀内基线（6dc8154）一致；PR 组装时 main #300 注册了第 87 个工具 `read_archive_entry`，本表按其同构补齐（协调方适配，未改任何 production）。

## 3. Canonical matrix

工具按 `TOOL_NAMES` 顺序排列。

| tool | surface | required scopes | stateful handle | 读写类 | module | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `agent_bootstrap` | global | obsidian.read | — | read | `src/tools/info.js` | global metadata plane（§7.1）；只写 session author，无跨调用 handle |
| `server_info` | global | obsidian.read | — | read | `src/tools/info.js` | global metadata plane（§7.1）；tool 视图按凭证过滤（§18.1） |
| `get_note` | vault-scoped | obsidian.read | — | read | `src/tools/notes.js` | 返回 `revision`；写入工具的 `ifMatch` 前置条件不计入 stateful handle（§5） |
| `pull_note_file` | vault-scoped | obsidian.read, obsidian.files | — | read+files | `src/tools/files.js` |  |
| `get_metadata` | vault-scoped | obsidian.read | — | read | `src/tools/notes.js` |  |
| `list_notes` | vault-scoped | obsidian.read | ← cursor, cursor → | read | `src/tools/search.js` | `cursor` = `nextCursor` 路径游标（§13.5 search cursor） |
| `list_files` | vault-scoped | obsidian.read | ← cursor, cursor → | read | `src/tools/files.js` | `cursor` = `nextCursor` 路径游标（§13.5 search cursor） |
| `list_recent` | vault-scoped | obsidian.read | — | read | `src/tools/search.js` |  |
| `search_notes` | vault-scoped | obsidian.read | — | read | `src/tools/search.js` |  |
| `get_file` | vault-scoped | obsidian.read, obsidian.files | — | read+files | `src/tools/files.js` |  |
| `pull_file` | vault-scoped | obsidian.read, obsidian.files | — | read+files | `src/tools/files.js` |  |
| `write_file` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/files.js` | `ifMatch` = revision 前置条件；响应含 `preWriteVersionId` |
| `start_file_upload` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | uploadId → | read+write+files | `src/tools/files.js` | upload 元数据在全局 `DATA_PATH/transfers/uploads`，当前未绑 vaultId（§1.8 / §44.7） |
| `file_upload_status` | vault-scoped | obsidian.read, obsidian.files | ← uploadId | read+files | `src/tools/files.js` | 同上；只凭 uploadId 读全局 transfer 元数据 |
| `upload_file_chunk` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | ← uploadId | read+write+files | `src/tools/files.js` | 同上；finalize 时按元数据里的 vault-relative path 落盘 |
| `cancel_file_upload` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | ← uploadId | read+write+files | `src/tools/files.js` | 同上 |
| `create_archive` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | archivePath → | read+write+files | `src/tools/files.js` | `archivePath` 为 vault-relative ZIP 路径（当次 vault 内解析） |
| `inspect_archive` | vault-scoped | obsidian.read, obsidian.files | ← archivePath | read+files | `src/tools/files.js` | 消费 vault-relative ZIP 路径 || `read_archive_entry` | vault-scoped | obsidian.read, obsidian.files | ← archivePath | read+files | `src/tools/files.js` | 读取 ZIP 内单条目（不解包）；消费 vault-relative ZIP 路径（#300 新增） |

| `extract_archive` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | ← archivePath | read+write+files | `src/tools/files.js` | 消费 vault-relative ZIP 路径 |
| `get_canvas` | vault-scoped | obsidian.read | — | read | `src/tools/files.js` |  |
| `write_canvas` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/files.js` |  |
| `write_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/notes.js` | `ifMatch` 前置条件；响应含 `preWriteVersionId` |
| `append_to_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/notes.js` | `ifMatch` 前置条件；响应含 `preWriteVersionId` |
| `patch_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/notes.js` | `ifMatch` 前置条件；响应含 `preWriteVersionId` |
| `replace_in_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/notes.js` | `ifMatch` 前置条件；响应含 `preWriteVersionId` |
| `manage_frontmatter` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/notes.js` |  |
| `list_tags` | vault-scoped | obsidian.read | — | read | `src/tools/search.js` |  |
| `manage_tags` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/notes.js` |  |
| `move_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/links.js` | 内部创建并立即 apply 计划；planId 不外泄（§13.1） |
| `delete_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/links.js` | 内部创建并立即 apply 计划；planId 不外泄（§13.1） |
| `list_trash` | vault-scoped | obsidian.read | backupPath → | read | `src/tools/links.js` | `backupPath` 相对全局 `TRASH_PATH`（§13.5） |
| `restore_from_trash` | vault-scoped | obsidian.read, obsidian.write | ← backupPath | read+write | `src/tools/links.js` | 消费 `backupPath`；Markdown 走内部 plan；非 md 直接恢复（§13.1） |
| `delete_trash_entry` | vault-scoped | obsidian.read, obsidian.write | ← backupPath | read+write | `src/tools/links.js` | 消费 `backupPath`；直接删全局 trash 条目 |
| `list_versions` | vault-scoped | obsidian.read | versionId → | read | `src/tools/links.js` | `versionId` 相对全局 `HISTORY_PATH`（§13.5） |
| `restore_version` | vault-scoped | obsidian.read, obsidian.write | ← versionId | read+write | `src/tools/links.js` | 消费 `versionId`；Markdown 走内部 plan；非 md 直接恢复 |
| `delete_version` | vault-scoped | obsidian.read, obsidian.write | ← versionId | read+write | `src/tools/links.js` | 消费 `versionId`；直接删全局 history 条目 |
| `manage_folders` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/files.js` |  |
| `get_backlinks` | vault-scoped | obsidian.read | — | read | `src/tools/links.js` |  |
| `get_graph` | vault-scoped | obsidian.read | — | read | `src/tools/links.js` |  |
| `get_unresolved_links` | vault-scoped | obsidian.read | — | read | `src/tools/links.js` |  |
| `get_orphans` | vault-scoped | obsidian.read | — | read | `src/tools/links.js` |  |
| `get_deadends` | vault-scoped | obsidian.read | — | read | `src/tools/links.js` |  |
| `list_tasks` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` |  |
| `update_task` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/workflows.js` |  |
| `daily_note` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/workflows.js` | 读 `.obsidian/daily-notes.json` + 模板；vault-relative 路径 |
| `list_templates` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` |  |
| `create_from_template` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/workflows.js` | 读 `.obsidian/templates.json`；vault-relative 路径 |
| `list_properties` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` |  |
| `list_aliases` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` |  |
| `rename_property` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/workflows.js` |  |
| `set_property_type` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/workflows.js` | 写 `.obsidian/types.json`（vault 内配置） |
| `list_bases` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` |  |
| `get_base` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` |  |
| `write_base` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/workflows.js` |  |
| `query_base` | vault-scoped | obsidian.read | — | read | `src/tools/workflows.js` | 无 cursor：Web Base 游标在 `src/app/base-cursor.js`，不属 MCP 工具（§5） |
| `git_status` | vault-scoped | obsidian.read | — | read | `src/tools/git.js` | 全局 GitRuntime 单例（§1.9 / §44.8） |
| `git_diff` | vault-scoped | obsidian.read | — | read | `src/tools/git.js` | 全局 GitRuntime 单例 |
| `git_log` | vault-scoped | obsidian.read | — | read | `src/tools/git.js` | 全局 GitRuntime 单例 |
| `git_commit` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/git.js` | 全局 GitRuntime 单例；`paths` 为 vault-relative 路径 |
| `git_pull` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/git.js` | 全局 GitRuntime 单例 |
| `git_push` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/git.js` | 全局 GitRuntime 单例 |
| `index_status` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` | 全局 retrieval/index 单例（§1.6） |
| `reindex_vault` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` | 全局 retrieval/index 单例 |
| `recall` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` |  |
| `find_related` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` |  |
| `get_note_context` | vault-scoped | obsidian.read | — | read | `src/tools/context.js` | 薄适配 `context-service.js`；只读（semantic 可能触发 embedding，openWorld） |
| `graph_health` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` |  |
| `suggest_links` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` |  |
| `memory_capture` | vault-scoped | obsidian.read, obsidian.write | — | read+write | `src/tools/intelligence.js` | 写 `MEMORY_PATH` 受管区域（config 默认取 vaultLayout.memory） |
| `memory_recall` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` | 限定 `MEMORY_PATH` 前缀的 recall |
| `skill_list` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` | 扫描受管 skills 根（SKILLS_PATH） |
| `skill_match` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` | 受管 skills 根 + recall |
| `skill_validate` | vault-scoped | obsidian.read | — | read | `src/tools/intelligence.js` | 校验单个 skill 包（vault-relative path） |
| `skill_export` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | skillPackagePath → | read+write+files | `src/tools/intelligence.js` | `skillPackagePath` 为 vault-relative ZIP（默认 `SKILLS_PATH/_packages/`） |
| `skill_import` | vault-scoped | obsidian.read, obsidian.write, obsidian.files | ← archivePath | read+write+files | `src/tools/intelligence.js` | 消费 vault-relative skill ZIP 路径 |
| `get_publish_status` | vault-scoped | obsidian.read | publishId → | read | `src/tools/publish.js` | 已手写 `vaultId`（§7.3 待收编）；输出含 publish record id（`publicPath`） |
| `manage_publish` | vault-scoped | obsidian.read, obsidian.write | publishId → | read+write | `src/tools/publish.js` | 已手写 `vaultId`；产出 publish record id；anonymous 解析独立模型（§13.5） |
| `plan_note_changes` | vault-scoped | obsidian.read | planId → | read | `src/tools/plans.js` |  |
| `plan_move_note` | vault-scoped | obsidian.read | planId → | read | `src/tools/plans.js` |  |
| `plan_delete_note` | vault-scoped | obsidian.read | planId → | read | `src/tools/plans.js` |  |
| `plan_restore_version` | vault-scoped | obsidian.read | ← versionId, planId → | read | `src/tools/plans.js` | 消费 `versionId` 并产出 `planId` |
| `plan_restore_from_trash` | vault-scoped | obsidian.read | ← backupPath, planId → | read | `src/tools/plans.js` | 消费 `backupPath` 并产出 `planId` |
| `get_note_plan` | vault-scoped | obsidian.read | ← planId | read | `src/tools/plans.js` | 消费 `planId`；进程内 plan Map（§13.1 / §44.6） |
| `apply_note_plan` | vault-scoped | obsidian.read, obsidian.write | ← planId, ← idempotencyKey | read+write | `src/tools/plans.js` | 消费 `planId` + `idempotencyKey`（+ `planHash` 前置条件）；幂等记录在全局 `DATA_PATH/mutation-idempotency`（§13.2） |
| `get_note_version` | vault-scoped | obsidian.read | ← versionId | read | `src/tools/plans.js` | 消费 `versionId` |
| `compare_note_versions` | vault-scoped | obsidian.read | ← versionId | read | `src/tools/plans.js` | `left`/`right` 的 `kind=version` 分支消费 `versionId` |

## 4. Handle 词表与证据（file:line）

| token | 类别 / 存储 | 产出工具 | 消费工具 | 源码证据 |
| --- | --- | --- | --- | --- |
| `planId` | 不透明持久 id；`mutation-plans.js` 进程内 `plans` Map（TTL） | `plan_note_changes`, `plan_move_note`, `plan_delete_note`, `plan_restore_version`, `plan_restore_from_trash` | `get_note_plan`, `apply_note_plan` | `app/src/mutation-plans.js:33-34`（plans/appliedIdempotency Map）、`:273`（`randomUUID()`）、`:289`（`plans.set`）、`:359-361`（`getNotePlan`） |
| `uploadId` | 不透明持久 id；全局 `DATA_PATH/transfers/uploads` | `start_file_upload` | `file_upload_status`, `upload_file_chunk`, `cancel_file_upload` | `app/src/file-transfer.js:27`（`UPLOADS_PATH`）、`:43-48`（uploadId→file）、`:88`（`randomUUID()`） |
| `versionId` | 不透明持久 id；相对全局 `HISTORY_PATH` | `list_versions` | `restore_version`, `delete_version`, `plan_restore_version`, `get_note_version`, `compare_note_versions` | `app/src/vault.js:227-237`（快照路径/版本 id）、`:251`（`listFileVersions` 产出）、`:256-259`、`:466-470` |
| `backupPath` | 不透明持久 id；相对全局 `TRASH_PATH` | `list_trash` | `restore_from_trash`, `delete_trash_entry`, `plan_restore_from_trash` | `app/src/vault.js:145-153`（trash 解析/相对化）、`:373-376`（`<timestamp>/<rel>`）、`:397`、`:410-412` |
| `idempotencyKey` | 调用方提供的不透明幂等键；全局 `DATA_PATH/mutation-idempotency` | — | `apply_note_plan` | `app/src/mutation-plans.js:368-403`（replay/记录）、`app/src/mutation-idempotency.js:4-6`、`:38`、`:112` |
| `cursor` | vault-relative 路径游标（`nextCursor`）；无服务端状态 | `list_notes`, `list_files` | `list_notes`, `list_files` | `app/src/tools/search.js:29`（input）、`:41`（nextCursor）；`app/src/tools/files.js:53`、`:64` |
| `publishId` | publish record id（`publicPath`/`publicUrl` 内）；vault 记录在 publish store | `get_publish_status`, `manage_publish` | —（无 MCP 工具消费，见 §5） | `app/src/tools/publish.js:22`（`publicPath = /publish/<record.id>`）、`app/src/publish/service.js:111`（`id: randomBytes(32)`） |
| `archivePath` | vault-relative ZIP 路径（当次 vault 内解析） | `create_archive` | `inspect_archive`, `read_archive_entry`, `extract_archive`, `skill_import` | `app/src/tools/files.js:333`（create destination）、`:371`（extract archivePath）；`app/src/file-transfer.js`（createZipArchive → `toVaultPath`） |
| `skillPackagePath` | vault-relative 导出 ZIP 路径（默认 `SKILLS_PATH/_packages/`） | `skill_export` | — | `app/src/skills.js:188-210`（`exportSkillPackage` 返回 `toVaultPath(destinationAbs)`） |

## 5. 未证实 / 边界（诚实清单）

- **web tree cursor 未在 MCP 工具层找到**。仓库里唯一的不透明分页游标是 Web Base 读 API 的 `app/src/app/base-cursor.js:1-22`（绑定 `catalogId`，A3 HTTP contract）；87 个 MCP 工具中 `query_base` 不接受也不返回 cursor。因此矩阵把 `cursor` 仅记为 `list_notes`/`list_files` 的路径游标，未给 MCP 工具挂 web tree cursor。
- **`publishId` 无 MCP 消费方**：publish id 只在输出 `publicPath`/`publicUrl` 出现，`get_publish_status`/`manage_publish` 以 `path` + `vaultId` 定位。符合 §13.5「anonymous resolve 属公开能力，保持独立安全模型」。
- **`ifMatch`/`revision`、`planHash` 不计入 stateful handle**：它们是内容/计划的**前置条件校验值**（`fileRevision`、plan hash），不是服务端持久句柄；不属 §13.5 词表。矩阵改在「备注」列标注。
- **`archivePath` / `skillPackagePath` 是 vault-relative 路径而非不透明 id**：每次调用在当前所选 vault 内解析，跨库复用只会指向目标库的（可能不存在的）路径，不构成 confused deputy；故归为路径引用类，仍列在矩阵中以便 A3 统一注入 `vaultId`。
- **`versionId` 的产出面大于工具层**：`list_versions` 是唯一产出 versionId 的**工具**，但 `write_file`/`write_note`/`append_to_note`/`patch_note`/`replace_in_note` 响应均含 `preWriteVersionId`（`app/src/vault.js:202,217`）。这些写入工具因此也**间接产出** versionId；矩阵按「工具名 + 显式 handle」口径只记 `list_versions`，此差异在此声明。
- **`move_note`/`delete_note`/`restore_from_trash`/`restore_version` 内部消费 planId 但不外泄**（`app/src/tools/links.js` 各自 `createXPlan` 后立刻 `applyNotePlan`）。
- **未做的运行时注入（Wave 0 边界）**：本切片刻意不改写入 schema（`vaultId` 注入属 Wave A / A3）、不碰 `auth.js`（属 Wave C，等 #285）、不改 bundle。

> **Wave C 更新（2026-10-07）**：§6 的清单已由 A3 + C 执行完毕（见下方状态）。
> 当前事实：全部 85 个 vault-scoped tool 的 `inputSchema` 带 canonical optional `vaultId`（`app/src/vault-scope-registrar.js` 注入，
> `applyVaultIdSpec()` 作为 fail-closed 守卫）；global 两个工具**不带**；tool count 仍 **87**（独立重算：`grep -o "registerTool(" src/tools/*.js | wc -l` = 87 = `TOOL_NAMES.length`）。
> 契约测试：`app/test/multi-vault-vault-scope-contract.test.js`；生成物已同步：`tool-discovery-cost-gate.mjs --write` / `tool-discovery-runtime-matrix.mjs --write`（gate 结论不变：hold / pass）。

## 6. A3 收编清单（Wave A / A3 = Vault scope/tool classification）

1. ~~在 production 新建 `app/src/vault-scope.js`…~~ **部分完成（A3）**：已建 `app/src/vault-scope.js`（`GLOBAL_TOOLS` + 由 `TOOL_NAMES` 派生的 `VAULT_SCOPED_TOOLS` + `applyVaultIdSpec`）。`TOOL_CLASSIFICATION` 的 `module`/`handles` 两列**刻意保留**在本切片 helper 里（见第 4 条）。
2. ~~由它派生 §7.3 的统一 optional `vaultId` schema…~~ **完成（C）**：`vault-scope-registrar.js` 按 `VAULT_ID_INPUT_SPEC` 注入 1–80 chars optional 字段；`publish.js` 的局部手写定义已删。
3. ~~`auth.js` 的 `VAULT_SCOPED_TOOLS`（`app/src/auth.js:62`）改为引用该 registry~~ **完成（C）**：该集合已删除，`auth.js` 只 import `isVaultScopedTool()`（§43.3）。
4. ~~收编后删除本切片的 `app/test/helpers/multi-vault-tool-classification.js`…~~ **有意偏离（C，待协调方裁定）**：`surface`/`GLOBAL_TOOLS` 仍以 **W0-B 冻结矩阵**形式存在，因为它现在是 `app/test/vault-scope.test.js` 的**独立交叉 oracle**（“canonical `GLOBAL_TOOLS` == 冻结矩阵 global 集”）——两把互相独立的尺子比一把重复的尺子强。production 只有一份分类（A3 模块），§43-3/§43-4 不被违反；§35 契约测试已落地（`multi-vault-vault-scope-contract.test.js`）。若协调方要求彻底退役，还需先把该 oracle 换成另一条独立证据。
5. ~~handle 列不落 production 映射~~ **保持（C 未动）**：handle 绑定属 Wave B/B6 与 §13 的 D-lane。

## 7. 验证证据

- `cd app && node --test test/multi-vault-tool-inventory.test.js` → 6 pass / 0 fail（含真实注册捕获、分类完整性、module 双向实证、scopes 派生、handle 方向锚点）。
- 负控（本地临时改分类表，不提交）：module 错标 → 红；分类缺一条 → 红。日志见 `scratch/multi-vault/W0B/negative-control-*.log`。
- `cd app && npm run check` → 0 违规（含 500 行门禁：两个新文件均 < 500 行）。
- `cd app && npm test` → 全量结果见 `scratch/multi-vault/W0B/W0B.HANDOFF.md`。
