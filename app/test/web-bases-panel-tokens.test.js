// Bases action-popover TOKEN contract (lane desktop-re/bases-panel-tokens, owner
// report 2026-10-20: 「UI 还是难看的，不协调的」).
//
// Why this file exists: inside one 320px popover the same control role was painted by
// three different skins. The real-Chromium probe of this lane measured, before the
// change, a 32px/6px enhanced `select` next to a 28px/5px text input next to a
// 28px/6px button, all three filled with `--background-primary` (i.e. the same colour
// as the popover surface, so the inputs had no face at all), plus a `resize:vertical`
// grip on the raw-expression textarea that the desktop does not have. That is the
// 「不协调」 — a token problem, not a taste problem.
//
// The invariants below are structural on the stylesheet the surface really ships
// (BASE_SURFACE_CSS is the single source base-navigation.js injects), because the Node
// gate must stay green without a browser. The geometric truth (computed heights, radii,
// backgrounds, escaping, hit-tests, dark 1440x900) is measured against a real Chromium
// by this lane's own probe, which lives in the lane root and is deliberately not
// committed to the branch (see HANDOFF.md).
//
// Targets, and where they come from:
//   * 30px border box — desktop `--input-height: 30px`, and the app's own
//     `.select-trigger` is 30px (+1px border each side on the `.select-control` = the
//     32px that used to stick out).
//   * radius 6 for controls / 4 for option rows / 8 for the panel — the app's shared
//     skin (`.select-control` 6px, `.select-option` 4px) on the desktop radius scale
//     (`--radius-s: 4px`, `--radius-m: 8px`). 5px and 7px are orphans and must not come
//     back into this surface.
//   * `--control-bg` / `--control-border` — the same face `.select-control` already
//     paints, instead of `--background-primary`.
//
// Run: cd app && node --test test/web-bases-panel-tokens.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import { BASE_SURFACE_CSS } from "../frontend/app/features/bases/styles.js";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const APP_CSS = fs.readFileSync(path.join(APP_DIR, "src", "app", "assets", "app.css"), "utf8");

// --- a tiny reader for the shipped stylesheet ---------------------------------
//
// A small brace-aware reader for the shipped stylesheet. BASE_SURFACE_CSS is the joined
// rule text (an array joined at the module boundary), and some rules open an `@media`
// block whose closing brace comes many rules later, so a reader has to track the block
// depth: that is what scopes the panel-body assertions below to the desktop popover. The
// `<=480px` block intentionally repaints `.base-panel` as a full-bleed overlay (radius 0,
// 44px rows), which is a different contract and must not be mistaken for a regression.
function parseRules(css) {
  const source = String(css);
  const rules = [];
  let mediaDepth = 0;
  let buffer = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      const prelude = buffer.trim();
      buffer = "";
      if (prelude.startsWith("@media")) {
        mediaDepth += 1;
        continue;
      }
      const end = source.indexOf("}", index);
      rules.push({
        selectors: prelude.split(",").map((part) => part.trim()),
        declarations: source.slice(index + 1, end),
        mediaDepth,
      });
      index = end;
      continue;
    }
    if (character === "}") {
      mediaDepth = Math.max(0, mediaDepth - 1);
      buffer = "";
      continue;
    }
    buffer += character;
  }
  return rules;
}

const RULES = parseRules(BASE_SURFACE_CSS);
const DESKTOP = RULES.filter((rule) => rule.mediaDepth === 0);

// Brace-matched extraction of ONE media block, so the `<=480px` overlay block (or a second
// `<=720px` block) can never be mistaken for the narrow band the nail below pins.
function mediaBlock(css, prelude) {
  const start = css.indexOf(prelude);
  assert.ok(start >= 0, `the stylesheet must still declare ${prelude}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

// The surface's own `<=720px` band (chip/popover narrow layout) and the app's first
// `<=720px` band (`app.css`, the touch-target rules the popover has to obey).
const NARROW = parseRules(mediaBlock(BASE_SURFACE_CSS, "@media (max-width:720px){"));
const APP_NARROW = parseRules(mediaBlock(APP_CSS, "@media (max-width: 720px) {"));

function valueIn(rules, selector, property) {
  let found = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule.declarations);
    if (match) found = match[1].trim();
  }
  return found;
}

// The declarations of every desktop rule that targets `selector` exactly, in source
// order, so a later rule can override an earlier one without hiding it from a reader.
function declarationsOf(selector) {
  return DESKTOP.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.declarations);
}

function valueOf(selector, property) {
  let found = null;
  for (const declarations of declarationsOf(selector)) {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(declarations);
    if (match) found = match[1].trim();
  }
  return found;
}

const PANEL_RULES = DESKTOP.filter((rule) => rule.selectors.some((selector) => selector.startsWith(".base-panel")));

// --- nail ①: one radius scale inside the panel --------------------------------

test("the panel paints one radius scale and no 5px/7px orphan", () => {
  const radii = new Map();
  for (const rule of PANEL_RULES) {
    for (const value of rule.declarations.matchAll(/border-radius:([^;]+)/g)) {
      for (const selector of rule.selectors) {
        if (!radii.has(selector)) radii.set(selector, []);
        radii.get(selector).push(value[1].trim());
      }
    }
  }
  assert.ok(radii.size > 0, "the panel stylesheet must declare at least one radius");
  // P0/P2 (lane desktop-re/bases-css-port-impl): the panel shell and the option row now paint the
  // desktop's own token instead of a repeated literal. `--radius-m` is 8px and `--radius-s` is 4px
  // in app.css, so the scale the assertion above protects (4 option / 6 control / 8 panel) is
  // unchanged — only the source of the number moved to the desktop token.
  //
  // FIX-1 F8: `0` used to be legal for EVERY selector in this sheet, which meant any later
  // `border-radius:0` anywhere in the panel was exempt from the scale check. The only zero-radius
  // surface in this panel is the P5 search field (the desktop's `.search-input-container` /
  // `input[type=search]` is a flat hairline row, `border-radius:0`, asar app.css@453150), so the
  // allowance is now pinned to those two selectors and to nothing else: a new zero elsewhere is a
  // failure again, and dropping the search row's own zero is a failure too.
  const desktopTokens = ["var(--radius-s)", "var(--menu-radius,var(--radius-m))"];
  const zeroRadius = new Set();
  for (const [selector, values] of radii) {
    for (const value of values) {
      if (value === "0") {
        zeroRadius.add(selector);
        continue;
      }
      assert.ok(
        ["4px", "6px", "8px", ...desktopTokens].includes(value),
        `${selector} paints border-radius:${value}; the panel scale is 4 (option) / 6 (control) / 8 (panel)`,
      );
    }
  }
  assert.deepEqual(
    [...zeroRadius].sort(),
    [".base-panel-search", ".base-search-input"],
    "only the P5 flat search row may paint border-radius:0",
  );
  // Same group, same radius: the controls are 6 (the shared `.select-control` skin),
  // the option rows are 4 (the shared `.select-option` skin), the panel is 8.
  const CONTROLS = [
    ".base-panel-input",
    ".base-panel-select",
    ".base-panel-button",
  ];
  const controlRadii = new Set(CONTROLS.map((selector) => valueOf(selector, "border-radius")));
  assert.deepEqual([...controlRadii], ["6px"], `every panel control must use one radius, got ${[...controlRadii].join(" / ")}`);
  // The enhanced select inherits the shared skin instead of re-declaring it: the wrapper
  // takes its 6px from `.select-control` and the trigger its radius from the wrapper
  // (`border-radius:inherit`), so neither may declare a second number — a second number
  // is exactly how the 5px/7px orphans got in. Both are pinned in the app.css contract
  // above, and the real-Chromium probe reads 6px on the computed wrapper.
  assert.equal(valueOf(".base-panel .select-control", "border-radius"), null);
  assert.equal(valueOf(".base-panel .select-trigger", "border-radius"), null);
  assert.match(APP_CSS, /\.select-trigger \{[^}]*border-radius: inherit/, "the shared .select-trigger must keep inheriting the wrapper radius");
  assert.equal(valueOf(".base-panel-option", "border-radius"), "var(--radius-s)");
  // P0: the shell paints the desktop token itself (`--radius-m` = 8px, asar app.css@282803
  // `border-radius:var(--menu-radius)`); the computed 8px is asserted in real Chromium by the
  // lane probe (`evidence/after/readings.json`, `.base-panel.borderRadius`).
  assert.equal(valueOf(".base-panel", "border-radius"), "var(--menu-radius,var(--radius-m))");
  assert.equal(valueOf(".base-panel-icon-button", "border-radius"), null, "the icon button must inherit the button radius, not declare a second one");
});

// --- nail ②: one control height ----------------------------------------------

test("every panel control is a 30px border box, input === button === select", () => {
  assert.equal(valueOf(".base-panel-input", "height"), "30px");
  assert.equal(valueOf(".base-panel-select", "height"), "30px");
  assert.equal(valueOf(".base-panel-button", "height"), "30px");
  // The enhanced select really laid out is the generated `.select-control` wrapper; the
  // native `<select>` (`ui/select.js` hides it as the 1px `.select-native`) is the
  // fallback and is styled by the rule above. 28px trigger + 1px border each side = the
  // same 30px border box as the input and the button, so a row never steps.
  assert.equal(valueOf(".base-panel .select-control", "height"), "30px");
  assert.equal(valueOf(".base-panel .select-trigger", "height"), "100%");
  // The chain only holds while the app's shared skin keeps its 1px border and its 30px
  // trigger: pin both ends of that contract here, so a change on either side is loud.
  assert.match(APP_CSS, /\.select-control \{[^}]*border: 1px solid var\(--control-border\)/, "the shared .select-control skin must keep its 1px border");
  assert.match(APP_CSS, /\.select-trigger \{[^}]*height: 30px/, "the shared .select-trigger must keep its 30px height");
  assert.match(APP_CSS, /\.select-control \{[^}]*border-radius: 6px/, "the shared .select-control skin must keep its 6px radius");
});

// --- nail ③: one background / border face -------------------------------------

test("panel controls paint the shared --control-bg, never --background-primary", () => {
  for (const selector of [".base-panel-input", ".base-panel-select", ".base-panel-button"]) {
    const background = valueOf(selector, "background");
    const border = valueOf(selector, "border");
    // The shared token must be the *painted* value; `--background-primary` may only
    // appear behind it in the fallback chain of `--control-bg` (for a theme that never
    // declares the token), never as the first choice.
    assert.match(background, /^var\(--control-bg\b/, `${selector} must paint var(--control-bg), got ${background}`);
    assert.doesNotMatch(background, /^var\(--background-primary/, `${selector} must not *set* the panel surface colour`);
    assert.match(border, /var\(--control-border\b/, `${selector} must use --control-border, got ${border}`);
  }
  assert.match(APP_CSS, /--control-bg: color-mix/, "the shared --control-bg token must still exist");
  assert.match(APP_CSS, /--control-border: color-mix/, "the shared --control-border token must still exist");
});

// --- nail ④: no resize grip on the raw-expression input ----------------------

test("the raw-expression textarea is a fixed block without a resize grip", () => {
  const rule = valueOf(".base-panel-textarea", "resize");
  assert.equal(rule, "none", "the desktop raw filter input has no resize grip and the popover already owns a max-height");
  assert.equal(valueOf(".base-panel-textarea", "min-height"), "56px");
  assert.equal(valueOf(".base-panel-textarea", "height"), "auto", "the row-height input rule must not flatten the textarea");
  assert.doesNotMatch(BASE_SURFACE_CSS, /resize:vertical/, "no element of this surface may re-introduce a vertical resize grip");
});

// --- nail ⑤: one spacing rhythm, and the footer hairline ---------------------
//
// FIX-1 F4 — the one place this nail now gives way, and why: it used to demand ONE 6px rhythm for
// rows, sections and the footer. The desktop contradicts it for the heading row:
// `.bases-toolbar-section-header{gap:var(--size-4-1)}` (asar app.css@455960, `--size-4-1` = 4px
// @86026). The heading is a desktop component, so the desktop wins that argument — a 6px heading
// that claims desktop parity is the weaker claim. `.base-panel-row` and `.base-panel-footer` have
// no desktop counterpart and keep the 6px rhythm. The heading is now pinned to the desktop TOKEN
// (`var(--size-4-1)`, whose app.css value is asserted below) instead of to a literal, so this nail
// is stronger on that selector than "6px" was: both the token and its value have to survive.
test("the heading keeps the desktop's 4px step and the rows/footer the surface's 6px rhythm", () => {
  assert.equal(valueOf(".base-panel-row", "gap"), "6px");
  // G7 (lane desktop-re/bases-menu-content): the heading box is the desktop
  // `.bases-toolbar-section-header` now, so the 4px step is pinned on
  // `.base-panel-section-header` — the wrapper above it took the desktop section's own
  // `padding:2px` (asar app.css@455722) in place of the old self-made `margin:0 0 6px`,
  // which is what put the heading at the desktop's 2+12 = 14px offset from the panel edge.
  assert.equal(valueOf(".base-panel-section-header", "gap"), "var(--size-4-1)");
  assert.match(APP_CSS, /--size-4-1: 4px/, "the panel heading reads --size-4-1, which app.css must keep at the desktop's 4px");
  assert.equal(valueOf(".base-panel-section", "padding"), "2px", "desktop .bases-toolbar-section{padding:var(--size-2-1)} (asar app.css@455722)");
  assert.equal(valueOf(".base-panel-footer", "gap"), "6px");
  assert.equal(valueOf(".base-panel-footer", "margin"), "6px 0 0");
  assert.equal(valueOf(".base-panel-footer", "padding-top"), "6px");
  assert.match(valueOf(".base-panel-footer", "border-top"), /^1px solid var\(--background-modifier-border/);
  assert.equal(valueOf(".base-panel-search", "margin"), "0 0 6px");
  assert.equal(valueOf(".base-panel-option", "padding"), "4px 4px");
  // P2 (lane desktop-re/bases-css-port-impl): the option row is the desktop
  // `.bases-toolbar-menu-item`, whose wider side is the inline start (asar app.css@466792).
  assert.equal(valueOf(".base-panel-option", "padding-inline-start"), "6px");
});

// --- FIX-1: the shell's token chain, the icon target and the property-row radius
//
// The four findings this block pins came out of the first review of the CSS port
// (`scratch/desktop-re/review/cssport-r1/REVIEW.md`): the shell declared one-off `var()` fallbacks
// whose values resolved differently from the desktop (F1/F2/F3), the close control was a 21x21 hit
// target (F6), the properties menu row kept the 4px option radius where the desktop overrides it
// (F7), and `--input-height: 28px` was copied with no consumer (F11).

test("the shell reads the desktop menu hook chain, and every token it reads is declared here", () => {
  assert.equal(valueOf(".base-panel", "border"), "var(--menu-border-width,1px) solid var(--menu-border-color,var(--color-base-35))");
  assert.equal(valueOf(".base-panel", "box-shadow"), "var(--menu-shadow,var(--shadow-s))");
  // F1/F3: the two `--menu-*` hooks the shell used to skip are now read, and their producers exist:
  // the border resolves through `--background-modifier-border-hover` (not declared here) to
  // `--color-base-35`, which app.css restates per colour mode — that is what made the old fallback
  // land on `--color-base-30` (rgb(228,228,228)) instead of the desktop's `#dadada`.
  assert.match(APP_CSS, /--menu-border-width: var\(--border-width, 1px\)/);
  assert.match(APP_CSS, /--menu-border-color: var\(--background-modifier-border-hover, var\(--color-base-35\)\)/);
  assert.match(APP_CSS, /--layer-popover: 30/);
  assert.match(APP_CSS, /:root, \.theme-light \{[^}]*--color-base-35: #dadada/);
  assert.match(APP_CSS, /\.theme-dark \{[^}]*--color-base-35: #3f3f3f/);
});

test("the menu shadow is the desktop's light/dark pair, not the dark one under a light panel", () => {
  // F2: `--shadow-s` is a mode pair on the desktop (asar app.css@99162 light / @102540 dark). The
  // shell's background here is `--background-secondary` = `--color-base-20` = #f6f6f6 in light mode,
  // so a light panel with the dark shadow was the visibly wrong default. Both halves must exist, be
  // in their own mode block, and be the desktop's own numbers (0.028/0.042/0.07 and
  // 0.121/0.179/0.3) — the version this replaced wrote `12%`/`18%`, i.e. it rounded 12.1/17.9.
  assert.match(
    APP_CSS,
    /:root, \.theme-light \{[^}]*--shadow-s: 0px 1px 2px rgba\(0, 0, 0, 0\.028\), 0px 3\.4px 6\.7px rgba\(0, 0, 0, 0\.042\), 0px 15px 30px rgba\(0, 0, 0, 0\.07\);/,
    "the light half of --shadow-s must be the desktop light value, inside the light block",
  );
  assert.match(
    APP_CSS,
    /\.theme-dark \{[^}]*--shadow-s: 0px 1px 2px rgba\(0, 0, 0, 0\.121\), 0px 3\.4px 6\.7px rgba\(0, 0, 0, 0\.179\), 0px 15px 30px rgba\(0, 0, 0, 0\.3\);/,
    "the dark half of --shadow-s must be the desktop dark value, inside the dark block",
  );
  assert.ok(!/:root, \.theme-light \{[^}]*0\.121/.test(APP_CSS), "the dark shadow may not leak into the light block");
});

test("the close control is a 24x24 target with the desktop's 16px glyph", () => {
  // F6: `--icon-s` = 16px (asar app.css@72362) + the button's own 4px padding = 24x24, the minimum
  // target the desktop uses here. The old 13px glyph left 21x21 (and no token: 13px was a Web
  // invention). The `<=480px` overlay re-sizes the same glyph at 18px and still wins there.
  assert.match(APP_CSS, /--icon-s: 16px/);
  assert.equal(valueOf(".base-panel-close .base-panel-icon", "width"), "var(--icon-s)");
  assert.equal(valueOf(".base-panel-close .base-panel-icon", "height"), "var(--icon-s)");
  assert.equal(valueOf(".base-panel-close .base-panel-icon", "flex"), "0 0 var(--icon-s)");
  assert.equal(valueOf(".base-panel-close", "padding"), "4px");
  assert.equal(valueIn(NARROW, ".base-panel-close .base-panel-icon", "width"), null, "the narrow band must not re-size the close glyph");
});

test("only the properties menu takes the desktop's 8px start radius", () => {
  // F7: the desktop overrides the property menu row's START corners
  // (`border-start-start-radius` / `border-end-start-radius: var(--bases-property-menu-item-radius)`,
  // asar app.css@455105; the token is the desktop's `var(--radius-m)` = 8px @453001). Every other
  // panel keeps the 4px `--radius-s` option row.
  const selector = '.base-panel[data-base-panel="properties"] .base-panel-option';
  assert.equal(valueOf(selector, "border-start-start-radius"), "var(--bases-property-menu-item-radius,var(--radius-m))");
  assert.equal(valueOf(selector, "border-end-start-radius"), "var(--bases-property-menu-item-radius,var(--radius-m))");
  assert.equal(valueOf(".base-panel-option", "border-radius"), "var(--radius-s)", "every other panel keeps the 4px option row");
  const scopedRadiusRules = PANEL_RULES.filter(
    (rule) => rule.selectors.some((part) => part.includes("data-base-panel")) && /radius/.test(rule.declarations),
  );
  assert.deepEqual(scopedRadiusRules.map((rule) => rule.selectors.join(",")), [selector], "no other panel id may re-open the radius scale");
});

test("the shell carries no declaration without a consumer", () => {
  // F11: the desktop's `.bases-toolbar-menu{--input-height:28px}` was copied here while nothing in
  // the panel reads it (the controls are the Web app's 30px `.select-control` skin, nail ②). It is
  // deleted, and this assertion is the reason it may not come back as "alignment evidence".
  assert.equal(valueOf(".base-panel", "--input-height"), null);
  assert.ok(!BASE_SURFACE_CSS.includes("--input-height"), "the surface must not declare a dead --input-height");
});

test("every control the panel bodies build is a node the stylesheet actually styles", () => {
  const harness = createDomHarness();
  harness.install();
  const { document } = harness;
  const api = createBasePanels({
    doc: document, close() {}, onFilter() {}, onToggleColumn() {}, onHideAllColumns() {}, onSort() {}, onQuery() {},
  });
  const columns = [
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "updated", label: "更新" },
  ];
  const state = {
    sort: [{ key: "status", dir: "asc" }],
    filter: [{ key: "status", op: "is", value: "active" }],
    q: "alfa",
    columns,
    rows: [],
    path: "Lane.base",
  };
  const context = { doc: document, columns, visibleColumns: [columns[0], columns[1]], config: { hidden: ["updated"], widths: {} } };
  const build = (id) => api.build(id, state, context);

  // properties: the search input is a `.base-panel-input`, the rows are options.
  const properties = build("properties");
  assert.equal(properties.querySelector(".base-panel-input")?.className.includes("base-panel-search"), true);
  assert.ok(properties.querySelector(".base-panel-option"), "the option rows must carry .base-panel-option");
  // filter (simple): a value input + a remove icon button inside a row.
  const filter = build("filter");
  assert.ok(filter.querySelector("input.base-panel-input"), "the value input must be a .base-panel-input");
  assert.ok(filter.querySelector("button.base-panel-button.base-panel-icon-button"), "the remove control must be .base-panel-button.base-panel-icon-button");
  // filter (advanced): the textarea carries .base-panel-textarea inside the section content.
  const advanced = api.build("filter", { ...state, filter: { and: ['status == "active"'] } }, context);
  const area = advanced.querySelector("[data-filter-advanced-mode]");
  assert.equal(area?.className.includes("base-panel-textarea"), true);
  // G7 (lane desktop-re/bases-menu-content): the body now sits in the desktop
  // `.bases-toolbar-section-content` (asar app.js@2479077), so the section content — not the
  // shell — is the input's row container. It is still NOT a condition row.
  assert.equal(area.closest("[data-section-content]"), area.parentNode, "the expression input must stay on its own row inside the section");
  assert.equal(area.closest(".base-panel-row"), null);
  // sort: two selects + an icon button in a row, plus the footer buttons.
  const sort = build("sort");
  assert.ok(sort.querySelector("select.base-panel-select"), "the selects must keep the .base-panel-select fallback class");
  assert.ok(sort.querySelector("button.base-panel-button.base-panel-icon-button"));
  assert.ok(sort.querySelector(".base-panel-footer button.base-panel-button"), "the footer buttons must be .base-panel-button");
  // search: the query input is a `.base-panel-input` in the search panel.
  const search = build("search");
  assert.ok(search.querySelector("input.base-panel-input.base-search-input"));
  assert.ok(search.querySelector(".base-panel-row"), "the search row keeps the row gap contract");
});

// --- nail ⑧: the narrow band keeps ONE control height too ---------------------
//
// The regression this nails (review of `641ba056`): at `<=720px` the shared app sheet hands
// `.select-trigger` a 44px touch `min-height`, `min-height` beats `height`, and the popover
// painted a 44px trigger inside a 30px `.select-control` (+14px) next to 30px inputs and
// buttons — the same 「不协调」 the owner reported, in the other direction.
//
// The judgement recorded here: the narrow band moves every control role UP to the app's 44px
// touch scale instead of dragging the select down to 30px. Reasons (all from this repo):
//   * `app.css @media (max-width: 720px)` already sizes `.select-trigger` and `.select-option`
//     at 44px — the shared component's touch contract for exactly these two nodes;
//   * this file's own `<=480px` overlay already paints `.base-action`, `.base-panel-header`
//     and `.base-panel-close` at 44px, so 44px is the surface's narrow scale, not a new number;
//   * the shipped parent commit rendered the narrow select at 44px (46px outer) — the bug was
//     that the neighbours were 28px, so 44px is the number the select already had.
// The desktop band is untouched (30px, nail ②), so the 1440x900 contract cannot move.
test("the <=720px band keeps one control height at the app's 44px touch scale", () => {
  // (a) the app-side contract this band obeys, pinned at both ends like nail ② does.
  assert.equal(valueIn(APP_NARROW, ".select-trigger", "min-height"), "44px", "app.css must keep the narrow .select-trigger touch target");
  assert.equal(valueIn(APP_NARROW, ".select-option", "min-height"), "44px", "app.css must keep the narrow .select-option touch target");

  // (b) one height for every control role inside the popover, equal to that touch target. The
  //     narrow band overrides the DESKTOP `height:30px` with `min-height`, which wins over
  //     `height` on a border box, so one declaration list carries all five roles.
  const narrowHeights = new Map();
  for (const selector of [".base-panel .select-control", ".base-panel-input", ".base-panel-select", ".base-panel-button"]) {
    narrowHeights.set(selector, valueIn(NARROW, selector, "min-height"));
  }
  assert.deepEqual([...new Set(narrowHeights.values())], ["44px"], `every narrow control role must share one height, got ${JSON.stringify([...narrowHeights])}`);
  assert.equal(valueIn(NARROW, ".base-panel-option", "min-height"), "44px", "option rows must step with the controls in the same popover");
  // The multi-line control keeps its own budget: the shared 44px would otherwise flatten the
  // raw-expression block to a one-line input (same specificity, narrow rule later in the sheet).
  assert.equal(valueIn(NARROW, ".base-panel-textarea", "min-height"), "56px", "the narrow band must keep the 56px expression block");

  // (c) the trigger is the inner face: it may never outgrow the wrapper it sits in. The
  //     wrapper keeps its 1px border, so the trigger's own box must stay 2px smaller, which
  //     is only true while the shared 44px `min-height` is reset inside the popover.
  assert.equal(valueOf(".base-panel .select-trigger", "min-height"), "0", "the popover trigger must reset the shared narrow min-height (min-height beats height)");
  assert.equal(valueOf(".base-panel .select-trigger", "height"), "100%");
  assert.equal(valueIn(NARROW, ".base-panel .select-trigger", "height"), null, "the narrow band must not re-declare the trigger height");
  assert.match(valueOf(".base-panel .select-control", "height"), /^30px$/, "the desktop wrapper stays 30px");
  for (const selector of [".base-panel .select-control", ".base-panel-input", ".base-panel-button"]) {
    assert.equal(valueIn(NARROW, selector, "border-radius"), null, `${selector} may not re-open the radius scale in the narrow band`);
  }
});

// --- the mobile overlay scale is a different contract, not a regression -------

test("the <=480px overlay keeps its own scale (this lane only touched the desktop popover)", () => {
  const mobile = RULES.filter((rule) => rule.mediaDepth > 0);
  assert.ok(mobile.length > 0, "the mobile block must still exist");
  const overlayRules = mobile.filter((rule) => rule.selectors.includes(".base-panel"));
  assert.ok(overlayRules.length > 0, "the mobile block must still repaint .base-panel as an overlay");
  const overlay = overlayRules.map((rule) => rule.declarations).join("\n");
  assert.match(overlay, /border-radius:0/, "the full-bleed mobile overlay must stay full-bleed");
  assert.match(overlay, /position:fixed/);
  // P0 of the CSS-port lane replaced the hand-drawn desktop box with the desktop `.menu` one:
  // the panel is `position:fixed` at every width now, and the `<=720px` band is the rule that
  // carries the old anchored shape back (`top:calc(100% + 6px)`, asserted below on that band).
  assert.match(valueOf(".base-panel", "position"), /^fixed$/);
  const narrow = RULES.filter((rule) => rule.mediaDepth > 0).filter((rule) => rule.selectors.includes(".base-panel"));
  assert.ok(
    narrow.some((rule) => /top:calc\(100% \+ 6px\)/.test(rule.declarations)),
    "the <=720px band must keep the anchored `top:calc(100% + 6px)` shape the positioner hands back to",
  );
});
