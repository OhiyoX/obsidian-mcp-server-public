// OAuth token grants: merge an access/refresh pair into the one row the Admin list shows.
// Data-only, no markup. Grouping uses the credential's `grantId` when present; legacy rows without
// one fall back to client + account + scope set, so two grants that only share a client stay apart.
export function grantKey(item) {
  const client = String(item?.clientId || "");
  const user = String(item?.userId || item?.username || "");
  const grant = item?.grantId != null && item.grantId !== "" ? String(item.grantId) : "";
  if (grant) return `g:${grant}`;
  const scopes = [...(Array.isArray(item?.scopes) ? item.scopes : [])].map(String).sort().join(",");
  return `c:${client}|u:${user}|s:${scopes}`;
}

/** Newest-first helpers keep the merge deterministic without trusting array order. */
function latest(items, field) {
  return items.reduce((best, item) => (Date.parse(item?.[field] || 0) >= Date.parse(best?.[field] || 0) ? item : best), items[0]);
}

export function mergeTokenGrants(tokens = []) {
  const groups = new Map();
  for (const item of tokens) {
    const key = grantKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const order = { active: 0, rotated: 1, expired: 2, revoked: 3 };
  return [...groups.values()].map((items) => {
    const access = items.find((item) => item.type === "access") || null;
    const refresh = items.find((item) => item.type === "refresh") || null;
    const primary = access || refresh || items[0];
    const statuses = items.map((item) => item.status);
    let status = "revoked";
    if (statuses.includes("active")) status = "active";
    else if (statuses.includes("rotated")) status = "rotated";
    else if (statuses.includes("expired")) status = "expired";
    const lastUsed = latest(items, "lastUsedAt");
    const issued = latest(items, "createdAt");
    return {
      key: grantKey(primary),
      items,
      access,
      refresh,
      primary,
      status,
      statusRank: order[status] ?? 9,
      scopes: [...new Set(items.flatMap((item) => item.scopes || []))],
      vaults: [...new Set(items.flatMap((item) => item.allowedVaults || []))],
      lastUsed,
      issued,
      connectionOrigin: primary.connectionOrigin || access?.connectionOrigin || refresh?.connectionOrigin || null,
      clientId: primary.clientId || null,
      userId: primary.userId || null,
      generation: Number.isInteger(primary.generation) ? primary.generation : 0,
    };
  }).sort((left, right) => Date.parse(right.issued?.createdAt || 0) - Date.parse(left.issued?.createdAt || 0));
}

/**
 * True when `after` only ADDS to `before` on both axes (scopes and Vaults).
 *
 * This is the guard behind 「仅新增授权，不撤销现有会话」: adding a Vault to an account does not widen
 * what an existing token can reach (tokens carry their own `allowedVaults` snapshot), so revoking every
 * session for a pure grant is avoidable. Any removal — or a changed scope set — cannot be expressed by
 * an old token and must still revoke.
 */
export function isAdditiveGrantChange({ beforeScopes = [], afterScopes = [], beforeVaults = [], afterVaults = [] } = {}) {
  const subset = (before, after) => before.every((item) => after.includes(item));
  return subset(beforeScopes, afterScopes) && subset(beforeVaults, afterVaults);
}

/** How many sessions an account's scope/Vault change is about to revoke (access + refresh tokens). */
export function sessionCountsFor(grants = [], userId = "") {
  const counts = { access: 0, refresh: 0, total: 0, clients: new Set() };
  for (const grant of grants) {
    for (const item of grant.items || []) {
      if (item.userId !== userId) continue;
      if (item.status === "revoked") continue;
      if (item.type === "refresh") counts.refresh += 1;
      else counts.access += 1;
      if (item.clientId) counts.clients.add(item.clientId);
    }
  }
  counts.total = counts.access + counts.refresh;
  return { ...counts, clients: counts.clients.size };
}

/**
 * The one decision behind 「保存权限」: keep the account's sessions or revoke them.
 *
 * Keeping is only legitimate for a pure grant AND an explicit opt-in. Everything else revokes, and the
 * caller must say so in the flash message — an operator who believes access was narrowed must not end
 * up with live tokens that still carry the old grant.
 */
export function decideGrantRevocation({ beforeScopes = [], afterScopes = [], beforeVaults = [], afterVaults = [] } = {}) {
  const additive = isAdditiveGrantChange({ beforeScopes, afterScopes, beforeVaults, afterVaults });
  // Automatic, not an opt-in: a pure addition cannot widen what an existing token reaches (tokens carry
  // their own allowedVaults/scopes snapshot), so revoking every session for it is pure harm — the
  // 2026-10-21 incident revoked 255 tokens to grant one Vault. A narrowing must still revoke, because an
  // old token would otherwise keep serving access the operator believes was taken away.
  return additive ? { keep: true, additive, reason: "additive" } : { keep: false, additive, reason: "narrowed" };
}
