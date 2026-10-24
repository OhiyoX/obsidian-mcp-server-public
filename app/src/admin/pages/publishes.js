// 发布文档 — port of `docs/admin-ui-proto/src/5-render.js` `renderPublish()` (L280–L311).
//
// Data is exactly `PublishService.list({ includeInactive: true })` as assembled by `catalog.js`:
// the service owns the lifecycle (`lifecycle.js`), this page only renders the field it already
// publishes, so a row and its status can never disagree. Retired records stay visible so they can
// be revoked (§9), and a retired row is never drawn as a working public link.
//
// Honest-data notes:
//   * the service publishes no document *title*, so the primary line is the file name derived from
//     `path` (the full path stays visible beside it, and in `title`);
//   * the service publishes no view counter, so the prototype's "N 次访问" keeps only its
//     `futonly` 规划中 marker — no number is invented;
//   * the actor is the real `createdBy` string (`web:<user>`, `mcp:<agent>/<model>`,
//     `mcp:<clientId>`, `admin-session`), never a guessed publisher.
import { pageBar, emptyState, table, mcards, moreMenu, confirmPage, esc, fut, ic } from "../ui.js";
import { fmtFull, rel } from "../presentation/format.js";

const TAB = "publishes";
const BASE = "/admin/auth?tab=publishes";
const ACTIVE = "active";

/** Prototype status cell wording (renderPublish L283) + the real lifecycle in `title`. */
const STATUS = Object.freeze({
  active: { label: "公开中", cls: "ok", title: "active：匿名链接可访问" },
  orphaned: { label: "已失效 · 源笔记不存在", cls: "amber", title: "orphaned：源笔记已不存在" },
  invalid: { label: "已失效 · 不再是 Markdown", cls: "amber", title: "invalid：目标不再是 Markdown" },
  unknown: { label: "待确认", cls: "off", title: "unknown：尚未观测到目标状态" },
});

function href(params = {}) {
  const search = new URLSearchParams({ tab: TAB });
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return `/admin/auth?${search.toString()}`;
}

/**
 * Row menu. Same two shared clipping rules as the token page: the prototype's
 * `.tbl td{overflow:hidden}` and `assets/ssr-css.js`'s `.tw{overflow-x:auto}`. The action cell is
 * switched back to `overflow:visible` and the panel opens on whichever side of the row it fits on.
 * See CHECKPOINT.md for the shared fix this works around.
 */
function rowMenu(items, { up = false } = {}) {
  const menu = moreMenu(items);
  if (!up) return menu;
  return menu.replace('<div class="menu" role="menu">', '<div class="menu" role="menu" style="top:auto;bottom:calc(100% + 4px)">');
}

const ACT_CELL = '<td class="act" style="overflow:visible">';

/** Measured geometry behind the fit check: `.tbl` row ≈62px, `.tbl th` = 36px, `.menu` item = 32px. */
const ROW_H = 62;
const HEAD_H = 36;

/** Open upwards only when downwards cannot hold the panel and upwards has more room. */
function openUpwards(index, rows, items) {
  const need = items * 32 + 16;
  const below = (rows - index - 1) * ROW_H;
  const above = index * ROW_H + HEAD_H;
  return below < need && above > below;
}

/** Menu entries: open the public page (only when it is reachable) + revoke the link. */
function recordMenuItems(ctx, record, url) {
  return [
    url ? { href: url, label: "打开公开页", icon: "ext" } : null,
    { href: href({ confirm: "publish-revoke", id: String(record?.id || "") }), label: "撤销公开链接…", icon: "ban", danger: true },
  ].filter(Boolean);
}

function stateOf(record) {
  return STATUS[record?.lifecycle] || { label: "状态未知", cls: "off", title: "lifecycle：未提供" };
}

/** The file name of the published note (`path`), used as the honest stand-in for a title. */
function docTitle(path) {
  const base = String(path || "").split("/").pop() || "";
  return base.replace(/\.md$/i, "") || base || "—";
}

/** `createdBy` → publisher name + its technical kind, per the prototype's two-line cell. */
function actorView(model, createdBy) {
  const raw = String(createdBy || "");
  if (!raw) return { name: "—", kind: "" };
  // The Admin route module records the literal actor `admin-session` (no `<scheme>:` prefix).
  if (raw === "admin-session") return { name: "管理员会话", kind: "管理操作" };
  const cut = raw.indexOf(":");
  const scheme = cut < 0 ? "" : raw.slice(0, cut);
  const rest = cut < 0 ? raw : raw.slice(cut + 1);
  if (scheme === "web") return { name: rest || "—", kind: "Web 用户" };
  if (scheme === "admin") return { name: "管理员会话", kind: "管理操作" };
  if (scheme === "mcp") {
    const client = model.client(rest);
    if (client) return { name: model.clientName(client), kind: "OAuth 客户端" };
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const agent = rest.slice(0, slash);
      const version = rest.slice(slash + 1);
      return { name: agent || "—", kind: version ? `MCP · ${version}` : "MCP 客户端" };
    }
    return { name: rest || "—", kind: "MCP 客户端" };
  }
  return { name: raw, kind: "" };
}

function publicHref(ctx, record) {
  const base = String(ctx.publicBaseUrl || "").replace(/\/+$/, "");
  if (!base || record?.lifecycle !== ACTIVE || !record?.id) return "";
  return `${base}/publish/${encodeURIComponent(String(record.id))}`;
}

function row(ctx, record, { index = 0, rows = 1 } = {}) {
  const state = stateOf(record);
  const path = String(record?.path || "");
  const actor = actorView(ctx.model, record?.createdBy);
  const id = String(record?.id || "");
  const url = publicHref(ctx, record);
  const link = url
    ? `<a class="ibtn" style="display:inline-grid;vertical-align:middle" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="打开公开页">${ic("link")}</a>`
    : "";
  const stamp = record?.createdAt
    ? `<span title="${esc(`发布 ${fmtFull(record.createdAt)}${record.updatedAt ? ` · 更新 ${fmtFull(record.updatedAt)}` : ""}`)}">${esc(rel(record.createdAt))}</span>`
    : "—";
  return `<tr class="${record?.lifecycle === ACTIVE ? "" : "dim"}">
<td><div class="nm"><b>${esc(docTitle(path))}</b><span class="sub2"><span class="tag acc" title="Vault id: ${esc(record?.vaultId || "")}">${esc(ctx.model.vaultLabel(record?.vaultId) || record?.vaultId || "—")}</span><span class="mono ell" title="${esc(path)}">${esc(path || "—")}</span></span></div></td>
<td><span class="st ${esc(state.cls)}" title="${esc(state.title)}"><span class="dot"></span>${esc(state.label)}</span></td>
<td class="cellt"><span class="mono">/publish/${esc(id.slice(0, 6))}…</span> ${link}</td>
<td class="cellt">${esc(actor.name)}<div class="muted">${esc(actor.kind || "—")}</div></td>
<td class="cellt">${stamp}<div class="muted futonly">${fut("访问统计")}</div></td>
${ACT_CELL}${rowMenu(recordMenuItems(ctx, record, url), { up: openUpwards(index, rows, 2) })}</td></tr>`;
}

function card(ctx, record) {
  const state = stateOf(record);
  const actor = actorView(ctx.model, record?.createdBy);
  return `<div class="mc"><div class="b"><div class="nm"><b>${esc(docTitle(record?.path))}</b><span class="sub2">${esc(ctx.model.vaultLabel(record?.vaultId) || record?.vaultId || "—")} · ${esc(record?.path || "—")}</span></div><div class="meta"><span class="st ${esc(state.cls)}"><span class="dot"></span>${esc(state.label)}</span><span>${esc(actor.name)}</span><span>${esc(rel(record?.createdAt))}</span></div></div>${rowMenu(recordMenuItems(ctx, record, publicHref(ctx, record)), { up: false })}</div>`;
}

function confirmRevoke(ctx) {
  const id = String(ctx.query?.id || "");
  const record = (ctx.publications || []).find((item) => String(item?.id || "") === id) || null;
  const state = stateOf(record);
  const retired = record && record.lifecycle !== ACTIVE;
  const body = record
    ? `匿名访问者将立即无法打开此链接；笔记本身不受影响。之后重新发布会生成新的链接。${retired ? `该记录已失效（${esc(state.title)}），撤销只会清理这条记录。` : ""}`
    : "该发布记录已不存在，撤销只会返回空结果。";
  return confirmPage({
    title: `撤销「${docTitle(record?.path)}」的公开链接？`,
    bodyHtml: body,
    listItems: record
      ? [
        `文档：<span class="mono">${esc(String(record.path || "—"))}</span>`,
        `公开 ID：<span class="mono">${esc(id || "—")}</span>`,
        `状态：${esc(state.label)} · 发布：${esc(fmtFull(record.createdAt))}`,
      ]
      : [`公开 ID：<span class="mono">${esc(id || "—")}</span>`],
    ok: "撤销链接",
    action: "/admin/auth/publish/revoke",
    csrf: ctx.csrf,
    fields: { id },
    backHref: BASE,
  });
}

export function renderPublishesPage(ctx) {
  const publications = Array.isArray(ctx.publications) ? ctx.publications : [];
  const retired = publications.filter((record) => record?.lifecycle !== ACTIVE);
  const unknown = publications.filter((record) => record?.lifecycle !== ACTIVE && !STATUS[record?.lifecycle]);

  const bannerHtml = retired.length
    ? `<div class="banner amber">${ic("alert")}<div><b>${retired.length} 条记录已失效</b>：源笔记被删除或不再是 Markdown，链接已无法访问。撤销即可清理记录。${unknown.length ? `<div style="margin-top:6px">其中 ${unknown.length} 条记录状态待确认：尚未观测到目标状态。</div>` : ""}</div></div>`
    : "";

  const content = `${pageBar({ title: "发布文档", count: publications.length })}<div class="content scroll"><div class="page">
<p class="lede">跨 Vault 统一管理匿名公开链接。仅展示元数据，不读取或渲染正文；只有「公开中」的文档可被匿名访问。</p>
${bannerHtml}
${table([["文档", "30%"], ["状态", "18%"], ["公开链接", "16%"], ["发布者", "16%"], ["发布时间", "14%"], ["", "", "act"]], publications.map((record, index) => row(ctx, record, { index, rows: publications.length })), emptyState("globe", "还没有公开的文档", "在 Web 端或通过 MCP 发布笔记后会出现在这里"))}${mcards(publications.map((record) => card(ctx, record)))}
</div></div>`;
  const detailPanel = String(ctx.query?.confirm || "") === "publish-revoke" ? confirmRevoke(ctx) : "";
  return { content, detailPanel };
}
