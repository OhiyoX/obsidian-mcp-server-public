// Issue #423 (real Chromium): a `vault.resync`-driven Explorer rebuild must not lose the root
// listing to the anchor-inclusive page of an in-flight document open.
//
// Every `vault.resync` frame (coverage-gap / watcher-ready / catalog-ready, plus the periodic
// watcher frames) makes `features/explorer/lazy-events.js` call `controller.invalidateEverything()`:
// the whole page set is retired and the root plus every expanded chain is re-materialized. A
// document open runs `openNote() -> explorer.ensureVisible() -> tree.locate()`, and `locate()` asks
// for an ANCHOR-INCLUSIVE page (`parent=&anchorPath=A.md`) -- a page that begins at the anchor and
// therefore excludes every sibling that sorts before it.
//
// When the frame lands while the open is still locating, the anchor page used to retire the
// rebuild's complete first page and win the write: the level was left holding only the slice from
// the anchor onwards, so every root-level folder (the folder group sorts before the root notes)
// disappeared from the DOM, and the page never re-fetched it (measured: still empty after >= 2.5 s,
// U47 fixture). The rebuild then returned `null` because its root page had been retired, so its own
// re-anchor step never ran either.
//
// This check drives exactly that interleaving through the application's own subscription: a
// well-formed `vault.resync` frame is re-dispatched on the page's real `EventSource` instances while
// the note fetch is in flight (`features/sync/live-events.js` subscribes by event name, so the
// mirror is structurally identical to the production subscription), and the rebuild's un-anchored
// root page is stalled by `page.route` so the anchor page deterministically writes last on an
// unfixed controller. No application file is touched and no assertion is derived from timing alone:
// the witnesses are the injected frame count and the `#note-list` rows.
//
// The row assertions run over a *witness domain* (`witnessRootRows`), not over the raw listing: the
// fixture Vault is shared with every other scene of this suite, so a row that another scene already
// deleted can still be listed when this scene samples. CI run 37888489851 attempt 1 (job
// 113683805332) failed this check exactly there -- `before.notes` carried `Draft mobile ok.md` and
// `Draft network.md`, removed from the Vault minutes earlier by `explorer-draft.mjs:322` / `:476`,
// while the measured rebuild listed neither; the same sample showed the mirror case, `attachments/`
// (created by `asset-drop.mjs`) present only in `after`. The domain keeps every row the Vault still
// holds -- this scene's fixture and every other scene's real rows alike -- so the #423 symptom (the
// whole root group vanishing from the level) is still pinned, and it only refuses to charge this
// rebuild for rows the fixture Vault no longer has.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const HOME_ROUTE = '/app';
// Same observation contract as `explorer.mjs` check 2 / `welcome-transition.mjs`: the listing has
// stopped mutating, so the scene builds its witness on a settled tree.
const SETTLE_MS = 400;
// Fire the frame once the note fetch is already in flight: the resync handler (and therefore
// `invalidateEverything`) then runs before the open's own `locate()` reads the root level.
const INJECT_AFTER_MS = 5;
// Stall the resync rebuild's un-anchored root page while the scene has armed itself, so that -- WITH
// the defect -- the open's fast anchor page writes last deterministically instead of on a lucky
// ordering. The preparation phase is never stalled, so the page's own startup rebuild cannot leave
// the tree empty when the scene samples its witness.
const ROOT_STALL_MS = 400;
// The self-heal window: the listing must come back on its own, without a manual refresh.
const HEAL_TIMEOUT_MS = 4000;
const SCENE_ATTEMPTS = 3;
// The shared fixture's own root folder (`env.mjs` creates it) and the note this scene opens: the two
// rows that must be inside the witness domain, so the domain can never become empty or trivially
// satisfied and the #423 symptom always has a folder row to lose.
const WITNESS_ROOT_FOLDER = 'Folder';
const WITNESS_NOTE = 'A.md';

// Which of the rows the page showed before the race did the fixture Vault really hold? The rest are
// catalog-lag phantoms left by another scene of this shared-Vault suite (see the header), and a
// rebuild cannot be charged for a row that is no longer in the Vault.
async function witnessRootRows({ folders, notes }, vault) {
  const existing = async (rows) => {
    const kept = [];
    for (const row of rows) {
      try {
        await fs.lstat(path.join(vault, row));
        kept.push(row);
      } catch {
        // Already removed from disk by another scene: a stale catalog row, not a dropped row.
      }
    }
    return kept;
  };
  return { folders: await existing(folders), notes: await existing(notes) };
}

export async function registerExplorerResyncRaceChecks({ check, sleep, page, base, open, vault }) {
  // Installed before the first navigation of the scene, so the wrapper exists before the app's own
  // `features/sync/live-events.js` constructs its `EventSource`. It only mirrors/counts the named
  // event and, when armed, re-dispatches one frame on the page's own source instances.
  await page.addInitScript((injectAfterMs) => {
    const Native = window.EventSource;
    window.__v423 = { frames: 0, injected: 0, sources: [] };
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener('vault.resync', () => { window.__v423.frames += 1; });
        window.__v423.sources.push(this);
      }
    };
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/web/v1/note?') && sessionStorage.__v423Arm) {
        delete sessionStorage.__v423Arm; // one injected frame per scene
        setTimeout(() => {
          window.__v423.injected += 1;
          const frame = JSON.stringify({ type: 'vault.resync', origin: 'v423-injected' });
          for (const source of window.__v423.sources) {
            source.dispatchEvent(new MessageEvent('vault.resync', { data: frame }));
          }
        }, injectAfterMs);
      }
      return nativeFetch.apply(this, arguments);
    };
  }, INJECT_AFTER_MS);

  const counters = () => page.evaluate(() => ({ frames: window.__v423?.frames ?? 0, injected: window.__v423?.injected ?? 0 }));
  const listing = () => page.evaluate(() => ({
    folders: [...document.querySelectorAll('#note-list .tree-folder-row')].map((row) => row.dataset.folderPath ?? ''),
    notes: [...document.querySelectorAll('#note-list .note[data-path]')].map((row) => row.dataset.path ?? ''),
  }));
  const settleExplorer = async () => {
    await page.waitForFunction(() => document.querySelector('#live-status')?.dataset?.state === 'live', null, { timeout: 15000 });
    await page.evaluate(() => {
      window.__v423QuietAt = performance.now();
      window.__v423Observer = new MutationObserver(() => { window.__v423QuietAt = performance.now(); });
      window.__v423Observer.observe(document.querySelector('#note-list'), { childList: true, subtree: true });
    });
    try {
      await page.waitForFunction((quiet) => performance.now() - window.__v423QuietAt > quiet, SETTLE_MS, { timeout: 15000 });
    } finally {
      await page.evaluate(() => { window.__v423Observer?.disconnect(); window.__v423Observer = null; });
    }
  };

  await check('an Explorer rebuild that lands while a note opens keeps the root listing (issue #423)', async () => {
    const treeRequests = [];
    const started = Date.now();
    const onTreeRequest = (request) => {
      if (!request.url().includes('/api/web/v2/tree')) return;
      const url = new URL(request.url());
      treeRequests.push(`${Date.now() - started}ms parent="${url.searchParams.get('parent') ?? ''}" anchor=${url.searchParams.get('anchorPath') ?? '-'}`);
    };
    page.on('request', onTreeRequest);
    // Stall on the second and later un-anchored root pages: the first one is the scene's own first
    // paint, the next one is the injected resync's rebuild.
    let stalling = false;
    const stallRebuildRoot = async (route) => {
      const url = new URL(route.request().url());
      if (stalling && (url.searchParams.get('parent') ?? '') === '' && !url.searchParams.has('anchorPath')) {
        await sleep(ROOT_STALL_MS);
      }
      await route.continue();
    };
    let measured = false;
    try {
      for (let attempt = 1; attempt <= SCENE_ATTEMPTS && !measured; attempt += 1) {
        stalling = false;
        await page.route('**/api/web/v2/tree**', stallRebuildRoot);
        try {
          await page.goto(`${base}${HOME_ROUTE}`);
          await page.waitForSelector('.note[title="A.md"]');
          await settleExplorer();
          // The page's own startup rebuild clears the listing for the duration of its re-fetch, so
          // wait for the root rows to be really present before building the witness (a stall is never
          // in force during this preparation phase, so this simply waits out the app's own rebuild).
          await page.waitForFunction(() => document.querySelectorAll('#note-list .tree-folder-row').length > 0, null, { timeout: 15000 });
          const before = await listing();
          const framesBefore = await counters();
          assert.ok(before.folders.length > 0, `the fixture root listing must carry folder rows: ${JSON.stringify(before)}`);
          // Freeze the witness domain while the listing is still pre-race, and keep the rows that
          // were dropped as phantoms readable on the page (the instrument in `V423/diag` prints
          // them, so a green run cannot be an accidental empty domain).
          assert.ok(typeof vault === 'string' && vault.length > 0, 'the fixture Vault path is required to scope the witness domain');
          const witness = await witnessRootRows(before, vault);
          await page.evaluate((stale) => { window.__v423StaleRows = stale; }, {
            folders: before.folders.filter((row) => !witness.folders.includes(row)),
            notes: before.notes.filter((row) => !witness.notes.includes(row)),
          });
          assert.ok(witness.folders.includes(WITNESS_ROOT_FOLDER), `the shared fixture's own root folder row must be inside the witness: ${JSON.stringify({ before, witness })}`);
          assert.ok(witness.notes.includes(WITNESS_NOTE), `the note this scene opens must be inside the witness: ${JSON.stringify({ before, witness })}`);
          // Arm the injection for the very next note fetch, then take the ordinary open path. Only
          // from here on is the resync rebuild's root page stalled.
          stalling = true;
          await page.evaluate(() => { sessionStorage.__v423Arm = '1'; });
          await open('A.md');
          // Bounded self-heal read: the listing has to come back on its own.
          let healed = true;
          try {
            await page.waitForFunction((count) => document.querySelectorAll('#note-list .tree-folder-row').length >= count, witness.folders.length, { timeout: HEAL_TIMEOUT_MS });
          } catch {
            healed = false;
          }
          const after = await listing();
          stalling = false;
          const framesAfter = await counters();
          // A *real* resync landing inside the scene also rebuilds the listing, so the read would
          // describe two interleaved rebuilds; re-run the scene on a settled page instead.
          if (framesAfter.frames - framesBefore.frames > framesAfter.injected - framesBefore.injected && attempt < SCENE_ATTEMPTS) continue;
          measured = true;

          assert.equal(framesAfter.injected, framesBefore.injected + 1, `the injected vault.resync frame must reach the application subscription: ${JSON.stringify({ framesBefore, framesAfter })}`);
          assert.ok(framesAfter.frames > framesBefore.frames, 'the application must rebuild for the injected frame');
          // Only LOSSES are the defect: another scene's upload (or a real editor) may legitimately add
          // a root row while this scene runs, and an added row is not a lost one. The comparison runs
          // over the witness domain, so a row another scene already deleted from the Vault cannot be
          // reported as this rebuild's loss (see the header and `witnessRootRows`).
          const lostFolders = witness.folders.filter((row) => !after.folders.includes(row));
          const lostNotes = witness.notes.filter((row) => !after.notes.includes(row));
          assert.deepEqual(lostFolders, [], `a resync-driven rebuild must not drop root folders while a note opens (#423): ${JSON.stringify({ before, witness, after })} | ${treeRequests.join(' | ')}`);
          assert.deepEqual(lostNotes, [], `and it must keep the root notes: ${JSON.stringify({ before, witness, after })} | ${treeRequests.join(' | ')}`);
          assert.equal(healed, true, `the root listing must return within ${HEAL_TIMEOUT_MS} ms without a manual refresh: ${JSON.stringify({ witness, after })}`);
          assert.equal(await page.evaluate(() => document.querySelector('#current-path').textContent.trim()), 'A.md', 'the opened note stays current');
          assert.equal(await page.evaluate(() => document.querySelector('.note[aria-current="page"]')?.dataset.path ?? null), 'A.md', 'and its row is still the current row');
        } finally {
          stalling = false;
          await page.unroute('**/api/web/v2/tree**', stallRebuildRoot);
        }
      }
      assert.equal(measured, true, `the scene must complete one measured attempt (requests: ${treeRequests.join(' | ')})`);
    } finally {
      page.off('request', onTreeRequest);
    }
  });
}
