// C4 (#668) — `graph_health` can propose reviewable link repairs, and never performs one.
//
// Contract of this cut (the plan fixes the interface):
//   * `includeProposals: true` adds `proposals: [{ sourcePath, targetPath?, evidence, reason,
//     expectedRevision, risk, proposedDiff? }]`; without it the payload is unchanged;
//   * a proposal is EVIDENCE, not an action: nothing here writes, commits or journals;
//   * an ambiguous link target is reported as ambiguity (candidates), never as a choice —
//     no semantic similarity, no alias guess;
//   * `expectedRevision` is the source note's real `sha256:` revision, i.e. exactly the
//     `baseRevision` that `plan_note_changes` consumes, so a stale proposal is refused by the
//     plan layer's CAS instead of being applied;
//   * the repair itself stays on the existing reviewed path
//     `plan_note_changes` -> `apply_note_plan` with a user approval;
//   * a proposal never names a path outside the selected Vault.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-c4-graph-proposals-"));
const VAULT = path.join(ROOT, "vault");
const DATA = path.join(ROOT, "data");
const SECONDARY_VAULT = path.join(ROOT, "vault-secondary");

process.env.VAULT_PATH = VAULT;
process.env.DATA_PATH = DATA;
process.env.HISTORY_PATH = path.join(DATA, "history");
process.env.TRASH_PATH = path.join(DATA, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const HUB = "hub.md";
const HUB_LINKS = [
  "[[shared-alias]]", // 1. one alias, two notes   -> ambiguous
  "[[Topic]]", // 2. one basename, two notes -> ambiguous
  "[[weekly  review]]", // 3. whitespace near-miss with two candidates -> ambiguous
  "[[deploy  guide]]", // 4. whitespace near-miss with exactly one candidate -> repair
  "[[Nonexistent Topic]]", // 5. no candidate at all -> nothing may be proposed
];

const NOTES = {
  "Alias/A Holder.md": "---\naliases: [shared-alias]\n---\n# A Holder\n",
  "Alias/B Holder.md": "---\naliases: [shared-alias]\n---\n# B Holder\n",
  "Dup/One/Topic.md": "# Topic one\n",
  "Dup/Two/Topic.md": "# Topic two\n",
  "Spacing/Weekly Review.md": "# Weekly Review\n",
  "Spacing/Weekly   Review.md": "# Weekly three spaces\n",
  "Guides/Deploy Guide.md": "# Deploy Guide\n",
  // Semantically close to link 5, textually different on purpose: similarity is not evidence.
  "Semantic/Nonexistent Topic Notes.md": "# Nonexistent Topic Notes\n",
  [HUB]: `# Hub\n\n${HUB_LINKS.join("\n")}\n`,
};

async function writeTree(root, files) {
  for (const [relative, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), body, "utf8");
  }
}
await fs.mkdir(DATA, { recursive: true });
await writeTree(VAULT, NOTES);
// A second Vault carries the tempting paths: the same alias twice would be ambiguous there, and
// its own `Deploy Guide` is spelled differently, so a leaked record is visible either way.
await writeTree(SECONDARY_VAULT, {
  "Alias/Only.md": "---\naliases: [shared-alias]\n---\n# Only\n",
  "Second/Deploy Guide.md": "# Deploy Guide secondary\n",
  "Second/hub.md": "# Secondary Hub\n\n[[shared-alias]]\n[[deploy  guide]]\n",
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revisionOf = async (relative) => `sha256:${sha256(await fs.readFile(path.join(VAULT, relative)))}`;

const { registerIntelligenceTools } = await import("../src/tools/intelligence.js");
const { createMemoryGuidanceRegistrar } = await import("../src/memory-guidance.js");
const { registerPlanTools } = await import("../src/tools/plans.js");
const { withRequestContext } = await import("../src/request-context.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { vaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { MCP_TOOL_SCOPE_REQUIREMENTS } = await import("../src/scopes.js");

after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

async function withClient(callback) {
  const server = new McpServer({ name: "c4-graph-proposals", version: "1" });
  // The same wrapper `registerObsidianCapabilities` puts outside the tool modules: it stamps the
  // request author, which the plan/apply path requires. No access, scope or Vault layers are added,
  // so the Vault selection under test is the request context alone.
  const registrar = createMemoryGuidanceRegistrar(server);
  registerIntelligenceTools(registrar);
  registerPlanTools(registrar);
  const client = new Client({ name: "c4-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const author = { agent: "c4-client", model: "test" };
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args, _meta: { "obsidian/author": author } });
    return { isError: result.isError === true, structured: result.structuredContent, text: result.content?.[0]?.text };
  };
  const ok = async (name, args) => {
    const { isError, structured, text } = await call(name, args);
    assert.equal(isError, false, `${name} failed: ${text}`);
    return structured;
  };
  try {
    return await callback({ ok, call });
  } finally {
    await client.close();
    await server.close();
  }
}

const proposalsFor = (health, raw) => health.proposals.filter((proposal) => proposal.evidence.raw === raw);

/** Every file under `dir` with its bytes and mtime: a write anywhere changes this digest. */
async function treeSnapshot(dir) {
  const entries = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) { entries.push(`d ${path.relative(dir, absolute)}`); await walk(absolute); continue; }
      const info = await fs.stat(absolute);
      entries.push(`f ${path.relative(dir, absolute)} ${info.size} ${info.mtimeMs} ${sha256(await fs.readFile(absolute))}`);
    }
  }
  await walk(dir);
  return entries.sort();
}

const WRITE_CALLS = Object.freeze(["writeFile", "appendFile", "rename", "unlink", "rm", "rmdir", "mkdir", "copyFile", "cp", "symlink", "link", "truncate", "utimes", "chmod"]);

async function countWrites(callback) {
  const original = new Map();
  const calls = [];
  for (const name of WRITE_CALLS) {
    const value = fsPromises[name];
    if (typeof value !== "function") continue;
    original.set(name, value);
    fsPromises[name] = (...args) => { calls.push(`${name}(${String(args[0])})`); return value(...args); };
  }
  let error = null;
  try { await callback(); } catch (caught) { error = caught; }
  finally { for (const [name, value] of original) fsPromises[name] = value; }
  if (error) throw error;
  return calls;
}

// -------------------------------------------------------------------------------------------------
// 1. The audit stays a read: no write, no journal, no git, no mutation of any kind
// -------------------------------------------------------------------------------------------------

test("the proposal query writes nothing at all: no mutation, journal entry, or new file", async () => {
  const vaultBefore = await treeSnapshot(VAULT);
  const dataBefore = await treeSnapshot(DATA);
  const writes = await countWrites(() => withClient(async ({ ok }) => {
    const health = await ok("graph_health", { includeProposals: true, includeDetails: true });
    assert.ok(health.proposals.length > 0, "the fixture must produce proposals, or this proof proves nothing");
    // Deterministic: a second identical query answers the same bytes.
    assert.deepEqual(await ok("graph_health", { includeProposals: true, includeDetails: true }), health);
  }));
  assert.deepEqual(writes, [], "the query path must not even attempt a write");
  assert.deepEqual(await treeSnapshot(VAULT), vaultBefore, "no Vault file may change");
  assert.deepEqual(await treeSnapshot(DATA), dataBefore, "no journal / history / index file may appear or change");
  await assert.rejects(() => fs.stat(path.join(DATA, "mutation-journal")), { code: "ENOENT" }, "a query must not create the mutation journal");
});

// -------------------------------------------------------------------------------------------------
// 2. Opt-in shape
// -------------------------------------------------------------------------------------------------

test("includeProposals is opt-in: the default answer keeps its historical shape", async () => {
  await withClient(async ({ ok }) => {
    const plain = await ok("graph_health", { includeDetails: true });
    assert.equal(Object.hasOwn(plain, "proposals"), false, "the default payload must not gain a field");
    const asked = await ok("graph_health", { includeProposals: true, includeDetails: true });
    assert.ok(Array.isArray(asked.proposals), "includeProposals returns an array");
    for (const proposal of asked.proposals) {
      assert.equal(typeof proposal.sourcePath, "string");
      assert.equal(typeof proposal.reason, "string");
      assert.equal(typeof proposal.risk, "string");
      assert.match(proposal.expectedRevision, /^sha256:[0-9a-f]{64}$/);
      assert.equal(typeof proposal.evidence, "object");
    }
    // Proposals never restate the audit: notes / links / counts / issues stay exactly as before.
    const stripped = { ...asked };
    delete stripped.proposals;
    delete stripped.truncated;
    const plainStripped = { ...plain };
    delete plainStripped.truncated;
    assert.deepEqual({ ...stripped, truncated: false }, { ...plainStripped, truncated: false });
  });
});

// -------------------------------------------------------------------------------------------------
// 3. The three ambiguity cases: evidence, never a choice
// -------------------------------------------------------------------------------------------------

test("an ambiguous alias is reported as evidence, never as a chosen target", async () => {
  await withClient(async ({ ok }) => {
    const health = await ok("graph_health", { includeProposals: true });
    const [proposal, ...rest] = proposalsFor(health, "[[shared-alias]]");
    assert.equal(rest.length, 0, "one proposal per broken link");
    assert.equal(Object.hasOwn(proposal, "targetPath"), false, "two notes could be the target: no choice is made");
    assert.equal(Object.hasOwn(proposal, "proposedDiff"), false, "an unresolved-choice proposal has no diff");
    assert.equal(proposal.sourcePath, HUB);
    assert.equal(proposal.reason, "ambiguous_link_target");
    assert.equal(proposal.risk, "high", "acting without reading the evidence is a guess");
    assert.equal(proposal.evidence.match, "alias");
    assert.deepEqual(proposal.evidence.candidates, ["Alias/A Holder.md", "Alias/B Holder.md"]);
    assert.equal(proposal.expectedRevision, await revisionOf(HUB));
  });
});

test("a duplicate basename is reported as evidence, never as a chosen target", async () => {
  await withClient(async ({ ok }) => {
    const health = await ok("graph_health", { includeProposals: true });
    const [proposal] = proposalsFor(health, "[[Topic]]");
    assert.equal(Object.hasOwn(proposal, "targetPath"), false);
    assert.equal(proposal.reason, "ambiguous_link_target");
    assert.equal(proposal.evidence.match, "basename");
    assert.deepEqual(proposal.evidence.candidates, ["Dup/One/Topic.md", "Dup/Two/Topic.md"]);
  });
});

test("a whitespace near-miss with two candidates is reported as evidence, never as a chosen target", async () => {
  await withClient(async ({ ok }) => {
    const health = await ok("graph_health", { includeProposals: true });
    const [proposal] = proposalsFor(health, "[[weekly  review]]");
    assert.equal(Object.hasOwn(proposal, "targetPath"), false);
    assert.equal(proposal.reason, "ambiguous_link_target");
    assert.equal(proposal.evidence.match, "collapsed-name");
    assert.deepEqual(proposal.evidence.candidates, ["Spacing/Weekly   Review.md", "Spacing/Weekly Review.md"]);
  });
});

// -------------------------------------------------------------------------------------------------
// 4. The one deterministic repair: exactly one candidate
// -------------------------------------------------------------------------------------------------

test("a whitespace near-miss with exactly one candidate proposes that note and its diff", async () => {
  await withClient(async ({ ok }) => {
    const health = await ok("graph_health", { includeProposals: true });
    const [proposal] = proposalsFor(health, "[[deploy  guide]]");
    assert.equal(proposal.targetPath, "Guides/Deploy Guide.md", "the single collapsed-name match is the target");
    assert.equal(proposal.reason, "link_target_spelling");
    assert.equal(proposal.risk, "low", "one deterministic candidate: no judgement is needed");
    assert.equal(proposal.expectedRevision, await revisionOf(HUB));
    assert.match(proposal.proposedDiff, /-\[\[deploy {2}guide\]\]/);
    assert.match(proposal.proposedDiff, /\+\[\[Deploy Guide\]\]/);
  });
});

test("no proposal is invented from semantic similarity", async () => {
  await withClient(async ({ ok }) => {
    const health = await ok("graph_health", { includeProposals: true });
    assert.deepEqual(proposalsFor(health, "[[Nonexistent Topic]]"), [], "a broken link with no candidate has no safe repair");
    const named = health.proposals.map((proposal) => proposal.targetPath).filter(Boolean);
    assert.equal(named.includes("Semantic/Nonexistent Topic Notes.md"), false, "a similar-looking note is never a target");
    assert.deepEqual([...new Set(health.proposals.map((proposal) => proposal.reason))].sort(), ["ambiguous_link_target", "link_target_spelling"]);
  });
});

// -------------------------------------------------------------------------------------------------
// 5. Cross-Vault isolation and the read-only identity
// -------------------------------------------------------------------------------------------------

test("a proposal never names a path outside the selected Vault", async () => {
  const secondary = createVaultRuntime({
    descriptor: { id: "secondary", name: "secondary", root: SECONDARY_VAULT, primary: false, writable: true },
    paths: vaultDataPaths({ primary: false, dataRoot: DATA, dataKey: vaultDataKey("secondary") }),
    deps: { requireRequestAuthor: () => ({ agent: "c4", model: "test" }) },
  });
  await withClient(async ({ ok }) => {
    const secondaryAnswers = await withRequestContext({ vaultId: "secondary", vaultRuntime: secondary }, () => ok("graph_health", { includeProposals: true }));
    const secondaryProposals = secondaryAnswers.proposals;
    assert.ok(secondaryProposals.length > 0);
    // The secondary Vault has ONE `shared-alias` holder, so that link resolves there: no proposal.
    assert.deepEqual(secondaryProposals.filter((proposal) => proposal.evidence.raw === "[[shared-alias]]"), []);
    const [deploy] = secondaryProposals.filter((proposal) => proposal.evidence.raw === "[[deploy  guide]]");
    assert.equal(deploy.targetPath, "Second/Deploy Guide.md", "the target is this Vault's note");
    assert.ok(secondaryProposals.every((proposal) => proposal.sourcePath === "Second/hub.md"));

    const primary = await ok("graph_health", { includeProposals: true });
    const primaryPaths = new Set(primary.proposals.flatMap((proposal) => [proposal.sourcePath, proposal.targetPath, ...(proposal.evidence.candidates || [])]).filter(Boolean));
    for (const leaked of ["Second/Deploy Guide.md", "Second/hub.md", "Alias/Only.md"]) {
      assert.equal(primaryPaths.has(leaked), false, `a primary proposal must not name the secondary Vault's ${leaked}`);
    }
    const secondaryPaths = new Set(secondaryProposals.flatMap((proposal) => [proposal.sourcePath, proposal.targetPath, ...(proposal.evidence.candidates || [])]).filter(Boolean));
    for (const leaked of ["Alias/A Holder.md", "Alias/B Holder.md", "Guides/Deploy Guide.md"]) {
      assert.equal(secondaryPaths.has(leaked), false, `a secondary proposal must not name the primary Vault's ${leaked}`);
    }
  });
});

test("a read-only identity gets the same proposals and cannot apply them", async () => {
  assert.deepEqual(MCP_TOOL_SCOPE_REQUIREMENTS.graph_health, ["obsidian.read"], "reading proposals needs no write scope");
  assert.ok(MCP_TOOL_SCOPE_REQUIREMENTS.apply_note_plan.includes("obsidian.write"), "executing a repair needs the write scope");
  assert.equal(MCP_TOOL_SCOPE_REQUIREMENTS.plan_note_changes.includes("obsidian.write"), false, "planning stays side-effect free");
  await withClient(async ({ ok }) => {
    const answered = await ok("graph_health", { includeProposals: true });
    assert.ok(answered.proposals.length > 0);
  });
});

// -------------------------------------------------------------------------------------------------
// 6. CAS: a stale proposal is refused by the plan layer, the source note stays byte-identical
// -------------------------------------------------------------------------------------------------

test("expectedRevision is the real revision, so a stale proposal is refused by the plan CAS", async () => {
  await withClient(async ({ ok, call }) => {
    const health = await ok("graph_health", { includeProposals: true });
    const [proposal] = proposalsFor(health, "[[deploy  guide]]");
    const replacement = { search: "[[deploy  guide]]", replace: "[[Deploy Guide]]", replaceAll: true };

    // The reviewer edits the note before approving: the proposal is now stale.
    await fs.appendFile(path.join(VAULT, HUB), "\nan external edit\n", "utf8");
    const staleBytes = await fs.readFile(path.join(VAULT, HUB));
    const refused = await call("plan_note_changes", { changes: [{ path: HUB, operation: "replace", baseRevision: proposal.expectedRevision, replacements: [replacement] }] });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Revision conflict: expected sha256:/, `the plan layer, not the proposal, refuses the stale revision; got: ${refused.text}`);
    assert.deepEqual(await fs.readFile(path.join(VAULT, HUB)), staleBytes, "a refused plan leaves the note byte-identical");

    // With the CURRENT revision the same proposal plans, and applying it repairs the link.
    const fresh = await ok("graph_health", { includeProposals: true });
    const [current] = proposalsFor(fresh, "[[deploy  guide]]");
    assert.equal(current.expectedRevision, await revisionOf(HUB));
    const plan = await ok("plan_note_changes", { changes: [{ path: HUB, operation: "replace", baseRevision: current.expectedRevision, replacements: [replacement] }] });
    assert.match(plan.changes[0].diff, /-\[\[deploy {2}guide\]\]/);
    assert.deepEqual(await fs.readFile(path.join(VAULT, HUB)), staleBytes, "planning is still side-effect free");

    const applied = await ok("apply_note_plan", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: "c4-repair-0001" });
    assert.equal(applied.applied, true);
    assert.match(await fs.readFile(path.join(VAULT, HUB), "utf8"), /\[\[Deploy Guide\]\]/);
    const after = await ok("graph_health", { includeProposals: true });
    assert.deepEqual(proposalsFor(after, "[[deploy  guide]]"), [], "the repaired link is no longer a proposal");
  });
});
