import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Environment must be configured before importing config/vault/retrieval modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-dotted-links-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const deployment = path.join(vault, "Deployment");
const dotted = path.join(vault, "Dotted");
await fs.mkdir(deployment, { recursive: true });
await fs.mkdir(dotted, { recursive: true });
await fs.mkdir(data, { recursive: true });

// Original post-#63 case: a deployment title whose basename contains several
// dot-separated version segments must resolve as a note, not an attachment.
const deploymentTitle = "2026-09-25 v2026.09.25.11 发布与 NAS 部署";
const deploymentTarget = `Deployment/${deploymentTitle}`;
await fs.writeFile(path.join(vault, `${deploymentTarget}.md`), `# ${deploymentTitle}\n`, "utf8");
await fs.writeFile(
  path.join(deployment, "README.md"),
  `[[${deploymentTarget}|release]]\n![[diagram.png]]\n`,
  "utf8",
);

// Post-#63 regression cases: extension-like dotted note basenames from the
// issue that must stay distinguishable from real attachments.
const DOTTED_NOTES = ["note.v1", "note.v2026.09.25.12", "note.with.dots"];
const SHARED_CONTENT = "shared dotted link keyword";
for (const name of DOTTED_NOTES) {
  await fs.writeFile(path.join(dotted, `${name}.md`), `# ${name}\n\n${SHARED_CONTENT}\n`, "utf8");
}
await fs.writeFile(
  path.join(dotted, "README.md"),
  `${DOTTED_NOTES.map((name) => `[[${name}]]`).join("\n")}\n![[diagram.png]]\n\n${SHARED_CONTENT}\n`,
  "utf8",
);
await fs.writeFile(path.join(dotted, "unrelated.md"), `# unrelated\n\n${SHARED_CONTENT}\n`, "utf8");
await fs.writeFile(path.join(dotted, "diagram.png"), "not a note\n", "utf8");

const { registerLinkTools } = await import("../src/tools/links.js");
const { registerIntelligenceTools } = await import("../src/tools/intelligence.js");
const { syncRetrievalIndex } = await import("../src/retrieval.js");

await syncRetrievalIndex({ force: true, embeddings: false });

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(register, callback) {
  const server = new McpServer({ name: "dotted-link-test", version: "1" });
  register(server);
  const client = new Client({ name: "dotted-link-client", version: "1" });
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

test("backlink tools resolve dotted note titles before attachment classification", async () => {
  await withClient(registerLinkTools, async (client) => {
    const backlinks = await client.callTool({
      name: "get_backlinks",
      arguments: { path: deploymentTarget },
    });
    assert.equal(backlinks.isError, undefined);
    assert.equal(backlinks.structuredContent.target, `${deploymentTarget}.md`);
    assert.deepEqual(
      backlinks.structuredContent.backlinks.map((item) => item.path),
      ["Deployment/README.md"],
    );

    const unresolved = await client.callTool({
      name: "get_unresolved_links",
      arguments: { pathPrefix: "Deployment", includeAmbiguous: true, limit: 100 },
    });
    assert.equal(unresolved.isError, undefined);
    assert.equal(
      unresolved.structuredContent.links.some((item) => item.target === deploymentTarget),
      false,
    );
    const attachment = unresolved.structuredContent.links.find((item) => item.target === "diagram.png");
    assert.equal(attachment?.status, "attachment");
    assert.deepEqual(attachment?.candidates, []);
  });
});

test("get_backlinks resolves note.v1, note.v2026.09.25.12, and note.with.dots", async () => {
  await withClient(registerLinkTools, async (client) => {
    for (const name of DOTTED_NOTES) {
      const result = await client.callTool({
        name: "get_backlinks",
        arguments: { path: `Dotted/${name}` },
      });
      assert.equal(result.isError, undefined, name);
      assert.equal(result.structuredContent.target, `Dotted/${name}.md`, name);
      assert.deepEqual(result.structuredContent.backlinks.map((item) => item.path), ["Dotted/README.md"], name);
    }
  });
});

test("get_unresolved_links separates dotted notes from attachments", async () => {
  await withClient(registerLinkTools, async (client) => {
    const result = await client.callTool({
      name: "get_unresolved_links",
      arguments: { pathPrefix: "Dotted", includeAmbiguous: true, limit: 100 },
    });
    assert.equal(result.isError, undefined);
    const targets = result.structuredContent.links.map((item) => item.target);
    for (const name of DOTTED_NOTES) {
      assert.equal(targets.includes(name), false, name);
    }
    const attachment = result.structuredContent.links.find((item) => item.target === "diagram.png");
    assert.equal(attachment?.status, "attachment");
    assert.deepEqual(attachment?.candidates, []);
  });
});

test("suggestions treat dotted notes as directly linked rather than new suggestions", async () => {
  await withClient(registerIntelligenceTools, async (client) => {
    const related = await client.callTool({
      name: "find_related",
      arguments: { path: "Dotted/README.md", semantic: false, limit: 20 },
    });
    assert.equal(related.isError, undefined);
    const directlyLinked = new Map(related.structuredContent.results.map((item) => [item.path, item.directlyLinked]));
    for (const name of DOTTED_NOTES) {
      assert.equal(directlyLinked.get(`Dotted/${name}.md`), true, name);
    }
    assert.equal(directlyLinked.get("Dotted/unrelated.md"), false);

    const suggestions = await client.callTool({
      name: "suggest_links",
      arguments: { path: "Dotted/README.md", semantic: false, limit: 20 },
    });
    assert.equal(suggestions.isError, undefined);
    const suggested = suggestions.structuredContent.suggestions.map((item) => item.path);
    for (const name of DOTTED_NOTES) {
      assert.equal(suggested.includes(`Dotted/${name}.md`), false, name);
    }
    assert.equal(suggested.includes("Dotted/unrelated.md"), true);
  });
});
