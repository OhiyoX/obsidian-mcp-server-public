import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  answerMatchesExpect,
  buildPiArgs,
  buildServerEnv,
  DEFAULT_OUT,
  EVIDENCE_LIMITS,
  EVIDENCE_METRICS,
  EVIDENCE_POLICY,
  evaluateTaskMatch,
  extractFinalText,
  generateEphemeralKey,
  normalizeAnswer,
  normalizeToolName,
  parsePiRecords,
  renderEvidenceMarkdown,
  resolvePiCli,
  scrubText,
  scrubValue,
  summarizeToolTrace,
} from "../scripts/host-bridge-evidence.mjs";

test("generateEphemeralKey returns a prefixed, high-entropy, non-repeating secret", () => {
  const first = generateEphemeralKey();
  const second = generateEphemeralKey();
  assert.match(first, /^hostbridge-[0-9a-f]{48}$/);
  assert.notEqual(first, second);
  assert.equal(generateEphemeralKey().length, first.length);
});

test("buildPiArgs never carries the API key in argv", () => {
  const secret = generateEphemeralKey();
  const args = buildPiArgs({
    piCli: "/opt/pi/cli.js",
    extensionPath: "/home/user/.pi/agent/extensions/obsidian-mcp/index.ts",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    prompt: "What is the status value?",
  });
  assert.equal(args[0], "/opt/pi/cli.js");
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("-e"));
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("-nbt"));
  assert.ok(!args.some((arg) => arg.includes(secret)));
  assert.ok(!args.some((arg) => arg.includes("OBSIDIAN_MCP_API_KEY")));
});

test("buildServerEnv passes the key only as a spawn env value and forces read-only", () => {
  const secret = generateEphemeralKey();
  const env = buildServerEnv({
    baseEnv: { PATH: "/usr/bin", LANG: "C" },
    port: 6011,
    vault: "/tmp/vault",
    data: "/tmp/data",
    apiKey: secret,
    profile: "full",
    toolsets: "",
  });
  assert.equal(env.API_KEY, secret);
  assert.equal(env.OBSIDIAN_READ_ONLY, "true");
  assert.equal(env.OAUTH_ENABLED, "false");
  assert.equal(env.EMBEDDING_PROVIDER, "disabled");
  assert.equal(env.GIT_ENABLED, "false");
  assert.equal(env.LANG, "C");
  assert.equal(env.MCP_DISCOVERY_PROFILE, "full");
});

test("parsePiRecords ignores partial/streamed lines", () => {
  const text = '{"type":"a"}\n{"type":"b"\n\n  {"type":"c"}\nnot json';
  const records = parsePiRecords(text);
  assert.deepEqual(
    records.map((record) => record.type),
    ["a", "c"],
  );
});

test("normalizeToolName strips the extension prefix", () => {
  assert.equal(normalizeToolName("mcp_obsidian_get_note"), "get_note");
  assert.equal(normalizeToolName("get_note"), "get_note");
});

test("summarizeToolTrace counts announced tools and enforces the read-only guard", () => {
  const records = [
    {
      type: "message_start",
      message: {
        sections: {
          tools: "<tools>\n- mcp_obsidian_get_note: get_note — read\n- mcp_obsidian_write_note: write_note — write\n- mcp_obsidian_search_notes: search_notes — read",
        },
      },
    },
    { type: "tool_execution_start", toolName: "mcp_obsidian_get_note" },
    { type: "tool_execution_start", toolName: "mcp_obsidian_search_notes" },
  ];
  // The server reports raw MCP names; the host reports prefixed names.
  const summary = summarizeToolTrace(records, {
    readOnlyNames: ["get_note", "search_notes"],
  });
  assert.equal(summary.announcedToolCount, 3);
  assert.equal(summary.executedToolCallCount, 2);
  assert.deepEqual(summary.mutationCalls, []);
  assert.equal(summary.readOnlyGuardPassed, true);

  const violating = summarizeToolTrace(
    [...records, { type: "tool_execution_start", toolName: "mcp_obsidian_write_note" }],
    { readOnlyNames: ["get_note", "search_notes"] },
  );
  assert.deepEqual(violating.mutationCalls, ["mcp_obsidian_write_note"]);
  assert.equal(violating.readOnlyGuardPassed, false);
});

test("extractFinalText returns the last assistant text block", () => {
  const records = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "active" }] } },
  ];
  assert.equal(extractFinalText(records), "active");
});

test("scrubText and scrubValue remove the secret everywhere", () => {
  const secret = generateEphemeralKey();
  assert.equal(scrubText(`key=${secret} tail`, secret), "key=[REDACTED] tail");
  const scrubbed = scrubValue({ nested: [secret, { deep: secret }], keep: 1 }, secret);
  assert.deepEqual(scrubbed, { nested: ["[REDACTED]", { deep: "[REDACTED]" }], keep: 1 });
  assert.equal(JSON.stringify(scrubbed).includes(secret), false);
});

test("resolvePiCli prefers PI_CLI and otherwise scans PATH", () => {
  assert.equal(resolvePiCli({ env: { PI_CLI: "/custom/cli.js" }, exists: (p) => p === "/custom/cli.js" }), "/custom/cli.js");
  const pathSep = path.delimiter;
  const expected = path.join(
    "/opt/pi",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  const found = resolvePiCli({ env: { PATH: `/opt/pi${pathSep}/usr/bin` }, exists: (p) => p === expected });
  assert.equal(found, expected);
  assert.equal(resolvePiCli({ env: { PATH: "/usr/bin" }, exists: () => false }), null);
});

test("renderEvidenceMarkdown summarizes runs without a secret", () => {
  const markdown = renderEvidenceMarkdown({
    schemaVersion: "1.0.0",
    host: { provider: "opencode-go", model: "deepseek-v4.1-flash", piCliVersion: "0.99.2", nodeVersion: "v22", bridge: "custom" },
    mutationGuard: { tool: "write_note", denied: true, fileCreated: false },
    runs: [
      {
        taskId: "full-roadmap-status",
        profile: "full",
        toolsets: "",
        status: "ok",
        taskMatch: true,
        latencyMs: 1234,
        catalog: { count: 86, readOnlyCount: 40, schemaBytes: 1000 },
        host: { announcedToolCount: 86, executedToolCallCount: 1, mutationCalls: [], readOnlyGuardPassed: true },
      },
    ],
    limits: ["bounded"],
  });
  assert.match(markdown, /full-roadmap-status/);
  assert.match(markdown, /\| 86 \| 40 \| 1 \| 0 \| pass \| yes \| 1234 \| ok \|/);
  assert.match(markdown, /denied=`true`, fileCreated=`false`/);
  // Requested provider/model is labelled, not presented as provider-attested.
  assert.match(markdown, /requested provider\/model/);
  assert.match(markdown, /not provider-attested identity/);
  // The membership guard is labelled as post-hoc, not an execution gate.
  assert.match(markdown, /POST-HOC assertion/);
  assert.match(markdown, /manage_publish/);
});

test("normalizeAnswer / answerMatchesExpect require an exact value and reject negations", () => {
  assert.equal(normalizeAnswer("  ACTIVE. "), "active");
  assert.equal(normalizeAnswer("Yes!"), "yes");
  assert.equal(answerMatchesExpect("active", "active"), true);
  assert.equal(answerMatchesExpect("  Active. ", "active"), true);
  assert.equal(answerMatchesExpect("Yes", "yes"), true);
  // A negation or superstring must NOT be accepted as the expected value.
  assert.equal(answerMatchesExpect("inactive", "active"), false);
  assert.equal(answerMatchesExpect("yesterday", "yes"), false);
  assert.equal(answerMatchesExpect("not active", "active"), false);
  assert.equal(answerMatchesExpect("the status is active", "active"), false);
  assert.equal(answerMatchesExpect("no", "yes"), false);
  assert.equal(answerMatchesExpect("", "yes"), false);
  assert.equal(answerMatchesExpect("yes", ""), false);
});

test("evaluateTaskMatch requires an exact answer AND an actual executed tool call", () => {
  assert.equal(evaluateTaskMatch({ answer: "active", expect: "active", executedToolCallCount: 1 }), true);
  assert.equal(evaluateTaskMatch({ answer: "Yes", expect: "yes", executedToolCallCount: 2 }), true);
  // Model self-report with an empty trace is not a validated success.
  assert.equal(evaluateTaskMatch({ answer: "active", expect: "active", executedToolCallCount: 0 }), false);
  // Exact match but a negation is still not a success.
  assert.equal(evaluateTaskMatch({ answer: "inactive", expect: "active", executedToolCallCount: 1 }), false);
  assert.equal(evaluateTaskMatch({ answer: "yesterday", expect: "yes", executedToolCallCount: 2 }), false);
});

test("committed Phase 3 artifact is consistent and regenerates its Markdown exactly", async () => {
  const json = JSON.parse(await readFile(DEFAULT_OUT, "utf8"));
  const markdown = await readFile(DEFAULT_OUT.replace(/\.json$/, ".md"), "utf8");
  // The Markdown is a pure function of the JSON (no hand-edited divergence);
  // trailing newlines and CRLF checkouts are normalized before comparison.
  assert.equal(
    renderEvidenceMarkdown(json).trim(),
    markdown.replace(/\r\n/g, "\n").trim(),
  );

  // Requested provider/model is reported as a configured alias, never as an
  // attested identity or a provider payload measurement.
  assert.equal(json.host.requestedProvider, "opencode-go");
  assert.equal(json.host.requestedModel, "deepseek-v4.1-flash");
  assert.match(json.host.providerModelProvenance, /configured/i);
  assert.equal(json.host.provider, undefined);
  assert.equal(json.host.model, undefined);

  assert.equal(json.runs.length, 3);
  for (const run of json.runs) {
    assert.equal(run.catalog.count, run.host.announcedToolCount);
    assert.equal(run.host.executedToolCallCount, run.host.executedToolCalls.length);
    // schemaBytes is the whole serialized array: descriptor sum + `count + 1`
    // framing bytes. Recording both prevents reading it as schema drift.
    assert.equal(run.catalog.descriptorBytesSum, run.catalog.schemaBytes - run.catalog.count - 1);
    assert.match(run.catalog.schemaBytesScope, /framing/i);
    // Success is recomputed with the strict validator (exact answer + >=1 call).
    assert.equal(
      run.taskMatch,
      answerMatchesExpect(run.answer, run.expect) && run.host.executedToolCallCount > 0,
    );
    assert.equal(run.taskMatch, true);
    assert.equal(run.host.readOnlyGuardPassed, true);
    assert.equal(run.host.mutationCalls.length, 0);
  }

  // The mutation probe is the specific write_note result, not a blanket claim.
  assert.equal(json.mutationGuard.tool, "write_note");
  assert.equal(json.mutationGuard.denied, true);
  assert.equal(json.mutationGuard.fileCreated, false);
  // The committed labels are exactly the harness's declared labels (no drift).
  assert.deepEqual(json.policy, EVIDENCE_POLICY);
  assert.deepEqual(json.metrics, EVIDENCE_METRICS);
  assert.deepEqual(json.limits, [...EVIDENCE_LIMITS]);
  assert.ok(json.limits.some((line) => /manage_publish/.test(line)));
  assert.ok(json.limits.some((line) => /different prompt/.test(line)));
});
