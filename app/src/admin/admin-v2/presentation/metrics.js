// Admin UI v2 W2: overview metric card view-model (proto labels).
function clean(value) {
  if (value == null) return "";
  return String(value).trim();
}

export function presentMetric(input) {
  const id = clean(input?.id);
  const label = clean(input?.label) || id || "指标";
  const source = clean(input?.source);
  const explicitUnavailable = input?.unavailable === true;
  const hasNumber = typeof input?.value === "number" && Number.isFinite(input.value);
  const unavailable = explicitUnavailable || !hasNumber;
  return Object.freeze({
    id,
    label,
    value: unavailable ? null : input.value,
    unavailable,
    source: source || "unspecified",
    asOf: input?.asOf == null || input.asOf === "" ? null : String(input.asOf),
    window: input?.window == null || input.window === "" ? null : String(input.window),
    href: input?.href == null || input.href === "" ? null : String(input.href),
    warning: input?.warning == null || input.warning === "" ? null : String(input.warning),
    icon: input?.icon || null,
  });
}

export function presentOverviewMetrics({
  accounts, keys, clients, activeTokens, publishActive, audit, authz, vaults,
  asOf = null,
  accessPolicyHref = "/admin/auth/access-policy",
  vaultGitHref = "/admin/auth/vault-git",
} = {}) {
  const cards = [
    presentMetric({ id: "accounts", label: "OAuth 账户", value: accounts, source: "oauthUsers.length", asOf, href: "/admin/auth?tab=accounts", icon: "user" }),
    presentMetric({ id: "keys", label: "API Key", value: keys, source: "apiKeys.length", asOf, href: "/admin/auth?tab=keys", icon: "key" }),
    presentMetric({ id: "clients", label: "OAuth 客户端", value: clients, source: "clients.length", asOf, href: "/admin/auth?tab=clients", icon: "app" }),
    presentMetric({ id: "tokens", label: "有效授权", value: activeTokens, source: "tokens.status=active", asOf, href: "/admin/auth?tab=tokens", icon: "ticket" }),
    presentMetric({ id: "publish", label: "已发布文档", value: publishActive, source: "publish.active", asOf, href: "/admin/auth?tab=publishes", icon: "globe" }),
    presentMetric({ id: "audit", label: "审计记录", value: audit, source: "audit.length", asOf, href: "/admin/auth?tab=audit", icon: "list" }),
    presentMetric(
      authz && typeof authz.value === "number"
        ? { id: "authz", label: "定时授权", value: authz.value, source: authz.source || "access-policy.policies", asOf: authz.asOf ?? asOf, href: accessPolicyHref, warning: authz.warning ?? null, icon: "cal" }
        : { id: "authz", label: "定时授权", unavailable: true, source: authz?.source || "access-policy", asOf: authz?.asOf ?? asOf, href: authz?.href === null ? null : accessPolicyHref, warning: authz?.warning || "未提供策略计数", icon: "cal" },
    ),
    presentMetric(
      vaults && typeof vaults.value === "number"
        ? { id: "vaults", label: "Vault", value: vaults.value, source: vaults.source || "vaultInventory.vaults", asOf: vaults.asOf ?? asOf, href: vaultGitHref, warning: vaults.warning ?? null, icon: "db" }
        : { id: "vaults", label: "Vault", unavailable: true, source: vaults?.source || "vault-git", asOf: vaults?.asOf ?? asOf, href: vaults?.href === null ? null : vaultGitHref, warning: vaults?.warning || "未提供 Vault 计数", icon: "db" },
    ),
  ];
  return Object.freeze(cards);
}
