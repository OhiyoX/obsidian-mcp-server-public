# W2 — Vault admission + unified reconciliation (#437)

Contract authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
(rev3, seat GO frozen 2026-10-09 08:40). This page records **what W2 implemented**, where it lives, and
what it deliberately did not do. It is a `candidate` branch note: nothing here is merged, released,
deployed or production-verified. R-A/R-B implementation plan was locked before code in
[W2-incarnation-repair.md](W2-incarnation-repair.md). Current contract revision is
`sha256:5240077f57b8dea1ac815b5c028f4797380ed7d495a9e7bf85f6020075895534`;
its W2 additions remain **unapproved candidate**, with RETURN and W3/#441 prerequisites unchanged.

## 1. Switch and default

| Env | Default | Meaning |
|---|---|---|
| `VAULT_DISCOVERY_ENABLED` | `false` | Controls the automatic trigger only. With `WEB_VAULTS_ROOT`, enforcement is switch OR record OR enrollment sentinel. Turning it off never removes the gate; genuine legacy requires all three absent. |
| `VAULT_ADMISSIONS_PATH` | `$DATA_PATH/vault-admissions.json` | The one authoritative record (contract §2.2). Overridable for tests/ops only. |

Existing state/importer ratchets remain unchanged. Turning the switch off still loads managed state
and preserves refusal; it is not a filesystem-I/O or admission bypass.

## 2. Modules

| Module | Responsibility |
|---|---|
| `src/vault-runtime/identity.js` | Managed identity v2: normalized realpath + bigint dev/ino + incarnation, structured tuple SHA-256. v1 parsing preserves tombstones; it cannot admit a managed Vault. Missing proof refuses, including same-tuple replacement. |
| `src/vault-runtime/incarnation.js` + `explicit-enrollment.js` | Bounded proof reads; exclusive creation only in explicit confirmed initialize/approve. Existing bindings never get replacement proof; v1 migration requires new IDs. |
| `src/vault-runtime/runtime-plans.js` | Per-owner private plan state; opaque previous token, public diagnostic copies; no membership/lease entry aliases. |
| `src/vault-runtime/admission-store.js` | The single writer of `vault-admissions.json`: schema v1 (`version/revision/migration/entries/registry`), one atomic `temp + rename` per decision, strict load-time cross-validation, corrupt/unreadable ⇒ refuse startup and keep the bytes, capacity guard (512 entries) with an explicit failure. |
| `src/vault-runtime/registry-scan.js` | Bounded enumeration: ≤4096 entries per allowed parent, per-round logical deadline, `fs.opendir` streaming in production. A breach aborts the round. |
| `src/vault-runtime/reconciliation.js` | The process's ONE unified service: trigger classes (`startup`/`manual`/`watcher`/`periodic` — W4 schedules the last two), single-flight + one pending rerun + coalescing, `added/removed/changed/unchanged` diff, the §4 ordering, lifecycle projection, observability. |
| `src/app/vault-admission.js` | Composition controller: admission store + reconciliation service + the admin/manual seams. |
| `src/app/vault-startup.js` | Startup: fail-closed admission load, then the STARTUP trigger before `app.listen`; `/healthz` projection. |

Changed: `src/vault-runtime/registry.js` (`prepare`/`commit` seam + a **persistent** admission `gate`),
`src/vault-runtime/instances.js` (`prepare`/`commit`/`discard`/`settleRetirements`), `src/config.js`
(the two new read points), `src/app/vault-registry.js` (controller + gated inventory path), `server.js`
(minimal assembly).

## 3. Contract §4 order as implemented

```text
① registry.prepare({ gate, maxEntriesPerParent, deadlineAt })   discovery + admission + path safety
② runtimeMap.prepare(descriptors)                               candidate runtimes + align validation
③ admissions.commit({ ..., expectedRevision })                   ONE document, ONE revision (CAS)
④ stage complete registry/runtime/serving; runtimeMap.commit(plan)  one composed record publication
⑤ activate({...}) per newly visible/changed Vault; runtimeMap.settleRetirements()
```

* `prepare` publishes nothing. Attached managed `registry.refresh/commit/applyStaged` refuse an
  independent publication; callers must use unified reconciliation. Standalone/true legacy retain
  supported paths. Actual Admin refresh caller alignment remains a W3 prerequisite.
* Step ③ is a **compare-and-swap** on the authoritative `revision`: a round that lost the race to an
  administrator decision is refused (`VAULT_ADMISSIONS_REVISION_CONFLICT`), its candidate is
  discarded and exactly one re-run is scheduled — a stale scan can never revert a revoke or lower a
  generation (RETURN item 3).
* The persisted revision is the **only** authority; step ④ mirrors it into the registry snapshot and
  re-baselines the serving gate in the same synchronous swap. `registry.commits()` counts successful
  composed commits (RETURN item 6).
* A persist failure (③) publishes nothing and keeps the previous visible snapshot; the tightened
  delete/identity refusal gates stay in force because they were applied to the **serving gate**
  during step ①/② (RETURN item 5).
* An activation failure (⑤) degrades the Vault to `error` and schedules exactly one retry; the new
  snapshot is never rolled back.
* A failed runtime prepare (②) disposes every candidate it built, names the failing Vault and isolates
  it; a failed retirement keeps its record/handle/error for a retry and reports
  `committed-degraded` (RETURN item 7).
* Retirement drains (`drain()` → optional injected `drainFor` → `dispose()`) instead of dropping the
  instance from the map; `settleRetirements()` is awaited in step ⑤.

## 4. Admission model

* `entries[<id>].admission` = `pending | approved`, written **only** by `initialize()` (explicit
  administrator confirmation) or `approve()`/`revoke()`. Discovery produces `pending`.
* Runtime state (`unavailable | initializing | ready | error`) is a **projection** in
  `reconciliation.status()` and is never persisted as an admission decision.
* Missing file: loads as uninitialized; **nothing** is auto-approved (not even the configured
  primary) and no discovery entry is persisted. Corrupt/unreadable file: `load()` throws and
  `server.js` refuses to start.
* Deletion ⇒ `unavailable` with the admission decision and identity binding untouched.
* Rename ⇒ old id `unavailable`, new id `pending` (no automatic transfer of authorization).
* Restore ⇒ served again only when the identity matches the persisted binding and the decision was
  already `approved`.
* A replaced directory (including same dev/ino with missing/changed incarnation) is refused, the original binding is kept, and
  the id can never be re-approved — a new Vault ID is required (v1 freeze, contract §3.1).

## 5. Operator / interface notes

* `vaultDiscoveryStatus()` / `/healthz` expose per-Vault `admission`, runtime `status`/`reason`,
  discovery time, failure count and last success. Bounded by the number of known Vaults — never a
  filesystem walk on a request path.
* `initializeVaultAdmissions({ confirm, actor, source })` is the only creation path for approvals;
  `confirm` must be the administrator's explicit list of Vault IDs.
* **W3 must line up** (contract §6): Web/Admin visible lists, MCP Vault resolution, and the
  catalog/index lifecycle must all read the same projection, and open pages must react to a change.
  W2 already refuses content resolution for a non-admitted Vault (structured refusal instead of a
  primary fallback); W3 maps that refusal onto the Web/MCP transports and the Admin UI.
* `createWebVault()` still creates the directory; under the W2 switch the new Vault is returned with
  `admission: "pending"` and is **not** served until an Admin decision.
* **Serving authority (RETURN item 1):** `vault-runtime/serving-gate.js` holds the ONE refusal
  decision per Vault. `registry.get`/`list`, `vaultRuntimeMap.get`/`has`, the canonical resolve and
  the Web resolve all consult it; a non-admitted primary is still *described* structurally
  (`snapshot().vaults`, `structuralList()`) but has no service right. Refusals are sticky until a
  successful composed publish, so a failed persist can never re-open a refused Vault. Structured
  refusals carry `{ code, httpStatus }` — uninitialized/unavailable ⇒ 503, initialized-but-unapproved
  ⇒ 403.

## 6. Not done in W2 (recorded debt)

* watcher / periodic scheduling, debounce 500 ms, periodic 60 s, exponential backoff (W4). The trigger
  classes and the bounded round are already in place (`reconciliation.js`, `scheduled: {watcher:false,
  periodic:false}`).
* Consumer alignment and the Admin approve/revoke UI (W3).
* Real-container end-to-end and NAS-mount verification (W5); NAS mounts are not touched here.

## 7. 返修（响应席位 RETURN，2026-10-09）

`codex-seat/RULING-437-W2-RESPONSE.md` RETURN 了 `671d4f76`（7 条必改）。本分支以**新增 commit**
修复（不 amend / 不 rebase / 不 merge / 不 tag / 不 deploy）。逐条落点：

| # | 修复 | 代码落点 | 负控（原始用例） |
|---|---|---|---|
| 1 | primary 不再绕过准入：`registry.get`/`list`、`vaultRuntimeMap.get`/`has`、canonical resolve 共同遵守 serving gate；非批准的 primary 只有**结构性描述**，没有**可服务权限**（结构化 503/403，禁止回落 primary）；`activate` 跳过非批准项 | 新增 `vault-runtime/serving-gate.js`；`registry.js`（`servingGate`/`servable`/`refusal`/`refuse`/`structural*`）；`instances.js`（`get`/`has`/`refusalOf`）；`app/vault-registry.js`（`requireServable`） | `vault-return-fixes.test.js` ITEM 1；`vault-reconciliation.test.js` 未初始化用例 |
| 2 | 开关只控制**自动发现触发**；控制器在配置了 `WEB_VAULTS_ROOT` 时始终构建，`开关 || 记录存在` ⇒ 持续强制；关闭开关后 pending/revoked/损坏仍拒绝 | `app/vault-admission.js`（`enforced`/`armGate`）；`app/vault-registry.js`（`ensureInventory` 先 `load()` 再分支） | `vault-discovery-fail-closed.test.js` 两个 ITEM 2 子进程探针 |
| 3 | 持久化串行段基于权威 revision 的 **CAS**：冲突 ⇒ 丢弃候选 + 单次重跑，扫描不再否决管理员决定、不倒退 generation | `admission-store.js`（`commit({expectedRevision})`、`snapshotState()`）；`reconciliation.js`（读 revision、`ADMISSIONS_REVISION_CONFLICT` ⇒ `pendingRerun`） | ITEM 3（屏障 + 暂停期间 revoke） |
| 4 | 移除 `initialize(force:true)` 逃生路径；初始化/恢复不得覆盖旧绑定或降低代次 | `admission-store.js`（`initialize` 去掉 `force`、加 identity 冲突拒绝与 `generation` 只增） | ITEM 4 两例（复现 + 直接绑定守卫） |
| 5 | 独立、持续的**粘性拒绝门**：步骤①/② 立即收紧，持久化失败不得撤回删除/替换/撤销的拒绝 | `serving-gate.js`（`refuse` 粘性、`publish` 才重设）；`reconciliation.js`（gate 内、`diff.removed` 处 `refuse`） | ITEM 5（替换 + 注入 rename 失败） |
| 6 | 以持久化 revision 为唯一权威；统一组合快照同步提交；新增 `registry.commits()` 计数 | `registry.js`（`commit(candidate, {revision})`、`commits`）；`reconciliation.js`（③ 返回值回传 ④） | ITEM 6（revision 一致 + runtime commit 失败仍不可取得） |
| 7 | 准备失败清理候选并隔离失败 Vault；退役失败保留可重试记录/句柄/错误并报降级 | `instances.js`（`prepare` try/catch 清理 + `error.vaultId`；`retirements` 保留失败项 + `settleRetirements` 重试/抛出） | ITEM 7① / 7② |

新增/拆分模块（守住 500 行预算）：`vault-runtime/serving-gate.js`、`vault-runtime/admission-document.js`
（schema 从 store 拆出）、`vault-runtime/reconciliation-diff.js`、`vault-runtime/registry-snapshot.js`。
`admission-store.js` 继续 re-export 文档契约，消费者 import 站点不变。

**复审入口**：

* `node --test test/vault-return-fixes.test.js test/vault-admission-store.test.js test/vault-reconciliation.test.js test/vault-discovery-fail-closed.test.js`
* `node --test test/multi-vault-*.test.js test/web-vault-*.test.js test/vault-*.test.js test/publish-*.test.js`（491 tests）
* `npm run check`；全量门禁 `node scripts/run-node-tests-ci.mjs`（本机 Windows 非稳定绿；W2FIX 失败集见 HANDOFF）。

## 8. 二次返修（响应席位第二次 RETURN，2026-10-09 12:55）

`codex-seat/RULING-437-W2FIX-RESPONSE.md` 再次 RETURN `eac0b69c`（1 P1 + 4 P0）。同样以**新增
commit**修复（不 amend/rebase/merge/tag/deploy）。

### 8.1 冻结的受管模式（必办 1）

* **文件**：`DATA_PATH/vault-admission-enrollment.json`（可用 `VAULT_ADMISSION_ENROLLMENT_PATH` 覆盖），
  与准入记录**分离**，单写者、`temp+rename`、mode 0600、损坏 fail-closed。
* **格式 v1**：`{ version, revision, managed: true, managedSince, bindings: { <id>: { identity, generation, enrolledAt } } }`。
  它**不存 admission 决定**（不含 `pending`/`approved`），装载时**从不**用来批准任何 Vault ——
  只能让实例**多拒绝**，绝不能多放行。
* **写入时机**：任何 `initialize` / `approve` / `revoke` / reconciliation `commit` 改变绑定时，先写哨兵、
  再写记录（崩在中间只会留下绑定**超集**，永不降低）；组合根在“启用强制”后若尚无哨兵则立即 `enroll()`。
* **强制判定（显式限定）**：`enforced = VAULT_DISCOVERY_ENABLED || 记录存在 || 哨兵存在`。真正 legacy
  只适用于“从未受管”（开关关 + 无记录 + 无哨兵），**不由 ENOENT 单独推断**。记录被删、开关关闭时，
  哨兵仍使实例受管，gate 返回 `admissions-not-initialized`（全拒绝）。
* **恢复**：记录丢失后，`initialize` 仍先比对**哨兵里存活的旧绑定**；同 identity ⇒ 允许（`generation` 只增），
  换 identity ⇒ `VAULT_ADMISSION_IDENTITY_CONFLICT` 且**不写任何文件**。generation 下限也随哨兵存活。
* **交叉校验**：记录与哨兵对同一个 id 的 identity 若不一致 ⇒ 加载 fail-closed。

### 8.2 load 生命周期（必办 2）

`admission-store.js` 的 `load()` **单飞并缓存成功结果**；**读-应用与所有 mutation 共用一条串行链**，
迟到旧读不可能发布到更新的 state；新增显式 `reload()`（与 initialize/approve/revoke/commit 串行）
且 **ENOENT 保留已知 state/binding**（返回 `kept:true`），绝不清空。

### 8.3 组合提交（必办 3/6）

> **W2FIX3 订正（2026-10-09）**：本节的初版措辞把”同一同步段内三面顺次赋值”称作”消费者观察不到半提交”。
> 席位实测证明那不是同一快照事务，且 `先换 registry → 再调用可失败的 map commit` 会在故障后留下
> “新 descriptor + 旧 runtime”。以下是订正后的**实际**语义（契约 §4.2）。
>
> **W2FIX5 订正（2026-10-09）**：本节进一步明确独立发布路径约束与只读集合防御性拷贝。

* `serving-gate.js` 是**显式 allow-set**：`publish(allowedIds, refusals)`；不在集合内的 id
  （未知/删除/撤销/未准备完成）**默认拒绝**（`VAULT_SERVING_REFUSED`/503），重设决策**不可能**把拒绝门清空成放行。
* `registry.stageCommit()`（`registry-commit.js`）在**发布前**完成全部可失败校验（轮次期限、revision 形状与单调、
  serving override 形状）并冻结 staged 记录；`composedServingSets` 在发布前算出 allow-set。
* **提交点：单一组合提交记录**（**W2FIX5 订正，见 §11**）：registry 快照、runtime map 与 serving allow-set
  共读 `vault-runtime/composed-commit.js` 的**同一个不可变记录**；`runtimeMap.commit(plan)` 以**一次记录赋值**
  发布三面，可失败校验全部在切换前完成，但**不宣称事务**。观察者可能在**进入 `map.commit` seam、实际交换之前**
  读取三面，所以**不能**用「顺次赋值」声称任意时点无混用：切换前三面一起显示上一提交点，切换后一起显示新代次。
  故障方向按 §11：**切换前**故障三面一起停在上一提交点；**切换后**故障三面一起停在新 revision，不得只回滚一面。
* **独立发布路径约束（W2FIX5 R1/F1）**：附接 runtime map 后，所有可发布路径（`refresh`/`commit`/`applyStaged`
  及 owner-specific publish）只能提交**同 revision、同 identity/代次的完整 staged registry/runtime/serving**，
  或委托统一 reconciliation；无法完成组合验证则 **typed refusal** 且**上一完整快照保持不变**。真正未附接 map
  的 standalone registry 使用场景保留。
* **只读集合防御性拷贝（W2FIX5 R2/F2）**：已提交 membership/allow-set 以防御性拷贝或严格内部所有权控制；
  公开只读接口的 callback **不得获得 raw Map/Set**（第三参数改为只读 view，`composed-commit.js` 的
  `readonlyMapView`/`readonlySetView`）。
* **R-A 订正（2026-10-10）**：prepare.previous 仅 opaque token；真实 previous/next/released 由 owner
  私有 WeakMap 持有，比较在私有存储完成。公开 next/released/条目为事实副本，instancesOf 仅只读事实；
  diagnostic Map 的修改不得改变待提交计划或已提交 membership。owner 不公开 adoption/membership。
* 任意失败 ⇒ 如实报 `committed-degraded`（`stage: runtime-commit`），**两个面保持同一代次**（§10）、
  **discard 未采纳候选**，**不重设拒绝门**，下一轮按持久化 revision 收敛。**新 descriptor 绝不与旧 runtime 配对服务**。
* 持久化已提交但发布失败 ⇒ 同样如实报该 durable revision 降级；`committed-degraded`/`publish`。

### 8.4 撤销与旧句柄的操作门（必办 4）

> **W2FIX3 订正（2026-10-09）**：初版声称”lease 已有 identity/generation”。实际上当时的 `generation` 只是
> retire 时递增的**本地计数**、lease 内**没有 identity**，且 primary 没有 lease；席位因此实测到”暂停扫描期
> revoke→approve 后旧二级句柄重新可读””撤销 primary 后旧句柄仍读到 primary-body”。以下是订正后的实际语义。
>
> **W2FIX5 订正（2026-10-09）**：本节进一步明确 primary bootstrap 顺序与所有索引写入口受门控。

* `reconciliation.revoke()` 在**返回前**同步 `registry.refuse(id, awaiting-approval)`，不等可能被 coalesced 的扫描。
* `runtime-lease.js` + `instance-leases.js` + `instances.js`：**每个**对外句柄（secondary **与 primary**）都经
  **唯一** lease facade 交出，绑定 **authoritative identity digest + generation**（不再是 id + 布尔）；
  `instances.get()` 对 primary 也返回 facade（底层 primary 实例被复用，但 raw 实例**不再**作为消费者句柄）。
* 复用键与 current 判据核**身份/代次**：代次未变 ⇒ 同一个 facade；代次前移（revoke 或再次 approve）⇒ 旧 lease
  被**不可逆** latched（`revoked=true`）并 mint **新 facade**。因此暂停扫描期 `revoke → approve` 也**不会复活**旧句柄。
* `revoke` 还会同步 `runtimeMap.quiesce(id)`：吊销 lease（旧 facade 立刻死）并调用组合根 `drainFor` 停止
  Git/search 缓存的定时器；后台运行时在**每次新操作**（含被捕获的定时回调）重核 lease。
* **进程共享 primary 的消费面**（W2FIX5，见 §11）：`gitRuntimeFor`/`searchRuntimeFor` 对 leased primary 句柄交出
  **每个授权代次固定绑定的消费 facade**（底层仓库/进程实例可共享，但旧 facade 的直接 sweep/操作在 revoke 后拒绝，
  重新批准也不会复活），并把 primary 的 Git sweep 与 retrieval refresh 接到当前 lease/generation；
  同一当前句柄重复解析**幂等**（不替换 guard/token，健康定时器不被误杀）。
* **受管 primary 启动顺序（W2FIX5 F3）**：`primary-authorization.js` 在进程启动时以显式证据（`initializePrimaryAuthorization({ managed })`）
  确定受管/legacy 模式，**不得由「首次 resolver 查询缺席」或「cache/guard 尚未填充」推断为 legacy**。受管模式下，
  权威绑定**必须发生在实际进程资源启动后台任务之前**：composition root 在 map 构造及每次组合发布的
  `onPrimaryLease` seam 注入真实 lease 与 currency predicate，受管模式还须有持久 identity digest；pre-load fallback
  不能授权。`allowPrimaryAuthorization()` 只启动当前有效绑定的资源，不授予权限、不替换 lease/token；approve
  先完成组合发布再启动后台。释放未缓存的 leased primary 仍须清 timer、取消未开始任务；真正经确认的 legacy
  （开关关 + 无记录 + 无哨兵）保持健康正控。
* **所有索引写入口受门控（W2FIX5 F4）**：`retrieval-runtime.js` 的所有新写/调度/直接同步/队列执行入口
  （`syncRetrievalIndex`、`startRetrievalIndex`、`requestRetrievalRefresh`、队列 drain 执行点）统一核 `mayRun()`
  与当前 authorization token；撤销后**未开始工作不得新写**索引；合法当前代次的允许、状态只读与在途 drain 保留。
* 区分**已进入操作的在途工作**（按冻结规则安全结束）与**撤销后的新调用**（结构化拒绝，`VAULT_RUNTIME_LEASE_REVOKED`/503）。

### 8.5 准备失败隔离（必办 5）

`instances.prepare()` **逐 Vault 隔离**：失败项记入 `failed`、清掉半成品候选、其它继续构建；
`reconciliation` 把失败项从候选可服务集合隔离（保留 identity 绑定与 `error`/`runtime-prepare-failed` 投影），
**继续持久化并提交健康项**，轮次报 `committed-degraded`/`prepare-runtime` 并排一次重跑。连续两轮 + 新健康项的
混合验收在 `vault-composed-commit.test.js` ITEM 5。

### 8.6 新增/拆分模块（守 500 行预算）

`vault-runtime/enrollment-sentinel.js`、`vault-runtime/runtime-lease.js`、
`vault-runtime/reconciliation-{vocabulary,status,commit}.js`；`admission-store.js` 与 `reconciliation.js`
保持 re-export，import 站点不变。`docs/multi-vault/W0-A-core-state-inventory.md` §6.11 登记新增的
`dataPathLiterals` 一项。

### 8.7 复审入口（W2FIX2）

* `node --test test/vault-runtime-identity.test.js test/vault-admission-store.test.js test/vault-reconciliation.test.js test/vault-discovery-fail-closed.test.js test/vault-return-fixes.test.js test/vault-admission-lifecycle.test.js test/vault-composed-commit.test.js`（76 tests）
* `node --test test/multi-vault-*.test.js test/web-vault-*.test.js test/vault-*.test.js test/publish-*.test.js`（519 tests）
* `npm run check`（760 syntax / 855 architecture）；全量门禁以 CI 为准。

## 9. 三次返修（响应席位第二次 RETURN，2026-10-09）

本节为历史切片；下表旧「先 map 后 registry」发布次序已由 §8.3/§11 的单一组合记录取代。

`codex-seat/RULING-437-W2FIX2.md` RETURN 了 `4455d651`：专项 76/76 与本机 `npm run check` 通过，但席位
另行构造的 13 项生产模块探针 **5 PASS / 8 FAIL**，复现 5 类旧反例 + 新增边界。本轮同样以**新增 commit**修复
（不 amend/rebase/merge/tag/deploy），落点上表 §8.3/§8.4 为订正后的语义。逐条：

| # | 修复 | 代码落点 | 负控 |
| --- | --- | --- | --- |
| 1 P0 | 哨兵路径独立性：构造期**规范化**比较（`resolve` + 平台大小写折叠），首次读/写前**真实目标**（`realpath` 最近存在祖先 + 回拼尾部）比较；冲突 fail-closed，不创建/不覆盖任一文件；损坏哨兵仍拒绝，不降级 legacy | 新增 `vault-runtime/path-identity.js`；`admission-store.js`（构造/`readAndApply`/`writeDocument`） | `vault-admission-independence.test.js` ITEM 1 ×4；`w2fix3-probe.log` item 1 |
| 2 P0 | 可信读回：sentinel 顶层 `revision` floor（先写哨兵）+ 同 revision 内容一致 + `entry.generation ≥ binding.generation`；拒绝读回时保留可信内存/旧 binding/拒绝门且不覆盖文件；`generationFloor = max(record, sentinel)`；ENOENT 保留 | 新增 `vault-runtime/admission-readback.js`、`vault-runtime/admission-trust.js`；`admission-document.js`（`ENROLLMENT_KEYS`+`revision`、`ADMISSIONS_RECOVERY_REQUIRED`） | `vault-admission-independence.test.js` ITEM 2 ×4；`w2fix3-probe.log` item 2/2b |
| 3 P0 | 组合提交指针：`stageCommit` 发布前完成全部可失败校验；提交点先 map 后 registry 再 gate；失败回滚 map + discard 候选 + 维持拒绝；候选 dispose 计数 | 新增 `vault-runtime/registry-commit.js`；`registry.js`（`stageCommit`/`applyStaged`/`admission`）；`instances.js`（`previous`/`rollback`/`discardedCount`） | `vault-composed-commit-facts.test.js` ×4；`w2fix3-probe.log` item 3 |
| 4 P0 | 所有对外句柄（含 primary）绑定真实 identity/generation；`revoke` 返回前不可逆吊销旧代次；新批准给新代次，旧 facade 永不复活 | 新增 `vault-runtime/instance-leases.js`；`runtime-lease.js`（`LEASE_STATE`/`isHandleCurrent`）；`instances.js`（primary facade + `refresh`） | `vault-runtime-lease-generation.test.js` ×3；`w2fix3-probe.log` item 4/4b |
| 5 P0 | 后台消费者接 lease/退役：Git 运行时 `guard` seam 每次新操作重核；`git-runtimes.js` 传 handle guard；`search-runtimes.js` 解包 primary facade；**search/index 运行时只能在对句柄仍当前时重新武装 retrieval refresh**（`mayScheduleWork`）；server 组合根注入 `drainFor`；`quiesce` 在 revoke 时停止缓存定时器 | `git-runtime/runtime.js`、`git-runtime/support.js`（`LEASE_REVOKED`）、`git-runtimes.js`、`git.js`、`search-runtimes.js`、`vault-runtime/search-runtime.js`（arm guard）、`runtime-lease.js`（`mayScheduleWork`）、`instances.js`、`reconciliation.js`、`server.js` | `vault-background-lease.test.js` ×2（真实 Git 二进制 + 定时回调）；`vault-search-background-lease.test.js` ×2（撤销后不再武装后台 retrieval job） |
| 6 P1 | 自重试有界化：`retryDelayMs` 校验（默认 1000ms，拒绝 `0`/`NaN`/负/`Infinity`）、几何退避、单一待重跑、`stop()` 取消 | 新增 `vault-runtime/reconciliation-retry.js`；`reconciliation.js`（`DEFAULT/MIN/MAX_RETRY_DELAY_MS`、`scheduler`、`commitObserver`） | `vault-retry-rate.test.js` ×4；`w2fix3-probe.log` item 6/6b |
| 7 P1 | 契约回写：权威契约新 revision（§2.4 哨兵/恢复/legacy、§4.2 组合提交/句柄/后台 lease/重试），本页 §8.3/§8.4 订正 | Vault 契约 + 本页 | 回读 §2.4/§4.2；Architecture 索引更新 |

**W2FIX3 新增/拆分模块**（守 500 行预算）：`vault-runtime/path-identity.js`、`admission-readback.js`、
`admission-trust.js`、`instance-leases.js`、`reconciliation-gate.js`、`reconciliation-retry.js`、`registry-commit.js`、
`runtime-release.js`（组合根 drain seam，`server.js` 只加 1 行装配）。

**复审入口（W2FIX3）**：

* 专项 7 套（76 tests）+ `node --test test/vault-admission-independence.test.js test/vault-background-lease.test.js test/vault-search-background-lease.test.js test/vault-composed-commit-facts.test.js test/vault-retry-rate.test.js test/vault-runtime-lease-generation.test.js`（23 tests）。
* `npm run check`；独立探针 `scratch/multi-vault/I437-W2/w2fix3-probes.mjs`（原始读数见 `w2fix3-probe.log`）。

## 10. 四次返修（响应席位第三次 RETURN，2026-10-09）

本节为历史切片；下表 A 的多次赋值/undo 描述已由 §8.3/§11 的单一组合记录取代。

`codex-seat/RULING-437-W2FIX3.md` RETURN 了 `4a1720ac`：其**原契约探针 13/13、专项 99/99、`npm run check`**
全过，但**新增 6 项扩展检查全红**。本轮只修这 6 项（不重开已过项），仍以**新增 commit**落地（不 amend/rebase/merge/tag/deploy）。
契约已订正 §4.2 并新增 **§4.3**；本节订正 §8.3 的提交顺序。

| # | 修复 | 代码落点 | 负控 |
| --- | --- | --- | --- |
| A P0 | **同步消费者视图单一代次**：提交点改为同一同步段内「① 写 registry 快照 → ② runtime map 采纳同一 revision → ③ 重设 serving gate → ④ observer `after`」；故障方向双向：**map 未采纳** ⇒ 同时撤销 registry 赋值（纯内存 undo）+ discard 候选，两面停在上一提交点；**map 已采纳**（serving publish / observer 抛错）⇒ 两面停在新 revision，**不得只回滚一个面** | 新增 `reconciliation-commit.js` `publishComposed()`；`registry.js`（`applyStaged({revert:true})` 反向计数）；`reconciliation.js`（调用点收缩） | `test/vault-sync-consumer-facts.test.js` ×4（含 mid-commit 观测点、两类迟到故障、map 故障反向控制） |
| B P0 | **primary 后台受 lease 约束**：`gitRuntimeFor` 对 **leased** primary 句柄绑定其 lease guard 并把该句柄登记为可退役项，组合根 `releaseGitRuntime` 真正 `stop()` primary sweep；`GitRuntime.leaseGuard` 公开可写（供重新绑定）且**对象本身即定时器授权 token**，定时回调在**武装时**捕获 token，失配则返回 `git_runtime_lease_revoked` ⇒ 撤销后不提交、重新批准后旧回调永久失效、当前句柄可恢复工作 | `git-runtimes.js`、`git-runtime/runtime.js`（`leaseGuard`/`started`/token 比对）、`git-runtime/timers.js`（arm 时捕获 token） | `test/vault-primary-background-lease.test.js` ×2（真实 Git 仓库 + 捕获 sweep 回调；含“无 stop 的重新绑定”反向控制） |
| C P1 | **显式恢复的 revision 下限**：`buildNextAdmissionDocument` 接收 durable `revisionFloor`（哨兵 revision），下一 revision = `max(base, floor) + 1`；store 传 `enrollment?.revision ?? 0`。记录丢失后的恢复不再写出低于 floor 的记录（否则下次启动 `VAULT_ADMISSIONS_RECOVERY_REQUIRED`） | `admission-document.js`、`admission-store.js`（`nextDocument`） | `test/vault-admission-recovery-floor.test.js` ×2（含跨重启加载 + “低于 floor 仍被拒”的反向控制） |
| D P1 | 契约/文档同步：契约 §4.2 次序与故障方向订正 + 新增 §4.3；§2.4 加 ⑥（恢复下限）；§0 加 W2FIX4 bullet；Architecture README + 新候选状态 note；本页 §8.3/§10 | Vault 契约 + 本页 + `Architecture/2026-10-09 Issue 437 W2 第四次返修（W2FIX4）候选状态.md` | 契约回读 `sha256:17be8aba…`（W2FIX5 再订正，见 §11） |

**未封口（如实）**：组合提交仍是**内存发布**而非数据库事务（三面共读单一记录，底层仍是进程内存）。primary 的进程共享 **search** 实例已在 **W2FIX5 R2** 接当前 lease/generation（见 §11）。

## 11. 五次返修（响应席位第四次 RETURN，2026-10-09）

`codex-seat/RULING-437-W2FIX4.md` RETURN 了 `3c88fb39`：原契约检查 13/13、上轮六条扩展检查 6/6、专项 107/107、`npm run check` 全过，但**本轮补充五项检查 0/5**。本轮修这五项（不重开已过项），仍以**新增 commit** 落地（不 amend/rebase/merge/tag/deploy）。契约订正 §4.2/§4.3，本页订正 §8.3/§8.4 并新增本节。

| # | 修复 | 代码落点 | 负控 |
| --- | --- | --- | --- |
| R1 P0 | **单一组合提交记录**：registry 快照 / runtime map / serving allow-set 共读一个不可变记录，`runtimeMap.commit(plan)` 以一次记录赋值发布三面；切换前故障记录未发布（候选 discard），切换后故障三面停在新 revision（不拆开回滚） | 新增 `vault-runtime/composed-commit.js`；`registry.js`、`instances.js`、`serving-gate.js`、`reconciliation-commit.js` | 席位 A 反例重跑 `w2fix5r-a-probe.mjs`（3/3：切换前 old/old、切换后 new/new、切换前故障 old/old）；`vault-sync-consumer-facts`/`vault-composed-commit-facts` |
| R2 P0 | **primary search 接 lease**：进程共享 retrieval 的已武装回调与 `startRetrievalIndex`/`requestRetrievalRefresh` 接当前授权 token；撤销后旧回调不写索引、不开新 job；`drain` 先取消未开始 debounce 再等在途 | 新增 `vault-runtime/primary-authorization.js`；`retrieval-runtime.js`（`deps.authorization`）、`retrieval.js`、`search-runtimes.js` | `w2fix5r-r2-probe.mjs`（6/6）+ 仓库测试 `vault-primary-search-lease.test.js`（真实 primary index/retrieval 与真实 `scheduleRetrievalRefresh`） |
| R3 P0 | **固定代次 Git 消费 facade**：leased primary 句柄拿到绑定该代次的 facade，底层 raw 实例不再交给消费者；旧 facade 的直接 sweep/flush 与旧 timer 在 revoke 后拒绝，重新批准也不复活 | `git-runtimes.js`（`leasedGitFacade`、`GIT_FACADE_TARGET`） | `vault-primary-background-lease.test.js`（旧 facade `sweepNow` 拒绝、旧 timer 拒绝、新 facade 工作） |
| R4 P1 | **同句柄绑定幂等**：同一当前 lease 重复解析不替换 guard/token，健康 sweep interval 不被误判失效；只有真实代次变化才换 token 并重新武装 | `git-runtimes.js`（`primary.boundLease` 幂等判断） | `vault-primary-background-lease.test.js`（R4：重复解析后 guard 身份不变、live timer 仍提交） |
| R5 P1 | 契约/文档/索引/候选 note/HANDOFF 与真实契约 revision 一致；删除被反例否定的「顺次赋值 ⇒ 无混用」泛化 | Vault 契约 + 本页 + README 索引 + W2FIX5 候选 note + `HANDOFF-W2FIX5.md` | 契约回读 `sha256:17be8aba5cf50cb4a9310d956c494e26f47ef7caaf09ff0a0fe87270215e8e40` |

**复审入口（W2FIX5）**：

* 席位 16 文件测试集 + 本轮新增测试：`tests 109 / pass 109 / fail 0`。
* `npm run check`（780 syntax / 875 architecture）。
* 独立探针：`w2fix5r-a-probe.mjs`（R1，3/3）、`w2fix5r-r2-probe.mjs`（R2，6/6）、`w2fix5r-r34-probe.log`（R3/R4，3/3，即 `vault-primary-background-lease.test.js`）。
* 全量 `npm test`：3761 pass / 2 fail，两处均为 Windows 并行文件锁/时序 flake（EPERM rename / EBUSY rmdir / 时序），单独复跑通过。

**复审入口（W2FIX4）**：

* 席位 13 文件测试集 + 本轮 3 个新增测试文件：`tests 107 / pass 107 / fail 0`。
* `npm run check`（777 syntax / 872 architecture）。
* 等价探针：`scratch/multi-vault/I437-W2/seat-w2fix4-extended-probe.mjs`（日志 `seat-w2fix4-composed-boundaries.log`、`seat-w2fix4-background-extended.log`、`seat-w2fix4-recovery-floor-probe.log`）+ 席位 6 项检查原文重跑 `seat-w2fix4-extended-check.mjs`（6/6 PASS）。
