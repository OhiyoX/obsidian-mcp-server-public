import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const defaultLight = [...css.matchAll(/:root, \.theme-light \{([\s\S]*?)\n\}/g)]
  .map((match) => match[1])
  .find((block) => block.includes("--color-base-00"));

function hexToken(block, name) {
  const match = block?.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("default light sidebar remains readable through Obsidian semantic tokens", () => {
  assert.ok(defaultLight);
  const background = hexToken(defaultLight, "color-base-20");
  assert.ok(contrast(hexToken(defaultLight, "color-base-70"), background) >= 4.5);
  assert.ok(contrast(hexToken(defaultLight, "color-base-100"), background) >= 7);

  assert.match(css, /--app-chrome-bg:\s*var\(--background-secondary\)/);
  assert.match(css, /--app-sidebar-text:\s*var\(--nav-item-color\)/);
  assert.match(css, /--app-sidebar-muted:\s*var\(--text-muted\)/);
  assert.match(css, /--app-sidebar-faint:\s*var\(--text-faint\)/);
  assert.match(css, /\.tree-folder, \.note \{[\s\S]*?color: var\(--app-sidebar-text/);
  assert.match(css, /\.tree-folder:hover, \.note:hover \{ background: var\(--app-sidebar-hover/);
  assert.match(css, /\.note\[aria-current="page"\] \{ background: var\(--app-sidebar-active-bg/);
});
