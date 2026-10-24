import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deployedVersion, formatDeployTime, releaseFooterLines } from "../release-version.js";

// Immutable assets need content-specific URLs after each deployment.
const assetVersions = new Map();
function assetUrl(name) {
  if (!assetVersions.has(name)) {
    const bytes = readFileSync(new URL(`./assets/${name}`, import.meta.url));
    assetVersions.set(name, createHash("sha256").update(bytes).digest("hex").slice(0, 16));
  }
  return `/app/assets/${name}?v=${assetVersions.get(name)}`;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// U38 (#571): the sprite is answered with the one-year `immutable` asset policy, so a symbol
// added after a client cached the file would never resolve (the #568 blank white box). Every
// sprite reference therefore carries the same content hash as the `assetUrl()` publish point.
const icon = (name, className = "svg-icon") => `<svg class="${className}" aria-hidden="true"><use href="${assetUrl("icons.svg")}#${name}"></use></svg>`;

// U6 file-panel-head additions. Inline (not added to the shared sprite) so this
// slice stays inside its owned files; `.svg-icon` supplies size/stroke.
const folderPlusIcon = `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/></svg>`;
// chevrons-down-up: two chevrons pointing toward each other = "collapse all".
const collapseAllIcon = `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 5 5 5-5"/><path d="m7 20 5-5 5 5"/></svg>`;

/**
 * Login page follows the default vault appearance (color mode + community theme)
 * so anonymous visitors see the same chrome as the signed-in workspace.
 *
 * The default `next` is the slash-bearing app root: the installed app resolves its manifest
 * `scope` to `/app/`, so the post-login landing page must be inside it (#471).
 */
export function loginPage(error = "", appearance = {}, next = "/app/") {
  const colorMode = ["dark", "light", "system"].includes(appearance.colorMode) ? appearance.colorMode : "system";
  const themeId = typeof appearance.themeId === "string" ? appearance.themeId.trim() : "";
  const initialClass = colorMode === "dark" ? "theme-dark" : "theme-light";
  const themeLink = themeId
    ? `<link id="community-theme" rel="stylesheet" href="/auth/theme.css?name=${encodeURIComponent(themeId)}">`
    : "";
  return `<!doctype html>
<html lang="zh-CN" class="${initialClass}" data-color-mode="${html(colorMode)}" data-desktop-color-mode="${html(colorMode)}"${themeId ? ` data-theme="${html(themeId)}"` : ""} data-icon-sprite="${assetUrl("icons.svg")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
<script src="${assetUrl("login.js")}"></script>
<title>登录 · Obsidian Web</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="${assetUrl("reader.css")}">
<link rel="stylesheet" href="${assetUrl("app.css")}">
${themeLink}
</head>
<body class="${initialClass}">
<main class="login-page">
<section class="login-card">
<div class="mark">O</div>
<h1>Obsidian Web</h1>
<p>使用 Obsidian 账户登录。管理密码、API Key 和 MCP Token 不适用于此处。</p>
${error ? `<p class="error-text">${html(error)}</p>` : ""}
<form method="post" action="/auth/login">
<input type="hidden" name="next" value="${html(next)}">
<label>用户名<input name="username" autocomplete="username" required autofocus></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">登录</button>
</form>
</section>
</main>
</body>
</html>`;
}

export function appPage(session, appearance = {}, initialNote = null, initialBase = null, initialCanvas = null) {
  const colorMode = ["dark", "light", "system"].includes(appearance.colorMode) ? appearance.colorMode : "system";
  const themeId = typeof appearance.themeId === "string" ? appearance.themeId.trim() : "";
  const initialClass = colorMode === "dark" ? "theme-dark" : "theme-light";
  const themeLink = themeId
    ? `<link id="community-theme" rel="stylesheet" href="/api/web/v1/theme.css?name=${encodeURIComponent(themeId)}">`
    : `<link id="community-theme" rel="stylesheet" disabled href="">`;
  const initial = [
    initialNote
      ? `<meta name="initial-note-path" content="${html(initialNote.path)}"><meta name="initial-note-vault" content="${html(initialNote.vaultId)}">`
      : "",
    initialBase
      ? `<meta name="initial-base-path" content="${html(initialBase.path)}"><meta name="initial-base-vault" content="${html(initialBase.vaultId)}">`
      : "",
    // G11: a `.canvas` document page publishes the same shape and the on-demand
    // canvas asset. A page without a canvas target emits neither, so the workspace
    // shell (`/app`, `/app/note/*`, `/app/base/*`) is byte-identical to before and
    // never references canvas.js (the zero-request evidence in the lane HANDOFF).
    initialCanvas
      ? `<meta name="initial-canvas-path" content="${html(initialCanvas.path)}"><meta name="initial-canvas-vault" content="${html(initialCanvas.vaultId)}">`
      : "",
  ].filter(Boolean).join("");
  // Settings reports the release the NAS actually runs, so a deployed build is
  // identifiable from the UI without keeping deployment metadata in navigation chrome.
  const release = deployedVersion();
  const formatted = formatDeployTime(release.deployedAt);
  // #503: the footer renders two lines — release identity, then the process clock
  // (production is UTC). The raw ISO rides on the deploy line so the browser can
  // replace that text with Beijing time; without script the UTC line stays.
  const footerFace = releaseFooterLines(release);
  const deployIso = formatted.iso ? ` data-deployed-at="${html(formatted.iso)}"` : "";
  const commitPart = release.commit ? `commit ${release.commit}` : "";
  const releaseTitle = ["部署版本", release.version, commitPart, formatted.label].filter(Boolean).join(" · ");
  const extra = `<script src="${assetUrl("theme-boot.js")}"></script><meta name="csrf-token" content="${html(session.csrf)}">${initial}`;
  // #369: the app shell is the page that consumes `env(safe-area-inset-*)` (`--app-inset-top` in
  // app.css), and those insets only resolve to a non-zero value on a notched device when the
  // viewport meta opts into the full canvas. The anonymous login/publish pages have their own
  // meta and are deliberately not changed here.
  // #471 (P1): install metadata. The manifest and both icons are content-addressed like every
  // other shell asset, so a redeploy that changes one is picked up instead of waiting out the
  // one-year immutable policy. `/app`, `/app/note/*` and `/app/base/*` render this same head and
  // therefore share one manifest; the anonymous login page keeps its own head (no manifest) and
  // Publish keeps its own independent CSP. `black-translucent` lets iOS content flow under the
  // status bar, which is only safe because the shell already consumes `env(safe-area-inset-top)`
  // through the single `--app-inset-top` owner in app.css (#371); the `pwa:` checks in
  // scripts/web-regression/pwa-install.mjs measure that the owner really reacts to a non-zero
  // inset, and the app/note/Base shells all keep the `viewport-fit=cover` prerequisite.
  const installMeta = [
    `<link rel="manifest" href="${assetUrl("manifest.webmanifest")}">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${assetUrl("apple-touch-icon-180.png")}">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
    `<meta name="apple-mobile-web-app-title" content="Obsidian Web">`,
  ].join("");
  const appHead = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff">${extra}<title>Obsidian Web</title>${installMeta}<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="${assetUrl("reader.css")}"><link rel="stylesheet" href="${assetUrl("app.css")}">${themeLink}</head>`;
  return `<!doctype html>
<html lang="zh-CN" class="${initialClass}" data-color-mode="${html(colorMode)}" data-desktop-color-mode="${html(colorMode)}"${themeId ? ` data-theme="${html(themeId)}"` : ""} data-icon-sprite="${assetUrl("icons.svg")}">
${appHead}
<body class="${initialClass} is-desktop">
  <div class="shell app-container horizontal-main-container">
    <aside class="ribbon workspace-ribbon side-dock-ribbon mod-left" aria-label="工作区">
      <button id="files-toggle" class="icon-btn active" title="显示或隐藏文件列表" aria-label="显示或隐藏文件列表">${icon("panel-left")}</button>
      <div class="ribbon-spacer"></div>
    </aside>
    <aside class="sidebar workspace-split mod-horizontal mod-left-split">
      <!-- U29 (#371): both side panes share one header shape — the view switcher plus one
           pane-level close control (the ✕ is a pane control, so it left the Files panel head).
           It delegates to the very same sidebar-panels toggle the ribbon uses. -->
      <div class="sidebar-head">
        <div class="sidebar-tabs" role="tablist" aria-label="左侧栏面板" data-pane-slot="switch">
          <button class="sidebar-tab is-active" type="button" role="tab" data-sidebar-tab="files" aria-selected="true" aria-controls="panel-files" title="文件" aria-label="文件">${icon("folder")}</button>
          <button class="sidebar-tab" type="button" role="tab" data-sidebar-tab="search" aria-selected="false" aria-controls="panel-search" title="搜索" aria-label="搜索">${icon("search")}</button>
        </div>
        <button id="panel-close" class="icon-btn pane-head-close" type="button" title="折叠侧栏" aria-label="折叠侧栏" data-pane-slot="close">${icon("x")}</button>
      </div>
      <section id="panel-files" class="sidebar-panel" role="tabpanel" data-sidebar-panel="files" aria-label="文件">
      <div class="panel-head" data-panel-head="files" data-explorer-mode="tree" data-pane-slot="actions">
        <button id="new-note" class="icon-btn" type="button" title="新建笔记" aria-label="新建笔记">${icon("square-pen")}</button>
        <button id="new-folder" class="icon-btn" type="button" title="新建文件夹" aria-label="新建文件夹">${folderPlusIcon}</button>
        <div class="sidebar-actions" role="toolbar" aria-label="文件工具">
          <button id="explorer-sort-toggle" class="icon-btn" type="button" title="排序：文件名 (A-Z)" aria-label="排序：文件名 (A-Z)" aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-sort-menu">${icon("arrow-up-narrow-wide")}</button>
          <button id="reveal-active" class="icon-btn" type="button" title="定位当前文件" aria-label="定位当前文件">${icon("gallery-vertical")}</button>
          <!-- #421: a one-shot shortcut, not a toggle. Clicking it always runs the same
               preset query (published:true) and hands the reader to the Search panel,
               so the control must not carry aria-pressed: the panel it lives in is not
               the one on screen once it has done its job (audit §7, seat ruling (a)). -->
          <button id="publishes-open" class="icon-btn" type="button" title="搜索已 Publish 文档" aria-label="搜索已 Publish 文档">${icon("globe-2")}</button>
        </div>
        <!-- Phase 2 flat view is a user-specified Web enhancement: the desktop file
             explorer has no flat mode, so this control reuses the existing list-tree
             glyph and the existing icon-button/menu pattern instead of inventing a
             desktop affordance. CSS (data-explorer-mode on this head) shows exactly
             one sort trigger per mode. -->
        <button id="explorer-mode-toggle" class="icon-btn" type="button" title="浏览模式：树状视图" aria-label="浏览模式：树状视图" aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-mode-menu">${icon("list-tree")}</button>
        <div class="explorer-sort-menu explorer-mode-menu" id="explorer-mode-menu" role="menu" aria-label="浏览模式" hidden>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="true" data-explorer-mode="tree"><span class="explorer-sort-option-label">树状视图</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-explorer-mode="flat"><span class="explorer-sort-option-label">平铺视图</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
        </div>
        <button id="explorer-flat-sort-toggle" class="icon-btn" type="button" title="排序：编辑时间 (从新到旧)" aria-label="排序：编辑时间 (从新到旧)" aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-flat-sort-menu">${icon("arrow-up-narrow-wide")}</button>
        <div class="explorer-sort-menu" id="explorer-flat-sort-menu" role="menu" aria-label="平铺排序" hidden>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="true" data-flat-sort="modified:desc"><span class="explorer-sort-option-label">编辑时间 (从新到旧)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="modified:asc"><span class="explorer-sort-option-label">编辑时间 (从旧到新)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="path:asc"><span class="explorer-sort-option-label">路径 (A-Z)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="path:desc"><span class="explorer-sort-option-label">路径 (Z-A)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="name:asc" data-requires-query="true"><span class="explorer-sort-option-label">文件名 (A-Z)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="name:desc" data-requires-query="true"><span class="explorer-sort-option-label">文件名 (Z-A)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="score:asc" data-requires-query="true"><span class="explorer-sort-option-label">相关度 (最相关在前)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="score:desc" data-requires-query="true"><span class="explorer-sort-option-label">相关度 (最不相关在前)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
        </div>
        <button id="collapse-all" class="icon-btn" type="button" title="折叠全部" aria-label="折叠全部">${collapseAllIcon}</button>
        <div class="explorer-sort-menu" id="explorer-sort-menu" role="menu" aria-label="笔记排序" hidden>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="true" data-sort-key="name" data-sort-direction="asc"><span class="explorer-sort-option-label">文件名 (A-Z)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-sort-key="name" data-sort-direction="desc"><span class="explorer-sort-option-label">文件名 (Z-A)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-sort-key="modified" data-sort-direction="desc"><span class="explorer-sort-option-label">编辑时间 (从新到旧)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-sort-key="modified" data-sort-direction="asc"><span class="explorer-sort-option-label">编辑时间 (从旧到新)</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
        </div>
      </div>
      <div id="files-status" class="search-status" role="status" aria-live="polite"></div>
      <nav id="note-list" class="note-list nav-files-container" aria-label="笔记"></nav>
      </section>
      <section id="panel-search" class="sidebar-panel" role="tabpanel" data-sidebar-panel="search" aria-label="搜索" hidden>
      <div class="panel-head search-panel-head" data-panel-head="search" data-pane-slot="actions">
        <div class="search-row">
          <div class="search-input-shell">
            <input id="search" class="search" type="search" placeholder="搜索笔记…" autocomplete="off" aria-describedby="search-status">
            <div class="search-input-actions" aria-label="搜索选项">
              <button id="search-clear" class="search-input-action search-clear" type="button" title="清除搜索" aria-label="清除搜索" hidden>${icon("x")}</button>
              <button id="search-case" class="search-input-action search-case" type="button" title="区分大小写" aria-label="区分大小写" aria-pressed="false">Aa</button>
            </div>
          </div>
          <button id="semantic-search" class="search-tool search-meaning" type="button" aria-pressed="false" title="在普通搜索之外使用语义相似度；file:、tag: 等筛选仍然生效">使用语义</button>
          <details class="search-help">
            <summary class="search-tool" title="搜索语法" aria-label="查看搜索语法">${icon("circle-help")}</summary>
            <div class="search-help-card">
              <div class="search-help-title">Obsidian 搜索语法</div>
              <p class="search-help-intro">默认使用普通搜索；开启“使用语义”后，会在精确结果之外补充意思相近的内容。</p>
              <span class="search-example">path:文件夹</span><span>路径包含</span>
              <span class="search-example">file:名称</span><span>文件名包含</span>
              <span class="search-example">tag:项目</span><span>标签及子标签</span>
              <span class="search-example">line:&quot;多个词&quot;</span><span>同一行</span>
              <span class="search-example">section:内容</span><span>同一标题区段</span>
              <span class="search-example">[status]</span><span>属性存在</span>
              <span class="search-example">[status:done]</span><span>属性值</span>
              <p>空格表示 AND；也可使用 OR、-排除和引号短语。</p>
            </div>
          </details>
        </div>
      </div>
      <div id="search-status" class="search-status" role="status" aria-live="polite"></div>
      <nav id="search-list" class="note-list search-list" aria-label="搜索结果"></nav>
      </section>
      <footer class="sidebar-footer">
        <div class="vault-switcher">
          <label for="vault-select" class="vault-label">
            <select id="vault-select" class="vault-select" data-select aria-label="切换 Vault"><option>正在读取…</option></select>
          </label>
          <button id="vault-create" class="icon-btn" type="button" title="创建 Vault" aria-label="创建 Vault">${icon("database")}</button>
          <button id="settings-open" class="icon-btn" type="button" title="设置" aria-label="打开设置">${icon("settings")}</button>
          <form class="sidebar-logout" method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value="${html(session.csrf)}">
            <button class="icon-btn" type="submit" title="退出 ${html(session.username)}" aria-label="退出 ${html(session.username)}">${icon("log-out")}</button>
          </form>
        </div>
      </footer>
    </aside>
    <div id="left-pane-resizer" class="pane-resizer pane-resizer-left" role="separator" aria-label="调整文件视图宽度" aria-orientation="vertical" aria-valuemin="190" aria-valuemax="520" aria-valuenow="270" tabindex="0"></div>
    <div class="scrim"></div>
    <main class="workspace workspace-split mod-vertical mod-root">
      <!-- U29 (#371): the topbar is the one workspace chrome band that is always in the layout
           (the welcome workspace keeps a single bar); #sidebar-toggle moved into its actions so
           it stays a layout-layer control outside the rail (U18), reachable while the rail is
           collapsed. The document tab row is the second, conditional band below it. -->
      <header class="topbar view-header">
        <button id="menu" class="icon-btn mobile-menu" title="打开文件列表" aria-label="打开文件列表">${icon("menu")}</button>
        <div id="current-path" class="current-path view-header-title">尚未打开笔记</div>
        <span id="reconnect-host" class="reconnect-host"></span>
        <!-- U46 (#422): #status stays the visible session readout but sits outside the polite
             .topbar-status live region, so a failure is announced once (by the toast). -->
        <span id="status" class="status"></span>
        <div class="topbar-actions">
          <div class="topbar-status" aria-live="polite">
          <span id="live-status" class="live-status" title="文件实时同步状态" aria-label="实时同步"></span>
          <span id="live-status-label" class="live-status-label">连接中</span>
          </div>
          <button id="save" class="primary mod-cta" type="button" title="保存" aria-label="保存" disabled><span class="save-label">保存</span>${icon("check", "svg-icon save-icon")}</button>
          <div class="view-mode topbar-view-mode">
            <button class="icon-btn view-mode-toggle" type="button" title="切换视图" aria-label="切换视图" aria-haspopup="menu" aria-expanded="false">${icon("book-open")}</button>
            <div class="view-mode-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" class="view-mode-item" data-mode="preview" aria-checked="true">${icon("book-open")}<span>阅读视图</span><span class="view-mode-check" aria-hidden="true">${icon("check")}</span></button>
              <button type="button" role="menuitemradio" class="view-mode-item" data-mode="raw" aria-checked="false">${icon("code")}<span>源码模式</span><span class="view-mode-check" aria-hidden="true">${icon("check")}</span></button>
              <button type="button" role="menuitemradio" class="view-mode-item" data-mode="live" aria-checked="false">${icon("pen")}<span>实时预览</span><span class="view-mode-check" aria-hidden="true">${icon("check")}</span></button>
            </div>
          </div>
          <div class="document-actions">
            <button id="document-actions-toggle" class="icon-btn document-actions-toggle" type="button" title="文档操作" aria-label="文档操作" aria-haspopup="menu" aria-expanded="false">${icon("more-vertical")}</button>
            <div id="document-actions-menu" class="document-actions-menu" role="menu" hidden>
              <button class="document-action-item" data-document-link type="button" role="menuitem" disabled>${icon("link")}<span>复制文档链接</span></button>
              <button class="document-action-item" data-publish-toggle type="button" role="menuitem" aria-pressed="false" disabled>${icon("globe-2")}<span class="document-action-label">Publish</span><span class="document-action-state" aria-hidden="true"></span></button>
            </div>
          </div>
          <button id="sidebar-toggle" class="icon-btn document-rail-toggle" type="button" title="隐藏右侧栏" aria-label="隐藏右侧栏" aria-pressed="true" aria-controls="context-sidebar">${icon("panel-right")}</button>
        </div>
      </header>
      <!-- U29 (#371): the tab row stays in the DOM (the U18 seam keeps its anchor and the strip
           keeps features/tabs as its only writer), but it only enters the layout while the
           strip really has a tab: features/explorer mirrors the committed tab model onto
           .has-document-tabs on .workspace. Tabs are rendered by features/tabs from the
           session's current document (v1: notes only, session-scoped, no persistence). -->
      <div class="document-tab-row">
        <div id="document-tabs" class="document-tabs" role="tablist" aria-label="打开的文档"></div>
      </div>
      <section class="document workspace-leaf-content view-content">
        <div id="base-host" hidden></div>
        ${initialCanvas ? `<div id="canvas-host" hidden></div>` : ""}
        <div id="editor" class="editor markdown-source-view mod-cm6 cm-s-obsidian is-readable-line-width" hidden aria-label="Markdown 编辑器"></div>
        <article id="preview" class="preview markdown-reading-view"><div class="markdown-preview-view markdown-rendered markdown-preview-sizer markdown-preview-section is-readable-line-width"><div class="welcome"><h1>欢迎回来，${html(session.displayName || session.username)}</h1><p>从左侧选择笔记，或创建一篇新笔记。使用 Ctrl/⌘ + S 保存。</p></div></div></article>
        <!-- Issue #430: the single word-count badge instance. It lives in the document pane
             (never inside .preview/.cm-scroller, which own scrolling and Reader/Live geometry),
             is hidden by default and is driven only by features/session/status-presenter.js. -->
        <button id="word-count-badge" class="word-count-badge" type="button" hidden><span class="word-count-badge-words"></span><span class="word-count-badge-characters"></span></button>
      </section>
    </main>
    <div id="right-pane-resizer" class="pane-resizer pane-resizer-right" role="separator" aria-label="调整大纲视图宽度" aria-orientation="vertical" aria-valuemin="190" aria-valuemax="520" aria-valuenow="250" tabindex="0"></div>
    <aside id="context-sidebar" class="context-sidebar workspace-split mod-horizontal mod-right-split" aria-label="笔记上下文">
      <!-- U18 + U29 (#371): the rail header is the panel layer. #context-drawer-close is the
           pane-level close of the pane header (the same shape the left pane exposes), and it
           delegates to the one rail state in pane-layout; the topbar #sidebar-toggle is the one
           layout-layer entry (#398 removed the ⋮ item that used to duplicate it). -->
      <header class="context-header context-view-header">
        <div class="context-view-switcher" role="tablist" aria-label="笔记上下文视图" data-pane-slot="switch">
          <button class="icon-btn context-view-btn is-active" type="button" role="tab" data-context-view="outline" aria-selected="true" aria-controls="context-view-outline" title="大纲" aria-label="大纲">${icon("list-tree")}</button>
          <button class="icon-btn context-view-btn" type="button" role="tab" data-context-view="outgoing" aria-selected="false" aria-controls="context-view-outgoing" title="当前笔记中的链接" aria-label="当前笔记中的链接">${icon("link-out")}</button>
          <button class="icon-btn context-view-btn" type="button" role="tab" data-context-view="incoming" aria-selected="false" aria-controls="context-view-incoming" title="链接当前笔记" aria-label="链接当前笔记">${icon("link-in")}</button>
          <button class="icon-btn context-view-btn" type="button" role="tab" data-context-view="tags" aria-selected="false" aria-controls="context-view-tags" title="标签" aria-label="标签">${icon("tag")}</button>
        </div>
        <button id="context-drawer-close" class="icon-btn pane-head-close" type="button" title="折叠笔记上下文" aria-label="折叠笔记上下文" data-pane-slot="close">${icon("x")}</button>
      </header>
      <section id="context-view-outline" class="context-view" data-context-view-panel="outline" role="tabpanel" aria-label="大纲">
        <nav id="outline-list" class="outline-list" aria-label="当前笔记大纲"><div class="context-empty">打开笔记后显示大纲与反链</div></nav>
      </section>
      <section id="context-view-outgoing" class="context-view" data-context-view-panel="outgoing" role="tabpanel" aria-label="当前笔记中的链接" hidden>
      <header class="context-header context-panel-head" data-context-panel="outgoing" data-pane-slot="actions">
        <button id="unlinked-toggle" class="icon-btn context-panel-toggle" type="button" title="隐藏未链接提及" aria-label="隐藏未链接提及" aria-pressed="true" aria-controls="unlinked-list">${icon("book-open")}</button>
        <button id="outgoing-menu-toggle" class="icon-btn context-section-menu-toggle" type="button" title="选项" aria-label="当前笔记中的链接 选项" aria-haspopup="menu" aria-expanded="false">${icon("more-vertical")}</button>
        <div class="context-section-menu" role="menu" aria-label="当前笔记中的链接 选项" hidden>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="collapse">折叠</button>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="refresh">刷新</button>
        </div>
      </header>
      <header class="context-header context-section-header" data-context-section="outgoing">
        <span class="context-title">当前笔记中的链接</span>
        <span class="context-section-count" data-context-count="outgoing">0</span>
      </header>
      <nav id="outgoing-list" class="outline-list outgoing-list" aria-label="当前笔记中的链接"><div class="context-empty">打开笔记后显示出链</div></nav>
      <div id="context-rail-splitter" class="context-rail-splitter" role="separator" aria-orientation="horizontal" aria-label="调整「链接」与「潜在链接」的高度" tabindex="0"></div>
      <header class="context-header context-section-header unlinked-header" data-context-section="unlinked">
        <span class="context-title">当前笔记中潜在的链接</span>
        <span class="context-section-count" data-context-count="unlinked">0</span>
      </header>
      <nav id="unlinked-list" class="outline-list unlinked-list" aria-label="当前笔记中潜在的链接"><div class="context-empty">打开笔记后显示潜在的链接</div></nav>
      </section>
      <section id="context-view-incoming" class="context-view" data-context-view-panel="incoming" role="tabpanel" aria-label="链接当前笔记" hidden>
      <header class="context-header context-panel-head" data-context-panel="incoming" data-pane-slot="actions">
        <button id="incoming-menu-toggle" class="icon-btn context-section-menu-toggle" type="button" title="选项" aria-label="链接当前笔记 选项" aria-haspopup="menu" aria-expanded="false">${icon("more-vertical")}</button>
        <div class="context-section-menu" role="menu" aria-label="链接当前笔记 选项" hidden>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="collapse">折叠</button>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="refresh">刷新</button>
        </div>
      </header>
      <header class="context-header context-section-header" data-context-section="incoming">
        <span class="context-title">链接当前笔记</span>
        <span class="context-section-count" data-context-count="incoming">0</span>
      </header>
      <nav id="incoming-list" class="outline-list incoming-list" aria-label="链接当前笔记"><div class="context-empty">打开笔记后显示反向链接</div></nav>
      </section>
      <section id="context-view-tags" class="context-view" data-context-view-panel="tags" role="tabpanel" aria-label="标签" hidden>
      <header class="context-header context-panel-head tags-header" data-context-panel="tags" data-context-section="tags" data-pane-slot="actions">
        <span class="context-title">标签</span>
        <div class="context-view-tools tags-tools" role="toolbar" aria-label="标签工具">
          <button id="tags-sort-toggle" class="icon-btn tags-sort-toggle" type="button" title="排序" aria-label="标签排序" aria-haspopup="menu" aria-expanded="false" aria-controls="tags-sort-menu">${icon("chevrons-up-down")}</button>
          <button id="tags-filter-toggle" class="icon-btn tags-filter-toggle" type="button" title="筛选标签" aria-label="筛选标签" aria-pressed="false" aria-controls="tags-filter">${icon("search")}</button>
          <div id="tags-sort-menu" class="tags-sort-menu" role="menu" aria-label="标签排序" hidden>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="true" data-tags-sort="count">按数量</button>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="false" data-tags-sort="name">按名称</button>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="true" data-tags-direction="desc">降序</button>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="false" data-tags-direction="asc">升序</button>
          </div>
        </div>
      </header>
      <div class="tags-filter-row" hidden><input id="tags-filter" class="tags-filter" type="search" placeholder="筛选标签…" autocomplete="off" aria-label="筛选标签"></div>
      <nav id="tags-list" class="outline-list tags-list" aria-label="标签"><div class="context-empty">没有标签</div></nav>
      </section>
    </aside>
  </div>
  <dialog id="settings-dialog" class="settings-dialog">
    <header><div><h2>设置</h2><p>Obsidian Web 的显示偏好保存在当前浏览器。</p></div><button id="settings-close" class="icon-btn" aria-label="关闭设置">${icon("x")}</button></header>
    <nav aria-label="设置分类"><button class="settings-tab active" type="button">外观</button></nav>
    <section class="settings-pane" aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">外观</h3>
      <div class="setting-item"><div><span class="setting-label">颜色模式</span><p>跟随桌面端、系统，或强制浅色/深色。</p></div><label><span class="sr-only">颜色模式</span><select id="color-mode" data-select title="颜色模式"><option value="desktop">桌面端</option><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>
      <div class="setting-item"><div><span class="setting-label">主题</span><p>兼容 Vault 中的标准 Obsidian 社区主题。</p></div><label><span class="sr-only">主题</span><select id="theme-select" data-select><option value="Things">Things</option></select></label></div>
    </section>
    <footer class="settings-meta" title="${html(releaseTitle)}"><span>Obsidian Web</span><span class="settings-meta-version"><span class="settings-meta-release">${html(footerFace.release)}</span><span class="settings-meta-deploy"${deployIso}>${html(footerFace.deploy)}</span></span></footer>
  </dialog>
  <script src="${assetUrl("app-loader.js")}" data-editor-src="${assetUrl("editor.js")}" data-reader-src="${assetUrl("reader.js")}" data-app-src="${assetUrl("app.js")}" data-mermaid-src="${assetUrl("mermaid.js")}" data-kanban-src="${assetUrl("kanban.js")}" defer></script>
  ${initialCanvas ? `<script type="module" src="${assetUrl("canvas.js")}" data-canvas-path="${html(initialCanvas.path)}" data-canvas-vault="${html(initialCanvas.vaultId)}"></script>` : ""}
</body></html>`;
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function publishPage({ title, content, publishedAt }) {
  return `<!doctype html>
<html lang="zh-CN" class="theme-light" data-color-mode="system" data-desktop-color-mode="system" data-icon-sprite="${assetUrl("icons.svg")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${html(title)} · Published note</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script src="${assetUrl("theme-boot.js")}"></script>
<link rel="stylesheet" href="${assetUrl("reader.css")}">
<link rel="stylesheet" href="${assetUrl("app.css")}">
<link rel="stylesheet" href="${assetUrl("publish.css")}">
</head>
<body>
<main class="publish-shell">
<header class="publish-head"><div class="publish-heading"><h1>${html(title)}</h1><div class="publish-meta">公开只读文档 · ${html(publishedAt || "")}</div></div><button id="publish-theme-toggle" class="publish-theme-toggle" type="button" data-target-mode="dark" title="切换到深色模式" aria-label="切换到深色模式"><span class="publish-theme-icon-slot" aria-hidden="true"><svg class="publish-theme-icon publish-theme-icon-moon" viewBox="0 0 24 24"><use href="${assetUrl("icons.svg")}#moon"></use></svg><svg class="publish-theme-icon publish-theme-icon-sun" viewBox="0 0 24 24"><use href="${assetUrl("icons.svg")}#sun"></use></svg></span><span data-publish-theme-label>深色模式</span></button></header>
<article id="published-note" class="publish-document preview markdown-reading-view" aria-live="polite"></article>
</main>
<script id="publish-data" type="application/json">${safeJson({ title, content })}</script>
<script src="${assetUrl("reader.js")}" data-mermaid-src="${assetUrl("mermaid.js")}" defer></script>
<script src="${assetUrl("publish.js")}" defer></script>
</body>
</html>`;
}
