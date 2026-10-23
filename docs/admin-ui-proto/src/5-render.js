<script>
"use strict";
// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ic = (n, cls = "") => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const fut = (src) => `<span class="fut" title="规划中，尚未实现">规划中${src ? " · " + esc(src) : ""}</span>`;
const pad = (n) => String(n).padStart(2, "0");
function rel(iso) {
  if (!iso) return "—";
  const d = NOW - new Date(iso);
  if (d < 60e3) return "刚刚";
  if (d < H) return Math.round(d / M) + " 分钟前";
  if (d < D) return Math.round(d / H) + " 小时前";
  if (d < 30 * D) return Math.round(d / D) + " 天前";
  return fmtDate(iso);
}
const sh = (iso) => new Date(new Date(iso).getTime() + 8 * H); // display in Asia/Shanghai regardless of host tz
function fmtDate(iso) { const t = sh(iso); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function fmt(iso) { if (!iso) return "—"; const t = sh(iso); return `${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; }
function fmtFull(iso) { if (!iso) return "—"; const t = sh(iso); return `${fmtDate(iso)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`; }
const short = (id) => (id && id.length > 12 ? id.slice(0, 8) + "…" : id || "");
const idc = (id, label) => `<button class="idc" data-copy="${esc(id)}" title="${esc(id)} · 点击复制">${esc(label ?? short(id))}${ic("copy")}</button>`;
const scopeName = (k) => SCOPES.find((s) => s.key === k)?.name ?? k;
const vaultLabel = (id) => VAULTS.find((v) => v.id === id)?.label ?? id;
const scopeTags = (arr) => arr.length === SCOPES.length ? `<span class="tag">全部权限</span>` : arr.map((k) => `<span class="tag" title="${esc(k)}">${esc(scopeName(k))}</span>`).join("");
const vaultTags = (arr) => arr.map((v) => `<span class="tag acc" title="Vault id: ${esc(v)}">${esc(v)}</span>`).join("");
const acct = (id) => ACCOUNTS.find((a) => a.id === id);
const acctName = (a) => (a ? a.displayName || a.username : "已删除 / 未知");
const client = (id) => CLIENTS.find((c) => c.clientId === id);
const clientName = (c) => (c ? c.clientName || "未命名客户端" : "已删除 / 未知");
const keyOf = (id) => KEYS.find((k) => k.id === id);
const keyName = (k) => (k ? k.label || "未命名 Key" : "已删除 / 未知");
const linkedAccounts = (cid) => [...new Set(TOKENS.filter((t) => t.clientId === cid && t.status === "active").map((t) => t.userId))].map(acct).filter(Boolean);
const linkedClients = (uid) => [...new Set(TOKENS.filter((t) => t.userId === uid && t.status === "active").map((t) => t.clientId))].map(client).filter(Boolean);
const TOKEN_ST = { active: ["有效", "ok"], rotated: ["已轮换", "off"], revoked: ["已撤销", "danger"], expired: ["已过期", "off"] };
const stTag = (s) => { const [l, c] = TOKEN_ST[s]; return `<span class="st ${c}" title="${s}"><span class="dot"></span>${l}</span>`; };
const MODE = { suspend: { n: "暂停", d: "窗口外暂停访问，已有会话与授权保留，回到窗口内自动恢复" }, revoke: { n: "撤销", d: "窗口外撤销该主体的全部授权与会话，需重新授权；能力必须为「全部」" } };
const DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const KIND_LABEL = { "api-key": "API Key", "oauth-client": "OAuth 客户端", "oauth-user": "OAuth 账户" };

/* subject view-model (#455)：名称 + 类型 + 缩略 id；未命名 / 已删除 两种区分 */
function subjectView(s) {
  const i = s.indexOf(":"), kind = s.slice(0, i), id = s.slice(i + 1);
  let name = null, missing = false, sub = "";
  if (kind === "api-key") {
    if (id === "configured-env") { name = "环境配置 API_KEY"; sub = "部署环境变量"; }
    else { const k = keyOf(id); if (!k) missing = true; else name = k.label || null; sub = k?.prefix ? k.prefix + "…" : ""; }
  } else if (kind === "oauth-client") {
    const c = client(id); if (!c) missing = true; else { name = c.clientName || null; sub = linkedAccounts(id).map(acctName).join("、"); }
  } else if (kind === "oauth-user") {
    const a = acct(id); if (!a) missing = true; else { name = a.displayName || a.username; sub = a.displayName ? a.username : ""; }
  }
  return { s, kind, id, kindLabel: KIND_LABEL[kind] ?? kind, name: missing ? "已删除 / 未知" : name ?? "未命名", unnamed: !missing && !name, missing, sub, shortId: id === "configured-env" ? id : short(id) };
}
function subjectCell(s) {
  const v = subjectView(s);
  return `<div class="nm"><b class="${v.missing ? "muted" : ""}" style="${v.unnamed || v.missing ? "font-style:italic;font-weight:400" : ""}">${esc(v.name)}</b><span class="sub2"><span class="kind">${esc(v.kindLabel)}</span>${idc(v.s, v.shortId)}</span></div>`;
}
function capName(k) { for (const g of CAPS) for (const it of g.items) if (it.k === k) return it.n; return k; }
const capTags = (arr) => arr.map((k) => `<span class="tag ${k === "all" ? "amber" : ""}" title="${esc(k)}">${esc(capName(k))}</span>`).join("");

/* window semantics (#434)：摘要文本 */
function windowSummary(p) {
  const parts = [];
  if (p.weekly.length) {
    const byRange = {};
    for (const w of p.weekly) (byRange[w.from + "–" + w.to] ??= []).push(w.day);
    for (const [r, days] of Object.entries(byRange)) {
      const ds = days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      let dl = ds.map((d) => DAYS[d]).join("、");
      const key = ds.join(",");
      if (key === "1,2,3,4,5") dl = "工作日"; else if (ds.length === 7) dl = "每天"; else if (key === "6,0") dl = "周末";
      parts.push(`${dl} ${r}`);
    }
  } else parts.push("每天全天");
  const marks = [];
  if (p.startsAt) marks.push(p.startsAt.slice(5, 10).replace("-", "/") + " 起");
  if (p.expiresAt) marks.push("至 " + p.expiresAt.slice(5, 10).replace("-", "/"));
  for (const r of p.dateRanges) marks.push(`限 ${r.from.slice(5).replace("-", "/")}–${r.to.slice(5).replace("-", "/")}`);
  return { text: parts.join("；"), marks };
}
/* is-allowed-now evaluation for preview (prototype logic, policy tz = Asia/Shanghai only) */
function inWindow(p, t = NOW) {
  const local = sh(t.toISOString()), day = local.getUTCDay(), hm = pad(local.getUTCHours()) + ":" + pad(local.getUTCMinutes()), dstr = fmtDate(t.toISOString());
  const ldt = dstr + "T" + hm;
  if (p.startsAt && ldt < p.startsAt) return { ok: false, why: "尚未到生效起点" };
  if (p.expiresAt && ldt > p.expiresAt) return { ok: false, why: "已过失效终点" };
  if (p.dateRanges.length && !p.dateRanges.some((r) => dstr >= r.from && dstr <= r.to)) return { ok: false, why: "今天不在限定日期内" };
  if (p.weekly.length && !p.weekly.some((w) => w.day === day && hm >= w.from && hm < w.to)) return { ok: false, why: `${DAYS[day]} ${hm} 不在每周窗口内` };
  return { ok: true, why: "在允许窗口内" };
}
function timeline(p) {
  const today = sh(NOW.toISOString()).getUTCDay(), nowPct = ((sh(NOW.toISOString()).getUTCHours() * 60 + sh(NOW.toISOString()).getUTCMinutes()) / 1440) * 100;
  const toPct = (s) => { const [h, m] = s.split(":").map(Number); return ((h * 60 + m) / 1440) * 100; };
  let rows = "";
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const ws = p.weekly.length ? p.weekly.filter((w) => w.day === d && w.to > w.from) : [{ from: "00:00", to: "24:00" }];
    rows += `<span class="${d === today ? "today" : ""}">${DAYS[d].slice(1)}</span><div class="tr">${ws.map((w) => `<div class="w" style="left:${toPct(w.from)}%;width:${toPct(w.to) - toPct(w.from)}%" title="${w.from}–${w.to}"></div>`).join("")}${d === today ? `<div class="now" style="left:${nowPct}%" title="现在"></div>` : ""}</div>`;
  }
  return `<div class="tl">${rows}<span></span><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}

// ---------------------------------------------------------------- shared bits
const pageBar = (title, extra = "", cnt = "") => `<header class="bar"><button class="ibtn mobile-only" data-act="mmenu" aria-label="菜单" style="display:none">${ic("menu")}</button><h1>${title}${cnt !== "" ? `<span class="cnt">${cnt}</span>` : ""}</h1><span class="grow"></span>${extra}</header>`;
const searchBox = (ph, val, key) => `<label class="search">${ic("search")}<input data-search="${key}" placeholder="${esc(ph)}" value="${esc(val || "")}"><kbd>/</kbd></label>`;
const moreBtn = (kind, id) => `<button class="ibtn" data-menu="${kind}" data-id="${esc(id)}" aria-label="更多操作" title="更多操作">${ic("more")}</button>`;
const emptyState = (icn, title, desc, action = "") => `<div class="empty"><div class="ic">${ic(icn)}</div><b>${title}</b><span>${desc}</span>${action}</div>`;
function table(cols, rows, empty) {
  if (!rows.length) return `<div class="tw">${empty}</div>`;
  return `<div class="tw hide-m"><table class="tbl"><colgroup>${cols.map((c) => `<col${c[1] ? ` style="width:${c[1]}"` : ""}>`).join("")}</colgroup><thead><tr>${cols.map((c) => `<th class="${c[2] || ""}">${c[0]}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
const mcards = (cards) => (cards.length ? `<div class="mcards">${cards.join("")}</div>` : "");

// ---------------------------------------------------------------- login
function renderLogin() {
  const locked = S.loginLocked;
  return `<div class="login"><form class="box" data-form="login">
  <h1><svg class="logo" style="width:28px;height:28px"><use href="#logo"/></svg>Obsidian MCP 授权管理</h1>
  <div class="fld"><label for="pw">管理密码</label><div class="pw"><input class="inp" id="pw" type="password" autocomplete="current-password" ${locked ? "disabled" : ""} style="height:40px"><button type="button" class="ibtn" data-act="pwtoggle" style="top:6px" aria-label="显示密码">${ic("eye")}</button></div>
  ${locked ? `<span class="lock-note">连续失败次数过多，已临时锁定，请 15 分钟后再试</span>` : S.loginErr ? `<span class="lock-note">密码不正确</span>` : ""}</div>
  <button class="btn primary" ${locked ? "disabled" : ""}>登录</button>
  <p class="help" style="margin:0">这里使用独立的管理密码，<b class="tx2" style="font-weight:600">不接受</b> OAuth 账户密码、API Key 或 Token。</p>
  <div class="foot"><span>部署版本 <span class="mono">${VERSION}</span></span><a href="#/web" onclick="return false">进入 Obsidian Web ${ic("ext", "xs")}</a></div>
  </form></div>`;
}

// ---------------------------------------------------------------- overview (#462)
function renderOverview() {
  const active = TOKENS.filter((t) => t.status === "active" && t.type === "refresh");
  const fails24 = AUDIT.filter((a) => !a.ok && NOW - new Date(a.at) < D);
  const pending = CLIENTS.filter((c) => c.transfer).length;
  const disabled = ACCOUNTS.filter((a) => !a.enabled).length;
  const retired = PUBLISHES.filter((p) => p.status !== "active").length;
  const unused = KEYS.filter((k) => !k.lastUsed).length;
  const stat = (href, icn, t, n, d) => `<a class="stat" href="#/${href}"><span class="t">${ic(icn)}${t}</span><span class="n">${n}</span><span class="d">${d}</span></a>`;
  const stats = [
    stat("accounts", "user", "OAuth 账户", ACCOUNTS.length, disabled ? `<span class="w">${disabled} 个已停用</span>` : "全部启用"),
    stat("keys", "key", "API Key", KEYS.length, unused ? `${unused} 个从未调用` : "均有调用"),
    stat("clients", "app", "OAuth 客户端", CLIENTS.length, pending ? `<span class="w">${pending} 个转移待完成</span>` : "无待处理"),
    stat("tokens", "ticket", "有效授权", active.length, `共 ${TOKENS.length / 2} 次授权记录`),
    stat("publish", "globe", "已发布文档", PUBLISHES.filter((p) => p.status === "active").length, retired ? `<span class="w">${retired} 条已失效待清理</span>` : "无失效记录"),
    stat("audit?outcome=failure", "list", "审计记录", AUDIT.length, fails24.length ? `<span class="w">24 小时内 ${fails24.length} 次失败</span>` : "24 小时内无失败"),
    stat("authz", "cal", "定时授权", POLICIES.filter((p) => p.enabled).length + " / " + POLICIES.length, AUTHZ.enabled ? "已启用策略 / 全部" : "AuthZ 总开关关闭"),
    stat("vaults", "db", "Vault", VAULTS.length, `${VAULTS.filter((v) => v.git.enabled).length} 个启用 Git`),
  ];
  const att = [];
  if (pending) att.push(`<a class="li" href="#/clients/${CLIENTS[0].clientId}"><span class="dot amber"></span><b>Claude Desktop 授权转移待完成</b><span class="ell">等待 audit-user 重新授权</span><span class="r">${rel(CLIENTS[0].transfer.at)}</span></a>`);
  const brute = AUDIT.filter((a) => a.action === "admin.login" && !a.ok);
  if (brute.length) att.push(`<a class="li" href="#/audit?outcome=failure&action=admin.login"><span class="dot danger"></span><b>管理登录失败 ${brute.length} 次</b><span class="ell mono">${brute[0].src}</span><span class="r">${rel(brute[0].at)}</span></a>`);
  if (retired) att.push(`<a class="li" href="#/publish"><span class="dot amber"></span><b>${retired} 条发布记录已失效</b><span class="ell">源笔记已删除，可撤销清理</span></a>`);
  att.push(`<a class="li" href="#/vaults/research"><span class="dot"></span><b>research 未初始化 Git 仓库</b><span class="ell">版本历史仅保存在本机</span></a>`);
  const fails = AUDIT.filter((a) => !a.ok).slice(0, 5).map((a) => `<a class="li" href="#/audit?outcome=failure&focus=${a.id}"><span class="dot danger"></span><b class="nowrap">${esc(ACTIONS[a.action]?.[0] ?? a.action)}</b><span class="ell">${esc(credLabel(a))}${a.reason ? " · " + esc(a.reason) : ""}</span><span class="r">${rel(a.at)}</span></a>`).join("");
  const health = `<div class="kv">
    <div class="k">定时授权</div><div>${AUTHZ.enabled ? `<span class="st ok"><span class="dot"></span>已启用</span> <span class="muted">· ${POLICIES.filter((p) => p.enabled).length} 条策略生效</span>` : `<span class="st off"><span class="dot"></span>未启用</span>`} ${fut("Stage 5")}</div>
    ${VAULTS.map((v) => `<div class="k">${esc(v.id)}</div><div>${gitState(v)}</div>`).join("")}
    <div class="k">部署版本</div><div><span class="mono">${VERSION}</span> <span class="muted">· main@3bc97da</span></div>
    <div class="k futonly">上次部署</div><div class="futonly"><span class="muted">2026-10-05 · v2026.10.05.8</span> ${fut("部署信息")}</div>
  </div>`;
  return pageBar("概览") + `<div class="content scroll"><div class="page">
  <div class="stats">${stats.join("")}</div>
  <div class="ov2"><div><div class="sect"><div class="sect-h"><h2>需要关注</h2><span class="muted">${att.length}</span></div><div class="list">${att.join("")}</div></div>
  <div class="sect"><div class="sect-h"><h2>最近失败</h2><span class="grow"></span><a href="#/audit?outcome=failure" class="btn ghost sm">查看全部 ${ic("chev", "xs")}</a></div><div class="list">${fails}</div></div></div>
  <div><div class="sect"><div class="sect-h"><h2>运行状态</h2></div>${health}</div>
  <div class="sect"><div class="sect-h"><h2>说明</h2></div><p class="help" style="margin:0">Publish 管理只显示 Vault、路径和时间等元数据，不在管理端渲染正文。所有修改 OAuth 账户权限、改密的操作都会撤销该账户已有授权。</p></div></div></div>
  </div></div>`;
}
function gitState(v) {
  const r = v.repo;
  if (!v.git.enabled && r.state === "norepo") return `<span class="st off"><span class="dot"></span>未初始化 Git 仓库</span>`;
  if (r.state === "clean") return `<span class="st ok"><span class="dot"></span>已同步</span> <span class="muted">· 最近提交 ${rel(r.lastCommit)}</span>`;
  if (r.state === "dirty") return `<span class="st amber"><span class="dot"></span>${r.pending.length} 个待提交</span>`;
  return `<span class="st danger"><span class="dot"></span>配置错误</span>`;
}
function credLabel(a) {
  const c = a.cred;
  if (c.kind === "api-key") return "API Key · " + keyName(keyOf(c.key));
  if (c.client) return clientName(client(c.client)) + (c.user ? " · " + acctName(acct(c.user)) : "");
  if (c.user) return acctName(acct(c.user));
  return CRED_KIND[c.kind];
}

// ---------------------------------------------------------------- accounts (#460)
function renderAccounts() {
  const q = (S.q.accounts || "").toLowerCase();
  const list = ACCOUNTS.filter((a) => !q || (a.username + a.displayName).toLowerCase().includes(q));
  const rows = list.map((a) => {
    const lc = linkedClients(a.id);
    return `<tr class="click ${a.enabled ? "" : "dim"} ${S.cur === a.id ? "cur" : ""}" data-open="account" data-id="${a.id}">
    <td><div class="nm"><b>${esc(a.displayName || a.username)}</b><span class="sub2">${a.displayName ? `<span class="mono">${esc(a.username)}</span>` : `<span class="muted" style="font-style:italic">未设置显示名</span>`}${idc(a.id)}</span></div></td>
    <td>${a.enabled ? `<span class="st ok"><span class="dot"></span>启用</span>` : `<span class="st off"><span class="dot"></span>已停用</span>`}</td>
    <td><div class="tags">${scopeTags(a.scopes)}${vaultTags(a.vaults)}</div></td>
    <td class="cellt">${lc.length ? lc.map((c) => `<a href="#/clients/${c.clientId}" data-stop>${esc(clientName(c))}</a>`).join("、") : `<span class="muted">—</span>`}</td>
    <td class="cellt">${a.lastLogin ? `${rel(a.lastLogin.at)} <span class="muted mono">${a.lastLogin.ip}</span>` : `<span class="muted">从未登录</span>`}</td>
    <td class="cellt muted">${fmtDate(a.createdAt)}</td>
    <td class="act">${moreBtn("account", a.id)}</td></tr>`;
  });
  const cards = list.map((a) => `<div class="mc" data-open="account" data-id="${a.id}"><div class="b"><div class="nm"><b>${esc(a.displayName || a.username)}</b><span class="sub2">${esc(a.username)}${a.enabled ? "" : " · 已停用"}</span></div><div class="tags">${scopeTags(a.scopes)}${vaultTags(a.vaults)}</div><div class="meta"><span>${a.lastLogin ? "登录 " + rel(a.lastLogin.at) : "从未登录"}</span><span>${linkedClients(a.id).length} 个客户端</span></div></div>${moreBtn("account", a.id)}</div>`);
  return pageBar("OAuth 账户", `<button class="btn primary" data-act="new-account">${ic("plus")}<span class="hide-m">新建账户</span></button>`, ACCOUNTS.length) + `<div class="content scroll"><div class="page">
  <p class="lede">账户用于客户端的 OAuth 同意页登录，与管理密码相互独立。</p>
  <div class="toolbar">${searchBox("搜索用户名或显示名", S.q.accounts, "accounts")}</div>
  ${table([["账户", "24%"], ["状态", "10%"], ["权限上限 · Vault", "24%"], ["已授权客户端", "16%"], ["最后登录", "14%"], ["创建", "10%"], ["", "", "act"]], rows, emptyState("user", q ? "没有匹配的账户" : "还没有 OAuth 账户", q ? "换个关键词试试" : "创建账户后，用户即可在客户端的授权页登录", q ? "" : `<button class="btn primary" data-act="new-account">${ic("plus")}新建账户</button>`))}${mcards(cards)}
  </div></div>`;
}

// ---------------------------------------------------------------- api keys (#459 #460)
function renderKeys() {
  const q = (S.q.keys || "").toLowerCase();
  const list = KEYS.filter((k) => !q || (k.label + (k.prefix || "")).toLowerCase().includes(q));
  const rows = list.map((k) => `<tr class="click ${S.cur === k.id ? "cur" : ""}" data-open="key" data-id="${k.id}">
    <td><div class="nm"><b style="${k.label ? "" : "font-style:italic;font-weight:400;color:var(--tx2)"}">${esc(keyName(k))}</b><span class="sub2">${k.env ? `<span class="kind">环境变量</span><span class="muted">由部署 .env 提供</span>` : `<span class="mono">${esc(k.prefix)}…</span>${idc(k.id)}`}</span></div></td>
    <td><div class="tags">${scopeTags(k.scopes)}${vaultTags(k.vaults)}</div></td>
    <td class="cellt">${k.lastUsed ? `${rel(k.lastUsed.at)} <span class="muted">· ${esc(k.lastUsed.agent)}</span>` : `<span class="muted">从未调用</span>`}</td>
    <td class="cellt mono muted">${k.lastUsed?.ip ?? "—"}</td>
    <td class="cellt muted">${k.env ? "随部署" : fmtDate(k.createdAt)}</td>
    <td class="act">${k.env ? `<span class="ibtn" title="环境配置 Key 只读：在受保护的 .env 中轮换">${ic("lock")}</span>` : moreBtn("key", k.id)}</td></tr>`);
  const cards = list.map((k) => `<div class="mc" data-open="key" data-id="${k.id}"><div class="b"><div class="nm"><b>${esc(keyName(k))}</b><span class="sub2">${k.env ? "环境变量 · 只读" : esc(k.prefix) + "…"}</span></div><div class="tags">${scopeTags(k.scopes)}${vaultTags(k.vaults)}</div><div class="meta"><span>${k.lastUsed ? "调用 " + rel(k.lastUsed.at) : "从未调用"}</span></div></div>${k.env ? "" : moreBtn("key", k.id)}</div>`);
  return pageBar("API Key", `<button class="btn primary" data-act="new-key">${ic("plus")}<span class="hide-m">新建 Key</span></button>`, KEYS.length) + `<div class="content scroll"><div class="page">
  <p class="lede">每个 Key 独立设置权限范围与可访问的 Vault。Key 明文只在创建时显示一次。</p>
  ${S.flashKey ? `<div class="banner amber">${ic("key")}<div style="flex:1;min-width:0"><b>新 Key「${esc(S.flashKey.label)}」已创建，明文仅显示这一次</b><div class="secret" style="margin-top:8px"><span class="grow">${esc(S.flashKey.secret)}</span><button class="btn sm" data-copy="${esc(S.flashKey.secret)}">${ic("copy")}复制</button></div><span class="help">离开或刷新本页后将无法再次查看；遗失请删除后重新创建。</span></div><button class="ibtn" data-act="dismiss-flash">${ic("x")}</button></div>` : ""}
  <div class="toolbar">${searchBox("搜索备注或前缀", S.q.keys, "keys")}</div>
  ${table([["名称 / 前缀", "26%"], ["权限 · Vault", "26%"], ["最后调用", "20%"], ["来源", "12%"], ["创建", "10%"], ["", "", "act"]], rows, emptyState("key", "没有匹配的 Key", "换个关键词试试"))}${mcards(cards)}
  </div></div>`;
}

// ---------------------------------------------------------------- clients (#459 #364)
function renderClients() {
  const q = (S.q.clients || "").toLowerCase();
  const list = CLIENTS.filter((c) => !q || (clientName(c) + c.redirectUris.join(" ")).toLowerCase().includes(q));
  const rows = list.map((c) => {
    const la = linkedAccounts(c.clientId);
    return `<tr class="click ${S.cur === c.clientId ? "cur" : ""}" data-open="client" data-id="${c.clientId}">
    <td><div class="nm"><b style="${c.clientName ? "" : "font-style:italic;font-weight:400;color:var(--tx2)"}">${esc(clientName(c))}</b><span class="sub2">${idc(c.clientId)}</span></div></td>
    <td class="cellt">${la.length ? la.map((a) => `<a href="#/accounts/${a.id}" data-stop>${esc(acctName(a))}</a>`).join("、") : `<span class="muted">无有效授权</span>`}${c.transfer ? `<div><span class="tag amber" title="已撤销原账户授权，等待目标账户在客户端重新同意">转移中 → ${esc(acctName(acct(c.transfer.to)))}</span></div>` : ""}</td>
    <td class="cellt">${c.domains.length ? c.domains.map((d) => `<span title="来源：${d.src.join("、")}">${esc(d.host)}</span>`).join("") : `<span class="muted">—</span>`}</td>
    <td class="cellt">${c.lastCall ? `${rel(c.lastCall.at)} <span class="muted mono">${c.lastCall.ip}</span>` : `<span class="muted">从未调用</span>`}</td>
    <td class="cellt mono muted" title="${esc(c.redirectUris.join("\n"))}">${esc(c.redirectUris[0].replace(/^https?:\/\//, ""))}${c.redirectUris.length > 1 ? ` <span class="tag">+${c.redirectUris.length - 1}</span>` : ""}</td>
    <td class="act">${moreBtn("client", c.clientId)}</td></tr>`;
  });
  const cards = list.map((c) => `<div class="mc" data-open="client" data-id="${c.clientId}"><div class="b"><div class="nm"><b>${esc(clientName(c))}</b><span class="sub2">${linkedAccounts(c.clientId).map(acctName).join("、") || "无有效授权"}</span></div>${c.transfer ? `<span><span class="tag amber">转移中 → ${esc(acctName(acct(c.transfer.to)))}</span></span>` : ""}<div class="meta"><span>${c.lastCall ? "调用 " + rel(c.lastCall.at) : "从未调用"}</span></div></div>${moreBtn("client", c.clientId)}</div>`);
  return pageBar("OAuth 客户端", "", CLIENTS.length) + `<div class="content scroll"><div class="page">
  <p class="lede">客户端通过动态注册（DCR）自动出现。连接域名来自实际授权与调用，不从回调地址推测。</p>
  <div class="toolbar">${searchBox("搜索客户端名称或回调地址", S.q.clients, "clients")}</div>
  ${table([["客户端", "24%"], ["已授权账户", "22%"], ["连接域名", "18%"], ["最后调用", "16%"], ["回调地址", "20%"], ["", "", "act"]], rows, emptyState("app", "没有匹配的客户端", "换个关键词试试"))}${mcards(cards)}
  </div></div>`;
}

// ---------------------------------------------------------------- tokens (#459 #463)
function renderTokens() {
  const f = S.tokenFilter, order = S.tokenOrder;
  const grants = {};
  for (const t of TOKENS) (grants[t.grant] ??= []).push(t);
  let gl = Object.values(grants).map((ts) => ({ ts, acc: ts.find((t) => t.type === "access"), ref: ts.find((t) => t.type === "refresh") }));
  const gst = (g) => g.ref.status;
  const counts = { all: gl.length, active: 0, rotated: 0, revoked: 0 };
  gl.forEach((g) => counts[gst(g)]++);
  if (f !== "all") gl = gl.filter((g) => gst(g) === f);
  gl.sort((a, b) => (order === "asc" ? 1 : -1) * (new Date(a.ref.createdAt) - new Date(b.ref.createdAt)));
  const rows = gl.map((g) => {
    const t = g.ref, c = client(t.clientId), a = acct(t.userId);
    return `<tr class="${t.status === "active" ? "" : "dim"}">
    <td><div class="nm"><b>${esc(clientName(c))}</b><span class="sub2">${esc(acctName(a))}</span></div></td>
    <td><div class="nm"><span class="cellt">访问 ${idc(g.acc.id)} ${g.acc.status === "active" ? "" : `<span class="muted">${TOKEN_ST[g.acc.status][0]}</span>`}</span><span class="cellt">刷新 ${idc(t.id)}</span></div></td>
    <td><div class="tags">${scopeTags(t.scopes)}${vaultTags(t.vaults)}</div></td>
    <td class="cellt">${t.lastUsed ? rel(t.lastUsed.at) + ` <span class="muted mono">${t.lastUsed.ip}</span>` : `<span class="muted">未使用</span>`}<div class="muted" title="${fmtFull(t.createdAt)}">签发 ${fmt(t.createdAt)}</div></td>
    <td>${stTag(t.status)}</td>
    <td class="act">${t.status === "active" ? moreBtn("token", t.grant) : ""}</td></tr>`;
  });
  const cards = gl.map((g) => { const t = g.ref; return `<div class="mc"><div class="b"><div class="nm"><b>${esc(clientName(client(t.clientId)))}</b><span class="sub2">${esc(acctName(acct(t.userId)))} · ${idc(t.id)}</span></div><div class="meta">${stTag(t.status)}<span>签发 ${rel(t.createdAt)}</span></div></div>${t.status === "active" ? moreBtn("token", t.grant) : ""}</div>`; });
  const seg = [["all", "全部"], ["active", "有效"], ["rotated", "已轮换"], ["revoked", "已撤销"]].map(([k, l]) => `<button class="${f === k ? "on" : ""}" data-tokf="${k}">${l}<span class="n">${counts[k]}</span></button>`).join("");
  return pageBar("OAuth Token", `<button class="btn" data-act="token-cleanup">${ic("trash")}<span class="hide-m">清理历史记录…</span></button>`, gl.length) + `<div class="content scroll"><div class="page">
  <p class="lede">一次授权（grant）包含访问 Token 与刷新 Token，按授权合并为一行。绑定域名：<span class="mono">obsidian.example.com</span>（来自 Token 的 resource）。</p>
  <div class="toolbar"><div class="seg">${seg}</div><span class="grow"></span><select class="sel sm" data-act="tok-order" aria-label="排序"><option value="desc" ${order === "desc" ? "selected" : ""}>签发时间：从新到旧</option><option value="asc" ${order === "asc" ? "selected" : ""}>签发时间：从旧到新</option></select></div>
  ${table([["客户端 · 账户", "22%"], ["Token（短 ID）", "22%"], ["权限 · Vault", "22%"], ["最后使用 · 签发", "18%"], ["状态", "10%"], ["", "", "act"]], rows, emptyState("ticket", "没有该状态的 Token", "切换上方筛选查看其他记录"))}${mcards(cards)}
  </div></div>`;
}

// ---------------------------------------------------------------- publish
function renderPublish() {
  const rows = PUBLISHES.map((p) => `<tr class="${p.status === "active" ? "" : "dim"}">
    <td><div class="nm"><b>${esc(p.title)}</b><span class="sub2"><span class="tag acc">${esc(p.vault)}</span><span class="mono ell" title="${esc(p.path)}">${esc(p.path)}</span></span></div></td>
    <td>${p.status === "active" ? `<span class="st ok"><span class="dot"></span>公开中</span>` : `<span class="st amber" title="orphaned：源笔记已不存在"><span class="dot"></span>已失效 · 源笔记不存在</span>`}</td>
    <td class="cellt"><span class="mono">/publish/${esc(p.id.slice(0, 6))}…</span> <button class="ibtn" style="display:inline-grid;vertical-align:middle" data-copy="https://obsidian.example.com/publish/${p.id}" title="复制公开链接">${ic("link")}</button></td>
    <td class="cellt">${esc(p.by.name)}${p.by.user ? ` <span class="muted">· ${esc(p.by.user)}</span>` : ""}<div class="muted">${p.by.kind === "key" ? "API Key" : "OAuth 客户端"}</div></td>
    <td class="cellt">${rel(p.at)}<div class="muted futonly">${p.views} 次访问 ${fut("访问统计")}</div></td>
    <td class="act">${moreBtn("publish", p.id)}</td></tr>`);
  const cards = PUBLISHES.map((p) => `<div class="mc"><div class="b"><div class="nm"><b>${esc(p.title)}</b><span class="sub2">${esc(p.vault)} · ${esc(p.path)}</span></div><div class="meta">${p.status === "active" ? `<span class="st ok"><span class="dot"></span>公开中</span>` : `<span class="st amber"><span class="dot"></span>已失效</span>`}<span>${esc(p.by.name)}</span><span>${rel(p.at)}</span></div></div>${moreBtn("publish", p.id)}</div>`);
  const retired = PUBLISHES.filter((p) => p.status !== "active").length;
  return pageBar("发布文档", "", PUBLISHES.length) + `<div class="content scroll"><div class="page">
  <p class="lede">跨 Vault 统一管理匿名公开链接。仅展示元数据，不读取或渲染正文；只有「公开中」的文档可被匿名访问。</p>
  ${retired ? `<div class="banner amber">${ic("alert")}<div><b>${retired} 条记录已失效</b>：源笔记被删除或不再是 Markdown，链接已无法访问。撤销即可清理记录。</div></div>` : ""}
  ${table([["文档", "30%"], ["状态", "18%"], ["公开链接", "16%"], ["发布者", "16%"], ["发布时间", "14%"], ["", "", "act"]], rows, emptyState("globe", "还没有公开的文档", "在 Web 端或通过 MCP 发布笔记后会出现在这里"))}${mcards(cards)}
  </div></div>`;
}

// ---------------------------------------------------------------- audit (#458 #285)
function auditFiltered() {
  const f = S.audit;
  return AUDIT.filter((a) => {
    if (f.outcome === "success" && !a.ok) return false;
    if (f.outcome === "failure" && a.ok) return false;
    if (f.action && !(a.action.startsWith(f.action) || (ACTIONS[a.action]?.[1] ?? "") === f.action)) return false;
    if (f.credential && a.cred.kind !== f.credential) return false;
    if (f.origin && !a.origin.includes(f.origin)) return false;
    if (f.source && !(a.src || "").includes(f.source)) return false;
    if (f.q) { const q = f.q.toLowerCase(); if (!((a.tool || "") + " " + (a.ua || "") + " " + (ACTIONS[a.action]?.[0] ?? "") + " " + credLabel(a)).toLowerCase().includes(q)) return false; }
    return true;
  });
}
function renderAudit() {
  const f = S.audit, list = auditFiltered(), ps = f.pageSize, pages = Math.max(1, Math.ceil(list.length / ps));
  const pg = Math.min(f.page, pages), slice = list.slice((pg - 1) * ps, pg * ps);
  const failN = list.filter((a) => !a.ok).length;
  const rows = [];
  for (const a of slice) {
    const [al, cat] = ACTIONS[a.action] ?? [a.action, ""];
    rows.push(`<tr class="click ${a.ok ? "" : "fail"} ${S.focus === a.id ? "cur" : ""}" data-ua="${a.id}">
    <td class="cellt num" title="${fmtFull(a.at)}">${fmt(a.at)}</td>
    <td>${a.ok ? `<span class="st ok"><span class="dot"></span>成功</span>` : `<span class="st danger"><span class="dot"></span>失败</span>`}</td>
    <td><div class="nm"><span class="ell" title="${esc(a.action)}">${esc(al)}</span><span class="sub2">${esc(cat)}${a.tool ? ` · <span class="mono ell">${esc(a.tool)}</span>` : ""}</span></div></td>
    <td><div class="nm"><span class="ell">${esc(credLabel(a))}</span><span class="sub2">${esc(CRED_KIND[a.cred.kind])}</span></div></td>
    <td><div class="nm"><span class="ell">${esc(a.agent || "—")}</span><span class="sub2">${a.agent ? (a.cred.kind === "api-key" ? "由 UA 推测" : "客户端自报") : ""}</span></div></td>
    <td class="cellt"><span class="mono">${esc(a.src || "—")}</span><div class="muted">${a.src === "127.0.0.1" ? "本机直连" : a.src?.startsWith("192.168") || a.src?.startsWith("10.") ? "内网" : "公网"}</div></td>
    <td class="act"><span class="ibtn">${ic("chev", S.uaOpen.has(a.id) ? "open" : "")}</span></td></tr>`);
    if (S.uaOpen.has(a.id)) rows.push(`<tr class="${a.ok ? "" : "fail"}"><td colspan="7" style="padding:0"><div class="uax">${a.reason ? `<div style="color:var(--danger);font-family:var(--font)">失败原因：${esc(a.reason)}</div>` : ""}${a.detail ? `<div style="color:var(--tx);font-family:var(--font)">${esc(a.detail)}</div>` : ""}动作键 ${esc(a.action)} · 域名 ${esc(a.origin)} · 凭据 ${esc(a.cred.kind)}<br>User-Agent：${esc(a.ua)}<div class="futonly" style="font-family:var(--font);margin-top:6px">${fut("#285")} <span class="tx2">转发链：</span><span class="mono">${esc(a.src)} ← 反代 172.18.0.1（受信）</span> · Agent 来源：${a.cred.kind === "api-key" ? "Key 绑定的 Agent 名" : "clientInfo"}</div></div></td></tr>`);
  }
  const cards = slice.map((a) => `<div class="mc ${a.ok ? "" : "fail"}"><div class="b"><div class="nm"><b>${esc(ACTIONS[a.action]?.[0] ?? a.action)}</b><span class="sub2">${esc(credLabel(a))}</span></div><div class="meta">${a.ok ? `<span class="st ok"><span class="dot"></span>成功</span>` : `<span class="st danger"><span class="dot"></span>失败</span>`}<span>${fmt(a.at)}</span><span class="mono">${esc(a.src)}</span>${a.tool ? `<span class="mono">${esc(a.tool)}</span>` : ""}</div>${a.reason ? `<span class="help" style="color:var(--danger)">${esc(a.reason)}</span>` : ""}</div></div>`);
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
  const nonDefault = f.action || f.credential || f.origin || f.source || f.q;
  const filters = `<div class="toolbar">
    <div class="seg">${[["", "全部"], ["success", "成功"], ["failure", "失败"]].map(([k, l]) => `<button class="${f.outcome === k ? "on" : ""}" data-auf="${k}">${l}</button>`).join("")}</div>
    <select class="sel sm" data-af="action" aria-label="动作">${opt("", "所有动作", f.action)}${opt("MCP", "MCP 调用", f.action)}${opt("OAuth", "OAuth 授权", f.action)}${opt("Web", "Web", f.action)}${opt("管理", "管理操作", f.action)}${opt("admin.login", "管理员登录", f.action)}</select>
    <select class="sel sm" data-af="credential" aria-label="凭据类型">${opt("", "所有凭据", f.credential)}${Object.entries(CRED_KIND).map(([k, l]) => opt(k, l, f.credential)).join("")}</select>
    <input class="inp sm hide-m" data-af="origin" placeholder="域名" value="${esc(f.origin)}" style="width:150px">
    <input class="inp sm hide-m" data-af="source" placeholder="来源 IP" value="${esc(f.source)}" style="width:120px">
    ${searchBox("搜索调用、工具、User-Agent", f.q, "audit")}
    ${nonDefault || f.outcome ? `<button class="btn ghost sm" data-act="audit-reset">重置</button>` : ""}</div>`;
  const pager = `<div class="pager"><span>共 ${list.length} 条${failN ? ` · <span style="color:var(--danger)">${failN} 条失败</span>` : ""}</span><span class="grow"></span><label>每页 <select class="sel sm" data-act="pagesize">${[25, 50, 100].map((n) => `<option ${n === ps ? "selected" : ""}>${n}</option>`).join("")}</select></label><div class="pg"><button data-pg="${pg - 1}" ${pg === 1 ? "disabled" : ""}>‹</button>${Array.from({ length: pages }, (_, i) => `<button class="${i + 1 === pg ? "on" : ""}" data-pg="${i + 1}">${i + 1}</button>`).join("")}<button data-pg="${pg + 1}" ${pg === pages ? "disabled" : ""}>›</button></div></div>`;
  return pageBar("审计", `<button class="btn ghost sm futonly" data-act="audit-export">${ic("file")}<span class="hide-m">导出 CSV</span> ${fut("设想")}</button>${moreBtn("audit", "")}`, "") + `<div class="content scroll"><div class="page wide">
  ${filters}
  ${table([["时间", "92px"], ["结果", "76px"], ["动作", "22%"], ["凭据", "22%"], ["Agent", "15%"], ["来源", "13%"], ["", "", "act"]], rows, emptyState("filter", "没有匹配的审计记录", "调整或重置筛选条件", `<button class="btn" data-act="audit-reset">重置筛选</button>`))}${mcards(cards)}
  ${list.length ? pager : ""}
  </div></div>`;
}

// ---------------------------------------------------------------- authz list (#405 #434 #455)
function renderAuthz() {
  const orphans = [...new Set(POLICIES.flatMap((p) => p.subjects))].filter((s) => subjectView(s).missing);
  const rows = POLICIES.map((p) => {
    const w = windowSummary(p), now = inWindow(p);
    return `<tr class="click ${p.enabled ? "" : "dim"}" data-open="policy" data-id="${p.id}">
    <td><div class="nm"><b>${esc(p.label)}</b><span class="sub2">${idc(p.id)}<span>· 修改于 ${rel(p.updatedAt)}</span></span></div></td>
    <td>${p.enabled ? `<span class="st ok"><span class="dot"></span>启用</span>` : `<span class="st off"><span class="dot"></span>停用</span>`}<div class="muted" style="font-size:13px" title="${p.mode}">窗口外${MODE[p.mode].n}</div></td>
    <td><div class="nm" style="gap:2px">${p.subjects.map((s) => { const v = subjectView(s); return `<span class="ell" title="${esc(s)}"><span class="${v.missing ? "muted" : ""}">${esc(v.name)}</span> <span class="muted">${esc(v.kindLabel)}</span>${v.missing ? ` <span class="tag danger">孤立</span>` : ""}</span>`; }).join("")}</div></td>
    <td><div class="tags">${capTags(p.capabilities)}</div></td>
    <td><div class="nm"><span class="ell">${esc(w.text)}</span><span class="sub2">${w.marks.map((m) => `<span class="tag">${esc(m)}</span>`).join("")}${p.enabled ? `<span class="${now.ok ? "" : ""}" style="color:${now.ok ? "var(--ok)" : "var(--amber)"}">${now.ok ? "现在允许" : "现在受限"}</span>` : ""}</span></div></td>
    <td class="act">${moreBtn("policy", p.id)}</td></tr>`;
  });
  const cards = POLICIES.map((p) => `<div class="mc" data-open="policy" data-id="${p.id}"><div class="b"><div class="nm"><b>${esc(p.label)}</b><span class="sub2">${p.enabled ? "启用" : "停用"} · 窗口外${MODE[p.mode].n}</span></div><span class="tx2" style="font-size:13px">${esc(windowSummary(p).text)}</span><div class="meta">${p.subjects.map((s) => `<span>${esc(subjectView(s).name)}</span>`).join("")}</div></div>${moreBtn("policy", p.id)}</div>`);
  const broken = S.broken === "authz";
  return pageBar("定时授权", `<button class="btn primary" data-act="new-policy" ${broken ? "disabled" : ""}>${ic("plus")}<span class="hide-m">新建策略</span></button>`, POLICIES.length) + `<div class="content scroll"><div class="page wide">
  <div class="banner ${AUTHZ.enabled ? "acc" : ""}">${ic("shield")}<div style="flex:1">定时授权只会在既有权限基础上<b>再加限制</b>，不会放大权限；管理后台本身不受策略约束。时间窗口表示「允许访问的时间」，不代表永久有效。<details style="margin-top:4px"><summary class="muted" style="cursor:pointer">技术细节</summary><span class="muted">策略修订号 <span class="mono">${AUTHZ.revision}</span>；保存时携带修订号，若他人已修改将提示冲突而不覆盖。suspend = 暂停（保留会话）；revoke = 撤销（作用于该主体全部授权）。</span></details></div>
  <div class="futonly bm" style="display:flex;align-items:center;gap:8px;white-space:nowrap"><span class="muted" style="font-size:13px">总开关</span><button class="switch ${AUTHZ.enabled ? "on" : ""}" data-act="authz-master" aria-label="AuthZ 总开关"></button>${fut("Stage 5")}</div></div>
  ${broken ? `<div class="banner danger">${ic("alert")}<div style="flex:1"><b>策略存储不可用</b>：策略文件无法解析（第 14 行 JSON 语法错误），所有策略暂不生效，编辑已禁用。<div style="margin-top:8px"><textarea class="inp mono" rows="5" style="height:auto;padding:8px" placeholder="粘贴修复用的策略文档（JSON）"></textarea></div><div style="margin-top:8px;display:flex;gap:8px"><button class="btn danger" data-act="authz-repair">用此文档覆盖修复…</button><span class="help" style="align-self:center">覆盖前会备份当前损坏文件</span></div></div></div>` : ""}
  ${orphans.length ? `<div class="banner amber">${ic("alert")}<div><b>${orphans.length} 个孤立主体</b>：策略引用了已删除的凭据（${orphans.map((s) => `<span class="mono">${esc(subjectView(s).shortId)}</span>`).join("、")}）。它们不会再匹配任何请求，建议编辑策略移除。</div></div>` : ""}
  ${table([["策略", "22%"], ["状态 · 模式", "12%"], ["主体", "22%"], ["限制的能力", "16%"], ["允许时间窗口", "24%"], ["", "", "act"]], rows, emptyState("cal", "还没有定时授权策略", "为某个 Key、客户端或账户设置可访问的时间段", `<button class="btn primary" data-act="new-policy">${ic("plus")}新建策略</button>`))}${mcards(cards)}
  <div class="sect" id="preview"><div class="sect-h"><h2>当前状态预览</h2><span class="muted">查看某个主体此刻是否被策略限制</span></div>
  <div class="card" style="padding:16px"><div style="display:flex;gap:8px;flex-wrap:wrap"><select class="sel" data-act="preview-subject" style="max-width:420px"><option value="">请选择主体…</option>${allSubjects().map((s) => { const v = subjectView(s); return `<option value="${esc(s)}" ${S.previewSubj === s ? "selected" : ""}>${esc(v.name)} · ${esc(v.kindLabel)} · ${esc(v.shortId)}</option>`; }).join("")}</select></div>${S.previewSubj ? previewFor(S.previewSubj) : `<p class="help" style="margin:8px 0 0">选择主体后显示命中的策略及此刻的判定。</p>`}</div></div>
  </div></div>`;
}
function allSubjects() {
  return [...KEYS.map((k) => "api-key:" + k.id), ...CLIENTS.map((c) => "oauth-client:" + c.clientId), ...ACCOUNTS.map((a) => "oauth-user:" + a.id)];
}
function previewFor(s, draft) {
  const ps = (draft ? [draft, ...POLICIES.filter((p) => p.id !== draft.id)] : POLICIES).filter((p) => p.enabled && p.subjects.includes(s));
  if (!ps.length) return `<div class="verdict ok">${ic("checkc")}<span><b>不受定时授权限制</b> · 没有启用的策略引用该主体，按其原有权限访问</span></div>`;
  return ps.map((p) => { const r = inWindow(p); return `<div class="verdict ${r.ok ? "ok" : "no"}">${ic(r.ok ? "checkc" : "ban")}<span><b>${esc(p.label)}</b>${p === draft ? " <span class='tag acc'>编辑中</span>" : ""} · ${r.ok ? "此刻允许" : `此刻${MODE[p.mode].n}`}（${esc(r.why)}）· 影响：${esc(p.capabilities.map(capName).join("、"))}</span></div>`; }).join("");
}

// ---------------------------------------------------------------- policy editor (#455 #406 #434)
function renderPolicyEditor() {
  const d = S.draft, isNew = !d.id;
  const subjSel = d.subjects.map((s) => { const v = subjectView(s); return `<span class="pill" title="${esc(s)}"><span class="kind">${esc(v.kindLabel)}</span>${esc(v.name)} <span class="mono muted">${esc(v.shortId)}</span><button data-unsubj="${esc(s)}" aria-label="移除">${ic("x", "xs")}</button></span>`; }).join("");
  const sq = (S.subjQ || "").toLowerCase();
  const groups = ["api-key", "oauth-client", "oauth-user"].map((kind) => {
    const items = allSubjects().filter((s) => s.startsWith(kind + ":")).map(subjectView).filter((v) => !sq || (v.name + v.sub + v.id).toLowerCase().includes(sq));
    if (!items.length) return "";
    return `<div class="pick-g"><span>${KIND_LABEL[kind]}</span><span>${items.length}</span></div>` + items.map((v) => `<label class="pick"><input type="checkbox" data-subj="${esc(v.s)}" ${d.subjects.includes(v.s) ? "checked" : ""}><div class="nm"><b style="${v.unnamed ? "font-style:italic;font-weight:400" : ""}">${esc(v.name)}</b><span class="sub2">${v.sub ? esc(v.sub) + " · " : ""}<span class="mono">${esc(v.shortId)}</span></span></div><span class="kind">${esc(v.kindLabel)}</span></label>`).join("");
  }).join("");
  const orphanSel = d.subjects.filter((s) => subjectView(s).missing);
  const cq = (S.capQ || "").toLowerCase(), rv = d.mode === "revoke";
  const capHtml = CAPS.map((g) => {
    const items = g.items.filter((it) => !cq || (it.k + it.n + (it.d || "")).toLowerCase().includes(cq));
    if (!items.length) return "";
    const selN = g.items.filter((it) => d.capabilities.includes(it.k)).length;
    const open = cq || S.capOpen.has(g.g);
    return `<div class="cap-g"><button type="button" class="cap-h ${open ? "open" : ""}" data-capg="${g.g}">${ic("chev", "chev")}<b>${g.name}</b><span class="mono" style="color:var(--tx4)">${g.g}</span><span class="grow"></span>${selN ? `<span class="tag acc">已选 ${selN}</span>` : ""}<span>${g.items.length} 项</span></button>${open ? `<div class="cap-b">${items.map((it) => `<label class="chk"><input type="checkbox" data-cap="${it.k}" ${d.capabilities.includes(it.k) ? "checked" : ""} ${rv && it.k !== "all" ? "disabled" : ""}><span>${esc(it.n)} <span class="mono">${esc(it.k)}</span>${it.d ? `<span class="d">${esc(it.d)}</span>` : ""}</span></label>`).join("")}</div>` : ""}</div>`;
  }).join("");
  const weekly = [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const ws = d.weekly.filter((w) => w.day === day);
    return { day, ws };
  });
  const onDays = new Set(d.weekly.map((w) => w.day));
  const wrows = weekly.filter((x) => x.ws.length).map(({ day, ws }) => ws.map((w, i) => `<div class="wrow"><span class="lab">${i === 0 ? DAYS[day] : ""}</span><input class="inp" type="time" value="${w.from}" data-wf="${day}:${i}:from"><span class="muted" style="text-align:center">–</span><input class="inp" type="time" value="${w.to}" data-wf="${day}:${i}:to"><button type="button" class="ibtn" data-wdel="${day}:${i}" aria-label="删除时段">${ic("x")}</button></div>`).join("")).join("");
  const crossBad = d.weekly.some((w) => w.to <= w.from);
  const drows = d.dateRanges.map((r, i) => `<div class="drow"><input class="inp" type="date" value="${r.from}" data-df="${i}:from"><span class="muted" style="text-align:center">–</span><input class="inp" type="date" value="${r.to}" data-df="${i}:to"><button type="button" class="ibtn" data-ddel="${i}" aria-label="删除日期区间">${ic("x")}</button></div>`).join("");
  const utc = (v) => { if (!v) return "未设置"; const t = new Date(v + ":00+08:00"); return isNaN(t) ? "格式无效" : t.toISOString().replace(".000", ""); };
  const w = windowSummary(d), now = inWindow(d);
  const conflict = S.conflict;
  return pageBar(`<a class="crumbp" href="#/authz">定时授权</a><span class="muted">›</span><span>${isNew ? "新建策略" : esc(d.label || "未命名策略")}</span>`, isNew ? "" : `<span class="hide-m">${idc(d.id)}</span>`) + `<div class="content scroll"><div class="ped">
  <form class="ped-form" data-form="policy" onsubmit="return false">
  ${conflict ? `<div class="banner danger">${ic("alert")}<div><b>保存冲突</b>：其他管理员在你编辑期间修改了策略（修订 ${AUTHZ.revision} → ${AUTHZ.revision + 1}）。你的改动尚未保存。<div style="margin-top:8px;display:flex;gap:8px"><button type="button" class="btn sm" data-act="conflict-reload">载入最新版本</button><button type="button" class="btn ghost sm" data-act="conflict-diff">查看差异</button></div></div></div>` : ""}
  <fieldset class="fs"><legend>基本信息</legend>
    <div class="grid2"><div class="fld"><label>策略名称</label><input class="inp" data-dv="label" value="${esc(d.label)}" placeholder="例如：研究机器人仅工作时间" maxlength="120"></div>
    <div class="fld"><label>状态</label><div style="display:flex;align-items:center;gap:8px;height:32px"><button type="button" class="switch ${d.enabled ? "on" : ""}" data-act="d-enabled" aria-label="启用"></button><span class="tx2" style="font-size:13px">${d.enabled ? "保存后立即生效" : "保存但不生效"}</span></div></div></div>
    <div class="fld" style="margin-top:12px"><span class="l">窗口外的处理方式</span><div class="mode">${["suspend", "revoke"].map((m) => `<button type="button" class="${d.mode === m ? "on" : ""} ${m === "revoke" ? "rv" : ""}" data-mode="${m}"><b><span class="radio"></span>${MODE[m].n} <span class="mono" style="color:var(--tx4);font-weight:400">${m}</span></b><span>${MODE[m].d}</span></button>`).join("")}</div></div>
  </fieldset>
  <fieldset class="fs"><legend>主体 <span class="muted">策略作用于哪些凭据 · 已选 ${d.subjects.length}</span></legend>
    ${d.subjects.length ? `<div class="selrow">${subjSel}</div>` : `<p class="help" style="margin:0 0 8px">尚未选择主体</p>`}
    ${orphanSel.length ? `<p class="help warn" style="margin:0 0 8px">${ic("alert", "xs")} 含 ${orphanSel.length} 个已删除的主体，建议移除</p>` : ""}
    <div class="picker"><label class="search">${ic("search")}<input data-subjq placeholder="按名称、账户或 ID 搜索" value="${esc(S.subjQ || "")}"></label><div class="pick-list scroll">${groups || `<div class="empty" style="padding:24px">没有匹配的主体</div>`}</div></div>
  </fieldset>
  <fieldset class="fs"><legend>限制的能力 <span class="muted">窗口外这些能力不可用</span></legend>
    ${rv ? `<div class="banner amber">${ic("info")}<div>「撤销」模式只能作用于<b>全部能力</b>，已自动锁定为「全部」。</div></div>` : ""}
    <div class="picker"><label class="search">${ic("search")}<input data-capq placeholder="搜索能力，例如 写入、git、write_note" value="${esc(S.capQ || "")}"></label>${capHtml || `<div class="empty" style="padding:24px">没有匹配的能力</div>`}</div>
    ${d.capabilities.length ? `<div class="selrow" style="margin-top:8px">${d.capabilities.map((k) => `<span class="pill">${esc(capName(k))} <span class="mono muted">${esc(k)}</span>${rv ? "" : `<button type="button" data-uncap="${esc(k)}">${ic("x", "xs")}</button>`}</span>`).join("")}</div>` : ""}
  </fieldset>
  <fieldset class="fs"><legend>允许访问的时间</legend>
    <div class="grid2"><div class="fld"><label>时区</label><select class="sel" data-dv="timezone">${TIMEZONES.map((z) => `<option ${z === d.timezone ? "selected" : ""}>${z}</option>`).join("")}<option>其他（IANA 名称）…</option></select><span class="help">下方所有时间都按此时区解释</span></div><div></div>
    <div class="fld"><label>生效起点 <small>startsAt</small></label><input class="inp" type="datetime-local" data-dv="startsAt" value="${d.startsAt}"><span class="help">${d.startsAt ? `存储为 <span class="mono">${utc(d.startsAt)}</span>` : "未设置 · 立即生效"}</span></div>
    <div class="fld"><label>失效终点 <small>expiresAt</small></label><input class="inp" type="datetime-local" data-dv="expiresAt" value="${d.expiresAt}"><span class="help">${d.expiresAt ? `存储为 <span class="mono">${utc(d.expiresAt)}</span>` : "未设置 · 长期有效"}</span></div></div>
    <div class="fld" style="margin-top:20px"><span class="l">每周窗口 <span class="muted">不选择 = 每天全天</span></span>
      <div class="chips">${[1, 2, 3, 4, 5, 6, 0].map((day) => `<button type="button" class="chip ${onDays.has(day) ? "on" : ""}" data-day="${day}">${DAYS[day]}</button>`).join("")}<span style="width:8px"></span><button type="button" class="btn ghost sm" data-preset="work">工作日 9–18</button><button type="button" class="btn ghost sm" data-preset="all">每天</button><button type="button" class="btn ghost sm" data-preset="clear">清空</button></div>
      ${wrows}
      ${onDays.size ? `<button type="button" class="addl" data-act="add-slot">${ic("plus", "xs")}为已选日期再加一个时段</button>` : ""}
      ${crossBad ? `<span class="help warn">${ic("alert", "xs")} 结束时间需晚于开始时间；跨午夜请拆成两段（如 22:00–24:00 和次日 00:00–06:00）</span>` : `<span class="help">不支持跨午夜，跨午夜请拆成两段</span>`}
    </div>
    <div class="fld" style="margin-top:20px"><span class="l">限定日期 <span class="muted">不添加 = 不限日期</span></span>${drows}<button type="button" class="addl" data-act="add-range">${ic("plus", "xs")}添加日期区间</button></div>
  </fieldset>
  </form>
  <aside class="ped-side"><div class="stick">
    <div class="sect-h"><h2>生效预览</h2><span class="muted">${esc(d.timezone)}</span></div>
    <div class="sumbox"><b>${esc(w.text)}</b>${w.marks.length ? `<div>${w.marks.map((m) => `<span class="tag" style="margin:4px 4px 0 0">${esc(m)}</span>`).join("")}</div>` : ""}<div style="margin-top:4px">窗口外：<b>${MODE[d.mode].n}</b> ${esc(d.capabilities.length ? d.capabilities.map(capName).join("、") : "（未选择能力）")}</div></div>
    <div style="margin-top:16px">${timeline(d)}</div>
    <div class="verdict ${now.ok ? "ok" : "no"}" style="margin-top:12px">${ic(now.ok ? "checkc" : "ban")}<span>现在（${fmt(NOW.toISOString())}）<b>${now.ok ? "允许访问" : MODE[d.mode].n}</b> · ${esc(now.why)}</span></div>
    <div class="sect-h" style="margin-top:24px"><h2>对主体的影响</h2></div>
    ${d.subjects.length ? d.subjects.map((s) => `<div style="margin-top:8px"><div style="font-size:13px;color:var(--tx2)">${esc(subjectView(s).name)} <span class="muted">${esc(subjectView(s).kindLabel)}</span></div>${previewFor(s, d)}</div>`).join("") : `<p class="help">选择主体后显示</p>`}
  </div></aside>
  </div>
  <div class="ped-foot"><button class="btn primary" data-act="save-policy">${isNew ? "创建策略" : "保存策略"}</button><a class="btn ghost" href="#/authz">取消</a><span class="grow"></span>${isNew ? "" : `<button class="btn danger-o" data-act="del-policy">${ic("trash")}<span class="hide-m">删除策略</span></button>`}<span class="help hide-m" style="margin-left:8px"><kbd>⌘</kbd> <kbd>↵</kbd> 保存</span></div>
  </div>`;
}

// ---------------------------------------------------------------- vault & git (#461 #401 #402 #404 #437)
function renderVaults() {
  const rows = VAULTS.map((v) => `<tr class="click ${S.cur === v.id ? "cur" : ""}" data-open="vault" data-id="${v.id}">
    <td><div class="nm"><b>${esc(v.label)}</b><span class="sub2"><span class="mono">${esc(v.id)}</span>${v.primary ? `<span class="kind">主库</span>` : ""}</span></div></td>
    <td>${gitState(v)}</td>
    <td class="cellt">${v.git.enabled ? `${v.git.autoCommit ? "自动提交" : "手动提交"} · ${v.git.autoPush ? "自动推送" : "不推送"}${v.git.autoCommitSweep ? ` · 每 ${v.git.sweepIntervalSeconds / 60} 分钟兜底` : ""}` : `<span class="muted">未启用</span>`}</td>
    <td class="cellt mono">${v.git.enabled ? esc(v.git.remote + "/" + v.git.branch) : "—"}</td>
    <td class="cellt">${Object.values(v.caps).filter(Boolean).length} / ${Object.keys(v.caps).length} 可用</td>
    <td class="act">${moreBtn("vault", v.id)}</td></tr>`);
  const cards = VAULTS.map((v) => `<div class="mc" data-open="vault" data-id="${v.id}"><div class="b"><div class="nm"><b>${esc(v.label)}</b><span class="sub2">${esc(v.id)}${v.primary ? " · 主库" : ""}</span></div><div class="meta">${gitState(v)}</div></div>${moreBtn("vault", v.id)}</div>`);
  const broken = S.broken === "git";
  return pageBar("Vault 与 Git", `<button class="btn" data-act="vault-refresh">${ic("refresh")}<span class="hide-m">刷新 Vault 清单</span></button><button class="btn futonly" data-act="vault-scan">${ic("search")}<span class="hide-m">扫描新 Vault</span> ${fut("#437")}</button>`, VAULTS.length) + `<div class="content scroll"><div class="page">
  <p class="lede">每个 Vault 的 Git 状态与同步设置。目录路径与远端名称只在管理端可见；这里不创建仓库，也不接受含凭据的远端地址。</p>
  ${broken ? `<div class="banner danger">${ic("alert")}<div style="flex:1"><b>Git 配置存储不可用</b>：配置文件损坏，各 Vault 回退为默认设置（不自动提交）。<div style="margin-top:8px"><button class="btn danger" data-act="git-repair">重置为默认并修复…</button></div></div></div>` : ""}
  ${table([["Vault", "20%"], ["Git 状态", "24%"], ["同步方式", "26%"], ["远端 / 分支", "14%"], ["能力", "10%"], ["", "", "act"]], rows, emptyState("db", "没有可用的 Vault", "检查部署配置中的 Vault 列表"))}${mcards(cards)}
  <div class="sect futonly"><div class="futbox" style="display:flex;gap:12px;align-items:center"><div class="grow"><b style="font-weight:600">从 GitHub 仓库添加 Vault</b> ${fut("Architecture TODO")}<div class="help">以远端仓库为存储后端的 Vault（GitHub-backed Vault），只读克隆或双向同步。</div></div><button class="btn" disabled>添加…</button></div></div>
  </div></div>`;
}
</script>
