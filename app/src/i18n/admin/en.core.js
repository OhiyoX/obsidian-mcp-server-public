// Admin plane — English catalog. Must carry exactly the keys of `zh-CN.js`
// (`test/i18n-admin-catalog.test.js`).
//
// Wording follows the same vocabulary the Web surface uses (sign in, Vault, keys)
// so an operator switching planes does not meet two names for one thing.
// Split by area so each catalog file stays inside the 800-line architecture budget.
// Merged (and frozen) by the sibling <locale>.js module; keys stay flat and global.
export default Object.freeze({
  // ---- document / brand ------------------------------------------------------
  "adm.doc.title": "Obsidian MCP · Authorization",

  // ---- sidebar ---------------------------------------------------------------
  "adm.nav.overview": "Overview",
  "adm.nav.accounts": "OAuth accounts",
  "adm.nav.keys": "API keys",
  "adm.nav.clients": "OAuth clients",
  "adm.nav.tokens": "OAuth tokens",
  "adm.nav.publishes": "Published documents",
  "adm.nav.audit": "Audit",
  "adm.nav.accessPolicy": "Scheduled access",
  "adm.nav.vaultGit": "Vaults & Git",
  "adm.nav.group.identity": "Identity & credentials",
  "adm.nav.group.content": "Content & security",
  "adm.nav.group.system": "System",
  "adm.side.subtitle": "Authorization",
  "adm.side.navLabel": "Authorization",
  "adm.side.dialogLabel": "Main navigation",
  "adm.side.closeMenu": "Close menu",
  "adm.side.web": "Open Obsidian Web",
  "adm.side.theme.toLight": "Switch to the light theme",
  "adm.side.theme.toDark": "Switch to the dark theme",
  "adm.side.shortcuts.title": "Shortcuts (?)",
  "adm.side.shortcuts.aria": "Keyboard shortcuts",
  "adm.side.logout": "Sign out",
  "adm.nav.toggle": "Menu",

  // ---- mobile nav ------------------------------------------------------------
  "adm.mnav.label": "Mobile navigation",
  "adm.mnav.more": "More",
  "adm.mnav.short.accessPolicy": "Access",
  "adm.mnav.short.tokens": "Tokens",

  // ---- login / out-of-band pages --------------------------------------------
  "adm.login.heading": "Obsidian MCP Authorization",
  "adm.login.password": "Admin password",
  "adm.login.submit": "Sign in",
  "adm.login.help.before": "This page uses a separate admin password. ",
  "adm.login.help.reject": "It does not accept",
  "adm.login.help.after": " OAuth account passwords, API keys or tokens.",
  "adm.login.locked": "Too many failed attempts: temporarily locked. Try again in {wait}.",
  "adm.login.wrongPassword": "Incorrect password.",
  "adm.login.title": "Obsidian MCP · Authorization",
  "adm.login.lockedTitle": "Too many attempts · Obsidian MCP",
  "adm.login.failedTitle": "Sign-in failed · Obsidian MCP",
  "adm.csrf.title": "Request rejected · Obsidian MCP",
  "adm.csrf.message": "CSRF validation failed: this request was not accepted and nothing was written. Go back to the admin page and try again.",
  "adm.error.title": "Something went wrong",
  "adm.back.list": "Back to list",
  "adm.back.admin": "Back to authorization",
  "adm.foot.deployVersion": "Deployed version",

  // ---- shell notices ---------------------------------------------------------
  "adm.flash.newKey.title": "New API key (shown once)",
  "adm.flash.newKey.help": "This key cannot be viewed again after you leave or reload this page; delete it and create a new one if it is lost.",

  // ---- router error surfaces -------------------------------------------------
  "adm.error.catalog.title": "Service unavailable",
  "adm.error.catalog.heading": "Could not read the admin data",

  // ---- overview page ----------------------------------------------------------
  "adm.overview.stat.grants": "Active grants",
  "adm.overview.stat.grantsTotal": "{count} grant records in total",
  "adm.overview.stat.published": "Published documents",
  "adm.overview.stat.publishedRetired": "{count} orphaned, to clean up",
  "adm.overview.stat.publishedNone": "No orphaned records",
  "adm.overview.stat.audit": "Audit records",
  "adm.overview.stat.auditFailures": "{count} failures in the last 24 h",
  "adm.overview.stat.auditNone": "No failures in the last 24 h",
  "adm.overview.stat.accountsDisabled": "{count} disabled",
  "adm.overview.stat.accountsAllEnabled": "All enabled",
  "adm.overview.stat.keysUnused": "{count} never used",
  "adm.overview.stat.keysUsed": "All used",
  "adm.overview.stat.clientsTransfers": "{count} transfers pending",
  "adm.overview.stat.clientsNone": "Nothing pending",
  "adm.overview.stat.authzDetail": "Enabled / all policies",
  "adm.overview.stat.vaultGit": "{count} with Git enabled",
  "adm.overview.authzBroken": "Policy store error",
  "adm.overview.gitSynced": "Synced",
  "adm.overview.gitLastCommit": "· last commit {time}",
  "adm.overview.gitDisabled": "Git disabled",
  "adm.overview.transferPending": "{client}: authorization transfer pending",
  "adm.overview.transferWaiting": "Waiting for {target} to re-authorize",
  "adm.overview.bruteForce": "{count} failed admin sign-ins",
  "adm.overview.publishOrphaned": "{count} publish records orphaned",
  "adm.overview.publishOrphanedWhy": "The source note was deleted or is no longer Markdown; revoke to clean up",
  "adm.overview.authzOrphaned": "{count} orphaned subjects",
  "adm.overview.authzOrphanedWhy": "The policy references a deleted credential; edit the policy to remove it",
  "adm.overview.vaultNoGit": "{vault} has no Git repository",
  "adm.overview.vaultNoGitWhy": "Version history lives only on this machine",
  "adm.overview.attention": "Needs attention",
  "adm.overview.attentionEmpty": "Nothing needs attention",
  "adm.overview.attentionEmptyWhy": "There are no alerts to handle",
  "adm.overview.recentFailures": "Recent failures",
  "adm.overview.failuresEmpty": "No recent failures",
  "adm.overview.failuresEmptyWhy": "The audit has no failed calls",
  "adm.overview.viewAll": "View all",
  "adm.overview.runtimeStatus": "Runtime status",
  "adm.overview.notes": "Notes",
  "adm.overview.notesBody": "Publish management shows metadata only — Vault, path and time; the admin plane never renders the note body. Changing an OAuth account's permissions or password revokes that account's existing grants.",
  "adm.overview.authzNotConnected": "Not connected",
  "adm.overview.authzEnabled": "Enabled",
  "adm.overview.authzPolicies": "{count} policies in effect",
  "adm.overview.authzRegistered": "Registered but disabled",
  "adm.overview.authzPolicyCount": "{count} policies",
  "adm.overview.lastDeploy": "Last deploy",
  "adm.overview.deployInfo": "deployment info",
  "adm.overview.notDeployed": "Not deployed (local run)",
  "adm.overview.deployedAgo": "deployed {when}",

  "adm.ui.listSeparator": ", ",

});
