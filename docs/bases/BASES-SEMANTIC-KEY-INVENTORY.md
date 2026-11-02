# BASES-SEMANTIC-KEY-INVENTORY — Bases P1 Wave 0-A 语义键分类矩阵

- lane / owner：`bases-p1/W0A`（分支 `test/bases-w0a-semantic-keys`）；本文件由该 lane 独占新建
- BASE_SHA（冻结，实测）：`f258427a1f430e89f08a6005970e085d23c717f5`（= 开工时 `origin/main`，Bases 域文件 `<BASE>..origin/main` 零改动）
- 权威契约：vault `_Workspace/40-Projects/obsidian_mcp_server/MCP/TODO - 增强 Bases 支持.md` 的「2026-10-05 P1+ 完整开发契约」§1–§19；派发口径 §19
- 席位裁定（必须落进本文件）：`scratch/bases-p1/reviewer-ack.txt`（红测形态 + 更宽静默面必须一并表征/分类 + 最小证据集）
- 冻结测试表：`app/test/bases-semantic-keys-characterization.test.js`（`SEMANTIC_KEY_CASES`；本刀 27 pass / 0 fail / 0 skip / 0 todo）
- 官方来源（**本刀自取 verbatim**，不是转述）：`https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Bases/Bases%20syntax.md`（= `https://obsidian.md/help/bases/syntax` 的官方 help 源；2026-10-05 抓取）。引文与出处见 §6 与本 lane 的 `official-syntax-verbatim-quotes.md`
- 证据纪律：本文件每一条「现行行为」都有本刀亲跑的测试用例（键路径 ↓ 表 = 冻结表 keyPath，逐条对应）或亲读的 `file:line`；凡未能自核的官方语义一律标 **`PENDING-VERIFY`**，不得当作权威原文引用

## 0. 口径

- 现行行为（本刀实测冻结）：
  - `ACCEPT-consumed` — 文档通过校验，且该键被 `evaluateBaseView` 实际消费（影响 rows / 顺序 / 列 / 标签 / 上限）
  - `ACCEPT-silent` — 文档通过校验，键被完全忽略；调用方仍得到 `supportedSubset: true` 与平铺 rows
  - `REJECT <code>` — 明确失败（W0-D 已把 3 个语义键与 filter 未知 namespace 翻到 `unsupported`；实施记录见 §9）
- 分类：
  - `SUPPORTED` — 已实现并有 characterization
  - `KNOWN-UNIMPLEMENTED-SEMANTIC` — 官方核心语义，未实现，**未实现前必须 fail closed**
  - `DISPLAY-METADATA` — 只影响展示（或属视图自有状态），可在明确契约下消费或忽略，不属 fail-closed 面
  - `NOT-APPLICABLE` — 不在官方 schema 内、本可移植子集不解释的键
- 现行校验点：键的读取/校验位置（`validateBaseDocument` = `app/src/base-query.js:83-100`，`compileBaseView` = `:121-133`，`evaluateBaseView` = `:277-320`）

## 1. 顶层键矩阵

| 键路径 | 官方语义（引文见 §6） | 现行行为 | 分类 | 现行校验点 `file:line` | 建议归属 Wave | W0-D flip |
| --- | --- | --- | --- | --- | --- | --- |
| `filters` | 全局过滤，对所有 view 生效；与 view 级 filters 求值时 AND 合并 | ACCEPT-consumed（先 base 后 view） | SUPPORTED | 读取 `app/src/base-query.js:279`；求值 `app/src/workflows.js:167` | — | no |
| `formulas` | 定义可在所有 view 显示的公式属性 | ACCEPT-consumed（`compileBaseView` 在任何 filter/limit/空结果之前全量编译；仅 `file.asLink(if(property, property, file.name))` 子集） | SUPPORTED | `app/src/base-query.js:124`；`app/src/base-formulas.js:138` | — | no |
| `properties` | 每属性的配置容器；表格里 displayName 用作列头；displayName 不参与 filter/formula | ACCEPT-consumed（只读 `formula.*` 键的 displayName） | SUPPORTED | `app/src/base-query.js:140-147` | 非 formula displayName 另开窄刀（见 §3） | no |
| `summaries` | 自定义 summary 公式：`values` 是结果集内该属性的全部值列表，summary 须返回单个 `Value` | REJECT `unsupported`（W0-D；非空即拒；`{}`/`null` 视为缺失） | KNOWN-UNIMPLEMENTED-SEMANTIC | 守卫 `app/src/base-query.js` `assertNoUnimplementedSemanticKeys`（`compileBaseView`） | **已完成（W0-D）** | **done** |
| `views` | 视图列表；每条定义同一数据的一个视图 | ACCEPT-consumed | SUPPORTED | `app/src/base-query.js:86-97`（数组/逐 view 校验）、`:128`（选择） | — | no |
| `<unknown top-level key>` | 官方 syntax 页只定义上述 5 个顶层节，且**无**顶层扩展条款（顶层 schema 封闭性未给出机器可读定义） | ACCEPT-silent（`theme: dark` 实测被忽略） | NOT-APPLICABLE | 无 | W0-D 不做；登记为待席位裁定的开放项（§6.8） | no |

## 2. view 键矩阵

| 键路径 | 官方语义（引文见 §6） | 现行行为 | 分类 | 现行校验点 `file:line` | 建议归属 Wave | W0-D flip |
| --- | --- | --- | --- | --- | --- | --- |
| `views[].type: table` | `type` 选择内置/插件视图类型；官方所有示例均为 table | ACCEPT-consumed（唯一真正实现的类型；无类型分派，table 即平铺 rows） | SUPPORTED | `app/src/base-query.js:90`（仅要求存在）、`:150-154`（列 DTO） | — | no |
| `views[].type: cards` | 同上；cards 为内置视图类型 | ACCEPT-silent（当 table 平铺，`views[]` 里仍回显声明类型） | DISPLAY-METADATA | `app/src/base-query.js:90`（不校验取值）、`:326-332`（回显） | Web 产品面（契约 §4 排除 P1） | no |
| `views[].type: list` | 同上；list 为内置视图类型 | ACCEPT-silent（同上） | DISPLAY-METADATA | 同上 | Web 产品面 | no |
| `views[].type: map` | 同上；map 为内置视图类型，另用视图自有键存经纬度/标题映射 | ACCEPT-silent（同上；map 自有键同样被忽略） | DISPLAY-METADATA | 同上 | Web 产品面 | no |
| `views[].type: <unknown>` | `type` 亦可来自插件（插件视图类型不自动执行，契约 §4） | ACCEPT-silent（无法区分插件类型与拼写错误） | DISPLAY-METADATA | 同上 | 需与 §4 插件边界一并复核（`PENDING-VERIFY`） | no |
| `views[].name` | 显示名，可用于定义默认视图 | ACCEPT-consumed（选择 view、`snapshot.view`、Web 选择器） | SUPPORTED | `app/src/base-query.js:91`（必填）、`:128` | — | no |
| `views[].limit` | 官方示例含 `limit: 10`，但 prose 未定义其语义（列/行/组上限均未说明）⇒ `PENDING-VERIFY` | ACCEPT-consumed（正安全整数；对平铺 rows 生效，request limit 优先） | SUPPORTED | `app/src/base-query.js:95-97`（校验）、`:306`（应用） | 语义精确化登记到 W0-B 矩阵 | no |
| `views[].filters` | 与全局 filters 语法相同，只作用于该 view；与全局 filters AND 合并 | ACCEPT-consumed | SUPPORTED | `app/src/base-query.js:279` | — | no |
| `views[].order` | 官方仅示例列出属性序列，prose 未定义（列顺序 / 投影列集）⇒ `PENDING-VERIFY` | ACCEPT-consumed（= 投影列集，决定 `columns` 与每行 `values` 键；缺省 `["file.path"]`） | SUPPORTED | `app/src/base-query.js:130`、`:150-154`、`:307` | 语义精确化登记到 W0-B 矩阵 | no |
| `views[].sort` | **官方 syntax 页无 `sort` 键**；官方仅说表格视图可用自有键"select which column is used to sort rows and in which direction" ⇒ 键名与持久化形态 `PENDING-VERIFY` | ACCEPT-consumed（本实现的排序键：`{property, direction}`；无声明时**不排序**，保持候选记录原序） | SUPPORTED | `app/src/base-query.js:298`、`:305`；`app/src/workflows.js:190` | W0-B 核对官方等价形态（本实现扩展键） | no |
| `views[].groupBy` | 指定属性与方向，按该属性值把行放进分组 | REJECT `unsupported`（W0-D；非空即拒） | KNOWN-UNIMPLEMENTED-SEMANTIC | 守卫 `app/src/base-query.js` `assertNoUnimplementedSemanticKeys`（`compileBaseView`） | **已完成（W0-D）** | **done** |
| `views[].summaries` | 属性名 → 具名 summary；对全部行做聚合 | REJECT `unsupported`（W0-D；非空即拒） | KNOWN-UNIMPLEMENTED-SEMANTIC | 守卫同上 | **已完成（W0-D）** | **done** |
| `views[].cardSize` | 官方 syntax 页未定义；按 view 扩展条款属视图自有状态 | ACCEPT-silent（忽略，rows/DTO 不变） | DISPLAY-METADATA | 无 | Web 产品面 | no |
| `views[].image` | 官方 syntax 页未定义；按 view 扩展条款属视图自有状态 | ACCEPT-silent（忽略，rows/DTO 不变） | DISPLAY-METADATA | 无 | Web 产品面 | no |
| `views[].<unknown key>` | 官方明确允许：视图条目可携带维持状态/渲染所需的任意自有数据 | ACCEPT-silent（忽略） | DISPLAY-METADATA | 无 | 官方语法变更时复查（W0-B 维护） | no |

## 3. `properties.<key>` 配置键矩阵

| 键路径 | 官方语义（引文见 §6） | 现行行为 | 分类 | 现行校验点 `file:line` | 建议归属 Wave | W0-D flip |
| --- | --- | --- | --- | --- | --- | --- |
| `properties.formula.note.displayName` | 官方示例对 `formula.formatted_price` 给 displayName；表格用它作列头 | ACCEPT-consumed（列 label = displayName） | DISPLAY-METADATA | `app/src/base-query.js:140-147`（`isFormulaProperty` 分支） | — | no |
| `properties.status.displayName` | 官方示例对 note 属性 `status` 同样给 displayName；"Display names are not used in filters or formulas" | ACCEPT-silent（**被忽略**：列 label 回退为点后缀 `status`） | DISPLAY-METADATA | `app/src/base-query.js:140-147`（非 formula 分支不过 displayName） | 独立展示窄刀（见 §6.6） | no |
| `properties.status.<unknown config key>` | "It is up to the individual view how to use these configuration values" ⇒ 属性配置可携带视图自有键 | ACCEPT-silent（忽略） | DISPLAY-METADATA | 无（`properties` 整体不做键级校验） | — | no |

## 4. adapter 层事实（逐条 `file:line`，本刀亲读）

契约 §2.4 要求先证明"adapter 是否已在别处提前拒绝"，再决定红测落点。结论：**两侧 adapter 都没有键级拒绝路径**，静默面在 domain 层就已成立并被 adapter 原样放大。

| adapter | 事实 | `file:line` |
| --- | --- | --- |
| MCP `query_base` | 直接 `evaluateBaseView` 后重组 DTO，`supportedSubset: true` **硬编码**（域层返回值在返回值里根本没被读） | `app/src/tools/workflows.js:428`（调用）、`:431`（硬编码） |
| MCP `query_base` 契约面 | DTO 只回 `path/view/rows/totalMatched/truncated/supportedSubset/index`；`views`/`columns`/`viewLimit` 被刻意排除 ⇒ 即使域层新增 capability 也无法透出；`limit` 上限 5000 | `app/src/tools/workflows.js:417`（inputSchema）、`:429-431`（DTO 注释与返回） |
| Web Base 路由 | `if (result?.supportedSubset !== true) throw 422 unsupported` —— 但域层恒返回 `true`（`app/src/base-query.js:313`）⇒ **该守卫当前恒不触发（死守卫）** | `app/src/app/base-route.js:106-108` |
| Web Base 路由（响应） | 再次硬编码 `supportedSubset: true`；同时已声明 `capabilities: { editable: false, grouping: false, aggregation: false }` 却**不因此拒绝**含 groupBy/summaries 的文档（静默平铺） | `app/src/app/base-route.js:156`、`:157` |
| Web 快照 seam | 只做 view 名桥接 + `view.limit` 夹取；除 `parseAndValidateBase` / `compileBaseView` 外**无键级校验**，因此域层放行什么就透传什么 | `app/src/app/base-snapshot-adapter.js:29-43` |
| 域层校验面 | 只校验：Base root 为对象、`views` 为数组、每个 view 的 `type`/`name` 存在、`limit` 为正安全整数；另加两个公式守卫（sort/filter 不得引用 formula；`order` 引用的 formula 必须已声明）。**没有任何 key 级 allowlist/denylist** | `app/src/base-query.js:83-100`、`:121-133`；公式守卫 `app/src/base-formulas.js:161`、`:188` |
| 顶层 `sort` 的不一致（附带发现） | `assertNoFormulaReferencesInSortOrFilter` 会检查 `base?.sort`，但 `evaluateBaseView` 只读 `view?.sort` ⇒ 顶层 `sort` 带 formula 引用会 `unsupported`，不带引用则被完全忽略 | 守卫 `app/src/base-formulas.js:161-187`；消费点 `app/src/base-query.js:298`（仅 `view?.sort`） |

## 5. 未证实 / `PENDING-VERIFY` 清单

| # | 项 | 为什么未证实 | 影响 |
| --- | --- | --- | --- |
| P1 | `views[].limit` 的官方作用点（全局行数 / 每组行数 / 列数） | 官方 syntax 页只在示例里出现 `limit: 10`，prose 未定义 | W0-B 兼容矩阵；契约 §6.4 B4 已登记 |
| P2 | `views[].order` 的官方语义（列集 vs 行序） | 同上（仅示例） | 我们把它当投影列集，官方是否如此未证 |
| P3 | `views[].sort` 的官方键名与持久化形态 | 官方 syntax 页无 `sort`；只有"表格视图可用自有键决定排序列与方向"的泛指 | 我们支持 `sort` 属实现选择；W0-B 需核对 |
| P4 | `views[].cardSize` / `views[].image` 的官方来源 | 官方 syntax 页没有任何提及（推测为 cards 视图自有状态） | 分类为 DISPLAY-METADATA 依据的是"视图自有键"条款，而非逐字定义 |
| P5 | 桌面 Obsidian 对未知顶层键 / 未知 `type` 值的行为（报错还是忽略） | 本机无 headless 桌面 Obsidian（同 `SEMANTIC-ORDER-BLOCKERS.md` 的约束） | §1/§2 未知行只做"我们怎么做"，不声称与 Obsidian 一致 |
| P6 | `properties.<key>` 于 file 属性（如 `file.ext`）的 displayName 是否也被表格采用 | 官方示例给了 `file.ext`，但我们没有 file 属性列的 displayName 消费路径 | §8.6 的展示窄刀需一并覆盖 |

## 6. 官方引文（verbatim，自取）

出处：`https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Bases/Bases%20syntax.md`（2026-10-05，Asia/Shanghai）。本 lane 的同内容摘录留档：`scratch/bases-p1/W0A/official-syntax-verbatim-quotes.md`。

- 顶层节：`filters`、`formulas`、`properties`、`summaries`、`views`（官方示例逐字）。
- `filters`："The `filters` section lets you define conditions to narrow down the dataset."；"There are two opportunities to apply filters: 1. At the global `filters` level (shown above) where they apply to all views in the base. 2. At the `view` level where apply only to a specific view."；"These two sections are functionally equivalent and when evaluating for a view they will be concatenated with an `AND`."
- `formulas`："The `formulas` section defines formula properties that can be displayed across all views in the base file."
- `properties`："The `properties` section allows storing configuration information about each property. It is up to the individual view how to use these configuration values. For example, in tables the display name is used for the column headers."；"Display names are not used in filters or formulas."
- `summaries`（顶层）："The `summaries` section can be used to define custom summary formulas. In addition to defining summary formulas here, there are several default summary formulas available."；"In summary formulas, the `values` key word is a list containing all of the values for that property across every note in the result set. The summary formula should return a single `Value`."
- `views`："The `views` section defines how the data can be rendered. Each entry in the `views` list defines a separate view of the same data, and there can be as many different views as needed."
- `type`："`type` selects from the built-in and plugin-added view types."
- `name`："`name` is the display name, and can be used to define the default view."
- view `filters`："`filters` are exactly the same as described above, but apply only to the view."
- `groupBy`："`groupBy` specifies a property and sort direction. The value of the specified property for each row is used to place the row into groups."
- view `summaries`："`summaries` maps property names to a named summary. Summaries perform an aggregation on the property across all rows."
- 视图自有键："Views can add additional data to store any information needed to maintain state or properly render, however plugin authors should take care to not use keys already in use by the core Bases plugin. As an example, a table view may use this to limit the number of rows or to select which column is used to sort rows and in which direction. A different view type such as a map could use this for mapping which property in the note corresponds to the latitude and longitude and which property should be displayed as the pin title."
- 官方示例 view 逐字包含：`type`、`name`、`limit: 10`、`groupBy: {property, direction}`、`filters`、`order`、`summaries`；**没有** `sort`、`cardSize`、`image`。

## 7. 本刀证据

- 冻结表与逐条断言：`app/test/bases-semantic-keys-characterization.test.js`（24 行 `SEMANTIC_KEY_CASES` + 正控 + 2 条自洽用例；本刀实跑 27 pass / 0 fail / 0 skip / 0 todo）
- 矩阵 ↔ 冻结表一致性脚本：`scratch/bases-p1/W0A/check-matrix-consistency.mjs`（逐条比对 keyPath 集合、现行行为、分类、flip 标记）
- 负控（仪器自证）：`scratch/bases-p1/W0A/negative-control-red.log`（临时改错一条期望 → 必红；未提交该改动，还原后 sha256 一致）
- 门禁：`scratch/bases-p1/W0A/focused.log`、`check.log`、`full-suite.log`
- 环境偏离（必须知情）：开工时 lane 的 `app/node_modules` Junction 指向的共享安装 `repo/app/node_modules` 已被清空（0 项），本 lane 为跑门禁把它重指向一个 `package-lock.json` sha256 与 BASE 完全一致的既有安装（未执行 `npm ci`/`npm install`），详见 HANDOFF。
## 8. W0-D 冻结建议（每项都有本刀实测证据）

翻转清单（机器可查常量）：`FLIP_TO_UNSUPPORTED_IN_W0D = ["views[].groupBy", "views[].summaries", "summaries"]`（见冻结测试文件顶部；测试内有一条自洽用例断言"清单 ↔ 每行 `flip` 标记"永不漂移）。

1. **`views[].groupBy` → flip `yes`（`unsupported`）**。理由：官方核心语义（"The value of the specified property for each row is used to place the row into groups"），现行实现完全忽略却回 `supportedSubset: true`，直接命中契约 §2.2 与 §17；证据：本刀 case `views[].groupBy`（3 行平铺、DTO 键集合无任何 group 元数据、rows 形状恒为 `{path, values}`）。
2. **`views[].summaries` → flip `yes`**。理由：官方聚合语义（"Summaries perform an aggregation on the property across all rows"）；忽略它会让调用方以为聚合已生效。
3. **`summaries`（顶层）→ flip `yes`**。理由：官方自定义 summary 公式（`values` → 单值）；与 2 同源，必须同刀翻转，否则"顶层 summaries 用不了但 view summaries 能查"的语义更混乱。
4. **`views[].type` 非 `table`（cards / list / map / 未知）→ flip `no`，分类 DISPLAY-METADATA**。理由：① 本刀实测 4 个非 table 值在 rows / totalMatched / truncated / DTO 键集合上与 table **逐字节同构**（同一冻结表），即它不改变 domain 行集合语义；② 官方把视图条目定义为可携带自有展示状态，且 `type` 也包含插件视图；③ 契约 §4 已把 Cards/List/Kanban/Map 的 Web 视觉 parity 排除在 P1 之外，在 domain 层 fail closed 会把"取数"一起拒掉，属超范围。**已考虑的反对方案（拒绝一切非 table type）被否**：它无法区分"官方内置 cards/list/map"与"插件视图/拼写错误"，会把 out-of-scope 变成"数据完全不可查"。**残余风险**：adapter 不得声称渲染了声明类型（Web 未回显 type、MCP DTO 不含 type），建议在 Wave 0 PR 的文档或后续 adapter 刀里写明"声明类型仅作展示提示，不改变行集合"（W0-D 的 owner 面只有 `app/src/base-query.js`，不承担 adapter 改动）。
5. **`views[].cardSize` / `views[].image` → flip `no`，分类 DISPLAY-METADATA**。理由：官方 syntax 页未定义这两键，按"视图条目可携带任意自有数据"条款属视图自有状态；本刀实测忽略它们后 rows / DTO 完全不变。`PENDING-VERIFY`（P4）只影响"它们到底属于哪个内置视图"，不影响"它们不是 core 语义"的结论。
6. **非 formula `properties.<key>.displayName` → flip `no`，分类 DISPLAY-METADATA，但必须**消费**（独立展示窄刀，不属 W0-D）**。理由：官方明确"in tables the display name is used for the column headers"，且官方示例对 note/file/formula 三类属性都给 displayName；现行 `columnLabel`（`app/src/base-query.js:140-147`）只对 `formula.*` 读 displayName ⇒ `properties.status.displayName` 被忽略（本刀 case 冻结 label = `status`）。这是显示 parity 缺口、不是语义 fail-closed 缺口；把它塞进 W0-D 会同时改展示行为，违反 W0-D"只加守卫"的 owner 边界。
7. **`views[].<unknown key>` → flip `no`，分类 DISPLAY-METADATA**。官方逐字允许视图自有键，因此不属 fail closed 面；风险由 W0-B 兼容矩阵 + 官方语法变更复查承担。
8. **`<unknown top-level key>` → 建议 W0-D 不 flip，登记待裁定**。理由：官方定义了 5 个顶层节但未给出机器可读 schema，也未说明未知顶层键是否非法（`PENDING-VERIFY` P5，本机无法用桌面 Obsidian 验证）；本刀实测到的唯一具体危害是顶层 `sort`（§4 末行：guard 检查 `base?.sort`、消费点只读 `view?.sort`），而该键在带 formula 引用时已经被拒绝、不带引用时只是被忽略。若无官方证据就 reject，存在拒绝合法文件的风险，且属"扩大 parser"而非 Wave 0 目标。**若席位选择收紧**，最小实现是"未知顶层键 → `unsupported`"，并把顶层 `sort` 单列说明。

翻转的**用户可见影响**（已落在 W0-D）：任何使用 `groupBy` / `summaries` 的真实 `.base` 在 `query_base` 与 Web Base API 上从"静默平铺 + `supportedSubset: true`"变为明确的 `unsupported`（MCP 错误 / Web 422）。这是契约 §2.2 要求的语义，但属可见行为变化。

> **状态：已实施（Wave 0-D，2026-10-06）。** 实施记录见 §9。下面 1–8 项保留为 W0-D 的冻结依据原文。

## 9. Wave 0-D 实施记录（本刀验收后回填）

- **已 fail closed（`unsupported`，查询/编译路径）**
  - `views[].groupBy`、`views[].summaries`、顶层 `summaries`：非空即拒；`{}` / `[]` / `null` / `undefined` 按"缺失"处理。落点 `app/src/base-query.js` `compileBaseView` → `assertNoUnimplementedSemanticKeys`（文档级：声明了这些键的任何 view 都会拒绝，不只看被选中的 view，因为 `queryBaseSnapshot` 会把所有声明 view 一起回传）。
  - filter 表达式的**未知 namespace**：带点引用的前缀 ∉ {`file`, `note`} → `unsupported`（`this.file.folder == ""` 不再静默匹配 0 行）。落点 `app/src/workflows.js` `evaluateBaseExpression` → `assertFilterPropertyNamespace`（裸属性不受影响；`formula.` 仍由 `assertNoFormulaReferencesInSortOrFilter` 提前拒）。
  - **正控**：`validateBaseDocument` 对上述文档仍返回 `[]`（写/读路径不变，`get_base` / `write_base` 不受影响）。
- **DISPLAY-METADATA（不翻转，行集合不变）**：`views[].type` 全部取值、`cardSize`、`image`、未知 view 键、未知 `properties.*` 配置键 — 明文契约见 `docs/bases/BASES-COMPATIBILITY-MATRIX.md` §12.1。
- **DEFERRED（登记，本刀不修）**：未实现 `file.<prop>` → P1-A typing；继承属性读取 → P1-A 安全加固；非 formula `displayName` → 展示窄刀；未知顶层键（含顶层 `sort`）→ 待席位裁定。逐条见 `BASES-COMPATIBILITY-MATRIX.md` §12.2。
- **本刀未做**：任何 grouping / summaries **语义实现**（`SEMANTIC-ORDER-BLOCKERS.md` 未清零）；任何 adapter 生产文件改动；任何工具描述 / registry / inventory / cost-gate 改动。
- **adapter 证据**：`app/test/bases-fail-closed-adapters.test.js`（MCP `query_base` 错误 + Web 路由 **422 `unsupported`**），用真实 McpServer / Express harness，不改生产代码。


