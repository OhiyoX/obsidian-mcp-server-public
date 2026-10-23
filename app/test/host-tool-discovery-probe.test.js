import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EVIDENCE_KINDS,
  EVIDENCE_TIERS,
  EVIDENCE_VERIFICATION,
  MATRIX_JSON_PATH,
  MATRIX_MARKDOWN_PATH,
  STATIC_SCANS,
  buildMatrix,
  globToRegExp,
  normalizeNewlines,
  parseCodexFeatures,
  parseScanSpecs,
  redactSecrets,
  renderMarkdown,
  resolveCollectionFiles,
  runStaticScans,
  scanBufferForMarkers,
  staticScanDigest,
  validateMatrix,
} from "../scripts/probe-host-tool-discovery.mjs";
import { registerObsidianCapabilities } from "../src/capabilities.js";

const matrix = buildMatrix();

// Descriptors registered after the frozen 85-tool host-matrix baseline. The baseline
// artifact is historical evidence and is never regenerated; new tools are named here.
const ADDITIVE_SINCE_MATRIX_BASELINE = ["get_note_context", "read_archive_entry", "list_base_views", "patch_base", "create_base_entry"];

test("host matrix declares the required dimensions and a controlled vocabulary", () => {
  assert.equal(matrix.schemaVersion, "1.1.0");
  assert.equal(matrix.readOnly, true);
  assert.equal(matrix.status, "candidate");
  assert.equal(matrix.hosts.length, 7);
  for (const host of matrix.hosts) {
    assert.ok(host.cells.toolDiscoveryMode, `${host.id} has no toolDiscoveryMode`);
    assert.ok(host.cells.nativeSchemaAutoLoad, `${host.id} has no nativeSchemaAutoLoad`);
    assert.ok(host.cells.listRefresh, `${host.id} has no listRefresh`);
    assert.ok(host.cells.crossSession, `${host.id} has no crossSession`);
  }
});

test("host matrix passes validation and honesty rules", () => {
  const validation = validateMatrix(matrix);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  for (const host of matrix.hosts) {
    const mode = host.cells.toolDiscoveryMode;
    if (mode.value === "real") {
      assert.ok(
        ["runtime-observed", "artifact-declared"].includes(mode.tier),
        `${host.id}: real requires an observed or artifact tier, got ${mode.tier}`,
      );
      assert.ok(mode.evidence.length > 0, `${host.id}: real without evidence`);
    }
    if (mode.value === "documented-only") {
      assert.equal(mode.tier, "documentation-only");
    }
  }
});

test("a fabricated supported-only claim is rejected by validation", () => {
  const broken = buildMatrix();
  broken.hosts[0].cells.toolDiscoveryMode = {
    value: "real",
    tier: "documentation-only",
    evidence: [],
    note: "fabricated",
  };
  const validation = validateMatrix(broken);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => /real requires/.test(error)));
});

test("checked-in matrix JSON and Markdown match the authored data", async () => {
  const [json, markdown] = await Promise.all([
    readFile(MATRIX_JSON_PATH, "utf8"),
    readFile(MATRIX_MARKDOWN_PATH, "utf8"),
  ]);
  assert.equal(normalizeNewlines(json), `${JSON.stringify(matrix, null, 2)}\n`);
  assert.equal(normalizeNewlines(markdown), renderMarkdown(matrix));
});

test("matrix build is deterministic across repeated calls", () => {
  assert.equal(JSON.stringify(buildMatrix()), JSON.stringify(matrix));
});

test("every evidence reference resolves and each tier is documented", () => {
  const evidenceIds = new Set(Object.keys(matrix.evidence));
  for (const [id, entry] of Object.entries(matrix.evidence)) {
    assert.equal(entry.id, id);
    assert.equal(typeof entry.summary, "string");
    assert.ok(entry.summary.length > 0, `${id} has an empty summary`);
    assert.ok(EVIDENCE_KINDS.has(entry.kind), `${id} has an unknown kind ${entry.kind}`);
    assert.ok(entry.verification in EVIDENCE_VERIFICATION, `${id} has an unknown verification ${entry.verification}`);
  }
  for (const host of matrix.hosts) {
    for (const cell of Object.values(host.cells)) {
      for (const id of cell.evidence) assert.ok(evidenceIds.has(id), `unresolved evidence ${id}`);
      assert.ok(cell.tier in EVIDENCE_TIERS, `undocumented tier ${cell.tier}`);
    }
  }
});

test("static marker scan is deterministic and reproduces counts on a synthetic artifact", () => {
  const tokens = ["tool_search", "defer_loading", "list_changed"];
  const buffer = Buffer.from("x tool_search y tool_search z defer_loading list_changed list_changed");
  const counts = scanBufferForMarkers(buffer, tokens);
  assert.deepEqual(counts, { tool_search: 2, defer_loading: 1, list_changed: 2 });
  assert.deepEqual(scanBufferForMarkers(buffer, tokens), counts);
});

test("recorded static scans carry a digest that recomputes from the recorded counts", () => {
  for (const scan of Object.values(matrix.staticScans)) {
    assert.equal(scan.digest, staticScanDigest(scan), `${scan.id} digest mismatch`);
    assert.deepEqual(Object.keys(scan.counts).sort(), [...scan.tokens].sort(), `${scan.id} count/token mismatch`);
  }
  assert.ok(Object.keys(matrix.staticScans).length > 0);
});

test("tampering with a recorded marker count fails digest validation", () => {
  const broken = buildMatrix();
  const [firstId] = Object.keys(broken.staticScans);
  const [firstToken] = broken.staticScans[firstId].tokens;
  broken.staticScans[firstId].counts[firstToken] += 1;
  const validation = validateMatrix(broken);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => /digest mismatch/.test(error)), validation.errors.join("\n"));
});

test("tier must be justified by a matching evidence kind", () => {
  const runtimeOnly = buildMatrix();
  const primeHost = runtimeOnly.hosts.find((host) => host.cells.toolDiscoveryMode.tier === "artifact-declared");
  primeHost.cells.toolDiscoveryMode = {
    value: "real",
    tier: "runtime-observed",
    evidence: ["codex-features-list"], // command-output only, no runtime evidence
    note: "fabricated runtime tier from static evidence",
  };
  const validation = validateMatrix(runtimeOnly);
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => /requires at least one evidence kind/.test(error)),
    validation.errors.join("\n"),
  );
});

test("artifact-declared tier cannot cite runtime-only evidence", () => {
  const broken = buildMatrix();
  broken.hosts[0].cells.toolDiscoveryMode = {
    value: "real",
    tier: "artifact-declared",
    evidence: ["pi-session-observation"], // runtime-session only
    note: "fabricated",
  };
  const validation = validateMatrix(broken);
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => /cannot cite runtime-session evidence/.test(error)),
    validation.errors.join("\n"),
  );
});

test("non-reproducible runtime and command observations are explicit external attestations", () => {
  const session = matrix.evidence["pi-session-observation"];
  assert.equal(session.kind, "runtime-session");
  assert.equal(session.verification, "external-attestation");
  assert.equal(matrix.evidence["codex-features-list"].verification, "external-attestation");
  assert.equal(matrix.evidence["server-tools-listchanged"].verification, "repository-test");
  const attested = Object.values(matrix.evidence).filter((entry) => entry.verification === "external-attestation");
  assert.ok(attested.length > 0);
  for (const entry of attested) assert.equal(entry.scanId, undefined, `${entry.id} must not carry a digest scanId`);
});

test("server tools.listChanged capability is reproduced by an in-process handshake", async () => {
  const server = new McpServer({ name: "host-matrix-probe", version: "1.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "host-matrix-probe-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const capabilities = client.getServerCapabilities();
    assert.equal(capabilities?.tools?.listChanged, true);
    const { tools } = await client.listTools();
    // Historical host-matrix baseline is 85. The count assertion stays anchored to the frozen
    // baseline plus the explicit additive descriptors instead of regenerating live evidence.
    assert.equal(tools.length, matrix.serverBaseline.catalogTools + ADDITIVE_SINCE_MATRIX_BASELINE.length);
    for (const name of ADDITIVE_SINCE_MATRIX_BASELINE) {
      assert.ok(tools.some((tool) => tool.name === name), `${name} must be registered`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("--scan re-scans a local artifact against the recorded counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-matrix-scan-"));
  try {
    const scanId = "cursor-workbench-3.21.16";
    const scan = STATIC_SCANS[scanId];
    const fixture = scan.tokens.map((token) => `${token} `.repeat(scan.counts[token])).join("");
    const artifactPath = path.join(dir, "synthetic-workbench.js");
    await writeFile(artifactPath, fixture, "utf8");
    const specs = parseScanSpecs(["--scan", `${scanId}=${artifactPath}`]);
    assert.deepEqual(specs, [{ scanId, filePath: artifactPath }]);
    const [result] = await runStaticScans(specs);
    assert.equal(result.ok, true, JSON.stringify(result.mismatches));
    assert.equal(result.expectedDigest, result.actualDigest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only the declared multi-file scan carries a collection descriptor", () => {
  const collections = Object.values(matrix.staticScans).filter((scan) => scan.collection);
  assert.deepEqual(
    collections.map((scan) => scan.id),
    ["gemini-cli-bundle-0.57.0"],
  );
  assert.equal(collections[0].collection.kind, "glob");
  assert.equal(collections[0].collection.pattern, "chunk-*.js");
  assert.equal(matrix.staticScanRecipeVersion, "1.1.0");
});

test("static-scan digest binds the collection descriptor and ignores display-only fields", () => {
  const base = { artifact: "x", tokens: ["a", "b"], counts: { a: 1, b: 2 } };
  const single = staticScanDigest(base);
  assert.equal(staticScanDigest({ ...base, collection: undefined }), single);
  assert.equal(staticScanDigest({ ...base, collection: null }), single);
  const glob = { kind: "glob", pattern: "chunk-*.js" };
  const withCollection = staticScanDigest({ ...base, collection: glob });
  assert.notEqual(withCollection, single);
  assert.equal(staticScanDigest({ ...base, collection: { ...glob, note: "display only" } }), withCollection);
  assert.notEqual(staticScanDigest({ ...base, collection: { ...glob, pattern: "other-*.js" } }), withCollection);
});

test("collection resolution sorts and dedupes matched files", async () => {
  const entries = [
    { name: "chunk-b.js", isFile: () => true },
    { name: "chunk-a.js", isFile: () => true },
    { name: "chunk-b.js", isFile: () => true },
    { name: "chunk-a.js.map", isFile: () => true },
    { name: "notes.txt", isFile: () => true },
    { name: "chunk-c.js", isFile: () => false },
  ];
  const files = await resolveCollectionFiles("/bundle", { pattern: "chunk-*.js" }, { readDirectory: async () => entries });
  assert.deepEqual(files.map((file) => path.basename(file)), ["chunk-a.js", "chunk-b.js"]);
  const reversed = await resolveCollectionFiles(
    "/bundle",
    { pattern: "chunk-*.js" },
    { readDirectory: async () => [...entries].reverse() },
  );
  assert.deepEqual(reversed, files);
  await assert.rejects(
    () => resolveCollectionFiles("/bundle", { pattern: "missing-*.js" }, { readDirectory: async () => entries }),
    /no files matched/,
  );
});

test("collection glob only honours the documented wildcard shape", () => {
  assert.equal(globToRegExp("chunk-*.js").test("chunk-abc.js"), true);
  assert.equal(globToRegExp("chunk-*.js").test("chunk-.js"), true);
  assert.equal(globToRegExp("chunk-*.js").test("chunk-abc.ts"), false);
  assert.equal(globToRegExp("chunk-?.js").test("chunk-a.js"), true);
  assert.equal(globToRegExp("chunk-?.js").test("chunk-ab.js"), false);
  assert.equal(globToRegExp("chunk-*.js").test("nested/chunk-a.js"), false);
});

test("--scan aggregates a multi-file collection in stable sorted order", async () => {
  const scans = {
    "synthetic-bundle": {
      artifact: "synthetic bundle",
      collection: { kind: "glob", pattern: "chunk-*.js" },
      tokens: ["includeTools", "excludeTools"],
      counts: { includeTools: 3, excludeTools: 1 },
    },
  };
  const contents = {
    "chunk-b.js": "includeTools includeTools excludeTools",
    "chunk-a.js": "includeTools",
  };
  const [result] = await runStaticScans([{ scanId: "synthetic-bundle", filePath: "/bundle" }], {
    scans,
    readDirectory: async () => [
      { name: "chunk-b.js", isFile: () => true },
      { name: "chunk-a.js", isFile: () => true },
      { name: "chunk-b.js", isFile: () => true },
    ],
    readArtifact: async (file) => Buffer.from(contents[path.basename(file)], "latin1"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
  assert.deepEqual(result.matchedFiles, ["chunk-a.js", "chunk-b.js"]);
  assert.equal(result.collectionPattern, "chunk-*.js");
  assert.equal(result.expectedDigest, result.actualDigest);
  assert.match(result.filesDigest, /^[0-9a-f]{64}$/);
});

test("--scan re-derives the Gemini collection counts from a real directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-matrix-gemini-"));
  try {
    const scanId = "gemini-cli-bundle-0.57.0";
    const scan = STATIC_SCANS[scanId];
    const half = (value) => Math.floor(value / 2);
    const build = (part) =>
      scan.tokens
        .map((token) => {
          const total = scan.counts[token];
          const start = part === 0 ? 0 : half(total);
          const end = part === 0 ? half(total) : total;
          return `${token} `.repeat(end - start);
        })
        .join("");
    // Written out of lexical order to prove the scan sorts, and one file is
    // repeated across the collection boundary.
    await writeFile(path.join(dir, "chunk-b.js"), build(1), "utf8");
    await writeFile(path.join(dir, "chunk-a.js"), build(0), "utf8");
    await writeFile(path.join(dir, "index.js"), scan.tokens.join(" "), "utf8");
    const [result] = await runStaticScans([{ scanId, filePath: dir }]);
    assert.equal(result.ok, true, JSON.stringify(result.mismatches));
    assert.deepEqual(result.matchedFiles, ["chunk-a.js", "chunk-b.js"]);
    assert.equal(result.expectedDigest, result.actualDigest);
    assert.match(result.filesDigest, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a collection scan rejects a single file path", async () => {
  const [result] = await runStaticScans([{ scanId: "gemini-cli-bundle-0.57.0", filePath: "/path/to/one-chunk.js" }], {
    readDirectory: async () => {
      throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /expects a directory/);
});

test("server baseline records the list-changed capability with an evidence id", () => {
  assert.equal(matrix.serverBaseline.catalogTools, 85);
  assert.equal(matrix.serverBaseline.toolsListChangedCapability, true);
  assert.ok(matrix.evidence[matrix.serverBaseline.toolsListChangedEvidence[0]]);
});

test("not-available hosts are disjoint from classified hosts", () => {
  const classified = new Set(matrix.hosts.map((host) => host.id));
  for (const id of matrix.notAvailableHosts) {
    assert.ok(!classified.has(id), `${id} is both classified and not-available`);
  }
  assert.ok(matrix.notAvailableHosts.includes("claude-code"));
});

test("parseCodexFeatures reads stage and effective state", () => {
  const parsed = parseCodexFeatures(
    [
      "tool_search                              removed            false",
      "tool_search_always_defer_mcp_tools      removed            true",
      "skill_search                             stable             true",
      "  not a feature line",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.map((row) => [row.name, row.stage, row.enabled]),
    [
      ["tool_search", "removed", false],
      ["tool_search_always_defer_mcp_tools", "removed", true],
      ["skill_search", "stable", true],
    ],
  );
});

test("redactSecrets removes credential-like values", () => {
  const redacted = redactSecrets("key sk-FAKE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ token=abc");
  assert.ok(!redacted.includes("sk-FAKE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  assert.match(redacted, /\[redacted\]/);
});
