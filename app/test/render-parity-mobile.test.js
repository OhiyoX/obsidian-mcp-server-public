// Offline guards for the Phase 1-M mobile (narrow viewport) parity gate.
//
// The bounded Chromium gate (`scripts/render-parity-phase1-mobile.mjs`) owns the
// computed-paint proof at 375x812 / 720x900. These fast checks keep the pieces a
// reviewer must be able to trust from drifting:
//
//   1. the gate owns exactly the two narrow viewports (1440 stays the existing
//      CI step's job) and still asserts the untouched core KINDS matrix;
//   2. the "kind is not rendered here" allowlist is EMPTY by default: a missing
//      canonical anchor is a failure until a reason is written down;
//   3. the report rows carry the viewport size and the measured host layout, so
//      the evidence requirement (clientHeight, host mode) cannot be dropped;
//   4. the `clientHeight > 0` guard fails with the measured dimensions;
//   5. the Live surface is merged over the whole scroll range, ends included.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXPECTED, KINDS } from "../scripts/render-parity-theme-core.mjs";
import {
  COMMUNITY_NARROW_WIDTH,
  LIVE_SCROLL_FRACTIONS,
  MOBILE_ALLOWLIST,
  MOBILE_VIEWPORTS,
  classifyMissingAnchors,
  describeHostLayout,
  mergeSnapshot,
  summarizeViewport,
} from "../scripts/render-parity-phase1-mobile.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Chromium job lives at the repository root, one level above `app/`.
const repoRoot = path.resolve(appRoot, "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");
const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

test("the gate owns exactly the two narrow viewports", () => {
  assert.deepEqual(MOBILE_VIEWPORTS.map(({ label, width, height }) => ({ label, width, height })), [
    { label: "mobile", width: 375, height: 812 },
    { label: "breakpoint-720", width: 720, height: 900 },
  ]);
  for (const viewport of MOBILE_VIEWPORTS) {
    assert.ok(viewport.width <= 720, `${viewport.label}: 1440/desktop stays with the existing CI step`);
    assert.ok(viewport.height > 0);
  }
  assert.equal(new Set(MOBILE_VIEWPORTS.map((viewport) => viewport.label)).size, MOBILE_VIEWPORTS.length);
  assert.equal(COMMUNITY_NARROW_WIDTH, MOBILE_VIEWPORTS[0].width);
});

test("the narrow gate asserts the same untouched 24-kind matrix", () => {
  assert.equal(KINDS.length, 24);
  const expectedIds = new Set(Object.keys(EXPECTED));
  for (const kind of KINDS) {
    assert.ok(expectedIds.has(kind.id), `${kind.id}: the core expectation table must still cover it`);
    assert.ok(kind.props.reader.length, `${kind.id} needs Reader props`);
  }
});

test("the non-rendering allowlist is empty by default and cannot silently excuse a kind", () => {
  assert.deepEqual(MOBILE_ALLOWLIST.nonRendering, []);
  const missing = { surface: "reader@375x812", kind: "callout", prop: "found", expected: "element", actual: "missing" };
  const declared = { surface: "reader@375x812", kind: "callout", prop: "color", expected: "rgb(1, 2, 3)", actual: "rgb(0, 0, 0)" };
  const strict = classifyMissingAnchors([missing], MOBILE_ALLOWLIST, "mobile");
  assert.equal(strict.failures.length, 1);
  assert.equal(strict.allowed.length, 0);
  // A value mismatch is never treated as a non-rendering allowlist candidate.
  assert.equal(classifyMissingAnchors([declared]).failures.length, 1);
  // An allowlist entry only excuses the anchor it names, on the viewport it names.
  const allowlist = { nonRendering: [{ viewport: "mobile", surface: "reader", kind: "callout", reason: "measured: none at 375" }] };
  const allowed = classifyMissingAnchors([missing], allowlist, "mobile");
  assert.equal(allowed.failures.length, 0);
  assert.equal(allowed.allowed[0].reason, "measured: none at 375");
  assert.equal(classifyMissingAnchors([missing], allowlist, "breakpoint-720").failures.length, 1);
  assert.equal(classifyMissingAnchors([{ ...missing, kind: "footnote" }], allowlist, "mobile").failures.length, 1);
});

test("report rows carry the viewport, its host modes and its measured layout", () => {
  const record = {
    label: "mobile", width: 375, height: 812,
    modes: { reader: "document mode-preview", live: "document mode-live" },
    layout: { reader: { clientHeight: 1665 }, live: { clientHeight: 716, scrollHeight: 1763 } },
    mismatches: [], allowlistedMissing: [], environmentMismatches: [], problems: [], control: null,
  };
  const passed = summarizeViewport(record);
  assert.equal(passed.viewport, "mobile");
  assert.deepEqual([passed.width, passed.height], [375, 812]);
  assert.equal(passed.status, "passed");
  assert.equal(passed.layout.live.clientHeight, 716);
  assert.match(passed.modes.live, /mode-live/);
  assert.equal(passed.control, null);
  const failed = summarizeViewport({
    ...record,
    control: { mismatches: [1, 2], unchanged: ["live callout color stayed"] },
    allowlistedMissing: [{ kind: "footnote" }],
    mismatches: [{ kind: "callout" }],
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.mismatches, 1);
  assert.equal(failed.allowlistedMissing, 1);
  assert.deepEqual(failed.control, { unchanged: 1, mismatches: 2 });
  assert.equal(summarizeViewport({ ...record, problems: ["boom"] }).status, "failed");
});

test("a host without layout fails with the measured dimensions", () => {
  const base = { viewport: "375x812", surface: "live", mode: "document mode-live" };
  assert.equal(describeHostLayout({ ...base, clientHeight: 1, clientWidth: 375 }), null);
  for (const clientHeight of [0, null, undefined, "0"]) {
    const message = describeHostLayout({ ...base, clientHeight, clientWidth: 0 });
    assert.ok(message, `clientHeight=${String(clientHeight)} must fail`);
    assert.match(message, /live@375x812/);
    assert.match(message, /clientHeight/);
    assert.match(message, /mode-live/);
  }
});

test("Live snapshots merge across the whole scroll range, ends included", () => {
  assert.equal(LIVE_SCROLL_FRACTIONS[0], 1);
  assert.equal(LIVE_SCROLL_FRACTIONS.at(-1), 0);
  const found = { found: true, values: { color: "rgb(1, 2, 3)" } };
  const missing = { found: false };
  const merged = mergeSnapshot(mergeSnapshot({ list: missing, hr: found }, { list: found }), { hr: { found: true, values: { color: "rgb(9, 9, 9)" } } });
  assert.equal(merged.list.found, true);
  assert.equal(merged.hr.values.color, "rgb(1, 2, 3)", "the first found entry wins");
});

test("the Chromium job wires the narrow gate and uploads its artifacts", () => {
  const ci = readRepo(".github/workflows/ci.yml");
  assert.match(ci, /node scripts\/render-parity-phase1-mobile\.mjs/);
  assert.match(ci, /timeout --signal=TERM --kill-after=15s 300s node scripts\/render-parity-phase1-mobile\.mjs/);
  assert.match(ci, /name: render-parity-phase1-mobile/);
  assert.match(ci, /RENDER_PARITY_OUTPUT: \$\{\{ runner\.temp \}\}\/render-parity-phase1-mobile/);
});
