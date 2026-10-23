// Issue #336 (real Chromium): opening a deep note must materialize every ancestor level
// AND land the current note row inside the list viewport.
//
// The regression is the *first paint* + *hard refresh* of a deep `/app/note/<route>` URL:
// the client connects its SSE stream right after the note commit, and the server answers
// that subscribe with a `vault.resync` (`coverage-gap`, and `watcher-ready` when the
// filesystem watcher is (re)created). That event re-materializes the tree after the first
// reveal render, so the scroll into view must run again on the settled tree — a one-shot
// scroll is discarded by the re-materialization. A level that is expanded, unloaded, not
// loading and not errored is the failure signature of issue #336 ("已展开但子级未加载")
// and is asserted against directly.
//
// The fixture is deliberately TALL: 60 root-level folders collate before `_Workspace`, so
// in the full-root layout the whole `_Workspace` chain sits below the list viewport at
// scrollTop 0. (Anchor pages start at the target, so in an anchor-window layout the row can
// legitimately be near the top; the probe therefore requires the row to be inside the
// viewport always, and a non-zero scrollTop only when the row starts below the fold.)
//
// R336 (#336 wait contract). Every read below waits for the fact its assertion is about:
//
//   1. the *committed document identity* (`#current-path` is the deep-linked note) is the
//      first fact — the deep link's own open is a precondition, not a race. Reading the
//      identity after a fixed delay (the flat scene's 1000 ms sleep) or settling on geometry
//      alone produced the CI signature this module was reworked for: `尚未打开笔记` compared
//      against the deep note path (run `37953848508` attempt 1, job `113899221114`, and three
//      earlier jobs where the flat check failed 1.7 s after the previous check passed);
//   2. the tree/geometry settle runs *inside the page*, as one read plus one judgment in the
//      same frame, with a bounded timeout (the `settledFolderState()` pattern from
//      `welcome-transition.mjs`): a read taken between two application rebuilds could accept
//      a cleared listing;
//   3. a timeout fails loudly with the whole state — identity witnesses, every ancestor level,
//      the note row geometry, the timeline verdict and the `vault.resync` frame count — so the
//      next occurrence classifies itself; a document that never opens still fails (late open).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { encodeDocumentRoute } from '../../src/publish/service.js';
// R476-fix (#468 diagnosis): the pre-navigation request timeline replaces the note-only observer
// that was installed *after* the failing navigation. The four controlled faults per family and
// their paired control (the shipped observer) live in `reveal-injections.mjs`; the commit-path,
// correlation and window regressions live in `reveal-commit-scenes.mjs`; the page-side geometry
// probe in `reveal-probe.mjs` (extracted for the 500-line budget).
import { attachRevealTimeline, NOTE_API_PATH } from './reveal-diagnostics.mjs';
import { installRevealProbe } from './reveal-probe.mjs';
import {
  installSupersededReadStub, installVaultsBodyStallStub, registerRevealInjectionChecks,
} from './reveal-injections.mjs';
import { installParallelReadStub, registerRevealCommitChecks } from './reveal-commit-scenes.mjs';

// `_Workspace/<area>/<slice>/<leaf>/Target.md`: four directory levels below the root, the
// same shape as the reported `_Workspace/...` note.
const DEEP_PARENT = '_Workspace/40-Projects/U19/Deep';
const DEEP_NOTE = `${DEEP_PARENT}/Target.md`;
const PUBLISHED_NOTE = `${DEEP_PARENT}/Published.md`;
const DEEP_ANCESTORS = ['_Workspace', '_Workspace/40-Projects', '_Workspace/40-Projects/U19', DEEP_PARENT];
const DEEP_PAD_NOTES = 30;
const PAD_LAST = `_Pad-${String(DEEP_PAD_NOTES - 1).padStart(3, '0')}`;
// The first-paint `vault.resync` re-materializes the tree with full pages *after* the
// anchor-window layout is already painted, so the anchor layout must not be accepted as the
// settled state. The grace below is that documented window; the settle predicate itself is
// state-based (see `installRevealProbe`).
const RESYNC_GRACE_MS = 2000;
const REVEAL_SETTLE_TIMEOUT_MS = 8000;
// The deep link's own open is a separate, separately bounded precondition: the old single
// poll spent the same budget on geometry that could never settle before the commit, so a slow
// open starved the reveal budget and reported an unreadable identity.
const DOCUMENT_OPEN_TIMEOUT_MS = 8000;
// Barrier for the late-open regression: long past the fixed delay the flat scene used to read
// on, far inside the bounded wait the fix introduces.
const LATE_OPEN_DELAY_MS = 1500;

function decodeRoute(route) {
  return JSON.parse(Buffer.from(route, 'base64url').toString('utf8'));
}

function summarize(state) {
  if (!state) return 'state=unreadable';
  return `currentPath=${JSON.stringify(state.currentPath)}, welcome=${state.document?.welcomeVisible}, `
    + `tabs=${JSON.stringify(state.document?.tabs ?? [])}, note=${JSON.stringify(state.note)}, `
    + `levels=${JSON.stringify(state.levels)}, resyncFrames=${state.resyncFrames}, scrollCalls=${JSON.stringify(state.scrollCalls)}`;
}

// R476: the diagnosis is the *timeline* (note/vaults/tree requests with body completion, plus the
// application's commit events), attached once before any navigation this module performs. Every
// natural scene below runs inside `timeline.runWindow()`, so a failing scene writes its whole
// window — timeline, final state and the original error — before the next navigation resets it.
let revealTimeline = null;

async function readRevealState(page) {
  try { return await page.evaluate(() => window.__revealReadState?.() ?? null); } catch { return null; }
}

async function revealFailureContext(page) {
  const timeline = revealTimeline ? await revealTimeline.text() : 'timeline=not attached';
  return `${summarize(await readRevealState(page))}; ${timeline}`;
}

// Wait for the fact the assertions are about. `#current-path` is the committed document
// identity: reading it on a fixed delay is a read defect, not a verdict. The bounded wait
// covers the whole precondition (shell, `#note-list`, commit), so the total budget stays the
// one this check always had instead of growing a second selector timeout in front of it.
// `timeoutMs` is only ever shortened by the R476 injection checks (scenes made to fail).
async function waitForCommittedDocument(page, notePath, label, { timeoutMs = DOCUMENT_OPEN_TIMEOUT_MS } = {}) {
  try {
    const handle = await page.waitForFunction(
      () => {
        const state = window.__revealReadState?.() ?? null;
        return state?.document?.committed ? state : null;
      },
      null,
      { timeout: timeoutMs, polling: 100 },
    );
    return await handle.jsonValue();
  } catch {
    throw new Error(`${label}: the deep-linked note never became the committed document within ${timeoutMs} ms (${await revealFailureContext(page)})`);
  }
}

async function waitForRevealSettled(page, notePath, label) {
  await new Promise((resolve) => setTimeout(resolve, RESYNC_GRACE_MS));
  try {
    const handle = await page.waitForFunction(() => window.__revealSettled?.() ?? null, null, { timeout: REVEAL_SETTLE_TIMEOUT_MS, polling: 250 });
    return await handle.jsonValue();
  } catch {
    throw new Error(`${label}: the deep-linked note never revealed within ${REVEAL_SETTLE_TIMEOUT_MS} ms (${await revealFailureContext(page)})`);
  }
}

async function assertRevealed(page, notePath, label) {
  await waitForCommittedDocument(page, notePath, label);
  const state = await waitForRevealSettled(page, notePath, label);
  const summary = summarize(state);
  const byPath = new Map(state.levels.map((level) => [level.path, level]));
  assert.equal(state.currentPath, notePath, `${label}: the deep-linked note must be open (${summary})`);
  for (const ancestor of DEEP_ANCESTORS) {
    const level = byPath.get(ancestor);
    assert.ok(level, `${label}: ancestor row "${ancestor}" must be rendered (${summary})`);
    assert.equal(level.expanded, true, `${label}: "${ancestor}" must be expanded (${summary})`);
    assert.ok(level.rows > 0, `${label}: expanded "${ancestor}" must render its children (${summary})`);
    assert.equal(level.retry, false, `${label}: "${ancestor}" must not end on a retry row (${summary})`);
  }
  const silentlyEmpty = state.levels.filter((level) => level.expanded && level.rows === 0 && !level.loading && !level.retry);
  assert.deepEqual(silentlyEmpty, [], `${label}: no expanded level may be left silently empty (${summary})`);
  assert.equal(state.note.present, true, `${label}: the current note row must exist in the tree (${summary})`);
  assert.equal(state.note.ariaCurrent, 'page', `${label}: the current note row must be marked current (${summary})`);
  assert.equal(state.note.inViewport, true, `${label}: the current note row must be inside the list viewport (${summary})`);
  // The row only needs a scroll when it starts below the fold. An anchor-window layout can
  // legitimately place the deep row near the top (scrollTop 0 is then correct); the full-root
  // layout (the reported one) puts it below the fold and the tree must have scrolled.
  if (state.note.belowFold) {
    assert.ok(state.note.scrollTop > 0, `${label}: the tree must scroll the current note into view (${summary})`);
  }
  return state;
}

async function setExplorerMode(page, mode) {
  await page.locator('#explorer-mode-toggle').click();
  await page.locator(`#explorer-mode-menu [data-explorer-mode="${mode}"]`).click();
  await page.waitForFunction(
    (expected) => document.querySelector('.panel-head')?.getAttribute('data-explorer-mode') === expected,
    mode,
  );
}

export async function registerExplorerRevealChecks({ check, page, base, vault, outputRoot, errors, sleep }) {
  // `registerBasesChecks` leaves the shared page at a mobile viewport at registration time,
  // so every check below pins the desktop layout it asserts against (and the reveal
  // geometry/visibility assertions are desktop-shaped).
  const ensureDesktop = () => page.setViewportSize({ width: 1440, height: 1000 });
  await fs.mkdir(path.join(vault, DEEP_PARENT), { recursive: true });
  // Root-level folder rows that collate before `_Workspace` (verified against the pinned
  // collator): in the full-root layout they push the `_Workspace` chain below the viewport,
  // so "the note exists" and "the note is visible" are two different facts.
  for (let n = 0; n < DEEP_PAD_NOTES; n += 1) {
    const dir = path.join(vault, `_Pad-${String(n).padStart(3, '0')}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'child.md'), `# pad ${n}\n`);
  }
  await fs.writeFile(path.join(vault, DEEP_NOTE), '# Deep target\n\nissue 336 reveal fixture\n');
  await fs.writeFile(path.join(vault, PUBLISHED_NOTE), '# Published deep note\n\nissue 336 publish-filter fixture\n');
  // A freshly written fixture needs a catalog reconcile before its anchor is resolvable;
  // `anchor-not-indexed` (409) is the expected transient. The ROOT page must also expose
  // `_Workspace`, otherwise a first paint runs against a root without the chain.
  let indexed = false;
  for (let attempt = 0; attempt < 300 && !indexed; attempt += 1) {
    const rootResponse = await page.request.get(`${base}/api/web/v2/tree?parent=`);
    const rootItems = rootResponse.ok() ? (await rootResponse.json()).items ?? [] : [];
    const anchorResponse = await page.request.get(`${base}/api/web/v2/tree?parent=${encodeURIComponent(DEEP_PARENT)}&anchorPath=${encodeURIComponent(DEEP_NOTE)}`);
    indexed = rootItems.some((item) => item.path === '_Workspace') && anchorResponse.ok();
    if (!indexed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(indexed, true, 'the deep fixture chain must be indexed before the probe');
  const vaults = await (await page.request.get(`${base}/api/web/v1/vaults`)).json();
  const deepLink = `${base}/app/note/${encodeDocumentRoute(vaults.current, DEEP_NOTE)}`;
  assert.equal(decodeRoute(deepLink.split('/').at(-1)).path, DEEP_NOTE);
  await installRevealProbe(page, { ancestors: DEEP_ANCESTORS, note: DEEP_NOTE });
  // R476: attach the request timeline here — before ANY navigation this module performs, so the
  // boot reads of the deep-link document are inside the observation window by construction (the
  // page-side hook runs at document start, the recorder is live from this line). The page-side
  // stubs are registered FIRST: all of them are document-start scripts wrapping `window.fetch` and
  // the last one registered wraps the first, so this order keeps the synthesized answers
  // observable by the timeline. Each stub is inert unless the scene's URL carries its own marker.
  await installSupersededReadStub(page, { notePath: DEEP_NOTE });
  await installVaultsBodyStallStub(page);
  await installParallelReadStub(page, { notePath: DEEP_NOTE });
  revealTimeline = await attachRevealTimeline(page, { notePath: DEEP_NOTE, budgetMs: DOCUMENT_OPEN_TIMEOUT_MS, outputRoot });
  const scrollCalls = () => page.evaluate(() => window.__revealScrollCalls ?? []);

  await check('explorer reveal #336: deep-link first paint materializes every ancestor level', async () => {
    const before = errors.length;
    await ensureDesktop();
    // Full navigation to the deep link: fresh document, one-shot catalog load, and the
    // SSE connect (with its `vault.resync`) landing while the anchor walk is in flight. The window
    // write on failure happens inside `runWindow`, before the next navigation can reset it.
    const state = await revealTimeline.runWindow('first paint', {}, async () => {
      await page.goto(deepLink);
      const revealed = await assertRevealed(page, DEEP_NOTE, 'first paint');
      // R476: the failure path carries a request-correlated timeline; the observation ordering is
      // asserted too, and the window must hold the vaults boot read plus the deep note's commit.
      const snapshot = await revealTimeline.snapshot();
      assert.equal(snapshot.installProof.recorderAttachedBeforeFirstRequest, true, `first paint: the recorder must precede the boot read (${JSON.stringify(snapshot.installProof)})`);
      assert.equal(snapshot.installProof.pagePatchBeforeFirstFetch, true, `first paint: the page hook must precede the document's first tracked fetch (${JSON.stringify(snapshot.installProof)})`);
      assert.match(snapshot.verdict.line, /commitOpen applied for the target/, `first paint: the healthy scene must record the commit (${snapshot.verdict.line})`);
      // The instrument that names the injected classes names the healthy scene as committed:
      // the discrimination is a six-way reading, not a one-sided demonstration.
      assert.equal(snapshot.verdict.kind, 'committed', `first paint: the healthy scene is the committed control (${snapshot.verdict.line})`);
      assert.equal(snapshot.verdict.commitPath.applied, 1, `first paint: exactly one applied commit for the deep link (${snapshot.verdict.line})`);
      assert.equal(snapshot.verdict.finalIdentity, DEEP_NOTE, `first paint: the final UI identity is the deep link (${snapshot.verdict.line})`);
      // Assert on the entries, not the rendered summary: the summary is chronological, so the page
      // hook's `fetch-request` precedes the harness `request` for the same vaults read.
      const firstPaintVaults = snapshot.entries.filter((entry) => entry.family === 'vaults');
      assert.ok(firstPaintVaults.some((entry) => entry.phase === 'request'), `first paint: the window must carry the vaults read (${snapshot.verdict.vaults})`);
      assert.ok(firstPaintVaults.some((entry) => entry.phase === 'response-headers'), `first paint: the vaults read must be answered in the window (${snapshot.verdict.vaults})`);
      await revealTimeline.writeArtifact(outputRoot, 'reveal-timeline-first-paint.json');
      assert.equal(await page.evaluate(() => location.pathname.startsWith('/app/note/')), true);
      assert.deepEqual(errors.slice(before), [], 'no page errors during the reveal');
      await page.screenshot({ path: path.join(outputRoot, 'explorer-reveal-first-paint.png') });
      return revealed;
    });
    return state;
  });

  await check('explorer reveal #336: hard refresh keeps every ancestor level materialized', async () => {
    const before = errors.length;
    const state = await revealTimeline.runWindow('hard refresh', {}, async () => {
      await page.reload();
      const revealed = await assertRevealed(page, DEEP_NOTE, 'hard refresh');
      assert.deepEqual(errors.slice(before), [], 'no page errors during the reveal');
      await page.screenshot({ path: path.join(outputRoot, 'explorer-reveal-hard-refresh.png') });
      return revealed;
    });
    return state;
  });

  // A second, deeper variant proves the fix is not tied to one depth and that a reveal in a
  // live session (no cold document) behaves the same after an explicit `vault.resync`-like
  // invalidation: open the note from the tree, then reload once more from a clean page.
  await check('explorer reveal #336: reveal-current restores the chain after re-opening the note', async () => {
    const before = errors.length;
    await ensureDesktop();
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="A.md"]');
    const state = await revealTimeline.runWindow('re-open', {}, async () => {
      await page.goto(deepLink);
      await assertRevealed(page, DEEP_NOTE, 're-open');
      // Non-regression: the manual `#reveal-active` locate must still land the row in view
      // after the user scrolled the list to the top (same render+scrollIntoView path).
      await page.evaluate(() => { document.querySelector('#note-list').scrollTop = 0; });
      const scrolledAway = await readRevealState(page);
      assert.equal(scrolledAway.note.scrollTop, 0, `reveal-current: the probe must be able to scroll the list to the top (${summarize(scrolledAway)})`);
      // Only a row that starts below the fold is actually taken out of view by scrolling up.
      if (scrolledAway.note.belowFold) {
        assert.equal(scrolledAway.note.inViewport, false, `reveal-current: the note is out of view before the manual locate (${summarize(scrolledAway)})`);
      }
      await page.locator('#reveal-active').click();
      const revealed = await assertRevealed(page, DEEP_NOTE, 'reveal-current');
      assert.deepEqual(errors.slice(before), [], 'no page errors during the reveal');
      await page.goto(`${base}/app`);
      await page.waitForSelector('.note[title="A.md"]');
      return revealed;
    });
    return state;
  });

  // Non-regression: the reveal scroll belongs to Tree mode only. A flat-page deep link must
  // not move the (shared) list container to the tree's current-note row.
  await check('explorer reveal #336: flat mode does not run the tree reveal scroll', async () => {
    const before = errors.length;
    await ensureDesktop();
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="A.md"]');
    await setExplorerMode(page, 'flat');
    const committed = await revealTimeline.runWindow('flat mode', {}, async () => {
      await page.goto(deepLink);
      await page.waitForSelector('#note-list .note .note-subtitle', { timeout: 7000 });
      // R336: the flat rows come from the catalog listing, not from the document commit, so this
      // wait cannot stand in for "the deep link opened". Wait for the committed document itself
      // instead of reading on a fixed delay — the fixed delay is what reported `尚未打开笔记` in CI.
      return waitForCommittedDocument(page, DEEP_NOTE, 'flat mode');
    });
    const flatState = await page.evaluate(() => {
      const list = document.querySelector('#note-list');
      return {
        scrollTop: list ? Math.round(list.scrollTop) : null,
        flatRows: list ? list.querySelectorAll('.note[data-path]').length : 0,
        currentPath: document.querySelector('#current-path')?.textContent ?? null,
      };
    });
    assert.equal(flatState.currentPath, DEEP_NOTE, `flat mode: the deep-linked note must still open (${summarize(committed)}, flat=${JSON.stringify(flatState)})`);
    assert.ok(flatState.flatRows > 0, 'flat mode: the flat list must still render rows');
    assert.equal(flatState.scrollTop, 0, 'flat mode must not scroll the list container to the tree current note');
    const calls = await scrollCalls();
    assert.equal(calls.some((call) => call.path === DEEP_NOTE), false, `flat mode must not run the tree reveal scroll (calls=${JSON.stringify(calls)})`);
    assert.deepEqual(errors.slice(before), [], 'no page errors in flat mode');
    await setExplorerMode(page, 'tree');
    await page.waitForSelector('#note-list .tree-folder-row', { timeout: 7000 });
  });

  // Non-regression: with the Publish filter (an active query) the files tree stays where the
  // reader left it; opening a published note from the results must not scroll the hidden tree.
  await check('explorer reveal #336: an active publish filter does not scroll the tree', async () => {
    const before = errors.length;
    await ensureDesktop();
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="A.md"]');
    // `published:true` is a hard filter over the Publish registry, not frontmatter, so the
    // fixture note is published through the same v1 route the desktop UI uses.
    const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    const publishResponse = await page.request.post(`${base}/api/web/v1/publish`, {
      headers: { 'X-CSRF-Token': csrf },
      data: { action: 'publish', path: PUBLISHED_NOTE },
    });
    assert.equal(publishResponse.status(), 200, 'the deep publish fixture must publish');
    await page.evaluate(() => { window.__revealScrollCalls = []; });
    await page.locator('#publishes-open').click();
    await page.waitForSelector(`#search-list .note[data-path="${PUBLISHED_NOTE}"]`, { timeout: 15000 });
    await page.locator(`#search-list .note[data-path="${PUBLISHED_NOTE}"]`).click();
    await page.waitForFunction((note) => document.querySelector('#current-path')?.textContent === note, PUBLISHED_NOTE);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // The search panel is in front, so the tree is measurable: the open must have materialized
    // the row (ensureVisible) without running the reveal scroll.
    const calls = await scrollCalls();
    assert.equal(calls.some((call) => call.path === PUBLISHED_NOTE), false, `an active publish filter must not run the tree reveal scroll (calls=${JSON.stringify(calls)})`);
    const tree = await page.evaluate((note) => {
      const list = document.querySelector('#note-list');
      return {
        present: Boolean(list?.querySelector(`.note[data-path="${note}"]`)),
        scrollTop: list ? Math.round(list.scrollTop) : null,
      };
    }, PUBLISHED_NOTE);
    assert.equal(tree.present, true, 'publish filter: the tree must still materialize the opened note');
    assert.equal(tree.scrollTop, 0, 'an active publish filter must not scroll the tree');
    assert.deepEqual(errors.slice(before), [], 'no page errors in publish filter');
  });

  // R336: the CI signature (`尚未打开笔记` compared against the deep note path) is a read taken
  // before the application commits the document. This check holds the deep note's own read past
  // the fixed delay the flat scene used to read on, and then requires the scene to wait for the
  // committed document. Its negative control is the same check with the old read (a 1000 ms
  // sleep plus a bare `#current-path` read), which fails with the CI signature verbatim; a
  // document that never opens still fails through `waitForCommittedDocument`'s bounded timeout.
  await check('explorer reveal #336: a deep-link document that opens late is waited for, not read early', async () => {
    const before = errors.length;
    await ensureDesktop();
    const delayedNoteRead = async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path');
      if (target !== DEEP_NOTE) return void route.continue().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, LATE_OPEN_DELAY_MS));
      // The application aborts a superseded read of its own (the boot open plus its
      // `vault.resync` refresh), and a navigation may retire the route while it is held:
      // a held route that resumed after that must not reject, or it would crash the suite.
      return void route.continue().catch(() => {});
    };
    const noteRoute = new RegExp(`${NOTE_API_PATH.replace(/\//g, '\\/')}\\?`);
    await page.route(noteRoute, delayedNoteRead);
    try {
      await page.goto(`${base}/app`);
      await page.waitForSelector('.note[title="A.md"]');
      await setExplorerMode(page, 'flat');
      // The late open gets its own window (it had none before): the phases of this scene belong to
      // this scene, and a failure here must land its own artifact.
      const state = await revealTimeline.runWindow('late open', {}, async () => {
        await page.goto(deepLink);
        // The flat rows are painted from the listing and are visible well before the document
        // commit: exactly the window the old read took the identity in.
        await page.waitForSelector('#note-list .note .note-subtitle', { timeout: 7000 });
        const committed = await waitForCommittedDocument(page, DEEP_NOTE, 'late open');
        assert.equal(committed.currentPath, DEEP_NOTE, `late open: the deep-linked note must be the committed document (${summarize(committed)})`);
        assert.equal(committed.note.present, true, `late open: the deep-linked note row must be materialized (${summarize(committed)})`);
        assert.deepEqual(errors.slice(before), [], 'no page errors during the late open');
        await page.screenshot({ path: path.join(outputRoot, 'explorer-reveal-late-open.png') });
        return committed;
      });
      return state;
    } finally {
      await page.unroute(noteRoute, delayedNoteRead);
      await setExplorerMode(page, 'tree');
      await page.waitForSelector('#note-list .tree-folder-row', { timeout: 7000 });
      await page.goto(`${base}/app`);
      await page.waitForSelector('.note[title="A.md"]');
    }
  });

  // R476-fix (#468): the controlled faults of both families (note + vaults), each paired with the
  // shipped post-navigation observer as the control (see `reveal-injections.mjs`), then the
  // commit-path / correlation / window regressions (see `reveal-commit-scenes.mjs`).
  const sceneContext = {
    check,
    page,
    base,
    deepLink,
    notePath: DEEP_NOTE,
    outputRoot,
    errors,
    ensureDesktop,
    timeline: revealTimeline,
    sleep,
    waitForCommittedDocument: (label, timeoutMs) => waitForCommittedDocument(page, DEEP_NOTE, label, { timeoutMs }),
  };
  await registerRevealInjectionChecks(sceneContext);
  await registerRevealCommitChecks(sceneContext);
  // The reveal module is the timeline's only consumer: stop the harness-side recorder here so the
  // instrument's footprint ends with this module (the document-start hook is an init script and
  // cannot be removed — see the HANDOFF on its bounded, read-only cost).
  revealTimeline.dispose();
  revealTimeline = null;
}
