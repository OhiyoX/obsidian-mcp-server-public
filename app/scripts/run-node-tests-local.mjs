#!/usr/bin/env node
// Full `node --test` run with an isolated DATA_PATH, for a local machine.
//
// Why this exists: several suites (`authorization-*`, the Web catalog routes) refuse to run when
// `DATA_PATH` is unset — their first assertion is `DATA_PATH must point at the isolated test
// root`, because the store they exercise writes a real state file. A bare `node --test` therefore
// reports them as failures on a machine that is perfectly fine, which is how "69 failed" readings
// appear (measured 2026-11-19: 69 failures, 61 of them from this guard alone).
//
// CI does not need this: its jobs set the path or run a narrow list. This is the local entry.
//
//   node scripts/run-node-tests-local.mjs                 # whole suite
//   node scripts/run-node-tests-local.mjs test/a.test.js  # one file, same environment
//   DATA_PATH=/somewhere node scripts/run-node-tests-local.mjs   # respect an explicit path
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const own = process.env.DATA_PATH === undefined || process.env.DATA_PATH === "";
const dataPath = own ? fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-tests-")) : process.env.DATA_PATH;

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
  cwd: path.resolve(import.meta.dirname, ".."),
  stdio: "inherit",
  env: { ...process.env, DATA_PATH: dataPath },
});

const cleanUp = () => {
  if (own) fs.rmSync(dataPath, { recursive: true, force: true });
};

child.on("exit", (code, signal) => {
  cleanUp();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
