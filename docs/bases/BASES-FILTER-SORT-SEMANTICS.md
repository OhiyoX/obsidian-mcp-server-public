# Bases filter / sort 语义（`formula.*` 参与 Base 自身 filter / sort）

> 归属：Bases P1 / INT-C。owner：`app/src/base-formulas.js`（公式侧 helper + 守卫）、
> `app/src/base-query.js`（filters / sort 编排）。
> 权威来源：契约 §7/§8（typed 类型策略）、`SEMANTIC-ORDER-EVIDENCE.md` B1/B2/B3/B6、
> 席位 `review-verdict-INT-C-GO.md` §3/§4。
> 本文件只描述**已接线**的行为；未接线项见文末「不支持清单」。

## 0. 一句话语义

Base 自身 `filters` / `sort` 里的 `formula.<name>` 用 **P1-A typed 值层**
（`app/src/base-values.js`：`evaluateBaseComparisonOperator` / `compareBaseValues`）
求值；**非公式**条件与排序键完全沿用冻结的 P0 路径
（`app/src/workflows.js`：`evaluateBaseFilter` / `sortBaseRecords`），
不引入第二套 evaluator，也不把公式语义回退成 `String()` coercion。

判定「是否走 typed」只看**前导 property token**（filter 字符串的开头标识符，或 sort 的
`property`）：`formula.x > 10` 走 typed，而 `type == "formula.note"` 里的
`"formula.note"` 是**字面量**，仍走 P0。

## 1. 公式在 filter 中的语义

条件形状（唯一支持的公式 filter 形状）：

```text
formula.<name> <op> <literal>      # op ∈ == != > < >= <=
```

- **`<literal>` 语法** = P0 的 literal 语法（`workflows.js literal()`）去掉 coercion：
  引号 → string；`true`/`false` → boolean；`null` → null；数字 token → number；
  其余 → 原始字符串。因此 `formula.x == 2` 与 `formula.x == "2"` 是**两个不同**条件。
- **`==` / `!=`**：typed 深度相等（`baseValuesEqual`）。`1 != "1"`；`missing` 与 `null`
  视为同一值；`date` / `datetime` 按瞬时比较；`list` / `object` 递归深度相等；
  `link` 按 path 相等。跨类型恒 `false`（不抛错）。
- **`>` `<` `>=` `<=`**：仅 `number×number`、`string×string`、`date/datetime` 家族支持，
  字符串按**码元序**。任何一侧为 `missing`/`null` → **稳定 `false`**（`formula.x > 5`
  在空值行上为 false，不会因 coercion 意外命中）。
- 其余组合（含 `list`/`object` 参与排序比较、`number` vs `string`）→ P1-A
  `type-mismatch`，在 `base-query` 边界折叠为 canonical `unsupported`，**不**回退 coercion。
- **公式 × P0 属性混合比较**（`filters: 'formula.computed > priority'` 且 `priority` 为
  string）→ 同上 `type-mismatch` → `unsupported`（席位 §4 选项 A）；需要跨类型比较时由
  调用方显式保证类型一致（转换函数属 P1-C）。
- **非 filter 形状**的公式条件（如 `formula.x.contains("a")`、`formula.x.startsWith(...)`）
  → fail closed。实现上它不进 typed 分支，直接落到 P0 evaluator，由 P0 的
  `Unsupported Base filter expression: …` 负责报错（消息复用，无第二套文案）。
- **未声明**公式（`formula.nope == 1` 而 `formulas` 无 `nope`）→ **compile 期**
  `unsupported`（`Base view references missing formula "nope"`），即使候选记录集为空也会
  拒绝，不会返回 `supportedSubset: true` + 0 行。
- filter 树结构（字符串 / 数组 / `and` / `or` / `not`）语义与 P0 逐字一致；只要树中
  任一条件命中公式形状，该条件走 typed，其余条件仍走 P0。

## 2. 公式在 sort 中的语义

- `order` 里的 `formula.<name>` 键用 P1-A 的**typed 总序** `compareBaseValues`：
  - `number` 数值；`string` **码元序**（非 `localeCompare`）；`boolean` `false < true`；
    `date`/`datetime` 按 epoch ms；`link` 按 path；空值（`missing` ≡ `null`）在
    **最小侧**（ASC 在前、DESC 在后，B6#2 DESIGN）；不相关类型按 `TYPE_RANK`
    的确定性次序。同一公式键等值时继续下一个 sort 键。
- **最终 tie-break** = `file.path` 升序（`localeCompare`），与 P0 一致；因此
  ASC 下 `missing`/`null` 行排在最前，组内按 path 排序。
  > 注意：这与 P0 非公式键的 **null-last** 行为不同（P0 comparator 把
  > `null` 恒排最后）。两者并存是刻意的：公式键 = P1-A 总序，非公式键 = P0 冻结行为。
  > 席位 §4 文字写「missing 排最后」，而 P1-A `base-values.js`（B6#2）实际把它放在
  > 最小侧；本实现遵从**冻结的 P1-A 模块 + B6#2 证据**，差异已在 HANDOFF 上报。
- **多个 sort 键**（含公式 / 非公式混排）按**声明优先级**逐键比较：公式键用 typed，
  非公式键用 P0 的单键语义（空值恒最后、date→number→numeric `localeCompare`），
  最后一个键等值时才用 `file.path`。混排下的 P0 单键比较经 `baseRow` 复用 P0 的
  `propertyValue` 取值，未重复实现属性解析；`app/test/base-int-c-filter-sort.test.js`
  用「公式键恒定」的用例证明混排路径与 `sortBaseRecords` 在纯 P0 键下逐字一致。
- 每个被 sort 引用的公式**每行最多求值一次**（先按行缓存，再排序）。
- `list` / `object` 值参与 sort → **`unsupported`**（官方未定义其排序语义，席位 §4
  选项 A fail-closed）。该检查在排序前对全部记录预扫，错误稳定、不依赖比较顺序。

## 3. 混合场景（公式 vs P0）

| 场景 | 行为 |
| --- | --- |
| 公式条件 + P0 条件（`and`/`or`） | 各自按自己的语义；整棵树用 P0 的 and/or/not 组合 |
| 公式键 + P0 键混排 sort | 按声明优先级；公式键 typed、P0 键 P0，末位 `file.path` |
| 公式值 vs P0 属性的**比较**（同一 `==`/`>` 两侧各一种） | typed 严格；跨类型 → `type-mismatch` → `unsupported` |
| `sortOverride`（Web query 参数）指向公式列 | 与 `view.sort` 走**同一条** typed 公式排序路径（不再用 asLink cell 的字符串比较） |
| `filterExtra`（Web query 参数的 operator API）指向公式列 | **未接线**：仍按 P0 的 `baseRow` 投影（asLink cell + `String()` 兜底）。见「不支持清单」 |

## 4. 不支持清单（仍 fail closed）

| 能力 | 状态 | 守卫 / 证据 |
| --- | --- | --- |
| `views[].groupBy` 用 `formula.<name>` | `unsupported` | `assertNoFormulaReferencesInGroupBy`（INT-C 改名，只保护 groupBy）+ W0-D 的 known-semantic-key 守卫；`base-int-c-filter-sort.test.js` |
| 任何非空 `views[].groupBy` | `unsupported` | W0-D `assertNoUnimplementedSemanticKeys`（grouping 未实现，P1-D） |
| `summaries`（top-level / `views[].summaries`） | `unsupported` | W0-D 守卫（P1-E） |
| 公式值为 `list` / `object` 时参与 sort | `unsupported` | `sortBaseRecordsWithFormulas` 预扫；`base-int-c-filter-sort.test.js` |
| 公式 filter 形状不是 `formula.<name> <op> <literal>`（`contains` 等） | `unsupported` | 落到 P0 evaluator 的 `Unsupported Base filter expression` |
| Web `filterExtra`（query 参数 operator API）指向公式列 | 未接线（P0 cell 语义） | `evaluateBaseCondition` 未改；HANDOFF §未接线 |
| 跨类型比较 / 排序（`number` vs `string` 等） | `unsupported`（`type-mismatch` 折叠） | P1-A `evaluateBaseComparisonOperator` |
| `this.*` / plugin 函数 / 日期算术 | `unsupported`（INT-C 未改） | INT-A/INT-B 既有路径 |

## 5. 证据索引

- `app/test/base-int-c-filter-sort.test.js`（14 用例）：typed 相等、`note.rank * 2` 参与比较、
  空值稳定 false、跨类型 fail-closed、list/object filter+sort、typed 总序（ASC/DESC）、
  混排优先级（两个方向）、恒等公式键与 P0 sort 的等价、未声明公式 compile 期拒绝、
  非 filter 形状拒绝、错误 direction、`groupBy` 仍禁、P0 coercion 零回归。
- 既有 P0 gate：`app/test/base-query-overrides.test.js`（`sortOverride` / `filterExtra`）、
  `app/test/workflows.test.js`、`app/test/base-query.test.js`（MCP ↔ canonical parity）。
- 语料：`hostile-formula-in-view-filter` / `-in-view-sort`（翻转申请见
  `scratch/bases-p1/INT-C/ESCALATION-FLIP-BATCH-1.md`）。
