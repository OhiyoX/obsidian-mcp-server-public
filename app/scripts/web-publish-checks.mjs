// Web Publish surface browser checks (Wave C / C3 — issues #277/#278, dev doc §9/§17).
//
// Four checks, each against the caller's *real* server + real Chromium:
//
//   1. Admin Publish tab  — every lifecycle (active / orphaned / invalid) is visible
//      with its status, and a retired row never renders a working public link.
//   2. Web `published:`   — the explorer's Publishes filter shows exactly the active
//      registry: the recreated-orphan path and the frontmatter decoy stay private.
//   3. Public surface     — the retired opaque ids are 404 while the active id serves.
//   4. Phone viewport     — #447: a long inline `code` token never widens the served
//      public page, while the block-level `pre` sample keeps its own horizontal
//      scroll. Both sample sets are asserted to exist *and to render a real box*
//      before they are measured, and the block contract asserts the user scroll
//      mechanism (`overflow-x: auto|scroll` plus a real scroll range), not just the
//      overflow size.
//
// `ctx` contract (same shape as `web-bases-checks.mjs`):
//
//   {
//     check(name, fn)          // register one check, from the runner
//     page                     // Playwright Page, already logged in as the Web user
//     serverUrl                // http://127.0.0.1:PORT
//     login()                  // idempotent Web login
//     adminLogin()             // idempotent /admin/auth session on the same cookie jar
//     search(path, query)      // authenticated GET of a JSON surface, parsed
//     fixtures                 // createWebPublishFixtureVault() result
//     state                    // { activeId, orphanId, activePath, orphanPath, ... }
//     sleep(ms)                // optional
//   }
import assert from "node:assert/strict";

import { WEB_PUBLISH_BLOCK_SAMPLES, WEB_PUBLISH_INLINE_SAMPLES } from "./web-publish-fixtures.mjs";

export const WEB_PUBLISH_SIDEBAR_TAB = (name) => `[data-sidebar-tab="${name}"]`;
export const PUBLISHES_BUTTON = "#publishes-open";
export const SEARCH_LIST = "#search-list";

/** `overflow-x` values that keep clipped block-level content reachable for the user. */
export const WEB_PUBLISH_SCROLL_OVERFLOW_X = Object.freeze(["auto", "scroll"]);

/**
 * Why a measured inline-code node cannot prove the #447 wrap contract — `[]` when it can.
 *
 * `node` is the shape `public-page-mobile-overflow` captures from the served page:
 * `{ display, visibility, clientRects, width, height, right, parentRight }`. A sample that is
 * still in the DOM but no longer *rendered* (`display: none`, `visibility: hidden`, or a zero
 * layout box) must fail: a vanished visual sample is not evidence that the token wrapped.
 */
export function inlineCodeBoxProblems(node) {
  if (!node) return ["the sample was not captured from the served page"];
  const problems = [];
  if (node.display === "none") problems.push("display:none");
  if (node.visibility === "hidden" || node.visibility === "collapse") problems.push(`visibility:${node.visibility}`);
  if (!(node.clientRects >= 1)) problems.push(`no client rect (getClientRects().length=${node.clientRects})`);
  if (!(node.width > 0 && node.height > 0)) problems.push(`zero layout box (width=${node.width} height=${node.height})`);
  if (!(node.right <= node.parentRight + 1)) problems.push(`paints past its parent box (right=${node.right} parentRight=${node.parentRight})`);
  return problems;
}

/**
 * Why a measured block-level `<pre>` cannot prove the #447 internal-scroll contract — `[]`
 * when it can.
 *
 * The decisive criterion is the *user scroll mechanism*: an oversize line whose box reports
 * `scrollWidth > clientWidth` but whose computed `overflow-x` is `hidden`/`clip`/`visible` is
 * unreachable. Programme-scrolling the box (`scrollLeft`) is deliberately not the proof —
 * `scrollLeft` is settable on an `overflow: hidden` box too — so it is only reported as
 * evidence, never accepted instead of the computed `overflow-x`.
 */
export function blockScrollProblems(block, viewportWidth) {
  if (!block) return ["the sample was not captured from the served page"];
  const problems = [];
  if (block.display === "none") problems.push("display:none");
  if (block.visibility === "hidden" || block.visibility === "collapse") problems.push(`visibility:${block.visibility}`);
  if (!(block.width > 0 && block.height > 0)) problems.push(`zero layout box (width=${block.width} height=${block.height})`);
  if (!WEB_PUBLISH_SCROLL_OVERFLOW_X.includes(block.overflowX)) {
    problems.push(`overflow-x:${block.overflowX} is not a user scroll mechanism (the oversize line must stay reachable; need ${WEB_PUBLISH_SCROLL_OVERFLOW_X.join("|")})`);
  }
  if (block.whiteSpace !== "pre") problems.push(`white-space:${block.whiteSpace} on the <pre> (the block must not wrap)`);
  if (block.codeWhiteSpace !== "pre") problems.push(`white-space:${block.codeWhiteSpace} on the <pre> code child (the block must not wrap)`);
  if (!(block.scrollWidth > block.clientWidth + 1)) problems.push(`no horizontal scroll range (scrollWidth=${block.scrollWidth} clientWidth=${block.clientWidth})`);
  if (!(block.scrollLeftAfterProgrammaticScroll >= 1)) problems.push(`the box is not a scroll container (scrollLeft stayed ${block.scrollLeftAfterProgrammaticScroll})`);
  if (!(block.right <= viewportWidth + 1)) problems.push(`paints past the page right edge (right=${block.right} viewport=${viewportWidth})`);
  return problems;
}

/** The 4 checks this module registers, in order. */
export const WEB_PUBLISH_SCENARIOS = Object.freeze([
  { id: "admin-publish-panel-lifecycle", name: "Admin Publish tab renders every lifecycle without a dead public link" },
  { id: "web-publishes-filter", name: "the Web Publishes filter matches the active Publish registry" },
  { id: "public-surface-orphan", name: "a retired Publish record is never a public candidate" },
  { id: "public-page-mobile-overflow", name: "the public page never scrolls sideways on a phone viewport (#447)" },
]);

export async function registerWebPublishChecks(ctx) {
  const { check, page, serverUrl, login, adminLogin, search, fixtures, state } = ctx;

  // The public link column may or may not carry PUBLIC_BASE_URL, so match the path.
  const publicLink = (id) => `a[href$="/publish/${id}"]`;

  await check(WEB_PUBLISH_SCENARIOS[0].name, async () => {
    await adminLogin();
    await page.goto(`${serverUrl}/admin/auth?tab=publishes`);
    await page.waitForSelector("table.data-table");
    const text = await page.locator("main").innerText();

    // §9/§17: retired rows must stay visible and cleanable.
    for (const relative of [state.activePath, state.orphanPath, state.invalidPath]) {
      assert.ok(text.includes(relative), `Admin Publish tab must list ${relative}`);
    }
    for (const label of ["已公开", "目标缺失", "不符合公开契约"]) {
      assert.ok(text.includes(label), `Admin Publish tab must label ${label}`);
    }

    // §9: a public link that 404s must never be rendered as a working link.
    assert.equal(await page.locator(publicLink(state.activeId)).count(), 1, "the active record links to its public page");
    assert.equal(await page.locator(publicLink(state.orphanId)).count(), 0, "an orphaned record renders no live public link");
    assert.equal(await page.locator(publicLink(fixtures.invalidId)).count(), 0, "an invalid record renders no live public link");
    // ...but both ids stay on the page so they can be revoked.
    assert.ok(text.includes(state.orphanId), "the orphaned opaque id is still shown");
    assert.ok(text.includes(fixtures.invalidId), "the invalid opaque id is still shown");
    assert.ok(text.includes("已失效"), "retired rows are marked as non-servable");
  });

  await check(WEB_PUBLISH_SCENARIOS[1].name, async () => {
    await login();
    await page.goto(`${serverUrl}/app`);
    // `#publishes-open` lives in the Files panel head, so it is only clickable while
    // the Files tab is selected (the default). Loading a query makes the app switch the
    // sidebar to the Search panel, where the rows land in `#search-list`.
    assert.equal(await page.locator(WEB_PUBLISH_SIDEBAR_TAB("files")).getAttribute("aria-selected"), "true");
    const filtered = page.waitForResponse((response) => {
      if (!response.url().includes("/api/web/v2/search?")) return false;
      return new URL(response.url()).searchParams.get("q") === "published:true";
    });
    await page.locator(PUBLISHES_BUTTON).click();
    assert.equal((await filtered).status(), 200, "the Publishes filter must answer 200");
    await page.waitForSelector(`${SEARCH_LIST} .note[title="${state.activePath}"]`);

    const titles = await page.locator(`${SEARCH_LIST} .note`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
    assert.deepEqual(titles, [state.activePath], `published:true must be exactly the active registry, got ${JSON.stringify(titles)}`);
    assert.equal(await page.locator(`${SEARCH_LIST} .note[title="${state.orphanPath}"]`).count(), 0, "the recreated orphan path is not a public candidate");
    assert.equal(await page.locator(`${SEARCH_LIST} .note[title="${state.decoyPath}"]`).count(), 0, "a frontmatter published:true note is not a public candidate (#270)");
    assert.equal(await page.locator(`${SEARCH_LIST} .note[title="${state.plainPath}"]`).count(), 0, "an unregistered note is not a public candidate");

    // The complement (v1 surface reads the Vault directly, so this is deterministic
    // even if the catalog has not yet picked up the recreated file).
    const privateNotes = await search("/api/web/v1/notes", "published:false");
    const privatePaths = privateNotes.notes.map((item) => item.path);
    for (const relative of [state.orphanPath, state.plainPath, state.decoyPath]) {
      assert.equal(privatePaths.includes(relative), true, `${relative} must be private`);
    }
    assert.equal(privatePaths.includes(state.activePath), false, "an active record is not private");
  });

  await check(WEB_PUBLISH_SCENARIOS[2].name, async () => {
    // Anonymous-style public reads: the retired ids stay dead, the active id serves.
    const active = await page.request.get(`${serverUrl}${state.activePublicPath}`);
    assert.equal(active.status(), 200, "the active public page still serves");
    for (const [label, id] of [["orphaned", state.orphanId], ["invalid", fixtures.invalidId]]) {
      const response = await page.request.get(`${serverUrl}/publish/${id}`);
      assert.equal(response.status(), 404, `the ${label} public page must be 404`);
    }
    // The active URL is the one the Admin panel advertises for the active record.
    assert.equal(state.activePublicPath, `/publish/${state.activeId}`);
  });

  await check(WEB_PUBLISH_SCENARIOS[3].name, async () => {
    // #447: the public page is not a scroll container (`.publish-document.preview` is
    // `overflow: visible`), so a long inline `code` token used to widen the whole document
    // on a phone. Measure the served page — never the stylesheet text — at two phone widths,
    // and keep the block-level `pre` contract (internal scroll, no wrapping) measurable at
    // the same time. The desktop reading is the target-② control: the wide layout must obey
    // exactly the same contract (same helpers), not a weaker one.
    //
    // Non-vacuity rule for this check: every measurement loop is preceded by an existence
    // assertion on the *named* sample it is about to measure. A vanished sample (inline token
    // or the block-level `pre` fixture) must fail here, never skip an empty loop and pass.
    // FIX3 closes the two shapes that survived in the DOM: a sample that no longer renders a
    // box (`display:none` / `visibility:hidden` / zero box) is not evidence of a successful
    // wrap, and a block whose computed `overflow-x` is no longer a user scroll mechanism is
    // not evidence that the oversize line stays reachable.
    const measure = async (viewport) => {
      await page.setViewportSize(viewport);
      await page.goto(`${serverUrl}${state.activePublicPath}`, { waitUntil: "load" });
      // The first `code` node only proves that *a* code node is present; every *named* sample
      // is asserted individually below, at all three viewports.
      await page.waitForSelector(".publish-document code");
      return page.evaluate(() => {
        const scroll = document.scrollingElement;
        const root = document.querySelector(".publish-document");
        const inline = [...root.querySelectorAll("code")].filter((node) => !node.closest("pre"));
        return {
          scrollWidth: scroll.scrollWidth,
          clientWidth: scroll.clientWidth,
          viewportWidth: document.documentElement.clientWidth,
          inline: inline.map((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              text: node.textContent || "",
              display: style.display,
              visibility: style.visibility,
              clientRects: node.getClientRects().length,
              width: box.width,
              height: box.height,
              right: box.right,
              parentRight: node.parentElement.getBoundingClientRect().right,
            };
          }),
          overflowing: [...root.querySelectorAll("*")]
            .filter((node) => {
              const box = node.getBoundingClientRect();
              return box.width > 0 && box.right > document.documentElement.clientWidth + 1;
            })
            .map((node) => node.tagName.toLowerCase()),
          pre: [...root.querySelectorAll("pre")].map((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            // Programme-scrolling the box is recorded as evidence only: `scrollLeft` is
            // settable on an `overflow: hidden` box too, so it can never rule the lost user
            // scroll mechanism out. The computed `overflow-x` plus a real scroll range does.
            const restore = node.scrollLeft;
            node.scrollLeft = restore + 24;
            const scrollLeftAfterProgrammaticScroll = node.scrollLeft;
            node.scrollLeft = restore;
            return {
              text: node.textContent || "",
              display: style.display,
              visibility: style.visibility,
              overflowX: style.overflowX,
              whiteSpace: style.whiteSpace,
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
              width: box.width,
              height: box.height,
              right: box.right,
              scrollLeftAfterProgrammaticScroll,
              codeWhiteSpace: node.firstElementChild ? getComputedStyle(node.firstElementChild).whiteSpace : null,
            };
          }),
        };
      });
    };

    /**
     * Every captured node carrying a *named* inline sample must render a real, wrapping box —
     * or fail loudly. Matching the text is not enough: the FIX3 counterexample kept the text
     * and set `display: none`, and a hidden node can never prove the token wrapped.
     */
    const assertInlineSample = (reading, where, sample) => {
      const hits = reading.inline.filter((node) => node.text === sample.text);
      assert.ok(
        hits.length >= 1,
        `${where}: inline sample "${sample.id}" is missing from the served page (looked for ${JSON.stringify(sample.text)}; measured ${JSON.stringify(reading.inline.map((node) => node.text))}) — the check must not pass with the sample gone`,
      );
      for (const node of hits) {
        const problems = inlineCodeBoxProblems(node);
        assert.deepEqual(
          problems,
          [],
          `${where}: inline sample "${sample.id}" (${JSON.stringify(sample.text.slice(0, 48))}) must render a real box inside its parent — ${problems.join("; ")}`,
        );
      }
      return hits;
    };

    /**
     * Every captured `pre` carrying a *named* block sample must keep a reachable internal
     * scroll — or fail loudly. Size alone is not the contract: `overflow-x: hidden` keeps
     * `scrollWidth > clientWidth` while removing the only way the user can reach the line.
     */
    const assertBlockSample = (reading, where, sample) => {
      const hits = reading.pre.filter((node) => node.text.includes(sample.text));
      assert.ok(
        hits.length >= 1,
        `${where}: block-level sample "${sample.id}" is missing from every <pre> (looked for ${JSON.stringify(sample.text)}; ${reading.pre.length} <pre> block(s) measured) — the block contract must not pass vacuously`,
      );
      for (const block of hits) {
        const problems = blockScrollProblems(block, reading.viewportWidth);
        assert.deepEqual(
          problems,
          [],
          `${where}: block sample "${sample.id}": the oversize line must stay reachable through the block's own horizontal scroll — ${problems.join("; ")}`,
        );
      }
      return hits;
    };

    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
      const reading = await measure(viewport);
      const where = `${viewport.width}x${viewport.height}`;

      // --- 1. sample existence + behaviour of those very samples (the desktop branch uses
      //        the same helpers, never a weaker contract) ---------------------------
      assert.ok(reading.inline.length >= WEB_PUBLISH_INLINE_SAMPLES.length, `${where}: the served page must render all ${WEB_PUBLISH_INLINE_SAMPLES.length} inline-code samples, saw ${reading.inline.length}`);
      for (const sample of WEB_PUBLISH_INLINE_SAMPLES) assertInlineSample(reading, where, sample);
      assert.ok(reading.pre.length >= 1, `${where}: the served page must render the block-level <pre> sample (saw ${reading.pre.length})`);
      for (const sample of WEB_PUBLISH_BLOCK_SAMPLES) assertBlockSample(reading, where, sample);

      // --- 2. page-level breadth checks (all inline nodes, all blocks) ---------------
      assert.ok(
        reading.scrollWidth <= reading.clientWidth + 1,
        `${where}: the page must not scroll sideways (scrollWidth=${reading.scrollWidth} clientWidth=${reading.clientWidth})`,
      );
      assert.deepEqual(reading.overflowing, [], `${where}: no element may paint past the viewport`);
      for (const node of reading.inline) {
        const problems = inlineCodeBoxProblems(node);
        assert.deepEqual(
          problems,
          [],
          `${where}: inline code "${node.text.slice(0, 32)}" must render and wrap inside its parent — ${problems.join("; ")}`,
        );
      }
      for (const block of reading.pre) {
        const problems = blockScrollProblems(block, reading.viewportWidth);
        assert.deepEqual(problems, [], `${where}: every block-level <pre> must keep a reachable internal scroll — ${problems.join("; ")}`);
      }
    }

    // Target ② control: the wide layout obeys exactly the same contract (same helpers).
    const desktop = await measure({ width: 1440, height: 1000 });
    assert.ok(desktop.inline.length >= WEB_PUBLISH_INLINE_SAMPLES.length, `desktop: the served page must render all ${WEB_PUBLISH_INLINE_SAMPLES.length} inline-code samples, saw ${desktop.inline.length}`);
    for (const sample of WEB_PUBLISH_INLINE_SAMPLES) assertInlineSample(desktop, "desktop", sample);
    assert.ok(desktop.pre.length >= 1, `desktop: the served page must render the block-level <pre> sample (saw ${desktop.pre.length})`);
    for (const sample of WEB_PUBLISH_BLOCK_SAMPLES) assertBlockSample(desktop, "desktop", sample);
    assert.ok(desktop.scrollWidth <= desktop.clientWidth + 1, `desktop: page must not scroll sideways (${desktop.scrollWidth}/${desktop.clientWidth})`);
    assert.deepEqual(desktop.overflowing, [], "desktop: no element may paint past the viewport");
    for (const node of desktop.inline) {
      const problems = inlineCodeBoxProblems(node);
      assert.deepEqual(
        problems,
        [],
        `desktop: inline code "${node.text.slice(0, 32)}" must render and wrap inside its parent — ${problems.join("; ")}`,
      );
    }
    for (const block of desktop.pre) {
      const problems = blockScrollProblems(block, desktop.viewportWidth);
      assert.deepEqual(problems, [], `desktop: every block-level <pre> must keep a reachable internal scroll — ${problems.join("; ")}`);
    }
    // Leave the shared page on the desktop viewport for later scenario authors.
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
}
