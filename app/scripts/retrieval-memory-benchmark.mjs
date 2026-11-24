// M0 — retrieval memory/latency benchmark (plan 01 Task 1).
//
// The production index is 383 MiB; loading it inside the normal test runner would
// make every gate slow and memory hungry. This script therefore measures an
// *isolated copy* in a child process and reports only numbers, never vault text.
//
// Usage:
//   node scripts/retrieval-memory-benchmark.mjs --fixture=<dir> --output=<dir> [--label=baseline]
//
// Fixture layout: <fixture>/vault/*.md and optionally <fixture>/data/index/retrieval-index.json.
// The fixture is copied to a temp workspace; the fixture itself is never written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const MIB = 1024 * 1024;
const FORBIDDEN_ROOTS = ["/data", "/srv", "/volume2", "/vault", "/vaults", "/workspace", "/app"];
const QUERY_SET = [
  "how do I deploy the server",
  "memory usage of retrieval index",
  "中文检索测试",
  "where is the release checklist",
];

export const bytesToMiB = (bytes) => (bytes === null || bytes === undefined ? null : Number((bytes / MIB).toFixed(1)));
export const msToNumber = (nanoseconds) => Number((Number(nanoseconds) / 1e6).toFixed(2));

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/** A fixture must live outside every real data root; a benchmark must never touch production. */
export function assertIsolatedRoot(candidate, { allowAll = false } = {}) {
  if (typeof candidate !== "string" || candidate === "") throw new Error("fixture root must be a non-empty path");
  const resolved = path.resolve(candidate);
  if (allowAll) return resolved;
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`refusing to benchmark inside ${forbidden}: use an isolated copy (plan 01 Task 1)`);
    }
  }
  const real = [process.env.VAULT_PATH, process.env.DATA_PATH, process.env.RETRIEVAL_INDEX_PATH]
    .filter((value) => typeof value === "string" && value !== "")
    .map((value) => path.resolve(value));
  if (real.some((value) => resolved === value || resolved.startsWith(`${value}${path.sep}`))) {
    throw new Error("refusing to benchmark inside the configured live Vault/Data root");
  }
  return resolved;
}

async function copyFixtureInto(fixtureRoot, workspace) {
  await fs.mkdir(workspace, { recursive: true });
  await fs.cp(path.join(fixtureRoot, "vault"), path.join(workspace, "vault"), { recursive: true });
  const data = path.join(fixtureRoot, "data");
  await fs.mkdir(path.join(workspace, "data"), { recursive: true });
  if (await fs.stat(data).then(() => true, () => false)) {
    await fs.cp(data, path.join(workspace, "data"), { recursive: true });
  }
  return { vault: path.join(workspace, "vault"), data: path.join(workspace, "data") };
}

function readProcStatus(file) {
  return fs.readFile(file, "utf8").catch(() => null);
}

async function childMeasure(workspace) {
  const indexDir = path.join(workspace.data, "index");
  const indexFile = path.join(indexDir, "retrieval-index.json");
  const storeDir = path.join(indexDir, "retrieval-index-v2");
  process.env.VAULT_PATH = workspace.vault;
  process.env.DATA_PATH = workspace.data;
  process.env.HISTORY_PATH = path.join(workspace.data, "history");
  process.env.RETRIEVAL_INDEX_PATH = indexFile;
  process.env.RETRIEVAL_AUTO_EMBED = process.env.RETRIEVAL_AUTO_EMBED ?? "false";
  process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? "disabled";
  process.env.GIT_ENABLED = "false";

  const retrieval = await import("../src/retrieval.js");
  const usage = () => {
    const memory = process.memoryUsage();
    return { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external, arrayBuffers: memory.arrayBuffers };
  };
  const stages = {};
  const latencies = [];

  await retrieval.drainRetrievalIndex();
  const coldStart = usage();
  const coldBegin = process.hrtime.bigint();
  await retrieval.syncRetrievalIndex({});
  const coldSync = usage();
  await retrieval.recall(QUERY_SET[0]);
  latencies.push(msToNumber(process.hrtime.bigint() - coldBegin));
  stages.cold = { before: coldStart, afterSync: coldSync, after: usage(), latencyMs: latencies[0] };

  for (const query of QUERY_SET.slice(1)) {
    const begin = process.hrtime.bigint();
    await retrieval.recall(query);
    latencies.push(msToNumber(process.hrtime.bigint() - begin));
  }
  await retrieval.drainRetrievalIndex();
  stages.warm = { after: usage(), latencyMs: latencies.slice(1) };

  // No-change sync: fingerprint the v2 generation and count writes the runtime performs.
  const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const fingerprint = async () => {
    const walk = async (directory) => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      const rows = [];
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) rows.push(...await walk(full));
        else {
          const stat = await fs.stat(full);
          rows.push(`${path.relative(storeDir, full)}:${stat.size}:${stat.mtimeMs}`);
        }
      }
      return rows;
    };
    return hashOf(Buffer.from((await walk(storeDir)).sort().join("|")));
  };
  const beforeHash = await fingerprint();
  const beforeStat = await fs.stat(path.join(storeDir, "current.json")).catch(() => null);
  const original = { writeFile: fs.writeFile, rename: fs.rename };
  const writes = { writeFile: 0, rename: 0 };
  const inside = (candidate) => String(candidate).startsWith(indexDir);
  fs.writeFile = async (candidate, ...rest) => { if (inside(candidate)) writes.writeFile += 1; return original.writeFile.call(fs, candidate, ...rest); };
  fs.rename = async (from, to, ...rest) => { if (inside(from) || inside(to)) writes.rename += 1; return original.rename.call(fs, from, to, ...rest); };
  try {
    await retrieval.syncRetrievalIndex({});
    await retrieval.syncRetrievalIndex({});
  } finally {
    fs.writeFile = original.writeFile;
    fs.rename = original.rename;
  }
  const afterHash = await fingerprint();
  const afterStat = await fs.stat(path.join(storeDir, "current.json")).catch(() => null);
  stages.noOpSync = {
    writes: writes.writeFile + writes.rename,
    bytes: writes.writeFile === 0 ? 0 : Number(afterStat?.size ?? 0),
    hashUnchanged: beforeHash === afterHash,
    mtimeUnchanged: beforeStat !== null && afterStat !== null && beforeStat.mtimeMs === afterStat.mtimeMs,
  };

  // One real change: append a line to one note.
  const notes = (await fs.readdir(path.join(workspace.vault))).filter((name) => name.endsWith(".md"));
  const target = path.join(workspace.vault, notes[0]);
  await fs.appendFile(target, "\n\nbenchmark-update-line\n", "utf8");
  const updateBegin = process.hrtime.bigint();
  const update = await retrieval.syncRetrievalIndex({});
  stages.singleNoteUpdate = { updated: update.updated, added: update.added, latencyMs: msToNumber(process.hrtime.bigint() - updateBegin), after: usage() };

  await retrieval.drainRetrievalIndex();
  const selfStatus = await readProcStatus("/proc/self/status");
  const hwm = selfStatus ? Number((/VmHWM:\s+(\d+)/u.exec(selfStatus) || [])[1] ?? 0) : 0;
  stages.peakRssBytes = hwm > 0 ? hwm * 1024 : null;
  stages.latency = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), samples: latencies.length };
  return { stages };
}

async function readCgroup() {
  const read = (name) => fs.readFile(path.join("/sys/fs/cgroup", name), "utf8").then((value) => value.trim(), () => null);
  const current = await read("memory.current");
  const peak = await read("memory.peak");
  const events = await read("memory.events");
  return {
    currentBytes: current === null ? null : Number(current),
    peakBytes: peak === null ? null : Number(peak),
    oomKillCount: events === null ? null : Number((/oom_kill (\d+)/u.exec(events) || [])[1] ?? 0),
  };
}

async function gitCommit(root) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("git", ["rev-parse", "HEAD"], { cwd: root }, (error, stdout) => resolve(error ? null : stdout.trim()));
    });
  });
}

/**
 * Runs the benchmark and returns the report. `fixtureRoot` must be an isolated copy;
 * `outputDir` receives `baseline.json` (or the given label) and `environment.json`.
 */
export async function runRetrievalMemoryBenchmark({ fixtureRoot, outputDir, label = "baseline", queries = QUERY_SET, concurrency = 1, env = {} } = {}) {
  if (typeof outputDir !== "string" || outputDir === "") throw new Error("outputDir is required");
  const isolated = assertIsolatedRoot(fixtureRoot, { allowAll: env.allowAll === true });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-bench-"));
  try {
    const copied = await copyFixtureInto(isolated, workspace);
    const child = spawnSync(process.execPath, [SELF, "--child", `--workspace=${workspace}`], {
      encoding: "utf8",
      timeout: env.childTimeoutMs ?? 600000,
      env: { ...process.env, ...env.childEnv },
    });
    if (child.status !== 0) {
      throw new Error(`benchmark child failed (exit ${child.status}): ${(child.stderr || "").trim().slice(-500)}`);
    }
    const measured = JSON.parse(child.stdout);
    const storeDir = path.join(copied.data, "index", "retrieval-index-v2");
    const walkBytes = async (directory) => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      let total = 0;
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) total += await walkBytes(full);
        else total += (await fs.stat(full)).size;
      }
      return total;
    };
    const indexBytes = await fs.stat(storeDir).then(() => walkBytes(storeDir), () => null);
    const report = {
      label,
      generatedAt: new Date().toISOString(),
      commit: await gitCommit(path.resolve(path.dirname(SELF), "..", "..")),
      node: process.version,
      fixture: { root: isolated, vaultNotes: (await fs.readdir(copied.vault)).filter((name) => name.endsWith(".md")).length, queries: queries.length, concurrency },
      index: { bytes: indexBytes, mib: bytesToMiB(indexBytes) },
      cgroup: await readCgroup(),
      stages: measured.stages,
      units: { bytes: "bytes", memory: "bytes", latency: "ms", size: "MiB (1048576 bytes)" },
      unavailable: {},
    };
    if (report.index.bytes === null) report.unavailable.indexSize = "no index file was produced";
    if (report.cgroup.peakBytes === null) report.unavailable.cgroupPeak = "memory.peak is not readable in this environment";
    if (report.stages.peakRssBytes === null) report.unavailable.peakRss = "/proc/self/status VmHWM unavailable";
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    const match = /^--([^=]+)=?(.*)$/u.exec(entry);
    if (match) args[match[1]] = match[2] === "" ? "true" : match[2];
  }
  return args;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  if (args.child === "true") {
    childMeasure({ vault: path.join(args.workspace, "vault"), data: path.join(args.workspace, "data") })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
      });
  } else {
    runRetrievalMemoryBenchmark({ fixtureRoot: args.fixture, outputDir: args.output, label: args.label ?? "baseline" })
      .then((report) => {
        process.stdout.write(`${JSON.stringify({ label: report.label, index: report.index, stages: report.stages, unavailable: report.unavailable }, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
