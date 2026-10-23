// R476-fix (#468 diagnosis): the document-start half of the reveal timeline.
//
// This module exists on its own because its main export is *serialized into the document* by
// `page.addInitScript` — nothing inside it may reference module scope — and because the three
// facts the review seat falsified live here:
//
//   1. **request identity.** Every phase of a read carries the identity of the read it belongs to
//      (`fetchSeq` here, `requestId` in the harness recorder). The pre-fix instrument had no such
//      identity for page-side phases: it matched a `fetch-response` to the most recent
//      `fetch-request` on the same path, so a completion of read #1 was attributed to read #2
//      whenever #2 was issued before #1 answered.
//   2. **window identity.** Every entry carries the window it was *issued* in (`windowSeq`), set
//      at `fetch-request` / `pushState` time and copied to every later phase of that read. A
//      response that lands after the next window opened therefore cannot be read as part of the
//      new window (the pre-fix recorder pushed it into whatever window was open).
//   3. **commit evidence from the commit path, not from a text transition.** The application's
//      own commit is observed on two surfaces that change on *every* applied commit:
//      `History.prototype.pushState/replaceState` carry the committed route state
//      (`{kind, index, vaultId, path, documentKind}`), and `#current-path` is re-rendered by
//      `applyOpenCommit()` → `pathBreadcrumb.render(result.path)`, which calls
//      `host.replaceChildren()` and re-sets `title` even when the rendered path is unchanged.
//      The pre-fix observer only watched for a *change* of `#current-path`'s text, so a
//      same-identity commit (the session reports `applied: true`, the UI identity does not move)
//      read as "the commit never applied", and a commit that was later superseded still read as
//      "committed".
//
// Everything here is read-only: the wrappers forward their arguments unchanged and add no header,
// no body and no behaviour to any application request. The `fetch` wrapper only *clones* the
// response body of the note/vaults families so a body that never completes stays measurable.
export function pageTimelineHook({ notePath, maxEntries = 400 }) {
  const probe = {
    installAt: Date.now(),
    patchAt: null,
    firstFetchAt: null,
    // `windowSeq` is bumped by the harness on every `begin()`. Entries record the value that was
    // current when their read was *issued*, so a late phase is identifiable as late.
    windowSeq: 0,
    fetchSeq: 0,
    identity: null,
    commitRenders: 0,
    entries: [],
  };
  window.__revealTimelineProbe = probe;
  const record = (entry) => {
    if (probe.entries.length < maxEntries) probe.entries.push(entry);
  };
  const classify = (input) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    let parsed = null;
    try { parsed = new URL(raw, location.origin); } catch { return null; }
    const family = parsed.pathname === '/api/web/v1/note' ? 'note'
      : parsed.pathname === '/api/web/v1/vaults' ? 'vaults'
        : parsed.pathname === '/api/web/v2/tree' ? 'tree' : null;
    if (!family) return null;
    return {
      family,
      path: `${parsed.pathname}${parsed.search}`,
      targetNote: family === 'note' && parsed.searchParams.get('path') === notePath,
    };
  };

  const nativeFetch = window.fetch;
  window.fetch = function revealDiagnosticsFetch(...args) {
    const target = classify(args[0]);
    if (!target) return nativeFetch.apply(this, args);
    const at = Date.now();
    const fetchSeq = (probe.fetchSeq += 1);
    const windowSeq = probe.windowSeq;
    // The identity of this read, copied to every later phase. Only literals may be referenced
    // here: this function is serialized into the document, so module constants are NOT in scope.
    const context = { at, source: 'page', windowSeq, fetchSeq, ...target };
    if (probe.firstFetchAt === null) probe.firstFetchAt = at;
    record({ ...context, phase: 'fetch-request' });
    let pending;
    try {
      pending = nativeFetch.apply(this, args);
    } catch (error) {
      record({ ...context, at: Date.now(), phase: 'fetch-threw', error: String((error && error.name) || error) });
      throw error;
    }
    return pending.then((response) => {
      record({ ...context, at: Date.now(), phase: 'fetch-response', status: response.status, ms: Date.now() - at });
      // Body completion as the *application* sees it. `clone()` leaves the application its own
      // stream, so a body that never completes is exactly the reading we want to keep.
      const bodyFamily = target.family === 'note' || target.family === 'vaults';
      if (bodyFamily && response.body) {
        response.clone().text().then(
          (text) => record({
            ...context, at: Date.now(), phase: 'fetch-body-complete',
            status: response.status, bytes: text.length, ms: Date.now() - at,
          }),
          (error) => record({
            ...context, at: Date.now(), phase: 'fetch-body-failed',
            status: response.status, error: String((error && error.name) || error), ms: Date.now() - at,
          }),
        );
      }
      return response;
    }, (error) => {
      record({
        ...context, at: Date.now(), phase: 'fetch-rejected',
        name: String((error && error.name) || error), ms: Date.now() - at,
      });
      throw error;
    });
  };
  probe.patchAt = Date.now();

  // The application's route commit. `bindDocumentNavigation().commit()` writes the committed
  // identity into the history entry (`{kind: "obsidianWebNavigation", index, vaultId, path,
  // documentKind, fragment}`), and it does so through `replaceState` too — a same-identity commit
  // re-enters the same URL. Reading the state object is therefore the app's own commit record,
  // not an inference from the URL text or from the DOM.
  for (const name of ['pushState', 'replaceState']) {
    const native = History.prototype[name];
    History.prototype[name] = function revealDiagnosticsHistory(...args) {
      const result = native.apply(this, args);
      const state = args[0] && typeof args[0] === 'object' ? args[0] : null;
      record({
        at: Date.now(),
        source: 'page',
        windowSeq: probe.windowSeq,
        phase: 'app-route-commit',
        mode: name === 'pushState' ? 'push' : 'replace',
        href: String(args[2] ?? ''),
        committedPath: state && typeof state.path === 'string' ? state.path : null,
        committedVaultId: state && state.vaultId != null ? String(state.vaultId) : null,
        committedKind: state && typeof state.documentKind === 'string' ? state.documentKind : null,
        historyKind: state && typeof state.kind === 'string' ? state.kind : null,
      });
      return result;
    };
  }

  // The breadcrumb half of the same commit: `applyOpenCommit()` renders `result.path` into
  // `#current-path` on every applied commit. `render()` re-creates the children and re-sets
  // `title`, so the mutation is observable even when the rendered path does not change.
  const readIdentity = () => {
    const node = document.querySelector('#current-path');
    return node ? node.textContent ?? null : null;
  };
  let hostNode = null;
  const tickIdentity = () => {
    const value = readIdentity();
    if (value === probe.identity) return;
    const first = probe.identity === null;
    probe.identity = value;
    record({
      at: Date.now(), source: 'page', windowSeq: probe.windowSeq,
      phase: first ? 'app-identity-initial' : 'app-identity', value,
    });
  };
  const recordRender = () => {
    const node = hostNode ?? document.querySelector('#current-path');
    if (!node) return;
    // `pathBreadcrumb.render(path)` sets `title = path` and renders that same path as chips, so
    // `textContent === title` identifies the breadcrumb render. The Base-document path label is
    // written directly (`document-kind.js`) without a matching `title`, and an empty render drops
    // the title: neither is a note commit.
    const path = node.title || null;
    const rendered = node.textContent ?? null;
    if (path === null || rendered !== path) {
      tickIdentity();
      return;
    }
    probe.commitRenders += 1;
    record({
      at: Date.now(), source: 'page', windowSeq: probe.windowSeq,
      phase: 'app-commit-render', path, rendered,
    });
    tickIdentity();
  };
  // Two observers, and the narrow one does the steady-state work. The breadcrumb element is
  // created once and never replaced (`core/app.js` queries `#current-path` at boot and
  // `createPathBreadcrumb` only writes into it), so the wide discovery observer exists for at most
  // the first frames and is disconnected as soon as the element is found: after that, this hook
  // costs one callback per breadcrumb write instead of one per document mutation. A document-wide
  // observer with `characterData` on the shared page adds a callback batch to every unrelated,
  // mutation-heavy scene (the table and editor checks), which is exactly the footprint the seat
  // asked to keep bounded.
  const commitObserver = new MutationObserver(() => recordRender());
  const observeHost = (node) => {
    hostNode = node;
    tickIdentity();
    commitObserver.observe(hostNode, {
      childList: true, characterData: true, attributes: true, attributeFilter: ['title'],
    });
  };
  const discoveryObserver = new MutationObserver(() => {
    if (hostNode) return;
    const node = document.querySelector('#current-path');
    if (!node) return;
    discoveryObserver.disconnect();
    observeHost(node);
  });
  const start = () => {
    const node = document.querySelector('#current-path');
    if (node) {
      observeHost(node);
      return;
    }
    discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
