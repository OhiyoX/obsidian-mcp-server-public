// Admin page dispatch. Each page module returns `{ content, detailPanel }`: `content` is the page
// (including its own `.bar`), `detailPanel` is the optional `?id=` drawer rendered over it.
//
// Every tab is registered here so a page module can be replaced without touching this file.
import { renderOverviewPage } from "./overview.js";
import { renderAccountsPage } from "./accounts.js";
import { renderKeysPage } from "./keys.js";
import { renderClientsPage } from "./clients.js";
import { renderTokensPage } from "./tokens.js";
import { renderPublishesPage } from "./publishes.js";
import { renderAuditPage } from "./audit.js";

export { renderLoginPage, renderLoginLocked, renderLoginFailure, renderCsrfRejected, renderError } from "./login.js";

export const PAGES = Object.freeze({
  overview: renderOverviewPage,
  accounts: renderAccountsPage,
  keys: renderKeysPage,
  clients: renderClientsPage,
  tokens: renderTokensPage,
  publishes: renderPublishesPage,
  audit: renderAuditPage,
});

export function renderAuthTab(activeTab, ctx) {
  const render = PAGES[activeTab];
  if (!render) {
    return {
      content: `<header class="bar"><h1>${activeTab}</h1></header><div class="content scroll"><div class="page"><div class="empty"><div class="ic"><svg class="i" aria-hidden="true"><use href="#i-info"/></svg></div><b>该页面尚未实现</b><span>页面模块 ${activeTab}.js 未注册</span></div></div></div>`,
      detailPanel: "",
    };
  }
  const page = render(ctx) || {};
  return { content: page.content ?? String(page), detailPanel: page.detailPanel || "" };
}
