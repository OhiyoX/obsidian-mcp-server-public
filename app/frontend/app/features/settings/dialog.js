import { renderSettingsDeployTime } from "./deploy-time.js";

/**
 * Wire the settings dialog chrome and rewrite its visible deploy-time line.
 *
 * Owned here so `core/app.js` stays a thin bootstrap — the architecture contract
 * tests pin that file at "net growth 0", so the open/close/backdrop wiring plus
 * the deploy-time rewrite live in this feature module instead. The rewrite reads
 * the raw ISO from `data-deployed-at` and hands it to the shared Beijing
 * formatter (`deploy-time.js`), which is the same implementation the Admin badge
 * reuses server-side.
 */
export function initializeSettingsDialog(root = document) {
  const dialog = root.querySelector("#settings-dialog");
  root.querySelector("#settings-open").onclick = () => dialog.showModal();
  root.querySelector("#settings-close").onclick = () => dialog.close();
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  renderSettingsDeployTime(root);
  return dialog;
}
