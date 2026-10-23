import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateCacheFor,
  estimateCacheKey,
  estimateThemeSignature,
  estimatedTableHeight,
  heuristicTableHeight,
} from "../frontend/app/features/editor/extensions/table-surface-dom.js";

function tableModel(overrides = {}) {
  return {
    from: 0,
    to: 38,
    source: "| alpha | beta |\n| --- | --- |\n| one | two |\n",
    columnCount: 2,
    alignments: ["left", "left"],
    blankBefore: false,
    blankAfter: false,
    rows: [
      {
        header: true,
        cells: [
          { from: 2, to: 7, value: "alpha" },
          { from: 10, to: 14, value: "beta" },
        ],
      },
      {
        header: false,
        cells: [
          { from: 26, to: 29, value: "one" },
          { from: 32, to: 35, value: "two" },
        ],
      },
    ],
    ...overrides,
  };
}

// Minimal duck-typed EditorView: only what the estimate path reads. The
// resolved-style object mirrors the shape of a real CSSStyleDeclaration for the
// properties the theme signature enumerates.
function themeStyle(vars) {
  return {
    fontSize: "16px",
    lineHeight: "1.65",
    fontFamily: "\"Recursive\", serif",
    fontWeight: "400",
    fontStyle: "normal",
    letterSpacing: "normal",
    wordSpacing: "0px",
    whiteSpace: "normal",
    wordBreak: "normal",
    overflowWrap: "anywhere",
    textTransform: "none",
    direction: "ltr",
    zoom: "1",
    paddingTop: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
    paddingRight: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    getPropertyValue(name) {
      return vars[name] ?? "";
    },
  };
}

function fakeView(vars = {}) {
  const state = { vars: { ...vars } };
  return {
    state,
    contentDOM: {},
    dom: { ownerDocument: { defaultView: { getComputedStyle: () => themeStyle(state.vars) } } },
  };
}

test("Table Surface v2.11 reads the theme signature from the owning editor table tokens", () => {
  const base = estimateThemeSignature(fakeView({
    "--table-text-size": "16px",
    "--font-text-size": "16px",
  }));
  assert.notEqual(base, "");
  assert.ok(base.includes("--table-text-size=16px"), base);
  assert.ok(base.includes("--font-text-size=16px"), base);
  assert.ok(base.includes("fontSize=16px"), base);

  const themed = estimateThemeSignature(fakeView({
    "--table-text-size": "22px",
    "--font-text-size": "16px",
  }));
  assert.notEqual(themed, base);
  assert.ok(themed.includes("--table-text-size=22px"), themed);

  // A view without a resolved-style source must degrade to an empty signature
  // instead of throwing: the height map runs before the DOM may exist.
  assert.equal(estimateThemeSignature(null), "");
  assert.equal(estimateThemeSignature({ contentDOM: {} }), "");
  assert.equal(estimateThemeSignature({ dom: { ownerDocument: {} }, contentDOM: {} }), "");
  // A style source that throws (detached / non-Element target) must stay total.
  assert.equal(estimateThemeSignature({
    contentDOM: {},
    dom: {
      ownerDocument: {
        defaultView: {
          getComputedStyle() {
            throw new Error("detached");
          },
        },
      },
    },
  }), "");
});

test("Table Surface v2.11 keys every estimate by exact per-view geometry", () => {
  const viewA = fakeView({ "--table-text-size": "16px" });
  const viewB = fakeView({ "--table-text-size": "16px" });
  // The cache is owned by the measuring view; two editors never share entries.
  assert.notEqual(estimateCacheFor(viewA), estimateCacheFor(viewB));
  assert.equal(estimateCacheFor(viewA), estimateCacheFor(viewA));

  const model = tableModel();
  const signature = estimateThemeSignature(viewA);
  const key = estimateCacheKey(model, 700, signature);
  assert.equal(key, estimateCacheKey(model, 700, signature));
  // Exact column width, never a rounded bucket: equal-source tables in
  // different-width panes must not collide.
  assert.notEqual(key, estimateCacheKey(model, 700.5, signature));
  // blankBefore/blankAfter live outside model.source but change block padding.
  assert.notEqual(key, estimateCacheKey({ ...model, blankBefore: true }, 700, signature));
  assert.notEqual(key, estimateCacheKey({ ...model, blankAfter: true }, 700, signature));
  // Typography and source both participate.
  assert.notEqual(
    key,
    estimateCacheKey(model, 700, estimateThemeSignature(fakeView({ "--table-text-size": "22px" }))),
  );
  assert.notEqual(key, estimateCacheKey({ ...model, source: `${model.source}\n` }, 700, signature));
});

test("Table Surface v2.11 reuses one measurement per view/theme and invalidates on change", () => {
  const view = fakeView({ "--table-text-size": "16px" });
  const model = tableModel();
  let calls = 0;
  const measure = () => {
    calls += 1;
    return 100 + calls;
  };

  const first = estimatedTableHeight(model, view, measure);
  assert.equal(calls, 1);
  // Same view, same theme, same source: served from the cache.
  assert.equal(estimatedTableHeight(model, view, measure), first);
  assert.equal(calls, 1);

  // A live theme change must produce a new signature and remeasure.
  view.state.vars["--table-text-size"] = "22px";
  const themed = estimatedTableHeight(model, view, measure);
  assert.equal(calls, 2);
  assert.notEqual(themed, first);
  assert.equal(estimatedTableHeight(model, view, measure), themed);
  assert.equal(calls, 2);

  // Same source with different adjacent blank lines must not reuse the entry.
  const blankedModel = { ...model, blankBefore: true };
  const blanked = estimatedTableHeight(blankedModel, view, measure);
  assert.equal(calls, 3);
  assert.notEqual(blanked, themed);
  assert.equal(estimatedTableHeight({ ...blankedModel }, view, measure), blanked);
  assert.equal(calls, 3);

  // A different editor at the same theme keeps its own measurement.
  const other = fakeView({ "--table-text-size": "16px" });
  let otherCalls = 0;
  assert.equal(estimatedTableHeight(model, other, () => {
    otherCalls += 1;
    return 120;
  }), 120);
  assert.equal(otherCalls, 1);
  assert.equal(calls, 3);
});

test("Table Surface v2.11 falls back to the fixed heuristic without a measurable view", () => {
  const model = tableModel();
  const heuristic = heuristicTableHeight(model);
  assert.ok(heuristic > 0);
  assert.equal(heuristic, heuristicTableHeight(model));

  // No view at all (pure state fixture / server-side tooling).
  assert.equal(estimatedTableHeight(model, null), heuristic);
  assert.equal(estimatedTableHeight(model, undefined), heuristic);
  // View-shaped object without a content box.
  assert.equal(estimatedTableHeight(model, {}), heuristic);

  // A measurement failure must not escape into the height map.
  assert.equal(estimatedTableHeight(model, fakeView(), () => {
    throw new Error("no layout engine");
  }), heuristic);

  // A throwing style source must not escape either: the signature degrades to
  // empty and the estimate still resolves (here via a working measurement).
  const throwingStyleView = () => ({
    contentDOM: {},
    dom: {
      ownerDocument: {
        defaultView: {
          getComputedStyle() {
            throw new Error("detached");
          },
        },
      },
    },
  });
  assert.equal(estimatedTableHeight(model, throwingStyleView(), () => 100), 100);
  assert.equal(estimatedTableHeight(model, throwingStyleView(), () => null), heuristic);

  // An unmeasurable probe (detached host / zero rect) is not cached: the next
  // call retries the real measurement instead of freezing the heuristic.
  let calls = 0;
  const view = fakeView();
  const nullMeasure = () => {
    calls += 1;
    return null;
  };
  assert.equal(estimatedTableHeight(model, view, nullMeasure), heuristic);
  assert.equal(estimatedTableHeight(model, view, nullMeasure), heuristic);
  assert.equal(calls, 2);
});
