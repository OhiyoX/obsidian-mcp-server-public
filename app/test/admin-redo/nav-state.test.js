// Q10 (user-decided design addition): the narrow-screen navigation menu.
//
// Two regressions this file locks down, both found by an independent reviewer in Wave R:
//   R-a — the scriptless toggle dropped every other query parameter, so a no-JS user on
//         `?tab=audit` who opened the menu landed back on the default page;
//   R-c — `?nav=1` at a WIDE viewport claimed `aria-modal="true"` on an ordinary always-visible
//         sidebar, and locked page scroll there through `body.overlay-open`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { navState } from "../../src/admin/pages/shell.js";
import { renderSidebar } from "../../src/admin/layout.js";

const ADMIN = path.resolve(import.meta.dirname, "..", "..", "src", "admin");

test("the scriptless toggle keeps every other query parameter", () => {
  assert.equal(
    navState({ originalUrl: "/admin/auth?tab=audit" }).href,
    "/admin/auth?tab=audit&nav=1",
    "a no-JS user on the audit tab must open the menu on the audit tab",
  );
  assert.equal(
    navState({ originalUrl: "/admin/auth?tab=accounts&order=asc" }).href,
    "/admin/auth?tab=accounts&order=asc&nav=1",
    "every existing parameter survives, order kept, nav appended",
  );
  assert.equal(
    navState({ originalUrl: "/admin/auth/access-policy?new=1&day=3" }).href,
    "/admin/auth/access-policy?new=1&day=3&nav=1",
    "the editor keeps its draft/day state as well",
  );
  assert.equal(navState({ originalUrl: "/admin/auth" }).href, "/admin/auth?nav=1", "no parameters, no stray ?&");
});

test("open/close hrefs are each other's inverse", () => {
  const opened = navState({ originalUrl: "/admin/auth?tab=audit" });
  assert.equal(opened.open, false);
  const closed = navState({ originalUrl: opened.href });
  assert.equal(closed.open, true, "the open state is recognised from the URL");
  assert.equal(closed.closeHref, "/admin/auth?tab=audit", "closing returns to the exact page, minus nav");
  assert.deepEqual(closed.href, opened.href, "re-opening is idempotent");
});

test("a wide-viewport ?nav=1 does not claim to be a modal dialog", () => {
  const open = renderSidebar({ activeTab: "accounts", navOpen: true, navCloseHref: "/admin/auth?tab=accounts" }).side;
  assert.match(open, /class="side nav-open"/, "the overlay state is still rendered");
  assert.ok(open.includes('role="dialog"'), "it keeps the dialog role");
  assert.equal(open.includes("aria-modal"), false, "but it must not claim aria-modal: at 1440px it is a normal column");
  const plain = renderSidebar({ activeTab: "accounts" }).side;
  assert.equal(plain.includes("aria-modal"), false);
  assert.equal(/role="dialog"/.test(plain), false, "the closed sidebar is not a dialog either");
});

/**
 * Media-block aware lookup: returns the text ranges covered by every `@media (max-width:720px){…}`
 * block, matched by brace counting. A plain `indexOf` on the media query string is not enough — the
 * stylesheet mentions the query in comments and in other rules, so a substring hit can point at prose
 * (reviewer N5).
 */
function narrowBlocks(css) {
  const ranges = [];
  const needle = "@media (max-width:720px){";
  for (let at = css.indexOf(needle); at !== -1; at = css.indexOf(needle, at + 1)) {
    let depth = 0;
    let end = at + needle.length;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        if (depth === 0) { end += 1; break; }
        depth -= 1;
      }
    }
    ranges.push([at, end]);
  }
  return ranges;
}

test("the scroll lock belongs to the narrow overlay only", () => {
  const css = fs.readFileSync(path.join(ADMIN, "assets", "ssr-css.js"), "utf8");
  assert.equal(css.includes("body.overlay-open"), false, "the unconditional scroll lock is gone");
  const lockAt = css.indexOf("body.nav-overlay-open{overflow:hidden}");
  assert.ok(lockAt > 0, "the lock rule exists at all");
  const blocks = narrowBlocks(css);
  assert.ok(blocks.length > 0, "there is at least one @media (max-width:720px) block");
  assert.ok(blocks.some(([start, end]) => lockAt > start && lockAt < end), "the lock lives inside the narrow-screen block, not beside it");
  // Negative control on the helper itself: a rule placed *after* the block must not count as inside it.
  const outsideAt = css.indexOf(".mobile-only{display:none}");
  assert.equal(blocks.some(([start, end]) => outsideAt > start && outsideAt < end), false, "the helper must not treat an outside rule as inside");
});
