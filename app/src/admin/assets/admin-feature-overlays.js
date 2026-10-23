// Feature module: overlays — right-side drawer, floating row menu, centred modal confirm, toasts.
//
// Owned by lane L1. Behaviour to match `docs/admin-ui-proto/src/6-app.js`:
//   * `openDrawer` (200-208) / `drawerHtml` (219-362) / `closeDrawer` (209-218) — right panel over
//     the list, `history.pushState`, scrim, Esc / outside click / ✕ close, browser Back closes it;
//   * `openMenu` (114-126) / `menuItems` / `closeMenu` — floating `.menu.on` anchored to the ⋯
//     button, outside click and Esc close it, `j/k`/arrows move the highlight with the `.kb` marker;
//   * `confirmBox` (99-105) — centred `.modal.on` + scrim, focus the typed input, Enter confirms
//     (native implicit submission, so the server still validates `confirm`), Esc cancels;
//   * `toast` (92-97) — same 3.2 s default; the SSR `.result` line is the no-JS form of it.
//
// The SSR markup already carries the server-rendered equivalents (`?id=` drawer page,
// `<details class="mn">` menu, `?confirm=` page, `.result` banner). This module upgrades them: it
// intercepts the click, fetches the same URL as a fragment, shows the server's own `.drawer` /
// `.modal` / scrim in place, and pushes the URL the prototype would push. On any failure it falls
// through to the original navigation, because the page must never depend on the script.
//
// Rules this file keeps (AGENTS.md / docs/admin/README.md):
//   1. SSR stays the source of truth. No markup is authored here; the nodes shown are the ones the
//      server rendered, parsed by `ctx.fetchFragment`. No `innerHTML`, no data-derived strings.
//   2. No-JS keeps working: every intercepted click is a real `<a href>`, every submit stays a real
//      form POST, and a fragment that cannot be fetched falls back to real navigation.
//   3. CSP stays `script-src 'self'` with no inline script and no eval.
//
// Honest deviations (see CHECKPOINT.md):
//   * a link to another tab (`?tab=…` different from `.app[data-tab]`) is left to the browser: a real
//     navigation renders that page *and* its drawer server-side, which is what the SSR design
//     intends, while the prototype re-rendered the SPA in place;
//   * 6-app.js has no `mousemove` handler, so the menu position is only recomputed on resize/scroll;
//   * a `.result` line that carries a secret, a link or a copy affordance (the one-shot API key
//     banner) keeps its banner: a toast must never be the only carrier of a credential;
//   * `j/k` move the *menu* highlight while a menu is open. The prototype's `j/k` move table rows,
//     and they never coexist with an open menu in the prototype's own flow.
import { registerFeature } from "./admin-client.js";

/* ---------------------------------------------------------------- geometry */

/** Prototype `openMenu` (6-app.js:114-126) uses a 220px minimum width and an 8px viewport margin. */
const MENU_MIN_WIDTH = 220;
const MENU_GAP = 4;
const MENU_MARGIN = 8;

/**
 * Prototype `openMenu` placement, same arithmetic: right-aligned to the button, clamped inside the
 * viewport, flipped above the button when it would overflow the bottom.
 */
function placeMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(MENU_MIN_WIDTH, menu.offsetWidth || MENU_MIN_WIDTH);
  const height = menu.offsetHeight;
  const left = Math.max(MENU_MARGIN, Math.min(window.innerWidth - width - MENU_MARGIN, rect.right - width));
  const below = rect.bottom + MENU_GAP;
  const above = rect.top - height - MENU_GAP;
  const wanted = below + height > window.innerHeight ? above : below;
  const top = Math.max(MENU_MARGIN, Math.min(wanted, Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN)));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/**
 * May the toast take the place of this `.result` line? Only for plain text: a banner that carries a
 * secret, a link or a control stays where it is (the theme/doc rule is that the toast is never the
 * only carrier of something the operator has to keep or click).
 */
function isToastableResult(node) {
  if (node.querySelector("a,button,input,select,textarea,code,.secret,.help,ul,ol,img")) return false;
  return node.textContent.trim().length > 0;
}

/** While a synthetic click runs, the menu must not drag focus back to its `<summary>` (see below). */
let refocusSuspended = false;

/** Focus target for "close, then put the caret back where the operator left it". */
function refocus(trigger) {
  if (refocusSuspended) return false;
  if (!trigger || !document.contains(trigger)) return false;
  // A link inside a closed `<details class="mn">` is unrendered, so its summary is the honest anchor.
  const host = trigger.closest?.("details.mn");
  const target = host && !host.open ? host.querySelector("summary") : trigger;
  if (!target || !document.contains(target)) return false;
  try {
    target.focus({ preventScroll: true });
  } catch {
    return false;
  }
  return document.activeElement === target;
}

/* ---------------------------------------------------------------- feature */

registerFeature("overlays", (ctx) => {
  /** Every mounted overlay, so a close can hand the DOM back exactly as the server rendered it. */
  const entries = [];
  let scrollLocks = 0;

  const currentTab = () => document.querySelector(".app[data-tab]")?.dataset.tab || null;

  /**
   * Classify a same-document Admin URL as an overlay the prototype would have shown in place.
   * `?confirm=` wins over `?id=` (`ui.confirmPage` renders over the drawer that links to it).
   * Another `tab` — or another path — is a real navigation and is left alone.
   */
  function classify(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    if (url.origin !== location.origin) return null;
    if (url.pathname !== location.pathname) return null;
    const params = url.searchParams;
    const tab = currentTab();
    const targetTab = params.get("tab");
    if (targetTab && tab && targetTab !== tab) return null;
    if (params.get("confirm")) return { kind: "modal", url: url.href };
    if (params.get("id")) return { kind: "drawer", url: url.href };
    return null;
  }

  function lockScroll() {
    scrollLocks += 1;
    document.body.classList.add("overlay-open");
  }

  function releaseScrollLock() {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (!scrollLocks) document.body.classList.remove("overlay-open");
  }

  /* ------------------------------------------------------------ overlay registry */

  function register(entry) {
    entries.push(entry);
    ctx.openOverlay(entry);
    lockScroll();
    return entry;
  }

  function detach(entry) {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  }

  const openMenuEntry = () => [...entries].reverse().find((entry) => entry.kind === "menu") || null;
  const openByKind = (kind) => [...entries].reverse().find((entry) => entry.kind === kind) || null;

  /**
   * Close, in the order the prototype implies: a history-owned overlay first hands the URL back
   * (`closeDrawer`/`closeModal` return to the list URL) and lets the resulting `popstate` finish the
   * teardown — that is what makes browser Back mean "close the drawer" without a reload.
   */
  function requestClose(entry, { fromHistory = false } = {}) {
    if (!entry || entry.closed) return;
    // `closing` means one `history.back()` of ours is still in flight: the `popstate` it produces is
    // the *completion* of this close, not a second request, so it finishes the teardown here.
    if (entry.closing) {
      if (fromHistory) finishClose(entry);
      return;
    }
    if (!fromHistory && entry.historyOwned) {
      entry.closing = true;
      window.history.back();
      return;
    }
    finishClose(entry);
  }

  function finishClose(entry) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.closing = false;
    ctx.closeOverlay(entry); // splices the stack; the entry's own close() is a no-op from here
    detach(entry);
    for (const node of entry.nodes) node.remove();
    releaseScrollLock();
    refocus(entry.trigger);
  }

  /* ------------------------------------------------------------ drawer (6-app.js:200-218) */

  /** Show the server's `.drawer` + `.scrim` for `target.url`; `false` means "let the browser go". */
  async function mountDrawer(target, { trigger = null, push = true } = {}) {
    closeMenus();
    let fragment;
    try {
      fragment = await ctx.fetchFragment(target.url);
    } catch (error) {
      reportDegrade("drawer", target.url, error);
      return false;
    }
    const drawer = fragment.querySelector(".drawer");
    if (!drawer) return false; // not an overlay after all (e.g. the AuthZ editor page)
    const existing = openByKind("drawer");
    // Re-clicking the row whose drawer is open must not stack another history entry on the same URL
    // (that would make ✕ / Back re-open it). The fetched fragment is simply dropped.
    if (existing && existing.url === target.url) return true;
    const scrim = fragment.querySelector(".scrim");
    const nodes = scrim ? [scrim, drawer] : [drawer];
    if (existing) {
      // Prototype `go()`: a second row click pushes another entry and re-renders the drawer in place.
      for (const node of existing.nodes) node.remove();
      existing.nodes = nodes;
      existing.url = target.url;
      if (trigger) existing.trigger = trigger;
      document.body.append(...nodes);
      wireDrawer(existing, drawer);
      if (push) ctx.push(target.url);
      focusDrawer(drawer);
      return true;
    }
    document.body.append(...nodes);
    drawer.classList.add("on");
    if (scrim) scrim.classList.add("on");
    const entry = register({
      kind: "drawer",
      url: target.url,
      nodes,
      trigger,
      historyOwned: true,
      closed: false,
      closing: false,
      close(options = {}) {
        requestClose(entry, options);
      },
    });
    wireDrawer(entry, drawer);
    if (push) ctx.push(target.url);
    focusDrawer(drawer);
    return true;
  }

  function wireDrawer(entry, drawer) {
    // `ui.drawer` renders the header ✕ and the footer 取消 as real links to the list URL; with the
    // script the overlay closes in place instead of reloading the list. Nothing else in the drawer
    // is touched — its other links (`?tab=audit&q=…`, `?confirm=…`) keep their own meaning.
    for (const dismiss of drawer.querySelectorAll('header a.ibtn[aria-label="关闭"], footer.dfoot a.btn.ghost')) {
      dismiss.dataset.overlayDismiss = entry.kind;
    }
  }

  function focusDrawer(drawer) {
    const close = drawer.querySelector('header a.ibtn[aria-label="关闭"]');
    if (!close) return;
    try {
      close.focus({ preventScroll: true });
    } catch {
      /* focus is an enhancement, never a precondition */
    }
  }

  /* ------------------------------------------------------------ modal (6-app.js:99-105) */

  /** Show the server's `.modal` + `.scrim` for `target.url`; `false` means "let the browser go". */
  async function mountModal(target, { trigger = null, push = true } = {}) {
    closeMenus();
    let fragment;
    try {
      fragment = await ctx.fetchFragment(target.url);
    } catch (error) {
      reportDegrade("modal", target.url, error);
      return false;
    }
    const modal = fragment.querySelector(".modal");
    if (!modal) return false;
    const scrim = fragment.querySelector(".scrim");
    const nodes = scrim ? [scrim, modal] : [modal];
    document.body.append(...nodes);
    modal.classList.add("on"); // prototype state class; `ui.confirmPage` ships `.modal.show`
    if (scrim) scrim.classList.add("on");
    const entry = register({
      kind: "modal",
      url: target.url,
      nodes,
      trigger,
      historyOwned: true,
      closed: false,
      closing: false,
      close(options = {}) {
        requestClose(entry, options);
      },
    });
    // `ui.confirmPage`'s 取消 control is a link back to the list/drawer URL: close in place.
    for (const dismiss of modal.querySelectorAll(".acts a.btn")) dismiss.dataset.overlayDismiss = "modal";
    if (push) ctx.push(target.url);
    gateTypedConfirm(modal);
    focusModal(modal);
    return true;
  }

  /*
   * Prototype `confirmBox`'s typed gate (`6-app.js:101` renders the button `disabled`, `6-app.js:437`
   * re-enables it on the input event): the action stays unavailable until the typed text matches the
   * target, and is disabled again when it stops matching.
   *
   * The server-rendered form ships the button **enabled** on purpose — that is the no-JS contract
   * (`ui.confirmPage`: the scriptless browser must be able to submit, and the server compares
   * `confirm` itself under POST + CSRF) — so re-adding the prototype's gate is precisely the job of
   * the enhancement, and the server check stays the authority. The target string is read from the
   * page's own markup (`.tc code`, or the inline form's `pattern`), never composed here.
   *
   * ONLY a text-entry control can carry that gate. A modal may legitimately submit other controls
   * named `confirm` — the Vault admission dialog submits one `confirm` CHECKBOX per Vault — and a
   * checkbox's `value` is the Vault id, which the operator can never type: adopting it disabled the
   * dialog's primary action permanently in every script browser, so a fresh deployment still could not
   * be switched to multi-vault from the UI (blocker found in review v31-r1, 2026-10-22). `ui.confirmPage`
   * renders the typed input as `input.inp[name=confirm]`; `[data-typeconf]` stays the explicit opt-in.
   *
   * A control that CLAIMS to be the typed gate but cannot be gated (not a text entry, no target string in
   * the markup, or no submit to gate) is marked `data-typed-gate-degraded` instead of being skipped
   * silently: the layout gate asserts that marker absent on every typed modal it exercises, because both
   * directions of a miss are failures — locking the operator (F1 above) and quietly removing the gate.
   */
  const TEXT_ENTRY_TYPES = new Set(["text", "search", "password", "email", "tel", "url", "number"]);
  const isTextEntry = (control) => control instanceof HTMLTextAreaElement
    || (control instanceof HTMLInputElement && TEXT_ENTRY_TYPES.has(control.type));

  function gateTypedConfirm(modal) {
    if (!modal || modal.dataset.typedGate === "1") return;
    const declared = modal.querySelector("[data-typeconf]");
    const typed = declared ?? modal.querySelector("input.inp[name=confirm]");
    if (!typed) return; // nothing in this modal claims to be a typed gate
    const submit = modal.querySelector('button[type="submit"]') || modal.querySelector(".acts button");
    const target = modal.querySelector(".tc code")?.textContent ?? typed.getAttribute("pattern") ?? "";
    if (!isTextEntry(typed) || !target || !submit) {
      modal.dataset.typedGateDegraded = "1";
      return;
    }
    modal.dataset.typedGate = "1";
    const apply = () => { submit.disabled = String(typed.value ?? "") !== target; };
    typed.addEventListener("input", apply);
    apply();
  }

  /** Prototype focuses the typed input after 30ms; the fragment is already in the DOM by now. */
  function focusModal(modal) {
    const typed = modal.querySelector("[data-typeconf], input[name=confirm]");
    const submit = modal.querySelector(".acts button, .acts a.btn");
    const target = typed || submit;
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------ menu (6-app.js:114-126) */

  function closeMenus() {
    for (const entry of [...entries]) if (entry.kind === "menu") entry.close();
    // A menu the browser opened by itself (native `<details>`, e.g. before this module booted).
    for (const host of document.querySelectorAll("details.mn[open]")) if (!host.dataset.floating) host.open = false;
  }

  function openMenu(details, summary) {
    const menu = details.querySelector(".menu");
    if (!menu) return false; // leave the native `<details>` behaviour alone
    closeMenus();
    details.open = true;
    details.dataset.floating = "1";
    menu.classList.add("on");
    // The SSR stylesheet positions `.mn > .menu` inside its cell; the prototype floats it, so the
    // override is inline and removed again on close — no stylesheet and no markup is rewritten.
    menu.style.position = "fixed";
    menu.style.right = "auto";
    menu.style.minWidth = `${MENU_MIN_WIDTH}px`;
    menu.style.display = "block";
    placeMenu(menu, summary);

    const reposition = () => {
      if (!entry.closed) placeMenu(menu, summary);
    };
    const entry = {
      kind: "menu",
      url: location.href,
      nodes: [],
      trigger: summary,
      historyOwned: false, // the prototype's menu is not a history state
      closed: false,
      closing: false,
      index: -1,
      menu,
      close({ fromHistory = false } = {}) {
        if (entry.closed) return;
        entry.closed = true;
        ctx.closeOverlay(entry);
        detach(entry);
        window.removeEventListener("resize", reposition);
        window.removeEventListener("scroll", reposition, true);
        menu.classList.remove("on");
        for (const property of ["position", "left", "top", "right", "minWidth", "display"]) menu.style.removeProperty(property);
        delete details.dataset.floating;
        details.open = false;
        releaseScrollLock();
        if (!fromHistory) refocus(summary);
      },
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    register(entry);
    highlightMenuItem(entry, -1);
    return true;
  }

  const menuItems = (entry) => [...entry.menu.querySelectorAll("a, button")].filter((item) => !item.disabled);

  function highlightMenuItem(entry, index) {
    const items = menuItems(entry);
    items.forEach((item, position) => {
      const on = position === index;
      item.classList.toggle("kb", on);
      // `.menu button.kb` paints the highlight; `ui.moreMenu` also renders anchors, so paint those.
      if (on) item.style.background = "var(--hover)";
      else item.style.removeProperty("background");
    });
    entry.index = index;
    if (index >= 0) items[index].scrollIntoView({ block: "nearest" });
  }

  function moveMenuHighlight(entry, delta) {
    const items = menuItems(entry);
    if (!items.length) return;
    const next = Math.max(0, Math.min(items.length - 1, entry.index + delta));
    highlightMenuItem(entry, next);
  }

  /* ------------------------------------------------------------ toast (6-app.js:92-97) */

  /**
   * The SSR result line is the no-JS form of the prototype's toast. With the script present the line
   * becomes the toast (same text, same 3.2 s default) and the banner is hidden in place — never
   * removed — so the scripted and unscripted pages carry exactly the same content.
   */
  function adoptResultBanners() {
    for (const banner of document.querySelectorAll(".result")) {
      if (banner.dataset.overlayToast === "1") continue;
      if (!isToastableResult(banner)) continue;
      banner.dataset.overlayToast = "1";
      const wrapper = banner.parentElement;
      const hide = wrapper && wrapper.classList.contains("content") && wrapper.children.length === 1 ? wrapper : banner;
      hide.style.display = "none";
      ctx.toast(banner.textContent.trim().replace(/\s+/g, " "), { err: banner.classList.contains("err") });
    }
  }

  /* ------------------------------------------------------------ click routing */

  /** A failed fragment fetch must not eat the action: fall back to the real navigation. */
  function reportDegrade(kind, url, error) {
    console.warn(`[admin] ${kind} overlay unavailable (${url}): ${error?.message ?? error}; falling back to navigation`);
  }

  /**
   * Take over the click, or hand the action back to the browser. `preventDefault()` has to happen
   * before the (async) fragment fetch, so *every* failure path — fetch refused, no overlay in the
   * fragment, or an unexpected exception — restores the very navigation the link always had.
   */
  async function intercept(event, anchor, target) {
    event.preventDefault();
    let taken = false;
    try {
      taken = target.kind === "modal"
        ? await mountModal(target, { trigger: anchor })
        : await mountDrawer(target, { trigger: anchor });
    } catch (error) {
      reportDegrade(target.kind, target.url, error);
    }
    if (!taken) location.assign(target.url);
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;

    const summary = target.closest?.("details.mn > summary");
    if (summary) {
      event.preventDefault();
      const details = summary.closest("details.mn");
      if (openMenuEntry() || details.open) closeMenus();
      else openMenu(details, summary);
      return;
    }

    const scrim = target.closest?.(".scrim");
    const scrimEntry = scrim ? entries.find((entry) => entry.nodes.includes(scrim)) : null;
    if (scrimEntry) {
      event.preventDefault();
      requestClose(scrimEntry);
      return;
    }

    const dismiss = target.closest?.("[data-overlay-dismiss]");
    if (dismiss) {
      event.preventDefault();
      const owner = entries.find((entry) => entry.nodes.some((node) => node.contains(dismiss)));
      requestClose(owner, {});
      return;
    }

    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = target.closest?.("a[href]");
    if (anchor && (!anchor.target || anchor.target === "_self") && !anchor.hasAttribute("download")) {
      const overlay = classify(anchor.getAttribute("href"));
      if (overlay) {
        void intercept(event, anchor, overlay);
        return;
      }
    }
    if (target.closest?.("details.mn")) return; // a click inside an open row menu (incl. its `<hr>`)
    closeMenus();
  }, true);

  /* ------------------------------------------------------------ keyboard */

  /**
   * Capture phase, and only while a menu owns the keyboard. Esc is deliberately *not* handled here:
   * `ctx.openOverlay`/`topOverlay` plus the shell's key router already close the top overlay
   * (drawer, modal, menu) on Esc, and every entry this module registers implements `close()`. What is
   * left is the part the foundation cannot know: the prototype's menu keys, and the rule that no
   * shortcut fires while a modal is open (6-app.js:410-417 returns early whenever the modal is up).
   */
  document.addEventListener("keydown", (event) => {
    const menu = openMenuEntry();
    if (menu) {
      if (event.key === "j" || event.key === "ArrowDown") {
        swallow(event);
        moveMenuHighlight(menu, 1);
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        swallow(event);
        moveMenuHighlight(menu, -1);
        return;
      }
      if (event.key === "Enter") {
        const items = menuItems(menu);
        if (menu.index >= 0 && items[menu.index]) {
          swallow(event);
          // The row button keeps focus after this keydown, and a synthetic click closes the menu —
          // restoring focus to the still-focused `<summary>` would let the tail of the *same* key
          // press activate it and re-open the menu. Drop focus; the overlay that opens takes it.
          refocusSuspended = true;
          try {
            menu.trigger?.blur();
            items[menu.index].click();
          } finally {
            refocusSuspended = false;
          }
        }
        return;
      }
      if (event.key === "Tab") {
        menu.close();
      }
      return; // the prototype lets other keys through while a menu is open
    }

    const modal = openByKind("modal");
    if (!modal) return;
    // With the modal open the prototype fires no shortcut. Esc and Enter are left to the browser and
    // to the shell's overlay stack, so the form still submits natively and the server's `confirm`
    // check stays the authority.
    const typing = ["input", "textarea", "select"].includes(event.target?.tagName?.toLowerCase());
    if (event.key !== "Enter" && event.key !== "Escape" && !typing) swallow(event);
  }, true);

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /* ------------------------------------------------------------ popstate */

  /**
   * Browser Back/Forward. The shell closes the top overlay on `popstate` (admin-client.js); this
   * listener runs after it and re-opens whatever the *new* URL asks for, so Back from a confirm
   * returns to the drawer it was opened from, and Forward returns to the confirm.
   */
  window.addEventListener("popstate", () => {
    const target = classify(location.href);
    if (!target) return;
    const open = openByKind(target.kind);
    if (open && open.url === location.href) return; // already showing this URL (e.g. the drawer)
    if (open) finishClose(open);
    if (target.kind === "modal") void mountModal(target, { push: false });
    else void mountDrawer(target, { push: false });
  });

  /* ------------------------------------------------------------ boot */

  adoptResultBanners();
  // A confirm page opened directly (`?confirm=…` with the script present) never goes through
  // `mountModal`, so the typed gate is adopted from the server-rendered modal too.
  for (const modal of document.querySelectorAll(".modal")) gateTypedConfirm(modal);
});
