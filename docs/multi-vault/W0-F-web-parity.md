# W0-F — Web parity characterization（primary vs secondary）

> Wave 0 表征（零行为改变）。BASE = `c077d6c774075908c977efc5dd467a9d966cc7f5`（派发冻结 `6dc8154` 因 main 前进而 rebase，见 §7）。
> 一切结论以源码 + 可复现测试为据：`app/test/multi-vault-web-parity.test.js`（10 pass / 1 host-skip / 0 fail）。
> 契约（唯一权威）：`_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md`（下称「契约」）。
>
> **术语**：本刀中「primary / secondary」= `vault-registry.js` 返回的 `primary` 布尔（即 id 是否等于 `WEB_DEFAULT_VAULT`），**不是**「Web session 当前库」。同一 canonical root 可以既是 `primary`（id=`dup`）又是 `secondary`（id=`alpha`）——这正是 §3 的别名缺口。

## 1. 差异矩阵

| 能力 | primary 现状 | secondary 现状 | 差异结论 |
| --- | --- | --- | --- |
| 读取（note read） | `readWebNote` → `resolveWebVaultPath` → `fs.readFile`，返回 `{path,content,revision,stat}`，无 `absolute`（`app/src/app/vault-registry.js:317-321`、`302-310`）；路由 `/api/web/v1/note` 附加 `vaultId`/`route` + ETag（`app/src/app/routes.js:255-269`） | 同一函数、同一代码路径（该函数不分支 primary） | **一致**（同一实现） |
| 写入（note write） | `vault.primary` → 全局 `resolveVaultPath` + `atomicWriteFile`（`vault-registry.js:335-338`）：进程级 mutation lock、**要求 request author**、`assertRevision` CAS、更新时写全局 HISTORY_PATH 快照、`trackGitMutation`（`app/src/vault.js:192-222,224-241`） | 独立实现：`mkdir` + `.name.web-<uuid>.tmp` + `writeFile` + `rename`（`vault-registry.js:340-352`）：无 author、无 history、无 Git 入队 | **独立实现**；公开返回结构相同 `{path,created,revision,size}`（`336-352`），CAS/锁共享在 Web 层（`:326-334`、`:268-299`） |
| history / versions | Web 无任何读取入口（无 export、无路由）；但**更新已有笔记时隐式产生** `.bak` 快照，落在全局 `HISTORY_PATH`（`vault.js:202`、`:224-241`、`config.js:29`） | **完全不产生**（`historyTree` 在 secondary 更新前后不变；测试用例 6） | **缺失 + 不对称**（primary 有隐式副作用且不可读，secondary 无） |
| trash | Web 无入口；`TRASH_PATH` 仅由 MCP 工具使用（`config.js:28`，`vault.js:369-465` 无 Web 引用） | 同左（无入口） | **一致（都不支持）**；但两者都没有契约 §3.4 要求的显式 `available:false + reason`，属「静默缺功能」 |
| semantic / retrieval | 走 `hybridSearch`（`vault-registry.js:222`），可命中进程全局 retrieval 单例（契约 §1.6） | 精确词法结果照常返回，但 `semanticUsed:false` + `semanticError:"Semantic search is available only for the primary Vault"` + `hybridUsed:false`（`vault-registry.js:215-220`） | **缺失（显式拒绝）**——契约 §44 old-red 10 的机器可验形态 |
| web catalog（索引/事件） | per-vault：`runtimes` Map 按 `vault.id`，SQLite `<WEB_CATALOG_DIR>/<vault.id>.sqlite`（未设 `WEB_CATALOG_DIR` 时为 `<DATA_PATH>/web-catalog/<vault.id>.sqlite`；#428 已退役旧的 `cwd/data/web-catalog` 默认值），root-scoped source，写入后 read-your-writes（`app/src/app/web-catalog/runtime.js:43-58,191,216-227`、`vault-registry.js:355-356`） | 同一实现、同一路径（root-scoped 后 primary/secondary 无分支，`runtime.js:172-184`） | **一致**（同一实现，按 id 隔离；但文件名用原始 id，见 §5） |
| events / watcher | per-vault watcher + SSE：`watchers` Map 按 vaultId，`MAX_WATCHERS`（默认 32），忽略 `.git`/`#recycle`（`app/src/app/live-events.js:19,30,47,60`；`runtime.js:215-250`） | 同一实现（key 为 vaultId，与 primary 无关） | **一致** |
| Git | Web 层零实现；primary 写入会 `trackGitMutation`（`vault.js:216`）进入**全局** Git 队列（`GIT_ENABLED=false` 默认关，契约 §1.9） | 不接触 Git | **差异**：primary 隐式入全局队列 / secondary 完全不接；Web 侧均无 Git 读入口 |

## 2. `WEB_VAULTS_ROOT` 扫描与 `vaultId` 解析规则

- **配置读取**：`WEB_VAULTS_ROOT` 由 `vault-registry.js:14-15` **直接读 `process.env`**（不是 `config.js` export；W0-A 亦记录同一事实）；空串 → `VAULTS_ROOT = null`。`DEFAULT_ID = WEB_DEFAULT_VAULT || basename(VAULT) || "vault"`（`:16`）。
- **扫描**（`:41-54`）：`mkdir -p VAULTS_ROOT` → `readdir` → 跳过「非目录 / symlink / 以 `.` 开头 / 不匹配 ID 正则」的条目；`primary = (entry.name === DEFAULT_ID)`；primary 的 root 用全局 `VAULT`，其余用 `VAULTS_ROOT/<name>`（`:49`）。若扫描结果中不存在 `DEFAULT_ID` 且 `VAULT` 存在，则追加 `record(DEFAULT_ID, VAULT, primary=true)`（`:50`）。
- **排序**（`:52`）：`Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name)` → primary 恒第一，其余按 `localeCompare`（宿主 locale 相关）。
- **`record()`**（`:30-35`）：非目录 → `"Vault is not a directory"`；`assertCanonicalInsideRoot(primary ? VAULT : VAULTS_ROOT, root)` 做包含性检查（越界/symlink 逃逸抛 `"Symbolic link escapes the vault"`，`vault.js:62-70`）；返回 `{id,name,root,primary,writable:!READ_ONLY}`，**无 `canonicalRoot` 字段**。
- **解析 `resolveWebVault(id)`**（`:56-61`）：`String(id || defaultWebVaultId())`，用 `===` 精确匹配（**大小写敏感**），未命中 → `Error("Vault not found")` + `code:"ENOENT"`。
- **未配置分支**（`:37-39,42`）：`VAULTS_ROOT=null` → `defaultWebVaultId()==="default"`，`listWebVaults()` 返回单条 primary，`canCreate:false`，`createWebVault` 抛 `"Multi-Vault management is not configured"`（`:66`）。
- **ID 正则（字面量，`vault-registry.js:17`）**：

  ```js
  /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u
  ```

  首字符必须是 Unicode 字母/数字；后续允许 空格、`.`、`_`、`(`、`)`、`-`；总长 ≤ 80。因此：`a..b`/`中文库`/`Main`（大小写敏感）/ 80 字符合法；`.`/`..`/`.hidden`/`a/b`/`a\b`/含 NUL/81 字符/emoji 非法。
- **两处应用不一致**：扫描路径（`:47`）对**原始目录名**做正则；`safeId`（`:20-24`）在正则前先 `.trim()`。故 `createWebVault(" a")` 得到 id `"a"`，而目录名 `" a"` 在扫描中被跳过。
- **契约对账（§3.2）**：要求「复用当前 Web ID 规则、max 80、禁 `.`/`..`、禁 slash/backslash/NUL、保持 case-sensitive」——前四项当前成立（除上述 trim 不一致）；**「同一 root 不得以两个 ID 出现」当前不成立**（见 §3）。

## 3. 同一 canonical root 双 ID（契约 §3.2 / §42 SEC-MV02 缺口）

当前**允许**注册：`WEB_DEFAULT_VAULT="dup"` 时，扫描把目录 `alpha` 注册为 `id="alpha", primary=false, root=<vaultsRoot>/alpha`，随后又追加 `id="dup", primary=true, root=VAULT=<vaultsRoot>/alpha`。两条 `realpath` 相同、`primary` 不同，均出现在 `listWebVaults()` 中。

- 测试用例 3 冻结该现状（`realpath` 相等 + `primary` 相反）。
- 后果：`allowedVaults` 会出现授权别名（同一物理库两个身份，权限判定/审计按 id 计）。
- 契约目标：registry 必须拒绝两个 id 解析到同一 canonical realpath（§3.2、§42 SEC-MV02）→ 由 A2（registry）+ B7（Web adapter）收口。

## 4. Web session 当前库保存 与 allowedVaults 过滤入口

**Session 当前库**
- 每次请求由 provider user record 权威重建：`allowedVaults = user.allowedVaults`；若 `record.vaultId` 不在其中则回落 `allowedVaults[0]` 并随 touch 写回（`app/src/app/web-session-resolve.js:42-46`）。
- 显式选择：`POST /api/web/v1/vault/select`（`routes.js:187-198`）：先 `allowedVaults.includes(id)`（否则 403），再 `resolveWebVault(id)`，再 `manager.selectVault` → `store.mutateSession` 持久化 `{vaultId}`（`web-session-resolve.js:129-131`），并写 audit `web.vault.select`。
- 导航隐式选择：`/app/note/*` 用 `manager.noteSelection`（进程内 CAS touch，不强制持久化，`:132-135`）。
- 契约 §2.2 明确「非目标：把 Web Session 当前 Vault 语义复制到 MCP」。

**allowedVaults 过滤入口（6 处）**
| # | 入口 | 行为 |
| --- | --- | --- |
| 1 | `currentVault(req)`（`routes.js:145-149`） | `req.webSession.vaultId` 与解析后 `vault.id` **双向**都必须在 allowedVaults，否则 `Error("Vault access denied")`；v1 note/notes/events/themes/theme.css/theme-asset/asset/publish + v2 tree/search + base/note-context/tags 全部经此注入（`routes.js:161-178`） |
| 2 | `GET /api/web/v1/vaults`（`:179-186`） | inventory 按 allowedVaults 过滤，并剥离 `root` 字段；`canCreate` 还需 `obsidian.write` |
| 3 | `POST /api/web/v1/vault/select`（`:190`） | 不在 allowedVaults → 403 |
| 4 | `POST /api/web/v1/vault`（`:199-210`） | 创建后把新 id 并入 `user.allowedVaults` 并 `updateOAuthUser` |
| 5 | `GET /api/web/v1/publish`（`:309`） | `vault.id` 不在 allowedVaults → 403 |
| 6 | `GET /app/note/*`（`:100`） | `target.vaultId` 不在 allowedVaults → 404 |

> 这是 **Web 自己的** allowlist；MCP 侧 allowlist 目前只真正覆盖 Publish（契约 §1.4）。两套并存 → 契约 §4/§9 目标：canonical registry + 统一 vault-scope 表。

## 5. secondary 写入的独立实现（对比 global `atomicWriteFile`）

| 方面 | primary（`vault-registry.js:335-338`） | secondary（`:340-352`） |
| --- | --- | --- |
| 路径解析 | `resolveVaultPath(path)`（**硬绑全局 `VAULT`**，`vault.js:97`） | `resolveWebVaultPath(vault,…)`（root-scoped） |
| 串行化 | `withMutationLock`（**进程全局** `mutationTail`，`vault.js:182-221`） | 无全局锁；仅 Web 层 per-`(canonicalRoot,path)` 进程锁（两分支共享，`:268-299`） |
| author | `requireRequestAuthor()`（缺 author 抛 `MCP writes require _meta["obsidian/author"] with agent and model`，`vault.js:195-196`；路由层由 `withRequestContext({author:{agent:"obsidian-web",…}})` 满足，`routes.js:386`） | 不要求 author |
| revision CAS | Web 层先比 `ifMatch`（共享，`:326-334`），再交给 `assertRevision`（`vault.js:174-180`） | 仅 Web 层比较（同上），无第二道 |
| history | 更新已有文件时 `createVersionSnapshot`（`vault.js:202,224-241`）写 **全局** `HISTORY_PATH` | 无 |
| Git | `trackGitMutation(toVaultPath(absPath))`（`vault.js:216`）入全局队列 | 无 |
| 落盘手法 | temp + `rename`（`vault.js:207-214`） | temp `.name.web-<uuid>.tmp` + `rename`（`:343-347`） |
| 目录创建 | `ensureVaultParent` + `assertCanonicalInsideVault` | `fs.mkdir(dirname,{recursive:true})` + `assertCanonicalInsideRoot` |
| Web Catalog | 写入后 `catalog.indexFile`（read-your-writes，`:355-356`） | 同（该调用在分支之后，两分支共享） |

**结论**：仅「落盘主体 + 附加副作用」是两套引擎；`ifMatch` 语义与进程内锁在 Web 层已共享。契约 §10 要求收口为 root-aware `LocalFs` 单一实现（B1），secondary 的 history/trash/retrieval 落到 `DATA_PATH/vaults/<dataKey>/`（§5.2，dataKey = `sha256(vaultId)`，§3.3）。

## 6. secondary「不支持」入口与错误形态（old-red 10 机器可验版本）

测试用例 7/8 冻结如下事实（可 `node --test test/multi-vault-web-parity.test.js` 复现）：

- **export 面**（冻结清单，无 history/trash/version/Git 任何命名）：
  `createWebVault, defaultWebVaultId, listWebNotes, listWebVaults, readWebNote, resolveWebNoteLink, resolveWebVault, resolveWebVaultPath, statWebNote, webNoteWriteLockKeyForTests, writeWebNote`
- **Web API 面**（扫描 `routes.js` 等 7 个路由文件得到的冻结清单，共 20 条）：`/api/web/v1{,/asset,/base,/events,/link/resolve,/note,/note-context/,/notes,/publish,/session,/tags,/theme-asset,/theme.css,/themes,/vault,/vault/select,/vaults}` + `/api/web/v2{,/search,/tree}` —— **不含 history/trash/version/git**。
- **semantic（secondary）字面形态**：
  ```json
  { "semanticRequested": true, "semanticUsed": false,
    "semanticError": "Semantic search is available only for the primary Vault",
    "hybridUsed": false }
  ```
  精确词法命中仍返回（`score:1`），即「静默降级到精确匹配」+ 一个错误字符串。

**错误形态（供后续 parity/负控用例引用）**

| 入口 / 条件 | 当前形态 |
| --- | --- |
| `resolveWebVault("unknown")` | `Error("Vault not found")`，`code:"ENOENT"`（`:60`） |
| `resolveWebVaultPath(vault,"../x")` / `"Notes/../../x"` | `Error("Invalid Vault path")`（`:78`） |
| `readWebNote`/`writeWebNote` 的 `"../…"` | `Error("Invalid Vault path")`（经 `:78`） |
| 绝对路径 `"/tmp/x.md"` | 前导 `/` 被 `normalizeVaultInput` 去掉（`vault.js:26-30`）→ **留在 root 内** `tmp/x.md`（越界被阻断，但形态是「静默转相对」而非报错） |
| `createWebVault` 非法 id | `Error("Invalid Vault name")`（`:22`） |
| `createWebVault` 已存在 | `Error("Vault already exists")`（`:69`） |
| `createWebVault` 未配置 `VAULTS_ROOT` | `Error("Multi-Vault management is not configured")`（`:66`） |
| `writeWebNote`(primary) 缺 author | `MCP writes require _meta["obsidian/author"] with agent and model`（`vault.js:196`） |
| 非文件 / 超 `MAX_READ_BYTES` | `Error("Note exceeds the Web editor limit")`（`:305`） |
| 已有文件缺 `ifMatch` | `Error("Existing notes require a revision")`（`:331`） |
| `ifMatch` 不符 / 新文件带 `ifMatch` | `Revision conflict: expected …, current …` / `…, but the file does not exist`（`:332-333`）；路由转 409（`routes.js:401`） |
| symlink 逃逸 | `assertCanonicalInsideRoot` → `"Symbolic link escapes the vault"`（`vault.js:70`） |

## 7. 漂移记录（派发 BASE `6dc8154` → 实际 BASE `c077d6c`）

`origin/main` 前进了 5 个 commit（`#288` 右栏 unlinked、`#294` 分隔条、`#291-293` 归档刀）。关注面中：

- `app/src/app/vault-registry.js`：**零 diff**（ID/scan/write 语义与本刀表征一致）。
- `app/src/app/web-catalog/*`：仅纯增量 —— `search-store.js` 新增只读访问器 `readIndexedNoteText`（`SELECT notes_fts.raw …`），`sqlite-store.js` 新增一行转发；**未触碰** indexes/watcher/runtime 生命周期，故 §1 的 catalog/events 结论与 ID/containment 结论均不受影响。
- 其余改动为 `app/frontend/**`、`app/src/app/assets/**`、`app/src/archive/**`、`app/src/file-transfer.js`、测试，均在本刀 owner 面之外。

按 BRIEF「漂移则 rebase 并记录实际 BASE_SHA」执行 rebase；本刀只新增 2 个文件，rebase 无冲突。契约 §1.2/§1.3 的表述与 rebase 后源码一致（§1.2「Web 已有真实 local multi-Vault registry」、§1.3「Web Catalog 已经 per-vault」均成立）。

## 8. 未证实项 / 后续归属

- **symlink 分支未在本机执行**：本 Windows 宿主 `fs.symlink` 返回 `EPERM`，用例 6 以 host-capability skip（理由字符串内嵌），仅执行了 skip 路径；Linux/CI 上的具体错误文案期望为 `"Symbolic link escapes the vault"`（依据 `vault.js:70`），**未实测**。
- **未覆盖分支**：`WEB_VAULTS_ROOT` 未配置分支已用第二个模块实例覆盖；但「`VAULTS_ROOT` 内条目为 symlink 时被跳过」仅由代码路径（`:47`）断言，未构造真实 symlink 目录。
- **`localeCompare` 排序**在非 zh/en locale 下顺序可能不同——测试冻结的是本机（node 默认 ICU）结果。
- **未接线能力**：history/trash/version/Git 在 Web 侧「无入口」不等于「有 capability 声明」；契约 §3.4 要求 `server_info`/Admin 显式 `available:false + reason`，当前无此声明（属后续 B1/B2/B3/B4 与 C 的接线范围）。
- 归属：**B1**（LocalFs/state：写入/history/trash/containment 收口）、**B2/B3**（index/retrieval runtime，消除 secondary semantic 拒绝）、**B4**（Git runtime）、**B7**（Web registry adapter：canonical registry/duplicate-root 拒绝/ID 单一来源）、**C**（tool/allowlist/scope 统一）。
