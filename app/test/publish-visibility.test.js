import test from "node:test";
import assert from "node:assert/strict";
import { readPublishMarker, isDraftSegment, visibilityOf } from "../src/publish/visibility.js";

test("the marker table", () => {
  assert.equal(readPublishMarker({ publish: true }), "public");
  assert.equal(readPublishMarker({ publish: false }), "private");
  assert.equal(readPublishMarker({ publish: "public" }), "public");
  assert.equal(readPublishMarker({ publish: "private" }), "private");
  assert.equal(readPublishMarker({ private: true }), "private");
  assert.equal(readPublishMarker({}), "none");
  assert.equal(readPublishMarker({ publish: "待定" }), "private", "an unknown value hides");
  assert.equal(readPublishMarker({ publish: false, private: true }), "private");
  assert.equal(readPublishMarker({ publish: true, private: true }), "private");
});

test("non-object data hides the note", () => {
  assert.equal(readPublishMarker(undefined), "private", "a caller that passes undefined must not publish");
});

test("the visibility table", () => {
  const cases = [
    ["public", false, false, "visible"],
    ["public", true, false, "visible"],
    ["private", true, false, "hidden"],
    ["private", false, false, "hidden"],
    ["none", true, false, "visible"],
    ["none", false, false, "hidden"],
    ["none", true, true, "hidden"],
    ["public", true, true, "visible"],
  ];
  for (const [marker, insidePublishedFolder, inDraftSubtree, expected] of cases) {
    assert.equal(visibilityOf({ marker, insidePublishedFolder, inDraftSubtree }), expected, `${marker}/${insidePublishedFolder}/${inDraftSubtree}`);
  }
});

test("a draft segment is _ or . prefixed", () => {
  assert.equal(isDraftSegment("_drafts"), true);
  assert.equal(isDraftSegment(".obsidian"), true);
  assert.equal(isDraftSegment("Notes"), false);
  assert.equal(isDraftSegment("_"), true);
});
