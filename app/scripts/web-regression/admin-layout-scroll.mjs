// Document-scroll gate: the Admin shell is `height: 100vh` and only `.content` scrolls. A descendant
// that is laid out *outside* that scroll container (e.g. an absolutely positioned clipped control)
// contributes scrollable overflow to the document instead, so the whole shell — sidebar, page bar and
// all — scrolls away and leaves a blank page under it.
//
// Found in production on 2026-10-31 (v2026.10.31): the self-drawn select clips the real `<select>`
// with `position:absolute`, and the audit page's 每页条数 select sits below a 1587px table, so its
// static position pushed the document to 1719px on an 831px viewport. The fix is `position:fixed`
// (a fixed box never adds to the document's scroll area); this scene is the guard, with a negative
// control that puts `absolute` back and requires the measurement to go red.
import assert from "node:assert/strict";

const PAGES = Object.freeze([
  ["overview", "?tab=overview"],
  ["accounts", "?tab=accounts"],
  ["keys", "?tab=keys"],
  ["clients", "?tab=clients"],
  ["tokens", "?tab=tokens"],
  ["publishes", "?tab=publishes"],
  ["audit", "?tab=audit"],
  ["authz", "access-policy"],
  ["vaults", "vault-git"],
]);

/** Document scroll height vs viewport, plus the clipped-select position that caused the defect. */
const measure = (page) => page.evaluate(`(() => {
  const doc = document.documentElement;
  const content = document.querySelector(".content");
  const clipped = [...document.querySelectorAll("select.sel[data-select-native]")].map((el) => getComputedStyle(el).position);
  return {
    docScrollHeight: doc.scrollHeight,
    docClientHeight: doc.clientHeight,
    innerHeight,
    contentScrolls: content ? content.scrollHeight > content.clientHeight + 1 : false,
    contentOverflowY: content ? getComputedStyle(content).overflowY : null,
    clippedPositions: [...new Set(clipped)],
  };
})()`);

export async function registerDocumentScrollChecks(ctx) {
  const { check, page, goto, tracePhase } = ctx;

  await check("admin-layout: 页面本身不滚动（100vh 外壳），只有 .content 内部滚动", async () => {
    const pages = [...PAGES];
    // The legacy editor is a read-only `?edit=` view now (`?new=1` renders the frozen list: there is no
    // form to open), and a policy id is generated, so the first stored row names it. Its `.ped` grid is
    // the second surface the 2026-10-31 defect came from, so it is scanned instead of dropped.
    await goto("/admin/auth/access-policy");
    const editRoute = await page.evaluate(`(() => {
      const link = [...document.querySelectorAll('.main a[href*="?id="]')].find((node) => /\\?id=/.test(node.getAttribute('href') || ''));
      if (!link) return null;
      const url = new URL(link.getAttribute('href'), location.origin);
      return url.pathname.replace('/admin/auth/', '') + url.search.replace('?id=', '?edit=');
    })()`);
    if (editRoute) pages.push(["authz-view", editRoute]);
    const report = [];
    for (const [id, route] of pages) {
      await goto(`/admin/auth/${route}`);
      const m = await measure(page);
      report.push({ id, ...m });
    }
    tracePhase?.("document-scroll", { report });
    for (const row of report) {
      assert.ok(
        row.docScrollHeight <= row.docClientHeight + 1,
        `${row.id}: the document must not scroll (scrollHeight ${row.docScrollHeight} > clientHeight ${row.docClientHeight})`,
      );
      assert.ok(row.contentOverflowY === "auto" || row.contentOverflowY === "scroll", `${row.id}: .content is the scroll container (overflow-y: ${row.contentOverflowY})`);
      for (const position of row.clippedPositions) {
        assert.equal(position, "fixed", `${row.id}: a clipped real select must be position:fixed, not ${position}`);
      }
    }
    // The audit page is the one that reproduces the defect (long list + pager select).
    const audit = report.find((row) => row.id === "audit");
    assert.ok(audit.contentScrolls, "the audit fixture must be long enough to overflow .content, or this guard proves nothing");
  });

  await check("admin-layout: 负控 — 同一段超高内容，进 .content 不外溢、进 body 必须真红", async () => {
    await goto("/admin/auth?tab=audit");
    const before = await measure(page);
    assert.ok(before.docScrollHeight <= before.docClientHeight + 1, "precondition: the page does not scroll");
    const probe = await page.evaluate(`(() => {
      const doc = document.documentElement;
      const spacer = document.createElement("div");
      spacer.style.cssText = "height:2000px;flex:0 0 auto";
      const content = document.querySelector(".content");
      content.appendChild(spacer);
      const insideContent = doc.scrollHeight;
      spacer.remove();
      document.body.appendChild(spacer);
      const insideBody = doc.scrollHeight;
      spacer.remove();
      return { insideContent, insideBody, docClientHeight: doc.clientHeight };
    })()`);
    // Two-sided: the criterion can go red (body overflow is seen) and the shell really contains its
    // content (the same spacer inside `.content` does not open the document) — 2000px of content that
    // escapes is exactly the 2026-10-31 production symptom.
    assert.ok(
      probe.insideBody > probe.docClientHeight + 1,
      `the measurement must see a document-level overflow (got ${probe.insideBody} / ${probe.docClientHeight})`,
    );
    assert.ok(
      probe.insideContent <= probe.docClientHeight + 1,
      `the shell must contain its content (a 2000px spacer inside .content opened the document to ${probe.insideContent})`,
    );
    const after = await measure(page);
    assert.ok(after.docScrollHeight <= after.docClientHeight + 1, "removing the probe must leave a non-scrolling document");
  });
}
