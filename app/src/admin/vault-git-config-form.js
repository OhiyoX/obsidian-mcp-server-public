// Per-Vault Git configuration form for the Admin "Vault 与 Git" tab, Wave E / E1, #404.
//
// Split out of `vault-git-view.js` for the architecture line budget. It is still a
// pure renderer: a plain `{ name, value, disabled }` control set and an HTML fragment
// string out. No DOM, no runtime, no validation, no CSRF check, no submit handler, no
// fetch - those stay with Wave E / E2's routes.
//
// #404: every control is labelled with a Chinese
// label plus the canonical config key as a small sub-label (`自动提交` / `autoCommit`) so
// the operator never reads a bare camelCase identifier; the controls are grouped into
// 开关 / 时间参数 / 远端 fieldsets; and the submit button sits in its own
// `.form-actions` row instead of trailing the `branch` input.
//
// `text(value)` is injected by the caller: it is the view's credential-masking text
// pipeline (§42 SEC-MV04), and this module must not grow a second copy of it.
import { GIT_CONFIG_LIMITS } from "../git-config/schema.js";
import { escapeHtml } from "./admin-html.js";

function selectOptions(entries, selected) {
  return entries
    .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function booleanSelect(name, value, disabled) {
  // SSR CSS switch (proto .switch); hidden false + checkbox true so uncheck posts false.
  const on = value === true;
  return `<span class="sw"${disabled ? ' aria-disabled="true"' : ""} title="${on ? "开启" : "关闭"}"><input type="hidden" name="${escapeHtml(name)}" value="false"><input type="checkbox" name="${escapeHtml(name)}" value="true"${on ? " checked" : ""}${disabled ? " disabled" : ""}><span class="switch" aria-hidden="true"></span></span>`;
}

/** Chinese label with the canonical config key as a small sub-label. */
function fieldLabel(label, name) {
  return `<span>${escapeHtml(label)}</span><small>${escapeHtml(name)}</small>`;
}

function numberField(name, label, value, min, max, disabled, text) {
  const attrs = `class="field" type="number" min="${escapeHtml(min)}" max="${escapeHtml(max)}"${disabled ? " disabled" : ""}`;
  return `<label>${fieldLabel(label, name)}<input ${attrs} name="${escapeHtml(name)}" value="${escapeHtml(Number.isInteger(value) ? String(value) : "")}"></label>`;
}

function textField(name, label, value, maxLength, disabled, text) {
  return `<label>${fieldLabel(label, name)}<input class="field" type="text" maxlength="${escapeHtml(maxLength)}"${disabled ? " disabled" : ""} name="${escapeHtml(name)}" value="${text(value)}"></label>`;
}

/**
 * @param {object} args
 * @param {object} args.vault    registry row (only `id` and `editable` are read)
 * @param {object} args.config   effective Git config
 * @param {object} args.urls     action URLs (`save`, `verify`)
 * @param {string} args.csrf     hidden CSRF field markup
 * @param {number|null} args.revision  CAS token rendered into the form
 * @param {(value: unknown) => string} args.text  credential-masking escape
 */
export function configForm({ vault, config, urls, csrf, revision, text }) {
  if (!urls.save) return "";
  const disabled = vault?.editable === false;
  const limits = GIT_CONFIG_LIMITS;
  return `<form class="form-grid" method="post" action="${escapeHtml(urls.save)}">${csrf}
<input type="hidden" name="vaultId" value="${text(vault?.id)}">
${revision === null || revision === undefined ? "" : `<input type="hidden" name="expectedRevision" value="${text(revision)}">`}
<fieldset><legend>开关</legend>
<label>${fieldLabel("启用该 Vault 的 Git", "enabled")}${booleanSelect("enabled", config?.enabled, disabled)}</label>
<label>${fieldLabel("自动提交", "autoCommit")}${booleanSelect("autoCommit", config?.autoCommit, disabled)}</label>
<label>${fieldLabel("自动推送", "autoPush")}${booleanSelect("autoPush", config?.autoPush, disabled)}</label>
<label>${fieldLabel("周期提交", "autoCommitSweep")}${booleanSelect("autoCommitSweep", config?.autoCommitSweep, disabled)}</label>
</fieldset>
<fieldset><legend>时间参数（秒）</legend>
${numberField("debounceSeconds", "提交防抖", config?.debounceSeconds, limits.debounceSecondsMin, limits.debounceSecondsMax, disabled, text)}
${numberField("maxDelaySeconds", "最大延迟", config?.maxDelaySeconds, limits.maxDelaySecondsMin, limits.maxDelaySecondsMax, disabled, text)}
${numberField("sweepIntervalSeconds", "周期 sweep 间隔", config?.sweepIntervalSeconds, limits.sweepIntervalSecondsMin, limits.sweepIntervalSecondsMax, disabled, text)}
</fieldset>
<fieldset><legend>远端</legend>
${textField("remote", "远端名称（不是 URL）", config?.remote, limits.remoteMaxLength, disabled, text)}
${textField("branch", "分支", config?.branch, limits.branchMaxLength, disabled, text)}
</fieldset>
<div class="form-actions"><button class="btn" type="submit"${disabled ? " disabled" : ""}>保存该 Vault 的 Git 配置</button></div>
</form>`;
}

/** Secondary action: the verify button renders only when its route is wired. */
export function verifyForm({ vault, urls, csrf, text }) {
  if (!urls.verify) return "";
  const disabled = vault?.editable === false;
  return `<form class="inline" method="post" action="${escapeHtml(urls.verify)}">${csrf}<input type="hidden" name="vaultId" value="${text(vault?.id)}"><button class="btn secondary" type="submit"${disabled ? " disabled" : ""}>验证仓库与配置</button></form>`;
}
