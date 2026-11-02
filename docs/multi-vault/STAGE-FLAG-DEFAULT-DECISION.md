# 阶段开关与默认值 — 决策提案（Wave F2）

> **状态：proposal（未实施）。本刀不改任何行为。**
> owner：Wave F2（文档 / 契约工件面）。范围依据：契约 §31 "Stage flag default decision"。
> 裁定人：**用户**（契约/发布 owner）；协调方决定组装顺序；审查席位复核"未实施"边界。
> 核验基线：`ad892d99`（Wave D 收口）。下文每条"现状"都可在该基线的源码里指到行号。

本文只做四件事：**现状 → 选项（≥2）→ 各自影响 → 建议与理由 → 需要谁裁定**。它不新增环境变量、不改 registrar、不改 `server_info`、不动 capability 图。

## 1. 现状（可核验事实）

| # | 事实 | 证据（BASE `ad892d99`） |
| --- | --- | --- |
| 1 | 仓库里**没有**多库阶段开关。全树搜索 `MULTI_VAULT` 只命中一个用途无关的测试常量 | `app/test/vault-runtime-factory-core.test.js:111` 的 `MULTI_VAULT_KEYS`（断言 health 不泄露这些键），不是 env 开关 |
| 2 | 多库是**始终开启**的：每次启动都物化 per-Vault runtime map 并 refresh；失败只降级为 primary-only + 一条 warn | `app/server.js:193-200`（`createVaultRuntimeMap` → `vaultRuntimeMap.refresh()`，catch 后 `[vault-scope] Vault runtime map is primary-only`） |
| 3 | 事实上的"关闭态"= **不配置 Vaults root**：此时唯一合法 id 是 `default`，服务等价于 primary-only | `app/src/app/vault-registry.js:16-18`、`:45-47`（`VAULTS_ROOT` 为空 → `defaultWebVaultId()` 返回 `"default"`） |
| 4 | 契约 §22.1 建议的 `MCP_MULTI_VAULT_ENABLED=false`（Stage 0）**从未实现**，因此 Wave C/D/E 的全部门禁都是在"多库全开"下跑的 | 契约 §22.1；同上 1–3 |
| 5 | capability 是"运行事实"的权威图：13 键中 9 键 `available:true`，其余 4 键显式 `{available:false, reason}` | `app/src/vault-runtime/capabilities.js`（`WIRED_CAPABILITY_KEYS` = notes, files, history, trash, git, memory, skills, plans, publish） |
| 6 | `server_info.vaults[].capabilities` **仍返回 A2 的 fail-closed 默认图**（13 键全 false + 一条共用 reason），primary 也一样 ⇒ 它现在不是"接线报告" | `app/src/tools/info.js:24`（`capabilities: defaultCapabilitiesFor()`）+ `app/src/vault-runtime/registry.js:81` |
| 7 | 渐进式工具发现的 profile 默认是 `full`，且离线成本闸门结论是 `hold`（= 生产默认保持 `full`），这是一条**已经做出**的"阶段默认值"先例 | `app/src/discovery-config.js:41`；`docs/review/tool-discovery/p2c-cost-gate/cost-gate.json`（`gate.decision = "hold"`, `productionDefaultProfile = "full"`） |
| 8 | `webCatalog` 已被席位裁定为**复合能力**（notes/files/search 的聚合，不是某个 tool 独占的原语），D-workflows 因此零翻转并获照准 | 契约 §3.4/§31；`app/src/vault-runtime/capabilities.js` 的 unwired reason |

一句话现状：**代码处在"Stage 2 常开"形态，用 root 缺席表达 primary-only；契约建议的显式开关不存在。**

## 2. 决策项

### D-F2-1 多库是否需要显式阶段开关？

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（保持）** | 不引入开关。保持"始终开启 + root 缺席 = primary-only" | 零改动；回滚路径 = 移除/改名 Vaults root + 重启（已有：`WEB_VAULTS_ROOT` 空则唯一 id `default`）。代价：没有"不重建注册表就把多库关掉"的一键开关；运维需要理解 root 缺席语义 |
| **B** | 新增 `MCP_MULTI_VAULT_ENABLED`，**默认 `true`**（等价 kill switch） | 多一条可观测/可回滚路径，但默认行为不变 ⇒ 需要为新开关补两态门禁（开/关各跑一次 `tools/list` schema gate）。代价：新增一个"必须同时维护两态"的配置面 |
| **C** | 新增 `MCP_MULTI_VAULT_ENABLED`，**默认 `false`**（= 契约 §22.1 的 Stage 0） | 最保守，但与已合并的 Wave C/D 事实冲突：registrar 的 schema 注入、per-Vault runtime 物化、9 键接线都已在 `main`；默认关会让默认行为与已验收测试矩阵不一致，等于把"已上线事实"重新变成条件功能。需另开一刀实现+验收 |

**建议：A。** 理由：
1. 契约 §22.1 的 Stage 0 是**当时**为了"组合树验证"而设的过渡态；该目标已由 W0-A..F 的 characterisation + Wave C/D 的完整双库矩阵达成，再引入默认关闭的开关属于把已合并事实重新条件化（§23 规则 8 之外的新语义）。
2. "关闭"已经有了不需要新代码的表达：不配置 `OBSIDIAN_VAULTS_ROOT` ⇒ 唯一 id `default` ⇒ 全部请求落在 primary（事实表 #3）。
3. 若运维确实需要"不重启根目录就把多库关掉"，B 是更省的折中（默认不变、只加 kill switch），但必须连带补两态 schema gate 与文档。

### D-F2-2 `webCatalog` 这类复合能力的默认与呈现

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（保持）** | 保持 `{available:false, reason}`；复合能力不进 map 级图，聚合事实由组合层（搜索/Web catalog）各自报告 | 与既有席位裁定一致；`server_info`/Admin 会显示 `不可用：...`，需要文档解释，否则操作方会误读成"功能缺失" |
| **B** | 在组合层把 `webCatalog` 标为 `available:true` | 会引入"能力 = 聚合体状态"的新语义（§3.4 要求 capability 是运行事实），需要先定义"哪个组合层有资格代表它"，否则就是 over-claim（D-workflows 的反向负控场景） |
| **C** | 从 `CAPABILITY_KEYS` 删除 `webCatalog` | 是**改契约**（§3.4 列表），影响 `CAPABILITY_KEYS` 的冻结断言与 Admin/`server_info` 形状 |

**建议：A**（保持 false + reason），并把"复合能力"的解释写进用户文档（本刀已在 `docs/USER_CONFIGURATION.md` 与 README 写出）。若选 C，属契约变更，需用户裁定并由独立刀实施。

### D-F2-3 `MCP_DISCOVERY_PROFILE` 的默认值

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（保持 `full`）** | 与离线成本闸门 `hold` 结论一致 | 零改动；客户端仍然看到全部 87 个工具 |
| **B** | 默认切 `core`/`module` | 需要新的**端到端**证据（静态覆盖率不等于任务成功率；`default-shrink-readiness` 闸门正是因此 fail） |

**建议：A。** 这是"默认值决策"的既有先例：离线证据只支持 `hold`，因此生产默认不能收紧。

### D-F2-4 `server_info.vaults[].capabilities` 的语义（F1 收敛项，与本文档绑定）

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A** | 改为报告**该 Vault 的真实接线图**（`vault-runtime/capabilities.js` + 组合层的 retrieval/semantic 事实） | 需要 `app/src/**` 改动（Wave F1 的 §31 收敛面），并由架构门禁钉住；之后 `server_info` 才能当"能力报告"读 |
| **B** | 保持 fail-closed 默认图，但改名/加注，避免被当成接线报告 | 零代码风险，但运维仍拿不到 per-Vault 能力事实 |

**建议：A + 过渡期 B**：过渡期文档必须写明"当前 `server_info.capabilities` 是 fail-closed 默认图"（已写入 `docs/USER_CONFIGURATION.md` 的 Multi-Vault 章与根 README），把实现留给 F1 的 §31 收敛刀。

## 3. 需要谁裁定

| 决策 | 裁定人 | 需要对方定什么 |
| --- | --- | --- |
| D-F2-1 | 用户 | 采纳 A / B / C；若选 B 需同时批准"两态 schema gate"作为额外验收 |
| D-F2-2 | 用户（仅 C 需裁定；A/B 属实现层） | 是否允许改 §3.4 的 capability 列表 |
| D-F2-3 | 用户 | 是否维持 `full` 为生产默认（本刀建议维持） |
| D-F2-4 | 协调方 | 是否把 A 并入 F1 的 §31 收敛，及组装顺序 |
| 全部 | 审查席位 | 复核"未实施"边界：本刀没有任何 env/行为改动 |

## 4. 本刀边界（明确不做）

- 不新增/读取任何开关环境变量；不改 registrar、`server.js`、`server_info`、capability 图。
- 不改 `docs/review/tool-discovery/**` 的生成工件（这些是可复算工件，见 `docs/TOOL_DISCOVERY.md` 的 Artifact provenance 段）。
- 若裁定为 D-F2-1 B/C，需要**独立实现刀**，并且按契约 §22.1 在正式启用前跑一轮真实的 `tools/list` schema gate（开/关两态）。
