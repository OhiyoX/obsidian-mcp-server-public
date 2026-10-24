// #625 ④, read-only half: `OBSIDIAN_READ_ONLY` is read at module-import time, so
// the read-only readouts live in their own test file/process (same convention as
// web-folder-readonly.test.js / web-base-patch-readonly.test.js).
//
// Every registered Web write route is driven through the real router with a real
// writer session (obsidian.read + obsidian.write) and a real CSRF token. The
// readouts are pinned exactly, because this lane's hard requirement is that the
// per-route gate does not change any registered route's status codes.
//
// Observed and pinned as-is (NOT introduced here): `POST /folder` and
// `PATCH /base` implement the read-only 403 themselves, while note/asset/vault
// fall through the pre-existing generic 500 mapping. Those three are the
// inherited behaviour the brief keeps out of scope (#632/#624 own the errno and
// precondition semantics); pinning them means a future change cannot pass as
// "no behaviour change".
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Env before any app import (see web-route-needs.test.js for why).
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-route-needs-ro-"));
await fs.mkdir(path.join(ROOT, "vault"), { recursive: true });
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
delete process.env.WEB_VAULTS_ROOT;

const { WRITE_ROUTE_CALLS, callRoute, startWebWriteSurface } = await import("./helpers/web-write-surface-harness.js");

const READ_ONLY_READOUTS = {
  "POST /api/web/v1/note": { status: 500, body: { error: "Request failed" } },
  "POST /api/web/v1/folder": { status: 403, body: { error: "Server is read-only" } },
  "POST /api/web/v1/asset": { status: 500, body: { error: "Request failed" } },
  "POST /api/web/v1/vault": { status: 500, body: { error: "Request failed" } },
  "POST /api/web/v1/publish": { status: 400, body: { error: "Unsupported publish action" } },
  "PATCH /api/web/v1/base": { status: 403, body: { error: "Server is read-only" } },
};

test.after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

test("④ read-only: every registered write route keeps its scope/CSRF 403s and writes nothing", async () => {
  const surface = await startWebWriteSurface({ root: ROOT, readOnly: true, label: "web-route-needs-ro" });
  try {
    for (const route of WRITE_ROUTE_CALLS) {
      const noScope = await callRoute(surface.base, route, surface.reader);
      assert.equal(noScope.status, 403, `${route.key}: reader status`);
      assert.deepEqual(noScope.json, { error: "Account does not have write permission" }, `${route.key}: reader body`);

      const noCsrf = await callRoute(surface.base, route, surface.writer, { csrf: false });
      assert.equal(noCsrf.status, 403, `${route.key}: missing CSRF status`);
      assert.deepEqual(noCsrf.json, { error: "CSRF validation failed" }, `${route.key}: missing CSRF body`);

      const expected = READ_ONLY_READOUTS[route.key];
      const authorised = await callRoute(surface.base, route, surface.writer);
      assert.equal(authorised.status, expected.status, `${route.key}: read-only status`);
      assert.deepEqual(authorised.json, expected.body, `${route.key}: read-only body`);
    }
    // Fail closed on disk: nothing was created, not even the folder.
    assert.deepEqual(await fs.readdir(surface.vault), ["Note.md"]);
  } finally {
    await surface.close();
  }
});
