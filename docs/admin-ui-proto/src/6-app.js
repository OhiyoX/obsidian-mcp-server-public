<script>
"use strict";
// ---------------------------------------------------------------- state & storage
const storageKey = (n) => "omcp-admin." + n;
const params = new URLSearchParams(location.search);
const DEV = params.get("dev") === "1";
const devp = (k) => (DEV ? params.get(k) : null);
const S = {
  route: "overview", sub: null, q: {}, cur: null, focus: null,
  tokenFilter: "all", tokenOrder: "desc",
  audit: { outcome: "", action: "", credential: "", origin: "", source: "", q: "", page: 1, pageSize: 25 },
  uaOpen: new Set(), draft: null, subjQ: "", capQ: "", capOpen: new Set(), previewSubj: "",
  flashKey: null, loginLocked: false, loginErr: false, authed: true, broken: null, conflict: false,
};
const NAV = [
  ["overview", "概览", "home", "o"], null, "身份与凭据",
  ["accounts", "OAuth 账户", "user", "a"], ["keys", "API Key", "key", "k"], ["clients", "OAuth 客户端", "app", "c"], ["tokens", "OAuth Token", "ticket", "t"],
  null, "内容与安全", ["publish", "发布文档", "globe", "p"], ["audit", "审计", "list", "u"], ["authz", "定时授权", "cal", "z"],
  null, "系统", ["vaults", "Vault 与 Git", "db", "v"],
];
const isMobile = () => matchMedia("(max-width:720px)").matches;

function setTheme(t) { document.documentElement.dataset.theme = t; $('meta[name="theme-color"]').content = t === "light" ? "#ffffff" : "#101318"; try { localStorage.setItem(storageKey("theme"), t); } catch {} }

// ---------------------------------------------------------------- router
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  S.route = parts[0] || "overview"; S.sub = parts[1] || null;
  const qp = new URLSearchParams(qs || "");
  if (S.route === "audit") {
    for (const k of ["outcome", "action", "credential", "origin", "source", "q"]) if (qp.has(k)) S.audit[k] = qp.get(k);
    if (qp.has("focus")) S.focus = qp.get("focus");
  }
  if (S.route === "authz" && S.sub) {
    if (!S.draft || S.draft._for !== S.sub) {
      const p = S.sub === "new" ? null : POLICIES.find((x) => x.id === S.sub);
      S.draft = p ? { ...structuredClone(p), _for: S.sub } : { id: null, _for: "new", label: "", mode: "suspend", enabled: true, timezone: "Asia/Shanghai", startsAt: "", expiresAt: "", weekly: [], dateRanges: [], subjects: [], capabilities: [] };
      S.capOpen = new Set(CAPS.filter((g) => g.items.some((it) => S.draft.capabilities.includes(it.k))).map((g) => g.g));
      if (!S.capOpen.size) S.capOpen.add("scope");
      S.subjQ = ""; S.capQ = "";
    }
  }
}
function go(hash, replace) { if (replace) history.replaceState(null, "", hash); else history.pushState(null, "", hash); onRoute(); }
function onRoute() {
  parseHash();
  closeMenu();
  if (S.route === "login") { S.authed = false; } else S.authed = true;
  render();
  // detail routes open drawers
  const map = { accounts: "account", keys: "key", clients: "client", vaults: "vault" };
  if (S.sub && map[S.route]) openDrawer(map[S.route], S.sub, true); else closeDrawer(true);
}

// ---------------------------------------------------------------- render
function sidebar() {
  let html = "";
  for (const n of NAV) {
    if (n === null) continue;
    if (typeof n === "string") { html += `<div class="sec-h">${n}</div>`; continue; }
    const [k, l, icn, key] = n;
    const cnt = { accounts: ACCOUNTS.length, keys: KEYS.length, clients: CLIENTS.length, tokens: TOKENS.filter((t) => t.status === "active" && t.type === "refresh").length, publish: PUBLISHES.length, authz: POLICIES.length, vaults: VAULTS.length }[k];
    html += `<a class="ni ${S.route === k ? "on" : ""}" href="#/${k}">${ic(icn)}<span class="lbl">${l}</span>${k === "audit" && AUDIT.some((a) => !a.ok && NOW - new Date(a.at) < D) ? `<span class="dot danger" title="24 小时内有失败"></span>` : ""}${k === "clients" && CLIENTS.some((c) => c.transfer) ? `<span class="dot amber" title="有转移待完成"></span>` : ""}<span class="cnt">${cnt ?? ""}</span></a>`;
  }
  return `<aside class="side"><div class="bar brand"><svg class="logo"><use href="#logo"/></svg><b>Obsidian MCP</b><span>授权管理</span></div>
  <nav class="side-body scroll">${html}</nav>
  <div class="side-foot"><a class="ni" href="#/web" onclick="return false" title="进入 Obsidian Web" style="flex:1">${ic("ext")}<span class="lbl">进入 Obsidian Web</span></a>
  <button class="ibtn" data-act="theme" title="切换主题 (T)">${ic(document.documentElement.dataset.theme === "dark" ? "sun" : "moon")}</button><button class="ibtn" data-act="kbd" title="快捷键 (?)">${ic("kbd")}</button><button class="ibtn" data-act="logout" title="退出登录">${ic("out")}</button></div></aside>`;
}
function mnav() {
  const items = [["overview", "概览", "home"], ["tokens", "Token", "ticket"], ["audit", "审计", "list"], ["authz", "定时", "cal"], ["more", "更多", "menu"]];
  const prim = items.slice(0, 4).map((i) => i[0]);
  return `<nav class="mnav">${items.map(([k, l, icn]) => `<a href="${k === "more" ? "#" : "#/" + k}" ${k === "more" ? 'data-act="mmore"' : ""} class="${S.route === k || (k === "more" && !prim.includes(S.route)) ? "on" : ""}">${ic(icn)}${l}</a>`).join("")}</nav>`;
}
function render() {
  const root = $("#root");
  if (!S.authed) { root.innerHTML = renderLogin(); return; }
  let main;
  const r = S.route;
  if (r === "authz" && S.sub) main = renderPolicyEditor();
  else main = ({ overview: renderOverview, accounts: renderAccounts, keys: renderKeys, clients: renderClients, tokens: renderTokens, publish: renderPublish, audit: renderAudit, authz: renderAuthz, vaults: renderVaults }[r] || renderOverview)();
  if (devp("empty") === r) main = pageBar(NAV.find((n) => n && n[0] === r)?.[1] || "") + `<div class="content"><div class="page">${emptyState({ accounts: "user", keys: "key", clients: "app", tokens: "ticket", publish: "globe", audit: "list", authz: "cal" }[r] || "info", "这里还没有内容", "空状态示例（dev 参数 empty）")}</div></div>`;
  const st = $(".content")?.scrollTop;
  root.innerHTML = `<div class="app">${sidebar()}<main class="main">${main}</main></div>${mnav()}`;
  if (st && $(".content")) $(".content").scrollTop = st;
}

// ---------------------------------------------------------------- toast / modal / menu
let toastT;
function toast(msg, opts = {}) {
  const t = $("#toast");
  t.className = "toast on" + (opts.err ? " err" : "");
  t.innerHTML = `${ic(opts.err ? "alert" : "checkc")}<span>${msg}</span>${opts.undo ? `<button data-act="undo">撤销</button>` : ""}`;
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), opts.ms || 3200);
}
let modalOk = null;
function confirmBox({ title, body, list, ok = "确认", danger = true, type, onOk, extra = "" }) {
  const m = $("#modal");
  m.innerHTML = `<h3>${title}</h3>${body ? `<p>${body}</p>` : ""}${list ? `<ul>${list.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}${extra}${type ? `<div class="tc">输入 <code>${esc(type)}</code> 以确认</div><input class="inp" data-typeconf autocomplete="off">` : ""}<div class="acts"><button class="btn ghost" data-act="mcancel">取消</button><button class="btn ${danger ? "danger" : "primary"}" data-act="mok" ${type ? "disabled" : ""}>${ok}</button></div>`;
  m.classList.add("on"); $("#mscrim").classList.add("on");
  modalOk = onOk; m.dataset.type = type || "";
  setTimeout(() => (type ? $("[data-typeconf]", m) : $("[data-act=mok]", m))?.focus(), 30);
}
function closeModal() { $("#modal").classList.remove("on"); $("#mscrim").classList.remove("on"); modalOk = null; }
function showKbd() {
  const row = (k, l) => `<div class="row"><span>${l}</span><span>${k.split(" ").map((x) => `<kbd>${x}</kbd>`).join(" ")}</span></div>`;
  const m = $("#modal"); m.classList.add("kbdp");
  m.innerHTML = `<h3>键盘快捷键</h3><div class="cols"><h4>导航</h4>${NAV.filter(Array.isArray).map((n) => row("g " + n[3], n[1])).join("")}<h4>通用</h4>${row("/", "搜索 / 筛选")}${row("n", "新建（当前页）")}${row("j k", "表格上下移动")}${row("↵", "打开详情")}${row("Esc", "关闭抽屉 / 弹窗")}${row("t", "切换主题")}${row("?", "本面板")}${row("⌘ ↵", "保存策略")}</div><div class="acts"><button class="btn" data-act="mcancel">关闭</button></div>`;
  m.classList.add("on"); $("#mscrim").classList.add("on");
}
let menuCtx = null;
function openMenu(btn, kind, id) {
  const items = menuItems(kind, id);
  const m = $("#menu");
  m.innerHTML = items.map((it) => (it === "-" ? "<hr>" : `<button data-mi="${it[0]}" class="${it[3] ? "dz2" : ""}" ${it[4] ? "disabled" : ""}>${ic(it[2])}<span class="grow">${it[1]}</span>${it[5] || ""}</button>`)).join("");
  m.classList.add("on");
  const r = btn.getBoundingClientRect(), mw = 220;
  m.style.minWidth = mw + "px";
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + "px";
  const h = m.offsetHeight;
  m.style.top = (r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4) + "px";
  menuCtx = { kind, id };
}
function closeMenu() { $("#menu")?.classList.remove("on"); menuCtx = null; }
function menuItems(kind, id) {
  if (kind === "account") { const a = acct(id); return [["open", "查看与编辑", "edit"], ["pw", "重置密码…", "lock"], ["toggle", a.enabled ? "停用账户…" : "启用账户", a.enabled ? "pause" : "play"], "-", ["del", "删除账户…", "trash", 1]]; }
  if (kind === "key") return [["open", "编辑权限与 Vault", "edit"], ["copyid", "复制 Key ID", "copy"], ["rotate", "轮换（重新生成）", "refresh", 0, 1, fut("设想")], "-", ["del", "删除 Key…", "trash", 1]];
  if (kind === "client") { const c = client(id); return [["open", "查看详情", "eye"], ["transfer", "转移授权账户…", "swap", 0, !linkedAccounts(id).length && !c.transfer], c.transfer ? ["canceltr", "取消待完成的转移", "x"] : null, "-", ["revoke", "撤销全部授权…", "ban", 1, !linkedAccounts(id).length], ["del", "删除客户端…", "trash", 1]].filter(Boolean); }
  if (kind === "token") return [["copyid", "复制刷新 Token ID", "copy"], ["toaudit", "查看相关审计", "list"], "-", ["revoke", "撤销此授权…", "ban", 1]];
  if (kind === "publish") return [["copylink", "复制公开链接", "link"], ["openlink", "打开公开页", "ext"], "-", ["revoke", "撤销公开链接…", "ban", 1]];
  if (kind === "policy") { const p = POLICIES.find((x) => x.id === id); return [["edit", "编辑", "edit"], ["toggle", p.enabled ? "停用" : "启用", p.enabled ? "pause" : "play"], ["dup", "复制为新策略", "copy"], "-", ["del", "删除策略…", "trash", 1]]; }
  if (kind === "vault") return [["open", "详情与 Git 设置", "edit"], ["verify", "验证 Git 仓库与配置", "checkc"], "-", ["openweb", "在 Web 中打开", "ext"]];
  if (kind === "audit") return [["clear", "清空审计日志…", "trash", 1]];
  return [];
}
function onMenu(act) {
  const { kind, id } = menuCtx; closeMenu();
  if (act === "open") return go(`#/${{ account: "accounts", key: "keys", client: "clients", vault: "vaults" }[kind]}/${id}`);
  if (kind === "account") {
    const a = acct(id);
    if (act === "pw") return openDrawer("account", id, false, "pw");
    if (act === "toggle") { if (!a.enabled) { a.enabled = true; render(); return toast(`已启用 ${esc(acctName(a))}`); } return confirmBox({ title: `停用「${esc(acctName(a))}」？`, body: `停用后该账户<b>无法登录授权页</b>，并会<b>撤销其全部已有授权</b>（${linkedClients(id).length} 个客户端需要重新授权）。之后可以重新启用。`, ok: "停用账户", onOk: () => { a.enabled = false; render(); toast("账户已停用，已撤销其授权"); } }); }
    if (act === "del") return confirmBox({ title: `删除账户「${esc(acctName(a))}」？`, body: "将永久删除账户并撤销其全部 Token，审计记录中的名称会显示为「已删除 / 未知」。此操作不能撤销。", type: a.username, ok: "永久删除", onOk: () => { ACCOUNTS.splice(ACCOUNTS.indexOf(a), 1); go("#/accounts", true); toast("账户已删除"); } });
  }
  if (kind === "key") {
    const k = keyOf(id);
    if (act === "copyid") return copy(id);
    if (act === "del") return confirmBox({ title: `删除 Key「${esc(keyName(k))}」？`, body: `使用此 Key 的程序将立即无法访问（最后调用：${k.lastUsed ? rel(k.lastUsed.at) + " · " + esc(k.lastUsed.agent) : "从未"}）。引用它的定时授权策略会变成孤立主体。`, type: k.label || k.prefix, ok: "删除 Key", onOk: () => { KEYS.splice(KEYS.indexOf(k), 1); go("#/keys", true); toast("Key 已删除"); } });
  }
  if (kind === "client") {
    const c = client(id);
    if (act === "transfer") return openDrawer("client", id, false, "transfer");
    if (act === "canceltr") { delete c.transfer; render(); return toast("已取消转移；原账户需重新授权才能恢复"); }
    if (act === "revoke") return revokeClient(c);
    if (act === "del") return confirmBox({ title: `删除客户端「${esc(clientName(c))}」？`, body: "将撤销其全部授权并删除注册记录；客户端下次连接时会重新注册为新客户端。", type: c.clientName || "delete", ok: "删除客户端", onOk: () => { CLIENTS.splice(CLIENTS.indexOf(c), 1); go("#/clients", true); toast("客户端已删除"); } });
  }
  if (kind === "token") {
    const ts = TOKENS.filter((t) => t.grant === id), t = ts.find((x) => x.type === "refresh");
    if (act === "copyid") return copy(t.id);
    if (act === "toaudit") return go("#/audit?q=" + encodeURIComponent(clientName(client(t.clientId))));
    if (act === "revoke") return confirmBox({ title: "撤销此授权？", body: `<b>${esc(clientName(client(t.clientId)))}</b> 以 <b>${esc(acctName(acct(t.userId)))}</b> 身份的访问 Token 与刷新 Token 将立即失效，客户端需要重新授权。`, extra: `<label class="chk futonly" style="margin:0 -8px 8px"><input type="checkbox" checked><span>同时断开该客户端的在线 MCP 会话 ${fut("#441")}</span></label>`, ok: "撤销", onOk: () => { ts.forEach((x) => (x.status = "revoked")); render(); toast("授权已撤销"); } });
  }
  if (kind === "publish") {
    const p = PUBLISHES.find((x) => x.id === id), url = "https://obsidian.example.com/publish/" + p.id;
    if (act === "copylink") return copy(url);
    if (act === "openlink") return toast("原型：将在新标签打开 " + esc(url));
    if (act === "revoke") return confirmBox({ title: `撤销「${esc(p.title)}」的公开链接？`, body: "匿名访问者将立即无法打开此链接；笔记本身不受影响。之后重新发布会生成新的链接。", ok: "撤销链接", onOk: () => { PUBLISHES.splice(PUBLISHES.indexOf(p), 1); render(); toast("公开链接已撤销"); } });
  }
  if (kind === "policy") {
    const p = POLICIES.find((x) => x.id === id);
    if (act === "edit") return go("#/authz/" + id);
    if (act === "toggle") { if (p.enabled) return confirmBox({ title: `停用「${esc(p.label)}」？`, body: "停用后该策略不再限制任何主体，相关凭据将按原有权限全天可用。", ok: "停用", danger: false, onOk: () => { p.enabled = false; AUTHZ.revision++; render(); toast("策略已停用"); } }); p.enabled = true; AUTHZ.revision++; render(); return toast("策略已启用"); }
    if (act === "dup") { S.draft = { ...structuredClone(p), id: null, _for: "new", label: p.label + "（副本）" }; return go("#/authz/new"); }
    if (act === "del") return delPolicy(p);
  }
  if (kind === "vault") {
    if (act === "verify") return verifyVault(id);
    if (act === "openweb") return toast("原型：将打开 Obsidian Web 中的 " + esc(id));
  }
  if (kind === "audit" && act === "clear") return confirmBox({ title: "清空全部审计日志？", body: `将永久删除 <b>${AUDIT.length}</b> 条记录（含 ${AUDIT.filter((a) => !a.ok).length} 条失败记录）。清空动作本身会作为第一条新记录保留。`, type: "清空日志", ok: "清空日志", onOk: () => { AUDIT.length = 0; AUDIT.push({ id: "au_new", at: NOW.toISOString(), action: "audit.clear", ok: true, cred: { kind: "admin-session" }, origin: "obsidian.example.com", src: "192.168.1.24", ua: UAS.browser }); render(); toast("审计日志已清空"); } });
}
function delPolicy(p) {
  confirmBox({ title: `删除策略「${esc(p.label)}」？`, body: `相关主体（${p.subjects.map((s) => esc(subjectView(s).name)).join("、")}）将不再受时间限制。`, type: p.label, ok: "删除策略", onOk: () => { POLICIES.splice(POLICIES.indexOf(p), 1); AUTHZ.revision++; S.draft = null; go("#/authz", true); toast("策略已删除"); } });
}
function revokeClient(c) {
  const la = linkedAccounts(c.clientId);
  confirmBox({ title: `撤销「${esc(clientName(c))}」的全部授权？`, body: `${la.map((a) => `<b>${esc(acctName(a))}</b>`).join("、")} 在此客户端上的 Token 将立即失效，需要重新授权。客户端注册保留。`, extra: `<label class="chk futonly" style="margin:0 -8px 8px"><input type="checkbox" checked><span>同时断开在线 MCP 会话 ${fut("#441")}</span></label>`, ok: "撤销授权", onOk: () => { TOKENS.forEach((t) => { if (t.clientId === c.clientId && t.status === "active") t.status = "revoked"; }); render(); refreshDrawer(); toast("已撤销全部授权"); } });
}
function verifyVault(id) {
  const v = VAULTS.find((x) => x.id === id);
  if (v.repo.state === "norepo") return toast(`${esc(id)}：未找到 Git 仓库（目录中没有 .git）`, { err: true, ms: 4200 });
  v.verified = { ok: true, at: NOW.toISOString() }; refreshDrawer(); toast(`${esc(id)}：仓库与配置验证通过`);
}
function copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); toast("已复制 " + `<span class="mono">${esc(text.length > 40 ? text.slice(0, 40) + "…" : text)}</span>`); }

// ---------------------------------------------------------------- drawers
let drawerCtx = null;
function openDrawer(kind, id, fromRoute, mode) {
  drawerCtx = { kind, id, mode: mode || null };
  S.cur = id;
  $("#drawer").innerHTML = drawerHtml();
  $("#drawer").classList.add("on"); $("#dscrim").classList.add("on");
  $$(".tbl tr.cur").forEach((r) => r.classList.remove("cur"));
  $$(`[data-open][data-id="${CSS.escape(id || "")}"]`).forEach((r) => r.classList.add("cur"));
}
function refreshDrawer() { if (drawerCtx && $("#drawer").classList.contains("on")) $("#drawer").innerHTML = drawerHtml(); }
function closeDrawer(silent) {
  if (!$("#drawer").classList.contains("on")) return;
  $("#drawer").classList.remove("on"); $("#dscrim").classList.remove("on"); drawerCtx = null; S.cur = null;
  $$(".tbl tr.cur").forEach((r) => r.classList.remove("cur"));
  if (!silent && S.sub && ["accounts", "keys", "clients", "vaults"].includes(S.route)) history.pushState(null, "", "#/" + S.route);
  if (!silent) S.sub = null;
}
const dhead = (title, sub) => `<header class="bar"><h1 class="ell">${title}</h1>${sub || ""}<span class="grow"></span><button class="ibtn" data-act="dclose" aria-label="关闭 (Esc)">${ic("x")}</button></header>`;
const scopeChecks = (sel, name) => SCOPES.map((s) => `<label class="chk"><input type="checkbox" name="${name}" value="${s.key}" ${sel.includes(s.key) ? "checked" : ""}><span>${s.name} <span class="sub">${s.key}</span><span class="d">${s.desc}</span></span></label>`).join("");
const vaultChecks = (sel) => VAULTS.map((v) => `<label class="chk"><input type="checkbox" name="vault" value="${v.id}" ${sel.includes(v.id) ? "checked" : ""}><span>${esc(v.label)} <span class="sub">${v.id}</span><span class="d">${v.primary ? "主库" : "附加库"}</span></span></label>`).join("");
function drawerHtml() {
  const { kind, id, mode } = drawerCtx;
  if (kind === "new-account") return dhead("新建 OAuth 账户") + `<form class="dbody scroll" data-form="new-account" onsubmit="return false"><div class="dsec"><div class="grid2"><div class="fld"><label>用户名 <small>username</small></label><input class="inp" name="username" placeholder="3–64 位，例如 carol" required></div><div class="fld"><label>显示名 <span class="muted">可选</span></label><input class="inp" name="displayName" placeholder="例如 Carol Wu"></div></div>
    <div class="fld" style="margin-top:12px"><label>初始密码</label><div class="pw"><input class="inp" type="password" name="password" autocomplete="new-password" placeholder="至少 12 位"><button type="button" class="ibtn" data-act="pwtoggle">${ic("eye")}</button></div><span class="help">与管理密码相互独立；用户在客户端的授权页使用</span></div></div>
    <div class="dsec"><h3>权限上限</h3><div class="grid2" style="gap:0">${scopeChecks(["obsidian.read"], "scope")}</div></div><div class="dsec"><h3>允许的 Vault</h3>${vaultChecks(["vault"])}</div></form><footer class="dfoot"><span class="help"></span><button class="btn ghost" data-act="dclose">取消</button><button class="btn primary" data-act="create-account">创建账户</button></footer>`;
  if (kind === "new-key") return dhead("新建 API Key") + `<form class="dbody scroll" data-form="new-key" onsubmit="return false"><div class="dsec"><div class="fld"><label>备注名</label><input class="inp" name="label" placeholder="例如：桌面客户端" maxlength="120"><span class="help">用于在列表、审计和定时授权中识别这个 Key</span></div></div>
    <div class="dsec"><h3>权限范围</h3>${scopeChecks(["obsidian.read"], "scope")}</div><div class="dsec"><h3>允许的 Vault</h3>${vaultChecks(["vault"])}</div>
    <div class="dsec futonly"><h3>到期时间 ${fut("设想")}</h3><select class="sel" disabled><option>永不过期</option></select></div></form><footer class="dfoot"><span class="help">明文只显示一次</span><button class="btn ghost" data-act="dclose">取消</button><button class="btn primary" data-act="create-key">创建 Key</button></footer>`;
  if (kind === "account") {
    const a = acct(id); if (!a) return dhead("账户不存在") + `<div class="dbody">${emptyState("user", "账户不存在或已删除", "")}</div>`;
    const lc = linkedClients(id);
    return dhead(esc(acctName(a)), a.enabled ? "" : `<span class="tag">已停用</span>`) + `<div class="dbody scroll">
    <div class="dsec"><div class="kv"><div class="k">用户名</div><div class="mono">${esc(a.username)}</div><div class="k">显示名</div><div>${a.displayName ? esc(a.displayName) : `<span class="muted">未设置</span>`}</div><div class="k">账户 ID</div><div>${idc(a.id, a.id)}</div><div class="k">创建</div><div>${fmtFull(a.createdAt)}</div><div class="k">最后登录</div><div>${a.lastLogin ? `${fmtFull(a.lastLogin.at)} <span class="muted mono">· ${a.lastLogin.ip}</span>` : `<span class="muted">从未登录</span>`}</div><div class="k">已授权客户端</div><div>${lc.length ? lc.map((c) => `<a href="#/clients/${c.clientId}">${esc(clientName(c))}</a>`).join("、") : `<span class="muted">无</span>`}</div></div></div>
    <form class="dsec" data-form="acct-perm" onsubmit="return false"><h3>权限上限与 Vault</h3>${scopeChecks(a.scopes, "scope")}<div style="height:8px"></div>${vaultChecks(a.vaults)}
      <div class="banner amber" style="margin:12px 0 0">${ic("alert")}<div>保存后将<b>撤销该账户已有的全部授权</b>（${lc.length} 个客户端需重新授权）。</div></div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" data-act="save-acct-perm">保存权限</button></div></form>
    <form class="dsec" data-form="acct-pw" onsubmit="return false" id="pwsec"><h3>重置密码</h3><div style="display:flex;gap:8px"><div class="pw grow"><input class="inp" type="password" placeholder="新密码，至少 12 位" ${mode === "pw" ? "autofocus" : ""}><button type="button" class="ibtn" data-act="pwtoggle">${ic("eye")}</button></div><button class="btn" data-act="acct-pw">重置</button></div><span class="help">重置后该账户的已有授权会被撤销</span></form>
    <div class="dsec"><h3>危险操作</h3><div class="danger-zone"><div class="dz"><div class="t"><b>${a.enabled ? "停用账户" : "启用账户"}</b>${a.enabled ? "禁止登录并撤销全部授权，可随时恢复" : "恢复登录能力；客户端需重新授权"}</div><button class="btn ${a.enabled ? "danger-o" : ""}" data-dz="toggle">${a.enabled ? "停用…" : "启用"}</button></div><div class="dz"><div class="t"><b>删除账户</b>永久删除，不能撤销</div><button class="btn danger-o" data-dz="del">删除…</button></div></div></div>
    <div class="dsec"><a href="#/audit?q=${encodeURIComponent(acctName(a))}" class="btn ghost sm">${ic("list")}查看此账户的审计记录</a></div></div>`;
  }
  if (kind === "key") {
    const k = keyOf(id); if (!k) return dhead("Key 不存在") + `<div class="dbody">${emptyState("key", "Key 不存在或已删除", "")}</div>`;
    const pol = POLICIES.filter((p) => p.subjects.includes("api-key:" + k.id));
    return dhead(esc(keyName(k)), k.env ? `<span class="tag">${ic("lock", "xs")}只读</span>` : "") + `<div class="dbody scroll">
    ${k.env ? `<div class="banner">${ic("info")}<div>这个 Key 来自部署环境变量 <span class="mono">API_KEY</span>，明文不在此显示，也不能在这里修改或删除。如需轮换，请修改受保护的 <span class="mono">.env</span> 后重启服务。</div></div>` : ""}
    <div class="dsec"><div class="kv"><div class="k">前缀</div><div class="mono">${k.env ? "—（环境变量）" : esc(k.prefix) + "…"}</div><div class="k">Key ID</div><div>${idc(k.id, k.id)}</div><div class="k">创建</div><div>${k.env ? "随部署" : fmtFull(k.createdAt)}</div><div class="k">最后调用</div><div>${k.lastUsed ? `${fmtFull(k.lastUsed.at)}<div class="muted">${esc(k.lastUsed.agent)} · <span class="mono">${k.lastUsed.ip}</span></div>` : `<span class="muted">从未调用</span>`}</div><div class="k">定时授权</div><div>${pol.length ? pol.map((p) => `<a href="#/authz/${p.id}">${esc(p.label)}</a>`).join("、") : `<span class="muted">未受限制</span>`}</div>
    <div class="k futonly">绑定 Agent</div><div class="futonly"><span class="muted">未设置</span> ${fut("#285")}<div class="help">审计中以此名称归因，替代 UA 推测</div></div></div></div>
    <form class="dsec" data-form="key-perm" onsubmit="return false"><h3>权限范围与 Vault</h3>${k.env ? `<div class="tags">${scopeTags(k.scopes)}${vaultTags(k.vaults)}</div>` : `${scopeChecks(k.scopes, "scope")}<div style="height:8px"></div>${vaultChecks(k.vaults)}<div style="margin-top:12px"><button class="btn primary" data-act="save-key-perm">保存</button></div>`}</form>
    ${k.env ? "" : `<div class="dsec"><h3>危险操作</h3><div class="danger-zone"><div class="dz"><div class="t"><b>删除 Key</b>使用此 Key 的程序将立即失去访问</div><button class="btn danger-o" data-dz="del">删除…</button></div></div></div>`}</div>`;
  }
  if (kind === "client") {
    const c = client(id); if (!c) return dhead("客户端不存在") + `<div class="dbody">${emptyState("app", "客户端不存在或已删除", "")}</div>`;
    const la = linkedAccounts(id), eligible = ACCOUNTS.filter((a) => a.enabled && !la.includes(a));
    const tr = c.transfer;
    return dhead(esc(clientName(c))) + `<div class="dbody scroll">
    ${tr ? `<div class="banner amber">${ic("swap")}<div style="flex:1"><b>授权转移待完成</b>：已于 ${rel(tr.at)} 撤销 <b>${esc(acctName(acct(tr.from)))}</b> 的授权，等待 <b>${esc(acctName(acct(tr.to)))}</b> 在客户端中重新登录并同意。<div style="margin-top:8px"><button class="btn sm" data-act="cancel-transfer">取消转移</button></div></div></div>` : ""}
    <div class="dsec"><div class="kv"><div class="k">客户端 ID</div><div>${idc(c.clientId, c.clientId)}</div><div class="k">已授权账户</div><div>${la.length ? la.map((a) => `<a href="#/accounts/${a.id}">${esc(acctName(a))}</a>`).join("、") : `<span class="muted">无有效授权</span>`}</div>
    <div class="k">连接域名</div><div>${c.domains.length ? c.domains.map((d) => `${esc(d.host)} <span class="muted">· 来源 ${d.src.join(" / ")}</span>`).join("<br>") : `<span class="muted">尚无</span>`}</div>
    <div class="k">注册</div><div>${fmtFull(c.createdAt)}</div><div class="k">最后调用</div><div>${c.lastCall ? `${fmtFull(c.lastCall.at)} <span class="muted mono">· ${c.lastCall.ip}</span>` : `<span class="muted">从未调用</span>`}</div></div></div>
    <div class="dsec"><h3>回调地址 · ${c.redirectUris.length}</h3><div class="list">${c.redirectUris.map((u) => `<div class="li"><span class="mono ell grow" title="${esc(u)}">${esc(u)}</span><button class="ibtn" data-copy="${esc(u)}">${ic("copy")}</button></div>`).join("")}</div></div>
    <!-- 「默认 Vault」分节：先实现、后补参照（#643 / issue #642）。
         参照在这里落后过一次有意的设计变更：OAuth 客户端的「默认作用域」是 #643 加进 Admin 抽屉的功能
         （不指定 vaultId 时用哪个库，偏好不等于授权），参照当时没有这一节。按协调席裁决 2026-10-22，
         把参照往前推而不是给实现发区域级豁免 —— 后者会让“这一块以后怎么变都不报”，是假守卫的温床。
         结构与实现逐项对齐：form.dsec > h3 + 一个 .sel 选择器 + 一个提交按钮。 -->
    <form class="dsec" data-form="client-default-vault" onsubmit="return false" id="dvsec"><h3>默认 Vault</h3>
      <div class="fld"><label for="default-vault">默认 Vault</label><select class="sel" id="default-vault" name="defaultVaultId"><option value="" selected>继承服务默认 Vault</option><option value="vault">vault (vault)</option></select><span class="help">MCP 调用不指定 vaultId 时使用此库；明确指定其他有权访问的 Vault 仍然有效。默认库不会授予访问权限。</span></div>
      <div style="margin-top:12px"><button class="btn primary" type="submit">保存默认 Vault</button></div></form>
    <form class="dsec" data-form="transfer" onsubmit="return false" id="trsec"><h3>转移授权账户</h3><p class="help" style="margin:0 0 8px">把此客户端的当前授权从一个账户换到另一个账户：撤销原账户的 Token，目标账户在客户端中重新同意后生效。不更改回调地址与密钥。</p>
      <div class="grid2"><div class="fld"><label>从</label><select class="sel" ${la.length ? "" : "disabled"}>${la.length ? la.map((a) => `<option>${esc(acctName(a))}（${esc(a.username)}）</option>`).join("") : "<option>无有效授权</option>"}</select></div><div class="fld"><label>转到</label><select class="sel" data-trto ${tr || !la.length ? "disabled" : ""}><option value="">选择目标账户…</option>${eligible.map((a) => `<option value="${a.id}">${esc(acctName(a))}（${esc(a.username)}）</option>`).join("")}${ACCOUNTS.filter((a) => !a.enabled).map((a) => `<option disabled>${esc(acctName(a))} · 已停用</option>`).join("")}</select></div></div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center"><button class="btn" data-act="begin-transfer" ${tr || !la.length ? "disabled" : ""}>${ic("swap")}开始转移…</button>${tr ? `<span class="help">已有一项转移待完成</span>` : ""}</div>
      <div class="futonly futbox" style="margin-top:12px"><label class="chk" style="margin:-6px -8px"><input type="checkbox" disabled><span>由管理员直接为目标账户签发等价授权，无需其重新同意 ${fut("#364 待决")}</span></label></div></form>
    <div class="dsec"><h3>危险操作</h3><div class="danger-zone"><div class="dz"><div class="t"><b>撤销全部授权</b>所有账户在此客户端上的 Token 立即失效，注册保留</div><button class="btn danger-o" data-dz="revoke" ${la.length ? "" : "disabled"}>撤销…</button></div><div class="dz"><div class="t"><b>删除客户端</b>撤销授权并删除注册记录</div><button class="btn danger-o" data-dz="del">删除…</button></div></div></div></div>`;
  }
  if (kind === "vault") {
    const v = VAULTS.find((x) => x.id === id); if (!v) return dhead("Vault 不存在") + "";
    const g = v.git, dis = !v.editable;
    const sw = (k, l, key, d) => `<div class="li" style="min-height:52px"><div class="grow"><b>${l}</b> <span class="sub">${key}</span><div class="help">${d}</div></div><button type="button" class="switch ${g[k] ? "on" : ""}" data-gsw="${k}" ${dis ? "disabled" : ""}></button></div>`;
    const num = (k, l, min, max) => `<div class="fld"><label>${l}</label><div style="display:flex;align-items:center;gap:6px"><input class="inp" type="number" min="${min}" max="${max}" value="${g[k]}" data-gnum="${k}" ${dis ? "disabled" : ""}><span class="muted">秒</span></div><span class="sub ell" title="${k} · 范围 ${min}–${max}">${k}</span></div>`;
    return dhead(esc(v.label), `<span class="mono muted">${esc(v.id)}</span>${v.primary ? `<span class="kind">主库</span>` : ""}`) + `<div class="dbody scroll">
    <div class="dsec"><h3>状态</h3><div class="kv"><div class="k">Git 仓库</div><div>${gitState(v)}${v.repo.state === "norepo" ? `<div class="help">目录中没有 .git。在服务器上执行 <span class="mono">git init</span> 后点「验证」，即可启用自动提交。</div>` : `<div class="help mono">HEAD ${v.repo.head} · ${esc(v.repo.msg)}</div>`}</div>
    ${v.repo.state === "clean" ? `<div class="k">最近推送</div><div>${rel(v.repo.lastPush)} · 领先 ${v.repo.ahead} / 落后 ${v.repo.behind}</div>` : ""}
    <div class="k">待提交</div><div>${v.repo.state === "clean" ? `<span class="muted">无</span>` : v.repo.state === "norepo" ? "—" : ""}</div>
    <div class="k">目录</div><div class="mono" style="word-break:break-all">${esc(v.root)}<div class="help" style="font-family:var(--font)">实际路径与此一致</div></div>
    <div class="k">配置来源</div><div>${v.configSource === "admin" ? `管理端保存 · ${rel(v.updatedAt)}` : "默认值（尚未保存过）"}</div>
    <div class="k">上次验证</div><div>${v.verified ? `<span class="st ok"><span class="dot"></span>通过</span> <span class="muted">· ${rel(v.verified.at)}</span>` : `<span class="muted">未验证</span>`}</div>
    <div class="k">定时任务</div><div>${g.enabled && g.autoCommitSweep ? `兜底提交：下次约 ${Math.round(g.sweepIntervalSeconds / 60) - 2} 分钟后` : `<span class="muted">未运行</span>`}</div></div></div>
    <form class="dsec" data-form="git" onsubmit="return false"><h3>Git 同步设置</h3><div class="list">${sw("enabled", "为此 Vault 启用 Git", "enabled", v.repo.state === "norepo" ? "需要先初始化仓库" : "关闭后不再自动提交或推送")}${sw("autoCommit", "自动提交", "autoCommit", "笔记变更后按防抖时间自动提交")}${sw("autoPush", "自动推送", "autoPush", "提交后推送到远端")}${sw("autoCommitSweep", "周期兜底提交", "autoCommitSweep", "定期提交遗漏的变更")}</div>
      <div class="grid3" style="margin-top:16px">${num("debounceSeconds", "提交防抖", 5, 3600)}${num("maxDelaySeconds", "最大延迟", 30, 86400)}${num("sweepIntervalSeconds", "兜底间隔", 60, 86400)}</div>
      <div class="grid2" style="margin-top:12px"><div class="fld"><label>远端名称 <small>remote</small></label><input class="inp mono" value="${esc(g.remote)}" ${dis ? "disabled" : ""}><span class="help">填写名称（如 origin），不是 URL</span></div><div class="fld"><label>分支 <small>branch</small></label><input class="inp mono" value="${esc(g.branch)}" ${dis ? "disabled" : ""}></div></div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" data-act="save-git">保存设置</button><button class="btn" data-act="verify-git">${ic("checkc")}验证仓库与配置</button></div></form>
    <div class="dsec"><h3>能力 <span class="muted" style="font-weight:400">${Object.values(v.caps).filter(Boolean).length} 项可用</span></h3><div class="caps">${Object.entries(v.caps).map(([k, on]) => `<span class="cap ${on ? "" : "off"}" title="${esc(k)}${on ? "" : " · " + esc(CAP_HINTS[k] || "该能力尚未接线")}"><span class="dot ${on ? "ok" : ""}"></span>${CAP_LABELS[k]}</span>`).join("")}</div>
    <div class="help" style="margin-top:8px">${Object.entries(v.caps).filter(([, on]) => !on).map(([k]) => `<div>· ${CAP_LABELS[k]}：${esc(CAP_HINTS[k] || "尚未接线")}</div>`).join("")}</div>
    <details style="margin-top:8px"><summary class="help" style="cursor:pointer">技术细节</summary><pre class="mono" style="white-space:pre-wrap;color:var(--tx3);margin:8px 0 0">${Object.entries(v.caps).filter(([, on]) => !on).map(([k]) => `${k}: available=false (unwired)`).join("\n")}</pre></details></div>
    <div class="dsec futonly"><div class="futbox"><b style="font-weight:600">运行时</b> ${fut("#437")}<div class="help">索引条目 1,284 · 最后扫描 2 分钟前 · 热刷新：开启（新增目录无需重启容器）</div></div></div></div>`;
  }
  return "";
}

// ---------------------------------------------------------------- events
document.addEventListener("click", (e) => {
  const t = e.target;
  const cp = t.closest("[data-copy]"); if (cp) { e.preventDefault(); e.stopPropagation(); return copy(cp.dataset.copy); }
  const mb = t.closest("[data-menu]"); if (mb) { e.stopPropagation(); if (menuCtx && menuCtx.id === mb.dataset.id && $("#menu").classList.contains("on")) return closeMenu(); return openMenu(mb, mb.dataset.menu, mb.dataset.id); }
  const mi = t.closest("[data-mi]"); if (mi) return onMenu(mi.dataset.mi);
  if (!t.closest("#menu")) closeMenu();
  if (t.closest("[data-stop]")) return;
  const op = t.closest("[data-open]");
  if (op && !t.closest("button,a,input,select")) {
    const k = op.dataset.open, id = op.dataset.id;
    if (k === "policy") return go("#/authz/" + id);
    return go(`#/${{ account: "accounts", key: "keys", client: "clients", vault: "vaults" }[k]}/${id}`);
  }
  const ua = t.closest("[data-ua]"); if (ua) { const id = ua.dataset.ua; S.uaOpen.has(id) ? S.uaOpen.delete(id) : S.uaOpen.add(id); return render(); }
  const dz = t.closest("[data-dz]"); if (dz && drawerCtx) { menuCtx = { kind: drawerCtx.kind, id: drawerCtx.id }; return onMenu(dz.dataset.dz); }
  const tf = t.closest("[data-tokf]"); if (tf) { S.tokenFilter = tf.dataset.tokf; return render(); }
  const af = t.closest("[data-auf]"); if (af) { S.audit.outcome = af.dataset.auf; S.audit.page = 1; return render(); }
  const pg = t.closest("[data-pg]"); if (pg && !pg.disabled) { S.audit.page = +pg.dataset.pg; render(); $(".content").scrollTop = 0; return; }
  // policy editor
  const md = t.closest("[data-mode]"); if (md) { S.draft.mode = md.dataset.mode; if (md.dataset.mode === "revoke") S.draft.capabilities = ["all"]; return render(); }
  const dy = t.closest("[data-day]"); if (dy) { const d = +dy.dataset.day; if (S.draft.weekly.some((w) => w.day === d)) S.draft.weekly = S.draft.weekly.filter((w) => w.day !== d); else S.draft.weekly.push({ day: d, from: "09:00", to: "18:00" }); return render(); }
  const pr = t.closest("[data-preset]"); if (pr) { const p = pr.dataset.preset; S.draft.weekly = p === "clear" ? [] : (p === "work" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]).map((day) => ({ day, from: p === "work" ? "09:00" : "00:00", to: p === "work" ? "18:00" : "24:00" })); return render(); }
  const wd = t.closest("[data-wdel]"); if (wd) { const [day, i] = wd.dataset.wdel.split(":").map(Number); const ws = S.draft.weekly.filter((w) => w.day === day); S.draft.weekly.splice(S.draft.weekly.indexOf(ws[i]), 1); return render(); }
  const dd = t.closest("[data-ddel]"); if (dd) { S.draft.dateRanges.splice(+dd.dataset.ddel, 1); return render(); }
  const us = t.closest("[data-unsubj]"); if (us) { S.draft.subjects = S.draft.subjects.filter((s) => s !== us.dataset.unsubj); return render(); }
  const uc = t.closest("[data-uncap]"); if (uc) { S.draft.capabilities = S.draft.capabilities.filter((s) => s !== uc.dataset.uncap); return render(); }
  const cg = t.closest("[data-capg]"); if (cg) { const g = cg.dataset.capg; S.capOpen.has(g) ? S.capOpen.delete(g) : S.capOpen.add(g); return render(); }
  const gsw = t.closest("[data-gsw]"); if (gsw && !gsw.disabled) { gsw.classList.toggle("on"); return; }
  const a = t.closest("[data-act]"); if (!a) return;
  const act = a.dataset.act;
  if (a.tagName === "A" && act === "mmore") e.preventDefault();
  const D_ = drawerCtx;
  switch (act) {
    case "theme": setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); return render();
    case "kbd": return showKbd();
    case "logout": return confirmBox({ title: "退出管理后台？", body: "将结束当前管理会话。", ok: "退出", danger: false, onOk: () => go("#/login") });
    case "dclose": return closeDrawer();
    case "mcancel": return closeModal();
    case "mok": { const f = modalOk; closeModal(); return f && f(); }
    case "pwtoggle": { const i = a.parentElement.querySelector("input"); i.type = i.type === "password" ? "text" : "password"; return; }
    case "new-account": S.cur = null; return openDrawer("new-account", "");
    case "new-key": return openDrawer("new-key", "");
    case "new-policy": S.draft = null; return go("#/authz/new");
    case "create-account": { const f = $("[data-form=new-account]"); const u = f.username.value.trim(); if (u.length < 3) { f.username.focus(); return toast("用户名至少 3 位", { err: true }); } if (f.password.value.length < 12) { f.password.focus(); return toast("密码至少 12 位", { err: true }); } ACCOUNTS.push({ id: crypto.randomUUID?.() || "new-" + Date.now(), username: u, displayName: f.displayName.value.trim(), scopes: $$("[name=scope]:checked", f).map((x) => x.value), vaults: $$("[name=vault]:checked", f).map((x) => x.value), enabled: true, createdAt: NOW.toISOString(), lastLogin: null }); closeDrawer(); render(); return toast(`已创建账户 ${esc(u)}`); }
    case "create-key": { const f = $("[data-form=new-key]"); const label = f.label.value.trim() || ""; const id = crypto.randomUUID?.() || "k" + Date.now(); const pre = "obmcp_" + id.replace(/-/g, "").slice(0, 8); KEYS.push({ id, label, prefix: pre, scopes: $$("[name=scope]:checked", f).map((x) => x.value), vaults: $$("[name=vault]:checked", f).map((x) => x.value), createdAt: NOW.toISOString(), lastUsed: null }); S.flashKey = { label: label || "未命名 Key", secret: pre + "_DUMMY-NOT-A-REAL-SECRET-x7Q2" }; closeDrawer(); go("#/keys", true); return; }
    case "dismiss-flash": S.flashKey = null; return render();
    case "save-acct-perm": return confirmBox({ title: "保存权限并撤销已有授权？", body: `<b>${esc(acctName(acct(D_.id)))}</b> 在 ${linkedClients(D_.id).length} 个客户端上的授权将被撤销，用户需要重新授权。`, ok: "保存并撤销", onOk: () => { const f = $("[data-form=acct-perm]"), ac = acct(D_.id); ac.scopes = $$("[name=scope]:checked", f).map((x) => x.value); ac.vaults = $$("[name=vault]:checked", f).map((x) => x.value); TOKENS.forEach((t) => { if (t.userId === ac.id && t.status === "active") t.status = "revoked"; }); render(); refreshDrawer(); toast("权限已保存，已撤销旧授权"); } });
    case "acct-pw": { const i = $("[data-form=acct-pw] input"); if (i.value.length < 12) { i.focus(); return toast("新密码至少 12 位", { err: true }); } return confirmBox({ title: "重置密码？", body: "该账户的已有授权会被撤销，需要用新密码重新授权。", ok: "重置密码", onOk: () => { i.value = ""; toast("密码已重置"); } }); }
    case "save-key-perm": { const f = $("[data-form=key-perm]"), k = keyOf(D_.id); k.scopes = $$("[name=scope]:checked", f).map((x) => x.value); k.vaults = $$("[name=vault]:checked", f).map((x) => x.value); render(); return toast("Key 权限已保存，立即生效"); }
    case "begin-transfer": { const to = $("[data-trto]").value; if (!to) return toast("请选择目标账户", { err: true }); const c = client(D_.id), from = linkedAccounts(c.clientId)[0]; return confirmBox({ title: "转移授权账户？", body: `将立即撤销 <b>${esc(acctName(from))}</b> 在「${esc(clientName(c))}」上的 Token。<b>${esc(acctName(acct(to)))}</b> 需在客户端中重新登录并同意后，转移才完成。`, ok: "开始转移", danger: false, onOk: () => { c.transfer = { from: from.id, to, at: NOW.toISOString() }; TOKENS.forEach((t) => { if (t.clientId === c.clientId && t.userId === from.id && t.status === "active") t.status = "revoked"; }); render(); refreshDrawer(); toast("已发起转移，等待目标账户重新授权"); } }); }
    case "cancel-transfer": delete client(D_.id).transfer; render(); refreshDrawer(); return toast("已取消转移");
    case "save-git": { const v = VAULTS.find((x) => x.id === D_.id); $$("[data-gsw]").forEach((s) => (v.git[s.dataset.gsw] = s.classList.contains("on"))); $$("[data-gnum]").forEach((n) => (v.git[n.dataset.gnum] = +n.value)); v.configSource = "admin"; v.updatedAt = NOW.toISOString(); render(); refreshDrawer(); return toast(`${esc(v.id)} 的 Git 设置已保存`); }
    case "verify-git": return verifyVault(D_.id);
    case "vault-refresh": return toast("Vault 清单已刷新：2 个，无变化");
    case "vault-scan": return toast("原型：将扫描数据目录并热加载新 Vault（#437）");
    case "token-cleanup": return confirmBox({ title: "清理历史 Token 记录", body: "只删除已撤销、已过期或已轮换的记录，<b>有效 Token 不受影响</b>。", extra: `<div class="fld"><label>清理范围</label><select class="sel" id="olderThan"><option value="7">早于 7 天</option><option value="30" selected>早于 30 天</option><option value="90">早于 90 天</option><option value="0">全部非活动记录</option></select></div>`, ok: "清理", onOk: () => { const n = TOKENS.filter((t) => t.status !== "active").length; toast(`已清理 ${n} 条非活动 Token 记录（访问 ${Math.ceil(n / 2)}，刷新 ${Math.floor(n / 2)}）`); } });
    case "audit-reset": Object.assign(S.audit, { outcome: "", action: "", credential: "", origin: "", source: "", q: "", page: 1 }); history.replaceState(null, "", "#/audit"); return render();
    case "audit-export": return toast("原型：导出当前筛选结果为 CSV（设想）");
    case "authz-master": return confirmBox({ title: AUTHZ.enabled ? "关闭定时授权？" : "启用定时授权？", body: AUTHZ.enabled ? "所有策略将暂停生效，凭据恢复全天可用。" : "所有启用的策略将立即开始限制对应主体。", ok: AUTHZ.enabled ? "关闭" : "启用", danger: AUTHZ.enabled, onOk: () => { AUTHZ.enabled = !AUTHZ.enabled; render(); toast("已" + (AUTHZ.enabled ? "启用" : "关闭") + "定时授权"); } });
    case "authz-repair": return confirmBox({ title: "用粘贴的文档覆盖策略存储？", body: "当前损坏的文件会先备份。覆盖后所有策略按新文档生效。", type: "覆盖", ok: "覆盖修复", onOk: () => { S.broken = null; render(); toast("策略存储已修复"); } });
    case "git-repair": return confirmBox({ title: "重置 Git 配置存储？", body: "所有 Vault 的 Git 设置将恢复默认（不自动提交），损坏文件会先备份。", type: "重置", ok: "重置", onOk: () => { S.broken = null; render(); toast("已重置 Git 配置"); } });
    case "d-enabled": S.draft.enabled = !S.draft.enabled; return render();
    case "add-slot": { const days = [...new Set(S.draft.weekly.map((w) => w.day))]; days.forEach((day) => S.draft.weekly.push({ day, from: "19:00", to: "22:00" })); return render(); }
    case "add-range": S.draft.dateRanges.push({ from: fmtDate(NOW.toISOString()), to: fmtDate(new Date(+NOW + 7 * D).toISOString()) }); return render();
    case "save-policy": return savePolicy();
    case "del-policy": return delPolicy(POLICIES.find((p) => p.id === S.draft.id));
    case "conflict-reload": S.conflict = false; S.draft = null; parseHash(); render(); return toast("已载入最新版本");
    case "conflict-diff": return toast("原型：并排显示你的改动与最新版本");
    case "mmore": return mobileMore(a);
    case "undo": return;
  }
});
function mobileMore(a) {
  const m = $("#menu");
  m.innerHTML = NAV.filter(Array.isArray).map(([k, l, icn]) => `<button data-nav="${k}">${ic(icn)}<span class="grow">${l}</span></button>`).join("") + `<hr><button data-act="theme">${ic("sun")}<span class="grow">切换主题</span></button><button data-act="logout">${ic("out")}<span class="grow">退出登录</span></button>`;
  m.classList.add("on"); m.style.left = "auto"; m.style.right = "8px"; m.style.top = innerHeight - m.offsetHeight - 64 + "px"; menuCtx = { kind: "more" };
}
document.addEventListener("click", (e) => { const n = e.target.closest("[data-nav]"); if (n) { closeMenu(); go("#/" + n.dataset.nav); } });
function savePolicy() {
  const d = S.draft;
  if (!d.label.trim()) { $("[data-dv=label]").focus(); return toast("请填写策略名称", { err: true }); }
  if (!d.subjects.length) return toast("请至少选择一个主体", { err: true });
  if (!d.capabilities.length) return toast("请至少选择一项能力", { err: true });
  if (d.weekly.some((w) => w.to <= w.from)) return toast("有时段的结束时间早于开始时间", { err: true });
  if (devp("conflict") === "1" && !S.conflictShown) { S.conflictShown = true; S.conflict = true; render(); $(".content").scrollTop = 0; return; }
  const { _for, ...clean } = d;
  if (d.id) Object.assign(POLICIES.find((p) => p.id === d.id), clean, { updatedAt: NOW.toISOString() });
  else POLICIES.push({ ...clean, id: crypto.randomUUID?.() || "p" + Date.now(), updatedAt: NOW.toISOString() });
  AUTHZ.revision++; S.draft = null; go("#/authz"); toast(d.id ? "策略已保存" : "策略已创建");
}
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.search) { const k = t.dataset.search; if (k === "audit") { S.audit.q = t.value; S.audit.page = 1; } else S.q[k] = t.value; return rerenderKeepFocus(t); }
  if (t.dataset.af) { S.audit[t.dataset.af] = t.value; S.audit.page = 1; return rerenderKeepFocus(t); }
  if (t.hasAttribute("data-subjq")) { S.subjQ = t.value; return rerenderKeepFocus(t); }
  if (t.hasAttribute("data-capq")) { S.capQ = t.value; return rerenderKeepFocus(t); }
  if (t.dataset.dv === "label") { S.draft.label = t.value; return; }
  if (t.hasAttribute("data-typeconf")) { $("[data-act=mok]").disabled = t.value !== $("#modal").dataset.type; }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.act === "tok-order") { S.tokenOrder = t.value; return render(); }
  if (t.dataset.act === "pagesize") { S.audit.pageSize = +t.value; S.audit.page = 1; return render(); }
  if (t.dataset.act === "preview-subject") { S.previewSubj = t.value; return render(); }
  if (t.dataset.af) { S.audit[t.dataset.af] = t.value; S.audit.page = 1; return render(); }
  if (t.dataset.subj) { const s = t.dataset.subj; S.draft.subjects = t.checked ? [...S.draft.subjects, s] : S.draft.subjects.filter((x) => x !== s); return render(); }
  if (t.dataset.cap) { const k = t.dataset.cap; S.draft.capabilities = t.checked ? [...S.draft.capabilities, k] : S.draft.capabilities.filter((x) => x !== k); return render(); }
  if (t.dataset.dv) { S.draft[t.dataset.dv] = t.value; return render(); }
  if (t.dataset.wf) { const [day, i, f] = t.dataset.wf.split(":"); const ws = S.draft.weekly.filter((w) => w.day === +day); ws[+i][f] = t.value; return render(); }
  if (t.dataset.df) { const [i, f] = t.dataset.df.split(":"); S.draft.dateRanges[+i][f] = t.value; return render(); }
});
function rerenderKeepFocus(el) {
  const sel = Object.keys(el.dataset).map((k) => `[data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}${el.dataset[k] ? `="${el.dataset[k]}"` : ""}]`).join("");
  const pos = el.selectionStart;
  render();
  const n = $(sel); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
}
document.addEventListener("submit", (e) => {
  if (e.target.dataset.form === "login") { e.preventDefault(); const v = $("#pw").value; if (v === "") { S.loginErr = true; return render(); } S.loginErr = false; go("#/overview"); toast("欢迎回来"); }
});
$("#dscrim").addEventListener("click", () => closeDrawer());
$("#mscrim").addEventListener("click", closeModal);

// ---------------------------------------------------------------- keyboard
let gPending = 0;
document.addEventListener("keydown", (e) => {
  const inField = e.target.matches("input,textarea,select");
  if ($("#modal").classList.contains("on")) {
    if (e.key === "Escape") closeModal();
    if (e.key === "Enter" && !$("[data-act=mok]")?.disabled && $("[data-act=mok]")) { e.preventDefault(); const f = modalOk; closeModal(); f && f(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && S.route === "authz" && S.sub) { e.preventDefault(); return savePolicy(); }
  if (e.key === "Escape") { if ($("#menu").classList.contains("on")) return closeMenu(); if (inField) return e.target.blur(); if (drawerCtx) return closeDrawer(); if (S.route === "authz" && S.sub) return go("#/authz"); return; }
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (gPending && Date.now() - gPending < 1200) { gPending = 0; const n = NAV.filter(Array.isArray).find((x) => x[3] === e.key); if (n) { e.preventDefault(); go("#/" + n[0]); } return; }
  if (e.key === "g") { gPending = Date.now(); return; }
  if (e.key === "?") { e.preventDefault(); return showKbd(); }
  if (e.key === "/") { const s = $("[data-search],[data-subjq]"); if (s) { e.preventDefault(); s.focus(); s.select(); } return; }
  if (e.key === "t") { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); return render(); }
  if (e.key === "n") { const b = $(".bar [data-act^=new-]"); if (b) { e.preventDefault(); b.click(); } return; }
  if (e.key === "j" || e.key === "k") {
    const rows = $$(".tbl tbody tr[data-open],.tbl tbody tr[data-ua]"); if (!rows.length) return;
    let i = rows.findIndex((r) => r.classList.contains("kb"));
    rows.forEach((r) => { r.classList.remove("kb"); r.classList.remove("cur"); });
    i = Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)));
    rows[i].classList.add("kb", "cur"); rows[i].scrollIntoView({ block: "nearest" }); return;
  }
  if (e.key === "Enter") { const r = $(".tbl tr.kb"); if (r) r.click(); }
});
addEventListener("popstate", onRoute);
addEventListener("hashchange", () => { if (location.hash !== lastHash) { lastHash = location.hash; onRoute(); } });
let lastHash = location.hash;

// ---------------------------------------------------------------- boot (dev params)
(function boot() {
  let theme = "dark"; try { theme = localStorage.getItem(storageKey("theme")) || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); } catch {}
  if (devp("theme")) theme = devp("theme");
  setTheme(theme);
  if (devp("future") === "0") document.body.classList.add("nofut");
  if (devp("lock") === "1") S.loginLocked = true;
  if (devp("broken")) S.broken = devp("broken");
  if (devp("authz") === "off") AUTHZ.enabled = false;
  if (devp("flash") === "1") S.flashKey = { label: "桌面客户端", secret: "obmcp_5f1e9a20_DUMMY-NOT-A-REAL-SECRET-x7Q2" };
  if (!location.hash) history.replaceState(null, "", location.search + "#/overview");
  lastHash = location.hash;
  onRoute();
  if (devp("subj")) { S.subjQ = devp("subj"); render(); }
  const dm = devp("menu"); if (dm) { const [k, id] = dm.split(":"); const b = $(`[data-menu="${k}"][data-id="${id || ""}"]`); b && openMenu(b, k, id || ""); }
  const da = devp("act"); if (da) { const b = $(`[data-act="${da}"]`); b && b.click(); }
  const mi = devp("mi"); if (mi && menuCtx) onMenu(mi);
  if (devp("kbd") === "1") showKbd();
  if (devp("ua")) { S.uaOpen.add(devp("ua")); render(); }
})();
</script>
</body>
</html>
