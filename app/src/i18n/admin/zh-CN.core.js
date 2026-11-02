// Admin plane — Simplified Chinese catalog (the default and the fallback).
//
// Copy is byte-identical to the literals the Admin renderers used before i18n, so
// the prototype-parity gate still compares the same Chinese face. Keys use the
// `adm.` prefix so that a key is never confused with an audit action value such as
// `admin.login` (those stay data, not copy).
// Split by area so each catalog file stays inside the 800-line architecture budget.
// Merged (and frozen) by the sibling <locale>.js module; keys stay flat and global.
export default Object.freeze({
  // ---- document / brand ------------------------------------------------------
  "adm.doc.title": "Obsidian MCP · 授权管理",

  // ---- sidebar ---------------------------------------------------------------
  "adm.nav.overview": "概览",
  "adm.nav.accounts": "OAuth 账户",
  "adm.nav.keys": "API Key",
  "adm.nav.clients": "OAuth 客户端",
  "adm.nav.tokens": "OAuth Token",
  "adm.nav.publishes": "发布文档",
  "adm.nav.audit": "审计",
  "adm.nav.accessPolicy": "定时授权",
  "adm.nav.vaultGit": "Vault 与 Git",
  "adm.nav.group.identity": "身份与凭据",
  "adm.nav.group.content": "内容与安全",
  "adm.nav.group.system": "系统",
  "adm.side.subtitle": "授权管理",
  "adm.side.navLabel": "授权管理",
  "adm.side.dialogLabel": "主导航",
  "adm.side.closeMenu": "关闭菜单",
  "adm.side.web": "进入 Obsidian Web",
  "adm.side.theme.toLight": "切换到浅色主题",
  "adm.side.theme.toDark": "切换到深色主题",
  "adm.side.shortcuts.title": "快捷键 (?) /?/",
  "adm.side.shortcuts.aria": "键盘快捷键",
  "adm.side.logout": "退出登录",
  "adm.nav.toggle": "菜单",

  // ---- mobile nav ------------------------------------------------------------
  "adm.mnav.label": "移动导航",
  "adm.mnav.more": "更多",
  "adm.mnav.short.accessPolicy": "定时",
  "adm.mnav.short.tokens": "Token",

  // ---- login / out-of-band pages --------------------------------------------
  "adm.login.heading": "Obsidian MCP 授权管理",
  "adm.login.password": "管理密码",
  "adm.login.submit": "登录",
  "adm.login.help.before": "这里使用独立的管理密码，",
  "adm.login.help.reject": "不接受",
  "adm.login.help.after": " OAuth 账户密码、API Key 或 Token。",
  "adm.login.locked": "连续失败次数过多，已临时锁定，请 {wait}后再试。",
  "adm.login.wrongPassword": "密码不正确。",
  "adm.login.title": "Obsidian MCP · 授权管理",
  "adm.login.lockedTitle": "尝试过多 · Obsidian MCP",
  "adm.login.failedTitle": "登录失败 · Obsidian MCP",
  "adm.csrf.title": "请求被拒绝 · Obsidian MCP",
  "adm.csrf.message": "CSRF 校验失败：本次请求未被接受，未发生任何写入。请返回管理页面重新操作。",
  "adm.error.title": "出错了",
  "adm.back.list": "返回列表",
  "adm.back.admin": "返回授权管理",
  "adm.foot.deployVersion": "部署版本",

  // ---- shell notices ---------------------------------------------------------
  "adm.flash.newKey.title": "新 API Key（仅显示一次）",
  "adm.flash.newKey.help": "离开或刷新本页后将无法再次查看；遗失请删除后重新创建。",

  // ---- router error surfaces -------------------------------------------------
  "adm.error.catalog.title": "服务暂不可用",
  "adm.error.catalog.heading": "读取管理数据失败",

  // ---- overview page ----------------------------------------------------------
  "adm.overview.stat.grants": "有效授权",
  "adm.overview.stat.grantsTotal": "共 {count} 次授权记录",
  "adm.overview.stat.published": "已发布文档",
  "adm.overview.stat.publishedRetired": "{count} 条已失效待清理",
  "adm.overview.stat.publishedNone": "无失效记录",
  "adm.overview.stat.audit": "审计记录",
  "adm.overview.stat.auditFailures": "24 小时内 {count} 次失败",
  "adm.overview.stat.auditNone": "24 小时内无失败",
  "adm.overview.stat.accountsDisabled": "{count} 个已停用",
  "adm.overview.stat.accountsAllEnabled": "全部启用",
  "adm.overview.stat.keysUnused": "{count} 个从未调用",
  "adm.overview.stat.keysUsed": "均有调用",
  "adm.overview.stat.clientsTransfers": "{count} 个转移待完成",
  "adm.overview.stat.clientsNone": "无待处理",
  "adm.overview.stat.authzDetail": "已启用策略 / 全部",
  "adm.overview.stat.vaultGit": "{count} 个启用 Git",
  "adm.overview.authzBroken": "策略存储异常",
  "adm.overview.gitSynced": "已同步",
  "adm.overview.gitLastCommit": "· 最近提交 {time}",
  "adm.overview.gitDisabled": "未启用 Git",
  "adm.overview.transferPending": "{client} 授权转移待完成",
  "adm.overview.transferWaiting": "等待 {target} 重新授权",
  "adm.overview.bruteForce": "管理登录失败 {count} 次",
  "adm.overview.publishOrphaned": "{count} 条发布记录已失效",
  "adm.overview.publishOrphanedWhy": "源笔记已删除或不再是 Markdown，可撤销清理",
  "adm.overview.authzOrphaned": "{count} 个孤立主体",
  "adm.overview.authzOrphanedWhy": "策略引用了已删除的凭据，建议编辑策略移除",
  "adm.overview.vaultNoGit": "{vault} 未初始化 Git 仓库",
  "adm.overview.vaultNoGitWhy": "版本历史仅保存在本机",
  "adm.overview.attention": "需要关注",
  "adm.overview.attentionEmpty": "暂无需要关注的项",
  "adm.overview.attentionEmptyWhy": "当前没有需要处理的告警",
  "adm.overview.recentFailures": "最近失败",
  "adm.overview.failuresEmpty": "最近无失败记录",
  "adm.overview.failuresEmptyWhy": "审计中没有失败的调用",
  "adm.overview.viewAll": "查看全部",
  "adm.overview.runtimeStatus": "运行状态",
  "adm.overview.notes": "说明",
  "adm.overview.notesBody": "Publish 管理只显示 Vault、路径和时间等元数据，不在管理端渲染正文。所有修改 OAuth 账户权限、改密的操作都会撤销该账户已有授权。",
  "adm.overview.authzNotConnected": "未接入",
  "adm.overview.authzEnabled": "已启用",
  "adm.overview.authzPolicies": "{count} 条策略生效",
  "adm.overview.authzRegistered": "已注册但未启用",
  "adm.overview.authzPolicyCount": "{count} 条策略",
  "adm.overview.lastDeploy": "上次部署",
  "adm.overview.deployInfo": "部署信息",
  "adm.overview.notDeployed": "未部署（本地运行）",
  "adm.overview.deployedAgo": "{when}部署",

  "adm.ui.listSeparator": "、",

});
