import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import {
  DEFAULT_FIXTURE_PATH,
  buildReport,
  formatReport,
  loadFixtures,
  validateFixtures,
} from "../scripts/tool-discovery-eager.mjs";

const fixtureFile = await loadFixtures(DEFAULT_FIXTURE_PATH);
const report = await buildReport(DEFAULT_FIXTURE_PATH);
const tasks = fixtureFile.tasks;

test("eager baseline declares 30-50 unique, well-formed task fixtures", () => {
  assert.ok(tasks.length >= 30 && tasks.length <= 50, `fixture count ${tasks.length} outside 30-50`);
  const ids = tasks.map((task) => task.taskId);
  assert.equal(new Set(ids).size, ids.length, "taskIds must be unique");
  for (const task of tasks) {
    assert.equal(typeof task.request, "string");
    assert.ok(task.request.trim().length > 0, `${task.taskId} has an empty request`);
    assert.ok(["en", "zh", "mixed"].includes(task.language), `${task.taskId} has an unknown language`);
  }
  assert.equal(report.validation.ok, true, report.validation.errors.join("\n"));
});

test("every expected and alternative tool name resolves against current TOOL_NAMES", () => {
  const known = new Set(TOOL_NAMES);
  for (const task of tasks) {
    assert.ok(task.expectedTools.length > 0, `${task.taskId} has no expected tools`);
    for (const name of [...task.expectedTools, ...task.alternativeTools]) {
      assert.ok(known.has(name), `${task.taskId} references unknown tool ${name}`);
    }
  }
});

test("the baseline covers every required task category", () => {
  const required = [
    "note-read-write-metadata",
    "search-recall",
    "links-graph-tasks-templates-bases",
    "files",
    "memory-skills",
    "git",
    "publish",
    "plan-apply-recovery",
    "negative-authorization",
    "bootstrap-context",
  ];
  const covered = new Set(tasks.map((task) => task.category));
  for (const category of required) assert.ok(covered.has(category), `missing category ${category}`);
  assert.deepEqual(fixtureFile.categories.slice().sort(), required.slice().sort());
});

test("every fixture records forbidden tool categories and safety expectations", () => {
  for (const task of tasks) {
    assert.ok(task.forbiddenToolCategories.length > 0, `${task.taskId} has no forbidden categories`);
    assert.ok(task.safetyExpectations.length > 0, `${task.taskId} has no safety expectation`);
    for (const category of task.forbiddenToolCategories) {
      assert.ok(fixtureFile.forbiddenToolCategories.includes(category), `${task.taskId} unknown forbidden category ${category}`);
    }
    for (const expectation of task.safetyExpectations) {
      assert.ok(fixtureFile.safetyExpectations.includes(expectation), `${task.taskId} unknown safety expectation ${expectation}`);
    }
  }
});

test("read-only fixtures never require a write-scoped tool", () => {
  const writeScoped = new Set(TOOL_NAMES.filter((name) => (MCP_TOOL_SCOPE_REQUIREMENTS[name] || []).includes("obsidian.write")));
  assert.ok(writeScoped.size > 0, "expected some write-scoped tools to exist");
  for (const task of tasks) {
    if (!task.safetyExpectations.includes("read-only")) continue;
    for (const name of [...task.expectedTools, ...task.alternativeTools]) {
      assert.ok(!writeScoped.has(name), `${task.taskId} read-only fixture references write-scoped ${name}`);
    }
  }
});

test("runner reports the real eager catalog size and schema-size methodology", () => {
  assert.equal(report.catalog.toolCount, TOOL_NAMES.length);
  assert.equal(report.catalog.matchesToolNames, true);
  assert.equal(report.catalog.tools.length, TOOL_NAMES.length);
  assert.equal(report.catalog.descriptorBytes, report.catalog.tools.reduce((sum, tool) => sum + tool.descriptorBytes, 0));
  assert.equal(report.catalog.inputSchemaBytes, report.catalog.tools.reduce((sum, tool) => sum + tool.inputSchemaBytes, 0));
  assert.equal(report.catalog.outputSchemaBytes, report.catalog.tools.reduce((sum, tool) => sum + tool.outputSchemaBytes, 0));
  assert.ok(report.catalog.descriptorBytes > report.catalog.inputSchemaBytes + report.catalog.outputSchemaBytes);
  assert.match(report.catalog.measurement, /utf8 byte length/i);
  assert.match(report.catalog.measurement, /no tokenization/i);
});

test("runner report is deterministic across repeated builds", async () => {
  const second = await buildReport(DEFAULT_FIXTURE_PATH);
  assert.equal(JSON.stringify(second), JSON.stringify(report));
});

test("runner marks agent success and latency as unmeasured", () => {
  const unmeasured = report.unmeasured.join(" ").toLowerCase();
  assert.match(unmeasured, /end-to-end agent task success/);
  assert.match(unmeasured, /latency/);
  assert.ok(!report.measured.join(" ").toLowerCase().includes("latency"));
  assert.equal(report.readOnly, true);
  assert.match(formatReport(report), /Unmeasured:/);
});
