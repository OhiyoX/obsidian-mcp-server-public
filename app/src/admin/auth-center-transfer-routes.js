// #364 slice 2 — Admin route for the OAuth authorization transfer.
//
// `POST /admin/auth/oauth/client/transfer` begins the transfer of one
// `(clientId, sourceUserId)` relation to `targetUserId`; `POST
// /admin/auth/oauth/client/transfer/cancel` cancels a pending completion intent.
// Both reuse the Auth Center's existing `requireAdmin` + `requireCsrf` guards, so there
// is no second auth scheme and no CSRF-free JSON shortcut (contract §1.4 / §5.2).
//
// The status codes are NOT re-derived here: the first slice's service throws
// `AuthorizationTransferError { code, status }` with the frozen §5.2 mapping
// (400 invalid_request / 404 not_found / 409 conflict / 503 unavailable) and the route
// only renders it. A rejection happened before any durable write, so the begin error page
// can safely say "not started"; the CANCEL page says something different on purpose — a
// failed cancel changes no committed record and never lifts the existing fence, so it must
// not reuse the begin wording.
//
// Success is a 303 back to the clients tab plus a flash. The wording is frozen by §5.2:
// the source authorization is revoked and the target must re-authorize with the same
// client — the flash must never say the transfer is complete. `degraded` is passed through
// verbatim, but described from the observed session report (see `beginFlash`).

const BEGIN_PATH = "/oauth/client/transfer";
const CANCEL_PATH = "/oauth/client/transfer/cancel";
const CLIENTS_TAB = "clients";

// The service's conflict `message` is the only discriminator it exposes (the code is a
// single `conflict`). These are the exact strings `authorization-transfer-methods.js`
// throws; the target-already-authorized wording is frozen by the seat ruling §17-1.
const CONFLICT_HINTS = Object.freeze({
  "The target account is already authorized for this client": "目标账户已授权该客户端，请先处理其现有授权。转移未发起。",
  "The source account has no active authorization for this client": "源账户对该客户端已无有效授权，无法发起转移。请刷新页面后重试。",
  "The target account is disabled": "目标账户已停用，不能作为转移目标。转移未发起。",
  "The source account already has a pending transfer to a different target": "该源账户已有发往其他目标的待完成转移，请先取消。转移未发起。",
  "The target account already has a pending transfer for this client": "该目标账户已有待完成的转移，请先取消。转移未发起。",
});
const CONFLICT_FALLBACK = "转移请求与当前授权状态冲突，未发起。请刷新页面后重试。";

// The error page is scoped to the action: "begin" and "cancel" describe DIFFERENT
// state. The begin 503 says no source authorization was revoked; reusing that text for a
// failed cancel was wrong — a cancel failure leaves the durable fence in place, so the page
// must say the cancel did not succeed and that the existing fence is not lifted.
const ERROR_PAGES = Object.freeze({
  begin: Object.freeze({
    400: { title: "转移请求无效", message: "提交的客户端、源账户或目标账户字段不合法。转移未发起。" },
    404: { title: "找不到客户端或账户", message: "指定的 OAuth 客户端或账户不存在。转移未发起。" },
    409: { title: "转移未发起", message: CONFLICT_FALLBACK },
    503: { title: "转移存储不可用", message: "转移的持久化存储当前不可写，未撤销源账户授权。请稍后重试。" },
  }),
  cancel: Object.freeze({
    400: { title: "取消请求无效", message: "提交的转移标识不合法，未能成功取消该转移。请刷新页面后重试。" },
    404: { title: "找不到转移记录", message: "指定的转移记录不存在，未能成功取消；既有转移的边界不受影响。" },
    409: { title: "取消失败", message: "该转移的状态与取消请求冲突，未能成功取消。请刷新页面后重试。" },
    503: { title: "取消失败", message: "转移的持久化存储当前不可写，未能成功取消该转移；既有转移的失效边界（fence）不会解除，源账户的旧凭证仍被拒绝。请稍后重试。" },
  }),
});

function clean(value, max = 240) {
  return String(value || "").replace(/[\r\n\0]/g, " ").slice(0, max) || null;
}

function sourceOf(req) {
  return clean(req.ip || req.socket?.remoteAddress, 80);
}

function statusOf(action, error) {
  const status = Number(error?.status);
  return Object.hasOwn(ERROR_PAGES[action], status) ? status : null;
}

function sendFailure(res, view, error, action) {
  const pages = ERROR_PAGES[action] ?? ERROR_PAGES.begin;
  const status = statusOf(action, error) ?? 503;
  const page = pages[status];
  const message = action === "begin" && status === 409 ? (CONFLICT_HINTS[String(error?.message || "")] ?? page.message) : page.message;
  const body = `<section class="card login"><h1>${page.title}</h1><p>${message}</p><p class="muted">错误码 <code>${status}</code></p><p><a class="btn secondary" href="/admin/auth?tab=${CLIENTS_TAB}">返回 OAuth 客户端</a></p></section>`;
  res.status(status).send(view.layout(page.title, body));
}

/**
 * The success flash after a durable begin. §17-5: a degraded note must describe what the
 * session report ACTUALLY said. A degraded begin whose every session closed (the
 * `source_revoke_sync_failed` path) must not be blamed on the session close; a close that
 * did refuse to complete is reported with its own counts. When the return value cannot
 * localise the sync failure, the note stays generic instead of naming a stage. The
 * "old credentials are gone" part never changes.
 */
function beginFlash(result) {
  const sessions = result?.sessions ?? null;
  const failed = Number(sessions?.failed) > 0;
  let degraded = "";
  if (failed) {
    const counts = [];
    if (Number.isFinite(Number(sessions?.matched)) && Number.isFinite(Number(sessions?.closed))) counts.push(`已关闭 ${Number(sessions.closed)}/${Number(sessions.matched)}`);
    counts.push(`未关闭 ${Number(sessions.failed)} 个`);
    degraded = `（源会话关闭未完全成功：${counts.join("，")}，已记录；源账户旧凭证仍被撤销）`;
  } else if (sessions?.unavailable === true) {
    degraded = "（无法确认源会话的关闭结果，已记录；源账户旧凭证仍被撤销）";
  } else if (result?.degraded) {
    degraded = "（本次操作有未完成的同步步骤，已降级记录；源账户旧凭证仍被撤销）";
  }
  return `已发起转移：源授权已撤销，等待目标账户用同一客户端重新授权${degraded}。`;
}

/**
 * `registerAuthorizationTransferRoutes(router, { provider, requireAdmin, requireCsrf, view, setFlash })`.
 * Returns `{ begin, cancel }`, or `null` when the provider has no transfer service (every
 * existing Auth Center test uses a snapshot-only stub, so this is a zero-difference path).
 */
export function registerAuthorizationTransferRoutes(router, {
  provider,
  requireAdmin,
  requireCsrf,
  view,
  setFlash = () => {},
} = {}) {
  if (!provider || typeof provider.beginAuthorizationTransfer !== "function") return null;
  if (typeof view?.layout !== "function") throw new TypeError("registerAuthorizationTransferRoutes requires view.layout (Auth Center page shell)");

  const actor = "admin-session";

  router.post(BEGIN_PATH, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await provider.beginAuthorizationTransfer({
        clientId: String(req.body?.clientId || ""),
        sourceUserId: String(req.body?.sourceUserId || ""),
        targetUserId: String(req.body?.targetUserId || ""),
        actor,
        source: sourceOf(req),
        userAgent: clean(req.headers?.["user-agent"]),
      });
      setFlash(req, beginFlash(result));
      res.redirect(303, `/admin/auth?tab=${CLIENTS_TAB}`);
    } catch (error) {
      if (error?.name !== "AuthorizationTransferError") { next(error); return; }
      sendFailure(res, view, error, "begin");
    }
  });

  router.post(CANCEL_PATH, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await provider.cancelAuthorizationTransfer(String(req.body?.transferId || ""), {
        actor,
        source: sourceOf(req),
        userAgent: clean(req.headers?.["user-agent"]),
      });
      setFlash(req, result?.changed
        ? "已取消待完成转移；源账户的旧凭证不会恢复，目标账户需用同一客户端重新授权。"
        : "该转移已不是待完成状态，无需取消；源账户的旧凭证不会恢复。");
      res.redirect(303, `/admin/auth?tab=${CLIENTS_TAB}`);
    } catch (error) {
      if (error?.name !== "AuthorizationTransferError") { next(error); return; }
      sendFailure(res, view, error, "cancel");
    }
  });

  return { begin: BEGIN_PATH, cancel: CANCEL_PATH };
}
