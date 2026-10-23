# Obsidian Web 文档视图 — metadata 面板（属性胶囊）与桌面 1.14.4 的差异登记

Status: **registration only**（登记文档，不是承诺）。本文件由 lane `desktop-re/note-props-pills` 的
`BRIEF-PILLS-3` 新增，**零产品改动**：只登记口径与依据，不改 CSS/测试/基线。

> **本文只记 web 文档视图 metadata 面板与桌面的差异；Bases 面的偏离见 `bases/BASES-COMPATIBILITY-MATRIX.md` §14**
> （§14.1 有指向本文的指针行；§14 是 Bases 的真源，本文是 metadata 面板的真源，两边互不复制正文）。

## 1. 面（surface）定义

| 位置 | 选择器 | 备注 |
| --- | --- | --- |
| 阅读视图属性行 | `.preview .metadata-property-value .multi-select-pill[data-tag]` | 扁平标记：胶囊自身带 `data-tag`（无 `.multi-select-pill-content` 包裹层） |
| Live 属性行 | `.cm-live-properties .cm-live-property-pills .cm-live-tag-pill` | 同一套声明块（钉子 ⑥） |
| 行内正文标签（**不属于本面**） | `.preview .tag`（阅读）/ `.cm-obsidian-tag`（Live） | 见 §2 ⓑ 生效范围 |

## 2. 与桌面 1.14.4 的差异登记

### ⓐ `tags` 胶囊 = 桌面皮肤（accent）；非 `tags` 属性 = 桌面中性窄样式 —— **两条都是 parity**

| 项 | 桌面 1.14.4 事实 | 口径 |
| --- | --- | --- |
| `tags` 行胶囊 | `app.css@390969`（选择器 `.metadata-property-value[data-property-type="tags"] .multi-select-pill`）把 `--pill-color/-hover/-remove` ← `--tag-color`、`--pill-background/-hover` ← `--tag-background`、`--pill-border-color(-hover)` ← `--tag-border-color`、`--pill-radius` ← `--tag-radius` | **桌面皮肤 = accent**，本项目按 `--tag-background/--tag-color/--tag-border-color` 走 ⇒ **parity**，不是偏离 |
| 属性类型写入 | 桌面属性渲染器写 `data-property-type`：`app.js@1867854` `this.valueEl.setAttr("data-property-type",c.type)` | accent 皮肤是**按属性类型**分支的，不是「所有胶囊一律 accent」 |
| 非 `tags` 属性（`aliases`/`cssclasses` …） | `app.css@388435`（`.metadata-property-value .multi-select-pill`）：`--pill-border-width:0; --pill-padding-x:0; --pill-padding-y:0; --pill-color:var(--metadata-input-text-color); line-height:var(--line-height-tight)` | **中性、无描边、无水平内缩** ⇒ 本项目同支 ⇒ **parity** |

**落地状态（PILLS-5 核对）**：`fix/note-props-pills` 上 parity 支（tags = 桌面 accent 皮肤 + 桌面几何 `0.875em`；非 tags = 桌面中性窄样式）
已落地于 **`800d8562`**（BRIEF-PILLS-4 的 ① 刀）；**放大已获业主批准并落地于 ② 刀 `fffc4b1c`**（见下节 ⓑ，
为全刀唯一一处有意偏离）。第一轮 `13393e5d` 与第二轮混刀 `37c41726` 都已被拆解，
混刀的 sha 只作对照（不在本分支历史上）。

### ⓑ **已批准（业主 2026-10-20 选 B）：属性胶囊字号/高度放大（业主可读性）**

> **业主 2026-10-20 明确回答「B」= 把「放大」转正**：属性胶囊放大到与行正文同号，**接受它是本刀唯一一处有意偏离桌面**。
> 桌面几何 = `--metadata-input-font-size: var(--font-smaller)` = `0.875em`（≈11.4px 字 / ≈17px 盒高）；
> 我们 = **13px**（行正文）/ 内缩 **8.45px** / 盒高 **≈21.5px** / radius **26px**。
> 回退 = `git revert --no-commit 800d8562..fix/note-props-pills`——① 之后的所有提交一起退（② 的 CSS + 放大钉子，加收尾提交的基线/登记）。
> **实测**（本刀，scratch worktree）：退完树与 ① `800d8562` **逐字节相同**，`reader-property-pills.test.js` 回到 **10/10 绿**；
> 代价是预算回到 ① 的 **122740 / 815862**（= ① 自己的 +55，PILLS-4 §8 未签，棘轮 2 条红）——退 ② 只解决「偏离」，不解决 ① 的 +55。
> **不要只退 `fffc4b1c`**：收尾提交动了钉子与登记两处同一区域，单退会在 `app/test/reader-property-pills.test.js` 与本文档冲突（已实测）。
> 首屏预算：基线 122685 / ① 122740 (+55) / ② 122798 (+113)；协调席 §5.9 已签字，**基线已按 ② 的实测值上调为 122798 / 815920**
> （签字的 +137 量自被拆掉的混刀 `37c41726`，其 app.css 注释长 104 raw 字节；拆刀时同刀压掉了 ⇒ 实测比签字低 24 gzip，见 lane `HANDOFF.md`）。

| 量 | 桌面 1.14.4 | 已批准 ②（放大，`fffc4b1c`） | 回退目标 ①（parity，`800d8562`） | 依据 |
| --- | --- | --- | --- |
| 胶囊字号 | `--metadata-input-font-size: var(--font-smaller)` = `0.875em`（`app.css@80359`；消费点 `app.css@389421` `.metadata-property-value .multi-select-container{font-size:var(--metadata-input-font-size)}`）⇒ 13px 行正文下 ≈ **11.375px** | **13px**（= 属性行正文，胶囊不写 `font-size`，继承行字号）——**偏离 1 处** | **11.375px**（`font-size: var(--tag-size)` = `0.875em`） | `app.css@80359` + `@389421` |
| 胶囊高度 | ≈ **17px** | ≈ **21.5px**（阅读；Live 22.5px） | ≈ **17.06px**（阅读，无描边） | 同上 + `--pill-padding-y:0.25em`、`--pill-radius:2em` |
| 水平内缩 | `--pill-padding-x:0.65em` 记在 `.multi-select-pill-content`（`app.css@153346` 一族），随胶囊自身字号 ⇒ 0.65×11.375 ≈ 7.39px | 同一 token，但字号已放大 ⇒ 0.65×13 = **8.45px** | 随 `0.875em` ⇒ **7.39px** | 同 ⓑ |

- **原因**：**业主可读性诉求（原话「胶囊有点小了」）**——桌面自己的属性胶囊比该行正文小一号（0.875em），
  在 web 阅读视图里偏小；业主要求两次后，2026-10-20 选 **B** 拍板转正。
- **生效范围**：**仅属性胶囊**（§1 前两行）；行内 `#tag`（正文引用）**不受影响**，仍 14px/accent 皮肤。
- **性质**：这是**已批准的审美偏离**，**不是 parity**；桌面几何 = 0.875em + accent 皮肤（= 回退目标 ① `800d8562`）。
  全刀**唯一一处**有意偏离：桌面 `0.875em` / ≈17px ↔ 我们 `13px` / ≈21.5px（皮肤仍桌面保真）。
  口径已锁进 `app/test/reader-property-pills.test.js`：放大几何三条是**默认断言**，负控 = 把 `font-size` 写回 `0.875em`（注入即红）。
- **回退方法**：`git revert --no-commit 800d8562..fix/note-props-pills`（② + 收尾提交一起退；实测树 = ① `800d8562` 逐字节相同、钉子 10/10 绿；单退 `fffc4b1c` 会冲突，见上）。② 的 CSS 面 = 胶囊声明块去 `font-size`
  + 加 `1px solid var(--tag-border-color)` 描边 + 非 tags 支补 `border: 0`。

## 3. 偏移是怎么取的（引用纪律）

- `@388435` / `@390969` / `@80359` / `@389421` / `@153346` 都是 **`app.css` 的字符偏移**（`grep -ob` 或 Python 取窗），
  对象是 `obsidian-1.14.4.asar` 解出的 `app.css`（本机 `<local-desktop-research>/extract/obsidian-asar-1.14.4/app.css`，668 223 字节）。
- `@1862953` 引用的是 **minified `app.js`**（3 942 126 字节），**不是 `app.css`**——按 app.css 取窗取空属正常
  （`app.css` 里 `data-property-type` 只出现在选择器 `@390950`）。
- 本机复核（`BRIEF-PILLS-3`，Python 取窗）：`@80359` `--metadata-input-font-size: var(--font-smaller)` ✓、
  `@388435` 非 tags 中性支 ✓、`@389421` `font-size:var(--metadata-input-font-size)` ✓、`@390969` tags accent 支 ✓。
  两个次要差：`--font-smaller: 0.875em` 实测 **@68327**，`.multi-select-pill` 实测 **@294001**
  （lane 早前记 `@68325`/`@293993`，2/8 字节差，属取窗口径差，不改语义）；
  `data-property-type` 的实际写入点实测 **`app.js@1867854`**（早前记的 `@1862953` 窗口落在同文件邻近的
  label type-mismatch warning 代码上，**引用文件仍是 app.js**，不是 app.css）。

## 4. 并排截图要求（业主拍板用，契约）

> 业主 2026-10-20 已用这两张并排图拍板（选 **B**，见 §2 ⓑ）；本节仍是产出素材时的硬约束。

- 条件：**同一篇文档、同一主题（暗色）、同一缩放（100%）**。
- 两张图 **同尺寸裁切**（**同一起止坐标**），否则放大对比不成立。
- 文件名：`pills-DESKTOP-geometry.png`（桌面口径：`0.875em`/accent 皮肤）与
  `pills-LARGER-geometry.png`（放大口径：13px/≈21.5px 高）。
- **不得暗示我们截过桌面**：本项目没有桌面运行时截图能力范围内的 Obsidian 截图；桌面口径是**按 asar CSS 复算的几何**，
  我们的两张图都是**本项目自己渲染的两种口径**（真 Chromium）。若产出只覆盖我们自己的两种口径，
  必须显式写「**没有桌面运行时截图，桌面口径是按 asar CSS 复算的几何**」。
- 工件位置：lane 根 `worktrees/desktop-re/note-props-pills/`（`evidence/` 保留原始全尺寸与探测 JSON）。
