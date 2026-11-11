// P0 / Task 1 — the permission baseline is only worth something if the comparator can fail.
//
// These tests pin the comparator's failure modes first (missing row, duplicate row, a flipped
// boolean, an "unknown" row treated as false) and the manifest's coverage. They do not run the
// collector; the collector is Step 3 and its output is the fixture the comparator compares.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { comparePermissionRows } from "./helpers/permission-baseline-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "permission-architecture");

/** One baseline row. Every field the comparator reads is present, so a diff is never a field gap. */
function row(overrides = {}) {
  return {
    actorCase: "oauth:full",
    surface: "mcp",
    capability: "get_note",
    targetCase: "vault:allowed",
    timeCase: "no-constraint",
    allowed: true,
    errorFamily: null,
    denialPoint: "none",
    handlerCalls: 1,
    contentIo: 0,
    ...overrides,
  };
}

test("an empty actual set is a difference, not a pass", () => {
  assert.notDeepEqual(comparePermissionRows([row()], []), []);
});

test("a missing row, a duplicate row, and a flipped verdict are each a difference", () => {
  const only = row();
  assert.equal(comparePermissionRows([only], [only]).length, 0, "identical input has no difference");

  const missing = comparePermissionRows([only], []);
  assert.equal(missing.length, 1);
  assert.match(missing[0].kind, /missing/);

  const extra = comparePermissionRows([], [only]);
  assert.equal(extra.length, 1, "a row nobody expected is also a difference");
  assert.match(extra[0].kind, /unexpected/);

  const flipped = comparePermissionRows([row({ allowed: false })], [row({ allowed: true })]);
  assert.equal(flipped.length, 1);
  assert.match(flipped[0].kind, /mismatch/);

  const duplicated = comparePermissionRows([only, only], [only]);
  assert.ok(duplicated.some((difference) => /duplicate/.test(difference.kind)), "a duplicate key cannot silently win");
});

test("an unknown verdict never compares equal to false", () => {
  const unknown = comparePermissionRows([row({ allowed: "unknown", handlerCalls: 0 })], [row({ allowed: false, handlerCalls: 0 })]);
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].kind, /unknown|mismatch/);
});

test("a row that differs only in where it was refused is a difference", () => {
  const moved = comparePermissionRows(
    [row({ allowed: false, errorFamily: "vault_access_denied", denialPoint: "transport", handlerCalls: 0 })],
    [row({ allowed: false, errorFamily: "vault_access_denied", denialPoint: "operation", handlerCalls: 0 })],
  );
  assert.equal(moved.length, 1, "a 403 that becomes a tool-level refusal changes what a client sees");
});

test("a refusal that moved a byte is a difference, never a quiet row", () => {
  const clean = row({ allowed: false, errorFamily: "vault_access_denied", handlerCalls: 0, contentIo: 0 });
  const leaked = row({ allowed: false, errorFamily: "vault_access_denied", handlerCalls: 0, contentIo: 1 });
  const differences = comparePermissionRows([clean], [leaked]);
  assert.equal(differences.length, 1);
  assert.match(differences[0].kind, /invariant/);
});

test("the manifest pins the baseline and covers every boundary it claims to cover", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, "manifest.json"), "utf8"));
  assert.equal(manifest.baseline.commit, "a65767d1785245dba07e42aeff9f32f6f686e981");
  assert.match(manifest.baseline.appTree, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(manifest.coverage) && manifest.coverage.length > 0);
  const kinds = new Set(manifest.coverage.map((entry) => entry.kind));
  for (const kind of ["tool", "resource", "web-route", "direct-upload", "admin-action"]) {
    assert.ok(kinds.has(kind), `the manifest must cover ${kind} boundaries`);
  }
});
