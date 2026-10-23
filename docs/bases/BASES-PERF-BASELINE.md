# Bases P1 Wave 0 — 性能与规模基线（W0-C）

- 契约：`_Workspace/40-Projects/obsidian_mcp_server/MCP/TODO - 增强 Bases 支持.md` §6.6（性能基准：10k/50k，先记录不设毫秒阈值）、§14.8（算法计数器）、§17、§19。
- BASE（冻结）：`f258427a1f430e89f08a6005970e085d23c717f5`（= `origin/main`，PR #304）。
- 测量对象（本刀零 production 改动，只读 canonical 域层）：
  `app/src/base-query.js`、`app/src/base-formulas.js`、`app/src/workflows.js`。
- 测试：`app/test/bases-perf-baseline.test.js`（新增）；原始数据：`scratch/bases-p1/W0C/perf-raw.json`。
- 命令：`cd app && node --test test/bases-perf-baseline.test.js`（裸跑，无额外 flag；GC 未强制）。

## 1. 方法与范围

- 合成记录生成器为纯函数、无 RNG、无时钟：同一 `count` 必得同一数组，故确定性断言有意义。
- 字段覆盖：`string`（title/status/note）、`number`（rank）、`date-string`（due）、`boolean`（done）、
  `list`（labels/tags/links）、`missing`（title/ref 缺失）、`null`（note）、结构化 `asLink` 列
  （frontmatter `ref` + 公式列 `formula.label`）。
- 每项操作独立计时，各 **5 次重复**，取 min / median / max。
- 断言**只含不变量**（行数 / `totalMatched` / 确定性 / tie-break 稳定 / 无异常 / `supportedSubset === true`）；
  **没有任何 wall-clock 阈值**（契约 §6.6 / §14.8）。数字仅记录、从不 gate。

## 2. 机器与负载（`perf-raw.json.machine`）

| 项 | 值 |
| --- | --- |
| Node | `v26.3.0` |
| 平台 | `win32 x64` |
| CPU | Intel(R) Core(TM) i9-14900HX，32 逻辑核 |
| 内存 | total 68 413 153 280 B（≈68 GB），采集时 free ≈14.9 GB |
| GC | **未强制**（`node --test` 默认无 `--expose-gc`） |

负载声明（原文照录）：本机同时跑 bases-p1 W0-A/W0-B/W0-C 与其他 agent harness，内存/CPU 共享，
**计时不受控**。采集 `perf-raw.json` 时另有其它 lane 的完整 `npm test` 在并发运行，因此该样本仍偏噪。

## 3. 原始数字（`perf-raw.json`，单位 ms）

### 10k 记录

| 测量项 | min | median | max |
| --- | ---: | ---: | ---: |
| `parseAndValidateBase` + `compileBaseView`（编译路径） | 0.219 | 0.226 | 0.494 |
| `evaluateBaseView` 纯 filter | 4.649 | 7.203 | 9.470 |
| `sortBaseRecords` 纯 sort（日期/数字/字符串 tie-break） | 43.705 | 46.957 | 48.365 |
| `evaluateBaseView` 公式列投影（`file.asLink`，全行） | 14.348 | 15.823 | 26.959 |
| `queryBaseSnapshot` 全管线（filter+sort+formula+limit） | 55.282 | 58.641 | 63.390 |

### 50k 记录

| 测量项 | min | median | max |
| --- | ---: | ---: | ---: |
| `parseAndValidateBase` + `compileBaseView`（编译路径） | 0.064 | 0.066 | 0.092 |
| `evaluateBaseView` 纯 filter | 20.619 | 22.708 | 48.672 |
| `sortBaseRecords` 纯 sort（日期/数字/字符串 tie-break） | 301.788 | 321.536 | 386.592 |
| `evaluateBaseView` 公式列投影（`file.asLink`，全行） | 106.147 | 125.765 | 147.728 |
| `queryBaseSnapshot` 全管线（filter+sort+formula+limit） | 350.815 | 399.408 | 453.933 |

配置（两档一致）：
- filter：view 级字符串过滤 `status != "archived"`，`order=[file.path]`，`limit=1`（投影钉到 1 行以隔离 filter）；
- sort：`due ASC, rank DESC, title ASC`（第三列字符串分支即最贵路径）；
- 公式投影：`order=[file.path,title,rank,due,done,labels,status,ref,formula.label]`，无 filter / 无 sort，投影全部行；
- 全管线：`filters` + `sort(due ASC, rank DESC)` + 公式列 + `view.limit=5000`。

`totalMatched`：10k = 8571、50k = 42857（= `count − ceil(count/7)`，因每第 7 条 `status=archived`）。

### 参考：另两次样本（非产物，仅说明方差）

同一代码、同一机器、不同并发负载下的 50k 全管线 median：本产物 = 399 ms；更早两次采样分别 ≈231 ms 与 ≈523 ms
（对应纯 sort 分别 ≈215 / ≈604 ms，纯 filter ≈18 / ≈42 ms，公式投影 ≈53 / ≈135 ms，编译恒 < 1 ms）。
三次之间只差宿主机并发负载，**不是**代码差异 —— 这正是本波不设阈值、只建基线的直接理由。

## 4. 峰值内存与观察（`heapUsedDeltaBytesMax` / `rssDeltaBytesMax`）

| 测量项 | 10k heapΔ | 10k rssΔ | 50k heapΔ | 50k rssΔ |
| --- | ---: | ---: | ---: | ---: |
| 编译路径 | 518 328 | 339 968 | 31 928 | 0 |
| 纯 filter | 8 214 464 | 11 153 408 | 17 696 896 | 29 233 152 |
| 纯 sort | 9 282 992 | 323 584 | 31 239 128 | 1 257 472 |
| 公式投影（全行） | 6 463 776 | 2 646 016 | 14 203 184 | 11 763 712 |
| 全管线 | 3 743 784 | 18 051 072 | 27 206 752 | 4 464 640 |

观察（只陈述现状）：

- **编译与记录数无关**：编译只解析 YAML 与公式 AST，10k/50k 同为亚毫秒级，`heapΔ` 极小（50k 仅 ~32 KB）。
- **filter 与记录数近线性**：50k median 约为 10k 的 3.2 倍（噪声大）。字符串 filter 表达式**每条记录重新做正则匹配**
  （见 §5.2），因此系数不小。
- **sort 是当前最贵项**：50k 纯 sort median ≈ 322 ms，约为纯 filter 的 14 倍；比较器每比较 2 次属性读取
  并带 `localeCompare(..., {numeric:true})` 与路径兜底（见 §5.3）。
- **公式投影按 `行 × 公式列` 线性分配**：50k 全行投影 `heapΔ` ≈ 14.2 MB，是全管线里最大的一块；
  50k 全管线因 `limit=5000` 只投影 5000 行，`heapΔ` ≈ 27.2 MB（含 42857 条 matched 中间数组 + 排序副本）。
- **明显的多倍临时分配**：出现。`sortBaseRecords` 先 `[...records]` 复制一份（O(N) 指针数组），
  `evaluateBaseView` 另建 `matched` 与 `sorted` 两个 O(N) 中间数组；公式/行投影再建 O(rows) 对象。
  50k 时中间态同时存在「原数组 + matched + sorted 副本 + 投影对象」，是 `rssΔ` 的主要来源。
- **未强制 GC 使 `heapΔ` 只是上限近似**：before/after 差可能因跨轮回收而为负（取 max 后为 0），
  须结合 `rssΔ` 与分配结构理解，不作为精确峰值。

## 5. 算法事实节（读代码得出，仅陈述现状）

> 结论均为对本 BASE 源码逐行阅读所得，附 `file:line`。本刀未改任何生产代码。

### 5.1 编译在每次调用发生一次

- `queryBaseSnapshot`（`app/src/base-query.js:339`）每次调用执行一次
  `parseAndValidateBase`（`:104`）→ `compileBaseView`（`:121`）→ `evaluateBaseView`（`:277`）。
- `compileBaseView` 内 `compileBaseFormulas`（`app/src/base-formulas.js:138`）对**每个声明的公式**解析一次 AST
  并全量校验（含不可达分支，`assertSupportedReferences` `:114`）；`compileBaseView` 随后做
  `assertNoFormulaReferencesInSortOrFilter`（`:161`）与 `assertFormulaPropertiesAvailable`（`:188`）。
- 即：**同一次查询内** YAML 与公式 AST 只解析一次；但**每次 HTTP/MCP 调用都会重新解析**（无跨调用编译缓存）。

### 5.2 filter 逐 record 调用

- `evaluateBaseView`：`records.filter(...)` 逐 record 调 `evaluateBaseFilter`（`app/src/base-query.js:280`）。
- 字符串 filter 走 `evaluateBaseExpression`（`app/src/workflows.js:144`），其实现是**对表达式字符串逐条记录重新
  跑正则匹配**（`file.inFolder` / `file.hasTag` / `file.hasLink` / `.contains` / 比较运算等分支），
  **没有预编译的 filter AST / 预编译正则**。
- `filterExtra`（Web 冻结 API）逐 record 调 `evaluateBaseCondition`（`:205`）；textQuery 分支逐 record 调 `baseRow`
  取列值（`:290`）。
- 因此 filter 成本 ≈ `记录数 × (filter 数 + filterExtra 数)`，且字符串 filter 每条都要重新解析一次表达式。

### 5.3 sort 走比较器

- `sortBaseRecords`（`app/src/workflows.js:190`）先 `[...records]` 复制数组，再 `Array.prototype.sort`
  传入比较器；比较器对每个 sort key 调 `propertyValue` **两次**（`:199`、`:200`），
  即属性读取次数 ≈ `2 × keys × O(N log N)`。
- 比较器内：null 排序（`:201-202`）、日期解析 `dateValue`（`:204-210`，逐次内联创建函数）、
  数字相减、否则 `String(a).localeCompare(String(b), undefined, { numeric: true })`（`:215`）；
  全部 key 相等时兜底 `left.path.localeCompare(right.path)`（`:218`）。
- **每次比较都重新读属性、重新解析日期**，无 decorate-sort-undecorate（无 Schwartzian 缓存）。

### 5.4 公式每 row 每列求值一次（当前无 memo）

- `baseRow`（`app/src/workflows.js:177`）对 `order` 的每个属性求值；公式列调
  `evaluateBaseFormula`（`app/src/base-formulas.js:249`）→ `evaluateNode`（`:239`）→ `evaluateReference`（`:230`）。
- 全管线里 `baseRow` 每投影行调用一次（`app/src/base-query.js:307`，`sorted.slice(0, limit).map(...)`），
  故 canonical 路径下公式求值次数 ≈ `投影行数 × 公式列数`；**同一公式若出现在多个列会被重复求值，
  当前没有 per-row memo / dependency 复用**（契约 §14.8 的「每 row 每 formula 最多一次」尚待后续 Wave 实现）。
- 过滤器与排序**不求值公式**：`assertNoFormulaReferencesInSortOrFilter`（`base-formulas.js:161`）显式拒绝
  在 `view.sort` / `filters` 中引用 `formula.*`；唯一例外是 Web 冻结 API 的 `sortOverride`，
  由 `overlayFormulaSortValues`（`app/src/base-query.js:250`）把公式值预物化进 frontmatter 覆盖层后再排序
  （MCP canonical 路径不经过它）。
- `columnLabel` / `buildColumns`（`:140`、`:150`）对列标签只算一次/列，不是每行。

## 6. 后续 Wave 的计数器计划（设计说明，本刀不实现）

契约 §6.6 / §14.8 要求记录 row/formula evaluation count 等算法计数器。本刀**不得改生产代码加钩子**
（BRIEF §3），故此处只给设计，供后续刀（W1 表达式/依赖引擎或专门 instrumentation lane）落地：

1. **注入式计数钩子（默认关闭）**：在 `baseRow` / `evaluateBaseView` 增加可选
   `options.counters`（或 `onEvaluate` 回调），缺省 `undefined` 时行为与性能完全不变；
   测试传入计数对象即可得到 `formulaEvaluations` / `rowsProjected` / `propertyReads`。
   钩子只加在 canonical 域层一处，MCP/Web adapter 不感知。
2. **per-row/per-formula 计数**：在 `evaluateBaseFormula` 调用点自增
   `formulaEvaluations[formulaName]++`，并断言 `≤ rowsProjected`（dependency 引擎引入后应进一步 `≤ 1`）。
3. **diamond 依赖复用**：W1-B 的 dependency DAG 引入 per-row memo（`Map<formulaName, value>`）后，
   计数 `uniqueEvaluations` 与 `totalRequests`，断言 diamond 图下 `uniqueEvaluations < totalRequests`。
4. **group 是否复制 rows**：W2 grouping 若不新建 row 对象，计数 `rowsCloned`（对 `records.map` 计数）应为 0；
   测试断言分组结果只持有索引/引用。
5. **summary 扫描次数**：W3 对每个 summary×property 计数 `scans`，断言同一 property 只扫一遍（`scans === 1`）。
6. 门禁方式：以上计数器只在测试进程内启用；本刀之后由对应 Wave 的 focused test 断言计数值，
   仍**不设 wall-clock 阈值**（保持 §14.8：硬毫秒阈值须来自同 runner 多次稳定测量）。

## 7. 不变量与确定性证据（测试断言，非计时）

对 10k 与 50k 两档均验证（`verification` 段，见 `perf-raw.json`）：

- 编译：`order` 等于 view 声明列序、`formulas.label` 存在、两次编译序列化一致。
- filter：`totalMatched === count − ceil(count/7)`（8571 / 42857），返回行数一致，且全部 `status !== "archived"`。
- sort：输出是输入的置换、两次结果**逐路径一致**（tie-break 稳定）、首列 `due` 非降序。
- 公式投影：投影行数 = 记录数、两次结果签名一致、抽样 cell 为 `{path, displayName, kind:"asLink"}`、
  缺失 title 的行回退到 `file.name`（displayName 非空）。
- 全管线：`view === "Overview"`、`totalMatched` 正确、`supportedSubset === true`、
  `rows.length === min(5000, matched)`、`truncated === (matched > 5000)`、两次快照签名一致、所有行非 archived。

## 8. 声明与局限

- 本文数字是**单机、单次采样**的本地基线，**不构成任何阈值**；阈值必须来自同一 runner 的多次稳定测量
  （契约 §14.8），且须先扣除宿主机并发负载。
- `rssΔ` / `heapΔ` 在未强制 GC 下只是上限近似；`heapΔ = 0` 属回收假象。
- 本刀只测 canonical 域层（纯函数），**不测 Web/browser、I/O、SQLite、HTTP** 链路；后者属后续 Wave。
- 计时受并发 lane 影响明显（§3 参考样本），复跑应记录当时负载。
