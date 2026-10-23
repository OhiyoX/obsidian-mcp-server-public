// A4a: `app/src/base-patch.js` — `.base` line-surgical patch, pure module.
//
// Every case here is written as a *statement about bytes*: the patch must change
// exactly the declared line and leave every other byte (comments, unknown keys,
// quote style, CRLF/LF mix, final newline) untouched. The three negative controls
// required by the brief prove the assertions can go red:
//   1. the canonical `yaml.dump(yaml.load(raw))` rewrite fails assertion C;
//   2. anchors / aliases / flow collections / inline comments / non-standard
//      indentation inside the target region are `base-not-patchable`;
//   3. a key outside the desktop whitelist is `base-unknown-key` and produces no
//      document at all (not even a partially patched one).
// FIX2 adds a fourth: the same-value short circuit sits *behind* every gate, so an
// illegal target is refused whether or not the mutation would have changed bytes
// (`FIX2: an equal value ...` cases below).
//
// Run: cd app && node --test test/base-patch.test.js

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  BASE_PATCH_ERROR_CODES,
  BASE_VIEW_OPTION_KEYS,
  BasePatchError,
  patchBaseDocument,
} from "../src/base-patch.js";
import { insertLines, joinLines, splitLines } from "../src/base-patch-lines.js";
import { countLines } from "../scripts/line-budget.mjs";

const SOURCE_PATHS = ["base-patch.js", "base-patch-lines.js"].map((name) =>
  path.join(import.meta.dirname, "..", "src", name),
);

// --------------------------------------------------------------- diff helpers

function linesWithEol(raw) {
  return raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function differingLines(before, after) {
  const left = linesWithEol(before);
  const right = linesWithEol(after);
  const out = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? null;
    const b = right[index] ?? null;
    if (a !== b) out.push({ index, before: a, after: b });
  }
  return out;
}

// Readable `diff -u`-shaped rendering; `\r` is visible because every line is
// JSON-quoted (a lost CRLF must not look like an unchanged line).
function unifiedDiff(before, after) {
  const parts = ["--- before", "+++ after"];
  for (const item of differingLines(before, after)) {
    if (item.before !== null) parts.push(`-${JSON.stringify(item.before)}`);
    if (item.after !== null) parts.push(`+${JSON.stringify(item.after)}`);
  }
  return parts.join("\n");
}

function assertOnlyLineChanged(before, after, expectedIndex) {
  const diff = differingLines(before, after);
  assert.equal(diff.length, 1, `expected exactly one changed line\n${unifiedDiff(before, after)}`);
  assert.equal(diff[0].index, expectedIndex, `changed the wrong line\n${unifiedDiff(before, after)}`);
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// The no-op contract is "the same bytes", not "the same meaning": the result must
// be the input string itself (F-1).
function assertByteIdentical(before, after, label) {
  assert.equal(sha256(after), sha256(before), `${label}: sha256 must be identical (byte-for-byte no-op)`);
  assert.equal(after, before, `${label}: the patch must return the input string itself`);
  assert.deepEqual(differingLines(before, after), [], `${label}: no line may differ`);
}

// ---------------------------------------------------------------- the fixture

// Mixed CRLF/LF, a leading comment, unknown keys at top level and inside a view,
// a flow-valued unknown key and single-quoted scalars: everything the patch must
// carry through byte-for-byte.
const FIXTURE_PIECES = [
  ["# desktop parity fixture — do not re-serialise", "\r\n"],
  ["views:", "\n"],
  ["  - type: table", "\r\n"],
  ["    name: 'Table'", "\n"],
  ["    limit: 10", "\r\n"],
  ["    unrecognizedData:", "\n"],
  ["      zzz: keep", "\r\n"],
  ["  - type: cards", "\n"],
  ["    name: Cards", "\r\n"],
  ["filters:", "\n"],
  ["  and:", "\r\n"],
  ['    - file.hasTag("parity")', "\n"],
  ["unrecognizedData: {zzz: 1}", "\r\n"],
  ["zzz_unknown: kept", "\n"],
  ["formulas:", "\r\n"],
  ["  price: 'qty * unit'", "\n"],
];
const FIXTURE = FIXTURE_PIECES.map(([text, eol]) => text + eol).join("");
const LIMIT_LINE = 4; // "    limit: 10\r\n"

test("assertion C: set-view-option changes exactly one line and nothing else", () => {
  const after = patchBaseDocument(FIXTURE, [{ op: "set-view-option", view: "Table", key: "limit", value: 25 }]);
  assertOnlyLineChanged(FIXTURE, after, LIMIT_LINE);
  assert.equal(linesWithEol(after)[LIMIT_LINE], "    limit: 25\r\n");
  // Byte-level proof that the untouched region is identical, not merely similar.
  const before = linesWithEol(FIXTURE);
  const next = linesWithEol(after);
  for (let index = 0; index < before.length; index += 1) {
    if (index === LIMIT_LINE) continue;
    assert.equal(next[index], before[index], `line ${index} changed: ${JSON.stringify(before[index])}`);
  }
  assert.equal(next.length, before.length);
});

test("assertion C: only the addressed field differs in the parsed documents", () => {
  const after = patchBaseDocument(FIXTURE, [{ op: "set-view-option", view: "Table", key: "limit", value: 25 }]);
  const beforeDoc = yaml.load(FIXTURE);
  const afterDoc = yaml.load(after);
  const expected = JSON.parse(JSON.stringify(beforeDoc));
  expected.views[0].limit = 25;
  assert.deepEqual(afterDoc, expected);
  assert.equal(afterDoc.unrecognizedData.zzz, 1);
  assert.equal(afterDoc.zzz_unknown, "kept");
  assert.equal(afterDoc.views[0].unrecognizedData.zzz, "keep");
  assert.equal(afterDoc.formulas.price, "qty * unit");
});

test("assertion C keeps quote style, comments, CRLF and key order on untouched lines", () => {
  const after = patchBaseDocument(FIXTURE, [{ op: "set-view-option", view: "Table", key: "limit", value: 25 }]);
  assert.ok(after.includes("# desktop parity fixture — do not re-serialise\r\n"));
  assert.ok(after.includes("    name: 'Table'\n"), "single-quoted style must survive");
  assert.ok(after.includes("      zzz: keep\r\n"), "unknown nested key must survive");
  assert.ok(after.includes("unrecognizedData: {zzz: 1}\r\n"));
  assert.deepEqual(Object.keys(yaml.load(after).views[0]), ["type", "name", "limit", "unrecognizedData"]);
});

test("negative control 1: the canonical yaml.dump rewrite fails assertion C", () => {
  const canonical = yaml.dump(yaml.load(FIXTURE), { noRefs: true, lineWidth: 120, sortKeys: false });
  const diff = differingLines(FIXTURE, canonical);
  assert.ok(diff.length > 1, `yaml.dump must disturb many lines\n${unifiedDiff(FIXTURE, canonical)}`);
  assert.ok(!canonical.includes("# desktop parity fixture"), "yaml.dump drops comments");
  assert.ok(!canonical.includes("'Table'"), "yaml.dump normalises quote style");
  assert.throws(
    () => assertOnlyLineChanged(FIXTURE, canonical, LIMIT_LINE),
    /expected exactly one changed line/,
    "assertion C must be able to go red against a dump-based implementation",
  );
});

// ------------------------------------------------- negative control 2 (region)

function withViewLines(extra, prefix = ["# fixture"]) {
  return [
    ...prefix,
    "views:",
    "  - type: table",
    "    name: Table",
    ...extra,
    "    limit: 10",
    "  - type: cards",
    "    name: Cards",
  ].join("\n") + "\n";
}

// Each entry is [region content (a valid YAML document), expected reason]. The
// alias case needs its anchor outside the region, because YAML itself rejects an
// unresolved alias before any locator runs (that is `invalid-yaml`, not a
// patchability question).
const NOT_PATCHABLE_REGIONS = [
  ["anchor", withViewLines(["    groupOrder: &order file.name"]), "YAML anchor"],
  ["alias", withViewLines(["    groupOrder: *order"], ["shared: &order file.name"]), "YAML alias"],
  ["flow collection", withViewLines(["    order: [file.name]"]), "flow (inline) collection"],
  ["inline comment", withViewLines(["    groupOrder: file.name # order"]), "inline comment"],
  ["tab after a colon", withViewLines(["    groupOrder:\tfile.name"]), "tab indentation"],
];

for (const [label, raw, reason] of NOT_PATCHABLE_REGIONS) {
  test(`negative control 2: ${label} inside the target region is base-not-patchable`, () => {
    let error = null;
    try {
      patchBaseDocument(raw, [{ op: "set-view-option", view: "Table", key: "limit", value: 25 }]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof BasePatchError, `${label} must fail closed, got ${error && error.message}`);
    assert.equal(error.code, "base-not-patchable");
    assert.match(error.message, /write_base/);
    assert.match(error.message, new RegExp(reason.replace(/[()[\]]/g, "\\$&")));
    // "不是静默重排": the caller gets no document at all, so it cannot be written.
    assert.equal(error.raw, undefined);
  });
}

test("negative control 2: indentation that is not the standard 2-space step is rejected", () => {
  const raw = ["views:", "   - type: table", "     name: Table", "     limit: 10"].join("\n") + "\n";
  assert.throws(
    () => patchBaseDocument(raw, [{ op: "set-view-option", view: "Table", key: "limit", value: 25 }]),
    (error) => error.code === "base-not-patchable" && /standard 2-space/.test(error.message),
  );
});

test("anchors and flow collections outside the target region do not block the patch", () => {
  const raw = ["views:", "  - type: table", "    name: Table", "    limit: 10", "other: &a [1, 2]"].join("\n") + "\n";
  const after = patchBaseDocument(raw, [{ op: "set-view-option", view: "Table", key: "limit", value: 25 }]);
  assertOnlyLineChanged(raw, after, 3);
  assert.ok(after.endsWith("other: &a [1, 2]\n"));
});

// --------------------------------------------- negative control 3 (whitelist)

test("negative control 3: a key outside the desktop whitelist is base-unknown-key", () => {
  for (const key of ["rowHeight", "zzz", "unrecognizedData", "limit2"]) {
    assert.throws(
      () => patchBaseDocument(FIXTURE, [{ op: "set-view-option", view: "Table", key, value: "x" }]),
      (error) => error instanceof BasePatchError && error.code === "base-unknown-key" && error.message.includes(key),
      `${key} must be rejected`,
    );
  }
  assert.deepEqual(BASE_PATCH_ERROR_CODES, ["base-not-patchable", "base-unknown-key"]);
  assert.ok(BASE_VIEW_OPTION_KEYS.includes("limit"));
});

test("negative control 3: a rejected batch produces no document and no partial write", () => {
  const snapshot = FIXTURE;
  const batch = [
    { op: "set-view-option", view: "Table", key: "limit", value: 25 },
    { op: "set-view-option", view: "Table", key: "rowHeight", value: "tall" },
  ];
  assert.throws(
    () => patchBaseDocument(FIXTURE, batch),
    (error) => error.code === "base-unknown-key",
  );
  // The valid first mutation alone *would* change a line; because the whitelist is
  // checked for the whole batch up front, nothing was patched at all.
  assertOnlyLineChanged(FIXTURE, patchBaseDocument(FIXTURE, [batch[0]]), LIMIT_LINE);
  assert.equal(FIXTURE, snapshot, "the input text must never be mutated in place");
});

// ------------------------------------------------------- insertion semantics

test("set-formulas on a document without a formulas block appends a block at the top-level end", () => {
  const raw = ["views:", "  - type: table", "    name: Table"].join("\n") + "\n";
  const after = patchBaseDocument(raw, [{ op: "set-formulas", key: "price", value: "qty * unit" }]);
  assert.ok(after.startsWith(raw), "existing bytes must be a prefix of the result");
  assert.equal(after.slice(raw.length), "formulas:\n  price: qty * unit\n");
  assert.equal(yaml.load(after).formulas.price, "qty * unit");
});

test("set-formulas inserts with the block's own indentation and appends at the block end", () => {
  const raw = ["views:", "  - type: table", "    name: Table", "formulas:", "  a: 'x + 1'", "  b: 'y + 2'", "zzz_unknown: 1"].join("\n") + "\n";
  const after = patchBaseDocument(raw, [{ op: "set-formulas", key: "c", value: "a + b" }]);
  assert.equal(after, raw.replace("  b: 'y + 2'\n", "  b: 'y + 2'\n  c: a + b\n"));
  assert.deepEqual(Object.keys(yaml.load(after).formulas), ["a", "b", "c"]);
});

test("set-formulas appends after a nested block and keeps CRLF line endings", () => {
  const raw = ["formulas:\r\n", "  a: 'x + 1'\r\n"].join("");
  const after = patchBaseDocument(raw, [{ op: "set-formulas", key: "b", value: "a + 1" }]);
  assert.equal(after, "formulas:\r\n  a: 'x + 1'\r\n  b: a + 1\r\n");
});

test("set-formulas appends without inventing a final newline on a document that has none", () => {
  const raw = "views:\n  - type: table\n    name: Table";
  const after = patchBaseDocument(raw, [{ op: "set-formulas", key: "price", value: "1 + 1" }]);
  assert.equal(after, `${raw}\nformulas:\n  price: 1 + 1`);
  assert.ok(!after.endsWith("\n"));
});

// BRIEF-FIX-PROVENANCE (A): the locator never edits an existing line object. The old append
// mutated the previous line's `eol`, which made an unaddressed line look replaced and got it
// re-encoded from a lossy decode. The separator is now new bytes on the first inserted line.
test("insertLines is pure: it edits no existing line and writes the separator itself", () => {
  const lines = splitLines("views:\n  - type: table\n    name: Table");
  const last = lines.at(-1);
  const before = { ...last };
  insertLines(lines, lines.length, ["formulas:", "  price: 1 + 1"]);
  assert.deepEqual({ ...last }, before, "the line before the insertion must not be touched (no in-place eol edit)");
  assert.equal(last.eol, "", "...its missing terminator stays missing");
  assert.equal(joinLines(lines), "views:\n  - type: table\n    name: Table\nformulas:\n  price: 1 + 1");
  const inserted = lines.slice(-2);
  assert.deepEqual(inserted.map((line) => line.kind), ["inserted", "inserted"]);
  assert.equal(inserted[0].lead, "\n", "the separator is new leading bytes on the first inserted line");
  assert.equal(inserted.at(-1).eol, "", "and no final newline is invented");
});

test("insertLines follows the document's own terminator style and leaves a middle insert intact", () => {
  const crlf = splitLines("views:\r\n  - type: table\r\n    name: Table");
  insertLines(crlf, crlf.length, ["formulas:", "  price: 1 + 1"]);
  assert.equal(joinLines(crlf), "views:\r\n  - type: table\r\n    name: Table\r\nformulas:\r\n  price: 1 + 1");
  const middle = splitLines("views:\n  - type: table\n    name: Table\nzzz: 1\n");
  const snapshot = middle.map((line) => ({ ...line }));
  insertLines(middle, 3, ["    limit: 10"]);
  assert.deepEqual(middle.slice(0, 3).map((line) => ({ ...line })), snapshot.slice(0, 3), "nothing before the insertion moves");
  assert.deepEqual({ ...middle.at(-1) }, snapshot.at(-1), "nothing after it does either");
  assert.equal(joinLines(middle), "views:\n  - type: table\n    name: Table\n    limit: 10\nzzz: 1\n");
});

test("set-formulas with null deletes the key line and its nested block, leaving other bytes alone", () => {
  const raw = ["views:", "  - type: table", "    name: Table", "formulas:", "  a:", "    note: nested", "  b: 'y'", "zzz_unknown: 1"].join("\n") + "\n";
  const after = patchBaseDocument(raw, [{ op: "set-formulas", key: "a", value: null }]);
  assert.equal(after, ["views:", "  - type: table", "    name: Table", "formulas:", "  b: 'y'", "zzz_unknown: 1"].join("\n") + "\n");
  assert.deepEqual(Object.keys(yaml.load(after).formulas), ["b"]);
});

test("set-property-display-name replaces an existing displayName and inserts a missing one", () => {
  const raw = ["properties:", "  note.rating:", "    displayName: 'Rating'", "  note.done:", "    zzz: keep"].join("\n") + "\n";
  const after = patchBaseDocument(raw, [
    { op: "set-property-display-name", property: "note.rating", value: "Score" },
    { op: "set-property-display-name", property: "note.done", value: "Done" },
  ]);
  assert.equal(
    after,
    ["properties:", "  note.rating:", "    displayName: Score", "  note.done:", "    zzz: keep", "    displayName: Done"].join("\n") + "\n",
  );
  assert.deepEqual(yaml.load(after).properties, {
    "note.rating": { displayName: "Score" },
    "note.done": { zzz: "keep", displayName: "Done" },
  });
});

test("set-property-display-name creates the properties block when the document has none", () => {
  const raw = "views:\n  - type: table\n    name: Table\n";
  const after = patchBaseDocument(raw, [{ op: "set-property-display-name", property: "note.rating", value: "Rating" }]);
  assert.equal(after, `${raw}properties:\n  note.rating:\n    displayName: Rating\n`);
  assert.equal(yaml.load(after).properties["note.rating"].displayName, "Rating");
});

test("set-view-option inserts a missing view key at the end of that view, not of the document", () => {
  const raw = ["views:", "  - type: table", "    name: Table", "  - type: cards", "    name: Cards"].join("\n") + "\n";
  const after = patchBaseDocument(raw, [{ op: "set-view-option", view: "Table", key: "limit", value: 10 }]);
  assert.equal(after, ["views:", "  - type: table", "    name: Table", "    limit: 10", "  - type: cards", "    name: Cards"].join("\n") + "\n");
});

// ------------------------------------------------------------- no-op / errors

test("a mutation that changes nothing returns the document byte-for-byte", () => {
  const same = patchBaseDocument(FIXTURE, [{ op: "set-view-option", view: "Table", key: "limit", value: 10 }]);
  assertByteIdentical(FIXTURE, same, "limit 10 -> 10");
  const deletingAbsent = patchBaseDocument(FIXTURE, [{ op: "set-formulas", key: "nope", value: null }]);
  assertByteIdentical(FIXTURE, deletingAbsent, "delete an undeclared formula");
});

// -------------------------------------------- F-1: same value ⇒ same bytes

// Each case writes the value the document already holds, once per value type.
// The spellings are deliberately *non-canonical* (quotes, CRLF-free LF, a block
// `sort:` sequence, a quoted formula) so a re-serialising implementation cannot
// pass: the only accepted answer is the original bytes.
const NOOP_CASES = [
  [
    "double-quoted string",
    'views:\n  - type: table\n    name: "Probe"\n',
    { op: "set-view-option", view: "Probe", key: "name", value: "Probe" },
  ],
  [
    "single-quoted string",
    "views:\n  - type: table\n    name: 'Probe'\n",
    { op: "set-view-option", view: "Probe", key: "name", value: "Probe" },
  ],
  [
    "bare string",
    "views:\n  - type: table\n    name: Probe\n",
    { op: "set-view-option", view: "Probe", key: "name", value: "Probe" },
  ],
  [
    "number",
    "views:\n  - type: table\n    name: Table\n    limit: 10\n",
    { op: "set-view-option", view: "Table", key: "limit", value: 10 },
  ],
  [
    "boolean",
    "views:\n  - type: table\n    name: Table\n    groupOrder: true\n",
    { op: "set-view-option", view: "Table", key: "groupOrder", value: true },
  ],
  [
    "set-formulas (same value)",
    "formulas:\n  price: 'qty * unit'\n",
    { op: "set-formulas", key: "price", value: "qty * unit" },
  ],
  [
    "set-property-display-name (same value)",
    "properties:\n  note.rating:\n    displayName: 'Rating'\n",
    { op: "set-property-display-name", property: "note.rating", value: "Rating" },
  ],
];

for (const [label, raw, mutation] of NOOP_CASES) {
  test(`F-1: an already-satisfied ${label} write returns the input bytes`, () => {
    const after = patchBaseDocument(raw, [mutation]);
    assertByteIdentical(raw, after, label);
    assert.ok(raw.endsWith("\n"), `${label}: fixture must end with a newline for this reading`);
  });
}

test("F-1: a batch of nothing but no-ops returns the input bytes", () => {
  const raw = 'views:\n  - type: table\n    name: "Probe"\n    limit: 10\nformulas:\n  price: \'qty * unit\'\n';
  const after = patchBaseDocument(raw, [
    { op: "set-view-option", view: "Probe", key: "name", value: "Probe" },
    { op: "set-view-option", view: "Probe", key: "limit", value: 10 },
  ]);
  assertByteIdentical(raw, after, "batch of two no-ops");
  const deletingAbsent = patchBaseDocument(raw, [{ op: "set-formulas", key: "absent", value: null }]);
  assertByteIdentical(raw, deletingAbsent, "batch: delete an undeclared formula");
});

test("F-1: a no-op next to a real change contributes no bytes", () => {
  const raw = 'views:\n  - type: table\n    name: "Probe"\n    limit: 10\n';
  const after = patchBaseDocument(raw, [
    { op: "set-view-option", view: "Probe", key: "name", value: "Probe" },
    { op: "set-view-option", view: "Probe", key: "limit", value: 25 },
  ]);
  assertOnlyLineChanged(raw, after, 3);
  // The quoted `name` line is *not* re-serialised, and the one change is the limit.
  assert.equal(linesWithEol(after)[2], '    name: "Probe"\n');
  assert.equal(linesWithEol(after)[3], "    limit: 25\n");
});

test("negative control: without the short circuit the quoted value is re-serialised", () => {
  const raw = 'views:\n  - type: table\n    name: "Probe"\n';
  // What the pre-F-1 path produced: `replaceScalar` rewrote the value bytes with
  // `serializeScalar(value)` === `yaml.dump(value, { lineWidth: -1 }).trimEnd()`.
  const injected = raw.replace('name: "Probe"', `name: ${yaml.dump("Probe", { lineWidth: -1 }).trimEnd()}`);
  assert.equal(linesWithEol(injected)[2], "    name: Probe\n", "the injected output must be the unquoted form");
  assert.notEqual(sha256(injected), sha256(raw), "injection must change the bytes");
  assert.throws(
    () => assertByteIdentical(raw, injected, "double-quoted string"),
    /sha256 must be identical/,
    "the F-1 assertion must be able to go red when the short circuit is removed",
  );
});

// The composite spellings a document holds in *block* form are not writable by
// this face at all (a composite cannot be inlined as a scalar). FIX2 makes that
// value-independent: whether the mutation matches the document or not, the write
// is `base-not-patchable`. These three cases used to return the input bytes.
const NESTED_BLOCK_CASES = [
  [
    "array (sort)",
    "views:\n  - type: table\n    name: Table\n    sort:\n      - property: file.name\n        direction: ASC\n",
    { op: "set-view-option", view: "Table", key: "sort", value: [{ property: "file.name", direction: "ASC" }] },
  ],
  [
    "object (summaries)",
    "views:\n  - type: table\n    name: Table\n    summaries:\n      qty: SUM\n",
    { op: "set-view-option", view: "Table", key: "summaries", value: { qty: "SUM" } },
  ],
  [
    "object (groupBy)",
    "views:\n  - type: table\n    name: Table\n    groupBy:\n      property: file.folder\n",
    { op: "set-view-option", view: "Table", key: "groupBy", value: { property: "file.folder" } },
  ],
];

for (const [label, raw, mutation] of NESTED_BLOCK_CASES) {
  test(`FIX2: an equal composite in block form is still base-not-patchable (${label})`, () => {
    assert.throws(
      () => patchBaseDocument(raw, [mutation]),
      (error) => error.code === "base-not-patchable" && /holds a nested block, not a scalar/.test(error.message),
      `${label}: the equal value must not buy an addressable target`,
    );
  });
}

// The short circuit may skip serialisation and nothing else: the same call that
// returns the input bytes on an addressable document must throw here, because the
// value happens to match. Each mutation is an exact no-op by value; only the
// target region (or the key's shape) is illegal.
const ILLEGAL_BUT_EQUAL_CASES = [
  [
    "set-view-option: anchor inside the addressed view item",
    "views:\n  - type: table\n    name: &n Table\n",
    { op: "set-view-option", view: "Table", key: "name", value: "Table" },
    /YAML anchor/,
  ],
  [
    "set-view-option: flow collection holding the addressed key",
    "views:\n  - type: table\n    name: Table\n    summaries: {qty: SUM}\n",
    { op: "set-view-option", view: "Table", key: "summaries", value: { qty: "SUM" } },
    /flow \(inline\) collection/,
  ],
  [
    "set-view-option: alias inside the addressed view item",
    "zzz_anchor: &v Table\nviews:\n  - type: table\n    name: Table\n    order: *v\n",
    { op: "set-view-option", view: "Table", key: "name", value: "Table" },
    /YAML alias/,
  ],
  [
    "set-formulas: anchor on the addressed formula",
    "formulas:\n  price: &p 'qty * unit'\n",
    { op: "set-formulas", key: "price", value: "qty * unit" },
    /YAML anchor/,
  ],
  [
    "set-property-display-name: anchor on the addressed displayName",
    "properties:\n  note.rating:\n    displayName: &d 'Rating'\n",
    { op: "set-property-display-name", property: "note.rating", value: "Rating" },
    /YAML anchor/,
  ],
];

for (const [label, raw, mutation, pattern] of ILLEGAL_BUT_EQUAL_CASES) {
  test(`FIX2: an equal value does not legalise the target (${label})`, () => {
    assert.throws(
      () => patchBaseDocument(raw, [mutation]),
      (error) => error.code === "base-not-patchable" && pattern.test(error.message),
      `${label}: expected base-not-patchable, not a byte-identical success`,
    );
  });
}

test("FIX2: the same anchor is refused for a *different* value too (no value-dependent error face)", () => {
  const raw = "views:\n  - type: table\n    name: &n Table\n";
  const equal = { op: "set-view-option", view: "Table", key: "name", value: "Table" };
  const changed = { op: "set-view-option", view: "Table", key: "name", value: "Renamed" };
  const codes = [equal, changed].map((mutation) => {
    try {
      patchBaseDocument(raw, [mutation]);
      return "success";
    } catch (error) {
      return error.code;
    }
  });
  assert.deepEqual(codes, ["base-not-patchable", "base-not-patchable"], "the answer must not depend on the passed value");
});

test("input errors keep the existing invalid-schema code", () => {
  const cases = [
    [[{ op: "set-view-option", view: "Missing", key: "limit", value: 1 }], /view "Missing" is not declared/],
    [[{ op: "set-view-option", view: "Table", key: "limit", value: null }], /must not be null/],
    [[{ op: "set-view-option", view: "Table", key: "limit", value: 1, extra: true }], /not part of set-view-option/],
    [[{ op: "rename-view", view: "Table" }], /op must be one of/],
    [[], /non-empty mutations array/],
    [[{ op: "set-formulas", key: "price" }], /value is required/],
  ];
  for (const [mutations, pattern] of cases) {
    assert.throws(
      () => patchBaseDocument(FIXTURE, mutations),
      (error) => error.code === "invalid-schema" && pattern.test(error.message),
      `expected invalid-schema for ${JSON.stringify(mutations)}`,
    );
  }
  // Mutation shape is validated before the document is parsed, so these two go
  // through the same non-empty batch and reach the YAML/schema layer.
  const ok = [{ op: "set-formulas", key: "x", value: "1" }];
  assert.throws(() => patchBaseDocument("views: [\n", ok), (error) => error.code === "invalid-yaml");
  assert.throws(() => patchBaseDocument("views: {}\n", ok), (error) => error.code === "invalid-schema");
});

test("a composite value cannot be inlined and is base-not-patchable", () => {
  assert.throws(
    () => patchBaseDocument(FIXTURE, [{ op: "set-view-option", view: "Table", key: "order", value: ["file.name"] }]),
    (error) => error.code === "base-not-patchable" && /scalar values/.test(error.message),
  );
});

test("a whitelisted key that holds a nested block is base-not-patchable", () => {
  const view = FIXTURE.slice(0, FIXTURE.indexOf("    limit: 10")) + "    order:\n      - file.name\n";
  assert.throws(
    () => patchBaseDocument(view, [{ op: "set-view-option", view: "Table", key: "order", value: "file.name" }]),
    (error) => error.code === "base-not-patchable" && /nested block/.test(error.message),
  );
});

// ------------------------------------------------------------ module hygiene

test("the module stays pure, small and free of write-surface coupling", async () => {
  const sources = await Promise.all(SOURCE_PATHS.map((file) => fs.readFile(file, "utf8")));
  for (const [index, source] of sources.entries()) {
    const file = path.basename(SOURCE_PATHS[index]);
    assert.ok(!/from\s+"[^"]*(?:node:fs|node:path|express|mcp)/.test(source), `${file}: no fs/path/express/MCP import`);
    assert.ok(!/from\s+"\.\/base-(?:grouping|summaries|values)\.js"/.test(source), `${file}: no extra domain coupling`);
    assert.ok(countLines(source) <= 300, `${file} is ${countLines(source)} lines (lane limit 300)`);
  }
});
