// Shared core for the Phase 1 "real theme.css inheritance" gate.
//
// The gate proves that every Markdown RenderKind in the TODO matrix takes its
// paint from the Vault's authoritative community `theme.css` (served through
// the production `/api/web/v1/theme.css` endpoint) in BOTH hosts:
//
//   Reader (safe HTML)  and  Live Preview (CodeMirror)
//
// It never compares Reader to Live. It compares each host's computed paint to
// the value the theme file actually declared. A negative control re-runs the
// same probe against a mutated copy of the theme file and requires the computed
// values to follow the declaration, which rules out "happens to be equal".
//
// This module is DOM-free and process-free: `collectThemePaint` is serialized
// into the page by `page.evaluate`, and everything else is plain data.

export const THEME_FIXTURE_RELATIVE = "test/fixtures/render-parity-theme-fixture.css";
export const THEME_ALLOWLIST_RELATIVE = "test/fixtures/render-parity-theme-allowlist.json";
export const THEME_NAME = "RenderParityTheme";
export const MUTATED_THEME_NAME = "RenderParityThemeMut";

// Canonical document covering every RenderKind in the gate matrix. Each marker
// is unique so a probe can resolve the exact node.
export const PROBE_SOURCE = `# H1MARK

PARAMARK paragraph text.

**STRONGMARK**

*EMMARK*

~~DELMARK~~

==HLMARK==

[LINKMARK](https://example.com)

[[WikiTarget|WIKIMARK]]

#TAGMARK

\`ICODEMARK\`

\`\`\`js
const CODEMARK = "STRMARK" + 4242; // COMMENTMARK
\`\`\`

> QUOTEMARK

- LISTMARK

- [ ] TASKMARK
- [x] TASKDONEMARK

| HEADCELL |
| --- |
| CELLMARK |

---
HRMARK

> [!NOTE] CALLOUTMARK
> callout body

> [!TIP]- COLLAPSEDMARK
> collapsed body

![[embed-parity.svg]]

FOOTNOTEMARK[^footmark]

[^footmark]: FOOTDEFMARK footnote definition
`;

function reader(needle, climb) {
  return { selector: null, climb, needle };
}

function live(selector, needle = null, climb = null) {
  return { selector, climb, needle };
}

// The same Markdown kind can expose different geometry on each host (a Reader
// cell owns a top border; the Live table cell owns its right/bottom grid), so
// each kind lists the computed properties per surface. The expected values
// live in EXPECTED below.
const both = (...props) => ({ reader: props, live: props });

export const KINDS = [
  { id: "paragraph", needle: "PARAMARK", props: both("color"), reader: reader("PARAMARK", "p"), live: live(null, "PARAMARK", ".cm-line") },
  { id: "heading1", needle: "H1MARK", props: both("color", "fontSize"), reader: reader("H1MARK", "h1"), live: live(".HyperMD-header-1") },
  { id: "strong", needle: "STRONGMARK", props: both("color", "fontWeight"), reader: reader("STRONGMARK", "strong"), live: live(".cm-strong") },
  { id: "emphasis", needle: "EMMARK", props: both("color"), reader: reader("EMMARK", "em"), live: live(".cm-em") },
  { id: "strikethrough", needle: "DELMARK", props: both("color"), reader: reader("DELMARK", "s"), live: live(".cm-strikethrough") },
  { id: "highlight", needle: "HLMARK", props: both("color", "backgroundColor"), reader: reader("HLMARK", "mark"), live: live(".cm-highlight") },
  { id: "link-external", needle: "LINKMARK", props: both("color"), reader: reader("LINKMARK", "a.external-link"), live: live(".cm-link") },
  { id: "link-internal", needle: "WIKIMARK", props: both("color"), reader: reader("WIKIMARK", "a.internal-link"), live: live(".cm-obsidian-link") },
  { id: "tag", needle: "TAGMARK", props: both("color"), reader: reader("TAGMARK", "a.tag"), live: live(".cm-hashtag") },
  { id: "inline-code", needle: "ICODEMARK", props: both("color", "backgroundColor", "borderTopLeftRadius"), reader: reader("ICODEMARK", "code"), live: live(".cm-inline-code") },
  { id: "code-block", needle: "CODEMARK", props: both("color", "backgroundColor", "borderTopLeftRadius"), reader: reader("CODEMARK", "pre"), live: live(".cm-live-code-lang-line") },
  // Code syntax tokens. Both surfaces must carry the canonical Obsidian token
  // class face so one Vault theme rule paints Reader and Live identically:
  // Live uses `.cm-*` (Desktop app.css "Syntax highlighting" block), Reader
  // uses the `.token *` family for a statically highlighted code block.
  { id: "code-keyword", needle: "const", props: both("color"), reader: { selector: ".token.keyword", climb: null, needle: null }, live: live(".cm-keyword") },
  { id: "code-string", needle: "STRMARK", props: both("color"), reader: { selector: ".token.string", climb: null, needle: null }, live: live(".cm-string") },
  { id: "code-comment", needle: "COMMENTMARK", props: both("color"), reader: { selector: ".token.comment", climb: null, needle: null }, live: live(".cm-comment") },
  { id: "code-number", needle: "4242", props: both("color"), reader: { selector: ".token.number", climb: null, needle: null }, live: live(".cm-number") },
  { id: "quote", needle: "QUOTEMARK", props: both("color"), reader: reader("QUOTEMARK", "blockquote"), live: live(null, "QUOTEMARK", ".HyperMD-quote") },
  { id: "list", needle: "LISTMARK", props: both("color"), reader: reader("LISTMARK", "li"), live: live(null, "LISTMARK", ".HyperMD-list-line") },
  { id: "task", needle: "TASKMARK", props: both("color"), reader: reader("TASKMARK", ".task-list-item"), live: live(".HyperMD-task-line") },
  {
    id: "task-checked",
    needle: "TASKDONEMARK",
    props: { reader: ["color", "textDecorationLine"], live: ["color", "textDecorationLine", "backgroundColor"] },
    reader: reader("TASKDONEMARK", ".task-list-item"),
    live: live(null, "TASKDONEMARK", ".HyperMD-task-line"),
  },
  {
    id: "table",
    needle: "CELLMARK",
    props: { reader: ["color", "borderTopColor"], live: ["color", "borderRightColor"] },
    reader: reader("CELLMARK", "td"),
    live: live(null, "CELLMARK", ".cm-table-cell"),
  },
  { id: "hr", needle: null, props: both("borderTopColor"), reader: { selector: "#preview hr", climb: null, needle: null }, live: live(".HyperMD-hr") },
  // Callout / footnote / embed canonical surfaces (§4 item 3). U15 owns the
  // Reader anchors and the paint they must inherit (Desktop app.css
  // 11253-11393 / 12178-12197); this slice adds the Live anchor for the SAME
  // canonical face (the Live callout block widget renders through the shared
  // Reader renderer, the Live image embed stays in-place wiki chrome, and the
  // Live footnote definition line carries `.HyperMD-footnote`), so ONE Vault
  // theme rule has to paint both hosts. The Live property lists only add
  // computed values that actually move under the negative control's mutation.
  //
  // A Live-only block face (the note embed's `.markdown-embed` container, which
  // the Web Reader deliberately serves as `a.internal-link.internal-embed
  // .note-embed`, see app.css) is deliberately NOT a kind here: the gate's
  // invariant is one Reader anchor plus one Live anchor per kind, and inventing
  // a live-only kind would have to weaken that invariant. That face is probed
  // directly by `render-parity-block-surfaces.mjs` instead.
  {
    id: "callout",
    needle: "CALLOUTMARK",
    props: { reader: ["color", "borderTopLeftRadius", "borderTopWidth"], live: ["color", "backgroundColor"] },
    reader: reader("CALLOUTMARK", ".callout"),
    live: live(".cm-callout .callout"),
  },
  {
    id: "footnote",
    props: { reader: ["fontSize", "color"], live: ["fontSize"] },
    reader: { selector: "#preview .footnotes", climb: null, needle: null },
    live: live(null, "FOOTDEFMARK", ".HyperMD-footnote"),
  },
  {
    id: "embed-image",
    props: both("borderTopLeftRadius"),
    reader: { selector: "#preview img.internal-embed.image-embed", climb: null, needle: null },
    live: live(null, "embed-parity.svg", ".internal-embed.image-embed"),
  },
];

/** Union of the per-surface property lists for one kind. */
export function kindProps(kind) {
  return [...new Set([...(kind.props.reader || []), ...(kind.props.live || [])])];
}

// Expected computed values, kept in lockstep with the fixture declarations by
// `validateFixture` (which fails when a value is absent from the CSS file).
export const EXPECTED = {
  paragraph: { color: "rgb(21, 22, 23)" },
  heading1: { color: "rgb(11, 12, 13)", fontSize: "31px" },
  strong: { color: "rgb(31, 32, 33)", fontWeight: "641" },
  emphasis: { color: "rgb(41, 42, 43)" },
  strikethrough: { color: "rgb(51, 52, 53)" },
  highlight: { color: "rgb(71, 72, 73)", backgroundColor: "rgb(61, 62, 63)" },
  "link-external": { color: "rgb(81, 82, 83)" },
  "link-internal": { color: "rgb(91, 92, 93)" },
  tag: { color: "rgb(101, 102, 103)" },
  "inline-code": { color: "rgb(111, 112, 113)", backgroundColor: "rgb(121, 122, 123)", borderTopLeftRadius: "13px" },
  "code-block": { color: "rgb(131, 132, 133)", backgroundColor: "rgb(141, 142, 143)", borderTopLeftRadius: "9px" },
  "code-keyword": { color: "rgb(231, 232, 233)" },
  "code-string": { color: "rgb(241, 242, 243)" },
  "code-comment": { color: "rgb(251, 252, 253)" },
  "code-number": { color: "rgb(215, 216, 217)" },
  quote: { color: "rgb(161, 162, 163)" },
  callout: { color: "rgb(231, 232, 233)", backgroundColor: "rgb(35, 36, 37)", borderTopLeftRadius: "11px", borderTopWidth: "3px" },
  footnote: { fontSize: "21px", color: "rgb(181, 182, 183)" },
  "embed-image": { borderTopLeftRadius: "12px" },
  list: { color: "rgb(171, 172, 173)" },
  task: { color: "rgb(191, 192, 193)" },
  "task-checked": { color: "rgb(201, 202, 203)", textDecorationLine: "line-through", backgroundColor: "rgb(221, 222, 223)" },
  table: { color: "rgb(31, 42, 53)", borderTopColor: "rgb(63, 74, 85)", borderRightColor: "rgb(63, 74, 85)" },
  hr: { borderTopColor: "rgb(95, 106, 117)" },
};

/** Every distinct sentinel string the fixture must literally declare. */
export function expectedValues() {
  const values = new Set();
  for (const kind of KINDS) {
    for (const prop of kindProps(kind)) {
      const value = EXPECTED[kind.id]?.[prop];
      if (value != null) values.add(value);
    }
  }
  return [...values];
}

/** Fail when an expectation is not present verbatim in the fixture CSS. */
export function validateFixture(css) {
  const text = String(css ?? "");
  const problems = [];
  for (const kind of KINDS) {
    for (const prop of kindProps(kind)) {
      const value = EXPECTED[kind.id]?.[prop];
      if (value == null) {
        problems.push(`EXPECTED.${kind.id}.${prop} is missing`);
        continue;
      }
      if (!text.includes(value)) problems.push(`fixture does not declare ${value} for ${kind.id}.${prop}`);
    }
  }
  return problems;
}

/**
 * Runs in the browser. Resolves the semantic element for each kind on one
 * surface and returns its computed values. Serialized via `page.evaluate`, so
 * it must not close over module scope.
 */
export function collectThemePaint({ kinds, surface }) {
  const root = surface === "reader"
    ? (document.querySelector("#preview .markdown-preview-view") || document.querySelector("#preview"))
    : document.querySelector(".cm-content");
  const deepestElementWith = (scope, needle) => {
    if (!scope || !needle) return null;
    let best = null;
    const walk = (element) => {
      if (!(element.textContent || "").includes(needle)) return;
      best = element;
      for (const child of element.children) walk(child);
    };
    walk(scope);
    return best;
  };
  const out = {};
  for (const kind of kinds) {
    const spec = surface === "reader" ? kind.reader : kind.live;
    const props = kind.props[surface] || kind.props.reader || kind.props;
    if (!spec || !props.length) {
      // This surface owns no anchor for the kind (reader-only kinds).
      out[kind.id] = { found: false, skipped: true };
      continue;
    }
    let element = null;
    if (spec.selector) element = document.querySelector(spec.selector);
    if (!element && spec.needle) element = deepestElementWith(root, spec.needle);
    if (element && spec.climb) element = element.closest(spec.climb) || element;
    if (!element) {
      out[kind.id] = { found: false };
      continue;
    }
    const style = getComputedStyle(element);
    const values = {};
    for (const prop of props) values[prop] = style[prop];
    out[kind.id] = {
      found: true,
      tag: element.tagName.toLowerCase(),
      classes: [...element.classList].sort(),
      text: (element.textContent || "").slice(0, 64),
      values,
    };
  }
  return out;
}

/** Compare one surface's computed paint against the theme declarations. */
export function evaluatePaint(snapshot, expected, surface, label = surface) {
  const mismatches = [];
  for (const kind of KINDS) {
    const props = kind.props[surface] || kind.props.reader || kind.props;
    // A kind with no anchor and no props on this surface makes no claim.
    if (!props.length) continue;
    const entry = snapshot?.[kind.id];
    if (!entry?.found) {
      mismatches.push({ surface: label, kind: kind.id, prop: "found", expected: "element", actual: "missing" });
      continue;
    }
    for (const prop of props) {
      const want = expected[kind.id]?.[prop];
      if (want == null) continue;
      const actual = entry.values[prop];
      if (actual !== want) mismatches.push({ surface: label, kind: kind.id, prop, expected: want, actual });
    }
  }
  return mismatches;
}

/** Distinct sentinel transform used by the negative control. */
function shiftChannel(value) {
  const number = Number(value);
  return number + 64 <= 255 ? number + 64 : number - 64;
}

// Decoration keywords carry no numeric channel to shift, so the mutation swaps
// them for a different visible decoration. Without this the completed-task
// decoration assertion would be a constant the negative control cannot move.
const DECORATION_SWAP = { "line-through": "underline", underline: "line-through" };

export function mutateValue(value) {
  const text = String(value);
  if (DECORATION_SWAP[text]) return DECORATION_SWAP[text];
  let match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(text);
  if (match) return `rgb(${shiftChannel(match[1])}, ${shiftChannel(match[2])}, ${shiftChannel(match[3])})`;
  match = /^(\d+(?:\.\d+)?)px$/.exec(text);
  if (match) return `${Number(match[1]) + 2}px`;
  match = /^(\d+)$/.exec(text);
  if (match) return `${Number(match[1]) + 12}`;
  return text;
}

/** Mutated expectations derived from the same transform as `mutateCss`. */
export function mutatedExpected(expected) {
  const out = {};
  for (const kind of KINDS) {
    out[kind.id] = {};
    for (const prop of kindProps(kind)) out[kind.id][prop] = mutateValue(expected[kind.id][prop]);
  }
  return out;
}

/**
 * Rewrite every sentinel in the fixture so the mutated theme declares
 * different paint. Mirrors `mutateValue` for the values the gate asserts.
 */
export function mutateCss(css) {
  return String(css)
    .replace(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g, (all, r, g, b) => `rgb(${shiftChannel(r)}, ${shiftChannel(g)}, ${shiftChannel(b)})`)
    .replace(/(\d+(?:\.\d+)?)px/g, (all, n) => `${Number(n) + 2}px`)
    .replace(/font-weight:\s*(\d+)/g, (all, n) => `font-weight: ${Number(n) + 12}`)
    .replace(/\bline-through\b/g, "underline");
}

/** Split mismatches into failing and allow-listed (environment) buckets. */
export function classifyMismatches(mismatches, allowlist) {
  const known = new Set(allowlist?.knownEnvironmentFailures || []);
  const failures = [];
  const environment = [];
  for (const mismatch of mismatches) {
    const key = `${mismatch.surface} ${mismatch.kind} ${mismatch.prop}`;
    if (known.has(key)) environment.push({ ...mismatch, allowlisted: true });
    else if ([...known].some((entry) => entry.endsWith("*") && key.startsWith(entry.slice(0, -1)))) environment.push({ ...mismatch, allowlisted: true });
    else failures.push(mismatch);
  }
  return { failures, environment };
}

export function describeMismatch(mismatch) {
  return `${mismatch.surface} ${mismatch.kind} ${mismatch.prop}: theme declared ${JSON.stringify(mismatch.expected)}, computed ${JSON.stringify(mismatch.actual)}`;
}
