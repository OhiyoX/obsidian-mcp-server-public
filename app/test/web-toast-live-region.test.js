// Issue #411 / audit §5 (Cut E): the toast channel of the Web workspace.
//
// A toast is a transient visual message, so screen readers need an explicit live
// region; a failure must live longer than a success and must be closable; and one
// operation must announce exactly once. These are asserted against the real
// `ui/feedback.js` (announcement counting runs on the shared DOM harness with the
// real page chrome shape and, for the search path, the real Explorer controller).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { installTimerRecorder } from "./helpers/deterministic-timers.mjs";
import { mountShellChrome } from "./helpers/web-shell-chrome.mjs";
import { LIVE_REGION_SELECTOR, announcedMessages, liveRegionTexts, liveRegions, toasts } from "./helpers/web-live-regions.mjs";
import { TOAST_ERROR_MS, TOAST_SUCCESS_MS, toast } from "../frontend/app/ui/feedback.js";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";

// --- deterministic environment ----------------------------------------------

// The harness installs globals rather than state, so every test gets a fresh document.
function withToasts(name, body) {
  test(name, async () => {
    const harness = createDomHarness();
    harness.install();
    const { document } = harness;
    const recorder = installTimerRecorder();
    try {
      await body({ document, recorder });
    } finally {
      recorder.restore();
    }
  });
}

// The real page chrome: the shipped topbar (its polite live region, `#status` and the
// two panel status regions) is parsed out of `pages.js` itself, so announcement counts
// run against the template the server serves rather than a hand-written mirror.
const mountPageChrome = (document) => mountShellChrome(document);

// --- semantics ---------------------------------------------------------------

withToasts("a success toast is a polite live region and is never assertive", ({ document }) => {
  const element = toast("已保存");

  assert.equal(element.getAttribute("role"), "status");
  assert.equal(element.getAttribute("aria-live"), "polite");
  assert.notEqual(element.getAttribute("role"), "alert");
  assert.notEqual(element.getAttribute("aria-live"), "assertive");
  assert.equal(element.getAttribute("aria-atomic"), "true");
  assert.equal(element.className, "toast", "the visual contract is unchanged");
  assert.equal(element.textContent, "已保存");
  assert.equal(toasts(document).length, 1);
});

withToasts("a failure toast is an assertive live region and keeps the error class", ({ document }) => {
  const element = toast("保存失败", true);

  assert.equal(element.getAttribute("role"), "alert");
  assert.equal(element.getAttribute("aria-live"), "assertive");
  assert.notEqual(element.getAttribute("role"), "status");
  assert.equal(element.getAttribute("aria-atomic"), "true");
  assert.equal(element.className, "toast error");
  assert.equal(element.textContent, "保存失败");
});

withToasts("exactly one live region is created per call (no container + child double announcement)", async ({ document }) => {
  await mountPageChrome(document);

  const beforeFirst = liveRegionTexts(document);
  const success = toast("已保存");
  assert.deepEqual(announcedMessages(document, beforeFirst), ["已保存"]);

  const beforeSecond = liveRegionTexts(document);
  const failure = toast("保存失败", true);
  assert.deepEqual(announcedMessages(document, beforeSecond), ["保存失败"]);

  // Each toast is its own live region and has no live-region ancestor.
  assert.equal(success.closest(LIVE_REGION_SELECTOR), success);
  assert.equal(failure.closest(LIVE_REGION_SELECTOR), failure);
  assert.deepEqual(liveRegions(document).filter((element) => element.className.startsWith("toast")), [success, failure]);
});

// --- timing ------------------------------------------------------------------

withToasts("an error outlives a success and both still auto-remove", ({ document, recorder }) => {
  const success = toast("已保存");
  const failure = toast("保存失败", true);
  const [successDelay, errorDelay] = recorder.delays();

  assert.equal(successDelay, TOAST_SUCCESS_MS);
  assert.equal(TOAST_SUCCESS_MS, 2600, "the success baseline of #411 is unchanged");
  assert.equal(errorDelay, TOAST_ERROR_MS);
  assert.ok(errorDelay > successDelay, `error (${errorDelay} ms) must outlive success (${successDelay} ms)`);

  // Not permanent: each toast removes itself when its own timer fires.
  recorder.runAll();
  assert.equal(toasts(document).length, 0);
  assert.equal(success.parentNode, null);
  assert.equal(failure.parentNode, null);
});

withToasts("a failure is closable by hand (click, and Escape on the focused toast)", ({ document, recorder }) => {
  const clicked = toast("保存失败", true);
  assert.equal(clicked.tabIndex, 0, "an error toast is keyboard reachable");
  clicked.dispatchEvent({ type: "click" });
  assert.equal(clicked.parentNode, null, "pointer activation closes the toast before its timeout");
  assert.equal(recorder.pending(), 0, "the pending auto-remove is cancelled on manual close");

  const escaped = toast("保存失败", true);
  assert.equal(escaped.parentNode, document.body);
  escaped.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(escaped.parentNode, null);

  const ignored = toast("保存失败", true);
  ignored.dispatchEvent({ type: "keydown", key: "Enter" });
  assert.equal(ignored.parentNode, document.body, "only Escape closes it");
});

withToasts("hovering or focusing an error postpones its auto-remove instead of removing it", ({ document, recorder }) => {
  const element = toast("保存失败", true);
  assert.equal(recorder.pending(), 1);

  element.dispatchEvent({ type: "mouseenter" });
  assert.equal(recorder.pending(), 0, "the auto-remove is paused while the reader is on the toast");
  assert.equal(element.parentNode, document.body, "pausing never removes the toast");

  element.dispatchEvent({ type: "mouseleave" });
  assert.deepEqual(recorder.delays(), [TOAST_ERROR_MS], "leaving re-arms the full error window");

  element.dispatchEvent({ type: "focus" });
  assert.equal(recorder.pending(), 0);
  element.dispatchEvent({ type: "blur" });
  assert.equal(recorder.pending(), 1);
  recorder.runAll();
  assert.equal(element.parentNode, null, "postponed, never permanent");
});

// --- one operation, one announcer --------------------------------------------

const SEARCH_ERROR_TEXT = "搜索服务暂时不可用，请稍后重试";

function createSearchController({ document, statusHost, onToast }) {
  const api = async () => {
    const error = new Error("boom");
    error.status = 500;
    throw error;
  };
  return createExplorerController({
    state: { path: null, query: "", searchCollapsed: new Set(), semantic: false, caseSensitive: false, vaultId: "v1" },
    host: document.createElement("div"),
    searchHost: null,
    statusHost,
    filesStatusHost: null,
    api,
    toast: onToast,
    escapeHtml: (value) => String(value),
    openNote: () => {},
    createNote: () => {},
    openBase: () => {},
    openFile: () => {},
  });
}

withToasts("a failed search announces once: the panel status region owns it, the toast is only the fallback", async ({ document }) => {
  const chrome = await mountPageChrome(document);
  const calls = [];
  const controller = createSearchController({
    document,
    statusHost: chrome.searchStatus,
    onToast: (...args) => { calls.push(args); return toast(...args); },
  });

  const before = liveRegionTexts(document);
  await controller.load("boom");

  // The panel status region is a live region, so the controller must not also
  // toast the same failure (controller.js:313 gate).
  assert.deepEqual(calls, []);
  assert.deepEqual(announcedMessages(document, before), [SEARCH_ERROR_TEXT]);
  assert.equal(chrome.statusLine.textContent, "", "the polite topbar status is not a second announcer here");
  assert.equal(toasts(document).length, 0);
});

withToasts("without a panel status region the toast becomes the single announcer of the same failure", async ({ document }) => {
  const chrome = await mountPageChrome(document);
  const calls = [];
  const controller = createSearchController({
    document,
    statusHost: null,
    onToast: (...args) => { calls.push(args); return toast(...args); },
  });

  const before = liveRegionTexts(document);
  await controller.load("boom");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [SEARCH_ERROR_TEXT, true]);
  assert.deepEqual(announcedMessages(document, before), [SEARCH_ERROR_TEXT]);
  assert.equal(chrome.searchStatus.textContent, "");
  assert.equal(toasts(document).length, 1);
  assert.equal(toasts(document)[0].getAttribute("role"), "alert");
});
