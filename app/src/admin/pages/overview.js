// 概览 page — a faithful port of the prototype's `renderOverview` (#462) onto real service data:
// eight stat cards, 需要关注 / 最近失败 on the left, 运行状态 / 说明 on the right.
// Every number comes from the snapshot; a value the service does not provide renders as `—`, never 0.
import { pageBar } from "../ui.js";
import { esc, fut, rel, relTitle } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { actionLabel, credentialKindLabel, gitRuntimeLabel, publishLifecycleLabel } from "../presentation/labels.js";
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
  if (kind === "admin-session") return "管理会话";
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
    return `<span class="st ok"><span class="dot"></span>已同步</span>${runtime.lastCommitAt ? ` <span class="muted">· 最近提交 ${relTitle(runtime.lastCommitAt)}</span>` : ""}`;
  }
  if (state === "repository-missing" || state === "norepo") return `<span class="st off"><span class="dot"></span>未初始化 Git 仓库</span>`;
  if (state === "disabled") return `<span class="st off"><span class="dot"></span>未启用 Git</span>`;
  if (state === "push-failing") return `<span class="st amber"><span class="dot"></span>推送失败</span>`;
  if (state === "config-invalid") return `<span class="st danger"><span class="dot"></span>配置无效</span>`;
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
    stat("/admin/auth?tab=accounts", "user", "OAuth 账户", accounts.length, disabled ? `<span class="w">${disabled} 个已停用</span>` : "全部启用"),
    stat("/admin/auth?tab=keys", "key", "API Key", keys.length, unused ? `${unused} 个从未调用` : "均有调用"),
    stat("/admin/auth?tab=clients", "app", "OAuth 客户端", clients.length, pendingTransfers.length ? `<span class="w">${pendingTransfers.length} 个转移待完成</span>` : "无待处理"),
    stat("/admin/auth?tab=tokens", "ticket", "有效授权", activeGrants.length, `共 ${grants.length} 次授权记录`),
    stat("/admin/auth?tab=publishes", "globe", "已发布文档", publishActive, retired ? `<span class="w">${retired} 条已失效待清理</span>` : "无失效记录"),
    stat("/admin/auth?tab=audit&outcome=failure", "list", "审计记录", audit.length, failures24.length ? `<span class="w">24 小时内 ${failures24.length} 次失败</span>` : "24 小时内无失败"),
    stat(ctx.accessPolicyBase || "/admin/auth", "cal", "定时授权", `${authz.enabledCount} / ${authz.count}`, authzBroken ? `<span class="w">策略存储异常</span>` : "已启用策略 / 全部"),
    stat(ctx.vaultGitBase || "/admin/auth", "db", "Vault", vaults.length, `${gitEnabled} 个启用 Git`),
  ];

  const attention = [];
  for (const transfer of pendingTransfers) {
    const client = model.client(transfer.clientId);
    const target = model.acct(transfer.targetUserId || transfer.toUserId);
    attention.push(`<a class="li" href="/admin/auth?tab=clients&id=${esc(transfer.clientId || "")}"><span class="dot amber"></span><b>${esc(model.clientName(client))} 授权转移待完成</b><span class="ell">等待 ${esc(model.acctName(target))} 重新授权</span><span class="r">${relTitle(transfer.at || transfer.updatedAt || null)}</span></a>`);
  }
  const brute = failures24.filter((row) => String(row?.action) === "admin.login");
  if (brute.length) {
    attention.push(`<a class="li" href="/admin/auth?tab=audit&outcome=failure&action=admin.login"><span class="dot danger"></span><b>管理登录失败 ${brute.length} 次</b><span class="ell mono">${esc(brute[0]?.source || brute[0]?.src || "—")}</span><span class="r">${relTitle(rowTime(brute[0]))}</span></a>`);
  }
  if (retired) {
    attention.push(`<a class="li" href="/admin/auth?tab=publishes"><span class="dot amber"></span><b>${retired} 条发布记录已失效</b><span class="ell">源笔记已删除或不再是 Markdown，可撤销清理</span></a>`);
  }
  if (authz.orphaned?.length) {
    attention.push(`<a class="li" href="${esc(ctx.accessPolicyBase || "/admin/auth")}"><span class="dot amber"></span><b>${authz.orphaned.length} 个孤立主体</b><span class="ell">策略引用了已删除的凭据，建议编辑策略移除</span></a>`);
  }
  for (const vault of vaults) {
    const state = vault?.runtime?.state || vault?.git?.state || "unknown";
    if (state === "repository-missing" || (!vault?.git?.enabled && state === "norepo")) {
      attention.push(`<a class="li" href="/admin/auth?tab=vault-git&id=${esc(vault.id)}"><span class="dot"></span><b>${esc(vault.name || vault.id)} 未初始化 Git 仓库</b><span class="ell">版本历史仅保存在本机</span></a>`);
    }
  }
  const attentionHtml = attention.length
    ? `<div class="list">${attention.join("")}</div>`
    : `<div class="list"><div class="li"><span class="dot ok"></span><b>暂无需要关注的项</b><span class="ell">当前没有需要处理的告警</span></div></div>`;

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
    : `<div class="list"><div class="li"><span class="dot ok"></span><b>最近无失败记录</b><span class="ell">审计中没有失败的调用</span></div></div>`;

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
    ? `<span class="st off"><span class="dot"></span>未接入</span>`
    : authzBroken
      ? `<span class="st danger"><span class="dot"></span>策略存储异常</span>`
      : authz.enabled
        ? `<span class="st ok"><span class="dot"></span>已启用</span> <span class="muted">· ${authz.enabledCount} 条策略生效</span>`
        : `<span class="st off"><span class="dot"></span>已注册但未启用</span> <span class="muted">· ${authz.count} 条策略</span>`;
  const health = `<div class="kv">
<div class="k">定时授权</div><div>${authzLine} ${fut("Stage 5")}</div>
${vaults.map((vault) => `<div class="k">${esc(vault.name || vault.id)}</div><div>${gitStateCell(vault)}</div>`).join("")}
<div class="k">部署版本</div><div><span class="mono">${esc(release.version || "—")}</span>${release.commit ? ` <span class="muted"${release.deployedAt ? ` data-deployed-at="${esc(release.deployedAt)}"` : ""}>· commit ${esc(release.commit)}${release.deployedAt ? ` · ${esc(deployTimeLabel)}` : ""}</span>` : ""}</div>
<div class="k futonly">上次部署</div><div class="futonly"><span class="muted">${esc(deployTimeLabel)}</span> ${fut("部署信息")}</div>
</div>`;

  const content = `${pageBar({ title: "概览" })}<div class="content scroll"><div class="page">
<div class="stats">${stats.join("")}</div>
<div class="ov2">
  <div>
    <div class="sect"><div class="sect-h"><h2>需要关注</h2><span class="muted">${attention.length}</span></div>${attentionHtml}</div>
    <div class="sect"><div class="sect-h"><h2>最近失败</h2><span class="grow"></span><a class="btn ghost sm" href="/admin/auth?tab=audit&amp;outcome=failure">查看全部 ${ic("chev", "xs")}</a></div>${failuresHtml}</div>
  </div>
  <div>
    <div class="sect"><div class="sect-h"><h2>运行状态</h2></div>${health}</div>
    <div class="sect"><div class="sect-h"><h2>说明</h2></div><p class="help" style="margin:0">Publish 管理只显示 Vault、路径和时间等元数据，不在管理端渲染正文。所有修改 OAuth 账户权限、改密的操作都会撤销该账户已有授权。</p></div>
  </div>
</div>
</div></div>`;
  return { content, detailPanel: "" };
}

export { publishLifecycleLabel };
