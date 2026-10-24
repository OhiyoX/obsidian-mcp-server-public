// Shared deterministic fixtures for the per-vault GitRuntime tests.
//
// Extracted verbatim from `git-runtime-factory.test.js` when #436 pushed that file past the line
// architecture budget: the extraction itself changes no behavior. Every `setup()` still builds a fresh
// instance over the injected fake clock/scheduler + fake exec, with no sleeps, no git binary, no
// network and no ambient config (contract §13/§16/§21 MV-I04/§26 A6/§38.2/§44-8).

import os from "node:os";
import path from "node:path";
import { createGitRuntime } from "../../src/git-runtime/runtime.js";

export const T0 = Date.parse("2026-10-05T00:00:00.000Z");
// Absolute and platform-neutral: "D:/vaults/primary" is a plain relative path on Linux (RETURN-1).
export const VAULT_ROOT = path.resolve(os.tmpdir(), "test-vault-primary");
export const AUTHOR = { agent: "cursor", model: "composer" };
export const OTHER_AUTHOR = { agent: "pi", model: "gpt" };

export class FakeClock {
  constructor(start = T0) {
    this.time = start;
    this.seq = 0;
    this.entries = new Map();
  }

  now() {
    return this.time;
  }

  setTimeout(fn, ms = 0) { return this.#arm(fn, ms, null); }

  setInterval(fn, ms = 1) { return this.#arm(fn, ms, Math.max(1, Number(ms) || 1)); }

  clearTimeout(handle) {
    if (handle) this.entries.delete(handle.id);
  }

  clearInterval(handle) {
    if (handle) this.entries.delete(handle.id);
  }

  intervals() {
    return [...this.entries.values()].filter((entry) => entry.interval !== null);
  }

  async advance(ms) {
    const target = this.time + Math.max(0, Number(ms) || 0);
    for (;;) {
      const next = [...this.entries.values()]
        .filter((entry) => entry.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.time = next.due;
      if (next.interval === null) this.entries.delete(next.id);
      else next.due = this.time + next.interval;
      await next.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
  }

  iso() {
    return new Date(this.time).toISOString();
  }

  #arm(fn, ms, interval) {
    const id = ++this.seq;
    const delay = Math.max(0, Number(ms) || 0);
    this.entries.set(id, { id, fn, due: this.time + delay, interval });
    return { id, unref() {} };
  }
}

export function gitError({ code, stderr = "", stdout = "" }) {
  return Object.assign(new Error(stderr || `git exited ${code}`), { code, stderr, stdout });
}

export function defaultRespond(args) {
  if (args.includes("--is-inside-work-tree")) return { stdout: "true\n" };
  if (args.includes("HEAD")) return { stdout: "a1b2c3d4e5\n" };
  if (args.includes("--quiet")) return gitError({ code: 1 }); // staged changes present
  return { stdout: "" };
}

export function fakeGit(respond) {
  const calls = [];
  const exec = async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options });
    const result = await (respond ?? defaultRespond)(args);
    if (result instanceof Error) throw result;
    return { stdout: result?.stdout ?? "", stderr: result?.stderr ?? "" };
  };
  return { exec, calls, commits: () => calls.filter((call) => call.args.includes("commit")), pushes: () => calls.filter((call) => call.args.includes("push")) };
}

export function enabledConfig(patch = {}) {
  return {
    enabled: true, autoCommit: true, autoPush: false, autoCommitSweep: false,
    debounceSeconds: 5, maxDelaySeconds: 900, sweepIntervalSeconds: 30,
    remote: "origin", branch: "", source: "persisted", ...patch,
  };
}

export function setup({ config = enabledConfig(), respond, root = VAULT_ROOT, logger, execEnv } = {}) {
  const clock = new FakeClock();
  const git = fakeGit(respond);
  const logs = [];
  const runtime = createGitRuntime({
    vaultId: "primary",
    root,
    configProvider: () => (typeof config === "function" ? config() : config),
    execFile: git.exec,
    clock,
    execEnv,
    logger: logger ?? {
      warn: (message) => logs.push({ level: "warn", message }),
      error: (message) => logs.push({ level: "error", message }),
    },
  });
  return { runtime, clock, git, logs };
}
