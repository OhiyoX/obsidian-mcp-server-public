// Single-instance word-count badge for the document pane (issue #430).
//
// One badge element, one owner. It never counts anything itself: `word-count.js` owns the
// frozen 口径 and this module only decides *when* to recompute, *which document* the numbers
// belong to, and how the result is painted.
//
// Lifecycle contract:
// - `update({ path, vaultId, epoch, text })` is the only write entry. The caller passes the
//   session's committed identity plus its live raw Markdown, so Live / RAW / Reader all feed
//   the exact same string and no code path ever scans rendered DOM.
// - Identity is fenced: a different `vaultId`/`path`/`epoch` never repaints the previous
//   document's numbers. On an identity change the visible numbers are cleared immediately and
//   the element is shown, then the counts are computed after a short throttle.
// - `hide()` (no note, welcome, Base surface, vault switch) clears and hides synchronously, so
//   a closed document can never leave a stale count on screen.
// - Recomputes are coalesced with a leading/trailing throttle (default 120 ms), so dense
//   typing on a 1 MB document costs at most ~8 full passes per second instead of one per key.
// - A throttled undo — the live text returns to exactly what is already painted while a queued
//   job still holds an intermediate edit — drops that job, so the trailing edge can never repaint
//   the text the user undid.
// - On an identity change the numbers *and* the accessible name are cleared together; a pending
//   badge must never announce the previous document's counts.
// - Nothing here writes to the network, the disk, the document session or the editor.
import { formatWordCountLabel, summarizeWordCount } from "./word-count.js";

export const WORD_COUNT_BADGE_CLASS = "word-count-badge";
export const WORD_COUNT_THROTTLE_MS = 120;
// During a typing burst the next pass may start no sooner than DUTY_CYCLE_DIVISOR × the previous
// pass duration. The badge therefore cannot eat the typing frame budget no matter how large the
// document (or how slow the machine) is: on a normal note a pass is far below 1 ms and the
// 120 ms window dominates, while on a 1 MB note the window stretches until the pass takes ~1/3
// of the time at most.
const DUTY_CYCLE_DIVISOR = 3;

const IDENTITY_FIELDS = ["vaultId", "path", "epoch"];

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function createElement(ownerDocument, tag, className) {
  const element = ownerDocument.createElement(tag);
  element.className = className;
  return element;
}

function ownerDocumentOf(node) {
  return node?.ownerDocument ?? (typeof document !== "undefined" ? document : null);
}

// The served markup already contains the badge (`pages.js`), which is what guarantees a single
// instance. The constructor path exists only so DOM/session fixtures without that markup still
// get a working badge; it can never create a second one when the served element is present.
function resolveBadge(host) {
  if (!host || typeof host.querySelector !== "function") return null;
  const existing = host.querySelector(`.${WORD_COUNT_BADGE_CLASS}`);
  if (existing) return existing;
  const ownerDocument = ownerDocumentOf(host);
  if (!ownerDocument || typeof ownerDocument.createElement !== "function") return null;
  const badge = createElement(ownerDocument, "button", WORD_COUNT_BADGE_CLASS);
  badge.type = "button";
  badge.hidden = true;
  host.appendChild(badge);
  return badge;
}

function ensureParts(badge) {
  const ownerDocument = ownerDocumentOf(badge);
  let words = typeof badge.querySelector === "function" ? badge.querySelector(".word-count-badge-words") : null;
  let characters = typeof badge.querySelector === "function" ? badge.querySelector(".word-count-badge-characters") : null;
  if ((!words || !characters) && ownerDocument && typeof ownerDocument.createElement === "function") {
    words = createElement(ownerDocument, "span", "word-count-badge-words");
    characters = createElement(ownerDocument, "span", "word-count-badge-characters");
    if (typeof badge.replaceChildren === "function") badge.replaceChildren(words, characters);
    else { badge.appendChild(words); badge.appendChild(characters); }
  } else if (words && !characters) {
    characters = createElement(ownerDocument, "span", "word-count-badge-characters");
    badge.appendChild(characters);
  } else if (characters && !words) {
    words = createElement(ownerDocument, "span", "word-count-badge-words");
    badge.insertBefore(words, characters);
  }
  return { words, characters };
}

export function createWordCountBadge({
  host,
  throttleMs = WORD_COUNT_THROTTLE_MS,
  setTimeoutFn,
  clearTimeoutFn,
  now,
} = {}) {
  const badge = resolveBadge(host);
  const parts = badge ? ensureParts(badge) : { words: null, characters: null };
  const scheduleTimer = setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimer = clearTimeoutFn ?? ((id) => clearTimeout(id));
  const clock = now ?? (() => Date.now());

  let claimed = null;       // identity the visible numbers belong to
  let renderedText = null;  // text those numbers were computed from
  let pending = null;       // { identity, text } waiting for the throttle
  let timer = null;
  let scheduled = false;
  let lastComputeAt = Number.NEGATIVE_INFINITY;
  let lastPassMs = 0;

  function clearNumbers() {
    if (parts.words) parts.words.textContent = "";
    if (parts.characters) parts.characters.textContent = "";
  }

  // The accessible name is part of the painted statistics: a badge whose numbers were cleared
  // (identity change, entering pending) must not keep announcing the previous document's counts
  // to a screen reader, so it goes when the numbers go.
  function clearAccessibleName() {
    if (typeof badge.removeAttribute === "function") {
      badge.removeAttribute("aria-label");
      badge.removeAttribute("title");
    }
  }

  function clearTimer() {
    if (timer !== null) cancelTimer(timer);
    timer = null;
    scheduled = false;
  }

  function hide() {
    if (!badge) return;
    clearTimer();
    pending = null;
    claimed = null;
    renderedText = null;
    clearNumbers();
    clearAccessibleName();
    if (badge.dataset) {
      // No document may be implied by the hidden badge: drop the identity the numbers belonged
      // to as well, not just the numbers (vault switch / last-tab close / Base).
      badge.dataset.state = "hidden";
      badge.dataset.path = "";
      badge.dataset.vaultId = "";
      badge.dataset.epoch = "";
      badge.dataset.words = "";
      badge.dataset.characters = "";
    }
    badge.hidden = true;
  }

  function paint(counts, identity) {
    const label = formatWordCountLabel(counts);
    if (parts.words) parts.words.textContent = label.words;
    if (parts.characters) parts.characters.textContent = label.characters;
    if (typeof badge.setAttribute === "function") {
      // One static accessible name; deliberately not an aria-live region (the issue forbids
      // announcing a count on every keystroke).
      badge.setAttribute("aria-label", label.full);
      badge.setAttribute("title", label.full);
    }
    if (badge.dataset) {
      badge.dataset.state = "ready";
      badge.dataset.words = String(counts.words);
      badge.dataset.characters = String(counts.characters);
      badge.dataset.vaultId = String(identity?.vaultId ?? "");
      badge.dataset.path = String(identity?.path ?? "");
      badge.dataset.epoch = String(identity?.epoch ?? "");
    }
  }

  function run() {
    const job = pending;
    if (!job) return;
    pending = null;
    // The job was fenced at `update` time; re-check so a stale trailing job can never paint
    // over a newer identity claimed in the meantime.
    if (!sameIdentity(claimed, job.identity)) return;
    const startedAt = clock();
    renderedText = job.text;
    paint(summarizeWordCount(job.text), job.identity);
    const finishedAt = clock();
    lastPassMs = Math.max(0, finishedAt - startedAt);
    lastComputeAt = finishedAt;
  }

  // Leading/trailing throttle. `scheduled` (not the timer id) is the guard so a scheduler that
  // invokes its callback synchronously cannot leave a stale "already scheduled" flag behind.
  function scheduleRun() {
    if (scheduled) return;
    scheduled = true;
    const sinceLast = clock() - lastComputeAt;
    const idle = !Number.isFinite(sinceLast) || sinceLast >= throttleMs;
    const wait = idle ? 0 : Math.max(throttleMs - sinceLast, lastPassMs * DUTY_CYCLE_DIVISOR);
    timer = scheduleTimer(() => {
      timer = null;
      scheduled = false;
      run();
    }, wait);
  }

  function update(snapshot) {
    if (!badge) return;
    const identity = {
      vaultId: snapshot?.vaultId ?? null,
      path: snapshot?.path ?? null,
      epoch: snapshot?.epoch ?? null,
    };
    if (identity.path == null) {
      hide();
      return;
    }
    const text = String(snapshot?.text ?? "");
    const changed = !sameIdentity(claimed, identity);
    if (changed) {
      clearTimer();
      pending = null;
      claimed = identity;
      renderedText = null;
      clearNumbers();
      clearAccessibleName();
      if (badge.dataset) badge.dataset.state = "pending";
      badge.hidden = false;
    } else if (renderedText === text) {
      // The incoming text is exactly what is already on screen while a queued job still holds an
      // intermediate edit. Throttled undo is the real case (`one` -> `one two` -> `one` inside one
      // window): drop the queued job instead of letting the trailing edge repaint the intermediate
      // count over the restored text. `run()` reads `pending`, so a callback that still fires is a
      // no-op.
      pending = null;
      clearTimer();
      return;
    }
    pending = { identity, text };
    scheduleRun();
  }

  if (badge && typeof badge.addEventListener === "function") {
    // Narrow panes hide the character count; the control (button + Enter/Space) reveals the
    // full value without a live region and without a second render path.
    badge.addEventListener("click", () => {
      if (typeof badge.classList?.toggle !== "function") return;
      const expanded = badge.classList.toggle("is-expanded");
      if (typeof badge.setAttribute === "function") badge.setAttribute("aria-pressed", String(expanded));
    });
  }

  return {
    update,
    hide,
    get element() { return badge; },
    get lastPassMs() { return lastPassMs; },
  };
}
