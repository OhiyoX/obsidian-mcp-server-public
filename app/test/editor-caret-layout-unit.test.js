import assert from "node:assert/strict";
import test from "node:test";

// L1 regression: the DPR=2 caret snap wrote `rawLeft + delta` as a double. Blink
// stores `style.left` as a 1/64 px LayoutUnit and serializes the *specified*
// float back, so a sum that lands strictly inside a LayoutUnit truncates one
// unit short of the device grid (pos 26: specified 123.49975 -> used 123.484375
// -> rect.left 437.484375 instead of 437.5). These tests pin the LayoutUnit
// pre-rounding that makes the write exact, and the exact failing sample.
import {
  LAYOUT_UNIT,
  caretPaintTarget,
  deviceGridLeft,
  layoutUnitLeft,
} from "../frontend/app/features/editor/extensions/caret-metrics.js";

const isLayoutUnitExact = (value) => Math.abs(value / LAYOUT_UNIT - Math.round(value / LAYOUT_UNIT)) < 1e-9;

// Device-grid exactness is only representable when 1/dpr is a multiple of the
// LayoutUnit (dpr divides 64); fractional DPR stays LayoutUnit-limited and is
// covered by the browser probe, not this unit test.
const INTEGRAL_DPRS = [1, 2, 4];
// Containing-block offsets that are themselves device aligned for every dpr above.
const ALIGNED_BLOCKS = [0, 314, 314.25, 314.5, 127.5];

test("layoutUnitLeft snaps a CSS write onto Blink's 1/64 px LayoutUnit grid", () => {
  assert.equal(LAYOUT_UNIT, 1 / 64);
  assert.equal(layoutUnitLeft(123.49975), 123.5);
  assert.equal(layoutUnitLeft(123.281), 123.28125);
  assert.equal(layoutUnitLeft(100), 100);
  for (const value of [0, 0.01, 400.05, 437.5, 123.49975, 146.99975, -12.34]) {
    const snapped = layoutUnitLeft(value);
    assert.ok(isLayoutUnitExact(snapped), `layoutUnitLeft(${value}) -> ${snapped} is not LayoutUnit exact`);
    assert.ok(Math.abs(snapped - value) <= LAYOUT_UNIT / 2 + 1e-9, `layoutUnitLeft(${value}) moved too far`);
    assert.equal(layoutUnitLeft(snapped), snapped, "layoutUnitLeft must be idempotent");
  }
});

test("DPR=2 pos-26 sample lands on the device grid only after the LayoutUnit write", () => {
  const dpr = 2;
  // The cursor layer sits at x=315 and the theme sets margin-left:-1px, so the
  // caret's containing block is K=314.
  const containingBlock = 314;
  const rawLeft = 123.281; // CodeMirror's specified value
  const usedLeft = 123.28125; // what Blink actually laid out
  const viewportLeft = containingBlock + usedLeft;
  assert.equal(viewportLeft, 437.28125);

  const { left, delta, changed } = caretPaintTarget({ rawLeft, viewportLeft, dpr });
  assert.equal(changed, true);
  assert.equal(left, 123.49975, "raw sum is the pre-fix write");
  assert.equal(delta, 437.5 - 437.28125);

  // The raw sum is not LayoutUnit representable; the engine quantizes it and the
  // caret used to land at 437.484375 (874.96875 physical, 0.03125 off grid).
  assert.equal(isLayoutUnitExact(left), false);
  const truncated = Math.trunc(left / LAYOUT_UNIT) * LAYOUT_UNIT;
  assert.equal(containingBlock + truncated, 437.484375);

  // Pre-rounding to the LayoutUnit grid reproduces the intended layout left and
  // the physical edge is an integer.
  const write = layoutUnitLeft(left);
  assert.ok(isLayoutUnitExact(write));
  const rectLeft = containingBlock + write;
  assert.equal(rectLeft, 437.5);
  assert.equal(rectLeft * dpr, 875);
  assert.equal((rectLeft + 2) * dpr, 879);
});

test("quantized writes put the caret rect on the device grid at integral DPR", () => {
  const phased = [];
  for (let i = 0; i <= 40; i += 1) phased.push(120 + i * 0.05);
  for (const dpr of INTEGRAL_DPRS) {
    for (const containingBlock of ALIGNED_BLOCKS) {
      for (const specified of phased) {
        // Model CodeMirror's specified value and Blink's used value: the used
        // value is the specified float quantized to a LayoutUnit.
        const used = layoutUnitLeft(specified);
        const viewportLeft = containingBlock + used;
        const { left, changed } = caretPaintTarget({ rawLeft: specified, viewportLeft, dpr });
        const write = layoutUnitLeft(left);
        const rectLeft = containingBlock + write;
        assert.ok(
          Math.abs(rectLeft * dpr - Math.round(rectLeft * dpr)) < 1e-9,
          `dpr=${dpr} K=${containingBlock} specified=${specified} -> rect=${rectLeft} off grid`,
        );
        if (changed) {
          // The desired layout left is a device/LayoutUnit multiple, so the
          // quantized write is exactly it (never one LayoutUnit short).
          const target = deviceGridLeft(viewportLeft, dpr);
          assert.ok(isLayoutUnitExact(target - containingBlock));
          assert.equal(write, target - containingBlock);
        }
      }
    }
  }
});

test("LayoutUnit write keeps DPR=1 caret edges integral (E1 antialiasing invariant)", () => {
  const phased = [];
  for (let i = 0; i <= 40; i += 1) phased.push(100 + i * 0.05);
  for (const containingBlock of [0, 314, 315]) {
    for (const specified of phased) {
      const used = layoutUnitLeft(specified);
      const viewportLeft = containingBlock + used;
      const { left } = caretPaintTarget({ rawLeft: specified, viewportLeft, dpr: 1 });
      const write = layoutUnitLeft(left);
      assert.ok(isLayoutUnitExact(write), `specified=${specified} write=${write} not LayoutUnit exact`);
      const rectLeft = containingBlock + write;
      assert.equal(rectLeft, Math.round(rectLeft), `specified=${specified} rect=${rectLeft} is not integral at DPR1`);
      assert.equal(rectLeft + 2, Math.round(rectLeft + 2));
    }
  }
});
