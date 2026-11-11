// Task 8 — the `/healthz` authorization report, and the silence it must keep.
//
// Contract: plan Task 8 and design §7. The report carries three facts and no more: the mode
// in force, the committed document revision, and how many constraints that document holds.
// It never carries a subject id, a Vault id, a window or a label — those stay on Admin — and
// this file proves that absence instead of promising it in a comment.
//
// The payload is assembled inside `server.js`, so the real process is spawned against a
// temporary DATA_PATH (`helpers/server-spawn-fixtures.js`); no helper here decides anything.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { serializeAuthorizationDocument, validateAuthorizationDocument } from "../src/authorization/schema.js";
import { freePort, seedVault, serverEnv, startServer, stopChild } from "./helpers/server-spawn-fixtures.js";

// Every value below is a needle the report must not carry: a label, a subject id, a Vault id
// and a window with its timezone.
const LABEL = "quiet-hours-label";
const SUBJECT = "api-key:configured-env";
const VAULT_ID = "vault-needle-id";
const TIMEZONE = "Asia/Shanghai";
const WINDOW_START = "09:00";

const CONSTRAINT = {
  id: "11111111-1111-4111-8111-111111111111",
  label: LABEL,
  enabled: true,
  subjects: [SUBJECT],
  mode: "suspend",
  selector: { anyOf: [{ surfaces: null, capabilities: ["read_note"], targets: [{ kind: "vault", vaultId: VAULT_ID }] }] },
  schedule: { timezone: TIMEZONE, weekly: { mon: [[WINDOW_START, "18:00"]] }, dateRanges: [], startsAt: null, expiresAt: null },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function documentWith(revision, constraints) {
  return validateAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision,
    timeConstraintsEnabled: true,
    subjects: {},
    constraints,
  });
}

async function boot(extra = {}, prepare = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "healthz-authz-"));
  await seedVault(root);
  if (prepare !== null) {
    await fs.mkdir(path.join(root, "data"), { recursive: true });
    await fs.writeFile(path.join(root, "data", "authorization.json"), prepare, "utf8");
  }
  const port = await freePort();
  const started = await startServer(serverEnv({ port, root, extra }));
  const health = await (await fetch(`${started.base}/healthz`)).json();
  return { ...started, health, root };
}

test("a first boot seeds the document and reports the mode, revision and constraint count", async () => {
  const { child, health } = await boot();
  try {
    assert.deepEqual(health.authorization, { mode: "legacy", revision: 1, constraints: 0 });
  } finally {
    await stopChild(child);
  }
});

test("a committed document's revision and constraint count are reported, and nothing else", async () => {
  const serialized = serializeAuthorizationDocument(documentWith(5, [CONSTRAINT, { ...CONSTRAINT, id: "22222222-2222-4222-8222-222222222222", label: "second" }]));
  const { child, health } = await boot({}, serialized);
  try {
    assert.deepEqual(health.authorization, { mode: "legacy", revision: 5, constraints: 2 });
    // The report is exactly these three keys: a subject, a Vault, a window or a label would be
    // a fourth one, or a value under one of these.
    assert.deepEqual(Object.keys(health.authorization).sort(), ["constraints", "mode", "revision"]);
    const text = JSON.stringify(health.authorization);
    for (const needle of [LABEL, SUBJECT, VAULT_ID, TIMEZONE, WINDOW_START, CONSTRAINT.id, "read_note", "mon"]) {
      assert.equal(text.includes(needle), false, `the health report must not carry ${needle}`);
    }
  } finally {
    await stopChild(child);
  }
});

test("the report follows the configured mode", async () => {
  const serialized = serializeAuthorizationDocument(documentWith(7, [CONSTRAINT]));
  const { child, health } = await boot({ AUTHORIZATION_MODE: "shadow" }, serialized);
  try {
    assert.deepEqual(health.authorization, { mode: "shadow", revision: 7, constraints: 1 });
  } finally {
    await stopChild(child);
  }
});
