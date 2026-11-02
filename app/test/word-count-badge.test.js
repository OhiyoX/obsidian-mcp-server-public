// Word-count badge contract: single instance, identity fencing, lifecycle and a11y
// (issue #430, matrix rows 3-4, 6-7 and the "0 write" row).
//
// The badge is wired through the real document session and the real session status presenter,
// so these tests exercise the same objects the app uses; only the DOM is the repo's headless
// harness and the timer is injected for determinism.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createDocumentSession } from "../frontend/app/features/session/index.js";
import { createSessionStatusPresenter } from "../frontend/app/features/session/status-presenter.js";
import { createWordCountBadge, WORD_COUNT_BADGE_CLASS } from "../frontend/app/features/document/word-count-badge.js";
import { summarizeWordCount } from "../frontend/app/features/document/word-count.js";

const harness = createDomHarness();
harness.install();

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const pagesSource = () => fs.readFileSync(`${APP_DIR}/src/app/pages.js`, "utf8");
const cssSource = () => fs.readFileSync(`${APP_DIR}/src/app/assets/app.css`, "utf8");

// The served document pane, exactly as `pages.js` renders it (badge included).
function servedDocumentHost() {
  const host = harness.document.createElement("section");
  host.className = "document workspace-leaf-content view-content";
  const preview = harness.document.createElement("article");
  preview.className = "preview markdown-reading-view";
  const badge = harness.document.createElement("button");
  badge.className = WORD_COUNT_BADGE_CLASS;
  badge.type = "button";
  badge.setAttribute("id", "word-count-badge");
  badge.hidden = true;
  const words = harness.document.createElement("span");
  words.className = "word-count-badge-words";
  const characters = harness.document.createElement("span");
  characters.className = "word-count-badge-characters";
  badge.append(words, characters);
  host.append(preview, badge);
  return host;
}

function makeClock() {
  const jobs = [];
  const cancelled = [];
  return {
    jobs,
    cancelled,
    schedule: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    cancel: (id) => { cancelled.push(id); },
    now: () => 0,
    flush(count = jobs.length) {
      while (jobs.length > count) break;
      const pending = jobs.splice(0, jobs.length);
      for (const job of pending) job.fn();
    },
  };
}

function paintTextOf(badge) {
  return {
    words: badge.querySelector(".word-count-badge-words").textContent,
    characters: badge.querySelector(".word-count-badge-characters").textContent,
  };
}

test("served markup: one badge element inside the document pane, never a status bar", () => {
  const source = pagesSource();
  assert.match(source, /<button id="word-count-badge" class="word-count-badge" type="button" hidden>/, "pages.js must mount the badge");
  const documentIndex = source.indexOf('<section class="document workspace-leaf-content view-content">');
  const badgeIndex = source.indexOf('id="word-count-badge"');
  const sectionEnd = source.indexOf("</section>", documentIndex);
  assert.ok(documentIndex >= 0 && badgeIndex > documentIndex && badgeIndex < sectionEnd, "the badge must be a child of the document section");
  const previewIndex = source.indexOf('<article id="preview"');
  const previewEnd = source.indexOf("</article>", previewIndex);
  assert.ok(badgeIndex > previewEnd, "the badge must be a sibling of #preview, not a child (it must not scroll with the Reader)");
  assert.doesNotMatch(source, /class="status-bar"/);
  assert.doesNotMatch(cssSource(), /\.status-bar/);
  const badgeRuleStart = cssSource().indexOf(".word-count-badge {");
  assert.ok(badgeRuleStart >= 0, "app.css must style the badge");
  const css = cssSource();
  const nextTopLevel = css.indexOf("\n.view-mode {", badgeRuleStart);
  const badgeCss = css.slice(badgeRuleStart, nextTopLevel > badgeRuleStart ? nextTopLevel : badgeRuleStart + 2000);
  // Geometry red line: the badge rules must not name the scroll owners at all, so they cannot
  // change Reader/Live padding, height or scroll ownership.
  assert.ok(!badgeCss.includes("cm-scroller"), "the badge rules must not touch .cm-scroller");
  assert.ok(!badgeCss.includes(".preview"), "the badge rules must not touch .preview");
  assert.ok(!badgeCss.includes(".editor"), "the badge rules must not touch .editor");
});

test("a headless caller (no host / no DOM) is a safe no-op", () => {
  const badge = createWordCountBadge({ host: null });
  assert.equal(badge.element, null);
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "hello" });
  badge.hide();
});

test("the served element is reused (single instance) and is never duplicated", () => {
  const host = servedDocumentHost();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 });
  assert.equal(host.querySelectorAll(".word-count-badge").length, 1);
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "hello world" });
  assert.equal(host.querySelectorAll(".word-count-badge").length, 1, "update must never create a second badge");
  assert.equal(badge.element, host.querySelector(".word-count-badge"));
});

test("a fixture without the served markup gets exactly one created badge", () => {
  const host = harness.document.createElement("section");
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 });
  assert.ok(badge.element);
  assert.equal(host.querySelectorAll(".word-count-badge").length, 1);
  assert.ok(badge.element.querySelector(".word-count-badge-words"));
  assert.ok(badge.element.querySelector(".word-count-badge-characters"));
});

test("update paints both counts with a static accessible name and no live region", () => {
  const host = servedDocumentHost();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 });
  const text = "hello 世界 1234";
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text });
  const expected = summarizeWordCount(text);
  assert.deepEqual(paintTextOf(badge.element), { words: "字数 4", characters: "字符 11" });
  assert.equal(badge.element.hidden, false);
  assert.match(badge.element.getAttribute("aria-label"), /字数 4，字符 11（字符数不含空白）/);
  assert.equal(badge.element.getAttribute("aria-live"), null, "the badge must not be an aria-live region");
  assert.equal(badge.element.getAttribute("role"), null, "no role implies a live region");
  assert.equal(badge.element.dataset.words, String(expected.words));
  assert.equal(badge.element.dataset.characters, String(expected.characters));
});

test("the badge starts hidden and hide() clears the numbers", () => {
  const host = servedDocumentHost();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 });
  assert.equal(badge.element.hidden, true);
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one two" });
  assert.equal(badge.element.hidden, false);
  badge.hide();
  assert.equal(badge.element.hidden, true);
  assert.deepEqual(paintTextOf(badge.element), { words: "", characters: "" });
  assert.equal(badge.element.dataset.state, "hidden");
});

test("a null path (welcome / no note) hides instead of showing the previous document", () => {
  const host = servedDocumentHost();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one two three" });
  badge.update({ path: null, vaultId: "v", epoch: 1, text: "one two three" });
  assert.equal(badge.element.hidden, true);
  assert.deepEqual(paintTextOf(badge.element), { words: "", characters: "" });
});

test("an identity change clears the numbers immediately and never shows the old document", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "alpha beta" });
  clock.flush();
  assert.equal(paintTextOf(badge.element).words, "字数 2");
  // New document: numbers must be gone before the throttled recompute lands.
  const scheduledBefore = clock.jobs.length;
  badge.update({ path: "Notes/B.md", vaultId: "v", epoch: 2, text: "x" });
  assert.deepEqual(paintTextOf(badge.element), { words: "", characters: "" }, "the previous document's numbers must not survive an identity change");
  assert.equal(badge.element.dataset.state, "pending");
  assert.equal(badge.element.dataset.path, "Notes/A.md", "the dataset still describes the last painted identity until the new paint lands");
  clock.flush(scheduledBefore);
  assert.equal(badge.element.dataset.path, "Notes/B.md");
  assert.equal(paintTextOf(badge.element).words, "字数 1");
});

test("an undo inside one throttle window cancels the queued intermediate count", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 120, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one" });
  clock.flush();
  assert.equal(badge.element.dataset.words, "1");
  // Edit inside the window: the intermediate text is queued, not painted yet.
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one two" });
  assert.equal(clock.jobs.length, 1, "the intermediate edit must be queued");
  // Undo back to the painted text, still inside the same window.
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one" });
  // Fire every queued callback, cancelled ones included: run() must find no pending job.
  clock.flush();
  assert.equal(badge.element.dataset.words, "1", "the undone edit must never be painted");
  assert.equal(paintTextOf(badge.element).words, "字数 1");
});

test("a real edit after a throttled undo still refreshes", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 120, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one" });
  clock.flush();
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one two" });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one" });
  assert.equal(clock.jobs.length, 1);
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one two three" });
  clock.flush();
  assert.equal(badge.element.dataset.words, "3", "cancelling the stale job must not wedge the throttle");
});

test("an identity change clears the numbers and the old accessible name together", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "alpha beta" });
  clock.flush();
  assert.match(String(badge.element.getAttribute("aria-label")), /字数 2/);
  const scheduledBefore = clock.jobs.length;
  badge.update({ path: "Notes/B.md", vaultId: "v", epoch: 2, text: "x" });
  assert.deepEqual(paintTextOf(badge.element), { words: "", characters: "" });
  assert.equal(badge.element.getAttribute("aria-label"), null, "a pending badge must not announce the old document");
  assert.equal(badge.element.getAttribute("title"), null);
  clock.flush(scheduledBefore);
  assert.match(String(badge.element.getAttribute("aria-label")), /字数 1/);
});

test("a late (out-of-order) callback cannot paint a superseded document", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "alpha beta gamma" });
  const staleCallback = clock.jobs[0].fn;
  badge.update({ path: "Notes/B.md", vaultId: "v", epoch: 2, text: "solo" });
  // The superseded job is cancelled and, even if it fires, it can only run the current slot.
  assert.ok(clock.cancelled.length >= 1);
  staleCallback();
  assert.equal(paintTextOf(badge.element).words, "字数 1", "the stale callback must not repaint the old document");
  assert.equal(badge.element.dataset.path, "Notes/B.md");
});

test("unchanged text does not schedule a recompute", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "same text" });
  clock.flush();
  const after = clock.jobs.length;
  for (let index = 0; index < 25; index += 1) {
    badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "same text" });
  }
  assert.equal(clock.jobs.length, after, "an unchanged snapshot must not queue another pass");
});

test("dense typing is coalesced: one pass per throttle window, not one per event", () => {
  const host = servedDocumentHost();
  const clock = makeClock();
  const badge = createWordCountBadge({ host, throttleMs: 120, setTimeoutFn: clock.schedule, clearTimeoutFn: clock.cancel, now: clock.now });
  for (let index = 0; index < 12; index += 1) {
    badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "a".repeat(index + 1) });
    assert.ok(clock.jobs.length <= 1, `update ${index} must not queue more than one pending pass`);
  }
  clock.flush();
  assert.equal(paintTextOf(badge.element).words, "字数 1");
});

test("the trailing throttle adapts to the measured pass cost (duty-cycle guard)", () => {
  const host = servedDocumentHost();
  const jobs = [];
  // A clock that advances on every read, so a "pass" has a measurable duration.
  let ticks = 0;
  const badge = createWordCountBadge({
    host,
    throttleMs: 120,
    setTimeoutFn: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    clearTimeoutFn: () => {},
    now: () => { ticks += 40; return ticks; },
  });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "alpha beta" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ms, 0, "the first pass after idle runs immediately");
  jobs.shift().fn();
  const passMs = badge.lastPassMs;
  assert.ok(passMs > 0, `expected a measurable pass cost, got ${passMs}`);
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "alpha beta gamma" });
  assert.equal(jobs.length, 1);
  assert.ok(
    jobs[0].ms >= passMs * 3,
    `a burst must wait at least 3x the measured pass (${passMs} ms), scheduled ${jobs[0].ms} ms`,
  );
});

test("the click control reveals the narrow-pane character count without a second render path", () => {
  const host = servedDocumentHost();
  const badge = createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 });
  badge.update({ path: "Notes/A.md", vaultId: "v", epoch: 1, text: "one two" });
  assert.equal(badge.element.classList.contains("is-expanded"), false);
  badge.element.click();
  assert.equal(badge.element.classList.contains("is-expanded"), true);
  assert.equal(badge.element.getAttribute("aria-pressed"), "true");
  badge.element.click();
  assert.equal(badge.element.classList.contains("is-expanded"), false);
  assert.equal(badge.element.getAttribute("aria-pressed"), "false");
});

// ---- presenter integration (the single write path in the app) ----

function presenterHarness({ documentKind = "note", withBadge = true } = {}) {
  const host = servedDocumentHost();
  const save = { disabled: false };
  const status = { textContent: "" };
  const badge = withBadge ? createWordCountBadge({ host, throttleMs: 0, setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {}, now: () => 0 }) : null;
  const session = createDocumentSession();
  const state = { path: null, revision: null, remoteRevision: null, dirty: false, deleted: false, conflict: null, documentKind };
  const presenter = createSessionStatusPresenter({
    state, session, save, status, conflictBar: { render() {} }, isVaultSwitching: () => false, wordCountBadge: badge,
  });
  return { host, session, state, presenter, badge, save, status };
}

test("presenter: a committed open paints the count, welcome and Base hide it", () => {
  const { session, state, presenter, badge } = presenterHarness({ documentKind: "note" });
  assert.equal(badge.element.hidden, true, "nothing open yet");
  const ticket = session.beginOpen({ vaultId: "v", path: "Notes/A.md" });
  session.commitOpen(ticket, { content: "# Head\n\nalpha beta gamma\n", revision: "r1", path: "Notes/A.md", vaultId: "v" });
  session.setLiveText(session.liveText);
  presenter(session.statusFlags());
  assert.equal(badge.element.hidden, false);
  assert.equal(badge.element.dataset.words, "4");

  // Base surface: the Markdown identity is untouched but the badge must disappear.
  state.documentKind = "base";
  presenter(session.statusFlags());
  assert.equal(badge.element.hidden, true);
  assert.deepEqual([badge.element.querySelector(".word-count-badge-words").textContent], [""]);

  // Back to the note.
  state.documentKind = "note";
  presenter(session.statusFlags());
  assert.equal(badge.element.hidden, false);

  // Welcome (the last tab closed) drops the document identity.
  session.closeDocument();
  presenter(session.statusFlags());
  assert.equal(badge.element.hidden, true);
});

test("presenter: a local edit refreshes from the session's live text, not from the DOM", () => {
  const { session, presenter, badge } = presenterHarness();
  const ticket = session.beginOpen({ vaultId: "v", path: "Notes/A.md" });
  session.commitOpen(ticket, { content: "one two\n", revision: "r1", path: "Notes/A.md", vaultId: "v" });
  presenter(session.statusFlags());
  assert.equal(badge.element.dataset.words, "2");
  const flags = session.noteLocalEdit("one two three four five");
  assert.equal(flags.dirty, true);
  presenter(flags);
  assert.equal(badge.element.dataset.words, "5");
});

test("presenter: a stale (touchCurrent === false) snapshot falls back to the committed document", () => {
  const { session, presenter, badge } = presenterHarness();
  const ticket = session.beginOpen({ vaultId: "v", path: "Notes/A.md" });
  session.commitOpen(ticket, { content: "alpha beta\n", revision: "r1", path: "Notes/A.md", vaultId: "v" });
  presenter(session.statusFlags());
  assert.equal(badge.element.dataset.words, "2");
  // A stale response for another document must never drive the badge.
  presenter({ applied: false, touchCurrent: false, reason: "identity-mismatch", path: "Notes/B.md", vaultId: "v", epoch: 99, dirty: false });
  assert.equal(badge.element.dataset.words, "2");
  assert.equal(badge.element.dataset.path, "Notes/A.md");
});

test("presenter: omitting the badge keeps the existing headless contract working", () => {
  const { session, presenter, save } = presenterHarness({ withBadge: false });
  const ticket = session.beginOpen({ vaultId: "v", path: "Notes/A.md" });
  session.commitOpen(ticket, { content: "alpha beta\n", revision: "r1", path: "Notes/A.md", vaultId: "v" });
  session.noteLocalEdit("alpha beta gamma");
  presenter(session.statusFlags());
  assert.equal(save.disabled, false, "the presenter's original duties are unchanged");
});
