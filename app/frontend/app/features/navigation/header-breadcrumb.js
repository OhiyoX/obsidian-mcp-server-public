// Header path wiring: keeps `core/app.js` thin by owning the breadcrumb lifecycle.
//
// Directory segments reveal (and scroll to) that folder in the Explorer — the web
// analogue of the desktop breadcrumb's "jump to location" — while the file segment
// stays plain text.
import { createPathBreadcrumb } from "./breadcrumb.js";

export function initializeHeaderBreadcrumb({ host, explorer } = {}) {
  if (!host || !explorer) return null;

  const breadcrumb = createPathBreadcrumb({
    host,
    onReveal: async (folderPath) => {
      await explorer.ensureVisible(folderPath).catch(() => {});
      const row = document.querySelector(`.tree-folder-row[data-folder-path="${CSS.escape(folderPath)}"]`);
      row?.scrollIntoView({ block: "center" });
    },
  });

  return {
    render: (path) => breadcrumb?.render(path),
    getPath: () => breadcrumb?.getPath() ?? "",
  };
}
