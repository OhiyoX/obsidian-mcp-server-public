#!/usr/bin/env node
// promptctl — publish the Base Prompt pack without rebuilding or restarting the image.
//
//   promptctl base validate [--root app/prompts/base]
//   promptctl base diff     --url https://host --password-stdin [--root DIR]
//   promptctl base publish  --url https://host --revision N --reason TEXT --password-stdin [--root DIR]
//   promptctl base adopt-bundled --url ... --revision N --reason TEXT --password-stdin
//   promptctl rollback TARGET --url ... --revision N --reason TEXT --password-stdin
//   promptctl status        --url ...
//
// The only write path is the Admin console API (session cookie + CSRF). There is no
// API-key or OAuth backdoor. The password arrives on stdin, never in argv, and the
// cookie and password are never printed.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, "..", "prompts", "base");

function usage(code = 2) {
  const text = `promptctl — Base Prompt publishing

usage:
  promptctl base validate [--root DIR]
  promptctl base diff --url URL --password-stdin [--root DIR]
  promptctl base publish --url URL --revision N --reason TEXT --password-stdin [--root DIR]
  promptctl base adopt-bundled --url URL --revision N --reason TEXT --password-stdin
  promptctl rollback TARGET --url URL --revision N --reason TEXT --password-stdin
  promptctl status --url URL --password-stdin
  promptctl override show --url URL --password-stdin
  promptctl override publish --url URL --revision N --reason TEXT --set key=text [--set ...] [--tuning repeatAfterReads=N] --password-stdin
  promptctl override reset --url URL --revision N --reason TEXT --key key [--key ...] --password-stdin
  promptctl override promote key [key ...] --to-repo WORKTREE --url URL --password-stdin
`;
  (code === 0 ? process.stdout : process.stderr).write(text);
  process.exit(code);
}

const REPEATABLE = new Set(["set", "key", "tuning"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "password-stdin" || name === "help") {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (REPEATABLE.has(name)) flags[name] = [...(flags[name] ?? []), value];
    else flags[name] = value;
    index += 1;
  }
  return { positional, flags };
}

/** `key=text` pairs into an override set; the text may contain `=`. */
function pairsOf(values = []) {
  const out = {};
  for (const item of values) {
    const at = item.indexOf("=");
    if (at <= 0) throw new Error(`expected key=value, got ${item}`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

/** `repeatAfterReads=10` into a numeric tuning map. */
function tuningOf(values = []) {
  const out = {};
  for (const item of values) {
    const at = item.indexOf("=");
    if (at <= 0) throw new Error(`expected name=number, got ${item}`);
    out[item.slice(0, at)] = Number.parseInt(item.slice(at + 1), 10);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function serverModules() {
  // The catalog the server validates against; importing it needs only defaults.
  process.env.VAULT_PATH ??= path.join(process.cwd(), "vault");
  process.env.DATA_PATH ??= path.join(process.cwd(), ".promptctl-data");
  const [{ loadBundledBase }, { TOOL_NAMES }, { COMPACT_GROUPS }, { MCP_PROMPT_NAMES }] = await Promise.all([
    import("../src/prompt-registry/base-pack.js"),
    import("../src/config.js"),
    import("../src/compact-tools.js"),
    import("../src/prompts.js"),
  ]);
  return {
    load: (root) =>
      loadBundledBase({
        rootDir: root,
        toolNames: [...TOOL_NAMES],
        compactDomains: Object.keys(COMPACT_GROUPS),
        promptNames: [...MCP_PROMPT_NAMES],
      }),
  };
}

/** The pack as the API receives it: manifest plus one text per declared file. */
async function readPack(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const files = {};
  const walk = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.name.endsWith(".md")) files[relative] = await readFile(path.join(directory, entry.name), "utf8");
    }
  };
  await walk(root);
  return { manifest, files };
}

class Session {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookie = "";
    this.csrf = "";
  }

  async login(password) {
    const response = await fetch(`${this.baseUrl}/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password }),
      redirect: "manual",
    });
    if (response.status !== 303) throw new Error(`login failed with HTTP ${response.status}`);
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")];
    this.cookie = cookies.filter(Boolean).map((item) => item.split(";")[0]).join("; ");
    if (this.cookie === "") throw new Error("login returned no session cookie");
    const session = await this.get("/admin/auth/prompt-registry/session");
    this.csrf = session.csrf;
  }

  async get(route) {
    const response = await fetch(`${this.baseUrl}${route}`, { headers: { cookie: this.cookie }, redirect: "manual" });
    if (response.status === 303) throw new Error("the Admin session expired; run the command again to log in");
    if (!response.ok) throw new Error(`GET ${route} failed with HTTP ${response.status}`);
    return response.json();
  }

  async post(route, body) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({ csrf: this.csrf, ...body }),
      redirect: "manual",
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`POST ${route} returned HTTP ${response.status} without JSON`);
    }
    if (!response.ok) {
      const error = new Error(`POST ${route} failed with HTTP ${response.status}: ${parsed.error ?? "unknown"}`);
      error.body = parsed;
      throw error;
    }
    return parsed;
  }
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help === true || positional.length === 0) usage(positional.length === 0 ? 2 : 0);
  const [command, ...rest] = positional;

  if (command === "base" && rest[0] === "validate") {
    const modules = await serverModules();
    const pack = modules.load(flags.root ?? DEFAULT_ROOT);
    process.stdout.write(`${JSON.stringify({ ok: true, digest: pack.digest, keys: Object.keys(pack.values).length })}\n`);
    return 0;
  }

  const url = flags.url;
  if (url === undefined) throw new Error("--url is required");
  if (flags["password-stdin"] !== true) throw new Error("--password-stdin is required; a password in argv is refused");
  const password = await readStdin();
  if (password === "") throw new Error("stdin is empty; a password is required");
  const session = new Session(url);
  await session.login(password);

  if (command === "override" && rest[0] === "show") {
    const state = await session.get("/admin/auth/prompt-registry/state");
    process.stdout.write(`${JSON.stringify({ revision: state.revision, overrides: state.overrides, tuning: state.tuning, shadowedKeys: state.shadowedKeys }, null, 2)}\n`);
    return 0;
  }

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await session.get("/admin/auth/prompt-registry/state"), null, 2)}\n`);
    return 0;
  }

  if (command === "base" && rest[0] === "diff") {
    const preview = await session.post("/admin/auth/prompt-registry/base/preview", { pack: await readPack(flags.root ?? DEFAULT_ROOT) });
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return preview.valid === true ? 0 : 1;
  }

  const reason = flags.reason;
  const revision = Number.parseInt(flags.revision ?? "", 10);
  if (!Number.isInteger(revision)) throw new Error("--revision is required");

  if (command === "base" && rest[0] === "publish") {
    if (typeof reason !== "string") throw new Error("--reason is required");
    const resetKeys = (flags["reset-overrides"] ?? "").split(",").map((key) => key.trim()).filter(Boolean);
    let expectedOverrideValues = {};
    if (resetKeys.length > 0) {
      // The reset must assert the values it removes; a concurrent admin wins instead
      // of having their edit deleted by this publish.
      const state = await session.get("/admin/auth/prompt-registry/state");
      for (const key of resetKeys) {
        if (!Object.hasOwn(state.overrides ?? {}, key)) throw new Error(`no override to reset: ${key}`);
        expectedOverrideValues[key] = state.overrides[key];
      }
    }
    const result = await session.post("/admin/auth/prompt-registry/base/publish", {
      expectedRevision: revision,
      reason,
      pack: await readPack(flags.root ?? DEFAULT_ROOT),
      ...(resetKeys.length > 0 ? { resetOverriddenKeys: resetKeys, expectedOverrideValues } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "base" && rest[0] === "adopt-bundled") {
    if (typeof reason !== "string") throw new Error("--reason is required");
    const result = await session.post("/admin/auth/prompt-registry/base/adopt-bundled", { expectedRevision: revision, reason });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "override" && rest[0] === "publish") {
    if (typeof reason !== "string") throw new Error("--reason is required");
    const result = await session.post("/admin/auth/prompt-registry/override/publish", {
      expectedRevision: revision,
      reason,
      set: pairsOf(flags.set),
      tuning: tuningOf(flags.tuning),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "override" && rest[0] === "reset") {
    if (typeof reason !== "string") throw new Error("--reason is required");
    const keys = flags.key ?? [];
    if (keys.length === 0) throw new Error("--key is required at least once");
    const result = await session.post("/admin/auth/prompt-registry/override/reset", { expectedRevision: revision, reason, keys });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "override" && rest[0] === "promote") {
    const keys = rest.slice(1);
    if (keys.length === 0) throw new Error("promote needs at least one key");
    if (flags["to-repo"] === undefined) throw new Error("--to-repo is required");
    const state = await session.get("/admin/auth/prompt-registry/state");
    const { promoteOverridesToWorktree } = await import("../src/prompt-registry/promote.js");
    const { bundledBasePack } = await import("../src/prompt-registry/bundled.js");
    const result = await promoteOverridesToWorktree({
      worktreeDir: flags["to-repo"],
      overrides: state.overrides ?? {},
      keys,
      sourceBasePack: bundledBasePack(),
    });
    process.stdout.write(`${JSON.stringify({
      changedFiles: result.changedFiles,
      expectedRevision: state.revision,
      expectedEffectiveValues: result.expectedEffectiveValues,
    }, null, 2)}\n`);
    process.stdout.write(result.diff);
    process.stderr.write("\nReview the diff and commit it yourself. Then publish with:\n");
    process.stderr.write(`  promptctl base publish --url ${url} --revision <current> --reason "promote overrides" --reset-overrides ${keys.join(",")} --password-stdin\n`);
    return 0;
  }

  if (command === "rollback") {
    if (typeof reason !== "string") throw new Error("--reason is required");
    const target = Number.parseInt(rest[0] ?? "", 10);
    if (!Number.isInteger(target)) throw new Error("rollback needs a target revision");
    const result = await session.post("/admin/auth/prompt-registry/rollback", {
      expectedRevision: revision,
      targetRevision: target,
      reason,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  usage(2);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    // Only the message: it never carries the password or the cookie.
    process.stderr.write(`promptctl: ${error.message}\n`);
    if (error.body !== undefined) process.stderr.write(`${JSON.stringify(error.body)}\n`);
    process.exit(1);
  });
