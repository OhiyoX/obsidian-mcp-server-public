/** Match Obsidian inline-title basename semantics without changing note content. */
export function inlineTitleFromSourcePath(sourcePath) {
  const name = String(sourcePath || "").split("/").filter(Boolean).at(-1) || "";
  return name.replace(/\.md$/i, "");
}
