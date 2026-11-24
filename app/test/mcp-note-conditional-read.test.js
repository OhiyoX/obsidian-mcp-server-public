// O5 — explicit, revision-aware conditional reads for `get_note`.
//
// Contract: a caller that passes `ifRevision` gets the tiny
// `{ path, revision, notModified: true }` answer **only** when that revision still matches the
// current source revision of the note the caller is authorized to read. Every other case keeps
// today's full response, byte for byte:
//   * a stale revision         -> the full note (same object, same pretty text);
//   * a missing / renamed path -> the same error as today;
//   * a refused Vault scope    -> the registrar refusal, never `notModified`;
//   * the same path in another Vault -> the *other* Vault's note, never a cross-hit;
//   * no `ifRevision`          -> the frozen full-note shape.
//
// Ordering rule: the comparison happens *after* authorization. Each Vault admission refusal below
// carries a revision that really matches, so a passing test proves the deny answered first.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-o5-conditional-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";

for (const root of [PRIMARY_ROOT, SECONDARY_ROOT, DATA_ROOT]) await fs.mkdir(root, { recursive: true });

// Same path, two Vaults, different bytes: the cross-Vault probe.
const SHARED_NOTE = "shared/note.md";
const PRIMARY_BODY = "# Shared\n\nprimary-only-marker alpha\n";
const SECONDARY_BODY = "# Shared\n\nsecondary-only-marker alpha\n";
await fs.mkdir(path.join(PRIMARY_ROOT, "shared"), { recursive: true });
await fs.mkdir(path.join(SECONDARY_ROOT, "shared"), { recursive: true });
await fs.writeFile(path.join(PRIMARY_ROOT, SHARED_NOTE), PRIMARY_BODY, "utf8");
await fs.writeFile(path.join(SECONDARY_ROOT, SHARED_NOTE), SECONDARY_BODY, "utf8");

const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");
const { requireRequestAuthor } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { registerNoteTools } = await import("../src/tools/notes.js");

const sha256Revision = (text) => `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
const bytes = (text) => Buffer.byteLength(text, "utf8");

const newMap = async () => {
  const map = createVaultRuntimeMap({
    registry: createVaultRegistry({ primaryRoot: PRIMARY_ROOT, primaryId: DEFAULT_VAULT_ID, vaultsRoot: VAULTS_ROOT, writable: true }),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor },
  });
  await map.refresh();
  return map;
};

const vaultScopeOf = (map) => ({ resolveVaultRuntime: (id) => map.get(id), vaultExists: (id) => map.has(id) });

/** Real MCP server (every capability) through the real registrars, driven by the real SDK. */
async function withServer(vaultScope, callback, serverName = "o5-conditional-read") {
  const server = new McpServer({ name: serverName, version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope });
  const client = new Client({ name: serverName, version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, structured: result.structuredContent, text: result.content[0].text };
  };
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert.equal(result.isError, false, `${name} failed: ${result.text}`);
    return result;
  };
  try {
    return await callback({ call, ok });
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Fake-server chain: the real Vault-scope registrar over a collecting server, with the real
 * `get_note` handler behind it. It is the only way to state `authInfo` in-process, so it is where
 * the authorization ordering is proven.
 */
function noteChain({ resolveVaultRuntime, vaultExists }) {
  const tools = new Map();
  const collecting = {
    getClientVersion: () => ({ name: "o5-chain", version: "0.0.0" }),
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
  };
  const registrar = createVaultScopeRegistrar(collecting, { resolveVaultRuntime, vaultExists });
  registerNoteTools(registrar);
  return (args, extra) => tools.get("get_note").handler(args, extra);
}

const apiKeyExtra = (allowedVaults) => ({
  authInfo: { type: "api-key", keyId: "o5-key", scopes: ["obsidian.read"], allowedVaults },
});

test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

// -------------------------------------------------------------------------------------------------
// 1. A matching revision answers the tiny shape
// -------------------------------------------------------------------------------------------------

test("a matching ifRevision answers { path, revision, notModified: true } and no body", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const full = await ok("get_note", { path: SHARED_NOTE });
    assert.equal(full.structured.revision, sha256Revision(PRIMARY_BODY), "the revision is the source bytes' hash");

    const conditional = await ok("get_note", { path: SHARED_NOTE, ifRevision: full.structured.revision });
    assert.deepEqual(conditional.structured, { path: SHARED_NOTE, revision: full.structured.revision, notModified: true });
    assert.deepEqual(Object.keys(conditional.structured).sort(), ["notModified", "path", "revision"]);
    for (const bodyField of ["content", "frontmatter", "tags", "stat", "outgoingLinks", "cache"]) {
      assert.equal(bodyField in conditional.structured, false, `the compressed answer must not carry ${bodyField}`);
    }
    // The O2 default text encoding is unchanged: pretty JSON of the same object.
    assert.equal(conditional.text, JSON.stringify(conditional.structured, null, 2));
    // Measured sizes for the report: the answer is not a note.
    // 142 bytes: the revision hash dominates the answer, which carries no note at all.
    assert.ok(bytes(conditional.text) <= 200, `notModified text was ${bytes(conditional.text)} bytes`);
    assert.ok(bytes(full.text) > 300, `full note text was ${bytes(full.text)} bytes`);
    assert.ok(bytes(conditional.text) * 2 < bytes(full.text), "the conditional answer must be far smaller than the note");
  });
});

test("a matching ifRevision compresses a format=content read too, and still sends no body", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const revision = (await ok("get_note", { path: SHARED_NOTE, format: "content" })).structured.revision;
    const conditional = await ok("get_note", { path: SHARED_NOTE, format: "content", ifRevision: revision });
    assert.deepEqual(conditional.structured, { path: SHARED_NOTE, revision, notModified: true });
    assert.equal("content" in conditional.structured, false);
  });
});

// -------------------------------------------------------------------------------------------------
// 2. Anything else stays today's answer, byte for byte
// -------------------------------------------------------------------------------------------------

test("a stale ifRevision returns the full note, byte for byte as without it", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const stale = (await ok("get_note", { path: SHARED_NOTE })).structured.revision;
    await fs.writeFile(path.join(PRIMARY_ROOT, SHARED_NOTE), `${PRIMARY_BODY}\nanother line\n`, "utf8");
    try {
      const plain = await ok("get_note", { path: SHARED_NOTE });
      const conditional = await ok("get_note", { path: SHARED_NOTE, ifRevision: stale });
      assert.notEqual(plain.structured.revision, stale, "the source really changed");
      assert.equal("notModified" in conditional.structured, false);
      assert.deepEqual(conditional.structured, plain.structured);
      assert.equal(conditional.text, plain.text);
      assert.match(conditional.structured.content, /another line/);
    } finally {
      await fs.writeFile(path.join(PRIMARY_ROOT, SHARED_NOTE), PRIMARY_BODY, "utf8");
    }
  });
});

test("a missing or renamed path errors as today, even with a matching revision", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ call, ok }) => {
    const revision = (await ok("get_note", { path: SHARED_NOTE })).structured.revision;

    const missing = await call("get_note", { path: "shared/missing.md", ifRevision: revision });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /^Error: /);
    assert.equal(missing.structured, undefined, "a refusal carries no notModified payload");

    await fs.rename(path.join(PRIMARY_ROOT, SHARED_NOTE), path.join(PRIMARY_ROOT, "shared/renamed.md"));
    try {
      const renamed = await call("get_note", { path: SHARED_NOTE, ifRevision: revision });
      assert.equal(renamed.isError, true);
      assert.match(renamed.text, /^Error: /);
      assert.equal(renamed.structured, undefined);
    } finally {
      await fs.rename(path.join(PRIMARY_ROOT, "shared/renamed.md"), path.join(PRIMARY_ROOT, SHARED_NOTE));
    }
  });
});

test("a call without ifRevision returns the frozen full-note shape", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const plain = await ok("get_note", { path: SHARED_NOTE });
    assert.deepEqual(Object.keys(plain.structured), ["path", "frontmatter", "content", "tags", "stat", "revision", "outgoingLinks"]);
    const { stat, ...rest } = plain.structured;
    assert.deepEqual(rest, {
      path: SHARED_NOTE,
      frontmatter: {},
      content: PRIMARY_BODY,
      tags: [],
      revision: sha256Revision(PRIMARY_BODY),
      outgoingLinks: [],
    });
    assert.deepEqual(Object.keys(stat), ["size", "created", "modified"]);
    assert.equal(stat.size, bytes(PRIMARY_BODY));
    assert.equal(new Date(stat.created).toISOString(), stat.created);
    assert.equal(new Date(stat.modified).toISOString(), stat.modified);
    assert.equal(plain.text, JSON.stringify(plain.structured, null, 2), "the default text encoding is unchanged");
  });
});

// -------------------------------------------------------------------------------------------------
// 3. Never a cross-Vault hit
// -------------------------------------------------------------------------------------------------

test("the same path in two Vaults never cross-hits: another Vault's revision answers with its note", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const primaryRevision = (await ok("get_note", { path: SHARED_NOTE })).structured.revision;
    const secondary = await ok("get_note", { vaultId: SECONDARY, path: SHARED_NOTE });
    assert.equal(secondary.structured.revision, sha256Revision(SECONDARY_BODY), "the other Vault owns the other revision");
    assert.notEqual(secondary.structured.revision, primaryRevision);

    // The primary's revision, spent on the secondary selection, must not short-circuit the read.
    const crossed = await ok("get_note", { vaultId: SECONDARY, path: SHARED_NOTE, ifRevision: primaryRevision });
    assert.equal("notModified" in crossed.structured, false, "a revision from another Vault must not answer notModified");
    assert.equal(crossed.structured.content, SECONDARY_BODY);
    assert.equal(crossed.structured.revision, secondary.structured.revision);

    // ... while the secondary's own revision still short-circuits inside the secondary Vault.
    const conditional = await ok("get_note", { vaultId: SECONDARY, path: SHARED_NOTE, ifRevision: secondary.structured.revision });
    assert.deepEqual(conditional.structured, { path: SHARED_NOTE, revision: secondary.structured.revision, notModified: true });

    // The reverse direction: the secondary's revision is stale for the primary.
    const reverse = await ok("get_note", { path: SHARED_NOTE, ifRevision: secondary.structured.revision });
    assert.equal("notModified" in reverse.structured, false);
    assert.equal(reverse.structured.content, PRIMARY_BODY);
  });
});

// -------------------------------------------------------------------------------------------------
// 4. Authorization comes first
// -------------------------------------------------------------------------------------------------

test("a revoked Vault scope refuses before the revision is compared", async () => {
  const map = await newMap();
  const callNote = noteChain({ resolveVaultRuntime: (id) => map.get(id), vaultExists: (id) => map.has(id) });
  const revision = (await callNote({ path: SHARED_NOTE }, {})).structuredContent.revision;
  assert.equal(revision, sha256Revision(PRIMARY_BODY), "the revision used below really matches");

  // Positive control: the same call with the secondary in the credential's Vault scope answers.
  const allowed = await callNote({ vaultId: SECONDARY, path: SHARED_NOTE, ifRevision: revision }, apiKeyExtra([DEFAULT_VAULT_ID, SECONDARY]));
  assert.equal(allowed.isError, undefined);
  assert.equal(allowed.structuredContent.content, SECONDARY_BODY, "the allowed call reads the selected Vault");

  // Revoked: the credential's Vault scope no longer names the selected Vault.
  const denied = await callNote({ vaultId: SECONDARY, path: SHARED_NOTE, ifRevision: revision }, apiKeyExtra([DEFAULT_VAULT_ID]));
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.structuredContent, { code: "vault_access_denied", vaultId: SECONDARY });
  assert.equal("notModified" in denied.structuredContent, false);
});

test("a selected Vault without a materialized runtime refuses before the revision is compared", async () => {
  const map = await newMap();
  const callNote = noteChain({
    resolveVaultRuntime: (id) => (id === DEFAULT_VAULT_ID ? primaryRuntime : undefined),
    vaultExists: () => true,
  });
  const revision = (await callNote({ path: SHARED_NOTE }, {})).structuredContent.revision;
  assert.equal(revision, sha256Revision(PRIMARY_BODY), "the revision used below really matches");

  const unavailable = await callNote({ vaultId: SECONDARY, path: SHARED_NOTE, ifRevision: revision }, apiKeyExtra([DEFAULT_VAULT_ID, SECONDARY]));
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /^Error: \[vault_unavailable\]/);
  assert.equal(unavailable.structuredContent, undefined);
  assert.equal(map.get(DEFAULT_VAULT_ID) !== undefined, true, "the primary runtime exists; the refusal is about the selection");
});
