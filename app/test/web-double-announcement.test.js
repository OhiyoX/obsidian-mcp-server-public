// U46 (#422): one operation, one live region.
//
// #411 turned the toast into an explicit live region (failure = `role="alert"`). The
// four paths below then announced twice, because `.topbar-status` is itself a polite
// live region and the entry wrote the same failure into `#status` as well
// (`U37/U37.HANDOFF.md` §4.3 debt D1-D4). The owner split U37 ruled, and this file
// pins, is:
//
//   D1 save failure (non-conflict) -> the toast owns it   (core/app.js saveNote)
//   D2 save hits a 409 conflict    -> the toast owns it   (core/app.js saveNote)
//   D3 save while a conflict is pending -> the toast owns it (core/app.js saveNote)
//   D4 session expired (401)       -> the reconnect hint owns it (attach-reconnect.js)
//
// `#status` keeps its visible text in every case (the persistent readout a reader can
// go back to); it simply is not an announcement channel any more. The chrome under
// test is parsed out of the shipped `pages.js` markup, not mirrored, so the negative
// control is a one-line revert of the template (`U46/U46.HANDOFF.md` §negative controls).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { installTimerRecorder } from "./helpers/deterministic-timers.mjs";
import { mountShellChrome } from "./helpers/web-shell-chrome.mjs";
import { announcedRegions, liveRegionTexts, toasts } from "./helpers/web-live-regions.mjs";
import { toast } from "../frontend/app/ui/feedback.js";
import { attachReconnect } from "../frontend/app/features/sync/attach-reconnect.js";
import { createHarness } from "./helpers/reconnect-supervisor-harness.mjs";

const SESSION_EXPIRED_TEXT = "登录已失效，请重新登录";
const ANY_LIVE_REGION = '[role="status"],[role="alert"],[aria-live]';

function withChrome(name, body) {
  test(name, async () => {
    const harness = createDomHarness();
    harness.install();
    const recorder = installTimerRecorder();
    try {
      await body({ document: harness.document, recorder });
    } finally {
      recorder.restore();
    }
  });
}

// --- the shipped chrome shape (D1-D3 owner: which element may announce) -------

withChrome("the shipped topbar keeps one polite live region and #status outside it", async ({ document }) => {
  const chrome = await mountShellChrome(document);

  // The persistent sync/connection channel survives untouched, `#live-status-label`
  // included (U37: it is why the whole `.topbar-status` must not be turned off).
  assert.equal(chrome.topbarStatus.getAttribute("aria-live"), "polite");
  assert.equal(chrome.liveStatusLabel.textContent, "连接中");
  assert.equal(chrome.liveStatusLabel.closest(ANY_LIVE_REGION), chrome.topbarStatus);
  assert.equal(chrome.topbar.querySelectorAll(ANY_LIVE_REGION).length, 1, "the topbar has exactly one live region");

  // The session readout is still rendered (visible text preserved) but is not a
  // live region and has no live-region ancestor, so its writes are silent.
  assert.equal(chrome.statusLine.className, "status");
  assert.equal(chrome.statusLine.parentNode, chrome.topbar, "#status is a direct topbar child, beside the action row");
  assert.equal(chrome.statusLine.closest(ANY_LIVE_REGION), null);

  // The move must not disturb the frozen action-row identity/order (#371 / U29).
  const keys = chrome.actions.children.map((element) => element.id || element.className.trim().split(/\s+/).pop());
  assert.deepEqual(keys, ["topbar-status", "save", "topbar-view-mode", "document-actions", "sidebar-toggle"]);
});

// --- D1 / D2 / D3: the toast is the only announcer ----------------------------

// The three failure transcripts of `core/app.js` `saveNote()`: each writes the visible
// summary into `#status` and the transient failure through `toast(message, true)`.
const SAVE_FAILURES = [
  {
    name: "D1 a save failure",
    status: "保存失败 (500)",
    message: "服务暂时不可用，请稍后重试",
  },
  {
    name: "D2 a save that hits a 409 conflict",
    status: "与磁盘版本冲突，请重新载入或复制本地内容后再处理",
    message: "保存冲突",
  },
  {
    name: "D3 a save while a conflict is still pending",
    status: "存在冲突，请先重新载入磁盘版本或保留本地后再试",
    message: "请先解决版本冲突",
  },
];

for (const failure of SAVE_FAILURES) {
  withChrome(`${failure.name} announces exactly once, through the assertive toast`, async ({ document }) => {
    const chrome = await mountShellChrome(document);

    const before = liveRegionTexts(document);
    chrome.statusLine.textContent = failure.status;
    const element = toast(failure.message, true);
    const announced = announcedRegions(document, before);

    assert.equal(announced.length, 1, `exactly one announcement, got ${JSON.stringify(announced.map((item) => item.text))}`);
    assert.equal(announced[0].text, failure.message);
    assert.equal(announced[0].element, element, "the toast is the announcer, not the topbar status region");
    assert.equal(announced[0].element.getAttribute("role"), "alert");
    assert.equal(chrome.statusLine.textContent, failure.status, "the visible status summary is preserved");
    assert.equal(chrome.topbarStatus.textContent, "连接中", "the polite region never carried the failure");
  });
}

// --- D4: the reconnect hint is the only announcer -----------------------------

withChrome("D4 a session expiry announces exactly once, through the reconnect hint", async ({ document }) => {
  await mountShellChrome(document);
  const host = document.getElementById("reconnect-host");
  assert.ok(host, "the shipped topbar still carries the reconnect host");

  // Real `attachReconnect` + real supervisor + real hint; only the probe/clock are fake.
  const { supervisor } = createHarness({ statuses: [401] });
  const before = liveRegionTexts(document);
  const attached = attachReconnect({ host, win: globalThis, doc: document, supervisor });
  try {
    await supervisor.probeNow();
    const announced = announcedRegions(document, before);

    assert.equal(announced.length, 1, `exactly one announcement, got ${JSON.stringify(announced.map((item) => item.text))}`);
    assert.equal(announced[0].text, SESSION_EXPIRED_TEXT);
    assert.equal(announced[0].element.getAttribute("role"), "status");
    assert.equal(announced[0].element.closest(".reconnect-hint"), announced[0].element, "the persistent hint owns it");
    assert.equal(toasts(document).length, 0, "the hint is not a toast, and no toast repeats the sentence");
    assert.equal(host.querySelector(".reconnect-hint").hidden, false);
  } finally {
    attached.stop();
  }
});

// --- reverse direction: the persistent channel must not regress ---------------

withChrome("the persistent connection label still announces every transition exactly once", async ({ document }) => {
  const chrome = await mountShellChrome(document);

  for (const label of ["实时", "连接中", "重连中", "已暂停"]) {
    const before = liveRegionTexts(document);
    chrome.liveStatusLabel.textContent = label;
    const announced = announcedRegions(document, before);
    assert.equal(announced.length, 1, `${label}: exactly one announcement`);
    assert.equal(announced[0].text, label);
    assert.equal(announced[0].element, chrome.topbarStatus, `${label}: announced by the polite topbar region`);
  }
  assert.equal(toasts(document).length, 0);
});

// --- source contract for the entry (bootstrap modules cannot be imported) -----

test("core/app.js keeps every transient channel single-owner", async () => {
  const app = await readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");

  // D4: the sentence belongs to `reconnect-supervisor.js` (HINT_LABELS). The entry
  // must attach the hint without re-announcing the same text through a toast.
  assert.doesNotMatch(app, /登录已失效/);
  const attach = app.match(/attachReconnect\(\{[\s\S]*?\}\);/);
  assert.ok(attach, "the entry still attaches the reconnect hint");
  assert.match(attach[0], /#reconnect-host/);
  assert.doesNotMatch(attach[0], /toast/);

  // D1-D3: inside `saveNote()` the only text write target is `status`, which the
  // shipped chrome above places outside every live region.
  const saveNote = app.slice(app.indexOf("async function saveNote()"), app.indexOf("async function reloadFromDisk"));
  assert.ok(saveNote.startsWith("async function saveNote()") && saveNote.includes("toast("), "saveNote must still be found and still toast failures");
  const targets = [...saveNote.matchAll(/([A-Za-z_$][\w$]*)\.textContent\s*=/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(targets)], ["status"]);
});
