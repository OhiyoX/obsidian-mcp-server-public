// Issue #229 follow-up / D1 — regex mode must not run the Obsidian query parser.
//
// P1 regression: after Wave B, the tool layer parsed `input.query` unconditionally
// (`const parsed = parseObsidianQuery(input.query || "");`) before branching on
// `input.useRegex`. A regex that is legal JavaScript but hostile to the Obsidian
// parser (a literal `"`, `OR`, a bare `path:`/`tag:` field) was therefore rejected
// with a parser error before regex mode could run, violating S229-08
// ("regex branch does not enter auto hybrid"; the regex path is unchanged).
//
// This suite exercises the real MCP tool boundary (registerSearchTools +
// InMemoryTransport) over a synthetic temp vault. Each hostile query asserts:
//   - the call succeeds (no isError);
//   - the result set equals the same regex applied directly with `new RegExp`;
//   - semanticMode matches the input and fallbackUsed / hybridUsed stay false;
//   - regex mode never returns zero-result diagnostics (which need `parsed`).
//
// Deviation from the D1 brief, verified by direct probe on base 9581a55:
//   - `path:(` is parser-hostile but is NOT a legal regex (unterminated group),
//     so regex mode cannot succeed for it; it is covered by a dedicated case
//     asserting the failure comes from RegExp, not the parser.
//   - `-` does not throw in parseObsidianQuery (it parses as a text clause), so
//     it never was a red case; `path:` / `tag:` are used instead.
//
// Run:
//   cd app
//   node --test test/search-229-regex-isolation.test.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-229-regex-isolation-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const [{ registerSearchTools }, { getVaultIndex }, { drainRetrievalIndex }] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/vault-index.js"),
  import("../src/retrieval.js"),
]);

// Literal markers for each hostile regex. Each note contains exactly one marker
// so the expected regex match set is unambiguous and independent of the tool.
const FIXTURE_NOTES = {
  "Regex/Quote.md": '# Quote\n\nThe literal phrase marker " sits in this line.\n',
  "Regex/Or.md": "# Or\n\nThe literal OR token appears in this line.\n",
  "Regex/Path.md": "# Path\n\nThe literal path: field text appears here.\n",
  "Regex/Tag.md": "# Tag\n\nThe literal tag: field text appears here.\n",
  "Regex/Dash.md": "# Dash\n\nA literal hyphen - appears in this line.\n",
  "Regex/Plain.md": "# Plain\n\nNothing hostile lives in this line.\n",
};

for (const [relative, raw] of Object.entries(FIXTURE_NOTES)) {
  const absolute = path.join(vault, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, raw, "utf8");
}

after(async () => {
  // Drain the retrieval debounce/queue before removing the scratch root so
  // cleanup cannot race an in-flight atomic index write.
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "search-229-regex-isolation", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-229-regex-isolation-client", version: "1" });
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

async function callSearch(client, args) {
  return client.callTool({ name: "search_notes", arguments: args });
}

async function search(client, args) {
  const result = await callSearch(client, args);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
}

function paths(results) {
  return results.map((item) => item.path).sort();
}

// Reference the tool cannot influence: apply the very same JavaScript regex to
// the same already-filtered candidate set (no outer filters here) and keep the
// notes it matches. The tool commits to the same note.raw (includeFrontmatter
// defaults to true), so the raw comparison is the exact contract.
async function expectedPaths(query) {
  const index = await getVaultIndex({ force: true });
  const regex = new RegExp(query, "i");
  return index.records.filter((record) => regex.test(record.raw)).map((record) => record.path).sort();
}

// Queries that are legal regexes but throw in parseObsidianQuery.
const PARSER_HOSTILE_QUERIES = ['"', "OR", "path:", "tag:"];
// The frozen parser message each hostile query would raise if the parser ran.
const PARSER_HOSTILE_MESSAGES = {
  '"': /Unterminated quoted phrase/,
  OR: /OR requires a term before it/,
  "path:": /Search operator requires a value/,
  "tag:": /Search operator requires a value/,
};

for (const query of PARSER_HOSTILE_QUERIES) {
  for (const semantic of ["omitted", false]) {
    test(`regex isolation: parser-hostile ${JSON.stringify(query)} succeeds in regex mode (semantic=${semantic})`, async () => {
      await withClient(async (client) => {
        const args = { query, useRegex: true };
        if (semantic !== "omitted") args.semantic = semantic;
        const result = await search(client, args);

        assert.equal(result.semanticMode, semantic === "omitted" ? "auto" : "off");
        assert.equal(result.fallbackUsed, false, "regex mode must never use the auto fallback");
        assert.equal(result.hybridUsed, false, "regex mode must never use hybrid retrieval");
        assert.equal(result.semanticUsed, false);
        assert.equal("diagnostics" in result, false, "regex mode has no parsed clauses, so no diagnostics");

        assert.deepEqual(paths(result.results), await expectedPaths(query));
      });
    });
  }
}

test("regex isolation: the parser really is hostile to these queries (guards the regression)", async () => {
  const { parseObsidianQuery } = await import("../src/search/obsidian-query.js");
  for (const query of PARSER_HOSTILE_QUERIES) {
    assert.throws(
      () => parseObsidianQuery(query),
      PARSER_HOSTILE_MESSAGES[query],
      `${JSON.stringify(query)} must stay parser-hostile or this suite no longer guards S229-08`,
    );
  }
});

test("regex isolation: a parser-hostile literal query still fails on the non-regex path", async () => {
  await withClient(async (client) => {
    const result = await callSearch(client, { query: '"' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unterminated quoted phrase/);
  });
});

test("regex isolation: an invalid regex fails in RegExp, not in the Obsidian parser", async () => {
  await withClient(async (client) => {
    const result = await callSearch(client, { query: "path:(", useRegex: true, semantic: false });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /Unterminated grouped filter/);
    assert.match(result.content[0].text, /Invalid regular expression/i);
  });
});

test("regex isolation: semantic=true + useRegex=true keeps the frozen rejection", async () => {
  await withClient(async (client) => {
    const result = await callSearch(client, { query: "OR", useRegex: true, semantic: true });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Error: Semantic search cannot be combined with regex mode");
  });
});
