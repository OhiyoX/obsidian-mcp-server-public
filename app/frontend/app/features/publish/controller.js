export function createPublishController({ api, state, copyButtons, publishButtons, actionsToggle, toast }) {
  let sharing = null;

  async function copyText(value, message) {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast(message);
  }

  function apply(data) {
    if (!data || data.path !== state.path || data.vaultId !== state.vaultId) return;
    sharing = data;
    for (const button of copyButtons) button.disabled = false;
    for (const button of copyButtons) {
      const label = button.querySelector("span:last-child");
      if (label) label.textContent = data.published ? "复制公开链接" : "复制文档链接";
      button.title = data.published ? "复制匿名公开链接" : "复制登录后文档链接";
    }
    for (const button of publishButtons) {
      button.disabled = false;
      button.classList.toggle("active", data.published);
      const label = data.published ? "取消 Publish" : "Publish";
      button.querySelector(".document-action-label").textContent = label;
      if (button.classList.contains("topbar-icon-action")) button.title = label;
      button.setAttribute("aria-pressed", String(data.published));
    }
    actionsToggle.classList.toggle("is-published", data.published);
    actionsToggle.title = data.published ? "文档操作（已公开）" : "文档操作";
    actionsToggle.setAttribute("aria-label", actionsToggle.title);
  }

  async function refresh() {
    const requestedPath = state.path;
    if (!requestedPath) return;
    for (const button of copyButtons) button.disabled = true;
    for (const button of publishButtons) button.disabled = true;
    try {
      apply(await api(`/api/web/v1/publish?path=${encodeURIComponent(requestedPath)}`));
    } catch (error) {
      if (requestedPath === state.path) toast(error.message, true);
    }
  }

  for (const button of copyButtons) button.onclick = async () => {
      const url = sharing?.published ? sharing.publicUrl : sharing?.privateUrl;
      if (!url) return;
      try { await copyText(url, sharing.published ? "公开链接已复制" : "文档链接已复制"); } catch { toast("无法复制链接", true); }
    };

  for (const button of publishButtons) button.onclick = async () => {
    if (!state.path || !sharing) return;
    const action = sharing.published ? "revoke" : "publish";
    for (const target of publishButtons) target.disabled = true;
    try {
      const data = await api("/api/web/v1/publish", { method: "POST", body: JSON.stringify({ path: state.path, action }) });
      apply(data);
      if (data.published && data.publicUrl) await copyText(data.publicUrl, "公开链接已复制");
      else toast("公开链接已撤销");
    } catch (error) {
      for (const target of publishButtons) target.disabled = false;
      toast(error.message, true);
    }
  };

  return { refresh };
}
