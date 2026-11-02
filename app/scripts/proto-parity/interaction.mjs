// Admin interaction gate — the behaviour contract, the in-page probes and the per-behaviour verdicts.
//
// The Admin plane is server-rendered; a *same-origin* module (`admin-client.js`, D0 approved
// 2026-10-18) re-adds the prototype's interactions. This module is the measurement layer for that
// claim, and it is deliberately split so one implementation serves both trees:
//
//   * `probe*` functions      — serialized into the page (`runProbe`), self-contained, run on the
//     **prototype** (`docs/admin-ui-proto/index.html`) and on the live plane, so the comparison is
//     symmetric by construction;
//   * `interactionVerdicts`   — one verdict per prototype behaviour, each returning the failure lines
//     it found (empty = satisfied). The prototype's own run must satisfy every verdict (fail closed:
//     a verdict nobody can satisfy is a broken criterion, not a product defect), and the live run is
//     then judged by exactly the same functions;
//   * `PROTOTYPE_BEHAVIOUR`   — the mapping table, and with it the `both` / `host` split.
//
// Sibling modules keep this file inside the line budget: `./policy.mjs` (the frozen CSP + the served
// HTML's script policy) and `./injection.mjs` (payloads, injection-surface probe, client source
// audit).
//
// Authority for the behaviour: `docs/admin-ui-proto/src/6-app.js` (`PROTOTYPE_BEHAVIOUR` names the
// lines). Authority for the security posture: the D0 ruling quoted in the lane brief.
import { scriptInventoryFailures } from "./policy.mjs";

/**
 * One entry per behaviour the enhancement must reproduce, with its prototype authority. `verdict` is
 * the key in `interactionVerdicts`; `sabotage` is the key of the control that must turn that verdict
 * red on the prototype (the scene owns the sabotage implementations, because they poke at the
 * prototype's own globals).
 */
export const PROTOTYPE_BEHAVIOUR = Object.freeze([
  Object.freeze({
    id: "drawer-opens-in-place",
    plane: "both",
    requires: "点行开抽屉：URL 走 history（pushState）而不是整页导航，抽屉与 scrim 同时出现",
    proto: "6-app.js:46 go() / 200 openDrawer() / 441 popstate",
    verdict: "drawer-opens-in-place",
  }),
  Object.freeze({
    id: "drawer-back-closes",
    plane: "both",
    requires: "浏览器 Back 关闭抽屉并回到列表 URL（不整页导航）",
    proto: "6-app.js:213 closeDrawer() 的 pushState / 441 addEventListener(\"popstate\", onRoute)",
    verdict: "drawer-back-closes",
  }),
  Object.freeze({
    id: "menu-floats-in-viewport",
    plane: "both",
    requires: "⋯ 菜单是浮层（不挤表格高度）且完全落在视口内",
    proto: "6-app.js:114 openMenu() 的 left/top 夹取与翻转",
    verdict: "menu-floats-in-viewport",
  }),
  Object.freeze({
    id: "menu-closes-on-outside-click",
    plane: "both",
    requires: "外点关闭菜单（点击菜单外任意处）",
    proto: "6-app.js:285 if (!t.closest(\"#menu\")) closeMenu()",
    verdict: "menu-closes-on-outside-click",
  }),
  Object.freeze({
    id: "menu-closes-on-escape",
    plane: "both",
    requires: "Esc 关闭菜单",
    proto: "6-app.js:422 if (e.key === \"Escape\") … closeMenu()",
    verdict: "menu-closes-on-escape",
  }),
  Object.freeze({
    id: "modal-centered",
    plane: "both",
    requires: "危险入口弹确认框：水平居中、完整在视口内、贴底锚定（原型确认框的几何由共享样式表给出）",
    proto: "6-app.js:99 confirmBox() 的 .on + #mscrim.on（.modal 居中由样式表给出）",
    verdict: "modal-centered",
  }),
  Object.freeze({
    id: "modal-typed-input-focused",
    plane: "both",
    requires: "确认框打开后聚焦 type-to-confirm 输入框",
    proto: "6-app.js:104 setTimeout(() => (type ? $(\"[data-typeconf]\", m) : …).focus(), 30)",
    verdict: "modal-typed-input-focused",
  }),
  Object.freeze({
    id: "modal-confirm-gated-by-text",
    plane: "both",
    requires: "确认按钮在输入等于目标串之前保持 disabled",
    proto: "6-app.js:101 按钮 ${type ? \"disabled\" : \"\"} / 437 input 事件解除",
    verdict: "modal-confirm-gated-by-text",
  }),
  Object.freeze({
    id: "modal-escape-cancels",
    plane: "both",
    requires: "Esc 取消确认框，且焦点不留在已关闭的浮层里",
    proto: "6-app.js:417 if (e.key === \"Escape\") closeModal()",
    verdict: "modal-escape-cancels",
  }),
  Object.freeze({
    id: "toast-shown-then-expires",
    plane: "both",
    requires: "toast 出现（轮询到可见）、1s 后仍在、随后被自身 3200ms 定时器收走（不早于 ~2.5s，不晚于 7s 上限）",
    proto: "6-app.js:92 toast() 的 opts.ms || 3200",
    verdict: "toast-shown-then-expires",
  }),
  Object.freeze({
    id: "theme-toggles-without-navigation",
    plane: "both",
    requires: "`t` / 侧栏主题按钮切换主题：不导航、写 localStorage、更新 meta[theme-color]",
    proto: "6-app.js:430 if (e.key === \"t\") / 25 setTheme() / 324 case \"theme\"",
    verdict: "theme-toggles-without-navigation",
  }),
  Object.freeze({
    id: "shortcut-question-mark-opens-panel",
    plane: "both",
    requires: "`?` 打开快捷键面板",
    proto: "6-app.js:428 if (e.key === \"?\") return showKbd() / 107 showKbd()",
    verdict: "shortcut-question-mark-opens-panel",
  }),
  Object.freeze({
    id: "shortcut-slash-focuses-search",
    plane: "both",
    requires: "`/` 聚焦当前页搜索框（无搜索框的页面按原型 no-op）",
    proto: "6-app.js:429 if (e.key === \"/\") … s.focus(); s.select()",
    verdict: "shortcut-slash-focuses-search",
  }),
  Object.freeze({
    id: "fragment-fetch-allowed",
    plane: "host",
    requires: "同源 fragment fetch（ctx.fetchFragment 的路径）必须成功且不产生 CSP 违规",
    proto: "6-app.js 无 fetch（原型是单文件 SPA）；本条是 D0 宿主的要求：default-src 'none' 下 connect-src 回落，必须显式允许同源",
    verdict: "fragment-fetch-allowed",
  }),
  Object.freeze({
    id: "no-cross-origin-and-no-csp-violation",
    plane: "host",
    requires: "整段交互里 0 条 CSP 违规、0 个跨源请求",
    proto: "D0 冻结策略 + BRIEF「隐私断言」",
    verdict: "no-cross-origin-and-no-csp-violation",
  }),
  Object.freeze({
    id: "client-writes-values-with-textContent",
    plane: "host",
    requires: "客户端只用 textContent 写来自数据的值（运行时计数器 + 静态源码审计）",
    proto: "D0 硬规则 1（SSR 仍是真源，值一律 textContent）",
    verdict: "client-writes-values-with-textContent",
  }),
  Object.freeze({
    id: "no-inline-script-policy",
    plane: "host",
    requires: "HTML 无 inline script / on*= / javascript:，脚本只有白名单里的同源 module",
    proto: "D0 冻结策略（script-src 'self'）",
    verdict: "no-inline-script-policy",
  }),
]);

/* ------------------------------------------------------------------ in-page probes */

/**
 * Script / attribute inventory of the *served* document. Deliberately reads attributes (not the
 * serialized HTML): a value the server escaped into a text node can never show up as an attribute
 * here, and an `on*=` attribute that the browser accepted is exactly what must be caught.
 */
export function probeDocumentPolicy() {
  const scripts = [...document.querySelectorAll("script")].map((node) => {
    const src = node.getAttribute("src");
    let sameOrigin = false;
    try { sameOrigin = src !== null && new URL(src, location.href).origin === location.origin; } catch { sameOrigin = false; }
    return {
      src: src === null ? "" : src,
      type: String(node.getAttribute("type") || "").toLowerCase(),
      inline: src === null,
      textLength: src === null ? String(node.textContent || "").length : 0,
      sameOrigin,
      async: node.hasAttribute("async"),
    };
  });
  const inlineHandlers = [];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...(element.attributes || [])]) {
      if (/^on/i.test(attribute.name)) inlineHandlers.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
    }
  }
  const javascriptUrls = [];
  for (const element of document.querySelectorAll("[href],[src],[action],[formaction]")) {
    for (const name of ["href", "src", "action", "formaction"]) {
      const value = element.getAttribute?.(name);
      if (value && /^\s*(?:javascript|vbscript):/i.test(value)) javascriptUrls.push(`${element.tagName.toLowerCase()}[${name}]=${value.slice(0, 60)}`);
    }
  }
  return {
    url: `${location.pathname}${location.search}`,
    scripts,
    inlineHandlers,
    javascriptUrls,
    cspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null,
  };
}

/**
 * Install the observers the interaction verdicts read:
 *   * `securitypolicyviolation` (a blocked inline script, a blocked fetch, a blocked third-party
 *     origin — the counter must stay 0 across the whole scenario);
 *   * `fetch` / `XMLHttpRequest.open` wrappers, recording cross-origin attempts before the browser
 *     even decides (a policy that blocks them would otherwise hide the attempt);
 *   * an `innerHTML` / `insertAdjacentHTML` / `outerHTML` counter (hard rule 1: values go through
 *     `textContent`, never through an HTML sink);
 *   * a `pushState` counter and a page-load counter, so "history changed the URL" is
 *     distinguishable from "the document was navigated and reloaded". The load counter lives in
 *     `sessionStorage`, which survives a reload inside the same tab — a `window` sentinel would be
 *     re-armed by this very init script and could never notice the reload it exists to catch.
 */
export function armInteractionObservers() {
  if (window.__adminInteraction) return true;
  const loads = Number(sessionStorage.getItem("__adminProbeLoads") || "0") + 1;
  sessionStorage.setItem("__adminProbeLoads", String(loads));
  const state = { violations: [], crossOrigin: [], htmlSinks: [], pushStates: 0, actions: 0, loads };
  window.__adminInteraction = state;
  document.addEventListener("securitypolicyviolation", (event) => {
    state.violations.push({
      directive: event.violatedDirective || event.effectiveDirective || "",
      blockedURI: String(event.blockedURI || "").slice(0, 120),
      source: event.sourceFile ? String(event.sourceFile).slice(0, 80) : null,
    });
  });
  const record = (url) => {
    try { if (new URL(String(url), location.href).origin !== location.origin) state.crossOrigin.push(String(url).slice(0, 120)); } catch { /* relative or opaque */ }
  };
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      record(typeof input === "string" ? input : input?.url ?? "");
      state.actions += 1;
      return originalFetch.call(this, input, init);
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    record(url);
    state.actions += 1;
    return originalOpen.call(this, method, url, ...rest);
  };
  const pushState = history.pushState.bind(history);
  history.pushState = (...args) => { state.pushStates += 1; return pushState(...args); };
  const countSink = (kind, value) => { state.htmlSinks.push({ kind, length: String(value ?? "").length }); state.actions += 1; };
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  if (innerHtml?.set) {
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      enumerable: innerHtml.enumerable,
      get: innerHtml.get,
      set(value) { countSink("innerHTML", value); return innerHtml.set.call(this, value); },
    });
  }
  const outerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML");
  if (outerHtml?.set) {
    Object.defineProperty(Element.prototype, "outerHTML", {
      configurable: true,
      enumerable: outerHtml.enumerable,
      get: outerHtml.get,
      set(value) { countSink("outerHTML", value); return outerHtml.set.call(this, value); },
    });
  }
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function patchedInsert(position, value) { countSink("insertAdjacentHTML", value); return insertAdjacentHTML.call(this, position, value); };
  const docWrite = document.write?.bind(document);
  if (docWrite) document.write = (...args) => { countSink("document.write", args.join("")); return docWrite(...args); };
  return true;
}

/** The armed state, as a report. `pageLoads` proves whether the document was reloaded. */
export function probeInteractionObservers() {
  const state = window.__adminInteraction || { violations: [], crossOrigin: [], htmlSinks: [], pushStates: 0, actions: 0, loads: null };
  return {
    violations: state.violations,
    crossOrigin: state.crossOrigin,
    htmlSinks: state.htmlSinks,
    pushStates: state.pushStates,
    actions: state.actions,
    pageLoads: state.loads,
    navigationEntries: performance.getEntriesByType("navigation").length,
    url: `${location.pathname}${location.search}${location.hash}`,
  };
}

/**
 * The prototype's `openDrawer` visual state (`#drawer.on` / `#dscrim.on`), for either tree.
 *
 * Self-contained on purpose: this function is serialized into the page with
 * `Function.prototype.toString` (`runProbe`), so every helper it needs lives inside it.
 */
export function probeDrawerState() {
  // Duplicated on purpose: a probe is serialized into the page on its own, so it cannot reach a
  // module-scope helper. "Visible" also means *on screen*: the prototype keeps `#drawer`/`#modal`
  // rendered (off-screen or `opacity:0`) in their closed state, so `getClientRects().length > 0`
  // alone reports a closed overlay as visible.
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.05) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  const focusInsideClosedOverlay = () => {
    const active = document.activeElement;
    if (!active) return false;
    const overlay = active.closest?.("#drawer, .drawer, #modal, .modal, .menu");
    if (!overlay) return false;
    const open = overlay.className.includes("on") || overlay.className.includes("show");
    return !open && overlay.getClientRects().length === 0;
  };
  const drawer = document.querySelector("#drawer.on, aside.drawer.on, .drawer.on");
  const scrim = document.querySelector("#dscrim.on, .scrim.on, [data-scrim].on, [data-scrim]");
  const observers = window.__adminInteraction || null;
  return {
    url: `${location.pathname}${location.search}${location.hash}`,
    drawerVisible: visible(drawer),
    drawerTitle: drawer ? String(drawer.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) : null,
    scrimVisible: visible(scrim),
    markedRows: document.querySelectorAll(".tbl tbody tr.cur, .tbl tbody tr.kb").length,
    focusInsideDrawer: Boolean(drawer && drawer.contains(document.activeElement)),
    focusInsideClosedOverlay: focusInsideClosedOverlay(),
    pageLoads: observers ? observers.loads : null,
    navigationEntries: performance.getEntriesByType("navigation").length,
    pushStates: observers ? observers.pushStates : null,
  };
}

/**
 * The prototype's `openMenu` geometry (`6-app.js:114`): a floating panel anchored to the ⋯ control,
 * clamped into the viewport. Measured for both trees: the prototype's `#menu.on`, the SSR
 * `<details class="mn">` panel while open, or any element the enhancement appends for the same job.
 */
export function probeMenuState() {
  const focusInsideClosedOverlay = () => {
    const active = document.activeElement;
    if (!active) return false;
    const overlay = active.closest?.("#drawer, .drawer, #modal, .modal, .menu");
    if (!overlay) return false;
    const open = overlay.className.includes("on") || overlay.className.includes("show");
    return !open && overlay.getClientRects().length === 0;
  };
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.05) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  const panels = [...document.querySelectorAll("#menu.on, .mn[open] > .menu, .row-menu-panel, [data-menu-panel]")].filter(visible);
  const panel = panels[0] ?? null;
  const button = document.querySelector("[data-menu], details.mn > summary, .row-menu > summary");
  const rect = panel?.getBoundingClientRect() ?? null;
  const buttonRect = button?.getBoundingClientRect() ?? null;
  const style = panel ? getComputedStyle(panel) : null;
  const parentStyle = panel?.parentElement ? getComputedStyle(panel.parentElement) : null;
  return {
    menuVisible: Boolean(panel),
    documentHeight: Math.round(document.documentElement.getBoundingClientRect().height),
    itemCount: panel ? panel.querySelectorAll("button, a").length : 0,
    inside: rect ? rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5 : false,
    box: rect ? { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) } : null,
    viewport: { width: innerWidth, height: innerHeight },
    position: style?.position ?? null,
    positionedAncestor: parentStyle?.position ?? null,
    anchorDelta: rect && buttonRect ? Math.round(rect.right - buttonRect.right) : null,
    focusInsideClosedOverlay: focusInsideClosedOverlay(),
    pageLoads: window.__adminInteraction?.loads ?? null,
  };
}

/**
 * The prototype's `confirmBox` state (`6-app.js:99`): centred `.modal.on` + scrim, the typed input
 * focused 30ms later, the confirm button disabled until the typed text matches.
 */
export function probeModalState() {
  const focusInsideClosedOverlay = () => {
    const active = document.activeElement;
    if (!active) return false;
    const overlay = active.closest?.("#drawer, .drawer, #modal, .modal, .menu");
    if (!overlay) return false;
    const open = overlay.className.includes("on") || overlay.className.includes("show");
    return !open && overlay.getClientRects().length === 0;
  };
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.05) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  const modal = document.querySelector("#modal.on, .modal.on, .modal.show");
  const rect = modal?.getBoundingClientRect() ?? null;
  const typed = modal?.querySelector("[data-typeconf], input[name=confirm], input[type=text], input.inp") ?? null;
  const confirm = modal?.querySelector("[data-act=mok], button[type=submit], .btn.danger, .btn.primary") ?? null;
  return {
    modalVisible: visible(modal),
    // A typed modal the enhancement could not gate (declared input but no target string / not a text
    // entry): the layout gate asserts this is never true on the live side, so a mis-wired selector fails
    // visibly instead of either locking the action (review v31-r1 F1) or silently removing the gate.
    typedDegraded: modal?.dataset.typedGateDegraded === "1",
    title: modal ? String(modal.querySelector("h3, h1")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) : null,
    scrimVisible: visible(document.querySelector("#mscrim.on, .modal + .scrim.on, .scrim.on")),
    // The prototype's own geometry (PROTO_CSS `.modal{left:50%;bottom:16px}`): horizontally centred,
    // fully inside the viewport and anchored near the bottom edge — *that* is the reference the live
    // plane has to reproduce, not an invented "floating in the middle" rule.
    horizontallyCentered: rect ? Math.abs((rect.left + rect.right) / 2 - innerWidth / 2) <= 2 : false,
    centerDelta: rect ? { x: Math.round((rect.left + rect.right) / 2 - innerWidth / 2), y: Math.round((rect.top + rect.bottom) / 2 - innerHeight / 2) } : null,
    insideViewport: rect ? rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5 : false,
    bottomGap: rect ? Math.round(innerHeight - rect.bottom) : null,
    // The shared stylesheet anchors the dialogue at `top:22vh` (desktop) / `bottom:16px` (narrow);
    // the verdict only requires "in the upper half and inside the viewport", and the scene compares
    // the live box against the prototype box measured in the same viewport, so the exact anchor is
    // pinned by the prototype rather than by a constant copied into the gate.
    upperHalf: rect ? rect.top >= 0 && rect.top <= innerHeight * 0.5 : false,
    box: rect ? { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
    // The dialogue's *structure*, not just its box: the prototype renders
    // `h3 · p · .tc · input · .acts`, while the SSR confirm page nests the typed field inside the
    // actions row (`.acts > form > .tc + input + button`). Same width, a different visible
    // arrangement — so the parity comparison is per child, in order.
    outline: rect ? [...modal.children].map((node) => ({ tag: node.tagName.toLowerCase(), classes: [...node.classList].join("."), height: Math.round(node.getBoundingClientRect().height) })) : null,
    typedParentClasses: typed ? [...(typed.parentElement?.classList ?? [])].join(".") : null,
    typedInsideActions: Boolean(typed?.closest(".acts")),
    typedPresent: Boolean(typed),
    typedFocused: Boolean(typed) && document.activeElement === typed,
    typedValueLength: typed ? String(typed.value ?? "").length : null,
    confirmPresent: Boolean(confirm),
    confirmDisabled: confirm ? confirm.disabled === true || confirm.getAttribute("aria-disabled") === "true" : null,
    confirmLabel: confirm ? String(confirm.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30) : null,
    focusInsideClosedOverlay: focusInsideClosedOverlay(),
    pageLoads: window.__adminInteraction?.loads ?? null,
    typedTarget: modal ? String(modal.querySelector(".tc code")?.textContent ?? "") : null,
  };
}

/**
 * The prototype's toast (`#toast.on`, `6-app.js:92`). Visibility is read from the class *and* the
 * resolved opacity: the closed `.toast` keeps its box (shipped off/transparent), so a
 * rect-based test would report "still visible" 3.6s later and hide the expiry defect.
 */
export function probeToastState() {
  const node = document.querySelector("#toast, .toast");
  const style = node ? getComputedStyle(node) : null;
  const rect = node?.getBoundingClientRect() ?? null;
  const visible = Boolean(node) && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && Boolean(rect) && rect.width > 0 && rect.height > 0 && !node.hasAttribute("hidden");
  return {
    toastPresent: Boolean(node),
    toastVisible: visible,
    className: node ? String(node.className) : null,
    opacity: style ? Number(style.opacity) : null,
    text: node ? String(node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : null,
    isError: Boolean(node) && node.className.includes("err"),
    hasUndo: Boolean(node?.querySelector("button")),
  };
}

/** Theme state + the evidence that the toggle did not navigate. */
export function probeThemeState() {
  let stored = null;
  try { stored = localStorage.getItem("omcp-admin.theme"); } catch { stored = "unavailable"; }
  return {
    url: `${location.pathname}${location.search}${location.hash}`,
    theme: document.documentElement.dataset.theme ?? null,
    metaThemeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
    stored,
    htmlBackground: getComputedStyle(document.body).backgroundColor,
    pageLoads: window.__adminInteraction?.loads ?? null,
    navigationEntries: performance.getEntriesByType("navigation").length,
  };
}

/** Keyboard-shortcut panel (`showKbd`, `6-app.js:107`): a visible overlay carrying the shortcut rows. */
export function probeKbdState() {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.05) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  // Only the *modal* vocabulary: the closed `#drawer` is rendered off-screen by the shared
  // stylesheet, so a `[role=dialog]` scan reported the drawer as the shortcut panel.
  const overlays = [...document.querySelectorAll("#modal, .modal, .kbdp, [data-kbd-panel]")].filter(visible);
  const overlay = overlays[0] ?? null;
  return {
    panelVisible: Boolean(overlay),
    overlayClass: overlay ? String(overlay.className) : null,
    kbdCount: overlay ? overlay.querySelectorAll("kbd").length : document.querySelectorAll("kbd").length,
    rowCount: overlay ? overlay.querySelectorAll(".row, tr, li").length : 0,
    mentions: overlay ? ["搜索", "主题", "关闭"].filter((word) => String(overlay.textContent || "").includes(word)) : [],
    pageLoads: window.__adminInteraction?.loads ?? null,
  };
}

/**
 * Focus after `/`: the page's own search box. The candidates are tried in *priority* order and a
 * control that can never take focus (`type=hidden`, `disabled`) is skipped, because a single
 * comma-separated `querySelector` returns the first match in **document order** — which on the SSR
 * pages is the search form's hidden `tab` field (`.search input` matches it), so the probe used to
 * report "`/` did not focus the search box" no matter what the page did. The order follows the
 * prototype's own selector (`6-app.js:429` `[data-search],[data-subjq]`) and then the SSR spellings;
 * on the prototype the `[data-search]` input *is* the first candidate, so both trees are resolved by
 * the same rule instead of each tree being measured against a different idea of "the search box".
 */
export function probeSearchState() {
  const focusable = (node) => Boolean(node) && node.disabled !== true && String(node.type || "").toLowerCase() !== "hidden";
  const candidates = ["[data-search]", "[data-subjq]", 'input[name="q"]', 'input[name="subjq"]', ".search input", "form.search input"];
  let search = null;
  for (const selector of candidates) {
    search = [...document.querySelectorAll(selector)].find(focusable) ?? null;
    if (search) break;
  }
  const active = document.activeElement;
  const boxes = (node) => (node && typeof node.getClientRects === "function" ? node.getClientRects().length : 0);
  const describe = (node) => (node ? { tag: node.tagName.toLowerCase(), name: node.getAttribute?.("name") ?? null, classes: [...(node.classList ?? [])].join(".") } : null);
  const selection = active && typeof active.selectionStart === "number" ? { start: active.selectionStart, end: active.selectionEnd, length: String(active.value ?? "").length } : null;
  return {
    searchPresent: Boolean(search),
    searchField: describe(search),
    activeTag: active ? active.tagName.toLowerCase() : null,
    activeName: active?.getAttribute?.("name") ?? null,
    // A hidden/zero-box control can be "focused" in the DOM while the operator sees nothing: the
    // verdict below requires the caret to land in a control with a layout box.
    activeVisible: Boolean(active) && boxes(active) > 0,
    activeIsSearch: Boolean(active) && Boolean(search) && active === search,
    activeInsideSearch: Boolean(active) && Boolean(search) && active !== search && search.contains(active),
    selection,
    pageLoads: window.__adminInteraction?.loads ?? null,
  };
}

/* ------------------------------------------------------------------ verdicts (node side) */

const isTrue = (value) => value === true;
const notTrue = (value) => value !== true;

/**
 * One verdict per behaviour. Each returns the failure lines it found; an empty array means the
 * behaviour holds. The live plane is judged with exactly these functions, and the prototype's own
 * record must satisfy all of them (an unsatisfiable verdict is a broken criterion).
 */
export const interactionVerdicts = Object.freeze({
  "drawer-opens-in-place": (bundle) => {
    const { rowOpen } = bundle;
    const failures = [];
    if (!rowOpen?.after?.drawerVisible) failures.push("点行之后没有出现抽屉（原型 openDrawer(): `#drawer.on`）");
    if (!rowOpen?.after?.scrimVisible) failures.push("点行之后没有出现 scrim（原型 `#dscrim.on`）");
    if (rowOpen?.after && rowOpen.after.pageLoads !== rowOpen.before?.pageLoads) failures.push("点行把页面整页导航/刷新了（文档重新加载；原型走 go() → pushState + onRoute）");
    if (rowOpen?.after && rowOpen.after.url === rowOpen.before?.url) failures.push(`点行没有把抽屉状态写进 URL（仍是 ${rowOpen.after.url}）`);
    if (rowOpen?.after && rowOpen.after.pushStates !== null && rowOpen.after.pushStates <= (rowOpen.before?.pushStates ?? 0)) failures.push("点行没有走 history.pushState（原型 6-app.js:46 go()）");
    return failures;
  },
  "drawer-back-closes": (bundle) => {
    const { rowOpen } = bundle;
    const failures = [];
    if (!rowOpen?.afterBack) return ["缺 Back 之后的测量（场景没有跑到那一步）"];
    if (isTrue(rowOpen.afterBack.drawerVisible)) failures.push("浏览器 Back 之后抽屉仍然可见（原型 popstate → onRoute → closeDrawer）");
    if (rowOpen.afterBack.pageLoads !== rowOpen.before?.pageLoads) failures.push("Back 触发了整页导航而不是 popstate");
    if (rowOpen.afterBack.url !== rowOpen.before?.url) failures.push(`Back 之后的 URL 是 ${rowOpen.afterBack.url}，期望回到 ${rowOpen.before?.url}`);
    return failures;
  },
  "menu-floats-in-viewport": (bundle) => {
    const { menu } = bundle;
    const failures = [];
    if (!menu?.open?.menuVisible) return ["点 ⋯ 之后没有出现菜单浮层"];
    if (!menu.open.inside) failures.push(`菜单浮层超出视口：box=${JSON.stringify(menu.open.box)} viewport=${JSON.stringify(menu.open.viewport)}（原型 6-app.js:114 会把 left/top 夹进视口）`);
    if (menu.open.position === "static" && menu.open.positionedAncestor === "static") failures.push("菜单是 static 元素（不是浮层，会挤动表格）");
    if (menu.open.documentHeight !== menu.closed?.documentHeight) failures.push(`打开菜单改变了文档高度（${menu.closed?.documentHeight} → ${menu.open.documentHeight}）：菜单在推布局，不是浮层`);
    if (!(menu.open.itemCount > 0)) failures.push("菜单里没有任何可点项");
    return failures;
  },
  "menu-closes-on-outside-click": (bundle) => {
    const { menu } = bundle;
    const failures = [];
    if (!menu?.open?.menuVisible) return ["前提不成立：菜单从未打开"];
    if (isTrue(menu.outside?.menuVisible)) failures.push("点击菜单之外没有关闭菜单（原型 6-app.js:285 `if (!t.closest(\"#menu\")) closeMenu()`）");
    if (menu.outside?.pageLoads !== menu.closed?.pageLoads) failures.push("外点把页面导航了（文档重新加载）");
    return failures;
  },
  "menu-closes-on-escape": (bundle) => {
    const { menu } = bundle;
    if (!menu?.open?.menuVisible) return ["前提不成立：菜单从未打开"];
    return isTrue(menu.esc?.menuVisible) ? ["Esc 没有关闭菜单（原型 6-app.js:422 closeMenu()）"] : [];
  },
  "modal-centered": (bundle) => {
    const { modal } = bundle;
    if (!modal?.open?.modalVisible) return ["危险入口没有弹出确认框（原型 confirmBox(): `.modal.on` + `#mscrim.on`）"];
    const failures = [];
    if (modal.open.pageLoads !== modal.before?.pageLoads) failures.push("确认框是整页导航出来的（文档重新加载）：原型在当前页 insert，不导航");
    if (!modal.open.horizontallyCentered) failures.push(`确认框没有水平居中（水平中心偏移 ${modal.open.centerDelta?.x}）`);
    if (!modal.open.insideViewport) failures.push(`确认框没有完整落在视口内（box=${JSON.stringify(modal.open.box)}）`);
    if (!modal.open.upperHalf) failures.push(`确认框没有落在视口上半部（top=${modal.open.box?.top}，共享样式表把桌面端锚在 22vh）`);
    if (!modal.open.scrimVisible) failures.push("确认框没有 scrim");
    return failures;
  },
  "modal-typed-input-focused": (bundle) => {
    const { modal } = bundle;
    if (!modal?.open?.modalVisible) return ["前提不成立：确认框没有打开"];
    const failures = [];
    if (!modal.open.typedPresent) failures.push("确认框里没有 type-to-confirm 输入框");
    else if (!modal.open.typedFocused) failures.push("确认框打开后没有聚焦 type-to-confirm 输入框（原型 6-app.js:104 setTimeout(…focus(), 30)）");
    return failures;
  },
  "modal-confirm-gated-by-text": (bundle) => {
    const { modal } = bundle;
    if (!modal?.open?.modalVisible) return ["前提不成立：确认框没有打开"];
    const failures = [];
    if (modal.open.confirmDisabled !== true) failures.push("输入为空时确认按钮仍可点（原型 6-app.js:101 给出 `disabled`）");
    if (modal.typed?.confirmDisabled !== false) failures.push("输入完全匹配之后确认按钮仍然 disabled（原型 6-app.js:437 的 input 事件解除）");
    if (modal.wrong?.confirmDisabled !== true) failures.push("输入不匹配时确认按钮可点（必须按原型保持 disabled）");
    return failures;
  },
  "modal-escape-cancels": (bundle) => {
    const { modal } = bundle;
    if (!modal?.open?.modalVisible) return ["前提不成立：确认框没有打开"];
    const failures = [];
    if (!modal.esc?.pageLoads) return ["缺 Esc 之后的测量"];
    if (isTrue(modal.esc?.modalVisible)) failures.push("Esc 没有关掉确认框（原型 6-app.js:417 closeModal()）");
    if (isTrue(modal.esc?.focusInsideClosedOverlay)) failures.push("Esc 关闭后焦点留在已关闭的浮层里");
    if (modal.esc.pageLoads !== modal.before?.pageLoads) failures.push("Esc 触发了整页导航（文档重新加载）");
    return failures;
  },
  "toast-shown-then-expires": (bundle) => {
    const { toast } = bundle;
    if (!toast?.appeared) return ["缺 toast 测量（场景没有产出）"];
    if (!toast.appeared.toastVisible) return ["动作完成后没有出现 toast（原型每次成功动作都 toast）"];
    const failures = [];
    if (!toast.at1000?.toastVisible) failures.push("1s 时 toast 已经不在了（原型默认 3200ms，6-app.js:92）");
    // Wave R: 判据从“3.6s 那一刻已经消失”改成“它确实被自己的定时器收走，且不早于 ~2.5s”。
    // 改的是时序假设（固定偏移 → 轮询到状态变化），不是放宽：仍然要求出现、1s 仍在、且消失于默认时长附近。
    if (!toast.expired) failures.push("7s 内 toast 没有消失（原型 3200ms 后移除 `.on`）");
    else if (typeof toast.expiredAfterMs === "number" && toast.expiredAfterMs < 2500) {
      failures.push(`toast 只显示了 ${toast.expiredAfterMs}ms 就消失（原型默认 3200ms，6-app.js:92）`);
    }
    return failures;
  },
  "theme-toggles-without-navigation": (bundle) => {
    const { theme } = bundle;
    const failures = [];
    if (!theme?.before || !theme?.after) return ["缺主题切换前后的测量"];
    if (theme.before.theme === theme.after.theme) failures.push(`主题没有变化（仍是 ${theme.after.theme}）`);
    if (theme.after.pageLoads !== theme.before.pageLoads) failures.push("切换主题把页面导航/刷新了（文档重新加载；原型 setTheme 只改 dataset + localStorage）");
    if (theme.after.url !== theme.before.url) failures.push(`切换主题改变了 URL（${theme.before.url} → ${theme.after.url}）`);
    if (theme.after.stored !== theme.after.theme) failures.push(`localStorage 里的主题是 ${theme.after.stored}，期望 ${theme.after.theme}（原型 storageKey(\"theme\")）`);
    if (theme.after.metaThemeColor === theme.before.metaThemeColor) failures.push(`meta[theme-color] 没有跟着主题更新（仍是 ${theme.after.metaThemeColor}）`);
    if (theme.afterClick) {
      if (theme.afterClick.theme === theme.after.theme) failures.push("侧栏主题按钮没有切换主题（`t` 键之后按钮必须再切一次）");
      if (theme.afterClick.pageLoads !== theme.before.pageLoads) failures.push("侧栏主题按钮把页面整页导航了（原型 case \"theme\" 只在当前页 setTheme + render）");
    }
    return failures;
  },
  "shortcut-question-mark-opens-panel": (bundle) => {
    const { kbd } = bundle;
    const failures = [];
    if (!kbd?.open?.panelVisible) return ["`?` 没有打开快捷键面板（原型 showKbd()）"];
    if (kbd.open.kbdCount < 6) failures.push(`快捷键面板里只有 ${kbd.open.kbdCount} 个 <kbd>（原型渲染 9+8 行）`);
    if (kbd.open.pageLoads !== kbd.closed?.pageLoads) failures.push("`?` 触发了整页导航（文档重新加载）");
    return failures;
  },
  "shortcut-slash-focuses-search": (bundle) => {
    const { search } = bundle;
    if (!search?.after) return ["缺 `/` 之后的测量"];
    if (!search.after.searchPresent) return ["当前页没有搜索框，`/` 的判据无法成立（场景选页错误）"];
    const after = search.after;
    const focused = isTrue(after.activeIsSearch) || isTrue(after.activeInsideSearch);
    if (!focused) return [`\`/\` 没有把焦点移到搜索框（activeElement=${after.activeTag}[name=${after.activeName}]，搜索框=${JSON.stringify(after.searchField)}）`];
    if (isTrue(after.activeVisible) === false) return [`\`/\` 把焦点放进了一个不可见的控件（${after.activeTag}[name=${after.activeName}] 没有布局盒）`];
    return [];
  },
  "fragment-fetch-allowed": (bundle) => {
    const { fragment } = bundle;
    if (!fragment) return ["缺 fragment fetch 的测量"];
    const failures = [];
    if (fragment.ok !== true) failures.push(`同源 fragment fetch 失败：${fragment.error ?? `HTTP ${fragment.status}`}（CSP 下 connect-src 回落到 default-src 'none'）`);
    if ((fragment.violations ?? []).length) failures.push(`同源 fragment fetch 触发了 CSP 违规：${JSON.stringify(fragment.violations.slice(0, 3))}`);
    return failures;
  },
  "no-cross-origin-and-no-csp-violation": (bundle) => {
    const { observers } = bundle;
    if (!observers) return ["缺 observer 报告"];
    const failures = [];
    if (observers.violations.length) failures.push(`整段交互产生 ${observers.violations.length} 条 CSP 违规：${JSON.stringify(observers.violations.slice(0, 3))}`);
    if (observers.crossOrigin.length) failures.push(`整段交互产生 ${observers.crossOrigin.length} 个跨源请求：${JSON.stringify(observers.crossOrigin.slice(0, 3))}`);
    return failures;
  },
  "client-writes-values-with-textContent": (bundle) => {
    const { observers } = bundle;
    if (!observers) return ["缺 observer 报告"];
    const failures = [];
    if (observers.htmlSinks.length) failures.push(`客户端脚本用 HTML sink 写了 ${observers.htmlSinks.length} 次值：${JSON.stringify(observers.htmlSinks.slice(0, 3))}（硬规则 1：值只走 textContent）`);
    if (!(observers.actions > 0)) failures.push("整段交互里没有观察到任何客户端动作（fetch/pushState/HTML 写入），判定无法成立");
    return failures;
  },
  "no-inline-script-policy": (bundle) => {
    const { policy } = bundle;
    if (!policy) return ["缺 HTML 策略清单"];
    return scriptInventoryFailures(policy, { authenticated: true });
  },
});

/**
 * Which tree each verdict is asserted on. `both` verdicts are measured on the prototype *and* on the
 * live plane — the prototype's own record is the reference and must satisfy them all, so a verdict
 * nobody can satisfy fails on the prototype side (fail closed) instead of reading as a product bug.
 * `host` verdicts are properties of the Admin host (CSP/script policy, the enhancement's own HTML
 * sinks, its fragment fetch): the prototype cannot satisfy them by design — it *is* one inline
 * script — so they are asserted on the live plane only, with their own negative controls.
 */
export const VERDICT_IDS = Object.freeze(Object.keys(interactionVerdicts));
export const PROTOTYPE_VERDICT_IDS = Object.freeze(PROTOTYPE_BEHAVIOUR.filter((entry) => entry.plane === "both").map((entry) => entry.verdict));
export const HOST_VERDICT_IDS = Object.freeze(PROTOTYPE_BEHAVIOUR.filter((entry) => entry.plane === "host").map((entry) => entry.verdict));
