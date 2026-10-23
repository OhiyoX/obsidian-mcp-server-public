// Admin is an inventory reader and a protected manual trigger of the ONE W2 service.
// No raw refresh, private membership accessor, or inferred approval lives here.
export const ADMISSION_ACTOR = "admin:auth-center";
export const ADMISSION_CODES = Object.freeze({
  REFUSED: "vault_git_admission_refused", INVALID: "vault_git_admission_invalid",
  UNAVAILABLE: "vault_git_registry_unavailable",
});

export function createVaultAdmissionAdmin({ registry, admission = null }) {
  const enabled = () => admission?.status?.().enabled === true;
  // A fresh deployment has neither an admissions record nor discovery enabled, so the controller is
  // not enforced yet — and `initialize` is exactly the operation that has to run in that state. The
  // old guard required `enabled()`, which made the documented enable path unreachable: the Admin form
  // was hidden and a hand-made POST answered `vault_git_admission_invalid` (hit on the NAS 2026-10-21).
  // Bootstrap stays scoped to `initialize` on an un-initialised store; approve/revoke still require an
  // enforced controller.
  const bootstrapPending = () => admission !== null && admission.status?.().initialized !== true;
  const permitted = (operation) => enabled() || (operation === "initialize" && bootstrapPending());
  function list() {
    if (!enabled()) return registry.list();
    const snapshot = registry.snapshot();
    const status = admission.status();
    const entries = admission.entries?.() ?? admission.store?.entries() ?? {};
    const descriptors = new Map(snapshot.vaults.map(vault => [vault.id, vault]));
    // Non-admitted secondaries are intentionally omitted from snapshot.vaults by W2.
    // Their already-committed decisions/status are Admin facts, never content descriptors.
    const ids = new Set([...descriptors.keys(), ...Object.keys(snapshot.admissions ?? {}), ...Object.keys(entries), ...Object.keys(status.vaults)]);
    return [...ids].sort().map(id => {
      const descriptor = descriptors.get(id) ?? { id, name: id, primary: id === registry.primaryId, writable: false };
      const decision = snapshot.admissions?.[id] ?? {};
      const runtime = status.vaults[id] ?? {};
      const runtimeStatus = runtime.status ?? decision.status;
      return Object.freeze({ ...descriptor, admission: Object.freeze({
        admission: entries[id]?.admission ?? decision.admission ?? runtime.admission ?? null,
        status: ["unavailable", "initializing", "ready", "error"].includes(runtimeStatus) ? runtimeStatus : "unavailable",
        reason: runtime.reason ?? decision.reason ?? null,
        generation: entries[id]?.generation ?? decision.generation ?? null, servable: registry.servable(id),
      }) });
    });
  }
  async function apply(operation, body = {}) {
    if (!["initialize", "approve", "revoke"].includes(operation) || !permitted(operation)) return { ok: false, code: ADMISSION_CODES.INVALID };
    const fields = operation === "initialize" ? ["csrf", "confirm"] : ["csrf", "vaultId"];
    if (Object.keys(body).some(key => !fields.includes(key))) return { ok: false, code: ADMISSION_CODES.INVALID };
    try {
      let result;
      if (operation === "initialize") {
        const confirm = Array.isArray(body.confirm) ? body.confirm : typeof body.confirm === "string" ? [body.confirm] : null;
        if (!confirm?.length || confirm.some(id => typeof id !== "string" || !id)) return { ok: false, code: ADMISSION_CODES.INVALID };
        await admission.initialize({ confirm, actor: ADMISSION_ACTOR, source: "admin-auth-center" });
        const status = admission.status();
        result = status.inFlight ? { status: "coalesced" } : status.history?.at(-1);
      } else {
        if (typeof body.vaultId !== "string" || !list().some(vault => vault.id === body.vaultId)) return { ok: false, code: ADMISSION_CODES.INVALID };
        result = await admission[operation](body.vaultId, { actor: ADMISSION_ACTOR });
      }
      if (result?.status === "coalesced") return { ok: true, httpStatus: 202, notice: "准入决定已保存；统一刷新已合并，等待发布。" };
      if (result?.status !== "committed") return { ok: false, code: ADMISSION_CODES.UNAVAILABLE };
      return { ok: true, notice: "准入操作已完成；Vault 清单已按统一提交发布。" };
    } catch (error) {
      // Only frozen codes reach HTTP; filesystem paths/error messages never do.
      const code = error?.code === "VAULT_ADMISSION_IDENTITY_CONFLICT" ? ADMISSION_CODES.REFUSED
        : ["VAULT_ADMISSIONS_INVALID_OPERATION", "VAULT_RECONCILIATION_CONFIG_INVALID"].includes(error?.code)
          ? ADMISSION_CODES.INVALID : ADMISSION_CODES.UNAVAILABLE;
      return { ok: false, code };
    }
  }
  return Object.freeze({ enabled, list, apply,
    refusesGit: id => enabled() && !registry.servable(id),
    // `null` means "no admission surface at all" (the view renders nothing). A bootstrap model keeps
    // the initialise form visible on a fresh deployment, which is the only way an operator can turn
    // the gate on from the UI.
    model: () => (enabled() || bootstrapPending()) ? { initialized: admission.status().initialized } : null });
}

export function registerVaultAdmissionRoutes(router, { admin, routeBase, requireAdmin, requireCsrf, tabPage, sendFailure }) {
  if (!admin.admissionAction) return;
  for (const operation of ["initialize", "approve", "revoke"]) {
    router.post(`${routeBase}/admission/${operation}`, requireAdmin, requireCsrf, async (req, res, next) => {
      try {
        const result = await admin.admissionAction(operation, req.body);
        if (!result.ok) return sendFailure(req, res, result);
        res.status(result.httpStatus ?? 200);
        await tabPage(req, res, next, result.notice);
      } catch (error) { next(error); }
    });
  }
}
