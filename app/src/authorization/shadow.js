// P2 / Task 9 — the shadow comparison and its bounded difference record.
//
// Contract: design §10 step 5 and §6.1. One AUTHORIZATION UNIT — one `tools/call`
// member, one resource read, one Web route, one stream frame — yields ONE row, no
// matter how many layers (transport, temporal gate, Vault scope) answered it. The
// row states the EFFECTIVE old answer for that unit (the first layer that denied,
// or "allowed" when every layer passed) beside the new model's answer at that same
// layer. A layer that never decided the unit can therefore not fabricate a
// difference.
//
// The record is a bounded ring of whitelisted metadata: no path, no body, no token,
// no subject, no Vault id. Every value that identifies a row (`boundary`, `phase`)
// is a bounded catalog key or a enum, so a difference is attributable.
//
// A pair whose sides cannot be read, that is not tied to one snapshot, or whose old
// verdict belongs to another member of a batch, is `inconclusive` with a reason. It
// is never counted as agreement.
//
// Nothing here decides anything. The observer returns nothing, so a transport cannot
// use it for control, and a throwing sink (or a full ring) changes no answer.

import { AsyncLocalStorage } from "node:async_hooks";

const SURFACES = new Set(["mcp", "web", "oauth", "admin", "publish", "system"]);
const TARGET_KINDS = new Set(["vault", "instance", "publication"]);
/** The layer that produced a verdict. A bounded enum, never request material. */
export const SHADOW_PHASES = Object.freeze(["transport", "tool", "resource", "vault-scope", "web", "stream", "upload", "publish", "git", "admin"]);
/** Why a unit could not be compared. A bounded enum, never request material. */
export const SHADOW_INCONCLUSIVE_REASONS = Object.freeze([
  "no_legacy_verdict", "no_new_verdict", "runtime_not_ready", "clock_unreadable",
  "unreadable_entry", "batch_shared_verdict", "pending_overflow",
]);
const PHASES = new Set(SHADOW_PHASES);
const REASONS = new Set(SHADOW_INCONCLUSIVE_REASONS);
// A stable machine code is all a row keeps of either verdict: the old and the new
// layer name some families differently, and the difference is for review.
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
// Boundary keys are catalog keys: tool names, resource URIs, `<METHOD> <path>`.
const BOUNDARY_PATTERN = /^[A-Za-z0-9_.:@*/ -]{1,160}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:#-]{1,96}$/;

/** Exactly the fields design §10 step 5 allows, plus the two attribution keys. */
export const AUTHORIZATION_SHADOW_ROW_KEYS = Object.freeze([
  "requestId", "boundary", "phase", "surface", "capability", "targetKind",
  "oldAllowed", "newAllowed", "oldCode", "newCode",
  "sourceRevision", "newRevision", "inconclusiveReason",
]);

const MAX_CAPACITY = 4096;
// A coverage set is bounded by the catalog (184 boundaries), never by traffic.
const MAX_COVERED_BOUNDARIES = 2048;
// One request cannot hold more authorization units than this, and one unit cannot
// hold more layers than this. Both are far above the real maximum (4 layers, and a
// batch of the catalog's tools), and both keep the pending record bounded.
const MAX_UNITS_PER_REQUEST = 16;
const MAX_LAYERS_PER_UNIT = 8;
const SHADOW_READ_ONLY = "authorization_shadow_read_only";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codeOf(value) {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : null;
}

function revisionOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function allowedOf(value) {
  return typeof value === "boolean" ? value : null;
}

function boundaryOf(value) {
  return typeof value === "string" && BOUNDARY_PATTERN.test(value) ? value : null;
}

function phaseOf(value) {
  return PHASES.has(value) ? value : null;
}

function reasonOf(value) {
  return REASONS.has(value) ? value : null;
}

/**
 * One row: the whitelist only. An unreadable field becomes `null`, which makes the
 * pair inconclusive — it can never become `false` (design §11.2).
 */
function shadowRow(source, fallbackRequestId) {
  const input = isRecord(source) ? source : {};
  const requestId = typeof input.requestId === "string" && REQUEST_ID_PATTERN.test(input.requestId) ? input.requestId : fallbackRequestId;
  const target = input.target;
  return Object.freeze({
    requestId: typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId) ? requestId : null,
    boundary: boundaryOf(input.boundary),
    phase: phaseOf(input.phase),
    surface: SURFACES.has(input.surface) ? input.surface : null,
    capability: typeof input.capability === "string" && CAPABILITY_PATTERN.test(input.capability) ? input.capability : null,
    targetKind: TARGET_KINDS.has(target?.kind) ? target.kind : (TARGET_KINDS.has(input.targetKind) ? input.targetKind : null),
    oldAllowed: allowedOf(input.oldAllowed),
    newAllowed: allowedOf(input.newAllowed),
    oldCode: codeOf(input.oldCode),
    newCode: codeOf(input.newCode),
    sourceRevision: revisionOf(input.sourceRevision),
    newRevision: revisionOf(input.newRevision),
    inconclusiveReason: reasonOf(input.inconclusiveReason),
  });
}

/** `match`, `difference` or `inconclusive`, from the stored row alone. */
function classifyRow(row) {
  if (row.inconclusiveReason !== null) return "inconclusive";
  if (row.boundary === null || row.phase === null) return "inconclusive";
  if (row.surface === null || row.capability === null || row.targetKind === null) return "inconclusive";
  if (row.oldAllowed === null || row.newAllowed === null) return "inconclusive";
  if (row.oldCode === null || row.newCode === null) return "inconclusive";
  if (row.oldAllowed !== row.newAllowed) return "difference";
  // Two denials of different families are not agreement either (§11.1 compares the
  // stable error family, not only the boolean).
  return row.oldAllowed === true || row.oldCode === row.newCode ? "match" : "difference";
}

/**
 * The two sides of one authorization unit, from every layer that answered it.
 *
 * The effective old answer is the FIRST layer that denied, or an allow when every
 * layer passed. The new answer is read at that same layer; when every layer allowed,
 * it is the first layer whose new verdict denies (the request reached the handler
 * only because every old layer allowed, so agreement needs every new layer to allow
 * too). A layer that the old gate never reached can therefore not invent a
 * difference.
 */
function finishUnit(entries, requestId) {
  const decisive = entries.find((entry) => entry.legacyAllowed === false) ?? null;
  const newDecisive = decisive ?? entries.find((entry) => entry.newAllowed === false) ?? entries[entries.length - 1];
  const anchor = decisive ?? newDecisive ?? entries[entries.length - 1];
  const refused = entries.find((entry) => entry.inconclusiveReason !== null) ?? null;
  return shadowRow({
    requestId,
    boundary: anchor?.boundary ?? null,
    phase: anchor?.phase ?? null,
    surface: anchor?.surface ?? null,
    capability: anchor?.capability ?? null,
    targetKind: anchor?.targetKind ?? null,
    oldAllowed: decisive === null ? true : false,
    oldCode: decisive === null ? "allowed" : decisive.legacyCode,
    newAllowed: newDecisive?.newAllowed ?? null,
    newCode: newDecisive?.newCode ?? null,
    sourceRevision: anchor?.sourceRevision ?? null,
    newRevision: newDecisive?.newRevision ?? null,
    inconclusiveReason: refused === null ? null : refused.inconclusiveReason,
  }, requestId);
}

/**
 * `observeAuthorization(pair, sink) -> void`
 *
 * Writes exactly one bounded row to `sink`. It returns nothing on purpose: a shadow
 * comparison must not be usable as an authorization answer. A throwing sink is
 * swallowed, because a diagnostic failure may never change a response.
 */
export function observeAuthorization(pair, sink) {
  if (typeof sink !== "function") throw new TypeError("the shadow sink must be a function");
  const row = shadowRow(pair, null);
  try {
    sink(row);
  } catch {
    // A broken sink changes no answer.
  }
}

/** `{}` for an empty record; the counters of a recorder otherwise. */
export function shadowSummary(recorder = null) {
  if (recorder === null || typeof recorder?.summary !== "function") {
    return Object.freeze({
      compared: 0, matches: 0, differences: 0, inconclusive: 0,
      coveredBoundaryKeys: Object.freeze([]), capacity: 0, dropped: 0, sinkFailures: 0,
      pendingScopes: 0,
    });
  }
  return recorder.summary();
}

/**
 * `createShadowRecorder({capacity, sink}) -> {observe, record, begin, summary, rows, requestId}`
 *
 * `begin({requestId})` opens one authorization unit context; `record(entry)` adds a
 * layer verdict to the unit of the request in flight (an MCP member, a Web route);
 * `end()` emits the unit rows. `record()` outside a context emits immediately, so a
 * single decision still yields exactly one row.
 */
export function createShadowRecorder({ capacity = 256, sink = null } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new TypeError(`the shadow record needs a capacity of 1..${MAX_CAPACITY}`);
  }
  if (sink !== null && typeof sink !== "function") throw new TypeError("the shadow sink must be a function or null");

  const rows = [];
  const covered = new Set();
  const counters = { compared: 0, matches: 0, differences: 0, inconclusive: 0, dropped: 0, sinkFailures: 0 };
  // Open authorization-unit scopes. A well-behaved producer closes a scope when its unit
  // finishes, so this number stays bounded by concurrent requests, never by queue length.
  let openScopes = 0;
  let sequence = 0;
  // Recorder-owned copy of the current scope: `begin()` nests through `withShadowRequest`.
  const scopeOf = () => requestScope.getStore() ?? null;

  function emit(row, target) {
    const outcome = classifyRow(row);
    counters.compared += 1;
    counters[outcome === "match" ? "matches" : outcome === "difference" ? "differences" : "inconclusive"] += 1;
    if (rows.length >= capacity) {
      rows.shift();
      counters.dropped += 1;
    }
    rows.push(row);
    if (row.boundary !== null && covered.size < MAX_COVERED_BOUNDARIES) covered.add(row.boundary);
    if (typeof target === "function") {
      try {
        target(row);
      } catch {
        counters.sinkFailures += 1;
      }
    }
    return outcome;
  }

  function unitKeyOf(entry) {
    return [entry.surface, entry.capability, entry.targetKind, entry.targetId ?? ""].join("|");
  }

  /**
   * Attach one layer to the authorization unit it belongs to.
   *
   * A unit key has no member discriminator: two `tools/call` members of the same tool
   * on the same Vault are the same key. Each unit holds at most one entry per PHASE,
   * so a layer joins the earliest unit of its key that has no entry for that phase yet.
   * Repeating members therefore stay separate units, in dispatch order, while the
   * transport, tool and Vault layers of ONE member still share one unit.
   */
  function addLayer(scope, entry) {
    const key = unitKeyOf(entry);
    let units = scope.units.get(key);
    if (units === undefined) {
      units = [];
      scope.units.set(key, units);
    }
    let unit = units.find((candidate) => !candidate.some((existing) => existing.phase === entry.phase));
    if (unit === undefined) {
      if (scope.unitCount >= MAX_UNITS_PER_REQUEST) {
        scope.overflow = true;
        return;
      }
      unit = [];
      units.push(unit);
      scope.unitCount += 1;
    }
    if (unit.length >= MAX_LAYERS_PER_UNIT) {
      unit.push({ inconclusiveReason: "pending_overflow" });
      return;
    }
    unit.push(entry);
  }

  function endScope(scope) {
    if (scope.ended) return;
    scope.ended = true;
    openScopes -= 1;
    const units = [...scope.units.values()].flat();
    const many = units.length > 1;
    for (let index = 0; index < units.length; index += 1) {
      const requestId = many ? `${scope.requestId}#${index}` : scope.requestId;
      emit(finishUnit(units[index], requestId), sink);
    }
    if (scope.overflow) {
      // The loss is reported, never silent: one bounded row per overflowed request.
      emit(shadowRow({ requestId: `${scope.requestId}#overflow`, inconclusiveReason: "pending_overflow" }, null), sink);
    }
  }

  /** Open one authorization-unit context. `end()` is idempotent and safe to call twice. */
  function begin({ requestId = null } = {}) {
    const id = typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId) ? requestId : `shadow-${sequence += 1}`;
    openScopes += 1;
    const scope = {
      recorder: api,
      requestId: id,
      units: new Map(),
      unitCount: 0,
      overflow: false,
      ended: false,
      record(entry) { addLayer(this, entry); },
      end() { endScope(this); },
    };
    return scope;
  }

  /** One layer verdict of the request in flight (or an immediate single row). */
  function record(entry) {
    const scope = scopeOf();
    if (scope !== null && scope.recorder === api) {
      scope.record(entry);
      return;
    }
    const single = begin({ requestId: entry?.requestId });
    single.record(entry);
    single.end();
  }

  /** The single-decision form: one pair, one row, no aggregation. */
  function observe(pair, override = null) {
    const target = override ?? sink;
    const row = shadowRow({
      ...(isRecord(pair) ? pair : {}),
      boundary: pair?.boundary ?? pair?.boundaryKey ?? null,
      phase: pair?.phase ?? "tool",
      inconclusiveReason: pair?.inconclusiveReason ?? (pair?.comparable === false ? pair?.reason ?? "unreadable_entry" : null),
    }, typeof pair?.requestId === "string" ? pair.requestId : `shadow-${sequence += 1}`);
    // `emit` takes the sink per call, so an override never replaces the recorder sink.
    return emit(row, typeof target === "function" ? target : null);
  }

  function summary() {
    return Object.freeze({
      compared: counters.compared,
      matches: counters.matches,
      differences: counters.differences,
      inconclusive: counters.inconclusive,
      coveredBoundaryKeys: Object.freeze([...covered].sort()),
      capacity,
      dropped: counters.dropped,
      sinkFailures: counters.sinkFailures,
      pendingScopes: openScopes,
    });
  }

  function snapshotRows() {
    return Object.freeze([...rows]);
  }

  const api = Object.freeze({
    observe,
    record,
    begin,
    summary,
    rows: snapshotRows,
    requestId: () => scopeOf()?.requestId ?? null,
  });
  return api;
}

/** The request-scoped authorization unit context (one per HTTP request or frame). */
const requestScope = new AsyncLocalStorage();

/**
 * Run `fn` inside one authorization-unit context. A nested call (a stream frame
 * inside a request, say) shadows the outer context and ends on its own.
 */
export function withShadowRequest(scope, fn) {
  return requestScope.run(scope, fn);
}

/** The request id of the context in flight, or `null`. */
export function currentShadowRequestId() {
  return requestScope.getStore()?.requestId ?? null;
}

/**
 * `createShadowCandidate({build, liveRevision}) -> store-shaped, in-memory only`
 *
 * The shadow candidate document never touches the disk before P4: it is built from
 * the frozen legacy state and rebuilt when that state's stamp moves. It offers the
 * four store methods the runtime asks for, and refuses every write, so no P2 path can
 * make it an authority. A candidate that cannot be built is `broken`, which denies;
 * "file missing = broken" only applies after the P4 switch.
 */
export function createShadowCandidate({ build, liveRevision } = {}) {
  if (typeof build !== "function") throw new TypeError("the shadow candidate needs a build function");
  if (typeof liveRevision !== "function") throw new TypeError("the shadow candidate needs a live revision source");

  let state = Object.freeze({ status: "loading" });
  let builtRevision = null;

  function readLive() {
    try {
      const value = liveRevision();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  function rebuild(live) {
    builtRevision = live;
    try {
      const result = build(live);
      if (isRecord(result) && result.status === "ready" && isRecord(result.document)) {
        state = Object.freeze({ status: "ready", revision: revisionOf(result.document.revision), document: result.document });
        return;
      }
      state = Object.freeze({ status: "broken" });
    } catch {
      state = Object.freeze({ status: "broken" });
    }
  }

  function snapshot() {
    const live = readLive();
    // An unreadable source revision cannot be tied to one snapshot: it is not a
    // comparison input, so the candidate reports itself broken instead of stale.
    if (live === null) return Object.freeze({ status: "broken" });
    if (live !== builtRevision) rebuild(live);
    return state;
  }

  const ready = Promise.resolve().then(() => { snapshot(); });

  return Object.freeze({
    ready,
    snapshot,
    sourceRevision: () => builtRevision,
    replace: () => ({ ok: false, revision: null, code: SHADOW_READ_ONLY }),
    repair: () => ({ ok: false, revision: null, code: SHADOW_READ_ONLY }),
    drain: () => Promise.resolve(),
  });
}
