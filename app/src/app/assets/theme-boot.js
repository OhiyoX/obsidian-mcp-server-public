const MODE_KEY = "obsidian-web.color-mode";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const MODES = new Set(["dark", "light", "system", "desktop"]);
const DEFAULT_THEME_COLORS = Object.freeze({ light: "#ffffff", dark: "#212121" });

function storedMode() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

function renderedSurfaceColor() {
  const surface = document.querySelector(".workspace") || document.body;
  if (!surface || typeof getComputedStyle !== "function") return "";
  const color = getComputedStyle(surface).backgroundColor?.trim();
  if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return "";
  return color;
}

function syncBrowserThemeColor(dark = document.documentElement.classList.contains("theme-dark")) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute("content", renderedSurfaceColor() || DEFAULT_THEME_COLORS[dark ? "dark" : "light"]);
}

function apply(dark) {
  for (const node of [document.documentElement, document.body]) {
    if (!node) continue;
    node.classList.toggle("theme-dark", dark);
    node.classList.toggle("theme-light", !dark);
  }
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  syncBrowserThemeColor(dark);
}

function resolveDark(preferred) {
  const mode = storedMode() || preferred || "system";
  if (mode === "dark") return true;
  if (mode === "light") return false;
  if (mode === "desktop") {
    const desktop = document.documentElement.dataset.desktopColorMode || preferred || "system";
    if (desktop === "dark") return true;
    if (desktop === "light") return false;
    return media.matches;
  }
  return media.matches;
}

const preferred = document.documentElement.dataset.colorMode || "system";
function getMode() {
  const mode = storedMode() || preferred;
  return MODES.has(mode) ? mode : preferred;
}

function announce(mode = getMode()) {
  document.dispatchEvent(new CustomEvent("obsidian-theme-change", {
    detail: { mode, dark: document.documentElement.classList.contains("theme-dark") },
  }));
}

function setMode(mode) {
  if (!MODES.has(mode) || mode === "desktop") mode = mode === "desktop" ? "system" : preferred;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Theme switching still applies for this page when storage is unavailable.
  }
  apply(resolveDark(mode));
  document.documentElement.dataset.colorMode = mode;
  announce(mode);
  return mode;
}

function toggle() {
  return setMode(document.documentElement.classList.contains("theme-dark") ? "light" : "dark");
}

function watchRenderedTheme() {
  const observer = typeof MutationObserver === "function"
    ? new MutationObserver(() => syncBrowserThemeColor())
    : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-color-mode"] });
  if (document.body) {
    observer?.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
  }
  document.querySelector("#community-theme")?.addEventListener("load", () => syncBrowserThemeColor());
  syncBrowserThemeColor();
}

window.obsidianWebTheme = {
  getMode,
  isDark: () => document.documentElement.classList.contains("theme-dark"),
  setMode,
  toggle,
  syncBrowserThemeColor,
};
apply(resolveDark(preferred));
if (!document.body) {
  document.addEventListener("DOMContentLoaded", () => {
    apply(resolveDark(preferred));
    watchRenderedTheme();
  }, { once: true });
} else {
  watchRenderedTheme();
}
window.addEventListener?.("load", () => syncBrowserThemeColor(), { once: true });
media.addEventListener?.("change", () => {
  const mode = getMode();
  if (mode === "system" || mode === "desktop") {
    apply(resolveDark(mode));
    announce(mode);
  }
});
