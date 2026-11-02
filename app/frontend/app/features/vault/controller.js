export function initializeVaultController({
  api, toast, session, state, lifecycle, saveButton, vaultSelect, createButton,
  abortOpen, abortRefresh, syncStatus,
}) {
  async function beginMutation(prepare) {
    if (lifecycle.switching) return false;
    lifecycle.switching = true;
    session.setWritesSuspended(true);
    saveButton.disabled = true;
    abortOpen();
    abortRefresh();
    session.invalidateInFlightReads();
    try {
      await session.whenSavesIdle();
      await prepare();
      return true;
    } catch (error) {
      lifecycle.switching = false;
      session.setWritesSuspended(false);
      syncStatus(session.statusFlags());
      throw error;
    }
  }

  async function load() {
    const data = await api("/api/web/v1/vaults");
    state.vaultId = data.current;
    vaultSelect.replaceChildren();
    for (const vault of data.vaults) {
      const option = document.createElement("option");
      option.value = vault.id;
      option.textContent = vault.name;
      option.selected = vault.id === data.current;
      vaultSelect.append(option);
    }
    createButton.hidden = !data.canCreate;
  }

  vaultSelect.addEventListener("change", async (event) => {
    if (session.isDirty() && !confirm("当前修改尚未保存，仍要切换 Vault 吗？")) {
      event.target.value = state.vaultId;
      return;
    }
    const previous = state.vaultId;
    try {
      await beginMutation(async () => {
        await api("/api/web/v1/vault/select", { method: "POST", body: JSON.stringify({ id: event.target.value }) });
        // The app root always carries its trailing slash: the installed app resolves its manifest
        // `scope` to `/app/`, so a slash-less `/app` reload would land outside the scope (#471).
        location.replace("/app/");
      });
    } catch (error) {
      event.target.value = previous;
      toast(error.message, true);
    }
  });

  createButton.onclick = async () => {
    const name = prompt("新 Vault 名称");
    if (!name) return;
    try {
      await beginMutation(async () => {
        await api("/api/web/v1/vault", { method: "POST", body: JSON.stringify({ name }) });
        location.replace("/app/");
      });
    } catch (error) {
      toast(error.message, true);
    }
  };

  return { load };
}
