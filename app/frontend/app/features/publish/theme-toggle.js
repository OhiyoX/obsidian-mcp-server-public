import { t } from "../../core/i18n.js";

export function publishThemeToggleView(dark) {
  return dark
    ? { targetMode: "light", label: t("publish.theme.light"), title: t("publish.theme.toLight") }
    : { targetMode: "dark", label: t("publish.theme.dark"), title: t("publish.theme.toDark") };
}

export function syncPublishThemeToggle(button, dark) {
  if (!button) return;
  const view = publishThemeToggleView(Boolean(dark));
  const label = button.querySelector("[data-publish-theme-label]");
  if (label) label.textContent = view.label;
  button.setAttribute("data-target-mode", view.targetMode);
  button.title = view.title;
  button.setAttribute("aria-label", view.title);
}

export function initializePublishThemeToggle({
  button = globalThis.document?.querySelector?.("#publish-theme-toggle"),
  theme = globalThis.window?.obsidianWebTheme,
  eventTarget = globalThis.document,
} = {}) {
  if (!button || !theme || typeof theme.isDark !== "function" || typeof theme.toggle !== "function") return () => {};

  const sync = () => syncPublishThemeToggle(button, theme.isDark());
  const onClick = () => {
    theme.toggle();
    sync();
  };

  button.addEventListener("click", onClick);
  eventTarget?.addEventListener?.("obsidian-theme-change", sync);
  sync();

  return () => {
    button.removeEventListener?.("click", onClick);
    eventTarget?.removeEventListener?.("obsidian-theme-change", sync);
  };
}
