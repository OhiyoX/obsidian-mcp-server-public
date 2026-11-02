import assert from "node:assert/strict";
import test from "node:test";
import { sortFlatNotes, sortTreeLevel } from "../frontend/app/features/explorer/sort-model.js";

// Test-local fixtures only. Records mirror the ordinary metadata payloads the
// Web explorer already receives (`path`, `title`, `modified`, `tags`, `score`,
// `matchCount`, `snippets`). They represent an already-returned, possibly
// truncated metadata-only tree or an already-returned query result set — never a
// full Vault. The model re-orders this set; it does not search or paginate.

function note(path, extra = {}) {
  return { path, ...extra };
}

function folder(path, extra = {}) {
  return { path, ...extra };
}

const paths = (records) => records.map((record) => record.path);

const treeFixture = () => ({
  folders: [folder("zeta", { name: "zeta" }), folder("alpha", { name: "alpha" })],
  notes: [
    note("zeta/z.md", { title: "zeta note" }),
    note("alpha/a.md", { title: "alpha note" }),
  ],
});

test("Tree default sort is name asc with separate folders-first arrays", () => {
  const result = sortTreeLevel(treeFixture());
  assert.deepEqual(paths(result.folders), ["alpha", "zeta"]);
  assert.deepEqual(paths(result.notes), ["alpha/a.md", "zeta/z.md"]);
  assert.deepEqual(Object.keys(result).sort(), ["folders", "notes"]);
});

test("Tree name desc reverses each array but keeps folders structurally separate", () => {
  const result = sortTreeLevel(treeFixture(), { key: "name", direction: "desc" });
  assert.deepEqual(paths(result.folders), ["zeta", "alpha"]);
  assert.deepEqual(paths(result.notes), ["zeta/z.md", "alpha/a.md"]);
  // folders-first is a shape contract, not a comparator side effect.
  assert.ok(Array.isArray(result.folders) && Array.isArray(result.notes));
});

test("Tree equal names break by raw path ASC, not input order", () => {
  const result = sortTreeLevel({
    folders: [],
    notes: [
      note("zzz/same.md", { title: "Same" }),
      note("aaa/same.md", { title: "Same" }),
    ],
  });
  assert.deepEqual(paths(result.notes), ["aaa/same.md", "zzz/same.md"]);
});

test("Tree modified asc/desc orders valid notes by timestamp", () => {
  const notes = [
    note("c.md", { modified: "2026-01-03T00:00:00Z" }),
    note("a.md", { modified: "2026-01-01T00:00:00Z" }),
    note("b.md", { modified: "2026-01-02T00:00:00Z" }),
  ];
  assert.deepEqual(paths(sortTreeLevel({ folders: [], notes }).notes), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(
    paths(sortTreeLevel({ folders: [], notes }, { key: "modified", direction: "desc" }).notes),
    ["c.md", "b.md", "a.md"],
  );
});

test("Tree modified keeps folders name ASC and never fakes a folder timestamp", () => {
  const result = sortTreeLevel(
    {
      folders: [folder("zeta", { name: "zeta", modified: "2026-01-01T00:00:00Z" }), folder("alpha", { name: "alpha" })],
      notes: [
        note("a.md", { modified: "2026-01-01T00:00:00Z" }),
        note("b.md", { modified: "2026-01-02T00:00:00Z" }),
      ],
    },
    { key: "modified", direction: "desc" },
  );
  assert.deepEqual(paths(result.folders), ["alpha", "zeta"]);
  assert.deepEqual(paths(result.notes), ["b.md", "a.md"]);
});

test("Tree modified puts invalid/missing timestamps last in both directions", () => {
  const notes = [
    note("a.md", { modified: "2026-01-01T00:00:00Z" }),
    note("b.md", { modified: "2026-01-02T00:00:00Z" }),
    note("c.md", { modified: null }),
    note("d.md", { modified: "2026-02-30T00:00:00Z" }),
  ];
  assert.deepEqual(paths(sortTreeLevel({ folders: [], notes }).notes), ["a.md", "b.md", "c.md", "d.md"]);
  assert.deepEqual(
    paths(sortTreeLevel({ folders: [], notes }, { key: "modified", direction: "desc" }).notes),
    ["b.md", "a.md", "c.md", "d.md"],
  );
});

test("Tree name falls back from missing title to basename, then to the raw path", () => {
  const basenameOrder = sortTreeLevel({
    folders: [],
    notes: [note("b/A.md"), note("a/Z.md")],
  });
  // basename: A.md < Z.md; a full-path sort would have produced a/Z.md first.
  assert.deepEqual(paths(basenameOrder.notes), ["b/A.md", "a/Z.md"]);

  const rawPathFallback = sortTreeLevel({
    folders: [],
    notes: [note("z/"), note("a.md")],
  });
  // basename("z/") is empty, so the raw "z/" is used: a.md < z/.
  assert.deepEqual(paths(rawPathFallback.notes), ["a.md", "z/"]);

  const titleWins = sortTreeLevel({
    folders: [],
    notes: [
      note("zzz/x.md", { title: "aaa" }),
      note("aaa/y.md", { title: "bbb" }),
    ],
  });
  assert.deepEqual(paths(titleWins.notes), ["zzz/x.md", "aaa/y.md"]);
});

test("Folder name falls back to basename(path) when name is missing", () => {
  const result = sortTreeLevel({ folders: [folder("b/A"), folder("a/Z")], notes: [] });
  assert.deepEqual(paths(result.folders), ["b/A", "a/Z"]);
});

test("Flat name asc/desc", () => {
  const notes = [
    note("c.md", { title: "charlie" }),
    note("a.md", { title: "alpha" }),
    note("b.md", { title: "bravo" }),
  ];
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "name", direction: "asc" })), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "name", direction: "desc" })), ["c.md", "b.md", "a.md"]);
});

test("Flat modified asc/desc", () => {
  const notes = [
    note("b.md", { modified: "2026-01-02T00:00:00Z" }),
    note("a.md", { modified: "2026-01-01T00:00:00Z" }),
    note("c.md", { modified: "nope" }),
  ];
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "modified", direction: "asc" })), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "modified", direction: "desc" })), ["b.md", "a.md", "c.md"]);
});

test("Flat path asc/desc uses raw UTF-16 order", () => {
  const notes = [note("b.md"), note("a.md"), note("c.md")];
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "path", direction: "asc" })), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "path", direction: "desc" })), ["c.md", "b.md", "a.md"]);
});

test("Flat score asc/desc is honoured only with query context", () => {
  const notes = [note("a.md", { score: 2 }), note("b.md", { score: 0 }), note("c.md", { score: 5 })];
  assert.deepEqual(
    paths(sortFlatNotes(notes, { key: "score", direction: "asc" }, { query: true })),
    ["b.md", "a.md", "c.md"],
  );
  assert.deepEqual(
    paths(sortFlatNotes(notes, { key: "score", direction: "desc" }, { query: true })),
    ["c.md", "a.md", "b.md"],
  );
});

test("Non-query score request falls back to name asc", () => {
  const notes = [
    note("c.md", { title: "charlie", score: 9 }),
    note("a.md", { title: "alpha", score: 0 }),
    note("b.md", { title: "bravo", score: 4 }),
  ];
  const byName = ["a.md", "b.md", "c.md"];
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "score", direction: "desc" }, { query: false })), byName);
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "score", direction: "desc" })), byName);
  // Same fallback for an explicit context object without query: true.
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "score", direction: "desc" }, {})), byName);
  // Guard against guessing query context from a non-zero score: only strict
  // query === true enables score ordering, so numeric 1 still falls back.
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "score", direction: "desc" }, { query: 1 })), byName);
});

test("score 0 is valid; NaN/Infinity/missing are invalid and stay last in both directions", () => {
  const notes = [
    note("a.md", { score: 0 }),
    note("b.md", { score: Number.NaN }),
    note("c.md", { score: Number.POSITIVE_INFINITY }),
    note("d.md", { score: undefined }),
    note("e.md", { score: 2 }),
  ];
  assert.deepEqual(
    paths(sortFlatNotes(notes, { key: "score", direction: "asc" }, { query: true })),
    ["a.md", "e.md", "b.md", "c.md", "d.md"],
  );
  assert.deepEqual(
    paths(sortFlatNotes(notes, { key: "score", direction: "desc" }, { query: true })),
    ["e.md", "a.md", "b.md", "c.md", "d.md"],
  );
});

test("invalid key, direction, or spec fails closed to name asc without throwing", () => {
  const { folders, notes } = treeFixture();
  const expected = sortTreeLevel({ folders, notes });
  for (const bad of [
    { key: "created", direction: "asc" },
    { key: "score", direction: "asc" },
    { key: "name", direction: "up" },
    { key: "name" },
    { direction: "asc" },
    null,
    undefined,
    "name",
    42,
    [],
  ]) {
    assert.deepEqual(sortTreeLevel({ folders, notes }, bad), expected, `tree sort=${JSON.stringify(bad)}`);
  }

  const flatNotes = [note("b.md", { title: "bravo" }), note("a.md", { title: "alpha" })];
  const flatExpected = ["a.md", "b.md"];
  for (const bad of [
    { key: "size", direction: "asc" },
    { key: "modified", direction: "down" },
    { key: "name", direction: "ASC" },
    null,
    "name",
  ]) {
    assert.deepEqual(paths(sortFlatNotes(flatNotes, bad)), flatExpected, `flat sort=${JSON.stringify(bad)}`);
  }
});

test("name desc still keeps path tie ASC", () => {
  const notes = [
    note("b.md", { title: "same" }),
    note("a.md", { title: "same" }),
  ];
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "name", direction: "desc" })), ["a.md", "b.md"]);
  assert.deepEqual(
    paths(sortTreeLevel({ folders: [], notes }, { key: "name", direction: "desc" }).notes),
    ["a.md", "b.md"],
  );
});

test("NFC affects only the comparison key; original title/path are preserved", () => {
  const decomposed = note("b.md", { title: "Cafe\u0301" });
  const composed = note("a.md", { title: "Caf\u00E9" });
  const notes = [decomposed, composed];
  const result = sortFlatNotes(notes, { key: "name", direction: "asc" });
  // NFC-equal names tie, so the raw path ASC tie-break decides.
  assert.deepEqual(paths(result), ["a.md", "b.md"]);
  assert.equal(decomposed.title, "Cafe\u0301");
  assert.equal(composed.title, "Caf\u00E9");
  assert.equal(result[0], composed);
  assert.equal(result[1], decomposed);
});

test("duplicate paths are not deduped; fully equal keys keep original index", () => {
  const first = note("dup.md", { title: "Dup", modified: "2026-01-01T00:00:00Z" });
  const second = note("dup.md", { title: "Dup", modified: "2026-01-01T00:00:00Z" });
  const third = note("dup.md", { title: "Dup", modified: "2026-01-01T00:00:00Z" });
  const result = sortFlatNotes([first, second, third], { key: "modified", direction: "desc" });
  assert.equal(result.length, 3);
  assert.equal(result[0], first);
  assert.equal(result[1], second);
  assert.equal(result[2], third);
});

test("input arrays are never mutated", () => {
  const folders = [folder("z"), folder("a")];
  const notes = [note("z.md"), note("a.md")];
  const foldersSnapshot = folders.slice();
  const notesSnapshot = notes.slice();
  sortTreeLevel({ folders, notes }, { key: "name", direction: "desc" });
  assert.deepEqual(folders, foldersSnapshot);
  assert.deepEqual(notes, notesSnapshot);

  const flat = [note("z.md"), note("a.md")];
  const flatSnapshot = flat.slice();
  sortFlatNotes(flat, { key: "path", direction: "desc" });
  assert.deepEqual(flat, flatSnapshot);
});

test("records are never mutated and output keeps object identity", () => {
  const notes = [
    Object.freeze(note("b.md", { title: "bravo", modified: "2026-01-02T00:00:00Z" })),
    Object.freeze(note("a.md", { title: "alpha", modified: "2026-01-01T00:00:00Z" })),
  ];
  const result = sortFlatNotes(notes, { key: "modified", direction: "asc" });
  assert.equal(result[0], notes[1]);
  assert.equal(result[1], notes[0]);
  assert.deepEqual(result, [notes[1], notes[0]]);
});

test("numeric / natural ordering is not enabled", () => {
  const notes = [note("foo2.md", { title: "foo2" }), note("foo10.md", { title: "foo10" })];
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "name", direction: "asc" })), ["foo10.md", "foo2.md"]);
});

test("sortFlatNotes is a projection of the passed set only (truncated/query results)", () => {
  const notes = [note("b.md", { title: "bravo" }), note("a.md", { title: "alpha" })];
  const result = sortFlatNotes(notes, { key: "name", direction: "asc" });
  assert.equal(result.length, notes.length);
  assert.equal(result.every((record) => notes.includes(record)), true);
});

test("invalid container shapes raise TypeError (documented fail-closed boundary)", () => {
  assert.throws(() => sortTreeLevel(null), TypeError);
  assert.throws(() => sortTreeLevel([]), TypeError);
  assert.throws(() => sortTreeLevel({ folders: [], notes: null }), TypeError);
  assert.throws(() => sortTreeLevel({ folders: null, notes: [] }), TypeError);
  assert.throws(() => sortFlatNotes(null), TypeError);
  assert.throws(() => sortFlatNotes({ path: "a.md" }), TypeError);
});

test("modified accepts Z, offsets, and fractional seconds", () => {
  const notes = [
    note("z.md", { modified: "2026-01-01T00:00:00Z" }),
    note("a.md", { modified: "2026-01-01T00:00:00-05:00" }),
    note("m.md", { modified: "2026-01-01T00:00:00.500Z" }),
  ];
  // -05:00 is later in UTC than Z; .500Z sorts after .000Z.
  assert.deepEqual(paths(sortFlatNotes(notes, { key: "modified", direction: "asc" })), ["z.md", "m.md", "a.md"]);
});

test("modified rejects naive, malformed, and calendar-rollover timestamps", () => {
  const invalid = [
    undefined,
    null,
    "",
    "not-a-date",
    "2026-01-01T00:00:00",
    "2026-01-01 00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-06-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+8:00",
    1767225600000,
  ];
  const notes = [
    note("m.md", { modified: "2026-01-01T00:00:00Z" }),
    ...invalid.map((value, index) => note(`x${String(index).padStart(2, "0")}.md`, { modified: value })),
  ];
  const ascending = sortFlatNotes(notes, { key: "modified", direction: "asc" });
  const descending = sortFlatNotes(notes, { key: "modified", direction: "desc" });
  assert.equal(ascending[0].path, "m.md");
  assert.equal(descending[0].path, "m.md");
  const expectedInvalid = invalid.map((_, index) => `x${String(index).padStart(2, "0")}.md`);
  assert.deepEqual(paths(ascending.slice(1)), expectedInvalid);
  assert.deepEqual(paths(descending.slice(1)), expectedInvalid);
});

test("timestamp offset is parsed into UTC ordering, not ignored", () => {
  const earlier = note("a.md", { modified: "2026-01-01T00:00:00+08:00" });
  const later = note("b.md", { modified: "2026-01-01T00:00:00Z" });
  assert.deepEqual(paths(sortFlatNotes([later, earlier], { key: "modified", direction: "asc" })), ["a.md", "b.md"]);
});
