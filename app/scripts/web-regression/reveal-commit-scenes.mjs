// R476-fix (#468 diagnosis): the commit-path regressions and the request/window correlation ones.
//
// Two things the review seat falsified are proved here on the *application's* own paths rather than
// on a synthetic record:
//
//   1. **identity unchanged ≠ commit not applied.** The seat called the real
//      `createDocumentSession()` directly and showed `commitOpen()` returning `applied: true` twice
//      for the same path while the pre-fix verdict — which only watched `#current-path`'s text for a
//      *change* — reported "commitOpen NEVER applied". `driveRealSession()` below drives that same
//      real session module (read-only import, no product change) and records its own
//      `applied`/`reason` vocabulary, so the observation of the commit path is the commit path's own
//      and not an inference from the DOM. The browser scene behind it then proves the instrument
//      reports the second commit on the real UI path (clicking the already-current note row).
//   2. **correlation by path + time proximity.** Two scenes issue two genuine reads of the same path
//      from the page: one that answers while the other is still in flight, and one where the two
//      complete in the opposite order to their issuance. Each read must keep its own completion.
//
// Plus the window-ownership regression: a failure scene whose read is still held when the window
// closes, and whose late phases must be reported as late rather than adopted by the next window.
// The failure scene is also the *controlled* proof that a failing window lands its artifact before
// the window is reset (the brief's NEXT 3).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildAttempts, belongsToWindow, classifyNoteRead, readOutcome } from './reveal-attempts.mjs';
import { NOTE_API_PATH } from './reveal-diagnostics.mjs';

export const PARALLEL_READ_MARKER = 'r476-parallel-read';
// The dropped read of the pair is marked with this request header, so the scene can hold exactly
// that read at the network layer (`route.request().headers()`). Counting "the first hit of the
// route" instead was the first CI failure of this file: on the runner the counter was consumed by an
// earlier read of the same path, the hold landed on the wrong request, and the check reported a
// `body-incomplete` read where the scene promises a read that is still in flight.
export const PARALLEL_HELD_HEADER = 'x-r476-held-read';

// The page-side stub for the concurrency classes. Under the marker, one application read of the
// deep link is turned into **two genuine reads of the same path issued in the same tick**: the
// second is returned to the application, the first is dropped (its rejection swallowed so the scene
// cannot raise a page error) and carries `PARALLEL_HELD_HEADER`. Both are real HTTP requests, so the
// harness recorder sees two — exactly the shape the pre-fix classifier merged into one — and the
// marked one is the read the scene holds.
export async function installParallelReadStub(page, { notePath, noteApi = NOTE_API_PATH }) {
  await page.addInitScript(({ marker, heldHeader, target, api }) => {
    const nativeFetch = window.fetch;
    window.fetch = function revealParallelRead(...args) {
      const mode = new URLSearchParams(location.search).get(marker);
      if (!mode) return nativeFetch.apply(this, args);
      const raw = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      let parsed = null;
      try { parsed = new URL(raw, location.origin); } catch { return nativeFetch.apply(this, args); }
      if (parsed.pathname !== api || parsed.searchParams.get('path') !== target) return nativeFetch.apply(this, args);
      const init = args[1] || {};
      const heldHeaders = new Headers(init.headers || undefined);
      heldHeaders.set(heldHeader, '1');
      nativeFetch.call(this, args[0], { ...init, headers: heldHeaders }).then(() => {}, () => {});
      return nativeFetch.apply(this, args);
    };
  }, { marker: PARALLEL_READ_MARKER, heldHeader: PARALLEL_HELD_HEADER, target: notePath, api: noteApi });
}

// One same-path pair scene: hold the *marked* read at the network layer for `holdMs` while its
// unmarked twin answers normally. The hold is bounded, and the route stays registered until the hold
// has elapsed, so nothing pending leaks into the next scene (the second CI failure of this file was
// the next scene's vaults read hanging behind a request that was still held).
async function runParallelPairScene({
  page, base, deepLink, timeline, sleep, mode, holdMs, settleMs, label, budgetMs,
  waitForCommittedDocument,
}) {
  await page.goto(`${base}/app`);
  await page.waitForSelector('.note[title="A.md"]');
  const routeLog = [];
  const handler = async (pageRoute) => {
    const request = pageRoute.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith(NOTE_API_PATH)) return void pageRoute.continue().catch(() => {});
    const held = request.headers()[PARALLEL_HELD_HEADER] === '1';
    routeLog.push({ at: Date.now(), held, url: `${url.pathname}${url.search}` });
    if (!held) return void pageRoute.continue().catch(() => {});
    await sleep(holdMs);
    return void pageRoute.continue().catch(() => {});
  };
  const noteRoute = new RegExp(`${NOTE_API_PATH.replace(/\//g, '\\/')}\\?`);
  await page.route(noteRoute, handler);
  try {
    await timeline.runWindow(label, { budgetMs }, async () => {
      await page.goto(`${deepLink}${deepLink.includes('?') ? '&' : '?'}${PARALLEL_READ_MARKER}=${mode}`);
      await waitForCommittedDocument(label, 9000);
      // The reverse scene must outlive the hold so the held read answers inside its own window.
      if (settleMs) await sleep(settleMs);
    });
    const snapshot = await timeline.snapshot();
    return { snapshot, routeLog, windowMs: snapshot.windowMs };
  } finally {
    await sleep(Math.max(0, holdMs - 400));
    await page.unroute(noteRoute, handler);
  }
}

// The real commit path, driven directly. `createDocumentSession()` is the module `core/app.js`
// builds the application session from, so its answers are the application's own commit vocabulary —
// measured here instead of assumed, and recorded as evidence next to the browser scenes.
export async function driveRealSession() {
  const { createDocumentSession } = await import('../../frontend/app/features/session/index.js');
  const session = createDocumentSession({ createMutationId: (() => { let n = 0; return () => `probe-${n += 1}`; })() });
  const trace = [];
  const record = (label, result, identity) => trace.push({
    step: label,
    applied: result.applied === true,
    reason: result.reason ?? null,
    identityPath: identity.path,
    identityEpoch: identity.epoch,
    content: result.content ?? null,
  });

  // (a) a first commit, then a second commit of the *same* path: the seat's counterexample.
  const first = session.beginOpen({ vaultId: 'v1', path: 'Target.md' });
  const firstResult = session.commitOpen(first, { content: '# one\n', revision: 'r1', path: 'Target.md', vaultId: 'v1' });
  record('same-identity:first-commit', firstResult, session.identity());
  const identityAfterFirst = session.identity();
  const second = session.beginOpen({ vaultId: 'v1', path: 'Target.md' });
  const secondResult = session.commitOpen(second, { content: '# two\n', revision: 'r2', path: 'Target.md', vaultId: 'v1' });
  record('same-identity:second-commit', secondResult, session.identity());

  // (b) a read that is superseded before it commits: `stale-request` — the commit path *ran* and
  // refused the answer, which is the "ignored" branch no DOM reading can distinguish from "never
  // attempted".
  const stale = session.beginOpen({ vaultId: 'v1', path: 'Target.md' });
  session.beginOpen({ vaultId: 'v1', path: 'Other.md' });
  const staleResult = session.commitOpen(stale, { content: '# stale\n', revision: 'r3', path: 'Target.md', vaultId: 'v1' });
  record('superseded-read:commit-ignored', staleResult, session.identity());

  // (c) an edit made while the read was pending: `local-edit` — refused for a different reason.
  const edited = session.beginOpen({ vaultId: 'v1', path: 'Other.md' });
  session.noteLocalEdit('# typed locally\n');
  const editResult = session.commitOpen(edited, { content: '# from disk\n', revision: 'r4', path: 'Other.md', vaultId: 'v1' });
  record('local-edit:commit-ignored', editResult, session.identity());

  // (d) commit then switch: the committed identity moves to another document.
  const other = session.beginOpen({ vaultId: 'v1', path: 'Other.md' });
  const otherResult = session.commitOpen(other, { content: '# other\n', revision: 'r5', path: 'Other.md', vaultId: 'v1' });
  record('commit-then-switch:second-document', otherResult, session.identity());
  return { trace, identityAfterFirst, finalIdentity: session.identity() };
}

// The pure correlation regressions: the seat's own counterexample shapes, fed through the real
// attempt builder. These run without a browser because they are about the classifier's attribution
// rule, and they are the direct counterpart of the seat's pure-function counterexample.
export function correlationSequences() {
  const entry = (over) => ({ at: 1000 + (over.rel ?? 0), rel: over.rel ?? 0, ...over });
  return {
    // The seat's real-Chromium shape: read #1 issued at +6 ms, read #2 at +110 ms, read #1 answered
    // with a whole body at +364 ms while read #2 never answered inside the window.
    concurrentFirstAnswered: [
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-request', family: 'note', targetNote: true, fetchSeq: 1, rel: 6, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-request', family: 'note', targetNote: true, fetchSeq: 2, rel: 110, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-response', family: 'note', targetNote: true, fetchSeq: 1, rel: 364, status: 200, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-body-complete', family: 'note', targetNote: true, fetchSeq: 1, rel: 366, status: 200, bytes: 28, path: '/api/web/v1/note?path=Target.md' }),
    ],
    // The seat's pure shape: two independent reads of the same path, 10 ms apart, both answered.
    tenMillisecondsApart: [
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-request', family: 'note', targetNote: true, fetchSeq: 1, rel: 0, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-request', family: 'note', targetNote: true, fetchSeq: 2, rel: 10, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-response', family: 'note', targetNote: true, fetchSeq: 1, rel: 40, status: 200, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-body-complete', family: 'note', targetNote: true, fetchSeq: 1, rel: 42, status: 200, bytes: 12, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-response', family: 'note', targetNote: true, fetchSeq: 2, rel: 60, status: 200, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-body-complete', family: 'note', targetNote: true, fetchSeq: 2, rel: 62, status: 200, bytes: 12, path: '/api/web/v1/note?path=Target.md' }),
    ],
    // A cross-window sequence: read #1 was issued in window 1 and its body lands after window 2
    // opened, alongside window 2's own read #2.
    crossWindowLate: [
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-request', family: 'note', targetNote: true, fetchSeq: 1, rel: 0, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 2, phase: 'fetch-request', family: 'note', targetNote: true, fetchSeq: 1, rel: 500, path: '/api/web/v1/note?path=Target.md' }),
      entry({ source: 'page', windowSeq: 1, phase: 'fetch-body-complete', family: 'note', targetNote: true, fetchSeq: 1, rel: 600, status: 200, bytes: 28, path: '/api/web/v1/note?path=Target.md' }),
    ],
  };
}

export function runCorrelationRegressions() {
  const sequences = correlationSequences();
  const read = (entries, windowSeq) => {
    const current = entries.filter((item) => belongsToWindow(item, windowSeq));
    return {
      attempts: buildAttempts(current, { family: 'note', notePath: 'Target.md', source: 'page', idKey: 'fetchSeq' }),
      excluded: entries.filter((item) => !belongsToWindow(item, windowSeq)),
    };
  };

  // (1) The first read answered; the second must NOT inherit its completion.
  const concurrent = read(sequences.concurrentFirstAnswered, 1);
  assert.equal(concurrent.attempts.length, 2, `concurrent: two reads must stay two reads (${JSON.stringify(concurrent.attempts)})`);
  assert.equal(readOutcome(concurrent.attempts[0]), 'complete', 'concurrent: the answered read must be reported complete');
  assert.equal(readOutcome(concurrent.attempts[1]), 'in-flight', 'concurrent: the unanswered read must stay in flight, never inherit read #1\'s body');

  // (2) Ten milliseconds apart is still two reads, not one merged attempt.
  const tenMs = read(sequences.tenMillisecondsApart, 1);
  assert.equal(tenMs.attempts.length, 2, `10 ms apart: two independent reads must not be merged (${JSON.stringify(tenMs.attempts)})`);
  assert.equal(tenMs.attempts[0].bodyAt, 42, '10 ms apart: read #1 keeps its own completion');
  assert.equal(tenMs.attempts[1].bodyAt, 62, '10 ms apart: read #2 keeps its own completion');

  // (3) A late phase from window 1 is excluded from window 2, and window 2 keeps its own read.
  const cross = read(sequences.crossWindowLate, 2);
  assert.equal(cross.excluded.length, 2, `cross-window: the previous window's read and its late body must be excluded (${JSON.stringify(cross.excluded)})`);
  assert.equal(cross.attempts.length, 1, 'cross-window: the late body must not create a read in the new window');
  assert.equal(readOutcome(cross.attempts[0]), 'in-flight', 'cross-window: the new window\'s own read is in flight, not completed by the late body');
  return { concurrent, tenMs, cross };
}

export async function registerRevealCommitChecks({
  check, page, base, deepLink, notePath, outputRoot, errors, ensureDesktop, timeline, waitForCommittedDocument, sleep,
}) {
  const beforeErrors = () => (errors ? errors.length : 0);
  const targetRow = `#note-list .note[data-path="${notePath}"]`;
  const otherNote = 'A.md';
  const noteRoute = new RegExp(`${NOTE_API_PATH.replace(/\//g, '\\/')}\\?`);

  // The direct observation of the real commit path. Recorded as evidence, asserted for its
  // vocabulary: `applied` twice for one path (identity unchanged), then `stale-request` and
  // `local-edit` — the two refusals no DOM reading can see.
  await check('explorer reveal #476 commit path: the real session returns applied for a same-identity commit and named reasons for a refused one', async () => {
    const probe = await driveRealSession();
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(path.join(outputRoot, 'reveal-commit-session-probe.json'), JSON.stringify(probe, null, 2));
    const byStep = new Map(probe.trace.map((item) => [item.step, item]));
    const first = byStep.get('same-identity:first-commit');
    const second = byStep.get('same-identity:second-commit');
    assert.equal(first.applied, true, `the first commit must apply (${JSON.stringify(first)})`);
    assert.equal(second.applied, true, `the same-identity commit must apply too (${JSON.stringify(second)})`);
    assert.equal(second.identityPath, first.identityPath, 'the identity must be unchanged by the second commit');
    assert.ok(second.identityEpoch > first.identityEpoch, 'the session still moved: the epoch is the commit evidence a text-only observer cannot see');
    assert.deepEqual(
      { applied: byStep.get('superseded-read:commit-ignored').applied, reason: byStep.get('superseded-read:commit-ignored').reason },
      { applied: false, reason: 'stale-request' },
      `a superseded read must be refused by name (${JSON.stringify(probe.trace)})`,
    );
    assert.deepEqual(
      { applied: byStep.get('local-edit:commit-ignored').applied, reason: byStep.get('local-edit:commit-ignored').reason },
      { applied: false, reason: 'local-edit' },
      `an edited read must be refused by name (${JSON.stringify(probe.trace)})`,
    );
    assert.equal(byStep.get('commit-then-switch:second-document').applied, true, 'a switch to another document applies');
    assert.equal(probe.finalIdentity.path, 'Other.md', `the switch must move the identity (${JSON.stringify(probe.finalIdentity)})`);
    return `real session: ${probe.trace.map((item) => `${item.step}=${item.applied ? 'applied' : item.reason}`).join(', ')}`;
  });

  await check('explorer reveal #476 correlation: same-path concurrency and reverse completion keep every read on its own request', async () => {
    runCorrelationRegressions();
    return 'pure attribution regressions: concurrent-first-answered, 10 ms apart, cross-window late';
  });

  // The two reads the stub issues for one application read: same path, same tick, i.e. inside the
  // pre-fix merge window (`SOURCE_TWIN_MS = 30`). Identifying them by that window is the point:
  // the old classifier *merged* exactly these two into one read.
  const twinPair = (attempts) => {
    for (let i = 0; i < attempts.length; i += 1) {
      for (let j = i + 1; j < attempts.length; j += 1) {
        if (Math.abs(attempts[i].requestAt - attempts[j].requestAt) <= 30) return [attempts[i], attempts[j]];
      }
    }
    return null;
  };

  // The real browser version of the same defect: two same-path reads issued in the same tick, the
  // marked one held at the network layer, the other answered. The pre-fix classifier merged exactly
  // these two into one read and handed the completion to "the most recent request on that path".
  await check('explorer reveal #476 correlation: two same-path reads issued together are two reads when one still has not answered', async () => {
    const before = beforeErrors();
    await ensureDesktop();
    const { snapshot, routeLog, windowMs } = await runParallelPairScene({
      page, base, deepLink, timeline, sleep, mode: 'overlap', holdMs: 2000, settleMs: 0,
      label: 'parallel reads (overlap)', budgetMs: 1500, waitForCommittedDocument,
    });
    const { app, http } = snapshot.verdict;
    await fs.writeFile(path.join(outputRoot, 'reveal-correlation-overlap.json'), JSON.stringify({ ...snapshot, routeLog, windowMs }, null, 2));
    const pair = twinPair(http);
    assert.ok(pair, `the two reads issued in the same tick must both be on the transport record (${JSON.stringify(http)})`);
    assert.notEqual(pair[0].id, pair[1].id, 'the two reads must keep distinct identities, never be merged into one');
    assert.ok(pair[0].headersAt == null && pair[0].bodyAt == null, `the held read must still be in flight in the window (${JSON.stringify(pair[0])})`);
    assert.ok(pair[1].bodyAt != null, `the answered read must keep its own completion (${JSON.stringify(pair[1])})`);
    assert.equal(readOutcome(pair[1]), 'complete', `the answered read must be reported complete (${JSON.stringify(pair[1])})`);
    // The application's own read (the returned one) committed: the scene is a healthy open with two
    // transport reads behind it, not a failure.
    assert.ok(snapshot.verdict.commitPath.applied >= 1, `the application read must have committed the deep link (${snapshot.verdict.line})`);
    assert.ok(app.some((attempt) => readOutcome(attempt) === 'complete'), `the application's own read must be complete (${JSON.stringify(app)})`);
    assert.ok(routeLog.some((entry) => entry.held), `the marked read must have reached the route handler (${JSON.stringify(routeLog)})`);
    assert.deepEqual(errors.slice(before), [], 'the concurrency scene must not raise page errors');
    return `held=${pair[0].id} [${readOutcome(pair[0])}] twin=${pair[1].id} [${readOutcome(pair[1])}] within ${Math.abs(pair[0].requestAt - pair[1].requestAt)} ms`;
  });

  // The same pair with the completion order reversed: the read that was issued first answers last.
  await check('explorer reveal #476 correlation: a same-path pair that completes out of order keeps each completion on its own read', async () => {
    const before = beforeErrors();
    await ensureDesktop();
    const { snapshot, routeLog } = await runParallelPairScene({
      page, base, deepLink, timeline, sleep, mode: 'reverse', holdMs: 1500, settleMs: 2200,
      label: 'parallel reads (reverse completion)', budgetMs: 5000, waitForCommittedDocument,
    });
    const { app, http } = snapshot.verdict;
    await fs.writeFile(path.join(outputRoot, 'reveal-correlation-reverse.json'), JSON.stringify({ ...snapshot, routeLog }, null, 2));
    const pair = twinPair(http);
    assert.ok(pair, `the two reads issued in the same tick must both be on the transport record (${JSON.stringify(http)})`);
    assert.equal(readOutcome(pair[0]), 'complete', `the held read must answer inside the budget (${JSON.stringify(pair[0])})`);
    assert.equal(readOutcome(pair[1]), 'complete', `the fast read must answer too (${JSON.stringify(pair[1])})`);
    assert.ok(pair[1].bodyAt < pair[0].bodyAt, `the first-issued read must be the one that completed last (${JSON.stringify(pair)})`);
    assert.ok(pair[0].bodyAt >= 1000, `the held read must have been held (${JSON.stringify(pair[0])})`);
    assert.ok(app.some((attempt) => readOutcome(attempt) === 'complete'), `the application's own read must be complete (${JSON.stringify(app)})`);
    assert.ok(snapshot.verdict.commitPath.applied >= 1, `the application read must have committed the deep link (${snapshot.verdict.line})`);
    assert.ok(routeLog.some((entry) => entry.held), `the marked read must have reached the route handler (${JSON.stringify(routeLog)})`);
    assert.deepEqual(errors.slice(before), [], 'the reverse scene must not raise page errors');
    return `held=${pair[0].id} body@+${pair[0].bodyAt} vs twin=${pair[1].id} body@+${pair[1].bodyAt} — issued first, completed last`;
  });

  // The real same-identity commit on the UI path: activating the row of the note that is already
  // the committed document runs `openNote()` again, so `commitOpen()` applies a second time without
  // the identity moving. The pre-fix verdict saw a single identity transition and could only say
  // "the committed identity never changed" — never "committed twice".
  await check('explorer reveal #476 commit path: re-opening the current note commits the same identity again and the window records both commits', async () => {
    const before = beforeErrors();
    await ensureDesktop();
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${otherNote}"]`);
    await timeline.runWindow('same-identity commit', { budgetMs: 8000 }, async () => {
      await page.goto(deepLink);
      await waitForCommittedDocument('same-identity commit', 8000);
      await page.waitForSelector(targetRow, { timeout: 8000 });
      await page.locator(targetRow).click({ timeout: 8000 });
      await page.waitForFunction((note) => {
        const probe = window.__revealTimelineProbe;
        return Boolean(probe) && probe.entries.filter((entry) => entry.phase === 'app-commit-render' && entry.path === note).length >= 2;
      }, notePath, { timeout: 8000 });
    });
    const snapshot = await timeline.snapshot();
    const { verdict } = snapshot;
    await fs.writeFile(path.join(outputRoot, 'reveal-commit-same-identity.json'), JSON.stringify(snapshot, null, 2));
    assert.equal(verdict.kind, 'committed', `both commits apply and the document stays committed (${verdict.line})`);
    assert.equal(verdict.commitPath.applied, 2, `the window must record two applied commits, not one identity change (${verdict.line})`);
    assert.ok(verdict.commitPath.routeWrites >= 2, `the route write must happen for both commits (${JSON.stringify(verdict.commitPath)})`);
    assert.equal(verdict.finalIdentity, notePath, `the final UI identity is the deep link (${verdict.line})`);
    // The falsified reading, made explicit: the identity moved exactly once, yet the commit path ran
    // twice. "The DOM identity never changed" is not "the commit never applied".
    const toTarget = verdict.identityTransitions.filter((transition) => transition.value === notePath).length;
    assert.equal(toTarget, 1, `the identity reaches the target once (${JSON.stringify(verdict.identityTransitions)})`);
    assert.deepEqual(errors.slice(before), [], 'the same-identity scene must not raise page errors');
    return `applied=${verdict.commitPath.applied}, identity transitions=${verdict.identityTransitions.length} (target reached once)`;
  });

  // Commit, then switch away: the pre-fix verdict returned plain `committed` and could not say that
  // the committed document had been superseded.
  await check('explorer reveal #476 commit path: a target commit that is later superseded is reported as superseded, with the final identity', async () => {
    const before = beforeErrors();
    await ensureDesktop();
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${otherNote}"]`);
    await timeline.runWindow('committed then superseded', { budgetMs: 8000 }, async () => {
      await page.goto(deepLink);
      await waitForCommittedDocument('committed then superseded', 8000);
      await page.locator(`.note[title="${otherNote}"]`).click({ timeout: 8000 });
      await page.waitForFunction((other) => document.querySelector('#current-path')?.textContent === other, otherNote, { timeout: 8000 });
    });
    const snapshot = await timeline.snapshot();
    const { verdict } = snapshot;
    await fs.writeFile(path.join(outputRoot, 'reveal-commit-superseded.json'), JSON.stringify(snapshot, null, 2));
    assert.equal(verdict.kind, 'committed-superseded', `the target commit was superseded (${verdict.line})`);
    assert.equal(verdict.commitPath.applied, 1, `exactly one target commit happened (${verdict.line})`);
    assert.equal(verdict.finalIdentity, otherNote, `the final identity is the other note (${verdict.line})`);
    assert.ok(verdict.commits.some((commit) => commit.path === otherNote), `the superseding commit is on the record (${JSON.stringify(verdict.commits)})`);
    assert.deepEqual(errors.slice(before), [], 'the superseded scene must not raise page errors');
    return `${verdict.line} | applied=${verdict.commitPath.applied} final=${verdict.finalIdentity}`;
  });

  // The window-ownership regression, and the controlled failure that proves the artifact lands: the
  // deep link's read is held past the window budget, so the check under observation fails; the
  // window artifact is written *before* the window is reset, and the phases that arrive afterwards
  // are reported as late from the older window instead of completing the new window's read.
  await check('explorer reveal #476 windows: a controlled re-open failure lands its whole timeline before the reset, and a late response is never adopted by the next window', async () => {
    const before = beforeErrors();
    await ensureDesktop();
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${otherNote}"]`);
    let hits = 0;
    const handler = async (route) => {
      const requested = new URL(route.request().url()).searchParams.get('path');
      if (requested !== notePath) return void route.continue().catch(() => {});
      hits += 1;
      // Longer than the window budget below, short enough to land inside the *next* window.
      if (hits === 1) await sleep(4500);
      return void route.continue().catch(() => {});
    };
    await page.route(noteRoute, handler);
    try {
      let failure = null;
      try {
        await timeline.runWindow('re-open (controlled failure)', { budgetMs: 900 }, async () => {
          await page.goto(deepLink);
          await waitForCommittedDocument('re-open (controlled failure)', 900);
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, 'the controlled failure must fail the scene (the deep link cannot open inside 900 ms)');
      assert.ok(failure.revealArtifact, `the failing window must have written its artifact (${failure.message})`);
      const artifact = JSON.parse(await fs.readFile(failure.revealArtifact, 'utf8'));
      await fs.writeFile(path.join(outputRoot, 'reveal-window-failure-summary.json'), JSON.stringify({
        artifact: failure.revealArtifact,
        error: artifact.error,
        verdict: artifact.timeline.verdict.line,
        entries: artifact.timeline.entries.length,
        finalState: artifact.finalState,
      }, null, 2));
      assert.ok(artifact.error.message.includes('never became the committed document'), `the artifact must carry the original error (${JSON.stringify(artifact.error)})`);
      assert.ok(artifact.timeline.entries.length > 0, 'the artifact must carry the window timeline, not just a summary');
      assert.equal(artifact.timeline.verdict.kind, 'in-flight', `the failing window must be named in flight (${artifact.timeline.verdict.line})`);
      assert.ok(artifact.finalState, 'the artifact must carry the final state read in the page');
      assert.ok(failure.message.includes(failure.revealArtifact), `the failure message must point at the artifact (${failure.message})`);
      // Now let the held read answer inside the *next* window and confirm it is reported as late.
      await timeline.runWindow('after the controlled failure', { budgetMs: 6000 }, async () => {
        await sleep(4600);
      });
      const snapshot = await timeline.snapshot();
      await fs.writeFile(path.join(outputRoot, 'reveal-window-late-response.json'), JSON.stringify(snapshot, null, 2));
      const late = snapshot.crossWindow.filter((entry) => entry.phase !== 'request' && entry.phase !== 'fetch-request');
      assert.ok(late.length > 0, `the late phases of the failed window must be reported, not dropped (${JSON.stringify(snapshot.crossWindow)})`);
      assert.ok(late.every((entry) => entry.windowSeq !== snapshot.windowSeq), `every late phase must carry its own window identity (${JSON.stringify(snapshot.crossWindow)})`);
      // The falsified reading: those phases as part of the *new* window's read. Every attempt of
      // the new window must be one of the new window's own reads.
      const staleIds = new Set(snapshot.crossWindow.map((entry) => `${entry.source}:${entry.requestId ?? entry.fetchSeq}`));
      for (const attempt of [...snapshot.verdict.app, ...snapshot.verdict.http]) {
        assert.ok(!staleIds.has(`${attempt.source}:${attempt.id}`), `a read of an earlier window must never appear as this window's read (${JSON.stringify(attempt)})`);
      }
      // Window ownership is per recorder: a navigation restarts the page-side counter at 0, while the
      // harness counter keeps counting across the whole run.
      const stalePage = snapshot.windowSeqs.page;
      const staleHarness = snapshot.windowSeqs.harness;
      assert.ok(snapshot.entries.every((entry) => (entry.source === 'page'
        ? entry.windowSeq == null || entry.windowSeq === stalePage
        : entry.windowSeq == null || entry.windowSeq === staleHarness)), 'no entry of the current window may carry another window\'s identity');
      assert.equal(hits >= 1, true, 'the held read must have been issued in the failed window');
      assert.deepEqual(errors.slice(before), [], 'the window scene must not raise page errors');
      return `artifact=${failure.revealArtifact}; late phases=${late.length}; new window attempts=${snapshot.verdict.app.length + snapshot.verdict.http.length}`;
    } finally {
      await page.unroute(noteRoute, handler);
    }
  });
}
