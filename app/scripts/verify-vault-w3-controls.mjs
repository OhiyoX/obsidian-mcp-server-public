// Each assigned real violation must fail unchanged assertions, followed by unmodified green.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { ownsW3DataPath, assertW3DataPath, cleanupW3DataPath } from "../test/helpers/vault-w3-data-path.js";
assertW3DataPath();
// Keep the explicit caller-path gate; the only other accepted root is fixture-owned.
if (!ownsW3DataPath) assert.equal(path.resolve(process.env.DATA_PATH), path.resolve(".data-local"), "explicit app/.data-local DATA_PATH required");
const modes = ["map-write", "set-write", "old-handle", "generation", "collision", "identity", "gate"];
const logDir = path.join(path.resolve(process.env.DATA_PATH), "w3-control-evidence");
fs.mkdirSync(logDir, { recursive: true });
function run(args, mode, name) {
  const result = spawnSync(process.execPath, args, { env: { ...process.env, W3_TEST_CONTROL: mode }, encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const evidence = `COMMAND W3_TEST_CONTROL=${mode} node ${args.join(" ")}\n${output}\nEXIT=${result.status}\n`;
  fs.writeFileSync(path.join(logDir, `${name}.log`), evidence); process.stdout.write(evidence);
  assert.equal(result.error, undefined, "load/process/timeout error is not a behavior counterexample");
  assert.equal(result.signal, null, "signal termination is not a behavior counterexample");
  return { status: result.status, output };
}
try {
for (const [index, mode] of modes.entries()) {
  const args = ["--import", "./test/helpers/vault-w3-source-hook.mjs", "--test", "--test-reporter=spec",
    `--test-name-pattern=^NC${index + 1} `, "test/vault-w3-negative-controls.test.js"];
  const { status, output } = run(args, mode, `negative-${mode}`);
  assert.equal(status, 1, `${mode} must fail unchanged assertions`);
  assert.match(output, new RegExp(`INJECTED ${mode}`)); assert.match(output, new RegExp(`NC${index + 1} `));
  assert.match(output, /AssertionError|ERR_ASSERTION/, "red must be a behavior assertion, not load/syntax/fixture failure");
  assert.match(output, /tests 1\b/); assert.match(output, /pass 0\b/); assert.match(output, /fail 1\b/);
  assert.match(output, /cancelled 0\b/); assert.match(output, /skipped 0\b/);
  const green = run(args, "clean", `green-${mode}`);
  assert.equal(green.status, 0, `NC${index + 1} unmodified production must pass`);
  assert.match(green.output, /tests 1\b/); assert.match(green.output, /pass 1\b/);
  assert.match(green.output, /fail 0\b/); assert.match(green.output, /skipped 0\b/);
  assert.doesNotMatch(green.output, /INJECTED/);
}
const args = ["--test", "--test-reporter=spec", "test/vault-w3-negative-controls.test.js"];
const clean = run(args, "clean", "negative-green");
assert.equal(clean.status, 0, "unmodified production must pass every assertion");
assert.match(clean.output, /tests 7\b/); assert.match(clean.output, /pass 7\b/);
assert.match(clean.output, /fail 0\b/); assert.match(clean.output, /skipped 0\b/);
} finally {
  await cleanupW3DataPath();
}
