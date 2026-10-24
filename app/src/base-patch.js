// Web write surface A4a — `.base` line-surgical patch (pure module).
// Authority: WRITE-SURFACE-DESIGN.md §6.3 (line-level surgical patch), §2.1 (an increment, never
// a whole document), §6.1 (unknown keys survive by construction). The locator lives in
// `base-patch-lines.js`; this module owns the mutation face: the desktop write whitelist, the
// three initial operations, and the locator safety net. Every line outside the patched lines is
// byte-identical: what cannot be addressed exactly is refused with `base-not-patchable` instead
// of being re-serialised (`yaml.dump` drops comments, key order and quote style), and off-
// whitelist keys with `base-unknown-key` before any line is touched; `base-query.js` keeps
// owning `invalid-yaml` / `invalid-schema`. Order (BRIEF-FIX2): shape → whitelist (whole batch,
// before the YAML parse) → parse → gate the region → "already equal ⇒ skip the write". Purity (asserted by test/base-patch.test.js): no fs / path / express / MCP import.

import yaml from "js-yaml";
import { BaseQueryError, parseAndValidateBase } from "./base-query.js";
import {
  BASE_PATCH_ERROR_CODES,
  BasePatchError,
  assertPatchableRegion,
  blockRange,
  contentEnd,
  findTopLevelEntry,
  insertLines,
  joinLines,
  mappingEntries,
  notPatchable,
  readKeyEntry,
  splitLines,
  tokenize,
} from "./base-patch-lines.js";

export { BASE_PATCH_ERROR_CODES, BasePatchError };

// Desktop view keys (RECON §1.5 / design §1.5) plus properties.<name>.displayName, formulas.<name>.
export const BASE_VIEW_OPTION_KEYS = Object.freeze([
  "type",
  "name",
  "filters",
  "groupBy",
  "groupOrder",
  "summaries",
  "order",
  "sort",
  "limit",
]);

export const BASE_PATCH_OPERATIONS = Object.freeze(["set-view-option", "set-formulas", "set-property-display-name"]);

const OP_FIELDS = Object.freeze({
  "set-view-option": ["op", "view", "key", "value"],
  "set-formulas": ["op", "key", "value"],
  "set-property-display-name": ["op", "property", "value"],
});

const unknownKey = (key) =>
  new BasePatchError(
    `Base key is outside the desktop write whitelist: views[].${String(key)} (writable view keys: ` +
      `${BASE_VIEW_OPTION_KEYS.join(", ")}; plus properties.<name>.displayName and formulas.<name>)`,
    "base-unknown-key",
  );

const invalid = (message) => new BaseQueryError(message, "invalid-schema");

function serializeScalar(value) {
  if (typeof value === "number" && !Number.isFinite(value)) throw invalid("Base patch values must be finite numbers");
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw notPatchable(`only scalar values can be written in place (got ${Array.isArray(value) ? "array" : typeof value})`);
  }
  return yaml.dump(value, { lineWidth: -1 }).trimEnd();
}

const serializeKey = (key) => (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) ? key : yaml.dump(key, { lineWidth: -1 }).trimEnd());

// Deep, strict equality of *parsed* values, used only to decide "this mutation is a no-op": `undefined` equals nothing, a number never equals its string spelling, `null` only itself.
function sameValue(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

// FIX2 gate: the no-op comparison happens only after the located entry is accepted, so "same value" cannot make an illegal target a success.
function replaceable(lines, entry) {
  if (entry.value === "") throw notPatchable(`\`${entry.key}\` holds a nested block, not a scalar`);
  assertPatchableRegion(lines, entry.line, entry.line + 1);
}

// The addressed line is rewritten in place, so the origin snapshot still names the slot the splice must fill (`replaces`).
function replaceScalar(state, entry, value) {
  const { lines } = state;
  replaceable(lines, entry);
  const line = lines[entry.line];
  const token = tokenize(line.text);
  const body = token.body.slice(0, token.body.length - entry.value.length) + serializeScalar(value);
  line.text = line.text.slice(0, token.bodyOffset) + body;
}

const insertEntry = (lines, at, indent, key, value) =>
  insertLines(lines, at, [`${" ".repeat(indent)}${serializeKey(key)}: ${serializeScalar(value)}`]);

// ----------------------------------------------------------------- mutations

function validateMutations(mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) throw invalid("Base patch requires a non-empty mutations array");
  return mutations.map((mutation, index) => {
    const at = `mutations[${index}]`;
    if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) throw invalid(`${at} must be an object`);
    if (!BASE_PATCH_OPERATIONS.includes(mutation.op)) throw invalid(`${at}.op must be one of ${BASE_PATCH_OPERATIONS.join(", ")}`);
    for (const key of Object.keys(mutation)) {
      if (!OP_FIELDS[mutation.op].includes(key)) throw invalid(`${at}.${key} is not part of ${mutation.op}`);
    }
    for (const field of OP_FIELDS[mutation.op]) {
      if (!Object.hasOwn(mutation, field)) throw invalid(`${at}.${field} is required`);
    }
    if (mutation.op === "set-view-option") {
      // The whitelist is checked for the whole batch before any line is touched (§6.1).
      if (!BASE_VIEW_OPTION_KEYS.includes(mutation.key)) throw unknownKey(mutation.key);
      if (typeof mutation.view !== "string" || !mutation.view) throw invalid(`${at}.view must be a non-empty string`);
      if (mutation.value === null) throw invalid(`${at}.value must not be null (only set-formulas can delete a key)`);
    }
    if (mutation.op === "set-formulas" && (typeof mutation.key !== "string" || !mutation.key)) {
      throw invalid(`${at}.key must be a non-empty formula name`);
    }
    if (mutation.op === "set-formulas" && mutation.value !== null && typeof mutation.value !== "string") {
      throw invalid(`${at}.value must be a formula string or null`);
    }
    if (mutation.op === "set-property-display-name") {
      if (typeof mutation.property !== "string" || !mutation.property) throw invalid(`${at}.property must be a non-empty string`);
      if (typeof mutation.value !== "string" || !mutation.value) throw invalid(`${at}.value must be a non-empty string`);
    }
    return mutation;
  });
}

// Both non-view write faces share this entry point; `properties` only nests one level deeper.
function topLevelBlock(lines, key) {
  const found = findTopLevelEntry(lines, key);
  if (found && found.entry.value !== "") throw notPatchable(`\`${key}\` is not written as a block mapping`);
  if (!found) return null;
  const block = blockRange(lines, found.line, 0);
  if (block.childIndent !== null && block.childIndent !== 2) {
    throw notPatchable(`\`${key}\` does not use the standard 2-space indentation`);
  }
  return block;
}

function setViewOption(state, expected, mutation) {
  const { lines, base } = state;
  const views = Array.isArray(base.views) ? base.views : [];
  const index = views.findIndex((view) => view && typeof view === "object" && view.name === mutation.view);
  if (index < 0) throw invalid(`view "${mutation.view}" is not declared in this Base`);
  const found = findTopLevelEntry(lines, "views");
  if (!found || found.entry.value !== "") throw notPatchable("`views` is not a block sequence on its own line");
  const block = blockRange(lines, found.line, 0);
  if (block.childIndent !== 2) throw notPatchable("`views` does not use the standard 2-space indentation");
  const items = [];
  for (let line = block.start; line < block.end; line += 1) {
    const token = tokenize(lines[line].text);
    if (token && !token.comment && token.dash && token.dashIndent === 2) items.push(line);
  }
  if (items.length !== views.length) throw notPatchable("`views` items are not addressable one by one");
  const item = items[index];
  if (!readKeyEntry(tokenize(lines[item].text))) throw notPatchable("a view item does not start its mapping on the item line");
  const itemEnd = index + 1 < items.length ? items[index + 1] : block.end;
  assertPatchableRegion(lines, item, itemEnd);
  const entry = mappingEntries(lines, item, itemEnd, 4, 2).get(mutation.key);
  if (entry) replaceable(lines, entry);
  // No-op short circuit, last: writing the value the document already holds must not reach `yaml.dump` (which normalises `"Probe"`), but matching skips no gate above.
  if (sameValue(views[index][mutation.key], mutation.value)) return;
  if (entry) replaceScalar(state, entry, mutation.value);
  else insertEntry(lines, contentEnd(lines, item, itemEnd), 4, mutation.key, mutation.value);
  expected.views[index][mutation.key] = mutation.value;
}

function setFormula(state, expected, mutation) {
  const { lines } = state;
  const block = topLevelBlock(lines, "formulas");
  if (block && state.base.formulas !== undefined && (typeof state.base.formulas !== "object" || Array.isArray(state.base.formulas))) {
    throw invalid("formulas must be a mapping");
  }
  const current = state.base.formulas && typeof state.base.formulas === "object" && !Array.isArray(state.base.formulas) ? state.base.formulas : {};
  // No-op short circuit (see `setViewOption`), after the gate: nothing to write.
  const entry = block ? mappingEntries(lines, block.start, block.end, 2).get(mutation.key) : null;
  if (entry && mutation.value !== null) replaceable(lines, entry);
  if (mutation.value === null ? !Object.hasOwn(current, mutation.key) : sameValue(current[mutation.key], mutation.value)) return;
  if (!block && mutation.value !== null) {
    insertLines(lines, contentEnd(lines, 0, lines.length), [
      "formulas:",
      `  ${serializeKey(mutation.key)}: ${serializeScalar(mutation.value)}`,
    ]);
  } else if (block && mutation.value === null && entry) {
    // Delete the line and everything nested under it (comments included).
    let end = entry.line + 1;
    while (end < block.end && !(tokenize(lines[end].text)?.indent <= 2)) end += 1;
    lines.splice(entry.line, end - entry.line);
  } else if (entry) {
    replaceScalar(state, entry, mutation.value);
  } else if (block && mutation.value !== null) {
    insertEntry(lines, contentEnd(lines, block.start, block.end), 2, mutation.key, mutation.value);
  }
  if (mutation.value === null) {
    if (expected.formulas) delete expected.formulas[mutation.key];
  } else {
    expected.formulas = { ...(expected.formulas ?? {}), [mutation.key]: mutation.value };
  }
}

function setPropertyDisplayName(state, expected, mutation) {
  const { lines } = state;
  const root = expected.properties ?? {};
  expected.properties = root;
  root[mutation.property] = { ...(root[mutation.property] ?? {}), displayName: mutation.value };
  const block = topLevelBlock(lines, "properties");
  if (!block) {
    insertLines(lines, contentEnd(lines, 0, lines.length), [
      "properties:",
      `  ${serializeKey(mutation.property)}:`,
      `    displayName: ${serializeScalar(mutation.value)}`,
    ]);
    return;
  }
  const entry = mappingEntries(lines, block.start, block.end, 2).get(mutation.property);
  if (!entry) {
    insertLines(lines, contentEnd(lines, block.start, block.end), [
      `  ${serializeKey(mutation.property)}:`,
      `    displayName: ${serializeScalar(mutation.value)}`,
    ]);
    return;
  }
  const property = blockRange(lines, entry.line, 2);
  if (property.childIndent !== null && property.childIndent !== 4) {
    throw notPatchable(`\`properties.${mutation.property}\` does not use the standard 2-space indentation`);
  }
  assertPatchableRegion(lines, property.start, property.end);
  const displayName = mappingEntries(lines, property.start, property.end, 4).get("displayName");
  if (displayName) replaceable(lines, displayName);
  // No-op short circuit (see `setViewOption`), after every gate above.
  const declared = state.base.properties?.[mutation.property];
  if (declared && typeof declared === "object" && !Array.isArray(declared) && sameValue(declared.displayName, mutation.value)) return;
  if (displayName) replaceScalar(state, displayName, mutation.value);
  else insertEntry(lines, contentEnd(lines, property.start, property.end), 4, "displayName", mutation.value);
}

// -------------------------------------------------------------------- public

/** Apply an increment to a `.base` document, returning the new text: comments, unknown keys, quote
 * style, CRLF/LF mix and the final-newline state survive byte-for-byte outside the patched lines;
 * an unaddressable document or an off-whitelist key throws instead of producing a document. */
export function patchBaseDocument(raw, mutations) {
  return patchBaseLines(raw, mutations).text;
}

/**
 * `patchBaseDocument` plus the provenance of every line it produced. `source` is the line's index
 * in the original document when the locator left it alone (unchanged), `null` for every line it
 * wrote; `kind` says which: `"kept"`, `"replaced"` (an addressed line rewritten in place) or
 * `"inserted"` (a new line, carrying a `lead` separator when it was appended to a document with no
 * final newline). Exact by object identity, not a text diff. A caller that owns the original bytes
 * copies every `kept` line from them instead of re-encoding a lossy decode, and refuses the patch
 * when a written line cannot be mapped back byte-for-byte; see `assertProvenancePatchable` in
 * `base-patch-lines.js`.
 * @returns {{text: string, lines: Array<{text: string, eol: string, lead?: string, source: number|null, kind: "kept"|"replaced"|"inserted", replaces?: number}>}}
 */
export function patchBaseLines(raw, mutations) {
  if (typeof raw !== "string") throw invalid("Base patch requires the document text");
  const batch = validateMutations(mutations);
  const { base } = parseAndValidateBase(raw);
  const expected = JSON.parse(JSON.stringify(base));
  const state = { lines: splitLines(raw), base };
  const origin = new Map(state.lines.map((line, index) => [line, { index, text: line.text, eol: line.eol }]));
  state.origin = origin;
  for (const mutation of batch) {
    if (mutation.op === "set-view-option") setViewOption(state, expected, mutation);
    else if (mutation.op === "set-formulas") setFormula(state, expected, mutation);
    else setPropertyDisplayName(state, expected, mutation);
  }
  const next = joinLines(state.lines);
  const lines = state.lines.map((line) => {
    const from = origin.get(line);
    const kept = Boolean(from) && from.text === line.text && from.eol === line.eol;
    const kind = kept ? "kept" : from ? "replaced" : line.kind === "inserted" ? "inserted" : null;
    return { text: line.text, eol: line.eol, ...(line.lead ? { lead: line.lead } : {}), source: kept ? from.index : null, kind, ...(kind === "replaced" ? { replaces: from.index } : {}) };
  });
  if (next === raw) return { text: next, lines };
  // Locator safety net: the bytes we produced must parse to exactly the intended document, else fail closed instead of shipping a corrupted `.base`.
  let parsed;
  try {
    parsed = parseAndValidateBase(next).base;
  } catch (error) {
    if (error instanceof BaseQueryError && error.code === "invalid-schema") throw error;
    throw notPatchable(`the patched document did not parse (${error.message})`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw notPatchable("the located lines do not reproduce the intended document");
  }
  return { text: next, lines };
}
