// Trusted explicit initialization/approval only. Old IDs never get a replacement marker.
import { initializeIncarnation } from "./incarnation.js";
import { ADMISSION_IDENTITY_CONFLICT, ADMISSIONS_INVALID_OPERATION } from "./admission-store.js";

export function assertEnrollmentActor(actor) {
  if (typeof actor !== "string" || !actor.trim()) throw Object.assign(new Error("explicit enrollment requires a trusted actor"), { code: ADMISSIONS_INVALID_OPERATION });
}
export async function identityForEnrollment({ descriptor, admissions, resolveIdentity, actor }) {
  assertEnrollmentActor(actor);
  const trusted = admissions.bindingFor(descriptor.id);
  const conflict = () => { throw Object.assign(new Error("old ID proof unavailable or changed; use a new Vault ID"), { code: ADMISSION_IDENTITY_CONFLICT }); };
  if (trusted?.identityVersion === 1) conflict(); // no retrospective lifecycle proof, no automatic upgrade
  if (!trusted) await initializeIncarnation(descriptor.root);
  let identity;
  try { identity = await resolveIdentity({ root: descriptor.root }); } catch (error) { if (trusted) conflict(); throw error; }
  if (trusted && trusted.digest !== identity.digest) conflict();
  return identity;
}

export async function initializeConfirmedVaults({ registry, admissions, resolveIdentity, now, configDigest, source, actor, confirm }) {
  assertEnrollmentActor(actor);
  if (!admissions.isLoaded() || !Array.isArray(confirm) || typeof source !== "string" || !source.trim() || admissions.isInitialized()) {
    throw Object.assign(new Error("initialize requires an explicit list/source and an uninitialized store"), { code: ADMISSIONS_INVALID_OPERATION });
  }
  // Validate the entire list before writing any markers; prepare does not publish.
  const prepared = await registry.prepare({ gate: async () => ({ admitted: true }), now });
  const confirmed = new Set(confirm);
  const selected = prepared.snapshot.vaults.filter(vault => vault.primary || confirmed.has(vault.id));
  for (const id of confirmed) if (!selected.some(item => item.id === id)) {
    throw Object.assign(new Error("confirmed ID has no discoverable/configured root"), { code: "VAULT_RECONCILIATION_CONFIG_INVALID" });
  }
  // Check old bindings/proofs for ALL selected IDs before provisioning a new one.
  for (const descriptor of selected) if (admissions.bindingFor(descriptor.id)) {
    await identityForEnrollment({ descriptor, admissions, resolveIdentity, actor });
  }
  const approved = [];
  for (const descriptor of selected) approved.push({ ...descriptor,
    identity: await identityForEnrollment({ descriptor, admissions, resolveIdentity, actor }) });
  await admissions.initialize({ source, configDigest: configDigest ?? "unspecified", approved, actor });
  return approved.map(item => item.id);
}

export async function approveConfirmedVault({ id, registry, admissions, resolveIdentity, now, actor }) {
  assertEnrollmentActor(actor);
  if (!admissions.isInitialized() || !admissions.entryFor(id)) {
    throw Object.assign(new Error("cannot approve an unknown/uninitialized ID"), { code: ADMISSIONS_INVALID_OPERATION });
  }
  const prepared = await registry.prepare({ gate: async () => ({ admitted: true }), now });
  const descriptor = prepared.snapshot.vaults.find(vault => vault.id === id);
  if (!descriptor) throw Object.assign(new Error("approved ID root is unavailable"), { code: ADMISSION_IDENTITY_CONFLICT });
  const identity = await identityForEnrollment({ descriptor, admissions, resolveIdentity, actor });
  await admissions.approve(id, { actor, identity });
}
