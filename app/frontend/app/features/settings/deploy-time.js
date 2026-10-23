// The server snapshot keeps the raw ISO (UTC) and this module rewrites ONLY the
// visible settings line from `data-deployed-at`.
//
// The Beijing conversion itself is NOT implemented here: it lives in
// `src/beijing-deploy-time.js` and is re-exported below, so the server-rendered
// Admin badge and this browser-side rewrite share exactly one implementation and
// cannot drift. The import is resolved by esbuild at build time and inlined into
// `app/assets/app.js`; it is never a runtime import from `src/` into `frontend/`
// (the container mounts only `app/server.js` + `app/src`, which is what made
// window #22 fail).
import { formatBeijingDeployLabel } from "../../../../src/beijing-deploy-time.js";

export { formatBeijingDeployLabel };

export function renderSettingsDeployTime(root = document) {
  const node = root?.querySelector?.(".settings-meta-deploy");
  if (!node) return null;
  const label = formatBeijingDeployLabel(node.getAttribute("data-deployed-at"));
  if (!label) return null;
  node.textContent = label;
  return label;
}
