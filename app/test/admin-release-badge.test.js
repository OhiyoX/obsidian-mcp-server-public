import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Pin the process timezone before any Date use so "process clock" and "Beijing" are
// distinguishable: production/CI run UTC (+00:00), while the badge must render +08:00.
process.env.TZ = "UTC";

// DATA_PATH must be set before the module graph resolves config.js.
const dataDir = mkdtempSync(path.join(tmpdir(), "admin-release-badge-"));
process.env.DATA_PATH = dataDir;
process.env.MCP_SERVER_VERSION = "0.0.0-local";
const { releaseBadgeHtml } = await import("../src/admin/release-badge.js");
const { formatDeployTime } = await import("../src/release-version.js");
const { formatBeijingDeployLabel } = await import("../frontend/app/features/settings/deploy-time.js");
const shellOverview = await import("../src/admin/pages/overview.js");
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

const DEPLOYED_AT = "2026-09-25T04:40:00Z";
const BEIJING_LABEL = "北京时间 · 2026-09-25 12:40:00 +08:00";

test("the Admin badge renders the deploy time as Beijing time", () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.7", commit: "0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6", deployedAt: DEPLOYED_AT }));
  const badge = releaseBadgeHtml();
  assert.match(badge, /北京时间 · 2026-09-25 12:40:00 \+08:00/);
  assert.match(badge, /commit 0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6/);
  assert.match(badge, /部署版本 <code>v2026\.09\.25\.7<\/code>/);
});

test("the badge uses the same single implementation as the web bundle", () => {
  // Two surfaces, one formatter: the label in the markup must be exactly what the
  // shared frontend module produces for the same raw ISO.
  writeManifest(JSON.stringify({ version: "v2026.09.25.7", deployedAt: DEPLOYED_AT }));
  assert.equal(formatBeijingDeployLabel(DEPLOYED_AT), BEIJING_LABEL);
  assert.ok(releaseBadgeHtml().includes(BEIJING_LABEL), "the badge must reuse the shared formatter verbatim");
});

test("the badge keeps the raw UTC ISO for a later client-side route", () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.7", deployedAt: DEPLOYED_AT }));
  assert.match(releaseBadgeHtml(), /data-deployed-at="2026-09-25T04:40:00Z"/);
});

test("the badge does not fall back to the server (process) clock string", () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.7", deployedAt: DEPLOYED_AT }));
  const badge = releaseBadgeHtml();
  const serverLocal = formatDeployTime(DEPLOYED_AT).local;
  assert.ok(serverLocal, "the server clock rendering must exist for this fixture");
  // With TZ pinned to UTC the server-clock string reads `04:40:00`, i.e. eight hours
  // off the Beijing label. The badge must never carry that rendering.
  assert.equal(serverLocal, "2026-09-25 04:40:00 +00:00", "the pinned-UTC server clock must be the +00:00 rendering");
  assert.equal(badge.includes(serverLocal), false, `the badge must not carry the process-clock string ${serverLocal}`);
  // The raw ISO still appears (inside `data-deployed-at`), which is intended.
  assert.match(badge, /data-deployed-at="2026-09-25T04:40:00Z"/);
});

test("a local run keeps the bare undeployed face and no data attribute", () => {
  rmSync(manifest, { force: true });
  const badge = releaseBadgeHtml();
  assert.match(badge, /部署版本 <code>0\.0\.0-local<\/code>/);
  assert.match(badge, /未部署 \(本地运行\)/);
  assert.equal(badge.includes("data-deployed-at"), false);
  assert.equal(badge.includes("北京时间"), false);
});

// The nail (browser-triage): the badge used to live in a shell strip, and when the greenfield shell
// replaced that strip the module became dead code while its browser scene (DT-2) kept failing on a
// real deployment. The identity now lives in the overview's 部署版本 row — which is the row the
// PROTOTYPE already has, so it costs no shape difference — and this pin is what keeps it from
// silently disappearing again, without a browser and without a deploy manifest.
test("the overview 部署版本 row carries the raw UTC ISO and the shared Beijing label", async () => {
  writeManifest(JSON.stringify({ version: "v2026.09.25.7", commit: "0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6", deployedAt: DEPLOYED_AT }));
  const { renderOverviewPage } = shellOverview;
  const { content: html } = renderOverviewPage({
    model: {
      keyOf: () => null, keyName: () => "—", client: () => null, clientName: () => "—",
      acct: () => null, acctName: () => "—",
    },
    snapshot: { oauthUsers: [], clients: [], audit: [] },
    keys: [], grants: [], publishCounts: { active: 0, total: 0 }, vaults: [], transfers: [], publications: [],
    authz: { enabled: false, enabledCount: 0, count: 0, status: "ok", available: true },
  });
  assert.match(html, /data-deployed-at="2026-09-25T04:40:00Z"/, "the row must expose the raw UTC ISO to later client-side routes");
  assert.match(html, /北京时间 · 2026-09-25 12:40:00 \+08:00/, "the row must show the shared Beijing label");
  assert.match(html, /commit 0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6/, "the row must keep the commit identity");
  assert.match(html, /部署版本/, "the row must name the release");
});
