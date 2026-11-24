// O1: the output-cost baseline must be a *measurement*, not an estimate.
// These tests pin the three properties later tasks depend on:
//   1. counting the same fixed sample twice gives the same numbers;
//   2. text and structured bytes are measured on their own channels and add up
//      to `bytes` exactly, as the script documents;
//   3. a sample with no Host receipt reports `null` injected tokens with a
//      reason — never a byte/4 "token count".
// The fixture Vault is synthetic (see FIXTURE_FILES in the script); no real note
// body is read, written or printed here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EVENTS,
  FIXTURE_FILES,
  NO_RECEIPT_REASON,
  RECEIPT_SOURCE,
  cleanupBaselineVault,
  measureBaseline,
  measureResult,
  resolveToolName,
  stabilizeResult,
  withFrozenClock,
} from "../scripts/mcp-output-cost-baseline.mjs";

test.after(async () => cleanupBaselineVault());

const settled = (rows) => rows.map(({ elapsedMs, ...rest }) => rest);

test("counting the same fixed sample twice gives the same numbers", async () => {
  const first = await measureBaseline();
  const second = await measureBaseline();
  assert.equal(first.length, DEFAULT_EVENTS.length);
  assert.equal(second.length, DEFAULT_EVENTS.length);
  assert.ok(first.every((row) => row.status === "ok"), JSON.stringify(first));
  assert.deepEqual(settled(first), settled(second));
  assert.ok(first.every((row) => Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0));
});

test("only the index's runtime bookkeeping is normalized, never the payload's content (#732)", () => {
  // The normalizer exists because every search rebuilds the index, so `durationMs`, `lastRefresh` and
  // a counting `publicationRevision` change between two calls of the same query. If it ever grows to
  // touch content fields, the baseline would stop measuring the payload — this is that boundary.
  const payload = {
    results: [{ path: "A.md", matchCount: 1 }],
    totalScanned: 4,
    index: {
      files: 4, reparsed: 0, reused: 4, removed: 0, skipped: 0,
      durationMs: 12, lastRefresh: "2026-11-19T17:22:36.495Z",
      publicationRevision: 3, snapshotGeneration: 7, vaultGeneration: 2,
      freshness: "clean", coverage: { includeHidden: false, completeness: "complete", skipped: 0 },
    },
  };
  const stable = stabilizeResult({ content: [{ type: "text", text: "whatever" }], structuredContent: payload });
  for (const key of ["durationMs", "lastRefresh", "publicationRevision", "snapshotGeneration", "vaultGeneration"]) {
    assert.equal(stable.structuredContent.index[key], null, `${key} is runtime state and must be neutralized`);
  }
  for (const key of ["files", "reparsed", "reused", "removed", "skipped", "freshness", "coverage"]) {
    assert.deepEqual(stable.structuredContent.index[key], payload.index[key], `${key} is payload content and must survive`);
  }
  assert.deepEqual(stable.structuredContent.results, payload.results);
  assert.equal(stable.structuredContent.totalScanned, 4);
  // The text channel must describe the SAME normalized payload, or the two channels would disagree.
  assert.deepEqual(JSON.parse(stable.content[0].text), stable.structuredContent);

  // A result with no index block is passed through untouched: other tools' payloads are not ours to edit.
  const plain = { content: [{ type: "text", text: "x" }], structuredContent: { notes: [], totalCount: 0 } };
  assert.equal(stabilizeResult(plain), plain);
});

test("the measurement freezes the clock, and restores it afterwards (#732)", async () => {
  // The flake this guards against: a measured result carries the index's own timing, so two passes of
  // the same sample differed by one byte (`durationMs` 9 -> 10) and the bytes looked unstable. The
  // device must be a real freeze — `Date.now()` AND `new Date()` — and it must not leak: a frozen
  // clock left in place would silently pin every later suite's timestamps.
  const before = Date.now();
  const seen = await withFrozenClock(() => ({ now: Date.now(), stamped: new Date().toISOString() }));
  assert.equal(seen.now, seen.stamped ? Date.parse(seen.stamped) : NaN, "the frozen clock must agree with itself");
  assert.equal(new Date(seen.stamped).toISOString(), seen.stamped);
  assert.ok(Math.abs(Date.now() - before) < 60_000, "the real clock must be back in place after the callback");
  assert.notEqual(seen.now, before, "inside the callback the clock is the fixed instant, not the real one");
  // …and the freeze really is inside the measurement, not only in this test.
  const first = await measureBaseline();
  const second = await measureBaseline();
  assert.deepEqual(settled(first), settled(second));
});

test("text and structured bytes are measured per channel and add up to bytes", async () => {
  // ASCII text block + compact structured JSON: '{"a":1}' is 7 bytes.
  const both = measureResult({ content: [{ type: "text", text: "abc" }], structuredContent: { a: 1 } });
  assert.deepEqual(both, { textBytes: 3, structuredBytes: 7, bytes: 10 });
  // UTF-8 bytes, not characters: two CJK characters are 6 bytes, not 2.
  assert.equal(measureResult({ content: [{ type: "text", text: "笔记" }] }).textBytes, 6);
  // Each channel alone, and a result with an empty text block.
  assert.deepEqual(measureResult({ structuredContent: { a: 1 } }), { textBytes: 0, structuredBytes: 7, bytes: 7 });
  assert.deepEqual(measureResult({ content: [{ type: "text", text: "" }] }), { textBytes: 0, structuredBytes: 0, bytes: 0 });

  const rows = await measureBaseline();
  for (const row of rows) assert.equal(row.bytes, row.textBytes + row.structuredBytes, row.trialId);
  // The channels are genuinely separate: the native `ok()` result carries the
  // pretty-printed JSON as text AND the same data as structuredContent.
  const full = rows.find((row) => row.trialId === "get-note-full");
  assert.ok(full.textBytes > 0 && full.structuredBytes > 0);
  assert.ok(full.textBytes > full.structuredBytes, "pretty-printed text is larger than compact structured JSON");
  // Every row reports both channels as integers, never as one merged number.
  assert.ok(rows.every((row) => Number.isSafeInteger(row.textBytes) && Number.isSafeInteger(row.structuredBytes)));
});

test("a sample with no Host receipt reports null tokens and a reason, never an estimate", async () => {
  const rows = await measureBaseline();
  for (const row of rows) {
    assert.equal(row.resultInjectedTokens, null, row.trialId);
    assert.equal(row.schemaInjectedTokens, null, row.trialId);
    assert.equal(row.source, NO_RECEIPT_REASON, row.trialId);
    // The forbidden shortcut: bytes/4 dressed up as a measurement.
    assert.notEqual(row.resultInjectedTokens, Math.ceil(row.bytes / 4));
    assert.equal("estimatedTokens" in row, false);
  }
});

test("tokens come from a Host receipt only, and a malformed receipt is refused", async () => {
  const trialId = DEFAULT_EVENTS[0].trialId;
  const rows = await measureBaseline({ receipts: { [trialId]: { resultInjectedTokens: 1234, schemaInjectedTokens: 99 } } });
  const receipted = rows.filter((row) => row.trialId === trialId);
  assert.equal(receipted.length, 1);
  assert.equal(receipted[0].resultInjectedTokens, 1234);
  assert.equal(receipted[0].schemaInjectedTokens, 99);
  assert.equal(receipted[0].source, RECEIPT_SOURCE);
  assert.ok(rows.filter((row) => row.trialId !== trialId).every((row) => row.resultInjectedTokens === null && row.source === NO_RECEIPT_REASON));

  for (const bad of [
    { resultInjectedTokens: 1.5, schemaInjectedTokens: 1 },
    { resultInjectedTokens: 1, schemaInjectedTokens: -1 },
    { resultInjectedTokens: "1", schemaInjectedTokens: 1 },
    { resultInjectedTokens: 1 },
  ]) {
    await assert.rejects(measureBaseline({ receipts: { [trialId]: bad } }), /receipt/i, JSON.stringify(bad));
  }
});

test("the routed wire name resolves to its native action, and every fixture note is marked synthetic", () => {
  assert.equal(DEFAULT_EVENTS.filter((event) => event.action === "get_note").length, 4, "full/content/section/document-map");
  assert.equal(resolveToolName({ tool: "obsidian_read_read", action: "get_note" }), "get_note");
  assert.equal(resolveToolName({ tool: "server_info" }), "server_info");
  const bodies = Object.entries(FIXTURE_FILES).filter(([relative]) => relative.endsWith(".md")).map(([, body]) => body);
  assert.ok(bodies.length > 0);
  assert.ok(bodies.every((body) => body.includes("synthetic")), "a fixture note is not labelled synthetic");
});
