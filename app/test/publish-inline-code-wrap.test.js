// #447 (Publish): an inline `code` token — a long Vault path, a 64-char SHA-256, a URL — must
// be able to break inside the public page, because the public page is not a scroll container
// (`.publish-document.preview` deliberately overrides the workspace `.preview`'s
// `overflow-x: hidden`). This file is the fast, always-on half of the regression; the
// behavioural half is the real-Chromium `public-page-mobile-overflow` check in
// scripts/web-publish-checks.mjs, which CI runs in the "Run Web Publish surface checks" step.
//
// It also pins the *scope* of the fix: the wrapping declaration belongs to the Publish
// stylesheet only. Hoisting it into the shared `app.css` changes the Reader / Live Preview
// surface, which needs its own render-parity evidence (AGENTS.md) — so that move must fail
// here instead of happening silently.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  WEB_PUBLISH_ACTIVE_BODY,
  WEB_PUBLISH_BLOCK_SAMPLES,
  WEB_PUBLISH_INLINE_SAMPLES,
} from "../scripts/web-publish-fixtures.mjs";

const publishCssUrl = new URL("../src/app/assets/publish.css", import.meta.url);
const appCssUrl = new URL("../src/app/assets/app.css", import.meta.url);

/** Rule bodies of every innermost `selector { ... }` block, comments stripped. */
function rules(source) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, " ");
  const found = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] });
  }
  return found;
}

/** The declaration block of the first rule whose selector contains `fragment`. */
function ruleBody(source, fragment) {
  const rule = rules(source).find((entry) => entry.selector.includes(fragment));
  assert.ok(rule, `publish.css/app.css must still declare a rule matching "${fragment}"`);
  return rule.body;
}

test("#447: the published fixture still carries every named sample the browser check measures", () => {
  // The real-Chromium check asserts each *named* sample exists on the served page and then
  // measures that sample. This is the fast, always-on binding between the two: deleting a
  // sample from the fixture body — the way the pre=0 counterexample removed the block — must
  // fail here, so the browser loop can never become vacuously green.
  assert.ok(
    WEB_PUBLISH_INLINE_SAMPLES.length >= 4,
    `the inline sample set must stay large enough to cover path / tarball / SHA-256 / URL, got ${WEB_PUBLISH_INLINE_SAMPLES.length}`,
  );
  assert.ok(WEB_PUBLISH_BLOCK_SAMPLES.length >= 1, "the block-level sample set must not be empty");

  for (const sample of WEB_PUBLISH_INLINE_SAMPLES) {
    // Must be a real inline-code span in the Markdown source, not prose that merely mentions it.
    assert.ok(
      WEB_PUBLISH_ACTIVE_BODY.includes(`\`${sample.text}\``),
      `the fixture body must keep the inline-code sample "${sample.id}": ${sample.text}`,
    );
  }

  const fences = WEB_PUBLISH_ACTIVE_BODY.split("```");
  assert.equal((fences.length - 1) % 2, 0, "the fixture body must keep balanced code fences");
  const fenced = fences.filter((_, index) => index % 2 === 1).join("\n");
  assert.ok(fenced.length > 0, "the fixture body must keep a fenced code block");
  for (const sample of WEB_PUBLISH_BLOCK_SAMPLES) {
    assert.ok(
      fenced.includes(sample.text),
      `the fixture fenced block must keep the block-level sample "${sample.id}": ${sample.text}`,
    );
  }
});

test("#447: the Publish stylesheet lets an inline code token break instead of widening the page", async () => {
  const css = await fs.readFile(publishCssUrl, "utf8");

  const wrapping = rules(css).filter(
    (rule) =>
      rule.selector.includes(".publish-document") &&
      rule.selector.includes(":not(pre)") &&
      rule.selector.includes("code"),
  );
  assert.ok(wrapping.length > 0, "publish.css must keep a `.publish-document … :not(pre) > code` rule");
  for (const rule of wrapping) {
    assert.match(
      rule.body,
      /overflow-wrap:\s*(?:anywhere|break-word)\s*;/,
      `the inline-code rule must declare a wrapping overflow-wrap: ${rule.selector}`,
    );
  }

  // The block-level contract must not be touched: `pre` keeps its own horizontal scroll.
  for (const rule of rules(css)) {
    const targetsBlockCode = /\bpre\b/.test(rule.selector) && !rule.selector.includes(":not(pre)");
    if (!targetsBlockCode) continue;
    assert.doesNotMatch(rule.body, /overflow-wrap/, `block-level code must stay unwrapped: ${rule.selector}`);
  }
});

test("#447: the inline-code wrapping stays Publish-scoped and leaves the shared surface alone", async () => {
  const [css, shared] = await Promise.all([
    fs.readFile(publishCssUrl, "utf8"),
    fs.readFile(appCssUrl, "utf8"),
  ]);

  // Every wrapping rule for inline code must be reachable only through the public page.
  for (const rule of rules(css)) {
    if (!/overflow-wrap/.test(rule.body) || !/code/.test(rule.selector)) continue;
    assert.ok(
      rule.selector.includes(".publish-document"),
      `an overflow-wrap rule for code must be scoped to .publish-document: ${rule.selector}`,
    );
  }

  // The shared base code surface (app.css) is deliberately untouched: Reader / Live Preview
  // parity is gated separately, and this fix must not pre-empt that decision.
  assert.doesNotMatch(
    ruleBody(shared, ":not(pre) > code"),
    /overflow-wrap/,
    "app.css's shared inline-code surface must not gain wrapping as part of the Publish fix",
  );
});
