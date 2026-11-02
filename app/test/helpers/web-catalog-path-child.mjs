#!/usr/bin/env node
/**
 * #428 Web Catalog location child harness (test helper, never a production entry point).
 *
 * Why a child process: `app/src/config.js` resolves `DATA_PATH` at import time, and the
 * default runtime opens one SQLite file per vault id per process. The acceptance item for
 * #428 is precisely "two real processes, same cwd + same vault id + different DATA_PATH must
 * not share one index", which cannot be observed inside a single module instance.
 *
 * Protocol: newline-delimited JSON.
 *   - stdout `{"event":"location", ...}` is emitted once, BEFORE the store opens, so a process
 *     that dies while opening the catalog still reports which file it was opening.
 *   - stdout `{"event":"ready", ...}` is emitted once, right after the store opens.
 *   - stdin  `{"cmd":"reconcile"}` -> `{"event":"reconciled","evidence":{...}}`
 *   - stdin  `{"cmd":"read"}`      -> `{"event":"read","evidence":{...}}`   (no reconcile)
 *   - stdin  `{"cmd":"exit"}`      -> `{"event":"closed"}` then exit 0
 *
 * Environment:
 *   I428_VAULT_ROOT   vault root for the `{ id, root }` descriptor (required; its absence is
 *                     also the guard that keeps `node --test` discovery from running this file)
 *   I428_VAULT_ID     vault id (default `default`)
 *   I428_OWN_NOTE     vault-relative path of the note this vault owns
 *   I428_OWN_TOKEN    single FTS token inside that note's body
 *   I428_OTHER_NOTE   vault-relative path owned by the *other* vault in the pair
 *   I428_OTHER_TOKEN  single FTS token inside that other note's body
 *   I428_CLEAR_WEB_CATALOG_DIR  `1` removes an inherited `WEB_CATALOG_DIR` before the first
 *                     resolution and reports both the inherited and the effective value, so the
 *                     parent can prove an explicit clear happened instead of assuming "not set"
 *   DATA_PATH / WEB_CATALOG_DIR / VAULT_PATH: the location inputs under test
 *
 * `console.log` is captured instead of written, so the protocol stream stays clean and the
 * open line can be asserted by the parent.
 */
import fs from "node:fs";

const vaultRoot = process.env.I428_VAULT_ROOT;
// Safety: if `node --test` discovery ever picks this helper up as a test file it has no scenario.
if (!vaultRoot) process.exit(0);

// `WEB_CATALOG_DIR` is read at call time, so an explicit clear must happen before the first resolve.
const inheritedWebCatalogDir = process.env.WEB_CATALOG_DIR ?? null;
if (process.env.I428_CLEAR_WEB_CATALOG_DIR === "1") delete process.env.WEB_CATALOG_DIR;

const { getWebCatalogRuntime, resolveWebCatalogLocation } = await import("../../src/app/web-catalog/runtime.js");

function envEvidence() {
  return {
    cwd: process.cwd(),
    clearRequested: process.env.I428_CLEAR_WEB_CATALOG_DIR === "1",
    webCatalogDirInherited: inheritedWebCatalogDir,
    webCatalogDir: process.env.WEB_CATALOG_DIR ?? null,
  };
}

const logs = [];
const writeLog = (...args) => {
  logs.push(args.map(String).join(" "));
};
console.log = writeLog;

const vault = { id: process.env.I428_VAULT_ID || "default", root: vaultRoot };
const own = { path: process.env.I428_OWN_NOTE, token: process.env.I428_OWN_TOKEN };
const other = { path: process.env.I428_OTHER_NOTE, token: process.env.I428_OTHER_TOKEN };

const location = resolveWebCatalogLocation(vault);
// Announced BEFORE the store opens so a child that dies while opening the file still reports WHICH
// file it was opening: the `#428` negative control needs that tie to rule out an unrelated crash.
send("location", { pid: process.pid, cwd: process.cwd(), env: envEvidence(), location });
const runtime = getWebCatalogRuntime(vault, { startReconcile: false });

function send(event, payload = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`);
}

function ftsCount(token) {
  return runtime.store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?").get(token).n;
}

function probe(entry) {
  if (!entry?.path) return null;
  return { path: entry.path, located: runtime.store.locate(entry.path) !== null, fts: ftsCount(entry.token) };
}

function evidence() {
  return {
    pid: process.pid,
    cwd: process.cwd(),
    env: envEvidence(),
    location,
    fileExists: fs.existsSync(location.file),
    started: runtime.isStarted(),
    stale: runtime.store.isStale(),
    logs: [...logs],
    tree: {
      root: runtime.store.listChildren("").items.map((item) => item.path),
      notes: runtime.store.listChildren("Notes").items.map((item) => item.path),
    },
    own: probe(own),
    other: probe(other),
  };
}

send("ready", { pid: process.pid, env: envEvidence(), location, fileExists: fs.existsSync(location.file) });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.cmd === "reconcile") {
      runtime.drain().then(
        () => send("reconciled", { evidence: evidence() }),
        (error) => send("error", { message: error?.message || String(error) }),
      );
    } else if (command.cmd === "read") {
      try {
        send("read", { evidence: evidence() });
      } catch (error) {
        send("error", { message: error?.message || String(error) });
      }
    } else if (command.cmd === "exit") {
      try {
        runtime.close();
      } catch {
        // best-effort shutdown
      }
      send("closed", {});
      process.exit(0);
    }
  }
});
