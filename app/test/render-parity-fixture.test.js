// Focused, offline checks for the Phase 0 render-parity fixture, allowlist and
// harness. These do not need Playwright or a browser: they keep the canonical
// fixture and the explicit allowlist from silently drifting out of sync.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROBES,
  diffSnapshots,
  missingRequiredSnapshots,
  probeDefinitionProblems,
  requiredLiveStates,
  semanticClassChanges,
  snapshotContractProblems,
} from "../scripts/render-parity-phase0.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(appRoot, "test", "fixtures", "render-parity-canonical.md");
const allowlistPath = path.join(appRoot, "test", "fixtures", "render-parity-allowlist.json");
const harnessPath = path.join(appRoot, "scripts", "render-parity-phase0.mjs");

const fixture = fs.readFileSync(fixturePath, "utf8").replace(/\r\n/g, "\n");
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));

test("canonical fixture covers the Phase 0 syntax list exactly once per probe", () => {
  const needles = PROBES.map((probe) => probe.needle).filter(Boolean);
  assert.equal(new Set(needles).size, needles.length, "probe needles must be unique");
  for (const needle of needles) {
    const occurrences = fixture.split(needle).length - 1;
    assert.equal(occurrences, 1, `${needle} must appear exactly once in the fixture`);
  }
});

test("canonical fixture keeps the broader Phase 0 syntax inventory", () => {
  const required = [
    /^# .*HEADING1-MARK/m,
    /^###### .*HEADING6-MARK/m,
    /\*\*STRONG-MARK\*\*/,
    /(?<!\*)\*EM-MARK\*(?!\*)/,
    /~~DEL-MARK~~/,
    /==HL-MARK==/,
    /`ICO-MARK`/,
    /\[LINK-MARK\]\(https:\/\/example\.com\/render-parity\)/,
    /\[\[Target\|WIKI-MARK\]\]/,
    /^> QUOTE-MARK/m,
    /^- \[ \] TASK-MARK/m,
    /^```js$/m,
    /^```$/m,
    /^    indented INDENT-MARK/m,
    /^\| Table head HEADER-MARK/m,
    /^---$/m,
    /\[!NOTE\] CALLOUT-MARK/,
    /!\[\[pixel\.svg\]\]/,
    /FOOTNOTE-MARK\[\^parity-note\]/,
    /^\[\^parity-note\]:/m,
    /%% COMMENT-MARK hidden comment %%/,
    /^---\ntitle: Render parity canonical fixture/m,
  ];
  for (const pattern of required) assert.match(fixture, pattern);
});

test("allowlist is explicit: category, reason and deferred scope are present", () => {
  assert.equal(allowlist.version, 1);
  assert.ok(Number(allowlist.tolerancePx) >= 0);
  assert.ok(Array.isArray(allowlist.deferred) && allowlist.deferred.length > 0);
  assert.ok(Array.isArray(allowlist.entries) && allowlist.entries.length > 0);
  for (const entry of allowlist.entries) {
    assert.ok(typeof entry.category === "string" && entry.category.length > 0, "entry.category");
    assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, "entry.reason");
    assert.ok(Array.isArray(entry.comparisons) && entry.comparisons.length > 0, "entry.comparisons");
    assert.ok(Array.isArray(entry.kinds) && entry.kinds.length > 0, "entry.kinds");
    assert.ok(Array.isArray(entry.fields) && entry.fields.length > 0, "entry.fields");
  }
});

test("deferred probes are named in the allowlist scope", () => {
  const deferredKinds = PROBES.filter((probe) => probe.deferred).map((probe) => probe.kind);
  assert.ok(deferredKinds.length > 0);
  for (const kind of deferredKinds) {
    assert.ok(allowlist.deferred.includes(kind), `${kind} must be listed in allowlist.deferred`);
  }
});

test("Phase 3 probes target the intended Live surface layers", () => {
  const table = PROBES.find((probe) => probe.kind === "table-cell");
  const hr = PROBES.find((probe) => probe.kind === "hr");
  const fenced = PROBES.find((probe) => probe.kind === "code-fenced-lang");
  assert.equal(table?.liveClimb, ".cm-table-cell-editor");
  assert.equal(table?.deferred, true);
  assert.equal(hr?.deferred, undefined);
  assert.deepEqual(hr?.states, ["idle"]);
  assert.equal(fenced?.liveComposite, "fenced-code");
  assert.equal(allowlist.deferred.includes("hr"), false);
});

test("task checkbox paint is gated independently from deferred task-list host structure", () => {
  const task = PROBES.find((probe) => probe.kind === "task-checkbox");
  assert.equal(task?.readerSelector, "#preview .task-list-item-checkbox");
  assert.equal(task?.liveSelector, ".cm-live-task-checkbox");
  assert.equal(task?.deferred, undefined);
  assert.deepEqual(task?.states, ["idle"]);
  assert.equal(allowlist.deferred.includes("task-list"), true);
});

test("required Live states cannot disappear without failing the gate", () => {
  const normal = { kind: "paragraph" };
  assert.deepEqual(requiredLiveStates(normal), ["idle", "active", "selection"]);
  assert.deepEqual(
    missingRequiredSnapshots(normal, {
      "live-idle": { paragraph: { found: true } },
      "live-active": {},
      "live-selection": { paragraph: { found: false } },
    }),
    ["active", "selection"],
  );

  const idleOnly = { kind: "hr", states: ["idle"] };
  assert.deepEqual(requiredLiveStates(idleOnly), ["idle"]);
  assert.deepEqual(
    missingRequiredSnapshots(idleOnly, { "live-idle": { hr: { found: true } } }),
    [],
  );
});

test("required Live state declarations fail closed instead of filtering unknown values", () => {
  assert.throws(
    () => requiredLiveStates({ kind: "bad", states: ["future-state"] }),
    /unknown state/,
  );
  assert.throws(
    () => requiredLiveStates({ kind: "bad", states: [] }),
    /non-empty array/,
  );
  assert.throws(
    () => requiredLiveStates({ kind: "bad", states: ["idle", "idle"] }),
    /duplicates/,
  );
});

test("every render-parity probe carries a non-empty required schema", () => {
  for (const probe of PROBES) {
    assert.deepEqual(probeDefinitionProblems(probe), [], probe.kind);
    assert.ok(probe.schema, probe.kind);
    assert.ok(probe.schema.requiredStyleProps.length > 0, probe.kind);
    assert.ok(probe.schema.requiredMetrics.length > 0, probe.kind);
  }
});

test("unknown composite measurement strategies fail closed", () => {
  const issues = probeDefinitionProblems({
    kind: "bad-composite",
    liveComposite: "mystery-surface",
    schema: {
      requiredStyleProps: ["display"],
      requiredMetrics: ["boxWidth"],
    },
  });
  assert.ok(issues.some((issue) => /unknown liveComposite strategy/.test(issue)));
});

test("strict harness adapter keeps style exact and tolerance only on geometry", () => {
  const styleDrift = diffSnapshots(
    { found: true, style: { fontSize: "16px" }, metrics: {} },
    { found: true, style: { fontSize: "16.25px" }, metrics: {} },
    "paragraph",
    "reader-liveIdle",
    1,
  );
  assert.equal(styleDrift.length, 1);
  assert.equal(styleDrift[0].field, "style.fontSize");
  assert.equal(styleDrift[0].delta, 0.25);

  const geometryDrift = diffSnapshots(
    { found: true, style: {}, metrics: { boxWidth: 100 } },
    { found: true, style: {}, metrics: { boxWidth: 100.75 } },
    "paragraph",
    "reader-liveIdle",
    1,
  );
  assert.deepEqual(geometryDrift, []);

  const rightOnly = diffSnapshots(
    { found: true, style: {}, metrics: {} },
    { found: true, style: {}, metrics: { glyphHeight: 12 } },
    "paragraph",
    "reader-liveIdle",
    1,
  );
  assert.equal(rightOnly.length, 1);
  assert.equal(rightOnly[0].field, "metrics.glyphHeight");
  assert.equal(rightOnly[0].reason, "missing-field");
});

test("semantic classes are compared symmetrically for additions and losses", () => {
  const changes = semanticClassChanges(
    { found: true, liveClasses: ["cm-live-a", "cm-live-b"] },
    { found: true, liveClasses: ["cm-live-b", "cm-live-c"] },
    "paragraph",
    "idle-active",
  );
  assert.deepEqual(
    changes.map((change) => [change.field, change.left, change.right]),
    [
      ["semanticClass.cm-live-a", "present", "absent"],
      ["semanticClass.cm-live-c", "absent", "present"],
    ],
  );
});

test("snapshot contract fails on missing schema fields and all-null required samples", () => {
  const missingSchema = probeDefinitionProblems({ kind: "x", schema: {} });
  assert.ok(missingSchema.some((issue) => /requiredStyleProps/.test(issue)));
  assert.ok(missingSchema.some((issue) => /requiredMetrics/.test(issue)));

  const probe = {
    kind: "x",
    states: ["idle"],
    schema: {
      requiredStyleProps: ["fontSize"],
      requiredMetrics: ["boxWidth"],
    },
  };
  const problems = snapshotContractProblems(probe, {
    found: true,
    style: { fontSize: null },
    metrics: { boxWidth: null },
  });
  assert.deepEqual(problems, [
    { section: "style", field: "fontSize", reason: "null-sample" },
    { section: "metrics", field: "boxWidth", reason: "null-sample" },
  ]);
});


test("harness parses as an ES module", () => {
  execFileSync(process.execPath, ["--check", harnessPath], { stdio: "pipe" });
});
