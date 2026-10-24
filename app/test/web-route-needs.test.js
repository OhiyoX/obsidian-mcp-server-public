// #625 (WRITE-SURFACE-DESIGN §3.1): the frozen per-route needs table for the Web
// write surface + deny-by-default for a Web write route that is not registered.
//
// ① table ↔ reality: the table is frozen, every entry needs the write class, the
//    real router stack registers exactly those keys, and each registered route
//    hands the policy runtime exactly the capabilities its needs imply;
// ② deny-by-default: a fake write route mounted in the test, keyed with a path
//    that is not in the table, is refused before its handler — with and without an
//    injected runtime, and without consulting the runtime;
// ③ negative control: the same fake route wired with `passThrough` IS reached, so
//    ② is sensitive to the deny itself and not to Express routing;
// ④ behaviour regression over real HTTP (real session, real CSRF, an injected
//    allow-everything runtime): every registered write route still answers 403 for
//    a missing scope and 403 for a missing CSRF token, a fully authorised writer
//    still reaches the handler's own validation, and a temporal deny still answers
//    the same 403 body the pre-#625 shared write gate produced.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

// The Vault env is read at module-import time and `src/access-policy/capabilities.js`
// imports `src/config.js` for the frozen tool vocabulary, so the env has to be in
// place before ANY app module is imported: a static import here would freeze the
// `VAULT_PATH` fallback. Same pattern as the other Web route tests.
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-route-needs-"));
await fs.mkdir(path.join(ROOT, "vault"), { recursive: true });
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
delete process.env.WEB_VAULTS_ROOT;

const {
  WEB_WRITE_ROUTE_NEEDS,
  WEB_WRITE_ROUTE_NOT_REGISTERED,
  createWebAccessPolicy,
  denyUnregisteredWriteRoute,
  webWriteRouteGate,
  webWriteRouteNeeds,
} = await import("../src/app/access-policy.js");
const { capabilitiesForWebRoute } = await import("../src/access-policy/capabilities.js");
const { WRITE_ROUTE_CALLS, callRoute, startWebWriteSurface } = await import("./helpers/web-write-surface-harness.js");

test.after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

const ALLOW = Object.freeze({ allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null, matchedPolicyIds: [] });
const DENY_SUSPEND = Object.freeze({ allowed: false, mode: "suspend", reason: "outside_window", denyPolicyId: "policy-suspend", matchedPolicyIds: ["policy-suspend"] });

const TABLE_KEYS = Object.keys(WEB_WRITE_ROUTE_NEEDS).sort();
const ROUTE_KEYS = WRITE_ROUTE_CALLS.map((route) => route.key).sort();
const UNREGISTERED = "POST /api/web/v1/not-registered";

// Write-method routes on the Web router that are NOT part of the content write
// pipeline, so they are (correctly) absent from the table. Frozen on purpose: a
// new route that lands here without being registered fails ①.
const NON_WRITE_PIPELINE_ROUTES = Object.freeze([
  "POST /auth/login", // auth plane: credential exchange, before any session exists
  "POST /auth/logout", // auth plane: session teardown
  "POST /api/web/v1/vault/select", // session plane: switches the session's current vault inside allowedVaults, writes no content
]);

/** What a fully authorised writer must see, per registered route (see ④). */
const AUTHORISED_READOUTS = {
  "POST /api/web/v1/note": (r) => {
    assert.equal(r.status, 200, `note: ${r.text}`);
    assert.equal(r.json.created, true);
  },
  "POST /api/web/v1/folder": (r) => {
    assert.equal(r.status, 201);
    assert.equal(r.json.path, "NewFolder");
  },
  "POST /api/web/v1/asset": (r) => {
    assert.equal(r.status, 201);
    assert.ok(String(r.json.path).endsWith(".png"), `asset path: ${r.json.path}`);
  },
  // The harness has no multi-vault root, so vault creation stops at its own guard.
  "POST /api/web/v1/vault": (r) => {
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "Vault creation is not available" });
  },
  "POST /api/web/v1/publish": (r) => {
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "Unsupported publish action" });
  },
  // No If-Match: the route's own precondition refusal, i.e. the handler really ran.
  "PATCH /api/web/v1/base": (r) => {
    assert.equal(r.status, 428);
    assert.deepEqual(r.json, { error: "precondition-required", code: "precondition-required", message: "PATCH /api/web/v1/base requires If-Match (or body ifMatch)" });
  },
};

function fakeRuntime(decision = ALLOW) {
  const calls = { evaluate: [], explain: [], audit: [] };
  return {
    status: "ready",
    calls,
    evaluate(input) {
      calls.evaluate.push(input);
      return decision;
    },
    explain(input) {
      calls.explain.push(input);
      return { nextAllowedAt: null };
    },
    audit(event) {
      calls.audit.push(event);
    },
  };
}

const session = (overrides = {}) => ({
  id: "web-session-1",
  userId: "u1",
  vaultId: "default",
  allowedVaults: ["default"],
  csrf: "csrf-token",
  ...overrides,
});

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function invoke(middleware, req = {}) {
  const res = makeRes();
  let nextCalled = 0;
  middleware(req, res, () => {
    nextCalled += 1;
  });
  return { res, nextCalled };
}

function writeRouteKeys(router) {
  const keys = new Set();
  for (const layer of router.stack ?? []) {
    const route = layer.route;
    if (!route) continue;
    for (const method of Object.keys(route.methods ?? {})) {
      if (method === "get" || method === "head") continue;
      keys.add(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return [...keys].sort();
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

const post = (base, path) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

test("① the per-route needs table is frozen and every entry needs obsidian.write", () => {
  assert.ok(Object.isFrozen(WEB_WRITE_ROUTE_NEEDS));
  assert.deepEqual(TABLE_KEYS, ROUTE_KEYS);
  for (const key of TABLE_KEYS) {
    const needs = WEB_WRITE_ROUTE_NEEDS[key];
    assert.ok(Object.isFrozen(needs), `${key}: needs must be frozen`);
    assert.deepEqual(needs, ["obsidian.read", "obsidian.write"], `${key}: needs`);
    // §3.2: no Web write route may need `obsidian.read` alone.
    assert.ok(needs.includes("obsidian.write"), `${key}: must need obsidian.write`);
  }
  assert.equal(webWriteRouteNeeds(UNREGISTERED), null);
  assert.equal(webWriteRouteNeeds("POST /api/web/v1/note "), null);
  assert.equal(webWriteRouteNeeds(undefined), null);
});

test("① every registered route is gated with exactly the capabilities its needs imply", () => {
  const runtime = fakeRuntime();
  const policy = createWebAccessPolicy({ runtime });
  const writeCapabilities = policy.webCapabilities.write;
  for (const key of TABLE_KEYS) {
    assert.deepEqual(capabilitiesForWebRoute({ scopes: WEB_WRITE_ROUTE_NEEDS[key] }), writeCapabilities, `${key}: needs -> capabilities`);
    const { res, nextCalled } = invoke(policy.requireWebWriteRoute(key), { webSession: session() });
    assert.equal(nextCalled, 1, `${key}: an allowed request must proceed`);
    assert.equal(res.statusCode, null, `${key}: no rejection`);
    assert.deepEqual(runtime.calls.evaluate.at(-1).capabilities, writeCapabilities, `${key}: runtime capabilities`);
  }
  // The pre-#625 shared gate carries the same capability set for every entry.
  invoke(policy.requireWebWrite, { webSession: session() });
  assert.deepEqual(runtime.calls.evaluate.at(-1).capabilities, writeCapabilities);
});

test("① the table covers exactly the write routes the app router registers", async () => {
  const surface = await startWebWriteSurface({ root: ROOT, label: "web-route-needs-enumeration" });
  try {
    const enumerated = writeRouteKeys(surface.router);
    const nonWrite = [...NON_WRITE_PIPELINE_ROUTES].sort();
    assert.deepEqual(enumerated.filter((key) => !nonWrite.includes(key)), TABLE_KEYS);
    // No stale allowlist entry: each exempted key must still exist on the router.
    assert.deepEqual(nonWrite.filter((key) => !enumerated.includes(key)), []);
    for (const key of nonWrite) assert.equal(webWriteRouteNeeds(key), null, `${key}: must not be in the write table`);
  } finally {
    await surface.close();
  }
});

test("② an unregistered web write route is denied before its handler runs", async () => {
  const reached = [];
  const runtime = fakeRuntime();
  const policy = createWebAccessPolicy({ runtime });
  const handler = (req, res) => {
    reached.push(req.path);
    res.json({ ok: true });
  };
  const app = express();
  app.use(express.json());
  app.post("/api/web/v1/not-registered", webWriteRouteGate(policy, UNREGISTERED), handler);
  // Stage 0 (no runtime injected): the deny must not depend on the policy plane.
  app.post("/api/web/v1/not-registered-stage0", webWriteRouteGate(null, "POST /api/web/v1/not-registered-stage0"), handler);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/api/web/v1/not-registered", "/api/web/v1/not-registered-stage0"]) {
      const denied = await post(base, path);
      assert.equal(denied.status, 403, `${path}: status`);
      assert.deepEqual(await denied.json(), { error: WEB_WRITE_ROUTE_NOT_REGISTERED }, `${path}: body`);
    }
    assert.deepEqual(reached, [], "the deny must land before the handler");
    assert.equal(runtime.calls.evaluate.length, 0, "the table lookup must precede any policy evaluation");
    // Unit level: the same refusal for the policy object and for the bare deny.
    const bareDeny = invoke(denyUnregisteredWriteRoute, {});
    assert.equal(bareDeny.nextCalled, 0);
    assert.equal(bareDeny.res.statusCode, 403);
    assert.deepEqual(bareDeny.res.body, { error: WEB_WRITE_ROUTE_NOT_REGISTERED });
    const viaPolicy = invoke(policy.requireWebWriteRoute(UNREGISTERED), { webSession: session() });
    assert.equal(viaPolicy.nextCalled, 0);
    assert.equal(viaPolicy.res.statusCode, 403);
    assert.deepEqual(viaPolicy.res.body, { error: WEB_WRITE_ROUTE_NOT_REGISTERED });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("③ negative control: without the deny the same fake route is reachable", async () => {
  const reached = [];
  const passThrough = (_req, _res, next) => next();
  // The gate reads `req.webSession` (set by `requireApi` in production), so the
  // standalone mounts below stub it with an already-authenticated session.
  const stubSession = (req, _res, next) => {
    req.webSession = session();
    next();
  };
  const runtime = fakeRuntime();
  const policy = createWebAccessPolicy({ runtime });
  const handler = (req, res) => {
    reached.push(req.path);
    res.json({ ok: true });
  };
  const app = express();
  app.use(express.json());
  app.post("/api/web/v1/not-registered", passThrough, handler);
  // Registered-key control: the deny is keyed on registration, not a blanket 403.
  app.post("/api/web/v1/control-registered", stubSession, webWriteRouteGate(policy, "POST /api/web/v1/note"), handler);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unguarded = await post(base, "/api/web/v1/not-registered");
    assert.equal(unguarded.status, 200, "removing the deny must make ② red");
    const registered = await post(base, "/api/web/v1/control-registered");
    assert.equal(registered.status, 200, "a registered key must pass the same gate");
    assert.deepEqual(reached, ["/api/web/v1/not-registered", "/api/web/v1/control-registered"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("④ every registered write route keeps its 403s and still reaches its handler", async () => {
  const runtime = fakeRuntime();
  const surface = await startWebWriteSurface({ root: ROOT, accessRuntime: runtime, label: "web-route-needs-regression" });
  try {
    for (const route of WRITE_ROUTE_CALLS) {
      const noScope = await callRoute(surface.base, route, surface.reader);
      assert.equal(noScope.status, 403, `${route.key}: reader status`);
      assert.deepEqual(noScope.json, { error: "Account does not have write permission" }, `${route.key}: reader body`);

      const noCsrf = await callRoute(surface.base, route, surface.writer, { csrf: false });
      assert.equal(noCsrf.status, 403, `${route.key}: missing CSRF status`);
      assert.deepEqual(noCsrf.json, { error: "CSRF validation failed" }, `${route.key}: missing CSRF body`);

      const authorised = await callRoute(surface.base, route, surface.writer);
      assert.notEqual(authorised.status, 403, `${route.key}: an authorised writer must pass the gate`);
      AUTHORISED_READOUTS[route.key](authorised);
    }
    assert.equal(runtime.calls.evaluate.length > 0, true, "the injected policy plane must have been consulted");
  } finally {
    await surface.close();
  }
});

test("④ a temporal deny on a registered write route keeps the pre-#625 403 body", async () => {
  const runtime = fakeRuntime(DENY_SUSPEND);
  const surface = await startWebWriteSurface({ root: ROOT, accessRuntime: runtime, label: "web-route-needs-window" });
  try {
    const note = WRITE_ROUTE_CALLS.find((route) => route.key === "POST /api/web/v1/note");
    const denied = await callRoute(surface.base, note, surface.writer);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, "outside_authorized_window");
    assert.equal(denied.json.mode, "suspend");
    assert.equal(denied.json.policyId, "policy-suspend");
    assert.deepEqual(denied.json.nextAllowedAt, null);
    assert.deepEqual(runtime.calls.evaluate.at(-1).capabilities, ["all", "surface:web", "scope:obsidian.read", "scope:obsidian.write"]);
    assert.equal(runtime.calls.audit.at(-1)?.action, "authz.deny");
  } finally {
    await surface.close();
  }
});
