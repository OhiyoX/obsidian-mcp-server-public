// P0 / Task 1 Step 4 — the committed baseline must be reproducible, not a one-off dump.
//
// This test collects the rows again from the real stack and demands zero differences against
// `test/fixtures/permission-architecture/baseline.json`. It also states the invariant the fixture
// itself has to satisfy, so a row cannot be "fixed" by hand to hide a refusal that ran content I/O.
//
// To regenerate the fixture after a *deliberate* recording change, let the collector write it —
// never edit baseline.json by hand:
//
// Known limits, stated once (do not build machinery for them in P0):
//   * the `operation` family merges several causes (a handler-side permission check, a disabled Git
//     runtime, an ENOENT); the code and the message are recorded nowhere, only the family;
//   * the plane differs from `server.js` in the JSON body limit, batched initialize, `GET /mcp`,
//     `/healthz` and the CORS preflight, so those boundaries have no row;
//   * the HTTP `denialPoint` is derived from the measured handler count, not from a static map of
//     which middleware owns which check;
//   * the legacy fixtures are compared after redaction (`passwordHash`, a provider-minted id), so a
//     change inside those two values would not show.
//
//   PERMISSION_BASELINE_WRITE=1 DATA_PATH="$PWD/.tmp-permission/t01" node --test test/permission-baseline-fixture.test.js
//   DATA_PATH="$PWD/.tmp-permission/t01" node --test test/permission-baseline-fixture.test.js   # must be green

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "permission-architecture");

const env = await (await import("./helpers/permission-baseline-env.js")).seedPermissionBaselineEnv();
const { collectBaselineRows, RESOURCE_URIS } = await import("./helpers/permission-baseline-collect.js");
const { comparePermissionRows, rowKey } = await import("./helpers/permission-baseline-harness.js");
const { TOOL_NAMES } = await import("../src/config.js");

test.after(async () => fs.rm(env.root, { recursive: true, force: true }));

const fixturePath = path.join(fixtures, "baseline.json");
const baseline = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const fresh = await collectBaselineRows({ sourceRoot: env.vaults, dataPath: env.dataPath, nowMs: Date.parse("2026-11-05T00:00:00.000Z") });
const REWRITE = process.env.PERMISSION_BASELINE_WRITE === "1";
if (REWRITE) {
  await fs.writeFile(fixturePath, `${JSON.stringify({ schema: "obsidian-permission-baseline/v1", rows: fresh }, null, 2)}\n`, "utf8");
  console.log(`rewrote ${fixturePath} with ${fresh.length} rows`);
}

test("collecting the baseline again reproduces the committed fixture exactly", { skip: REWRITE ? "the fixture was just rewritten; commit it and run again" : false }, () => {
  assert.deepEqual(comparePermissionRows(baseline.rows, fresh), []);
});

test("the fixture carries no duplicate row keys", () => {
  const keys = fresh.map(rowKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("every refusal is a refusal: a gate refusal ran no handler, and no refusal moved a byte", () => {
  const gatePoints = new Set(["transport", "csrf", "authorization", "validation", "rate_limit", "routing", "operation_gate"]);
  const denied = fresh.filter((row) => row.allowed === false);
  assert.ok(denied.length > 0, "the baseline must contain refusals, or it proves nothing");
  let insideOperation = 0;
  for (const row of denied) {
    assert.equal(row.contentIo, 0, `${rowKey(row)} refused but changed ${row.contentIo} Vault file(s)`);
    assert.notEqual(row.denialPoint, "none", `${rowKey(row)} is denied but names no refusal point`);
    if (row.denialPoint === "operation") {
      // The handler itself refused (a password check, a scope check inside the route). That is a
      // recorded fact, not a leak; the byte invariant above still holds for it.
      insideOperation += 1;
      continue;
    }
    assert.ok(gatePoints.has(row.denialPoint), `${rowKey(row)} names an unknown refusal point ${row.denialPoint}`);
    assert.equal(row.handlerCalls, 0, `${rowKey(row)} was refused at ${row.denialPoint} but a handler ran`);
  }
  console.log(`refusals: ${denied.length}, decided inside the operation: ${insideOperation}`);
});

test("every allow really ran: a positive handler count, and a named target", () => {
  const allowed = fresh.filter((row) => row.allowed === true);
  assert.ok(allowed.length > 0);
  for (const row of allowed) {
    assert.equal(row.handlerCalls, 1, `${rowKey(row)} is allowed but no handler answered`);
    assert.equal(row.denialPoint, "none");
    assert.equal(row.errorFamily, null);
    assert.ok(row.targetCase && row.timeCase, `${rowKey(row)} must name a target and a time case`);
  }
});

test("a row that names a Vault reads that Vault", () => {
  // The marker rows carry `targetVaultObserved`: the content they got back exists in one Vault only.
  const observed = fresh.filter((row) => row.targetVaultObserved);
  assert.ok(observed.length >= 10, `expected marker rows, found ${observed.length}`);
  for (const row of observed) {
    // A refused row got no content, so there is nothing to attribute; its byte invariant is checked
    // by the refusal test instead.
    if (!row.allowed) continue;
    const expected = row.targetCase.startsWith("vault:secondary") ? "secondary"
      : row.targetCase.startsWith("vault:primary") ? "primary" : null;
    if (expected) assert.equal(row.targetVaultObserved, expected, `${rowKey(row)} read ${row.targetVaultObserved}`);
  }
  // Default routing, before and after the Admin row that sets a client-level default Vault.
  const before = fresh.find((row) => row.targetCase === "vault:default");
  const after = fresh.find((row) => row.targetCase === "vault:default#after-client-default");
  assert.equal(before.targetVaultObserved, "primary", "with no Admin write yet the default is the primary Vault");
  assert.equal(after.targetVaultObserved, "secondary", "the recorded effect of the client-level default Vault");
  // The temporal rows: every window that CONTAINS the pinned instant must read the primary Vault,
  // which is the Blocker this matrix could not see before.
  const inside = fresh.filter((row) => row.timeCase.startsWith("window:") || row.timeCase.startsWith("weekly:") || row.timeCase.startsWith("dateRange:"));
  const allowed = inside.filter((row) => row.allowed);
  assert.ok(allowed.length >= 6, `expected at least 6 inside-window rows, found ${allowed.length}`);
  for (const row of allowed) assert.equal(row.targetVaultObserved, "primary", `${row.timeCase} read ${row.targetVaultObserved}`);
  for (const row of inside.filter((entry) => !entry.allowed)) assert.equal(row.contentIo, 0);
});

test("the inventory, every tool and every resource have a row", () => {
  const capabilities = new Set(fresh.map((row) => row.capability));
  for (const name of TOOL_NAMES) assert.ok(capabilities.has(name), `no baseline row for tool ${name}`);
  for (const uri of RESOURCE_URIS) assert.ok(capabilities.has(uri), `no baseline row for resource ${uri}`);
});

test("every manifest boundary has a row, except the documented blocked list", async () => {
  // A printed gap is not a gate: an unrecorded boundary fails here.
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, "manifest.json"), "utf8"));
  const BLOCKED = new Map([
    ["GET /api/web/v1/events", "an SSE stream: the request never ends, so a row could not finish"],
    ["ADMIN GET /assets/:file", "public Admin code asset: no session and no permission answer"],
    ["* /uploads/:uploadId", "catch-all answer for every other method on the path PUT/PATCH already cover"],
  ]);
  const capabilities = new Set(fresh.map((row) => row.capability));
  const missing = manifest.coverage.filter((entry) => !capabilities.has(entry.id));
  const unexplained = missing.filter((entry) => !BLOCKED.has(entry.id)).map((entry) => `${entry.kind} ${entry.id}`);
  assert.deepEqual(unexplained, [], `manifest boundaries without a row: ${unexplained.join(", ")}`);

  // The blocked list must stay honest: every entry exists in the manifest, has no row, and says why.
  const manifestIds = new Set(manifest.coverage.map((entry) => entry.id));
  for (const [id, reason] of BLOCKED) {
    assert.ok(manifestIds.has(id), `the blocked list names a boundary the manifest does not hold: ${id}`);
    assert.ok(!capabilities.has(id), `a blocked boundary now has a row — remove it from the list: ${id}`);
    assert.ok(typeof reason === "string" && reason.length > 20, `blocked boundary ${id} needs a real reason`);
  }
  const recorded = manifest.coverage.length - missing.length;
  console.log(`baseline boundaries recorded: ${recorded}/${manifest.coverage.length}, blocked: ${BLOCKED.size}`);
});
