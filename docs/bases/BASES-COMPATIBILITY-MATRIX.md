# Obsidian Bases × obsidian-mcp-server 兼容矩阵（W0-B，2026-10-05）

> **性质**：本文件是 *对账文档*，不是承诺。它把官方 Obsidian Bases 语法面逐条映射到本仓库当前实现的实际行为，
> 冻结成可执行证据（`app/test/fixtures/bases/**` + `app/test/bases-compat-corpus.test.js`）。
> 本刀**零 production 改动**：所有 `planned` / `RED` 行只描述现状与归属，不实现新能力。
>
> **语义顺序**：`groupBy` × `sort` × `limit` × `summaries` 的相对顺序已由 **`docs/bases/SEMANTICS-FROZEN.md`**（2026-10-19，桌面 asar 1.14.4 静态取证，P1–P23）冻结，并在 **刀4**（`fix/bases-cut4-grouping`）落地执行：
> `filters → sort → limit(全局平铺行) → groupBy(分区) → summaries(按组、对留存行)`。本文件 §6/§7 的状态列已按该实现翻转，§14 是刀4 的差异登记。

## 0. 状态词表（四分类）

| 状态 | 含义 |
| --- | --- |
| `supported` | 现行实现真实消费该语义，且本刀 fixture 或既有测试有证据。**不代表与 Obsidian 语义完全一致**（见分歧行）。 |
| `planned` | 契约 §5 路线（S3–S9）内、当前未实现。**未实现期间必须 fail closed**（Wave 0-D 已把会改变结果集的键翻成 `explicitly-unsupported`）。 |
| `explicitly-unsupported` | 官方有该语义、本项目**明确不实现**，现行已拒绝（或 W0-D 必须拒绝）。 |
| `not-applicable` | 本项目协议面外用不到（无 Obsidian UI/插件/时钟上下文），或契约 §4 明确列出的非目标。 |

**`W0-D flipped` 标记 = `expected.json` 中 `"flipIn": "W0-D"`**：该 fixture 已在 Wave 0-D 从"静默接受"**原子翻转为** `outcome: "reject"` / `code: "unsupported"`。语料测试的形状守卫强制 `flipIn` 非 null ⇒ 必须 `reject` + `unsupported`，因此这个字段**不再可能表示"待翻转的 RED"**。未被翻转的 fixture `flipIn` 为 `null`，并在 `note` 里写明分类（`DISPLAY-METADATA` / `DEFERRED <lane>`）。

**`INT-A flipped` 标记 = `expected.json` 中可选的 `"flippedIn": "INT-A"`（2026-10-06 冻结）**：该 fixture 已在 INT-A 由接线从 `reject` **原子翻转为** `outcome: "accept"`（`code: null`、`supportedSubset: true`、`rowPaths` 为实际行）。两个标记按方向分工，语义如下：

| 标记组合 | 含义 |
| --- | --- |
| `flipIn: "W0-D"` | 在 W0-D 翻转（`accept` → `reject`，恒为 `unsupported`） |
| `flipIn: null` + `flippedIn: "INT-A"` | 在 INT-A 翻转（`reject` → `accept`） |
| `flipIn: null` + 无 `flippedIn` | 从未翻转（仍为其原始状态） |

两个守卫都是单向的，互不放宽：`flipIn` 非 null ⇒ 必须 `reject` + `unsupported`（W0-D 原文守卫，逐字保留）；`flippedIn` 非 null ⇒ 必须 `accept`、`flipIn` 为 `null`、且与 `CORPUS_EXPECTATIONS` 一致（INT-A 新增，additive）。
>
> **W0-D 冻结边界（唯一会让结果集变化的键才 fail closed）**：`views[].groupBy`、`views[].summaries`、顶层 `summaries`、filter 里带点引用的未知 namespace。其余静默键（`type` / `cardSize` / `image` / 未知 view 键 / 未知 `properties.*` 键）一律显式分类为 `DISPLAY-METADATA`；未实现的 `file.<prop>` 读取与继承属性读取登记 `DEFERRED`。详见 §12。
>
> **刀4 更新（2026-10-19）**：前三个键已由 `fix/bases-cut4-grouping` **执行**（accept）并从 fail-closed 集合退出；filter 未知 namespace 仍 fail closed。剩余 fail-closed 面（仍会让结果集变化的键）：非法 `groupBy.direction`、`groupBy.property` 指向 `formula.*`、未知/被引用的自定义 summary 名、`limit` 的非法取值（含 `limit: 0`）。逐条见 §6/§7/§14。

## 1. 官方来源登记（本刀自核）

| ID | 来源 | 抓取方式与时间 | 用途 |
| --- | --- | --- | --- |
| S1 | `https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Bases/Bases%20syntax.md`（= 官方 help 仓库的 `Bases syntax` 页原文；对应站点页 <https://obsidian.md/help/bases/syntax>） | 2026-10-05 直接抓取 **raw markdown 原文**（站点页是客户端渲染，早前抓取只得到标题） | filters / formulas / properties / summaries / views / 运算符 / file 属性 |
| S2 | `.../en/Bases/Functions.md`（<https://obsidian.md/help/bases/functions>） | 同上 | 全局与按类型函数清单、File 字段表 |
| S3 | `.../en/Bases/Views.md`（<https://obsidian.md/help/bases/views>） | 同上 | view 布局（table/cards/list/kanban/map）、sort/group UI 语义、"grouping by only one property" |
| S4 | `.../en/Bases/Formulas.md`（<https://obsidian.md/help/bases/formulas>） | 同上 | 公式属性概念（本刀只用于交叉引用，未新增行） |
| S5 | **经验来源（非官方文档）**：对用户 vault 中 5 份 Obsidian 写出的 `.base` 做 **key 存在性扫描**（2026-10-05，仅统计 key，未复制任何内容） | 本机 `grep -oE '^[ ]*-?[ ]*[A-Za-z_][A-Za-z0-9_]*:'` + 计数 | 判定 `view.sort` / `order` / `columnSize` 等键是否真的由 Obsidian 写出 |

S5 观察到的事实（只报 key，不报内容）：view 级 `sort:`, `order:`, `filters:`, `name:`, `type:`；sort 项 `property:`, `direction:`；
`properties:` + `displayName:`；view 私钥 `columnSize:`。**未**观察到 `groupBy:` / `summaries:` / `limit:`。

**证据纪律**：本文件每一行的"证据"列都指向真实存在的 fixture 文件名或测试名；未能自核的行单独进 §9 `PENDING-VERIFY` 登记表。

## 2. filters

| 官方语法片段 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| 顶层 `filters:`（作用于所有 view） | S1 | `supported` | `official-filters-global-and-view`；`base-query.test.js: parity (ok): base.filters + view.filters` | S1 |
| view 级 `filters:`（只作用于该 view） | S1 | `supported` | `official-filters-global-and-view`；`real-project-second-view-select` | S1 |
| 全局 + view 过滤以 **AND** 合并 | S1（"concatenated with an `AND`"） | `supported` | `official-filters-global-and-view`→`[Notes/Alpha.md]`；`real-project-second-view-select`→空集（全局 `not(status==done)` 与 view `status==done` 相加为空） | S1 |
| filter 为单个字符串语句 | S1 | `supported` | `official-filter-hastag-nested`、`official-filter-comparison-coercion`、`real-project-second-view-select` | S1 |
| filter 为递归对象，键限 `and`/`or`/`not` | S1 | `supported` | `official-filters-nested-or-and-not`；`workflows.test.js: portable Base filters support nested logic and file helpers` | S1 |
| **filter 组形态 fail-closed**（同一层多个合取键 / 非数组值 / 非对象非数组） | 桌面 `app.js@2361900`（`Object.keys(t).length!==1` ⇒ `msgErrorFilterAllowedKeys`；`!Array.isArray` ⇒ `msgErrorFilterMustBeArray`） | `explicitly-unsupported`（**本刀接线**：`compileBaseView` 在求值前校验整棵树，code `invalid-schema`；零行记录集也必拒绝） | `app/test/base-filter-groups.test.js`：`an unparsable or ambiguous group fails closed instead of picking a key`、`a document with an ambiguous filter group fails closed before evaluation` | 已完成（G3） |
| `?filter=`（Web 冻结覆盖）接受**组形态** `{and\|or\|not:[…]}`，递归，叶可为条件或表达式串 | desktop 同款 + Web 冻结 API | `supported` | `app/test/base-filter-groups.test.js`、`app/test/web-bases-filter-groups-ui.test.js`、`app/src/app/base-params.js` | 已完成（G3）；旧 `filter=[{key,op,value}]` 行为不变（同文件 `the legacy AND list is byte-identical to the pre-G3 evaluation`） |
| 同一层同时给出 `and` 与 `or`（歧义） | desktop 拒绝 | `explicitly-unsupported`（400 `invalid-filter` / 域层 `invalid-schema`） | 同上 | 已完成（G3） |
| 未知合取键（如 `nand`） | S1（未定义） | `explicitly-unsupported` | `hostile-unknown-filter-object`（`unsupported`） | S1 |
| 未知 filter 函数 `file.zzz("x")` | S1/S2 | `explicitly-unsupported` | `hostile-unknown-filter-function`、`hostile-unsupported-file-property-filter`（`contains` 于未实现属性）；`base-query.test.js: parity (error): unsupported filter expression`（含 `title.matches(...)`） | S1 |
| `filters: []` | S1（未记载） | `supported`（空数组 `every()` 恒真） | `boundary-filters-empty-array` | S1 |
| 比较 `== != > < >= <=` | S1（Comparison operators 表） | `supported` | `official-filter-comparison-operators`（`!=` `>=` `<` `==`）、`official-file-property-filter`（`>=` `>`）、`official-view-complete-table`（`!=`） | S1 |
| `==`/`!=` 的跨类型兜底（`String(left)===String(right)`） | S1（"Equal and not equal can be used with any kind of value"） | `supported`（语义 PENDING-VERIFY） | `official-filter-comparison-coercion`：数值 `3` 与字符串 `"3"` 相等 → 见 §9 V1 | S1（语义冻结待 characterization） |
| `contains`（字符串/列表） | S1/S2 | `supported`（列表为元素精确匹配，字符串为子串） | `official-filter-string-operators`；`workflows.test.js: portable Base filters support nested logic and file helpers` | S1 |
| `startsWith` / `endsWith` | S1/S2 | `supported`（非字符串值恒 false） | `official-filter-string-operators` | S1 |
| `file.inFolder("…")` | S1/S2 | `supported`（前缀匹配，含子目录） | `official-filters-nested-or-and-not`；`workflows.test.js: portable Base filters support nested logic and file helpers` | S1 |
| `file.hasTag("…")` | S1/S2 | `supported` **但语义分歧**：只做精确匹配，**不展开嵌套标签**（官方 S2 明示 `#tag1/a` 也匹配 `hasTag("tag1")`） | `official-filter-hastag-nested`（`hasTag("work")` 不匹配 `#work/nested`）→ 见 §8 D1 | S1（分歧修复未排期） |
| `file.hasLink("…")` | S1/S2 | `supported` | `official-filters-nested-or-and-not`（`hasLink("Alpha")`） | S1 |
| `note.<prop>` 前缀 与 裸 property | S1 | `supported`（`note.` 被剥掉后同裸 property） | `official-filter-comparison-operators`（`note.status`）、`official-filter-comparison-coercion`（`price`） | S1 |
| 未知 namespace（`this.…`、任意未实现前缀） | S1（`this` 见 §7 N5） | `explicitly-unsupported`（**W0-D 已 fail closed**：filter 里带点引用的**前缀 ∉ {`file`, `note`}** → `unsupported`；裸属性不受影响） | `hostile-unknown-namespace-filter`（`flipIn: "W0-D"` → `reject`/`unsupported`）；`app/src/workflows.js` `assertFilterPropertyNamespace` | 已完成（W0-D） |
| filter 里的公式属性 `formula.<name>` | S1（允许） | `supported`（**INT-C 接线**：typed 比较；`==` 严格、空值稳定 false、跨类型 `unsupported`，见 `BASES-FILTER-SORT-SEMANTICS.md`；语料/parity 翻转待批） | `app/test/base-int-c-filter-sort.test.js`；`hostile-formula-in-view-filter`（翻转申请 `ESCALATION-FLIP-BATCH-1.md`） | S5 → since INT-C |

### 2.1 file 属性逐条（官方 S1 file properties 表 + S2 File 字段表）

| 官方属性 | 官方类型 | filter/sort 路径 | 公式路径 | 证据 | 状态与归属 |
| --- | --- | --- | --- | --- | --- |
| `file.name` | String | `supported` | `supported` | `official-formula-aslink-if-fallback`、`official-file-property-sort` | `supported`（S0–S2） |
| `file.path` | String | `supported` | `explicitly-unsupported` | `boundary-empty-base`（默认 `file.path` 列）、`probe/log-file-props.txt` | filter/sort `supported`；公式侧 S3 |
| `file.folder` | String | `supported` | `explicitly-unsupported` | `probe/log-file-props.txt`（`"Notes"`）、`base-query.test.js: columns fall back to the raw formula key and the dot suffix` | 同上 |
| `file.ext` | String | `supported`（恒 `"md"`） | `explicitly-unsupported` | `probe/log-file-props.txt`、`official-properties-displayname-note` | 同上 |
| `file.size` | Number | `supported` | `explicitly-unsupported`（RED→已拒绝） | `official-file-property-filter`、`official-file-property-sort`、`official-file-property-formula-unsupported` | 见 §2.2 |
| `file.ctime` | Date | `supported`（ISO 字符串比较） | `explicitly-unsupported` | `official-file-property-filter` | 同上 |
| `file.mtime` | Date | `supported` | `explicitly-unsupported` | `probe/log-file-props.txt` | 同上 |
| `file.tags` | List | `supported`（规范化小写标签数组） | `explicitly-unsupported` | `probe/log-file-props.txt`（`["work"]`） | 同上 |
| `file.links` | List | `supported`（出链 target 列表） | `explicitly-unsupported` | `probe/log-file-props.txt`（`["Beta"]`） | 同上 |
| `file.backlinks` | List（官方注明性能昂贵） | `explicitly-unsupported` **但当前静默 undefined** | `explicitly-unsupported` | `hostile-unsupported-file-property-filter`（`accept`，`flipIn: null`）、`probe/log-file-props.txt` | **DEFERRED（P1-A typing）**：W0-D 明确不修（未见 `this.…` 类未知 namespace，`file` 前缀合法）；`file.<prop>` 属性名 allowlist 归 P1-A |
| `file.embeds` | List | 同上（静默 undefined） | `explicitly-unsupported` | `probe/log-file-props.txt` | 同上 |
| `file.file` | File | `explicitly-unsupported`（静默 undefined） | `explicitly-unsupported` | `probe/log-file-props.txt` | S10 / 契约 §4 非目标 |
| `file.properties` | Object | `explicitly-unsupported`（静默 undefined） | `explicitly-unsupported` | `probe/log-file-props.txt` | S10 |
| `file.basename` | String（**只在 S2 Functions 页 File 字段表**，S1 属性表无） | `explicitly-unsupported`（静默 undefined） | `explicitly-unsupported` | `probe/log-file-props.txt`、`hostile-unknown-filter-function`（未知函数路径同族） | S1（filter 侧补齐未排期） |

> 结论：**filter/sort 侧的 `file.*` 面比公式侧宽**（公式只认 `file.name`）。两侧都不做属性名 allowlist：
> 未实现属性在 filter 里被当作 `undefined`，这是 W0-D 必须收敛的 fail-closed 缺口（`hostile-unsupported-file-property-filter` 是 RED）。

### 2.2 公式侧 file.* 的差异证据

`official-file-property-formula-unsupported`（`file.asLink(file.size)`）在 compile 阶段被拒，错误文本
`Base formula "x" uses unsupported file property "file.size"`（code `unsupported`），与 `workflows.test.js:
Base formula compiler supports note.* references and the P1-A literals, and still fails closed on unsupported
references and depth overflow` 的 `file.path` 用例一致。
即：同一属性在 filter 里可用、在公式里不可用——两张能力表必须分别记，不能写"file.size 已支持"。

### 2.3 简单筛选器运算符对账（RECON **G4**，本刀）

桌面**唯一权威表**：`app.js@3238200` `workspace.registerOperatorFuncConfigs("bases", [{funcName,display,inverseDisplay}, …])`，共 **11 个**：
`hasProperty` / `isEmpty` / `startsWith` / `endsWith` / `contains` / `containsAny` / `containsAll` / `matches` / `hasLink` / `inFolder` / `hasTag`。

本文的 `BASE_FILTER_OPERATORS` 是 **Web 冻结 API 的结构化词表**（`?filter=[{key,op,value}]`），桌面 funcName 是**函数名**;
下表是两者逐条映射。**前 11 行是本刀前的比较型词表（全部保留，Web 已在用，不得删）**，其后 7 行是本刀新增的语义型结构算子。

| # | 桌面 funcName | display / inverseDisplay | Web 结构化 op | 状态 | 语义对齐证据（本刀自读） |
| --- | --- | --- | --- | --- | --- |
| 1 | `hasProperty` | `has property` / `does not have property` | `has-property`（**本刀新增**） | 本刀支持 | 桌面实现 `app.js@2244130`：`operate=function(e,t){var n=e.getProps();return n&&n.keys().contains(t.data)}` ⇒ 就是「属性存在」。Web 用 `key` 作属性名（等价 `note.hasProperty("<key>")`），声明即存在（`null` 也算，对齐 `props.keys()`）；`file.*` 走 `baseRow` 解析。反向用 `{not:[…]}` 组表达 |
| 2 | `isEmpty` | `is empty` / `is not empty` | `is-empty` / `is-not-empty` | 已支持（本刀前） | `isEmptyBaseValue`：`null`/`undefined`/空串/空数组/空对象 |
| 3 | `startsWith` | `starts with` / `does not start with` | `starts-with` | 已支持（本刀前） | 与表达式层 `x.startsWith()` 同口径（非字符串值恒 false）——注意**结构化 `contains`/`starts-with` 走 `baseSearchableText`（数组展开、`file.asLink` 双字段）**，比表达式层宽松，此差异在本刀前已存在且被 Web URL 契约使用，**未改**（见 §9 V-register 提示） |
| 4 | `endsWith` | `ends with` / `does not end with` | `ends-with` | 已支持（本刀前） | 同上 |
| 5 | `contains` | `contains` / `does not contain` | `contains` | 已支持（本刀前） | 同上 |
| 6 | `containsAny` | `contains any of` | `contains-any`（**本刀新增**） | 本刀支持 | 桌面是 varargs（`containsAny(list, …needles)`）⇒ Web 接受标量或数组 value。**大小写**：字符串值的桌面实现 `app.js@2230842`：`var i=e.data.toLowerCase();return t.some((function(e){return i.includes(e.data.toLowerCase())}))`（本刀自读确认）⇒ **不区分大小写**；列表值走 `fK` 分支的 `containsAny`（注册 `app.js@2237327`，实体 `app.js@2237531`：`if(1===t.length&&t[0]instanceof fK){…if(e.includes(i.get(o)))return!0…}`）⇒ **元素精确、区分大小写**。Web 两分支分别对齐（`containsBaseNeedle`）**（⑤-8 更正：原引 `@2225713`/`@2226133`；后者引文 `list.includes(value)` 在 app.js 0 命中，非源码字面）**|
| 7 | `containsAll` | `contains all of` | `contains-all`（**本刀新增**） | 本刀支持 | 同上，改为 `every(needle)`；字符串值同样**不区分大小写**（注册 `app.js@2231056`，字符串实现 `app.js@2231262`：`var i=e.data.toLowerCase();return t.every((function(e){return i.includes(e.data.toLowerCase())}))`），列表值元素精确（注册 `app.js@2237817`，实体 `app.js@2238021`：`if(1===t.length&&t[0]instanceof fK){…if(!e.includes(i.get(o)))return!1…}`）**（⑤-8 更正：原引 `@2226000`）** |
| 8 | `matches` | `matches` / `does not match` | `matches`（**本刀新增**） | 本刀支持（**大小写：`desktop-unverified`**） | 桌面 `labelRegExpMatches` 系正则语义 ⇒ `new RegExp(String(value))` 对 cell 文本（多值展开任一命中）求 `test`；**非法正则 fail-closed**：`BaseQueryError` code `invalid-schema`（HTTP 422），绝不当「零行命中」。**大小写未证实**：asar 只证实 RegExp 值类型携带 flags（`app.js@2343705`：`fromParsedResult=function(e){return new t(new RegExp(e.pattern,e.flags))}`；其内 `new RegExp(e.pattern,e.flags)` 起 `@2343747`）**（⑤-9 更正：原引 `@2338710`，该窗口是公式标识符代码、与 `matches` 无关）**，简单构建器把文本 pattern 变成 RegExp 的那一步是否补 `i` 未证实 ⇒ 本实现选**无 flags（区分大小写）**一侧，并显式标 `desktop-unverified`，待真机对拍后再定。表达式层 `title.matches(...)` 仍 `unsupported`（见 §2 该行），二者**不冲突**：高级/表达式模式不接受 `matches` |
| 9 | `hasLink` | `links to` / `does not link to` | `has-link`（**本刀新增**） | 本刀支持 | 与表达式层 `file.hasLink` 同一规则（`workflows.js`）：`target` 相等，或两侧 `.md` 归一后相等。**操作数是记录**：`key` 只用于列范围（且此算子豁免列门禁，见下） |
| 10 | `inFolder` | `in folder` / `is not in folder` | `in-folder`（**本刀新增**） | 本刀支持 | 与表达式层 `file.inFolder` 同一规则：`record.path.startsWith(value.replace(/\/$/,"")+"/")` ⇒ **含子目录**、**按文件夹边界**（`Arch` 不匹配 `Archive/`） |
| 11 | `hasTag` | `has tag` | `has-tag`（**本刀新增**） | 本刀支持 **但保留既有 D1 分歧** | 与表达式层 `file.hasTag` 同一规则：去 `#`、小写、**精确匹配不展开嵌套标签**（官方 S2 的嵌套语义仍未修，属 §8 D1） |

**结构算子（非桌面 funcName，本刀保留）**：`is`/`is-not`/`lt`/`lte`/`gt`/`gte` —— Web 专用比较词表，桌面用表达式运算符；**全部保留**。

**执行规则（本刀新增，`base-query.js` 导出的 `BASE_FILTER_RECORD_OPERATORS`）**：`has-property`/`has-link`/`in-folder`/`has-tag` 的**操作数是记录而非单元格**，
因此它们的 `key` **不经过视图列门禁**（`assertBaseColumnKeys`）——否则「视图没显示 `file.path` 就不能按文件夹筛」这类人为限制会与桌面语义偏离。
其余算子的 `key` 仍必须属于所选视图 `order`（422 `unsupported`）。

**仍未对账（诚实清单）**：桌面 `inverseDisplay`（`does not have property` / `is not empty` …）在 Web 靠 `{not:[…]}` 组表达，**不设**第二个反向 op；
桌面的 `labelPropertyKey` / 属性选择器的 `file.*` 13 个内建属性下拉**未做**（UI 侧仍只列视图列，服务端 `file.*` 已可用）。

## 3. formulas

> **INT-A 状态标注（2026-10-06）**：下表三行（`note.<prop>` / 算术 / 字面量）已由 INT-A 接线转为 `supported`，
> 它们对应的 **W0-B 语料 fixture 已在同一波翻转**（席位 `review-verdict-P0-FLIP-2.md` 批准原子翻转；
> 翻转后 `bases-compat-corpus.test.js` + `workflows.test.js` = **88/88 绿**，本节三行与语料重新一致）：
>
> | fixture | 翻转前 | 翻转后 | 标记 |
> | --- | --- | --- | --- |
> | `hostile-formula-note-namespace` | `reject` / `unsupported`（`note.<prop>` 被 fail closed） | ✅ `accept`（`flipIn: null` + `flippedIn: "INT-A"`） | INT-A |
> | `hostile-formula-number-literal` | `reject` / `unsupported`（数字字面量被 tokenizer 拒） | ✅ `accept`（同上） | INT-A |
> | `hostile-formula-literal-true` | `reject` / `unsupported`（`true`/`false`/`null` 被当保留字拒） | ✅ `accept`（同上） | INT-A |
> | `hostile-formula-comparison` | `reject` / `unsupported`（公式内比较运算符被拒） | ✅ `accept`（同上） | INT-A |
>
> 依据：契约 §7「不得两套 evaluator」（保留旧 `reject` 就等于两套 parser）；第一次翻转 `2ae8983`（test 断言），
> 第二次翻转与 `flippedIn` 规范见 `scratch/bases-p1/INT-A/INT-A.HANDOFF.md` §P0 限制表征翻转。

| 官方语法片段 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| `formulas:` 映射（name → YAML 字符串表达式） | S1 | `supported` | `official-formula-aslink-if-fallback`、`official-formula-nested-if` | S2 |
| `file.asLink(expr)`（可选 display） | S1/S2 | `supported`（返回 `{path, displayName, kind:"asLink"}` 结构化 cell） | `official-formula-aslink-if-fallback`；`base-query.test.js: file.asLink emits structured link cells with declared fallback display names`；`bases-link-formula.test.js: query_base returns structured asLink cells for Knowledge (file.asLink(if(title, title, file.name)))` | S2（生产已验证） |
| 嵌套 `if(cond, a, b)` | S1/S2 | `supported` | `official-formula-nested-if`；`base-query.test.js: nested if resolves title then name then file.name` | S2 |
| `file.name` | S1/S2 | `supported` | `official-formula-aslink-if-fallback`（Beta 无 title → 回退 file.name） | S2 |
| 裸 frontmatter property（官方 "no prefix ⇒ note property"） | S1 | `supported` | `official-formula-aslink-if-fallback`、`real-project-tag-filter-views-sort` | S2 |
| `note.<prop>` / `note["prop"]` 前缀 | S1 | `supported`（INT-A 接线：与裸 property 等价） | `app/test/base-query.test.js: parity (ok): note.title namespace is now supported (INT-A)`；`app/test/bases-link-formula.test.js: flipped P0 restrictions…`；`app/test/base-int-a-expressions.test.js` | S3（已接线） |
| `formula.<name>` 引用（官方允许，禁止循环） | S1 | `supported`（**INT-B 接线**：compile 期 DAG 校验 + 逐行 memo 求值。取值为被引用公式的**原始值**，非 `{path,displayName,kind}` cell；未声明引用仍 fail closed） | `official-formula-formula-ref`（`reject`→`accept`，`flippedIn: "INT-B"`）；`base-query.test.js: parity (ok): formula.<name> reference (INT-B: declared dependency)`、`parity (error): undeclared formula.<name> reference`；`bases-link-formula.test.js: flipped P0 restrictions (INT-B): a formula definition can reference a declared formula` | S4 → since INT-B |
| 公式循环引用 | S1 | `supported`（INT-B：self / 2-node / 多节点环、**包括 dead branch 与未被引用的公式**在 compile 期 fail closed） | `workflows.test.js: Base formula compiler supports note.* references and the P1-A literals, and still fails closed on undeclared references and depth overflow`；`base-formula-dependencies.test.js: cycle: self / 2-node / 3-node / dead-branch all fail closed at compile time` | S4 → since INT-B |
| `this`（`this.file.name` 等） | S1/S4 | `explicitly-unsupported` | `official-formula-this`（`unsupported namespaced reference "this.file.name"`） | S10 / 见 §7 N5 |
| 算术 `+ - * / % ( )` | S1 | `supported`（INT-A 接线：数字算术、字符串 `+`、括号与优先级；跨类型仍 `unsupported`/`type-mismatch`） | `app/test/base-int-a-expressions.test.js`（算术/比较/逻辑矩阵）；`official-formula-arithmetic-ppu` 仍 reject（`.toFixed()` 属 P1-C） | S3（已接线） |
| 日期算术与 duration 单位（`y/M/d/w/h/m/s`…） | S1 | `explicitly-unsupported` | 同算术行（`+`/`-` 亦被 tokenizer 拒） | S3/S10（需 injected clock） |
| 内置全局函数（`if` 除外）：`date/now/today/duration/file/link/number/list/min/max/random/escapeHTML/html/image/icon` | S1/S2 | `explicitly-unsupported` | `official-formula-global-function`（`link("Alpha")` → `Unexpected character "\""`）；`workflows.test.js: Base formula compiler supports note.* references and the P1-A literals, and still fails closed on unsupported references and depth overflow` | S3/S6（P1-C allowlist） |
| 字符串/数字/list/object/date/regexp 方法（`.toFixed()`, `.round()`, `.mean()`, `.contains()`, `.join()`, `.map()`, …） | S1/S2 | `explicitly-unsupported` | `official-formula-builtin-tolist`（`.toFixed(2)` → tokenizer 拒绝）；`official-top-summaries-custom`（`values.mean().round(3)` 见 §6） | S6（P1-C 逐项 characterization） |
| 字面量（number / string / bool / null） | S1 | `supported`（INT-A 接线：字面量可求值且保类型；null 仍走 basename 回退） | `app/test/base-query.test.js: parity (ok): true literal is now supported (INT-A)`；`app/test/bases-link-formula.test.js: flipped P0 restrictions…`；`app/test/base-int-a-expressions.test.js` | S3（已接线） |
| 公式排序/过滤（`sort`/`filters` 用 `formula.*`） | S1（允许） | `supported`（**INT-C 接线**：filter typed 比较、sort typed 总序；`list`/`object` 排序与跨类型仍 fail closed；`groupBy` 用公式仍禁） | `app/test/base-int-c-filter-sort.test.js`；`hostile-formula-in-view-sort`、`hostile-formula-in-view-filter`（翻转申请 `ESCALATION-FLIP-BATCH-1.md`）；`docs/bases/BASES-FILTER-SORT-SEMANTICS.md` | S5 → since INT-C |
| `order` 引用未声明 formula | S1 | `explicitly-unsupported` | `hostile-formula-missing-reference`；`base-query.test.js: parity (error): missing formula property in order` | S2 |
| `formulas` 值非字符串 | S1（"always stored as strings"） | `explicitly-unsupported` | `hostile-formula-non-string` | S0 |
| 嵌套深度边界 20 / >20 | 项目冻结（契约 §7） | `supported`（>20 fail closed） | `hostile-formula-depth-25`；`base-query.test.js: parity (error): depth > 20` | S0（不得无依据放宽） |
| 未使用公式 / dead branch 也全量 compile | 契约 §7 | `supported`（fail closed） | `workflows.test.js: Base formula compiler validates unused formulas and dead branches before evaluation`；`bases-link-formula.test.js: empty result sets still validate the whole formula AST` | S0 |
| hostile 键（`__proto__` 作 formula 名） | 契约 §14.7 | `supported`（null-prototype registry，保持 own key） | `hostile-proto-formula-name`；`workflows.test.js: Base formula compilation keeps hostile keys as own properties` | S0 |
| 公式求值不触发 accessor / 无动态代码 | 契约 §7/§14.7 | `supported` | `workflows.test.js: Base formula evaluation returns structured cells and never invokes accessors` | S0 |
| plugin 提供的函数 | S1/S2 | `not-applicable`（永久不自动执行；契约 §4） | `official-formula-global-function` 同类路径（未知函数 fail closed） | S10 |

## 4. properties

| 官方语法片段 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| `properties.formula.<name>.displayName` | S1 | `supported`（**被消费为列 label**） | `official-properties-displayname-formula`（`columns` 断言 `[["formula.label","Label"]]`）；`real-project-tag-filter-views-sort`（`Project`） | S1 |
| `properties.<note prop>.displayName` | S1 | `supported`（**只有 formula 列消费它**；note 属性上的声明被**忽略**，label = 内置名表（U5）?? key 尾巴。2026-10-21 `desktop-re/bases-ui-parity-2` 曾让所有 kind 声明优先，2026-10-24 `desktop-re/column-label-surfaces` 按业主 01/04 表头改正，见 §14.10） | `official-properties-displayname-note`（`columns` 断言 `[["status","status"]]`）；`bases-semantic-keys-characterization.test.js` 的 `properties.status.displayName` 行（label = `status`）；`web-bases-ui-parity-2.test.js`；`web-bases-builtin-names.test.js` ③/③b/③c/③d/③e | S1 |
| `properties.file.<prop>.displayName` | S1（示例含 `file.ext`） | `supported`（同样**只对 formula 列生效**；`file.*` 的 label 走内置名表，`file.ext` 本身不入列集时自然无 label。§14.10） | `official-properties-displayname-note`（`status` → `status`） | S1 |
| properties 下的**未知配置键** | S1（"It is up to the individual view how to use these"） | `not-applicable`（显式分类为忽略：官方明说由各 view 自行决定用途，本实现忽略且不改变行集合） | `hostile-unknown-properties-key`（`accept`，`flipIn: null`） | **DISPLAY-METADATA**（不属 fail-closed 面；见 §12） |
| `displayName` 不参与 filter/formula | S1 | `supported`（label 只用于列显示） | `official-properties-displayname-*` | S1 |

## 5. views

| 官方语法片段 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| `views:` 为数组；每项 `type` + `name` 必填 | S1 | `supported`（缺失即 `invalid-schema`） | `boundary-missing-view-name`、`boundary-missing-view-type`；`base-query.test.js: validateBaseDocument preserves the historical rule text and evaluation order` | S0 |
| `views: []` | S1（未记载） | `supported`（无 view 可选中 → 默认 `file.path` 投影） | `boundary-empty-views`；`base-query.test.js: compileBaseView defaults to no view and file.path order` | S0 |
| `views` 非数组 | S1 | `explicitly-unsupported` | `boundary-views-not-array`；`base-query.test.js: invalid views shape fails closed; service normalizes the historical runtime TypeError` | S0 |
| `name` 用于选择/默认第一个 view | S1/S3 | `supported` | `real-project-second-view-select`；`base-query.test.js: compileBaseView picks the requested/default view and compiles formulas` | S0 |
| 未知 `name` | S1 | `explicitly-unsupported` | `boundary-request-view-not-found`；`base-query.test.js: parity (error): view not found` | S0 |
| `limit`（正整数） | S1 | `supported`；非法值（0/负数/小数/字符串）`invalid-schema` | `boundary-limit-zero`、`boundary-limit-negative`、`boundary-limit-fraction`、`boundary-limit-string`；`real-project-limit-truncation`；`base-query.test.js: view.limit canonical domain is a positive integer; invalid values fail closed` | S0 |
| 请求级 limit 覆盖 view.limit | 项目冻结（MCP DTO） | `supported`（`limit \|\| view.limit \|\| sorted.length`） | `real-project-request-limit-override`；`base-query.test.js: limit precedence: request > view limit, and 0/undefined fall through` | S0 |
| `order`（列集合/列顺序） | S1（示例列出 property 列表） | `supported`（作为投影列集合，默认 `["file.path"]`） | `official-formula-aslink-if-fallback`（`columns`）、`official-properties-displayname-formula` | S0 |
| `sort`（官方 help 语法页**未记载**） | S1 **无**；S5 真实 `.base` 有 `sort:` + `property:`/`direction:` | `supported`（现行实现的 view 排序键；`direction` 缺省 ASC，其他值 fail closed） | `official-file-property-sort`、`real-project-tag-filter-views-sort`、`hostile-sort-missing-direction`、`hostile-sort-bad-direction`；`base-query.test.js: sort applies ASC/DESC, null-last and final path tie-break` | S1；官方地位见 §9 V2 |
| `type: table` | S1/S3 | `supported` | 全部 `type: table` fixture | S0 |
| `type: list` / `cards` / `kanban` / `map`（含插件视图） | S1/S3 | `not-applicable`（domain 层）：布局选择器**不改变行集合**，本实现一律按 table 取数并回显声明类型 | `official-view-type-list` / `-cards` / `-map` / `-unknown`（均 `accept`，`flipIn: null`） | **DISPLAY-METADATA**（W0-D 不翻转）；Web 视觉 parity 属 Web 独立 TODO（契约 §4）；见 §12 明文契约 |
| view 私钥（`cardSize`、`image`、`columnSize`、任意未知键） | S1（"Views can add additional data to store any information…"）；S5 观察到 `columnSize` | `not-applicable`：官方明示属视图自有状态；忽略后 rows / DTO 逐字节不变 | `official-view-cardSize-table`、`hostile-unknown-view-key`（均 `accept`，`flipIn: null`） | **DISPLAY-METADATA**（W0-D 不翻转）；见 §12 |
| 多 view 共存、声明顺序 | S1 | `supported` | `real-project-tag-filter-views-sort`（2 个 view）；`base-query.test.js: queryBaseSnapshot exposes declared views in declaration order` | S0 |

## 6. groupBy

> **刀4（2026-10-19，`fix/bases-cut4-grouping`）**：本节从 `explicitly-unsupported` 翻转为 **`supported`**。
> 实现落点：`app/src/base-query.js`（`readGroupByDeclaration` / `assertSupportedGroupingKeys` / `buildGroupingDto`）+ `app/src/base-grouping.js`（接线，D1）。
> 证据：`app/test/base-cut4-grouping.test.js`（C2/C4/C5/C6/C18/C19/C20/C21）、语料 `official-view-groupby-*`（`flippedIn: "CUT4"`）、`app/test/bases-semantic-keys-characterization.test.js`。
> 仍 fail closed 的两行（非法 direction、`formula.*` 组键）**保持不变**。

| 官方语法片段 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| `groupBy: {property, direction}` | S1（示例 `direction: DESC`） | `supported`（**刀4 接线**：组序由组键 + `direction` 决定；`SEMANTICS-FROZEN` P9/P12） | `official-view-groupby-asc` / `-desc`（`flippedIn: "CUT4"`）；`app/test/base-cut4-grouping.test.js` C4/C5 | P1-D（S7）→ 已完成（刀4） |
| `direction: ASC` | S1（ASC 未在示例出现，推断） | `supported`（组键升序；空键组恒最后） | `official-view-groupby-asc`（`flippedIn: "CUT4"`）；C6 | P1-D → 已完成（刀4） |
| `direction: DESC` | S1 | `supported`（只翻**组间**序；行序仍由 `sort` 决定） | `official-view-groupby-desc`（`flippedIn: "CUT4"`）；C5 | P1-D → 已完成（刀4） |
| 缺 `direction` | S1 未自核其可缺省性 | `supported`（缺省 = `ASC`，`DEFAULT_GROUP_DIRECTION`） | `official-view-groupby-property-only`（`flippedIn: "CUT4"`）；C6 | P1-D → 已完成（刀4）；官方可缺省性见 §9 V3（已按 E6 收口） |
| 非法 `direction` 值 | S1（无定义） | `explicitly-unsupported`（**保持 fail closed**：`unsupported`，消息含 `views[].groupBy`） | `official-view-groupby-bad-direction`（仍 `reject`/`unsupported`，理由改为非法取值）；`app/test/bases-fail-closed-adapters.test.js`（MCP tool error + Web 422） | 已完成（W0-D 收窄，刀4 保持） |
| `groupBy.property` 指向 `formula.<name>` | S1（groupBy 用公式未写） | `explicitly-unsupported`（**INT-C 守卫逐字保留** `assertNoFormulaReferencesInGroupBy`；E11/U1 未证实，不得放开） | `app/test/base-int-c-filter-sort.test.js: formula.* in view.groupBy is still unsupported`；`app/test/base-cut4-grouping.test.js` C17 | 随 `formula.x` 键路径证据（`unverified` U1） |
| `groupBy` × `sort` × `limit` 组合形态 | S1（同一 view 示例里同时出现） | `supported`（**冻结顺序**：`limit` 作用于全局已排序平铺行、**早于**分组；`groupBy.direction` 只定组间序） | `SEMANTICS-FROZEN` §1 P2/P6/P7/P9；`official-view-groupby-with-sort-and-limit`（`flippedIn: "CUT4"`，`limit: 2` 后只剩 2 组）；C1/C2/C9/C21 | 已完成（刀4；`CHARACTERIZE-PENDING` 由冻结契约替换） |

## 7. summaries

> **刀4（2026-10-19，`fix/bases-cut4-grouping`）**：本节从 `explicitly-unsupported`/`planned` 翻转为 **`supported`**。
> 实现落点：`app/src/base-summaries.js`（新，纯模块）+ `app/src/base-query.js` 的 `buildGroupingDto`。
> 冻结依据：`SEMANTICS-FROZEN` P15–P21（逐条引用见下表）；差异：**D2**（Stddev = 总体，n=1 ⇒ 0）、**D3**（Empty 只数 `isType("null")`）、**D4**（Unique 类型化）已按桌面事实落地；
> 两处**有意的收窄**（不主张 parity，已在 §14 登记）：未知 summary 名/被引用的自定义 summary 名 **fail closed**（桌面静默无值），不可算的组值带显式 `reason`（桌面静默无值）。
> 证据：`app/test/base-cut4-grouping.test.js`（C8–C15/C16/C22）、语料 `official-view-summaries-builtins` / `official-view-complete-table` / `official-top-summaries-custom`（`flippedIn: "CUT4"`）。

| 官方语法片段 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| 顶层 `summaries:`（custom summary 公式，`values` 为属性值列表，须返回单个 Value） | S1 | `supported`（**注册表语义**：形状被校验；**未被引用**时不改行/列/组，与桌面一致）。**被 `views[].summaries` 引用时 fail closed**（`unsupported`：`values.*` 面未实现，矩阵 §3 逐条列明） | `official-top-summaries-custom`（`flippedIn: "CUT4"`）；`app/test/base-cut4-grouping.test.js` C22；`app/test/bases-semantic-keys-characterization.test.js`（顶层行 + 被引用行） | P1-F（S9）仅剩 `values.*` 公式面 |
| view `summaries:`（property → 内置 summary 名） | S1 | `supported`（**刀4 接线**：按组、对**留存行**（post-limit）聚合；无 `groupBy` ⇒ 整表一个无键组，P8/P15/P16） | `official-view-summaries-builtins` / `official-view-complete-table`（`flippedIn: "CUT4"`）；C8/C9/C10 | P1-E（S8）→ 已完成（刀4） |
| 内置 `Average`（Number） | S1 表 | `supported`（`.round(2)`；空组 → 无值，P18） | `official-view-summaries-builtins`；C8/C14 | P1-E → 已完成 |
| 内置 `Min`（Number） | S1 表 | `supported`（不舍入，P18） | 同上；C14 | P1-E → 已完成 |
| 内置 `Max`（Number） | S1 表 | `supported`（不舍入，P18） | 同上；C14 | P1-E → 已完成 |
| 内置 `Sum`（Number） | S1 表 | `supported`（`.round(2)`，P18） | 同上；C9/C14 | P1-E → 已完成 |
| 内置 `Range`（Number）= Max−Min | S1 表 | `supported`（数字组：不舎入；**日期组**：单位/舎入 asar 未读到（U4）⇒ `value: null` + `reason: "unverified-unit"`，不猜单位） | `app/test/base-cut4-grouping.test.js` C14；`SEMANTICS-FROZEN` U4 | P1-E → 已完成（日期单位待 U4） |
| 内置 `Median`（Number，偶数项规则待 characterization） | S1 表 | `supported`（偶数项 = 中间两值均值；U4 未读到官方实现体，仍属 `unverified`） | C14 | P1-E → 已完成（U4 残留） |
| 内置 `Stddev`（Number；population vs sample 待 characterization） | S1 表 | `supported`（**总体**标准差，除数 n；n=1 ⇒ **0**；空组 ⇒ 无值；`.round(2)`）——**D2 已按桌面事实落地** | `SEMANTICS-FROZEN` P19；`app/test/base-cut4-grouping.test.js` C13（σ([2,4,4,4,5,5,7,9])=2，样本值会是 2.14） | P1-E → 已完成（D2） |
| 内置 `Earliest`（Date） | S1 表 | `supported`（按瞬时取最小，输出 ISO-8601 UTC 字符串；显示格式 U5 未证实） | C13 同类；`SEMANTICS-FROZEN` U5 | P1-E → 已完成 |
| 内置 `Latest`（Date） | S1 表 | `supported`（同上，取最大） | 同上 | P1-E → 已完成 |
| 内置 `Range`（Date）= Latest−Earliest | S1 表（与 Number `Range` 同名两行） | `supported`（**值面收窄**：`null` + `reason: "unverified-unit"`，U4） | 同上 | P1-E → 待 U4 |
| 内置 `Checked`（Boolean，`true` 计数） | S1 表 | `supported`（typed 相等计数；非 boolean 值不计；空组 ⇒ 0） | `app/src/base-summaries.js`；C16 | P1-E → 已完成 |
| 内置 `Unchecked`（Boolean，`false` 计数） | S1 表 | `supported`（同上） | 同上 | P1-E → 已完成 |
| 内置 `Empty` / `Filled`（Any 计数） | S1 表 | `supported`（**Empty = `isType("null")` 计数**，映射到本项目冻结的 missing ≡ null（B6#1）；`""` / `0` / `false` **不计** —— **D3 已按桌面事实落地**） | `SEMANTICS-FROZEN` P18/P20；`app/test/base-cut4-grouping.test.js` C11 | P1-E → 已完成（D3） |
| 内置 `Unique`（Any 计数，equality 待 characterization） | S1 表 | `supported`（`toString()` 分桶 + `baseValuesEqual` 判重：`1` 与 `"1"` 相异、空值计一个 —— **D4 已按桌面事实落地**） | `SEMANTICS-FROZEN` P21；`app/test/base-cut4-grouping.test.js` C12 | P1-E → 已完成（D4） |
| summaries × limit / group 的相对顺序 | S1 未定义 | `supported`（**冻结**：summary 值域 = 该组**留存行**（post-limit），DTO 带 `scope: "visible-rows"`） | `SEMANTICS-FROZEN` P15/P16/E14；C9/C10/C21 | 已完成（刀4；`CHARACTERIZE-PENDING` 由冻结契约替换） |

> 本表 15 条内置 summary 已全部可达（`official-view-summaries-builtins` 已翻转为 `accept`）。每条的值语义都能在 `app/test/base-cut4-grouping.test.js` 找到对应 C 项；**不可算**的组值不再"静默无值"，而是 `value: null` + `reason`（`empty` / `type-mismatch` / `unverified-unit` / `not-a-column`）。

## 8. YAML / schema 边界与安全

| 边界形态 | 官方来源 | 现行状态 | 证据 | 计划归属 |
| --- | --- | --- | --- | --- |
| 空 Base（`{}`，无任何顶层键） | S1（"By default a base includes every file"） | `supported` | `boundary-empty-base` | S0 |
| `views: []` | S1 未记载 | `supported` | `boundary-empty-views` | S0 |
| 缺 `views[].name` | S1（`name` 是 view 键） | `explicitly-unsupported` | `boundary-missing-view-name` | S0 |
| 缺 `views[].type` | S1 | `explicitly-unsupported` | `boundary-missing-view-type` | S0 |
| `limit: 0` | S1（"limit the number of results"） | `explicitly-unsupported` | `boundary-limit-zero` | S0 |
| `limit` 负数 | S1 | `explicitly-unsupported` | `boundary-limit-negative` | S0 |
| `limit` 小数 | S1 | `explicitly-unsupported` | `boundary-limit-fraction` | S0 |
| `limit` 字符串数字 `"5"` | S1 | `explicitly-unsupported`（不做 coercion） | `boundary-limit-string` | S0 |
| 非对象 root（YAML 列表） | S1（"must be valid YAML conforming to the schema"） | `explicitly-unsupported` | `boundary-root-list`；`base-query.test.js: parity (error): invalid base root` | S0 |
| malformed YAML | S1 | `explicitly-unsupported`（`invalid-yaml`，与 `invalid-schema` 分流） | `boundary-malformed-yaml`；`base-query.test.js: parseAndValidateBase classifies YAML syntax vs schema errors` | S0 |
| hostile 键 `__proto__` 作 filter 键 | 契约 §14.7 | `supported`（不匹配 and/or/not → fail closed） | `hostile-proto-filter-key` | S0 |
| hostile 键 `__proto__` 作 formula 名 | 契约 §14.7 | `supported`（own key，null-prototype） | `hostile-proto-formula-name` | S0 |
| hostile 键 `__proto__` 作记录 frontmatter own 键 | 契约 §14.7 | `supported`（按 own 值读取） | `hostile-proto-frontmatter-property` | S0 |
| `constructor` 等**继承属性**经 filter 路径被读到 | 契约 §14.7（"inherited property 不得被执行"） | `explicitly-unsupported` **但当前静默**：`propertyValue` 直接下标取值，命中原型链（不执行 getter，但不报错） | `hostile-inherited-constructor-filter`（`accept`，`flipIn: null`） | **DEFERRED（P1-A security）**：W0-D 明确不修（`constructor` 是裸属性、无 namespace，不在本刀冻结面）；own-key 化归 P1-A 安全加固 |
| 超长字符串（1024 字符字面量） | 契约 §14.7 | `supported`（tokenizer 线性；无显式上限，仅受上游文件大小限制） | `hostile-overlong-string-literal` | S0（如需硬上限，单独评估） |
| 无 `eval` / `Function` / `vm` / 动态 import | 契约 §7/§17 | `supported` | `probe/log-no-dynamic-code.txt`（`base-query.js` / `base-formulas.js` / `workflows.js` 三文件 grep 无 `eval(`/`new Function`/`child_process`/动态 `import(`/`vm.`）；`workflows.test.js: Base formula evaluation returns structured cells and never invokes accessors` | S0（RETURN 条件，任何新增能力都不得破） |
| XSS-like 字符串只作值传递 | 契约 §14.7 | `supported`（Web 渲染层转义，属 web 面） | Web：`app/test/web-bases-surface-contract.test.js`、`web-bases-browser-contract.test.js`（本刀未改） | S0 |

## 9. PENDING-VERIFY 登记（未自核项，逐条说明）

| ID | 未能自核的点 | 说明与下一步 |
| --- | --- | --- |
| V1 | `==` / `!=` 与 `<`/`>` 在 **跨类型**（number vs string、missing vs ""、Date vs string）下的官方语义 | S1 只说"Equal and not equal 可用于任何值"，未定义 coercion。现行实现用 `String()` 兜底（`official-filter-comparison-coercion` 冻结现状）。需桌面 Obsidian 实验（归 `SEMANTIC-ORDER-BLOCKERS.md` B6）。 |
| V2 | `view.sort` 的**官方地位**与 `order` 的确切语义 | S1 的 view 键列表**不含** `sort`，但 S5 显示 Obsidian 自己写出 `sort:`/`direction:`；S3 说 table view 可自存"哪一列排序及方向"。结论：`sort` 是真实存在但未见于语法参考的 view 键。**官方文档层面无法进一步自核**，需桌面实验或 Obsidian 源码/导出样本。 |
| V3 | `groupBy` 是否允许缺 `direction`；`direction` 的合法取值集合 | **已收口（刀4）**：桌面 asar `setGroupBy` 只写 `{property,direction}`，缺省 `ASC` 的可缺省性只在**手动列**路径可见（`SEMANTICS-FROZEN` E6 / P14）⇒ 本项目定：缺省 `ASC`（`DESIGN`，不主张 parity）；合法集合严格 `{ASC, DESC}`（大小写敏感），其余 `unsupported`（比桌面更严）。证据：`app/test/base-cut4-grouping.test.js` C5/C6、语料 `official-view-groupby-bad-direction`。 |
| V4 | 官方 view `type` 的完整取值集合（含 `kanban` 自 Obsidian 1.14 起） | S3 的布局表列了 table/cards/list/kanban/map 及版本，但 `type` 的字符串字面量未在语法页枚举；插件可扩展。需桌面样例。 |
| V5 | `properties.<prop>` 下除 `displayName` 外的官方配置键（如类型/格式） | S1 只说"由各 view 自行决定用途"，未列举。`hostile-unknown-properties-key` 冻结现状（忽略）。 |
| V6 | 官方 custom summary 里 `values` 的完整语义（类型过滤、空集） | S1 只说"是该属性在结果集上的值列表，须返回单个 Value"。属 P1-F，须 characterization。 |

## 10. RECON §2 静默面的 W0-D 处置（逐项）

W0-B 曾把 RECON §2 的静默面逐项登记为 W0-D 输入；下表是 Wave 0-D 的**最终处置结果**（契约 §2 点名三键之外更宽的静默面也逐项有去处）：

| 现象 | fixture | W0-D 处置 | 现状 | 依据 |
| --- | --- | --- | --- | --- |
| 三个 core 语义键 `groupBy` / `view.summaries` / 顶层 `summaries` 被静默忽略 | `official-view-groupby-*`（５）、`official-view-summaries-builtins`、`official-top-summaries-custom`、`official-view-complete-table` | **已翻转 → `unsupported`** | `reject`，`flipIn: "W0-D"` | 契约 §2.2 / §17 |
| filter 里未知 namespace（`this.…`）被当 undefined | `hostile-unknown-namespace-filter` | **已翻转 → `unsupported`** | `reject`，`flipIn: "W0-D"` | 契约 §2.2 / §17（会改变结果集） |
| `views[].type` 非 table（list/cards/map/未知）被平铺为 table | `official-view-type-list` / `-cards` / `-map` / `-unknown` | **不翻转 → DISPLAY-METADATA**（不改变行集合） | `accept`，`flipIn: null` | 契约 §2.3 + §4（Web 视觉 parity 非 P1） |
| `cardSize` / `image` / 未知 view 键被忽略 | `official-view-cardSize-table`、`hostile-unknown-view-key` | **不翻转 → DISPLAY-METADATA** | `accept`，`flipIn: null` | 官方"视图自有键"条款 + 契约 §2.3 |
| 未知 `properties.*` 配置键被忽略 | `hostile-unknown-properties-key` | **不翻转 → DISPLAY-METADATA** | `accept`，`flipIn: null` | 同上 |
| 未实现 file 属性（`file.backlinks` 等）在 filter 里被当 undefined | `hostile-unsupported-file-property-filter` | **不翻转 → DEFERRED（P1-A typing）** | `accept`，`flipIn: null` | `file` 是合法 namespace；属性名 allowlist 属 P1-A |
| `constructor` 等继承属性经 filter 路径可读 | `hostile-inherited-constructor-filter` | **不翻转 → DEFERRED（P1-A security）** | `accept`，`flipIn: null` | 裸属性无 namespace；own-key 化属 P1-A 安全加固 |
| `file.hasTag` 不展开嵌套标签 | `official-filter-hastag-nested` | 本刀不处理（语义分歧、非 fail-closed 缺口） | `accept`，`flipIn: null` | S2；需单独 GO |
| 顶层 `sort` 被 guard 检查却不被消费（§4 末行） | 无独立 fixture | 本刀不处理，登记待裁定 | — | 官方 schema 未定义顶层键封闭性（§9 V5 同类） |

## 11. 本刀覆盖面自查（对照 BRIEF §1.1）

| BRIEF 要求 | 落点 |
| --- | --- |
| filters：全局/view、and/or/not 递归、比较 6 种、contains/startsWith/endsWith、file.inFolder/hasTag/hasLink、未实现 file helper 逐条 | §2 + §2.1（14 个 file 属性逐条） |
| formulas：现行 asLink 子集、明确 unsupported 的算术/内置/formula.*/this/.toFixed，各给 code | §3（每条带 code 或行为） |
| properties：公式 displayName / 非公式 displayName / 未知配置键 | §4 |
| views：type 取值、name/limit/filters/order/sort、`sort` 官方性自核 | §5 + §9 V2 |
| groupBy：两方向 + 与 sort/limit 组合形态 | §6 |
| summaries：顶层/view + 15 条内置逐条 | §7 |
| YAML 边界：空 views、缺 name/type、非法 limit ×4、非对象 root、malformed YAML、hostile 键、超长字符串 | §8 |
| PENDING-VERIFY 行有明确说明 | §9（V1–V6） |
| 逐行：官方片段 / 官方来源 / 现行状态 / 证据 / 计划归属 | 全部表格 5 列 |

## 12. DISPLAY-METADATA 明文契约与 DEFERRED 登记（Wave 0-D）

### 12.1 明文契约（席位口径，逐字落地）

> 当前实现把所有 `view.type` 当 table 处理，返回相同的行集合；`cardSize` / `image` 等键保留但不改变查询结果。
> 未来若支持 cards / list 等视图类型，其渲染差异不影响"此类视图在 `supportedSubset=true` 时返回正确 row 语义"的契约。

展开成可执行条款：

1. **行集合不变**：`views[].type`（任意取值）、`cardSize`、`image`、任何未知 view 键、任何未知 `properties.<key>` 配置键的存在与取值，**不得**改变 `rows`、`totalMatched`、`truncated`、列集或列顺序。证据：W0-A 冻结表与 `official-view-type-*` / `official-view-cardSize-table` / `hostile-unknown-view-key` / `hostile-unknown-properties-key` 在 `flipIn: null` 下仍是 `accept`。
2. **`supportedSubset=true` 的含义**：它描述的是**取数语义**（这份文档的行/列/上限都已按支持子集正确求值），不是"已渲染声明视图类型"的声明。
3. **adapter 不得把它当渲染承诺**：MCP `query_base` DTO 不含 `type`；Web 路由回传 `views[]` 的 `type` 仅作选择器展示，并已声明 `capabilities.grouping=false` / `aggregation=false`。calls：Web 视觉 parity 属 Web 独立 TODO（契约 §4）。
4. **一旦支持非 table 类型**：新类型的渲染差异也不得改变第 1 条的行集合语义；若某类型的**取数**需要不同行语义（例如 map 的坐标投影），则必须另开 fail-closed 守卫，而不是默默改变 `supportedSubset` 的含义。

### 12.2 DEFERRED 登记（四处，逐条归属）

| # | 登记项 | 归属 lane | 当前行为 | 证据 fixture | 不得混淆之处 |
| --- | --- | --- | --- | --- | --- |
| D1 | 未实现的 `file.<prop>` 在 filter 里静默 `undefined`（`file.backlinks` / `file.embeds` / `file.basename` / `file.properties` …） | **P1-A expression typing**（`file` 属性名 allowlist） | `accept`，静默匹配 0 行 | `hostile-unsupported-file-property-filter`（`flipIn: null`） | 前缀 `file` **合法**，属"属性名未实现"而非"语法不支持"；W0-D 冻结的是走点引用的**未知 namespace** |
| D2 | `constructor` 等**继承属性**经 filter 路径可读（不执行 getter，但不报错） | **P1-A 安全加固**（`propertyValue` own-key 化） | `accept`，匹配 0 行 | `hostile-inherited-constructor-filter`（`flipIn: null`） | `constructor` 是**裸属性名**（无点），不属 W0-D 的 namespace 守卫面，也不应因为"看着像危险键"就顺手修 |
| D3 | 非 formula `properties.<key>.displayName` 被忽略（列 label 回退为 key 后缀） | **展示窄刀**（独立，非 W0-D） | **最终口径（2026-10-24，`desktop-re/column-label-surfaces`）**：`accept`，但 label **不采用**非 formula 的 `displayName`——它是内置名表（U5）?? key 尾巴；只有 formula 列消费 displayName。（2026-10-21 `desktop-re/bases-ui-parity-2` 曾改为声明优先，已被业主 01/04 表头否定） | `official-properties-displayname-note`（`status` → `status`）；W0-A 冻结表 `properties.status.displayName`（label = `status`） | 原为展示 parity 缺口；两轮修正后两处冻结期望与 fixture 的 `note` 已同步 |
| D4 | 未知顶层键（含顶层 `sort`）无明确 allowlist/denylist | **待席位裁定** | `accept`，忽略 | W0-A 冻结表 `<unknown top-level key>`；本文件 §4 末行 | 官方五节 schema 无机器可读封闭性定义（§9 V5 同类）；无证据就 reject 有拒绝合法文件的风险 |

## 12.3 本刀未做的两件事（防外溢声明）

> 历史声明（W0-B / W0-D 席位）：下文两条描述的是**当时的**状态，已由后续刀改变 —— 见 §14。

- **未实现任何 grouping / summaries 语义**（`SEMANTIC-ORDER-BLOCKERS.md` 未清零；本刀只拒绝，不实现）。→ **已过时**：`SEMANTICS-FROZEN.md` 已冻结，刀4 已实现（§6/§7/§14）。
- **未改任何 adapter 生产文件**（`app/src/tools/workflows.js`、`app/src/app/base-route.js`、`app/src/base-formulas.js`、bundle）：Web 的 422 `unsupported` 走**既有** `base-route.js` 错误映射，MCP 走**既有** `err(error)` 路径（新增只读证据：`app/test/bases-fail-closed-adapters.test.js`）。

## 13. 复现方式

```text
cd app
node --test test/bases-compat-corpus.test.js     # 74 fixtures + 2 清单测试
```

fixture 三件套形状与 `flipIn` / `flippedIn` 语义写在 `app/test/bases-compat-corpus.test.js` 顶部注释里；`expected.json` 保留冻结的 **6 个键**（`outcome` / `code` / `supportedSubset` / `rowPaths` / `note` / `flipIn`），
外加**唯一可选键** `flippedIn`（INT-A 新增，标记 `reject`→`accept` 的前向翻转；其余未知键仍被形状守卫拒绝）。
查询输入（`viewName`/`limit`）与列 label 断言集中在测试文件顶部的 `CORPUS_EXPECTATIONS`。W0-D 后 `flipIn` 非 null ⇒ 必为 `reject`+`unsupported`（形状守卫强制执行，防止再出现"假翻转"标记）；INT-A 后 `flippedIn` 非 null ⇒ 必为 `accept` 且 `flipIn` 为 `null`（新增守卫，additive）；
刀4 的 7 个 fixture 用 `flippedIn: "CUT4"`（`FORWARD_FLIP_LANES` 已加入该 lane）；`official-view-groupby-bad-direction` **仍为 `flipIn: "W0-D"` / `reject`**，理由从"整键未实现"变为"非法 direction 取值"。

## 14. 刀4 差异登记（`fix/bases-cut4-grouping`，2026-10-19）

**翻转面**：`views[].groupBy`、`views[].summaries`、顶层 `summaries` 从 fail-closed 变 accept；管线顺序按 `SEMANTICS-FROZEN.md` §1 冻结：`filters → sort → limit(全局平铺行) → groupBy(分区) → summaries(按组、留存行)`。

**DTO（ADD-only）**：仅当所选 view 声明了 `groupBy` / `summaries` 时，`queryBaseSnapshot` 额外返回：

```jsonc
{
  "groups": [
    { "key": <JSON-safe 组键|null>, "keyType": "string|number|boolean|date|datetime|link|null",
      "count": 2, "rowPaths": ["…"],
      "summaries": { "scope": "visible-rows", "values": { "<prop>": { "summary": "Sum", "value": 13, "reason": null } } } }
  ],
  "summaries": { "scope": "visible-rows", "values": { "<prop>": { "summary": "Sum", "value": 17, "reason": null } } }
}
```

- `groups` = 留存行的**分区**（组内行序 = `sort` 序）；`groups[].summaries` = 该组留存行的聚合；顶层 `summaries` = 整批留存行（P8 的"单一组"）。
- `scope: "visible-rows"` 记录值域是 **post-limit**（E14/B5 要求的 scope 字段）。
- `reason` 取值：`null`（可算）/ `empty`（组内无值）/ `type-mismatch`（组内有值但不可算，E10）/ `unverified-unit`（日期 `Range`，U4）/ `not-a-column`（声明的属性不在 `view.order` 列集，E8）。
- **未声明时两个键都不出现**：MCP `query_base`（重建自己的 DTO）与 Web 页面 DTO 逐字节不变（`capabilities.grouping` 仍为 `false`，UI 腿属另刀）。

**D1–D5 落地（逐条）**

| # | 项 | 桌面 asar 事实 | 刀4 选择 | 证据 |
| --- | --- | --- | --- | --- |
| D1 | 无值/空组位置 | 恒在最后（ASC/DESC 皆然，P10/P11） | **选桌面（parity）**；B7 的"最小侧"DESIGN 退为历史 | `app/src/base-grouping.js` 排序分支；`base-grouping.test.js`、C6 |
| D2 | `Stddev` | 总体标准差，n=1 ⇒ 0，空 ⇒ 无值 | **选桌面（parity）** | `app/src/base-summaries.js` `populationStddev`；C13 |
| D3 | `Empty` 判据 | 只认 `isType("null")` | **选桌面**（映射到本项目 missing ≡ null；`""`/`0`/`false` 不计） | C11 |
| D4 | `Unique` | 类型化相等 + `toString()` 分桶 | **选桌面** | C12 |
| D5 | `limit: 0` | 0 = 不限制（"Show all"） | **有意收窄**：仍 `invalid-schema`，**不主张 parity** | C3；`validateBaseDocument` 未改 |

**仍 fail closed / 有意收窄（逐条，不得读作 parity）**

| # | 项 | 桌面行为 | 本项目行为 | 理由 |
| --- | --- | --- | --- | --- |
| N1 | 未知 summary 名 | 静默无值 | `unsupported`（消息含 `unknown summary name`） | E9 要求 fail closed；契约 §17 不返回部分语义 |
| N2 | 顶层自定义 summary 被引用 | 执行 `values.*` 公式 | `unsupported`（`values.*` 面未实现，矩阵 §3） | 不放开公式引擎 fail-closed 方向（本刀禁改 `base-formulas.js`） |
| N3 | 组内混合类型 | 由首个非空值的类型决定 summary 集，查不到则无值 | `value: null` + `reason: "type-mismatch"`（**显式**，不静默） | E10 |
| N4 | 日期 `Range` | 产出 duration（单位未读到） | `value: null` + `reason: "unverified-unit"` | U4 `unverified`，不得当已证实 |
| N5 | `groupOrder` | **行集白名单过滤器**（P14，高危） | **保持静默忽略（未知键语义不变）**，不半实现；不进 DTO | E12/U2；kanban 前置，见 HANDOFF |
| N6 | `list`/`object` 组键 | 单元素 list 与其元素同组（loose） | `unsupported_group_key` 整次失败 | E4 两分支之一（项目选 fail-closed） |
| N7 | `limit: 0` | 不限制 | `invalid-schema` | D5 |
| N8 | `groupBy` 内的多余键（如 `{property, directions}`） | 读侧只取 `{property, direction}`，多余键静默忽略 | `unsupported`（消息含 `views[].groupBy` 且点名该键） | 刀4 修正（fix lane）：实现对齐自己声明的「anything else fails closed」；asar `setGroupBy` 只写 `{property, direction}`（E6，`@2353401`），未发现第三个键 ⇒ 收窄优于静默吞键；C23 |
| N9 | 顶层视图键拼写错误（`groupby:` / `summarie:`） | 同形：未知 view 键无后果 | **静默忽略**（既有 §12.1 DISPLAY-METADATA 契约，本刀不改行为） | 刀4 让 `groupBy` 有后果后，一次拼写错误会**静默丢掉分组意图**（不丢行、不少列，仅少 `groups`）；登记为已知风险，护栏属另刀 |
| N10 | 空记录集（0 行）的 `Empty` | 类型 undefined ⇒ 内置集空集 ⇒ 无值（E1） | `value: 0, reason: null` | 显示面微小偏离（**不动行集/组集**）：「数 0 个东西」可算 ⇒ 报 `0`；C16 |

**§14.1 跨面指针（非真源，2026-10-21 加）**

| # | 项 | 登记位置 | 性质 |
| --- | --- | --- | --- |
| P1 | 文档视图 metadata 面板的属性胶囊 | 见 `docs/web-document-metadata-panel.md`「与桌面 1.14.4 的差异登记」 | 指针，非真源 |

> 属性胶囊属**文档视图 metadata 面板**，不属 Bases 面；正文（tags 支 / 非 tags 支 / 唯一有意偏离）只在其真源
> `docs/web-document-metadata-panel.md` 登记，本矩阵不复抄，避免第二真源。

**§14.2 UI parity 2 偏差登记（`desktop-re/bases-ui-parity-2`，2026-10-21）**

业主 2026-10-21 两张截图（筛选弹层高级模式 / 属性弹层）指「UI 看起来粗糙，不像复刻桌面端」后，本刀按 asar 1.14.4
静态读对齐了 Bases 两个弹层。**读法**：引用一律 `文件@字节偏移` + 唯一片段（不用行号）；`app.css` 668,223 B、`app.js` 3,942,126 B、
`i18n.js` 132,996 B，取自 `scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4/`。**五条登记**如下（U5 已于 2026-10-21 由刀 `desktop-re/bases-builtin-names` 闭环，其余四条仍为偏差），其余项按桌面改（见 HANDOFF-UI-PARITY-2.md 逐条读数）。

**第 2 条（属性名）以协调席 BRIEF-DELTA 为准**：`properties.<key>.displayName` 是作者的声明，**对所有 kind 都优先**——
`app/src/base-query.js` 的 `columnLabel()` 原先只对公式列读 `displayName`，非公式列直接吐 key 尾巴（`file.mtime` → `mtime`），
这才是业主截图里出现 `mtime`/`ctime`/`size` 的根因（业主自己的 `.base` 已声明 `file.mtime: {displayName: 编辑时间}` 等）。
**声明优先（`.30` 与 `desktop-re/bases-ui-parity-2` 的 BRIEF-DELTA 共同确立）**在本 head 仍成立；未声明时**不再回退 key 尾巴**：桌面内置名表已按 U5 引入（见下表 U5，`desktop-re/bases-builtin-names`，2026-10-21 闭环）。

| # | 项 | 桌面 asar 事实 | 本项目行为 | 理由 |
| --- | --- | --- | --- | --- |
| U1 | 筛选弹层宽度 | `--bases-filter-menu-width: 520px`（`app.css@57465`），由 `.bases-toolbar-menu.bases-toolbar-filter-menu{width:var(--bases-filter-menu-width)}` 应用（`app.css@455631`，同块另有 `min-width:220px;max-width:100vw`） | **已采纳桌面宽度**（`desktop-re/bases-css-port-impl`）：`:where(.base-panel[data-base-panel="filter"]){width:var(--bases-filter-menu-width,520px)}`，零特异性，窄档仍归样式表 | 上一条「保持 320px」的**机制已消失**：弹层现在是桌面 `.menu` 盒（`position:fixed`，`styles.js`），不再被 `overflow:hidden` 外壳裁切，`panel-position.js` 按锚点右对齐并收进文档列（`anchor.right - width`，列内放不下则退回视口）。实读（1024 档：弹层未越过窗口右缘、自身无溢出）与改前/改后截图在 lane 根 `evidence/`。旧读数（`worktrees/desktop-re/bases-1024-stacking/evidence/readings.json`）仍是那条旧判据的历史证据。 |
| U2 | `清除筛选` | 桌面筛选菜单**无此动作**（清理由每条件的 `plugins.bases.tooltip-remove-filter` 承担） | 保留（行为契约，既有测试 `web-bases-popovers.test.js` 断言其存在与效果） | 删掉即功能回归；本刀只把它从「等宽撑满」改为桌面形态的整行动作行（`.bases-toolbar-menu-actions{display:flex;flex-direction:column;padding:var(--size-4-1)}`，`app.css@459374`）。 |
| U3 | 公式列文本 `ƒ ` 前缀 | 桌面表头只加 `mod-formula` 类 + 一个 icon 元素（`app.js@3222931`：`r.toggleClass("mod-formula","formula"===a)`、`i.iconEl=c.createDiv({cls:"bases-table-header-icon"})`）；`app.js` 里 `ƒ`（U+0192）**只**出现在数学实体表与 CodeMirror completion 图标，Bases 面 0 处 | 表头/卡片/看板标签仍是文本 `ƒ <名字>`（`<名字>` = 作者声明的 `displayName`，已生效；见 §14.2 第 2 条） | **本刀不动**（协调席 BRIEF-DELTA 第 2 条：该斜体 `f` 是本仓公式列徽标、有意为之）；若要换成桌面式 icon 元素，需改 `web-bases-formula-ui.test.js:96/117` 与 `web-bases-kanban.test.js:135` 三条断言 ⇒ 待裁定。 |
| U5 | 未声明时的**内置属性显示名** | 桌面**有**内置名表 `o$`（`app.js` **@2351488**，14 个 `file.*` 键：`file.file / name / basename / fullname / path / folder / ext / ctime / mtime / size / links / backlinks / embeds / tags`，值取自 i18n `label-file-prop-*`（en `modified time` 在 `i18n.js@115390`；zh 逐键见下）。`getDisplayName()` 的优先级是 **声明 → 内置名表 → 属性名**（`app.js@2352471`：`this.displayName?this.displayName:Object.hasOwn(o$,this.propertyId)?o$[this.propertyId]():UQ(this.propertyId).name`），**无 kind 分支**。**注意 `编辑时间` 不是桌面内置名**，那是业主自己 `.base` 里的 `displayName` 声明值（见 `BRIEF-DELTA`），不得混用 | **已闭环（2026-10-21，刀 `desktop-re/bases-builtin-names`）**：本项目**也有一份**同一张表，唯一副本在 `app/src/base-builtin-names.js`（14 键逐条抄 `i18n/zh.txt`，来源按 `i18n/mapping.txt` 行号标在表内：`file.file`=2334、`name`=2335、`basename`=2336、`fullname`=2337、`path`=2338、`folder`=2339、`ext`=2340、`ctime`=2341、`mtime`=2342、`size`=2343、`links`=2345、`backlinks`=2344、`embeds`=2346、`tags`=2347；两文件逐行对齐）。`columnLabel()` 的优先级改为 **内置名表 → key 尾巴**（**只有 formula 列**用 `properties.<key>.displayName`；2026-10-24 `desktop-re/column-label-surfaces` 按业主 01/04 表头更正 `.30`/`bases-ui-parity-2` 的「所有 kind 声明优先」，见 §14.10）（`src/base-query.js`）；`panel-chrome.js` 的 stale-key 分支（`columnOptions()`）从 `label: key` 改为复用同一份表（它是唯一需要客户端表的路径：stale key 按定义不在服务端返回的 `columns` 里）。自定义属性（非 `file.*`）仍回退 key 尾巴（`status` → `status`） | 上一 head（`.30`）把此处登记为**有意偏差**，回退 key 尾巴（`file.mtime` → `mtime`、`file.size` → `size`）；本刀按桌面 `o$` 补齐回退表后偏差消失。**可核描述**：桌面 `o$` 显式列举 14 键 + `getDisplayName()` 无 kind 分支（`app.js@2351488` / `@2352471`，两个偏移都能静态复读）；本项目同 14 键同顺序（`links` 在 `backlinks` 前，与 `o$` 一致），值逐条对齐 `zh.txt` 同行。测试 `app/test/web-bases-builtin-names.test.js` 把三个面（表头 / 属性弹层 / 筛选·排序下拉）钉在同一标签上，并把表本身钉在桌面 14 键上；负控：删掉表里 `file.mtime` 那行、或把它的值改错，三面断言均变红。预算账（**一处账目**）见 `app/scripts/web-firstload-baseline.json` `notes[0]` |
| U4 | 公式失败文案 | 桌面走 i18n `plugins.bases.msg-error-*`（zh：`无法解析数据库文件：` 等） | `controller.js` 的 `FORMULA_MESSAGES` 仍为英文（`Invalid function in formula.` 等） | 同上：`web-bases-formula-ui.test.js:151` 逐字钉住英文；其余**所有**内部英文（HTTP 状态映射、`closed`/`network`/`superseded` 等约 20 条、stale 横幅）本刀已改中文并把 `code`/原始英文留在节点上（`data-error-code` / `data-catalog-stale-code` / `title`）。 |

**§14.3 弹层外壳 CSS 移植登记（`desktop-re/bases-css-port-impl`，2026-10-22，基线 `.33` `15556114`）**

桌面事实来源：recon 席 `worktrees/desktop-re/bases-css-port/{port-plan.md,dom-map.md,desktop-rules.json,var-deps.json}`。下表只写**状态与理由**，逐条读数（含改前/改后）只在 lane 根 `evidence/{before,after}/readings.json`，预算账只在 `app/scripts/web-firstload-baseline.json` 的 `notes[0]`。

| # | 项 | 状态 | 理由 |
| --- | --- | --- | --- |
| C1 | 面板外壳 = 桌面 `.menu` + `.bases-toolbar-menu` | **已采纳**（`position:fixed` / `--layer-popover` / `min-width:220px` / `max-width:100vw` / `max-height:100%` / `padding:0` / `overflow:hidden` / `--background-secondary` / `--menu-radius` / `--menu-shadow` / `--menu-border-color`，`--input-height:28px`） | 我们自己的 `background-primary` / `0 12px 32px` / `padding:8px` / `min(320px,…)` 作废。桌面盒子是 `div.menu.bases-toolbar-menu`（`app.js@2368459`），外壳来自通用 `.menu`（`app.css@282803`）。app.css **未声明**的两条链（`--menu-border-width` → `--border-width`、`--menu-border-color` → `--background-modifier-border-hover`）以桌面自己的解析值为 `var()` 兜底；现在消费的整套 `--menu-*` / `--layer-popover` / `--shadow-s` / `--icon-s` 由本仓 `app.css` 按桌面原文声明（`--shadow-s` 浅/深一对随主题切换，边框落 `--color-base-35`），主题改 `--menu-*` 能整体生效。桌面 `.bases-toolbar-menu{--input-height:28px}` **不抄**（本面控件吃 app 自己的 30px `.select-control` 皮肤，抄了没人消费）；`--menu-backdrop-filter`（桌面为 `none`）与 `corner-shape` 未抄（无 token、无效果），`-webkit-app-region` 不抄（plan 明确排除）。FIX-1 逐条读数：lane `evidence/fix1/readings.json`（真 Chromium，浅/深两模式）。 |
| C2 | 页头 + 返回（桌面 `pageStack`） | **已采纳为「同面板分页」**：栈深 > 1 才出现页头与返回按钮（桌面 `app.js@2371419`），根页无页头；返回 = 弹栈并把焦点交回上一页的动作按钮 | 本仓没有桌面的属性子页/子菜单（`capabilities.grouping === false`、无公式写入面），所以「真正的下钻页」只能是**同一面板里的另一页菜单**；不画没有目标的返回按钮（禁用死控件）。这同时把业主截图 3 的机制（两个浮层重叠、内层越界）变成不可能：任何时刻只有一个 `[data-base-panel]` 节点。逐条读数：lane `evidence/`。 |
| C3 | `.bases-toolbar-menu-item` 行几何 | **已采纳到属性弹层的行**（`padding:4px 4px` + `padding-inline-start:6px`、`border-radius:var(--radius-s)`、`gap:var(--size-4-2)`、`width:100%`） | 桌面只有**一个** menu-item 类；我们这一侧真正是「菜单项」的只有属性行的 `.base-panel-option`。`.base-panel-row`（排序/筛选/搜索/新建）在桌面属**表单行族** `.bases-toolbar-menu-form .input-row*` —— port-plan 自己把该族标为「要么整族移植，要么明确记为 not-ported」，所以它保留本面自己的 6px 节奏（`web-bases-panel-tokens.test.js` 的 ①⑤ 两条钉子仍在）。 |
| C4 | 区块与区块标题 | **部分采纳**：标题值取桌面 `.bases-toolbar-section-header`（`padding:8px 12px`、`font-weight:500`、`font-size:13px`、`color:var(--text-normal)`）；桌面 `.bases-toolbar-section` 包裹层的 `padding:2px` 映射到 `.base-panel > *{margin-inline:2px}` | 我们的 DOM 里 `.base-panel-section` **就是**标题行，没有独立的 section 包裹节点；桌面包裹层的 2px 内缩必须落在子元素上，否则外壳 `padding:0` 会让控件贴边。标题 `gap` 取桌面 `var(--size-4-1)` = 4px（FIX-1 F4：桌面 `app.css@455960` 赢过本面自造的 6px 节奏，钉子只在该选择器上让位，`.base-panel-row`/`.base-panel-footer` 仍是 6px）。 |
| C5 | 搜索框皮肤 | **已采纳**：输入本身 `border:0; box-shadow:none; background-color:transparent; border-radius:0`，外框下沿 1px hairline + `padding-bottom:2px` + `margin-top:4px`（桌面 `.search-input-container` / `input[type=search]`，`app.css@453150`/`@453414`） | 桌面搜索框不是控件盒而是「一条底线」。 |
| C6 | 桌面 `.bases-toolbar-menu-container{max-width:300px}` | **未移植** | 该选择器作用在**内层容器**上，而我们的 DOM 没有这一层（`dom-map.md` 标 ABSENT）；桌面外层 `.bases-toolbar-menu` 自己说 `max-width:100vw`，本面按外层采纳。port-plan P5 第 3 条也要求「先确认是哪个盒子」。 |
| C7 | `grouping / 分组依据 / 输入并开始搜索` 的浮第二层 | **不复现、也不在本次修复范围** | `origin/main`（`.33` 树）上无法产出那个状态：`分组依据` 不渲染（DTO `capabilities.grouping === false`）、字符串「输入并开始搜索」全仓 0 命中、`openPanel` 标量且与溢出菜单互斥（`dom-map.md` §7.1，`gaps.md`）。C2 已把「两个浮层」这条路彻底断掉；若业主截图来自另一棵树，需要那张树的 head 才能复现。 |

**预算**：本刀为**净增**，§5.9 **已签**（协调席，签字依据为复核席独立测量 + 本刀的注释回收实验）。**数字只在 `app/scripts/web-firstload-baseline.json` 的 `notes[0]`**（含逐资产净额与回收审计），本节不复述；逐条读数在 lane 根 `evidence/fix1/readings.json` 与 `HANDOFF-CSS-PORT.md` §FIX-1 / §RECLAIM-1。已知偏差（登记、不在本刀修）：F5 `.base-panel > *{margin-inline:2px}` 未按档限定；F12 `user-select:none`（桌面 `.menu` 确是 `none`，但本面板含输入控件，可选择性代价由本刀承担）。


## 14.4 Bases 动作面板 = 桌面 `.menu` 组件（`app.css` 源码里只有一行指针，真源在这里）

**状态**：Web 的 Bases 动作面板（筛选 / 属性 / 排序 / 分组 / 新建）在 2026-10-22 起**按桌面声明移植**，不再是照截图手画。
此前它是一套自造类名与自造尺寸（`padding:8px`、`width:min(320px,…)`、`background-primary`、`box-shadow:0 12px 32px`），
与桌面 `app.css` 的 **115 个 `.bases-*` 选择器** 交集为零 —— 这就是「UI 都没对齐」的机制性原因。

**桌面事实（全部为 `obsidian-1.14.4.asar` 的 `app.css`，668,223 B，sha256 `866e50ac…d7ba`，按字节偏移读）**

| 项 | 桌面位置 | 内容 |
| --- | --- | --- |
| 外壳 | `.menu` `@282803` | `display:flex;flex-direction:column;border:var(--menu-border-width) solid var(--menu-border-color);background-color:var(--menu-background);overflow:hidden;padding:0;border-radius:var(--menu-radius);box-shadow:var(--menu-shadow);max-height:100%;position:fixed;z-index:var(--layer-menu);user-select:none` |
| Bases 附加类 | `.bases-toolbar-menu` `@455439` | `--input-height:28px; z-index:var(--layer-popover); min-width:220px; max-width:100vw`（同特异性后写，`z-index` 取 **30**） |
| 筛选菜单宽 | `--bases-filter-menu-width` `@57465` + 应用 `@455631` | **520px** |
| 菜单行 | `.bases-toolbar-menu-item` `@466792` | `padding:var(--size-2-2) var(--size-2-2); padding-inline-start:var(--size-2-3); border-radius:var(--radius-s); gap:var(--size-4-2)` |
| 页头 | `@449758` / `@449844` / `@450681` | `padding:var(--size-4-1)`；标题/返回 `flex-grow:1; font-weight:var(--font-medium); font-size:var(--font-ui-small); padding:var(--size-2-2); gap:var(--size-4-1); border-radius:var(--radius-s)`；关闭控件 `color:var(--text-muted)` |
| 区块 | `@455722` / `@455797` / `@455939` | `padding:var(--size-2-1)`；`section:not(:last-child)` 1px 下边框；标题 `padding:var(--size-4-2) var(--size-4-3)`、`gap:var(--size-4-1)`、`--font-medium` / `--font-ui-small` |

**token 链（我们照抄，不发明）**

```
--menu-border-width  = var(--border-width) = 1px                      (@78483 → @61411)
--menu-border-color  = var(--background-modifier-border-hover)
                     = var(--color-base-35) = #dadada(浅) / #3f3f3f(深)  (@78419 → @96170 → 本仓 `:root, .theme-light` 第 22 行 / `.theme-dark` 第 146 行)
--menu-background    = var(--background-secondary)                     (@78369)
--menu-radius        = var(--radius-m) = 8px                           (@78291 → @83110)
--menu-shadow        = var(--shadow-s)                                 (@78257)
--layer-menu = 65 / --layer-popover = 30                               (@74475 / @74387；Bases 菜单取 30)
--shadow-s 浅 @99162 / 深 @102540                                      明暗**两值**，必须成对；只抄一值就是把深色阴影画在浅色面板上
                                                                     浅 = `0px 1px 2px rgba(0,0,0,.028), 0px 3.4px 6.7px rgba(0,0,0,.042), 0px 15px 30px rgba(0,0,0,.07)`
                                                                     深 = `0px 1px 2px rgba(0,0,0,.121), 0px 3.4px 6.7px rgba(0,0,0,.179), 0px 15px 30px rgba(0,0,0,.3)`
--icon-s = 16px                                                        (@72362，关闭控件字形)
```

**本仓声明位置**：`app/src/app/assets/app.css`（`--shadow-s` 明暗两值落在 token 兜底层，其余四条与 `--radius-m` / `--size-4-*` 同层）。
本仓**不声明** `--border-width` 与 `--background-modifier-border-hover` 这两条 producer，因此链上保留桌面解析值作 `var()` 兜底（`1px` / `var(--color-base-35)`），主题仍可覆盖。

**有意偏离（登记，不读作 parity）**

| # | 项 | 桌面 | 本仓 | 理由 |
| --- | --- | --- | --- | --- |
| U1 | 根页页头 | 只有 `pageStack.length > 1`（嵌套页）才有页头与返回（`app.js@2371419`） | 同桌面：根页无页头；`<=480px` 覆盖层恒有页头 | 手机没有"外面"可点 |
| U2 | `.base-panel-row` | 属**表单行族**（`.bases-toolbar-menu-form .input-row*`），不是 menu-item | **整族未移植**（not-ported），只对 `.base-panel-option` 套 menu-item 几何 | 半抄 padding 比不抄更糟 |
| U3 | 内层 `.bases-toolbar-menu-container{max-width:300px}` | 属性/搜索面板内层容器 | 本 DOM 无该层（ABSENT），外层 `max-width:100vw` | 无对应节点，硬造一个只为宽度会牵动命中与滚动 |
| U4 | 阴影/边框的 `var()` 兜底 | 桌面由主题提供 producer | 兜底写桌面解析值 | 本仓无 producer；写成字面量则不随主题变 |
| U5 | 面板内非输入文本不可选 | `.menu` 为 `user-select:none` | 同桌面；输入控件处 `user-select:text` | 面板含输入控件，代价由本刀承担 |
| U6 | `<=720` 档 | 桌面无此断点 | 保留 `.33` 的"交还样式表"（`position:absolute` / `z-index:7`） | 该档是我们自己的窄屏形态。**注意：采纳桌面外壳后该档不再逐项等于 `.33`**：背景 `--background-primary`→`--background-secondary`、阴影由单层 `0 12px 32px` 变三层 `--shadow-s`、新增 `user-select:none`（输入控件处 `user-select:text`）—— 这是 P0 的应有结果，不是回归 |
| U7 | `.bases-toolbar-menu-action-icon` | **有规则无建点**：`app.css@469535` 有 `.bases-toolbar-menu-item .bases-toolbar-menu-action-icon{color;display;align-items;justify-content}`，而 `app.js` 里该串**计数 0**（真实建的是 `bases-toolbar-menu-item-icon`，计数 4） | **CSS-only 登记，不贴到我们的节点上**（复核 §3：贴类＝造结构）。尾随动作槽的可寻址类是我们自己的 `base-panel-action-icon` ＋桌面真建点 `bases-toolbar-menu-item-icon` | 桌面自己不建这个类，我们也不造节点充数；一个字面量类别名换不来任何可见差异 |
| U8 | 区块标题 `.flair` 的 0 值 | `e.setText(String(t)),e.toggle(t>0)`（`app.js@2480449`）：计 0 ⇒ 节点建了但**不绘制** | 同语义：`hidden` 属性（节点留在树里可寻址，`display:none`，不进 header 的可见文本） | `flair` 是计数徽标，画个 `0` 是复制错了半句控制流 |

> FIX-R1（2026-10-23，分支 `feat/bases-menu-content`，head `b379af82` 族）：复核 NO-GO 绑 `061d5b01` 的三条阻断
> （U7 贴类、U8 的 0 值、预算与证据）与两条顺带项（G5 谓词空真、G10 登记）已修，**逐条改法 / 真 Chromium 读数 / 负控**
> 与**预算净额 + 四条回收实测**在 lane 根 `HANDOFF-MENU-CONTENT.md` §FIX-R1；本表只登记状态与口径，不复述数字。
> 首屏棘轮在本刀仍未闭合（`firstScreen 126253 > 125426`、`issue414 819375 > 818548`，全在 `app.js`）——基线未改、不自签，等协调席签字。

### 14.5 lane `desktop-re/bases-menu-surface`（P5 表面：筛选面板读起来像菜单，不像表单）

基座 `97a55209`（分支 `feat/bases-menu-surface`）。四项验收（动作行 `.menu-item` 化 / 连接词紧凑行内 /
`</>` 归位 / 区块标题）的桌面偏移、逐项 computed 读数与暗色截图对比在 lane 根
`HANDOFF-MENU-SURFACE.md`；**本表只登记状态与理由**。

| # | 项 | 桌面 | 本仓 | 理由 |
| --- | --- | --- | --- | --- |
| U9 | 筛选面板的连接词行 | `div.filter-group > div.filter-group-header > select.conjunction.dropdown`（`app.js@2464626`/`@2464745`）；`@471459` 让 header 成为 ROW；控件皮肤 `@471630`（`background-color:transparent;box-shadow:none;text-align:start;font-size:var(--font-ui-small)`）+ hover `@471841` | **同结构、同皮肤**：`.base-panel-group-header`（桌面类名 `filter-group-header` 未借用）+ `select.base-panel-select.conjunction.dropdown`；可见盒子是生成的 `.select-control`，故皮肤写在**该 wrapper** 上（`:not()` 无、`:focus-within` 代 `:focus-visible`） | 桌面那一族 `.input-*` 未移植（`gaps.md` G11），本刀只取筛选面板真正用到的子集；`--size-2-1`/`--size-2-2` 本层未声明，写桌面解析值 `2px`/`4px` |
| U10 | `</>` 高级模式开关的落点 | **条件行的动作区**：`app.js@2468679` `l.createDiv("filter-row-actions")` → `@2468775` `createEl("button",{cls:"clickable-icon filer-expression-mode-toggle"})`；`@474298` `.filter-expression .filter-row-actions{display:flex;padding:var(--size-2-1);margin-inline-start:auto;height:var(--input-height)}` | 落在**面板级动作行**（`div.base-panel-actions`，桌面 `filter-group-actions` 形状），且**不带** `margin-inline-start:auto` | 桌面的开关把**一行**切进公式编辑器；本 build 的 raw 表达式模式是**面板级**的（`data-filter-advanced-mode` 文本域），因此不可能挂在某个条件行里。本行动作行只有添加动作、没有填满行的输入，保留 `auto` 会把它钉在面板右缘（业主截图里的"漏出来的控件"） |
| U11 | `添加筛选器组` 动作 | `filter-group-actions` 里的第二个 `+`（`app.js@2465689`），建可继续编辑的嵌套 `.filter-group` | **不渲染**（not-ported） | 本面板的构建器只有一层（`panel-filter.js` 的 `leavesOf`/`withConjunction` 只读一层叶子列表），且 `capabilities.grouping` 在 `app/src/app/base-route.js:187` 硬编码 `false` —— 画出来会是一个点不动的假控件。既有断言（`web-bases-popovers.test.js` 的"不存在该字符串"）**不放宽** |
| U12 | `所有视图` 区块（桌面筛选面板的第二个区块，业主截图 01 有 `> 所有视图 2`） | 列出 Base 文件级 `filters`，计数进 `.flair`（`app.js@2479449`/`@2480093`）；区块是 `bases-toolbar-section`（`app.js@2479077`），条件盒是 `.filter-group`（列 flex `@470677`）`> .filter-group-statements`（`@470700`），带边框的是嵌套 `.filter-group` 体（`@470985`），行是 `.filter-row`（`@472153`，属性格外层 `@472522`） | **已渲染**（lane `desktop-re/all-views-section`，2026-10-23）：新增 **additive** DTO 字段 `filters:{base,view}`（见 §14.6）+ 客户端 `所有视图` 区块与两个真实 `.flair`；声明层条件以**只读**行渲染（无控件、无逐行动作） | 见 §14.6：计数 = 该层**叶**条件数（含嵌套组叶），与 `.flair` 的 `toggle(t>0)` 语义一致；DTO 缺 `filters` 时退回 pre-U12 形状（不造假数） |
| U13 | `.clickable-icon` 的圆角 token | `@258658` `border-radius:var(--clickable-icon-radius)` | `var(--radius-s)`（4px） | 本层不声明 `--clickable-icon-radius`；已在上一刀登记，本刀复核仍成立（`padding:var(--size-2-2) var(--size-2-3)` = 桌面解析值 `4px 6px` 已按字面写） |

**本刀同时修掉的两个上一任缺陷**（都在 `styles.js`，见 HANDOFF §2）：两条规则被**逐字重复输出**
（`.base-panel-actions .base-panel-mode:hover` 与 `…[data-filter-mode="advanced"]`，各两遍）；以及
**两条本层未声明的 token 被当作 `var()` 写**（`padding-top:var(--size-2-2)`、`padding-bottom:var(--size-2-1)`），
后者在计算值阶段失效 → 实际 `0px`，与桌面 `4px`/`2px` 不符；现按本表 U4 的既有口径写桌面解析值。

## 14.6 lane `desktop-re/all-views-section`（U12：`所有视图` 区块 + 条件行 + DTO 暴露 filter 结构）

基座 `56cdbf73`（`main`，= PR #665 合并点）。逐项证据（桌面偏移 → 改动 → 截图对比 → 读数 →
预算净额 → `audit:` 段）在 lane 根 `HANDOFF-ALL-VIEWS.md`；**这里只登记契约与状态**。

### 14.6.1 Web DTO 契约变更（**只增**，`GET /api/web/v1/base`）

新增一个**始终存在**的顶层字段（`app/src/app/base-route.js` `normalizeFilterSummary`）：

```
filters: {
  base: null | { conjunction: "and"|"or"|"not"|null,
                 count: <该层叶条件数>,
                 conditions: [ { property, operator, value, expression } ] },
  view: null | { ...同上 },
}
```

- `null` = **该层没有声明** `filters:`；声明了但为空组（如 `{or: []}`）= `{conjunction:"or", count:0, conditions:[]}`。
- `count` 是**叶**条件数（嵌套组递归展开），就是桌面 `.flair` 的数字（`app.js@2480449` `n=function(e){return e?e instanceof t$?e.filters.length:1:0}` +
  `i=function(e,t){e.setText(String(t)),e.toggle(t>0)}` @2480472，调用 @2480522）。
  **[未证实/偏差] 嵌套组的差异**：桌面把顶层的**直接条目**计数（一个嵌套组算 1 个条目，且它渲染成一个嵌套子框），
  本刀把嵌套组展平为叶行，因此 flair = 可见行数 = 叶数；业主锚点（两层都是平铺）两口径相等，
  差异只在嵌套组出现时可见（本 builder 也造不出嵌套组，U11 not-ported）。
- `conditions[]` 的 `property`/`operator`/`value` 只在**能读出来**时给：`.base` 侧走既有表达式解析器
  （`base-expression.js` `parseBaseExpression`），仅 `reference <cmp> literal` 成立时映射为 `{property, operator, value}`
  （`==`→`is` / `!=`→`is-not` / `>`→`gt` / `<`→`lt` / `>=`→`gte` / `<=`→`lte`，全部取自 `BASE_FILTER_OPERATORS`）；
  其余（如 `file.inFolder("…")`、逻辑链）三项为 `null`，`expression` 带作者原文（上限 240 字符）。
- 语义不变、权限不变：`capabilities` 仍是 `{editable:false, grouping:false, aggregation:false}`，`supportedSubset` 判据未动；
  老客户端忽略该字段即得到逐字节相同的行为。
- 值来源：`app/src/base-filter-summary.js`（新模块，复用 `assertBaseFilterTree` 与既有常量，**不新写解析器**），
  由 `base-snapshot-adapter.js` 挂到 snapshot 上；tree 形状已在 `compileBaseView` 校验过一遍。

### 14.6.2 状态登记

| # | 项 | 桌面 | 本仓 | 状态 |
| --- | --- | --- | --- | --- |
| U12 | `所有视图` 区块 + `.flair` 真数 | `app.js@2479449`（section 顺序里 globalFilters 在前）+ `@2480093`（计数） | `所有视图`（`data-filter-group="base"`）在 `当前视图` 之前；两个 flair 都取**该层叶数 + 本 surface 自己的 URL 覆盖叶数** | **ported**。`所有视图` 只在 DTO 带 `filters` 时出现（老服务端 ⇒ 退回 pre-U12，不造假数） |
| U12-a | `所有视图` 的连接词选择器 | `select.conjunction.dropdown`（`app.js@2464745`） | **不渲染**（read-only） | not-ported：那是**写**控件，本刀只读呈现；要编辑得走 `PATCH /api/web/v1/base` |
| U12-f | 嵌套组的计数口径 | 顶层**直接条目**数（`app.js@2480449`：组算 1 个条目，并渲染为嵌套子框） | 展平为**叶**行，flair = 行数 | **deviation**（[未证实] 桌面嵌套渲染未逐像素对比）：业主锚点两层均平铺，两口径相等；带嵌套组的文档下两者不等，已在 §14.6.1 登记 |
| U12-b | 条件行的逐行动作（`</>` / 垃圾桶） | `filter-row-actions`（`app.js@2468679`，`@474298`） | **不渲染**：声明层行不带任何控件（`select/input/textarea/button` = 0） | not-ported：删/改一条**声明**的筛选器＝改 `.base` 文件，本刀不做写回。`</>` 仍按 U10 留在面板级动作行（本刀未挪） |
| U12-c | 带边框盒的归属 | 边框在**嵌套** `.filter-group` 体上（`app.css@470985`） | 每个区块的 statements 盒（`data-filter-statements`）都画该边框 | **deviation**：业主截图 01 看到的是一段带框条件区，本刀按「每区块一个框」落地；面板高度因此偏高（实测 244 vs 桌面判据 191），记为待裁定项 |
| U12-d | `</>` 图标尺寸 | `.clickable-icon` 在菜单行里 `--icon-s` = 16px | 实测 **13×13**（`.base-panel-icon` 的 `width/height:13px`） | **未定案**（[未证实]）：本刀只量到 13×13；改它会动 U10 已裁定的控件皮肤，等协调席裁 |
| U12-e | 复核指出的 4 处引用精度 | — | `panel-chrome.js` / `panel-filter.js` / `styles.js` 的 `@284660`、`@2480093`、`@2464626`/`@2464745`、`@2479077` 已按复核结论订正 | 见 HANDOFF §4（值相同、选择器不同的那条按复核结论标注） |


## 14.7 lane `desktop-re/panel-properties`（属性面板 = 桌面 26 行菜单）

基座 `e58913d6`（`origin/main`）。逐项证据在 lane 根 `HANDOFF-PROPERTIES.md`；这里只登记契约与状态。

### 14.7.1 Web DTO 契约变更（**只增**，`GET /api/web/v1/base`）

新增一个**始终存在**的顶层字段（`app/src/app/base-route.js` → `app/src/base-property-catalog.js`）：

```
propertyCatalog: [
  { key: "formula.note", label: "项目", kind: "formula", checked: true,  source: "column"   },
  { key: "archived",     label: "archived", kind: "boolean", checked: false, source: "observed" },
  …
]
```

- `checked` = 该 key 是否在本视图的 `order` 里（客户端仍以**本地隐藏集**决定勾选框，见 §14.7.2）；
  已勾行按 `order` 顺序在前，未勾行按 key 字典序在后（业主截图 02 的 23 行未勾项就是 key 字典序）。
- `kind`：`formula`（视图列）/ `property`（视图列里的普通属性）/ `builtin`（`file.*` 内置 14 项）/
  `text|number|boolean|date|list|object`（**由目录里实际出现的值推断**，不是声明类型）。**注意**：`kind` 是推断值，但客户端**会**用它选行内类型图标 —— 这属于**已登记的偏离**（见 §14.7.2 P7-h），不是“不画图标”；推断与声明不同时图标可能与桌面相反（`next_action`、值全空的属性）。
- `source` 只作溯源：`column`（视图列）/ `declared`（`.base` 的 `properties:`）/ `observed`（目录里出现的 frontmatter 键）/
  `builtin`（内置表）。
- 三个数据源都是既有真源，没有第二套目录：① `BASE_BUILTIN_PROPERTY_NAMES`（`src/base-builtin-names.js`，
  桌面 `o$` 表 `app.js@2351488`）；② `.base` 自身的 `properties:` + 已解析列 `label`（displayName 优先级同 `columnLabel`）；
  ③ 该 `.base` **所在目录**（递归）里记录的真实 frontmatter —— 记录集就是本次查询已经加载的那一批
  （`base-record-source.js` `loadRecords`），**没有额外 IO**，也没有第二次扫描。
- 语义不变、权限不变：`capabilities`、`supportedSubset`、错误码与游标身份全部未动；老客户端忽略该字段即逐字节相同。
- 形状断言：`app/test/base-property-catalog.test.js`（五项字段、唯一性、字典序、目录边界、坏文档降级）。

### 14.7.1a 本刀**未静默**的三条口径（复核 `rev-properties-2` 要求登记）

1. **属性目录的取样范围**：目录 = 内置 `file.*`（13，排除 `file.file`）+ `.base` 的 `properties:` + **命中当前视图筛选的记录**的 frontmatter 键。
   桌面机制与此一致（`app.js@2550063 getProperties()` = FILE_PROPERTIES ∪ 命中行 ∪ 查询公式，键取自 `@2548697` 的结果集）。
   **偏离**：`.base` 的 `properties:` 键我们**无条件**入册；桌面只在搜索框有输入时才并入 `metadataTypeManager.getAllProperties()`。
   影响：业主这份 `.base` 没有孤儿键（即声明了但任何记录都不带的键），所以当前不显形。
2. **行序**：已勾（视图 `order`）→ 内置 `file.*` 按 key → 作者键按 key。桌面由 `Intl.Collator`（`@1307315`）比较**完整标识符**，
   因此 `file.*` 天然排在 `note.*` 之前 —— 是**结构性**保证，不是我们另加的"分组"。
3. **标签**：只有**公式行**用 `.base` 的 displayName（`项目`）；note 行显示**原始键**（`status`/`updated`），内置行显示内置名。
   依据：业主 02 截图逐行如此（`02-properties-open.png`：`项目` y≈228 / `status` y≈276 / `updated` y≈324）。
   **2026-10-23 更正（lane `desktop-re/property-label-surfaces`）**：本节原文还写了「表格表头显示 `状态/更新` 是**表头**的行为」——
   这句话**与业主截图相反**：01 的表头读 `status`（`01-filter-open.png`，原图 2452x800，表头 y≈162，`status` x≈862）、
   04 的表头读 `updated`（`04-sort-popover.png`，1298x552，y≈168，x≈310-405），而同一 `.base`
   （`_Workspace/40-Projects/Projects.base`）确实声明了 `status:{displayName:状态}` / `updated:{displayName:更新}`。
   即：**表头是否消费 note 属性的 displayName 尚未证实**（我们仍按 `column.label` = displayName 优先画表头，本刀不改）。
   分面契约（选择器 vs 表头）与未证实项见 §14.9。

### 14.7.2 状态登记

| # | 项 | 桌面 | 本仓 | 状态 |
| --- | --- | --- | --- | --- |
| P7-a | 属性菜单行集 | 全目录（业主 26 行 = 3 已勾 + 23 未勾） | 全 `propertyCatalog`（同一 Base 实测 74 行：目录子树里出现的键更多） | **ported**；行数差异是**取样范围**差异（本仓按 `.base` 目录递归），登记为 [未证实] 待与桌面逐键对账 |
| P7-b | 区块头 `已显示` | 无 | 已删除（`[data-prop-section]` = 0） | **ported** |
| P7-c | 每行右侧 `›` | `app.css@469509` 槽位 | `.base-panel-action-icon` + `chevron-right`，`aria-hidden`（子菜单未移植） | **ported（仅形状）** |
| P7-d | 未勾行暗色 | `app.css@467406`（`mod-hidden` → `--text-faint`） | 同一类名 → 实测 `rgb(93,109,126)` vs 已勾 `rgb(218,218,218)` | **ported** |
| P7-e | 行内公式原文 `ƒ …` | 无（只有 `Edit formula...` 子菜单） | **已删除**：`[data-formula-source]` = 0，行文本 = displayName（`项目`） | **ported** |
| P7-f | 底部 `全部隐藏` | `bases-toolbar-menu-actions`（`app.css@459374`，`padding:4px`）+ `.menu-item` 皮肤（`@283971`） | 复用 `.base-panel-actions .base-panel-button`；实测 `border-width:0`、`padding:4px 8px`、footer `border-top:0` | **ported** |
| P7-g | `添加公式` | 有 | **不画**（无公式写入路由） | not-ported（`添加公式` 字符串仍不存在，既有断言未放宽） |
| P7-h | 属性类型图标（`☰`/`📅`/`ⓘ`/`ƒ`） | 三分支（1.14.4 `app.js@2381738`）：内置 `file.*` → info（ⓘ）、公式 → `lucide-square-function`、note 属性 → **声明类型**的图标（`metadataTypeManager.getTypeInfo(...).expected.icon`） | **已画**，但按**推断 kind**（`propertyIconName()`）：内置→`circle-info`、公式→`code`、date→`calendar`、text→`text`、list→`tag`、number/object/boolean→`text`；未命中→`circle-info`（兜底**指向存在**的符号） | **registered deviation**（不是 not-ported，也不是造假）：本仓没有声明类型，只能由命中记录的值推断。两处已知代价：①值全空的属性保留文本图标；②`next_action`（我们 📅 / 桌面 ☰）与 `created` 可能与桌面相反。sprite 无 `square-function`，公式用 `code`（**不发明 path**）。复核依据：`rev-properties-2/REVIEW.md` + `work/checkbox-pixels.json` |
| P7-i | 行距 / 面板宽 | 桌面读数 ≈25.75 CSS / 220 CSS | 实测 **27.5 CSS** / **234.6 CSS** | **deviation**：行距差额 = 行盒（13px × `--line-height-normal:1.5` = 19.5 + 8 内边距），面板宽差额 = 最长未勾属性名把 shrink-to-fit 撑到 220 下限之上；两项都标 [未证实] |

## 14.8 lane `desktop-re/panel-sort`（排序菜单 = 桌面「排序依据」页）

基座 `98264a1a`（`origin/main`）。逐项证据（偏移 → 改动 → 并排截图 → 读数 → 负控）在 lane 根
`HANDOFF-SORT.md`；这里只登记契约与状态。**基准 = 桌面 1.14.4**（本刀所有偏移都在
`scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4/` 上重量过，清单 D 段里那些 1.13.7 偏移已弃用）。

### 14.8.1 Web DTO 契约变更（**只增**，`GET /api/web/v1/base`）

新增一个**始终存在**的顶层字段（`app/src/app/base-route.js` → `base-snapshot-adapter.js` `summarizeBaseSort`）：

```
viewSort: [ { key: "updated", dir: "desc" } ]
```

- 语义：**选中视图**在 `.base` 里**声明**的 `views[].sort`，投影成与 URL 覆盖（`?sort=`）完全相同的形状
  （`[{key, dir}]`）。`key` 就是声明的 `property` 原文（即 `order`/列键词汇），`direction` 映射为 `asc`/`desc`；
  缺 `direction` 视同 `ASC`（与文档管线 `item.direction || "ASC"` 同一默认）。
- 为什么必须有：桌面排序页的行是**从视图配置读出来**的
  （`display()` 合并 `currentSort` 与 `loadSort(){ return queryController.getViewConfig()?.getSort() ?? [] }`，
  1.14.4 `app.js@2526324`/`@2527053`）；客户端此前拿不到声明，打开即空。
- 语义不变、权限不变：行顺序**本来就是**服务端按视图 `sort:` 排好的（`viewSort` 只是把同一事实投影出来），
  `capabilities`/`supportedSubset`/游标身份均未改；不带 URL 覆盖时请求仍不发送 `sort`，老客户端忽略该字段即逐字节相同。
- 无属性 / 重复属性 / 非字符串属性的条目直接丢弃（桌面一行一属性）；**不**在这里截断 4 级上限（那是编辑器约束）。
- 键集由 `test/web-base-route.test.js` 的 §8 冻结契约（已按既有先例加注 `viewSort`）与本 lane
  `test/web-bases-sort-seed.test.js` 双重钉住。

### 14.8.2 状态登记

| # | 项 | 桌面（1.14.4） | 本仓 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 打开带出声明 sort | `loadSort()` 读视图配置（`app.js@2527053`） | 菜单行 = URL 覆盖非空时用覆盖，否则用 `viewSort`；实测打开 **1 行** `updated` / `从新到旧` | **ported** |
| D2 | 行首拖拽把手 | `createDiv("grip-handle")` + `lucide-grip-vertical` 插在 `firstChild`（`app.js@2528519`），`cursor:grab`（`app.css@453866` 族） | 同一节点 + `grip-vertical` 精灵；**拖拽真实可用**（HTML5 drag → `onSort` 同一写路径），实测 `display:flex`/`cursor:grab`/16px | **ported**（键盘排序 not-ported：桌面也只有指针拖拽） |
| D3 | 一行一个外框两段 | `.base-toolbar-sort-item`（`app.css@461837`）+ `.combobox-button{radius:0;background:--background-modifier-form-field}`（`@462364`）+ `.bases-sort-direction{min-width:5.25em;border-left;padding-inline-start}`（`@458358`） | 同一形状：外框 `base-toolbar-sort-item`（实测 `display:flex`/`radius:4px`/bg=菜单底）、属性段 `--interactive-normal`、方向段 form-field + 1px 左分隔线 | **ported**（属性段标签遗留的「用 DTO `label`=displayName `更新`、业主图是原始键 `updated`」已由 §14.9 闭环：属性段现在读 `propertyPickerLabel`，即内置名 ?? 原始键，公式行才用 displayName） |
| D4 | 菜单内 `--input-height:28px` | `.bases-toolbar-menu{--input-height:28px}`（`app.css@455463`） | 声明在排序面板作用域，`.select-control` 用 `height:var(--input-height,30px)` 消费；实测两段均 28 | **ported**（filter/properties 菜单仍 30，等各自量） |
| D6 | `+ 添加排序` = 无边框菜单行 | 独立 `.bases-toolbar-section.bases-toolbar-menu-actions`（`app.js@2526713`）+ `C$` 行 `bases-toolbar-menu-item bases-toolbar-menu-action`（`app.js@2373586`） | 动作行是行区块的**兄弟** section（`section:not(:last-child)` 分割线由区块自己画），复用 `.base-panel-actions` 菜单行皮肤；实测 `border-width:0`/`border-style:none`/透明底 | **ported** |
| D7 | 面板宽 | 只写 `min-width:220px`；248.5 是内容撑开 | 实测 **228** CSS（属性段 14em 上限 + 方向段 5.25em）；**不硬编码宽度**（`web-bases-sort-seed` 有钉子） | 内容驱动，差额登记 [未证实] |
| D8 | 标题无计数徽标 | header 只有文案（`app.js@2526548`），`flairEl` 是工具栏 badge | 排序区块头不再传 `count`，实测无 `[data-section-count]` 节点、无数字 | **ported** |
| D9 | 方向文案按类型 | `getWidgetForIdent`（`app.js@2482225`）：date→从旧到新/从新到旧、number→0 → 1/1 → 0、其它→A → Z/Z → A（i18n.js@115815） | 同一映射；**date 两串由 `旧 → 新/新 → 旧` 改为桌面原文**；类型仍按当前页值样本推断（DTO 无声明类型） | **ported（文案）**；类型来源 = registered deviation |
| D10 | 候选排除 `file.file`/`file.backlinks` | `propertyFilter`（`app.js@2528675`） | 我们的候选集只来自视图列 + 已引用键，这两个键在 DTO 里根本不存在 | **不可达**（[未证实] 无需实现） |
| — | 行尾删除图标 | `clickable-icon` + `lucide-trash-2`（`app.js@2481117`） | 同一 `trash-2`（sprite 新增，lucide 路径取自 `app.js@1167742`），无边框 28px 命中盒 | **ported**（本刀顺带修：此前是带框的 `x`） |
| — | `清除排序` | 排序页**没有**该动作（只有 `添加排序`） | 保留（本 surface 的清空手段，URL 覆盖无法表达「显式无排序」；删掉会丢功能） | 登记为**多出**；清理声明级排序需 `PATCH`，不在本刀 |

## 14.9 lane `desktop-re/property-label-surfaces`（标签分面：表头 vs 三个选择器）

基座 `ece280ed`（`origin/main`，PR #681 合并后）。逐面证据、负控与预算账在 lane 根 `HANDOFF-LABELS.md`；
这里只登记契约与状态。**基准 = 桌面 1.14.4 + 业主截图**（这一条 asar 静态读不足以定案，见 §14.9.2）。

### 14.9.1 两个标签面（契约）

| 面 | 规则 | 依据 |
| --- | --- | --- |
| 表格表头（`view.js` 的 `.base-column-label`） | 服务端 `column.label`（**本刀未改**；下一个刀改正为「formula → displayName；否则内置名表 ?? 原始键」，见 §14.10） | 本仓既有实现（`.30` + U5）；§14.9.2-1 已在 §14.10 结案 |
| 三个选择器：属性菜单行 / 排序行 / 筛选属性下拉 | `propertyPickerLabel(key, column)`：公式行 → displayName；否则 **内置名表 ?? 原始键** | 业主截图：02 `项目`（y≈228）/ `status`（y≈276）/ `updated`（y≈324）；04 排序行 `updated`（1298×552，y≈240，x≈690-810）；01 筛选行 `kind`（2452×800，条件行 y≈396，x≈1624-1796） |

- **单一实现**：`app/frontend/app/features/bases/panel-chrome.js` 的 `propertyPickerLabel()`。`columnOptions()`
  （排序下拉 + 筛选下拉 + stale URL 覆盖键）与 `property-panelRows()` 的「老服务端无目录」降级分支共用它；
  服务端目录 `src/base-property-catalog.js` 的 `label()` 早已是同一规则（§14.7.1a 第 3 条）。表头**不**用它。
- **测试**：`app/test/web-bases-builtin-names.test.js` 新增「4 个面 × {内置键 `file.mtime`、note 键 `status`/`updated`、
  公式键 `formula.note`}」的 DOM 文本断言（走 `propertyCatalog` 生产路径）；三条旧钉子按面拆开（表头 / 选择器 / 一张表）。
  **负控**：把 `propertyPickerLabel` 的公式分支去掉（即回到「所有面都用 displayName」）⇒ 该断言 12 个标签里 6 个变红，
  `web-bases-ui-parity-2` 的 3 条同步变红。

### 14.9.2 [已结案]（本刀留下的问题由 §14.10 回答）

1. **表头是否消费 note 属性的 displayName** → **不消费（已证，2026-10-24）**。01/04 的表头读 `status` / `updated`
   **原始键**，而同一 `.base`（`_Workspace/40-Projects/Projects.base`）声明了 `status:{displayName:状态}` /
   `updated:{displayName:更新}`。结案证据与改法见 §14.10.1。
2. **属性菜单的搜索匹配什么**：行现在画选择器标签，搜索只匹配「该行画出来的标签 + 原始键」（`columnMatchesSearch`）。
   因此按表头名（如 `更新`）搜不到 `updated` 行 —— `test/web-bases-popovers.test.js` 已按新行为钉住。桌面行为 [未证实]；
   若要同时支持表头名，需服务端在目录里多带一个 `headerLabel`（本刀不做，避免 DTO 变更）。
3. formula 行的 displayName 来源仍是服务端 `column.label`（已按 `formulaDisplayName` 解析）；公式未声明时它是
   `formula.<name>`，与选择器规则的「原始键」回退一致。

### 14.9.3 预算

`app.js` **+27 gzip**（88313 → 88340；firstScreen 128253 → 128280，issue414 822219 → 822246；deferred 700587 与
shellEagerRawBytes 6773 逐字节不变，`editor.js` / `reader.js` / `app.css` / `icons.svg` 未动）。基线**未抬**
（本刀不自签）；唯一账目在 lane 根 `HANDOFF-LABELS.md` §预算。

## 14.10 lane `desktop-re/column-label-surfaces`（`column.label` 统一：表头 / 卡片 / 列表 / MCP）

基座 `db99f27c`（`origin/main`，#682 合并后）。逐面证据与 `audit:` 在 lane 根 `HANDOFF-COLUMN-LABEL.md`。

### 14.10.1 契约：一条规则，所有面

| 面 | 读什么 | 依据 |
| --- | --- | --- |
| 服务端单一真源 | `app/src/base-query.js` `columnLabel()`：formula → `properties.<key>.displayName` → 公式键；否则 **内置名表（U5）?? key 尾巴** | 业主截图（下述） |
| 表头 `view.js` `.base-column-label` | `column.label`（不再有 displayName 优先） | 01 表头 `status`（x≈862, y≈162）；04 表头 `updated`（y≈168） |
| 卡片布局 `row-layouts.js`（`bases-cards-label`，第 131 行附近） | `column.label` + 公式 `ƒ ` 标记 | 同一 `columns` DTO，无第二个决策点 |
| 列表布局 `row-layouts.js`（`bases-list-*`） | **不画列标签**（只画值）；它读同一 `columns` DTO，无 label 槽可漂 | 桌面 list 布局同形 |
| 属性菜单 / 排序 / 筛选选择器 | `propertyPickerLabel()`（客户端）＋服务端目录 `label()` | 与 §14.9.1 同规则，现在与前四面**一致** |
| MCP `query_base` | json DTO 不带 `columns`（B1 DTO lock）；label 只出现在 `csv` / `tsv` / `md` 的**表头行** | 见 14.10.2 |

**业主截图证据（独立复核席位亲自读图，本仓不重测）**：01（2452×800）表头 `项目`（公式）/ `status`（x≈862, y≈162）；
04 表头 `updated`（y≈168）；02/04 选择器 `status` / `updated` / `kind`；而 `_Workspace/40-Projects/Projects.base`
确实声明 `status:{displayName:状态}` / `updated:{displayName:更新}` —— 所以「只有公式列用 displayName」。

### 14.10.2 MCP `query_base` 口径（**显式裁定**）

- **跟随桌面**：json DTO 不变（`columns` 本来就不在契约里，B1 DTO lock）；`csv`/`tsv`/`md` 的表头行改用同一 `columnLabel`
  的值，所以带 `displayName` 的 note 属性从 `状态` / `更新` 变成 `status` / `updated`。对外可见的 API 语义变化，已登记。
- **grep 结果（开刀前）**：仓内消费 `columns[].label` 的位置共 4 处：`base-formats.js`（三种文本表头）、`view.js`（表头）、
  `row-layouts.js`（卡片）、`base-property-catalog.js`（属性菜单，formula 行走 `column.label`，其余自己算）。
  **没有任何客户端 / 文档 / 测试依赖 `状态` 这类非 formula 中文标签**（唯一两处冻结期望是官方 fixture 与 W0-A 表征表，已按新规则更新并改注释，**不是**删断言）。仓库外 MCP 客户端无法 grep，如实记作未证实风险。

### 14.10.3 状态登记

| 项 | 状态 | 证据 |
| --- | --- | --- |
| §14.9.2-1「表头是否消费 note 属性 displayName」 | **已证（原 `[未证实]`）** | 业主 01/04 表头坐标 + 02/04 选择器 + `.base` 声明 + 复核席位独立读图 |
| `columnLabel()` 非 formula 分支 | **改**（一处，`app/src/base-query.js`） | `git show` 单行；`web-bases-builtin-names.test.js` ③/③b/③c/③d/③e |
| 与 `propertyPickerLabel()` / 目录 `label()` 的关系 | **等价**（注释写明 + 行为断言） | ③d：同一列在「DTO / 客户端选择器 / 目录」三处同值 |
| MCP 文本格式表头 | **跟随**（见 14.10.2） | `mcp-base-query-formats.test.js` 129/129 绿；fixture 均未声明 displayName |
| 预算 | **服务端 0 字节**（不进 `app.js`） | 客户端未改 ⇒ firstScreen / issue414 逐字节不变（`git diff` 只涉服务端与测试） |

## 14.11 lane `desktop-re/grouping-honesty`（`分组` 按钮按布局收窄；cards/list 组头 not-ported）

基座 `6220d210`（`origin/main`，`#685` 合并后；`#684` 已把 `capabilities.grouping` 翻成 `true`）。
复核 D5 的实测：**list / cards 两种布局完全不读 `state.groups`**，`分组` 按钮在那两种布局下是**没有效果的控件**。
本刀只把它做诚实；本轮**未**移植 cards/list 的组头。逐项读数与 `audit:` 在 lane 根 `HANDOFF-GROUP-HONESTY.md`，
探针/截图/读数在 lane 根 `evidence/`（按 standing rule §5.22 不入仓）。

| # | 项 | 事实（本 head 已读） | 本仓行为 | 状态 |
| --- | --- | --- | --- | --- |
| G1 | 能力位 vs 布局位 | `capabilities.grouping` 是**表面**能力（`app/src/app/base-route.js` 一处 `true`），DTO 里 `groups[]` 与布局无关，list/cards 照样收到 | **不改服务端 / DTO**：能力位继续按表面声明；**客户端 UI 按布局收窄** | 已落地（收窄，不是能力回退） |
| G2 | 组头在哪画 | 表格：`group-heading.js` 画 `groups[]`；kanban：`kanban-runtime.js` 列 = 组 | `visibleActionItems(capabilities, viewType)` 只给 `layout ∈ {table, kanban}` 的 `分组` 条目；未知/缺失 layout = table（`normalizeViewType`，与 `view.js` 分派同一规则） | 已落地 |
| G3 | list / cards 的 `分组` | 两种布局都不存在组头，按钮点了不改任何可见内容 | **不渲染**（不是 disabled 假控件）；同一动作行的其余按钮不变 | 已落地 |
| G4 | 切布局时的开面板 | — | 动作因布局收窄而消失时，其已开面板一并剪掉：否则面板没有按钮可关，且切回时会自行重开 | 已落地（真 Chromium 断言） |
| G5 | **cards / list 组头** | **桌面有**（asar 1.14.4 静态读，本机 `scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4/app.js`）：共享 `_J.createGroupHeadingEl()` `@2499736`（`createDiv("bases-group-heading mod-collapsible")`，带属性名/值/折叠箭头），表格 `_7.render` `@3226622`、列表 `A7` `@3185086`（`bases-list-group` + `bases-list-group-list`）、卡片 `s7` `@3154320`（`bases-cards-group`）都调它；kanban `@3167346`/`@3176550` 自己的 `bases-group-heading`。附带读数：`createGroupHeadingEl` 对无值组 `if(!e.key)return null`（不画组头）——与本仓表格画 `无值` 不同，属 B 刀的另一条差异 | **not-ported（真实缺口，不是只收窄就够了）**：list/cards 仍平铺、无组头，也没有桌面组的折叠态。本刀只收窄按钮，**不以隐藏按钮掩盖缺口** | 未实现；B（移植组头 + 折叠）是后续刀，预算明显大于本刀，需先报数 |
| G6 | 服务端分组与 `?group=` | 服务端执行、override、组序不动（`#684`） | 不回归：`web-bases-grouping.test.js` 既有断言逐条仍绿，新增断言单列一条 | 不变 |
| G7 | 预算 | 客户端新增布局闸门 | **+111 gzip**（只在 `app.js`；firstScreen 130092→130203、issue414 824058→824169；其余首屏资产与 deferred 逐字节不变） | **基线未抬、未自签**；账目与回收实测见 `HANDOFF-GROUP-HONESTY.md` §预算 |

**判据（行为化，可重跑）**：`visibleActionItems({grouping:true}, "table"|"kanban"|"list"|"cards")` 的输出集合（
`app/test/web-bases-grouping.test.js`「分组 is narrowed …」）；真 Chromium 四个布局的工具栏 + 切换布局后的面板读数
（lane 根 `evidence/probe-bases-group-honesty.mjs` / `group-honesty-readings.json`）。



## 14.12 lane `desktop-re/group-headings-list-cards`（B：cards / list 的组头 + 折叠）

承接 §14.11 G5 登记的真实缺口。桌面读数全部来自本机 1.14.4 解包副本
（`scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4/`，**字节偏移，不按行号**）。

### 14.12.0 桌面读数（recon）

| # | 事实 | 偏移 / 依据 |
| --- | --- | --- |
| R1 | 组头工厂 `_J.createGroupHeadingEl(e)`：`if(!e.key)return null`；`createDiv("bases-group-heading mod-collapsible")`；子节点顺序 = 可选 `div.bases-group-property`（`if(config.groupBy)`，文本 = `getDisplayName(groupBy.property)`）→ `div.bases-group-value`（`RJ(el, key, app)`：空值走 `labelGroupKeyNone()`，其余 `key.renderTo`）→ `div.collapse-indicator collapse-icon`（`LM(el,"lucide-chevron-right")`） | `app.js@2499736` |
| R2 | 折叠交互：组头 `click`（`!defaultPrevented && button===0`）→ `preventDefault()` + `toggleGroupCollapsed(e)` + `bO(r, isGroupCollapsed(e))`。`bO(e,t)` = 在组头**和** `.collapse-icon` 上 `toggleClass("is-collapsed", t)` | `app.js@2499736` / `app.js@1498694` |
| R3 | 折叠态存储：`queryController.getGroupFolds()`（Set，`saveGroupFolds()` 持久化），id = `getGroupId(e)` = `` `${key.constructor}:${key}` ``，无 key 返回 `null`（不可折叠） | `app.js@2499736` |
| R4 | 表格 `_7.render`：children = `[heading?, summaryRow?, tbodyEl]` ⇒ 组头是 `.bases-tbody` 的**兄弟**，不是行 | `app.js@3226622` |
| R5 | 列表 `A7`：`createDiv("bases-list-group")` → 组头 append **进组容器** → `createDiv("bases-list-group-list")` 装行；`render` 对组容器 `toggleClass("is-collapsed")`，折叠时把所有行 `detach()`，并把组头高度量进 `headerHeight` | `app.js@3185086` |
| R6 | 卡片 `s7`：`containerEl = createDiv("bases-cards-group")`，`groupHeadingEl = createDiv("bases-group-heading")`（占位，`render` 用工厂结果替换）；`updateCollapsed` 对组容器 `toggleClass("is-collapsed")` + `padding:0 / borderWidth:0`；卡片的组渲染把**组头与组容器当兄弟**依次推入容器（`q=!!key` 才推组头） | `app.js@3154320` |
| R7 | 卡片/列表的几何是**虚拟化的绝对定位**：`groupHeadingHeight = tester.groupHeadingEl.offsetHeight`，组头 `top:R`、组容器 `top:R+headingHeight`，`groupGap`/`groupPad`/`cardGap` 从 computed style 读。本仓无此虚拟化 ⇒ 组头走正常流（登记差异，不假装同几何） | `app.js@3154320`、`app.js@3185086` |
| R8 | `is-grouped` 类：`viewContainerEl.toggleClass("is-grouped", !!config.groupBy)`（`data-view-type` 在同一个元素上） | `app.js@2546799` |
| R9 | CSS：`.bases-group-heading` = flex / `align-items:baseline` / `line-height:var(--bases-table-row-height)` / `gap:var(--size-4-1)` / 省略号；`.mod-collapsible{cursor:var(--cursor)}`；`.mod-collapsible .collapse-icon{flex-shrink:0;align-self:center;padding-inline:var(--size-2-1)}`；箭头 `transform:rotate(calc(var(--direction)*90deg))`，`.is-collapsed` 时 `transform:none`；`.collapse-indicator` 在 `@media (hover:hover)` 下 hover 才 `opacity:1`，`(hover:none)` 恒 1；`.bases-group-property{font-size:var(--bases-group-heading-property-size)=var(--font-ui-smaller);weight:var(--font-normal);color:var(--text-muted);display:block}`；`.bases-group-value{font-size:var(--font-smaller);weight:var(--font-semibold);overflow:hidden;text-overflow:ellipsis}` | `app.css@447337`、`@447865`、`@447931`、`@448062`、`@448184`、`@448311`、`@448423`、`@448504`、`@448773`、token `@57575`/`@57638`/`@57699`/`@57758`/`@57815`/`@57875` |
| R10 | CSS：`.bases-list-container{position:relative;min-height:100px}`、`.bases-list-group{position:absolute;width:100%}`、`.bases-list-group-list{position:relative}`；`.is-grouped .bases-cards-container .bases-group-heading{position:absolute;padding:var(--size-4-1) 0 var(--size-4-2)}`；`.is-grouped .bases-cards-container .bases-cards-group{padding:0 0 var(--size-4-4) 0;border:0 0 1px 0 solid var(--background-modifier-border)}`；`.bases-cards-group{position:absolute;gap:var(--size-4-3)}`；`.bases-table .bases-group-heading{width:100%;height:var(--bases-table-row-height);padding-inline-start:var(--size-4-2)}` | `app.css@484683`、`@484742`、`@484800`、`@475598`、`@475726`、`@475905`、`@488413` |
| R11 | **sticky**：组头**不是** sticky。整个 `app.css` 里 `position:sticky` 只出现在 `.setting-page-titlebar` `@172656`、`.bases-thead` `@488569`、`.bases-table-footer` `@491293`；组头是相对/绝对定位的普通块（R10），随内容滚走 | `app.css` 全量 `position: sticky` 扫描 |
| R12 | **无值组**：`createGroupHeadingEl` 对 falsy key 返回 `null` ⇒ 桌面**不画无值组头**（列表/卡片只画组容器与它的行）。`labelGroupKeyNone()` 只在 `RJ` 里对「非 null 的空值」可达 | `app.js@2499736`、`app.js@2489496`(`RJ`) |

### 14.12.1 状态

实现与预算见 lane 根 `HANDOFF-GROUP-HEADINGS.md`；本节的 R1–R12 是**桌面事实**，与实现是否采用它们分开记账。

### 14.12.1 落地状态（承接 §14.11 G5 的 not-ported 项）

| # | 项 | 本仓行为 | 状态 |
| --- | --- | --- | --- |
| H1 | list / cards 的组头 | `row-layouts.js` 按 `groupPage(state)`（`state.groups` × 本页窗口）分组：列表 `div.bases-list-group`（组头 + `div.bases-list-group-list[role=list]`），卡片组头与 `div.bases-cards-group` 为兄弟；组头 = `bases-group-heading mod-collapsible` + `bases-group-property` + `bases-group-value` + `collapse-indicator collapse-icon`（R1） | 已落地 |
| H2 | 折叠 | 点组头 → `is-collapsed` 写在**组盒**与组头的 chevron 上（R2/R5/R6），行由 CSS 不画（桌面是 detach）；折叠态按挂载期 `Set` 保存，翻页/动作重渲染不丢 | 已落地 |
| H3 | 折叠态持久化 | 桌面写 `saveGroupFolds()`（R3）；本仓**只在挂载期记忆**，不写 localStorage/URL | **未移植（登记差异）** |
| H4 | 无值组 | 本仓画 `无值` 组头（与自己的表格一致）；桌面 `if(!e.key)return null` **不画组头**（R12） | **登记差异**（与 #684 表格同口径） |
| H5 | 几何 | 桌面是虚拟化容器里的绝对定位（R7/R10）；本仓正常流，只对齐「谁包谁」+ 皮肤 token。列表组头 `padding:4px 0 8px` 取自卡片 `@475598`，列表侧无桌面值 | 部分 `[未证实]` |
| H6 | sticky | 桌面组头**不 sticky**（R11）；本仓也不 sticky | 与桌面一致 |
| H7 | 键盘 | 桌面组头是纯 `div` + click（无 `role`/`tabindex`）；本仓同样，未发明键盘折叠 | 与桌面一致 |
| H8 | `分组` 按钮的布局闸门 | `GROUPING_LAYOUTS` 回到四种布局（`#686` 的收窄是「缺口未补」期间的诚实措施，缺口补上后放宽）；`web-bases-grouping.test.js` 对应断言**改写**（不是删除），能力闸门与未知=表格两条规则仍被断言 | 已落地 |
| H9 | 预算 | **+841 gzip**（app.js 90263 → 91104；firstScreen 130203 → **131044**、issue414 824169 → **825010**；其余首屏资产与 deferred 逐字节不变）。骨架版首次读数 +863，实测回收 −22 | **未签、未抬基线**（等协调席 §5.9） |
