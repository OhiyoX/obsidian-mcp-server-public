// GitHub-backed Vault — the read-only fact card on 「Vault 与 Git」 (design C,
// `scratch/sdd-747/design-github-vault.md`).
//
// The card answers one question — is this Vault's remote host GitHub? — and restates the runtime
// facts the Git admin already reports. Three things are asserted here and nothing else:
//   1. the four service classes plus "nothing to read" render as their own text;
//   2. the page never holds a remote URL: the classification happens in the service
//      (`remoteKindFromUrl`), the model carries `git.remoteKind`, and a model that still carries a
//      credential-bearing URL must not leak it;
//   3. the old placeholder (`Architecture TODO` + its disabled CTA) is gone.
import assert from "node:assert/strict";
import test from "node:test";

import { renderVaultsPage } from "../src/admin/pages/vaults.js";
import { createVaultGitAdmin, remoteKindFromUrl } from "../src/admin/vault-git-routes.js";

const BASE = "/admin/auth/vault-git";
const ACTIONS = Object.freeze({ base: BASE, save: `${BASE}/save`, refresh: `${BASE}/refresh`, verify: `${BASE}/verify` });

/** One Vault with the drawer/list facts the card reads; `remoteKind` is the only variable. */
function vault(remoteKind) {
  return {
    id: "vault",
    name: "主库",
    primary: true,
    writable: true,
    root: "/data/vaults/vault",
    editable: true,
    capabilities: [{ key: "notes", available: true, reason: null }],
    git: {
      state: "ready",
      repository: "ready",
      configSource: "persisted",
      configError: null,
      config: {
        enabled: true, autoCommit: true, autoPush: true, autoCommitSweep: true,
        debounceSeconds: 30, maxDelaySeconds: 300, sweepIntervalSeconds: 900,
        remote: "origin", branch: "main", updatedAt: "2026-10-13T10:00:00.000Z",
      },
      remoteKind,
      pending: { count: 0, paths: [], authors: [], since: null },
      dirty: false,
      timers: { commit: false, maxDelay: false, sweep: true },
      lastSweep: null,
      // A non-zero failure count is what makes 「推送失败」 reachable; the card restates it.
      push: { lastOutcome: { at: "2026-10-17T08:00:05.000Z", pushed: false, failureClass: "auth", remote: "origin", branch: "main", exitCode: 128, summary: "denied" }, consecutiveFailures: 1 },
    },
  };
}

function render(remoteKind, extraGit = {}) {
  const only = vault(remoteKind);
  only.git = { ...only.git, ...extraGit };
  const model = {
    vaults: [only],
    revision: 3,
    status: "ready",
    broken: null,
    defaultVaultId: "vault",
    notice: null,
    admission: { initialized: true },
  };
  return renderVaultsPage({ vaultGit: { wired: true, model, error: null }, csrf: "csrf", actions: ACTIONS, query: {} }).content;
}

test("remote host class: github.com, *.github.com and the FQDN trailing dot are GitHub", () => {
  assert.equal(remoteKindFromUrl("https://github.com/x/y.git"), "github");
  assert.equal(remoteKindFromUrl("https://gist.github.com/x/y.git"), "github");
  assert.equal(remoteKindFromUrl("git@github.com:x/y.git"), "github");
  assert.equal(remoteKindFromUrl("https://github.com./x/y.git"), "github", "a trailing dot is still github.com");
  assert.equal(remoteKindFromUrl("git@gitlab.com:x/y.git"), "other");
  assert.equal(remoteKindFromUrl("https://example.com/github.com/x/y.git"), "other");
  assert.equal(remoteKindFromUrl("/data/vaults/vault"), "other");
  assert.equal(remoteKindFromUrl(""), "none");
  assert.equal(remoteKindFromUrl(null), null);
  assert.equal(remoteKindFromUrl(undefined), null);
});

test("the card renders the GitHub state of the configured remote", () => {
  const html = render("github");
  assert.match(html, /GitHub<\/span>/, "the GitHub class is the card's own reading");
  assert.equal(html.includes("非 GitHub"), false);
  assert.equal(html.includes("无 remote"), false);
});

test("the card renders a non-GitHub remote as 非 GitHub", () => {
  const html = render("other");
  assert.equal(html.includes("非 GitHub"), true);
  assert.equal(html.includes(">GitHub<"), false);
});

test("the card renders a repository with no remote URL as 无 remote", () => {
  const html = render("none");
  assert.equal(html.includes("无 remote"), true);
  assert.equal(html.includes(">GitHub<"), false);
});

test("a Vault with Git disabled says 启用, not 未提供: the switch is a fact, not a gap", () => {
  const html = render("disabled");
  assert.equal(html.includes("Git 未启用"), true);
  assert.equal(html.includes("未提供"), false);
  assert.equal(html.includes(">GitHub<"), false);
});

test("a Vault with nothing to read says 未提供 instead of guessing a remote", () => {
  for (const kind of [null, undefined, "something-else"]) {
    const html = render(kind);
    assert.equal(html.includes("未提供"), true, `kind ${String(kind)} renders 未提供`);
    assert.equal(html.includes(">GitHub<"), false);
    assert.equal(html.includes("无 remote"), false);
  }
});

test("no remote URL can reach the HTML, even if a model still carries one", () => {
  const html = render("github", { remoteUrl: "https://user:token@github.com/x/y.git" });
  assert.equal(html.includes("token"), false, "no credential fragment in the page");
  assert.equal(html.includes("user:"), false, "no userinfo fragment in the page");
  assert.equal(html.includes("x/y.git"), false, "no remote URL path in the page");
  assert.match(html, /GitHub<\/span>/, "only the class is rendered");
});

test("the placeholder is gone: no Architecture TODO, no disabled add button", () => {
  const html = render("github");
  assert.equal(html.includes("Architecture TODO"), false);
  assert.equal(html.includes("添加…"), false);
  assert.equal(html.includes("futonly"), false, "the card is a real section, not a planned box");
});

// ------------------------------------------------------- the data source --
//
// The card's `remoteKind` comes from ONE local read per Vault — `git config --get
// remote.<remote>.url` through the Vault's own runtime, so it is bound to the same `-C <root>` the
// runtime uses for every other command. These cases pin the contract the page depends on.
function buildAdmin({ runGit, refusesGit = () => false, enabled = true, warnings = [] }) {
  const descriptor = { id: "vault", name: "主库", primary: true, writable: true, root: "/data/vaults/vault", capabilities: {} };
  const admin = createVaultGitAdmin({
    registry: {
      primaryId: "vault",
      list: () => [descriptor],
      get: () => descriptor,
      snapshot: () => ({ status: "ready", revision: 1, vaults: [descriptor], maxVaults: 5 }),
      refresh: async () => ({ revision: 1 }),
      refusesGit,
    },
    store: { snapshot: () => ({ status: "ready", revision: 1, vaults: {} }), upsertVault: async () => ({ ok: true, revision: 2 }) },
    runtimeFor: () => ({ runGit }),
    envDefaults: () => ({ enabled, autoCommit: false, autoPush: false, autoCommitSweep: false, debounceSeconds: 30, maxDelaySeconds: 300, sweepIntervalSeconds: 900, remote: "origin", branch: "main" }),
    logger: { warn: (message) => warnings.push(String(message)) },
  });
  return admin;
}

test("model: the kind is read once per Vault, and the URL itself never enters the model", async () => {
  const calls = [];
  const admin = buildAdmin({ runGit: async (args) => { calls.push(args); return { stdout: "https://github.com/x/y.git\n", stderr: "", exitCode: 0 }; } });
  const model = await admin.model();
  assert.deepEqual(calls, [["config", "--get", "remote.origin.url"]], "the read is `git config --get remote.origin.url`");
  assert.equal(model.vaults[0].git.remoteKind, "github", "only the class reaches the model");
  assert.deepEqual(Object.keys(model.vaults[0].git).filter((key) => /url/i.test(key)), [], "the model carries no URL field");
});

test("model: git exit 1 is 无 remote, a broken read is unknown, and no error text is logged", async () => {
  const warnings = [];
  const none = await buildAdmin({ runGit: async () => ({ stdout: "", stderr: "", exitCode: 1 }), warnings }).model();
  assert.equal(none.vaults[0].git.remoteKind, "none", "an absent remote URL is \"none\"");

  const broken = await buildAdmin({
    runGit: async () => { throw new Error("bad config value https://user:token@github.com/x/y.git"); },
    warnings,
  }).model();
  assert.equal(broken.vaults[0].git.remoteKind, null, "an unreadable remote is unknown, never a guess");
  assert.deepEqual(warnings, ["vault-git: the remote URL of vault could not be read"], "the warning names the Vault only");
  assert.equal(JSON.stringify(warnings).includes("token"), false, "no credential can reach the log");
});

test("model: Git disabled or Git refused never runs a command and never warns", async () => {
  const warnings = [];
  const calls = [];
  const runGit = async (args) => { calls.push(args); return { stdout: "https://github.com/x/y.git", stderr: "", exitCode: 0 }; };

  const disabled = await buildAdmin({ runGit, enabled: false, warnings }).model();
  assert.equal(disabled.vaults[0].git.remoteKind, "disabled", "the enablement switch is the card's own reading");

  const refused = await buildAdmin({ runGit, refusesGit: () => true, warnings }).model();
  assert.equal(refused.vaults[0].git.remoteKind, null, "a refused Vault has no remote fact, like it has no status");
  assert.equal(refused.vaults[0].git.state, null, "the refusal also removes the runtime status (one rule, not two)");

  assert.deepEqual(calls, [], "no `git config` call for a disabled or refused Vault");
  assert.deepEqual(warnings, [], "no warning per page render");
});

test("an absent git branch renders as a placeholder, never as markup inside the input (bug, 2026-11-21)", () => {
  // The drawer's text fields put `maybeText()` into a value="…" attribute. That helper answers HTML
  // (`<span class="muted">—</span>` for a missing value), so a Vault without `branch` rendered the
  // literal fragment as the field's content — the screenshot that reported this showed
  // `<span class="` and a stray `">` under the label 分支. An attribute carries text, never markup.
  const withoutBranch = (config) => {
    const only = vault("github");
    only.git = { ...only.git, config: { ...only.git.config, ...config } };
    const model = { vaults: [only], revision: 3, status: "ready", broken: null, defaultVaultId: "vault", notice: null, admission: { initialized: true } };
    // The drawer is a separate return value (`detailPanel`), opened by `?id=`.
    return renderVaultsPage({ vaultGit: { wired: true, model, error: null }, csrf: "csrf", actions: ACTIONS, query: { id: "vault" } }).detailPanel;
  };
  const field = (html, name) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? "";

  const attribute = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

  const missing = withoutBranch({ remote: "origin", branch: null });
  const branch = field(missing, "branch");
  assert.ok(branch, "the branch field is rendered");
  assert.equal(attribute(branch, "value"), "", "a missing branch carries an empty value, not markup");
  assert.ok(attribute(branch, "placeholder"), "and says so with a placeholder instead");
  assert.doesNotMatch(attribute(branch, "placeholder"), /[<>]/, "the placeholder is text, not markup");
  const remote = field(missing, "remote");
  assert.equal(attribute(remote, "value"), "origin");

  // A real value is escaped, including the characters that would break out of the attribute. The
  // broken build rendered `value="<span class="`, which ended the attribute early.
  const hostileTag = field(withoutBranch({ remote: 'ori"gin<x>', branch: 'a"b<c>' }), "branch");
  const hostile = attribute(hostileTag, "value") ?? "";
  assert.doesNotMatch(hostile, /[<>]/, `angle brackets must be escaped inside the value: ${hostileTag}`);
  assert.doesNotMatch(hostile, /"/, "a raw quote would end the attribute early");
  assert.match(hostile, /a/, "the value itself survives escaping");
});
