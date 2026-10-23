import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// E1 P0-B: caret device-pixel paint policy.
//
// Behavior contract for the paint-only caret alignment. The real rasterization
// is verified by the browser harness/probe; these tests pin the deterministic
// arithmetic the paint step relies on, and guard that the paint step stays
// paint-only (no second position state machine).
import {
  caretPaintTarget,
  caretSnapSettled,
  deviceGridLeft,
} from "../frontend/app/features/editor/extensions/caret-metrics.js";

const caretSource = fs.readFileSync(
  fileURLToPath(new URL("../frontend/app/features/editor/extensions/caret.js", import.meta.url)),
  "utf8",
);

const INTEGRAL_DPRS = [1, 2, 3];
const FRACTIONAL_DPRS = [1.25, 1.5, 1.75];
// Sub-pixel layout phases that occur from real glyph advances and zoom.
const PHASES = [];
for (let i = 0; i <= 20; i += 1) PHASES.push(400 + i * 0.05);

test("caret paint target lands exactly on the device-pixel grid", () => {
  for (const dpr of [...INTEGRAL_DPRS, ...FRACTIONAL_DPRS]) {
    for (const layoutLeft of PHASES) {
      const target = deviceGridLeft(layoutLeft, dpr);
      const device = target * dpr;
      assert.ok(
        Math.abs(device - Math.round(device)) < 1e-9,
        `deviceGridLeft(${layoutLeft}, ${dpr}) -> ${target} is not on the device grid (device=${device})`,
      );
      // The move must never exceed half a device pixel.
      assert.ok(
        Math.abs(target - layoutLeft) <= 0.5 / dpr + 1e-9,
        `deviceGridLeft(${layoutLeft}, ${dpr}) moved ${target - layoutLeft} CSS px`,
      );
    }
  }
});

test("caret paint target is idempotent", () => {
  for (const dpr of [...INTEGRAL_DPRS, ...FRACTIONAL_DPRS]) {
    for (const layoutLeft of PHASES) {
      const once = deviceGridLeft(layoutLeft, dpr);
      assert.equal(deviceGridLeft(once, dpr), once, `not idempotent at dpr=${dpr}, left=${layoutLeft}`);
    }
  }
});

test("caret paint target is representable in integral-DPR CSS layout", () => {
  // At integral DPR the grid step (1/DPR) is exactly representable by Blink's
  // LayoutUnit (1/64 px), so the layout write itself guarantees a crisp rect.
  for (const dpr of INTEGRAL_DPRS) {
    for (const layoutLeft of PHASES) {
      const target = deviceGridLeft(layoutLeft, dpr);
      assert.ok(Number.isInteger(target * dpr), `dpr=${dpr} target=${target} is not layout-representable`);
    }
  }
});

test("caret paint adjustment moves the layout left, not a fractional transform", () => {
  // A fractional-positioned caret must become device aligned by moving its
  // layout `left`; the transform path is what antialiases integral DPR.
  for (const dpr of INTEGRAL_DPRS) {
    for (const viewportLeft of PHASES) {
      const { left, delta, changed } = caretPaintTarget({ rawLeft: viewportLeft, viewportLeft, dpr });
      const landed = viewportLeft + delta;
      assert.ok(Math.abs(landed * dpr - Math.round(landed * dpr)) < 1e-9,
        `dpr=${dpr} viewportLeft=${viewportLeft} target is off grid`);
      assert.equal(left, landed, "left write and delta disagree");
      assert.equal(changed, Math.abs(delta) > 1e-4, "changed flag disagrees with delta");
    }
  }
});

test("fractional-DPR caret snap settles instead of re-firing forever", () => {
  // Regression for the observer write loop: Blink read-back of `style.left` is
  // rounded to the 1/64 px LayoutUnit, so a guard that remembers the requested
  // float never matches and keeps writing at fractional DPR.
  const round64 = (value) => Math.round(value * 64) / 64;
  const simulate = (dpr, storeReadBack) => {
    let rawLeft = 100.05;
    let snappedLeft;
    let writes = 0;
    for (let i = 0; i < 50; i += 1) {
      if (caretSnapSettled(rawLeft, snappedLeft)) return { settled: true, writes };
      const viewportLeft = round64(rawLeft - 1);
      const { left, changed } = caretPaintTarget({ rawLeft, viewportLeft, dpr });
      if (!changed) return { settled: true, writes };
      writes += 1;
      rawLeft = Number.parseFloat(String(round64(left)));
      snappedLeft = storeReadBack ? rawLeft : left;
    }
    return { settled: false, writes };
  };
  for (const dpr of FRACTIONAL_DPRS) {
    const fixed = simulate(dpr, true);
    assert.equal(fixed.settled, true, `dpr=${dpr} never settled (writes=${fixed.writes})`);
    assert.ok(fixed.writes <= 2, `dpr=${dpr} took ${fixed.writes} writes to settle`);
  }
  // The read-back guard is what makes that termination possible.
  assert.equal(caretSnapSettled(100.203, 100.203125), false);
  assert.equal(caretSnapSettled(100.203, 100.203), true);
});

test("caret paint step is paint-only and does not use a fractional translate", () => {
  // Guard the invariant from the TODO: caret paint must never become a second
  // position state machine, and must not reintroduce the fractional-transform
  // snap that antialiases the caret at integral DPR.
  assert.doesNotMatch(caretSource, /\.translate\s*=/, "caret paint must not set a CSS translate");
  assert.doesNotMatch(caretSource, /dispatch\s*\(/, "caret paint must not dispatch transactions");
  assert.doesNotMatch(caretSource, /state\.selection/, "caret paint must not read/write selection state");
  assert.doesNotMatch(caretSource, /EditorSelection/, "caret paint must not construct selections");
  assert.match(caretSource, /\.style\.left\s*=/, "caret paint must align the layout left");
  assert.match(caretSource, /caret-metrics/, "caret paint must use the shared device-grid helper");
});
