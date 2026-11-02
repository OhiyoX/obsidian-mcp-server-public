// W0-B: official Bases compatibility corpus + current-behaviour characterization.
//
// Fixture-driven. Every `test/fixtures/bases/<family>/<id>.base` is replayed
// through the canonical Base domain service (`src/base-query.js`) with its
// sibling `<id>.records.json` candidate records, and the observed behaviour is
// compared with `<id>.expected.json`.
//
// The corpus pins what the CURRENT implementation does with the official Obsidian
// Bases surface (see `docs/bases/BASES-COMPATIBILITY-MATRIX.md`). It adds no
// production behaviour and does not touch the real vault: records are injected,
// so the result never depends on `VAULT_PATH`, on test execution order or on
// another test file.
//
// Frozen `expected.json` shape (the mechanical flip surface for W0-D):
//   {
//     "outcome": "accept" | "reject",
//     "code": null | "invalid-yaml" | "invalid-schema" | "unsupported" | "view-not-found",
//     "supportedSubset": true | false,
//     "rowPaths": ["A.md", ...],        // [] when the query is rejected
//     "note": "one sentence naming the frozen fact",
//     "flipIn": null | "W0-D",
//     "flippedIn": null | "INT-A" | "INT-B"   // optional key, see below
//   }
// Query inputs (`viewName`, `limit`) and assertions the frozen shape cannot carry
// (`columns`) live in the single CORPUS_EXPECTATIONS table below, so W0-D only has
// to edit `outcome` / `code` in `expected.json` plus the matching table entry.
// Entries whose `flipIn` is `"W0-D"` were flipped by Wave 0-D from
// silently-accepted to `outcome: "reject"` / `code: "unsupported"`. The shape
// guard below enforces that link so `flipIn` can never again imply a *pending*
// RED. Fixtures that are deliberately NOT fail-closed carry their classification
// (`DISPLAY-METADATA` / `DEFERRED <lane>`) in `note`.
//
// Flip-marker semantics (frozen 2026-10-06, INT-A; extended by INT-B/INT-C/CUT4):
//   `flipIn: "W0-D"`                  -> flipped in W0-D (accept -> reject);
//   `flipIn: null` + `flippedIn: "INT-A"` -> flipped in INT-A (reject -> accept);
//   `flipIn: null` + `flippedIn: "INT-B"` -> flipped in INT-B (reject -> accept);
//   `flipIn: null` + `flippedIn: "INT-C"` -> flipped in INT-C (reject -> accept);
//   `flipIn: null` + `flippedIn: "CUT4"`  -> flipped in CUT4 (reject -> accept:
//     groupBy / summaries / top-level summaries are executed);
//   `flipIn: null` + no `flippedIn`   -> never flipped (still its original state).
// `flippedIn` is the only key allowed beyond the frozen six, and it is additive:
// it marks a *completed forward* flip, so it may never sit on a fixture that still
// rejects. The W0-D guard above keeps `flipIn` non-null => reject + `unsupported`.
//
// Wave 0-D freeze: only keys that change the *result set* fail closed. `type`,
// `cardSize`, `image`, unknown view keys and unknown `properties` config keys
// stay DISPLAY-METADATA (rows / totalMatched / truncated are unchanged);
// unimplemented `file.<prop>` reads and inherited-property reads are registered
// DEFERRED for P1-A.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BaseQueryError, queryBaseSnapshot } from "../src/base-query.js";

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "bases");
const FROZEN_KEYS = ["outcome", "code", "supportedSubset", "rowPaths", "note", "flipIn"];
// Additive (INT-A): optional forward-flip marker. Everything else stays frozen.
const FROZEN_OPTIONAL_KEYS = ["flippedIn"];
// Lanes that have performed an authorised reject -> accept flip.
const FORWARD_FLIP_LANES = Object.freeze(["INT-A", "INT-B", "INT-C", "CUT4"]);
const ERROR_CODES = new Set(["invalid-yaml", "invalid-schema", "unsupported", "view-not-found"]);

// The single central expectations table. Keep it in sync with the on-disk corpus:
// the manifest test below fails if a fixture is missing here or vice versa.
const CORPUS_EXPECTATIONS = Object.freeze({
  // family 1 — official-doc equivalents
  "official-filters-nested-or-and-not": { flipIn: null },
  "official-filters-global-and-view": { flipIn: null },
  "official-filter-comparison-operators": { flipIn: null },
  "official-filter-string-operators": { flipIn: null },
  "official-filter-comparison-coercion": { flipIn: null },
  "official-formula-aslink-if-fallback": { columns: [["file.name", "名称"], ["status", "status"], ["formula.note", "formula.note"]], flipIn: null },
  "official-formula-nested-if": { flipIn: null },
  "official-formula-arithmetic-ppu": { flipIn: null },
  "official-formula-builtin-tolist": { flipIn: null },
  "official-formula-global-function": { flipIn: null },
  "official-formula-formula-ref": { flipIn: null, flippedIn: "INT-B" }, // flipped in INT-B (reject -> accept): formula.<name> is wired
  "official-formula-this": { flipIn: null },
  "official-properties-displayname-formula": { columns: [["file.name", "名称"], ["formula.label", "Label"]], flipIn: null },
  "official-properties-displayname-note": { columns: [["status", "status"], ["formula.label", "Label"]], flipIn: null },
  "official-view-complete-table": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (groupBy + view/top summaries execute)
  "official-view-summaries-builtins": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (view.summaries execute)
  "official-top-summaries-custom": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (top-level summaries = registry, unreferenced)
  "official-view-groupby-asc": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (view.groupBy executes)
  "official-view-groupby-desc": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (view.groupBy executes)
  "official-view-groupby-property-only": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (direction defaults to ASC)
  "official-view-groupby-bad-direction": { flipIn: "W0-D" }, // still rejects, now as an invalid direction value
  "official-view-groupby-with-sort-and-limit": { flipIn: null, flippedIn: "CUT4" }, // flipped in CUT4 (limit before grouping)
  "official-view-type-list": { flipIn: null }, // DISPLAY-METADATA: never flips
  "official-view-type-cards": { flipIn: null }, // DISPLAY-METADATA: never flips
  "official-view-type-map": { flipIn: null }, // DISPLAY-METADATA: never flips
  "official-view-type-unknown": { flipIn: null }, // DISPLAY-METADATA: never flips
  "official-view-cardSize-table": { flipIn: null }, // DISPLAY-METADATA: never flips
  "official-filter-hastag-nested": { flipIn: null },
  "official-file-property-filter": { flipIn: null },
  "official-file-property-sort": { flipIn: null },
  "official-file-property-formula-unsupported": { flipIn: null },

  // family 2 — real-world shapes (generalised field names, synthetic values)
  "real-project-tag-filter-views-sort": { columns: [["file.name", "名称"], ["status", "status"], ["priority", "priority"], ["formula.label", "Project"]], flipIn: null },
  "real-project-second-view-select": { viewName: "Done", flipIn: null },
  "real-maps-title-formula": { flipIn: null },
  "real-project-limit-truncation": { flipIn: null },
  "real-project-request-limit-override": { limit: 1, flipIn: null },
  "real-project-empty-result": { flipIn: null },
  "real-project-unsorted-input-order": { flipIn: null },

  // family 3 — YAML / schema boundaries
  "boundary-empty-base": { flipIn: null },
  "boundary-empty-views": { flipIn: null },
  "boundary-missing-view-name": { flipIn: null },
  "boundary-missing-view-type": { flipIn: null },
  "boundary-limit-zero": { flipIn: null },
  "boundary-limit-negative": { flipIn: null },
  "boundary-limit-fraction": { flipIn: null },
  "boundary-limit-string": { flipIn: null },
  "boundary-root-list": { flipIn: null },
  "boundary-views-not-array": { flipIn: null },
  "boundary-malformed-yaml": { flipIn: null },
  "boundary-request-view-not-found": { viewName: "Ghost", flipIn: null },
  "boundary-filters-empty-array": { flipIn: null },
  "boundary-sort-empty-array": { flipIn: null },

  // family 4 — hostile keys, unknown namespaces and unsupported file helpers
  "hostile-proto-filter-key": { flipIn: null },
  "hostile-proto-formula-name": { columns: [["formula.__proto__", "formula.__proto__"]], flipIn: null },
  "hostile-proto-frontmatter-property": { flipIn: null },
  "hostile-inherited-constructor-filter": { flipIn: null }, // DEFERRED (P1-A security): never flips in W0-D
  "hostile-unknown-namespace-filter": { flipIn: "W0-D" }, // flipped in W0-D (filter unknown namespace)
  "hostile-unsupported-file-property-filter": { flipIn: null }, // DEFERRED (P1-A typing): never flips in W0-D
  "hostile-formula-note-namespace": { flipIn: null, flippedIn: "INT-A" }, // flipped in INT-A (reject -> accept): note.<prop> is wired
  "hostile-formula-number-literal": { flipIn: null, flippedIn: "INT-A" }, // flipped in INT-A (reject -> accept): number literals evaluate
  "hostile-formula-comparison": { flipIn: null, flippedIn: "INT-A" }, // flipped in INT-A (reject -> accept): comparison operators evaluate
  "hostile-formula-literal-true": { flipIn: null, flippedIn: "INT-A" }, // flipped in INT-A (reject -> accept): true/false/null are typed literals
  "hostile-formula-missing-reference": { flipIn: null },
  "hostile-formula-in-view-sort": { flipIn: null, flippedIn: "INT-C" }, // flipped in INT-C (reject -> accept): formula.* in view.sort
  "hostile-formula-in-view-filter": { flipIn: null, flippedIn: "INT-C" }, // flipped in INT-C (reject -> accept): formula.* in view.filters
  "hostile-formula-depth-25": { flipIn: null },
  "hostile-formula-non-string": { flipIn: null },
  "hostile-sort-bad-direction": { flipIn: null },
  "hostile-sort-missing-direction": { flipIn: null },
  "hostile-unknown-filter-object": { flipIn: null },
  "hostile-unknown-filter-function": { flipIn: null },
  "hostile-unknown-view-key": { flipIn: null }, // DISPLAY-METADATA: never flips
  "hostile-unknown-properties-key": { flipIn: null }, // DISPLAY-METADATA: never flips
  "hostile-overlong-string-literal": { flipIn: null },
});

async function collectBases(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collectBases(full)));
    else if (entry.name.endsWith(".base")) found.push(full);
  }
  return found;
}

async function loadFixtures() {
  const files = (await collectBases(FIXTURE_ROOT)).sort();
  const fixtures = [];
  for (const file of files) {
    const id = path.basename(file, ".base");
    const raw = await fs.readFile(file, "utf8");
    const records = JSON.parse(await fs.readFile(file.replace(/\.base$/, ".records.json"), "utf8"));
    const expected = JSON.parse(await fs.readFile(file.replace(/\.base$/, ".expected.json"), "utf8"));
    fixtures.push({ id, family: path.basename(path.dirname(file)), raw, records, expected });
  }
  return fixtures;
}

const fixtures = await loadFixtures();

test("corpus: every fixture has an entry in CORPUS_EXPECTATIONS and vice versa", () => {
  assert.ok(fixtures.length >= 70, `corpus is too small: ${fixtures.length} fixtures`);
  const ids = fixtures.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length, "fixture ids must be unique");
  assert.deepEqual([...ids].sort(), Object.keys(CORPUS_EXPECTATIONS).sort());
  const families = new Set(fixtures.map((fixture) => fixture.family));
  for (const family of ["official", "real", "hostile"]) {
    assert.ok(families.has(family), `missing fixture family: ${family}`);
  }
});

test("corpus: expected.json files only carry the frozen shape", () => {
  for (const fixture of fixtures) {
    // Additive INT-A extension: the six frozen keys keep their exact set and order;
    // `flippedIn` is the only additional key allowed, so an unknown key still fails.
    assert.deepEqual(Object.keys(fixture.expected).filter((key) => FROZEN_KEYS.includes(key)), FROZEN_KEYS, `${fixture.id}: expected.json keys`);
    const extraKeys = Object.keys(fixture.expected).filter((key) => !FROZEN_KEYS.includes(key));
    assert.deepEqual(extraKeys.filter((key) => !FROZEN_OPTIONAL_KEYS.includes(key)), [], `${fixture.id}: expected.json has an unknown key`);
    assert.ok(["accept", "reject"].includes(fixture.expected.outcome), `${fixture.id}: outcome`);
    assert.ok(fixture.expected.outcome === "accept" ? fixture.expected.code === null : ERROR_CODES.has(fixture.expected.code), `${fixture.id}: code`);
    assert.equal(fixture.expected.supportedSubset, fixture.expected.outcome === "accept", `${fixture.id}: supportedSubset`);
    assert.equal(fixture.expected.flipIn, CORPUS_EXPECTATIONS[fixture.id].flipIn, `${fixture.id}: flipIn must match CORPUS_EXPECTATIONS`);
    // A flipped fixture is a *completed* flip: `flipIn` may never mark a fixture
    // that still accepts, or a rejection that is not the frozen `unsupported`.
    if (fixture.expected.flipIn !== null) {
      assert.equal(fixture.expected.outcome, "reject", `${fixture.id}: a flipped fixture must reject`);
      assert.equal(fixture.expected.code, "unsupported", `${fixture.id}: a Wave 0-D flip is always unsupported`);
    }
    // Additive INT-A guard: `flippedIn` marks a completed reject -> accept flip, so it
    // may never sit on a fixture that still rejects, and it must match the table.
    if (fixture.expected.flippedIn !== undefined) {
      assert.ok(FORWARD_FLIP_LANES.includes(fixture.expected.flippedIn), `${fixture.id}: flippedIn lane`);
      assert.equal(fixture.expected.outcome, "accept", `${fixture.id}: a forward-flipped fixture must accept`);
      assert.equal(fixture.expected.flipIn, null, `${fixture.id}: a forward-flipped fixture cannot also carry flipIn`);
      assert.equal(CORPUS_EXPECTATIONS[fixture.id].flippedIn, fixture.expected.flippedIn, `${fixture.id}: flippedIn must match CORPUS_EXPECTATIONS`);
    }
    assert.ok(fixture.expected.note.length > 0, `${fixture.id}: note`);
  }
});

for (const fixture of fixtures) {
  const spec = CORPUS_EXPECTATIONS[fixture.id];
  test(`bases corpus (${fixture.family}): ${fixture.id}`, () => {
    const input = { raw: fixture.raw, records: fixture.records };
    if (spec.viewName) input.viewName = spec.viewName;
    if (spec.limit) input.limit = spec.limit;

    let snapshot;
    let failure;
    try {
      snapshot = queryBaseSnapshot(input);
    } catch (error) {
      failure = error;
    }

    if (fixture.expected.outcome === "reject") {
      assert.ok(failure instanceof BaseQueryError, `${fixture.id}: must fail closed`);
      assert.equal(failure.code, fixture.expected.code, `${fixture.id}: error code (${failure.message})`);
      assert.deepEqual(fixture.expected.rowPaths, [], `${fixture.id}: a rejected query yields no rows`);
      assert.equal(fixture.expected.supportedSubset, false, `${fixture.id}: supportedSubset`);
      return;
    }

    assert.equal(failure, undefined, `${fixture.id}: must not fail: ${failure?.message}`);
    assert.equal(snapshot.supportedSubset, true, `${fixture.id}: supportedSubset`);
    assert.deepEqual(snapshot.rows.map((row) => row.path), fixture.expected.rowPaths, `${fixture.id}: row paths`);
    if (spec.columns) {
      assert.deepEqual(snapshot.columns.map((column) => [column.key, column.label]), spec.columns, `${fixture.id}: column labels`);
    }
  });
}
