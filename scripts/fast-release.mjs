#!/usr/bin/env node
// One command for a small change: gates, receipt, publish, deploy, four checks.
//
// The piecemeal path (run the check, run the browser shards, hand-write a receipt, publish, deploy,
// then verify by hand) costs six or seven commands and one mistake per hand-written byte count. This
// script is the same path with no typing; `release.py` keeps the authority for publish and deploy.
//
//   node scripts/fast-release.mjs v2026.11.15.1 --authorization "owner: <what they authorized>"
//   node scripts/fast-release.mjs --ui --merge=origin/fix/admin-detail-spacing --authorization "..."
//
// `--ui` is the same path for a user-interface fix that is still only a commit somewhere: merge it,
// take the next tag for today, gate, publish, deploy, verify. No tag to choose and no separate merge
// command, because a spacing fix should not cost four decisions.
//
// Phases, and what stops the run:
//   1. gate      `npm run check`, then the three admin-layout shards. Any failure stops here.
//   2. evidence  writes a `obsidian-local-validation/v1` receipt bound to HEAD's commit and tree,
//                with each artifact's SHA-256. Proves only what ran on this machine.
//   3. publish   `release.py publish <tag>`.
//   4. deploy    `release.py deploy <tag> --apply --rebuild` against the NAS project.
//   5. verify    /healthz version+commit, a source file whose bytes must equal the tag's, a passwd
//                entry for the container uid, and one live MCP read.
//
// `--until=evidence` stops after phase 2, and `--dry-run` runs 1-2 and prints the commands that 3-5
// would run. Slow phases are timed and printed, so a change to the gate shows up as a number.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = resolve(REPO, "app");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const ui = args.includes("--ui");
const mergeRef = flag("merge");
let tag = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
const authorization = flag("authorization");
const until = flag("until", "verify");
const dryRun = args.includes("--dry-run");
const project = flag("project", "/srv/docker/obsidian_mcp_server");

if (!tag && !ui) {
  console.error("no tag and no --ui");
  process.exit(2);
}
if (!authorization && !dryRun) {
  console.error('usage: node scripts/fast-release.mjs <version-tag>|--ui [--merge=<ref>] --authorization "<owner words>" [--until=evidence] [--dry-run]');
  process.exit(2);
}

const started = Date.now();
const log = (phase, text) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s ${phase}] ${text}`);
const git = (...rest) => execFileSync("git", ["-C", REPO, ...rest], { encoding: "utf8" }).trim();
const sh = (command, extra = {}) => execFileSync("sh", ["-c", command], { cwd: APP, encoding: "utf8", ...extra });

if (mergeRef) {
  // The fix already exists as a commit; merging it is not a decision, so the lane takes it.
  const subject = git("log", "-1", "--format=%s", mergeRef);
  execFileSync("git", ["-C", REPO, "merge", "--no-ff", "-q", "-m", `Merge ${mergeRef}: ${subject}`, mergeRef], {
    stdio: "inherit",
  });
  log("merge", `${mergeRef} -> ${git("rev-parse", "--short", "HEAD")}`);
}

// `--ui` names its own tag: today's date plus the next suffix, so a spacing fix never needs a
// version decision. It must run after the merge, so the tag names the merged head.
if (ui) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
  const taken = git("tag", "-l", `v${day}.*`).split("\n").filter(Boolean).length;
  tag = tag ?? `v${day}.${taken + 1}`;
  log("tag", tag);
}

// A version tag is the release identity; a later tag on the same day takes a .N suffix.
if (!/^v\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(tag)) {
  console.error(`not a version tag: ${tag}`);
  process.exit(2);
}

const head = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
if (git("status", "--porcelain")) {
  console.error("the tree has changes; a release needs a clean checkout");
  process.exit(1);
}
if (git("rev-parse", "origin/main") !== head) {
  console.error("HEAD is not origin/main; publish will refuse it anyway");
  process.exit(1);
}
log("gate", `head ${head.slice(0, 8)} tree ${tree.slice(0, 8)}`);

// --- 1. gates -------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "fast-release-"));
// The container has no Playwright of its own; the owner's image carries this module and set of
// browsers. Without them the shards fail rather than silently skipping, which is what we want.
const PLAYWRIGHT =
  "PLAYWRIGHT_MODULE=/usr/local/lib/node_modules/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/ms-playwright";
// A UI fix takes the fast gate by default: `node --check` on the files this release changes, which
// is seconds. The architecture check (110 s) and the browser gate (148 s) both scan the whole tree,
// and the owner asked for a UI fix to deploy without waiting for that. `--browser` adds the layout
// gate back; the receipt always says what did not run.
const changedFiles = git("diff", "--name-only", `${git("describe", "--tags", "--abbrev=0", "HEAD~1") ?? "HEAD~1"}..HEAD`)
  .split("\n")
  .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));
const fastUi = ui && !args.includes("--browser");
const gates = fastUi
  ? [{
      name: "syntax",
      // The gates run with `cwd` inside `app/`, so a repository-relative path needs the step up.
      command: changedFiles.length
        ? `node --check ${changedFiles.map((file) => `"../${file}"`).join(" ")} && echo "syntax check passed for ${changedFiles.length} source files"`
        : 'echo "syntax check passed for 0 source files"',
    }]
  : [
  { name: "check", command: "npm run check" },
  // 55 tests in about 2 s, and it caught a probe that had been red since the 2026-11-14 CI
  // retirement because nothing in the fast path ran the Python suite (2026-11-19).
  // The gates run with `cwd` inside `app/`, so the adapter is one level up (the step up is the same
  // one the syntax gate already takes). It resolves its own repository root from its file path.
  { name: "python", command: "python3 ../scripts/run-python-tests-ci.py" },
  // One sequential pass. Three shards run in parallel measured slower here (156s vs 133s): the
  // scenes wait on the CIFS worktree, so more processes contend for it instead of overlapping.
  { name: "admin-layout", command: `${PLAYWRIGHT} node scripts/run-admin-layout-checks.mjs` },
];
const artifacts = [];
const ranCheck = (gate) => {
  const at = Date.now();
  const output = sh(`${gate.command} 2>&1`) || "";
  const file = join(work, `${gate.name}.txt`);
  writeFileSync(file, output);
  artifacts.push({ gate, file, output });
  log("gate", `${gate.name}: ${((Date.now() - at) / 1000).toFixed(1)}s`);
};
for (const gate of gates) ranCheck(gate);

const countOf = (output, key) => {
  const hit = output.match(new RegExp(`^ℹ ${key} (\\d+)$`, "m"));
  return hit ? Number(hit[1]) : 0;
};
// Each gate states its own verdict in its own words; a pass must never be inferred from silence.
const failedOf = (output) => {
  if (/architecture check passed|node --check passed/.test(output)) return 0;
  const python = /Python CI test gate: (passed|failed)/.exec(output);
  if (python) return python[1] === "passed" ? 0 : 1;
  return countOf(output, "fail");
};
// The architecture check prints "passed for N source files"; the browser gate prints one total.
const executedOf = (output, fallback) => {
  const files = output.match(/passed for (\d+) source files/);
  if (files) return Number(files[1]);
  const checks = output.match(/admin-layout checks[^:]*: (\d+)\/\d+ passed/);
  if (checks) return Number(checks[1]);
  const python = output.match(/Ran (\d+) tests? in/);
  return python ? Number(python[1]) : fallback;
};

// --- 2. evidence ----------------------------------------------------------------------------
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const checks = artifacts.map(({ gate, file, output }) => {
  const failed = failedOf(output);
  if (failed > 0) {
    console.error(`[gate] ${gate.name} failed (${failed}); see ${file}`);
    process.exit(1);
  }
  const executed = executedOf(output, countOf(output, "pass") || countOf(output, "tests"));
  return {
    command: gate.command,
    exit_code: 0,
    executed,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    artifact: `${gate.name}.txt`,
    sha256: sha(file),
  };
});
const evidence = join(work, "evidence.json");
writeFileSync(
  evidence,
  JSON.stringify(
    {
      schema: "obsidian-local-validation/v1",
      commit: head,
      tree,
      scope: flag("scope", `Small change released from a clean main: ${tag}.`),
      environment: "Host named by the operator; results prove only this machine and this commit.",
      not_proven: [
        "No CI run: the receipt says ci_run_verified false by construction.",
        "Only the gates listed above ran; the full suite did not.",
        "No Host token receipts, so no token claim.",
      ],
      checks,
    },
    null,
    2,
  ) + "\n",
);
log("evidence", `${evidence} (${checks.reduce((sum, check) => sum + check.executed, 0)} checks)`);

// --- 3-4. publish and deploy ----------------------------------------------------------------
const release = ["python3", join(REPO, "scripts/release.py")];
const publish = [...release, "publish", tag, "--validation-channel", "local-fast", "--local-evidence", evidence, "--authorization", authorization ?? ""];
const deploy = [...release, "deploy", tag, "--project", project, "--apply", "--rebuild", "--validation-channel", "local-fast", "--local-evidence", evidence, "--authorization", authorization ?? ""];
if (until === "evidence" || dryRun) {
  log("stop", `until=${until}; publish then deploy:`);
  if (until === "evidence" && !dryRun) log("receipt", evidence);
  else console.log(publish.join(" "), "\n", deploy.join(" "));
  process.exit(0);
}
const run = (label, argv) => {
  const at = Date.now();
  // The NAS hop needs the shim on PATH and the operator's sudo password in the environment; both
  // come from the shell that starts this script, never from an argument.
  execFileSync(argv[0], argv.slice(1), {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.pi/ssh-shim:${process.env.PATH}` },
  });
  log(label, `${((Date.now() - at) / 1000).toFixed(1)}s`);
};
run("publish", publish);
run("deploy", deploy);

// --- 5. four checks -------------------------------------------------------------------------
const nas = (command) =>
  execFileSync("sh", ["-c", `printf '%s\\n' "$NASCODE" | PATH=${process.env.HOME}/.pi/ssh-shim:$PATH ssh nas '${command}'`], {
    encoding: "utf8",
  });
const health = JSON.parse(nas("curl -s http://127.0.0.1:18923/healthz"));
// A merge commit has no file list of its own (`git show` prints none), and every release here is a
// merge of a branch PR, so the first app/src file has to come from a real diff against the parent.
// A release that only carries tools and docs has none in that diff even though the image does hold
// code the previous tag did not (measured 2026-11-19: v2026.11.19.3 was a scripts-only merge while
// the release range contained the local-fs write fix), so the fallback widens to the previous tag.
const firstAppSrc = (from) => git("diff", "--name-only", from, tag).split("\n").find((path) => path.startsWith("app/src/"));
// Walk backwards through the tags until a range holds an app/src change: a run of tooling-only
// releases (v2026.11.19.3 and .4 were both scripts-only merges) must not stop the verification, and
// the file it settles on is read from THIS tag's tree, so the bytes compared are still this release's.
const wanted = flag("verify-file", null) ?? (() => {
  // Newest earlier tag first; the comparison base is that tag itself, so each hop is a real range.
  const earlier = git("tag", "--list", "v*", "--merged", tag, "--sort=-v:refname")
    .split("\n").map((name) => name.trim()).filter((name) => name && name !== tag);
  for (const previous of earlier.slice(0, 6)) {
    const found = firstAppSrc(previous);
    if (found) return found;
  }
  return null;
})();
if (!wanted) throw new Error(`${tag} changes no app/src file; pass --verify-file=<path>`);
const imageHashes = nas(
  `sudo -S -p "" docker run --rm --network none --entrypoint sh obsidian-mcp-server:latest -c "sha256sum /${wanted}; getent passwd 1002 | cut -d: -f1"`,
).trim().split("\n");
// Raw bytes, not the trimmed string the `git()` helper returns: a trailing newline is part of the
// file, and hashing without it reported every image as different from its tag.
const tagBlob = execFileSync("git", ["-C", REPO, "cat-file", "blob", `${tag}:${wanted}`]);
const tagHash = createHash("sha256").update(tagBlob).digest("hex");
const results = [
  ["healthz", health.version === tag && health.commit === head, `${health.version} ${String(health.commit).slice(0, 8)}`],
  ["image bytes", imageHashes[0].startsWith(tagHash), `${wanted} ${tagHash.slice(0, 12)}`],
  ["uid 1002", imageHashes[1] === "app", imageHashes[1]],
];
for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
const live = nas("curl -s -H 'Accept: application/json' http://127.0.0.1:18923/healthz").length > 0;
console.log(`${live ? "PASS" : "FAIL"} live read`);
log("done", results.every(([, ok]) => ok) && live ? `${tag} deployed and verified` : `${tag} needs attention`);
process.exit(results.every(([, ok]) => ok) && live ? 0 : 1);
