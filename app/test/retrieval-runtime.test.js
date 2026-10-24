// B3 — per-Vault retrieval runtime isolation.
//
// Contract: Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置
//   §12  Retrieval runtime (per-Vault state; index content and job state are not shared)
//   §21  MV-I02 cross-vault independence, MV-I04 timers capture the runtime
//   §40  Retrieval / semantic tests (A/B same path different content, independent index,
//        reindex A must not clear B, failure A must not dirty B, capability disabled =>
//        structured response, no silent primary fallback)
//   §43-7 retrieval/index runtime state must not live in a module global
//
// These tests drive two runtimes built from two temp Vaults and assert on observable
// effects (index files, providers called, status payloads) — not on private internals.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { vaultDataKey } from "../src/vault-runtime/descriptor.js";
import { vaultDataPaths } from "../src/vault-runtime/paths.js";
import { createVaultRuntime } from "../src/vault-runtime/runtime.js";
import { DEFAULT_RETRIEVAL_CONFIG, createRetrievalRuntime } from "../src/vault-runtime/retrieval-runtime.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_DIR, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b3-retrieval-"));
const created = [];

after(async () => {
  for (const runtime of created) await runtime.drainRetrievalIndex();
  await fs.rm(scratch, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function runtimeConfig(overrides = {}) {
  return { ...DEFAULT_RETRIEVAL_CONFIG, autoEmbed: false, ...overrides };
}

async function makeVault(name, body) {
  const id = name.toLocaleLowerCase();
  const vaultRoot = path.join(scratch, name, "vault");
  const dataRoot = path.join(scratch, name, "data");
  await fs.mkdir(vaultRoot, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Note.md"), `# ${name}\n\n${body}\n`, "utf8");
  const paths = vaultDataPaths({ primary: false, dataRoot, dataKey: vaultDataKey(id) });
  const vaultRuntime = createVaultRuntime({ descriptor: { id, name, root: vaultRoot, primary: false, writable: true }, paths });
  return { id, vaultRoot, paths, vaultRuntime };
}

/** Vault-local index source: reads this Vault's own Markdown files (no `vault-index.js` coupling). */
function indexProviderFor(vault, calls) {
  return async function getVaultIndex() {
    calls?.push(Date.now());
    const entries = await fs.readdir(vault.vaultRoot, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const absolute = path.join(vault.vaultRoot, entry.name);
      const [content, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
      records.push({
        path: entry.name,
        basename: entry.name.replace(/\.md$/, ""),
        content,
        frontmatter: {},
        tags: [],
        aliases: [],
        links: [],
        revision: `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`,
        stat: { created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() },
      });
    }
    return { records, stats: { notes: records.length } };
  };
}

function makeRuntime(vault, { calls, config = {}, embeddingProvider = null, deps = {} } = {}) {
  const runtime = createRetrievalRuntime({
    vaultRuntime: vault.vaultRuntime,
    embeddingProvider,
    deps: { getVaultIndex: indexProviderFor(vault, calls), retrievalConfig: runtimeConfig(config), ...deps },
  });
  created.push(runtime);
  return runtime;
}

async function readIndex(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("reindexing A never touches B's index file or B's state (contract §40)", async () => {
  const alpha = await makeVault("Alpha", "ALPHA-ONLY-NEEDLE");
  const beta = await makeVault("Beta", "BETA-ONLY-NEEDLE");
  const alphaRuntime = makeRuntime(alpha, { calls: [] });
  const betaRuntime = makeRuntime(beta, { calls: [] });

  const alphaResult = await alphaRuntime.syncRetrievalIndex({ force: true });
  assert.equal(alphaResult.notes, 1);
  assert.equal(alphaResult.added, 1);
  const alphaIndex = await readIndex(alpha.paths.retrievalIndex);
  assert.ok(alphaIndex.notes["Note.md"].chunks.some((chunk) => chunk.text.includes("ALPHA-ONLY-NEEDLE")));

  // B has never been indexed: no file, no in-memory state, no provider call.
  await assert.rejects(fs.readFile(beta.paths.retrievalIndex, "utf8"), (error) => error.code === "ENOENT");
  assert.equal(betaRuntime.retrievalIndexStatusSnapshot(), null);
  assert.equal((await betaRuntime.retrievalIndexStatus()).notes, 0);

  // B's own index is independent and self-contained.
  const betaResult = await betaRuntime.syncRetrievalIndex({ force: true });
  assert.equal(betaResult.notes, 1);
  const betaBytes = await fs.readFile(beta.paths.retrievalIndex, "utf8");
  const betaIndex = JSON.parse(betaBytes);
  assert.ok(betaIndex.notes["Note.md"].chunks.some((chunk) => chunk.text.includes("BETA-ONLY-NEEDLE")));
  assert.ok(!betaBytes.includes("ALPHA-ONLY-NEEDLE"), "B's index must not contain A's content");

  // Re-indexing A (`force`) must leave B's index bytes untouched.
  const alphaAgain = await alphaRuntime.syncRetrievalIndex({ force: true });
  assert.equal(alphaAgain.notes, 1);
  assert.equal(await fs.readFile(beta.paths.retrievalIndex, "utf8"), betaBytes, "reindex A must not rewrite B's index");
  assert.equal(alphaRuntime.indexPath, alpha.paths.retrievalIndex);
  assert.equal(betaRuntime.indexPath, beta.paths.retrievalIndex);
  assert.notEqual(alphaRuntime.indexPath, betaRuntime.indexPath);
});

test("A's index load failure does not make B dirty (contract §40)", async () => {
  const alpha = await makeVault("AlphaFail", "ALPHA-FAIL-NEEDLE");
  const beta = await makeVault("BetaFail", "BETA-FAIL-NEEDLE");
  const betaRuntime = makeRuntime(beta, { calls: [] });
  await betaRuntime.syncRetrievalIndex({ force: true });
  const betaBytes = await fs.readFile(beta.paths.retrievalIndex, "utf8");

  // Corrupt A's index on disk, then build a fresh A runtime so it must actually load it.
  await fs.mkdir(path.dirname(alpha.paths.retrievalIndex), { recursive: true });
  await fs.writeFile(alpha.paths.retrievalIndex, "{ not json", "utf8");
  const logged = [];
  const alphaRuntime = createRetrievalRuntime({
    vaultRuntime: alpha.vaultRuntime,
    deps: { getVaultIndex: indexProviderFor(alpha), retrievalConfig: runtimeConfig(), log: { error: (...args) => logged.push(args.join(" ")) } },
  });
  created.push(alphaRuntime);

  const alphaStatus = await alphaRuntime.retrievalIndexStatus();
  assert.equal(alphaStatus.available, true, "a broken index file degrades to an empty index, not to unavailable");
  assert.equal(alphaStatus.notes, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Retrieval index load failed/);

  // B is untouched by A's failure.
  assert.equal(await fs.readFile(beta.paths.retrievalIndex, "utf8"), betaBytes);
  const betaStatus = await betaRuntime.retrievalIndexStatus();
  assert.equal(betaStatus.notes, 1);
  assert.equal(betaRuntime.retrievalIndexStatusSnapshot().notes, 1);
});

test("an in-flight job on A neither appears in B nor blocks B's queue (MV-I02)", async () => {
  const alpha = await makeVault("AlphaJob", "ALPHA-JOB-NEEDLE");
  const beta = await makeVault("BetaJob", "BETA-JOB-NEEDLE");
  let releaseGate = () => {};
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const alphaCalls = [];
  const alphaRuntime = createRetrievalRuntime({
    vaultRuntime: alpha.vaultRuntime,
    deps: {
      getVaultIndex: async () => {
        alphaCalls.push(Date.now());
        await gate;
        return indexProviderFor(alpha)();
      },
      retrievalConfig: runtimeConfig(),
    },
  });
  created.push(alphaRuntime);
  const betaRuntime = makeRuntime(beta, { calls: [] });

  const job = alphaRuntime.startRetrievalIndex({ force: true });
  assert.equal(job.status, "queued");
  assert.equal(alphaRuntime.retrievalIndexStatusSnapshot(), null);
  await waitFor(() => alphaCalls.length === 1);
  assert.equal((await alphaRuntime.retrievalIndexStatus()).indexJob.status, "queued");

  // While A's job is gated: B has no job, no timer, and its own queue completes.
  assert.equal((await betaRuntime.retrievalIndexStatus()).indexJob, null);
  const betaResult = await betaRuntime.syncRetrievalIndex({ force: true });
  assert.equal(betaResult.notes, 1);
  assert.equal(alphaRuntime.retrievalIndexStatusSnapshot().notes, 0, "A must not have published its content while gated");

  releaseGate();
  await alphaRuntime.drainRetrievalIndex();
  const alphaStatus = await alphaRuntime.retrievalIndexStatus();
  assert.equal(alphaStatus.indexJob.status, "completed");
  assert.equal(alphaStatus.notes, 1);
});

test("A's refresh timer and 10s throttle fire only A (MV-I04, contract §12)", async () => {
  const alpha = await makeVault("AlphaTimer", "ALPHA-TIMER-NEEDLE");
  const beta = await makeVault("BetaTimer", "BETA-TIMER-NEEDLE");
  const alphaCalls = [];
  const betaCalls = [];
  const alphaRuntime = makeRuntime(alpha, { calls: alphaCalls, config: { refreshDebounceMs: 20 } });
  const betaRuntime = makeRuntime(beta, { calls: betaCalls, config: { refreshDebounceMs: 20 } });

  alphaRuntime.scheduleRetrievalRefresh();
  assert.equal(alphaRuntime.retrievalIndexStatusSnapshot(), null);
  assert.equal(betaRuntime.retrievalIndexStatusSnapshot(), null);
  await delay(150);
  assert.equal(betaCalls.length, 0, "A's timer must not refresh B while it fires");
  await alphaRuntime.drainRetrievalIndex();

  assert.equal(alphaCalls.length, 1, "A's own timer must refresh A exactly once");
  assert.equal(alphaRuntime.retrievalIndexStatusSnapshot().notes, 1);
  assert.equal(betaRuntime.retrievalIndexStatusSnapshot(), null, "B must stay unloaded");
  await assert.rejects(fs.readFile(beta.paths.retrievalIndex, "utf8"), (error) => error.code === "ENOENT");
  assert.ok((await readIndex(alpha.paths.retrievalIndex)).notes["Note.md"]);

  // `lastRefreshAt` is per instance: A's second refresh inside the 10s window is throttled,
  // while B's first refresh still starts a job.
  const alphaSecond = alphaRuntime.requestRetrievalRefresh();
  assert.equal(alphaSecond.status, "completed");
  assert.equal(alphaCalls.length, 1, "A's throttled refresh must not call the provider again");
  const betaFirst = betaRuntime.requestRetrievalRefresh();
  assert.equal(betaFirst.status, "queued");
  await betaRuntime.drainRetrievalIndex();
  assert.equal(betaCalls.length, 1, "B's throttle state is independent of A's");
});

test("capability disabled returns a structured unavailable and never another Vault's index (§12/§40)", async () => {
  const alpha = await makeVault("AlphaDisabled", "ALPHA-ONLY-NEEDLE");
  const beta = await makeVault("BetaDisabled", "BETA-ONLY-NEEDLE");
  const alphaRuntime = makeRuntime(alpha, { calls: [] });
  await alphaRuntime.syncRetrievalIndex({ force: true });
  assert.ok((await readIndex(alpha.paths.retrievalIndex)).notes["Note.md"]);

  // (a) No index provider injected: the retrieval capability itself is unavailable.
  const noProvider = createRetrievalRuntime({ vaultRuntime: beta.vaultRuntime, embeddingProvider: null, deps: {} });
  created.push(noProvider);
  assert.equal(noProvider.capability.available, false);
  assert.equal(typeof noProvider.capability.reason, "string");
  assert.equal(noProvider.capability.reason.length > 0, true);
  const status = await noProvider.retrievalIndexStatus();
  assert.equal(status.available, false);
  assert.equal(status.reason, noProvider.capability.reason);
  assert.equal(status.path, beta.paths.retrievalIndex, "the status must name this Vault's own index path");
  assert.equal(status.notes, 0);
  assert.equal(status.indexJob, null);
  assert.equal(noProvider.retrievalIndexStatusSnapshot(), null);
  assert.equal(noProvider.semanticCapability().available, false);

  const recalled = await noProvider.recall("ALPHA-ONLY-NEEDLE");
  assert.equal(recalled.available, false);
  assert.equal(recalled.unavailable, true);
  assert.deepEqual(recalled.results, []);
  assert.equal(recalled.totalCandidates, 0);
  assert.equal(recalled.index.available, false);
  // The caller's own query is echoed back; every other field must carry no content at all.
  const { query: _echoedQuery, ...rest } = recalled;
  const serialized = JSON.stringify(rest);
  assert.ok(!serialized.includes("ALPHA-ONLY-NEEDLE"), "a disabled Vault must never return another Vault's content");
  assert.ok(!serialized.includes("BETA-ONLY-NEEDLE"), "and must not invent content of its own either");
  await assert.rejects((async () => {
    await noProvider.syncRetrievalIndex({ force: true });
    return fs.readFile(beta.paths.retrievalIndex, "utf8");
  })(), (error) => error.code === "ENOENT", "a disabled runtime must not create or read an index file");
  assert.equal(noProvider.startRetrievalIndex({ force: true }).status, "unavailable");
  assert.equal(noProvider.requestRetrievalRefresh().status, "unavailable");
  assert.equal(noProvider.scheduleRetrievalRefresh().status, "unavailable");

  // (b) Index provider without an embedding provider: semantic is structured-unavailable,
  // lexical retrieval still works and stays inside B.
  const noEmbeddings = createRetrievalRuntime({
    vaultRuntime: beta.vaultRuntime,
    embeddingProvider: null,
    deps: { getVaultIndex: indexProviderFor(beta), retrievalConfig: runtimeConfig() },
  });
  created.push(noEmbeddings);
  assert.equal(noEmbeddings.capability.available, true);
  const semantic = noEmbeddings.semanticCapability();
  assert.equal(semantic.available, false);
  assert.equal(typeof semantic.reason, "string");
  await noEmbeddings.syncRetrievalIndex({ force: true });
  const betaRecall = await noEmbeddings.recall("BETA-ONLY-NEEDLE");
  assert.equal(betaRecall.semanticUsed, false);
  assert.equal(betaRecall.index.semanticCapability.available, false);
  assert.ok(betaRecall.results.some((result) => result.path === "Note.md"), "lexical recall must keep working");
  assert.ok(!JSON.stringify(betaRecall).includes("ALPHA-ONLY-NEEDLE"), "B's recall must not surface A's content");
  await noEmbeddings.drainRetrievalIndex();
});

// ---------------------------------------------------------------------------
// Source ratchet: the moved state must not reappear as module-level state, and the new
// Vault-dependent modules must not reach for process config or the global path constants
// (§43-5 / §43-7; brief §1.4 item 5).
// ---------------------------------------------------------------------------

const RUNTIME_MODULES = Object.freeze([
  "src/vault-runtime/retrieval-runtime.js",
  "src/vault-runtime/retrieval-rank.js",
  "src/vault-runtime/retrieval-status.js",
]);

function blankCommentsAndStrings(source) {
  let out = "";
  let index = 0;
  let state = "code";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; out += "  "; index += 2; continue; }
      if (char === "/" && next === "*") { state = "block"; out += "  "; index += 2; continue; }
      if (char === "'" || char === '"' || char === "`") { state = char; out += char; index += 1; continue; }
      out += char; index += 1; continue;
    }
    if (state === "line") { out += char === "\n" ? char : " "; if (char === "\n") state = "code"; index += 1; continue; }
    if (state === "block") { out += char === "\n" ? char : " "; if (char === "*" && next === "/") { state = "code"; index += 2; continue; } index += 1; continue; }
    if (char === "\\") { out += "  "; index += 2; continue; }
    if (char === state) { state = "code"; out += char; index += 1; continue; }
    out += char === "\n" ? char : " ";
    index += 1;
  }
  return out;
}

const GLOBAL_PATH_CONSTANTS = Object.freeze(["VAULT", "DATA_PATH", "TRASH_PATH", "HISTORY_PATH", "RETRIEVAL_INDEX_PATH"]);

test("retrieval runtime modules hold no module-level state and read no config/env", async () => {
  for (const relative of RUNTIME_MODULES) {
    const source = await fs.readFile(path.join(APP_ROOT, relative), "utf8");
    const code = blankCommentsAndStrings(source);

    const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(!/(^|\/)config\.js$/.test(specifier), `${relative} must not import config.js (got ${specifier})`);
      assert.ok(specifier !== "node:process", `${relative} must not import node:process`);
    }
    assert.ok(!code.includes("process.env"), `${relative} must not read process.env`);
    for (const name of GLOBAL_PATH_CONSTANTS) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(code), `${relative} must not reference the global ${name}`);
    }

    // Module scope only: no `let`/`var`, no mutable container initialization. (Function-local
    // declarations are indented, so the column-0 anchors only see module-level statements.)
    const moduleScope = code.split("\n").filter((line) => /^(export\s+)?(let|var)\s/.test(line) || /^(export\s+)?const\s+\w+\s*=\s*(new\s+(Map|Set|WeakMap|WeakSet|Array)\b|\[|\{)/.test(line));
    assert.deepEqual(moduleScope, [], `${relative} must not declare module-level mutable state: ${moduleScope.join(" | ")}`);
  }
});

test("purity scanner self-proof: it flags a module-level `let`, an env read and a config import", () => {
  const fixture = ['import { VAULT } from "./config.js";', "let shared = 1;", "const t = `${process.env.X}`;", ""].join("\n");
  const code = blankCommentsAndStrings(fixture);
  assert.equal(code.split("\n").length, fixture.split("\n").length, "the scanner must preserve line structure");
  assert.deepEqual(code.split("\n").filter((line) => /^(export\s+)?(let|var)\s/.test(line)).length, 1);
  assert.ok(!code.includes("process.env"), "template bodies are blanked");
  assert.ok(!code.includes("config.js"), "the module specifier is blanked");
  assert.match(fixture, /from\s*["']\.\/config\.js["']/);
});
