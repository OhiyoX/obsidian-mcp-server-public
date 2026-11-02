// Issue #336 (real Chromium): the page-side state reader and the settle predicate for the
// reveal geometry checks.
//
// Extracted from `explorer-reveal.mjs` for the 500-line architecture budget, unchanged: the read
// and the judgment must happen in the page, in one frame, because a read taken from the harness
// between two application rebuilds can observe a cleared listing or an identity the application has
// not committed yet.
export function installRevealProbe(page, { ancestors, note }) {
  return page.addInitScript(({ chain, target }) => {
    // Observe every `scrollIntoView` the app performs. The first-paint checks assert the
    // current note row IS scrolled; the flat/publish-filter checks assert it is NOT. This is
    // independent of list geometry, so it stays true when an anchor window happens to place
    // the row near the top.
    window.__revealScrollCalls = [];
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(...args) {
      window.__revealScrollCalls.push({ path: this.dataset?.path ?? null, cls: this.className });
      return originalScrollIntoView.apply(this, args);
    };
    // Mirror of the app's own SSE subscription (`features/sync/live-events.js`) without
    // touching it: every `vault.resync` frame rebuilds the Explorer, so the frame count
    // belongs in a failure diagnosis.
    window.__revealResyncFrames = 0;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener('vault.resync', () => { window.__revealResyncFrames += 1; });
      }
    };
    window.__revealReadState = () => {
      const list = document.querySelector('#note-list');
      const levels = [];
      if (list) {
        for (const wrap of list.querySelectorAll('.tree-folder-row[data-folder-path]')) {
          const children = wrap.nextElementSibling;
          const box = children?.classList.contains('tree-children') ? children : null;
          levels.push({
            path: wrap.dataset.folderPath,
            expanded: wrap.querySelector('.tree-folder')?.getAttribute('aria-expanded') === 'true',
            rows: box ? box.children.length : -1,
            loading: box ? Boolean(box.querySelector('.empty')) : false,
            retry: box ? Boolean(box.querySelector('.tree-load-error')) : false,
          });
        }
      }
      const row = list ? [...list.querySelectorAll('.note[data-path]')].find((node) => node.dataset.path === target) : null;
      const listRect = list?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const clientHeight = list ? Math.round(list.clientHeight) : null;
      const rowOffsetTop = row?.offsetTop ?? null;
      // `rowHeight` was read by the geometry assertions below but never collected by the state
      // reader, so `aboveFold`/`belowFold` were silently always false and the settle condition
      // degenerated to "the list scrolled". Collect it and decide the fold here.
      const rowHeight = rowRect ? Math.round(rowRect.height) : null;
      const measurable = rowOffsetTop !== null && rowHeight !== null && clientHeight !== null;
      const currentPath = document.querySelector('#current-path')?.textContent ?? null;
      const welcome = document.querySelector('.welcome');
      return {
        currentPath,
        document: {
          committed: currentPath === target,
          welcomeVisible: Boolean(welcome) && (welcome.getBoundingClientRect().height ?? 0) > 0,
          tabs: [...document.querySelectorAll('#document-tabs .document-tab')].map((tab) => tab.getAttribute('data-tab-path')),
        },
        levels,
        note: {
          present: Boolean(row),
          ariaCurrent: row?.getAttribute('aria-current') ?? null,
          scrollTop: list ? Math.round(list.scrollTop) : null,
          scrollHeight: list ? Math.round(list.scrollHeight) : null,
          clientHeight,
          rowOffsetTop,
          rowHeight,
          inViewport: Boolean(rowRect && listRect) ? rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1 : null,
          aboveFold: measurable && rowOffsetTop + rowHeight <= clientHeight + 1,
          belowFold: measurable && rowOffsetTop + rowHeight > clientHeight + 1,
        },
        resyncFrames: window.__revealResyncFrames ?? 0,
        scrollCalls: (window.__revealScrollCalls ?? []).map((call) => call.path).filter(Boolean),
      };
    };
    // The settle predicate: the committed identity, the whole ancestor chain and the row
    // geometry, judged in the same frame as the read. Returns the state or null.
    window.__revealSettled = () => {
      const state = window.__revealReadState();
      if (!state.document.committed) return null;
      if (!state.note.present || state.note.inViewport !== true) return null;
      if (!(state.note.scrollTop > 0 || state.note.aboveFold === true)) return null;
      const byPath = new Map(state.levels.map((level) => [level.path, level]));
      for (const ancestor of chain) {
        const level = byPath.get(ancestor);
        if (!level || !level.expanded || !(level.rows > 0) || level.retry) return null;
      }
      if (state.levels.some((level) => level.expanded && level.rows === 0 && !level.loading && !level.retry)) return null;
      return state;
    };
  }, { chain: ancestors, target: note });
}
