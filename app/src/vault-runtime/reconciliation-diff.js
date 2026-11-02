// W2 (#437) — the pure added/removed/changed/unchanged diff of two registry snapshots (contract §1).
//
// Split out of `reconciliation.js` (which must stay inside the repository line budget) as one
// cohesive unit and re-exported from there so consumers keep one import site.

function factKey(descriptor, identities) {
  return JSON.stringify([
    descriptor.id,
    descriptor.root,
    descriptor.canonicalRoot ?? null,
    descriptor.primary === true,
    descriptor.writable === true,
    descriptor.capabilities ?? null,
    identities?.[descriptor.id]?.digest ?? null,
  ]);
}

/** added / removed / changed / unchanged vs the previously published snapshot (contract §1). */
export function computeReconciliationDiff(previous, next) {
  const prevById = new Map((previous?.vaults ?? []).map((vault) => [vault.id, vault]));
  const nextById = new Map((next?.vaults ?? []).map((vault) => [vault.id, vault]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const id of nextById.keys()) {
    const before = prevById.get(id);
    if (before === undefined) added.push(id);
    else if (factKey(before, previous?.identities) !== factKey(nextById.get(id), next?.identities)) changed.push(id);
    else unchanged.push(id);
  }
  for (const id of prevById.keys()) if (!nextById.has(id)) removed.push(id);
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), changed: Object.freeze(changed), unchanged: Object.freeze(unchanged) });
}
