/**
 * #428 shared driver for Web Catalog child-process acceptance tests.
 *
 * Extracted from `web-catalog-default-path.test.js` so that test file stays inside the line
 * budget (the child harness, the handshake and the isolation predicate are one cohesive concern).
 *
 * Pairs are always: same cwd, same vault id, different Vault roots, one child per process. The
 * parent controls the reconcile order with a stdin/stdout handshake, so the shared-directory case
 * is deterministic instead of timing-dependent. `runSharedDirectoryPair` is the one exception: the
 * negative control WANTS the collision, so it starts both children against one file and classifies
 * whichever harm SQLite charges first (crosstalk, or explicit SQLite BUSY/LOCKED evidence tied to
 * that one file) with `classifySharedDirectoryHarm`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = path.join(APP_ROOT, "test", "helpers", "web-catalog-path-child.mjs");

export { APP_ROOT, HELPER };

/**
 * Start one real `node` process running the catalog child harness.
 * `env` values are the location inputs under test; an inherited `WEB_CATALOG_DIR` is deleted
 * unless the case sets it explicitly.
 */
export function startCatalogChild({ label, cwd, env, timeoutMs = 30_000 }) {
  const childEnv = { ...process.env, WEB_CATALOG_ENABLED: "true", ...env };
  if (!Object.prototype.hasOwnProperty.call(env, "WEB_CATALOG_DIR")) delete childEnv.WEB_CATALOG_DIR;

  const child = spawn(process.execPath, [HELPER], { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const queue = [];
  const waiters = [];
  let stdout = "";
  let stderr = "";
  let exited = null;
  let location = null;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const index = stdout.indexOf("\n");
      if (index < 0) break;
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.event === "location") location = message.location;
      if (message.event === "error") {
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`${label} reported: ${message.message}`));
        }
        continue;
      }
      const waiterIndex = waiters.findIndex((waiter) => waiter.event === message.event);
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const failWaiters = (error) => {
    exited = exited ?? { error };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  child.on("error", (error) => {
    stderr += `\nspawn error: ${error.message}`;
    failWaiters(error);
  });
  child.on("close", (code, signal) => {
    exited = exited ?? { code, signal };
    failWaiters(new Error(`${label} closed early (${code}/${signal})\nstderr:\n${stderr}`));
  });

  const api = {
    get stderr() {
      return stderr;
    },
    /** Resolved catalog location announced before the store opened (null until it arrives). */
    get location() {
      return location;
    },
    /** `{ code, signal }` once the process closed normally; null while it is alive or on spawn error. */
    get exitStatus() {
      return exited && Object.prototype.hasOwnProperty.call(exited, "code") ? exited : null;
    },
    awaitExit() {
      if (exited) return Promise.resolve(exited);
      return new Promise((resolve) => child.once("close", (code, signal) => resolve(exited ?? { code, signal })));
    },
    awaitEvent(event) {
      const index = queue.findIndex((message) => message.event === event);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      if (exited) {
        return Promise.reject(
          exited.error ?? new Error(`${label} already exited (${exited.code}/${exited.signal})\nstderr:\n${stderr}`),
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label} timed out waiting for "${event}"\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
          timeoutMs,
        );
        waiters.push({ event, resolve, reject, timer });
      });
    },
    command(cmd, event) {
      if (!child.stdin) throw new Error(`${label} has no stdin (spawn failed)\nstderr:\n${stderr}`);
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
      return api.awaitEvent(event);
    },
    async stop() {
      if (exited) return;
      try {
        await Promise.race([
          api.command({ cmd: "exit" }, "closed"),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch {
        // fall through to the kill path
      }
      if (!exited) {
        try {
          child.kill();
        } catch {
          // already gone
        }
        await Promise.race([
          new Promise((resolve) => child.once("close", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    },
  };
  return api;
}

/** Run a full pair: ready -> reconcile A -> reconcile B -> read A -> read B. */
export async function runCatalogPair({ name, cwd, envA, envB, vaultA, vaultB, noteA, noteB, tokenA, tokenB }) {
  const childA = startCatalogChild({
    label: `${name}:A`,
    cwd,
    env: {
      VAULT_PATH: vaultA,
      I428_VAULT_ROOT: vaultA,
      I428_VAULT_ID: "default",
      I428_OWN_NOTE: noteA,
      I428_OWN_TOKEN: tokenA,
      I428_OTHER_NOTE: noteB,
      I428_OTHER_TOKEN: tokenB,
      ...envA,
    },
  });
  const childB = startCatalogChild({
    label: `${name}:B`,
    cwd,
    env: {
      VAULT_PATH: vaultB,
      I428_VAULT_ROOT: vaultB,
      I428_VAULT_ID: "default",
      I428_OWN_NOTE: noteB,
      I428_OWN_TOKEN: tokenB,
      I428_OTHER_NOTE: noteA,
      I428_OTHER_TOKEN: tokenA,
      ...envB,
    },
  });
  try {
    const readyA = await childA.awaitEvent("ready");
    const readyB = await childB.awaitEvent("ready");
    // Handshake: A fully reconciles before B starts, so the shared-directory case is deterministic.
    const reconciledA = await childA.command({ cmd: "reconcile" }, "reconciled");
    const reconciledB = await childB.command({ cmd: "reconcile" }, "reconciled");
    const readA = await childA.command({ cmd: "read" }, "read");
    const readB = await childB.command({ cmd: "read" }, "read");
    return { readyA, readyB, reconciledA, reconciledB, readA, readB };
  } finally {
    await childA.stop();
    await childB.stop();
  }
}

/** The cross-process acceptance predicate: only this Vault's markers, in tree and in FTS. */
export function isolationHolds(evidence, ownPath, otherPath) {
  return (
    evidence.own?.path === ownPath &&
    evidence.own.located === true &&
    evidence.own.fts >= 1 &&
    evidence.other?.located === false &&
    evidence.other.fts === 0 &&
    evidence.tree.notes.includes(ownPath) &&
    !evidence.tree.notes.includes(otherPath)
  );
}

// ---------------------------------------------------------------------------
// #428 negative-control driver (a shared effective directory)
// ---------------------------------------------------------------------------

/** One child's open phase: never throws, records why the open failed. */
async function openChild(child) {
  const facts = { opened: false, phase: "open", failures: [], reconcile: null, read: null };
  const ready = child.awaitEvent("ready").then(
    () => true,
    (error) => {
      facts.failures.push({ phase: "open", message: error.message || String(error) });
      return false;
    },
  );
  facts.opened = await Promise.race([ready, child.awaitExit().then(() => false)]);
  return facts;
}

/**
 * Start two real children at the SAME time against ONE effective catalog directory — the shape the
 * retired `process.cwd()/data/web-catalog` default produced. Evidence is collected in phases
 * (open -> reconcile -> read) so a pair that opens the file successfully still shows the crosstalk,
 * while a pair that collides on the SQLite file shows the contention instead. Never throws; the
 * caller classifies the record with `classifySharedDirectoryHarm`.
 */
export async function runSharedDirectoryPair({ name, cwd, env, sharedFile, a, b }) {
  const spawnSide = (label, vault, note, token, otherNote, otherToken) =>
    startCatalogChild({
      label: `${name}:${label}`,
      cwd,
      env: {
        VAULT_PATH: vault,
        I428_VAULT_ROOT: vault,
        I428_VAULT_ID: "default",
        I428_OWN_NOTE: note,
        I428_OWN_TOKEN: token,
        I428_OTHER_NOTE: otherNote,
        I428_OTHER_TOKEN: otherToken,
        ...env,
      },
    });

  const children = {
    a: spawnSide("A", a.vault, a.note, a.token, b.note, b.token),
    b: spawnSide("B", b.vault, b.note, b.token, a.note, a.token),
  };
  const record = {
    sharedFile,
    notes: { a: { own: a.note, other: b.note }, b: { own: b.note, other: a.note } },
    sides: {},
  };
  try {
    // Both processes race for the one file, exactly like two servers on the retired default.
    await Promise.all(Object.entries(children).map(async ([side, child]) => {
      record.sides[side] = await openChild(child);
    }));
    // Reconcile every process that opened BEFORE any read, so a pair that shares the file
    // successfully must show the other Vault's note.
    await Promise.all(Object.entries(children).map(async ([side, child]) => {
      const facts = record.sides[side];
      if (!facts.opened) return;
      facts.phase = "reconcile";
      try {
        facts.reconcile = (await child.command({ cmd: "reconcile" }, "reconciled")).evidence;
      } catch (error) {
        facts.failures.push({ phase: "reconcile", message: error.message || String(error) });
      }
    }));
    await Promise.all(Object.entries(children).map(async ([side, child]) => {
      const facts = record.sides[side];
      if (!facts.opened) return;
      facts.phase = "read";
      try {
        facts.read = (await child.command({ cmd: "read" }, "read")).evidence;
      } catch (error) {
        facts.failures.push({ phase: "read", message: error.message || String(error) });
      }
    }));
  } finally {
    // Snapshot exit/stderr/location BEFORE teardown, so a child this driver SIGTERMs itself can
    // never be mistaken for a child that crashed on its own.
    for (const [side, child] of Object.entries(children)) {
      record.sides[side].location = child.location;
      record.sides[side].exit = child.exitStatus;
      record.sides[side].stderr = child.stderr;
    }
    for (const child of Object.values(children)) await child.stop();
  }
  return record;
}

/**
 * The ONLY accepted contention evidence: an explicit SQLite BUSY/LOCKED signal.
 *
 * Deliberately a whitelist, not a shape match. A generic `ERR_SQLITE_ERROR` code covers every
 * SQLite failure (a syntax error, a corrupt page, an I/O error), and the string `web-catalog`
 * appears in this helper's own file name, so either of them would accept an unrelated failure —
 * e.g. a `TypeError` whose stack merely names a file under `app/test/helpers/web-catalog-*`.
 */
const CONTENTION_EVIDENCE = [
  { id: "SQLITE_BUSY", pattern: /SQLITE_BUSY/i },
  { id: "SQLITE_LOCKED", pattern: /SQLITE_LOCKED/i },
  { id: "database-is-locked", pattern: /database is locked/i },
  { id: "database-table-is-locked", pattern: /database table is locked/i },
  { id: "database-schema-is-locked", pattern: /database schema is locked/i },
];

/** The phases in which the SHARED catalog file is opened, migrated or read. */
const CONTENTION_PHASES = new Set(["open", "reconcile", "read"]);

/**
 * #428 negative-control verdict.
 *
 * Sharing one effective directory is harmful in one of two observable ways, and which one appears
 * depends on SQLite lock timing rather than on the code under test:
 *   (i)  crosstalk — a process reads the other Vault's note (or loses its own) out of the shared
 *        store, i.e. the very isolation acceptance that the positive control asserts reports false;
 *   (ii) contention — a process fails while opening/reconciling/reading the SHARED catalog file and
 *        the failure carries explicit SQLite BUSY/LOCKED evidence in that phase.
 * Both are accepted and both are recorded. Contention needs ALL of: (a) the failing process named
 * the shared file, (b) whitelisted BUSY/LOCKED evidence (`CONTENTION_EVIDENCE`), and (c) that
 * evidence inside an open/reconcile/read phase observation. Everything else — a timeout, an
 * unrelated `TypeError`, a non-lock SQLite error, a failure in another phase or against another
 * file — lands in `untiedFailures`, so it cannot satisfy the control.
 */
export function classifySharedDirectoryHarm({ sharedFile, notes, sides }) {
  const verdict = { sharedFile, isolation: {}, crosstalk: [], contention: [], untiedFailures: [] };
  for (const [side, facts] of Object.entries(sides)) {
    if (facts.read) {
      verdict.isolation[side] = isolationHolds(facts.read, notes[side].own, notes[side].other);
      if (!verdict.isolation[side]) {
        verdict.crosstalk.push({
          side,
          own: facts.read.own,
          other: facts.read.other,
          notes: facts.read.tree?.notes ?? [],
        });
      }
    } else {
      verdict.isolation[side] = null;
    }
    const died = Boolean(facts.exit) && facts.exit.code !== 0;
    if (facts.failures.length === 0 && !died) continue;
    // Observations that can carry contention evidence. A process that died without a recorded
    // phase failure is attributed to the phase it was in, with its stderr as the message.
    const observations = facts.failures.map((failure) => ({ phase: failure.phase, message: failure.message }));
    if (died && observations.length === 0) {
      observations.push({ phase: facts.phase ?? null, message: String(facts.stderr ?? "") });
    }
    const contention = observations
      .filter((observation) => CONTENTION_PHASES.has(observation.phase))
      .map((observation) => ({
        phase: observation.phase,
        evidence: CONTENTION_EVIDENCE.filter((item) => item.pattern.test(observation.message)).map((item) => item.id),
      }))
      .filter((observation) => observation.evidence.length > 0);
    const tiedToSharedFile = facts.location?.file === sharedFile && contention.length > 0;
    const entry = {
      side,
      tiedToSharedFile,
      location: facts.location ?? null,
      exit: facts.exit ?? null,
      failures: facts.failures,
      contention,
      stderrTail: String(facts.stderr ?? "").split("\n").slice(-12).join("\n"),
    };
    (tiedToSharedFile ? verdict.contention : verdict.untiedFailures).push(entry);
  }
  verdict.harmObserved = verdict.crosstalk.length > 0 || verdict.contention.length > 0;
  verdict.harmless = !verdict.harmObserved;
  return verdict;
}
