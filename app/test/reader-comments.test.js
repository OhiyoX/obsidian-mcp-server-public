import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { installDomShim } from "./dom-shim.mjs";

register("./css-stub-loader.mjs", import.meta.url);
installDomShim();

const { obsidianComments, obsidianTags } = await import("../frontend/app/features/reader/reader.js");

test("LP-11 source no longer clears pending on comments", () => {
  const source = fs.readFileSync(new URL("../frontend/app/features/reader/reader.js", import.meta.url), "utf8");
  assert.equal(source.includes("state.pending = \"\""), false);
  assert.equal(source.includes("Intentionally keep state.pending"), true);
});

test("LP-11 comments preserve pending text before %% and render dimmed like Desktop", () => {
  const md = new MarkdownIt({ html: false });
  obsidianComments(md);
  const html = md.render("before %% secret %% after");
  assert.equal(html.includes("before"), true);
  assert.equal(html.includes("after"), true);
  // Desktop Reading keeps the comment visible but faint, delimiters included (owner decision
  // 2026-10-10: Web Reader must match Desktop).
  assert.match(html, /<span class="obsidian-comment">%% secret %%<\/span>/);
  const multi = md.render("start %%a%% mid %%b%% end");
  assert.equal(multi.includes("start"), true);
  assert.equal(multi.includes("mid"), true);
  assert.equal(multi.includes("end"), true);
  assert.equal((multi.match(/obsidian-comment/g) || []).length, 2, "both comments render, neither is dropped");
  const unclosed = md.render("keep %%not closed");
  assert.equal(unclosed.includes("keep"), true);
  assert.equal(unclosed.includes("%%not closed"), true, "an unclosed pair stays literal");
  assert.equal(md.render("code `%% x %%` ok").includes("%% x %%"), true, "code spans keep their literal text");
  // A comment must not become an injection point: its raw text is escaped.
  const hostile = md.render("a %% <img src=x onerror=alert(1)> %% b");
  assert.equal(hostile.includes("<img"), false);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(hostile, /obsidian-comment/);
});

test("purely numeric hashes remain body text while mixed tags still render", () => {
  const parser = new MarkdownIt({ html: false });
  obsidianTags(parser);
  const html = parser.render("issue #7 and #123 stay literal; #phase7 and #123/alpha are tags");

  assert.equal(html.includes('data-tag="7"'), false);
  assert.equal(html.includes('data-tag="123"'), false);
  assert.match(html, /#7/);
  assert.match(html, /#123/);
  assert.match(html, /data-tag="phase7"/);
  assert.match(html, /data-tag="123\/alpha"/);
});

