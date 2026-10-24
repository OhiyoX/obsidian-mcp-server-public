// #642: identity-scoped default Vault Admin mutations.
// Kept out of the main Admin router to preserve its existing line budget.
import { listField } from "../http.js";

export function registerDefaultVaultRoutes(router, {
  requireAdmin, requireCsrf, provider, listVaults, stored,
  setFlash, redirectTab, renderError,
}) {
  const defaultChoice = (body) =>
    body?.defaultVaultId === "" || body?.defaultVaultId == null ? null : body.defaultVaultId;

  async function validateChoice(selected, allowedVaults) {
    if (selected === null) return;
    if (typeof selected !== "string" || !allowedVaults.includes(selected)) {
      throw new Error("默认 Vault 必须位于该凭证授权的 Vault 范围内");
    }
    const inventory = await listVaults();
    if (!(inventory?.vaults || []).some((vault) => vault.id === selected)) {
      throw new Error("默认 Vault 不存在或已不可用");
    }
  }

  router.post("/api-key/create", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const scopes = listField(req.body, "allowedScope");
      const vaults = listField(req.body, "allowedVault");
      const selected = defaultChoice(req.body);
      await validateChoice(selected, vaults);
      const created = await provider.createApiKey(req.body?.label, scopes, vaults.length ? vaults : undefined, selected);
      const session = stored(req);
      if (session) session.flashKey = created.secret;
      redirectTab(res, "keys");
    } catch (error) {
      res.status(400).send(renderError({ title: "创建失败", heading: "API Key 创建失败", message: String(error?.message || error) }));
    }
  });

  router.post("/api-key/default-vault", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const id = String(req.body?.id || "");
      if (id === "configured-env") throw new Error("环境配置 Key 不能在 Admin 修改");
      const snapshot = await provider.authorizationSnapshot();
      const key = (snapshot.apiKeys || []).find((item) => item.id === id);
      if (!key) throw new Error("API Key 不存在");
      const selected = defaultChoice(req.body);
      await validateChoice(selected, key.allowedVaults || []);
      if (!await provider.updateApiKey(id, { defaultVaultId: selected })) throw new Error("API Key 已被删除");
      // Preference updates are live. Unlike authorization changes, they do not revoke sessions.
      setFlash(req, "API Key 默认 Vault 已更新，对后续调用生效。");
      redirectTab(res, "keys");
    } catch (error) {
      res.status(400).send(renderError({ title: "更新失败", heading: "默认 Vault 更新失败", message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/client/default-vault", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const clientId = String(req.body?.clientId || "");
      const snapshot = await provider.authorizationSnapshot();
      if (!(snapshot.clients || []).some((item) => item.clientId === clientId)) throw new Error("OAuth 客户端不存在");
      const selected = defaultChoice(req.body);
      const available = (snapshot.tokens || [])
        .filter((token) => token.clientId === clientId && token.status === "active")
        .flatMap((token) => token.allowedVaults || []);
      await validateChoice(selected, available);
      if (!await provider.updateOAuthClientDefaultVault(clientId, selected)) throw new Error("OAuth 客户端已被删除");
      setFlash(req, "OAuth 客户端默认 Vault 已更新，对后续调用生效。");
      redirectTab(res, "clients");
    } catch (error) {
      res.status(400).send(renderError({ title: "更新失败", heading: "默认 Vault 更新失败", message: String(error?.message || error) }));
    }
  });
}
