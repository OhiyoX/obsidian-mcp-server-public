export function createConflictBar({ status, session, toast, onReload }) {
  function render(conflict) {
    let bar = document.getElementById("conflict-actions");
    if (!conflict) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "conflict-actions";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "版本冲突处理");
      status.insertAdjacentElement("afterend", bar);
    }
    bar.replaceChildren();

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.id = "conflict-copy-local";
    copyButton.textContent = "复制本地内容";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(session.liveText);
        toast("已复制本地内容到剪贴板");
      } catch {
        toast("复制失败，请手动全选复制", true);
      }
    });

    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.id = "conflict-reload-disk";
    reloadButton.textContent = "从磁盘重新载入";
    reloadButton.addEventListener("click", onReload);
    bar.append(copyButton, reloadButton);
  }

  return { render };
}
