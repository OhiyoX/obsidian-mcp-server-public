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
import { snapshotSubjects } from "./access-policy.js";
import { authorizationOperation, catalogOperationIds } from "../authorization/catalog.js";
import { mergeTokenGrants } from "./grants.js";
import { observeAdminRead } from "../authorization/adapters/admin.js";
import { capabilityCatalog } from "./capabilities.js";
import { createModel } from "./presentation/model.js";
import { parseCookies } from "./http.js";
import { configuredApiKeyVaults } from "../config.js";
import { DEFAULT_VAULT_ID } from "../oauth-provider.js";

const DAY = 24 * 3600 * 1000;

/** The synthetic `configured-env` API Key: real only when the deployment configures one, and its
 *  last-use facts come from the recorded usage (never invented). Its Vault grants come from the
 *  same `API_KEY_VAULTS` source the auth layer reads (contract §9.2), so the Admin plane cannot
 *  advertise less (or more) than the key can actually reach: the primary Vault plus the
 *  deployment's `API_KEY_VAULTS` additions, built exactly as `auth.js` builds them. */
function configuredEnvKey(vaults, usage = {}) {
  return {
    id: "configured-env",
    label: "环境配置 API_KEY",
    prefix: "不可显示",
    createdAt: null,
    lastUsedAt: usage.lastUsedAt || null,
    lastSource: usage.lastSource || null,
    allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
    allowedVaults: [...new Set([DEFAULT_VAULT_ID, ...(configuredApiKeyVaults() ?? [])])],
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

/**
 * Read the per-Vault constraint document (plan Task 6). Never throws: a store that is not ready
 * renders as `broken` with the store's own code, because the Admin plane must never be gated by
 * what it manages. `null` fields mean "the service did not provide this value" (§6.8).
 */
function readConstraints(constraintAdmin) {
  if (!constraintAdmin || typeof constraintAdmin.list !== "function") {
    return { available: false, status: "unavailable", revision: null, timeConstraintsEnabled: null, constraints: [], code: null, error: null };
  }
  try {
    const listed = constraintAdmin.list();
    const broken = listed?.revision === null || typeof listed?.code === "string";
    return {
      available: true,
      status: broken ? "broken" : "ready",
      revision: broken ? null : listed.revision,
      timeConstraintsEnabled: broken ? null : listed.timeConstraintsEnabled === true,
      constraints: broken || !Array.isArray(listed?.constraints) ? [] : listed.constraints,
      code: listed?.code ?? null,
      error: null,
    };
  } catch (error) {
    return { available: true, status: "broken", revision: null, timeConstraintsEnabled: null, constraints: [], code: null, error: String(error?.message || error) };
  }
}

/**
 * Operations the picker offers: the catalog's own IDs, one entry per operation, filed under the
 * first surface it runs on (design §6.3). The ID is the canonical name (§4.1), so no second
 * vocabulary is invented here; a non-grantable operation is left out because no ceiling can hold
 * it, and a constraint on it could never remove anything.
 */
function constraintOperations() {
  return catalogOperationIds
    .map((id) => authorizationOperation(id))
    .filter((operation) => operation !== null && operation.grantable)
    .map((operation) => ({
      id: operation.id,
      surface: operation.surfaces[0] ?? "system",
      surfaces: operation.surfaces,
      label: operation.id,
    }));
}

/**
 * The legacy atoms an imported constraint came from (design §6.3). An imported constraint keeps the
 * old policy's UUID (`legacy-policy-import.js`), and the legacy store is still readable, so the atom
 * is read from there instead of guessed: one atom can expand onto several operations, and that
 * expansion cannot be collapsed back into the atom a page would have to invent.
 */
function importedAtoms(constraints, policies) {
  const atoms = {};
  const byId = new Map((Array.isArray(policies) ? policies : []).map((policy) => [policy.id, policy]));
  for (const constraint of constraints) {
    const policy = byId.get(constraint.id);
    const list = (Array.isArray(policy?.capabilities) ? policy.capabilities : []).filter((atom) => typeof atom === "string" && atom);
    if (list.length) atoms[constraint.id] = list;
  }
  return atoms;
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
  const { provider, listVaults = async () => ({ vaults: [] }), publishService = null, accessPolicyAdmin = null, authorizationAdmin = null, vaultGitAdmin = null, configuredApiKeyEnabled = false, authorizationShadow = null } = deps;
  // P2 / Task 18: one console read is one authorization unit, recorded with an
  // `admin-session` actor that carries NO subject. The console is not a person's
  // credential, so no account window and no user revoke can change its answer. The row is
  // recorded before the catalog is assembled and changes nothing in it.
  if (authorizationShadow !== null) {
    observeAdminRead({
      shadow: authorizationShadow,
      routeKey: `ADMIN ${String(req?.method || "GET").toUpperCase()} ${String(req?.path || "/")}`,
    });
  }
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
  const constraints = readConstraints(authorizationAdmin);
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

  // The page model of 「定时授权」 (design §6.3, plan Task 6): the constraint document plus what a
  // form needs to describe one — the admitted Vaults and the operation catalog. `presentation` is the
  // shared subject/capability view model, so a page never builds its own idea of a subject.
  const constraintPage = {
    ...constraints,
    vaults: vaults.map((vault) => ({ id: vault.id, name: vault.name || vault.label || vault.id })),
    operations: constraintOperations(),
    importedAtoms: importedAtoms(constraints.constraints, authz.policies),
    subjects: snapshotSubjects(snapshot, { configuredApiKeyEnabled }),
    presentation: model,
  };

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
    constraintPage,
    capabilities,
    // The sidebar's 定时授权 entry opens the constraint page (Task 7 item B), so its badge counts
    // that page's own rows — the same `constraints` the page bar counts. It used to carry the legacy
    // policy count, and the two numbers sat side by side on one screen and diverged on the first
    // create or delete.
    navCounts: { ...nav.counts, authz: constraintPage.constraints.length },
    navAttention: nav.attention,
    pendingTransfers: nav.pendingTransfers,
    recentFailures: nav.recentFailures,
    publicBaseUrl: deps.publicBaseUrl || "",
    model,
    deployedLabel: process.env.OBSIDIAN_DEPLOYED_LABEL || process.env.OMCP_DEPLOYED_LABEL || null,
  };
}

export { capabilityCatalog };
