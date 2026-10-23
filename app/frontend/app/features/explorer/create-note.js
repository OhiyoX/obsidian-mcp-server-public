export async function createNoteInFolder({
  folderPath,
  rawName,
  session,
  toast,
  state,
  search,
  semanticButton,
  publishesButton,
  api,
  syncSearchChrome,
  cancelPendingSearch,
  loadNotes,
  openNote,
  enterLiveMode,
  hasChild,
  ensureExpanded,
}) {
  if (session.isDirty()) {
    toast("请先保存当前笔记，再新建笔记", true);
    return false;
  }

  const name = String(rawName || "").trim().replace(/\.md$/i, "");
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    toast("请输入当前文件夹内的笔记名称", true);
    return false;
  }

  const path = `${folderPath}/${name}.md`;
  // Collision is checked against the lazy tree's loaded children for this parent
  // (the global notes list is no longer the Explorer source of truth).
  const collides = typeof hasChild === "function" ? hasChild(folderPath, path) : false;
  if (collides) {
    toast("已存在同名笔记，请换一个名称", true);
    return false;
  }
  try {
    state.expanded.add(folderPath);
    ensureExpanded?.(folderPath);
    cancelPendingSearch();
    search.value = "";
    syncSearchChrome?.();
    state.semantic = false;
    semanticButton.classList.remove("active");
    semanticButton.setAttribute("aria-pressed", "false");

    const data = await api("/api/web/v1/note", {
      method: "POST",
      body: JSON.stringify({ path, content: "" }),
    });
    await loadNotes("");
    const opened = await openNote(data.path);
    if (opened) enterLiveMode();
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}
