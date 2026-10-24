import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mutation-plans-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.VERSION_HISTORY_ENABLED = "true";
process.env.GIT_ENABLED = "false";

const { withRequestContext } = await import("../src/request-context.js");
const {
  applyNotePlan,
  compareNoteSources,
  createNotePlan,
  getNoteVersion,
} = await import("../src/mutation-plans.js");
const { fileRevision, listFileVersions } = await import("../src/vault.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const author = { agent: "test-agent", model: "test-model" };
const authored = (callback) => withRequestContext({ author }, callback);

test("note plans preview without side effects and apply a multi-note batch idempotently", async () => {
  const readme = path.join(vault, "Project", "README.md");
  await fs.mkdir(path.dirname(readme), { recursive: true });
  await fs.writeFile(readme, "---\ntitle: Project\n---\n# Project\n\nOld status\n", "utf-8");
  const baseRevision = await fileRevision(readme);

  const plan = await authored(() => createNotePlan([
    {
      path: "Project/README.md",
      operation: "patch",
      targetType: "heading",
      target: "Project",
      patchOperation: "replace",
      content: "\nNew status\n",
      baseRevision,
    },
    {
      path: "Project/TODO.md",
      operation: "write",
      content: "# TODO\n\n- [ ] Verify\n",
      frontmatter: { status: "active" },
      mustNotExist: true,
    },
  ], { maxDiffChars: 20000 }));

  assert.equal(plan.changed, true);
  assert.equal(plan.changes.length, 2);
  assert.match(plan.changes[0].diff, /New status/);
  assert.deepEqual(plan.changes[1].summary.headings.added, ["1:TODO"]);
  await assert.rejects(() => fs.access(path.join(vault, "Project", "TODO.md")));
  assert.match(await fs.readFile(readme, "utf-8"), /Old status/);

  const applied = await authored(() => applyNotePlan(plan.planId, plan.planHash, "mutation-plan-test-0001"));
  assert.equal(applied.applied, true);
  assert.equal(applied.idempotentReplay, false);
  assert.equal(applied.changed.length, 2);
  assert.match(await fs.readFile(readme, "utf-8"), /New status/);
  assert.match(await fs.readFile(path.join(vault, "Project", "TODO.md"), "utf-8"), /mcp_author/);

  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, "mutation-plan-test-0001"));
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.changed, applied.changed);
});

test("plan apply rejects an external revision change before writing", async () => {
  const target = path.join(vault, "Project", "README.md");
  const baseRevision = await fileRevision(target);
  const plan = await authored(() => createNotePlan([{
    path: "Project/README.md",
    operation: "append",
    content: "planned",
    baseRevision,
  }]));
  await fs.appendFile(target, "external\n", "utf-8");
  await assert.rejects(
    () => authored(() => applyNotePlan(plan.planId, plan.planHash, "mutation-plan-test-0002")),
    /Revision conflict/,
  );
  const saved = await fs.readFile(target, "utf-8");
  assert.match(saved, /external/);
  assert.doesNotMatch(saved, /planned/);
});

test("persistent versions can be read and compared with current notes", async () => {
  const versions = await listFileVersions("Project/README.md");
  assert.ok(versions.length >= 1);
  const version = await getNoteVersion(versions[0].versionId, 20000);
  assert.equal(version.truncated, false);
  assert.match(version.content, /Old status/);

  const compared = await compareNoteSources(
    { kind: "version", versionId: versions[0].versionId },
    { kind: "current", path: "Project/README.md" },
    20000,
  );
  assert.equal(compared.changed, true);
  assert.match(compared.diff, /New status|external/);
  assert.equal(typeof compared.summary.frontmatter, "object");
});

test("registered MCP plan tools validate and round-trip structured results", async () => {
  const server = new McpServer({ name: "mutation-plan-server", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "test-agent", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    for (const name of ["plan_note_changes", "get_note_plan", "apply_note_plan", "get_note_version", "compare_note_versions"]) {
      assert.ok(listed.tools.some((tool) => tool.name === name), `${name} must be discoverable`);
    }
    for (const name of [
      "plan_note_changes",
      "plan_move_note",
      "plan_delete_note",
      "plan_restore_version",
      "plan_restore_from_trash",
      "compare_note_versions",
    ]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.equal(tool.inputSchema.properties.maxDiffChars.minimum, 1, `${name} must accept compact diff previews`);
      assert.equal(tool.inputSchema.properties.maxDiffChars.maximum, 500000, `${name} maxDiffChars upper bound`);
      assert.equal(tool.inputSchema.properties.maxDiffChars.default, 100000, `${name} maxDiffChars default`);
    }
    const longContent = `# Tool\n\n${"x".repeat(600)}\n`;
    const planned = await client.callTool({
      name: "plan_note_changes",
      arguments: {
        changes: [{ path: "Project/Tool.md", operation: "write", content: longContent, mustNotExist: true }],
        maxDiffChars: 300,
      },
    });
    assert.equal(planned.isError, undefined);
    assert.equal(planned.structuredContent.changed, true);
    assert.equal(planned.structuredContent.changes[0].truncated, true);
    assert.match(planned.structuredContent.changes[0].diff, /diff truncated/);
    const applied = await client.callTool({
      name: "apply_note_plan",
      arguments: {
        planId: planned.structuredContent.planId,
        planHash: planned.structuredContent.planHash,
        idempotencyKey: "mutation-plan-tool-test-0001",
      },
    });
    assert.equal(applied.isError, undefined);
    assert.equal(applied.structuredContent.applied, true);
    const savedTool = await fs.readFile(path.join(vault, "Project", "Tool.md"), "utf-8");
    assert.match(savedTool, /# Tool/);
    assert.ok(savedTool.includes("x".repeat(600)), "diff preview truncation must not truncate applied content");
  } finally {
    await client.close();
    await server.close();
  }
});

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
