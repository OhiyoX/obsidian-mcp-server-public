// The Admin manual trigger uses the process's one managed reconciliation service.
// Legacy inventory remains on the registry's existing refresh path.
export function createVaultInventoryAdmin({ registry, admission = null }) {
  const enabled = () => admission?.status?.().enabled === true;
  async function refresh() {
    if (!enabled()) return registry.refresh();
    const result = await admission.reconcile("manual", { actor: "admin:auth-center" });
    if (result?.status === "coalesced") return result;
    if (result?.status !== "committed") throw new Error("unified refresh did not commit cleanly");
    return registry.snapshot();
  }
  return Object.freeze({ enabled, refresh });
}
