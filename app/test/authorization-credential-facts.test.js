// P4 / Task 23 — the actor carries the credential's frozen ceiling and committed epoch.
//
// Contract: design §5.2 (the token's frozen `grantCeiling` intersects the live grants)
// and §7 ("a ceiling the user once consented to is frozen; what the operator allows
// now is read live"). Two default values made the shadow report dishonest:
//
//   * `grantCeiling: null` reads as "this credential does not tighten anything", so a
//     token narrower than its account appeared to allow what the old Scope gate denies;
//   * `credentialEpochs: 0` reads as a stale credential as soon as the permission state
//     commits an epoch above zero, so every request became `invalid_credential`.
//
// Both facts are held by the composition root (the imported state), never by the
// adapter. This file proves the feed works at the real MCP boundary and that the same
// request differs without it: each proof has its negative control (§11.2).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authz-credential-facts-"));
process.env.DATA_PATH = root;
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18932";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "facts-owner";
process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
process.env.API_KEY = "facts-configured-key";
process.env.MCP_PATH = "/mcp";
process.env.WEB_VAULTS_ROOT = path.join(root, "vaults");
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";

const MCP_URL = "http://127.0.0.1:18932/mcp";
const ACCOUNT = "facts-user";
const PASSWORD = "facts-user-password";

test.after(async () => {
  await harness.close();
});

/** The imported state, a runtime over it, and one app: the production shape, by hand. */
async function boot() {
  const [
    { createAuthMiddleware },
    { createOAuthService },
    { createAuthorizationRuntime, createLegacyDecisionBackend },
    { createShadowCandidate, createShadowRecorder },
    { importLegacyAuthorization },
    { installCredentialFacts, credentialFacts },
  ] = await Promise.all([
    import("../src/auth.js"),
    import("../src/oauth-provider.js"),
    import("../src/authorization/runtime.js"),
    import("../src/authorization/shadow.js"),
    import("../src/authorization/legacy-import.js"),
    import("../src/authorization/credential-facts.js"),
  ]);

  const oauthService = createOAuthService();
  const provider = oauthService.provider;
  await provider.ready;
  const account = await provider.createOAuthUser({
    username: ACCOUNT,
    password: PASSWORD,
    displayName: "Facts",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["vault"],
  });
  // A registered client is a subject of the plane (`grants: null` = does not tighten).
  provider.data.clients["facts-client"] = { client_id: "facts-client" };
  // A token narrower than its account: the account may write, this credential may not.
  const narrow = provider.issueTokens("facts-client", ["obsidian.read"], MCP_URL, account.id, ["vault"]);
  await provider.save();
  const subjectId = `oauth-user:${account.id}`;

  /**
   * One app over the imported state. `committed` is the epoch the permission state commits
   * now (the document and the projection); `frozen` is the epoch the credential was issued
   * with (its envelope). The two are separate facts on purpose: a credential issued before
   * an epoch moved must stay stale, and a credential issued after it must pass.
   */
  async function app({ committed = 0, frozen = committed, feed = true } = {}) {
    const imported = importLegacyAuthorization({
      providerSnapshot: provider.data,
      policyDocument: null,
      timeConstraintsEnabled: false,
      environmentKey: { configured: true, vaults: ["vault"] },
    });
    const document = committed === 0 ? imported.document : atEpoch(imported.document, subjectId, committed);
    const identity = { subjects: projectionSubjects(document, provider.data), sessions: {} };
    if (committed !== 0) identity.subjects[subjectId] = { credentialEpoch: committed, disabled: false };
    const envelopes = atFrozenEpoch(imported.credentialEnvelopes, subjectId, frozen);

    const recorder = createShadowRecorder({ capacity: 32 });
    const runtime = createAuthorizationRuntime({
      store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document }) }),
      identitySnapshot: () => identity,
      vaultSnapshot: () => ({ vault: { admitted: true, readOnly: false } }),
      publicationSnapshot: () => null,
      deployment: () => ({ readOnly: false }),
      now: () => Date.now(),
      // The deployment the window runs before the flip: the old gate still answers, and
      // the new model is compared beside it.
      mode: "legacy",
      legacy: createLegacyDecisionBackend({ accessRuntime: null }),
      shadow: recorder,
    });
    await runtime.ready;

    installCredentialFacts(feed
      ? (authInfo) => credentialFacts({ authInfo, envelopes })
      : null);

    const handled = [];
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(createAuthMiddleware(oauthService, { authorization: runtime, authorizationShadow: runtime.shadow }));
    app.post("/mcp", (req, res) => {
      handled.push(req.auth);
      res.status(200).json({ ok: true });
    });
    const server = await new Promise((resolve, reject) => {
      const instance = http.createServer(app);
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => resolve(instance));
    });
    return {
      handled,
      recorder,
      token: narrow.access_token,
      call: (name, args) => fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${narrow.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      close: () => new Promise((resolve, reject) => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close((error) => error ? reject(error) : resolve());
      }),
    };
  }

  return {
    narrow,
    subjectId,
    app,
    async close() {
      installCredentialFacts(null);
      await provider.drainPersistence();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** The production projection (server.js): one subject row per imported subject. */
function projectionSubjects(document, providerData) {
  const subjects = {};
  for (const [subjectId, record] of Object.entries(document.subjects)) {
    const disabled = subjectId.startsWith("oauth-user:")
      ? Boolean(providerData?.oauthUsers?.[subjectId.slice("oauth-user:".length)]?.disabledAt)
      : false;
    subjects[subjectId] = { credentialEpoch: record.credentialEpoch, disabled };
  }
  return subjects;
}

/** The import's envelopes with the credential's frozen subject epoch set. */
function atFrozenEpoch(envelopes, subjectId, epoch) {
  return Object.fromEntries(Object.entries(envelopes).map(([id, envelope]) => [id, {
    ...envelope,
    authorization: { ...envelope.authorization, subjectEpochs: { [subjectId]: epoch } },
  }]));
}

/** The same document with one subject's committed epoch moved. */
function atEpoch(document, subjectId, epoch) {
  return {
    ...document,
    subjects: { ...document.subjects, [subjectId]: { ...document.subjects[subjectId], credentialEpoch: epoch } },
  };
}

const harness = await boot();

test("a_token_narrower_than_its_account_shows_no_shadow_difference", async () => {
  // The old Scope gate denies `write_note` (this credential holds read only); the new
  // model must deny it too, because the frozen ceiling is intersected with the live
  // account grants. Without the envelope the account's write grant would allow it.
  const withFacts = await harness.app({ feed: true });
  try {
    const response = await withFacts.call("write_note", { path: "note.md", content: "x" });
    assert.equal(response.status, 403, "the old gate still refuses the write");
    assert.equal(withFacts.handled.length, 0, "a refused write never reaches the handler");
    const summary = withFacts.recorder.summary();
    assert.equal(summary.compared, 1, "one tools/call member, one row");
    assert.equal(summary.differences, 0, `the narrow token must agree: ${JSON.stringify(withFacts.recorder.rows())}`);
    const [row] = withFacts.recorder.rows();
    assert.equal(row.oldCode, "insufficient_scope");
    assert.equal(row.newCode, "insufficient_scope", "the ceiling gap keeps the old Scope family");
  } finally {
    await withFacts.close();
  }

  // The negative control: with no envelope the same request is a difference. A proof
  // that cannot fail proves nothing (§11.2).
  const withoutFacts = await harness.app({ feed: false });
  try {
    const response = await withoutFacts.call("write_note", { path: "note.md", content: "x" });
    assert.equal(response.status, 403, "legacy mode keeps the old answer either way");
    const summary = withoutFacts.recorder.summary();
    assert.equal(summary.differences, 1, "without the envelope the account grants would allow the write");
    assert.equal(withoutFacts.recorder.rows()[0].newAllowed, true);
  } finally {
    await withoutFacts.close();
  }
});

test("a_committed_epoch_above_zero_does_not_read_as_invalid_credential", async () => {
  // A credential issued AFTER the state committed epoch 3 carries that epoch: it passes.
  const current = await harness.app({ committed: 3, frozen: 3, feed: true });
  try {
    const response = await current.call("get_note", { path: "note.md" });
    assert.equal(response.status, 200, "the old gate allows the read");
    const summary = current.recorder.summary();
    assert.equal(summary.differences, 0, `the committed epoch must not differ: ${JSON.stringify(current.recorder.rows())}`);
    const [row] = current.recorder.rows();
    assert.equal(row.newAllowed, true);
    assert.notEqual(row.newCode, "invalid_credential", "the actor states the epoch the credential was issued with");
  } finally {
    await current.close();
  }

  // The control in the other direction, and the one that rules out a live backfill: a
  // credential issued at epoch 0 against a state that now commits 3 is stale, and reading
  // the committed epoch into the actor would silently re-validate it (design §7, §10-7).
  const stale = await harness.app({ committed: 3, frozen: 0, feed: true });
  try {
    const response = await stale.call("get_note", { path: "note.md" });
    assert.equal(response.status, 200, "legacy mode keeps the old answer either way");
    const [row] = stale.recorder.rows();
    assert.equal(row.newAllowed, false, "a credential older than the committed epoch is refused");
    assert.equal(row.newCode, "invalid_credential");
    assert.equal(stale.recorder.summary().differences, 1, "the old gate has no epoch, so this is a real difference");
  } finally {
    await stale.close();
  }
});
