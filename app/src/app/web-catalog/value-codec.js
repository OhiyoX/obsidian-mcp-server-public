// Versioned typed frontmatter codec for the Web Catalog Base projection.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 显示 Bases 视图.md §6.2
// A Base query must see the same value tree the MCP vault-index record exposes, so
// a lossy JSON.stringify is forbidden: Date/array/object/null must round-trip, and
// any unsupported JS/YAML value (bigint/function/symbol/Map/undefined/...) fails
// closed instead of silently dropping the field.
//
// The encoding is a tagged tree serialized as JSON. Object entries are emitted as
// [key, value] pairs (never a raw JSON object) so a hostile `__proto__` / `constructor`
// key is preserved as an own property and can never pollute a prototype on decode.

export const FRONTMATTER_CODEC_VERSION = 1;

// Hostile/huge structures fail closed rather than exhausting the stack.
const MAX_DEPTH = 64;

export class WebCatalogValueCodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebCatalogValueCodecError";
    this.code = "WEB_CATALOG_VALUE_UNSUPPORTED";
  }
}

function fail(message) {
  throw new WebCatalogValueCodecError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeNode(value, depth) {
  if (depth > MAX_DEPTH) fail("frontmatter value exceeds the maximum nesting depth");
  if (value === null) return { t: "null" };
  const type = typeof value;
  if (type === "string") return { t: "string", v: value };
  if (type === "boolean") return { t: "boolean", v: value };
  if (type === "number") {
    if (!Number.isFinite(value)) fail("frontmatter number must be finite");
    return { t: "number", v: value };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) fail("frontmatter date is invalid");
    const iso = value.toISOString();
    // A date-only YAML scalar parses to UTC midnight; keep the distinction so the
    // display layer can render a date without a fabricated time component.
    if (ms % 86_400_000 === 0) return { t: "date", v: iso.slice(0, 10) };
    return { t: "datetime", v: iso };
  }
  if (Array.isArray(value)) {
    return { t: "array", v: value.map((item) => encodeNode(item, depth + 1)) };
  }
  if (isPlainObject(value)) {
    const pairs = [];
    for (const key of Object.keys(value)) {
      pairs.push([key, encodeNode(value[key], depth + 1)]);
    }
    return { t: "object", v: pairs };
  }
  if (type === "undefined") fail("frontmatter value must not be undefined");
  fail(`frontmatter value type is unsupported: ${type}`);
}

function decodeNode(node, depth) {
  if (depth > MAX_DEPTH) fail("encoded frontmatter exceeds the maximum nesting depth");
  if (!node || typeof node !== "object") fail("encoded frontmatter node is malformed");
  switch (node.t) {
    case "null":
      return null;
    case "string":
      if (typeof node.v !== "string") fail("encoded string is malformed");
      return node.v;
    case "boolean":
      if (typeof node.v !== "boolean") fail("encoded boolean is malformed");
      return node.v;
    case "number":
      if (typeof node.v !== "number" || !Number.isFinite(node.v)) fail("encoded number is malformed");
      return node.v;
    case "date":
    case "datetime": {
      if (typeof node.v !== "string") fail("encoded date is malformed");
      const parsed = new Date(node.t === "date" ? `${node.v}T00:00:00.000Z` : node.v);
      if (Number.isNaN(parsed.getTime())) fail("encoded date is invalid");
      return parsed;
    }
    case "array":
      if (!Array.isArray(node.v)) fail("encoded array is malformed");
      return node.v.map((item) => decodeNode(item, depth + 1));
    case "object": {
      if (!Array.isArray(node.v)) fail("encoded object is malformed");
      const result = {};
      for (const pair of node.v) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
          fail("encoded object entry is malformed");
        }
        // defineProperty keeps `__proto__`/`constructor` as own data properties.
        Object.defineProperty(result, pair[0], {
          value: decodeNode(pair[1], depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    default:
      fail(`encoded frontmatter tag is unknown: ${String(node.t)}`);
  }
}

// Encode a decoded frontmatter value tree to a stable JSON string.
export function encodeFrontmatter(value) {
  return JSON.stringify({ codec: FRONTMATTER_CODEC_VERSION, root: encodeNode(value, 0) });
}

// Decode a stored frontmatter value tree; malformed/foreign payloads fail closed.
export function decodeFrontmatter(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    fail("stored frontmatter payload is not JSON");
  }
  if (!parsed || typeof parsed !== "object") fail("stored frontmatter payload is malformed");
  if (parsed.codec !== FRONTMATTER_CODEC_VERSION) {
    fail(`stored frontmatter codec version mismatch: ${String(parsed.codec)}`);
  }
  return decodeNode(parsed.root, 0);
}
