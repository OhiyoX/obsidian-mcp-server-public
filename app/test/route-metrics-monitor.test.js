// Phase 4A: the removal gate depends on independent monitor evidence, not on local state.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 4A
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouteMetrics, deprecationWindow } from "../src/app/route-metrics.js";

const DAY_MS = 86_400_000;
const BASE = Date.parse("2026-10-01T00:00:00Z");
const dayList = (fromDay, count) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(`${fromDay}T00:00:00Z`) + index * DAY_MS).toISOString().slice(0, 10));
const monitorFor = (healthyDays, brokenDays = []) => ({ enabled: true, healthyDays, brokenDays });

async function establishedMetrics({ heartbeats = 6 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-metrics-monitor-"));
  const file = path.join(root, "route-metrics.json");
  for (let offset = 0; offset < heartbeats; offset += 1) {
    const day = createRouteMetrics({ file, now: () => BASE + offset * DAY_MS });
    day.heartbeat();
    day.dispose();
  }
  return { root, file };
}

test("without an independent attestation the gate fails closed", async () => {
  const { root, file } = await establishedMetrics();
  const previous = process.env.WEB_DEPRECATION_OPS_LOG;
  process.env.WEB_DEPRECATION_OPS_LOG = path.join(root, "ops.log");
  try {
    const metrics = createRouteMetrics({ file, now: () => BASE + 5 * DAY_MS });
    // The local channels look perfectly healthy -- and that is exactly the problem: they
    // cannot prove their own blindness, so they are not accepted as the evidence.
    assert.equal(metrics.evidenceState().valid, true);
    assert.equal(metrics.evidenceState().ops.failures, 0);
    const result = deprecationWindow(metrics, { days: 4, now: BASE + 5 * DAY_MS });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no independent observation-monitor attestation/);
    metrics.dispose();
  } finally {
    if (previous === undefined) delete process.env.WEB_DEPRECATION_OPS_LOG;
    else process.env.WEB_DEPRECATION_OPS_LOG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the attestation must cover every day of the window and today", async () => {
  const { root, file } = await establishedMetrics();
  const previous = process.env.WEB_DEPRECATION_OPS_LOG;
  process.env.WEB_DEPRECATION_OPS_LOG = path.join(root, "ops.log");
  try {
    const metrics = createRouteMetrics({ file, now: () => BASE + 5 * DAY_MS });
    const full = dayList("2026-10-02", 5);

    const complete = deprecationWindow(metrics, { days: 4, now: BASE + 5 * DAY_MS, monitor: monitorFor(full) });
    assert.equal(complete.ok, true, JSON.stringify(complete));
    assert.equal(complete.monitor.enabled, true);

    // A gap means "no marker was needed" was mistaken for "the sink was healthy".
    // Today is attested, but two completed days are missing from the monitor's record.
    const gap = deprecationWindow(metrics, { days: 4, now: BASE + 5 * DAY_MS, monitor: monitorFor(["2026-10-02", "2026-10-03", "2026-10-06"]) });
    assert.equal(gap.ok, false);
    assert.match(gap.reason, /no observation heartbeat on/);

    // The monitor reporting a broken day fails the gate even though the local files look clean.
    const broken = deprecationWindow(metrics, { days: 4, now: BASE + 5 * DAY_MS, monitor: monitorFor(full, ["2026-10-04"]) });
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.brokenDays, ["2026-10-04"]);
    assert.match(broken.reason, /evidence was broken/);

    // A blind morning today is not evidence either.
    const todayBlind = deprecationWindow(metrics, { days: 4, now: BASE + 5 * DAY_MS, monitor: monitorFor(full, ["2026-10-06"]) });
    assert.equal(todayBlind.ok, false);
    assert.match(todayBlind.reason, /broken ingestion today/);

    metrics.dispose();
  } finally {
    if (previous === undefined) delete process.env.WEB_DEPRECATION_OPS_LOG;
    else process.env.WEB_DEPRECATION_OPS_LOG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
