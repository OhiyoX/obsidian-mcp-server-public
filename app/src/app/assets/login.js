const MODE_KEY = "obsidian-web.color-mode";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const DEFAULT_THEME_COLORS = Object.freeze({ light: "#ffffff", dark: "#212121" });

function storedMode() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

function renderedSurfaceColor() {
  const surface = document.querySelector(".login-page") || document.body;
  if (!surface || typeof getComputedStyle !== "function") return "";
  const color = getComputedStyle(surface).backgroundColor?.trim();
  if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return "";
  return color;
}

function syncBrowserThemeColor(dark) {
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
apply(resolveDark(preferred));
if (!document.body) {
  document.addEventListener("DOMContentLoaded", () => apply(resolveDark(preferred)), { once: true });
}
window.addEventListener?.("load", () => syncBrowserThemeColor(resolveDark(preferred)), { once: true });
media.addEventListener?.("change", () => {
  const mode = storedMode() || preferred;
  if (mode === "system" || mode === "desktop") apply(resolveDark(preferred));
});
