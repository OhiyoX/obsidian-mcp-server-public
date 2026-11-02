# Bases 分组模型（`base-grouping.js`，纯模型）

> 归属：Bases P1 / **W2-A**（第一段：纯模型）+ **刀4**（第二段：接线，`fix/bases-cut4-grouping`）。owner：`app/src/base-grouping.js`。
> 权威来源：契约 §7（模块划分）/ §9（groupBy 契约）/ §11（canonical pipeline）/ §13/§14.5（分组矩阵）；
> 语义依据：`SEMANTICS-FROZEN.md`（P9/P10/P11 = 组序与无键组位置；P2/P6/P7 = limit 早于分组）与旧 `SEMANTIC-ORDER-EVIDENCE.md` **B3 / B4 / B6**（B7 的"空组在最小侧"已被 **D1** 取代，见 §3）；切法裁定：`review-verdict-P1D-GO.md` §2.1。
> 本文件描述**已接线**的模型与它在 `base-query.js` 里的编排（§9）。
> **注**：旧依据文件 `SEMANTIC-ORDER-EVIDENCE.md` **不在本仓**（位于 `scratch/bases-p1/`，`git ls-files` 无此项）；D1–D5 的回填落在本文件 §3/§8 与 `BASES-COMPATIBILITY-MATRIX.md` §14。

## 0. 一句话语义

输入**已排序**的行序列与**已求值**的组键，输出**扁平 rows 的组边界**
（`{ boundaries, totalGroups }`）：组间按组键排序（**无键组恒在最后**，D1），组内保持调用方排序序，
不复制行载荷、不做 filter / sort / limit、不做属性解析、不做公式求值。

## 1. 输入契约

```js
buildBaseGroups(sortedRows, groupBy, options?)
```

| 参数 | 形状 | 语义 |
| --- | --- | --- |
| `sortedRows` | `ReadonlyArray<unknown>` | **已排序**的行序列（B3：调用方负责 `filter → sort`）。本模块不重排、不复制、不修改该数组 |
| `groupBy.property` | `string`（非空，必填） | 组属性名；用于默认读值路径与错误文案。**不是**属性解析：见下 |
| `groupBy.direction` | `"ASC" \| "DESC"`（可选，默认 `"ASC"`） | 组序方向；非法值 fail closed（大小写敏感） |
| `groupBy.keyOf` / `options.keyOf` | `(row, index) => unknown`（可选） | **组键 seam**：由调用方返回**已求值**的组键。`options.keyOf` 优先 |
| 返回值 | `{ boundaries, totalGroups }`（冻结） | 见 §5 |

- **不做属性解析、不做公式求值**：给了 `keyOf` seam 时，本模块**完全不读**行属性，seam 的返回值就是组键；
  未给 seam 时只做一次**自有数据属性读**（own data property，`readOwnDataProperty`）——继承属性与
  accessor/getter **永不执行**（契约 §7 / §14.7）。
- **不做 filter / sort**：模块内没有任何过滤或行排序；行序原样保留（B3）。
- **不做 limit**：见 §6。

## 2. 组键类型

组键类型由 P1-A 值层 `normalizeBaseValue`（`app/src/base-values.js`）判定，**跨类型不相等、不 coercion**。

| 组键类型 | 行为 | 依据 |
| --- | --- | --- |
| `string` | 独立组；同一字符串一组 | 契约 §9 |
| `number` | 独立组；`0` 与 `-0` 同组（数值相等） | 契约 §9 |
| `boolean` | `false` / `true` 两组 | 契约 §9 |
| `date` / `datetime` | **同一 date 家族**：按瞬时（epoch ms）归组——`"2024-01-02"`、`"2024-01-02T00:00:00Z"` 与等值 `Date` 实例是**同一组** | 契约 §9 + B6#3（非法日期按 missing）|
| `link` | 按 `path` 归组（`displayName` **不**参与身份）；复用 P1-A 冻结的 link 序，非本刀新语义 | B7（类型化排序） |
| **null 组** | `missing`（属性不存在/`undefined`）、`null`、`NaN`、`±Infinity`、非法日期串（如 `"2024-13-01"`）**合并为一个组**，`groupValue` 恒为 `null` | B6#1（missing ≡ null）、B6#3（NaN/非法日期按 missing）、B7（空/缺失归 null 组） |
| `list` / `object` | **fail closed**：抛 `unsupported_group_key`，整次调用失败（不返回部分结果） | 契约 §9「实现前必须冻结」+ §11「任何阶段 unsupported 都整次失败」 |

**空值界定（`DESIGN`，本项目选择，官方未定义）**

- B6 的官方 `isEmpty()` 是**逐类型的空判定**，不是分组身份：`string` 空串为 `isEmpty() === true`，
  但仍是一个**存在的值**。
- 因此本模块的选择是：**只有 missing/null/NaN/非法日期进 null 组**；
  **空串 `""`、`0`、`false`、空数组、空对象各有自己的身份**（空数组/空对象因类型为 `list`/`object` 直接 fail closed）。
- *理由*：B6#1 只把「缺失 ≡ null」定为同一值；把 `isEmpty()` 也并入 null 组会让「有值但为空」的行
  丢失可区分的组键，且与 B7「空/缺失」的字面范围不符。
- *风险*：低。若官方实际把空串并入空组，改动局限在 `groupKeyIdentity` 一个分支（1 处 + 1 用例）。

## 3. 组序（D1，取代旧 B7 DESIGN）

- 方向：`ASC` 升序 / `DESC` 降序；`number`、date 家族按自然序，`string` 用**码元序**。
- 比较器**复用 P1-A 冻结总序** `compareBaseValues`（`app/src/base-values.js`），不实现第二套比较逻辑
  （契约 §7）；因此「与 sort 相同的比较器」是**同一函数**，不是复刻。
- **无键（null）组恒在最后**：`ASC` 与 `DESC` **都是最后一组**。桌面依据：组比较器只在**两侧都有键**时乘
  direction（`SEMANTICS-FROZEN` P10/P11，asar `@2496540`）。旧 B7 DESIGN（"最小侧"：ASC 首 / DESC 尾）
  **已退为历史**；只改组序，不改组员（见 `app/test/base-grouping.test.js` 的 D1 用例与刀4 C6）。
- 组序**只由组键决定**：与行的出现顺序无关（同键必同组，不同组键比较恒非 0，故组序是全序、确定）。

## 4. 组内序（B3）

- 组内顺序 = **调用方传入的行序**，本模块**不重排**（B3：「组内保持 sort 结果序」）。
- **tie-break = `file.path` 升序（B7）由调用方保证**：本模块看不到 `path`，也不做自己的 tie-break。
  调用方按 `filter → sort（末键 file.path 升序）→ group` 编排时，组内即为 path 升序。
- 若调用方传入未排序行，本模块不报错也不重排：`boundaries` 描述的是**按组序拼接后的行序**
  （见 §5 的不变式），此时它与输入数组下标不再一一对应——这是调用方违约，不是本模块的语义。

## 5. 输出模型（契约 §9：flat rows + group metadata）

```js
{ boundaries: [ { groupValue, startIndex, count, rowIndexes } ], totalGroups }
```

- **不复制整份 row payload**（§9）：返回值只有组元数据（`rowIndexes` 是**下标**，不是行对象），行仍由调用方持有为扁平数组。
- `groupValue` = 该组**首个出现**的原始组键值（原样，不归一化）；**null 组恒为 `null`**。
- `rowIndexes` = 该组成员在 `sortedRows` 里的下标（升序，即调用方排序序），刀4 接线用它物化组员（`groups[].rowPaths` / 按组 summaries）而无需重新推导成员。
- 不变式（测试逐条钉住）：`boundaries.length === totalGroups`；`Σ count === sortedRows.length`；
  `startIndex` 从 `0` 起、逐项连续（`next = prev + count`）；`count ≥ 1`；
  返回值、`boundaries` 与其元素全部 `Object.freeze`；输入数组与行对象永不被修改。
- 该形状与席位冻结的 additive MCP DTO 一致（`groups: { boundaries, totalGroups }`，`rows` 仍平铺），
  接线属 INT-D（`review-verdict-P1D-GO.md` §3.1）。

## 6. limit 语义（B4 / P6）

- **本模块不实现 per-group limit**：不截断任何组，一个组有多少行就报多少行。
- B4/P6：`limit` 是 **view 级单一标量**，作用于**全局已排序的平铺行**；不存在 per-group limit 的配置面。
- 因此 `limit` **早于分组**：调用方（`base-query.js`，见 §9）先 `slice(0, limit)` 再把**留存行**交给本模块，
  所以「组只看到留存行、被截掉的组整组消失」是编排层的结论，不是本模块的。本模块既不读 `view.limit`，也不接受 `groupBy.limit` 这类键。

## 7. 错误码与文本模板

`BaseGroupingError extends Error`，字段 `code`（与 `BaseFormulaError` / `BaseQueryError` 同风格）。

| code | 触发 | 文本模板 |
| --- | --- | --- |
| `invalid_input` | `sortedRows` 非数组；默认读值路径遇到非对象行 | `Base groupBy requires an array of rows`；`Base groupBy rows must be objects to read property "<property>"` |
| `invalid_group_by` | `groupBy` 非对象；`property` 非非空字符串；`keyOf` 非函数 | `Base groupBy must be an object with a property name`；`Base groupBy.property must be a non-empty string`；`Base groupBy keyOf resolver must be a function` |
| `invalid_direction` | `direction` 存在但不是 `ASC`/`DESC` | `Unsupported Base groupBy direction "<value>" (expected ASC or DESC)` |
| `unsupported_group_key` | 组键被判定为 `list` / `object` | `Base groupBy is not supported for <type> values (out of scope)` |

全部 fail closed：**整次调用抛错**，不返回「能算的部分」。

## 8. DESIGN 标注（本文件与实现里所有「不主张 parity」项）

| # | 选择 | 理由 | 风险 |
| --- | --- | --- | --- |
| D1 | 组内序 = 输入序，tie-break（`file.path`）完全交给调用方 | B3 的 `filter→sort→group` 显式选择；模块看不到 path，自造 tie-break 会产生第二套排序 | 低：调用方违约时结果仍是确定的（只是不是 path 升序） |
| **D1′（新，刀4）** | 无键组**恒在最后**（两方向），取代旧 B7 DESIGN | 桌面 asar P10/P11 是唯一直接证据；旧 DESIGN 无桌面支持 | 低：只影响展示顺序，不影响组员；已在 §3 与刀4 C6 钉住 |
| D2 | 「空」只指 missing/null/NaN/非法日期；空串/`0`/`false` 各成一组 | B6#1 只绑定 missing ≡ null；`isEmpty()` 是空判定而非身份 | 低：单分支可改（见 §2） |
| D3 | `boundaries` 描述「按组序拼接后的行序」而非输入下标 | 与 §9 的 flat rows + group metadata 以及 `Σcount === rows.length` 一致；排序正确时两者等价 | 低：文档 + 测试显式覆盖未排序输入 |
| D4 | `groupValue` 用首个出现的原始键值（原样），不归一化 | 不替调用方决定 DTO 里日期/链接的表示；`null` 组用 `null` 哨兵 | 低：同组键值类型化相等，故组内表示差异只在既有 overload（如 `displayName`）上 |
| D5 | `link` 按 `path` 归组 | 复用 P1-A 冻结的 link 相等/排序语义（§7 不得两套比较） | 低：未来若要停用 link 分组，是一处 fail-closed 改动 |
| D6 | `list` / `object` 组键 unsupported | 官方未定义深比较的组序；fail closed 优于猜 | 低：INT-D 明确报错，不静默平铺 |

## 9. 接线（刀4，`base-query.js`）

- W2-A 只新增了纯模型；**刀4** 把它接入 canonical pipeline，并把结果变成 additive DTO：

```js
// app/src/base-query.js —— 冻结顺序：filters -> sort -> limit -> groupBy -> summaries
const retained = sorted.slice(0, effectiveLimit);            // limit 作用于全局已排序平铺行（P6）
const keyValues = retained.map((record) => baseRow(record, [groupBy.property], { formulas })[groupBy.property]);
const model = buildBaseGroups(retained, { property, direction }, { keyOf: (_row, index) => keyValues[index] });
// groups[] = { key, keyType, count, rowPaths, summaries? }；顶层 summaries = 整批留存行（P8）
```

- 组键经**同一个属性值 seam**（`baseRow`，含 `formula.*`）求值后由 `keyOf` 注入；本模块仍不接触公式引擎。
- 公式作为**组键**仍被 `assertNoFormulaReferencesInGroupBy` 拒（E11/U1 未证实）；公式作为**summary 列**可用（与 `order` 同一值层）。
- `limit: 0` 在到达本模块前就被 `validateBaseDocument` 以 `invalid-schema` 拒（D5 有意收窄）。
- Web 路由仍声明 `capabilities.grouping: false`（UI 腿属另刀），且不发布 `groups`/`summaries`。

## 10. 复杂度与确定性

- 归组一次遍历 O(n)；组序排序 O(g log g)（g = 组数）；无递归、无时钟、无 I/O、无全局状态。
- 同输入必得同输出（含 null 组与 `DESC`）：身份串与比较器是同一等价关系
  （`app/test/base-grouping.test.js` 最后一条用例逐对钉住 `groupKeyIdentity ↔ baseValuesEqual ↔ compareBaseValues ≠ 0`）。

## 11. 不支持清单（刀4 后的现状）

| 项 | 现状 | 归属 |
| --- | --- | --- |
| pipeline 编排（`filter→sort→limit→groupBy→summaries`） | **已接线（刀4）**，见 §9 | 已完成 |
| additive DTO `groups` / `summaries` | **已接线（刀4）**；仅当 view 声明时出现 | 已完成 |
| Web 分组渲染 / `capabilities.grouping` 翻转 | 未做（服务端优先；另刀） | Web UI 腿 |
| 内置 `summaries`（per-group） | **已实现（刀4）**，见 `app/src/base-summaries.js` | 已完成 |
| 顶层自定义 summary（`values.*` 公式） | 声明可接受；**被引用时 fail closed** | 公式面（矩阵 §3） |
| per-group limit | 明确 out-of-scope | B4 |
| `groupOrder`（桌面：**行集白名单过滤器**，P14） | 仍为未知键、静默忽略，**不半实现** | kanban 前置（矩阵 §14 N5） |
| 多属性分组（`groupBy` 数组） | 未实现；官方仅单属性（B7/`Views.md:90`） | 后续 Wave |
| cursor 分页跨组 | 未实现 | INT-D（契约 §9 冻结项） |
