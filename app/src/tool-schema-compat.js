// Explicit compatibility rules for comparing the current MCP input schemas
// with the frozen Wave 1 tool inventory.
//
// The inventory is historical evidence and must not be rewritten when a later
// schema change is backward-compatible. Instead, a narrowly-scoped rule may
// project the current schema back to its historical shape for baseline
// comparison. Any field not named by a rule remains byte-for-byte protected.

import { VAULT_ID_INPUT_SPEC, isVaultScopedTool } from "./vault-scope.js";

const MAX_DIFF_CHARS_TOOLS = Object.freeze([
  "plan_note_changes",
  "plan_move_note",
  "plan_delete_note",
  "plan_restore_version",
  "plan_restore_from_trash",
  "compare_note_versions",
]);

/**
 * The two Publish tools declared `vaultId` locally before Wave C (contract §7.3: "现有 Publish
 * 手写 vaultId 必须被 parity test 验证；收口时优先删除局部重复定义"). The Wave 1 inventory
 * recorded that local shape, so the comparison restores it after removing the canonical field —
 * the parity assertion itself lives in `test/multi-vault-vault-scope-contract.test.js`.
 */
const PUBLISH_LOCAL_VAULT_ID = Object.freeze({
  get_publish_status: Object.freeze({ type: "string", minLength: 1 }),
  manage_publish: Object.freeze({ type: "string", minLength: 1 }),
});

/**
 * Multi-Vault Wave C (contract §7.3): every vault-scoped tool's input schema gained the canonical
 * optional `vaultId`, and global tools (§7.1) must not carry it. This projection removes exactly
 * that one property — and only when it is byte-identical to the frozen canonical spec — so the
 * historical Wave 1 inventory stays the comparison baseline while any other schema change still
 * drifts. A tool classified as vault-scoped without the property, or a global tool carrying it, is
 * an error rather than a silently tolerated difference.
 */
export function vaultScopeComparableInputSchema(name, schema) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const declared = properties[VAULT_ID_INPUT_SPEC.name];
  const scoped = isVaultScopedTool(name);
  if (declared === undefined) {
    if (scoped) throw new Error(`${name} is vault-scoped but its inputSchema declares no canonical ${VAULT_ID_INPUT_SPEC.name}`);
    return schema;
  }
  if (!scoped) throw new Error(`${name} is a global tool but its inputSchema declares ${VAULT_ID_INPUT_SPEC.name}`);
  const expected = {
    type: VAULT_ID_INPUT_SPEC.type,
    minLength: VAULT_ID_INPUT_SPEC.minLength,
    maxLength: VAULT_ID_INPUT_SPEC.maxLength,
    description: VAULT_ID_INPUT_SPEC.description,
  };
  const actualKeys = Object.keys(declared).sort();
  const expectedKeys = Object.keys(expected).sort();
  const exact = actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && actualKeys.every((key) => declared[key] === expected[key]);
  if (!exact) throw new Error(`${name} ${VAULT_ID_INPUT_SPEC.name} must be the canonical spec, got ${JSON.stringify(declared)}`);
  const comparable = cloneJson(schema);
  delete comparable.properties[VAULT_ID_INPUT_SPEC.name];
  const historical = PUBLISH_LOCAL_VAULT_ID[name];
  if (historical) comparable.properties[VAULT_ID_INPUT_SPEC.name] = { ...historical };
  return comparable;
}

export const WAVE1_INPUT_SCHEMA_WIDENINGS = Object.freeze(Object.fromEntries(
  MAX_DIFF_CHARS_TOOLS.map((name) => [name, Object.freeze({
    property: "maxDiffChars",
    keyword: "minimum",
    historicalValue: 1000,
    currentValue: 1,
    reason: "Allow compact diff previews while preserving the historical default and upper bound.",
  })]),
));

/**
 * Additive input properties: `query_base` gained an optional `format` selector (A1,
 * `desktop-re/mcp-a1-formats`) and the three optional ad-hoc narrowing inputs `filters` / `sort` /
 * `search` (#628, `desktop-re/mcp-query-adhoc`). Every one of them is optional and leaves the
 * historical default behavior byte-identical, so the Wave 1 inventory stays the comparison baseline
 * by projecting the new properties away — but only while each one is byte-identical to its frozen
 * spec. Any other shape, or any unrelated schema drift, still fails the comparison (the projection
 * cannot hide it). Unlike `WAVE1_INPUT_SCHEMA_WIDENINGS` these are *additions*, so they are
 * deliberately not reported by `hasWave1InputSchemaWidening()` (whose live-catalog set is asserted
 * exactly).
 *
 * The ad-hoc specs are deliberately the loose transport shapes the handler validates itself
 * (`z.unknown()` for the recursive filter tree, `z.array(z.unknown())` for the sort items, a plain
 * string for the search literal): the frozen operator/column/direction rules are enforced by the
 * canonical evaluator, and a second JSON-Schema copy of them would be a second rule set to drift.
 */
export const WAVE1_INPUT_SCHEMA_ADDITIONS = Object.freeze({
  // B (#834, 2026-11-24): a rollback no longer needs a snapshot only — the same two tools take a
  // Markdown note's committed bytes at a Vault Git revision. Both properties are optional and the
  // versionId form is unchanged, so a Wave 1 caller sends the same request as before.
  restore_version: Object.freeze([
    Object.freeze({
      property: "path",
      spec: Object.freeze({ type: "string", minLength: 1 }),
      reason: "B (#834): the note a Git-revision restore writes; alternates with versionId.",
    }),
    Object.freeze({
      property: "revision",
      spec: Object.freeze({ type: "string", minLength: 1, description: "Vault Git commit (4-40 hex), HEAD or HEAD~N; use with path instead of versionId. Markdown only." }),
      reason: "B (#834): the commit to read the note from; alternates with versionId.",
    }),
  ]),
  plan_restore_version: Object.freeze([
    Object.freeze({
      property: "path",
      spec: Object.freeze({ type: "string", minLength: 1 }),
      reason: "B (#834): preview target of a Git-revision restore; alternates with versionId.",
    }),
    Object.freeze({
      property: "revision",
      spec: Object.freeze({ type: "string", minLength: 1, description: "Vault Git commit (4-40 hex), HEAD or HEAD~N; use with path instead of versionId. Markdown only." }),
      reason: "B (#834): preview source commit; alternates with versionId.",
    }),
  ]),
  // S6 (#666): source provenance is real evidence, not free (about 220 bytes per item).
  get_note_context: Object.freeze([
    Object.freeze({
      property: "includeProvenance",
      spec: Object.freeze({ default: false, description: "Attach per-item source provenance and index freshness (about 220 bytes per item). Off by default.", type: "boolean" }),
      reason: "S6 (#666): opt-in source provenance on the context bundle.",
    }),
  ]),

  // S7 (2026-11-13, #667): `get_file` can return page-cited PDF text. Both inputs are optional and
  // `encoding: "auto"` keeps its historical base64 answer, so an old caller is unaffected.
  get_file: Object.freeze([
    Object.freeze({
      property: "pdfText",
      spec: Object.freeze({ default: false, description: "Return page-cited text extracted from a PDF instead of base64.", type: "boolean" }),
      reason: "S7 (#667): opt-in page-cited PDF text; absent, a PDF still reads as base64.",
    }),
    Object.freeze({
      property: "maxChars",
      spec: Object.freeze({ default: 20000, description: "pdfText only: total excerpt budget across pages.", type: "integer", minimum: 1, maximum: 200000 }),
      reason: "S7: excerpt budget for pdfText; ignored by every other read.",
    }),
  ]),
  // C4 (#668, 2026-11-14): `graph_health` can return reviewable link-repair proposals. Opt-in, and
  // absent it changes nothing, so the historical audit payload stays byte-identical.
  graph_health: Object.freeze([
    Object.freeze({
      property: "includeProposals",
      spec: Object.freeze({ default: false, description: "Return `proposals` for reviewable link repairs: ambiguous targets as candidates only (never a chosen one) and single-candidate spelling fixes, each with the expectedRevision plan_note_changes takes. Executes nothing.", type: "boolean" }),
      reason: "C4 (#668): opt-in proposals for the reviewed plan/apply path; the default answer is unchanged.",
    }),
  ]),
  // Task 8 (2026-11-08 folder publish): `manage_publish` publishes a directory when it is told
  // `kind: "folder"`. Optional, so the historical "one Markdown note" call is byte-identical.
  manage_publish: Object.freeze([
    Object.freeze({
      property: "kind",
      spec: Object.freeze({ type: "string", enum: Object.freeze(["document", "folder"]) }),
      reason: "Task 8: publish a folder; the default (absent) is a document record.",
    }),
  ]),
  query_base: Object.freeze([
    Object.freeze({
      property: "format",
      spec: Object.freeze({ type: "string" }),
      reason: "A1: optional output format selector; the default json DTO is unchanged.",
    }),
    Object.freeze({
      property: "filters",
      spec: Object.freeze({}),
      reason: "#628: optional ad-hoc filter tree, AND-combined with the base/view filters.",
    }),
    Object.freeze({
      property: "sort",
      spec: Object.freeze({ type: "array", items: Object.freeze({}) }),
      reason: "#628: optional ad-hoc sort list that replaces the view sort.",
    }),
    Object.freeze({
      property: "search",
      spec: Object.freeze({ type: "string" }),
      reason: "#628: optional ad-hoc substring predicate, AND-combined with the filters.",
    }),
  ]),
  // O5 (2026-11-13, token optimization): `get_note` gained the optional `ifRevision` so an agent
  // can ask "has this changed?" without re-reading the body. Absent, the answer is today's note.
  get_note: Object.freeze([
    Object.freeze({
      property: "ifRevision",
      spec: Object.freeze({
        description: "Optional revision returned by get_note; when it still matches, the answer is {path, revision, notModified: true} with no body.",
        type: "string",
        minLength: 1,
      }),
      reason: "O5: optional revision-aware conditional read; without it the full note is returned.",
    }),
  ]),
  // O3 (2026-11-13) + S6 (#666): the three search-shaped tools gained the optional `view`
  // projection and opt-in source provenance. Default `full` without provenance is today's payload
  // byte for byte, so the historical inventory stays the baseline.
  ...Object.fromEntries(Object.freeze([
    ["search_notes", "about 225 bytes per hit"],
    ["recall", "about 120 bytes per hit"],
    ["find_related", "about 120 bytes per hit"],
  ]).map(([name, cost]) => [name, Object.freeze([
    Object.freeze({
      property: "view",
      spec: Object.freeze({
        default: "full",
        description: "Result detail: full (default, unchanged) keeps every field; standard drops excerpt text; brief keeps only path, revision, the totals/truncation state and the semantic status.",
        type: "string",
        enum: Object.freeze(["full", "standard", "brief"]),
      }),
      reason: "O3: optional result-detail projection; the default reproduces the historical payload.",
    }),
    Object.freeze({
      property: "includeProvenance",
      spec: Object.freeze({
        default: false,
        description: name === "search_notes"
          ? `Attach per-hit source provenance and index freshness (${cost}). Off by default: it is evidence you ask for, not a tax on every search.`
          : `Attach per-hit source provenance and index freshness (${cost}). Off by default.`,
        type: "boolean",
      }),
      reason: "S6 (#666): opt-in source provenance; absent, the hit shape is unchanged.",
    }),
  ])])),
});

/**
 * Task 8 (2026-11-08 folder publish): a Publish record now has a `kind` (`document` / `folder`),
 * and its public address shape depends on it (`/publish/<id>` vs `/publish/d/<id>`). Both tools
 * report it, and it is `null` when no record exists (a revoke), so the property is a nullable
 * union rather than the default `string`. Declared here so the frozen Wave 1 output contract
 * stays byte-identical while any other output drift still fails.
 */
const PUBLISH_KIND_OUTPUT = Object.freeze({
  property: "kind",
  spec: Object.freeze({ type: Object.freeze(["string", "null"]), description: "kind value returned by the tool." }),
  reason: "Task 8: the record kind explains the public-path shape; document records are unchanged.",
});

export const WAVE1_OUTPUT_SCHEMA_ADDITIONS = Object.freeze({
  get_publish_status: PUBLISH_KIND_OUTPUT,
  manage_publish: PUBLISH_KIND_OUTPUT,
  get_base: Object.freeze({
    property: "revision",
    spec: Object.freeze({ type: "string", description: "revision value returned by the tool." }),
    reason: "P1 #629: additive content-revision output field; it is the CAS precondition patch_base.ifMatch consumes.",
  }),
  // R1 (review-f3-f5): #704 made `file_upload_status` answer the publish receipt the completing
  // PUT/PATCH already returned, so a client that lost that response can recover the id without
  // another round trip. Additive and never fabricated — `null` until a publish wrote one — hence the
  // nullable union rather than the default `string`, which would advertise a value that does not
  // exist before completion. Declared here (not by rewriting the inventory) so the frozen Wave 1
  // output contract stays byte-identical while any OTHER output drift still fails.
  // B (#834, 2026-11-24): a restore now says where its bytes came from, and — when the note
  // already existed — which snapshot of the previous bytes it wrote, so one call undoes it. Both
  // are optional: the versionId form keeps the historical four fields only.
  restore_version: Object.freeze([
    Object.freeze({
      property: "sourceRevision",
      spec: Object.freeze({ type: "string", description: "sourceRevision value returned by the tool." }),
      reason: "B (#834): names the Git commit a path + revision restore read, so the answer is auditable.",
    }),
    Object.freeze({
      property: "preWriteVersionId",
      spec: Object.freeze({ type: Object.freeze(["string", "null"]), description: "preWriteVersionId value returned by the tool." }),
      reason: "B (#834): the snapshot of the bytes the restore replaced, so the restore itself can be undone.",
    }),
  ]),
  file_upload_status: Object.freeze({
    property: "receiptId",
    spec: Object.freeze({ type: Object.freeze(["string", "null"]), description: "receiptId value returned by the tool." }),
    reason: "R1 (§6.4/R1 brief): additive nullable receipt id, already returned by transfer-runtime.fileUploadStatus since #704.",
  }),
});

function projectAddedOutputProperty(name, schema) {
  const declared = WAVE1_OUTPUT_SCHEMA_ADDITIONS[name];
  if (!declared) return schema;
  // A tool may declare more than one additive property (B: `sourceRevision` and
  // `preWriteVersionId`); a single rule keeps its historical object shape.
  const rules = Array.isArray(declared) ? declared : [declared];
  let comparable = schema;
  for (const rule of rules) comparable = projectOneOutputProperty(name, comparable, rule);
  return comparable;
}

function projectOneOutputProperty(name, schema, rule) {
  const property = schema?.properties?.[rule.property];
  // Absent: leave the schema untouched so the historical byte comparison reports
  // the removal as drift (the projection must never invent or hide a property).
  if (property === undefined) return schema;
  const expectedKeys = Object.keys(rule.spec).sort();
  const actualKeys = Object.keys(property).sort();
  const exact = actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    // JSON comparison, not `===`: `file_upload_status.receiptId` declares `type` as the two-element
    // array `["string", "null"]`, and a fresh array from `z.toJSONSchema()` is never reference-equal
    // to the frozen spec. The input twin (`projectAddedProperty`) compares the same way.
    && actualKeys.every((key) => JSON.stringify(property[key]) === JSON.stringify(rule.spec[key]));
  if (!exact) {
    throw new Error(
      `${name} output compatibility rule expects an exact ${rule.property} spec ` +
      `${JSON.stringify(rule.spec)} (${rule.reason}), got ${JSON.stringify(property)}`,
    );
  }
  const comparable = schema === undefined ? schema : cloneJson(schema);
  delete comparable.properties[rule.property];
  // A REQUIRED additive property (`file_upload_status.receiptId`) also leaves its name in
  // `required`; the historical shape had neither, so the projection must drop both or the byte
  // comparison would report the residue as drift. Only the declared property is touched.
  if (Array.isArray(comparable.required)) {
    comparable.required = comparable.required.filter((key) => key !== rule.property);
  }
  return comparable;
}

/**
 * The output-contract twin of `wave1ComparableInputSchema`: it projects exactly the declared
 * additive output properties away, so the frozen Wave 1 inventory stays the comparison baseline.
 * An undeclared output change (or a spec that drifted from the frozen one) still fails the byte
 * comparison.
 */
// The output twin of the input relaxation above: a Git-revision restore has no `versionId` to
// report, so that one field became optional. Restoring the historical `required` keeps the frozen
// contract comparable while every other output change still drifts.
const WAVE1_OUTPUT_SCHEMA_RELAXATIONS = Object.freeze({
  restore_version: Object.freeze({
    property: "versionId",
    // The historical `required` array, in the order the baseline recorded (arrays are compared
    // byte for byte; a re-sorted array hashes differently). Set equality is still checked, so this
    // cannot hide any other `required` change.
    required: Object.freeze(["restoredPath", "versionId", "revision", "size"]),
  }),
});

export function wave1ComparableOutputSchema(name, schema) {
  const projected = projectAddedOutputProperty(name, schema);
  const rule = WAVE1_OUTPUT_SCHEMA_RELAXATIONS[name];
  if (!rule || !projected?.properties || !(rule.property in projected.properties)) return projected;
  const required = Array.isArray(projected.required) ? projected.required : [];
  if (required.includes(rule.property)) return projected;
  const historical = rule.required ?? [...required, rule.property].sort();
  const today = [...required, rule.property].sort();
  if (historical.length !== today.length || historical.slice().sort().some((key, index) => key !== today[index])) {
    throw new Error(`${name} relaxation rule expects the historical required set ${JSON.stringify(historical)}, got ${JSON.stringify(required)}`);
  }
  const comparable = cloneJson(projected);
  comparable.required = [...historical];
  return comparable;
}

/**
 * B (#834, 2026-11-24): `restore_version` and `plan_restore_version` used to REQUIRE `versionId`.
 * A Markdown restore from a Vault Git revision passes `path` + `revision` instead, so `versionId`
 * became optional — a relaxation, never a break: every Wave 1 call still carries `versionId` and is
 * accepted byte for byte as before. The projection restores the historical requirement for the
 * baseline comparison only; any other `required` change still drifts.
 */
const WAVE1_INPUT_SCHEMA_RELAXATIONS = Object.freeze({
  restore_version: Object.freeze({ property: "versionId", reason: "B (#834): path + revision can replace versionId." }),
  plan_restore_version: Object.freeze({ property: "versionId", reason: "B (#834): path + revision can replace versionId." }),
});

function projectRelaxedRequirement(name, schema) {
  const rule = WAVE1_INPUT_SCHEMA_RELAXATIONS[name];
  if (!rule) return schema;
  if (!schema?.properties || !(rule.property in schema.properties)) {
    throw new Error(`${name} relaxation rule expects inputSchema.properties.${rule.property}`);
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.includes(rule.property)) return schema;
  const comparable = cloneJson(schema);
  comparable.required = [rule.property, ...required];
  return comparable;
}

function projectAddedProperty(name, schema) {
  const rules = WAVE1_INPUT_SCHEMA_ADDITIONS[name];
  if (!rules) return schema;
  let comparable = schema;
  for (const rule of rules) {
    const property = schema?.properties?.[rule.property];
    // Absent: leave the schema untouched so the historical byte comparison reports
    // the removal as drift (the projection must never invent or hide a property).
    if (property === undefined) continue;
    const expectedKeys = Object.keys(rule.spec).sort();
    const actualKeys = Object.keys(property).sort();
    const exact = actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index])
      // JSON comparison, not `===`: the ad-hoc specs carry nested shapes
      // (`{type:"array",items:{}}`) and an empty `{}` is never reference-equal.
      && actualKeys.every((key) => JSON.stringify(property[key]) === JSON.stringify(rule.spec[key]));
    if (!exact) {
      throw new Error(
        `${name} compatibility rule expects an exact ${rule.property} spec ` +
        `${JSON.stringify(rule.spec)} (${rule.reason}), got ${JSON.stringify(property)}`,
      );
    }
    if (comparable === schema) comparable = cloneJson(schema);
    delete comparable.properties[rule.property];
    // A property that carries a `default` is REQUIRED in the rendered schema, so its name also sits
    // in `required`; the historical shape had neither and only the declared property is touched.
    if (Array.isArray(comparable.required)) comparable.required = comparable.required.filter((key) => key !== rule.property);
  }
  return comparable;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function wave1ComparableInputSchema(name, schema) {
  const projected = projectRelaxedRequirement(name, projectAddedProperty(name, vaultScopeComparableInputSchema(name, schema)));
  const rule = WAVE1_INPUT_SCHEMA_WIDENINGS[name];
  if (!rule) return projected;

  const property = projected?.properties?.[rule.property];
  if (!property || typeof property !== "object") {
    throw new Error(`${name} compatibility rule cannot find inputSchema.properties.${rule.property}`);
  }

  const actual = property[rule.keyword];
  if (actual === rule.historicalValue) return projected;
  if (actual !== rule.currentValue) {
    throw new Error(
      `${name} compatibility rule expected ${rule.property}.${rule.keyword} ` +
      `${rule.historicalValue} (historical) or ${rule.currentValue} (compatible widening), got ${String(actual)}`,
    );
  }

  const comparable = cloneJson(projected);
  comparable.properties[rule.property][rule.keyword] = rule.historicalValue;
  return comparable;
}

export function hasWave1InputSchemaWidening(name, schema) {
  const rule = WAVE1_INPUT_SCHEMA_WIDENINGS[name];
  return Boolean(rule && schema?.properties?.[rule.property]?.[rule.keyword] === rule.currentValue);
}
