// Admin plane enhancement client — the *same-origin* script that gives the SSR pages the prototype's
// interaction behaviour (`docs/admin-ui-proto/src/6-app.js`): overlay management, floating row
// menus, modal confirms, toasts, theme switching, keyboard shortcuts, instant list filtering and a
// live policy preview.
//
// Rules this file exists to enforce:
//   1. SSR stays the source of truth. The script never builds a page, never trusts a value that came
//      from data, and never writes HTML from untrusted input (only `textContent` for values).
//   2. The plane must work with the script absent: every action it intercepts is a real link or a
//      real form in the markup. Interception is always `preventDefault()` *after* deciding we can
//      do better.
//   3. CSP stays strict: `script-src 'self'`, no inline handlers, no eval, no third-party origins.
//
// Feature modules register themselves here; each owns its own file so parallel work stays
// file-disjoint. The registry lives in its own module (no cycle) — see `admin-feature-registry.js`.
import { features } from "./admin-feature-registry.js";

export { registerFeature } from "./admin-feature-registry.js";

/* ------------------------------------------------------------------ ctx helpers */

/** Prototype `toast(msg, {err, undo, ms})` — same classes, same 3.2s default. */
function toast(message, { err = false, ms = 3200, undo = null } = {}) {
  let node = document.getElementById("toast");
  const fresh = !node;
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    document.body.appendChild(node);
  }
  node.className = "toast" + (err ? " err" : "");
  node.textContent = "";
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = err ? "!" : "✓";
  const text = document.createElement("span");
  text.textContent = String(message ?? "");
  node.append(icon, text);
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "撤销";
    button.addEventListener("click", () => { node.classList.remove("on"); undo(); }, { once: true });
    node.appendChild(button);
  }
  clearTimeout(node._timer);
  // The prototype's toast fades up (`.toast` opacity/transform .15s). A fresh node needs its
  // pre-transition style painted first; an already-visible toast just stays put.
  if (fresh || !node.classList.contains("on")) reveal(node);
  node._timer = setTimeout(() => node.classList.remove("on"), ms);
}

/**
 * Motion helpers — the prototype CSS carries the transitions (`.drawer` translateX .2s, `.modal` /
 * `.toast` opacity+transform .15s, `.scrim` opacity .15s), but a transition only runs when the
 * browser has already computed a *starting* style for the element. Appending a node and adding the
 * state class in the same task skips that step, so the overlay snapped into place: the plane was
 * static where the prototype animates. `reveal` forces the start style, `conceal` waits for the
 * exit before anything leaves the DOM.
 */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const motionOff = () => {
  try {
    return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
};

/** Add `cls` on the next frame, after the element's pre-transition style has been computed. */
function reveal(node, cls = "on") {
  if (!node) return;
  const classes = String(cls).split(/\s+/).filter(Boolean);
  if (motionOff()) {
    node.classList.add(...classes);
    return;
  }
  void node.offsetWidth; // eslint-disable-line no-unused-expressions — forces the start style
  requestAnimationFrame(() => node.classList.add(...classes));
}

/** Remove `cls`, then resolve once the exit transition had its time (bounded: never hangs). */
function conceal(node, cls = "on", ms = 220) {
  if (!node) return Promise.resolve();
  node.classList.remove(cls);
  if (motionOff()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      node.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === node) finish();
    };
    node.addEventListener("transitionend", onEnd);
    setTimeout(finish, ms);
  });
}

/** The one open overlay (drawer / modal / menu), so Esc and outside clicks close the right thing. */
const overlayStack = [];

/**
 * Mount a modal into the prototype's own hosts (`#modal` / `#mscrim`), so every feature shares one
 * dialog surface and one Esc order instead of each building its own panel. Returns the overlay entry
 * (`close()`); the caller owns the dialog's inner markup.
 */
function mountModal(node, { onClose = null } = {}) {
  let host = document.getElementById("modal");
  if (!host) {
    host = document.createElement("div");
    host.id = "modal";
    host.className = "modal";
    host.setAttribute("role", "alertdialog");
    host.setAttribute("aria-modal", "true");
    document.body.appendChild(host);
  }
  let scrim = document.getElementById("mscrim");
  if (!scrim) {
    scrim = document.createElement("div");
    scrim.id = "mscrim";
    scrim.className = "scrim";
    document.body.appendChild(scrim);
  }
  host.textContent = "";
  host.appendChild(node);
  host.classList.add("on");
  scrim.classList.add("on");
  const entry = pushOverlay({
    close({ fromHistory = false } = {}) {
      host.classList.remove("on");
      scrim.classList.remove("on");
      host.textContent = "";
      scrim.onclick = null;
      if (!fromHistory) onClose?.();
    },
  });
  scrim.onclick = () => entry.close();
  return entry;
}

function pushOverlay(entry) {
  overlayStack.push(entry);
  return entry;
}

function popOverlay(entry = overlayStack[overlayStack.length - 1]) {
  const index = overlayStack.indexOf(entry);
  if (index >= 0) overlayStack.splice(index, 1);
  entry?.close?.();
  return entry;
}

function topOverlay() {
  return overlayStack[overlayStack.length - 1] || null;
}

/** Keyboard shortcut registry (prototype keys: `/`, `t`, `?`, `g <key>`, `j`, `k`, `n`, Enter, Esc). */
const shortcuts = new Map();
const sequence = { prefix: null, timer: null };

function registerShortcut(combo, handler, { allowInInput = false } = {}) {
  shortcuts.set(combo, { handler, allowInInput });
}

function isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true;
}

function handleKeydown(event) {
  if (event.defaultPrevented) return;
  const typing = isTypingTarget(event.target);
  if (event.key === "Escape") {
    const top = topOverlay();
    if (top) { event.preventDefault(); top.close(); }
    return;
  }
  // The `g` prefix is resolved FIRST (prototype order): a pending `g` consumes the next key, and any
  // other key clears it so a stale prefix can never swallow a later shortcut.
  if (sequence.prefix === "g") {
    const chained = shortcuts.get(`g ${event.key}`);
    sequence.prefix = null;
    clearTimeout(sequence.timer);
    if (chained) { event.preventDefault(); chained.handler(event); return; }
  }
  if (!typing) {
    if (event.key === "g") {
      sequence.prefix = "g";
      clearTimeout(sequence.timer);
      sequence.timer = setTimeout(() => { sequence.prefix = null; }, 900);
      return;
    }
    const direct = shortcuts.get(event.key);
    if (direct) { event.preventDefault(); direct.handler(event); return; }
  }
  // ⌘/Ctrl+Enter works inside the editor's inputs too.
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    const handler = shortcuts.get("mod+enter");
    if (handler) { event.preventDefault(); handler.handler(event); }
  }
}

/** Delegated listener helper: `on("click", ".selector", handler)`. */
function on(event, selector, handler, options) {
  document.addEventListener(event, (domEvent) => {
    const target = domEvent.target?.closest?.(selector);
    if (target) handler(domEvent, target);
  }, options);
}

/** Same-origin HTML fetch, used to pull a server-rendered fragment (drawer, modal, preview). */
async function fetchFragment(url) {
  const response = await fetch(url, { credentials: "same-origin", headers: { "x-admin-fragment": "1" }, redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return new DOMParser().parseFromString(text, "text/html");
}

function debounce(fn, ms = 150) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast(`已复制 ${String(text).slice(0, 40)}`);
    return true;
  } catch {
    toast("复制失败：浏览器拒绝了剪贴板访问", { err: true });
    return false;
  }
}

const theme = {
  get() { return document.documentElement.dataset.theme === "light" ? "light" : "dark"; },
  apply(next) {
    const value = next === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = value;
    // Same storage key as the prototype (`omcp-admin.theme`); the cookie keeps the SSR path in sync.
    try { localStorage.setItem("omcp-admin.theme", value); } catch { /* private mode */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = value === "light" ? "#ffffff" : "#101318";
    // The cookie attributes must match what the router writes, or a client write would downgrade a
    // hardened production cookie (the router adds `secure` on https).
    const secure = location.protocol === "https:" ? "; secure" : "";
    document.cookie = `omcp-admin.theme=${value}; path=/admin/auth; max-age=31536000; samesite=strict${secure}`;
    return value;
  },
  toggle() { return theme.apply(theme.get() === "dark" ? "light" : "dark"); },
  /** Adopt the stored preference before paint (prototype does this on boot). */
  restore() {
    let stored = null;
    try { stored = localStorage.getItem("omcp-admin.theme"); } catch { /* ignore */ }
    if (!stored) return theme.get();
    return theme.apply(stored);
  },
};

const ctx = {
  toast, on, fetchFragment, debounce, copy, theme,
  registerShortcut,
  reveal, conceal, motionOff,
  openOverlay: pushOverlay,
  closeOverlay: popOverlay,
  topOverlay,
  /** The shared dialog surface (`#modal` / `#mscrim`) with Esc/outside-click already wired. */
  mountModal,
  /** Navigate with history (drawer/segment switching) instead of a reload. */
  push(url) { history.pushState({ adminClient: true }, "", url); },
};

/* ------------------------------------------------------------------ SSR hooks */

/**
 * `data-enhance="hide-when-scripted"` — the control is a *no-JS fallback*: it exists so the page can
 * be submitted with the script absent, and the prototype has no such control because its own script
 * submits for the operator. Once the enhancement that replaces it has really run, keeping it would
 * make the scripted page differ from the prototype (the 定时授权 preview card grew 40px from exactly
 * this). Two guards keep it honest:
 *   * a control inside a `<form>` is hidden **only if that form was marked `data-enhanced="1"`** by
 *     the feature that upgraded it — if the enhancement threw, the button stays and the page still
 *     works;
 *   * the element is removed from the accessibility tree too (`hidden` + `aria-hidden`), so a screen
 *     reader never meets a button the pointer user cannot see.
 */
function applyScriptedControls() {
  for (const node of document.querySelectorAll('[data-enhance~="hide-when-scripted"]')) {
    const form = node.closest("form");
    if (form && form.dataset.enhanced !== "1") continue;
    node.hidden = true;
    node.setAttribute("aria-hidden", "true");
    if (node.hasAttribute("tabindex")) node.removeAttribute("tabindex");
    node.dataset.enhancedHidden = "1";
  }
}

/**
 * `data-autosubmit` — the prototype's scripted `<select>` submits on change (`data-act=tok-order`,
 * `data-act=preview-subject`, …); ours is a real form so it needs a submitter without script. With the
 * script running, change → submit restores the prototype's behaviour and lets the fallback button go.
 * The select feature dispatches a real `change` after mirroring a pick, so this one listener serves
 * both spellings.
 */
function applyAutoSubmit() {
  on("change", "[data-autosubmit]", (_event, node) => {
    const form = node.form || node.closest("form");
    if (!form) return;
    // A form the client upgrades to an in-place answer (the list page's preview card) submits itself.
    if (form.hasAttribute("data-preview-form")) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  });
}


/**
 * 列宽拖拽（2026-10-31 owner request：「所有表格都能自由调整列宽」）。
 *
 * Why it is built this way:
 *   * **no DOM is added.** The grab area is the `th::after` strip in the stylesheet (7px, cursor
 *     col-resize); the handler only has to notice that a mousedown landed inside it. Nothing appears
 *     in the markup, so the scriptless page, the prototype-parity capture and the shape gate see
 *     exactly the table that the server rendered;
 *   * **a `<col>` is what changes.** The table already ships a `<colgroup>` with the server's widths;
 *     dragging writes a px width onto that column, which is the one thing that can narrow a column
 *     without touching every cell;
 *   * **the width is remembered per page and per column index** in `localStorage` under
 *     `omcp.colw:<surface>`, where the surface is the current tab (or the access-policy / vault page)
 *     — a width tuned on 审计 does not follow the operator to Token;
 *   * **double-click resets** the column to the server's own width, and a width is never written below
 *     `MIN_COL_PX`: a column cannot be squeezed into illegibility with no way back.
 *
 * Without the module none of this exists — and none of it is needed: the table renders, sorts and
 * reads exactly as before, at the widths the server chose.
 */
const COL_SCALE_KEY = "omcp.colw";
const MIN_COL_PX = 56;

function surfaceKey() {
  const params = new URLSearchParams(location.search);
  const tab = params.get("tab");
  if (tab) return tab;
  return location.pathname.replace(/\/+$/, "") || "admin";
}

function readColumnWidths() {
  try {
    const raw = localStorage.getItem(`${COL_SCALE_KEY}:${surfaceKey()}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeColumnWidths(widths) {
  try {
    localStorage.setItem(`${COL_SCALE_KEY}:${surfaceKey()}`, JSON.stringify(widths));
  } catch {
    /* a full or disabled store must not break the page */
  }
}

function columnNodes(table) {
  return [...table.querySelectorAll(":scope > colgroup > col")];
}

function restoreColumnWidths() {
  const widths = readColumnWidths();
  for (const table of document.querySelectorAll("table.tbl")) {
    columnNodes(table).forEach((col, index) => {
      const px = Number(widths[index]);
      if (Number.isFinite(px) && px >= MIN_COL_PX) col.style.width = `${px}px`;
    });
  }
}

function rememberColumnWidths(table) {
  const widths = readColumnWidths();
  columnNodes(table).forEach((col, index) => {
    const value = col.style.width;
    // Only a px width this client wrote is worth remembering: the server's own widths are
    // percentages (`26%`), and "26" must never come back as a 26px column.
    if (!/px$/.test(value)) {
      delete widths[index];
      return;
    }
    const px = Number.parseFloat(value);
    if (Number.isFinite(px)) widths[index] = Math.round(px);
    else delete widths[index];
  });
  writeColumnWidths(widths);
}

function applyColumnResize() {
  restoreColumnWidths();
  on("mousedown", "table.tbl th", (event, th) => {
    if (event.button !== 0 || th.classList.contains("act")) return;
    const rect = th.getBoundingClientRect();
    // The grab strip is the stylesheet's `th::after` (7px at the right edge); the pointer must land
    // inside it, so a plain click on the label still follows the sort link.
    if (rect.right - event.clientX > 8) return;
    const table = th.closest("table");
    const index = [...th.parentElement.children].indexOf(th);
    const col = columnNodes(table)[index];
    if (!col) return;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    event.preventDefault();
    table.classList.add("rz-active");
    const move = (moveEvent) => {
      const next = Math.max(MIN_COL_PX, Math.round(startWidth + (moveEvent.clientX - startX)));
      col.style.width = `${next}px`;
    };
    const up = () => {
      table.classList.remove("rz-active");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      rememberColumnWidths(table);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
  });
  // Double-click the same strip = back to the server's width for that column.
  on("dblclick", "table.tbl th", (event, th) => {
    if (th.classList.contains("act")) return;
    const rect = th.getBoundingClientRect();
    if (rect.right - event.clientX > 8) return;
    const table = th.closest("table");
    const index = [...th.parentElement.children].indexOf(th);
    const col = columnNodes(table)[index];
    if (!col) return;
    col.style.removeProperty("width");
    event.preventDefault();
    rememberColumnWidths(table);
  });
}

/* ------------------------------------------------------------------ boot */


function boot() {
  // A marker the browser gates assert on: it exists only when module evaluation completed and boot
  // ran, so a TDZ/import failure cannot be mistaken for "the script is loaded".
  document.documentElement.dataset.adminClient = "1";
  document.documentElement.dataset.adminFeatures = String(features.length);
  document.addEventListener("keydown", handleKeydown, { capture: false });
  history.replaceState({ adminClient: "root" }, "", location.href);
  window.addEventListener("popstate", () => {
    const top = topOverlay();
    if (top) { top.close({ fromHistory: true }); return; }
    location.reload();
  });
  for (const feature of features) {
    try {
      feature.setup(ctx);
    } catch (error) {
      // A broken enhancement must never break a working page: the SSR markup stays usable.
      console.error(`[admin] feature ${feature.name} failed`, error);
    }
  }
  // After every feature has had its chance: drop the controls the features replaced.
  applyScriptedControls();
  applyAutoSubmit();
  applyColumnResize();
  theme.restore();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

// Feature modules are imported for their registration side effect.
import "./admin-feature-overlays.js";
import "./admin-feature-keys.js";
import "./admin-feature-lists.js";
import "./admin-feature-select.js";
import "./admin-feature-nav.js";
