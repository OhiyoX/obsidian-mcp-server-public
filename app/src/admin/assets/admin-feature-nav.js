// Feature module: the narrow-screen navigation overlay.
//
// **This is a user-decided DESIGN ADDITION, not prototype parity (2026-10-18).** The prototype's page
// bar carries `<button class="ibtn mobile-only" data-act="mmenu">` (`5-render.js:106`) but that marker
// is dead: `.mobile-only` has no rule, the button is inline-`display:none` in both viewports, and no
// handler in `6-app.js` listens for `mmenu`. The owner therefore decided that the plane gets a real
// narrow-screen menu; `docs/QUALITY_AUDIT.md` and `docs/admin/README.md` record it as an addition.
//
// It reuses no new breakpoint: the plane's own mobile layout is `@media (max-width:720px)`
// (`docs/admin-ui-proto/src/1-head.html:353`), and the overlay is that same viewport's sidebar.
//
// No-JS contract: the SSR renders `?nav=1` as the open state — the sidebar is an overlay with a scrim
// and a close link back to the current URL — and the toggle is a real link to `?nav=1`. So the menu
// is fully usable with the script absent (and the bottom `.mnav` stays where it is). With the script
// running the same markup is opened in place (`pushState`, no reload), and Esc / scrim / a nav item /
// a second press of the toggle all close it, with focus handed back to the toggle.
import { registerFeature } from "./admin-client.js";

const NARROW = "(max-width: 720px)";

registerFeature("nav", (ctx) => {
  const toggle = document.querySelector("[data-nav-toggle]");
  const side = document.querySelector("aside.side") || document.querySelector(".side");
  if (!toggle || !side) return;
  if (!side.id) side.id = "admin-nav";
  const narrow = window.matchMedia(NARROW);

  /** `?nav=1` is the server's open state; the client keeps the same URL while the overlay is open. */
  const isOpen = () => side.classList.contains("nav-open");
  const urlWithoutNav = () => {
    const url = new URL(location.href);
    url.searchParams.delete("nav");
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const urlWithNav = () => {
    const url = new URL(location.href);
    url.searchParams.set("nav", "1");
    return `${url.pathname}${url.search}${url.hash}`;
  };

  let entry = null;
  let closing = false;
  let pushed = false;
  let serverOpen = isOpen();

  let veil = document.querySelector("#mscrim[data-nav-scrim], [data-nav-scrim]");
  function scrim() {
    if (veil && document.contains(veil)) return veil;
    veil = document.createElement("div");
    veil.id = "mscrim";
    veil.className = "scrim";
    veil.dataset.navScrim = "1";
    document.body.appendChild(veil);
    return veil;
  }

  function register() {
    if (entry) return;
    entry = {
      closed: false,
      close(options = {}) {
        if (entry?.closed) return;
        requestClose(options);
      },
    };
    ctx.openOverlay(entry);
  }

  function openNav({ push = true } = {}) {
    const top = ctx.topOverlay();
    if (top && top !== entry) top.close();
    side.classList.add("nav-open");
    if (narrow.matches) {
      side.setAttribute("role", "dialog");
      side.setAttribute("aria-modal", "true");
    }
    toggle.setAttribute("aria-expanded", "true");
    if (narrow.matches) document.body.classList.add("nav-overlay-open");
    const shade = scrim();
    shade.classList.add("on");
    shade.onclick = () => requestClose();
    register();
    if (push && !pushed) {
      pushed = true;
      history.pushState({ adminClient: "nav" }, "", urlWithNav());
    }
    const first = side.querySelector("a[href], button:not([data-nav-close])");
    if (first) {
      try { first.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Close order mirrors the drawer: a `?nav=1` this client pushed is handed back with `history.back()`
   * and the resulting `popstate` finishes the teardown (so browser Back means "close the menu"); the
   * server-rendered `?nav=1` (no history entry of ours) is replaced in place, without a reload.
   */
  function requestClose({ fromHistory = false } = {}) {
    if (closing) {
      if (fromHistory) finishClose();
      return;
    }
    if (pushed && !fromHistory) {
      closing = true;
      history.back();
      return;
    }
    finishClose();
  }

  function finishClose() {
    const wasOpen = isOpen();
    closing = false;
    pushed = false;
    side.classList.remove("nav-open");
    side.removeAttribute("role");
    side.removeAttribute("aria-modal");
    toggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("nav-overlay-open");
    if (veil) {
      veil.classList.remove("on");
      veil.onclick = null;
    }
    if (entry) {
      entry.closed = true;
      ctx.closeOverlay(entry);
      entry = null;
    }
    if (serverOpen) {
      serverOpen = false;
      history.replaceState({ adminClient: "root" }, "", urlWithoutNav());
    }
    if (wasOpen) {
      try { toggle.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }

  // --- the control ---------------------------------------------------------------------------
  toggle.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault();
    if (isOpen()) requestClose();
    else openNav({ push: true });
  });
  for (const node of document.querySelectorAll("[data-nav-close]")) {
    if (node === toggle) continue;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      requestClose();
    });
  }

  // --- the server's own open state -----------------------------------------------------------
  if (serverOpen) {
    if (!narrow.matches) {
      // `?nav=1` on a wide viewport is not an overlay: hand the URL back instead of leaving a modal
      // role on an always-visible sidebar.
      finishClose();
    } else {
      openNav({ push: false });
      serverOpen = true;
    }
  }

  // The breakpoint and the overlay cannot disagree: leaving the narrow viewport closes the overlay.
  const onViewport = () => {
    if (!isOpen()) return;
    if (!narrow.matches) requestClose();
  };
  if (typeof narrow.addEventListener === "function") narrow.addEventListener("change", onViewport);
  else narrow.addListener(onViewport);
});
