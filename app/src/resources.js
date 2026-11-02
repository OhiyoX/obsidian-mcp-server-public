import { allTagsForNote, extractLinks, readNote } from "./obsidian.js";
import { allMarkdownFiles, resolveVaultPath, walk } from "./vault.js";
import { getVaultIndex } from "./vault-index.js";
import { getAgentBootstrap, MEMORY_POLICY_URI } from "./agent-bootstrap.js";

export function registerResources(server) {
  if (typeof server.registerResource !== "function") return;

  server.registerResource(
    "obsidian-agent-memory-policy",
    MEMORY_POLICY_URI,
    { title: "Shared Agent Memory Workflow", description: "Versioned project-memory contract for any MCP client. Prefer agent_bootstrap when tools are easier to discover.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(getAgentBootstrap(), null, 2) }] }),
  );

  server.registerResource(
    "obsidian-vault-index",
    "obsidian://vault/index",
    { title: "Obsidian Vault Index", description: "A JSON index of notes in the vault.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href || String(uri), mimeType: "application/json", text: JSON.stringify({ entries: await walk(resolveVaultPath(""), { recursive: true, depth: 20, extension: ".md", maxEntries: 500 }) }, null, 2) }] }),
  );

  server.registerResource(
    "obsidian-tags",
    "obsidian://vault/tags",
    { title: "Obsidian Tags", description: "A JSON tag index with usage counts.", mimeType: "application/json" },
    async (uri) => {
      const counts = new Map();
      const index = await getVaultIndex();
      for (const record of index.records.slice(0, 2000)) for (const tag of record.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
      return { contents: [{ uri: uri.href || String(uri), mimeType: "application/json", text: JSON.stringify({ tags: [...counts.entries()].map(([tag, count]) => ({ tag, count })) }, null, 2) }] };
    },
  );

  server.registerResource(
    "obsidian-graph",
    "obsidian://vault/graph",
    { title: "Obsidian Link Graph", description: "A JSON graph of notes and vault-internal links.", mimeType: "application/json" },
    async (uri) => {
      const nodes = [];
      const edges = [];
      const index = await getVaultIndex();
      for (const record of index.records.slice(0, 2000)) {
        nodes.push({ id: record.path, tags: record.tags, aliases: record.aliases });
        for (const link of record.links) {
          const resolution = index.resolveLink(link, record.path);
          edges.push({ from: record.path, to: resolution.path || link.target, type: link.type, status: resolution.status });
        }
      }
      return { contents: [{ uri: uri.href || String(uri), mimeType: "application/json", text: JSON.stringify({ nodes, edges }, null, 2) }] };
    },
  );
}
