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
import { t } from "../../i18n/context.js";
import { readSort, sortRows } from "../table-sort.js";

const TAB = "publishes";
const BASE = "/admin/auth?tab=publishes";
const ACTIVE = "active";

/** Prototype status cell wording (renderPublish L283) + the real lifecycle in `title`. */
const STATUS = Object.freeze({
  active: { labelKey: "adm.publishes.status.active", cls: "ok", titleKey: "adm.publishes.statusTitle.active" },
  orphaned: { labelKey: "adm.publishes.status.orphaned", cls: "amber", titleKey: "adm.publishes.statusTitle.orphaned" },
  invalid: { labelKey: "adm.publishes.status.invalid", cls: "amber", titleKey: "adm.publishes.statusTitle.invalid" },
  unknown: { labelKey: "adm.publishes.status.unknown", cls: "off", titleKey: "adm.publishes.statusTitle.unknown" },
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
    url ? { href: url, label: t("adm.publishes.menu.open"), icon: "ext" } : null,
    { href: href({ confirm: "publish-revoke", id: String(record?.id || "") }), label: t("adm.publishes.menu.revoke"), icon: "ban", danger: true },
  ].filter(Boolean);
}

function stateOf(record) {
  const status = STATUS[record?.lifecycle];
  return status
    ? { cls: status.cls, label: t(status.labelKey), title: t(status.titleKey) }
    : { cls: "off", label: t("adm.label.unknownPublish"), title: t("adm.publishes.statusTitle.missing") };
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
  if (raw === "admin-session") return { name: t("adm.label.credential.admin"), kind: t("adm.publishes.actor.admin") };
  const cut = raw.indexOf(":");
  const scheme = cut < 0 ? "" : raw.slice(0, cut);
  const rest = cut < 0 ? raw : raw.slice(cut + 1);
  if (scheme === "web") return { name: rest || "—", kind: t("adm.publishes.actor.webUser") };
  if (scheme === "admin") return { name: t("adm.label.credential.admin"), kind: t("adm.publishes.actor.admin") };
  if (scheme === "mcp") {
    const client = model.client(rest);
    if (client) return { name: model.clientName(client), kind: t("adm.label.credential.oauth-client") };
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const agent = rest.slice(0, slash);
      const version = rest.slice(slash + 1);
      return { name: agent || "—", kind: version ? `MCP · ${version}` : t("adm.publishes.actor.mcpClient") };
    }
    return { name: rest || "—", kind: t("adm.publishes.actor.mcpClient") };
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
    ? `<a class="ibtn" style="display:inline-grid;vertical-align:middle" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(t("adm.publishes.menu.open"))}">${ic("link")}</a>`
    : "";
  const stamp = record?.createdAt
    ? `<span title="${esc(`${t("adm.publishes.stampPublished", { time: fmtFull(record.createdAt) })}${record.updatedAt ? t("adm.publishes.stampUpdated", { time: fmtFull(record.updatedAt) }) : ""}`)}">${esc(rel(record.createdAt))}</span>`
    : "—";
  return `<tr class="${record?.lifecycle === ACTIVE ? "" : "dim"}">
<td><div class="nm"><b>${esc(docTitle(path))}</b><span class="sub2"><span class="tag acc" title="Vault id: ${esc(record?.vaultId || "")}">${esc(ctx.model.vaultLabel(record?.vaultId) || record?.vaultId || "—")}</span><span class="mono ell" title="${esc(path)}">${esc(path || "—")}</span></span></div></td>
<td><span class="st ${esc(state.cls)}" title="${esc(state.title)}"><span class="dot"></span>${esc(state.label)}</span></td>
<td class="cellt"><span class="mono">/publish/${esc(id.slice(0, 6))}…</span> ${link}</td>
<td class="cellt">${esc(actor.name)}<div class="muted">${esc(actor.kind || "—")}</div></td>
<td class="cellt">${stamp}<div class="muted futonly">${fut(t("adm.publishes.plannedViews"))}</div></td>
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
    ? `${esc(t("adm.publishes.revokeBody"))}${retired ? esc(t("adm.publishes.revokeBodyRetired", { reason: state.title })) : ""}`
    : esc(t("adm.publishes.revokeMissing"));
  return confirmPage({
    title: t("adm.publishes.revokeTitle", { name: docTitle(record?.path) }),
    bodyHtml: body,
    listItems: record
      ? [
        `${esc(t("adm.publishes.revokeDoc"))} <span class="mono">${esc(String(record.path || "—"))}</span>`,
        `${esc(t("adm.publishes.revokeId"))} <span class="mono">${esc(id || "—")}</span>`,
        t("adm.publishes.revokeMeta", { status: esc(state.label), published: esc(fmtFull(record.createdAt)) }),
      ]
      : [`${esc(t("adm.publishes.revokeId"))} <span class="mono">${esc(id || "—")}</span>`],
    ok: t("adm.publishes.revokeOk"),
    action: "/admin/auth/publish/revoke",
    csrf: ctx.csrf,
    fields: { id },
    backHref: BASE,
  });
}

export function renderPublishesPage(ctx) {
  const publications = Array.isArray(ctx.publications) ? ctx.publications : [];
  // Sorting is server state (`table-sort.js`): the header link carries it, this page decides on it.
  const sort = readSort(ctx.query ?? {}, ["doc", "status", "link", "publisher", "published"], "doc");
  const listed = sortRows(publications, sort, {
    doc: (record) => record?.title || record?.path || record?.docId || null,
    status: (record) => record?.lifecycle ?? null,
    link: (record) => record?.url || record?.slug || null,
    publisher: (record) => record?.publishedBy || record?.author || null,
    published: (record) => record?.publishedAt ?? record?.updatedAt ?? null,
  });
  const retired = publications.filter((record) => record?.lifecycle !== ACTIVE);
  const unknown = publications.filter((record) => record?.lifecycle !== ACTIVE && !STATUS[record?.lifecycle]);

  const bannerHtml = retired.length
    ? `<div class="banner amber">${ic("alert")}<div>${t("adm.publishes.banner", { count: retired.length })}${unknown.length ? `<div style="margin-top:6px">${esc(t("adm.publishes.bannerUnknown", { count: unknown.length }))}</div>` : ""}</div></div>`
    : "";

  const content = `${pageBar({ title: t("adm.nav.publishes"), count: publications.length })}<div class="content scroll"><div class="page">
<p class="lede">${esc(t("adm.publishes.lede"))}</p>
${bannerHtml}
${table([[t("adm.publishes.column.doc"), "30%", "", "doc"], [t("adm.publishes.column.status"), "18%", "", "status"], [t("adm.publishes.column.link"), "16%", "", "link"], [t("adm.publishes.column.publisher"), "16%", "", "publisher"], [t("adm.publishes.column.published"), "14%", "", "published"], ["", "", "act"]], listed.map((record, index) => row(ctx, record, { index, rows: listed.length })), emptyState("globe", t("adm.publishes.emptyTitle"), t("adm.publishes.emptyHint")), { ...sort, base: BASE })}${mcards(listed.map((record) => card(ctx, record)))}
</div></div>`;
  const detailPanel = String(ctx.query?.confirm || "") === "publish-revoke" ? confirmRevoke(ctx) : "";
  return { content, detailPanel };
}
