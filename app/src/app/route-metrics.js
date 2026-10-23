// Persistent, privacy-safe route counters (Phase 4A — deprecation evidence).
//
// Purpose: prove whether the v1 compatibility layer can be removed. Two properties
// matter more than the counts themselves:
//
//   1. durability — a count must survive restart / container recreate / deploy, so the
//      aggregate is written synchronously on every increment (atomic temp + rename);
//   2. continuity — the file must be able to say *since when* the observation has been
//      unbroken, and must never look "clean" after a persistence failure, a corrupted
//      file or a version change. Those all start a new observation epoch, which
//      restarts the 7-day window.
//
// Privacy: only names in ROUTE_METRIC_NAMES can be written; only aggregate integers and
// day-granular metadata are stored. No request records, query, note path, Vault
// name/id, user id, IP, UA, or sub-day timestamp.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 4A
import fs from "node:fs";
import path from "node:path";
import { DATA_PATH } from "../config.js";

export const ROUTE_METRIC_NAMES = Object.freeze([
  // The deprecation gate itself: authenticated first-party v1 usage.
  "web.v1.notes.requests",
  "web.v2.tree.requests",
  "web.v2.search.requests",
  "web.v2.search.semantic.requested",
  "web.v2.search.semantic.used",
  "web.v2.search.semantic.degraded",
  // Failure / recovery signals that must not regress while the compatibility layer goes.
  "web.v2.failure.catalog_not_ready",
  "web.v2.failure.cursor_stale",
  // Observation liveness marker, not a route counter: one write per day proves the
  // evidence file was writable that day. A day where persistence failed therefore has
  // NO heartbeat, and that absence survives a restart -- which is the only way to
  // express "the failure could not be recorded".
  "observation.heartbeat",
]);

export const HEARTBEAT_METRIC = "observation.heartbeat";

// Independent, greppable ops signal. The metrics file cannot record its own write
// failure, so the deletion gate also requires that this marker never appears in the
// container's log sink (which is a different, independently persisted location) during
// the observation window. Error code + counter + UTC day only: no user content.
export const EVIDENCE_BROKEN_MARKER = "WEB_DEPRECATION_EVIDENCE_BROKEN";
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

const FILE_VERSION = 2;
const MAX_DAYS = 30;
const MAX_RESETS = 10;
const RESET_REASONS = Object.freeze(["created", "missing", "corrupted", "version", "invalid-epoch", "persist-failure"]);

export function routeMetricsFile() {
  return path.resolve(process.env.WEB_ROUTE_METRICS_FILE || path.join(DATA_PATH, "route-metrics.json"));
}

// Optional independent ops sink. The metrics file cannot record its own write failure,
// so the gate also requires this marker in a sink that is persisted separately from the
// metrics volume. Point this at storage that is NOT the metrics file's volume (the
// container's per-container json-file log is removed with the container, so it does not
// qualify on its own).
export function opsSinkConfigured() {
  return Boolean(process.env.WEB_DEPRECATION_OPS_LOG);
}

export function opsLogFile() {
  const target = process.env.WEB_DEPRECATION_OPS_LOG;
  return target ? path.resolve(target) : null;
}

export function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function isDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function cleanDays(raw) {
  const clean = {};
  if (typeof raw !== "object" || raw === null) return clean;
  for (const [day, counters] of Object.entries(raw)) {
    if (!isDay(day) || typeof counters !== "object" || counters === null) continue;
    const kept = {};
    for (const [name, value] of Object.entries(counters)) {
      if (ROUTE_METRIC_NAMES.includes(name) && Number.isSafeInteger(value) && value >= 0) kept[name] = value;
    }
    clean[day] = kept;
  }
  return clean;
}

export function createRouteMetrics({ file = routeMetricsFile(), now = () => Date.now(), logger = console, writer = null } = {}) {
  const today = () => utcDayKey(now());
  const markerFile = `${file}.epoch`;
  const loaded = load();
  const days = loaded.days;
  const observation = loaded.observation;
  let lastPersistError = null;
  let warnedDay = null;
  const ops = { writes: 0, failures: 0, lastError: null, warned: false };

  // The durable ops sink is the deletion gate's evidence channel, so its write result
  // must never be swallowed: a failed append means this marker exists nowhere durable,
  // which invalidates the observation window exactly like a metrics write failure.
  function emitMarker(line) {
    logger?.error?.(line);
    const target = opsLogFile();
    if (!target) return false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `${line}
`);
      ops.writes += 1;
      return true;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "ops-write-failed";
      ops.failures += 1;
      ops.lastError = code;
      observation.invalid = true;
      observation.invalidReason = "ops-sink-failure";
      if (!ops.warned) {
        ops.warned = true;
        logger?.error?.(`${EVIDENCE_BROKEN_MARKER} reason=ops-sink-write-failed code=${code} day=${utcDayKey(now())} epoch=${observation.epoch}`);
      }
      return false;
    }
  }

  // Returns { ok, days, observation }. A file that is missing, unreadable, damaged,
  // version-invalid, or already marked invalid starts a NEW epoch: the 7-day window
  // restarts rather than silently continuing a broken chain.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      // No main file: either a first-ever deploy, or a window that had been
      // established and then lost. The marker (written once per epoch) tells them
      // apart, so a lost window is labelled and cannot masquerade as a fresh start.
      let established = false;
      try {
        established = JSON.parse(fs.readFileSync(markerFile, "utf8"))?.version === FILE_VERSION;
      } catch {
        established = false;
      }
      return fresh(established ? "missing" : "created");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fresh("corrupted");
    }
    if (parsed?.version !== FILE_VERSION || typeof parsed !== "object" || parsed === null) return fresh("version");
    if (parsed.observation?.invalid === true) return fresh("invalid-epoch");
    const priorDays = cleanDays(parsed.days);
    const priorStarted = isDay(parsed.observation?.startedDay) ? parsed.observation.startedDay : null;
    if (!priorStarted) return fresh("corrupted");
    return {
      created: false,
      days: priorDays,
      observation: {
        epoch: Number.isSafeInteger(parsed.observation?.epoch) && parsed.observation.epoch > 0 ? parsed.observation.epoch : 1,
        startedDay: priorStarted,
        resets: cleanResets(parsed.observation?.resets),
        invalid: false,
        invalidReason: null,
      },
    };
  }

  function cleanResets(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => entry && isDay(entry.day) && RESET_REASONS.includes(entry.reason))
      .slice(-MAX_RESETS)
      .map((entry) => ({ day: entry.day, reason: entry.reason }));
  }

  function fresh(reason) {
    const day = today();
    return {
      created: true,
      days: {},
      observation: { epoch: 1, startedDay: day, resets: [{ day, reason }], invalid: false, invalidReason: null },
    };
  }

  function payload() {
    const keys = Object.keys(days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete days[key];
    return {
      version: FILE_VERSION,
      observation: {
        epoch: observation.epoch,
        startedDay: observation.startedDay,
        resets: observation.resets.slice(-MAX_RESETS),
        invalid: observation.invalid,
        invalidReason: observation.invalidReason,
      },
      days: Object.fromEntries(Object.keys(days).sort().map((key) => [key, days[key]])),
    };
  }

  // Atomic write. Returns whether the evidence actually reached disk; a failure is
  // never silent: the epoch is invalidated (so the window restarts) and an operational
  // error signal is emitted once.
  function persist() {
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (writer) writer({ tmp, file, data: JSON.stringify(payload()) });
      else {
        fs.writeFileSync(tmp, JSON.stringify(payload()));
        fs.renameSync(tmp, file);
      }
      lastPersistError = null;
      return true;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "persist-failed";
      lastPersistError = code;
      observation.invalid = true;
      observation.invalidReason = "persist-failure";
      const day = utcDayKey(now());
      if (warnedDay !== day) {
        warnedDay = day;
        // Operational signal only: an error code, never user content. Emitted at most
        // once per UTC day so a long outage still leaves daily evidence.
        emitMarker(`${EVIDENCE_BROKEN_MARKER} reason=persist-failure code=${code} day=${day} epoch=${observation.epoch}`);
      }
      return false;
    }
  }

  function count(name, delta = 1) {
    if (!ROUTE_METRIC_NAMES.includes(name)) return false;
    const value = Number(delta);
    if (!Number.isSafeInteger(value) || value <= 0) return false;
    const day = today();
    if (!days[day]) days[day] = {};
    days[day][name] = (days[day][name] || 0) + value;
    // Synchronous: a lost increment could make a non-zero day look clean, which is
    // exactly what the removal gate must not allow.
    return persist();
  }

  function heartbeat() {
    const day = today();
    if (!days[day]) days[day] = {};
    days[day][HEARTBEAT_METRIC] = (days[day][HEARTBEAT_METRIC] || 0) + 1;
    return persist();
  }

  function totals() {
    const result = {};
    for (const day of Object.values(days)) {
      for (const [name, value] of Object.entries(day)) result[name] = (result[name] || 0) + value;
    }
    return result;
  }

  // The epoch start must be durable from creation, not from the first request. The
  // marker is only written here (once per epoch), so a normal increment costs one write.
  if (loaded.created) {
    persist();
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(`${markerFile}.tmp`, JSON.stringify({ version: FILE_VERSION, epoch: observation.epoch, startedDay: observation.startedDay }));
      fs.renameSync(`${markerFile}.tmp`, markerFile);
    } catch {
      // Best effort; the main file remains the authority.
    }
  }

  // Record liveness immediately (so the current day is provable from the start) and
  // keep refreshing it. unref() so the timer never holds the process open.
  heartbeat();
  const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    file,
    heartbeat,
    // A v1 attempt whose counter could not be recorded is still real usage: a valid
    // client was still depending on the endpoint. It is emitted to the independent ops
    // channel because this file is exactly what is broken.
    markUnrecordedAttempt(counter) {
      const day = utcDayKey(now());
      return emitMarker(`${EVIDENCE_BROKEN_MARKER} reason=unrecorded-attempt counter=${counter} day=${day} epoch=${observation.epoch}`);
    },
    count,
    dispose() {
      clearInterval(timer);
    },
    countMany(names) {
      let ok = true;
      for (const name of names) if (!count(name)) ok = false;
      return ok;
    },
    snapshot() {
      return { version: FILE_VERSION, observation: { ...observation, resets: [...observation.resets] }, days: JSON.parse(JSON.stringify(days)), totals: totals() };
    },
    totals,
    // Evidence state for the removal gate: a window only counts while it is valid and
    // has been unbroken since `startedDay`.
    evidenceState() {
      return {
        valid: observation.invalid !== true,
        epoch: observation.epoch,
        startedDay: observation.startedDay,
        resets: observation.resets.length,
        invalidReason: observation.invalidReason,
        lastPersistError,
        // Durable ops-sink health for the whole epoch, not just a one-off retention test.
        ops: { configured: opsSinkConfigured(), writes: ops.writes, failures: ops.failures, lastError: ops.lastError },
        heartbeatDays: Object.keys(days).filter((day) => (days[day]?.[HEARTBEAT_METRIC] || 0) > 0).sort(),
      };
    },
  };
}

let shared;

// Process-wide instance for the routes. Tests use createRouteMetrics() directly.
export function getRouteMetrics() {
  if (!shared) shared = createRouteMetrics();
  return shared;
}

export function __resetRouteMetricsForTests() {
  shared = undefined;
}

// The removal gate, executable. A window only counts when it is valid, has been
// unbroken for the whole period, and every one of those days carries an observation
// heartbeat (i.e. the evidence file was actually writable that day). A persistence
// failure therefore fails this predicate even if the process restarted before the
// in-memory "invalid" flag could be written: the day simply has no heartbeat.
// The two local channels (metrics file + ops log) cannot prove their own blindness: when
// both are unwritable the process has no way to record that it was blind, and a restart
// would reload a clean-looking file. The removal gate therefore requires an attestation
// from an independent host/collector monitor that is persisted outside both channels and
// survives container restart. `monitor.healthyDays` is that monitor's own durable record
// of confirmed ingestion; it must cover every day of the window (and today), so "no
// marker was needed" can never be mistaken for "the sink was healthy".
export function deprecationWindow(metrics, { days = 7, now = Date.now(), brokenDays = [], monitor = null } = {}) {
  const snapshot = metrics.snapshot();
  const state = metrics.evidenceState();
  const result = { ok: false, reason: null, startedDay: state.startedDay, checkedDays: [], missingHeartbeats: [], v1Requests: 0, brokenDays: [], ops: state.ops };
  // Local checks stay, but only as *additional* strictness: they can never be the
  // evidence that the observation was continuously healthy.
  if (!state.ops?.configured) {
    result.reason = "no durable ops sink configured (WEB_DEPRECATION_OPS_LOG)";
    return result;
  }
  if ((state.ops?.failures || 0) > 0) {
    result.reason = `ops sink write failed during this epoch (${state.ops.lastError || "unknown"})`;
    return result;
  }
  if (!monitor || monitor.enabled !== true) {
    result.reason = "no independent observation-monitor attestation (required for the removal gate)";
    return result;
  }
  const monitorHealthy = Array.isArray(monitor.healthyDays) ? monitor.healthyDays : [];
  const monitorBroken = Array.isArray(monitor.brokenDays) ? monitor.brokenDays : [];
  result.monitor = { enabled: true, healthyDays: monitorHealthy, brokenDays: monitorBroken };
  if (!state.valid) {
    result.reason = `observation epoch is invalid (${state.invalidReason || "unknown"})`;
    return result;
  }
  // Only *fully completed* UTC days count. The day the deploy/reset happened is not a
  // complete observation day, so `days` complete days prove >= days*24h even if the
  // window started at 23:59 -- today is never part of the window.
  const today = utcDayKey(now);
  // Today is veto-only: it cannot prove the required duration (it is not a complete
  // day), but usage or broken evidence *today* must block the gate immediately --
  // otherwise a client still using v1 this morning would not stop a same-day removal.
  const todayV1 = snapshot.days[today]?.["web.v1.notes.requests"] || 0;
  result.today = { day: today, v1Requests: todayV1, broken: brokenDays.includes(today) };
  if (todayV1 > 0) {
    result.reason = `authenticated v1 usage today (${todayV1})`;
    return result;
  }
  // The independent monitor must also cover today: a blind morning is not evidence.
  if (!monitorHealthy.includes(today)) {
    result.reason = `independent observation monitor has no healthy record for today (${today})`;
    return result;
  }
  if (monitorBroken.includes(today)) {
    result.reason = `independent observation monitor reported broken ingestion today (${today})`;
    return result;
  }
  if (result.today.broken) {
    result.reason = `evidence was broken today (${today})`;
    return result;
  }
  const midnight = Date.parse(`${today}T00:00:00Z`);
  for (let offset = days; offset >= 1; offset -= 1) {
    const day = utcDayKey(midnight - offset * 86_400_000);
    result.checkedDays.push(day);
    if (!(snapshot.days[day]?.[HEARTBEAT_METRIC] > 0)) result.missingHeartbeats.push(day);
    if (brokenDays.includes(day) || monitorBroken.includes(day)) result.brokenDays.push(day);
    if (!monitorHealthy.includes(day)) result.missingHeartbeats.push(day);
  }
  if (result.missingHeartbeats.length > 0) {
    result.reason = `no observation heartbeat on ${result.missingHeartbeats.join(", ")}`;
    return result;
  }
  if (result.brokenDays.length > 0) {
    result.reason = `evidence was broken on ${result.brokenDays.join(", ")}`;
    return result;
  }
  if (!(state.startedDay < result.checkedDays[0])) {
    result.reason = "observation window is younger than the required period";
    return result;
  }
  result.v1Requests = result.checkedDays.reduce((sum, day) => sum + (snapshot.days[day]?.["web.v1.notes.requests"] || 0), 0);
  if (result.v1Requests !== 0) {
    result.reason = `authenticated v1 usage is non-zero (${result.v1Requests})`;
    return result;
  }
  result.ok = true;
  return result;
}
