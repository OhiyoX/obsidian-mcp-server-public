#!/usr/bin/env node
// O1 — output-cost baseline: what one successful MCP call costs in BYTES.
//
// Later token-optimization tasks must prove a reduction without inventing token
// numbers, so this harness measures the one thing it can measure exactly: the
// bytes of the MCP result a Host receives, split by channel. Token counts are
// copied from a Host receipt when one exists; otherwise they stay `null` with a
// stated reason. `ceil(bytes / 4)` is never written as a token count — a byte
// heuristic is not a measurement.
//
// Byte accounting (the sum is exact by construction):
//   textBytes       = UTF-8 bytes of every `type:"text"` content block's `text`
//   structuredBytes = UTF-8 bytes of JSON.stringify(result.structuredContent),
//                     0 when the result carries no structuredContent
//   bytes           = textBytes + structuredBytes
// Both channels travel over the transport on the same call: the native `ok()`
// result (src/result.js) carries the pretty-printed JSON as text AND the same
// data as structuredContent, so both are counted. The JSON framing keys
// (`content`, `type`, `structuredContent`, `isError`) are NOT counted: no Host
// injects those keys into the model context.
//
// Boundaries:
//   * the Vault is a SYNTHETIC fixture built in a fresh temp dir — no real note
//     is ever read, and no note body is printed or written by this script;
//   * one native registry, one search/retrieval implementation: the calls go
//     through `registerObsidianCapabilities` over InMemoryTransport, exactly as
//     the existing tests drive the server;
//   * no tokenizer, no embedding provider, no network;
//   * the environment is read once per process, so one process measures one
//     fixture Vault (`measureBaseline` reuses it, and says so if asked to move).
//
// Usage:
//   node scripts/mcp-output-cost-baseline.mjs [--out baseline.jsonl]
//   node scripts/mcp-output-cost-baseline.mjs --receipts receipts.json
// `--receipts` takes `{ "<trialId>": { "resultInjectedTokens": n,
// "schemaInjectedTokens": n } }` — the Host's own numbers, never derived here.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const AUTHOR = "app/scripts/mcp-output-cost-baseline.mjs";

// The token fields say where their numbers came from, one short reason each.
export const RECEIPT_SOURCE = "host-receipt: injected tokens as reported by the Host";
export const NO_RECEIPT_REASON =
  "no-host-receipt: unknown, no Host injected-token receipt for this trial (bytes are measured; ceil(bytes/4) is not a token count)";

// SYNTHETIC Vault fixture. Every note says so in its own body, so a copied
// fixture can never be mistaken for a real note. Nothing here is derived from
// any real Vault: the paths, tags and sentences are invented for measurement.
export const FIXTURE_FILES = Object.freeze({
  ".obsidian/app.json": JSON.stringify({ legacyEditor: false, newLinkFormat: "absolute" }, null, 2) + "\n",
  "Projects/Atlas.md": [
    "---",
    'title: "Atlas (synthetic fixture)"',
    "type: project",
    "tags: [baseline, synthetic]",
    "aliases: [Atlas, Project Atlas]",
    "status: active",
    "---",
    "# Atlas",
    "",
    "Synthetic fixture note for the output-cost baseline. Alpha keyword body.",
    "",
    "## Decisions",
    "",
    "The decision section carries a paragraph of invented text so that a section",
    "read returns a real-sized answer with a heading, a link and a list.",
    "",
    "- one decision with a [[Projects/Beacon]] link",
    "- a second decision, synthetic",
    "",
    "## Risks",
    "",
    "Invented risk text for the section form: alpha keyword, beta keyword.",
    "",
    "## Log",
    "",
    "A short line per invented day, synthetic fixture content only.",
    "",
  ].join("\n"),
  "Projects/Beacon.md": [
    "---",
    'title: "Beacon (synthetic fixture)"',
    "type: note",
    "tags: [baseline, synthetic]",
    "---",
    "# Beacon",
    "",
    "Synthetic fixture companion note. It links back to [[Projects/Atlas]] so that",
    "the context bundle has one backlink to bound.",
    "",
    "## Notes",
    "",
    "alpha keyword in an invented sentence, synthetic fixture only.",
    "",
  ].join("\n"),
  "Notes/Index.md": [
    "---",
    "title: Index (synthetic fixture)",
    "tags: [baseline, synthetic]",
    "---",
    "# Index",
    "",
    "Synthetic fixture index. Links: [[Projects/Atlas]], [[Projects/Beacon]].",
    "",
  ].join("\n"),
  "Notes/Unrelated.md": [
    "# Unrelated (synthetic fixture)",
    "",
    "Synthetic fixture filler, used only so that result sets stay partial",
    "instead of always covering the whole Vault.",
    "",
  ].join("\n"),
});

const QUERY = "alpha keyword";

// The fixed sample: the read shapes people actually pay for. `tool` is the
// routed wire name the Host sees (`obsidian_read_read` and friends, built in
// src/compact-tools.js) and `action` is the native tool it carries, so
// `resolveToolName` needs no second registry.
export const DEFAULT_EVENTS = Object.freeze([
  { trialId: "get-note-full", tool: "obsidian_read_read", action: "get_note", profile: "full", host: "baseline", model: "none", params: { path: "Projects/Atlas.md", format: "full" } },
  { trialId: "get-note-content", tool: "obsidian_read_read", action: "get_note", profile: "full", host: "baseline", model: "none", params: { path: "Projects/Atlas.md", format: "content" } },
  { trialId: "get-note-section", tool: "obsidian_read_read", action: "get_note", profile: "full", host: "baseline", model: "none", params: { path: "Projects/Atlas.md", format: "section", section: "Decisions", sectionType: "heading" } },
  { trialId: "get-note-document-map", tool: "obsidian_read_read", action: "get_note", profile: "full", host: "baseline", model: "none", params: { path: "Projects/Atlas.md", format: "document-map" } },
  { trialId: "search-notes", tool: "obsidian_search_read", action: "search_notes", profile: "full", host: "baseline", model: "none", params: { query: QUERY } },
  { trialId: "recall", tool: "obsidian_search_read", action: "recall", profile: "full", host: "baseline", model: "none", params: { query: QUERY, semantic: false } },
  { trialId: "get-note-context", tool: "obsidian_read_read", action: "get_note_context", profile: "full", host: "baseline", model: "none", params: { path: "Projects/Atlas.md" } },
]);

const UTF8 = new TextEncoder();
const RECEIPT_INT = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Strip the payload's own runtime bookkeeping before measuring, and only that (#732).
 *
 * Measured 2026-11-20: every `search_notes` call rebuilds the Vault index, so the response's `index`
 * block carries a fresh `durationMs`, `lastRefresh` and a `publicationRevision` that counts up
 * (2, 3, 4, 5 on four identical queries against an unchanged fixture). Two passes of the SAME sample
 * therefore differed by a byte — `publicationRevision` 9 -> 10 — which is the last flake at the
 * pinned gate concurrency. Those fields are the server's state, not the payload's content, so a cost
 * baseline replaces them with a placeholder instead of counting them; everything else, including the
 * rest of the `index` block (`files`, `reparsed`, `reused`, `freshness`, `coverage`), is measured
 * unchanged.
 */
const INDEX_RUNTIME_KEYS = Object.freeze(["durationMs", "lastRefresh", "publicationRevision", "snapshotGeneration", "vaultGeneration"]);

export function stabilizeResult(result) {
  const structured = result?.structuredContent;
  if (!structured || typeof structured !== "object" || !structured.index || typeof structured.index !== "object") return result;
  const index = { ...structured.index };
  for (const key of INDEX_RUNTIME_KEYS) if (key in index) index[key] = null;
  const stable = { ...structured, index };
  // `ok()` sends the same data twice: pretty-printed JSON as text, compact JSON as structuredContent.
  // Re-deriving the text keeps the two channels describing ONE payload after normalization.
  return { ...result, content: [{ type: "text", text: JSON.stringify(stable, null, 2) }], structuredContent: stable };
}

/** UTF-8 byte length, the only unit used here. */
export function byteLength(value) {
  return UTF8.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

/**
 * Measure one MCP result per channel. `bytes` is the exact sum of the two
 * channels, so a later task can point at the channel it shrank.
 */
export function measureResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  let textBytes = 0;
  for (const block of blocks) {
    if (block?.type === "text") textBytes += byteLength(String(block.text ?? ""));
  }
  const structuredBytes = result?.structuredContent === undefined ? 0 : byteLength(result.structuredContent);
  return { textBytes, structuredBytes, bytes: textBytes + structuredBytes };
}

/** The routed wire name carries the group; the action is the native tool name. */
export function resolveToolName(event) {
  return typeof event?.action === "string" && event.action ? event.action : event?.tool;
}

function receiptFor(receipts, trialId) {
  const receipt = receipts?.[trialId];
  if (receipt === undefined) return null;
  if (!RECEIPT_INT(receipt?.resultInjectedTokens) || !RECEIPT_INT(receipt?.schemaInjectedTokens)) {
    throw new Error(`Malformed Host receipt for trial ${trialId}: resultInjectedTokens and schemaInjectedTokens must be non-negative integers; this harness will not derive them`);
  }
  return { resultInjectedTokens: receipt.resultInjectedTokens, schemaInjectedTokens: receipt.schemaInjectedTokens };
}

/** One JSONL row: the identity of the sample, then only measured values. */
export function buildRecord(event, response, elapsedMs, receipts) {
  const receipt = receiptFor(receipts, event.trialId);
  return {
    trialId: event.trialId,
    tool: event.tool,
    action: event.action ?? null,
    profile: event.profile ?? null,
    status: response?.isError === true ? "error" : "ok",
    ...measureResult(response),
    resultInjectedTokens: receipt ? receipt.resultInjectedTokens : null,
    schemaInjectedTokens: receipt ? receipt.schemaInjectedTokens : null,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    source: receipt ? RECEIPT_SOURCE : NO_RECEIPT_REASON,
  };
}

let configured = null;

async function configureFixtureVault() {
  if (configured) return configured;
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-output-cost-baseline-"));
  const vault = path.join(root, "vault");
  const data = path.join(root, "data");
  for (const [relative, body] of Object.entries(FIXTURE_FILES)) {
    const absolute = path.join(vault, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, body, "utf8");
  }
  // Module-level environment: config/vault/retrieval read it at import time, so
  // it must be set before the first `import("../src/...")` and cannot change
  // afterwards. One process therefore measures one fixture Vault.
  process.env.VAULT_PATH = vault;
  process.env.DATA_PATH = data;
  process.env.HISTORY_PATH = path.join(data, "history");
  process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
  process.env.RETRIEVAL_AUTO_EMBED = "false";
  process.env.EMBEDDING_PROVIDER = "disabled";
  process.env.GIT_ENABLED = "false";
  process.env.OBSIDIAN_READ_ONLY = "true";
  process.env.API_KEY = "";
  process.env.OAUTH_ENABLED = "false";
  const { registerObsidianCapabilities } = await import("../src/capabilities.js");
  const { syncRetrievalIndex } = await import("../src/retrieval.js");
  await syncRetrievalIndex({ force: true, embeddings: false });
  configured = { root, vault, registerObsidianCapabilities };
  return configured;
}

async function withClient(callback) {
  const { registerObsidianCapabilities } = await configureFixtureVault();
  const server = new McpServer({ name: "mcp-output-cost-baseline", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "mcp-output-cost-baseline-client", version: "1" });
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

// Determinism device (#732). A measured result carries wall-clock facts: the index reports how long
// its last refresh took and when it ran, so two passes of the SAME sample can differ by a byte — the
// flake measured 2026-11-20 at the pinned gate concurrency was exactly that (`index.durationMs`
// 9 -> 10, +1 byte on each channel). A byte baseline must not inherit clock noise, so the clock is
// frozen while a sample is measured and restored afterwards. `performance.now()` is untouched: the
// per-trial `elapsedMs` is still a real measurement.
const FROZEN_NOW = Date.UTC(2026, 0, 1);

export async function withFrozenClock(callback) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [FROZEN_NOW] : args));
    }
    static now() {
      return FROZEN_NOW;
    }
  }
  globalThis.Date = FrozenDate;
  try {
    return await callback();
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * Measure the fixed sample against the synthetic fixture Vault.
 *
 * A warm-up pass runs the whole sample unmeasured first: the memory-guidance
 * layer appends a one-time reminder text block to the first read of a session,
 * and that session state must not land inside a measured sample.
 */
export async function measureBaseline({ events = DEFAULT_EVENTS, receipts = {} } = {}) {
  // Fail on a bad receipt before doing any work.
  for (const event of events) receiptFor(receipts, event.trialId);
  const records = await withFrozenClock(() => withClient(async (client) => {
    for (const event of events) await client.callTool({ name: resolveToolName(event), arguments: event.params });
    const rows = [];
    for (const event of events) {
      const started = performance.now();
      const response = await client.callTool({ name: resolveToolName(event), arguments: event.params });
      rows.push(buildRecord(event, stabilizeResult(response), performance.now() - started, receipts));
    }
    return rows;
  }));
  return records;
}

/** JSONL: one JSON object per measured sample, in sample order. */
export function toJsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/** Remove the fixture Vault. Only the CLI calls this; a test keeps it warm. */
export async function cleanupBaselineVault() {
  if (!configured) return;
  const { root } = configured;
  await rm(root, { recursive: true, force: true });
  configured = null;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const receiptsPath = argumentValue("--receipts");
  const receipts = receiptsPath ? JSON.parse(await readFile(receiptsPath, "utf8")) : {};
  const outPath = argumentValue("--out");
  const jsonl = toJsonl(await measureBaseline({ receipts }));
  if (outPath) await writeFile(outPath, jsonl, "utf8");
  else process.stdout.write(jsonl);
  process.stderr.write(`${AUTHOR}: ${jsonl.split("\n").length - 1} samples measured\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } finally {
    await cleanupBaselineVault();
  }
}
