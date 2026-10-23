// Wave A / A2: versioned typed frontmatter codec tests.
//
// Contract: TODO - Web 显示 Bases 视图 §6.2 / §15.3 — null/string/boolean/finite
// number/date/datetime/array/plain-object round-trip losslessly; unsupported values
// fail closed; prototype-pollution keys stay own properties.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTMATTER_CODEC_VERSION,
  WebCatalogValueCodecError,
  decodeFrontmatter,
  encodeFrontmatter,
} from "../src/app/web-catalog/value-codec.js";

function roundTrip(value) {
  return decodeFrontmatter(encodeFrontmatter(value));
}

test("codec round-trips every supported scalar and container value", () => {
  const cases = [
    "hello",
    "",
    true,
    false,
    0,
    -12,
    3.25,
    null,
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T12:34:56.789Z"),
    ["a", 1, true, null],
    [[1, 2], ["x"]],
    { type: "note", done: false, nested: { n: 2, list: [1, { deep: "v" }] } },
    {},
    [],
  ];
  for (const value of cases) {
    assert.deepEqual(roundTrip(value), value);
  }
});

test("codec preserves Unicode and special-string keys/values", () => {
  const value = {
    "键": "值",
    "a\"b\\c\n": "x",
    "": "empty-key",
    "emoji-😀": "🎉 go",
  };
  assert.deepEqual(roundTrip(value), value);
});

test("codec keeps prototype-pollution keys as own properties", () => {
  const hostile = {};
  Object.defineProperty(hostile, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true });
  Object.defineProperty(hostile, "constructor", { value: { prototype: { bad: 1 } }, enumerable: true, configurable: true });
  hostile.safe = "yes";

  const decoded = roundTrip(hostile);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype, "decoded object keeps Object.prototype");
  assert.equal({}.polluted, undefined, "global Object.prototype must not be polluted");
  assert.equal({}.bad, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded, "__proto__"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded, "constructor"), true);
  assert.deepEqual(decoded.safe, "yes");
});

test("codec fails closed on unsupported values instead of dropping them", () => {
  const unsupported = [
    undefined,
    1n,
    Symbol("s"),
    () => {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Map([["a", 1]]),
    new Set([1]),
    /re/,
    new (class Widget {})(),
  ];
  for (const value of unsupported) {
    assert.throws(() => encodeFrontmatter(value), WebCatalogValueCodecError, `unsupported: ${String(value)}`);
  }
  // A nested unsupported value also fails the whole tree.
  assert.throws(() => encodeFrontmatter({ a: [1, { b: 2n }] }), WebCatalogValueCodecError);
});

test("codec fails closed on malformed or foreign stored payloads", () => {
  assert.throws(() => decodeFrontmatter("not json"), WebCatalogValueCodecError);
  assert.throws(() => decodeFrontmatter(JSON.stringify({ codec: 1 })), WebCatalogValueCodecError);
  assert.throws(() => decodeFrontmatter(JSON.stringify({ codec: 999, root: { t: "null" } })), WebCatalogValueCodecError);
  assert.throws(() => decodeFrontmatter(JSON.stringify({ codec: 1, root: { t: "number", v: "x" } })), WebCatalogValueCodecError);
  assert.equal(FRONTMATTER_CODEC_VERSION, 1);
});
