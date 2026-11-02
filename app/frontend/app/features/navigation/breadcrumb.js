// Path breadcrumb for the document header.
//
// Desktop Obsidian renders the open file's path as a breadcrumb whose directory
// segments are clickable chips (hover background, click to jump to that location).
// The web analogue of "jump to that location" is revealing and expanding the folder
// in the Explorer, so every directory segment is a button and the file segment stays
// plain text. `mousedown` is prevented so a click cannot blur an active inline-create
// draft in the sidebar.
export function createPathBreadcrumb({ host, onReveal, emptyLabel = "尚未打开笔记" } = {}) {
  if (!host) return null;
  let currentPath = "";

  function appendSeparator() {
    const separator = document.createElement("span");
    separator.className = "path-crumb-sep";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "/";
    host.append(separator);
  }

  function render(path) {
    currentPath = String(path || "").trim();
    host.replaceChildren();
    if (!currentPath) {
      host.textContent = emptyLabel;
      host.removeAttribute("title");
      return;
    }
    host.title = currentPath;
    const parts = currentPath.split("/").filter(Boolean);
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      if (isFile) {
        const name = document.createElement("span");
        name.className = "path-crumb path-crumb-file";
        name.textContent = part;
        host.append(name);
        return;
      }
      const prefix = parts.slice(0, index + 1).join("/");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "path-crumb path-crumb-folder";
      button.textContent = part;
      button.title = `跳转到 ${prefix}`;
      button.setAttribute("aria-label", `跳转到 ${prefix}`);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => onReveal?.(prefix));
      host.append(button);
      appendSeparator();
    });
  }

  return { render, getPath: () => currentPath };
}
