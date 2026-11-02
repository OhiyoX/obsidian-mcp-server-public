# Bases 公式：桌面 → Web 子集对账（RECON §4 刀3 验收 ③）

> **性质**：对账文档，不是 parity 声明。逐条列出桌面 1.14.4 的公式/筛选函数名在 Web 实现里的真实状态。
> 分类词表照 `BASES-COMPATIBILITY-MATRIX.md` §0（本文件只用其中三档：`supported` / `planned` / `explicitly-unsupported`）。
> 依据：`RECON.md` §1.4（asar 静态读取的函数名清单 + i18n@119770 的 `msgError*` / `funcs.*` 文档键）、
> `BASES-COMPATIBILITY-MATRIX.md` §2/§3（filters / formulas 逐行证据）、以及本刀的服务端/前端契约测试。
> **本刀未改任何 grammar / 接受面**（`app/src/base-expression.js`、`app/src/base-formulas.js` 的 fail-closed 方向未动）。

## 1. 分类口径（可复核）

| 档 | 本文件判定规则 |
| --- | --- |
| `supported` | Web 侧**今天**能真实消费，且测试/corpus 有证据；行内注明消费面（`公式` 或 `筛选`）。 |
| `planned` | 现行实现**拒绝**（fail closed），但 `BASES-COMPATIBILITY-MATRIX.md` 已给出路线归属（S3/S6 = P1-C allowlist）。未实现期间不得假装可用。 |
| `explicitly-unsupported` | 现行拒绝且**无路线归属**：Obsidian 渲染器/插件上下文，或契约明确排除（正则等）。 |

**重要限定**：公式侧的 `supported` 子集要求表达式包在 P0 冻结的 `file.asLink( … )` 外壳里（`app/src/base-formulas.js` P0 grammar）。
因此官方写法 `ppu: "(price / age).toFixed(2)"`（corpus `official-formula-arithmetic-ppu`）**仍被拒绝**——它连外壳都不满足，且 `.toFixed()` 属方法访问（未接线）。本刀没有放宽这条边界。

## 2. 逐条对账

### 2.1 `supported`（8 个）

| 函数名 | 消费面 | 证据 |
| --- | --- | --- |
| `asLink` | 公式 | `file.asLink(expr)` 外壳，返回 `{path,displayName,kind:"asLink"}`；corpus `official-formula-aslink-if-fallback`、`app/test/web-base-formula-dto.test.js` |
| `if` | 公式 | `app/src/base-formulas.js` 只接受 3 参数 `if`；`app/test/base-formulas.test.js`、corpus `official-formula-nested-if` |
| `contains` | 筛选 | `app/src/workflows.js` 的 filter 函数表（`file.inFolder`/`file.hasTag`/`file.hasLink`/`<prop>.contains`/`<prop>.startsWith`/`<prop>.endsWith`）；矩阵 §2 |
| `endsWith` | 筛选 | `app/src/workflows.js` 的 filter 函数表（`file.inFolder`/`file.hasTag`/`file.hasLink`/`<prop>.contains`/`<prop>.startsWith`/`<prop>.endsWith`）；矩阵 §2 |
| `hasLink` | 筛选 | `app/src/workflows.js` 的 filter 函数表（`file.inFolder`/`file.hasTag`/`file.hasLink`/`<prop>.contains`/`<prop>.startsWith`/`<prop>.endsWith`）；矩阵 §2 |
| `hasTag` | 筛选 | `app/src/workflows.js` 的 filter 函数表（`file.inFolder`/`file.hasTag`/`file.hasLink`/`<prop>.contains`/`<prop>.startsWith`/`<prop>.endsWith`）；矩阵 §2 |
| `inFolder` | 筛选 | `app/src/workflows.js` 的 filter 函数表（`file.inFolder`/`file.hasTag`/`file.hasLink`/`<prop>.contains`/`<prop>.startsWith`/`<prop>.endsWith`）；矩阵 §2 |
| `startsWith` | 筛选 | `app/src/workflows.js` 的 filter 函数表（`file.inFolder`/`file.hasTag`/`file.hasLink`/`<prop>.contains`/`<prop>.startsWith`/`<prop>.endsWith`）；矩阵 §2 |

> `contains` / `startsWith` / `endsWith` 在筛选面是**属性方法**（`title.contains("x")`），不是同名全局函数；公式面的同名调用仍被拒绝（见 2.2）。

### 2.2 `planned`（49 个，当前一律 fail closed）

- `abs`
- `asFile`
- `ceil`
- `containsAll`
- `containsAny`
- `date`
- `duration`
- `earliest`
- `file`
- `filter`
- `flat`
- `floor`
- `format`
- `isEmpty`
- `isTruthy`
- `isType`
- `join`
- `keys`
- `latest`
- `link`
- `list`
- `lower`
- `map`
- `max`
- `mean`
- `median`
- `min`
- `now`
- `number`
- `random`
- `reduce`
- `relative`
- `repeat`
- `replace`
- `reverse`
- `round`
- `slice`
- `sort`
- `split`
- `stddev`
- `sum`
- `time`
- `title`
- `toFixed`
- `toString`
- `today`
- `trim`
- `unique`
- `values`

路线归属：矩阵 §3「内置全局函数（`if` 除外）」与「字符串/数字/list/object/date/regexp 方法」两行 ⇒ S3/S6（P1-C allowlist）。
今天调用它们的公式在 **compile 阶段**被拒（`formula-unsupported` / `formula-invalid-function`），不返回半个结果集。

### 2.3 `explicitly-unsupported`（7 个）

| 函数名 | 为什么不做 |
| --- | --- |
| `html` / `escapeHTML` / `icon` / `image` | Obsidian 渲染器/插件上下文（矩阵 §3 尾行：plugin 提供的函数不自动执行，契约 §4 非目标）。 |
| `matches` | 正则族：`app/src/base-formulas.js` 头注释明确「regular expressions」deliberately NOT wired，无路线归属。 |
| `hasProperty` / `linksTo` | 官方筛选辅助函数，本仓 filter 函数表未实现且矩阵未给归属（`app/src/workflows.js` 逐行核对）。 |

### 2.4 疑为 webpack 误命中（不计入三分类）

| 名 | 判定 |
| --- | --- |
| `description` | `RECON.md` §5 已在「`unverified`」登记：疑为 webpack 元数据命中，不是公式函数。本刀**未**在桌面 asar 里复核（无法执行桌面端），故不作 parity 断言。 |
| `robots` | `RECON.md` §5 已在「`unverified`」登记：疑为 webpack 元数据命中，不是公式函数。本刀**未**在桌面 asar 里复核（无法执行桌面端），故不作 parity 断言。 |

## 3. 计数与一处**对不上**（诚实登记）

| 量 | 值 |
| --- | --- |
| 三分类合计（本文件逐条列出） | 64 |
| 节名里写的 64 + 2 误命中 | 66 |
| `RECON.md` §1.4 声明的「69 个函数名」 | 69 |

逐条差异：RECON §1.4 的**行内清单**用 `name="…"` 去重得到 **64** 个名字，加上单独标注的 `description` / `robots` 共 **66**；
与同一个 §1.4 表头写的 **69** 相差 3。本刀无法在桌面 asar 上复核（未执行桌面端，且本刀禁改 RECON 的既有结论），
因此**以行内清单 64 + 2 为准**，并把「69 与行内清单不可复现」登记为 `unverified`（见 §5）。
→ 结论：**不得**在任何地方引用「Web 支持 N/69」这类比值；只能引用本文件逐条列表。

## 4. 本刀交付的 DTO / UI 契约（与对账表的关系）

服务端（`app/src/app/base-snapshot-adapter.js` + `base-route.js`）：

- 成功快照：`columns[]` 中 `kind: "formula"` 的列额外带 `formula: { name, expression, displayName }`（`expression` 为 `.base` 里声明的源码；未声明则 `null`）。其余列 `formula` 不出现（MCP DTO 逐字未变，见 `app/test/web-base-formula-dto.test.js`）。
- 失败（**fail closed**，不返回行）：HTTP 422 + `{ error: "unsupported", formula: { code, name } }`，`code` 取自 `FORMULA_FAILURE_CLASSES`：
  `formula-invalid-function`（桌面 `msgErrorInvalidFunction`）、`formula-type-error`（`msgErrorTypeError`）、`formula-infinite-loop`（`msgErrorInfiniteLoop`）、`formula-not-enough-arguments` / `formula-too-many-arguments`（`msgErrorNotEnoughArguments` / `msgErrorTooManyArguments`）、`formula-parse`（`msgErrorParseFormula`）、`formula-unsupported`（兜底）。
  错误体**不含**公式源码、路径、Vault 名或堆栈；`name` 是该 `.base` 自己的键（与成功 DTO 的 `column.key` 同源）。
- 前端：`ƒ` 文本标记（表格表头 / cards 标签）+ `data-column-kind="formula"`（三种布局都写）；Properties 弹层显示只读公式定义（`data-formula-source`）；422 + `formula.code` 显示桌面语义的可读消息。

## 5. `unverified`

- 桌面 69 vs 行内 64（§3）：未在桌面 asar 复核，也未执行桌面端。
- `description` / `robots` 的 webpack 误命中判定沿用 `RECON.md` §5，本刀未复核。
- `properties.<key>.formula: "…"` 这种「属性级公式声明」（刀 brief 括号里的写法）在本仓**没有任何实现或语料**：本仓只支持顶层 `formulas:` 映射 + `properties.formula.<name>.displayName`。本刀未新增该语法（新 grammar 必须语料先于实现），也未写语料 ⇒ 归 `unverified`，不得当作已支持。
- 桌面对公式错误的**逐行**呈现（一个单元格出错只影响该格）与本仓的整查询 fail closed 不同：本仓方向是契约冻结的（禁改），UI 只呈现整体错误消息。
- 未跑真 Chromium 探针（本刀只跑组件级 DOM harness + HTTP 契约测试）。
