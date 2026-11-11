// P2 / Task 15 — the direct upload continuation and its bound Vault.
//
// Contract: design §6.1.5 and §10 P2. A `PUT`/`PATCH /uploads/:uploadId` continuation
// is authorized against the Vault the HANDLE is bound to — never against the ambient
// default and never by probing a Vault the credential may not use. The row is recorded
// once the handle is located and before a body byte is read; the old gates still decide
// the answer.
//
// The cases:
//   * a handle created in `vault` keeps writing to `vault` after the account default
//     moved to another Vault, and the row names `vault`;
//   * a handle in a Vault this credential may not use is not found at all (404): no
//     cross-Vault probe, no row, no bytes;
//   * the continuation still lands when the new model would deny it (old gate decides),
//     and that difference is recorded once.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-upload-"));
const vault = path.join(root, "vault");
const secondary = path.join(root, "secondary");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
await fs.mkdir(secondary, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.DIRECT_UPLOAD_ENABLED = "true";
process.env.DIRECT_UPLOAD_RATE_PER_MINUTE = "100";
process.env.VERSION_HISTORY_ENABLED = "true";

const [
  { startDirectUpload, createDirectUploadRouter, DIRECT_UPLOAD_PATH_PREFIX },
  { primaryRuntime },
  { createVaultRuntime },
  { vaultDataPaths },
  { vaultDataKey },
  { withRequestContext },
  { createAuthorizationRuntime },
  { createShadowCandidate, createShadowRecorder },
  { AUTHORIZATION_CATALOG_VERSION },
] = await Promise.all([
  import("../src/direct-upload.js"),
  import("../src/vault.js"),
  import("../src/vault-runtime/runtime.js"),
  import("../src/vault-runtime/paths.js"),
  import("../src/vault-runtime/descriptor.js"),
  import("../src/request-context.js"),
  import("../src/authorization/runtime.js"),
  import("../src/authorization/shadow.js"),
  import("../src/authorization/catalog.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const PAYLOAD = Buffer.alloc(2_048, 7);
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");
const PRIMARY_ID = primaryRuntime.id;

const SECONDARY_RUNTIME = createVaultRuntime({
  descriptor: { id: "secondary", name: "secondary", root: secondary, primary: false, writable: true },
  paths: vaultDataPaths({ primary: false, dataRoot: data, dataKey: vaultDataKey("secondary") }),
  deps: { requireRequestAuthor: () => ({ agent: "p2", model: "test" }) },
});

const CREDENTIALS = {
  primary: { type: "api-key", keyId: "key-primary", clientId: "api-key:key-primary", scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], allowedVaults: [PRIMARY_ID], defaultVaultId: "secondary" },
  secondaryOnly: { type: "api-key", keyId: "key-secondary", clientId: "api-key:key-secondary", scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], allowedVaults: ["secondary"] },
};

function document({ grantPrimary }) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 2,
    timeConstraintsEnabled: false,
    subjects: {
      "api-key:key-primary": {
        credentialEpoch: 0,
        grants: grantPrimary ? [{ target: { kind: "vault", vaultId: PRIMARY_ID }, capabilities: ["start_direct_upload", "get_note"] }] : [],
      },
    },
    constraints: [],
  };
}

/** One in-process data plane: the real router, a fake credential header, a real shadow. */
async function startPlane({ grantPrimary = true, shadow = true } = {}) {
  const recorder = createShadowRecorder({ capacity: 64 });
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: document({ grantPrimary }) }) }),
    identitySnapshot: () => ({ subjects: { "api-key:key-primary": { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ [PRIMARY_ID]: { admitted: true, readOnly: false }, secondary: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => Date.now(),
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;

  const app = express();
  app.use((req, _res, next) => {
    const name = String(req.headers["x-test-credential"] || "primary");
    req.auth = { ...CREDENTIALS[name] };
    next();
  });
  app.use(createDirectUploadRouter({
    auth: (req, _res, next) => next(),
    resolveRuntime: (id) => (id === "secondary" ? SECONDARY_RUNTIME : id === PRIMARY_ID ? primaryRuntime : null),
    provider: null,
    enabled: true,
    writable: true,
    limiter: null,
    authorizationShadow: shadow ? runtime.shadow : null,
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, recorder,
    rows: () => recorder.rows(),
    summary: () => recorder.summary(),
    async put(relativePath, { credential = "primary", method = "PUT", headers = {} } = {}) {
      const response = await fetch(`${base}${relativePath}`, {
        method,
        headers: { "Content-Type": "application/octet-stream", "x-test-credential": credential, ...headers },
        body: method === "PUT" ? PAYLOAD : PAYLOAD.subarray(0, 1),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.text() };
    },
    close() { return new Promise((resolve) => { server.closeIdleConnections?.(); server.close(() => resolve()); }); },
  };
}

/** A real single-PUT handle in the given Vault, created by the control plane. */
async function newHandle({ vaultId = PRIMARY_ID, target }) {
  const vaultRuntime = vaultId === "secondary" ? SECONDARY_RUNTIME : primaryRuntime;
  return withRequestContext({ vaultId, vaultRuntime, author: { agent: "p2", model: "test" } }, () => startDirectUpload({
    vaultPath: target,
    totalBytes: PAYLOAD.length,
    expectedSha256: DIGEST,
    overwrite: false,
  }));
}

const readFileSafe = async (file) => { try { return await fs.readFile(file); } catch { return null; } };

test("upload_shadow_preserves_bound_vault_after_default_and_grant_changes", async () => {
  const plane = await startPlane({ grantPrimary: true });
  const denying = await startPlane({ grantPrimary: false });
  const unsighted = await startPlane({ grantPrimary: true, shadow: false });
  try {
    // 1. A handle created in `vault` keeps writing there although this credential's
    //    own default now points at another Vault.
    const first = await newHandle({ target: `attachments/first-${Date.now()}.bin` });
    assert.equal(first.vaultId, PRIMARY_ID);
    const landed = await plane.put(first.relativePath);
    assert.equal(landed.status, 201, landed.body);
    assert.deepEqual(await fs.readFile(path.join(vault, first.path)), PAYLOAD, "the bound Vault received the bytes");
    const afterPut = plane.summary();
    assert.equal(afterPut.compared, 1, "one continuation is one row");
    const row = plane.rows()[0];
    assert.equal(row.capability, "start_direct_upload");
    assert.equal(row.phase, "upload");
    assert.equal(row.targetKind, "vault");
    assert.equal(row.oldAllowed, true);
    assert.equal(row.newAllowed, true);
    assert.equal(afterPut.differences, 0);

    // 2. A `PATCH` continuation is its own authorization unit on the same bound Vault.
    const second = await newHandle({ target: `attachments/second-${Date.now()}.bin` });
    const patch = await plane.put(second.relativePath, { method: "PATCH", headers: { "Upload-Offset": "0" } });
    assert.ok([200, 204, 409].includes(patch.status), `the old answer for a PATCH continuation is unchanged: ${patch.status} ${patch.body.slice(0, 120)}`);
    assert.equal(plane.summary().compared, 2, "the PATCH recorded its own row, before any mode or offset check");
    assert.equal(plane.rows()[1].capability, "start_direct_upload");
    assert.equal(plane.rows()[1].phase, "upload");

    // 3. A handle in a Vault this credential may not use is never found: no probe, no
    //    row, no bytes.
    const foreign = await newHandle({ vaultId: "secondary", target: `attachments/foreign-${Date.now()}.bin` });
    assert.equal(foreign.vaultId, "secondary");
    const before = plane.summary().compared;
    const refused = await plane.put(foreign.relativePath);
    assert.equal(refused.status, 404, "a handle outside the allowed Vaults is unknown");
    assert.equal(plane.summary().compared, before, "no target, no authorization row");
    assert.equal(await readFileSafe(path.join(secondary, foreign.path)), null);

    // 4. The old gate still decides when the new model would deny: the continuation
    //    lands, and exactly one difference records the gap.
    const third = await newHandle({ target: `attachments/third-${Date.now()}.bin` });
    const landedDenied = await denying.put(third.relativePath);
    assert.equal(landedDenied.status, 201, "the old gate allows; the shadow changes no answer");
    assert.deepEqual(await fs.readFile(path.join(vault, third.path)), PAYLOAD);
    assert.equal(denying.summary().compared, 1);
    const denyRow = denying.rows()[0];
    assert.equal(denyRow.oldAllowed, true);
    assert.equal(denyRow.newAllowed, false, "the candidate grants nothing on the bound Vault");
    assert.equal(denyRow.newCode, "vault_access_denied");
    assert.equal(denying.summary().differences, 1);

    // 5. Without an observer nothing is recorded and the answers are identical.
    const fourth = await newHandle({ target: `attachments/fourth-${Date.now()}.bin` });
    const bare = await unsighted.put(fourth.relativePath);
    assert.equal(bare.status, 201);
    assert.equal(unsighted.summary().compared, 0);

    // 6. No path, digest or credential id enters the record.
    const text = JSON.stringify(plane.summary()) + JSON.stringify(plane.rows());
    for (const leak of ["attachments/", DIGEST, "api-key:key-primary", PRIMARY_ID]) {
      assert.equal(text.includes(leak), false, `the record must not carry ${leak}`);
    }
  } finally {
    await plane.close();
    await denying.close();
    await unsighted.close();
  }
});
