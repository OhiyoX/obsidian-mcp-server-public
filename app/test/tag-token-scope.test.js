// #479: tag / property-pill paint must resolve at the point of use, not at `:root`.
//
// The defect was a one-line alias: `:root { --tag-bg: var(--tag-background) }`
// resolved to the fallback there, so a community theme overriding
// `--tag-background` on `body` (Things / Minimal / AnuPpuccin all do) never
// reached `--tag-bg` — the non-hover rules used `--tag-background` directly and
// looked right, while the hover rules mixed the stale `--tag-bg` and lost the
// pill background ("looks like plain text").
//
// The fix removes the alias entirely, drives every state from desktop 1.14.4's
// own tag/pill tokens, and gives both hosts the same geometry tokens. These pins
// are source-level (the field-level proof is the Chromium probe in
// `scratch/obsidian-desktop-re/tools/verify-tag-tokens.mjs`).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "..");
const appCss = fs.readFileSync(path.join(appRoot, "src/app/assets/app.css"), "utf8");
const fallbackLayer = appCss.slice(appCss.indexOf("@layer web-theme-fallback"), appCss.indexOf("} /* @layer web-theme-fallback */"));

test("the :root alias that broke theme overrides is gone", () => {
  assert.equal(/var\(--tag-bg\b/.test(appCss), false, "no rule may read --tag-bg (it resolved before the theme could override)");
  assert.equal(/--tag-bg\s*:/.test(appCss), false, "the --tag-bg alias itself must not come back");
});

test("every tag state reads a desktop tag token", () => {
  assert.equal(/var\(--tag-background\)/.test(appCss), true, "the resting state reads --tag-background directly");
  const hoverRules = appCss.match(/[^{\n]*:hover \{[^}]*var\(--tag-background-hover[^}]*\}/g) ?? [];
  assert.ok(hoverRules.length >= 2, `hover must use --tag-background-hover in both hosts (found ${hoverRules.length})`);
  assert.equal(/color: var\(--tag-color-hover, var\(--tag-color\)\)/.test(appCss), true, "hover text follows --tag-color-hover");
});

test("Reader and Live Preview share one geometry token set", () => {
  const padding = appCss.match(/padding: var\(--tag-padding-y\) var\(--tag-padding-x\)/g) ?? [];
  assert.ok(padding.length >= 2, `inline tag + pill geometry must come from the tokens in both hosts (found ${padding.length})`);
  assert.equal(/border-radius: var\(--tag-radius\)/.test(appCss), true, "inline tag radius follows --tag-radius");
  assert.equal(/border: var\(--tag-border-width\) solid var\(--tag-border-color\)/.test(appCss), true, "tag border follows the desktop border tokens");
  assert.equal(/border-radius: var\(--pill-radius\)/.test(appCss), true, "property pills follow --pill-radius");
  assert.equal(/font-size: var\(--tag-size\)/.test(appCss), true, "pill/tag size follows --tag-size");
});

test("the Live pill remove button follows the pill remove tokens", () => {
  assert.equal(/color: var\(--pill-color-remove\)/.test(appCss), true);
  assert.equal(/color: var\(--pill-color-remove-hover\)/.test(appCss), true);
});

test("the fallback layer declares desktop's tag/pill token set", () => {
  const expected = [
    "--tag-background-hover: color-mix(in oklch, var(--interactive-accent) 20%, transparent)",
    "--tag-color-hover: var(--text-accent)",
    "--tag-border-color: color-mix(in oklch, var(--interactive-accent) 15%, transparent)",
    "--tag-border-width: 0px",
    "--tag-padding-x: 0.65em",
    "--tag-padding-y: 0.25em",
    "--tag-radius: 2em",
    "--tag-size: var(--font-smaller)",
    "--tag-weight: inherit",
    "--pill-background: transparent",
    "--pill-background-hover: transparent",
    "--pill-color: var(--text-muted)",
    "--pill-color-hover: var(--text-normal)",
    "--pill-padding-x: 0.65em",
    "--pill-padding-y: 0.25em",
    "--pill-radius: 2em",
    "--pill-color-remove: var(--text-faint)",
    "--pill-color-remove-hover: var(--text-accent)",
    "--pill-weight: inherit",
  ];
  for (const declaration of expected) {
    assert.ok(fallbackLayer.includes(declaration), `fallback layer must declare ${declaration}`);
  }
});
