// Shared core for the Phase 1-B "shared geometry token" gate.
//
// The TODO (统一 Markdown 语义渲染服务) requires one geometry contract for both
// hosts: heading before/after spacing, the visible gap between a heading and its
// adjacent block, and the table host geometry/overflow policy. Reader maps the
// tokens to block flow (margins); Live maps the same tokens to measurable line
// padding, because CodeMirror must not use external margins for editable lines.
//
// This gate therefore never asserts "Reader == Live". It asserts that each
// host's MEASURED bounding-box geometry equals the value the real theme.css
// declared for the shared token. A negative control mutates those tokens and
// requires the measured geometry to follow, which rules out "happens to match".
//
// Geometry is measured from bounding boxes and scroll/client widths only: no
// screenshots and no colour sampling are involved.
//
// `collectGeometry` is serialized into the page by `page.evaluate`, so it must
// not close over module scope; everything else here is plain data.

export const GEOMETRY_FIXTURE_RELATIVE = "test/fixtures/render-parity-geometry-fixture.css";
export const GEOMETRY_ALLOWLIST_RELATIVE = "test/fixtures/render-parity-geometry-allowlist.json";
export const GEOMETRY_THEME_NAME = "RenderParityGeometry";
export const MUTATED_GEOMETRY_THEME_NAME = "RenderParityGeometryMut";

// The geometry tokens the gate asserts. Every name is declared by app.css as
// the Web fallback and overridden by the geometry theme fixture, so the probe
// proves the value came from the theme file through the normal cascade.
export const GEOMETRY_TOKENS = [
  "--md-heading-space-before",
  "--md-heading-space-after",
  "--md-block-gap",
  "--md-list-item-gap",
  "--md-table-inline-size",
  "--md-table-box-sizing",
  "--md-table-overflow-x",
  "--md-table-overflow-x-active",
  "--md-table-overflow-tolerance",
];

// Canonical probe document. Every heading/target pair is DIRECTLY adjacent (no
// blank source line), so the measured gap is the spacing contract itself rather
// than a source-line spacer. A HEADING->block pair proves the after-space token;
// a block->HEADING pair proves the before-space token.
export const GEOMETRY_PROBE_SOURCE = `# HNAF0MARK
GAPAF0MARK paragraph after heading

# HNAF1MARK
- GAPAF1MARK list item after heading

# HNAF2MARK
> GAPAF2MARK quote after heading

# HNAF3MARK
\`\`\`
GAPAF3MARK code after heading
\`\`\`

# HNAF4MARK
| GAPAF4MARK | col2 |
| --- | --- |
| cell1 | cell2 |

GAPBF0MARK paragraph before heading
# HNB0MARK

- GAPBF1MARK list before heading
# HNB1MARK

> GAPBF2MARK quote before heading
# HNB2MARK

\`\`\`
GAPBF3MARK code before heading
\`\`\`
# HNB3MARK

| GAPBF4MARK | col2 |
| --- | --- |
| cell1 | cell2 |
# HNB4MARK

| WIDE1MARK | W2MARK | W3MARK | W4MARK | W5MARK | W6MARK | W7MARK | W8MARK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| w1 | wide content value | another wide value | more content | extra column | overflow probe | wide cell | last cell |
`;

function heading(level, needle) {
  return { needle, climb: `h${level}` };
}

// `direction: "after"` measures heading -> block (after-space token);
// `direction: "before"` measures block -> heading (before-space token).
export const ADJACENCIES = [
  {
    id: "after-heading1-paragraph",
    direction: "after",
    readerHeading: heading(1, "HNAF0MARK"),
    readerTarget: { needle: "GAPAF0MARK", climb: "p" },
    liveHeading: { needle: "HNAF0MARK" },
    liveTarget: { needle: "GAPAF0MARK", kind: "text" },
  },
  {
    id: "after-heading2-list",
    direction: "after",
    readerHeading: heading(2, "HNAF1MARK"),
    readerTarget: { needle: "GAPAF1MARK", climb: "ul" },
    liveHeading: { needle: "HNAF1MARK" },
    liveTarget: { needle: "GAPAF1MARK", kind: "text" },
  },
  {
    id: "after-heading3-quote",
    direction: "after",
    readerHeading: heading(3, "HNAF2MARK"),
    readerTarget: { needle: "GAPAF2MARK", climb: "blockquote" },
    liveHeading: { needle: "HNAF2MARK" },
    liveTarget: { needle: "GAPAF2MARK", kind: "text" },
  },
  {
    id: "after-heading4-code",
    direction: "after",
    readerHeading: heading(4, "HNAF3MARK"),
    readerTarget: { needle: "GAPAF3MARK", climb: "pre" },
    liveHeading: { needle: "HNAF3MARK" },
    liveTarget: { needle: "GAPAF3MARK", kind: "code", fallbackNeedle: "HNAF3MARK" },
  },
  {
    id: "after-heading5-table",
    direction: "after",
    readerHeading: heading(5, "HNAF4MARK"),
    readerTarget: { needle: "GAPAF4MARK", climb: ".table-scroll" },
    liveHeading: { needle: "HNAF4MARK" },
    liveTarget: { needle: "GAPAF4MARK", kind: "table" },
  },
  {
    id: "before-heading1-paragraph",
    direction: "before",
    readerHeading: heading(1, "HNB0MARK"),
    readerTarget: { needle: "GAPBF0MARK", climb: "p" },
    liveHeading: { needle: "HNB0MARK" },
    liveTarget: { needle: "GAPBF0MARK", kind: "text" },
  },
  {
    id: "before-heading2-list",
    direction: "before",
    readerHeading: heading(2, "HNB1MARK"),
    readerTarget: { needle: "GAPBF1MARK", climb: "ul" },
    liveHeading: { needle: "HNB1MARK" },
    liveTarget: { needle: "GAPBF1MARK", kind: "text" },
  },
  {
    id: "before-heading3-quote",
    direction: "before",
    readerHeading: heading(3, "HNB2MARK"),
    readerTarget: { needle: "GAPBF2MARK", climb: "blockquote" },
    liveHeading: { needle: "HNB2MARK" },
    liveTarget: { needle: "GAPBF2MARK", kind: "text" },
  },
  {
    id: "before-heading4-code",
    direction: "before",
    readerHeading: heading(4, "HNB3MARK"),
    readerTarget: { needle: "GAPBF3MARK", climb: "pre" },
    liveHeading: { needle: "HNB3MARK" },
    liveTarget: { needle: "GAPBF3MARK", kind: "code", fallbackNeedle: "GAPBF3MARK" },
  },
  {
    id: "before-heading5-table",
    direction: "before",
    readerHeading: heading(5, "HNB4MARK"),
    readerTarget: { needle: "GAPBF4MARK", climb: ".table-scroll" },
    liveHeading: { needle: "HNB4MARK" },
    liveTarget: { needle: "GAPBF4MARK", kind: "table" },
  },
];

// One narrow table and one deliberately wide table. The wide one must make the
// shared overflow policy observable (wrapper scrollWidth > clientWidth).
export const TABLES = [
  { id: "narrow", needle: "GAPAF4MARK", expectOverflow: false },
  { id: "wide", needle: "WIDE1MARK", expectOverflow: true },
];

// The page-side collector lives in its own module: `page.evaluate` serializes it
// by source, so it stays self-contained while this file keeps only plain data.
export { collectGeometry } from "./render-parity-geometry-probe.mjs";

/** Fail when an expectation is not present verbatim in the geometry fixture. */
export function validateGeometryFixture(css, expected = GEOMETRY_EXPECTED) {
  const text = String(css ?? "");
  const problems = [];
  for (const name of GEOMETRY_TOKENS) {
    const value = expected[name];
    if (value == null) {
      problems.push(`expected ${name} is missing`);
      continue;
    }
    if (!new RegExp(`${name}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;`).test(text)) {
      problems.push(`fixture does not declare ${name}: ${value}`);
    }
  }
  return problems;
}

function shiftLength(value) {
  const text = String(value);
  let match = /^(-?\d+(?:\.\d+)?)px$/.exec(text);
  if (match) return `${Number(match[1]) + 8}px`;
  return text;
}

/** Distinct sentinel transform used by the negative control.
 *
 * `overflow-x` mutates between `hidden` and `auto` rather than to `clip`: the
 * Live viewport also declares `overflow-y: hidden`, and per CSS Overflow a
 * `clip` axis paired with a non-visible axis computes to `hidden`, so `clip`
 * would not be observable on both hosts.
 */
const KEYWORD_MUTATION = {
  "border-box": "content-box",
  "content-box": "border-box",
  hidden: "auto",
  auto: "hidden",
  scroll: "hidden",
};

/**
 * Tokens the negative control mutates. `--md-table-inline-size` is deliberately
 * excluded: the shared allocator always fills the host column (measured
 * allocator == column width), so `max(inline-size, allocator)` is dominated by
 * the allocator for any feasible value and no honest measurement would follow a
 * mutation. Its consumption is asserted structurally (both adapters use the
 * token) plus the measured "table box fills the host column" consequence.
 */
export const MUTABLE_GEOMETRY_TOKENS = GEOMETRY_TOKENS.filter((name) => name !== "--md-table-inline-size");

export function mutateGeometryValue(value) {
  const text = String(value);
  if (Object.prototype.hasOwnProperty.call(KEYWORD_MUTATION, text)) return KEYWORD_MUTATION[text];
  return shiftLength(text);
}

/** Rewrite the fixture so the mutated theme declares different geometry. */
export function mutateGeometryCss(css) {
  let out = String(css);
  for (const name of MUTABLE_GEOMETRY_TOKENS) {
    const before = GEOMETRY_EXPECTED[name];
    if (before == null) continue;
    const after = mutateGeometryValue(before);
    if (after === before) continue;
    out = out.replace(
      new RegExp(`(${name}\\s*:\\s*)${before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*;)`, "g"),
      `$1${after}$2`,
    );
  }
  return out;
}

/** Mutated expectations derived from the same transform as `mutateGeometryCss`. */
export function mutatedGeometryExpected(expected = GEOMETRY_EXPECTED) {
  const out = { ...expected };
  for (const name of MUTABLE_GEOMETRY_TOKENS) out[name] = mutateGeometryValue(expected[name]);
  return out;
}

/**
 * Expectations the geometry fixture declares. `--md-heading-space-after` is the
 * gap a heading owns towards the following block; `--md-heading-space-before`
 * is the gap a heading owns towards the previous block.
 */
export const GEOMETRY_EXPECTED = {
  "--md-heading-space-before": "23px",
  "--md-heading-space-after": "19px",
  "--md-block-gap": "27px",
  "--md-list-item-gap": "11px",
  "--md-table-inline-size": "360px",
  "--md-table-box-sizing": "content-box",
  "--md-table-overflow-x": "auto",
  "--md-table-overflow-x-active": "scroll",
  "--md-table-overflow-tolerance": "3px",
};

const px = (value) => Number.parseFloat(String(value));

/**
 * Compare measured geometry against the token declarations. `allowlist.tolerancePx`
 * is the only permitted slack and must stay tiny; `knownEnvironmentFailures`
 * stays empty for this gate.
 */
export function evaluateGeometry(snapshot, expected = GEOMETRY_EXPECTED, allowlist = {}) {
  const tolerance = Number.isFinite(Number(allowlist?.tolerancePx)) ? Number(allowlist.tolerancePx) : 1;
  const spaceAfter = px(expected["--md-heading-space-after"]);
  const spaceBefore = px(expected["--md-heading-space-before"]);
  const inlineSize = px(expected["--md-table-inline-size"]);
  const overflowTolerance = px(expected["--md-table-overflow-tolerance"]);
  const mismatches = [];
  const near = (a, b, tol = tolerance) => Number.isFinite(a) && Math.abs(a - b) <= tol;
  const surface = snapshot?.surface || "unknown";

  for (const adj of ADJACENCIES) {
    const want = adj.direction === "after" ? spaceAfter : spaceBefore;
    {
      const entry = snapshot?.gaps?.[adj.id];
      if (!entry?.found) {
        mismatches.push({ area: "gap", id: adj.id, surface, prop: "found", expected: `${adj.direction} block`, actual: `heading=${entry?.heading} target=${entry?.target}` });
        continue;
      }
      if (!near(entry.visibleGap, want)) {
        mismatches.push({
          area: "gap",
          id: adj.id,
          surface,
          prop: `${adj.direction}-space`,
          expected: `${want}px`,
          actual: `${entry.visibleGap.toFixed(2)}px`,
        });
      }
    }
  }

  for (const spec of TABLES) {
    {
      const entry = snapshot?.tables?.[spec.id];
      if (!entry?.found) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "found", expected: "table+wrapper", actual: `table=${entry?.table} wrapper=${entry?.wrapper}` });
        continue;
      }
      const resolvedInlineSize = String(expected["--md-table-inline-size"]).endsWith("%")
        ? (inlineSize / 100) * entry.wrapperClientWidth
        : inlineSize;
      const wantWidth = Math.max(resolvedInlineSize, entry.allocatorWidth);
      if (!near(entry.tableWidth, wantWidth)) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "tableWidth", expected: `${wantWidth.toFixed(2)}px (max(token ${inlineSize}, allocator ${entry.allocatorWidth}))`, actual: `${entry.tableWidth.toFixed(2)}px` });
      }
      const wantOverflow = entry.overflowAttr ? expected["--md-table-overflow-x-active"] : expected["--md-table-overflow-x"];
      if (entry.overflowX !== wantOverflow) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "overflowX", expected: wantOverflow, actual: entry.overflowX });
      }
      if (entry.allocatorWidth <= 0) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "allocatorWidth", expected: ">0", actual: entry.allocatorRaw || "0" });
      }
      if (entry.boxSizing !== expected["--md-table-box-sizing"]) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "boxSizing", expected: expected["--md-table-box-sizing"], actual: entry.boxSizing });
      }
      if (entry.overflowAttr) {
        if (!(entry.wrapperScrollWidth > entry.wrapperClientWidth)) {
          mismatches.push({ area: "table", id: spec.id, surface, prop: "overflowPolicy", expected: "scrollWidth > clientWidth when data-table-overflow=true", actual: `scroll=${entry.wrapperScrollWidth} client=${entry.wrapperClientWidth}` });
        }
      } else if (!(entry.wrapperScrollWidth <= entry.wrapperClientWidth + overflowTolerance + 0.5)) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "falseOverflow", expected: `scrollWidth <= clientWidth + ${overflowTolerance}px`, actual: `scroll=${entry.wrapperScrollWidth} client=${entry.wrapperClientWidth}` });
      }
      if (entry.overflowAttr !== spec.expectOverflow) {
        mismatches.push({ area: "table", id: spec.id, surface, prop: "overflowAttr", expected: String(spec.expectOverflow), actual: String(entry.overflowAttr) });
      }
    }
  }

  for (const name of GEOMETRY_TOKENS) {
    const want = expected[name];
    const actual = snapshot?.tokens?.[name];
    if (actual !== want) mismatches.push({ area: "token", id: name, surface: "root", prop: name, expected: want, actual: actual ?? "missing" });
  }
  return mismatches;
}

export function describeGeometryMismatch(mismatch) {
  return `${mismatch.area} ${mismatch.surface} ${mismatch.id} ${mismatch.prop}: expected ${mismatch.expected}, measured ${mismatch.actual}`;
}

/** Split mismatches into failing and allow-listed (environment) buckets. */
export function classifyGeometryMismatches(mismatches, allowlist) {
  const known = new Set(allowlist?.knownEnvironmentFailures || []);
  const failures = [];
  const environment = [];
  for (const mismatch of mismatches) {
    const key = `${mismatch.area} ${mismatch.surface} ${mismatch.id} ${mismatch.prop}`;
    if (known.has(key)) environment.push({ ...mismatch, allowlisted: true });
    else failures.push(mismatch);
  }
  return { failures, environment };
}

/**
 * The negative control compares two snapshots: after mutating the geometry
 * tokens, every value the gate asserts must have changed. It also compares the
 * two hosts' table allocator widths, which must agree because both consume the
 * same shared allocator (this is a cross-host check, never a substitute for the
 * per-host token assertions).
 */
export function geometryNegativeControl(before, after, expected, mutatedExpected) {
  const unchanged = [];
  const spaceAfterBefore = px(expected["--md-heading-space-after"]);
  const spaceAfterAfter = px(mutatedExpected["--md-heading-space-after"]);
  const spaceBeforeBefore = px(expected["--md-heading-space-before"]);
  const spaceBeforeAfter = px(mutatedExpected["--md-heading-space-before"]);
  for (const adj of ADJACENCIES) {
    const wantBefore = adj.direction === "after" ? spaceAfterBefore : spaceBeforeBefore;
    const wantAfter = adj.direction === "after" ? spaceAfterAfter : spaceBeforeAfter;
    if (wantBefore === wantAfter) continue;
    const a = before?.gaps?.[adj.id]?.visibleGap;
    const b = after?.gaps?.[adj.id]?.visibleGap;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a - b) < 1) unchanged.push(`gap ${adj.id} stayed ${a.toFixed(2)}px`);
  }
  for (const spec of TABLES) {
    const a = before?.tables?.[spec.id];
    const b = after?.tables?.[spec.id];
    if (!a?.found || !b?.found) continue;
    if (a.boxSizing === b.boxSizing && expected["--md-table-box-sizing"] !== mutatedExpected["--md-table-box-sizing"]) {
      unchanged.push(`table ${spec.id} box-sizing stayed ${a.boxSizing}`);
    }
    if (a.overflowX === b.overflowX && expected["--md-table-overflow-x"] !== mutatedExpected["--md-table-overflow-x"]) {
      unchanged.push(`table ${spec.id} overflow-x stayed ${a.overflowX}`);
    }
  }
  for (const name of GEOMETRY_TOKENS) {
    if (before?.tokens?.[name] === after?.tokens?.[name] && expected[name] !== mutatedExpected[name]) {
      unchanged.push(`token ${name} stayed ${before.tokens[name]}`);
    }
  }
  return unchanged;
}

/**
 * Both hosts must derive their table geometry from the same shared allocator.
 * This is additive evidence, not a replacement for the token assertions above.
 */
export function evaluateAllocatorParity(reader, live, allowlist = {}) {
  const tolerance = Number.isFinite(Number(allowlist?.tolerancePx)) ? Number(allowlist.tolerancePx) : 1;
  const mismatches = [];
  for (const spec of TABLES) {
    for (const key of ["allocatorWidth", "tableWidth"]) {
      const a = reader?.tables?.[spec.id]?.[key];
      const b = live?.tables?.[spec.id]?.[key];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        mismatches.push({ area: "allocator-parity", surface: "reader|live", id: spec.id, prop: key, expected: "both hosts measured", actual: `${a}/${b}` });
        continue;
      }
      if (Math.abs(a - b) > tolerance) {
        mismatches.push({ area: "allocator-parity", surface: "reader|live", id: spec.id, prop: key, expected: `${a.toFixed(2)}px on both hosts`, actual: `${b.toFixed(2)}px` });
      }
    }
  }
  return mismatches;
}
