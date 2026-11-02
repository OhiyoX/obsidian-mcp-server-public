// Phase 4A: persistent, privacy-safe route counters.
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HEARTBEAT_METRIC,
  ROUTE_METRIC_NAMES,
  deprecationWindow,
  createRouteMetrics,
  routeMetricsFile,
  utcDayKey,
} from "../src/app/route-metrics.js";

async function tempFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-metrics-"));
  return { root, file: path.join(root, "route-metrics.json") };
}

test("counters aggregate by UTC day bucket and total", async () => {
  const { root, file } = await tempFile();
  let clock = Date.parse("2026-10-04T23:59:00Z");
  const metrics = createRouteMetrics({ file, now: () => clock });
  metrics.count("web.v1.notes.requests");
  metrics.count("web.v2.tree.requests", 3);
  clock = Date.parse("2026-10-05T00:01:00Z");
  metrics.count("web.v2.tree.requests", 2);

  const snapshot = metrics.snapshot();
  assert.deepEqual(Object.keys(snapshot.days).sort(), ["2026-10-04", "2026-10-05"]);
  assert.equal(snapshot.days["2026-10-04"]["web.v1.notes.requests"], 1);
  assert.equal(snapshot.days["2026-10-04"]["web.v2.tree.requests"], 3);
  assert.equal(snapshot.days["2026-10-05"]["web.v2.tree.requests"], 2);
  assert.equal(snapshot.totals["web.v2.tree.requests"], 5);
  assert.equal(utcDayKey(clock), "2026-10-05");
  await fs.rm(root, { recursive: true, force: true });
});

test("counts survive a restart (the 7-day evidence must not depend on process memory)", async () => {
  const { root, file } = await tempFile();
  const first = createRouteMetrics({ file, now: () => Date.parse("2026-10-04T10:00:00Z") });
  first.count("web.v2.search.requests", 4);
  first.count("web.v2.search.semantic.requested", 2);
  first.count("web.v2.search.semantic.degraded", 2);
  // A new process / container recreate: a fresh instance on the same file.
  const restarted = createRouteMetrics({ file, now: () => Date.parse("2026-10-04T11:00:00Z") });
  restarted.count("web.v2.search.requests", 1);
  assert.equal(restarted.totals()["web.v2.search.requests"], 5);
  assert.equal(restarted.totals()["web.v2.search.semantic.degraded"], 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("the store is an allowlist: unknown names and non-integer deltas are dropped", async () => {
  const { root, file } = await tempFile();
  const metrics = createRouteMetrics({ file });
  assert.equal(metrics.count("web.v1.notes.requests"), true);
  assert.equal(metrics.count("some.other.metric"), false);
  assert.equal(metrics.count("web.v2.tree.requests", 0), false);
  assert.equal(metrics.count("web.v2.tree.requests", -1), false);
  assert.equal(metrics.count("web.v2.tree.requests", 1.5), false);
  const names = Object.keys(metrics.totals()).filter((name) => name !== "observation.heartbeat");
  assert.deepEqual(names, ["web.v1.notes.requests"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("the persisted file holds aggregate integers only (privacy boundary)", async () => {
  const { root, file } = await tempFile();
  const metrics = createRouteMetrics({ file });
  metrics.count("web.v1.notes.requests");
  metrics.count("web.v2.failure.cursor_stale", 2);
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);
  for (const [day, counters] of Object.entries(parsed.days)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    for (const [name, value] of Object.entries(counters)) {
      assert.ok(ROUTE_METRIC_NAMES.includes(name), `only allowlisted names: ${name}`);
      assert.ok(Number.isSafeInteger(value) && value > 0);
    }
  }
  // No request-identifying content can appear: the file is names + integers + dates,
  // so it can never contain a path, an email or a file extension.
  for (const forbidden of ["/", "@", "\\"]) assert.equal(raw.includes(forbidden), false, `evidence file must not contain ${forbidden}`);
  assert.equal(raw.toLowerCase().includes(".md"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("a damaged or missing file degrades to empty instead of throwing", async () => {
  const { root, file } = await tempFile();
  await fs.writeFile(file, "{ not json");
  const metrics = createRouteMetrics({ file });
  assert.equal(metrics.totals()["web.v2.tree.requests"], undefined);
  metrics.count("web.v2.tree.requests");
  assert.equal(metrics.totals()["web.v2.tree.requests"], 1);
  // Unknown names persisted by an older/newer writer are ignored on load.
  await fs.writeFile(file, JSON.stringify({ version: 2, observation: { epoch: 1, startedDay: "2026-10-04", resets: [] }, days: { "2026-10-04": { "web.v2.tree.requests": 2, "evil.metric": 9 } } }));
  const reloaded = createRouteMetrics({ file });
  assert.equal(reloaded.totals()["web.v2.tree.requests"], 2);
  assert.equal(reloaded.totals()["evil.metric"], undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test("day buckets are bounded so the evidence file cannot grow without limit", async () => {
  const { root, file } = await tempFile();
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const metrics = createRouteMetrics({ file, now: () => clock });
  for (let day = 0; day < 40; day += 1) {
    clock = Date.parse("2026-01-01T00:00:00Z") + day * 86_400_000;
    metrics.count("web.v2.tree.requests");
  }
  const snapshot = metrics.snapshot();
  assert.equal(Object.keys(snapshot.days).length, 30);
  assert.equal(snapshot.days["2026-01-01"], undefined, "oldest buckets are trimmed");
  assert.equal(snapshot.days["2026-02-09"]["web.v2.tree.requests"], 1, "newest bucket is kept");
  await fs.rm(root, { recursive: true, force: true });
});

test("the default file lives under the data directory, not the Vault", () => {
  const previous = process.env.WEB_ROUTE_METRICS_FILE;
  delete process.env.WEB_ROUTE_METRICS_FILE;
  const file = routeMetricsFile();
  assert.match(file.replaceAll("\\", "/"), /\/data\/route-metrics\.json$/);
  if (previous !== undefined) process.env.WEB_ROUTE_METRICS_FILE = previous;
});

// Phase 4A review: evidence durability + continuity.

test("a persistence failure invalidates the epoch instead of hiding a lost count", async () => {
  const { root, file } = await tempFile();
  const errors = [];
  const metrics = createRouteMetrics({ file, logger: { error: (message) => errors.push(message) } });
  assert.equal(metrics.count("web.v1.notes.requests"), true);
  assert.equal(metrics.evidenceState().valid, true);

  // Make every subsequent write fail (the parent path is now a file, not a directory).
  await fs.rm(file, { force: true });
  await fs.writeFile(file, "not a json document");
  // Point the store at an unwritable location by replacing the file with a directory.
  const blocked = path.join(root, "blocked");
  await fs.mkdir(blocked);
  const failing = createRouteMetrics({ file: blocked, logger: { error: (message) => errors.push(message) } });
  assert.equal(failing.count("web.v1.notes.requests"), false, "count() must report that the increment did not persist");
  const state = failing.evidenceState();
  assert.equal(state.valid, false, "the epoch must be invalid");
  assert.equal(state.invalidReason, "persist-failure");
  assert.equal(state.lastPersistError !== null, true);
  assert.equal(errors.length, 1, "an operational signal is emitted once");
  assert.doesNotMatch(errors[0], /query|note|vault|user|ip|ua/i);
  await fs.rm(root, { recursive: true, force: true });
});

test("continuity is expressed: a fresh epoch starts on creation and survives restarts", async () => {
  const { root, file } = await tempFile();
  const day1 = Date.parse("2026-10-04T09:00:00Z");
  const first = createRouteMetrics({ file, now: () => day1 });
  const created = first.evidenceState();
  assert.equal(created.valid, true);
  assert.equal(created.startedDay, "2026-10-04");
  assert.equal(created.epoch, 1);
  assert.equal(created.resets, 1, "creation records the epoch start");

  // A normal restart keeps the same epoch and start day.
  const restarted = createRouteMetrics({ file, now: () => Date.parse("2026-10-06T09:00:00Z") });
  const after = restarted.evidenceState();
  assert.equal(after.epoch, created.epoch);
  assert.equal(after.startedDay, "2026-10-04", "an unbroken window keeps its start day");
  assert.equal(after.resets, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("a broken or replaced evidence file starts a new epoch and restarts the window", async () => {
  const { root, file } = await tempFile();
  const clock = () => Date.parse("2026-10-08T09:00:00Z");
  createRouteMetrics({ file, now: () => Date.parse("2026-10-04T09:00:00Z") });

  // (a) corrupted
  await fs.writeFile(file, "{ broken");
  const corrupted = createRouteMetrics({ file, now: clock });
  assert.equal(corrupted.evidenceState().startedDay, "2026-10-08");
  assert.equal(corrupted.evidenceState().resets, 1);
  assert.equal(corrupted.snapshot().observation.resets.at(-1).reason, "corrupted");

  // (b) deleted after an established window
  await fs.rm(file, { force: true });
  const missing = createRouteMetrics({ file, now: clock });
  assert.equal(missing.evidenceState().startedDay, "2026-10-08");
  assert.equal(missing.snapshot().observation.resets.at(-1).reason, "missing");

  // (c) a different schema version
  await fs.writeFile(file, JSON.stringify({ version: 999, days: {} }));
  const versioned = createRouteMetrics({ file, now: clock });
  assert.equal(versioned.snapshot().observation.resets.at(-1).reason, "version");
  assert.equal(versioned.evidenceState().valid, true, "a version change is a reset, not a permanent invalid");

  // (d) an epoch already marked invalid must not be reused
  await fs.writeFile(file, JSON.stringify({ version: 2, observation: { epoch: 4, startedDay: "2026-10-01", resets: [], invalid: true, invalidReason: "persist-failure" }, days: { "2026-10-01": { "web.v1.notes.requests": 3 } } }));
  const invalid = createRouteMetrics({ file, now: clock });
  assert.equal(invalid.evidenceState().valid, true);
  assert.equal(invalid.evidenceState().startedDay, "2026-10-08");
  assert.equal(invalid.snapshot().observation.resets.at(-1).reason, "invalid-epoch");
  assert.equal(invalid.totals()["web.v1.notes.requests"], undefined, "an invalid epoch's counts are not carried forward");
  await fs.rm(root, { recursive: true, force: true });
});

test("the continuity metadata stays privacy-safe (day granularity, fixed reasons)", async () => {
  const { root, file } = await tempFile();
  const metrics = createRouteMetrics({ file, now: () => Date.parse("2026-10-04T09:00:00Z") });
  metrics.count("web.v1.notes.requests");
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ["days", "observation", "version"]);
  assert.deepEqual(Object.keys(parsed.observation).sort(), ["epoch", "invalid", "invalidReason", "resets", "startedDay"]);
  for (const reset of parsed.observation.resets) {
    assert.match(reset.day, /^\d{4}-\d{2}-\d{2}$/, "day granularity only");
    assert.equal(typeof reset.reason, "string");
  }
  for (const forbidden of ["/", "@", "\\"]) assert.equal(raw.includes(forbidden), false);
  await fs.rm(root, { recursive: true, force: true });
});

// Phase 4A review: the last crash/restart boundary of the persistence failure.

// Stand-in for the independent host/collector monitor attestation.
const dayList = (fromDay, count) => Array.from({ length: count }, (_, index) =>
  new Date(Date.parse(`${fromDay}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
const monitorFor = (healthyDays, brokenDays = []) => ({ enabled: true, healthyDays, brokenDays });

function failingWriter(control) {
  return ({ tmp, file, data }) => {
    if (control.fail) {
      const error = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    fsSync.writeFileSync(tmp, data);
    fsSync.renameSync(tmp, file);
  };
}

test("a persistence failure is reported as unrecorded, and the window stays sound", async () => {
  const { root, file } = await tempFile();
  const control = { fail: false };
  const writer = failingWriter(control);
  const dayMs = 86_400_000;
  const base = Date.parse("2026-10-01T00:00:00Z");

  // Days 1..3: healthy, heartbeats written, no v1 usage.
  for (let offset = 0; offset < 3; offset += 1) {
    const metrics = createRouteMetrics({ file, now: () => base + offset * dayMs, writer });
    metrics.heartbeat();
    metrics.dispose();
  }

  // Day 4: storage breaks. The v1 increment cannot be recorded, so the route answers
  // 503 evidence-unavailable (see the HTTP test) rather than a normal success, and the
  // running epoch is invalid.
  control.fail = true;
  const day4 = createRouteMetrics({ file, now: () => base + 3 * dayMs, writer, logger: { error: () => {} } });
  assert.equal(day4.count("web.v1.notes.requests"), false, "the increment is reported as unrecorded");
  const broken = day4.evidenceState();
  assert.equal(broken.valid, false);
  assert.equal(broken.invalidReason, "persist-failure");
  assert.equal(broken.lastPersistError, "ENOSPC");
  day4.dispose();

  // A restart cannot be protected by the file alone: a same-day heartbeat would be
  // written again. That is exactly why the endpoint fails closed instead of relying on
  // this file to record the failure.
  control.fail = false;
  const restarted = createRouteMetrics({ file, now: () => base + 3 * dayMs, writer });
  assert.equal(restarted.evidenceState().valid, true, "the stale file alone cannot express it");
  assert.equal(restarted.evidenceState().heartbeatDays.includes("2026-10-04"), true, "a same-day restart re-writes the heartbeat");
  restarted.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test("the removal gate only counts fully completed UTC days", async () => {
  const { root, file } = await tempFile();
  const previousOps = process.env.WEB_DEPRECATION_OPS_LOG;
  process.env.WEB_DEPRECATION_OPS_LOG = path.join(root, "ops.log");
  const dayMs = 86_400_000;
  const base = Date.parse("2026-10-01T00:00:00Z");
  const heartbeats = async (count) => {
    for (let offset = 0; offset < count; offset += 1) {
      const day = createRouteMetrics({ file, now: () => base + offset * dayMs });
      day.heartbeat();
      day.dispose();
    }
  };

  // Started Oct 1 with heartbeats through Oct 5: on Oct 6 the four completed days are
  // Oct 2..Oct 5, and the start day is strictly before them -> the window is real.
  await heartbeats(5);
  const healthy = createRouteMetrics({ file, now: () => base + 5 * dayMs });
  const ok = deprecationWindow(healthy, { days: 4, now: base + 5 * dayMs, monitor: monitorFor(dayList("2026-10-01", 10)) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.checkedDays, ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"], "today is never part of the window");
  assert.equal(ok.v1Requests, 0);
  healthy.dispose();

  // Off-by-one guard: started Oct 1, checked on Oct 4 with days=3 -> the completed days
  // are Oct 1..Oct 3, but Oct 1 is the start day itself, so it cannot count. This is the
  // case that previously passed after only 3x24h (or less).
  const started = createRouteMetrics({ file, now: () => base + 2 * dayMs });
  const tooEarly = deprecationWindow(started, { days: 3, now: base + 3 * dayMs, monitor: monitorFor(dayList("2026-10-01", 10)) });
  assert.equal(tooEarly.ok, false, "the deploy day is not a complete observation day");
  assert.match(tooEarly.reason, /younger than the required period/);
  started.dispose();

  // An authenticated v1 request inside the window fails the gate. It must land on a
  // *completed* day (today is excluded by design, so a request made today cannot
  // retroactively fail the completed window -- it fails the next day's evaluation).
  const used = createRouteMetrics({ file, now: () => base + 3 * dayMs });
  used.count("web.v1.notes.requests");
  const blocked = deprecationWindow(used, { days: 4, now: base + 5 * dayMs, monitor: monitorFor(dayList("2026-10-01", 10)) });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /authenticated v1 usage is non-zero/);
  assert.equal(blocked.v1Requests, 1);
  used.dispose();

  // Today is veto-only: usage today blocks the gate even though the completed days are
  // all clean (otherwise a client still on v1 this morning would not stop a same-day
  // removal). Today needs no heartbeat and does not count toward the duration.
  const todayUse = createRouteMetrics({ file, now: () => base + 6 * dayMs });
  todayUse.count("web.v1.notes.requests");
  const vetoed = deprecationWindow(todayUse, { days: 4, now: base + 6 * dayMs, monitor: monitorFor(dayList("2026-10-01", 10)) });
  assert.equal(vetoed.ok, false);
  assert.match(vetoed.reason, /authenticated v1 usage today/);
  assert.equal(vetoed.v1Requests, 0, "the completed window itself is still clean");
  assert.equal(vetoed.today.v1Requests, 1);
  todayUse.dispose();

  // A later day with no recorded v1 usage, so the today-broken veto is what fires.
  const cleanToday = createRouteMetrics({ file, now: () => base + 7 * dayMs });
  const todayBroken = deprecationWindow(cleanToday, { days: 4, now: base + 7 * dayMs, brokenDays: ["2026-10-08"], monitor: monitorFor(dayList("2026-10-01", 10)) });
  assert.equal(todayBroken.ok, false);
  assert.match(todayBroken.reason, /evidence was broken today/);
  assert.equal(todayBroken.today.broken, true);
  cleanToday.dispose();

  // A day where the independent ops channel reported broken evidence fails the gate.
  const opsBroken = deprecationWindow(used, { days: 4, now: base + 5 * dayMs, brokenDays: ["2026-10-04"], monitor: monitorFor(dayList("2026-10-01", 10)) });
  assert.equal(opsBroken.ok, false);
  assert.deepEqual(opsBroken.brokenDays, ["2026-10-04"]);
  assert.match(opsBroken.reason, /evidence was broken/);
  used.dispose();
  if (previousOps === undefined) delete process.env.WEB_DEPRECATION_OPS_LOG;
  else process.env.WEB_DEPRECATION_OPS_LOG = previousOps;
  await fs.rm(root, { recursive: true, force: true });
});

test("an unrecorded v1 attempt is emitted to the independent ops channel", async () => {
  const { root, file } = await tempFile();
  const lines = [];
  const metrics = createRouteMetrics({
    file,
    writer: () => { const error = new Error("nospc"); error.code = "ENOSPC"; throw error; },
    logger: { error: (line) => lines.push(line) },
  });
  metrics.count("web.v1.notes.requests");
  metrics.markUnrecordedAttempt("web.v1.notes.requests");
  const marker = lines.filter((line) => line.includes("WEB_DEPRECATION_EVIDENCE_BROKEN"));
  assert.equal(marker.length >= 1, true);
  assert.equal(marker.some((line) => line.includes("reason=unrecorded-attempt") && line.includes("counter=web.v1.notes.requests")), true);
  assert.equal(marker.some((line) => line.includes("reason=persist-failure") && line.includes("code=ENOSPC")), true);
  for (const line of marker) {
      assert.match(line, /day=[0-9]{4}-[0-9]{2}-[0-9]{2}/);
      assert.doesNotMatch(line, /query|vault|user|ip|ua|[.]md/i);
  }
  metrics.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test("the heartbeat is a liveness marker, not a route counter, and stays privacy-safe", async () => {
  const { root, file } = await tempFile();
  const metrics = createRouteMetrics({ file, now: () => Date.parse("2026-10-04T00:00:00Z") });
  assert.ok(ROUTE_METRIC_NAMES.includes(HEARTBEAT_METRIC));
  assert.equal(metrics.totals()[HEARTBEAT_METRIC] > 0, true);
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes(HEARTBEAT_METRIC), true);
  for (const forbidden of ["/", "@", "\\"]) assert.equal(raw.includes(forbidden), false);
  metrics.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test("a v1 compatibility request fails closed when its evidence cannot be recorded", async () => {
  // The route-level guarantee: no successful authenticated v1 response without a
  // recorded counter, so a broken store can never look like a clean zero.
  const { root, file } = await tempFile();
  const control = { fail: true };
  const metrics = createRouteMetrics({
    file,
    writer: ({ tmp, file: target, data }) => {
      if (control.fail) { const error = new Error("nospc"); error.code = "ENOSPC"; throw error; }
      fsSync.writeFileSync(tmp, data);
      fsSync.renameSync(tmp, target);
    },
    logger: { error: () => {} },
  });
  assert.equal(metrics.count("web.v1.notes.requests"), false);
  control.fail = false;
  assert.equal(metrics.count("web.v1.notes.requests"), true);
  metrics.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test("the broken-evidence marker can be appended to an independent ops sink", async () => {
  const { root, file } = await tempFile();
  const opsLog = path.join(root, "ops", "deprecation.log");
  const previous = process.env.WEB_DEPRECATION_OPS_LOG;
  process.env.WEB_DEPRECATION_OPS_LOG = opsLog;
  try {
    const metrics = createRouteMetrics({
      file,
      writer: () => { const error = new Error("nospc"); error.code = "ENOSPC"; throw error; },
      logger: { error: () => {} },
    });
    metrics.count("web.v1.notes.requests");
    metrics.markUnrecordedAttempt("web.v1.notes.requests");
    metrics.markUnrecordedAttempt("web.v1.notes.requests");
    metrics.dispose();
    const lines = (await fs.readFile(opsLog, "utf8")).trim().split(String.fromCharCode(10));
    assert.equal(lines.length, 3, "append-only, one line per signal");
    assert.equal(lines.some((line) => line.includes("reason=persist-failure") && line.includes("code=ENOSPC")), true);
    assert.equal(lines.filter((line) => line.includes("reason=unrecorded-attempt")).length, 2);
    for (const line of lines) {
      assert.match(line, /^WEB_DEPRECATION_EVIDENCE_BROKEN /);
      assert.match(line, /day=[0-9]{4}-[0-9]{2}-[0-9]{2}/);
      assert.doesNotMatch(line, /query|vault|user|ip|ua|[.]md/i);
    }
  } finally {
    if (previous === undefined) delete process.env.WEB_DEPRECATION_OPS_LOG;
    else process.env.WEB_DEPRECATION_OPS_LOG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the gate requires a healthy durable ops sink for the whole window", async () => {
  const { root, file } = await tempFile();
  const dayMs = 86_400_000;
  const base = Date.parse("2026-10-01T00:00:00Z");
  const previousOps = process.env.WEB_DEPRECATION_OPS_LOG;
  const opsLog = path.join(root, "ops", "deprecation.log");
  try {
    // No sink configured: the gate must fail closed, not assume one exists.
    delete process.env.WEB_DEPRECATION_OPS_LOG;
    const unsinked = createRouteMetrics({ file, now: () => base });
    for (let offset = 0; offset < 5; offset += 1) {
      const day = createRouteMetrics({ file, now: () => base + offset * dayMs });
      day.heartbeat();
      day.dispose();
    }
    const noSink = deprecationWindow(unsinked, { days: 4, now: base + 5 * dayMs, monitor: monitorFor(dayList("2026-10-01", 10)) });
    assert.equal(noSink.ok, false);
    assert.match(noSink.reason, /no durable ops sink configured/);
    unsinked.dispose();

    // A sink whose append fails must invalidate the epoch: the marker exists nowhere
    // durable, so the window cannot be trusted even if the file looks clean.
    process.env.WEB_DEPRECATION_OPS_LOG = path.join(root, "blocked", "ops.log");
    fsSync.mkdirSync(path.join(root, "blocked"), { recursive: true });
    fsSync.rmSync(path.join(root, "blocked"), { recursive: true, force: true });
    fsSync.writeFileSync(path.join(root, "blocked"), "not a directory");
    const brokenSink = createRouteMetrics({
      file,
      now: () => base + 5 * dayMs,
      writer: () => { const error = new Error("nospc"); error.code = "ENOSPC"; throw error; },
      logger: { error: () => {} },
    });
    assert.equal(brokenSink.markUnrecordedAttempt("web.v1.notes.requests"), false, "the append result is reported");
    const state = brokenSink.evidenceState();
    assert.equal(state.valid, false);
    assert.equal(state.invalidReason, "ops-sink-failure");
    assert.equal(state.ops.failures >= 1, true, `both markers failed to append: ${state.ops.failures}`);
    assert.equal(state.ops.lastError !== null, true);
    const blocked = deprecationWindow(brokenSink, { days: 4, now: base + 5 * dayMs, monitor: monitorFor(dayList("2026-10-01", 10)) });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /ops sink write failed during this epoch/);
    brokenSink.dispose();

    // Healthy sink: appends are counted and the gate can pass.
    process.env.WEB_DEPRECATION_OPS_LOG = opsLog;
    const healthy = createRouteMetrics({ file, now: () => base + 5 * dayMs });
    assert.equal(healthy.markUnrecordedAttempt("web.v1.notes.requests"), true);
    const afterFirst = healthy.evidenceState().ops.writes;
    assert.equal(healthy.markUnrecordedAttempt("web.v1.notes.requests"), true);
    assert.equal(healthy.evidenceState().ops.writes, afterFirst + 1, "each successful marker is counted");
    assert.equal(healthy.evidenceState().ops.failures, 0);
    healthy.dispose();
  } finally {
    if (previousOps === undefined) delete process.env.WEB_DEPRECATION_OPS_LOG;
    else process.env.WEB_DEPRECATION_OPS_LOG = previousOps;
    await fs.rm(root, { recursive: true, force: true });
  }
});
