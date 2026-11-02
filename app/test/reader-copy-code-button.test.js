// Reader copy-code button (#482, second slice).
//
// Covers the Desktop reading-view post-processor behaviour on a headless DOM
// (one labelled button per `pre > code`, direct child of the `<pre>`, idempotent,
// one trailing newline stripped, visible result) and pins the stylesheet/sprite
// literals that carry the parity claim. The real-browser face (hidden until
// hover, visible on hover, clipboard content) is asserted by the lane's Chromium
// probe, not here.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { codeBlockGeometryViolations, codeBlockRules, stripCssComments } from "./helpers/code-block-css.mjs";
import {
  COPY_BUTTON_ATTR,
  COPY_BUTTON_CLASS,
  COPY_LABELS,
  attachCopyCodeButtons,
  codeBlockText,
} from "../frontend/app/features/reader/copy-code-button.js";

const dom = createDomHarness();
dom.install();

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const sprite = await fs.readFile(new URL("../src/app/assets/icons.svg", import.meta.url), "utf8");

function container({ blocks = 1, inline = false, bare = false } = {}) {
  const root = dom.createElement("div");
  root.setAttribute("class", "markdown-rendered");
  for (let index = 0; index < blocks; index += 1) {
    const pre = dom.createElement("pre");
    const code = dom.createElement("code");
    code.setAttribute("class", "language-js");
    code.textContent = `const MARK${index} = 1;\n`;
    pre.appendChild(code);
    root.appendChild(pre);
  }
  if (bare) {
    const pre = dom.createElement("pre");
    pre.textContent = "no code element here";
    root.appendChild(pre);
  }
  if (inline) {
    const paragraph = dom.createElement("p");
    const code = dom.createElement("code");
    code.textContent = "inline";
    paragraph.appendChild(code);
    root.appendChild(paragraph);
  }
  return root;
}

function buttons(root) {
  return root.querySelectorAll(`.${COPY_BUTTON_CLASS}`);
}

function timerQueue() {
  const queued = [];
  return { queued, setTimeout: (fn) => queued.push(fn) };
}

function clipboardStub() {
  const writes = [];
  return { writes, navigator: { clipboard: { writeText: async (text) => writes.push(text) } } };
}

/** The two inline glyph faces, identified by their shape count and geometry. */
const COPY_SHAPE = Object.freeze({ copy: "rect+path", check: "path" });
function copiedGlyphShapes(button) {
  const svg = button.querySelector("svg");
  if (!svg) return "none";
  const tags = (svg.childNodes ?? []).filter((child) => child.nodeType === 1).map((child) => String(child.tagName).toLowerCase());
  if (tags.length === 1 && tags[0] === "path") return COPY_SHAPE.check;
  if (tags.join("+") === "rect+path") return COPY_SHAPE.copy;
  return tags.join("+") || "empty";
}

/** The click handler is async, so let its microtasks drain before asserting. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("attaches one labelled button inside every code block", () => {
  const root = container({ blocks: 2 });
  const attached = attachCopyCodeButtons(root, { document: dom.document });

  assert.equal(attached, 2, "one button per pre > code");
  const found = buttons(root);
  assert.equal(found.length, 2);
  for (const pre of root.querySelectorAll("pre")) {
    const button = buttons(pre)[0];
    assert.ok(button, "the button lives inside the <pre> (Desktop child selector)");
    assert.equal(button.parentNode, pre);
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute(COPY_BUTTON_ATTR), "");
    assert.equal(button.getAttribute("aria-label"), COPY_LABELS.idle);
    assert.equal(button.getAttribute("title"), COPY_LABELS.idle);
    assert.equal(button.getAttribute("data-copy-state"), "idle");
    assert.equal(button.textContent, "", "the button carries the icon, never the code text");
    const glyph = button.querySelector("svg");
    assert.ok(glyph, "the button paints an icon");
    assert.equal(glyph.getAttribute("viewBox"), "0 0 24 24", "the glyph carries its own coordinate system");
    assert.equal(button.querySelector("use"), null, "the icon is inline, never a sprite reference (see below)");
  }
});

test("re-running the pass does not stack buttons (Desktop's idempotency rule)", () => {
  const root = container({ blocks: 1 });
  assert.equal(attachCopyCodeButtons(root, { document: dom.document }), 1);
  assert.equal(attachCopyCodeButtons(root, { document: dom.document }), 0);
  assert.equal(buttons(root).length, 1);
});

test("inline code and a pre without a code child get no button", () => {
  const root = container({ blocks: 0, inline: true, bare: true });
  assert.equal(attachCopyCodeButtons(root, { document: dom.document }), 0);
  assert.equal(buttons(root).length, 0);
});

test("clicking copies the code text and paints the copied state until the timer fires", async () => {
  const root = container({ blocks: 1 });
  const clipboard = clipboardStub();
  const timers = timerQueue();
  attachCopyCodeButtons(root, {
    document: dom.document,
    navigator: clipboard.navigator,
    setTimeout: timers.setTimeout,
  });

  const button = buttons(root)[0];
  button.click();
  await settle();

  assert.deepEqual(clipboard.writes, ["const MARK0 = 1;"], "exactly one trailing newline is stripped");
  assert.equal(button.getAttribute("data-copy-state"), "copied");
  assert.equal(button.classList.contains("is-copied"), true);
  assert.equal(button.getAttribute("aria-label"), COPY_LABELS.copied);
  assert.equal(copiedGlyphShapes(button), COPY_SHAPE.check, "the copied state swaps in the check glyph");
  assert.equal(timers.queued.length, 1, "the result is transient");

  timers.queued.shift()();
  assert.equal(button.getAttribute("data-copy-state"), "idle");
  assert.equal(button.classList.contains("is-copied"), false);
  assert.equal(copiedGlyphShapes(button), COPY_SHAPE.copy, "the idle state restores the copy glyph");
});

test("falls back to execCommand when the Clipboard API is missing", async () => {
  const root = container({ blocks: 1 });
  const commands = [];
  const doc = { ...dom.document, execCommand: (command) => { commands.push(command); return true; } };
  const timers = timerQueue();
  attachCopyCodeButtons(root, { document: doc, navigator: {}, setTimeout: timers.setTimeout });

  const button = buttons(root)[0];
  button.click();
  await settle();

  assert.deepEqual(commands, ["copy"], "the legacy path is tried before giving up");
  assert.equal(button.getAttribute("data-copy-state"), "copied");
});

test("a copy that cannot happen paints the failure state instead of pretending", async () => {
  const root = container({ blocks: 1 });
  const timers = timerQueue();
  attachCopyCodeButtons(root, {
    document: dom.document,
    navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    setTimeout: timers.setTimeout,
  });

  const button = buttons(root)[0];
  button.click();
  await settle();

  assert.equal(button.getAttribute("data-copy-state"), "failed");
  assert.equal(button.classList.contains("is-copy-failed"), true);
  assert.equal(button.getAttribute("aria-label"), COPY_LABELS.failed);
  assert.equal(button.getAttribute("title"), COPY_LABELS.failed);
  assert.equal(copiedGlyphShapes(button), COPY_SHAPE.copy, "a failed copy keeps the copy glyph, in the error colour");
  assert.equal(timers.queued.length, 1);
});

test("the code block is the tab stop that reveals the button (keyboard path)", () => {
  const root = container({ blocks: 1 });
  attachCopyCodeButtons(root, { document: dom.document });
  assert.equal(
    root.querySelectorAll("pre")[0].getAttribute("tabindex"),
    "0",
    "a display:none button cannot be focused, so the <pre> has to be the tab stop",
  );
  assert.equal(buttons(root).length, 1);
});

test("a second click inside the first window owns the result until its own timer", async () => {
  const root = container({ blocks: 1 });
  const clipboard = clipboardStub();
  const timers = timerQueue();
  attachCopyCodeButtons(root, {
    document: dom.document,
    navigator: clipboard.navigator,
    setTimeout: timers.setTimeout,
  });

  const button = buttons(root)[0];
  button.click();
  await settle();
  button.click();
  await settle();
  assert.equal(timers.queued.length, 2, "each click schedules its own reset");

  timers.queued[0]();
  assert.equal(
    button.getAttribute("data-copy-state"),
    "copied",
    "the earlier click's timer must not cut the second result short (review F5)",
  );
  timers.queued[1]();
  assert.equal(button.getAttribute("data-copy-state"), "idle");
});

test("codeBlockText strips one trailing newline, like Desktop's Nj()", () => {
  assert.equal(codeBlockText({ textContent: "a\n" }), "a");
  assert.equal(codeBlockText({ textContent: "a\n\n" }), "a\n");
  assert.equal(codeBlockText({ textContent: "a" }), "a");
  assert.equal(codeBlockText(null), "");
});

test("app.css keeps the Desktop reading-view values and hides the button until hover", () => {
  const start = css.indexOf("button.copy-code-button {");
  const end = css.indexOf("/* Keyboard reachability");
  assert.ok(start > 0 && end > start, "the copy-button rules must exist");
  const block = css.slice(start, end);

  assert.match(
    css,
    /^\.preview pre, \.markdown-rendered pre \{ position: relative; \}$/m,
    "the <pre> is the positioning context (Desktop app.css@11836-11837) at Desktop's own (0,1,1) weight",
  );
  assert.match(
    css,
    /:where\(\.preview, \.markdown-rendered\) pre:not\(:hover\) > button\.copy-code-button \{ display: none; \}/,
    "Desktop hides the button until the block is hovered (app.css@11854)",
  );
  for (const literal of [
    "margin: 6px;",
    "padding: 6px 8px;",
    "height: auto;",
    // Desktop's rule does not need this (Obsidian's base CSS resets the UA button
    // border) but this app has no global reset: without it the button paints the UA
    // `2px outset` box — the owner's blank white square, reproduced first-hand.
    "border: 0;",
    "background-color: transparent;",
    "box-shadow: none;",
    "color: var(--text-muted);",
    "font-size: var(--font-ui-smaller);",
    "font-family: var(--font-interface);",
    "position: absolute;",
    "top: 0;",
    "inset-inline-end: 0;",
  ]) {
    assert.ok(block.includes(literal), `the button rule must carry \`${literal}\``);
  }
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(block), false, "the button must be token-driven, never a hardcoded colour");
  assert.match(
    css,
    /@media \(hover: hover\) \{\s*:where\(\.preview, \.markdown-rendered\) button\.copy-code-button:hover \{ background-color: var\(--background-modifier-hover\); \}/,
    "Desktop's hover face uses the theme's hover modifier",
  );
  // Regression pins for the independent review's blocker (F1): the result rules have
  // to repeat the hidden rule's `pre > button.copy-code-button` shape (same
  // (0,2,2) weight) AND come after it, or `pre:not(:hover)` keeps winning and the
  // copied/failed result vanishes the moment the pointer leaves the block.
  const hiddenAt = css.indexOf("pre:not(:hover) > button.copy-code-button { display: none; }");
  const resultAt = css.indexOf("pre > button.copy-code-button.is-copied,");
  assert.ok(hiddenAt > 0 && resultAt > hiddenAt, "the result rules must come after the hidden rule");
  assert.match(
    css,
    /:where\(\.preview, \.markdown-rendered\) pre > button\.copy-code-button\.is-copied,\s*:where\(\.preview, \.markdown-rendered\) pre > button\.copy-code-button\.is-copy-failed \{ display: inline-flex; \}/,
    "the result rules must carry the same selector shape as the hidden rule",
  );
  // Regression pin for F2: the keyboard path is the focused code block, because a
  // `display:none` button cannot take focus.
  assert.match(
    css,
    /\.preview pre:focus-within > button\.copy-code-button,\s*\.markdown-rendered pre:focus-within > button\.copy-code-button \{ display: inline-flex; \}/,
    "a focused code block must reveal the button",
  );
  assert.match(
    css,
    /button\.copy-code-button\.is-copied \{ color: var\(--text-success, var\(--color-green\)\); \}/,
    "a successful copy is announced in the theme's success colour",
  );
  assert.match(
    css,
    /button\.copy-code-button\.is-copy-failed \{ color: var\(--text-error, var\(--color-red\)\); \}/,
    "a failed copy must be visible",
  );
  assert.match(css, /--font-ui-smaller: 12px;/, "the button's font size is the Desktop UI token, not a literal");
});

// Owner-visible regression of 2026-10-18: after the block was scrolled horizontally, the
// copy icon sat on top of the code text (screenshot: the icon on `node` of
// `t/snapshot && timeout 50 node scripts/check-syntax.mjs`).
//
// Root cause, reproduced first-hand in real Chromium (`evidence/probe-copy-button-scroll-anchor.mjs`,
// `evidence/report-pre-fix-efc6fbd9.json`): the button is `position: absolute` inside the
// `<pre>` (the Desktop shape this file pins), so the `<pre>` is its containing block — and the
// `<pre>` was ALSO the block's `overflow: auto` scroll container. An absolutely positioned
// child of a scroll container scrolls with that container's content, so `pre.scrollLeft = 911`
// carried the button 911px to the left: its gap to the block's right edge went 7px -> 918px and
// its viewport `left` went 1023 -> 112.
//
// Attribution (same probe, `evidence/report-baseline-65290682.json`): byte-identical readings on
// `v2026.10.18.2` (`65290682`) and on the deployed `v2026.10.18.3` (`efc6fbd9`), and
// `app/src/app/assets/app.css` is identical between the two commits => this is NOT a regression
// of that release; it has been the shape since #482's second slice (`40e883cf`), which mirrored
// Desktop. Desktop declares the same pair (`.markdown-rendered pre { position: relative;
// overflow-x: auto }` @11836-11844 and the absolutely positioned button @11857-11874), so
// Desktop's button scrolls with the content too: a fixed top-right corner is an improvement on
// Desktop, not a parity claim (Desktop runtime itself is unverified here — its DOM probe is
// still behind the plugin-trust gate; the CSS pair is read from the asar).
//
// The fix keeps the DOM and every button selector untouched and moves the block's scroll box one
// level in, to the `pre > code` the block already owns: the `<code>` fills the `<pre>`'s content
// box, so the `<pre>` has no scroll range left to carry the button, and `pre:not(:hover)` /
// `pre:focus-within` / `.is-copied` / `.is-copy-failed` / the `<pre>` tab stop keep working
// because the button is still the `<pre>`'s direct child.
//
// THIS IS THE REGRESSION NAIL. Reverting the fix means deleting `overflow: auto` from the
// `.preview pre code` rule below, and this test goes red. The behavioural half (the anchor
// measured before and after a real horizontal scroll, on both themes) is the Chromium probe;
// the pre-fix tree is its negative control (7px vs 918px).
test("the code block scrolls inside the <code>, not inside the <pre> the button is anchored to", () => {
  const rule = /\.preview pre code \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the `pre > code` rule must exist");
  const declarations = rule[1];
  assert.match(
    declarations,
    /(?:^|;)\s*overflow:\s*auto\s*;/,
    "the `pre > code` box owns the block's scroll; without it the `<pre>` (the button's containing " +
      "block) is the scroll container again and a horizontal scroll carries the button over the code",
  );
  assert.match(
    declarations,
    /(?:^|;)\s*display:\s*block\s*;/,
    "the `<code>` must stay block-level so it fills the `<pre>`'s content box (a shrink-to-fit box " +
      "would leave the `<pre>` a horizontal scroll range again)",
  );
  // Desktop's own `pre` declaration is deliberately kept: with the code box filling the content
  // box the `<pre>` has nothing left to scroll, and keeping it means a theme that reads
  // `overflow-x` off the block still sees the value it saw before this fix.
  assert.match(css, /\.preview pre \{[^}]*overflow:\s*auto/s, "the block keeps Desktop's `overflow: auto` declaration");
});

// Two nails for the owner's second-order worry behind the same 2026-10-18 report:
// "the code block got taller". Both are measured, not guessed, in real Chromium by
// `probes/probe-reading-geometry.mjs` over five trees (`v2026.10.18.2` `65290682` /
// `.3` `efc6fbd9` / `.4` `b08fad6d` / `.5` `7e793590` / `649fe534`) x seven block
// shapes (1/3/8 lines, wide and narrow, bare / in list / in callout / in quote):
// reports `evidence/report-geometry-*.json`.
//
// Measured result of the hotfix, and the reason NO height fix is owed:
//   * the button's containing block stops scrolling: scroll owner `pre` -> `code`;
//     scrollLeft(max) carried the button -487px on `.2`/`.3` (right gap 7px -> 494px)
//     and 0px on `.4`/`.5`/HEAD (right gap stays 7px);
//   * the block's OUTER height is invariant: 86.375px for the wide block and 71.375px
//     for the narrow one on every one of the five trees, i.e. a 0.000px delta; the
//     15px scrollbar did not appear, it MOVED from the `<pre>`'s border box
//     (`pre.scrollbarBlock` 15 -> 0) into the `<code>` box (`code.scrollbarBlock`
//     0 -> 15). Auto height is content + padding + exactly one scrollbar in both
//     layouts, which is why the hypothesis "`overflow: auto` on `pre > code` adds a
//     gutter" is falsified rather than fixed.
//
// So the nails below guard the two ways that measured invariant can be broken again.
test("the <code> box fills the <pre>, so the <pre> has no scroll range to carry the button", () => {
  const rule = /\.preview pre code \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the `pre > code` rule must exist");
  const declarations = rule[1];
  // `display: block` alone is not enough: an inline-size constraint shrinks the code box to
  // its content, which restores a horizontal scroll range on the `<pre>` and carries the
  // absolutely positioned button away with the content (the owner's original report).
  for (const shrink of ["width", "max-width", "min-width", "inline-size", "max-inline-size", "min-inline-size", "display:\s*inline", "float", "position:\s*absolute", "position:\s*fixed"]) {
    assert.doesNotMatch(
      declarations,
      new RegExp(`(?:^|;)\\s*${shrink}`),
      `\`${shrink}\` on \`pre > code\` would shrink-to-fit the code box and hand the horizontal ` +
        "scroll range back to the `<pre>` that anchors the button (`evidence/report-geometry-efc6fbd9.json`:" +
        " the button moves -487px with the content there)",
    );
  }
});

test("nothing in the code-block chain reserves a second scrollbar band", () => {
  const pre = /\.preview pre \{([^}]*)\}/.exec(css);
  const code = /\.preview pre code \{([^}]*)\}/.exec(css);
  assert.ok(pre && code, "both code-block rules must exist");
  for (const [name, declarations] of [["pre", pre[1]], ["pre > code", code[1]]]) {
    // `scrollbar-gutter: stable|stable both-edges` reserves a band even when the box does not
    // scroll: that is the one declaration that would make the block taller than the measured
    // 86.375px / 71.375px while "just" touching the scroll policy.
    assert.doesNotMatch(
      declarations,
      /scrollbar-gutter/,
      `\`${name}\` must not reserve a scrollbar gutter; the block's height is content + padding + ` +
        "exactly one scrollbar (probe: identical 86.375px on all five trees)",
    );
  }
  // The `<code>` box measured as exactly one scrollbar tall above the text and nothing else:
  // no block padding, no border, no min-height/height override that would add a band.
  assert.match(code[1], /(?:^|;)\s*padding:\s*0\s*;/, "`pre > code` keeps the zero padding the block's geometry is measured with");
  assert.match(code[1], /(?:^|;)\s*border:\s*0\s*;/, "`pre > code` adds no border to the block's height");
  for (const band of ["min-height", "max-height", "height"]) {
    assert.doesNotMatch(
      code[1],
      new RegExp(`(?:^|;)\\s*${band}\\s*:`),
      `\`${band}\` on \`pre > code\` would add a block-axis band the measurement does not account for`,
    );
  }
});

// The owner-visible regression of 2026-10-17: the icon was a sprite reference
// (`/app/assets/icons.svg#copy`) while that URL is unversioned (U38) and served
// `Cache-Control: public, max-age=31536000, immutable`, so a browser holding a
// sprite cached before the symbol existed painted an empty box. These pins keep
// the affordance independent of any cacheable external asset.
// The owner-visible regression of 2026-10-17: the icon was a sprite reference
// (`/app/assets/icons.svg#copy`) while that URL is unversioned (U38) and served
// `Cache-Control: public, max-age=31536000, immutable`, so a browser holding a
// sprite cached before the symbol existed painted an empty box. These pins keep the
// affordance independent of any cacheable external asset.
//
// What each layer can actually catch (the independent review built a real pre-fix
// bundle and ran this suite against it — REVIEW-HANDOFF.md §adversarial A):
//   * the **import** pins fail on the pre-fix shape (it imported `ICON_SPRITE, icon`
//     from `ui/icons.js`), and so does "no `href` in the copy path" (it called
//     `setAttribute("href", …)`);
//   * a *bundle grep* cannot: esbuild builds the sprite href from a variable, so
//     neither `icons.svg#copy` nor `#copy` appears as a literal in the built file —
//     an earlier revision of this test claimed that layer and it could not fail.
//     The runtime layer is the Chromium probe instead
//     (`evidence/probe-copy-icon-sprite.mjs` asserts the button carries no `<use>`
//     at all, and the pre-fix tree fails exactly that check).
test("the copy affordance never depends on the sprite (cache-proof glyphs)", async () => {
  const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");
  const source = await read("../frontend/app/features/reader/copy-code-button.js");
  assert.equal(source.includes("ui/icons.js"), false, "the button module must not import the sprite helper");
  assert.equal(source.includes("href"), false, "no sprite reference is built in the button path");
  assert.match(source, /from "\.\.\/document\/code-copy\.js"/, "the copy primitive comes from the shared module");
  const shared = await read("../frontend/app/features/document/code-copy.js");
  assert.match(shared, /from "\.\.\/\.\.\/ui\/copy-icon\.js"/, "the shared primitive paints the inline glyphs");
  assert.equal(shared.includes("ui/icons.js"), false, "the shared primitive must not import the sprite helper");
  assert.equal(shared.includes("href"), false, "no sprite reference is built anywhere in the copy path");
  const glyphs = await read("../frontend/app/ui/copy-icon.js");
  assert.match(glyphs, /viewBox", "0 0 24 24"/, "inline glyphs carry their own viewBox");
  assert.equal(glyphs.includes("href"), false, "the glyph module must not build a sprite reference");
  assert.equal(glyphs.includes('createElementNS(SVG_NS, "use")'), false, "no <use> element is created");
  // The built reader bundle is what a browser actually runs: it must carry the
  // inline glyph's geometry. `setAttribute("viewBox", "0 0 24 24")` is the inline
  // builder's own shape — a sprite `<symbol>` would carry it as markup instead —
  // so this assertion fails on a bundle built before the fix.
  const bundle = await read("../src/app/assets/reader.js");
  assert.match(bundle, /setAttribute\("viewBox","0 0 24 24"/, "the built bundle carries the inline glyph builder");
});

// `check` stays in the sprite for the server-rendered shell marks
// (`src/app/pages.js` renders the explorer's sort check and the save button from
// it), not for callouts — `callout-tokens.js` carries its own inline lucide table.
// `copy` was removed when the button moved to inline glyphs, because an unused
// symbol is 50 first-screen gzip bytes for nothing.
test("the sprite keeps the symbols other surfaces still use, and drops the dead one", () => {
  assert.match(sprite, /<symbol id="check" viewBox="0 0 24 24">/, "the shell's server-rendered check marks still use the sprite");
  assert.equal(sprite.includes('id="copy"'), false, "the unused copy symbol must not come back");
});

// `check` stays in the sprite for the callout face (`callout-tokens.js` maps the
// success callout to it); `copy` was removed when the button moved to inline
// glyphs, because an unused symbol is 50 first-screen gzip bytes for nothing.
test("the sprite keeps the symbols other surfaces still use, and drops the dead one", () => {
  assert.match(sprite, /<symbol id="check" viewBox="0 0 24 24">/, "callouts still use the sprite check");
  assert.equal(sprite.includes('id="copy"'), false, "the unused copy symbol must not come back");
});

// The pass is a DOM post-processor, so every surface that injects Reader HTML has
// to call it. These pins keep the wiring (source + built bundles) from silently
// losing a surface; the Reader surface's real behaviour is the Chromium probe.
test("both reader surfaces run the pass and the built bundles carry it", async () => {
  const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");
  const readerSource = await read("../frontend/app/features/reader/reader.js");
  assert.match(
    readerSource,
    /window\.attachCopyCodeButtons = /,
    "reader.js must publish the hook for the on-demand bundles",
  );
  // The lazy mermaid gate rides that same hook, so a new Reading surface cannot call the copy
  // pass without also getting the diagram pass (and neither surface needs a second call site).
  assert.match(
    readerSource,
    /void attachMermaidBlocks\(root, options\)/,
    "the lazy mermaid pass must ride the published hook",
  );
  assert.match(
    await read("../frontend/app/core/app.js"),
    /window\.attachCopyCodeButtons\?\.\(preview\);/,
    "the Reader surface must run the pass after every render",
  );
  assert.match(
    await read("../frontend/app/publish.js"),
    /window\.attachCopyCodeButtons\?\.\(wrapper\);/,
    "published pages reuse the Reader, so they run the same pass",
  );
  for (const bundle of ["../src/app/assets/app.js", "../src/app/assets/publish.js", "../src/app/assets/reader.js"]) {
    assert.match(await read(bundle), /attachCopyCodeButtons/, `${bundle} must be rebuilt with the wiring`);
  }
});

/* ===================================================================== *
 * #586 — the two nails above read ONE rule each; the three tests below read the
 * WHOLE stylesheet, so a second rule (appended at the end of the file, inside a
 * media query or inside an @layer), an `!important` variant, or a `pre` box
 * declaration that changes the block's height cannot hide behind them.
 *
 * `helpers/code-block-css.mjs` holds the scanner and, at its top, the scope of
 * the scan plus the per-invariant "why this is a necessary invariant" argument;
 * the third test below is the negative control that keeps the scanner honest.
 * ===================================================================== */

const CSS_TEXT = stripCssComments(css);

test("the stylesheet-wide scan sees every rule that targets the code-block boxes (#586)", () => {
  const rules = codeBlockRules(CSS_TEXT);
  const pre = rules.filter((rule) => rule.target.startsWith("pre"));
  const code = rules.filter((rule) => rule.target.startsWith("pre > code"));
  assert.ok(pre.length >= 4, `the scan must find the \`<pre>\` rules, not zero (found ${pre.length})`);
  assert.ok(code.length >= 1, `the scan must find the \`pre > code\` rule (found ${code.length})`);
  for (const selector of [".preview pre", ".preview pre code", ".markdown-rendered pre"]) {
    assert.ok(
      rules.some((rule) => rule.selector === selector),
      `the scan must see \`${selector}\` (a scanner that matches nothing makes every nail below vacuous)`,
    );
  }
  // The inline-code rule is NOT a code-block rule: `:not(pre) > code` must not be
  // mistaken for `pre > code`, or the scan would police inline code's padding.
  assert.equal(
    rules.some((rule) => rule.selector.includes(":not(pre)")),
    false,
    "`:not(pre) > code` is inline code, not the code block's scroll box",
  );
});

test("no rule in the stylesheet hands the horizontal scroll range back to the <pre> the button is anchored to (#586)", () => {
  assert.deepEqual(
    codeBlockGeometryViolations(CSS_TEXT),
    [],
    "every `pre` / `pre > code` rule, however it is spelled or nested, must keep the code box filling the block",
  );
});

test("the scan is not vacuous: each way of writing the regression trips it (#586 negative controls)", () => {
  // The canonical pair, reduced to the declarations the scan polices.
  const CANONICAL = [
    ".preview pre { box-sizing: border-box; padding: var(--code-block-padding-block) var(--code-block-padding-inline);",
    "  overflow: auto; border: 1px solid var(--line); font-size: var(--code-block-font-size); line-height: var(--code-block-line-height); }",
    ".preview pre code { display: block; padding: 0; overflow: auto; border: 0; line-height: inherit; font: inherit; }",
  ].join("\n");
  assert.deepEqual(codeBlockGeometryViolations(CANONICAL), [], "the canonical pair must be green");

  // Semantically equivalent rewrites must stay green: this is the "do not over-tighten"
  // half of the nail. Same values, reached through a merge, a split, a reshuffle, the
  // longhand spelling of the same padding, a comment and different whitespace.
  const REFACTORED = [
    "/* the block's box, split in two rules on purpose */",
    ".markdown-rendered pre {",
    "  padding-block: var(--code-block-padding-block);",
    "  padding-inline: var(--code-block-padding-inline);",
    "  border-width: 1px;",
    "  border-style: solid;",
    "  box-sizing: border-box;",
    "  line-height: var(--code-block-line-height);",
    "  font-size: var(--code-block-font-size);",
    "}",
    ".preview pre, .markdown-rendered pre { padding-block: var(--code-block-padding-block); padding-inline: var(--code-block-padding-inline); }",
    ".preview pre > code,",
    ".preview pre code { display: block; overflow: auto; border: 0 none; padding: 0px; line-height: inherit; }",
  ].join("\n");
  assert.deepEqual(codeBlockGeometryViolations(REFACTORED), [], "an equivalent rewrite must stay green");

  // …and each way review found the invariant can be broken must go red.
  const INJECTIONS = [
    ["a declaration inside an existing rule", CANONICAL.replace("padding: 0;", "padding: 0; min-width: max-content;")],
    ["a second rule appended at the end of the file", `${CANONICAL}\n.preview pre code { width: max-content; }`],
    ["a `pre` box declaration that changes the block height", `${CANONICAL}\npre { padding: 26px 15px; }`],
    ["a declaration inside a media query", `${CANONICAL}\n@media (min-width: 10px) { .preview pre code { inline-size: max-content; } }`],
    ["an `!important` variant", `${CANONICAL}\n.preview pre code { max-width: max-content !important; }`],
    ["a declaration inside an `@layer`", `${CANONICAL}\n@layer later { .preview pre { padding: 26px 15px; } }`],
    ["an `:is()`-spelled selector", `${CANONICAL}\n.preview :is(pre) code { float: left; }`],
    ["a `scrollbar-gutter` on the block", `${CANONICAL}\npre { scrollbar-gutter: stable; }`],
    ["a non-zero padding on the scroll box", `${CANONICAL}\n.preview pre code { padding: 6px 8px; }`],
    ["a fixed height on the block", `${CANONICAL}\npre { max-height: 300px; }`],
  ];
  for (const [name, injected] of INJECTIONS) {
    const violations = codeBlockGeometryViolations(injected);
    assert.ok(violations.length > 0, `the scan must flag ${name}`);
  }
  // An injection written for inline code must NOT be flagged: over-tightening here
  // would police a surface this nail has nothing to say about.
  assert.deepEqual(
    codeBlockGeometryViolations(`${CANONICAL}\n:not(pre) > code { padding: 2px 4px; }`),
    [],
    "inline code is outside the code-block geometry",
  );
});
