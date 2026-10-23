<script>
/* Obsidian MCP Admin — prototype (static, mock data, no deps)
   Data shapes mirror app/src/admin/** @ main 3bc97da:
   oauthUser {id, username, displayName, scopes[], vaults[], enabled, createdAt, lastLogin{at,ip}}
   apiKey    {id, label, prefix, scopes[], vaults[], createdAt, lastUsed{at,ip,agent}, env?}
   client    {clientId, clientName, redirectUris[], domains[{host,src}], createdAt, lastCall, transfer?}
   token     {id, grant, type access|refresh, clientId, userId, resource, scopes, vaults, status active|rotated|revoked|expired}
   policy    {id, label, mode suspend|revoke, enabled, timezone, startsAt, expiresAt, weekly[{day,from,to}], dateRanges[{from,to}], subjects[], capabilities[]}
   All ids are dummy. No real secrets. */
"use strict";
const NOW = new Date("2026-10-10T10:30:00+08:00"); // Saturday
const VERSION = "1.0.0";
const H = 3600e3, D = 24 * H, M = 60e3;
const ago = (ms) => new Date(NOW - ms).toISOString();

const SCOPES = [
  { key: "obsidian.read", name: "读取", desc: "读取笔记、搜索、查看历史" },
  { key: "obsidian.write", name: "写入", desc: "创建、修改、移动笔记" },
  { key: "obsidian.files", name: "文件", desc: "上传与管理附件文件" },
];

const VAULTS = [
  { id: "vault", name: "vault", label: "主库", primary: true, root: "/data/vaults/vault", editable: true,
    git: { enabled: true, autoCommit: true, autoPush: true, autoCommitSweep: true, debounceSeconds: 30, maxDelaySeconds: 300, sweepIntervalSeconds: 900, remote: "origin", branch: "main" },
    repo: { state: "clean", head: "a1c9e07", lastCommit: ago(14 * M), lastPush: ago(13 * M), ahead: 0, behind: 0, msg: "auto: 3 notes updated" },
    verified: { ok: true, at: ago(2 * D) }, configSource: "admin", updatedAt: ago(5 * D),
    caps: { notes: 1, files: 1, history: 1, trash: 1, plans: 1, retrieval: 1, semantic: 0, webCatalog: 0, publish: 1, git: 1, events: 0, memory: 1, skills: 1 } },
  { id: "research", name: "research", label: "研究库", primary: false, root: "/data/vaults/research", editable: true,
    git: { enabled: false, autoCommit: false, autoPush: false, autoCommitSweep: false, debounceSeconds: 30, maxDelaySeconds: 300, sweepIntervalSeconds: 900, remote: "origin", branch: "main" },
    repo: { state: "norepo" }, verified: null, configSource: "default", updatedAt: null,
    caps: { notes: 1, files: 1, history: 1, trash: 1, plans: 1, retrieval: 1, semantic: 0, webCatalog: 0, publish: 1, git: 0, events: 0, memory: 1, skills: 0 } },
];
const CAP_LABELS = { notes: "笔记读写", files: "文件与上传", history: "历史版本", trash: "回收站", plans: "变更方案", retrieval: "检索索引", semantic: "语义检索", webCatalog: "Web 目录", publish: "发布", git: "Git", events: "实时事件", memory: "记忆", skills: "技能" };
const CAP_HINTS = { semantic: "本机未配置向量服务，检索仍按关键词工作", webCatalog: "属于 Web 端能力，MCP 不使用", events: "属于 Web 端实时推送，MCP 不使用", git: "该库尚未初始化 Git 仓库", skills: "该库没有 skills 目录" };

const ACCOUNTS = [
  { id: "2819e4a9-6c1d-4b8e-9f20-5a7c3e1d0b42", username: "alice", displayName: "Alice Chen", scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], vaults: ["vault", "research"], enabled: true, createdAt: ago(41 * D), lastLogin: { at: ago(2 * H), ip: "192.168.1.24" } },
  { id: "6b03f7d2-11a8-4c5e-8d74-e2b9c0a51f63", username: "bob", displayName: "Bob Li", scopes: ["obsidian.read"], vaults: ["research"], enabled: true, createdAt: ago(18 * D), lastLogin: { at: ago(3 * D), ip: "10.0.0.8" } },
  { id: "c4d8a0e1-73b5-4f19-a6c2-98e1d3f7b250", username: "audit-user", displayName: "", scopes: ["obsidian.read"], vaults: ["vault"], enabled: false, createdAt: ago(6 * D), lastLogin: null },
];

const KEYS = [
  { id: "configured-env", env: true, label: "环境配置 API_KEY", prefix: null, scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], vaults: ["vault", "research"], createdAt: null, lastUsed: { at: ago(25 * M), ip: "127.0.0.1", agent: "Claude Code" } },
  { id: "87ca7263-0f4e-4a1b-b6d9-3c5e81f20a7d", label: "Research bot", prefix: "obmcp_a97db1bd", scopes: ["obsidian.read"], vaults: ["research"], createdAt: ago(12 * D), lastUsed: { at: ago(19 * H), ip: "10.0.0.31", agent: "research-bot/0.4" } },
  { id: "3c09aa30-5d2e-4e8f-a1b7-6f9c04d2e815", label: "NAS 同步脚本", prefix: "obmcp_3c09aa30", scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], vaults: ["vault"], createdAt: ago(30 * D), lastUsed: { at: ago(4 * M), ip: "192.168.1.5", agent: "undici" } },
  { id: "e51b8c47-92a0-4d6f-8e13-7b2a9d0c4f61", label: "", prefix: "obmcp_e51b8c47", scopes: ["obsidian.read"], vaults: ["vault"], createdAt: ago(9 * D), lastUsed: null },
];

const CLIENTS = [
  { clientId: "0f6a2d91-8b47-4c3e-a5d1-2e9b7c4f8a60", clientName: "Claude Desktop", redirectUris: ["http://127.0.0.1:33418/callback", "https://claude.ai/api/mcp/auth_callback"], domains: [{ host: "obsidian.example.com", src: ["授权", "调用"] }], createdAt: ago(40 * D), lastCall: { at: ago(9 * M), ip: "192.168.1.24" },
    transfer: { from: ACCOUNTS[0].id, to: ACCOUNTS[2].id, at: ago(50 * M) } },
  { clientId: "a9d3e7b0-24c6-4f81-9e5a-1b8d6c0f3e27", clientName: "ChatGPT Connector", redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], domains: [{ host: "obsidian.example.com", src: ["注册", "授权", "调用"] }], createdAt: ago(17 * D), lastCall: { at: ago(3 * D), ip: "198.51.100.8" } },
  { clientId: "5e7c1b02-d9a4-4e63-b8f0-a2c6e91d4b73", clientName: "Cursor IDE", redirectUris: ["cursor://anysphere.cursor-retrieval/oauth/callback"], domains: [{ host: "obsidian.example.com", src: ["授权", "调用"] }], createdAt: ago(8 * D), lastCall: { at: ago(36 * M), ip: "192.168.1.24" } },
  { clientId: "d20e4f8a-6b13-47c9-91e5-c3a7b0f2d846", clientName: "", redirectUris: ["http://localhost:6274/oauth/callback"], domains: [], createdAt: ago(2 * D), lastCall: null },
];

/* tokens: one grant = access + refresh pair */
const TOKENS = [];
(() => {
  let n = 0;
  const hex = () => (Math.abs(Math.sin(++n * 9301 + 49297)) * 1e17).toString(16).replace(".", "").padEnd(12, "7").slice(0, 8);
  const mk = (clientIdx, userIdx, status, created, scopes, vaults, used) => {
    const grant = "g_" + hex();
    for (const type of ["access", "refresh"]) {
      const st = type === "access" && status === "active" && created > 1 * H ? "expired" : status;
      TOKENS.push({ id: hex() + "-" + hex().slice(0, 4) + "-4" + hex().slice(0, 3) + "-" + hex().slice(0, 4) + "-" + hex() + hex().slice(0, 4), grant, type, clientId: CLIENTS[clientIdx].clientId, userId: ACCOUNTS[userIdx].id, resource: "https://obsidian.example.com/mcp", scopes, vaults, status: type === "refresh" ? status : st, createdAt: ago(created), lastUsed: used == null ? null : { at: ago(used), ip: userIdx === 1 ? "198.51.100.8" : "192.168.1.24" } });
    }
  };
  mk(0, 0, "revoked", 40 * M, ["obsidian.read", "obsidian.write"], ["vault", "research"], 9 * M);
  mk(2, 0, "active", 3 * H, ["obsidian.read", "obsidian.write", "obsidian.files"], ["vault"], 36 * M);
  mk(1, 1, "active", 2 * D, ["obsidian.read"], ["research"], 3 * D);
  mk(0, 0, "rotated", 1 * D, ["obsidian.read", "obsidian.write"], ["vault", "research"], 1 * D);
  mk(0, 0, "rotated", 2 * D, ["obsidian.read", "obsidian.write"], ["vault", "research"], 2 * D);
  mk(2, 0, "revoked", 6 * D, ["obsidian.read"], ["vault"], 6 * D);
  mk(1, 1, "rotated", 9 * D, ["obsidian.read"], ["research"], 9 * D);
  mk(1, 2, "revoked", 5 * D, ["obsidian.read"], ["vault"], null);
})();

const PUBLISHES = [
  { id: "pZ8kq2Lm4Rt7", vault: "vault", path: "Projects/Alpha.md", title: "Alpha 项目简报", status: "active", by: { kind: "client", name: "Claude Desktop", user: "alice" }, at: ago(3 * D), views: 41 },
  { id: "vN3xw9Bc1Hs5", vault: "research", path: "Reading/2026 Q3 reading list.md", title: "2026 Q3 书单", status: "active", by: { kind: "key", name: "Research bot" }, at: ago(8 * D), views: 7 },
  { id: "tQ6yd0Fe2Jk8", vault: "vault", path: "Drafts/Old idea.md", title: "Old idea", status: "orphaned", by: { kind: "client", name: "Cursor IDE", user: "alice" }, at: ago(20 * D), views: 2 },
];

/* audit — action keys mirror server keys; zh labels for display */
const ACTIONS = {
  "admin.login": ["管理员登录", "管理"], "admin.logout": ["管理员退出", "管理"], "audit.clear": ["清空审计日志", "管理"],
  "oauth.authorize": ["OAuth 同意授权", "OAuth"], "oauth.token": ["签发 Token", "OAuth"], "oauth.refresh": ["刷新 Token", "OAuth"], "oauth.register": ["注册客户端", "OAuth"],
  "oauth.client.transfer.begin": ["发起授权转移", "OAuth"], "oauth.user.password": ["重置账户密码", "管理"], "oauth.user.create": ["创建 OAuth 账户", "管理"],
  "apikey.create": ["创建 API Key", "管理"], "authz.policy.update": ["修改定时授权", "管理"],
  "mcp.initialize": ["MCP 连接", "MCP"], "mcp.tools/call": ["MCP 工具调用", "MCP"], "mcp.notifications/initialized": ["MCP 初始化完成", "MCP"], "mcp.resources/read": ["MCP 读取资源", "MCP"],
  "web.login": ["Web 登录", "Web"], "publish.create": ["发布文档", "Web"], "authz.denied": ["定时授权拒绝", "MCP"],
};
const CRED_KIND = { "oauth-access": "OAuth Token", "oauth-refresh": "刷新 Token", "api-key": "API Key", "admin-session": "管理会话", "none": "匿名" };
const UAS = {
  claude: "Claude-User/1.0 (Macintosh; Intel Mac OS X 10_15_7) node-fetch/3.3.2 mcp-remote/0.1.29",
  chatgpt: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
  cursor: "Cursor/1.7.38 (darwin arm64) @modelcontextprotocol/sdk/1.18.0",
  undici: "undici", browser: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  bot: "research-bot/0.4 python-httpx/0.27.2",
};
const AUDIT = [];
(() => {
  const C = CLIENTS, A = ACCOUNTS, K = KEYS;
  const ev = (minAgo, action, ok, cred, extra = {}) => AUDIT.push({ id: "au_" + (1000 + AUDIT.length), at: ago(minAgo * M), action, ok, cred, origin: "obsidian.example.com", ...extra });
  const claude = { kind: "oauth-access", client: C[0].clientId, user: A[0].id };
  const cursor = { kind: "oauth-access", client: C[2].clientId, user: A[0].id };
  const gpt = { kind: "oauth-access", client: C[1].clientId, user: A[1].id };
  const nas = { kind: "api-key", key: K[2].id }, bot = { kind: "api-key", key: K[1].id }, env = { kind: "api-key", key: "configured-env" };
  const adm = { kind: "admin-session" }, none = { kind: "none" };
  ev(1, "mcp.tools/call", true, nas, { tool: "write_note", src: "192.168.1.5", ua: UAS.undici, agent: "undici" });
  ev(4, "mcp.tools/call", true, nas, { tool: "list_notes", src: "192.168.1.5", ua: UAS.undici, agent: "undici" });
  ev(9, "mcp.tools/call", true, claude, { tool: "search_notes", src: "192.168.1.24", ua: UAS.claude, agent: "Claude Desktop" });
  ev(11, "mcp.resources/read", true, claude, { tool: "vault://notes/Inbox.md", src: "192.168.1.24", ua: UAS.claude, agent: "Claude Desktop" });
  ev(18, "authz.denied", false, bot, { tool: "get_note", src: "10.0.0.31", ua: UAS.bot, agent: "research-bot", reason: "定时授权「Research bot 工作时间」：当前不在允许窗口（周六）" });
  ev(25, "mcp.tools/call", true, env, { tool: "git_status", src: "127.0.0.1", ua: UAS.claude, agent: "Claude Code" });
  ev(36, "mcp.tools/call", true, cursor, { tool: "get_note", src: "192.168.1.24", ua: UAS.cursor, agent: "Cursor IDE" });
  ev(41, "oauth.refresh", true, { kind: "oauth-refresh", client: C[0].clientId, user: A[0].id }, { src: "192.168.1.24", ua: UAS.claude });
  ev(50, "oauth.client.transfer.begin", true, adm, { src: "192.168.1.24", ua: UAS.browser, detail: "Claude Desktop：alice → audit-user（待重新授权）" });
  ev(52, "admin.login", true, adm, { src: "192.168.1.24", ua: UAS.browser });
  ev(58, "admin.login", false, none, { src: "198.51.100.7", ua: "python-requests/2.32.3", reason: "管理密码错误" });
  ev(59, "admin.login", false, none, { src: "198.51.100.7", ua: "python-requests/2.32.3", reason: "管理密码错误" });
  ev(61, "admin.login", false, none, { src: "198.51.100.7", ua: "python-requests/2.32.3", reason: "管理密码错误" });
  ev(95, "mcp.initialize", true, cursor, { src: "192.168.1.24", ua: UAS.cursor, agent: "Cursor IDE" });
  ev(96, "mcp.notifications/initialized", true, cursor, { src: "192.168.1.24", ua: UAS.cursor, agent: "Cursor IDE" });
  ev(180, "oauth.token", true, cursor, { src: "192.168.1.24", ua: UAS.cursor });
  ev(181, "oauth.authorize", true, { kind: "admin-session", user: A[0].id, client: C[2].clientId }, { src: "192.168.1.24", ua: UAS.browser, detail: "alice 同意 Cursor IDE：读取、写入、文件 · vault" });
  ev(240, "mcp.tools/call", false, gpt, { tool: "write_note", src: "198.51.100.8", ua: UAS.chatgpt, agent: "ChatGPT Connector", reason: "权限不足：缺少「写入」" });
  ev(300, "web.login", true, { kind: "none", user: A[0].id }, { src: "192.168.1.24", ua: UAS.browser });
  ev(420, "publish.create", true, claude, { tool: "Projects/Alpha.md", src: "192.168.1.24", ua: UAS.claude, agent: "Claude Desktop" });
  ev(19 * 60, "mcp.tools/call", true, bot, { tool: "search_notes", src: "10.0.0.31", ua: UAS.bot, agent: "research-bot" });
  ev(26 * 60, "oauth.token", false, { kind: "oauth-refresh", client: C[1].clientId, user: A[2].id }, { src: "198.51.100.8", ua: UAS.chatgpt, reason: "刷新 Token 已撤销" });
  ev(30 * 60, "authz.policy.update", true, adm, { src: "192.168.1.24", ua: UAS.browser, detail: "Research bot 工作时间 · 修订 3" });
  ev(48 * 60, "oauth.register", true, none, { src: "127.0.0.1", ua: "node", detail: "未命名客户端（localhost:6274）" });
  ev(3 * 24 * 60, "mcp.tools/call", true, gpt, { tool: "search_notes", src: "198.51.100.8", ua: UAS.chatgpt, agent: "ChatGPT Connector" });
  ev(5 * 24 * 60, "oauth.user.create", true, adm, { src: "192.168.1.24", ua: UAS.browser, detail: "audit-user" });
  for (let i = 0; i < 22; i++) ev(6 * 24 * 60 + i * 97, i % 5 === 3 ? "oauth.refresh" : "mcp.tools/call", i % 9 !== 4, i % 2 ? nas : claude, { tool: ["list_notes", "get_note", "search_notes", "write_note"][i % 4], src: i % 2 ? "192.168.1.5" : "192.168.1.24", ua: i % 2 ? UAS.undici : UAS.claude, agent: i % 2 ? "undici" : "Claude Desktop", reason: i % 9 === 4 ? "笔记不存在" : undefined });
})();

/* AuthZ — capability catalog (scope / toolset / tool / resource) */
const CAPS = [
  { g: "all", name: "全部能力", items: [{ k: "all", n: "全部", d: "所有 Scope、工具与资源" }] },
  { g: "scope", name: "权限范围", items: SCOPES.map((s) => ({ k: "scope:" + s.key, n: s.name, d: s.desc })) },
  { g: "toolset", name: "工具集", items: [
    { k: "toolset:notes", n: "笔记", d: "读写、移动、删除笔记" }, { k: "toolset:search", n: "检索", d: "关键词 / 语义检索" },
    { k: "toolset:files", n: "文件", d: "附件上传与下载" }, { k: "toolset:git", n: "Git", d: "提交、推送、日志" },
    { k: "toolset:publish", n: "发布", d: "公开分享笔记" }, { k: "toolset:memory", n: "记忆", d: "capture / recall" } ] },
  { g: "tool", name: "单个工具", items: [
    { k: "tool:get_note", n: "读取笔记" }, { k: "tool:write_note", n: "写入笔记" }, { k: "tool:delete_note", n: "删除笔记" },
    { k: "tool:list_notes", n: "列出笔记" }, { k: "tool:search_notes", n: "搜索笔记" }, { k: "tool:git_commit", n: "Git 提交" },
    { k: "tool:git_push", n: "Git 推送" }, { k: "tool:manage_publish", n: "管理发布" } ] },
  { g: "resource", name: "资源", items: [{ k: "resource:vault://notes", n: "笔记资源" }, { k: "resource:vault://files", n: "文件资源" }] },
];
const TIMEZONES = ["Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "UTC"];
const POLICIES = [
  { id: "4f2a9c1e-7b3d-4e86-a0f5-9d1c2b8e6a73", label: "Research bot 工作时间", mode: "suspend", enabled: true, timezone: "Asia/Shanghai", startsAt: "", expiresAt: "",
    weekly: [1, 2, 3, 4, 5].map((day) => ({ day, from: "09:00", to: "18:00" })), dateRanges: [], subjects: ["api-key:" + KEYS[1].id], capabilities: ["scope:obsidian.read", "toolset:search"], updatedAt: ago(30 * H) },
  { id: "b81e3d07-c5a2-4f9b-8e64-1a7d0c3f2e95", label: "ChatGPT 仅限国庆后试用", mode: "revoke", enabled: true, timezone: "Asia/Shanghai", startsAt: "2026-10-08T09:00", expiresAt: "2026-10-31T23:59",
    weekly: [], dateRanges: [], subjects: ["oauth-client:" + CLIENTS[1].clientId, "oauth-user:" + ACCOUNTS[1].id], capabilities: ["all"], updatedAt: ago(4 * D) },
  { id: "e7c40b9d-2a18-4d5e-b3f6-08a9e1c7d254", label: "NAS 同步夜间窗口", mode: "suspend", enabled: false, timezone: "Asia/Shanghai", startsAt: "", expiresAt: "",
    weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: "01:00", to: "06:00" })), dateRanges: [{ from: "2026-10-01", to: "2026-10-07" }], subjects: ["api-key:" + KEYS[2].id, "api-key:5a0d7f3e-orphan"], capabilities: ["toolset:git", "tool:write_note"], updatedAt: ago(9 * D) },
];
const AUTHZ = { enabled: true, revision: 3 };
</script>
