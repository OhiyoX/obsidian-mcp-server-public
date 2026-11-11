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
  file_upload_status: Object.freeze({
    property: "receiptId",
    spec: Object.freeze({ type: Object.freeze(["string", "null"]), description: "receiptId value returned by the tool." }),
    reason: "R1 (§6.4/R1 brief): additive nullable receipt id, already returned by transfer-runtime.fileUploadStatus since #704.",
  }),
});

function projectAddedOutputProperty(name, schema) {
  const rule = WAVE1_OUTPUT_SCHEMA_ADDITIONS[name];
  if (!rule) return schema;
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
  const comparable = cloneJson(schema);
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
export function wave1ComparableOutputSchema(name, schema) {
  return projectAddedOutputProperty(name, schema);
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
  }
  return comparable;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function wave1ComparableInputSchema(name, schema) {
  const projected = projectAddedProperty(name, vaultScopeComparableInputSchema(name, schema));
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
