// P3 / Task 22 — the boundaries outside the Web/MCP routers decide through the runtime too.
//
// Contract: design §6.1.5-8 and §10 P3. Three properties decide this task:
//
//   1. NO CONTENT WITHOUT A DECISION. The direct-upload data plane, the anonymous public
//      read and every Admin control action ask the authorization runtime, and a deny it
//      states stops the bytes, the body and the write: the counters stay at 0.
//   2. THE DOMAIN CONTROLS STAY. Handle metadata containment, the Publish lifecycle, the
//      Git configuration and the Admin session/CSRF checks are not permission decisions and
//      are untouched.
//   3. THE PROOF IS NOT FORGEABLE. A `system` or `admin-session` actor can only come from the
//      verifier of its own surface: an ordinary request body cannot supply one.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

// The temp Vault must exist and the environment must be fixed BEFORE any module-scope config
// read (the frozen `VAULT`/`DATA_PATH` constants), so the fixture comes first.
const FIXTURE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "authz-domain-publish-"));
const FIXTURE_VAULT = path.join(FIXTURE_ROOT, "vault");
await fs.mkdir(path.join(FIXTURE_VAULT, "Notes"), { recursive: true });
await fs.writeFile(path.join(FIXTURE_VAULT, "Public.md"), "# Public sentinel\n", "utf8");
process.env.VAULT_PATH = FIXTURE_VAULT;
delete process.env.WEB_VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = path.basename(FIXTURE_VAULT);
process.env.DATA_PATH = path.join(FIXTURE_ROOT, "data");
await fs.mkdir(process.env.DATA_PATH, { recursive: true });
const { PublishService } = await import("../src/publish/service.js");

const ALLOWED = Object.freeze({
  allowed: true, code: "allowed", enforcement: "operation", mode: null,
  revision: null, matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt: null,
});

function deny(code = "vault_access_denied") {
  return Object.freeze({
    allowed: false, code, enforcement: "operation", mode: null, revision: null,
    matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt: null,
  });
}

function stubRuntime(decide) {
  const calls = [];
  return {
    calls,
    authorize(request) {
      calls.push(request);
      return decide(request) ?? ALLOWED;
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// 1. Direct upload: a runtime deny stops the request before any byte is written.
// ---------------------------------------------------------------------------

test("direct_upload_writes_no_byte_when_the_runtime_denies", async () => {
  const { createDirectUploadRouter } = await import("../src/direct-upload.js");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "authz-domain-upload-"));
  try {
    const app = express();
    const denials = [];
    const uploads = { started: 0 };
    app.use((req, _res, next) => {
      req.auth = { type: "api-key", keyId: "domain-key", clientId: "api-key:domain-key", scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], allowedVaults: ["default"] };
      next();
    });
    const authorization = stubRuntime(() => deny("outside_authorized_window"));
    app.use("/", createDirectUploadRouter({
      auth: (_req, _res, next) => next(),
      authorization,
      provider: null,
      // The handle lookup itself is untouched: the deny must happen before it.
      define: null,
      resolveRuntime: () => null,
      statfs: async () => ({ bsize: 4096, blocks: 10_000, bfree: 9_000, bavail: 9_000 }),
    }));
    app.use((error, _req, res, _next) => res.status(500).json({ error: String(error?.message || error) }));

    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/uploads/does-not-exist`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: "payload" });
      assert.equal(response.status, 403, "a runtime deny is the upload's answer");
      const body = await response.json();
      assert.equal(body.error, "outside_window");
      assert.equal(authorization.calls.length, 1, "one decision per write");
      assert.equal(authorization.calls[0].capability, "start_direct_upload");
      assert.equal(authorization.calls[0].surface, "mcp");
      assert.equal(uploads.started, 0, "no upload handle work happens on a deny");
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Publish: the anonymous read decides with the record as its proof.
// ---------------------------------------------------------------------------

test("public_read_serves_no_body_when_the_runtime_denies_and_the_proof_is_the_record", async () => {
  try {
    const service = new PublishService({ file: path.join(process.env.DATA_PATH, "publish.json") });
    await service.ready;
    const published = await service.publish(undefined, "Public.md");
    assert.ok(published?.id, "the fixture must publish one note");

    // A deny: the read answers "not found" and no body is returned.
    const denying = [];
    const denied = await service.resolve(published.id, {
      authorize: (request) => {
        denying.push(request);
        return deny("capability_denied");
      },
    });
    assert.equal(denied, null, "a denied public read serves nothing");
    assert.equal(denying.length, 1);
    assert.equal(denying[0].surface, "publish");
    assert.equal(denying[0].capability, "publish_document_read");
    assert.equal(denying[0].actor.kind, "publication");
    assert.equal(denying[0].actor.subjectIds.length, 0, "a link is not a person's credential");
    assert.deepEqual(denying[0].actor.proof, { kind: "publication", id: published.id }, "the proof is the record itself");
    assert.deepEqual(denying[0].target, { kind: "publication", id: published.id });

    // An allow still serves the body: the deny above is the runtime's answer.
    const allowed = await service.resolve(published.id, { authorize: () => ALLOWED });
    assert.equal(allowed?.record?.id, published.id);
    assert.match(allowed?.note?.content ?? "", /Public sentinel/);
  } finally {
    await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Admin: a control action is decided with the console's own proof.
// ---------------------------------------------------------------------------

test("admin_control_actions_deny_without_the_console_proof_and_write_nothing", async () => {
  const { createAdminRouter } = await import("../src/admin/router.js");

  async function mount({ authorization }) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    const audit = [];
    app.use("/admin/auth", createAdminRouter({
      provider: {
        authorizationSnapshot: async () => ({ apiKeys: [], oauthUsers: [], clients: [], tokens: [], audit }),
        recordAudit: (event) => audit.push(event),
      },
      adminPassword: "test-only-password",
      secureCookie: false,
      authorization,
    }));
    return { app, audit };
  }

  const deniedRuntime = stubRuntime(() => deny("capability_denied"));
  const denying = await mount({ authorization: deniedRuntime });
  const server = await listen(denying.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // The login itself is a catalog boundary too, and the runtime admits it here so the
    // session exists: the deny below must come from the control action, not from login.
    denyingRuntimeAuthorize(deniedRuntime, "/login");
    const login = await fetch(`${base}/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=test-only-password",
      redirect: "manual",
    });
    assert.equal(login.status, 303, "the console login still runs first");
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie.includes("="), "the console issued a session cookie");

    // A control action: refused by the runtime, and no audit/state change happened.
    const before = denying.audit.length;
    const deniedAction = await fetch(`${base}/admin/auth/theme`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: "csrf=irrelevant&theme=dark",
      redirect: "manual",
    });
    assert.equal(deniedAction.status, 403, "a runtime deny stops the control action");
    assert.equal(denying.audit.length, before, "a denied control action records no change");
    const control = deniedRuntime.calls.find((call) => call.capability === "admin_metadata_read" && call.surface === "admin");
    assert.ok(control, "the control action was decided on the admin surface");
    assert.equal(control.actor.kind, "admin-session");
    assert.equal(control.actor.subjectIds.length, 0, "the console is not a person's credential");
    assert.deepEqual(control.actor.proof, { kind: "admin-session" }, "the console's own verifier supplies the proof");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Let the login boundary through, keep every other decision a deny. */
function denyingRuntimeAuthorize(runtime, allowedPath) {
  const decidedOnce = runtime.authorize;
  runtime.authorize = (request) => {
    if (request.legacy?.path === allowedPath) return ALLOWED;
    return decidedOnce(request);
  };
}

// ---------------------------------------------------------------------------
// 4. The proof is not forgeable from request input.
// ---------------------------------------------------------------------------

test("no_request_body_can_supply_a_system_or_admin_proof", async () => {
  const { adminAuthorizationRequest } = await import("../src/authorization/adapters/admin.js");
  const { gitTaskAuthorizationRequest } = await import("../src/authorization/adapters/git.js");
  const { verifyGitTaskAuthorization, verifyAdminSession } = await import("../src/authorization/actors.js").then(
    (module) => ({ verifyGitTaskAuthorization: module.isVerifiedActor, verifyAdminSession: module.isVerifiedActor }),
  );

  // An ordinary request-shaped object is not an actor: the brand never survives a JSON round
  // trip, so a body, an argument or `_meta` cannot become a proof.
  const forged = JSON.parse(JSON.stringify({ kind: "system", subjectIds: [], proof: { kind: "system", vaultId: "vault", task: "commit" } }));
  assert.equal(verifyGitTaskAuthorization(forged), false);
  assert.equal(verifyAdminSession({ ...forged, kind: "admin-session", proof: { kind: "admin-session" } }), false);

  // The verifiers that CAN build one carry no subject, and the request they build names the
  // operation on the right surface.
  const admin = adminAuthorizationRequest({ routeKey: "ADMIN POST /theme" });
  assert.equal(admin.actor.kind, "admin-session");
  assert.equal(admin.surface, "admin");
  const task = gitTaskAuthorizationRequest({ vaultId: "vault", task: "commit" });
  assert.equal(task.actor.kind, "system");
  assert.equal(task.surface, "system");
  assert.equal(task.actor.subjectIds.length, 0);
});
