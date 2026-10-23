# Bases 表达式 grammar corpus（P1-A / W1-A）

> **性质**：本文件是 P1-A（expression foundation）的**语料说明与官方锚点登记**，不是承诺清单。
> 落盘顺序（席位要求 a）：**先提交语料**（`app/test/fixtures/bases-grammar/**` + 本文件），**再提交实现**
> （`app/src/base-expression.js`、`app/src/base-values.js`、两个测试文件）。语料先于实现存在，实现只负责让语料变绿。
>
> 本刀**零接线**：`base-expression.js` / `base-values.js` 都是纯新模块，不改 `base-query.js` /
> `base-formulas.js` / `workflows.js` / `tools/workflows.js` / Web frontend / bundle。语法树求值（AST 遍历）
> 属 INT-A，公式依赖图属 P1-B。

## 0. 语料驱动方式

| 语料 | target | 驱动测试 |
| --- | --- | --- |
| `01-literals` … `07-unsupported-official` | `base-expression` | `app/test/base-expression.test.js` |
| `08-values-cross-type` | `base-values` | `app/test/base-values.test.js` |

每个 `*.corpus.json` 的形状：

```jsonc
{
  "target": "base-expression",          // 由哪个测试消费（驱动测试会断言 target 匹配）
  "group": "literals",                  // 组名（case id 全局唯一，跨组不许重名）
  "title": "…",                         // 人类可读标题
  "anchors": [                          // 官方锚点：来源文件 + 段落 + 逐字引文 + 站点 URL
    { "kind": "official-doc", "source": "REFERENCE/official-docs/Bases syntax.md",
      "locator": "## Types → ### Strings, numbers, and booleans",
      "quote": "Strings are enclosed in single or double quotes, for example `\"message\"`.",
      "url": "https://obsidian.md/help/bases/syntax" }
  ],
  "cases": [
    { "id": "…", "input": "1 + 2 * 3", "outcome": "accept",
      "ast": { "type": "binary", "operator": "+", "left": {}, "right": {} },
      "note": "官方原文出处或判定理由" },
    { "id": "…", "input": "1 +", "outcome": "reject",
      "code": "syntax", "position": 3,
      "messageTemplate": "Expected an expression but found {token} at position {position}",
      "note": "…" }
  ]
}
```

- `anchors[].kind`：`official-doc`（`REFERENCE/official-docs/` 的逐字原文）| `changelog`（官方发布说明）|
  `project-contract`（vault TODO 的契约条款）| `design`（官方未写、本项目显式选择，必须带理由；见 §9）。
- 官方原文快照：`scratch/bases-p1/REFERENCE/official-docs/{Bases syntax,Formulas,Functions,Views,Table view}.md`
  （源 `github.com/obsidianmd/obsidian-help`，2026-10-06 抓取；站点页分别为
  <https://obsidian.md/help/bases/syntax>、<https://obsidian.md/help/formulas>、<https://obsidian.md/help/bases/functions>）。
- `accept` case 必须给 `ast`（整树深比较）或 `astType`（只比较根节点类型）；两者都没有视为语料错误。
- `reject` case 必须有 `code`（精确等值断言）+ `messageTemplate`；`position` 若存在则精确断言（不存在＝该 case 不断言位置）。
  `messageTemplate` 里的 `{position}` 只匹配数字、`{token}` 只匹配任意记号文本——模板固定，
  **只有位置/记号变化**（席位要求 6）。
- 只有 `accept` + 带 `input` 的 case 会进 AST 断言；`parenDepth` / `unaryDepth` 由驱动生成输入（§5）。

## 1. 分组与锚点

| 组 | 文件 | case 数 | 官方锚点（逐字，见文件 `anchors`） |
| --- | --- | --- | --- |
| literals | `01-literals.corpus.json` | 19 | `Bases syntax.md` → Types → Strings/numbers/booleans（`"message"`、`1`/`(2.5)`、`true`/`false`）；`Functions.md` → `if()` 的 `falseResult?` 默认 `null`；`Formulas.md` → Data types（`"hello"` / `'world'`） |
| grouping-precedence | `02-grouping-precedence.corpus.json` | 22 | `Bases syntax.md` → Arithmetic operators（`radius * (2 * 3.14)`、`( )` 行）、Comparison operators 表、Boolean operators 表；`Formulas.md` → `(part / whole) * 100`；契约 §14.2 |
| references | `03-references.corpus.json` | 15 | `Bases syntax.md` → Note properties（`note.author` / 裸 `author`）、File properties（`file.ext == "md"`）、`this`（`this.file.folder`）、Objects and lists（`property[0]`、`property["subprop"]`）；`Formulas.md` → `formula.formula_name`、`formula.price_per_unit * 1.1`、`price * quantity` |
| functions-arity | `04-functions-arity.corpus.json` | 22 | `Functions.md` → `if(condition, trueResult, falseResult?)` 签名与示例 `if(isModified, "Modified", "Unmodified")`、Global 函数清单（now/today/date/number/link…）、`list.map()`；`Formulas.md` → Use functions；契约 §7/§8 |
| errors | `05-errors.corpus.json` | 16 | `Bases syntax.md` → 三张运算符表（`@`、`` ` ``、`=` 不在其中）；`Functions.md` → String type；契约 §14.2（确定性 error text/code、不泄漏 stack/绝对路径） |
| depth | `06-depth.corpus.json` | 9 | 契约 §7（深度 20 不得放宽）、§14.2（20 边界 / >20 fail）；`Bases syntax.md` → `( )` 行；DESIGN（官方允许任意嵌套，20 是本项目安全收窄） |
| unsupported-official | `07-unsupported-official.corpus.json` | 14 | `Functions.md` → Regular expression type、`duration()`、Date type fields/`format()`、Object type；`Bases syntax.md` → Objects and lists（方括号）、Date arithmetic（`date + "1M"`）、`this`；契约 §4/§8 |
| values-cross-type | `08-values-cross-type.corpus.json` | 138 | `Bases syntax.md` → Arithmetic/Comparison/Date arithmetic 表；`Formulas.md` → Combine text fields；`Functions.md` → 逐类型 `isEmpty()`；changelog 1.10.0（null checkbox 与 false 同序）；`SEMANTIC-ORDER-EVIDENCE.md` B6 DESIGN；契约 §14.4 |

## 2. AST 形状（冻结）

括号**透明**（只塑形，不产生节点）；节点不带位置（位置只出现在错误对象里），整树深冻结：

```text
{ type: "literal",    valueType: "number"|"string"|"boolean"|"null", value }
{ type: "reference",  namespace: "note"|"file"|"formula", name, explicit }   // 裸 property: namespace=note, explicit=false
{ type: "unary",      operator: "-"|"!", argument }
{ type: "binary",     operator: "+"|"-"|"*"|"/"|"%", left, right }
{ type: "comparison", operator: "=="|"!="|">"|"<"|">="|"<=", left, right }
{ type: "logical",    operator: "&&"|"||", left, right }
{ type: "call",       name: "if", args: [ … ] }
```

`AST_NODE_TYPES` 是导出常量，语料驱动会断言每个 accept case 的根类型在枚举内。

## 3. 字面量（冻结）

| 记号 | 规则 | 依据 |
| --- | --- | --- |
| 字符串 | 单引号或双引号；转义集合**冻结**为 `\\` `\"` `\'` `\n` `\r` `\t`；未知转义 fail closed；字面换行/未闭合 = `syntax` | 官方「Strings are enclosed in single or double quotes」+ Formulas.md Data types |
| 数字 | `\d+(\.\d+)?([eE][+-]?\d+)?`；非有限（`1e999`）= `syntax`；`-5` 是**一元负号 + 字面量**，不是带符号字面量 | 官方「Numbers are written as digits」+ Arithmetic 表把 `-` 记为运算符；指数写法按「Bases functions follow JavaScript behavior」 |
| boolean / null | `true` / `false` / `null` 为保留字面量 | 官方 Types；`Functions.md` `if()` 的 `null` 默认值 |
| 其他 | 反引号模板串、`=` 赋值**不是** Bases 语法（`syntax`）；`+5`（一元正号）未定义 → `unsupported` | 官方运算符表 |

## 4. 运算符与优先级（自低到高）

```text
||  <  &&  <  == !=  <  > < >= <=  <  + -  <  * / %  <  一元 - !  <  成员/调用 >  字面量/引用/括号
```

- 全部二元运算**左结合**（JS parity，官方示例 `radius * (2 * 3.14)` 与「Bases functions follow JavaScript behavior」）。
- `2-grouping-precedence` 组用「同记号、不同括号 → 不同树」证明括号生效（`1 + 2 * 3` vs `(1 + 2) * 3`）。
- 一元运算绑定紧于乘法（`-2 * 3` = `(-2) * 3`）。
- 未定义的一元 `+`：`unsupported`。

## 5. 嵌套深度规则（冻结；席位要求 7）

- 常量 `MAX_EXPRESSION_DEPTH = 20`（导出）。
- **计数点**（每进入一层 +1）：括号分组 `( … )`、函数调用实参、一元操作数。顶层表达式深度为 0。
- **恰好 20 通过、21 失败**：`depth-parens-20-accept` / `depth-parens-21-reject`、
  `depth-unary-20-accept` / `depth-unary-21-reject`、`depth-combined-20/21`（10 括号 + 10/11 一元）。
- 超限的 `code` 是 `limit`：语法合法但超过本项目安全上限（DESIGN，官方允许任意嵌套）。
  适配层（INT-A）把它映射到项目既有的 `unsupported` fail-closed 语义，与现行 `base-formulas.js` 深度 20 行为一致。
- `06-depth` 用 `parenDepth` / `unaryDepth` 描述输入，驱动生成
  `"(".repeat(parenDepth) + "!".repeat(unaryDepth) + "1" + ")".repeat(parenDepth)`，避免手写长串数错层数。
- 驱动测试另外生成 0..30 全边界、21 层以上一元串、以及 5000 层深输入，证明**不递归爆栈**
  （一元若不计层，`"!".repeat(n)` 会把 JS 调用栈打穿并泄漏 `RangeError`）。

## 6. 错误 code 与文本模板（冻结；席位要求 5/6）

导出常量：`ERROR_CODE_SYNTAX` / `ERROR_CODE_UNSUPPORTED` / `ERROR_CODE_TYPE_MISMATCH` / `ERROR_CODE_LIMIT`
（`BASE_EXPRESSION_ERROR_CODES` 是冻结数组）。测试一律 **assert 精确 code**，不用 `includes("syntax")` 这类模糊断言。

| code | 含义 | 模板（`{position}` 只变数字，`{token}` 只变记号） |
| --- | --- | --- |
| `syntax` | 词法/结构非法（含调用实参个数违反官方签名） | `Expression is empty`（无位置）· `Expression must be a string`（无位置）· `Unexpected character "{token}" at position {position}` · `Unterminated string literal at position {position}` · `Unterminated regular expression literal at position {position}` · `Unsupported escape sequence "{token}" at position {position}` · `Invalid number literal "{token}" at position {position}` · `Expected an expression but found {token} at position {position}` · `Expected ")" but found {token} at position {position}` · `Expected a property name after "." at position {position}` · `Function "if" expects 2 to 3 arguments but found {token} at position {position}` · `Unexpected token {token} at position {position}; expected end of expression` |
| `unsupported` | 官方有、本刀（或永久）不做 | `Unsupported expression namespace "{token}" at position {position}` · `Unsupported nested member access "{token}" at position {position}` · `Unsupported function "{token}" at position {position}` · `Unsupported unary operator "+" at position {position}` · `Unsupported regular expression literal at position {position}` · `Unsupported expression syntax "{token}" at position {position}` · `Unsupported index access at position {position}` · `Unsupported member access "{token}" at position {position}` |
| `type-mismatch` | 值层类型违规（由 `base-values.js` 抛出，共用同一 code 词表） | `Operator "{token}" requires two numbers[ or two strings] but found {token} and {token}` · `Unary "-" requires a number but found {token}` · `Operator "{token}" cannot compare {token} and {token}` · `Unsupported date arithmetic ("{token}" with a date value): durations need the injected clock contract (P1-C)`（这条是 `unsupported`，不是 type-mismatch） |
| `limit` | 超过冻结安全上限 | `Expression nesting exceeds the maximum depth of 20 at position {position}` |

**不泄漏**（席位要求 7 后半）：`base-expression.js` 的错误对象把 `stack` 重写成单行 `Name: message`，
所以任何错误路径都不会带 `node:internal` 帧、绝对路径或主机细节；测试有专门反例（深层/恶意输入触发错误，
断言 `stack` 单行且不含盘符/`file://`/绝对路径，并且 `JSON.stringify(error)` 不含 `stack`）。

## 7. 类型枚举与跨类型运算矩阵（席位要求 3/4）

`SUPPORTED_VALUE_TYPES`（冻结）：`missing` `null` `boolean` `number` `string` `date` `datetime` `list` `object` `link`。
`PLANNED_VALUE_TYPES`（同样冻结，实现留 unsupported）：`duration` `regex` `image` `file` `html` `icon`。
`VALUE_TYPES` = 两者并集。官方其它值（duration / regex / image / html / icon / file 对象）在实现前只能落成
`string` / `object` / `missing`，不会冒充已支持类型。

矩阵口径（**coerce 一格都没有**：`"5" + 3` 报错，不产出 `"53"`；§14.4 禁止 JS 隐式乱转）：

| 运算符 | number | string | date/datetime | list | object | link | boolean | missing/null |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `+` | number | string（字符串拼接，官方 Combine text fields） | unsupported（日期算术留 P1-C） | type-mismatch | type-mismatch | type-mismatch | type-mismatch | type-mismatch |
| `-` `*` `/` `%` | number | type-mismatch | `-`+date → unsupported；其它 → type-mismatch | type-mismatch | type-mismatch | type-mismatch | type-mismatch | type-mismatch |
| `==` `!=` | 全类型对全部**支持**，typed 深度相等（missing ≡ null；`1 != "1"`） | | | | | | | |
| `>` `<` `>=` `<=` | number×number / string×string / date×datetime 支持；含 missing/null 一侧**稳定 false**；其余 type-mismatch | | | | | | | |
| `&&` `||` | 全类型支持，返回显式 boolean（truthiness 复用 P0 `base-formulas.isFormulaTruthy`） | | | | | | | |
| 一元 `!` | 全类型支持 | | | | | | | |
| 一元 `-` | number 支持；其余 type-mismatch | | | | | | | |

矩阵测试是**全格驱动**：每种类型取一个样本，`08` 组给带官方锚点的样板格，`app/test/base-values.test.js`
再对全部样本两两组合 × 各运算符逐个断言（见测试文件 `CROSS_TYPE_MATRIX` 规则表），因此不存在「到时候看代码」的格子。

## 8. 「官方有但 P1-A 故意不支持」清单（席位要求 8）

| 官方语法 | 锚点 | 本刀结果 | 归属（corpus `disposition`） |
| --- | --- | --- | --- |
| 正则字面量与正则函数 | `Functions.md` Regular expression type | `unsupported` | **永久**（契约 §4：不引入正则/可注入执行） |
| list / object 字面量、方括号索引、`property.subprop` | `Bases syntax.md` Objects and lists | `unsupported` | P1-C（list/object 值语义） |
| 值成员访问（`date.year`、`"x".lower()`、`(3.14).toFixed(2)`、`object.keys()`） | `Functions.md` Date/String/Number/Object | `unsupported` | P1-C（内置函数 allowlist） |
| 内置函数（`now()` `today()` `date()` `number()` `link()` `duration()` `if` 之外的函数） | `Functions.md` Global | `unsupported`（`if` 仅解析，2..3 参数） | P1-C |
| list 高阶函数（`map` `filter` `reduce` `sort` `unique` `join`） | `Functions.md` List type | `unsupported` | P1-C / 最后做（§8 优先级 4） |
| plugin 函数（`plugin.*`） | 契约 §4/§8 | `unsupported` | **永久**（永不自动执行） |
| `this`（`this.file.folder`） | `Bases syntax.md` Access properties with `this` | `unsupported` | **永久**（取值依赖 base 展示位置，注入式记录模型无法确定） |
| 日期单位算术（`date + "1d"`、`now() - file.ctime`） | `Bases syntax.md` Date arithmetic | 解析层 accept；**求值层** `unsupported` | P1-C（需注入 clock/timezone 契约，§8 优先级 3） |
| 未实现的 `file.*` 字段（`backlinks` `embeds` `properties` `file`） | `Bases syntax.md` File properties 表 | 解析层 accept；**取值层** `unsupported` | P1-C |
| 赋值（`a = 1`）、模板串（`` `x` ``） | 不在官方运算符/类型表内 | `syntax` | **永久**（不是 Bases 表达式语法；报 syntax 而非 unsupported，因为连记号都不存在） |
| `formula.<name>` 依赖 | `Formulas.md` Reference other formulas | 解析层 accept；**取值层**无 resolver → `unsupported` | P1-B / INT-B（依赖 DAG） |

「解析层 accept、求值层 unsupported」的项（日期算术、file 未实现字段、`formula.*`）在语料里如实写成
`accept` + note，不假装解析层拒绝：这是为了 INT-A 接线时不会误以为解析器已经挡住了它们。

## 9. 已知分歧与 DEFERRED（不主张 parity）

| 项 | 本刀冻结 | 与官方/现行实现的差异 | 归属 |
| --- | --- | --- | --- |
| `file.name` | `= record.basename`（与 `workflows.propertyValue` 一致） | 官方 `file.name` 含扩展名、`file.basename` 才是去扩展名 | DEFERRED（INT-A 一次性改并单独评审） |
| `file.ext` | 恒 `"md"`（同 P0） | 官方对附件也给真实扩展名 | DEFERRED（Base 目前只取 Markdown 记录） |
| typed 相等 | `1 == "1"` 为 **false** | P0 filter 走 `String(left) === String(right)`（历史 coercion，未改） | DESIGN；§7 要求改旧行为必须单独评审，本刀不接线 |
| 字符串排序/比较 | 码元序 | P0 sort 用 `localeCompare(..., { numeric: true })` | DESIGN；INT-A 接线时决定统一口径 |
| date/datetime 归一 | Date 实例 UTC 午夜 → `date`，否则 `datetime`；非法日期 → `missing` | 官方未定义 JS 层映射 | DESIGN（B6#3） |
| 深度上限 | 20 + `limit` | 官方允许任意嵌套 | DESIGN；适配层映射到既有 `unsupported` |
| 指数数字（`1e3`） | 支持 | 官方只写 digits | DESIGN（JS 字面量 parity，取值确定） |
| 对象 truthiness | `{}` 为 truthy | 官方未写 | 沿用 P0 `isFormulaTruthy`（§7：truthiness 只有一份实现） |

## 10. 如何核验（协调方）

```sh
cd app
node --test test/base-expression.test.js test/base-values.test.js   # focused，计数见 HANDOFF
npm run check                                                       # 0 违规 + 新文件 ≤500 行
npm test                                                            # 全量（与 BASE 对照判 flake）
```

逐条抽查建议：

1. 官方锚点：随机取 ≥5 组，用 `REFERENCE/official-docs/` 里对应文件的段落/示例逐字比对（本文件 §1 表给出行号级定位）。
2. 顺序证据：`git log --oneline` 显示 corpus 提交早于实现提交（或 `git show --stat` 分别列出两组路径）。
3. 错误 code：`grep -n 'includes("syntax")' app/test/base-*.test.js` 应为空；模板断言见 §6。
4. 深度：`depth-parens-20-accept` 通过 / `depth-parens-21-reject` 失败（`limit`）；不泄漏反例在测试文件。
5. 矩阵：`app/test/base-values.test.js` 的全格驱动 + `08` 组样例。

## 11. 未证实项

- 官方对**表达式求值**的许多细节（跨类型比较、字符串序、`+` 的数字/字符串优先级）官方文档未逐条规定；
  本刀只冻结「解析 + 类型/运算符原语」，不主张与 Obsidian 运行时逐位 parity（DESIGN 项见 §9）。
- `this` / plugin / 正则的**永久** unsupported 属本项目安全收窄，不是官方语义结论。
- 桌面 Obsidian 实测仍未做（用户 2026-10-05 明确要求跳过；语义顺序改走网上取证，见 `SEMANTIC-ORDER-EVIDENCE.md`）。
