// R476-fix (#468 diagnosis): the verdict half of the timeline.
//
// The pre-fix verdict merged the two recorders into a single attempt list by *path plus 30 ms of
// time proximity* and then handed each later phase to the attempt of the same path that most
// recently preceded it. The review seat falsified that in two independent ways:
//
//   * a real Chromium scene in which read #1 (issued at +6 ms) completed while read #2 (issued at
//     +110 ms) was still in flight was reported as "#2 completed, uncommitted" — the completion of
//     #1 was attributed to #2;
//   * a pure sequence in which two independent requests for the same path were issued 10 ms apart
//     was *merged into one* attempt, so "how many reads happened" was not even answerable.
//
// This module therefore never invents an identity. A read is identified by the identity its own
// recorder gave it — `fetchSeq` on the page (the application's `fetch` call site) and `requestId`
// in the harness (the Playwright request object) — and each phase is attached to exactly that read.
// The two recorders are kept as **separate views** (`app` and `http`) rather than merged: the page
// stream is the application's own view of the read, the harness stream is the transport's, and the
// two do not have to contain the same reads at all (a page-side stub issues no HTTP request; a
// stub that issues two native fetches produces two HTTP requests for one application read).
// Merging them was the defect; reporting both, with an explicit disagreement flag, is the fix.
//
// Commit evidence comes from the application's commit path, not from "the DOM text moved": each
// `app-commit-render` is an `applyOpenCommit()` → `pathBreadcrumb.render(result.path)` call (which
// re-renders even for an unchanged path) and each `app-route-commit` is
// `bindDocumentNavigation().commit()`'s history write carrying the committed
// `{path, vaultId, documentKind}`. The pre-fix verdict could not tell "not committed" from
// "committed and then superseded" from "committed again with the same identity", because an
// unchanged identity produced no event at all.
import { NOTE_API_PATH, VAULTS_API_PATH } from './reveal-urls.mjs';

// Per family. The primary view is the application's own `fetch` call site: the question a reveal
// failure asks ("did the document become the committed one") is about what the application got,
// and the harness view is the transport's corroboration of it.
const VIEWS = [
  { key: 'app', source: 'page', idKey: 'fetchSeq' },
  { key: 'http', source: 'harness', idKey: 'requestId' },
];

export function buildAttempts(entries, { family, notePath = null, source, idKey }) {
  const byId = new Map();
  const attempts = [];
  for (const entry of entries) {
    if (entry.source !== source) continue;
    if (entry.family !== family) continue;
    if (family === 'note' && entry.targetNote !== true) continue;
    const id = entry[idKey];
    if (id == null) continue;
    let attempt = byId.get(id);
    if (!attempt) {
      attempt = {
        source, id, seq: attempts.length, path: entry.path, at: entry.at, rel: entry.rel,
        requestAt: null, headersAt: null, status: null, bodyAt: null, bytes: null,
        bodyError: null, failure: null, failedAt: null, phases: [],
      };
      byId.set(id, attempt);
      attempts.push(attempt);
    }
    attempt.phases.push(entry.phase);
    if (entry.rel != null && attempt.rel == null) attempt.rel = entry.rel;
    if (entry.phase === 'request' || entry.phase === 'fetch-request') {
      attempt.requestAt = entry.rel;
      attempt.at = entry.at;
    }
    if (entry.phase === 'response-headers' || entry.phase === 'fetch-response') {
      attempt.status = entry.status;
      attempt.headersAt = entry.rel;
    }
    if (entry.phase === 'response-body-complete' || entry.phase === 'fetch-body-complete') {
      attempt.bodyAt = entry.rel;
      if (entry.bytes != null) attempt.bytes = entry.bytes;
    }
    if (entry.phase === 'response-body-failed' || entry.phase === 'fetch-body-failed') {
      attempt.bodyError = entry.error ?? true;
    }
    if (entry.phase === 'request-failed') {
      attempt.failure = entry.failure ?? '?';
      attempt.failedAt = entry.rel;
    }
    if (entry.phase === 'fetch-rejected') {
      attempt.failure = attempt.failure ?? entry.name ?? 'fetch-rejected';
      attempt.failedAt = attempt.failedAt ?? entry.rel;
    }
    if (entry.phase === 'fetch-threw') {
      attempt.failure = attempt.failure ?? entry.error ?? 'fetch-threw';
      attempt.failedAt = attempt.failedAt ?? entry.rel;
    }
  }
  return attempts;
}

// Window ownership: an entry belongs to this window only when the window it was *issued* in is the
// current one. `reveal-page-hook.mjs` and the harness recorder both stamp every phase with the
// window of the read it belongs to, so a response that lands after the next `begin()` keeps the
// identity of its own window and can never be attributed to the new window's read. An entry
// without a stamp (a document-start marker) is treated as this window's.
export function belongsToWindow(entry, windowSeq) {
  if (entry.windowSeq == null || windowSeq == null) return true;
  return entry.windowSeq === windowSeq;
}

// One read's outcome class, from the facts of that read alone.
export function readOutcome(attempt) {
  if (!attempt) return 'absent';
  if (attempt.failure) return 'transport-failed';
  if (typeof attempt.status === 'number' && attempt.status >= 400) return 'failed-status';
  if (attempt.headersAt == null) return 'in-flight';
  if (attempt.bodyAt == null) return 'body-incomplete';
  return 'complete';
}

export function attemptShape(attempt) {
  if (!attempt) return 'no read';
  const head = `read @${attempt.rel >= 0 ? '+' : ''}${attempt.rel} ms`;
  if (attempt.failure) {
    return `${head} FAILED with ${attempt.failure}${attempt.failedAt != null ? ` @+${attempt.failedAt} ms` : ''}`;
  }
  if (attempt.headersAt == null) return `${head}, no response headers in the window`;
  const body = attempt.bodyAt != null
    ? `, body complete @+${attempt.bodyAt} ms${attempt.bytes != null ? ` (${attempt.bytes} bytes)` : ''}`
    : ', body did not complete in the window';
  return `${head}, headers ${attempt.status ?? '?'} @+${attempt.headersAt} ms${body}`;
}

export function familyViews(entries, { family, notePath = null }) {
  const views = {};
  for (const view of VIEWS) {
    views[view.key] = buildAttempts(entries, { family, notePath, source: view.source, idKey: view.idKey });
  }
  const primaryKey = views.app.length ? 'app' : (views.http.length ? 'http' : 'app');
  const appLatest = views.app[views.app.length - 1] ?? null;
  const httpLatest = views.http[views.http.length - 1] ?? null;
  const appOutcome = readOutcome(appLatest);
  const httpOutcome = readOutcome(httpLatest);
  return {
    app: views.app,
    http: views.http,
    primary: views[primaryKey],
    primarySource: primaryKey,
    appLatest,
    httpLatest,
    appOutcome,
    httpOutcome,
    // The two recorders must agree on the latest read's class; when they do not, the verdict says
    // so instead of quietly preferring one. (`absent` on one side is a real disagreement: a
    // page-side stub issues no HTTP request at all, which is a *reading*, not a defect.)
    viewsDisagree: views.app.length > 0 && views.http.length > 0 && appOutcome !== httpOutcome,
  };
}

// Both recorders' reading of the injected class, failure text included: the application sees a
// rejected `fetch` (`TypeError`), the transport sees `net::ERR_FAILED`, and both are evidence.
function viewsText(views) {
  const one = (key, outcome, latest) => `${key}: ${outcome}${latest?.failure ? ` ${latest.failure}` : ''}`;
  return `[${one('app', views.appOutcome, views.appLatest)}; ${one('http', views.httpOutcome, views.httpLatest)}]`;
}

function readLine(label, views, budgetMs) {
  const latest = views.primary[views.primary.length - 1] ?? null;
  const outcome = readOutcome(latest);
  const both = viewsText(views);
  if (outcome === 'absent') {
    return `${label} read ABSENT in this window (budget +${budgetMs} ms): no read of this family was issued here — `
      + 'a read issued before the window opened is not counted, so this is "not observed in the window", not "never issued"';
  }
  if (outcome === 'transport-failed') return `${label} read FAILED with ${latest.failure}: ${attemptShape(latest)} ${both}`;
  if (outcome === 'failed-status') return `${label} read answered HTTP ${latest.status}: ${attemptShape(latest)} ${both}`;
  if (outcome === 'in-flight') {
    return `${label} read STILL IN FLIGHT at the +${budgetMs} ms budget: ${attemptShape(latest)} ${both}`;
  }
  if (outcome === 'body-incomplete') {
    return `${label} read status ${latest.status} @+${latest.headersAt} ms but the response BODY did not complete `
      + `within the +${budgetMs} ms budget: ${attemptShape(latest)} ${both}`;
  }
  return `${label} read status ${latest.status} @+${latest.headersAt} ms with a COMPLETE body`
    + `${latest.bytes != null ? ` (${latest.bytes} bytes)` : ''} @+${latest.bodyAt} ms ${both}`;
}

export function familyVerdict(entries, { family, notePath = null, budgetMs, label = family }) {
  const views = familyViews(entries, { family, notePath });
  const latest = views.primary[views.primary.length - 1] ?? null;
  return {
    family,
    kind: readOutcome(latest),
    line: readLine(label, views, budgetMs),
    latest,
    app: views.app,
    http: views.http,
    primarySource: views.primarySource,
    viewsDisagree: views.viewsDisagree,
    outcomes: { app: views.appOutcome, http: views.httpOutcome },
  };
}

// The application's commit events, in time order, with the identity each one committed.
export function commitEvidence(entries, { notePath }) {
  const events = [
    ...entries
      .filter((entry) => entry.phase === 'app-commit-render')
      .map((entry) => ({ at: entry.at, rel: entry.rel, source: 'breadcrumb', path: entry.path, mode: null })),
    ...entries
      .filter((entry) => entry.phase === 'app-route-commit' && entry.historyKind === 'obsidianWebNavigation')
      .map((entry) => ({ at: entry.at, rel: entry.rel, source: 'route', path: entry.committedPath, mode: entry.mode })),
  ].sort((left, right) => left.at - right.at);
  const identities = entries.filter((entry) => entry.phase === 'app-identity' || entry.phase === 'app-identity-initial');
  const renders = events.filter((event) => event.source === 'breadcrumb' && event.path === notePath);
  const routes = events.filter((event) => event.source === 'route' && event.path === notePath);
  return {
    events,
    forTarget: events.filter((event) => event.path === notePath),
    // One `app-commit-render` is exactly one `applyOpenCommit()`: that count is the number of
    // commits the application actually applied to the target, whether or not the identity moved.
    renders,
    routes,
    identityTransitions: identities.map((entry) => ({ rel: entry.rel, value: entry.value })),
  };
}

function commitWhere(event) {
  if (!event) return 'nowhere';
  return `${event.source === 'route' ? `route ${event.mode}` : 'breadcrumb render'} @+${event.rel} ms`;
}

export function classifyNoteRead(entries, { notePath, budgetMs, finalIdentity = null }) {
  const note = familyVerdict(entries, { family: 'note', notePath, budgetMs, label: 'note' });
  const vaults = familyVerdict(entries, { family: 'vaults', budgetMs, label: 'vaults' });
  const commits = commitEvidence(entries, { notePath });
  const targetCommits = commits.forTarget;
  const lastTarget = commits.renders[commits.renders.length - 1] ?? targetCommits[targetCommits.length - 1] ?? null;
  const superseding = lastTarget
    ? commits.events.find((event) => event.at > lastTarget.at && event.path && event.path !== notePath) ?? null
    : null;
  const appliedText = lastTarget
    ? `commitOpen applied for the target ${commits.renders.length}× (last ${commitWhere(lastTarget)}${commits.routes.length ? `, route ${commits.routes[commits.routes.length - 1].mode} @+${commits.routes[commits.routes.length - 1].rel} ms` : ''})`
    : 'no commitOpen for the target was observed in this window';
  const commitPath = {
    attempted: { app: note.app.length, http: note.http.length },
    applied: commits.renders.length,
    routeWrites: commits.routes.length,
    // Reads whose body completed and after which no target commit was observed. The instrument
    // reports the *observation*; the application's own reason ("stale-request", "local-edit") is
    // measured separately against the real session (`reveal-commit-scenes.mjs`), because it is not
    // visible from outside the page.
    completedWithoutCommit: note.app.filter((attempt) => readOutcome(attempt) === 'complete'
      && !commits.renders.some((event) => event.at >= attempt.at)).length,
  };
  const base = {
    commits: commits.events.map((event) => ({
      rel: event.rel, source: event.source, path: event.path, mode: event.mode,
    })),
    identityTransitions: commits.identityTransitions,
    commitPath,
    attempts: note.app,
    app: note.app,
    http: note.http,
    primarySource: note.primarySource,
    viewsDisagree: note.viewsDisagree,
    outcomes: note.outcomes,
    vaults: vaults.line,
    vaultsVerdict: vaults,
    finalIdentity,
    budgetMs,
  };
  const shape = note.line;
  if (note.kind !== 'complete') {
    const absentWithCommit = note.kind === 'request-absent' && lastTarget
      ? `; a commit for the target was still observed (${commitWhere(lastTarget)}) — the read itself happened outside this window`
      : '';
    return { ...base, kind: note.kind, line: `${shape}; ${appliedText}${absentWithCommit}; final UI identity ${JSON.stringify(finalIdentity)}` };
  }
  if (!lastTarget) {
    return {
      ...base,
      kind: 'uncommitted',
      line: `${shape}, yet no commitOpen for the target was observed within the +${budgetMs} ms budget `
        + `(${commitPath.attempted.app} application read(s), ${commitPath.applied} applied commit(s), final UI identity ${JSON.stringify(finalIdentity)}). `
        + 'This is what the window observed: an unobserved commit is not evidence that a commit never happened.',
    };
  }
  const superseded = Boolean(superseding) || (finalIdentity != null && finalIdentity !== notePath);
  if (superseded) {
    const by = superseding
      ? `${commitWhere(superseding)} committed ${JSON.stringify(superseding.path)}`
      : `the final UI identity is ${JSON.stringify(finalIdentity)}`;
    return {
      ...base,
      kind: 'committed-superseded',
      line: `${shape}; commitOpen applied for the target ${commitWhere(lastTarget)}, but the committed document was superseded: ${by}`,
    };
  }
  return {
    ...base,
    kind: 'committed',
    line: `${shape}; commitOpen applied for the target ${commitWhere(lastTarget)}; final UI identity ${JSON.stringify(finalIdentity)}`,
  };
}

export const REVEAL_PATHS = { NOTE_API_PATH, VAULTS_API_PATH };
