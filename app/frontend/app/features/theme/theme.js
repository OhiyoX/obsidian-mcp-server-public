const THEME_KEY = "obsidian-web.theme";
const MODE_KEY = "obsidian-web.color-mode";
const DESKTOP_THEME = "__desktop__";
const media = matchMedia("(prefers-color-scheme: dark)");

function stored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function applyMode(mode) {
  const dark = mode === "dark" || (mode === "system" && media.matches);
  for (const node of [document.documentElement, document.body]) {
    node.classList.toggle("theme-dark", dark);
    node.classList.toggle("theme-light", !dark);
  }
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function applyTheme(theme) {
  const link = document.querySelector("#community-theme");
  if (!link) return;
  if (!theme) {
    link.removeAttribute("href");
    link.disabled = true;
    document.body.dataset.theme = "default";
    return;
  }
  link.disabled = false;
  link.href = `/api/web/v1/theme.css?name=${encodeURIComponent(theme)}`;
  document.body.dataset.theme = theme;
}

export async function initializeTheme({ api, toast }) {
  const themeSelect = document.querySelector("#theme-select");
  const modeSelect = document.querySelector("#color-mode");
  try {
    const data = await api("/api/web/v1/themes");
    const appearance = data.appearance || { themeId: data.defaultTheme || "", colorMode: "system", baseFontSize: 16 };
    document.documentElement.style.setProperty("--font-text-size", `${appearance.baseFontSize || 16}px`);
    let mode = stored(MODE_KEY, "desktop");
    if (!["desktop", "system", "light", "dark"].includes(mode)) mode = "desktop";
    const resolvedMode = () => mode === "desktop" ? (appearance.colorMode || "system") : mode;
    if (modeSelect) modeSelect.value = mode;
    applyMode(resolvedMode());
    media.addEventListener?.("change", () => {
      if (resolvedMode() === "system") applyMode("system");
    });
    modeSelect?.addEventListener("change", () => {
      mode = modeSelect.value;
      remember(MODE_KEY, mode);
      applyMode(resolvedMode());
    });

    const selected = stored(THEME_KEY, DESKTOP_THEME);
    themeSelect.replaceChildren();
    const desktop = document.createElement("option");
    desktop.value = DESKTOP_THEME;
    desktop.textContent = `跟随 Obsidian 桌面端${appearance.themeId ? `（${appearance.themeId}）` : ""}`;
    themeSelect.append(desktop);
    const base = document.createElement("option");
    base.value = "";
    base.textContent = "Obsidian 默认主题";
    themeSelect.append(base);
    for (const theme of data.themes) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.name + (theme.legacy ? "（旧版）" : "");
      option.title = [theme.author, theme.version].filter(Boolean).join(" · ");
      themeSelect.append(option);
    }
    const valid = selected === DESKTOP_THEME || selected === "" || data.themes.some((theme) => theme.id === selected) ? selected : DESKTOP_THEME;
    themeSelect.value = valid;
    // Prefer desktop cssTheme (e.g. Things) so Web matches Obsidian appearance.json.
    applyTheme(valid === DESKTOP_THEME ? (appearance.themeId || "") : valid);
    remember(THEME_KEY, valid);
    themeSelect.addEventListener("change", () => {
      remember(THEME_KEY, themeSelect.value);
      applyTheme(themeSelect.value === DESKTOP_THEME ? (appearance.themeId || "") : themeSelect.value);
    });
  } catch (error) {
    applyMode(media.matches ? "dark" : "light");
    applyTheme("");
    toast(`主题列表加载失败：${error.message}`, true);
  }
}
