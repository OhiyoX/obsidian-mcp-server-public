// Announcement counting for the Web live-region assertions.
//
// Extracted verbatim from `web-toast-live-region.test.js` (#411) so that file and the
// #422 double-announcement file count announcements the same way: one region is one
// announcement channel, and a region whose text changed to something non-empty (or that
// appeared with content) announces once. A nested container + child pair counts twice on
// purpose — that is exactly the double-announcement shape these tests must keep out.

export const LIVE_REGION_SELECTOR = '[role="status"],[role="alert"],[aria-live]';

// Every live region currently in the document (an `aria-live="off"` node is not
// an announcement channel by definition).
export function liveRegions(doc) {
  return doc.body.querySelectorAll(LIVE_REGION_SELECTOR)
    .filter((element) => element.getAttribute("aria-live") !== "off");
}

export function liveRegionTexts(doc) {
  return new Map(liveRegions(doc).map((element) => [element, element.textContent]));
}

// Every region a screen reader would announce since `before`: a live region that
// appeared with content, or an existing one whose text changed to something
// non-empty. Returns the announcing element, so a test can also assert *who* owns
// the announcement (toast / status region / hint).
export function announcedRegions(doc, before) {
  const announced = [];
  for (const [element, text] of liveRegionTexts(doc)) {
    if (!text) continue;
    if (!before.has(element) || before.get(element) !== text) announced.push({ element, text });
  }
  return announced;
}

export function announcedMessages(doc, before) {
  return announcedRegions(doc, before).map(({ text }) => text);
}

export const toasts = (doc) => doc.body.querySelectorAll(".toast");
