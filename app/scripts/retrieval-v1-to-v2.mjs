// M2 — offline legacy -> v2 migration CLI (plan 02 Task 3, Step 3).
//
// Production must never convert on the first ordinary query, because that parse
// costs about a gigabyte. This script converts an *isolated copy* and prints a
// machine-readable report; the operator then switches the container to it.
//
// Usage:
//   node scripts/retrieval-v1-to-v2.mjs --source=<copy>/index/retrieval-index.json \
//     --report=<out>/migration.json [--limit-bytes=N] [--allow-real-root]
//
// Run it as the service user when the target is a live data directory, otherwise the
// new `retrieval-index-v2/` directory belongs to root and every later commit fails:
//   docker run --rm --user 1002:10 -v <data>:/data --entrypoint node <image> \
//     scripts/retrieval-v1-to-v2.mjs --source=/data/index/retrieval-index.json --allow-real-root
// A running process keeps the blocked state until it restarts, so restart once after
// migrating.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { legacyIndexState, migrateLegacyIndex } from "../src/vault-runtime/retrieval-index-migration.js";
import { openIndexStore } from "../src/vault-runtime/retrieval-index-store.js";

const SELF = fileURLToPath(import.meta.url);
const FORBIDDEN_ROOTS = ["/data", "/srv", "/volume2", "/vault", "/vaults", "/app"];

/** The real production roots need an explicit `--allow-real-root`. */
export function assertAllowedSource(source, { allowRealRoot = false } = {}) {
  if (typeof source !== "string" || source === "") throw new Error("--source is required");
  const resolved = path.resolve(source);
  if (allowRealRoot) return resolved;
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`refusing to convert inside ${forbidden}: convert an isolated copy first, or pass --allow-real-root`);
    }
  }
  return resolved;
}

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    const match = /^--([^=]+)=?(.*)$/u.exec(entry);
    if (match) args[match[1]] = match[2] === "" ? "true" : match[2];
  }
  return args;
}

export async function runMigration({ source, report, limitBytes, allowRealRoot = false } = {}) {
  const resolved = assertAllowedSource(source, { allowRealRoot });
  const store = openIndexStore({ legacyIndexPath: resolved });
  const before = await legacyIndexState(resolved);
  const started = process.hrtime.bigint();
  const result = await migrateLegacyIndex({ legacyIndexPath: resolved, store, limitBytes });
  const elapsedMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1));
  const memory = process.memoryUsage();
  const summary = {
    ...result,
    source: resolved,
    storeRoot: store.root,
    legacyBytes: before.bytes,
    elapsedMs,
    peak: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers },
  };
  if (report) {
    await fs.mkdir(path.dirname(path.resolve(report)), { recursive: true });
    await fs.writeFile(path.resolve(report), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  return summary;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  runMigration({
    source: args.source,
    report: args.report,
    limitBytes: args["limit-bytes"] === undefined ? undefined : Number(args["limit-bytes"]),
    allowRealRoot: args["allow-real-root"] === "true",
  })
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
