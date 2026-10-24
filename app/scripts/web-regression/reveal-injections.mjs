// R476-fix (#468 diagnosis): the controlled fault injections that give the timeline's readings
// their discriminating power, each paired with the shipped post-navigation observer as the control.
//
// Kept in its own module for the 500-line architecture budget (the instrument and its verdict live
// in `reveal-diagnostics.mjs` / `reveal-attempts.mjs`, the commit-path scenes in
// `reveal-commit-scenes.mjs`).
//
// What the pairing is — and is not
// --------------------------------
// The review seat's first hypothesis was that the shipped observer is blind because it is
// installed *after* the navigation. That was measured and it is false for this scene: in every
// scene below the boot's note read is issued *after* the vaults read answered, so it lands after
// `page.goto()` returned and the shipped observer sees it. The seat accepted that correction and
// restricted it to what is measurable: the old observer's gap is the body/commit stage, and the
// 0/10 natural runs do **not** disprove that a historical occurrence issued its read elsewhere.
// The pins below therefore keep the old observer's vocabulary per class (`legacyReading`) and the
// new timeline must (a) name the class with its own read identity and (b) carry the phase / body /
// commit facts the old reading lacks. For the `uncommitted` class the old observer is blind in the
// strict sense: the read is answered inside the page, so a network-level observer records nothing
// and prints the same text as a scene in which no read was ever issued.
//
// Two fault families, two fault surfaces
// --------------------------------------
//   * `/api/web/v1/note` (the deep link's own read) — `network` faults are applied with
//     `page.route`: delay, HTTP 500, transport abort; the `uncommitted` class uses a page-side stub
//     that answers 200 with a whole body *after* the read was superseded.
//   * `/api/web/v1/vaults` (the boot read every note read depends on) — delay, HTTP 503, abort and
//     a page-side **body stall** (headers answered, body never completes). The stall is the only
//     surface that can distinguish "the answer arrived" from "the body arrived": a network-level
//     observer has no way to hold a body open, and the application's own `fetch` view is where the
//     difference is visible.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { attachLegacyNoteWatch, NOTE_API_PATH, VAULTS_API_PATH } from './reveal-diagnostics.mjs';

export const REVEAL_INJECTION_MARKER = 'r476-superseded-read';
export const VAULTS_STALL_MARKER = 'r476-vaults-body-stall';
export const NOTE_ROUTE = new RegExp(`${NOTE_API_PATH.replace(/\//g, '\\/')}\\?`);
export const VAULTS_ROUTE = new RegExp(`${VAULTS_API_PATH.replace(/\//g, '\\/')}`);
export const LEGACY_BLIND_TEXT = `no ${NOTE_API_PATH} read for the deep note`;

// Each spec drives one class deterministically and states what BOTH instruments must read:
//   * `legacyReading` — the shipped observer's text, pinned to what it is able to say;
//   * `expect.kind` / `expect.verdict` — the verdict of the injected family (the note read for
//     `family: 'note'`, the vaults boot read for `family: 'vaults'`);
//   * `expect.app` / `expect.http` — the facts each recorder must hold for the faulted read, with
//     `'absent'` meaning "that recorder cannot see this read at all" (a page-side stub issues no
//     HTTP request; a network fault is invisible to a stub). Both are asserted, because the two
//     recorders are kept separate on purpose: merging them is what the review seat falsified.
export const REVEAL_INJECTIONS = [
  {
    id: 'delay',
    name: 'explorer reveal #476 delay: a boot read still in flight at the budget is named in flight, not as a stall',
    family: 'note',
    note: { kind: 'hold', ms: 3000 },
    budgetMs: 1200,
    expect: {
      kind: 'in-flight',
      verdict: /STILL IN FLIGHT/,
      app: { status: null, headers: false, body: false },
      http: { status: null, headers: false, body: false },
    },
    legacyReading: /^request$/,
    legacyCannot: 'no outcome at all: cannot tell "the answer is still pending" from "the request was never issued" or from a read that was answered and then dropped',
  },
  {
    id: 'failure',
    name: 'explorer reveal #476 failure: a 5xx boot read is named with its status and the missing commit',
    family: 'note',
    note: { kind: 'status', status: 500, ms: 0 },
    budgetMs: 2000,
    expect: {
      kind: 'failed-status',
      verdict: /HTTP 500/,
      app: { status: 500, headers: true, body: true },
      http: { status: 500, headers: true, body: true },
    },
    legacyReading: /^request -> response 500 \(\d+ ms\)$/,
    legacyCannot: 'names the status but nothing about the document: "500" is the same reading whether the app retried, recovered or stayed on the previous document, and it carries no commit state',
  },
  {
    id: 'abort',
    name: 'explorer reveal #476 abort: an aborted boot read is named as a transport failure, not as a stall',
    family: 'note',
    note: { kind: 'abort', ms: 0 },
    budgetMs: 2000,
    expect: {
      kind: 'transport-failed',
      verdict: /ERR_FAILED/,
      app: { status: null, headers: false, body: false, failure: /TypeError|AbortError/ },
      http: { status: null, headers: false, body: false, failure: /ERR_FAILED/ },
    },
    legacyReading: /^request -> failed net::ERR_FAILED \(\d+ ms\)$/,
    legacyCannot: 'names the transport failure but not its effect: the same reading covers an aborted navigation, a superseded refresh or a retried read, and it carries no commit state',
  },
  {
    id: 'uncommitted',
    name: 'explorer reveal #476 uncommitted: a 200 read with a complete body whose commitOpen was never applied is named as uncommitted',
    family: 'note',
    note: { kind: 'stub-200', ms: 2000 },
    budgetMs: 3500,
    supersede: true,
    via: 'page',
    marker: REVEAL_INJECTION_MARKER,
    expect: {
      kind: 'uncommitted',
      verdict: /no commitOpen for the target was observed/,
      app: { status: 200, headers: true, body: true },
      http: 'absent',
      commitPath: { applied: 0, completedWithoutCommit: 1 },
    },
    legacyReading: new RegExp(`^${LEGACY_BLIND_TEXT.replace(/[/.]/g, '\\$&')}$`),
    legacyCannot: 'nothing: the read is answered inside the page, so a network-level observer records no request at all and prints the same text as a scene with no read',
  },
  // The vaults family: the boot read every note read depends on. A fault here is *not* visible in
  // the note verdict's kind (the note read never happens), so the contrast is the point: the note
  // line says "absent in this window" and the vaults line names the fault.
  {
    id: 'vaults-delay',
    name: 'explorer reveal #476 vaults delay: a vaults boot read still in flight is named in flight and the note read is reported as absent in the window',
    family: 'vaults',
    vaults: { kind: 'hold', ms: 3000 },
    budgetMs: 1200,
    expect: {
      kind: 'in-flight',
      verdict: /STILL IN FLIGHT/,
      app: { status: null, headers: false, body: false },
      http: { status: null, headers: false, body: false },
      noteKind: 'absent',
    },
    legacyReading: new RegExp(`^${LEGACY_BLIND_TEXT.replace(/[/.]/g, '\\$&')}$`),
    legacyCannot: 'the shipped observer watches the note read only: a boot that never gets a vault list produces the same text as a boot whose note read was never issued',
  },
  {
    id: 'vaults-failure',
    name: 'explorer reveal #476 vaults failure: a 503 vaults boot read is named with its status and the note read is reported as absent in the window',
    family: 'vaults',
    vaults: { kind: 'status', status: 503, ms: 0 },
    budgetMs: 2000,
    expect: {
      kind: 'failed-status',
      verdict: /HTTP 503/,
      app: { status: 503, headers: true, body: true },
      http: { status: 503, headers: true, body: true },
      noteKind: 'absent',
    },
    legacyReading: new RegExp(`^${LEGACY_BLIND_TEXT.replace(/[/.]/g, '\\$&')}$`),
    legacyCannot: 'no vaults timeline at all: "the note never opened" and "the vault list never answered" are the same reading',
  },
  {
    id: 'vaults-abort',
    name: 'explorer reveal #476 vaults abort: an aborted vaults boot read is named as a transport failure and the note read is reported as absent in the window',
    family: 'vaults',
    vaults: { kind: 'abort', ms: 0 },
    budgetMs: 2000,
    expect: {
      kind: 'transport-failed',
      verdict: /ERR_FAILED/,
      app: { status: null, headers: false, body: false, failure: /TypeError|AbortError/ },
      http: { status: null, headers: false, body: false, failure: /ERR_FAILED/ },
      noteKind: 'absent',
    },
    legacyReading: new RegExp(`^${LEGACY_BLIND_TEXT.replace(/[/.]/g, '\\$&')}$`),
    legacyCannot: 'no vaults timeline at all: an aborted vault list read is indistinguishable from a stall',
  },
  {
    id: 'vaults-body-stall',
    name: 'explorer reveal #476 vaults body stall: headers answered with a body that never completes is named body-incomplete, not as a stall or a status',
    family: 'vaults',
    via: 'page',
    marker: VAULTS_STALL_MARKER,
    budgetMs: 2000,
    expect: {
      kind: 'body-incomplete',
      verdict: /BODY did not complete/,
      app: { status: 200, headers: true, body: false },
      // The stall is synthesized inside the page: there is no HTTP request for a network-level
      // recorder to see. That asymmetry is the reason both recorders are kept.
      http: 'absent',
      noteKind: 'absent',
    },
    legacyReading: new RegExp(`^${LEGACY_BLIND_TEXT.replace(/[/.]/g, '\\$&')}$`),
    legacyCannot: 'no vaults timeline at all: "200 headers arrived and the body never came" is invisible to a network observer before the body completes',
  },
];

// The page-side stub for the `uncommitted` class: a 200 answer with a COMPLETE body for the
// deep-linked note, delivered late enough that the application has already superseded the read —
// so `session.commitOpen()` refuses it (`stale-request`) while the read itself looks healthy.
// Registered once and inert unless the scene's URL carries the marker, so it cannot leak into any
// other check on the shared page. (Controlled injection, not instrumentation.)
//
// ORDERING: this must be registered BEFORE `attachRevealTimeline()`. Both are document-start
// scripts and each wraps `window.fetch`; the last one registered wraps the first, so registering
// the stub first lets the timeline wrap the stub and observe the synthesized 200 + body. With the
// opposite order the timeline sees nothing for the target read and the verdict degenerates to
// `request-absent` — measured, see the HANDOFF.
export async function installSupersededReadStub(page, { notePath }) {
  await page.addInitScript(({ marker, target }) => {
    const nativeFetch = window.fetch;
    window.fetch = function revealSupersededRead(...args) {
      const raw = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (!location.search.includes(marker)) return nativeFetch.apply(this, args);
      let parsed = null;
      try { parsed = new URL(raw, location.origin); } catch { return nativeFetch.apply(this, args); }
      if (parsed.pathname !== '/api/web/v1/note' || parsed.searchParams.get('path') !== target) return nativeFetch.apply(this, args);
      const payload = JSON.stringify({ content: '# injected stub\n', revision: 'injected-stub', path: target, vaultId: null, route: location.pathname });
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })), 2000);
      });
    };
  }, { marker: REVEAL_INJECTION_MARKER, target: notePath });
}

// The page-side stub for the `vaults-body-stall` class: a 200 whose headers arrive immediately and
// whose body stream is never closed, so the application's `await response.json()` never settles.
export async function installVaultsBodyStallStub(page) {
  await page.addInitScript(({ marker, path: vaultsPath }) => {
    const nativeFetch = window.fetch;
    window.fetch = function revealVaultsBodyStall(...args) {
      const raw = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (!location.search.includes(marker)) return nativeFetch.apply(this, args);
      let parsed = null;
      try { parsed = new URL(raw, location.origin); } catch { return nativeFetch.apply(this, args); }
      if (parsed.pathname !== vaultsPath) return nativeFetch.apply(this, args);
      // Headers now, body never: a ReadableStream that keeps the connection open.
      const body = new ReadableStream({ start() { /* never enqueue, never close */ } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  }, { marker: VAULTS_STALL_MARKER, path: VAULTS_API_PATH });
}

function faultFor(spec) {
  return spec.family === 'note' ? spec.note : spec.vaults;
}

// One injection scene with BOTH instruments on it: the new timeline (installed before the
// navigation) and the shipped observer, installed at its shipped point (after `page.goto()`
// returned).
export async function runInjectionScene({
  page, base, deepLink, notePath, timeline, spec, waitForCommittedDocument, errors, sleep,
}) {
  const before = errors ? errors.length : 0;
  const undo = [];
  const fault = faultFor(spec);
  const target = spec.marker
    ? `${deepLink}${deepLink.includes('?') ? '&' : '?'}${spec.marker}=1`
    : deepLink;
  await page.goto(`${base}/app`);
  await page.waitForSelector('.note[title="A.md"]');
  // The window's budget is the scene's wait contract: the verdict the check compares against the
  // failure message must be computed at the same budget the wait used.
  await timeline.begin(spec.id, { budgetMs: spec.budgetMs });
  if (spec.via !== 'page') {
    const route = spec.family === 'note' ? NOTE_ROUTE : VAULTS_ROUTE;
    const handler = async (pageRoute) => {
      if (spec.family === 'note') {
        const requested = new URL(pageRoute.request().url()).searchParams.get('path');
        if (requested !== notePath) return void pageRoute.continue().catch(() => {});
      }
      if (fault.ms) await sleep(fault.ms);
      if (fault.kind === 'abort') return void pageRoute.abort('failed').catch(() => {});
      if (fault.kind === 'status') {
        return void pageRoute.fulfill({
          status: fault.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: `injected ${fault.status}` }),
        }).catch(() => {});
      }
      return void pageRoute.continue().catch(() => {});
    };
    await page.route(route, handler);
    undo.push(() => page.unroute(route, handler));
  }
  try {
    await page.goto(target);
    timeline.mark('goto-returned');
    // The shipped install point, faithfully: after the navigation resolved.
    const legacy = attachLegacyNoteWatch(page, notePath);
    timeline.mark('legacy-installed');
    if (spec.supersede) {
      await page.waitForSelector('.note[title="A.md"]', { state: 'attached', timeout: 7000 });
      await page.locator('.note[title="A.md"]').click({ timeout: 7000 });
      timeline.mark('superseded');
    }
    let message = null;
    try {
      await waitForCommittedDocument(spec.id, spec.budgetMs);
    } catch (error) {
      message = error.message;
    }
    const legacyText = legacy.text();
    legacy.dispose();
    const snapshot = await timeline.snapshot();
    return { spec, message, legacyText, snapshot, verdict: snapshot.verdict, pageErrors: errors ? errors.slice(before) : [] };
  } finally {
    for (const restore of undo.reverse()) await restore().catch(() => {});
  }
}

// The permanent regressions. For each class the check asserts BOTH readings on the same scene:
//   * the timeline names the class with the injected family's own verdict and carries the phases
//     of both recorders (`expect.app` / `expect.http`);
//   * the shipped observer's reading is the pinned one (`legacyReading`) — recorded, so a change
//     in the app's request/answer pattern cannot silently pass as "the control is still blind".
// The ordering facts (`installProof`) are asserted because they are the reason the timeline is
// allowed to speak about boot reads at all.
export async function registerRevealInjectionChecks({
  check, page, base, deepLink, notePath, outputRoot, errors, ensureDesktop, timeline, waitForCommittedDocument, sleep,
}) {
  for (const spec of REVEAL_INJECTIONS) {
    // Awaited on purpose: every scene drives the shared page, so an un-awaited registration runs
    // the scenes concurrently and each `page.goto()` aborts the previous one. (That is the
    // `net::ERR_ABORTED` the first local run of this file produced.)
    await check(spec.name, async () => {
      await ensureDesktop();
      const result = await runInjectionScene({
        page, base, deepLink, notePath, timeline, spec, waitForCommittedDocument, errors, sleep,
      });
      const { verdict, snapshot } = result;
      const view = spec.family === 'note'
        ? { kind: verdict.kind, line: verdict.line, app: verdict.app, http: verdict.http, outcomes: verdict.outcomes }
        : {
          kind: verdict.vaultsVerdict.kind,
          line: verdict.vaultsVerdict.line,
          app: verdict.vaultsVerdict.app,
          http: verdict.vaultsVerdict.http,
          outcomes: verdict.vaultsVerdict.outcomes,
        };
      await fs.mkdir(outputRoot, { recursive: true });
      await fs.writeFile(
        path.join(outputRoot, `reveal-timeline-injection-${spec.id}.json`),
        JSON.stringify({
          spec: {
            ...spec,
            expect: {
              ...spec.expect,
              verdict: String(spec.expect.verdict),
              app: spec.expect.app === 'absent' ? 'absent' : { ...spec.expect.app, failure: String(spec.expect.app.failure ?? '') },
              http: spec.expect.http === 'absent' ? 'absent' : { ...spec.expect.http, failure: String(spec.expect.http.failure ?? '') },
            },
            legacyReading: String(spec.legacyReading),
          },
          paired: {
            legacyReading: result.legacyText,
            legacyCannot: spec.legacyCannot,
            timelineKind: view.kind,
            timelineLine: view.line,
            noteLine: verdict.line,
            vaultsLine: verdict.vaults,
          },
          message: result.message,
          timeline: snapshot,
        }, null, 2),
      );
      assert.ok(result.message, `${spec.id}: the injected read must keep the deep link from committing (${view.line})`);
      assert.ok(result.message.includes(view.line), `${spec.id}: the failure message must carry the timeline verdict, got: ${result.message}`);
      assert.equal(view.kind, spec.expect.kind, `${spec.id}: wrong verdict kind (${view.line})`);
      assert.match(view.line, spec.expect.verdict, `${spec.id}: the verdict must name this class (${view.line})`);
      if (spec.family === 'vaults') {
        assert.equal(verdict.kind, spec.expect.noteKind, `${spec.id}: the note read cannot have run while the vaults boot read is faulty (${verdict.line})`);
      }
      // The paired control: the shipped observer's reading, pinned per class.
      assert.match(result.legacyText, spec.legacyReading, `${spec.id}: the shipped observer must read this class as recorded (${result.legacyText})`);
      // Both recorders, separately: a read the page-side stub answers has no HTTP request, and a
      // network fault is invisible to a stub. Each side is asserted against its own expectation.
      for (const key of ['app', 'http']) {
        const expected = spec.expect[key];
        const attempts = view[key];
        if (expected === 'absent') {
          assert.equal(attempts.length, 0, `${spec.id}: the ${key} recorder must hold no attempt for a read it cannot see (${JSON.stringify(attempts)})`);
          continue;
        }
        assert.ok(attempts.length >= 1, `${spec.id}: the ${key} recorder must hold the injected read (${JSON.stringify(view.outcomes)})`);
        const latest = attempts[attempts.length - 1];
        assert.equal(latest.status ?? null, expected.status, `${spec.id}: wrong ${key} read status (${JSON.stringify(latest)})`);
        assert.equal(latest.headersAt != null, expected.headers, `${spec.id}: ${key} response headers must ${expected.headers ? '' : 'not '}be part of the record (${JSON.stringify(latest)})`);
        assert.equal(latest.bodyAt != null, expected.body, `${spec.id}: ${key} body completion must ${expected.body ? '' : 'not '}be part of the record (${JSON.stringify(latest)})`);
        if (expected.failure) {
          assert.match(String(latest.failure ?? ''), expected.failure, `${spec.id}: the ${key} transport failure must be recorded (${JSON.stringify(latest)})`);
        }
      }
      // The read identity: every attempt carries the identity of the recorder that produced it, so
      // a completion can only ever be attributed to the request it was recorded on.
      for (const attempt of [...view.app, ...view.http]) {
        assert.ok(attempt.id != null, `${spec.id}: every attempt needs its recorder's own read identity (${JSON.stringify(attempt)})`);
      }
      // The commit-path vocabulary: the injected class must carry the observation counts, and the
      // wording must report what was *observed* rather than asserting that a commit never happened.
      assert.ok(verdict.commitPath, `${spec.id}: the verdict must carry the commit-path vocabulary (${view.line})`);
      assert.match(verdict.line, /commitOpen|no commit/, `${spec.id}: the note verdict must state what was observed about the commit (${verdict.line})`);
      assert.doesNotMatch(verdict.line, /NEVER applied|never changed/, `${spec.id}: an unobserved commit must not be reported as a commit that never happened (${verdict.line})`);
      if (spec.expect.commitPath) {
        assert.equal(verdict.commitPath.applied, spec.expect.commitPath.applied, `${spec.id}: wrong applied-commit count (${JSON.stringify(verdict.commitPath)})`);
        assert.equal(verdict.commitPath.completedWithoutCommit, spec.expect.commitPath.completedWithoutCommit, `${spec.id}: wrong completed-without-commit count (${JSON.stringify(verdict.commitPath)})`);
      }
      // The vaults timeline is part of the record for every class: a scene that fails while the
      // vault list never answered is a different failure than one that failed after a healthy boot.
      const vaults = snapshot.entries.filter((entry) => entry.family === 'vaults');
      if (spec.family === 'note') {
        assert.ok(vaults.some((entry) => entry.phase === 'request'), `${spec.id}: the vaults timeline must hold the boot read (${verdict.vaults})`);
        assert.ok(vaults.some((entry) => entry.phase === 'response-headers'), `${spec.id}: the vaults boot read must be answered in the record (${verdict.vaults})`);
      }
      // Ordering: the recorder and the page hook are in place before the document issues its first
      // tracked read — the property that lets the timeline speak about boot reads.
      assert.equal(snapshot.installProof.recorderAttachedBeforeFirstRequest, true, `${spec.id}: the recorder must be attached before the boot read (${JSON.stringify(snapshot.installProof)})`);
      assert.equal(snapshot.installProof.pagePatchBeforeFirstFetch, true, `${spec.id}: the page hook must precede the document's first tracked fetch (${JSON.stringify(snapshot.installProof)})`);
      if (spec.family === 'note') {
        // The shipped install point is recorded on the same axis as the boot read (the reading the
        // seat asked for); it is a measurement, not an assumption.
        const legacyMark = snapshot.marks.find((mark) => mark.name === 'legacy-installed');
        // The boot read of the deep note as *either* recorder saw it: a page-side stub answers inside
        // the page and issues no HTTP request, which is why the search covers both phases.
        const firstNote = snapshot.entries.find((entry) => (entry.phase === 'request' || entry.phase === 'fetch-request') && entry.targetNote === true);
        assert.ok(legacyMark, `${spec.id}: the shipped install point must be marked on the timeline`);
        assert.ok(firstNote, `${spec.id}: the boot note read must be on the timeline`);
        assert.deepEqual(result.pageErrors, [], `${spec.id}: the injection must not raise page errors (${view.line})`);
        return `${view.line} | shipped observer: ${result.legacyText} | shipped install @+${legacyMark.rel} ms vs boot note read @+${firstNote.rel} ms`;
      }
      assert.deepEqual(result.pageErrors, [], `${spec.id}: the injection must not raise page errors (${view.line})`);
      return `${view.line} | shipped observer: ${result.legacyText}`;
    });
  }
}
