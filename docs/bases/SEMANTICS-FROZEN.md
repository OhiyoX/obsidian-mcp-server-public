# SEMANTICS-FROZEN —— `groupBy × sort × limit × summaries` 冻结契约（刀4 前置）

- **性质**：只读研究产物。本文件**不改**任何产品/测试代码，**不裁定**实现切法；它把 `BASES-COMPATIBILITY-MATRIX.md` §6 末行（`groupBy × sort × limit 组合形态`）与 §7 末行（`summaries × limit / group 相对顺序`）的 `CHARACTERIZE-PENDING` 换成**可引用的冻结契约**。
- **桌面依据**：`D:/Coding/Codex/obsidian server projects/scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4/app.js`
  （3,942,126 字节 minified 单行；**sha256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`**）。i18n 依据：同目录 `i18n.js`。
- **证据留档**：`evidence/semantics-freeze-asar-windows.txt`（本次取证的**逐窗口原文**；下文 `@N` = 窗口起点，`±80` 为 `grep -obE` 匹配窗口的前缀宽度）。**未启桌面运行时**：全部结论来自 asar 静态读取。
- **复现**：
  ```bash
  ASAR="D:/Coding/Codex/obsidian server projects/scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4"
  dd if="$ASAR/app.js" bs=1 skip=2495950 count=700 2>/dev/null | fold -w 170   # UJ 构造器 + groupedData
  grep -obE '.{0,80}getSummaryValue.{0,80}' "$ASAR/app.js" | head
  ```
- **等级词表**（每条结论必带其一）：
  - `FROZEN-DESKTOP` —— asar 静态可读、唯一片段直接支持；刀4 可据此写测试。
  - `DESIGN` —— 桌面未定义/未读到，由本项目选择；必须带「不主张 parity + 理由 + 风险」。
  - `unverified` —— 静态读取**无法**证实；**不得**被刀4 当作已证实结论引用。

---

## 0. 桌面断言的引用约定

> 由 `desktop-re/claims-docfix` 依 2026-10-20 全量回查（`worktrees/desktop-re/desktop-claim-audit/CLAIMS-AUDIT.md`，31 行手工判定）加入。**不改变任何一条语义结论**，只约束「引用 asar 时怎么写」。

1. **一律「字节偏移 + 唯一片段」，不用行号。** `app.js` 是 **3,942,126 字节的单行 minified** 文件，「第 N 行」不存在。
   规范写法 = `app.js@2498117`，且**片段前缀必须唯一命中**：`grep -obF '<片段前缀>' app.js` 只回**同一个**偏移（多命中 ⇒ 前缀不唯一，要加长）；片段中部的省略处标 `…`（带 `…` 的整段不能直接拿去 grep，只能逐段命）。
2. **必须同时标明是哪个文件。** 本轮 8 条 `OFFSET-MISMATCH` 里**只有 1 条**是「偏移挂错文件」；**主因是编码口径**（char 当 byte，见第 3 条），文件挂错只是**个别**情形：

   | 文件 | 字节数 | 形态 |
   | --- | --- | --- |
   | `app.css` | **668,223** | 多行 CSS |
   | `app.js` | **3,942,126** | **单行** minified JS |
   | `i18n.js` | **132,996** | 单行 minified JS |

   偏移 > 668,223 却写成 `app.css@…` 就是**直接越界**——本轮唯一的「文件挂错」即此条（②-7 `@1862953`：`app.css` 根本没有那么多字节，该锚实落 `app.js`）。
3. **警惕「char 偏移被当成 byte 偏移」。** 同一串在语言层按 code point / UTF-16 单元计长、在磁盘上按 UTF-8 字节计：
   `app.js` = **3,936,928 code points** / **3,937,083 UTF-16 单元** / **3,942,126 字节**（code point 与字节差 **5,198**）。
   该型错误的特征 = **声称值比真值小约 4.8k–5.3k，且随文件位置增长**（审计实测 4 个样本：**+4,901 / +5,037 / +5,056 / +5,129**）。
   取证必须 `open(path,'rb')` + 字节索引，或统一 `grep -obF/-obE`；**不得**用 `str.index()` 或编辑器行号。
4. **未判定的断言必须显式标出来，不能沉默。** 未判定 ≠ 已判无问题。未判定清单登记在 **issue #621**；
   作用域**限于本刀之后新增/更正的引用**，以及 #621 中已登记为本刀触及面的条目 —— 这些就地标 `未判定（见 #621）`，并写清「缺哪一份证据」。
   **不在本刀范围**：`WRITE-SURFACE-DESIGN.md` 的 W-1..W-9（~24 个 `@offset`）等 #621 其余待办，本刀不补标（否则本刀自己不合规）。
   **lane 根工件不在仓库语料内**（如 `bases-panel-tokens/HANDOFF.md`、`bases-ui-polish/HANDOFF.md`），其 `unverified` 断言统一登记在 **#621**，**不在仓库文档里就地标注**。
   （本文档 §5 的 `unverified` 是**自有等级词**：结论本身不可静态判定；与 #621 的「未判定 = 还没人去判」不同。）
5. **更正标记**：本文档/`RECON.md`/`BASES-COMPATIBILITY-MATRIX.md`/`WRITE-SURFACE-DESIGN.md` 中凡带 `（⑤-N 更正）` 的引用
   = 按上述口径**重取**过的字节偏移（审计编号见 `CLAIMS-AUDIT.md` §2）；**不带该标记的旧偏移沿用本文件头部既有约定**（头部**证据留档**行：`@N` = 窗口起点，`±80` 为 `grep -obE` 匹配窗口的前缀宽度；部分行另标逐行 `(+N)`），本节**不另立第二套约定**。
   **容差方向不唯一**：个别旧锚的目标片段落在锚**前**（**P4** `@2497600` 的引用片段实起 **2497527 = 锚前 73 B**，仍在 `±80` 内属既有例外）；正向越过 `±80` 的例也有（如 P1/U2 `@2548380` 的 `zJ(` 调用实起 **2548522 = +142**、P15 `@3233876` 的调用实起 **3234026 = +150**）。

---

## 1. 冻结管线（一句话 + 逐条证据）

**`filters(base+view) → [groupOrder 行集合限制] → search → sort(base path → view.sort 键) → limit(全局、对已排序的平铺行) → groupBy(分组) → summaries(按组、对该组留存行)`**

排序轴与分组轴**互相独立**：`views[].sort` 决定**行序**（组内序 = 行序），`groupBy.direction` 只决定**组间序**，二者不冲突、不互相覆盖。

| # | 阶段 | 结论 | 证据（asar 窗口 + 唯一片段） |
| --- | --- | --- | --- |
| P1 | 渲染路径总编排 | 取 view 配置 → （若 `groupOrder`）**先按组键白名单过滤行** → search → `file.path` 基线排序 → 求值属性（含公式）→ 构造数据模型（`applySort` 再 `applyLimit`） | `@2548380`（+300）：`u=r.getViewConfig(this.viewName)…var h=zJ(i,u,Array.from(this.results.values())),p=this.applySearchQuery(h,u.getOrder())…p.sort((function(e,t){return BT(e.file.path,t.file.path)})),this.evaluateRelevantProperties(p);…o.data=new UJ(i,u,v,p)` |
| P2 | **sort 先于 limit** | 同一行数组上先排序、后截断 | `@2495950`（+700）：`this.applySort(i),this.applyLimit(i),this.data=i` |
| P3 | 行排序（`views[].sort`） | 多键递归比较：类型化比较器（boolean / number / date / time / 其他 `toString()`）；无配置键时用**默认键** `[{property:"file.name",direction:"ASC"}]` | `@2496540`（`applySort` 主体，`r=t.getSort()…0===r.length&&(r=s$.slice())`）；`@2352760`：`s$=[{property:"file.name",direction:"ASC"}],l$=["file.name"]` |
| P4 | 排序里的**无值**位 | 无值（null/missing 哨兵 `lK.value`）**恒排在最后**，且该早退分支**不吃 direction 乘子** ⇒ DESC 时也在最后；null 与 boolean 相比走 boolean 分支 ⇒ 与 `false` 同序 | `@2497600`：`if(i instanceof lK&&a instanceof lK)u=0;else if(i instanceof dK||a instanceof dK)u=(i.isTruthy()?1:-1)-(a.isTruthy()?1:-1);else{if(i instanceof lK)return 1;if(a instanceof lK)return-1;…}return 0===u?o(e+1,t,n):"ASC"===c?u:-u` |
| P5 | 行基线序 / 组内 tie-break | `file.path` 升序是**基线序**，`applySort` 是稳定排序 ⇒ 同键行保持 `path` 升序 | `@2548380`：`p.sort((function(e,t){return BT(e.file.path,t.file.path)}))`（P2 的排序发生在其后） |
| P6 | **limit 语义：全局、作用于平铺行、在分组之前** | 截断 `[t, len)`，`t = config.getLimit()`；`t<=0` 不截断；工具栏计数 `shownCount = t>0&&n>t ? t : n`（="results in view" 的**行数**） | `@2497920`（+200）：`applyLimit=function(e){var t=this.config.getLimit();t>0&&e.length>t&&e.splice(t,e.length-t)}`；`@2355679`：`getLimit=function(){return this.limit||0}`；`@2521540`：`var i=t.getLimit();this.shownCount=i>0&&n>i?i:n` |
| P7 | 分组从**已截断**行集派生 | `groupedData` 只读 `this.data`（`applyLimit` 之后赋值的同一数组） | `@2496050`：`get:function(){…var e=this.config,t=this.data,n=e.groupBy,i=e.groupOrder;if(!n)return this.groupedDataCache=[new OJ(this.data)],…` |
| P8 | 无 `groupBy` 时 | 整表 = **单一组**（`new OJ(this.data)`）⇒ summaries 自然就是"整表" | 同上 |
| P9 | 自动组序（无 `groupOrder`） | 先按**首次出现**归组（遍历已排序行），再按组键**排序**；方向 `"ASC"===t?1:-1` | `@2496480`：`var o=qJ(t,n.property);return function(e,t){var n="ASC"===t?1:-1;e.sort(…FJ(e.key,t.key)*n…)}(o,n.direction)`；`@2495380`（+260）：`qJ` 主体（`toString()` 分桶 + `aK.looseEquals`） |
| P10 | **无键（missing/null）组的位置** | 组比较器只在**两侧都有键**时应用 direction ⇒ **无键组在 ASC 与 DESC 都排在最后**（与 B7 现行 DESIGN「ASC 首 / DESC 尾」**不一致**，见 §4-D1） | `@2496540`（+320）：`e.sort((function(e,t){return e.hasKey()&&t.hasKey()?FJ(e.key,t.key)*n:e.hasKey()?-1:t.hasKey()?1:0}))` |
| P11 | 键的有效性判定 | `hasKey()` = 键非假值 **且** 不等于无值哨兵 | `@2493960`（+700）：`OJ=function(){function e(e,t){this.entries=e,this.key=t}return e.prototype.hasKey=function(){return!!this.key&&!aK.equals(this.key,lK.value)},e}()` |
| P12 | 组键比较器 `FJ` | 相等→0；两侧 number→数值序；否则 `toString()` 字典序（即文本/日期/链接等按渲染串） | `@2494196`：`function FJ(e,t){return aK.equals(e,t)?0:e instanceof pK&&t instanceof pK?VT(e.data,t.data):BT(e.toString(),t.toString())}` |
| P13 | 组键相等性 = **loose** 相等 | 同构造器→`equals`；跨类型→`looseEquals`（date 可解析 text；**单元素 list ≡ 其元素**；number↔text 不相等） | `@2493960`：`qJ` 内 `aK.looseEquals(e.key,o)`；`app.js@2196827`（⑤-5 更正，原引 `@2201500`）：`e.looseEquals=function(e,t){return e===t||…}`；`@2207400`：date.looseEquals 里 `if(e instanceof hK){var n=t.parseFromString(e.data);n&&(e=n)}`；`@2200863` 附近：list `looseEquals(e){return e instanceof t?this.compare(e,aK.looseEquals):1===this.data.length&&aK.looseEquals(this.get(0),e)}` |
| P14 | **`groupOrder`（手动列/组序）路径** | 存在 `groupOrder` 时：① 组序 = `groupOrder` 键序；② 行集**先被白名单过滤**（键不在 `groupOrder` 的行在渲染路径被剔除）；③ 空组被丢弃；④ 组列表 UI 里这些行另成 `isVisible:false` 的组 | ①③ `@2496050`：`if(i){var r=WJ(this.app,e,t).groups;return this.groupedDataCache=r.filter((function(e){return e.entries.length>0}))…}`；② `zJ` 定义（`@2493960` 窗口内）：`function zJ(e,t,n){var i=VJ(e,t);return i?n.filter((function(e){return-1!==HJ(i,e)})):n}`，调用点见 P1；④ `@2549600`（+470）：`getAllGroups(){…var i=WJ(…),r=i.groups,o=i.unlisted,a=r.map(…isVisible:!0),s=qJ(o,n.property).map(…isVisible:!1);return a.concat(s)}` |
| P15 | **summaries：按组**（整表 = 唯一的未分组组） | `getSummaryValue(query, entries, propertyId, summaryKey)` 的 `entries` 即该组行数组；缓存按**组对象**（WeakMap） | `app.js@2498117`（⑤-6 更正，原引 `@2497600`）：`getSummaryValue=function(e,t,n,i){var r=this.summaryCache;…var p=t.map((function(e){return e.getValue(n)})),d=new qQ(this.app,p);a[i]=h.getValue(d)}`；调用点 `@3233876`：`var c=s.data.getSummaryValue(s.queryController,t,e,l)`（`t=this.entries`） |
| P16 | **summaries 在 limit 之后**（post-limit / "可见行"） | 因 P6+P7：entries 来自已截断行集 ⇒ 被 limit 截掉的组整组消失、被截一半的组只对**留存行**聚合 | 由 P6/P7/P15 复合；无独立补偿代码（未在 asar 中读到任何"summaries 用未截断集合"的路径） |
| P17 | summary **内置集由组内首个非空值的类型**决定 | 取 `u.constructor`（首个 `!==lK.value` 的值）→ 查自定义公式，否则查 `zQ(type)` 原型链表；查不到 ⇒ 该 summary 值为**无值哨兵**（不报错） | `app.js@2498318`（⑤-6 更正，原引 `@2497600`；`var u=c[l].getValue` 起 `@2498318`、`if(u!==lK.value)` 起 `@2498341`）：`for(…){var u=c[l].getValue(n);if(u!==lK.value){s=u.constructor;break}}var h=e.query.getSummaryFormula(s,i);if(a[i]=lK.value,h){…}`；`@2360790`：`getSummaryFormula=function(e,t){if(this.summaryFormulas&&Object.hasOwn(this.summaryFormulas,t))return this.summaryFormulas[t];var n=function(e,t){return zQ(e)[t]||null}(e,t);return n?new mQ(n):null}` |
| P18 | 内置 summary = **公式源码**（逐条，Type→Name→定义） | number：`Average:"values.mean().round(2)"`、`Min`、`Max`、`Sum:"values.sum().round(2)"`、`Range:"values.max() - values.min()"`、`Median`、`Stddev:"values.stddev().round(2)"`；date：`Earliest`、`Latest`、`Range:"(values.latest() - values.earliest())"`；boolean：`Checked:"values.filter(value == true).length"`、`Unchecked:"…false…)`；Any：`Empty:"values.filter(value.isType("null")).length"`、`Filled:"…!value.isType("null")…)`、`Unique:"values.unique().length"` | `@2344390`（+640）：`HQ=new Map([[pK,{Average:…}],[wK,{Earliest…}],[dK,{Checked…}],[aK,{Empty…,Filled…,Unique…}]]);function zQ(e){for(var t={};e;){var n=HQ.get(e);if(n&&(t=g(g({},n),t)),e===aK)break;e=Object.getPrototypeOf(e)}return t}` |
| P19 | `Stddev` = **总体（population）**标准差；空集→无值；n=1→0 | `i=mean(平方偏差)`，`sqrt(i)`，除数 **n**（非 n−1） | `@2203130`（+250）：`stddev=function(){var e=this.getNumbers();if(0===e.length)return lK.value;var t=function(e){var t=e.reduce(…,0);return t/e.length},n=t(e),i=t(e.map((function(e){return Math.pow(e-n,2)})));return new pK(Math.sqrt(i))}` |
| P20 | `Empty/Filled` = **null 类型值**计数（不是空串/0/false） | 定义即 `value.isType("null")`（P18） | 与 `Empty` 语义相关的 i18n：`labelGroupKeyNone:"None"`（无键组标签，`i18n.js`） |
| P21 | `Unique` = **类型化**相异计数（`aK.equals`） | `toString()` 分桶后用 `aK.equals` 判重 ⇒ `1` 与 `"1"` 相异、null 计一个 | `@2201500`：`unique=function(){for(var e=this.data,n={},i=function(e){var t=r.get(e),i=t.toString();if(Object.hasOwn(n,i)){var o=n[i];o.some((function(e){return aK.equals(t,e)}))||o.push(t)}else n[i]=[t]},r=this,o=0;o<e.length;o++)…` |
| P22 | search 阶段位置 | 在 view 过滤之后、排序之前（`applySearchQuery(rows, view.order)`） | `@2552380`（+330）：`applySearchQuery=function(e,t){…return e.filter(…)}`；调用点见 P1 |
| P23 | filter 阶段位置 | base+view filters 在进入本管线**之前**已作用于候选行集（`this.results`）；本 lane 未重推其内部顺序（属 B1 面） | 仓库内既有证据：`docs/bases/BASES-SEMANTIC-KEY-INVENTORY.md` §2（`views[].filters` ACCEPT-consumed）+ `BASES-COMPATIBILITY-MATRIX.md` §4/§6；调用点 P1 只见"已过滤的 `this.results`" |

**冻结一句话**（可写进 DTO 文档）：
> `limit` 是**行数**上限，作用于**全局已排序平铺行**，**早于分组**；`groupBy` 只是对留存行做**分区**（不重排行）；`summaries` **按组**、对该组**留存行**聚合；`groupBy.direction` 只定**组间序**，**行序永远由 `sort`（末键 `file.path` 升序）决定**。

---

## 2. 边界与退化（逐条：桌面行为 + 依据 + 本项目需裁定项）

| # | 场景 | 桌面行为 | 依据 | 本项目口径建议 |
| --- | --- | --- | --- | --- |
| E1 | 空集（0 行） | 无 `groupBy`：仍是**一个空组**（`[new OJ([])]`）；有 `groupBy`：`qJ([]) = []` ⇒ **0 组**；无 summary 值（类型 undefined ⇒ 内置集空集 ⇒ 哨兵） | P8/P9/P17 | 显式钉住：`groups: []`、`totalGroups: 0`、`summaries: []`/全 null；不得报错 |
| E2 | `limit: 0` | **不限制**（`t>0&&`；UI 0 = "Show all"，i18n `buttonShowAll:"Show all"`） | P6 | **分歧**：矩阵 §4 现把 `limit: 0` 判 `invalid-schema`（`boundary-limit-zero`）。保留项目 fail-closed，但在文档显式登记"与桌面 0=无限制不同"，**不主张 parity** |
| E3 | `limit` 截断到组中间 | 该组只剩留存行；summary 只算这些行；被整组截掉的组**不出现** | P6/P7/P16 | 钉住：`Σ group.count === min(totalMatched, limit)` |
| E4 | 多值（list）属性作 groupBy 键 | 单元素 list **与其元素同组**（`list.looseEquals` 长度=1 分支）；多元素 list 自成一组（同构造器比较 + `toString()` 分桶）；**不是**"每元素一组" | P13/P12 | 桌面证据只支持"整值身份"；若刀4 要做"每元素展开"必须标 `DESIGN` 并写理由 |
| E5 | `groupBy` + `sort` 冲突 | 不存在冲突：`sort` 定行序、`groupBy.direction` 定组序；**行序不变** | P2/P9/P12 | 钉住：组内序 == 无分组时的行序切片 |
| E6 | `groupBy.direction` 缺省/非法 | 滚动条外：`setGroupBy` 只接受 `{property,direction}`；序列化回写 `direction`（`@2353385`）。缺省取 ASC 的路径在**手动列**路径可见（`s=t||"ASC"`，`@2509711`） | `@2353401`：`e.groupBy={property:f$(…),direction:this.groupBy.direction}`；`@2509711`：`…direction)&&void 0!==o?o:"ASC":t;a.setGroupBy({property:e,direction:s})` | 缺省 ASC = `DESIGN`（矩阵 §9 V3 仍开放）；非法值 fail-closed 优于桌面（桌面无独立校验读侧） |
| E7 | 无键组（missing/null/NaN/非法日期） | **恒排最后**（ASC/DESC 皆然）；组标签 i18n `labelGroupKeyNone:"None"` | P10/P11 | **与 B7 现行 DESIGN 冲突**（§4-D1）⇒ 刀4 必须二选一并写进矩阵 |
| E8 | `summaries` 引用**未知属性** | `getSummaryKey(propertyId)` 只在 `view.summaries` 有该键时返回名字 ⇒ 未知属性**无 summary**；`view.summaries` 里声明了但不在 `order` 的属性没有列 ⇒ 无渲染位 | `@2354903`：`getSummaryKey=function(e){return this.summaries&&Object.hasOwn(this.summaries,e)?this.summaries[e]:null}` | 建议：**fail-closed 或显式 `not-applicable`**，不得静默忽略（契约 §17） |
| E9 | `summaries` 引用**未知 summary 名** | `getSummaryFormula` 查不到 ⇒ `null` ⇒ 该单元格**无值**（无错误、无提示） | P17 | **分歧**：项目应 fail-closed（对齐 W0-D 方向），并登记为"不比桌面宽松" |
| E10 | 组内混合类型 | 内置集由**首个非空值**的类型决定 ⇒ 若首值是 text，number 族 summary **不可用**（无值），即使后续有数字 | P17 | 建议：显式 `type-mismatch` 语义（或按"该类型的值子集"聚合）；不得静默无值 |
| E11 | `formula.*` 作 groupBy 键 | 桌面的组键走**同一属性值层**（`getValue(propertyId)`，且在 `evaluateRelevantProperties` 之后）⇒ 公式派生属性可作分组键；但 `"formula.x"` **字面拼写**是否能作为 `propertyId` 传入**未在 asar 中确证** | P1（求值先于取键） | `unverified`（§5-U1）。本项目现为 `assertNoFormulaReferencesInGroupBy` fail-closed；刀4 若要放开，必须先落 `formula.x` 键解析的证据 |
| E12 | `groupOrder` 存在时 | 组序=显式键序；**行集被白名单裁剪**（非列出键的行不渲染）；空组丢弃；组列表 UI 把被裁行标 `isVisible:false` | P14 | **高危**：`groupOrder` 不只是"组序"，它是一个**隐藏的行集合过滤器**。刀4/kanban 必须显式裁定（建议：只读 DTO 明确 `unlisted` 计数，或整键 fail-closed） |
| E13 | 同时声明 `groupBy` 与 `groupOrder`，但 `groupBy.property` 改了 | `setGroupBy` 在 property 变化时**清空 `groupOrder`**（`[]`→`null` 往返） | `@2355765`：`setGroupBy=function(e){var t=this.groupBy;if(e||t)return!e&&t?(this.groupBy=null,this.groupOrder=null,…):void(t&&e.property===t.property&&e.direction===t.direction||(e.property!==(null==t?void 0:t.property)&&(this.groupOrder=this.groupOrder?[]:null),this.groupBy=e,…))}` | 提醒实现：改 `groupBy` 必须同时作废"手动组序"状态 |
| E14 | `limit` 与 summaries 的组合 | summary 值域 = `min(total, limit)` 行；上限场景下 Average/Sum **随 limit 变化** | P6/P16/P18 | DTO 需带 scope 字段（B5 已要求 `summariesScope`）；本冻结把 scope 钉为 **`visible-rows`（post-limit）** |

---

## 3. 刀4 可执行验收清单（先落证据 → 再改代码）

要求：每条语义对应**一个能变红的测试形态**（函数级/契约级即可，不必实现）。`R` = 若实现选择与桌面一致则红；`D` = 若实现选择与本案 DESIGN 不符则红。

| # | 语义 | 测试形态（可变红） | 依据 |
| --- | --- | --- | --- |
| C1 | sort 先于 limit | fixture：2 个属性排序键的 6 行 + `limit: 3`；断言"先排序再截断"与"先截断再排序"结果不同（组内成员集合不同）⇒ 断言取值 | P2 |
| C2 | limit 作用于平铺行、**分组之前** | 构造使其按 sort 顺序前 2 行全属 A 组（B 组 3 行在后）+ `limit: 2` + `groupBy`；断言 `groups == [A]`、`A.count == 2` | P6/P7 |
| C3 | `limit: 0` | 断言项目口径（现为 `invalid-schema`）；红测名必须写明"桌面 0=无限制，本项目 fail-closed" | E2 |
| C4 | 组内序 = sort 序 | 无 `groupBy` 时行序 == 有 `groupBy` 时各组 rows 拼接序；末键 `file.path` 升序（同键行） | P2/P5/P12 |
| C5 | 组间序 = `groupBy.direction` | 同一 fixture 跑 ASC/DESC 两方向；断言只数组顺序、行集合不变 | P9 |
| C6 | 无键组位置 | fixture：一个 missing/null 键行 + 两个有键行；**两个方向各断言一次**（桌面=最后；B7 DESIGN=ASC 首/DESC 尾） | P10 ↔ §4-D1 |
| C7 | 排序里无值恒最后 | `sort` 单键 + null 值行；ASC/DESC 各断言一次 | P4 |
| C8 | summaries 按组 | 2 组 × 各 3 行 + `summaries: {<num prop>: "Average"}`；断言每组一个值且 ≠ 全量值 | P15 |
| C9 | summaries 在 limit 后 | 同 C8 + `limit` 截掉第二组；断言第一组 summary 只反映留存行，且被截组的组与 summary 都不存在 | P16 + E3 |
| C10 | 无 `groupBy` 时 summary = 整表（post-limit） | 单组断言 `groups.length===1`，值 == 前 `limit` 行聚合 | P8/P16 |
| C11 | `Empty`/`Filled` 只数 null 类型 | fixture 含 `""`、`0`、`false`、missing；断言 `Empty` 只含 missing（空串/0/false **不计**） | P18/P20 |
| C12 | `Unique` 类型化 | fixture 含 `1` 与 `"1"`、两个 null；断言 `Unique == 3`（1、"1"、null） | P21 |
| C13 | `Stddev` = population + 舍入 | 已知数列（如 `[2,4,4,4,5,5,7,9]`）断言 population σ=2.0（sample=2.14）；n=1 → 0；空组 → 无值；断言 `.round(2)` | P18/P19 |
| C14 | `Average`/`Sum` 舍入 2 位 | 断言 `1/3` 类输入输出 2 位小数（不是全精度） | P18 |
| C15 | 混合类型组 | 首值为 text、含数字的组 ⇒ 断言项目选择（number summary 报错 / 或按子集聚合），**不得**静默无值 | E10 |
| C16 | 空集 | 0 行：无 groupBy → 1 空组、有 groupBy → 0 组、summary 无值；断言不抛错 | E1 |
| C17 | `groupBy` 用 `formula.*` | 当前 `assertNoFormulaReferencesInGroupBy` 必须保持（红测已存在）；若放开，先补 `formula.x` 键路径的证据测试 | E11/U1 |
| C18 | 多值键 | 单元素 list 与标量同组、多元素 list 自成组（**或**项目选 `unsupported_group_key` fail-closed）；两分支都要有红测 | E4 |
| C19 | `groupOrder` 行集裁剪 | 声明 `groupOrder` 只含键 A：断言非 A 行**不在** rows 里（或显式 `unlisted` 计数）；此语义**不得**悄悄进入只读 DTO | E12 |
| C20 | 改 `groupBy.property` 作废手动组序 | 断言 `groupOrder` 被清空（`DESIGN`：可只在服务端做等价不变式） | E13 |
| C21 | pipeline 顺序不变式（契约级） | 一条测试遍历 fixture 组合（groupBy × sort × limit × summaries 的 2×2×2×2），断言 `Σ group.count === min(totalMatched, limit)`、组间无重复行、行集合 = 排序后前 N 行 | P1–P16 汇总 |
| C22 | 未知 summary 名 / 未知属性 | 断言 fail-closed 错误码（项目选择），并注明桌面是静默无值 | E8/E9 |

**顺序纪律**：C1–C10（顺序与 limit）→ C11–C14（内置 summary 值语义）→ C18/C19/C22（fail-closed 边界）→ C15/C16/C17/C20（DESIGN 收口）。**每一条先落 fixture + 期望值文档，再改 `base-query.js` 接受面。**

---

## 4. 与现存 B1–B7 冻结（`SEMANTIC-ORDER-EVIDENCE.md`）的差异 —— 必须回填的 4 条

> 这些是**桌面证据与现行 DESIGN 不一致**的点，刀4 若照抄 B3/B5/B7 会与桌面行为分叉；矩阵更新属**实现刀**（本 lane 不改）。

| # | 项 | 现行冻结（网上取证 + DESIGN） | 桌面 asar 事实 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 无值/空组位置 | B7 DESIGN：空（缺失）组归 null 组，**放最小侧（ASC 首、DESC 尾）** | **恒在最后**（两方向都是），因为 direction 乘子只作用于"两侧都有键"分支；行排序里无值也**恒在最后** | 只改组/行展示顺序，不改集合成员。刀4 必须**二选一**并在矩阵写明（若选桌面=parity，则 B7 DESIGN 需退为历史） |
| D2 | `Stddev` | B6 DESIGN ④：**样本**标准差，n=1 → null | **总体**标准差；n=1 → **0**；空 → 无值 | 数值级差异 √(n/(n−1))。刀4/刀8 若宣称 parity，必须改；否则保留 DESIGN 并标"不主张 parity" |
| D3 | `Empty` 判据 | B6 DESIGN D2：空串/`0`/`false` 各成一组（与 `isEmpty()` 区分） | `Empty` 定义为 `isType("null")` ⇒ 空串/0/false **不计** Empty；分组身份同理（`lK` 哨兵） | 与 B6 同向，**已被桌面证实**；可把该 DESIGN 升为 parity |
| D4 | `Unique` 相等性 | B6 DESIGN ⑤：类型化相等、missing/null 计一个 | `aK.equals` + `toString()` 分桶：**类型化**、null 计一个；**单元素 list 合并进标量组**（loose） | 与 B6 同向，可升 parity；但注意 P13 的 **loose** 组键相等（date↔text、单元素 list）是 B6 未覆盖的新面 |
| D5 | `limit: 0` | 矩阵 §4：`limit: 0` = `invalid-schema` | 0 = **不限制**（"Show all"） | 显式登记为**有意的收窄**（不主张 parity） |

**B4 的网上取证结论（limit 全局、无 per-group limit）已被桌面 asar 独立证实**（P6），可从 `DOC`+旁证升为 `FROZEN-DESKTOP`。

---

## 5. `unverified`（本 lane 未证实，刀4 不得引用为已证实）

| # | 项 | 为什么未证实 |
| --- | --- | --- |
| U1 | `"formula.x"` 字面拼写能否直接作 `views[].groupBy.property` | asar 只证明"组键经属性值层取值、公式已先行求值"；未读到 `f$`/`UQ` 对 `formula.` 前缀的规范化路径（E11） |
| U2 | `groupOrder` 裁剪行集是**持久语义**还是**手动排序模式的临时态** | `zJ` 调用点在 `@2548380` 的渲染路径；未确认无 UI 交互（纯打开 `.base`）时是否同样裁剪。静态读取无法区分"打开即裁剪"与"仅手动列模式"<br>**未证实（2026-10-20 审计 ⑤-4 = 本行 U2：`zJ` 的调用点确实在 `app.js@2548522` 的常规渲染路径，但「纯打开 `.base` 即裁剪行集」与「仅手动列模式」在 asar 静态读取下无法区分 —— 该断言的内容本身就是「静态不可判定」，判 UNVERIFIABLE，须桌面运行时对拍或另行举证。结论不变。）** |
| U3 | `unlisted` 行在表格里的最终呈现（`isVisible:false` 组是否可展开/是否显示在"Unlisted"区） | 只读到 `getAllGroups` 的数据构造，未读到渲染分支（DOM 层） |
| U4 | `Median` 偶数项规则、`Min/Max` 空集行为、date `Range` 的单位/取整 | 定义仅是公式源码字符串（`values.median()`、`values.max()-values.min()`）；实现体未逐条读 |
| U5 | 组键渲染（`RJ` → `renderTo`）对 date/number 的显示格式 | 只读到 `RJ` 调 `t.renderTo`；格式化细节属 DOM 层 |
| U6 | `views[].limit` 与**搜索/分页/虚拟滚动**的交互（`updateVirtualDisplay`） | 本 lane 未读虚拟滚动路径（RECON §5 已登记 list/cards 虚拟滚动未实现） |
| U7 | `summaries` 在**组头** vs **表尾**的渲染位置（桌面 i18n 有 `labelSummary`/`actionSelectSummary`） | 只读到 summary **取值**路径（`@3233876` 的单元格渲染器 + `this.entries`），未读到组头渲染分支 |
| U8 | `kanban` 列与 `groupOrder` 的关系（kanban 的"手动列"是否复用 `groupOrder`） | 只读到 i18n（`actionEditColumns`/`labelColumnWidth`/`textNoGroupBy`）与 `setGroupOrder` 的可复用性推断，未读 kanban 实现体（递归 §1.1 的登记） |

---

## 6. 风险与翻键建议（翻 `accept` 的最小安全序）

**可原子翻转（同一刀内，因为共享同一个 DTO 边界）**
1. `views[].groupBy` + `views[].summaries` —— **建议同刀**。理由：P15/P16/P17 表明"组的行集"就是"summary 的输入域"，拆开会出现"有 groups 无 summaries"或反过来的**半语义**（契约 §17 禁止返回部分语义结果）。翻转前提 = C1–C10 全绿 + `groups` DTO additive 字段（`BASES-GROUPING-MODEL.md` §9 已冻结形状）。
2. 顶层 `summaries`（自定义 summary 公式，`values` 关键字）—— **建议独立后置**（矩阵 §7 已归 P1-F/S9）。但注意桌面把**内置 summary 也实现为公式**（P18 全是 `values.*` 表达式）⇒ 若本项目选择"内置 summary 复用公式引擎"，则 `values` 关键字成为 `views[].summaries` 的**前置**而非后继，翻键顺序要反转。**这是刀4 开工前必须定的第一个问题。**

**必须分批（不可与上面同刀）**
- `groupOrder`（E12/P14）：它不是展示键，是**行集合过滤器**（`zJ`）。建议**先 fail-closed 保留**，等"`unlisted` 语义"（U2/U3）落地后再翻；否则会出现"打开 `.base` 少行"的静默数据丢失。
- `formula.*` 作组键（E11/U1）：先补键路径证据，再决定是否收窄 `assertNoFormulaReferencesInGroupBy`。

**`kanban` 与 groupBy 的耦合**
- 硬依赖：i18n `titleNoGroupBy:"Add columns"` / `textNoGroupBy:"Choose a property to group by."` ⇒ 无 `groupBy` 时 kanban **无列可画**（RECON §1.1）。
- 结构依赖：kanban 的"列"= 组，且桌面有 `setGroupOrder`/`actionEditColumns` ⇒ kanban 的**手动列**极可能复用 `groupOrder`（U8）。因此 **`groupOrder` 的语义必须先于 kanban 冻结**，否则 kanban 会把"白名单裁剪行集"硬化成用户可见行为。
- 结论：`groupBy`（+summaries）→ `groupOrder` → `kanban`，三步不可并。

**预算（承接 RECON §6，未变）**：本刀产物是文档 + 证据文件，**零资产影响**；刀4 前端分组行仍落 `firstScreen`（`app.js`），需同刀回收。

---

## 附：本文件未做的事
- 未改任何产品/测试代码；未改 `BASES-COMPATIBILITY-MATRIX.md`（该更新属实现刀）；未启桌面端 Obsidian；未 tag/release/部署。
- 未做桌面**运行时**对拍（纯 asar 静态读取）⇒ §5 全部 `unverified` 项不得被下游引用为已证实结论。
- 临时文件在 `os.tmpdir()`（`/tmp/bases-freeze/`），退出前清理。
