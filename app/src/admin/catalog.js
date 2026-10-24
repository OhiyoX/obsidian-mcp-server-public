// Admin data layer: assemble one request's view model from the real services.
//
// This module owns *data*, never markup: it is the single place where the Admin plane reads
// `provider.authorizationSnapshot()`, the publish service, the Vault registry / Git admin model and
// the access-policy admin store, and it is the only place that decides what a page may see.
//
// Honesty rules (mirrors the contract's D5): a value the service did not provide stays unknown
// (`unavailable`), a disabled feature is never reported as an error, and nothing is inferred from
// a missing field. No credential secret ever passes through this layer except the one-time API Key
// value, which the router stores on the session and this module never touches.
import { loadAdminProjection } from "./auth-center-transfer-view.js";
import { publishRecordCounts } from "./publish-view.js";
import { mergeTokenGrants } from "./grants.js";
import { capabilityCatalog } from "./capabilities.js";
import { createModel } from "./presentation/model.js";
import { parseCookies } from "./http.js";

const DAY = 24 * 3600 * 1000;

/** The synthetic `configured-env` API Key: real only when the deployment configures one, and its
 *  last-use facts come from the recorded usage (never invented). */
function configuredEnvKey(vaults, usage = {}) {
  return {
    id: "configured-env",
    label: "环境配置 API_KEY",
    prefix: "不可显示",
    createdAt: null,
    lastUsedAt: usage.lastUsedAt || null,
    lastSource: usage.lastSource || null,
    allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
    allowedVaults: vaults.filter((item) => item.primary).map((item) => item.id),
    immutable: true,
  };
}

function isFailure(row) {
  return row?.ok === false || row?.outcome === "failure" || row?.success === false;
}

function failureAt(row) {
  return Date.parse(row?.time || row?.at || row?.timestamp || row?.createdAt || 0);
}

/** Per-page/status counts and the sidebar attention dots. */
function deriveNav(rows) {
  const pendingTransfers = rows.transfers.filter((item) => item && item.status === "pending").length;
  const recentFailures = rows.audit.filter((row) => isFailure(row) && (failureAt(row) >= Date.now() - DAY || !Number.isFinite(failureAt(row)))).length;
  return {
    counts: {
      accounts: rows.accounts.length,
      keys: rows.keys.length,
      clients: rows.clients.length,
      tokens: rows.grants.length,
      publishes: rows.publishCounts.total ?? rows.publishCounts.active ?? 0,
      audit: rows.audit.length,
      authz: rows.authz.count,
      vaults: rows.vaults.length,
    },
    attention: {
      clients: pendingTransfers > 0 ? "amber" : null,
      clientsTitle: pendingTransfers > 0 ? "有转移待完成" : "",
      audit: recentFailures > 0 ? "danger" : null,
      auditTitle: recentFailures > 0 ? "24 小时内存在失败审计" : "",
    },
    pendingTransfers,
    recentFailures,
  };
}

/**
 * Read the access-policy admin store. Never throws: a broken store renders as `broken` so the
 * page can still show the repair surface (the Admin plane must never be gated by what it manages).
 */
async function readAuthz(accessPolicyAdmin, configuredApiKeyEnabled) {
  if (!accessPolicyAdmin || typeof accessPolicyAdmin.listPolicies !== "function") {
    return { available: false, enabled: false, status: "not-configured", revision: null, policies: [], orphaned: [], count: 0, enabledCount: 0 };
  }
  try {
    const listed = await accessPolicyAdmin.listPolicies();
    const policies = Array.isArray(listed?.policies) ? listed.policies : [];
    const enabledCount = policies.filter((policy) => policy.enabled !== false && policy.enabled !== 0).length;
    return {
      available: true,
      enabled: listed?.status === "ready",
      status: listed?.status || "unknown",
      revision: listed?.revision ?? null,
      policies,
      orphaned: Array.isArray(listed?.orphaned) ? listed.orphaned : [],
      count: policies.length,
      enabledCount,
    };
  } catch (error) {
    return { available: true, enabled: false, status: "broken", revision: null, policies: [], orphaned: [], count: 0, enabledCount: 0, error: String(error?.message || error) };
  }
}

async function readVaultGit(vaultGitAdmin, vaults) {
  if (!vaultGitAdmin || typeof vaultGitAdmin.model !== "function") return { wired: false, model: null, vaults };
  try {
    const model = await vaultGitAdmin.model();
    const listed = Array.isArray(model?.vaults) && model.vaults.length ? model.vaults : vaults;
    return { wired: true, model, vaults: listed };
  } catch (error) {
    return { wired: true, model: null, vaults, error: String(error?.message || error) };
  }
}

/**
 * Build everything a page needs for one request.
 * @param {{ deps: object, req: object, query?: object, now?: number }} input
 */
export async function buildCatalog({ deps, req, query = {}, now = Date.now() }) {
  const { provider, listVaults = async () => ({ vaults: [] }), publishService = null, accessPolicyAdmin = null, vaultGitAdmin = null, configuredApiKeyEnabled = false } = deps;
  const [rawSnapshot, vaultInventory, publications] = await Promise.all([
    provider.authorizationSnapshot(),
    listVaults().catch(() => ({ vaults: [] })),
    publishService ? publishService.list({ includeInactive: true }).catch(() => []) : [],
  ]);
  const { snapshot, transfers } = await loadAdminProjection(provider, rawSnapshot);
  const publishCounts = publishRecordCounts(publications);
  const vaultGit = await readVaultGit(vaultGitAdmin, vaultInventory.vaults || []);
  const vaults = vaultGit.vaults;
  const keys = [...(configuredApiKeyEnabled ? [configuredEnvKey(vaults, snapshot.configuredApiKeyUsage || {})] : []), ...(snapshot.apiKeys || [])];
  const grants = mergeTokenGrants(snapshot.tokens || []);
  const authz = await readAuthz(accessPolicyAdmin, configuredApiKeyEnabled);
  const audit = snapshot.audit || [];
  const nav = deriveNav({ accounts: snapshot.oauthUsers || [], clients: snapshot.clients || [], keys, grants, publishCounts, audit, authz, vaults, transfers });
  const capabilities = capabilityCatalog();
  const themeCookie = parseCookies(req)["omcp-admin.theme"];
  const theme = themeCookie === "light" ? "light" : themeCookie === "dark" ? "dark" : "dark";

  const model = createModel({
    now,
    snapshot: { ...snapshot, tokenGrants: grants },
    keys,
    vaults,
    publications,
    publishCounts,
    transfers,
    query,
    labels: { capabilityName: capabilities.nameOf },
  });

  return {
    now,
    theme,
    query,
    snapshot,
    keys,
    grants,
    publications,
    publishCounts,
    vaults,
    vaultGit,
    transfers,
    authz,
    capabilities,
    navCounts: nav.counts,
    navAttention: nav.attention,
    pendingTransfers: nav.pendingTransfers,
    recentFailures: nav.recentFailures,
    publicBaseUrl: deps.publicBaseUrl || "",
    model,
    deployedLabel: process.env.OBSIDIAN_DEPLOYED_LABEL || process.env.OMCP_DEPLOYED_LABEL || null,
  };
}

export { capabilityCatalog };
