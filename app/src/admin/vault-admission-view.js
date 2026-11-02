// Bounded Admin-only projection. Content/Git controls keep their separate serving gate.

/**
 * The per-vault confirmation choices. Shared by BOTH bootstrap surfaces — the legacy view's inline form
 * (`renderVaultAdmission`, below) and the live `?confirm=admission` dialog in `pages/vaults.js` — so
 * their `confirm` field names and values can never drift apart.
 */
export function admissionConfirmChoices({ vaults, text }) {
  return vaults.map(vault => `<label><input type="checkbox" name="confirm" value="${text(vault.id)}" ${vault.primary ? "checked" : ""}>${text(vault.id)}</label>`).join(" ");
}

/**
 * The bootstrap form as the LEGACY projection renders it (used by `renderVaultAdmission` only).
 * The live `pages/vaults.js` confirm state does NOT render this markup: it builds `ui.confirmPage`
 * (same helper as the Git repair dialog, so cancel/Esc/geometry are the prototype's) and shares only
 * `admissionConfirmChoices` with this one. The list projection renders no admission section at all
 * before the first initialise, so the page stays byte-comparable with the prototype (which has no
 * admission section: grep 准入 in docs/admin-ui-proto → 0).
 */
export function admissionInitializeForm({ vaults, base, csrf, text }) {
  return `<form method="post" action="${text(base)}/admission/initialize">${csrf}<p>显式确认准入清单（含配置 primary）；未选 secondary 保持 pending。</p>${admissionConfirmChoices({ vaults, text })}<button class="btn" type="submit">初始化准入</button></form>`;
}

export function renderVaultAdmission({ vaults, admission, base, csrf, text }) {
  if (!admission) return "";
  const hidden = id => `${csrf}<input type="hidden" name="vaultId" value="${text(id)}">`;
  const rows = vaults.map(vault => {
    const state = vault.admission ?? {};
    const operation = state.admission === "approved" ? "revoke" : "approve";
    const action = admission.initialized
      ? `<form method="post" action="${text(base)}/admission/${operation}">${hidden(vault.id)}<button class="btn secondary" type="submit">${operation === "revoke" ? "撤销批准" : "批准"}</button></form>` : "等待显式初始化";
    return `<tr data-admission-vault-id="${text(vault.id)}"><td>${text(vault.id)}</td><td>${text(state.admission ?? "unknown")}</td><td>${text(state.status)}</td><td>${text(state.reason ?? "—")}</td><td>${action}</td></tr>`;
  }).join("");
  const initialize = admission.initialized ? "" : admissionInitializeForm({ vaults, base, csrf, text });
  // Bootstrap state (no admissions record yet, discovery off) renders ONLY the initialise form. The
  // decision table is meaningless before the first initialise — every row would read `waiting` — and
  // the prototype has no admission surface at all (grep 准入 in docs/admin-ui-proto → 0), so keeping
  // the small form and adding the table only once real decisions exist is the smallest honest
  // divergence for the shape gate.
  if (!admission.initialized) {
    return `<section class="card" id="vault-admission"><h3>Vault 准入</h3>${initialize}</section>`;
  }
  return `<section class="card" id="vault-admission"><h3>Vault 准入</h3><div class="scroll"><table class="data-table"><thead><tr><th>Vault</th><th>准入决定</th><th>运行状态</th><th>原因</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
