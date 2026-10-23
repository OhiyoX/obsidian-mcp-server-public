// issue #415 — `memory_capture` must not create a directory implicitly.
//
// Real incident: a caller-composed `path` whose parent folder did not exist (the title carried a
// `/`, so the segment after it became a directory name) was silently accepted because
// `writeNoteFile` → `atomicWriteFile` → `ensureVaultParent` runs
// `fs.mkdir(path.dirname(abs), { recursive: true })`. On disk that produced
// `.../20-Memory/Facts/2026-10-05 …（修正 ZCode/` + an inner `Claude 身份借用）.md`.
//
// `write_note` legitimately creates nested paths, so the guard lives in the `memory_capture`
// handler only (`src/tools/intelligence.js`): the target's parent folder must already exist, and
// a refusal must leave the Vault byte-identical (no directory, no file, no journal). The managed
// root (`20-Memory/`) stays the one folder the tool may still materialize, because a fresh Vault
// has none yet and "omit path" is the documented remedy.
//
// Driven through the real production registration chain (`registerObsidianCapabilities`), so the
// vault-scope + memory-guidance wrappers (request context, author stamping) are exercised too.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Environment is assigned before the src modules are imported (`config.js` resolves at load).
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-memory-path-guard-"));
const VAULT = path.join(ROOT, "vault");
const DATA = path.join(ROOT, "data");
process.env.VAULT_PATH = VAULT;
process.env.DATA_PATH = DATA;
process.env.HISTORY_PATH = path.join(DATA, "history");
process.env.TRASH_PATH = path.join(DATA, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(DATA, { recursive: true });

const { MEMORY_PATH } = await import("../src/config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { resolveSearchRuntime } = await import("../src/search-runtimes.js");

// Managed root exists, and one legitimate subdirectory exists (the "existing folder" case).
await fs.mkdir(path.join(VAULT, MEMORY_PATH, "Facts"), { recursive: true });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Recursive `D <rel>` / `F <rel>:<sha256>` listing — a positive, whole-Vault side-effect proof. */
async function snapshot(root) {
  const entries = [];
  async function walk(current) {
    const dirents = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, dirent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (dirent.isDirectory()) {
        entries.push(`D ${rel}`);
        await walk(abs);
      } else {
        entries.push(`F ${rel}:${sha256(await fs.readFile(abs))}`);
      }
    }
  }
  await walk(root);
  return entries;
}

const textOf = (result) => (result.content || []).map((part) => part.text || "").join("\n");

async function withClient(callback) {
  const server = new McpServer({ name: "memory-path-guard", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "memory-path-guard", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await callback((name, args) => client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.close();
  }
}

after(async () => {
  await resolveSearchRuntime().drain();
  await fs.rm(ROOT, { recursive: true, force: true });
});

// ① A `path` whose parent folder does not exist is refused, and the Vault is untouched.
test("issue #415: memory_capture refuses a missing parent folder with zero side effects", async () => {
  const before = await snapshot(VAULT);
  const missingParent = `${MEMORY_PATH}/ImplicitDirProbe`;
  await withClient(async (call) => {
    const result = await call("memory_capture", {
      title: "Implicit Dir Probe",
      content: "probe body that must never be written",
      path: `${missingParent}/2026-10-05 Implicit Dir Probe.md`,
    });
    assert.equal(result.isError, true, "a missing parent folder must be refused");
    assert.match(textOf(result), /Target folder does not exist/);
    assert.match(textOf(result), /memory_capture does not create directories/);
    assert.match(textOf(result), /Facts\//, "the error must name an existing usable folder");
  });
  assert.equal(await fs.access(path.join(VAULT, missingParent)).then(() => true, () => false), false, "the refused folder must not exist");
  assert.deepEqual(await snapshot(VAULT), before, "a refusal must leave the Vault byte-identical (no directory, no file, no journal)");
});

// ② A title containing `/` without an explicit `path` still produces one flat filename.
test("issue #415: a title containing '/' without an explicit path stays a flat filename", async () => {
  const beforeDirs = (await snapshot(VAULT)).filter((entry) => entry.startsWith("D "));
  const title = "Gitea 身份复查法：…（修正 ZCode/Claude 身份借用）";
  // The frozen `safeFilename` cleaning: `[\\/:*?"<>|]` → space, whitespace collapsed.
  const expectedName = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  let captured;
  await withClient(async (call) => {
    const result = await call("memory_capture", { title, content: "flat filename marker" });
    assert.equal(result.isError, undefined, textOf(result));
    captured = result.structuredContent;
  });
  const date = new Date().toISOString().slice(0, 10);
  assert.equal(captured.path, `${MEMORY_PATH}/${date} ${expectedName}.md`);
  assert.ok(!captured.path.slice(MEMORY_PATH.length + 1).includes("/"), "the filename must not contain a path separator");
  assert.ok((await fs.stat(path.join(VAULT, captured.path))).isFile(), "the flat memory file must exist");
  const afterDirs = (await snapshot(VAULT)).filter((entry) => entry.startsWith("D "));
  assert.deepEqual(afterDirs, beforeDirs, "no directory may be created by a title with '/'");
});

// ③ An explicit `path` into an existing managed subdirectory keeps working.
test("issue #415: an explicit path into an existing managed subdirectory still succeeds", async () => {
  const target = `${MEMORY_PATH}/Facts/2026-10-05 Fact In Existing Folder.md`;
  await withClient(async (call) => {
    const result = await call("memory_capture", {
      title: "Fact In Existing Folder",
      content: "existing folder marker",
      path: target,
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(result.structuredContent.path, target);
  });
  assert.ok((await fs.stat(path.join(VAULT, target))).isFile(), "the memory in the existing folder must exist");
});

// ④ The managed root is the only folder the tool may still materialize implicitly.
test("issue #415: an explicit path directly under the managed root stays allowed", async () => {
  const target = `${MEMORY_PATH}/2026-10-05 Root Level Memory.md`;
  await withClient(async (call) => {
    const result = await call("memory_capture", {
      title: "Root Level Memory",
      content: "root level marker",
      path: target,
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(result.structuredContent.path, target);
  });
  assert.ok((await fs.stat(path.join(VAULT, target))).isFile(), "the root-level memory must exist");
});
