// #364 slice 2 — Admin projection + view for OAuth authorization transfers.
//
// Pure, framework-free helpers for the "OAuth 客户端" tab. Two rules from the frozen
// contract shape everything here:
//
// 1. §4.5 — the *fenced* relation is decided by `applyAuthorizationTransferFence`
//    (see `./auth-center-oauth-linkage.js`), never by string-filtering the HTML.
//    This module consumes the already-overlaid snapshot; it never re-derives the fence.
// 2. §11.5 — the `pending` TTL is a LAZY deadline. When the expiry sweep could not be
//    written, the committed record is still `pending` with a past `expiresAt`. The
//    projection must distinguish that from a live pending: it may say the deadline has
//    passed, but it must NOT claim the expiry landed and must not offer completion.
//    `healthy` is not consulted here either — it never means "writable".
//
// `loadAdminProjection` is the single seam the router uses: fetch the transfer snapshot
// (which sweeps the expired intents and audits each `expire`), apply the fence overlay,
// and hand the clients tab the transfer rows plus one stable `now`.

import { applyAuthorizationTransferFence, linkedOAuthAccountsForClient } from "./auth-center-oauth-linkage.js";

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Display label for an OAuth account id; a deleted account stays explicit. */
export function transferAccountLabel(snapshot, userId) {
  const wanted = String(userId ?? "");
  const user = (Array.isArray(snapshot?.oauthUsers) ? snapshot.oauthUsers : []).find((item) => String(item?.id ?? "") === wanted);
  if (!user) return wanted || "已删除账户";
  const display = String(user.displayName || "").trim() || String(user.username || "").trim();
  return display || wanted || "已删除账户";
}

function accountOptions(accounts, { placeholder = null } = {}) {
  const options = accounts.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(transferAccountLabel({ oauthUsers: [user] }, user.id))}</option>`);
  if (placeholder) options.unshift(`<option value="">${escapeHtml(placeholder)}</option>`);
  return options.join("");
}

/** Transfers for one client whose record is still `pending` (regardless of deadline). */
export function pendingTransfersFor(clientId, transfers) {
  return (Array.isArray(transfers) ? transfers : [])
    .filter((transfer) => transfer?.clientId === clientId && transfer.status === "pending")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

/** A pending record whose deadline has passed but whose expiry is not committed yet. */
export function isUnpersistedExpiry(transfer, now) {
  return transfer?.status === "pending" && Number.isFinite(now) && Date.parse(transfer.expiresAt) <= now;
}

/**
 * The "已授权账户" cell addendum. The literal pending wording is frozen by §17-1:
 * 「转移待 <target> 重新授权」. A deadline that has passed without a durable expiry is
 * reported separately and never as a live pending.
 */
export function pendingTransferNotice({ clientId, snapshot, transfers, now }) {
  return pendingTransfersFor(clientId, transfers).map((transfer) => {
    const target = transferAccountLabel(snapshot, transfer.targetUserId);
    if (isUnpersistedExpiry(transfer, now)) {
      return `<span class="bad">转移期限已过（记录仍为 pending，尚未落盘，不可完成）；目标 ${escapeHtml(target)} 尚未重新授权</span>`;
    }
    return `<span class="badge">转移待 ${escapeHtml(target)} 重新授权</span>`;
  }).join("<br>");
}

/** The "操作" cell addendum: cancel forms for live/expired pendings + the begin form. */
export function transferControls({ client, snapshot, transfers, now, csrf, action = "/admin/auth/oauth/client/transfer", cancelAction = "/admin/auth/oauth/client/transfer/cancel" }) {
  const clientId = String(client?.clientId ?? "");
  if (!clientId) return "";
  const pending = pendingTransfersFor(clientId, transfers);
  const cancelForms = pending.map((transfer) => {
    const target = transferAccountLabel(snapshot, transfer.targetUserId);
    const expired = isUnpersistedExpiry(transfer, now);
    return `<form class="inline" method="post" action="${escapeHtml(cancelAction)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="transferId" value="${escapeHtml(transfer.id)}"><button class="btn secondary" type="submit">取消待完成转移（${escapeHtml(target)}）</button></form><p class="muted">取消只停止自动完成${expired ? "；该记录已过期限" : ""}，不会恢复源账户的旧凭证。</p>`;
  }).join("");
  const accounts = Array.isArray(snapshot?.oauthUsers) ? snapshot.oauthUsers : [];
  const currentIds = new Set(linkedOAuthAccountsForClient(client, snapshot).map((account) => account.id));
  const pendingSourceIds = new Set(pending.map((transfer) => String(transfer.sourceUserId)));
  const sources = accounts.filter((user) => currentIds.has(String(user.id)) && !user.disabledAt && !pendingSourceIds.has(String(user.id)));
  const targets = accounts.filter((user) => !user.disabledAt && !currentIds.has(String(user.id)));
  if (!sources.length) return cancelForms || '<p class="muted">无可发起转移的源账户</p>';
  if (!targets.length) return `${cancelForms}<p class="muted">无可选目标账户：需要存在、未停用、且当前未授权该客户端的 OAuth 账户。</p>`;
  // §5.1: with several current accounts the source must be chosen explicitly, never defaulted.
  const sourceOptions = accountOptions(sources, sources.length > 1 ? { placeholder: "请选择源账户" } : {});
  const targetOptions = accountOptions(targets, { placeholder: "请选择目标账户" });
  return `${cancelForms}<details class="transfer"><summary>转移授权账户</summary><form class="scope-form" method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="clientId" value="${escapeHtml(clientId)}"><label>源账户<select name="sourceUserId">${sourceOptions}</select></label><label>目标账户<select name="targetUserId">${targetOptions}</select></label><button class="btn danger" type="submit">发起转移</button><p class="muted">发起后源账户的旧凭证立即永久失效；目标账户必须用同一客户端重新登录并同意，不继承任何 Scope / Vault。</p></form></details>`;
}

/**
 * Router seam: fetch + sweep + overlay in one place. Returns the overlaid credential
 * snapshot, the committed transfer rows and the `now` the render used, so a page
 * render cannot accidentally show a fence it did not apply.
 */
export async function loadAdminProjection(provider, snapshot, now = Date.now()) {
  if (typeof provider?.authorizationTransferSnapshot !== "function") {
    return { snapshot, transfers: [], available: false, now };
  }
  const transferSnapshot = await provider.authorizationTransferSnapshot();
  return {
    snapshot: applyAuthorizationTransferFence(snapshot, transferSnapshot),
    transfers: Array.isArray(transferSnapshot?.transfers) ? transferSnapshot.transfers : [],
    available: transferSnapshot?.available === true,
    now,
  };
}
