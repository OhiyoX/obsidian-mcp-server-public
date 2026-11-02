// AuthZ Wave C / C1 — real-server end-to-end integration (readiness + policy states).
//
// Contract: `scratch/authz/INTERFACE.md` §10.1/§10.2/§10.3/§10.6 and the C1
// BRIEF §2. These tests spawn the real `server.js` against a temporary DATA_PATH
// and talk to it over HTTP, so wiring defects that pure helper tests cannot see
// (registration order, middleware injection, health aggregation, Stage 0
// zero-difference) are exercised for real.
//
// This file covers Stage 0, the empty policy store, the suspend gate and the
// broken-store fail-closed path. The hard-revoke, OAuth-lifecycle and
// shutdown-drain half lives in
// `access-policy-server-integration-lifecycle.test.js`; the shared spawn/HTTP
// fixtures are `helpers/server-spawn-fixtures.js`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TOOL_NAMES } from "../src/config.js";
import {
  API_KEY,
  METADATA_TOOLS,
  callTool,
  freePort,
  initialize,
  listTools,
  outsideWindowPolicy,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
  waitForAudit,
  writeCorruptPolicy,
  writePolicy,
} from "./helpers/server-spawn-fixtures.js";

test("Stage 0: AUTHZ_ENABLED unset ignores a corrupt policy file (zero behaviour difference)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-stage0-"));
  const port = await freePort();
  await seedVault(root);
  await writeCorruptPolicy(root);
  const env = serverEnv({ port, root });
  const { child, base } = await startServer(env);
  try {
    const healthResponse = await fetch(`${base}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.deepEqual(health.authorizationWindows, { enabled: false, status: "disabled", policyCount: 0 });
    const rootInfo = await (await fetch(`${base}/`, { headers: { "X-API-Key": API_KEY } })).json();
    assert.deepEqual(rootInfo.authorizationWindows, { enabled: false, status: "disabled", policyCount: 0 });
    assert.ok(!("subjects" in rootInfo.authorizationWindows) && !("schedule" in rootInfo.authorizationWindows));

    const init = await initialize(base, { key: API_KEY });
    assert.equal(init.status, 200);
    const listed = await listTools(base, { key: API_KEY }, init.session);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload.result.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    const read = await callTool(base, { key: API_KEY }, init.session, "get_note", { path: "note.md" });
    assert.equal(read.status, 200);
    assert.notEqual(read.payload.result.isError, true);
  } finally {
    await stopChild(child);
  }
});

test("enabled + empty policy store: ready with policyCount 0 and content still readable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-empty-"));
  const port = await freePort();
  await seedVault(root);
  const env = serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } });
  const { child, base } = await startServer(env);
  try {
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.deepEqual(health.authorizationWindows, { enabled: true, status: "ready", policyCount: 0 });
    const init = await initialize(base, { key: API_KEY });
    const read = await callTool(base, { key: API_KEY }, init.session, "get_note", { path: "note.md" });
    assert.equal(read.status, 200);
    assert.notEqual(read.payload.result.isError, true);
  } finally {
    await stopChild(child);
  }
});

test("suspend outside the window denies content, keeps discovery/metadata, and audits truthfully", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-suspend-"));
  const port = await freePort();
  await seedVault(root);
  await writePolicy(root, [outsideWindowPolicy()]);
  const env = serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } });
  const { child, base } = await startServer(env);
  try {
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.authorizationWindows.status, "ready");
    assert.equal(health.authorizationWindows.policyCount, 1);

    const init = await initialize(base, { key: API_KEY });
    assert.equal(init.status, 200);

    // A-08: suspend never mutates discovery.
    const listed = await listTools(base, { key: API_KEY }, init.session);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload.result.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());

    // A-06/A-11: the content gate denies with the frozen machine code.
    const denied = await callTool(base, { key: API_KEY }, init.session, "get_note", { path: "note.md" }, 11);
    assert.equal(denied.status, 200);
    assert.equal(denied.payload.result.isError, true);
    assert.equal(denied.payload.result.structuredContent.code, "outside_authorized_window");
    assert.equal(denied.payload.result.structuredContent.mode, "suspend");
    assert.ok(denied.payload.result.structuredContent.policyId);
    assert.equal(denied.payload.result.content[0].text, JSON.stringify(denied.payload.result.structuredContent));

    // A-07: the metadata plane stays reachable while suspended.
    for (const [index, tool] of METADATA_TOOLS.entries()) {
      const metadata = await callTool(base, { key: API_KEY }, init.session, tool, {}, 20 + index);
      assert.equal(metadata.status, 200, `${tool} must stay callable`);
      assert.notEqual(metadata.payload.result.isError, true, `${tool} must not be denied by the temporal gate`);
    }

    const audit = await waitForAudit(root, (entries) => entries.some((entry) => entry.action === "authz.deny"));
    const denies = audit.filter((entry) => entry.action === "authz.deny");
    const successes = audit.filter((entry) => typeof entry.action === "string" && entry.action.startsWith("mcp.tool.get_note") && entry.outcome !== "failure");
    assert.equal(successes.length, 0, "a denied tools/call must not record a success (A-10)");
    assert.equal(denies.length, 1, `expected exactly one authz.deny for the denied call, got ${JSON.stringify(denies)}`);
    assert.equal(denies[0].outcome, "failure");
    assert.equal(denies[0].surface, "mcp");
    assert.equal(denies[0].mode, "suspend");
    assert.ok(denies[0].policyId);
  } finally {
    await stopChild(child);
  }
});


test("broken policy fails closed on content but keeps startup and the metadata plane", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wave-c-broken-"));
  const port = await freePort();
  await seedVault(root);
  await writeCorruptPolicy(root);
  const env = serverEnv({ port, root, extra: { AUTHZ_ENABLED: "true" } });
  const { child, base } = await startServer(env);
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.authorizationWindows.enabled, true);
    assert.equal(body.authorizationWindows.status, "broken");

    const init = await initialize(base, { key: API_KEY });
    assert.equal(init.status, 200);
    const denied = await callTool(base, { key: API_KEY }, init.session, "get_note", { path: "note.md" });
    assert.equal(denied.payload.result.isError, true);
    assert.equal(denied.payload.result.structuredContent.code, "authorization_policy_unavailable");

    const metadata = await callTool(base, { key: API_KEY }, init.session, "server_info", {});
    assert.notEqual(metadata.payload.result.isError, true);
  } finally {
    await stopChild(child);
  }
});

