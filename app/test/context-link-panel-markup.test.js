// Shell markup contract for the two note-context link panels (U2 copy/structure, U7 head
// split). Extracted from `context-incoming.test.js` so that file stays inside the K1 line
// budget; the assertions are moved verbatim, none relaxed.
//
// U7 moved each link panel's `⋮` menu out of the section header and into that panel's own
// head row (`data-context-panel`), so the menu is asserted against the head while the U2
// title/count/empty copy stay asserted against the section header.
import assert from "node:assert/strict";
import test from "node:test";

const OUTGOING_TITLE = "当前笔记中的链接";
const INCOMING_TITLE = "链接当前笔记";

// --- real shell markup (source of truth for copy/structure) -----------------

async function shellMarkup() {
  const { appPage } = await import("../src/app/pages.js");
  return appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});
}

function headerBlock(page, name) {
  const anchor = page.indexOf(`data-context-section="${name}"`);
  assert.ok(anchor > 0, `shell must contain the ${name} section header`);
  const open = page.lastIndexOf("<header", anchor);
  const end = page.indexOf("</header>", anchor);
  return page.slice(open, end + "</header>".length);
}

// U7: the ⋮ lives in the panel's own head row, addressed by `data-context-panel`.
function panelHeadBlock(page, name) {
  const anchor = page.indexOf(`data-context-panel="${name}"`);
  assert.ok(anchor > 0, `shell must contain the ${name} panel head`);
  const open = page.lastIndexOf("<header", anchor);
  const end = page.indexOf("</header>", anchor);
  return page.slice(open, end + "</header>".length);
}

function navBlock(page, id) {
  const anchor = page.indexOf(`id="${id}"`);
  assert.ok(anchor > 0, `shell must contain #${id}`);
  const open = page.lastIndexOf("<nav", anchor);
  const end = page.indexOf("</nav>", anchor);
  return page.slice(open, end + "</nav>".length);
}

function titleOf(header) {
  return header.match(/<span class="context-title">([^<]*)<\/span>/)?.[1] ?? null;
}

function countTextOf(header) {
  return header.match(/<span class="context-section-count"[^>]*>([^<]*)<\/span>/)?.[1] ?? null;
}

function menuItemsOf(header) {
  return [...header.matchAll(/data-context-action="([a-z-]+)"[^>]*>([^<]*)</g)].map((match) => `${match[1]}=${match[2]}`);
}

// --- markup (hard copy/structure assertions) --------------------------------

test("the shell carries the desktop Backlinks panel structure for both sections", async () => {
  const page = await shellMarkup();
  const outgoingHeader = headerBlock(page, "outgoing");
  const incomingHeader = headerBlock(page, "incoming");

  // Titles and counts: exact strings, no fuzzy matching.
  assert.equal(titleOf(outgoingHeader), "当前笔记中的链接");
  assert.equal(titleOf(incomingHeader), "链接当前笔记");
  assert.equal(countTextOf(outgoingHeader), "0");
  assert.equal(countTextOf(incomingHeader), "0");
  assert.equal(outgoingHeader.includes('data-context-count="outgoing"'), true);
  assert.equal(incomingHeader.includes('data-context-count="incoming"'), true);

  // Empty-state copy: the outgoing list has its own empty state; the second section
  // (unlinked mentions) is a separate labelled landmark covered by its own test.
  assert.equal(
    navBlock(page, "outgoing-list").includes('<div class="context-empty">打开笔记后显示出链</div>'),
    true,
  );
  assert.equal(
    navBlock(page, "incoming-list").includes('<div class="context-empty">打开笔记后显示反向链接</div>'),
    true,
  );

  // List semantics: each section is its own labelled navigation landmark.
  assert.equal(navBlock(page, "outgoing-list").includes(`aria-label="${OUTGOING_TITLE}"`), true);
  assert.equal(navBlock(page, "incoming-list").includes(`aria-label="${INCOMING_TITLE}"`), true);

  // The `⋮` menu only offers actions this app really implements.
  const outgoingHead = panelHeadBlock(page, "outgoing");
  const incomingHead = panelHeadBlock(page, "incoming");
  assert.deepEqual(menuItemsOf(outgoingHead), ["collapse=折叠", "refresh=刷新"]);
  assert.deepEqual(menuItemsOf(incomingHead), ["collapse=折叠", "refresh=刷新"]);
  for (const header of [outgoingHead, incomingHead]) {
    assert.equal(header.includes("排序"), false, "no fake sort control");
    assert.equal(header.includes("在页面中显示"), false, "no fake 'show in page' control");
    assert.equal(header.includes("context-section-menu-toggle"), true);
    assert.equal(header.includes('role="menu"'), true);
    assert.equal(header.includes('aria-haspopup="menu"'), true);
  }
  // The section headers themselves carry no menu any more (U7 moved it into the head).
  for (const header of [outgoingHeader, incomingHeader]) {
    assert.equal(header.includes("context-section-menu-toggle"), false, "the ⋮ moved to the panel head");
  }
});
