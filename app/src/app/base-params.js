// Frozen Web Base API parameter contract (D-PARITY-PLAN).
//
// Owns the transport-level parsing/normalization of `GET /api/web/v1/base`:
// path/view/limit/cursor plus the three desktop-parity overrides `sort`/`filter`/`q`
// and their canonical cursor-identity encodings. It is deliberately separate from
// base-route.js (HTTP status mapping + page resolution) and base-query.js
// (view-dependent canonical evaluation) so that:
//
//   - structural / JSON / value-domain failures are 400 with a stable code
//     (`invalid-sort`, `invalid-filter`, `invalid-query`);
//   - an unsupported but well-formed operator is 422 `unsupported`;
//   - a key that is not in the selected view's column set is 422 `unsupported`
//     (that check needs the compiled view, so it lives in base-query.js).
//
// Every parser fails closed on a non-string (e.g. a repeated `?sort=a&sort=b`
// yields an array) and never coerces a malformed value.
import { BASE_FILTER_OPERATORS } from "../base-query.js";

export const BASE_LIMIT_DEFAULT = 100;
export const BASE_LIMIT_MIN = 1;
export const BASE_LIMIT_MAX = 500;

// `q` is a bounded text predicate: the frozen contract caps it at 256 chars.
export const BASE_QUERY_TEXT_MAX = 256;

// Public offset/pageNumber are explicitly not part of the contract (§4.3).
const PROHIBITED_PARAMS = ["offset", "pageNumber", "page", "skip", "start"];

export class BaseHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BaseHttpError";
    this.status = status;
    this.code = code;
  }
}

// Public limit contract: default 100, decimal integers 1..500; anything else is a
// 400 (never silently clamped).
export function parseBaseLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return BASE_LIMIT_DEFAULT;
  const value = Array.isArray(raw) ? "__array__" : String(raw);
  if (!/^\d+$/.test(value)) throw new BaseHttpError(400, "invalid-limit", "limit must be a decimal integer");
  const limit = Number(value);
  if (limit < BASE_LIMIT_MIN || limit > BASE_LIMIT_MAX) {
    throw new BaseHttpError(400, "invalid-limit", "limit out of range");
  }
  return limit;
}

function optionalString(raw, code) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new BaseHttpError(400, code, "parameter must be a single string");
  return raw;
}

function parseJsonArray(raw, code) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new BaseHttpError(400, code, "parameter must be a single JSON string");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BaseHttpError(400, code, "parameter is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new BaseHttpError(400, code, "parameter must be a JSON array");
  return parsed;
}

// `sort` = [{"key": "<column key>", "dir": "asc"|"desc"}]. The structure already
// supports multi-column sort; an absent/empty array means "no override", and a
// missing `dir` defaults to `asc`. `key` membership is validated later against
// the view's `order` (422 `unsupported`).
export function parseBaseSort(raw) {
  const parsed = parseJsonArray(raw, "invalid-sort");
  if (parsed === null) return null;
  const sort = parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BaseHttpError(400, "invalid-sort", "sort item must be an object");
    }
    if (typeof item.key !== "string" || item.key === "") {
      throw new BaseHttpError(400, "invalid-sort", "sort item needs a string key");
    }
    const dir = item.dir === undefined || item.dir === null ? "asc" : item.dir;
    if (dir !== "asc" && dir !== "desc") {
      throw new BaseHttpError(400, "invalid-sort", "sort dir must be asc or desc");
    }
    return { key: item.key, dir };
  });
  return sort.length ? sort : null;
}

// `filter` = `[{key,op,value}]` (AND list, the original frozen shape) OR the
// desktop filter-group tree `{and|or|not:[...]}` nested to any depth (G3). Both
// are structurally validated here and evaluated by `evaluateBaseFilterTree`.
// An unsupported op is a well-formed but unimplemented predicate (422
// `unsupported`); a malformed item or group is 400 `invalid-filter`.
//
// Desktop reference (app.js@2361900): a group object must have EXACTLY ONE of
// `and`/`or`/`not` (else `msgErrorFilterAllowedKeys`), each of which must be an
// array (else `msgErrorFilterMustBeArray`). Both are 400 here.
const FILTER_CONJUNCTIONS = ["and", "or", "not"];

function parseFilterNode(node, path) {
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) return node.map((item, index) => parseFilterNode(item, `${path}[${index}]`));
  if (!node || typeof node !== "object") {
    throw new BaseHttpError(400, "invalid-filter", "filter item must be an object");
  }
  const keys = Object.keys(node);
  const conjunction = keys.find((key) => FILTER_CONJUNCTIONS.includes(key));
  if (conjunction) {
    if (keys.length !== 1) {
      throw new BaseHttpError(400, "invalid-filter", '"filters" may only have one of an "and", "or", or "not" keys.');
    }
    if (!Array.isArray(node[conjunction])) {
      throw new BaseHttpError(400, "invalid-filter", `${conjunction} must be an array`);
    }
    return { [conjunction]: node[conjunction].map((item, index) => parseFilterNode(item, `${path}.${conjunction}[${index}]`)) };
  }
  if (typeof node.key !== "string" || node.key === "") {
    throw new BaseHttpError(400, "invalid-filter", "filter item needs a string key");
  }
  if (typeof node.op !== "string" || node.op === "") {
    throw new BaseHttpError(400, "invalid-filter", "filter item needs a string op");
  }
  for (const key of keys) {
    if (!["key", "op", "value"].includes(key)) {
      throw new BaseHttpError(400, "invalid-filter", `filter item has an unknown key: ${key}`);
    }
  }
  if (!BASE_FILTER_OPERATORS.includes(node.op)) {
    throw new BaseHttpError(422, "unsupported", `unsupported filter op: ${node.op}`);
  }
  return { key: node.key, op: node.op, value: node.value };
}

export function parseBaseFilter(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new BaseHttpError(400, "invalid-filter", "parameter must be a single JSON string");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BaseHttpError(400, "invalid-filter", "parameter is not valid JSON");
  }
  if (Array.isArray(parsed)) {
    const filter = parsed.map((item, index) => parseFilterNode(item, `[${index}]`));
    return filter.length ? filter : null;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BaseHttpError(400, "invalid-filter", "parameter must be a JSON array or filter group");
  }
  const group = parseFilterNode(parsed, "filter");
  const conjunction = FILTER_CONJUNCTIONS.find((key) => group[key]);
  // A bare condition object is not a valid TOP-LEVEL shape: the frozen contract
  // is an array (AND list) or a filter group; only nested leaves may be
  // conditions.
  if (!conjunction) throw new BaseHttpError(400, "invalid-filter", "parameter must be a JSON array or filter group");
  // F3: do NOT collapse an empty group to `null`. `null` means "no override"
  // (all rows) while the evaluator treats `{"or":[]}` as the empty union (no
  // rows) and `{"and":[]}` / `{"not":[]}` as the empty intersection (all
  // rows). Passing the group through keeps the HTTP layer and
  // `evaluateBaseFilterTree` on the same rule; the evaluator stays the single
  // source of truth. The legacy top-level `[]` above is still "no override".
  return group;
}

// `q`: case-insensitive substring match over every column of the selected view.
// The literal is preserved verbatim (identity + echo), never trimmed or cased.
export function parseBaseTextQuery(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new BaseHttpError(400, "invalid-query", "q must be a single string");
  if (raw.length > BASE_QUERY_TEXT_MAX) throw new BaseHttpError(400, "invalid-query", "q is too long");
  return raw;
}

// Deterministic JSON with recursively sorted object keys. `undefined` becomes
// `null` so `{k: undefined}` and `{k: null}` cannot produce two identities for
// the same filter.
function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key]) ?? null]),
    );
  }
  return value ?? null;
}

// Canonical, stable cursor-identity encodings. A no-op override returns
// `undefined` so the cursor field is omitted entirely.
export function encodeSortIdentity(sort) {
  if (!Array.isArray(sort) || !sort.length) return undefined;
  return JSON.stringify(sort.map(({ key, dir }) => ({ key, dir })));
}

export function encodeFilterIdentity(filter) {
  if (filter === null || filter === undefined) return undefined;
  if (Array.isArray(filter)) {
    if (!filter.length) return undefined;
    return JSON.stringify(filter.map(({ key, op, value }) => ({ key, op, value: canonicalJsonValue(value) })));
  }
  // G3 filter group: one canonical JSON identity for the whole tree.
  return JSON.stringify(canonicalJsonValue(filter));
}

export function encodeQueryIdentity(textQuery) {
  return typeof textQuery === "string" && textQuery.length ? textQuery : undefined;
}

export function parseBaseQuery(query = {}) {
  for (const name of PROHIBITED_PARAMS) {
    if (query[name] !== undefined) {
      throw new BaseHttpError(400, "unsupported-parameter", `${name} is not a public parameter`);
    }
  }
  if (query.path === undefined || query.path === null || query.path === "") {
    throw new BaseHttpError(400, "invalid-path", "path is required");
  }
  if (typeof query.path !== "string") throw new BaseHttpError(400, "invalid-path", "path must be a single string");

  const sort = parseBaseSort(query.sort);
  const filter = parseBaseFilter(query.filter);
  const textQuery = parseBaseTextQuery(query.q);

  return {
    path: query.path,
    view: optionalString(query.view, "invalid-view"),
    limit: parseBaseLimit(query.limit),
    cursor: optionalString(query.cursor, "invalid-cursor"),
    sort,
    filter,
    textQuery,
    sortIdentity: encodeSortIdentity(sort),
    filterIdentity: encodeFilterIdentity(filter),
    queryIdentity: encodeQueryIdentity(textQuery),
  };
}
