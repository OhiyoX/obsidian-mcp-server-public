# BASES-FORMULA-GRAPH — P1-B 公式依赖图与按行求值编排（接口冻结）

状态：**依赖图已接线（INT-B）**：`base-formulas.js` 通过 `app/src/base-formula-dependencies.js` 调用本模块；
`formula.<name>` 引用参与公式定义已上线，参与 `filters` / `sort` / `groupBy` 仍 unsupported（见 §9）。
实现：`app/src/base-formula-graph.js`（371 行）· 测试：`app/test/base-formula-graph.test.js`（31 条）。
契约来源：vault `MCP/TODO - 增强 Bases 支持.md` §7（显式 DAG、compile 期 cycle 检测、per-row memoization）、§14.3、审查席位 4 项补充要求（`scratch/bases-p1/review-verdict-NEXT.md` §3.2）。

> INT-A 状态：P1-A 的**表达式层**（`base-expression.js` + `base-values.js`）已由 INT-A 接进 `base-formulas.js`（§8）。
> INT-B 状态：本模块的 DAG 编排已由 INT-B 接进 `base-formulas.js`（§9），seam 实现见 `app/src/base-formula-dependencies.js`。

## 1. 职责与边界

本模块只负责 **依赖图编排**：

- 依赖 DAG 构建（名字 → 直接依赖 / 反向依赖）
- 确定性 topological sort（依赖先于使用者）
- compile 期环检测（self / 2-node / 多节点 / 未被引用的 dead branch）
- 按行（per-row）记忆化求值编排 + 依赖失败传播

**不是**本模块的职责（由 P1-A / INT-B 负责）：

- 表达式 tokenize / parse / typing / 求值 → P1-A（`base-expression.js`、`base-values.js`）
- 引用提取（识别 `formula.<name>` 并去掉前缀）→ 注入的 `extractReferences`
- 把图接进 Base 查询管线（filter / sort / order 里的 `formula.*`）→ INT-B
- 禁止出现第二套表达式解析（契约 §17）：本模块不 import 任何 parser，也不读表达式内容。

## 2. 冻结的输入契约

```js
formulas:
  | Record<string, unknown>                       // 名字 -> 表达式（对象字面量，重复声明不可能出现）
  | Array<[string, unknown] | { name, expression }> // entries 形式，可检出重复声明
```

- 表达式值对本模块是**不透明值**（opaque）：字符串源码或 P1-A 已编译对象都可，原样传给 seam。
- `Record` 形式只接受 **own data property**；accessor（getter）会被拒绝（`invalid_input`）且**绝不触发**。
- 名字必须是**非空字符串**；`__proto__` / `constructor` / `toString` 等 hostile 名字按普通 own key 处理（内部用 `Map` + null-prototype record）。

## 3. 接口签名表（暴露给 INT-B；参数/返回类型明确）

| 导出 | 签名 | 返回 |
| --- | --- | --- |
| `FORMULA_GRAPH_ERROR_CODES` | `Readonly<Record<string, string>>` | 冻结的 compile/API 错误码枚举 |
| `FORMULA_EVALUATION_ERROR_CODES` | `Readonly<Record<string, string>>` | 冻结的求值错误码枚举 |
| `FORMULA_GRAPH_DIAGNOSTIC_CODES` | `Readonly<Record<string, string>>` | 冻结的诊断码枚举（非致命） |
| `BaseFormulaGraphError` | `class extends Error`，字段 `code: string`、`message: string` | 抛出型错误（无 stack 泄漏场景见 §6） |
| `buildFormulaDependencyGraph` | `({ formulas?: FormulasInput, extractReferences: (expression: unknown) => string[] }) => FormulaDependencyGraph` | 冻结的图 |
| `createFormulaRowEvaluator` | `(graph: FormulaDependencyGraph, row: object, evaluate: FormulaEvaluator) => FormulaRowEvaluator` | 绑定**一行**的求值器（持有该行 memo） |
| `evaluateFormulaRow` | `(graph, row, evaluate) => FormulaRowResult` | 一次性求值全部公式的便捷入口 |

```ts
type FormulasInput = Record<string, unknown> | Array<[string, unknown] | { name: string; expression: unknown }>;

type FormulaDependencyGraph = Readonly<{
  names: readonly string[];                         // 声明顺序
  order: readonly string[];                         // topological：依赖先于使用者（确定性）
  expressions: Readonly<Record<string, unknown>>;   // null-prototype；名字 -> 不透明表达式
  dependencies: Readonly<Record<string, readonly string[]>>;  // 直接依赖，去重后按首次出现顺序
  dependents: Readonly<Record<string, readonly string[]>>;    // 直接反向依赖，声明顺序
  diagnostics: readonly FormulaGraphDiagnostic[];   // 非致命告警（声明顺序）
  has(name: string): boolean;
}>;

type FormulaGraphDiagnostic = Readonly<{
  code: string;            // FORMULA_GRAPH_DIAGNOSTIC_CODES.UNREFERENCED_FORMULA
  severity: "warning";
  formula: string;
  message: string;
}>;

type FormulaEvaluator = (context: {
  name: string;
  expression: unknown;                  // 与输入完全相同的不透明值
  row: object;                          // 与 createFormulaRowEvaluator 收到的同一引用
  dependencies: Readonly<Record<string, unknown>>;  // null-prototype + frozen；仅**成功**的依赖值
}) => unknown;                          // 失败通过 throw 表达

type FormulaEvaluationError = Readonly<{
  code: string;                         // FORMULA_EVALUATION_ERROR_CODES.*
  formula: string;
  message: string;
  causes: readonly FormulaEvaluationError[];   // 依赖失败传播链（仅原因为该公式的失败）
}>;

type FormulaRowResult = Readonly<{
  ok: boolean;                          // errors.length === 0
  values: Readonly<Record<string, unknown>>;   // null-prototype；只含成功项，topological 顺序
  errors: readonly FormulaEvaluationError[];   // topological 顺序（根因先出现）
  evaluated: readonly string[];         // 本次闭包内已求值的公式名（topological 顺序）
}>;

type FormulaRowEvaluator = Readonly<{
  evaluate(name: string): FormulaRowResult;   // name 及其传递依赖的闭包结果
  evaluateAll(): FormulaRowResult;            // 全部已声明公式
}>;
```

`extractReferences` **返回裸公式名**（`formula.` 前缀由 parser 去掉）；返回值必须是字符串数组，元素非空字符串，否则 `invalid_reference`。
INT-B 若拿到的是 AST 形式的引用节点，需要自己做「只保留 formula 引用、去前缀」这一步——这是**唯一**需要适配的地方，且不改变本模块语义。

## 4. compile 期错误码与文本模板

| code | 触发条件 | message 模板（仅变量变化） |
| --- | --- | --- |
| `invalid_input` | formulas 容器类型非法 / entries 非 `[name, expression]` 或对象 / accessor 属性 / `extractReferences` 不是函数 / 传入非本模块构建的图 / `evaluate` 不是函数 | `Base formulas must be a mapping of name to expression or an array of entries`、`Base formula "${name}" must be a data property, not an accessor`、`Formula graph requires an extractReferences function`、`A graph built by buildFormulaDependencyGraph is required`、`Base formula entry must be a [name, expression] pair (index ${i})`、`Base formula evaluation requires an evaluate function` |
| `invalid_formula_name` | 名字不是非空字符串 | `Base formula name must be a non-empty string (index ${i})` |
| `invalid_formula_expression` | 表达式缺失/`undefined` | `Base formula "${name}" must provide an expression`、`Base formula entry must provide an expression (index ${i})` |
| `duplicate_formula` | 同名声明两次（entries 形式） | `Base formula "${name}" is declared more than once` |
| `invalid_reference` | extractor 返回非数组 / 元素非字符串 / 空字符串 | `Reference extractor must return an array of formula names for base formula "${name}"`、`Reference extractor returned an invalid formula name at index ${i} for base formula "${name}"` |
| `expression_error` | extractor 抛错（例如 P1-A 的语法错误） | `Base formula "${name}" could not be analyzed for references: ${thrownMessage}` |
| `missing_formula` | 引用了不存在（未声明）的公式 | `Base formula "${name}" references undeclared formula "${ref}"` |
| `formula_cycle` | self / 2-node / 多节点环，**包括 dead branch 与未被引用的公式** | `Base formula dependency cycle detected: ${a} -> ${b} -> ... -> ${a}` |
| `unknown_formula` | 求值时请求未声明的名字 | `Base formula "${name}" is not declared` |
| `invalid_row` | 行不是非 null 对象 | `Base formula evaluation requires a non-null row object` |

**Cycle 完备性**：`compile` 对**每一个**已声明公式调用 extractor 并做 DFS（迭代 + 显式栈），因此「没有任何视图或其他公式引用」的公式里的环同样在 compile 阶段失败（契约 §7「未使用公式、dead branch 中的非法引用也必须 fail closed」）。环路径按声明顺序 + 引用顺序确定，可逐字断言。

## 5. 求值契约（per-row memoization + 错误传播）—— 冻结

**记忆化**：`createFormulaRowEvaluator(graph, row, evaluate)` 绑定一行并持有该行 memo。

- 同一 (公式, 行) **最多调用 `evaluate` 一次**；diamond 依赖复用 memo 值。
- 跨多次调用复用：同一个 evaluator 实例上反复 `evaluate(name)` / `evaluateAll()`，计数不增加（INT-B 的 filter → sort → 展示应复用同一实例）。
- 不同行 = 不同实例 = 各自求值（`evaluateFormulaRow` 每次新建，适合一次性用途）。
- 求值顺序 = `graph.order`（topological），不是递归下钻；2000 长链也不爆栈。

**依赖失败传播（席位要求 11 的冻结行为）**：若 A 依赖 B 且 B 求值失败：

1. A **不会被调用**（`evaluate({name:"A"})` 不执行，计数为 0）；
2. A 得到一条 `formula_dependency_failed` 错误，`causes` 为 A **自身依赖声明顺序**里的失败项（可嵌套：A→B→C 时 A.causes=[B.error]，B.causes=[C.error]）；
3. `evaluate` 抛出的值**只取 `.message`**（`formula_evaluation_failed`），**不暴露 stack / 原始对象**；非 Error 抛出值退化为 `String(value)`；
4. 聚合：`evaluateAll()` 继续求值所有**独立**分支，`errors` 按 `order`（根因先）排列 → 多个错误顺序确定、可逐字断言；
5. 返回值不抛异常（失败是**值**，不是异常）；只有 `unknown_formula` / `invalid_row` / `invalid_input` 这类编程错误才 throw。

`values` 只包含成功项；失败公式不出现在 `values` 里（避免 `undefined` 被误当空值）。

**非致命诊断**：没有任何其他公式引用它的公式会得到 `unreferenced_formula` 告警（仅 `graph.diagnostics`，**不报错、不阻断**）。注意：图**不知道视图用法**，只被 `filters` / `order` 引用的公式也会出现在这里——调用方不得把它当错误（契约 §7 只要求这样的公式里的**非法引用** fail closed，本例由 §4 的 compile 错误保证）。

## 6. Hostile 输入策略

| 输入 | 策略 | 理由 |
| --- | --- | --- |
| 深链 / 超长链（测试用 2000） | 迭代 DFS + 迭代拓扑求值，**不设深度上限** | 无递归即无栈溢出；加人为上限会拒绝合法 Base |
| 超长名字 / 任意 Unicode 名字 | 只校验「非空字符串」，其余不透明 | 名字语义属 parser/调用方 |
| `__proto__` / `constructor` / `toString` | 普通 own key（`Map` + null-prototype record） | 防原型污染；测试覆盖 |
| accessor（getter）属性 | 拒绝并**不触发** | 契约 §7：不得执行 getter |
| 未知代码 | 不 eval / Function / vm / 动态 import，不读表达式内容 | 契约 §17 |

## 7. INT-B 接线要点与退出通道

- 唯一 seam：`extractReferences(expression) => string[]`（裸公式名）。**INT-B 已接 P1-A 的真实提取器**：
  `base-formula-dependencies.js` 的 `extractFormulaReferences` 走 P1-A AST（`reference` 节点 + `namespace === "formula"` + 去前缀，按首次出现顺序去重）。
- 每个 row 建一个 `createFormulaRowEvaluator`，把 `evaluate` 实现为「P1-A/AST 求值 + 本模块给的 `dependencies`」，即可得到「每公式每行最多一次」。
  INT-B 用 `WeakMap<record, {evaluator, thrown}>` 在 `base-formulas` 外侧做 row→evaluator 绑定（调用点无 seam，见 §9.2）。
- 失败呈现：INT-B 把 `FormulaRowResult.errors` 升格为查询错误（fail-closed）；公式**自身**求值失败保留 INT-A 的 P1-A 映射，依赖失败保留本模块 message + `causes` 链。
- **退出通道（席位裁定）**：若 INT-B/INT-A 集成时接口不匹配，**优先保留 P1-A 的接口**，本模块适配（见 `scratch/bases-p1/W1B/W1B.HANDOFF.md`）。

## 8. INT-A 接线状态（表达式层已落地）

**范围**：把 P1-A 的字面量 / `note.<prop>` / 裸 property / 括号 / 算术·比较·逻辑运算符接进 canonical 公式求值。
依赖图、`formula.<name>` 引用、`groupBy` / `summaries` **不在本刀**。

### 8.1 接线点（只动 `app/src/base-formulas.js`）

| 函数 | 变化 |
| --- | --- |
| `compileBaseFormulas` | 先拆 `file.asLink(...)` 外壳（外壳错误保持 P0 文案），再用 `parseBaseExpression` 解析内层表达式，最后 `assertSupportedNode` 全量校验（含 dead branch / 未使用公式） |
| `compileFormula`（新，内部） | 校验 + 把 P1-A AST **编译成闭包**（每 formula 一次）；编译对象 `{ name, source, expression, evaluate }` 冻结 |
| `assertSupportedNode`（新，内部） | 显式拒绝 `formula.<name>`、非 `file.name` 的 `file.<prop>`、2 参 `if`、未知节点类型 |
| `compileNode`（新，内部） | AST → 求值闭包：字面量 / 引用 / 一元 / 二元 / 比较 / 逻辑 / `if`（仅走选中分支） |
| `evaluateBaseFormula(ast, record)` | **入口签名不变**（`workflows.baseRow` 旧调用点零改动）；运行时不再走 AST，直接调用编译闭包 |
| `parseBaseFormula` | **保持冻结的 P0 解析器**（`app/test/workflows.test.js` 钉住其语法与错误文案），供兼容调用方使用 |
| `assertNoFormulaReferencesInSortOrFilter` / `assertFormulaPropertiesAvailable` / `isFormulaTruthy` / `formulaDisplayName` | **未改**（守卫不得弱化） |

`base-query.js`、`workflows.js`、`tools/workflows.js`、frontend / bundle **均未改动**（错误码归一化层沿用既有 `toBaseQueryError(error, "unsupported")`）。

### 8.2 属性读取与类型语义

- 读取：`base-values.js` 的 `readOwnDataProperty`（own data only，不触发 getter，不读原型链）。记录**信封**（`record.frontmatter`）与 P0 `evaluateReference` / `workflows.propertyValue` 同样直接取字段；用户可控的 frontmatter 键走安全 primitive。
- 类型/比较/真值：全部委托 P1-A（`evaluateBaseBinaryOperator` / `evaluateBaseComparisonOperator` / `evaluateBaseLogicalOperator` / `evaluateBaseUnaryOperator` / `baseValuesEqual` / `isFormulaTruthy`），不存在第二套实现。
- 值上下文保留**原始值**（不提前 `normalizeBaseValue`）：`file.asLink(...)` 的显示规则因此与 P0 逐字节一致（date 形状字符串、`Date` 对象不被重新分类为 epoch）。

### 8.3 错误码映射（冻结表）

| P1-A code | `BaseFormulaError.code`（本层） | canonical `BaseQueryError.code` |
| --- | --- | --- |
| `syntax` | `syntax` | `unsupported`（P0 归一化层不变，`base-query.test.js` 钉住） |
| `unsupported` | `unsupported` | `unsupported` |
| `type-mismatch` | `unsupported` | `unsupported` |
| `limit` | `unsupported` | `unsupported` |

原始 P1-A message 逐字保留；`BaseFormulaError.expressionCode` 保存 P1-A 原码。被折叠为 `unsupported` 的两类
（`type-mismatch` / `limit`）在 message 末尾附上类别名，便于不解析 `code` 也能识别：
`… but found string and number (type-mismatch)`、`… maximum depth of 20 at position 203 (limit)`。

### 8.4 未接线（本层显式 `unsupported`，绝不静默 `undefined`）

`formula.<name>`（INT-B）、`file.<prop>`（除 `file.name`）、成员/下标访问、list/object 字面量、正则、除 `if` 外的函数、plugin 函数、`this`、`&&`/`||` 的短路（两个操作数都会求值）、2 参 `if`（P0 要求 3 参）、公式进 `sort` / `filters`。
**逐行类型错误是惰性的**：`type-mismatch` 只在到达该行时触发（未触达的行/被 limit 截断的行不会让查询失败）；compile 期的语法与引用合法性则无条件全量校验。

### 8.5 证据

- `app/test/base-formulas.test.js`（14 用例）：P0 parity、§4a 端到端矩阵、未接线 unsupported、错误码映射、每行求值计数、MCP 级证据。
- `app/test/base-int-a-expressions.test.js`（7 用例）：`note.<prop>` / 字面量与类型探针 / 算术·比较·逻辑 / type-mismatch / depth 20-21 / MCP 级。
- 翻转（席位 `review-verdict-P0-FLIP.md` 批准，commit `2ae8983`）：`base-query.test.js` 2 条 parity 行 + `bases-link-formula.test.js` 3 处 P0 限制表征。
- 每行求值次数：`note.title` 每行恰 1 次求值（Proxy descriptor 计数），未走的分支 0 次。
- 性能：`perf/ab-sources.mjs`（同进程、交错、成对中位数）对 P0 四种公式形状的接入开销 ≤ ±20%。
- **仍待单独裁定**（席位附加约束 c，未授权改动）：`app/test/workflows.test.js` 4 条旧断言（`note.title` / `true` / `false` / `null` 必须抛错）
  与 4 组 W0-B 语料 `hostile-formula-*`（仍写 `reject`）；它们与已翻转的同类项性质相同，但不在本刀 owner 面内。详见 `scratch/bases-p1/INT-A/INT-A-FLIP.HANDOFF.md` §5。
  （历史项：INT-A 两轮翻转均已落地，上述 8 处已全部清零。）

## 9. INT-B 接线状态（依赖层已落地）

**范围**：把本模块的 DAG 编排接进 `base-formulas.js`，让**公式定义**可以引用其他公式（`formulas.a: file.asLink(formula.b * 2)`）。
`formula.*` 参与 `filters` / `sort` / `groupBy` **不在本刀**（见 §9.4）。

### 9.1 接线点

| 文件 / 函数 | 变化 |
| --- | --- |
| 新增 `app/src/base-formula-dependencies.js`（180 行） | `extractFormulaReferences`（P1-A AST → 裸公式名）、`BaseFormulaDependencyError`、`createFormulaDependencyRuntime`（DAG 构建 + row→evaluator 绑定 + 失败映射）。不解析表达式、不实现第二套求值语义 |
| `compileBaseFormulas` | 改为三阶段：① 逐公式 parse + `assertSupportedNode`（dead branch 含）；② `createFormulaDependencyRuntime` 建图（missing / cycle 在此抛出）；③ 发布冻结 entry，`evaluate(record)` 经图 memo 解析 |
| `assertSupportedNode` | 放行 `formula.<name>`（名字仍须 `BARE_PROPERTY`；未声明/成环由图的 compile 期拦截）；其余未接线项不变 |
| `compileNode` | `reference` 的 `formula` 分支读图给出的 `dependencies[name]`（原始值）；所有闭包签名补传 `dependencies`（外层八种节点逐层透传） |
| `evaluateBaseFormula(ast, record)` | **入口签名不变**；catch 块新增 `BaseFormulaDependencyError` → `BaseFormulaError(code = unsupported, message 逐字, causes)` 映射 |
| `BaseFormulaError` | 新增只读 `causes`（默认 `[]`；W1-B 的 `{code, formula, message, causes}` 链原样保留） |
| 未改动 | `base-formula-graph.js`（W1-B 冻结接口）、`base-expression.js` / `base-values.js`（P1-A）、`base-query.js`、`workflows.js`、`tools/workflows.js`、adapter / frontend / bundle、`assertNoFormulaReferencesInSortOrFilter`（逐字）、`assertFormulaPropertiesAvailable`、`parseBaseFormula` |

### 9.2 per-row memo 的绑定（为何不改调用点）

canonical 调用链是 `workflows.baseRow` → `evaluateBaseFormula(formulas[name], record)`，**没有** evaluator seam，且同一行会被多个阶段重复投影（filter / sort / textQuery / 展示）。
因此 runtime 用 `WeakMap<record, {evaluator, thrown}>`：

- 同一个 record 对象在整个查询（一个 compiled registry = 一个 runtime）里只建一个 `createFormulaRowEvaluator`，
  所以「每公式每行最多一次」跨阶段成立；
- record 不再被引用时其 memo 随 GC 释放（不强引用 record）；
- 两次独立查询 = 两个 registry = 两个 runtime（各自重新求值，符合预期）。

### 9.3 语义决定（与 W1-B 口径的对应）

- **依赖值 = 原始值**（`formula.a` 参与运算时是 P1-A 求值结果，不是 `{path, displayName, kind: "asLink"}` cell）；cell 只是投影外壳。
  证据：`app/test/base-formula-dependencies.test.js`「wired: a formula property can be defined from other formulas end to end」（`formula.base * 10`）。
- **依赖失败**：A 不被调用 → `formula_dependency_failed` → 映射 `unsupported`，**保留 W1-B 原始 message**
  （`Base formula "a" was not evaluated because dependency formulas failed: b`）+ `causes` 链（按声明序、嵌套、根因码/消息保留）。
- **公式自身失败**（无依赖短路）：仍走 INT-A 的 `mapExpressionError`（`type-mismatch` / `limit` 折叠为 `unsupported`、`expressionCode` 保留），
  不被图的 `Base formula "x" failed to evaluate: …` 文案覆盖——P0/INT-A 错误面零漂移。
- **cycle / missing**：compile 期 `unsupported`，message 逐字保留（`… cycle detected: a -> b -> a`、`… references undeclared formula "b"`）。

### 9.4 未接线（显式 `unsupported`）

| 能力 | 行为 | 守卫 |
| --- | --- | --- |
| `formula.*` 进 `filters` | `unsupported`：`Base formulas are not supported in filters (out of scope)` | `assertNoFormulaReferencesInSortOrFilter` **逐字未改** |
| `formula.*` 进 `sort` | `unsupported`：`… not supported in view sort (out of scope)` | 同上 |
| `formula.*` 进 `groupBy` | `unsupported`：`Unsupported Base key: views[].groupBy …` | `assertNoUnimplementedSemanticKeys`（base-query，未改） |
| 内置函数 / list·object 字面量 / 索引访问（P1-C）、summaries（P1-E） | 仍 `unsupported` | 见 §8.4 |

### 9.5 证据

- `app/test/base-formula-dependencies.test.js`（10 用例）：seam 提取 4 组 + 顺序/去重/AST 直通；公式间引用端到端；diamond 计数（5 行 → `{n:5,b0:5,c0:5,a0:5}`，且 `textQuery` 双阶段投影不增计数）；cycle 4 类（self / 2-node / 3-node / dead branch，含空记录集）；missing；错误传播 3 组（根因 / 声明序 / 5 层链）+ MCP 级 `unsupported`；未接线 3 组。
- `app/test/base-formulas.test.js`（+1 describe / 3 用例）：declared 依赖成功、unused/dead-branch 依赖校验、未声明与成环 compile 期 fail closed；原 `formula.<name>` 拒绝断言已按新能力翻转（同文件内）。
- 负控（memo 关闭 → 计数翻倍，留证不提交）与全量/BASE 对照见 `scratch/bases-p1/INT-B/INT-B.HANDOFF.md` §3。

### 9.6 待批准的限制表征翻转（不在 INT-B owner 面）

`formula.<name>` 已支持，下列钉住旧拒绝行为的断言按「单独请示、逐批批准、原子翻转」待批（清单与处置方案见
`scratch/bases-p1/INT-B/ESCALATION-FLIP-BATCH-1.md`）：

1. `app/test/workflows.test.js:73`、`74-77`（`/unsupported formula reference/`）、`105`、`106-108`（同）；
2. `app/test/bases-link-formula.test.js:356-359`（4 组 `Bad/FormulaRef*.base`）；
3. `app/test/base-query.test.js:133` + `app/test/helpers/base-fixtures.js:231`（`Bad/FormulaRef.base`）；
4. `app/test/fixtures/bases/official/official-formula-formula-ref.expected.json`（`reject` → `accept`）+ `app/test/bases-compat-corpus.test.js`（`flippedIn` 守卫与表项）。

除上述 5 个测试文件外，其余 74 组语料与所有 P0 用例逐字节未改。
