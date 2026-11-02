// Feature module: instant theme switching and the prototype's keyboard shortcuts.
//
// Owned by lane L2 (`app/test/admin-redo/client-keys.test.js` is its harness). Truth source:
// `docs/admin-ui-proto/src/6-app.js` —
//   * `setTheme` (23-25), the sidebar theme button (70) and the `t` branch (430);
//   * `showKbd()` (107-113) and the `?` branch (428);
//   * `/` (429), `n` (431), `j`/`k` (432-437), `Enter` (438), `mod+Enter` (421-422), `Esc` (423);
//   * the `g <key>` sequence (425-427) over `NAV` (14-20).
//
// Hard rules this file obeys:
//   1. The SSR markup stays the source of truth: nothing here builds a page, and every value that
//      could carry data is written with `textContent` — never `innerHTML`.
//   2. The plane must work with this script absent: the theme control is a real POST form, the nav
//      entries are real links, the create entry is a real GET form/anchor, every row owns a real
//      link or disclosure. `preventDefault()` is called only where we know we can do better, and a
//      failed lookup falls through to the browser's own behaviour.
//   3. CSP stays strict: no inline handler, no `eval`, no third-party origin.
import { registerFeature } from "./admin-client.js";

/** The sidebar theme control (`layout.js: renderSidebar`): a real POST form when the script is absent. */
const THEME_FORM = 'form[action="/admin/auth/theme"]';
/** The panel's own ids. The prototype uses `#modal`/`#mscrim` for every overlay state (see CHECKPOINT F2). */
const PANEL_ID = "admin-kbd-panel";
/** Prototype `gPending` window: `Date.now() - gPending < 1200` (`6-app.js:425`). */
const G_SEQUENCE_MS = 1200;

/** Prototype `showKbd()` 通用 group (`6-app.js:110`), label for label and combo for combo. */
const GENERAL_ROWS = Object.freeze([
  ["/", "搜索 / 筛选"],
  ["n", "新建（当前页）"],
  ["j k", "表格上下移动"],
  ["↵", "打开详情"],
  ["Esc", "关闭抽屉 / 弹窗"],
  ["t", "切换主题"],
  ["?", "本面板"],
  ["⌘ ↵", "保存策略"],
]);

/** Prototype `inField` test (`6-app.js:417`): single-key shortcuts never fire from a text control. */
function isTyping(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true;
}

/** The nav entries the server rendered (`layout.js`: `.ni[data-hotkey]`), in sidebar order. */
function navEntries() {
  return Array.from(document.querySelectorAll("[data-hotkey]"))
    .map((link) => ({
      key: String(link.dataset.hotkey || ""),
      label: (link.querySelector(".lbl") || link).textContent.trim(),
      link,
    }))
    .filter((entry) => entry.key);
}

/** Prototype `row(k, l)` (`6-app.js:108`): label left, one `<kbd>` per combo token right. */
function kbdRow(label, combo) {
  const row = document.createElement("div");
  row.className = "row";
  const text = document.createElement("span");
  text.textContent = label;
  const keys = document.createElement("span");
  combo.split(" ").forEach((token, index) => {
    if (index > 0) keys.appendChild(document.createTextNode(" "));
    const key = document.createElement("kbd");
    key.textContent = token;
    keys.appendChild(key);
  });
  row.append(text, keys);
  return row;
}

registerFeature("keys", (ctx) => {
  /* ------------------------------------------------------------------ theme */
  // Prototype `setTheme` (23-25) writes `data-theme` + `meta[name=theme-color]`; the SSR control
  // additionally has to keep the server's own cookie in sync so the next render agrees (catalog.js
  // reads `omcp-admin.theme`). `ctx.theme.apply` owns all of that.
  const themeForm = () => document.querySelector(THEME_FORM);

  /**
   * The prototype re-renders the sidebar on every toggle, so its button always describes the *next*
   * action (`6-app.js:70`). The SSR form is static, so keep the same affordance in the same state:
   * hidden field, icon and accessible name — no structural change.
   */
  function syncThemeControl() {
    const form = themeForm();
    if (!form) return;
    const next = ctx.theme.get() === "dark" ? "light" : "dark";
    const field = form.querySelector('input[name="theme"]');
    if (field) field.value = next;
    const button = form.querySelector("button");
    if (!button) return;
    const use = button.querySelector("use");
    if (use) use.setAttribute("href", next === "light" ? "#i-sun" : "#i-moon");
    const title = next === "light" ? "切换到浅色主题" : "切换到深色主题";
    button.setAttribute("title", title);
    button.setAttribute("aria-label", title);
  }

  function toggleTheme() {
    const next = ctx.theme.get() === "dark" ? "light" : "dark";
    ctx.theme.apply(next);
    return next;
  }

  // The POST form is the no-JS path (`router.js: post /theme`); with the script present the same
  // button toggles in place instead of navigating.
  ctx.on("submit", THEME_FORM, (event) => {
    event.preventDefault();
    toggleTheme();
  });
  // The control follows every theme change, including the client's own `theme.restore()` at boot.
  new MutationObserver(syncThemeControl).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  syncThemeControl();

  /* ------------------------------------------------------------------ shortcut panel */
  // Prototype `showKbd()` (107-113): `.modal.kbdp` + scrim, 导航 from `NAV`, then the 通用 group.
  let panel = null;
  let scrim = null;
  let open = null;
  let restoreFocus = null;

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "modal kbdp";
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "键盘快捷键");
    panel.tabIndex = -1;
    const heading = document.createElement("h3");
    heading.textContent = "键盘快捷键";
    const cols = document.createElement("div");
    cols.className = "cols";
    const navHeading = document.createElement("h4");
    navHeading.textContent = "导航";
    cols.appendChild(navHeading);
    for (const entry of navEntries()) cols.appendChild(kbdRow(entry.label, `g ${entry.key}`));
    const generalHeading = document.createElement("h4");
    generalHeading.textContent = "通用";
    cols.appendChild(generalHeading);
    for (const [combo, label] of GENERAL_ROWS) cols.appendChild(kbdRow(label, combo));
    const acts = document.createElement("div");
    acts.className = "acts";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn";
    close.textContent = "关闭";
    close.addEventListener("click", hidePanel);
    acts.appendChild(close);
    cols.appendChild(acts);
    panel.append(heading, cols);
    scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.addEventListener("click", hidePanel);
    document.body.append(scrim, panel);
  }

  /** Close (Esc via the shared overlay stack, the scrim, the 关闭 button) and give focus back. */
  function hidePanel() {
    const state = open;
    if (!state) return;
    open = null;
    state.panel.classList.remove("on");
    state.scrim.classList.remove("on");
    if (ctx.topOverlay() === state.entry) ctx.closeOverlay(state.entry);
    const target = restoreFocus;
    restoreFocus = null;
    if (target && target.isConnected && typeof target.focus === "function") target.focus();
  }

  function showPanel() {
    if (open) return; // the prototype re-renders the same open panel; it is not a toggle
    if (!panel) buildPanel();
    const active = document.activeElement;
    restoreFocus = active && active !== document.body ? active : null;
    panel.classList.add("on");
    scrim.classList.add("on");
    const entry = { name: "kbd", close: hidePanel };
    open = { panel, scrim, entry };
    ctx.openOverlay(entry); // so the shared Esc stack closes this panel first
    panel.focus();
  }

  /* ------------------------------------------------------------------ lookups over the SSR markup */
  const navLink = (key) => navEntries().find((entry) => entry.key === key)?.link || null;

  /** Activate a real server-rendered control (link, or the form it belongs to). */
  function activate(node) {
    if (!node) return;
    if (node.tagName === "FORM") node.requestSubmit();
    else node.click();
  }

  /**
   * Prototype `$("[data-search],[data-subjq]")` (`6-app.js:429`): the current page's search box.
   * The candidates are tried in priority order — a single comma-separated `querySelector` would pick
   * the SSR form's hidden `tab` field, which comes first in document order and cannot take focus.
   */
  function searchField() {
    for (const selector of ['[data-search]', 'input[name="q"]', 'input[name="subjq"]', '.toolbar .search input:not([type="hidden"])']) {
      const field = document.querySelector(selector);
      if (field) return field;
    }
    return null;
  }

  /**
   * Prototype `$(".bar [data-act^=new-]")` (`6-app.js:431`). The SSR page bar renders the create
   * entry as a GET form to `?id=new` (`pages/accounts.js`, `pages/keys.js`) or, on the policy list,
   * as an anchor (`pages/authz.js`).
   */
  function createEntry() {
    const form = document.querySelector('.bar form[method="get"] input[name="id"][value="new"]')?.closest("form");
    if (form) return form.querySelector('button[type="submit"]') || form;
    return document.querySelector('.bar a[href*="new=1"]');
  }

  /**
   * Prototype `.tbl tbody tr[data-open],.tbl tbody tr[data-ua]` (`6-app.js:433`): the rows that own
   * an entry — a detail link (list pages) or the audit disclosure.
   */
  const rows = () => Array.from(document.querySelectorAll(".tbl tbody tr")).filter((row) => row.querySelector("a.cell-link, details.ua"));

  function moveRow(delta) {
    const list = rows();
    if (!list.length) return;
    let index = list.findIndex((row) => row.classList.contains("kb"));
    for (const row of list) row.classList.remove("kb", "cur");
    index = Math.max(0, Math.min(list.length - 1, index + delta));
    const row = list[index];
    row.classList.add("kb", "cur");
    row.scrollIntoView({ block: "nearest" });
  }

  /** Prototype `Enter` (`6-app.js:438`): activate the selected row (`r.click()`). */
  function activateRow() {
    const row = document.querySelector(".tbl tbody tr.kb");
    if (!row) return;
    const link = row.querySelector("a.cell-link");
    if (link) {
      link.click();
      return;
    }
    row.querySelector("details.ua > summary")?.click();
  }

  /**
   * Prototype `savePolicy()` (`6-app.js:421-422`) — only the policy editor has this shortcut. The
   * SSR editor keeps its save button in `.ped-foot` and points it at the form via `form="authz-form"`.
   */
  function editorForm() {
    const button = document.querySelector('.ped-foot button[type="submit"][form]');
    const owned = button ? document.getElementById(button.getAttribute("form")) : null;
    return owned || document.querySelector("form#authz-form");
  }

  function submitEditor() {
    if (open) return;
    const form = editorForm();
    if (form) form.requestSubmit();
  }

  /* ------------------------------------------------------------------ keyboard */
  // The prototype checks a pending `g` sequence before *any* single-key shortcut (`6-app.js:425`),
  // and consumes the key even when no nav entry matches. The shared client resolves single keys
  // first (CHECKPOINT F3), so a colliding key re-checks the prefix here; both orders navigate the
  // same way. `g` itself is tracked locally because the shared client keeps its own copy private.
  let gAt = 0;

  function guarded(key, action) {
    return (event) => {
      if (open) return; // prototype 417-422: while its modal is open only Esc/Enter act
      if (event.metaKey || event.ctrlKey || event.altKey) return; // prototype 424: never with a modifier
      if (gAt && Date.now() - gAt < G_SEQUENCE_MS) {
        gAt = 0;
        const link = navLink(key);
        if (link) link.click();
        return;
      }
      action(event);
    };
  }

  ctx.registerShortcut("?", guarded("?", showPanel));
  // The prototype also opens the same panel from the sidebar footer's shortcut button
  // (`6-app.js` `<button class="ibtn" data-act="kbd">`). The plane's button carries a CLASS hook
  // (`.kbd-button`) instead of the prototype's `data-act`: the SSR markup must not need script hooks
  // (`test/admin-redo/*.test.js` asserts no `data-act`/`data-menu`/`data-open` in the served HTML),
  // and without script the button does nothing — exactly like the prototype's, whose panel
  // `showKbd()` builds in JS.
  ctx.on("click", ".kbd-button", (event) => { event.preventDefault(); showPanel(); });
  ctx.registerShortcut("/", guarded("/", () => {
    const field = searchField();
    if (!field) return;
    field.focus();
    try { field.select(); } catch { /* not a text input */ }
  }));
  ctx.registerShortcut("t", guarded("t", toggleTheme));
  ctx.registerShortcut("n", guarded("n", () => activate(createEntry())));
  ctx.registerShortcut("j", guarded("j", () => moveRow(1)));
  ctx.registerShortcut("k", guarded("k", () => moveRow(-1)));
  ctx.registerShortcut("Enter", (event) => {
    // `⌘/Ctrl+Enter` saves the editor (prototype 421). The shared client resolves single keys before
    // its own `mod+enter` branch, so outside an input this key would be swallowed as a plain Enter
    // (CHECKPOINT F3): route the modifier here too. `mod+enter` still covers the in-input case.
    if (event.metaKey || event.ctrlKey) {
      submitEditor();
      return;
    }
    guarded("Enter", activateRow)(event);
  });
  ctx.registerShortcut("mod+enter", submitEditor, { allowInInput: true });
  for (const entry of navEntries()) ctx.registerShortcut(`g ${entry.key}`, () => entry.link.click());

  document.addEventListener("keydown", (event) => {
    if (event.key === "g" && !isTyping(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      gAt = Date.now();
      return;
    }
    if (event.key !== "g") gAt = 0;
  });
});
