import fs from "node:fs/promises";
import path from "node:path";
import { VAULT } from "../config.js";
import { assertCanonicalInsideRoot, exists } from "../vault.js";

const MAX_THEME_CSS_BYTES = 2 * 1024 * 1024;
const MAX_THEME_ASSET_BYTES = 12 * 1024 * 1024;
const THEME_ID = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,99}$/u;

function safeThemeId(value) {
  const id = String(value || "").trim();
  if (!THEME_ID.test(id) || id === "." || id === "..") throw new Error("Invalid theme name");
  return id;
}

function safeRelativeAsset(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/").replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) throw new Error("Invalid theme asset path");
  return normalized;
}

async function readJson(file, fallback = {}) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return fallback;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function detectModes(css) {
  const modes = [];
  if (/\.theme-light\b/.test(css)) modes.push("light");
  if (/\.theme-dark\b/.test(css)) modes.push("dark");
  return modes.length ? modes : ["light", "dark"];
}

async function themeRecord(entry, themesRoot) {
  if (!entry.isDirectory()) return null;
  const root = path.join(themesRoot, entry.name);
  const cssPath = path.join(root, "theme.css");
  if (!(await exists(cssPath))) return null;
  const manifest = await readJson(path.join(root, "manifest.json"));
  const stat = await fs.stat(cssPath);
  if (!stat.isFile() || stat.size > MAX_THEME_CSS_BYTES) return null;
  const css = await fs.readFile(cssPath, "utf8");
  return {
    id: entry.name,
    name: String(manifest.name || entry.name),
    version: manifest.version ? String(manifest.version) : null,
    minAppVersion: manifest.minAppVersion ? String(manifest.minAppVersion) : null,
    author: manifest.author ? String(manifest.author) : null,
    modes: detectModes(css),
    root,
    cssPath,
    modified: stat.mtime.toISOString(),
  };
}

export async function listWebThemes(vaultRoot = VAULT) {
  const themesRoot = path.join(vaultRoot, ".obsidian", "themes");
  let entries;
  try { entries = await fs.readdir(themesRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  await assertCanonicalInsideRoot(vaultRoot, themesRoot);
  return (await Promise.all(entries.map((entry) => themeRecord(entry, themesRoot))))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readWebAppearance(vaultRoot = VAULT) {
  const appearance = await readJson(path.join(vaultRoot, ".obsidian", "appearance.json"));
  const themes = await listWebThemes(vaultRoot);
  const requestedTheme = typeof appearance.cssTheme === "string" ? appearance.cssTheme.trim() : "";
  const theme = themes.find((item) => item.id === requestedTheme)
    || themes.find((item) => item.id.toLocaleLowerCase() === requestedTheme.toLocaleLowerCase())
    || null;
  const mode = appearance.theme === "obsidian" ? "dark" : appearance.theme === "moonstone" ? "light" : "system";
  const requestedSize = Number(appearance.baseFontSize);
  return {
    themeId: theme?.id || null,
    colorMode: mode,
    baseFontSize: Number.isFinite(requestedSize) ? Math.min(24, Math.max(12, requestedSize)) : 16,
  };
}

export async function resolveWebTheme(themeId, vaultRoot = VAULT) {
  const id = safeThemeId(themeId);
  const themes = await listWebThemes(vaultRoot);
  const theme = themes.find((item) => item.id === id) || themes.find((item) => item.id.toLocaleLowerCase() === id.toLocaleLowerCase());
  if (!theme) throw Object.assign(new Error("Theme not found"), { code: "ENOENT" });
  return theme;
}

function rewriteThemeUrls(css, theme, assetBase = "/api/web/v1/theme-asset") {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, _quote, raw) => {
    const value = raw.trim();
    if (!value || /^(?:data:|https?:|blob:|#|\/)/i.test(value)) return all;
    const asset = value.split(/[?#]/, 1)[0];
    if (!asset || asset.startsWith("..")) return all;
    const url = `${assetBase}?name=${encodeURIComponent(theme.id)}&path=${encodeURIComponent(asset)}`;
    return `url("${url}")`;
  });
}

export async function readWebThemeCss(themeId, vaultRoot = VAULT, options = {}) {
  const theme = await resolveWebTheme(themeId, vaultRoot);
  await assertCanonicalInsideRoot(theme.root, theme.cssPath);
  const css = await fs.readFile(theme.cssPath, "utf8");
  const assetBase = options.assetBase || "/api/web/v1/theme-asset";
  return { theme, css: rewriteThemeUrls(css, theme, assetBase) };
}

export async function resolveWebThemeAsset(themeId, assetPath, vaultRoot = VAULT) {
  const theme = await resolveWebTheme(themeId, vaultRoot);
  const relative = safeRelativeAsset(assetPath);
  const absolute = path.resolve(theme.root, ...relative.split("/"));
  await assertCanonicalInsideRoot(theme.root, absolute);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > MAX_THEME_ASSET_BYTES) throw new Error("Theme asset is not available");
  return { theme, absolute, stat };
}

export function publicThemeRecord(theme) {
  return {
    id: theme.id,
    name: theme.name,
    version: theme.version,
    minAppVersion: theme.minAppVersion,
    author: theme.author,
    modes: theme.modes,
    modified: theme.modified,
  };
}
