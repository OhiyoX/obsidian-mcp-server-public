// Admin UI v2 W6: Vault/Git list proto helpers (SSR, no JS).
// Proto columns (角色 merged into Vault; 能力 column; 同步方式).
// Forms stay in vault-git-view.js. D0 HOLD.

import { statusPill, rowMenu, pageLede } from "../components.js";
import { futBadge } from "../icons.js";
import { futBox } from "../detail-panel.js";

export function escapeVault(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Proto summary columns — 角色 merged into Vault cell; 配置来源 → panel. */
export const VAULT_LIST_HEADERS = Object.freeze([
  "Vault", "Git 状态", "同步方式", "远端 / 分支", "能力", "操作",
]);

export function vaultIdentityCell(vault, text = escapeVault) {
  const name = vault?.name || vault?.id || "—";
  const id = vault?.id || "";
  const role = vault?.primary ? "主库" : "附加";
  const writable = vault?.writable === true ? "可写" : "只读";
  return `<strong class="label-keep">${text(name)}</strong> <span class="tag">${escapeVault(role)}</span> <span class="muted">${escapeVault(writable)}</span><br><code class="breakable idc" title="${text(id)}">${text(id)}</code>`;
}

export function syncTags(config = {}) {
  const autoCommit = Boolean(config?.autoCommit);
  const autoPush = Boolean(config?.autoPush);
  const sweepOn = config?.autoCommitSweep === true;
  const interval = Number(config?.sweepIntervalSeconds);
  if (!autoCommit && !autoPush && !sweepOn) {
    return `<span class="muted">未启用</span>`;
  }
  const parts = [];
  if (autoCommit) parts.push("自动提交");
  if (autoPush) parts.push("自动推送");
  if (sweepOn) {
    const mins = Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.round(interval / 60)) : null;
    parts.push(mins ? `每 ${mins} 分钟兜底` : "定时兜底");
  }
  return `<span class="keep">${escapeVault(parts.join(" · "))}</span>`;
}

export function gitStatePill(token, label, tone) {
  if (tone === "ok") return `<span class="st ok" data-git-state="${escapeVault(token)}"><span class="dot"></span>${escapeVault(label)}</span>`;
  if (tone === "muted") return `<span class="st off" data-git-state="${escapeVault(token)}"><span class="dot"></span>${escapeVault(label)}</span>`;
  if (tone === "amber") return `<span class="st amber" data-git-state="${escapeVault(token)}"><span class="dot"></span>${escapeVault(label)}</span>`;
  return `<span class="st danger" data-git-state="${escapeVault(token)}"><span class="dot"></span>${escapeVault(label)}</span>`;
}

export function capabilitySummary(vault) {
  const raw = vault?.capabilities;
  if (!Array.isArray(raw) || raw.length === 0) return `<span class="muted">—</span>`;
  const items = raw.map((entry) => {
    if (typeof entry === "string") return { key: entry, available: true };
    if (!entry || typeof entry !== "object") return null;
    return { key: typeof entry.key === "string" ? entry.key : "", available: entry.available === true };
  }).filter((item) => item && item.key);
  if (!items.length) return `<span class="muted">—</span>`;
  const on = items.filter((i) => i.available).length;
  return `<span class="keep">${on} / ${items.length} 可用</span>`;
}

export function vaultRowMenu({ vaultId, base }) {
  const root = base || "/admin/auth/vault-git";
  const id = String(vaultId || "");
  const href = `${root}?id=${encodeURIComponent(id)}#vault-${encodeURIComponent(id)}`;
  const detail = `<a class="btn secondary" href="${escapeVault(href)}">详情与 Git 设置</a>`;
  return rowMenu(`${pageLede("详情在右侧面板（?id=）；表单仍走既有 save/verify CSRF 与 revision CAS。")}${detail}`);
}

export function vaultScanFut() {
  return futBox(`<span class="muted">扫描新 Vault</span> ${futBadge("#437")}`);
}

export function vaultGithubAddFut() {
  return futBox(`<div class="futonly" style="padding:12px;border:1px dashed var(--line);border-radius:8px;margin-top:12px">从 GitHub 仓库添加 Vault ${futBadge("Architecture TODO")}<div class="help">以远端仓库为存储后端的 Vault（规划中：不会创建远端仓库或写入凭据）。</div></div>`);
}
