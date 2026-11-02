// Canonical callout / footnote surface for the Reader.
//
// The class names, DOM shape and token faces asserted here were extracted from
// the local Obsidian Desktop install (obsidian.asar 1.13.7):
//   callout  -> app.css 11253-11393, app.js @1362880 / @1993241 / @1994064
//   footnote -> app.css 12178-12197, app.js @1359497 / @1360864-1361470
// This file pins the renderer output; the real Chromium probe in
// scratch/web-bases/U15/probe/ owns the computed-paint and sanitizer proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { CALLOUT_TYPES, calloutColorToken, calloutIconHtml, calloutLabel } from "../frontend/app/features/document/callout-tokens.js";
import { configureCallouts } from "../frontend/app/features/reader/callout-render.js";
import { configureFootnotes } from "../frontend/app/features/reader/footnote-rules.js";
import { ICON_SPRITE_ATTR } from "../frontend/app/ui/icons.js";

// U38 (#571): the collapsible callout's fold chevron is built by the shared sprite resolver
// (`ui/icons.js` → `iconHtml`), which reads the published sprite URL off `<html data-icon-sprite>`.
// This renderer runs without a DOM, so the file installs the very attribute every served page
// carries — the URL `pages.js` publishes from `sha256(icons.svg)[0..16]`. The assertion below is
// built from that published URL (not from a bare `icons.svg#…` literal) so a reference that loses
// its content hash is red here, exactly like the served pages.
const SPRITE_HASH = createHash("sha256")
  .update(await fs.readFile(new URL("../src/app/assets/icons.svg", import.meta.url)))
  .digest("hex")
  .slice(0, 16);
const PUBLISHED_SPRITE = `/app/assets/icons.svg?v=${SPRITE_HASH}`;
globalThis.document = {
  documentElement: { getAttribute: (name) => (name === ICON_SPRITE_ATTR ? PUBLISHED_SPRITE : null) },
};

const md = new MarkdownIt({ html: false, linkify: true }).use(footnote).use(configureFootnotes).use(configureCallouts);
const render = (source) => md.render(source);

test("callout DOM is the canonical Desktop shape for all three fold states", () => {
  const plain = render("> [!info] Info title\n> body");
  assert.match(plain, /^<div class="callout" data-callout="info">/);
  assert.equal(plain.includes("is-collapsible"), false);
  assert.equal(plain.includes("callout-fold"), false);
  assert.match(plain, /<div class="callout-title"><div class="callout-icon">.*<\/div><div class="callout-title-inner">Info title<\/div><\/div>/);
  assert.match(plain, /<div class="callout-icon"><svg class="svg-icon lucide-info"/);
  assert.match(plain, /<div class="callout-content"><p>body<\/p>/);

  const expanded = render("> [!tip]+ Tip title\n> body");
  assert.match(expanded, /^<div class="callout is-collapsible" data-callout="tip" data-callout-fold="\+">/);
  assert.ok(
    expanded.includes(`<div class="callout-fold"><svg class="svg-icon" aria-hidden="true"><use href="${PUBLISHED_SPRITE}#chevron-down"></use></svg></div>`),
    `the fold chevron must carry the published sprite URL: ${expanded}`,
  );

  const collapsed = render("> [!warning]- Warn title\n> body");
  assert.match(collapsed, /^<div class="callout is-collapsible is-collapsed" data-callout="warning" data-callout-fold="-">/);
  assert.match(collapsed, /<div class="callout-fold is-collapsed">/);
});

test("callout type text is normalized the way Desktop normalizes it", () => {
  // app.js @189747: type.trim().toLowerCase().replace(/\s+/g, "-").
  assert.match(render("> [!NOTE] Title\n> body"), /data-callout="note"/);
  // app.js @1363000: no title -> type words with the first character uppercased.
  const defaulted = render("> [!check-circle]\n> body");
  assert.match(defaulted, /<div class="callout-title-inner">Check circle<\/div>/);
  assert.match(defaulted, /data-callout="check-circle"/);
  // The Web-only `callout-<type>` / `callout-collapsed` / `<aside>` shapes are gone.
  assert.equal(/callout-(note|tip|warning|info)\b/.test(render("> [!note] a\n> b")), false);
  assert.equal(defaulted.includes("<aside"), false);
});

test("every Desktop callout type keeps its colour token and lucide icon", () => {
  for (const entry of CALLOUT_TYPES) {
    for (const type of entry.types) {
      assert.equal(calloutColorToken(type), entry.color, type);
      const icon = calloutIconHtml(type);
      assert.match(icon, new RegExp(`^<svg class="svg-icon lucide-${entry.icon}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`), type);
      assert.match(icon, /<\/svg>$/, type);
    }
  }
  // Desktop's base `.callout` rule (app.css 11253-11255).
  assert.equal(calloutColorToken("note"), "--callout-default");
  assert.match(calloutIconHtml("unknown-type"), /class="svg-icon lucide-pencil"/);
  assert.equal(calloutLabel("note"), "Note");
  assert.equal(calloutLabel("check-circle"), "Check circle");
});

test("footnote DOM is the canonical Desktop shape", () => {
  const html = md.render("Text[^a] and again[^a]\n\n[^a]: Definition text");
  // Reference: sup.footnote-ref[data-footnote-id] > a.footnote-link, caption "[n]".
  assert.match(
    html,
    /<sup class="footnote-ref" data-footnote-id="fnref-1"><a class="footnote-link" href="#fn-1" data-footref="a">\[1\]<\/a><\/sup>/,
  );
  // Repeated reference keeps Desktop's `-<occurrence>` suffix on the label/id.
  assert.match(
    html,
    /<sup class="footnote-ref" data-footnote-id="fnref-1-1"><a class="footnote-link" href="#fn-1" data-footref="a">\[1-1\]<\/a><\/sup>/,
  );
  // Block: section.footnotes > hr + ol > li[data-footnote-id], Desktop's arrow.
  assert.match(html, /<section class="footnotes">\n<hr>\n<ol>\n<li data-footnote-id="fn-1">/);
  assert.match(html, /<a class="footnote-backref footnote-link" href="#fnref-1">\u21a9\uFE0E<\/a>/);
  assert.match(html, /href="#fnref-1-1">\u21a9\uFE0E<\/a>/);
  // markdown-it-footnote's own class inventions must not survive.
  for (const legacy of ["footnotes-sep", "footnotes-list", "footnote-item"]) {
    assert.equal(html.includes(legacy), false, legacy);
  }
});

test("footnote rules stay additive-safe against a second render", () => {
  // The plugin owns mutable `env.footnotes`; the overrides must not change the
  // document-context contract that LP-10 relies on (one section per render).
  const html = md.render("Hello[^1]\n\n[^1]: a footnote");
  assert.equal((html.match(/class="footnotes"/g) || []).length, 1);
  assert.equal((html.match(/<hr>/g) || []).length, 1);
});
