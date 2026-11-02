import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(TEST_DIR, "..");
const SCRIPT = path.join(APP_DIR, "scripts", "tool-discovery-cost-gate.mjs");

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: APP_DIR,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  });
  assert.equal(result.error, undefined, result.error?.stack || String(result.error || ""));
  assert.equal(result.signal, null, `cost-gate CLI was terminated by ${result.signal}: ${result.stderr}`);
  return result;
}

test("cost-gate real CLI keeps hold as full, writes hold artifacts, and verifies them", { timeout: 180_000 }, async () => {
  const reportRun = runCli(["--json"]);
  assert.equal(reportRun.status, 0, reportRun.stderr);
  const report = JSON.parse(reportRun.stdout);
  assert.equal(report.gate.decision, "hold");
  assert.equal(report.gate.productionDefaultProfile, "full");
  assert.equal(
    report.gate.checks.find((check) => check.id === "default-shrink-readiness")?.pass,
    false,
  );
  assert.ok(
    report.gate.blockers.some((blocker) => blocker.startsWith("default-shrink-readiness:")),
    "hold must name the missing shrink-readiness evidence",
  );

  const outDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-cost-gate-cli-"));
  try {
    const writeRun = runCli(["--write", "--out-dir", outDir]);
    assert.equal(writeRun.status, 0, writeRun.stderr);
    assert.match(writeRun.stdout, /gate hold/);

    const written = JSON.parse(await readFile(path.join(outDir, "cost-gate.json"), "utf8"));
    assert.equal(written.gate.decision, "hold");
    assert.equal(written.gate.productionDefaultProfile, "full");

    const verifyRun = runCli(["--verify", "--out-dir", outDir]);
    assert.equal(verifyRun.status, 0, verifyRun.stderr);
    assert.match(verifyRun.stdout, /verify: ok .*gate hold/);

    const markdownPath = path.join(outDir, "cost-gate.md");
    const markdown = await readFile(markdownPath, "utf8");
    await writeFile(markdownPath, `${markdown}tampered\n`, "utf8");
    const tamperedRun = runCli(["--verify", "--out-dir", outDir]);
    assert.equal(tamperedRun.status, 1, tamperedRun.stderr);
    assert.match(tamperedRun.stdout, /verify: failed/);
    assert.match(tamperedRun.stdout, /cost-gate\.md does not match/);

    const rewriteRun = runCli(["--write", "--out-dir", outDir]);
    assert.equal(rewriteRun.status, 0, rewriteRun.stderr);
    await rm(path.join(outDir, "cost-gate.json"), { force: true });
    const missingRun = runCli(["--verify", "--out-dir", outDir]);
    assert.equal(missingRun.status, 1, missingRun.stderr);
    assert.match(missingRun.stdout, /verify: failed/);
    assert.match(missingRun.stdout, /cost-gate\.json missing or unreadable/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
