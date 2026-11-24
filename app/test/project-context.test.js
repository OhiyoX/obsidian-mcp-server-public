import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// C1 (Agent Context plan): an EXPLICIT project-root context. The caller names the
// root; nothing is guessed, no Vault-wide scan, no fallback to the primary Vault.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-project-context-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

async function write(relative, content) {
  const abs = path.join(vault, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

const FILLER = "This paragraph exists to make a full read expensive: a chained search plus read of every file returns all of this text. ".repeat(40);

await write("README.md", `---\ntitle: Vault Home\ntype: project\n---\n# Vault Home\n\nTop-level entry note.\n\n${FILLER}\n`);
await write("AGENTS.md", `# Vault Agent Rules\n\nRead the conventions before you edit.\n\n${FILLER}\n`);

await write("Projects/Alpha/README.md", `---\ntitle: Alpha Project\ntype: project\ntags: [alpha, context]\n---\n# Alpha Project\n\nAlpha is the reference project for the bounded context fixture.\n\n## Goal\n\nShip one call that answers "what is this project".\n\n## Layout\n\n- notes/ holds prose\n\n${FILLER}\n`);
await write("Projects/Alpha/CONVENTIONS.md", `# Alpha Conventions\n\nWrite in Simplified Technical English.\n\n## Naming\n\nOne folder per deliverable.\n\n${FILLER}\n`);
await write("Projects/Alpha/TODO.md", `# Alpha TODO\n\n- [ ] Ship the bounded project context\n- [x] Done checkbox item that must not appear\n- [-] Cancelled checkbox item that must not appear\n\n## Next\n\n- [ ] Write the C1 report\n\n## Done\n\n- [ ] Open box under a Done heading must not appear\n\n## History\n\n- [ ] Open box under a History heading must not appear\n`);
await write("Projects/Alpha/Project.base", "views:\n  - name: 进行中\n  - name: 已完成\n");
await write("Projects/Alpha/notes/Design.md", "# Design\n\nA nested folder without a README is not a project root.\n");

await write("Projects/Nest/README.md", "# Nest Project\n\nThe outer root wins.\n");
await write("Projects/Nest/Child/README.md", "# Nest Child\n\nA nested project root.\n");
await write("Projects/Nest/Child/TODO.md", "- [ ] Nested root item that must not be merged\n");

await write("Projects/Many/README.md", "# Many README markdown\n");
await write("Projects/Many/README.txt", "Many README plain text\n");

await write("Projects/None/TODO.md", "# None TODO\n\n- [ ] Item in a project without a README\n");

await write("Projects/Broken/README.md", "# Broken Base Project\n");
await write("Projects/Broken/Project.base", "views: [unclosed\n");

const { buildNoteContext, buildProjectContext, OUTPUT_BUDGET_TOO_SMALL } = await import("../src/context-service.js");
const { registerContextTools } = await import("../src/tools/context.js");
const { createMemoryGuidanceRegistrar } = await import("../src/memory-guidance.js");
const { withRequestContext } = await import("../src/request-context.js");
const { primaryRuntime } = await import("../src/vault.js");
const { SEARCH_RUNTIME_REFUSED } = await import("../src/search-runtimes.js");
const { createRuntimeLease, createLeasedRuntime, revokeRuntimeLease, VAULT_RUNTIME_LEASE_REVOKED } = await import("../src/vault-runtime/runtime-lease.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withContextClient(callback) {
  const server = new McpServer({ name: "project-context-test", version: "1" });
  registerContextTools(createMemoryGuidanceRegistrar(server));
  const client = new Client({ name: "project-context-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function warningCodes(result) {
  return result.warnings.map((warning) => warning.code);
}

function assertProvenance(result) {
  assert.equal(result.scope, "project");
  assert.equal(result.policy.source, "server");
  assert.equal(result.sources.length, result.items.length);
  assert.equal(result.budget.counting, "vault-text-codepoints");
  assert.ok(result.budget.usedChars <= result.budget.maxChars);
  for (const item of result.items) {
    assert.equal(typeof item.path, "string");
    assert.ok(item.path.length > 0);
    assert.equal(item.trust, "untrusted_reference");
    assert.equal(typeof item.reason, "string");
    assert.ok(Object.hasOwn(item, "revision"), "every item declares a revision (null when unknown)");
    assert.equal(Object.hasOwn(item, "content"), false);
    assert.equal(Object.hasOwn(item, "raw"), false);
  }
  for (const source of result.sources) {
    assert.equal(source.trust, "untrusted_reference");
    assert.ok(Object.hasOwn(source, "revision"));
  }
}

test("a clean project root returns the canonical README, nearby conventions and active TODO items", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/Alpha" });
  assert.equal(result.projectRoot, "Projects/Alpha");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.project.readme, "Projects/Alpha/README.md");
  assert.equal(result.project.base, "Projects/Alpha/Project.base");
  assert.deepEqual(result.project.views, ["进行中", "已完成"]);
  assert.deepEqual(result.project.nestedRoots, []);
  assertProvenance(result);

  const readme = result.items[0];
  assert.equal(readme.kind, "readme");
  assert.equal(readme.reason, "project_readme");
  assert.equal(readme.path, "Projects/Alpha/README.md");
  assert.match(readme.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(readme.revisionSource, "bounded_note_read");
  assert.equal(readme.metadata.title, "Alpha Project");

  const conventions = result.items.filter((item) => item.kind === "convention");
  assert.deepEqual(conventions.map((item) => item.path), ["Projects/Alpha/CONVENTIONS.md", "AGENTS.md"]);
  assert.deepEqual(conventions.map((item) => item.reason), ["nearby_convention", "nearby_convention"]);

  const todos = result.items.filter((item) => item.kind === "todo");
  assert.deepEqual(todos.map((item) => item.excerpt), ["Ship the bounded project context", "Write the C1 report"]);
  assert.ok(todos.every((item) => item.path === "Projects/Alpha/TODO.md"));
  assert.ok(todos.every((item) => item.reason === "active_todo"));

  // No item smuggles a full body: the expensive fixture text stays out.
  assert.equal(JSON.stringify(result).includes("This paragraph exists to make a full read expensive"), false);
});

test("a top-level root uses the vault README and does not treat a child folder as a project root", async () => {
  const result = await buildProjectContext({ projectRoot: "" });
  assert.equal(result.projectRoot, "");
  assert.equal(result.status, "ok");
  assert.equal(result.items[0].path, "README.md");
  assert.equal(result.items[0].kind, "readme");
  // Projects/ holds the project folders, but it has no README of its own: no nested root.
  assert.deepEqual(result.project.nestedRoots, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.items.filter((item) => item.kind === "convention").map((item) => item.path), ["AGENTS.md"]);
  assertProvenance(result);
});

test("a nested project root is not merged: the named root wins with a warning", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/Nest" });
  assert.equal(result.project.readme, "Projects/Nest/README.md");
  assert.deepEqual(result.items.filter((item) => item.kind === "readme").map((item) => item.path), ["Projects/Nest/README.md"]);
  assert.deepEqual(result.project.nestedRoots, ["Projects/Nest/Child"]);
  assert.ok(warningCodes(result).includes("nested_project_root"));
  const todoPaths = result.items.filter((item) => item.kind === "todo").map((item) => item.path);
  assert.deepEqual(todoPaths, [], "a nested root's TODO file is never merged into the outer answer");
  assert.equal(result.status, "partial");
});

test("several README files resolve deterministically to the markdown one with a warning", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/Many" });
  assert.equal(result.project.readme, "Projects/Many/README.md");
  assert.ok(warningCodes(result).includes("readme_ambiguous"));
  assert.equal(result.status, "partial");
  assertProvenance(result);
  const again = await buildProjectContext({ projectRoot: "Projects/Many" });
  assert.deepEqual(again.items, result.items);
});

test("a project without a README says so and still returns its bounded items", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/None" });
  assert.equal(result.project.readme, null);
  assert.ok(warningCodes(result).includes("project_readme_missing"));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.items.filter((item) => item.kind === "readme"), []);
  assert.deepEqual(result.items.filter((item) => item.kind === "todo").map((item) => item.excerpt), ["Item in a project without a README"]);
  assertProvenance(result);
});

test("an unparseable Project.base is a warning with a deterministic fallback, never a fake complete answer", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/Broken" });
  assert.ok(warningCodes(result).includes("project_base_unparsed"));
  assert.equal(result.project.base, null);
  assert.equal(result.project.views, null);
  assert.equal(result.status, "partial");
  assert.equal(result.project.readme, "Projects/Broken/README.md");
  assertProvenance(result);
});

test("history and Done sections are excluded from active TODO items", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/Alpha" });
  const text = JSON.stringify(result.items.filter((item) => item.kind === "todo"));
  for (const excluded of ["Done checkbox item", "Cancelled checkbox item", "Open box under a Done heading", "Open box under a History heading"]) {
    assert.equal(text.includes(excluded), false, `excluded TODO leaked: ${excluded}`);
  }
  assert.equal(result.items.filter((item) => item.kind === "todo").length, 2);
});

test("a root in a Vault this process has no runtime for is refused and never served by the primary Vault", async () => {
  await withRequestContext({ vaultId: "ghost-vault" }, async () => {
    await assert.rejects(
      () => buildProjectContext({ projectRoot: "Projects/Alpha" }),
      (error) => {
        assert.equal(error.code, SEARCH_RUNTIME_REFUSED);
        assert.equal(error.vaultId, "ghost-vault");
        return true;
      },
    );
  });
});

test("a revoked Vault scope refuses the project context before any read", async () => {
  const lease = createRuntimeLease(primaryRuntime.id);
  const handle = createLeasedRuntime(primaryRuntime, lease);
  revokeRuntimeLease(lease, "test revoke");
  await assert.rejects(
    () => buildProjectContext({ vaultRuntime: handle, projectRoot: "Projects/Alpha" }),
    (error) => {
      assert.equal(error.code, VAULT_RUNTIME_LEASE_REVOKED);
      return true;
    },
  );
});

test("a Vault runtime the caller is not authorized for is refused, not used", async () => {
  const impostor = { ...primaryRuntime, id: "other-vault", root: "/tmp/not-this-vault" };
  await assert.rejects(
    () => buildProjectContext({ vaultRuntime: impostor, projectRoot: "Projects/Alpha" }),
    (error) => {
      assert.equal(error.code, "project_root_vault_mismatch");
      return true;
    },
  );
});

test("project scope requires an explicit projectRoot and refuses an escaping one", async () => {
  await assert.rejects(
    () => buildProjectContext({}),
    (error) => {
      assert.equal(error.code, "project_root_required");
      return true;
    },
  );
  await assert.rejects(() => buildProjectContext({ projectRoot: "../escape" }), /traversal/i);
});

test("a missing project root is not_found and empty", async () => {
  const result = await buildProjectContext({ projectRoot: "Projects/Ghost" });
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.sources, []);
  assert.ok(warningCodes(result).includes("project_root_not_found"));
  assert.equal(result.budget.usedItems, 0);
});

test("note scope without the new options is byte-identical to today", async () => {
  const plain = await buildNoteContext({ path: "Projects/Alpha/README.md", includeBacklinks: false });
  const withNewOptions = await buildNoteContext({ path: "Projects/Alpha/README.md", includeBacklinks: false, contextScope: "note", projectRoot: "Projects/Alpha" });
  assert.equal(JSON.stringify(withNewOptions), JSON.stringify(plain));
  assert.equal(Object.hasOwn(plain, "scope"), false);
});

test("the adapter serves project scope, reuses the note envelope trimming and keeps note mode intact", async () => {
  await withContextClient(async (client) => {
    const project = await client.callTool({ name: "get_note_context", arguments: { path: "Projects/Alpha/README.md", contextScope: "project", projectRoot: "Projects/Alpha" } });
    assert.equal(project.isError, undefined);
    assert.equal(project.structuredContent.scope, "project");
    assert.equal(project.structuredContent.project.readme, "Projects/Alpha/README.md");

    const note = await client.callTool({ name: "get_note_context", arguments: { path: "Projects/Alpha/README.md", includeBacklinks: false } });
    assert.equal(note.structuredContent.scope, undefined);
    assert.equal(note.structuredContent.items[0].kind, "target");

    const missingRoot = await client.callTool({ name: "get_note_context", arguments: { path: "Projects/Alpha/README.md", contextScope: "project" } });
    assert.equal(missingRoot.isError, true);
    assert.match(missingRoot.content[0].text, /project_root_required/);
  });
});

test("the project envelope reuses the existing byte-budget trimming order", async () => {
  const big = await buildProjectContext({ projectRoot: "Projects/Alpha" });
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const trimmed = await buildProjectContext({ projectRoot: "Projects/Alpha", maxOutputBytes: bytes(big) - 1 });
  assert.equal(bytes(trimmed) <= bytes(big) - 1, true);
  assert.equal(trimmed.status, "partial");
  assert.ok(warningCodes(trimmed).includes("output_budget_truncated"));
  assert.equal(trimmed.budget.maxOutputBytes, bytes(big) - 1);
  assert.equal(trimmed.sources.length, trimmed.items.length);

  await assert.rejects(
    () => buildProjectContext({ projectRoot: "Projects/Alpha", maxOutputBytes: 200 }),
    (error) => {
      assert.equal(error.code, OUTPUT_BUDGET_TOO_SMALL);
      return true;
    },
  );
});

test("one project call costs fewer bytes than chaining search plus full reads", async () => {
  const project = await buildProjectContext({ projectRoot: "Projects/Alpha" });
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  // The hand-rolled chain an agent needs today: a search hit list, then a full read of
  // each file the search named (README, CONVENTIONS, TODO).
  const files = ["Projects/Alpha/README.md", "Projects/Alpha/CONVENTIONS.md", "Projects/Alpha/TODO.md"];
  const search = { results: files.map((file) => ({ path: file, score: 0.9, excerpt: "" })) };
  const reads = [];
  for (const file of files) {
    reads.push({ path: file, revision: "sha256:…", content: await fs.readFile(path.join(vault, file), "utf8") });
  }
  const chainBytes = bytes(search) + bytes(reads);
  const projectBytes = bytes(project);
  assert.ok(projectBytes < chainBytes, `project ${projectBytes} bytes vs chain ${chainBytes} bytes`);
  // Recorded for the report: the ratio must stay well below half of the chain.
  assert.ok(projectBytes * 2 < chainBytes, `project ${projectBytes} bytes is not below half of the chain ${chainBytes} bytes`);
});
