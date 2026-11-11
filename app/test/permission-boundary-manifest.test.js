// P0 / Task 1 — the coverage manifest must equal the boundaries `src` really registers.
//
// The gap this closes was real: the manifest listed `GET /api/web/v1/asset` and not
// `POST /api/web/v1/asset`, so the Web editor's image upload — a mutation boundary with its own
// scope, CSRF and Vault gate — was invisible to every later phase that reads the manifest.
//
// A hand-kept list cannot be trusted to notice its own hole, so the inventory is derived from the
// shipped code (`permission-boundary-inventory.js`) and compared with the manifest in BOTH
// directions: a route in `src` without a manifest row fails, and so does a manifest row with no
// route in `src`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { rowKey } from "./helpers/permission-baseline-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "permission-architecture");

// `src/config.js` reads its paths at import time, so the isolated environment comes first.
const env = await (await import("./helpers/permission-baseline-env.js")).seedPermissionBaselineEnv();
const { deriveBoundaryEntries, routeKeysOf, withMountTracking } = await import("./helpers/permission-boundary-inventory.js");
const express = (await import("express")).default;

test.after(async () => fs.rm(env.root, { recursive: true, force: true }));

const { entries, counts } = await deriveBoundaryEntries();
const manifest = JSON.parse(await fs.readFile(path.join(fixtures, "manifest.json"), "utf8"));

test("every boundary src registers has a manifest row", () => {
  const listed = new Set(manifest.coverage.map((entry) => entry.id));
  const missing = entries.filter((entry) => !listed.has(entry.id)).map((entry) => `${entry.kind} ${entry.id}`);
  assert.deepEqual(missing, [], `src registers boundaries the manifest does not list: ${missing.join(", ")}`);
});

test("every manifest row names a boundary src registers", () => {
  const derived = new Set(entries.map((entry) => entry.id));
  const orphaned = manifest.coverage.filter((entry) => !derived.has(entry.id)).map((entry) => `${entry.kind} ${entry.id}`);
  assert.deepEqual(orphaned, [], `manifest rows with no route in src: ${orphaned.join(", ")}`);
});

test("each manifest row has the kind the derivation gives it", () => {
  const kindById = new Map(entries.map((entry) => [entry.id, entry.kind]));
  for (const entry of manifest.coverage) {
    assert.equal(entry.kind, kindById.get(entry.id), `${entry.id} is filed as ${entry.kind}`);
  }
});

test("the derived inventory is bigger than the old 136-row manifest", () => {
  assert.ok(entries.length > 136, `derived ${entries.length} boundaries`);
  assert.equal(manifest.coverage.length, entries.length);
  console.log(JSON.stringify({ derived: entries.length, manifest: manifest.coverage.length, counts }));
});

test("the Web asset upload is a boundary with a recorded mutation row", async () => {
  const assetRow = manifest.coverage.find((entry) => entry.id === "POST /api/web/v1/asset");
  assert.deepEqual(assetRow, { kind: "web-route", id: "POST /api/web/v1/asset" });

  const baseline = JSON.parse(await fs.readFile(path.join(fixtures, "baseline.json"), "utf8"));
  const rows = baseline.rows.filter((row) => row.capability === "POST /api/web/v1/asset");
  assert.ok(rows.length > 0, "the baseline must record the Web asset upload");
  const allowed = rows.filter((row) => row.allowed === true);
  assert.ok(allowed.length > 0, "an allowed upload row must exist");
  for (const row of allowed) {
    assert.equal(row.handlerCalls, 1);
    assert.ok(row.contentIo > 0, `${row.actorCase} uploaded an asset, so a Vault file changed`);
    assert.equal(row.errorFamily, null);
  }
  for (const row of rows.filter((entry) => entry.allowed === false)) {
    assert.equal(row.contentIo, 0, "a refused upload must leave the Vault byte-identical");
    // A refusal decided inside the route handler (the scope check on this route lives there, not in
    // a gate in front of it) counts one handler entry. A refusal named as pre-handler may not.
    if (row.denialPoint === "operation") assert.equal(row.handlerCalls, 1, `${rowKey(row)} was refused by the handler`);
    else assert.equal(row.handlerCalls, 0, `${rowKey(row)} was refused at ${row.denialPoint} but a handler ran`);
  }
});

test("every recorded row names a boundary the manifest lists", async () => {
  // `no_such_tool` is a deliberate negative probe, not a boundary: it proves an unknown tool is
  // refused. Everything else the collector records must be an id the derivation also produces.
  const NEGATIVE_PROBES = new Set(["no_such_tool"]);
  const listed = new Set(entries.map((entry) => entry.id));
  const baseline = JSON.parse(await fs.readFile(path.join(fixtures, "baseline.json"), "utf8"));
  const unlisted = [...new Set(baseline.rows.map((row) => row.capability))].filter((capability) => !listed.has(capability) && !NEGATIVE_PROBES.has(capability));
  assert.deepEqual(unlisted, [], `baseline rows name boundaries the manifest does not list: ${unlisted.join(", ")}`);
});

test("a route on a mounted sub-router is derived, not missed", () => {
  // Review control: a route added on a nested router kept all six manifest tests green, because the
  // derivation only read the top-level router. It must now appear with its mount prefix.
  const built = withMountTracking((mounts) => {
    const inner = express.Router();
    inner.get("/inner-route", (_req, res) => res.end("ok"));
    const middle = express.Router();
    middle.post("/middle-route", (_req, res) => res.end("ok"));
    middle.use("/deep", inner);
    const outer = express.Router();
    outer.get("/outer-route", (_req, res) => res.end("ok"));
    outer.use("/nested", middle);
    return { outer, mounts };
  });
  const keys = routeKeysOf(built.outer, { mounts: built.mounts });
  assert.ok(keys.includes("GET /nested/deep/inner-route"), `nested route missing: ${keys.join(", ")}`);
  assert.ok(keys.includes("POST /nested/middle-route"), `middle route missing: ${keys.join(", ")}`);
  assert.ok(keys.includes("GET /outer-route"));
});

test("a real router mounted under a prefix keeps its routes visible", async () => {
  const { createWebAppRouter } = await import("../src/app/routes.js");
  const { createWebSessionStore } = await import("../src/app/web-session-store.js");
  const built = withMountTracking((mounts) => {
    const provider = { ready: Promise.resolve(), authenticateOAuthUser: async () => null, oauthUserSessionRecord: async () => null, recordAudit: () => {} };
    const web = createWebAppRouter({ provider, secureCookie: false, webSessionStore: createWebSessionStore({ file: null }) });
    const outer = express.Router();
    outer.use("/mounted", web);
    return { outer, mounts };
  });
  const keys = routeKeysOf(built.outer, { mounts: built.mounts });
  assert.ok(keys.includes("POST /mounted/api/web/v1/asset"), `mounted web route missing: ${keys.slice(0, 5).join(", ")}`);
  assert.ok(keys.includes("GET /mounted/api/web/v1/notes"));
});
