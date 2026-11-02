import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deployedVersion, formatDeployTime, releaseFooterLines } from "../release-version.js";
import { DEFAULT_LOCALE, LOCALE_PREFERENCE_AUTO, SUPPORTED_LOCALES, createTranslator } from "../i18n/index.js";

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

// I18n (Web bilingual UI). Every user-visible label on these three documents is
// looked up in the shared catalog (`src/i18n/messages/`), so the anonymous login,
// the workspace shell and the public Publish page all follow one locale decision.
// `zh-CN` stays the default and the copy is byte-identical to the pre-i18n
// literals, so nothing about the existing render changes unless the reader asks
// for another language (`?lang=` / the preference cookie / Accept-Language).

/** Language choices in the settings dialog: stored preference → catalog label.
 *  No stored preference means the default catalog, so that is what the select shows;
 *  "follow the browser" is an explicit choice, never the implicit default. A one-off
 *  `?lang=` render never rewrites the stored choice. */
function languageOptions(t, preference) {
  const stored = preference === LOCALE_PREFERENCE_AUTO || SUPPORTED_LOCALES.includes(preference) ? preference : DEFAULT_LOCALE;
  const choices = [[LOCALE_PREFERENCE_AUTO, t("settings.language.auto")], ...SUPPORTED_LOCALES.map((id) => [id, t(`settings.language.${id}`)])];
  return choices
    .map(([value, label]) => `<option value="${html(value)}"${value === stored ? " selected" : ""}>${html(label)}</option>`)
    .join("");
}

/**
 * Login page follows the default vault appearance (color mode + community theme)
 * so anonymous visitors see the same chrome as the signed-in workspace.
 *
 * The default `next` is the slash-bearing app root: the installed app resolves its manifest
 * `scope` to `/app/`, so the post-login landing page must be inside it (#471).
 *
 * `error` is a catalog key (`"login.error.invalidCredentials"`) or `{ key, params }` for
 * copy that carries a value (the lockout wait), never a pre-rendered sentence: the
 * message has to exist in the language the reader asked for.
 */
export function loginPage(error = "", appearance = {}, next = "/app/", locale = DEFAULT_LOCALE) {
  const { t, htmlLang: lang } = createTranslator(locale);
  const colorMode = ["dark", "light", "system"].includes(appearance.colorMode) ? appearance.colorMode : "system";
  const themeId = typeof appearance.themeId === "string" ? appearance.themeId.trim() : "";
  const initialClass = colorMode === "dark" ? "theme-dark" : "theme-light";
  const themeLink = themeId
    ? `<link id="community-theme" rel="stylesheet" href="/auth/theme.css?name=${encodeURIComponent(themeId)}">`
    : "";
  const errorText = error && typeof error === "object"
    ? (error.key ? t(error.key, error.params) : "")
    : (error ? t(error) : "");
  return `<!doctype html>
<html lang="${lang}" class="${initialClass}" data-color-mode="${html(colorMode)}" data-desktop-color-mode="${html(colorMode)}"${themeId ? ` data-theme="${html(themeId)}"` : ""} data-icon-sprite="${assetUrl("icons.svg")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
<script src="${assetUrl("login.js")}"></script>
<title>${t("login.title")}</title>
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
<p>${t("login.subtitle")}</p>
${errorText ? `<p class="error-text">${html(errorText)}</p>` : ""}
<form method="post" action="/auth/login">
<input type="hidden" name="next" value="${html(next)}">
<label>${t("login.username")}<input name="username" autocomplete="username" required autofocus></label>
<label>${t("login.password")}<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">${t("login.submit")}</button>
</form>
</section>
</main>
</body>
</html>`;
}

export function appPage(session, appearance = {}, initialNote = null, initialBase = null, initialCanvas = null, localeOptions = {}) {
  const locale = localeOptions.locale ?? DEFAULT_LOCALE;
  const localePreference = localeOptions.preference ?? null;
  const { t, htmlLang: lang } = createTranslator(locale);
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
  const formatted = formatDeployTime(release.deployedAt, locale);
  // #503: the footer renders two lines — release identity, then the process clock
  // (production is UTC). The raw ISO rides on the deploy line so the browser can
  // replace that text with Beijing time; without script the UTC line stays.
  const footerFace = releaseFooterLines(release, locale);
  const deployIso = formatted.iso ? ` data-deployed-at="${html(formatted.iso)}"` : "";
  const commitPart = release.commit ? `commit ${release.commit}` : "";
  const releaseTitle = [t("release.deployedVersion"), release.version, commitPart, formatted.label].filter(Boolean).join(" · ");
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
<html lang="${lang}" class="${initialClass}" data-color-mode="${html(colorMode)}" data-desktop-color-mode="${html(colorMode)}" data-ui-locale="${lang}"${themeId ? ` data-theme="${html(themeId)}"` : ""} data-icon-sprite="${assetUrl("icons.svg")}">
${appHead}
<body class="${initialClass} is-desktop">
  <div class="shell app-container horizontal-main-container">
    <aside class="ribbon workspace-ribbon side-dock-ribbon mod-left" aria-label="${t("shell.ribbon.label")}">
      <button id="files-toggle" class="icon-btn active" title="${t("shell.ribbon.toggleFiles")}" aria-label="${t("shell.ribbon.toggleFiles")}">${icon("panel-left")}</button>
      <div class="ribbon-spacer"></div>
    </aside>
    <aside class="sidebar workspace-split mod-horizontal mod-left-split">
      <!-- U29 (#371): both side panes share one header shape — the view switcher plus one
           pane-level close control (the ✕ is a pane control, so it left the Files panel head).
           It delegates to the very same sidebar-panels toggle the ribbon uses. -->
      <div class="sidebar-head">
        <div class="sidebar-tabs" role="tablist" aria-label="${t("shell.sidebar.tabsLabel")}" data-pane-slot="switch">
          <button class="sidebar-tab is-active" type="button" role="tab" data-sidebar-tab="files" aria-selected="true" aria-controls="panel-files" title="${t("shell.tab.files")}" aria-label="${t("shell.tab.files")}">${icon("folder")}</button>
          <button class="sidebar-tab" type="button" role="tab" data-sidebar-tab="search" aria-selected="false" aria-controls="panel-search" title="${t("shell.tab.search")}" aria-label="${t("shell.tab.search")}">${icon("search")}</button>
        </div>
        <button id="panel-close" class="icon-btn pane-head-close" type="button" title="${t("shell.sidebar.collapse")}" aria-label="${t("shell.sidebar.collapse")}" data-pane-slot="close">${icon("x")}</button>
      </div>
      <section id="panel-files" class="sidebar-panel" role="tabpanel" data-sidebar-panel="files" aria-label="${t("shell.tab.files")}">
      <div class="panel-head" data-panel-head="files" data-explorer-mode="tree" data-pane-slot="actions">
        <button id="new-note" class="icon-btn" type="button" title="${t("explorer.newNote")}" aria-label="${t("explorer.newNote")}">${icon("square-pen")}</button>
        <button id="new-folder" class="icon-btn" type="button" title="${t("explorer.newFolder")}" aria-label="${t("explorer.newFolder")}">${folderPlusIcon}</button>
        <div class="sidebar-actions" role="toolbar" aria-label="${t("explorer.toolsLabel")}">
          <button id="explorer-sort-toggle" class="icon-btn" type="button" title="${t("explorer.sort.title.nameAsc")}" aria-label="${t("explorer.sort.title.nameAsc")}" aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-sort-menu">${icon("arrow-up-narrow-wide")}</button>
          <button id="reveal-active" class="icon-btn" type="button" title="${t("explorer.revealActive")}" aria-label="${t("explorer.revealActive")}">${icon("gallery-vertical")}</button>
          <!-- #421: a one-shot shortcut, not a toggle. Clicking it always runs the same
               preset query (published:true) and hands the reader to the Search panel,
               so the control must not carry aria-pressed: the panel it lives in is not
               the one on screen once it has done its job (audit §7, seat ruling (a)). -->
          <button id="publishes-open" class="icon-btn" type="button" title="${t("explorer.searchPublished")}" aria-label="${t("explorer.searchPublished")}">${icon("globe-2")}</button>
        </div>
        <!-- Phase 2 flat view is a user-specified Web enhancement: the desktop file
             explorer has no flat mode, so this control reuses the existing list-tree
             glyph and the existing icon-button/menu pattern instead of inventing a
             desktop affordance. CSS (data-explorer-mode on this head) shows exactly
             one sort trigger per mode. -->
        <button id="explorer-mode-toggle" class="icon-btn" type="button" title="${t("explorer.mode.treeTitle")}" aria-label="${t("explorer.mode.treeTitle")}" aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-mode-menu">${icon("list-tree")}</button>
        <div class="explorer-sort-menu explorer-mode-menu" id="explorer-mode-menu" role="menu" aria-label="${t("explorer.mode.label")}" hidden>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="true" data-explorer-mode="tree"><span class="explorer-sort-option-label">${t("explorer.mode.tree")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-explorer-mode="flat"><span class="explorer-sort-option-label">${t("explorer.mode.flat")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
        </div>
        <button id="explorer-flat-sort-toggle" class="icon-btn" type="button" title="${t("explorer.sort.title.modifiedDesc")}" aria-label="${t("explorer.sort.title.modifiedDesc")}" aria-haspopup="menu" aria-expanded="false" aria-controls="explorer-flat-sort-menu">${icon("arrow-up-narrow-wide")}</button>
        <div class="explorer-sort-menu" id="explorer-flat-sort-menu" role="menu" aria-label="${t("explorer.flatSort.label")}" hidden>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="true" data-flat-sort="modified:desc"><span class="explorer-sort-option-label">${t("explorer.sort.modifiedDesc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="modified:asc"><span class="explorer-sort-option-label">${t("explorer.sort.modifiedAsc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="path:asc"><span class="explorer-sort-option-label">${t("explorer.sort.pathAsc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="path:desc"><span class="explorer-sort-option-label">${t("explorer.sort.pathDesc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="name:asc" data-requires-query="true"><span class="explorer-sort-option-label">${t("explorer.sort.nameAsc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="name:desc" data-requires-query="true"><span class="explorer-sort-option-label">${t("explorer.sort.nameDesc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="score:asc" data-requires-query="true"><span class="explorer-sort-option-label">${t("explorer.sort.scoreDesc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-flat-sort="score:desc" data-requires-query="true"><span class="explorer-sort-option-label">${t("explorer.sort.scoreAsc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
        </div>
        <button id="collapse-all" class="icon-btn" type="button" title="${t("explorer.collapseAll")}" aria-label="${t("explorer.collapseAll")}">${collapseAllIcon}</button>
        <div class="explorer-sort-menu" id="explorer-sort-menu" role="menu" aria-label="${t("explorer.sortMenu.label")}" hidden>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="true" data-sort-key="name" data-sort-direction="asc"><span class="explorer-sort-option-label">${t("explorer.sort.nameAsc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-sort-key="name" data-sort-direction="desc"><span class="explorer-sort-option-label">${t("explorer.sort.nameDesc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-sort-key="modified" data-sort-direction="desc"><span class="explorer-sort-option-label">${t("explorer.sort.modifiedDesc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
          <button class="explorer-sort-option" type="button" role="menuitemradio" aria-checked="false" data-sort-key="modified" data-sort-direction="asc"><span class="explorer-sort-option-label">${t("explorer.sort.modifiedAsc")}</span><span class="explorer-sort-option-check" aria-hidden="true">${icon("check")}</span></button>
        </div>
      </div>
      <div id="files-status" class="search-status" role="status" aria-live="polite"></div>
      <nav id="note-list" class="note-list nav-files-container" aria-label="${t("explorer.notesLabel")}"></nav>
      </section>
      <section id="panel-search" class="sidebar-panel" role="tabpanel" data-sidebar-panel="search" aria-label="${t("shell.tab.search")}" hidden>
      <div class="panel-head search-panel-head" data-panel-head="search" data-pane-slot="actions">
        <div class="search-row">
          <div class="search-input-shell">
            <input id="search" class="search" type="search" placeholder="${t("search.placeholder")}" autocomplete="off" aria-describedby="search-status">
            <div class="search-input-actions" aria-label="${t("search.options")}">
              <button id="search-clear" class="search-input-action search-clear" type="button" title="${t("search.clear")}" aria-label="${t("search.clear")}" hidden>${icon("x")}</button>
              <button id="search-case" class="search-input-action search-case" type="button" title="${t("search.caseSensitive")}" aria-label="${t("search.caseSensitive")}" aria-pressed="false">Aa</button>
            </div>
          </div>
          <button id="semantic-search" class="search-tool search-meaning" type="button" aria-pressed="false" title="${t("search.semantic.title")}">${t("search.semantic")}</button>
          <details class="search-help">
            <summary class="search-tool" title="${t("search.help.title")}" aria-label="${t("search.help.aria")}">${icon("circle-help")}</summary>
            <div class="search-help-card">
              <div class="search-help-title">${t("search.help.cardTitle")}</div>
              <p class="search-help-intro">${t("search.help.intro")}</p>
              <span class="search-example">${t("search.help.example.path")}</span><span>${t("search.help.desc.pathContains")}</span>
              <span class="search-example">${t("search.help.example.file")}</span><span>${t("search.help.desc.fileContains")}</span>
              <span class="search-example">${t("search.help.example.tag")}</span><span>${t("search.help.desc.tagMatches")}</span>
              <span class="search-example">${t("search.help.example.line")}</span><span>${t("search.help.desc.sameLine")}</span>
              <span class="search-example">${t("search.help.example.section")}</span><span>${t("search.help.desc.sameSection")}</span>
              <span class="search-example">${t("search.help.example.property")}</span><span>${t("search.help.desc.propertyExists")}</span>
              <span class="search-example">${t("search.help.example.propertyValue")}</span><span>${t("search.help.desc.propertyValue")}</span>
              <p>${t("search.help.footer")}</p>
            </div>
          </details>
        </div>
      </div>
      <div id="search-status" class="search-status" role="status" aria-live="polite"></div>
      <nav id="search-list" class="note-list search-list" aria-label="${t("search.resultsLabel")}"></nav>
      </section>
      <footer class="sidebar-footer">
        <div class="vault-switcher">
          <label for="vault-select" class="vault-label">
            <select id="vault-select" class="vault-select" data-select aria-label="${t("vault.switch")}"><option>${t("vault.loading")}</option></select>
          </label>
          <button id="vault-create" class="icon-btn" type="button" title="${t("vault.create")}" aria-label="${t("vault.create")}">${icon("database")}</button>
          <button id="settings-open" class="icon-btn" type="button" title="${t("settings.open")}" aria-label="${t("settings.openAria")}">${icon("settings")}</button>
          <form class="sidebar-logout" method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value="${html(session.csrf)}">
            <button class="icon-btn" type="submit" title="${t("shell.logout", { user: html(session.username) })}" aria-label="${t("shell.logout", { user: html(session.username) })}">${icon("log-out")}</button>
          </form>
        </div>
      </footer>
    </aside>
    <div id="left-pane-resizer" class="pane-resizer pane-resizer-left" role="separator" aria-label="${t("shell.resizer.left")}" aria-orientation="vertical" aria-valuemin="190" aria-valuemax="520" aria-valuenow="270" tabindex="0"></div>
    <div class="scrim"></div>
    <main class="workspace workspace-split mod-vertical mod-root">
      <!-- U29 (#371): the topbar is the one workspace chrome band that is always in the layout
           (the welcome workspace keeps a single bar); #sidebar-toggle moved into its actions so
           it stays a layout-layer control outside the rail (U18), reachable while the rail is
           collapsed. The document tab row is the second, conditional band below it. -->
      <header class="topbar view-header">
        <button id="menu" class="icon-btn mobile-menu" title="${t("shell.topbar.openFiles")}" aria-label="${t("shell.topbar.openFiles")}">${icon("menu")}</button>
        <div id="current-path" class="current-path view-header-title">${t("shell.topbar.noNote")}</div>
        <span id="reconnect-host" class="reconnect-host"></span>
        <!-- U46 (#422): #status stays the visible session readout but sits outside the polite
             .topbar-status live region, so a failure is announced once (by the toast). -->
        <span id="status" class="status"></span>
        <div class="topbar-actions">
          <div class="topbar-status" aria-live="polite">
          <span id="live-status" class="live-status" title="${t("shell.liveStatus.title")}" aria-label="${t("shell.liveStatus.label")}"></span>
          <span id="live-status-label" class="live-status-label">${t("shell.liveStatus.connecting")}</span>
          </div>
          <button id="save" class="primary mod-cta" type="button" title="${t("shell.save")}" aria-label="${t("shell.save")}" disabled><span class="save-label">${t("shell.save")}</span>${icon("check", "svg-icon save-icon")}</button>
          <div class="view-mode topbar-view-mode">
            <button class="icon-btn view-mode-toggle" type="button" title="${t("view.toggle")}" aria-label="${t("view.toggle")}" aria-haspopup="menu" aria-expanded="false">${icon("book-open")}</button>
            <div class="view-mode-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" class="view-mode-item" data-mode="preview" aria-checked="true">${icon("book-open")}<span>${t("view.reading")}</span><span class="view-mode-check" aria-hidden="true">${icon("check")}</span></button>
              <button type="button" role="menuitemradio" class="view-mode-item" data-mode="raw" aria-checked="false">${icon("code")}<span>${t("view.source")}</span><span class="view-mode-check" aria-hidden="true">${icon("check")}</span></button>
              <button type="button" role="menuitemradio" class="view-mode-item" data-mode="live" aria-checked="false">${icon("pen")}<span>${t("view.live")}</span><span class="view-mode-check" aria-hidden="true">${icon("check")}</span></button>
            </div>
          </div>
          <div class="document-actions">
            <button id="document-actions-toggle" class="icon-btn document-actions-toggle" type="button" title="${t("document.actions")}" aria-label="${t("document.actions")}" aria-haspopup="menu" aria-expanded="false">${icon("more-vertical")}</button>
            <div id="document-actions-menu" class="document-actions-menu" role="menu" hidden>
              <button class="document-action-item" data-document-link type="button" role="menuitem" disabled>${icon("link")}<span>${t("document.copyLink")}</span></button>
              <button class="document-action-item" data-publish-toggle type="button" role="menuitem" aria-pressed="false" disabled>${icon("globe-2")}<span class="document-action-label">Publish</span><span class="document-action-state" aria-hidden="true"></span></button>
            </div>
          </div>
          <button id="sidebar-toggle" class="icon-btn document-rail-toggle" type="button" title="${t("shell.sidebar.toggleRight")}" aria-label="${t("shell.sidebar.toggleRight")}" aria-pressed="true" aria-controls="context-sidebar">${icon("panel-right")}</button>
        </div>
      </header>
      <!-- U29 (#371): the tab row stays in the DOM (the U18 seam keeps its anchor and the strip
           keeps features/tabs as its only writer), but it only enters the layout while the
           strip really has a tab: features/explorer mirrors the committed tab model onto
           .has-document-tabs on .workspace. Tabs are rendered by features/tabs from the
           session's current document (v1: notes only, session-scoped, no persistence). -->
      <div class="document-tab-row">
        <div id="document-tabs" class="document-tabs" role="tablist" aria-label="${t("shell.tabs.label")}"></div>
      </div>
      <section class="document workspace-leaf-content view-content">
        <div id="base-host" hidden></div>
        ${initialCanvas ? `<div id="canvas-host" hidden></div>` : ""}
        <div id="editor" class="editor markdown-source-view mod-cm6 cm-s-obsidian is-readable-line-width" hidden aria-label="${t("shell.editor.label")}"></div>
        <article id="preview" class="preview markdown-reading-view"><div class="markdown-preview-view markdown-rendered markdown-preview-sizer markdown-preview-section is-readable-line-width"><div class="welcome"><h1>${t("shell.welcome.title", { name: html(session.displayName || session.username) })}</h1><p>${t("shell.welcome.hint")}</p></div></div></article>
        <!-- Issue #430: the single word-count badge instance. It lives in the document pane
             (never inside .preview/.cm-scroller, which own scrolling and Reader/Live geometry),
             is hidden by default and is driven only by features/session/status-presenter.js. -->
        <button id="word-count-badge" class="word-count-badge" type="button" hidden><span class="word-count-badge-words"></span><span class="word-count-badge-characters"></span></button>
      </section>
    </main>
    <div id="right-pane-resizer" class="pane-resizer pane-resizer-right" role="separator" aria-label="${t("shell.resizer.right")}" aria-orientation="vertical" aria-valuemin="190" aria-valuemax="520" aria-valuenow="250" tabindex="0"></div>
    <aside id="context-sidebar" class="context-sidebar workspace-split mod-horizontal mod-right-split" aria-label="${t("context.label")}">
      <!-- U18 + U29 (#371): the rail header is the panel layer. #context-drawer-close is the
           pane-level close of the pane header (the same shape the left pane exposes), and it
           delegates to the one rail state in pane-layout; the topbar #sidebar-toggle is the one
           layout-layer entry (#398 removed the ⋮ item that used to duplicate it). -->
      <header class="context-header context-view-header">
        <div class="context-view-switcher" role="tablist" aria-label="${t("context.viewsLabel")}" data-pane-slot="switch">
          <button class="icon-btn context-view-btn is-active" type="button" role="tab" data-context-view="outline" aria-selected="true" aria-controls="context-view-outline" title="${t("context.outline")}" aria-label="${t("context.outline")}">${icon("list-tree")}</button>
          <button class="icon-btn context-view-btn" type="button" role="tab" data-context-view="outgoing" aria-selected="false" aria-controls="context-view-outgoing" title="${t("context.outgoing")}" aria-label="${t("context.outgoing")}">${icon("link-out")}</button>
          <button class="icon-btn context-view-btn" type="button" role="tab" data-context-view="incoming" aria-selected="false" aria-controls="context-view-incoming" title="${t("context.incoming")}" aria-label="${t("context.incoming")}">${icon("link-in")}</button>
          <button class="icon-btn context-view-btn" type="button" role="tab" data-context-view="tags" aria-selected="false" aria-controls="context-view-tags" title="${t("context.tags")}" aria-label="${t("context.tags")}">${icon("tag")}</button>
        </div>
        <button id="context-drawer-close" class="icon-btn pane-head-close" type="button" title="${t("context.collapse")}" aria-label="${t("context.collapse")}" data-pane-slot="close">${icon("x")}</button>
      </header>
      <section id="context-view-outline" class="context-view" data-context-view-panel="outline" role="tabpanel" aria-label="${t("context.outline")}">
        <nav id="outline-list" class="outline-list" aria-label="${t("context.outlineNav")}"><div class="context-empty">${t("context.outlineEmpty")}</div></nav>
      </section>
      <section id="context-view-outgoing" class="context-view" data-context-view-panel="outgoing" role="tabpanel" aria-label="${t("context.outgoing")}" hidden>
      <header class="context-header context-panel-head" data-context-panel="outgoing" data-pane-slot="actions">
        <button id="unlinked-toggle" class="icon-btn context-panel-toggle" type="button" title="${t("context.unlinkedToggle")}" aria-label="${t("context.unlinkedToggle")}" aria-pressed="true" aria-controls="unlinked-list">${icon("book-open")}</button>
        <button id="outgoing-menu-toggle" class="icon-btn context-section-menu-toggle" type="button" title="${t("context.options")}" aria-label="${t("context.outgoingOptions")}" aria-haspopup="menu" aria-expanded="false">${icon("more-vertical")}</button>
        <div class="context-section-menu" role="menu" aria-label="${t("context.outgoingOptions")}" hidden>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="collapse">${t("context.collapseSection")}</button>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="refresh">${t("context.refresh")}</button>
        </div>
      </header>
      <header class="context-header context-section-header" data-context-section="outgoing">
        <span class="context-title">${t("context.outgoing")}</span>
        <span class="context-section-count" data-context-count="outgoing">0</span>
      </header>
      <nav id="outgoing-list" class="outline-list outgoing-list" aria-label="${t("context.outgoing")}"><div class="context-empty">${t("context.outgoingEmpty")}</div></nav>
      <div id="context-rail-splitter" class="context-rail-splitter" role="separator" aria-orientation="horizontal" aria-label="${t("context.railSplitter")}" tabindex="0"></div>
      <header class="context-header context-section-header unlinked-header" data-context-section="unlinked">
        <span class="context-title">${t("context.unlinked")}</span>
        <span class="context-section-count" data-context-count="unlinked">0</span>
      </header>
      <nav id="unlinked-list" class="outline-list unlinked-list" aria-label="${t("context.unlinked")}"><div class="context-empty">${t("context.unlinkedEmpty")}</div></nav>
      </section>
      <section id="context-view-incoming" class="context-view" data-context-view-panel="incoming" role="tabpanel" aria-label="${t("context.incoming")}" hidden>
      <header class="context-header context-panel-head" data-context-panel="incoming" data-pane-slot="actions">
        <button id="incoming-menu-toggle" class="icon-btn context-section-menu-toggle" type="button" title="${t("context.options")}" aria-label="${t("context.incomingOptions")}" aria-haspopup="menu" aria-expanded="false">${icon("more-vertical")}</button>
        <div class="context-section-menu" role="menu" aria-label="${t("context.incomingOptions")}" hidden>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="collapse">${t("context.collapseSection")}</button>
          <button class="context-section-menu-item" type="button" role="menuitem" data-context-action="refresh">${t("context.refresh")}</button>
        </div>
      </header>
      <header class="context-header context-section-header" data-context-section="incoming">
        <span class="context-title">${t("context.incoming")}</span>
        <span class="context-section-count" data-context-count="incoming">0</span>
      </header>
      <nav id="incoming-list" class="outline-list incoming-list" aria-label="${t("context.incoming")}"><div class="context-empty">${t("context.incomingEmpty")}</div></nav>
      </section>
      <section id="context-view-tags" class="context-view" data-context-view-panel="tags" role="tabpanel" aria-label="${t("context.tags")}" hidden>
      <header class="context-header context-panel-head tags-header" data-context-panel="tags" data-context-section="tags" data-pane-slot="actions">
        <span class="context-title">${t("context.tags")}</span>
        <div class="context-view-tools tags-tools" role="toolbar" aria-label="${t("tags.tools")}">
          <button id="tags-sort-toggle" class="icon-btn tags-sort-toggle" type="button" title="${t("tags.sort")}" aria-label="${t("tags.sortLabel")}" aria-haspopup="menu" aria-expanded="false" aria-controls="tags-sort-menu">${icon("chevrons-up-down")}</button>
          <button id="tags-filter-toggle" class="icon-btn tags-filter-toggle" type="button" title="${t("tags.filter")}" aria-label="${t("tags.filter")}" aria-pressed="false" aria-controls="tags-filter">${icon("search")}</button>
          <div id="tags-sort-menu" class="tags-sort-menu" role="menu" aria-label="${t("tags.sortLabel")}" hidden>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="true" data-tags-sort="count">${t("tags.sortCount")}</button>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="false" data-tags-sort="name">${t("tags.sortName")}</button>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="true" data-tags-direction="desc">${t("tags.desc")}</button>
            <button class="tags-sort-option" type="button" role="menuitemradio" aria-checked="false" data-tags-direction="asc">${t("tags.asc")}</button>
          </div>
        </div>
      </header>
      <div class="tags-filter-row" hidden><input id="tags-filter" class="tags-filter" type="search" placeholder="${t("tags.filterPlaceholder")}" autocomplete="off" aria-label="${t("tags.filter")}"></div>
      <nav id="tags-list" class="outline-list tags-list" aria-label="${t("context.tags")}"><div class="context-empty">${t("tags.empty")}</div></nav>
      </section>
    </aside>
  </div>
  <dialog id="settings-dialog" class="settings-dialog">
    <header><div><h2>${t("settings.title")}</h2><p>${t("settings.subtitle")}</p></div><button id="settings-close" class="icon-btn" aria-label="${t("settings.close")}">${icon("x")}</button></header>
    <nav aria-label="${t("settings.tabs")}"><button class="settings-tab active" type="button">${t("settings.appearanceTab")}</button></nav>
    <section class="settings-pane" aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">${t("settings.appearance")}</h3>
      <div class="setting-item"><div><span class="setting-label">${t("settings.colorMode")}</span><p>${t("settings.colorModeHint")}</p></div><label><span class="sr-only">${t("settings.colorMode")}</span><select id="color-mode" data-select title="${t("settings.colorMode")}"><option value="desktop">${t("settings.colorMode.desktop")}</option><option value="system">${t("settings.colorMode.system")}</option><option value="light">${t("settings.colorMode.light")}</option><option value="dark">${t("settings.colorMode.dark")}</option></select></label></div>
      <div class="setting-item"><div><span class="setting-label">${t("settings.theme")}</span><p>${t("settings.themeHint")}</p></div><label><span class="sr-only">${t("settings.theme")}</span><select id="theme-select" data-select><option value="Things">Things</option></select></label></div>
      <!-- No-JS language switch: a plain GET form inside the item's text column, so it needs
           no extra layout rule. The route stores the preference in a cookie and redirects
           back to the Referer, so it never needs script and never leaves the reader on a
           bare app root. -->
      <div class="setting-item"><div><span class="setting-label">${t("settings.language")}</span><p>${t("settings.languageHint")}</p><form method="get" action="/app/language"><label><span class="sr-only">${t("settings.language")}</span><select id="language-select" name="lang" data-select title="${t("settings.language")}">${languageOptions(t, localePreference)}</select></label> <button class="primary mod-cta" type="submit">${t("settings.languageApply")}</button></form></div></div>
    </section>
    <footer class="settings-meta" title="${html(releaseTitle)}"><span>Obsidian Web</span><span class="settings-meta-version"><span class="settings-meta-release">${html(footerFace.release)}</span><span class="settings-meta-deploy"${deployIso}>${html(footerFace.deploy)}</span></span></footer>
  </dialog>
  <script src="${assetUrl("app-loader.js")}" data-editor-src="${assetUrl("editor.js")}" data-reader-src="${assetUrl("reader.js")}" data-app-src="${assetUrl("app.js")}" data-mermaid-src="${assetUrl("mermaid.js")}" data-kanban-src="${assetUrl("kanban.js")}" data-property-edit-src="${assetUrl("property-edit.js")}" defer></script>
  ${initialCanvas ? `<script type="module" src="${assetUrl("canvas.js")}" data-canvas-path="${html(initialCanvas.path)}" data-canvas-vault="${html(initialCanvas.vaultId)}"></script>` : ""}
</body></html>`;
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function publishPage({ title, content, publishedAt, locale = DEFAULT_LOCALE }) {
  const { t, htmlLang: lang } = createTranslator(locale);
  return `<!doctype html>
<html lang="${lang}" class="theme-light" data-color-mode="system" data-desktop-color-mode="system" data-icon-sprite="${assetUrl("icons.svg")}">
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
<header class="publish-head"><div class="publish-heading"><h1>${html(title)}</h1><div class="publish-meta">${html(t("publish.meta", { time: publishedAt || "" }))}</div></div><button id="publish-theme-toggle" class="publish-theme-toggle" type="button" data-target-mode="dark" title="${t("publish.theme.toDark")}" aria-label="${t("publish.theme.toDark")}"><span class="publish-theme-icon-slot" aria-hidden="true"><svg class="publish-theme-icon publish-theme-icon-moon" viewBox="0 0 24 24"><use href="${assetUrl("icons.svg")}#moon"></use></svg><svg class="publish-theme-icon publish-theme-icon-sun" viewBox="0 0 24 24"><use href="${assetUrl("icons.svg")}#sun"></use></svg></span><span data-publish-theme-label>${t("publish.theme.dark")}</span></button></header>
<article id="published-note" class="publish-document preview markdown-reading-view" aria-live="polite"></article>
</main>
<script id="publish-data" type="application/json">${safeJson({ title, content })}</script>
<script src="${assetUrl("reader.js")}" data-mermaid-src="${assetUrl("mermaid.js")}" defer></script>
<script src="${assetUrl("publish.js")}" defer></script>
</body>
</html>`;
}
