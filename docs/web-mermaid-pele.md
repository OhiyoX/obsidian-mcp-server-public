# 阅读面图表渲染（Pele）

适用范围：Web 阅读面（`/app` Reading view 与 Publish 的 Markdown 渲染）中的 ` ```mermaid ` 围栏。
Live Preview 不渲染图表（本仓历来如此，见 `features/editor/extensions/code-block-flair.js`）。

## 引擎

`pele`（<https://github.com/obsidianmd/pele>，MIT，`app/package.json` 固定 `^1.10.0`）——Obsidian
自带的 Mermaid→SVG 渲染器：同步、零运行时依赖、样式全部走 CSS 变量、能按容器宽度重排。

2026-10-25 业主裁定用它替换 Mermaid（`mermaid@12`，含 elkjs/cytoscape/@mermaid-js/parser 的依赖树）。
随之失效的两条旧口径：

- 「图表与桌面端逐像素/逐字节对齐」——裁定为不需要；
- 「深色主题用 `invert(100%) hue-rotate(180deg)` 反色」——Pele 直接读主题变量。

## 加载与失败

`features/reader/mermaid-lazy.js` 仍是唯一的门：文档里真有 `code.language-mermaid` 才 `import()`
构建出来的 `src/app/assets/mermaid.js`（lazy，不在首屏/deferred 预算里）。渲染成功才移除源码 `<pre>`；
Pele 画不出来时抛错，门保留源码块并补一行可见的错误提示——读者不会丢掉画不出的原文。

## 宽度：宽表同一套出血规则

块宽不是正文列宽，而是复用 `features/document/table-overflow-geometry.js` 里宽表那套对称出血：

1. 第一相按图的**自然宽度**绘制（`maxWidth: NATURAL_WIDTH`），得到块需要的宽度；
2. `computeTableOverflowGeometry(naturalWidth, columnWidth, paneWidth, {pane 与正文列实测边界, safety: TABLE_PANE_SAFETY})`
   算出左右各能伸出多少（永不压到 pane 边、不钻到侧栏下面），写进 `--mermaid-extension`；
3. 第二相按真实块宽重绘，超出 gutters 的部分留在块内，由缩放层平移。

CSS 见 `mermaid-runtime.js` 注入的 `#mermaid-surface-style`（随 chunk 走，不占首屏字节）：
`.mermaid{width:calc(100% + 2*var(--mermaid-extension,0px));margin:1em calc(-1*var(--mermaid-extension,0px))}`。

## 交互（Web 独有）

**不用 Pele 自带的 zoom 层**（`zoom: false`）：它只在 Ctrl/⌘ 按住时才缩放，且「没放大过就不许拖」—— 业主两条要求它都做不到。改用本块自己的 viewBox 视口（`createViewport`）：

- **滚轮直接缩放**（无需修饰键，以光标为锚点，`exp` 曲线，1 档约 1.16×；触控板 ctrl+wheel 走同一条路径）；缩放范围 `1×`（正好铺满块宽）到 `6×`。
- **按住左键拖拽平移**（pointer capture；`is-dragging` 换 grabbing 光标），位移按 viewBox 单位换算，**夹在图形自身边界内**——所以恰好铺满时拖不动（外面没有内容），放大后才有可移动空间。
- 双击切换 1× / 2×，`0`、`Esc` 回 1×，`+` / `-` 键盘缩放；拖拽结束的那一次 click 被吞掉（防止误点图内链接），窗口只有一个 task，之后的正常点击不受影响。
- 右上角工具条：放大 / 缩小 / 重置 / 全屏（`requestFullscreen`，退出时按 `fullscreenchange` 回写 `aria-label`/`title`，全屏下 `--mermaid-extension` 归零）。缩放只改 viewBox，不动元素尺寸 ⇒ **不重排笔记**。
- 代价（明说）：指针在图上时滚轮归图表，页面不滚；离开图表即恢复页面滚动。

## 主题映射

`.mermaid` 上把 Pele 变量接到 vault 语义 token：`--pele-fg:var(--text-normal)`、`--pele-muted`/
`--pele-line:var(--text-muted)`、`--pele-surface:var(--background-secondary)`、`--pele-border:
var(--background-modifier-border)`、`--pele-accent:var(--text-accent)`、`--pele-font:var(--font-mermaid)`
（`--font-mermaid` 由 chunk 在 `:root` 声明为 `var(--font-text)`，桌面同值）。

## 证据与门禁

- 真 Chromium 探针：`node evidence/probe-pele-render.mjs`（读数落在 `evidence/pele-render-mermaid.js.json`）。
- 钉住契约的测试：`app/test/reader-mermaid-lazy.test.js`（引擎、几何、交互、主题映射，且反向断言
  Mermaid 时代的 `initialize`/反色**以及** Pele 自带 zoom 层都不许回归）。
- 体积棘轮：`scripts/web-firstload-baseline.json` 的 `lazyAssets.mermaid.js` 已下调到实测值，理由记在
  `notes` 末条。
