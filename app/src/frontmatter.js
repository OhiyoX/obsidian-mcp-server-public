// In-repo front matter parse/serialize — byte-for-byte replacement for
// `gray-matter@4.0.3`, which DEP-339 removes (its transitive
// js-yaml@3 -> argparse@1 -> sprintf-js chain carries GHSA-hp3w-g68c-fv3c).
//
// This is a faithful port of gray-matter's `lib/*` with js-yaml 4 (`load` /
// `dump`) standing in for js-yaml 3 (`safeLoad` / `safeDump`). Every observable
// shape is preserved on purpose:
//   * only a leading `---` block closed by a line starting with `---` is front
//     matter; an absent block yields `data = {}` and `content = raw`;
//   * the first line after `---` is treated as gray-matter's engine tag
//     (`yaml` / `yml` / `json` / `javascript`), exactly as before;
//   * a YAML parse failure throws, so `readNote({tolerateMalformedFrontmatter})`
//     and the Web index still degrade a malformed header to plain Markdown;
//   * serialization reproduces gray-matter's delimiter, `\n`, indentation,
//     quoting, key order and trailing-newline rules.
//
// Equivalence is proven by scratch/web-bases/DEP-339/evidence/check-equivalence.mjs
// (2729 inputs: repo literals/fixtures, 2452 real vault notes, 81 pathological).
import yaml from "js-yaml";

const OPEN = "---";
const CLOSE = "\n---";
const BOM = 0xfeff;

function stripBom(value) {
  return value.charCodeAt(0) === BOM ? value.slice(1) : value;
}

function toContentString(value) {
  if (Buffer.isBuffer(value)) return stripBom(value.toString("utf8"));
  if (typeof value !== "string") throw new TypeError("expected input to be a string or buffer");
  return stripBom(value);
}

// gray-matter's JavaScript engine (`---javascript` / `---js` headers). Carried
// over only to keep the two implementations observationally identical; no repo
// fixture or vault note uses it.
function parseJavascript(str, wrap = true) {
  let source = str;
  try {
    if (wrap !== false) source = `(function() {\nreturn ${source.trim()};\n}());`;
    // eslint-disable-next-line no-eval
    return eval(source) || {};
  } catch (error) {
    if (wrap !== false && /(unexpected|identifier)/i.test(error.message)) return parseJavascript(source, false);
    throw new SyntaxError(error);
  }
}

const ENGINES = {
  yaml: { parse: (text) => yaml.load(text), stringify: (data) => yaml.dump(data, { schema: DUMP_SCHEMA }) },
  json: { parse: (text) => JSON.parse(text), stringify: (data) => JSON.stringify(data, null, 2) },
  javascript: {
    parse: (text) => parseJavascript(text),
    stringify: () => { throw new Error("stringifying JavaScript is not supported"); },
  },
};

// js-yaml 3 (gray-matter's engine) quoted any plain scalar containing a flow
// indicator or `:` because its `isPlainSafe` had no block/flow distinction;
// js-yaml 4 permits them inside a block scalar. A resolver-only implicit type
// makes the dumper's `testAmbiguousType` reject those strings, restoring the
// older quoting without affecting parsing (load uses the stock schema) and
// without emitting a tag (detectType selects on `predicate`, not `resolve`).
const FLOW_QUOTE_TYPE = new yaml.Type("tag:frontmatter.local,2026:flow-quote", {
  kind: "scalar",
  resolve: (value) => typeof value === "string" && /[,\[\]{}:]/.test(value),
});
const DUMP_SCHEMA = yaml.DEFAULT_SCHEMA.extend({ implicit: [FLOW_QUOTE_TYPE] });

function aliasedEngineName(name) {
  switch (String(name).toLowerCase()) {
    case "js":
    case "javascript":
      return "javascript";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return name;
  }
}

function engineFor(name) {
  const key = Object.prototype.hasOwnProperty.call(ENGINES, name) ? name : aliasedEngineName(name);
  const engine = ENGINES[key];
  if (typeof engine === "undefined") throw new Error(`front matter engine "${name}" is not registered`);
  return engine;
}

// The tag on the first line after the opening delimiter. gray-matter reads it with
// `str.slice(0, str.search(/\r?\n/))`, i.e. `slice(0, -1)` when there is no newline.
function detectLanguage(str) {
  const index = str.search(/\r?\n/);
  const raw = index === -1 ? str.slice(0, -1) : str.slice(0, index);
  return { raw, name: raw ? raw.trim() : "" };
}

function newline(str) {
  return str.slice(-1) !== "\n" ? `${str}\n` : str;
}

// gray-matter's `matter()` + `parseMatter()` (minus caching, excerpt and sections,
// none of which affect `data`/`content`). Returns the internal file shape so
// `stringifyMatter` can reuse the source language and merged data.
function parseMatterRaw(input) {
  const content = toContentString(input);
  if (!content.startsWith(OPEN)) return { data: {}, content, language: "yaml" };
  if (content.charAt(OPEN.length) === OPEN.slice(-1)) return { data: {}, content, language: "yaml" };

  let str = content.slice(OPEN.length);
  const length = str.length;
  let language = "yaml";
  const detected = detectLanguage(str);
  if (detected.name) {
    language = detected.name;
    str = str.slice(detected.raw.length);
  }

  let closeIndex = str.indexOf(CLOSE);
  if (closeIndex === -1) closeIndex = length;

  const raw = str.slice(0, closeIndex);
  const block = raw.replace(/^\s*#[^\n]+/gm, "").trim();
  const data = block === "" ? {} : engineFor(language).parse(raw);

  let body;
  if (closeIndex === length) {
    body = "";
  } else {
    body = str.slice(closeIndex + CLOSE.length);
    if (body[0] === "\r") body = body.slice(1);
    if (body[0] === "\n") body = body.slice(1);
  }
  return { data, content: body, language };
}

export function parseFrontmatter(raw) {
  const parsed = parseMatterRaw(raw);
  return { data: parsed.data || {}, content: parsed.content || "" };
}

// gray-matter's `matter.stringify(content, data)`: the source's own front matter is
// folded in first, then `data`, then delimiters are emitted unless the dump is `{}`.
export function stringifyMatter(data, content) {
  const file = parseMatterRaw(content);
  const engine = engineFor(file.language || "yaml");
  const merged = Object.assign({}, file.data, data);
  const dumped = engine.stringify(merged).trim();
  const buf = dumped === "{}" ? "" : newline(OPEN) + newline(dumped) + newline(OPEN);
  return buf + newline(file.content);
}

// The repo-wide funnel: no front matter rewrite when there is nothing to write.
export function stringifyFrontmatter(data, content) {
  return data && Object.keys(data).length > 0 ? stringifyMatter(data, content) : content;
}
