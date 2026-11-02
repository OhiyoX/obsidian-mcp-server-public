// 概览 page — a faithful port of the prototype's `renderOverview` (#462) onto real service data:
// eight stat cards, 需要关注 / 最近失败 on the left, 运行状态 / 说明 on the right.
// Every number comes from the snapshot; a value the service does not provide renders as `—`, never 0.
import { pageBar } from "../ui.js";
import { esc, fut, rel, relTitle } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { actionLabel, credentialKindLabel, gitRuntimeLabel, publishLifecycleLabel } from "../presentation/labels.js";
import { t } from "../../i18n/context.js";
import { deployedVersion, formatDeployTime } from "../../release-version.js";
import { formatBeijingDeployLabel } from "../../beijing-deploy-time.js";

const DAY = 24 * 3600 * 1000;

function stat(href, icon, title, value, detail) {
  return `<a class="stat" href="${esc(href)}"><span class="t">${ic(icon)}${esc(title)}</span><span class="n">${esc(String(value))}</span><span class="d">${detail}</span></a>`;
}

function credentialText(model, row) {
  const kind = String(row?.credentialType || "");
  if (kind === "api-key") {
    const id = String(row?.credentialId || row?.clientId || "").replace(/^api-key:/, "");
    return `API Key · ${model.keyName(model.keyOf(id))}`;
  }
  if (kind.startsWith("oauth")) {
    const client = model.client(row?.clientId) || model.client(row?.credentialId);
    const account = row?.userId ? model.acct(row.userId) : null;
    if (client) return `${model.clientName(client)}${account ? ` · ${model.acctName(account)}` : ""}`;
    if (account) return model.acctName(account);
  }
  if (kind === "admin-session") return t("adm.label.credential.admin-session");
  if (!kind) return "—";
  return credentialKindLabel(kind).label;
}

function isFailure(row) {
  return row?.ok === false || row?.outcome === "failure" || row?.success === false;
}

function rowTime(row) {
  return row?.at || row?.time || row?.timestamp || row?.createdAt || null;
}

function gitStateCell(vault) {
  const git = vault?.git || {};
  const runtime = vault?.runtime || git.runtime || {};
  const state = runtime.state || git.state || "unknown";
  if (state === "ready" || state === "clean" || state === "synced") {
    return `<span class="st ok"><span class="dot"></span>${esc(t("adm.overview.gitSynced"))}</span>${runtime.lastCommitAt ? ` <span class="muted">${esc(t("adm.overview.gitLastCommit", { time: relTitle(runtime.lastCommitAt) }))}</span>` : ""}`;
  }
  if (state === "repository-missing" || state === "norepo") return `<span class="st off"><span class="dot"></span>${esc(t("adm.label.gitRuntime.repository-missing"))}</span>`;
  if (state === "disabled") return `<span class="st off"><span class="dot"></span>${esc(t("adm.overview.gitDisabled"))}</span>`;
  if (state === "push-failing") return `<span class="st amber"><span class="dot"></span>${esc(t("adm.label.gitRuntime.push-failing"))}</span>`;
  if (state === "config-invalid") return `<span class="st danger"><span class="dot"></span>${esc(t("adm.label.gitRuntime.config-invalid"))}</span>`;
  return `<span class="st off"><span class="dot"></span>${esc(gitRuntimeLabel(state).label)}</span>`;
}

export function renderOverviewPage(ctx) {
  const { model, snapshot, keys, grants, publishCounts, vaults, authz, transfers, publications } = ctx;
  const accounts = Array.isArray(snapshot?.oauthUsers) ? snapshot.oauthUsers : [];
  const clients = Array.isArray(snapshot?.clients) ? snapshot.clients : [];
  const audit = Array.isArray(snapshot?.audit) ? snapshot.audit : [];
  const disabled = accounts.filter((account) => account.enabled === false || account.disabledAt).length;
  const unused = keys.filter((key) => !key.lastUsedAt).length;
  const pendingTransfers = (transfers || []).filter((item) => item && item.status === "pending");
  const activeGrants = grants.filter((grant) => grant.status === "active");
  const publishActive = publishCounts.active ?? 0;
  const publishTotal = publishCounts.total ?? publishActive;
  const retired = Math.max(0, publishTotal - publishActive);
  const failures24 = audit.filter((row) => isFailure(row) && Date.parse(rowTime(row) || 0) >= Date.now() - DAY);
  const gitEnabled = vaults.filter((vault) => vault?.git?.enabled).length;
  const authzBroken = authz.status === "broken";

  const stats = [
    stat("/admin/auth?tab=accounts", "user", t("adm.nav.accounts"), accounts.length, disabled ? `<span class="w">${esc(t("adm.overview.stat.accountsDisabled", { count: disabled }))}</span>` : esc(t("adm.overview.stat.accountsAllEnabled"))),
    stat("/admin/auth?tab=keys", "key", t("adm.nav.keys"), keys.length, unused ? esc(t("adm.overview.stat.keysUnused", { count: unused })) : esc(t("adm.overview.stat.keysUsed"))),
    stat("/admin/auth?tab=clients", "app", t("adm.nav.clients"), clients.length, pendingTransfers.length ? `<span class="w">${esc(t("adm.overview.stat.clientsTransfers", { count: pendingTransfers.length }))}</span>` : esc(t("adm.overview.stat.clientsNone"))),
    stat("/admin/auth?tab=tokens", "ticket", t("adm.overview.stat.grants"), activeGrants.length, esc(t("adm.overview.stat.grantsTotal", { count: grants.length }))),
    stat("/admin/auth?tab=publishes", "globe", t("adm.overview.stat.published"), publishActive, retired ? `<span class="w">${esc(t("adm.overview.stat.publishedRetired", { count: retired }))}</span>` : esc(t("adm.overview.stat.publishedNone"))),
    stat("/admin/auth?tab=audit&outcome=failure", "list", t("adm.overview.stat.audit"), audit.length, failures24.length ? `<span class="w">${esc(t("adm.overview.stat.auditFailures", { count: failures24.length }))}</span>` : esc(t("adm.overview.stat.auditNone"))),
    stat(ctx.accessPolicyBase || "/admin/auth", "cal", t("adm.nav.accessPolicy"), `${authz.enabledCount} / ${authz.count}`, authzBroken ? `<span class="w">${esc(t("adm.overview.authzBroken"))}</span>` : esc(t("adm.overview.stat.authzDetail"))),
    stat(ctx.vaultGitBase || "/admin/auth", "db", "Vault", vaults.length, esc(t("adm.overview.stat.vaultGit", { count: gitEnabled }))),
  ];

  const attention = [];
  for (const transfer of pendingTransfers) {
    const client = model.client(transfer.clientId);
    const target = model.acct(transfer.targetUserId || transfer.toUserId);
    attention.push(`<a class="li" href="/admin/auth?tab=clients&id=${esc(transfer.clientId || "")}"><span class="dot amber"></span><b>${esc(t("adm.overview.transferPending", { client: model.clientName(client) }))}</b><span class="ell">${esc(t("adm.overview.transferWaiting", { target: model.acctName(target) }))}</span><span class="r">${relTitle(transfer.at || transfer.updatedAt || null)}</span></a>`);
  }
  const brute = failures24.filter((row) => String(row?.action) === "admin.login");
  if (brute.length) {
    attention.push(`<a class="li" href="/admin/auth?tab=audit&outcome=failure&action=admin.login"><span class="dot danger"></span><b>${esc(t("adm.overview.bruteForce", { count: brute.length }))}</b><span class="ell mono">${esc(brute[0]?.source || brute[0]?.src || "—")}</span><span class="r">${relTitle(rowTime(brute[0]))}</span></a>`);
  }
  if (retired) {
    attention.push(`<a class="li" href="/admin/auth?tab=publishes"><span class="dot amber"></span><b>${esc(t("adm.overview.publishOrphaned", { count: retired }))}</b><span class="ell">${esc(t("adm.overview.publishOrphanedWhy"))}</span></a>`);
  }
  if (authz.orphaned?.length) {
    attention.push(`<a class="li" href="${esc(ctx.accessPolicyBase || "/admin/auth")}"><span class="dot amber"></span><b>${esc(t("adm.overview.authzOrphaned", { count: authz.orphaned.length }))}</b><span class="ell">${esc(t("adm.overview.authzOrphanedWhy"))}</span></a>`);
  }
  for (const vault of vaults) {
    const state = vault?.runtime?.state || vault?.git?.state || "unknown";
    if (state === "repository-missing" || (!vault?.git?.enabled && state === "norepo")) {
      attention.push(`<a class="li" href="/admin/auth?tab=vault-git&id=${esc(vault.id)}"><span class="dot"></span><b>${esc(t("adm.overview.vaultNoGit", { vault: vault.name || vault.id }))}</b><span class="ell">${esc(t("adm.overview.vaultNoGitWhy"))}</span></a>`);
    }
  }
  const attentionHtml = attention.length
    ? `<div class="list">${attention.join("")}</div>`
    : `<div class="list"><div class="li"><span class="dot ok"></span><b>${esc(t("adm.overview.attentionEmpty"))}</b><span class="ell">${esc(t("adm.overview.attentionEmptyWhy"))}</span></div></div>`;

  const failures = audit.filter(isFailure).slice(0, 5).map((row) => {
    const action = actionLabel(row?.action);
    // Prototype `renderOverview`: the row deep-links to the exact record (`&focus=<id>`), which the
    // audit page marks with `.cur` (`renderAuditPage`); a row without an id falls back to the filter.
    const recordId = row?.id ?? row?.auditId ?? null;
    const href = recordId
      ? `/admin/auth?tab=audit&outcome=failure&focus=${encodeURIComponent(String(recordId))}`
      : "/admin/auth?tab=audit&outcome=failure";
    return `<a class="li" href="${esc(href)}"><span class="dot danger"></span><b class="nowrap">${esc(action.label)}</b><span class="ell">${esc(credentialText(model, row))}${row?.reason ? ` · ${esc(String(row.reason).slice(0, 80))}` : ""}</span><span class="r">${relTitle(rowTime(row))}</span></a>`;
  }).join("");
  const failuresHtml = failures
    ? `<div class="list">${failures}</div>`
    : `<div class="list"><div class="li"><span class="dot ok"></span><b>${esc(t("adm.overview.failuresEmpty"))}</b><span class="ell">${esc(t("adm.overview.failuresEmptyWhy"))}</span></div></div>`;

  let release = { version: "—", commit: "", deployedAt: null };
  try {
    release = deployedVersion() || release;
  } catch { /* local run without a manifest */ }
  // #515: the raw UTC ISO is the source of truth for API faces (`/healthz`, `server_info`);
  // every human face renders the Beijing label through the one shared formatter. This row
  // used to print the raw ISO, which read as a UTC wall clock to the operator.
  const deployTimeLabel = (() => {
    const formatted = formatDeployTime(release.deployedAt);
    return formatBeijingDeployLabel(formatted.iso) ?? formatted.label;
  })();
  // `data-deployed-at` carries the RAW manifest string (never re-serialised: #515's DT-2 scene
  // compares it byte for byte with the manifest) on the same `span.muted` the prototype's row
  // already has — no new node, so the proto-shape comparison is unaffected — which is what lets a
  // later client-side route rewrite the label without touching this markup.
  const authzLine = authz.available === false
    ? `<span class="st off"><span class="dot"></span>${esc(t("adm.overview.authzNotConnected"))}</span>`
    : authzBroken
      ? `<span class="st danger"><span class="dot"></span>${esc(t("adm.overview.authzBroken"))}</span>`
      : authz.enabled
        ? `<span class="st ok"><span class="dot"></span>${esc(t("adm.overview.authzEnabled"))}</span> <span class="muted">· ${esc(t("adm.overview.authzPolicies", { count: authz.enabledCount }))}</span>`
        : `<span class="st off"><span class="dot"></span>${esc(t("adm.overview.authzRegistered"))}</span> <span class="muted">· ${esc(t("adm.overview.authzPolicyCount", { count: authz.count }))}</span>`;
  const health = `<div class="kv">
<div class="k">${esc(t("adm.nav.accessPolicy"))}</div><div>${authzLine} ${fut("Stage 5")}</div>
${vaults.map((vault) => `<div class="k">${esc(vault.name || vault.id)}</div><div>${gitStateCell(vault)}</div>`).join("")}
<div class="k">${esc(t("adm.foot.deployVersion"))}</div><div><span class="mono">${esc(release.version || "—")}</span>${release.commit ? ` <span class="muted"${release.deployedAt ? ` data-deployed-at="${esc(release.deployedAt)}"` : ""}>· commit ${esc(release.commit)}${release.deployedAt ? ` · ${esc(deployTimeLabel)}` : ""}</span>` : ""}</div>
<div class="k">${esc(t("adm.overview.lastDeploy"))}</div><div>${release.deployedAt ? `${relTitle(release.deployedAt)} <span class="mono">· ${esc(release.version || "—")}</span>` : `<span class="muted">${esc(t("adm.overview.notDeployed"))}</span>`}</div>
</div>`;

  const content = `${pageBar({ title: t("adm.nav.overview") })}<div class="content scroll"><div class="page">
<div class="stats">${stats.join("")}</div>
<div class="ov2">
  <div>
    <div class="sect"><div class="sect-h"><h2>${esc(t("adm.overview.attention"))}</h2><span class="muted">${attention.length}</span></div>${attentionHtml}</div>
    <div class="sect"><div class="sect-h"><h2>${esc(t("adm.overview.recentFailures"))}</h2><span class="grow"></span><a class="btn ghost sm" href="/admin/auth?tab=audit&amp;outcome=failure">${esc(t("adm.overview.viewAll"))} ${ic("chev", "xs")}</a></div>${failuresHtml}</div>
  </div>
  <div>
    <div class="sect"><div class="sect-h"><h2>${esc(t("adm.overview.runtimeStatus"))}</h2></div>${health}</div>
    <div class="sect"><div class="sect-h"><h2>${esc(t("adm.overview.notes"))}</h2></div><p class="help" style="margin:0">${esc(t("adm.overview.notesBody"))}</p></div>
  </div>
</div>
</div></div>`;
  return { content, detailPanel: "" };
}

export { publishLifecycleLabel };
