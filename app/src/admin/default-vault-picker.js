// #642 — reusable Admin selector. This controls routing only; authorization lives server-side.
import { t } from "../i18n/context.js";
import { esc } from "./presentation/format.js";

export function renderDefaultVaultPicker(ctx, { current = null, allowedVaults = [] } = {}) {
  const permitted = new Set(allowedVaults);
  const inventory = (Array.isArray(ctx.vaults) ? ctx.vaults : [])
    .filter((vault) => permitted.has(vault.id));
  const configured = current !== null && current !== undefined;
  const valid = inventory.some((vault) => vault.id === current);
  const options = ['<option value=""' + (!configured ? " selected" : "") + ">" + esc(t("adm.picker.inherit")) + "</option>"];
  for (const vault of inventory) {
    options.push(`<option value="${esc(vault.id)}"${vault.id === current ? " selected" : ""}>${esc(vault.name || vault.id)} (${esc(vault.id)})</option>`);
  }
  if (configured && !valid) {
    options.push(`<option value="${esc(current)}" selected disabled>${esc(t("adm.picker.stale"))}</option>`);
  }
  return `<div class="fld"><label for="default-vault">${esc(t("adm.picker.label"))}</label><select class="sel" id="default-vault" name="defaultVaultId">${options.join("")}</select><span class="help">MCP 调用不指定 vaultId 时使用此库；明确指定其他有权访问的 Vault 仍然有效。默认库不会授予访问权限。</span></div>`;
}
