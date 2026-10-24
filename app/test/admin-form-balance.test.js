// Admin markup is a string pipeline: pages are template literals assembled into one HTML document.
// A missing `</form>` therefore does not fail loudly — the browser's parser silently closes the
// element and the page keeps rendering, which is exactly the "声明存在但结构不对" family we keep
// paying for. This file is the always-on structural invariant for that.
//
// Why it counts the way it does (the trap this file was born from, issue #648):
// `app/src/admin/assets/ssr-css.js` shipped a CSS **comment** containing the literal text
// `<form>` ("cannot be a nested <form> and must not be a dead button"). That text travels inside
// the page's `<style>` block, so any naive `html.match(/<form\b/g)` count saw one extra opening tag
// on every Admin page and reported the pages as unbalanced. Two consequences, both pinned below:
//   1. the comment no longer spells a tag (a CSS comment must never look like markup), so a raw
//      count on a rendered page is now meaningful;
//   2. the source invariant strips JavaScript/CSS comments before counting, so a comment that
//      mentions the element for documentation purposes cannot distort the verdict either.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ADMIN_ROOT = path.resolve(import.meta.dirname, "..", "src", "admin");
const SSR_CSS = path.join(ADMIN_ROOT, "assets", "ssr-css.js");

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(^|[^:])\/\/[^\n]*$/gm, "$1");
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function formCounts(text) {
  return {
    opens: (text.match(/<form\b/g) || []).length,
    closes: (text.match(/<\/form>/g) || []).length,
  };
}

test("every Admin module emits balanced form markup", async () => {
  const offenders = [];
  for (const file of await walk(ADMIN_ROOT)) {
    const source = stripComments(await fs.readFile(file, "utf8"));
    const { opens, closes } = formCounts(source);
    if (opens !== closes) {
      offenders.push(`${path.relative(ADMIN_ROOT, file)}: <form ${opens} vs </form> ${closes}`);
    }
  }
  assert.deepEqual(offenders, [], `unbalanced form markup (a browser parser would silently repair it):\n${offenders.join("\n")}`);
});

test("the served stylesheet never spells a form tag inside its comments", async () => {
  // Form tags are the ones this file counts, so they are the ones whose prose spelling would poison
  // the count on every Admin page (they travel inside `<style>`). Other element names in prose are
  // harmless for this invariant and are deliberately left alone.
  const source = await fs.readFile(SSR_CSS, "utf8");
  const comments = source.match(/\/\*[\s\S]*?\*\//g) || [];
  const offenders = comments.filter((comment) => /<\/?form\b/i.test(comment));
  assert.deepEqual(offenders.map((c) => c.slice(0, 80)), [],
    "a CSS comment in ssr-css.js spells a form tag; it will be counted as markup on every Admin page");
});

test("a rendered Admin page counts forms symmetrically (raw, without stripping anything)", async () => {
  // The end-to-end half: render the one page that needs no service model and count it the naive
  // way. If a comment ever spells a tag again, this goes red without any HTML knowledge.
  process.env.DATA_PATH = process.env.DATA_PATH || path.join(process.env.TEMP || "/tmp", "admin-form-balance");
  const { renderLoginPage } = await import("../src/admin/pages/login.js");
  const html = renderLoginPage({ theme: "dark" });
  const { opens, closes } = formCounts(html);
  assert.equal(opens, closes, `the login page must ship balanced form markup (opens=${opens}, closes=${closes})`);
  assert.ok(opens > 0, "the login page is expected to carry the login form");
});
