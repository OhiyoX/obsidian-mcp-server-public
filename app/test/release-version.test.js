import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// DATA_PATH must be set before the module graph resolves config.js.
const dataDir = mkdtempSync(path.join(tmpdir(), "release-version-"));
process.env.DATA_PATH = dataDir;
process.env.MCP_SERVER_VERSION = "0.0.0-local";
const { deployedVersion, formatDeployTime, releaseFooterLines, versionLabel } = await import("../src/release-version.js");
const manifest = path.join(dataDir, "deployed-version.json");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

// Rewrites in the same millisecond would otherwise reuse the cached manifest.
let mtimeBump = 1000;
function writeManifest(text) {
  writeFileSync(manifest, text);
  mtimeBump += 1000;
  const stamp = new Date(Date.now() + mtimeBump);
  utimesSync(manifest, stamp, stamp);
}

test("falls back to the configured version when no deployment manifest exists", () => {
  const release = deployedVersion();
  assert.equal(release.version, "0.0.0-local");
  assert.equal(release.source, "config");
  assert.equal(release.commit, null);
  assert.equal(release.deployedAt, null);
  assert.equal(versionLabel(release), "0.0.0-local");
});

test("reports the release tag and commit written by the deploy script", () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.7", commit: "0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6", deployedAt: "2026-09-25T04:40:00Z" }));
  const release = deployedVersion();
  assert.deepEqual(release, { version: "v2026.09.25.7", commit: "0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6", deployedAt: "2026-09-25T04:40:00Z", source: "deploy" });
  assert.equal(versionLabel(release), "v2026.09.25.7 · 0baca750");
});

test("omits the commit from the compact label when the manifest has none", () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.8" }));
  assert.equal(versionLabel(), "v2026.09.25.8");
});

test("ignores an unreadable or version-less manifest instead of failing", () => {
  for (const text of ["not json", JSON.stringify({ commit: "abc" }), JSON.stringify({ version: "   " }), JSON.stringify(null)]) {
    writeManifest(text);
    assert.equal(deployedVersion().source, "config", `unexpected manifest acceptance for ${text}`);
  }
  rmSync(manifest);
  assert.equal(deployedVersion().source, "config");
});

test("picks up a rewritten manifest for the same deployment path", () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.9", commit: "b".repeat(40) }));
  assert.equal(deployedVersion().version, "v2026.09.25.9");
  writeManifest(JSON.stringify({ version: "v2026.09.26.1", commit: "c".repeat(40) }));
  assert.equal(deployedVersion().version, "v2026.09.26.1");
});

test("formatDeployTime returns null fields and clear label when input is null", () => {
  const result = formatDeployTime(null);
  assert.equal(result.iso, null);
  assert.equal(result.local, null);
  assert.equal(result.label, "未部署 (本地运行)");
});

test("formatDeployTime returns null fields and clear label when input is invalid", () => {
  const result = formatDeployTime("not-a-date");
  assert.equal(result.iso, null);
  assert.equal(result.local, null);
  assert.equal(result.label, "未部署 (本地运行)");
});

test("formatDeployTime formats valid ISO timestamp with the process clock", () => {
  const isoString = "2026-10-10T04:40:07Z";
  const result = formatDeployTime(isoString);
  const date = new Date(isoString);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${offsetSign}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(2, "0")}`;
  const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")} ${offset}`;

  assert.equal(result.iso, isoString);
  assert.equal(result.local, expected);
  assert.ok(result.local.match(/[+-]\d{2}:\d{2}$/), "local should end with timezone offset");
  assert.ok(result.label.includes(result.local), "label should contain local time");
  assert.ok(result.label.includes(isoString), "label should contain ISO string");
});

test("formatDeployTime handles edge case: empty string", () => {
  const result = formatDeployTime("");
  assert.equal(result.iso, null);
  assert.equal(result.local, null);
  assert.equal(result.label, "未部署 (本地运行)");
});

test("formatDeployTime handles edge case: non-string input", () => {
  const result = formatDeployTime(123);
  assert.equal(result.iso, null);
  assert.equal(result.local, null);
  assert.equal(result.label, "未部署 (本地运行)");
});

// #503: the settings footer renders two lines — release identity, then the deploy
// time labelled as the server clock — so the timestamp cannot be misread as the
// visitor's own local time. Beijing display is a browser rewrite of the raw ISO.
test("releaseFooterLines puts the deploy time on its own line and names the server clock", () => {
  writeManifest(JSON.stringify({ version: "v2026.10.10.5", commit: "d55f9f4c102f562090fbadcc319ead14e8cdd24f", deployedAt: "2026-10-10T11:37:33Z" }));
  const lines = releaseFooterLines(deployedVersion());
  assert.equal(lines.release, "v2026.10.10.5 · d55f9f4c");
  assert.match(lines.deploy, /^服务端时间 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  assert.ok(!lines.deploy.includes("北京时间"), "the server face stays on the process clock");
  assert.ok(!lines.deploy.includes("T11:37:33Z"), "the visible line must not fall back to the raw ISO label");
});

// Negative control for #503: with no deployment marker there is no deploy moment to
// attribute, so the footer keeps the bare local-run face and no "server time" claim.
test("releaseFooterLines keeps the bare local-run face when nothing was deployed", () => {
  const lines = releaseFooterLines({ version: "1.0.0", commit: null, deployedAt: null, source: "config" });
  assert.equal(lines.release, "1.0.0");
  assert.equal(lines.deploy, "未部署 (本地运行)");
  assert.ok(!lines.deploy.includes("服务端时间"), "no deploy time means nothing to attribute to the server");
});

// Reverse control: an unparseable timestamp must not be dressed up as a server time.
test("releaseFooterLines never labels an unusable timestamp as server time", () => {
  const lines = releaseFooterLines({ version: "1.0.0", commit: "abc1234", deployedAt: "not-a-timestamp", source: "deploy" });
  assert.equal(lines.deploy, "未部署 (本地运行)");
  assert.ok(!lines.deploy.includes("服务端时间"), "an unusable timestamp must never be dressed up as server time");
});
