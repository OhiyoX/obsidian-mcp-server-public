#!/usr/bin/env node
// Hot Routes Phase 0-A — evidence group 4: reproducible synthetic cold/warm
// benchmark.
//
// Read-only characterization. It never touches a live Vault, never contacts a
// network peer outside 127.0.0.1, and never caches arbitrary search/recall
// results. It measures:
//
//   - getVaultIndex cold build, warm unchanged refresh, pathPrefix refresh;
//   - getCachedVaultIndex (no Vault IO);
//   - project-entry lookup as a proposed L1 route-resolution proxy
//     (cached basename map vs naive fresh scan) with output equality;
//   - tag-count and recent-note derivations from a clean snapshot;
//   - listSkillPackages first/repeated observations;
//   - raw descriptor / tools/list local transport cost (in-memory and loopback).
//
// Filesystem-operation proxy: `node:fs/promises` method calls on the module
// default export (stat, lstat, readdir, open, readFile, realpath, access,
// mkdir) are wrapped before the source modules are imported. This is NOT a
// literal count of all filesystem operations: FileHandle instance methods
// (handle.read / handle.readFile / handle.sync / handle.close), streams, and
// OS syscall counts are not captured.
//
// Per-scenario CPU deltas use `process.cpuUsage()` (user/system microseconds),
// RSS before/after uses `process.memoryUsage().rss`, and the measured sample
// count is recorded. fs-call totals are reported as the last sample plus the
// min/max range and the per-sample totals; they are never presented as a
// single canonical count.
//
// Honesty notes:
//   - tools/list timeout causation cannot be inferred from loopback alone.
//   - Hot cache hit metrics are N/A until a Hot Route cache is implemented.
//   - TTL / capacity numbers are proposals, not measurements or frozen policy.
//   - listSkillPackages rescans on every call (no cache/reset); "first" and
//     "repeated" are observations, not a genuine cold/warm reset.

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fsPromisesDefault from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, "docs", "review", "hot-routes", "phase0", "benchmark-results.json");

// `--out <path>` (or `--out=<path>`) lets a reproducer write somewhere other
// than the tracked evidence file, so re-running does not have to dirty the
// committed artifact.
function parseOutputPath(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") return path.resolve(process.cwd(), argv[index + 1]);
    if (arg.startsWith("--out=")) return path.resolve(process.cwd(), arg.slice("--out=".length));
  }
  return DEFAULT_OUTPUT_PATH;
}
const OUTPUT_PATH = parseOutputPath(process.argv.slice(2));

const SEED = 0x5eed1234;
const NOTE_COUNT = 120;
const SKILL_COUNT = 12;
const README_COUNT = 1;
// Generated Markdown files the vault index actually sees: every synthetic note,
// the README, and each skill's SKILL.md (skills live inside the vault root).
const SYNTHETIC_MARKDOWN_FILES = NOTE_COUNT + README_COUNT + SKILL_COUNT;
const TOOL_COUNT = 40;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same vault every run.
// ---------------------------------------------------------------------------
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = createRng(SEED);
const folders = ["Projects", "Areas", "Archive", "Notes", "Notes/Deep"];
const tagPool = ["project", "todo", "reference", "meeting", "idea", "review"];

function noteBody(index) {
  const tag = tagPool[Math.floor(rng() * tagPool.length)];
  const link = `[[Note ${Math.floor(rng() * NOTE_COUNT)}]]`;
  return [
    "---",
    `title: Note ${index}`,
    `tags: [${tag}]`,
    "---",
    `# Note ${index}`,
    "",
    `Body ${index}. ${link}`,
    "x".repeat(Math.floor(rng() * 80)),
    "",
  ].join("\n");
}

async function createSyntheticVault(root) {
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, "Projects"), { recursive: true });
  await mkdir(path.join(vault, "Projects", "Guides"), { recursive: true });
  await writeFile(
    path.join(vault, "Projects", "README.md"),
    "---\ntitle: Project Entry\ntags: [project]\n---\n# Project Entry\n[[Note 1]]\n",
  );
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    const folder = folders[index % folders.length];
    await mkdir(path.join(vault, folder), { recursive: true });
    await writeFile(path.join(vault, folder, `Note ${index}.md`), noteBody(index));
  }
  for (let index = 0; index < SKILL_COUNT; index += 1) {
    const skillRoot = path.join(vault, "60-Skills", "engineering", `skill-${index}`);
    await mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---\nname: skill-${index}\ndescription: Synthetic benchmark skill ${index}.\n---\n\n# Skill ${index}\n\nRun scripts/validate.mjs.\n`,
    );
    await writeFile(path.join(skillRoot, "scripts", "validate.mjs"), `console.log('${index}')\n`);
  }
  return vault;
}

// ---------------------------------------------------------------------------
// fs call counters installed before source modules import fs/promises.
//
// This proxy counts calls to these `node:fs/promises` module methods only.
// FileHandle instance methods, streams, and OS syscalls are not counted.
// ---------------------------------------------------------------------------
const COUNTED_FS = ["stat", "lstat", "readdir", "open", "readFile", "realpath", "access", "mkdir"];
const fsCounts = {};
const fsOriginals = {};
for (const name of COUNTED_FS) {
  if (typeof fsPromisesDefault[name] !== "function") continue;
  fsOriginals[name] = fsPromisesDefault[name];
  fsCounts[name] = 0;
  fsPromisesDefault[name] = (...args) => {
    fsCounts[name] += 1;
    return fsOriginals[name](...args);
  };
}
function resetFsCounts() {
  for (const name of Object.keys(fsCounts)) fsCounts[name] = 0;
}
function fsCallTotal() {
  return Object.values(fsCounts).reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// Measurement helpers.
// ---------------------------------------------------------------------------
function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[index];
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

async function measure(label, fn, samples) {
  const durations = [];
  const cpuUserUs = [];
  const cpuSystemUs = [];
  const rssBeforeBytes = [];
  const rssAfterBytes = [];
  const fsPerSample = [];
  let lastResult;
  for (let index = 0; index < samples; index += 1) {
    resetFsCounts();
    const rssBefore = process.memoryUsage().rss;
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    lastResult = await fn(index);
    durations.push(performance.now() - started);
    const cpuDelta = process.cpuUsage(cpuStart);
    cpuUserUs.push(cpuDelta.user);
    cpuSystemUs.push(cpuDelta.system);
    rssBeforeBytes.push(rssBefore);
    rssAfterBytes.push(process.memoryUsage().rss);
    fsPerSample.push({ total: fsCallTotal(), byName: { ...fsCounts } });
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const totals = fsPerSample.map((entry) => entry.total);
  const rssDeltas = rssAfterBytes.map((value, index) => value - rssBeforeBytes[index]);
  return {
    label,
    samples,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(sum(durations) / durations.length),
    cpu: {
      source: "process.cpuUsage",
      userMsTotal: round(sum(cpuUserUs) / 1000),
      systemMsTotal: round(sum(cpuSystemUs) / 1000),
      userMsMeanPerSample: round(sum(cpuUserUs) / samples / 1000),
      systemMsMeanPerSample: round(sum(cpuSystemUs) / samples / 1000),
    },
    rssBytes: {
      source: "process.memoryUsage().rss",
      beforeFirst: rssBeforeBytes[0],
      afterLast: rssAfterBytes[rssAfterBytes.length - 1],
      deltaFirstToLast: rssAfterBytes[rssAfterBytes.length - 1] - rssBeforeBytes[0],
      deltaMeanPerSample: Math.round(sum(rssDeltas) / samples),
      deltaMaxPerSample: Math.max(...rssDeltas),
    },
    fsCalls: {
      proxy: "node:fs/promises module-method calls (FileHandle methods, streams, and OS syscalls excluded)",
      lastSample: fsPerSample[fsPerSample.length - 1],
      minTotal: Math.min(...totals),
      maxTotal: Math.max(...totals),
      perSampleTotals: totals,
    },
    result: lastResult,
  };
}

function deriveTagCounts(index) {
  const counts = new Map();
  for (const record of index.records) {
    for (const tag of record.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
}

function deriveRecent(index, limit = 10) {
  return index.records
    .map((record) => ({ path: record.path, modified: record.stat.modified, revision: record.revision }))
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, limit);
}

function buildProjectEntryMap(index) {
  const map = new Map();
  for (const record of index.records) {
    map.set(record.basename.toLowerCase(), record.path);
    map.set(record.name.toLowerCase(), record.path);
    if (typeof record.frontmatter?.title === "string") map.set(record.frontmatter.title.toLowerCase(), record.path);
    for (const alias of record.aliases) map.set(alias.toLowerCase(), record.path);
  }
  return map;
}

function resolveNaive(index, key) {
  const wanted = key.toLowerCase();
  return index.records.find(
    (record) =>
      record.basename.toLowerCase() === wanted ||
      record.name.toLowerCase() === wanted ||
      String(record.frontmatter?.title || "").toLowerCase() === wanted ||
      record.aliases.some((alias) => alias.toLowerCase() === wanted),
  )?.path || null;
}

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-hot-routes-bench-"));
try {
  const vault = await createSyntheticVault(root);

  process.env.VAULT_PATH = vault;
  process.env.DATA_PATH = path.join(root, "data");
  process.env.SKILLS_PATH = "60-Skills";
  process.env.GIT_ENABLED = "false";
  process.env.EMBEDDING_PROVIDER = "disabled";
  process.env.RETRIEVAL_AUTO_EMBED = "false";
  process.env.RETRIEVAL_REFRESH_DEBOUNCE_MS = "60000";

  const { getVaultIndex, getCachedVaultIndex, invalidateVaultIndex } = await import("../src/vault-index.js");
  const { listSkillPackages } = await import("../src/skills.js");

  const results = {};

  // 1. Vault index cold / warm / pathPrefix.
  results.vaultIndexCold = await measure(
    "vaultIndex.cold",
    async () => {
      invalidateVaultIndex();
      const index = await getVaultIndex();
      return { files: index.stats.files, reparsed: index.stats.reparsed, records: index.records.length };
    },
    5,
  );
  results.vaultIndexWarm = await measure(
    "vaultIndex.warmUnchanged",
    async () => {
      const index = await getVaultIndex();
      return { files: index.stats.files, reparsed: index.stats.reparsed, reused: index.stats.reused };
    },
    25,
  );
  results.vaultIndexPathPrefix = await measure(
    "vaultIndex.pathPrefix",
    async () => {
      const index = await getVaultIndex({ pathPrefix: "Projects" });
      return { records: index.records.length };
    },
    25,
  );

  // 2. Cached snapshot read (no Vault IO).
  await getVaultIndex();
  results.cachedSnapshotRead = await measure(
    "cachedSnapshot.read",
    async () => {
      const cached = getCachedVaultIndex();
      return { records: cached.records.length, cached: cached.stats.cached };
    },
    50,
  );

  // 3. Tag / recent derivations: cached snapshot vs fresh refresh.
  const cleanSnapshot = getCachedVaultIndex();
  results.tagsDeriveCached = await measure("tags.deriveCached", () => deriveTagCounts(cleanSnapshot), 50);
  results.tagsDeriveFresh = await measure("tags.deriveFresh", async () => deriveTagCounts(await getVaultIndex()), 15);
  results.recentDeriveCached = await measure("recent.deriveCached", () => deriveRecent(cleanSnapshot), 50);
  results.recentDeriveFresh = await measure("recent.deriveFresh", async () => deriveRecent(await getVaultIndex()), 15);

  // 4. Project-entry lookup proxy (cached map vs naive fresh scan).
  const entryMap = buildProjectEntryMap(cleanSnapshot);
  const ENTRY_KEY = "Project Entry";
  results.projectEntryCached = await measure("projectEntry.resolveCached", () => entryMap.get(ENTRY_KEY.toLowerCase()) || null, 100);
  results.projectEntryNaive = await measure(
    "projectEntry.resolveNaive",
    async () => resolveNaive(await getVaultIndex(), ENTRY_KEY),
    15,
  );

  // 5. Skill package inventory. listSkillPackages has no cache and no reset, so
  // the first call is an observation, not a genuine cold state; the later calls
  // are repeated observations.
  results.skillsListFirstObservation = await measure("skills.listFirstObservation", async () => (await listSkillPackages()).skills.length, 10);
  results.skillsListRepeated = await measure("skills.listRepeated", async () => (await listSkillPackages()).skills.length, 25);

  // 6. Raw descriptor / tools/list local transport cost.
  const { z } = await import("zod/v4");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const express = (await import("express")).default;

  function registerSyntheticTools(server) {
    for (let index = 0; index < TOOL_COUNT; index += 1) {
      server.registerTool(
        `synthetic_tool_${index}`,
        {
          title: `Synthetic Tool ${index}`,
          description: `Synthetic descriptor for benchmark tool ${index}.`,
          inputSchema: { path: z.string(), limit: z.number().int().optional() },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    }
  }

  // 6a. In-memory transport round trip.
  {
    const server = new McpServer({ name: "hot-routes-bench", version: "1" });
    registerSyntheticTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "hot-routes-bench-client", version: "1" });
    await client.connect(clientTransport);
    const first = await client.listTools();
    const descriptorBytes = Buffer.byteLength(JSON.stringify(first.tools));
    results.toolsListInMemory = await measure("toolsList.inMemory", async () => (await client.listTools()).tools.length, 20);
    results.toolsListInMemory.descriptorBytes = descriptorBytes;
    results.toolsListInMemory.toolCount = first.tools.length;
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }

  // 6b. Loopback Streamable HTTP round trip (real transport).
  {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    const sessions = new Map();
    app.post("/mcp", async (req, res) => {
      try {
        const sessionId = req.header("mcp-session-id");
        if (sessionId) {
          const record = sessions.get(sessionId);
          if (!record) { res.status(404).end(); return; }
          await record.transport.handleRequest(req, res, req.body);
          return;
        }
        const server = new McpServer({ name: "hot-routes-bench", version: "1" });
        registerSyntheticTools(server);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, { transport, server }),
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: String(error?.message || error) });
      }
    });
    const httpServer = app.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const port = httpServer.address().port;
    const rpc = async (method, params, session) => {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (session) headers["mcp-session-id"] = session;
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
      });
      const text = await response.text();
      return {
        payload: !text ? null : response.headers.get("content-type")?.includes("event-stream")
          ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((message) => message.id === 7)
          : JSON.parse(text),
        session: response.headers.get("mcp-session-id") || session,
      };
    };
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "1" } });
    const session = init.session;
    results.toolsListLoopback = await measure("toolsList.loopback", async () => {
      const response = await rpc("tools/list", {}, session);
      return response.payload.result.tools.length;
    }, 20);
    results.toolsListLoopback.descriptorBytes = Buffer.byteLength(JSON.stringify((await rpc("tools/list", {}, session)).payload.result.tools));
    results.toolsListLoopback.toolCount = TOOL_COUNT;
    for (const record of sessions.values()) await record.server.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  }

  // -------------------------------------------------------------------------
  // Output equality checks.
  // -------------------------------------------------------------------------
  const warmIndex = await getVaultIndex();
  const cachedIndex = getCachedVaultIndex();
  const equality = {
    coldVsWarmRecordPaths: JSON.stringify(warmIndex.records.map((r) => r.path)) === JSON.stringify(cleanSnapshot.records.map((r) => r.path)),
    cachedVsFreshRecordPaths: JSON.stringify(cachedIndex.records.map((r) => r.path)) === JSON.stringify(warmIndex.records.map((r) => r.path)),
    tagsCachedVsFresh: JSON.stringify(results.tagsDeriveCached.result) === JSON.stringify(results.tagsDeriveFresh.result),
    recentCachedVsFresh: JSON.stringify(results.recentDeriveCached.result) === JSON.stringify(results.recentDeriveFresh.result),
    projectEntryCachedVsNaive: results.projectEntryCached.result === results.projectEntryNaive.result,
    projectEntryValue: results.projectEntryCached.result,
    skillsListFirstVsRepeated: results.skillsListFirstObservation.result === results.skillsListRepeated.result,
  };
  for (const [key, value] of Object.entries(equality)) {
    if (value === false) throw new Error(`output equality check failed: ${key}`);
  }

  // -------------------------------------------------------------------------
  // Report.
  // -------------------------------------------------------------------------
  const report = {
    schemaVersion: 2,
    artifact: "hot-routes-phase0-benchmark",
    status: "candidate",
    generatedBy: "app/scripts/hot-routes-phase0-benchmark.mjs",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    },
    workload: {
      seed: SEED,
      // Generated knobs:
      noteCount: NOTE_COUNT,
      skillCount: SKILL_COUNT,
      readmeCount: README_COUNT,
      toolCount: TOOL_COUNT,
      noteFolders: folders,
      // Real Markdown files the vault index actually enumerates:
      syntheticMarkdownFiles: SYNTHETIC_MARKDOWN_FILES,
      indexedMarkdownFilesObserved: results.vaultIndexCold.result.files,
    },
    equality,
    results,
    caveats: [
      "Synthetic scratch vault only; no live Vault content.",
      "fs-call counts are a proxy: node:fs/promises module-method calls only; FileHandle methods, streams, and OS syscalls are not captured.",
      "fs-call totals are reported as last sample plus min/max range and per-sample totals, never as one canonical count.",
      "CPU deltas are process.cpuUsage() user/system microseconds; RSS is process.memoryUsage().rss before/after per sample.",
      "projectEntry.* is a proposed L1 route-resolution proxy; no project-entry API exists yet.",
      "skills.list* has no cache/reset; first vs repeated are observations, not a cold/warm reset.",
      "tools/list timeout causation cannot be inferred from a loopback benchmark.",
      "Hot cache hit metrics are N/A until a Hot Route cache is implemented.",
      "TTL/capacity numbers are proposals, not measurements, and are not frozen policy.",
    ],
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(OUTPUT_PATH, serialized);

  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${serialized.length} bytes)`);
  for (const key of Object.keys(results)) {
    const item = results[key];
    console.log(`${key}: samples=${item.samples} p50=${item.p50Ms}ms p95=${item.p95Ms}ms fsCalls(last/range)=${item.fsCalls.lastSample.total}[${item.fsCalls.minTotal}-${item.fsCalls.maxTotal}] cpuUser=${item.cpu.userMsTotal}ms cpuSys=${item.cpu.systemMsTotal}ms rssDeltaMean=${item.rssBytes.deltaMeanPerSample}`);
  }
} finally {
  // Always remove the synthetic scratch vault, including on failure, so no
  // temp content (and no live Vault content) can leak.
  await rm(root, { recursive: true, force: true });
}
