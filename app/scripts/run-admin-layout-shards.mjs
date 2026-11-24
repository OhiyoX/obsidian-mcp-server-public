// Run every shard of the Admin layout gate and prove the slices tile the scene (issue #378).
//
// The shards run CONCURRENTLY. Measured 2026-11-21 on this container: one shard costs ~24 s of which
// ~10 s is its own Chromium launch plus its own server boot, and the unsharded scene takes 86 s. Three
// shards in sequence therefore cost ~72 s — slower than not sharding at all in wall-clock terms, and
// the release gate spent most of its 130 s here. Concurrency is what makes the split pay: the boot
// cost overlaps instead of repeating. Each shard keeps its own output directory and its own log.
//
//   node scripts/run-admin-layout-shards.mjs [shard count, default 3]
//
// A CI job that runs one shard calls `run-admin-layout-checks.mjs --shard=<i>/<n>` directly. This
// entry is the local/CI-wide guard: it fails when a shard fails, when two shards claim the same check
// name, or when the shards together do not cover every scene exactly once (one scene = one shard =
// the same set of check names: `web-regression/admin-layout-shard.mjs`). Each shard writes into its
// own output directory, because every shard rewrites `admin-layout-results.json` and the trace.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const count = Number(process.argv[2] ?? 3);
if (!Number.isInteger(count) || count < 1) {
  console.error(`shard count must be a whole number >= 1, got ${process.argv[2]}`);
  process.exit(2);
}
const baseOutput = path.resolve(process.env.WEB_TEST_OUTPUT || path.join(os.tmpdir(), 'obsidian-admin-layout-shards'));

const names = [];
const failures = [];
const census = new Map();
const runShard = (index) => new Promise((resolve) => {
  const shard = `${index}/${count}`;
  const outputRoot = path.join(baseOutput, `shard-${index}-of-${count}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const logFile = path.join(outputRoot, 'shard.log');
  const log = fs.openSync(logFile, 'w');
  const startedAt = Date.now();
  // `stdio: 'inherit'` cannot be used here: concurrent shards would interleave their output and a
  // failure inside one shard would look like a failure of whichever line printed next.
  const child = spawn(process.execPath, [path.join(appRoot, 'scripts', 'run-admin-layout-checks.mjs'), `--shard=${shard}`], {
    cwd: appRoot,
    stdio: ['ignore', log, log],
    env: { ...process.env, WEB_TEST_OUTPUT: outputRoot },
  });
  child.once('error', (error) => {
    fs.closeSync(log);
    resolve({ shard, outputRoot, status: 1, seconds: 0, error: error.message });
  });
  child.once('exit', (status, signal) => {
    fs.closeSync(log);
    resolve({ shard, outputRoot, status: status ?? 1, signal, seconds: Math.round((Date.now() - startedAt) / 1000) });
  });
});

const startedAll = Date.now();
const runs = await Promise.all(Array.from({ length: count }, (_, offset) => runShard(offset + 1)));
for (const run of runs) {
  console.log(`\n===== admin-layout shard ${run.shard} (${run.outputRoot}) =====`);
  const logText = fs.existsSync(path.join(run.outputRoot, 'shard.log')) ? fs.readFileSync(path.join(run.outputRoot, 'shard.log'), 'utf8') : '';
  // The tail is what a reader needs; the full log stays beside the shard's own results.
  process.stdout.write(logText.split('\n').slice(-8).join('\n'));
  console.log(`\n----- admin-layout shard ${run.shard}: ${run.status === 0 ? 'passed' : 'FAILED'} in ${run.seconds}s -----`);
  if (run.error) failures.push(`shard ${run.shard} could not start: ${run.error}`);
  else if (run.status !== 0) failures.push(`shard ${run.shard} exited ${run.status ?? run.signal}`);

  const resultsFile = path.join(run.outputRoot, 'admin-layout-results.json');
  const traceFile = path.join(run.outputRoot, 'admin-layout-trace.json');
  const shardNames = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')).results.map((item) => item.name) : [];
  if (shardNames.length === 0) failures.push(`shard ${run.shard} wrote no check results (${resultsFile})`);
  for (const name of shardNames) {
    if (names.includes(name)) failures.push(`check ran twice across shards: ${name}`);
    names.push(name);
  }
  const executed = fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')).executed ?? [] : [];
  for (const id of executed) {
    if (census.has(id)) failures.push(`scene ${id} ran in shard ${census.get(id)} and in shard ${run.shard}`);
    census.set(id, run.shard);
  }
}
console.log(`\nall ${count} shards finished in ${Math.round((Date.now() - startedAll) / 1000)}s`);

// Full coverage: every scene the gate owns is in exactly one shard. The scene ids come from the
// census each shard writes, so a scene that silently dropped out of a slice shows up as a gap.
const traceOf = (index) => {
  const file = path.join(baseOutput, `shard-${index}-of-${count}`, 'admin-layout-trace.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};
const expected = (traceOf(1).census ?? []).map((entry) => entry.id);
const missing = expected.filter((id) => !census.has(id));
const unknown = [...census.keys()].filter((id) => !expected.includes(id));
if (missing.length) failures.push(`no shard ran these scenes: ${missing.join(', ')}`);
if (unknown.length) failures.push(`shards ran scenes outside the census: ${unknown.join(', ')}`);
// The census of every shard is the same table; a shard whose owner map disagrees is a partition bug.
for (let index = 2; index <= count; index += 1) {
  for (const entry of traceOf(index).census ?? []) {
    if (census.get(entry.id) !== `${entry.owner}/${count}`) failures.push(`scene ${entry.id} belongs to shard ${entry.owner}/${count} but ran in ${census.get(entry.id)}`);
  }
}

console.log(`\nadmin-layout shards ${count}: ${names.length} check results, ${census.size}/${expected.length} scenes covered`);
if (failures.length) {
  for (const failure of failures) console.error(`SHARD FAILED: ${failure}`);
  process.exitCode = 1;
}
