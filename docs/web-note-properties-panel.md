# 笔记属性面板（阅读视图 / Live Preview）结构与桌面对齐登记

本文登记**笔记属性面板**（frontmatter 属性区）在 Web 端的 DOM 结构、几何口径，以及**已复刻**与**未移植**的清单。

## 0. 两套编号，别混（引用纪律）

| 编号体系 | 形式 | 对象 | 怎么读 |
|---|---|---|---|
| **桌面字节偏移** | `app.css@293814` / `app.js@1841778` | `scratch/obsidian-desktop-re/extract/obsidian-asar-1.14.4/` 下的解包文件（`app.css` 668 223 B、`app.js` 3 942 126 B） | **字节偏移**，`grep -obF '<原文>' <file>` 或 Python `data.find(b'<原文>')` 的输出，从文件第 0 字节起算 |
| **本仓行号** | `行 2403` | 本仓 `app/src/app/assets/app.css` 等（**行号会随编辑漂移**） | `grep -n` 的行号，1 起算 |

- 桌面基准：**Obsidian 1.14.4**。桌面侧一律引用**字节偏移**，不引用行号。
- 本仓侧只在引用**我们自己的文件**时用行号，且必须写「行 N」，不得写成 `@N`（两者数量级不同，混写会让后来的读者去错文件里找）。
- 本文里所有桌面偏移都由 lane `desktop-re/pill-max-width-fixup` 在 2026-10-21 用 `grep -obF` / Python 复核过一遍（此前一版几乎全是**行号**，已作废）。

> 为什么有这篇：`#700` 复核指出「多值行 = `.multi-select-container` + 6px」这条 parity 结构**没有任何文档记录**，
> 只有 commit 与基线 ledger 里有。结构一旦再被改（例如有人为了"顺手"调间距），没有文档就没有判据。

## 1. 两个面，同一套口径

| 面 | 渲染方 | 容器类名 | 间距来源 |
|---|---|---|---|
| **阅读视图**（`reader.js`） | `propertiesHtml()` 生成 HTML | `.multi-select-container` 包列表型值 + `.property-pill.multi-select-pill` | 本仓 `app.css`（行 1794 起）：`.preview .metadata-property-value .multi-select-container { display:inline-flex; flex-wrap:wrap; align-items:center; gap:6px; width:100% }` |
| **Live Preview**（`properties-panel.js`） | `createElement` 构建 | `.document-property-pills.cm-live-property-pills` + `.cm-live-tag-pill` | 本仓 `app.css`（行 1843）：`.cm-live-property-pills { display:flex; flex-wrap:wrap; gap:6px }` |

两面的**行距与列距都是 6px**，因为它们对齐的是桌面同一个 token（`--size-2-3`）。

## 2. 桌面口径（1.14.4，**字节偏移**）

| 事实 | 桌面位置（字节偏移） | 原文窗口（实测） |
|---|---|---|
| 多值行容器 `.multi-select-container { display:inline-flex; vertical-align:top; flex-wrap:wrap; flex:1 1 auto; gap:var(--size-2-3); min-height:var(--input-height) }` | `app.css@293814` | 规则首 `.multi-select-container {` |
| `--size-2-3: 6px` | `app.css@86009` | 全文仅此一处 |
| `.metadata-property-value { display:flex; gap:var(--size-2-2); align-items:center; min-height:var(--input-height) }` | `app.css@386681` | 规则首 `.metadata-property-value {` |
| `--size-2-2: 4px` | `app.css@85990` | 全文仅此一处（`--size-2-1: 2px` 在 `@85971`） |
| `.metadata-property-value .multi-select-container` 只把背景/字体改透明，**不动 gap** | `app.css@387544` | 规则体只有 `background-color: transparent;`（同选择器还有一份 `@389606`，只把 `--background-modifier-form-field/border` 改透明并改 `align-items`；别混） |
| `tags` 行的胶囊改为 tag 变量：`--pill-background: var(--tag-background)`、`--pill-padding-*: var(--tag-padding-*)`（`0.65em` / `0.25em`） | `app.css@390925` | 规则首 `.metadata-property-value[data-property-type="tags"] .multi-select-pill {`；锚点 `data-property-type="tags"` = `@390950`、`"tags"` = `@390969` |
| 胶囊本体 `.multi-select-pill { display:flex; align-items:center; line-height:1; gap:var(--size-2-1) }` + **`max-width: calc(100% - var(--size-2-3) - 1ch)`** | `app.css@294001`（`.` 在 294001，`multi-select-pill {` 在 294002）；**`max-width` 行 = `@294431`** | `.multi-select-pill:focus:after` 是另一条规则（`@294526`），别把它的偏移当成钳位 |
| 内容层 `.multi-select-pill-content { word-break: break-word; margin-inline-start: var(--pill-padding-x); overflow: hidden }`（**无** `text-overflow`、**无** `white-space: nowrap`） | `app.css@295174` | `.multi-select-pill-content {` = 295173（带点）/ 295174（无点口径） |
| remove 按钮 `.multi-select-pill-remove-button` | `app.css@295296` | 选择器首字节 |
| 唯一给 `.multi-select-pill-content` 加省略号的规则（`.external-link` / `.internal-link` 支，需 `.metadata-property-value` 祖先） | `app.css@390120` | 第二条选择器行 `@390188`；**属性胶囊不带链接类 ⇒ 不适用 ⇒ 桌面是换行不是省略号** |
| 全局 `* { box-sizing: border-box }` | `app.css@108496` | 胶囊自身不重述（靠这条） |
| 容器在 JS 侧是 `createDiv({cls:"multi-select-container", attr:{tabIndex:-1}})` | `app.js@1841778` | 字符串 `multi-select-container` 起于 `@1841783` |
| 胶囊 / 内容层 / 移除按钮的 DOM | `app.js@1845906` / `@1845965` / `@1847449` | `createDiv({cls:"multi-select-pill"})` / `createDiv({cls:"multi-select-pill-content"})` / `createSpan({text:String(i)})` |

**关键推论**：桌面的折行间距**不是行盒行距**，而是容器的 `gap`。所以"把行高调大一点"不叫复刻；正确做法是用容器 + `gap`。

## 3. 本仓的行结构

> 本节引用**本仓行号**（不是桌面字节偏移）。行号以当前 `main` 上的 `app/src/app/assets/app.css` 为准，会随编辑漂移；判据用选择器，不用行号。

- 行容器：`.document-property-row`（`app.css` **行 2403**）—— `min-height: 30px`、`display:grid`、
  `grid-template-columns: minmax(145px, var(--metadata-label-width, 28%)) minmax(0, 1fr) 22px`、`gap: 8px`、`padding: 4px 5px`；
  只读态少第三列（`22px` 的删除列）。
- 值单元格：`.metadata-property-value` —— 块级，**不是** flex（只做 `min-width: 0`）。
  ⇒ 多值行必须自己包 `.multi-select-container`，否则胶囊退化成 inline 流。
- 单值行（文本 / 日期 / 布尔 / 对象）**不包**容器：包了会改它们的高度与命中区域。

## 4. 为什么会有人来改这里（历史坑）

`#700` 之前，阅读视图把胶囊用 `join(" ")` 拼进 inline 流，容器是普通 block ⇒ **折行间距 = 行盒行距**
（真机实测 **0.00px**，行内只有空格的 `3.56px`）。业主截图看到两行胶囊几乎贴在一起，反馈「胶囊上下间距要优化」。
修法不是调数，而是补上桌面的容器结构 ⇒ 行距/列距同时变成 **6.00px**。

## 5. 已登记的行为差 / 已复刻项（不是 bug，但必须留在账上）

1. **复制/选中文本是换行分隔**：`getSelection().toString()` 得到 `"obsidian\nmcp\narchitecture"`，改前是空格分隔。
   成因：flex 子项 blockify + 容器内**刻意不留空格文本节点**（留了会在 6px `gap` 之上再加一个空格宽）。
   **桌面内部同样没有空格节点 ⇒ 这一行为与桌面一致**，故不回滚；`#700` 复核实测确认（`Range.selectNodeContents` 取到 `obsidian`，内层 `span` 不引入分隔符）。
2. **单个超长胶囊的 `max-width` 钳位 —— 已移植（`ddb7b329`）**：桌面 `.multi-select-pill { max-width: calc(100% - var(--size-2-3) - 1ch) }`（`app.css@294001`，钳位行 `@294431`）
   现已落在本仓共享胶囊声明块（`--size-2-3` 本仓没有 ⇒ 直接写解析值 `6px`；`1ch` = 桌面的 remove-button 留位）。
   配套：`.multi-select-pill-content` 内层（`overflow:hidden` + `word-break:break-word` + 本仓必需的 `white-space: normal`）
   + `.multi-select-container` 的 `width: 100%`（阅读视图容器没有桌面那条 `flex: 1 1 auto`，不定宽则百分比 `max-width` 成环）。
   **桌面同口径 = 钳位到行宽并在胶囊内换行**（不是截断、不是省略号，见 §2 的 `@390120` 门控）。
   实测（真 Chromium 1440×900 / dark）：200 字符 tag ⇒ 阅读胶囊 `457.08 × 60.5`（= 容器 470.09 − 6 − 1ch(7.0078)）、
   `right 1073.98 − cell.right 1087 = −13.02`、无横向滚动；100 字符档阅读 `457.08 × 34.5` / Live `427.08 × 34.5`，`−13.02` 同口径。
   ⚠ 早前本文把这条写成「`max-width` **截断**未移植」——**已过时且语义错**（桌面与现在都是**换行**）。
3. **极窄视口下单个胶囊的换行行为未测**（`width:100%` 在窄单元格 / 移动栈式布局下的表现也未覆盖）。

## 6. 怎么验（不靠肉眼）

```bash
cd app
# 1) 结构：多值行必须由 .multi-select-container 包裹，且容器内无空格文本节点；
#    另外三条 CSS 钉子：钳位 max-width 在、内容层无 text-overflow、（负向）注入 text-overflow 必须红
node --test test/reader-property-pills.test.js
# 2) 行为：点胶囊仍触发 tag: 搜索、Live 面板 × 仍删除
node --test test/document-tag-pills-click.test.js
# 3) 预算：这条结构属于首屏 CSS，改它就要过棘轮
GZIP_LEVEL=9 node --test test/web-firstload-budget.test.js
```

真机几何的判据（真 Chromium，业主主题 Things）：容器 `computed display=inline-flex`、`gap=6px`、`flex-wrap=wrap`；
**相邻两行胶囊的 `rect.top` 差 = 胶囊高 + 6**；同排相邻胶囊水平间隔 = 6。

## 7. 预算归属

这条结构由 `#700` 引入：`firstScreenAssetsGzipBytes 131044 → 131215`（**+171**，全在 `app.css` 31403→31574）、
`deferredAssetsGzipBytes 700587 → 700598`（+11）、`issue414ComparisonGzipBytes 825010 → 825192`。
签字条目在 `app/scripts/web-firstload-baseline.json` 的 `notes`（R29 canonical JSON，**签名绑定数字**）。

其后 `ddb7b329`（胶囊钳位 + 内容层）再加：`app.css` 31574 → **31949**（+375 gzip）、`editor.js` +12 / `reader.js` +14（+26），
合计 **+401**（`131590 / 700624 / 825593`）。**基线未抬、门如实红着**，压注释或签基线是合并前的决策项（见 lane `pill-max-width` 的 `HANDOFF-PILL-MAX-WIDTH.md`
与 `rev-pill-max-width` 的复核报告）。
