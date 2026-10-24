// R476-fix (#468 diagnosis): the request-correlated timeline for a deep-link reveal failure.
//
// Why the shipped observer cannot decide a failure
// ------------------------------------------------
// `attachLegacyNoteWatch()` below is the pre-R476 observer, kept verbatim as the *paired control*.
// Its install point is measured, not assumed: in every scene probed the deep note's boot read is
// issued *after* `page.goto()` returned (the read depends on the vaults read, which the app issues
// before `load`), so the shipped observer does see the request. What it cannot report is:
//
//   1. where the read stopped — it records `request` / `response <status>` / `failed <err>` and
//      nothing else: no response-body completion, no `/api/web/v1/vaults` timeline and no
//      application commit event, so a 200 that was never committed reads exactly like a healthy
//      200 (see the pinned paired readings in `reveal-injections.mjs`);
//   2. anything at all for a read the application answers inside the page (the `uncommitted`
//      injection): a network-level observer records no request and prints the same text as a scene
//      that never issued one.
//
// What this module records, per window
// ------------------------------------
//   * the harness half of every note / vaults / tree read, keyed by a per-request `requestId` and
//     stamped with the `windowSeq` the request was issued in, with `request` ->
//     `response-headers` -> `response-body-complete` (via `Response.finished()`) and
//     `request-failed`;
//   * the page half (`reveal-page-hook.mjs`): the application's own `fetch` call site keyed by
//     `fetchSeq`, the application's route commits with their committed `{path, vaultId}` state, and
//     the `applyOpenCommit()` breadcrumb renders;
//   * the install ordering — when the recorder and the page hook were in place versus when the
//     first tracked read was issued — so "this observer saw the whole scene" is a reading rather
//     than an assumption;
//   * the window each entry belongs to. A phase that lands after the next `begin()` is reported in
//     `crossWindow`, never as this window's read.
//
// `classifyNoteRead()` (in `reveal-attempts.mjs`) turns the record into the one-line verdict the
// failure messages carry. Read-only by construction: `window.fetch` and
// `History.prototype.pushState / replaceState` are wrapped and their arguments forwarded unchanged,
// and the breadcrumb is observed with a MutationObserver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { NOTE_API_PATH, VAULTS_API_PATH, TREE_API_PATH, BODY_FAMILIES, displayPath, familyOf, isTargetNoteUrl } from './reveal-urls.mjs';
import { pageTimelineHook } from './reveal-page-hook.mjs';
import { belongsToWindow, classifyNoteRead } from './reveal-attempts.mjs';

export { NOTE_API_PATH, VAULTS_API_PATH, TREE_API_PATH, familyOf, isTargetNoteUrl, displayPath, classifyNoteRead };
export { classifyNoteRead as classifyRevealWindow };

// A window records a handful of reads; the cap only bounds a pathological page that hammers the
// tree API, and it is per window so a bounded scene never loses its own history.
const MAX_ENTRIES = 400;

// The pre-R476 observer, verbatim, kept as the *paired control* that measures what the new
// timeline adds (the injection checks in `reveal-injections.mjs` attach it at the shipped install
// point: after the navigation, for the deep note only).
export function attachLegacyNoteWatch(page, notePath) {
  const log = [];
  const started = new Map();
  const matches = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.pathname === NOTE_API_PATH && parsed.searchParams.get('path') === notePath;
    } catch { return false; }
  };
  const onRequest = (request) => {
    if (!matches(request.url())) return;
    started.set(request, Date.now());
    log.push({ phase: 'request' });
  };
  const onResponse = (response) => {
    const request = response.request();
    if (!matches(request.url())) return;
    log.push({ phase: 'response', status: response.status(), ms: Date.now() - (started.get(request) ?? Date.now()) });
  };
  const onFailed = (request) => {
    if (!matches(request.url())) return;
    log.push({ phase: 'failed', failure: request.failure()?.errorText ?? '?', ms: Date.now() - (started.get(request) ?? Date.now()) });
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  return {
    text: () => (log.length
      ? log.map((entry) => `${entry.phase}${entry.status ? ` ${entry.status}` : ''}${entry.failure ? ` ${entry.failure}` : ''}${entry.ms != null ? ` (${entry.ms} ms)` : ''}`).join(' -> ')
      : `no ${NOTE_API_PATH} read for the deep note`),
    dispose: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
    },
  };
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'window';
}

export async function attachRevealTimeline(page, { notePath, budgetMs = 8000, outputRoot = null }) {
  const state = {
    notePath,
    budgetMs,
    defaultBudgetMs: budgetMs,
    label: null,
    windowSeq: 0,
    requestSeq: 0,
    t0: Date.now(),
    entries: [],
    marks: [],
    active: true,
    attachedAt: Date.now(),
    firstTrackedAt: null,
    offset: 0,
  };
  // Keyed by the Playwright request object, which is the harness's own identity for a read: the
  // response and the body completion of a request can only ever be found through this map, never
  // through "the most recent request on this path".
  const started = new Map();
  const push = (entry) => {
    if (!state.active) return;
    if (state.entries.length >= MAX_ENTRIES) return;
    state.entries.push({ at: Date.now(), source: 'harness', ...entry });
  };
  const noteTarget = (url) => isTargetNoteUrl(url, notePath);
  const onRequest = (request) => {
    const family = familyOf(request.url());
    if (!family) return;
    const at = Date.now();
    const requestId = (state.requestSeq += 1);
    const windowSeq = state.windowSeq;
    const path = displayPath(request.url());
    const targetNote = noteTarget(request.url());
    started.set(request, { at, path, targetNote, requestId, windowSeq });
    if (state.firstTrackedAt === null) state.firstTrackedAt = at;
    push({ phase: 'request', windowSeq, requestId, family, method: request.method(), path, targetNote });
  };
  const onResponse = (response) => {
    const request = response.request();
    const family = familyOf(request.url());
    if (!family) return;
    // A response whose request was missed still gets an identity of its own, and is marked as
    // unmatched: it is never merged into another read.
    const known = started.get(request) ?? {
      at: Date.now(), path: displayPath(request.url()), targetNote: noteTarget(request.url()),
      requestId: (state.requestSeq += 1), windowSeq: state.windowSeq, unmatchedRequest: true,
    };
    const at = Date.now();
    push({
      phase: 'response-headers', windowSeq: known.windowSeq, requestId: known.requestId, family,
      status: response.status(), ms: at - known.at, path: known.path, targetNote: known.targetNote,
      unmatchedRequest: known.unmatchedRequest ?? false,
    });
    if (!BODY_FAMILIES.has(family)) return;
    // `finished()` resolves when the body is fully received (or with the transport error):
    // recording headers alone was one of the gaps this module closes.
    response.finished().then((error) => {
      push({
        phase: error ? 'response-body-failed' : 'response-body-complete',
        windowSeq: known.windowSeq, requestId: known.requestId, family, status: response.status(),
        ms: Date.now() - known.at, path: known.path, targetNote: known.targetNote, error: error ?? null,
      });
    }).catch(() => {});
  };
  const onFailed = (request) => {
    const family = familyOf(request.url());
    if (!family) return;
    const known = started.get(request) ?? {
      at: Date.now(), path: displayPath(request.url()), targetNote: noteTarget(request.url()),
      requestId: (state.requestSeq += 1), windowSeq: state.windowSeq, unmatchedRequest: true,
    };
    push({
      phase: 'request-failed', windowSeq: known.windowSeq, requestId: known.requestId, family,
      failure: request.failure()?.errorText ?? '?', ms: Date.now() - known.at, path: known.path,
      targetNote: known.targetNote, unmatchedRequest: known.unmatchedRequest ?? false,
    });
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  await page.addInitScript(pageTimelineHook, { notePath });

  const readProbe = async () => {
    try {
      return await page.evaluate(() => {
        const probe = window.__revealTimelineProbe;
        if (!probe) return null;
        return {
          installAt: probe.installAt, patchAt: probe.patchAt, firstFetchAt: probe.firstFetchAt,
          windowSeq: probe.windowSeq, fetchSeq: probe.fetchSeq, identity: probe.identity,
          commitRenders: probe.commitRenders, entries: probe.entries.slice(-400),
        };
      });
    } catch { return null; }
  };
  // The state the failure message must carry: the identity the page actually shows, read in the
  // page, in one frame.
  const readFinalState = async () => {
    try {
      return await page.evaluate(() => {
        const node = document.querySelector('#current-path');
        return {
          currentPath: node ? node.textContent ?? null : null,
          breadcrumbTitle: node ? node.title || null : null,
          href: location.href,
          welcomeVisible: Boolean(document.querySelector('.welcome')),
          noteListPresent: Boolean(document.querySelector('#note-list')),
        };
      });
    } catch (error) {
      return { unreadable: String(error && error.message ? error.message : error) };
    }
  };

  const timeline = {
    notePath,
    attachedAt: state.attachedAt,
    // Start a scene window. Called *before* the navigation under observation, which is the whole
    // point: the recorder and the page hook are in place when the boot fires. The window counter is
    // bumped here and in the page hook, so every entry issued from now on is identifiable as this
    // window's — including a phase that lands after the next window opened.
    async begin(label, { budgetMs: windowBudget } = {}) {
      state.windowSeq += 1;
      state.label = label;
      state.budgetMs = windowBudget ?? state.defaultBudgetMs;
      state.entries = [];
      state.marks = [];
      state.firstTrackedAt = null;
      state.active = true;
      state.t0 = Date.now();
      try {
        const before = Date.now();
        const pageNow = await page.evaluate(() => Date.now());
        const after = Date.now();
        state.offset = pageNow - Math.round((before + after) / 2);
        await page.evaluate(() => {
          const probe = window.__revealTimelineProbe;
          if (!probe) return;
          probe.entries.length = 0;
          probe.windowSeq += 1;
          probe.fetchSeq = 0;
        });
      } catch { /* navigating: the new document starts a fresh probe */ }
      return state.t0;
    },
    get windowSeq() { return state.windowSeq; },
    mark(name) {
      state.marks.push({ name, at: Date.now(), rel: Date.now() - state.t0 });
    },
    async snapshot({ budgetMs: override } = {}) {
      const probe = await readProbe();
      const pageWindow = probe ? probe.windowSeq : null;
      const stamped = [...state.entries, ...(probe?.entries ?? []).map((entry) => ({ ...entry, at: entry.at - state.offset }))]
        .map((entry, index) => ({ ...entry, rel: Math.round(entry.at - state.t0), _index: index }))
        .sort((a, b) => a.at - b.at || a._index - b._index)
        .map(({ _index, ...entry }) => entry);
      const isCurrent = (entry) => belongsToWindow(entry, entry.source === 'page' ? pageWindow : state.windowSeq);
      const entries = stamped.filter(isCurrent);
      const crossWindow = stamped.filter((entry) => !isCurrent(entry));
      const budget = override ?? state.budgetMs;
      const finalState = await readFinalState();
      const firstRead = entries.find((entry) => entry.phase === 'request' || entry.phase === 'fetch-request') ?? null;
      const installProof = {
        recorderAttachedAt: state.attachedAt,
        firstTrackedRequestAt: state.firstTrackedAt,
        // The ordering claim covers both recorders: the harness recorder was live and the page
        // hook was patched before the document issued its first tracked read.
        recorderAttachedBeforeFirstRequest: firstRead === null ? null : state.attachedAt < firstRead.at,
        pageHookInstallAt: probe ? probe.installAt - state.offset : null,
        pageFetchPatchAt: probe ? probe.patchAt - state.offset : null,
        pageFirstFetchAt: probe?.firstFetchAt != null ? probe.firstFetchAt - state.offset : null,
        pagePatchBeforeFirstFetch: probe && probe.firstFetchAt != null ? probe.patchAt < probe.firstFetchAt : null,
      };
      return {
        label: state.label,
        notePath,
        windowSeq: state.windowSeq,
        // The two recorders count their own windows: a navigation gives the new document a fresh
        // page-side counter at 0, so a page entry's window identity is comparable only with the
        // page's own counter. Both are reported so nothing has to be inferred.
        windowSeqs: { harness: state.windowSeq, page: pageWindow },
        budgetMs: budget,
        windowMs: Date.now() - state.t0,
        marks: state.marks.map((mark) => ({ ...mark })),
        installProof,
        finalState,
        finalIdentity: probe ? probe.identity : null,
        verdict: classifyNoteRead(entries, { notePath, budgetMs: budget, finalIdentity: probe ? probe.identity : null }),
        crossWindow: crossWindow.map((entry) => ({
          rel: entry.rel, source: entry.source, phase: entry.phase, windowSeq: entry.windowSeq,
          requestId: entry.requestId ?? null, fetchSeq: entry.fetchSeq ?? null, path: entry.path ?? null,
        })),
        entries,
      };
    },
    // The one line every failure message carries, plus the time-ordered record behind it. The
    // artifact holds the whole timeline; the message stays bounded so a CI log stays readable.
    async text({ budgetMs: override, maxEntries = 14 } = {}) {
      const snapshot = await this.snapshot({ budgetMs: override });
      const lines = [
        `verdict[${snapshot.label}]: ${snapshot.verdict.line}`,
        `verdict[${snapshot.label}] vaults: ${snapshot.verdict.vaults}`,
        `install: recorder attached ${snapshot.installProof.recorderAttachedBeforeFirstRequest ? 'before' : 'AFTER'} the first tracked read`
          + `${snapshot.installProof.pagePatchBeforeFirstFetch != null ? `; page fetch hook patched before the document's first tracked fetch: ${snapshot.installProof.pagePatchBeforeFirstFetch}` : ''}`,
        `final state: ${JSON.stringify(snapshot.finalState)}`,
        `timeline (${snapshot.entries.length} entries; ${snapshot.crossWindow.length} late from an earlier window; full record in the window artifact):`,
      ];
      for (const entry of snapshot.entries.slice(-maxEntries)) {
        lines.push(`  +${String(entry.rel).padStart(6)} ms [${entry.source}] ${entry.phase}`
          + `${entry.family ? ` ${entry.family}` : ''}${entry.status ? ` ${entry.status}` : ''}${entry.failure ? ` ${entry.failure}` : ''}`
          + `${entry.bytes != null ? ` ${entry.bytes}B` : ''}${entry.name ? ` ${entry.name}` : ''}`
          + `${entry.value ? ` ${JSON.stringify(entry.value)}` : ''}`
          + `${entry.committedPath ? ` path=${JSON.stringify(entry.committedPath)}` : ''}`
          + `${entry.phase === 'app-commit-render' && entry.path ? ` path=${JSON.stringify(entry.path)}` : ''}`
          + `${entry.href ? ` ${entry.href}` : ''}${entry.path ? ` ${entry.path}` : ''}`);
      }
      for (const entry of snapshot.crossWindow.slice(-4)) {
        lines.push(`  +${String(entry.rel).padStart(6)} ms [${entry.source}] ${entry.phase} LATE from window #${entry.windowSeq}`);
      }
      return lines.join('\n');
    },
    async writeArtifact(outputRoot, name) {
      const snapshot = await this.snapshot();
      await fs.mkdir(outputRoot, { recursive: true });
      const file = path.join(outputRoot, name);
      await fs.writeFile(file, JSON.stringify(snapshot, null, 2));
      return file;
    },
    // The failure path: the whole window, the final state and the original error are written
    // *before* the window is reset or the next navigation starts. A failure that only printed a
    // summary plus the last N events lost the history the next occurrence would need.
    async writeFailure(outputRoot, label, error) {
      const snapshot = await this.snapshot();
      await fs.mkdir(outputRoot, { recursive: true });
      const file = path.join(outputRoot, `reveal-timeline-${slug(label)}-failure.json`);
      await fs.writeFile(file, JSON.stringify({
        label,
        error: { message: error?.message ?? String(error), stack: error?.stack ?? null },
        finalState: snapshot.finalState,
        finalIdentity: snapshot.finalIdentity,
        crossWindow: snapshot.crossWindow,
        timeline: snapshot,
      }, null, 2));
      return file;
    },
    // One scene window: `begin()`, the body, and — if the body throws — the window artifact before
    // the error is re-thrown to the check that owns the assertion. The artifact path is appended to
    // the message so a red CI log names the file that carries the whole window.
    async runWindow(label, options, body) {
      await this.begin(label, options);
      try {
        return await body();
      } catch (error) {
        const file = await this.writeFailure(outputRoot ?? path.join(process.cwd(), '.reveal-evidence'), label, error)
          .catch(() => null);
        error.revealArtifact = file;
        if (file) error.message = `${error.message} [window artifact: ${file}]`;
        throw error;
      }
    },
    dispose() {
      state.active = false;
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
    },
  };
  return timeline;
}
