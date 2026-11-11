// P0 / Task 1 Step 3 — the dedicated resource probe: WHICH Vault does a primary-only resource read?
//
// The design refuses to guess this (§11.3-3). A 200 alone cannot answer it, so this probe makes
// each Vault distinguishable — one file and one tag exist in exactly one Vault — and then reads all
// four resources with a primary-only token, a secondary-only token and a full token.
//
// P0 recorded the finding, and it was a real cross-Vault read: the three `obsidian://vault/*`
// handlers ran outside the Vault gate and answered content to a credential that holds only another
// Vault. The owner approved the tightening (design §11.3-3), and `fix/resource-vault-scope` repairs
// it in the canonical Vault registrar; this probe now pins the repaired answer. The four resource
// targets stay the primary Vault, and only a credential that holds the primary Vault may read them.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const env = await (await import("./helpers/permission-baseline-env.js")).seedPermissionBaselineEnv();
const {
  createPermissionPlane,
  observeCase,
  resourceRead,
} = await import("./helpers/permission-plane.js");
const { RESOURCE_URIS, observedVaultOf } = await import("./helpers/permission-baseline-collect.js");

test.after(async () => fs.rm(env.root, { recursive: true, force: true }));

test("a Vault resource reads the primary Vault, and only a credential that holds it may read it", async (t) => {
  const plane = await createPermissionPlane({ envKey: process.env.API_KEY, primaryVault: env.primary });
  t.after(() => plane.close());

  // Markers that exist in exactly one Vault, so the payload itself says who answered.
  await fs.writeFile(path.join(env.vaults, "vault", "note.md"), "---\ntags:\n  - primarytag\n---\n\n# Primary note\n", "utf8");
  await fs.writeFile(path.join(env.vaults, "vault", "primary-only-marker.md"), "# Only in the primary Vault\n", "utf8");
  await fs.writeFile(path.join(env.vaults, "alpha", "note.md"), "---\ntags:\n  - alphatag\n---\n\n# Alpha note\n", "utf8");
  await fs.writeFile(path.join(env.vaults, "alpha", "alpha-only-marker.md"), "# Only in the alpha Vault\n", "utf8");

  const provider = plane.provider;
  const user = await provider.createOAuthUser({
    username: "resource-probe",
    password: "resource-probe-password",
    displayName: "Resource Probe",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["vault", "alpha"],
  });
  await provider.clientsStore.registerClient({
    client_id: "resource-probe-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Resource Probe",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const resource = "http://127.0.0.1:18923/mcp";
  const credentials = {
    "oauth:primary-only": await provider.issueTokens("resource-probe-client", ["obsidian.read"], resource, user.id, ["vault"]),
    "oauth:secondary-only": await provider.issueTokens("resource-probe-client", ["obsidian.read"], resource, user.id, ["alpha"]),
    "oauth:full": await provider.issueTokens("resource-probe-client", ["obsidian.read"], resource, user.id, ["vault", "alpha"]),
  };

  const observed = [];
  for (const [actorCase, token] of Object.entries(credentials)) {
    const actor = { id: actorCase, headers: () => ({ Authorization: `Bearer ${token.access_token}` }) };
    for (const uri of RESOURCE_URIS) {
      const result = await observeCase(plane, { actor, request: resourceRead(uri), vaultRoot: env.vaults, targetCase: uri });
      observed.push({ actorCase, uri, allowed: result.allowed, status: result.status, payload: result.payload, read: observedVaultOf(uri, result.payload) });
    }
  }

  const rowsOf = (actorCase) => observed.filter((entry) => entry.actorCase === actorCase);

  // 1. The approved tightening (design §11.3-3): a credential that holds ONLY the secondary Vault
  //    is refused on all three Vault resources, before any content is read. `obsidian://agent/
  //    memory-policy` holds no Vault content and stays readable.
  const secondaryOnly = rowsOf("oauth:secondary-only");
  assert.deepEqual(secondaryOnly.map((entry) => entry.allowed), [false, false, false, true], "the three Vault resources are refused, the instance resource is not");
  for (const uri of ["obsidian://vault/index", "obsidian://vault/tags", "obsidian://vault/graph"]) {
    const entry = secondaryOnly.find((candidate) => candidate.uri === uri);
    assert.equal(entry.read, "undetermined", `${uri} answers no Vault content`);
    assert.doesNotMatch(entry.payload, /primary-only-marker\.md/, `${uri} leaks no file of the primary Vault`);
    assert.doesNotMatch(entry.payload, /alpha-only-marker\.md/, `${uri} leaks no file of the secondary Vault either`);
    assert.match(entry.payload, /vault_access_denied/, `${uri} states the refusal code`);
  }
  const policy = secondaryOnly.find((entry) => entry.uri === "obsidian://agent/memory-policy");
  assert.equal(policy.read, "instance", "the memory-policy resource stays instance-level");

  // 2. The same answer for the other two credentials: the resource plane never consults the token's
  //    Vault set. Same rows, same Vault — that is what makes it a rule, not an accident.
  for (const actorCase of ["oauth:primary-only", "oauth:full"]) {
    for (const uri of RESOURCE_URIS) {
      const entry = observed.find((candidate) => candidate.actorCase === actorCase && candidate.uri === uri);
      assert.equal(entry.allowed, true, `${actorCase} may read ${uri}`);
      assert.equal(entry.read, uri === "obsidian://agent/memory-policy" ? "instance" : "primary", `${uri} reads the primary Vault for ${actorCase}`);
    }
  }

  // 3. The memory-policy resource is instance-level: no Vault marker, no Vault answer.
  const policyRow = observed.find((entry) => entry.uri === "obsidian://agent/memory-policy");
  assert.doesNotMatch(policyRow.payload, /primarytag|alphatag|primary-only-marker/, "the memory-policy resource holds no Vault content");
});

test("the committed baseline records the answer for every resource row", async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(here, "fixtures", "permission-architecture", "baseline.json"), "utf8"));
  const resourceRows = baseline.rows.filter((row) => row.surface === "mcp-resource" && row.actorCase !== "anonymous");
  assert.equal(resourceRows.length, 12, "4 resources x 3 credentials");
  const VAULT_RESOURCES = new Set(["obsidian://vault/index", "obsidian://vault/tags", "obsidian://vault/graph"]);
  for (const row of resourceRows) {
    // The owner-approved tightening (design §11.3-3): a credential that holds only another Vault
    // is refused on the Vault resources, by the gate and before any handler. Every other row keeps
    // its recorded answer.
    const refused = row.actorCase === "oauth:secondary-only" && VAULT_RESOURCES.has(row.capability);
    if (refused) {
      assert.equal(row.allowed, false, `${row.actorCase} must not read ${row.capability}`);
      assert.equal(row.errorFamily, "vault_access_denied");
      assert.equal(row.denialPoint, "operation_gate");
      assert.equal(row.handlerCalls, 0, "a refused resource read runs no handler");
      assert.equal(row.targetVaultObserved, "undetermined");
      continue;
    }
    assert.equal(row.allowed, true, `${row.actorCase} may read ${row.capability}`);
    const expected = row.capability === "obsidian://agent/memory-policy" ? "instance" : "primary";
    assert.equal(row.targetVaultObserved, expected, `${row.actorCase} ${row.capability} is recorded as reading ${row.targetVaultObserved}`);
  }
});
