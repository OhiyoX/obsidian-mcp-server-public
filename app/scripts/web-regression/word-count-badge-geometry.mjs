// Word-count badge geometry: the DOM read the browser checks share and the placement contract
// they assert (issue #430 shipped bottom-left; issue #469 / U57 moved it to the bottom-right).
//
// Extracted from `word-count-badge.mjs` so that scenario keeps one cohesive job (the count
// lifecycle matrix) and stays inside the repository's line budget. This module is a helper,
// never a registered scene: `scripts/web-regression.mjs` imports scenarios explicitly.
import assert from 'node:assert/strict';

// Small geometry tolerance: sub-pixel layout rounding only, never a licence to drift.
export const GEOMETRY_TOLERANCE_PX = 2;

// The right-aligned placement contract (#469): the badge sits in a 20px right inset (the 12px
// scrollbar gutter the reading/editing surface reserves + an 8px visible inset) and must clear
// the live scrollbar gutter by at least 4px. The band is asserted with the tolerance above, so a
// left-aligned badge (the pre-#469 geometry) fails it instead of passing a looser "is somewhere
// near the bottom" check.
export const BADGE_RIGHT_INSET_PX = 20;
export const BADGE_SCROLLBAR_CLEARANCE_PX = 4;

/** The scrollbar gutter the *visible* scroll owner reserves on its own right edge. */
export const visibleGutter = (snapshot) => {
  const surface = snapshot.preview && snapshot.preview.offsetWidth > 0 ? snapshot.preview : snapshot.scroller;
  if (!surface) return 0;
  return Math.max(0, surface.offsetWidth - surface.clientWidth);
};

/**
 * Assert the #469 right-edge relationship: a 20px right inset, clearance from the measured
 * scrollbar gutter, and no return to the left edge.
 */
export const assertRightAligned = (snapshot, label) => {
  const inset = snapshot.docRect.right - snapshot.rect.right;
  const gutter = visibleGutter(snapshot);
  assert.ok(
    Math.abs(inset - BADGE_RIGHT_INSET_PX) <= GEOMETRY_TOLERANCE_PX,
    `${label}: the badge must sit at the right edge with a ${BADGE_RIGHT_INSET_PX}px inset (got ${inset}px)`,
  );
  assert.ok(
    inset >= gutter + BADGE_SCROLLBAR_CLEARANCE_PX,
    `${label}: the badge must clear the ${gutter}px scrollbar gutter by ${BADGE_SCROLLBAR_CLEARANCE_PX}px (got ${inset}px)`,
  );
  assert.ok(
    snapshot.rect.left - snapshot.docRect.left >= 24,
    `${label}: the badge must not be left-aligned (left inset ${snapshot.rect.left - snapshot.docRect.left}px)`,
  );
};

/**
 * Read the badge, its document pane, the scroll owners, the last rendered line and the docked
 * rail in one page round trip. `present: false` when either element is missing.
 */
export const readBadgeSnapshot = (page, selector) => page.evaluate((badgeSelector) => {
  const el = document.querySelector(badgeSelector);
  const doc = document.querySelector('.document');
  if (!el || !doc) return { present: false };
  window.__u52Badge = window.__u52Badge || el;
  const rect = el.getBoundingClientRect();
  const docRect = doc.getBoundingClientRect();
  const charactersNode = el.querySelector('.word-count-badge-characters');
  const preview = document.querySelector('#preview');
  const editor = document.querySelector('#editor');
  let lastLineBottom = null;
  if (preview && !preview.hidden) {
    const blocks = [...preview.querySelectorAll('.markdown-preview-sizer > *')];
    const last = blocks[blocks.length - 1];
    if (last) lastLineBottom = last.getBoundingClientRect().bottom;
  } else if (editor && !editor.hidden) {
    const lines = [...editor.querySelectorAll('.cm-line')];
    const last = lines[lines.length - 1];
    if (last) lastLineBottom = last.getBoundingClientRect().bottom;
  }
  const scroller = document.querySelector('.cm-scroller');
  return {
    present: true,
    sameNode: el === window.__u52Badge,
    badgeCount: document.querySelectorAll(badgeSelector).length,
    nodeName: el.nodeName,
    type: el.getAttribute('type'),
    hidden: el.hidden,
    display: getComputedStyle(el).display,
    words: el.querySelector('.word-count-badge-words')?.textContent ?? null,
    characters: charactersNode?.textContent ?? null,
    charactersVisible: charactersNode ? getComputedStyle(charactersNode).display !== 'none' : null,
    ariaLabel: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    ariaLive: el.getAttribute('aria-live'),
    role: el.getAttribute('role'),
    expanded: el.classList.contains('is-expanded'),
    ariaPressed: el.getAttribute('aria-pressed'),
    state: el.dataset.state ?? null,
    dataPath: el.dataset.path ?? null,
    dataEpoch: el.dataset.epoch ?? null,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    docRect: { left: docRect.left, top: docRect.top, right: docRect.right, bottom: docRect.bottom },
    lastLineBottom,
    documentScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    preview: preview ? { clientWidth: preview.clientWidth, offsetWidth: preview.offsetWidth, scrollWidth: preview.scrollWidth, clientHeight: preview.clientHeight, scrollHeight: preview.scrollHeight, paddingBottom: getComputedStyle(preview).paddingBottom } : null,
    scroller: scroller ? { clientWidth: scroller.clientWidth, offsetWidth: scroller.offsetWidth, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, paddingBottom: getComputedStyle(scroller).paddingBottom, paddingTop: getComputedStyle(scroller).paddingTop } : null,
    railLeft: (() => { const rail = document.querySelector('#context-sidebar'); if (!rail || rail.offsetParent === null) return null; return rail.getBoundingClientRect().left; })(),
    statusBarCount: document.querySelectorAll('.status-bar').length,
  };
}, selector);
