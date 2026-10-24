// Search-syntax help popover.
//
// The sidebar is `overflow: hidden`; the absolute card was therefore clipped as soon as
// the sidebar was narrower than the card (the default 270px sidebar vs a 310px card hid
// the left half of every syntax example). It now positions itself from viewport
// coordinates through `ui/popup-position.js` and can be dismissed from anywhere
// (outside click / Escape) so it never traps the note list.
import { applyPopupLayout, computePopupLayout } from "../../ui/popup-position.js";

export const HELP_CARD_MAX_WIDTH = 310;
export const HELP_CARD_MIN_WIDTH = 200;
export const HELP_CARD_MAX_HEIGHT = 420;
export const HELP_CARD_MIN_HEIGHT = 120;

export function computeHelpCardLayout({ button, viewport } = {}) {
  return computePopupLayout({
    trigger: button,
    viewport,
    maxWidth: HELP_CARD_MAX_WIDTH,
    minWidth: HELP_CARD_MIN_WIDTH,
    maxHeight: HELP_CARD_MAX_HEIGHT,
    minHeight: HELP_CARD_MIN_HEIGHT,
    preferredHeight: 280,
  });
}

// DOM wiring: position on open, keep it in the viewport on resize/scroll, and close on
// outside click / Escape (a second trigger click toggles natively via `<details>`).
export function initializeSearchHelp({ root = globalThis.document, win = globalThis.window } = {}) {
  const details = root?.querySelector?.(".search-help");
  const card = details?.querySelector?.(".search-help-card");
  const trigger = details?.querySelector?.("summary");
  if (!details || !card || !trigger || !win) return null;

  function position() {
    applyPopupLayout(card, computeHelpCardLayout({
      button: trigger.getBoundingClientRect(),
      viewport: { width: win.innerWidth, height: win.innerHeight },
    }));
  }

  function close() {
    if (details.open) details.open = false;
  }

  details.addEventListener("toggle", () => {
    card.classList.toggle("is-positioned", details.open);
    if (details.open) position();
  });
  root.addEventListener("pointerdown", (event) => {
    if (details.open && !details.contains(event.target)) close();
  }, true);
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !details.open) return;
    event.stopPropagation();
    close();
    trigger.focus?.();
  });
  win.addEventListener("resize", () => { if (details.open) position(); }, { passive: true });
  win.addEventListener("scroll", () => { if (details.open) position(); }, { passive: true, capture: true });

  return { position, close, isOpen: () => details.open };
}
