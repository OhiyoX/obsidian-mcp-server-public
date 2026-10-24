# MCP GROUPED DTO —— `query_base` 的 `groups` / `summaries` 投射契约（#627 P1）

- **性质**：实现契约（非研究产物）。冻结 `query_base` 在**声明了** `groupBy` / `summaries` 时向 agent 暴露的分组 DTO 形状、五种 `format` 的关系、以及 fail-closed 码。
- **语义来源**：`docs/bases/SEMANTICS-FROZEN.md`（刀4 冻结管线）**不改**；本文件只描述**投射**（计算 → wire），不重新裁定语义。
- **代码来源**（形状取自实际代码，不取自文档猜测）：
  - `app/src/base-query.js` `buildGroupingDto` / `groupKeyDto` / `evaluateBaseView`
  - `app/src/base-grouping.js`（分组模型 + 声明读取 + `groupKeyDto`）
  - `app/src/base-summaries.js` `computeBaseSummaries` / `readSummaryDeclarations`
  - `app/src/tools/workflows.js` `query_base` handler + `projectBaseGroupingDto`
  - 参照实现（同一 DTO 的 Web 侧）：`app/src/app/base-route.js` `normalizeGroup`

---

## 1. 管线与投射位置（不变式）

```
filters → sort → limit(全局行数，分组前) → groupBy(分区) → summaries(按组、post-limit)
```

MCP 面**只做投射**，不参与计算：

| 层 | 负责 |
| --- | --- |
| `base-query.js` `evaluateBaseView` | 计算 `groups` / `summaries`；**未声明 ⇒ 两个键都不存在**（`buildGroupingDto` 返回 `{}`） |
| `tools/workflows.js` `query_base` | 用同一套声明读取器（`readGroupByDeclaration` / `readSummaryDeclarations`）判定「该不该投」；声明存在而结果没有 ⇒ fail-closed（见 §5） |
| `tool-contracts.js` | `query_base` 输出契约把 `groups` / `summaries` 登记为 **optional**，形状按本文件冻结 |

**ADD-only 规则（与刀4、Web 路由一致）**：键的出现**只由声明决定**，不由数据决定。

- 未声明 ⇒ **键不存在**（不是 `null`，不是 `[]`）。
- 声明 `groupBy` 而结果 0 行 ⇒ `groups: []`（键存在，空数组）。
- 声明 `summaries` 而无 `groupBy` ⇒ `groups` 仍存在，且是**唯一一个无键组**（`key: null`, `keyType: "null"`，覆盖全部 retained 行）。

**字段顺序**：`groups` / `summaries` **追加在历史字段之后**，历史前缀逐字节不变：

```
path, view, rows, totalMatched, truncated, supportedSubset, index[, groups][, summaries]
```

`index` 是 `VaultIndex.stats`，语义与投射前后一致（本次未改）。非 json 格式再追加 `format` / `text`（`paths` 另有 `paths`）。

---

## 2. 形状冻结表（每种返回形状写清：不存在 / `null` / `[]`）

| 字段 | 类型 | 何时出现 | 说明 |
| --- | --- | --- | --- |
| `groups` | `Array` | 选中视图声明了 `groupBy` **或** `summaries` | 未声明 ⇒ **键不存在**；0 行 ⇒ `[]` |
| `groups[].key` | `string \| number \| boolean \| null` | 恒在 | JSON 安全值：`null` 组即 `null`；date/datetime → ISO-8601 字符串；link → 目标 path |
| `groups[].keyType` | `"string" \| "number" \| "boolean" \| "date" \| "datetime" \| "link" \| "null"` | 恒在 | 与 `key` 配套的类型标签；缺失/`null`/`NaN`/±Infinity/非法日期统一为 `"null"`（一个组） |
| `groups[].count` | `number` | 恒在 | 组内行数；`Σ count === min(totalMatched, limit)` |
| `groups[].rowPaths` | `string[]` | 恒在 | 组内成员，顺序 = 冻结 `sort` 顺序（**不是** path 顺序），组内不重排 |
| `groups[].summaries` | `{ scope, values }` | **仅当**视图声明了 `summaries` | 未声明 ⇒ 键不存在（不是 `null`） |
| `groups[].summaries.scope` | `"visible-rows"` | 同上 | 域 = post-limit 的 retained 行（B5/E14） |
| `groups[].summaries.values` | `Record<property, { summary, value, reason }>` | 同上 | 每个声明项一条；`value` 为 `number` / ISO 字符串 / `null` |
| `summaries` | `{ scope, values }` | **仅当**视图声明了 `summaries` | 全视图（未分组时=唯一组）的同一计算；未声明 ⇒ 键不存在 |
| `…values[p].summary` | 内置汇总名 | 同上 | 见 `base-summaries.js` 的 P18 名单 |
| `…values[p].reason` | `null \| "empty" \| "type-mismatch" \| "unverified-unit" \| "not-a-column"` | 同上 | 无法计算时给**显式原因**，绝不静默丢项 |

组顺序：`compareBaseValues` 的类型化全序，`groupBy.direction` 只移动**组**（`ASC` 默认）；**无键组恒在最后**（ASC/DESC 皆然）。

---

## 3. 五种 `format` 的关系（选择 + 理由）

| `format` | `content[0].text` | `structuredContent` |
| --- | --- | --- |
| `json`（默认） | 与 §1/§2 的 DTO **同一 JSON** | 同 DTO（无 `format` / `text`） |
| `csv` | 桌面 `toText` 语义的扁平表 | DTO（含 `groups` / `summaries`）+ `format` + `text` |
| `tsv` | 同上（制表符） | 同上 |
| `md` | 桌面 `toMarkdown` 语义的扁平表 | 同上 |
| `paths` | 换行连接的 path 列表 | DTO + `format` + `text` + `paths` |

**决定：分组信息不进扁平文本，但一定进 `structuredContent`。**

理由（最小惊讶）：

1. **文本基线是冻结产物**。A1 的 csv/tsv/md 文本逐字节对齐桌面 `toText` / `toMarkdown`，五种格式的旧回归是硬条件；往文本里插组头/小计会**改变既有消费者的解析结果**，属于把分组展平后伪装成正常行。
2. **意图不丢**。`groups` / `summaries` 与 json 同键、同值地出现在**每一种**格式的 `structuredContent` 里，因此任何格式下「这个视图声明了分组」都可机器判读；不存在「静默吞掉分组」的分支。
3. **不新增第二渲染语义**。文本渲染器继续只认 `columns` + `rows`，不需要知道分组；真要渲染分组时由调用方用 `structuredContent.groups` 自行排版（kanban 等），MCP 面不预设。

**登记的 narrowing**：只读 `content[0].text`（不看 `structuredContent`）的宿主看不到分组。这是刻意的取舍（保文本基线），不是遗漏；工具描述已写明「csv/tsv/md/paths 文本不表达分组，请读 `structuredContent`」。

---

## 4. 与 Web Base route 的关系

同一 `base-query.js` 结果的两个适配器：

| | Web `GET /api/web/v1/base` | MCP `query_base` |
| --- | --- | --- |
| `groups` | 有（`normalizeGroup` 重投影：`key/keyType/count/rowPaths`） | 有（本文件 §2，另含每组 `summaries`） |
| `summaries` | 未投射（页面不渲染汇总） | 有（本文件 §2） |
| 分页/游标 | 有（`nextCursor` 等） | 无（MCP 无游标） |

两者**都不重算**语义，只做字段重投影；MCP 侧因 agent 需要机器可读的汇总值，才多投 `summaries`。

---

## 5. fail-closed 码（`#627` 点名的风险面）

`query_base` 的失败一律是 **MCP tool error**：`isError: true` + `structuredContent: { code, message }`，**绝不**出现「`supportedSubset: true` 却吞掉分组意图」。

| 情形 | `code` | 触发点 |
| --- | --- | --- |
| `groupBy.direction` 非 `ASC`/`DESC` | `unsupported` | `readGroupByDeclaration` |
| `groupBy` 里出现非法键（`directions`/`groupOrder`…） | `unsupported` | 同上 |
| `groupBy.property` 非非空字符串 / `groupBy` 非映射 | `unsupported` | 同上 |
| 汇总名不在内置名单 / 引用自定义 `summaries:` 注册表（`values.*` 面未实现） | `unsupported` | `assertSupportedGroupingKeys` / `computeBaseSummaries` |
| `groupBy` 用 `formula.*` 作键 | `unsupported` | `assertNoFormulaReferencesInGroupBy` |
| 组键为 `list` / `object` | `unsupported` | `groupKeyIdentity` |
| **声明了 `groupBy`/`summaries` 但结果里没有 `groups`** | `unsupported` | `tools/workflows.js` `projectBaseGroupingDto`（#627 新增守卫，防伪成功） |
| 服务自报 `supportedSubset !== true` | `unsupported` | `query_base` handler（同一守卫族） |
| 非选中视图的非法声明 | `unsupported` | `assertSupportedGroupingKeys`（**文档级**，`view` 选择不能洗白，见 #612） |

其余既有码（`view-not-found` / `invalid-schema` / `invalid-yaml` / `invalid-format`）不变；Vault-scope 拒绝保持自己的冻结形状（真实 HTTP 抽样：`vaultId` 非本库 ⇒ `403 {"error":"access_denied"}`）。

---

## 6. 验收

- 新测试：`app/test/mcp-query-base-groups.test.js`（17 例：未声明对拍、分区不变式、`direction`、`summaries` 直算对拍、0 行 / null 键 / limit 截断 / formula 列 / 非选中视图 fail-closed、五种格式、三条负控）。
- DTO lock additive 登记：`app/test/mcp-query-base-dto-lock.test.js`（历史键列表 + 「声明时才追加 `groups`/`summaries`」）。
- 工具发现快照 additive 登记：`docs/review/tool-discovery/inventory.json` 的 `query_base.outputContract`（`bytes 862→1508`、`propertyCount 7→9`、`optionalCount 1→3`、新 `sha256`；`totals.outputSchemaBytes 67098→67744`）+ `inventory.md` 该行 `6/1→6/3`。**只改这一条**，未整体重生成快照（历史快照纪律）。
- 真 HTTP 抽样（`full` / `compact` 两个 profile）：lane 根 `probe-mcp-query-groups.mjs`。
- 负控实测：删掉投射接线（`git stash` 掉 `workflows.js`）⇒ 分组类用例 14 红 / 未声明与 fail-closed 用例仍绿；反转 `base-grouping.js` 的 `direction` 乘子 ⇒ `direction` 用例红。

## 7. `unverified`

- 只读 `content[0].text` 的宿主看不到分组（§3 登记的 narrowing，未做宿主侧验证）。
- 桌面端是否把汇总渲染进表格文本，本文件**不主张** parity：csv/tsv/md 的文本保持 A1 冻结基线（= 桌面 `toText`/`toMarkdown` 的行集合），分组文本渲染属未取证范围。
