// Authenticated Admin shell: sidebar + page content + mobile nav (+ `?id=` detail drawer).
// Pages own their own `.bar` (prototype `pageBar`) — this module only composes the frame, the
// server result lines (the prototype's toast) and the drawer that the page returns.
import { deployedVersion } from "../../release-version.js";
import { esc } from "../presentation/format.js";
import { renderDocument, renderAppShell } from "../layout.js";
import { ic } from "../assets/icons.js";

const TITLE = "Obsidian MCP · 授权管理";

/**
 * The narrow-screen navigation state, derived from the request the page was rendered for (Q10).
 *
 * `?nav=1` is the server's open state, so the menu works without the script: the sidebar renders as
 * an overlay with a scrim and the close link goes back to exactly this URL minus `nav`. The toggle's
 * href is the same URL plus `nav=1`. Only authenticated Admin paths are eligible — anything else
 * falls back to the tab root, and the query is rebuilt from `URLSearchParams`, never spliced.
 */
export function navState(request) {
  const raw = String(request?.originalUrl || request?.url || "");
  const at = raw.indexOf("?");
  const rawPath = at < 0 ? raw : raw.slice(0, at);
  const pathname = /^\/admin\/auth(?:[/?]|$)/.test(rawPath) ? rawPath : "/admin/auth";
  const query = new URLSearchParams(at < 0 ? "" : raw.slice(at + 1));
  const open = query.get("nav") === "1";
  query.delete("nav");
  const rest = query.toString();
  const closeHref = `${pathname}${rest ? `?${rest}` : ""}`;
  const openQuery = new URLSearchParams(rest);
  openQuery.set("nav", "1");
  // The toggle must keep every other query parameter: a scriptless user on `?tab=audit` (or `?new=1`,
  // `?tab=accounts&order=asc`) who opens the menu has to land on the SAME page, not the default tab.
  return { open, href: `${pathname}?${openQuery.toString()}`, closeHref };
}

function releaseLabel() {
  try {
    const release = deployedVersion();
    const commit = release?.commit ? release.commit.slice(0, 7) : "";
    return `${esc(release?.version || "—")}${commit ? ` · ${esc(commit)}` : ""}`;
  } catch {
    return "—";
  }
}

export function renderAuthShell({
  activeTab,
  accessPolicyBase,
  vaultGitBase,
  session,
  flashKey,
  flashMessage,
  flashTone = "ok",
  content,
  detailPanel = "",
  theme = "dark",
  navCounts = {},
  navAttention = {},
  request = null,
}) {
  const notices = [
    flashKey
      ? `<div class="content" style="padding-bottom:0"><div class="result ok" role="status">${ic("checkc")}<div><b>新 API Key（仅显示一次）</b><div class="secret" style="margin-top:8px"><code class="grow">${esc(flashKey)}</code></div><div class="help">离开或刷新本页后将无法再次查看；遗失请删除后重新创建。</div></div></div></div>`
      : "",
    flashMessage
      ? `<div class="content" style="padding-bottom:0"><div class="result ${flashTone === "err" ? "err" : "ok"}" role="status">${ic(flashTone === "err" ? "alert" : "checkc")}<div>${esc(flashMessage)}</div></div></div>`
      : "",
  ].join("");
  const nav = navState(request);
  const bodyHtml = renderAppShell({
    activeTab,
    content: detailPanel ? content : content,
    notices,
    theme,
    counts: navCounts,
    attention: navAttention,
    accessPolicyBase,
    vaultGitBase,
    csrf: session?.csrf || "",
    release: releaseLabel(),
    drawerHtml: detailPanel,
    nav,
  });
  return renderDocument({ title: TITLE, theme, bodyHtml, bodyClass: nav.open ? "nav-overlay-open" : "", scripts: ["/admin/auth/assets/admin-client.js"] });
}
