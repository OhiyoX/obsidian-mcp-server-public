// Date-valued properties must show the *authored* calendar day (#481).
//
// Three inputs reach the property panel and the Bases cells:
//   - a `YYYY-MM-DD` string,
//   - a `Date` instance — js-yaml turns an unquoted date-only YAML scalar into UTC
//     midnight, which used to be rejected outright by `isoDateParts` (string-only),
//     so the date chip silently disappeared,
//   - an ISO datetime string, which used to be rejected too.
//
// Desktop renders dates through moment (`L`, or `L LT` with a time) and normalizes
// date-only values to `T00:00:00`, i.e. a date-only value is a calendar day that no
// timezone may shift. The two Web copies (`features/document/property-value.js` and
// `features/bases/cell.js`) are deliberately independent modules, so this file runs
// the same matrix against both and fails if they drift apart.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import * as document_ from "../frontend/app/features/document/property-value.js";
import * as bases from "../frontend/app/features/bases/cell.js";

const IMPLEMENTATIONS = [
  ["document", document_],
  ["bases", bases],
];

// The shape js-yaml produces for `date: 2026-10-05`.
const yamlDateOnly = () => new Date(Date.UTC(2026, 9, 5));
const yamlDateTime = () => new Date(Date.UTC(2026, 9, 5, 14, 30));

test("a Date instance from YAML keeps its calendar day and stops being ignored", () => {
  for (const [name, module] of IMPLEMENTATIONS) {
    const parsed = module.isoDateParts(yamlDateOnly());
    assert.ok(parsed, `${name}: a date-only Date must be recognised`);
    assert.equal(parsed.iso, "2026-10-05", `${name}: the UTC day is the authored day`);
    assert.equal(parsed.time, false, `${name}: midnight means "no time of day"`);
    assert.equal(parsed.datetime, "2026-10-05T00:00:00.000Z");
    assert.equal(module.isoDateParts(new Date(Number.NaN)), null, `${name}: an invalid Date is not a date`);

    const withTime = module.isoDateParts(yamlDateTime());
    assert.equal(withTime.iso, "2026-10-05", `${name}: the day still comes from UTC`);
    assert.equal(withTime.time, true, `${name}: a real time must be reported`);
  }
});

test("date-only strings keep the existing contract, impossible dates still rejected", () => {
  for (const [name, module] of IMPLEMENTATIONS) {
    assert.equal(module.isoDateParts("2026-10-05").iso, "2026-10-05", name);
    assert.equal(module.isoDateParts(" 2026-10-05 ").iso, "2026-10-05", `${name}: outer whitespace is trimmed`);
    assert.equal(module.isoDateParts("2026-02-31"), null, `${name}: impossible calendar dates are refused`);
    assert.equal(module.isoDateParts("2026-2-5"), null, `${name}: unpadded dates are not dates`);
    assert.equal(module.isoDateParts(""), null, name);
    assert.equal(module.isoDateParts("not a date"), null, name);
    assert.equal(module.isoDateParts(20261005), null, `${name}: numbers are not dates`);
    assert.equal(module.isoDateParts(null), null, name);
    assert.equal(module.isoDateParts(undefined), null, name);
  }
});

test("ISO datetime strings keep the day of their own date part", () => {
  for (const [name, module] of IMPLEMENTATIONS) {
    for (const value of ["2026-10-05T14:30", "2026-10-05T14:30:15.500", "2026-10-05T14:30:00+08:00", "2026-10-05T23:30:00Z"]) {
      const parsed = module.isoDateParts(value);
      assert.ok(parsed, `${name}: ${value} must be recognised`);
      assert.equal(parsed.iso, "2026-10-05", `${name}: ${value} keeps its own date part`);
      assert.equal(parsed.time, true, `${name}: ${value} carries a time`);
    }
    assert.equal(module.isoDateParts("2026-02-31T10:00:00"), null, `${name}: impossible datetime days are refused`);
    assert.equal(module.isoDateParts("2026-10-05 14:30"), null, `${name}: a space-separated datetime is not ISO`);
  }
});

test("the two implementations neither drift nor lose the desktop's L / L LT shape", () => {
  const inputs = [yamlDateOnly(), yamlDateTime(), "2026-10-05", "2026-10-05T14:30:00", "2026-10-05T14:30:00Z", "2026-02-31", null, 7];
  for (const value of inputs) {
    const left = document_.isoDateParts(value);
    const right = bases.isoDateParts(value);
    assert.deepEqual(left, right, `isoDateParts disagrees on ${String(value)}`);
    assert.equal(document_.formatDateValue(value), value instanceof Date || typeof value === "string" ? document_.formatDateValue(value) : null);
  }
  const dateOnly = document_.formatDateValue("2026-10-05");
  assert.match(dateOnly, /2026/, "the calendar date survives formatting");
  assert.equal(dateOnly.includes(":"), false, "a date-only value renders no time");
  const withTime = document_.formatDateValue(yamlDateTime());
  assert.match(withTime, /:/, "a datetime value appends the locale time (desktop's `L LT`)");
  assert.ok(withTime.startsWith(dateOnly.split(" ")[0].slice(0, 2)) || withTime.includes("2026"), "the datetime keeps a date part too");
});

test("a negative-offset timezone cannot shift the authored day", () => {
  // The regression class from the issue: the same document must show 10/05 in every
  // timezone. A child process is the only honest way to pin this — Node reads TZ at
  // startup, and the assertion is meaningless in whatever zone the test host happens
  // to run in.
  const documentModule = pathToFileURL(path.resolve(import.meta.dirname, "../frontend/app/features/document/property-value.js")).href;
  const basesModule = pathToFileURL(path.resolve(import.meta.dirname, "../frontend/app/features/bases/cell.js")).href;
  const script = `
    const doc = await import(${JSON.stringify(documentModule)});
    const cell = await import(${JSON.stringify(basesModule)});
    const out = [
      doc.isoDateParts("2026-10-05").iso,
      doc.isoDateParts(new Date(Date.UTC(2026, 9, 5))).iso,
      doc.isoDateParts("2026-10-05T00:00:00Z").iso,
      cell.isoDateParts("2026-10-05").iso,
      cell.isoDateParts(new Date(Date.UTC(2026, 9, 5))).iso,
      doc.formatDateValue("2026-10-05").includes("10") || doc.formatDateValue("2026-10-05").includes("2026"),
    ];
    console.log(JSON.stringify(out));
  `;
  for (const zone of ["America/New_York", "Asia/Shanghai", "Pacific/Kiritimati"]) {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
    });
    const rows = JSON.parse(raw.trim());
    assert.deepEqual(rows.slice(0, 5), ["2026-10-05", "2026-10-05", "2026-10-05", "2026-10-05", "2026-10-05"], `TZ=${zone} shifted a day`);
    assert.equal(rows[5], true, `TZ=${zone}: the formatted value still carries the calendar date`);
  }
});
