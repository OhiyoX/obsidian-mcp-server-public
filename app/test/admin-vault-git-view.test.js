// Focused tests for the Wave E / E1 Admin "Vault 与 Git" tab renderer
// (`app/src/admin/vault-git-view.js`).
//
// Pure view tests: a plain view-model in, an HTML fragment string out. They pin the
// §17 display list item by item, the §16.2 five-state Git badge, the §15.4
// `configSource` tokens, the §3.4 `available:false + reason` capability rule, the
// §15.2 hard bounds on the numeric controls, and the §42 SEC-MV03/SEC-MV04
// guarantee that an unknown model field (an API key, an auth header, a
// connection string with embedded userinfo) has no render path at all.

import assert from "node:assert/strict";
import test from "node:test";

import { secondaryVault, vaultFixture } from "./helpers/vault-git-view-fixtures.js";
import {
  DEFAULT_ACTIONS,
  MAX_RENDERED_PENDING_PATHS,
  escapeHtml,
  gitStateToken,
  renderVaultGitTab,
} from "../src/admin/vault-git-view.js";

const CSRF = "csrf-1a2b3c";

const GIT_STATES = ["disabled", "ready", "repository-missing", "config-invalid", "push-failing"];

function view(overrides = {}) {
  return {
    vaults: [vaultFixture(), secondaryVault()],
    revision: 7,
    status: "ready",
    broken: null,
    defaultVaultId: "primary",
    notice: null,
    csrfToken: CSRF,
    actions: {},
    ...overrides,
  };
}

test("escapeHtml neutralizes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(0), "0");
});

test("gitStateToken returns the canonical token or an empty string", () => {
  for (const state of GIT_STATES) assert.equal(gitStateToken({ state }), state);
  assert.equal(gitStateToken({}), "");
  assert.equal(gitStateToken({ state: "  " }), "");
  assert.equal(gitStateToken(null), "");
});

test("the tab renders the §17 page label, the Admin-plane note and the refresh control", () => {
  const html = renderVaultGitTab(view());
  assert.ok(html.includes('<section class="card" id="vault-git">'));
  assert.ok(html.includes("Vault 与 Git"));
  assert.ok(html.includes("仅在本 Admin 平面可见"));
  assert.ok(html.includes("不创建 repo"));
  assert.ok(html.includes(`action="${DEFAULT_ACTIONS.refresh}"`));
  assert.ok(html.includes("刷新 Vault 清单"));
  assert.ok(html.includes(`name="csrf" value="${CSRF}"`));
  assert.ok(html.includes('value="7"'), "revision CAS token is rendered into the forms");
});

test("every §17 display item for a Vault is rendered", () => {
  const html = renderVaultGitTab(view());
  // id / name / primary-secondary
  assert.ok(html.includes('data-vault-role="primary"') && html.includes(">主库<"), "primary role Chinese");
  assert.ok(html.includes("主库 A"));
  assert.ok(html.includes('data-vault-role="primary"'));
  assert.ok(html.includes('data-vault-role="secondary"'));
  assert.ok(html.includes('data-vault-role="primary"') && html.includes(">主库<"), "primary role Chinese");
  assert.ok(html.includes('data-vault-role="secondary"') && html.includes(">附加<"), "secondary role Chinese");
  assert.ok(html.includes("可写"));
  assert.ok(html.includes("只读") === false, "both fixture Vaults are writable");
  const readOnlyRole = renderVaultGitTab(view({ vaults: [vaultFixture({ writable: false })] }));
  assert.ok(readOnlyRole.includes("只读"));
  // root is operator-only and still shown on the Admin plane
  assert.ok(html.includes("root（仅 Admin 平面）"));
  assert.ok(html.includes("/srv/vaults/main"));
  assert.ok(html.includes("/srv/vaults/example-vault"));
  assert.ok(html.includes("canonicalRoot"));
  // capability list (#402: Chinese state badge, raw reason behind <details>)
  assert.ok(html.includes('data-capability="notes"'));
  assert.ok(html.includes("笔记读写 · 可用"));
  // git status / config source
  assert.ok(html.includes('data-git-state="ready"'));
  assert.ok(html.includes('data-config-source="persisted"'));
  assert.ok(html.includes('data-config-source="default-disabled"'));
  // automation flags + sweep interval
  assert.ok(html.includes("autoCommit"));
  assert.ok(html.includes("autoPush"));
  assert.ok(html.includes("sweep"));
  assert.ok(html.includes("900"), "sweep interval value present");
  assert.ok(html.includes("开启"));
  assert.ok(html.includes("关闭"));
  // remote name / branch
  assert.ok(html.includes("<code class=\"keep\">origin</code>"));
  assert.ok(html.includes("<code class=\"keep\">main</code>"));
  // last sweep
  assert.ok(html.includes("最近 sweep"));
  assert.ok(html.includes("2026-10-06T01:30:00.000Z"));
  assert.ok(html.includes("abc1234"));
  // last push outcome + consecutiveFailures
  assert.ok(html.includes("最近 push"));
  assert.ok(html.includes('data-consecutive-failures="3"'));
  assert.ok(html.includes("连续失败 3"));
  assert.ok(html.includes("推送未成功"));
  assert.ok(html.includes("Authentication failed"));
  // dirty / pending count
  assert.ok(html.includes('data-pending-count="2"'));
  assert.ok(html.includes("待提交 2"));
  assert.ok(html.includes("有未提交改动"));
  assert.ok(html.includes("notes/a.md"));
  assert.ok(html.includes("作者 codex"));
});

test("each of the five §16.2 Git states renders its own distinct badge", () => {
  const seen = new Set();
  for (const state of GIT_STATES) {
    const html = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { state } })] }));
    assert.ok(html.includes(`data-git-state="${state}"`), `token ${state}`);
    assert.ok(html.includes(state), `token label ${state}`);
    const badge = new RegExp(`data-git-state="${state}"[^>]*>([^<]*)<`).exec(html)?.[1];
    assert.ok(badge, `badge text for ${state}`);
    seen.add(badge);
    assert.equal((html.match(/data-git-state=/g) ?? []).length, 2, "table cell + detail summary");
  }
  assert.equal(seen.size, GIT_STATES.length, "every state has a distinct label");
  // Only `ready` is a healthy tone; the rest are muted/bad.
  const ready = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { state: "ready" } })] }));
  assert.ok(/<span class="badge ok" data-git-state="ready"/.test(ready));
  const missing = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { state: "repository-missing" } })] }));
  assert.ok(/<span class="badge bad" data-git-state="repository-missing"/.test(missing));
  const failing = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { state: "push-failing" } })] }));
  assert.ok(/<span class="badge bad" data-git-state="push-failing"/.test(failing));
  const disabled = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { state: "disabled" } })] }));
  assert.ok(/<span class="badge muted" data-git-state="disabled"/.test(disabled));
  const invalid = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { state: "config-invalid" } })] }));
  assert.ok(/<span class="badge bad" data-git-state="config-invalid"/.test(invalid));
});

test("an unavailable capability shows available:false together with its reason", () => {
  const html = renderVaultGitTab(view({ vaults: [vaultFixture()] }));
  // #402: the badge is the bounded `<中文名> · 不可用`; the upstream English reason is not
  // dropped, it stays in the DOM inside the closed `<details class="cap-detail">`.
  assert.ok(html.includes('<span class="badge bad" data-capability="semantic" title="semantic · 不可用">'));
  assert.ok(html.includes(">语义检索 · 不可用</span>"), "the badge text is the Chinese state label");
  assert.ok(html.includes("<p class=\"cap-hint\">语义检索：本机未配置向量服务，未启用；检索仍按关键词工作</p>"), "the operator gets a Chinese one-liner");
  assert.ok(/<details class="cap-detail"><summary>技术细节：<code>semantic<\/code><\/summary><code>embedding 未接线<\/code><\/details>/.test(html), "the full reason stays in the DOM");
  // The reason never renders as badge content (that was the 907x52px badge).
  assert.equal(/<span class="badge[^>]*>[^<]*embedding 未接线/.test(html), false, "the reason is not badge text");

  // A missing reason must not be silently dropped.
  const noReason = renderVaultGitTab(view({
    vaults: [vaultFixture({ capabilities: [{ key: "publish", available: false }] })],
  }));
  assert.ok(noReason.includes(">发布 · 不可用</span>"));
  assert.ok(noReason.includes("<code>未说明原因</code>"));

  // An unmapped key falls back to `<key> · 不可用` with a neutral hint, never to prose.
  const unmapped = renderVaultGitTab(view({
    vaults: [vaultFixture({ capabilities: [{ key: "brandNew", available: false, reason: "a very long implementer note " + "x".repeat(400) }] })],
  }));
  assert.ok(unmapped.includes(">brandNew · 不可用</span>"));
  assert.ok(unmapped.includes("该能力尚未接线，当前不生效"));

  // A plain string entry means "available"; junk entries are skipped, not printed.
  const mixed = renderVaultGitTab(view({
    vaults: [vaultFixture({ capabilities: ["git", null, { available: true }, 42] })],
  }));
  assert.ok(mixed.includes('data-capability="git"'));
  assert.ok(mixed.includes("Git · 可用"));
  assert.equal(mixed.includes('data-capability=""'), false);
});

test("#400: pending authors render {agent, model} instead of [object Object]", () => {
  const render = (authors) => renderVaultGitTab(view({
    vaults: [vaultFixture({ git: { pending: { count: 2, paths: ["notes/a.md"], authors, since: null } } })],
  }));

  // The runtime shape: a structured `{agent, model}` fact, never stringified raw.
  const structured = render([{ agent: "codex", model: "gpt-5.6" }]);
  assert.ok(structured.includes("作者 codex / gpt-5.6"));
  assert.equal(structured.includes("[object Object]"), false);

  // One usable field alone still renders that field.
  assert.ok(render([{ agent: "codex" }]).includes("作者 codex"));
  assert.ok(render([{ model: "gpt-5.6" }]).includes("作者 gpt-5.6"));

  // An empty object, blank fields or a non-object element degrade to a placeholder.
  for (const authors of [[{}], [{ agent: "", model: "" }], [{ agent: "  ", model: null }], [null]]) {
    const html = render(authors);
    assert.ok(html.includes("作者 未知"), JSON.stringify(authors));
    assert.equal(html.includes("[object Object]"), false, JSON.stringify(authors));
  }

  // Backward compatible with the pre-#400 string shape, including mixed arrays.
  assert.ok(render(["codex"]).includes("作者 codex"));
  assert.ok(render(["codex", { agent: "claude", model: "opus-5" }]).includes("作者 codex / claude / opus-5"));
  assert.ok(render([{ agent: "a", model: "m" }, "codex"]).includes("作者 a / m / codex"));

  // No authors at all renders no author segment.
  assert.equal(render([]).includes("作者"), false);

  // Both render sites used to share this renderer; #401 moved the pending column out of
  // the summary table, so the detail card is now the single render site.
  const rendered = render([{ agent: "codex", model: "gpt-5.6" }]);
  const pendingCells = (rendered.match(/作者 codex \/ gpt-5\.6/g) ?? []).length;
  assert.equal(pendingCells, 1, "detail card");
  const summaryRow = /<table class="data-table"><thead><tr>([\s\S]*?)<\/tbody>/.exec(rendered)?.[1] ?? "";
  assert.equal(summaryRow.includes("作者"), false, "the summary row no longer carries the pending detail");
});

test("the three config sources are distinguished", () => {
  const html = renderVaultGitTab(view());
  assert.ok(html.includes("env-default（继承 GIT_* 环境默认）") === false, "not present in this fixture");
  assert.ok(html.includes("persisted（Admin 已保存）"));
  assert.ok(html.includes("default-disabled（默认关闭）"));
  const envDefault = renderVaultGitTab(view({ vaults: [vaultFixture({ git: { configSource: "env-default" } })] }));
  assert.ok(envDefault.includes('data-config-source="env-default"'));
  assert.ok(envDefault.includes("env-default（继承 GIT_* 环境默认）"));
});

test("the config form renders controls with values, bounds and a disabled state only", () => {
  const html = renderVaultGitTab(view({ vaults: [vaultFixture()] }));
  const multi = renderVaultGitTab(view());
  for (const field of ["enabled", "autoCommit", "autoPush", "autoCommitSweep", "debounceSeconds", "maxDelaySeconds", "sweepIntervalSeconds", "remote", "branch"]) {
    assert.ok(html.includes(`name="${field}"`), `field ${field}`);
  }
  assert.ok(html.includes(`action="${DEFAULT_ACTIONS.save}"`));
  assert.ok(html.includes(`action="${DEFAULT_ACTIONS.verify}"`));
  assert.ok(multi.includes('name="vaultId" value="primary"'));
  assert.ok(multi.includes('name="vaultId" value="example-vault"'));
  assert.ok(html.includes("class=\"sw\"") && html.includes("class=\"switch\""));
  assert.ok(html.includes("type=\"checkbox\"") && html.includes('value="true"'));
  assert.ok(html.includes("type=\"hidden\"") && html.includes('value="false"'));
  assert.ok(html.includes('name="debounceSeconds" value="180"'));
  assert.ok(html.includes('name="maxDelaySeconds" value="900"'));
  assert.ok(html.includes('name="sweepIntervalSeconds" value="900"'));
  assert.ok(html.includes('name="remote" value="origin"'));
  assert.ok(html.includes('name="branch" value="main"'));
  // §15.2 hard bounds are re-applied on the controls.
  assert.ok(html.includes('min="5" max="86400" name="debounceSeconds"'));
  assert.ok(html.includes('min="1" max="86400" name="maxDelaySeconds"'));
  assert.ok(html.includes('min="30" max="604800" name="sweepIntervalSeconds"'));
  assert.ok(html.includes('maxlength="128" name="remote"'));
  assert.ok(html.includes('maxlength="240" name="branch"'));
  // Rendering only: no inline handler, no submit logic, no external asset.
  for (const forbidden of ["onclick=", "onsubmit=", "onchange=", "<script", "fetch(", "XMLHttpRequest"]) {
    assert.equal(html.includes(forbidden), false, `no ${forbidden}`);
  }
  // A non-editable Vault renders the same controls disabled.
  const readOnly = renderVaultGitTab(view({ vaults: [vaultFixture({ editable: false })] }));
  assert.ok(readOnly.includes("disabled"));
  assert.ok(readOnly.includes('<button class="btn" type="submit" disabled>'));
});

test("an empty action URL drops its form instead of rendering a dead control", () => {
  const html = renderVaultGitTab(view({ actions: { save: "", refresh: "", verify: null } }));
  assert.equal(html.includes("<form"), false, "no dead form");
  assert.ok(html.includes("Vault 与 Git"), "the read-only view still renders");
});

test("action URLs are overridable for the Wave E / E2 wiring", () => {
  const html = renderVaultGitTab(view({ actions: { save: "/custom/save", refresh: "/custom/refresh", verify: "/custom/verify" } }));
  assert.ok(html.includes('action="/custom/save"'));
  assert.ok(html.includes('action="/custom/refresh"'));
  assert.ok(html.includes('action="/custom/verify"'));
  assert.equal(html.includes(`action="${DEFAULT_ACTIONS.save}"`), false);
});

test("a broken config store renders the failure code and only exposes repair when wired", () => {
  const html = renderVaultGitTab(view({ status: "broken", broken: { errorCode: "git_config_invalid_document" } }));
  assert.ok(html.includes("Git 配置存储不可用"));
  assert.ok(html.includes("git_config_invalid_document"));
  assert.ok(html.includes("fail closed"));
  assert.equal(html.includes('action="/admin/vaults/git/repair"'), false, "no invented repair route");

  const withRepair = renderVaultGitTab(view({
    status: "broken",
    broken: { code: "git_config_invalid_document" },
    actions: { repair: "/custom/repair" },
  }));
  assert.ok(withRepair.includes('action="/custom/repair"'));
});

test("dynamic values are escaped (no executable markup from the model)", () => {
  const evil = "<script>alert(1)</script>";
  const html = renderVaultGitTab(view({
    notice: { kind: "error", message: `<b>${evil}</b>` },
    vaults: [vaultFixture({
      id: "x",
      name: evil,
      root: evil,
      capabilities: [{ key: evil, available: false, reason: evil }],
      git: {
        state: evil,
        config: { remote: evil, branch: evil },
        pending: { count: 1, paths: [evil] },
        push: { lastOutcome: { pushed: false, summary: evil }, consecutiveFailures: 1 },
      },
    })],
  }));
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("</script>"), false);
  assert.equal(html.includes("<b>"), false);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("未知状态（&lt;script&gt;alert(1)&lt;/script&gt;）"));
  assert.ok(html.includes("&lt;b&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/b&gt;"));
});

test("an unknown field has no render path (whitelist negative control)", () => {
  const injected = {
    token: "ghp_0000000000000000000000000000000000",
    password: "hunter2",
    authorization: "Bearer abcdef",
    credentialUrl: "https://svc:hunter2@git.example.com/repo.git",
    clientSecret: "s3cr3t",
  };
  const html = renderVaultGitTab(view({
    ...injected,
    vaults: [
      { ...vaultFixture(), ...injected },
      { ...secondaryVault(), ...injected },
    ],
  }));
  for (const forbidden of [
    "ghp_0000000000000000000000000000000000",
    "hunter2",
    "Bearer abcdef",
    "s3cr3t",
    "git.example.com",
    "token",
    "password",
    "authorization",
    "credential",
    "clientSecret",
  ]) {
    assert.equal(html.includes(forbidden), false, `leaked ${forbidden}`);
  }
  // The one intentional secret-shaped field is the caller-supplied CSRF value.
  assert.ok(html.includes(`name="csrf" value="${CSRF}"`));
});

test("a credential-bearing remote/branch/summary is masked, never printed", () => {
  const html = renderVaultGitTab(view({
    vaults: [vaultFixture({
      root: "https://svc:hunter2@git.example.com/vault.git",
      capabilities: [{ key: "git", available: false, reason: "push failed: token=ghp_0000000000000000000000000000000000" }],
      git: {
        config: { remote: "https://svc:hunter2@git.example.com/repo.git", branch: "main" },
        push: {
          lastOutcome: { pushed: false, remote: "svc:hunter2@git.example.com:22", summary: "fatal: could not read password for 'https://user:pw@host'" },
          consecutiveFailures: 2,
        },
      },
    })],
  }));
  assert.equal(html.includes("hunter2"), false);
  assert.equal(html.includes("user:pw@"), false);
  assert.ok(html.includes("***@"), "userinfo is masked, not dropped");

  // A rendered diagnostic also cannot smuggle the credential *concept* through:
  // git's own stderr says "could not read password for", a reason can say "token=".
  for (const keyword of ["password", "token", "secret", "authorization", "ghp_"]) {
    assert.equal(html.includes(keyword), false, `masked keyword ${keyword}`);
  }
  assert.ok(html.includes("could not read"), "the actionable part of the diagnostic survives");
  assert.ok(html.includes("push failed:"));
});

test("an unknown or missing Git state is rendered escaped, not crashed on", () => {
  const blank = renderVaultGitTab({});
  assert.ok(blank.includes("还没有 Vault"));
  assert.equal(blank.includes("undefined"), false);
  assert.equal(blank.includes("NaN"), false);

  const partial = renderVaultGitTab({ vaults: [{ id: "x" }], revision: 0 });
  assert.ok(partial.includes("未知状态"));
  assert.ok(partial.includes('data-vault-role="secondary"'));
  assert.ok(partial.includes('data-pending-count=""'));
  assert.equal(partial.includes("undefined"), false);

  const junk = renderVaultGitTab({ vaults: "nope" });
  assert.ok(junk.includes("还没有 Vault"));
});

test("the pending path list is bounded", () => {
  const paths = Array.from({ length: MAX_RENDERED_PENDING_PATHS + 5 }, (unused, index) => `p/${index}.md`);
  const html = renderVaultGitTab(view({
    vaults: [vaultFixture({ git: { pending: { count: paths.length, paths } } })],
  }));
  assert.ok(html.includes(`p/${MAX_RENDERED_PENDING_PATHS - 1}.md`));
  assert.equal(html.includes(`p/${paths.length - 1}.md`), false);
  assert.ok(html.includes(`…（共 ${paths.length} 条）`));
  assert.ok(html.includes(`data-pending-count="${paths.length}"`));
});

