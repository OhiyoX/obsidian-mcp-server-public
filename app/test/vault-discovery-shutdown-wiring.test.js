// W4 (#437) — F1 (independent review, non-blocking): the SHUTDOWN WIRING of the automatic discovery
// triggers had zero automated coverage. The reviewer deleted `server.js`'s stop call entirely and a
// 63-file directed suite stayed green (459 pass / 0 fail), so nothing in the repository would notice
// if a later refactor moved that call away.
//
// WHAT THIS FILE IS — a WIRING-EXISTENCE check, not a behavior test. It reads the production sources
// and asserts that every link of the chain still exists and is still in the right place:
//
//   server.js (shutdown handler)  ->  vault-startup.stopVaultDiscoverySchedulers()
//     ->  vault-registry.stopVaultDiscovery()  ->  vault-admission.stopDiscovery()
//       ->  vault-watcher.stop()  (closes handles + clears timers)
//
// WHAT THIS FILE IS NOT — it does NOT prove that a real SIGTERM reaches the handler, that the watcher
// is actually stopped, or that the process exits gracefully. Those need a Linux/NAS container
// (`docker stop` → tini → SIGTERM); on this host (Windows/MSYS) `kill -TERM` becomes
// TerminateProcess and the graceful branch is unobservable. Real-signal integration is W5.
// The behavior of `stop()` itself (handles closed, timers cleared) is covered by the unit tests in
// `vault-watcher.test.js`, and the same call path was observed in a real process by
// `scratch/briefs/w4-evidence/probe-start-stop.mjs`.
//
// NEGATIVE CONTROL (measured, this exact file): deleting the single line
// `try { stopVaultDiscoverySchedulers(); } catch (error) { fail(error); }` from `server.js` makes the
// first test below fail (`shutdown must call the stop seam`), and deleting the arm call after
// `startVaultRuntimeInventory` makes the third one fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFile(path.join(APP_DIR, relative), "utf8");

/** The body of `shutdown(signal)` in server.js, up to the signal registrations that follow it. */
function shutdownBody(source) {
  const start = source.indexOf("function shutdown(signal) {");
  assert.notEqual(start, -1, "server.js must still define shutdown(signal)");
  const end = source.indexOf('process.on("SIGINT"', start);
  assert.notEqual(end, -1, "server.js must still register SIGINT after shutdown()");
  return source.slice(start, end);
}

test("shutdown must call the stop seam (wiring existence, not behavior)", async () => {
  const server = await read("server.js");
  assert.match(
    server,
    /import \{[^}]*\bstopVaultDiscoverySchedulers\b[^}]*\} from "\.\/src\/app\/vault-startup\.js";/,
    "server.js must import the stop seam from the startup module",
  );
  const body = shutdownBody(server);
  assert.match(
    body,
    /stopVaultDiscoverySchedulers\(\)/,
    "the graceful shutdown must stop the automatic discovery triggers (F1: this is the line the reviewer deleted with the suite still green)",
  );
  // Ordering inside shutdown: the triggers stop before the SSE/transport teardown begins, so no new
  // round can start while the process is draining.
  assert.ok(
    body.indexOf("stopVaultDiscoverySchedulers()") < body.indexOf("teardownLiveEvents()"),
    "the discovery triggers must be stopped before the SSE/transport teardown starts",
  );
});

test("the stop chain still exists end to end", async () => {
  const [startup, registry, admission, watcher] = await Promise.all([
    read("src/app/vault-startup.js"),
    read("src/app/vault-registry.js"),
    read("src/app/vault-admission.js"),
    read("src/vault-runtime/vault-watcher.js"),
  ]);
  assert.match(startup, /export function stopVaultDiscoverySchedulers\(\)/, "vault-startup must export the stop seam");
  assert.match(startup, /return stopVaultDiscovery\(\);/, "the stop seam must delegate to the registry seam");
  assert.match(registry, /export const stopVaultDiscovery = \(\) =>/, "vault-registry must export stopVaultDiscovery");
  assert.match(registry, /admissionController\.stopDiscovery\(\)/, "the registry seam must reach the controller");
  assert.match(admission, /function stopDiscovery\(\)/, "the controller must expose stopDiscovery");
  assert.match(admission, /watcher\.stop\(\)/, "the controller must stop the watcher");
  assert.match(watcher, /function stop\(\)/, "the watcher must implement stop()");
  // A watcher that was never armed must not make the stop seam throw (it returns null instead).
  assert.match(admission, /return watcher === null \? null : watcher\.stop\(\);/, "stopDiscovery must be a no-op when discovery is off");
});

test("the process entry arms the triggers only after the startup inventory published", async () => {
  const server = await read("server.js");
  assert.match(
    server,
    /import \{[^}]*\bstartVaultDiscoverySchedulers\b[^}]*\} from "\.\/src\/app\/vault-startup\.js";/,
    "server.js must import the arm seam from the startup module",
  );
  const inventory = server.indexOf("await startVaultRuntimeInventory(");
  const arm = server.indexOf("await startVaultDiscoverySchedulers(");
  assert.notEqual(inventory, -1, "server.js must still start the runtime inventory");
  assert.notEqual(arm, -1, "server.js must arm the automatic discovery triggers");
  assert.ok(arm > inventory, "the triggers must be armed only after the startup round published");
  // And the arm must stay in the process entry, not drift back into the startup helper: the helper is
  // also called by library-style embedders/tests, where long-lived triggers would be unpaired.
  const startup = await read("src/app/vault-startup.js");
  const helper = startup.slice(startup.indexOf("export async function startVaultReconciliation("), startup.indexOf("export async function startVaultDiscoverySchedulers("));
  assert.doesNotMatch(helper, /startVaultDiscovery\(\)/, "startVaultReconciliation must not arm the long-lived triggers itself");
});
