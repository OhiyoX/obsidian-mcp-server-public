// #480: callout structure — nested callouts and titles carrying inline syntax.
//
// Both defects shared one root cause: the callout transform used to run as a
// single regex over the *rendered HTML*, so a title with inline markup
// (`<strong>`, `<a>`, `<code>`) never matched, and the non-greedy
// `([\s\S]*?)</blockquote>` stopped at the inner `</blockquote>` — a nested
// callout ate its parent's closing tag and the inner block stayed a raw quote.
// The transform now runs on markdown-it's token stream, where "nested" is just
// "the inner blockquote is another callout".
//
// These cases pin exactly the shapes the issue reported: the title line keeps its
// inline children, the body after the first line becomes the first paragraph of
// `.callout-content`, nesting closes at the right depth, and a plain quote is
// left alone.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { configureCallouts } from "../frontend/app/features/reader/callout-render.js";
import { ICON_SPRITE_ATTR } from "../frontend/app/ui/icons.js";

// U38 (#571): the collapsible callout's fold chevron is the one callout glyph built through the
// shared sprite resolver (`ui/icons.js` → `iconHtml`), which reads the published sprite URL off
// `<html data-icon-sprite>`. This file renders markdown without a DOM, so it installs exactly the
// attribute a served page carries — the same content hash `pages.js` `assetUrl("icons.svg")`
// publishes. The renderer must keep working in this environment (a bare global `document` read
// would throw here), and the symbols pinned below stay independent of the URL.
const SPRITE_HASH = createHash("sha256")
  .update(await fs.readFile(new URL("../src/app/assets/icons.svg", import.meta.url)))
  .digest("hex")
  .slice(0, 16);
const PUBLISHED_SPRITE = `/app/assets/icons.svg?v=${SPRITE_HASH}`;
globalThis.document = {
  documentElement: { getAttribute: (name) => (name === ICON_SPRITE_ATTR ? PUBLISHED_SPRITE : null) },
};

const md = new MarkdownIt({ html: false, linkify: true }).use(configureCallouts);
const render = (source) => md.render(source);
const titleOf = (html) => /<div class="callout-title-inner">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;
const countDivs = (html) => [(html.match(/<div/g) ?? []).length, (html.match(/<\/div>/g) ?? []).length];

test("a title with inline syntax is a callout and keeps its inline children", () => {
  const bold = render("> [!tip] 标题带 **粗体** 与 `code`\n> 正文");
  assert.match(bold, /^<div class="callout" data-callout="tip">/);
  const title = titleOf(bold);
  assert.ok(title.includes("<strong>粗体</strong>"), `title lost its bold run: ${title}`);
  assert.ok(title.includes("<code>code</code>"), `title lost its code span: ${title}`);
  assert.equal(title.includes("[!tip]"), false, "the marker must not survive in the title");
  assert.match(bold, /<div class="callout-content"><p>正文<\/p>/);

  const highlight = render("> [!note] ==高亮== 与 #tag");
  const highlightTitle = titleOf(highlight);
  assert.ok(highlightTitle.includes("==高亮==") || highlightTitle.includes("<mark>"), `highlight markup missing: ${highlightTitle}`);
  assert.ok(highlightTitle.includes("#tag"), `tag text missing: ${highlightTitle}`);

  const link = render("> [!info] 见 [[Target|链接]]");
  assert.ok(titleOf(link).includes("[[Target|链接]]"), "wikilink text (unrendered without the reader's link rule) must stay in the title");
});

test("nested callouts both become callouts and the DOM stays balanced", () => {
  const html = render("> [!note]+ Outer\n> 外层正文\n> > [!custom-x]- Inner 内层标题\n> > 内层正文\n>\n> 回到外层");
  const [open, close] = countDivs(html);
  assert.equal(open, close, `unbalanced divs in:\n${html}`);
  assert.equal((html.match(/class="callout[ "]/g) ?? []).length >= 2, true, "both callouts must exist");
  assert.match(html, /data-callout="note"/);
  assert.match(html, /data-callout="custom-x"/);
  assert.equal(/<blockquote>/.test(html), false, "no callout may fall back to a raw quote");

  // The inner callout lives inside the outer callout's content, and the outer's
  // own content resumes after it.
  const outerContent = html.slice(html.indexOf('<div class="callout-content">'));
  const innerIndex = outerContent.indexOf('data-callout="custom-x"');
  assert.ok(innerIndex > 0, "inner callout must sit inside the outer content");
  assert.ok(outerContent.indexOf("回到外层") > innerIndex, "content after the nested callout must stay in the outer content");
  assert.match(html, /<div class="callout is-collapsible" data-callout="note" data-callout-fold="\+">/);
  assert.match(html, /<div class="callout is-collapsible is-collapsed" data-callout="custom-x" data-callout-fold="-">/);
});

test("nesting closes at its own depth, three levels deep", () => {
  const html = render("> [!note] L1\n> > [!tip] L2\n> > > [!warning] L3\n> > > 最深\n> > 回到 L2\n> 回到 L1");
  const [open, close] = countDivs(html);
  assert.equal(open, close, `unbalanced divs in:\n${html}`);
  for (const type of ["note", "tip", "warning"]) assert.match(html, new RegExp(`data-callout="${type}"`));
  const last = html.lastIndexOf("回到 L1");
  const firstWarning = html.indexOf('data-callout="warning"');
  assert.ok(firstWarning > 0 && last > firstWarning, "outermost content must close last");
});

test("a marker-only line falls back to the Desktop type label", () => {
  const html = render("> [!check-circle]\n> body");
  assert.equal(titleOf(html), "Check circle");
  assert.match(html, /data-callout="check-circle"/);
  assert.equal(html.includes("is-collapsible"), false);
});

test("an uppercase type is normalized, and other quoting is left alone", () => {
  assert.match(render("> [!NOTE] Title\n> body"), /data-callout="note"/);
  const plain = render("> 只是引用\n> 共两行");
  assert.equal(plain.includes("callout"), false);
  assert.match(plain, /^<blockquote>/);
  // A marker that is not the first thing in the quote is not a callout.
  const mid = render("> 先说话\n> [!note] not a callout");
  assert.equal(mid.includes("data-callout"), false);
  assert.equal(/class="callout/.test(mid), false);
});
